import { defineConfig, devices } from '@playwright/test';

/**
 * Phase 9.5 Steps B/H/N — real browser verification against production
 * (https://www.magicflux.ai by default; override with E2E_BASE_URL for a
 * local dev server). Disposable @magicflux.local accounts only (created via
 * service-role admin API outside this repo, passed in through
 * E2E_ACCOUNT_A_EMAIL/PASSWORD and E2E_ACCOUNT_B_EMAIL/PASSWORD env vars --
 * never hardcoded here). No real external side effects: specs must only use
 * safe_preview/staging_deploy execution modes and safe target URLs
 * (httpbin.org etc.), never a real Slack/Shopify/email send.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://www.magicflux.ai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-375', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
    { name: 'mobile-320', use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 690 }, isMobile: true, hasTouch: true } },
    { name: 'mobile-430', use: { ...devices['Desktop Chrome'], viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true } },
    { name: 'tablet-768', use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
    { name: 'webkit-mobile', use: { ...devices['iPhone 14'] } },
  ],
});
