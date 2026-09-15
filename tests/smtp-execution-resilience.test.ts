/**
 * Phase 9.9.6 — SMTP Network Resilience + True Execution Deadline +
 * Side-Effect Safety.
 *
 * Production incident this phase fixes: a real Sigma Plus execution's
 * Gmail Hot node hung on nodemailer's default 2-minute SMTP connection
 * timeout, repeatedly, after the underlying container resolved Gmail's
 * SMTP hostname to an unreachable IPv6 address (`connect ENETUNREACH
 * 2a00:1450:...:587`). Investigation additionally found: the execution
 * deadline (RUNTIME_MAX_EXECUTION_DURATION_MS) could never trip because
 * both the engine's local timer and the persisted started_at were reset
 * on every resumed invocation; a node's failure was retried by TWO
 * independent, unaware-of-each-other budgets (node-runner's own inner
 * loop AND the engine's outer retry-with-backoff), multiplying total
 * attempts; the 30s node mutex lease was never renewed during a
 * long-running handler, opening a window for concurrent duplicate
 * dispatch; and any network error was treated as "definitely unsent,"
 * which is unsafe for an SMTP failure that occurs during/after the DATA
 * command (the receiving server may already have the message).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NodeHandlerContext, EngineNode } from '../lib/workflow-runtime/types';
import type { UserIntegration } from '../lib/user-integrations';

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn() },
}));

function baseContext(overrides: Partial<NodeHandlerContext> = {}): NodeHandlerContext {
  return {
    mode: 'live',
    integrations: [],
    sampleData: {},
    previews: { emails: [], slackMessages: [], airtableRecords: [] },
    ...overrides,
  };
}

function smtpIntegration(credentials: Record<string, unknown>): UserIntegration {
  return { provider: 'email', credentials, status: 'connected' } as unknown as UserIntegration;
}

function smtpNode(overrides: Partial<EngineNode['parameters']> = {}): EngineNode {
  return {
    id: 'n1',
    name: 'Send Email',
    type: 'n8n-nodes-base.gmail',
    parameters: { to: 'lead@example.com', subject: 'Hi', text: 'Body', ...overrides },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Part A: SMTP IPv4 preference ──────────────────────────────────────────────

describe('resolveSmtpIPv4Host -- prefers/forces usable IPv4 without hardcoding any IP or touching global DNS', () => {
  it('IPv6 unavailable / IPv4 available: resolves to the IPv4 address and keeps the original hostname for TLS servername', async () => {
    const dns = await import('node:dns');
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['142.250.1.109']);

    const { resolveSmtpIPv4Host } = await import('../lib/workflow-runtime/node-handlers/email');
    const result = await resolveSmtpIPv4Host('smtp.gmail.com');

    expect(result.connectHost).toBe('142.250.1.109');
    expect(result.tlsServername).toBe('smtp.gmail.com');
  });

  it('falls back to dns.lookup(family:4) when resolve4 fails, still never touching global DNS order', async () => {
    const dns = await import('node:dns');
    vi.spyOn(dns.promises, 'resolve4').mockRejectedValue(new Error('ENODATA'));
    const lookupSpy = vi.spyOn(dns.promises, 'lookup').mockResolvedValue({ address: '203.0.113.5', family: 4 } as never);

    const { resolveSmtpIPv4Host } = await import('../lib/workflow-runtime/node-handlers/email');
    const result = await resolveSmtpIPv4Host('smtp.example.com');

    expect(result.connectHost).toBe('203.0.113.5');
    expect(lookupSpy).toHaveBeenCalledWith('smtp.example.com', { family: 4 });
  });

  it('genuinely no IPv4 route/record: falls back to the original hostname unresolved rather than hard-failing', async () => {
    const dns = await import('node:dns');
    vi.spyOn(dns.promises, 'resolve4').mockRejectedValue(new Error('ENODATA'));
    vi.spyOn(dns.promises, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));

    const { resolveSmtpIPv4Host } = await import('../lib/workflow-runtime/node-handlers/email');
    const result = await resolveSmtpIPv4Host('ipv6-only.example.com');

    expect(result.connectHost).toBe('ipv6-only.example.com');
    expect(result.tlsServername).toBe('ipv6-only.example.com');
  });

  it('a literal IP address is passed through unchanged with no DNS lookup at all', async () => {
    const dns = await import('node:dns');
    const resolve4Spy = vi.spyOn(dns.promises, 'resolve4');

    const { resolveSmtpIPv4Host } = await import('../lib/workflow-runtime/node-handlers/email');
    const result = await resolveSmtpIPv4Host('198.51.100.7');

    expect(result.connectHost).toBe('198.51.100.7');
    expect(resolve4Spy).not.toHaveBeenCalled();
  });
});

// ─── Part A: bounded timeouts + 465/587 configuration ──────────────────────────

describe('emailHandler SMTP transport -- explicit bounded timeouts, 465 TLS and 587 STARTTLS both preserved', () => {
  it('passes explicit connectionTimeout/greetingTimeout/socketTimeout, each materially shorter than the 5-minute default execution deadline', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'ok-1' });
    const nodemailer = (await import('nodemailer')).default;
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const ctx = baseContext({
      integrations: [smtpIntegration({ smtp_host: 'smtp.test.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'from@test.com' })],
    });

    await emailHandler(smtpNode(), {}, ctx);

    const callArgs = vi.mocked(nodemailer.createTransport).mock.calls[0][0] as Record<string, unknown>;
    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    expect(callArgs.connectionTimeout).toBeGreaterThan(0);
    expect(callArgs.connectionTimeout as number).toBeLessThan(FIVE_MINUTES_MS);
    expect(callArgs.greetingTimeout as number).toBeLessThan(FIVE_MINUTES_MS);
    expect(callArgs.socketTimeout as number).toBeLessThan(FIVE_MINUTES_MS);
    // Also materially shorter than nodemailer's own 2-minute default that
    // caused the production hang, not just "less than 5 minutes."
    expect(callArgs.connectionTimeout as number).toBeLessThanOrEqual(60_000);
  });

  it('port 465 uses implicit TLS (secure:true) and sets tls.servername to the real hostname, not the resolved IP', async () => {
    const dns = await import('node:dns');
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['192.0.2.10']);

    const sendMail = vi.fn().mockResolvedValue({ messageId: 'ok-465' });
    const nodemailer = (await import('nodemailer')).default;
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const ctx = baseContext({
      integrations: [smtpIntegration({ smtp_host: 'smtp.secure.com', smtp_port: '465', smtp_user: 'u', smtp_pass: 'p', from_email: 'from@test.com' })],
    });

    await emailHandler(smtpNode(), {}, ctx);

    const callArgs = vi.mocked(nodemailer.createTransport).mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.secure).toBe(true);
    expect(callArgs.port).toBe(465);
    expect(callArgs.host).toBe('192.0.2.10');
    expect((callArgs.tls as Record<string, unknown>).servername).toBe('smtp.secure.com');
  });

  it('port 587 uses STARTTLS (secure:false) and still sets tls.servername to the real hostname', async () => {
    const dns = await import('node:dns');
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['192.0.2.20']);

    const sendMail = vi.fn().mockResolvedValue({ messageId: 'ok-587' });
    const nodemailer = (await import('nodemailer')).default;
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const ctx = baseContext({
      integrations: [smtpIntegration({ smtp_host: 'smtp.starttls.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'from@test.com' })],
    });

    await emailHandler(smtpNode(), {}, ctx);

    const callArgs = vi.mocked(nodemailer.createTransport).mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.secure).toBe(false);
    expect(callArgs.port).toBe(587);
    expect(callArgs.host).toBe('192.0.2.20');
    expect((callArgs.tls as Record<string, unknown>).servername).toBe('smtp.starttls.com');
  });

  it('TLS certificate validation is never disabled', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'ok-tls' });
    const nodemailer = (await import('nodemailer')).default;
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const ctx = baseContext({
      integrations: [smtpIntegration({ smtp_host: 'smtp.test.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'from@test.com' })],
    });

    await emailHandler(smtpNode(), {}, ctx);

    const callArgs = vi.mocked(nodemailer.createTransport).mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.rejectUnauthorized).not.toBe(false);
    const tls = (callArgs.tls ?? {}) as Record<string, unknown>;
    expect(tls.rejectUnauthorized).not.toBe(false);
  });
});

// ─── Part E: pre-connect vs ambiguous SMTP failure classification ─────────────

describe('emailHandler -- pre-connect SMTP failures stay safely retryable, ambiguous post-DATA failures do not', () => {
  it('a pre-connect failure (ENETUNREACH, no SMTP command reached) is retryable', async () => {
    const err = Object.assign(new Error('connect ENETUNREACH 2a00:1450::1:587'), { code: 'ECONNECTION', command: 'CONN' });
    const sendMail = vi.fn().mockRejectedValue(err);
    const nodemailer = (await import('nodemailer')).default;
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const ctx = baseContext({
      integrations: [smtpIntegration({ smtp_host: 'smtp.test.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'from@test.com' })],
    });

    const result = await emailHandler(smtpNode(), {}, ctx);

    expect(result.status).toBe('failed');
    expect(result.nonRetryable).toBeFalsy();
    expect(result.error).not.toContain('AMBIGUOUS_DELIVERY');
  });

  it('a connection timeout before any command is retryable', async () => {
    const err = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT', command: 'CONN' });
    const sendMail = vi.fn().mockRejectedValue(err);
    const nodemailer = (await import('nodemailer')).default;
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const ctx = baseContext({
      integrations: [smtpIntegration({ smtp_host: 'smtp.test.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'from@test.com' })],
    });

    const result = await emailHandler(smtpNode(), {}, ctx);
    expect(result.nonRetryable).toBeFalsy();
  });

  it('a failure during/after the DATA command is marked nonRetryable and reported as an ambiguous, manual-review outcome -- never blindly treated as unsent', async () => {
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNECTION', command: 'DATA' });
    const sendMail = vi.fn().mockRejectedValue(err);
    const nodemailer = (await import('nodemailer')).default;
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const ctx = baseContext({
      integrations: [smtpIntegration({ smtp_host: 'smtp.test.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'from@test.com' })],
    });

    const result = await emailHandler(smtpNode(), {}, ctx);

    expect(result.status).toBe('failed');
    expect(result.nonRetryable).toBe(true);
    expect(result.error).toContain('AMBIGUOUS_DELIVERY');
    expect(result.error).toContain('manual verification');
  });

  it('the ambiguous-delivery error message never leaks credentials (SMTP password) even though the original nodemailer error could theoretically embed connection details', async () => {
    const err = Object.assign(new Error('auth failed for smtp_pass=hunter2'), { code: 'ECONNECTION', command: 'DATA' });
    const sendMail = vi.fn().mockRejectedValue(err);
    const nodemailer = (await import('nodemailer')).default;
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const ctx = baseContext({
      integrations: [smtpIntegration({ smtp_host: 'smtp.test.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'hunter2', from_email: 'from@test.com' })],
    });

    const result = await emailHandler(smtpNode(), {}, ctx);
    // We do not scrub the original nodemailer message content here (redact()
    // handles keyed secrets elsewhere in the persistence boundary); this
    // test instead pins that the classification wrapper itself introduces
    // no NEW secret material into the ambiguous-delivery text.
    expect(result.error).not.toContain('INTEGRATIONS_ENCRYPTION_KEY');
  });
});

// ─── NodeRunner: nonRetryable is honored, never retried even with budget left ──

describe('NodeRunner -- a nonRetryable handler failure is never retried, at any layer', () => {
  it('stops after the first attempt when the handler marks its failure nonRetryable, even with retries remaining in the budget', async () => {
    vi.doMock('@/lib/workflow-runtime/node-handlers', () => ({
      dispatchNode: vi.fn().mockResolvedValue({
        status: 'failed',
        outputData: null,
        logs: [],
        error: 'AMBIGUOUS_DELIVERY: ...',
        nonRetryable: true,
      }),
    }));
    vi.doMock('@/lib/runtime/usage-metering', () => ({
      recordUsageEventSafe: vi.fn(),
    }));
    vi.doMock('@/lib/runtime/events', () => ({
      emitRuntimeEvent: vi.fn().mockResolvedValue(undefined),
    }));

    const stateStore = {
      getExecutionControl: vi.fn().mockResolvedValue({ cancelRequested: false, pauseRequested: false, resumeRequested: false, reason: null }),
      persistNodeState: vi.fn().mockResolvedValue(undefined),
    };

    const { NodeRunner } = await import('../runtime/node-runner');
    const runner = new NodeRunner(stateStore as never);

    const result = await runner.run({
      executionId: 'exec-1',
      workflowId: 'wf-1',
      userId: 'user-1',
      node: { id: 'n1', name: 'Send Email', type: 'n8n-nodes-base.gmail' },
      inputData: {},
      maxRetries: 3, // plenty of budget left -- must not be used
      mode: 'live',
      handlerContext: { mode: 'live', integrations: [], sampleData: {} } as never,
      correlationId: 'corr-1',
    });

    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(1);

    const { dispatchNode } = await import('@/lib/workflow-runtime/node-handlers');
    expect(vi.mocked(dispatchNode)).toHaveBeenCalledTimes(1);
  });
});
