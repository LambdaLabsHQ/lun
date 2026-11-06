import assert from "node:assert/strict";
import { test } from "node:test";
import { AST_FORMAT, AST_VERSION, AstJsonError, astFromJson, astToJson, type Program, type Span } from "../../src/frontend/index.ts";
import { parseOk } from "./helpers.ts";

const source = `type probe = Ship | Skip
open Std
let r = ask(@alice, "Ship?", ~options=[Ship, Skip], ~until=2026-11-07T12:00Z)
switch r {
| Done(Ship) | TimedOut => run(@auto, \`ship \${1.5}\`)
| _ => if true { [x, ...rest] } else { (1, 2h) }
}
let f = (~on=[], x) => x + 1 * -2
`;
const program = parseOk(source);
const text = astToJson(program);

/** Documents in these tests are changed freely, so they are untyped. */
type Json = any;

/** A fresh, writable copy of the document. */
function documentCopy(): Json {
  return JSON.parse(text);
}

function span(offset: number, length: number): Span {
  return { start: { line: 1, column: offset + 1, offset }, end: { line: 1, column: offset + length + 1, offset: offset + length } };
}

test("the writer emits one line, with fields in their documented order", () => {
  assert.ok(text.startsWith(`{"format":"norn-ast","version":1,"program":{"kind":"Program","body":[{"kind":"TypeDecl","name":"probe",`));
  assert.ok(!text.includes("\n"));
  const document = JSON.parse(text);
  assert.equal(document.format, AST_FORMAT);
  assert.equal(document.version, AST_VERSION);
  assert.deepEqual(document.program, program);
  // Construction order does not matter: keys come out as kind, fields, span.
  const shuffled = { span: span(0, 1), body: [{ span: span(0, 1), name: "x", kind: "Identifier" }], kind: "Program" } as Program;
  assert.equal(
    astToJson(shuffled),
    `{"format":"norn-ast","version":1,"program":{"kind":"Program","body":[{"kind":"Identifier","name":"x","span":${JSON.stringify(span(0, 1))}}],"span":${JSON.stringify(span(0, 1))}}}`,
  );
});

test("reading a document gives back the same tree", () => {
  assert.deepEqual(astFromJson(text), program);
  assert.equal(astToJson(astFromJson(text)), text);
});

test("reading and writing do not recurse, so a tree 100,000 nodes deep round-trips", () => {
  const leaf = `{"kind":"Identifier","name":"x","span":${JSON.stringify(span(0, 1))}}`;
  const depth = 100_000;
  const unary = `{"kind":"Unary","op":"!","operand":`;
  const close = `,"span":${JSON.stringify(span(0, 1))}}`;
  const deep = `{"format":"norn-ast","version":1,"program":{"kind":"Program","body":[${unary.repeat(depth)}${leaf}${close.repeat(depth)}],"span":${JSON.stringify(span(0, 1))}}}`;
  assert.equal(astToJson(astFromJson(deep)), deep);
});

