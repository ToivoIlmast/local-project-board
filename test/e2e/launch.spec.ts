import { AxeBuilder } from '@axe-core/playwright';
import { fakeClaude } from '../support/fakeClaude.js';
import { cleanTmpDirs } from '../support/tmp.js';
import { expect, test, taskDetails } from './board';

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
  const details = taskDetails(page, 'Task T1');
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

  await expect(details.getByText(/^Sent T1 to the runner /)).toBeVisible();
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

test.afterAll(cleanTmpDirs);

/**
 * The comment of the dialog end to end (T9), with the real runner (`claude --wait`) and a
 * `claude` stand-in that reads its handoff: the comment reaches begin, then the handoff of the
 * run that works, and is shown with that run; never the command line, never the task.
 */
test('the comment of the dialog reaches begin and the handoff of the run, and the task is left as it was (T9)', async ({
  page,
  board,
}) => {
  const COMMENT = 'Keep the public API.\nTouch only the dialog.';
  await board.api('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Ship it', status: 'todo', body: 'The description.' },
  });
  const claude = await fakeClaude();
  const runner = board.spawnRunner(['claude', '--wait'], claude.env({ agent: true }));
  await expect
    .poll(() => runner.printed(), { timeout: 15_000 })
    .toContain('Waiting for Send to AI');
  await page.goto(board.url);

  await page.getByRole('button', { name: 'Ship it' }).click();
  const details = taskDetails(page, 'Task T1');
  await details.getByRole('button', { name: 'Send to AI' }).click();
  await page.getByRole('button', { name: 'Claude Code' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start Claude Code on T1' });
  await dialog.getByLabel('Comment (optional)').fill(COMMENT);
  await dialog.getByRole('button', { name: 'Start' }).click();

  const run = details.getByRole('region', { name: 'AI run' });
  await expect(run.getByText('finished', { exact: true })).toBeVisible({ timeout: 15_000 });
  // Begin wrote the comment into the run, and the run shows it as it was typed.
  const task = (await board.api('/api/v1/tasks/T1')) as {
    body: string;
    aiRun?: { comment?: string };
  };
  expect(task.aiRun?.comment).toBe(COMMENT);
  await expect(run.getByRole('region', { name: 'Comment' })).toContainText(
    'Touch only the dialog.',
  );
  // The handoff the agent read while the run worked holds the comment, after the description.
  const read = (await claude.reads()).find(({ url }) => url.endsWith('/tasks/T1/handoff'));
  expect(read?.handoff).toContain('## Comment from the person');
  expect(read?.handoff).toContain(`\`\`\`text\n${COMMENT}\n\`\`\``);
  expect(read?.handoff.indexOf('## Description')).toBeLessThan(
    read?.handoff.indexOf('## Comment from the person') ?? -1,
  );
  // Not on the command line of `claude`, and not in the task.
  const calls = await claude.calls();
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls.map(({ argv }) => argv))).not.toContain('Keep the public API.');
  expect(task.body).toBe('The description.');
});
