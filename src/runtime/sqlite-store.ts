import { systemClock, type Clock } from "./clock.ts";
import { DatabaseSync } from "node:sqlite";
import { closeSync, openSync } from "node:fs";
import {
  effectId, requestId, waitId, encodeJson,
  type Checkpoint, type CheckpointChange, type Commit, type DispatchClaim, type DurableStore,
  type ExecutionStatus, type InitialCheckpoint, type Json, type RequestOutcome,
  type RequestEvidence, type RetryEvidence, type Scan, type StoredEffect, type StoredRequest, type StoredWait, type WaitFor, type WaitOutcome, type WaitDescription,
} from "./persistence.ts";

type Row = Record<string, unknown>;
const schemaVersion = 7;
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
    settledAt: row.settled_at as number | null,
  };
}
function storedWait(row: Row): StoredWait {
  return { ...JSON.parse(row.description as string) as WaitDescription,
    id: row.id as string, executionId: row.execution_id as string, cursor: row.cursor as number,
    outcome: row.outcome === null ? null : JSON.parse(row.outcome as string) as WaitOutcome };
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
  private readonly clock: Clock;
  private closed = false;
  constructor(path: string, clock: Clock = systemClock) {
    this.clock = clock;
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
            CREATE TABLE clock_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), last_seen INTEGER NOT NULL);
            INSERT INTO clock_state VALUES (1, 0);
            CREATE TABLE codes (id TEXT PRIMARY KEY, ast TEXT NOT NULL);
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
              epoch INTEGER NOT NULL, holder TEXT NOT NULL, arguments TEXT NOT NULL, outcome TEXT, settled_at INTEGER
            );
            CREATE TABLE request_evidence (
              seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL REFERENCES requests(id),
              epoch INTEGER NOT NULL, holder TEXT NOT NULL, outcome TEXT NOT NULL,
              received_at INTEGER NOT NULL, accepted INTEGER NOT NULL
            );
            CREATE INDEX request_evidence_request ON request_evidence(request_id, seq);
            CREATE TABLE waits (
              id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id),
              description TEXT NOT NULL, cursor INTEGER NOT NULL, outcome TEXT
            );
            CREATE TABLE events (
              seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              key TEXT NOT NULL, mode TEXT NOT NULL, value TEXT NOT NULL, at INTEGER NOT NULL, origin TEXT
            );
            CREATE INDEX events_key ON events(key, mode, seq);
            CREATE INDEX waits_execution ON waits(execution_id);
            CREATE INDEX effects_execution ON effects(execution_id, revision, ordinal);
            CREATE INDEX effects_recovery ON effects(status, lease_until, id);
            CREATE INDEX requests_execution ON requests(execution_id);
            PRAGMA user_version = 7;
          `);
        } else if (version !== schemaVersion) {
          throw new Error(`Unsupported Norn store version ${version}; migration is required`);
        }
      });
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    } catch (error) { this.db.close(); throw error; }
  }
  private time(): number {
    const observed = this.clock.now(); clock(observed);
    const row = this.db.prepare("UPDATE clock_state SET last_seen = MAX(last_seen, ?) WHERE singleton = 1 RETURNING last_seen").get(observed) as Row;
    return row.last_seen as number;
  }
  async currentTime(): Promise<number> { return this.time(); }
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
    this.db.prepare(`UPDATE effects SET status = 'superseded', detail = 'request no longer assigned', owner = NULL, lease_until = 0
      WHERE operation = 'request.offer' AND json_extract(arguments, '$.requestId') = ?
      AND status IN ('dispatching', 'uncertain', 'blocked')`).run(id);
  }
  private finishRequest(request: StoredRequest, outcome: RequestOutcome, at: number): void {
    this.db.prepare("UPDATE requests SET outcome = ?, settled_at = ? WHERE id = ?").run(encodeJson(outcome as unknown as Json), at, request.id);
    this.withdrawRequestOffer(request.id);
    this.notice(request, "closed", "request.closed", {
      requestId: request.id, epoch: request.epoch, holder: request.holder,
      outcome: outcome as unknown as Json,
    });
  }
  private canSend(effect: StoredEffect): boolean {
    if (effect.kind === "notification") return true;
    if (["failed", "cancelled", "revoked"].includes(this.read(effect.executionId)!.status)) return false;
    if (effect.operation !== "request.offer") return true;
    const args = effect.arguments as { requestId: string; epoch: number; holder: string };
    const request = this.readRequest(args.requestId);
    return request !== null && request.outcome === null && request.epoch === args.epoch && request.holder === args.holder;
  }
  async saveCode(codeId: string, ast: string): Promise<void> {
    this.transaction(() => {
      const row = this.db.prepare("SELECT ast FROM codes WHERE id = ?").get(codeId);
      if (row && row.ast !== ast) throw new Error("Pinned AST identity cannot be overwritten");
      if (!row) this.db.prepare("INSERT INTO codes(id, ast) VALUES (?, ?)").run(codeId, ast);
    });
  }
  async loadCode(codeId: string): Promise<string | null> {
    const row = this.db.prepare("SELECT ast FROM codes WHERE id = ?").get(codeId);
    return row ? row.ast as string : null;
  }
  async create(initial: InitialCheckpoint): Promise<boolean> {
    const waiting = initial.waitingFor ?? null;
    if (waiting) throw new Error("Initial creation cannot reference an uncommitted wait");
    return this.db.prepare(`INSERT INTO executions(id, revision, code_id, machine_version, status, snapshot, wait_kind, wait_id)
      VALUES (?, 0, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(
      initial.executionId, initial.codeId, initial.machineVersion, initial.status, encodeJson(initial.snapshot),
      null, null).changes === 1;
  }
  async load(executionId: string): Promise<Checkpoint | null> { return this.read(executionId); }
  async commit(expected: Checkpoint, change: CheckpointChange): Promise<Commit | null> {
    if (!Number.isSafeInteger(expected.revision) || expected.revision < 0 || !Number.isSafeInteger(expected.revision + 1)) {
      throw new TypeError("Checkpoint revision must be a nonnegative safe integer");
    }
    const now = this.time();
    const snapshot = encodeJson(change.snapshot);
    const effects = (change.effects ?? []).map(e => ({ ...e, arguments: JSON.parse(encodeJson(e.arguments)) as Json }));
    const requests = (change.requests ?? []).map(r => ({ ...r, arguments: JSON.parse(encodeJson(r.arguments)) as Json }));
    if (terminal.has(change.status) && ((change.waits?.length ?? 0) || requests.length || effects.some(e => (e.kind ?? "work") === "work"))) {
      throw new Error("A terminal transition cannot create new work");
    }
    return this.transaction(() => {
      const current = this.read(expected.executionId);
      if (!current || current.revision !== expected.revision || current.codeId !== expected.codeId ||
        current.machineVersion !== expected.machineVersion || terminal.has(current.status)) return null;
      for (const action of change.requestActions ?? []) {
        const r = this.readRequest(action.id);
        if (!r || r.executionId !== current.executionId || r.epoch !== action.epoch || r.holder !== action.holder || r.outcome !== null) return null;
      }
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
        const request: StoredRequest = { ...r, id, executionId: current.executionId, epoch: 0, outcome: null, settledAt: null };
        savedEffects.push(this.notice(request, "offer", "request.offer", {
          requestId: id, epoch: 0, holder: r.holder, arguments: r.arguments,
        }, "work"));
        return request;
      });
      const savedWaits = (change.waits ?? []).map((description, ordinal) => {
        if (description.until !== null) clock(description.until);
        for (const target of description.targets) {
          if (target.kind === "timer") clock(target.at);
          if (target.kind === "request" && this.readRequest(target.id)?.executionId !== current.executionId) throw new Error("Cannot wait on another execution's request");
        }
        for (const id of description.withdrawOnTimeout) {
          if (this.readRequest(id)?.executionId !== current.executionId) throw new Error("Cannot withdraw another execution's request");
        }
        const id = waitId(current.executionId, revision, ordinal);
        const cursor = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as Row).seq as number;
        this.db.prepare("INSERT INTO waits(id, execution_id, description, cursor) VALUES (?, ?, ?, ?)")
          .run(id, current.executionId, encodeJson(description as unknown as Json), cursor);
        return { ...description, id, executionId: current.executionId, cursor, outcome: null } as StoredWait;
      });
      for (const action of change.requestActions ?? []) {
        const r = this.readRequest(action.id)!;
        if (action.action === "cancel") this.finishRequest(r, { tag: "Cancelled" }, now);
        else this.moveRequest(r, action.nextHolder);
      }
      if (waiting) {
        const table = waiting.kind === "delivery" ? "effects" : waiting.kind === "wait" ? "waits" : "requests";
        if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND execution_id = ?`).get(waiting.id, current.executionId)) {
          throw new Error("A checkpoint must wait on its own durable effect or request");
        }
      }
      if (terminal.has(change.status)) {
        if (change.status !== "completed") this.db.prepare(`UPDATE effects SET status = 'withdrawn', detail = 'execution terminated'
          WHERE execution_id = ? AND status = 'pending' AND kind = 'work'`).run(current.executionId);
        const open = this.db.prepare("SELECT * FROM requests WHERE execution_id = ? AND outcome IS NULL")
          .all(current.executionId).map(storedRequest);
        for (const request of open) this.finishRequest(request, { tag: change.status === "revoked" ? "Revoked" : "Cancelled" }, now);
      }
      this.resolveWaits(now);
      return { checkpoint: this.read(current.executionId)!, effects: savedEffects, requests: savedRequests, waits: savedWaits.map(w => this.readWait(w.id)!) };
    });
  }
  async effects(executionId: string): Promise<StoredEffect[]> {
    return this.db.prepare("SELECT * FROM effects WHERE execution_id = ? ORDER BY revision, ordinal, id")
      .all(executionId).map(storedEffect);
  }
  async request(id: string): Promise<StoredRequest | null> { return this.readRequest(id); }
  async requestEvidence(id: string): Promise<RequestEvidence[]> {
    return this.db.prepare("SELECT * FROM request_evidence WHERE request_id = ? ORDER BY seq").all(id).map(row => ({
      epoch: row.epoch as number, holder: row.holder as string, outcome: JSON.parse(row.outcome as string) as RequestOutcome,
      receivedAt: row.received_at as number, accepted: row.accepted === 1,
    }));
  }
  async settleRequest(id: string, epoch: number, holder: string, outcome: RequestOutcome): Promise<boolean> {
    const at = this.time();
    encodeJson(outcome as unknown as Json);
    if (!["Done", "Declined", "Failed", "Cancelled", "Revoked"].includes(outcome.tag) ||
      (outcome.tag === "Done" && !Object.hasOwn(outcome, "value")) ||
      ((outcome.tag === "Declined" || outcome.tag === "Failed") && typeof outcome.reason !== "string")) {
      throw new TypeError("Invalid request outcome");
    }
    return this.transaction(() => {
      this.resolveWaits(at);
      const request = this.readRequest(id);
      if (!request) return false;
      const accepted = request.epoch === epoch && request.holder === holder && request.outcome === null &&
        !terminal.has(this.read(request.executionId)!.status);
      this.db.prepare("INSERT INTO request_evidence(request_id, epoch, holder, outcome, received_at, accepted) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, epoch, holder, encodeJson(outcome as unknown as Json), at, accepted ? 1 : 0);
      if (!accepted) return false;
      this.finishRequest(request, outcome, at);
      this.resolveWaits(at);
      return true;
    });
  }
  async handOver(id: string, epoch: number, holder: string, nextHolder: string): Promise<StoredRequest | null> {
    return this.transaction(() => {
      const request = this.readRequest(id);
      if (!request || request.epoch !== epoch || request.holder !== holder || request.outcome !== null ||
        terminal.has(this.read(request.executionId)!.status)) return null;
      return this.moveRequest(request, nextHolder);
    });
  }
  private moveRequest(request: StoredRequest, nextHolder: string): StoredRequest {
    const { id, epoch, holder } = request;
    if (!nextHolder || nextHolder === holder || !Number.isSafeInteger(epoch + 1)) throw new TypeError("Invalid next request holder");
    this.withdrawRequestOffer(id);
    this.notice(request, "released", "request.released", { requestId: id, epoch, holder, nextHolder });
    const next = { ...request, epoch: epoch + 1, holder: nextHolder };
    this.db.prepare("UPDATE requests SET epoch = ?, holder = ? WHERE id = ?").run(next.epoch, nextHolder, id);
    this.notice(next, "offer", "request.offer", { requestId: id, epoch: next.epoch, holder: nextHolder, arguments: next.arguments }, "work");
    return next;
  }
  private readWait(id: string): StoredWait | null {
    const row = this.db.prepare("SELECT * FROM waits WHERE id = ?").get(id);
    return row ? storedWait(row) : null;
  }
  async wait(id: string): Promise<StoredWait | null> { return this.readWait(id); }
  private resolveWaits(now: number): void {
    const waits = this.db.prepare(`SELECT w.* FROM waits w JOIN executions e ON e.id = w.execution_id
      WHERE w.outcome IS NULL AND ${activeSql}`).all().map(storedWait);
    for (const wait of waits) {
      const candidates: { at: number; priority: number; outcome: WaitOutcome }[] = [];
      if (wait.until !== null && wait.until <= now) candidates.push({ at: wait.until, priority: 0, outcome: { tag: "TimedOut" } });
      for (const target of wait.targets) {
        if (target.kind === "request") {
          const r = this.readRequest(target.id)!;
          if (r.outcome !== null && r.settledAt !== null && r.settledAt <= now) candidates.push({ at: r.settledAt, priority: 1, outcome: r.outcome });
        } else if (target.kind === "timer") {
          if (target.at <= now) candidates.push({ at: target.at, priority: 1, outcome: { tag: "Done", value: Object.hasOwn(target, "result") ? target.result! : { type: "time", value: String(target.at) } } });
        } else {
          const row = this.db.prepare(`SELECT * FROM events WHERE key = ? AND mode = ? AND at <= ? AND seq > ?
            AND (origin IS NULL OR origin <> ?) ORDER BY at, seq LIMIT 1`)
            .get(target.key, target.mode, now, target.mode === "fact" ? 0 : wait.cursor, wait.executionId);
          if (row) candidates.push({ at: row.at as number, priority: 1, outcome: { tag: "Done", value: Object.hasOwn(target, "result") ? target.result! : JSON.parse(row.value as string) as Json } });
        }
      }
      candidates.sort((a, b) => a.at - b.at || a.priority - b.priority);
      if (!candidates.length) continue;
      const { outcome, at } = candidates[0];
      this.db.prepare("UPDATE waits SET outcome = ? WHERE id = ? AND outcome IS NULL").run(encodeJson(outcome as unknown as Json), wait.id);
      if (outcome.tag === "TimedOut") for (const id of wait.withdrawOnTimeout) {
        const request = this.readRequest(id)!;
        if (request.outcome === null) this.finishRequest(request, { tag: "Cancelled" }, at);
      }
    }
  }
  async publishEvent(id: string, key: string, mode: "fact" | "stream", value: Json, originExecutionId?: string): Promise<boolean> {
    const at = this.time(); const encoded = encodeJson(value);
    return this.transaction(() => {
      const inserted = this.db.prepare("INSERT INTO events(id, key, mode, value, at, origin) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
        .run(id, key, mode, encoded, at, originExecutionId ?? null).changes === 1;
      this.resolveWaits(at); return inserted;
    });
  }
  async provideEvidence(id: string, detail: string): Promise<boolean> {
    return this.db.prepare("UPDATE effects SET status = 'uncertain', detail = ?, lease_until = 0 WHERE id = ? AND status = 'blocked'")
      .run(detail, id).changes === 1;
  }
  private validClaim(claim: DispatchClaim, now: number): Row | null {
    clock(now);
    const row = this.db.prepare(`SELECT * FROM effects WHERE id = ? AND owner = ? AND lease_epoch = ?
      AND lease_until > ? AND status IN ('dispatching', 'uncertain')`).get(claim.effect.id, claim.owner, claim.epoch, now);
    return row ?? null;
  }
  async claimEffect(id: string, owner: string, leaseMs: number): Promise<DispatchClaim | null> {
    const now = this.time(); clock(now, leaseMs);
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
  async prepareRetry(claim: DispatchClaim, evidence: RetryEvidence): Promise<DispatchClaim | null> {
    const now = this.time();
    if (!["host-deduplicates-original-id", "previous-sender-fenced-and-host-confirmed-absent"].includes(evidence)) throw new TypeError("Retry requires host evidence");
    return this.transaction(() => {
      const row = this.validClaim(claim, now);
      if (!row || row.status !== "uncertain" || !this.canSend(storedEffect(row))) return null;
      this.db.prepare("UPDATE effects SET status = 'dispatching', detail = ? WHERE id = ?").run(evidence, row.id as string);
      return { ...claim, mode: "send", effect: { ...storedEffect(row), status: "dispatching", detail: evidence } };
    });
  }
  async markUncertain(claim: DispatchClaim, detail: string): Promise<boolean> {
    const now = this.time();
    return this.transaction(() => {
      if (!this.validClaim(claim, now)) return false;
      this.db.prepare("UPDATE effects SET status = 'blocked', detail = ?, owner = NULL, lease_until = 0 WHERE id = ?")
        .run(detail, claim.effect.id);
      return true;
    });
  }
  async recordDelivery(claim: DispatchClaim, receipt: Json): Promise<boolean> {
    const now = this.time();
    const encoded = encodeJson(receipt);
    return this.transaction(() => {
      if (!this.validClaim(claim, now)) return false;
      this.db.prepare("UPDATE effects SET status = 'delivered', receipt = ?, detail = NULL, owner = NULL, lease_until = 0 WHERE id = ?")
        .run(encoded, claim.effect.id);
      return true;
    });
  }
  async scanEffects(scan: Scan = {}): Promise<StoredEffect[]> {
    const now = this.time();
    return this.db.prepare(`SELECT f.* FROM effects f JOIN executions e ON e.id = f.execution_id
      WHERE f.id > ? AND ((f.status = 'pending' AND (f.kind = 'notification' OR e.status IN ('ready', 'suspended', 'completed')))
      OR (f.status IN ('dispatching', 'uncertain') AND f.lease_until <= ?)) ORDER BY f.id LIMIT ?`)
      .all(scan.after ?? "", now, pageSize(scan)).map(storedEffect);
  }
  async scanReady(scan: Scan = {}): Promise<Checkpoint[]> {
    const now = this.time();
    return this.transaction(() => {
    this.resolveWaits(now);
    return this.db.prepare(`SELECT e.* FROM executions e WHERE e.id > ? AND (? IS NULL OR e.code_id = ?) AND
      (e.status = 'ready' OR (e.status = 'suspended' AND (
        (e.wait_kind = 'delivery' AND EXISTS (SELECT 1 FROM effects f WHERE f.id = e.wait_id AND f.status = 'delivered')) OR
        (e.wait_kind = 'request' AND EXISTS (SELECT 1 FROM requests r WHERE r.id = e.wait_id AND r.outcome IS NOT NULL)) OR
        (e.wait_kind = 'wait' AND EXISTS (SELECT 1 FROM waits w WHERE w.id = e.wait_id AND w.outcome IS NOT NULL))
      ))) ORDER BY e.id LIMIT ?`).all(scan.after ?? "", scan.codeId ?? null, scan.codeId ?? null, pageSize(scan)).map(checkpoint);
    });
  }
  async close(): Promise<void> { if (!this.closed) { this.db.close(); this.closed = true; } }
}
