/**
 * Checking in the playground: the reference host and the standard library are
 * read once from their bundled text, then each version of the program is
 * checked against them. The report is plain data, so it can cross from the
 * worker that checks to the page that shows it.
 */
import { checkSource, readInterface, readLibrary, type CheckDiagnostic, type EffectSummary } from "../../src/frontend/check/index.ts";

export interface CheckReport {
  ok: boolean;
  /** The checker's diagnostics, in source order, with its exact messages. */
  diagnostics: CheckDiagnostic[];
  /** What the program may do, for review; null when it has errors. */
  effects: EffectSummary[] | null;
  /** The types of the program's top-level bindings. */
  bindings: { name: string; type: string }[];
}

export type Checker = (source: string) => CheckReport;

/** A checker for programs against a host interface and a standard library, given as source text. */
export function createChecker(hostSource: string, stdSource: string): Checker {
  const host = readInterface(hostSource, "hosts/reference.norn");
  if (!host.ok) throw new Error(`the host interface does not check: ${host.diagnostics.map((d) => d.message).join("; ")}`);
  const std = readLibrary(stdSource, "std/std.norn", host);
  if (!std.ok) throw new Error(`the standard library does not check: ${std.diagnostics.map((d) => d.message).join("; ")}`);
  return (source) => {
    const { ok, diagnostics, effects, bindings } = checkSource(source, { host, std });
    return { ok, diagnostics, effects, bindings };
  };
}

/** The participants and the references that a program's effects name, each once, in order. */
export function named(effects: readonly EffectSummary[]): { participants: string[]; refs: string[] } {
  const targets = [...new Set(effects.flatMap((effect) => effect.targets))].sort();
  return { participants: targets.filter((target) => target.startsWith("@")), refs: targets.filter((target) => !target.startsWith("@")) };
}

/** "2 errors and 1 warning", "1 error", "no problems". */
export function problemCount(diagnostics: readonly CheckDiagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const parts = [
    ...(errors > 0 ? [`${errors} ${errors === 1 ? "error" : "errors"}`] : []),
    ...(warnings > 0 ? [`${warnings} ${warnings === 1 ? "warning" : "warnings"}`] : []),
  ];
  return parts.length === 0 ? "no problems" : parts.join(" and ");
}
