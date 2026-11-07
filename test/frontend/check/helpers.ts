import assert from "node:assert/strict";
import { checkSource, type CheckDiagnostic, type SourceCheck } from "../../../src/frontend/check/index.ts";
import { referenceOptions } from "../../../src/frontend/check/node.ts";

/** Checks a program against the reference host, with the standard library. */
export function check(source: string): SourceCheck {
  return checkSource(source, referenceOptions());
}

/** The diagnostics as `code: message @line:column`, for readable failures. */
export function describe(diagnostics: readonly CheckDiagnostic[]): string {
  return diagnostics.map((d) => `${d.severity} ${d.code}: ${d.message} @${d.span.start.line}:${d.span.start.column}`).join("\n");
}

/** A program that must check without any diagnostic; returns its top-level bindings' types by name. */
export function types(source: string): Record<string, string> {
  const result = check(source);
  assert.equal(result.diagnostics.length, 0, `expected no diagnostics in ${JSON.stringify(source)}, found:\n${describe(result.diagnostics)}`);
  return Object.fromEntries(result.bindings.map(({ name, type }) => [name, type]));
}

/** The type of one top-level binding of a program that checks. */
export function typeOf(source: string, name: string): string {
  const found = types(source)[name];
  assert.ok(found !== undefined, `no binding ${name} in ${JSON.stringify(source)}`);
  return found;
}

/** The only diagnostic of a program, which must have this code. */
export function only(source: string, code: string): CheckDiagnostic {
  const { diagnostics } = check(source);
  assert.equal(diagnostics.length, 1, `expected exactly one diagnostic in ${JSON.stringify(source)}, found:\n${describe(diagnostics)}`);
  assert.equal(diagnostics[0]!.code, code, describe(diagnostics));
  return diagnostics[0]!;
}

/** The only diagnostic's message, checking its code. */
export function message(source: string, code: string): string {
  return only(source, code).message;
}

/** The diagnostics of a program, as [code, message, line, column]. */
export function all(source: string): [string, string, number, number][] {
  return check(source).diagnostics.map((d) => [d.code, d.message, d.span.start.line, d.span.start.column]);
}

/** Where a diagnostic points: the source text under its span. */
export function under(source: string, diagnostic: CheckDiagnostic): string {
  return source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset);
}
