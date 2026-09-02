import { NextRequest, NextResponse } from 'next/server';
import { classifyError } from '@/lib/security/safe-error';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { requiredProvidersFromWorkflow } from '@/lib/integrations';
import { runProPlanner } from '@/lib/ai-engine/pro-planner';

type Ctx = { params: { id: string } };

export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const { data: workflow, error: workflowError } = await db
    .from('workflows')
    .select('id, name, description, prompt')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (workflowError) {
    const safe = classifyError(workflowError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const prompt = String(body.prompt ?? workflow.prompt ?? '').trim();
  if (!prompt) return NextResponse.json({ error: 'prompt is required' }, { status: 400 });

  const apiKey = process.env.OPENAI_API_KEY;
  const mode = process.env.AI_PLANNER_MODE === 'openai' && apiKey ? 'openai' : 'deterministic';

  let planned;
  try {
    planned = await runProPlanner(prompt, { mode, apiKey: apiKey ?? undefined });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Regeneration failed';
    const status = message.includes('Unable to generate accurate workflow') ? 422 : 500;
    return NextResponse.json({ error: message }, { status });
  }

  const n8nJson = planned.plannerResult.n8nJson as unknown as Record<string, unknown>;
  const integrations = requiredProvidersFromWorkflow(n8nJson);

  const { data: updated, error: updateError } = await db
    .from('workflows')
    .update({
      name: planned.plannerResult.plan.title || workflow.name,
      description: planned.plannerResult.plan.description || workflow.description,
      prompt,
      workflow_json: n8nJson,
      integrations,
      status: 'draft',
      updated_at: new Date().toISOString(),
    })
    .eq('id', workflow.id)
    .eq('user_id', user.id)
    .select('id, user_id, name, description, prompt, workflow_json, integrations, status, n8n_workflow_id, created_at, updated_at')
    .maybeSingle();

  if (updateError) {
    const safe = classifyError(updateError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  return NextResponse.json({
    success: true,
    workflow: updated,
    plannerResult: planned.plannerResult,
    proPlanner: planned.proPlanner,
    generationAdjusted: planned.generationAdjusted,
    generationWarning: planned.generationWarning,
  });
}
