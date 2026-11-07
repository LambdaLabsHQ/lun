/**
 * Syntax highlighting from Norn's own lexer, so the editor colours exactly the
 * tokens the parser reads: participants, references, times and durations
 * included. The lexer skips comments as trivia, so they are found in the gaps
 * between its tokens. Pure: the editor turns these ranges into decorations.
 */
import { builtinValues } from "../../src/frontend/check/builtins.ts";
import { lex, type Token } from "../../src/frontend/lexer.ts";

export type Style =
  | "comment"
  | "keyword"
  | "bool"
  | "string"
  | "interpolation"
  | "number"
  | "time"
  | "participant"
  | "ref"
  | "constructor"
  | "type"
  | "typeVar"
  | "label"
  | "effect"
  | "call"
  | "operator";

export interface Highlight {
  from: number;
  to: number;
  style: Style;
}

/** The built-ins that perform an effect (docs/types.md §8): the places where a program touches the world. */
const EFFECTS: ReadonlySet<string> = new Set(builtinValues().filter((builtin) => builtin.family !== null).map((builtin) => builtin.name));

const OPERATORS: ReadonlySet<string> = new Set([
  "=>", "->", "==", "!=", "<=", ">=", "&&", "||", "++", "+.", "-.", "*.", "/.", "|", "?", "!", "<", ">", "+", "-", "*", "/", "...", "=",
]);

/** Highlighted ranges of a source text, in order and without overlap. */
export function highlights(source: string): Highlight[] {
  const { tokens } = lex(source);
  const out: Highlight[] = [];
  let gapStart = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    gap(source, gapStart, token.span.start.offset, out);
    if (token.kind === "EOF") break;
    style(token, tokens[index - 1], tokens[index + 1], out);
    gapStart = token.span.end.offset;
  }
  return out;
}

function style(token: Token, previous: Token | undefined, next: Token | undefined, out: Highlight[]): void {
  const from = token.span.start.offset;
  const to = token.span.end.offset;
  const push = (style: Style, start = from, end = to) => {
    if (end > start) out.push({ from: start, to: end, style });
  };
  switch (token.kind) {
    case "let": case "rec": case "and": case "if": case "else": case "switch": case "type": case "open": case "as":
      return push("keyword");
    case "true": case "false":
      return push("bool");
    case "Int": case "Float":
      return push("number");
    case "Time": case "Duration":
      return push("time");
    case "Participant":
      return push("participant");
    case "Ref":
      return push("ref");
    case "String": case "TemplateFull":
      return push("string");
    case "TemplateHead":
      push("string", from, to - 2);
      return push("interpolation", to - 2, to);
    case "TemplateMiddle":
      push("interpolation", from, from + 1);
      push("string", from + 1, to - 2);
      return push("interpolation", to - 2, to);
    case "TemplateTail":
      push("interpolation", from, from + 1);
      return push("string", from + 1, to);
    case "UIdent":
      return push("constructor");
    case "TypeVar":
      return push("typeVar");
    case "Ident":
      if (previous?.kind === "~") return push("label", previous.span.start.offset, to);
      if (previous?.kind === "type") return push("type");
      if (next?.kind === "(" || previous?.kind === "->") return push(EFFECTS.has(token.text) ? "effect" : "call");
      return;
    default:
      if (OPERATORS.has(token.kind)) push("operator");
  }
}

/**
 * Comments in the text between two tokens. That text is whitespace and
 * comments, unless the lexer gave up on a token there: then a quote starts an
 * unfinished string, which is shown as one up to the end of its line, or of
 * the text for a template.
 */
function gap(source: string, from: number, to: number, out: Highlight[]): void {
  let at = from;
  while (at < to) {
    const character = source[at]!;
    if (source.startsWith("//", at)) {
      const end = lineEnd(source, at, to);
      out.push({ from: at, to: end, style: "comment" });
      at = end;
    } else if (source.startsWith("/*", at)) {
      const close = source.indexOf("*/", at + 2);
      const end = close === -1 || close + 2 > to ? to : close + 2;
      out.push({ from: at, to: end, style: "comment" });
      at = end;
    } else if (character === '"' || character === "`") {
      const end = character === '"' ? lineEnd(source, at, to) : to;
      out.push({ from: at, to: end, style: "string" });
      at = end;
    } else {
      at += 1;
    }
  }
}

function lineEnd(source: string, from: number, limit: number): number {
  const end = source.indexOf("\n", from);
  return end === -1 || end > limit ? limit : end;
}
