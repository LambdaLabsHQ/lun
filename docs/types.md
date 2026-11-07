# Types in Norn (draft v0)

> Status: design for `norn check`, 2026-11-06, implemented in
> [`src/frontend/check`](../src/frontend/check). It refines spec §4–§6. Where
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
  generalized after the group. Each of its functions has, from the start, the
  shape its parameters give it, so a recursive call may leave out a label
  that has a default.
- **Functions are uncurried**, as in ReScript 11.
  - A function type lists positional parameters in order and labelled
    parameters by name: `(participant, string, ~until: time=?) => outcome<string>`.
  - A call supplies every positional argument and every required label. A
    label with a default may be left out.
  - `~label` alone means `~label=label`.
  - A function passed as a value unifies with its whole type, labels
    included, and with whether each label is optional.
  - A call of a value whose type is not known yet, such as a parameter,
    decides that type: its positional arguments in order, and each label it
    passes, required.
- **Pipes.** `a->f(b)` is `f(a, b)`, and `a->f` is `f(a)`.
- **Parameters** are patterns that must always match, like `let` patterns
  (§6). A parameter list binds each name once.
- **Default values** are read inside the function, when a call leaves their
  label out.
  - A default sees the positional parameters and the labelled parameters
    before it. A labelled parameter after it is bound only when the caller
    passes it, so using one is an error.
  - `?` in a default returns from the function whose parameter it is.
- **Function literals passed as arguments** are checked against the
  parameter's function type from the start. So in
  `released(…)->map(r => r.version)` the type of `r` is known, and an error in
  a handler's result points at the handler's body.

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
  - The internal names cannot be written, so a program may declare its own
    `source`.
- **User types** are declared with `type`, as in ReScript: variants,
  records and aliases. A field or payload may have a function type, as in
  `type job = {name: string, action: () => outcome<report>}`.
  - **Records are nominal.** A record literal has the type of the latest
    declared record type with exactly its fields. A literal that leaves out a
    field of the type it matches is an error that names the missing fields.
    `{...r, f: v}` has the type of `r`, and `f` must be one of its fields.
  - **Field access.** In `x.f`, the field comes from the type of `x`. If that
    type is not known yet, it comes from the latest declared record type that
    has a field `f`. The host's types are declared before the program's.
- **Names of types and constructors are global** to a program, the standard
  library it opens and its host interface. Declaring one twice, or declaring
  a built-in one, is an error.
- **Declarations are read before the program.** A type may refer to itself
  and to types declared after it, so recursive and mutually recursive types
  need no `rec`. An alias that refers to itself is an error: declare a
  variant instead.
- **Template strings** interpolate strings, as in ReScript. `${x->show}`
  turns another value into text.
- **`if` without `else`** is `()` when its condition is false, so its branch
  must be `()` too.
- **Patterns** bind each name once: `(x, x)` is an error. Every alternative
  of an or-pattern binds the same names, with the same types.

## 3. Constrained type variables

Five small closed classes stand in for overloading. A constrained variable
checks membership when it meets a concrete type. Two constrained variables
meet in their intersection. Generalization keeps the constraint, so a helper
that compares its arguments stays generic over every ordered type. Its type
prints as `('a, 'a) => bool where 'a: ordered`.

| Class | Members | Used by |
|---|---|---|
| `ordered` | `int`, `float`, `string`, `time`, `duration` | `<` `<=` `>` `>=` |
| `equality` | every type with no function inside | `==` `!=`, literal patterns |
| `deadline` | `time`, `duration` | `~until`, `after` |
| `addressee` | `participant`, `ref` | `say` |
| `handled` | `unit`, `outcome<_>` | the handler of `forEach` |

- **One more, from §6a.** The checker puts `discardable`, "not an
  outcome", on a generic type whose values a function drops. It prints as
  `where 'b: discardable`.
- **Intersections.** `deadline` lies inside `ordered`. `equality` holds every
  member of `ordered`, `deadline` and `addressee`, and combines with
  `handled`: a variable can need `()` or an outcome whose value is
  comparable. Any other two classes have no common type, which is the
  `class-conflict` error.
- **Equality of declared types.** A variant or a record is an equality type
  when the types of its payloads and fields are, for its type arguments. An
  abstract host type is, when its type arguments are.
- **Sources.** A request compares as a handle. An event or a stream never
  compares, since it may hold a function, as `map` and `filter` do. A source
  whose kind is not known yet becomes a request when it is compared.
- **Participants** are compared together with their arguments, so an
  argument such as the `~repo` of `@auto(~repo="acme/api")` has no function
  inside.

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
- The first `?` in a function fixes the family it returns. A `?` of another
  family in the same function is an error, and so is a function whose value
  at its end is of another family.
