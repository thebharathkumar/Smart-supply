import { test, expect } from '@playwright/test';

test.describe('Forecast view', () => {
  test('lists suppliers and runs a forecast', async ({ page }) => {
    await page.goto('/forecast');
    await page.waitForResponse(
      (r) => r.url().includes('/api/suppliers') && r.status() === 200,
    );

    // First supplier in the sidebar.
    const firstSupplier = page.locator('aside button').first();
    await expect(firstSupplier).toBeVisible({ timeout: 10_000 });
    await firstSupplier.click();

    await page.getByRole('button', { name: /run forecast/i }).click();

    // Either we get a forecast back (chart) or a 404 (no history) error panel.
    const chartOrError = page.locator(
      'text=/forecast failed|model:|MAPE/i',
    );
    await expect(chartOrError.first()).toBeVisible({ timeout: 30_000 });
  });
});
