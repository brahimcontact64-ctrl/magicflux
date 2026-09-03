/**
 * Phase 9.5.1A — pure, isolated capability filter for LLM-generated node
 * arrays, used by lib/agent/executor.ts's 'generate_workflow_json' tool
 * handler (the primary, LLM-driven canonical generation path -- the
 * /builder chat flow, via runAgentLoop -- which had NO node-capability
 * check at all before this fix, unlike lib/planner's deterministic path).
 *
 * Lives in its own file, separate from executor.ts, specifically so it's
 * directly unit-testable without pulling in executor.ts's heavy
 * module-level side effects (lib/graph/live-graph-manager.ts instantiates
 * a real Supabase client at import time). Uses the same authoritative
 * checkNodeCapability() every other path (planner, both validators,
 * runtime dispatch) already uses -- one source of truth, not a second
 * blocklist.
 */

import { checkNodeCapability } from '@/lib/workflow-runtime/node-capabilities';

export function findIncapableNodes(nodes: unknown): Array<{ name: string; reason: string; userMessage: string }> {
  return (Array.isArray(nodes) ? nodes : [])
    .map((node) => (node && typeof node === 'object' ? (node as Record<string, unknown>) : {}))
    .map((node) => {
      const capability = checkNodeCapability({ type: String(node.type ?? ''), parameters: node.parameters });
      return {
        name: typeof node.name === 'string' ? node.name : String(node.type ?? 'step'),
        capability,
      };
    })
    .filter((entry): entry is { name: string; capability: { capable: false; reason: string; userMessage: string } } => !entry.capability.capable)
    .map((entry) => ({ name: entry.name, reason: entry.capability.reason, userMessage: entry.capability.userMessage }));
}
