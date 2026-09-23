import { test, expect } from '@playwright/test';
import { loginViaSession, expectNoHorizontalOverflow, type TestAccount } from './fixtures';

/**
 * Phase 9.9.21 -- Website & Platform Connection Experience.
 *
 * Proves the full acceptance path end-to-end on a disposable, DRAFT
 * (never active) fixture workflow shaped like Workflow #1's Sigma Plus
 * intake: Connection Guide loads -> shows this workflow's OWN derived
 * fields (not a hardcoded list) -> platform selector renders every
 * required platform -> Test Connection transitions Waiting -> Received ->
 * Valid/Connected when a REAL request hits the REAL production webhook URL
 * with the REAL secret -- and that request is validated WITHOUT ever
 * dispatching a real execution (no side effects).
 */

function connectAccount(): TestAccount {
  const email = process.env.E2E_CONNECT_ACCOUNT_EMAIL;
  const password = process.env.E2E_CONNECT_ACCOUNT_PASSWORD;
  if (!email || !password) throw new Error('E2E_CONNECT_ACCOUNT_EMAIL / E2E_CONNECT_ACCOUNT_PASSWORD not set');
  return { email, password };
}

function workflowId(): string {
  const id = process.env.E2E_CONNECT_WORKFLOW_ID;
  if (!id) throw new Error('E2E_CONNECT_WORKFLOW_ID not set');
  return id;
}

function webhookSecret(): string {
  const secret = process.env.E2E_CONNECT_WEBHOOK_SECRET;
  if (!secret) throw new Error('E2E_CONNECT_WEBHOOK_SECRET not set');
  return secret;
}

/** Defensive cleanup -- a prior test in this file (or a prior failed run) may have left Test Connection armed; each test that needs "Start test" visible starts from a known-clean state. */
async function ensureTestModeStopped(page: import('@playwright/test').Page): Promise<void> {
  await page.request.post(`/api/workflows/${workflowId()}/connection/test`, {
    headers: { 'Content-Type': 'application/json' },
    data: { action: 'stop' },
  }).catch(() => {});
}

test.describe('Connection Guide -- Deploy -> Connect -> platform setup -> test inbound event -> Connected', () => {
  test('shows this workflow\'s OWN derived fields and every required platform', async ({ page }) => {
    await loginViaSession(page, connectAccount());
    await page.goto(`/dashboard/workflows/${workflowId()}/connect`, { waitUntil: 'domcontentloaded' });

    // Real derived fields from THIS workflow's json (name/email required from
    // the Airtable mapping, budget/urgency/purchase_intent from the AI
    // Classifier's inputFields) -- never a hardcoded global list.
    await expect(page.getByText(/name.*email|email.*name/i).first()).toBeVisible({ timeout: 15_000 });

    for (const label of ['Custom website', 'WordPress', 'WooCommerce', 'Shopify', 'ClickFunnels', 'Webflow', 'Wix', 'Squarespace', 'Framer', 'Other']) {
      await expect(page.getByRole('button', { name: new RegExp(label, 'i') }).first()).toBeVisible();
    }
  });

  test('Shopify is truthfully labeled "Requires Relay" (Phase 9.9.22 correction), never Native, with an official doc link', async ({ page }) => {
    await loginViaSession(page, connectAccount());
    await page.goto(`/dashboard/workflows/${workflowId()}/connect`, { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: /^Shopify$/i }).click();
    await expect(page.getByText(/requires relay/i)).toBeVisible();
    await expect(page.getByText(/^native connection$/i)).not.toBeVisible();
    await expect(page.getByRole('link', { name: /shopify/i }).first()).toHaveAttribute('href', /shopify/);
  });

  test('Squarespace is truthfully labeled an Intermediary connection, never claimed native', async ({ page }) => {
    await loginViaSession(page, connectAccount());
    await page.goto(`/dashboard/workflows/${workflowId()}/connect`, { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: /squarespace/i }).click();
    await expect(page.getByText(/intermediary connection/i)).toBeVisible();
    await expect(page.getByText(/native connection/i)).not.toBeVisible();
  });

  test('full Test Connection flow: Start test -> a real inbound event -> Connected, with zero real side effects', async ({ page, request, baseURL }) => {
    await loginViaSession(page, connectAccount());
    await ensureTestModeStopped(page);
    await page.goto(`/dashboard/workflows/${workflowId()}/connect`, { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: /start test/i }).click();
    // .first() -- the same text also appears in a transient toast notification.
    await expect(page.getByText(/waiting for an event/i).first()).toBeVisible({ timeout: 10_000 });

    // Simulate the external platform hitting the REAL production webhook URL
    // with the REAL secret and a REAL, valid payload -- exactly what a
    // successfully-configured Shopify/WordPress/custom integration would do.
    const webhookUrl = `${baseURL}/api/workflows/${workflowId()}/webhook`;
    const res = await request.post(webhookUrl, {
      headers: { 'Content-Type': 'application/json', 'X-MagicFlux-Webhook-Secret': webhookSecret() },
      data: { name: 'Jane Doe', email: 'jane@example.com', budget: 50000, urgency: 'high', purchase_intent: 'ready to buy' },
    });
    expect(res.status()).toBe(202);
    const body = await res.json();
    expect(body.test).toBe(true);
    expect(body.valid).toBe(true);

    await expect(page.getByText(/connected.*payload valid/i)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /stop test/i }).click();
    await expect(page.getByRole('button', { name: /start test/i })).toBeVisible();
  });

  test('an incomplete payload during test reports the specific missing field, not a generic failure', async ({ page, request, baseURL }) => {
    await loginViaSession(page, connectAccount());
    await ensureTestModeStopped(page);
    await page.goto(`/dashboard/workflows/${workflowId()}/connect`, { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: /start test/i }).click();
    await expect(page.getByText(/waiting for an event/i).first()).toBeVisible({ timeout: 10_000 });

    const webhookUrl = `${baseURL}/api/workflows/${workflowId()}/webhook`;
    const res = await request.post(webhookUrl, {
      headers: { 'Content-Type': 'application/json', 'X-MagicFlux-Webhook-Secret': webhookSecret() },
      data: { name: 'Jane Doe' }, // missing email
    });
    expect(res.status()).toBe(202);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.missingFields).toContain('email');

    await expect(page.getByText(/missing.*email/i)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /stop test/i }).click();
  });

  test('developer handoff copy omits the secret by default', async ({ page }) => {
    await loginViaSession(page, connectAccount());
    await page.goto(`/dashboard/workflows/${workflowId()}/connect`, { waitUntil: 'domcontentloaded' });

    const checkbox = page.locator('input[type="checkbox"]');
    await expect(checkbox).not.toBeChecked();
  });

  test('no horizontal overflow at the narrowest supported viewport (mobile-first requirement)', async ({ page }) => {
    await loginViaSession(page, connectAccount());
    await page.goto(`/dashboard/workflows/${workflowId()}/connect`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: /^Shopify$/i }).click();
    await page.waitForTimeout(200);
    await expectNoHorizontalOverflow(page);
  });
});
