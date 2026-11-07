import assert from "node:assert/strict";
import { test } from "node:test";
import { all, check, describe, only, typeOf, under } from "./helpers.ts";

const replyAdvice = "handle it with switch, ? or fail, or write ignore(…) to drop it on purpose";
const requestAdvice = "wait for it with ->wait, hand it over with handOver, return it, or call it off with cancel(…)";

test("a request or a reply used as a statement before the last of its block is an error", () => {
  const source = `run(@auto, "first")\nrun(@auto, "second")->wait`;
  const dropped = only(source, "dropped-request");
  assert.equal(dropped.message, `this request<report> is dropped: only the last statement of a block gives its value; ${requestAdvice}`);
  assert.equal(dropped.found, "request<report>");
  assert.equal(under(source, dropped), `run(@auto, "first")`);
  const reply = only(`run(@auto, "first")->wait\nrun(@auto, "second")->wait`, "dropped-reply");
  assert.equal(reply.message, `this reply<report> is dropped: only the last statement of a block gives its value; ${replyAdvice}`);
  // In a function's block, and in a case body.
  assert.deepEqual(all(`let f = () => {\n  ask(@alice, "q")->wait\n  ()\n}`), [["dropped-reply", `this reply<string> is dropped: only the last statement of a block gives its value; ${replyAdvice}`, 2, 3]]);
  assert.deepEqual(all(`switch Some(1) {\n| Some(_) =>\n  run(@auto, "x")\n  ()\n| None => ()\n}`).map(([code, , line]) => [code, line]), [["dropped-request", 3]]);
  // A block whose value is a reply, used as a statement.
  assert.deepEqual(all(`{ run(@auto, "x")->wait }\n()`).map(([code]) => code), ["dropped-reply"]);
  // A fact's or a stream's value is not a reply: it may be dropped.
  assert.deepEqual(check(`merged("acme/api#1")->wait\nafter(1h)->wait\n()`).diagnostics, []);
});

test("a request as the program's last expression is dropped: nothing waits for it", () => {
  const source = `run(@codex, "Fix the build")`;
  const dropped = only(source, "dropped-request");
  assert.equal(
    dropped.message,
    `this request<report> is the program's last value, so nothing waits for it, and it is cancelled when the program ends; ${requestAdvice}`,
  );
  assert.equal(under(source, dropped), source);
  // A reply there is the program's result.
  assert.deepEqual(check(`run(@codex, "Fix the build")->wait`).diagnostics, []);
  // So is a request a function returns.
  assert.deepEqual(check(`let f = () => run(@codex, "Fix the build")\nf()->wait`).diagnostics, []);
});

test("let _ = e drops a request or a reply, and so does a _ for one inside a let pattern", () => {
  const source = `let _ = ask(@alice, "q")->wait`;
  const dropped = only(source, "dropped-reply");
  assert.equal(dropped.message, `let _ = … drops this reply<string>; ${replyAdvice}`);
  assert.equal(under(source, dropped), "_");
  assert.equal(only(`let _ = ask(@alice, "q")`, "dropped-request").message, `let _ = … drops this request<string>; ${requestAdvice}`);
  assert.equal(only(`let (_, n) = (ask(@alice, "q")->wait, 1)\nignore(n)`, "dropped-reply").message, `this _ drops a reply<string>; ${replyAdvice}`);
});

test("a let that binds a request or a reply to a name never used is an error", () => {
  const source = `let answer = ask(@alice, "q")->wait`;
  const unused = only(source, "unused-reply");
  assert.equal(unused.message, "answer holds a reply<string> that is never used; handle it with switch, ? or fail, or write ignore(answer) to drop it on purpose");
  assert.equal(under(source, unused), "answer");
  assert.equal(
    only(`let q = ask(@alice, "q")`, "unused-request").message,
    "q holds a request<string> that is never used; wait for it with q->wait, hand it over, return it, or cancel(q)",
  );
  assert.equal(only(`let (answer, n) = (ask(@alice, "q")->wait, 1)\nignore(n)`, "unused-reply").message.startsWith("answer holds a reply<string>"), true);
  // A later binding of the same name does not use the first.
  assert.deepEqual(all(`let r = run(@auto, "x")->wait\nlet r = 1\nignore(r)`).map(([code, , line]) => [code, line]), [["unused-reply", 1]]);
});

