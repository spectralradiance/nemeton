import http from 'node:http';
import { expect, test } from '@playwright/test';
import { Store } from '@nemeton/server/store';
import { E2E_DB } from './paths';

// The performance budget from PLAN.md §8, measured in a real (Chromium) browser.

let token: string;
test.beforeAll(() => {
  const store = Store.open(E2E_DB);
  token = store.addOrganizer('Perf Organizer').token;
  store.close();
});

test.describe('performance budget', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'uses Chrome DevTools throttling');

  test('repeat visit shows the schedule in under 1 s on a mid-range phone CPU', async ({
    page,
    context,
  }, { project }) => {
    test.skip(project.name !== 'phone', 'phone budget');
    // First visit: service worker installs, schedule downloads into IndexedDB.
    await page.goto('/schedule/2026-06-19');
    await expect(page.locator('.session-row').first()).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    // Repeat visit, offline (so it can't be the network) with the CPU slowed 4x.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await context.setOffline(true);
    const start = Date.now();
    await page.reload();
    await expect(page.locator('.session-row').first()).toBeVisible();
    const elapsed = Date.now() - start;
    test.info().annotations.push({ type: 'repeat visit (4x CPU)', description: `${elapsed} ms` });
    expect(elapsed).toBeLessThan(1000);
  });

  test('applying 100 changes takes under 50 ms', async ({ page, request }, { project }) => {
    test.skip(project.name !== 'desktop', 'one run is enough');
    await page.goto('/updates');
    await expect(page.locator('main')).not.toBeEmpty();

    const snapshot = await (await request.get('/api/schedule/snapshot')).json();
    const changes = snapshot.sessions.slice(0, 100).map((s: { id: string }) => ({
      op: 'upsert',
      entity: 'session',
      id: s.id,
      data: { ...s, note: 'Budget test' },
    }));
    expect(changes.length).toBeGreaterThanOrEqual(50); // the festival has 53 sessions
    // Pad to 100 changes with vendor no-op upserts.
    for (const v of snapshot.vendors) {
      if (changes.length >= 100) break;
      changes.push({ op: 'upsert', entity: 'vendor', id: v.id, data: v });
    }
    while (changes.length < 100) changes.push(changes[changes.length % 50]);
    const res = await request.post('/api/admin/changes', {
      headers: { Authorization: `Bearer ${token}` },
      data: { changes },
    });
    expect(res.ok()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    const measure = await page
      .waitForFunction(() => {
        const m = performance.getEntriesByName('nemeton:apply-changes').at(-1) as
          PerformanceMeasure | undefined;
        return m && (m.detail as { count: number }).count >= 100
          ? { duration: m.duration, count: (m.detail as { count: number }).count }
          : null;
      })
      .then((h) => h.jsonValue());
    test.info().annotations.push({
      type: 'apply 100 changes',
      description: `${measure!.duration.toFixed(1)} ms`,
    });
    expect(measure!.duration).toBeLessThan(50);
  });

  test('the schedule download is under 300 KB compressed', async ({ baseURL }, { project }) => {
    test.skip(project.name !== 'desktop', 'one run is enough');
    // Raw bytes on the wire: Playwright's and fetch's clients would transparently decompress.
    const { encoding, bytes } = await new Promise<{ encoding?: string; bytes: number }>(
      (resolve, reject) => {
        http
          .get(
            `${baseURL}/api/schedule/snapshot`,
            { headers: { 'Accept-Encoding': 'gzip' } },
            (res) => {
              let bytes = 0;
              res.on('data', (chunk: Buffer) => (bytes += chunk.length));
              res.on('end', () => resolve({ encoding: res.headers['content-encoding'], bytes }));
            },
          )
          .on('error', reject);
      },
    );
    expect(encoding).toBe('gzip');
    test.info().annotations.push({
      type: 'snapshot (gzip)',
      description: `${(bytes / 1024).toFixed(1)} KB`,
    });
    expect(bytes).toBeLessThan(300 * 1024);
  });
});
