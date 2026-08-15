/**
 * Phase 23 — Security Remediation Tests
 *
 * Statically verifies that all three launch-blocking security findings are
 * closed at every layer (application code, library, and DB migrations).
 *
 * Findings covered:
 *   S-01 — Missing requirePermission + tenant isolation on 9 control-plane GETs
 *   S-02 — Overly permissive default RBAC grant (was 7 permissions, now view_runtime)
 *   S-03 — Permissive USING(true) RLS policies on 5 runtime tables
 *
 * Run: npx tsx scripts/test-phase23-security.ts
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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function readSrc(rel: string): string {
  return readFileSync(resolve(__dirname, '..', rel), 'utf8');
}

// ============================================================================
// S-01: requirePermission on control-plane GET routes
// ============================================================================

const ROUTES_REQUIRING_VIEW_RUNTIME = [
  'app/api/runtime/control/incidents/route.ts',
  'app/api/runtime/control/workers/route.ts',
  'app/api/runtime/control/overview/route.ts',
  'app/api/runtime/control/metrics/route.ts',
  'app/api/runtime/control/traces/route.ts',
  'app/api/runtime/control/cost/route.ts',
  'app/api/runtime/control/stream/route.ts',
];

for (const route of ROUTES_REQUIRING_VIEW_RUNTIME) {
  const shortName = route.split('/').slice(-2).join('/');

  test('S-01 requirePermission', `${shortName} — imports requirePermission`, () => {
    const src = readSrc(route);
    assert(src.includes("requirePermission"), `${route} must import/call requirePermission`);
  });

  test('S-01 requirePermission', `${shortName} — calls requirePermission('view_runtime') in GET`, () => {
    const src = readSrc(route);
    assert(
      src.includes("requirePermission(user.id, 'view_runtime')"),
      `${route} GET must call requirePermission(user.id, 'view_runtime')`
    );
  });
}

test('S-01 requirePermission', 'operator-actions/route.ts — requires view_audit', () => {
  const src = readSrc('app/api/runtime/control/operator-actions/route.ts');
  assert(
    src.includes("requirePermission(user.id, 'view_audit')"),
    'operator-actions GET must require view_audit'
  );
});

test('S-01 requirePermission', 'rbac/route.ts — all-assignments path requires admin_runtime', () => {
  const src = readSrc('app/api/runtime/control/rbac/route.ts');
  assert(
    src.includes("requirePermission(user.id, 'admin_runtime')"),
    'rbac GET must require admin_runtime before returning all assignments'
  );
});

test('S-01 requirePermission', 'metrics/route.ts — snapshot=true requires admin_runtime', () => {
  const src = readSrc('app/api/runtime/control/metrics/route.ts');
  assert(
    src.includes("requirePermission(user.id, 'admin_runtime')"),
    'metrics GET ?snapshot=true must require admin_runtime'
  );
});

// ============================================================================
// S-01: Tenant isolation — user_id scoping on user-scoped tables
// ============================================================================

test('S-01 tenant-isolation', 'incidents/route.ts — passes userId to listActiveIncidents', () => {
  const src = readSrc('app/api/runtime/control/incidents/route.ts');
  assert(src.includes('userId:') && src.includes('scopedUserId'),
    'incidents route must pass scopedUserId to listActiveIncidents');
});

test('S-01 tenant-isolation', 'incidents/route.ts — passes userId to getIncidentById', () => {
  const src = readSrc('app/api/runtime/control/incidents/route.ts');
  assert(src.includes('getIncidentById(id, scopedUserId)'),
    'incidents route must pass scopedUserId to getIncidentById');
});

test('S-01 tenant-isolation', 'traces/route.ts — scopes query by user_id for non-admin', () => {
  const src = readSrc('app/api/runtime/control/traces/route.ts');
  assert(
    src.includes(".eq('user_id', user.id)"),
    'traces route must filter by user.id for non-admin'
  );
});

test('S-01 tenant-isolation', 'cost/route.ts — passes userId to getCostSummary', () => {
  const src = readSrc('app/api/runtime/control/cost/route.ts');
  assert(
    src.includes('getCostSummary(safeDays, scopedUserId)'),
    'cost route must pass scopedUserId to getCostSummary'
  );
  assert(
    src.includes('getTopCostlyWorkflows(safeTop, scopedUserId)'),
    'cost route must pass scopedUserId to getTopCostlyWorkflows'
  );
});

test('S-01 tenant-isolation', 'operator-actions/route.ts — scopes by operator_id for non-admin', () => {
  const src = readSrc('app/api/runtime/control/operator-actions/route.ts');
  assert(
    src.includes(".eq('operator_id', user.id)"),
    'operator-actions route must filter by operator_id for non-admin'
  );
});

test('S-01 tenant-isolation', 'overview/route.ts — scopes commands by user_id for non-admin', () => {
  const src = readSrc('app/api/runtime/control/overview/route.ts');
  assert(
    src.includes(".eq('user_id', user.id)"),
    'overview route must filter commands by user_id for non-admin'
  );
});

test('S-01 tenant-isolation', 'stream/route.ts — passes scopedUserId to fetchRuntimeState', () => {
  const src = readSrc('app/api/runtime/control/stream/route.ts');
  assert(
    src.includes('fetchRuntimeState(db, scopedUserId)'),
    'stream route must pass scopedUserId to fetchRuntimeState'
  );
  assert(
    src.includes('.eq(\'user_id\', scopedUserId)') ||
    src.includes(".eq('user_id', scopedUserId)"),
    'fetchRuntimeState must scope commands by user_id when scopedUserId is set'
  );
});

test('S-01 tenant-isolation', 'incident-manager.ts — listActiveIncidents accepts userId param', () => {
  const src = readSrc('lib/runtime/incident-manager.ts');
  assert(
    src.includes('userId?:') && src.includes("q = q.eq('user_id', params.userId)"),
    'listActiveIncidents must accept and apply optional userId filter'
  );
});

test('S-01 tenant-isolation', 'incident-manager.ts — getIncidentById accepts userId param', () => {
  const src = readSrc('lib/runtime/incident-manager.ts');
  assert(
    src.includes('getIncidentById(incidentId: string, userId?: string)'),
    'getIncidentById must accept optional userId for tenant scoping'
  );
});

test('S-01 tenant-isolation', 'cost-engine.ts — getCostSummary accepts userId param', () => {
  const src = readSrc('lib/runtime/cost-engine.ts');
  assert(
    src.includes('getCostSummary(windowDays: number = 30, userId?: string)'),
    'getCostSummary must accept optional userId'
  );
  assert(
    src.includes("q = q.eq('user_id', userId)"),
    'getCostSummary must apply user_id filter when userId is provided'
  );
});

test('S-01 tenant-isolation', 'cost-engine.ts — getTopCostlyWorkflows passes userId to getCostSummary', () => {
  const src = readSrc('lib/runtime/cost-engine.ts');
  assert(
    src.includes('getTopCostlyWorkflows(limit: number = 10, userId?: string)'),
    'getTopCostlyWorkflows must accept optional userId'
  );
  assert(
    src.includes('getCostSummary(30, userId)'),
    'getTopCostlyWorkflows must pass userId to getCostSummary'
  );
});

// ============================================================================
// S-02: Default RBAC grant reduced to view_runtime only
// ============================================================================

test('S-02 default-permissions', "rbac.ts default returns only ['view_runtime']", () => {
  const src = readSrc('lib/runtime/rbac.ts');
  // The old overly-broad default returned 7 permissions
  assert(
    !src.includes("'manage_workers'") || !src.includes("return [") ||
    !src.match(/return \[[\s\S]*?'manage_workers'/),
    'default permissions must NOT include manage_workers'
  );
});

test('S-02 default-permissions', "rbac.ts default returns exactly view_runtime", () => {
  const src = readSrc('lib/runtime/rbac.ts');
  assert(
    src.includes("return ['view_runtime']"),
    "getUserPermissions must return ['view_runtime'] as the no-assignment default"
  );
});

test('S-02 default-permissions', 'migration 20260601000004 exists', () => {
  const sql = readSrc('supabase/migrations/20260601000004_preserve_operator_access.sql');
  assert(sql.length > 0, 'backward-compat migration must exist');
});

test('S-02 default-permissions', 'migration 20260601000004 backfills operator role', () => {
  const sql = readSrc('supabase/migrations/20260601000004_preserve_operator_access.sql');
  assert(sql.includes("name = 'operator'"), 'must look up operator role');
  assert(
    sql.includes('FROM auth.users') || sql.includes('from auth.users'),
    'must query auth.users to find existing users'
  );
  assert(
    sql.includes('INSERT INTO runtime_role_assignments'),
    'must insert into runtime_role_assignments'
  );
  assert(
    sql.includes('NOT EXISTS'),
    'must only assign role to users with no existing assignment'
  );
  assert(
    sql.includes('ON CONFLICT') && sql.includes('DO NOTHING'),
    'must be idempotent via ON CONFLICT DO NOTHING'
  );
});

// ============================================================================
// S-03: Permissive USING(true) RLS policies replaced
// ============================================================================

test('S-03 rls-policies', 'migration 20260601000003 exists', () => {
  const sql = readSrc('supabase/migrations/20260601000003_fix_permissive_rls.sql');
  assert(sql.length > 0, 'RLS fix migration must exist');
});

const RLS_TABLES = [
  { table: 'runtime_execution_events',   oldPolicies: ['Service can insert execution events', 'Service can read execution events'] },
  { table: 'runtime_idempotency_keys',   oldPolicies: ['Service can manage idempotency keys'] },
  { table: 'runtime_execution_commands', oldPolicies: ['Service can insert execution commands', 'Service can read execution commands', 'Service can update execution commands'] },
  { table: 'runtime_command_dispatch_log', oldPolicies: ['Service can manage command dispatch log'] },
  { table: 'runtime_workflow_versions',  oldPolicies: ['Service can manage workflow versions'] },
];

for (const { table, oldPolicies } of RLS_TABLES) {
  test('S-03 rls-policies', `${table} — old USING(true) policies dropped`, () => {
    const sql = readSrc('supabase/migrations/20260601000003_fix_permissive_rls.sql');
    for (const policy of oldPolicies) {
      assert(
        sql.includes(`DROP POLICY IF EXISTS "${policy}"`),
        `must DROP POLICY "${policy}" on ${table}`
      );
    }
  });

  test('S-03 rls-policies', `${table} — new service_role policy created`, () => {
    const sql = readSrc('supabase/migrations/20260601000003_fix_permissive_rls.sql');
    assert(
      sql.includes(table) && sql.includes("auth.role() = 'service_role'"),
      `${table} must have a new policy using auth.role() = 'service_role'`
    );
  });
}

test('S-03 rls-policies', 'migration has no remaining USING(true) policies', () => {
  const sql = readSrc('supabase/migrations/20260601000003_fix_permissive_rls.sql');
  // Strip block comments (/* ... */) before scanning
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = stripped.split('\n').filter(l =>
    !l.trim().startsWith('--') &&
    !l.includes('DROP POLICY') &&
    (l.includes('USING (true)') || l.includes('WITH CHECK (true)'))
  );
  assert(lines.length === 0, `migration must not create any new USING(true)/WITH CHECK(true) policies — found: ${lines.join('; ')}`);
});

// ============================================================================
// Results
// ============================================================================

const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;

console.log('\n=== Phase 23 Security Remediation Tests ===\n');

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
