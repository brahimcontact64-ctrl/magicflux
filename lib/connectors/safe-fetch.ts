/**
 * Phase 9.9.22 -- SSRF-guarded fetch for platform connector adapters
 * (WooCommerce today; any future adapter that calls out to a
 * user-supplied store URL). Mirrors lib/workflow-runtime/node-handlers/
 * http.ts's own guardedFetch() exactly (SSRF pre-check on every hop,
 * manual redirect following, bounded response size) without importing
 * from or modifying that certified execution-path module -- connector
 * adapters are a separate trust boundary (Part O: "connector ingestion
 * must terminate at the existing runtime boundary," not reach INTO it).
 */

import { checkUrlSafe } from '@/lib/workflow-runtime/node-handlers/ssrf-guard';

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB -- generous for a REST API JSON response, never unbounded

async function readBodyWithLimit(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) throw new Error('Response exceeded the maximum allowed size');
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

export type GuardedFetchResult = { status: number; bodyText: string; finalUrl: string };

/** Requires HTTPS unless RUNTIME_HTTP_ALLOW_PRIVATE_NETWORKS is explicitly set (test/dev only -- see ssrf-guard.ts). */
function requireHttps(rawUrl: string): void {
  if (process.env.RUNTIME_HTTP_ALLOW_PRIVATE_NETWORKS === 'true') return;
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error('Store URL must use HTTPS');
  }
}

export async function guardedFetch(
  initialUrl: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<GuardedFetchResult> {
  requireHttps(initialUrl);
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await checkUrlSafe(currentUrl);
    if (!check.allowed) {
      throw new Error(`Blocked by SSRF protection: ${check.reason}`);
    }

    const res = await fetch(currentUrl, { ...init, redirect: 'manual' });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        const bodyText = await readBodyWithLimit(res, MAX_RESPONSE_BYTES);
        return { status: res.status, bodyText, finalUrl: currentUrl };
      }
      if (hop === MAX_REDIRECTS) {
        throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
      }
      // Every hop is re-validated against SSRF AND re-required to be HTTPS --
      // a 200 from an allowed host that redirects to a private/internal
      // target, or downgrades to plain HTTP, is blocked, not silently followed.
      currentUrl = new URL(location, currentUrl).toString();
      requireHttps(currentUrl);
      continue;
    }

    const bodyText = await readBodyWithLimit(res, MAX_RESPONSE_BYTES);
    return { status: res.status, bodyText, finalUrl: currentUrl };
  }

  throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}

export { checkUrlSafe };
