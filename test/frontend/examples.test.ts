import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { NODE_FIELDS, astFromJson, astToJson, type AstNode, type Pos } from "../../src/frontend/index.ts";
import { assertNoSharedObjects, parseOk, preorderKinds } from "./helpers.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const norn = (directory: string) =>
  readdirSync(new URL(directory, root))
    .filter((name) => name.endsWith(".norn"))
    .sort()
    .map((name) => `${directory}/${name}`);
const programs = [...norn("examples"), ...norn("std")];

test("the examples and the standard library exist", () => {
  assert.deepEqual(programs, [
    "examples/decide.norn",
    "examples/follow-up.norn",
    "examples/push.norn",
    "examples/release-chain.norn",
    "examples/standing-duty.norn",
    "std/std.norn",
  ]);
});

for (const path of programs) {
  test(`${path} parses to a tree of distinct objects that survives a JSON round trip`, () => {
    const source = read(path);
    const program = parseOk(source);
    assert.ok(program.body.length > 0);
    const roundTrip = astFromJson(astToJson(program));
    assert.deepEqual(roundTrip, program);
    assertNoSharedObjects(program);
    assert.deepEqual(preorderKinds(program), preorderKinds(roundTrip));
    checkPositions(program, source, path);
  });
}

// Set UPDATE_SNAPSHOTS=1 to rewrite the snapshots after an intended change to the tree.
for (const name of ["decide", "push"]) {
  test(`examples/${name}.norn matches its AST snapshot`, () => {
    const actual = astToJson(parseOk(read(`examples/${name}.norn`)));
    const snapshot = `test/frontend/snapshots/${name}.ast.json`;
    if (process.env["UPDATE_SNAPSHOTS"] === "1") writeFileSync(new URL(snapshot, root), actual);
    assert.equal(actual, read(snapshot));
  });
}

test("every norn block in the spec parses", () => {
  const blocks = codeBlocks(read("docs/spec.md"), "norn");
  assert.ok(blocks.length >= 6);
  for (const block of blocks) parseOk(block);
});

test("every code block in the README parses", () => {
  const blocks = codeBlocks(read("README.md"), "rescript");
  assert.ok(blocks.length >= 3);
  for (const block of blocks) parseOk(block);
});

function codeBlocks(markdown: string, language: string): string[] {
  return [...markdown.matchAll(new RegExp("^```" + language + "\\n([\\s\\S]*?)^```", "gm"))].map((match) => match[1]!);
}

/**
 * Every node's line and column agree with its offset, its span lies inside
 * its parent's, and its fields are exactly those NODE_FIELDS lists.
 */
function checkPositions(program: AstNode, source: string, path: string): void {
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") lineStarts.push(index + 1);
  const expected = (offset: number): Pos => {
    let line = lineStarts.length;
    while (lineStarts[line - 1]! > offset) line -= 1;
    const column = [...source.slice(lineStarts[line - 1], offset)].length + 1;
    return { line, column, offset };
  };
  const visit = (node: AstNode, parent: AstNode | null) => {
    const label = `${path}: ${node.kind} at offset ${node.span.start.offset}`;
    assert.deepEqual(Object.keys(node).sort(), ["kind", ...NODE_FIELDS[node.kind], "span"].sort(), label);
    assert.deepEqual(node.span.start, expected(node.span.start.offset), label);
    assert.deepEqual(node.span.end, expected(node.span.end.offset), label);
    assert.ok(node.span.start.offset <= node.span.end.offset, label);
    if (parent !== null) {
      assert.ok(parent.span.start.offset <= node.span.start.offset && node.span.end.offset <= parent.span.end.offset, label);
    }
    for (const field of NODE_FIELDS[node.kind] as readonly string[]) {
      const value = (node as unknown as { [field: string]: unknown })[field];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (typeof child === "object" && child !== null && "kind" in child) visit(child as AstNode, node);
      }
    }
  };
  visit(program, null);
}
