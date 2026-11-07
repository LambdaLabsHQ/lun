import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "../../src/frontend/parser.ts";
import { compile } from "../../src/runtime/code.ts";
import { advance, start } from "../../src/runtime/machine.ts";
import { VirtualClock } from "../../src/runtime/clock.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { SimulatedHost } from "../../src/runtime/simulated-host.ts";
import { SqliteStore } from "../../src/runtime/sqlite-store.ts";
import { text, unit, variant, type Value } from "../../src/runtime/value.ts";
import type { Json, StoredRequest } from "../../src/runtime/persistence.ts";

function source(contents: string) {
  const parsed = parse(contents);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return compile(parsed.program);
}
const ci: Value = { type: "source", kind: "stream", name: "ciFailed", args: [text("acme/api")], labels: {} };
async function offered(store: SqliteStore): Promise<StoredRequest> {
  for (const effect of await store.effects("p")) {
    if (effect.operation !== "request.offer") continue;
    const request = (await store.request((effect.arguments as { requestId: string }).requestId))!;
    if (request.outcome === null) return request;
  }
  throw new Error("No pending request");
}

test("one failed run reports its outcome and does not end a standing duty", async () => {
  const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
  const runtime = new Runtime(source('ciFailed("acme/api")->forEach(_ => run(@auto, "Check health")->wait)'), store, host);
  try {
    await runtime.create("p"); await host.pump(runtime);
    await host.emit("first", ci, text("first incident")); await host.pump(runtime);
    const first = await offered(store);
    await host.reply(first, variant("Broke", text("temporary failure"))); await host.pump(runtime);
    assert.equal((await store.load("p"))!.status, "suspended");
    const notices = (await store.effects("p")).filter(effect => effect.operation === "execution.handler_failed");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, "notification");
    assert.equal(notices[0].status, "delivered");
    assert.deepEqual(notices[0].arguments, variant("Broke", text("temporary failure")));
    await host.emit("second", ci, text("second incident")); await host.pump(runtime);
    const second = await offered(store);
    assert.notEqual(second.id, first.id);
    await host.reply(second, variant("Answered", {type: "record", fields: {text: text("healthy")}})); await host.pump(runtime);
    assert.equal((await store.load("p"))!.status, "suspended");
    assert.equal((await store.effects("p")).filter(effect => effect.operation === "execution.handler_failed").length, 1);
  } finally { await store.close(); }
});

test("every unsuccessful handler outcome reports once and takes the next occurrence", async () => {
  for (const expression of ['Refused("no")', 'Broke("fault")', 'NoReply', 'Cancelled', 'Revoked']) {
    const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
    const runtime = new Runtime(source(`ciFailed("acme/api")->forEach(_ => ${expression})`), store, host);
    try {
      await runtime.create("p"); await host.pump(runtime);
      for (let i = 1; i <= 2; i++) {
        await host.emit(String(i), ci, text("incident")); await host.pump(runtime);
        assert.equal((await store.load("p"))!.status, "suspended", expression);
        assert.equal((await store.effects("p")).filter(effect => effect.operation === "execution.handler_failed").length, i, expression);
      }
    } finally { await store.close(); }
  }
});

test("competing resumptions and restart cannot duplicate a handler failure intent", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-handler-")), path = join(directory, "state.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const clock = new VirtualClock();
  let store = new SqliteStore(path, clock), host = new SimulatedHost(store, clock);
  const runtime = new Runtime(source('ciFailed("acme/api")->forEach(_ => Broke("retry later"))'), store, host);
  await runtime.create("p"); await host.pump(runtime);
  await host.emit("first", ci, text("incident"));
  const commits = await Promise.all([runtime.step("p"), runtime.step("p")]);
  assert.equal(commits.filter(Boolean).length, 1);
  const notices = (await store.effects("p")).filter(effect => effect.operation === "execution.handler_failed");
  assert.equal(notices.length, 1); assert.equal(notices[0].status, "pending");
  await store.close(); store = new SqliteStore(path, clock); host = new SimulatedHost(store, clock);
  try {
    const restored = await Runtime.restore("p", store, host);
    await host.pump(restored);
    assert.equal((await store.load("p"))!.status, "suspended");
    const after = (await store.effects("p")).filter(effect => effect.operation === "execution.handler_failed");
    assert.equal(after.length, 1); assert.equal(after[0].id, notices[0].id); assert.equal(after[0].status, "delivered");
    assert.equal(await host.pump(restored), 0);
  } finally { await store.close(); }
});

