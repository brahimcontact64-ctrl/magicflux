/**
 * Durable SLA Acknowledgment -- magicflux-nodes.waitForAcknowledgment
 * (Phase 9.9.12).
 *
 * The third real, reusable durable-pause capability alongside
 * magicflux-nodes.humanReview (Phase 9.9.2) and Wait (lib/workflow-runtime/
 * node-handlers/wait.ts) -- but genuinely different from both:
 *   - Human Review answers "what should the AI have decided instead" (a
 *     human OVERRIDES a judgment call). It deliberately has NO timer --
 *     see human-review.ts's own doc comment -- because there is no correct
 *     default decision to fall back to.
 *   - This node answers "has a human taken ownership of an ALREADY-DECIDED
 *     outcome before a deadline". Unlike Human Review, a timeout here IS a
 *     meaningful, correct outcome (escalate) -- so this node DOES set
 *     nextRunAt, reusing the EXACT SAME durable timer Wait nodes already
 *     use (lib/runtime/retry-dispatcher.ts's dispatchDueRetries(), which
 *     scans workflow_executions_v2 rows parked 'waiting' with a due
 *     next_run_at) -- no new scheduler/cron is introduced for the timeout
 *     side of this primitive.
 *
 * Why an in-process timer (setTimeout) would be unsafe here: a Vercel
 * serverless function's process does not persist between invocations at
 * all (a webhook request that dispatched this node may have already fully
 * exited before the SLA minutes elapse); a Railway worker process can
 * restart on deploy, crash, or be rescheduled by the platform at any time,
 * silently losing any in-memory timer with it. Only a value durably
 * persisted in the database (next_run_at here) and re-checked by an
 * independent, stateless poller survives all of: worker restart, Railway
 * restart, a Vercel redeploy, or a temporary scheduler outage (the next
 * poll tick simply catches up on whatever is now overdue).
 *
 * Only two ways this durable wait resolves (Part E) -- 'pending' ->
 * 'acknowledged' (a human acted before the deadline) XOR 'pending' ->
 * 'timed_out' (the deadline passed first) -- enforced by a
 * compare-and-swap UPDATE ... WHERE status = 'pending', the same pattern
 * already proven by workflow_review_items' decide route and the Phase
 * 9.9.11A side-effect ledger. Whichever transition's UPDATE actually
 * commits first in Postgres wins; the other's WHERE clause simply no
 * longer matches -- there is no in-memory race to reason about.
 */

import { randomBytes, createHash } from 'crypto';
import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';
import { createServiceClient } from '@/lib/supabase-server';

const DEFAULT_OUTPUT_FIELD = 'acknowledgment_status';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

type AckParams = {
  slaMinutes: number;
  outputField: string;
  escalationLevel: number;
};

type ParamResult = { ok: true; params: AckParams } | { ok: false; error: string };

function parseParams(node: EngineNode): ParamResult {
  const raw = asRecord(node.parameters);

  const slaMinutesRaw = raw.slaMinutes;
  const slaMinutes = typeof slaMinutesRaw === 'number' ? slaMinutesRaw : Number(slaMinutesRaw);
  if (!Number.isFinite(slaMinutes) || slaMinutes <= 0) {
    return { ok: false, error: 'Wait for Acknowledgment: "slaMinutes" is required and must be a positive number -- the business\'s own SLA duration, never a hard-coded default.' };
  }

  const outputField = typeof raw.outputField === 'string' && raw.outputField.trim() ? raw.outputField.trim() : DEFAULT_OUTPUT_FIELD;

  const escalationLevelRaw = raw.escalationLevel;
  const escalationLevel = typeof escalationLevelRaw === 'number' && Number.isInteger(escalationLevelRaw) && escalationLevelRaw >= 0 ? escalationLevelRaw : 0;

  return { ok: true, params: { slaMinutes, outputField, escalationLevel } };
}

