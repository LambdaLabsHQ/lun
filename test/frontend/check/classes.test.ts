import assert from "node:assert/strict";
import { test } from "node:test";
import { all, message, only, typeOf, types, under } from "./helpers.ts";

test("ordered: < compares int, float, string, time and duration, and a generic comparison keeps the class", () => {
  assert.deepEqual(types(`let le = (a, b) => a <= b
let i = le(1, 2)
let f = le(1.5, 2.5)
let s = le("a", "b")
let t = le(now(), 2026-11-07T12:00Z)
let d = le(1h, 2h)`), { le: "('a, 'a) => bool where 'a: ordered", i: "bool", f: "bool", s: "bool", t: "bool", d: "bool" });
  const ordered = "expected int, float, string, time or duration for the left operand of <, found";
  assert.equal(message("let f = x => x\nignore(f < f)", "not-ordered"), `${ordered} ('a) => 'a: only those have an order`);
  assert.equal(message(`ignore({version: "1"} < {version: "2"})`, "not-ordered"), `${ordered} release: only those have an order`);
  assert.equal(message("ignore(@a > @b)", "not-ordered"), ordered.replace("<", ">") + " participant: only those have an order");
  // Through a generic helper, at its call.
  assert.deepEqual(all("let le = (a, b) => a <= b\nignore(le(Some(1), 2))"), [
    ["not-ordered", "expected int, float, string, time or duration for the first argument of le, found option<int>: only those have an order", 2, 11],
  ]);
  const mixed = only("ignore(1 < \"a\")", "type-mismatch");
  assert.equal(mixed.message, "expected int for the right operand of <, found string: both sides of < have one type");
});

test("equality: == compares every type with no function inside", () => {
  assert.deepEqual(types(`let eq = (a, b) => a == b
let p = eq(@a, @b)
let r = eq(doc"x", doc"y")
let l = eq([Some(1)], [None])
let v = {version: "1"} == {version: "2"}
let q = ask(@a, "x") == ask(@a, "y")`), {
    eq: "('a, 'a) => bool where 'a: equality", p: "bool", r: "bool", l: "bool", v: "bool", q: "bool",
  });
  assert.equal(
    message("let f = x => x\nignore(f == f)", "not-comparable"),
    "expected a type without functions for the left operand of ==, found ('a) => 'a: functions cannot be compared",
  );
  assert.equal(
    message("let xs = [x => x + 1]\nignore(xs != xs)", "not-comparable"),
    "expected a type without functions for the left operand of !=, found list<(int) => int>, which contains the function type (int) => int: functions cannot be compared",
  );
  assert.equal(
    message("type t = {f: (int) => int}\nlet r = {f: x => x}\nignore(r == r)", "not-comparable"),
    "expected a type without functions for the left operand of ==, found t, which holds a function: functions cannot be compared",
  );
  // A parameterized type is comparable when its arguments are.
  assert.equal(typeOf("type box<'a> = Box('a)\nlet b = Box(1) == Box(2)", "b"), "bool");
  assert.equal(
    message("type box<'a> = Box('a)\nlet f = x => x\nignore(Box(f) == Box(f))", "not-comparable"),
    "expected a type without functions for the left operand of ==, found box<('a) => 'a>, which contains the function type ('a) => 'a: functions cannot be compared",
  );
});

test("deadline: ~by, waitUntil and after take a time or a duration, not a string", () => {
  assert.deepEqual(types(`let a = ask(@alice, "q", ~by=1h)->wait
let b = ask(@alice, "q", ~by=2026-11-07T12:00Z)->wait
let w = (x, d) => x->waitUntil(d)
let c = w(merged("acme/api#1"), 1d)
let e = after(2026-11-07T12:00Z)
ignore((a, b, c))`), {
    a: "reply<string>",
    b: "reply<string>",
    w: "((event|stream|request)<'a>, 'b) => option<'a> where 'b: deadline",
    c: "option<pr>",
    e: "stream<time>",
  });
  const source = `ignore(ask(@alice, "q", ~by="tomorrow")->wait)`;
  const diagnostic = only(source, "not-a-deadline");
  assert.equal(diagnostic.message, "expected time or duration for ~by of ask, found string: a deadline is a time, or a duration from now");
  assert.deepEqual([diagnostic.expected, diagnostic.found, under(source, diagnostic)], ["time or duration", "string", `"tomorrow"`]);
  assert.equal(message(`ignore(after("tomorrow"))`, "not-a-deadline"), "expected time or duration for the first argument of after, found string: a deadline is a time, or a duration from now");
  assert.equal(message("ignore(run(@auto, \"x\", ~by=1)->wait)", "not-a-deadline"), "expected time or duration for ~by of run, found int: a deadline is a time, or a duration from now");
  assert.equal(message(`ignore(ask(@a, "q")->waitUntil("soon"))`, "not-a-deadline"), "expected time or duration for the second argument of waitUntil, found string: a deadline is a time, or a duration from now");
  // every takes a duration only.
  assert.equal(message("ignore(every(2026-11-07T12:00Z))", "type-mismatch"), "expected duration for the first argument of every, found time");
});

