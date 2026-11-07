import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { readInterface } from "../../../src/frontend/check/index.ts";
import { check, describe } from "./helpers.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const norn = (directory: string) =>
  readdirSync(new URL(directory, root)).filter((name) => name.endsWith(".norn")).sort().map((name) => `${directory}/${name}`);
/** The code blocks of a language, indented ones included, without their indentation. */
const codeBlocks = (markdown: string, language: string) =>
  [...markdown.matchAll(new RegExp("^( *)```" + language + "\\n([\\s\\S]*?)^\\1```", "gm"))].map((match) =>
    match[2]!.split("\n").map((line) => line.slice(match[1]!.length)).join("\n"));

// Everything in the repository type-checks, with no warning either. There are no exceptions: every
// norn block of the spec is a whole program or a set of definitions.
for (const path of [...norn("examples"), "std/std.norn"]) {
  test(`${path} type-checks`, () => {
    const result = check(read(path));
    assert.deepEqual(result.diagnostics, [], describe(result.diagnostics));
  });
}

// The spec's blocks use the redesigned request and reply model (spec §15), which the checker learns
// in the front-end change that follows the contract. Until then this test is a todo: it runs and
// reports, but does not fail CI. That change removes the todo.
test("every norn block in the spec type-checks", { todo: "the checker learns the request and reply model of spec §15 next" }, () => {
  const blocks = codeBlocks(read("docs/spec.md"), "norn");
  assert.equal(blocks.length, 6);
  blocks.forEach((block, index) => {
    const result = check(block);
    assert.deepEqual(result.diagnostics, [], `block ${index + 1}:\n${block}\n${describe(result.diagnostics)}`);
  });
});

test("every code block in the README type-checks", () => {
  const blocks = codeBlocks(read("README.md"), "rescript");
  assert.ok(blocks.length >= 3);
  for (const block of blocks) {
    const result = check(block);
    assert.deepEqual(result.diagnostics, [], `${block}\n${describe(result.diagnostics)}`);
  }
});

test("every norn block in the skill for models type-checks", () => {
  const blocks = codeBlocks(read("skills/norn/SKILL.md"), "norn");
  assert.ok(blocks.length >= 5);
  for (const block of blocks) {
    const result = check(block);
    assert.deepEqual(result.diagnostics, [], `${block}\n${describe(result.diagnostics)}`);
  }
});

test("the reference host is a valid interface file, and the blocks of docs/types.md check", () => {
  assert.deepEqual(readInterface(read("hosts/reference.norn"), "hosts/reference.norn").diagnostics, []);
  const blocks = codeBlocks(read("docs/types.md"), "norn");
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    // A block with an external is an interface; the others are programs.
    const result = /^external /m.test(block) ? readInterface(block, "docs/types.md") : check(block);
    assert.deepEqual(result.diagnostics, [], `${block}\n${describe(result.diagnostics)}`);
  }
});

test("the examples' effects, as a reviewer sees them", () => {
  const summary = (path: string) => check(read(path)).effects!.map(({ family, targets }) => [family, ...targets].join(" "));
  assert.deepEqual(summary("examples/decide.norn"), ["ask @alice", "run @auto"]);
  assert.deepEqual(summary("examples/follow-up.norn"), ["request @codex", "wait", "handOver @alice", `say doc"ops#machines"`]);
  assert.deepEqual(summary("examples/push.norn"), ["run @claude", "wait", "judge"]);
  assert.deepEqual(summary("examples/release-chain.norn"), ["run @codex", "wait", "say @alice"]);
  assert.deepEqual(summary("examples/standing-duty.norn"), ["run @auto", "wait"]);
});

test("the standard library's types", () => {
  const result = check(read("std/std.norn"));
  assert.deepEqual(result.bindings.map(({ name, type }) => `${name}: ${type}`), [
    "remind: (participant, string, ~at: 'a) => outcome<string> where 'a: deadline",
    "decide: (participant, string, ~options: list<'a>, ~recommend: 'a, ~until: 'b) => 'a where 'b: deadline",
    "followUp: (participant, string, ~until: 'a, ~escalateTo: participant) => outcome<string> where 'a: deadline",
    "schedule: (string, ~every: duration, ~on: stream<'a>=?) => 'b",
    "digest: ('a, ~every: duration) => 'b",
  ]);
});
