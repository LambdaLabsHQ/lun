/**
 * A program running against a simulated team, in the page. The visitor plays
 * the team: answers, refuses or breaks requests, moves the virtual clock and
 * fires the host's facts and streams. This module drives the reference
 * runtime (`src/runtime/browser.ts`) and keeps what happened as a timeline of
 * plain data; it knows nothing of the page.
 *
 * The runtime time-slices pure computation. Between slices this module gives
 * the page a turn, so a program that loops without waiting keeps running, and
 * the page stays responsive, until the visitor restarts it. Nothing here caps
 * a program's steps.
 */
import type { Program } from "../../src/frontend/ast.ts";
import {
  MemoryStore, Runtime, SimulatedHost, VirtualClock, compile, text, variant,
  type Checkpoint, type ExecutionStatus, type Json, type RequestOutcome, type StoredWait, type Value, type WaitOutcome,
} from "../../src/runtime/browser.ts";
import { code, either, literal, participant, quote, source, time, type Run } from "./words.ts";

/** When every simulation starts: 09:00 UTC on 7 November 2026, three hours before decide.norn's deadline. */
export const START = Date.UTC(2026, 10, 7, 9, 0);

const EXECUTION = "playground";

/** A request as the program made it. */
export interface RequestInfo {
  id: string;
  /** Who holds it now, as in `@alice`; `@judge` for `judge`. */
  holder: string;
  /** The verb that made it. */
  name: "ask" | "confirm" | "choose" | "run" | "judge";
  /** The question, the task or the condition. */
  text: string;
  /** The options of a `choose`; `Yes` and `No` for a `confirm`. */
  options: Value[] | null;
  /** The request's own deadline (`~by`), on the store's clock: past it, the request ends `NoReply`. */
  by: number | null;
}

export type Entry =
  | { kind: "offered"; at: number; request: RequestInfo }
  | { kind: "handedOver"; at: number; request: RequestInfo; from: string; to: string }
  | { kind: "closed"; at: number; request: RequestInfo; outcome: RequestOutcome }
  /** An answer the host could not map, such as an option the request did not offer: kept as evidence, and the request stays open. */
  | { kind: "rejected"; at: number; request: RequestInfo; answer: string; reason: string }
  | { kind: "said"; at: number; to: string; text: string }
  /** `targets` reads after "Waiting", as in "for @alice’s answer to “…”"; `deadline` after that, as in " until 2026-11-07 12:00 UTC". */
  | { kind: "waiting"; at: number; targets: Run[]; deadline: Run[] }
  /** A wait ended by an event or a timer; the value it gave, unless that is `()` or a time. */
  | { kind: "woke"; at: number; outcome: string | null }
  /** A `waitUntil` ran out before what it waited for: only the wait ends. */
  | { kind: "elapsed"; at: number; targets: Run[]; open: boolean }
  | { kind: "fired"; at: number; source: string; mode: "fact" | "stream"; value: string }
  | { kind: "handlerFailed"; at: number; outcome: string }
  /** `outcome` is the program's result, or the text of a program error when `error` is true. */
  | { kind: "ended"; at: number; status: Exclude<ExecutionStatus, "ready" | "suspended">; outcome: string; error: boolean };

export interface OpenRequest extends RequestInfo {
  epoch: number;
  /** Whether the program is waiting for this request now. */
  awaited: boolean;
}

/** A fact or stream the program is waiting on now, which the visitor can fire. */
export interface AwaitedEvent {
  source: Extract<Value, { type: "source" }>;
  mode: "fact" | "stream";
}

export interface SimulationState {
  now: number;
  status: ExecutionStatus;
  /** The program is computing between waits: a long or endless loop shows here. */
  computing: boolean;
  /** What the program waits for, in words, and until when. */
  waiting: { targets: Run[]; deadline: Run[]; until: number | null } | null;
  requests: OpenRequest[];
  events: AwaitedEvent[];
  /** The earliest deadline still ahead: of the current wait, a timer it waits on, or an open request's `~by`. */
  nextDeadline: number | null;
  timeline: Entry[];
  /** The runtime itself stopped with an error: a bug to show, not an outcome of the program. */
  error: string | null;
}