test("addressee: say goes to a participant or a ref, not a string", () => {
  assert.deepEqual(types(`let tell = who => say(who, "hi")
let a = tell(@alice)
let b = tell(doc"ops#machines")
let c = say(channel"general", "x")`), { tell: "('a) => unit where 'a: addressee", a: "unit", b: "unit", c: "unit" });
  assert.equal(message(`say("alice", "hi")`, "not-an-addressee"), "expected participant or ref for the first argument of say, found string");
  assert.equal(message(`let tell = who => say(who, "hi")\ntell("alice")`, "not-an-addressee"), "expected participant or ref for the first argument of tell, found string");
});

test("handled: a forEach handler returns () or a reply; ignore sets a value aside", () => {
  assert.deepEqual(types(`let a = every(1d)->forEach(_ => ())
let b = every(1d)->forEach(_ => run(@auto, "x")->wait)
let c = every(1d)->forEach(_ => ignore(1))
let d = every(1d)->forEach(t => say(@alice, t->show))`), { a: "'a", b: "'a", c: "'a", d: "'a" });
  const source = "every(1d)->forEach(_ => 1)";
  const diagnostic = only(source, "not-handled");
  assert.equal(
    diagnostic.message,
    "expected () or a reply as the result of this function, found int: a forEach handler returns one of them; wrap a value that does not matter in ignore(…)",
  );
  assert.equal(under(source, diagnostic), "1");
  assert.equal(
    message("let h = t => t\nevery(1d)->forEach(h)", "not-handled"),
    "expected () or a reply for the second argument of forEach, found time, in (time) => time: a forEach handler returns one of them; wrap a value that does not matter in ignore(…)",
  );
  assert.equal(
    message(`every(1d)->forEach(_ => ask(@a, "x"))`, "not-handled"),
    "expected () or a reply as the result of this function, found request<string>: nothing waits for a request a handler returns; wait for it with ->wait",
  );
  // A handler's class is kept by a generic helper, and combines with equality.
  assert.equal(typeOf("let h = x => { ignore(x == x); every(1d)->forEach(_ => x) }", "h"), "('a) => 'b where 'a: handled, equality");
});

test("two classes with no common type conflict", () => {
  assert.deepEqual(all(`let f = d => {
  ignore(after(d))
  say(d, "x")
}`), [[
    "class-conflict",
    "expected a type that is both an addressee (participant or ref) and a deadline (time or duration) for the first argument of say, and no type is both",
    3,
    7,
  ]]);
  // ordered and deadline meet in deadline.
  assert.equal(typeOf("let f = d => { ignore(d < d); after(d) }", "f"), "('a) => stream<time> where 'a: deadline");
});

test("equality: a request compares as a handle, an event or a stream never, and a participant's arguments must compare", () => {
  assert.equal(typeOf("let r = ask(@codex, \"q\")\nlet same = r == r", "same"), "bool");
  assert.equal(
    message("let s = every(1d)->map(t => 1)\nignore(s == s)", "not-comparable"),
    "expected a type without functions for the left operand of ==, found stream<int>: events and streams cannot be compared, since they may hold functions, as map and filter do",
  );
  assert.equal(message("type w = {s: event<pr>}\nlet a = {s: merged(\"x\")}\nignore(a == a)", "not-comparable").startsWith("expected a type without functions for the left operand of ==, found w, which holds a function"), true);
  // A source whose kind is not known yet, once compared, is a request.
  assert.equal(typeOf("let same = (a, b) => a == b\nlet w = x => {\n  ignore(same(x, x))\n  wait(x)\n}", "w"), "(request<'a>) => reply<'a>");
  assert.equal(
    message("let p = @auto(~f=(x => x))\nignore(p == p)", "not-comparable"),
    "expected a type without functions for ~f of a participant, found ('a) => 'a: functions cannot be compared",
  );
});
