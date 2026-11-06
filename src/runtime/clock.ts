/** A storage adapter's trusted clock; event timestamps never implement this interface. */
export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };

/** Explicit test/simulation clock shared by the local host and its store. */
export class VirtualClock implements Clock {
  private instant: number;
  constructor(initial = 0) { this.instant = initial; this.validate(initial); }
  now(): number { return this.instant; }
  advanceTo(instant: number): void {
    this.validate(instant);
    if (instant < this.instant) throw new Error("Simulation time cannot move backwards");
    this.instant = instant;
  }
  private validate(instant: number): void {
    if (!Number.isSafeInteger(instant) || instant < 0) throw new TypeError("Clock must return nonnegative safe integer milliseconds");
  }
}
