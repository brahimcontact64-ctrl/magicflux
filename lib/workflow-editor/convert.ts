/**
 * Bidirectional conversion between WorkflowJson (DB / runtime format) and
 * React Flow nodes + edges (visual editor format).
 *
 * Design invariants:
 *   • Connections in WorkflowJson always use node NAMES (runtime requirement).
 *   • React Flow edges use stable UUIDs (node.id) so renaming never breaks edges.
 *   • node.id is persisted back into WorkflowJson so round-trips are stable.
 *   • Nodes without id are auto-migrated (assigned a UUID) on first load.
 *   • Nodes without position get positions from the auto-layout engine.
 */

import type { Node, Edge } from '@xyflow/react';
import type { WorkflowJson, WorkflowJsonNode, WorkflowNodeData } from './types';
import { autoLayout } from './layout';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function newUUID(): string {
  // crypto.randomUUID is available in Node 14.17+ and all modern browsers.
  // Fallback for older environments (shouldn't be needed but kept safe).
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Node types that behave as IF/condition branches (2 output ports). */
const CONDITION_KEYWORDS = ['if', 'condition', 'switch', 'filter'] as const;

/** Provider exact types that must NOT be treated as condition nodes even if their
 *  type string accidentally contains a condition keyword (e.g. shopify ⊃ 'if'). */
const PROVIDER_EXACT_TYPES = new Set([
  'n8n-nodes-base.shopify',
  'n8n-nodes-base.shopifytrigger',
  'n8n-nodes-base.slack',
  'n8n-nodes-base.slacktrigger',
  'n8n-nodes-base.airtable',
  'n8n-nodes-base.airtabletrigger',
  'n8n-nodes-base.emailsend',
  'n8n-nodes-base.emailreadimap',
  'n8n-nodes-base.gmail',
  'n8n-nodes-base.gmailtrigger',
  'n8n-nodes-base.googledrive',
  'n8n-nodes-base.googledrivetrigger',
]);

export function isConditionNodeType(type: string): boolean {
  const lc = type.toLowerCase();
  if (PROVIDER_EXACT_TYPES.has(lc)) return false;
  return CONDITION_KEYWORDS.some((k) => lc.includes(k));
}

// ─── WorkflowJson → React Flow ────────────────────────────────────────────────

export interface ConvertToRFResult {
  rfNodes: Node<WorkflowNodeData>[];
  rfEdges: Edge[];
  /** True if any node was missing an id and got one auto-assigned. */
  migrated: boolean;
}

export function workflowJsonToRF(wf: WorkflowJson): ConvertToRFResult {
  let migrated = false;

  // Step 1: Ensure every node has a stable UUID.
  const nodesWithIds: Array<WorkflowJsonNode & { id: string }> = wf.nodes.map((n) => {
    if (n.id) return n as WorkflowJsonNode & { id: string };
    migrated = true;
    return { ...n, id: newUUID() };
  });

  // Step 2: Name → ID map (for building edges from name-based connections).
  const idByName = new Map<string, string>();
  for (const n of nodesWithIds) idByName.set(n.name, n.id);

  // Step 3: Positions — use stored positions if all nodes have them, otherwise auto-layout.
  const allHavePositions = nodesWithIds.every((n) => Array.isArray(n.position) && n.position.length === 2);
  const positions: Map<string, { x: number; y: number }> = allHavePositions
    ? new Map(nodesWithIds.map((n) => [n.name, { x: n.position![0], y: n.position![1] }]))
    : autoLayout(nodesWithIds, wf.connections);

  // Step 4: Build RF nodes.
  const rfNodes: Node<WorkflowNodeData>[] = nodesWithIds.map((n) => {
    const pos = positions.get(n.name) ?? { x: 0, y: 0 };
    return {
      id: n.id,
      type: 'workflowNode' as const,
      position: { x: pos.x, y: pos.y },
      data: {
        name: n.name,
        nodeType: n.type,
        parameters: n.parameters ?? {},
      },
    };
  });

  // Step 5: Build RF edges from name-based connections.
  const rfEdges: Edge[] = [];
  for (const [sourceName, conn] of Object.entries(wf.connections)) {
    const sourceId = idByName.get(sourceName);
    if (!sourceId) continue;

    for (let portIdx = 0; portIdx < conn.main.length; portIdx++) {
      const port = conn.main[portIdx];
      for (let targetIdx = 0; targetIdx < port.length; targetIdx++) {
        const targetName = port[targetIdx].node;
        const targetId = idByName.get(targetName);
        if (!targetId) continue;

        rfEdges.push({
          id: `${sourceId}→${targetId}:p${portIdx}:t${targetIdx}`,
          source: sourceId,
          target: targetId,
          sourceHandle: `port-${portIdx}`,
          targetHandle: 'in',
          type: 'smoothstep',
          animated: false,
        });
      }
    }
  }

  return { rfNodes, rfEdges, migrated };
}

// ─── React Flow → WorkflowJson ────────────────────────────────────────────────

export function rfToWorkflowJson(
  rfNodes: Node<WorkflowNodeData>[],
  rfEdges: Edge[],
  workflowName: string,
): WorkflowJson {
  // Map node UUID → current name (after any renames).
  const nameById = new Map<string, string>();
  for (const n of rfNodes) nameById.set(n.id, n.data.name);

  // Build persisted nodes (preserve id + position for stable round-trips).
  const nodes: WorkflowJsonNode[] = rfNodes.map((n) => ({
    id: n.id,
    name: n.data.name,
    type: n.data.nodeType,
    parameters: n.data.parameters ?? {},
    position: [Math.round(n.position.x), Math.round(n.position.y)] as [number, number],
  }));

  // Build connections (name-based for runtime compatibility).
  const connections: WorkflowJson['connections'] = {};

  for (const edge of rfEdges) {
    const sourceName = nameById.get(edge.source);
    const targetName = nameById.get(edge.target);
    if (!sourceName || !targetName) continue;

    // Determine port index from the source handle (port-0 = true/default, port-1 = false).
    const portIdx = edge.sourceHandle === 'port-1' ? 1 : 0;

    if (!connections[sourceName]) {
      connections[sourceName] = { main: [] };
    }
    while (connections[sourceName].main.length <= portIdx) {
      connections[sourceName].main.push([]);
    }
    connections[sourceName].main[portIdx].push({ node: targetName });
  }

  return { name: workflowName, nodes, connections };
}

// ─── Unique name generator ────────────────────────────────────────────────────

export function generateUniqueName(base: string, existingNames: string[]): string {
  if (!existingNames.includes(base)) return base;
  let i = 2;
  while (existingNames.includes(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

// ─── Snapshot cloning (for undo/redo history) ─────────────────────────────────

export function cloneNodes(nodes: Node<WorkflowNodeData>[]): Node<WorkflowNodeData>[] {
  return nodes.map((n) => ({
    ...n,
    position: { ...n.position },
    data: { ...n.data, parameters: { ...n.data.parameters } },
  }));
}

export function cloneEdges(edges: Edge[]): Edge[] {
  return edges.map((e) => ({ ...e }));
}