- A `forEach` handler returns `()` or an outcome, so `?` on an `option` or a
  `result` cannot return from it.

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
  - That is checked where the options' type is known. A helper that passes
    its own parameter as `~options` stays generic; the runtime still refuses
    an option that is not a constructor.
  - An empty list literal of options is an error.
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
- **`report`** is a type the host declares (§7). A host that does not
  declare it gets an abstract `report`.

## 6. Exhaustiveness

- **Every `switch` must cover its scrutinee's type.**
  - This uses Maranget's usefulness algorithm over the cases, leaving out
    guarded cases.
  - A missing case is an error that names example patterns, such as
    "this switch does not handle `Declined(_)` or `Revoked`".
    - It names all of them, not a sample, in the order of the type's
      constructors: `Some(None)` before `Some(Some(false))`.
    - Where a type has no finite set of values, the example is `_`. When the
      only example is made of `_`, as `(_, _)` is, the message asks for a
      catch-all case.
  - `int`, `float` and `string` have no finite set of values, so they need a
    catch-all case. So do types that have no constructor patterns, such as
    `time` or `participant`.
- **A case that can never match** is a warning, and so is an alternative of a
  case's or-pattern that can never match.
- **`let` patterns and parameters must always match**: tuples, records,
  variables, `_`, `()` and constructors of a one-constructor variant. To take
  apart an `outcome`, use `?` or `switch`.

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

- A `_` that matches an outcome anywhere in a `let` pattern drops it, as in
  `let (_, n) = (ask(…), 1)`, and is an error too.
- Any reference to the name counts as a use, including `show(x)` and passing
  it on.
- **Generic functions.** A function may drop a value whose type it does not
  know yet, as `each` does with `f(x)` below. That type then gets the
  `discardable` constraint, so a use that makes it an outcome is the error:
  `each(people, who => ask(who, "Approve?"))` drops every answer.

  ```norn
  let rec each = (xs, f) => switch xs {
  | [] => ()
  | [x, ...rest] =>
    f(x)
    each(rest, f)
  }
  ```
- **The rules look at outcomes, not into other values.** A value that holds
  outcomes, such as `list<outcome<'a>>`, a tuple or a record, is not itself an
  outcome. So `let _ = (ask(…), 1)` passes, and so does a record pattern that
  leaves out an outcome field.

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
- **What an interface file holds:** only `type` and `external` declarations.
  - An external's type variables are generic: `external first: (list<'a>) =>
    option<'a>` works at every type.
  - An external may not redeclare a built-in or another external.
  - `report` takes no type parameters, since `run` returns `outcome<report>`.
  - A program reads a field from a value whose type is not known yet by the
    latest declared record type with that field (§2). So the records of one
    host should not share field names: the reference host's `message` has a
    `body`, so that `r => r.text` reads a `report`.
  - `norn check` checks the interface file in use as an interface when it is
    among the paths it is given. Any other `.norn` file is a program, so an
    abstract type or an external in it is an error.
- **Grammar additions** for interface files:
  - abstract `type t` and `type t<'a>`;
  - `external name: type`;
  - function types `(T, ~label: U, ~other: V=?) => R` in type expressions.
- **AST version.** These additions add the node kinds `External`,
  `FunctionType` and `LabelledType`, and let `TypeDecl.definition` be `null`
  for an abstract type. That is AST version 2.
  - The runtime ignores `External`. The host supplies the implementation.

## 7a. The standard library is opened explicitly

`std/std.norn` is in scope only after `open Std`, from that line on. It is not
implicitly in scope.

- **Why.** Spec §5 and §7 say the standard library is opened with `open Std`.
  An implicit library would make that line meaningless. With it, a reviewer
  who sees `decide` knows where it comes from.
- **Shadowing.** The names `open Std` brings in shadow earlier bindings of the
  same names, as `open` does in ReScript.
- **A hint.** Using a standard library name without `open Std` is an error
  that says to add it.
- **One check.** The standard library is checked once against the host
  interface in use, and a program sees its generalized types.

## 8. Effects shown for review (spec §12, item 5)

`norn check --json` reports two things for each program:

- **the effect families it may perform:** `ask`, `run`, `request`, `start`,
  `wait`, `cancel`, `handOver`, `say` and `judge`;
- **the participant literals** that appear as their targets.

These are computed over everything the program can reach, including the
standard library. They are an over-approximation for reviewers: they grant
nothing and replace no runtime check.

- **What counts.** All of the program's own code counts, even a function it
  never calls. A standard library function counts when the program refers to
  it, with the library functions it calls in turn.
- **`forEach`** waits for each occurrence, so it is in the `wait` family.
  `status` only looks, and is in no family.
