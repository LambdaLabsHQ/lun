import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function norn(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("norn help prints the usage", () => {
  const result = norn("help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: norn <command>/);
  assert.equal(norn().stdout, result.stdout);
});

test("an unknown command is a usage error", () => {
  const result = norn("frobnicate");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command 'frobnicate'/);
});
