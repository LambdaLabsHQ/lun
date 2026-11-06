import assert from "node:assert/strict";
import { test } from "node:test";
import { STACK_EXHAUSTED, treeLines } from "../../src/frontend/index.ts";
import {
  assertNoSharedObjects, binary, call, ctor, ctorPattern, id, int, item, labelled, parseErrors, parseOk, participant, pipe,
  preorderKinds, str, strip, variable,
} from "./helpers.ts";
import { astFromJson, astToJson } from "../../src/frontend/index.ts";

test("literals", () => {
  assert.deepEqual(item("42"), int("42"));
  assert.deepEqual(item("1.5"), { kind: "FloatLiteral", value: 1.5 });
  assert.deepEqual(item(`"hi"`), str("hi"));
  assert.deepEqual(item("true"), { kind: "BoolLiteral", value: true });
  assert.deepEqual(item("()"), { kind: "UnitLiteral" });
  assert.deepEqual(item("2026-11-07T12:00+08:00"), {
    kind: "TimeLiteral", value: "2026-11-07T12:00+08:00", epochMs: Date.UTC(2026, 10, 7, 4), offsetMinutes: 480,
  });
  assert.deepEqual(item("90m"), { kind: "DurationLiteral", amount: "90", unit: "m" });
  assert.deepEqual(item("@codex:2"), participant("codex", "2"));
  assert.deepEqual(item(`@auto(~repo="acme/api", ~size)`), participant("auto", null, [labelled("repo", str("acme/api")), labelled("size", id("size"))]));
  assert.deepEqual(item(`doc"spec#syntax"`), { kind: "RefLiteral", refKind: "doc", value: "spec#syntax" });
});

test("templates alternate text and interpolations", () => {
  assert.deepEqual(item("`plain`"), { kind: "TemplateLiteral", strings: ["plain"], expressions: [] });
  assert.deepEqual(item("`Verify ${release.version} on ${host->name}`"), {
    kind: "TemplateLiteral",
    strings: ["Verify ", " on ", ""],
    expressions: [{ kind: "FieldAccess", record: id("release"), field: "version" }, pipe(id("host"), id("name"))],
  });
  assert.deepEqual(item("`a${`b${c}`}`"), {
    kind: "TemplateLiteral",
    strings: ["a", ""],
    expressions: [{ kind: "TemplateLiteral", strings: ["b", ""], expressions: [id("c")] }],
  });
});

test("the postfix chain binds tighter than prefix operators", () => {
  const judge = call(id("judge"), id("c"));
  assert.deepEqual(item("!judge(c)?"), { kind: "Unary", op: "!", operand: { kind: "Try", operand: judge } });
  assert.deepEqual(item("x->wait?"), { kind: "Try", operand: pipe(id("x"), id("wait")) });
  assert.deepEqual(item("-x->abs"), { kind: "Unary", op: "-", operand: pipe(id("x"), id("abs")) });
  assert.deepEqual(item("a + b->f"), binary("+", id("a"), pipe(id("b"), id("f"))));
  assert.deepEqual(item("a->f.b"), { kind: "FieldAccess", record: pipe(id("a"), id("f")), field: "b" });
  assert.deepEqual(item("f(a)(b)?.c"), {
    kind: "FieldAccess", record: { kind: "Try", operand: call(call(id("f"), id("a")), id("b")) }, field: "c",
  });
});

test("binary operators: precedence and left associativity", () => {
  assert.deepEqual(item("a + b * c"), binary("+", id("a"), binary("*", id("b"), id("c"))));
  assert.deepEqual(item("a * b + c"), binary("+", binary("*", id("a"), id("b")), id("c")));
  assert.deepEqual(item("a - b - c"), binary("-", binary("-", id("a"), id("b")), id("c")));
  assert.deepEqual(item("a || b && c == d"), binary("||", id("a"), binary("&&", id("b"), binary("==", id("c"), id("d")))));
  assert.deepEqual(item(`a ++ b ++ "c"`), binary("++", binary("++", id("a"), id("b")), str("c")));
  assert.deepEqual(item("x *. 2.0 +. y"), binary("+.", binary("*.", id("x"), { kind: "FloatLiteral", value: 2 }), id("y")));
  assert.deepEqual(item("(a + b) * c"), binary("*", binary("+", id("a"), id("b")), id("c")));
  assert.deepEqual(item("-.x"), { kind: "Unary", op: "-.", operand: id("x") });
});

