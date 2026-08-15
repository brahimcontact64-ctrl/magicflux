/**
 * Phase 23.1 — Security Hardening Tests
 *
 * Verifies four targeted fixes:
 *   F1 — Incident events never queried before ownership is confirmed
 *   F2 — Trace spans never queried before ownership is confirmed
 *   F3 — requested_by stripped for non-admin callers (workers route)
 *   F4 — Exactly one getUserPermissions call per GET request (no double lookup)
 *
 * Run: npx tsx scripts/test-phase231-security.ts
 */

import { readFileSync } from 'node:fs';
import { resolve }      from 'node:path';

type TestResult = { name: string; section: string; ok: boolean; message?: string };

const results: TestResult[] = [];

function test(section: string, name: string, fn: () => void): void {
  try {
    fn();
    results.push({ section, name, ok: true });
  } catch (err) {
    results.push({ section, name, ok: false, message: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function readSrc(rel: string): string {
  return readFileSync(resolve(__dirname, '..', rel), 'utf8');
}

// ============================================================================
// F1 — Incident events not queried before ownership
// ============================================================================

test('F1 incident-timing', 'getIncidentById: no Promise.all wrapping both queries', () => {
  const src = readSrc('lib/runtime/incident-manager.ts');
  // Extract the function body
  const fnStart = src.indexOf('export async function getIncidentById');
  assert(fnStart !== -1, 'getIncidentById must exist');
  const fnBody = src.slice(fnStart, fnStart + 1200);

  // There must be no Promise.all in this function
  assert(
    !fnBody.includes('Promise.all'),
    'getIncidentById must not use Promise.all (parallel fetch removed)'
  );
});

test('F1 incident-timing', 'getIncidentById: early return before events query', () => {
  const src = readSrc('lib/runtime/incident-manager.ts');
  const fnStart = src.indexOf('export async function getIncidentById');
  const fnBody = src.slice(fnStart, fnStart + 1200);

  // Ownership check (null guard) must appear before the events table name
  const nullGuardIdx    = fnBody.indexOf('if (!incidentRes.data) return null');
  const eventsQueryIdx  = fnBody.indexOf('runtime_incident_events');

  assert(nullGuardIdx  !== -1, 'must have null guard: if (!incidentRes.data) return null');
  assert(eventsQueryIdx !== -1, 'must still query runtime_incident_events after ownership confirmed');
  assert(
    nullGuardIdx < eventsQueryIdx,
    `ownership null-guard (pos ${nullGuardIdx}) must come before events query (pos ${eventsQueryIdx})`
  );
});

test('F1 incident-timing', 'getIncidentById: response shape preserved (incident + incidentEvents)', () => {
  const src = readSrc('lib/runtime/incident-manager.ts');
  const fnStart = src.indexOf('export async function getIncidentById');
  const fnBody = src.slice(fnStart, fnStart + 1200);

  assert(fnBody.includes('incident:'), 'response must include incident field');
  assert(fnBody.includes('incidentEvents:'), 'response must include incidentEvents field');
  assert(fnBody.includes('mapIncidentRow'), 'must map incident row');
  assert(fnBody.includes('mapIncidentEventRow'), 'must map incident event rows');
});

// ============================================================================
// F2 — Trace spans not queried before ownership
// ============================================================================

test('F2 trace-timing', 'traces route: no Promise.all in single-trace path', () => {
  const src = readSrc('app/api/runtime/control/traces/route.ts');
  // The Promise.all was in the `if (id)` branch — check the entire file
  assert(
    !src.includes('Promise.all'),
    'traces/route.ts must not use Promise.all (parallel fetch removed)'
  );
});

test('F2 trace-timing', 'traces route: ownership check before spans query', () => {
  const src = readSrc('app/api/runtime/control/traces/route.ts');
  const ifIdIdx       = src.indexOf('if (id)');
  assert(ifIdIdx !== -1, 'single-trace path must exist');

  const singleTracePath = src.slice(ifIdIdx, ifIdIdx + 1000);

  const ownershipIdx = singleTracePath.indexOf('if (!traceRes.data)');
  const spansIdx     = singleTracePath.indexOf('runtime_spans');

  assert(ownershipIdx !== -1, 'must have 404 guard: if (!traceRes.data)');
  assert(spansIdx     !== -1, 'must still query runtime_spans after ownership confirmed');
  assert(
    ownershipIdx < spansIdx,
    `404 guard (pos ${ownershipIdx}) must come before spans query (pos ${spansIdx})`
  );
});

test('F2 trace-timing', 'traces route: response shape preserved (trace + spans)', () => {
  const src = readSrc('app/api/runtime/control/traces/route.ts');
  assert(src.includes('trace: traceRes.data'), 'response must include trace field');
  assert(src.includes('spans: spansRes.data'), 'response must include spans field');
});

// ============================================================================
// F3 — requested_by hidden for non-admins
// ============================================================================

test('F3 requested_by', 'workers route: isAdmin derived before response build', () => {
  const src = readSrc('app/api/runtime/control/workers/route.ts');
  assert(
    src.includes('const isAdmin = perms.includes(\'admin_runtime\')') ||
    src.includes("const isAdmin = perms.includes('admin_runtime')"),
    'isAdmin must be derived from perms in GET handler'
  );
});

test('F3 requested_by', 'workers route: requested_by stripped for non-admin path', () => {
  const src = readSrc('app/api/runtime/control/workers/route.ts');
  // Must have conditional stripping logic
  assert(
    src.includes('requested_by') && src.includes('isAdmin'),
    'must reference both requested_by and isAdmin in the response building'
  );
  // The stripping pattern: destructure or omit requested_by when not admin
  assert(
    src.includes('requested_by: _rb') ||
    src.includes("requested_by: _") ||
    src.match(/isAdmin[\s\S]{0,200}requested_by/) !== null ||
    src.match(/requested_by[\s\S]{0,200}isAdmin/) !== null,
    'must conditionally exclude requested_by for non-admin callers'
  );
});

test('F3 requested_by', 'workers route: admin path retains full restart request data', () => {
  const src = readSrc('app/api/runtime/control/workers/route.ts');
  // isAdmin path should return rawRequests as-is (no stripping)
  assert(
    src.includes('isAdmin') &&
    (src.includes('? rawRequests') || src.includes('rawRequests\n') || src.includes('rawRequests,')),
    'admin path must return rawRequests without modification'
  );
});

test('F3 requested_by', 'workers route POST still uses requirePermission (unmodified)', () => {
  const src = readSrc('app/api/runtime/control/workers/route.ts');
  assert(
    src.includes("requirePermission(user.id, 'manage_workers')"),
    'POST handler must still use requirePermission for manage_workers'
  );
});

// ============================================================================
// F4 — Single permission lookup per GET request
// ============================================================================

const ROUTES_WITH_DUAL_LOOKUP = [
  { path: 'app/api/runtime/control/incidents/route.ts',        perm: 'view_runtime' },
  { path: 'app/api/runtime/control/overview/route.ts',         perm: 'view_runtime' },
  { path: 'app/api/runtime/control/operator-actions/route.ts', perm: 'view_audit'   },
  { path: 'app/api/runtime/control/metrics/route.ts',          perm: 'view_runtime' },
  { path: 'app/api/runtime/control/traces/route.ts',           perm: 'view_runtime' },
  { path: 'app/api/runtime/control/cost/route.ts',             perm: 'view_runtime' },
  { path: 'app/api/runtime/control/stream/route.ts',           perm: 'view_runtime' },
  { path: 'app/api/runtime/control/workers/route.ts',          perm: 'view_runtime' },
];

for (const { path, perm } of ROUTES_WITH_DUAL_LOOKUP) {
  const shortName = path.split('/').slice(-2).join('/');

  test('F4 single-perm-lookup', `${shortName}: imports getUserPermissions`, () => {
    const src = readSrc(path);
    assert(
      src.includes("getUserPermissions"),
      `${path} must import and call getUserPermissions`
    );
  });

  test('F4 single-perm-lookup', `${shortName}: calls getUserPermissions once in GET`, () => {
    const src = readSrc(path);
    // Count occurrences of the function call
    const callCount = (src.match(/getUserPermissions\s*\(/g) ?? []).length;
    assert(
      callCount === 1,
      `getUserPermissions must be called exactly once, found ${callCount} call(s)`
    );
  });

  test('F4 single-perm-lookup', `${shortName}: no hasPermission call in GET (removed double lookup)`, () => {
    const src = readSrc(path);
    // hasPermission should not appear as a function call (it made the second DB round-trip)
    const hasPermCalls = (src.match(/\bhasPermission\s*\(/g) ?? []).length;
    assert(
      hasPermCalls === 0,
      `hasPermission() must not be called — found ${hasPermCalls} call(s). Use perms array instead.`
    );
  });

  test('F4 single-perm-lookup', `${shortName}: no requirePermission in GET handler (collapsed into getUserPermissions)`, () => {
    const src = readSrc(path);
    // GET handlers should use getUserPermissions directly.
    // For routes with POST that still use requirePermission, we need to be precise.
    // Check that the GET export function body doesn't call requirePermission.
    const getHandlerStart = src.indexOf('export async function GET');
    if (getHandlerStart === -1) return; // no GET handler, skip

    // Find the next export (POST or end of file) to bound the GET body
    const nextExportIdx = src.indexOf('\nexport ', getHandlerStart + 1);
    const getHandlerBody = nextExportIdx === -1
      ? src.slice(getHandlerStart)
      : src.slice(getHandlerStart, nextExportIdx);

    const reqPermInGet = (getHandlerBody.match(/\brequirePermission\s*\(/g) ?? []).length;
    assert(
      reqPermInGet === 0,
      `requirePermission() must not be called in GET handler — found ${reqPermInGet} call(s). Perm check uses getUserPermissions directly.`
    );
  });

  test('F4 single-perm-lookup', `${shortName}: applies admin_runtime bypass correctly`, () => {
    const src = readSrc(path);
    // The permission check must include the admin_runtime bypass
    assert(
      src.includes("perms.includes('admin_runtime')"),
      `must check perms.includes('admin_runtime') to preserve admin bypass logic`
    );
  });

  test('F4 single-perm-lookup', `${shortName}: gates on '${perm}' using perms array`, () => {
    const src = readSrc(path);
    assert(
      src.includes(`perms.includes('${perm}')`),
      `must check perms.includes('${perm}') as primary permission gate`
    );
  });
}

// ============================================================================
// Results
// ============================================================================

const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;

console.log('\n=== Phase 23.1 Security Hardening Tests ===\n');

const bySection = results.reduce<Record<string, TestResult[]>>((acc, r) => {
  (acc[r.section] ??= []).push(r);
  return acc;
}, {});

for (const [section, tests] of Object.entries(bySection)) {
  const sectionFail = tests.filter(t => !t.ok).length;
  const status = sectionFail === 0 ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${section}`);
  for (const t of tests) {
    const icon = t.ok ? '  ✓' : '  ✗';
    console.log(`${icon} ${t.name}`);
    if (!t.ok && t.message) console.log(`      → ${t.message}`);
  }
  console.log('');
}

console.log(`Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
