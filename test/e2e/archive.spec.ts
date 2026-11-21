import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from './board';

/** The Archive page (T11): a task of each column goes there and comes back to its own column. */
const STATUSES = ['backlog', 'todo', 'in-progress', 'done'] as const;

test('archived tasks are on the Archive page, not on the board, and Restore brings each back', async ({
  page,
  board,
}) => {
  for (const status of STATUSES) {
    await board.api('/api/v1/tasks', { method: 'POST', body: { title: `In ${status}`, status } });
  }
  // T1..T4 in the order of the columns.
  for (const id of ['T1', 'T2', 'T3', 'T4']) {
    await board.api(`/api/v1/tasks/${id}/archive`, { method: 'POST', body: {} });
  }

  await page.goto(board.url);
  for (const status of STATUSES) {
    await expect(page.getByRole('button', { name: `In ${status}`, exact: true })).toHaveCount(0);
  }

  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page).toHaveURL(/view=archive/);
  const archive = page.getByRole('region', { name: 'Archive' });
  for (const status of STATUSES) {
    await expect(archive.getByText(`In ${status}`, { exact: true })).toBeVisible();
  }

  for (const id of ['T1', 'T2', 'T3', 'T4']) {
    await archive.getByRole('button', { name: `Restore ${id}` }).click();
  }
  await expect(page.getByText('The archive is empty')).toBeVisible();

  await page.getByRole('button', { name: 'Board' }).click();
  for (const status of STATUSES) {
    const column = page.getByRole('region', { name: new RegExp(status, 'i') }).first();
    await expect(column.getByText(`In ${status}`, { exact: true })).toBeVisible();
  }
});

test('a reload on ?view=archive stays on the page, and Back returns to the board', async ({
  page,
  board,
}) => {
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Shelved', status: 'todo' } });
  await board.api('/api/v1/tasks/T1/archive', { method: 'POST', body: {} });

  await page.goto(board.url);
  await page.getByRole('button', { name: 'Archive' }).click();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Archive' })).toBeVisible();
  await expect(page.getByText('Shelved', { exact: true })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('region', { name: 'Archive' })).toHaveCount(0);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe finds nothing on the Archive page in the ${scheme} theme`, async ({ page, board }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await board.api('/api/v1/tasks', {
      method: 'POST',
      body: { title: 'Shelved', status: 'done' },
    });
    await board.api('/api/v1/tasks/T1/archive', { method: 'POST', body: {} });

    await page.goto(`${board.url}?view=archive`);
    await expect(page.getByText('Shelved', { exact: true })).toBeVisible();

    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });
}
