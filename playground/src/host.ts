/**
 * The simulated host's facts and streams, read from the `external`
 * declarations of its interface file (hosts/reference.norn), so the forms
 * that fire them follow the interface as it changes. Pure: the page renders
 * a `Field` as inputs and gives back what was typed, which `valueOf` turns
 * into a runtime value.
 */
import type * as A from "../../src/frontend/ast.ts";
import { lex } from "../../src/frontend/lexer.ts";
import type { Value } from "../../src/runtime/browser.ts";

export interface HostExternal {
  name: string;
  kind: "fact" | "stream";
  /** The comment above the declaration. */
  doc: string;
  params: HostParam[];
  /** The type of the value each occurrence carries. */
  element: A.TypeExpression;
}

export interface HostParam {
  /** Null for a positional parameter. */
  label: string | null;
  optional: boolean;
  type: A.TypeExpression;
}

export interface Host {
  externals: HostExternal[];
  types: ReadonlyMap<string, A.TypeDecl>;
}

/** The facts and streams a host interface declares, with the comment above each. */
export function readHost(program: A.Program, text: string): Host {
  const lines = text.split("\n");
  const types = new Map<string, A.TypeDecl>();
  const externals: HostExternal[] = [];
  for (const item of program.body) {
    if (item.kind === "TypeDecl") types.set(item.name, item);
    if (item.kind !== "External" || item.type.kind !== "FunctionType") continue;
    const result = item.type.result;
    if (result.kind !== "TypeName" || (result.name !== "event" && result.name !== "stream") || result.args.length !== 1) continue;
    externals.push({
      name: item.name,
      kind: result.name === "event" ? "fact" : "stream",
      doc: comment(lines, item.span.start.line),
      params: item.type.params.map((param) =>
        param.kind === "LabelledType" ? { label: param.label, optional: param.optional, type: param.type } : { label: null, optional: false, type: param }),
      element: result.args[0]!,
    });
  }
  return { externals, types };
}

/** The `//` lines right above a line, as one paragraph. */
function comment(lines: readonly string[], line: number): string {
  const found: string[] = [];
  for (let index = line - 2; index >= 0; index -= 1) {
    const match = /^\s*\/\/\s?(.*)$/.exec(lines[index]!);
    if (match === null) break;
    found.unshift(match[1]!.trim());
  }
  return found.join(" ");
}

// Fields -----------------------------------------------------------------------

/** How a value of a type is typed in: one input, a choice of constructor, or a record's fields. */
export type Field =
  | { kind: "text"; type: string }
  | { kind: "abstract"; type: string }
  | { kind: "number"; type: "int" | "float" }
  | { kind: "bool" }
  | { kind: "unit" }
  /** Typed as Norn writes it, and read by Norn's lexer: `@alice`, `doc"ops#machines"`, `2026-11-07T12:00Z`, `2h`. */
  | { kind: "literal"; type: "participant" | "ref" | "time" | "duration" }
  /** Constructors' arguments are read when one is chosen, so a recursive type has no end to unfold. */
  | { kind: "variant"; type: string; constructors: { name: string; args: () => Field[] }[] }
  | { kind: "record"; type: string; fields: { name: string; field: Field }[] }
  | { kind: "unsupported"; type: string };

const NO_SPAN: A.Span = { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } };

function name(type: string): A.TypeName {
  return { kind: "TypeName", name: type, args: [], span: NO_SPAN };
}

function variable(type: string): A.TypeVar {
  return { kind: "TypeVar", name: type, span: NO_SPAN };
}

const BUILTIN_VARIANTS: Record<string, { params: string[]; constructors: [string, A.TypeExpression[]][] }> = {
  outcome: { params: ["a"], constructors: [["Done", [variable("a")]], ["Declined", [name("string")]], ["Failed", [name("string")]], ["TimedOut", []], ["Cancelled", []], ["Revoked", []]] },
  option: { params: ["a"], constructors: [["None", []], ["Some", [variable("a")]]] },
  result: { params: ["a", "e"], constructors: [["Ok", [variable("a")]], ["Error", [variable("e")]]] },
};

