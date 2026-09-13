/**
 * Phase 9.9.0 -- Complex Workflow Branching Integrity.
 *
 * Root cause (production investigation, lead-routing Hot/Warm/Cold/Uncertain
 * workflow): the generator produced a real n8n-nodes-base.if node with a
 * correct condition, but wired BOTH downstream fan-outs into the SAME
 * output-port array (connections[node].main[0]) instead of splitting them
 * across main[0] (true) and main[1] (false) -- using the *target* object's
 * `index` field (its own input port, irrelevant here) instead of encoding
 * the branch as the *source* array position. Combined with the runtime's
 * previous fallback behavior (fixed separately in runtime/workflow-engine.ts),
 * this made every classification execute identical downstream nodes.
 *
 * This is the deterministic, fail-closed backstop: it rejects a generated
 * graph before persistence whenever a conditional node's connections don't
 * structurally separate its output ports, so a graph that "looks correct"
 * (renders an arrow into every branch) can never reach persistence unless
 * the underlying wiring the certified runtime actually executes is
 * structurally correct too.
 *
 * Phase 9.9.3.1 -- the INVERSE defect, found via a real regeneration of the
 * lead-routing workflow this guard was originally built for: a
 * magicflux-nodes.aiClassifier node (genuinely non-branching -- see
 * ai-classifier.ts, which never sets _conditionBranch) was wired with TWO
 * separate output-port arrays (main[0] -> Airtable Save, main[1] -> Human
 * Review). The runtime's branch-dispatch fallback for
 * conditionBranch === null fires EVERY existing port -- correct for a
 * single-port node with multiple fanned-out targets, catastrophic here,
 * since it ran both downstream paths unconditionally for every lead. This
 * module now validates BOTH directions from the exact same
 * isConditionalNodeType() predicate used by handler routing
 * (lib/workflow-runtime/node-handlers/index.ts) and by generation checks
 * (lib/agent/ai-review-routing-guard.ts): a conditional node's ports must be
 * structurally separated (checked above), and a non-conditional node must
 * have AT MOST ONE output-port array -- multiple TARGETS inside that single
 * port (fan-out) remain completely valid.
 */

import { isConditionalNodeType } from '@/lib/workflow-runtime/node-capabilities';

export type BranchConnectionValidation =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      node: string;
      code: 'malformed_branch_connections' | 'malformed_non_branching_connections';
    };

type ConnectionEntryLike = { node?: unknown };
type NodeConnectionsLike = { main?: unknown };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Validates that every conditional (if/condition/switch/filter-routed) node
 * in the generated graph encodes its branches as separate output-port
 * arrays -- connections[node].main[0] and main[1] each present as their own
 * array (an empty array is fine; a missing/absent one is not), never
 * collapsed into a single port with multiple fanned-out targets.
 */
export function validateBranchConnections(nodes: unknown[], connections: unknown): BranchConnectionValidation {
  const nodeArray = Array.isArray(nodes) ? nodes : [];
  const connRecord = asRecord(connections);

  for (const rawNode of nodeArray) {
    if (!rawNode || typeof rawNode !== 'object') continue;
    const node = rawNode as Record<string, unknown>;
    const type = String(node.type ?? '');
    const name = String(node.name ?? node.id ?? '').trim();
    if (!name) continue;

    const nodeConnections = connRecord[name] as NodeConnectionsLike | undefined;
    const main = nodeConnections?.main;

    if (!isConditionalNodeType(type)) {
      // Phase 9.9.3.1 -- inverse check. A node that never produces
      // _conditionBranch must have AT MOST ONE output-port array: multiple
      // TARGETS inside that single port (fan-out) are still valid, but
      // multiple separate port arrays are only meaningful for a node that
      // has actually decided a branch -- see this module's header comment
      // for the exact production defect this rejects.
      if (Array.isArray(main) && main.length > 1) {
        return {
          ok: false,
          node: name,
          code: 'malformed_non_branching_connections',
          reason:
            `Node "${name}" (${type}) does not produce a branch decision (_conditionBranch) but is wired ` +
            `with ${main.length} separate output-port arrays. A non-branching node must have at most one ` +
            'output port -- if it needs to reach multiple downstream nodes, list every target inside that ' +
            'single main[0] array (fan-out), never split them across main[0]/main[1]/... as if this node ' +
            'could choose which port fires.',
        };
      }
      continue;
    }

    // No outgoing wiring at all for this conditional node -- nothing to
    // collapse, nothing to validate (a dead-end branch node is not this
    // guard's concern).
    if (main === undefined || (Array.isArray(main) && main.length === 0)) continue;

    if (!Array.isArray(main)) {
      return {
        ok: false,
        node: name,
        code: 'malformed_branch_connections',
        reason: `Conditional node "${name}" (${type}) has a malformed "main" connections value -- it must be an array of output-port arrays.`,
      };
    }

    if (main.length < 2) {
      return {
        ok: false,
        node: name,
        code: 'malformed_branch_connections',
        reason:
          `Conditional node "${name}" (${type}) collapses its branches into a single output port. ` +
          'True and false branches must each be their own entry in "main" (main[0] for true, main[1] ' +
          'for false), even if one branch has no downstream targets (an empty array), rather than ' +
          'putting every target in main[0] and relying on the target\'s own "index" field to encode ' +
          'which branch it belongs to.',
      };
    }

    for (const [portIndex, port] of main.entries()) {
      if (!Array.isArray(port)) {
        return {
          ok: false,
          node: name,
          code: 'malformed_branch_connections',
          reason: `Conditional node "${name}" (${type}) has a malformed output port at main[${portIndex}] -- each port must be an array (use [] for a branch with no downstream targets).`,
        };
      }
      for (const entry of port) {
        const target = (entry as ConnectionEntryLike | null | undefined)?.node;
        if (typeof target !== 'string' || !target.trim()) {
          return {
            ok: false,
            node: name,
            code: 'malformed_branch_connections',
            reason: `Conditional node "${name}" (${type}) has a malformed connection target at main[${portIndex}] -- every entry needs a valid "node" name.`,
          };
        }
      }
    }
  }

  return { ok: true };
}
