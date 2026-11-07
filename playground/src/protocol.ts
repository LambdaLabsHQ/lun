/** Messages between the page and the worker that checks programs. */
import type { CheckReport } from "./check.ts";

export interface CheckRequest {
  id: number;
  source: string;
}

export type CheckReply =
  | { id: number; report: CheckReport }
  /** The checker itself failed: a bug to show, not a diagnostic of the program. */
  | { id: number; failure: string };