/** The field for a type, with the type arguments in force where it appears. */
export function fieldFor(type: A.TypeExpression, types: ReadonlyMap<string, A.TypeDecl>, bound: ReadonlyMap<string, A.TypeExpression> = new Map()): Field {
  if (type.kind === "TypeVar") {
    const argument = bound.get(type.name);
    return argument === undefined ? { kind: "unsupported", type: `'${type.name}` } : fieldFor(argument, types);
  }
  if (type.kind !== "TypeName") return { kind: "unsupported", type: describe(type) };
  const shown = describe(type);
  switch (type.name) {
    case "string":
      return { kind: "text", type: shown };
    case "int":
    case "float":
      return { kind: "number", type: type.name };
    case "bool":
      return { kind: "bool" };
    case "unit":
      return { kind: "unit" };
    case "participant":
    case "ref":
    case "time":
    case "duration":
      return { kind: "literal", type: type.name };
  }
  const arguments_ = new Map<string, A.TypeExpression>();
  const builtin = BUILTIN_VARIANTS[type.name];
  if (builtin !== undefined) {
    builtin.params.forEach((param, index) => arguments_.set(param, resolveArgument(type.args[index], bound)));
    return {
      kind: "variant",
      type: shown,
      constructors: builtin.constructors.map(([ctor, args]) => ({ name: ctor, args: () => args.map((arg) => fieldFor(arg, types, arguments_)) })),
    };
  }
  const declared = types.get(type.name);
  if (declared === undefined) return { kind: "unsupported", type: shown };
  declared.params.forEach((param, index) => arguments_.set(param.name, resolveArgument(type.args[index], bound)));
  const definition = declared.definition;
  if (definition === null) return { kind: "abstract", type: shown };
  if (definition.kind === "VariantType") {
    return {
      kind: "variant",
      type: shown,
      constructors: definition.constructors.map((ctor) => ({ name: ctor.name, args: () => ctor.args.map((arg) => fieldFor(arg, types, arguments_)) })),
    };
  }
  if (definition.kind === "RecordType") {
    return { kind: "record", type: shown, fields: definition.fields.map((field) => ({ name: field.name, field: fieldFor(field.type, types, arguments_) })) };
  }
  return fieldFor(definition, types, arguments_);
}

function resolveArgument(type: A.TypeExpression | undefined, bound: ReadonlyMap<string, A.TypeExpression>): A.TypeExpression {
  if (type === undefined) return variable("_");
  return type.kind === "TypeVar" ? (bound.get(type.name) ?? type) : type;
}

/** A type expression as Norn writes it. */
export function describe(type: A.TypeExpression): string {
  switch (type.kind) {
    case "TypeName":
      return type.args.length === 0 ? type.name : `${type.name}<${type.args.map(describe).join(", ")}>`;
    case "TypeVar":
      return `'${type.name}`;
    case "TupleType":
      return `(${type.elements.map(describe).join(", ")})`;
    case "FunctionType":
      return `(${type.params.map((param) => (param.kind === "LabelledType" ? `~${param.label}: ${describe(param.type)}${param.optional ? "=?" : ""}` : describe(param))).join(", ")}) => ${describe(type.result)}`;
  }
}


// What was typed, as values -----------------------------------------------------

/** What the page collected for a field: text for one input, the chosen constructor with its arguments, or a record's fields. */
export type Input =
  | string
  | boolean
  | { choice: string; args: Input[] }
  | { fields: Record<string, Input> };

export type Read = { ok: true; value: Value } | { ok: false; message: string };

