import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { createSampleDataForWorkflow } from '@/lib/workflow-runtime/sample-data';
import { runWorkflowExecution } from '@/lib/workflow-runtime/engine';
import { canExecuteWorkflow, getPlanLimits } from '@/lib/billing/plan-limits';
import { redact, redactText } from '@/lib/security/redact';
import { classifyError } from '@/lib/security/safe-error';

type WorkflowShape = {
  name?: string;
  nodes?: object[];
  connections?: object;
  settings?: object;
};

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const executionCheck = await canExecuteWorkflow(user.id);
  if (!executionCheck.allowed) {
    const plan = await getPlanLimits(user.id);
    return NextResponse.json({
      error: 'PLAN_LIMIT_REACHED',
      message: executionCheck.reason ?? `Your ${plan.name} plan reached its monthly execution limit.`,
      redirect: '/pricing',
    }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const workflowId = String(body.workflowId ?? '').trim();
  const inputSampleData = body?.sampleData;
  const sampleDataInput = (
    inputSampleData &&
    typeof inputSampleData === 'object' &&
    !Array.isArray(inputSampleData)
  )
    ? inputSampleData as Record<string, unknown>
    : {};

  if (!workflowId) {
    return NextResponse.json({ error: 'workflowId is required' }, { status: 400 });
  }

  const db = createServiceClient();
  const { data: workflow, error: workflowError } = await db
    .from('workflows')
    .select('id, name, workflow_json')
    .eq('id', workflowId)
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

  const sampleData = Object.keys(sampleDataInput).length > 0
    ? sampleDataInput
    : createSampleDataForWorkflow(raw);

  const result = await runWorkflowExecution({
    workflowJson: raw,
    inputData: sampleData,
    userId: user.id,
    workflowId: workflow.id,
    mode: 'test',
  });

  const legacySteps = redact(result.steps.map((s) => ({
    nodeName: s.nodeName,
    nodeType: s.nodeType,
    status: s.status,
    input: s.inputData,
    output: s.outputData,
    logs: (s.logs ?? []).map((line) => redactText(line, 500)),
    error: s.error ? redactText(s.error, 500) : s.error,
  })));
  const safePreviews = redact(result.previews);
  const safeFinalOutput = redact(result.finalOutput);
  const safeTopLevelError = result.error ? redactText(result.error, 500) : result.error;

  const { data: savedRun } = await db
    .from('workflow_runs')
    .insert({
      workflow_id: workflow.id,
      user_id: user.id,
      status: result.status === 'success' || result.status === 'simulated_success' ? 'success' : 'failed',
      logs: legacySteps,
      previews: safePreviews,
      final_output: safeFinalOutput,
      error_message: safeTopLevelError ?? null,
    })
    .select('id')
    .maybeSingle();

  return NextResponse.json({
    success: result.status === 'success',
    status: result.status,
    message: result.message ?? (result.simulated ? 'Simulated only. No real API was called.' : 'Live execution completed.'),
    simulationMessage: result.simulated ? 'SIMULATED — no real API executed' : null,
    executionId: result.executionId,
    steps: legacySteps,
    finalOutput: safeFinalOutput,
    previews: safePreviews,
    error: safeTopLevelError ?? null,
    nextRunAt: result.nextRunAt ?? null,
    simulated: result.simulated,
    warnings: result.warnings ?? [],
    runId: savedRun?.id ?? null,
  });
}
