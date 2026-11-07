import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkSource, readInterface, referenceHost, standardLibrary } from "../../../src/frontend/check/index.ts";
import { describe, message } from "./helpers.ts";

const reference = readFileSync(new URL("../../../hosts/reference.norn", import.meta.url), "utf8");

test("the reference host interface declares the facts and streams of the spec", () => {
  const host = referenceHost();
  assert.deepEqual(host.diagnostics, []);
  const externals = [...host.values.values()].filter((value) => value.origin === "host").map((value) => value.name);
  assert.deepEqual(externals, ["merged", "released", "machineUpdated", "replied", "runEnded", "ciFailed", "prActivity", "docChanged", "message"]);
  const result = checkSource(`let a = merged("acme/api#1")
let b = released(Beta, ~containing=a->wait?)
let c = machineUpdated(~machine="win-builder", ~atLeast="1.2")
let d = replied(doc"x#1")
let e = replied(doc"x#1", ~by=@alice)
let f = runEnded(doc"run#7")
let g = ciFailed("acme/api")
let h = prActivity("acme/api#1")
let i = docChanged(doc"ops")
let j = message(channel"general", ~from=@bob)`);
  assert.deepEqual(result.diagnostics, [], describe(result.diagnostics));
  assert.deepEqual(Object.fromEntries(result.bindings.map(({ name, type }) => [name, type])), {
    a: "event<pr>",
    b: "event<release>",
    c: "event<string>",
    d: "event<message>",
    e: "event<message>",
    f: "event<outcome<report>>",
    g: "stream<string>",
    h: "stream<string>",
    i: "stream<string>",
    j: "stream<message>",
  });
});

test("externals and abstract types are only for host interface files", () => {
  assert.equal(
    message("type token\n()", "interface-only"),
    "an abstract type such as 'type token' can only be declared in a host interface file; give it a definition, as in type token = Token",
  );
  assert.equal(
    message("external now2: () => time\n()", "interface-only"),
    "external declarations are only allowed in a host interface file: a program cannot declare what the host supplies",
  );
});

test("an interface holds only type and external declarations, with no name declared twice", () => {
  const host = readInterface(`type ticket
type state = Open | Closed
external opened: (string) => event<ticket>
external opened: (string) => stream<ticket>
external wait: (int) => int
external id: ('a) => 'a
external bad: (~at: time, ~at: time) => unit
let x = 1
open Std`, "test.norn");
  assert.deepEqual(host.diagnostics.map((d) => [d.code, d.message]), [
    ["duplicate-external", "the external opened is already declared at 3:1"],
    ["duplicate-external", "wait is a built-in; an interface cannot declare it again"],
    ["duplicate-label", "the label ~at appears twice in this function type"],
    ["interface-item", "a host interface file holds only type and external declarations, found a let binding"],
    ["interface-item", "a host interface file holds only type and external declarations, found 'open Std'"],
  ]);
  assert.equal(host.ok, false);
});

test("another host: its types, its externals, generic externals, and a report it does not declare", () => {
  const host = readInterface(`// A ticketing host.
type ticket
type state = Open | Closed
type update = {ticket: ticket, state: state}
external opened: (string) => event<ticket>
external updates: (ticket, ~from: participant=?) => stream<update>
external first: (list<'a>) => option<'a>`, "tickets.norn");
  assert.deepEqual(host.diagnostics, []);
  const std = standardLibrary(host);
  assert.equal(std.ok, true, describe(std.diagnostics));
  const result = checkSource(`let t = opened("T-1")->wait?
let u = t->updates->wait?
let s = switch u.state {
| Open => "open"
| Closed => "closed"
}
let f = first([1, 2])
let r = run(@auto, "x")?
ignore(f)`, { host, std });
  assert.deepEqual(result.diagnostics, [], describe(result.diagnostics));
  assert.deepEqual(Object.fromEntries(result.bindings.map(({ name, type }) => [name, type])), {
    t: "ticket", u: "update", s: "string", f: "option<int>", r: "report",
  });
  // Without the reference host there is no merged, and report has no fields.
  const other = checkSource(`ignore(merged("x"))\nlet r = run(@auto, "x")?\nignore(r.text)`, { host, std });
  assert.deepEqual(other.diagnostics.map((d) => d.code), ["unknown-name", "type-mismatch"]);
});

test("open Std brings the standard library in; without it, its names are unknown", () => {
  const program = `type choice = Yes | No
open Std
let c = decide(@alice, "Ship?", ~options=[Yes, No], ~recommend=Yes, ~until=1d)
let r = remind(@bob, "Look at #12", ~at=2h)
let f = followUp(@codex, "Done?", ~until=1h, ~escalateTo=@alice)
ignore((r, f))`;
  const result = checkSource(program);
  assert.deepEqual(result.diagnostics, [], describe(result.diagnostics));
  assert.deepEqual(result.bindings.map(({ name, type }) => `${name}: ${type}`), ["c: choice", "r: outcome<string>", "f: outcome<string>"]);
  const without = checkSource(program.replace("open Std\n", ""));
  assert.deepEqual(without.diagnostics.map((d) => d.code), ["unknown-name", "unknown-name", "unknown-name"]);
  // Without a standard library, open Std is an error.
  assert.deepEqual(checkSource("open Std\n()", { std: null }).diagnostics.map((d) => d.message), ["open Std needs the standard library, and this check was not given one"]);
});

test("the reference host file is itself a valid interface, and not a valid program", () => {
  assert.deepEqual(readInterface(reference, "hosts/reference.norn").diagnostics, []);
  const asProgram = checkSource(reference);
  assert.ok(asProgram.diagnostics.length > 0);
  assert.ok(asProgram.diagnostics.every((d) => d.code === "interface-only" || d.code === "duplicate-type"), describe(asProgram.diagnostics));
});

test("a host's report takes no type parameters, and an external in a program is one error", () => {
  assert.deepEqual(readInterface("type report<'a> = {text: 'a}", "r.norn").diagnostics.map((d) => d.message), [
    "expected no type parameters for report, found 1: report is what run and start return, as in outcome<report>",
  ]);
  assert.deepEqual(checkSource("external now2: () => time\nlet t = now2()").diagnostics.map((d) => d.code), ["interface-only"]);
});

test("field names that differ across the host's records let a helper read a report's text", () => {
  const result = checkSource(`let summary = r => r.text
let tell = m => say(m.from, m.body)
switch run(@auto, "x") {
| Done(r) => say(@bob, summary(r))
| other => fail(other)
}`);
  assert.deepEqual(result.diagnostics, [], describe(result.diagnostics));
  assert.deepEqual(result.bindings.map(({ name, type }) => `${name}: ${type}`), ["summary: (report) => string", "tell: (message) => unit"]);
});
