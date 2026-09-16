/**
 * Create Acknowledgment Challenge -- magicflux-nodes.createAcknowledgmentChallenge
 * (Phase 9.9.12A, Part I).
 *
 * Root problem this exists to fix: the original single-node
 * magicflux-nodes.waitForAcknowledgment design only creates its durable
 * row (and therefore its acknowledgment_url) the moment IT is dispatched.
 * In the natural reference topology "Airtable -> Gmail -> Slack -> Await
 * Acknowledgment", that node is positioned AFTER the notifications it's
 * meant to track -- so the acknowledgment_url does not exist yet when
 * Gmail/Slack render, and the very first (Level 0) notification can never
 * contain a working acknowledgment link. That is a real chicken-and-egg
 * gap, not a cosmetic one.
 *
 * This node is a small, NON-BLOCKING, single-output-port capability
 * (unlike waitForAcknowledgment, it never pauses/branches) that a workflow
 * places BEFORE its notification nodes: it creates the SAME durable
 * workflow_acknowledgments row (via wait-for-acknowledgment.ts's shared
 * createChallengeRow(), so both topologies produce byte-identical rows)
 * and immediately continues, having written `acknowledgment_url` (and the
 * row's own id, under a configurable field name) into $json -- which every
 * downstream node, including the Gmail/Slack notifications AND a later
 * magicflux-nodes.waitForAcknowledgment node, can now safely reference.
 * The SLA clock (deadline_at) starts here, at creation time, exactly when
 * the business intends "the clock starts" to mean -- not artificially
 * delayed until whatever node happens to come after the notifications.
 *
 * A workflow using this node MUST place a waitForAcknowledgment node later
 * in the graph configured with the SAME challengeIdField this node writes
 * to (default "acknowledgment_challenge_id" on both) so it waits on this
 * exact row instead of creating a new one of its own.
 */

import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';
import { createServiceClient } from '@/lib/supabase-server';
import { createChallengeRow } from './wait-for-acknowledgment';

const DEFAULT_OUTPUT_ID_FIELD = 'acknowledgment_challenge_id';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

type Params = {
  slaMinutes: number;
  escalationLevel: number;
  outputIdField: string;
};

type ParamResult = { ok: true; params: Params } | { ok: false; error: string };

function parseParams(node: EngineNode): ParamResult {
  const raw = asRecord(node.parameters);

  const slaMinutesRaw = raw.slaMinutes;
  const slaMinutes = typeof slaMinutesRaw === 'number' ? slaMinutesRaw : Number(slaMinutesRaw);
  if (!Number.isFinite(slaMinutes) || slaMinutes <= 0) {
    return { ok: false, error: 'Create Acknowledgment Challenge: "slaMinutes" is required and must be a positive number -- the business\'s own SLA duration, never a hard-coded default.' };
  }

  const escalationLevelRaw = raw.escalationLevel;
  const escalationLevel = typeof escalationLevelRaw === 'number' && Number.isInteger(escalationLevelRaw) && escalationLevelRaw >= 0 ? escalationLevelRaw : 0;

  const outputIdField = typeof raw.outputIdField === 'string' && raw.outputIdField.trim() ? raw.outputIdField.trim() : DEFAULT_OUTPUT_ID_FIELD;

  return { ok: true, params: { slaMinutes, escalationLevel, outputIdField } };
}

export async function createAcknowledgmentChallengeHandler(
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
    logs.push('Create Acknowledgment Challenge: simulated in test mode -- no durable row created.');
    return {
      status: 'simulated_success',
      outputData: { ...data, [params.outputIdField]: 'test-challenge-id', acknowledgment_url: 'https://example.invalid/simulated-acknowledgment-link' },
      logs,
    };
  }

  const nodeId = String(node.id ?? node.name ?? '').trim();
  if (!context.userId || !context.workflowId || !context.executionId || !nodeId) {
    const error = 'Create Acknowledgment Challenge requires an active execution context (userId/workflowId/executionId).';
    logs.push(error);
    return { status: 'failed', outputData: null, logs, error };
  }

  const db = createServiceClient();

  const result = await createChallengeRow(db, {
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

  if (!result.ok) {
    logs.push(result.error);
    return { status: 'failed', outputData: null, logs, error: result.error };
  }

  logs.push(`Create Acknowledgment Challenge: created, deadline ${result.deadline.toISOString()} (SLA: ${params.slaMinutes} minute(s)) -- continuing immediately, never pauses.`);

  return {
    status: 'success',
    outputData: {
      ...data,
      [params.outputIdField]: result.id,
      // Never a secret in the confidentiality sense -- see
      // wait-for-acknowledgment.ts's own doc comment for why this is safe
      // to place directly in notification content.
      acknowledgment_url: result.url,
    },
    logs,
  };
}
