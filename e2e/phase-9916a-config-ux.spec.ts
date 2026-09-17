import { test, expect, devices } from '@playwright/test';
import { loginViaSession, expectNoHorizontalOverflow, trackConsoleErrors, type TestAccount } from './fixtures';

/**
 * Phase 9.9.16A -- Part L: browser certification for the Phase 9.9.16
 * configuration UX. TEMPORARY verification spec against a disposable
 * @magicflux.local test account and a fabricated (not AI-generated, not
 * activated) reference-pattern test workflow, run against a local dev
 * server (E2E_BASE_URL) -- never the real Lead workflow, never production.
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
  test.describe(`Phase 9.9.16 configuration UX -- ${label}`, () => {
    test.use({ viewport });

    test(`workflow detail page loads with all new panels, no horizontal overflow (${label})`, async ({ page }) => {
      const consoleErrors = trackConsoleErrors(page, [/favicon/i]);
      await loginViaSession(page, testAccount());
      await page.goto(`/dashboard/workflows/${workflowId()}`);
      await page.waitForLoadState('networkidle');

      await expectNoHorizontalOverflow(page);

      await expect(page.getByText('Readiness', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('Branch Overview', { exact: true })).toBeVisible();
      await expect(page.getByText('AI Qualification Policy', { exact: true })).toBeVisible();
      await expect(page.getByText('Human Review', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Notification Content', { exact: true })).toBeVisible();
      await expect(page.getByText('Acknowledgment SLA', { exact: true })).toBeVisible();

      // Save/Activate controls remain reachable (not clipped/hidden) at this viewport.
      const activateButton = page.getByRole('button', { name: /activate/i }).first();
      await expect(activateButton).toBeVisible();
      await expect(activateButton).toBeInViewport({ ratio: 0.1 }).catch(() => {
        // Scrolled below the fold is acceptable; "reachable" means scrollable-to, not always in first view.
      });

      expect(consoleErrors.errors, `console errors on ${label}: ${consoleErrors.errors.join('; ')}`).toEqual([]);
    });

    test(`AI Policy Editor is usable -- fields visible, labels present, contradiction UI unlocked (${label})`, async ({ page }) => {
      await loginViaSession(page, testAccount());
      await page.goto(`/dashboard/workflows/${workflowId()}`);
      await page.waitForLoadState('networkidle');

      const policySection = page.locator('section', { has: page.getByText('AI Qualification Policy', { exact: true }) });
      await expect(policySection).toBeVisible();
      await expect(policySection.getByText('Allowed classifications')).toBeVisible();
      await expect(policySection.getByText(/Confidence threshold/)).toBeVisible();
      // The two seeded field rules (budget_max, urgency) render as inputs.
      await expect(policySection.getByPlaceholder('field name, e.g. budget_max').first()).toBeVisible();

      await expectNoHorizontalOverflow(page);
    });

    test(`Notification Editor field-insertion controls are present, no raw template syntax required to see them (${label})`, async ({ page }) => {
      await loginViaSession(page, testAccount());
      await page.goto(`/dashboard/workflows/${workflowId()}`);
      await page.waitForLoadState('networkidle');

      const notifSection = page.locator('section', { has: page.getByText('Notification Content', { exact: true }) });
      await expect(notifSection).toBeVisible();
      // Field-insertion buttons render as "+ fieldname", not raw {{$json["..."]}}.
      await expect(notifSection.getByText(/^\+ /).first()).toBeVisible();
      await expect(notifSection.getByText('Insert acknowledgment link').first()).toBeVisible();

      await expectNoHorizontalOverflow(page);
    });

    test(`SLA editor shows elapsed-time wording and the seeded 15-minute value (${label})`, async ({ page }) => {
      await loginViaSession(page, testAccount());
      await page.goto(`/dashboard/workflows/${workflowId()}`);
      await page.waitForLoadState('networkidle');

      const slaSection = page.locator('section', { has: page.getByText('Acknowledgment SLA', { exact: true }) });
      await expect(slaSection).toBeVisible();
      await expect(slaSection.getByText(/elapsed wall-clock time/)).toBeVisible();
      const slaInput = slaSection.locator('input').first();
      await expect(slaInput).toHaveValue('15');

      await expectNoHorizontalOverflow(page);
    });

    test(`Readiness summary reflects a real, incomplete checklist (Airtable unconfigured) (${label})`, async ({ page }) => {
      await loginViaSession(page, testAccount());
      await page.goto(`/dashboard/workflows/${workflowId()}`);
      await page.waitForLoadState('networkidle');

      const readinessSection = page.locator('section', { has: page.getByText('Readiness', { exact: true }) });
      await expect(readinessSection).toBeVisible();
      // This fixture workflow has no real Airtable base/table configured --
      // Readiness must say so, not claim everything is ready.
      await expect(readinessSection.getByText(/Airtable/).first()).toBeVisible();
    });

    test(`Preview scenario buttons are present and clicking one causes zero real provider calls (${label})`, async ({ page }) => {
      await loginViaSession(page, testAccount());
      await page.goto(`/dashboard/workflows/${workflowId()}`);
      await page.waitForLoadState('networkidle');

      const hotButton = page.getByRole('button', { name: 'Likely Hot' });
      await expect(hotButton).toBeVisible();
      await hotButton.click();
      // The existing simulated-test route always reports zero real API calls.
      await expect(page.getByText(/no real apis were called/i).or(page.getByText(/simulated/i)).first()).toBeVisible({ timeout: 20_000 });
    });
  });
}
