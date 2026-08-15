/**
 * Phase 8.1 — Failure/crash-safety: concurrency reservation expiry, reclaim,
 * and fail-closed behavior on RPC error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({ rpc: (...a: unknown[]) => rpcMock(...(a as [string, Record<string, unknown>])) })),
}));

beforeEach(() => { rpcMock.mockReset(); });

describe('concurrency reservation expiry and proactive reclaim', () => {
  it('reclaimExpiredConcurrencyReservations calls the reclaim RPC and returns the count reclaimed', async () => {
    rpcMock.mockResolvedValue({ data: 3, error: null });
    const { reclaimExpiredConcurrencyReservations } = await import('../lib/runtime/concurrency-guard');
    const count = await reclaimExpiredConcurrencyReservations();
    expect(count).toBe(3);
    expect(rpcMock).toHaveBeenCalledWith('reclaim_expired_concurrency_reservations', {});
  });

  it('releaseConcurrencySlot is safe to call even when nothing is reserved (idempotent — matches worker-crash finally-block usage)', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const { releaseConcurrencySlot } = await import('../lib/runtime/concurrency-guard');
    await expect(releaseConcurrencySlot({ executionId: 'never-reserved' })).resolves.toBeUndefined();
  });

  it('a reservation RPC error fails closed (never treated as reserved)', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    const { reserveConcurrencySlot } = await import('../lib/runtime/concurrency-guard');
    const result = await reserveConcurrencySlot({ executionId: 'exec-1', userId: 'user-1', workflowId: 'wf-1' });
    expect(result.reserved).toBe(false);
  });

  it('reserveConcurrencySlot passes a TTL to the RPC so an abandoned reservation is bounded, not permanent', async () => {
    rpcMock.mockResolvedValue({ data: { reserved: true }, error: null });
    const { reserveConcurrencySlot } = await import('../lib/runtime/concurrency-guard');
    await reserveConcurrencySlot({ executionId: 'exec-1', userId: 'user-1', workflowId: 'wf-1', ttlSeconds: 600 });
    expect(rpcMock).toHaveBeenCalledWith('reserve_concurrency_slot', expect.objectContaining({ p_ttl_seconds: 600 }));
  });
});
