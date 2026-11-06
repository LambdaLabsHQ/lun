# Types in Norn (draft v0)

> Status: design for `norn check`, 2026-11-06. It refines spec §4–§6. Where
> the two disagree, this document is newer.

Agents will write most Norn, and people will review it. The type checker
serves both. It asks for no annotations. Its main job is to make sure no
`outcome` is lost. Every outcome is inspected with `switch` and all of its
cases, propagated with `?`, ended with `fail`, returned, or set aside with
`ignore` in the program text. When it rejects
a program, it says where, what it expected and what it found, in words a model
can act on.

## 1. Inference

- **Hindley–Milner.** Types are inferred by Hindley–Milner inference with let
  generalization. Norn has no mutation, so no value restriction is needed.
- **Recursion.** A `let rec … and …` group is inferred together and
  generalized after the group.
- **Functions are uncurried**, as in ReScript 11.
  - A function type lists positional parameters in order and labelled
    parameters by name: `(participant, string, ~until: time=?) => outcome<string>`.
  - A call supplies every positional argument and every required label. A
    label with a default may be left out.
  - `~label` alone means `~label=label`.
  - A function passed as a value unifies with its whole type, labels
    included.
- **Pipes.** `a->f(b)` is `f(a, b)`, and `a->f` is `f(a)`.

## 2. Types

- **Base types:** `string`, `int`, `float`, `bool`, `unit`, `time`,
  `duration`, `participant`, `ref`.
- **Built-in type constructors:**
  - `list<'a>` and tuples;
  - `option<'a> = None | Some('a)`;
  - `result<'a, 'e> = Ok('a) | Error('e)`;
  - `outcome<'a> = Done('a) | Declined(string) | Failed(string) | TimedOut | Cancelled | Revoked`.
- **Sources.** `event<'a>`, `stream<'a>` and `request<'a>` are one internal
  type, `source<'kind, 'a>`, with three kinds: fact, occurrence and request.
  - So `wait` has one ordinary type for all three.
  - `merge` and `forEach` accept only streams, and `cancel` accepts only
    requests.
  - Messages always use the three familiar names.
- **User types** are declared with `type`, as in ReScript: variants and
  records.
  - **Records are nominal.** A record literal must match a declared record
    type by its fields.
  - **Field access.** In `x.f`, the field comes from the type of `x`. If that
    type is not known yet, it comes from the latest declared record type that
    has a field `f`.
- **Constructors.** Constructor names are global to a program and the
  interfaces it sees. Declaring one twice is an error.

## 3. Constrained type variables

Five small closed classes stand in for overloading. A constrained variable
checks membership when it meets a concrete type. Two constrained variables
meet in their intersection. Generalization keeps the constraint, so a helper
that compares its arguments stays generic over every ordered type.

| Class | Members | Used by |
|---|---|---|
| `ordered` | `int`, `float`, `string`, `time`, `duration` | `<` `<=` `>` `>=` |
| `equality` | every type with no function inside | `==` `!=`, literal patterns |
| `deadline` | `time`, `duration` | `~until`, `after` |
| `addressee` | `participant`, `ref` | `say` |
| `handled` | `unit`, `outcome<_>` | the handler of `forEach` |

Arithmetic is not overloaded, as in ReScript:

- `+ - * /` and unary `-` take `int`;
- `+. -. *. /.` and unary `-.` take `float`;
- `++` takes `string`;
- `&& || !` take `bool`.

## 4. `?`

If `e : outcome<'a>`, then `e? : 'a`, and the enclosing function must return
`outcome<'b>` for some `'b`. The other cases carry no `'a`, so they are
returned unchanged.

- `option` works the same way.
- `result<'a, 'e>` also keeps its error type `'e`.
- At the top of a program, `?` ends the program and adds no constraint.
- If the family of `e` is still unknown when `?` is checked, it is taken to be
  `outcome`.

## 5. Built-ins

`'d` is a `deadline` variable and `'t` an `addressee` variable.

| Built-in | Type |
|---|---|
| `ask` | `(participant, string, ~options: list<'a>, ~until: 'd=?) => outcome<'a>` |
| `ask` without `~options` | `(participant, string, ~until: 'd=?) => outcome<string>` |
| `run` | `(participant, string, ~context: 'c=?, ~until: 'd=?) => outcome<report>` |
| `request` | `(participant, string) => request<string>` |
| `start` | `(participant, string, ~context: 'c=?) => request<report>` |
| `wait` | `(source<'k, 'a>, ~until: 'd=?) => outcome<'a>` |
| `cancel` | `(request<'a>) => unit` |
| `handOver` | `(request<'a>, participant) => request<'a>` |
| `status` | `(request<'a>) => option<outcome<'a>>`, which is `None` while the request is open |
| `say` | `('t, string) => unit` |
| `judge` | `(string, ~about: 'b=?) => outcome<bool>` |
| `now` | `() => time` |
| `show` | `('a) => string` |
| `fail` | `(outcome<'a>) => 'b` |
| `every` | `(duration) => stream<time>` |
| `after` | `('d) => stream<time>` |
| `never` | `() => stream<'a>` |
| `merge` | `(stream<'a>, stream<'a>) => stream<'a>` |
| `or` | `(stream<'a>, stream<'b>) => stream<unit>` |
| `map` | `(stream<'a>, ('a) => 'b) => stream<'b>` |
| `filter` | `(stream<'a>, ('a) => bool) => stream<'a>` |
| `forEach` | `(stream<'a>, ('a) => 'h) => 'c`, where `'h` is `handled` |
| `ignore` | `('a) => unit` |

