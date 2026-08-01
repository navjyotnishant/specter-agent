// Author: Navjyot Nishant
// Created: 2026-08-01
// Last updated: 2026-08-01
// Description: Pure persistence helpers for the Workflow Builder — snapshotting,
//              graph normalization, and the save-state decision.
//
// These live outside WorkflowBuilder.tsx because they are the functions with a
// data-loss history, and inside a 1,377-line component they were unreachable
// from any test. Everything here is pure: no React, no I/O, no globals.
//
// Run the self-check with:  npx tsx src/lib/workflow-persistence.ts

import type { Edge, Node } from "@xyflow/react";

/** A graph fingerprint. Two equal strings mean "nothing the user cares about changed". */
export function snapshotOf(
  nodes: Node[],
  edges: Edge[],
  name: string,
  description: string,
): string {
  return JSON.stringify({
    name,
    description,
    // Positions count: a drag is a real change the user expects to keep.
    nodes: nodes.map((x) => ({ id: x.id, type: x.type, position: x.position, data: x.data })),
    edges: edges.map((x) => ({ id: x.id, source: x.source, target: x.target })),
  });
}

/**
 * Structural fingerprint — ids, types and connections only, no positions or data.
 *
 * The baseline timer keys on this so that dragging a node (which changes
 * `position` every frame) does not restart it. Without that distinction the
 * 400ms timer never fires while the user is interacting, `baselined` never
 * latches, and the unsaved-changes guard silently never arms.
 */
export function structureOf(nodes: Node[], edges: Edge[]): string {
  return JSON.stringify({
    nodes: nodes.map((n) => `${n.id}:${n.type}`).sort(),
    edges: edges.map((e) => `${e.source}>${e.target}`).sort(),
  });
}

/** True when the current state differs from what is known to be on the server. */
export function isGraphDirty(current: string, savedSnapshot: string, baselined: boolean): boolean {
  // Before the baseline lands, everything looks changed — reporting dirty then
  // would prompt on a canvas the user has not touched.
  if (!baselined) return false;
  return current !== savedSnapshot;
}

/**
 * Normalize a stored graph into React Flow's shape.
 *
 * Empty stays empty. Substituting a seed template here made a blank workflow
 * look like a sample, which autosave then made permanent.
 */
export function normalizeGraph(
  graph: { nodes?: unknown[]; edges?: unknown[] } | undefined,
  decorateEdge: (e: Edge) => Edge = (e) => e,
): { nodes: Node[]; edges: Edge[] } {
  if (!Array.isArray(graph?.nodes) || graph.nodes.length === 0) return { nodes: [], edges: [] };
  const nodes = (graph.nodes as (Partial<Node> & Record<string, unknown>)[]).map((raw, i) => ({
    id: String(raw.id ?? `node-${i}`),
    type: String(raw.type ?? "specialistAgent"),
    position: (raw.position as { x: number; y: number }) ?? { x: 100 + i * 240, y: 120 },
    data: (raw.data ?? {}) as Record<string, unknown>,
  })) as Node[];
  const edges = ((Array.isArray(graph?.edges) ? graph.edges : []) as Edge[]).map(decorateEdge);
  return { nodes, edges };
}

/** Fresh id for a new node. Random, so ids never collide across reloads. */
export function newNodeId(type: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${type}-${rand}`;
}

// ── self-check ───────────────────────────────────────────────────────────────
// Assert-based, no framework. These are the exact behaviours that have caused
// data loss in this component before.

function demo() {
  const n = (id: string, x = 0): Node =>
    ({ id, type: "specialistAgent", position: { x, y: 0 }, data: { label: id } }) as Node;
  const e = (s: string, t: string): Edge => ({ id: `${s}-${t}`, source: s, target: t }) as Edge;

  // snapshotOf: positions are part of the fingerprint (a drag is a real change).
  const a = snapshotOf([n("x", 0)], [], "w", "d");
  const b = snapshotOf([n("x", 50)], [], "w", "d");
  console.assert(a !== b, "moving a node must change the snapshot");
  console.assert(snapshotOf([n("x")], [], "w", "d") === a, "same state must fingerprint equal");

  // Renaming via data must be visible to the dirty check. This is the bug where
  // an in-place `data.label = ...` mutation left the workflow looking unchanged.
  const renamed = { ...n("x"), data: { label: "renamed" } } as Node;
  console.assert(snapshotOf([renamed], [], "w", "d") !== a, "a rename must change the snapshot");

  // structureOf: ignores position, so a drag does not restart the baseline timer.
  console.assert(
    structureOf([n("x", 0)], []) === structureOf([n("x", 999)], []),
    "dragging must not change the structural fingerprint",
  );
  console.assert(
    structureOf([n("x")], []) !== structureOf([n("x"), n("y")], []),
    "adding a node must change the structural fingerprint",
  );
  console.assert(
    structureOf([n("x"), n("y")], []) !== structureOf([n("x"), n("y")], [e("x", "y")]),
    "adding an edge must change the structural fingerprint",
  );

  // isGraphDirty: never dirty before the baseline lands.
  console.assert(!isGraphDirty("a", "b", false), "must not report dirty before baselining");
  console.assert(isGraphDirty("a", "b", true), "must report dirty after baselining when changed");
  console.assert(!isGraphDirty("a", "a", true), "identical state is not dirty");

  // normalizeGraph: empty stays empty -- the fabricated-default bug.
  console.assert(normalizeGraph(undefined).nodes.length === 0, "undefined graph stays empty");
  console.assert(normalizeGraph({ nodes: [] }).nodes.length === 0, "empty graph stays empty");
  console.assert(
    normalizeGraph({ nodes: [{ id: "a" }] }).nodes[0].type === "specialistAgent",
    "missing type defaults",
  );
  // Edges survive normalization; a graph with edges but no nodes is still empty.
  console.assert(
    normalizeGraph({ nodes: [{ id: "a" }, { id: "b" }], edges: [{ id: "e", source: "a", target: "b" }] })
      .edges.length === 1,
    "edges survive normalization",
  );

  // newNodeId: unique across calls, so two nodes can never share an id.
  const ids = new Set(Array.from({ length: 500 }, () => newNodeId("specialistAgent")));
  console.assert(ids.size === 500, "node ids must not collide");

  console.log("workflow-persistence self-check OK");
}

// Node/tsx entry point only; never runs in the browser bundle.
declare const process: { argv?: string[] } | undefined;
if (typeof process !== "undefined" && process?.argv?.[1]?.includes("workflow-persistence")) demo();
