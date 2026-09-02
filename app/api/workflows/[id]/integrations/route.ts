/**
 * Workflow Integrations API
 * 
 * GET /api/workflows/[id]/integrations
 * - List all available integrations for a workflow and which are attached
 * 
 * POST /api/workflows/[id]/integrations/attach
 * - Attach an integration to a workflow for a specific provider
 * { integrationId, provider }
 * 
 * DELETE /api/workflows/[id]/integrations/detach
 * - Detach an integration from a workflow
 * { provider }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { classifyError } from '@/lib/security/safe-error';

type Ctx = { params: { id: string } };

export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const workflowId = params.id;
  if (!workflowId) {
    return NextResponse.json({ error: 'workflowId is required' }, { status: 400 });
  }

  const db = createServiceClient();

  // Get workflow to verify ownership
  const { data: workflow, error: workflowError } = await db
    .from('workflows')
    .select('id, integrations')
    .eq('id', workflowId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (workflowError) {
    const safe = classifyError(workflowError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  // Get all user' integrations
  const { data: userIntegrations, error: integrationsError } = await db
    .from('user_integrations')
    .select('id, provider, name, status, created_at')
    .eq('user_id', user.id)
    .eq('status', 'connected')
    .order('created_at', { ascending: false });

  if (integrationsError) {
    const safe = classifyError(integrationsError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  // Get workflow_integrations (currently attached)
  const { data: attached, error: attachedError } = await db
    .from('workflow_integrations')
    .select('id, provider, integration_id')
    .eq('workflow_id', workflowId);

  if (attachedError) {
    const safe = classifyError(attachedError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  // Build response: group integrations by provider
  const groupedByProvider = new Map<string, {
    integrationId: string;
    name: string | null;
    attached: boolean;
  }[]>();

  (userIntegrations ?? []).forEach((integration) => {
    if (!groupedByProvider.has(integration.provider)) {
      groupedByProvider.set(integration.provider, []);
    }
    const isAttached = (attached ?? []).some(
      (a) => a.integration_id === integration.id && a.provider === integration.provider
    );
    groupedByProvider.get(integration.provider)!.push({
      integrationId: integration.id,
      name: integration.name || 'Default',
      attached: isAttached,
    });
  });

  // Convert to object format for easier frontend consumption
  const availableByProvider = Object.fromEntries(
    Array.from(groupedByProvider.entries()).map(([provider, integrations]) => [provider, integrations])
  );

  return NextResponse.json({
    success: true,
    workflowId,
    requiredProviders: (workflow.integrations ?? []) as string[],
    availableByProvider,
    attached: (attached ?? []).map((a) => ({ provider: a.provider, integrationId: a.integration_id })),
  });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const workflowId = params.id;
  if (!workflowId) {
    return NextResponse.json({ error: 'workflowId is required' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const integrationId = String(body.integrationId ?? '').trim();
  const provider = String(body.provider ?? '').trim();

  if (!integrationId || !provider) {
    return NextResponse.json({ error: 'integrationId and provider are required' }, { status: 400 });
  }

  const db = createServiceClient();

  // Verify workflow exists and belongs to user
  const { data: workflow, error: workflowError } = await db
    .from('workflows')
    .select('id')
    .eq('id', workflowId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (workflowError) {
    const safe = classifyError(workflowError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  // Verify integration exists, belongs to user, and is connected
  const { data: integration, error: integrationError } = await db
    .from('user_integrations')
    .select('id, provider, status')
    .eq('id', integrationId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (integrationError) {
    const safe = classifyError(integrationError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }
  if (!integration) {
    return NextResponse.json({ error: 'Integration not found' }, { status: 404 });
  }
  if (integration.status !== 'connected') {
    return NextResponse.json({ error: 'Integration is not connected' }, { status: 422 });
  }
  if (integration.provider !== provider) {
    return NextResponse.json({ error: 'Integration provider mismatch' }, { status: 400 });
  }

  // Upsert workflow_integration (one per provider)
  const { data: attached, error: upsertError } = await db
    .from('workflow_integrations')
    .upsert({
      workflow_id: workflowId,
      user_id: user.id,
      integration_id: integrationId,
      provider,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workflow_id,provider' })
    .select('id, provider, integration_id')
    .maybeSingle();

  if (upsertError) {
    const safe = classifyError(upsertError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  return NextResponse.json({
    success: true,
    attached: {
      id: attached?.id,
      provider: attached?.provider,
      integrationId: attached?.integration_id,
    },
  });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const workflowId = params.id;
  if (!workflowId) {
    return NextResponse.json({ error: 'workflowId is required' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const provider = String(body.provider ?? '').trim();

  if (!provider) {
    return NextResponse.json({ error: 'provider is required' }, { status: 400 });
  }

  const db = createServiceClient();

  // Verify workflow exists and belongs to user
  const { data: workflow, error: workflowError } = await db
    .from('workflows')
    .select('id')
    .eq('id', workflowId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (workflowError) {
    const safe = classifyError(workflowError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  // Delete workflow_integration for this provider
  const { error: deleteError } = await db
    .from('workflow_integrations')
    .delete()
    .eq('workflow_id', workflowId)
    .eq('provider', provider)
    .eq('user_id', user.id);

  if (deleteError) {
    const safe = classifyError(deleteError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  return NextResponse.json({ success: true, provider });
}
