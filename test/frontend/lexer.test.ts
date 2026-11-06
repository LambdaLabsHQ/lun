import assert from "node:assert/strict";
import { test } from "node:test";
import { lex, type Token } from "../../src/frontend/index.ts";

function tokens(source: string): Token[] {
  const result = lex(source);
  assert.deepEqual(result.diagnostics, [], `unexpected lexical error in ${JSON.stringify(source)}`);
  return result.tokens.slice(0, -1);
}

function kinds(source: string): string[] {
  return tokens(source).map((token) => token.kind);
}

function only(source: string): Token {
  const all = tokens(source);
  assert.equal(all.length, 1, `expected one token in ${JSON.stringify(source)}`);
  return all[0]!;
}

function lexError(source: string): { message: string; line: number; column: number } {
  const { diagnostics } = lex(source);
  assert.ok(diagnostics.length > 0, `expected a lexical error in ${JSON.stringify(source)}`);
  const [first] = diagnostics;
  return { message: first!.message, line: first!.span.start.line, column: first!.span.start.column };
}

test("participants: names, instances and hyphens", () => {
  assert.deepEqual(
    tokens("@alice @codex:2 @auto @win-builder @x:007").map((token) => token.kind === "Participant" && [token.name, token.instance]),
    [["alice", null], ["codex", "2"], ["auto", null], ["win-builder", null], ["x", "7"]],
  );
  // A hyphen that ends a name, or a colon without digits, is not part of it.
  assert.deepEqual(kinds("@alice- 1"), ["Participant", "-", "Int"]);
  assert.deepEqual(kinds("{who: @alice}"), ["{", "Ident", ":", "Participant", "}"]);
});

test("references: doc and channel, with string escapes", () => {
  const doc = only(`doc"spec#syntax \\"v0\\""`);
  assert.equal(doc.kind, "Ref");
  assert.ok(doc.kind === "Ref" && doc.refKind === "doc" && doc.value === `spec#syntax "v0"`);
  const channel = only(`channel"general"`);
  assert.ok(channel.kind === "Ref" && channel.refKind === "channel" && channel.value === "general");
  // With a space it is an identifier and then a string.
  assert.deepEqual(kinds(`doc "x"`), ["Ident", "String"]);
});

test("time literals carry the instant and the written offset", () => {
  const utc = only("2026-11-07T12:00Z");
  assert.ok(utc.kind === "Time");
  assert.equal(utc.epochMs, Date.UTC(2026, 10, 7, 12, 0));
  assert.equal(utc.offsetMinutes, 0);
  assert.equal(utc.text, "2026-11-07T12:00Z");

  const east = only("2026-11-07T12:00:30+08:00");
  assert.ok(east.kind === "Time");
  assert.equal(east.epochMs, Date.UTC(2026, 10, 7, 4, 0, 30));
  assert.equal(east.offsetMinutes, 480);

  const west = only("2026-01-01T00:00-05:30");
  assert.ok(west.kind === "Time");
  assert.equal(west.epochMs, Date.UTC(2026, 0, 1, 5, 30));
  assert.equal(west.offsetMinutes, -330);

  const leap = only("2028-02-29T23:59:59Z");
  assert.ok(leap.kind === "Time" && leap.epochMs === Date.UTC(2028, 1, 29, 23, 59, 59));
  const early = only("0099-01-01T00:00Z");
  assert.ok(early.kind === "Time" && new Date(early.epochMs).toISOString() === "0099-01-01T00:00:00.000Z");
});

test("durations, integers and floats", () => {
  assert.deepEqual(
    tokens("30m 2h 1d 1w 007m").map((token) => token.kind === "Duration" && [token.amount, token.unit]),
    [["30", "m"], ["2", "h"], ["1", "d"], ["1", "w"], ["7", "m"]],
  );
  const big = only("123456789012345678901234567890");
  assert.ok(big.kind === "Int" && big.value === "123456789012345678901234567890");
  assert.ok(only("007").kind === "Int" && (only("007") as Token & { value: string }).value === "7");
  assert.deepEqual(
    tokens("1.5 2e-3 1E5 0.25").map((token) => token.kind === "Float" && token.value),
    [1.5, 0.002, 100000, 0.25],
  );
  // A dot that is not followed by a digit is field access.
  assert.deepEqual(kinds("1.foo"), ["Int", ".", "Ident"]);
});

test("string escapes are decoded", () => {
  const token = only(String.raw`"a\nb\tc\\d\"e\'fé\u{1F600}\$\`"`);
  assert.ok(token.kind === "String");
  assert.equal(token.value, "a\nb\tc\\d\"e'fé\u{1F600}$`");
});

test("templates split around their interpolations, which may nest", () => {
  const all = tokens("`a ${x} b ${ {k: `in ${y}`}.k } c`");
  assert.deepEqual(
    all.map((token) => [token.kind, "value" in token ? token.value : token.text]),
    [
      ["TemplateHead", "a "],
      ["Ident", "x"],
      ["TemplateMiddle", " b "],
      ["{", "{"],
      ["Ident", "k"],
      [":", ":"],
      ["TemplateHead", "in "],
      ["Ident", "y"],
      ["TemplateTail", ""],
      ["}", "}"],
      [".", "."],
      ["Ident", "k"],
      ["TemplateTail", " c"],
    ],
  );
  const multiline = only("`one\r\ntwo\\n`");
  assert.ok(multiline.kind === "TemplateFull" && multiline.value === "one\ntwo\n");
});

