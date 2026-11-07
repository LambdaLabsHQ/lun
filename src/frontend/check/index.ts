/**
 * The Norn type checker (docs/types.md).
 *
 * ```ts
 * const host = loadInterface(hostProgram, "hosts/reference.norn");
 * const std = loadLibrary(stdProgram, "std/std.norn", host);
 * const result = checkProgram(program, { host, std });
 * ```
 *
 * `readInterface`, `readLibrary` and `checkSource` do the same from source
 * text. Nothing this module exports reads a file or needs Node, so it runs in
 * a browser. `node.ts` reads the reference host and the standard library from
 * this repository's files.
 */
export { FAMILIES, type Family } from "./builtins.ts";
export { CODES, type CheckDiagnostic, type Code, type Severity } from "./diagnostics.ts";
export type { EffectSummary } from "./effects.ts";
export { checkProgram, loadLibrary, type CheckOptions, type CheckResult, type Library } from "./infer.ts";
export { builtinInterface, loadInterface, type HostInterface, type ValueBinding } from "./interface.ts";
export { checkSource, readInterface, readLibrary, type SourceCheck } from "./source.ts";
