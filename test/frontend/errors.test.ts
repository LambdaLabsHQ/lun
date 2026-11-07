import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticLine, formatDiagnostic } from "../../src/frontend/index.ts";
import { parseErrors } from "./helpers.ts";

/** Source, message, line, column of the first error. */
const cases: [string, string, number, number][] = [
  // The example from the brief: a case without its arrow.
  ["switch x {\n| Done(Drop) run(@auto, \"x\")\n}", "expected '=>' after pattern, found 'run'", 2, 14],
  ["switch x {\n| Done(n) if n > 1 n\n}", "expected '=>' after the guard, found 'n'", 2, 20],
  ['ask(@alice "Ship?")', "expected ',' or ')' after an argument, found a string", 1, 12],
  ["let f = (a, b => a", "expected ')' to close the '(' at 1:9, found end of file", 1, 19],
  ["switch x {\n| A => 1\n", "expected '}' to close the '{' at 1:10, found end of file", 3, 1],
  ["let x = {\n  let y = 1\n", "expected '}' to close the '{' at 1:9, found end of file", 3, 1],
  ["[1, 2", "expected ']' to close the '[' at 1:1, found end of file", 1, 6],
  ["let x = foo bar", "expected a line break or ';' before 'bar'", 1, 13],
  ["await fetch()", "expected a line break or ';' before 'fetch'; Norn has no 'await': a built-in that waits suspends the program by itself", 1, 7],
  ["while ok {}", "expected a line break or ';' before 'ok'; Norn has no loops: repeat with recursion, or with forEach over a stream", 1, 7],
  ["return x", "expected a line break or ';' before 'x'; Norn has no 'return': a function's value is its last expression, and postfix ? returns early", 1, 8],
  ["toString x", "expected a line break or ';' before 'x'", 1, 10],
  ["let = 1", "expected a pattern, found '='", 1, 5],
  ["let x 1", "expected '=' after the pattern of 'let', found '1'", 1, 7],
  ["let x: int = 1", "type annotations are not part of Norn v0: types are inferred (spec §4)", 1, 6],
  ["let x = 1 and y = 2", "'and' can only join the functions of a 'let rec'", 1, 11],
  ["let rec x = 1", "'let rec' binds functions only: write 'let rec x = (…) => …'", 1, 13],
  ["let rec = 1", "expected a function name after 'let rec', found '='", 1, 9],
  ["let f = (a=1) => a", "only a labelled parameter can have a default, as in ~on=[]", 1, 11],
  ["let f = (~until=?) => until", "optional parameters without a default ('~x=?') are not part of Norn v0: give a default, as in ~on=[]", 1, 17],
  ["f(~until=?)", "optional arguments ('~x=?') are not part of Norn v0", 1, 10],
  ["f(~)", "expected a label name after '~', found ')'", 1, 4],
  ["type Probe = A | B", "type names start with a lowercase letter: write 'type probe = …'", 1, 6],
  ["type t = a | b", "expected a line break or ';' before '|'", 1, 12],
  ["type t = | a", "expected a constructor name, which starts with an uppercase letter, found 'a'", 1, 12],
  ["type t = A()", "a constructor without a payload takes no parentheses: write A", 1, 12],
  ["type t int", "expected '=' after the type name 't', found 'int'", 1, 8],
  ["type t = (~a: int)", "a labelled type such as ~until: duration is only allowed among the parameters of a function type, which '=>' follows", 1, 11],
  ["type t = ~a: int", "a labelled type such as ~until: duration is only allowed among the parameters of a function type", 1, 10],
  ["type t = (~a: int=1) => unit", "expected '?' after '=' in a labelled parameter type, as in ~a: duration=?, found '1'", 1, 19],
  ["type t = (~a int) => unit", "expected ':' after the label '~a', as in ~a: duration, found 'int'", 1, 14],
  ["type t = (int,", "expected ')' to close the '(' at 1:10, found end of file", 1, 15],
  ["type t = (int) =>", "expected a type, found end of file", 1, 18],
  ["external f", "expected ':' after 'f': an external declares its type, as in external merged: (string) => event<pr>, found end of file", 1, 11],
  ["external f = 1", "expected ':' after 'f': an external declares its type, as in external merged: (string) => event<pr>, found '='", 1, 12],
  ["{ external f: int }", "an external declaration is only allowed at the top level of a host interface file", 1, 3],
  ["type t = ()", "write 'unit' for the unit type", 1, 11],
  ["type t = {}", "a record type needs at least one field", 1, 10],
  ["type t<a> = A", "expected a type variable such as 'a, found 'a'", 1, 8],
  ["f(type t = A)", "expected an expression, found 'type'", 1, 3],
  ["{ type t = A }", "a type declaration is only allowed at the top level of a program", 1, 3],
  ["{ open Std }", "'open' is only allowed at the top level of a program", 1, 3],
  ["open Belt", "only 'open Std' exists in v0: there is no module Belt", 1, 6],
  ["open std", "expected a module name after 'open', found 'std'", 1, 6],
  ["Std.map(xs, f)", "qualified names such as Std.map are not part of Norn v0; 'open Std' brings the standard library into scope", 1, 4],
  ["Foo()", "a constructor without a payload takes no parentheses: write Foo", 1, 5],
  ["Done(~x=1)", "the arguments of a constructor cannot be labelled", 1, 6],
  ["x->Some", "expected a function name after '->', found 'Some'", 1, 4],
  ['@auto("acme/api")', 'arguments of a participant must be labelled, as in @auto(~repo="acme/api")', 1, 7],
  ["[...xs, y]", "a '...' spread must be the last element of a list", 1, 9],
  ["{a: 1, ...base}", "a record spread must come first, as in {...base, field: value}", 1, 8],
  ["{...base a: 1}", "expected ',' or '}' after the spread, found 'a'", 1, 10],
  ["(a,)", "a tuple needs at least two elements", 1, 1],
  ["let f = _", "'_' can only be used as a pattern, not as a value", 1, 9],
  ["let t = 'a", "type variables such as 'a can only appear in type declarations", 1, 9],
  ["if x 1", "expected '{' after the condition of 'if', found '1'", 1, 6],
  ["if x { 1 } else 2", "expected '{' or 'if' after 'else', found '2'", 1, 17],
  ["switch x { }", "expected '|' to start the first case of the switch, found '}'", 1, 12],
  ["switch x | A => 1", "expected '{' after the value of 'switch', found '|'", 1, 10],
  ["switch x { | A => }", "expected an expression after '=>', found '}'", 1, 19],
  ["switch x { | `a` => 1 }", "a template string cannot be a pattern: use a plain string", 1, 14],
  ["switch x { | @alice => 1 }", "only strings, numbers, booleans and () can be matched as literals; compare others with == in a guard", 1, 14],
  ["switch x { | -y => 1 }", "expected a number after '-' in a pattern, found 'y'", 1, 15],
  ["switch x { | [a, ...b, c] => 1 }", "a '...' rest must be the last element of a list pattern", 1, 24],
  ["switch x { | {} => 1 }", "a record pattern needs at least one field", 1, 14],
  ["switch x { | (a,) => 1 }", "a tuple pattern needs at least two elements", 1, 14],
  ["`a ${} b`", "expected an expression inside '${…}'", 1, 6],
  ["`a ${x y} b`", "expected '}' to end the interpolation, found 'y'", 1, 8],
  ["f(x", "expected ')' to close the '(' at 1:2, found end of file", 1, 4],
  [")", "expected an expression, found ')'", 1, 1],
];

