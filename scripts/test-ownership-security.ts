/**
 * Ownership & Security Regression Suite
 *
 * Tests the three ownership assertion functions in lib/security/ownership.ts
 * and verifies that cross-user attack vectors are correctly blocked.
 *
 * Run: npx tsx scripts/test-ownership-security.ts
 */

process.env.INTEGRATIONS_ENCRYPTION_KEY = '0'.repeat(64);
process.env.NEXT_PUBLIC_APP_URL = 'https://test.magicflux.app';

import { v4 as uuidv4, v1 as uuidv1 } from 'uuid';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertTrustedUserId } from '@/lib/credentials/storage';
import {
  assertWorkflowOwnership,
  assertCredentialOwnership,
  assertExecutionOwnership,
} from '@/lib/security/ownership';

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name}\n      ${msg}`);
    failed++;
    failures.push(`${name}: ${msg}`);
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name}\n      ${msg}`);
    failed++;
    failures.push(`${name}: ${msg}`);
  }
}

function section(title: string) {
  console.log(`\n── ${title} ─`);
}

function throws(fn: () => unknown, expectedSubstring: string): void {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes(expectedSubstring)) {
      throw new Error(`Expected error containing "${expectedSubstring}", got: "${msg}"`);
    }
  }
  if (!threw) throw new Error('Expected function to throw, but it did not');
}

async function throwsAsync(fn: () => Promise<unknown>, expectedSubstring: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes(expectedSubstring)) {
      throw new Error(`Expected error containing "${expectedSubstring}", got: "${msg}"`);
    }
  }
  if (!threw) throw new Error('Expected async function to throw, but it did not');
}

const ROOT = resolve(process.cwd());

