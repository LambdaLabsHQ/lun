import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "src/cli.ts");

function norn(args: string[], input?: string) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", input, maxBuffer: 1 << 30 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("norn help prints the usage", () => {
  const result = norn(["help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: norn <command>/);
  assert.equal(norn([]).stdout, result.stdout);
});

test("an unknown command is a usage error", () => {
  const result = norn(["frobnicate"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^norn: unknown command 'frobnicate'/);
});

test("norn parse prints an outline of the tree", () => {
  const result = norn(["parse", "examples/standing-duty.norn"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const lines = result.stdout.split("\n");
  assert.equal(lines[0], "Program  1:1-5:1");
  assert.ok(lines.includes(`    Pipe  2:1-4:81`));
  assert.ok(lines.includes(`            DurationLiteral amount="1" unit="d"  2:7-2:9`));
});

test("norn parse --json prints the norn-ast document on one line", () => {
  const result = norn(["parse", "--json", "examples/decide.norn"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.indexOf("\n"), result.stdout.length - 1);
  const document = JSON.parse(result.stdout);
  assert.equal(document.format, "norn-ast");
  assert.equal(document.version, 1);
  assert.deepEqual(document.program.body.map((item: { kind: string }) => item.kind), ["TypeDecl", "Switch"]);
});

test("norn parse - reads standard input", () => {
  const result = norn(["parse", "--json", "-"], "say(@alice, `hi`)\n");
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).program.body[0].kind, "Call");
});

test("norn check accepts the examples and the standard library", () => {
  const result = norn(["check", "examples", "std/std.norn"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "examples/decide.norn: ok",
    "examples/follow-up.norn: ok",
    "examples/push.norn: ok",
    "examples/release-chain.norn: ok",
    "examples/standing-duty.norn: ok",
    "std/std.norn: ok",
  ]);
});

test("norn check reports each error with its file, line and column", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const broken = join(directory, "broken.norn");
  writeFileSync(broken, 'let a = 1\nswitch a {\n| 1 say(@alice, "one")\n}\nlet b = )\n');
  const result = norn(["check", broken, "examples/push.norn"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "examples/push.norn: ok\n");
  assert.equal(
    result.stderr,
    [
      `error: expected '=>' after pattern, found 'say' at ${broken}:3:5`,
      ` 3 | | 1 say(@alice, "one")`,
      `   |     ^^^`,
      "",
      `error: expected an expression, found ')' at ${broken}:5:9`,
      ` 5 | let b = )`,
      `   |         ^`,
      "",
      "",
    ].join("\n"),
  );
});

test("unreadable files and bad arguments are usage errors", () => {
  assert.deepEqual(norn(["check", "nope.norn"]).stderr, "norn: cannot read nope.norn: no such file or directory\n");
  assert.equal(norn(["check", "nope.norn"]).status, 2);
  assert.equal(norn(["check"]).status, 2);
  assert.equal(norn(["parse", "a.norn", "b.norn"]).stderr, "norn: parse takes exactly one file\n");
  assert.equal(norn(["parse", "--yaml", "a.norn"]).stderr, "norn: unknown option '--yaml' for parse\n");
  assert.equal(norn(["check", "docs"]).stderr, "norn: no .norn files under docs\n");
});

test("a 10,000-link chain prints, and nesting deeper than the stack is a clean error", () => {
  const chain = norn(["parse", "--json", "-"], `x${"->f".repeat(10_000)}\n`);
  assert.equal(chain.status, 0, chain.stderr);
  assert.equal(JSON.parse(chain.stdout).program.body[0].kind, "Pipe");
  // An outline's indentation grows with depth, so its size grows with the square of the chain's length.
  const outline = norn(["parse", "-"], `x${"->f".repeat(1_000)}\n`);
  assert.equal(outline.status, 0, outline.stderr);
  assert.equal(outline.stdout.split("\n").length, 2_004);

  const deep = norn(["check", "-"], `let x = ${"(".repeat(200_000)}\n`);
  assert.equal(deep.status, 1);
  assert.match(deep.stderr, /^error: the program nests deeper than this implementation's stack can follow at <stdin>:1:\d+\n 1 \| let x = \(/);
  assert.doesNotMatch(deep.stderr, /RangeError|    at /);
});