test("pipes keep the piped value apart from the arguments", () => {
  assert.deepEqual(item("x->f"), pipe(id("x"), id("f")));
  assert.deepEqual(item("x->f()"), pipe(id("x"), id("f")));
  assert.deepEqual(item("q->wait(~until=1h)"), pipe(id("q"), id("wait"), labelled("until", { kind: "DurationLiteral", amount: "1", unit: "h" })));
  assert.deepEqual(item("x->(f(a))(b)"), pipe(id("x"), call(id("f"), id("a")), id("b")));
  assert.deepEqual(item("every(1d)\n->merge(a)\n->forEach(_ => b)"), pipe(
    pipe(call(id("every"), { kind: "DurationLiteral", amount: "1", unit: "d" }), id("merge"), id("a")),
    id("forEach"),
    { kind: "Lambda", params: [{ kind: "WildcardPattern" }], body: id("b") },
  ));
});

test("line breaks: what continues an expression and what starts a statement", () => {
  const items = (source: string) => parseOk(source).body.map(strip);
  // `(` on a new line does not call; `->`, `.`, `?` and binary operators continue.
  assert.deepEqual(items("f\n(x)"), [id("f"), id("x")]);
  assert.deepEqual(items("a\n.b\n?"), [{ kind: "Try", operand: { kind: "FieldAccess", record: id("a"), field: "b" } }]);
  assert.deepEqual(items("a\n&& b"), [binary("&&", id("a"), id("b"))]);
  // `-x` at the start of a line is a new statement; `- x` is subtraction.
  assert.deepEqual(items("a\n-b"), [id("a"), { kind: "Unary", op: "-", operand: id("b") }]);
  assert.deepEqual(items("a\n- b"), [binary("-", id("a"), id("b"))]);
  // `;` separates statements on one line.
  assert.deepEqual(items("a; b;; c;"), [id("a"), id("b"), id("c")]);
  // A constructor's payload must start on its line too.
  assert.deepEqual(items("Ship\n(1, 2)"), [ctor("Ship"), { kind: "TupleLiteral", elements: [int("1"), int("2")] }]);
});

test("functions: positional and labelled parameters", () => {
  assert.deepEqual(item("x => x"), { kind: "Lambda", params: [variable("x")], body: id("x") });
  assert.deepEqual(item("() => ()"), { kind: "Lambda", params: [], body: { kind: "UnitLiteral" } });
  assert.deepEqual(item("(a, ~b, ~c=1, ~d as e, ~f as (g, h)=p, _) => a"), {
    kind: "Lambda",
    params: [
      variable("a"),
      { kind: "LabelledParam", label: "b", pattern: variable("b"), defaultValue: null },
      { kind: "LabelledParam", label: "c", pattern: variable("c"), defaultValue: int("1") },
      { kind: "LabelledParam", label: "d", pattern: variable("e"), defaultValue: null },
      { kind: "LabelledParam", label: "f", pattern: { kind: "TuplePattern", elements: [variable("g"), variable("h")] }, defaultValue: id("p") },
      { kind: "WildcardPattern" },
    ],
    body: id("a"),
  });
  // A lambda body extends as far as it can.
  assert.deepEqual(item("x => y => x + y"), {
    kind: "Lambda", params: [variable("x")], body: { kind: "Lambda", params: [variable("y")], body: binary("+", id("x"), id("y")) },
  });
});

test("calls with labelled and punned arguments, in source order", () => {
  assert.deepEqual(item(`ask(who, ~options, "q", ~until=t)`), call(id("ask"), id("who"), labelled("options", id("options")), str("q"), labelled("until", id("t"))));
  assert.deepEqual(item("f(a, b,)"), call(id("f"), id("a"), id("b")));
});

