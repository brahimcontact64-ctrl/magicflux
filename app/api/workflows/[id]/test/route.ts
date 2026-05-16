import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { createSampleDataForWorkflow } from '@/lib/workflow-runtime';
import { runWorkflowExecution } from '@/lib/workflow-runtime/engine';
import { canExecuteWorkflow, getPlanLimits } from '@/lib/billing/plan-limits';

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
    return NextResponse.json({
      error: 'PLAN_LIMIT_REACHED',
      message: executionCheck.reason ?? `Your ${plan.name} plan reached its monthly execution limit.`,
      redirect: '/pricing',
    }, { status: 429 });
  }

  const body = await req.json().catch(() => ({})) as { sampleData?: unknown };
  const inputSampleData = body?.sampleData;
  const sampleData: Record<string, unknown> = (
    inputSampleData &&
    typeof inputSampleData === 'object' &&
    !Array.isArray(inputSampleData)
  )
    ? inputSampleData as Record<string, unknown>
    : {};

  const db = createServiceClient();
  const { data: workflow, error: workflowError } = await db
    .from('workflows')
    .select('id, name, workflow_json')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (workflowError) return NextResponse.json({ error: workflowError.message }, { status: 500 });
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  const raw = (workflow.workflow_json ?? {}) as WorkflowShape;
  if (!raw.nodes || !raw.connections) {
    return NextResponse.json({ error: 'Workflow JSON is incomplete' }, { status: 400 });
  }

  const effectiveSampleData =
    Object.keys(sampleData).length > 0
      ? sampleData
      : createSampleDataForWorkflow(raw);

  const result = await runWorkflowExecution({
    workflowJson: raw,
    inputData: effectiveSampleData,
    userId: user.id,
    workflowId: workflow.id,
    mode: 'test',
  });

  // Also persist a legacy workflow_run for backwards compat with history UI
  const legacySteps = result.steps.map((s) => ({
    nodeName: s.nodeName,
    nodeType: s.nodeType,
    status: s.status,
    input: s.inputData,
    output: s.outputData,
    logs: s.logs,
    error: s.error,
  }));

  await db
    .from('workflow_runs')
    .insert({
      workflow_id: workflow.id,
      user_id: user.id,
      status: result.status === 'success' || result.status === 'simulated_success' ? 'success' : 'failed',
      logs: legacySteps,
      previews: result.previews,
      final_output: result.finalOutput,
      error_message: result.error ?? null,
    });

  return NextResponse.json({
    success: result.status === 'success',
    status: result.status,
    message: result.message ?? (result.simulated ? 'Simulated only. No real API was called.' : 'Live execution completed.'),
    simulationMessage: result.simulated ? 'SIMULATED — no real API executed' : null,
    executionId: result.executionId,
    steps: legacySteps,
    finalOutput: result.finalOutput,
    previews: result.previews,
    error: result.error ?? null,
    nextRunAt: result.nextRunAt ?? null,
    simulated: result.simulated,
    warnings: result.warnings ?? [],
  });
}
