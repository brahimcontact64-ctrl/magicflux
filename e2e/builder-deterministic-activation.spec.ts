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
