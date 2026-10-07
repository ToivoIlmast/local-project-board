import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from './board';

/**
 * Send to AI → Claude Code in a real browser, against the real board, with a runner that waits
 * as `claude --wait` does and starts nothing (T38): the dialog is reached and used from the
 * keyboard alone, and what the runner is handed is the request of the dialog and nothing else.
 */
test('the dialog of a start of Claude Code is used from the keyboard, and the runner gets its request', async ({
  page,
  board,
}) => {
  await board.api('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Ship it', status: 'todo' },
  });
  const runner = await board.waitForRun();
  await page.goto(board.url);

  await page.getByRole('button', { name: 'Ship it' }).click();
  const details = page.getByRole('complementary', { name: 'Task T1' });
  await details.getByRole('button', { name: 'Send to AI' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Claude Code' })).toBeFocused();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Start Claude Code on T1' });
  await expect(dialog.getByLabel('Model')).toBeFocused();
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(axe.violations.map((violation) => violation.id)).toEqual([]);
  await dialog.getByLabel('Model').selectOption('sonnet');
  await expect(dialog.getByRole('option', { name: /Resume/ })).toBeDisabled();
  // The language select is enabled once the board said which language is in effect.
  await expect(dialog.getByLabel(/^Report language/)).toBeEnabled();
  await dialog.getByLabel(/^Report language/).selectOption('fi');
  await dialog.getByRole('button', { name: 'Start' }).focus();
  await page.keyboard.press('Enter');

  await expect(details.getByText(/^Claude Code is starting on T1 /)).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(details.getByRole('button', { name: 'Send to AI' })).toBeFocused();
  expect(await runner.request).toEqual({
    type: 'run.requested',
    taskId: 'T1',
    agent: 'claude-code',
    model: 'sonnet',
  });
  // The language was saved to the task, as a setting of the task.
  const task = (await board.api('/api/v1/tasks/T1')) as { workflow?: unknown };
  expect(task.workflow).toEqual({ reportLanguage: 'fi' });
});
