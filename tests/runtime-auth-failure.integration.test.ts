/**
 * Phase 23.2 — Runtime Integration Tests: Auth Failure Behavior
 *
 * Cold audit. Does NOT trust static tests, grep, string matching, or documentation.
 *
 * Each test actually invokes the real GET handler and inspects the live HTTP response.
 * getUserPermissions is mocked at the module level so we can inject any failure mode.
 *
 * Scenarios under test:
 *   A — getUserPermissions throws Error("db failure")
 *   B — getUserPermissions rejects with a non-Error value
 *   C — getUserPermissions resolves with null      (not a throw — tests null guard)
 *   D — getUserPermissions resolves with undefined (not a throw — tests null guard)
 *   E — getUserPermissions resolves with []        (no permissions)
 *   F — getUserPermissions resolves with [primaryPerm]
 *   G — getUserPermissions resolves with ["admin_runtime"]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ────────────────────────────────────────────────────────────
// vi.mock() calls are hoisted by vitest to run before any import statement.

vi.mock('server-only', () => ({}));

vi.mock('@/lib/runtime/rbac', () => ({
  getUserPermissions: vi.fn(),
  requirePermission: vi.fn().mockResolvedValue(undefined),
  hasPermission:     vi.fn().mockResolvedValue(false),
}));

// Supabase client mock: every DB call resolves to { data: [], error: null, count: 0 }.
// The Proxy intercepts any chaining method and returns itself, making it both chainable
// and directly awaitable as a terminal step.
vi.mock('@/lib/supabase-server', () => {
  function chain(): unknown {
    const h: ProxyHandler<object> = {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined;
        const k = String(prop);
        const resolved = { data: [] as unknown[], error: null, count: 0 };
        if (k === 'then')    return (res: (v: typeof resolved) => unknown) => Promise.resolve(resolved).then(res);
        if (k === 'catch')   return ()                                      => Promise.resolve(resolved);
        if (k === 'finally') return (fn: () => void)                        => Promise.resolve(resolved).finally(fn);
        if (k === 'maybeSingle') return () => Promise.resolve({ data: null,  error: null });
        if (k === 'single')      return () => Promise.resolve({ data: null,  error: null });
        // Any other method (select, eq, order, limit, insert, …) returns the same proxy.
        return () => chain();
      },
    };
    return new Proxy({} as object, h);
  }
  return {
    getUserFromRequest: vi.fn(),
    createServiceClient: vi.fn(() => ({ from: () => chain() })),
  };
});

vi.mock('@/lib/runtime/incident-manager', () => ({
  listActiveIncidents:  vi.fn().mockResolvedValue([]),
  getIncidentById:      vi.fn().mockResolvedValue(null),
  resolveIncident:      vi.fn().mockResolvedValue(true),
  escalateIncident:     vi.fn().mockResolvedValue(true),
  appendIncidentEvent:  vi.fn().mockResolvedValue(undefined),
  recordOperatorAction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/runtime/health-score-v2', () => ({
  computeHealthScoreV2: vi.fn().mockResolvedValue({
    overallScore: 100,
    components:   {},
    signals:      [],
    computedAt:   new Date().toISOString(),
  }),
}));

vi.mock('@/lib/runtime/metrics-engine', () => ({
  recordRuntimeMetricsSnapshot: vi.fn().mockResolvedValue({}),
  queryMetricSeries:             vi.fn().mockResolvedValue([]),
  listAvailableMetrics:          vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/runtime/cost-engine', () => ({
  getCostSummary:         vi.fn().mockResolvedValue({ total: 0 }),
  getTopCostlyWorkflows:  vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/runtime/worker-lifecycle', () => ({
  requestWorkerRestart: vi.fn().mockResolvedValue(undefined),
  drainWorker:          vi.fn().mockResolvedValue(undefined),
}));

// ─── Imports (run after mocks are registered) ────────────────────────────────

import { getUserPermissions } from '@/lib/runtime/rbac';
import { getUserFromRequest }  from '@/lib/supabase-server';

import { GET as getIncidents  } from '@/app/api/runtime/control/incidents/route';
import { GET as getWorkers    } from '@/app/api/runtime/control/workers/route';
import { GET as getOverview   } from '@/app/api/runtime/control/overview/route';
import { GET as getOpActions  } from '@/app/api/runtime/control/operator-actions/route';
import { GET as getMetrics    } from '@/app/api/runtime/control/metrics/route';
import { GET as getTraces     } from '@/app/api/runtime/control/traces/route';
import { GET as getCost       } from '@/app/api/runtime/control/cost/route';
import { GET as getStream     } from '@/app/api/runtime/control/stream/route';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type RouteHandler = (req: NextRequest) => Promise<Response>;
type Perm = 'view_runtime' | 'view_audit' | 'admin_runtime' | 'manage_workers' |
            'manage_incidents' | 'manage_commands' | 'manage_executions' |
            'manage_replay';

function makeReq(url = 'http://localhost/api/test'): NextRequest {
  return new NextRequest(new URL(url));
}

async function bodyJson(res: Response): Promise<Record<string, unknown>> {
  try { return (await res.json()) as Record<string, unknown>; }
  catch { return {}; }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(() => {
  // All routes require an authenticated user. Mock that here once.
  vi.mocked(getUserFromRequest).mockResolvedValue({ id: 'test-user-id', email: 'tester@example.com' });
});

afterEach(() => {
  // Clear any fake setInterval handles that stream/route.ts may have installed.
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ─── Route matrix ────────────────────────────────────────────────────────────

interface RouteConfig {
  name:        string;
  handler:     RouteHandler;
  primaryPerm: Perm;      // The minimum non-admin permission for GET access
  successUrl:  string;    // URL that won't 400 on param validation after auth passes
}

const ROUTES: RouteConfig[] = [
  {
    name:        'incidents',
    handler:     getIncidents,
    primaryPerm: 'view_runtime',
    successUrl:  'http://localhost/api/runtime/control/incidents',
  },
  {
    name:        'workers',
    handler:     getWorkers,
    primaryPerm: 'view_runtime',
    successUrl:  'http://localhost/api/runtime/control/workers',
  },
  {
    name:        'overview',
    handler:     getOverview,
    primaryPerm: 'view_runtime',
    successUrl:  'http://localhost/api/runtime/control/overview',
  },
  {
    name:        'operator-actions',
    handler:     getOpActions,
    primaryPerm: 'view_audit',           // ← requires view_audit, NOT view_runtime
    successUrl:  'http://localhost/api/runtime/control/operator-actions',
  },
  {
    name:        'metrics',
    handler:     getMetrics,
    primaryPerm: 'view_runtime',
    successUrl:  'http://localhost/api/runtime/control/metrics?list=true',
  },
  {
    name:        'traces',
    handler:     getTraces,
    primaryPerm: 'view_runtime',
    successUrl:  'http://localhost/api/runtime/control/traces',
  },
  {
    name:        'cost',
    handler:     getCost,
    primaryPerm: 'view_runtime',
    successUrl:  'http://localhost/api/runtime/control/cost',
  },
  {
    name:        'stream',
    handler:     getStream,
    primaryPerm: 'view_runtime',
    successUrl:  'http://localhost/api/runtime/control/stream',
  },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

for (const { name, handler, primaryPerm, successUrl } of ROUTES) {
  describe(name, () => {

    // ── Scenario A: getUserPermissions throws an Error ────────────────────

    describe('Scenario A — getUserPermissions throws Error("db failure")', () => {
      it('returns HTTP 503', async () => {
        vi.mocked(getUserPermissions).mockRejectedValue(new Error('db failure'));
        const res = await handler(makeReq());
        expect(res.status).toBe(503);
      });

      it('body.error = "Authorization service unavailable"', async () => {
        vi.mocked(getUserPermissions).mockRejectedValue(new Error('db failure'));
        const res = await handler(makeReq());
        const body = await bodyJson(res);
        expect(body.error).toBe('Authorization service unavailable');
      });

      it('does NOT return 500 (no unhandled exception)', async () => {
        vi.mocked(getUserPermissions).mockRejectedValue(new Error('db failure'));
        const res = await handler(makeReq());
        expect(res.status).not.toBe(500);
      });
    });

    // ── Scenario B: rejected promise with a non-Error value ───────────────

    describe('Scenario B — getUserPermissions rejects with string', () => {
      it('returns HTTP 503', async () => {
        vi.mocked(getUserPermissions).mockRejectedValue('connection refused');
        const res = await handler(makeReq());
        expect(res.status).toBe(503);
      });

      it('does NOT return 500', async () => {
        vi.mocked(getUserPermissions).mockRejectedValue('connection refused');
        const res = await handler(makeReq());
        expect(res.status).not.toBe(500);
      });
    });

    // ── Scenario C: resolves with null (no throw — tests null guard) ──────
    //
    // This is different from Scenario A/B: .catch() is NOT triggered.
    // The null guard `if (!perms)` must handle a null-valued resolved promise.

    describe('Scenario C — getUserPermissions resolves with null', () => {
      it('returns HTTP 503 (null guard fires)', async () => {
        vi.mocked(getUserPermissions).mockResolvedValue(null as never);
        const res = await handler(makeReq());
        expect(res.status).toBe(503);
      });

      it('does NOT throw TypeError (cannot read properties of null)', async () => {
        vi.mocked(getUserPermissions).mockResolvedValue(null as never);
        const res = await handler(makeReq());
        // If perms.includes() were called on null it would throw, producing 500.
        expect(res.status).not.toBe(500);
      });

      it('body.error = "Authorization service unavailable"', async () => {
        vi.mocked(getUserPermissions).mockResolvedValue(null as never);
        const res = await handler(makeReq());
        const body = await bodyJson(res);
        expect(body.error).toBe('Authorization service unavailable');
      });
    });

    // ── Scenario D: resolves with undefined (tests null guard) ────────────
    //
    // Same as C but undefined. Both falsy values must be handled.

    describe('Scenario D — getUserPermissions resolves with undefined', () => {
      it('returns HTTP 503 (null guard fires)', async () => {
        vi.mocked(getUserPermissions).mockResolvedValue(undefined as never);
        const res = await handler(makeReq());
        expect(res.status).toBe(503);
      });

      it('does NOT throw TypeError (cannot read properties of undefined)', async () => {
        vi.mocked(getUserPermissions).mockResolvedValue(undefined as never);
        const res = await handler(makeReq());
        expect(res.status).not.toBe(500);
      });

      it('body.error = "Authorization service unavailable"', async () => {
        vi.mocked(getUserPermissions).mockResolvedValue(undefined as never);
        const res = await handler(makeReq());
        const body = await bodyJson(res);
        expect(body.error).toBe('Authorization service unavailable');
      });
    });

    // ── Scenario E: resolves with [] (no permissions assigned) ────────────
    //
    // getUserPermissions succeeded (no service error) but the user has zero
    // permissions. The null guard must NOT fire; the permission gate MUST fire.

    describe('Scenario E — getUserPermissions resolves with []', () => {
      it('returns HTTP 403 (not 503)', async () => {
        vi.mocked(getUserPermissions).mockResolvedValue([]);
        const res = await handler(makeReq());
        expect(res.status).toBe(403);
      });

      it('body.error = "Forbidden" (not "Authorization service unavailable")', async () => {
        vi.mocked(getUserPermissions).mockResolvedValue([]);
        const res = await handler(makeReq());
        const body = await bodyJson(res);
        expect(body.error).toBe('Forbidden');
        expect(body.error).not.toBe('Authorization service unavailable');
      });

      it('does NOT return 503 (service was reachable — wrong perms is 403, not 503)', async () => {
        vi.mocked(getUserPermissions).mockResolvedValue([]);
        const res = await handler(makeReq());
        expect(res.status).not.toBe(503);
      });
    });

    // ── Scenario F: resolves with the primary permission ──────────────────

    describe(`Scenario F — getUserPermissions resolves with ["${primaryPerm}"]`, () => {
      it('auth passes (not 401 / 403 / 503)', async () => {
        vi.useFakeTimers();
        vi.mocked(getUserPermissions).mockResolvedValue([primaryPerm]);
        const res = await handler(new NextRequest(new URL(successUrl)));
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
        expect(res.status).not.toBe(503);
      });
    });

    // ── Scenario G: resolves with ["admin_runtime"] ───────────────────────
    //
    // admin_runtime must bypass ALL primary permission gates.

    describe('Scenario G — getUserPermissions resolves with ["admin_runtime"]', () => {
      it('admin bypass works (not 401 / 403 / 503)', async () => {
        vi.useFakeTimers();
        vi.mocked(getUserPermissions).mockResolvedValue(['admin_runtime']);
        const res = await handler(new NextRequest(new URL(successUrl)));
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
        expect(res.status).not.toBe(503);
      });
    });

  });
}

// ─── operator-actions: permission boundary test ──────────────────────────────
//
// operator-actions requires view_audit. A user with ONLY view_runtime must be
// denied with 403, not 503. This verifies the permission boundary is exact.

describe('operator-actions — permission boundary', () => {
  it('view_runtime alone → 403 (view_audit is required)', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(['view_runtime']);
    const res = await getOpActions(makeReq());
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(503);
  });

  it('view_audit alone → auth passes', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(['view_audit']);
    const res = await getOpActions(new NextRequest(new URL('http://localhost/api/runtime/control/operator-actions')));
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(503);
  });
});

// ─── stream route — SSE-specific checks ──────────────────────────────────────
//
// On auth failure the route must return a plain JSON 503, NOT open an SSE stream.
// On auth success it must return a stream with the correct content-type.

describe('stream — SSE-specific behavior', () => {
  it('Scenario A: 503 response is NOT an SSE stream', async () => {
    vi.mocked(getUserPermissions).mockRejectedValue(new Error('db failure'));
    const res = await getStream(makeReq());
    expect(res.status).toBe(503);
    // text/event-stream is only correct for the success path
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).not.toContain('text/event-stream');
  });

  it('Scenario F: auth pass → response is text/event-stream', async () => {
    vi.useFakeTimers();
    vi.mocked(getUserPermissions).mockResolvedValue(['view_runtime']);
    const ac = new AbortController();
    const res = await getStream(new NextRequest(
      new URL('http://localhost/api/runtime/control/stream'),
      { signal: ac.signal },
    ));
    ac.abort(); // clean up intervals via the route's own abort listener
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('text/event-stream');
  });

  it('Scenario C: null perms → 503 (not SSE stream)', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(null as never);
    const res = await getStream(makeReq());
    expect(res.status).toBe(503);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).not.toContain('text/event-stream');
  });
});
