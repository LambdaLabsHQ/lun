import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestId, waitId, type WaitDescription, type Json } from "../../src/runtime/persistence.ts";
import { SqliteStore } from "../../src/runtime/sqlite-store.ts";

async function waiting(store: SqliteStore, withdraw: boolean) {
  await store.create({ executionId: "p", codeId: "c", machineVersion: "m", status: "ready", snapshot: null });
  const id = requestId("p", 1), wait = waitId("p", 1);
  const committed = (await store.commit((await store.load("p"))!, {
    status: "suspended", snapshot: "continuation", now: 0,
    requests: [{ holder: "alice", arguments: "question" }],
    waits: [{ targets: [{ kind: "request", id }], until: 100, withdrawOnTimeout: withdraw ? [id] : [] }],
    waitingFor: { kind: "wait", id: wait },
  }))!;
  return { id, wait, checkpoint: committed.checkpoint };
}
async function eventWait(store: SqliteStore, description: WaitDescription, executionId = "p") {
  await store.create({ executionId, codeId: "c", machineVersion: "m", status: "ready", snapshot: null });
  const id = waitId(executionId, 1);
  await store.commit((await store.load(executionId))!, { status: "suspended", snapshot: null, waits: [description],
    waitingFor: { kind: "wait", id }, now: 0 });
  return id;
}

test("ask timeout withdraws its request even when no worker was online at the deadline", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const { id, wait } = await waiting(store, true);
    assert.equal(await store.settleRequest(id, 0, "alice", { tag: "Done", value: "late" }, 101), false);
    assert.deepEqual((await store.request(id))!.outcome, { tag: "Cancelled" });
    assert.deepEqual((await store.wait(wait))!.outcome, { tag: "TimedOut" });
    assert.equal((await store.scanReady(101))[0].executionId, "p");
  } finally { await store.close(); }
});

test("explicit wait timeout leaves the same request open for handover and a later wait", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const { id, wait, checkpoint } = await waiting(store, false);
    await store.scanReady(100);
    assert.equal((await store.request(id))!.outcome, null);
    assert.deepEqual((await store.wait(wait))!.outcome, { tag: "TimedOut" });
    const second = waitId("p", 2);
    await store.commit(checkpoint, { status: "suspended", snapshot: "continued", now: 100,
      requestActions: [{ id, epoch: 0, holder: "alice", action: "handOver", nextHolder: "bob" }],
      waits: [{ targets: [{ kind: "request", id }], until: 200, withdrawOnTimeout: [] }], waitingFor: { kind: "wait", id: second } });
    assert.equal(await store.settleRequest(id, 0, "alice", { tag: "Done", value: "obsolete" }, 110), false);
    assert.equal(await store.settleRequest(id, 1, "bob", { tag: "Done", value: "answer" }, 120), true);
    assert.deepEqual((await store.wait(second))!.outcome, { tag: "Done", value: "answer" });
    assert.deepEqual((await store.wait(wait))!.outcome, { tag: "TimedOut" });
  } finally { await store.close(); }
});

test("an answer recorded before the deadline wins; an answer exactly at it times out", async () => {
  for (const at of [99, 100]) {
    const store = new SqliteStore(":memory:");
    try {
      const { id, wait } = await waiting(store, true);
      assert.equal(await store.settleRequest(id, 0, "alice", { tag: "Done", value: "yes" }, at), at === 99);
      await store.scanReady(500);
      assert.deepEqual((await store.wait(wait))!.outcome, at === 99 ? { tag: "Done", value: "yes" } : { tag: "TimedOut" });
    } finally { await store.close(); }
  }
});

test("timers and event alternatives survive process restart without polling a participant", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-wait-")), path = join(directory, "runtime.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new SqliteStore(path);
  const id = await eventWait(store, { targets: [{ kind: "event", key: "ci", mode: "stream" }, { kind: "timer", at: 50 }], until: 100, withdrawOnTimeout: [] });
  await store.close(); store = new SqliteStore(path);
  try {
    assert.deepEqual(await store.scanReady(49), []);
    assert.equal((await store.scanReady(50))[0].executionId, "p");
    assert.deepEqual((await store.wait(id))!.outcome, { tag: "Done", value: { type: "time", value: "50" } });
  } finally { await store.close(); }
});

test("facts can predate subscription; streams cannot replay old or self-caused occurrences", async () => {
  const store = new SqliteStore(":memory:");
  try {
    await store.publishEvent("prior-fact", "merged", "fact", "known", 0);
    await store.publishEvent("prior-ci", "ci", "stream", "old occurrence", 0);
    const fact = await eventWait(store, { targets: [{ kind: "event", key: "merged", mode: "fact" }], until: null, withdrawOnTimeout: [] }, "fact");
    const stream = await eventWait(store, { targets: [{ kind: "event", key: "ci", mode: "stream" }], until: null, withdrawOnTimeout: [] }, "stream");
    assert.deepEqual((await store.wait(fact))!.outcome, { tag: "Done", value: "known" });
    assert.equal((await store.wait(stream))!.outcome, null);
    await store.publishEvent("self-ci", "ci", "stream", "self", 1, "stream");
    assert.equal((await store.wait(stream))!.outcome, null);
    await store.publishEvent("new-ci", "ci", "stream", "new", 2);
    assert.deepEqual((await store.wait(stream))!.outcome, { tag: "Done", value: "new" });
    assert.equal(await store.publishEvent("new-ci", "ci", "stream", "duplicate", 3), false);
  } finally { await store.close(); }
});

test("checkpoint CAS fences handover side effects as well as continuation state", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const { id, checkpoint } = await waiting(store, false);
    const change = { status: "ready" as const, snapshot: null as Json,
      requestActions: [{ id, epoch: 0, holder: "alice", action: "handOver" as const, nextHolder: "bob" }] };
    assert.ok(await store.commit(checkpoint, change));
    assert.equal(await store.commit(checkpoint, change), null);
    assert.equal((await store.request(id))!.epoch, 1);
  } finally { await store.close(); }
});
