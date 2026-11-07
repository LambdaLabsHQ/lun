import assert from "node:assert/strict";
import { test } from "node:test";
import { check, describe } from "./helpers.ts";

/** The effects summary as "family: targets" lines. */
function effects(source: string): string[] {
  const result = check(source);
  assert.ok(result.ok, describe(result.diagnostics));
  return result.effects!.map(({ family, targets }) => `${family}:${targets.length === 0 ? "" : ` ${targets.join(" ")}`}`);
}

test("the families a program performs, and the participant and ref literals they target", () => {
  assert.deepEqual(effects(`let q = request(@codex, "Is the build machine still overheating?")
let reply = switch q->wait(~until=1h) {
| TimedOut => q->handOver(@alice)->wait
| other => other
}
say(doc"ops#machines", reply?)`), ["request: @codex", "wait:", "handOver: @alice", "say: doc\"ops#machines\""]);
  assert.deepEqual(effects(`let r = start(@codex:2, "x")
cancel(r)
let j = judge("ok")?
ignore((j, ask(@alice, "q")))`), ["ask: @alice", "start: @codex:2", "cancel:", "judge:"]);
  // forEach waits for each occurrence.
  assert.deepEqual(effects(`every(1d)->forEach(_ => run(@auto, "Check production health"))`), ["run: @auto", "wait:"]);
  // A pure program performs nothing.
  assert.deepEqual(effects("let x = 1 + 2\nshow(x)"), []);
});

test("targets flow through the parameters of named functions, their defaults, and recursion", () => {
  assert.deepEqual(effects(`let tell = (who, text) => say(who, text)
let ping = () => tell(@bob, "ping")
let rec loop = who => {
  tell(who, "again")
  loop(@carol)
}
ping()`), ["say: @bob @carol"]);
  assert.deepEqual(effects(`let notify = (~to=@ops, text) => say(to, text)\nnotify("x")`), ["say: @ops"]);
  // A target that is not a literal is not shown; the family still is.
  assert.deepEqual(effects(`let pick = list => switch list {\n| [first, ..._] => first\n| [] => @auto\n}\nignore(run([@a]->pick, "x"))`), ["run:"]);
  // Code that is never called still counts: it is part of the program.
  assert.deepEqual(effects(`let unused = () => ask(@nobody, "never called")\n()`), ["ask: @nobody"]);
  // Through the branches of an if or a switch, and another name for a function.
  assert.deepEqual(effects(`say(if true { @a } else { @b }, "x")`), ["say: @a @b"]);
  assert.deepEqual(effects(`let tell = who => say(who, "hi")\nlet greet = tell\ngreet(@alice)`), ["say: @alice"]);
  // A function passed as a value may be called anywhere.
  assert.deepEqual(effects(`let tell = t => say(@alice, t->show)\nevery(1d)->forEach(tell)`), ["wait:", "say: @alice"]);
});

test("the standard library functions a program calls count, with the literals passed to them", () => {
  assert.deepEqual(effects(`open Std\nremind(@alice, "x", ~at=1h)`), ["ask: @alice", "wait:"]);
  assert.deepEqual(effects(`open Std\nfollowUp(@codex, "?", ~until=1h, ~escalateTo=@alice)`), ["request: @codex", "wait:", "handOver: @alice"]);
  assert.deepEqual(effects(`open Std\ndigest(@alice, ~every=1d)`), ["run: @auto", "wait:"]);
  assert.deepEqual(effects(`type choice = Yes | No\nopen Std\ndecide(@bob, "Ship?", ~options=[Yes, No], ~recommend=Yes, ~until=1d)`), ["ask: @bob"]);
  // Opening Std without calling anything from it adds nothing.
  assert.deepEqual(effects(`open Std\nsay(@alice, "hi")`), ["say: @alice"]);
});

test("a program with errors has no effects summary", () => {
  const result = check(`ask(@alice, 1)`);
  assert.equal(result.ok, false);
  assert.equal(result.effects, null);
});