/** SHA-256 hex digest -- the ONLY form of the acknowledgment token ever persisted (Part D/J). The plaintext exists only transiently in this function's return value and the notification content a downstream node may reference. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return randomBytes(32).toString('base64url'); // 256 bits of entropy -- unguessable (Part J).
}

function acknowledgmentUrl(id: string, token: string): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
  return `${site}/api/acknowledgments/${id}/ack?token=${token}`;
}

type AckRow = {
  id: string;
  status: 'pending' | 'acknowledged' | 'timed_out';
  deadline_at: string;
};

export async function waitForAcknowledgmentHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext,
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const data = asRecord(inputData);

  const parsed = parseParams(node);
  if (!parsed.ok) {
    return { status: 'failed', outputData: null, logs: [parsed.error], error: parsed.error };
  }
  const params = parsed.params;

  if (context.mode === 'test') {
    logs.push('Wait for Acknowledgment: simulated in test mode -- auto-acknowledged, no durable row created.');
    return {
      status: 'simulated_success',
      outputData: { ...data, [params.outputField]: 'acknowledged', _conditionBranch: 0 },
      logs,
    };
  }

  const nodeId = String(node.id ?? node.name ?? '').trim();
  if (!context.userId || !context.workflowId || !context.executionId || !nodeId) {
    const error = 'Wait for Acknowledgment requires an active execution context (userId/workflowId/executionId).';
    logs.push(error);
    return { status: 'failed', outputData: null, logs, error };
  }

  const db = createServiceClient();

  const { data: existing, error: lookupError } = await db
    .from('workflow_acknowledgments')
    .select('id, status, deadline_at')
    .eq('execution_id', context.executionId)
    .eq('node_id', nodeId)
    .maybeSingle();

  if (lookupError) {
    const error = 'Failed to look up the durable acknowledgment record.';
    logs.push(error);
    return { status: 'failed', outputData: null, logs, error };
  }

  const row = existing as AckRow | null;

  if (!row) {
    const deadline = new Date(Date.now() + params.slaMinutes * 60_000);
    const token = generateToken();
    const { error: insertError } = await db.from('workflow_acknowledgments').insert({
      user_id: context.userId,
      workflow_id: context.workflowId,
      execution_id: context.executionId,
      node_id: nodeId,
      node_name: node.name ?? null,
      deployment_version_id: context.deploymentVersionId ?? null,
      mode: context.mode,
      status: 'pending',
      deadline_at: deadline.toISOString(),
      escalation_level: params.escalationLevel,
      acknowledgment_token_hash: hashToken(token),
    });

    // A concurrent duplicate insert (two parallel dispatches of the same
    // node) fails the (execution_id, node_id) unique constraint -- treat
    // it the same as finding it via the lookup above, not as a real error.
    if (insertError && !String(insertError.message ?? '').toLowerCase().includes('duplicate')) {
      const error = 'Failed to create the durable acknowledgment record.';
      logs.push(error);
      return { status: 'failed', outputData: null, logs, error };
    }

    logs.push(`Wait for Acknowledgment: awaiting acknowledgment until ${deadline.toISOString()} (SLA: ${params.slaMinutes} minute(s)).`);

    // The id was just generated server-side (gen_random_uuid()) -- read it
    // back so the URL handed to any downstream reminder/escalation node is
    // the real one, never guessed.
    const { data: created } = await db
      .from('workflow_acknowledgments')
      .select('id')
      .eq('execution_id', context.executionId)
      .eq('node_id', nodeId)
      .maybeSingle();

    return {
      status: 'waiting',
      outputData: {
        ...data,
        // Never a secret in the sense of "must stay confidential from
        // everyone" -- this capability URL is specifically MEANT to be
        // delivered to the lead owner (e.g. in a reminder/escalation
        // notification); its security property is unguessability, not
        // confidentiality from its own intended recipient.
        acknowledgment_url: created?.id ? acknowledgmentUrl(String(created.id), token) : null,
      },
      logs,
      nextRunAt: deadline,
    };
  }

  if (row.status === 'acknowledged') {
    logs.push('Wait for Acknowledgment: already acknowledged -- continuing on the acknowledged branch.');
    return {
      status: 'success',
      outputData: { ...data, [params.outputField]: 'acknowledged', _conditionBranch: 0 },
      logs,
    };
  }

  if (row.status === 'timed_out') {
    logs.push('Wait for Acknowledgment: SLA already breached -- continuing on the escalation branch.');
    return {
      status: 'success',
      outputData: { ...data, [params.outputField]: 'timed_out', _conditionBranch: 1 },
      logs,
    };
  }

  // row.status === 'pending' -- resumed before or at the deadline.
  const deadline = new Date(row.deadline_at);
  if (Date.now() < deadline.getTime()) {
    // Resumed early (a manual resume, a retry-dispatcher timing edge) --
    // never transition ahead of the real deadline; re-park until it.
    logs.push(`Wait for Acknowledgment: resumed before the deadline (${deadline.toISOString()}) -- still awaiting acknowledgment.`);
    return { status: 'waiting', outputData: data, logs, nextRunAt: deadline };
  }

  // Deadline has passed and this row is still 'pending' -- attempt the
  // CAS transition to 'timed_out'. Guarded on status = 'pending' so a
  // concurrent acknowledgment landing at the same instant can never lose
  // to this, and vice versa (Part E).
  const { data: cas, error: casError } = await db
    .from('workflow_acknowledgments')
    .update({ status: 'timed_out', updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (casError) {
    const error = 'Failed to record the SLA timeout.';
    logs.push(error);
    return { status: 'failed', outputData: null, logs, error };
  }

  if (cas) {
    logs.push(`Wait for Acknowledgment: SLA breached at ${deadline.toISOString()} -- continuing on the escalation branch.`);
    return {
      status: 'success',
      outputData: { ...data, [params.outputField]: 'timed_out', _conditionBranch: 1 },
      logs,
    };
  }

  // Lost the CAS race -- a concurrent acknowledgment won at (essentially)
  // the same instant. Re-read the row's now-current, authoritative state
  // rather than assuming which side won.
  const { data: after } = await db
    .from('workflow_acknowledgments')
    .select('status')
    .eq('id', row.id)
    .maybeSingle();

  const finalStatus = (after as { status?: string } | null)?.status;
  logs.push(`Wait for Acknowledgment: lost the timeout race to a concurrent acknowledgment -- final status "${finalStatus}".`);
  return {
    status: 'success',
    outputData: { ...data, [params.outputField]: finalStatus === 'acknowledged' ? 'acknowledged' : 'timed_out', _conditionBranch: finalStatus === 'acknowledged' ? 0 : 1 },
    logs,
  };
}
