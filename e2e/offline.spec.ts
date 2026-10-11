import { expect, test, type Page } from '@playwright/test';

/** Waits until a service worker controls the page and has finished precaching the app shell. */
async function waitForOfflineReady(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
  }
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test('the schedule works offline after one visit', async ({ page, context }) => {
  await page.goto('/schedule/2026-06-19');
  await expect(page.getByText('Stygian Bough').first()).toBeVisible();
  await waitForOfflineReady(page);

  await context.setOffline(true);

  // A hard reload is served entirely from the service worker cache and IndexedDB.
  await page.reload();
  await expect(page.getByText('Stygian Bough').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Offline' })).toBeVisible();

  // Deep links work too, even ones never visited online.
  await page.goto('/session/fauna-sun');
  await expect(page.getByRole('heading', { name: 'Fauna', level: 1 })).toBeVisible();
  await expect(page.getByText('formed in 2004', { exact: false })).toBeVisible();

  await page.goto('/lineup');
  await page.getByRole('searchbox', { name: 'Search the lineup' }).fill('selkie');
  await expect(page.getByRole('link', { name: /Rewilding the Selkie/ })).toBeVisible();

  // Back online: the indicator clears.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('link', { name: 'Offline' })).toBeHidden();
});

test('the web app manifest is installable', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await request.get(href!)).json();
  expect(manifest).toMatchObject({ name: 'Nemeton', display: 'standalone', start_url: '/' });
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
});

test('photos saved from Settings show offline', async ({ page, context }) => {
  await page.goto('/settings');
  await waitForOfflineReady(page);
  await page.getByRole('button', { name: 'Save all photos now' }).click();
  await expect(page.getByRole('button', { name: 'All photos saved' })).toBeVisible({
    timeout: 60_000,
  });

  await context.setOffline(true);
  await page.goto('/session/hail-fri');
  const photo = page.getByRole('img', { name: 'Hail' });
  await expect(photo).toBeVisible();
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
});
