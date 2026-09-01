/**
 * Phase 9.2 — Production Onboarding & First-Run Experience.
 *
 * Sections:
 *   1. shouldUserOnboard() — the pure grandfather-compatibility decision
 *   2. GET /api/onboarding/status — auth + server-authoritative decision
 *   3. POST /api/onboarding/complete — auth + cross-user tamper resistance
 *   4. getOnboardingToolOptions() — capability honesty (derived, not hard-coded)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Fake Supabase client (top-level: vi.mock is hoisted regardless of
// textual position, so the class/state it closes over must be top-level too
// — see tests/node-capabilities.test.ts for the same pattern). ──────────────

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private patch: Row | null = null;
  private isUpsert = false;
  private countMode = false;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.count) this.countMode = true;
    return this;
  }
  update(patch: Row): this { this.patch = patch; return this; }
  upsert(row: Row): this { this.patch = row; this.isUpsert = true; this.filters = [['id', row.id]]; return this; }
  private matched(): Row[] {
    let m = this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    if (this.patch) {
      if (m.length === 0) {
        // Real Postgres semantics: .update() on zero matching rows inserts
        // nothing (data stays null); only .upsert() creates a new row.
        if (this.isUpsert) {
          const created = { ...this.patch };
          this.rows.push(created);
          m = [created];
        }
      } else {
        for (const row of m) Object.assign(row, this.patch);
      }
    }
    return m;
  }
  async maybeSingle() {
    const m = this.matched();
    return { data: m[0] ? { ...m[0] } : null, error: null, count: this.countMode ? m.length : undefined };
  }
  then<T>(resolve: (v: { data: Row[]; error: null; count: number }) => T) {
    const m = this.matched();
    return Promise.resolve(resolve({ data: m, error: null, count: m.length }));
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => new FakeQuery(tables[name] ?? (tables[name] = [])),
  })),
  getUserFromRequest: vi.fn(),
}));

// ─── 1. shouldUserOnboard() ──────────────────────────────────────────────────

describe('shouldUserOnboard (pure decision function)', () => {
  it('a brand-new user with no profile row and no workflows should onboard', async () => {
    const { shouldUserOnboard } = await import('../lib/onboarding');
    expect(shouldUserOnboard(null, false)).toBe(true);
  });

  it('a fresh profile created after the launch cutoff, not yet complete, should onboard', async () => {
    const { shouldUserOnboard, ONBOARDING_LAUNCH_CUTOFF } = await import('../lib/onboarding');
    const afterCutoff = new Date(new Date(ONBOARDING_LAUNCH_CUTOFF).getTime() + 60_000).toISOString();
    expect(shouldUserOnboard({ onboarding_complete: false, created_at: afterCutoff }, false)).toBe(true);
  });

  it('a profile with onboarding_complete=true should never onboard again', async () => {
    const { shouldUserOnboard, ONBOARDING_LAUNCH_CUTOFF } = await import('../lib/onboarding');
    const afterCutoff = new Date(new Date(ONBOARDING_LAUNCH_CUTOFF).getTime() + 60_000).toISOString();
    expect(shouldUserOnboard({ onboarding_complete: true, created_at: afterCutoff }, false)).toBe(false);
  });

  it('a legacy profile created before the launch cutoff is grandfathered even with onboarding_complete=false', async () => {
    // This is the exact real-world shape of all 5 pre-existing production
    // user_profiles rows: onboarding_complete=false (written at signup,
    // never previously consumed), created_at from well before this feature
    // shipped. Must NOT be forced into onboarding.
    const { shouldUserOnboard } = await import('../lib/onboarding');
    expect(shouldUserOnboard({ onboarding_complete: false, created_at: '2026-05-01T23:28:55.998917+00:00' }, false)).toBe(false);
  });

  it('a user with an existing workflow is grandfathered regardless of the flag or timestamp', async () => {
    const { shouldUserOnboard } = await import('../lib/onboarding');
    expect(shouldUserOnboard({ onboarding_complete: false, created_at: new Date().toISOString() }, true)).toBe(false);
    expect(shouldUserOnboard(null, true)).toBe(false);
  });
});

// ─── 2. GET /api/onboarding/status ───────────────────────────────────────────

describe('GET /api/onboarding/status', () => {
  const USER_ID = '00000000-0000-4000-8000-0000000000f1';

  beforeEach(() => {
    tables = { user_profiles: [], workflows: [] };
  });

  it('returns 401 when unauthenticated', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null);

    const { GET } = await import('../app/api/onboarding/status/route');
    const res = await GET(new Request('http://localhost/api/onboarding/status') as never);
    expect(res.status).toBe(401);
  });

  it('a new authenticated user with a fresh, incomplete profile should onboard', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_ID, email: 'a@example.com' });
    tables.user_profiles = [{ id: USER_ID, onboarding_complete: false, created_at: new Date().toISOString() }];

    const { GET } = await import('../app/api/onboarding/status/route');
    const res = await GET(new Request('http://localhost/api/onboarding/status') as never);
    const body = await res.json() as { shouldOnboard: boolean };
    expect(res.status).toBe(200);
    expect(body.shouldOnboard).toBe(true);
  });

  it('a legacy account (pre-cutoff profile, no workflows) does not see onboarding', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_ID, email: 'legacy@example.com' });
    tables.user_profiles = [{ id: USER_ID, onboarding_complete: false, created_at: '2026-05-01T23:28:55.998917+00:00' }];

    const { GET } = await import('../app/api/onboarding/status/route');
    const res = await GET(new Request('http://localhost/api/onboarding/status') as never);
    const body = await res.json() as { shouldOnboard: boolean };
    expect(body.shouldOnboard).toBe(false);
  });

  it('a returning user who already completed onboarding does not see it again', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_ID, email: 'done@example.com' });
    tables.user_profiles = [{ id: USER_ID, onboarding_complete: true, created_at: new Date().toISOString() }];

    const { GET } = await import('../app/api/onboarding/status/route');
    const res = await GET(new Request('http://localhost/api/onboarding/status') as never);
    const body = await res.json() as { shouldOnboard: boolean };
    expect(body.shouldOnboard).toBe(false);
  });

  it('a user with an existing workflow does not see onboarding even with an incomplete new profile', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_ID, email: 'haswf@example.com' });
    tables.user_profiles = [{ id: USER_ID, onboarding_complete: false, created_at: new Date().toISOString() }];
    tables.workflows = [{ id: 'wf-1', user_id: USER_ID }];

    const { GET } = await import('../app/api/onboarding/status/route');
    const res = await GET(new Request('http://localhost/api/onboarding/status') as never);
    const body = await res.json() as { shouldOnboard: boolean };
    expect(body.shouldOnboard).toBe(false);
  });
});

// ─── 3. POST /api/onboarding/complete ────────────────────────────────────────

describe('POST /api/onboarding/complete', () => {
  const USER_ID = '00000000-0000-4000-8000-0000000000f2';
  const OTHER_USER_ID = '00000000-0000-4000-8000-0000000000f3';

  beforeEach(() => {
    tables = {
      user_profiles: [
        { id: USER_ID, onboarding_complete: false, created_at: new Date().toISOString() },
        { id: OTHER_USER_ID, onboarding_complete: false, created_at: new Date().toISOString() },
      ],
    };
  });

  it('returns 401 when unauthenticated', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null);

    const { POST } = await import('../app/api/onboarding/complete/route');
    const res = await POST(new Request('http://localhost/api/onboarding/complete', { method: 'POST' }) as never);
    expect(res.status).toBe(401);
  });

  it('marks only the authenticated caller as complete', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_ID, email: 'me@example.com' });

    const { POST } = await import('../app/api/onboarding/complete/route');
    const res = await POST(new Request('http://localhost/api/onboarding/complete', { method: 'POST' }) as never);
    expect(res.status).toBe(200);

    const mine = tables.user_profiles.find((r) => r.id === USER_ID);
    const other = tables.user_profiles.find((r) => r.id === OTHER_USER_ID);
    expect(mine?.onboarding_complete).toBe(true);
    expect(other?.onboarding_complete).toBe(false); // untouched
  });

  it('a request body attempting to specify a different user id is ignored — identity comes only from the verified token', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: USER_ID, email: 'me@example.com' });

    const { POST } = await import('../app/api/onboarding/complete/route');
    const res = await POST(new Request('http://localhost/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: OTHER_USER_ID, userId: OTHER_USER_ID }),
    }) as never);
    expect(res.status).toBe(200);

    const attacker = tables.user_profiles.find((r) => r.id === USER_ID);
    const victim = tables.user_profiles.find((r) => r.id === OTHER_USER_ID);
    expect(attacker?.onboarding_complete).toBe(true); // the real (verified) caller
    expect(victim?.onboarding_complete).toBe(false); // never touched despite body content
  });

  it('creates a profile row (skip flow) if one somehow does not exist yet', async () => {
    const NEW_ID = '00000000-0000-4000-8000-0000000000f4';
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: NEW_ID, email: 'brandnew@example.com' });

    const { POST } = await import('../app/api/onboarding/complete/route');
    const res = await POST(new Request('http://localhost/api/onboarding/complete', { method: 'POST' }) as never);
    expect(res.status).toBe(200);

    const created = tables.user_profiles.find((r) => r.id === NEW_ID);
    expect(created?.onboarding_complete).toBe(true);
  });
});

// ─── 4. getOnboardingToolOptions() — capability honesty ──────────────────────

describe('getOnboardingToolOptions (capability honesty, Phase 9.1.6-derived)', () => {
  it('never claims an available tool that the capability registry blocks', async () => {
    const { getOnboardingToolOptions } = await import('../lib/onboarding-capabilities');
    const options = getOnboardingToolOptions();

    const byKey = Object.fromEntries(options.map((o) => [o.key, o]));
    // Confirmed genuinely working providers (Phase 9.1.6).
    expect(byKey.slack?.available).toBe(true);
    expect(byKey.shopify?.available).toBe(true);
    expect(byKey.airtable?.available).toBe(true);
    expect(byKey.gmail?.available).toBe(true); // send-only, but real (emailHandler)
    expect(byKey.http?.available).toBe(true);
    // Confirmed blocked by the Phase 9.1.6 capability gate — must never be
    // presented as available, matching Step E's mandatory requirement.
    expect(byKey.google_sheets?.available).toBe(false);
    expect(byKey.hubspot?.available).toBe(false);
    expect(byKey.twilio?.available).toBe(false);
    expect(byKey.google_drive?.available).toBe(false);
  });

  it('every listed tool has a plain, non-technical label (no raw node type strings)', async () => {
    const { getOnboardingToolOptions } = await import('../lib/onboarding-capabilities');
    for (const option of getOnboardingToolOptions()) {
      expect(option.label).not.toContain('n8n-nodes-base');
      expect(option.label.toLowerCase()).not.toContain('handler');
    }
  });
});
