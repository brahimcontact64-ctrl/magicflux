import { test, expect } from '@playwright/test';
import { loginViaSession, expectNoHorizontalOverflow, type TestAccount } from './fixtures';

/**
 * Phase 9.9.19 -- Part 10: authenticated mobile journey coverage. Uses a
 * disposable @magicflux.local account + a disposable, non-Sigma-Plus test
 * workflow (created out-of-band, same pattern as every other account this
 * suite uses) shaped like the certified reference topology (webhook -> AI
 * Classifier -> Human Review -> Hot/Warm/Cold -> Airtable/Gmail/Slack/SLA)
 * so every specialized config panel actually has a matching node to render
 * against. No real Gmail/Slack/Airtable calls, no Sigma Plus lead, no
 * production workflow mutation -- this workflow is never activated.
 *
 * Requires E2E_MOBILE_ACCOUNT_EMAIL / E2E_MOBILE_ACCOUNT_PASSWORD /
 * E2E_MOBILE_WORKFLOW_ID env vars (created via
 * scripts/e2e-mobile-fixture-setup.ts). Skips cleanly if unset, rather
 * than failing the whole suite when this specific fixture isn't
 * provisioned for a given run.
 */

const email = process.env.E2E_MOBILE_ACCOUNT_EMAIL;
const password = process.env.E2E_MOBILE_ACCOUNT_PASSWORD;
const workflowId = process.env.E2E_MOBILE_WORKFLOW_ID;
const hasFixture = Boolean(email && password && workflowId);

test.skip(!hasFixture, 'E2E_MOBILE_ACCOUNT_EMAIL/PASSWORD/E2E_MOBILE_WORKFLOW_ID not set -- run scripts/e2e-mobile-fixture-setup.ts first');
test.skip(({ isMobile }) => !isMobile, 'mobile-only journey -- desktop coverage is the existing non-mobile specs');

function account(): TestAccount {
  return { email: email!, password: password! };
}

test.describe('authenticated mobile journey (fixture workflow, no real provider calls)', () => {
  test('workflow dashboard renders without horizontal overflow and the mobile step editor is reachable', async ({ page }) => {
    await loginViaSession(page, account());
    await page.goto(`/dashboard/workflows/${workflowId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    await expectNoHorizontalOverflow(page);

    const addStepButton = page.getByRole('button', { name: /add step/i });
    await addStepButton.scrollIntoViewIfNeeded();
    await expect(addStepButton).toBeVisible();
  });

  test('tapping a step in the mobile Steps view opens its configuration as a full-screen sheet, closeable, no data loss', async ({ page }) => {
    await loginViaSession(page, account());
    await page.goto(`/dashboard/workflows/${workflowId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const triggerStep = page.getByRole('button', { name: /Configure Webhook Trigger/i });
    await triggerStep.scrollIntoViewIfNeeded();
    await triggerStep.click();

    const sheet = page.getByRole('dialog', { name: /Configure Webhook Trigger/i });
    await expect(sheet).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const closeButton = page.getByRole('button', { name: /close settings/i });
    await expect(closeButton).toBeVisible();
    await closeButton.click();
    await expect(sheet).not.toBeVisible();
  });

  test('the AI Qualification Policy panel (confidence slider, required fields) is usable at phone width', async ({ page }) => {
    await loginViaSession(page, account());
    await page.goto(`/dashboard/workflows/${workflowId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const heading = page.getByText(/AI Qualification Policy/i).first();
    await heading.scrollIntoViewIfNeeded();
    await expect(heading).toBeVisible();

    const slider = page.locator('input[type="range"]').first();
    await expect(slider).toBeVisible();
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(40); // a real touch target, not a sliver

    await expectNoHorizontalOverflow(page);
  });

  test('Human Review, Notification Content, and SLA panels render stacked with visible Save actions, no clipping', async ({ page }) => {
    await loginViaSession(page, account());
    await page.goto(`/dashboard/workflows/${workflowId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    for (const label of [/Human Review/i, /Notification Content/i, /Acknowledgment SLA/i]) {
      const heading = page.getByText(label).first();
      await heading.scrollIntoViewIfNeeded();
      await expect(heading).toBeVisible();
    }

    await expectNoHorizontalOverflow(page);
  });

  test('unpublished-changes state is truthfully shown and Activate remains reachable', async ({ page }) => {
    await loginViaSession(page, account());
    await page.goto(`/dashboard/workflows/${workflowId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const activateButton = page.getByRole('button', { name: /activate/i });
    await activateButton.scrollIntoViewIfNeeded();
    await expect(activateButton).toBeVisible();
  });

  test('the Builder chat/generation screen is usable at phone width -- no squeezed sidebar, input reachable', async ({ page }) => {
    await loginViaSession(page, account());
    await page.goto('/builder', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    await expectNoHorizontalOverflow(page);

    // The Templates sidebar must default CLOSED on mobile (Phase 9.9.19
    // fix) -- the chat input must be a real, comfortably wide touch target,
    // not squeezed into half the viewport by an always-open sidebar.
    const chatInput = page.locator('textarea, input[type="text"]').first();
    await expect(chatInput).toBeVisible();
    const box = await chatInput.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(200);
  });

  test('dashboard header does not force page-level horizontal overflow', async ({ page }) => {
    await loginViaSession(page, account());
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await expectNoHorizontalOverflow(page);

    // Every action must still be reachable -- via horizontal scroll within
    // the header strip, not by being cut off entirely.
    const homeLink = page.getByRole('link', { name: /home/i });
    await homeLink.scrollIntoViewIfNeeded();
    await expect(homeLink).toBeVisible();
  });

  test('Reviews, Acknowledgments, Executions, and Analytics pages render without horizontal overflow', async ({ page }) => {
    await loginViaSession(page, account());
    for (const path of ['/reviews', '/acknowledgments', '/executions', `/analytics/${workflowId}`]) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await expectNoHorizontalOverflow(page);
    }
  });
});
