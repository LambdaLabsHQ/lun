import assert from "node:assert/strict";
import { test } from "node:test";
import type { Program, Span } from "../../src/frontend/ast.ts";
import { AST_FORMAT, AST_VERSION, astFromJson, astToJson } from "../../src/frontend/json.ts";

function span(line: number, column: number, offset: number, length: number): Span {
  return { start: { line, column, offset }, end: { line, column: column + length, offset: offset + length } };
}

// type probe = Ship | Skip
const program: Program = {
  kind: "Program",
  body: [
    {
      kind: "TypeDecl",
      name: "probe",
      params: [],
      definition: {
        kind: "VariantType",
        constructors: [
          { kind: "ConstructorDecl", name: "Ship", args: [], span: span(1, 14, 13, 4) },
          { kind: "ConstructorDecl", name: "Skip", args: [], span: span(1, 21, 20, 4) },
        ],
        span: span(1, 14, 13, 11),
      },
      span: span(1, 1, 0, 24),
    },
  ],
  span: span(1, 1, 0, 24),
};

test("a document has the format, the version and the program", () => {
  const document = JSON.parse(astToJson(program));
  assert.equal(document.format, AST_FORMAT);
  assert.equal(document.version, AST_VERSION);
  assert.deepEqual(document.program, program);
});

test("the JSON text is indented, with each span on one line", () => {
  const text = astToJson(program);
  assert.ok(text.startsWith(`{\n  "format": "norn-ast",\n  "version": 1,\n  "program": {\n    "kind": "Program",\n`));
  assert.ok(text.includes(`"span": {"start": {"line": 1, "column": 14, "offset": 13}, "end": {"line": 1, "column": 18, "offset": 17}}`));
  assert.ok(text.includes(`"params": [],`));
  assert.ok(text.endsWith("}\n"));
});

test("fields are written in their documented order, whatever order a node was built in", () => {
  const shuffled: Program = {
    span: program.span,
    body: [{ span: span(1, 1, 0, 1), name: "x", kind: "Identifier" }],
    kind: "Program",
  };
  const ordered: Program = {
    kind: "Program",
    body: [{ kind: "Identifier", name: "x", span: span(1, 1, 0, 1) }],
    span: program.span,
  };
  assert.equal(astToJson(shuffled), astToJson(ordered));
  const lines = astToJson(ordered).split("\n").map((line) => line.trim());
  const identifier = lines.indexOf(`"kind": "Identifier",`);
  assert.deepEqual(lines.slice(identifier, identifier + 3).map((line) => line.split(":")[0]), [`"kind"`, `"name"`, `"span"`]);
});

test("reading a document gives back the same program", () => {
  assert.deepEqual(astFromJson(astToJson(program)), program);
});

test("a node with a missing, unknown or undefined field is refused", () => {
  const missing = { kind: "Program", span: program.span } as unknown as Program;
  assert.throws(() => astToJson(missing), /Program node is missing its body/);
  const unknown = { ...program, extra: 1 } as unknown as Program;
  assert.throws(() => astToJson(unknown), /Program node has an unknown field extra/);
  const undefinedRest = {
    kind: "Program",
    body: [{ kind: "ListLiteral", elements: [], rest: undefined, span: program.span }],
    span: program.span,
  } as unknown as Program;
  assert.throws(() => astToJson(undefinedRest), /use null/);
  const badKind = { kind: "Program", body: [{ kind: "Nope", span: program.span }], span: program.span } as unknown as Program;
  assert.throws(() => astToJson(badKind), /unknown node kind "Nope"/);
});

test("documents of another format or version are refused", () => {
  assert.throws(() => astFromJson(`{"format": "other", "version": 1, "program": {}}`), /not a norn-ast document/);
  assert.throws(() => astFromJson(`{"format": "norn-ast", "version": 99, "program": {}}`), /unsupported norn-ast version 99; expected 1/);
  assert.throws(() => astFromJson(`{"format": "norn-ast", "version": 1, "program": {"kind": "Let"}}`), /needs a Program/);
});
