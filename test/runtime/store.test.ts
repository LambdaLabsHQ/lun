import { VirtualClock } from "../../src/runtime/clock.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { effectId, requestId, type InitialCheckpoint, type Json } from "../../src/runtime/persistence.ts";
import { SqliteStore } from "../../src/runtime/sqlite-store.ts";

const initial: InitialCheckpoint = {
  executionId: "program/one", codeId: "code:one", machineVersion: "cek:1", status: "ready",
  snapshot: { control: 0, frames: [], environments: { root: { bindings: {} } } },
};
function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "norn-store-"));
  const path = join(directory, "runtime.sqlite");
  const clock = new VirtualClock();
  const stores: SqliteStore[] = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return Object.assign(() => { const store = new SqliteStore(path, clock); stores.push(store); return store; }, { clock });
}
async function pending(store: SqliteStore, execution = initial.executionId) {
  await store.create({ ...initial, executionId: execution });
  return (await store.commit((await store.load(execution))!, {
    status: "suspended", snapshot: { continuation: "next" },
    waitingFor: { kind: "delivery", id: effectId(execution, 1) },
    effects: [{ operation: "run", arguments: "original work" }],
  }))!;
}
async function requested(store: SqliteStore, execution = initial.executionId) {
  await store.create({ ...initial, executionId: execution });
  return (await store.commit((await store.load(execution))!, {
    status: "suspended", snapshot: { continuation: "after-answer" },
    waitingFor: { kind: "request", id: requestId(execution, 1) },
    requests: [{ holder: "alice", arguments: { text: "Ship?" } }],
  }))!;
}

test("a restart restores lexical references and its original undelivered intent", async (t) => {
  const open = fixture(t);
  const first = open();
  await first.create(initial);
  const saved = {
    control: { kind: "effect", id: effectId(initial.executionId, 1) },
    frames: [{ kind: "call", environment: "root" }],
    environments: { root: { bindings: { next: { closure: "fn1", environment: "root" } } } },
  };
  const committed = (await first.commit((await first.load(initial.executionId))!, {
    status: "suspended", snapshot: saved,
    effects: [{ operation: "ask", arguments: { who: "alice", text: "Ship?" } }],
  }))!;
  await first.close();
  const resumed = open();
  assert.deepEqual(await resumed.load(initial.executionId), committed.checkpoint);
  assert.deepEqual((await resumed.load(initial.executionId))!.snapshot, saved);
  assert.deepEqual(await resumed.effects(initial.executionId), committed.effects);
});

test("two workers at one revision commit only one checkpoint and outbox", async (t) => {
  const open = fixture(t), a = open(), b = open();
  await a.create(initial);
  const beforeA = (await a.load(initial.executionId))!, beforeB = (await b.load(initial.executionId))!;
  const [winner, loser] = await Promise.all([
    a.commit(beforeA, { status: "suspended", snapshot: "a", effects: [{ operation: "run", arguments: "first" }] }),
    b.commit(beforeB, { status: "suspended", snapshot: "b", effects: [{ operation: "run", arguments: "second" }] }),
  ]);
  assert.ok(winner);
  assert.equal(loser, null);
  assert.equal((await b.load(initial.executionId))!.snapshot, "a");
  assert.equal((await b.effects(initial.executionId)).length, 1);
});

test("SIGKILL after commit retains both checkpoint and original intent", { timeout: 10_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-crash-"));
  const path = join(directory, "runtime.sqlite");
  const moduleUrl = new URL("../../src/runtime/sqlite-store.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { SqliteStore } from ${JSON.stringify(moduleUrl)};
    const store = new SqliteStore(${JSON.stringify(path)});
    await store.create(${JSON.stringify(initial)});
    await store.commit(await store.load(${JSON.stringify(initial.executionId)}), {
      status: 'suspended', snapshot: { continuation: 'after-the-request' },
      effects: [{ operation: 'run', arguments: 'one original request' }]
    });
    process.stdout.write('committed');
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("child exited before committing"); })]);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const recovered = new SqliteStore(path);
  try {
    assert.deepEqual((await recovered.load(initial.executionId))!.snapshot, { continuation: "after-the-request" });
    const effects = await recovered.effects(initial.executionId);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].status, "pending");
    assert.equal(effects[0].arguments, "one original request");
  } finally { await recovered.close(); }
});

test("cancellation withdraws queued work atomically but retains terminal notices", async (t) => {
  const open = fixture(t), store = open(), observer = open();
  const committed = await requested(store);
  const cancelled = await store.commit(committed.checkpoint, {
    status: "cancelled", snapshot: "stopped", effects: [{ operation: "notify", arguments: "owner", kind: "notification" }],
  });
  assert.ok(cancelled);
  const effects = await observer.effects(initial.executionId);
  assert.equal(effects.find(e => e.operation === "request.offer")!.status, "withdrawn");
  assert.equal(await observer.claimEffect(committed.effects[0].id, "late-sender", 100), null);
  assert.deepEqual((await observer.request(committed.requests[0].id))!.outcome, { tag: "Cancelled" });
  assert.ok((await observer.scanEffects()).every(e => e.kind === "notification"));
  assert.equal(await observer.settleRequest(committed.requests[0].id, 0, "alice", { tag: "Done", value: "too late" }), false);
  await assert.rejects(store.commit(cancelled!.checkpoint, { status: "completed", snapshot: null,
    effects: [{ operation: "run", arguments: "new work after termination" }] }), /cannot create new work/);
});

