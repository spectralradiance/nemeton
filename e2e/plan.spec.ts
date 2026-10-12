import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { Store } from '@nemeton/server/store';
import { E2E_DB } from './paths';

// Phase 5: the attendee's plan works offline, syncs when back online, and reacts to organizer
// changes to saved sessions.

let token: string;
test.beforeAll(() => {
  const store = Store.open(E2E_DB);
  token = store.addOrganizer('Plan Organizer').token;
  store.close();
});

const auth = () => ({ Authorization: `Bearer ${token}` });
/** Desktop and phone runs share the server, so each uses its own sessions. */
const pick = (project: string, desktop: string, phone: string) =>
  project === 'phone' ? phone : desktop;

async function save(page: Page, id: string) {
  await page.goto(`/session/${id}`);
  await page.getByRole('button', { name: 'Add to my plan' }).click();
  await expect(page.getByRole('button', { name: 'In my plan' })).toBeVisible();
}

async function organizer(
  request: APIRequestContext,
  change: { op: 'upsert' | 'delete'; id: string; patch?: Record<string, unknown> },
) {
  const snapshot = await (await request.get('/api/schedule/snapshot')).json();
  const session = snapshot.sessions.find((s: { id: string }) => s.id === change.id);
  const res = await request.post('/api/admin/changes', {
    headers: auth(),
    data: {
      changes: [
        change.op === 'delete'
          ? { op: 'delete', entity: 'session', id: change.id }
          : {
              op: 'upsert',
              entity: 'session',
              id: change.id,
              data: { ...session, ...change.patch },
            },
      ],
    },
  });
  expect(res.ok()).toBe(true);
}

async function savedCount(request: APIRequestContext, id: string) {
  const { sessions } = await (await request.get('/api/admin/stats', { headers: auth() })).json();
  return sessions.find((s: { sessionId: string }) => s.sessionId === id)?.count ?? 0;
}

test('saving works offline and syncs when back online', async ({ page, context, request }, {
  project,
}) => {
  const id = pick(project.name, 'oromet-sat', 'sastruga-sat');
  await page.goto('/schedule');
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();

  await context.setOffline(true);
  await save(page, id);
  await page.getByRole('link', { name: 'My plan' }).click();
  await expect(page.locator('.plan-item')).toHaveCount(1);
  await expect(page.locator('.plan-status')).toContainText('will sync when you');
  expect(await savedCount(request, id)).toBe(0);

  await context.setOffline(false);
  await expect(page.locator('.plan-status')).toBeHidden({ timeout: 10_000 });
  await expect.poll(() => savedCount(request, id)).toBe(1);

  // Survives a reload: it's stored on the device, not in memory.
  await page.reload();
  await expect(page.locator('.plan-item')).toHaveCount(1);
});

test('organizer changes to saved sessions are flagged and announced', async ({ page, request }, {
  project,
}) => {
  const cancelled = pick(project.name, 'glasghote-sat', 'dynja-sat');
  const removed = pick(project.name, 'creaturess-fri', 'ember-veil-fri');
  await save(page, cancelled);
  await save(page, removed);
  await page.goto('/plan');
  await expect(page.locator('.plan-item')).toHaveCount(2);

  await organizer(request, {
    op: 'upsert',
    id: cancelled,
    patch: { status: 'cancelled', note: 'Cancelled: van broke down' },
  });
  await expect(page.locator('.change-toast')).toContainText('Cancelled', { timeout: 5000 });
  await expect(page.locator('.plan-flag[data-status="cancelled"]')).toContainText('van broke down');

  await organizer(request, { op: 'delete', id: removed });
  const orphan = page.locator('.plan-item[data-orphan]');
  await expect(orphan).toContainText('The organizers removed this session', { timeout: 5000 });
  await orphan.getByRole('button', { name: 'Remove from my plan' }).click();
  await expect(orphan).toHaveCount(0);
  await expect(page.locator('.plan-item')).toHaveCount(1);
});

test('overlapping saved sessions are flagged as clashes', async ({ page }, { project }) => {
  // Both start Friday 3:00 PM on different stages.
  const [a, b] =
    project.name === 'phone'
      ? ['gethen-fri', 'holy-death-animal-slaughter-workshop-fri']
      : ['holy-death-animal-slaughter-workshop-fri', 'gethen-fri'];
  await save(page, a);
  await save(page, b);
  await page.goto('/plan');
  await expect(page.locator('.plan-flag[data-clash]')).toHaveCount(2);
  await expect(page.locator('.plan-flag[data-clash]').first()).toContainText('Clashes with');
});

test('the plan exports as a calendar file', async ({ page }, { project }) => {
  await save(page, pick(project.name, 'novemthree-sun', 'john-haughm-sun'));
  await page.goto('/plan');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Add to calendar (.ics)' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('my-festival-plan.ics');
  const ics = readFileSync((await download.path())!, 'utf8');
  expect(ics).toContain('BEGIN:VCALENDAR');
  expect(ics).toMatch(/SUMMARY:(Novemthree|John Haughm)/);
});
