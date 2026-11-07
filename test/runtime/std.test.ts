import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parse } from "../../src/frontend/parser.ts";
import { astToJson } from "../../src/frontend/json.ts";
import { checkSource } from "../../src/frontend/check/load.ts";
import { compile, compileAstJson } from "../../src/runtime/code.ts";
import { MemoryStore } from "../../src/runtime/memory-store.ts";
import { SqliteStore } from "../../src/runtime/sqlite-store.ts";
import { VirtualClock } from "../../src/runtime/clock.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { SimulatedHost } from "../../src/runtime/simulated-host.ts";
import { text, variant, type Value } from "../../src/runtime/value.ts";
import type { DurableStore, StoredRequest } from "../../src/runtime/persistence.ts";

function tree(source: string) {
  const parsed = parse(source); assert.ok(parsed.ok, JSON.stringify(parsed)); return parsed.program;
}
const std = tree(readFileSync(new URL("../../std/std.norn", import.meta.url), "utf8"));
async function offered(store: DurableStore): Promise<StoredRequest> {
  for (const effect of await store.effects("p")) {
    if (effect.operation !== "request.offer") continue;
    const r = (await store.request((effect.arguments as {requestId: string}).requestId))!;
    if (r.outcome === null) return r;
  }
  throw new Error("No pending request");
}

for (const [name, open] of Object.entries({ memory: (c: VirtualClock) => new MemoryStore(c), sqlite: (c: VirtualClock) => new SqliteStore(":memory:", c) })) {
  test(`${name}: open Std executes the same remind that passed type checking`, async () => {
    const source = 'open Std\nremind(@alice, "Review this", ~at=1h)';
    const checked = checkSource(source); assert.ok(checked.ok, JSON.stringify(checked.diagnostics));
    const clock = new VirtualClock(), store = open(clock), host = new SimulatedHost(store, clock);
    const runtime = new Runtime(compile(checked.program!, {std}), store, host);
    try {
      await runtime.create("p"); await host.pump(runtime);
      assert.deepEqual(await store.effects("p"), []);
      await host.advanceTo(3_600_000); await host.pump(runtime);
      const request = await offered(store); assert.equal(request.holder, "@alice");
      await host.reply(request, variant("Done", text("reviewed"))); await host.pump(runtime);
      assert.equal((await store.load("p"))!.status, "completed");
    } finally { await store.close(); }
  });

  test(`${name}: Std followUp times out and transfers one request without changing its identity`, async () => {
    const clock = new VirtualClock(), store = open(clock), host = new SimulatedHost(store, clock);
    const runtime = new Runtime(compile(tree('open Std\nfollowUp(@codex, "Progress?", ~until=1h, ~escalateTo=@alice)'), {std}), store, host);
    try {
      await runtime.create("p"); await host.pump(runtime); const first = await offered(store);
      await host.advanceTo(3_600_000); await host.pump(runtime); const next = await offered(store);
      assert.equal(first.id, next.id); assert.equal(next.epoch, 1); assert.equal(next.holder, "@alice");
      assert.equal(await host.reply(first, variant("Done", text("obsolete"))), false);
      await host.reply(next, variant("Done", text("current"))); await host.pump(runtime);
      assert.equal((await store.load("p"))!.status, "completed");
    } finally { await store.close(); }
  });
}

test("Std functions have private lexical bindings and repeated open restores the exports", async () => {
  const clock = new VirtualClock(), store = new MemoryStore(clock), host = new SimulatedHost(store, clock);
  const source = `
    let __norn_Std = 0
    let ask = (who, question) => Done("wrong ask")
    open Std
    let remind = (who, question, ~at) => Done("wrong remind")
    open Std
    remind(@alice, "Real ask", ~at=1h)
  `;
  const runtime = new Runtime(compile(tree(source), {std}), store, host);
  try {
    await runtime.create("p"); await host.pump(runtime);
    assert.equal((await store.load("p"))!.status, "suspended");
    await host.advanceTo(3_600_000); await host.pump(runtime);
    const request = await offered(store);
    assert.equal((request.arguments as {name: string}).name, "ask");
  } finally { await store.close(); }
});

test("restore pins the original library, even after its source changes", async () => {
  const program = tree('open Std\nafter(1h)->wait?\nhelper()');
  const oldCode = compile(program, {std: tree('let helper = () => 1')});
  const newCode = compile(program, {std: tree('let helper = () => 2')});
  assert.notEqual(oldCode.id, newCode.id);
  const clock = new VirtualClock(), store = new MemoryStore(clock), host = new SimulatedHost(store, clock);
  try {
    await new Runtime(oldCode, store, host).create("p");
    await host.pump(await Runtime.restore("p", store, host));
    const restored = await Runtime.restore("p", store, host);
    await host.advanceTo(3_600_000); await host.pump(restored);
    assert.deepEqual(((await store.load("p"))!.snapshot as {control: unknown}).control, {kind: "done", value: {type: "int", value: "1"}});
  } finally { await store.close(); }
});

test("unopened code retains its exact hash and trailing opens preserve the final value", async () => {
  const plain = tree('"中文🙂"'), code = compile(plain, {std});
  assert.equal(code.ast, astToJson(plain));
  assert.equal(code.id, `sha256:${createHash("sha256").update(astToJson(plain)).digest("hex")}`);
  const clock = new VirtualClock(), store = new MemoryStore(clock), host = new SimulatedHost(store, clock);
  try {
    const runtime = new Runtime(compile(tree('42\nopen Std'), {std}), store, host);
    await runtime.create("p"); await host.pump(runtime);
    assert.deepEqual(((await store.load("p"))!.snapshot as {control: unknown}).control, {kind: "done", value: {type: "int", value: "42"}});
  } finally { await store.close(); }
  assert.throws(() => compile(tree('open Std\nremind')), /pinned library AST/);
  assert.throws(() => compileAstJson(astToJson(tree('open Std\nremind'))), /unlinked/);
});

test("generic ask options remain checked at runtime and message payloads use body", async () => {
  const clock = new VirtualClock(), store = new MemoryStore(clock), host = new SimulatedHost(store, clock);
  try {
    for (const [id, options] of [["empty", "[]"], ["number", "[1]"], ["mixed", "[Ship, 1]"]]) {
      const runtime = new Runtime(compile(tree(`let choose = options => ask(@alice, "Choose", ~options)\nchoose(${options})`)), store, host);
      await runtime.create(id); await host.pump(runtime);
      assert.equal((await store.load(id))!.status, "failed");
      assert.equal((await store.effects(id)).some(e => e.operation === "request.offer"), false);
    }
    const source = 'message(channel"ops")->wait?->show';
    const runtime = new Runtime(compile(tree(source)), store, host);
    await runtime.create("message"); await host.pump(runtime);
    const participant: Value = {type: "participant", name: "alice", instance: null, labels: {}};
    await host.emit("posted", {type: "source", kind: "stream", name: "message", args: [{type: "ref", kind: "channel", value: "ops"}], labels: {}}, {type: "record", fields: {from: participant, body: text("hello")}});
    await host.pump(runtime);
    assert.deepEqual(((await store.load("message"))!.snapshot as {control: unknown}).control, {kind: "done", value: text('{from: @alice, body: hello}')});
  } finally { await store.close(); }
});
