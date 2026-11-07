import assert from "node:assert/strict";
import { test } from "node:test";
import { all, message, only, typeOf, types, under } from "./helpers.ts";

test("? takes the value out of an outcome, option or result, and the function returns the same family", () => {
  assert.deepEqual(types(`let o = () => {
  let r = run(@auto, "x")?
  Done(r.text)
}
let p = () => {
  let x = Some(1)?
  Some(x + 1)
}
let q = () => {
  let x = Ok(1)?
  Ok(x)
}
let e = () => {
  let x = Error("bad")?
  Ok(x)
}`), {
    o: "() => outcome<string>",
    p: "() => option<int>",
    q: "() => result<int, 'a>",
    e: "() => result<'a, string>",
  });
  // While the family is unknown, it is taken to be outcome.
  assert.equal(typeOf("let f = r => r?", "f"), "(outcome<outcome<'a>>) => outcome<'a>");
  // At the top of a program ? adds no constraint, in any family.
  assert.deepEqual(types(`let x = run(@auto, "x")?
let y = Some(1)?
let z = Ok(1)?
say(@alice, x.text)`), { x: "report", y: "int", z: "int" });
});

test("? mismatches: the operand's family, and the family the function returns", () => {
  const source = "ignore(1?)";
  const operand = only(source, "try-operand");
  assert.equal(operand.message, "expected an outcome, option or result before ?, found int");
  assert.equal(under(source, operand), "1?");
  assert.deepEqual(all(`let f = () => {
  let r = run(@auto, "x")?
  r
}`), [[
    "type-mismatch",
    "expected outcome<'a> as the result of this function, found report; the ? at 2:11 returns an outcome from this function early, so it must return an outcome at its end too",
    3,
    3,
  ]]);
  assert.equal(
    message("let f = () => {\n  let x = Some(1)?\n  let y = run(@a, \"x\")?\n  None\n}", "try-return"),
    "? on an outcome returns its other cases from the enclosing function, so the function must return outcome<'a>, but the ? at 2:11 returns an option from it",
  );
  // A result keeps its error type.
  assert.equal(
    message("let f = () => {\n  let x = Ok(1)?\n  let y = Error(1)?\n  Error(\"s\")\n}", "type-mismatch"),
    "expected result<'a, int> as the result of this function, found result<'a, string>",
  );
  // A forEach handler returns () or an outcome, so ? on an option cannot return from it.
  assert.equal(
    message("every(1d)->forEach(_ => {\n  let y = Some(1)?\n  ()\n})", "try-return"),
    "? on an option returns its other cases from the enclosing function, so the function must return option<'a>, but it must return () or an outcome, as a forEach handler does",
  );
});

test("every built-in has the signature of docs/types.md §5", () => {
  assert.deepEqual(types(`type choice = Yes | No
let a = ask(@alice, "q")
let b = ask(@alice, "q", ~options=[Yes, No], ~until=1h)
let c = run(@auto, "task", ~context={version: "1"}, ~until=2h)
let d = request(@codex, "q")
let e = start(@codex, "task", ~context=1)
let f = d->wait(~until=1h)
let g = merged("acme/api#1")->wait
let h = ciFailed("acme/api")->wait
let i = cancel(d)
let j = handOver(e, @alice)
let k = status(j)
let l = say(@alice, "x")
let m = judge("cond", ~about=c)
let n = now()
let o = show(Yes)
let p = ignore(a)
let q = every(1h)
let r = after(1h)
let s = after(n)
let t = never()
let u = merge(every(1h), after(2h))
let v = ciFailed("acme/api")->or(every(1d))
let w = ciFailed("acme/api")->map(s => s ++ "!")
let x = ciFailed("acme/api")->filter(s => s == "x")
let y = o2 => fail(o2)
let z = every(1d)->forEach(_ => ())
ignore((b, f, g, h, k, m))`), {
    a: "outcome<string>",
    b: "outcome<choice>",
    c: "outcome<report>",
    d: "request<string>",
    e: "request<report>",
    f: "outcome<string>",
    g: "outcome<pr>",
    h: "outcome<string>",
    i: "unit",
    j: "request<report>",
    k: "option<outcome<report>>",
    l: "unit",
    m: "outcome<bool>",
    n: "time",
    o: "string",
    p: "unit",
    q: "stream<time>",
    r: "stream<time>",
    s: "stream<time>",
    t: "stream<'a>",
    u: "stream<time>",
    v: "stream<unit>",
    w: "stream<string>",
    x: "stream<string>",
    y: "(outcome<'a>) => 'b",
    z: "'a",
  });
});