export interface SimulationOptions {
  program: Program;
  std: Program;
  start?: number;
  /** Called whenever the state changes. */
  onChange?: (state: SimulationState) => void;
  /** Gives the page a turn between slices of a long computation. */
  pause?: () => Promise<void>;
}

const TERMINAL: ReadonlySet<ExecutionStatus> = new Set(["completed", "failed", "revoked", "cancelled"]);

export class Simulation {
  private readonly clock: VirtualClock;
  private readonly store: MemoryStore;
  private readonly host: SimulatedHost;
  private readonly runtime: Runtime;
  private readonly listeners = new Set<(state: SimulationState) => void>();
  private readonly pause: () => Promise<void>;

  private readonly timeline: Entry[] = [];
  private readonly requests = new Map<string, RequestInfo>();
  private readonly seenEffects = new Set<string>();
  /** Waits seen, and whether their outcome is in the timeline yet. */
  private readonly waits = new Map<string, boolean>();
  private checkpoint: Checkpoint | null = null;
  private computing = false;
  private error: string | null = null;
  private fired = 0;
  private acted = false;
  private disposed = false;
  private running: Promise<void> | null = null;
  private again = false;
  /** Every change to the store, one at a time. */
  private tail: Promise<unknown> = Promise.resolve();
  private snapshot: SimulationState;

  private constructor(options: SimulationOptions) {
    this.clock = new VirtualClock(options.start ?? START);
    this.store = new MemoryStore(this.clock);
    this.host = new SimulatedHost(this.store, this.clock);
    this.runtime = new Runtime(compile(options.program, { std: options.std }), this.store, this.host);
    if (options.onChange !== undefined) this.listeners.add(options.onChange);
    this.pause = options.pause ?? (() => new Promise((resolve) => setTimeout(resolve, 0)));
    this.snapshot = {
      now: this.clock.now(), status: "ready", computing: true, waiting: null, requests: [], events: [], nextDeadline: null, timeline: [], error: null,
    };
  }

  /** Starts a program: it runs until it first waits, or for as long as it computes. */
  static async start(options: SimulationOptions): Promise<Simulation> {
    const simulation = new Simulation(options);
    await simulation.runtime.create(EXECUTION);
    await simulation.exclusive(() => simulation.observe());
    simulation.run();
    return simulation;
  }

  /** The state as of the last change. */
  get state(): SimulationState {
    return this.snapshot;
  }

  /** Whether the visitor has done anything yet: a run nobody touched can be replaced without losing anything. */
  get touched(): boolean {
    return this.acted;
  }

