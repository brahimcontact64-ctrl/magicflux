/**
 * Phase 9.9.14 -- proves the three new recovery mechanisms this phase adds
 * are actually WIRED into the self-heal cycle, not merely defined and
 * tested in isolation. This audit's own investigation found
 * reconcileStaleSideEffects() had existed, fully tested, since Phase
 * 9.9.11A but was NEVER called from runSelfHeal() or any cron route --
 * dead code that silently never ran. A static source check (the same
 * style already established in this codebase for exactly this class of
 * "is X wired to Y" verification -- see scripts/redis-chaos-test.ts) is
 * the proportionate way to prove the wiring itself, given runSelfHeal()'s
 * full orchestration has a large, multi-module dependency surface
 * (anomaly-detector, metrics, worker-registry, queue, worker-lifecycle)
 * with no existing test harness to extend; each of the three functions'
 * OWN behavior is separately, fully behaviorally tested in
 * tests/recovery-hardening-9914.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../lib/runtime/self-healer.ts'), 'utf8');

describe('self-healer.ts wiring (Phase 9.9.14)', () => {
  it('imports markOrphanQueuedExecutionsFailed and calls it inside the maintenance actions', () => {
    expect(source).toMatch(/import\s*\{[^}]*markOrphanQueuedExecutionsFailed[^}]*\}\s*from\s*['"]@\/runtime\/hardening-layer['"]/);
    expect(source).toMatch(/safeRun\('mark_orphan_queued_executions_failed',\s*\(\)\s*=>\s*\n?\s*markOrphanQueuedExecutionsFailed/);
  });

  it('imports reconcileStaleSideEffects and calls it inside the maintenance actions', () => {
    expect(source).toMatch(/import\s*\{\s*reconcileStaleSideEffects\s*\}\s*from\s*['"]\.\/side-effect-ledger['"]/);
    expect(source).toMatch(/safeRun\('reconcile_stale_side_effects',/);
    expect(source).toContain('reconcileStaleSideEffects(');
  });

  it('imports reclaimOrphanedIdempotencyLocks and calls it inside the maintenance actions', () => {
    expect(source).toMatch(/import\s*\{\s*reclaimOrphanedIdempotencyLocks\s*\}\s*from\s*['"]\.\/idempotency['"]/);
    expect(source).toMatch(/safeRun\('reclaim_orphaned_idempotency_locks',\s*\(\)\s*=>\s*\n?\s*reclaimOrphanedIdempotencyLocks/);
  });

  it('all three new actions are inside the "Always-on maintenance actions" block, not an anomaly-gated (conditional) one', () => {
    const maintenanceBlockStart = source.indexOf('Always-on maintenance actions run unconditionally');
    const maintenanceBlockEnd = source.indexOf(']);', maintenanceBlockStart);
    expect(maintenanceBlockStart).toBeGreaterThan(-1);
    expect(maintenanceBlockEnd).toBeGreaterThan(maintenanceBlockStart);
    const block = source.slice(maintenanceBlockStart, maintenanceBlockEnd);
    expect(block).toContain('markOrphanQueuedExecutionsFailed');
    expect(block).toContain('reconcileStaleSideEffects');
    expect(block).toContain('reclaimOrphanedIdempotencyLocks');
  });
});
