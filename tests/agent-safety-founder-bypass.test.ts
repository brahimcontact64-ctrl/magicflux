/**
 * Phase 9.6 Section 1 — evaluateToolSafety()'s daily AI cost/token cap
 * (QUOTA_EXCEEDED) is a commercial quota, not a runtime-safety protection,
 * so a Founder/admin account (isAdminUser() true) may bypass it -- and
 * only it. Every other guard in this function (mode gates, approval
 * requirements, duplicate/rate-limit/loop-detection checks) must remain
 * fully intact for admins too; this suite only exercises the one bypass
 * that was added, using generate_workflow_json (low risk, allowed in every
 * mode, no approval required) so none of those other guards interfere.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let aiUsageRows: Array<{ total_tokens: number; estimated_cost_usd: number }>;

function genericTable() {
  const api = {
    select: () => api,
    eq: () => api,
    gte: () => api,
    lt: () => api,
    gt: () => api,
    or: () => api,
    limit: () => api,
    order: () => api,
    delete: () => api,
    insert: async () => ({ data: null, error: null }),
    upsert: async () => ({ data: null, error: null }),
    async maybeSingle() { return { data: null, error: null }; },
    then(resolve: (v: { data: unknown[]; error: null; count: number }) => unknown) {
      return Promise.resolve(resolve({ data: [], error: null, count: 0 })).then(() => undefined);
    },
  };
  return api;
}

function makeFakeDb() {
  return {
    from(table: string) {
      if (table === 'agent_ai_usage') {
        const api = {
          select: () => api,
          eq: () => api,
          gte: () => api,
          async limit() { return { data: aiUsageRows, error: null }; },
        };
        return api;
      }
      return genericTable();
    },
  };
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeDb()),
  isAdminUser: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Comfortably over both the new $5 / 75,000-token Beta default cap.
  aiUsageRows = [{ total_tokens: 200_000, estimated_cost_usd: 20 }];
});

const CTX = {
  userId: 'user-1',
  sessionId: 'session-1',
  toolName: 'generate_workflow_json',
  args: {},
};

describe('evaluateToolSafety -- Founder AI-cost bypass', () => {
  it('a non-admin user over the daily cap is blocked with QUOTA_EXCEEDED', async () => {
    const { isAdminUser } = await import('@/lib/supabase-server');
    vi.mocked(isAdminUser).mockResolvedValue(false);

    const { evaluateToolSafety } = await import('../lib/agent/safety');
    const decision = await evaluateToolSafety(CTX);

    expect(decision.allowed).toBe(false);
    expect(decision.blockCode).toBe('QUOTA_EXCEEDED');
  });

  it('a Founder/admin user over the same daily cap is allowed through (commercial-quota bypass only)', async () => {
    const { isAdminUser } = await import('@/lib/supabase-server');
    vi.mocked(isAdminUser).mockResolvedValue(true);

    const { evaluateToolSafety } = await import('../lib/agent/safety');
    const decision = await evaluateToolSafety(CTX);

    expect(decision.allowed).toBe(true);
    expect(decision.blockCode).toBeUndefined();
  });

  it('a non-admin user under the cap is allowed through normally', async () => {
    aiUsageRows = [{ total_tokens: 100, estimated_cost_usd: 0.01 }];
    const { isAdminUser } = await import('@/lib/supabase-server');
    vi.mocked(isAdminUser).mockResolvedValue(false);

    const { evaluateToolSafety } = await import('../lib/agent/safety');
    const decision = await evaluateToolSafety(CTX);

    expect(decision.allowed).toBe(true);
  });
});
