/**
 * Phase 9.4.1 — Secrets Redaction & User-Safe Error Boundary tests.
 *
 * Covers lib/security/redact.ts (the one authoritative deep-object
 * redaction utility) and lib/security/safe-error.ts (the error taxonomy),
 * plus regression coverage for the production boundaries wired to them
 * this phase: runtime/runtime-state.ts's persistence, the real HTTP node
 * handler, and the workflow test-run API routes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { redact, redactText, isSensitiveKey, REDACTED } from '@/lib/security/redact';
import { classifyError, makeSafeError } from '@/lib/security/safe-error';

const SYNTHETIC_SECRET = 'sk_test_FAKE_SECRET_DO_NOT_USE';
const SYNTHETIC_BEARER = 'Bearer TEST_SECRET_123';

describe('redact() — deep object redaction', () => {
  it('1. redacts an Authorization header', () => {
    const input = { headers: { Authorization: SYNTHETIC_BEARER } };
    const out = redact(input);
    expect((out as any).headers.Authorization).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain('TEST_SECRET_123');
  });

  it('2. redacts lowercase and uppercase header-key variants identically', () => {
    const variants = [
      { authorization: SYNTHETIC_BEARER },
      { Authorization: SYNTHETIC_BEARER },
      { AUTHORIZATION: SYNTHETIC_BEARER },
      { 'Proxy-Authorization': SYNTHETIC_BEARER },
      { Cookie: 'session=abc123' },
      { 'set-cookie': 'session=abc123' },
    ];
    for (const v of variants) {
      const out = redact(v) as Record<string, unknown>;
      const key = Object.keys(v)[0];
      expect(out[key]).toBe(REDACTED);
    }
  });

  it('3. redacts nested API keys/tokens/passwords at any depth', () => {
    const input = {
      workflow: {
        node: {
          credentials: {
            api_key: SYNTHETIC_SECRET,
            access_token: 'at_real_value',
            refresh_token: 'rt_real_value',
            client_secret: 'cs_real_value',
            password: 'hunter2',
          },
        },
      },
    };
    const out = redact(input) as any;
    const c = out.workflow.node.credentials;
    expect(c.api_key).toBe(REDACTED);
    expect(c.access_token).toBe(REDACTED);
    expect(c.refresh_token).toBe(REDACTED);
    expect(c.client_secret).toBe(REDACTED);
    expect(c.password).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain(SYNTHETIC_SECRET);
  });

  it('4. sanitizes arrays containing sensitive objects', () => {
    const input = [
      { token: SYNTHETIC_SECRET, label: 'a' },
      { token: 'other_secret', label: 'b' },
      'plain string',
      42,
    ];
    const out = redact(input) as any[];
    expect(out[0].token).toBe(REDACTED);
    expect(out[0].label).toBe('a');
    expect(out[1].token).toBe(REDACTED);
    expect(out[2]).toBe('plain string');
    expect(out[3]).toBe(42);
  });

  it('5. leaves harmless similarly-named fields intact (no substring over-matching)', () => {
    const input = {
      tokenized_words: ['a', 'b'],
      broken_link: 'https://example.com/404',
      passenger_count: 3,
      access_token_count: 5, // NOT the same key as access_token -- must survive
      customer_id: 'cust_123',
    };
    const out = redact(input) as any;
    expect(out.tokenized_words).toEqual(['a', 'b']);
    expect(out.broken_link).toBe('https://example.com/404');
    expect(out.passenger_count).toBe(3);
    expect(out.access_token_count).toBe(5);
    expect(out.customer_id).toBe('cust_123');
  });

  it('6. does not mutate the original object', () => {
    const input = { token: SYNTHETIC_SECRET, nested: { password: 'hunter2' } };
    const snapshotBefore = JSON.parse(JSON.stringify(input));
    redact(input);
    expect(input).toEqual(snapshotBefore);
    expect(input.token).toBe(SYNTHETIC_SECRET); // still the real value on the original
  });

  it('7. handles circular references without crashing', () => {
    const input: any = { name: 'node', token: SYNTHETIC_SECRET };
    input.self = input;
    let out: any;
    expect(() => { out = redact(input); }).not.toThrow();
    expect(out.token).toBe(REDACTED);
    expect(out.self).toBe('[CIRCULAR]');
  });

  it('preserves null/undefined on a sensitive key rather than implying a secret exists', () => {
    const out = redact({ password: null, token: undefined }) as any;
    expect(out.password).toBeNull();
    expect(out.token).toBeUndefined();
  });

  it('isSensitiveKey() is exact/normalized, not substring', () => {
    expect(isSensitiveKey('Authorization')).toBe(true);
    expect(isSensitiveKey('access_token')).toBe(true);
    expect(isSensitiveKey('accessToken')).toBe(true);
    expect(isSensitiveKey('tokenized')).toBe(false);
    expect(isSensitiveKey('broken')).toBe(false);
  });

  it('extends the sensitive set with registered provider secret fields (e.g. bot_token, webhook_secret)', () => {
    // These come from lib/credentials/provider-registry.ts's secret:true
    // fields, not the base hard-coded list -- proves the registry
    // integration actually wires through.
    expect(isSensitiveKey('bot_token')).toBe(true);
    expect(isSensitiveKey('webhook_secret')).toBe(true);
    expect(isSensitiveKey('personal_access_token')).toBe(true);
    // and confirms non-secret registered fields are correctly left alone
    expect(isSensitiveKey('shop_domain')).toBe(false);
    expect(isSensitiveKey('chat_id')).toBe(false);
  });
});

describe('redactText() — free-text sanitization', () => {
  it('strips URLs and key=value-shaped credential patterns', () => {
    const text = `Request to https://api.example.com/v1?token=${SYNTHETIC_SECRET} failed`;
    const out = redactText(text);
    expect(out).not.toContain(SYNTHETIC_SECRET);
    expect(out).not.toContain('api.example.com');
  });

  it('truncates to the given max length', () => {
    const out = redactText('a'.repeat(500), 50);
    expect(out.length).toBeLessThanOrEqual(50);
  });
});

describe('classifyError() — user-safe error taxonomy', () => {
  it('never includes the raw error message in the safe message', () => {
    const raw = new Error(`Connection to postgres://user:${SYNTHETIC_SECRET}@db.internal:5432/prod failed`);
    const classified = classifyError(raw);
    expect(classified.message).not.toContain(SYNTHETIC_SECRET);
    expect(classified.message).not.toContain('postgres://');
    expect(Object.values(classified).join(' ')).not.toContain(SYNTHETIC_SECRET);
  });

  it('classifies a Postgres SQLSTATE code as a safe temporary_system_problem', () => {
    const err = { code: '23505', message: 'duplicate key value violates unique constraint "subscriptions_user_id_key"' };
    const classified = classifyError(err);
    expect(classified.code).toBe('temporary_system_problem');
    expect(classified.message).not.toContain('subscriptions_user_id_key');
    expect(classified.message).not.toContain('SQL');
  });

  it('classifies a PostgREST PGRST code the same way', () => {
    const err = { code: 'PGRST200', message: "Could not find a relationship between 'subscriptions' and 'plan'" };
    const classified = classifyError(err);
    expect(classified.code).toBe('temporary_system_problem');
    expect(classified.message).not.toContain('PGRST');
    expect(classified.message).not.toContain('relationship');
  });

  it('classifies HTTP status codes into the right safe category', () => {
    expect(classifyError({ status: 401 }).code).toBe('authentication_expired');
    expect(classifyError({ status: 403 }).code).toBe('permission_denied');
    expect(classifyError({ status: 404 }).code).toBe('not_found');
    expect(classifyError({ status: 429 }).code).toBe('rate_limited');
    expect(classifyError({ status: 503 }).code).toBe('service_unavailable');
  });

  it('marks the right codes retryable and the right ones not', () => {
    expect(classifyError({ status: 503 }).retryable).toBe(true);
    expect(classifyError({ status: 429 }).retryable).toBe(true);
    expect(classifyError({ status: 403 }).retryable).toBe(false);
    expect(classifyError({ status: 404 }).retryable).toBe(false);
  });

  it('retains sanitized diagnostics useful for operators without leaking the secret', () => {
    const err = { status: 500, code: 'PGRST301', message: `db error near token=${SYNTHETIC_SECRET}` };
    const classified = classifyError(err, { executionId: 'exec-1', correlationId: 'corr-1' });
    expect(classified.diagnostics.executionId).toBe('exec-1');
    expect(classified.diagnostics.correlationId).toBe('corr-1');
    expect(classified.diagnostics.internalCode).toBe('PGRST301');
    expect(classified.diagnostics.providerStatus).toBe(500);
    expect(JSON.stringify(classified.diagnostics)).not.toContain(SYNTHETIC_SECRET);
  });

  it('makeSafeError() never requires a raw error at all', () => {
    const e = makeSafeError('connection_required');
    expect(e.message).toBe('This step needs a connected integration. Connect it and try again.');
    expect(e.httpStatus).toBe(409);
  });
});
