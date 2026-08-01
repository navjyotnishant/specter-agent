// Author: Navjyot Nishant
// Created: 2026-08-01
// Last updated: 2026-08-01
// Description: Graph validation for the Workflow Builder — what makes a graph
//              unrunnable, and which connections must be refused.
//
// Pure and testable. The inspector marks six fields "Required" with a red
// asterisk and nothing consumed any of them: saveGraph validated only the
// workflow name, and Run was gated solely on whether a repository was selected.
// So a graph with no edges, empty objectives, an unset condition, an unset
// webhook URL, or a cycle would start a real sandboxed agent run.
//
// Run the self-check with:  npx tsx src/lib/graph-validation.ts

import type { Edge, Node } from "@xyflow/react";

export type GraphIssue = {
  nodeId: string;
  /** Node label, for a message the user can act on without opening the node. */
  label: string;
  reason: string;
};

const AGENT_TYPES = new Set(["supervisorAgent", "specialistAgent"]);

function str(data: Record<string, unknown>, key: string): string {
  return String(data[key] ?? "").trim();
}

/**
 * Every reason this graph cannot run, one per offending node.
 *
 * Deliberately not reported: a node with no skills, an empty system-instructions
 * field, or a missing model. Those produce a worse run, not a broken one, and
 * blocking on them would train people to ignore the gate.
 */
export function graphIssues(nodes: Node[], edges: Edge[]): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const labelOf = (n: Node) => str(n.data as Record<string, unknown>, "label") || n.id;

  for (const node of nodes) {
    const data = (node.data ?? {}) as Record<string, unknown>;
    const label = labelOf(node);

    if (!str(data, "label")) issues.push({ nodeId: node.id, label: node.id, reason: "has no label" });

    if (AGENT_TYPES.has(String(node.type)) && !str(data, "objective")) {
      issues.push({ nodeId: node.id, label, reason: "has no objective — the agent would get no instruction" });
    }
    if (node.type === "conditional" && !str(data, "condition")) {
      issues.push({ nodeId: node.id, label, reason: "has no condition — the branch cannot be evaluated" });
    }
    if (node.type === "webhook" && !str(data, "url")) {
      issues.push({ nodeId: node.id, label, reason: "has no URL — nothing would be posted" });
    }
    if (node.type === "trigger" && !str(data, "fieldName")) {
      issues.push({ nodeId: node.id, label, reason: "has no field name — its input cannot be passed on" });
    }
  }

  // Orphans: with more than one node, anything unconnected can never run.
  if (nodes.length > 1) {
    const connected = new Set<string>();
    for (const e of edges) { connected.add(e.source); connected.add(e.target); }
    for (const node of nodes) {
      if (!connected.has(node.id)) {
        issues.push({ nodeId: node.id, label: labelOf(node), reason: "is not connected to anything" });
      }
    }
  }

  for (const id of findCycle(nodes, edges)) {
    const node = nodes.find((n) => n.id === id);
    issues.push({ nodeId: id, label: node ? labelOf(node) : id, reason: "is part of a loop — the run would never finish" });
  }

  return issues;
}

/**
 * Node ids that sit in a cycle, via Kahn's algorithm.
 *
 * The same check already exists server-side in supervisor.py, but only guards
 * the LLM planner's output — never the graph a human draws on the canvas.
 */
export function findCycle(nodes: Node[], edges: Edge[]): string[] {
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!indegree.has(e.target) || !out.has(e.source)) continue;
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
    out.get(e.source)!.push(e.target);
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const settled = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    settled.add(id);
    for (const next of out.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  // Anything never reaching in-degree zero is in, or downstream of, a cycle.
  return nodes.map((n) => n.id).filter((id) => !settled.has(id));
}

/**
 * Whether an edge may be drawn. Refuses self-loops and any connection that
 * would close a cycle — checked by walking forward from `target` looking for
 * `source`, which is cheaper than rebuilding the whole graph per hover.
 */
export function canConnect(source: string, target: string, edges: Edge[]): boolean {
  if (source === target) return false;
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    adjacency.get(e.source)!.push(e.target);
  }
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === source) return false; // target already reaches source: this closes a loop
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(adjacency.get(id) ?? []));
  }
  return true;
}

// ── self-check ───────────────────────────────────────────────────────────────

function demo() {
  const n = (id: string, type = "specialistAgent", data: Record<string, unknown> = {}): Node =>
    ({ id, type, position: { x: 0, y: 0 }, data: { label: id, objective: "do a thing", ...data } }) as Node;
  const e = (s: string, t: string): Edge => ({ id: `${s}-${t}`, source: s, target: t }) as Edge;

  // A valid two-node chain has no issues.
  console.assert(graphIssues([n("a"), n("b")], [e("a", "b")]).length === 0, "valid graph must be clean");

  // A single node needs no edges -- orphan detection starts at two.
  console.assert(graphIssues([n("solo")], []).length === 0, "a lone node is runnable");

  // Empty objective on an agent blocks.
  const noObjective = graphIssues([n("a", "specialistAgent", { objective: "" }), n("b")], [e("a", "b")]);
  console.assert(noObjective.some((i) => i.reason.includes("objective")), "empty objective must block");

  // Unset conditional and webhook block; a set one does not.
  console.assert(
    graphIssues([n("c", "conditional", { condition: "" }), n("b")], [e("c", "b")])
      .some((i) => i.reason.includes("condition")),
    "unset condition must block",
  );
  console.assert(
    graphIssues([n("c", "conditional", { condition: "is it ok?" }), n("b")], [e("c", "b")]).length === 0,
    "a set condition is fine",
  );
  console.assert(
    graphIssues([n("w", "webhook", { url: "" }), n("b")], [e("b", "w")])
      .some((i) => i.reason.includes("URL")),
    "unset webhook URL must block",
  );

  // Orphans and the zero-edge case.
  console.assert(
    graphIssues([n("a"), n("b"), n("orphan")], [e("a", "b")])
      .some((i) => i.nodeId === "orphan"), "an orphan must be reported",
  );
  console.assert(graphIssues([n("a"), n("b")], []).length === 2, "no edges means both nodes orphaned");

  // Cycles.
  const cyc = graphIssues([n("a"), n("b")], [e("a", "b"), e("b", "a")]);
  console.assert(cyc.some((i) => i.reason.includes("loop")), "a 2-cycle must be reported");
  console.assert(findCycle([n("a"), n("b")], [e("a", "b")]).length === 0, "a DAG has no cycle");
  console.assert(
    findCycle([n("a"), n("b"), n("c")], [e("a", "b"), e("b", "c"), e("c", "a")]).length === 3,
    "a 3-cycle reports all three",
  );

  // canConnect.
  console.assert(!canConnect("a", "a", []), "self-loops refused");
  console.assert(canConnect("a", "b", []), "a fresh edge is allowed");
  console.assert(!canConnect("b", "a", [e("a", "b")]), "closing a 2-cycle refused");
  console.assert(!canConnect("c", "a", [e("a", "b"), e("b", "c")]), "closing a 3-cycle refused");
  console.assert(canConnect("a", "c", [e("a", "b"), e("b", "c")]), "a shortcut edge is allowed");

  console.log("graph-validation self-check OK");
}

declare const process: { argv?: string[] } | undefined;
if (typeof process !== "undefined" && process?.argv?.[1]?.includes("graph-validation")) demo();