- **Targets.**
  - A target is the first argument of `ask`, `run`, `request`, `start` and
    `say`, and the second of `handOver`.
  - Ref literals count as targets of `say`, as in `doc"ops#machines"`.
  - A literal counts when it is the argument, or a branch of an `if` or a
    `switch` there.
  - A literal passed to a parameter of a named function, or a literal default
    of a labelled parameter, counts where the parameter is a target.
    `remind(@alice, …)` asks `@alice`. Another name for a function, as in
    `let greet = tell`, counts as the function.
  - A target that reaches the effect any other way, such as through a
    function passed as an argument, is not listed. The family still is, and
    the runtime checks every effect when it happens (spec §10).
- **Shape.** `effects` is a list of `{family, targets}` in the order above,
  with the targets sorted, as in
  `[{"family": "ask", "targets": ["@alice"]}, {"family": "wait", "targets": []}]`.
  A program with errors has `"effects": null`.

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
- **The JSON document** is
  `{"host": {"file", "ok", "diagnostics"}, "files": [{"file", "ok", "diagnostics", "effects"}]}`.
  An interface file among the paths also has `"interface": true`.
- **Exit status:** 0 without errors, warnings allowed; 1 with an error; 2 on a
  usage or read error.
- **Running out of stack.** The checker walks chains, such as a 10,000-link
  `->` chain, in loops. A program that nests deeper than the stack can follow
  is the `too-deep` error, not a crash. There is no other limit.
- **Shared types.** A type that shares its parts, as the result of
  `x => (x, x)` applied 30 times does, is checked in time linear in its
  size. Printed in full it would not fit in a string, so a message shows "a
  type too large to show".

| Code | Severity | Meaning |
|---|---|---|
| `syntax` | error | the source does not parse |
| `type-mismatch` | error | a value's type is not the one its context needs |
| `infinite-type` | error | a type would have to contain itself |
| `not-ordered` | error | `<`, `<=`, `>` or `>=` on a type that has no order |
| `not-comparable` | error | `==` or `!=` on a type with a function inside |
| `not-a-deadline` | error | a deadline that is neither a time nor a duration |
| `not-an-addressee` | error | `say` to something that is neither a participant nor a ref |
| `not-handled` | error | a `forEach` handler that returns neither `()` nor an outcome |
| `class-conflict` | error | one value would need two classes that no type has together |
| `unknown-name` | error | a name that nothing binds |
| `unknown-constructor` | error | a constructor that no type declares |
| `unknown-type` | error | a type name that nothing declares |
| `unknown-type-variable` | error | a type variable that the declaration does not list |
| `unknown-field` | error | a field that the record type, or every record type, lacks |
| `unknown-label` | error | a labelled argument that the function does not take |
| `missing-field` | error | a record literal without a field of its type |
| `missing-label` | error | a call without a labelled argument the function requires |
| `argument-count` | error | more or fewer positional arguments than the function takes |
| `constructor-arity` | error | more or fewer arguments than a constructor takes |
| `type-arity` | error | more or fewer type arguments than a type takes |
| `not-a-function` | error | a call of a value that is not a function |
| `duplicate-binding` | error | a name bound twice in one pattern or parameter list |
| `duplicate-label` | error | a label given twice |
| `duplicate-field` | error | a field given or declared twice |
| `duplicate-type` | error | a type name declared twice, or a built-in one |
| `duplicate-constructor` | error | a constructor name declared twice |
| `duplicate-external` | error | an external declared twice, or one that redeclares a built-in |
| `duplicate-type-parameter` | error | a type parameter listed twice |
| `cyclic-type` | error | a type alias that refers to itself |
| `or-pattern-bindings` | error | alternatives of a pattern that bind different names |
| `later-parameter` | error | a default value that uses a labelled parameter declared after it |
| `ask-not-a-value` | error | `ask` used other than in a call |
| `ask-options` | error | options of `ask` that are not constructors of one variant type |
| `try-operand` | error | `?` on a value that is not an outcome, option or result |
| `try-return` | error | `?` in a function that returns another family |
| `non-exhaustive` | error | a `switch` that does not handle every case |
| `refutable-pattern` | error | a `let` or parameter pattern that does not match every value |
| `dropped-outcome` | error | an outcome used as a statement before the last, bound to `_`, or given to a generic function that drops it |
| `unused-outcome` | error | a `let` that binds an outcome to a name that is never used |
| `interface-only` | error | an external or an abstract type in a program |
| `interface-item` | error | anything but a type or an external in an interface file |
| `no-std` | error | `open Std` without the standard library |
| `std-error` | error | a standard library that does not type-check with this host |
| `too-deep` | error | a program that nests deeper than the stack can follow |
| `unreachable-case` | warning | a case that can never match |

## 10. Not in v0

- type annotations in programs;
- modules other than `Std`;
- row polymorphism and effect polymorphism;
- request races (`any`), which will come with durable `scope`;
- classes other than the five in §3.
