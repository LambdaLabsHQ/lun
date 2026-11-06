# Which formal model underneath? A survey

> Research for the language design discussion, 2026-11-06 (written by a Claude research agent). Internal names in the examples were replaced with neutral ones.


**Bottom line.** The candidates answer three different questions:
- how a program suspends: continuations, effects, promises, statecharts;
- how participants interact: actors, channels, tuple spaces;
- what can be checked: types, nets, CALM.

Most translate into each other (§2). **Recommended core: one-shot algebraic effects, run as stored continuations inside virtual actors. The actors share only durable single-assignment requests and pushed events.**

## 1. Comparison (● strong ◐ partial ○ weak)

| Model | a autonomy | b weeks-long waits | c no coordinator | d durable, code change | e typing | f LLM-writable | g beauty | h 6 mechanisms + cards | i maturity, cost |
|---|---|---|---|---|---|---|---|---|---|
| 1 Continuations (one-shot, delimited) | ◐ mechanism only | ● if serialized | ● | ◐ serializable; pins old code | ◐ | ● direct style | ● | ● library fns | ◐ own interpreter |
| 2 Effects + handlers | ● typed ops; policy as handlers | ● | ● | ◐ as 1 | ● effect rows, capabilities | ● (handlers ◐) | ● | ● | ◐ Unison 1.0 ships them; Koka, Effekt research |
| 3 Actors, virtual actors | ● receive…after, supervisors | ◐ Erlang `after` ≤ 50 d, in memory; ● DO alarms | ● | ● state is data, `code_change` | ◐ mailbox types (research) | ◐ IDs, state threading | ◐ split per message | ● verbose | ● DOs are virtual actors |
| 4 CSP, π, join | ◐ select + timer | ○ volatile | ● | ○ | ◐ session types | ◐ deadlocks | ● join patterns | ◐ | ◐ build on DOs |
| 5 FRP, Bloom/Hydro | ○ no requests | ◐ | ● CALM | ◐ | ◐ | ○ | ● standing rules | ◐ schedules only | ○ Rust research |
| 6 Statecharts, Petri, BPMN | ● timers, escalation, cancel regions | ● | ○ engine (BPMN) | ● snapshot is data | ◐ net soundness | ◐ graphs | ○ verbose | ● native | ● XState in TS |
| 7 Linda, blackboard | ◐ atomic take, no owner | ● | ● | ◐ control state lost | ○ | ◐ racy | ◐ | ◐ cards weak | ● one PG table |
| 8 Durable promises | ● resolve once; ID/URL | ● ≤ 365 d (Workflows) | ◐ orchestrator per workflow | ● replay; ○ code change | ● | ● async/await | ◐ colouring | ● | ● Restate, Trigger.dev, Workflows, DBOS, Absurd |

**Others**
- **BDI (Jason).** It has goals, failure plans and `.wait(E,T)`. An intention is a continuation. It is niche, runs on the JVM, and its LLM integration is early (ChatBDI).
- **FIPA, A2A 1.0 and MCP tasks.** These are protocols, not programming models. They supply the outcome vocabulary:
  - FIPA: refuse, agree, failure.
  - A2A: REJECTED, INPUT_REQUIRED, AUTH_REQUIRED.
  - MCP: a cancelled task "MUST remain cancelled" even if its execution completes. MCP tasks are polled.
- **Orc.** Pruning means the first result wins and the rest are cancelled. It is not durable.
- **Behavioral programming.** A central, synchronous event selector, so it fails (c).
- **Temporal logic.** Useful only as a monitor layer.
- **Session types** are covered elsewhere. MAGπ adds timeouts on receive.

## 2. Equivalences, and what each adds

