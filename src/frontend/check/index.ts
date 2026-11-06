/**
 * The Norn type checker (docs/types.md).
 *
 * ```ts
 * const host = loadInterface(hostProgram, "hosts/reference.norn");
 * const std = loadLibrary(stdProgram, "std/std.norn", host);
 * const result = checkProgram(program, { host, std });
 * ```
 *
 * `checkSource` does all of this from source text, with the reference host
 * and the standard library of this repository.
 */
export { FAMILIES, type Family } from "./builtins.ts";
export { CODES, type CheckDiagnostic, type Code, type Severity } from "./diagnostics.ts";
export type { EffectSummary } from "./effects.ts";
export { checkProgram, loadLibrary, type CheckOptions, type CheckResult, type Library } from "./infer.ts";
export { builtinInterface, loadInterface, type HostInterface, type ValueBinding } from "./interface.ts";
export { checkSource, readInterface, readLibrary, referenceHost, referenceHostPath, standardLibrary, standardLibraryPath, type SourceCheck } from "./load.ts";
