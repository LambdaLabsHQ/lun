import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "../../src/frontend/parser.ts";
import { eventKey, type Value } from "../../src/runtime/browser.ts";
import { describe, fieldFor, readHost, sourceValue, valueOf, type Field } from "../../playground/src/host.ts";

const text = readFileSync(new URL("../../hosts/reference.norn", import.meta.url), "utf8");
const parsed = parse(text);
assert.ok(parsed.ok);
const host = readHost(parsed.program, text);
const external = (name: string) => host.externals.find((candidate) => candidate.name === name)!;

test("the forms follow the host interface's external declarations", () => {
  assert.deepEqual(host.externals.map((e) => `${e.name}: ${e.kind}<${describe(e.element)}>`), [
    "merged: fact<pr>", "released: fact<release>", "machineUpdated: fact<string>", "replied: fact<message>", "runEnded: fact<outcome<report>>",
    "ciFailed: stream<string>", "prActivity: stream<string>", "docChanged: stream<string>", "message: stream<message>",
  ]);
  assert.equal(external("merged").doc, "The pull request \"owner/repo#n\" has been merged. The value is the pull request.");
  assert.deepEqual(external("replied").params.map((p) => [p.label, p.optional, describe(p.type)]), [[null, false, "ref"], ["by", true, "participant"]]);
});

test("each type of the reference host has a field", () => {
  const kinds = (field: Field): unknown => {
    switch (field.kind) {
      case "variant":
        return { variant: field.type, constructors: Object.fromEntries(field.constructors.map((c) => [c.name, c.args().map(kinds)])) };
      case "record":
        return { record: field.type, fields: Object.fromEntries(field.fields.map((f) => [f.name, kinds(f.field)])) };
      default:
        return field.kind;
    }
  };
  assert.equal(kinds(fieldFor(external("merged").element, host.types)), "abstract");
  assert.deepEqual(kinds(fieldFor(external("message").element, host.types)), { record: "message", fields: { from: "literal", body: "text" } });
  assert.deepEqual(kinds(fieldFor(external("runEnded").element, host.types)), {
    variant: "outcome<report>",
    constructors: { Done: [{ record: "report", fields: { text: "text" } }], Declined: ["text"], Failed: ["text"], TimedOut: [], Cancelled: [], Revoked: [] },
  });
  assert.deepEqual(kinds(fieldFor(external("released").params[0]!.type, host.types)), { variant: "channel", constructors: { Beta: [], Stable: [] } });
});

test("what is typed becomes the value a program would make, read by Norn's lexer", () => {
  const field = (name: string) => fieldFor(external(name).element, host.types);
  assert.deepEqual(valueOf(field("message"), { fields: { from: "@codex:2", body: "LGTM" } }), {
    ok: true,
    value: { type: "record", fields: { from: { type: "participant", name: "codex", instance: "2", labels: {} }, body: { type: "string", value: "LGTM" } } },
  });
  assert.deepEqual(valueOf(field("message"), { fields: { from: "codex", body: "" } }), { ok: false, message: "from: Write a participant as in @alice" });
  assert.deepEqual(valueOf(field("runEnded"), { choice: "Failed", args: ["Out of disk"] }), { ok: true, value: { type: "variant", name: "Failed", args: [{ type: "string", value: "Out of disk" }] } });
  const literal = (type: "ref" | "time" | "duration", input: string) => valueOf({ kind: "literal", type }, input);
  assert.deepEqual(literal("ref", 'doc"ops#machines"'), { ok: true, value: { type: "ref", kind: "doc", value: "ops#machines" } });
  assert.deepEqual(literal("time", "2026-11-07T20:00+08:00"), { ok: true, value: { type: "time", value: String(Date.parse("2026-11-07T12:00Z")) } });
  assert.deepEqual(literal("duration", "90m"), { ok: true, value: { type: "duration", value: "5400000" } });
  assert.equal(literal("duration", "1.5h").ok, false);
  assert.deepEqual(valueOf({ kind: "number", type: "int" }, "123456789012345678901234567890"), { ok: true, value: { type: "int", value: "123456789012345678901234567890" } });
});

test("a fact fired from the form has the key the program waits on", () => {
  const program = parse('let r = replied(doc"pr#7", ~by=@alice)->wait?');
  assert.ok(program.ok);
  const by = valueOf({ kind: "literal", type: "participant" }, "@alice");
  const ref = valueOf({ kind: "literal", type: "ref" }, 'doc"pr#7"');
  assert.ok(by.ok && ref.ok);
  const made = sourceValue(external("replied"), [ref.value, by.value]);
  const expected: Value = { type: "source", kind: "fact", name: "replied", args: [ref.value], labels: { by: by.value } };
  assert.equal(eventKey(made), eventKey(expected));
  // An optional label left out is not part of the key.
  assert.deepEqual(sourceValue(external("replied"), [ref.value, null]), { type: "source", kind: "fact", name: "replied", args: [ref.value], labels: {} });
});
