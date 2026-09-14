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
import { getUserIntegrations } from '@/lib/user-integrations';
import { canonicalizeProviderId } from '@/lib/integrations';

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

  // Phase 9.9.4E -- the ONE canonical, already-established provider lookup
  // (Phase 9.8.5 / 9.9.4B), the same one runtime execution
  // (resolveWorkflowIntegrations) and Airtable discovery
  // (getConnectedAirtableToken) already use -- never a raw, uncanonicalized
  // user_integrations query. Root cause this replaces: a raw query grouped
  // by user_integrations.provider AS STORED ('email', the legacy SMTP
  // connect flow's own literal value), while requiredProvidersFromWorkflow()
  // always reports the canonical 'gmail' for a real n8n-nodes-base.gmail
  // node -- so a genuinely connected 'email' credential was never listed
  // under the 'gmail' key the Builder UI actually looks up, showing "No
  // connected integrations" for a provider that was, in fact, connected.
  // getUserIntegrations() already canonicalizes at load time; never exposes
  // decrypted credentials here -- only id/name/attached are ever returned.
  const userIntegrations = await getUserIntegrations(user.id, { connectedOnly: true });

  // Get workflow_integrations (currently attached)
  const { data: attached, error: attachedError } = await db
    .from('workflow_integrations')
    .select('id, provider, integration_id')
    .eq('workflow_id', workflowId);

  if (attachedError) {
    const safe = classifyError(attachedError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  // Build response: group integrations by CANONICAL provider (already
  // canonicalized by getUserIntegrations(), applied again defensively here
  // so this route can never silently regress if that guarantee ever changes).
  const groupedByProvider = new Map<string, {
    integrationId: string;
    name: string | null;
    attached: boolean;
  }[]>();

  userIntegrations.forEach((integration) => {
    if (!integration.id) return;
    const canonicalProvider = canonicalizeProviderId(integration.provider);
    if (!groupedByProvider.has(canonicalProvider)) {
      groupedByProvider.set(canonicalProvider, []);
    }
    const isAttached = (attached ?? []).some(
      (a) => a.integration_id === integration.id && canonicalizeProviderId(a.provider) === canonicalProvider
    );
    groupedByProvider.get(canonicalProvider)!.push({
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
    attached: (attached ?? []).map((a) => ({ provider: canonicalizeProviderId(a.provider), integrationId: a.integration_id })),
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
  // Phase 9.9.4E -- compare CANONICAL provider identity (the same
  // canonicalizeProviderId() runtime resolution/Airtable discovery already
  // use), not the raw stored string -- a 'gmail'-required attach request
  // must accept a credential stored under the legacy 'email' alias, and
  // vice versa. A genuine mismatch (e.g. attaching a Slack credential as
  // "gmail") is still rejected.
  const canonicalRequested = canonicalizeProviderId(provider);
  if (canonicalizeProviderId(integration.provider) !== canonicalRequested) {
    return NextResponse.json({ error: 'Integration provider mismatch' }, { status: 400 });
  }

  // Upsert workflow_integration (one per provider) -- always stored under
  // the CANONICAL provider identity, so resolveWorkflowIntegrations()'s own
  // canonical lookup (lib/user-integrations.ts) and this table can never
  // disagree about which provider a row represents.
  const { data: attached, error: upsertError } = await db
    .from('workflow_integrations')
    .upsert({
      workflow_id: workflowId,
      user_id: user.id,
      integration_id: integrationId,
      provider: canonicalRequested,
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

  // Phase 9.9.4E -- delete by CANONICAL provider identity, matching how
  // POST now always stores it, and defensively covering any pre-existing
  // non-canonical row from before this fix.
  const canonicalProvider = canonicalizeProviderId(provider);
  const { error: deleteError } = await db
    .from('workflow_integrations')
    .delete()
    .eq('workflow_id', workflowId)
    .in('provider', Array.from(new Set([provider, canonicalProvider])))
    .eq('user_id', user.id);

  if (deleteError) {
    const safe = classifyError(deleteError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  return NextResponse.json({ success: true, provider });
}
