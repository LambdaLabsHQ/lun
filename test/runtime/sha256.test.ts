import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sha256 } from "../../src/runtime/sha256.ts";

test("portable SHA-256 matches known answers and Node UTF-8 hashing at block boundaries", () => {
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256("a".repeat(1_000_000)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 127, 128, 129, 4096]) {
    for (const alphabet of ["a", "\0\xff", "中文🙂", "\ud800\udfff\ud800x\udfff"]) {
      const value = alphabet.repeat(length);
      assert.equal(sha256(value), createHash("sha256").update(value).digest("hex"), `${length} ${JSON.stringify(alphabet)}`);
    }
  }
});
