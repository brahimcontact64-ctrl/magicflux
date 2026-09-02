import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { canExecuteWorkflow, getPlanLimits } from '@/lib/billing/plan-limits';
import { guardWebhookRequest, suspiciousExecutionScore } from '@/lib/runtime/webhook-security';
import { isExecutableStatus } from '@/lib/workflow/lifecycle';
import { deriveWebhookIdempotencyKey } from '@/lib/runtime/idempotency';
import { dispatchProductionExecution } from '@/lib/runtime/execution-dispatch';
import { classifyError } from '@/lib/security/safe-error';

type Ctx = { params: { id: string } };

const MAX_WEBHOOK_BODY_BYTES = Number(process.env.RUNTIME_MAX_WEBHOOK_BODY_BYTES ?? 1024 * 1024); // 1MB

function methodAllowedByNode(workflowJson: unknown, requestMethod: string): boolean {
  const wf = (workflowJson ?? {}) as { nodes?: Array<Record<string, unknown>> };
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const webhookNodes = nodes.filter((n) => String(n.type ?? '').toLowerCase().includes('webhook') && !String(n.type ?? '').toLowerCase().includes('trigger.'));
  // No webhook trigger node found, or none specify a method — default-permissive (existing behavior).
  if (webhookNodes.length === 0) return true;
  return webhookNodes.some((n) => {
    const method = String((n.parameters as Record<string, unknown> | undefined)?.httpMethod ?? 'POST').toUpperCase();
    return method === requestMethod.toUpperCase();
  });
}

