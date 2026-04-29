import { test, expect } from '@playwright/test';

test.describe('Agent Console', () => {
  test('streams events from the deterministic agent loop', async ({ page }) => {
    await page.goto('/agent');
    await expect(page.getByText(/supply\.optimize/)).toBeVisible();

    const goalBox = page.locator('textarea');
    await expect(goalBox).toBeVisible();
    // Default sample goal is pre-filled; just hit run.
    await page.getByRole('button', { name: /run agent/i }).click();

    // Wait for at least one streamed event row to appear.
    await expect(page.getByText(/session started/i)).toBeVisible({ timeout: 10_000 });

    // Mode badge populates from the started event.
    await expect(page.locator('text=/mode · (llm|deterministic)/')).toBeVisible({
      timeout: 10_000,
    });

    // Final plan card shows up by the time the loop completes.
    await expect(page.getByText(/final plan/i)).toBeVisible({ timeout: 30_000 });
  });
});
