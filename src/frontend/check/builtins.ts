/**
 * What every program sees without declaring it: the base types, `list`,
 * `option`, `result`, `outcome`, the three source types, and the built-in
 * functions with the signatures of docs/types.md §5.
 *
 * In a signature, `'d` is a `deadline` variable, `'t` an `addressee` variable
 * and `'h` a `handled` variable (§3).
 */
import { TypeTable, typeInfo, type CtorInfo, type TypeInfo } from "./declarations.ts";
import {
  FACT, GENERIC, OCCURRENCE, REQUEST, con, fun, newVar, source, type FiniteClass, type TLabel, type TParam, type Type,
} from "./types.ts";

/** The effect families of docs/types.md §8, in the order the effects summary lists them. */
export const FAMILIES = ["ask", "run", "request", "start", "wait", "cancel", "handOver", "say", "judge"] as const;
export type Family = (typeof FAMILIES)[number];

export const BASE_TYPES = ["string", "int", "float", "bool", "unit", "time", "duration", "participant", "ref"] as const;

export const t = {
  string: con("string"),
  int: con("int"),
  float: con("float"),
  bool: con("bool"),
  unit: con("unit"),
  time: con("time"),
  duration: con("duration"),
  participant: con("participant"),
  ref: con("ref"),
  list: (element: Type) => con("list", element),
  option: (element: Type) => con("option", element),
  result: (value: Type, error: Type) => con("result", value, error),
  outcome: (value: Type) => con("outcome", value),
  event: (element: Type) => source(FACT, element),
  stream: (element: Type) => source(OCCURRENCE, element),
  request: (element: Type) => source(REQUEST, element),
};

const param = (index: number, name: string): TParam => ({ tag: "param", index, name });

/** The table every host interface starts from. */
export function builtinTable(): TypeTable {
  const table = new TypeTable();
  for (const name of BASE_TYPES) table.types.set(name, typeInfo({ name, kind: "base", origin: "builtin" }));
  table.types.set("list", typeInfo({ name: "list", kind: "list", origin: "builtin", params: ["a"], equality: { never: false, params: new Set([0]) } }));
  const variant = (name: string, params: string[], constructors: [string, Type[]][]) => {
    const info = typeInfo({ name, kind: "variant", origin: "builtin", params, equality: { never: false, params: new Set(params.map((_, index) => index)) } });
    info.constructors = constructors.map(([ctor, args], index): CtorInfo => ({ name: ctor, owner: info, args, index, decl: null }));
    table.adopt(info);
  };
  const a = param(0, "a");
  variant("option", ["a"], [["None", []], ["Some", [a]]]);
  variant("result", ["a", "e"], [["Ok", [a]], ["Error", [param(1, "e")]]]);
  variant("outcome", ["a"], [["Done", [a]], ["Declined", [t.string]], ["Failed", [t.string]], ["TimedOut", []], ["Cancelled", []], ["Revoked", []]]);
  const sourceName = (name: string, kind: Type): TypeInfo =>
    typeInfo({ name, kind: "source", origin: "builtin", params: ["a"], sourceKind: kind, equality: { never: false, params: new Set([0]) } });
  table.types.set("event", sourceName("event", FACT));
  table.types.set("stream", sourceName("stream", OCCURRENCE));
  table.types.set("request", sourceName("request", REQUEST));
  return table;
}

/** A built-in value: its generalized type, the effect family it performs, and whether it is `ask`, which is not a value. */
export interface Builtin {
  readonly name: string;
  readonly type: Type;
  readonly family: Family | null;
}

const g = (cls: FiniteClass | null = null) => newVar(GENERIC, cls);
const required = (label: string, type: Type): TLabel => ({ label, type, optional: false });
const optional = (label: string, type: Type): TLabel => ({ label, type, optional: true });

/** The two types of `ask`. The call site chooses by whether it passes `~options` (§5), so `ask` is not a value. */
export function askType(withOptions: boolean): Type {
  if (withOptions) {
    const a = g();
    return fun([t.participant, t.string], [required("options", t.list(a)), optional("until", g("deadline"))], t.outcome(a));
  }
  return fun([t.participant, t.string], [optional("until", g("deadline"))], t.outcome(t.string));
}

/** The built-in functions other than `ask`. `report` is the host's type (§7). */
export function builtinValues(): Builtin[] {
  const report = con("report");
  const values: [string, Family | null, () => Type][] = [
    ["run", "run", () => fun([t.participant, t.string], [optional("context", g()), optional("until", g("deadline"))], t.outcome(report))],
    ["request", "request", () => fun([t.participant, t.string], [], t.request(t.string))],
    ["start", "start", () => fun([t.participant, t.string], [optional("context", g())], t.request(report))],
    ["wait", "wait", () => {
      const a = g();
      return fun([source(g(), a)], [optional("until", g("deadline"))], t.outcome(a));
    }],
    ["cancel", "cancel", () => fun([t.request(g())], [], t.unit)],
    ["handOver", "handOver", () => {
      const a = g();
      return fun([t.request(a), t.participant], [], t.request(a));
    }],
    ["status", null, () => {
      const a = g();
      return fun([t.request(a)], [], t.option(t.outcome(a)));
    }],
    ["say", "say", () => fun([g("addressee"), t.string], [], t.unit)],
    ["judge", "judge", () => fun([t.string], [optional("about", g())], t.outcome(t.bool))],
    ["now", null, () => fun([], [], t.time)],
    ["show", null, () => fun([g()], [], t.string)],
    ["ignore", null, () => fun([g()], [], t.unit)],
    ["fail", null, () => fun([t.outcome(g())], [], g())],
    ["every", null, () => fun([t.duration], [], t.stream(t.time))],
    ["after", null, () => fun([g("deadline")], [], t.stream(t.time))],
    ["never", null, () => fun([], [], t.stream(g()))],
    ["merge", null, () => {
      const a = g();
      return fun([t.stream(a), t.stream(a)], [], t.stream(a));
    }],
    ["or", null, () => fun([t.stream(g()), t.stream(g())], [], t.stream(t.unit))],
    ["map", null, () => {
      const a = g();
      const b = g();
      return fun([t.stream(a), fun([a], [], b)], [], t.stream(b));
    }],
    ["filter", null, () => {
      const a = g();
      return fun([t.stream(a), fun([a], [], t.bool)], [], t.stream(a));
    }],
    // forEach waits for each occurrence, so it counts as the wait family.
    ["forEach", "wait", () => {
      const a = g();
      return fun([t.stream(a), fun([a], [], g("handled"))], [], g());
    }],
  ];
  return values.map(([name, family, type]) => ({ name, family, type: type() }));
}
