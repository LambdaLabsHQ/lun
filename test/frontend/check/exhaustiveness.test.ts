import assert from "node:assert/strict";
import { test } from "node:test";
import { all, check, describe, only, under } from "./helpers.ts";

/** The cases a switch misses, as its error lists them. */
function missing(source: string): string[] {
  const diagnostic = only(source, "non-exhaustive");
  return diagnostic.missing!;
}

const handled = (cases: string) => `switch run(@auto, "x") {\n${cases}\n}`;

test("a switch that misses cases of an outcome names them", () => {
  const source = handled("| Done(_) => ()\n| Failed(_) => ()\n| TimedOut => ()\n| Cancelled => ()");
  const diagnostic = only(source, "non-exhaustive");
  assert.equal(diagnostic.message, "this switch does not handle Declined(_) or Revoked");
  assert.deepEqual(diagnostic.missing, ["Declined(_)", "Revoked"]);
  // It points at the switch keyword.
  assert.equal(under(source, diagnostic), "switch");
  assert.deepEqual(check(handled("| Done(_) => ()\n| other => fail(other)")).diagnostics, []);
  assert.deepEqual(check(handled("| Done(_) | Declined(_) | Failed(_) | TimedOut | Cancelled | Revoked => ()")).diagnostics, []);
});

test("nested patterns: each missing value, all of them, in the order of the constructors", () => {
  assert.deepEqual(missing(`switch Some(run(@auto, "x")) {\n| Some(Done(_)) => 1\n| None => 2\n}`), [
    "Some(Declined(_))", "Some(Failed(_))", "Some(TimedOut)", "Some(Cancelled)", "Some(Revoked)",
  ]);
  assert.deepEqual(missing("switch Some(Some(true)) {\n| Some(Some(true)) => 1\n| None => 2\n}"), ["Some(None)", "Some(Some(false))"]);
  assert.deepEqual(missing("type t = A(option<bool>) | B\nswitch B {\n| A(Some(true)) => 1\n| B => 2\n}"), ["A(None)", "A(Some(false))"]);
});

test("or-patterns cover each of their alternatives", () => {
  const source = `type probe = Ship | Drop
switch ask(@alice, "Ship?", ~options=[Ship, Drop]) {
| Done(Ship) | TimedOut => 1
| Done(Drop) => 2
| Declined(_) | Failed(_) => 3
}`;
  assert.deepEqual(missing(source), ["Cancelled", "Revoked"]);
  assert.deepEqual(check(source.replace("| Declined(_) | Failed(_) => 3", "| Declined(_) | Failed(_) | Cancelled | Revoked => 3")).diagnostics, []);
});

test("guarded cases do not count: a guard may be false", () => {
  assert.deepEqual(missing(handled(`| Done(r) if r.text == "" => ()\n| Declined(_) | Failed(_) | TimedOut | Cancelled | Revoked => ()`)), ["Done(_)"]);
  const everyGuarded = only("switch Some(1) {\n| x if x == Some(1) => 1\n}", "non-exhaustive");
  assert.equal(everyGuarded.message, "this switch has a guard on every case, and a guard can be false: add a case without one, such as _ => …");
  assert.deepEqual(everyGuarded.missing, ["_"]);
  assert.deepEqual(check("switch Some(1) {\n| Some(x) if x > 1 => 1\n| _ => 2\n}").diagnostics, []);
});

test("int, float and string literals need a catch-all case", () => {
  const ints = only("switch 3 {\n| 1 => \"a\"\n| 2 => \"b\"\n}", "non-exhaustive");
  assert.equal(ints.message, "this switch does not handle every value of type int: add a catch-all case, such as _ => …");
  assert.deepEqual(ints.missing, ["_"]);
  assert.deepEqual(missing(`switch "x" {\n| "a" => 1\n}`), ["_"]);
  assert.deepEqual(missing("switch 1.5 {\n| 1.5 => 1\n| -0.0 => 2\n}"), ["_"]);
  // Inside a constructor, _ stands for the other values.
  assert.deepEqual(missing(`switch ask(@alice, "q") {\n| Done("yes") => 1\n| Done("no") => 2\n| Declined(_) | Failed(_) | TimedOut | Cancelled | Revoked => 3\n}`), ["Done(_)"]);
  assert.deepEqual(check(`switch "x" {\n| "a" => 1\n| _ => 2\n}`).diagnostics, []);
  // bool and () are finite.
  assert.deepEqual(check("switch true {\n| true => 1\n| false => 2\n}").diagnostics, []);
  assert.deepEqual(check("switch () {\n| () => 1\n}").diagnostics, []);
  assert.deepEqual(missing("switch true {\n| true => 1\n}"), ["false"]);
});

test("a table of literals needs a catch-all, and the message says so", () => {
  const table = Array.from({ length: 8 }, (_, index) => `| ("k${index}", ${index}) => ${index}`).join("\n");
  const diagnostic = only(`let f = p => switch p {\n${table}\n}`, "non-exhaustive");
  assert.equal(diagnostic.message, "this switch does not handle every value of type (string, int): add a catch-all case, such as _ => …");
  assert.deepEqual(diagnostic.missing, ["(_, _)"]);
});

