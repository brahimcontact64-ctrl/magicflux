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

// Phase 9.9.4H -- root cause of "Builder shows Gmail as Attached with no
// workflow_integrations row": getUserFromRequest() reads the auth token off
// req.headers directly (a plain Request property access), never through
// next/headers' cookies()/headers() functions. On Next.js 13's App Router, a
// GET Route Handler is treated as static/cacheable UNLESS it calls one of
// those dynamic APIs or opts out explicitly -- this GET had neither, so
// Vercel's Full Route Cache could serve the SAME cached JSON body (captured
// from whichever request happened to populate the cache first, for ANY
// user) for every subsequent request to this exact URL, regardless of the
// caller's identity or any later attach/detach writes to the DB. That is
// exactly consistent with the reported symptom: the UI kept showing a prior
// "attached" snapshot while direct, repeated production reads confirmed no
// such row exists. This is the same directive already used by 8 other
// authenticated GET routes in this codebase for the same reason (e.g.
// app/api/conversation/route.ts, app/api/onboarding/status/route.ts) -- this
// route was simply missed. Forces per-request, per-user evaluation.
export const dynamic = 'force-dynamic';

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

  // Phase 9.9.4F -- root cause of the production "temporary_system_problem"
  // failure: workflow_integrations.provider has a live, un-migrated DB
  // CHECK constraint (workflow_integrations_provider_check) whose allowed
  // value list is ['email','shopify','slack','airtable','twilio','webhook']
  // -- it does NOT include 'gmail' at all. Phase 9.9.4E's fix stored the
  // CANONICAL requested provider ('gmail'), which the database itself then
  // rejected with a check_violation (Postgres SQLSTATE 23514) --
  // classifyError() maps any raw Postgres SQLSTATE to the generic
  // 'temporary_system_problem' code, which is exactly the message that
  // reached the UI. Storing 'gmail' would need a schema migration to add it
  // to the constraint; per this project's standing rule, no migration is
  // applied without stopping first to get it approved -- so this stores the
  // credential's own ALREADY-ALLOWED raw provider instead ('email' for a
  // legacy SMTP-connected credential), and every reader below canonicalizes
  // at comparison time instead of assuming the stored value is already
  // canonical. Functionally identical to storing 'gmail' from every
  // caller's perspective (GET already canonicalizes on the way out;
  // resolveWorkflowIntegrations() now does too, see lib/user-integrations.ts),
  // with zero schema risk.
  //
  // "One row per canonical provider per workflow" is enforced at the
  // application level here (rather than via the table's own
  // (workflow_id, provider) unique constraint, which only ever sees the raw
  // string) -- find any existing row for this workflow under ANY alias of
  // the requested canonical provider and update it in place; only insert a
  // new row when none exists.
  const { data: existingRows, error: existingError } = await db
    .from('workflow_integrations')
    .select('id, provider')
    .eq('workflow_id', workflowId)
    .eq('user_id', user.id);

  if (existingError) {
    const safe = classifyError(existingError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  const existingRow = (existingRows ?? []).find((row) => canonicalizeProviderId(String(row.provider)) === canonicalRequested);

  const rawProviderToStore = integration.provider; // Always the credential's OWN, already-constraint-valid raw label.
  type AttachedRow = { id: string; provider: string; integration_id: string };
  let attached: AttachedRow | null = null;
  let mutationError: unknown = null;

  if (existingRow) {
    const { data, error } = await db
      .from('workflow_integrations')
      .update({
        integration_id: integrationId,
        provider: rawProviderToStore,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingRow.id)
      .select('id, provider, integration_id')
      .maybeSingle();
    attached = data as AttachedRow | null;
    mutationError = error;
  } else {
    const { data, error } = await db
      .from('workflow_integrations')
      .insert({
        workflow_id: workflowId,
        user_id: user.id,
        integration_id: integrationId,
        provider: rawProviderToStore,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('id, provider, integration_id')
      .maybeSingle();
    attached = data as AttachedRow | null;
    mutationError = error;
  }

  if (mutationError) {
    const safe = classifyError(mutationError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  return NextResponse.json({
    success: true,
    attached: {
      id: attached?.id,
      provider: canonicalizeProviderId(String(attached?.provider ?? canonicalRequested)),
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

  // Phase 9.9.4F -- workflow_integrations.provider stores the credential's
  // OWN raw label (e.g. 'email'), not necessarily the canonical requested
  // provider (e.g. 'gmail') -- see the POST handler's comment for why. Match
  // by canonical equivalence in application code rather than filtering the
  // literal column value, so detaching "gmail" also removes a row stored as
  // "email", and vice versa.
  const canonicalProvider = canonicalizeProviderId(provider);
  const { data: candidateRows, error: candidateError } = await db
    .from('workflow_integrations')
    .select('id, provider')
    .eq('workflow_id', workflowId)
    .eq('user_id', user.id);

  if (candidateError) {
    const safe = classifyError(candidateError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  const idsToDelete = (candidateRows ?? [])
    .filter((row) => canonicalizeProviderId(String(row.provider)) === canonicalProvider)
    .map((row) => row.id);

  if (idsToDelete.length > 0) {
    const { error: deleteError } = await db
      .from('workflow_integrations')
      .delete()
      .in('id', idsToDelete);

    if (deleteError) {
      const safe = classifyError(deleteError);
      return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
    }
  }

  return NextResponse.json({ success: true, provider });
}