test("braces: records, blocks and the cases between", () => {
  const field = (name: string, value: unknown) => ({ kind: "RecordField", name, value });
  assert.deepEqual(item("{a: 1, b}"), { kind: "RecordLiteral", spread: null, fields: [field("a", int("1")), field("b", id("b"))] });
  assert.deepEqual(item("{a,}"), { kind: "RecordLiteral", spread: null, fields: [field("a", id("a"))] });
  assert.deepEqual(item("{...base, a: 2}"), { kind: "RecordLiteral", spread: id("base"), fields: [field("a", int("2"))] });
  assert.deepEqual(item("{...base}"), { kind: "RecordLiteral", spread: id("base"), fields: [] });
  assert.deepEqual(item("{a}"), { kind: "Block", body: [id("a")] });
  assert.deepEqual(item("{}"), { kind: "Block", body: [] });
  assert.deepEqual(item("{ let x = 1\n  x }"), { kind: "Block", body: [{ kind: "Let", pattern: variable("x"), value: int("1") }, id("x")] });
});

test("lists, tuples and constructors", () => {
  assert.deepEqual(item("[]"), { kind: "ListLiteral", elements: [], rest: null });
  assert.deepEqual(item("[Ship, Skip,]"), { kind: "ListLiteral", elements: [ctor("Ship"), ctor("Skip")], rest: null });
  assert.deepEqual(item("[x, ...rest]"), { kind: "ListLiteral", elements: [id("x")], rest: id("rest") });
  assert.deepEqual(item("(a, b, c)"), { kind: "TupleLiteral", elements: [id("a"), id("b"), id("c")] });
  assert.deepEqual(item("((a))"), id("a"));
  assert.deepEqual(item("Done(Pair(a, b))"), ctor("Done", ctor("Pair", id("a"), id("b"))));
});

test("if, else if, else, and if without else", () => {
  const block = (...body: unknown[]) => ({ kind: "Block", body });
  assert.deepEqual(item("if a { 1 } else if b { 2 } else { 3 }"), {
    kind: "If",
    condition: id("a"),
    thenBranch: block(int("1")),
    elseBranch: { kind: "If", condition: id("b"), thenBranch: block(int("2")), elseBranch: block(int("3")) },
  });
  assert.deepEqual(item("if !done(x)? {\n  retry()\n}"), {
    kind: "If",
    condition: { kind: "Unary", op: "!", operand: { kind: "Try", operand: call(id("done"), id("x")) } },
    thenBranch: block(call(id("retry"))),
    elseBranch: null,
  });
  assert.deepEqual(item("if a { 1 }\nelse { 2 }"), { kind: "If", condition: id("a"), thenBranch: block(int("1")), elseBranch: block(int("2")) });
});

test("switch: guards, flat or-patterns and blocks without braces", () => {
  const source = `switch o {
| Done(Ship) | (TimedOut | Cancelled) => a
| Done(n) if n > 1 => b
| Failed(_) =>
  let x = c
  x
| _ => let y = d
}`;
  assert.deepEqual(item(source), {
    kind: "Switch",
    scrutinee: id("o"),
    cases: [
      {
        kind: "Case",
        pattern: { kind: "OrPattern", alternatives: [ctorPattern("Done", ctorPattern("Ship")), ctorPattern("TimedOut"), ctorPattern("Cancelled")] },
        guard: null,
        body: id("a"),
      },
      { kind: "Case", pattern: ctorPattern("Done", variable("n")), guard: binary(">", id("n"), int("1")), body: id("b") },
      {
        kind: "Case",
        pattern: ctorPattern("Failed", { kind: "WildcardPattern" }),
        guard: null,
        body: { kind: "Block", body: [{ kind: "Let", pattern: variable("x"), value: id("c") }, id("x")] },
      },
      { kind: "Case", pattern: { kind: "WildcardPattern" }, guard: null, body: { kind: "Block", body: [{ kind: "Let", pattern: variable("y"), value: id("d") }] } },
    ],
  });
});

