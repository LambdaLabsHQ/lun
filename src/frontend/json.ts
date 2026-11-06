/**
 * The stable JSON form of a Norn syntax tree, as printed by `norn parse --json`.
 *
 * A document is `{"format": "norn-ast", "version": 1, "program": …}`. Each
 * node is written as `kind`, then its fields in `NODE_FIELDS` order, then
 * `span`. Spans are written on one line; everything else is indented by two
 * spaces. See docs/ast.md.
 */
import { NODE_FIELDS, type NodeKind, type Program } from "./ast.ts";

export const AST_FORMAT = "norn-ast";
export const AST_VERSION = 1;

export interface AstDocument {
  format: typeof AST_FORMAT;
  version: typeof AST_VERSION;
  program: Program;
}

/** Serializes a program as a norn-ast JSON document, ending in a newline. */
export function astToJson(program: Program): string {
  const document: AstDocument = { format: AST_FORMAT, version: AST_VERSION, program };
  const out: string[] = [];
  write(document, "", out);
  out.push("\n");
  return out.join("");
}

/** Reads a document written by `astToJson`. Throws if it is not a norn-ast document of this version. */
export function astFromJson(text: string): Program {
  const document: unknown = JSON.parse(text);
  if (!isObject(document) || document["format"] !== AST_FORMAT) {
    throw new Error(`not a ${AST_FORMAT} document`);
  }
  if (document["version"] !== AST_VERSION) {
    throw new Error(`unsupported ${AST_FORMAT} version ${String(document["version"])}; expected ${AST_VERSION}`);
  }
  const program = document["program"];
  if (!isObject(program) || program["kind"] !== "Program") {
    throw new Error(`a ${AST_FORMAT} document needs a Program`);
  }
  return program as unknown as Program;
}

type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeKind(kind: unknown): kind is NodeKind {
  return typeof kind === "string" && Object.hasOwn(NODE_FIELDS, kind);
}

/** Spans and positions: objects that are not nodes and hold only scalars or other such objects. */
function isInline(value: unknown): boolean {
  if (!isObject(value)) return value === null || typeof value !== "object";
  return !("kind" in value) && Object.values(value).every(isInline);
}

/** Appends the JSON text of `value` to `out`, so that writing takes time linear in its length. */
function write(value: unknown, indent: string, out: string[]): void {
  if (value === undefined) throw new Error("undefined is not part of the AST; use null");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${value} has no JSON form`);
  if (value === null || typeof value !== "object" || isInline(value)) {
    out.push(inline(value));
    return;
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0 || value.every(isInline)) {
      out.push(`[${value.map(inline).join(", ")}]`);
      return;
    }
    out.push("[\n");
    value.forEach((item, index) => {
      out.push(index === 0 ? inner : `,\n${inner}`);
      write(item, inner, out);
    });
    out.push(`\n${indent}]`);
    return;
  }
  const object = value as JsonObject;
  out.push("{\n");
  orderedKeys(object).forEach((key, index) => {
    out.push(`${index === 0 ? "" : ",\n"}${inner}${JSON.stringify(key)}: `);
    write(object[key], inner, out);
  });
  out.push(`\n${indent}}`);
}

/** Scalars, and spans and positions on one line. */
function inline(value: unknown): string {
  if (value === undefined) throw new Error("undefined is not part of the AST; use null");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${value} has no JSON form`);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const object = value as JsonObject;
  return `{${Object.keys(object).map((key) => `${JSON.stringify(key)}: ${inline(object[key])}`).join(", ")}}`;
}

/** Nodes: `kind`, the fields in NODE_FIELDS order, `span`. Other objects keep their own order. */
function orderedKeys(object: JsonObject): string[] {
  const kind = object["kind"];
  if (kind === undefined) return Object.keys(object);
  if (!isNodeKind(kind)) throw new Error(`unknown node kind ${JSON.stringify(kind)}`);
  const keys = ["kind", ...NODE_FIELDS[kind], "span"];
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) throw new Error(`${kind} node is missing its ${key}`);
  }
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) throw new Error(`${kind} node has an unknown field ${key}`);
  }
  return keys;
}
