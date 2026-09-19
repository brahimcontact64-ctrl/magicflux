import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Incident 9.9.17E -- root cause: acknowledgmentUrl() read
 * `process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'`. Vercel had
 * NEXT_PUBLIC_SITE_URL set; the Railway worker (where this function actually
 * runs -- see lib/workflow-runtime/node-handlers/wait-for-acknowledgment.ts)
 * did not, so a real Sigma Plus Hot lead's production acknowledgment email
 * silently linked to http://localhost:3000/... instead of failing loudly.
 *
 * lib/config/public-origin.ts is the one canonical, validated source these
 * tests certify: production must never silently produce a localhost/private/
 * http link -- it must fail closed instead.
 */

describe('getPublicOrigin (Incident 9.9.17E)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('production + valid https NEXT_PUBLIC_SITE_URL -> returns it exactly', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://www.magicflux.ai');
    const { getPublicOrigin } = await import('@/lib/config/public-origin');
    expect(getPublicOrigin()).toBe('https://www.magicflux.ai');
  });

  it('production + trailing slash -> normalized (no trailing slash)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://www.magicflux.ai/');
    const { getPublicOrigin } = await import('@/lib/config/public-origin');
    expect(getPublicOrigin()).toBe('https://www.magicflux.ai');
  });

  it('development with no NEXT_PUBLIC_SITE_URL -> localhost fallback is intentional and allowed', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    const { getPublicOrigin } = await import('@/lib/config/public-origin');
    expect(getPublicOrigin()).toBe('http://localhost:3000');
  });

  it('production + missing NEXT_PUBLIC_SITE_URL -> fails closed (throws), never a localhost link', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    const { getPublicOrigin } = await import('@/lib/config/public-origin');
    expect(() => getPublicOrigin()).toThrow(/not configured/i);
  });

  it('production + NEXT_PUBLIC_SITE_URL=localhost -> fails closed (the exact incident)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://localhost:3000');
    const { getPublicOrigin } = await import('@/lib/config/public-origin');
    expect(() => getPublicOrigin()).toThrow(/localhost|private/i);
  });

  it('production + a private/internal hostname -> fails closed', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://192.168.1.50');
    const { getPublicOrigin } = await import('@/lib/config/public-origin');
    expect(() => getPublicOrigin()).toThrow(/localhost|private/i);
  });

  it('production + http:// (not https) -> fails closed', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://www.magicflux.ai');
    const { getPublicOrigin } = await import('@/lib/config/public-origin');
    expect(() => getPublicOrigin()).toThrow(/https/i);
  });

  it('production + unparseable NEXT_PUBLIC_SITE_URL -> fails closed', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'not a url');
    const { getPublicOrigin } = await import('@/lib/config/public-origin');
    expect(() => getPublicOrigin()).toThrow(/not a valid URL/i);
  });

  it('takes no request/headers input at all -- a poisoned Host header cannot influence it by construction', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://www.magicflux.ai');
    const { getPublicOrigin } = await import('@/lib/config/public-origin');
    // The function signature itself is the proof: zero parameters, so there
    // is no Host header (or anything else request-derived) it could read.
    expect(getPublicOrigin.length).toBe(0);
    expect(getPublicOrigin()).toBe('https://www.magicflux.ai');
  });
});

describe('acknowledgmentUrl (Incident 9.9.17E -- the actual reported bug)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('production -> https://www.magicflux.ai/api/acknowledgments/<id>/ack?token=<token>', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://www.magicflux.ai');
    const { acknowledgmentUrl } = await import('@/lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    const url = acknowledgmentUrl('exec-123', 'tok-abc');
    expect(url).toBe('https://www.magicflux.ai/api/acknowledgments/exec-123/ack?token=tok-abc');
  });

  it('local development -> intentionally uses localhost', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    const { acknowledgmentUrl } = await import('@/lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    const url = acknowledgmentUrl('exec-123', 'tok-abc');
    expect(url).toBe('http://localhost:3000/api/acknowledgments/exec-123/ack?token=tok-abc');
  });

  it('production + missing origin -> throws rather than generating a localhost link (the exact incident, at the call site that actually mails it)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    const { acknowledgmentUrl } = await import('@/lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    expect(() => acknowledgmentUrl('exec-123', 'tok-abc')).toThrow();
  });

  it('production + NEXT_PUBLIC_SITE_URL=localhost -> throws rather than generating the exact broken link this incident shipped', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://localhost:3000');
    const { acknowledgmentUrl } = await import('@/lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    expect(() => acknowledgmentUrl('exec-123', 'tok-abc')).toThrow();
  });

  it('the token appears in the URL only as the caller-supplied plaintext -- this function does not hash, log, or otherwise persist it', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://www.magicflux.ai');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { acknowledgmentUrl } = await import('@/lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    const token = 'super-secret-token-value';
    acknowledgmentUrl('exec-123', token);
    const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(' ');
    expect(allLoggedText).not.toContain(token);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