/** One malformed document per rule: a change to a valid document, and the error it must give. */
const malformed: [string, (document: Json) => unknown, string][] = [
  // The document
  ["not JSON", () => "{", "not JSON: "],
  ["not an object", () => [], "not a norn-ast document"],
  ["another format", (d) => { d.format = "estree"; }, "not a norn-ast document"],
  ["another version", (d) => { d.version = 2; }, "version: unsupported norn-ast version 2; expected 1"],
  ["an unknown document field", (d) => { d.extra = true; }, `unknown field "extra" in the document`],
  ["no program", (d) => { delete d.program; }, "the document has no program"],
  ["a program that is not a Program", (d) => { d.program = d.program.body[2]; }, "program: expected a Program node, found a Let node"],
  // Nodes: a known kind, exactly their fields
  ["an unknown kind", (d) => { d.program.body[1].kind = "Import"; }, `program.body[1].kind: unknown node kind "Import"`],
  ["a kind that is not a string", (d) => { d.program.body[1].kind = 7; }, "program.body[1].kind: expected a string, found 7"],
  ["an object without a kind", (d) => { delete d.program.body[1].kind; }, "program.body[1]: expected a top-level item, found an object without a kind"],
  ["an unknown field", (d) => { d.program.body[2].value.args[0].foo = 1; }, `program.body[2].value.args[0]: unknown field "foo"`],
  ["a missing field", (d) => { delete d.program.body[2].value.args; }, `program.body[2].value: missing field "args"`],
  ["a missing span", (d) => { delete d.program.body[1].span; }, `program.body[1]: missing field "span"`],
  // Spans and positions
  ["a span that is not an object", (d) => { d.program.body[1].span = null; }, "program.body[1].span: expected a span {start, end}, found null"],
  ["an unknown span field", (d) => { d.program.body[1].span.file = "a.norn"; }, `program.body[1].span: unknown field "file"`],
  ["a missing position field", (d) => { delete d.program.body[1].span.start.offset; }, `program.body[1].span.start: missing field "offset"`],
  ["a line of 0", (d) => { d.program.body[1].span.start.line = 0; }, "program.body[1].span.start.line: expected a positive integer, found 0"],
  ["a fractional column", (d) => { d.program.body[1].span.end.column = 1.5; }, "program.body[1].span.end.column: expected a positive integer, found 1.5"],
  ["a negative offset", (d) => { d.program.body[1].span.start.offset = -1; }, "program.body[1].span.start.offset: expected a non-negative integer, found -1"],
  ["a span that ends before it starts", (d) => { d.program.body[1].span.end.offset = 0; }, "program.body[1].span: the span ends at offset 0, before it starts at 25"],
  // Which node kinds a slot may hold
  ["a pattern where an expression goes", (d) => { d.program.body[2].value.args[1] = d.program.body[2].pattern; }, "program.body[2].value.args[1]: expected an argument, found a VarPattern node"],
  ["an expression where a pattern goes", (d) => { d.program.body[2].pattern = d.program.body[2].value.callee; }, "program.body[2].pattern: expected a pattern, found an Identifier node"],
  ["a statement where a type goes", (d) => { d.program.body[0].definition.constructors[0] = d.program.body[2]; }, "program.body[0].definition.constructors[0]: expected a ConstructorDecl node, found a Let node"],
  ["a nested OrPattern", (d) => { const or = d.program.body[3].cases[0].pattern; or.alternatives[1] = structuredClone(or); }, "program.body[3].cases[0].pattern.alternatives[1]: an OrPattern cannot be an alternative of another OrPattern; list its alternatives directly"],
  // Scalars and enumerations
  ["a number for a string", (d) => { d.program.body[2].value.callee.name = 3; }, "program.body[2].value.callee.name: expected a string, found 3"],
  ["a string for a boolean", (d) => { d.program.body[3].cases[1].body.condition.value = "yes"; }, `program.body[3].cases[1].body.condition.value: expected true or false, found "yes"`],
  ["a string for a number", (d) => { d.program.body[3].cases[0].body.args[1].expressions[0].value = "1.5"; }, `program.body[3].cases[0].body.args[1].expressions[0].value: expected a finite number, found "1.5"`],
  ["an infinite float", () => text.replace(`"value":1.5`, `"value":1e999`), "program.body[3].cases[0].body.args[1].expressions[0].value: expected a finite number, found Infinity"],
  ["a fractional integer", (d) => { d.program.body[2].value.args[3].value.epochMs = 1.5; }, "program.body[2].value.args[3].value.epochMs: expected an integer, found 1.5"],
  ["a non-canonical integer", (d) => { d.program.body[4].value.body.left.kind = "IntLiteral"; d.program.body[4].value.body.left.value = "042"; delete d.program.body[4].value.body.left.name; }, `program.body[4].value.body.left.value: expected a decimal integer string such as "42" or "-1", found "042"`],
  ["a number for a decimal string", (d) => { d.program.body[3].cases[1].body.elseBranch.body[0].elements[0].value = 1; }, `program.body[3].cases[1].body.elseBranch.body[0].elements[0].value: expected a decimal integer string such as "42" or "-1", found 1`],
  ["a signed duration", (d) => { d.program.body[3].cases[1].body.elseBranch.body[0].elements[1].amount = "-2"; }, `program.body[3].cases[1].body.elseBranch.body[0].elements[1].amount: expected a string of digits such as "42", found "-2"`],
  ["an unknown unit", (d) => { d.program.body[3].cases[1].body.elseBranch.body[0].elements[1].unit = "s"; }, `program.body[3].cases[1].body.elseBranch.body[0].elements[1].unit: expected one of "m", "h", "d", "w", found "s"`],
  ["an unknown operator", (d) => { d.program.body[4].value.body.op = "%"; }, `program.body[4].value.body.op: expected one of "||", "&&", "==", "!=", "<", "<=", ">", ">=", "+", "-", "++", "+.", "-.", "*", "/", "*.", "/.", found "%"`],
  ["another module", (d) => { d.program.body[1].module = "Belt"; }, `program.body[1].module: expected one of "Std", found "Belt"`],
  // Nullable slots and lists
  ["null where a node is required", (d) => { d.program.body[2].value = null; }, "program.body[2].value: expected an expression, found null"],
  ["the wrong node in a nullable slot", (d) => { const branch = d.program.body[3].cases[1].body; branch.elseBranch = d.program.body[2].value; }, "program.body[3].cases[1].body.elseBranch: expected a Block or If node, found a Call node"],
  ["an object for a list", (d) => { d.program.body[2].value.args = {}; }, "program.body[2].value.args: expected a list, found an object"],
  ["a one-element tuple", (d) => { d.program.body[3].cases[1].body.elseBranch.body[0].elements.pop(); }, "program.body[3].cases[1].body.elseBranch.body[0].elements: expected at least 2 items, found 1"],
  ["a switch without cases", (d) => { d.program.body[3].cases = []; }, "program.body[3].cases: expected at least 1 item, found 0"],
  ["a template whose strings and expressions do not alternate", (d) => { d.program.body[3].cases[0].body.args[1].strings.pop(); }, "program.body[3].cases[0].body.args[1]: a template has one more string than expressions, found 1 and 1"],
];