  /** Calls `listener` after every change; returns a function that stops it. */
  onChanged(listener: (state: SimulationState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once the program has nothing left to do until the visitor acts. */
  async settled(): Promise<void> {
    while (this.running !== null) await this.running;
  }

  /** Stops the program for good, as Restart does. */
  dispose(): void {
    this.disposed = true;
    void this.exclusive(() => this.store.close());
  }

  // The visitor's actions --------------------------------------------------------

  /**
   * Replies to a request as its holder: Answered with a value, Refused or
   * Broke with a reason. An answer the host cannot map is refused at its
   * boundary; the timeline says so, and the request stays open.
   */
  async reply(requestId: string, outcome: Value): Promise<boolean> {
    return this.act(async () => {
      const request = await this.store.request(requestId);
      if (request === null || request.outcome !== null) return false;
      const accepted = await this.host.reply(request, outcome);
      if (!accepted) {
        const evidence = (await this.store.requestEvidence(requestId)).at(-1);
        const info = this.requests.get(requestId);
        const answer = outcome.type === "variant" && outcome.name === "Answered" && outcome.args.length === 1 ? outcome.args[0]! : outcome;
        if (info !== undefined && evidence?.invalidReason != null) {
          this.timeline.push({ kind: "rejected", at: this.clock.now(), request: { ...info, holder: request.holder }, answer: literal(answer), reason: evidence.invalidReason });
        }
      }
      return accepted;
    });
  }

  answer(requestId: string, value: Value): Promise<boolean> {
    return this.reply(requestId, variant("Answered", value));
  }

  refuse(requestId: string, reason: string): Promise<boolean> {
    return this.reply(requestId, variant("Refused", text(reason)));
  }

  broke(requestId: string, reason: string): Promise<boolean> {
    return this.reply(requestId, variant("Broke", text(reason)));
  }

  /** Fires a fact, which then holds, or one occurrence of a stream. */
  async fire(event: Extract<Value, { type: "source" }>, value: Value): Promise<boolean> {
    return this.act(async () => {
      const accepted = await this.host.emit(`fired-${++this.fired}`, event, value);
      if (accepted) this.timeline.push({ kind: "fired", at: this.clock.now(), source: source(event), mode: event.kind, value: literal(value) });
      return accepted;
    });
  }

  /**
   * Moves the clock forward. Deadlines and timers on the way fire at their own
   * times, in order, and the program reacts to each before the clock goes on.
   */
  async advanceTo(target: number): Promise<void> {
    for (;;) {
      const next = this.snapshot.nextDeadline;
      if (next === null || next > target || next <= this.clock.now() || this.disposed) break;
      await this.act(() => this.host.advanceTo(next));
    }
    if (target > this.clock.now()) await this.act(() => this.host.advanceTo(target));
  }

  advance(ms: number): Promise<void> {
    return this.advanceTo(this.clock.now() + ms);
  }

  // Running ------------------------------------------------------------------------

  /** Does what the visitor did, then lets the program react: the promise resolves once it waits or ends again. */
  private async act<T>(action: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("This simulation has been restarted");
    this.acted = true;
    let result: T | undefined;
    try {
      result = await this.exclusive(async () => {
        const value = await action();
        await this.observe();
        return value;
      });
    } catch (error) {
      // The runtime failed, not the program: the page shows it, and the run stops.
      if (this.disposed) throw new Error("This simulation has been restarted");
      this.error = error instanceof Error ? error.message : String(error);
      this.snapshot = { ...this.snapshot, error: this.error };
      this.notify();
      return undefined as T;
    }
    this.run();
    await this.settled();
    return result;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {});
    return next;
  }

  /** Steps the program until it waits or ends, one slice at a time, observing each. */
  private run(): void {
    if (this.running !== null) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      try {
        let last = performance.now();
        do {
          this.again = false;
          for (;;) {
            if (this.disposed || this.error !== null) return;
            const advanced = await this.exclusive(async () => {
              const count = await this.host.pump(this.runtime, 1);
              await this.observe();
              return count;
            });
            if (advanced === 0) break;
            if (performance.now() - last > 12) {
              this.notify();
              await this.pause();
              last = performance.now();
            }
          }
        } while (this.again);
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.running = null;
        this.computing = false;
        this.snapshot = { ...this.snapshot, computing: false, error: this.error };
        this.notify();
      }
    })();
  }

  private notify(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(this.snapshot);
  }

  // Observing ----------------------------------------------------------------------

  /** Reads what changed in the store since the last look, into the timeline and the state. */
  private async observe(): Promise<void> {
    if (this.disposed) return;
    const now = this.clock.now();
    const checkpoint = await this.store.load(EXECUTION);
    if (checkpoint === null) return;

    // Waits that ended: a waitUntil that ran out, or a wake-up by an event or a timer. A request's reply has its own entry.
    for (const [id, reported] of this.waits) {
      if (reported) continue;
      const wait = await this.store.wait(id);
      if (wait === null || wait.outcome === null) continue;
      this.waits.set(id, true);
      await this.waitEnded(wait, wait.outcome);
    }

    for (const effect of await this.store.effects(EXECUTION)) {
      if (this.seenEffects.has(effect.id)) continue;
      this.seenEffects.add(effect.id);
      const args = effect.arguments as Record<string, Json>;
      switch (effect.operation) {
        case "request.offer": {
          if ((args.epoch as number) !== 0) break; // A handover's offer; request.released tells it.
          const info = requestInfo(args.requestId as string, args.holder as string, (args.by as number | null | undefined) ?? null, args.arguments as unknown as EffectJson);
          this.requests.set(info.id, info);
          this.timeline.push({ kind: "offered", at: now, request: info });
          break;
        }
        case "request.released": {
          const request = this.requests.get(args.requestId as string);
          if (request === undefined) break;
          const moved = { ...request, holder: args.nextHolder as string };
          this.requests.set(request.id, moved);
          this.timeline.push({ kind: "handedOver", at: now, request: moved, from: args.holder as string, to: args.nextHolder as string });
          break;
        }
        case "request.closed": {
          const request = this.requests.get(args.requestId as string);
          if (request === undefined) break;
          const stored = await this.store.request(request.id);
          this.timeline.push({ kind: "closed", at: stored?.settledAt ?? now, request: { ...request, holder: args.holder as string }, outcome: args.outcome as unknown as RequestOutcome });
          break;
        }
        case "say": {
          const [to, message] = (args as unknown as EffectJson).args;
          this.timeline.push({ kind: "said", at: now, to: to === undefined ? "?" : literal(to), text: message?.type === "string" ? message.value : literal(message ?? { type: "unit" }) });
          break;
        }
        case "execution.handler_failed":
          this.timeline.push({ kind: "handlerFailed", at: now, outcome: literal(effect.arguments as unknown as Value) });
          break;
      }
    }

    // A wait that started.
    if (checkpoint.status === "suspended" && checkpoint.waitingFor?.kind === "wait" && !this.waits.has(checkpoint.waitingFor.id)) {
      const wait = await this.store.wait(checkpoint.waitingFor.id);
      if (wait !== null) {
        this.waits.set(wait.id, false);
        this.timeline.push({ kind: "waiting", at: now, ...(await this.describeWait(wait)) });
        if (wait.outcome !== null) {
          this.waits.set(wait.id, true);
          await this.waitEnded(wait, wait.outcome);
        }
      }
    }

    if (TERMINAL.has(checkpoint.status) && !TERMINAL.has(this.checkpoint?.status ?? "ready")) {
      this.timeline.push({ kind: "ended", at: now, status: checkpoint.status as "completed" | "failed" | "revoked" | "cancelled", ...finalOutcome(checkpoint) });
    }
    this.computing = checkpoint.status === "ready";
    this.checkpoint = checkpoint;
    this.snapshot = await this.current();
    this.notify();
  }

  private async waitEnded(wait: StoredWait, outcome: WaitOutcome): Promise<void> {
    if (outcome.tag === "Elapsed") {
      const open = wait.targets.some((target) => target.kind === "request");
      this.timeline.push({ kind: "elapsed", at: wait.until ?? this.clock.now(), targets: (await this.describeWait(wait)).targets, open });
      return;
    }
    // A request's reply is told by request.closed.
    if (outcome.tag === "Reply") return;
    const now = this.clock.now();
    const timers = wait.targets.flatMap((target) => (target.kind === "timer" && target.at <= now ? [target.at] : []));
    const byTimer = timers.length > 0 && !wait.targets.some((target) => target.kind === "event");
    const value = outcome.value as unknown as Value;
    this.timeline.push({ kind: "woke", at: byTimer ? Math.min(...timers) : now, outcome: wakeValue(value) });
  }

  /**
   * What a wait is for, in words: "for @alice’s answer to “…”", "for the next
   * ciFailed("acme/api") or until 2026-11-08 09:00 UTC", then its deadline.
   */
  private async describeWait(wait: StoredWait): Promise<{ targets: Run[]; deadline: Run[] }> {
    const requests: Run[][] = [];
    const events: Run[][] = [];
    const timers: Run[][] = [];
    for (const target of wait.targets) {
      if (target.kind === "request") {
        const stored = await this.store.request(target.id);
        const info = this.requests.get(target.id);
        if (stored === null || info === undefined) continue;
        const holder = participant(stored.holder);
        const due: Run[] = stored.by === null ? [] : [", due by ", time(stored.by)];
        if (info.name === "judge") requests.push(["for the judge to decide ", quote(info.text), ...due]);
        else if (info.name === "run") requests.push(["for ", holder, " to finish ", quote(info.text), ...due]);
        else requests.push(["for ", holder, "’s answer to ", quote(info.text), ...due]);
      } else if (target.kind === "timer") {
        timers.push(["until ", time(target.at)]);
      } else {
        const event = JSON.parse(target.key) as Extract<Value, { type: "source" }>;
        events.push(target.mode === "fact" ? ["for ", code(source(event)), " to hold"] : ["for the next ", code(source(event))]);
      }
    }
    const parts = [...requests, ...events, ...timers];
    const targets: Run[] = parts.length === 0 ? ["on ", code("never()")] : either(parts);
    const deadline: Run[] = wait.until === null ? [] : timers.length > 0 ? [", and no later than ", time(wait.until)] : [" until ", time(wait.until)];
    return { targets, deadline };
  }

  private async current(): Promise<SimulationState> {
    const checkpoint = this.checkpoint;
    const now = this.clock.now();
    const requests: OpenRequest[] = [];
    let wait: StoredWait | null = null;
    if (checkpoint?.status === "suspended" && checkpoint.waitingFor?.kind === "wait") wait = await this.store.wait(checkpoint.waitingFor.id);
    const awaited = new Set(wait?.outcome === null ? wait.targets.flatMap((target) => (target.kind === "request" ? [target.id] : [])) : []);
    const dues: number[] = [];
    for (const info of this.requests.values()) {
      const stored = await this.store.request(info.id);
      if (stored === null || stored.outcome !== null) continue;
      requests.push({ ...info, holder: stored.holder, by: stored.by, epoch: stored.epoch, awaited: awaited.has(info.id) });
      if (stored.by !== null) dues.push(stored.by);
    }
    const open = wait !== null && wait.outcome === null ? wait : null;
    const deadlines = [
      ...dues,
      ...(open === null ? [] : [
        ...(open.until === null ? [] : [open.until]),
        ...open.targets.flatMap((target) => (target.kind === "timer" ? [target.at] : [])),
      ]),
    ].filter((at) => at > now);
    const waiting = open === null ? null : this.timeline.findLast((entry): entry is Entry & { kind: "waiting" } => entry.kind === "waiting") ?? null;
    return {
      now,
      status: checkpoint?.status ?? "ready",
      computing: this.computing,
      waiting: open === null || waiting === null ? null : { targets: waiting.targets, deadline: waiting.deadline, until: open.until },
      requests,
      events: open === null ? [] : open.targets.flatMap((target) =>
        target.kind === "event" ? [{ source: JSON.parse(target.key) as AwaitedEvent["source"], mode: target.mode }] : []),
      nextDeadline: deadlines.length === 0 ? null : Math.min(...deadlines),
      timeline: [...this.timeline],
      error: this.error,
    };
  }
}

