# Lun language spec (draft v0)

> Status: design draft, 2026-11-06. Nothing here is implemented, and
> everything is open to change. The language sections were drafted by Claude
> and the runtime protocol (§11) is based on research by Codex
> ([runtime research](research/runtime.md)). The project was started at
> [Lambda Labs](https://github.com/LambdaLabsHQ).

## 1. What Lun is

Lun decides **who continues the work, and when**. It never does the work
itself.

Its units are autonomous participants: people, and complete AI agents of any
kind. They are not model calls or tools. Every call to a participant is a
*request* to someone who decides how to do the work. They may answer late,
decline, fail, or lose the authority to act.

That places Lun one level above agent frameworks such as LangGraph, whose
nodes are model calls and functions inside one agent. It is also
*choreography, not orchestration*: there is no central conductor. Each
program belongs to a person, an agent or a document section, and waits on
others the way a team member does.

### 1.1 Motivation

A team of people and agents needs several ways to suspend work and resume it
later:

- schedules;
- event triggers, such as "on merge" or "on CI failure";
- reminders;
- "waiting for your reply";
- pull-request subscriptions;
- approval and question cards;
- "keep going until it's done".

Products usually build each of these as its own feature. None of them says
what happens when the awaited thing never comes.

In the workspace where Lun was conceived, ten days of production data showed
the cost:

- 36 of 44 decisions that were waiting on a person closed silently by default.
- About 24 agent launches failed without anyone being told.
- 13 daily schedules woke on a timer only to ask whether anything had changed.

Each case is suspended work that went wrong. It was leaked, had nobody to
handle it, was woken by a timer instead of by its event, or was dropped on
failure. Lun makes "suspend, wait for something, then carry on" the one
primitive. Everything else is a library written in Lun.

## 2. Design principles

- **Programs, not graphs.** Nobody writes nodes and edges. Dependencies are a
  program's control flow and data flow.
- **Turing complete.** Safety comes from capabilities (§10), not from
  limiting what can be expressed.
- **Code is first-class content.** Programs live next to the documents they
  keep true, and are read as code.
- **Modern functional, with a syntax that reads well:**
  - immutable values;
  - everything is an expression;
  - algebraic data types and pattern matching;
  - events as streams composed with pipes;
  - a ReScript-flavoured surface close to languages models already write well.
- **Event-driven.** Waiting suspends a program until its event arrives.
  Nothing polls.
- **The language is separate from any host.** A host supplies participants,
  events and storage (§11). xMatrix is the first host.

## 3. A first look

```lun
// A decision with a default. The recommendation is written into the program.
switch ask(@alice, "Ship the billing probe? A: ship / B: skip", ~until=2026-11-07T12:00Z) {
| Done("B") => run(@auto, "Record the decision: skip the billing probe")
| Done(_) | TimedOut => run(@auto, "Ship the billing probe as recommended: at most US$0.10")
| other => fail(other)
}
```

```lun
// A chain of facts in the world, then an agent.
let pr = merged("acme/api#1436")->wait?
switch released(Beta, ~containing=pr)->wait(~until=1d) {
| Done(release) =>
  machineUpdated(~machine="win-builder", ~atLeast=release.version)->wait?
  run(@codex, "Check out acme/api on win-builder and confirm the long-path fix")
| _ => say(@alice, "#1436 did not reach a beta within a day")
}
```

```lun
// A standing duty.
every(1d)
->merge(ciFailed("acme/api"))
->forEach(_ => run(@auto, "Check production health and fix the riskiest issue"))
```

```lun
// A follow-up that hands the same request from an agent to a person,
// so only one of them ever works on it.
let q = request(@codex, "Is the build machine still overheating?")
switch q->wait(~until=1h) {
| Done(answer) => say(@alice, answer)
| TimedOut => q->handOver(@alice)->wait
| other => fail(other)
}
```

```lun
// Keep going until a judged condition holds.
let rec push = () => {
  let report = run(@claude, "Move #1439 forward until it is merged and verified live")?
  if !judge("merged and verified live", ~about=report)? {
    prActivity("acme/api#1439")->merge(after(2h))->wait?
    push()
  }
}
push()
```

## 4. Values and types

Types are inferred with Hindley–Milner inference. Only built-ins carry
written signatures, so ordinary programs need no annotations.

| Type | Literals and notes |
|---|---|
| `string`, `int`, `float`, `bool`, `unit` | As in ReScript. Templates are `` `…${x}…` ``. |
| `time`, `duration` | `2026-11-07T12:00Z` (always with its offset); `30m`, `2h`, `1d`, `1w`. A `~until=` takes either a time or a duration from now. |
| `participant` | `@alice`, `@codex`, `@codex:2` (one instance), `@auto` (the host picks a suitable agent). People and agents are values: they can be passed, stored and compared. Naming a participant grants nothing (§10). |
| `ref` | A reference to a host document or conversation, e.g. `doc"<id>#<section>"`, rendered as its title. |
| `list<'a>`, records, tuples, `option<'a>`, `result<'a, 'e>` | As in ReScript. |
| `outcome<'a>` | `Done('a) \| Declined(string) \| Failed(string) \| TimedOut \| Cancelled \| Revoked` |
| `request<'a>` | A durable handle to a request made of a participant. |
| `event<'a>`, `stream<'a>` | A fact that may hold, or occurrences that keep happening (§6.2). |
| User variants | `type choice = Ship \| Skip \| Later(duration)` |

`outcome` is the language's answer to autonomy:

- A participant answers (`Done`), refuses (`Declined`), or tries and fails
  (`Failed`).
- The request is called off (`Cancelled`), or the program's author loses the
  authority it needs (`Revoked`).
- `TimedOut` belongs to a *wait*, not to the request. It only means we stopped
  waiting.
  - With `ask` and `run`, which wait directly, the request is withdrawn at that
    moment, and the host records the withdrawal. Any work the participant
    already did is not undone, and a late answer is kept as evidence; it cannot
    resume the program again.
  - With a `request` handle, the request stays open. The program chooses to
    keep waiting, `cancel` it, or `handOver` the same request to someone else.

Types make a program acknowledge every case. They cannot prove it handles
each case well, because `TimedOut => ()` type-checks too. What the runtime
guarantees instead (§10, §11):

- state is visible;
- results can be checked;
- every failure has an owner.

## 5. Syntax

Lun is a subset of ReScript with a few additions.

- **Bindings and functions:** `let x = …`, `let f = (a, ~b, ~c=default) => …`,
  `let rec`. Blocks return their last expression. Pipe with `->`.
- **Control:** `if`, `switch` with patterns, recursion. There is no `while` and
  no mutation. Repetition is `forEach` over a stream, or recursion.
- **Additions:**
  - participant and reference literals;
  - time and duration literals;
  - postfix `?` on an `outcome`, `option` or `result`, as in Rust. On anything
    but `Done`, `Some` or `Ok`, the enclosing function returns that value at
    once. At the top of a program it ends the program, and the author is told
    (§10).
- **No function colouring.** There is no `async` or `await` keyword. A built-in
  that waits may suspend, and so may any function that calls one.
- **Left out of v0:**
  - modules beyond `open Std`;
  - exceptions, mutation and classes;
  - foreign-function interop;
  - macros.

## 6. Effects

Effects are the only way a program touches the world. Each one is performed as
the program's author, and is authorized at the moment it is performed (§10).

### 6.1 Built-ins

| Built-in | Waits? | Meaning |
|---|---|---|
| `ask(who, text, ~options=?, ~until=?) : outcome<string>` | yes | Asks a person or an agent, and waits for the answer. The host shows the request to `who`, with who is waiting and until when. |
| `run(who, task, ~context=?, ~until=?) : outcome<report>` | yes | Starts a run of `who` on `task`, written in natural language, and waits for its final report. What `report` contains is host-defined: text, changes made, evidence. |
| `request(who, text)`, `start(who, task) : request<'a>` | no | The same two calls, returning a handle instead of waiting. |
| `wait(x, ~until=?) : outcome<'a>` | yes | Waits for a request, an event or a stream (§6.2). |
| `cancel(r)`, `handOver(r, who)`, `status(r)` | no | Calls a request off, moves the same request to another participant, or looks at its progress without waiting. |
| `say(to, text) : unit` | no | Posts a message to a participant or a `ref`. |
| `judge(condition, ~about=?) : outcome<bool>` | briefly | The host's judge model decides whether a condition written in natural language holds. |
| `now() : time` | no | The time the program resumed. It is stable within one step. |
| `fail(o) : 'b` | no | Ends the program with an outcome other than success (§10). |

Planned next, not in v0: structured child programs (`spawn` and `join`) for
asking several participants at once.

### 6.2 Facts and occurrences

These are two different kinds of waiting, kept apart on purpose.

- **`event<'a>` is a fact that may already hold.** Examples:
  - `merged("owner/repo#n")`
  - `released(Beta, ~containing=pr)`
  - `replied(messageRef, ~by=?)`
  - `runEnded(runRef)`

  Waiting for a fact that already holds returns at once. The host observes the
  fact and registers the wait as one step, so a change cannot slip between
  observing "false" and starting to wait.
- **`stream<'a>` is occurrences that keep happening.** Examples:
  - `every(d)` and `after(d)`
  - `ciFailed("owner/repo")`
  - `prActivity("owner/repo#n")`
  - `docChanged(ref)`
  - `message(ref, ~from=?)`
  - host app events

  Streams compose with `merge`, `filter` and `map`. `wait(stream)` returns the
  next occurrence after the program starts listening. `forEach` handles every
  occurrence until the program ends. A `forEach` declares what happens when
  occurrences arrive while the previous one is still being handled: run them
  one after another, coalesce them, or run them concurrently. The default is
  to coalesce.

An occurrence caused by the program's own effects never wakes that same
program. That is the guard against loops, and it needs no count limit.

## 7. Where programs live

A program lives next to what it keeps true. In xMatrix that is a `lun` block in
a Page section or a message.

- **Starting is explicit.** A program starts through a host's admission step,
  the same one that admits other work. Code quoted in a document, or shown as
  an example, is content, not a running program.
- **The host shows each running program where it lives**, in words. For
  example: "waiting for Alice's answer until 11-07 12:00 UTC; then the
  recommendation".
- **The participant being waited on sees the same request.** They can answer
  it, decline it, or give an ETA, which moves the deadline.
- **Shared functions live in a standard library** written in Lun and opened
  with `open Std`.

## 8. The standard library, in Lun

Higher-level features are functions, not product features:

```lun
let remind = (who, text, ~at) => {
  at->sleepUntil?
  ask(who, text)
}

let decide = (who, question, ~recommend, ~until) =>
  switch ask(who, `${question}\nRecommended: ${recommend}. No answer by ${until->show} means the recommendation.`, ~until) {
  | Done(choice) => choice
  | TimedOut => recommend
  | other => fail(other)
  }

let followUp = (who, text, ~until, ~escalateTo) => {
  let q = request(who, text)
  switch q->wait(~until) {
  | TimedOut => q->handOver(escalateTo)->wait
  | answered => answered
  }
}

let schedule = (~every as period, ~on=[], task) =>
  every(period)->mergeAll(on)->forEach(_ => run(@auto, task))

let digest = (who, ~every as period) =>
  schedule(~every=period, `Tell ${who->name} what changed since they last looked; say nothing if nothing changed`)
```

Common features of agent products reduce to these functions:

- cron-like schedules → `schedule`;
- event triggers → `schedule(~on=…)` or `forEach`;
- reminders → `remind`;
- "waiting for your reply" → `ask`;
- PR subscriptions → `prActivity(…)->forEach`;
- approval cards → `ask` issued by the host;
- decisions with defaults → `decide`;
- "keep going until it's done" → the `push` loop in §3.

## 9. Execution model in one paragraph

A running program is a pure functional evaluation that pauses only at effects.
At each effect the host durably records the program's state together with the
effect's intent. It performs the effect under current authority, and later
resumes the program with exactly one committed result. How the state is
represented is the host's choice (§11): an explicit evaluator state, replay
from an effect journal, or a hybrid. The language guarantees the same
observable behaviour either way.

## 10. Safety and authority

- **Capabilities, not restrictions.** A program reaches the world only through
  §6. It cannot open sockets, read secrets, spend money or send mail. Those
  things happen inside agent runs that `run` starts, under the agent's own
  permissions and approval policies.
- **Code is pinned; authority is not.** A waiting program keeps running the code
  it started with. Every effect is admitted under the author's *current*
  grants. Authority lost during a long wait shows up as `Revoked`. Suspended
  state stores references to credentials, never credentials themselves.
- **Naming is not granting.** Passing `@alice` to another program does not let
  that program act as Alice.
- **Failures surface.** A program that ends without success is reported to its
  author as a request. A failure is never silence.
- **Pure computation between waits is time-sliced** and charged to the
  author. A loop that never waits is a bug in that program, not a reason for a
  language-wide cap.
- **Defaults that spend money, contact outsiders, or cannot be undone** must
  say so: amount and scope go into the program text, where reviewers and
  tools can see them.

## 11. Runtime protocol (from the [runtime research](research/runtime.md))

The language fixes a portable kernel. Hosts implement a contract.

**The kernel owns:**

- the grammar, types and standard library;
- a versioned portable program representation and a reference evaluator;
- the host contract, which covers:
  - durable state transitions;
  - request delivery;
  - event observation;
  - time;
  - authorization results;
- a local durable store and clock, so examples and restart tests run without
  any host;
- a deterministic failure-injection conformance suite that every host must
  pass.

**Every host must preserve:**

1. **Requests and waits have separate lifetimes.** A request is durable once its
   intent is recorded. Recording it does not mean the recipient accepted,
   started or finished.
2. **One committed resumption, not one physical evaluation.** Pure code may be
   re-evaluated after a crash. Only one state transition from a given
   suspended revision commits. Retries reuse the same request and effect
   identities, and a recipient deduplicates them.
3. **Unconfirmed actions are reconciled, not repeated.** After dispatch and before
   a receipt, the host reconciles the original identity. It does not invent
   success and does not blindly repeat.
4. **Facts and occurrences are different.** See §6.2.
5. **Code is pinned and authority is current.** See §10. A change to a program's
   definition creates a new version. The host's activation contract says
   whether running instances drain, are cancelled, or are explicitly
   migrated. It never runs both versions by accident.

**Conformance cases** (to be implemented, not yet passing):

- a person replies after a long wait and a host restart;
- a fact that already held before the wait;
- duplicate events and concurrent workers;
- a crash between recording an intent and dispatching it;
- a crash between dispatch and receipt;
- a reply racing a timeout or a deleted source;
- cancellation while an agent is already running;
- permission withdrawn while suspended;
- a definition or ABI change;
- bursts of stream events;
- pure loops that never wait;
- handing over a request without duplicating its rights.

## 12. The formal model underneath (under research)

The behaviour above can be read as continuations, algebraic effects and
handlers, actors with timed receives, or choreographies. These models are
close, and several are isomorphic. Two surveys are in progress:

- **The candidates:**
  - continuations;
  - algebraic effects (OCaml 5, Koka, Effekt, Unison);
  - actors (Erlang `receive … after`, virtual actors);
  - CSP and the π-calculus;
  - dataflow (Bloom, Hydro);
  - statecharts and Petri nets;
  - tuple spaces (Linda);
  - durable promises.
- **Choreographic programming and multiparty session types**: Choral,
  HasChor, MultiChor, ChoRus.

Their results will decide which formal model the spec is written against, and
whether interactions between participants can be type-checked as protocols.

## 13. Open questions

1. **Concurrency.** Do structured child programs (`spawn`/`join`) belong in v0?
   Should multi-shot resumption be exposed at all? The current answer is no:
   child requests get distinct identities instead.
2. **Activation.** How exactly do hosts admit and stop programs, and what does
   an edit do to a running instance?
3. **Decentralization.**
   - (a) Each scope has one authority, and authorities co-operate through
     authenticated messages. This is the current assumption.
   - (b) Waiting programs live on participants' own machines.
4. **Recovery backend for the first host.** The choice is between an explicit
   evaluator state with an effect journal, and replay on a managed workflow
   service. It will be settled by a failure-injection prototype.
5. **Concrete syntax details.**
   - Time literals.
   - `?` on nested outcomes.
   - Which `forEach` policy is the default.
   - The file extension.

## 14. Non-goals

- **Not an agent framework.** How one agent thinks belongs to that agent.
- **Not a general-purpose language.** No I/O, packages or network access
  inside the language.
- **Not tied to one vendor, one agent harness or one host.**
