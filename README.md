# Norn

**The coordination language for teams of people and AI agents.**

> Status: design draft; front-end only. The spec is open for discussion:
> open an issue.

Norn solves coordination **at the language level**. A team of people and AI
agents has to settle several things:

- who is responsible for what;
- who asks whom;
- what depends on what;
- what counts as done;
- how the work carries on when something changes.

Products usually answer each of these with a separate feature: reminders,
schedules, approval cards, follow-ups. In Norn they are all just programs, much
as SQL turned "how do I get this data" into a language. The language does not
do the work itself; people and agents do. It describes how they get it done
together.

The participants are autonomous: people, and complete AI agents of any kind,
not model calls or tools. Every call to a participant is a *request*. They may
answer late, decline, fail, or lose the authority to act, and the language
makes a program handle each case.

```rescript
// Ask a person to choose; if nobody chooses by the deadline, the declared default applies.
type probe = Ship | Skip

switch ask(@alice, "Ship the billing probe?", ~options=[Ship, Skip], ~until=2026-11-07T12:00Z) {
| Done(Skip) => run(@auto, "Record the decision: skip the billing probe")
| Done(Ship) | TimedOut => run(@auto, "Ship the billing probe as recommended: at most US$0.10")
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
happens when the awaited thing never comes. Underneath, they are all the same
relationship: someone asks, someone answers or doesn't, and the work goes on.

Written as a language, these mechanisms compose. They can be read and
reviewed like any other code, and their failure cases can be checked.
Everything else becomes a library.

## Principles

- **Coordination, not orchestration.** There is no central conductor. Each
  program belongs to a person, an agent or a document, and waits on others the
  way a team member does. Norn sits one level above agent frameworks: how an
  agent thinks is the agent's business.
- **Programs, not graphs.** You write ordinary functional programs. The
  dependency graph is whatever the runtime can draw from where programs are
  waiting.
- **Autonomy in the types.** Outcomes are `Done | Declined | Failed |
  TimedOut | Cancelled | Revoked`. A request and a wait are separate things,
  so a timeout never quietly turns into a second request.
- **Capabilities, not restrictions.** Norn is Turing complete. A program touches
  the world only through a handful of effects, and real actions such as
  spending, mailing or deploying happen inside agent runs, under their own
  permissions.
- **Event-driven.** Waiting suspends the program, possibly for weeks and across
  restarts and deploys. Nothing polls.
- **Modern functional and pleasant to read.** It has a ReScript-flavoured
  surface, close to what models already write well, because agents will write
  most Norn.

## The name

In Norse myth, the Norns sit beneath the world tree Yggdrasil. They spin the
threads of fate for gods and people alike, settling what comes next and when.
Norn was also a real language: the Norse tongue of Orkney and Shetland, last
spoken in the 18th century. A language in which people and agents weave
their work together borrows its name.

## Documents

- [Language spec (draft v0)](docs/spec.md)
- [Syntax tree (AST) and syntax decisions](docs/ast.md)
- [Durable runtime research](docs/research/runtime.md)

## Building

The front-end has a lexer, a parser and the syntax tree. It is TypeScript,
and Node 22.18 or newer runs it as is: there is no build step. CI runs on
Node 24.

```sh
npm ci              # install the pinned dev dependencies
npm test            # run the tests
npm run typecheck   # type-check with tsc

npm run norn -- check examples std                   # report syntax errors
npm run norn -- parse examples/decide.norn           # print the syntax tree
npm run norn -- parse --json examples/decide.norn    # print it as JSON
```

`npm link` puts the `norn` command on your PATH.

The [examples](examples) are the programs of spec §3. The
[standard library](std/std.norn) is §8.

## Hosts

A host implements Norn's effects: who the participants are, how requests reach
them, which events exist, and where waiting programs are stored.
[xMatrix](https://github.com/LambdaLabsHQ/xmatrix) is the first host. The
language does not depend on it.

## License

[Apache-2.0](LICENSE)
