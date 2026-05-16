import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { requiredProvidersFromWorkflow } from '@/lib/integrations';
import { getWorkflowIntegrationStatus } from '@/lib/user-integrations';

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const prompt = String(body.prompt ?? '').trim();

  if (!prompt) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }

  const plannerRes = await fetch(`${req.nextUrl.origin}/api/planner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    cache: 'no-store',
  });

  const plannerPayload = await plannerRes.json().catch(() => null) as {
    result?: { n8nJson?: Record<string, unknown> };
    error?: string;
  } | null;

  if (!plannerRes.ok || !plannerPayload?.result?.n8nJson) {
    return NextResponse.json(
      { error: plannerPayload?.error ?? 'Failed to generate workflow' },
      { status: plannerRes.ok ? 500 : plannerRes.status }
    );
  }

  const workflow_json = plannerPayload.result.n8nJson;
  const integrationStatus = await getWorkflowIntegrationStatus(user.id, workflow_json);

  return NextResponse.json({
    success: true,
    workflow_json,
    required_integrations: requiredProvidersFromWorkflow(workflow_json),
    missing_integrations: integrationStatus.missing_integrations,
  });
}
