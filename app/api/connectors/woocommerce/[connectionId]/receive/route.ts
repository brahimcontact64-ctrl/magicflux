/**
 * Phase 9.9.22 -- the actual inbound receiver WooCommerce's webhook
 * subscription is configured to POST to. Public (no user session), the
 * SAME trust model as the generic /api/workflows/[id]/webhook route:
 * authenticity comes entirely from a verified provider signature, never
 * from anything client-supplied being trusted.
 *
 * Flow (Parts F/G/H/I/O): verify signature on the RAW body -> identify the
 * event (ack pings without dispatch) -> reject unsupported topics closed
 * -> normalize deterministically -> confirm the target workflow's
 * required trigger fields are satisfiable -> dispatch through the
 * EXISTING, unmodified dispatchProductionExecution() -- this route never
 * implements its own execution/runtime logic.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { isExecutableStatus } from '@/lib/workflow/lifecycle';
import { canExecuteWorkflow, getPlanLimits } from '@/lib/billing/plan-limits';
import { dispatchProductionExecution } from '@/lib/runtime/execution-dispatch';
import { deriveTriggerFields } from '@/lib/connection-guide/trigger-fields';
import { getConnectionById, getDecryptedWebhookSecret, updateConnectionHealth } from '@/lib/connectors/storage';
import { getConnector } from '@/lib/connectors/registry';

type Ctx = { params: { connectionId: string } };

const MAX_BODY_BYTES = 1024 * 1024; // 1MB, matching the generic webhook route's own cap

export async function POST(req: NextRequest, { params }: Ctx) {
  const declaredLength = Number(req.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  const connection = await getConnectionById(params.connectionId);
  if (!connection) {
    return NextResponse.json({ error: 'Unknown connection' }, { status: 404 });
  }

  const connector = getConnector(connection.platform);
  if (!connector) {
    return NextResponse.json({ error: 'Unsupported platform' }, { status: 404 });
  }

  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  const webhookSecret = await getDecryptedWebhookSecret(connection.id);
  if (!webhookSecret) {
    return NextResponse.json({ error: 'Connection is not fully configured' }, { status: 409 });
  }

  // Part F: signature verification runs against the RAW body -- never
  // parsed/re-serialized first, matching WooCommerce's own documented
  // requirement and the exact discipline the generic webhook route already
  // applies for its own HMAC scheme.
  const verifyResult = connector.verify({ rawBody, headers: req.headers, connection, webhookSecret });
  if (!verifyResult.ok) {
    await updateConnectionHealth(connection.id, { status: 'needs_attention', lastError: verifyResult.reason, errorCategory: 'invalid_signature' });
    return NextResponse.json({ error: verifyResult.reason }, { status: 401 });
  }

  const identity = connector.identifyEvent({ rawBody, headers: req.headers });
  if (!identity) {
    return NextResponse.json({ error: 'Could not identify event' }, { status: 400 });
  }

  if (identity.isPing) {
    // WooCommerce's own connectivity ping (sent on webhook creation/
    // activation) -- acknowledged, never normalized or dispatched.
    await updateConnectionHealth(connection.id, { status: 'connected', lastVerifiedAt: new Date().toISOString() });
    return NextResponse.json({ ok: true, ping: true });
  }

  const normalized = connector.normalize({ rawBody, headers: req.headers, connection, identity });
  if (!normalized) {
    // Part H: an unsupported/unrecognized topic fails closed -- acknowledged
    // (200, so the provider does not endlessly retry an event we will never
    // support) but never dispatched or mis-mapped.
    return NextResponse.json({ ok: true, skipped: true, reason: 'UNSUPPORTED_TOPIC' });
  }

  const db = createServiceClient();
  const { data: workflow } = await db
    .from('workflows')
    .select('id, user_id, status, workflow_json, active_deployment_version_id')
    .eq('id', connection.workflowId)
    .maybeSingle();

  if (!workflow) {
    return NextResponse.json({ error: 'Target workflow not found' }, { status: 404 });
  }
  if (!isExecutableStatus(workflow.status)) {
    return NextResponse.json({ error: 'Workflow is not active. Activate it before connecting a live platform event.' }, { status: 422 });
  }

  // Part I: confirm the target workflow's own required trigger fields
  // (derived from ITS json, never a hardcoded list -- reuses the Phase
  // 9.9.21 deriver) are satisfiable by this event's normalized data BEFORE
  // dispatching -- an actionable configuration error, never a malformed
  // execution.
  const workflowJsonToRun = workflow.active_deployment_version_id
    ? (await db.from('deployment_versions').select('workflow_data').eq('id', workflow.active_deployment_version_id).maybeSingle()).data?.workflow_data ?? workflow.workflow_json
    : workflow.workflow_json;
  const requiredFields = deriveTriggerFields(workflowJsonToRun).filter((f) => f.required).map((f) => f.name);
  const missingFields = requiredFields.filter((f) => {
    const v = normalized.normalizedData[f];
    return v === undefined || v === null || v === '';
  });

  if (missingFields.length > 0) {
    await updateConnectionHealth(connection.id, {
      status: 'needs_attention',
      lastError: `Event received but missing required field(s): ${missingFields.join(', ')}`,
      errorCategory: 'field_mapping',
    });
    return NextResponse.json(
      { error: 'MAPPING_INCOMPLETE', message: `This workflow expects field(s) not present in the WooCommerce event: ${missingFields.join(', ')}`, missingFields },
      { status: 422 },
    );
  }

  const executionCheck = await canExecuteWorkflow(workflow.user_id);
  if (!executionCheck.allowed) {
    const plan = await getPlanLimits(workflow.user_id);
    return NextResponse.json({ error: 'PLAN_LIMIT_REACHED', message: executionCheck.reason ?? `Your ${plan.name} plan reached its monthly execution limit.` }, { status: 429 });
  }

  // Part G: composite idempotency key, prefixed by connectionId (globally
  // unique, one tenant/workflow) exactly like the generic webhook route
  // prefixes by workflowId -- reuses the SAME atomic reservation inside
  // dispatchProductionExecution(), never a second/parallel dedup mechanism.
  const idempotencyKey = `connector:${connection.platform}:${connection.id}:${identity.eventIdSource}:${identity.eventId}`;

  const dispatch = await dispatchProductionExecution({
    userId: workflow.user_id,
    workflowId: workflow.id,
    deploymentVersionId: workflow.active_deployment_version_id ?? null,
    inputData: normalized.normalizedData,
    idempotencyKey,
  });

  if (!dispatch.ok) {
    const status = dispatch.code === 'ENQUEUE_FAILED' ? 503 : 429;
    return NextResponse.json({ error: dispatch.code, message: dispatch.message }, { status });
  }

  await updateConnectionHealth(connection.id, { status: 'connected', lastEventAt: new Date().toISOString(), lastError: null, errorCategory: null });

  if (dispatch.duplicate) {
    return NextResponse.json({ executionId: dispatch.executionId, status: dispatch.status, live: true, duplicate: true });
  }
  return NextResponse.json({ executionId: dispatch.executionId, status: dispatch.status, live: true }, { status: 202 });
}
