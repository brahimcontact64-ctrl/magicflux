import { test, expect } from '@playwright/test';
import { loginViaSession, type TestAccount } from './fixtures';

/**
 * Phase 9.9.20 -- Global Free Beta Entitlements.
 *
 * Root cause: lib/auth-context.tsx's fetchPlan() ran its OWN independent,
 * non-Beta-aware query directly against subscriptions/user_profiles,
 * bypassing the canonical server-side resolver (resolveUserPlan(), already
 * fully Beta-aware and already the single source every real enforcement
 * route used). A brand-new account with zero subscription rows resolved
 * there to the raw string 'free', which every isPro-style client check then
 * read as "blocked" -- producing "requires Pro" messaging for a capability
 * the server had already granted. Fixed by pointing the client at
 * /api/billing/usage (the existing endpoint that already wraps
 * resolveUserPlan()) instead of a second, divergent resolver.
 *
 * This spec proves it end-to-end for the exact account shape the bug
 * report described: authenticated, brand-new, zero subscription rows,
 * never manually provisioned.
 */

function betaAccount(): TestAccount {
  const email = process.env.E2E_BETA_ACCOUNT_EMAIL;
  const password = process.env.E2E_BETA_ACCOUNT_PASSWORD;
  if (!email || !password) throw new Error('E2E_BETA_ACCOUNT_EMAIL / E2E_BETA_ACCOUNT_PASSWORD not set');
  return { email, password };
}

test.describe('Global Free Beta entitlements -- brand-new, zero-subscription account', () => {
  test('/api/billing/usage grants Beta capability (deploy_enabled, expanded limits) with the real "free" slug intact', async ({ page }) => {
    await loginViaSession(page, betaAccount());
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

    const res = await page.request.get('/api/billing/usage');
    expect(res.ok()).toBe(true);
    const body = await res.json();

    // The real, un-expanded paid-tier identity -- Beta must never fake a
    // paid subscription.
    expect(body.plan_slug).toBe('free');
    // But the effective, Beta-aware capability must be fully unlocked.
    expect(body.deploy_enabled).toBe(true);
    expect(body.workflows_limit).toBe(10);
    expect(body.integrations_limit).toBe(3);
    expect(body.executions_limit).toBe(100);
    expect(String(body.plan_name)).toMatch(/beta/i);
  });

  test('Builder page never shows a "requires Pro" / "Pro only" blocker for this account', async ({ page }) => {
    await loginViaSession(page, betaAccount());
    await page.goto('/builder', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500); // let auth-context hydration + /api/billing/usage resolve

    const blockerText = page.getByText(/requires pro|pro only|pro required/i);
    expect(await blockerText.count(), 'a Beta account must never see Pro-required blocking copy').toBe(0);

    // The old unconditional amber upgrade banner must not render either --
    // it's now gated on the real deploy_enabled signal, which is true here.
    const upgradeBanner = page.getByText(/activating a live workflow requires pro/i);
    expect(await upgradeBanner.count()).toBe(0);
  });
});
