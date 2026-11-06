import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Expression, Program } from "../../src/frontend/ast.ts";
import { compile } from "../../src/runtime/code.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { SimulatedHost } from "../../src/runtime/simulated-host.ts";
import { SqliteStore } from "../../src/runtime/sqlite-store.ts";
import { text, variant, type Value } from "../../src/runtime/value.ts";
import type { StoredRequest } from "../../src/runtime/persistence.ts";
import { n, id, str, call, block, let_, lambda, constructor, variable, program } from "./ast-fixture.ts";

const person = (name: string) => n("ParticipantLiteral", { name, instance: null, args: [] });
const hour = () => n("DurationLiteral", { amount: "1", unit: "h" });
const labelled = (label: string, value: Expression) => n("LabelledArg", { label, value });
const invoke = (name: string, args: Parameters<typeof n<"Call">>[1]["args"]) => n("Call", { callee: id(name), args });
async function setup(p: Program) {
  const store = new SqliteStore(":memory:"), host = new SimulatedHost(store), runtime = new Runtime(compile(p), store, host);
  await runtime.create("p"); await host.pump(runtime);
  return { store, host, runtime };
}
async function openRequest(store: SqliteStore, name?: string): Promise<StoredRequest> {
  for (const effect of await store.effects("p")) {
    if (effect.operation !== "request.offer") continue;
    const args = effect.arguments as { requestId: string; epoch: number };
    const r = (await store.request(args.requestId))!;
    if (r.outcome === null && r.epoch === args.epoch && (!name || (r.arguments as { name: string }).name === name)) return r;
  }
  throw new Error(`No open ${name ?? ""} request`);
}
function arm(name: string, body: Expression, bound?: string) {
  return n("Case", { pattern: n("ConstructorPattern", { name, args: bound ? [variable(bound)] : [] }), guard: null, body });
}

test("decide takes a declared default only on timeout; an unknown answer never consents", async () => {
  const p = program(n("Switch", {
    scrutinee: invoke("ask", [person("alice"), str("Ship?"), labelled("options", n("ListLiteral", { elements: [constructor("Ship"), constructor("Skip")], rest: null })), labelled("until", hour())]),
    cases: [n("Case", { pattern: n("OrPattern", { alternatives: [n("ConstructorPattern", { name: "Done", args: [n("ConstructorPattern", { name: "Ship", args: [] })] }), n("ConstructorPattern", { name: "TimedOut", args: [] })] }), guard: null, body: call("run", person("codex"), str("ship within budget")) }),
      arm("Done", call("say", person("alice"), str("skipped")), "skip"),
      n("Case", { pattern: variable("other"), guard: null, body: call("fail", id("other")) })],
  }));
  for (const timedOut of [true, false]) {
    const { store, host, runtime } = await setup(p);
    try {
      const decision = await openRequest(store, "ask");
      if (timedOut) await host.advanceTo(3_600_000);
      else await host.reply(decision, variant("Done", text("nonsense")));
      await host.pump(runtime);
      if (timedOut) {
        assert.deepEqual((await store.request(decision.id))!.outcome, { tag: "Cancelled" });
        const work = await openRequest(store, "run");
        assert.equal((work.arguments as { args: { value: string }[] }).args[1].value, "ship within budget");
        await host.reply(work, variant("Done", text("shipped"))); await host.pump(runtime);
        assert.equal((await store.load("p"))!.status, "completed");
      } else {
        assert.equal((await store.load("p"))!.status, "failed");
        assert.equal((await store.effects("p")).filter(e => e.operation === "request.offer").length, 1);
      }
    } finally { await store.close(); }
  }
});

test("followUp hands the same request over after one wait times out", async () => {
  const p = program(let_("q", call("request", person("codex"), str("Build healthy?"))), n("Switch", {
    scrutinee: invoke("wait", [id("q"), labelled("until", hour())]), cases: [arm("Done", id("answer"), "answer"),
      arm("TimedOut", call("wait", call("handOver", id("q"), person("alice"))))],
  }));
  const { store, host, runtime } = await setup(p);
  try {
    const original = await openRequest(store); await host.advanceTo(3_600_000); await host.pump(runtime);
    const moved = await openRequest(store);
    assert.equal(moved.id, original.id); assert.equal(moved.epoch, 1); assert.equal(moved.holder, "@alice");
    assert.equal(await host.reply(original, variant("Done", text("late"))), false);
    assert.equal(await host.reply(moved, variant("Done", text("healthy"))), true);
    await host.pump(runtime); assert.equal((await store.load("p"))!.status, "completed");
  } finally { await store.close(); }
});

