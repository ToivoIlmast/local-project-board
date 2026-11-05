import { expect, test } from './board';

test('topics are made, changed and filtered by, and the address bar keeps the view across a reload', async ({
  page,
  board,
}) => {
  await board.api('/api/v1/topics', { method: 'POST', body: { title: 'M1 Core' } });
  await board.api('/api/v1/topics', { method: 'POST', body: { title: 'M2 Rollout' } });
  await board.api('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'In M1', status: 'todo', topic: 'P1' },
  });
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Loose', status: 'todo' } });

  await page.goto(board.url);
  const filter = page.getByLabel('Topic', { exact: true });
  await expect(page.getByRole('region', { name: /^todo \(2\)/ })).toBeVisible();

  await filter.selectOption('none');
  await expect(page.getByRole('region', { name: /^todo \(1\)/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Loose', exact: true })).toBeVisible();

  // A reload keeps the filter, and the panel.
  await filter.selectOption('P1');
  await page.getByRole('button', { name: 'Topics' }).click();
  await page.reload();
  await expect(filter).toHaveValue('P1');
  await expect(page.getByRole('button', { name: 'In M1', exact: true })).toBeVisible();
  const panel = page.getByRole('complementary', { name: 'Topics' });
  await expect(panel).toBeVisible();

  // Create with the keyboard: the form opens on its title.
  await panel.getByRole('button', { name: 'New topic' }).click();
  await expect(panel.getByLabel('Title')).toBeFocused();
  await page.keyboard.type('M3 Launch');
  await page.keyboard.press('Enter');
  await expect(panel.getByText('M3 Launch')).toBeVisible();
  await expect(panel.getByLabel('Title')).toHaveCount(0);
  expect(((await board.api('/api/v1/topics')) as { id: string }[]).map((t) => t.id)).toEqual([
    'P1',
    'P2',
    'P3',
  ]);

  // An empty topic is deleted; the one with a task is refused and stays.
  await panel.getByRole('button', { name: 'Delete P3' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(panel.getByText('M3 Launch')).toHaveCount(0);

  await panel.getByRole('button', { name: 'Delete P1' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('not empty');
  await page.keyboard.press('Escape');
  await expect(panel.getByText('M1 Core')).toBeVisible();

  // Deleting the topic the board is filtered by returns the board to All.
  await filter.selectOption('P2');
  await panel.getByRole('button', { name: 'Delete P2' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(filter).toHaveValue('');
  await expect(page.getByRole('region', { name: /^todo \(2\)/ })).toBeVisible();
});
