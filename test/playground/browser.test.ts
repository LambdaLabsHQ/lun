import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

/**
 * Every module a browser entry imports, followed through relative imports,
 * with the other specifiers they name.
 */
function imports(entry: URL): { modules: string[]; external: Map<string, string> } {
  const seen = new Set<string>();
  const external = new Map<string, string>();
  const pending = [entry];
  for (let url = pending.pop(); url !== undefined; url = pending.pop()) {
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    for (const { fileName: specifier } of ts.preProcessFile(readFileSync(url, "utf8"), true, true).importedFiles) {
      if (specifier.startsWith(".")) pending.push(new URL(specifier, url));
      else external.set(specifier, url.pathname);
    }
  }
  return { modules: [...seen], external };
}

test("the playground's browser entries import no Node module", () => {
  const page = imports(new URL("../../playground/src/main.ts", import.meta.url));
  const worker = imports(new URL("../../playground/src/check-worker.ts", import.meta.url));
  // The worker runs the checker, and the page the lexer, from the language's own sources.
  assert.ok(worker.modules.some((module) => module.endsWith("/src/frontend/check/index.ts")));
  assert.ok(page.modules.some((module) => module.endsWith("/src/frontend/lexer.ts")));
  for (const { external } of [page, worker]) {
    for (const [specifier, from] of external) {
      // CodeMirror's packages, and the examples the build bundles.
      assert.ok(/^@codemirror\/|^norn:examples$/.test(specifier), `${from} imports ${specifier}, which a browser cannot load`);
    }
  }
});

test("the checker's entry imports no Node module, and only node.ts reads files", () => {
  const { modules, external } = imports(new URL("../../src/frontend/check/index.ts", import.meta.url));
  assert.deepEqual([...external.keys()], []);
  assert.ok(!modules.some((module) => module.endsWith("/node.ts")));
});
