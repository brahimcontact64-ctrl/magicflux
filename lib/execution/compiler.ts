/**
 * Workflow compiler — converts a WorkflowJson into a topologically-sorted
 * ExecutionPlan with cycle detection, orphan detection, and validation.
 */

import type { WorkflowExecutionPlan, PlanNode, PlanStep } from './plan-types';

// ─── Public input type (mirrors WorkflowJson structure) ───────────────────────

export interface CompilerInput {
  nodes: Array<{
    id?: string;
    name: string;
    type: string;
    parameters?: Record<string, unknown>;
  }>;
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
}

// ─── Trigger detection (mirrors workflow-validator rule) ──────────────────────

function isTriggerType(type: string): boolean {
  const lc = type.toLowerCase();
  return (
    lc.includes('trigger') ||
    lc.includes('webhook') ||
    lc.includes('manualtrigger')
  );
}

// ─── Compiler ─────────────────────────────────────────────────────────────────

export function compileWorkflow(input: CompilerInput): WorkflowExecutionPlan {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── 1. Guard: must have at least one node ──────────────────────────────────
  if (!input.nodes || input.nodes.length === 0) {
    return {
      steps: [],
      valid: false,
      errors: ['Workflow has no nodes.'],
      warnings: [],
      cycleNodeNames: [],
      orphanNodeNames: [],
    };
  }

  // ── 2. Index nodes by name ────────────────────────────────────────────────
  const nodeByName = new Map<string, PlanNode>();
  for (const n of input.nodes) {
    if (!n.name || !n.type) {
      errors.push(`Node missing name or type: ${JSON.stringify(n)}`);
      continue;
    }
    nodeByName.set(n.name, {
      id:         n.id ?? n.name,
      name:       n.name,
      type:       n.type,
      parameters: n.parameters ?? {},
    });
  }

  const allNames = [...nodeByName.keys()];

  // ── 3. Build adjacency lists ───────────────────────────────────────────────
  // outEdges[A] = [B, C, …] (A → B, A → C)
  // inEdges[B]  = [A] (who points to B)

  const outEdges = new Map<string, string[]>(allNames.map((n) => [n, []]));
  const inEdges  = new Map<string, string[]>(allNames.map((n) => [n, []]));

  for (const [sourceName, conn] of Object.entries(input.connections)) {
    if (!nodeByName.has(sourceName)) {
      warnings.push(`Connection source "${sourceName}" not found in node list — ignored.`);
      continue;
    }
    for (const port of conn.main) {
      for (const entry of port) {
        const targetName = entry.node;
        if (!nodeByName.has(targetName)) {
          warnings.push(`Connection target "${targetName}" not found in node list — ignored.`);
          continue;
        }
        outEdges.get(sourceName)!.push(targetName);
        inEdges.get(targetName)!.push(sourceName);
      }
    }
  }

  // ── 4. Kahn's topological sort ────────────────────────────────────────────

  const inDegree = new Map<string, number>();
  for (const name of allNames) {
    inDegree.set(name, inEdges.get(name)!.length);
  }

  const queue: string[] = allNames.filter((n) => inDegree.get(n) === 0);
  const sorted: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const successor of outEdges.get(current) ?? []) {
      const newDegree = (inDegree.get(successor) ?? 1) - 1;
      inDegree.set(successor, newDegree);
      if (newDegree === 0) queue.push(successor);
    }
  }

  // ── 5. Cycle detection ───────────────────────────────────────────────────

  const cycleNodeNames: string[] = [];
  if (sorted.length < allNames.length) {
    for (const name of allNames) {
      if (!sorted.includes(name)) {
        cycleNodeNames.push(name);
      }
    }
    errors.push(
      `Cycle detected involving: ${cycleNodeNames.join(', ')}. Workflows must be acyclic.`,
    );
    // Emit plan even with cycle so UI can still show what compiled
  }

  // ── 6. Trigger requirement ────────────────────────────────────────────────

  const hasTrigger = allNames.some((n) => isTriggerType(nodeByName.get(n)!.type));
  if (!hasTrigger) {
    errors.push('Workflow has no trigger node. Add a Webhook or Schedule trigger.');
  }

  // ── 7. Orphan detection ───────────────────────────────────────────────────

  const orphanNodeNames: string[] = [];
  for (const name of allNames) {
    const hasIn  = (inEdges.get(name)?.length ?? 0) > 0;
    const hasOut = (outEdges.get(name)?.length ?? 0) > 0;
    const isTrig = isTriggerType(nodeByName.get(name)!.type);
    if (!hasIn && !hasOut && !isTrig) {
      orphanNodeNames.push(name);
      warnings.push(`Node "${name}" is isolated — no connections and not a trigger.`);
    }
  }

  // ── 8. Disconnected branch detection (unreachable from any trigger) ───────

  const triggerNames = allNames.filter((n) => isTriggerType(nodeByName.get(n)!.type));
  if (triggerNames.length > 0) {
    const reachable = new Set<string>(triggerNames);
    const bfsQueue = [...triggerNames];
    while (bfsQueue.length > 0) {
      const cur = bfsQueue.shift()!;
      for (const succ of outEdges.get(cur) ?? []) {
        if (!reachable.has(succ)) {
          reachable.add(succ);
          bfsQueue.push(succ);
        }
      }
    }
    for (const name of allNames) {
      if (!reachable.has(name) && !orphanNodeNames.includes(name)) {
        warnings.push(
          `Node "${name}" is not reachable from any trigger — it forms a disconnected branch.`,
        );
      }
    }
  }

  // ── 9. Build plan steps ───────────────────────────────────────────────────

  // Include sorted nodes, then append cycle nodes at the end so UI still shows them.
  const orderedNames = [...sorted, ...cycleNodeNames];

  const steps: PlanStep[] = orderedNames
    .filter((name) => nodeByName.has(name))
    .map((name, idx) => ({
      stepIndex: idx + 1,
      node: nodeByName.get(name)!,
      dependsOn: inEdges.get(name) ?? [],
    }));

  return {
    steps,
    valid: errors.length === 0,
    errors,
    warnings,
    cycleNodeNames,
    orphanNodeNames,
  };
}
