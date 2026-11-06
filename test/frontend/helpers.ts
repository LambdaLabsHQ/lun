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
