import { systemClock, type Clock } from "./clock.ts";
import {
  effectId, requestId, waitId, encodeJson, deadlineAt, projectOccurrence, validateReply,
  type Checkpoint, type CheckpointChange, type Commit, type DispatchClaim, type DurableStore,
  type ExecutionStatus, type InitialCheckpoint, type Json, type RequestOutcome, type RequestEvidence,
  type RetryEvidence, type Scan, type StoredEffect, type StoredRequest, type StoredWait, type WaitOutcome,
} from "./persistence.ts";

type Lease = { effect: StoredEffect; owner: string | null; epoch: number; until: number };
type Event = { key: string; mode: "fact" | "stream"; value: Json; at: number; origin: string | null; seq: number };
interface State {
  codes: Map<string, string>;
  executions: Map<string, Checkpoint>;
  effects: Map<string, Lease>;
  requests: Map<string, StoredRequest>;
  evidence: Map<string, RequestEvidence[]>;
  waits: Map<string, StoredWait>;
  events: Map<string, Event>;
  sequence: number;
}
const empty = (): State => ({ codes: new Map(), executions: new Map(), effects: new Map(), requests: new Map(),
  evidence: new Map(), waits: new Map(), events: new Map(), sequence: 0 });
const terminal = new Set<ExecutionStatus>(["completed", "failed", "cancelled", "revoked"]);
const copy = <T>(value: T): T => JSON.parse(encodeJson(value as unknown as Json)) as T;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function limit(scan: Scan): number {
  const value = scan.limit ?? 100;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Scan limit must be a positive safe integer");
  return value;
}
function clock(at: number, duration = 1): void {
  if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(duration) || duration < 1 || !Number.isSafeInteger(at + duration)) {
    throw new TypeError("Lease clock and duration must be safe integer milliseconds");
  }
}

