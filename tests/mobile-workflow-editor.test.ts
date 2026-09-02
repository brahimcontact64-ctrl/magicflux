/**
 * Phase 9.4.2 — mobile workflow editor regression tests.
 *
 * Focused on lib/workflow-editor/mobile-order.ts, the pure function behind
 * the mobile step list's branch-aware ordering -- the piece of this phase
 * where a defect would silently misrepresent or corrupt how a user
 * understands their workflow's real connections. No new DOM-testing stack
 * introduced (this codebase's vitest suite is entirely logic/API-level;
 * matching that convention rather than adding React Testing Library for a
 * single component).
 */

import { describe, it, expect } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import { computeMobileOrder } from '@/lib/workflow-editor/mobile-order';
import { workflowJsonToRF, rfToWorkflowJson } from '@/lib/workflow-editor/convert';
import type { WorkflowJson, WorkflowNodeData } from '@/lib/workflow-editor/types';

function node(id: string, name: string, nodeType = 'n8n-nodes-base.set'): Node<WorkflowNodeData> {
  return { id, type: 'workflowNode', position: { x: 0, y: 0 }, data: { name, nodeType, parameters: {} } };
}

function edge(id: string, source: string, target: string, sourceHandle = 'port-0'): Edge {
  return { id, source, target, sourceHandle, targetHandle: 'in', type: 'smoothstep' };
}

describe('computeMobileOrder()', () => {
  it('orders a simple linear workflow trigger -> A -> B', () => {
    const nodes = [node('a', 'Step A'), node('trig', 'Trigger'), node('b', 'Step B')];
    const edges = [edge('e1', 'trig', 'a'), edge('e2', 'a', 'b')];
    const order = computeMobileOrder(nodes, edges);
    const stepNames = order.filter((e) => e.kind === 'step').map((e) => (e as any).node.data.name);
    expect(stepNames).toEqual(['Trigger', 'Step A', 'Step B']);
  });

  it('represents an if/condition branch with Yes/No labels, mapped to the real port-0/port-1 connections', () => {
    const nodes = [node('trig', 'Trigger'), node('cond', 'Check status', 'n8n-nodes-base.if'), node('yes', 'Send success email'), node('no', 'Send failure alert')];
    const edges = [
      edge('e1', 'trig', 'cond'),
      edge('e2', 'cond', 'yes', 'port-0'), // Yes branch
      edge('e3', 'cond', 'no', 'port-1'),  // No branch
    ];
    const order = computeMobileOrder(nodes, edges);
    const steps = order.filter((e) => e.kind === 'step') as Array<{ kind: 'step'; node: Node<WorkflowNodeData>; branchLabel?: string }>;

    const yesEntry = steps.find((s) => s.node.data.name === 'Send success email');
    const noEntry = steps.find((s) => s.node.data.name === 'Send failure alert');
    expect(yesEntry?.branchLabel).toBe('Yes');
    expect(noEntry?.branchLabel).toBe('No');
    // both branches are present -- neither connection was silently dropped
    // or flattened into a fake linear sequence.
    expect(steps.map((s) => s.node.data.name)).toContain('Send success email');
    expect(steps.map((s) => s.node.data.name)).toContain('Send failure alert');
  });

  it('handles branches that reconverge on the same downstream node without duplicating or looping', () => {
    const nodes = [node('trig', 'Trigger'), node('cond', 'Check', 'n8n-nodes-base.if'), node('yes', 'Path A'), node('no', 'Path B'), node('join', 'Notify team')];
    const edges = [
      edge('e1', 'trig', 'cond'),
      edge('e2', 'cond', 'yes', 'port-0'),
      edge('e3', 'cond', 'no', 'port-1'),
      edge('e4', 'yes', 'join'),
      edge('e5', 'no', 'join'), // reconvergence -- both branches lead here
    ];
    const order = computeMobileOrder(nodes, edges);
    const stepEntries = order.filter((e) => e.kind === 'step');
    const referenceEntries = order.filter((e) => e.kind === 'reference');

    // "Notify team" is rendered in full exactly once (first reachable path)...
    expect(stepEntries.filter((e: any) => e.node.data.name === 'Notify team')).toHaveLength(1);
    // ...and referenced (not silently dropped) from the second branch.
    expect(referenceEntries.some((e: any) => e.targetNode.data.name === 'Notify team')).toBe(true);
  });

  it('never loops forever on a malformed cyclic graph', () => {
    const nodes = [node('a', 'A'), node('b', 'B')];
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')]; // cycle
    expect(() => computeMobileOrder(nodes, edges)).not.toThrow();
    const order = computeMobileOrder(nodes, edges);
    expect(order.length).toBeGreaterThan(0);
    expect(order.length).toBeLessThan(10); // did not runaway-recurse
  });

  it('a fully isolated node (no edges at all) is still shown, treated as its own root', () => {
    const nodes = [node('trig', 'Trigger'), node('a', 'Connected'), node('orphan', 'Orphan Step')];
    const edges = [edge('e1', 'trig', 'a')];
    const order = computeMobileOrder(nodes, edges);
    const stepNames = order.filter((e) => e.kind === 'step').map((e: any) => e.node.data.name);
    // A node with zero edges has no incoming edge either, so it's treated
    // as its own root and rendered directly -- never silently dropped.
    expect(stepNames).toContain('Orphan Step');
  });

  it('appends nodes unreachable from any root as `unreachable` (an isolated cycle disconnected from the real flow) rather than silently dropping them', () => {
    // trig -> a is the real flow. x <-> y is an isolated cycle with no
    // connection to it -- every node in it has an incoming edge (so
    // neither qualifies as a "root"), and no root's forward walk ever
    // reaches either.
    const nodes = [node('trig', 'Trigger'), node('a', 'Connected'), node('x', 'Isolated X'), node('y', 'Isolated Y')];
    const edges = [edge('e1', 'trig', 'a'), edge('e2', 'x', 'y'), edge('e3', 'y', 'x')];
    const order = computeMobileOrder(nodes, edges);
    const unreachable = order.filter((e) => e.kind === 'unreachable').map((e: any) => e.node.data.name);
    expect(unreachable).toEqual(expect.arrayContaining(['Isolated X', 'Isolated Y']));
  });

  it('does not mutate the input nodes/edges arrays', () => {
    const nodes = [node('trig', 'Trigger'), node('a', 'A')];
    const edges = [edge('e1', 'trig', 'a')];
    const nodesSnapshot = JSON.parse(JSON.stringify(nodes));
    const edgesSnapshot = JSON.parse(JSON.stringify(edges));
    computeMobileOrder(nodes, edges);
    expect(nodes).toEqual(nodesSnapshot);
    expect(edges).toEqual(edgesSnapshot);
  });

  it('falls back to array order when no node has zero incoming edges (e.g. all nodes are isolated)', () => {
    const nodes = [node('a', 'A'), node('b', 'B')];
    const order = computeMobileOrder(nodes, []);
    expect(order.filter((e) => e.kind === 'step')).toHaveLength(2);
  });
});

