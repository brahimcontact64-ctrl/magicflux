/**
 * Phase 9.9.4I — Test Runtime UI must render a durable Human Review/wait
 * pause as WAITING, never FAILED.
 *
 * Root cause: the runtime engine (runtime/workflow-engine.ts) and the
 * live-test/test API routes already expose a canonical, non-failure
 * 'waiting' execution status -- and ExecutionStatusBadge
 * (components/app/execution-status-badge.tsx) already renders it as its
 * own distinct "WAITING" badge, exactly as it does for the executions list
 * elsewhere on this same page. But app/dashboard/workflows/[id]/page.tsx's
 * Test Runtime panel discarded that status before it ever reached the
 * badge: TestResult['status'] didn't include 'waiting' at all,
 * handleRunTest explicitly coerced a 'waiting' API response into 'failed',
 * and the badge callsite's own ternary collapsed anything that wasn't
 * 'simulated_success'/'success' into 'failed'. A workflow correctly
 * pausing at magicflux-nodes.humanReview with zero downstream side effects
 * therefore showed as FAILED -- incorrect product truth, since the
 * execution had neither completed nor errored.
 *
 * This project has no jsdom/testing-library configured (vitest.config.ts
 * runs environment: 'node'), and importing a .tsx component through
 * vitest's default transform fails on JSX -- so these are source-level
 * pins read as plain text, the same pattern already used by
 * tests/workflow-integrations-provider-alias.test.ts's force-dynamic pin.
 * They fail loudly (a broken match) if any of the three collapsing points
 * regress, or if the badge component itself stops treating 'waiting' as
 * its own distinct, non-failure state.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const pageSource = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'dashboard', 'workflows', '[id]', 'page.tsx'),
  'utf8'
);
const badgeSource = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'app', 'execution-status-badge.tsx'),
  'utf8'
);

describe('ExecutionStatusBadge -- canonical status labels (used by the Test Runtime panel)', () => {
  it('defines a distinct, non-failure WAITING label for the waiting status', () => {
    const waitingBlock = badgeSource.match(/waiting:\s*\{[^}]*\}/)?.[0] ?? '';
    expect(waitingBlock).toMatch(/label:\s*'WAITING'/);
  });

  it('keeps failed and waiting as visually and semantically distinct entries', () => {
    const failedBlock = badgeSource.match(/failed:\s*\{[^}]*\}/)?.[0] ?? '';
    expect(failedBlock).toMatch(/label:\s*'FAILED'/);
    expect(failedBlock).not.toContain("label: 'WAITING'");
  });
});

describe('Phase 9.9.4I -- Test Runtime panel must not collapse waiting into failed', () => {
  it('TestResult.status type includes the canonical waiting state', () => {
    expect(pageSource).toMatch(/status:\s*'success'\s*\|\s*'failed'\s*\|\s*'simulated_success'\s*\|\s*'waiting';/);
  });

  it('does not coerce a waiting API response into failed anywhere in the file', () => {
    expect(pageSource).not.toMatch(/'waiting'\s*\?\s*'failed'/);
  });

  it('passes the canonical status straight through to the badge instead of collapsing non-success to failed', () => {
    expect(pageSource).toMatch(/<ExecutionStatusBadge status=\{testResult\.status\}\s*\/>/);
    // The old collapsing ternary must be gone, not just supplemented.
    expect(pageSource).not.toMatch(/testResult\.status === 'success' \? 'success' : 'failed'/);
  });

  it('both the simulated-test and live-test handlers store the raw canonical status rather than defaulting it away', () => {
    const occurrences = pageSource.match(/status: payload\?\.status \?\? 'failed',/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
});
