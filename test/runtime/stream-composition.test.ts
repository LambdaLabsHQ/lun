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

function source(contents: string) {
  const parsed = parse(contents);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return compile(parsed.program);
}
const ci = (repo = "acme/api"): Value => ({ type: "source", kind: "stream", name: "ciFailed", args: [text(repo)], labels: {} });
const hour = 3_600_000;

for (const winner of ["event", "timer"]) {
  test(`or preserves the ${winner} value across restart before and after resolution`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "norn-or-")), path = join(directory, "state.sqlite");
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const clock = new VirtualClock();
    let store = new SqliteStore(path, clock), host = new SimulatedHost(store, clock);
    let runtime = new Runtime(source('never()->or(ciFailed("acme/api"))->or(after(1h))->wait'), store, host);
    await runtime.create("p"); await host.pump(runtime);
    assert.equal((await store.load("p"))!.status, "suspended");
    await store.close(); store = new SqliteStore(path, clock); host = new SimulatedHost(store, clock);
    if (winner === "event") await host.emit("ci", ci(), text("private incident details"));
    else await host.advanceTo(hour);
    await store.close(); store = new SqliteStore(path, clock); host = new SimulatedHost(store, clock);
    try {
      runtime = await Runtime.restore("p", store, host);
      await host.pump(runtime);
      const checkpoint = (await store.load("p"))!;
      assert.equal(checkpoint.status, "completed");
      assert.deepEqual((checkpoint.snapshot as { control: unknown }).control, { kind: "done", value: winner === "event" ? variant("First", variant("Second", text("private incident details"))) : variant("Second", {type: "time", value: String(hour)}) });
    } finally { await store.close(); }
  });
}

test("nested or preserves the full source constructor path", async () => {
  const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
  const runtime = new Runtime(source('ciFailed("a")->or(ciFailed("b"))->or(never())->wait'), store, host);
  try {
    await runtime.create("p"); await host.pump(runtime);
    await host.emit("b", ci("b"), text("not unit")); await host.pump(runtime);
    assert.deepEqual(((await store.load("p"))!.snapshot as { control: unknown }).control, { kind: "done", value: variant("First", variant("Second", text("not unit"))) });
  } finally { await store.close(); }
});

test("or preserves tagged payloads from either stream", async () => {
  for (const repo of ["a", "b"]) {
    const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
    const runtime = new Runtime(source('ciFailed("a")->or(ciFailed("b"))->wait'), store, host);
    try {
      await runtime.create("p"); await host.pump(runtime);
      await host.emit("ci", ci(repo), text(`incident in ${repo}`)); await host.pump(runtime);
      assert.deepEqual(((await store.load("p"))!.snapshot as { control: unknown }).control, { kind: "done", value: variant(repo === "a" ? "First" : "Second", text(`incident in ${repo}`)) });
    } finally { await store.close(); }
  }
});

test("never stays suspended after restart, unrelated events and repeated scheduler scans", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-never-")), path = join(directory, "state.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const clock = new VirtualClock();
  let store = new SqliteStore(path, clock), host = new SimulatedHost(store, clock);
  const first = new Runtime(source('never()->wait'), store, host);
  await first.create("p"); await host.pump(first);
  const suspended = (await store.load("p"))!;
  assert.equal(suspended.status, "suspended");
  await store.close(); store = new SqliteStore(path, clock); host = new SimulatedHost(store, clock);
  try {
    const runtime = await Runtime.restore("p", store, host);
    await host.advanceTo(30 * 24 * hour); await host.emit("unrelated", ci(), text("unrelated"));
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await store.scanReady(), []);
      assert.equal(await host.pump(runtime), 0);
    }
    assert.deepEqual(await store.load("p"), suspended);
    await store.commit(suspended, { status: "cancelled", snapshot: suspended.snapshot });
    assert.equal(await host.pump(runtime), 0);
    assert.equal((await store.load("p"))!.status, "cancelled");
  } finally { await store.close(); }
});

test("never permits a deadline and empty alternatives cannot produce a spurious occurrence", async () => {
  const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
  const runtime = new Runtime(source('never()->or(never())->waitUntil(1h)'), store, host);
  try {
    await runtime.create("p"); await host.pump(runtime);
    await host.advanceTo(hour - 1); assert.equal(await host.pump(runtime), 0);
    await host.advanceTo(hour); await host.pump(runtime);
    assert.deepEqual(((await store.load("p"))!.snapshot as { control: unknown }).control, { kind: "done", value: variant("None") });
  } finally { await store.close(); }
});

test("forEach rearms or and passes tagged values to the handler on successive occurrences", async () => {
  const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
  const runtime = new Runtime(source('never()->or(ciFailed("acme/api"))->forEach(x => say(@alice, show(x)))'), store, host);
  try {
    await runtime.create("p"); await host.pump(runtime);
    for (const id of ["first", "second"]) {
      await host.emit(id, ci(), text(id)); await host.pump(runtime);
      assert.equal((await store.load("p"))!.status, "suspended");
    }
    const messages = (await store.effects("p")).filter(effect => effect.operation === "say");
    assert.deepEqual(messages.map(effect => (effect.arguments as unknown as { args: Value[] }).args[1]), [text("Second(first)"), text("Second(second)")]);
  } finally { await store.close(); }
});

test("stream combinators reject non-stream arguments, wrong arity and labels", () => {
  for (const expression of [
    'never(1)', 'never(~unused=1)', 'or()', 'or(never())', 'or(never(), 1)',
    'or(never(), merged("p"))', 'or(never(), never(), never())', 'or(never(), never(), ~unused=1)',
    'merge(never())', 'merge(never(), never(), never())', 'merge(never(), never(), ~unused=1)',
  ]) {
    const code = source(expression);
    assert.equal(advance(code, start(code)).control.kind, "error", expression);
  }
});

test("the simulated host cannot inject an occurrence into never or a composite stream", async () => {
  const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
  try {
    for (const name of ["or", "never", "merge"]) {
      await assert.rejects(host.emit("forged", { type: "source", kind: "stream", name, args: [], labels: {} }, text("forged")), /concrete external/);
    }
  } finally { await store.close(); }
});