Notes:

- **`ask`.** The call site decides between the two `ask` types, by whether it
  passes `~options`. So `ask` cannot be passed as a value. The options must be
  constructors of one variant type.
- **`merge` and `or`.** `merge` keeps the values of two streams of one type.
  `or` takes any two streams and only says that something happened. That is
  what "wake me on either" needs.
  - `every(1d)->or(ciFailed("acme/api"))` type-checks.
  - To keep values from different streams, map them into one variant first,
    then `merge` them.
- **`forEach` never returns.** It handles occurrences until the program ends.
  - **What the handler returns:**
    - **`()` or `Done(_)`:** the loop takes the next occurrence.
    - **Any other outcome:** the outcome is reported to the program's author,
      and the loop goes on. One failed run does not end a standing duty, and
      the failure is not silent.
    - **To end the program**, the handler calls `fail(o)`.
    - **For an effect whose result does not matter**, wrap it in `ignore`.
  - **Other return types are an error.** A handler that returns an `int` or
    a `request` is probably a mistake. A runtime given unchecked code
    discards such values.
- **`report`** is a type the host declares (§7).

## 6. Exhaustiveness

- **Every `switch` must cover its scrutinee's type.**
  - This uses Maranget's usefulness algorithm over the cases, leaving out
    guarded cases.
  - A missing case is an error that names example patterns, such as
    "this switch does not handle `Declined(_)` or `Revoked`".
  - `int`, `float` and `string` have no finite set of values, so they need a
    catch-all case.
- **A case that can never match** is a warning.
- **`let` patterns must always match**: tuples, records, variables and `_`. To
  take apart an `outcome`, use `?` or `switch`.

## 6a. Outcomes are not dropped

Covering every case of a `switch` is not enough: `let _ = ask(…)` would still
drop an answer. An outcome must not be dropped silently. Three cases are
errors:

- an expression of type `outcome<_>` used as a statement that is not the last
  in its block;
- `let _ = e`, where `e : outcome<_>`;
- a `let` that binds an `outcome<_>`, in whole or as part of a pattern, to a
  name that is never used.

The message says what to do instead: handle it with `switch`, `?` or `fail`,
or write `ignore(e)` to drop it on purpose.

**A program's own result follows the same rule.** If its last expression is
an outcome other than `Done`, the program fails with that outcome, exactly as
if it had called `fail`. The author is told (spec §10). So a program that ends
with `run(…)` reports the run's failure; it does not complete quietly.

## 7. Host interfaces

A host tells the checker what its programs can see, in a Norn interface file.
It uses two declarations that only interface files may contain:

```norn
type pr                       // an abstract type
type channel = Beta | Stable
type release = {version: string}
type report = {text: string}

external merged: (string) => event<pr>
external released: (channel, ~containing: pr) => event<release>
external ciFailed: (string) => stream<string>
external prActivity: (string) => stream<string>
```

- `hosts/reference.norn` describes the simulated host and covers every
  example in the spec. `norn check` uses it unless `--host <file>` names
  another.
- The xMatrix host will publish its own interface file.
- **Grammar additions** for interface files:
  - abstract `type t` and `type t<'a>`;
  - `external name: type`;
  - function types `(T, ~label: U, ~other: V=?) => R` in type expressions.
- **AST version.** These additions add the node kinds `External`,
  `FunctionType` and `LabelledType`, and let `TypeDecl.definition` be `null`
  for an abstract type. That is AST version 2.
  - The runtime ignores `External`. The host supplies the implementation.

## 8. Effects shown for review (spec §12, item 5)

`norn check --json` reports two things for each program:

- **the effect families it may perform:** `ask`, `run`, `request`, `start`,
  `wait`, `cancel`, `handOver`, `say` and `judge`;
- **the participant literals** that appear as their targets.

These are computed over everything the program can reach, including the
standard library. They are an over-approximation for reviewers: they grant
nothing and replace no runtime check.

## 9. Diagnostics

Type errors read like parse errors. The message comes first, then the place,
then the source line with a caret under it:

```
error: this switch does not handle Declined(_) or Revoked at examples/decide.norn:4:1
```

- With `--json`, each diagnostic has these fields:
  - `severity`, `code`, `message` and `span`;
  - `expected` and `found` when two types disagree;
  - `missing` when cases are not covered.
- `code` is stable, so a skill or a doc can explain it.

## 10. Not in v0

- type annotations in programs;
- modules other than `Std`;
- row polymorphism and effect polymorphism;
- request races (`any`), which will come with durable `scope`;
- classes other than the five in §3.
