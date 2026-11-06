# Choreographic programming and multiparty session types: a deep dive

> Research for the language design discussion, 2026-11-06 (written by a Claude research agent). Internal names in the examples were replaced with neutral ones.

## 1. Core ideas
- **Choreography and projection.** A choreography is one global program made of interactions (`a ~> b: M`). **Endpoint projection** compiles it into one local program per role. Each send is written together with its receive, so the projected system is deadlock-free by construction ([Carbone & Montesi, POPL'13](https://fabriziomontesi.com/publication/deadlock-freedom-by-design); textbook: [Montesi 2023](https://doi.org/10.1017/9781108981491)).
- **MPST** do the same for types: a global type projects to local types ([Honda, Yoshida & Carbone](https://doi.org/10.1145/2827695)).
- **Knowledge of choice.** If one role branches, every role whose behaviour changes must be told. Otherwise the program cannot be projected.
- **History.** SOA split *orchestration* (BPEL, executable, one controller) from *choreography* (W3C WS-CDL, a global description). WS-CDL stalled as a [2005 Candidate Recommendation](https://www.w3.org/TR/ws-cdl/), and its [working group closed in 2009](https://www.w3.org/groups/wg/ws-chor/ipr/). Formalising it ([Carbone, Honda & Yoshida](https://mrg.cs.ox.ac.uk/publications/structured-communication-centered-programming-for-web-services/)) led to MPST.
- **the language uses "choreography" in the SOA sense:** many small per-author orchestrators that interact through events. It has no global program and no projection.

## 2. Languages (activity checked on GitHub)
| Language | Status | Syntax |
|---|---|---|
| [Choral](https://github.com/choral-lang/choral/releases) (Java) | Active. v0.1.13 (Sep 2026). `--infer-comms` (Feb 2026) inserts communications for you. Still "a prototype". | `String@Bob x = topic >> chAB<String>::com;` |
| [HasChor](https://arxiv.org/abs/2303.00924) (Haskell) | Last commit Jun 2025 | `price' <- (seller, price) ~> buyer` |
| [MultiChor](https://arxiv.org/abs/2412.02107) (Haskell) / ChoRus (Rust) / ChoreoTS | MultiChor: v1.1 (Apr 2025), commits until Dec 2025. ChoRus and ChoreoTS: last change Mar 2025. | `(buyer, title) ~> seller @@ nobody` · `op.comm(Alice, Bob, &x)` |
| [Chorex](https://arxiv.org/abs/2511.15820) (Elixir) | Last commit Sep 2025. [Event-Driven Chorex](https://users.cs.utah.edu/~blg/publications/chorex/wg-choreo-2026.pdf) is in progress. | `Seller.get_price(b) ~> Buyer.(p)` |
| [Klor](https://github.com/lovrosdu/klor) (Clojure) | Quiet since Oct 2024 | `(B->A (B (inc (A->B x))))` |
| [Pirouette](https://arxiv.org/abs/2111.03484) | Coq-verified calculus; no library | — |

Other hosts and newer work:
- **Scala:** [romac/choreo](https://github.com/romac/choreo), last change May 2026.
- **OCaml:** ChorCaml, repo idle since May 2024.
- **New:** [Tempo](https://github.com/tempo-lang/tempo) (compiles to Go, 2026), [CloudChor](https://popl26.sigplan.org/details/pepm-2026-papers/9/Towards-Lightweight-and-Efficient-Choreographic-Cloud-Services) (PEPM'26), [Mech](https://arxiv.org/abs/2607.15174) (Lean 4), and [Pact](https://arxiv.org/abs/2605.03143) (CP 2026).

## 3. Failures and autonomy
The base theory assumes participants that are reliable, cooperative and always answer. The extensions:
- **Crashes.** [Barwell et al. (CONCUR'22)](https://arxiv.org/abs/2207.02015) add a `crash` branch to choices. Some roles are declared "reliable", and only a receiver detects a crash. [Teatrino (ECOOP'23)](https://arxiv.org/abs/2305.06238) generates Scala code with crash-handling branches. [Viering et al. (OOPSLA'21)](https://2021.splashcon.org/details/splash-2021-oopsla/28/A-Multiparty-Session-Typing-Discipline-for-Fault-Tolerant-Event-Driven-Distributed-Pr) replace failed parties and retry parts of the protocol.
- **Time.** [Timed MPST](https://mrg.cs.ox.ac.uk/publications/timed-multiparty-session-types/) treat deadlines as obligations, not branches. [Affine timed MPST (ECOOP'24)](https://arxiv.org/abs/2406.19541) turn a timeout into cancellation. A real timeout *branch* needs a choice that mixes sending and receiving; [TOAST (LMCS 2025)](https://arxiv.org/abs/2401.11197) makes that safe for **two-party** sessions only. [MAGπ](https://arxiv.org/abs/2301.10827) adds timeout branches to receives.
- **Choreographies.**
  - Chorex `checkpoint … rescue`: a crashed actor restarts and everyone jumps to `rescue`.
  - [Lossy choreographies](https://arxiv.org/abs/1712.05465) handle lost messages.
  - [Ozone (ECOOP'24)](https://arxiv.org/abs/2401.17403) runs out of order, using keys so a late message cannot bind to the wrong variable.
- **Refusal and deviation have no theory.** [Pact](https://arxiv.org/abs/2605.03143) exists because choreographic programming "assumes cooperative participants". Endpoints that cannot be trusted get runtime monitors only ([Chen et al.](https://mrg.cs.ox.ac.uk/publications/asynchronous-distributed-monitoring-for-multiparty-session-enforcement/); [timed](https://arxiv.org/abs/1408.5979)).
- **"Default at T"** exists only in research calculi. Telltale is a single-author DSL, not peer-reviewed. It writes `timeout 5s Client at … on timeout =>`, but [its docs](https://github.com/hxrts/telltale/blob/main/docs/202_choreographic_dsl.md) say projection rejects it.
- **Handover.** MPST *delegation* passes an endpoint linearly. Types cannot stop a slow codex from replying, so the runtime needs:
  - a fence, where the first committed answer wins;
  - cancellation of the old holder ([MultiCrusty](https://arxiv.org/abs/2204.13464)).

  Work already done inside the first Run stays done.

## 4. Dynamic participants and people
- **Static roles with runtime binding are ordinary,** so `@auto` fits.
- **Choosing participants at runtime** is covered by:
  - [PolyChorλ](https://doi.org/10.1017/S0956796823000114) (process polymorphism);
  - [connect/disconnect actions](https://www.doc.ic.ac.uk/~rhu/scribble/explicit.html);
  - [EnsembleS](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ECOOP.2021.10).
- **Census polymorphism** varies how many participants there are. MultiChor's census is a type-level list fixed at build time (source checked).
- **People:** MultiChor's `naryHumans` example has people typing answers. [ZipperGen](https://arxiv.org/abs/2604.17612) treats LLM calls and human inputs as "opaque typed functions". None handles someone who never answers.

## 5. Durability
I found nothing that supports weeks-long waits.
- **[Accompanist](https://arxiv.org/abs/2603.20942)** (Choral, 2026 preprint) replays from a durable inbox/outbox. It is at-least-once, and only if steps are deterministic and idempotent. It targets millisecond sagas (median latency 5.9× lower than Temporal).
- **Chorex** keeps checkpoints in a GenServer's memory (source checked).
- **ZipperGen** replays from SQLite.
- **Older:** recovery in Erlang ([CC'17](https://mrg.cs.ox.ac.uk/publications/let-it-recover-multiparty-protocol-induced-recovery/)); choreographies as smart contracts (ChorChain, [Nomos](https://arxiv.org/abs/1902.06056)).
- **Updating a running choreography** needs coordinated scopes ([AIOCJ](https://arxiv.org/abs/1611.09067)).

## 6. What type checking buys
- **the language code:**
  - conformance to local types;
  - exhaustive failure and timeout branches (the language's `outcome` already acts as crash branches);
  - a deadlock-free coordination skeleton.
- **Agents and people:** they cannot be typed, only monitored. A monitor checks each reply's label, schema and timing, and each party's contract is generated.
- **Limits:**
  - Semantics: ZipperGen's GPT-4.1 workflows were 10/10 valid but only 6/10 correct.
  - Human liveness is restored only by deadlines.
  - Incentives (Pact's point).
  - Effects inside Runs are not exactly-once.

## 7. The three examples
Notation: `!` send, `?` receive, `&{}` choice; the receiver owns `within`.
```rescript
choreo decision(p: program, d: person) = {
  p ~> d: Ask("Ship the billing probe? A / B")
  switch d ~> p: Answer within at("2026-11-07T12:00Z") {
  | Got("B") => p ~> d: Closed(Skipped)
  | Got(_) | Late => {
      p ~> d: Closed(DefaultTaken)              // Alice learns how it ended
      let x = spawn(@auto)                      // bound only on this branch
      p ~> x: Run("Carry out the billing probe as recommended, ≤ US$0.10"); x ~> p: Report } } }
// d: ?Ask · &{ !Answer before T · ?Closed | ?Closed }  → a Needs you card; a mixed choice (the TOAST case)
// x: ?Run · !Report      p: the the language draft program, run by the Hub
// An Answer at T+ε races Late: the request record decides which one counts

choreo releaseCheck(p, gh, rel, ws: system, c: agent, d: person) = {
  gh ~> p: Merged(pr)
  switch rel ~> p: Released(v) within at("2026-11-07T06:00Z") {
  | Got(v) => { ws ~> p: DaemonUpdated(v)
                p ~> c: Run("On win-builder, confirm the long-path fix"); c ~> p: Report }
  | Late => p ~> d: Say("#1436 missed the 06:00 beta") } }
// gh, rel, ws cannot run code: each projection is a subscription with an order and a deadline (a monitor)
// c: ?Run · !Report    Only one role acts on instructions, so the global view adds little

choreo followUp(p, x: agent, d: person) = {
  let q = p ~> x: Ask("Are the win-builder fans still loud?")
  switch x ~> p: Answer within after(1h) {
  | Got(a) => p ~> d: Say(a)
  | Late => { p ~> x: Revoke(q)                // codex learns it is off the hook
              delegate(q, ~from=x, ~to=d); d ~> p: Answer } } }
// x: ?Ask · &{ !Answer before 1h | ?Revoke }   (a later answer is refused)
// d: &{ ?Say | ?Ask(q) · !Answer }
```

## 8. Verdict: a layer and inspiration over an effects core, not the semantic core
**Making it the core would gain** a global narrative and a deadlock-free skeleton. **It would lose:**
- **Projection's payoff.** Only the program's own role runs code. People, Agents, GitHub and daemons do not run projections.
- **Maturity where the language needs it.** Timeouts, refusal, revocation, handover, durable waits and editing a running program are all research-grade. Reactive `on …` programs need the choreography "shredded" into handlers (cited by Accompanist).
- **Fit with how the language deploys.** Choreographic programming assumes one global program deployed with fixed roles; Accompanist lists "can't join a running choreography" as a limit. the language programs belong to separate sections.
- **Evidence that LLMs can write it.** There is no benchmark. In ZipperGen's toy test, small models produced 0 valid workflows. Projection errors are non-local, and Choral needed `--infer-comms`. My judgement: Agents write the local style (the draft) more reliably.

**An effects core keeps the door open.** Library choreographies already run on effects: HasChor uses a freer monad, [Shen & Kuper](https://arxiv.org/abs/2407.06509) write projection as handlers, and [Effekt](https://effekt-lang.org/examples/choreo.html) has a working example. A later `choreo` block can be a library over the language's continuations; the reverse does not work.

**Take now:**
1. Requests become linear endpoints with typed outcomes, and every await on an unreliable role must have failure branches. The Hub is the only reliable role.
2. A knowledge-of-choice check: everyone asked is told how it ended. This targets "closed by default, nobody answered" and "failed, nobody told".
3. `handOver` = delegation, plus a fencing epoch, plus cancellation of the old holder.
4. Projection as rendering:
   - each party's card or prompt plus reply schema;
   - monitored replies, with violations turned into `Failed`;
   - running instances drawn as sequence diagrams on Pages.
5. Correlation keys on every await, as in Ozone.

**Beauty:** the arrow notation reads like a team procedure, but library embeddings are not beautiful. Show the arrows as the rendered view instead of making Agents write them.

*Read at abstract level only (not verified in full text): Viering, Lossy choreographies, Pact, EnsembleS, connection actions, TOAST, MAGπ, timed monitors, CloudChor, Event-Driven Chorex.*
