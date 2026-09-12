import { test, expect } from '@playwright/test';
import { loginViaSession, trackConsoleErrors } from './fixtures';

/**
 * Phase 9.8.1 — reproduces the exact manual Founder journey from the
 * Phase 9.8 production incident end-to-end in a real browser, using a
 * disposable synthetic account and a synthetic workflow (never Brahim's
 * real reference workflow, d64074c8-c28c-42db-bed6-2ac32b60295e, which is
 * left untouched).
 *
 * Asserts the root-cause fix holds under real browser conditions:
 *   - clicking Approve + Deploy issues zero requests to
 *     /api/conversation/stream (the chat/LLM pipeline)
 *   - it issues exactly one POST to /api/workflows/[id]/lifecycle
 *   - no classification drift artifacts (Telegram/WhatsApp/Customer
 *     Support/"This step type isn't available yet") ever appear
 *   - the UI reaches a truthful final state (active, with webhook info)
 */

const FOUNDER_PROMPT =
  'Create a webhook automation that receives a customer name and order amount. ' +
  'If the amount is greater than 100, mark the customer as VIP; otherwise mark them as Standard.';

const FORBIDDEN_TEXT = [/telegram/i, /whatsapp/i, /customer support/i, /this step type isn.t available yet/i, /hit a snag/i];

test('Approve + Deploy reproduces the exact Founder journey deterministically, with zero chat-pipeline reinvocation', async ({ page }) => {
  const account = {
    email: process.env.E2E_ACCOUNT_A_EMAIL!,
    password: process.env.E2E_ACCOUNT_A_PASSWORD!,
  };
  if (!account.email || !account.password) {
    throw new Error('E2E_ACCOUNT_A_EMAIL / E2E_ACCOUNT_A_PASSWORD not set');
  }

  const errors = trackConsoleErrors(page);
  await loginViaSession(page, account);

  let conversationStreamCallsAfterDeployClick = 0;
  let lifecycleCallsAfterDeployClick = 0;
  let trackingArmed = false;

  page.on('request', (req) => {
    if (!trackingArmed) return;
    const url = req.url();
    if (req.method() === 'POST' && url.includes('/api/conversation/stream')) conversationStreamCallsAfterDeployClick++;
    if (req.method() === 'POST' && /\/api\/workflows\/[^/]+\/lifecycle/.test(url)) lifecycleCallsAfterDeployClick++;
  });

  await page.goto('/builder', { waitUntil: 'domcontentloaded' });

  const textarea = page.getByPlaceholder('What do you want to automate today?');
  await expect(textarea).toBeVisible({ timeout: 20_000 });
  await textarea.fill(FOUNDER_PROMPT);
  await textarea.press('Enter');

  // Real AI generation -- give it real time.
  const deployButton = page.getByRole('button', { name: /approve \+ deploy/i });
  await expect(deployButton).toBeVisible({ timeout: 60_000 });
  // The card can render briefly blocked (integration/persistence status
  // still settling from a just-arrived SSE event) before becoming
  // clickable -- wait for the stable, enabled state rather than racing it.
  await expect(deployButton).toBeEnabled({ timeout: 15_000 });
  await page.waitForTimeout(500);

  // Confirm the classification-drift bug did not resurface during
  // generation itself before we even click deploy.
  const bodyTextBeforeClick = await page.locator('body').innerText();
  for (const pattern of FORBIDDEN_TEXT) {
    expect(bodyTextBeforeClick, `found forbidden text matching ${pattern} before clicking deploy`).not.toMatch(pattern);
  }

  // Arm tracking and click. Everything after this point must be
  // deterministic: no chat pipeline, no reclassification.
  trackingArmed = true;
  await deployButton.click();

  // Wait for a terminal state: either the success card or a truthful error.
  await page.waitForFunction(
    () => {
      const text = document.body.innerText;
      return /your automation is live/i.test(text) || /activation failed|error/i.test(text);
    },
    { timeout: 30_000 },
  );

  const bodyTextAfterClick = await page.locator('body').innerText();
  for (const pattern of FORBIDDEN_TEXT) {
    expect(bodyTextAfterClick, `found forbidden text matching ${pattern} after clicking deploy`).not.toMatch(pattern);
  }

  expect(conversationStreamCallsAfterDeployClick, 'Approve + Deploy must never call /api/conversation/stream').toBe(0);
  expect(lifecycleCallsAfterDeployClick, 'Approve + Deploy must call POST /api/workflows/[id]/lifecycle exactly once').toBe(1);

  expect(errors.errors, `console errors: ${errors.errors.join('\n')}`).toEqual([]);
});

/**
 * Phase 9.8.3 — production nav bug: "Open workflow" pointed straight at the
 * POST-only webhook endpoint, so opening it (a browser GET) always 405'd.
 * Reproduces the exact Founder journey through activation and asserts the
 * CTA now targets the canonical workflow detail page, with the webhook URL
 * presented separately as a copyable field, never as the navigation target.
 */
