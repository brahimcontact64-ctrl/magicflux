/**
 * Phase 9.4.2 — derives an ordered, branch-aware sequence for the mobile
 * step-list editor from the exact same React Flow nodes/edges the desktop
 * canvas uses. Pure, read-only: never mutates or reinterprets the
 * underlying connections, only computes a display order over them.
 *
 * A node with two distinct outgoing ports (an if/condition node -- see
 * isConditionNodeType()/WorkflowNodeCard's port-0="Yes"/port-1="No"
 * convention, unchanged here) produces a branchLabel on the first entry of
 * each branch, so the mobile list can render:
 *   [Condition]
 *     Yes -> [Node A] -> [Node B]
 *     No  -> [Node C]
 * A node reachable from more than one place (branches reconverging, or any
 * other DAG shape beyond a simple tree) is rendered in full only the first
 * time it's reached; later references become a lightweight `reference`
 * entry pointing at it by name, rather than duplicating the full card or
 * looping forever on a malformed cyclic graph. Every node is guaranteed to
 * appear at least once -- nodes unreachable from any root (no incoming
 * edges) are appended at the end as `unreachable`, never silently dropped.
 */

import type { Node, Edge } from '@xyflow/react';
import type { WorkflowNodeData } from './types';

export type MobileOrderEntry =
  | { kind: 'step'; node: Node<WorkflowNodeData>; depth: number; branchLabel?: string }
  | { kind: 'reference'; targetNode: Node<WorkflowNodeData>; depth: number; branchLabel?: string }
  | { kind: 'unreachable'; node: Node<WorkflowNodeData> };

function outgoingByPort(edges: Edge[], nodeId: string): Edge[][] {
  const bySource = edges.filter((e) => e.source === nodeId);
  if (bySource.length === 0) return [];
  const maxPort = Math.max(
    0,
    ...bySource.map((e) => (e.sourceHandle === 'port-1' ? 1 : e.sourceHandle === 'port-0' ? 0 : 0)),
  );
  const ports: Edge[][] = Array.from({ length: maxPort + 1 }, () => []);
  for (const e of bySource) {
    const idx = e.sourceHandle === 'port-1' ? 1 : 0;
    ports[idx].push(e);
  }
  return ports;
}

export function computeMobileOrder(
  nodes: Node<WorkflowNodeData>[],
  edges: Edge[],
): MobileOrderEntry[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const hasIncoming = new Set(edges.map((e) => e.target));
  const roots = nodes.filter((n) => !hasIncoming.has(n.id));
  const startIds = (roots.length > 0 ? roots : nodes).map((n) => n.id);

  const entries: MobileOrderEntry[] = [];
  const rendered = new Set<string>();
  const ancestors = new Set<string>(); // cycle guard for a single DFS path

  function walk(nodeId: string, depth: number, branchLabel: string | undefined) {
    const node = nodeById.get(nodeId);
    if (!node) return;

    if (rendered.has(nodeId)) {
      entries.push({ kind: 'reference', targetNode: node, depth, branchLabel });
      return;
    }
    if (ancestors.has(nodeId)) {
      // Malformed cyclic graph -- do not loop forever. Represent as a
      // reference rather than crashing or hanging the UI.
      entries.push({ kind: 'reference', targetNode: node, depth, branchLabel });
      return;
    }

    rendered.add(nodeId);
    ancestors.add(nodeId);
    entries.push({ kind: 'step', node, depth, branchLabel });

    const ports = outgoingByPort(edges, nodeId);
    if (ports.length <= 1) {
      for (const e of ports[0] ?? []) walk(e.target, depth, undefined);
    } else {
      const labels = ['Yes', 'No'];
      ports.forEach((portEdges, portIdx) => {
        portEdges.forEach((e, i) => {
          walk(e.target, depth + 1, i === 0 ? (labels[portIdx] ?? `Branch ${portIdx + 1}`) : undefined);
        });
      });
    }

    ancestors.delete(nodeId);
  }

  for (const id of startIds) walk(id, 0, undefined);

  for (const n of nodes) {
    if (!rendered.has(n.id)) entries.push({ kind: 'unreachable', node: n });
  }

  return entries;
}
