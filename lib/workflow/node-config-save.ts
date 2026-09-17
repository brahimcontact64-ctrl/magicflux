import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';
import { validateSupportedTemplateSyntax } from '@/lib/agent/template-expression-guard';
import { validateNotificationFieldAllowlist } from '@/lib/agent/notification-content-guard';
import { validateQualificationPolicyShape } from '@/lib/agent/qualification-policy-guard';
import { validateAirtableDedupeClaim } from '@/lib/agent/airtable-dedupe-guard';
import { validateSlaAcknowledgmentGating } from '@/lib/agent/sla-acknowledgment-gating-guard';

/**
 * Phase 9.9.16 -- Part B/L: the ONE canonical way every new node-level
 * configuration editor (AI policy, Human Review, notification content, SLA)
 * writes back into a workflow. Two structural guarantees this exists to
 * provide, so five separate PATCH routes don't each reinvent (and possibly
 * get wrong) the same two things:
 *
 * 1. Part B -- "one canonical source of workflow configuration truth": this
 *    reads and writes the EXACT SAME `workflows.workflow_json` column that
 *    the validator/activation/deployment/runtime pipeline already reads.
 *    There is no second config table a UI edit could drift from.
 *
 * 2. Part L -- optimistic concurrency: Phase 9.9.16's read-only audit of the
 *    existing PATCH /api/workflows/[id] and /api/workflows/[id]/airtable-
 *    config routes found BOTH do a blind read-then-write with no compare-
 *    and-swap, so a second editor's save can silently vanish. Every new
 *    route built on this helper requires the caller to pass back the
 *    `updatedAt` it most recently read, and the write is conditioned on
 *    `updated_at` still matching that value -- reusing the column that
 *    already exists (no migration needed). A lost race returns 409 with the
 *    CURRENT updated_at, never a silent overwrite.
 *
 * 3. Part D -- "server-side generation/activation guards remain
 *    authoritative": after the caller's `mutate()` produces a new node, the
 *    ENTIRE resulting node set is re-run through the exact same guards
 *    lib/workflow/lifecycle.ts runs at activation time, before anything is
 *    persisted. A UI that only validated client-side could otherwise persist
 *    a shape that would later fail activation with no clear link back to
 *    which edit caused it.
 */

type WorkflowRow = { id: string; user_id: string; workflow_json: unknown; updated_at: string };

export type NodeConfigSaveResult =
  | { ok: true; node: Record<string, unknown>; updatedAt: string }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 409; error: string; latestUpdatedAt: string | null };

export function asConfigRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Read-only load used by GET routes/panels that need the current draft + its updatedAt to hand back to a subsequent PATCH. */
export async function loadWorkflowForConfigEdit(userId: string, workflowId: string): Promise<WorkflowRow | null> {
  const db = createServiceClient();
  const { data } = await db
    .from('workflows')
    .select('id, user_id, workflow_json, updated_at')
    .eq('id', workflowId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as WorkflowRow | null) ?? null;
}

export async function patchWorkflowNode(params: {
  userId: string;
  workflowId: string;
  nodeId: string;
  expectedUpdatedAt: string;
  mutate: (node: Record<string, unknown>, allNodes: Record<string, unknown>[]) => { ok: true; node: Record<string, unknown> } | { ok: false; error: string };
}): Promise<NodeConfigSaveResult> {
  const db = createServiceClient();
  const { data } = await db
    .from('workflows')
    .select('id, user_id, workflow_json, updated_at')
    .eq('id', params.workflowId)
    .eq('user_id', params.userId)
    .maybeSingle();

  if (!data) return { ok: false, status: 404, error: 'Workflow not found.' };

  const workflowJson = asConfigRecord(data.workflow_json);
  const nodes = Array.isArray(workflowJson.nodes) ? [...(workflowJson.nodes as Record<string, unknown>[])] : [];
  const nodeIndex = nodes.findIndex((n) => String(n.id ?? n.name ?? '') === params.nodeId);
  if (nodeIndex === -1) return { ok: false, status: 404, error: `Node "${params.nodeId}" was not found in this workflow.` };

  const mutated = params.mutate(nodes[nodeIndex], nodes);
  if (!mutated.ok) return { ok: false, status: 400, error: mutated.error };
  nodes[nodeIndex] = mutated.node;

  const guardResults = [
    validateSupportedTemplateSyntax(nodes),
    validateNotificationFieldAllowlist(nodes),
    validateQualificationPolicyShape(nodes),
    validateAirtableDedupeClaim(nodes),
    validateSlaAcknowledgmentGating(nodes, workflowJson.connections),
  ];
  for (const r of guardResults) {
    if (!r.ok) return { ok: false, status: 400, error: r.reason };
  }

  const updatedWorkflowJson = { ...workflowJson, nodes };

  const { data: updated } = await db
    .from('workflows')
    .update({ workflow_json: updatedWorkflowJson, updated_at: new Date().toISOString() })
    .eq('id', params.workflowId)
    .eq('user_id', params.userId)
    .eq('updated_at', params.expectedUpdatedAt)
    .select('updated_at')
    .maybeSingle();

  if (!updated) {
    const { data: fresh } = await db.from('workflows').select('updated_at').eq('id', params.workflowId).eq('user_id', params.userId).maybeSingle();
    return {
      ok: false,
      status: 409,
      error: 'This workflow was changed elsewhere since you loaded it. Reload to see the latest version before saving again.',
      latestUpdatedAt: (fresh as { updated_at: string } | null)?.updated_at ?? null,
    };
  }

  return { ok: true, node: mutated.node, updatedAt: (updated as { updated_at: string }).updated_at };
}