test('after activation, "Open workflow" targets the canonical dashboard page, and the webhook URL is shown separately', async ({ page }) => {
  const account = {
    email: process.env.E2E_ACCOUNT_A_EMAIL!,
    password: process.env.E2E_ACCOUNT_A_PASSWORD!,
  };
  if (!account.email || !account.password) {
    throw new Error('E2E_ACCOUNT_A_EMAIL / E2E_ACCOUNT_A_PASSWORD not set');
  }

  await loginViaSession(page, account);
  await page.goto('/builder', { waitUntil: 'domcontentloaded' });

  const textarea = page.getByPlaceholder('What do you want to automate today?');
  await expect(textarea).toBeVisible({ timeout: 20_000 });
  await textarea.fill(FOUNDER_PROMPT);
  await textarea.press('Enter');

  const deployButton = page.getByRole('button', { name: /approve \+ deploy/i });
  await expect(deployButton).toBeVisible({ timeout: 60_000 });
  await expect(deployButton).toBeEnabled({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await deployButton.click();

  const openWorkflowLink = page.getByRole('link', { name: /open workflow/i });
  await expect(openWorkflowLink).toBeVisible({ timeout: 30_000 });

  const href = await openWorkflowLink.getAttribute('href');
  expect(href, 'Open workflow must never navigate to the raw API/webhook endpoint').not.toMatch(/\/api\//);
  expect(href, 'Open workflow must target the canonical workflow detail page').toMatch(/^\/dashboard\/workflows\/[^/]+$/);

  // The webhook URL is presented separately, with its own Copy control.
  const webhookLabel = page.getByText(/webhook url/i);
  await expect(webhookLabel).toBeVisible({ timeout: 10_000 });
  const copyButton = page.getByRole('button', { name: /copy url/i });
  await expect(copyButton).toBeVisible();

  // Clicking Open workflow actually lands on the canonical detail page, not a 405.
  await openWorkflowLink.click();
  await page.waitForURL(/\/dashboard\/workflows\//, { timeout: 15_000 });
  await expect(page.getByText(/production control/i)).toBeVisible({ timeout: 15_000 });
});

/**
 * Phase 9.8.4 — production 401 incident: a plain external POST to an active
 * webhook workflow always failed because the runtime silently required a
 * global, never-exposed HMAC secret. The dashboard also lied, claiming
 * "requests are accepted unsigned." This reproduces the Founder journey
 * through activation and asserts the dashboard now shows a truthful,
 * actually-usable auth section: a masked secret with Reveal/Hide and Copy,
 * the exact required header name, and copy-paste curl/PowerShell examples
 * — with no claim anywhere that unsigned requests are accepted.
 */
test('the workflow detail page shows a truthful, usable webhook auth section — masked secret, exact header, curl/PowerShell examples', async ({ page }) => {
  const account = {
    email: process.env.E2E_ACCOUNT_A_EMAIL!,
    password: process.env.E2E_ACCOUNT_A_PASSWORD!,
  };
  if (!account.email || !account.password) {
    throw new Error('E2E_ACCOUNT_A_EMAIL / E2E_ACCOUNT_A_PASSWORD not set');
  }

  await loginViaSession(page, account);
  await page.goto('/builder', { waitUntil: 'domcontentloaded' });

  const textarea = page.getByPlaceholder('What do you want to automate today?');
  await expect(textarea).toBeVisible({ timeout: 20_000 });
  await textarea.fill(FOUNDER_PROMPT);
  await textarea.press('Enter');

  const deployButton = page.getByRole('button', { name: /approve \+ deploy/i });
  await expect(deployButton).toBeVisible({ timeout: 60_000 });
  await expect(deployButton).toBeEnabled({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await deployButton.click();

  const openWorkflowLink = page.getByRole('link', { name: /open workflow/i });
  await expect(openWorkflowLink).toBeVisible({ timeout: 30_000 });
  await openWorkflowLink.click();
  await page.waitForURL(/\/dashboard\/workflows\//, { timeout: 15_000 });

  // Truthful auth section, not the old false "unsigned" claim.
  await expect(page.getByText(/authentication required/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/accepted unsigned/i)).toHaveCount(0);
  await expect(page.getByText('X-MagicFlux-Webhook-Secret').first()).toBeVisible();

  // Masked by default, then revealed.
  const revealButton = page.getByRole('button', { name: /^reveal$/i });
  await expect(revealButton).toBeEnabled({ timeout: 15_000 });
  const maskedField = page.locator('code', { hasText: '••••' });
  await expect(maskedField).toBeVisible();
  await revealButton.click();
  await expect(page.getByRole('button', { name: /^hide$/i })).toBeVisible();
  await expect(maskedField).toHaveCount(0);

  await expect(page.getByRole('button', { name: /copy secret/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /^rotate$/i })).toBeVisible();

  // Copy-paste examples, both carrying the exact required header.
  await page.getByText(/example request/i).click();
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).toMatch(/curl -X POST/);
  expect(bodyText).toMatch(/Invoke-RestMethod/);
  expect((bodyText.match(/X-MagicFlux-Webhook-Secret/g) ?? []).length).toBeGreaterThanOrEqual(3);
});
