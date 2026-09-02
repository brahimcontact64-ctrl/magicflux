import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { createSampleDataForWorkflow } from '@/lib/workflow-runtime/sample-data';
import { runWorkflowExecution } from '@/lib/workflow-runtime/engine';
import { canExecuteWorkflow, getPlanLimits } from '@/lib/billing/plan-limits';
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

  if (workflowError) {
    const safe = classifyError(workflowError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }
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

  // Also persist a legacy workflow_run for backwards compat with history UI.
  // Phase 9.4.1: this table (and the JSON response below) is pure
  // observability/display -- workflow_runs is never read back to drive
  // execution -- so both are built from a redact()ed copy. steps/previews/
  // finalOutput can legitimately contain a user's real node config
  // (headers, body, credentials) since this is a Test run of their own
  // workflow; nothing here is safe to show unredacted to the client, the
  // DB, or any log.
  const legacySteps = redact(result.steps.map((s) => ({
    nodeName: s.nodeName,
    nodeType: s.nodeType,
    status: s.status,
    input: s.inputData,
    output: s.outputData,
    // error/logs are free text, not keyed objects -- redact()'s key-based
    // matching can't scrub embedded secrets in string content, so each
    // goes through redactText() explicitly (same treatment as the
    // persistence boundary in runtime/runtime-state.ts).
    logs: (s.logs ?? []).map((line) => redactText(line, 500)),
    error: s.error ? redactText(s.error, 500) : s.error,
  })));
  const safePreviews = redact(result.previews);
  const safeFinalOutput = redact(result.finalOutput);
  const safeTopLevelError = result.error ? redactText(result.error, 500) : result.error;

  await db
    .from('workflow_runs')
    .insert({
      workflow_id: workflow.id,
      user_id: user.id,
      status: result.status === 'success' || result.status === 'simulated_success' ? 'success' : 'failed',
      logs: legacySteps,
      previews: safePreviews,
      final_output: safeFinalOutput,
      error_message: safeTopLevelError ?? null,
    });

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
  });
}
