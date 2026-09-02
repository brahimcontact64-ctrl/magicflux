import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { createSampleDataForWorkflow } from '@/lib/workflow-runtime/sample-data';
import { runWorkflowExecution } from '@/lib/workflow-runtime/engine';
import { canExecuteWorkflow, getPlanLimits } from '@/lib/billing/plan-limits';
import { getWorkflowIntegrationStatus } from '@/lib/user-integrations';
import { redact, redactText } from '@/lib/security/redact';
import { classifyError } from '@/lib/security/safe-error';

type Ctx = { params: { id: string } };

type WorkflowShape = {
  nodes?: object[];
  connections?: object;
};

export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const executionCheck = await canExecuteWorkflow(user.id);
  if (!executionCheck.allowed) {
    const plan = await getPlanLimits(user.id);
    return NextResponse.json(
      {
        error: 'PLAN_LIMIT_REACHED',
        message: executionCheck.reason ?? `Your ${plan.name} plan reached its monthly execution limit.`,
        redirect: '/pricing',
      },
      { status: 429 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { sampleData?: unknown };
  const sampleData =
    body?.sampleData && typeof body.sampleData === 'object' && !Array.isArray(body.sampleData)
      ? (body.sampleData as Record<string, unknown>)
      : {};

  const db = createServiceClient();
  const { data: workflow, error: workflowError } = await db
    .from('workflows')
    .select('id, user_id, workflow_json')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (workflowError) {
    const safe = classifyError(workflowError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  const raw = (workflow.workflow_json ?? {}) as WorkflowShape;
  if (!raw.nodes || !raw.connections) {
    return NextResponse.json({ error: 'Workflow JSON is incomplete' }, { status: 400 });
  }

  const integrationStatus = await getWorkflowIntegrationStatus(user.id, raw);
  if (integrationStatus.missing_integrations.length > 0 || integrationStatus.invalid_integrations.length > 0) {
    const blocked = Array.from(
      new Set([...integrationStatus.missing_integrations, ...integrationStatus.invalid_integrations])
    );
    return NextResponse.json(
      {
        error: 'SETUP_REQUIRED',
        missingIntegrations: blocked,
        redirect: '/settings/integrations',
      },
      { status: 400 }
    );
  }

  const result = await runWorkflowExecution({
    workflowJson: raw,
    inputData:
      Object.keys(sampleData).length > 0
        ? sampleData
        : createSampleDataForWorkflow(raw),
    userId: user.id,
    workflowId: workflow.id,
    mode: 'live',
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

  // Phase 9.4.1: live mode makes real calls with real injected
  // credentials -- steps/finalOutput can contain genuinely live secret
  // values (a provider's actual response headers/body, an injected
  // Authorization header echoed back in a request preview, etc.), not
  // just user-typed placeholders as in test mode. Redacted before ever
  // leaving this route.
  const safeSteps = redact(result.steps.map((s) => ({
    ...s,
    // error/logs are free text -- redact()'s key-based matching can't
    // scrub embedded secrets in string content.
    logs: Array.isArray(s.logs) ? s.logs.map((line) => redactText(line, 500)) : s.logs,
    error: s.error ? redactText(s.error, 500) : s.error,
  })));
  const safeTopLevelError = result.error ? redactText(result.error, 500) : result.error;

  return NextResponse.json({
    success: result.status === 'success',
    executionId: result.executionId,
    status: result.status,
    message: result.message ?? 'Live execution completed.',
    currentNodeId: result.currentNodeId,
    nextRunAt: result.nextRunAt ?? null,
    error: safeTopLevelError ?? null,
    simulated: false,
    live: true,
    steps: safeSteps,
    finalOutput: redact(result.finalOutput),
  });
}
