import { DatabaseSync } from "node:sqlite";
import { closeSync, openSync } from "node:fs";
import {
  effectId, requestId, encodeJson,
  type Checkpoint, type CheckpointChange, type Commit, type DispatchClaim, type DurableStore,
  type ExecutionStatus, type InitialCheckpoint, type Json, type RequestOutcome,
  type RetryEvidence, type Scan, type StoredEffect, type StoredRequest, type WaitFor,
} from "./persistence.ts";

type Row = Record<string, unknown>;
const schemaVersion = 2;
const terminal = new Set<ExecutionStatus>(["completed", "failed", "cancelled", "revoked"]);
const activeSql = "e.status IN ('ready', 'suspended')";

function checkpoint(row: Row): Checkpoint {
  return {
    executionId: row.id as string, revision: row.revision as number,
    codeId: row.code_id as string, machineVersion: row.machine_version as string,
    status: row.status as ExecutionStatus, snapshot: JSON.parse(row.snapshot as string) as Json,
    waitingFor: row.wait_kind === null ? null : { kind: row.wait_kind, id: row.wait_id } as WaitFor,
  };
}
function storedEffect(row: Row): StoredEffect {
  return {
    id: row.id as string, executionId: row.execution_id as string,
    revision: row.revision as number, ordinal: row.ordinal as number,
    operation: row.operation as string, arguments: JSON.parse(row.arguments as string) as Json,
    kind: row.kind as StoredEffect["kind"], status: row.status as StoredEffect["status"],
    receipt: row.receipt === null ? null : JSON.parse(row.receipt as string) as Json,
    detail: row.detail as string | null,
  };
}
function storedRequest(row: Row): StoredRequest {
  return {
    id: row.id as string, executionId: row.execution_id as string, epoch: row.epoch as number,
    holder: row.holder as string, arguments: JSON.parse(row.arguments as string) as Json,
    outcome: row.outcome === null ? null : JSON.parse(row.outcome as string) as RequestOutcome,
  };
}
function pageSize(scan: Scan): number {
  const limit = scan.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Scan limit must be a positive safe integer");
  return limit;
}
function clock(now: number, leaseMs = 1): void {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1 ||
      !Number.isSafeInteger(now + leaseMs)) throw new TypeError("Lease clock and duration must be safe integer milliseconds");
}

