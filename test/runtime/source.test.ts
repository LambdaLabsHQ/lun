import { VirtualClock } from "../../src/runtime/clock.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "../../src/frontend/parser.ts";
import { compile } from "../../src/runtime/code.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { SimulatedHost } from "../../src/runtime/simulated-host.ts";
import { SqliteStore } from "../../src/runtime/sqlite-store.ts";
import { text, variant, type Value } from "../../src/runtime/value.ts";
import type { StoredRequest } from "../../src/runtime/persistence.ts";

async function example(name: string) {
  const source = readFileSync(new URL(`../../examples/${name}.norn`, import.meta.url), "utf8");
  const parsed = parse(source);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const clock = new VirtualClock(), store = new SqliteStore(":memory:", clock), host = new SimulatedHost(store, clock);
  const runtime = new Runtime(compile(parsed.program), store, host);
  await runtime.create("example"); await host.pump(runtime);
  return { store, host, runtime };
}
async function offered(store: SqliteStore, name: string): Promise<StoredRequest> {
  for (const effect of await store.effects("example")) {
    if (effect.operation !== "request.offer") continue;
    const args = effect.arguments as { requestId: string; epoch: number };
    const request = (await store.request(args.requestId))!;
    if (request.epoch === args.epoch && request.outcome === null && (request.arguments as { name: string }).name === name) return request;
  }
  throw new Error(`No pending ${name}: ${JSON.stringify((await store.load("example"))!.snapshot)}`);
}
const fact = (name: string, args: Value[], labels: Record<string, Value> = {}): Value => ({ type: "source", kind: "fact", name, args, labels });

test("decide.norn executes its explicit timeout default with a scripted participant", async () => {
  const { store, host, runtime } = await example("decide");
  try {
    const question = await offered(store, "confirm");
    await host.advanceTo(Date.parse("2026-11-07T12:00Z")); await host.pump(runtime);
    assert.deepEqual((await store.request(question.id))!.outcome, { tag: "NoReply" });
    const work = await offered(store, "run");
    const task = (work.arguments as { args: { value: string }[] }).args[1].value;
    assert.match(task, /at most US\$0\.10/);
    await host.reply(work, variant("Answered", {type: "record", fields: {text: text("simulated report")}})); await host.pump(runtime);
    assert.equal((await store.load("example"))!.status, "completed");
  } finally { await store.close(); }
});

test("follow-up.norn times out one wait and transfers the same request to a person", async () => {
  const { store, host, runtime } = await example("follow-up");
  try {
    const first = await offered(store, "ask");
    await host.advanceTo(3_600_000); await host.pump(runtime);
    const moved = await offered(store, "ask");
    assert.equal(moved.id, first.id); assert.equal(moved.holder, "@alice"); assert.equal(moved.epoch, 1);
    assert.equal(await host.reply(first, variant("Answered", text("old reply"))), false);
    await host.reply(moved, variant("Answered", text("answer"))); await host.pump(runtime);
    assert.equal((await store.load("example"))!.status, "completed");
  } finally { await store.close(); }
});

test("release-chain.norn waits through release and machine facts before requesting verification", async () => {
  const { store, host, runtime } = await example("release-chain");
  try {
    await host.emit("merge", fact("merged", [text("acme/api#1436")]), text("pr1436")); await host.pump(runtime);
    await host.emit("release", fact("released", [variant("Beta")], { containing: text("pr1436") }), { type: "record", fields: { version: text("v1") } });
    await host.pump(runtime);
    assert.equal((await store.effects("example")).length, 0);
    await host.emit("machine", fact("machineUpdated", [], { machine: text("win-builder"), atLeast: text("v1") }), text("ready"));
    await host.pump(runtime);
    await host.reply(await offered(store, "run"), variant("Answered", {type: "record", fields: {text: text("verified")}})); await host.pump(runtime);
    assert.equal((await store.load("example"))!.status, "completed");
  } finally { await store.close(); }
});

test("push.norn recursively continues on a PR event and terminates after a positive judgement", async () => {
  const { store, host, runtime } = await example("push");
  try {
    for (const done of [false, true]) {
      await host.reply(await offered(store, "run"), variant("Answered", {type: "record", fields: {text: text("report")}})); await host.pump(runtime);
      await host.reply(await offered(store, "judge"), variant("Answered", { type: "bool", value: done })); await host.pump(runtime);
      if (!done) {
        await host.emit("activity", { type: "source", kind: "stream", name: "prActivity", args: [text("acme/api#1439")], labels: {} }, text("new activity"));
        await host.pump(runtime);
      }
    }
    assert.equal((await store.load("example"))!.status, "completed");
  } finally { await store.close(); }
});
