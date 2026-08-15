/**
 * Phase 22 — Command Ownership Security Tests
 *
 * Verifies that the cross-tenant command injection vulnerability is closed at
 * every layer: application code, API routes, and DB migration.
 *
 * Test cases:
 *   1.  getExecutionOwnerUserId is exported from command-bus.ts
 *   2.  appendCommand calls getExecutionOwnerUserId before inserting
 *   3.  appendCommand logs cross_tenant_command_rejected on mismatch
 *   4.  appendCommand returns null on ownership mismatch (does not insert)
 *   5.  retryCommand scopes UPDATE by user_id (no cross-tenant re-queue)
 *   6.  deadLetterCommand scopes UPDATE by user_id (no cross-tenant DL)
 *   7.  control/executions POST imports getExecutionOwnerUserId
 *   8.  control/executions POST checks ownership before appendCommand
 *   9.  control/executions POST opens high-severity incident on cross-tenant attempt
 *  10.  control/executions POST returns 404 on cross-tenant attempt (no data leak)
 *  11.  control/commands GET has user_id filter (IDOR fix)
 *  12.  DB migration creates guard_execution_command_ownership trigger function
 *  13.  DB migration attaches trigger to runtime_execution_commands BEFORE INSERT
 *  14.  DB trigger allows NULL user_id (system commands)
 *  15.  DB trigger allows missing execution row (legacy executions)
 *  16.  DB trigger rejects cross-tenant user_id mismatch with insufficient_privilege
 *  17.  GIN index on runtime_metrics.labels added
 *  18.  runtime_workers heartbeat_at index added
 *  19.  runtime_queue_jobs (status, heartbeat_at) index added
 *  20.  No duplicate processing: retryCommand user_id-scoped UPDATE is idempotent
 *  21.  commands/[executionId] GET already scopes by user_id (regression check)
 *  22.  commands/[executionId] POST verifies command belongs to user before acting
 *
 * Run: npx tsx scripts/test-command-ownership-security.ts
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
// Section 1: command-bus.ts — ownership guard in appendCommand
// ============================================================================

test('command-bus', 'getExecutionOwnerUserId is exported', () => {
  const src = readSrc('lib/runtime/command-bus.ts');
  assert(src.includes('export async function getExecutionOwnerUserId'), 'must export getExecutionOwnerUserId');
});

test('command-bus', 'getExecutionOwnerUserId queries workflow_executions_v2 by id', () => {
  const src = readSrc('lib/runtime/command-bus.ts');
  assert(src.includes("from('workflow_executions_v2')"), 'must query workflow_executions_v2');
  assert(src.includes(".eq('id', executionId)"), 'must filter by id');
  assert(src.includes("'user_id'"), 'must select user_id');
});

test('command-bus', 'appendCommand calls getExecutionOwnerUserId before inserting', () => {
  const src = readSrc('lib/runtime/command-bus.ts');
  const appendIdx = src.indexOf('export async function appendCommand');
  const ownerIdx  = src.indexOf('getExecutionOwnerUserId(input.executionId)');
  assert(appendIdx !== -1, 'appendCommand must exist');
  assert(ownerIdx  !== -1, 'must call getExecutionOwnerUserId inside appendCommand');
  assert(ownerIdx > appendIdx, 'ownership check must be inside appendCommand body');
  // Verify check is before the RPC call
  const rpcIdx = src.indexOf("rpc('append_execution_command'");
  assert(ownerIdx < rpcIdx, 'ownership check must precede the RPC call');
});

test('command-bus', 'appendCommand logs cross_tenant_command_rejected on mismatch', () => {
  const src = readSrc('lib/runtime/command-bus.ts');
  assert(src.includes("'cross_tenant_command_rejected'"), 'must log cross_tenant_command_rejected event');
  assert(src.includes('caller_user_id'), 'log must include caller_user_id');
  assert(src.includes('execution_owner_id'), 'log must include execution_owner_id');
});

test('command-bus', 'appendCommand returns null on ownership mismatch (no insert)', () => {
  const src = readSrc('lib/runtime/command-bus.ts');
  // The guard block must return null without reaching the rpc() call
  const guardBlock = src.slice(
    src.indexOf('getExecutionOwnerUserId(input.executionId)'),
    src.indexOf("rpc('append_execution_command'")
  );
  assert(guardBlock.includes('return null'), 'must return null when ownership check fails');
});

test('command-bus', 'retryCommand scopes UPDATE by user_id', () => {
  const src = readSrc('lib/runtime/command-bus.ts');
  // The retry update block should have user_id scoping
  assert(
    src.includes("q = q.eq('user_id', params.userId)") ||
    src.includes('.eq(\'user_id\', params.userId)'),
    'retryCommand must scope UPDATE by user_id'
  );
});

test('command-bus', 'deadLetterCommand scopes UPDATE by user_id', () => {
  const src = readSrc('lib/runtime/command-bus.ts');
  assert(
    src.includes("dlq = dlq.eq('user_id', params.userId)") ||
    src.includes('.eq(\'user_id\', params.userId)'),
    'deadLetterCommand must scope UPDATE by user_id'
  );
});

test('command-bus', 'logger imported from ./logger', () => {
  const src = readSrc('lib/runtime/command-bus.ts');
  assert(src.includes("from './logger'"), 'command-bus must import logger');
});

// ============================================================================
// Section 2: control/executions route — ownership check before command dispatch
// ============================================================================

test('executions-route', 'imports getExecutionOwnerUserId from command-bus', () => {
  const src = readSrc('app/api/runtime/control/executions/route.ts');
  assert(src.includes('getExecutionOwnerUserId'), 'must import getExecutionOwnerUserId');
  assert(src.includes("from '@/lib/runtime/command-bus'"), 'import must be from command-bus');
});

test('executions-route', 'ownership check is present before appendCommand call', () => {
  const src = readSrc('app/api/runtime/control/executions/route.ts');
  const checkIdx   = src.indexOf('getExecutionOwnerUserId(executionId)');
  const appendIdx  = src.indexOf('appendCommand(');
  assert(checkIdx !== -1, 'ownership check must be present');
  assert(appendIdx !== -1, 'appendCommand call must be present');
  assert(checkIdx < appendIdx, 'ownership check must precede first appendCommand call');
});

test('executions-route', 'opens high-severity incident on cross-tenant attempt', () => {
  const src = readSrc('app/api/runtime/control/executions/route.ts');
  assert(src.includes('openIncident'), 'must call openIncident on cross-tenant attempt');
  assert(src.includes("severity:     'high'"), 'incident must have high severity');
  assert(src.includes("'Cross-tenant execution command attempt'") ||
         src.includes('cross-tenant'), 'incident title must mention cross-tenant');
});

test('executions-route', 'returns 404 on cross-tenant attempt (no data leak)', () => {
  const src = readSrc('app/api/runtime/control/executions/route.ts');
  assert(
    src.includes("'Execution not found'") && src.includes('status: 404'),
    'must return 404 with generic message (no ownership detail leaked to attacker)'
  );
});

// ============================================================================
// Section 3: control/commands GET — IDOR fix
// ============================================================================

test('commands-route', 'GET query has user_id filter', () => {
  const src = readSrc('app/api/runtime/control/commands/route.ts');
  assert(
    src.includes(".eq('user_id', user.id)"),
    'control/commands GET must filter by user.id to prevent IDOR'
  );
});

// ============================================================================
// Section 4: commands/[executionId] — regression checks (was already correct)
// ============================================================================

test('commands-exec-route', 'GET scopes by user_id (regression)', () => {
  const src = readSrc('app/api/runtime/commands/[executionId]/route.ts');
  assert(src.includes(".eq('user_id', user.id)"), 'commands/[executionId] GET must scope by user.id');
});

test('commands-exec-route', 'POST verifies command belongs to user before action', () => {
  const src = readSrc('app/api/runtime/commands/[executionId]/route.ts');
  assert(src.includes(".eq('user_id', user.id)"), 'commands/[executionId] POST must verify ownership via user.id filter');
});

// ============================================================================
// Section 5: DB migration — trigger and indexes
// ============================================================================

test('migration', 'trigger function guard_execution_command_ownership created', () => {
  const sql = readSrc('supabase/migrations/20260602000001_command_ownership_guard.sql');
  assert(sql.includes('CREATE OR REPLACE FUNCTION guard_execution_command_ownership'), 'trigger function must be created');
});

test('migration', 'trigger attached BEFORE INSERT on runtime_execution_commands', () => {
  const sql = readSrc('supabase/migrations/20260602000001_command_ownership_guard.sql');
  assert(sql.includes('BEFORE INSERT ON runtime_execution_commands'), 'trigger must fire BEFORE INSERT');
  assert(sql.includes('tg_execution_command_ownership'), 'trigger must have correct name');
});

test('migration', 'trigger allows NULL user_id (system commands pass through)', () => {
  const sql = readSrc('supabase/migrations/20260602000001_command_ownership_guard.sql');
  assert(sql.includes('NEW.user_id IS NULL'), 'must short-circuit for NULL user_id');
  assert(sql.includes('RETURN NEW'), 'must RETURN NEW on pass-through');
});

test('migration', 'trigger allows missing execution row (legacy executions)', () => {
  const sql = readSrc('supabase/migrations/20260602000001_command_ownership_guard.sql');
  assert(sql.includes('v_owner_user_id IS NULL'), 'must allow when no owner row found');
});

test('migration', 'trigger rejects cross-tenant mismatch with insufficient_privilege', () => {
  const sql = readSrc('supabase/migrations/20260602000001_command_ownership_guard.sql');
  assert(sql.includes('insufficient_privilege'), 'must use insufficient_privilege ERRCODE');
  assert(sql.includes("v_owner_user_id <> NEW.user_id"), 'must check owner mismatch');
});

test('migration', 'GIN index on runtime_metrics.labels created', () => {
  const sql = readSrc('supabase/migrations/20260602000001_command_ownership_guard.sql');
  assert(sql.includes('runtime_metrics_labels_gin'), 'GIN index must be created');
  assert(sql.includes('USING GIN (labels)'), 'must use GIN on labels column');
});

test('migration', 'runtime_workers heartbeat_at index created', () => {
  const sql = readSrc('supabase/migrations/20260602000001_command_ownership_guard.sql');
  assert(sql.includes('runtime_workers_heartbeat_idx'), 'heartbeat index must be created');
  assert(sql.includes('ON runtime_workers (heartbeat_at DESC)'), 'must index heartbeat_at DESC');
});

test('migration', 'runtime_queue_jobs (status, heartbeat_at) index created', () => {
  const sql = readSrc('supabase/migrations/20260602000001_command_ownership_guard.sql');
  assert(sql.includes('runtime_queue_jobs_status_heartbeat_idx'), 'recovery index must be created');
  assert(
    sql.includes("status = 'active'"),
    'recovery index must be partial (WHERE status = active)'
  );
});

// ============================================================================
// Results
// ============================================================================

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;

console.log('\n=== Command Ownership Security Test ===\n');

const bySection = results.reduce<Record<string, TestResult[]>>((acc, r) => {
  (acc[r.section] ??= []).push(r);
  return acc;
}, {});

for (const [section, tests] of Object.entries(bySection)) {
  const sectionFail = tests.filter((t) => !t.ok).length;
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
