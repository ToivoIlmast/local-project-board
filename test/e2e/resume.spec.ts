import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from './board';

/**
 * A run that failed, recovered from the page (T39), against the real board with a runner that
 * waits as `claude --wait` does and starts nothing: the block of the run says why it ended, and
 * Resume reaches the runner as a request for the session of that run.
 */
const SESSION = '0b5c0a1e-6c9b-4b8e-9c55-8f1d2a3b4c5d';

test('a failed run is resumed from the page, and the runner is asked to continue its session', async ({
  page,
  board,
}) => {
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Ship it', status: 'todo' } });
  // What a runner does when `claude` ends without a word: begin, then end with a code.
  await board.api('/api/v1/tasks/T1/ai-run', {
    method: 'POST',
    body: { sessionId: SESSION, mode: 'new', model: 'sonnet' },
  });
  await board.api('/api/v1/tasks/T1/ai-run/1/end', {
    method: 'POST',
    body: { exitCode: 3, sessionId: SESSION },
  });
  const runner = await board.waitForRun();
  await page.goto(board.url);

  await page.getByRole('button', { name: 'Ship it' }).click();
  const details = page.getByRole('complementary', { name: 'Task T1' });
  const block = details.getByRole('region', { name: 'AI run' });
  await expect(block.getByRole('alert')).toHaveText(
    'The session ended without a final report (code 3).',
  );
  const axe = await new AxeBuilder({ page }).include('[aria-labelledby="ai-run-T1"]').analyze();
  expect(axe.violations.map((violation) => violation.id)).toEqual([]);

  await block.getByRole('button', { name: 'Resume' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start Claude Code on T1' });
  await expect(dialog.getByLabel('Session')).toHaveValue('resume');
  await dialog.getByRole('button', { name: 'Start' }).click();

  await expect(block.getByText(/^Claude Code is starting on T1 /)).toBeVisible();
  expect(await runner.request).toEqual({
    type: 'run.requested',
    taskId: 'T1',
    agent: 'claude-code',
    model: 'sonnet',
    mode: 'resume',
  });
});
