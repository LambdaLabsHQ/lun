/** Portable data boundary. Native closures and host credentials never enter snapshots. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ExecutionStatus = "ready" | "suspended" | "completed" | "failed" | "cancelled" | "revoked";
export type WaitFor = { kind: "delivery" | "request" | "wait"; id: string };

export interface Checkpoint {
  executionId: string;
  revision: number;
  codeId: string;
  machineVersion: string;
  status: ExecutionStatus;
  snapshot: Json;
  waitingFor: WaitFor | null;
}
export type InitialCheckpoint = Omit<Checkpoint, "revision" | "waitingFor"> & { waitingFor?: WaitFor | null };
export interface EffectDescription {
  operation: string;
  arguments: Json;
  kind?: "work" | "notification";
}
/** Relative deadlines are resolved once, at the transaction's authority time. */
export type Deadline = number | { after: number };
export interface RequestDescription { holder: string; arguments: Json; by?: Deadline | null }
export type RequestOutcome =
  | { tag: "Answered"; value: Json }
  | { tag: "Refused" | "Broke"; reason: string }
  | { tag: "NoReply" | "Cancelled" | "Revoked" };
export interface StoredRequest extends Omit<RequestDescription, "by"> {
  id: string;
  executionId: string;
  epoch: number;
  by: number | null;
  outcome: RequestOutcome | null;
  settledAt: number | null;
}
export interface RequestEvidence {
  epoch: number;
  holder: string;
  /** Invalid answers retain their original data without becoming a reply. */
  outcome: Json;
  receivedAt: number;
  accepted: boolean;
  invalidReason: string | null;
}
/** An outer-to-inner constructor path preserves the winning source of nested or. */
export type SourcePath = readonly ("First" | "Second")[];
export type WaitTarget =
  | { kind: "request"; id: string }
  | { kind: "event"; key: string; mode: "fact" | "stream"; path?: SourcePath }
  | { kind: "timer"; at: number; path?: SourcePath };
/** Store protocol results are distinct from language replies and event payloads. */
export type WaitOutcome = { tag: "Reply"; reply: RequestOutcome } | { tag: "Occurred"; value: Json } | { tag: "Elapsed" };
export interface WaitDescription {
  /** An empty set never fires on its own. */
  targets: WaitTarget[];
  until: Deadline | null;
}
export interface StoredWait extends Omit<WaitDescription, "until"> {
  id: string;
  executionId: string;
  cursor: number;
  until: number | null;
  outcome: WaitOutcome | null;
}
export type RequestAction = { id: string; epoch: number; holder: string } &
  ({ action: "cancel" } | { action: "handOver"; nextHolder: string });
export interface CheckpointChange {
  status: ExecutionStatus;
  snapshot: Json;
  waitingFor?: WaitFor | null;
  effects?: EffectDescription[];
  requests?: RequestDescription[];
  waits?: WaitDescription[];
  requestActions?: RequestAction[];
}
export interface StoredEffect extends EffectDescription {
  id: string;
  executionId: string;
  revision: number;
  ordinal: number;
  kind: "work" | "notification";
  status: "pending" | "dispatching" | "uncertain" | "blocked" | "delivered" | "withdrawn" | "superseded";
  receipt: Json;
  detail: string | null;
}
export interface DispatchClaim {
  effect: StoredEffect;
  owner: string;
  epoch: number;
  until: number;
  mode: "send" | "reconcile";
}
export type RetryEvidence = "host-deduplicates-original-id" | "previous-sender-fenced-and-host-confirmed-absent";
export interface Scan { after?: string; limit?: number; codeId?: string }
export interface Commit { checkpoint: Checkpoint; effects: StoredEffect[]; requests: StoredRequest[]; waits: StoredWait[] }

/**
 * Hosts validate current authority and reply schemas at their own boundary.
 * Leases authorize storage updates, not physical external actions. Expiration only
 * permits reconciliation; replay requires explicit host evidence for the same ID.
 * All adapters are asynchronous, including the synchronous SQLite reference backend.
 */