test("lists, tuples and records", () => {
  assert.deepEqual(missing("switch [1] {\n| [] => 0\n| [x] => x\n}"), ["[_, _, ..._]"]);
  assert.deepEqual(missing("switch [Some(1)] {\n| [] => 0\n| [Some(_), ..._] => 1\n}"), ["[None, ..._]"]);
  assert.deepEqual(missing("switch [true] {\n| [true, ...rest] => 1\n| [false] => 2\n}"), ["[]", "[false, _, ..._]"]);
  assert.deepEqual(check("switch [1] {\n| [] => 0\n| [first, ...rest] => first\n}").diagnostics, []);
  assert.deepEqual(missing("switch (true, false) {\n| (true, true) => 1\n}"), ["(true, false)", "(false, _)"]);
  assert.deepEqual(check("switch (true, Some(1)) {\n| (true, _) => 1\n| (false, Some(_)) => 2\n| (false, None) => 3\n}").diagnostics, []);
  const record = `type check = {name: string, state: outcome<report>}\nlet c = {name: "ci", state: TimedOut}\n`;
  assert.deepEqual(missing(`${record}switch c {\n| {state: Done(_)} => 1\n| {state: TimedOut} => 2\n}`), [
    "{state: Declined(_)}", "{state: Failed(_)}", "{state: Cancelled}", "{state: Revoked}",
  ]);
  assert.deepEqual(check(`${record}switch c {\n| {state: Done(_)} => 1\n| {name} => 2\n}`).diagnostics, []);
  assert.deepEqual(missing(`switch {version: "1"} {\n| {version: "1"} => 1\n}`), ["_"]);
});

test("a case that can never match is a warning, and so is an alternative", () => {
  const source = `switch "x" {\n| "a" => 1\n| _ => 2\n| "b" => 3\n}`;
  const warning = only(source, "unreachable-case");
  assert.equal(warning.severity, "warning");
  assert.equal(warning.message, "this case can never match: the cases before it cover every value it matches");
  assert.equal(under(source, warning), `"b"`);
  assert.deepEqual(all("switch Done(1) {\n| Done(_) => 1\n| Done(1) => 2\n| other => fail(other)\n}"), [
    ["unreachable-case", "this case can never match: the cases before it cover every value it matches", 3, 3],
  ]);
  assert.deepEqual(all("switch Done(1) {\n| Done(_) | Done(1) => 1\n| other => fail(other)\n}"), [
    ["unreachable-case", "this alternative can never match: the patterns before it cover every value it matches", 2, 13],
  ]);
  // A guarded case can be unreachable too, and a case after a guarded one is not.
  assert.deepEqual(all("switch Some(1) {\n| _ => 1\n| Some(x) if x > 0 => 2\n}"), [
    ["unreachable-case", "this case can never match: the cases before it cover every value it matches", 3, 3],
  ]);
  assert.deepEqual(check("switch Some(1) {\n| Some(x) if x > 0 => 1\n| Some(_) => 2\n| None => 3\n}").diagnostics, []);
});

test("let patterns and parameters must match every value", () => {
  assert.deepEqual(check(`let (a, b) = (1, 2)\nlet {version} = {version: "1"}\nlet () = ()\nlet f = ((x, y), {version: v}) => x + y\nignore((a, b, version, f))`).diagnostics, []);
  const source = "let Some(x) = Some(1)\nignore(x)";
  const refutable = only(source, "refutable-pattern");
  assert.equal(
    refutable.message,
    "this pattern does not match every value: it misses None; a let takes apart only a value that always matches, such as a tuple or a record; use switch, or ? on an outcome, option or result",
  );
  assert.deepEqual(refutable.missing, ["None"]);
  assert.equal(under(source, refutable), "Some(x)");
  assert.deepEqual(only(`let Done(r) = run(@auto, "x")\nignore(r)`, "refutable-pattern").missing, ["Declined(_)", "Failed(_)", "TimedOut", "Cancelled", "Revoked"]);
  assert.deepEqual(only("let [x] = [1]\nignore(x)", "refutable-pattern").missing, ["[]", "[_, _, ..._]"]);
  assert.equal(
    only("let f = (Some(x)) => x", "refutable-pattern").message,
    "this pattern does not match every value: it misses None; a parameter takes apart only a value that always matches; switch on the value inside the function instead",
  );
});

test("patterns: names are bound once, and every alternative binds the same names with the same types", () => {
  assert.deepEqual(all("switch (1, 2) {\n| (x, x) => 1\n}"), [["duplicate-binding", "x is bound twice in this pattern", 2, 7]]);
  assert.deepEqual(all("switch Some(1) {\n| Some(x) | None => 1\n}"), [
    ["or-pattern-bindings", "every alternative of a pattern binds the same names: the first alternative binds x, and this one does not", 2, 13],
  ]);
  assert.deepEqual(all("switch (Some(1), \"s\") {\n| (Some(x), _) | (None, x) => 1\n}"), [
    ["type-mismatch", "expected x to have type int, as in the first alternative, found string", 2, 25],
  ]);
  assert.deepEqual(all(`switch 1 {\n| "one" => 1\n| _ => 2\n}`), [["type-mismatch", "expected a pattern of type int, found one of type string", 2, 3]]);
  assert.deepEqual(all("switch Some(1) {\n| Done(_) => 1\n| _ => 2\n}"), [["type-mismatch", "expected a pattern of type option<int>, found one of type outcome<'a>", 2, 3]]);
  // A switch whose patterns are wrong is not also reported as incomplete.
  const result = check("switch Some(1) {\n| Nope => 1\n}");
  assert.deepEqual(result.diagnostics.map((d) => d.code), ["unknown-constructor"], describe(result.diagnostics));
});
