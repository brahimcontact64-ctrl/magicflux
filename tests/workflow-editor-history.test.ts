/**
 * Undo / Redo history management tests.
 *
 * Tests the pure history-stack logic extracted from WorkflowEditor.
 * No React, no DOM — just the data-structure behaviour.
 */

import { describe, it, expect } from 'vitest';
import { cloneNodes, cloneEdges, workflowJsonToRF } from '../lib/workflow-editor/convert';
import type { WorkflowJson } from '../lib/workflow-editor/types';
import type { Node, Edge } from '@xyflow/react';
import type { WorkflowNodeData } from '../lib/workflow-editor/types';

// ─── Pure history implementation (mirrors WorkflowEditor internals) ───────────

const MAX_HISTORY = 50;

interface Snapshot { nodes: Node<WorkflowNodeData>[]; edges: Edge[] }

class HistoryStack {
  private h: Snapshot[] = [];
  private idx = -1;

  get canUndo() { return this.idx > 0; }
  get canRedo() { return this.idx < this.h.length - 1; }
  get current() { return this.h[this.idx] ?? null; }
  get size() { return this.h.length; }

  push(nodes: Node<WorkflowNodeData>[], edges: Edge[]) {
    const next = this.h.slice(0, this.idx + 1);
    next.push({ nodes: cloneNodes(nodes), edges: cloneEdges(edges) });
    if (next.length > MAX_HISTORY) next.shift();
    this.h = next;
    this.idx = this.h.length - 1;
  }

  undo(): Snapshot | null {
    if (!this.canUndo) return null;
    this.idx--;
    return this.h[this.idx];
  }

  redo(): Snapshot | null {
    if (!this.canRedo) return null;
    this.idx++;
    return this.h[this.idx];
  }
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

function makeNodes(count: number): Node<WorkflowNodeData>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `node-${i}`,
    type: 'workflowNode' as const,
    position: { x: i * 260, y: 0 },
    data: { name: `Node ${i}`, nodeType: 'n8n-nodes-base.webhook', parameters: {} },
  }));
}

const EMPTY_EDGES: Edge[] = [];

// ═══════════════════════════════════════════════════════════════════════════
// Initial state
// ═══════════════════════════════════════════════════════════════════════════

