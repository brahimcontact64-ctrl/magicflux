import 'server-only';

import { randomBytes } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase-server';
import { encryptSecretValue, decryptSecretValue } from '@/lib/security/encryption';
import { getCredentialRowId } from '@/lib/credentials/storage';
import type { ConnectionRecord, ConnectionStatus } from './types';

/**
 * Phase 9.9.22 -- persistence for platform_connections (see the migration
 * file's header for why this is a new table rather than reusing
 * integration_credentials/workflow_integrations/workflow_json.security).
 *
 * NOT YET LIVE: the platform_connections migration is drafted but not
 * applied (standing schema-approval gate). Every function here will fail
 * with a real Postgres error if called before that migration is approved
 * and run -- by design, nothing in this phase wires these functions into
 * reachable UI navigation, mirroring the Phase 9.9.12 workflow_acknowledgments
 * precedent exactly.
 */

type ConnectionRow = {
  id: string;
  user_id: string;
  workflow_id: string;
  platform: string;
  status: ConnectionStatus;
  store_url: string;
  webhook_secret_encrypted: string;
  provider_subscriptions: Record<string, string> | null;
  topics: string[] | null;
  last_verified_at: string | null;
  last_event_at: string | null;
  last_error: string | null;
  error_category: string | null;
};

function toRecord(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    workflowId: row.workflow_id,
    platform: row.platform,
    status: row.status,
    storeUrl: row.store_url,
    providerSubscriptions: row.provider_subscriptions ?? {},
    topics: row.topics ?? [],
    lastVerifiedAt: row.last_verified_at,
    lastEventAt: row.last_event_at,
    lastError: row.last_error,
    errorCategory: row.error_category,
  };
}

function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/** Owner-scoped lookup for the Connect/Test UI and API routes. */
export async function getConnectionForOwner(userId: string, workflowId: string, platform: string): Promise<ConnectionRecord | null> {
  const db = createServiceClient();
  const { data } = await db
    .from('platform_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('workflow_id', workflowId)
    .eq('platform', platform)
    .maybeSingle();
  return data ? toRecord(data as ConnectionRow) : null;
}

/**
 * Unauthenticated lookup by connection id -- used ONLY by the public
 * inbound receiver route, which authenticates the REQUEST via the
 * connector's own signature verification (never via a user session).
 * Structurally cannot leak another tenant's data: the caller must already
 * know this exact connection id (embedded in the delivery URL WooCommerce
 * itself was configured with) AND produce a valid signature for that
 * connection's own generated secret.
 */
export async function getConnectionById(connectionId: string): Promise<ConnectionRecord | null> {
  const db = createServiceClient();
  const { data } = await db.from('platform_connections').select('*').eq('id', connectionId).maybeSingle();
  return data ? toRecord(data as ConnectionRow) : null;
}

export async function getDecryptedWebhookSecret(connectionId: string): Promise<string | null> {
  const db = createServiceClient();
  const { data } = await db.from('platform_connections').select('webhook_secret_encrypted').eq('id', connectionId).maybeSingle();
  if (!data?.webhook_secret_encrypted) return null;
  return decryptSecretValue(String(data.webhook_secret_encrypted));
}

/**
 * Creates a new connection row (status 'connecting') with a freshly
 * generated webhook secret, or returns the existing row unchanged if one
 * already exists for (workflow, platform) -- idempotent, so a repeated
 * "Connect WooCommerce" click before the first attempt finishes never
 * creates a second row (Part K).
 */
export async function ensureConnection(userId: string, workflowId: string, platform: string, storeUrl: string): Promise<{ connection: ConnectionRecord; webhookSecret: string; isNew: boolean }> {
  const existing = await getConnectionForOwner(userId, workflowId, platform);
  if (existing) {
    // Phase 9.9.22B -- Live Certification Failure #2 audit: this
    // previously fell back to `secret ?? generateWebhookSecret()` -- if
    // the stored secret was ever unreadable, that silently handed the
    // caller a FRESH, NEVER-PERSISTED secret. The caller (connect/route.ts)
    // would then configure WooCommerce's webhook with that fresh value
    // while this row kept storing the old one -- signature verification on
    // every subsequent real delivery would fail forever, indistinguishable
    // from a genuine attacker without this audit trail. An existing
    // connection's secret must always be readable; anything else is a real
    // data-integrity fault and must fail loudly (never silently diverge)
    // so the operator sees it immediately instead of a mysteriously
    // rejected signature days later.
    const secret = await getDecryptedWebhookSecret(existing.id);
    if (!secret) {
      throw new Error(`Existing platform_connections row ${existing.id} has no readable webhook secret -- refusing to proceed with a freshly generated, unpersisted one (would cause permanent signature-verification drift).`);
    }
    return { connection: existing, webhookSecret: secret, isNew: false };
  }

  const webhookSecret = generateWebhookSecret();
  // Phase 9.9.22A -- links this connection to the integration_credentials
  // row set it depends on (any one row is a valid CASCADE anchor -- see
  // the migration's own header note), so disconnecting those credentials
  // via the existing Settings > Integrations flow cleanly cascades this
  // connection away instead of silently orphaning it. Best-effort: a null
  // credentialId here (the row not found yet, e.g. a future connector with
  // a different credential shape) still creates the connection -- the FK
  // column is nullable precisely for that case.
  const credentialId = await getCredentialRowId(userId, platform, 'consumer_secret').catch(() => null);

  const db = createServiceClient();
  const { data, error } = await db
    .from('platform_connections')
    .insert({
      user_id: userId,
      workflow_id: workflowId,
      platform,
      status: 'connecting',
      store_url: storeUrl,
      credential_id: credentialId,
      webhook_secret_encrypted: encryptSecretValue(webhookSecret),
      provider_subscriptions: {},
      topics: [],
    })
    .select('*')
    .single();

  if (error || !data) throw new Error(`Failed to create platform connection: ${error?.message}`);
  return { connection: toRecord(data as ConnectionRow), webhookSecret, isNew: true };
}

export async function updateConnectionSubscriptions(connectionId: string, params: { providerSubscriptions: Record<string, string>; topics: string[]; status: ConnectionStatus }): Promise<void> {
  const db = createServiceClient();
  await db
    .from('platform_connections')
    .update({
      provider_subscriptions: params.providerSubscriptions,
      topics: params.topics,
      status: params.status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connectionId);
}

export async function updateConnectionHealth(connectionId: string, params: { status?: ConnectionStatus; lastVerifiedAt?: string; lastEventAt?: string; lastError?: string | null; errorCategory?: string | null }): Promise<void> {
  const db = createServiceClient();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (params.status !== undefined) patch.status = params.status;
  if (params.lastVerifiedAt !== undefined) patch.last_verified_at = params.lastVerifiedAt;
  if (params.lastEventAt !== undefined) patch.last_event_at = params.lastEventAt;
  if (params.lastError !== undefined) patch.last_error = params.lastError;
  if (params.errorCategory !== undefined) patch.error_category = params.errorCategory;
  await db.from('platform_connections').update(patch).eq('id', connectionId);
}

export async function deleteConnection(userId: string, connectionId: string): Promise<ConnectionRecord | null> {
  const db = createServiceClient();
  const { data } = await db.from('platform_connections').select('*').eq('id', connectionId).eq('user_id', userId).maybeSingle();
  if (!data) return null;

  await db.from('platform_connections').delete().eq('id', connectionId).eq('user_id', userId);
  return toRecord(data as ConnectionRow);
}
