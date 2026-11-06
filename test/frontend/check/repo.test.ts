import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { checkSource, readInterface } from "../../../src/frontend/check/index.ts";
import { describe } from "./helpers.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const norn = (directory: string) =>
  readdirSync(new URL(directory, root)).filter((name) => name.endsWith(".norn")).sort().map((name) => `${directory}/${name}`);
const codeBlocks = (markdown: string, language: string) =>
  [...markdown.matchAll(new RegExp("^```" + language + "\\n([\\s\\S]*?)^```", "gm"))].map((match) => match[1]!);

// Everything in the repository type-checks, with no warning either. There are no exceptions: every
// norn block of the spec is a whole program or a set of definitions.
for (const path of [...norn("examples"), "std/std.norn"]) {
  test(`${path} type-checks`, () => {
    const result = checkSource(read(path));
    assert.deepEqual(result.diagnostics, [], describe(result.diagnostics));
  });
}

test("every norn block in the spec type-checks", () => {
  const blocks = codeBlocks(read("docs/spec.md"), "norn");
  assert.equal(blocks.length, 6);
  blocks.forEach((block, index) => {
    const result = checkSource(block);
    assert.deepEqual(result.diagnostics, [], `block ${index + 1}:\n${block}\n${describe(result.diagnostics)}`);
  });
});

test("every code block in the README type-checks", () => {
  const blocks = codeBlocks(read("README.md"), "rescript");
  assert.ok(blocks.length >= 3);
  for (const block of blocks) {
    const result = checkSource(block);
    assert.deepEqual(result.diagnostics, [], `${block}\n${describe(result.diagnostics)}`);
  }
});

test("the reference host and the interface in docs/types.md are valid interface files", () => {
  assert.deepEqual(readInterface(read("hosts/reference.norn"), "hosts/reference.norn").diagnostics, []);
  const blocks = codeBlocks(read("docs/types.md"), "norn");
  assert.ok(blocks.length >= 1);
  for (const block of blocks) assert.deepEqual(readInterface(block, "docs/types.md").diagnostics, []);
});

test("the examples' effects, as a reviewer sees them", () => {
  const summary = (path: string) => checkSource(read(path)).effects!.map(({ family, targets }) => [family, ...targets].join(" "));
  assert.deepEqual(summary("examples/decide.norn"), ["ask @alice", "run @auto"]);
  assert.deepEqual(summary("examples/follow-up.norn"), ["request @codex", "wait", "handOver @alice", `say doc"ops#machines"`]);
  assert.deepEqual(summary("examples/push.norn"), ["run @claude", "wait", "judge"]);
  assert.deepEqual(summary("examples/release-chain.norn"), ["run @codex", "wait", "say @alice"]);
  assert.deepEqual(summary("examples/standing-duty.norn"), ["run @auto", "wait"]);
});

test("the standard library's types", () => {
  const result = checkSource(read("std/std.norn"));
  assert.deepEqual(result.bindings.map(({ name, type }) => `${name}: ${type}`), [
    "remind: (participant, string, ~at: 'a) => outcome<string> where 'a: deadline",
    "decide: (participant, string, ~options: list<'a>, ~recommend: 'a, ~until: 'b) => 'a where 'b: deadline",
    "followUp: (participant, string, ~until: 'a, ~escalateTo: participant) => outcome<string> where 'a: deadline",
    "schedule: (string, ~every: duration, ~on: stream<'a>=?) => 'b",
    "digest: ('a, ~every: duration) => 'b",
  ]);
});
