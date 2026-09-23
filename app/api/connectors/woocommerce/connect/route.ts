/**
 * Phase 9.9.22 -- Part D: "Connect WooCommerce" in one authenticated call.
 * The user is never asked to manually build a WooCommerce webhook -- this
 * route validates the store, verifies the credentials actually work, and
 * creates the required webhook subscription(s) through WooCommerce's own
 * REST API.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { saveProviderCredentials } from '@/lib/credentials/storage';
import { diagnoseWooCommerceConnection } from '@/lib/connectors/woocommerce/client';
import { getConnector } from '@/lib/connectors/registry';
import { ensureConnection, updateConnectionSubscriptions, updateConnectionHealth, getConnectionForOwner } from '@/lib/connectors/storage';
import { isSupportedTopic, WOOCOMMERCE_SUPPORTED_TOPICS } from '@/lib/connectors/woocommerce/capabilities';

const DEFAULT_TOPICS = ['order.created', 'customer.created'] as const;

/**
 * Phase 9.9.22B -- lets the Connect page discover whether THIS workflow
 * already has a WooCommerce connection, without the browser needing to
 * already know a connectionId. Owner-scoped; never returns credentials or
 * the webhook secret.
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const workflowId = req.nextUrl.searchParams.get('workflowId');
  if (!workflowId) return NextResponse.json({ error: 'workflowId is required' }, { status: 400 });

  const connection = await getConnectionForOwner(user.id, workflowId, 'woocommerce');
  if (!connection) return NextResponse.json({ connected: false });

  return NextResponse.json({
    connected: true,
    connectionId: connection.id,
    status: connection.status,
    storeUrl: connection.storeUrl,
    topics: connection.topics,
    lastVerifiedAt: connection.lastVerifiedAt,
    lastEventAt: connection.lastEventAt,
    lastError: connection.lastError,
  });
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    workflowId?: string;
    storeUrl?: string;
    consumerKey?: string;
    consumerSecret?: string;
    topics?: string[];
  };

  if (!body.workflowId || !body.storeUrl || !body.consumerKey || !body.consumerSecret) {
    return NextResponse.json({ error: 'storeUrl, consumerKey, consumerSecret and workflowId are required' }, { status: 400 });
  }

  const requestedTopics = (body.topics && body.topics.length > 0 ? body.topics : [...DEFAULT_TOPICS]).filter(Boolean);
  const unsupported = requestedTopics.filter((t) => !isSupportedTopic(t));
  if (unsupported.length > 0) {
    return NextResponse.json({ error: 'UNSUPPORTED_TOPICS', message: `Not supported yet: ${unsupported.join(', ')}`, supportedTopics: WOOCOMMERCE_SUPPORTED_TOPICS }, { status: 400 });
  }

  const db = createServiceClient();
  const { data: workflow } = await db.from('workflows').select('id').eq('id', body.workflowId).eq('user_id', user.id).maybeSingle();
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  // Part E -- SSRF pre-flight before ANY outbound call is made with the
  // user-supplied store URL. Phase 9.9.22B -- full staged diagnosis
  // (store -> WordPress REST -> WooCommerce namespace -> credentials ->
  // webhooks endpoint), with the pretty-permalink/rest_route compatibility
  // fallback applied transparently at every step, so Connect never fails
  // with a misleading "credentials invalid" for what's actually a
  // permalink/rewrite-rule limitation on the store.
  const preflightCredentials = { storeUrl: body.storeUrl, consumerKey: body.consumerKey, consumerSecret: body.consumerSecret };
  const diagnosis = await diagnoseWooCommerceConnection(body.storeUrl, preflightCredentials);
  if (diagnosis.stage !== 'ready') {
    // Never logs the store URL, key, or secret -- only the host (for
    // cross-referencing with the store owner) and the pre-written/caught
    // stage + detail, which are either a fixed safe string or a generic
    // network-error message (never a raw upstream response body).
    console.error('[woocommerce-connect] pre-flight diagnosis did not reach ready', {
      workflowId: body.workflowId,
      storeHost: (() => { try { return new URL(body.storeUrl!).host; } catch { return 'unparseable'; } })(),
      stage: diagnosis.stage,
      detail: diagnosis.detail,
    });
    return NextResponse.json({ error: diagnosis.stage.toUpperCase(), message: diagnosis.detail }, { status: 400 });
  }

  const storeUrl = diagnosis.storeUrl ?? body.storeUrl;
  const credentials = { storeUrl, consumerKey: body.consumerKey, consumerSecret: body.consumerSecret };

  // Consumer Key/Secret never returned to the browser again after this
  // point -- saved encrypted, read back only server-side.
  await saveProviderCredentials(user.id, 'woocommerce', {
    store_url: storeUrl,
    consumer_key: body.consumerKey,
    consumer_secret: body.consumerSecret,
  });

  const { connection, webhookSecret } = await ensureConnection(user.id, body.workflowId, 'woocommerce', storeUrl);
  const webhookUrl = `${req.nextUrl.origin}/api/connectors/woocommerce/${connection.id}/receive`;

  const connector = getConnector('woocommerce')!;
  const subscribed = await connector.subscribe({
    credentials,
    webhookUrl,
    webhookSecret,
    topics: requestedTopics,
    existing: connection.providerSubscriptions,
  });

  if (!subscribed.ok) {
    await updateConnectionSubscriptions(connection.id, {
      providerSubscriptions: subscribed.partialSubscriptions ?? connection.providerSubscriptions,
      topics: requestedTopics,
      status: 'needs_attention',
    });
    await updateConnectionHealth(connection.id, { lastError: subscribed.reason, errorCategory: 'subscription_failed' });
    return NextResponse.json({ error: 'SUBSCRIPTION_FAILED', message: subscribed.reason, connectionId: connection.id }, { status: 502 });
  }

  await updateConnectionSubscriptions(connection.id, {
    providerSubscriptions: subscribed.providerSubscriptions,
    topics: requestedTopics,
    status: 'connected',
  });
  await updateConnectionHealth(connection.id, { lastVerifiedAt: new Date().toISOString(), lastError: null, errorCategory: null });

  return NextResponse.json({
    success: true,
    connectionId: connection.id,
    status: 'connected',
    topics: requestedTopics,
  });
}
