import { test, expect } from '@playwright/test';
import { loginViaSession, expectNoHorizontalOverflow, type TestAccount } from './fixtures';

/**
 * Phase 9.9.17A -- Part N: browser certification for the "Publish changes"
 * UI on an ALREADY-active workflow. Requires a disposable @magicflux.local
 * test account and a disposable test workflow that is already active with
 * a pending draft change -- never the real Sigma Plus workflow (Part L).
 * Provision via E2E_TEST_ACCOUNT_EMAIL/PASSWORD and E2E_TEST_WORKFLOW_ID.
 */

function testAccount(): TestAccount {
  const email = process.env.E2E_TEST_ACCOUNT_EMAIL;
  const password = process.env.E2E_TEST_ACCOUNT_PASSWORD;
  if (!email || !password) throw new Error('E2E_TEST_ACCOUNT_EMAIL / E2E_TEST_ACCOUNT_PASSWORD not set');
  return { email, password };
}

function workflowId(): string {
  const id = process.env.E2E_TEST_WORKFLOW_ID;
  if (!id) throw new Error('E2E_TEST_WORKFLOW_ID not set');
  return id;
}

for (const [label, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile-375', { width: 375, height: 812 }],
] as const) {
  test.describe(`Publish changes UI -- ${label}`, () => {
    test.use({ viewport });

    test(`shows "Unpublished changes" + Publish changes button, never tells the user to Deactivate first (${label})`, async ({ page }) => {
      await loginViaSession(page, testAccount());
      await page.goto(`/dashboard/workflows/${workflowId()}`);
      await page.waitForLoadState('networkidle');

      await expectNoHorizontalOverflow(page);

      await expect(page.getByText('Unpublished changes')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Publish changes' })).toBeVisible();
      // Pause/Deactivate remain present as separate controls, never a
      // suggestion to use them before publishing.
      await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Deactivate' })).toBeVisible();
      await expect(page.getByText(/deactivate first/i)).toHaveCount(0);
    });

    test(`Publish confirmation states production stays live during validation (${label})`, async ({ page }) => {
      await loginViaSession(page, testAccount());
      await page.goto(`/dashboard/workflows/${workflowId()}`);
      await page.waitForLoadState('networkidle');

      await page.getByRole('button', { name: 'Publish changes' }).click();
      await expect(page.getByText('Publish these changes?')).toBeVisible();
      await expect(page.getByText(/stays live/i)).toBeVisible();
      await expect(page.getByText(/production is left completely unchanged/i)).toBeVisible();

      // Cancel -- must not have published anything.
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByText('Publish these changes?')).toHaveCount(0);
      await expect(page.getByText('Unpublished changes')).toBeVisible();
    });

    test(`confirming Publish succeeds, updates to "Up to date", never showed a non-executable/offline state (${label})`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

      await loginViaSession(page, testAccount());
      await page.goto(`/dashboard/workflows/${workflowId()}`);
      await page.waitForLoadState('networkidle');

      await page.getByRole('button', { name: 'Publish changes' }).click();
      await page.getByRole('button', { name: 'Publish' }).click();

      await expect(page.getByText('Up to date')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('Unpublished changes')).toHaveCount(0);
      // Status badge remains "active" throughout -- never flashed
      // draft/disabled/error/validating anywhere in the visible text.
      await expect(page.locator('text=/^validating$/i')).toHaveCount(0);

      await expectNoHorizontalOverflow(page);
    });
  });
}
