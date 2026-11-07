/**
 * The review at the top of the run column: the checker's diagnostics in its
 * own words, what the program may do, and the types of its top-level
 * bindings.
 */
import type { CheckDiagnostic, EffectSummary } from "../../src/frontend/check/index.ts";
import { named, problemCount, type CheckReport } from "./check.ts";

/** What each effect family does, in words, for the effects summary. */
const FAMILY_WORDS: Record<string, string> = {
  ask: "asks, and waits for the answer",
  run: "hands over a task, and waits for its report",
  request: "asks without waiting",
  start: "hands over a task without waiting",
  wait: "waits for a request, a fact or a stream",
  cancel: "calls a request off",
  handOver: "gives a request to someone else",
  say: "posts a message",
  judge: "asks the host’s judge whether a condition holds",
};

export interface Panels {
  /** Shows a checked version of the program. */
  show(report: CheckReport): void;
  /** Shows that the checker itself failed on this version. */
  fail(message: string): void;
  /** Brings the problems into view, as Restart does when the program does not type-check. */
  revealProblems(): void;
}

export function createPanels(root: HTMLElement, onReveal: (diagnostic: CheckDiagnostic) => void): Panels {
  return {
    show(report) {
      root.replaceChildren(
        ...(report.diagnostics.length === 0 ? [] : [section("problems", "Problems", problemList(report.diagnostics, onReveal))]),
        ...(report.effects === null ? [] : [section("effects", "Effects", ...effectsSummary(report.effects))]),
        ...(report.bindings.length === 0 ? [] : [typeList(report.bindings)]),
      );
    },
    fail(message) {
      root.replaceChildren(section("problems", "Problems", el("p", { class: "failure" }, `The checker failed on this program: ${message}`)));
    },
    revealProblems() {
      const problems = root.querySelector(".review-problems");
      problems?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      problems?.querySelector("button")?.focus({ preventScroll: true });
    },
  };
}

function section(id: string, title: string, ...body: HTMLElement[]): HTMLElement {
  return el("section", { class: `review-section review-${id}`, "aria-labelledby": `${id}-heading` }, el("h3", { id: `${id}-heading` }, title), ...body);
}

function problemList(diagnostics: readonly CheckDiagnostic[], onReveal: (diagnostic: CheckDiagnostic) => void): HTMLElement {
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

function effectsSummary(effects: readonly EffectSummary[]): HTMLElement[] {
  const note = el("p", { class: "note" }, "Review information: what this program may do, and whom it names. It grants nothing; the host checks each effect when it happens.");
  if (effects.length === 0) return [el("p", { class: "quiet" }, "This program performs no effects."), note];
  const table = el("dl", { class: "effects" });
  for (const effect of effects) {
    table.append(el("div", { class: "effect" },
      el("dt", {}, el("code", { class: "effect-family" }, effect.family)),
      el("dd", {},
        ...effect.targets.map((target) => el("code", { class: target.startsWith("@") ? "participant" : "ref" }, target)),
        el("span", { class: "effect-words" }, FAMILY_WORDS[effect.family] ?? ""))));
  }
  const { participants, refs } = named(effects);
  const all = [...participants, ...refs];
  const names = el("p", { class: "named" });
  if (all.length === 0) names.append("It names no participant.");
  else {
    names.append("It names ");
    all.forEach((name, index) => {
      if (index > 0) names.append(index === all.length - 1 ? " and " : ", ");
      names.append(el("code", { class: name.startsWith("@") ? "participant" : "ref" }, name));
    });
    names.append(".");
  }
  return [table, names, note];
}

function typeList(bindings: readonly { name: string; type: string }[]): HTMLElement {
  const list = el("dl", { class: "types" });
  for (const binding of bindings) {
    list.append(el("div", { class: "binding" }, el("dt", {}, el("code", {}, binding.name)), el("dd", {}, el("code", {}, binding.type))));
  }
  return el("details", { class: "review-section review-types" }, el("summary", {}, el("h3", {}, "Types")), list);
}

/** The small glyph before a problem or in the status: a cross for an error, a triangle for a warning, a tick. */
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
