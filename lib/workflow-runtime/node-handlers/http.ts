import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';
import { checkUrlSafe } from './ssrf-guard';

function getParam(node: EngineNode, keys: string[]): string {
  const params = node.parameters ?? {};
  for (const key of keys) {
    const val = params[key];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return '';
}

function getNumParam(node: EngineNode, key: string, fallback: number): number {
  const val = (node.parameters ?? {})[key];
  if (typeof val === 'number' && isFinite(val)) return val;
  const n = Number(val);
  return isFinite(n) ? n : fallback;
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function parseJsonParam(node: EngineNode, key: string): Record<string, unknown> | undefined {
  const raw = (node.parameters ?? {})[key];
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const RETRYABLE_ATTEMPTS = 3; // 1 initial attempt + 2 retries
const RETRY_DELAY_MS = [500, 1500];
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = Number(process.env.RUNTIME_HTTP_MAX_RESPONSE_BYTES ?? 5 * 1024 * 1024); // 5MB default

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response body exceeded the ${limit}-byte limit`);
    this.name = 'ResponseTooLargeError';
  }
}

/** Reads a response body up to `maxBytes`, aborting the stream if exceeded rather than buffering unbounded. */
async function readBodyWithLimit(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new ResponseTooLargeError(maxBytes);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

type GuardedResponse = { res: Response; bodyText: string; finalUrl: string };

/**
 * fetch() with SSRF protection: validates the target (and every redirect hop)
 * against lib/workflow-runtime/node-handlers/ssrf-guard.ts before connecting,
 * follows redirects manually (never trusts fetch's built-in follower) so each
 * hop is re-checked, and caps the response body size instead of buffering an
 * unbounded stream. See ssrf-guard.ts for the documented threat model and the
 * one residual (DNS-rebinding) gap this does not close.
 */
async function guardedFetch(
  initialUrl: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
): Promise<GuardedResponse> {
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
        return { res, bodyText, finalUrl: currentUrl };
      }
      if (hop === MAX_REDIRECTS) {
        throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    const bodyText = await readBodyWithLimit(res, MAX_RESPONSE_BYTES);
    return { res, bodyText, finalUrl: currentUrl };
  }

  throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}

export async function httpHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const data = asRecord(inputData);

  const url = getParam(node, ['url']);
  const method = (getParam(node, ['method']) || 'GET').toUpperCase();
  const headers = parseJsonParam(node, 'headers') ?? {};
  const body = parseJsonParam(node, 'body');
  const timeoutMs = getNumParam(node, 'timeout', 10000);

  if (!url) {
    return { status: 'failed', outputData: null, logs: ['HTTP: url is required'], error: 'url is required' };
  }

  const preview = { nodeName: node.name ?? node.id, method, url, headers, body };

  if (context.mode === 'test') {
    logs.push(`HTTP ${method} ${url} simulated in test mode.`);
    return {
      status: 'simulated_success',
      outputData: { ...data, http_preview: preview },
      logs,
    };
  }

  const requestHeaders: Record<string, string> = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, String(v)])
  );

  // Generic/custom API-key credential: inject its header only when the node
  // didn't already set that header explicitly — an explicit header always wins.
  const customIntegration = context.integrations.find((i) => i.provider === 'custom');
  const customCreds = customIntegration?.credentials as Record<string, string> | undefined;
  if (customCreds?.api_key && customCreds.header_name) {
    const alreadySet = Object.keys(requestHeaders).some((h) => h.toLowerCase() === customCreds.header_name.toLowerCase());
    if (!alreadySet) {
      const value = customCreds.prefix ? `${customCreds.prefix} ${customCreds.api_key}` : customCreds.api_key;
      requestHeaders[customCreds.header_name] = value;
      logs.push(`Injected credential "${customCreds.name ?? 'custom'}" into ${customCreds.header_name} header.`);
    }
  }

  const hasBody = body !== undefined && !['GET', 'HEAD'].includes(method);
  if (hasBody && !Object.keys(requestHeaders).some((h) => h.toLowerCase() === 'content-type')) {
    requestHeaders['Content-Type'] = 'application/json';
  }

  // Pre-flight SSRF check on the initial URL — fails fast (and without
  // consuming a retry attempt) for an obviously blocked target. Every
  // redirect hop is re-checked inside guardedFetch() regardless.
  const preflight = await checkUrlSafe(url);
  if (!preflight.allowed) {
    const msg = `Blocked by SSRF protection: ${preflight.reason}`;
    logs.push(msg);
    return { status: 'failed', outputData: null, logs, error: msg };
  }

  let lastError: string = 'HTTP request failed';

  for (let attempt = 1; attempt <= RETRYABLE_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const { res, bodyText, finalUrl } = await guardedFetch(url, {
        method,
        headers: requestHeaders,
        body: hasBody ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const contentType = res.headers.get('content-type') ?? '';
      let responseBody: unknown = bodyText;
      if (contentType.includes('application/json')) {
        try {
          responseBody = JSON.parse(bodyText);
        } catch {
          responseBody = null;
        }
      }

      if (!res.ok) {
        if (isRetryableStatus(res.status) && attempt < RETRYABLE_ATTEMPTS) {
          logs.push(`HTTP ${method} ${finalUrl} returned ${res.status} (attempt ${attempt}/${RETRYABLE_ATTEMPTS}) — retrying.`);
          await sleep(RETRY_DELAY_MS[attempt - 1] ?? RETRY_DELAY_MS[RETRY_DELAY_MS.length - 1]);
          continue;
        }
        lastError = `HTTP ${res.status}: ${typeof responseBody === 'string' ? responseBody.slice(0, 200) : JSON.stringify(responseBody).slice(0, 200)}`;
        logs.push(`HTTP ${method} ${finalUrl} failed: ${lastError}`);
        return { status: 'failed', outputData: { status: res.status, body: responseBody }, logs, error: lastError };
      }

      logs.push(`HTTP ${method} ${finalUrl} → ${res.status}${attempt > 1 ? ` (succeeded on attempt ${attempt})` : ''}.`);
      return {
        status: 'success',
        outputData: { ...data, status: res.status, headers: Object.fromEntries(res.headers.entries()), body: responseBody },
        logs,
      };
    } catch (err) {
      clearTimeout(timer);
      const aborted = err instanceof Error && err.name === 'AbortError';
      lastError = aborted ? `Request timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err);

      // SSRF blocks and response-too-large are not transient — never retry them.
      const nonRetryable = err instanceof ResponseTooLargeError || (err instanceof Error && err.message.startsWith('Blocked by SSRF protection'));
      if (!nonRetryable && attempt < RETRYABLE_ATTEMPTS) {
        logs.push(`HTTP ${method} ${url} error (attempt ${attempt}/${RETRYABLE_ATTEMPTS}): ${lastError} — retrying.`);
        await sleep(RETRY_DELAY_MS[attempt - 1] ?? RETRY_DELAY_MS[RETRY_DELAY_MS.length - 1]);
        continue;
      }
      if (nonRetryable) break;
    }
  }

  logs.push(`HTTP ${method} ${url} failed after ${RETRYABLE_ATTEMPTS} attempts: ${lastError}`);
  return { status: 'failed', outputData: null, logs, error: lastError };
}
