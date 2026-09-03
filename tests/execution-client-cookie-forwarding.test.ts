/**
 * Phase 9.5 Step H — two real, compounding bugs found live in
 * app/executions/[id]/page.tsx and app/executions/page.tsx's MetricsPanel,
 * both Server Components that call into lib/execution/client.ts:
 *
 * 1. A relative fetch() from a Server Component in this Next.js runtime is
 *    NOT resolved against the deployment's own origin -- Node's underlying
 *    fetch (undici) throws "TypeError: Failed to parse URL from
 *    /api/executions/..." outright. Confirmed live via a server-log stack
 *    trace. A browser's fetch() has no such problem (a client component's
 *    relative URL resolves against the current page origin natively), so
 *    only the server-side call needs an absolute URL -- resolveUrl() below
 *    is a no-op when `window` exists.
 *
 * 2. Server-side fetch() also has no browser cookie jar to auto-attach the
 *    visitor's session with, unlike a client component's fetch() -- so the
 *    internal call was also unauthenticated. extraHeaders exists so a
 *    Server Component can forward the incoming request's cookie.
 *
 * Bug 1 masked bug 2 in earlier manual testing (a relative-URL fetch that
 * throws immediately never gets far enough to reveal a missing-cookie
 * 404), and both were in turn masked by an unrelated auth-guard crash
 * (see get-user-from-request-headers-shape.test.ts) that always fired
 * first until this same audit fixed it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
const ORIGINAL_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env.NEXT_PUBLIC_SITE_URL = 'https://www.magicflux.ai';
});

afterEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_SITE_URL;
});

describe('fetchExecutionDetail -- server-side calls use an absolute URL, not a bare relative path', () => {
  it('resolves against NEXT_PUBLIC_SITE_URL (vitest runs with no `window`, i.e. the server branch)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ execution: { id: 'exec-1' } }) });
    const { fetchExecutionDetail } = await import('../lib/execution/client');

    await fetchExecutionDetail('exec-1');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://www.magicflux.ai/api/executions/exec-1');
  });

  it('forwards extraHeaders (the cookie) to the underlying fetch call when provided', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ execution: { id: 'exec-1' } }) });
    const { fetchExecutionDetail } = await import('../lib/execution/client');

    await fetchExecutionDetail('exec-1', { cookie: 'mf_access_token=abc123' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toEqual({ cookie: 'mf_access_token=abc123' });
  });

  it('omitting extraHeaders forces no headers in (client-component callers are unaffected)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ execution: { id: 'exec-1' } }) });
    const { fetchExecutionDetail } = await import('../lib/execution/client');

    await fetchExecutionDetail('exec-1');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toBeUndefined();
  });
});

describe('fetchExecutionMetrics -- server-side calls use an absolute URL and forward cookies', () => {
  it('resolves against NEXT_PUBLIC_SITE_URL and forwards extraHeaders', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ metrics: {}, window_days: 30 }) });
    const { fetchExecutionMetrics } = await import('../lib/execution/client');

    await fetchExecutionMetrics(undefined, 30, { cookie: 'mf_access_token=abc123' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://www.magicflux.ai/api/executions/metrics?days=30');
    expect(init.headers).toEqual({ cookie: 'mf_access_token=abc123' });
  });
});

describe('fetchExecutions -- also resolves an absolute URL server-side (future-proofing, no server caller today)', () => {
  it('resolves against NEXT_PUBLIC_SITE_URL', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ executions: [], total: 0 }) });
    const { fetchExecutions } = await import('../lib/execution/client');

    await fetchExecutions({}, 1, 20);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/www\.magicflux\.ai\/api\/executions/);
  });
});