test("ignore sets a reply aside, never a request", () => {
  const source = `ignore(ask(@alice, "q"))`;
  const dropped = only(source, "dropped-request");
  assert.equal(
    dropped.message,
    "expected a value that is not a request for the first argument of ignore, found request<string>: ignore cannot set a request aside, since nothing would wait for it; wait for it with ->wait, hand it over, return it, or cancel(…) it",
  );
  // A helper that ignores its argument passes the rule on.
  assert.equal(typeOf("let skip = x => ignore(x)", "skip"), "('a) => unit where 'a: ignorable");
  assert.equal(only(`let skip = x => ignore(x)\nskip(run(@auto, "x"))`, "dropped-request").code, "dropped-request");
});

test("waiting, handing over, cancelling, returning, handling, propagating, failing or ignoring is fine", () => {
  for (const source of [
    // A request is waited on, handed over, cancelled or returned.
    `let q = ask(@codex, "q")\nq->handOver(@alice)->wait`,
    `let q = ask(@codex, "q")\ncancel(q)`,
    `let q = ask(@codex, "q")\nswitch q->waitUntil(1h) {\n| Some(r) => r\n| None => q->handOver(@alice)->wait\n}`,
    `let f = () => run(@auto, "x")\nf()->wait`,
    // ignore sets a reply aside on purpose.
    `ignore(run(@auto, "x")->wait)\nrun(@auto, "y")->wait`,
    `let _ = ignore(ask(@alice, "q")->wait)`,
    // ? propagates a reply, switch inspects it, fail ends the program with it.
    `let r = run(@auto, "x")->wait?\nsay(@alice, r.text)`,
    `switch run(@auto, "x")->wait {\n| other => ()\n}`,
    `let o = run(@auto, "x")->wait\nfail(o)`,
    // The last statement is the block's value: a function returns it, a program ends with it.
    `let f = () => run(@auto, "x")->wait\nf()`,
    `let answer = ask(@alice, "q")->wait\nsay(@alice, show(answer))`,
    // A value of another type that holds requests or replies is not one.
    `let xs = [run(@auto, "x")]\n()`,
    `let s = status(ask(@codex, "q"))\n()`,
  ]) {
    const result = check(source);
    assert.deepEqual(result.diagnostics, [], `${source}\n${describe(result.diagnostics)}`);
  }
});

test("a generic function that drops a value cannot be given a request or a reply to drop", () => {
  const each = `let rec each = (xs, f) => switch xs {
| [] => ()
| [x, ...rest] =>
  f(x)
  each(rest, f)
}
`;
  assert.equal(typeOf(`${each}()`, "each"), "(list<'a>, ('a) => 'b) => unit where 'b: discardable");
  const source = `${each}each([@a, @b], who => ask(who, "Approve?"))`;
  const dropped = only(source, "dropped-request");
  assert.equal(
    dropped.message,
    `expected a value that is neither a request nor a reply as the result of this function, found request<string>: a value of this type is dropped at 4:3 without being looked at; ${requestAdvice}`,
  );
  assert.equal(under(source, dropped), `ask(who, "Approve?")`);
  assert.equal(only(`${each}each([@a, @b], who => ask(who, "Approve?")->wait)`, "dropped-reply").code, "dropped-reply");
  // Handled in the callback, it is fine.
  assert.deepEqual(check(`${each}each([@a, @b], who => say(who, "Done"))`).diagnostics, []);
  assert.deepEqual(check(`${each}each([@a, @b], who => ignore(ask(who, "Approve?")->wait))`).diagnostics, []);
  // let _ and an unused let in a generic function too.
  assert.deepEqual(all("let twice = t => {\n  let _ = t()\n  t()\n}\nignore(twice(() => run(@auto, \"x\")->wait))").map(([code, , line]) => [code, line]), [["dropped-reply", 5]]);
  assert.deepEqual(all("let first = t => {\n  let unused = t()\n  ()\n}\nfirst(() => run(@auto, \"x\"))").map(([code, , line]) => [code, line]), [["dropped-request", 5]]);
  // A value the generic function returns or uses is not dropped.
  assert.deepEqual(check("let call = t => t()\nlet r = call(() => run(@auto, \"x\"))->wait?\nsay(@alice, r.text)").diagnostics, []);
});
