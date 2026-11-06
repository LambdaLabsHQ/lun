import assert from "node:assert/strict";
import { test } from "node:test";
import type { Expression, Program, Span } from "../../../src/frontend/ast.ts";
import { STACK_EXHAUSTED } from "../../../src/frontend/index.ts";
import { checkProgram, referenceHost, standardLibrary } from "../../../src/frontend/check/index.ts";
import { check, describe } from "./helpers.ts";

/** A program that must check without any diagnostic. */
function ok(source: string): void {
  const result = check(source);
  assert.deepEqual(result.diagnostics, [], describe(result.diagnostics.slice(0, 3)));
}

test("chains of 10,000 links check: pipes, calls, operators, ? and else if", () => {
  ok(`let inc = x => x + 1\n0${"->inc".repeat(10_000)}`);
  ok(`let x = ${Array(10_001).fill("1").join(" + ")}`);
  ok(`let f = x => x\nlet g = f${"(f)".repeat(10_000)}`);
  ok(`let x = ${"!".repeat(10_000)}true`);
  ok(`let o = ${"Some(".repeat(100)}1${")".repeat(100)}\nlet x = o${"?".repeat(100)}`);
  ok(`let a = true\nlet x = if a { 1 }${" else if a { 1 }".repeat(9_999)} else { 2 }`);
  // A chain whose type nests one level deeper at each link.
  ok(`let wrap = x => [x]\nlet y = 0${"->wrap".repeat(10_000)}`);
});

test("10,000 cases and 10,000 statements check", () => {
  const cases = Array.from({ length: 10_000 }, (_, index) => `| "${index}" => ${index}`).join("\n");
  ok(`let n = switch "x" {\n${cases}\n| _ => 0\n}`);
  ok(Array.from({ length: 10_000 }, (_, index) => `let x${index} = ${index}`).join("\n"));
});

test("a tree nested deeper than the stack can follow is a diagnostic, not a crash", () => {
  const span: Span = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 2, offset: 1 } };
  const options = { host: referenceHost(), std: standardLibrary() };
  const nest = (wrap: (inner: Expression) => Expression): Program => {
    let expression: Expression = { kind: "IntLiteral", value: "1", span };
    for (let depth = 0; depth < 200_000; depth += 1) expression = wrap(expression);
    return { kind: "Program", body: [expression], span };
  };
  for (const program of [
    nest((inner) => ({ kind: "Block", body: [inner], span })),
    nest((inner) => ({ kind: "Lambda", params: [], body: inner, span })),
    nest((inner) => ({ kind: "TupleLiteral", elements: [inner, { kind: "UnitLiteral", span }], span })),
  ]) {
    const result = checkProgram(program, options);
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics.map((d) => [d.code, d.message]), [["too-deep", STACK_EXHAUSTED]]);
  }
});
