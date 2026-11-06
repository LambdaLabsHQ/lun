import type { AstNode, Expression, FieldsOf, NodeKind, Pattern, Program, Statement, Span } from "../../src/frontend/ast.ts";
const span: Span = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } };
export function n<K extends NodeKind>(kind: K, fields: Pick<Extract<AstNode, {kind: K}>, FieldsOf<K>>): Extract<AstNode, {kind: K}> {
  return { kind, ...fields, span } as Extract<AstNode, {kind: K}>;
}
export const id = (name: string) => n("Identifier", { name });
export const variable = (name: string) => n("VarPattern", { name });
export const int = (value: string | number) => n("IntLiteral", { value: String(value) });
export const str = (value: string) => n("StringLiteral", { value });
export const call = (name: string, ...args: Expression[]) => n("Call", { callee: id(name), args });
export const block = (...body: Statement[]) => n("Block", { body });
export const let_ = (name: string, value: Expression) => n("Let", { pattern: variable(name), value });
export const lambda = (params: string[], body: Expression) => n("Lambda", { params: params.map(variable), body });
export const constructor = (name: string, ...args: Expression[]) => n("Constructor", { name, args });
export const bin = (op: "+" | "-" | "==", left: Expression, right: Expression) => n("Binary", { op, left, right });
export const program = (...body: Statement[]): Program => n("Program", { body });
