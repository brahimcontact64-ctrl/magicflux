import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { requiredProvidersFromWorkflow } from '@/lib/integrations';

type Ctx = { params: { id: string } };

export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const { data, error } = await db
    .from('workflows')
    .select('id, user_id, name, description, prompt, workflow_json, integrations, status, n8n_workflow_id, deployed_at, created_at, updated_at')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  return NextResponse.json({ success: true, workflow: data });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.name !== undefined) patch.name = String(body.name ?? '').trim();
  if (body.description !== undefined) patch.description = String(body.description ?? '').trim();
  if (body.prompt !== undefined) patch.prompt = String(body.prompt ?? '');
  if (body.workflow_json !== undefined) {
    patch.workflow_json = body.workflow_json;
    patch.integrations = requiredProvidersFromWorkflow(body.workflow_json);
  }
  if (body.status !== undefined) {
    const nextStatus = String(body.status);
    if (nextStatus !== 'draft' && nextStatus !== 'deployed') {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
    patch.status = nextStatus;
  }

  const db = createServiceClient();
  const { data, error } = await db
    .from('workflows')
    .update(patch)
    .eq('id', params.id)
    .eq('user_id', user.id)
    .select('id, user_id, name, description, prompt, workflow_json, integrations, status, n8n_workflow_id, deployed_at, created_at, updated_at')
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  return NextResponse.json({ success: true, workflow: data });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const { error } = await db
    .from('workflows')
    .delete()
    .eq('id', params.id)
    .eq('user_id', user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
