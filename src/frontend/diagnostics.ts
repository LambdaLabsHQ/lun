import type { Span } from "./ast.ts";

/** A syntax error with the source range it is about. */
export interface Diagnostic {
  message: string;
  span: Span;
}

/** `message at file:line:column` */
export function diagnosticLine(diagnostic: Diagnostic, file: string): string {
  const { line, column } = diagnostic.span.start;
  return `${diagnostic.message} at ${file}:${line}:${column}`;
}

/**
 * The one-line form, then the source line with a caret under the range:
 *
 *     error: expected '=>' after pattern, found 'run' at examples/decide.norn:4:13
 *      4 | | Done(Skip) run(@auto, "Record the decision")
 *        |             ^^^
 */
export function formatDiagnostic(diagnostic: Diagnostic, source: string, file: string): string {
  const { start, end } = diagnostic.span;
  const text = (source.split("\n")[start.line - 1] ?? "").replace(/\r$/, "");
  const characters = [...text];
  const indent = characters
    .slice(0, start.column - 1)
    .map((character) => (character === "\t" ? "\t" : " "))
    .join("");
  const lastColumn = end.line === start.line ? end.column : characters.length + 1;
  const carets = "^".repeat(Math.max(1, lastColumn - start.column));
  const gutter = " ".repeat(String(start.line).length);
  return [
    `error: ${diagnosticLine(diagnostic, file)}`,
    ` ${start.line} | ${text}`,
    ` ${gutter} | ${indent}${carets}`,
  ].join("\n");
}
