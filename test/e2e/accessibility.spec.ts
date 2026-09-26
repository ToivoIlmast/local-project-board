import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './board';

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations.flatMap((violation) =>
    violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')}`),
  );
}

for (const scheme of ['light', 'dark'] as const) {
  test(`axe finds nothing on any screen of the board in the ${scheme} theme`, async ({
    page,
    board,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await board.api('/api/v1/tasks', {
      method: 'POST',
      body: {
        title: 'A task with a rather long title to see how wrapping behaves',
        status: 'todo',
        labels: ['ui', 'a11y'],
        branch: 'task/T1-a11y',
        body: 'Some **bold** text, a [link](https://example.com) and `code`.\n\n```\nconst a = 1;\n```\n',
      },
    });
    await board.api('/api/v1/tasks/T1/documents/plan.md', {
      method: 'PUT',
      body: { content: '# Plan\n\nA [link](https://example.com) in a document.\n' },
    });
    await board.api('/api/v1/reports', {
      method: 'POST',
      body: { title: 'Dependency audit', format: 'html', content: '<h1>Audit</h1>' },
    });

    // Settings with something in every state: a column that mutes the settings that need code,
    // and a board that sets a text and a status.
    await board.api('/api/v1/workflow', {
      method: 'PUT',
      body: {
        board: { push: true, checkCommand: 'npm test', finishStatus: 'done' },
        statuses: { backlog: { editCode: false }, todo: { commit: false } },
      },
    });

    const screens: [string, () => Promise<void>][] = [
      [
        'the board',
        async () => {
          await page.goto(board.url);
        },
      ],
      ['a card menu', () => page.getByRole('button', { name: 'Actions for T1' }).click()],
      [
        'a task with its documents',
        async () => {
          await page.keyboard.press('Escape');
          await page.getByRole('button', { name: /^A task with/ }).click();
          await page.getByRole('button', { name: 'plan.md', exact: true }).click();
        },
      ],
      ['the task form', () => page.getByRole('button', { name: 'Edit', exact: true }).click()],
      [
        'the delete question',
        async () => {
          await page.keyboard.press('Escape');
          await page.getByRole('button', { name: 'Delete', exact: true }).click();
        },
      ],
      [
        'the reports',
        async () => {
          await page.keyboard.press('Escape');
          await page.getByRole('button', { name: 'Reports' }).click();
          await page.getByRole('button', { name: 'Dependency audit' }).click();
        },
      ],
      ['the git panel', () => page.getByRole('button', { name: 'Git', exact: true }).click()],
      ['the AI instructions', () => page.getByRole('button', { name: 'AI instructions' }).click()],
      ['the settings', () => page.getByRole('button', { name: 'Settings' }).click()],
      [
        'a task that is not there',
        async () => {
          await page.goto(`${board.url.replace(/\/$/, '')}/?task=T99`);
        },
      ],
    ];

    for (const [name, show] of screens) {
      await show();
      await expect(page.locator('h1.header__title')).toBeVisible();
      expect(await violations(page), `${name}, ${scheme} theme`).toEqual([]);
    }
  });
}

test('the whole board can be used with the keyboard alone, and the focus is never lost', async ({
  page,
  board,
}) => {
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Seed', status: 'todo' } });
  await page.goto(board.url);
  await expect(page.getByRole('region', { name: /^todo \(1\)/ })).toBeVisible();
  const { keyboard } = page;
  const dialog = page.getByRole('dialog');
  const focus = page.locator(':focus');

  // Create: the dialog opens on its first field, so typing a title with spaces in it does not
  // press a button; Tab stays inside the dialog and wraps round.
  await page.getByRole('button', { name: 'New task' }).focus();
  await keyboard.press('Enter');
  await expect(page.getByLabel('Title')).toBeFocused();
  await keyboard.type('Reached with a keyboard');
  await expect(page.getByLabel('Title')).toHaveValue('Reached with a keyboard');
  for (const name of ['Status', 'Labels', 'Branch', 'Description', 'Cancel', 'Create', 'Close']) {
    await keyboard.press('Tab');
    await expect(dialog.locator(':focus')).toHaveAccessibleName(name);
  }
  await keyboard.press('Tab');
  await expect(page.getByLabel('Title')).toBeFocused();
  await keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();

  // Escape closes it, and the focus goes back to the button that opened it.
  await keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New task' })).toBeFocused();

  // Submit it from the keyboard. The task's panel takes the focus, so the cards of the board
  // are not between the person and the thing they just made.
  await keyboard.press('Enter');
  await keyboard.type('Reached with a keyboard');
  await page.getByRole('button', { name: 'Create' }).focus();
  await keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: 'Task T2' })).toBeFocused();

  // A card's menu gives the focus back to its button on Escape…
  await page.getByRole('button', { name: 'Actions for T2' }).focus();
  await keyboard.press('Enter');
  await keyboard.press('Tab');
  await expect(focus).toHaveAccessibleName('Open');
  await keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Actions for T2' })).toBeFocused();

  // …and after "Move to done" the focus follows the card into its new column.
  await keyboard.press('Enter');
  await page.getByRole('button', { name: 'Move to done' }).focus();
  await keyboard.press('Enter');
  await expect(page.getByRole('region', { name: /^done \(1\)/ })).toBeVisible();
  await expect(page.locator('[data-task-id="T2"] .card__title')).toBeFocused();

  // Closing the panel returns to where the person was before it opened.
  await page
    .getByRole('complementary', { name: 'Task T2' })
    .getByRole('button', { name: 'Close' })
    .focus();
  await keyboard.press('Enter');
  await expect(page.getByRole('complementary')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New task' })).toBeFocused();

  // Delete: it asks first, with the safe answer focused; Escape backs out, Enter on the
  // danger button does it.
  await page.getByRole('button', { name: 'Actions for T2' }).focus();
  await keyboard.press('Enter');
  await page.getByRole('button', { name: 'Delete', exact: true }).focus();
  await keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Actions for T2' })).toBeFocused();

  await keyboard.press('Enter');
  await page.getByRole('button', { name: 'Delete', exact: true }).focus();
  await keyboard.press('Enter');
  await dialog.getByRole('button', { name: 'Delete' }).focus();
  await keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);

  const tasks = (await board.api('/api/v1/tasks')) as { id: string }[];
  expect(tasks.map((task) => task.id)).toEqual(['T1']);
});

