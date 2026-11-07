# The Norn syntax tree

The front-end turns a `.norn` file into the tree described here. The
evaluator and every other later phase work from this tree, either through the
TypeScript types or through its JSON form.

- **Types:** [`src/frontend/ast.ts`](../src/frontend/ast.ts). Every node kind
  is an interface with the same name as its `kind` string.
- **JSON:** [`src/frontend/json.ts`](../src/frontend/json.ts) writes and reads
  it. `norn parse --json file.norn` prints it.
- **Field order:** `NODE_FIELDS` in `ast.ts` lists each kind's fields in JSON
  order. The compiler checks that it lists every field.
- **Schema:** `NODE_SCHEMA` in `ast.ts` says what each field may hold, and
  `NODE_GROUPS` names the unions of node kinds. The compiler checks that the
  schema covers every field and that each group lists every kind of its
  union. See [Reading and writing JSON](#reading-and-writing-json).

## Parsing

[`src/frontend/index.ts`](../src/frontend/index.ts) exports the front-end:

```ts
import { parse, astToJson, formatDiagnostic } from "./src/frontend/index.ts";

const result = parse(source);
if (result.ok) console.log(astToJson(result.program));
else for (const d of result.diagnostics) console.error(formatDiagnostic(d, source, "main.norn"));
```

- **Result.** `parse(source)` returns `{ok: true, program}` or
  `{ok: false, diagnostics}`. It never returns a partial tree.
- **Diagnostics.** A diagnostic is `{message, span}`. `diagnosticLine` gives
  its one-line form,
  `expected '=>' after pattern, found 'run' at examples/decide.norn:4:14`.
  `formatDiagnostic` adds the source line, with a caret under the span.
- **Error recovery.**
  - Lexical errors, such as an unterminated string or an invalid time
    literal, are all reported, and then parsing stops.
  - Otherwise the parser reports one error per top-level item it cannot read.
    It carries on at the next line that starts in column 1.
- **Depth.** There is no fixed limit on nesting.
  - Chains are read in loops, and they can be as long as memory allows. This
    covers calls, field access, `->`, `?`, binary and prefix operators, and
    `else if`.
  - Nested constructs such as parentheses, blocks, lambdas and `switch`
    recurse. Their limit is the stack: on Node's default stack that is
    about 1,000 to 5,000 levels, depending on the construct.
  - Running out of stack is the diagnostic "the program nests deeper than
    this implementation's stack can follow". It points at the construct
    being read, and it is not a crash.
- **Deep trees.** A long chain makes a deep tree. `x->f->f…` with 10,000
  links is a `Pipe` whose `left` is a `Pipe`, 10,000 levels down.
  - The JSON reader and writer and the outline printer (`treeLines`) do not
    recurse, so any tree can be written, read and printed.
  - A walker over the tree should not assume that the tree is shallow.
- **CLI.**
  - `norn parse [--json] file.norn` prints the tree as an outline, or as JSON
    on one line. `-` reads standard input.
  - `norn check [--host file] [--json] paths…` parses and type-checks files,
    and the `.norn` files under directories, as [types](types.md) describes.
  - Both exit with 1 on an error and 2 on a usage error.

## Stability

The JSON document carries `"format": "norn-ast"` and a `"version"`, 1 or 2.
`NODE_FIELDS` and `NODE_SCHEMA` are part of the contract.

- **Version 2** added what host interface files need: the node kinds
  `External`, `FunctionType` and `LabelledType` (`VERSION_2_KINDS` in
  `ast.ts`), and a `TypeDecl` whose `definition` is null, for an abstract
  type.
- **The lowest version that can express a tree is the one written.** A tree
  with none of the version-2 additions is written as version 1, byte for byte
  as before. The runtime pins a program's code by a hash of those bytes, so
  ordinary programs keep their code identity. `astVersion(program)` gives the
  version a tree needs.
- **Reading.** `astFromJson` reads both versions. A version-1 document that
  holds a version-2 addition is refused at its path. A version-2 document may
  hold any tree.
- **Changes.** Any change to the shape of an existing node kind bumps the
  version. This includes renaming, removing or retyping a field, letting a
  field hold what it could not hold before, or changing how existing source
  maps onto nodes. So does a new node kind: a reader that predates it would
  refuse it anyway, and the version says why.

## The JSON document

`astToJson` writes the document on one line. The JSON text is canonical,
because the writer orders the keys itself: the same tree always gives the
same text, whatever order its objects were built in. Here is
`q->waitUntil(1h)?`, with no trailing newline, laid out for reading:

```json
{
  "format": "norn-ast",
  "version": 1,
  "program": {
    "kind": "Program",
    "body": [
      {
        "kind": "Try",
        "operand": {
          "kind": "Pipe",
          "left": {
            "kind": "Identifier",
            "name": "q",
            "span": {"start": {"line": 1, "column": 1, "offset": 0}, "end": {"line": 1, "column": 2, "offset": 1}}
          },
          "callee": {
            "kind": "Identifier",
            "name": "waitUntil",
            "span": {"start": {"line": 1, "column": 4, "offset": 3}, "end": {"line": 1, "column": 13, "offset": 12}}
          },
          "args": [
            {
              "kind": "DurationLiteral",
              "amount": "1",
              "unit": "h",
              "span": {"start": {"line": 1, "column": 14, "offset": 13}, "end": {"line": 1, "column": 16, "offset": 15}}
            }
          ],
          "span": {"start": {"line": 1, "column": 1, "offset": 0}, "end": {"line": 1, "column": 17, "offset": 16}}
        },
        "span": {"start": {"line": 1, "column": 1, "offset": 0}, "end": {"line": 1, "column": 18, "offset": 17}}
      }
    ],
    "span": {"start": {"line": 1, "column": 1, "offset": 0}, "end": {"line": 1, "column": 18, "offset": 17}}
  }
}
```

Conventions:

- **Node layout.** Every node is `kind`, then its fields in `NODE_FIELDS`
  order, then `span`.
- **Absent and empty values.** An absent optional child is `null`; it is never
  left out. A list is always present, possibly empty.
- **Strings** are decoded: escapes such as `\n` are already processed.
- **Integers** are canonical decimal strings with arbitrary precision. This
  covers `IntLiteral.value`, `DurationLiteral.amount` and
  `ParticipantLiteral.instance`. Norn's `int` has arbitrary precision too
  (spec §4), so there is no range to check.
- **Floats** are JSON numbers, always finite.
- **Positions** are `{line, column, offset}`:
  - `line` is 1-based.
  - `column` is 1-based and counts Unicode code points; a tab is one column.
  - `offset` is a 0-based index in UTF-16 code units, so
    `source.slice(span.start.offset, span.end.offset)` is a node's text in
    JavaScript.

  A span's `end` is exclusive: it is the position just after the node's last
  character.
- **Not in the tree:** parentheses leave no node, and a parenthesized
  expression keeps the span of what is inside them. Comments are not in the
  tree either.
- **No shared objects.** No object appears twice in a tree. Every node, list,
  span and position is a fresh object, even for punned names such as
  `{count}` or `~by`, as in a tree read back from JSON. A walk that skips
  objects it has seen, such as one that numbers nodes, therefore gives the
  same result for a fresh parse and for a JSON round trip.

## Reading and writing JSON

`astFromJson(text)` reads a document, and `validateProgram(value)` checks a
tree that is already in memory.

**What is checked.** Both check every node against `NODE_SCHEMA`, and so does
`astToJson` before it writes. Reading a version-1 document also refuses what
version 2 added:

- **Nodes.** Each node has a known `kind`, and exactly the fields of
  `NODE_FIELDS` plus `span`, no more and no less.
- **Spans.** A span is exactly `{start, end}` and does not end before it
  starts.
- **Positions.** A position is exactly `{line, column, offset}`, made of
  integers. `line` and `column` are at least 1, and `offset` at least 0.
- **Field values.** Each field holds what its schema says:
  - `"string"` or `"boolean"`;
  - `"number"`, which is finite, or `"integer"`, a safe integer;
  - `"decimal"`, a canonical decimal string such as `"42"` or `"-1"`, or
    `"digits"`, one without a sign;
  - `oneOf`, one of listed strings such as the operators, duration units,
    reference kinds and `"Std"`;
  - `node`, a node of a group such as `expression`, `pattern` or `argument`,
    or of listed kinds;
  - `list`, with a minimum length where the tree needs one. A tuple has at
    least two elements, and a `switch` at least one case;
  - `nullable`, for a slot that may hold `null`.

  An expression slot therefore refuses a pattern node, and so on.
- **Shape rules.**
  - A template has one more string than expressions.
  - An `OrPattern` is not directly inside another.
- **Identity.** No node or list appears twice in the tree, which also rules
  out cycles. Spans may be shared in a tree built by hand; only nodes and
  lists have an identity that matters.
- **The document around the tree** is exactly `format`, `version` and
  `program`, and `version` is 1 or 2.

**Errors.** A problem is an `AstJsonError`. It names the JSON path of the first
problem in document order:

```
program.body[2].value.args[0]: unknown field "foo"
program.body[2].pattern: expected a pattern, found an Identifier node
program.body[3].cases: expected at least 1 item, found 0
program.body[0]: an External node needs norn-ast version 2, but this document is version 1
```

The checks do not recurse, so a document of any depth is read or refused
cleanly.

## Nodes

`TopLevelItem`, `Statement`, `Expression`, `Argument`, `Parameter`,
`Pattern`, `TypeExpression` and `ParameterType` are unions of node kinds;
`AstNode` is every kind.

### Program and top level

| Kind | Fields | Source |
|---|---|---|
| `Program` | `body: TopLevelItem[]` | a whole file |
| `TypeDecl` | `name: string`, `params: TypeVar[]`, `definition: VariantType \| RecordType \| TypeExpression \| null` | `type probe = Ship \| Drop`, `type pr` |
| `External` | `name: string`, `type: TypeExpression` | `external merged: (string) => event<pr>` |
| `Open` | `module: "Std"` | `open Std` |

`TopLevelItem` is `TypeDecl | External | Open | Statement`. A program's items
run in order. Type declarations, externals and `open` appear only at the top
level.

- **Abstract types.** A `TypeDecl` without `=` has a null `definition`: its
  values are made only by the host, as with `type pr`.
- **Externals** declare a value that the host supplies, with its type.
- Only a host interface file may declare an abstract type or an external. The
  parser accepts them anywhere at the top level; the type checker refuses them
  in a program (docs/types.md §7). Both need version 2 of the JSON form.

### Statements

`Statement` is `Let | LetRec | Expression`. Statements make up a program or a
`Block`.

| Kind | Fields | Source |
|---|---|---|
| `Let` | `pattern: Pattern`, `value: Expression` | `let pr = merged("acme/api#1436")->wait` |
| `LetRec` | `bindings: RecBinding[]` | `let rec push = () => … and pull = () => …` |
| `RecBinding` | `name: string`, `value: Lambda` | `push = () => …` |

A `let rec` binds functions only, so every `RecBinding.value` is a `Lambda`.
All of its bindings are in scope in all of its values.

### Expressions

| Kind | Fields | Source |
|---|---|---|
| `IntLiteral` | `value: string` | `42` |
| `FloatLiteral` | `value: number` | `1.5`, `2e-3` |
| `StringLiteral` | `value: string` | `"Ship the billing probe?"` |
| `TemplateLiteral` | `strings: string[]`, `expressions: Expression[]` | `` `Verify ${release.version} now` `` |
| `BoolLiteral` | `value: boolean` | `true` |
| `UnitLiteral` | — | `()` |
| `TimeLiteral` | `value: string`, `epochMs: number`, `offsetMinutes: number` | `2026-11-07T12:00Z` |
| `DurationLiteral` | `amount: string`, `unit: "m" \| "h" \| "d" \| "w"` | `30m`, `1d` |
| `ParticipantLiteral` | `name: string`, `instance: string \| null`, `args: LabelledArg[]` | `@alice`, `@codex:2`, `@auto(~repo="acme/api")` |
| `RefLiteral` | `refKind: "doc" \| "channel"`, `value: string` | `doc"spec#syntax"` |
| `Identifier` | `name: string` | `pr` |
| `Constructor` | `name: string`, `args: Expression[]` | `Ship`, `Answered(x)` |
| `TupleLiteral` | `elements: Expression[]` | `(a, b)` |
| `ListLiteral` | `elements: Expression[]`, `rest: Expression \| null` | `[Ship, Drop]`, `[x, ...rest]` |
| `RecordLiteral` | `spread: Expression \| null`, `fields: RecordField[]` | `{name: "x", count}`, `{...base, count: 2}` |
| `RecordField` | `name: string`, `value: Expression` | `count: 2` |
| `FieldAccess` | `record: Expression`, `field: string` | `release.version` |
| `Call` | `callee: Expression`, `args: Argument[]` | `ask(@alice, "Ship?", ~by=1h)` |
| `LabelledArg` | `label: string`, `value: Expression` | `~by=1h` |
| `Pipe` | `left: Expression`, `callee: Expression`, `args: Argument[]` | `q->handOver(@alice)` |
| `Try` | `operand: Expression` | `run(@claude, task)?` |
| `Unary` | `op: "!" \| "-" \| "-."`, `operand: Expression` | `!done` |
| `Binary` | `op`, `left: Expression`, `right: Expression` | `a ++ b` |
| `Lambda` | `params: Parameter[]`, `body: Expression` | `(who, ~at) => …`, `_ => …` |
| `LabelledParam` | `label: string`, `pattern: Pattern`, `defaultValue: Expression \| null` | `~every as period`, `~on=[]` |
| `Block` | `body: Statement[]` | `{ let x = f(); g(x) }` |
| `If` | `condition: Expression`, `thenBranch: Block`, `elseBranch: Block \| If \| null` | `if ok { a } else { b }` |
| `Switch` | `scrutinee: Expression`, `cases: Case[]` | `switch o { … }` |
| `Case` | `pattern: Pattern`, `guard: Expression \| null`, `body: Expression` | `\| Answered(x) if x > 0 => …` |

Details:

- **Literals.**
  - `TimeLiteral.value` is the literal as written. `epochMs` is the instant
    in milliseconds since 1970-01-01T00:00Z. `offsetMinutes` is the written
    offset: `Z` is 0, `+08:00` is 480.
  - In `TemplateLiteral`, the text pieces and the interpolations alternate,
    and `strings.length === expressions.length + 1`. So
    `` `Verify ${v} now` `` has `strings` `["Verify ", " now"]`.
  - `ParticipantLiteral.args` are labelled, and their meaning is
    host-defined. `instance` is the decimal string after `:`.
- **Constructors.** `Constructor` builds a variant value, and `args` is empty
  for a constructor without a payload.
- **Arguments.** `Argument` is `Expression | LabelledArg`, in source order,
  which is evaluation order. A punned `~by` is a `LabelledArg` whose value
  is an `Identifier` named `by`. The same holds for a punned record field
  `{count}`.
- **Pipe.** `left->callee(args)` means `callee(left, args)`: `left` becomes
  the first positional argument. `x->f` and `x->f()` both have empty `args`.
  `callee` is an `Identifier` or a parenthesized expression. The pipe is kept
  as a node, not desugared into a `Call`.
- **Unary.** A minus before a number in an expression stays an operator:
  `-1` is a `Unary` around `IntLiteral` `"1"`. Only literal patterns fold the
  sign into the number.
- **Try** is postfix `?`. On anything but `Answered`, `Some` or `Ok`, the
  enclosing function returns the operand's value at once; at the top of a
  program it ends the program (§5).
- **Binary operators**, all left-associative, from lowest precedence:
  - `||`
  - `&&`
  - `==` `!=` `<` `<=` `>` `>=`
  - `+` `-` `++` `+.` `-.`
  - `*` `/` `*.` `/.`

  `++` joins strings. The dotted operators are for floats, as in ReScript.
- **Lambda.** `Parameter` is `Pattern | LabelledParam`. A positional
  parameter is a pattern, usually a `VarPattern` or `WildcardPattern`.
  `params` is empty for `() => …`.
  - `LabelledParam.pattern` is what the argument binds. For `~at` it is a
    `VarPattern` named `at`; for `~every as period` it is one named `period`.
  - A labelled parameter without `defaultValue` is required.
- **Blocks.** A `Block`'s value is that of its last statement when that is an
  expression; otherwise, or when the block is empty, it is `()`.
- **If.** An `else if` chain nests: `elseBranch` is another `If`. Without
  `else`, the value is `()` when the condition is false.
- **Switch.** Cases are tried in order.
  - A case body with more than one statement is a `Block` that runs from the
    first statement to the last, even though no braces were written.
  - A `guard` is written `| pattern if condition =>`.

### Patterns

| Kind | Fields | Source |
|---|---|---|
| `WildcardPattern` | — | `_` |
| `VarPattern` | `name: string` | `other` |
| `LiteralPattern` | `literal: IntLiteral \| FloatLiteral \| StringLiteral \| BoolLiteral \| UnitLiteral` | `"yes"`, `-1`, `true`, `()` |
| `ConstructorPattern` | `name: string`, `args: Pattern[]` | `NoReply`, `Answered(Ship)` |
| `TuplePattern` | `elements: Pattern[]` | `(a, b)` |
| `ListPattern` | `elements: Pattern[]`, `rest: Pattern \| null` | `[]`, `[first, ...rest]` |
| `RecordPattern` | `fields: FieldPattern[]` | `{version, state: Answered(_)}` |
| `FieldPattern` | `name: string`, `pattern: Pattern` | `state: Answered(_)` |
| `OrPattern` | `alternatives: Pattern[]` | `Answered(Yes) \| NoReply` |

- A `ListPattern` without `rest` matches a list of exactly that length.
- A `RecordPattern` checks only the fields it names. A punned field `{version}`
  binds a `VarPattern` named `version`.
- In a negative literal pattern such as `| -1 =>`, the sign is part of the
  literal: `IntLiteral.value` is `"-1"`.
- An `OrPattern` is flat: an alternative is never itself an `OrPattern`.

### Types

Types appear only in `type` and `external` declarations: v0 programs carry no
annotations (§4).

| Kind | Fields | Source |
|---|---|---|
| `TypeName` | `name: string`, `args: TypeExpression[]` | `string`, `list<'a>` |
| `TypeVar` | `name: string` | `'a` (the name is `a`) |
| `TupleType` | `elements: TypeExpression[]` | `(int, string)` |
| `FunctionType` | `params: ParameterType[]`, `result: TypeExpression` | `(string, ~containing: pr) => event<release>` |
| `LabelledType` | `label: string`, `type: TypeExpression`, `optional: boolean` | `~containing: pr`, `~by: duration=?` |
| `VariantType` | `constructors: ConstructorDecl[]` | `Ship \| Drop \| Later(duration)` |
| `ConstructorDecl` | `name: string`, `args: TypeExpression[]` | `Later(duration)` |
| `RecordType` | `fields: FieldDecl[]` | `{version: string}` |
| `FieldDecl` | `name: string`, `type: TypeExpression` | `version: string` |

`TypeExpression` is `TypeName | TypeVar | TupleType | FunctionType`. A
`TypeDecl`'s definition is a `VariantType`, a `RecordType`, a
`TypeExpression` for an alias such as `type id = string`, or null for an
abstract type.

- **Function types** are uncurried. `ParameterType` is
  `TypeExpression | LabelledType`; positional and labelled parameters keep
  source order, and `params` is empty for `() => time`.
  - `LabelledType.optional` is true for `~label: type=?`, a parameter that a
    caller may leave out.
  - `FunctionType` and `LabelledType` need version 2 of the JSON form.

## Syntax notes

These rules settle what §5 leaves open. They follow ReScript unless they say
otherwise.

- **Postfix chain.** Calls `f(…)`, field access `.f`, pipes `->f(…)` and `?`
  form one chain, read left to right. It binds tighter than the prefix
  operators `!`, `-` and `-.`, which bind tighter than every binary operator.
  Some readings that follow:

  | Source | Reads as |
  |---|---|
  | `!judge(c)?` | `!(judge(c)?)` |
  | `x->wait?` | `(x->wait)?` |
  | `-x->abs` | `-(x->abs)` |
  | `a + b->f` | `a + (b->f)` |
  | `a->f.b` | `(a->f).b` |

  The last reading differs from ReScript, which reads `a->(f.b)`. Norn has no
  modules to make `->Module.fn` useful.
- **Lambdas** have the lowest precedence; a lambda's body extends as far right
  as it can. A lambda starts with `x =>`, `_ =>` or `(…) =>`.
- **Conditions.** The condition of an `if` and the value of a `switch` are
  ordinary expressions, and the `{` that follows ends them.
- **Lines.** Statements are separated by a line break or `;`. An expression
  continues onto the next line when that line starts with a binary operator,
  `->`, `.` or `?`.
  - An argument list must open on the line where the function ends. A `(` at
    the start of a line begins a new expression. The same holds for a
    constructor's payload and a participant's arguments.
  - A `-` or `-.` that starts a line and is directly followed by its operand,
    as in `-x`, starts a new statement. With a space after it, as in `- x`, it
    continues the line above as subtraction.
- **Records and blocks.** `{` starts a record when it is followed by `...`,
  `name:` or `name,`; otherwise it starts a block. So `{x}` is a block whose
  value is `x`, and `{}` is an empty block whose value is `()`.
- **Lists.** A spread is allowed only in the last position, as in
  `[x, ...rest]`.
- **`let`.**
  - `let rec` binds functions, and `and` joins mutually recursive ones.
  - A plain `let` has a single binding.
  - `let x: int = …` is an error, because v0 has no annotations.
- **Constructors.** A constructor without a payload has no parentheses:
  `Foo()` is an error.
- **Literal patterns** are strings, numbers (optionally negative), booleans and
  `()`. To test a participant or a time, use `==` in a guard.
- **Function types**, as in ReScript:
  - `(T, ~label: U, ~other: V=?) => R` lists the parameters in parentheses.
    A labelled parameter type is allowed only there.
  - `() => R` takes no arguments, and `T => R` takes one: `string => unit` is
    `(string) => unit`.
  - `(int, string) => R` takes two arguments; `((int, string)) => R` takes
    one tuple.
  - `=>` groups to the right: `int => int => int` is `int => (int => int)`.
- **Abstract types and externals.** `type pr`, with nothing after the name on
  its line, is abstract. `external name: type` declares a value the host
  supplies.
- **Lexical rules.**
  - Value, field, label and type names are `[a-z_][A-Za-z0-9_]*`.
    Constructors and `Std` are `[A-Z][A-Za-z0-9_]*`.
  - The keywords are `let`, `rec`, `and`, `if`, `else`, `switch`, `type`,
    `open`, `true`, `false` and `as`.
  - `external` is a keyword only at the start of a top-level item, followed by
    a name on the same line. Elsewhere it is an ordinary name, so programs
    that used it as one keep their meaning.
  - Comments are `//` to the end of the line, and `/* … */`, which does not
    nest.
  - String escapes are `\n`, `\r`, `\t`, `\\`, `\"`, `\'`, `` \` ``, `\$`,
    `\uXXXX` and `\u{X…}`. A string literal cannot span lines; a template
    can.

## Spec clarifications

Where the spec's examples use syntax that §5 does not cover or that could be
read two ways, the parser takes the reading below. The spec text itself is
unchanged.

1. **Case bodies are blocks.** §3's release chain writes two statements after
   `| Some(release) =>` without braces. As in ReScript, a case body runs to
   the next `|` that starts a case, or to the closing `}`.
2. **`?` binds tighter than `!` and covers the whole chain on its left.**
   §3 writes `if !judge(…)? {`, which needs `!(judge(…)?)`. It also writes
   `merged(…)->wait?` and §8 writes `at->sleepUntil?`, which need
   `(… ->wait)?`. Hence the postfix chain in the syntax notes.
3. **No conditional operator.** §5 makes `?` postfix "as in Rust", so
   ReScript's `c ? a : b` is not part of Norn; use `if`/`else`.
4. **`->` continues across lines.** §3's standing duty starts its lines with
   `->`. A line that starts with `->`, `.`, `?` or a binary operator continues
   the expression above it.
5. **Labelled-parameter aliases and punning.** §8 writes `~every as period`
   and passes `~by` without a value. These are ReScript's forms, and they are
   accepted:
   - `~every as period` binds the argument labelled `every` to `period`;
   - `~by` alone means `~by=by`.
6. **`~x=?` is signature notation.** §6.1 writes optional arguments as
   `~by=?`. That describes built-in signatures. In source it appears only
   in function types, as in `external run: (participant, string, ~by:
   duration=?) => request<report>`. A user function's optional labelled
   parameter has a default, as in `~on=[]`, and a call never writes `~x=?`.
7. **`[a, b]` is a list.** §4 names `list<'a>` and §6.1 writes
   `choose(who, question, [A, B])`, so the square-bracket literal builds an immutable
   list. ReScript's arrays and `list{…}` are not part of Norn.
8. **Time literals.** §4 says a time is "always with its offset". The
   accepted form is `YYYY-MM-DDTHH:MM`, then optionally `:SS`, then `Z` or
   `±HH:MM`.
   - Fractional seconds, lowercase `t`/`z` and offsets without a colon
     (`+0800`) are not accepted.
   - A date alone, or a date-time without an offset, is an error rather than
     arithmetic. Otherwise `2026-11-07` would read as `2026 - 11 - 7`.

   This answers the time-literal item of §13.5 for the parser only.
9. **Durations.** A duration is a whole number directly followed by `m`, `h`,
   `d` or `w`, as in §4. Forms such as `1.5h`, `30s` and `1h30m` are errors;
   write `90m` instead.
10. **Participants.** A participant is `@` and a name. The name may contain
    letters, digits, `_` and inner `-`, as in `@win-builder`.
    - It may be followed by `:N` for one instance, with no spaces, as in
      `@codex:2`.
    - Arguments in parentheses must be labelled, as in
      `@auto(~repo="acme/api")`. They are accepted on any participant, and
      the host defines what they mean.
11. **References.** A reference is `doc"…"` or `channel"…"`, with no space
    before the quote.
    - The text uses string escapes and has no interpolation.
    - Any other prefix before a quote is an error.
12. **`if` without `else`.** §3's push loop uses `if … { … }` with no `else`.
    Its value is `()` when the condition is false.

## Notes for later phases

Reading the spec while writing the parser raised two questions. Both are
settled:

- **The push loop's `?` and its result type.** §3's push loop now ends with
  `Answered(report)`, so both of its paths return a reply, as the typing of `?`
  needs ([types](types.md) §4).
- **Functions that §6 did not define.** `sleepUntil`, `mergeAll` and `name`
  are gone from the spec, `show` is a built-in (§6.1), and `machineUpdated` is
  a fact that the host declares in its interface file
  ([`hosts/reference.norn`](../hosts/reference.norn)).
