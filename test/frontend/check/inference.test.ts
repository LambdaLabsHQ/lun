import assert from "node:assert/strict";
import { test } from "node:test";
import { all, message, only, typeOf, types, under } from "./helpers.ts";

test("let generalizes: one binding is used at several types", () => {
  assert.deepEqual(types(`let id = x => x
let a = id(1)
let b = id("s")
let pair = (x, y) => (x, y)
let c = pair(id, 1)`), {
    id: "('a) => 'a",
    a: "int",
    b: "string",
    pair: "('a, 'b) => ('a, 'b)",
    c: "(('a) => 'a, int)",
  });
  // Nested lets generalize too.
  assert.equal(typeOf(`let f = () => {
  let id = x => x
  (id(1), id("s"))
}`, "f"), "() => (int, string)");
  // A parameter is not generalized: inside its function it has one type.
  const source = `let f = g => (g(1), g("s"))`;
  const diagnostic = only(source, "type-mismatch");
  assert.equal(diagnostic.message, "expected int for the first argument of g, found string");
  assert.equal(under(source, diagnostic), `"s"`);
});

test("let rec infers its group together and generalizes after it", () => {
  assert.deepEqual(types(`let rec even = n => if n == 0 { true } else { odd(n - 1) }
and odd = n => if n == 0 { false } else { even(n - 1) }`), { even: "(int) => bool", odd: "(int) => bool" });
  assert.deepEqual(types(`let rec length = xs => switch xs {
| [] => 0
| [_, ...rest] => 1 + length(rest)
}
let a = length([1, 2])
let b = length(["a"])`), { length: "(list<'a>) => int", a: "int", b: "int" });
  assert.equal(typeOf("let rec forever = x => forever(x)", "forever"), "('a) => 'b");
  // Inside its group a function has one type.
  assert.equal(message(`let rec f = x => {
  ignore(f(1))
  f("s")
}`, "type-mismatch"), "expected int for the first argument of f, found string");
  // A plain let is not recursive.
  assert.equal(message("let x = 1\nlet y = y + x", "unknown-name"), "unknown name y");
});

test("labels: defaults may be left out, a punned ~label passes the name, and order does not matter", () => {
  assert.deepEqual(types(`let f = (a, ~b, ~c=1) => a + b + c
let b = 2
let x = f(1, ~b=2)
let y = f(~c=3, ~b=2, 1)
let z = f(1, ~b)
let g = (~every as period, ~on=0) => period + on
let w = g(~every=2)
let h = (x, ~y=x) => y
let v = h("s")`), {
    f: "(int, ~b: int, ~c: int=?) => int",
    b: "int",
    x: "int",
    y: "int",
    z: "int",
    g: "(~every: int, ~on: int=?) => int",
    w: "int",
    h: "('a, ~y: 'a=?) => 'a",
    v: "string",
  });
});

test("a call gives every positional argument and every required label, and only labels the function has", () => {
  const define = "let f = (a, ~b, ~c=1) => a + b + c\n";
  assert.equal(
    message(`${define}ignore(f(1))`, "missing-label"),
    "expected ~b for f, which requires it; its type is (int, ~b: int, ~c: int=?) => int",
  );
  assert.equal(
    message(`${define}ignore(f(1, 2, ~b=1))`, "argument-count"),
    "expected 1 positional argument for f, found 2; its type is (int, ~b: int, ~c: int=?) => int",
  );
  assert.equal(message(`${define}ignore(f(~b=1))`, "argument-count"), "expected 1 positional argument for f, found 0; its type is (int, ~b: int, ~c: int=?) => int");
  assert.equal(message(`${define}ignore(f(1, ~b=1, ~d=2))`, "unknown-label"), "f has no labelled argument ~d; it takes ~b and ~c");
  assert.equal(message(`ignore(run(@alice, "q", ~contxt=1)->wait)`, "unknown-label"), "run has no labelled argument ~contxt; it takes ~context and ~by; did you mean ~context?");
  assert.equal(message(`${define}ignore(f(1, ~b=1, ~b=2))`, "duplicate-label"), "~b is passed twice");
  assert.equal(message("let g = x => x\nignore(g(1, ~b=1))", "unknown-label"), "g has no labelled argument ~b; it takes no labelled arguments");
  // The value before -> counts as the first argument.
  assert.equal(message("let one = () => 1\nignore(2->one)", "argument-count"), "expected 0 positional arguments for one, found 1 (the value before -> is the first); its type is () => int");
  assert.equal(message("let x = 1\nignore(x(2))", "not-a-function"), "expected a function for x, found int");
});

