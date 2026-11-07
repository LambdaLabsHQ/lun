---
name: norn
description: Write, check and fix Norn programs (.norn files). Norn is the coordination language for teams of people and AI agents. Use this skill when work between participants should become a program: reminders, follow-ups, decisions with a default, waiting for an event, standing duties, or "keep going until it's done". Also use it when `norn check` reports errors.
---

# Writing Norn

A Norn program says how people and agents get something done together. The
program asks, waits, decides and hands work over. The work itself is done by
people and agents, never by the program. Every participant is autonomous: an
answer can come late, be a refusal, or never come. Norn makes every program
handle each of these cases.

## The model

- **Participants.** People and agents are values, such as `@alice`, `@codex`,
  `@codex:2` (one instance) and `@auto` (the host picks an agent). Naming a
  participant grants nothing.
- **Requests.** There is one verb for each kind of request: `ask` (free
  text), `confirm` (yes or no), `choose` (one of your options), `run` (a task)
  and `judge` (does a condition hold). Every verb returns a handle,
  `request<'a>`, at once. Nothing waits until you write `->wait`.
- **Replies.** A request ends in one of six replies, each naming who acted
  and why:
  `reply<'a> = Answered('a) | Refused(string) | NoReply | Broke(string) | Cancelled | Revoked`.
  - `Answered`: they answered. `Refused`: they declined. `Broke`: they tried
    and could not.
  - `NoReply`: the request's own `~by` deadline passed. Only a request made
    with `~by` can end this way.
  - `Cancelled`: the program called it off. `Revoked`: the authority behind it
    was lost.
- **Deadlines.** `~by=` is the request's own deadline; it stays with the
  request through a handover. `r->waitUntil(1h)` only stops *this wait*: it
  gives `None` and the request stays open, or `Some(reply)`.
- **Facts and streams.** A fact (`event<'a>`) may already hold, as with
  `merged("acme/api#1436")`. A stream (`stream<'a>`) keeps happening, as with
  `ciFailed("acme/api")`. The host declares which ones exist. They are not
  requests: `->wait` gives the value itself, and `->waitUntil(t)` an `option`.
- **Syntax.** The syntax is ReScript. Values never change. There is no
  `async`/`await`, no `while` and no exceptions. To repeat, use recursion or
  `forEach` over a stream.

## Built-ins

| Call | Type and meaning |
|---|---|
| `ask(who, question, ~by=?)` | `request<string>`: a free-text answer. |
| `confirm(who, question, ~by=?)` | `request<yesno>`, with the built-in `type yesno = Yes \| No`. |
| `choose(who, question, [A, B], ~by=?)` | `request<'a>`: one of the options, constructors of a variant type you declare. |
| `run(who, task, ~context=?, ~by=?)` | `request<report>`: someone works on a task and reports. |
| `judge(condition, ~about=?)` | `request<bool>`: the host's judge decides a condition stated in words. |
| `r->wait` | `reply<'a>` for a request; the value itself for a fact or a stream. |
| `r->waitUntil(t)` | `option<reply<'a>>` (or `option<'a>` for a fact or stream). `None`: this wait ran out, and the request stays open. |
| `handOver(r, who)`, `cancel(r)`, `status(r)` | Give the same request to someone else (same `~by`), call it off, or look at it: `status` returns `option<reply<'a>>`. |
| `say(to, text)` | `unit`. Posts to a participant or a `doc"…"`/`channel"…"` reference. |
| `now()`, `show(x)` | The current time; any value rendered as text. |
| `fail(r)` | Ends the program with a reply other than `Answered`. |
| `ignore(x)` | Sets a value aside on purpose; never a request. |
| `every(d)`, `after(t_or_d)`, `never()` | Timer streams, which give the `time`, and a stream that never fires. |
| `a->or(b)` | `stream<either<'a, 'b>>`: either stream, with its value as `First(x)` or `Second(y)`. |
| `map`, `filter`, `forEach` | Stream functions. `forEach` runs a handler for every occurrence and never returns; the handler returns `()` or a reply. |

`open Std` adds `remind`, `decide`, `followUp`, `schedule` and `digest` (see
`std/std.norn`).

`request`, `start`, `merge`, `outcome`, `Done`, `Declined`, `Failed`,
`TimedOut`, `ask(~options=)` and `~until` belong to the first draft and no
longer exist; the checker names the replacement.

## Rules the checker enforces

Run `norn check --json file.norn` and fix what it reports. Every diagnostic has
a stable `code`.

| Code | Means | Fix |
|---|---|---|
| `dropped-request`, `unused-request` | A request is never waited on. The runtime cancels it when the program ends. | Add `->wait` (or `->waitUntil(t)`), hand it over, return it, or `cancel` it. |
| `dropped-reply`, `unused-reply` | A reply is thrown away. | Use `switch`, `?` or `fail`, return it, or write `ignore(r)` if dropping it is intended. |
| `non-exhaustive` | A `switch` misses cases; `missing` lists them. | Handle them. To end the program on the rest, add `\| other => fail(other)`. |
| `try-operand` | `?` on something that is not a reply, option or result: often a request. | Wait first: `run(…)->wait?`. |
| `try-return` | `?` is used on an `option` or a `result` in a function that returns a reply, or the other way round. | Use a `switch` to convert, or make the function return the same family. |
| `type-mismatch` | The types disagree; read `expected` and `found`. | Common causes: a request where its reply is needed (add `->wait`), a reply where its value is needed (add `?`), a function uses `?` but returns a plain value (end it with `Answered(value)`), or `switch` branches return different types. |
| `not-handled` | A `forEach` handler returns something other than `()` or a reply. | Return the reply (`->wait`), or wrap the call in `ignore`. |
| `unknown-name`, `unknown-label`, `unknown-constructor` | A name is not bound. | For `remind`, `decide` and the other Std functions, add `open Std`. For a fact or stream, check that the host interface declares it. For a removed name, the message says what replaced it. |
| `choose-options` | The options of `choose` mix types or are not constructors. | Declare `type choice = A \| B` and pass `[A, B]`. For yes or no, use `confirm`. |
| `not-a-deadline` | `~by` or `waitUntil` is given something other than a time or a duration. | Use `2026-11-07T12:00Z` or `1h`. |
| `refutable-pattern` | A `let` pattern can fail to match. | Use `switch`. |

In `` `…${x}…` ``, only strings can be interpolated: write `${x->show}`. An
`if` without `else` must produce `()`.

## Patterns

**A decision with a default.** Only the request's own deadline takes the
recommendation; a refusal is not consent.

```norn
switch confirm(@alice, "Ship the billing probe?", ~by=2026-11-07T12:00Z)->wait {
| Answered(Yes) | NoReply => run(@auto, "Ship it as recommended: at most US$0.10")->wait
| Answered(No) => run(@auto, "Record the decision: don't ship")->wait
| other => fail(other)
}
```

**A choice among your own options.**

```norn
type plan = Ship | Delay | Drop

switch choose(@alice, "What should we do with the probe?", [Ship, Delay, Drop], ~by=1d)->wait {
| Answered(Ship) | NoReply => run(@auto, "Ship the probe")->wait
| Answered(Delay) => run(@auto, "Move the probe to next week")->wait
| Answered(Drop) => run(@auto, "Record the decision: drop the probe")->wait
| other => fail(other)
}
```

**A follow-up with a handover.** The same request moves to another person, so
no answer is lost.

```norn
let q = ask(@codex, "Is the build machine still overheating?")
let reply = switch q->waitUntil(1h) {
| Some(r) => r
| None => q->handOver(@alice)->wait
}
say(doc"ops#machines", reply?)
```

**A chain of facts.** The next step starts when the world is ready.

```norn
let pr = merged("acme/api#1436")->wait
switch released(Beta, ~containing=pr)->waitUntil(1d) {
| Some(release) => run(@codex, `Verify ${release.version} on the Windows build machine`)->wait
| None => run(@alice, "#1436 did not reach a beta within a day: find out why")->wait
}
```

**A standing duty.** A failed run is reported to the author, and the duty goes
on.

```norn
every(1d)
->or(ciFailed("acme/api"))
->forEach(_ => run(@auto, "Check production health and fix the riskiest issue")->wait)
```

**Keep going until done.** The function returns a reply, so `?` can pass a
failure up.

```norn
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

## Habits

- **Put defaults that spend money, contact outsiders or cannot be undone in the
  task text,** with the amount and scope, as in "at most US$0.10". Reviewers
  read the program.
- **Never poll.** Wait on a fact or a stream, or use `after`/`every` for a
  timer.
- **Put the deadline on the request with `~by`** when the request itself
  should end without an answer, as with a decision's default. Use
  `->waitUntil(t)` when you only want to stop waiting, to hand the request
  over or decide what to do next.
- **Read the effects in `norn check --json` before proposing a program.** That
  is everyone it will ask or run. They inform review and grant nothing.
- **A checked program is not a running one.** A host starts programs through
  its own admission step. Don't claim a program ran because it type-checks.