test("keywords, names, type variables and punctuation", () => {
  assert.deepEqual(
    kinds("let rec and if else switch type open true false as letter Ship _ _x 'a"),
    ["let", "rec", "and", "if", "else", "switch", "type", "open", "true", "false", "as", "Ident", "UIdent", "Underscore", "Ident", "TypeVar"],
  );
  assert.deepEqual(
    kinds("... => -> == != <= >= && || ++ +. -. *. /. ( ) [ ] { } , ; : . = | ~ ? ! < > + - * /"),
    ["...", "=>", "->", "==", "!=", "<=", ">=", "&&", "||", "++", "+.", "-.", "*.", "/.", "(", ")", "[", "]", "{", "}", ",", ";", ":", ".", "=", "|", "~", "?", "!", "<", ">", "+", "-", "*", "/"],
  );
});

test("comments are skipped, and block comments do not nest", () => {
  assert.deepEqual(kinds("a // b c\nd /* e\nf */ g"), ["Ident", "Ident", "Ident"]);
  assert.deepEqual(kinds("/* a /* b */ c"), ["Ident"]);
});

test("positions count lines, code points and UTF-16 offsets", () => {
  const all = tokens('\tx "😀" y\r\n  z');
  assert.deepEqual(all[0]!.span.start, { line: 1, column: 2, offset: 1 });
  assert.deepEqual(all[1]!.span, { start: { line: 1, column: 4, offset: 3 }, end: { line: 1, column: 7, offset: 7 } });
  assert.deepEqual(all[2]!.span.start, { line: 1, column: 8, offset: 8 });
  assert.deepEqual(all[3]!.span.start, { line: 2, column: 3, offset: 13 });
  const eof = lex("a\n").tokens.at(-1)!;
  assert.equal(eof.kind, "EOF");
  assert.deepEqual(eof.span.start, { line: 2, column: 1, offset: 2 });
  assert.deepEqual(tokens("﻿x")[0]!.span.start, { line: 1, column: 1, offset: 1 });
});

test("lexical errors say what is wrong and where", () => {
  const cases: [string, string, number, number][] = [
    ["let x = 1 # 2", "unexpected character '#'", 1, 11],
    ["x y", "unexpected character U+00A0", 1, 2],
    ['say(@alice, "hi)\n', "unterminated string: a string ends on its own line; use \\n for a line break, or a template string", 1, 13],
    ["`abc ${x}", "unterminated template string", 1, 1],
    ["x /* never closed", "unterminated comment: '/*' has no matching '*/'", 1, 3],
    [String.raw`"a\qb"`, String.raw`unknown escape sequence: '\' followed by 'q'; the escapes are \n \r \t \\ \" \' \` \$ and \u`, 1, 3],
    [String.raw`"\u{110000}"`, String.raw`invalid unicode escape: use \uXXXX or \u{X…} with a code point up to 10FFFF`, 1, 2],
    ["2026-11-07", "a time literal needs a time of day and an offset, as in 2026-11-07T12:00Z", 1, 1],
    ["2026-11-07T12:00", "a time literal needs an offset such as Z or +08:00, as in 2026-11-07T12:00Z", 1, 1],
    ["2026-11-07T12:00+0800", "a time literal needs an offset such as Z or +08:00, as in 2026-11-07T12:00Z", 1, 1],
    ["2026-13-07T12:00Z", "invalid month 13 in the time literal", 1, 1],
    ["2026-02-29T12:00Z", "invalid day 29 for 2026-02 in the time literal", 1, 1],
    ["2026-11-07T24:00Z", "invalid hour 24 in the time literal", 1, 1],
    ["2026-11-07T12:00Zed", "unexpected 'e' after the time literal", 1, 18],
    ["30s", "unknown duration unit 's' in '30s': a duration is a whole number followed by m, h, d or w, as in 90m", 1, 1],
    ["1.5h", "invalid duration '1.5h': a duration is a whole number followed by m, h, d or w, as in 90m", 1, 1],
    ["1.5x", "unexpected 'x' after the number 1.5", 1, 1],
    ["1e999", "float literal 1e999 is out of range", 1, 1],
    ["@ alice", "expected a participant name after '@', as in @alice", 1, 1],
    ['foo"x"', `unknown reference kind 'foo': a reference is doc"…" or channel"…"`, 1, 1],
    ["'1", "expected a type variable such as 'a after the quote; strings use double quotes", 1, 1],
  ];
  for (const [source, message, line, column] of cases) {
    assert.deepEqual(lexError(source), { message, line, column }, source);
  }
});

test("the lexer reports several errors in one pass", () => {
  const { diagnostics } = lex("a # b\nc $ d");
  assert.deepEqual(diagnostics.map((d) => [d.message, d.span.start.line]), [
    ["unexpected character '#'", 1],
    ["unexpected character '$'", 2],
  ]);
});
