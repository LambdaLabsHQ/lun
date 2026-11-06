import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { effectId, type InitialCheckpoint, type Json } from "../../src/runtime/persistence.ts";
import { SqliteStore } from "../../src/runtime/sqlite-store.ts";

const initial: InitialCheckpoint = {
  executionId: "program/one", codeId: "code:one", machineVersion: "cek:1", status: "ready",
  snapshot: { control: 0, frames: [], environments: { root: { bindings: {} } } },
};

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "norn-store-"));
  const path = join(directory, "runtime.sqlite");
  const stores: SqliteStore[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return () => { const store = new SqliteStore(path); stores.push(store); return store; };
}

test("a restart restores lexical references and an undelivered original intent", (t) => {
  const open = fixture(t);
  const first = open();
  assert.equal(first.create(initial), true);
  const saved = {
    control: { kind: "effect", id: effectId(initial.executionId, 1) },
    frames: [{ kind: "call", environment: "root" }],
    environments: { root: { bindings: { next: { closure: "fn1", environment: "root" } } } },
  };
  const committed = first.commit(first.load(initial.executionId)!, {
    status: "suspended", snapshot: saved,
    effects: [{ operation: "ask", arguments: { who: "alice", text: "Ship?" } }],
  })!;
  first.close();

  const resumed = open();
  assert.deepEqual(resumed.load(initial.executionId), committed.checkpoint);
  assert.deepEqual(resumed.load(initial.executionId)!.snapshot, saved);
  assert.deepEqual(resumed.effects(initial.executionId), committed.effects);
  assert.equal(resumed.effects(initial.executionId)[0].status, "pending");
});

test("two workers at the same revision can commit only one state and outbox", (t) => {
  const open = fixture(t);
  const a = open();
  const b = open();
  a.create(initial);
  const beforeA = a.load(initial.executionId)!;
  const beforeB = b.load(initial.executionId)!;
  const winner = a.commit(beforeA, {
    status: "suspended", snapshot: { winner: "a" },
    effects: [{ operation: "run", arguments: "first request" }],
  });
  const loser = b.commit(beforeB, {
    status: "suspended", snapshot: { winner: "b" },
    effects: [{ operation: "run", arguments: "second request" }],
  });
  assert.ok(winner);
  assert.equal(loser, null);
  assert.deepEqual(b.load(initial.executionId)!.snapshot, { winner: "a" });
  assert.equal(b.effects(initial.executionId).length, 1);
  assert.equal(b.effects(initial.executionId)[0].arguments, "first request");
});

test("a process killed after commit leaves both its checkpoint and original intent", { timeout: 10_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-crash-"));
  const path = join(directory, "runtime.sqlite");
  const moduleUrl = new URL("../../src/runtime/sqlite-store.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { SqliteStore } from ${JSON.stringify(moduleUrl)};
    const store = new SqliteStore(${JSON.stringify(path)});
    store.create(${JSON.stringify(initial)});
    store.commit(store.load(${JSON.stringify(initial.executionId)}), {
      status: 'suspended', snapshot: { continuation: 'after-the-request' },
      effects: [{ operation: 'run', arguments: 'one original request' }]
    });
    process.stdout.write('committed');
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => { throw new Error("child exited before committing"); }),
  ]);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const recovered = new SqliteStore(path);
  try {
    assert.deepEqual(recovered.load(initial.executionId)!.snapshot, { continuation: "after-the-request" });
    const [effect] = recovered.effects(initial.executionId);
    assert.equal(effect.status, "pending");
    assert.equal(effect.arguments, "one original request");
    assert.equal(recovered.effects(initial.executionId).length, 1);
  } finally { recovered.close(); }
});

