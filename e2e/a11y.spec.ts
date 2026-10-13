import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Automated accessibility checks (WCAG 2.1 A and AA) on every screen, in both color schemes.
// Automated checks catch roughly a third of real problems; see PLAN.md §6 for the manual checks.

const screens: Array<[name: string, path: string, prepare?: (page: Page) => Promise<void>]> = [
  ['schedule (list)', '/schedule/2026-06-20?now=2026-06-20T20:40'],
  [
    'schedule (by stage)',
    '/schedule/2026-06-20?now=2026-06-20T20:40',
    async (page) => {
      await page.getByRole('button', { name: 'By stage' }).click();
    },
  ],
  ['lineup', '/lineup'],
  ['session detail', '/session/the-four-pillars-of-norse-magic-sat'],
  [
    'my plan',
    '/session/emma-ruth-rundle-sat',
    async (page) => {
      await page.getByRole('button', { name: 'Add to my plan' }).click();
      await page.getByRole('link', { name: 'My plan' }).click();
      await expect(page.locator('.plan-item')).toHaveCount(1);
    },
  ],
  ['updates', '/updates'],
  ['vendors', '/vendors'],
  ['settings', '/settings'],
];

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });
    for (const [name, path, prepare] of screens) {
      test(`${name} has no detectable WCAG A/AA violations`, async ({ page }) => {
        await page.goto(path);
        await expect(page.locator('main')).not.toBeEmpty();
        await prepare?.(page);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        const summary = results.violations.map((v) => ({
          rule: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')}: ${n.failureSummary}`),
        }));
        expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
      });
    }
  });
}

test('keyboard users can reach the main navigation, and focus follows navigation', async ({
  page,
}, { project }) => {
  test.skip(project.name === 'phone', 'keyboard navigation is a desktop concern');
  await page.goto('/schedule');
  await expect(page.locator('main')).not.toBeEmpty();
  // The skip link is the first stop.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();

  // Tab to "Lineup" in the main navigation and activate it with Enter.
  const lineup = page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Lineup' });
  for (let i = 0; i < 10 && !(await lineup.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(lineup).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Lineup', level: 1 })).toBeVisible();
  // Focus moved into the new page, not left on the old link.
  await expect(page.locator('main')).toBeFocused();
});
