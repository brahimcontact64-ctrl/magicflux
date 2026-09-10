/**
 * Phase 9.6.2 — Multi-Founder architecture audit.
 *
 * MagicFlux has two co-founders and the Founder/Admin mechanism
 * (app_metadata.role === 'admin', checked by isAdminUser() in
 * lib/supabase-server.ts) must support any number of independently
 * authenticated Founder accounts, never a single shared identity, and
 * must never let Founder status reach into runtime security, capability
 * validation, tenant isolation, Code/Function restrictions, or secret
 * protection -- those systems must stay unaware admin status exists at
 * all (see FOUNDER_PLAN's own doc comment in lib/billing/plan-limits.ts
 * and evaluateToolSafety()'s in lib/agent/safety.ts).
 *
 * This suite pins both properties as executable, CI-enforced invariants
 * rather than comments that can silently drift:
 *
 *   A) isAdminUser() is only ever imported by an explicit, reviewed
 *      allowlist of files. Adding a new import anywhere else (e.g. into
 *      node-capabilities.ts, a tenant-scoped /api/workflows/* route, or
 *      the credential/secret layer) fails this test immediately, forcing
 *      a deliberate decision instead of a silent scope creep.
 *
 *   B) isAdminUser() is purely a function of the userId argument -- no
 *      caching, no module-level "the admin" singleton -- so two distinct
 *      accounts, each independently granted app_metadata.role:'admin',
 *      are each recognized as Founders on their own, and revoking one
 *      never affects the other.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── A: isAdminUser() import allowlist ─────────────────────────────────────

// Every non-test file allowed to import/reference isAdminUser, and why:
//  - lib/supabase-server.ts       -- defines it
//  - middleware.ts                -- gates /admin/:path* pages
//  - app/api/admin/**             -- admin-only API routes (feedback,
//                                     beta-metrics, dev/assign-pro, deploy,
//                                     generate, requests)
//  - lib/feedback.ts              -- doc-comment only ("caller must have
//                                     already verified isAdminUser()"), no
//                                     capability/tenant/secret logic here
//  - lib/billing/plan-limits.ts   -- commercial plan-limit bypass ONLY
//  - lib/agent/safety.ts          -- commercial AI-cost-quota bypass ONLY
const ALLOWED_FILES = new Set([
  'lib/supabase-server.ts',
  'middleware.ts',
  'lib/feedback.ts',
  'lib/billing/plan-limits.ts',
  'lib/agent/safety.ts',
  'app/api/admin/feedback/route.ts',
  'app/api/admin/beta-metrics/route.ts',
  'app/api/admin/dev/assign-pro/route.ts',
  'app/api/admin/deploy/route.ts',
  'app/api/admin/generate/route.ts',
  'app/api/admin/requests/route.ts',
]);

// Systems that FOUNDER_PLAN/evaluateToolSafety's own doc comments claim
// have "nothing here for them to trust" -- explicitly pinned as isAdminUser-free.
const MUST_STAY_ADMIN_UNAWARE = [
  'lib/workflow-runtime/node-capabilities.ts', // capability validation / Code+Function prohibition
  'lib/security/ssrf-guard.ts',
  'lib/security/redact.ts',
  'lib/security/encryption.ts',
];

function walk(dir: string, results: string[] = []): string[] {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'temp-check') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, results);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) results.push(full);
  }
  return results;
}

function toRelPosix(file: string): string {
  return path.relative(process.cwd(), file).replace(/\\/g, '/');
}

describe('A — isAdminUser() usage stays within an explicit, reviewed allowlist', () => {
  const files = [...walk('lib'), ...walk('app/api'), path.join(process.cwd(), 'middleware.ts')];

  it('every non-test file referencing isAdminUser is on the allowlist', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = toRelPosix(file);
      if (rel.endsWith('.test.ts') || rel.endsWith('.security.test.ts')) continue;
      const content = fs.readFileSync(file, 'utf8');
      if (/\bisAdminUser\b/.test(content) && !ALLOWED_FILES.has(rel)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `New isAdminUser() usage found outside the reviewed allowlist: ${offenders.join(', ')}. ` +
        `If this is deliberate, add it to ALLOWED_FILES in this test only after confirming it cannot bypass ` +
        `capability validation, tenant isolation, Code/Function restrictions, or secret protection.`,
    ).toEqual([]);
  });

  for (const file of MUST_STAY_ADMIN_UNAWARE) {
    it(`${file} contains no reference to isAdminUser or app_metadata (stays admin-unaware)`, () => {
      const full = path.join(process.cwd(), file);
      if (!fs.existsSync(full)) return; // file may not exist in every checkout state; not this suite's concern
      const content = fs.readFileSync(full, 'utf8');
      expect(/isAdminUser|app_metadata/.test(content)).toBe(false);
    });
  }
});

// ─── B: isAdminUser() is per-account, not a cached singleton ───────────────

let userRecords: Record<string, { app_metadata?: Record<string, unknown> }>;

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      admin: {
        getUserById: vi.fn(async (id: string) => {
          const user = userRecords[id];
          if (!user) return { data: { user: null }, error: { message: 'not found' } };
          return { data: { user }, error: null };
        }),
      },
    },
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('B — two independent Founder accounts are each recognized on their own merits', () => {
  it('two distinct accounts, each with app_metadata.role:"admin", both independently resolve to admin -- no shared/global admin identity', async () => {
    userRecords = {
      'founder-account-1': { app_metadata: { role: 'admin' } },
      'founder-account-2': { app_metadata: { role: 'admin' } },
      'ordinary-account': { app_metadata: {} },
    };

    const { isAdminUser } = await import('../lib/supabase-server');

    expect(await isAdminUser('founder-account-1')).toBe(true);
    expect(await isAdminUser('founder-account-2')).toBe(true);
    expect(await isAdminUser('ordinary-account')).toBe(false);
  });

  it('revoking one Founder account never affects the other (no cross-account caching)', async () => {
    userRecords = {
      'founder-account-1': { app_metadata: { role: 'admin' } },
      'founder-account-2': { app_metadata: { role: 'admin' } },
    };
    const { isAdminUser } = await import('../lib/supabase-server');
    expect(await isAdminUser('founder-account-1')).toBe(true);
    expect(await isAdminUser('founder-account-2')).toBe(true);

    // Revoke account 1 only (what an offboarding would do), independently of account 2.
    userRecords['founder-account-1'] = { app_metadata: {} };

    expect(await isAdminUser('founder-account-1')).toBe(false);
    expect(await isAdminUser('founder-account-2')).toBe(true); // unaffected
  });

  it('order of checks does not matter -- checking account 2 first does not "warm" account 1', async () => {
    userRecords = {
      'founder-account-1': { app_metadata: { role: 'admin' } },
      'founder-account-2': { app_metadata: {} },
    };
    const { isAdminUser } = await import('../lib/supabase-server');

    expect(await isAdminUser('founder-account-2')).toBe(false);
    expect(await isAdminUser('founder-account-1')).toBe(true);
  });
});