test("syntax errors say what was expected, and where", () => {
  for (const [source, message, line, column] of cases) {
    const [first] = parseErrors(source);
    assert.deepEqual([first!.message, first!.span.start.line, first!.span.start.column], [message, line, column], source);
  }
});

test("a diagnostic reads as message, file, line and column, then the source line", () => {
  const source = [
    "type probe = Ship | Drop",
    "",
    'switch ask(@alice, "Ship?", ~options=[Ship, Drop]) {',
    '| Done(Drop) run(@auto, "Record the decision")',
    "| _ => ()",
    "}",
  ].join("\n");
  const [diagnostic] = parseErrors(source);
  assert.equal(diagnosticLine(diagnostic!, "examples/decide.norn"), "expected '=>' after pattern, found 'run' at examples/decide.norn:4:14");
  assert.equal(
    formatDiagnostic(diagnostic!, source, "examples/decide.norn"),
    [
      "error: expected '=>' after pattern, found 'run' at examples/decide.norn:4:14",
      ` 4 | | Done(Drop) run(@auto, "Record the decision")`,
      "   |              ^^^",
    ].join("\n"),
  );
});

test("the caret lines up under tabs and wide characters", () => {
  const source = '\tsay("😀", x y)';
  const [diagnostic] = parseErrors(source);
  assert.equal(diagnostic!.span.start.column, 13);
  assert.equal(
    formatDiagnostic(diagnostic!, source, "f.norn"),
    ["error: expected ',' or ')' after an argument, found 'y' at f.norn:1:13", ' 1 | \tsay("😀", x y)', " 1 | ".replace("1", " ") + "\t           ^"].join("\n"),
  );
});

test("an error at the end of the file points just past the last character", () => {
  const source = "let x = f(1,\n";
  const [diagnostic] = parseErrors(source);
  assert.equal(
    formatDiagnostic(diagnostic!, source, "f.norn"),
    ["error: expected ')' to close the '(' at 1:10, found end of file at f.norn:2:1", " 2 | ", "   | ^"].join("\n"),
  );
});
