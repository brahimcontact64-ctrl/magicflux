import { test, expect } from '@playwright/test';
import { expectNoHorizontalOverflow, findOverflowingElements } from './fixtures';

/**
 * Phase 9.9.19C -- a real iPhone showed the SAME production build render
 * correctly in one capture and with massive horizontal overflow (badge,
 * H1, subtitle, rotating text, and the terminal card all "extend
 * off-screen"/"oversized") in another, from the same session. Extensive
 * automated investigation (recursive DOM-width hunting through every
 * requested state transition -- menu open/close x3, anchor navigation,
 * scroll, resize 390<->393, reload, and 12s of idle time spanning multiple
 * full Hero typing/rotation cycles -- on BOTH Chromium and Playwright's
 * WebKit engine) found ZERO reproduction of page-level overflow.
 *
 * That negative result is itself the diagnostic finding, not a dead end:
 * Playwright's "webkit" project is DESKTOP WebKit wearing a mobile
 * viewport/UA/touch costume -- it does not implement iOS Safari's actual
 * mobile-only text-autosizing ("boost") subsystem, which can inflate
 * rendered font sizes beyond what the CSS specifies independent of any
 * layout bug, and is a well-documented source of exactly this
 * "same device, same code, intermittent oversized/overflowing text"
 * symptom. No Playwright-based engine can exercise or verify this
 * behavior; only a real iPhone can. What IS provable here:
 *
 *  1. html now explicitly disables that WebKit auto-inflation
 *     (-webkit-text-size-adjust / text-size-adjust: 100%) -- the
 *     standard, non-hacky mitigation, verified by asserting the
 *     computed style directly (fails on the pre-fix CSS, passes after).
 *  2. The raw server-rendered HTML previously carried two duplicate (if
 *     identical) <meta name="viewport"> tags, because the root layout was
 *     a client component and Next.js cannot use a client component's
 *     `metadata`/`viewport` export -- it synthesized its own fallback
 *     alongside the manually-authored one. Fixed by splitting the
 *     client-only providers into their own component and restoring
 *     app/layout.tsx to a real server component using Next's `metadata`
 *     export as the single source of truth. Verified by counting the tag
 *     in the actual HTTP response body (not just post-hydration DOM),
 *     which fails on the pre-fix duplicate and passes at exactly one.
 *  3. Repeated (not single-shot) geometry checks across every requested
 *     transition, to keep asserting the negative result stays negative on
 *     whatever regressions ARE visible to these engines.
 */

test('html disables WebKit/mobile text auto-inflation (the standard mitigation for "text renders oversized on a real device, not reproducible in automation")', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const adjust = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('-webkit-text-size-adjust') || getComputedStyle(document.documentElement).getPropertyValue('text-size-adjust'));
  expect(adjust.trim()).toBe('100%');
});

test('exactly one <meta name="viewport"> tag in the raw server-rendered HTML (not two)', async ({ request, baseURL }) => {
  const res = await request.get(baseURL ?? '/');
  const body = await res.text();
  const matches = body.match(/<meta[^>]*name=["']viewport["'][^>]*>/g) ?? [];
  expect(matches.length, `expected exactly one viewport meta tag, found: ${JSON.stringify(matches)}`).toBe(1);
});

test.describe('repeated geometry stability through every requested state transition (320-430 + webkit-mobile)', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile-viewport-specific stability sweep');

  test('fresh load -> menu cycles x3 -> anchor nav -> scroll -> resize -> reload -> idle through Hero animation, zero page-level overflow at every checkpoint', async ({ page }) => {
    const checkpoints: string[] = [];
    const assertClean = async (label: string) => {
      checkpoints.push(label);
      await expectNoHorizontalOverflow(page);
      const { offenders } = await findOverflowingElements(page);
      expect(offenders, `non-decorative/non-contained overflowing element(s) at [${label}]: ${JSON.stringify(offenders)}`).toEqual([]);
    };

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await assertClean('fresh-load');

    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: /open menu/i }).click();
      await page.waitForTimeout(300);
      await assertClean(`menu-open-${i}`);
      await page.getByRole('button', { name: /close menu/i }).click();
      await page.waitForTimeout(300);
      await assertClean(`menu-closed-${i}`);
    }

    await page.evaluate(() => { window.location.hash = '#how-it-works'; });
    await page.waitForTimeout(500);
    await assertClean('anchor-nav');
    await page.evaluate(() => { window.location.hash = ''; window.scrollTo(0, 0); });
    await page.waitForTimeout(500);
    await assertClean('back-to-top');

    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);
    await assertClean('scrolled');
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(300);
    await assertClean('scrolled-back');

    const vp = page.viewportSize()!;
    await page.setViewportSize({ width: vp.width === 390 ? 393 : vp.width + 3, height: vp.height });
    await page.waitForTimeout(400);
    await assertClean('resized');
    await page.setViewportSize(vp);
    await page.waitForTimeout(400);
    await assertClean('resized-back');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await assertClean('after-reload');

    // Idle through a full typed-example + rotating-word cycle (~2.5-4.5s
    // combined) with several checkpoints, not one deterministic shot.
    const idleStart = Date.now();
    let n = 0;
    while (Date.now() - idleStart < 6000) {
      await assertClean(`idle-${n++}`);
      await page.waitForTimeout(500);
    }

    expect(checkpoints.length).toBeGreaterThan(15);
  });
});