/** A session-local DurableStore adapter. Closing or refreshing the page loses its state. */
export class MemoryStore implements DurableStore {
  private state = empty();
  private readonly clock: Clock;
  private observed = 0;
  private closed = false;
  constructor(clock: Clock = systemClock) { this.clock = clock; }
  private open(): void { if (this.closed) throw new Error("Memory store is closed"); }
  private time(): number {
    this.open(); const at = this.clock.now(); clock(at);
    this.observed = Math.max(this.observed, at); return this.observed;
  }
  /** Rows are replaced, never mutated; copying the maps makes synchronous transactions rollback-safe. */
  private transaction<T>(body: () => T): T {
    this.open(); const previous = this.state;
    this.state = { codes: new Map(previous.codes), executions: new Map(previous.executions),
      effects: new Map(previous.effects), requests: new Map(previous.requests), evidence: new Map(previous.evidence),
      waits: new Map(previous.waits), events: new Map(previous.events), sequence: previous.sequence };
    try { return body(); } catch (error) { this.state = previous; throw error; }
  }
  async currentTime(): Promise<number> { return this.time(); }
  async saveCode(id: string, ast: string): Promise<void> {
    this.open(); const existing = this.state.codes.get(id);
    if (existing !== undefined && existing !== ast) throw new Error("Pinned AST identity cannot be overwritten");
    this.state.codes.set(id, ast);
  }
  async loadCode(id: string): Promise<string | null> { this.open(); return this.state.codes.get(id) ?? null; }
  async create(initial: InitialCheckpoint): Promise<boolean> {
    this.open();
    if (initial.waitingFor) throw new Error("Initial creation cannot reference an uncommitted wait");
    const value = copy({ ...initial, revision: 0, waitingFor: null });
    if (this.state.executions.has(initial.executionId)) return false;
    this.state.executions.set(initial.executionId, value); return true;
  }
  async load(id: string): Promise<Checkpoint | null> {
    return this.transaction(() => { this.resolveWaits(this.time()); return copy(this.state.executions.get(id) ?? null); });
  }
  private insert(id: string, executionId: string, revision: number, ordinal: number, operation: string, args: Json,
    kind: "work" | "notification"): StoredEffect {
    if (this.state.effects.has(id)) throw new Error(`Duplicate effect ${id}`);
    const effect: StoredEffect = { id, executionId, revision, ordinal, operation, arguments: copy(args), kind,
      status: "pending", receipt: null, detail: null };
    this.state.effects.set(id, { effect, owner: null, epoch: 0, until: 0 }); return copy(effect);
  }
  private notice(r: StoredRequest, suffix: string, operation: string, args: Json, kind: "work" | "notification" = "notification"): StoredEffect {
    return this.insert(`${r.id}/epoch/${r.epoch}/${suffix}`, r.executionId, this.state.executions.get(r.executionId)!.revision, 0, operation, args, kind);
  }
  private withdraw(id: string): void {
    for (const [key, lease] of this.state.effects) {
      const effect = lease.effect;
      if (effect.operation !== "request.offer" || (effect.arguments as { requestId: string }).requestId !== id) continue;
      if (effect.status === "pending") this.state.effects.set(key, { ...lease, effect: { ...effect, status: "withdrawn", detail: "request no longer assigned" } });
      else if (["dispatching", "uncertain", "blocked"].includes(effect.status)) this.state.effects.set(key, {
        ...lease, owner: null, until: 0, effect: { ...effect, status: "superseded", detail: "request no longer assigned" },
      });
    }
  }
  private finish(r: StoredRequest, outcome: RequestOutcome, at: number): void {
    this.state.requests.set(r.id, { ...r, outcome: copy(outcome), settledAt: at }); this.withdraw(r.id);
    this.notice(r, "closed", "request.closed", { requestId: r.id, epoch: r.epoch, holder: r.holder, outcome: outcome as unknown as Json });
  }
  private move(r: StoredRequest, nextHolder: string): StoredRequest {
    if (!nextHolder || nextHolder === r.holder || !Number.isSafeInteger(r.epoch + 1)) throw new TypeError("Invalid next request holder");
    this.withdraw(r.id);
    this.notice(r, "released", "request.released", { requestId: r.id, epoch: r.epoch, holder: r.holder, nextHolder });
    const next = { ...r, epoch: r.epoch + 1, holder: nextHolder }; this.state.requests.set(r.id, next);
    this.notice(next, "offer", "request.offer", { requestId: next.id, epoch: next.epoch, holder: nextHolder, by: next.by, arguments: next.arguments }, "work");
    return next;
  }
  async commit(expected: Checkpoint, change: CheckpointChange): Promise<Commit | null> {
    if (!Number.isSafeInteger(expected.revision) || expected.revision < 0 || !Number.isSafeInteger(expected.revision + 1)) {
      throw new TypeError("Checkpoint revision must be a nonnegative safe integer");
    }
    const snapshot = copy(change.snapshot);
    const effects = (change.effects ?? []).map(e => ({ ...e, arguments: copy(e.arguments) }));
    const requests = (change.requests ?? []).map(r => ({ ...r, arguments: copy(r.arguments) }));
    if (terminal.has(change.status) && (change.waits?.length || requests.length || effects.some(e => (e.kind ?? "work") === "work"))) throw new Error("A terminal transition cannot create new work");
    return this.transaction(() => {
      const now = this.time();
      this.resolveWaits(now);
      const current = this.state.executions.get(expected.executionId);
      if (!current || current.revision !== expected.revision || current.codeId !== expected.codeId || current.machineVersion !== expected.machineVersion || terminal.has(current.status)) return null;
      for (const action of change.requestActions ?? []) {
        const r = this.state.requests.get(action.id);
        if (!r || r.executionId !== current.executionId || r.epoch !== action.epoch || r.holder !== action.holder || r.outcome !== null) return null;
      }
      const revision = current.revision + 1, waitingFor = copy(change.waitingFor ?? null);
      const checkpoint: Checkpoint = { ...current, revision, status: change.status, snapshot, waitingFor };
      this.state.executions.set(current.executionId, checkpoint);
      const savedEffects = effects.map((e, index) => this.insert(effectId(current.executionId, revision, index), current.executionId, revision, index, e.operation, e.arguments, e.kind ?? "work"));
      const savedRequests = requests.map((r, index): StoredRequest => {
        const id = requestId(current.executionId, revision, index);
        if (this.state.requests.has(id)) throw new Error(`Duplicate request ${id}`);
        const request: StoredRequest = { ...r, by: deadlineAt(r.by, now), id, executionId: current.executionId, epoch: 0, outcome: null, settledAt: null };
        this.state.requests.set(id, request);
        savedEffects.push(this.notice(request, "offer", "request.offer", { requestId: id, epoch: 0, holder: r.holder, by: request.by, arguments: r.arguments }, "work"));
        return request;
      });
      const savedWaits = (change.waits ?? []).map((input, index) => {
        const description = { ...copy(input), until: deadlineAt(input.until, now) };
        if (description.until !== null) clock(description.until);
        for (const target of description.targets) {
          if (target.kind === "timer") clock(target.at);
          if (target.kind !== "request") projectOccurrence(null, target.path);
          if (target.kind === "request" && this.state.requests.get(target.id)?.executionId !== current.executionId) throw new Error("Cannot wait on another execution's request");
        }
        const id = waitId(current.executionId, revision, index);
        if (this.state.waits.has(id)) throw new Error(`Duplicate wait ${id}`);
        this.state.waits.set(id, { ...description, id, executionId: current.executionId, cursor: this.state.sequence, outcome: null });
        return id;
      });
      for (const action of change.requestActions ?? []) {
        const r = this.state.requests.get(action.id)!;
        if (action.action === "cancel") this.finish(r, { tag: "Cancelled" }, now); else this.move(r, action.nextHolder);
      }
      if (waitingFor) {
        const table = waitingFor.kind === "delivery" ? this.state.effects : waitingFor.kind === "wait" ? this.state.waits : this.state.requests;
        const value = table.get(waitingFor.id);
        const owner = value && ("effect" in value ? value.effect.executionId : value.executionId);
        if (owner !== current.executionId) throw new Error("A checkpoint must wait on its own durable effect or request");
      }
      if (terminal.has(change.status)) {
        if (change.status !== "completed") for (const [id, lease] of this.state.effects) {
          if (lease.effect.executionId === current.executionId && lease.effect.status === "pending" && lease.effect.kind === "work") {
            this.state.effects.set(id, { ...lease, effect: { ...lease.effect, status: "withdrawn", detail: "execution terminated" } });
          }
        }
        for (const r of this.state.requests.values()) if (r.executionId === current.executionId && r.outcome === null) this.finish(r, { tag: "Cancelled" }, now);
      }
      this.resolveWaits(now);
      return copy({ checkpoint, effects: savedEffects.map(e => this.state.effects.get(e.id)!.effect), requests: savedRequests.map(r => this.state.requests.get(r.id)!), waits: savedWaits.map(id => this.state.waits.get(id)!) });
    });
  }
  async effects(id: string): Promise<StoredEffect[]> {
    this.open(); return copy([...this.state.effects.values()].map(l => l.effect).filter(e => e.executionId === id)
      .sort((a, b) => a.revision - b.revision || a.ordinal - b.ordinal || compare(a.id, b.id)));
  }
  async request(id: string): Promise<StoredRequest | null> {
    return this.transaction(() => { this.resolveWaits(this.time()); return copy(this.state.requests.get(id) ?? null); });
  }
  async requestEvidence(id: string): Promise<RequestEvidence[]> { this.open(); return copy(this.state.evidence.get(id) ?? []); }
  async settleRequest(id: string, epoch: number, holder: string, outcome: RequestOutcome): Promise<boolean> {
    const result = copy(outcome);
    validateReply(result);
    return this.transaction(() => {
      const at = this.time();
      this.resolveWaits(at); const r = this.state.requests.get(id); if (!r) return false;
      const accepted = r.epoch === epoch && r.holder === holder && r.outcome === null && !terminal.has(this.state.executions.get(r.executionId)!.status);
      this.state.evidence.set(id, [...(this.state.evidence.get(id) ?? []), { epoch, holder, outcome: result as unknown as Json, receivedAt: at, accepted, invalidReason: null }]);
      if (accepted) { this.finish(r, result, at); this.resolveWaits(at); } return accepted;
    });
  }
  async rejectAnswer(id: string, epoch: number, holder: string, answer: Json, reason: string): Promise<boolean> {
    const at = this.time(), value = copy(answer);
    return this.transaction(() => {
      this.resolveWaits(at); if (!this.state.requests.has(id)) return false;
      this.state.evidence.set(id, [...(this.state.evidence.get(id) ?? []), { epoch, holder, outcome: value, receivedAt: at, accepted: false, invalidReason: reason }]);
      return true;
    });
  }
  async handOver(id: string, epoch: number, holder: string, nextHolder: string): Promise<StoredRequest | null> {
    return this.transaction(() => {
      this.resolveWaits(this.time());
      const r = this.state.requests.get(id);
      if (!r || r.epoch !== epoch || r.holder !== holder || r.outcome !== null || terminal.has(this.state.executions.get(r.executionId)!.status)) return null;
      return copy(this.move(r, nextHolder));
    });
  }
  async wait(id: string): Promise<StoredWait | null> {
    return this.transaction(() => { this.resolveWaits(this.time()); return copy(this.state.waits.get(id) ?? null); });
  }
  private resolveWaits(now: number): void {
    for (const r of this.state.requests.values()) {
      if (r.outcome === null && r.by !== null && r.by <= now && !terminal.has(this.state.executions.get(r.executionId)!.status)) {
        this.finish(r, { tag: "NoReply" }, r.by);
      }
    }
    for (const wait of this.state.waits.values()) {
      if (wait.outcome !== null || terminal.has(this.state.executions.get(wait.executionId)!.status)) continue;
      const candidates: { at: number; priority: number; outcome: WaitOutcome }[] = [];
      if (wait.until !== null && wait.until <= now) candidates.push({ at: wait.until, priority: 0, outcome: { tag: "Elapsed" } });
      for (const target of wait.targets) {
        if (target.kind === "request") {
          const r = this.state.requests.get(target.id)!;
          if (r.outcome !== null && r.settledAt !== null && r.settledAt <= now) candidates.push({ at: r.settledAt, priority: r.outcome.tag === "NoReply" ? -1 : 1, outcome: { tag: "Reply", reply: r.outcome } });
        } else if (target.kind === "timer") {
          if (target.at <= now) candidates.push({ at: target.at, priority: 1, outcome: { tag: "Occurred", value: projectOccurrence({ type: "time", value: String(target.at) }, target.path) } });
        } else {
          const event = [...this.state.events.values()].filter(e => e.key === target.key && e.mode === target.mode && e.at <= now && e.seq > (target.mode === "fact" ? 0 : wait.cursor) && e.origin !== wait.executionId)
            .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
          if (event) candidates.push({ at: event.at, priority: 1, outcome: { tag: "Occurred", value: projectOccurrence(event.value, target.path) } });
        }
      }
      const first = candidates.sort((a, b) => a.at - b.at || a.priority - b.priority)[0];
      if (!first) continue;
      this.state.waits.set(wait.id, { ...wait, outcome: copy(first.outcome) });
    }
  }
  async publishEvent(id: string, key: string, mode: "fact" | "stream", value: Json, originExecutionId?: string): Promise<boolean> {
    const at = this.time(), payload = copy(value);
    return this.transaction(() => {
      const inserted = !this.state.events.has(id);
      if (inserted) this.state.events.set(id, { key, mode, value: payload, at, origin: originExecutionId ?? null, seq: ++this.state.sequence });
      this.resolveWaits(at); return inserted;
    });
  }
  private canSend(effect: StoredEffect): boolean {
    if (effect.kind === "notification") return true;
    if (["failed", "cancelled", "revoked"].includes(this.state.executions.get(effect.executionId)!.status)) return false;
    if (effect.operation !== "request.offer") return true;
    const args = effect.arguments as { requestId: string; epoch: number; holder: string }, r = this.state.requests.get(args.requestId);
    return !!r && r.outcome === null && r.epoch === args.epoch && r.holder === args.holder;
  }
  private claim(claim: DispatchClaim, now: number): Lease | null {
    const lease = this.state.effects.get(claim.effect.id);
    return lease && lease.owner === claim.owner && lease.epoch === claim.epoch && lease.until > now && ["dispatching", "uncertain"].includes(lease.effect.status) ? lease : null;
  }
  async claimEffect(id: string, owner: string, leaseMs: number): Promise<DispatchClaim | null> {
    const now = this.time(); clock(now, leaseMs); if (!owner) throw new TypeError("A dispatch claim needs an owner");
    this.transaction(() => this.resolveWaits(now));
    const lease = this.state.effects.get(id);
    if (!lease || !["pending", "dispatching", "uncertain"].includes(lease.effect.status) || lease.until > now || (lease.effect.status === "pending" && !this.canSend(lease.effect))) return null;
    const mode = lease.effect.status === "pending" ? "send" : "reconcile";
    const next: Lease = { effect: { ...lease.effect, status: mode === "send" ? "dispatching" : "uncertain" }, owner, epoch: lease.epoch + 1, until: now + leaseMs };
    this.state.effects.set(id, next); return copy({ effect: next.effect, owner, epoch: next.epoch, until: next.until, mode });
  }
  async prepareRetry(claim: DispatchClaim, evidence: RetryEvidence): Promise<DispatchClaim | null> {
    const now = this.time();
    this.transaction(() => this.resolveWaits(now));
    if (!["host-deduplicates-original-id", "previous-sender-fenced-and-host-confirmed-absent"].includes(evidence)) throw new TypeError("Retry requires host evidence");
    const lease = this.claim(claim, now);
    if (!lease || lease.effect.status !== "uncertain" || !this.canSend(lease.effect)) return null;
    const effect: StoredEffect = { ...lease.effect, status: "dispatching", detail: evidence }; this.state.effects.set(effect.id, { ...lease, effect });
    return copy({ ...claim, mode: "send", effect });
  }
  async markUncertain(claim: DispatchClaim, detail: string): Promise<boolean> {
    this.transaction(() => this.resolveWaits(this.time()));
    const lease = this.claim(claim, this.time()); if (!lease) return false;
    this.state.effects.set(lease.effect.id, { ...lease, owner: null, until: 0, effect: { ...lease.effect, status: "blocked", detail } }); return true;
  }
  async provideEvidence(id: string, detail: string): Promise<boolean> {
    this.transaction(() => this.resolveWaits(this.time()));
    const lease = this.state.effects.get(id); if (!lease || lease.effect.status !== "blocked") return false;
    this.state.effects.set(id, { ...lease, until: 0, effect: { ...lease.effect, status: "uncertain", detail } }); return true;
  }
  async recordDelivery(claim: DispatchClaim, receipt: Json): Promise<boolean> {
    const now = this.time(), result = copy(receipt);
    this.transaction(() => this.resolveWaits(now));
    const lease = this.claim(claim, now); if (!lease) return false;
    this.state.effects.set(lease.effect.id, { ...lease, owner: null, until: 0, effect: { ...lease.effect, status: "delivered", receipt: result, detail: null } }); return true;
  }
  async scanEffects(scan: Scan = {}): Promise<StoredEffect[]> {
    const now = this.time(), count = limit(scan);
    this.transaction(() => this.resolveWaits(now));
    return copy([...this.state.effects.values()].filter(l => l.effect.id > (scan.after ?? "") &&
      ((l.effect.status === "pending" && this.canSend(l.effect)) || (["dispatching", "uncertain"].includes(l.effect.status) && l.until <= now)))
      .sort((a, b) => compare(a.effect.id, b.effect.id)).slice(0, count).map(l => l.effect));
  }
  async scanReady(scan: Scan = {}): Promise<Checkpoint[]> {
    const now = this.time(), count = limit(scan);
    return this.transaction(() => {
      this.resolveWaits(now);
      return copy([...this.state.executions.values()].filter(e => {
        if (e.executionId <= (scan.after ?? "") || (scan.codeId !== undefined && e.codeId !== scan.codeId)) return false;
        if (e.status === "ready") return true;
        const wait = e.waitingFor;
        if (e.status !== "suspended" || !wait) return false;
        if (wait.kind === "delivery") return this.state.effects.get(wait.id)?.effect.status === "delivered";
        return (wait.kind === "wait" ? this.state.waits.get(wait.id) : this.state.requests.get(wait.id))?.outcome != null;
      }).sort((a, b) => compare(a.executionId, b.executionId)).slice(0, count));
    });
  }
  async close(): Promise<void> { this.state = empty(); this.closed = true; }
}