test("dead dispatchers are recovered for reconciliation, never an automatic resend", async (t) => {
  const open = fixture(t), a = open(), b = open();
  const { effects: [effect] } = await pending(a);
  open.clock.advanceTo(100);
  const first = (await a.claimEffect(effect.id, "first", 20))!;
  assert.equal(first.mode, "send");
  open.clock.advanceTo(119);
  assert.equal(await b.claimEffect(effect.id, "second", 20), null);
  await a.close();
  const recovered = open();
  assert.equal((await recovered.scanEffects()).length, 0);
  open.clock.advanceTo(120);
  assert.equal((await recovered.scanEffects())[0].id, effect.id);
  const next = (await recovered.claimEffect(effect.id, "second", 20))!;
  assert.equal(next.mode, "reconcile");
  assert.equal(next.effect.id, first.effect.id);
  open.clock.advanceTo(121);
  assert.equal(await b.recordDelivery(first, "stale receipt"), false);
  assert.equal(await b.markUncertain(first, "stale writer"), false);
  await assert.rejects(recovered.prepareRetry(next, "expired" as never), /host evidence/);
  const retry = (await recovered.prepareRetry(next, "host-deduplicates-original-id"))!;
  assert.equal(retry.mode, "send");
  assert.equal(retry.effect.id, effect.id);
  assert.equal(await recovered.recordDelivery(retry, { delivered: true }), true);
  assert.equal(await recovered.recordDelivery(retry, "duplicate"), false);
});

test("unknown delivery remains recoverable without manufacturing success", async (t) => {
  const store = fixture(t)();
  const { effects: [effect] } = await pending(store);
  const claim = (await store.claimEffect(effect.id, "a", 10))!;
  assert.equal(await store.markUncertain(claim, "no transport acknowledgement"), true);
  assert.deepEqual(await store.scanEffects(), []);
  assert.equal(await store.claimEffect(effect.id, "b", 10), null);
  assert.equal(await store.provideEvidence(effect.id, "host lookup now available"), true);
  const reconcile = (await store.claimEffect(effect.id, "b", 10))!;
  assert.equal(reconcile.mode, "reconcile");
  assert.equal((await store.effects(initial.executionId))[0].receipt, null);
  assert.equal((await store.scanReady()).length, 0);
  await store.commit((await store.load(initial.executionId))!, { status: "revoked", snapshot: null });
  assert.equal(await store.prepareRetry(reconcile, "host-deduplicates-original-id"), null);
  assert.equal(await store.recordDelivery(reconcile, "original delivery confirmed after revocation"), true);
  assert.equal((await store.scanReady()).length, 0);
});

test("delivery acknowledgement and weeks-later request outcome are independent", async (t) => {
  const open = fixture(t), store = open();
  const { requests: [request], effects: [offer] } = await requested(store);
  const claim = (await store.claimEffect(offer.id, "sender", 100))!;
  assert.equal(await store.recordDelivery(claim, { accepted: true }), true);
  assert.equal((await store.request(request.id))!.outcome, null);
  assert.deepEqual(await store.scanReady(), []);
  await store.close();
  const later = open();
  assert.equal(await later.settleRequest(request.id, 0, "alice", { tag: "Done", value: "Ship" }), true);
  assert.equal(await later.settleRequest(request.id, 0, "alice", { tag: "Done", value: "Drop" }), false);
  assert.equal((await later.scanReady())[0].executionId, initial.executionId);
  assert.equal((await later.load(initial.executionId))!.revision, 1); // Input alone never executes code.
  assert.deepEqual((await later.effects(initial.executionId)).find(e => e.id === offer.id)!.receipt, { accepted: true });
});

test("handover keeps the request and fences replies from its previous holder", async (t) => {
  const store = fixture(t)();
  const { requests: [request] } = await requested(store);
  assert.equal(await store.handOver(request.id, 0, "mallory", "bob"), null);
  const moved = (await store.handOver(request.id, 0, "alice", "bob"))!;
  assert.equal(moved.id, request.id);
  assert.equal(moved.epoch, 1);
  assert.equal(moved.outcome, null);
  assert.equal(await store.settleRequest(request.id, 0, "alice", { tag: "Done", value: "late" }), false);
  assert.equal(await store.settleRequest(request.id, 1, "alice", { tag: "Done", value: "wrong holder" }), false);
  assert.equal(await store.settleRequest(request.id, 1, "bob", { tag: "Declined", reason: "busy" }), true);
  assert.equal(await store.handOver(request.id, 1, "bob", "charlie"), null);
  const effects = await store.effects(initial.executionId);
  assert.ok(effects.some(e => e.operation === "request.released"));
  assert.ok(effects.some(e => e.operation === "request.closed"));
});

