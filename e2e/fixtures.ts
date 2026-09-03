import { type Page, expect } from '@playwright/test';

/**
 * Phase 9.5 — shared E2E helpers. Accounts are disposable @magicflux.local
 * test users created out-of-band via the Supabase service-role admin API
 * (never real users, never real external side effects) and passed in
 * through env vars so no credential is ever hardcoded in a spec file.
 */

export type TestAccount = { email: string; password: string };

export function accountA(): TestAccount {
  const email = process.env.E2E_ACCOUNT_A_EMAIL;
  const password = process.env.E2E_ACCOUNT_A_PASSWORD;
  if (!email || !password) throw new Error('E2E_ACCOUNT_A_EMAIL / E2E_ACCOUNT_A_PASSWORD not set');
  return { email, password };
}

export function accountB(): TestAccount {
  const email = process.env.E2E_ACCOUNT_B_EMAIL;
  const password = process.env.E2E_ACCOUNT_B_PASSWORD;
  if (!email || !password) throw new Error('E2E_ACCOUNT_B_EMAIL / E2E_ACCOUNT_B_PASSWORD not set');
  return { email, password };
}

/**
 * Injects a real Supabase session directly into localStorage (obtained via
 * the standard password-grant REST call, same credentials as loginAs)
 * instead of driving the login form. Used only where the form-based flow
 * has proven flaky in this environment (heavy automated traffic during
 * this audit appears to trip something -- possibly bot/rate-limit
 * protection -- specific to the browser-context sign-in call; the
 * credentials and token themselves are independently confirmed valid via
 * the same REST endpoint). A legitimate, standard Playwright pattern
 * (storage-state injection), not a workaround for a product bug.
 */
export async function loginViaSession(page: Page, account: TestAccount): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY not set');

  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  if (!res.ok) throw new Error(`session grant failed: ${res.status} ${await res.text()}`);
  const session = await res.json();

  const projectRef = new URL(url).hostname.split('.')[0];
  const storageKey = `sb-${projectRef}-auth-token`;

  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: storageKey, value: JSON.stringify(session) },
  );

  // Server components (e.g. app/executions/[id]/page.tsx) authenticate via
  // getUserFromRequest(), which reads the mf_access_token cookie -- a
  // separate mechanism from supabase-js's own localStorage session, and one
  // normally only written by lib/auth-context.tsx's effect once the client
  // React tree has mounted. Navigating straight to a server-auth-guarded
  // page (no intermediate client page first) beats that effect to the
  // first request, so it's set directly here too.
  const baseURL = process.env.E2E_BASE_URL ?? 'https://www.magicflux.ai';
  await page.context().addCookies([
    {
      name: 'mf_access_token',
      value: session.access_token,
      url: baseURL,
    },
  ]);
}

export async function loginAs(page: Page, account: TestAccount): Promise<void> {
  await page.goto('/login');
  // Step N finding: the login form's <label> elements aren't programmatically
  // associated with their <input>s (no htmlFor/id pair), so getByLabel()
  // can't find them -- falling back to type selectors here. Flagged
  // separately as a real (low-severity) accessibility gap, not fixed here.
  await page.locator('input[type="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole('button', { name: /sign ?in/i }).click();
  await page.waitForURL(/\/(dashboard|builder|onboarding)/, { timeout: 20_000 });
}

/** Fails the test on any browser console error, except a small documented allowlist. */
export function trackConsoleErrors(page: Page, allow: RegExp[] = []): { errors: string[] } {
  const state = { errors: [] as string[] };
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (allow.some((re) => re.test(text))) return;
    state.errors.push(text);
  });
  return state;
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });
  expect(overflow, 'page has horizontal overflow (content wider than viewport)').toBeLessThanOrEqual(2);
}