test("patterns", () => {
  const caseOf = (pattern: string) => (item(`switch x { | ${pattern} => () }`) as { cases: { pattern: unknown }[] }).cases[0]!.pattern;
  const literal = (literal: unknown) => ({ kind: "LiteralPattern", literal });
  assert.deepEqual(caseOf(`"yes"`), literal(str("yes")));
  assert.deepEqual(caseOf("-1"), literal(int("-1")));
  assert.deepEqual(caseOf("-0"), literal(int("0")));
  assert.deepEqual(caseOf("-2.5"), literal({ kind: "FloatLiteral", value: -2.5 }));
  assert.deepEqual(caseOf("false"), literal({ kind: "BoolLiteral", value: false }));
  assert.deepEqual(caseOf("()"), literal({ kind: "UnitLiteral" }));
  assert.deepEqual(caseOf("(a, _)"), { kind: "TuplePattern", elements: [variable("a"), { kind: "WildcardPattern" }] });
  assert.deepEqual(caseOf("[]"), { kind: "ListPattern", elements: [], rest: null });
  assert.deepEqual(caseOf("[first, ...rest]"), { kind: "ListPattern", elements: [variable("first")], rest: variable("rest") });
  assert.deepEqual(caseOf("{version, state: Done(_)}"), {
    kind: "RecordPattern",
    fields: [
      { kind: "FieldPattern", name: "version", pattern: variable("version") },
      { kind: "FieldPattern", name: "state", pattern: ctorPattern("Done", { kind: "WildcardPattern" }) },
    ],
  });
});

test("let, let rec with and, and destructuring", () => {
  assert.deepEqual(item("let (a, b) = pair"), { kind: "Let", pattern: { kind: "TuplePattern", elements: [variable("a"), variable("b")] }, value: id("pair") });
  const lambda = (body: unknown) => ({ kind: "Lambda", params: [], body });
  assert.deepEqual(item("let rec ping = () => pong()\nand pong = () => ping()"), {
    kind: "LetRec",
    bindings: [
      { kind: "RecBinding", name: "ping", value: lambda(call(id("pong"))) },
      { kind: "RecBinding", name: "pong", value: lambda(call(id("ping"))) },
    ],
  });
});

test("type declarations: variants, records, aliases and parameters", () => {
  const name = (n: string, ...args: unknown[]) => ({ kind: "TypeName", name: n, args });
  assert.deepEqual(item("type choice = Ship | Skip | Later(duration)"), {
    kind: "TypeDecl",
    name: "choice",
    params: [],
    definition: {
      kind: "VariantType",
      constructors: [
        { kind: "ConstructorDecl", name: "Ship", args: [] },
        { kind: "ConstructorDecl", name: "Skip", args: [] },
        { kind: "ConstructorDecl", name: "Later", args: [name("duration")] },
      ],
    },
  });
  assert.deepEqual(item("type pair<'a, 'b> =\n  | Pair('a, 'b)"), {
    kind: "TypeDecl",
    name: "pair",
    params: [{ kind: "TypeVar", name: "a" }, { kind: "TypeVar", name: "b" }],
    definition: { kind: "VariantType", constructors: [{ kind: "ConstructorDecl", name: "Pair", args: [{ kind: "TypeVar", name: "a" }, { kind: "TypeVar", name: "b" }] }] },
  });
  assert.deepEqual(item("type release = {version: string, notes: list<list<string>>}"), {
    kind: "TypeDecl",
    name: "release",
    params: [],
    definition: {
      kind: "RecordType",
      fields: [
        { kind: "FieldDecl", name: "version", type: name("string") },
        { kind: "FieldDecl", name: "notes", type: name("list", name("list", name("string"))) },
      ],
    },
  });
  assert.deepEqual(item("type entry = (string, result<int, string>)"), {
    kind: "TypeDecl",
    name: "entry",
    params: [],
    definition: { kind: "TupleType", elements: [name("string"), name("result", name("int"), name("string"))] },
  });
});

