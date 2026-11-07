/**
 * The reference host and the standard library of this repository, read from
 * their files: what `norn check` and the tests use unless they are given
 * others. Node only; the checker itself (index.ts) takes source text.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CheckOptions, Library } from "./infer.ts";
import type { HostInterface } from "./interface.ts";
import { readInterface, readLibrary } from "./source.ts";

/** The reference host's interface file, which `norn check` reads unless `--host` names another. */
export function referenceHostPath(): string {
  return fileURLToPath(new URL("../../../hosts/reference.norn", import.meta.url));
}

/** The standard library, which `open Std` brings in. */
export function standardLibraryPath(): string {
  return fileURLToPath(new URL("../../../std/std.norn", import.meta.url));
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

/** The reference host with the standard library checked against it: what `norn check` uses without `--host`. */
export function referenceOptions(): CheckOptions {
  const host = referenceHost();
  return { host, std: standardLibrary(host) };
}