describe('mobile ordering stays consistent with the canonical WorkflowJson <-> React Flow round-trip', () => {
  it('a branching WorkflowJson converted to RF, reordered for mobile, and converted back produces identical connections', () => {
    const wf: WorkflowJson = {
      name: 'Branch test',
      nodes: [
        { id: 'trig', name: 'Trigger', type: 'n8n-nodes-base.manualtrigger', position: [0, 0] },
        { id: 'cond', name: 'Check', type: 'n8n-nodes-base.if', position: [200, 0] },
        { id: 'yes', name: 'Yes Path', type: 'n8n-nodes-base.set', position: [400, -50] },
        { id: 'no', name: 'No Path', type: 'n8n-nodes-base.set', position: [400, 50] },
      ],
      connections: {
        Trigger: { main: [[{ node: 'Check' }]] },
        Check: { main: [[{ node: 'Yes Path' }], [{ node: 'No Path' }]] },
      },
    };

    const { rfNodes, rfEdges } = workflowJsonToRF(wf);
    // Mobile ordering is purely a read/derived view -- computing it must not
    // alter the RF state that gets converted back to WorkflowJson.
    computeMobileOrder(rfNodes, rfEdges);
    const roundTripped = rfToWorkflowJson(rfNodes, rfEdges, wf.name);

    expect(roundTripped.connections.Trigger.main[0][0].node).toBe('Check');
    expect(roundTripped.connections.Check.main[0][0].node).toBe('Yes Path');
    expect(roundTripped.connections.Check.main[1][0].node).toBe('No Path');
  });
});
