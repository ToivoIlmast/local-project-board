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

test('the board is stopped and started again while the page stays open', async ({
  page,
  board,
}) => {
  await board.api('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Already on the board', status: 'todo' },
  });
  await page.goto(board.url);
  await expect(page.getByText('Already on the board')).toBeVisible();

  // One change through the page first: from here on it holds a token of this run, and that
  // token is what the restart below invalidates.
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByLabel('Title').fill('Written before the stop');
  await page.getByRole('dialog').getByLabel('Status').selectOption('todo');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('complementary', { name: 'Task T2' })).toBeVisible();

  await board.stop();

  // The stream is gone and the page says so, in the one place that can only mean the stream.
  // It keeps showing what it last knew: no blank screen, nothing pretending to be current.
  await expect(page.getByText(/Live updates are off/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('Already on the board')).toBeVisible();

  // A change attempted now fails in the open instead of looking as though it worked.
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByLabel('Title').fill('Written while the board was down');
  await page.getByRole('dialog').getByLabel('Status').selectOption('todo');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(/not answering/);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('region', { name: /^todo \(2\)/ })).toBeVisible();

  // The board comes back on the same port, and another process changes it meanwhile.
  await board.restart();
  await board.api('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Created while the page waited', status: 'todo' },
  });

  // The browser reconnects the stream on its own. There is no event log (§14), so the page
  // recovers by reading the whole board again.
  await expect(page.getByText('Created while the page waited')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Live updates are off/)).toHaveCount(0);
  await expect(page.getByText(/is not answering/)).toHaveCount(0);

  // Changes work again, although the token this page was given died with the old process:
  // the board answers 401 once, the page asks for the current token and sends it (ADR-0008).
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByLabel('Title').fill('Written after the restart');
  await page.getByRole('dialog').getByLabel('Status').selectOption('todo');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('complementary', { name: 'Task T4' })).toBeVisible();

  const tasks = (await board.api('/api/v1/tasks')) as { id: string; title: string }[];
  expect(tasks.map((task) => task.title)).toEqual([
    'Already on the board',
    'Written before the stop',
    'Created while the page waited',
    'Written after the restart',
  ]);
});

test('a task opened while the board is down gets its documents when the board is back', async ({
  page,
  board,
}) => {
  await board.api('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Opened in the dark', status: 'todo' },
  });
  await board.api('/api/v1/tasks/T1/documents/plan.md', {
    method: 'PUT',
    body: { content: '# Plan\n' },
  });
  await page.goto(board.url);
  await expect(page.getByText('Opened in the dark')).toBeVisible();

  await board.stop();
  await expect(page.getByText(/Live updates are off/)).toBeVisible();

  // The person opens the task now, so the page has to read its documents from a board that
  // is not there. It says so, in the panel where the documents would be.
  await page.getByRole('button', { name: 'Opened in the dark' }).click();
  const documents = page.getByRole('region', { name: 'Documents' });
  await expect(documents.getByText(/not answering/)).toBeVisible();

  await board.restart();

  // Nothing was delivered while the stream was down, so the page reads the board again, and
  // that has to include what the open panel asked for and never got.
  await expect(documents.getByRole('button', { name: 'plan.md', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/Live updates are off/)).toHaveCount(0);
  await expect(page.getByText(/is not answering/)).toHaveCount(0);
  await expect(documents.getByText('Loading documents…')).toHaveCount(0);
});
