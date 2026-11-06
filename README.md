# Lun

**The coordination language for teams of people and AI agents.**

> Status: design draft. There is no implementation yet. The spec is open
> for discussion: open an issue.

Lun (轮, "turn": whose turn it is to carry the work forward) decides **who
continues the work, and when**. It never does the work itself.

The units of a Lun program are autonomous participants: people, and complete
AI agents of any kind. They are not model calls or tools. Every call to a
participant is a *request*. They may answer late, decline, fail, or lose the
authority to act, and the language makes a program handle each of these.

```rescript
// Ask a person; if nobody answers by the deadline, carry out the recommendation.
switch ask(@alice, "Ship the billing probe? A: ship / B: skip", ~until=2026-11-07T12:00Z) {
| Done("B") => run(@auto, "Record the decision: skip the billing probe")
| Done(_) | TimedOut => run(@auto, "Ship the billing probe as recommended: at most US$0.10")
| other => fail(other)
}
```

```rescript
// Wait for facts in the world, then hand the next step to an agent.
let pr = merged("acme/api#1436")->wait?
switch released(Beta, ~containing=pr)->wait(~until=1d) {
| Done(release) => run(@codex, `Verify ${release.version} on the Windows build machine`)
| _ => say(@alice, "#1436 did not reach a beta within a day")
}
```

```rescript
// A standing duty: every day, and whenever CI fails on main.
every(1d)
->merge(ciFailed("acme/api"))
->forEach(_ => run(@auto, "Check production health and fix the riskiest issue"))
```

## Why a language

Teams of people and agents keep re-inventing the same few mechanisms:
reminders, schedules, "waiting for your reply", subscriptions to pull
requests, approval cards, "keep going until it's done". None of them says what
happens when the awaited thing never comes. They are all the same thing:
suspend, wait for something, then carry on. Lun makes that one primitive,
and everything else is a library written in Lun.

## Principles

- **Coordination, not orchestration.** There is no central conductor. Each
  program belongs to a person, an agent or a document, and waits on others the
  way a team member does. Lun sits one level above agent frameworks: how an
  agent thinks is the agent's business.
- **Programs, not graphs.** You write ordinary functional programs. The
  dependency graph is whatever the runtime can draw from where programs are
  waiting.
- **Autonomy in the types.** `Done | Declined | Failed | TimedOut | Cancelled |
  Revoked`. A request and a wait are separate things, so a timeout never
  quietly turns into duplicated work.
- **Capabilities, not restrictions.** Lun is Turing complete. A program touches
  the world only through a handful of effects, and real actions such as
  spending, mailing or deploying happen inside agent runs, under their own
  permissions.
- **Event-driven.** Waiting suspends the program, possibly for weeks and across
  restarts and deploys. Nothing polls.
- **Modern functional and pleasant to read.** It has a ReScript-flavoured
  surface, close to what models already write well, because agents will write
  most Lun.

## Documents

- [Language spec (draft v0)](docs/spec.md)
- [Durable runtime research](docs/research/runtime.md)

## Hosts

A host implements Lun's effects: who the participants are, how requests reach
them, which events exist, and where waiting programs are stored.
[xMatrix](https://github.com/LambdaLabsHQ/xmatrix) is the first host. The
language does not depend on it.

## License

[Apache-2.0](LICENSE)
