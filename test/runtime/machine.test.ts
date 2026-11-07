import assert from "node:assert/strict";
import { test } from "node:test";
import type { AstNode, Expression, FieldsOf, NodeKind, Pattern, Program, Statement, Span } from "../../src/frontend/ast.ts";
import { compile } from "../../src/runtime/code.ts";
import { advance, resume, start, type Machine } from "../../src/runtime/machine.ts";
import { encodeJson, type Json } from "../../src/runtime/persistence.ts";
import { show, text, unit, variant, type Value } from "../../src/runtime/value.ts";

const span: Span = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } };
function n<K extends NodeKind>(kind: K, fields: Pick<Extract<AstNode, {kind: K}>, FieldsOf<K>>): Extract<AstNode, {kind: K}> {
  return { kind, ...fields, span } as Extract<AstNode, {kind: K}>;
}
const id = (name: string) => n("Identifier", { name });
const variable = (name: string) => n("VarPattern", { name });
const int = (value: string | number) => n("IntLiteral", { value: String(value) });
const str = (value: string) => n("StringLiteral", { value });
const call = (name: string, ...args: Expression[]) => n("Call", { callee: id(name), args });
const block = (...body: Statement[]) => n("Block", { body });
const let_ = (name: string, value: Expression) => n("Let", { pattern: variable(name), value });
const lambda = (params: string[], body: Expression) => n("Lambda", { params: params.map(variable), body });
const constructor = (name: string, ...args: Expression[]) => n("Constructor", { name, args });
const bin = (op: "+" | "-" | "==", left: Expression, right: Expression) => n("Binary", { op, left, right });
const program = (...body: Statement[]): Program => n("Program", { body });
const snapshot = (machine: Machine) => JSON.parse(encodeJson(machine as unknown as Json)) as Machine;
function done(p: Program): Value {
  const code = compile(p); let machine = start(code);
  do { machine = advance(code, machine); } while (machine.control.kind === "eval" || machine.control.kind === "value");
  assert.equal(machine.control.kind, "done", JSON.stringify(machine.control));
  return (machine.control as {kind: "done"; value: Value}).value;
}

test("lexical capture survives JSON serialization and source reloading during an effect", () => {
  const p = program(let_("x", str("captured")), let_("f", lambda([], id("x"))), let_("x", str("shadowed")),
    call("run", n("ParticipantLiteral", { name: "codex", instance: "2", args: [] }), str("work")), call("f"));
  let code = compile(p), machine = advance(code, start(code, 7));
  assert.equal(machine.control.kind, "effect");
  const encoded = snapshot(machine);
  code = compile(JSON.parse(JSON.stringify(p)) as Program);
  machine = advance(code, resume(encoded, variant("Answered", text("report")), 100));
  assert.deepEqual(machine.control, { kind: "done", value: text("captured") });
});

test("integers retain arbitrary precision; floating negative zero is serializable", () => {
  assert.deepEqual(done(program(bin("+", int("900719925474099300000"), int(1)))), { type: "int", value: "900719925474099300001" });
  const result = done(program(n("Unary", { op: "-.", operand: n("FloatLiteral", { value: 0 }) })));
  assert.deepEqual(result, { type: "float", value: "-0" });
  assert.equal(JSON.parse(encodeJson(result as unknown as Json)).value, "-0");
});

test("labelled defaults evaluate in the function environment and retain argument order", () => {
  const fn = n("Lambda", { params: [variable("x"), n("LabelledParam", {
    label: "extra", pattern: variable("y"), defaultValue: bin("+", id("x"), int(1)),
  })], body: bin("+", id("x"), id("y")) });
  assert.deepEqual(done(program(let_("f", fn), call("f", int(20)))), { type: "int", value: "41" });
});

test("tail recursion yields repeatedly without retaining an unbounded stack or lexical heap", () => {
  const recursive = n("LetRec", { bindings: [n("RecBinding", { name: "count", value: lambda(["x"], n("If", {
    condition: bin("==", id("x"), int(0)), thenBranch: block(int(0)), elseBranch: block(call("count", bin("-", id("x"), int(1)))),
  })) })] });
  const code = compile(program(recursive, call("count", int(10_000)))); let machine = start(code);
  let slices = 0;
  while (machine.control.kind === "eval" || machine.control.kind === "value") {
    machine = advance(code, snapshot(machine), 200); slices++;
    assert.ok(machine.frames.length < 20);
    assert.ok(Object.keys(machine.environments).length < 20);
  }
  assert.ok(slices > 10);
  assert.deepEqual(machine.control, { kind: "done", value: { type: "int", value: "0" } });
});

