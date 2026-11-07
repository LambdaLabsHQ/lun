import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkSource } from "../../src/frontend/check/index.ts";
import { referenceOptions } from "../../src/frontend/check/node.ts";
import { createChecker, named, problemCount } from "../../playground/src/check.ts";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const check = createChecker(read("hosts/reference.norn"), read("std/std.norn"));

test("the playground reports what norn check reports, from bundled text", () => {
  for (const source of [read("examples/follow-up.norn"), "open Std\nlet c = remind(@bob, \"Look\", ~at=2h)", "switch ask(@alice, \"Ship?\") {\n| Done(x) => x\n}"]) {
    const report = check(source);
    const reference = checkSource(source, referenceOptions());
    assert.deepEqual(report, { ok: reference.ok, diagnostics: reference.diagnostics, effects: reference.effects, bindings: reference.bindings });
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report, "a report crosses to the page as plain data");
  }
});

test("the effects name their participants and references once each", () => {
  const report = check(read("examples/follow-up.norn"));
  assert.deepEqual(named(report.effects!), { participants: ["@alice", "@codex"], refs: ['doc"ops#machines"'] });
});

test("problem counts read as words", () => {
  const span = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } };
  const error = { severity: "error" as const, code: "syntax" as const, message: "x", span };
  const warning = { ...error, severity: "warning" as const, code: "unreachable-case" as const };
  assert.equal(problemCount([]), "no problems");
  assert.equal(problemCount([error]), "1 error");
  assert.equal(problemCount([error, error, warning]), "2 errors and 1 warning");
  assert.equal(problemCount([warning, warning]), "2 warnings");
});
