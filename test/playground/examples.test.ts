import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { describeExamples } from "../../playground/src/examples.ts";

test("examples are named by file and described by their leading comment's first sentence", () => {
  const directory = new URL("../../examples/", import.meta.url);
  const files = readdirSync(directory).filter((file) => file.endsWith(".norn")).reverse()
    .map((file) => ({ file, source: readFileSync(new URL(file, directory), "utf8") }));
  const examples = describeExamples(files);
  assert.deepEqual(examples.map((example) => example.name), [...examples.map((example) => example.name)].sort());
  const decide = examples.find((example) => example.name === "decide")!;
  assert.equal(decide.file, "decide.norn");
  assert.equal(decide.summary, "A decision with a declared default.");
  for (const example of examples) assert.match(example.summary, /^[A-Z].*\.$/, example.file);
});

test("a program without a leading comment has no summary", () => {
  assert.deepEqual(describeExamples([{ file: "x.norn", source: "let x = 1\n// later" }]).map((e) => e.summary), [""]);
});
