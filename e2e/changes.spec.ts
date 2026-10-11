import { expect, test } from '@playwright/test';
import { Store } from '@nemeton/server/store';
import { E2E_DB } from './paths';

// Phase 3 exit: an organizer's change reaches an already-open app on its next refresh trigger,
// without a reload.

let token: string;
test.beforeAll(() => {
  // The test API server created and seeded this database; add an organizer straight into it.
  const store = Store.open(E2E_DB);
  token = store.addOrganizer('E2E Organizer').token;
  store.close();
});

test('an organizer change shows up in an open app without reloading', async ({
  page,
  request,
}, testInfo) => {
  // Each project gets its own session so the two runs don't interfere.
  const id = testInfo.project.name === 'phone' ? 'fogweaver-fri' : 'hail-fri';
  await page.goto(`/session/${id}`);
  await expect(page.locator('.detail-title')).toBeVisible();
  const marker = await page.evaluate(() => {
    (document.querySelector('.detail') as HTMLElement & { __marker?: number }).__marker = 1;
    return 1;
  });

  const snapshot = await (await request.get('/api/schedule/snapshot')).json();
  const session = snapshot.sessions.find((s: { id: string }) => s.id === id);
  const res = await request.post('/api/admin/changes', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      baseSeq: snapshot.seq,
      changes: [
        {
          op: 'upsert',
          entity: 'session',
          id,
          data: { ...session, status: 'cancelled', note: 'Cancelled due to high winds' },
        },
      ],
    },
  });
  expect(res.ok()).toBe(true);

  // A refresh trigger the app listens for (coming back online).
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect(page.getByText('Cancelled due to high winds')).toBeVisible();
  // Same DOM node: updated in place, not reloaded or remounted.
  expect(
    await page.evaluate(
      () => (document.querySelector('.detail') as HTMLElement & { __marker?: number }).__marker,
    ),
  ).toBe(marker);
});
