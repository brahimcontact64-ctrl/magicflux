/**
 * Phase 23.2 — Auth Failure Handling Tests
 *
 * Verifies that all 8 GET routes handle getUserPermissions() failures gracefully:
 *   1. getUserPermissions is wrapped in error-handling (.catch)
 *   2. Returns 503 on authorization lookup failure
 *   3. Returns "Authorization service unavailable" error message
 *   4. No requirePermission() call in GET handler
 *   5. No hasPermission() call in GET handler
 *   6. getUserPermissions called exactly once per GET handler
 *
 * Run: npx tsx scripts/test-phase232-auth-failure.ts
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

// Extract the GET handler body (from `export async function GET` to the next top-level export or EOF).
function getHandlerBody(src: string): string {
  const start = src.indexOf('export async function GET');
  if (start === -1) return '';
  const nextExport = src.indexOf('\nexport ', start + 1);
  return nextExport === -1 ? src.slice(start) : src.slice(start, nextExport);
}

// ============================================================================
// Routes under test
// ============================================================================

const ROUTES = [
  { path: 'app/api/runtime/control/incidents/route.ts',        name: 'incidents/route.ts'        },
  { path: 'app/api/runtime/control/workers/route.ts',          name: 'workers/route.ts'          },
  { path: 'app/api/runtime/control/overview/route.ts',         name: 'overview/route.ts'         },
  { path: 'app/api/runtime/control/operator-actions/route.ts', name: 'operator-actions/route.ts' },
  { path: 'app/api/runtime/control/metrics/route.ts',          name: 'metrics/route.ts'          },
  { path: 'app/api/runtime/control/traces/route.ts',           name: 'traces/route.ts'           },
  { path: 'app/api/runtime/control/cost/route.ts',             name: 'cost/route.ts'             },
  { path: 'app/api/runtime/control/stream/route.ts',           name: 'stream/route.ts'           },
];

for (const { path, name } of ROUTES) {
  const section = `auth-failure ${name}`;

  test(section, `${name}: getUserPermissions wrapped with .catch`, () => {
    const src = readSrc(path);
    assert(
      src.includes('getUserPermissions(user.id).catch('),
      'getUserPermissions must be called with .catch() to handle DB/auth failures'
    );
  });

  test(section, `${name}: returns 503 on auth lookup failure`, () => {
    const src = readSrc(path);
    assert(
      src.includes('503'),
      'route must return HTTP 503 when getUserPermissions fails'
    );
  });

  test(section, `${name}: 503 response body is "Authorization service unavailable"`, () => {
    const src = readSrc(path);
    assert(
      src.includes('Authorization service unavailable'),
      'route must include "Authorization service unavailable" as the 503 error message'
    );
  });

  test(section, `${name}: 503 check precedes permission gate`, () => {
    const src = readSrc(path);
    const nullCheckIdx = src.indexOf('if (!perms)');
    const permGateIdx  = src.indexOf('!perms.includes(');
    assert(nullCheckIdx !== -1, 'must have null-guard: if (!perms)');
    assert(permGateIdx  !== -1, 'must have permission gate using perms.includes()');
    assert(
      nullCheckIdx < permGateIdx,
      `null-guard (pos ${nullCheckIdx}) must come before permission gate (pos ${permGateIdx})`
    );
  });

  test(section, `${name}: no requirePermission() in GET handler`, () => {
    const getBody = getHandlerBody(readSrc(path));
    const calls = (getBody.match(/\brequirePermission\s*\(/g) ?? []).length;
    assert(
      calls === 0,
      `requirePermission() must not be called in GET handler — found ${calls} call(s)`
    );
  });

  test(section, `${name}: no hasPermission() in GET handler`, () => {
    const getBody = getHandlerBody(readSrc(path));
    const calls = (getBody.match(/\bhasPermission\s*\(/g) ?? []).length;
    assert(
      calls === 0,
      `hasPermission() must not be called in GET handler — found ${calls} call(s)`
    );
  });

  test(section, `${name}: getUserPermissions called exactly once`, () => {
    const src = readSrc(path);
    const calls = (src.match(/getUserPermissions\s*\(/g) ?? []).length;
    assert(
      calls === 1,
      `getUserPermissions must be called exactly once — found ${calls} call(s)`
    );
  });
}

// ============================================================================
// Results
// ============================================================================

const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;

console.log('\n=== Phase 23.2 Auth Failure Handling Tests ===\n');

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