test("reading refuses a malformed document, naming the path of the problem", () => {
  for (const [rule, change, message] of malformed) {
    const document = documentCopy();
    const replaced = change(document);
    const input = typeof replaced === "string" ? replaced : JSON.stringify(replaced ?? document);
    assert.throws(
      () => astFromJson(input),
      (error: unknown) => error instanceof AstJsonError && (message.endsWith(": ") ? error.message.startsWith(message) : error.message === message),
      rule,
    );
  }
});

test("a tree in which a node or list appears twice, or that has a cycle, is refused", () => {
  const shared = documentCopy();
  shared.program.body[2].value.args[1] = shared.program.body[2].value.args[0];
  assert.throws(() => astToJson(shared.program), {
    name: "AstJsonError",
    message: "program.body[2].value.args[1]: this node also appears elsewhere in the tree; each must be its own object",
  });
  const sharedList = documentCopy();
  sharedList.program.body[3].cases[0].body.args = sharedList.program.body[2].value.args;
  assert.throws(() => astToJson(sharedList.program), { message: /^program\.body\[3\]\.cases\[0\]\.body\.args: this list also appears elsewhere/ });
  const cycle = documentCopy();
  cycle.program.body[2].value.args[1] = cycle.program.body[2].value;
  assert.throws(() => astToJson(cycle.program), { message: /^program\.body\[2\]\.value\.args\[1\]: this node also appears elsewhere/ });
  // Spans may be shared; only nodes and lists have an identity that matters.
  const sharedSpan = documentCopy();
  sharedSpan.program.body[1].span = sharedSpan.program.body[0].span;
  assert.doesNotThrow(() => astToJson(sharedSpan.program));
});

test("writing refuses the same malformed trees", () => {
  for (const [rule, change, message] of malformed) {
    const document = documentCopy();
    const replaced = change(document);
    if (replaced !== undefined) continue; // documents that are not trees
    if (!message.startsWith("program")) continue; // problems with the document around the tree
    assert.throws(() => astToJson(document.program), { name: "AstJsonError", message }, rule);
  }
  const withUndefined = documentCopy();
  withUndefined.program.body[3].cases[1].body.thenBranch.body[0].rest = undefined;
  assert.throws(() => astToJson(withUndefined.program), {
    message: "program.body[3].cases[1].body.thenBranch.body[0].rest: expected an expression, found undefined",
  });
});