test("interface declarations: abstract types, externals and function types", () => {
  const name = (n: string, ...args: unknown[]) => ({ kind: "TypeName", name: n, args });
  const fn = (params: unknown[], result: unknown) => ({ kind: "FunctionType", params, result });
  const labelledType = (label: string, type: unknown, optional = false) => ({ kind: "LabelledType", label, type, optional });
  assert.deepEqual(item("type pr"), { kind: "TypeDecl", name: "pr", params: [], definition: null });
  assert.deepEqual(item("type box<'a>"), { kind: "TypeDecl", name: "box", params: [{ kind: "TypeVar", name: "a" }], definition: null });
  assert.deepEqual(parseOk("type a; type b\ntype c").body.map(strip), ["a", "b", "c"].map((n) => ({ kind: "TypeDecl", name: n, params: [], definition: null })));
  assert.deepEqual(item("external released: (channel, ~containing: pr) => event<release>"), {
    kind: "External",
    name: "released",
    type: fn([name("channel"), labelledType("containing", name("pr"))], name("event", name("release"))),
  });
  assert.deepEqual(item("external ask: (participant, string, ~until: 'd=?) => outcome<string>"), {
    kind: "External",
    name: "ask",
    type: fn([name("participant"), name("string"), labelledType("until", { kind: "TypeVar", name: "d" }, true)], name("outcome", name("string"))),
  });
  // `() =>` takes nothing, a bare type takes one argument, and `=>` groups to the right.
  assert.deepEqual(item("external now: () => time"), { kind: "External", name: "now", type: fn([], name("time")) });
  assert.deepEqual(item("external k: int => int => int"), { kind: "External", name: "k", type: fn([name("int")], fn([name("int")], name("int"))) });
  assert.deepEqual(item("external s: (string) => unit"), item("external s: string => unit"));
  // Two parameters, or one tuple.
  assert.deepEqual(item("type f = (int, string) => unit"), { kind: "TypeDecl", name: "f", params: [], definition: fn([name("int"), name("string")], name("unit")) });
  assert.deepEqual(item("type f = ((int, string)) => unit"), {
    kind: "TypeDecl", name: "f", params: [], definition: fn([{ kind: "TupleType", elements: [name("int"), name("string")] }], name("unit")),
  });
  // Function types are ordinary types: in fields, payloads and arguments.
  assert.deepEqual(item("type job = Job((report) => bool) | Idle"), {
    kind: "TypeDecl",
    name: "job",
    params: [],
    definition: {
      kind: "VariantType",
      constructors: [
        { kind: "ConstructorDecl", name: "Job", args: [fn([name("report")], name("bool"))] },
        { kind: "ConstructorDecl", name: "Idle", args: [] },
      ],
    },
  });
  assert.deepEqual(item("type handlers = {each: list<(time) => unit>}"), {
    kind: "TypeDecl",
    name: "handlers",
    params: [],
    definition: { kind: "RecordType", fields: [{ kind: "FieldDecl", name: "each", type: name("list", fn([name("time")], name("unit"))) }] },
  });
});

test("external is a keyword only at the start of a top-level item", () => {
  assert.deepEqual(parseOk("let external = 1\nexternal\nf(external)").body.map(strip), [
    { kind: "Let", pattern: variable("external"), value: int("1") },
    id("external"),
    call(id("f"), id("external")),
  ]);
});

test("the outline shows interface declarations", () => {
  assert.deepEqual([...treeLines(parseOk("type pr\nexternal f: (~at: time=?) => pr"))], [
    "Program  1:1-2:32",
    "  body:",
    "    TypeDecl name=\"pr\"  1:1-1:8",
    "    External name=\"f\"  2:1-2:32",
    "      type: FunctionType  2:13-2:32",
    "        params:",
    "          LabelledType label=\"at\" optional=true  2:14-2:25",
    "            type: TypeName name=\"time\"  2:19-2:23",
    "        result: TypeName name=\"pr\"  2:30-2:32",
  ]);
});

test("open Std, comments and the program span", () => {
  const program = parseOk("open Std\n// a comment\n/* another */ say(@alice, `hi`)\n");
  assert.deepEqual(program.body.map(strip), [
    { kind: "Open", module: "Std" },
    call(id("say"), participant("alice"), { kind: "TemplateLiteral", strings: ["hi"], expressions: [] }),
  ]);
  assert.deepEqual(program.span, { start: { line: 1, column: 1, offset: 0 }, end: { line: 4, column: 1, offset: 54 } });
  assert.deepEqual(parseOk("").body, []);
});

test("spans cover their source text", () => {
  const source = `switch q->wait(~until=1h) {\n| Done(x) =>\n  say(@alice, x)\n  x\n| _ => ()\n}`;
  const program = parseOk(source);
  const text = (span: { start: { offset: number }; end: { offset: number } }) => source.slice(span.start.offset, span.end.offset);
  const switchNode = program.body[0]!;
  assert.equal(text(switchNode.span), source);
  assert.ok(switchNode.kind === "Switch");
  assert.equal(text(switchNode.scrutinee.span), "q->wait(~until=1h)");
  const [first] = switchNode.cases;
  assert.equal(text(first!.span), "| Done(x) =>\n  say(@alice, x)\n  x");
  assert.equal(text(first!.body.span), "say(@alice, x)\n  x");
  assert.deepEqual(first!.body.span.start, { line: 3, column: 3, offset: 43 });
});

