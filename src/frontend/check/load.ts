/**
 * Reading the checker's inputs from files: host interfaces, the standard
 * library, and programs given as source text.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type * as A from "../ast.ts";
import { STACK_EXHAUSTED } from "../diagnostics.ts";
import { parse } from "../parser.ts";
import type { CheckDiagnostic } from "./diagnostics.ts";
import { checkProgram, loadLibrary, type CheckResult, type Library } from "./infer.ts";
import { builtinInterface, loadInterface, type HostInterface } from "./interface.ts";

/** The reference host's interface file, which `norn check` reads unless `--host` names another. */
export function referenceHostPath(): string {
  return fileURLToPath(new URL("../../../hosts/reference.norn", import.meta.url));
}

/** The standard library, which `open Std` brings in. */
export function standardLibraryPath(): string {
  return fileURLToPath(new URL("../../../std/std.norn", import.meta.url));
}

/** A host interface from source text. A syntax error makes an interface of the built-ins alone, with the error. */
export function readInterface(source: string, file: string): HostInterface {
  const parsed = parse(source);
  if (!parsed.ok) return { ...builtinInterface(), file, diagnostics: parsed.diagnostics.map(syntax), ok: false };
  return loadInterface(parsed.program, file);
}

/** The standard library from source text, checked against a host. */
export function readLibrary(source: string, file: string, host: HostInterface): Library {
  const parsed = parse(source);
  if (!parsed.ok) {
    const program: A.Program = { kind: "Program", body: [], span: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } } };
    return { file, program, exports: [], types: [], resolutions: new Map(), diagnostics: parsed.diagnostics.map(syntax), ok: false };
  }
  return loadLibrary(parsed.program, file, host);
}

let reference: HostInterface | null = null;
const libraries = new WeakMap<HostInterface, Library>();

/** The reference host's interface, read once. */
export function referenceHost(): HostInterface {
  reference ??= readInterface(readFileSync(referenceHostPath(), "utf8"), "hosts/reference.norn");
  return reference;
}

/** The standard library checked against a host, once per host. */
export function standardLibrary(host: HostInterface = referenceHost()): Library {
  let library = libraries.get(host);
  if (library === undefined) {
    library = readLibrary(readFileSync(standardLibraryPath(), "utf8"), "std/std.norn", host);
    libraries.set(host, library);
  }
  return library;
}

export interface SourceCheck extends CheckResult {
  /** The tree, when the source parses. */
  program: A.Program | null;
}

/** Parses and checks a program's source, by default against the reference host and with the standard library. */
export function checkSource(source: string, options: { host?: HostInterface; std?: Library | null } = {}): SourceCheck {
  const parsed = parse(source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics.map(syntax), bindings: [], effects: null, program: null };
  const host = options.host ?? referenceHost();
  const std = options.std === undefined ? standardLibrary(host) : options.std;
  return { ...checkProgram(parsed.program, { host, std }), program: parsed.program };
}

/** A syntax error as a checker diagnostic; running out of stack while parsing is `too-deep`, as while checking. */
export function syntax(diagnostic: { message: string; span: A.Span }): CheckDiagnostic {
  return { severity: "error", code: diagnostic.message === STACK_EXHAUSTED ? "too-deep" : "syntax", message: diagnostic.message, span: diagnostic.span };
}
