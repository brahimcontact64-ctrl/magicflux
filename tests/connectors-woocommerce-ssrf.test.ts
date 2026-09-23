/**
 * Phase 9.9.22 -- Part E/M: SSRF protections for the WooCommerce connector's
 * store-URL validation and every subsequent REST API call. Mocks node:dns
 * (matching tests/ssrf-guard.test.ts's own convention) and global fetch, so
 * these run deterministically with no real network access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const lookupMock = vi.fn();
vi.mock('node:dns', () => ({
  promises: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  lookupMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RUNTIME_HTTP_ALLOW_PRIVATE_NETWORKS;
});

describe('validateStoreUrlReachable() -- SSRF protections', () => {
  it('rejects a store URL resolving to a private/internal IP (RFC1918)', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5' }]);
    const { validateStoreUrlReachable } = await import('@/lib/connectors/woocommerce/client');
    const result = await validateStoreUrlReachable('https://internal-store.example.com');
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a store URL resolving to the cloud metadata endpoint (169.254.169.254)', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254' }]);
    const { validateStoreUrlReachable } = await import('@/lib/connectors/woocommerce/client');
    const result = await validateStoreUrlReachable('https://metadata-lookalike.example.com');
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a literal loopback IP given directly as the store URL', async () => {
    const { validateStoreUrlReachable } = await import('@/lib/connectors/woocommerce/client');
    const result = await validateStoreUrlReachable('https://127.0.0.1');
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a plain-HTTP store URL (HTTPS required in production)', async () => {
    lookupMock.mockResolvedValue([{ address: '203.0.113.10' }]); // public TEST-NET-3 address
    const { validateStoreUrlReachable } = await import('@/lib/connectors/woocommerce/client');
    const result = await validateStoreUrlReachable('http://store.example.com');
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid URL without throwing', async () => {
    const { validateStoreUrlReachable } = await import('@/lib/connectors/woocommerce/client');
    const result = await validateStoreUrlReachable('not a url at all');
    expect(result.ok).toBe(false);
  });

  it('allows a public HTTPS store URL that resolves to a public address', async () => {
    lookupMock.mockResolvedValue([{ address: '203.0.113.10' }]);
    fetchMock.mockResolvedValue({ status: 200, headers: { get: () => null }, body: null, text: async () => '{}' });
    const { validateStoreUrlReachable } = await import('@/lib/connectors/woocommerce/client');
    const result = await validateStoreUrlReachable('https://real-store.example.com');
    expect(result.ok).toBe(true);
  });

  it('blocks a redirect from a public host to a private/internal target -- each hop is re-validated', async () => {
    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === 'public-facade.example.com') return [{ address: '203.0.113.20' }];
      throw new Error('unexpected hostname in test');
    });
    fetchMock.mockResolvedValueOnce({
      status: 302,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'https://169.254.169.254/latest/meta-data' : null) },
      body: null,
      text: async () => '',
    });
    const { validateStoreUrlReachable } = await import('@/lib/connectors/woocommerce/client');
    const result = await validateStoreUrlReachable('https://public-facade.example.com');
    expect(result.ok).toBe(false);
    // Only the first hop's request was ever made -- the redirect target was
    // rejected before a second fetch to the metadata endpoint could happen.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolution failure (unresolvable hostname) fails closed, not open', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    const { validateStoreUrlReachable } = await import('@/lib/connectors/woocommerce/client');
    const result = await validateStoreUrlReachable('https://does-not-exist.invalid');
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createWebhook()/listWebhooks() also SSRF-guard every call, not just the initial validation', () => {
  it('listWebhooks() refuses to call a store URL that now resolves to a private address', async () => {
    lookupMock.mockResolvedValue([{ address: '192.168.1.1' }]);
    const { listWebhooks } = await import('@/lib/connectors/woocommerce/client');
    const result = await listWebhooks('https://store.example.com', { storeUrl: 'https://store.example.com', consumerKey: 'ck', consumerSecret: 'cs' });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