test('a read of the board that began before a move does not take the focus from the moved card', async ({
  page,
  board,
}) => {
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Seed', status: 'todo' } });
  await page.goto(board.url);
  await expect(page.getByRole('region', { name: /^todo \(1\)/ })).toBeVisible();

  // The page reads the whole board again after every write, and it has the answer only once
  // git has answered too. Hold git open: a read that began before the move is then still
  // open when the move is done, as on a runner where `git status` is slow.
  let held = 0;
  let answered = 0;
  let reading!: () => void;
  const started = new Promise<void>((resolve) => (reading = resolve));
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/v1/git/status', async (route) => {
    held += 1;
    reading();
    await open;
    await route.continue();
  });
  page.on('response', (response) => {
    if (response.url().endsWith('/api/v1/git/status')) answered += 1;
  });

  // An agent adds a card, and the read that follows sees it in "todo".
  await board.api('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Made by an agent', status: 'todo' },
  });
  await started;
  await expect(page.getByRole('region', { name: /^todo \(2\)/ })).toBeVisible();

  await page.getByRole('button', { name: 'Actions for T2' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Move to done' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: /^done \(1\)/ })).toBeVisible();
  await expect(page.locator('[data-task-id="T2"] .card__title')).toBeFocused();

  // The old read now finishes. What it saw is older than what the move told the page, so it
  // must not put the card back, and the card the person is on must stay where the focus is.
  release();
  await expect.poll(() => held - answered).toBe(0);
  // Two frames: whatever the answer changed has been drawn.
  await page.evaluate(
    'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))',
  );
  await expect(page.getByRole('region', { name: /^done \(1\)/ })).toBeVisible();
  await expect(page.locator('[data-task-id="T2"] .card__title')).toBeFocused();
});

test('what an agent does to the board does not take the focus out of a form', async ({
  page,
  board,
}) => {
  await page.goto(board.url);
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByLabel('Labels').focus();
  await page.keyboard.type('half typed');

  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Made by an agent' } });
  await expect(page.getByText('Made by an agent')).toBeVisible();

  await expect(page.getByLabel('Labels')).toBeFocused();
  await expect(page.getByLabel('Labels')).toHaveValue('half typed');
});
