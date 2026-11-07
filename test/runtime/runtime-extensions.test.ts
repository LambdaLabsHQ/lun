import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../../src/frontend/parser.ts";
import { compile, compileAstJson } from "../../src/runtime/code.ts";
import { advance, start } from "../../src/runtime/machine.ts";
import { VirtualClock } from "../../src/runtime/clock.ts";
import { SqliteStore } from "../../src/runtime/sqlite-store.ts";
import { SimulatedHost } from "../../src/runtime/simulated-host.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { text, variant } from "../../src/runtime/value.ts";

function source(text: string) {
  const parsed = parse(text);
  assert.ok(parsed.ok, parsed.ok ? "" : JSON.stringify(parsed.diagnostics));
  return compile(parsed.program);
}

test("a 10,000-stage source pipe compiles and executes without a native traversal stack", () => {
  const code = source(`let inc = x => x + 1\n0${"->inc".repeat(10_000)}`);
  const machine = start(code);
  do { advance(code, machine, 10_000); } while (machine.control.kind === "eval" || machine.control.kind === "value");
  assert.deepEqual(machine.control, { kind: "done", value: { type: "int", value: "10000" } });
});

test("show is callable in source and through a pipe without a host effect", () => {
  const code = source('(show(2026-11-07T12:00Z), 1h->show, show(@alice), show(Answered("yes")))');
  const machine = advance(code, start(code));
  assert.deepEqual(machine.control, { kind: "done", value: { type: "tuple", values: [
    text("2026-11-07T12:00:00.000Z"), text("1h"), text("@alice"), text("Answered(yes)"),
  ] } });
});

test("show rejects a missing value, extra positional values and unknown labels", () => {
  for (const call of ['show()', 'show(1, 2)', 'show(1, ~extra=2)']) {
    const code = source(call), machine = advance(code, start(code));
    assert.equal(machine.control.kind, "error", call);
  }
});

test("after accepts an absolute time and resumes when that instant is observed", async () => {
  const at = Date.parse("2026-11-07T12:00Z");
  const clock = new VirtualClock(at - 60_000), store = new SqliteStore(":memory:", clock);
  const host = new SimulatedHost(store, clock);
  const runtime = new Runtime(source('after(2026-11-07T12:00Z)->wait->show'), store, host);
  try {
    await runtime.create("at"); await host.pump(runtime);
    assert.equal((await store.load("at"))!.status, "suspended");
    await host.advanceTo(at - 1); await host.pump(runtime);
    assert.equal((await store.load("at"))!.status, "suspended");
    await host.advanceTo(at); await host.pump(runtime);
    const checkpoint = (await store.load("at"))!;
    assert.equal(checkpoint.status, "completed");
    assert.deepEqual((checkpoint.snapshot as { control: unknown }).control, { kind: "done", value: text("2026-11-07T12:00:00.000Z") });
  } finally { await store.close(); }
});

test("an elapsed absolute timer is ready immediately and every still requires a duration", async () => {
  const at = Date.parse("2026-11-07T12:00Z");
  const clock = new VirtualClock(at + 1), store = new SqliteStore(":memory:", clock);
  const host = new SimulatedHost(store, clock);
  try {
    const elapsed = new Runtime(source('after(2026-11-07T12:00Z)->wait'), store, host);
    await elapsed.create("elapsed"); await host.pump(elapsed);
    assert.equal((await store.load("elapsed"))!.status, "completed");
    const invalid = new Runtime(source('every(2026-11-07T12:00Z)->wait'), store, host);
    await invalid.create("invalid"); await host.pump(invalid);
    assert.equal((await store.load("invalid"))!.status, "failed");
  } finally { await store.close(); }
});


test("restoration retains a stored AST identity when the current writer uses another layout", async () => {
  const canonical = source('ask(@alice, "Question?")->wait');
  const saved = compileAstJson(`${JSON.stringify(JSON.parse(canonical.ast), null, 2)}\n`);
  assert.notEqual(saved.id, canonical.id);
  const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
  try {
    const runtime = new Runtime(saved, store, host);
    await runtime.create("legacy"); await host.pump(runtime);
    const restored = await Runtime.restore("legacy", store, host);
    assert.equal(restored.code.id, saved.id);
    assert.equal(restored.code.ast, saved.ast);
    const offer = (await store.effects("legacy")).find(effect => effect.operation === "request.offer")!;
    const request = (await store.request((offer.arguments as { requestId: string }).requestId))!;
    await host.reply(request, variant("Answered", text("answer"))); await host.pump(restored);
    assert.equal((await store.load("legacy"))!.status, "completed");
  } finally { await store.close(); }
});
