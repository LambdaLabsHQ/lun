/**
 * The playground page: the editor, the checker in its worker, the review
 * column, the examples menu and the program in the URL fragment.
 */
import exampleFiles from "norn:examples";
import { problemCount, type CheckReport } from "./check.ts";
import { createEditor, replaceDoc, reveal, setWrapping, showDiagnostics } from "./editor.ts";
import { describeExamples, type Example } from "./examples.ts";
import { createPanels, el, icon } from "./panels.ts";
import type { CheckReply, CheckRequest } from "./protocol.ts";
import { fragmentFor, readFragment, type Fragment } from "./share.ts";

const examples = describeExamples(exampleFiles);
const fallback = examples.find((example) => example.name === "decide") ?? examples[0]!;

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const statusLine = byId<HTMLElement>("status");
const programName = byId<HTMLElement>("program-name");
const notice = byId<HTMLElement>("notice");

if (LIVE_RELOAD) new EventSource("/esbuild").addEventListener("change", () => location.reload());

setUpTheme(byId<HTMLButtonElement>("theme"));

// The program --------------------------------------------------------------------

const initial = await programFrom(await readFragment(location.hash));
const view = createEditor({ parent: byId("editor"), doc: initial, onChange: changed });
nameProgram();

const narrow = matchMedia("(max-width: 720px)");
setWrapping(view, narrow.matches);
narrow.addEventListener("change", () => setWrapping(view, narrow.matches));

/** The program a fragment names; an example, and a notice, when it names none that can be read. */
async function programFrom(fragment: Fragment): Promise<string> {
  switch (fragment.kind) {
    case "code":
      return fragment.source;
    case "example": {
      const example = examples.find((candidate) => candidate.name === fragment.name);
      if (example !== undefined) return example.source;
      say(`There is no example named “${fragment.name}”, so here is ${fallback.file}.`);
      return fallback.source;
    }
    case "unreadable":
      say(`The program in this link could not be read, so here is ${fallback.file}.`);
      return fallback.source;
    case "none":
      return fallback.source;
  }
}

/** The unedited example the editor holds, if it holds one. */
function currentExample(): Example | null {
  const text = view.state.doc.toString();
  return examples.find((example) => example.source === text) ?? null;
}

function nameProgram(): void {
  programName.textContent = currentExample()?.file ?? "Your program";
}

function say(message: string): void {
  notice.textContent = message;
  notice.hidden = message === "";
}

let checkTimer: ReturnType<typeof setTimeout> | undefined;
let fragmentTimer: ReturnType<typeof setTimeout> | undefined;

function changed(): void {
  nameProgram();
  say("");
  clearTimeout(checkTimer);
  checkTimer = setTimeout(requestCheck, 250);
  clearTimeout(fragmentTimer);
  fragmentTimer = setTimeout(() => void syncFragment(), 400);
}

/** Keeps the fragment in step with the editor, without adding history entries for edits. */
async function syncFragment(): Promise<void> {
  clearTimeout(fragmentTimer);
  const fragment = await fragmentFor(view.state.doc.toString(), currentExample()?.name ?? null);
  if (fragment !== location.hash) history.replaceState(null, "", fragment);
}

addEventListener("hashchange", () => void followFragment());
addEventListener("popstate", () => void followFragment());

/** Loads the program a changed fragment names, as after Back or a pasted link. */
async function followFragment(): Promise<void> {
  const fragment = await readFragment(location.hash);
  if (fragment.kind === "none") return;
  const program = await programFrom(fragment);
  if (program !== view.state.doc.toString()) replaceDoc(view, program);
}

// Checking -----------------------------------------------------------------------

const panels = createPanels(byId("review"), (diagnostic) => reveal(view, diagnostic.span.start.offset, diagnostic.span.end.offset));
const worker = new Worker(new URL(CHECK_WORKER, import.meta.url), { type: "module" });
let sent = 0;
let busy = false;
/** The text of each request, by id, until its reply arrives. */
const pending = new Map<number, string>();

function requestCheck(): void {
  if (busy) return; // The reply to the current check asks again.
  const request: CheckRequest = { id: ++sent, source: view.state.doc.toString() };
  pending.set(request.id, request.source);
  busy = true;
  worker.postMessage(request);
}