export interface DurableStore {
  currentTime(): Promise<number>;
  saveCode(codeId: string, ast: string): Promise<void>;
  loadCode(codeId: string): Promise<string | null>;
  create(initial: InitialCheckpoint): Promise<boolean>;
  load(executionId: string): Promise<Checkpoint | null>;
  commit(expected: Checkpoint, change: CheckpointChange): Promise<Commit | null>;
  effects(executionId: string): Promise<StoredEffect[]>;
  request(id: string): Promise<StoredRequest | null>;
  requestEvidence(id: string): Promise<RequestEvidence[]>;
  settleRequest(id: string, epoch: number, holder: string, outcome: RequestOutcome): Promise<boolean>;
  rejectAnswer(id: string, epoch: number, holder: string, answer: Json, reason: string): Promise<boolean>;
  wait(id: string): Promise<StoredWait | null>;
  publishEvent(id: string, key: string, mode: "fact" | "stream", value: Json, originExecutionId?: string): Promise<boolean>;
  handOver(id: string, epoch: number, holder: string, nextHolder: string): Promise<StoredRequest | null>;
  claimEffect(id: string, owner: string, leaseMs: number): Promise<DispatchClaim | null>;
  provideEvidence(id: string, detail: string): Promise<boolean>;
  prepareRetry(claim: DispatchClaim, evidence: RetryEvidence): Promise<DispatchClaim | null>;
  markUncertain(claim: DispatchClaim, detail: string): Promise<boolean>;
  recordDelivery(claim: DispatchClaim, receipt: Json): Promise<boolean>;
  scanEffects(scan?: Scan): Promise<StoredEffect[]>;
  scanReady(scan?: Scan): Promise<Checkpoint[]>;
  close(): Promise<void>;
}

export function deadlineAt(deadline: Deadline | null | undefined, now: number): number | null {
  if (deadline == null) return null;
  const at = typeof deadline === "number" ? deadline : now + deadline.after;
  if ((typeof deadline !== "number" && (!Number.isSafeInteger(deadline.after) || deadline.after < 0)) ||
      !Number.isSafeInteger(at) || at < 0) throw new TypeError("Deadline must fit the host clock's nonnegative safe integer milliseconds");
  return at;
}

export function projectOccurrence(value: Json, path: SourcePath = []): Json {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i] !== "First" && path[i] !== "Second") throw new TypeError("Invalid source constructor path");
    value = { type: "variant", name: path[i], args: [value] };
  }
  return value;
}

/** NoReply is exclusively a clock resolution; hosts cannot declare it. */
export function validateReply(outcome: RequestOutcome): void {
  if (!["Answered", "Refused", "Broke", "Cancelled", "Revoked"].includes(outcome.tag) ||
      (outcome.tag === "Answered" && !Object.hasOwn(outcome, "value")) ||
      ((outcome.tag === "Refused" || outcome.tag === "Broke") && typeof outcome.reason !== "string")) {
    throw new TypeError("Invalid request reply; NoReply is decided only by the store clock");
  }
}

export function requestId(executionId: string, revision: number, ordinal = 0): string {
  return `${effectId(executionId, revision, ordinal)}/request`;
}

export function waitId(executionId: string, revision: number, ordinal = 0): string {
  return `${effectId(executionId, revision, ordinal)}/wait`;
}

/** Stable across retries of exactly the same committed transition. */
export function effectId(executionId: string, revision: number, ordinal = 0): string {
  return `${encodeURIComponent(executionId)}/${revision}/${ordinal}`;
}

/** Reject values JSON would silently drop or transform before touching storage. */
export function encodeJson(value: Json): string {
  const ancestors = new Set<object>();
  function visit(item: unknown): void {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0)) return;
    if (typeof item !== "object" || item === null) throw new TypeError("Snapshot must contain JSON data only");
    if (ancestors.has(item)) throw new TypeError("Snapshot cycles must use explicit references");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError("Snapshot objects must be plain data");
    }
    if (Object.getOwnPropertySymbols(item).length > 0) throw new TypeError("Snapshot cannot contain symbol keys");
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const field = (descriptor: PropertyDescriptor | undefined): void => {
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
        throw new TypeError("Snapshot cannot contain accessors, holes or hidden fields");
      }
      visit(descriptor.value);
    };
    if (Array.isArray(item)) {
      for (const key of Object.keys(descriptors)) {
        if (key !== "length" && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) {
          throw new TypeError("Snapshot arrays cannot contain extra properties");
        }
      }
      for (let i = 0; i < item.length; i++) field(descriptors[String(i)]);
    } else {
      for (const descriptor of Object.values(descriptors)) field(descriptor);
    }
    ancestors.delete(item);
  }
  visit(value);
  return JSON.stringify(value);
}
