import assert from "node:assert/strict";
import { test } from "node:test";
import { VirtualClock } from "../../src/runtime/clock.ts";
import { MemoryStore } from "../../src/runtime/memory-store.ts";
import { SqliteStore } from "../../src/runtime/sqlite-store.ts";
import { effectId, requestId, waitId, type DurableStore, type InitialCheckpoint, type Json } from "../../src/runtime/persistence.ts";

const initial: InitialCheckpoint = { executionId: "p", codeId: "code", machineVersion: "test", status: "ready", snapshot: { position: 0 } };
const stores = { memory: (clock: VirtualClock): DurableStore => new MemoryStore(clock), sqlite: (clock: VirtualClock): DurableStore => new SqliteStore(":memory:", clock) };

for (const [name, open] of Object.entries(stores)) {
  test(`${name}: a convenience deadline withdraws before accepting a late reply without a scan`, async () => {
    const clock = new VirtualClock(), store = open(clock);
    try {
      await store.create(initial);
      const id = requestId("p", 1), wait = waitId("p", 1);
      await store.commit((await store.load("p"))!, { status: "suspended", snapshot: "waiting",
        requests: [{ holder: "alice", arguments: "question" }],
        waits: [{ targets: [{ kind: "request", id }], until: 100, withdrawOnTimeout: [id] }], waitingFor: { kind: "wait", id: wait } });
      clock.advanceTo(101);
      assert.equal(await store.settleRequest(id, 0, "alice", { tag: "Done", value: "late" }), false);
      assert.deepEqual((await store.request(id))!.outcome, { tag: "Cancelled" });
      assert.deepEqual((await store.wait(wait))!.outcome, { tag: "TimedOut" });
      assert.equal((await store.requestEvidence(id))[0].accepted, false);
      assert.equal((await store.effects("p")).find(e => e.operation === "request.offer")!.status, "withdrawn");
    } finally { await store.close(); }
  });

  test(`${name}: checkpoint CAS, independent wait expiry, handover and late evidence`, async () => {
    const clock = new VirtualClock(), store = open(clock);
    try {
      await store.create(initial);
      const before = (await store.load("p"))!, id = requestId("p", 1), wait = waitId("p", 1);
      const change = { status: "suspended" as const, snapshot: "waiting" as Json, requests: [{ holder: "alice", arguments: "question" }],
        waits: [{ targets: [{ kind: "request" as const, id }], until: 100, withdrawOnTimeout: [] }], waitingFor: { kind: "wait" as const, id: wait } };
      const competing = await Promise.all([store.commit(before, change), store.commit(before, change)]);
      assert.equal(competing.filter(Boolean).length, 1);
      const offer = (await store.effects("p"))[0], claim = (await store.claimEffect(offer.id, "worker", 10))!;
      assert.ok(await store.recordDelivery(claim, "delivered"));
      assert.equal((await store.request(id))!.outcome, null);
      const moved = (await store.handOver(id, 0, "alice", "bob"))!;
      assert.equal(moved.epoch, 1); assert.equal(moved.id, id);
      assert.equal(await store.settleRequest(id, 0, "alice", { tag: "Done", value: "old reply" }), false);
      clock.advanceTo(100); assert.equal((await store.scanReady())[0].executionId, "p");
      assert.deepEqual((await store.wait(wait))!.outcome, { tag: "TimedOut" });
      assert.equal((await store.request(id))!.outcome, null);
      assert.ok(await store.settleRequest(id, 1, "bob", { tag: "Done", value: "answer" }));
      assert.deepEqual((await store.wait(wait))!.outcome, { tag: "TimedOut" });
      assert.deepEqual((await store.request(id))!.outcome, { tag: "Done", value: "answer" });
      assert.deepEqual((await store.requestEvidence(id)).map(e => e.accepted), [false, true]);
      const checkpoint = (await store.load("p"))!;
      await store.commit(checkpoint, { status: "cancelled", snapshot: "stopped" });
      assert.equal(await store.commit((await store.load("p"))!, { status: "ready", snapshot: "revived" }), null);
    } finally { await store.close(); }
  });

  test(`${name}: rollback and by-value snapshots protect atomic ownership`, async () => {
    const store = open(new VirtualClock());
    try {
      const input = { ...initial, snapshot: { nested: { value: 1 } } };
      await store.create(input); input.snapshot.nested.value = 99;
      const before = (await store.load("p"))!;
      (before.snapshot as {nested: {value: number}}).nested.value = 88;
      assert.deepEqual((await store.load("p"))!.snapshot, { nested: { value: 1 } });
      const original = (await store.load("p"))!;
      await assert.rejects(store.commit(original, { status: "suspended", snapshot: "invalid", effects: [{ operation: "work", arguments: "unsent" }], waitingFor: { kind: "request", id: "not-owned" } }), /own durable/);
      assert.deepEqual(await store.load("p"), original); assert.deepEqual(await store.effects("p"), []);
      await assert.rejects(store.commit(original, { status: "ready", snapshot: { invalid: NaN } }), /JSON/);
      assert.deepEqual(await store.load("p"), original);
      await store.saveCode("pinned", "original");
      await assert.rejects(store.saveCode("pinned", "replacement"), /overwritten/);
      assert.equal(await store.loadCode("pinned"), "original");
    } finally { await store.close(); }
  });

  test(`${name}: uncertain deliveries require evidence, lease fencing and explicit recovery`, async () => {
    const clock = new VirtualClock(), store = open(clock);
    try {
      await store.create(initial);
      await store.commit((await store.load("p"))!, { status: "ready", snapshot: null, effects: [{ operation: "work", arguments: "task" }] });
      const id = effectId("p", 1), first = (await store.claimEffect(id, "first", 10))!;
      clock.advanceTo(10);
      assert.equal(await store.recordDelivery(first, "obsolete"), false);
      const recovery = (await store.claimEffect(id, "second", 10))!;
      assert.equal(recovery.mode, "reconcile");
      await store.markUncertain(recovery, "no receipt");
      assert.deepEqual(await store.scanEffects(), []);
      assert.equal(await store.claimEffect(id, "third", 10), null);
      assert.ok(await store.provideEvidence(id, "host now reachable"));
      const reconciled = (await store.claimEffect(id, "third", 10))!;
      const retry = (await store.prepareRetry(reconciled, "host-deduplicates-original-id"))!;
      assert.equal(retry.mode, "send"); assert.equal(retry.effect.id, id);
      assert.ok(await store.recordDelivery(retry, { originalId: id }));
      assert.equal((await store.effects("p"))[0].status, "delivered");
    } finally { await store.close(); }
  });

  test(`${name}: facts predate subscription, streams use cursors, projections and deadlines persist`, async () => {
    const clock = new VirtualClock(), store = open(clock);
    try {
      await store.publishEvent("fact", "known", "fact", "existing");
      await store.publishEvent("past", "next", "stream", "past");
      for (const [id, targets, until] of [
        ["fact", [{ kind: "event", key: "known", mode: "fact" }], null],
        ["stream", [{ kind: "event", key: "next", mode: "stream", result: null }], null],
        ["timer", [{ kind: "timer", at: 100, result: "tick" }], null],
        ["never", [], 100],
      ] as const) {
        await store.create({ ...initial, executionId: id });
        await store.commit((await store.load(id))!, { status: "suspended", snapshot: null, waits: [{ targets: [...targets], until, withdrawOnTimeout: [] }], waitingFor: { kind: "wait", id: waitId(id, 1) } });
      }
      assert.deepEqual((await store.scanReady()).map(e => e.executionId), ["fact"]);
      await store.publishEvent("self", "next", "stream", "self", "stream");
      assert.equal((await store.wait(waitId("stream", 1)))!.outcome, null);
      clock.advanceTo(99); await store.publishEvent("new", "next", "stream", "discarded");
      assert.deepEqual((await store.wait(waitId("stream", 1)))!.outcome, { tag: "Done", value: null });
      assert.equal(await store.publishEvent("new", "next", "stream", "duplicate"), false);
      clock.advanceTo(100); await store.scanReady();
      assert.deepEqual((await store.wait(waitId("timer", 1)))!.outcome, { tag: "Done", value: "tick" });
      assert.deepEqual((await store.wait(waitId("never", 1)))!.outcome, { tag: "TimedOut" });
      assert.deepEqual((await store.scanReady({ after: "fact", limit: 2 })).map(e => e.executionId), ["never", "stream"]);
      assert.deepEqual(await store.scanReady({ codeId: "another" }), []);
    } finally { await store.close(); }
  });

  test(`${name}: terminating an execution withdraws work and rejects obsolete request retries`, async () => {
    const clock = new VirtualClock(), store = open(clock);
    try {
      await store.create(initial);
      await store.commit((await store.load("p"))!, { status: "ready", snapshot: null, requests: [{ holder: "alice", arguments: "question" }], effects: [{ operation: "say", arguments: "queued" }] });
      const offer = (await store.effects("p")).find(e => e.operation === "request.offer")!;
      const claim = (await store.claimEffect(offer.id, "worker", 10))!;
      await store.commit((await store.load("p"))!, { status: "cancelled", snapshot: null });
      assert.equal((await store.effects("p")).find(e => e.id === offer.id)!.status, "superseded");
      assert.equal(await store.prepareRetry(claim, "host-deduplicates-original-id"), null);
      assert.deepEqual((await store.request(requestId("p", 1)))!.outcome, { tag: "Cancelled" });
      const queued = (await store.scanEffects()).filter(e => e.kind === "work");
      assert.deepEqual(queued, []);
    } finally { await store.close(); }
  });
}

test("closing a memory session releases state and refuses further operations", async () => {
  const store = new MemoryStore(); await store.create(initial); await store.close(); await store.close();
  await assert.rejects(store.load("p"), /closed/);
  await assert.rejects(store.currentTime(), /closed/);
});
