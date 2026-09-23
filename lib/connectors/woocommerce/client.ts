import { checkUrlSafe, guardedFetch } from '../safe-fetch';
import type { ConnectCredentials } from '../types';

/**
 * Phase 9.9.22 -- thin WooCommerce REST API v3 client. Every call is
 * SSRF-guarded (Part E) and requires HTTPS. Auth is HTTP Basic with the
 * store's Consumer Key/Secret -- WooCommerce's own documented method for
 * HTTPS stores (developer.woocommerce.com/docs/apis/rest-api/v2/webhooks/),
 * avoiding the more complex OAuth1.0a signing WooCommerce only requires
 * over plain HTTP, which this connector never allows anyway.
 *
 * Phase 9.9.22B -- Live Certification Failure #1: a real store (temporary
 * WPRun host) returned 404 for GET /wp-json/wc/v3/webhooks even with valid
 * credentials. Root cause (confirmed against WooCommerce's own GitHub
 * issue tracker and WordPress REST API docs, not host-specific): WordPress
 * REST API "pretty" routes (/wp-json/*) depend on the site's permalink
 * structure being non-"Plain" AND the server's rewrite rules actually
 * being flushed/configured to route /wp-json/* to WordPress -- on a
 * constrained/trial host, or a site where permalinks were never
 * (re-)saved after WooCommerce activation, that routing simply isn't
 * there, and EVERY /wp-json/* path 404s regardless of credentials.
 * WordPress's own canonical fallback, handled directly by index.php
 * without depending on any rewrite rule, is the query-string form:
 * `?rest_route=/wc/v3/webhooks`. This is a documented, general WordPress/
 * WooCommerce compatibility path (see e.g. woocommerce/woocommerce#15064,
 * #27631), not a WPRun-specific hack -- every request in this client now
 * tries the pretty path first and transparently retries via `rest_route`
 * on a 404, so the connector works identically whether or not a given
 * store's rewrite rules happen to be configured.
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

type WcRequestResult = { status: number; bodyText: string; usedFallback: boolean };

/**
 * Issues one WordPress/WooCommerce REST API request, trying the "pretty"
 * permalink path first and transparently retrying via the canonical
 * `?rest_route=` query form on a 404. Both URLs are same-origin (built
 * from the same, already-validated `storeUrl`), HTTPS-only (enforced by
 * guardedFetch), and independently SSRF-checked before each request --
 * the fallback is never a different host, never a redirect, never a
 * relaxation of any existing protection.
 */
async function wcRequest(
  storeUrl: string,
  restPath: string,
  init: { method: string; headers?: Record<string, string>; body?: string; query?: Record<string, string> },
): Promise<WcRequestResult> {
  const prettyUrl = new URL(`${storeUrl}/wp-json${restPath}`);
  for (const [k, v] of Object.entries(init.query ?? {})) prettyUrl.searchParams.set(k, v);

  const prettyCheck = await checkUrlSafe(prettyUrl.toString());
  if (!prettyCheck.allowed) throw new Error(`Blocked by SSRF protection: ${prettyCheck.reason}`);
  const prettyRes = await guardedFetch(prettyUrl.toString(), { method: init.method, headers: init.headers ?? {}, body: init.body });

  if (prettyRes.status !== 404) {
    return { status: prettyRes.status, bodyText: prettyRes.bodyText, usedFallback: false };
  }

  const fallbackUrl = new URL(`${storeUrl}/`);
  fallbackUrl.searchParams.set('rest_route', restPath);
  for (const [k, v] of Object.entries(init.query ?? {})) fallbackUrl.searchParams.set(k, v);

  const fallbackCheck = await checkUrlSafe(fallbackUrl.toString());
  if (!fallbackCheck.allowed) throw new Error(`Blocked by SSRF protection: ${fallbackCheck.reason}`);
  const fallbackRes = await guardedFetch(fallbackUrl.toString(), { method: init.method, headers: init.headers ?? {}, body: init.body });

  return { status: fallbackRes.status, bodyText: fallbackRes.bodyText, usedFallback: true };
}

export type WcDiagnosisStage =
  | 'store_unreachable'
  | 'wordpress_rest_unavailable'
  | 'woocommerce_unavailable'
  | 'authentication_failed'
  | 'webhooks_endpoint_unavailable'
  | 'ready';