test("after an error the parser resumes at the next top-level line", () => {
  const diagnostics = parseErrors("let a = 1\nlet b = = 2\nlet c = 3\nswitch c {\n| 1 => x y\n}\nlet d = )");
  assert.deepEqual(diagnostics.map((d) => [d.message, d.span.start.line, d.span.start.column]), [
    ["expected an expression, found '='", 2, 9],
    ["expected a line break or ';' before 'y'", 5, 10],
    ["expected an expression, found ')'", 7, 9],
  ]);
});

test("chains of any length are loops: 10,000 links parse and survive a JSON round trip", () => {
  const roundTrip = (source: string) => {
    const program = parseOk(source);
    const text = astToJson(program);
    assert.equal(astToJson(astFromJson(text)), text);
    return program.body[0]!;
  };
  // The spine of a chain is as deep as the chain is long; walk it without recursion.
  const spine = (node: { kind: string }, next: (node: never) => { kind: string }) => {
    let length = 0;
    for (let at = node; at.kind !== "Identifier"; at = next(at as never)) length += 1;
    return length;
  };
  assert.equal(spine(roundTrip("x" + "->f".repeat(10_000)), (node: { left: { kind: string } }) => node.left), 10_000);
  assert.equal(spine(roundTrip(Array(10_001).fill("x").join(" + ")), (node: { left: { kind: string } }) => node.left), 10_000);
  assert.equal(spine(roundTrip("f" + "(x)".repeat(10_000)), (node: { callee: { kind: string } }) => node.callee), 10_000);
  assert.equal(spine(roundTrip("x" + "?".repeat(10_000)), (node: { operand: { kind: string } }) => node.operand), 10_000);
  assert.equal(spine(roundTrip("!".repeat(10_000) + "x"), (node: { operand: { kind: string } }) => node.operand), 10_000);
  // The outline is written without recursion too.
  let lines = 0;
  for (const _ of treeLines(parseOk("x" + "->f".repeat(10_000)))) lines += 1;
  assert.equal(lines, 20_003);
  const ifs = roundTrip("if a { 1 }" + " else if a { 1 }".repeat(9_999) + " else { 2 }");
  assert.equal(spine(ifs, (node: { elseBranch: { kind: string } }) => (node.elseBranch.kind === "Block" ? { kind: "Identifier" } : node.elseBranch)), 10_000);
});

test("nesting deeper than the stack can follow is a diagnostic, not a crash", () => {
  for (const source of ["(".repeat(200_000) + "x" + ")".repeat(200_000), "[".repeat(200_000), "x => ".repeat(200_000) + "x"]) {
    const [diagnostic, ...rest] = parseErrors(source);
    assert.equal(diagnostic!.message, STACK_EXHAUSTED);
    assert.equal(diagnostic!.span.start.line, 1);
    assert.deepEqual(rest, []);
  }
  // The other items of the program are still read and checked.
  const diagnostics = parseErrors(`let a = ${"(".repeat(200_000)}\nlet b = = 1\nlet c = 2`);
  assert.deepEqual(diagnostics.map((d) => [d.message, d.span.start.line]), [[STACK_EXHAUSTED, 1], ["expected an expression, found '='", 2]]);
});

test("CRLF line endings parse to the same tree", () => {
  const source = "let rec push = () => {\n  let r = run(@claude, task)?\n  if !judge(c, ~about=r)? {\n    push()\n  }\n}\npush()\n";
  assert.deepEqual(strip(parseOk(source.replaceAll("\n", "\r\n"))), strip(parseOk(source)));
});

test("no object appears twice in a tree, punned names and literal patterns included", () => {
  const program = parseOk(`type t<'a> = A('a) | B
let f = (~at, ~every as period, ~on=[], x) => {count, at}
let g = ({version, state}) => ask(who, ~options, ~until)
switch o {
| (A | B) | C => @auto(~repo)
| {name} => -1
| () | "x" | -2 | 1.5 | true => [x, ...rest]
| _ =>
  let y = q->wait?
  y
}`);
  assertNoSharedObjects(program);
  assert.deepEqual(preorderKinds(program), preorderKinds(astFromJson(astToJson(program))));
});