/** The JSON of an effect as stored: what the program called, with what. */
interface EffectJson {
  name: string;
  args: Value[];
  labels: Record<string, Value>;
}

function requestInfo(id: string, holder: string, by: number | null, effect: EffectJson): RequestInfo {
  const name = effect.name as RequestInfo["name"];
  const said = name === "judge" ? effect.args[0] : effect.args[1];
  const choices = effect.args[2];
  return {
    id,
    holder,
    name,
    text: said?.type === "string" ? said.value : said === undefined ? "" : literal(said),
    options: name === "choose" && choices?.type === "list" ? choices.values : name === "confirm" ? [variant("Yes"), variant("No")] : null,
    by,
  };
}

/** What a wake-up gave, for the timeline: nothing for `()` or a time, and the path an `or` took around the value. */
function wakeValue(value: Value): string | null {
  let inner = value;
  while (inner.type === "variant" && (inner.name === "First" || inner.name === "Second") && inner.args.length === 1) inner = inner.args[0]!;
  return inner.type === "unit" || inner.type === "time" ? null : literal(value);
}

/** How the program ended, from its last checkpoint: its value, the reply it failed with, or a program error. */
function finalOutcome(checkpoint: Checkpoint): { outcome: string; error: boolean } {
  const control = (checkpoint.snapshot as unknown as { control?: { kind?: string; value?: Value; outcome?: Value; message?: string } }).control;
  if (control?.kind === "done" && control.value !== undefined) return { outcome: literal(control.value), error: false };
  if (control?.kind === "failed" && control.outcome !== undefined) return { outcome: literal(control.outcome), error: false };
  if (control?.kind === "error" && control.message !== undefined) return { outcome: control.message, error: true };
  return { outcome: checkpoint.status, error: false };
}