test("a function passed as a value unifies with its whole type, labels included", () => {
  const define = "let apply = f => f(1, ~until=1h)\n";
  assert.equal(typeOf(define, "apply"), "((int, ~until: duration) => 'a) => 'a");
  assert.equal(typeOf(`${define}let g = (x, ~until) => x\nlet a = apply(g)`, "a"), "int");
  assert.equal(
    message(`${define}let h = (x, ~until=2h) => x\nlet b = apply(h)`, "type-mismatch"),
    "expected (int, ~until: duration) => 'a for the first argument of apply, found ('b, ~until: duration=?) => 'b: ~until is optional in one and required in the other",
  );
  assert.equal(
    message(`${define}let c = apply(x => x)`, "type-mismatch"),
    "expected (int, ~until: duration) => 'a for the first argument of apply, found ('b) => 'b: only one of them takes ~until",
  );
});

test("a pipe passes the value on its left first", () => {
  assert.deepEqual(types(`let sub = (a, b) => a - b
let x = 10->sub(3)
let y = 1->show
let z = (1, 2)->(((a, b)) => a + b)`), { sub: "(int, int) => int", x: "int", y: "string", z: "int" });
  const source = `let sub = (a, b) => a - b\nlet x = "ten"->sub(3)`;
  const diagnostic = only(source, "type-mismatch");
  assert.equal(diagnostic.message, "expected int for the first argument of sub (the value before ->), found string");
  assert.equal(under(source, diagnostic), `"ten"`);
});

test("a default value sees the parameters before it, never a labelled one after it", () => {
  assert.equal(typeOf("let x = 1\nlet f = (~x=x) => x\nlet y = f()", "y"), "int");
  assert.equal(
    message("let f = (~a=b, ~b=1) => a", "later-parameter"),
    "this default value cannot use b: it is the labelled parameter ~b, declared later, which is bound only when a caller passes it",
  );
  // ? in a default returns from the function whose parameter it is.
  assert.equal(typeOf(`let f = (~r=run(@auto, "x")->wait?) => Answered(r.text)`, "f"), "(~r: report=?) => reply<string>");
});

test("names: unknown ones suggest a close name, or open Std", () => {
  assert.equal(message("let value = 1\nignore(valu + 1)", "unknown-name"), "unknown name valu; did you mean value?");
  assert.equal(
    message(`ignore(remind(@alice, "x", ~at=1h))`, "unknown-name"),
    "unknown name remind; remind is in the standard library: add open Std at the top of the program",
  );
  assert.equal(message("let f = (x, x) => x", "duplicate-binding"), "x is bound twice in these parameters");
  assert.equal(message("let f = (~a, ~a) => a", "duplicate-label"), "the label ~a appears twice in these parameters");
});

test("constructors: arity, unknown names and built-in variants", () => {
  assert.deepEqual(types("let a = Some(1)\nlet b = None\nlet c = Ok(1)\nlet d = Error(\"e\")"), {
    a: "option<int>", b: "option<'a>", c: "result<int, 'a>", d: "result<'a, string>",
  });
  assert.equal(message("ignore(Answered(1, 2))", "constructor-arity"), "expected 1 argument for Answered, found 2: it is written Answered('a)");
  assert.equal(message("ignore(Some)", "constructor-arity"), "expected 1 argument for Some, found 0: it is written Some('a)");
  assert.equal(message("ignore(NoReply(1))", "constructor-arity"), "expected no arguments for NoReply, found 1: it is written NoReply");
  assert.equal(message("ignore(Answerd(1))", "unknown-constructor"), "unknown constructor Answerd; did you mean Answered?");
  assert.equal(message("type t = Later(duration)\nignore(Later(1))", "type-mismatch"), "expected duration for the argument of Later, found int");
});

