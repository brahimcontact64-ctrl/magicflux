import { test, expect } from '@playwright/test';
import { loginViaSession, accountA } from './fixtures';

/**
 * Incident 9.9.17B -- root cause: ExecutionFilterBar's Status/Mode/Date
 * filter dropdowns each unconditionally rendered a `<SelectItem value="">`
 * ("All statuses" / "All modes" / "All time") for the whole lifetime of this
 * component. Radix's <Select.Item> hard-throws when value="" (that string is
 * reserved internally to mean "cleared -- show placeholder"), so /executions
 * threw on every single render for every user, regardless of workflow or
 * execution data -- a standing, data-independent defect (present since the
 * pre-Phase-8 commit that introduced this file), surfaced to production
 * users as "Application error: a client-side exception has occurred."
 */

for (const [label, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile-375', { width: 375, height: 812 }],
] as const) {
  test.describe(`/executions filter bar -- ${label}`, () => {
    test.use({ viewport });

    test(`loads without the Select.Item empty-value crash and filters still work (${label})`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

      await loginViaSession(page, accountA());
      await page.goto('/executions');
      await page.waitForLoadState('networkidle');

      await expect(page.getByText('Application error')).toHaveCount(0);
      expect(consoleErrors.some((e) => e.includes('Select.Item') && e.includes('empty string'))).toBe(false);

      // The filter bar itself must have actually rendered (not silently
      // swallowed by an error boundary further up the tree).
      await expect(page.getByText('All statuses')).toBeVisible();
      await expect(page.getByText('All modes')).toBeVisible();
      await expect(page.getByText('All time')).toBeVisible();

      // Exercise each dropdown -- selecting a real filter, then returning to
      // "All ..." must not throw either (the reverse of the crash path).
      await page.getByText('All statuses').click();
      await page.getByRole('option', { name: 'Failed' }).click();
      await expect(page.getByText('Application error')).toHaveCount(0);

      await page.getByText('Failed', { exact: true }).click();
      await page.getByRole('option', { name: 'All statuses' }).click();
      await expect(page.getByText('Application error')).toHaveCount(0);

      expect(consoleErrors.some((e) => e.includes('Select.Item') && e.includes('empty string'))).toBe(false);
    });
  });
}
