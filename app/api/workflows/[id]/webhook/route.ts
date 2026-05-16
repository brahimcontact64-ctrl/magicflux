import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { runWorkflowExecution } from '@/lib/workflow-runtime/engine';
import { canExecuteWorkflow, getPlanLimits } from '@/lib/billing/plan-limits';
import { guardWebhookRequest, suspiciousExecutionScore } from '@/lib/runtime/webhook-security';

type Ctx = { params: { id: string } };

/**
 * POST /api/workflows/[id]/webhook
 *
 * Live entry point for webhook-triggered workflows.
 * Accepts any JSON body as input data and starts a live execution.
 *
 * No user auth required (public webhook), but the workflow must be deployed.
 * Security checks are enforced here: signature validation, replay prevention,
 * IP allowlist checks, and request-rate protection.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const db = createServiceClient();

  const { data: workflow, error: workflowError } = await db
    .from('workflows')
    .select('id, user_id, workflow_json, status')
    .eq('id', params.id)
    .maybeSingle();

  if (workflowError) {
    return NextResponse.json({ error: workflowError.message }, { status: 500 });
  }

  if (!workflow) {
    return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
  }

  if (workflow.status !== 'deployed') {
    return NextResponse.json(
      { error: 'Workflow is not deployed. Deploy first before triggering via webhook.' },
      { status: 422 }
    );
  }

  const rawBody = await req.text();

  let inputData: Record<string, unknown> = {};
  try {
    const contentType = req.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('application/json') && rawBody.trim().length > 0) {
      inputData = JSON.parse(rawBody) as Record<string, unknown>;
    } else if (rawBody.trim().length > 0) {
      inputData = { rawBody };
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const workflowJson = (workflow.workflow_json ?? {}) as Record<string, unknown>;
  const security = ((workflowJson.security ?? workflowJson.webhook_security ?? {}) as Record<string, unknown>);
  const allowlist = Array.isArray(security.ip_allowlist)
    ? security.ip_allowlist.map((item) => String(item)).filter(Boolean)
    : [];

  const secret = typeof security.webhook_secret === 'string'
    ? security.webhook_secret
    : (process.env.MAGICFLUX_WEBHOOK_SECRET ?? null);

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

  const result = await runWorkflowExecution({
    workflowJson: workflow.workflow_json,
    inputData,
    userId: workflow.user_id,
    workflowId: workflow.id,
    mode: 'live',
    idempotencyKey: `${workflow.id}:${signatureGuard.requestHash}`,
  });

  if (result.error?.startsWith('SETUP_REQUIRED:')) {
    const provider = result.error.split(':')[1] ?? null;
    return NextResponse.json(
      {
        executionId: result.executionId,
        status: 'failed',
        live: true,
        error: 'SETUP_REQUIRED',
        missingIntegrations: provider ? [provider] : [],
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    executionId: result.executionId,
    status: result.status,
    live: true,
    currentNodeId: result.currentNodeId,
    nextRunAt: result.nextRunAt ?? null,
    error: result.error ?? null,
  });
}