test("if: a bool condition, one type for every branch, and () without else", () => {
  assert.deepEqual(types("let a = if true { 1 } else if false { 2 } else { 3 }\nlet b = if true { () }"), { a: "int", b: "unit" });
  assert.deepEqual(all(`let a = if 1 { 2 } else { 3 }
let b = if true { 1 } else { "s" }
let c = if true { 1 }
let d = if judge("x") { () }
let e = if judge("x")->wait { () }`), [
    ["type-mismatch", "expected bool for the condition of if, found int", 1, 12],
    ["type-mismatch", "expected int, like the first branch of this if, found string: every branch of an if returns one type", 2, 30],
    ["type-mismatch", "expected unit from a branch of an if without else, found int: such an if is () when its condition is false; add an else branch", 3, 19],
    ["type-mismatch", "expected bool for the condition of if, found request<bool>; this is a request: wait for its reply with ->wait", 4, 12],
    ["type-mismatch", "expected bool for the condition of if, found reply<bool>; take the value out of the reply with ? or switch", 5, 12],
  ]);
});

test("arithmetic is not overloaded, and the message says which operator fits", () => {
  assert.deepEqual(types("let a = 1 + 2 * 3 / 4 - 5\nlet b = 1.5 *. 2.0 -. 0.5\nlet c = \"a\" ++ \"b\"\nlet d = !true || false && true\nlet e = -1\nlet f = -.1.5"), {
    a: "int", b: "float", c: "string", d: "bool", e: "int", f: "float",
  });
  assert.deepEqual(all("ignore(1 + 1.5)\nignore(1.5 +. 1)\nignore(\"a\" + 1)\nignore(1 ++ \"a\")\nignore(!1)"), [
    ["type-mismatch", "expected int for the right operand of +, found float; + takes ints: use +. for floats", 1, 12],
    ["type-mismatch", "expected float for the right operand of +., found int; +. takes floats: write a float literal such as 1.0, or use + for ints", 2, 15],
    ["type-mismatch", "expected int for the left operand of +, found string; use ++ to join strings", 3, 8],
    ["type-mismatch", "expected string for the left operand of ++, found int; turn a value into text with show(x)", 4, 8],
    ["type-mismatch", "expected bool for the operand of !, found int", 5, 9],
  ]);
});

test("templates interpolate strings; lists and switch cases have one type", () => {
  assert.equal(typeOf("let a = `n = ${1->show}`", "a"), "string");
  assert.equal(message("ignore(`n = ${1}`)", "type-mismatch"), "expected string in a template interpolation, found int; turn a value into text with ${x->show}");
  assert.equal(typeOf("let a = [1, ...[2, 3]]", "a"), "list<int>");
  assert.equal(message(`ignore([1, "a"])`, "type-mismatch"), "expected int, like the elements before it, found string: a list holds values of one type");
  assert.equal(message("ignore([1, ...2])", "type-mismatch"), "expected list<int> for the list after ..., found int");
  assert.equal(
    message(`ignore(switch 1 { | 1 => "a" | _ => 2 })`, "type-mismatch"),
    "expected string, like the cases before it, found int: every case of a switch returns one type",
  );
});

test("records are nominal: a literal has the type with exactly its fields, and access follows the type", () => {
  assert.deepEqual(types(`type box<'a> = {value: 'a, label: string}
let b = {value: 1, label: "x"}
let v = b.value + 1
let c = {...b, value: 2}
let label = x => x.label
let n = label({value: "s", label: "y"})`), {
    b: "box<int>", v: "int", c: "box<int>", label: "(box<'a>) => string", n: "string",
  });
  // While the type of x is unknown, x.f comes from the latest declared record type with a field f.
  assert.equal(typeOf("type a = {f: int}\ntype b = {f: string}\nlet g = x => x.f", "g"), "(b) => string");
  // The host's records are declared first.
  assert.equal(typeOf("let version = r => r.version", "version"), "(release) => string");
  assert.equal(typeOf("let r = {version: \"1.2\"}", "r"), "release");
});

