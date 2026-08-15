/**
 * BFS topological auto-layout engine.
 *
 * Takes the name-based workflow graph and computes (x, y) positions for every
 * node.  Column = topological depth, row = order within that column.
 *
 * Returns a Map<nodeName, { x, y }> used by the conversion layer to set
 * React Flow node positions.
 */

import type { WorkflowJsonNode, NodeConnections } from './types';

export interface LayoutPosition {
  x: number;
  y: number;
}

const COL_SPACING = 260;
const ROW_SPACING = 120;

/**
 * Compute canvas positions via BFS topological ordering.
 *
 * Cycles are handled gracefully: if a node is encountered again at a greater
 * depth, its column is updated (latest-wins).  Unreachable / disconnected
 * nodes fall into column 0.
 */
export function autoLayout(
  nodes: WorkflowJsonNode[],
  connections: Record<string, NodeConnections>,
  colSpacing = COL_SPACING,
  rowSpacing = ROW_SPACING,
): Map<string, LayoutPosition> {
  if (nodes.length === 0) return new Map();

  const nameSet = new Set(nodes.map((n) => n.name));

  // Build adjacency (name → names[])
  const outgoing = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const n of nodes) {
    outgoing.set(n.name, []);
    inDegree.set(n.name, 0);
  }

  for (const [src, conn] of Object.entries(connections)) {
    if (!nameSet.has(src)) continue;
    const seen = new Set<string>();
    for (const port of conn.main) {
      for (const entry of port) {
        const tgt = entry.node;
        if (!nameSet.has(tgt) || seen.has(tgt)) continue;
        seen.add(tgt);
        outgoing.get(src)!.push(tgt);
        inDegree.set(tgt, (inDegree.get(tgt) ?? 0) + 1);
      }
    }
  }

  // BFS from start nodes (in-degree 0)
  const column = new Map<string, number>();
  const queue: Array<{ name: string; col: number }> = [];

  for (const n of nodes) {
    if ((inDegree.get(n.name) ?? 0) === 0) {
      queue.push({ name: n.name, col: 0 });
    }
  }

  // If every node has incoming edges (pure cycle), start from first node
  if (queue.length === 0 && nodes.length > 0) {
    queue.push({ name: nodes[0].name, col: 0 });
  }

  const visited = new Set<string>();

  while (queue.length > 0) {
    const { name, col } = queue.shift()!;

    // Allow column updates (for convergent graphs, take max depth)
    const prev = column.get(name) ?? -1;
    if (col <= prev) continue; // already placed at equal or greater depth
    column.set(name, col);

    if (visited.has(name)) continue;
    visited.add(name);

    for (const tgt of outgoing.get(name) ?? []) {
      queue.push({ name: tgt, col: col + 1 });
    }
  }

  // Disconnected nodes → column 0
  for (const n of nodes) {
    if (!column.has(n.name)) column.set(n.name, 0);
  }

  // Group by column, assign row order (maintain original node array order)
  const byColumn = new Map<number, string[]>();
  for (const n of nodes) {
    const col = column.get(n.name) ?? 0;
    if (!byColumn.has(col)) byColumn.set(col, []);
    byColumn.get(col)!.push(n.name);
  }

  const positions = new Map<string, LayoutPosition>();
  for (const [col, names] of byColumn.entries()) {
    // Vertically centre each column's nodes around y = 0
    const totalH = (names.length - 1) * rowSpacing;
    names.forEach((name, row) => {
      positions.set(name, {
        x: col * colSpacing,
        y: row * rowSpacing - totalH / 2,
      });
    });
  }

  return positions;
}
