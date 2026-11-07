import { compileAstJson, type Code } from "./code.ts";
import { advance, machineVersion, resume, start, type Effect, type Machine } from "./machine.ts";
import { requestId, waitId, type Checkpoint, type CheckpointChange, type Deadline, type DurableStore, type Json, type RequestOutcome, type SourcePath, type WaitOutcome, type WaitTarget } from "./persistence.ts";
import { show, text, unit, variant, type Value } from "./value.ts";

export class ProgramError extends Error {}

export interface Policy {
  /** Host authority is checked afresh; participant literals are not grants. */
  authorize(executionId: string, effect: Effect): Promise<boolean>;
}
const json = (value: unknown): Json => value as Json;
function reply(value: RequestOutcome): Value {
  if (value.tag === "Answered") return variant("Answered", value.value as unknown as Value);
  if (value.tag === "Broke" || value.tag === "Refused") return variant(value.tag, text(value.reason));
  return variant(value.tag);
}
function waited(value: WaitOutcome, optional: boolean): Value {
  if (value.tag === "Elapsed") return variant("None");
  const result = value.tag === "Reply" ? reply(value.reply) : value.value as unknown as Value;
  return optional ? variant("Some", result) : result;
}
function milliseconds(value: Value, now: number): number {
  if (value.type !== "time" && value.type !== "duration") throw new ProgramError("A deadline needs a time or duration");
  const integer = BigInt(value.value) + (value.type === "duration" ? BigInt(now) : 0n);
  const result = Number(integer);
  if (integer < 0n || !Number.isSafeInteger(result)) throw new ProgramError("Deadline lies outside the host clock range");
  return result;
}
function deadline(value: Value | undefined): Deadline | null {
  if (!value) return null;
  const at = milliseconds(value, 0);
  return value.type === "duration" ? { after: at } : at;
}
/** Stable key for an external fact/occurrence, independent of object insertion order. */
export function eventKey(value: Value): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
    return item;
  }
  return JSON.stringify(canonical(value));
}
function targets(source: Value, now: number): WaitTarget[] {
  const result: WaitTarget[] = [];
  const pending: { source: Value; path: SourcePath }[] = [{ source, path: [] }];
  while (pending.length) {
    const { source: current, path } = pending.pop()!;
    if (current.type === "request") { result.push({ kind: "request", id: current.id }); continue; }
    if (current.type !== "source") throw new ProgramError("wait needs a request, fact or stream");
    if (current.name === "never") continue;
    if (current.name === "or") {
      pending.push({ source: current.args[1], path: [...path, "Second"] }, { source: current.args[0], path: [...path, "First"] });
      continue;
    }
    if (current.name === "map" || current.name === "filter") throw new ProgramError("Stream map/filter are not implemented by the reference host yet");
    const projection = path.length ? { path } : {};
    if (current.name === "after" || current.name === "every") {
      if (current.args.length !== 1 || Object.keys(current.labels).length) throw new ProgramError("A timer needs one positional argument");
      const when = current.args[0];
      if (!(current.name === "after" && when.type === "time") && (when.type !== "duration" || BigInt(when.value) <= 0n)) throw new ProgramError("A relative timer needs a positive duration");
      result.push({ kind: "timer", at: milliseconds(when, now), ...projection });
    } else result.push({ kind: "event", mode: current.kind, key: eventKey(current), ...projection });
  }
  return result;
}
function participant(value: Value | undefined): string {
  if (!value || value.type !== "participant") throw new ProgramError("Expected a participant");
  return show(value);
}
function requestHandle(value: Value | undefined): string {
  if (!value || value.type !== "request") throw new ProgramError("Expected a request handle");
  return value.id;
}

