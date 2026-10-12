import { expect, test, type APIRequestContext } from '@playwright/test';
import { Store } from '@nemeton/server/store';
import { E2E_DB } from './paths';

// Phase 4 exit: an organizer change reaches a connected app in under 2 seconds with no refresh
// trigger at all, and a dropped connection resumes without missing changes.

let token: string;
test.beforeAll(() => {
  const store = Store.open(E2E_DB);
  token = store.addOrganizer('Live Organizer').token;
  store.close();
});

async function publish(request: APIRequestContext, id: string, patch: Record<string, unknown>) {
  const snapshot = await (await request.get('/api/schedule/snapshot')).json();
  const session = snapshot.sessions.find((s: { id: string }) => s.id === id);
  const res = await request.post('/api/admin/changes', {
    headers: { Authorization: `Bearer ${token}` },
    data: { changes: [{ op: 'upsert', entity: 'session', id, data: { ...session, ...patch } }] },
  });
  expect(res.ok()).toBe(true);
}

/** A different session per browser project, so desktop and phone runs don't interfere. */
const pick = (project: string, desktop: string, phone: string) =>
  project === 'phone' ? phone : desktop;

test('a change is pushed to a connected app within 2 seconds', async ({ page, request }, {
  project,
}) => {
  const id = pick(project.name, 'soriah-fri', 'sorcia-sat');
  // The live stream is a request that never finishes, so wait for it to start. Anything published
  // before the server subscribes is still delivered: the stream replays from the app's seq.
  const stream = page.waitForRequest((r) => r.url().includes('/api/events'));
  await page.goto(`/session/${id}`);
  await expect(page.locator('.detail-title')).toBeVisible();
  await stream;
  // Toasts are for sessions in the attendee's plan.
  await page.getByRole('button', { name: 'Add to my plan' }).click();
  await page.waitForTimeout(300);

  const started = Date.now();
  await publish(request, id, { status: 'delayed', note: 'Pushed live' });
  await expect(page.locator('.status-banner')).toContainText('Pushed live', { timeout: 2000 });
  expect(Date.now() - started).toBeLessThan(2000);

  // A toast says what happened, and the Updates tab shows it as new.
  await expect(page.locator('.change-toast')).toContainText('Delayed');
  await expect(page.locator('.nav-link', { hasText: 'Updates' }).locator('.badge')).toBeVisible();
  await page.locator('.nav-link', { hasText: 'Updates' }).click();
  await expect(page.locator('.feed-item').first()).toContainText('Pushed live');
  await expect(page.locator('.nav-link', { hasText: 'Updates' }).locator('.badge')).toBeHidden();
});

test('changes made while the connection was down arrive when it comes back', async ({
  page,
  context,
  request,
}, { project }) => {
  const id = pick(project.name, 'oromet-sat', 'iron-rot-sun');
  await page.goto(`/session/${id}`);
  await expect(page.locator('.detail-title')).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByRole('link', { name: 'Offline' })).toBeVisible();

  // Published while this device can't hear about it.
  await publish(request, id, { status: 'cancelled', note: 'Missed while offline' });
  await page.waitForTimeout(500);
  await expect(page.locator('.status-banner')).toHaveCount(0);

  await context.setOffline(false);
  await expect(page.locator('.status-banner')).toContainText('Missed while offline', {
    timeout: 5000,
  });
});