test("successful and unchecked ordinary callback values are discarded without a failure notice", async () => {
  for (const expression of ['()', 'Answered("ok")', '1', 'false', '"unused"', 'None', '{unused: 1}']) {
    const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
    const runtime = new Runtime(source(`ciFailed("acme/api")->forEach(_ => ${expression})`), store, host);
    try {
      await runtime.create("p"); await host.pump(runtime);
      await host.emit("first", ci, text("incident")); await host.pump(runtime);
      assert.equal((await store.load("p"))!.status, "suspended", expression);
      assert.deepEqual(await store.effects("p"), [], expression);
    } finally { await store.close(); }
  }
});

test("explicit fail in a handler terminates the program and stops further occurrences", async () => {
  const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
  const runtime = new Runtime(source('ciFailed("acme/api")->forEach(_ => fail(Broke("stop")))'), store, host);
  try {
    await runtime.create("p"); await host.pump(runtime);
    await host.emit("first", ci, text("incident")); await host.pump(runtime);
    const failed = (await store.load("p"))!;
    assert.equal(failed.status, "failed");
    assert.deepEqual((failed.snapshot as { control: unknown }).control, { kind: "failed", outcome: variant("Broke", text("stop")) });
    const notices = await store.effects("p");
    assert.equal(notices.length, 1); assert.equal(notices[0].operation, "execution.failed");
    await host.emit("second", ci, text("incident"));
    assert.equal(await host.pump(runtime), 0);
    assert.deepEqual(await store.load("p"), failed);
  } finally { await store.close(); }
});

test("ignore evaluates its argument, can be piped, and explicitly discards an outcome", async () => {
  const code = source('(ignore(1), Broke("explicitly ignored")->ignore)');
  assert.deepEqual(advance(code, start(code)).control, { kind: "done", value: { type: "tuple", values: [unit, unit] } });
  const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
  const runtime = new Runtime(source('ignore(say(@alice, "Still evaluated"))'), store, host);
  try {
    await runtime.create("p"); await host.pump(runtime);
    assert.deepEqual(((await store.load("p"))!.snapshot as { control: unknown }).control, { kind: "done", value: unit });
    const messages = await store.effects("p");
    assert.equal(messages.length, 1); assert.equal(messages[0].operation, "say"); assert.equal(messages[0].status, "delivered");
  } finally { await store.close(); }
  for (const expression of ['ignore()', 'ignore(1, 2)', 'ignore(1, ~unused=2)']) {
    const invalid = source(expression);
    assert.equal(advance(invalid, start(invalid)).control.kind, "error", expression);
  }
});

test("ignore on a handler outcome suppresses automatic failure reporting", async () => {
  const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
  const runtime = new Runtime(source('ciFailed("acme/api")->forEach(_ => Broke("ignored")->ignore)'), store, host);
  try {
    await runtime.create("p"); await host.pump(runtime);
    await host.emit("first", ci, text("incident")); await host.pump(runtime);
    assert.equal((await store.load("p"))!.status, "suspended");
    assert.deepEqual(await store.effects("p"), []);
  } finally { await store.close(); }
});

test("an older machine ABI cannot silently adopt the new handler semantics", async () => {
  const code = source('ciFailed("acme/api")->forEach(_ => Broke("old semantics"))');
  const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
  try {
    await store.saveCode(code.id, code.ast);
    await store.create({ executionId: "old", codeId: code.id, machineVersion: "norn-cek:2", status: "ready", snapshot: { ...start(code), version: "norn-cek:2" } as unknown as Json });
    const before = await store.load("old");
    await assert.rejects(Runtime.restore("old", store, host), /norn-cek:2.*norn-cek:4/);
    assert.deepEqual(await store.load("old"), before);
  } finally { await store.close(); }
});
