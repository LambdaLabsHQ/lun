/**
 * The timeline in words: each entry of a simulation as a sentence, with a
 * tone the page shows as the colour of its knot on the thread. Pure.
 */
import type { Value } from "../../src/runtime/browser.ts";
import type { Entry, RequestInfo } from "./simulation.ts";
import { code, literal, participant, quote, time, type Run } from "./words.ts";

/**
 * - `reach`: the program asks someone, or hands a request over.
 * - `good`, `bad`: a request or the program ended well, or not.
 * - `quiet`: something cancelled, an answer not taken, or something said in passing.
 * - `wait`: the program waits; the thread goes slack until the next entry.
 * - `deadline`: a deadline passed: a request had no reply by its `~by`, or a `waitUntil` ran out.
 * - `world`: a fact or a stream occurrence the visitor fired.
 */
export type Tone = "reach" | "good" | "bad" | "quiet" | "wait" | "deadline" | "world" | "plain";

export interface Line {
  runs: Run[];
  /** A second, quieter line: the options of a request, and its deadline. */
  detail: Run[] | null;
  tone: Tone;
  /** The end of the program: shown larger. */
  end: boolean;
}

export function tell(entry: Entry): Line {
  const line = (runs: Run[], tone: Tone, detail: Run[] | null = null, end = false): Line => ({ runs, detail, tone, end });
  switch (entry.kind) {
    case "offered": {
      const { request } = entry;
      const options: Run[] = request.name !== "choose" || request.options === null ? []
        : ["Options: ", ...request.options.flatMap((option, index) => [...(index > 0 ? [", "] : []), code(option.type === "variant" ? option.name : "?")])];
      const due: Run[] = request.by === null ? [] : [options.length > 0 ? ". Due by " : "Due by ", time(request.by)];
      const detail = options.length + due.length === 0 ? null : [...options, ...due];
      const holder = participant(request.holder);
      switch (request.name) {
        case "judge":
          return line(["Asked the judge whether ", quote(request.text)], "reach", detail);
        case "run":
          return line(["Asked ", holder, " to run ", quote(request.text)], "reach", detail);
        case "confirm":
          return line(["Asked ", holder, " to confirm ", quote(request.text)], "reach", detail);
        case "choose":
          return line(["Asked ", holder, " to choose: ", quote(request.text)], "reach", detail);
        case "ask":
          return line(["Asked ", holder, " ", quote(request.text)], "reach", detail);
      }
    }
    case "rejected": {
      const who = entry.request.name === "judge" ? "the judge" : participant(entry.request.holder);
      return line(["The answer ", code(entry.answer), " from ", who, " was not taken: ", quote(entry.reason), ". The request stays open."], "quiet");
    }
    case "handedOver":
      return line(["Handed the request over from ", participant(entry.from), " to ", participant(entry.to)], "reach");
    case "closed":
      return closed(entry.request, entry.outcome, line);
    case "said":
      return entry.to.startsWith("@")
        ? line(["Told ", participant(entry.to), " ", quote(entry.text)], "quiet")
        : line(["Posted to ", code(entry.to), " ", quote(entry.text)], "quiet");
    case "waiting":
      return line(["Waiting ", ...entry.targets, ...entry.deadline], "wait");
    case "woke":
      return line(entry.outcome === null ? ["Woke up"] : ["Woke up with ", code(entry.outcome)], "plain");
    case "elapsed":
      return line(["Stopped waiting ", ...entry.targets, ...(entry.open ? ["; the request stays open"] : [])], "deadline");
    case "fired":
      return line([code(entry.source), entry.mode === "fact" ? " holds, with " : " happened, with ", code(entry.value)], "world");
    case "handlerFailed":
      return line(["A forEach handler ended with ", code(entry.outcome), ". The author is told, and the duty goes on."], "bad");
    case "ended":
      switch (entry.status) {
        case "completed":
          return line(entry.outcome === "()" ? ["Completed"] : ["Completed with ", code(entry.outcome)], "good", null, true);
        case "failed":
          return entry.error
            ? line(["Failed with a program error: ", quote(entry.outcome), ". The author is told."], "bad", null, true)
            : line(["Failed with ", code(entry.outcome), ". The author is told."], "bad", null, true);
        case "revoked":
          return line(["Revoked: the author no longer has the authority to go on."], "bad", null, true);
        case "cancelled":
          return line(["Cancelled"], "quiet", null, true);
      }
  }
}

function closed(request: RequestInfo, outcome: Extract<Entry, { kind: "closed" }>["outcome"], line: (runs: Run[], tone: Tone) => Line): Line {
  const who = request.name === "judge" ? "the judge" : null;
  const holder = participant(request.holder);
  const what = request.name === "run" ? "The task given to " : "The question to ";
  switch (outcome.tag) {
    case "Answered": {
      const value = outcome.value as unknown as Value;
      const answer: Run = value.type === "string" ? quote(value.value) : code(literal(value));
      if (who !== null) return line(["The judge decided ", answer], "good");
      if (request.name === "run") return line([holder, " finished with ", answer], "good");
      return line([holder, " answered ", answer], "good");
    }
    case "Refused":
      return line([who ?? holder, " refused: ", quote(outcome.reason)], "bad");
    case "Broke":
      return line([who ?? holder, " tried and could not: ", quote(outcome.reason)], "bad");
    case "NoReply":
      return line(["No reply from ", who ?? holder, " by the deadline"], "deadline");
    case "Cancelled":
      return line([who === null ? what : "The question to ", who ?? holder, " was cancelled"], "quiet");
    case "Revoked":
      return line(["The request to ", who ?? holder, " was revoked"], "bad");
  }
}

/** Words that end a sentence: a full stop, unless they already end in one, or in a quoted question or exclamation. */
export function sentence(words: readonly Run[]): Run[] {
  const last = words.at(-1);
  const text = typeof last === "string" ? last : last?.text ?? "";
  return /[.?!]$/.test(text.trimEnd()) ? [...words] : [...words, "."];
}
