import { expect, test } from './board';

test('a developer opens the board and works on a task', async ({ page, board }) => {
  await page.goto(board.url);

  // The board is there, with the statuses it is configured with.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: /^todo/ })).toBeVisible();
  await expect(page.getByText(/no tasks yet/i)).toBeVisible();

  // Create.
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByLabel('Title').fill('Extract the git adapter');
  await page.getByRole('dialog').getByLabel('Status').selectOption('todo');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('complementary', { name: 'Task T1' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: /^todo/ }).getByText('Extract the git adapter'),
  ).toBeVisible();

  // Edit.
  await page.getByRole('complementary').getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Title').fill('Extract the git reader');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Extract the git reader' }).first()).toBeVisible();

  // A document, written and read back as markdown.
  await page.getByRole('button', { name: 'New document' }).click();
  await page.getByLabel('File name').fill('plan.md');
  await page.getByLabel('Content').fill('# Plan\n\nMove the parser.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'plan.md', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Document plan.md' })
      .getByRole('heading', { name: 'Plan', exact: true }),
  ).toBeVisible();

  // Change the status from the panel.
  await page.getByRole('complementary').getByLabel('Status').selectOption('done');
  await expect(page.getByRole('region', { name: /^done \(1\)/ })).toBeVisible();

  // What the board shows is what the board stored.
  const tasks = (await board.api('/api/v1/tasks')) as { id: string; status: string }[];
  expect(tasks).toMatchObject([{ id: 'T1', status: 'done' }]);

  // And the page reloads into the same place, because the task is in the address.
  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Task T1' })).toBeVisible();
});

test('a card is dragged into another column and stays there', async ({ page, board }) => {
  await board.api('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Drag me', status: 'backlog' },
  });
  await page.goto(board.url);

  const card = page.locator('[data-task-id="T1"]');
  const target = page.getByRole('region', { name: /^in-progress/ });
  await expect(card).toBeVisible();

  const from = await card.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('the board did not lay out');

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 12 });
  await page.mouse.up();

  await expect(target.locator('[data-task-id="T1"]')).toBeVisible();
  // The server decided the position, and it is still there after a reload.
  await page.reload();
  await expect(page.getByRole('region', { name: /^in-progress \(1\)/ })).toBeVisible();
  const tasks = (await board.api('/api/v1/tasks')) as { status: string }[];
  expect(tasks[0]?.status).toBe('in-progress');
});

test('what another process does to the board shows up without a reload', async ({
  page,
  board,
}) => {
  await page.goto(board.url);
  await expect(page.getByText(/no tasks yet/i)).toBeVisible();

  // An agent, working through the API exactly as the instructions describe.
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Written by an agent' } });
  await expect(page.getByText('Written by an agent')).toBeVisible();

  await board.api('/api/v1/reports', {
    method: 'POST',
    body: {
      title: 'Dependency audit',
      format: 'html',
      content: '<h1>Audit</h1><p>3 outdated.</p>',
    },
  });
  await page.getByRole('button', { name: 'Reports' }).click();
  await page.getByRole('button', { name: 'Dependency audit' }).click();

  // The report renders, in a frame of its own origin (ADR-0023).
  const frame = page.frameLocator('iframe[title="Report R1"]');
  await expect(frame.getByRole('heading', { name: 'Audit' })).toBeVisible();
  await expect(page.locator('iframe[title="Report R1"]')).toHaveAttribute(
    'sandbox',
    'allow-scripts',
  );
});

test('the board hands over the instructions an agent needs, token and all', async ({
  page,
  board,
}) => {
  await page.goto(board.url);

  await page.getByRole('button', { name: 'AI instructions' }).click();
  const panel = page.getByRole('complementary', { name: 'AI instructions' });

  await expect(panel.getByText('GET /api/v1/tasks')).toBeVisible();
  await expect(panel.getByText(/Authorization: Bearer/)).toBeVisible();
  // The board never printed the token in the terminal, though (ADR-0008).
  const token = (await board.api('/api/v1/session')) as { token: string };
  expect(board.output()).not.toContain(token.token);
});