worker.addEventListener("message", (event: MessageEvent<CheckReply>) => {
  const reply = event.data;
  const source = pending.get(reply.id);
  pending.delete(reply.id);
  busy = false;
  const current = view.state.doc.toString();
  if (source !== current) {
    // The text changed while it was checked; check what the editor holds now.
    requestCheck();
    return;
  }
  if ("failure" in reply) {
    panels.fail(reply.failure);
    showStatus("failure", "The checker failed");
    return;
  }
  show(reply.report);
});

worker.addEventListener("error", (event) => {
  busy = false;
  panels.fail(event.message || "the checking worker could not start");
  showStatus("failure", "The checker failed");
});

function show(report: CheckReport): void {
  showDiagnostics(view, report.diagnostics);
  panels.show(report);
  const errors = report.diagnostics.some((d) => d.severity === "error");
  const words = problemCount(report.diagnostics);
  showStatus(errors ? "error" : report.diagnostics.length > 0 ? "warning" : "ok", words.charAt(0).toUpperCase() + words.slice(1));
}

function showStatus(kind: "ok" | "error" | "warning" | "failure", text: string): void {
  statusLine.dataset.kind = kind;
  statusLine.replaceChildren(icon(kind === "failure" ? "error" : kind), el("span", {}, text));
}

requestCheck();

// Examples -----------------------------------------------------------------------

setUpExamples(byId<HTMLButtonElement>("examples-button"), byId<HTMLElement>("examples-menu"), (example) => {
  replaceDoc(view, example.source);
  history.pushState(null, "", `#example=${encodeURIComponent(example.name)}`);
  view.focus();
});

function setUpExamples(button: HTMLButtonElement, menu: HTMLElement, choose: (example: Example) => void): void {
  const items = examples.map((example) => {
    const item = el("button", { type: "button", role: "menuitem", tabindex: "-1", class: "example" },
      el("span", { class: "example-file" }, example.file),
      el("span", { class: "example-summary" }, example.summary));
    item.addEventListener("click", () => {
      close(false);
      choose(example);
    });
    return item;
  });
  menu.replaceChildren(...items);

  const open = (focus: number) => {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const current = currentExample();
    items.forEach((item, index) => item.setAttribute("aria-current", String(examples[index] === current)));
    items[focus]?.focus();
  };
  const close = (refocus: boolean) => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (refocus) button.focus();
  };
  const focusedIndex = () => items.indexOf(document.activeElement as HTMLButtonElement);

  button.addEventListener("click", () => (menu.hidden ? open(Math.max(0, examples.indexOf(currentExample()!))) : close(false)));
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open(event.key === "ArrowDown" ? 0 : items.length - 1);
    }
  });
  menu.addEventListener("keydown", (event) => {
    const index = focusedIndex();
    const move = (to: number) => {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") close(false);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target as Node) && !button.contains(event.target as Node)) close(false);
  });
}

// Copying the link ---------------------------------------------------------------

const copy = byId<HTMLButtonElement>("copy-link");
let copyTimer: ReturnType<typeof setTimeout> | undefined;
copy.addEventListener("click", async () => {
  await syncFragment();
  let text = "Link copied";
  try {
    await navigator.clipboard.writeText(location.href);
  } catch {
    text = "Copy the address bar";
  }
  copy.textContent = text;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copy.textContent = "Copy link"), 1600);
});

// Theme --------------------------------------------------------------------------

function setUpTheme(button: HTMLButtonElement): void {
  const root = document.documentElement;
  const system = matchMedia("(prefers-color-scheme: dark)");
  const current = (): "light" | "dark" => (root.dataset.theme as "light" | "dark" | undefined) ?? (system.matches ? "dark" : "light");
  const label = () => button.setAttribute("aria-label", current() === "dark" ? "Use the light theme" : "Use the dark theme");
  label();
  system.addEventListener("change", label);
  button.addEventListener("click", () => {
    const next = current() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("norn-theme", next);
    } catch {
      // Storage may be unavailable; the choice then lasts for this page.
    }
    label();
  });
}

