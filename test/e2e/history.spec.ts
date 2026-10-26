import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from './board';

/**
 * The whole of T46 in a real browser, against the real board: a check is asked for from the
 * page and handed to a waiting runner; the agent's report arrives; a recommendation is accepted
 * and applied through the editor and its diff; the version it makes is in the list; an older
 * version is restored. The new dialogs pass the accessibility check.
 */
const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';

test('check, decide, apply, save and restore, from the page', async ({ page, board }) => {
  await board.api('/api/v1/tasks', {
    method: 'POST',
    body: {
      title: 'Extract the git adapter',
      status: 'done',
      body: 'The parser lives in `src/git.ts`.\n\nAcceptance: it is tested.\n',
      labels: ['refactor'],
    },
  });
  const runner = await board.waitForRun();
  await page.goto(board.url);

  await page.getByRole('button', { name: 'Extract the git adapter' }).click();
  const details = page.getByRole('complementary', { name: 'Task T1' });
  await expect(details.getByLabel('Version', { exact: true })).toHaveValue('current');

  // 1. Check actuality, for a task in any status: the runner is handed a check.
  await details.getByRole('button', { name: 'Check actuality' }).click();
  expect(await runner.request).toEqual({
    type: 'run.requested',
    taskId: 'T1',
    agent: 'claude-code',
    kind: 'check',
  });
  await expect(details.getByText('A check of T1 was handed to Claude Code.')).toBeVisible();

  // 2. The runner begins it and the agent reports; the page follows the stream.
  await board.api('/api/v1/tasks/T1/checks', {
    method: 'POST',
    body: { agent: 'claude-code', sessionId: SESSION },
  });
  await board.api('/api/v1/tasks/T1/checks/1/report', {
    method: 'POST',
    body: {
      agent: 'claude-code',
      verdict: 'partly-outdated',
      summary: 'The parser moved.',
      findings: [
        {
          id: 'f1',
          title: 'The adapter was moved',
          explanation: 'It lives in src/server/git now.',
          evidence: [{ kind: 'file', ref: 'src/server/git/reader.ts' }],
        },
      ],
      recommendations: [
        {
          id: 'r1',
          findings: ['f1'],
          text: 'Update the path.',
          edit: { field: 'body', find: 'src/git.ts', replace: 'src/server/git/reader.ts' },
        },
        { id: 'r2', findings: [], text: 'Ask whether the acceptance line still holds.' },
      ],
    },
  });
  await details.getByRole('button', { name: 'Open T1-C1' }).click();
  const report = page.getByRole('dialog', { name: 'Check T1-C1' });
  await expect(report.getByText('The parser moved.')).toBeVisible();
  const reportAxe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(reportAxe.violations.map((violation) => violation.id)).toEqual([]);

  // 3. One recommendation is accepted; the other is advice and only read.
  await report.getByRole('button', { name: 'Accept r1' }).click();
  await expect(report.getByText('Accepted')).toBeVisible();
  const decided = (await board.api('/api/v1/tasks/T1/checks/1')) as {
    decisions: { recommendation: string; decision: string }[];
  };
  expect(decided.decisions).toMatchObject([{ recommendation: 'r1', decision: 'accepted' }]);

  // 4. Apply: the editor holds the draft, the diff shows it, and nothing is saved before Save.
  await report.getByRole('button', { name: 'Apply accepted' }).click();
  const editor = page.getByRole('dialog', { name: 'Apply T1-C1 to T1' });
  await expect(editor.getByLabel('Description')).toHaveValue(/src\/server\/git\/reader\.ts/);
  expect(((await board.api('/api/v1/tasks/T1')) as { body: string }).body).toContain('src/git.ts');
  await editor.getByRole('button', { name: 'Review changes' }).click();
  await expect(editor.getByRole('group', { name: 'Changes to T1' })).toContainText(
    'src/server/git/reader.ts',
  );
  const diffAxe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(diffAxe.violations.map((violation) => violation.id)).toEqual([]);
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toBeHidden();

  // 5. A new version was made, from the check; the status of the task did not move.
  await expect(details.getByLabel('Version', { exact: true })).toHaveValue('current');
  await expect(details.getByLabel('Version', { exact: true }).locator('option').first()).toHaveText(
    'v2 · Current',
  );
  const versions = (await board.api('/api/v1/tasks/T1/versions')) as {
    versions: { number: number; source: string; fromCheck?: { check: number } }[];
  };
  expect(versions.versions.map((v) => [v.number, v.source, v.fromCheck?.check])).toEqual([
    [1, 'create', undefined],
    [2, 'edit', 1],
  ]);
  expect(((await board.api('/api/v1/tasks/T1')) as { status: string }).status).toBe('done');
  // The report read v1: the task has moved on, and the list says so.
  await expect(details.getByText('Stale')).toBeVisible();

  // 6. Look at v1, and restore it.
  await details.getByLabel('Version', { exact: true }).selectOption({ label: 'v1 · historical' });
  await expect(details.getByText(/looking at v1, a historical version/)).toBeVisible();
  await expect(details.getByRole('button', { name: 'Edit' })).toBeHidden();
  await details.getByRole('button', { name: 'Restore this version' }).click();
  const confirm = page.getByRole('dialog', { name: 'Restore v1?' });
  await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .analyze()
    .then((result) => expect(result.violations.map((violation) => violation.id)).toEqual([]));
  await confirm.getByRole('button', { name: 'Restore' }).click();
  await expect(details.getByText('Restored v1 as a new version.')).toBeVisible();

  const after = (await board.api('/api/v1/tasks/T1')) as { body: string; status: string };
  expect(after.body).toContain('src/git.ts');
  expect(after.status).toBe('done');
  const final = (await board.api('/api/v1/tasks/T1/versions')) as {
    versions: { source: string; restoredFrom?: number }[];
  };
  expect(final.versions.map((v) => v.source)).toEqual(['create', 'edit', 'restore']);
  expect(final.versions[2]?.restoredFrom).toBe(1);
});

