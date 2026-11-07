import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../../src/frontend/parser.ts";
import { compile } from "../../src/runtime/code.ts";
import { machineVersion, start } from "../../src/runtime/machine.ts";
import { MemoryStore } from "../../src/runtime/memory-store.ts";
import { SqliteStore } from "../../src/runtime/sqlite-store.ts";
import { VirtualClock } from "../../src/runtime/clock.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { SimulatedHost } from "../../src/runtime/simulated-host.ts";
import { requestId, type DurableStore, type Json, type StoredRequest } from "../../src/runtime/persistence.ts";
import { text, variant, type Value } from "../../src/runtime/value.ts";

const hour = 3_600_000;
function source(contents: string) {
  const parsed = parse(contents); assert.ok(parsed.ok, JSON.stringify(parsed)); return compile(parsed.program);
}
async function question(store: DurableStore): Promise<StoredRequest> {
  const offer = (await store.effects("p")).find(e => e.operation === "request.offer")!;
  return (await store.request((offer.arguments as {requestId: string}).requestId))!;
}
async function control(store: DurableStore): Promise<unknown> { return ((await store.load("p"))!.snapshot as {control: unknown}).control; }
const stores = { memory: (c: VirtualClock): DurableStore => new MemoryStore(c), sqlite: (c: VirtualClock): DurableStore => new SqliteStore(":memory:", c) };

