# Norn language spec (draft v0)

> Status: design draft, 2026-11-06, revised 2026-11-07, open to change. The
> request and reply model was redesigned for clarity: see
> [Changes from the first draft](#15-changes-from-the-first-draft). A local reference
> implementation (a parser, a durable evaluator and a simulated host) runs
> four of the §3 examples from source
> ([reference runtime](reference-runtime.md)). No production host implements
> it yet. The language sections were drafted by Claude.
> The runtime protocol (§11) is based on research by Codex
> ([runtime research](research/runtime.md)). The formal model (§12) draws on
> two surveys ([models](research/models.md),
> [choreographies](research/choreographies.md)). The project was started at
> [Lambda Labs](https://github.com/LambdaLabsHQ).

## 1. What Norn is

Norn solves coordination at the language level. It describes how a group of
autonomous people and AI agents get something done together:

- who is responsible for what;
- who asks whom;
- what depends on what;
- what counts as done;
- how the work carries on when circumstances change.

Norn does not do the work itself; the participants do.

Its participants are people, and complete AI agents of any kind. They are not
model calls or tools. Every call to a participant is a *request* to someone
who decides how to do the work. They may answer late, decline, fail, or lose
the authority to act.

That places Norn one level above agent frameworks such as LangGraph, whose
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

In the workspace where Norn was conceived, ten days of production data showed
the cost:

- 36 of 44 decisions that were waiting on a person closed silently by default.
- About 24 agent launches failed without anyone being told.
- 13 daily schedules woke on a timer only to ask whether anything had changed.

Each case is the same relationship gone wrong: someone asks, someone answers
or doesn't, and the work goes on. A request was leaked, had nobody to handle
it, was woken by a timer instead of by its event, or was dropped on failure.
Norn expresses that relationship in a language. Each of the features above
becomes a short program, and the standard library is written in Norn itself.

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

```norn
// A decision with a declared default. Only the request's own deadline takes
// the recommendation: a refusal is not consent.
switch confirm(@alice, "Ship the billing probe?", ~by=2026-11-07T12:00Z)->wait {
| Answered(Yes) | NoReply => run(@auto, "Ship it as recommended: at most US$0.10")->wait
| Answered(No) => run(@auto, "Record the decision: don't ship")->wait
| other => fail(other)
}
```

```norn
// A chain of facts in the world, then an agent.
let pr = merged("acme/api#1436")->wait
switch released(Beta, ~containing=pr)->waitUntil(1d) {
| Some(release) =>
  machineUpdated(~machine="win-builder", ~atLeast=release.version)->wait
  run(@codex, "Check out acme/api on win-builder and confirm the long-path fix")->wait
| None => run(@alice, "#1436 did not reach a beta within a day: find out why")->wait
}
```

```norn
// A standing duty.
every(1d)
->or(ciFailed("acme/api"))
->forEach(_ => run(@auto, "Check production health and fix the riskiest issue")->wait)
```

```norn
// A follow-up that hands the same request over from an agent to a person.
// Handing over moves who continues; it does not undo what the agent may
// already have done, which the host still reconciles.
let q = ask(@codex, "Is the build machine still overheating?")
let reply = switch q->waitUntil(1h) {
| Some(r) => r
| None => q->handOver(@alice)->wait
}
say(doc"ops#machines", reply?)
```

```norn
// Keep going until a judged condition holds.
let rec push = () => {
  let report = run(@claude, "Move #1439 forward until it is merged and verified live")->wait?
  if judge("merged and verified live", ~about=report)->wait? {
    Answered(report)
  } else {
    prActivity("acme/api#1439")->or(after(2h))->wait
    push()
  }
}
push()?
```

## 4. Values and types

Types are inferred with Hindley–Milner inference. Only built-ins and host
interfaces carry written signatures, so ordinary programs need no annotations.
The typing rules, built-in signatures and exhaustiveness checks are in
[Types in Norn](types.md).

| Type | Literals and notes |
|---|---|
| `string`, `int`, `float`, `bool`, `unit` | As in ReScript, except that `int` has arbitrary precision: there is no 32-bit overflow. Templates are `` `…${x}…` `` and interpolate strings. |
| `time`, `duration` | `2026-11-07T12:00Z` (always with its offset); `30m`, `2h`, `1d`, `1w`. A deadline (`~by=`, `waitUntil`, `after`) takes either a time or a duration from now. |
| `participant` | `@alice`, `@codex`, `@codex:2` (one instance), `@auto` (the host picks a suitable agent). People and agents are values: they can be passed, stored and compared. Naming a participant grants nothing (§10). |
| `ref` | A reference to a host document or conversation, e.g. `doc"<id>#<section>"`, rendered as its title. |
| `list<'a>`, records, tuples, `option<'a>`, `result<'a, 'e>` | As in ReScript. |
| `request<'a>` | A durable handle to a request made of a participant. Every request verb returns one (§6.1). |
| `reply<'a>` | `Answered('a) \| Refused(string) \| NoReply \| Broke(string) \| Cancelled \| Revoked`: how a request ended. |
| `yesno` | `Yes \| No`: the answer to `confirm`. |
| `either<'a, 'b>` | `First('a) \| Second('b)`: which of two streams happened, with its value (§6.2). |
| `event<'a>`, `stream<'a>` | A fact that may hold, or occurrences that keep happening (§6.2). |
| User variants | `type choice = Ship \| Drop \| Later(duration)` |

### 4.1 Replies

A `reply` is the language's answer to autonomy. Each case names who acted
and why, and means one thing only:

| Case | Who acted | Meaning |
|---|---|---|
| `Answered(x)` | the participant | They answered, and `x` is the answer. |
| `Refused(why)` | the participant | They explicitly declined. |
| `NoReply` | the clock | The request's own `~by` deadline passed with no answer. Only a request made with `~by` can end this way, and the store's clock decides it (§11.1). |
| `Broke(why)` | the participant | They tried, and could not do it. |
| `Cancelled` | the program | We called the request off, with `cancel`, or by ending the program (§11.1). |
| `Revoked` | the authority | The authority behind the request was lost (§10). |

- **A wait running out is not a reply.** `r->waitUntil(1h)` gives
  `option<reply<'a>>`. `None` means only that this wait ran out; the request
  stays open, and the program decides to keep waiting, `cancel` it, or
  `handOver` the same request to someone else.
- **An answer the host cannot map is not a reply.** An invalid answer to
  `confirm` or `choose`, such as a free-text "maybe", is refused at the host's
  boundary and kept as evidence. The request stays open. It never becomes
  `Refused`, and never a choice.
- **Facts and streams are not requests**, so they have no replies: waiting on
  one gives its value (§6.2).

Types make a program acknowledge every case. They cannot prove it handles
each case well, because `NoReply => ()` type-checks too. What the runtime
guarantees instead (§10, §11):

- state is visible;
- results can be checked;
- every failure has an owner.

## 5. Syntax

Norn is a subset of ReScript with a few additions. Source files use the `.norn` extension.

- **Bindings and functions:** `let x = …`, `let f = (a, ~b, ~c=default) => …`,
  `let rec`. Blocks return their last expression. Pipe with `->`.
- **Control:** `if`, `switch` with patterns, recursion. There is no `while` and
  no mutation. Repetition is `forEach` over a stream, or recursion.
- **Additions:**
  - participant and reference literals;
  - time and duration literals;
  - postfix `?`, with one rule: on a `reply` it unwraps `Answered`, on an
    `option` `Some`, on a `result` `Ok`. Anything else returns from the
    current function at once, unchanged. At the top of a program it ends the
    program: the runtime records that value as the program's result and tells
    the author (§10).

    If `e : reply<'a>`, then `e? : 'a`, and the enclosing function must itself
    return some `reply<'b>`: the other cases carry no `'a`, so they are
    returned as they are. `option` and `result` work the same way, and a
    `result` keeps its error type. That is why the `push` loop in §3 ends with
    `Answered(report)`, not `()`. `?` does not wait: on a request, write
    `r->wait?`.
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

There is one verb for each kind of request. Every verb returns a handle at
once, and nothing waits until the program says `->wait`. `~by=` is always the
request's own deadline (§11.1).

| Built-in | Waits? | Meaning |
|---|---|---|
| `ask(who, question, ~by=?) : request<string>` | no | Asks a person or an agent a question with a free-text answer. |
| `confirm(who, question, ~by=?) : request<yesno>` | no | Asks for a yes or a no. |
| `choose(who, question, [A, B], ~by=?) : request<'a>` | no | Asks for one of the options, which are constructors of one variant type the program declares. |
| `run(who, task, ~context=?, ~by=?) : request<report>` | no | Starts a run of `who` on `task`, written in natural language. Its answer is the final report; what a `report` contains is host-defined: text, changes made, evidence. |
| `judge(condition, ~about=?) : request<bool>` | no | Asks the host's judge whether a condition written in natural language holds. |
| `r->wait : reply<'a>` | yes | Waits until the request ends. |
| `r->waitUntil(t) : option<reply<'a>>` | yes | Waits until the request ends or the time or duration `t` passes, whichever is first. `None` means only that this wait ran out; the request stays open. |
| `handOver(r, who) : request<'a>` | no | Moves the same request to another participant, with a new epoch (§12). The request keeps its `~by`. |
| `cancel(r) : unit` | no | Calls the request off. It ends `Cancelled` unless it has already ended. |
| `status(r) : option<reply<'a>>` | no | Looks at the request without waiting: `None` while it is open. |
| `say(to, text) : unit` | no | Posts a message to a participant or a `ref`. |
| `now() : time` | no | The time the program resumed. It is stable within one step. |
| `show(x) : string` | no | Renders a value as text for people: a time in ISO 8601, a duration as `1h` or `1d`, a participant as `@alice`, a variant by its name. |
| `fail(r) : 'b` | no | Ends the program with a reply other than `Answered` as its result (§10). |
| `ignore(x) : unit` | no | Sets a value aside on purpose. A request cannot be ignored: wait for it, hand it over, return it, or `cancel` it. |

**`judge` answers a `bool`, not a `yesno`.** `yesno` is the vocabulary a
person is offered: two named answers on a card, matched by name as
`Answered(Yes)`, so that consent is never a computed truth value. A judge does
not consent to anything; it decides whether a stated condition holds, which is
a truth value, and a program uses it as one: `if judge("merged", ~about=report)->wait? { … }`.

**A request is never dropped silently.** A `request<_>` must be waited on,
handed over, returned from a function, or `cancel`ed, and a `reply<_>` must be
inspected, propagated with `?`, ended with `fail`, returned, or `ignore`d. The
checker enforces both ([types](types.md) §6a). So a bare
`run(@codex, "Fix the build")` as a statement is an error that suggests
`->wait`. It matters because a program's open requests are cancelled when the
program ends (§11.1).

Planned next, not in v0:

- structured child programs (`spawn` and `join`) for asking several
  participants at once;
- `scope(f)` and request races (`any`). `scope` runs `f`, and every request
  started inside it is cancelled when `f` ends, loses an `any`, or passes its
  deadline (§12). They need durable scopes in the runtime first.

### 6.2 Facts and occurrences

These are two different kinds of waiting, kept apart on purpose. Neither is a
request, so neither has a reply: nobody answers, refuses or breaks a fact.

Which facts and streams exist is up to the host (§11). The ones below are
examples from the xMatrix host; only `every`, `after` and `never` are part of
the language.

- **`event<'a>` is a fact that may already hold.** Examples:
  - `merged("owner/repo#n")`
  - `released(Beta, ~containing=pr)`
  - `machineUpdated(~machine="win-builder", ~atLeast=version)`
  - `replied(messageRef, ~from=?)`
  - `runEnded(runRef)`

  Waiting for a fact that already holds returns at once. The host observes the
  fact and registers the wait as one step, so a change cannot slip between
  observing "false" and starting to wait.
- **`stream<'a>` is occurrences that keep happening.** Examples:
  - `every(d)`, and `after(t)`, which happens once, at a time or after a
    duration from now; both give the `time` they fired
  - `ciFailed("owner/repo")`
  - `prActivity("owner/repo#n")`
  - `docChanged(ref)`
  - `message(ref, ~from=?)`
  - host app events

  `s->wait` returns the next occurrence after the program starts listening.
- **Waiting gives the value itself.** `merged(pr)->wait : pr`, and
  `after(1h)->wait : time`. `x->waitUntil(t) : option<'a>` is `None` if `t`
  passes first.
- **Losing authority** while waiting on a fact or a stream ends the program as
  `Revoked` (§10). There is no reply for the program to inspect, because the
  program itself, not a request, lost its authority.

Streams compose:

- `a->or(b) : stream<either<'a, 'b>>` happens when either does, and keeps the
  value and where it came from: `First(x)` from `a`, `Second(y)` from `b`.
  Nesting keeps every value: `a->or(b)->or(c)` gives
  `either<either<'a, 'b>, 'c>`.
- `map` and `filter` transform and select occurrences.
- `never()` is a stream with no occurrences.
- `forEach` handles every occurrence until the program ends. Its handler
  returns `()` or a `reply`. `Answered(_)` or `()` takes the next occurrence;
  any other reply is reported to the author, and the loop goes on. To end the
  program, the handler calls `fail`. A `forEach` declares what happens when
  occurrences arrive while the previous one is still being handled: run them
  one after another, coalesce them, or run them concurrently. The default is
  to coalesce.

An occurrence caused by the program's own effects never wakes that same
program. That is the guard against loops, and it needs no count limit.

## 7. Where programs live

A program lives next to what it keeps true. In xMatrix that is a `norn` block in
a Page section or a message.

- **Starting is explicit.** A program starts through a host's admission step,
  the same one that admits other work. Code quoted in a document, or shown as
  an example, is content, not a running program.
- **The host shows each running program where it lives**, in words. For
  example: "waiting for Alice's answer, due 11-07 12:00 UTC; with no reply,
  the recommendation".
- **The participant being asked sees the same request**, with who is asking
  and its `~by` deadline. They can answer it, refuse it, or report that they
  could not do it. A message such as an ETA is a message: it does not move the
  deadline, which belongs to the program text.
- **Shared functions live in a standard library** written in Norn and opened
  with `open Std`.

## 8. The standard library, in Norn

Higher-level features are functions, not product features:

```norn
let remind = (who, text, ~at) => {
  after(at)->wait
  ask(who, text)->wait
}

let decide = (who, question, ~options, ~recommend, ~by) =>
  switch choose(who, `${question}\nRecommended: ${recommend->show}. No answer by ${by->show} means the recommendation.`, options, ~by)->wait {
  | Answered(choice) => choice
  | NoReply => recommend             // the declared default, and only when nobody replied in time
  | other => fail(other)
  }

let followUp = (who, text, ~within, ~escalateTo) => {
  let q = ask(who, text)
  switch q->waitUntil(within) {
  | Some(reply) => reply
  | None => q->handOver(escalateTo)->wait
  }
}

let schedule = (~every as period, ~on=never(), task) =>
  every(period)->or(on)->forEach(_ => run(@auto, task)->wait)

let digest = (who, ~every as period) =>
  schedule(~every=period, `Tell ${who->show} what changed since they last looked; say nothing if nothing changed`)
```

Common features of agent products reduce to these functions:

- cron-like schedules → `schedule`;
- event triggers → `schedule(~on=…)` or `forEach`;
- reminders → `remind`;
- "waiting for your reply" → `ask(…)->wait`;
- PR subscriptions → `prActivity(…)->forEach`;
- approval cards → `confirm`, issued by the host;
- decisions with defaults → `decide`;
- escalation → `followUp`;
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
  grants. Authority lost during a long wait shows up as `Revoked`: as the
  reply of a request whose authority was lost, or, while the program waits on
  a fact or a stream, as the program's own result. Suspended state stores
  references to credentials, never credentials themselves.
- **Naming is not granting.** Passing `@alice` to another program does not let
  that program act as Alice.
- **Failures surface.** A program's result is a reply to its author. A
  program that ends without success is reported to its author as a request,
  and a failure is never silence. It ends without success when:
  - its last expression is a reply other than `Answered`;
  - it calls `fail(r)`, with such a reply;
  - a `?` at its top level meets anything but `Answered`, `Some` or `Ok`;
  - it loses its authority while waiting on a fact or a stream (`Revoked`).

  The runtime records that value as the program's result. The type checker
  refuses to let a request or a reply be dropped silently
  ([types](types.md) §6a).
- **A program's own errors are not replies.** Division by zero, a bad
  argument to a built-in, or unchecked code that names something unbound end
  the program as a *program failure*, recorded with the error's text and
  reported to the author. They never become `Broke`, which only a participant
  who tried and could not gives. `fail(Answered(x))` is such an error, since
  an answer is not a failure; the checker cannot always rule it out.
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
4. **Facts and occurrences are different.** See §6.2. Neither is a request,
   and waiting on one never produces a reply.
5. **Code is pinned and authority is current.** See §10. A change to a program's
   definition creates a new version. The host's activation contract says
   whether running instances drain, are cancelled, or are explicitly
   migrated. It never runs both versions by accident.

### 11.1 Requests, replies and deadlines: the runtime contract

This is the contract the reference runtime implements, and every host after
it.

- **A request is single-assignment.** It goes from open to exactly one reply
  of §4.1. The first valid resolution committed by the request's authority
  wins. Invalid answers, and answers from a holder who no longer holds the
  request, are kept as evidence and resolve nothing.
- **`~by` is stored on the request** when its intent is recorded, as an
  absolute time on the store's clock: a duration is added to the store's time
  at that moment. It is part of the request, not of any wait on it.
- **The store's clock decides `NoReply`.** An answer committed at a store time
  strictly before `by` is `Answered` (or `Refused`, `Broke`). At `by` or
  later, the request has ended `NoReply`, whether or not any scan, alarm or
  worker has noticed yet: the reply is a function of the committed history and
  the store's clock, never of when a worker looked.
- **`handOver` keeps the request.** Same identity, same `~by`, a new epoch. The
  previous holder is told it was released.
- **`cancel(r)`** ends an open request `Cancelled` and tells its holder. On a
  request that has already ended it does nothing; the earlier reply stands.
- **Ending a program cancels its open requests.** However the program ends,
  every request it made that is still open ends `Cancelled`, and each holder
  is told, in the same commit that records the program's result. Work a
  holder already did is not undone.
- **Answer schemas are checked at the boundary.** `confirm` takes `Yes` or
  `No`, `choose` one of its options, `ask` any text, `run` a report, `judge`
  a `bool`. An answer outside the schema is refused to the participant, kept
  as evidence, and leaves the request open.
- **`r->wait`** suspends until the request has a reply, and returns it.
- **`r->waitUntil(t)`** stores the wait's own deadline, an absolute store
  time computed like `~by`. It returns `Some(reply)` if the request ends first,
  and `None` if the wait's deadline passes first; then the request stays open.
  When the request's `~by` comes first, or both fall at the same instant, the
  result is `Some(NoReply)`: the request ends, so the wait has its reply. A
  reply committed exactly at the wait's deadline loses: deadlines are
  exclusive.
- **Waiting on a fact or a stream** returns its value: `wait` gives `'a`,
  `waitUntil` gives `option<'a>`, and a `forEach` handler receives each
  occurrence's value itself, with no `Answered` around it. A loss of the program's authority during
  such a wait ends the program `Revoked`.
- **`or` keeps values.** `a->or(b)` delivers `First(x)` or `Second(y)`, with
  the occurrence's own value. Nesting composes: the path of `First`/`Second`
  constructors is stored with the wait's registration, so it survives a
  restart, and an occurrence recorded before a crash is delivered after it
  once, with the same value and path.

**Contract cases.** The redesign of §15 adds these cases to the conformance
suite. Each states the input history and the one allowed result.

1. **A deadline passes with no scan.** A request with `~by=1h`; the store's
   clock reaches 1h and nothing runs; then the holder answers. The answer is
   kept as evidence, and the request's reply is `NoReply`. A `wait` on it,
   resumed afterwards, returns `NoReply`; `status` returns `Some(NoReply)`.
2. **An old holder's reply after a handover.** `q` is held by `@codex`;
   `q->handOver(@alice)`; then `@codex` answers. The answer carries the old
   epoch, so it is kept as evidence and resolves nothing; the request is still
   open with `@alice`, and its `~by` is unchanged. `@alice`'s answer then
   resolves it.
3. **Two deadlines at the same instant.** `ask(@a, q, ~by=T)->waitUntil(T)`
   returns `Some(NoReply)`, never `None`, and the request has ended. With the
   wait's deadline strictly before `by`, it returns `None` and the request
   stays open.
4. **A request handle is dropped.** The checker refuses a program that drops
   one. A runtime given unchecked code that does so keeps the request open
   while the program runs, and cancels it when the program ends (`Cancelled`,
   holder told), like any other open request.
5. **`or` through nesting and restart.** `a->or(b)->or(c)` delivers
   `First(Second(y))` for an occurrence `y` of `b`. A crash after the
   occurrence is recorded and before the program resumes delivers the same
   value once after restart.
6. **ABI and store version bump.** Checkpoints and stores written before this
   redesign hold `outcome` values, `merge` waits, wait-level `TimedOut`
   results and `~until` deadlines. The runtime bumps its machine ABI
   (`norn-cek:3` → `norn-cek:4`) and its store schema (7 → 8). A checkpoint or
   store of an older version is refused with an error that names both
   versions; it is never reinterpreted under the new built-ins, and nothing
   migrates it silently.

**Conformance cases.** The reference runtime has local checks for the cases
marked ✓, against its SQLite store and simulated host. A host-independent
suite that every host runs is still to be written.

- ✓ a person replies after a long wait and a host restart;
- ✓ a fact that already held before the wait;
- ✓ concurrent workers; duplicate events are not checked yet;
- ✓ a crash between recording an intent and dispatching it;
- ✓ a crash between dispatch and receipt;
- ✓ a reply racing a deadline; a deleted source is not checked yet;
- the six contract cases of §11.1 (to be checked by the runtime that
  implements this redesign);
- cancellation while an agent is already running;
- ✓ permission withdrawn while suspended;
- ✓ a definition or ABI change is refused on resumption; migration is not
  implemented;
- bursts of stream events;
- ✓ pure loops that never wait;
- ✓ handing over a request without duplicating its rights.

## 12. The formal model underneath (proposed)

Two surveys informed this section. The model survey is
[research/models.md](research/models.md) and the choreography survey is
[research/choreographies.md](research/choreographies.md). Their conclusions
agree.

**Core: one-shot algebraic effects, run as stored continuations inside virtual
actors.**

- **Effects.** Every suspension is an effect, and the host is the outermost
  handler. Continuations are delimited, not `call/cc`, and one-shot, as in
  OCaml 5. Higher-level policies are ordinary handlers in the standard library
  (`escalating`, `decide`). Agents write direct-style code; handlers live in
  reviewed library code.
- **Virtual actors.** Each running program instance is a single-threaded actor
  with its own identity and state, so no conductor exists. The coordination
  protocol exposes two shared constructs; host resources such as documents
  retain their own concurrency rules:
  - **Durable single-assignment requests.** A request goes from `Pending` to
    exactly one reply (§4.1). A resolution must match the request's
    current epoch, reply schema and authority; the first valid resolution
    committed by its authority wins. Invalid or stale replies are evidence,
    not contenders. Resolution, cancellation and handover are serialized by
    that same authority.
  - **Pushed events.**
- **Where coordination is needed.** The [CALM theorem](https://arxiv.org/abs/1901.01930)
  relates coordination-free consistency to logical monotonicity. Immutable
  observations, such as evidence that a PR was merged, can accumulate without
  retracting earlier observations. Examples of non-monotone decisions here
  include:
  - "no answer by T";
  - a declared default;
  - the winner of an `any`;
  - `cancel`;
  - `handOver`.

  This is not an exhaustive list or a proof that the whole runtime is
  coordination-free. Admission, current permissions, revocation and resource
  invariants may also require authoritative ordering. Each such decision is
  committed by the authority for its scope; an actor cannot settle another
  authority's policy merely by observing an event.
- **Code identity.** Code is pinned per instance; edits start new instances;
  migration is explicit, as with Erlang's `code_change`. The recovery
  backend, explicit evaluator state or replay, is still chosen by the
  experiment in §11.

**Rules adopted from the surveys:**

1. **Structured cancellation.** `scope(f)` cancels every request started
   inside `f` when `f` returns, loses an `any`, or passes its deadline. This
   is the same idea as Orc pruning, YAWL cancel regions and leaving a
   statechart state. This is a logical, persistent scope: a durable program
   instance outlives the process or agent turn that created it. Ending that
   creator's turn does not end the program's scope or its reminders. Leaving
   the logical scope withdraws authority and requests cancellation; it does
   not prove that an external participant has stopped or undo prior effects.
2. **Handover is delegation plus fencing.**
   - `handOver(r, who)` keeps the same request and increases its epoch.
   - A resolution or capability that carries an old epoch is refused.
   - The previous holder is told it was released.
3. **Reply and delegation notices are durable.** A reply creates
   a durable notification intent for affected participants. Handover creates
   a delegation-change notice; it does not terminate the request. Delivery
   respects current access and availability. Failed or suppressed delivery is
   visible to the responsible owner rather than counted as delivered; the
   protocol cannot guarantee that an offline person has read a notice.
4. **Correlation keys.** Every wait names exactly what it waits for: a request
   identity, or a PR, SHA or release. A later, unrelated message can never
   satisfy it.
5. **Effect rows inform review, not authorization.** The inferred operation
   families (`ask`, `confirm`, `choose`, `run`, `say`, …) and statically known targets are shown before
   a program starts. Dynamically selected participants still require runtime
   resolution. An effect row neither grants a capability nor replaces the
   host's current permission and epoch checks at each effect.
6. **Dry runs.** A handler with a simulated clock and scripted answers runs a
   program before it is committed. That is how a person sees "if nobody
   answers, at 12:00 this happens".

**Choreographies are a view, not the core.** Choreographic programming gives
a global narrative; some calculi prove deadlock freedom under their specified
projection and execution assumptions. Those guarantees do not automatically
apply to this language's external participants. Only the program's own role runs
code: people, agents and external systems cannot run projected programs.
Timeouts, refusal, revocation, handover and durable waits are still research
topics there. Norn therefore keeps the effects core and borrows the
choreographic view:

- each participant's card, prompt and reply schema is generated from the
  program;
- answers that break that schema are refused at the boundary and kept as
  evidence; the request stays open (§11.1);
- a running instance can be drawn as a sequence diagram.

A `choreo` block could later be a library over effects. Choreographic
projection can be written as effect handlers, but effects cannot be built
from projection.

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
   - `?` on nested replies.
   - Which `forEach` policy is the default.

## 14. Non-goals

- **Not an agent framework.** How one agent thinks belongs to that agent.
- **Not a general-purpose language.** No I/O, packages or network access
  inside the language.
- **Not tied to one vendor, one agent harness or one host.**

## 15. Changes from the first draft

The first draft of this spec (2026-11-06) used one word for several things.
Daniel, the project's owner, found its syntax and semantics too ambiguous to
read reliably, so the surface was redesigned around one rule: **one word, one
meaning; a name says who acted and why.** The runtime's semantics were
reviewed with Codex. Old programs do not check or run under the new names, and
old checkpoints are refused (§11.1, case 6).

| First draft | Now | Why |
|---|---|---|
| `outcome<'a> = Done \| Declined \| Failed \| TimedOut \| Cancelled \| Revoked` | `reply<'a> = Answered \| Refused \| NoReply \| Broke \| Cancelled \| Revoked`, for requests only | `Done` read as "the work is done" for a mere answer; `Failed` mixed "they could not" with program failure; facts and streams had outcomes nobody could give. |
| `TimedOut` | `NoReply`, only for the request's own `~by`; a wait that runs out is `None` | `TimedOut` meant "withdrawn" after `ask` and "still open" after `request`: one word, two outcomes. |
| `~until=` on `ask`, `run` and `wait` | `~by=` on the request; `r->waitUntil(t)` for a wait | Two deadlines with one name; a handover could not say which deadline it kept. |
| `ask` and `run` waited; `request` and `start` returned handles | every verb returns a `request<'a>`, and waiting is always `->wait` | Two spellings of each request, with different timeout semantics. |
| `request(who, text)`, `start(who, task)` | removed: `ask`, `run` | Redundant once every verb returns a handle. |
| `ask(…, ~options=[A, B])` | `choose(who, question, [A, B])` | One verb whose answer type changed with a label. |
| a user `type yes = Yes \| No` for approvals | `confirm(…) : request<yesno>`, built-in `yesno` | Approval is the most common request; it needs no declaration. |
| `wait(x, ~until=?)` | `x->wait`, `x->waitUntil(t)` | The label changed the result's meaning. |
| `wait` on a fact or stream gave `outcome<'a>` | it gives `'a`; `waitUntil` gives `option<'a>` | Nobody answers or refuses a fact. |
| `merge(a, b)`; `or(a, b) : stream<unit>` | `a->or(b) : stream<either<'a, 'b>>` | `or` threw values away and `merge` kept them: two composers for one idea. |
| `judge(…) : outcome<bool>`, waiting | `judge(…) : request<bool>`, waited explicitly | Like every other request. |
| `fail(outcome)` | `fail(reply)` | Follows the rename. |
| dropped outcomes refused | dropped requests and replies refused | The runtime cancels a program's open requests when it ends, so a dropped handle is a silent cancellation. |
| the holder could give an ETA that moved the deadline | the deadline is the program's; an ETA is a message | A deadline that the waited-on party can move has no single meaning. |
| host fact `replied(ref, ~by=participant)` | `replied(ref, ~from=participant)` | `~by` now always means a request's deadline. |
