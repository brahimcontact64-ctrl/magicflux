import { NextRequest, NextResponse } from 'next/server';

import {
  createServiceClient,
  getBearerToken,
  getUserFromAccessToken,
  isAdminUser,
} from '@/lib/supabase-server';
import {
  injectCredentialsIntoWorkflow,
  requiredProvidersFromWorkflow,
  type IntegrationProvider,
} from '@/lib/integrations';
import { runProPlanner } from '@/lib/ai-engine/pro-planner';
import { decryptIntegrationCredentials } from '@/lib/security/encryption';

async function assertAdmin(req: NextRequest): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const user = await getUserFromAccessToken(token);
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const admin = await isAdminUser(user.id);
  if (!admin) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return { ok: true };
}

export async function POST(req: NextRequest) {
  const guard = await assertAdmin(req);
  if (!guard.ok) return guard.response;

  const body = await req.json().catch(() => ({}));
  const requestId = body.requestId as string | undefined;

  if (!requestId) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }

  const db = createServiceClient();
  const { data: request, error: requestError } = await db
    .from('managed_requests')
    .select('id, user_id, description')
    .eq('id', requestId)
    .maybeSingle();

  if (requestError) {
    return NextResponse.json({ error: requestError.message }, { status: 500 });
  }

  if (!request) {
    return NextResponse.json({ error: 'Managed request not found' }, { status: 404 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const mode = process.env.AI_PLANNER_MODE === 'openai' && apiKey ? 'openai' : 'deterministic';

  let generatedWorkflowJson: unknown;
  try {
    const planned = await runProPlanner(request.description, { mode, apiKey: apiKey ?? undefined });
    generatedWorkflowJson = planned.plannerResult.n8nJson;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Planner generation failed';
    if (message.startsWith('INCOMPLETE_INTENT:')) {
      return NextResponse.json(
        {
          error: 'INCOMPLETE_INTENT',
          message: message.replace('INCOMPLETE_INTENT:', '').trim(),
        },
        { status: 422 }
      );
    }
    if (message.startsWith('UNSUPPORTED_REQUIREMENTS:')) {
      return NextResponse.json(
        {
          error: 'UNSUPPORTED_REQUIREMENTS',
          message: message.replace('UNSUPPORTED_REQUIREMENTS:', '').trim(),
        },
        { status: 422 }
      );
    }
    if (message.startsWith('CLARIFICATION_REQUIRED:') || message.includes('Unable to generate accurate workflow')) {
      return NextResponse.json(
        {
          error: 'CLARIFICATION_REQUIRED',
          message: message.replace('CLARIFICATION_REQUIRED:', '').trim(),
        },
        { status: 422 }
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const requiredProviders = requiredProvidersFromWorkflow(generatedWorkflowJson);

  const { data: integrationRows, error: integrationsError } = await db
    .from('user_integrations')
    .select('provider, credentials')
    .eq('user_id', request.user_id ?? '')
    .eq('status', 'connected');

  if (integrationsError) {
    return NextResponse.json({ error: integrationsError.message }, { status: 500 });
  }

  const connectedProviders = new Set(
    (integrationRows ?? []).map(row => row.provider as IntegrationProvider)
  );
  const missingIntegrations = requiredProviders.filter(provider => !connectedProviders.has(provider));

  const workflowJson = injectCredentialsIntoWorkflow(
    generatedWorkflowJson,
    (integrationRows ?? []).map(row => ({
      provider: row.provider as IntegrationProvider,
      credentials: decryptIntegrationCredentials(row.credentials as Record<string, unknown>),
    }))
  );

  const { error: updateError } = await db
    .from('managed_requests')
    .update({
      workflow_json: workflowJson,
      status: 'generated',
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    requestId,
    workflow_json: workflowJson,
    status: 'generated',
    requiredIntegrations: requiredProviders,
    missingIntegrations,
  });
}
