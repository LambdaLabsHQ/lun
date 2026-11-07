import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "../../src/frontend/parser.ts";
import type { Program } from "../../src/frontend/ast.ts";
import { text, variant, type Value } from "../../src/runtime/browser.ts";
import { START, Simulation } from "../../playground/src/simulation.ts";
import { tell } from "../../playground/src/story.ts";
import { formatTimeOfDay, plain } from "../../playground/src/words.ts";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const std = tree(read("std/std.norn"));
const HOUR = 3_600_000;
const report = (words: string): Value => ({ type: "record", fields: { text: text(words) } });

function tree(source: string): Program {
  const parsed = parse(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.program;
}

type Source = Extract<Value, { type: "source" }>;

async function start(source: string, pause?: () => Promise<void>): Promise<Simulation> {
  const simulation = await Simulation.start({ program: tree(source), std, pause: pause ?? (() => Promise.resolve()) });
  await simulation.settled();
  return simulation;
}

/** The timeline as "hh:mm sentence" lines. */
function story(simulation: Simulation): string[] {
  return simulation.state.timeline.map((entry) => `${formatTimeOfDay(entry.at)} ${plain(tell(entry).runs)}`);
}

function waiting(simulation: Simulation): string | null {
  const now = simulation.state.waiting;
  return now === null ? null : plain(["Waiting ", ...now.targets, ...now.deadline]);
}

test("decide.norn waits for Alice until its deadline, then takes the declared default", async () => {
  const simulation = await start(read("examples/decide.norn"));
  assert.equal(waiting(simulation), "Waiting for @alice’s answer to “Ship the billing probe?” until 2026-11-07 12:00 UTC");
  const [question] = simulation.state.requests;
  assert.deepEqual([question!.holder, question!.name, question!.awaited, question!.options?.map((o) => (o as { name: string }).name)], ["@alice", "ask", true, ["Ship", "Skip"]]);
  assert.equal(simulation.state.nextDeadline, Date.parse("2026-11-07T12:00Z"));

  // +1 day stops at the deadline on the way, and the program reacts at 12:00.
  await simulation.advance(24 * HOUR);
  assert.equal(simulation.state.now, START + 24 * HOUR);
  const [task] = simulation.state.requests;
  assert.equal(task!.holder, "@auto");
  await simulation.answer(task!.id, report("Shipped for US$0.08"));
  assert.equal(simulation.state.status, "completed");
  assert.deepEqual(story(simulation), [
    "09:00 Asked @alice “Ship the billing probe?”",
    "09:00 Waiting for @alice’s answer to “Ship the billing probe?” until 2026-11-07 12:00 UTC",
    "12:00 Timed out waiting for @alice’s answer to “Ship the billing probe?”",
    "12:00 The question to @alice was withdrawn",
    "12:00 Asked @auto to run “Ship the billing probe as recommended: at most US$0.10”",
    "12:00 Waiting for @auto to finish “Ship the billing probe as recommended: at most US$0.10”",
    "09:00 @auto finished with {text: \"Shipped for US$0.08\"}",
    "09:00 Completed with Done({text: \"Shipped for US$0.08\"})",
  ]);
  simulation.dispose();
});

test("an answer, a refusal and a failure each take their own branch", async () => {
  const skip = await start(read("examples/decide.norn"));
  const [question] = skip.state.requests;
  await skip.answer(question!.id, question!.options![1]!);
  assert.match(skip.state.requests[0]!.text, /^Record the decision/);
  await skip.fail(skip.state.requests[0]!.id, "No access to the billing service");
  assert.equal(skip.state.status, "failed");
  assert.deepEqual(story(skip).slice(-2), [
    "09:00 @auto failed: “No access to the billing service”",
    "09:00 Failed with Failed(\"No access to the billing service\"). The author is told.",
  ]);

  // Declining is not consent: the default applies only on a timeout.
  const declined = await start(read("examples/decide.norn"));
  await declined.decline(declined.state.requests[0]!.id, "Not before the audit");
  assert.equal(declined.state.status, "failed");
  assert.deepEqual(story(declined).slice(-2), [
    "09:00 @alice declined: “Not before the audit”",
    "09:00 Failed with Declined(\"Not before the audit\"). The author is told.",
  ]);
  skip.dispose();
  declined.dispose();
});

test("follow-up.norn hands the same request over after an hour, and posts the answer", async () => {
  const simulation = await start(read("examples/follow-up.norn"));
  const first = simulation.state.requests[0]!;
  assert.deepEqual([first.holder, first.name, first.epoch], ["@codex", "request", 0]);
  await simulation.advanceTo(simulation.state.nextDeadline!);
  const moved = simulation.state.requests[0]!;
  assert.deepEqual([moved.id, moved.holder, moved.epoch], [first.id, "@alice", 1]);
  await simulation.answer(moved.id, text("Yes, it reached 92°C"));
  assert.equal(simulation.state.status, "completed");
  assert.deepEqual(story(simulation).slice(2), [
    "10:00 Timed out waiting for @codex’s answer to “Is the build machine still overheating?”",
    "10:00 Handed the request over from @codex to @alice",
    "10:00 Waiting for @alice’s answer to “Is the build machine still overheating?”",
    "10:00 @alice answered “Yes, it reached 92°C”",
    "10:00 Posted to doc\"ops#machines\" “Yes, it reached 92°C”",
    "10:00 Completed",
  ]);
  simulation.dispose();
});

test("release-chain.norn waits on facts the visitor makes hold, in order", async () => {
  const simulation = await start(read("examples/release-chain.norn"));
  assert.equal(waiting(simulation), "Waiting for merged(\"acme/api#1436\") to hold");
  await simulation.fire(simulation.state.events[0]!.source, text("acme/api#1436"));
  assert.equal(waiting(simulation), "Waiting for released(Beta, ~containing=\"acme/api#1436\") to hold until 2026-11-08 09:00 UTC");
  await simulation.fire(simulation.state.events[0]!.source, { type: "record", fields: { version: text("2.4.0") } });
  assert.equal(waiting(simulation), "Waiting for machineUpdated(~atLeast=\"2.4.0\", ~machine=\"win-builder\") to hold");
  await simulation.fire(simulation.state.events[0]!.source, text("2.4.1"));
  await simulation.answer(simulation.state.requests[0]!.id, report("The long-path fix works"));
  assert.equal(simulation.state.status, "completed");
  simulation.dispose();
});

test("a fact that already holds ends the wait at once; a stream occurrence nobody listens for is lost", async () => {
  const merged: Source = { type: "source", kind: "fact", name: "merged", args: [text("acme/api#1")], labels: {} };
  const fact = await start('after(1h)->wait?\nlet pr = merged("acme/api#1")->wait?\nsay(@alice, "merged")');
  await fact.fire(merged, text("pr"));
  await fact.advance(HOUR);
  assert.equal(fact.state.status, "completed");
  fact.dispose();

  const ciFailed: Source = { type: "source", kind: "stream", name: "ciFailed", args: [text("acme/api")], labels: {} };
  const stream = await start('after(1h)->wait?\nswitch ciFailed("acme/api")->wait(~until=1h) {\n| TimedOut => say(@alice, "no new failure")\n| _ => say(@alice, "a new failure")\n}');
  await stream.fire(ciFailed, text("lint"));
  await stream.advance(2 * HOUR);
  assert.equal(stream.state.status, "completed");
  assert.equal(story(stream).at(-2), "11:00 Told @alice “no new failure”");
  stream.dispose();
});

test("standing-duty.norn reports a failed run to the author and goes on", async () => {
  const simulation = await start(read("examples/standing-duty.norn"));
  assert.equal(waiting(simulation), "Waiting for the next ciFailed(\"acme/api\") or until 2026-11-08 09:00 UTC");
  await simulation.advance(24 * HOUR);
  await simulation.fail(simulation.state.requests[0]!.id, "The disk is full");
  assert.equal(simulation.state.status, "suspended");
  assert.equal(waiting(simulation), "Waiting for the next ciFailed(\"acme/api\") or until 2026-11-09 09:00 UTC");
  await simulation.fire(simulation.state.events[0]!.source, text("lint"));
  assert.equal(simulation.state.requests.length, 1);
  assert.deepEqual(story(simulation), [
    "09:00 Waiting for the next ciFailed(\"acme/api\") or until 2026-11-08 09:00 UTC",
    "09:00 Woke up",
    "09:00 Asked @auto to run “Check production health and fix the riskiest issue”",
    "09:00 Waiting for @auto to finish “Check production health and fix the riskiest issue”",
    "09:00 @auto failed: “The disk is full”",
    "09:00 A forEach handler ended with Failed(\"The disk is full\"). The author is told, and the duty goes on.",
    "09:00 Waiting for the next ciFailed(\"acme/api\") or until 2026-11-09 09:00 UTC",
    "09:00 ciFailed(\"acme/api\") happened, with \"lint\"",
    "09:00 Woke up",
    "09:00 Asked @auto to run “Check production health and fix the riskiest issue”",
    "09:00 Waiting for @auto to finish “Check production health and fix the riskiest issue”",
  ]);
  simulation.dispose();
});

test("push.norn asks the judge, and waits for activity or two hours", async () => {
  const simulation = await start(read("examples/push.norn"));
  await simulation.answer(simulation.state.requests[0]!.id, report("Pushed a fix"));
  assert.equal(simulation.state.requests[0]!.name, "judge");
  await simulation.answer(simulation.state.requests[0]!.id, { type: "bool", value: false });
  assert.equal(waiting(simulation), "Waiting for the next prActivity(\"acme/api#1439\") or until 2026-11-07 11:00 UTC");
  await simulation.fire(simulation.state.events[0]!.source, text("review approved"));
  await simulation.answer(simulation.state.requests[0]!.id, report("Merged and live"));
  await simulation.answer(simulation.state.requests[0]!.id, { type: "bool", value: true });
  assert.equal(simulation.state.status, "completed");
  simulation.dispose();
});

test("the standard library runs from the same text the checker reads", async () => {
  const simulation = await start('open Std\nremind(@alice, "Review #12", ~at=1h)');
  assert.equal(waiting(simulation), "Waiting until 2026-11-07 10:00 UTC");
  await simulation.advance(2 * HOUR);
  assert.equal(waiting(simulation), "Waiting for @alice’s answer to “Review #12”");
  assert.deepEqual(story(simulation).slice(1, 3), ["10:00 Woke up", "10:00 Asked @alice “Review #12”"]);
  simulation.dispose();
});

test("never() waits for nothing but its deadline", async () => {
  const simulation = await start("switch never()->wait(~until=30m) {\n| TimedOut => ()\n| _ => ()\n}");
  assert.equal(waiting(simulation), "Waiting on never() until 2026-11-07 09:30 UTC");
  await simulation.advanceTo(simulation.state.nextDeadline!);
  assert.equal(simulation.state.status, "completed");
  simulation.dispose();
});

test("a program that never waits keeps computing until it is restarted, and the page gets its turns", async () => {
  let turns = 0;
  const simulation = await Simulation.start({
    program: tree("let rec spin = n => spin(n + 1)\nspin(0)"),
    std,
    pause: () => new Promise((resolve) => setTimeout(() => { turns += 1; resolve(); }, 0)),
  });
  while (turns < 3) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(simulation.state.status, "ready");
  assert.equal(simulation.state.computing, true);
  simulation.dispose();
  await simulation.settled();
});

test("a replaced run refuses further moves", async () => {
  const simulation = await start(read("examples/decide.norn"));
  assert.equal(simulation.touched, false);
  await simulation.advance(HOUR);
  assert.equal(simulation.touched, true);
  simulation.dispose();
  await assert.rejects(simulation.advance(HOUR), /restarted/);
});

test("a reply that does not match the declared options is a refusal, never a choice", async () => {
  const simulation = await start(read("examples/decide.norn"));
  await simulation.answer(simulation.state.requests[0]!.id, variant("Later"));
  assert.equal(simulation.state.status, "failed");
  assert.equal(story(simulation).at(-2), "09:00 @alice declined: “Response did not match a declared option”");
  simulation.dispose();
});
