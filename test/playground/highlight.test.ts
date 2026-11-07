import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { highlights, type Style } from "../../playground/src/highlight.ts";

/** Each highlighted piece of text with its style, as "style text". */
function styled(source: string): string[] {
  return highlights(source).map(({ from, to, style }) => `${style} ${source.slice(from, to)}`);
}

test("Norn's literals, effects and ReScript's tokens each get their style", () => {
  const source = `// a comment
type probe = Ship | Skip
let q = request(@codex:2, "Overheating?")
let r = q->wait(~until=2026-11-07T12:00Z)? /* inline */
say(doc"ops#machines", \`waited \${30m->show} for \${r}\`)
let n = fold(1, 2.5, true, 'a)`;
  assert.deepEqual(styled(source), [
    "comment // a comment",
    "keyword type", "type probe", "operator =", "constructor Ship", "operator |", "constructor Skip",
    "keyword let", "operator =", "effect request", "participant @codex:2", 'string "Overheating?"',
    "keyword let", "operator =", "operator ->", "effect wait", "label ~until", "operator =", "time 2026-11-07T12:00Z", "operator ?",
    "comment /* inline */",
    "effect say", 'ref doc"ops#machines"', "string `waited ", "interpolation ${", "time 30m", "operator ->", "call show",
    "interpolation }", "string  for ", "interpolation ${", "interpolation }", "string `",
    "keyword let", "operator =", "call fold", "number 1", "number 2.5", "bool true", "typeVar 'a",
  ]);
});

test("an unfinished string or comment is shown as one while it is typed", () => {
  assert.deepEqual(styled('say(@alice, "https://example.com\nlet x = 1'), [
    "effect say", "participant @alice", 'string "https://example.com', "keyword let", "operator =", "number 1",
  ]);
  assert.deepEqual(styled("let x = 1 /* not closed\nlet y = 2"), ["keyword let", "operator =", "number 1", "comment /* not closed\nlet y = 2"]);
});

test("every example highlights in order, without overlaps", () => {
  const directory = new URL("../../examples/", import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".norn"))) {
    const source = readFileSync(new URL(file, directory), "utf8");
    const ranges = highlights(source);
    assert.ok(ranges.length > 0, file);
    let end = 0;
    for (const range of ranges) {
      assert.ok(range.from >= end && range.to > range.from, `${file}: ${JSON.stringify(range)}`);
      end = range.to;
    }
    const styles = new Set<Style>(ranges.map((range) => range.style));
    assert.ok(styles.has("comment") && styles.has("participant"), file);
  }
});
