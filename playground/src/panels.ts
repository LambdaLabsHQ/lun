/**
 * The review column: the checker's diagnostics in its own words, what the
 * program may do, and the types of its top-level bindings.
 */
import type { CheckDiagnostic, EffectSummary } from "../../src/frontend/check/index.ts";
import { named, problemCount, type CheckReport } from "./check.ts";

/** What each effect family does, in words, for the effects summary. */
const FAMILY_WORDS: Record<string, string> = {
  ask: "asks and waits for the answer",
  run: "hands over a task and waits for its report",
  request: "asks without waiting",
  start: "starts a task without waiting",
  wait: "waits for a request, fact or stream",
  cancel: "calls a request off",
  handOver: "gives a request to someone else",
  say: "posts a message",
  judge: "asks the host's judge whether a condition holds",
};

export interface Panels {
  /** Shows a checked version of the program. */
  show(report: CheckReport): void;
  /** Shows that the checker itself failed on this version. */
  fail(message: string): void;
}

export function createPanels(root: HTMLElement, onReveal: (diagnostic: CheckDiagnostic) => void): Panels {
  const problems = section(root, "problems", "Problems");
  const effects = section(root, "effects", "Effects");
  const types = section(root, "types", "Types");

  return {
    show(report) {
      problems.heading.textContent = "Problems";
      problems.body.replaceChildren(problemList(report.diagnostics, onReveal));
      effects.body.replaceChildren(...effectsSummary(report.effects));
      types.body.replaceChildren(typeList(report.bindings, report.ok));
    },
    fail(message) {
      problems.body.replaceChildren(paragraph(`The checker failed on this program: ${message}`, "failure"));
      effects.body.replaceChildren();
      types.body.replaceChildren();
    },
  };
}

function section(root: HTMLElement, id: string, title: string): { heading: HTMLElement; body: HTMLElement } {
  const element = el("section", { class: `review-section review-${id}`, "aria-labelledby": `${id}-heading` });
  const heading = el("h2", { id: `${id}-heading` }, title);
  const body = el("div", { class: "review-body" });
  element.append(heading, body);
  root.append(element);
  return { heading, body };
}

function problemList(diagnostics: readonly CheckDiagnostic[], onReveal: (diagnostic: CheckDiagnostic) => void): HTMLElement {
  if (diagnostics.length === 0) return paragraph("No problems. The program type-checks.", "quiet");
  const list = el("ol", { class: "problems", "aria-label": problemCount(diagnostics) });
  for (const diagnostic of diagnostics) {
    const { line, column } = diagnostic.span.start;
    const button = el("button", { type: "button", class: `problem problem-${diagnostic.severity}` });
    button.append(
      icon(diagnostic.severity),
      el("span", { class: "problem-message" }, diagnostic.message),
      el("span", { class: "problem-meta" },
        el("span", { class: "problem-where" }, `Line ${line}, column ${column}`),
        el("code", { class: "problem-code" }, diagnostic.code)),
    );
    button.addEventListener("click", () => onReveal(diagnostic));
    list.append(el("li", {}, button));
  }
  return list;
}

function effectsSummary(effects: readonly EffectSummary[] | null): HTMLElement[] {
  if (effects === null) return [paragraph("Shown once the program type-checks.", "quiet")];
  const note = paragraph("For review: what this program may do and whom it names. Naming a participant grants nothing; the host checks each effect when it happens.", "note");
  if (effects.length === 0) return [paragraph("This program performs no effects.", "quiet"), note];
  const table = el("dl", { class: "effects" });
  for (const effect of effects) {
    const targets = el("span", { class: "effect-targets" });
    for (const target of effect.targets) targets.append(el("code", { class: target.startsWith("@") ? "participant" : "ref" }, target));
    table.append(
      el("div", { class: "effect" },
        el("dt", {}, el("code", { class: "effect-family" }, effect.family)),
        el("dd", {}, el("span", { class: "effect-words" }, FAMILY_WORDS[effect.family] ?? ""), targets)),
    );
  }
  const { participants, refs } = named(effects);
  const names = el("p", { class: "named" });
  if (participants.length === 0 && refs.length === 0) names.append("It names no participant.");
  else {
    names.append("It names ");
    const all = [...participants, ...refs];
    all.forEach((name, index) => {
      if (index > 0) names.append(index === all.length - 1 ? " and " : ", ");
      names.append(el("code", { class: name.startsWith("@") ? "participant" : "ref" }, name));
    });
    names.append(".");
  }
  return [table, names, note];
}

function typeList(bindings: readonly { name: string; type: string }[], ok: boolean): HTMLElement {
  if (bindings.length === 0) return paragraph(ok ? "The program binds no names at its top level." : "Shown once the program parses.", "quiet");
  const list = el("dl", { class: "types" });
  for (const binding of bindings) {
    list.append(el("div", { class: "binding" }, el("dt", {}, el("code", {}, binding.name)), el("dd", {}, el("code", {}, binding.type))));
  }
  return list;
}

function paragraph(text: string, className: string): HTMLElement {
  return el("p", { class: className }, text);
}

/** The small glyph before a problem: a cross for an error, a triangle for a warning. */
export function icon(kind: "error" | "warning" | "ok"): SVGElement {
  const paths = {
    error: "M5 5l6 6M11 5l-6 6",
    warning: "M8 3.2l5.2 9.3H2.8z M8 7v2.6 M8 11.2v.1",
    ok: "M3.5 8.4l3 3 6-6.6",
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `glyph glyph-${kind}`);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[kind]);
  svg.append(path);
  return svg;
}

type Child = Node | string;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string>, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.append(...children);
  return element;
}
