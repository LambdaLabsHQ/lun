/**
 * A readable outline of a syntax tree, as printed by `norn parse`: one node
 * per line with its scalar fields and span, children indented below it.
 *
 *     Program  1:1-3:25
 *       body:
 *         TypeDecl name="probe"  3:1-3:25
 *           definition: VariantType  3:14-3:25
 */
import { NODE_FIELDS, type AstNode, type Span } from "./ast.ts";

export function formatTree(node: AstNode): string {
  const lines: string[] = [];
  write(node, "", "", lines);
  return `${lines.join("\n")}\n`;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && "kind" in value;
}

function write(node: AstNode, indent: string, label: string, lines: string[]): void {
  const scalars: string[] = [];
  const children: [string, AstNode | AstNode[]][] = [];
  const fields = node as unknown as { [field: string]: unknown };
  for (const field of NODE_FIELDS[node.kind] as readonly string[]) {
    const value = fields[field];
    if (value === null || (Array.isArray(value) && value.length === 0)) continue;
    if (isNode(value)) children.push([field, value]);
    else if (Array.isArray(value) && value.every(isNode)) children.push([field, value]);
    else scalars.push(`${field}=${JSON.stringify(value)}`);
  }
  const summary = [node.kind, ...scalars].join(" ");
  lines.push(`${indent}${label}${summary}  ${formatSpan(node.span)}`);
  for (const [field, value] of children) {
    if (Array.isArray(value)) {
      lines.push(`${indent}  ${field}:`);
      for (const child of value) write(child, `${indent}    `, "", lines);
    } else {
      write(value, `${indent}  `, `${field}: `, lines);
    }
  }
}

function formatSpan({ start, end }: Span): string {
  return `${start.line}:${start.column}-${end.line}:${end.column}`;
}
