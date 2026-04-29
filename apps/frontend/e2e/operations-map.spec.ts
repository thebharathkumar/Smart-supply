import { test, expect } from '@playwright/test';

test.describe('Operations Map', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('renders the layout chrome and connects WS', async ({ page }) => {
    await expect(page.getByText('SMART · SUPPLY')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Operations Map' })).toBeVisible();

    // WS status indicator must transition to "open" within 5s.
    await expect(page.getByText(/ws · open/)).toBeVisible({ timeout: 5_000 });
  });

  test('renders the Leaflet map and at least one route polyline', async ({ page }) => {
    // Leaflet renders into a .leaflet-container div with SVG overlays.
    await expect(page.locator('.leaflet-container')).toBeVisible();

    // Wait for routes to load (network may be slow in CI).
    await page.waitForResponse(
      (r) => r.url().includes('/api/routes') && r.status() === 200,
      { timeout: 15_000 },
    );

    // SVG path elements come from polylines + circle markers.
    await expect(page.locator('.leaflet-overlay-pane svg path')).toHaveCount(
      // Loose: at least one route polyline drawn.
      await page.locator('.leaflet-overlay-pane svg path').count(),
    );
    expect(await page.locator('.leaflet-overlay-pane svg path').count()).toBeGreaterThan(0);
  });

  test('legend is visible', async ({ page }) => {
    await expect(page.getByText(/excellent/i)).toBeVisible();
    await expect(page.getByText(/critical/i)).toBeVisible();
  });
});