/** Local reference adapter. No async callbacks run inside SQLite transactions. */
export class SqliteStore implements DurableStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    if (path !== ":memory:") {
      try { const fd = openSync(path, "wx", 0o600); closeSync(fd); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      }
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.transaction(() => {
        const version = (this.db.prepare("PRAGMA user_version").get() as Row).user_version;
        if (version === 0) {
          const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
          if (tables.length) throw new Error("Refusing to initialize a nonempty database without a Norn schema version");
          this.db.exec(`
            CREATE TABLE executions (
              id TEXT PRIMARY KEY, revision INTEGER NOT NULL, code_id TEXT NOT NULL,
              machine_version TEXT NOT NULL, status TEXT NOT NULL, snapshot TEXT NOT NULL,
              wait_kind TEXT, wait_id TEXT
            );
            CREATE TABLE effects (
              id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id),
              revision INTEGER NOT NULL, ordinal INTEGER NOT NULL, operation TEXT NOT NULL,
              arguments TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
              receipt TEXT, detail TEXT, owner TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0,
              lease_until INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE requests (
              id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id),
              epoch INTEGER NOT NULL, holder TEXT NOT NULL, arguments TEXT NOT NULL, outcome TEXT
            );
            CREATE INDEX effects_execution ON effects(execution_id, revision, ordinal);
            CREATE INDEX effects_recovery ON effects(status, lease_until, id);
            CREATE INDEX requests_execution ON requests(execution_id);
            PRAGMA user_version = 2;
          `);
        } else if (version !== schemaVersion) {
          throw new Error(`Unsupported Norn store version ${version}; migration is required`);
        }
      });
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = body(); this.db.exec("COMMIT"); return result; }
    catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the originating failure. */ }
      throw error;
    }
  }
  private read(executionId: string): Checkpoint | null {
    const row = this.db.prepare("SELECT * FROM executions WHERE id = ?").get(executionId);
    return row ? checkpoint(row) : null;
  }
  private readRequest(id: string): StoredRequest | null {
    const row = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id);
    return row ? storedRequest(row) : null;
  }
  private insertEffect(id: string, executionId: string, revision: number, ordinal: number,
    operation: string, args: Json, kind: "work" | "notification"): StoredEffect {
    const encoded = encodeJson(args);
    this.db.prepare(`INSERT INTO effects(id, execution_id, revision, ordinal, operation, arguments, kind, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`).run(id, executionId, revision, ordinal, operation, encoded, kind);
    return { id, executionId, revision, ordinal, operation, arguments: JSON.parse(encoded) as Json,
      kind, status: "pending", receipt: null, detail: null };
  }
  private notice(request: StoredRequest, suffix: string, operation: string, args: Json,
    kind: "work" | "notification" = "notification"): StoredEffect {
    const execution = this.read(request.executionId)!;
    return this.insertEffect(`${request.id}/epoch/${request.epoch}/${suffix}`, request.executionId,
      execution.revision, 0, operation, args, kind);
  }
  private withdrawRequestOffer(id: string): void {
    this.db.prepare(`UPDATE effects SET status = 'withdrawn', detail = 'request no longer assigned'
      WHERE operation = 'request.offer' AND json_extract(arguments, '$.requestId') = ? AND status = 'pending'`).run(id);
  }
  private finishRequest(request: StoredRequest, outcome: RequestOutcome): void {
    this.db.prepare("UPDATE requests SET outcome = ? WHERE id = ?").run(encodeJson(outcome as unknown as Json), request.id);
    this.withdrawRequestOffer(request.id);
    this.notice(request, "closed", "request.closed", {
      requestId: request.id, epoch: request.epoch, holder: request.holder,
      outcome: outcome as unknown as Json,
    });
  }
  private canSend(effect: StoredEffect): boolean {
    if (effect.kind === "notification") return true;
    if (terminal.has(this.read(effect.executionId)!.status)) return false;
    if (effect.operation !== "request.offer") return true;
    const args = effect.arguments as { requestId: string; epoch: number; holder: string };
    const request = this.readRequest(args.requestId);
    return request !== null && request.outcome === null && request.epoch === args.epoch && request.holder === args.holder;
  }
  async create(initial: InitialCheckpoint): Promise<boolean> {
    const waiting = initial.waitingFor ?? null;
    if (waiting) throw new Error("Initial creation cannot reference an uncommitted wait");
    return this.db.prepare(`INSERT INTO executions(id, revision, code_id, machine_version, status, snapshot, wait_kind, wait_id)
      VALUES (?, 0, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(
      initial.executionId, initial.codeId, initial.machineVersion, initial.status, encodeJson(initial.snapshot),
      waiting?.kind ?? null, waiting?.id ?? null).changes === 1;
  }
  async load(executionId: string): Promise<Checkpoint | null> { return this.read(executionId); }
  async commit(expected: Checkpoint, change: CheckpointChange): Promise<Commit | null> {
    if (!Number.isSafeInteger(expected.revision) || expected.revision < 0 || !Number.isSafeInteger(expected.revision + 1)) {
      throw new TypeError("Checkpoint revision must be a nonnegative safe integer");
    }
    const snapshot = encodeJson(change.snapshot);
    const effects = (change.effects ?? []).map(e => ({ ...e, arguments: JSON.parse(encodeJson(e.arguments)) as Json }));
    const requests = (change.requests ?? []).map(r => ({ ...r, arguments: JSON.parse(encodeJson(r.arguments)) as Json }));
    if (terminal.has(change.status) && (requests.length || effects.some(e => (e.kind ?? "work") === "work"))) {
      throw new Error("A terminal transition cannot create new work");
    }
    return this.transaction(() => {
      const current = this.read(expected.executionId);
      if (!current || current.revision !== expected.revision || current.codeId !== expected.codeId ||
        current.machineVersion !== expected.machineVersion || terminal.has(current.status)) return null;
      const revision = current.revision + 1;
      const waiting = change.waitingFor ?? null;
      this.db.prepare("UPDATE executions SET revision = ?, status = ?, snapshot = ?, wait_kind = ?, wait_id = ? WHERE id = ?")
        .run(revision, change.status, snapshot, waiting?.kind ?? null, waiting?.id ?? null, current.executionId);
      const savedEffects = effects.map((e, ordinal) => this.insertEffect(effectId(current.executionId, revision, ordinal),
        current.executionId, revision, ordinal, e.operation, e.arguments, e.kind ?? "work"));
      const savedRequests = requests.map((r, ordinal): StoredRequest => {
        const id = requestId(current.executionId, revision, ordinal);
        this.db.prepare("INSERT INTO requests(id, execution_id, epoch, holder, arguments) VALUES (?, ?, 0, ?, ?)")
          .run(id, current.executionId, r.holder, encodeJson(r.arguments));
        const request = { ...r, id, executionId: current.executionId, epoch: 0, outcome: null };
        savedEffects.push(this.notice(request, "offer", "request.offer", {
          requestId: id, epoch: 0, holder: r.holder, arguments: r.arguments,
        }, "work"));
        return request;
      });
      if (waiting) {
        const table = waiting.kind === "delivery" ? "effects" : "requests";
        if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND execution_id = ?`).get(waiting.id, current.executionId)) {
          throw new Error("A checkpoint must wait on its own durable effect or request");
        }
      }
      if (terminal.has(change.status)) {
        this.db.prepare(`UPDATE effects SET status = 'withdrawn', detail = 'execution terminated'
          WHERE execution_id = ? AND status = 'pending' AND kind = 'work'`).run(current.executionId);
        const open = this.db.prepare("SELECT * FROM requests WHERE execution_id = ? AND outcome IS NULL")
          .all(current.executionId).map(storedRequest);
        for (const request of open) this.finishRequest(request, { tag: change.status === "revoked" ? "Revoked" : "Cancelled" });
      }
      return { checkpoint: this.read(current.executionId)!, effects: savedEffects, requests: savedRequests };
    });
  }
  async effects(executionId: string): Promise<StoredEffect[]> {
    return this.db.prepare("SELECT * FROM effects WHERE execution_id = ? ORDER BY revision, ordinal, id")
      .all(executionId).map(storedEffect);
  }
  async request(id: string): Promise<StoredRequest | null> { return this.readRequest(id); }
  async settleRequest(id: string, epoch: number, holder: string, outcome: RequestOutcome): Promise<boolean> {
    encodeJson(outcome as unknown as Json);
    if (!["Done", "Declined", "Failed", "Cancelled", "Revoked"].includes(outcome.tag) ||
      (outcome.tag === "Done" && !Object.hasOwn(outcome, "value")) ||
      ((outcome.tag === "Declined" || outcome.tag === "Failed") && typeof outcome.reason !== "string")) {
      throw new TypeError("Invalid request outcome");
    }
    return this.transaction(() => {
      const request = this.readRequest(id);
      if (!request || request.epoch !== epoch || request.holder !== holder || request.outcome !== null ||
          terminal.has(this.read(request.executionId)!.status)) return false;
      this.finishRequest(request, outcome);
      return true;
    });
  }
  async handOver(id: string, epoch: number, holder: string, nextHolder: string): Promise<StoredRequest | null> {
    return this.transaction(() => {
      const request = this.readRequest(id);
      if (!request || request.epoch !== epoch || request.holder !== holder || request.outcome !== null ||
        terminal.has(this.read(request.executionId)!.status)) return null;
      if (!nextHolder || nextHolder === holder || !Number.isSafeInteger(epoch + 1)) throw new TypeError("Invalid next request holder");
      this.withdrawRequestOffer(id);
      this.notice(request, "released", "request.released", { requestId: id, epoch, holder, nextHolder });
      const next = { ...request, epoch: epoch + 1, holder: nextHolder };
      this.db.prepare("UPDATE requests SET epoch = ?, holder = ? WHERE id = ?").run(next.epoch, nextHolder, id);
      this.notice(next, "offer", "request.offer", { requestId: id, epoch: next.epoch, holder: nextHolder, arguments: next.arguments }, "work");
      return next;
    });
  }
  private validClaim(claim: DispatchClaim, now: number): Row | null {
    clock(now);
    const row = this.db.prepare(`SELECT * FROM effects WHERE id = ? AND owner = ? AND lease_epoch = ?
      AND lease_until > ? AND status IN ('dispatching', 'uncertain')`).get(claim.effect.id, claim.owner, claim.epoch, now);
    return row ?? null;
  }
  async claimEffect(id: string, owner: string, now: number, leaseMs: number): Promise<DispatchClaim | null> {
    clock(now, leaseMs);
    if (!owner) throw new TypeError("A dispatch claim needs an owner");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM effects WHERE id = ?").get(id);
      if (!row || !["pending", "dispatching", "uncertain"].includes(row.status as string) || (row.lease_until as number) > now) return null;
      const effect = storedEffect(row);
      if (effect.status === "pending" && !this.canSend(effect)) return null;
      const epoch = (row.lease_epoch as number) + 1;
      const mode = effect.status === "pending" ? "send" : "reconcile";
      this.db.prepare("UPDATE effects SET status = ?, owner = ?, lease_epoch = ?, lease_until = ? WHERE id = ?")
        .run(mode === "send" ? "dispatching" : "uncertain", owner, epoch, now + leaseMs, id);
      return { effect: { ...effect, status: mode === "send" ? "dispatching" : "uncertain" }, owner, epoch, until: now + leaseMs, mode };
    });
  }
  async prepareRetry(claim: DispatchClaim, evidence: RetryEvidence, now: number): Promise<DispatchClaim | null> {
    if (!["host-deduplicates-original-id", "previous-attempt-proven-unsent"].includes(evidence)) throw new TypeError("Retry requires host evidence");
    return this.transaction(() => {
      const row = this.validClaim(claim, now);
      if (!row || row.status !== "uncertain" || !this.canSend(storedEffect(row))) return null;
      this.db.prepare("UPDATE effects SET status = 'dispatching', detail = ? WHERE id = ?").run(evidence, row.id as string);
      return { ...claim, mode: "send", effect: { ...storedEffect(row), status: "dispatching", detail: evidence } };
    });
  }
  async markUncertain(claim: DispatchClaim, detail: string, now: number): Promise<boolean> {
    return this.transaction(() => {
      if (!this.validClaim(claim, now)) return false;
      this.db.prepare("UPDATE effects SET status = 'uncertain', detail = ?, owner = NULL, lease_until = 0 WHERE id = ?")
        .run(detail, claim.effect.id);
      return true;
    });
  }
  async recordDelivery(claim: DispatchClaim, receipt: Json, now: number): Promise<boolean> {
    const encoded = encodeJson(receipt);
    return this.transaction(() => {
      if (!this.validClaim(claim, now)) return false;
      this.db.prepare("UPDATE effects SET status = 'delivered', receipt = ?, detail = NULL, owner = NULL, lease_until = 0 WHERE id = ?")
        .run(encoded, claim.effect.id);
      return true;
    });
  }
  async scanEffects(now: number, scan: Scan = {}): Promise<StoredEffect[]> {
    clock(now);
    return this.db.prepare(`SELECT f.* FROM effects f JOIN executions e ON e.id = f.execution_id
      WHERE f.id > ? AND ((f.status = 'pending' AND (f.kind = 'notification' OR ${activeSql}))
      OR (f.status IN ('dispatching', 'uncertain') AND f.lease_until <= ?)) ORDER BY f.id LIMIT ?`)
      .all(scan.after ?? "", now, pageSize(scan)).map(storedEffect);
  }
  async scanReady(scan: Scan = {}): Promise<Checkpoint[]> {
    return this.db.prepare(`SELECT e.* FROM executions e WHERE e.id > ? AND
      (e.status = 'ready' OR (e.status = 'suspended' AND (
        (e.wait_kind = 'delivery' AND EXISTS (SELECT 1 FROM effects f WHERE f.id = e.wait_id AND f.status = 'delivered')) OR
        (e.wait_kind = 'request' AND EXISTS (SELECT 1 FROM requests r WHERE r.id = e.wait_id AND r.outcome IS NOT NULL))
      ))) ORDER BY e.id LIMIT ?`).all(scan.after ?? "", pageSize(scan)).map(checkpoint);
  }
  async close(): Promise<void> { if (!this.closed) { this.db.close(); this.closed = true; } }
}
