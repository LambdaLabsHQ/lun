import { DatabaseSync } from "node:sqlite";
import { closeSync, openSync } from "node:fs";
import {
  effectId,
  encodeJson,
  type Checkpoint,
  type CheckpointChange,
  type Commit,
  type DurableStore,
  type ExecutionStatus,
  type InitialCheckpoint,
  type Json,
  type StoredEffect,
} from "./persistence.ts";

type Row = Record<string, unknown>;
const schemaVersion = 1;
const terminal = new Set<ExecutionStatus>(["completed", "failed", "cancelled", "revoked"]);

function checkpoint(row: Row): Checkpoint {
  return {
    executionId: row.id as string,
    revision: row.revision as number,
    codeId: row.code_id as string,
    machineVersion: row.machine_version as string,
    status: row.status as ExecutionStatus,
    snapshot: JSON.parse(row.snapshot as string) as Json,
  };
}

function storedEffect(row: Row): StoredEffect {
  return {
    id: row.id as string,
    executionId: row.execution_id as string,
    revision: row.revision as number,
    ordinal: row.ordinal as number,
    operation: row.operation as string,
    arguments: JSON.parse(row.arguments as string) as Json,
    status: row.status as StoredEffect["status"],
    result: row.result === null ? null : JSON.parse(row.result as string) as Json,
    detail: row.detail as string | null,
  };
}

/** Local reference adapter. SQLite transactions own the checkpoint/outbox commit. */
export class SqliteStore implements DurableStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (path !== ":memory:") {
      try {
        const descriptor = openSync(path, "wx", 0o600);
        closeSync(descriptor);
      } catch (error) {
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
          if (tables.length !== 0) throw new Error("Refusing to initialize a nonempty database without a Norn schema version");
          this.db.exec(`
            CREATE TABLE executions (
              id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
              code_id TEXT NOT NULL, machine_version TEXT NOT NULL,
              status TEXT NOT NULL, snapshot TEXT NOT NULL
            );
            CREATE TABLE effects (
              id TEXT PRIMARY KEY,
              execution_id TEXT NOT NULL REFERENCES executions(id),
              revision INTEGER NOT NULL, ordinal INTEGER NOT NULL,
              operation TEXT NOT NULL, arguments TEXT NOT NULL,
              status TEXT NOT NULL, result TEXT, detail TEXT
            );
            CREATE INDEX effects_execution ON effects(execution_id, revision, ordinal);
            PRAGMA user_version = 1;
          `);
        } else if (version !== schemaVersion) {
          throw new Error(`Unsupported Norn store version ${version}; migration is required`);
        }
      });
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = body();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the originating failure. */ }
      throw error;
    }
  }

  create(initial: InitialCheckpoint): boolean {
    const snapshot = encodeJson(initial.snapshot);
    return this.db.prepare(`
      INSERT INTO executions(id, revision, code_id, machine_version, status, snapshot)
      VALUES (?, 0, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
    `).run(initial.executionId, initial.codeId, initial.machineVersion, initial.status, snapshot).changes === 1;
  }

  load(executionId: string): Checkpoint | null {
    const row = this.db.prepare("SELECT * FROM executions WHERE id = ?").get(executionId);
    return row ? checkpoint(row) : null;
  }

  commit(expected: Checkpoint, change: CheckpointChange): Commit | null {
    if (!Number.isSafeInteger(expected.revision) || expected.revision < 0 || !Number.isSafeInteger(expected.revision + 1)) {
      throw new TypeError("Checkpoint revision must be a nonnegative safe integer");
    }
    const snapshot = encodeJson(change.snapshot);
    const descriptions = (change.effects ?? []).map((effect) => ({
      operation: effect.operation,
      arguments: encodeJson(effect.arguments),
    }));
    return this.transaction(() => {
      const current = this.load(expected.executionId);
      if (!current || current.revision !== expected.revision || current.codeId !== expected.codeId ||
          current.machineVersion !== expected.machineVersion || terminal.has(current.status)) return null;
      const revision = current.revision + 1;
      this.db.prepare("UPDATE executions SET revision = ?, status = ?, snapshot = ? WHERE id = ?")
        .run(revision, change.status, snapshot, current.executionId);
      const effects: StoredEffect[] = [];
      const insert = this.db.prepare(`
        INSERT INTO effects(id, execution_id, revision, ordinal, operation, arguments, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `);
      for (const [ordinal, description] of descriptions.entries()) {
        const id = effectId(current.executionId, revision, ordinal);
        insert.run(id, current.executionId, revision, ordinal, description.operation, description.arguments);
        effects.push({
          id, executionId: current.executionId, revision, ordinal,
          operation: description.operation, arguments: JSON.parse(description.arguments) as Json,
          status: "pending", result: null, detail: null,
        });
      }
      return {
        checkpoint: { ...current, revision, status: change.status, snapshot: JSON.parse(snapshot) as Json },
        effects,
      };
    });
  }

  effects(executionId: string): StoredEffect[] {
    return this.db.prepare("SELECT * FROM effects WHERE execution_id = ? ORDER BY revision, ordinal")
      .all(executionId).map(storedEffect);
  }

  beginDispatch(id: string): boolean {
    return this.db.prepare("UPDATE effects SET status = 'dispatching' WHERE id = ? AND status = 'pending'")
      .run(id).changes === 1;
  }

  markUncertain(id: string, detail: string): boolean {
    return this.db.prepare("UPDATE effects SET status = 'uncertain', detail = ? WHERE id = ? AND status = 'dispatching'")
      .run(detail, id).changes === 1;
  }

  recordResult(id: string, result: Json): boolean {
    return this.db.prepare(`
      UPDATE effects SET status = 'settled', result = ?, detail = NULL
      WHERE id = ? AND status IN ('dispatching', 'uncertain')
    `).run(encodeJson(result), id).changes === 1;
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