describe('HistoryStack — initial state', () => {
  it('canUndo is false before any push', () => {
    const h = new HistoryStack();
    expect(h.canUndo).toBe(false);
  });

  it('canRedo is false before any push', () => {
    const h = new HistoryStack();
    expect(h.canRedo).toBe(false);
  });

  it('current is null before any push', () => {
    const h = new HistoryStack();
    expect(h.current).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Push behaviour
// ═══════════════════════════════════════════════════════════════════════════

describe('HistoryStack — push', () => {
  it('canUndo is false after first push (nothing to undo)', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    expect(h.canUndo).toBe(false);
  });

  it('canUndo is true after second push', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    h.push(makeNodes(2), EMPTY_EDGES);
    expect(h.canUndo).toBe(true);
  });

  it('canRedo is false right after a push', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    h.push(makeNodes(2), EMPTY_EDGES);
    expect(h.canRedo).toBe(false);
  });

  it('size grows with each push', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    h.push(makeNodes(2), EMPTY_EDGES);
    h.push(makeNodes(3), EMPTY_EDGES);
    expect(h.size).toBe(3);
  });

  it('current reflects most recent push', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    h.push(makeNodes(2), EMPTY_EDGES);
    expect(h.current!.nodes).toHaveLength(2);
  });

  it('snapshots are independent copies (mutation proof)', () => {
    const h = new HistoryStack();
    const nodes = makeNodes(2);
    h.push(nodes, EMPTY_EDGES);
    // Mutate source — should not affect history
    nodes[0].data.name = 'MUTATED';
    h.push(nodes, EMPTY_EDGES);
    const snap0 = h.undo()!;
    expect(snap0.nodes[0].data.name).not.toBe('MUTATED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Undo behaviour
// ═══════════════════════════════════════════════════════════════════════════

describe('HistoryStack — undo', () => {
  it('undo returns previous snapshot', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    h.push(makeNodes(2), EMPTY_EDGES);
    const snap = h.undo();
    expect(snap!.nodes).toHaveLength(1);
  });

  it('undo enables canRedo', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    h.push(makeNodes(2), EMPTY_EDGES);
    h.undo();
    expect(h.canRedo).toBe(true);
  });

  it('double undo returns two steps back', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    h.push(makeNodes(2), EMPTY_EDGES);
    h.push(makeNodes(3), EMPTY_EDGES);
    h.undo();
    const snap = h.undo();
    expect(snap!.nodes).toHaveLength(1);
  });

  it('undo at beginning returns null', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    const result = h.undo();
    expect(result).toBeNull();
  });

  it('canUndo is false after undoing to beginning', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    h.push(makeNodes(2), EMPTY_EDGES);
    h.undo();
    expect(h.canUndo).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Redo behaviour
// ═══════════════════════════════════════════════════════════════════════════

describe('HistoryStack — redo', () => {
  it('redo after undo returns the redone snapshot', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    h.push(makeNodes(2), EMPTY_EDGES);
    h.undo();
    const snap = h.redo();
    expect(snap!.nodes).toHaveLength(2);
  });

  it('canRedo is false after redo reaches end', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    h.push(makeNodes(2), EMPTY_EDGES);
    h.undo();
    h.redo();
    expect(h.canRedo).toBe(false);
  });

  it('redo at end returns null', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    const result = h.redo();
    expect(result).toBeNull();
  });

  it('push after undo clears redo stack', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    h.push(makeNodes(2), EMPTY_EDGES);
    h.undo();
    h.push(makeNodes(3), EMPTY_EDGES); // branch — discards redo
    expect(h.canRedo).toBe(false);
  });

  it('push after undo creates correct new history', () => {
    const h = new HistoryStack();
    h.push(makeNodes(1), EMPTY_EDGES);
    h.push(makeNodes(2), EMPTY_EDGES);
    h.undo();
    h.push(makeNodes(99), EMPTY_EDGES);
    expect(h.current!.nodes).toHaveLength(99);
    expect(h.size).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 50-entry depth limit
// ═══════════════════════════════════════════════════════════════════════════

describe('HistoryStack — 50-entry depth limit', () => {
  it('does not exceed MAX_HISTORY (50)', () => {
    const h = new HistoryStack();
    for (let i = 0; i < 60; i++) h.push(makeNodes(i), EMPTY_EDGES);
    expect(h.size).toBeLessThanOrEqual(MAX_HISTORY);
  });

  it('still has the most recent entry after overflow', () => {
    const h = new HistoryStack();
    for (let i = 0; i < 60; i++) h.push(makeNodes(i), EMPTY_EDGES);
    expect(h.current!.nodes).toHaveLength(59);
  });

  it('canUndo is true after overflow', () => {
    const h = new HistoryStack();
    for (let i = 0; i < 60; i++) h.push(makeNodes(i), EMPTY_EDGES);
    expect(h.canUndo).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: convert → history
// ═══════════════════════════════════════════════════════════════════════════

describe('HistoryStack — integration with converter', () => {
  function wf(name: string): WorkflowJson {
    return {
      name,
      nodes: [{ name: 'A', type: 'n8n-nodes-base.webhook' }],
      connections: {},
    };
  }

  it('workflow round-trips through history unchanged', () => {
    const { rfNodes, rfEdges } = workflowJsonToRF(wf('test'));
    const h = new HistoryStack();
    h.push(rfNodes, rfEdges);

    const snap = h.current!;
    expect(snap.nodes[0].data.name).toBe('A');
    expect(snap.nodes[0].data.nodeType).toBe('n8n-nodes-base.webhook');
  });

  it('three workflow states stored and navigated correctly', () => {
    const { rfNodes: n1 } = workflowJsonToRF(wf('v1'));
    const { rfNodes: n2 } = workflowJsonToRF({ ...wf('v2'), nodes: [{ name: 'B', type: 'n8n-nodes-base.slack' }] });
    const { rfNodes: n3 } = workflowJsonToRF({ ...wf('v3'), nodes: [{ name: 'A', type: 'n8n-nodes-base.webhook' }, { name: 'C', type: 'n8n-nodes-base.airtable' }] });

    const h = new HistoryStack();
    h.push(n1, []);
    h.push(n2, []);
    h.push(n3, []);

    // current = n3
    expect(h.current!.nodes).toHaveLength(2);
    // undo → n2
    const s2 = h.undo()!;
    expect(s2.nodes[0].data.name).toBe('B');
    // undo → n1
    const s1 = h.undo()!;
    expect(s1.nodes[0].data.name).toBe('A');
    // redo → n2
    const s2b = h.redo()!;
    expect(s2b.nodes[0].data.name).toBe('B');
  });
});
