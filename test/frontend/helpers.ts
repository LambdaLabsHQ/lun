import assert from "node:assert/strict";
import type { Diagnostic, Program, TopLevelItem } from "../../src/frontend/index.ts";
import { parse } from "../../src/frontend/index.ts";

/** Parses a program that must have no errors. */
export function parseOk(source: string): Program {
  const result = parse(source);
  if (!result.ok) assert.fail(`unexpected syntax error: ${result.diagnostics.map((d) => d.message).join("; ")}`);
  return result.program;
}

/** Parses a program that must have errors, and returns them. */
export function parseErrors(source: string): Diagnostic[] {
  const result = parse(source);
  if (result.ok) assert.fail(`expected a syntax error in ${JSON.stringify(source)}`);
  return result.diagnostics;
}

/** The only top-level item of a program, without spans. */
export function item(source: string): unknown {
  const { body } = parseOk(source);
  assert.equal(body.length, 1, `expected one top-level item in ${JSON.stringify(source)}`);
  return strip(body[0] as TopLevelItem);
}

/** A copy of a tree without its spans, for comparing shapes. */
export function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "span").map(([key, child]) => [key, strip(child)]));
}

export const id = (name: string) => ({ kind: "Identifier", name });
export const int = (value: string) => ({ kind: "IntLiteral", value });
export const str = (value: string) => ({ kind: "StringLiteral", value });
export const call = (callee: unknown, ...args: unknown[]) => ({ kind: "Call", callee, args });
export const labelled = (label: string, value: unknown) => ({ kind: "LabelledArg", label, value });
export const pipe = (left: unknown, callee: unknown, ...args: unknown[]) => ({ kind: "Pipe", left, callee, args });
export const binary = (op: string, left: unknown, right: unknown) => ({ kind: "Binary", op, left, right });
export const variable = (name: string) => ({ kind: "VarPattern", name });
export const ctor = (name: string, ...args: unknown[]) => ({ kind: "Constructor", name, args });
export const ctorPattern = (name: string, ...args: unknown[]) => ({ kind: "ConstructorPattern", name, args });
export const participant = (name: string, instance: string | null = null, args: unknown[] = []) => ({
  kind: "ParticipantLiteral",
  name,
  instance,
  args,
});

/**
 * Fails if any object, whether a node, a list, a span or a position, can be
 * reached twice from the root. A tree read back from JSON never shares objects,
 * and the runtime numbers nodes by object identity, so a parsed tree must not
 * share them either.
 */
export function assertNoSharedObjects(root: unknown): void {
  const seen = new Set<object>();
  const visit = (value: unknown, path: string): void => {
    if (typeof value !== "object" || value === null) return;
    assert.ok(!seen.has(value), `${path} is an object that also appears elsewhere in the tree`);
    seen.add(value);
    for (const [key, child] of Object.entries(value)) visit(child, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`);
  };
  visit(root, "program");
}

/** Node kinds in pre-order, visiting each object once, as the runtime numbers them. */
export function preorderKinds(root: unknown): string[] {
  const seen = new Set<object>();
  const kinds: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if ("kind" in value && typeof value.kind === "string") kinds.push(value.kind);
    for (const child of Object.values(value)) visit(child);
  };
  visit(root);
  return kinds;
}

/**
 * norn-ast JSON laid out for reading, as the snapshots store it: indented by
 * two spaces, with each span on one line. For the small trees of tests only.
 */
export function prettyAstJson(text: string): string {
  const inline = (value: unknown): boolean =>
    typeof value !== "object" || value === null || (!Array.isArray(value) && !("kind" in value) && Object.values(value).every(inline));
  const oneLine = (value: unknown): string =>
    typeof value !== "object" || value === null
      ? JSON.stringify(value)
      : `{${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}: ${oneLine(child)}`).join(", ")}}`;
  const layout = (value: unknown, indent: string): string => {
    if (inline(value)) return oneLine(value);
    const inner = `${indent}  `;
    if (Array.isArray(value)) {
      if (value.length === 0 || value.every(inline)) return `[${value.map(oneLine).join(", ")}]`;
      return `[\n${value.map((item) => inner + layout(item, inner)).join(",\n")}\n${indent}]`;
    }
    const entries = Object.entries(value as object).map(([key, child]) => `${inner}${JSON.stringify(key)}: ${layout(child, inner)}`);
    return `{\n${entries.join(",\n")}\n${indent}}`;
  };
  return `${layout(JSON.parse(text), "")}\n`;
}
