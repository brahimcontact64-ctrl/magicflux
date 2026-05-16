import { createServiceClient } from '@/lib/supabase-server';
import type { ProviderMetadata } from './types';

type ProviderMemoryRow = {
  id: string;
  user_id: string;
  provider_key: string;
  display_name: string;
  provider_type: string;
  capabilities: string[];
  auth_strategy: Record<string, unknown>;
  required_credentials: string[];
  docs_url: string | null;
  logo_url: string | null;
  validation_strategy: string;
  endpoint_hints: string[];
  aliases: string[];
  confidence: number;
  metadata: Record<string, unknown>;
};

function rowToMetadata(row: ProviderMemoryRow): ProviderMetadata {
  return {
    provider: row.provider_key,
    displayName: row.display_name,
    providerType: row.provider_type as ProviderMetadata['providerType'],
    capabilities: row.capabilities,
    requiredCredentials: row.required_credentials,
    docsUrl: row.docs_url,
    logo: row.logo_url,
    authStrategy: row.auth_strategy as ProviderMetadata['authStrategy'],
    validationStrategy: row.validation_strategy as ProviderMetadata['validationStrategy'],
    endpointHints: row.endpoint_hints,
    aliases: row.aliases,
    confidence: Number(row.confidence ?? 0),
    source: 'memory',
  };
}

export async function getProviderMemoryByKey(params: {
  userId: string;
  providerKey: string;
}): Promise<ProviderMetadata | null> {
  const db = createServiceClient();

  const { data, error } = await db
    .from('provider_intelligence')
    .select('*')
    .eq('user_id', params.userId)
    .eq('provider_key', params.providerKey.toLowerCase())
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return rowToMetadata(data as ProviderMemoryRow);
}

export async function getProviderMemoryByAlias(params: {
  userId: string;
  providerAlias: string;
}): Promise<ProviderMetadata | null> {
  const db = createServiceClient();
  const alias = params.providerAlias.toLowerCase();

  const { data } = await db
    .from('provider_intelligence')
    .select('*')
    .eq('user_id', params.userId)
    .contains('aliases', [alias])
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  return rowToMetadata(data as ProviderMemoryRow);
}

export async function listProviderMemory(params: {
  userId: string;
}): Promise<ProviderMetadata[]> {
  const db = createServiceClient();

  const { data } = await db
    .from('provider_intelligence')
    .select('*')
    .eq('user_id', params.userId)
    .order('updated_at', { ascending: false })
    .limit(200);

  return ((data ?? []) as ProviderMemoryRow[]).map(rowToMetadata);
}

export async function saveProviderMemory(params: {
  userId: string;
  metadata: ProviderMetadata;
  runtimeAdapter?: Record<string, unknown>;
  successfulPatterns?: Record<string, unknown>;
}): Promise<void> {
  const db = createServiceClient();

  await db
    .from('provider_intelligence')
    .upsert({
      user_id: params.userId,
      provider_key: params.metadata.provider.toLowerCase(),
      display_name: params.metadata.displayName,
      provider_type: params.metadata.providerType,
      capabilities: params.metadata.capabilities,
      auth_strategy: params.metadata.authStrategy,
      required_credentials: params.metadata.requiredCredentials,
      docs_url: params.metadata.docsUrl ?? null,
      logo_url: params.metadata.logo ?? null,
      validation_strategy: params.metadata.validationStrategy,
      endpoint_hints: params.metadata.endpointHints,
      aliases: params.metadata.aliases ?? [],
      confidence: params.metadata.confidence,
      metadata: {
        source: params.metadata.source,
        runtimeAdapter: params.runtimeAdapter ?? null,
        successfulPatterns: params.successfulPatterns ?? {},
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,provider_key' });
}

export async function updateProviderHealth(params: {
  userId: string;
  providerKey: string;
  success: boolean;
  latencyMs?: number;
  estimatedCostUsd?: number;
  errorMessage?: string;
}): Promise<void> {
  const db = createServiceClient();
  const { data: current } = await db
    .from('provider_intelligence')
    .select('health_score, success_count, failure_count')
    .eq('user_id', params.userId)
    .eq('provider_key', params.providerKey.toLowerCase())
    .limit(1)
    .maybeSingle();

  const successCount = Number(current?.success_count ?? 0) + (params.success ? 1 : 0);
  const failureCount = Number(current?.failure_count ?? 0) + (params.success ? 0 : 1);
  const total = Math.max(1, successCount + failureCount);
  const healthScore = Math.round((successCount / total) * 100);

  await db
    .from('provider_intelligence')
    .update({
      success_count: successCount,
      failure_count: failureCount,
      health_score: healthScore,
      last_latency_ms: params.latencyMs ?? null,
      estimated_cost_usd: params.estimatedCostUsd ?? null,
      last_error: params.errorMessage ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', params.userId)
    .eq('provider_key', params.providerKey.toLowerCase());
}