test("mutually recursive closures reference one durable environment", () => {
  const branch = (other: string, answer: boolean) => lambda(["n"], n("If", {
    condition: bin("==", id("n"), int(0)), thenBranch: block(n("BoolLiteral", { value: answer })),
    elseBranch: block(call(other, bin("-", id("n"), int(1)))),
  }));
  const rec = n("LetRec", { bindings: [n("RecBinding", { name: "even", value: branch("odd", true) }), n("RecBinding", { name: "odd", value: branch("even", false) })] });
  assert.deepEqual(done(program(rec, call("even", int(41)))), { type: "bool", value: false });
});

test("? returns from the nearest function and propagates explicitly at program level", () => {
  const p = program(let_("f", lambda([], block(n("Try", { operand: constructor("Refused", str("busy")) }), str("unreachable")))),
    let_("answer", call("f")), n("TupleLiteral", { elements: [id("answer"), str("caller continued")] }));
  assert.deepEqual(done(p), { type: "tuple", values: [variant("Refused", text("busy")), text("caller continued")] });
  const code = compile(program(n("Try", { operand: constructor("Revoked") }), call("run", str("never"))));
  assert.deepEqual(advance(code, start(code)).control, { kind: "failed", outcome: variant("Revoked") });
});

test("patterns, guards and short circuiting do not perform skipped effects", () => {
  const cases = [n("Case", { pattern: variable("x"), guard: n("BoolLiteral", { value: false }), body: call("run", str("never")) }),
    n("Case", { pattern: n("ConstructorPattern", { name: "Answered", args: [variable("result")] }), guard: null, body: id("result") })];
  assert.deepEqual(done(program(n("Switch", { scrutinee: constructor("Answered", str("yes")), cases }))), text("yes"));
  assert.deepEqual(done(program(n("Binary", { op: "&&", left: n("BoolLiteral", { value: false }), right: call("judge", str("never")) }))), { type: "bool", value: false });
});

test("record fields are data, including names inherited by JavaScript objects", () => {
  const record = n("RecordLiteral", { spread: null, fields: [n("RecordField", { name: "__proto__", value: str("safe") })] });
  assert.deepEqual(done(program(n("FieldAccess", { record, field: "__proto__" }))), text("safe"));
  const code = compile(program(n("FieldAccess", { record: n("RecordLiteral", { spread: null, fields: [] }), field: "constructor" })));
  const result = advance(code, start(code));
  assert.equal(result.control.kind, "error");
});

test("now is stable until a suspended machine resumes", () => {
  const p = program(let_("before", call("now")), call("say", str("wait for a checkpoint")), n("TupleLiteral", { elements: [id("before"), call("now")] }));
  const code = compile(p), m = advance(code, start(code, 10));
  assert.equal(m.control.kind, "effect");
  const result = advance(code, resume(snapshot(m), unit, 20));
  assert.deepEqual(result.control, { kind: "done", value: { type: "tuple", values: [{ type: "time", value: "10" }, { type: "time", value: "20" }] } });
});

test("forEach waits after its callback instead of treating the report as another occurrence", () => {
  const p = program(call("forEach", call("every", n("DurationLiteral", { amount: "1", unit: "d" })), lambda(["event"], call("run", str("job")))));
  const code = compile(p); let m = advance(code, start(code));
  assert.equal(m.control.kind, "effect");
  m = advance(code, resume(m, text("tick"), 1));
  assert.equal(m.control.kind, "effect");
  if (m.control.kind === "effect") assert.equal(m.control.effect.name, "run");
  m = advance(code, resume(snapshot(m), variant("Answered", text("report")), 2));
  assert.equal(m.control.kind, "effect");
  if (m.control.kind === "effect") assert.equal(m.control.effect.name, "wait");
});

test("pinned code cannot be mutated through the original AST or exposed node table", () => {
  const literal = int(1), p = program(literal), code = compile(p);
  literal.value = "2";
  const machine = advance(code, start(code));
  assert.deepEqual(machine.control, { kind: "done", value: { type: "int", value: "1" } });
  const pinned = Object.values(code.nodes).find(x => x.kind === "IntLiteral")!;
  assert.throws(() => { (pinned as { value: string }).value = "3"; }, TypeError);
  assert.throws(() => { code.nodes["replacement"] = int(4); }, TypeError);
});

test("lexical names that resemble JavaScript prototype properties stay ordinary bindings", () => {
  const p = program(let_("__proto__", str("value")), id("__proto__"));
  assert.deepEqual(done(p), text("value"));
});


test("time and duration rendering produces readable coordination text", () => {
  assert.equal(show({ type: "time", value: String(Date.parse("2026-11-07T12:00Z")) }), "2026-11-07T12:00:00.000Z");
  assert.equal(show({ type: "duration", value: "3600000" }), "1h");
  assert.equal(show({ type: "duration", value: "86400000" }), "1d");
});