/**
 * POST /api/workflows/[id]/webhook
 *
 * Live entry point for webhook-triggered workflows.
 * Accepts any JSON body as input data and starts a live execution.
 *
 * No user auth required (public webhook), but the workflow must be active.
 * Security checks are enforced here: signature validation, replay prevention,
 * IP allowlist checks, and request-rate protection.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const db = createServiceClient();

  // Reject oversized payloads before ever reading the body, when the client
  // reports Content-Length honestly. req.text() below still enforces the
  // real limit even if a client lies about (or omits) Content-Length.
  const declaredLength = Number(req.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  const { data: workflow, error: workflowError } = await db
    .from('workflows')
    .select('id, user_id, workflow_json, status, active_deployment_version_id')
    .eq('id', params.id)
    .maybeSingle();

  if (workflowError) {
    const safe = classifyError(workflowError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  if (!workflow) {
    return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
  }

  if (!isExecutableStatus(workflow.status)) {
    return NextResponse.json(
      { error: 'Workflow is not active. Activate it before triggering via webhook.' },
      { status: 422 }
    );
  }

  // Resolve the FROZEN active version (if the workflow has been natively
  // activated) rather than the live, still-editable workflow_json — editing
  // a workflow must not change what an active webhook executes until the
  // owner re-activates it. Falls back to live workflow_json for workflows
  // deployed through the legacy external-n8n path only (no frozen version).
  let workflowJsonToRun = workflow.workflow_json;
  if (workflow.active_deployment_version_id) {
    const { data: version } = await db
      .from('deployment_versions')
      .select('workflow_data')
      .eq('id', workflow.active_deployment_version_id)
      .maybeSingle();
    if (version?.workflow_data) workflowJsonToRun = version.workflow_data;
  }

  if (!methodAllowedByNode(workflowJsonToRun, req.method)) {
    return NextResponse.json({ error: `Method ${req.method} not allowed by this workflow's webhook trigger` }, { status: 405 });
  }

  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  const queryParams: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => { queryParams[key] = value; });

  let inputData: Record<string, unknown> = { query: queryParams };
  try {
    const contentType = req.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('application/json') && rawBody.trim().length > 0) {
      inputData = { ...inputData, ...(JSON.parse(rawBody) as Record<string, unknown>) };
    } else if (rawBody.trim().length > 0) {
      inputData = { ...inputData, rawBody };
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const workflowJson = (workflowJsonToRun ?? {}) as Record<string, unknown>;
  const security = ((workflowJson.security ?? workflowJson.webhook_security ?? {}) as Record<string, unknown>);
  const allowlist = Array.isArray(security.ip_allowlist)
    ? security.ip_allowlist.map((item) => String(item)).filter(Boolean)
    : [];

  const secret = typeof security.webhook_secret === 'string'
    ? security.webhook_secret
    : (process.env.MAGICFLUX_WEBHOOK_SECRET ?? null);

  // Provider-native idempotency: Shopify's delivery ID > a generic
  // Idempotency-Key header > a deterministic body hash fallback. Derived
  // before the signature guard so the exact same key is available
  // regardless of which check runs first.
  const idempotency = deriveWebhookIdempotencyKey({
    workflowId: workflow.id,
    rawBody,
    headers: req.headers,
  });

  const signatureGuard = await guardWebhookRequest({
    workflowId: workflow.id,
    userId: workflow.user_id,
    rawBody,
    signature: req.headers.get('x-mf-signature') ?? req.headers.get('x-signature'),
    timestamp: req.headers.get('x-mf-timestamp') ?? req.headers.get('x-timestamp'),
    nonce: req.headers.get('x-mf-nonce') ?? req.headers.get('x-nonce'),
    ipAddress: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    secret,
    allowedIps: allowlist,
  });

  if (!signatureGuard.allowed) {
    return NextResponse.json(
      {
        error: signatureGuard.reason ?? 'Webhook rejected',
      },
      { status: 401 }
    );
  }

  const suspiciousScore = suspiciousExecutionScore(inputData);
  if (suspiciousScore >= 80) {
    await db.from('runtime_security_alerts').insert({
      user_id: workflow.user_id,
      workflow_id: workflow.id,
      alert_type: 'prompt_injection',
      severity: 'critical',
      score: suspiciousScore,
      details: {
        reason: 'Webhook payload blocked due to high-risk prompt-injection signature',
        requestHash: signatureGuard.requestHash,
      },
      created_at: new Date().toISOString(),
    });

    return NextResponse.json({ error: 'UNSAFE_PAYLOAD_DETECTED' }, { status: 400 });
  }

  const executionCheck = await canExecuteWorkflow(workflow.user_id);
  if (!executionCheck.allowed) {
    const plan = await getPlanLimits(workflow.user_id);
    return NextResponse.json(
      {
        error: 'PLAN_LIMIT_REACHED',
        message: executionCheck.reason ?? `Your ${plan.name} plan reached its monthly execution limit.`,
      },
      { status: 429 }
    );
  }

  // Async dispatch: reserve idempotency + concurrency atomically, create the
  // execution row, enqueue onto the existing execution_queue, and return
  // immediately. The workflow itself runs on a worker (lib/runtime/worker.ts,
  // 'run_workflow_execution'), never inside this HTTP request — so a slow or
  // hanging workflow can no longer hold a webhook sender's connection open,
  // and SETUP_REQUIRED / provider failures are now discovered asynchronously
  // (visible via GET /api/executions/[id]) rather than in this response.
  const dispatch = await dispatchProductionExecution({
    userId: workflow.user_id,
    workflowId: workflow.id,
    deploymentVersionId: workflow.active_deployment_version_id ?? null,
    inputData,
    idempotencyKey: idempotency.key,
  });

  if (!dispatch.ok) {
    const status = dispatch.code === 'ENQUEUE_FAILED' ? 503 : 429;
    return NextResponse.json({ error: dispatch.code, message: dispatch.message }, { status });
  }

  if (dispatch.duplicate) {
    return NextResponse.json({
      executionId: dispatch.executionId,
      status: dispatch.status,
      live: true,
      duplicate: true,
      message: 'An execution for this event was already triggered; returning the existing execution.',
    });
  }

  return NextResponse.json(
    {
      executionId: dispatch.executionId,
      status: dispatch.status,
      live: true,
      idempotencySource: idempotency.source,
    },
    { status: 202 }
  );
}
