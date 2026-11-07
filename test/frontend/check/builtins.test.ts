import assert from "node:assert/strict";
import { test } from "node:test";
import { all, message, only, typeOf, types, under } from "./helpers.ts";

test("? takes the value out of a reply, option or result, and the function returns the same family", () => {
  assert.deepEqual(types(`let o = () => {
  let r = run(@auto, "x")->wait?
  Answered(r.text)
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
    o: "() => reply<string>",
    p: "() => option<int>",
    q: "() => result<int, 'a>",
    e: "() => result<'a, string>",
  });
  // While the family is unknown, it is taken to be reply.
  assert.equal(typeOf("let f = r => r?", "f"), "(reply<reply<'a>>) => reply<'a>");
  // At the top of a program ? adds no constraint, in any family.
  assert.deepEqual(types(`let x = run(@auto, "x")->wait?
let y = Some(1)?
let z = Ok(1)?
say(@alice, x.text)`), { x: "report", y: "int", z: "int" });
});

test("? mismatches: the operand's family, and the family the function returns", () => {
  const source = "ignore(1?)";
  const operand = only(source, "try-operand");
  assert.equal(operand.message, "expected a reply, option or result before ?, found int");
  assert.equal(under(source, operand), "1?");
  // ? does not wait.
  assert.equal(
    message(`let r = run(@auto, "x")?\nsay(@alice, r.text)`, "try-operand"),
    "expected a reply, option or result before ?, found request<report>: ? does not wait; wait for the request first, with ->wait?",
  );
  assert.deepEqual(all(`let f = () => {
  let r = run(@auto, "x")->wait?
  r
}`), [[
    "type-mismatch",
    "expected reply<'a> as the result of this function, found report; the ? at 2:11 returns a reply from this function early, so it must return a reply at its end too",
    3,
    3,
  ]]);
  assert.equal(
    message("let f = () => {\n  let x = Some(1)?\n  let y = run(@a, \"x\")->wait?\n  None\n}", "try-return"),
    "? on a reply returns its other cases from the enclosing function, so the function must return reply<'a>, but the ? at 2:11 returns an option from it",
  );
  // A result keeps its error type.
  assert.equal(
    message("let f = () => {\n  let x = Ok(1)?\n  let y = Error(1)?\n  Error(\"s\")\n}", "type-mismatch"),
    "expected result<'a, int> as the result of this function, found result<'a, string>",
  );
  // A forEach handler returns () or a reply, so ? on an option cannot return from it.
  assert.equal(
    message("every(1d)->forEach(_ => {\n  let y = Some(1)?\n  ()\n})", "try-return"),
    "? on an option returns its other cases from the enclosing function, so the function must return option<'a>, but it must return () or a reply, as a forEach handler does",
  );
});

test("every built-in has the signature of docs/types.md §5", () => {
  assert.deepEqual(types(`type probe = Ship | Drop
let a = ask(@alice, "q")
let b = choose(@alice, "q", [Ship, Drop], ~by=1h)
let c = run(@auto, "task", ~context={version: "1"}, ~by=2h)
let d = confirm(@codex, "q", ~by=2026-11-07T12:00Z)
let e = judge("cond", ~about=1)
let f = d->wait
let g = merged("acme/api#1")->wait
let h = ciFailed("acme/api")->wait
let i = cancel(d)
let j = handOver(c, @alice)
let k = status(j)
let l = say(@alice, "x")
let m = a->waitUntil(1h)
let n = now()
let o = show(Ship)
let p = ignore(f)
let q = every(1h)
let r = after(1h)
let s = after(n)
let t = never()
let u = merged("acme/api#1")->waitUntil(n)
let v = ciFailed("acme/api")->or(every(1d))
let w = ciFailed("acme/api")->map(s => s ++ "!")
let x = ciFailed("acme/api")->filter(s => s == "x")
let y = r2 => fail(r2)
let z = every(1d)->forEach(_ => ())
ignore((b, e, g, h, k, m, u))`), {
    a: "request<string>",
    b: "request<probe>",
    c: "request<report>",
    d: "request<yesno>",
    e: "request<bool>",
    f: "reply<yesno>",
    g: "pr",
    h: "string",
    i: "unit",
    j: "request<report>",
    k: "option<reply<report>>",
    l: "unit",
    m: "option<reply<string>>",
    n: "time",
    o: "string",
    p: "unit",
    q: "stream<time>",
    r: "stream<time>",
    s: "stream<time>",
    t: "stream<'a>",
    u: "option<pr>",
    v: "stream<either<string, time>>",
    w: "stream<string>",
    x: "stream<string>",
    y: "(reply<'a>) => 'b",
    z: "'a",
  });
  // Every request verb is an ordinary function, and can be passed as a value.
  assert.equal(typeOf("let f = ask", "f"), "(participant, string, ~by: 'a=?) => request<string> where 'a: deadline");
  assert.equal(typeOf("let w = r => r->wait", "w"), "((event|stream|request)<'a>) => 'a");
});

test("choose: the options are constructors of one variant type", () => {
  assert.equal(typeOf("type probe = Ship | Drop\nlet a = choose(@alice, \"Ship?\", [Ship, Drop])->wait\nignore(a)", "a"), "reply<probe>");
  assert.equal(typeOf("let a = @alice->confirm(\"Ship?\")->wait\nignore(a)", "a"), "reply<yesno>");
  const options = only(`let o = choose(@alice, "q", ["yes", "no"])->wait\nignore(o)`, "choose-options");
  assert.equal(options.message, "expected constructors of one variant type for the options of choose, found list<string>; declare the choices as a type, as in type choice = Ship | Drop");
  assert.equal(message(`let o = choose(@alice, "q", [])->wait\nignore(o)`, "choose-options"), "expected at least one option for choose, found an empty list");
  // Options whose type is not known yet are accepted: a generic helper passes them on.
  assert.equal(typeOf("let pick = (who, options) => choose(who, \"Pick one\", options)", "pick"), "(participant, list<'a>) => request<'a>");
});

test("the first draft's names are gone, each with a hint that names its replacement", () => {
  assert.equal(message(`let q = request(@alice, "q")->wait\nignore(q)`, "unknown-name"), "unknown name request; request was removed: every verb returns a request; use ask and ->wait");
  assert.equal(message(`let q = start(@alice, "q")->wait\nignore(q)`, "unknown-name"), "unknown name start; start was removed: run returns a request; use run and ->wait");
  assert.equal(message(`ignore(every(1d)->merge(every(2d)))`, "unknown-name"), "unknown name merge; merge was removed: a->or(b) keeps both values, as First(x) and Second(y)");
  assert.equal(message(`ignore(Done(1))`, "unknown-constructor"), "unknown constructor Done; Done was removed: a request's answer is Answered(x)");
  assert.equal(
    message(`switch ask(@a, "q")->wait {\n| TimedOut => ()\n| _ => ()\n}`, "unknown-constructor"),
    "unknown constructor TimedOut; TimedOut was removed: a request's own ~by deadline gives NoReply, and a wait that runs out with ->waitUntil gives None",
  );
  assert.equal(
    message(`let r = ask(@a, "q", ~options=[1])->wait\nignore(r)`, "unknown-label"),
    "ask(…, ~options=…) was removed: use choose(who, question, [A, B]), or confirm(who, question) for a yes or a no",
  );
  assert.equal(
    message(`let r = run(@a, "q", ~until=1h)->wait\nignore(r)`, "unknown-label"),
    "~until was removed: a request's own deadline is ~by, as in run(…, ~by=1h); to stop waiting without ending the request, use ->waitUntil(t)",
  );
  assert.equal(
    message(`let r = ask(@a, "q")->wait(~until=1h)\nignore(r)`, "unknown-label"),
    "wait(x, ~until=t) was removed: use x->waitUntil(t), which gives None if t passes first",
  );
  // A program may still bind the old names for itself.
  assert.equal(typeOf("let request = (x) => x\nlet a = request(1)", "a"), "int");
});

test("sources: or, map, filter and forEach take streams; cancel, handOver and status take requests", () => {
  assert.equal(
    message(`ignore(merged("x")->or(every(1d)))`, "type-mismatch"),
    "expected stream<'a> for the first argument of or (the value before ->), found event<pr>",
  );
  assert.equal(message("ignore(every(1d)->cancel)", "type-mismatch"), "expected request<'a> for the first argument of cancel (the value before ->), found stream<time>");
  assert.equal(message("ignore(every(1d)->handOver(@alice)->wait)", "type-mismatch"), "expected request<'a> for the first argument of handOver (the value before ->), found stream<time>");
  assert.equal(message("ignore(status(every(1d)))", "type-mismatch"), "expected request<'a> for the first argument of status, found stream<time>");
  assert.equal(message(`ignore(merged("x")->forEach(_ => ()))`, "type-mismatch"), "expected stream<'a> for the first argument of forEach (the value before ->), found event<pr>");
  assert.equal(message("ignore(wait(1))", "type-mismatch"), "expected (event|stream|request)<'a> for the first argument of wait, found int");
  // or keeps both values, and nesting keeps every value.
  assert.equal(typeOf(`let s = every(1d)->or(ciFailed("acme/api"))->or(prActivity("acme/api#1"))`, "s"), "stream<either<either<time, string>, string>>");
  assert.equal(message(`ignore(ciFailed("x")->filter(s => 1))`, "type-mismatch"), "expected bool as the result of this function, found int");
  assert.equal(message("ignore(fail(Some(1)))", "type-mismatch"), "expected reply<'a> for the first argument of fail, found option<int>");
  assert.equal(message(`ignore(run("auto", "x")->wait)`, "type-mismatch"), "expected participant for the first argument of run, found string");
  // A request where its reply is needed: ->wait is missing.
  assert.equal(
    message(`switch ask(@a, "q") {\n| Answered(t) => say(@a, t)\n| _ => ()\n}`, "type-mismatch"),
    "expected a pattern of type request<string>, found one of type reply<'a>; this is a request: wait for its reply with ->wait",
  );
  assert.equal(message(`say(@a, ask(@a, "q"))`, "type-mismatch"), "expected string for the second argument of say, found request<string>; this is a request: wait for its reply with ->wait");
});

test("report is the host's type, and abstract when the host does not declare it", () => {
  assert.equal(typeOf("let r = run(@auto, \"x\")->wait?\nlet t = r.text", "t"), "string");
});
