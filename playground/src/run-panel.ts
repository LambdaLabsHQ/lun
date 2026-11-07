/**
 * The run column: the virtual clock, the program's thread of events, and at
 * its end what the program waits for now, with the controls to play the team
 * and the world.
 */
import { fieldFor, sourceValue, valueOf, type Field, type Host, type HostExternal } from "./host.ts";
import { el } from "./panels.ts";
import { fieldInput, type FieldInput } from "./forms.ts";
import type { Value } from "../../src/runtime/browser.ts";
import type { AwaitedEvent, OpenRequest, Simulation, SimulationState } from "./simulation.ts";
import { sentence, tell } from "./story.ts";
import { formatDate, formatTime, formatTimeOfDay, formatWeekday, source as sourceText, type Run } from "./words.ts";

export interface RunElements {
  /** The scrolling part of the column, which follows the thread's end. */
  body: HTMLElement;
  clockTime: HTMLElement;
  clockDate: HTMLElement;
  hour: HTMLButtonElement;
  day: HTMLButtonElement;
  next: HTMLButtonElement;
  thread: HTMLOListElement;
  now: HTMLElement;
}

export interface RunPanel {
  /** Shows a running simulation, from its start. */
  attach(simulation: Simulation): void;
  /** Shows that nothing runs: the program does not type-check. */
  refuse(): void;
  /** Shows that the program could not start. */
  stop(message: string): void;
}

