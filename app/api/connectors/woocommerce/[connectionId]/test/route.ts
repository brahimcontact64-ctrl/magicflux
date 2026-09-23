/**
 * Phase 9.9.22 -- Part J: "Test WooCommerce Connection." Unlike the
 * generic webhook's Test Connection (Phase 9.9.21, which must intercept
 * the real inbound URL and is therefore only safe for a non-active
 * workflow), this test is a pure OUTBOUND health check against
 * WooCommerce's own API -- store reachable -> credentials valid ->
 * permissions sufficient -> subscription valid -> ready. It never touches
 * the inbound receiver route or the target workflow's execution path at
 * all, so it is equally safe to run against a workflow that is currently
 * ACTIVE and processing real traffic (Part J's explicit requirement).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { getDecryptedProviderCredentials } from '@/lib/credentials/storage';
import { getConnector } from '@/lib/connectors/registry';
import { getConnectionForOwner, updateConnectionHealth } from '@/lib/connectors/storage';

type Ctx = { params: { connectionId: string } };

export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { createServiceClient } = await import('@/lib/supabase-server');
  const db = createServiceClient();
  const { data: row } = await db.from('platform_connections').select('workflow_id, platform').eq('id', params.connectionId).eq('user_id', user.id).maybeSingle();
  if (!row) return NextResponse.json({ error: 'Connection not found' }, { status: 404 });

  const connection = await getConnectionForOwner(user.id, row.workflow_id, row.platform);
  const connector = getConnector(row.platform);
  if (!connection || !connector) return NextResponse.json({ error: 'Connection not found' }, { status: 404 });

  const creds = await getDecryptedProviderCredentials(user.id, row.platform);
  if (!creds.store_url || !creds.consumer_key || !creds.consumer_secret) {
    return NextResponse.json({ stage: 'credentials_invalid', detail: 'Credentials are missing or incomplete.' });
  }

  const result = await connector.testConnection({
    connection,
    credentials: { storeUrl: creds.store_url, consumerKey: creds.consumer_key, consumerSecret: creds.consumer_secret },
  });

  await updateConnectionHealth(connection.id, {
    status: result.stage === 'ready' ? 'connected' : 'needs_attention',
    lastVerifiedAt: new Date().toISOString(),
    lastError: result.stage === 'ready' ? null : result.detail,
    errorCategory: result.stage === 'ready' ? null : result.stage,
  });

  return NextResponse.json(result);
}
