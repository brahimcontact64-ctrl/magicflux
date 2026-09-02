import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { requiredProvidersFromWorkflow } from '@/lib/integrations';
import { canCreateWorkflow, getPlanLimits } from '@/lib/billing/plan-limits';
import { classifyError } from '@/lib/security/safe-error';

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const { data, error } = await db
    .from('workflows')
    .select('id, name, description, workflow_json, integrations, status, n8n_workflow_id, created_at, updated_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  return NextResponse.json({ success: true, workflows: data ?? [] });
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const planCheck = await canCreateWorkflow(user.id);
  if (!planCheck.allowed) {
    const plan = await getPlanLimits(user.id);
    return NextResponse.json({
      error: 'PLAN_LIMIT_REACHED',
      message: planCheck.reason,
      redirect: '/pricing',
    }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? '').trim();
  const description = String(body.description ?? '').trim();
  const prompt = String(body.prompt ?? '').trim();
  const workflowJson = (body.workflow_json ?? {}) as Record<string, unknown>;
  const integrations = requiredProvidersFromWorkflow(workflowJson);

  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  const db = createServiceClient();
  const { data, error } = await db
    .from('workflows')
    .insert({
      user_id: user.id,
      name,
      description,
      prompt,
      workflow_json: workflowJson,
      integrations,
      status: 'draft',
    })
    .select('id, name, description, workflow_json, integrations, status, n8n_workflow_id, created_at, updated_at')
    .maybeSingle();

  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  return NextResponse.json({ success: true, workflow: data }, { status: 201 });
}
