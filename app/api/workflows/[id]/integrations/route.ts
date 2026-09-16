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
import { canonicalizeProviderId, WORKFLOW_INTEGRATION_ALLOWED_RAW_PROVIDERS } from '@/lib/integrations';
import { getCredentialRowById, verifyProviderConnection } from '@/lib/credentials/storage';

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

  // Verify integration exists, belongs to user, and is connected. Tries the
  // legacy user_integrations table first (unchanged behavior for Airtable/
  // Slack/legacy-SMTP-email), then falls back to the canonical OAuth
  // credential store (Phase 9.9.8C) -- integrationId there is
  // integration_credentials' own real row id (see
  // lib/credentials/storage.ts's getCredentialRowId()/getCredentialRowById()),
  // an opaque, non-secret reference, never a token. Both lookups are scoped
  // by the AUTHENTICATED user's id in the query itself, so neither can ever
  // resolve another tenant's credential.
  type ResolvedIntegration = { id: string; provider: string; status: 'connected' | 'invalid' | 'not_connected' };
  let integration: ResolvedIntegration | null = null;
  {
    const { data, error } = await db
      .from('user_integrations')
      .select('id, provider, status')
      .eq('id', integrationId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) {
      const safe = classifyError(error);
      return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
    }
    if (data) integration = data as ResolvedIntegration;
  }

  if (!integration) {
    // Phase 9.9.8C -- the canonical OAuth credential path. A Gmail (or any
    // other OAuth-bridged provider) connection lives in integration_credentials,
    // never user_integrations, so it was previously invisible to this route
    // entirely -- Settings correctly showed "Connected via Google OAuth"
    // while the workflow-attachment selector showed "No connected
    // integrations" for the exact same credential.
    let credRow: Awaited<ReturnType<typeof getCredentialRowById>> = null;
    try {
      credRow = await getCredentialRowById(user.id, integrationId);
    } catch {
      credRow = null;
    }
    if (credRow) {
      // Re-verify genuinely connected RIGHT NOW (never trust mere row
      // existence) -- the same authoritative check Settings/discovery use.
      // Fails closed if the credential was since revoked/deleted.
      const status = await verifyProviderConnection(user.id, credRow.provider).catch(() => ({ connected: false, missing: [] as string[] }));
      if (status.connected) {
        integration = { id: credRow.id, provider: credRow.provider, status: 'connected' };
      }
    }
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

  // Phase 9.9.4F -- root cause of an earlier production "temporary_system_problem"
  // failure: workflow_integrations.provider had a live DB CHECK constraint
  // (workflow_integrations_provider_check) whose allowed value list was
  // ['email','shopify','slack','airtable','twilio','webhook'] -- it did not
  // include 'gmail'. For a LEGACY, SMTP-connected credential this was
  // stored under its own already-allowed raw label ('email') instead, since
  // that credential genuinely IS the same 'email'/'gmail' alias group
  // (lib/integrations.ts's PROVIDER_STORAGE_ALIAS_GROUPS).
  //
  // Phase 9.9.8C -- a genuine Gmail OAuth credential (integration.provider
  // === 'gmail' from integration_credentials, not user_integrations) is
  // NOT the same credential as legacy SMTP/email and must never be stored
  // under the 'email' label as if it were -- that would misrepresent which
  // credential type is actually attached and violate the "Gmail OAuth and
  // Email/SMTP remain independent credential types" requirement. This
  // stores the credential's own true raw provider (rawProviderToStore)
  // unconditionally; if the live CHECK constraint still does not allow
  // 'gmail', the write below is caught explicitly (23514) and reported
  // honestly as a specific, actionable schema-limitation error -- never
  // silently substituted for a different credential identity.
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

  const rawProviderToStore = integration.provider; // Always the credential's OWN true raw provider identity -- never aliased.

  // Phase 9.9.8D -- fail clearly and immediately for a raw provider value
  // the DB CHECK constraint would reject anyway, instead of relying solely
  // on the 23514 catch below. Both paths lead to the same honest error;
  // this one avoids the round-trip.
  if (!WORKFLOW_INTEGRATION_ALLOWED_RAW_PROVIDERS.has(rawProviderToStore)) {
    return NextResponse.json(
      {
        error: 'PROVIDER_NOT_YET_ALLOWED',
        message: `Attaching a "${rawProviderToStore}" credential requires a small database schema update that has not been applied to this environment yet. This is a known, tracked limitation, not a transient error -- please contact support.`,
      },
      { status: 409 }
    );
  }

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
    // Phase 9.9.8C -- a Postgres check_violation (23514) here means the
    // live workflow_integrations_provider_check constraint does not yet
    // allow this credential's raw provider value (e.g. 'gmail'). Reported
    // explicitly and honestly rather than the generic
    // 'temporary_system_problem' classifyError() would otherwise produce --
    // this is a specific, known, fixable schema limitation, never a
    // transient failure, and never silently worked around by storing a
    // different (e.g. 'email') credential identity instead.
    const rawCode = (mutationError as { code?: unknown } | null)?.code;
    if (rawCode === '23514') {
      return NextResponse.json(
        {
          error: 'PROVIDER_NOT_YET_ALLOWED',
          message: `Attaching a "${rawProviderToStore}" credential requires a small database schema update that has not been applied to this environment yet. This is a known, tracked limitation, not a transient error -- please contact support.`,
        },
        { status: 409 }
      );
    }
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
