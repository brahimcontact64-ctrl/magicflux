import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { requiredProvidersFromWorkflow } from '@/lib/integrations';
import { classifyError } from '@/lib/security/safe-error';

type Ctx = { params: { id: string } };

export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const { data, error } = await db
    .from('workflows')
    .select('id, user_id, name, description, prompt, workflow_json, integrations, status, n8n_workflow_id, deployed_at, created_at, updated_at, active_deployment_version_id, activated_at, deployment_error')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }
  if (!data) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  let deployedVersion: number | null = null;
  if (data.active_deployment_version_id) {
    const { data: version } = await db
      .from('deployment_versions')
      .select('version')
      .eq('id', data.active_deployment_version_id)
      .maybeSingle();
    deployedVersion = version?.version ?? null;
  }

  const { data: schedules } = await db
    .from('workflow_schedules')
    .select('id, node_id, node_name, schedule_type, cron_expression, interval_seconds, timezone, enabled, next_run_at, last_run_at, last_error')
    .eq('workflow_id', params.id)
    .eq('user_id', user.id);

  return NextResponse.json({ success: true, workflow: { ...data, deployed_version: deployedVersion }, schedules: schedules ?? [] });
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

  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }
  if (!data) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  return NextResponse.json({ success: true, workflow: data });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  // Phase 9.5 Step F: .select('id') after .delete() so we can tell a real
  // deletion apart from a no-op. Without it, a cross-tenant delete attempt
  // (someone else's workflow ID, or one that never existed) matched zero
  // rows -- not a DB error -- and this unconditionally reported
  // {success:true} anyway, unlike every sibling route on this resource
  // (GET/PATCH/integrations/test/lifecycle/... all correctly 404).
  const { data: deleted, error } = await db
    .from('workflows')
    .delete()
    .eq('id', params.id)
    .eq('user_id', user.id)
    .select('id');

  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  if (!deleted || deleted.length === 0) {
    return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
