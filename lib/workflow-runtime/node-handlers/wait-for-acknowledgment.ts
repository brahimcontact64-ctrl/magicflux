/**
 * Durable SLA Acknowledgment -- magicflux-nodes.waitForAcknowledgment
 * (Phase 9.9.12, topology fix Phase 9.9.12A Part I).
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
 *
 * Phase 9.9.12A -- Part I topology fix: the ORIGINAL single-node design
 * (this node creates its own row on first dispatch) has a real
 * chicken-and-egg gap -- if this node is positioned AFTER the Gmail/Slack
 * notifications it's meant to track (the natural reading of "Airtable ->
 * Gmail -> Slack -> Await Acknowledgment"), the acknowledgment_url does
 * not exist yet when those notifications are rendered, so the FIRST
 * (Level 0) notification can never contain a working acknowledgment link.
 * This node now ALSO supports referencing a challenge row created EARLIER
 * by magicflux-nodes.createAcknowledgmentChallenge (see that module) via
 * an explicit `$json[challengeIdField]` value flowing through the graph
 * (default field name "acknowledgment_challenge_id") -- when present, this
 * node looks up and waits on THAT already-created row (whose deadline
 * clock started at creation time, BEFORE the notifications ever sent)
 * instead of creating a new one under its own node_id. The original
 * self-contained, single-node behavior is COMPLETELY UNCHANGED and remains
 * the default when no upstream challenge id is present -- this is
 * additive, never a breaking change to the Phase 9.9.12 contract.
 */

import { randomBytes, createHash } from 'crypto';
import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';
import { createServiceClient } from '@/lib/supabase-server';
import { getPublicOrigin } from '@/lib/config/public-origin';

const DEFAULT_OUTPUT_FIELD = 'acknowledgment_status';
const DEFAULT_CHALLENGE_ID_FIELD = 'acknowledgment_challenge_id';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

type AckParams = {
  slaMinutes: number;
  outputField: string;
  escalationLevel: number;
  challengeIdField: string;
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

  const challengeIdField = typeof raw.challengeIdField === 'string' && raw.challengeIdField.trim() ? raw.challengeIdField.trim() : DEFAULT_CHALLENGE_ID_FIELD;

  return { ok: true, params: { slaMinutes, outputField, escalationLevel, challengeIdField } };
}

type AckRow = {
  id: string;
  status: 'pending' | 'acknowledged' | 'timed_out';
  deadline_at: string;
};

/**
 * Given an existing row (however it was found -- by this node's own
 * node_id, or by an upstream-created challenge id), decides the branch and
 * performs the timeout CAS if the deadline has passed. Shared by both
 * lookup modes so their resume/race/idempotency semantics can never drift
 * apart.
 */
async function resolveFromRow(
  db: ReturnType<typeof createServiceClient>,
  row: AckRow,
  data: Record<string, unknown>,
  params: AckParams,
  logs: string[],
): Promise<NodeHandlerResult> {
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

  // Phase 9.9.12A -- Part I: if an upstream createAcknowledgmentChallenge
  // node already created the row (its id flowing through $json), wait on
  // THAT row -- scoped by execution_id AND user_id so a value from an
  // unrelated tenant/execution can never be referenced. Never creates a
  // row in this mode; the challenge node is the sole source of truth.
  const referencedChallengeId = data[params.challengeIdField];
  if (typeof referencedChallengeId === 'string' && referencedChallengeId.trim()) {
    const { data: challengeRow, error: challengeLookupError } = await db
      .from('workflow_acknowledgments')
      .select('id, status, deadline_at')
      .eq('id', referencedChallengeId.trim())
      .eq('execution_id', context.executionId)
      .eq('user_id', context.userId)
      .maybeSingle();

    if (challengeLookupError) {
      const error = 'Failed to look up the referenced acknowledgment challenge.';
      logs.push(error);
      return { status: 'failed', outputData: null, logs, error };
    }
    if (!challengeRow) {
      const error = `Wait for Acknowledgment: no acknowledgment challenge found for $json["${params.challengeIdField}"] -- was createAcknowledgmentChallenge run earlier in this same execution?`;
      logs.push(error);
      return { status: 'failed', outputData: null, logs, error };
    }

    return resolveFromRow(db, challengeRow as AckRow, data, params, logs);
  }

  // Self-contained mode (Phase 9.9.12's original, unchanged default): this
  // node creates and owns its own row, keyed by its own node_id.
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
    const created = await createChallengeRow(db, {
      userId: context.userId,
      workflowId: context.workflowId,
      executionId: context.executionId,
      nodeId,
      nodeName: node.name ?? null,
      deploymentVersionId: context.deploymentVersionId ?? null,
      mode: context.mode,
      slaMinutes: params.slaMinutes,
      escalationLevel: params.escalationLevel,
    });

    if (!created.ok) {
      logs.push(created.error);
      return { status: 'failed', outputData: null, logs, error: created.error };
    }

    logs.push(`Wait for Acknowledgment: awaiting acknowledgment until ${created.deadline.toISOString()} (SLA: ${params.slaMinutes} minute(s)).`);
    return {
      status: 'waiting',
      outputData: { ...data, acknowledgment_url: created.url },
      logs,
      nextRunAt: created.deadline,
    };
  }

  return resolveFromRow(db, row, data, params, logs);
}

