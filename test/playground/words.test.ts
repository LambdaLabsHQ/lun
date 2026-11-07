import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDate, formatDuration, formatTime, literal } from "../../playground/src/words.ts";

test("times, dates and durations read as Norn writes them", () => {
  const noon = Date.parse("2026-11-07T12:00Z");
  assert.equal(formatTime(noon), "2026-11-07 12:00 UTC");
  assert.equal(formatTime(noon + 30_000), "2026-11-07 12:00:30 UTC");
  assert.equal(formatDate(noon), "Saturday 7 November 2026");
  assert.deepEqual([3_600_000, 5_400_000, 86_400_000, 604_800_000, 90_061_000].map(formatDuration), ["1h", "90m", "1d", "1w", "1d 1h 1m 1s"]);
});

test("values are shown as Norn source would write them", () => {
  assert.equal(literal({ type: "string", value: "say \"hi\"\n" }), '"say \\"hi\\"\\n"');
  assert.equal(literal({ type: "variant", name: "Done", args: [{ type: "record", fields: { text: { type: "string", value: "ok" } } }] }), 'Done({text: "ok"})');
  assert.equal(literal({ type: "participant", name: "codex", instance: "2", labels: { repo: { type: "string", value: "acme/api" } } }), '@codex:2(~repo="acme/api")');
  assert.equal(literal({ type: "ref", kind: "channel", value: "ops" }), 'channel"ops"');
  assert.equal(literal({ type: "time", value: String(Date.parse("2026-11-07T12:00Z")) }), "2026-11-07T12:00Z");
  assert.equal(literal({ type: "duration", value: "7200000" }), "2h");
  assert.equal(literal({ type: "list", values: [{ type: "int", value: "1" }, { type: "bool", value: true }] }), "[1, true]");
  assert.equal(literal({ type: "source", kind: "stream", name: "or", args: [
    { type: "source", kind: "stream", name: "every", args: [{ type: "duration", value: "86400000" }], labels: {} },
    { type: "source", kind: "stream", name: "ciFailed", args: [{ type: "string", value: "acme/api" }], labels: {} },
  ], labels: {} }), 'every(1d)->or(ciFailed("acme/api"))');
});

test("a sentence ends with a full stop, unless its last quote already ends it", async () => {
  const { sentence } = await import("../../playground/src/story.ts");
  const { plain } = await import("../../playground/src/words.ts");
  assert.equal(plain(sentence(["Waiting for ", { kind: "quote", text: "Is it hot?" }])), "Waiting for “Is it hot?”");
  assert.equal(plain(sentence(["Waiting until ", { kind: "time", text: "2026-11-07 10:00 UTC" }])), "Waiting until 2026-11-07 10:00 UTC.");
});
