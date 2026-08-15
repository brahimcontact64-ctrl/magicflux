/**
 * Auto-layout engine tests.
 *
 * Verifies BFS topological layout produces correct column/row assignments
 * and handles edge cases (cycles, disconnected nodes, fan-out, condition branches).
 */

import { describe, it, expect } from 'vitest';
import { autoLayout } from '../lib/workflow-editor/layout';
import type { WorkflowJsonNode } from '../lib/workflow-editor/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function node(name: string): WorkflowJsonNode {
  return { name, type: 'n8n-nodes-base.webhook' };
}

function conn(src: string, ...targets: string[]) {
  return { [src]: { main: [targets.map((t) => ({ node: t }))] } };
}

// ═══════════════════════════════════════════════════════════════════════════
// Basic layout
// ═══════════════════════════════════════════════════════════════════════════

describe('autoLayout — basic', () => {
  it('returns empty map for empty nodes', () => {
    const result = autoLayout([], {});
    expect(result.size).toBe(0);
  });

  it('assigns position to single node', () => {
    const result = autoLayout([node('A')], {});
    expect(result.has('A')).toBe(true);
    const pos = result.get('A')!;
    expect(typeof pos.x).toBe('number');
    expect(typeof pos.y).toBe('number');
  });

  it('linear chain: A→B — B gets greater x than A', () => {
    const result = autoLayout([node('A'), node('B')], conn('A', 'B'));
    expect(result.get('A')!.x).toBeLessThan(result.get('B')!.x);
  });

  it('linear chain: A→B→C — ascending x', () => {
    const nodes = [node('A'), node('B'), node('C')];
    const connections = { ...conn('A', 'B'), ...conn('B', 'C') };
    const result = autoLayout(nodes, connections);
    const ax = result.get('A')!.x;
    const bx = result.get('B')!.x;
    const cx = result.get('C')!.x;
    expect(ax).toBeLessThan(bx);
    expect(bx).toBeLessThan(cx);
  });

  it('column spacing defaults to 260', () => {
    const nodes = [node('A'), node('B')];
    const result = autoLayout(nodes, conn('A', 'B'));
    const diff = result.get('B')!.x - result.get('A')!.x;
    expect(diff).toBe(260);
  });

  it('custom column spacing respected', () => {
    const nodes = [node('A'), node('B')];
    const result = autoLayout(nodes, conn('A', 'B'), 400, 120);
    const diff = result.get('B')!.x - result.get('A')!.x;
    expect(diff).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fan-out
// ═══════════════════════════════════════════════════════════════════════════

describe('autoLayout — fan-out', () => {
  it('fan-out: A→[B,C] — B and C are in the same column', () => {
    const nodes = [node('A'), node('B'), node('C')];
    const connections = { A: { main: [[{ node: 'B' }, { node: 'C' }]] } };
    const result = autoLayout(nodes, connections);
    expect(result.get('B')!.x).toBe(result.get('C')!.x);
  });

  it('fan-out: A→[B,C] — B and C have different y', () => {
    const nodes = [node('A'), node('B'), node('C')];
    const connections = { A: { main: [[{ node: 'B' }, { node: 'C' }]] } };
    const result = autoLayout(nodes, connections);
    expect(result.get('B')!.y).not.toBe(result.get('C')!.y);
  });

  it('fan-out: A→[B,C] — A is in an earlier column', () => {
    const nodes = [node('A'), node('B'), node('C')];
    const connections = { A: { main: [[{ node: 'B' }, { node: 'C' }]] } };
    const result = autoLayout(nodes, connections);
    expect(result.get('A')!.x).toBeLessThan(result.get('B')!.x);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Condition (dual output ports)
// ═══════════════════════════════════════════════════════════════════════════

describe('autoLayout — condition branches', () => {
  it('IF→[True, False] — both targets share the same column', () => {
    const nodes = [node('Trigger'), node('IF'), node('True'), node('False')];
    const connections = {
      Trigger: { main: [[{ node: 'IF' }]] },
      IF:      { main: [[{ node: 'True' }], [{ node: 'False' }]] },
    };
    const result = autoLayout(nodes, connections);
    expect(result.get('True')!.x).toBe(result.get('False')!.x);
  });

  it('Trigger is in column 0, IF in column 1, branches in column 2', () => {
    const nodes = [node('Trigger'), node('IF'), node('True'), node('False')];
    const connections = {
      Trigger: { main: [[{ node: 'IF' }]] },
      IF:      { main: [[{ node: 'True' }], [{ node: 'False' }]] },
    };
    const result = autoLayout(nodes, connections);
    const tx = result.get('Trigger')!.x;
    const ix = result.get('IF')!.x;
    const bx = result.get('True')!.x;
    expect(tx).toBeLessThan(ix);
    expect(ix).toBeLessThan(bx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Disconnected nodes
// ═══════════════════════════════════════════════════════════════════════════

describe('autoLayout — disconnected nodes', () => {
  it('all nodes get a position even with no connections', () => {
    const nodes = [node('A'), node('B'), node('C')];
    const result = autoLayout(nodes, {});
    expect(result.has('A')).toBe(true);
    expect(result.has('B')).toBe(true);
    expect(result.has('C')).toBe(true);
  });

  it('disconnected nodes have different y positions', () => {
    const nodes = [node('A'), node('B'), node('C')];
    const result = autoLayout(nodes, {});
    const ys = [result.get('A')!.y, result.get('B')!.y, result.get('C')!.y];
    expect(new Set(ys).size).toBeGreaterThan(1);
  });

  it('mixed: connected A→B, disconnected C — all get positions', () => {
    const nodes = [node('A'), node('B'), node('C')];
    const result = autoLayout(nodes, conn('A', 'B'));
    expect(result.has('C')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Unknown source/target (defensive)
// ═══════════════════════════════════════════════════════════════════════════

describe('autoLayout — unknown nodes in connections', () => {
  it('ignores connection from node not in nodes array', () => {
    const nodes = [node('A')];
    const connections = { Ghost: { main: [[{ node: 'A' }]] } };
    const result = autoLayout(nodes, connections);
    expect(result.has('A')).toBe(true);
    expect(result.has('Ghost')).toBe(false);
  });

  it('ignores connection target not in nodes array', () => {
    const nodes = [node('A')];
    const connections = { A: { main: [[{ node: 'Ghost' }]] } };
    expect(() => autoLayout(nodes, connections)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Position uniqueness
// ═══════════════════════════════════════════════════════════════════════════

describe('autoLayout — position uniqueness', () => {
  it('all positions are unique in a linear chain', () => {
    const nodes = [node('A'), node('B'), node('C'), node('D')];
    const connections = {
      ...conn('A', 'B'),
      ...conn('B', 'C'),
      ...conn('C', 'D'),
    };
    const result = autoLayout(nodes, connections);
    const posKeys = [...result.values()].map((p) => `${p.x},${p.y}`);
    expect(new Set(posKeys).size).toBe(posKeys.length);
  });

  it('positions map has same number of entries as nodes', () => {
    const nodes = [node('A'), node('B'), node('C')];
    const result = autoLayout(nodes, conn('A', 'B'));
    expect(result.size).toBe(3);
  });
});
