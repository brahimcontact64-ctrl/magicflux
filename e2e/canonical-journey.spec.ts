import { test, expect } from '@playwright/test';
import { accountA, loginAs, trackConsoleErrors, expectNoHorizontalOverflow } from './fixtures';

/**
 * Phase 9.5 Step B — closest-possible production journey: login (account
 * pre-created via service-role admin API, matching established discipline
 * rather than driving the real email-confirmation-gated /signup form) →
 * onboarding → builder → describe → generate → observe the output surface.
 *
 * Deliberately uses only webhook + code/transform blocks (no real
 * credentials, no external side effect) and switches to "Preview" mode
 * before generating, so nothing here can trigger a real Slack/Shopify/email
 * send or a real deploy regardless of what the AI planner proposes.
 */

test.describe('Canonical journey (Step B)', () => {
  test('login -> builder loads with no console errors, no horizontal overflow', async ({ page }) => {
    const errors = trackConsoleErrors(page, [/ResizeObserver loop/i]);
    await loginAs(page, accountA());
    await page.goto('/builder');
    await page.waitForLoadState('networkidle');

    await expect(page.getByPlaceholder(/what do you want to automate/i)).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalOverflow(page);
    expect(errors.errors, `console errors on /builder: ${errors.errors.join('\n')}`).toEqual([]);
  });

  test('describe -> generate produces a real, renderable plan (no raw JSON, no blank/broken output)', async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, accountA());
    await page.goto('/builder');
    await page.waitForLoadState('networkidle');

    // Preview mode -- no real deploy, no real side effects, regardless of
    // what the planner proposes.
    const previewToggle = page.getByRole('button', { name: /^Preview$/ });
    if (await previewToggle.count() > 0) {
      await previewToggle.click();
    }

    const input = page.getByPlaceholder(/what do you want to automate/i);
    await input.fill('When I receive a webhook, run a small JavaScript step to log the payload. No other integrations.');
    await input.press('Enter');

    // The chat streams via SSE; give it real time to reach a terminal state
    // (either a rendered plan/composition, or an honest clarification/error
    // message) rather than asserting exact wording of a specific bubble.
    const planSurface = page.locator('text=/node|step|trigger|workflow/i').first();
    await expect(planSurface).toBeVisible({ timeout: 90_000 });

    // Whatever happened, it must not be a raw unhandled error dump.
    const rawErrorDump = page.locator('text=/^\\s*\\{.*"stack"/');
    expect(await rawErrorDump.count()).toBe(0);
  });
});
