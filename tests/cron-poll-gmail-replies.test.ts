import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Workflow #2 Phase D.6 -- GET /api/cron/poll-gmail-replies route tests.
 * The scheduler itself is fully mocked here (its own real behavior is
 * covered by tests/gmail-polling-scheduler.test.ts) -- this file only
 * verifies the route's own auth boundary and that it never reads/forwards
 * arbitrary request input. NO REAL GMAIL CALLS, no real database.
 */

const runGmailPollingBatchMock = vi.fn();
vi.mock('@/lib/runtime/inbound-reply/gmail-polling-scheduler', () => ({
  runGmailPollingBatch: (...args: unknown[]) => runGmailPollingBatchMock(...args),
}));

beforeEach(() => {
  vi.resetModules();
  runGmailPollingBatchMock.mockReset();
  runGmailPollingBatchMock.mockResolvedValue({ discovered: 0, attempted: 0, succeeded: 0, failed: 0, skipped: 0, repliesProcessed: 0, errors: [] });
  process.env.CRON_SECRET = 'real-cron-secret-value';
});

function cronRequest(headers: Record<string, string> = {}, url = 'http://localhost/api/cron/poll-gmail-replies'): NextRequest {
  return new NextRequest(new URL(url), { headers });
}

describe('GET /api/cron/poll-gmail-replies', () => {
  it('1. rejects a request with no Authorization header', async () => {
    const { GET } = await import('@/app/api/cron/poll-gmail-replies/route');
    const res = await GET(cronRequest());

    expect(res.status).toBe(401);
    expect(runGmailPollingBatchMock).not.toHaveBeenCalled();
  });

  it('1b. rejects a request with the WRONG secret', async () => {
    const { GET } = await import('@/app/api/cron/poll-gmail-replies/route');
    const res = await GET(cronRequest({ authorization: 'Bearer wrong-secret' }));

    expect(res.status).toBe(401);
    expect(runGmailPollingBatchMock).not.toHaveBeenCalled();
  });

  it('1c. fails closed (never defaults to "open") when CRON_SECRET itself is not configured', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('@/app/api/cron/poll-gmail-replies/route');
    const res = await GET(cronRequest({ authorization: 'Bearer anything' }));

    expect(res.status).toBe(500);
    expect(runGmailPollingBatchMock).not.toHaveBeenCalled();
  });

  it('2. an authorized request invokes the scheduler and returns its summary', async () => {
    runGmailPollingBatchMock.mockResolvedValue({ discovered: 3, attempted: 3, succeeded: 2, failed: 1, skipped: 0, repliesProcessed: 1, errors: ['user abcd1234…: boom'] });

    const { GET } = await import('@/app/api/cron/poll-gmail-replies/route');
    const res = await GET(cronRequest({ authorization: 'Bearer real-cron-secret-value' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(runGmailPollingBatchMock).toHaveBeenCalledTimes(1);
    expect(body).toEqual({ discovered: 3, attempted: 3, succeeded: 2, failed: 1, skipped: 0, repliesProcessed: 1, errors: ['user abcd1234…: boom'] });
  });

  it('3. arbitrary userId/mailboxId query parameters cannot redirect polling -- the scheduler is always invoked with the same fixed batch size, never request-derived arguments', async () => {
    const { GET } = await import('@/app/api/cron/poll-gmail-replies/route');
    await GET(cronRequest({ authorization: 'Bearer real-cron-secret-value' }, 'http://localhost/api/cron/poll-gmail-replies?userId=attacker-controlled&mailboxId=other'));

    expect(runGmailPollingBatchMock).toHaveBeenCalledTimes(1);
    const callArgs = runGmailPollingBatchMock.mock.calls[0];
    expect(callArgs).toEqual([25]); // CRON_BATCH_SIZE only -- no request-derived value ever passed through
  });

  it('a scheduler failure is reported as a 500 with a short message, never a stack trace or credential content', async () => {
    runGmailPollingBatchMock.mockRejectedValue(new Error('Failed to discover Gmail connections: db unreachable'));

    const { GET } = await import('@/app/api/cron/poll-gmail-replies/route');
    const res = await GET(cronRequest({ authorization: 'Bearer real-cron-secret-value' }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain('db unreachable');
  });

  it('19. the response never contains a token/Authorization-shaped value', async () => {
    runGmailPollingBatchMock.mockResolvedValue({ discovered: 1, attempted: 1, succeeded: 1, failed: 0, skipped: 0, repliesProcessed: 0, errors: [] });

    const { GET } = await import('@/app/api/cron/poll-gmail-replies/route');
    const res = await GET(cronRequest({ authorization: 'Bearer real-cron-secret-value' }));
    const bodyText = JSON.stringify(await res.json());

    expect(bodyText).not.toContain('real-cron-secret-value');
    expect(bodyText).not.toContain('Bearer');
  });
});
