import type { Edge, Node } from "@xyflow/react";

export const COL_GAP = 280;
export const ROW_GAP = 160;
const NODE_H = 120;

// ── topological layout — assigns column (depth) to each node ─────────────────
export function topoLayout(nodes: Node[], edges: Edge[]): { nodes: Node[]; colMap: Record<string, number> } {
  if (!nodes.length) return { nodes, colMap: {} };

  const inDegree: Record<string, number> = {};
  const children: Record<string, string[]> = {};
  for (const n of nodes) { inDegree[n.id] = 0; children[n.id] = []; }
  for (const e of edges) {
    if (inDegree[e.target] !== undefined) inDegree[e.target]++;
    if (children[e.source]) children[e.source].push(e.target);
  }

  const col: Record<string, number> = {};
  const queue = nodes.filter((n) => inDegree[n.id] === 0).map((n) => n.id);
  for (const id of queue) col[id] = 0;

  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    for (const child of children[id] ?? []) {
      col[child] = Math.max(col[child] ?? 0, (col[id] ?? 0) + 1);
      if (--inDegree[child] === 0) queue.push(child);
    }
  }
  for (const n of nodes) if (col[n.id] === undefined) col[n.id] = 0;

  const byCol: Record<number, string[]> = {};
  for (const n of nodes) { const c = col[n.id]; (byCol[c] = byCol[c] ?? []).push(n.id); }

  const pos: Record<string, { x: number; y: number }> = {};
  for (const [c, ids] of Object.entries(byCol)) {
    const colIdx = Number(c);
    const totalH = ids.length * NODE_H + (ids.length - 1) * (ROW_GAP - NODE_H);
    ids.forEach((id, row) => {
      pos[id] = { x: colIdx * COL_GAP, y: row * ROW_GAP - totalH / 2 + 200 };
    });
  }

  return {
    colMap: col,
    nodes: nodes.map((n) => ({ ...n, position: pos[n.id] ?? n.position })),
  };
}

// ── position generated subgraph right of its supervisor anchor ────────────────
// Runs topoLayout over the whole graph, then keeps every non-generated node at
// its existing position and translates generated nodes so their first column
// starts one COL_GAP right of the anchor, rows centred on the anchor.
export function layoutGeneratedSubgraph(allNodes: Node[], allEdges: Edge[], anchor: Node): Node[] {
  const generatedIds = new Set(
    allNodes.filter((n) => (n.data as Record<string, unknown>)?.generatedBy === anchor.id).map((n) => n.id),
  );
  if (!generatedIds.size) return allNodes;

  const { nodes: laid, colMap } = topoLayout(allNodes, allEdges);
  const laidById = new Map(laid.map((n) => [n.id, n]));

  const anchorCol = colMap[anchor.id] ?? 0;
  const anchorLaid = laidById.get(anchor.id);
  const dx = anchor.position.x + COL_GAP - (anchorCol + 1) * COL_GAP;
  const dy = anchor.position.y - (anchorLaid?.position.y ?? anchor.position.y);

  return allNodes.map((n) => {
    if (!generatedIds.has(n.id)) return n;
    const laidNode = laidById.get(n.id);
    if (!laidNode) return n;
    return { ...n, position: { x: laidNode.position.x + dx, y: laidNode.position.y + dy } };
  });
}