/** The runtime value for what was typed into a field, or what is wrong with it. */
export function valueOf(field: Field, input: Input | undefined): Read {
  switch (field.kind) {
    case "text":
    case "abstract":
      return { ok: true, value: { type: "string", value: typeof input === "string" ? input : "" } };
    case "unit":
      return { ok: true, value: { type: "unit" } };
    case "bool":
      return { ok: true, value: { type: "bool", value: input === true } };
    case "number": {
      const text = typeof input === "string" ? input.trim() : "";
      if (field.type === "int") {
        return /^-?[0-9]+$/.test(text)
          ? { ok: true, value: { type: "int", value: BigInt(text).toString() } }
          : { ok: false, message: "Write a whole number, as in 3" };
      }
      const number = Number(text);
      return text !== "" && Number.isFinite(number)
        ? { ok: true, value: { type: "float", value: Object.is(number, -0) ? "-0" : String(number) } }
        : { ok: false, message: "Write a number, as in 2.5" };
    }
    case "literal":
      return literalValue(field.type, typeof input === "string" ? input.trim() : "");
    case "variant": {
      const chosen = typeof input === "object" && Object.hasOwn(input, "choice") ? input as { choice: string; args: Input[] } : { choice: field.constructors[0]?.name ?? "", args: [] };
      const ctor = field.constructors.find((candidate) => candidate.name === chosen.choice);
      if (ctor === undefined) return { ok: false, message: `Choose one of ${field.constructors.map((c) => c.name).join(", ")}` };
      const args: Value[] = [];
      for (const [index, argument] of ctor.args().entries()) {
        const read = valueOf(argument, chosen.args[index]);
        if (!read.ok) return read;
        args.push(read.value);
      }
      return { ok: true, value: { type: "variant", name: ctor.name, args } };
    }
    case "record": {
      const fields: Record<string, Value> = {};
      const given = typeof input === "object" && Object.hasOwn(input, "fields") ? (input as { fields: Record<string, Input> }).fields : {};
      for (const { name: fieldName, field: fieldType } of field.fields) {
        const read = valueOf(fieldType, given[fieldName]);
        if (!read.ok) return { ok: false, message: `${fieldName}: ${read.message}` };
        fields[fieldName] = read.value;
      }
      return { ok: true, value: { type: "record", fields } };
    }
    case "unsupported":
      return { ok: false, message: `The playground has no form for ${field.type} yet` };
  }
}

const EXAMPLES = { participant: "@alice", ref: 'doc"ops#machines"', time: "2026-11-07T12:00Z", duration: "2h" } as const;

/** A participant, reference, time or duration, read by Norn's own lexer. */
function literalValue(type: "participant" | "ref" | "time" | "duration", text: string): Read {
  const wrong: Read = { ok: false, message: `Write a ${type === "ref" ? "reference" : type} as in ${EXAMPLES[type]}` };
  const { tokens, diagnostics } = lex(text);
  if (diagnostics.length > 0 || tokens.length !== 2) return wrong;
  const token = tokens[0]!;
  switch (token.kind) {
    case "Participant":
      return type === "participant" ? { ok: true, value: { type: "participant", name: token.name, instance: token.instance, labels: {} } } : wrong;
    case "Ref":
      return type === "ref" ? { ok: true, value: { type: "ref", kind: token.refKind, value: token.value } } : wrong;
    case "Time":
      return type === "time" ? { ok: true, value: { type: "time", value: String(token.epochMs) } } : wrong;
    case "Duration": {
      const unit = { m: 60_000n, h: 3_600_000n, d: 86_400_000n, w: 604_800_000n }[token.unit];
      return type === "duration" ? { ok: true, value: { type: "duration", value: String(BigInt(token.amount) * unit) } } : wrong;
    }
    default:
      return wrong;
  }
}

/** A placeholder for a literal field. */
export function example(type: "participant" | "ref" | "time" | "duration"): string {
  return EXAMPLES[type];
}

/** The source value for an external called with these arguments, as the program would make it. */
export function sourceValue(external: HostExternal, args: (Value | null)[]): Value {
  const positional: Value[] = [];
  const labels: Record<string, Value> = {};
  external.params.forEach((param, index) => {
    const value = args[index];
    if (value === null || value === undefined) return;
    if (param.label === null) positional.push(value);
    else labels[param.label] = value;
  });
  return { type: "source", kind: external.kind, name: external.name, args: positional, labels };
}