/** A single-worker driver over an optimistic, multi-worker-safe persistence boundary. */
export class Runtime {
  readonly store: DurableStore;
  readonly code: Code;
  private readonly policy: Policy;
  constructor(code: Code, store: DurableStore, policy: Policy) { this.code = code; this.store = store; this.policy = policy; }
  static async restore(executionId: string, store: DurableStore, policy: Policy): Promise<Runtime> {
    const checkpoint = await store.load(executionId);
    if (!checkpoint) throw new Error("Execution not found");
    if (checkpoint.machineVersion !== machineVersion) throw new Error(`Unsupported machine ABI ${checkpoint.machineVersion}; this runtime requires ${machineVersion}`);
    const ast = await store.loadCode(checkpoint.codeId);
    if (ast === null) throw new Error("Pinned AST is missing");
    const code = compileAstJson(ast);
    if (code.id !== checkpoint.codeId) throw new Error("Stored AST does not match its pinned identity");
    return new Runtime(code, store, policy);
  }
  async create(executionId: string): Promise<boolean> {
    const now = await this.store.currentTime();
    await this.store.saveCode(this.code.id, this.code.ast);
    return this.store.create({ executionId, codeId: this.code.id, machineVersion, status: "ready", snapshot: json(start(this.code, now)) });
  }
  async step(executionId: string, slice = 1_000): Promise<Checkpoint | null> {
    const now = await this.store.currentTime();
    const before = await this.store.load(executionId);
    if (!before || !["ready", "suspended"].includes(before.status)) return before;
    if (before.machineVersion !== machineVersion) throw new Error(`Unsupported machine ABI ${before.machineVersion}; this runtime requires ${machineVersion}`);
    if (before.codeId !== this.code.id) throw new Error("Pinned code identity mismatch");
    const machine = before.snapshot as unknown as Machine;
    if (before.status === "suspended") {
      if (before.waitingFor?.kind !== "wait") throw new Error("Unsupported suspension format");
      if (machine.control.kind !== "effect") throw new Error("A wait must pin its suspended effect");
      if (!await this.policy.authorize(executionId, machine.control.effect)) {
        const source = machine.control.effect.args[0];
        if (source?.type === "request") {
          const current = await this.store.request(source.id);
          if (current && current.outcome === null) await this.store.settleRequest(current.id, current.epoch, current.holder, { tag: "Revoked" });
        } else {
          machine.control = { kind: "failed", outcome: variant("Revoked") };
          return (await this.store.commit(before, this.checkpoint(machine, now)))?.checkpoint ?? null;
        }
      }
      const wait = await this.store.wait(before.waitingFor.id);
      if (!wait?.outcome) return before;
      resume(machine, waited(wait.outcome, machine.control.effect.name === "waitUntil"), now);
    } else machine.resumedAt = now;
    advance(this.code, machine, slice);
    let change: CheckpointChange;
    try {
      change = machine.control.kind === "effect" ? await this.effect(before, machine, machine.control.effect, now) : this.checkpoint(machine, now);
    } catch (error) {
      if (!(error instanceof ProgramError)) throw error;
      machine.control = { kind: "error", message: error.message };
      change = this.checkpoint(machine, now);
    }
    const committed = await this.store.commit(before, change);
    return committed?.checkpoint ?? null; // A loser reloads; it never performs the abandoned effect.
  }
  private checkpoint(machine: Machine, now: number): CheckpointChange {
    if (machine.control.kind === "report") {
      const reported = machine.control.outcome;
      resume(machine, unit, now);
      return { status: "ready", snapshot: json(machine), effects: [{ operation: "execution.handler_failed", arguments: json(reported), kind: "notification" }] };
    }
    if (machine.control.kind === "done") return { status: "completed", snapshot: json(machine) };
    if (machine.control.kind === "error") return {
      status: "failed", snapshot: json(machine),
      effects: [{ operation: "execution.failed", arguments: { kind: "program-error", message: machine.control.message }, kind: "notification" }],
    };
    if (machine.control.kind === "failed") return {
      status: machine.control.outcome.type === "variant" && machine.control.outcome.name === "Revoked" ? "revoked" : "failed",
      snapshot: json(machine),
      effects: [{ operation: "execution.failed", arguments: json(machine.control.outcome), kind: "notification" }],
    };
    return { status: "ready", snapshot: json(machine) };
  }
  private async effect(before: Checkpoint, machine: Machine, effect: Effect, now: number): Promise<CheckpointChange> {
    if (!await this.policy.authorize(before.executionId, effect)) {
      machine.control = { kind: "failed", outcome: variant("Revoked") };
      return this.checkpoint(machine, now);
    }
    const { name, args, labels } = effect;
    const declaredLabels: Record<string, string[]> = { ask: ["by"], confirm: ["by"], choose: ["by"], run: ["context", "by"],
      wait: [], waitUntil: [], cancel: [], handOver: [], status: [], say: [], judge: ["about"] };
    for (const label of Object.keys(labels)) if (!declaredLabels[name]?.includes(label)) throw new ProgramError(`Unknown ${name} label ${label}`);
    if (name === "choose" && (args[2]?.type !== "list" || !args[2].values.length || args[2].values.some(v => v.type !== "variant"))) {
      throw new ProgramError("choose options must be a nonempty list of constructors");
    }

    const base: CheckpointChange = { status: "ready", snapshot: json(machine) };
    const finish = (value: Value) => { resume(machine, value, now); return { ...base, snapshot: json(machine) }; };
    if (["ask", "confirm", "choose", "run", "judge"].includes(name)) {
      const holder = name === "judge" ? "@judge" : participant(args[0]);
      if (name !== "judge" && (args.length !== (name === "choose" ? 3 : 2) || args[1]?.type !== "string")) throw new ProgramError(`${name} needs a participant and text${name === "choose" ? ", and its options" : ""}`);
      if (name === "judge" && (args.length !== 1 || args[0].type !== "string")) throw new ProgramError("judge needs a condition string");
      const id = requestId(before.executionId, before.revision + 1);
      return { ...finish({ type: "request", id }), requests: [{ holder, arguments: json(effect), by: deadline(labels.by) }] };
    } else if (name === "wait" || name === "waitUntil") {
      if (args.length !== (name === "waitUntil" ? 2 : 1)) throw new ProgramError(`${name} needs a target${name === "waitUntil" ? " and a positional deadline" : ""}`);
      base.waits = [{ targets: targets(args[0], now), until: name === "waitUntil" ? deadline(args[1]) : null }];
    } else if (["cancel", "handOver", "status"].includes(name)) {
      if (args.length !== (name === "handOver" ? 2 : 1)) throw new ProgramError(`${name} received the wrong number of arguments`);
      const id = requestHandle(args[0]), request = await this.store.request(id);
      if (!request || request.executionId !== before.executionId) throw new ProgramError("Request is outside this execution's scope");
      if (name === "status") return finish(request.outcome ? variant("Some", reply(request.outcome)) : variant("None"));
      if (name === "cancel") return { ...finish(unit), requestActions: request.outcome ? [] : [{ id, epoch: request.epoch, holder: request.holder, action: "cancel" }] };
      return { ...finish({ type: "request", id }), requestActions: request.outcome ? [] : [{
        id, epoch: request.epoch, holder: request.holder, action: "handOver", nextHolder: participant(args[1]),
      }] };
    } else if (name === "say") {
      if (args.length !== 2 || !["participant", "ref"].includes(args[0].type) || args[1].type !== "string") throw new ProgramError("say needs a participant/ref and text");
      return { ...finish(unit), effects: [{ operation: "say", arguments: json(effect), kind: "work" }] };
    } else throw new ProgramError(`Reference host does not implement ${name}`);
    return { ...base, status: "suspended", waitingFor: { kind: "wait", id: waitId(before.executionId, before.revision + 1) } };
  }
  /** A bounded scheduler pass yields unfinished programs, rather than failing them. */
  async runReady(slices = 100): Promise<number> {
    let count = 0;
    while (count < slices) {
      const ready = await this.store.scanReady({ limit: slices - count, codeId: this.code.id });
      if (!ready.length) break;
      for (const execution of ready) {
        if (execution.codeId === this.code.id) { await this.step(execution.executionId); count++; }
      }
      if (!ready.some(e => e.codeId === this.code.id)) break;
    }
    return count;
  }
}

export function requestOutcome(value: Value): RequestOutcome {
  if (value.type !== "variant") throw new ProgramError("Scripted response must be a reply");
  if (value.name === "Answered" && value.args.length === 1) return { tag: "Answered", value: json(value.args[0]) };
  if ((value.name === "Refused" || value.name === "Broke") && value.args.length === 1 && value.args[0].type === "string") {
    return { tag: value.name, reason: value.args[0].value };
  }
  if ((value.name === "Cancelled" || value.name === "Revoked") && value.args.length === 0) return { tag: value.name };
  throw new ProgramError("Invalid scripted reply; NoReply is decided only by the store clock");
}
