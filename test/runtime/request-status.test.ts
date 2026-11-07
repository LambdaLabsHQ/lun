import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../../src/frontend/parser.ts";
import { compile } from "../../src/runtime/code.ts";
import { VirtualClock } from "../../src/runtime/clock.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { SimulatedHost } from "../../src/runtime/simulated-host.ts";
import { SqliteStore } from "../../src/runtime/sqlite-store.ts";
import { text, variant } from "../../src/runtime/value.ts";

function source(contents: string) {
  const parsed = parse(contents);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return compile(parsed.program);
}

test("status is None while open and Some for each terminal request outcome", async () => {
  for (const answer of [variant("Answered", text("answer")), variant("Refused", text("no")), variant("Broke", text("fault")), variant("Cancelled"), variant("Revoked")]) {
    const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
    const runtime = new Runtime(source(`
      let q = ask(@alice, "Question?")
      let before = status(q)
      after(1h)->wait
      (before, status(q))
    `), store, host);
    try {
      await runtime.create("p"); await host.pump(runtime);
      const offer = (await store.effects("p")).find(effect => effect.operation === "request.offer")!;
      const request = (await store.request((offer.arguments as { requestId: string }).requestId))!;
      assert.ok(await host.reply(request, answer));
      await host.advanceTo(3_600_000); await host.pump(runtime);
      const checkpoint = (await store.load("p"))!;
      assert.equal(checkpoint.status, "completed");
      assert.deepEqual((checkpoint.snapshot as { control: unknown }).control, { kind: "done", value: { type: "tuple", values: [variant("None"), variant("Some", answer)] } });
    } finally { await store.close(); }
  }
});

test("a timed-out explicit wait still has status None until the request is cancelled", async () => {
  const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
  const runtime = new Runtime(source(`
    let q = ask(@alice, "Question?")
    let waited = q->waitUntil(1h)
    let pending = status(q)
    cancel(q)
    (waited, pending, status(q))
  `), store, host);
  try {
    await runtime.create("p"); await host.pump(runtime);
    await host.advanceTo(3_600_000); await host.pump(runtime);
    assert.deepEqual(((await store.load("p"))!.snapshot as { control: unknown }).control, {
      kind: "done", value: { type: "tuple", values: [variant("None"), variant("None"), variant("Some", variant("Cancelled"))] },
    });
  } finally { await store.close(); }
});
