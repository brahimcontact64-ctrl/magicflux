import { test, expect } from '@playwright/test';
import { expectNoHorizontalOverflow } from './fixtures';

/**
 * Phase 9.9.19 -- Part B regression: the mobile menu used to render INLINE
 * inside the fixed-position header, so opening it grew the header's own
 * height without ever pushing the Hero content below it down -- the
 * expanded link list painted directly over the headline/CTA area. Fixed by
 * making the mobile menu a full-viewport sibling overlay instead of inline
 * growth. This spec pins the structural property that actually prevents
 * the regression (nav content renders BELOW the fixed top bar, never over
 * it), not just "the page looks fine in one screenshot".
 *
 * Runs only against the mobile/touch projects (device-matrix.spec.ts
 * already covers desktop + general no-overflow checks for these pages).
 */
test.skip(({ isMobile }) => !isMobile, 'mobile-menu-specific regression -- desktop has no burger menu to test');

const TOP_BAR_HEIGHT = 64; // h-16

test('opening the mobile menu never overlaps the Hero headline/CTA, and closing it restores the original layout', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const heroHeadline = page.getByRole('heading', { level: 1 });
  await expect(heroHeadline).toBeVisible();
  const headlineBoxBefore = await heroHeadline.boundingBox();
  expect(headlineBoxBefore).not.toBeNull();

  const menuButton = page.getByRole('button', { name: /open menu/i });
  await menuButton.click();

  // The overlay itself must exist and start exactly at the top bar's
  // bottom edge -- never at 0 (which would mean it's covering the logo/
  // close button too) and never floating below some arbitrary offset.
  // Scoped to <header> -- the Footer has its own identical-looking "How it
  // works" link further down the page.
  const firstNavLink = page.locator('header').getByRole('link', { name: 'How it works' });
  await expect(firstNavLink).toBeVisible();
  const linkBox = await firstNavLink.boundingBox();
  expect(linkBox).not.toBeNull();
  expect(linkBox!.y).toBeGreaterThanOrEqual(TOP_BAR_HEIGHT);

  // The close control must remain reachable while the menu is open --
  // never covered by the menu's own content.
  const closeButton = page.getByRole('button', { name: /close menu/i });
  await expect(closeButton).toBeVisible();
  const closeBox = await closeButton.boundingBox();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.y).toBeLessThan(TOP_BAR_HEIGHT);

  // Body scroll must be intentionally locked while a full-viewport sheet
  // is open -- otherwise the page behind it remains independently
  // scrollable, which is exactly the "unintentional scroll" Part B warns
  // against.
  const bodyOverflow = await page.evaluate(() => document.body.style.overflow);
  expect(bodyOverflow).toBe('hidden');

  await expectNoHorizontalOverflow(page);

  await closeButton.click();
  await expect(firstNavLink).not.toBeVisible();

  const bodyOverflowAfterClose = await page.evaluate(() => document.body.style.overflow);
  expect(bodyOverflowAfterClose).not.toBe('hidden');

  // The Hero headline must be back exactly where it was -- no residual
  // layout shift from the menu having been open.
  const headlineBoxAfter = await heroHeadline.boundingBox();
  expect(headlineBoxAfter).not.toBeNull();
  expect(Math.abs(headlineBoxAfter!.y - headlineBoxBefore!.y)).toBeLessThan(2);
});

test('the primary CTA ("Build Your First Automation") is visible and tappable with the menu closed, no horizontal overflow', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const cta = page.getByRole('link', { name: /build your first automation/i });
  await expect(cta).toBeVisible();
  const box = await cta.boundingBox();
  expect(box).not.toBeNull();
  // A real touch target, not a sliver clipped by overflow.
  expect(box!.width).toBeGreaterThan(40);
  expect(box!.height).toBeGreaterThan(30);
  await expectNoHorizontalOverflow(page);
});