/**
 * T58 in a real browser: a research is asked for from the AI research section with the keyboard
 * alone, reaches the runner as a research with its focus, shows only once the board has it, and
 * its report is read and a recommendation rejected with a reason, all passing the accessibility
 * check.
 */
test('research from the keyboard: ask, read the report, reject with a reason', async ({
  page,
  board,
}) => {
  await board.api('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Extract the git adapter', status: 'todo', body: 'See `src/git.ts`.\n' },
  });
  const runner = await board.waitForRun();
  await page.goto(board.url);
  await page.getByRole('button', { name: 'Extract the git adapter' }).click();
  const details = page.getByRole('complementary', { name: 'Task T1' });
  const section = details.getByRole('region', { name: 'AI research' });

  await section.getByRole('button', { name: 'New research…' }).focus();
  await page.keyboard.press('Enter');
  const ask = page.getByRole('dialog', { name: 'New research on T1' });
  await expect(ask.getByLabel('Focus (optional)')).toBeFocused();
  const askAxe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(askAxe.violations.map((violation) => violation.id)).toEqual([]);
  await page.keyboard.type('Only the adapter.');
  await ask.getByRole('button', { name: 'Start research' }).focus();
  await page.keyboard.press('Enter');

  expect(await runner.request).toEqual({
    type: 'run.requested',
    taskId: 'T1',
    agent: 'claude-code',
    kind: 'research',
    comment: 'Only the adapter.',
  });
  await expect(details.getByText('A research of T1 was handed to Claude Code.')).toBeVisible();
  // Nothing is in the list until the board has the research (ADR-0025).
  await expect(section.getByRole('listitem')).toHaveCount(0);

  await board.api('/api/v1/tasks/T1/checks', {
    method: 'POST',
    body: {
      agent: 'claude-code',
      sessionId: SESSION,
      kind: 'research',
      comment: 'Only the adapter.',
    },
  });
  await expect(section.getByRole('listitem')).toContainText('Research · Working');
  await board.api('/api/v1/tasks/T1/checks/1/report', {
    method: 'POST',
    body: {
      agent: 'claude-code',
      summary: 'The adapter moved.',
      markdown: '# What I found\n\nThe adapter lives in `src/server/git` now.\n',
      findings: [],
      recommendations: [
        {
          id: 'r1',
          findings: [],
          text: 'Update the plan.',
          targets: [{ kind: 'document', name: 'plan.md' }],
        },
      ],
    },
  });
  await expect(section.getByRole('listitem')).toContainText(
    '0 accepted · 0 rejected · 1 undecided',
  );

  await section.getByRole('button', { name: 'Open T1-C1' }).focus();
  await page.keyboard.press('Enter');
  const report = page.getByRole('dialog', { name: 'Research T1-C1' });
  await expect(report.getByRole('region', { name: 'Focus' })).toContainText('Only the adapter.');
  await expect(report.getByText('Not applicable here')).toBeVisible();
  await report.getByText('Report', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(report.getByRole('heading', { name: 'What I found' })).toBeVisible();
  const reportAxe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(reportAxe.violations.map((violation) => violation.id)).toEqual([]);

  await report.getByRole('button', { name: 'Reject r1' }).focus();
  await page.keyboard.press('Enter');
  await expect(report.getByLabel('Why reject r1? (optional)')).toBeFocused();
  await page.keyboard.type('The plan is not ours.');
  await report.getByRole('button', { name: 'Confirm rejecting r1' }).focus();
  await page.keyboard.press('Enter');
  await expect(report.getByText(/The plan is not ours\./)).toBeVisible();

  const decided = (await board.api('/api/v1/tasks/T1/checks/1')) as {
    decisions: { recommendation: string; decision: string; note?: string }[];
  };
  expect(decided.decisions).toMatchObject([
    { recommendation: 'r1', decision: 'rejected', note: 'The plan is not ours.' },
  ]);
  // A research changes nothing of the task.
  expect(((await board.api('/api/v1/tasks/T1')) as { body: string }).body).toBe(
    'See `src/git.ts`.\n',
  );
  await page.keyboard.press('Escape');
  await expect(report).toBeHidden();
});
