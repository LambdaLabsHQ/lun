import type { Effect } from "./machine.ts";
import type { DurableStore, Json, StoredRequest } from "./persistence.ts";
import { eventKey, requestOutcome, type Policy, Runtime } from "./runtime.ts";
import { equal, text, variant, type Value } from "./value.ts";

/** Local, deterministic host. It never starts an agent or calls an external service. */
export class SimulatedHost implements Policy {
  readonly store: DurableStore;
  now: number;
  permitted = true;
  private readonly worker: string;
  constructor(store: DurableStore, now = 0, worker = "simulation") { this.store = store; this.now = now; this.worker = worker; }
  async authorize(_executionId: string, _effect: Effect): Promise<boolean> { return this.permitted; }
  async advanceTo(at: number): Promise<void> {
    if (!Number.isSafeInteger(at) || at < this.now) throw new Error("Simulation time cannot move backwards");
    this.now = at; await this.store.scanReady(at);
  }
  async reply(request: StoredRequest, answer: Value): Promise<boolean> {
    let response = answer;
    const effect = request.arguments as unknown as Effect;
    if (response.type === "variant" && response.name === "Done") {
      const answered = response.args[0], arity = response.args.length;
      const allowed = effect.labels.options;
      if (allowed && (allowed.type !== "list" || arity !== 1 || !allowed.values.some(v => equal(v, answered)))) {
        response = variant("Declined", text("Response did not match a declared option"));
      }
      if (effect.name === "judge" && answered?.type !== "bool") response = variant("Failed", text("Judge response must be boolean"));
      if (effect.name === "ask" && !allowed && answered?.type !== "string") response = variant("Declined", text("Answer must be a string"));
    }
    if (!this.permitted) response = variant("Revoked");
    return this.store.settleRequest(request.id, request.epoch, request.holder, requestOutcome(response), this.now);
  }
  async emit(id: string, source: Value, value: Value, originExecutionId?: string): Promise<boolean> {
    if (source.type !== "source" || ["merge", "after", "every", "map", "filter"].includes(source.name)) throw new Error("Emit a concrete external fact or stream occurrence");
    return this.store.publishEvent(id, eventKey(source), source.kind, value as unknown as Json, this.now, originExecutionId);
  }
  async dispatch(): Promise<number> {
    let count = 0, after = "";
    while (true) {
      const effects = await this.store.scanEffects(this.now, { after, limit: 100 });
      if (!effects.length) break;
      for (const effect of effects) {
        after = effect.id;
        const claim = await this.store.claimEffect(effect.id, this.worker, this.now, 60_000);
        if (!claim) continue;
        if (claim.mode === "reconcile") {
          await this.store.markUncertain(claim, "No simulated transport evidence; explicit reconciliation required", this.now); continue;
        }
        if (effect.operation === "say" && !this.permitted) {
          await this.store.markUncertain(claim, "Permission revoked before message delivery", this.now); continue;
        }
        if (effect.operation === "request.offer") {
          const args = effect.arguments as { requestId: string; epoch: number; holder: string };
          const current = await this.store.request(args.requestId);
          if (!this.permitted && current) {
            await this.store.settleRequest(current.id, current.epoch, current.holder, { tag: "Revoked" }, this.now); continue;
          }
          if (!current || current.epoch !== args.epoch || current.holder !== args.holder || current.outcome !== null) continue;
        }
        // This receipt means visible in the simulation, never that the request is answered.
        await this.store.recordDelivery(claim, { simulated: true }, this.now); count++;
      }
    }
    return count;
  }
  async pump(runtime: Runtime, slices = 100): Promise<number> {
    const advanced = await runtime.runReady(this.now, slices);
    await this.dispatch();
    return advanced;
  }
}
