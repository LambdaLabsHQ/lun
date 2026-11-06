import { createHash } from "node:crypto";
import { NODE_FIELDS, type AstNode, type Program } from "../frontend/ast.ts";
import { astToJson } from "../frontend/json.ts";

/** Pinned code is kept separately from a serializable machine checkpoint. */
export interface Code {
  id: string;
  root: string;
  nodes: Record<string, AstNode>;
  nodeId(node: AstNode): string;
}
export function compile(program: Program): Code {
  const ids = new WeakMap<object, string>();
  const nodes: Record<string, AstNode> = Object.create(null);
  let nextNode = 0;
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object" || !("kind" in value) || !("span" in value)) return;
    const node = value as AstNode;
    if (ids.has(node)) return;
    const id = `n${nextNode++}`;
    ids.set(node, id); nodes[id] = node;
    for (const field of NODE_FIELDS[node.kind]) visit((node as unknown as Record<string, unknown>)[field]);
  }
  visit(program);
  return {
    id: `sha256:${createHash("sha256").update(astToJson(program)).digest("hex")}`,
    root: ids.get(program)!, nodes,
    nodeId(node) { const id = ids.get(node); if (!id) throw new Error("Node does not belong to pinned code"); return id; },
  };
}