type Source = Extract<Value, { type: "source" }>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function createRunPanel(elements: RunElements, host: Host): RunPanel {
  let simulation: Simulation | null = null;
  let shown = 0;
  let lastDay = "";
  let nowSignature = "";
  let frame = 0;
  let unsubscribe = () => {};

  const externals = new Map(host.externals.map((external) => [external.name, external]));

  /** Runs a move; a run restarted meanwhile refuses it, which is no error. */
  const move = (work: Promise<unknown> | undefined): Promise<unknown> => (work ?? Promise.resolve()).catch(() => {});

  elements.hour.addEventListener("click", () => void move(simulation?.advance(HOUR)));
  elements.day.addEventListener("click", () => void move(simulation?.advance(DAY)));
  elements.next.addEventListener("click", () => {
    const next = simulation?.state.nextDeadline;
    if (next !== null && next !== undefined) void move(simulation?.advanceTo(next));
  });

  function schedule(): void {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (simulation !== null) render(simulation.state);
    });
  }

  function render(state: SimulationState): void {
    const following = isFollowing();
    elements.clockTime.textContent = `${formatTimeOfDay(state.now)} UTC`;
    elements.clockDate.textContent = formatDate(state.now);
    const ended = !["ready", "suspended"].includes(state.status);
    for (const button of [elements.hour, elements.day]) button.disabled = ended || state.computing;
    elements.next.disabled = ended || state.computing || state.nextDeadline === null;
    elements.next.textContent = state.nextDeadline === null ? "To the next deadline" : `To ${deadlineLabel(state.now, state.nextDeadline)}`;

    // The wait the program is in now is told at the thread's end, with what can end it.
    const last = state.timeline.at(-1);
    const visible = state.waiting !== null && last?.kind === "waiting" ? state.timeline.length - 1 : state.timeline.length;
    for (; shown < visible; shown += 1) {
      const entry = state.timeline[shown]!;
      const day = formatDate(entry.at);
      if (day !== lastDay) {
        elements.thread.append(el("li", { class: "day" }, day));
        lastDay = day;
      }
      const line = tell(entry);
      elements.thread.append(el("li", { class: `knot tone-${line.tone}${line.end ? " end" : ""}` },
        el("time", { class: "knot-time", datetime: new Date(entry.at).toISOString() }, formatTimeOfDay(entry.at)),
        el("p", { class: "knot-text" }, ...runs(line.runs)),
        ...(line.detail === null ? [] : [el("p", { class: "knot-detail" }, ...runs(line.detail))])));
    }

    const signature = JSON.stringify([state.now, state.status, state.computing, state.error, state.waiting, state.requests.map((r) => [r.id, r.epoch, r.awaited]), state.events]);
    if (signature !== nowSignature) {
      nowSignature = signature;
      elements.now.replaceChildren(...nowPanel(state));
    }
    if (following) elements.body.scrollTop = elements.body.scrollHeight;
  }

  /** Whether the column shows its end, so new entries should keep it in view. */
  function isFollowing(): boolean {
    const body = elements.body;
    return body.scrollHeight - body.scrollTop - body.clientHeight < 48;
  }

  function nowPanel(state: SimulationState): HTMLElement[] {
    if (state.error !== null) return [el("p", { class: "now-sentence failure" }, `The runtime stopped: ${state.error}`)];
    if (state.status === "completed" || state.status === "failed" || state.status === "revoked" || state.status === "cancelled") {
      return [el("p", { class: "now-sentence quiet" }, "The program has ended. Restart it to play again.")];
    }
    if (state.computing || state.waiting === null) {
      return [el("p", { class: "now-sentence" }, "Computing. A program that never waits runs until you restart it.")];
    }
    const today = formatDate(state.now);
    const parts: HTMLElement[] = [
      ...(today === lastDay ? [] : [el("p", { class: "now-day" }, today)]),
      el("time", { class: "now-time", datetime: new Date(state.now).toISOString() }, formatTimeOfDay(state.now)),
      el("p", { class: "now-sentence" }, ...runs(sentence(["Waiting ", ...state.waiting.targets, ...state.waiting.deadline]))),
    ];
    for (const request of state.requests) parts.push(requestCard(request));
    for (const event of state.events) parts.push(eventCard(event));
    parts.push(otherEvents());
    return parts;
  }

  // Requests -------------------------------------------------------------------------

  function requestCard(request: OpenRequest): HTMLElement {
    const card = el("article", { class: "card", "aria-label": `${request.holder}: ${request.text}` });
    const actions = el("div", { class: "card-actions" });
    const reason = el("form", { class: "card-reason", hidden: "" });
    const busy = (work: () => Promise<unknown>) => {
      const controls = [...card.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input, select, textarea")];
      for (const control of controls) control.disabled = true;
      void move(work()).finally(() => {
        for (const control of controls) control.disabled = false;
      });
    };

    const who: Run[] =
      request.name === "judge" ? ["The judge decides this. Decide as the judge."]
      : request.name === "run" ? [{ kind: "participant", text: request.holder }, " has this task. Finish it as them."]
      : [{ kind: "participant", text: request.holder }, " is asked. Answer as them."];
    const due: Run[] = request.by === null ? [] : [" With no reply by ", { kind: "time", text: formatTime(request.by) }, ", it ends as no reply."];
    card.append(
      el("h3", { class: "card-question" }, request.text),
      el("p", { class: "card-who" }, ...runs(who), ...runs(due), ...(request.awaited ? [] : [" Nothing waits for it yet: the reply is kept until the program looks."])),
    );

    if (request.name === "judge") {
      for (const verdict of [true, false]) {
        const button = el("button", { type: "button", class: "choice" }, String(verdict));
        button.addEventListener("click", () => busy(() => simulation!.answer(request.id, { type: "bool", value: verdict })));
        actions.append(button);
      }
    } else if (request.options !== null) {
      for (const option of request.options) {
        const button = el("button", { type: "button", class: "choice mono" }, option.type === "variant" ? option.name : "?");
        button.addEventListener("click", () => busy(() => simulation!.answer(request.id, option)));
        actions.append(button);
      }
    } else {
      const report = request.name === "run";
      const field: Field = report ? fieldFor({ kind: "TypeName", name: "report", args: [], span: SPAN }, host.types) : { kind: "text", type: "string" };
      const input = fieldInput(field, report ? "Report" : "Answer", "", true);
      const form = el("form", { class: "card-answer" }, input.element, el("button", { type: "submit", class: "choice" }, report ? "Finish" : "Answer"));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const read = valueOf(field, input.read());
        if (!read.ok) return problem(form, read.message);
        busy(() => simulation!.answer(request.id, read.value));
      });
      actions.append(form);
    }

    const refusals = el("span", { class: "card-refusals" });
    // Any request can be refused, or broken: tried, and not done.
    for (const [label, verb] of [["Refuse…", "refuse"], ["Broke…", "broke"]] as const) {
      const button = el("button", { type: "button", class: "quiet-button" }, label);
      button.addEventListener("click", () => openReason(verb));
      refusals.append(button);
    }
    actions.append(refusals);

    const openReason = (verb: "refuse" | "broke") => {
      const input = el("input", { type: "text", "aria-label": verb === "refuse" ? "Why refuse" : "What went wrong", placeholder: verb === "refuse" ? "Why refuse?" : "What went wrong?", autocomplete: "off" });
      reason.replaceChildren(input,
        el("button", { type: "submit", class: "choice" }, verb === "refuse" ? "Refuse" : "Broke"),
        el("button", { type: "button", class: "quiet-button", "data-cancel": "" }, "Cancel"));
      reason.hidden = false;
      reason.querySelector("[data-cancel]")!.addEventListener("click", () => (reason.hidden = true));
      reason.onsubmit = (event) => {
        event.preventDefault();
        const why = input.value.trim() || (verb === "refuse" ? "Refused without a reason" : "Could not do it, without a reason");
        busy(() => (verb === "refuse" ? simulation!.refuse(request.id, why) : simulation!.broke(request.id, why)));
      };
      input.focus();
    };

    card.append(actions, reason);
    return card;
  }

  // Facts and streams ------------------------------------------------------------------

  function eventCard(event: AwaitedEvent): HTMLElement {
    const external = externals.get(event.source.name);
    const card = el("article", { class: "card card-event" },
      el("h3", { class: "card-question mono" }, sourceText(event.source)),
      el("p", { class: "card-who" }, event.mode === "fact" ? "A fact the program waits for. Make it hold:" : "A stream the program listens to. Make it happen:"));
    if (external === undefined) {
      card.append(el("p", { class: "form-hint" }, "The host interface does not declare this."));
      return card;
    }
    if (external.doc !== "") card.append(el("p", { class: "card-doc" }, external.doc));
    card.append(fireForm(external, () => event.source, defaultValue(event.source)));
    return card;
  }

  /** The form for the value an occurrence carries, then Fire. */
  function fireForm(external: HostExternal, source: () => Source | string, initial: string): HTMLElement {
    const field = fieldFor(external.element, host.types);
    const input = fieldInput(field, "Value", initial);
    const form = el("form", { class: "card-answer" }, input.element, el("button", { type: "submit", class: "choice" }, external.kind === "fact" ? "Make it hold" : "Fire"));
    form.addEventListener("submit", (submit) => {
      submit.preventDefault();
      const made = source();
      if (typeof made === "string") return problem(form, made);
      const read = valueOf(field, input.read());
      if (!read.ok) return problem(form, read.message);
      const controls = [...form.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input, select")];
      for (const control of controls) control.disabled = true;
      void move(simulation!.fire(made, read.value)).finally(() => {
        for (const control of controls) control.disabled = false;
      });
    });
    return form;
  }

  /** Any fact or stream the host declares, with its arguments: for one the program has not reached yet. */
  function otherEvents(): HTMLElement {
    const details = el("details", { class: "other-events" }, el("summary", {}, "Fire another fact or stream"));
    const select = el("select", { "aria-label": "Fact or stream" }, ...host.externals.map((external) => el("option", { value: external.name }, `${external.name} (${external.kind})`)));
    const body = el("div", { class: "other-body" });
    const choose = () => {
      const external = externals.get(select.value)!;
      const params: { label: string; field: Field; input: FieldInput; optional: boolean }[] = external.params.map((param, index) => {
        const field = fieldFor(param.type, host.types);
        const label = param.label === null ? `Argument ${index + 1}` : `~${param.label}${param.optional ? ", or empty" : ""}`;
        return { label, field, input: fieldInput(field, label), optional: param.optional };
      });
      const made = () => {
        const args = [];
        for (const param of params) {
          const typed = param.input.read();
          if (param.optional && typed === "") {
            args.push(null);
            continue;
          }
          const read = valueOf(param.field, typed);
          if (!read.ok) return `${param.label}: ${read.message}`;
          args.push(read.value);
        }
        return sourceValue(external, args) as Source;
      };
      body.replaceChildren(
        ...(external.doc === "" ? [] : [el("p", { class: "card-doc" }, external.doc)]),
        ...params.map((param) => param.input.element),
        fireForm(external, made, ""),
      );
    };
    select.addEventListener("change", choose);
    choose();
    details.append(el("div", { class: "form-row" }, select), body);
    return details;
  }

  return {
    attach(next) {
      unsubscribe();
      simulation = next;
      shown = 0;
      lastDay = "";
      nowSignature = "";
      elements.thread.replaceChildren();
      elements.now.replaceChildren();
      render(next.state);
      unsubscribe = next.onChanged(schedule);
    },
    stop(message) {
      this.refuse();
      elements.now.replaceChildren(el("p", { class: "now-sentence failure" }, `The program could not start: ${message}`));
    },
    refuse() {
      unsubscribe();
      simulation = null;
      shown = 0;
      lastDay = "";
      nowSignature = "";
      elements.thread.replaceChildren();
      elements.clockTime.textContent = "";
      elements.clockDate.textContent = "";
      for (const button of [elements.hour, elements.day, elements.next]) button.disabled = true;
      elements.now.replaceChildren(el("p", { class: "now-sentence quiet" }, "This program does not type-check, so it cannot run. Fix the problems, and it starts."));
    },
  };
}

