import { test, expect, type Page } from '@playwright/test';
import { loginViaSession, expectNoHorizontalOverflow, type TestAccount } from './fixtures';

/**
 * Phase 9.9.19B -- a real iPhone caught two collisions that
 * scrollWidth<=clientWidth-only assertions (Phase 9.9.19's own spec) never
 * could:
 *
 *   1. Anchor-navigating to a landing section (e.g. "How it works") scrolls
 *      its top edge to viewport y=0 -- directly under the 64px fixed
 *      navbar -- because none of the six #anchor sections had
 *      scroll-margin-top. Horizontal overflow was never involved; this was
 *      a pure vertical element-to-element collision.
 *   2. A long account email overflowed the mobile nav sheet's "Signed in
 *      as" row horizontally -- contained by the sheet's own overflow-x:
 *      auto (so page-level scrollWidth stayed within clientWidth), but
 *      still a real, visible overflow WITHIN the sheet no page-level check
 *      would ever catch.
 *
 * This file asserts actual bounding-box geometry (no intersection between
 * the fixed navbar and the content that must never sit under it), not just
 * page-level overflow. Screenshots are captured as artifacts for manual
 * visual review (test-results/) -- not compared against committed pixel
 * baselines, since a pixel-diff baseline generated in one environment
 * (this sandbox) is not a reliable regression signal in another (font
 * hinting, OS rendering) without ongoing baseline maintenance this project
 * has no CI runner to own. Geometry assertions are the actual regression
 * guarantee here; screenshots are for a human to look at.
 */

function intersects(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function navbarBox(page: Page) {
  const box = await page.locator('header').first().boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

test.describe('landing page anchor-scroll must never collide with the fixed navbar', () => {
  test.skip(({ isMobile }) => !isMobile, 'the reported bug is mobile-nav-driven; desktop nav has no anchor-collision risk at this navbar height');

  const anchors: Array<{ href: string; headingPattern: RegExp }> = [
    { href: '#how-it-works', headingPattern: /two ways to automate/i },
    { href: '#templates', headingPattern: /./ },
    { href: '#managed', headingPattern: /./ },
    { href: '#pricing', headingPattern: /./ },
    { href: '#demo', headingPattern: /./ },
    { href: '#waitlist', headingPattern: /./ },
  ];

  for (const { href, headingPattern } of anchors) {
    test(`anchor ${href}: target section clears the fixed navbar after native scroll`, async ({ page }) => {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);

      // Open the mobile sheet and tap the real nav link -- exactly the
      // real-device repro path, not a page.goto(hash) shortcut (which
      // skips the browser's own native anchor-scroll behavior entirely).
      await page.getByRole('button', { name: /open menu/i }).click();
      await page.getByRole('link', { name: new RegExp(href.replace('#', ''), 'i') }).click().catch(async () => {
        // Fall back to clicking by href for links whose visible label
        // doesn't literally contain the anchor id (Templates, Demo, etc.)
        await page.locator(`header a[href="${href}"]`).first().click();
      });
      await page.waitForTimeout(600);

      const nav = await navbarBox(page);
      const target = page.locator(href);
      await expect(target).toBeVisible();
      const targetBox = await target.boundingBox();
      expect(targetBox).not.toBeNull();

      // The section's own box (with scroll-margin-top applied) must start
      // AT OR BELOW the navbar's bottom edge -- zero pixels of overlap.
      expect(targetBox!.y).toBeGreaterThanOrEqual(nav.y + nav.height - 1);
      expect(intersects(nav, targetBox!)).toBe(false);

      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: `test-results/visual-anchor-${href.replace('#', '')}.png` });
    });
  }
});

test.describe('landing page — visual capture + no-collision baseline (initial load)', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile-specific visual capture');

  test('initial load: navbar closed, Hero content clear of the navbar, no overflow', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await expectNoHorizontalOverflow(page);

    const nav = await navbarBox(page);
    const heading = page.getByRole('heading', { level: 1 });
    const headingBox = await heading.boundingBox();
    expect(headingBox).not.toBeNull();
    expect(intersects(nav, headingBox!)).toBe(false);

    await page.screenshot({ path: 'test-results/visual-landing-initial.png' });
  });

  test('navbar open: full-viewport sheet, no overflow, close control reachable, opening does not shift page layout', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    const heroBefore = await page.getByRole('heading', { level: 1 }).boundingBox();

    await page.getByRole('button', { name: /open menu/i }).click();
    await page.waitForTimeout(400);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: 'test-results/visual-navbar-open.png' });

    await page.getByRole('button', { name: /close menu/i }).click();
    await page.waitForTimeout(400);
    const heroAfter = await page.getByRole('heading', { level: 1 }).boundingBox();
    expect(Math.abs(heroAfter!.y - heroBefore!.y)).toBeLessThan(2);
    await page.screenshot({ path: 'test-results/visual-navbar-closed-after.png' });
  });

  test('first section below Hero ("How it works") never collides with the navbar on a normal scroll (not just anchor-jump)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.locator('#how-it-works').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);

    const nav = await navbarBox(page);
    const heading = page.getByRole('heading', { name: /two ways to automate/i });
    const headingBox = await heading.boundingBox();
    expect(headingBox).not.toBeNull();
    expect(intersects(nav, headingBox!)).toBe(false);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: 'test-results/visual-how-it-works-section.png' });
  });
});

test.describe('authenticated navbar with hostile content (long email)', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile nav sheet is the surface under test');

  const email = process.env.E2E_LONG_EMAIL_ACCOUNT_EMAIL;
  const password = process.env.E2E_LONG_EMAIL_ACCOUNT_PASSWORD;
  test.skip(!email || !password, 'E2E_LONG_EMAIL_ACCOUNT_EMAIL/PASSWORD not set -- run scripts/e2e-long-email-fixture-setup.ts first');

  test('a very long email never forces the mobile nav sheet (or the page) wider than the viewport', async ({ page }) => {
    await loginViaSession(page, { email: email!, password: password! } as TestAccount);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.getByRole('button', { name: /open menu/i }).click();
    await page.waitForTimeout(400);

    await expect(page.getByText(/signed in as/i)).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // The sheet itself (not just the outer <html>) must not scroll
    // horizontally either -- this is the exact gap a page-level-only
    // overflow check missed (the sheet's own overflow-y-auto computed
    // overflow-x: auto too, which contains a spillover as a horizontal
    // scrollbar WITHIN the sheet rather than a page-level overflow).
    const sheet = page.locator('header > div.fixed').first();
    const sheetOverflow = await sheet.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(sheetOverflow).toBeLessThanOrEqual(1);

    await page.screenshot({ path: 'test-results/visual-navbar-long-email.png' });
  });
});
