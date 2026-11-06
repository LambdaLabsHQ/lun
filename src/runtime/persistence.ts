/** Portable persistence boundary. These values contain data, never native closures. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ExecutionStatus = "ready" | "suspended" | "completed" | "failed" | "cancelled" | "revoked";

export interface Checkpoint {
  executionId: string;
  revision: number;
  codeId: string;
  machineVersion: string;
  status: ExecutionStatus;
  snapshot: Json;
}

export type InitialCheckpoint = Omit<Checkpoint, "revision">;

export interface EffectDescription {
  operation: string;
  arguments: Json;
}

export interface CheckpointChange {
  status: ExecutionStatus;
  snapshot: Json;
  effects?: EffectDescription[];
}

export interface StoredEffect extends EffectDescription {
  id: string;
  executionId: string;
  revision: number;
  ordinal: number;
  status: "pending" | "dispatching" | "uncertain" | "settled";
  result: Json;
  detail: string | null;
}

export interface Commit {
  checkpoint: Checkpoint;
  effects: StoredEffect[];
}

/**
 * Hosts validate current authority and typed replies before recording results.
 * A recorded result is durable input; it does not itself resume an execution.
 */
export interface DurableStore {
  create(initial: InitialCheckpoint): boolean;
  load(executionId: string): Checkpoint | null;
  commit(expected: Checkpoint, change: CheckpointChange): Commit | null;
  effects(executionId: string): StoredEffect[];
  beginDispatch(effectId: string): boolean;
  markUncertain(effectId: string, detail: string): boolean;
  recordResult(effectId: string, result: Json): boolean;
  close(): void;
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
