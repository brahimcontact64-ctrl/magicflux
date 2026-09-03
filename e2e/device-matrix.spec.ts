import { test, expect } from '@playwright/test';
import { expectNoHorizontalOverflow, trackConsoleErrors } from './fixtures';

/**
 * Phase 9.5 Step N — browser/device matrix. Runs against every project in
 * playwright.config.ts (320 / 375 / 430 / tablet / desktop, chromium +
 * webkit as the Safari proxy). Public, unauthenticated pages only, so this
 * spec needs no test account and is safe to run against production anytime.
 */

const PUBLIC_PAGES = ['/', '/pricing', '/login', '/signup', '/marketplace'];

for (const path of PUBLIC_PAGES) {
  test(`${path} renders with no horizontal overflow, no console errors, no raw error text`, async ({ page }) => {
    const errors = trackConsoleErrors(page, [/ResizeObserver loop/i]);
    const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
    expect(res?.status(), `${path} returned a non-2xx/3xx status`).toBeLessThan(400);

    // Not networkidle: a local `next dev` server keeps an HMR websocket
    // open indefinitely, which networkidle would wait on forever. A short
    // settle is enough for client hydration on both dev and production.
    await page.waitForTimeout(1500);
    await expectNoHorizontalOverflow(page);

    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toMatch(/\bTypeError\b|\bStack:|\bat Object\.|Unhandled Runtime Error/);

    expect(errors.errors, `console errors on ${path}: ${errors.errors.join('\n')}`).toEqual([]);
  });
}

test('/nonexistent-page-xyz shows an honest, styled 404, not a raw framework error page', async ({ page }) => {
  const res = await page.goto('/nonexistent-page-xyz');
  expect(res?.status()).toBe(404);
  await expect(page.getByText(/page not found|not found|404/i).first()).toBeVisible();
});