test("ask: the call decides its type by ~options, and ask is not a value", () => {
  assert.equal(typeOf("type probe = Ship | Drop\nlet a = ask(@alice, \"Ship?\", ~options=[Ship, Drop])\nignore(a)", "a"), "outcome<probe>");
  assert.equal(typeOf("let a = @alice->ask(\"Free text?\")\nignore(a)", "a"), "outcome<string>");
  assert.equal(typeOf("let ask = (x) => x\nlet a = ask(1)", "a"), "int");
  assert.equal(
    message("let f = ask", "ask-not-a-value"),
    "ask cannot be used as a value: its type depends on whether a call passes ~options, so call it directly, as in ask(who, text)",
  );
  const options = only(`let o = ask(@alice, "q", ~options=["yes", "no"])\nignore(o)`, "ask-options");
  assert.equal(options.message, "expected constructors of one variant type for ~options of ask, found list<string>; declare the choices as a type, as in type choice = Yes | No");
  assert.equal(message(`let o = ask(@alice, "q", ~options=[])\nignore(o)`, "ask-options"), "expected at least one option for ask, found an empty list");
  // Options whose type is not known yet are accepted: a generic helper passes them on.
  assert.equal(typeOf("let pick = (who, options) => ask(who, \"Pick one\", ~options)", "pick"), "(participant, list<'a>) => outcome<'a>");
});

test("sources: merge and forEach take streams, cancel, handOver and status take requests", () => {
  assert.equal(
    message(`ignore(merged("x")->merge(every(1d)))`, "type-mismatch"),
    "expected stream<'a> for the first argument of merge (the value before ->), found event<pr>",
  );
  assert.equal(message("ignore(every(1d)->cancel)", "type-mismatch"), "expected request<'a> for the first argument of cancel (the value before ->), found stream<time>");
  assert.equal(message("ignore(every(1d)->handOver(@alice))", "type-mismatch"), "expected request<'a> for the first argument of handOver (the value before ->), found stream<time>");
  assert.equal(message("ignore(status(every(1d)))", "type-mismatch"), "expected request<'a> for the first argument of status, found stream<time>");
  assert.equal(message(`ignore(merged("x")->forEach(_ => ()))`, "type-mismatch"), "expected stream<'a> for the first argument of forEach (the value before ->), found event<pr>");
  assert.equal(message("ignore(wait(1))", "type-mismatch"), "expected (event|stream|request)<'a> for the first argument of wait, found int");
  // merge keeps values of one type; or takes any two streams.
  assert.equal(
    message(`ignore(ciFailed("x")->merge(every(1d)))`, "type-mismatch"),
    "expected stream<string> for the second argument of merge, found stream<time>; merge keeps the values of two streams of one type: to wake on either of two streams, use or",
  );
  assert.equal(typeOf(`let s = every(1d)->or(ciFailed("acme/api"))`, "s"), "stream<unit>");
  assert.equal(message(`ignore(ciFailed("x")->filter(s => 1))`, "type-mismatch"), "expected bool as the result of this function, found int");
  assert.equal(message("ignore(fail(Some(1)))", "type-mismatch"), "expected outcome<'a> for the first argument of fail, found option<int>");
  assert.equal(message(`ignore(run("auto", "x"))`, "type-mismatch"), "expected participant for the first argument of run, found string");
});

test("report is the host's type, and abstract when the host does not declare it", () => {
  assert.equal(typeOf("let r = run(@auto, \"x\")?\nlet t = r.text", "t"), "string");
});