test("a release verification chain consumes preexisting facts and a later release before asking an agent", async () => {
  const p = program(let_("pr", n("Try", { operand: call("wait", call("merged", str("acme/api#1"))) })),
    let_("release", n("Try", { operand: call("wait", invoke("released", [constructor("Beta"), labelled("containing", id("pr"))])) })),
    n("Try", { operand: call("wait", invoke("machineUpdated", [labelled("machine", str("builder")), labelled("atLeast", n("FieldAccess", { record: id("release"), field: "version" }))])) }),
    call("run", person("codex"), str("verify live")));
  const store = new SqliteStore(":memory:"), host = new SimulatedHost(store), runtime = new Runtime(compile(p), store, host);
  const source = (name: string, args: Value[], labels: Record<string, Value> = {}): Value => ({ type: "source", kind: "fact", name, args, labels });
  try {
    await host.emit("merged-first", source("merged", [text("acme/api#1")]), text("pr:1"));
    await runtime.create("p"); await host.pump(runtime);
    assert.equal((await store.effects("p")).length, 0);
    await host.advanceTo(10);
    await host.emit("release", source("released", [variant("Beta")], { containing: text("pr:1") }), { type: "record", fields: { version: text("v1") } });
    await host.pump(runtime); assert.equal((await store.effects("p")).length, 0);
    await host.emit("machine", source("machineUpdated", [], { machine: text("builder"), atLeast: text("v1") }), text("ready"));
    await host.pump(runtime);
    const work = await openRequest(store, "run"); await host.reply(work, variant("Done", text("verified"))); await host.pump(runtime);
    assert.equal((await store.load("p"))!.status, "completed");
  } finally { await store.close(); }
});

test("keep-going recursion wakes on a PR event, then stops when the judge says done", async () => {
  const body = block(let_("report", n("Try", { operand: call("run", person("codex"), str("advance PR")) })),
    n("If", { condition: n("Unary", { op: "!", operand: n("Try", { operand: invoke("judge", [str("complete?"), labelled("about", id("report"))]) }) }),
      thenBranch: block(n("Try", { operand: call("wait", call("merge", call("prActivity", str("acme/api#1")), call("after", hour()))) }), call("push")), elseBranch: null }));
  const p = program(n("LetRec", { bindings: [n("RecBinding", { name: "push", value: lambda([], body) })] }), call("push"));
  const { store, host, runtime } = await setup(p);
  try {
    for (const complete of [false, true]) {
      await host.reply(await openRequest(store, "run"), variant("Done", text("report"))); await host.pump(runtime);
      await host.reply(await openRequest(store, "judge"), variant("Done", { type: "bool", value: complete })); await host.pump(runtime);
      if (!complete) {
        assert.equal((await store.load("p"))!.status, "suspended");
        await host.emit("new-pr-event", { type: "source", kind: "stream", name: "prActivity", args: [text("acme/api#1")], labels: {} }, text("updated"));
        await host.pump(runtime);
      }
    }
    assert.equal((await store.load("p"))!.status, "completed");
  } finally { await store.close(); }
});

test("restart loads the pinned AST artifact rather than recompiling source", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-runtime-")), path = join(directory, "runtime.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new SqliteStore(path), host = new SimulatedHost(store);
  let runtime = new Runtime(compile(program(call("ask", person("alice"), str("hello")))), store, host);
  await runtime.create("p"); await host.pump(runtime); const original = await openRequest(store); await store.close();
  store = new SqliteStore(path); host = new SimulatedHost(store, 20);
  try {
    runtime = await Runtime.restore("p", store, host);
    await assert.rejects(store.saveCode(runtime.code.id, "overwritten"), /cannot be overwritten/);
    await host.reply(original, variant("Done", text("answer"))); await host.pump(runtime);
    assert.equal((await store.load("p"))!.status, "completed");
    const state = (await store.load("p"))!.snapshot as { control: { value: Value } };
    assert.deepEqual(state.control.value, variant("Done", text("answer")));
  } finally { await store.close(); }
});

test("current host policy blocks new work and a message whose permission was revoked before delivery", async () => {
  const store = new SqliteStore(":memory:"), host = new SimulatedHost(store);
  const runtime = new Runtime(compile(program(call("say", person("alice"), str("notice")))), store, host);
  try {
    await runtime.create("p"); await runtime.runReady(host.now); host.permitted = false; await host.dispatch();
    const effects = await store.effects("p");
    assert.equal(effects.find(e => e.operation === "say")!.status, "blocked");
  } finally { await store.close(); }
  const s = new SqliteStore(":memory:"), h = new SimulatedHost(s); h.permitted = false;
  try {
    const r = new Runtime(compile(program(call("run", person("codex"), str("never")))), s, h);
    await r.create("p"); await h.pump(r);
    assert.equal((await s.load("p"))!.status, "revoked");
    assert.ok((await s.effects("p")).every(e => e.operation !== "request.offer"));
  } finally { await s.close(); }
});
