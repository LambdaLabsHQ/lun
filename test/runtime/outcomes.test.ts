import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../../src/frontend/parser.ts";
import { compile } from "../../src/runtime/code.ts";
import { advance, start } from "../../src/runtime/machine.ts";
import { VirtualClock } from "../../src/runtime/clock.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { SimulatedHost } from "../../src/runtime/simulated-host.ts";
import { SqliteStore } from "../../src/runtime/sqlite-store.ts";
import { text, variant, type Value } from "../../src/runtime/value.ts";

function source(contents: string) {
  const parsed = parse(contents);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return compile(parsed.program);
}

test("each final unsuccessful outcome fails visibly rather than completing", async () => {
  const cases: [string, Value][] = [
    ['Refused("no")', variant("Refused", text("no"))],
    ['Broke("fault")', variant("Broke", text("fault"))],
    ['NoReply', variant("NoReply")], ['Cancelled', variant("Cancelled")], ['Revoked', variant("Revoked")],
  ];
  for (const [expression, expected] of cases) {
    const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
    const runtime = new Runtime(source(expression), store, host);
    try {
      await runtime.create("p"); await host.pump(runtime);
      const checkpoint = (await store.load("p"))!;
      assert.equal(checkpoint.status, expression === "Revoked" ? "revoked" : "failed");
      assert.deepEqual((checkpoint.snapshot as { control: unknown }).control, { kind: "failed", outcome: expected });
      const notices = await store.effects("p");
      assert.equal(notices.length, 1); assert.equal(notices[0].operation, "execution.failed");
      assert.equal(notices[0].kind, "notification"); assert.equal(notices[0].status, "delivered");
      assert.deepEqual(notices[0].arguments, expected);
    } finally { await store.close(); }
  }
});

test("a program ending in run reports a participant failure without requiring explicit ?", async () => {
  const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
  const runtime = new Runtime(source('run(@codex, "Do the task")->wait'), store, host);
  try {
    await runtime.create("p"); await host.pump(runtime);
    const offer = (await store.effects("p")).find(effect => effect.operation === "request.offer")!;
    const request = (await store.request((offer.arguments as { requestId: string }).requestId))!;
    await host.reply(request, variant("Broke", text("could not finish"))); await host.pump(runtime);
    assert.equal((await store.load("p"))!.status, "failed");
    const terminal = (await store.effects("p")).filter(effect => effect.operation === "execution.failed");
    assert.equal(terminal.length, 1);
    assert.deepEqual(terminal[0].arguments, variant("Broke", text("could not finish")));
  } finally { await store.close(); }
});

test("a function may return failure for its caller to handle", () => {
  const code = source(`
    let check = () => Broke("recoverable")
    switch check() {
    | Broke(reason) => Answered(reason)
    | other => other
    }
  `);
  assert.deepEqual(advance(code, start(code)).control, { kind: "done", value: variant("Answered", text("recoverable")) });
});

test("successful outcomes and ordinary final values still complete normally", () => {
  for (const expression of ['Answered("ok")', '42', '()', 'None', 'ignore(Broke("discarded"))']) {
    const code = source(expression);
    assert.equal(advance(code, start(code)).control.kind, "done", expression);
  }
});