function routeSource(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf-8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {

  // ── 1. assertTrustedUserId ─────────────────────────────────────────────────

  section('1. assertTrustedUserId — UUID v4 validation');

  test('accepts a valid UUID v4', () => {
    assertTrustedUserId(uuidv4());
  });

  test('rejects empty string', () => {
    throws(() => assertTrustedUserId(''), 'SECURITY');
  });

  test('rejects whitespace-only string', () => {
    throws(() => assertTrustedUserId('   '), 'SECURITY');
  });

  test('rejects non-UUID string', () => {
    throws(() => assertTrustedUserId('not-a-uuid'), 'SECURITY');
  });

  test('rejects UUID v1', () => {
    throws(() => assertTrustedUserId(uuidv1()), 'SECURITY');
  });

  test('rejects UUID v3 (version nibble flipped)', () => {
    const v4 = uuidv4();
    const v3 = v4.slice(0, 14) + '3' + v4.slice(15);
    throws(() => assertTrustedUserId(v3), 'SECURITY');
  });

  test('rejects a numeric string', () => {
    throws(() => assertTrustedUserId('12345'), 'SECURITY');
  });

  test("rejects SQL injection as userId (' OR '1'='1)", () => {
    throws(() => assertTrustedUserId("' OR '1'='1"), 'SECURITY');
  });

  test('rejects zero UUID', () => {
    throws(() => assertTrustedUserId('00000000-0000-0000-0000-000000000000'), 'SECURITY');
  });

  test('rejects UUID v1 (time-based)', () => {
    throws(() => assertTrustedUserId('550e8400-e29b-11d4-a716-446655440000'), 'SECURITY');
  });

  // ── 2. assertWorkflowOwnership — guard layer (bad input, no DB needed) ─────

  section('2. assertWorkflowOwnership — userId guard fires before DB');

  await testAsync('rejects non-UUID userId', async () => {
    await throwsAsync(() => assertWorkflowOwnership('not-a-uuid', uuidv4()), 'SECURITY');
  });

  await testAsync('rejects empty string userId', async () => {
    await throwsAsync(() => assertWorkflowOwnership('', uuidv4()), 'SECURITY');
  });

  await testAsync('rejects UUID v1 as userId', async () => {
    await throwsAsync(() => assertWorkflowOwnership(uuidv1(), uuidv4()), 'SECURITY');
  });

  await testAsync('rejects SQL injection as userId', async () => {
    await throwsAsync(() => assertWorkflowOwnership("1' OR '1'='1", 'wf-123'), 'SECURITY');
  });

  await testAsync('rejects empty workflowId', async () => {
    await throwsAsync(() => assertWorkflowOwnership(uuidv4(), ''), 'SECURITY');
  });

  await testAsync('rejects null workflowId', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await throwsAsync(() => assertWorkflowOwnership(uuidv4(), null as any), 'SECURITY');
  });

  // ── 3. assertCredentialOwnership — guard layer ─────────────────────────────

  section('3. assertCredentialOwnership — userId guard fires before DB');

  await testAsync('rejects non-UUID userId', async () => {
    await throwsAsync(() => assertCredentialOwnership('bad-id', 'gmail'), 'SECURITY');
  });

  await testAsync('rejects empty userId', async () => {
    await throwsAsync(() => assertCredentialOwnership('', 'gmail'), 'SECURITY');
  });

  await testAsync('rejects empty provider', async () => {
    await throwsAsync(() => assertCredentialOwnership(uuidv4(), ''), 'SECURITY');
  });

  await testAsync('rejects null provider', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await throwsAsync(() => assertCredentialOwnership(uuidv4(), null as any), 'SECURITY');
  });

  await testAsync('rejects numeric-string userId', async () => {
    await throwsAsync(() => assertCredentialOwnership('99999', 'gmail'), 'SECURITY');
  });

  // ── 4. assertExecutionOwnership — guard layer ──────────────────────────────

  section('4. assertExecutionOwnership — userId guard fires before DB');

  await testAsync('rejects non-UUID userId', async () => {
    await throwsAsync(() => assertExecutionOwnership('not-a-uuid', uuidv4()), 'SECURITY');
  });

  await testAsync('rejects empty userId', async () => {
    await throwsAsync(() => assertExecutionOwnership('', uuidv4()), 'SECURITY');
  });

  await testAsync('rejects empty executionId', async () => {
    await throwsAsync(() => assertExecutionOwnership(uuidv4(), ''), 'SECURITY');
  });

  await testAsync('rejects null executionId', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await throwsAsync(() => assertExecutionOwnership(uuidv4(), null as any), 'SECURITY');
  });

  await testAsync('rejects UUID v1 as userId', async () => {
    await throwsAsync(() => assertExecutionOwnership(uuidv1(), uuidv4()), 'SECURITY');
  });

  // ── 5. Cross-user attack vector simulation ─────────────────────────────────

  section('5. Cross-user attack vectors — forged userId values all rejected');

  const ATTACK_VECTORS: Array<{ name: string; value: string }> = [
    { name: 'numeric id', value: '12345' },
    { name: 'object injection', value: '[object Object]' },
    { name: 'prototype pollution', value: '__proto__' },
    { name: 'double-quote injection', value: '"id" = "1"' },
    { name: 'null byte in string', value: 'valid-prefix\x00suffix' },
    { name: 'excessively long string', value: 'a'.repeat(1000) },
    { name: 'UUID with extra chars', value: uuidv4() + '-extra' },
    { name: 'whitespace-padded UUID', value: ' ' + uuidv4() + ' ' },
  ];

  for (const { name, value } of ATTACK_VECTORS) {
    test(`assertTrustedUserId rejects: ${name}`, () => {
      throws(() => assertTrustedUserId(value), 'SECURITY');
    });
  }

  // ── 6. Error message safety — no information leakage ──────────────────────

  section('6. Error message safety — SECURITY prefix, no resource detail leakage');

  test('assertTrustedUserId error does not echo back the rejected value', () => {
    const badId = 'definitely-not-a-uuid-injected';
    let errorMsg = '';
    try { assertTrustedUserId(badId); } catch (err) {
      errorMsg = err instanceof Error ? err.message : '';
    }
    if (errorMsg.includes(badId)) {
      throw new Error('Error message leaks the rejected userId value');
    }
    if (!errorMsg.startsWith('SECURITY:')) {
      throw new Error(`Expected SECURITY: prefix, got: "${errorMsg}"`);
    }
  });

  await testAsync('assertWorkflowOwnership empty workflowId error starts with SECURITY:', async () => {
    let errorMsg = '';
    try { await assertWorkflowOwnership(uuidv4(), ''); } catch (err) {
      errorMsg = err instanceof Error ? err.message : '';
    }
    if (!errorMsg.startsWith('SECURITY:')) {
      throw new Error(`Expected SECURITY: prefix, got: "${errorMsg}"`);
    }
  });

  await testAsync('assertCredentialOwnership empty provider error starts with SECURITY:', async () => {
    let errorMsg = '';
    try { await assertCredentialOwnership(uuidv4(), ''); } catch (err) {
      errorMsg = err instanceof Error ? err.message : '';
    }
    if (!errorMsg.startsWith('SECURITY:')) {
      throw new Error(`Expected SECURITY: prefix, got: "${errorMsg}"`);
    }
  });

  await testAsync('assertExecutionOwnership empty executionId error starts with SECURITY:', async () => {
    let errorMsg = '';
    try { await assertExecutionOwnership(uuidv4(), ''); } catch (err) {
      errorMsg = err instanceof Error ? err.message : '';
    }
    if (!errorMsg.startsWith('SECURITY:')) {
      throw new Error(`Expected SECURITY: prefix, got: "${errorMsg}"`);
    }
  });

  // ── 7. Route ownership wiring — structural analysis ────────────────────────

  section('7. Route ownership wiring — import and call order verification');

  test('graph/mutate/route.ts imports assertWorkflowOwnership', () => {
    const c = routeSource('app/api/workflows/[id]/graph/mutate/route.ts');
    if (!c.includes('assertWorkflowOwnership')) {
      throw new Error('assertWorkflowOwnership not imported');
    }
  });

  test('graph/mutate/route.ts calls assertWorkflowOwnership before GraphMutationEngine', () => {
    const c = routeSource('app/api/workflows/[id]/graph/mutate/route.ts');
    // Use lastIndexOf to find the call sites, not the import declarations
    const ownerPos = c.lastIndexOf('assertWorkflowOwnership(');
    const enginePos = c.lastIndexOf('new GraphMutationEngine(');
    if (ownerPos === -1) throw new Error('assertWorkflowOwnership call not found');
    if (enginePos === -1) throw new Error('new GraphMutationEngine() call not found');
    if (ownerPos > enginePos) throw new Error('assertWorkflowOwnership must precede GraphMutationEngine');
  });

  test('graph/mutate/route.ts 404s on ownership failure (not 403 — no info leak)', () => {
    const c = routeSource('app/api/workflows/[id]/graph/mutate/route.ts');
    // Search the block between the ownership call and the engine instantiation
    const ownerPos = c.lastIndexOf('assertWorkflowOwnership(');
    const enginePos = c.lastIndexOf('new GraphMutationEngine(');
    if (ownerPos === -1 || enginePos === -1) throw new Error('Could not locate call sites');
    const ownerBlock = c.slice(ownerPos, enginePos);
    if (!ownerBlock.includes('404')) {
      throw new Error('Ownership failure must return 404, not expose access denied');
    }
  });

  test('credentials/delete/route.ts imports assertCredentialOwnership', () => {
    const c = routeSource('app/api/credentials/delete/route.ts');
    if (!c.includes('assertCredentialOwnership')) {
      throw new Error('assertCredentialOwnership not imported');
    }
  });

  test('credentials/delete/route.ts calls assertCredentialOwnership before deleteProviderCredentials', () => {
    const c = routeSource('app/api/credentials/delete/route.ts');
    const ownerPos = c.lastIndexOf('assertCredentialOwnership(');
    const deletePos = c.lastIndexOf('deleteProviderCredentials(');
    if (ownerPos === -1) throw new Error('assertCredentialOwnership call not found');
    if (deletePos === -1) throw new Error('deleteProviderCredentials call not found');
    if (ownerPos > deletePos) throw new Error('assertCredentialOwnership must precede deleteProviderCredentials');
  });

  test('credentials/delete/route.ts 404s on ownership failure', () => {
    const c = routeSource('app/api/credentials/delete/route.ts');
    const ownerPos = c.lastIndexOf('assertCredentialOwnership(');
    const deletePos = c.lastIndexOf('deleteProviderCredentials(');
    if (ownerPos === -1 || deletePos === -1) throw new Error('Could not locate call sites');
    const ownerBlock = c.slice(ownerPos, deletePos);
    if (!ownerBlock.includes('404')) {
      throw new Error('Ownership failure must return 404');
    }
  });

  test('oauth/refresh/route.ts imports assertCredentialOwnership', () => {
    const c = routeSource('app/api/oauth/refresh/route.ts');
    if (!c.includes('assertCredentialOwnership')) {
      throw new Error('assertCredentialOwnership not imported');
    }
  });

  test('oauth/refresh/route.ts calls assertCredentialOwnership before getValidAccessToken', () => {
    const c = routeSource('app/api/oauth/refresh/route.ts');
    const ownerPos = c.lastIndexOf('assertCredentialOwnership(');
    const refreshPos = c.lastIndexOf('getValidAccessToken(');
    if (ownerPos === -1) throw new Error('assertCredentialOwnership call not found');
    if (refreshPos === -1) throw new Error('getValidAccessToken call not found');
    if (ownerPos > refreshPos) throw new Error('assertCredentialOwnership must precede getValidAccessToken');
  });

  test('oauth/refresh/route.ts 404s on ownership failure', () => {
    const c = routeSource('app/api/oauth/refresh/route.ts');
    const ownerPos = c.lastIndexOf('assertCredentialOwnership(');
    const refreshPos = c.lastIndexOf('getValidAccessToken(');
    if (ownerPos === -1 || refreshPos === -1) throw new Error('Could not locate call sites');
    const ownerBlock = c.slice(ownerPos, refreshPos);
    if (!ownerBlock.includes('404')) {
      throw new Error('Ownership failure must return 404');
    }
  });

  // ── 8. executions/resume route — workflow fetch user_id filter ─────────────

  section('8. executions/resume/route.ts — workflow fetch scoped to authenticated user');

  test('resume route workflow fetch includes .eq("user_id", user.id)', () => {
    const c = routeSource('app/api/workflows/executions/resume/route.ts');
    const fetchStart = c.indexOf(".from('workflows')");
    const fetchEnd = c.indexOf('const workflowMap');
    if (fetchStart === -1) throw new Error(".from('workflows') not found");
    if (fetchEnd === -1) throw new Error('workflowMap construction not found');
    const fetchBlock = c.slice(fetchStart, fetchEnd);
    if (!fetchBlock.includes(".eq('user_id', user.id)")) {
      throw new Error(
        "Workflow fetch missing .eq('user_id', user.id) — cross-user execution resume bug"
      );
    }
  });

  test('resume route execution query is already scoped to user.id', () => {
    const c = routeSource('app/api/workflows/executions/resume/route.ts');
    if (!c.includes(".eq('user_id', user.id)")) {
      throw new Error("No .eq('user_id', user.id) found in resume route");
    }
  });

  // ── 9. n8n orchestrate — user_id on UPDATE calls ───────────────────────────

  section('9. n8n/orchestrate/route.ts — user_id on workflow_executions UPDATEs');

  test('OAuth-path workflow_executions UPDATE includes user_id filter', () => {
    const c = routeSource('app/api/n8n/orchestrate/route.ts');
    // The OAuth-path update contains orchestration_stage: 'complete' and credential_types_provisioned
    const oauthUpdateIdx = c.indexOf("orchestration_stage: 'complete', credential_types_provisioned");
    if (oauthUpdateIdx === -1) throw new Error('OAuth-path UPDATE block not found');
    const blockEnd = c.indexOf('.then(() => {}, () => {})', oauthUpdateIdx) + 30;
    const block = c.slice(oauthUpdateIdx, blockEnd);
    if (!block.includes(".eq('user_id', authUser.id)")) {
      throw new Error("OAuth-path workflow_executions UPDATE missing .eq('user_id', authUser.id)");
    }
  });

  test('activation workflow_executions UPDATE includes user_id filter', () => {
    const c = routeSource('app/api/n8n/orchestrate/route.ts');
    const activationIdx = c.indexOf("status: 'active',\n      activated_at");
    if (activationIdx === -1) throw new Error('Activation UPDATE block not found');
    const blockEnd = c.indexOf('.then(() => {}, () => {})', activationIdx) + 30;
    const block = c.slice(activationIdx, blockEnd);
    if (!block.includes(".eq('user_id', authUser.id)")) {
      throw new Error("Activation workflow_executions UPDATE missing .eq('user_id', authUser.id)");
    }
  });

  test('workflow_executions INSERT includes user_id', () => {
    const c = routeSource('app/api/n8n/orchestrate/route.ts');
    const insertIdx = c.indexOf("from('workflow_executions').insert");
    if (insertIdx === -1) throw new Error('workflow_executions INSERT not found');
    const block = c.slice(insertIdx, c.indexOf('.then(() => {}, () => {})', insertIdx) + 30);
    if (!block.includes('user_id: authUser.id')) {
      throw new Error("workflow_executions INSERT missing user_id: authUser.id");
    }
  });

  // ── 10. RLS migration content checks ───────────────────────────────────────

  section('10. RLS hardening migration — 20260522000002 content verification');

  const rlsPath = 'supabase/migrations/20260522000002_ownership_rls_hardening.sql';

  test('RLS hardening migration file exists', () => {
    readFileSync(resolve(ROOT, rlsPath), 'utf-8');
  });

  test('RLS migration drops runtime_workers policies', () => {
    const c = readFileSync(resolve(ROOT, rlsPath), 'utf-8');
    if (!c.includes('DROP POLICY') || !c.includes('runtime_workers')) {
      throw new Error('Must drop runtime_workers policies');
    }
  });

  test('RLS migration drops runtime_webhook_nonces policies', () => {
    const c = readFileSync(resolve(ROOT, rlsPath), 'utf-8');
    if (!c.includes('runtime_webhook_nonces')) {
      throw new Error('Must address runtime_webhook_nonces');
    }
  });

  test('RLS migration fixes runtime_webhook_request_log — no IS NULL in new policy', () => {
    const c = readFileSync(resolve(ROOT, rlsPath), 'utf-8');
    if (!c.includes('runtime_webhook_request_log')) {
      throw new Error('Must address runtime_webhook_request_log');
    }
    // New policy section (after the DROP) must not include IS NULL
    const afterDrop = c.slice(c.lastIndexOf('DROP POLICY IF EXISTS "Users can access own webhook logs"'));
    const newPolicySection = afterDrop.slice(0, afterDrop.indexOf('runtime_security_alerts'));
    if (newPolicySection.includes('IS NULL')) {
      throw new Error('New runtime_webhook_request_log policy must not leak IS NULL rows');
    }
  });

  test('RLS migration fixes runtime_security_alerts — no IS NULL in new policy', () => {
    const c = readFileSync(resolve(ROOT, rlsPath), 'utf-8');
    const afterDrop = c.slice(c.lastIndexOf('DROP POLICY IF EXISTS "Users can access own security alerts"'));
    const section = afterDrop.slice(0, afterDrop.indexOf('runtime_metrics_minute'));
    if (section.includes('IS NULL')) {
      throw new Error('New runtime_security_alerts policy must not leak IS NULL rows');
    }
  });

  test('RLS migration fixes runtime_metrics_minute — no IS NULL in new policy', () => {
    const c = readFileSync(resolve(ROOT, rlsPath), 'utf-8');
    const afterDrop = c.slice(c.lastIndexOf('DROP POLICY IF EXISTS "Users can access own runtime metrics"'));
    if (afterDrop.includes('IS NULL')) {
      throw new Error('New runtime_metrics_minute policy must not leak IS NULL rows');
    }
  });

  // ── 11. lib/security/ownership.ts source contract ─────────────────────────

  section('11. lib/security/ownership.ts — source-level contract verification');

  test('ownership.ts exists', () => {
    readFileSync(resolve(ROOT, 'lib/security/ownership.ts'), 'utf-8');
  });

  test('ownership.ts calls assertTrustedUserId before createServiceClient in all three functions', () => {
    const c = readFileSync(resolve(ROOT, 'lib/security/ownership.ts'), 'utf-8');
    const fns = ['assertWorkflowOwnership', 'assertCredentialOwnership', 'assertExecutionOwnership'];
    for (const fn of fns) {
      const fnStart = c.indexOf(`async function ${fn}`);
      if (fnStart === -1) throw new Error(`${fn} not found`);
      const fnBody = c.slice(fnStart, c.indexOf('\n}', fnStart) + 2);
      const guardPos = fnBody.indexOf('assertTrustedUserId');
      const dbPos = fnBody.indexOf('createServiceClient');
      if (guardPos === -1) throw new Error(`assertTrustedUserId not called in ${fn}`);
      if (dbPos === -1) throw new Error(`createServiceClient not called in ${fn}`);
      if (guardPos > dbPos) throw new Error(`assertTrustedUserId must precede createServiceClient in ${fn}`);
    }
  });

  test('ownership.ts queries filter by both user_id AND resource identifier', () => {
    const c = readFileSync(resolve(ROOT, 'lib/security/ownership.ts'), 'utf-8');
    const checks: Array<{ fn: string; cols: string[] }> = [
      { fn: 'assertWorkflowOwnership', cols: [".eq('id', workflowId)", ".eq('user_id', userId)"] },
      { fn: 'assertCredentialOwnership', cols: [".eq('provider', provider)", ".eq('user_id', userId)"] },
      { fn: 'assertExecutionOwnership', cols: [".eq('id', executionId)", ".eq('user_id', userId)"] },
    ];
    for (const { fn, cols } of checks) {
      const fnStart = c.indexOf(`async function ${fn}`);
      const fnEnd = c.indexOf('\n}', fnStart) + 2;
      const fnBody = c.slice(fnStart, fnEnd);
      for (const col of cols) {
        if (!fnBody.includes(col)) throw new Error(`${fn} missing query filter: ${col}`);
      }
    }
  });

  test('ownership.ts uses maybeSingle() (not single()) to avoid 406 errors', () => {
    const c = readFileSync(resolve(ROOT, 'lib/security/ownership.ts'), 'utf-8');
    if (c.includes('.single()')) throw new Error('Use .maybeSingle() not .single()');
    const count = (c.match(/\.maybeSingle\(\)/g) ?? []).length;
    if (count < 3) throw new Error(`Expected ≥3 .maybeSingle() calls, found ${count}`);
  });

  test('ownership.ts throws generic errors — no resource IDs in thrown messages', () => {
    const c = readFileSync(resolve(ROOT, 'lib/security/ownership.ts'), 'utf-8');
    const throwLines = c.split('\n').filter((l) => l.includes('throw new Error(') && l.includes('SECURITY:'));
    for (const line of throwLines) {
      if (line.includes('${workflowId}') || line.includes('${executionId}') || line.includes('${provider}')) {
        throw new Error(`Error message leaks resource ID: ${line.trim()}`);
      }
    }
  });

  test('ownership.ts console.warn logs use only the first 8 chars of each ID', () => {
    const c = readFileSync(resolve(ROOT, 'lib/security/ownership.ts'), 'utf-8');
    const lines = c.split('\n');
    // For each console.warn call, collect the call + surrounding 3 lines (the template literal follows)
    const warnBlocks: string[] = [];
    lines.forEach((line, i) => {
      if (line.includes('console.warn')) {
        warnBlocks.push(lines.slice(i, i + 4).join('\n'));
      }
    });
    if (warnBlocks.length < 3) throw new Error(`Expected ≥3 console.warn calls, found ${warnBlocks.length}`);
    for (const block of warnBlocks) {
      if (!block.includes('.slice(0, 8)')) {
        throw new Error(`console.warn block does not truncate IDs to 8 chars:\n${block}`);
      }
    }
  });

  // ── 12. Invariant: ownership module never imported client-side ─────────────

  section('12. Client-side safety — ownership module not imported from browser code');

  test('AutomationBrain.tsx does not import from lib/security/ownership', () => {
    const c = routeSource('components/builder/AutomationBrain.tsx');
    if (c.includes('lib/security/ownership')) {
      throw new Error('lib/security/ownership must never be imported from client components');
    }
  });

  test('ConnectionModal is not imported in lib/security/ownership.ts', () => {
    const c = readFileSync(resolve(ROOT, 'lib/security/ownership.ts'), 'utf-8');
    if (c.includes('ConnectionModal') || c.includes('components/')) {
      throw new Error('ownership.ts must never import from components/');
    }
  });

  // ── 13. control/route.ts — assertExecutionOwnership wiring ───────────────────

  section('13. executions/[id]/control/route.ts — execution ownership enforcement');

  test('control route imports assertExecutionOwnership', () => {
    const c = routeSource('app/api/workflows/executions/[id]/control/route.ts');
    if (!c.includes('assertExecutionOwnership')) {
      throw new Error('assertExecutionOwnership not imported in control route');
    }
  });

  test('control route calls assertExecutionOwnership before ExecutionManager instantiation', () => {
    const c = routeSource('app/api/workflows/executions/[id]/control/route.ts');
    const ownerPos = c.lastIndexOf('assertExecutionOwnership(');
    const managerPos = c.lastIndexOf('new ExecutionManager(');
    if (ownerPos === -1) throw new Error('assertExecutionOwnership call not found in control route');
    if (managerPos === -1) throw new Error('new ExecutionManager() not found in control route');
    if (ownerPos > managerPos) {
      throw new Error('assertExecutionOwnership must precede new ExecutionManager() in control route');
    }
  });

  test('control route 404s on execution ownership failure', () => {
    const c = routeSource('app/api/workflows/executions/[id]/control/route.ts');
    const ownerPos = c.lastIndexOf('assertExecutionOwnership(');
    const managerPos = c.lastIndexOf('new ExecutionManager(');
    if (ownerPos === -1 || managerPos === -1) throw new Error('Could not locate call sites');
    const block = c.slice(ownerPos, managerPos);
    if (!block.includes('404')) {
      throw new Error('control route must return 404 on ownership failure, not 403');
    }
  });

  test('control route ownership check covers pause action (not just resume/rewind)', () => {
    const c = routeSource('app/api/workflows/executions/[id]/control/route.ts');
    // assertExecutionOwnership must appear BEFORE the pause/cancel branches
    const ownerPos = c.lastIndexOf('assertExecutionOwnership(');
    const pausePos = c.indexOf("action === 'pause'");
    if (ownerPos === -1) throw new Error('assertExecutionOwnership not found');
    if (pausePos === -1) throw new Error("action === 'pause' branch not found");
    if (ownerPos > pausePos) {
      throw new Error('assertExecutionOwnership must precede the pause branch — pause was previously unprotected');
    }
  });

  test('control route ownership check covers cancel action (not just resume/rewind)', () => {
    const c = routeSource('app/api/workflows/executions/[id]/control/route.ts');
    const ownerPos = c.lastIndexOf('assertExecutionOwnership(');
    const cancelPos = c.indexOf("action === 'cancel'");
    if (ownerPos === -1) throw new Error('assertExecutionOwnership not found');
    if (cancelPos === -1) throw new Error("action === 'cancel' branch not found");
    if (ownerPos > cancelPos) {
      throw new Error('assertExecutionOwnership must precede the cancel branch');
    }
  });

  // ── 14. steps/route.ts — assertExecutionOwnership wiring ─────────────────────

  section('14. executions/[id]/steps/route.ts — execution ownership enforcement');

  test('steps route imports assertExecutionOwnership', () => {
    const c = routeSource('app/api/workflows/executions/[id]/steps/route.ts');
    if (!c.includes('assertExecutionOwnership')) {
      throw new Error('assertExecutionOwnership not imported in steps route');
    }
  });

  test('steps route calls assertExecutionOwnership before workflow_execution_steps fetch', () => {
    const c = routeSource('app/api/workflows/executions/[id]/steps/route.ts');
    const ownerPos = c.lastIndexOf('assertExecutionOwnership(');
    const stepsPos = c.indexOf("from('workflow_execution_steps')");
    if (ownerPos === -1) throw new Error('assertExecutionOwnership call not found');
    if (stepsPos === -1) throw new Error("from('workflow_execution_steps') not found");
    if (ownerPos > stepsPos) {
      throw new Error('assertExecutionOwnership must precede the steps fetch');
    }
  });

  test('steps route 404s on execution ownership failure', () => {
    const c = routeSource('app/api/workflows/executions/[id]/steps/route.ts');
    const ownerPos = c.lastIndexOf('assertExecutionOwnership(');
    const stepsPos = c.indexOf("from('workflow_execution_steps')");
    if (ownerPos === -1 || stepsPos === -1) throw new Error('Could not locate call sites');
    const block = c.slice(ownerPos, stepsPos);
    if (!block.includes('404')) {
      throw new Error('steps route must return 404 on ownership failure');
    }
  });

  test('steps route no longer contains manual ownership select query on workflow_executions_v2', () => {
    const c = routeSource('app/api/workflows/executions/[id]/steps/route.ts');
    // The old manual check queried executions_v2 for ownership — now replaced by assertExecutionOwnership
    // The query "select('id, user_id')" on workflow_executions_v2 should no longer appear
    const hasManualCheck =
      c.includes("from('workflow_executions_v2')") &&
      c.includes("select('id, user_id')");
    if (hasManualCheck) {
      throw new Error(
        'steps route still has manual ownership SELECT query — should use assertExecutionOwnership instead'
      );
    }
  });

  // ── 15. workflow_deployments — ownership fix in orchestrate ──────────────────

  section('15. workflow_deployments ownership — orchestrate UPDATE and migration');

  test('orchestrate workflow_deployments UPDATE includes user_id filter', () => {
    const c = routeSource('app/api/n8n/orchestrate/route.ts');
    const deployUpdateIdx = c.indexOf("from('workflow_deployments')\n      .update");
    if (deployUpdateIdx === -1) throw new Error("workflow_deployments UPDATE not found");
    const blockEnd = c.indexOf('.then(() => {}, () => {})', deployUpdateIdx) + 30;
    const block = c.slice(deployUpdateIdx, blockEnd);
    if (!block.includes(".eq('user_id', authUser.id)")) {
      throw new Error("workflow_deployments UPDATE missing .eq('user_id', authUser.id)");
    }
  });

  test('orchestrate workflow_deployments INSERT already includes user_id', () => {
    const c = routeSource('app/api/n8n/orchestrate/route.ts');
    const insertIdx = c.indexOf("from('workflow_deployments').insert");
    if (insertIdx === -1) throw new Error("workflow_deployments INSERT not found");
    const blockEnd = c.indexOf('.then(() => {}, () => {})', insertIdx) + 30;
    const block = c.slice(insertIdx, blockEnd);
    if (!block.includes('user_id: authUser.id')) {
      throw new Error("workflow_deployments INSERT missing user_id: authUser.id");
    }
  });

  test('workflow_deployments RLS migration file exists', () => {
    readFileSync(
      resolve(ROOT, 'supabase/migrations/20260522000003_workflow_deployments_rls.sql'),
      'utf-8'
    );
  });

  test('workflow_deployments migration creates table with user_id column', () => {
    const c = readFileSync(
      resolve(ROOT, 'supabase/migrations/20260522000003_workflow_deployments_rls.sql'),
      'utf-8'
    );
    if (!c.includes('CREATE TABLE IF NOT EXISTS workflow_deployments')) {
      throw new Error('Migration must create workflow_deployments table');
    }
    if (!c.includes('user_id') || !c.includes('uuid') || !c.includes('NOT NULL')) {
      throw new Error('Migration must define user_id uuid NOT NULL');
    }
  });

  test('workflow_deployments migration enables RLS', () => {
    const c = readFileSync(
      resolve(ROOT, 'supabase/migrations/20260522000003_workflow_deployments_rls.sql'),
      'utf-8'
    );
    if (!c.includes('ENABLE ROW LEVEL SECURITY')) {
      throw new Error('Migration must ENABLE ROW LEVEL SECURITY on workflow_deployments');
    }
  });

  test('workflow_deployments migration creates user-scoped policy', () => {
    const c = readFileSync(
      resolve(ROOT, 'supabase/migrations/20260522000003_workflow_deployments_rls.sql'),
      'utf-8'
    );
    if (!c.includes('auth.uid() = user_id')) {
      throw new Error('Migration must create a policy using auth.uid() = user_id');
    }
  });

  test('workflow_deployments migration policy uses both USING and WITH CHECK', () => {
    const c = readFileSync(
      resolve(ROOT, 'supabase/migrations/20260522000003_workflow_deployments_rls.sql'),
      'utf-8'
    );
    if (!c.includes('USING') || !c.includes('WITH CHECK')) {
      throw new Error('FOR ALL policy must include both USING (read) and WITH CHECK (write) clauses');
    }
  });

  // ── 16. ExecutionManager — requestPause/requestCancel ownership ──────────────

  section('16. ExecutionManager — requestPause / requestCancel DB ownership filters');

  test('requestPause UPDATE scopes by both id and user_id', () => {
    const c = readFileSync(resolve(ROOT, 'runtime/execution-manager.ts'), 'utf-8');
    const fnStart = c.indexOf('async requestPause(');
    if (fnStart === -1) throw new Error('requestPause not found');
    const fnEnd = c.indexOf('\n  }', fnStart) + 4;
    const body = c.slice(fnStart, fnEnd);
    if (!body.includes('.eq(\'id\', executionId)')) {
      throw new Error('requestPause UPDATE must filter by .eq(\'id\', executionId)');
    }
    if (!body.includes('.eq(\'user_id\', userId)')) {
      throw new Error('requestPause UPDATE must filter by .eq(\'user_id\', userId)');
    }
  });

  test('requestPause does not UPDATE workflow_executions_v2 by id alone', () => {
    const c = readFileSync(resolve(ROOT, 'runtime/execution-manager.ts'), 'utf-8');
    const fnStart = c.indexOf('async requestPause(');
    const fnEnd = c.indexOf('\n  }', fnStart) + 4;
    const body = c.slice(fnStart, fnEnd);
    // Every .update(...) chain must have a .eq('user_id', ...) filter
    const updateIdx = body.indexOf('.update({');
    if (updateIdx === -1) throw new Error('No .update() found in requestPause');
    const afterUpdate = body.slice(updateIdx);
    if (!afterUpdate.includes('.eq(\'user_id\', userId)')) {
      throw new Error('requestPause UPDATE chain missing user_id ownership filter');
    }
  });

  test('requestCancel UPDATE scopes by both id and user_id', () => {
    const c = readFileSync(resolve(ROOT, 'runtime/execution-manager.ts'), 'utf-8');
    const fnStart = c.indexOf('async requestCancel(');
    if (fnStart === -1) throw new Error('requestCancel not found');
    const fnEnd = c.indexOf('\n  }', fnStart) + 4;
    const body = c.slice(fnStart, fnEnd);
    if (!body.includes('.eq(\'id\', executionId)')) {
      throw new Error('requestCancel UPDATE must filter by .eq(\'id\', executionId)');
    }
    if (!body.includes('.eq(\'user_id\', userId)')) {
      throw new Error('requestCancel UPDATE must filter by .eq(\'user_id\', userId)');
    }
  });

  test('requestCancel does not UPDATE workflow_executions_v2 by id alone', () => {
    const c = readFileSync(resolve(ROOT, 'runtime/execution-manager.ts'), 'utf-8');
    const fnStart = c.indexOf('async requestCancel(');
    const fnEnd = c.indexOf('\n  }', fnStart) + 4;
    const body = c.slice(fnStart, fnEnd);
    const updateIdx = body.indexOf('.update({');
    if (updateIdx === -1) throw new Error('No .update() found in requestCancel');
    const afterUpdate = body.slice(updateIdx);
    if (!afterUpdate.includes('.eq(\'user_id\', userId)')) {
      throw new Error('requestCancel UPDATE chain missing user_id ownership filter');
    }
  });

  test('getExecution SELECT scopes by both id and user_id', () => {
    const c = readFileSync(resolve(ROOT, 'runtime/execution-manager.ts'), 'utf-8');
    const fnStart = c.indexOf('async getExecution(');
    if (fnStart === -1) throw new Error('getExecution not found');
    const nextFn = c.indexOf('\n  async ', fnStart + 1);
    const body = nextFn !== -1 ? c.slice(fnStart, nextFn) : c.slice(fnStart);
    if (!body.includes(".eq('id', executionId)")) {
      throw new Error("getExecution SELECT must filter by .eq('id', executionId)");
    }
    if (!body.includes(".eq('user_id', userId)")) {
      throw new Error("getExecution SELECT must filter by .eq('user_id', userId)");
    }
  });

  // ── 17. RuntimeStateStore — all execution-state UPDATEs scoped by user_id ────

  section('17. RuntimeStateStore — execution-state UPDATEs scoped by user_id');

  test('setExecutionState UPDATE scopes by user_id', () => {
    const c = readFileSync(resolve(ROOT, 'runtime/runtime-state.ts'), 'utf-8');
    const fnStart = c.indexOf('async setExecutionState(');
    if (fnStart === -1) throw new Error('setExecutionState not found');
    const nextFn = c.indexOf('\n  async ', fnStart + 1);
    const body = nextFn !== -1 ? c.slice(fnStart, nextFn) : c.slice(fnStart);
    if (!body.includes(".eq('user_id', params.userId)")) {
      throw new Error('setExecutionState UPDATE missing user_id ownership filter');
    }
  });

  test('setExecutionState fallback UPDATE also scopes by user_id', () => {
    const c = readFileSync(resolve(ROOT, 'runtime/runtime-state.ts'), 'utf-8');
    const fnStart = c.indexOf('async setExecutionState(');
    const nextFn = c.indexOf('\n  async ', fnStart + 1);
    const body = nextFn !== -1 ? c.slice(fnStart, nextFn) : c.slice(fnStart);
    const matches = body.match(/\.eq\('user_id', params\.userId\)/g) ?? [];
    if (matches.length < 2) {
      throw new Error(
        `setExecutionState must scope both the main and fallback UPDATE by user_id (found ${matches.length})`
      );
    }
  });

  test('initializeExecution UPDATE scopes by user_id when executionId is provided', () => {
    const c = readFileSync(resolve(ROOT, 'runtime/runtime-state.ts'), 'utf-8');
    const fnStart = c.indexOf('async initializeExecution(');
    if (fnStart === -1) throw new Error('initializeExecution not found');
    const nextFn = c.indexOf('\n  async ', fnStart + 1);
    const body = nextFn !== -1 ? c.slice(fnStart, nextFn) : c.slice(fnStart);
    if (!body.includes(".eq('user_id', params.userId)")) {
      throw new Error('initializeExecution UPDATE missing user_id filter');
    }
  });

  test('getLatestCheckpoint SELECT scopes by both execution_id and user_id', () => {
    const c = readFileSync(resolve(ROOT, 'runtime/runtime-state.ts'), 'utf-8');
    const fnStart = c.indexOf('async getLatestCheckpoint(');
    if (fnStart === -1) throw new Error('getLatestCheckpoint not found');
    const nextFn = c.indexOf('\n  async ', fnStart + 1);
    const body = nextFn !== -1 ? c.slice(fnStart, nextFn) : c.slice(fnStart);
    if (!body.includes(".eq('execution_id', executionId)")) {
      throw new Error('getLatestCheckpoint missing execution_id filter');
    }
    if (!body.includes(".eq('user_id', userId)")) {
      throw new Error('getLatestCheckpoint missing user_id filter');
    }
  });

  test('getSnapshotByVersion SELECT scopes by execution_id, user_id, AND version', () => {
    const c = readFileSync(resolve(ROOT, 'runtime/runtime-state.ts'), 'utf-8');
    const fnStart = c.indexOf('async getSnapshotByVersion(');
    if (fnStart === -1) throw new Error('getSnapshotByVersion not found');
    const nextFn = c.indexOf('\n  async ', fnStart + 1);
    const body = nextFn !== -1 ? c.slice(fnStart, nextFn) : c.slice(fnStart);
    if (!body.includes(".eq('execution_id', executionId)")) throw new Error('missing execution_id filter');
    if (!body.includes(".eq('user_id', userId)")) throw new Error('missing user_id filter');
    if (!body.includes(".eq('snapshot_version', snapshotVersion)")) throw new Error('missing snapshot_version filter');
  });

  // ── 18. steps/route.ts — auth unification ────────────────────────────────────

  section('18. steps/route.ts — unified auth via getUserFromRequest');

  test('steps route imports getUserFromRequest from supabase-server', () => {
    const c = routeSource('app/api/workflows/executions/[id]/steps/route.ts');
    if (!c.includes('getUserFromRequest')) {
      throw new Error('steps route must use getUserFromRequest');
    }
    if (!c.includes("from '@/lib/supabase-server'")) {
      throw new Error('getUserFromRequest must be imported from @/lib/supabase-server');
    }
  });

  test('steps route does not import createClient from @supabase/supabase-js', () => {
    const c = routeSource('app/api/workflows/executions/[id]/steps/route.ts');
    if (c.includes("from '@supabase/supabase-js'")) {
      throw new Error(
        "steps route must not import from '@supabase/supabase-js' — use getUserFromRequest instead"
      );
    }
  });

  test('steps route does not manually parse the Authorization header for auth', () => {
    const c = routeSource('app/api/workflows/executions/[id]/steps/route.ts');
    // The old pattern was: req.headers.get('authorization') + client.auth.getUser(token)
    // getUserFromRequest handles this internally; the route should not duplicate it
    if (c.includes('client.auth.getUser') || c.includes('authHeader.slice(7)')) {
      throw new Error('steps route must not manually call client.auth.getUser — use getUserFromRequest');
    }
  });

  test('steps route passes user.id (not userData.user.id) to assertExecutionOwnership', () => {
    const c = routeSource('app/api/workflows/executions/[id]/steps/route.ts');
    if (c.includes('userData.user.id')) {
      throw new Error('steps route still references userData.user.id — should be user.id after auth unification');
    }
    if (!c.includes('user.id')) {
      throw new Error('steps route must pass user.id to assertExecutionOwnership');
    }
  });

  // ── 19. Tenant-aware UPSERT conflict targets ──────────────────────────────

  section('19. Tenant-aware UPSERT conflict targets — runtime-state.ts');

  const runtimeStateSrc = readFileSync(resolve(ROOT, 'runtime/runtime-state.ts'), 'utf-8');

  test('persistNodeState upsert specifies user_id-scoped conflict target', () => {
    const fnStart = runtimeStateSrc.indexOf('async persistNodeState(');
    if (fnStart === -1) throw new Error('persistNodeState not found');
    const nextFn = runtimeStateSrc.indexOf('\n  async ', fnStart + 1);
    const body = nextFn !== -1 ? runtimeStateSrc.slice(fnStart, nextFn) : runtimeStateSrc.slice(fnStart);
    if (!body.includes("onConflict: 'execution_id,node_id,user_id'")) {
      throw new Error("runtime_node_states upsert must specify onConflict: 'execution_id,node_id,user_id'");
    }
  });

  test('writeSnapshot upsert specifies user_id-scoped conflict target', () => {
    const fnStart = runtimeStateSrc.indexOf('async writeSnapshot(');
    if (fnStart === -1) throw new Error('writeSnapshot not found');
    const nextFn = runtimeStateSrc.indexOf('\n  async ', fnStart + 1);
    const body = nextFn !== -1 ? runtimeStateSrc.slice(fnStart, nextFn) : runtimeStateSrc.slice(fnStart);
    if (!body.includes("onConflict: 'execution_id,snapshot_version,user_id'")) {
      throw new Error("runtime_execution_snapshots upsert must specify onConflict: 'execution_id,snapshot_version,user_id'");
    }
  });

  test('setExecutionControl upsert specifies user_id-scoped conflict target', () => {
    const fnStart = runtimeStateSrc.indexOf('async setExecutionControl(');
    if (fnStart === -1) throw new Error('setExecutionControl not found');
    const nextFn = runtimeStateSrc.indexOf('\n  async ', fnStart + 1);
    const body = nextFn !== -1 ? runtimeStateSrc.slice(fnStart, nextFn) : runtimeStateSrc.slice(fnStart);
    if (!body.includes("onConflict: 'execution_id,user_id'")) {
      throw new Error("runtime_execution_controls upsert must specify onConflict: 'execution_id,user_id'");
    }
  });

  test('runtime_execution_controls upsert does not conflict on execution_id alone', () => {
    const fnStart = runtimeStateSrc.indexOf('async setExecutionControl(');
    const nextFn = runtimeStateSrc.indexOf('\n  async ', fnStart + 1);
    const body = nextFn !== -1 ? runtimeStateSrc.slice(fnStart, nextFn) : runtimeStateSrc.slice(fnStart);
    // The tenant-unsafe old pattern: onConflict string containing execution_id but not user_id
    if (body.includes("onConflict: 'execution_id'")) {
      throw new Error("runtime_execution_controls must not conflict on execution_id alone — cross-tenant overwrite risk");
    }
    // Must have the tenant-safe form
    if (!body.includes("onConflict: 'execution_id,user_id'")) {
      throw new Error("runtime_execution_controls upsert must use tenant-safe conflict target 'execution_id,user_id'");
    }
  });

  test('workflow_execution_steps uses INSERT (not upsert) in persistNodeState', () => {
    const fnStart = runtimeStateSrc.indexOf('async persistNodeState(');
    const nextFn = runtimeStateSrc.indexOf('\n  async ', fnStart + 1);
    const body = nextFn !== -1 ? runtimeStateSrc.slice(fnStart, nextFn) : runtimeStateSrc.slice(fnStart);
    if (!body.includes("from('workflow_execution_steps').insert(")) {
      throw new Error('workflow_execution_steps must use INSERT (append-only audit log), not upsert');
    }
    if (body.includes("from('workflow_execution_steps').upsert(")) {
      throw new Error('workflow_execution_steps must not use upsert — it is an append-only audit log');
    }
  });

  test('persistNodeState upsert payload includes user_id field', () => {
    const fnStart = runtimeStateSrc.indexOf('async persistNodeState(');
    const nextFn = runtimeStateSrc.indexOf('\n  async ', fnStart + 1);
    const body = nextFn !== -1 ? runtimeStateSrc.slice(fnStart, nextFn) : runtimeStateSrc.slice(fnStart);
    if (!body.includes('user_id: input.userId')) {
      throw new Error('persistNodeState upsert payload must include user_id: input.userId');
    }
  });

  test('writeSnapshot upsert payload includes user_id field', () => {
    const fnStart = runtimeStateSrc.indexOf('async writeSnapshot(');
    const nextFn = runtimeStateSrc.indexOf('\n  async ', fnStart + 1);
    const body = nextFn !== -1 ? runtimeStateSrc.slice(fnStart, nextFn) : runtimeStateSrc.slice(fnStart);
    if (!body.includes('user_id: input.userId')) {
      throw new Error('writeSnapshot upsert payload must include user_id: input.userId');
    }
  });

  test('setExecutionControl upsert payload includes user_id field', () => {
    const fnStart = runtimeStateSrc.indexOf('async setExecutionControl(');
    const nextFn = runtimeStateSrc.indexOf('\n  async ', fnStart + 1);
    const body = nextFn !== -1 ? runtimeStateSrc.slice(fnStart, nextFn) : runtimeStateSrc.slice(fnStart);
    if (!body.includes('user_id: params.userId')) {
      throw new Error('setExecutionControl upsert payload must include user_id: params.userId');
    }
  });

  const multitenantMigSrc = readFileSync(
    resolve(ROOT, 'supabase/migrations/20260523000001_runtime_multitenant_hardening.sql'),
    'utf-8'
  );

  test('multitenant hardening migration file exists', () => {
    if (!multitenantMigSrc) throw new Error('Migration file is empty');
  });

  test('migration uses CREATE UNIQUE INDEX IF NOT EXISTS (idempotent) for all three tables', () => {
    const count = (multitenantMigSrc.match(/CREATE UNIQUE INDEX IF NOT EXISTS/g) ?? []).length;
    if (count < 3) {
      throw new Error(`Migration must have ≥3 CREATE UNIQUE INDEX IF NOT EXISTS statements, found ${count}`);
    }
  });

  test('migration creates runtime_node_states index with execution_id, node_id, user_id', () => {
    const idx = multitenantMigSrc.indexOf('ON runtime_node_states(');
    if (idx === -1) throw new Error('No index definition found for runtime_node_states');
    const def = multitenantMigSrc.slice(idx, multitenantMigSrc.indexOf(';', idx));
    if (!def.includes('execution_id') || !def.includes('node_id') || !def.includes('user_id')) {
      throw new Error('runtime_node_states index must include execution_id, node_id, and user_id');
    }
  });

  test('migration creates runtime_execution_controls index with execution_id and user_id', () => {
    const idx = multitenantMigSrc.indexOf('ON runtime_execution_controls(');
    if (idx === -1) throw new Error('No index definition found for runtime_execution_controls');
    const def = multitenantMigSrc.slice(idx, multitenantMigSrc.indexOf(';', idx));
    if (!def.includes('execution_id') || !def.includes('user_id')) {
      throw new Error('runtime_execution_controls index must include execution_id and user_id');
    }
  });

  test('migration creates runtime_execution_snapshots index with execution_id, snapshot_version, user_id', () => {
    const idx = multitenantMigSrc.indexOf('ON runtime_execution_snapshots(');
    if (idx === -1) throw new Error('No index definition found for runtime_execution_snapshots');
    const def = multitenantMigSrc.slice(idx, multitenantMigSrc.indexOf(';', idx));
    if (!def.includes('execution_id') || !def.includes('snapshot_version') || !def.includes('user_id')) {
      throw new Error('runtime_execution_snapshots index must include execution_id, snapshot_version, and user_id');
    }
  });

  test('migration contains no DROP INDEX or DROP TABLE statements (non-destructive)', () => {
    if (multitenantMigSrc.includes('DROP INDEX') || multitenantMigSrc.includes('DROP TABLE')) {
      throw new Error('Multitenant hardening migration must not drop any indexes or tables');
    }
  });

  // ── Report ─────────────────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(60)}`);
  console.log('Ownership & Security Regression Suite');
  console.log('─'.repeat(60));
  console.log(`Total:  ${passed + failed}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  • ${f}`));
    process.exit(1);
  } else {
    console.log('\nAll tests passed.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
