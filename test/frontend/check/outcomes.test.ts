import assert from "node:assert/strict";
import { test } from "node:test";
import { all, check, describe, only, under } from "./helpers.ts";

const advice = "handle it with switch, ? or fail, or write ignore(…) to drop it on purpose";

test("an outcome used as a statement before the last of its block is an error", () => {
  const source = `run(@auto, "first")\nrun(@auto, "second")`;
  const dropped = only(source, "dropped-outcome");
  assert.equal(dropped.message, `this outcome<report> is dropped: only the last statement of a block gives its value; ${advice}`);
  assert.equal(dropped.found, "outcome<report>");
  assert.equal(under(source, dropped), `run(@auto, "first")`);
  // In a function's block, and in a case body.
  assert.deepEqual(all(`let f = () => {\n  ask(@alice, "q")\n  ()\n}`), [["dropped-outcome", `this outcome<string> is dropped: only the last statement of a block gives its value; ${advice}`, 2, 3]]);
  assert.deepEqual(all(`switch Some(1) {\n| Some(_) =>\n  run(@auto, "x")\n  ()\n| None => ()\n}`).map(([code, , line]) => [code, line]), [["dropped-outcome", 3]]);
  // A block whose value is an outcome, used as a statement.
  assert.deepEqual(all(`{ run(@auto, "x") }\n()`).map(([code]) => code), ["dropped-outcome"]);
});

test("let _ = e drops an outcome, and so does a _ for an outcome inside a let pattern", () => {
  const source = `let _ = ask(@alice, "q")`;
  const dropped = only(source, "dropped-outcome");
  assert.equal(dropped.message, `let _ = … drops this outcome<string>; ${advice}`);
  assert.equal(under(source, dropped), "_");
  assert.equal(only(`let (_, n) = (ask(@alice, "q"), 1)\nignore(n)`, "dropped-outcome").message, `this _ drops an outcome<string>; ${advice}`);
});

test("a let that binds an outcome to a name never used is an error", () => {
  const source = `let answer = ask(@alice, "q")`;
  const unused = only(source, "unused-outcome");
  assert.equal(unused.message, "answer holds an outcome<string> that is never used; handle it with switch, ? or fail, or write ignore(answer) to drop it on purpose");
  assert.equal(under(source, unused), "answer");
  assert.equal(only(`let (answer, n) = (ask(@alice, "q"), 1)\nignore(n)`, "unused-outcome").message.startsWith("answer holds an outcome<string>"), true);
  // A later binding of the same name does not use the first.
  assert.deepEqual(all(`let r = run(@auto, "x")\nlet r = 1\nignore(r)`).map(([code, , line]) => [code, line]), [["unused-outcome", 1]]);
});

test("handling, propagating, failing, returning or ignoring an outcome is fine", () => {
  for (const source of [
    // ignore sets it aside on purpose.
    `ignore(run(@auto, "x"))\nrun(@auto, "y")`,
    `let _ = ignore(ask(@alice, "q"))`,
    // ? propagates it, switch inspects it, fail ends the program with it.
    `let r = run(@auto, "x")?\nsay(@alice, r.text)`,
    `switch run(@auto, "x") {\n| other => ()\n}`,
    `let o = run(@auto, "x")\nfail(o)`,
    // The last statement is the block's value: a function returns it, a program ends with it.
    `let f = () => run(@auto, "x")\nf()`,
    `let answer = ask(@alice, "q")\nsay(@alice, show(answer))`,
    // A value of another type that holds outcomes is not an outcome.
    `let xs = [run(@auto, "x")]\n()`,
    `let s = status(request(@codex, "q"))\n()`,
  ]) {
    const result = check(source);
    assert.deepEqual(result.diagnostics, [], `${source}\n${describe(result.diagnostics)}`);
  }
});
