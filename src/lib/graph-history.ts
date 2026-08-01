// Author: Navjyot Nishant
// Created: 2026-08-01
// Last updated: 2026-08-01
// Description: Undo/redo history for the Workflow Builder canvas.
//
// Pure reducer over {past, present, future}. Kept out of the component so it is
// testable, and so the coalescing rule below — the part that actually decides
// whether undo feels right — can be asserted rather than eyeballed.
//
// Run the self-check with:  npx tsx src/lib/graph-history.ts

import type { Edge, Node } from "@xyflow/react";

export type GraphState = { nodes: Node[]; edges: Edge[] };

export type History = {
  past: GraphState[];
  present: GraphState;
  future: GraphState[];
  /** True when `present` is mid-gesture and its "before" is already on `past`.
   *  Without this the first frame of a drag has nothing to fold into, so the
   *  whole gesture coalesces into nothing and the drag is not undoable. */
  coalescing?: boolean;
};

/** Cap on retained history. 50 undos is far past what anyone reaches for, and
 *  each entry holds a full graph copy. */
const LIMIT = 50;

export function initHistory(present: GraphState): History {
  return { past: [], present, future: [], coalescing: false };
}

/**
 * Structural signature — ids and connections only.
 *
 * Dragging a node fires a change per frame. Pushing each one would make undo
 * step backwards one pixel at a time, so a commit that changes nothing
 * structural is folded into the previous entry: one drag becomes one undo.
 */
function signature(state: GraphState): string {
  return JSON.stringify({
    n: state.nodes.map((x) => `${x.id}:${x.type}`).sort(),
    e: state.edges.map((x) => `${x.source}>${x.target}`).sort(),
  });
}

/** True when only positions/data differ — i.e. a drag or a field edit. */
function isCosmetic(a: GraphState, b: GraphState): boolean {
  return signature(a) === signature(b);
}

/**
 * Record a new state.
 *
 * `coalesce` folds the change into the current entry instead of pushing a new
 * one; callers pass it for continuous gestures. Structural changes (adding or
 * removing a node or edge) always push, even mid-gesture, so an accidental
 * delete is always one undo away.
 */
export function commit(history: History, next: GraphState, coalesce = false): History {
  if (JSON.stringify(next) === JSON.stringify(history.present)) return history;

  if (coalesce && isCosmetic(history.present, next)) {
    // Already mid-gesture: fold in, so the whole drag stays one undo.
    if (history.coalescing) return { ...history, present: next, future: [] };
    // First frame: push the pre-gesture state so there is something to undo to.
    return {
      past: [...history.past, history.present].slice(-LIMIT),
      present: next,
      future: [],
      coalescing: true,
    };
  }
  const past = [...history.past, history.present].slice(-LIMIT);
  return { past, present: next, future: [], coalescing: false };
}

export function undo(history: History): History {
  if (!history.past.length) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, LIMIT),
    coalescing: false,
  };
}

export function redo(history: History): History {
  if (!history.future.length) return history;
  return {
    past: [...history.past, history.present].slice(-LIMIT),
    present: history.future[0],
    future: history.future.slice(1),
    coalescing: false,
  };
}

export const canUndo = (h: History) => h.past.length > 0;
export const canRedo = (h: History) => h.future.length > 0;

// ── self-check ───────────────────────────────────────────────────────────────

function demo() {
  const n = (id: string, x = 0): Node =>
    ({ id, type: "specialistAgent", position: { x, y: 0 }, data: { label: id } }) as Node;
  const e = (s: string, t: string): Edge => ({ id: `${s}-${t}`, source: s, target: t }) as Edge;
  const st = (nodes: Node[], edges: Edge[] = []): GraphState => ({ nodes, edges });

  let h = initHistory(st([n("a")]));
  console.assert(!canUndo(h) && !canRedo(h), "a fresh history has nothing to undo or redo");

  // Adding a node is undoable, and undo restores exactly the prior state.
  h = commit(h, st([n("a"), n("b")]));
  console.assert(canUndo(h), "adding a node must be undoable");
  h = undo(h);
  console.assert(h.present.nodes.length === 1, "undo restores the previous graph");
  console.assert(canRedo(h), "undo must enable redo");
  h = redo(h);
  console.assert(h.present.nodes.length === 2, "redo reapplies the change");

  // A new commit clears the redo stack -- redoing onto a diverged branch would
  // silently resurrect work the user has already moved past.
  h = undo(h);
  h = commit(h, st([n("a"), n("c")]));
  console.assert(!canRedo(h), "a fresh commit clears redo");

  // Coalescing: a drag is one undo, not one per frame.
  let d = initHistory(st([n("a", 0)]));
  for (let x = 1; x <= 30; x++) d = commit(d, st([n("a", x)]), true);
  console.assert(d.past.length === 1, `a drag is one undo entry, got ${d.past.length}`);
  d = undo(d);
  console.assert(d.present.nodes[0].position.x === 0, "undoing a drag returns to the start");

  // A structural change still pushes even when coalesce is requested.
  let s2 = initHistory(st([n("a")]));
  s2 = commit(s2, st([n("a"), n("b")]), true);
  console.assert(s2.past.length === 1, "a structural change always pushes");

  // Edge changes are structural too.
  let s3 = initHistory(st([n("a"), n("b")]));
  s3 = commit(s3, st([n("a"), n("b")], [e("a", "b")]), true);
  console.assert(s3.past.length === 1, "adding an edge always pushes");

  // Identical commits are ignored, so undo never becomes a no-op step.
  let s4 = initHistory(st([n("a")]));
  s4 = commit(s4, st([n("a")]));
  console.assert(s4.past.length === 0, "an identical commit is ignored");

  // The cap holds and keeps the most recent entries.
  let cap = initHistory(st([n("a", 0)]));
  for (let i = 1; i <= 120; i++) cap = commit(cap, st([n("a", i), n(`x${i}`)]));
  console.assert(cap.past.length === LIMIT, `history caps at ${LIMIT}, got ${cap.past.length}`);

  // Undo past the start is a no-op rather than an error.
  let z = initHistory(st([n("a")]));
  console.assert(undo(z) === z, "undo with empty past returns the same history");
  console.assert(redo(z) === z, "redo with empty future returns the same history");

  console.log("graph-history self-check OK");
}

declare const process: { argv?: string[] } | undefined;
if (typeof process !== "undefined" && process?.argv?.[1]?.includes("graph-history")) demo();