test("a dispatch crash stays uncertain and records one original result", (t) => {
  const open = fixture(t);
  const sender = open();
  const other = open();
  sender.create(initial);
  const effect = sender.commit(sender.load(initial.executionId)!, {
    status: "suspended", snapshot: { waiting: true },
    effects: [{ operation: "run", arguments: "do the work" }],
  })!.effects[0];
  assert.equal(sender.beginDispatch(effect.id), true);
  assert.equal(other.beginDispatch(effect.id), false);
  sender.close(); // The transport may have sent; its acknowledgement is lost.

  const recovered = open();
  assert.equal(recovered.effects(initial.executionId)[0].status, "dispatching");
  assert.equal(recovered.beginDispatch(effect.id), false);
  assert.equal(recovered.markUncertain(effect.id, "reconcile original request"), true);
  assert.equal(recovered.recordResult(effect.id, { tag: "Done", value: "original receipt" }), true);
  assert.equal(recovered.recordResult(effect.id, { tag: "Failed", value: "duplicate" }), false);
  assert.deepEqual(recovered.effects(initial.executionId)[0].result, { tag: "Done", value: "original receipt" });
  assert.equal(recovered.load(initial.executionId)!.revision, 1); // Receipt alone never resumes code.
});

test("nonportable state cannot partially save an execution or effect", (t) => {
  const store = fixture(t)();
  store.create(initial);
  const expected = store.load(initial.executionId)!;
  const arrayWithHook = Object.assign([1], { toJSON: () => "lost the original state" });
  const arrayWithGetter = Object.defineProperty([1], "0", { enumerable: true, get() { throw new Error("getter must never run"); } });
  for (const bad of [undefined, () => 1, NaN, Infinity, -0, new Date(), { hidden: undefined }, arrayWithHook, arrayWithGetter, Array(2)]) {
    assert.throws(() => store.commit(expected, {
      status: "suspended", snapshot: { changed: true },
      effects: [{ operation: "ask", arguments: bad as Json }],
    }), /Snapshot/);
    assert.deepEqual(store.load(initial.executionId), expected);
    assert.deepEqual(store.effects(initial.executionId), []);
  }
  const cyclic: Record<string, Json> = {};
  cyclic.self = cyclic;
  assert.throws(() => store.commit(expected, { status: "ready", snapshot: cyclic }), /explicit references/);
});

test("independent processes can initialize and write the same fresh store", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-workers-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "runtime.sqlite");
  const moduleUrl = new URL("../../src/runtime/sqlite-store.ts", import.meta.url).href;
  const exec = promisify(execFile);
  await Promise.all(["worker-a", "worker-b"].map((executionId) => exec(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "-e",
    `import { SqliteStore } from ${JSON.stringify(moduleUrl)};
     const store = new SqliteStore(${JSON.stringify(path)});
     store.create(${JSON.stringify({ ...initial, executionId })});
     store.close();`,
  ])));
  const store = new SqliteStore(path);
  try {
    assert.ok(store.load("worker-a"));
    assert.ok(store.load("worker-b"));
  } finally { store.close(); }
});

test("a different pinned definition, ABI, or terminal execution cannot resume", (t) => {
  const store = fixture(t)();
  store.create(initial);
  const before = store.load(initial.executionId)!;
  assert.equal(store.commit({ ...before, codeId: "replacement" }, { status: "ready", snapshot: null }), null);
  assert.equal(store.commit({ ...before, machineVersion: "cek:2" }, { status: "ready", snapshot: null }), null);
  const done = store.commit(before, { status: "completed", snapshot: "result" })!.checkpoint;
  assert.equal(store.commit(done, { status: "ready", snapshot: "revived" }), null);
  assert.deepEqual(store.load(initial.executionId)!.snapshot, "result");
});

test("an unsupported database is refused without rewriting its schema version", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-newer-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "runtime.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => new SqliteStore(path), /migration is required/);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 99);
  check.close();
});

test("a new on-disk snapshot database is private to its OS user", { skip: process.platform === "win32" }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-private-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "runtime.sqlite");
  const store = new SqliteStore(path);
  try {
    store.create({ ...initial, snapshot: { privateMessage: "synthetic captured input" } });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { store.close(); }
});