/** SHA-256 hex digest -- the ONLY form of the acknowledgment token ever persisted (Part D/J). The plaintext exists only transiently in this function's return value and the notification content a downstream node may reference. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return randomBytes(32).toString('base64url'); // 256 bits of entropy -- unguessable (Part J).
}

export function acknowledgmentUrl(id: string, token: string): string {
  // Incident 9.9.17E -- never a silent localhost fallback in production; see
  // lib/config/public-origin.ts. Takes no request object, so there is no
  // Host header (or anything else client-controlled) anywhere in this path
  // that could redirect a real customer's acknowledgment link.
  const site = getPublicOrigin();
  return `${site}/api/acknowledgments/${id}/ack?token=${token}`;
}

export type CreateChallengeResult =
  | { ok: true; id: string; url: string; deadline: Date }
  | { ok: false; error: string };

/**
 * Shared by both magicflux-nodes.waitForAcknowledgment's self-contained
 * mode and magicflux-nodes.createAcknowledgmentChallenge (Part I) -- the
 * ONE place a workflow_acknowledgments row is ever inserted, so both
 * topologies create rows with identical shape/guarantees.
 */
export async function createChallengeRow(
  db: ReturnType<typeof createServiceClient>,
  params: {
    userId: string;
    workflowId: string;
    executionId: string;
    nodeId: string;
    nodeName: string | null;
    deploymentVersionId: string | null;
    mode: 'test' | 'live';
    slaMinutes: number;
    escalationLevel: number;
  },
): Promise<CreateChallengeResult> {
  const deadline = new Date(Date.now() + params.slaMinutes * 60_000);
  const token = generateToken();

  const { error: insertError } = await db.from('workflow_acknowledgments').insert({
    user_id: params.userId,
    workflow_id: params.workflowId,
    execution_id: params.executionId,
    node_id: params.nodeId,
    node_name: params.nodeName,
    deployment_version_id: params.deploymentVersionId,
    mode: params.mode,
    status: 'pending',
    deadline_at: deadline.toISOString(),
    escalation_level: params.escalationLevel,
    acknowledgment_token_hash: hashToken(token),
  });

  // A concurrent duplicate insert (two parallel dispatches of the same
  // node) fails the (execution_id, node_id) unique constraint -- treat it
  // the same as finding it via a fresh lookup, not as a real error.
  if (insertError && !String(insertError.message ?? '').toLowerCase().includes('duplicate')) {
    return { ok: false, error: 'Failed to create the durable acknowledgment record.' };
  }

  // The id was just generated server-side (gen_random_uuid()) -- read it
  // back so the URL/challenge id handed to downstream nodes is the real
  // one, never guessed.
  const { data: created } = await db
    .from('workflow_acknowledgments')
    .select('id')
    .eq('execution_id', params.executionId)
    .eq('node_id', params.nodeId)
    .maybeSingle();

  if (!created?.id) {
    return { ok: false, error: 'Failed to read back the created acknowledgment record.' };
  }

  return { ok: true, id: String(created.id), url: acknowledgmentUrl(String(created.id), token), deadline };
}