export type WcDiagnosis = { stage: WcDiagnosisStage; detail: string; storeUrl?: string; usedFallback?: boolean };

/**
 * Phase 9.9.22B -- Part: Test Connection must distinguish store-unreachable
 * from "WordPress is there but WooCommerce's REST API isn't" from
 * "credentials are wrong" from "the webhooks endpoint itself is missing"
 * from success. Never exposes the raw upstream response body (it can
 * contain arbitrary site content/HTML/plugin output) -- only fixed,
 * pre-written, safe detail strings per stage.
 */
export async function diagnoseWooCommerceConnection(rawUrl: string, credentials: ConnectCredentials): Promise<WcDiagnosis> {
  let storeUrl: string;
  try {
    storeUrl = normalizeStoreUrl(rawUrl);
  } catch {
    return { stage: 'store_unreachable', detail: 'Invalid store URL.' };
  }

  const urlCheck = await checkUrlSafe(storeUrl);
  if (!urlCheck.allowed) return { stage: 'store_unreachable', detail: urlCheck.reason };

  let indexRes: WcRequestResult;
  try {
    indexRes = await wcRequest(storeUrl, '/', { method: 'GET' });
  } catch (err) {
    return { stage: 'store_unreachable', detail: err instanceof Error ? err.message : 'Store is unreachable.' };
  }

  if (indexRes.status >= 500) {
    return { stage: 'store_unreachable', detail: `Store returned a server error (${indexRes.status}).` };
  }
  if (indexRes.status === 404) {
    return {
      stage: 'wordpress_rest_unavailable',
      detail: 'The WordPress REST API is not available at this URL (checked both /wp-json/ and the ?rest_route= fallback). Confirm this is a WordPress site.',
    };
  }

  let hasWooCommerce = false;
  try {
    const parsed = JSON.parse(indexRes.bodyText) as { namespaces?: string[] };
    hasWooCommerce = Array.isArray(parsed.namespaces) && parsed.namespaces.includes('wc/v3');
  } catch {
    return { stage: 'wordpress_rest_unavailable', detail: 'Unexpected response from the WordPress REST API index.' };
  }
  if (!hasWooCommerce) {
    return {
      stage: 'woocommerce_unavailable',
      detail: 'WordPress REST API is available, but the WooCommerce REST API (wc/v3) is not registered. Confirm WooCommerce is installed and active on this store.',
    };
  }

  let listRes: WcRequestResult;
  try {
    listRes = await wcRequest(storeUrl, '/wc/v3/webhooks', { method: 'GET', headers: { Authorization: authHeader(credentials) }, query: { per_page: '1' } });
  } catch (err) {
    return { stage: 'store_unreachable', detail: err instanceof Error ? err.message : 'Store became unreachable while checking webhooks.' };
  }

  if (listRes.status === 401 || listRes.status === 403) {
    return { stage: 'authentication_failed', detail: 'WooCommerce rejected these credentials.' };
  }
  if (listRes.status === 404) {
    return {
      stage: 'webhooks_endpoint_unavailable',
      detail: 'WooCommerce\'s REST API is available, but its webhooks endpoint is unavailable on this store even via the compatibility fallback.',
    };
  }
  if (listRes.status >= 400) {
    return { stage: 'store_unreachable', detail: `WooCommerce returned an unexpected error (${listRes.status}).` };
  }

  return { stage: 'ready', detail: 'Store reachable, WooCommerce REST API available, and credentials valid.', storeUrl, usedFallback: listRes.usedFallback };
}

/** Thin wrapper kept for callers that only need the normalized store URL + basic reachability (no credentials yet). Superseded by diagnoseWooCommerceConnection() for anything credential-aware. */
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
    const res = await wcRequest(storeUrl, '/', { method: 'GET' });
    if (res.status >= 500) return { ok: false, reason: `Store returned a server error (${res.status})` };
    if (res.status === 404) return { ok: false, reason: 'The WordPress REST API is not available at this URL (checked both /wp-json/ and the ?rest_route= fallback).' };
    return { ok: true, storeUrl };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Store is unreachable' };
  }
}

