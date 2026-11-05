import type { Page } from '@playwright/test';
import { expect, test } from './board';

const view = (page: Page) => page.getByRole('region', { name: 'Blocks', exact: true });
const trigger = (page: Page, id: string) =>
  page.getByRole('button', { name: `Block ${id} actions` });
const headings = (page: Page) =>
  view(page).getByRole('region', { name: 'P1 · M1 Core' }).getByRole('heading', { level: 4 });

test('the Blocks View is a main view; its blocks are renamed, added, moved and deleted with the keyboard', async ({
  page,
  board,
}) => {
  await board.api('/api/v1/topics', { method: 'POST', body: { title: 'M1 Core' } });
  for (const title of ['Design', 'Build', 'Review']) {
    await board.api('/api/v1/topics/P1/blocks', { method: 'POST', body: { title } });
  }
  await board.api('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Sketch', status: 'todo', topic: 'P1', block: 'K1' },
  });
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Loose', status: 'todo' } });

  // The view is in the address: it is there after a reload, with the panel beside it.
  await page.goto(`${board.url}?view=blocks&panel=git`);
  await expect(view(page)).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Git' })).toBeVisible();
  await expect(page.getByRole('region', { name: /^todo \(/ })).toHaveCount(0);
  await page.reload();
  await expect(view(page)).toBeVisible();
  const switcher = page.getByRole('navigation', { name: 'View' });
  await expect(switcher.getByRole('button', { name: 'Blocks' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(view(page).getByRole('region', { name: 'No block' })).toContainText('Loose');

  // Rename with the keyboard: the menu opens on Enter, the form on its title, Enter saves.
  await trigger(page, 'K2').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByLabel('Title')).toBeFocused();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Make');
  await page.keyboard.press('Enter');
  await expect(headings(page)).toHaveText(['K1 · Design', 'K2 · Make', 'K3 · Review']);
  await expect(trigger(page, 'K2')).toBeFocused();

  // Add: at the end of the topic.
  await trigger(page, 'K1').click();
  await page.getByRole('button', { name: 'Add block', exact: true }).click();
  await page.keyboard.type('Ship');
  await page.keyboard.press('Enter');
  await expect(headings(page)).toHaveText(['K1 · Design', 'K2 · Make', 'K3 · Review', 'K4 · Ship']);

  // Move to position, by the selector alone; the board has the order, and so does a reload.
  await trigger(page, 'K1').click();
  await page.getByRole('button', { name: 'Move to position', exact: true }).click();
  await page.getByLabel('Position').selectOption('3');
  await page.getByRole('dialog').getByRole('button', { name: 'Move', exact: true }).click();
  await expect(headings(page)).toHaveText(['K2 · Make', 'K3 · Review', 'K1 · Design', 'K4 · Ship']);
  await page.reload();
  await expect(headings(page)).toHaveText(['K2 · Make', 'K3 · Review', 'K1 · Design', 'K4 · Ship']);
  const topic = (await board.api('/api/v1/topics')) as { blocks: { id: string }[] }[];
  expect(topic[0]?.blocks.map((b) => b.id)).toEqual(['K2', 'K3', 'K1', 'K4']);

  // Delete: a block with a task is refused and stays; an empty one is asked about, then goes.
  await trigger(page, 'K1').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('not empty');
  await page.keyboard.press('Escape');
  await expect(trigger(page, 'K1')).toBeFocused();

  await trigger(page, 'K4').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(headings(page)).toHaveText(['K2 · Make', 'K3 · Review', 'K1 · Design']);
  await expect(page.locator(':focus')).toHaveCount(1);
  await expect(page.locator('body')).not.toBeFocused();

  // The Board and the Blocks switch keeps what else is in the address.
  await switcher.getByRole('button', { name: 'Board' }).click();
  await expect(page.getByRole('region', { name: /^todo \(/ })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('panel')).toBe('git');
});

test('a change made elsewhere is on the Blocks View without a reload', async ({ page, board }) => {
  await board.api('/api/v1/topics', { method: 'POST', body: { title: 'M1 Core' } });
  await board.api('/api/v1/topics/P1/blocks', { method: 'POST', body: { title: 'Design' } });
  await page.goto(`${board.url}?view=blocks`);
  await expect(headings(page)).toHaveText(['K1 · Design']);

  await board.api('/api/v1/topics/P1/blocks', { method: 'POST', body: { title: 'Remote' } });
  await board.api('/api/v1/topics/P1/blocks/K1', { method: 'PATCH', body: { title: 'Renamed' } });

  await expect(headings(page)).toHaveText(['K1 · Renamed', 'K2 · Remote']);
});

test('the old panel address opens the view', async ({ page, board }) => {
  await page.goto(`${board.url}?panel=blocks`);

  await expect(view(page)).toBeVisible();
  await expect.poll(() => new URL(page.url()).search).toBe('?view=blocks');
});
