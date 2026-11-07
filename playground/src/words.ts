/**
 * Values, times and waits in words, for the simulation. Pure: the page turns
 * these runs of text into elements, styling each kind of run.
 */
import type { Value } from "../../src/runtime/browser.ts";

/** A piece of a sentence: plain text, or text the page styles by kind. */
export type Run = string | { kind: "participant" | "quote" | "code" | "time"; text: string };

/** `2026-11-07 12:00 UTC`, with seconds only when there are some. */
export function formatTime(ms: number): string {
  const iso = new Date(ms).toISOString();
  const seconds = iso.slice(17, 19);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}${seconds === "00" ? "" : `:${seconds}`} UTC`;
}

/** The time of day alone, as the timeline shows it: `12:00`. */
export function formatTimeOfDay(ms: number): string {
  const iso = new Date(ms).toISOString();
  const seconds = iso.slice(17, 19);
  return `${iso.slice(11, 16)}${seconds === "00" ? "" : `:${seconds}`}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `Saturday 7 November 2026`, in UTC, the same in every browser. */
export function formatDate(ms: number): string {
  const date = new Date(ms);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** `Sunday`. */
export function formatWeekday(ms: number): string {
  return WEEKDAYS[new Date(ms).getUTCDay()]!;
}

/** A duration as Norn writes it: `1h`, `90m`, `2d`; `1d 2h` when no single unit fits. */
export function formatDuration(ms: number): string {
  const units: [string, number][] = [["w", 604_800_000], ["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]];
  for (const [unit, size] of units) if (ms !== 0 && ms % size === 0) return `${ms / size}${unit}`;
  const parts: string[] = [];
  let rest = ms;
  for (const [unit, size] of units.slice(1)) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }
  if (rest > 0 || parts.length === 0) parts.push(`${rest / 1000}s`);
  return parts.join(" ");
}

/** A value as Norn source would write it: strings quoted, `Done({text: "ok"})`, `@alice`, `2026-11-07T12:00Z`. */
export function literal(value: Value): string {
  switch (value.type) {
    case "unit":
      return "()";
    case "bool":
      return String(value.value);
    case "string":
      return JSON.stringify(value.value);
    case "int":
    case "float":
      return value.value;
    case "time":
      return new Date(Number(value.value)).toISOString().replace(/:00\.000Z$/, "Z").replace(/\.000Z$/, "Z");
    case "duration":
      return formatDuration(Number(value.value));
    case "participant": {
      const labels = Object.entries(value.labels);
      const name = `@${value.name}${value.instance === null ? "" : `:${value.instance}`}`;
      return labels.length === 0 ? name : `${name}(${labels.map(([label, item]) => `~${label}=${literal(item)}`).join(", ")})`;
    }
    case "ref":
      return `${value.kind}${JSON.stringify(value.value)}`;
    case "variant":
      return value.args.length === 0 ? value.name : `${value.name}(${value.args.map(literal).join(", ")})`;
    case "list":
      return `[${value.values.map(literal).join(", ")}]`;
    case "tuple":
      return `(${value.values.map(literal).join(", ")})`;
    case "record":
      return `{${Object.entries(value.fields).map(([name, field]) => `${name}: ${literal(field)}`).join(", ")}}`;
    case "closure":
    case "builtin":
      return "a function";
    case "request":
      return "a request";
    case "source":
      return source(value);
  }
}

/** A fact or stream as the program made it: `merged("acme/api#1436")`, `ciFailed("acme/api")->or(every(1d))`. */
export function source(value: Extract<Value, { type: "source" }>): string {
  if (value.name === "merge" || value.name === "or") {
    const [first, second] = value.args;
    return `${first === undefined ? "?" : literal(first)}->${value.name}(${second === undefined ? "?" : literal(second)})`;
  }
  const args = [
    ...value.args.map(literal),
    ...Object.entries(value.labels).map(([label, item]) => `~${label}=${literal(item)}`),
  ];
  return `${value.name}(${args.join(", ")})`;
}

/** A participant's name from its shown form, as stored on a request: `@alice`. */
export function participant(name: string): Run {
  return { kind: "participant", text: name };
}

export function quote(text: string): Run {
  return { kind: "quote", text };
}

export function code(text: string): Run {
  return { kind: "code", text };
}

export function time(ms: number): Run {
  return { kind: "time", text: formatTime(ms) };
}

/** Runs joined as plain text, for tests and for accessible labels. */
export function plain(runs: readonly Run[]): string {
  return runs.map((run) => (typeof run === "string" ? run : run.kind === "quote" ? `“${run.text}”` : run.text)).join("");
}

/** "a, b or c" over runs. */
export function either(items: readonly Run[][]): Run[] {
  return items.flatMap((item, index) => [...(index === 0 ? [] : [index === items.length - 1 ? " or " : ", "]), ...item]);
}
