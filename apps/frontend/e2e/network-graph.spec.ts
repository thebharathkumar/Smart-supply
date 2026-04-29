import { test, expect } from '@playwright/test';

test.describe('Network Graph', () => {
  test('renders force-directed graph and supports optimize', async ({ page }) => {
    await page.goto('/network');
    await expect(page.getByText('network')).toBeVisible();

    // Wait for hubs/routes API responses, then for d3-force to settle nodes.
    await page.waitForResponse((r) => r.url().includes('/api/hubs') && r.status() === 200);
    await page.waitForResponse((r) => r.url().includes('/api/routes') && r.status() === 200);

    // Hub nodes are circles in the inner <g> within the SVG.
    const circles = page.locator('svg g circle');
    await expect.poll(async () => circles.count(), { timeout: 10_000 }).toBeGreaterThan(0);

    // Click + shift-click to set origin and destination.
    const all = await circles.all();
    expect(all.length).toBeGreaterThan(1);
    await all[0]!.click();
    await all[1]!.click({ modifiers: ['Shift'] });

    // Optimize button enabled now.
    const optimizeBtn = page.getByRole('button', { name: /find pareto routes/i });
    await expect(optimizeBtn).toBeEnabled();
    await optimizeBtn.click();

    // Either a 200 with solutions or a 404 (no path) - we accept both,
    // but expect the request to be made.
    await page.waitForResponse(
      (r) => r.url().includes('/api/optimize/route'),
      { timeout: 15_000 },
    );
  });
});
