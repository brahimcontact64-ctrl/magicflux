import { createServiceClient } from '@/lib/supabase-server';
import { requiredProvidersFromWorkflow, type IntegrationProvider } from '@/lib/integrations';
import { decryptIntegrationCredentials } from '@/lib/integration-crypto';

export type IntegrationStatus = 'connected' | 'invalid' | 'not_connected';

export type UserIntegration = {
  id?: string;
  provider: IntegrationProvider;
  credentials: Record<string, string>;
  status: IntegrationStatus;
  name?: string | null;
  last_verified_at?: string | null;
  created_at?: string;
};

export async function getUserIntegrations(
  userId: string,
  opts?: { connectedOnly?: boolean }
): Promise<UserIntegration[]> {
  const connectedOnly = opts?.connectedOnly ?? true;
  const db = createServiceClient();
  const { data, error } = await db
    .from('user_integrations')
    .select('id, provider, name, credentials, status, last_verified_at, created_at')
    .eq('user_id', userId);

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []).map((row) => ({
    id: row.id as string | undefined,
    provider: row.provider as IntegrationProvider,
    name: (row.name as string | null | undefined) ?? null,
    credentials: decryptIntegrationCredentials((row.credentials ?? {}) as Record<string, unknown>),
    status: (row.status ?? 'not_connected') as IntegrationStatus,
    last_verified_at: (row.last_verified_at as string | null | undefined) ?? null,
    created_at: row.created_at as string | undefined,
  }));

  if (!connectedOnly) return rows;
  return rows.filter((row) => row.status === 'connected');
}

export async function getWorkflowIntegrationStatus(userId: string, workflowJson: unknown) {
  const userIntegrations = await getUserIntegrations(userId, { connectedOnly: false });
  const requiredIntegrations = requiredProvidersFromWorkflow(workflowJson);
  const connected = new Set(
    userIntegrations
      .filter((item) => item.status === 'connected')
      .map((item) => item.provider)
  );
  const missingIntegrations = requiredIntegrations.filter((provider) => !connected.has(provider));
  const invalidIntegrations = userIntegrations
    .filter((item) => item.status === 'invalid')
    .map((item) => item.provider);

  return {
    required_integrations: requiredIntegrations,
    missing_integrations: missingIntegrations,
    invalid_integrations: invalidIntegrations,
    user_integrations: userIntegrations.filter((item) => item.status === 'connected'),
    user_integrations_all: userIntegrations,
  };
}

  /**
   * Resolve workflow-level integration selections
   * 1. Check workflow_integrations for explicitly selected integration per provider
   * 2. Fall back to user default (if only one connected for that provider)
   * 3. Return resolved credentials or throw if missing
   */
  export async function resolveWorkflowIntegrations(
    userId: string,
    workflowId: string,
    workflowJson: unknown
  ) {
    const db = createServiceClient();
    const requiredProviders = requiredProvidersFromWorkflow(workflowJson);
    const userIntegrations = await getUserIntegrations(userId, { connectedOnly: true });

    const byProvider = new Map<IntegrationProvider, UserIntegration[]>();
    for (const integration of userIntegrations) {
      const list = byProvider.get(integration.provider) ?? [];
      list.push(integration);
      byProvider.set(integration.provider, list);
    }

    const { data: workflowSelections, error: selectionError } = await db
      .from('workflow_integrations')
      .select('provider, integration_id')
      .eq('workflow_id', workflowId)
      .eq('user_id', userId);

    if (selectionError) {
      throw new Error(selectionError.message);
    }

    const selectedByProvider = new Map<IntegrationProvider, string>();
    (workflowSelections ?? []).forEach((row) => {
      selectedByProvider.set(row.provider as IntegrationProvider, row.integration_id as string);
    });

    const resolved = new Map<IntegrationProvider, UserIntegration>();
    const warnings: string[] = [];

    for (const provider of requiredProviders) {
      const available = byProvider.get(provider) ?? [];
      if (available.length === 0) {
        throw new Error(`SETUP_REQUIRED:${provider}`);
      }

      const selectedId = selectedByProvider.get(provider);
      if (selectedId) {
        const selected = available.find((item) => item.id === selectedId);
        if (selected) {
          resolved.set(provider, selected);
          continue;
        }
        throw new Error(`SETUP_REQUIRED:${provider}`);
      }

      if (available.length === 1) {
        resolved.set(provider, available[0]);
        continue;
      }

      throw new Error(`SETUP_REQUIRED:${provider}`);
    }

    return { resolved, warnings };
  }
