/**
 * Phase 9.9.22 -- Part K/L: owner-scoped connection lifecycle.
 *
 * GET    -- safe observability (status, last verified/event, error
 *           category -- never credentials, signatures, or raw payloads).
 * DELETE -- disconnect: removes the WooCommerce-side webhook
 *           subscription(s) (tolerant of one already deleted externally)
 *           and the connection row. Credentials in integration_credentials
 *           are left in place so reconnecting doesn't require re-entering
 *           them -- deleting those is a separate, explicit action via the
 *           existing Settings > Integrations disconnect flow.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { createServiceClient } from '@/lib/supabase-server';
import { getDecryptedProviderCredentials } from '@/lib/credentials/storage';
import { getConnector } from '@/lib/connectors/registry';
import { deleteConnection } from '@/lib/connectors/storage';

type Ctx = { params: { connectionId: string } };

export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const { data } = await db
    .from('platform_connections')
    .select('id, platform, status, store_url, topics, last_verified_at, last_event_at, last_error, error_category')
    .eq('id', params.connectionId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!data) return NextResponse.json({ error: 'Connection not found' }, { status: 404 });

  return NextResponse.json({
    connectionId: data.id,
    platform: data.platform,
    status: data.status,
    storeUrl: data.store_url,
    topics: data.topics,
    lastVerifiedAt: data.last_verified_at,
    lastEventAt: data.last_event_at,
    lastError: data.last_error,
    errorCategory: data.error_category,
  });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const connection = await deleteConnection(user.id, params.connectionId);
  if (!connection) return NextResponse.json({ error: 'Connection not found' }, { status: 404 });

  const connector = getConnector(connection.platform);
  if (connector && Object.keys(connection.providerSubscriptions).length > 0) {
    const creds = await getDecryptedProviderCredentials(user.id, connection.platform);
    if (creds.store_url && creds.consumer_key && creds.consumer_secret) {
      await connector.unsubscribe({
        credentials: { storeUrl: creds.store_url, consumerKey: creds.consumer_key, consumerSecret: creds.consumer_secret },
        providerSubscriptions: connection.providerSubscriptions,
      });
    }
  }

  return NextResponse.json({ success: true, disconnected: true });
}
