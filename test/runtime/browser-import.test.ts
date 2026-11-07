import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("the browser entry runs Std and restores a request without Node imports or globals", () => {
  const std = readFileSync(new URL("../../std/std.norn", import.meta.url), "utf8");
  const bootstrap = `
    import {parse} from "./src/frontend/parser.ts";
    import {compile, MemoryStore, Runtime, VirtualClock, SimulatedHost, text, variant} from "./src/runtime/browser.ts";
    const clock = new VirtualClock(), store = new MemoryStore(clock), host = new SimulatedHost(store, clock);
    const code = compile(parse(${JSON.stringify('open Std\nremind(@alice, "Review", ~at=1h)')}).program, {std: parse(${JSON.stringify(std)}).program});
    let runtime = new Runtime(code, store, host);
    await runtime.create("browser"); await host.pump(runtime);
    await host.advanceTo(3600000); await host.pump(runtime);
    runtime = await Runtime.restore("browser", store, host);
    const offer = (await store.effects("browser")).find(e => e.operation === "request.offer");
    await host.reply(await store.request(offer.arguments.requestId), variant("Done", text("yes")));
    await host.pump(runtime);
    export const result = JSON.stringify({status: (await store.load("browser")).status, process: typeof process, Buffer: typeof Buffer, require: typeof require});
  `;
  const script = `
    import {readFileSync} from 'node:fs';
    import {SourceTextModule, createContext} from 'node:vm';
    import ts from 'typescript';
    const context = createContext({TextEncoder});
    const cache = new Map();
    function load(url) {
      if (!cache.has(url)) {
        const source = readFileSync(new URL(url), 'utf8');
        const output = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true}}).outputText;
        cache.set(url, new SourceTextModule(output, {context, identifier: url}));
      }
      return cache.get(url);
    }
    const bootstrap = new SourceTextModule(${JSON.stringify(bootstrap)},
      {context, identifier: new URL('./browser-test.ts', 'file://' + process.cwd() + '/').href});
    await bootstrap.link((specifier, parent) => {
      if (!specifier.startsWith('.')) throw new Error('Browser imported a host module: ' + specifier);
      return load(new URL(specifier, parent.identifier).href);
    });
    await bootstrap.evaluate();
    console.log(bootstrap.namespace.result);
  `;
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), input: script, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {status: "completed", process: "undefined", Buffer: "undefined", require: "undefined"});
});