test("records: unknown fields, missing fields and duplicates are errors", () => {
  const box = `type box = {value: int, label: string}\n`;
  const missing = only(`${box}ignore({value: 1})`, "missing-field");
  assert.equal(missing.message, "expected the fields value and label of box, found only value: a record literal gives every field of its type, so add label: string");
  assert.deepEqual([missing.expected, missing.found, missing.missing], ["{value: int, label: string}", "{value}", ["label: string"]]);
  assert.equal(message(`${box}ignore({value: 1, label: "x", extra: 2})`, "unknown-field"), "unknown field extra: no record type has it");
  assert.equal(message(`${box}let b = {value: 1, label: "x"}\nignore(b.lebel)`, "unknown-field"), "the type box has no field lebel; its fields are value and label; did you mean label?");
  assert.equal(message(`${box}let b = {value: 1, label: "x"}\nignore({...b, colour: 1})`, "unknown-field"), "the type box has no field colour; its fields are value and label");
  assert.equal(message(`${box}let b = {value: 1, label: "x"}\nignore({...b, label: 3})`, "type-mismatch"), "expected string for the field label of box, found int");
  assert.equal(message(`${box}ignore({value: 1, value: 2, label: "x"})`, "duplicate-field"), "the field value is given twice");
  assert.equal(message("ignore(x => x.nowhere)", "unknown-field"), "unknown field nowhere: no record type has it");
  assert.equal(message("ignore(run(@auto, \"x\").text)", "type-mismatch"), "expected a record with the field text, found request<report>; wait for the request first, with ->wait");
  assert.equal(message("ignore(run(@auto, \"x\")->wait.text)", "type-mismatch"), "expected a record with the field text, found reply<report>; take the value out first, with ? or switch");
  assert.equal(message("type r = {f: int, f: string}", "duplicate-field"), "the field f is declared twice in r");
});

test("type declarations may refer to each other in any order; aliases may not refer to themselves", () => {
  assert.deepEqual(types(`type tree<'a> = Leaf | Node(forest<'a>, 'a)
type forest<'a> = list<tree<'a>>
let rec size = t => switch t {
| Leaf => 0
| Node(children, _) => 1 + sizes(children)
}
and sizes = ts => switch ts {
| [] => 0
| [first, ...rest] => size(first) + sizes(rest)
}
let s = size(Node([Leaf], "x"))`), { size: "(tree<'a>) => int", sizes: "(list<tree<'a>>) => int", s: "int" });
  assert.equal(message("type t = list<t>", "cyclic-type"), "the type alias t refers to itself; declare a variant instead, as in type t = T(…)");
  assert.equal(message("type a = b\ntype b = (a, int)", "cyclic-type"), "the type alias a refers to itself; declare a variant instead, as in type a = A(…)");
  assert.equal(message("type t = A(foo)", "unknown-type"), "unknown type foo");
  assert.equal(message("type t = A(strng)", "unknown-type"), "unknown type strng; did you mean string?");
  assert.equal(message("type t = A(source<int>)", "unknown-type"), "unknown type source; write event<…>, stream<…> or request<…>");
  assert.equal(message("type t = A(list<int, int>)", "type-arity"), "expected 1 type argument for list, found 2, as in list<'a>");
  assert.equal(message("type t = A(int<string>)", "type-arity"), "expected no type arguments for int, found 1");
  assert.equal(message("type t = A('a)", "unknown-type-variable"), "the type variable 'a is not a parameter of t; declare it, as in type t<'a>");
  assert.equal(message("type t<'a, 'a> = A('a)", "duplicate-type-parameter"), "the type parameter 'a is listed twice");
  // Function types are ordinary types in a program's declarations.
  assert.deepEqual(types(`type job = {name: string, action: () => reply<report>}
let j = {name: "check", action: () => run(@auto, "check")->wait}
let r = j.action()
switch r {
| Answered(_) => ()
| other => fail(other)
}`), { j: "job", r: "reply<report>" });
});

