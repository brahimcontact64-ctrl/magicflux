/**
 * SSRF guard tests (lib/workflow-runtime/node-handlers/ssrf-guard.ts).
 *
 * isBlockedAddress is pure — tested directly against real IP literals.
 * checkHostnameSafe/checkUrlSafe depend on DNS resolution, which is mocked
 * (node:dns) so these run deterministically without real network access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const lookupMock = vi.fn();

vi.mock('node:dns', () => ({
  promises: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

afterEach(() => {
  delete process.env.RUNTIME_HTTP_ALLOW_PRIVATE_NETWORKS;
  vi.clearAllMocks();
});

// ─── isBlockedAddress — pure, no mocking needed ────────────────────────────────

describe('isBlockedAddress — IPv4', () => {
  it.each([
    ['127.0.0.1', true, 'loopback'],
    ['127.255.255.255', true, 'loopback range'],
    ['10.0.0.1', true, 'RFC1918 10/8'],
    ['172.16.0.1', true, 'RFC1918 172.16/12'],
    ['172.31.255.255', true, 'RFC1918 172.16/12 upper bound'],
    ['192.168.1.1', true, 'RFC1918 192.168/16'],
    ['169.254.169.254', true, 'AWS/GCP/Azure metadata endpoint'],
    ['169.254.0.1', true, 'link-local'],
    ['100.64.0.1', true, 'CGNAT'],
    ['0.0.0.0', true, '"this network"'],
    ['224.0.0.1', true, 'multicast'],
    ['8.8.8.8', false, 'public DNS — allowed'],
    ['1.1.1.1', false, 'public DNS — allowed'],
    ['172.15.255.255', false, 'just below RFC1918 172.16/12'],
    ['172.32.0.0', false, 'just above RFC1918 172.16/12'],
  ])('%s → blocked=%s (%s)', async (ip, expected) => {
    const { isBlockedAddress } = await import('../lib/workflow-runtime/node-handlers/ssrf-guard');
    expect(isBlockedAddress(ip)).toBe(expected);
  });
});

describe('isBlockedAddress — IPv6', () => {
  it.each([
    ['::1', true, 'loopback'],
    ['::', true, 'unspecified'],
    ['fe80::1', true, 'link-local fe80::/10'],
    ['febf:ffff::1', true, 'link-local fe80::/10 upper bound'],
    ['fc00::1', true, 'unique local fc00::/7'],
    ['fd12:3456::1', true, 'unique local fc00::/7'],
    ['::ffff:127.0.0.1', true, 'IPv4-mapped loopback — must unwrap and check'],
    ['::ffff:169.254.169.254', true, 'IPv4-mapped metadata endpoint — must unwrap and check'],
    ['::ffff:8.8.8.8', false, 'IPv4-mapped public address'],
    ['2001:4860:4860::8888', false, 'public IPv6 (Google DNS)'],
  ])('%s → blocked=%s (%s)', async (ip, expected) => {
    const { isBlockedAddress } = await import('../lib/workflow-runtime/node-handlers/ssrf-guard');
    expect(isBlockedAddress(ip)).toBe(expected);
  });
});

// ─── checkHostnameSafe / checkUrlSafe — mocked DNS ─────────────────────────────

// NOTE: mock reset is done inline at the top of each test body, not via
// beforeEach(() => lookupMock.mockReset()) — that combination with a
// rejected mock configured later in the same test triggers an unrelated
// Vitest/Node timing quirk that surfaces the rejection as an uncaught test
// error even though the application code (checkHostnameSafe) genuinely
// catches it — verified by isolated bisection. Inline reset avoids it.

describe('checkHostnameSafe', () => {
  it('allows a hostname that resolves only to public addresses', async () => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const { checkHostnameSafe } = await import('../lib/workflow-runtime/node-handlers/ssrf-guard');
    const result = await checkHostnameSafe('example.com');
    expect(result.allowed).toBe(true);
  });

  it('blocks a hostname where ANY resolved address is private — not just the first', async () => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    const { checkHostnameSafe } = await import('../lib/workflow-runtime/node-handlers/ssrf-guard');
    const result = await checkHostnameSafe('attacker-controlled-dns.example');
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain('169.254.169.254');
  });

  it('fails closed when DNS resolution fails (unresolvable is not a legitimate target)', async () => {
    lookupMock.mockReset();
    lookupMock.mockImplementation(() => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })));
    const { checkHostnameSafe } = await import('../lib/workflow-runtime/node-handlers/ssrf-guard');
    const result = await checkHostnameSafe('does-not-exist.invalid');
    expect(result.allowed).toBe(false);
  });

  it('validates a raw IPv4 literal directly, without a DNS lookup', async () => {
    lookupMock.mockReset();
    const { checkHostnameSafe } = await import('../lib/workflow-runtime/node-handlers/ssrf-guard');
    const result = await checkHostnameSafe('127.0.0.1');
    expect(result.allowed).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('respects RUNTIME_HTTP_ALLOW_PRIVATE_NETWORKS=true as an explicit opt-out (documented policy layer)', async () => {
    lookupMock.mockReset();
    process.env.RUNTIME_HTTP_ALLOW_PRIVATE_NETWORKS = 'true';
    const { checkHostnameSafe } = await import('../lib/workflow-runtime/node-handlers/ssrf-guard');
    const result = await checkHostnameSafe('127.0.0.1');
    expect(result.allowed).toBe(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe('checkUrlSafe', () => {
  it('rejects non-http(s) schemes before any DNS lookup (e.g. file://, gopher://)', async () => {
    lookupMock.mockReset();
    const { checkUrlSafe } = await import('../lib/workflow-runtime/node-handlers/ssrf-guard');
    const result = await checkUrlSafe('file:///etc/passwd');
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain('scheme');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed URL', async () => {
    lookupMock.mockReset();
    const { checkUrlSafe } = await import('../lib/workflow-runtime/node-handlers/ssrf-guard');
    const result = await checkUrlSafe('not a url');
    expect(result.allowed).toBe(false);
  });

  it('allows a well-formed https URL to a public host', async () => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const { checkUrlSafe } = await import('../lib/workflow-runtime/node-handlers/ssrf-guard');
    const result = await checkUrlSafe('https://example.com/api/data');
    expect(result.allowed).toBe(true);
  });

  it('blocks a URL whose host is a metadata-endpoint IP literal', async () => {
    lookupMock.mockReset();
    const { checkUrlSafe } = await import('../lib/workflow-runtime/node-handlers/ssrf-guard');
    const result = await checkUrlSafe('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
    expect(result.allowed).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blocks a URL using a bracketed IPv6 metadata-mapped literal', async () => {
    lookupMock.mockReset();
    const { checkUrlSafe } = await import('../lib/workflow-runtime/node-handlers/ssrf-guard');
    const result = await checkUrlSafe('http://[::ffff:169.254.169.254]/');
    expect(result.allowed).toBe(false);
  });
});

// ─── Redirect-to-private-IP SSRF (Phase 8.4 regression test) ──────────────────
//
// Phase 8.3's audit found that lib/workflow-runtime/node-handlers/http.ts's
// guardedFetch() re-checks checkUrlSafe() on every redirect hop (never trusts
// fetch's built-in follower) at the CODE level, but no automated test proved
// it. This drives the real httpHandler (not guardedFetch directly — it isn't
// exported) with a mocked global fetch that returns a 302 pointing at a
// private/metadata IP, proving the SSRF-blocked redirect target is never
// actually connected to.

describe('httpHandler — redirect-to-private-IP SSRF regression', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    lookupMock.mockReset();
  });

  it('blocks a redirect chain that points from a public URL to the cloud metadata endpoint, and never connects to it', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]); // the initial public host resolves fine

    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://public-looking-site.example/redirect') {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' } });
      }
      // If the guard failed to block the hop, this branch would be reached —
      // fail the test loudly rather than silently returning attacker-controlled data.
      throw new Error(`TEST FAILURE: fetch() was called against the redirect target — SSRF guard did not block the hop (url=${url})`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    const result = await httpHandler(
      { type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://public-looking-site.example/redirect', method: 'GET' } },
      {},
      { mode: 'live', integrations: [], sampleData: {} },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Blocked by SSRF protection/);
    // Exactly one fetch call — the initial public hop. The redirect target was never fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('blocks a redirect chain that points from a public URL to an RFC1918 private address', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://public-looking-site.example/redirect') {
        return new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/internal-admin' } });
      }
      throw new Error(`TEST FAILURE: fetch() was called against the redirect target — SSRF guard did not block the hop (url=${url})`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    const result = await httpHandler(
      { type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://public-looking-site.example/redirect', method: 'GET' } },
      {},
      { mode: 'live', integrations: [], sampleData: {} },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Blocked by SSRF protection/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows a redirect chain where every hop resolves to a public address', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://public-looking-site.example/redirect') {
        return new Response(null, { status: 302, headers: { location: 'https://public-looking-site.example/final' } });
      }
      if (url === 'https://public-looking-site.example/final') {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    const result = await httpHandler(
      { type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://public-looking-site.example/redirect', method: 'GET' } },
      {},
      { mode: 'live', integrations: [], sampleData: {} },
    );

    expect(result.status).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(2); // both hops legitimately followed
  });
});