/** "12:00", or "Sunday 09:00" when the deadline is on another day. */
function deadlineLabel(now: number, at: number): string {
  const sameDay = formatDate(now) === formatDate(at);
  return sameDay ? formatTimeOfDay(at) : `${formatWeekday(at)} ${formatTimeOfDay(at)}`;
}

/** A first value for an occurrence: the fact's first text argument, as for the pull request "acme/api#1436", or labelled one. */
function defaultValue(source: Source): string {
  const first = [...source.args, ...Object.values(source.labels)].find((arg) => arg.type === "string");
  return first?.type === "string" ? first.value : "";
}

function problem(form: HTMLElement, message: string): void {
  let note = form.querySelector(".form-problem");
  if (note === null) {
    note = el("p", { class: "form-problem", role: "alert" });
    form.append(note);
  }
  note.textContent = message;
}

/** Runs of words as inline elements. */
export function runs(items: readonly Run[]): (Node | string)[] {
  return items.map((run) => {
    if (typeof run === "string") return run;
    switch (run.kind) {
      case "participant":
        return el("span", { class: "participant" }, run.text);
      case "quote":
        return el("q", {}, run.text);
      case "code":
        return el("code", {}, run.text);
      case "time":
        return el("time", { class: "when" }, run.text);
    }
  });
}

const SPAN = { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } };

