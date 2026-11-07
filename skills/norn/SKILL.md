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
- **Outcomes.** Every request ends in one of six outcomes:
  `outcome<'a> = Done('a) | Declined(string) | Failed(string) | TimedOut | Cancelled | Revoked`.
- **Waiting.** Waiting suspends the program for minutes or weeks, across
  restarts, and nothing polls. A deadline (`~until=`) belongs to the wait, not
  to the request.
- **Facts and streams.** A fact (`event<'a>`) may already hold, as with
  `merged("acme/api#1436")`. A stream (`stream<'a>`) keeps happening, as with
  `ciFailed("acme/api")`. The host declares which ones exist.
- **Syntax.** The syntax is ReScript. Values never change. There is no
  `async`/`await`, no `while` and no exceptions. To repeat, use recursion or
  `forEach` over a stream.

## Built-ins

| Call | Type and meaning |
|---|---|
| `ask(who, text, ~options=?, ~until=?)` | `outcome<'a>`. With `~options=[A, B]` the answer is one of the constructors; without options it is a `string`. A timeout withdraws the question. |
| `run(who, task, ~context=?, ~until=?)` | `outcome<report>`: someone works on a task until it ends. |
| `request(who, text)`, `start(who, task)` | `request<string>` and `request<report>`: a handle. Nothing waits until you call `wait`. |
| `wait(x, ~until=?)` | `outcome<'a>` for a request, fact or stream. With a handle, a timeout leaves the request open. |
| `handOver(r, who)`, `cancel(r)`, `status(r)` | Give the same request to someone else, call it off, or look at it: `status` returns `option<outcome<'a>>`. |
| `say(to, text)` | `unit`. Posts to a participant or a `doc"…"`/`channel"…"` reference. |
| `judge(condition, ~about=?)` | `outcome<bool>`. The host's judge decides a condition stated in words. |
| `now()`, `show(x)` | The current time; any value rendered as text. |
| `fail(o)` | Ends the program with an outcome other than `Done`. |
| `ignore(x)` | Drops a value on purpose. |
| `every(d)`, `after(t_or_d)`, `never()` | Timer streams, and a stream that never fires. |
| `a->merge(b)` | Two streams of one element type; their values are kept. |
| `a->or(b)` | Any two streams; it only says that something happened. |
| `map`, `filter`, `forEach` | Stream functions. `forEach` runs a handler for every occurrence and never returns. |

`open Std` adds `remind`, `decide`, `followUp`, `schedule` and `digest` (see
`std/std.norn`).

## Rules the checker enforces

Run `norn check --json file.norn` and fix what it reports. Every diagnostic has
a stable `code`.

| Code | Means | Fix |
|---|---|---|
| `non-exhaustive` | A `switch` misses cases; `missing` lists them. | Handle them. To end the program on the rest, add `\| other => fail(other)`. |
| `dropped-outcome`, `unused-outcome` | An outcome is thrown away. | Use `switch`, `?` or `fail`, return it, or write `ignore(e)` if dropping it is intended. |
| `try-return` | `?` is used on an `option` or a `result` in a function that returns an outcome, or the other way round. | Use a `switch` to convert, or make the function return the same family. |
| `type-mismatch` | The types disagree; read `expected` and `found`. | Common causes: a function uses `?` but returns a plain value (end it with `Done(value)`), `switch` branches return different types, `merge` gets two different streams (use `or`), or text is an outcome (take it out with `?`). |
| `not-handled` | A `forEach` handler returns something other than `()` or an outcome. | Return the outcome, or wrap the call in `ignore`. |
| `unknown-name` | A name is not bound. | For `remind`, `decide` and the other Std functions, add `open Std`. For a fact or stream, check that the host interface declares it. |
| `ask-options` | `~options` mixes types or is not a list of constructors. | Declare `type choice = A \| B` and pass `[A, B]`. |
| `not-a-deadline` | `~until` is given something other than a time or a duration. | Use `2026-11-07T12:00Z` or `1h`. |
| `refutable-pattern` | A `let` pattern can fail to match. | Use `switch`. |

In `` `…${x}…` ``, only strings can be interpolated: write `${x->show}`. An
`if` without `else` must produce `()`.

## Patterns

**A decision with a default.** Only a timeout takes the recommendation; a
refusal is not consent.

```norn
type probe = Ship | Skip

switch ask(@alice, "Ship the billing probe?", ~options=[Ship, Skip], ~until=2026-11-07T12:00Z) {
| Done(Skip) => run(@auto, "Record the decision: skip the billing probe")
| Done(Ship) | TimedOut => run(@auto, "Ship the billing probe as recommended: at most US$0.10")
| other => fail(other)
}
```

**A follow-up with a handover.** The same request moves to another person, so
no answer is lost.

```norn
let q = request(@codex, "Is the build machine still overheating?")
let reply = switch q->wait(~until=1h) {
| TimedOut => q->handOver(@alice)->wait
| other => other
}
say(doc"ops#machines", reply?)
```

**A chain of facts.** The next step starts when the world is ready.

```norn
let pr = merged("acme/api#1436")->wait?
let release = released(Beta, ~containing=pr)->wait(~until=1d)?
run(@codex, `Verify ${release.version} on the Windows build machine`)
```

**A standing duty.** A failed run is reported to the author, and the duty goes
on.

```norn
every(1d)
->or(ciFailed("acme/api"))
->forEach(_ => run(@auto, "Check production health and fix the riskiest issue"))
```

**Keep going until done.** The function returns an outcome, so `?` can pass a
failure up.

```norn
let rec push = () => {
  let report = run(@claude, "Move #1439 forward until it is merged and verified live")?
  if judge("merged and verified live", ~about=report)? {
    Done(report)
  } else {
    prActivity("acme/api#1439")->or(after(2h))->wait?
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
- **Prefer `request` and `wait` to `ask`** when you may want to hand the
  question over or keep waiting after a deadline.
- **Read the effects in `norn check --json` before proposing a program.** That
  is everyone it will ask or run. They inform review and grant nothing.
- **A checked program is not a running one.** A host starts programs through
  its own admission step. Don't claim a program ran because it type-checks.