for (const [name, open] of Object.entries(stores)) {
  test(`${name}: request deadline without scans rejects a late reply and status sees NoReply`, async () => {
    const clock = new VirtualClock(), store = open(clock), host = new SimulatedHost(store, clock);
    const runtime = new Runtime(source('let q = ask(@alice, "Question", ~by=1h)\nlet r = q->wait\n(r, status(q))'), store, host);
    try {
      await runtime.create("p"); await host.pump(runtime); const q = await question(store);
      clock.advanceTo(hour + 1); // No alarm, scan or worker runs at the boundary.
      assert.equal(await host.reply(q, variant("Answered", text("late"))), false);
      await host.pump(runtime);
      assert.deepEqual(await control(store), {kind: "done", value: {type: "tuple", values: [variant("NoReply"), variant("Some", variant("NoReply"))]}});
      const evidence = await store.requestEvidence(q.id);
      assert.equal(evidence.length, 1); assert.equal(evidence[0].accepted, false);
      assert.deepEqual((await store.request(q.id))!.outcome, {tag: "NoReply"});
    } finally { await store.close(); }
  });

  test(`${name}: waitUntil is independent; equal request and observation deadlines yield Some(NoReply)`, async () => {
    for (const [by, expected] of [["1h", variant("Some", variant("NoReply"))], ["2h", variant("None")]] as const) {
      const clock = new VirtualClock(), store = open(clock), host = new SimulatedHost(store, clock);
      const runtime = new Runtime(source(`let q = ask(@alice, "Question", ~by=${by})\nlet observed = q->waitUntil(1h)\nlet state = status(q)\nafter(1h)->wait\n(observed, state)`), store, host);
      try {
        await runtime.create("p"); await host.pump(runtime); const q = await question(store);
        clock.advanceTo(hour); await host.pump(runtime);
        assert.deepEqual((await store.request(q.id))!.outcome, by === "1h" ? {tag: "NoReply"} : null);
        clock.advanceTo(2 * hour); await host.pump(runtime);
        assert.deepEqual(await control(store), {kind: "done", value: {type: "tuple", values: [expected, by === "1h" ? variant("Some", variant("NoReply")) : variant("None")]}});
      } finally { await store.close(); }
    }
  });

  test(`${name}: handover preserves the deadline and fences old replies after restoration`, async () => {
    const clock = new VirtualClock(), store = open(clock), host = new SimulatedHost(store, clock);
    let runtime = new Runtime(source('let q = ask(@codex, "Question", ~by=2h)\nlet r = switch q->waitUntil(1h) { | Some(r) => r | None => q->handOver(@alice)->wait }\nr'), store, host);
    try {
      await runtime.create("p"); await host.pump(runtime); const first = await question(store);
      clock.advanceTo(hour); await host.pump(runtime);
      const moved = (await store.request(first.id))!;
      assert.equal(moved.holder, "@alice"); assert.equal(moved.epoch, 1); assert.equal(moved.by, 2 * hour);
      runtime = await Runtime.restore("p", store, host);
      assert.equal(await host.reply(first, variant("Answered", text("obsolete"))), false);
      assert.equal((await store.request(first.id))!.outcome, null);
      assert.ok(await host.reply(moved, variant("Answered", text("current")))); await host.pump(runtime);
      assert.deepEqual(await control(store), {kind: "done", value: variant("Answered", text("current"))});
    } finally { await store.close(); }
  });

  test(`${name}: an unchecked dropped request stays open while running, then is cancelled atomically`, async () => {
    const clock = new VirtualClock(), store = open(clock), host = new SimulatedHost(store, clock);
    const runtime = new Runtime(source('ask(@alice, "Unobserved")\nafter(1h)->wait'), store, host);
    try {
      await runtime.create("p"); await host.pump(runtime); const q = await question(store);
      assert.equal(q.outcome, null);
      clock.advanceTo(hour); await runtime.runReady();
      assert.equal((await store.load("p"))!.status, "completed");
      assert.deepEqual((await store.request(q.id))!.outcome, {tag: "Cancelled"});
      const closure = (await store.effects("p")).filter(e => e.operation === "request.closed");
      assert.equal(closure.length, 1); assert.equal(closure[0].status, "pending");
      assert.deepEqual((closure[0].arguments as {outcome: unknown}).outcome, {tag: "Cancelled"});
    } finally { await store.close(); }
  });

  test(`${name}: invalid answers are evidence, never refusal or consent`, async () => {
    const cases: [string, Value, Value][] = [
      ['confirm(@alice, "Proceed?")', text("maybe"), variant("Yes")],
      ['choose(@alice, "Choose", [Ship, Drop])', variant("Other"), variant("Drop")],
      ['ask(@alice, "Text?")', variant("Yes"), text("yes")],
      ['judge("Ready?")', text("yes"), {type: "bool", value: true}],
      ['run(@alice, "Work")', text("unstructured"), {type: "record", fields: {text: text("report")}}],
    ];
    for (const [expression, invalid, valid] of cases) {
      const clock = new VirtualClock(), store = open(clock), host = new SimulatedHost(store, clock);
      const runtime = new Runtime(source(`${expression}->wait`), store, host);
      try {
        await runtime.create("p"); await host.pump(runtime); const q = await question(store);
        assert.equal(await host.reply(q, variant("Answered", invalid)), false);
        assert.equal((await store.request(q.id))!.outcome, null);
        assert.equal((await store.requestEvidence(q.id))[0].accepted, false);
        assert.ok((await store.requestEvidence(q.id))[0].invalidReason);
        assert.ok(await host.reply(q, variant("Answered", valid))); await host.pump(runtime);
        assert.deepEqual(await control(store), {kind: "done", value: variant("Answered", valid)});
      } finally { await store.close(); }
    }
  });

  test(`${name}: expiry without a waiter fences dispatch, reads and handover`, async () => {
    for (const operation of ["claim", "read", "handover", "scan"] as const) {
      const clock = new VirtualClock(), store = open(clock);
      try {
        await store.create({executionId: "p", codeId: "c", machineVersion, status: "ready", snapshot: null});
        const c = (await store.commit((await store.load("p"))!, {status: "ready", snapshot: null, requests: [{holder: "alice", arguments: "q", by: {after: hour}}]}))!;
        clock.advanceTo(hour);
        if (operation === "claim") assert.equal(await store.claimEffect(c.effects[0].id, "worker", 10), null);
        if (operation === "read") assert.deepEqual((await store.request(c.requests[0].id))!.outcome, {tag: "NoReply"});
        if (operation === "handover") assert.equal(await store.handOver(c.requests[0].id, 0, "alice", "bob"), null);
        if (operation === "scan") assert.equal((await store.scanEffects()).some(e => e.operation === "request.offer"), false);
        assert.deepEqual((await store.request(c.requests[0].id))!.outcome, {tag: "NoReply"});
      } finally { await store.close(); }
    }
  });

  test(`${name}: program errors remain errors; every open request ends Cancelled`, async () => {
    for (const [expression, message] of [['1 / 0', 'Division by zero'], ['missing', 'Unbound name missing'], ['fail(Answered(1))', 'fail requires a reply other than Answered'], ['ask(@alice, "q", ~until=1h)', 'Unknown ask label until']] as const) {
      const clock = new VirtualClock(), store = open(clock), host = new SimulatedHost(store, clock);
      const runtime = new Runtime(source(`let q = ask(@alice, "Outstanding")\n${expression}`), store, host);
      try {
        await runtime.create("p"); await host.pump(runtime);
        assert.deepEqual(await control(store), {kind: "error", message});
        assert.equal((await store.load("p"))!.status, "failed");
        const q = await question(store); assert.deepEqual(q.outcome, {tag: "Cancelled"});
        const error = (await store.effects("p")).find(e => e.operation === "execution.failed")!;
        assert.deepEqual(error.arguments, {kind: "program-error", message});
      } finally { await store.close(); }
    }
  });

  test(`${name}: events return their actual value and lost observation authority revokes the program`, async () => {
    const clock = new VirtualClock(), store = open(clock), host = new SimulatedHost(store, clock);
    const runtime = new Runtime(source('let q = ask(@alice, "Still open")\nmerged("pr")->wait'), store, host);
    try {
      await runtime.create("p"); await host.pump(runtime); const q = await question(store);
      host.permitted = false;
      await host.emit("merged", {type: "source", kind: "fact", name: "merged", args: [text("pr")], labels: {}}, text("pr"));
      await host.pump(runtime);
      assert.equal((await store.load("p"))!.status, "revoked");
      assert.deepEqual((await store.request(q.id))!.outcome, {tag: "Cancelled"});
      assert.deepEqual(await control(store), {kind: "failed", outcome: variant("Revoked")});
    } finally { await store.close(); }
  });

  test(`${name}: an older machine ABI is rejected with both versions and its snapshot unchanged`, async () => {
    const clock = new VirtualClock(), store = open(clock), host = new SimulatedHost(store, clock), code = source('1');
    try {
      await store.saveCode(code.id, code.ast);
      await store.create({executionId: "p", codeId: code.id, machineVersion: "norn-cek:3", status: "ready", snapshot: {...start(code), version: "norn-cek:3"} as unknown as Json});
      const before = await store.load("p");
      await assert.rejects(Runtime.restore("p", store, host), /norn-cek:3.*norn-cek:4/);
      await assert.rejects(new Runtime(code, store, host).step("p"), /norn-cek:3.*norn-cek:4/);
      assert.deepEqual(await store.load("p"), before);
    } finally { await store.close(); }
  });

  test(`${name}: relative request deadlines use commit time and cannot be declared by a participant`, async () => {
    const clock = new VirtualClock(), store = open(clock);
    try {
      await store.create({executionId: "p", codeId: "c", machineVersion, status: "ready", snapshot: null});
      const before = (await store.load("p"))!;
      clock.advanceTo(123);
      await store.commit(before, {status: "ready", snapshot: null, requests: [{holder: "alice", arguments: "q", by: {after: hour}}]});
      const q = (await store.request(requestId("p", 1)))!; assert.equal(q.by, hour + 123);
      await assert.rejects(store.settleRequest(q.id, 0, "alice", {tag: "NoReply"}), /store clock/);
      assert.equal((await store.request(q.id))!.outcome, null);
    } finally { await store.close(); }
  });
}
