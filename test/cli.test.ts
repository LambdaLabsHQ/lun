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

test("norn check accepts the examples, the standard library and the reference host", () => {
  const result = norn(["check", "examples", "std/std.norn", "hosts"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "examples/decide.norn: ok",
    "examples/follow-up.norn: ok",
    "examples/push.norn: ok",
    "examples/release-chain.norn: ok",
    "examples/standing-duty.norn: ok",
    "std/std.norn: ok",
    "hosts/reference.norn: ok (host interface)",
  ]);
});

test("norn check reports type errors and warnings in the parser's style, and exits 1 on an error", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "probe.norn");
  writeFileSync(file, 'type probe = Ship | Skip\nswitch ask(@alice, "Ship?", ~options=[Ship, Skip]) {\n| Done(Ship) => ()\n| Done(_) => ()\n| Done(Skip) => ()\n| TimedOut | Failed(_) => ()\n}\n');
  const result = norn(["check", file]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    [
      `error: this switch does not handle Declined(_), Cancelled or Revoked at ${file}:2:1`,
      ` 2 | switch ask(@alice, "Ship?", ~options=[Ship, Skip]) {`,
      `   | ^^^^^^`,
      "",
      `warning: this case can never match: the cases before it cover every value it matches at ${file}:5:3`,
      ` 5 | | Done(Skip) => ()`,
      `   |   ^^^^^^^^^^`,
      "",
      "",
    ].join("\n"),
  );
  // Warnings alone exit 0.
  writeFileSync(file, 'switch 1 {\n| _ => ()\n| 2 => ()\n}\n');
  const warned = norn(["check", file]);
  assert.equal(warned.status, 0);
  assert.equal(warned.stdout, `${file}: ok\n`);
  assert.match(warned.stderr, /^warning: this case can never match/);
});

test("norn check --json prints each file's diagnostics and effects in one document", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "bad.norn");
  writeFileSync(file, 'say("alice", "hi")\nswitch run(@auto, "x") {\n| Done(_) => ()\n}\n');
  const result = norn(["check", "--json", "examples/decide.norn", file]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.indexOf("\n"), result.stdout.length - 1);
  const document = JSON.parse(result.stdout);
  assert.deepEqual(document.host, { file: "hosts/reference.norn", ok: true, diagnostics: [] });
  assert.deepEqual(document.files[0], {
    file: "examples/decide.norn",
    ok: true,
    diagnostics: [],
    effects: [{ family: "ask", targets: ["@alice"] }, { family: "run", targets: ["@auto"] }],
  });
  const [addressee, missing] = document.files[1].diagnostics;
  assert.deepEqual(addressee, {
    severity: "error",
    code: "not-an-addressee",
    message: "expected participant or ref for the first argument of say, found string",
    span: { start: { line: 1, column: 5, offset: 4 }, end: { line: 1, column: 12, offset: 11 } },
    expected: "participant or ref",
    found: "string",
  });
  assert.deepEqual(missing, {
    severity: "error",
    code: "non-exhaustive",
    message: "this switch does not handle Declined(_), Failed(_), TimedOut, Cancelled or Revoked",
    span: { start: { line: 2, column: 1, offset: 19 }, end: { line: 2, column: 7, offset: 25 } },
    missing: ["Declined(_)", "Failed(_)", "TimedOut", "Cancelled", "Revoked"],
  });
  assert.deepEqual([document.files[1].ok, document.files[1].effects], [false, null]);
  // A syntax error has the code "syntax".
  const syntax = JSON.parse(norn(["check", "--json", "-"], "let = 1\n").stdout);
  assert.deepEqual(syntax.files[0].diagnostics.map((d: { code: string }) => d.code), ["syntax"]);
});

test("norn check --host checks programs against another interface, and refuses a broken one", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "norn-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = join(directory, "tickets.norn");
  writeFileSync(host, "type ticket\nexternal opened: (string) => event<ticket>\n");
  const program = join(directory, "watch.norn");
  writeFileSync(program, 'let t = opened("T-1")->wait?\nsay(@alice, "opened")\n');
  assert.deepEqual(norn(["check", "--host", host, program]), { status: 0, stdout: `${program}: ok\n`, stderr: "" });
  assert.equal(norn(["check", `--host=${host}`, program, host]).stdout, `${program}: ok\n${host}: ok (host interface)\n`);
  // The reference host's facts are not there.
  const other = norn(["check", "--host", host, "examples/release-chain.norn"]);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /^error: unknown name merged; did you mean merge\? at examples\/release-chain\.norn:2:10/);
  // A broken interface is reported, and nothing is checked against it.
  writeFileSync(host, "type ticket\nlet x = 1\n");
  const broken = norn(["check", "--host", host, program]);
  assert.equal(broken.status, 1);
  assert.equal(broken.stdout, "");
  assert.match(broken.stderr, new RegExp(`^error: a host interface file holds only type and external declarations, found a let binding at ${host.replaceAll("\\", "\\\\")}:2:1`));
  assert.equal(norn(["check", "--host"]).stderr, "norn: --host needs an interface file, as in --host hosts/reference.norn\n");
  assert.equal(norn(["check", "--host", "nope.norn", program]).status, 2);
  assert.equal(norn(["check", "--strict", program]).stderr, "norn: unknown option '--strict' for check\n");
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