- **Continuations ≈ effects ≈ monads.** They macro-express each other untyped, though not all typeably [Forster+ ICFP'17]. One-shot handlers can be expressed by asymmetric coroutines [Kobayashi & Kameyama 2026], so JS generators can run them in memory, though not durably. *Effects add* typed operations and handlers as policy; timeout and rollback are classic handlers [Plotkin & Pretnar].
- **Promises are reified one-shot continuations.** async/await can be built as a handler library with scoped cancellation and timeouts [Leijen 2017]. Asynchronous effects split an operation into an outgoing signal and an incoming interrupt [Ahman & Pretnar POPL'21]: effects over mailboxes. *Promises add* a handle that anyone may resolve, once. They also add pipelining: an unanswered request can be passed onward (E [Miller+ 2005], Cap'n Proto).
- **Replay rebuilds the continuation from a log.** Durable Functions proves this equivalent to a fault-free model [Burckhardt+ OOPSLA'21]. Replay costs determinism, and old code must stay runnable (Temporal `patched()`, Restate's deployment pinning). Racket stores continuations directly [McCarthy ICFP'09].
- **Actors ≈ channels** [Fowler+ ECOOP'17], and **join ≈ π** [Fournet & Gonthier POPL'96]. *Actors add* identity and single-writer state, which is what Durable Objects are. *Joins add* "when A and B".
- **Statecharts are compiled continuations.** Each suspension point becomes a state. XState v5 machines are actor logic, and leaving a state cancels its timers. *They add* states that can be named and migrated.
- **BPMN maps to Petri nets** [Dijkman+ 2008]. Cancellation needs reset nets, whose reachability is undecidable [Wynn+].
- **Linda.** Its expressive power depends on ordered `out` [Busi+ 2000]. *It adds* decoupling in time and space, the original "coordination language" idea [Gelernter & Carriero 1992]. Pages already provide that.
- **CALM.** A program needs no coordination exactly when it is monotone [Hellerstein & Alvaro]. `merged` and `released` are monotone. "No answer by T", `any` winners, cancel and handover are not, and that is where coordination must live.

## 3. Recommendation

1. **Control.** Every suspension is an effect, and the runtime is the outermost handler.
   - Continuations are delimited, not call/cc [Kiselyov], and one-shot [Bruggeman+ PLDI'96], as OCaml 5 enforces. Each is stored as data after every step.
   - Code is content-addressed, so a waiting instance finishes on the code it started with. Edits start new instances, and migration is explicit, as with Erlang's `code_change`. Replay would instead pin old code for weeks.
2. **Requests are durable promises** owned by the caller's actor: `Pending → Done | Declined | Failed | Cancelled | Revoked`. The first terminal write wins.
   - `handOver` keeps the same promise and bumps an epoch. Resolutions and capabilities carrying a stale epoch are refused (fencing [Kleppmann†]). Nobody acquires anything, so this is not a claim.
   - This rules out double resolution, double resumption and double authority. No model can stop an autonomous party from doing work that is then wasted.
3. **Coordinate only the non-monotone steps** inside that single-threaded actor: timeout, default, `any` winner, cancel and handover.
4. **Structured cancellation.** Leaving a `scope`, losing an `any` or passing a deadline cancels the requests started inside it. Orc pruning, YAWL cancel regions and statechart exit follow the same rule.
5. **Hosting.** One Durable Object per instance, and no conductor.
   - Events are pushed at least once, and resumes are idempotent by step number.
   - Time arrives through alarms, which are durable reminders, not timers.
6. **Types.** Hindley–Milner with inferred effect rows (Koka) or capabilities (Effekt). The row is the program's authority manifest.
   - Agents write direct style; handlers live on the reviewed Std page.
   - A dry-run handler, with a simulated clock and scripted answers, tests a program before it is committed.

**Cost** [estimate]: a CEK interpreter and HM checker in TS, a few thousand lines. Continuations are kept in DO storage and history in PG. Absurd, Workflows and the Agents SDK's months-long `waitForApproval` show that the durable side is small. Effect-TS (`@effect/workflow` with `@effect/cluster`) is a TypeScript precedent.

## 4. Sketches

**(A) Effects.** Direct style; a handler appears only where policy is needed.

```rescript
// 1 Decision card: leaving `scope` cancels the open ask, so a late answer is refused
let d74 = scope(() =>
  switch ask(@alice, "Ship the billing probe?", ~options=[#run, #skip])
         ->await(~until=at("2026-11-07T12:00Z")) {
  | Ready(Done(c)) => c
  | _ => #run                                   // timed out, declined, failed: recommendation
  })
if d74 == #run { run(@auto, "Carry out the billing probe: ≤ US$0.10, one preview email")->await->ignore }

// 2 Release chain
let pr  = await(merged("acme/api#1436"))?
let rel = await(released(Beta, ~containing=pr), ~until=after(1d))?   // TimedOut: author is asked
await(daemonUpdated(~machine="win-builder", ~atLeast=rel.version))?
run(@claude, "On win-builder, confirm the long-path fix")->await??

// 3 Hand-over as a Std handler; the body reads as if nobody were late
let escalating = (body, ~after as d, ~to) =>
  switch body() {
  | effect Await(Request(r), ~until), k =>
    switch perform(Await(Request(r), ~until=min(until, now() + d))) {
    | TimedOut if now() < until => k->resume(handOver(r, to)->await(~until))  // same request, epoch+1
    | w => k->resume(w)                                                       // at most once
    }
  | v => v
  }
escalating(~after=1h, ~to=@alice, () =>
  say(@alice, ask(@codex, "Are the win-builder fans still loud?")->await??))
```

**(B) Actors.** Each wait is a named state, and replies are matched by request id.

```rescript
// 1 Decision card
let carryOut = () => request(@auto, Run("Carry out the billing probe: ≤ US$0.10, one preview email"))->ignore
let q = request(@alice, Ask("Ship the billing probe?", [#run, #skip]))
receive(~until=at("2026-11-07T12:00Z")) {
| Reply(id, Done(#skip)) if id == q => tell(doc"decisions", "the billing decision = skip")
| Reply(id, _) if id == q => carryOut()
| Timeout => { cancel(q); carryOut() }
}

// 2 Release chain
let rec merging = () => { subscribe(merged("acme/api#1436")); receive { | Merged(pr) => beta(pr) } }
and beta = pr => {
  subscribe(released(Beta, ~containing=pr))
  receive(~until=after(1d)) { | Released(rel) => updating(rel) | Timeout => tell(@alice, "#1436 missed beta") }
}
and updating = rel => {
  subscribe(daemonUpdated(~machine="win-builder", ~atLeast=rel.version))
  receive { | DaemonUpdated(_) => request(@claude, Run("Confirm the long-path fix"))->ignore }
}
merging()

// 3 Follow-up with hand-over
let q = request(@codex, Ask("Are the win-builder fans still loud?"))
let rec waiting = (~escalated) =>
  receive(~until=escalated ? never : after(1h)) {
  | Reply(id, Done(a)) if id == q => tell(@alice, a)    // codex's stale-epoch reply is refused upstream
  | Timeout => { handOver(q, @alice); waiting(~escalated=true) }
  }
waiting(~escalated=false)
```

(A) is short and its policies are reusable, but its state is implicit. (B) makes states explicit and timeouts native, but the author must match replies, manage subscriptions, discard stale messages and supervise the Runs it starts; that bookkeeping is where LLM-written code slips [judgment]. The core gets both: Agents write (A), and the runtime runs it as (B), naming each suspension point ("waiting in `beta`"). Durable promises, written out, would be (A) plus `await`.

## 5. Unverified

These were not confirmed from primary sources:
- whether Unison serializes continuations (sources disagree);
- Effekt's JS backend;
- whether XState v5 re-arms `after` timers when restored;
- what Cloudflare Workflows does with in-flight instances when new code is deployed;
- anything in Leijen or Ahman & Pretnar beyond the abstracts;
- † Kleppmann's post, which I saw only through other pages.

The LLM-writability verdicts beyond the cited data, and the cost estimate, are my judgment. The cited data:
- code actions beat JSON actions by up to 20%;
- type-constrained decoding more than halves compile errors;
- low-resource languages lose accuracy;
- Elixir tops AutoCodeBench, per secondary write-ups.

**Sources.**
- **Products:** [Workflows `waitForEvent`](https://developers.cloudflare.com/workflows/build/events-and-parameters/), [Agents HITL](https://developers.cloudflare.com/agents/guides/human-in-the-loop), [Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/), [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), Restate [events](https://docs.restate.dev/develop/ts/external-events) / [timers](https://docs.restate.dev/develop/ts/durable-timers) / [versioning](https://docs.restate.dev/services/versioning), [Trigger.dev tokens](https://trigger.dev/docs/wait-for-token), [DBOS](https://docs.dbos.dev/typescript/tutorials/workflow-communication), Absurd [1](https://lucumr.pocoo.org/2025/11/3/absurd-workflows/) / [2](https://lucumr.pocoo.org/2026/4/4/absurd-in-production/), [@effect/workflow](https://www.npmjs.com/package/@effect/workflow), [Temporal versioning](https://docs.temporal.io/develop/typescript/versioning).
- **Languages:** [OCaml 5 effects](https://ocaml.org/manual/5.3/effects.html), [Koka](https://github.com/koka-lang/koka), [Effekt](https://se.cs.uni-tuebingen.de/publications/brachthaeuser20effects/), Unison [1.0](https://www.infoworld.com/article/4100673/futuristic-unison-functional-language-debuts.html) / [design](https://www.unison-lang.org/docs/the-big-idea/), [Erlang receive](https://www.erlang.org/doc/system/expressions.html), Orleans [reminders](https://learn.microsoft.com/en-us/dotnet/orleans/grains/timers-and-reminders) / [paper](https://www.microsoft.com/en-us/research/publication/orleans-distributed-virtual-actors-for-programmability-and-scalability/), XState [delays](https://stately.ai/docs/delayed-transitions) / [persistence](https://stately.ai/docs/persistence), [Camunda timers](https://docs.camunda.io/docs/next/components/modeler/bpmn/timer-events/), [Hydro](https://hydro.run), [Orc](https://orc.csres.utexas.edu/documentation/html/userguide/userguide.html), [Jason `.wait`](https://jason-lang.github.io/api/jason/stdlib/wait.html), [Racket stateless servlets](https://docs.racket-lang.org/web-server/stateless.html), [Cap'n Proto](https://capnproto.org/rpc.html).
- **Protocols:** [A2A 1.0](https://a2a-protocol.org/latest/specification/), [MCP tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks), [FIPA Request](https://www.fipa.org/specs/fipa00026/SC00026H.html).
- **Papers:** [Forster+](https://arxiv.org/abs/1610.09161), [Kobayashi & Kameyama](https://arxiv.org/abs/2609.06443), [Plotkin & Pretnar](https://arxiv.org/abs/1312.1399), [Leijen](https://www.microsoft.com/en-us/research/publication/structured-asynchrony-algebraic-effects), [Ahman & Pretnar](https://arxiv.org/abs/2003.02110), [Burckhardt+](https://www.microsoft.com/en-us/research/publication/durable-functions-semantics-for-stateful-serverless/), [McCarthy](https://jeapostrophe.github.io/home/static/icfp065-mccarthy.pdf), [Bruggeman+](https://bibtex.github.io/PLDI-1996-BruggemanWD.html), [Kiselyov](https://okmij.org/ftp/continuations/against-callcc.html), [Fowler+](https://arxiv.org/abs/1611.06276), [Pat mailbox types](https://arxiv.org/abs/2306.12935), [Fournet & Gonthier](https://www.classes.cs.uchicago.edu/archive/2007/spring/32102-1/papers/p372-fournet.pdf), [CALM](https://arxiv.org/abs/1901.01930), [Dijkman+](https://dblp.uni-trier.de/rec/journals/infsof/DijkmanDO08.html), [Wynn+](https://research.tue.nl/en/publications/verifying-workflows-with-cancellation-regions-and-or-joins-an-app-2/), [Busi+](https://doi.org/10.1006/inco.1999.2823), [Gelernter & Carriero](https://doi.org/10.1145/129630.376083), [Miller+ (E)](https://papers.agoric.com/papers/concurrency-among-strangers/abstract), [MAGπ](https://arxiv.org/abs/2301.10827), [Behavioral programming](https://www.wisdom.weizmann.ac.il/~amarron/BP%20-%20CACM%20-%20Author%20version.pdf), [ChatBDI](https://aamas.csc.liv.ac.uk/Proceedings/aamas2025/pdfs/p2541.pdf), [Kleppmann†](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html).
- **LLM evidence:** [CodeAct](https://proceedings.mlr.press/v235/wang24h.html), [type-constrained decoding](https://arxiv.org/abs/2504.09246), [MultiPL-T](https://arxiv.org/html/2308.09895v6), [AutoCodeBench write-up](https://codemyspec.com/blog/autocodebench-explained).
