/**
 * The code editor: CodeMirror 6, highlighted by Norn's own lexer, with the
 * checker's diagnostics drawn inline.
 */
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import { bracketMatching, indentService, indentUnit, type IndentContext } from "@codemirror/language";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import {
  Decoration, EditorView, GutterMarker, ViewPlugin, drawSelection, gutterLineClass, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, type DecorationSet, type ViewUpdate,
} from "@codemirror/view";
import type { CheckDiagnostic } from "../../src/frontend/check/index.ts";
import { highlights, type Highlight, type Style } from "./highlight.ts";

export interface EditorOptions {
  parent: HTMLElement;
  doc: string;
  /** Called after every change of the text. */
  onChange: (view: EditorView) => void;
  /** Mod-Enter: run the program. */
  onRun: () => boolean;
}

export function createEditor({ parent, doc, onChange, onRun }: EditorOptions): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [keymap.of([{ key: "Mod-Enter", run: onRun }]), ...extensions(onChange)] }),
  });
}

/** Replaces the whole text, as loading an example does: one undoable change. */
export function replaceDoc(view: EditorView, doc: string): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, selection: { anchor: 0 }, scrollIntoView: true });
}

/** Shows the checker's diagnostics inline. Their spans are offsets into the text they were checked on, which must be the editor's. */
export function showDiagnostics(view: EditorView, diagnostics: readonly CheckDiagnostic[]): void {
  const length = view.state.doc.length;
  const marks: Diagnostic[] = diagnostics.map((diagnostic) => {
    const from = Math.min(diagnostic.span.start.offset, length);
    return {
      from,
      to: Math.max(from, Math.min(diagnostic.span.end.offset, length)),
      severity: diagnostic.severity,
      message: diagnostic.message,
      source: diagnostic.code,
    };
  });
  const severities = new Map<number, "error" | "warning">();
  for (const mark of marks) {
    const line = view.state.doc.lineAt(mark.from).from;
    if (severities.get(line) !== "error") severities.set(line, mark.severity as "error" | "warning");
  }
  const lines = [...severities].sort(([a], [b]) => a - b).map(([from, severity]) => problemLine[severity].range(from));
  view.dispatch(setDiagnostics(view.state, marks), { effects: setProblemLines.of(RangeSet.of(lines)) });
}

/** The line numbers of lines with a problem take its colour, in place of a gutter of markers. */
class ProblemLine extends GutterMarker {
  constructor(severity: "error" | "warning") {
    super();
    this.elementClass = `cm-problemLine-${severity}`;
  }
}
const problemLine = { error: new ProblemLine("error"), warning: new ProblemLine("warning") };
const setProblemLines = StateEffect.define<RangeSet<GutterMarker>>();
const problemLines = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(lines, transaction) {
    let next = lines.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setProblemLines)) next = effect.value;
    return next;
  },
  provide: (field) => gutterLineClass.from(field),
});

/** Selects a range and brings it into view, as a click on a diagnostic does. */
export function reveal(view: EditorView, from: number, to: number): void {
  const length = view.state.doc.length;
  view.dispatch({
    selection: { anchor: Math.min(from, length), head: Math.min(to, length) },
    effects: EditorView.scrollIntoView(Math.min(from, length), { y: "center" }),
  });
  view.focus();
}

function extensions(onChange: (view: EditorView) => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    indentUnit.of("  "),
    indentService.of(indentation),
    EditorState.languageData.of(() => [{ commentTokens: { line: "//", block: { open: "/*", close: "*/" } } }]),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    problemLines,
    highlighter,
    EditorView.lineWrapping,
    hangingIndent,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, { key: "Mod-/", run: toggleComment }, indentWithTab]),
    EditorView.contentAttributes.of({ "aria-label": "Norn program", spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
    EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged) onChange(update.view);
    }),
  ];
}

// Highlighting ---------------------------------------------------------------

const marks = new Map<Style, Decoration>();
const mark = (style: Style): Decoration => {
  let decoration = marks.get(style);
  if (decoration === undefined) {
    decoration = Decoration.mark({ class: `tok-${style}` });
    marks.set(style, decoration);
  }
  return decoration;
};

/** Lexes the text once per change, and decorates what is in view. */
const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private ranges: Highlight[];

    constructor(view: EditorView) {
      this.ranges = highlights(view.state.doc.toString());
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.ranges = highlights(update.state.doc.toString());
      if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
    }

    private build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        // The first range that ends after `from`: ranges are in order and do not overlap.
        let low = 0;
        let high = this.ranges.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (this.ranges[middle]!.to <= from) low = middle + 1;
          else high = middle;
        }
        for (let index = low; index < this.ranges.length && this.ranges[index]!.from < to; index += 1) {
          const range = this.ranges[index]!;
          builder.add(range.from, range.to, mark(range.style));
        }
      }
      return builder.finish();
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// Wrapping -------------------------------------------------------------------

const indents = new Map<number, Decoration>();

/**
 * A long line wraps, and its continuation starts two columns in from where
 * the line's own text starts, so wrapping never looks like a new line.
 */
const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
    }

    private build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to;) {
          const line = view.state.doc.lineAt(pos);
          const columns = /^[ \t]*/.exec(line.text)![0].replace(/\t/g, "  ").length + 2;
          let decoration = indents.get(columns);
          if (decoration === undefined) {
            decoration = Decoration.line({ attributes: { style: `--hang: ${columns}ch` } });
            indents.set(columns, decoration);
          }
          builder.add(line.from, line.from, decoration);
          pos = line.to + 1;
        }
      }
      return builder.finish();
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// Indentation ----------------------------------------------------------------

/**
 * The indentation of the line at `pos`, in the style of the examples: two
 * spaces inside brackets and after `=>` or `=` at the end of a line, the
 * cases of a switch level with it, and a closing bracket level with the line
 * that opened it. Pressing Enter asks for the line after a simulated break at
 * `pos`, which `context` takes into account.
 */
function indentation(context: IndentContext, pos: number): number {
  if (/^\s*[}\])]/.test(context.textAfterPos(pos))) return openerIndent(context.state.doc, pos) ?? 0;
  let from = context.lineAt(pos, 1).from;
  while (from > 0) {
    const previous = context.lineAt(from - 1, -1);
    const code = previous.text.replace(/\/\/.*$/, "").trimEnd();
    if (code.trim() !== "") {
      const base = /^\s*/.exec(previous.text)![0].length;
      if (/^\s*switch\b.*\{$/.test(code)) return base;
      return /[{(\[]$|=>$|=$/.test(code) ? base + 2 : base;
    }
    from = previous.from;
  }
  return 0;
}

/** The indentation of the line holding the bracket that a closing bracket at `pos` closes. */
function openerIndent(doc: Text, pos: number): number | null {
  const text = doc.sliceString(0, pos);
  let depth = 0;
  for (let at = text.length - 1; at >= 0; at -= 1) {
    const character = text[at]!;
    if (character === "}" || character === ")" || character === "]") depth += 1;
    else if (character === "{" || character === "(" || character === "[") {
      if (depth === 0) return /^\s*/.exec(doc.lineAt(at).text)![0].length;
      depth -= 1;
    }
  }
  return null;
}