test("handover fences resending an old offer even when its host supports deduplication", async (t) => {
  const open = fixture(t), store = open();
  const { requests: [request], effects: [offer] } = await requested(store);
  const sending = (await store.claimEffect(offer.id, "old-worker", 10))!;
  await store.handOver(request.id, 0, "alice", "bob");
  open.clock.advanceTo(10);
  assert.equal(await store.claimEffect(offer.id, "new-worker", 10), null);
  assert.equal((await store.effects(initial.executionId)).find(e => e.id === offer.id)!.status, "superseded");
  assert.ok((await store.scanEffects()).every(e => e.id !== offer.id));
  assert.equal(await store.prepareRetry(sending, "host-deduplicates-original-id"), null);
  assert.equal(await store.recordDelivery(sending, "late old acknowledgement"), false);
  assert.equal((await store.request(request.id))!.holder, "bob");
});

test("recovery discovers ready programs and effects with keyset pagination", async (t) => {
  const store = fixture(t)();
  for (const name of ["a", "b", "c"]) await pending(store, name);
  const first = await store.scanEffects({ limit: 2 });
  const second = await store.scanEffects({ limit: 2, after: first[1].id });
  assert.deepEqual([...first, ...second].map(e => e.executionId), ["a", "b", "c"]);
  for (const effect of [...first, ...second]) {
    const claim = (await store.claimEffect(effect.id, "sender", 10))!;
    await store.recordDelivery(claim, "delivered");
  }
  const ready = await store.scanReady({ limit: 2 });
  assert.deepEqual(ready.map(e => e.executionId), ["a", "b"]);
  assert.deepEqual((await store.scanReady({ after: ready[1].executionId })).map(e => e.executionId), ["c"]);
});

test("nonportable data and invalid wait dependencies cannot partially commit", async (t) => {
  const store = fixture(t)(); await store.create(initial);
  const expected = (await store.load(initial.executionId))!;
  const hook = Object.assign([1], { toJSON: () => "lost" });
  const getter = Object.defineProperty([1], "0", { enumerable: true, get() { throw new Error("getter must never run"); } });
  for (const bad of [undefined, () => 1, NaN, Infinity, -0, new Date(), { hidden: undefined }, hook, getter, Array(2)]) {
    await assert.rejects(store.commit(expected, { status: "suspended", snapshot: null,
      effects: [{ operation: "ask", arguments: bad as Json }] }), /Snapshot/);
    assert.deepEqual(await store.load(initial.executionId), expected);
    assert.deepEqual(await store.effects(initial.executionId), []);
  }
  const cyclic: Record<string, Json> = {}; cyclic.self = cyclic;
  await assert.rejects(store.commit(expected, { status: "ready", snapshot: cyclic }), /explicit references/);
  await assert.rejects(store.commit(expected, { status: "suspended", snapshot: null,
    waitingFor: { kind: "request", id: "not-mine" }, requests: [{ holder: "alice", arguments: "new" }] }), /own durable/);
  assert.deepEqual(await store.load(initial.executionId), expected);
  assert.deepEqual(await store.effects(initial.executionId), []);
});

test("independent processes initialize and write the same fresh store", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-workers-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "runtime.sqlite");
  const moduleUrl = new URL("../../src/runtime/sqlite-store.ts", import.meta.url).href;
  const exec = promisify(execFile);
  await Promise.all(["worker-a", "worker-b"].map(executionId => exec(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "-e",
    `import { SqliteStore } from ${JSON.stringify(moduleUrl)};
     const store = new SqliteStore(${JSON.stringify(path)});
     await store.create(${JSON.stringify({ ...initial, executionId })}); await store.close();`,
  ])));
  const store = new SqliteStore(path);
  try { assert.ok(await store.load("worker-a")); assert.ok(await store.load("worker-b")); }
  finally { await store.close(); }
});

test("pinned code, ABI and terminal state cannot be replaced on resumption", async (t) => {
  const store = fixture(t)(); await store.create(initial);
  const before = (await store.load(initial.executionId))!;
  assert.equal(await store.commit({ ...before, codeId: "replacement" }, { status: "ready", snapshot: null }), null);
  assert.equal(await store.commit({ ...before, machineVersion: "cek:2" }, { status: "ready", snapshot: null }), null);
  const done = (await store.commit(before, { status: "completed", snapshot: "result" }))!.checkpoint;
  assert.equal(await store.commit(done, { status: "ready", snapshot: "revived" }), null);
});

test("unsupported database versions are refused without rewriting them", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-newer-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const version of [6, 99]) {
    const path = join(directory, `runtime-${version}.sqlite`);
    const db = new DatabaseSync(path); db.exec(`PRAGMA user_version = ${version}`); db.close();
    assert.throws(() => new SqliteStore(path), /migration is required/);
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, version); check.close();
  }
});

test("new snapshot databases are private to their OS user", { skip: process.platform === "win32" }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-private-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "runtime.sqlite"), store = new SqliteStore(path);
  try { await store.create(initial); assert.equal(statSync(path).mode & 0o777, 0o600); }
  finally { await store.close(); }
});
