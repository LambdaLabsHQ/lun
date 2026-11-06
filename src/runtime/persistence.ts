/** Portable data boundary. Native closures and host credentials never enter snapshots. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ExecutionStatus = "ready" | "suspended" | "completed" | "failed" | "cancelled" | "revoked";
export type WaitFor = { kind: "delivery" | "request"; id: string };

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
export interface RequestDescription { holder: string; arguments: Json }
/** Timeout is a result of waiting, never a terminal request outcome. */
export type RequestOutcome =
  | { tag: "Done"; value: Json }
  | { tag: "Declined" | "Failed"; reason: string }
  | { tag: "Cancelled" | "Revoked" };
export interface StoredRequest extends RequestDescription {
  id: string;
  executionId: string;
  epoch: number;
  outcome: RequestOutcome | null;
}
export interface CheckpointChange {
  status: ExecutionStatus;
  snapshot: Json;
  waitingFor?: WaitFor | null;
  effects?: EffectDescription[];
  requests?: RequestDescription[];
}
export interface StoredEffect extends EffectDescription {
  id: string;
  executionId: string;
  revision: number;
  ordinal: number;
  kind: "work" | "notification";
  status: "pending" | "dispatching" | "uncertain" | "delivered" | "withdrawn";
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
export type RetryEvidence = "host-deduplicates-original-id" | "previous-attempt-proven-unsent";
export interface Scan { after?: string; limit?: number }
export interface Commit { checkpoint: Checkpoint; effects: StoredEffect[]; requests: StoredRequest[] }

/**
 * Hosts validate current authority and reply schemas at their own boundary.
 * Leases authorize storage updates, not physical external actions. Expiration only
 * permits reconciliation; replay requires explicit host evidence for the same ID.
 * All adapters are asynchronous, including the synchronous SQLite reference backend.
 */
export interface DurableStore {
  create(initial: InitialCheckpoint): Promise<boolean>;
  load(executionId: string): Promise<Checkpoint | null>;
  commit(expected: Checkpoint, change: CheckpointChange): Promise<Commit | null>;
  effects(executionId: string): Promise<StoredEffect[]>;
  request(id: string): Promise<StoredRequest | null>;
  settleRequest(id: string, epoch: number, holder: string, outcome: RequestOutcome): Promise<boolean>;
  handOver(id: string, epoch: number, holder: string, nextHolder: string): Promise<StoredRequest | null>;
  claimEffect(id: string, owner: string, now: number, leaseMs: number): Promise<DispatchClaim | null>;
  prepareRetry(claim: DispatchClaim, evidence: RetryEvidence, now: number): Promise<DispatchClaim | null>;
  markUncertain(claim: DispatchClaim, detail: string, now: number): Promise<boolean>;
  recordDelivery(claim: DispatchClaim, receipt: Json, now: number): Promise<boolean>;
  scanEffects(now: number, scan?: Scan): Promise<StoredEffect[]>;
  scanReady(scan?: Scan): Promise<Checkpoint[]>;
  close(): Promise<void>;
}

export function requestId(executionId: string, revision: number, ordinal = 0): string {
  return `${effectId(executionId, revision, ordinal)}/request`;
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
