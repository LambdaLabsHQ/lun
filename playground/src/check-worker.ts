/**
 * The worker that checks programs, so that typing never waits for the
 * checker, however long the program. It reads the reference host and the
 * standard library once, from text bundled with it.
 */
import hostSource from "../../hosts/reference.norn";
import stdSource from "../../std/std.norn";
import { createChecker, type Checker } from "./check.ts";
import type { CheckReply, CheckRequest } from "./protocol.ts";

interface WorkerScope {
  onmessage: ((event: MessageEvent<CheckRequest>) => void) | null;
  postMessage(reply: CheckReply): void;
}
const scope = self as unknown as WorkerScope;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

let checker: Checker | null = null;
let startup = "";
try {
  checker = createChecker(hostSource, stdSource);
} catch (error) {
  startup = describe(error);
}

scope.onmessage = ({ data: { id, source } }) => {
  if (checker === null) {
    scope.postMessage({ id, failure: startup });
    return;
  }
  try {
    scope.postMessage({ id, report: checker(source) });
  } catch (error) {
    scope.postMessage({ id, failure: describe(error) });
  }
};
