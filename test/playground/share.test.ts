import assert from "node:assert/strict";
import { test } from "node:test";
import { fragmentFor, readFragment } from "../../playground/src/share.ts";

test("a program survives the fragment, whatever its text", async () => {
  for (const source of ["", "say(@alice, \"Grüße, 你好 🧵\")\n", "let x = 1\n".repeat(20_000)]) {
    const fragment = await fragmentFor(source, null);
    assert.match(fragment, /^#code=[A-Za-z0-9_-]*$/);
    assert.deepEqual(await readFragment(fragment), { kind: "code", source });
  }
});

test("an unedited example is named, not encoded", async () => {
  assert.equal(await fragmentFor("ignored", "follow-up"), "#example=follow-up");
  assert.deepEqual(await readFragment("#example=follow-up"), { kind: "example", name: "follow-up" });
});

test("a fragment without a program, or with one cut short, says so", async () => {
  assert.deepEqual(await readFragment(""), { kind: "none" });
  assert.deepEqual(await readFragment("#"), { kind: "none" });
  assert.deepEqual(await readFragment("#example="), { kind: "none" });
  const fragment = await fragmentFor("ask(@alice, \"Ship the billing probe?\")".repeat(10), null);
  assert.deepEqual(await readFragment(fragment.slice(0, fragment.length / 2)), { kind: "unreadable" });
  assert.deepEqual(await readFragment("#code=%%%"), { kind: "unreadable" });
});