test("a duplicate type or constructor name is an error: both are global", () => {
  assert.equal(message("type t = A | B\ntype u = B | C", "duplicate-constructor"), "the constructor B is already declared by the type t at 1:1; constructors are global, so choose another name");
  assert.equal(message("type t = Answered(int)", "duplicate-constructor"), "the constructor Answered is already declared by the type reply as a built-in; constructors are global, so choose another name");
  assert.equal(message("type t = Yes | Maybe", "duplicate-constructor"), "the constructor Yes is already declared by the type yesno as a built-in; constructors are global, so choose another name");
  assert.equal(message("type phase = Beta | Gamma", "duplicate-constructor"), "the constructor Beta is already declared by the type channel by the host interface; constructors are global, so choose another name");
  assert.equal(message("type t = A\ntype t = B", "duplicate-type"), "the type t is already declared at 1:1; type names are global, so choose another name");
  assert.equal(message("type option<'a> = Nothing", "duplicate-type"), "the type option is built in; choose another name");
  assert.equal(message("type pr = PR", "duplicate-type"), "the type pr is already declared by the host interface; type names are global, so choose another name");
});

test("let rec: a recursive call may leave out a label with a default, and a missing label is blamed on the call", () => {
  assert.equal(typeOf("let rec loop = (~n=3) => if n == 0 { () } else { loop(~n=n - 1) }\nlet x = loop()", "loop"), "(~n: int=?) => unit");
  assert.deepEqual(types("let rec ping = (~n=3) => if n == 0 { 0 } else { pong(~n=n - 1) }\nand pong = (~n) => ping(~n)"), {
    ping: "(~n: int=?) => int", pong: "(~n: int) => int",
  });
  const source = "let rec count = (~from, ~to) => if from > to { () } else { count(~from=from + 1) }";
  const diagnostic = only(source, "missing-label");
  assert.equal(diagnostic.message, "expected ~to for count, which requires it; its type is (~from: int, ~to: int) => 'a");
  assert.equal(under(source, diagnostic), "count(~from=from + 1)");
});

test("a program may declare its own type named source", () => {
  assert.equal(typeOf("type source = Github | Slack\nlet x = switch Github {\n| Github => 1\n| Slack => 2\n}", "x"), "int");
  assert.equal(
    message("type source<'k, 'a> = Src('k, 'a)\nlet o = wait(Src(1, 2))\nfail(o)", "type-mismatch"),
    "expected (event|stream|request)<'a> for the first argument of wait, found source<int, int>",
  );
});

test("hints for the likeliest mistakes: a missing ?, a missing rec, and a swapped letter", () => {
  assert.equal(
    message(`let pr = ask(@a, "Which?")->wait\nignore(say(@a, pr))`, "type-mismatch"),
    "expected string for the second argument of say, found reply<string>; take the value out of the reply with ? or switch",
  );
  assert.equal(
    message("let loop = n => if n == 0 { () } else { loop(n - 1) }", "unknown-name"),
    "unknown name loop; a let is not recursive: write let rec loop = … to use loop in its own definition",
  );
  assert.equal(message("let value = 1\nignore(valeu + 1)", "unknown-name"), "unknown name valeu; did you mean value?");
  // A misspelt label is one error, not also a missing one.
  assert.equal(message("let f = (~until) => until\nignore(f(~untill=1h))", "unknown-label"), "f has no labelled argument ~untill; it takes ~until; did you mean ~until?");
  // A constructor used without its argument is one error, not also a bad call.
  assert.equal(message("let f = Some\nignore(f(1))", "constructor-arity"), "expected 1 argument for Some, found 0: it is written Some('a)");
});
