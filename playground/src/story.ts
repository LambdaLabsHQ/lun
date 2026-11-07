/**
 * The timeline in words: each entry of a simulation as a sentence, with a
 * tone the page shows as the colour of its knot on the thread. Pure.
 */
import type { Value } from "../../src/runtime/browser.ts";
import type { Entry, RequestInfo } from "./simulation.ts";
import { code, literal, participant, quote, type Run } from "./words.ts";

/**
 * - `reach`: the program asks someone, or hands a request over.
 * - `good`, `bad`: a request or the program ended well, or not.
 * - `quiet`: something withdrawn, or said in passing.
 * - `wait`: the program waits; the thread goes slack until the next entry.
 * - `deadline`: a wait timed out.
 * - `world`: a fact or a stream occurrence the visitor fired.
 */
export type Tone = "reach" | "good" | "bad" | "quiet" | "wait" | "deadline" | "world" | "plain";

export interface Line {
  runs: Run[];
  /** A second, quieter line: the options of a question. */
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
      const options = request.options === null ? null : ["Options: ", ...request.options.flatMap((option, index) => [...(index > 0 ? [", "] : []), code(option.type === "variant" ? option.name : "?")])];
      if (request.name === "judge") return line(["Asked the judge whether ", quote(request.text)], "reach");
      if (request.name === "run" || request.name === "start") return line(["Asked ", participant(request.holder), " to run ", quote(request.text)], "reach");
      return line(["Asked ", participant(request.holder), " ", quote(request.text)], "reach", options);
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
    case "timedOut":
      return line(["Timed out waiting ", ...entry.targets], "deadline");
    case "fired":
      return line([code(entry.source), entry.mode === "fact" ? " holds, with " : " happened, with ", code(entry.value)], "world");
    case "handlerFailed":
      return line(["A forEach handler ended with ", code(entry.outcome), ". The author is told, and the duty goes on."], "bad");
    case "ended":
      switch (entry.status) {
        case "completed":
          return line(entry.outcome === "()" ? ["Completed"] : ["Completed with ", code(entry.outcome)], "good", null, true);
        case "failed":
          return line(["Failed with ", code(entry.outcome), ". The author is told."], "bad", null, true);
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
  switch (outcome.tag) {
    case "Done": {
      const value = outcome.value as unknown as Value;
      const answer: Run = value.type === "string" ? quote(value.value) : code(literal(value));
      if (who !== null) return line(["The judge decided ", answer], "good");
      if (request.name === "run" || request.name === "start") return line([holder, " finished with ", answer], "good");
      return line([holder, " answered ", answer], "good");
    }
    case "Declined":
      return line([who ?? holder, " declined: ", quote(outcome.reason)], "bad");
    case "Failed":
      return line([who ?? holder, " failed: ", quote(outcome.reason)], "bad");
    case "Cancelled":
      if (who !== null) return line(["The question to the judge was withdrawn"], "quiet");
      return line([request.name === "run" || request.name === "start" ? "The task given to " : "The question to ", holder, " was withdrawn"], "quiet");
    case "Revoked":
      return line(["The request to ", who ?? holder, " was revoked"], "bad");
  }
}
