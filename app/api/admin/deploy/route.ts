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
import { decryptIntegrationCredentials } from '@/lib/integration-crypto';

type WorkflowPayload = {
  name?: string;
  nodes?: unknown[];
  connections?: Record<string, unknown>;
  settings?: Record<string, unknown>;
};

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

  const n8nUrl = process.env.N8N_API_URL;
  const n8nKey = process.env.N8N_API_KEY;

  if (!n8nUrl || !n8nKey) {
    return NextResponse.json({ error: 'n8n is not configured' }, { status: 503 });
  }

  const db = createServiceClient();
  const { data: request, error: requestError } = await db
    .from('managed_requests')
    .select('id, user_id, template_name, workflow_json')
    .eq('id', requestId)
    .maybeSingle();

  if (requestError) {
    return NextResponse.json({ error: requestError.message }, { status: 500 });
  }

  if (!request) {
    return NextResponse.json({ error: 'Managed request not found' }, { status: 404 });
  }

  const workflow = request.workflow_json as WorkflowPayload | null;
  if (!workflow?.nodes || !workflow?.connections) {
    return NextResponse.json({ error: 'Workflow not generated for this request yet' }, { status: 400 });
  }

  const requiredProviders = requiredProvidersFromWorkflow(workflow);
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

  if (missingIntegrations.length > 0) {
    return NextResponse.json(
      { error: `Missing required integrations: ${missingIntegrations.join(', ')}`, missingIntegrations },
      { status: 422 }
    );
  }

  const preparedWorkflow = injectCredentialsIntoWorkflow(
    workflow,
    (integrationRows ?? []).map(row => ({
      provider: row.provider as IntegrationProvider,
      credentials: decryptIntegrationCredentials(row.credentials as Record<string, unknown>),
    }))
  ) as WorkflowPayload;

  const base = n8nUrl.replace(/\/$/, '');

  const createRes = await fetch(`${base}/api/v1/workflows`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-N8N-API-KEY': n8nKey,
      Accept: 'application/json',
    },
    body: JSON.stringify({
      name: preparedWorkflow.name ?? request.template_name ?? `Managed Request ${request.id}`,
      nodes: preparedWorkflow.nodes,
      connections: preparedWorkflow.connections,
      settings: preparedWorkflow.settings ?? { executionOrder: 'v1' },
      active: false,
    }),
  });

  if (!createRes.ok) {
    const createError = await createRes.text().catch(() => 'Failed to create workflow in n8n');
    return NextResponse.json({ error: createError }, { status: 502 });
  }

  const created = await createRes.json().catch(() => ({})) as { id?: string };
  const workflowId = created.id;

  if (!workflowId) {
    return NextResponse.json({ error: 'n8n did not return workflow ID' }, { status: 502 });
  }

  const activateRes = await fetch(`${base}/api/v1/workflows/${workflowId}/activate`, {
    method: 'POST',
    headers: {
      'X-N8N-API-KEY': n8nKey,
      Accept: 'application/json',
    },
  });

  if (!activateRes.ok) {
    const activateError = await activateRes.text().catch(() => 'Failed to activate workflow in n8n');
    return NextResponse.json({ error: activateError }, { status: 502 });
  }

  const { error: updateError } = await db
    .from('managed_requests')
    .update({
      workflow_id: workflowId,
      status: 'deployed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, requestId, workflow_id: workflowId, status: 'deployed' });
}