/** GET /webhooks (list) -- requires only read scope. Used to confirm the credentials themselves are valid, and (Part K) to de-duplicate before creating a new subscription. */
export async function listWebhooks(storeUrl: string, credentials: ConnectCredentials): Promise<{ ok: true; webhooks: WcWebhook[] } | { ok: false; status: number; reason: string }> {
  const check = await checkUrlSafe(storeUrl);
  if (!check.allowed) return { ok: false, status: 0, reason: check.reason };

  const res = await wcRequest(storeUrl, '/wc/v3/webhooks', { method: 'GET', headers: { Authorization: authHeader(credentials) }, query: { per_page: '100' } });

  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, reason: 'WooCommerce rejected these credentials' };
  }
  if (res.status === 404) {
    return { ok: false, status: res.status, reason: 'WooCommerce\'s webhooks endpoint is unavailable on this store (checked both /wp-json/ and the ?rest_route= fallback)' };
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

/**
 * Phase 9.9.22B -- Live Certification Failure #3: safe delivery-history
 * inspection, used to answer "did WooCommerce actually attempt to deliver
 * this event, and what did IT observe" independently of anything our own
 * receiver logged. The return type deliberately omits request_headers,
 * request_body, response_headers, response_body, and summary (which
 * embeds response body text) -- WooCommerce's own documented fields for
 * this endpoint that can carry payload/credential-adjacent content. Only
 * id/date/duration/destination-url/response-code are ever returned, so a
 * caller cannot accidentally log or display anything sensitive even by
 * mistake.
 */
export type WcWebhookDeliverySafe = { id: number; dateCreated: string; requestUrl: string; responseCode: number | null; durationSeconds: number | null };

export async function listWebhookDeliveries(storeUrl: string, credentials: ConnectCredentials, webhookId: string): Promise<{ ok: true; deliveries: WcWebhookDeliverySafe[] } | { ok: false; status: number; reason: string }> {
  const check = await checkUrlSafe(storeUrl);
  if (!check.allowed) return { ok: false, status: 0, reason: check.reason };

  const res = await wcRequest(storeUrl, `/wc/v3/webhooks/${encodeURIComponent(webhookId)}/deliveries`, {
    method: 'GET',
    headers: { Authorization: authHeader(credentials) },
  });

  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, reason: 'WooCommerce rejected these credentials' };
  }
  if (res.status === 404) {
    // Modern WooCommerce versions may not expose delivery logs via this
    // (documented-deprecated) REST sub-resource at all -- a 404 here means
    // "not available through this API," not "no deliveries occurred."
    return { ok: false, status: res.status, reason: 'Delivery history is not available via the REST API on this store' };
  }
  if (res.status >= 400) {
    return { ok: false, status: res.status, reason: `WooCommerce returned an error listing deliveries (${res.status})` };
  }

  try {
    const parsed = JSON.parse(res.bodyText) as Array<Record<string, unknown>>;
    const safe = (Array.isArray(parsed) ? parsed : []).map((d) => ({
      id: Number(d.id),
      dateCreated: String(d.date_created ?? ''),
      requestUrl: String(d.request_url ?? ''),
      responseCode: typeof d.response_code === 'number' ? d.response_code : null,
      durationSeconds: typeof d.duration === 'number' ? d.duration : null,
    }));
    return { ok: true, deliveries: safe };
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

  const res = await wcRequest(storeUrl, '/wc/v3/webhooks', {
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
  if (res.status === 404) {
    return { ok: false, status: res.status, reason: 'WooCommerce\'s webhooks endpoint is unavailable on this store (checked both /wp-json/ and the ?rest_route= fallback)' };
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
    const res = await wcRequest(storeUrl, `/wc/v3/webhooks/${encodeURIComponent(webhookId)}`, {
      method: 'DELETE',
      headers: { Authorization: authHeader(credentials) },
      query: { force: 'true' },
    });
    // A webhook already deleted externally (Part K) 404s -- not a failure
    // from this connector's point of view, since the end state (no
    // provider-side subscription) is exactly what disconnect wants. This
    // also covers the compatibility-fallback case (both forms 404 because
    // the row is genuinely gone, not because the endpoint is unavailable --
    // indistinguishable from here, and either way there is nothing left to
    // delete).
    if (res.status >= 400 && res.status !== 404) {
      return { ok: false, reason: `WooCommerce rejected the webhook deletion (${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Failed to delete webhook' };
  }
}
