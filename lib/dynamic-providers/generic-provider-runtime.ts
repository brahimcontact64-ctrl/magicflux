import { applyAuthStrategy } from './generic-auth-runtime';
import type { ProviderAdapter } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPathValue(input: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, input);
}

function transformPayload(params: {
  adapter: ProviderAdapter;
  input: Record<string, unknown>;
}): Record<string, unknown> {
  const template = params.adapter.payloadTemplate ?? {};

  if (params.adapter.payloadTransformer?.mode === 'map_fields' && params.adapter.payloadTransformer.mapping) {
    const mapped: Record<string, unknown> = { ...template };
    for (const [to, from] of Object.entries(params.adapter.payloadTransformer.mapping)) {
      mapped[to] = getPathValue(params.input, from);
    }
    return mapped;
  }

  return {
    ...template,
    ...params.input,
  };
}

function transformResponse(params: {
  adapter: ProviderAdapter;
  response: Record<string, unknown>;
}): unknown {
  if (params.adapter.responseTransformer?.mode === 'pick_path' && params.adapter.responseTransformer.path) {
    return getPathValue(params.response, params.adapter.responseTransformer.path);
  }

  return params.response;
}

export async function executeWithProviderAdapter(params: {
  adapter: ProviderAdapter;
  baseUrl: string;
  credentials: Record<string, string>;
  input: Record<string, unknown>;
  headers?: HeadersInit;
}): Promise<{ status: number; data: unknown; latencyMs: number }> {
  const payload = transformPayload({ adapter: params.adapter, input: params.input });

  const retry = params.adapter.retryPolicy ?? {
    attempts: 2,
    baseDelayMs: 500,
    maxDelayMs: 4000,
  };

  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < retry.attempts) {
    attempt += 1;
    try {
      const joinedUrl = new URL(params.adapter.endpoint, params.baseUrl);
      const auth = applyAuthStrategy({
        strategy: params.adapter.auth,
        credentials: params.credentials,
        headers: {
          'Content-Type': 'application/json',
          ...(params.headers ?? {}),
        },
        url: joinedUrl,
      });

      const startedAt = Date.now();
      const res = await fetch(auth.url.toString(), {
        method: params.adapter.method,
        headers: auth.headers,
        body: params.adapter.method === 'GET' ? undefined : JSON.stringify(payload),
      });
      const latencyMs = Date.now() - startedAt;

      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = typeof parsed?.error === 'string' ? parsed.error : `Provider returned ${res.status}`;
        throw new Error(message);
      }

      const data = transformResponse({
        adapter: params.adapter,
        response: parsed as Record<string, unknown>,
      });

      return {
        status: res.status,
        data,
        latencyMs,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= retry.attempts) break;
      const delay = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }

  throw lastError ?? new Error('Provider execution failed');
}
