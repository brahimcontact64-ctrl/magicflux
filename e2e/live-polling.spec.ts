import { test, expect } from '@playwright/test';
import { accountA, loginViaSession } from './fixtures';

/**
 * Phase 9.5 Step H — closes the Phase 9.4.3 caveat: the execution-detail
 * live-polling mechanism (components/execution/ExecutionDetailView.tsx,
 * built in 9.4.3) had never actually been browser-verified end to end.
 *
 * A genuinely non-terminal execution row is fixtured directly via the
 * service-role admin API (no real long-running job needed) before this
 * spec runs; the execution ID is passed in through E2E_EXECUTION_ID.
 * Mid-test, the fixture is flipped to a terminal state by an external
 * script while the page is open, proving the page updates itself instead
 * of requiring a manual reload.
 */

test('execution detail page shows a running status, then updates itself to terminal without a manual reload', async ({ page }) => {
  test.setTimeout(60_000);
  const executionId = process.env.E2E_EXECUTION_ID;
  if (!executionId) throw new Error('E2E_EXECUTION_ID not set');

  await loginViaSession(page, accountA());
  await page.goto(`/executions/${executionId}`);

  // Exact-match, not a substring search: the page also shows an unrelated
  // "Success rate" stat card, which a loose /success/i text search matched
  // immediately regardless of this execution's real status -- a false
  // pass caught by confirming this test's actual runtime (it finished in
  // ~3s, far too fast to have genuinely waited through both timeouts).
  const statusBadge = page.getByText(/^(running|success)$/i);

  // Starting state: genuinely non-terminal.
  await expect(statusBadge.first()).toHaveText(/running/i, { timeout: 15_000 });

  // The external harness flips the DB row to 'success' partway through this
  // wait window (see the orchestrating script) -- the page must pick it up
  // on its own via polling, with no page.reload() call anywhere below.
  await expect(statusBadge.first()).toHaveText(/success/i, { timeout: 20_000 });
});
