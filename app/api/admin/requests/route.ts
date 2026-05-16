import { NextRequest, NextResponse } from 'next/server';

import {
  createServiceClient,
  getBearerToken,
  getUserFromAccessToken,
  isAdminUser,
} from '@/lib/supabase-server';
import { requiredProvidersFromWorkflow, type IntegrationProvider } from '@/lib/integrations';

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

export async function GET(req: NextRequest) {
  const guard = await assertAdmin(req);
  if (!guard.ok) return guard.response;

  const db = createServiceClient();
  const { data, error } = await db
    .from('managed_requests')
    .select('id, user_id, template_id, template_name, request_type, description, contact_email, status, workflow_json, workflow_id, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const userIds = Array.from(new Set((data ?? []).map(row => row.user_id).filter(Boolean))) as string[];

  let providersByUser = new Map<string, Set<IntegrationProvider>>();
  if (userIds.length > 0) {
    const { data: integrations, error: integrationsError } = await db
      .from('user_integrations')
      .select('user_id, provider')
      .eq('status', 'connected')
      .in('user_id', userIds);

    if (integrationsError) {
      return NextResponse.json({ error: integrationsError.message }, { status: 500 });
    }

    providersByUser = integrations?.reduce((acc, row) => {
      const userId = String(row.user_id ?? '');
      if (!acc.has(userId)) acc.set(userId, new Set<IntegrationProvider>());
      acc.get(userId)?.add(row.provider as IntegrationProvider);
      return acc;
    }, new Map<string, Set<IntegrationProvider>>()) ?? new Map<string, Set<IntegrationProvider>>();
  }

  const requests = (data ?? []).map(row => {
    const required = requiredProvidersFromWorkflow(row.workflow_json);
    const connected = providersByUser.get(String(row.user_id ?? '')) ?? new Set<IntegrationProvider>();
    const missingIntegrations = required.filter(provider => !connected.has(provider));
    return {
      ...row,
      missing_integrations: missingIntegrations,
      required_integrations: required,
    };
  });

  return NextResponse.json({ success: true, requests });
}
