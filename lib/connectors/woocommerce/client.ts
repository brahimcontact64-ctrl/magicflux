import { checkUrlSafe, guardedFetch } from '../safe-fetch';
import type { ConnectCredentials } from '../types';

/**
 * Phase 9.9.22 -- thin WooCommerce REST API v3 client. Every call is
 * SSRF-guarded (Part E) and requires HTTPS. Auth is HTTP Basic with the
 * store's Consumer Key/Secret -- WooCommerce's own documented method for
 * HTTPS stores (developer.woocommerce.com/docs/apis/rest-api/v2/webhooks/),
 * avoiding the more complex OAuth1.0a signing WooCommerce only requires
 * over plain HTTP, which this connector never allows anyway.
 */

export type WcWebhook = { id: number; name: string; topic: string; delivery_url: string; status: string };

export class WooCommerceApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'WooCommerceApiError';
  }
}

function normalizeStoreUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.protocol}//${url.host}`;
}

function authHeader(credentials: ConnectCredentials): string {
  const token = Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString('base64');
  return `Basic ${token}`;
}

export async function validateStoreUrlReachable(rawUrl: string): Promise<{ ok: true; storeUrl: string } | { ok: false; reason: string }> {
  let storeUrl: string;
  try {
    storeUrl = normalizeStoreUrl(rawUrl);
  } catch {
    return { ok: false, reason: 'Invalid store URL' };
  }

  const check = await checkUrlSafe(storeUrl);
  if (!check.allowed) return { ok: false, reason: check.reason };

  try {
    const res = await guardedFetch(`${storeUrl}/wp-json/`, { method: 'GET', headers: {} });
    if (res.status >= 500) return { ok: false, reason: `Store returned a server error (${res.status})` };
    return { ok: true, storeUrl };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Store is unreachable' };
  }
}

/** GET /webhooks (list) -- requires only read scope. Used to confirm the credentials themselves are valid. */
export async function listWebhooks(storeUrl: string, credentials: ConnectCredentials): Promise<{ ok: true; webhooks: WcWebhook[] } | { ok: false; status: number; reason: string }> {
  const check = await checkUrlSafe(storeUrl);
  if (!check.allowed) return { ok: false, status: 0, reason: check.reason };

  const res = await guardedFetch(`${storeUrl}/wp-json/wc/v3/webhooks?per_page=100`, {
    method: 'GET',
    headers: { Authorization: authHeader(credentials) },
  });

  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, reason: 'WooCommerce rejected these credentials' };
  }
  if (res.status >= 400) {
    return { ok: false, status: res.status, reason: `WooCommerce returned an error listing webhooks (${res.status})` };
  }

  try {
    const parsed = JSON.parse(res.bodyText) as WcWebhook[];
    return { ok: true, webhooks: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { ok: false, status: res.status, reason: 'Unexpected response from WooCommerce' };
  }
}

/** POST /webhooks -- requires write scope. A read-only Consumer Key fails here with 401/403 even though listWebhooks() above succeeded. */
export async function createWebhook(
  storeUrl: string,
  credentials: ConnectCredentials,
  params: { name: string; topic: string; deliveryUrl: string; secret: string },
): Promise<{ ok: true; webhook: WcWebhook } | { ok: false; status: number; reason: string }> {
  const check = await checkUrlSafe(storeUrl);
  if (!check.allowed) return { ok: false, status: 0, reason: check.reason };

  const res = await guardedFetch(`${storeUrl}/wp-json/wc/v3/webhooks`, {
    method: 'POST',
    headers: { Authorization: authHeader(credentials), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: params.name,
      topic: params.topic,
      delivery_url: params.deliveryUrl,
      secret: params.secret,
      status: 'active',
    }),
  });

  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, reason: 'This Consumer Key does not have permission to create webhooks (requires Read/Write access)' };
  }
  if (res.status >= 400) {
    return { ok: false, status: res.status, reason: `WooCommerce rejected the webhook creation (${res.status})` };
  }

  try {
    const webhook = JSON.parse(res.bodyText) as WcWebhook;
    return { ok: true, webhook };
  } catch {
    return { ok: false, status: res.status, reason: 'Unexpected response from WooCommerce' };
  }
}

export async function deleteWebhook(storeUrl: string, credentials: ConnectCredentials, webhookId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const check = await checkUrlSafe(storeUrl);
  if (!check.allowed) return { ok: false, reason: check.reason };

  try {
    const res = await guardedFetch(`${storeUrl}/wp-json/wc/v3/webhooks/${encodeURIComponent(webhookId)}?force=true`, {
      method: 'DELETE',
      headers: { Authorization: authHeader(credentials) },
    });
    // A webhook already deleted externally (Part K) 404s -- not a failure
    // from this connector's point of view, since the end state (no
    // provider-side subscription) is exactly what disconnect wants.
    if (res.status >= 400 && res.status !== 404) {
      return { ok: false, reason: `WooCommerce rejected the webhook deletion (${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Failed to delete webhook' };
  }
}
