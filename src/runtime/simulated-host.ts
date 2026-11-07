import { VirtualClock } from "./clock.ts";
import type { Effect } from "./machine.ts";
import type { DurableStore, Json, StoredRequest } from "./persistence.ts";
import { eventKey, ProgramError, requestOutcome, type Policy, Runtime } from "./runtime.ts";
import { equal, variant, type Value } from "./value.ts";

/** Local, deterministic host. It never starts an agent or calls an external service. */
export class SimulatedHost implements Policy {
  readonly store: DurableStore;
  readonly clock: VirtualClock;
  get now(): number { return this.clock.now(); }
  permitted = true;
  private readonly worker: string;
  constructor(store: DurableStore, clock: VirtualClock, worker = "simulation") { this.store = store; this.clock = clock; this.worker = worker; }
  async authorize(_executionId: string, _effect: Effect): Promise<boolean> { return this.permitted; }
  async advanceTo(at: number): Promise<void> {
    this.clock.advanceTo(at); await this.store.scanReady();
  }
  async reply(request: StoredRequest, answer: Value): Promise<boolean> {
    const current = await this.store.request(request.id);
    if (!current) return false;
    const effect = current.arguments as unknown as Effect;
    const response = this.permitted ? answer : variant("Revoked");
    let result;
    try { result = requestOutcome(response); }
    catch (error) {
      if (!(error instanceof ProgramError)) throw error;
      await this.store.rejectAnswer(request.id, request.epoch, request.holder, answer as unknown as Json, error.message);
      return false;
    }
    let invalid: string | null = null;
    if (result.tag === "Answered") {
      const answered = result.value as unknown as Value;
      const allowed = effect.name === "choose" ? effect.args[2] : null;
      if (effect.name === "choose" && (allowed?.type !== "list" || !allowed.values.some(v => equal(v, answered)))) invalid = "Answer did not match a declared option";
      if (effect.name === "confirm" && (answered.type !== "variant" || !["Yes", "No"].includes(answered.name) || answered.args.length)) invalid = "Answer must be Yes or No";
      if (effect.name === "judge" && answered.type !== "bool") invalid = "Judge answer must be boolean";
      if (effect.name === "ask" && answered.type !== "string") invalid = "Answer must be a string";
      if (effect.name === "run" && (answered.type !== "record" || answered.fields.text?.type !== "string")) invalid = "Reference report must be a record with text";
    }
    if (invalid !== null) {
      await this.store.rejectAnswer(request.id, request.epoch, request.holder, answer as unknown as Json, invalid);
      return false;
    }
    return this.store.settleRequest(request.id, request.epoch, request.holder, result);
  }
  async emit(id: string, source: Value, value: Value, originExecutionId?: string): Promise<boolean> {
    if (source.type !== "source" || ["merge", "or", "never", "after", "every", "map", "filter"].includes(source.name)) throw new Error("Emit a concrete external fact or stream occurrence");
    return this.store.publishEvent(id, eventKey(source), source.kind, value as unknown as Json, originExecutionId);
  }
  async dispatch(): Promise<number> {
    let count = 0, after = "";
    while (true) {
      const effects = await this.store.scanEffects({ after, limit: 100 });
      if (!effects.length) break;
      for (const effect of effects) {
        after = effect.id;
        const claim = await this.store.claimEffect(effect.id, this.worker, 60_000);
        if (!claim) continue;
        if (claim.mode === "reconcile") {
          await this.store.markUncertain(claim, "No simulated transport evidence; explicit reconciliation required"); continue;
        }
        if (effect.operation === "say" && !this.permitted) {
          await this.store.markUncertain(claim, "Permission revoked before message delivery"); continue;
        }
        if (effect.operation === "request.offer") {
          const args = effect.arguments as { requestId: string; epoch: number; holder: string };
          const current = await this.store.request(args.requestId);
          if (!this.permitted && current) {
            await this.store.settleRequest(current.id, current.epoch, current.holder, { tag: "Revoked" }); continue;
          }
          if (!current || current.epoch !== args.epoch || current.holder !== args.holder || current.outcome !== null) continue;
        }
        // This receipt means visible in the simulation, never that the request is answered.
        await this.store.recordDelivery(claim, { simulated: true }); count++;
      }
    }
    return count;
  }
  async pump(runtime: Runtime, slices = 100): Promise<number> {
    const advanced = await runtime.runReady(slices);
    await this.dispatch();
    return advanced;
  }
}
