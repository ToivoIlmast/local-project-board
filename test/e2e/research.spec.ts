import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeClaude } from '../support/fakeClaude.js';
import { cleanTmpDirs } from '../support/tmp.js';
import { expect, test, type RunningBoard } from './board';

/**
 * The AI Research Workflow end to end (T60, §9.1 items 25–26 of the research): the real board,
 * the real runner (`claude --wait`) and a `claude` stand-in that acts on its prompt alone. Two
 * researches of one task, decided on and applied from the page; the board is restarted while the
 * second session is still open; then the work itself is sent to AI. What a research reported
 * stays as it was through all of it.
 */

const CLI = fileURLToPath(new URL('../../bin/board.js', import.meta.url));

interface Check {
  begin: { number: number; kind?: string; comment?: string; version: number };
  report?: { summary: string; recommendations: { id: string }[] };
  decisions: { recommendation: string; decision: string; note?: string }[];
  end?: { exitCode?: number };
  state: string;
}

const FIRST = {
  agent: 'claude-code',
  summary: 'The adapter moved; the plan needs one path fixed.',
  markdown: '# What I found\n\nThe adapter lives in `src/server/git` now.\n',
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
      text: 'Point the task at the new path.',
      edit: { field: 'body', find: 'src/git.ts', replace: 'src/server/git/reader.ts' },
    },
    {
      id: 'r2',
      findings: [],
      text: 'Split the task in two.',
      targets: [{ kind: 'task' }],
    },
  ],
};

const SECOND = {
  agent: 'claude-code',
  summary: 'Nothing more to change.',
  markdown: '# Second look\n\nThe task is ready as it is.\n',
  findings: [],
  recommendations: [],
};

const REASON = 'One task is enough here.';
const FOCUS = 'Only the adapter, as of the new path.';

const check = async (board: RunningBoard, n: number): Promise<Check> =>
  (await board.api(`/api/v1/tasks/T1/checks/${n}`)) as Check;

/** The text of a research's report, as the board serves it (no token needed to read). */
const reportText = async (board: RunningBoard, n: number): Promise<string> => {
  const response = await fetch(
    `${board.url.replace(/\/$/, '')}/api/v1/tasks/T1/checks/${n}/report.md`,
  );
  expect(response.status).toBe(200);
  return response.text();
};

function startRunner(
  root: string,
  env: NodeJS.ProcessEnv,
): { child: ChildProcess; printed: () => string } {
  const child = spawn(process.execPath, [CLI, 'claude', '--wait'], {
    cwd: root,
    env: { ...process.env, ...env, XDG_CONFIG_HOME: join(root, 'no-user-config') },
  });
  let printed = '';
  child.stdout?.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  return { child, printed: () => printed };
}

/** How many times the runner said it waits: once per connection to the board. */
const waits = (printed: string): number => printed.split('Waiting for Send to AI').length - 1;

test.afterAll(cleanTmpDirs);

test('two researches, decided and applied from the page, a restart, then the work: the reports stay as they were', async ({
  page,
  board,
}) => {
  test.setTimeout(120_000);
  await board.api('/api/v1/tasks', {
    method: 'POST',
    body: {
      title: 'Extract the git adapter',
      status: 'todo',
      body: 'The parser lives in `src/git.ts`.\n',
    },
  });
  const reports = join(board.root, 'fake-reports');
  await mkdir(reports);
  await writeFile(join(reports, '1.json'), JSON.stringify(FIRST));
  await writeFile(join(reports, '2.json'), JSON.stringify(SECOND));
  // The second session stays open after its report, until the board has been restarted.
  await writeFile(join(reports, '2.hold'), '');

  const claude = await fakeClaude();
  const runner = startRunner(board.root, claude.env({ agent: 'research', reports }));
  try {
    await expect.poll(() => waits(runner.printed()), { timeout: 15_000 }).toBe(1);
    await page.goto(board.url);
    await page.getByRole('button', { name: 'Extract the git adapter' }).click();
    const details = page.getByRole('complementary', { name: 'Task T1' });
    const section = details.getByRole('region', { name: 'AI research' });
    const items = section.getByRole('listitem');

    // 1. Research #1, without a focus: the runner starts it and the agent reports r1 and r2.
    await section.getByRole('button', { name: 'New research…' }).click();
    await page
      .getByRole('dialog', { name: 'New research on T1' })
      .getByRole('button', { name: 'Start research' })
      .click();
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Research · Reported');
    await expect(items.first()).toContainText('0 accepted · 0 rejected · 2 undecided');
    // The session ended and the runner waits again before the next one is asked for.
    await expect.poll(async () => (await check(board, 1)).end, { timeout: 15_000 }).toBeDefined();
    await expect.poll(() => waits(runner.printed()), { timeout: 15_000 }).toBe(2);
    const first = await check(board, 1);
    const firstText = await reportText(board, 1);
    expect(first.begin).toMatchObject({ kind: 'research', version: 1 });
    expect(firstText).toBe(FIRST.markdown);

    // 2. Accept r1 and apply it: v2, from the research. Nothing is written before Save.
    await section.getByRole('button', { name: 'Open T1-C1' }).click();
    const report = page.getByRole('dialog', { name: 'Research T1-C1' });
    await report.getByRole('button', { name: 'Accept r1' }).click();
    await expect(report.getByRole('button', { name: 'Accept r1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await report.getByRole('button', { name: 'Apply accepted' }).click();
    const editor = page.getByRole('dialog', { name: 'Apply T1-C1 to T1' });
    await expect(editor.getByLabel('Description')).toHaveValue(/src\/server\/git\/reader\.ts/);
    expect(((await board.api('/api/v1/tasks/T1')) as { body: string }).body).toContain(
      'src/git.ts',
    );
    await editor.getByRole('button', { name: 'Review changes' }).click();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toBeHidden();
    await expect(
      details.getByLabel('Version', { exact: true }).locator('option').first(),
    ).toHaveText('v2 · Current');

    // 3. Reject r2, with a reason. Apply closed the report; it is opened again, now stale.
    await section.getByRole('button', { name: 'Open T1-C1' }).click();
    await report.getByRole('button', { name: 'Reject r2' }).click();
    await report.getByLabel('Why reject r2? (optional)').fill(REASON);
    await report.getByRole('button', { name: 'Confirm rejecting r2' }).click();
    await expect(report.getByText(REASON)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(report).toBeHidden();
    const decided = await check(board, 1);
    expect(decided.decisions).toMatchObject([
      { recommendation: 'r1', decision: 'accepted' },
      { recommendation: 'r2', decision: 'rejected', note: REASON },
    ]);

    // 4. Research #2 with a focus: it is pinned to v2 and its handoff holds v2, the focus, and
    //    what became of #1, the reason for r2 included.
    await section.getByRole('button', { name: 'New research…' }).click();
    const ask = page.getByRole('dialog', { name: 'New research on T1' });
    await ask.getByLabel('Focus (optional)').fill(FOCUS);
    await ask.getByRole('button', { name: 'Start research' }).click();
    await expect(items).toHaveCount(2);
    await expect(
      section.getByRole('listitem').filter({ hasText: 'Research · Reported · v2' }),
    ).toHaveCount(1);
    const second = await check(board, 2);
    expect(second.begin).toMatchObject({ kind: 'research', version: 2, comment: FOCUS });
    expect(second.end).toBeUndefined();

    const read = (await claude.reads()).find(({ url }) =>
      url.endsWith('/tasks/T1/checks/2/handoff'),
    );
    expect(read?.handoff).toContain('as of version v2 of the task');
    expect(read?.handoff).toContain('src/server/git/reader.ts');
    expect(read?.handoff).toContain(`\`\`\`text\n${FOCUS}\n\`\`\``);
    expect(read?.handoff).toContain('- r1: accepted, applied in v2');
    expect(read?.handoff).toContain(`- r2: rejected, note: ${JSON.stringify(REASON)}`);
    // The focus went to the board through the begin, never to the command line of `claude`.
    const calls = await claude.calls();
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls.map(({ argv }) => argv))).not.toContain(FOCUS);

    // 5. The board is stopped while session #2 is still open; the session ends meanwhile; the
    //    board comes back, and the runner delivers the end it kept.
    await board.stop();
    await rm(join(reports, '2.hold'));
    await expect
      .poll(() => runner.printed(), { timeout: 15_000 })
      .toContain('The session on T1 ended');
    await board.restart();
    await expect
      .poll(async () => (await check(board, 2)).end, { timeout: 30_000 })
      .toEqual(expect.objectContaining({ exitCode: 0 }));
    // History, reports and decisions are where they were.
    expect(await check(board, 1)).toEqual(decided);
    expect(await reportText(board, 1)).toBe(firstText);
    const secondText = await reportText(board, 2);
    expect(secondText).toBe(SECOND.markdown);
    const versions = (await board.api('/api/v1/tasks/T1/versions')) as {
      versions: { number: number; source: string; fromCheck?: { check: number } }[];
    };
    expect(versions.versions.map((v) => [v.number, v.source, v.fromCheck?.check])).toEqual([
      [1, 'create', undefined],
      [2, 'edit', 1],
    ]);
    await expect.poll(() => waits(runner.printed()), { timeout: 15_000 }).toBe(3);

    // 6. #1 and its report open as they were, on the page that stayed open.
    await expect(items).toHaveCount(2, { timeout: 30_000 });
    await section.getByRole('button', { name: 'Open T1-C1' }).click();
    await expect(report.getByText(FIRST.summary)).toBeVisible();
    await expect(report.getByText(REASON)).toBeVisible();
    await report.getByText('Report', { exact: true }).click();
    await expect(report.getByRole('heading', { name: 'What I found' })).toBeVisible();
    await page.keyboard.press('Escape');

    // 7. The work, sent to AI apart: a run of the task, not a research. The agent writes the
    //    document report.md of the task; the reports of the researches are not touched.
    await details.getByRole('button', { name: 'Send to AI' }).click();
    await page.getByRole('button', { name: 'Claude Code', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Start Claude Code on T1' })
      .getByRole('button', { name: 'Start' })
      .click();
    const run = details.getByRole('region', { name: 'AI run' });
    await expect(run.getByText('finished', { exact: true })).toBeVisible({ timeout: 15_000 });
    const work = (await claude.calls()).at(-1);
    expect(work?.argv.at(-1)).toMatch(
      /^Work on task T1 of the local board: read GET \S+\/tasks\/T1\/handoff /,
    );

    expect(await check(board, 1)).toEqual(decided);
    expect(await check(board, 2)).toMatchObject({ report: { summary: SECOND.summary } });
    expect(await reportText(board, 1)).toBe(firstText);
    expect(await reportText(board, 2)).toBe(secondText);
    expect((await board.api('/api/v1/tasks/T1/checks')) as unknown[]).toHaveLength(2);
    const after = (await board.api('/api/v1/tasks/T1/versions')) as { versions: unknown[] };
    expect(after.versions).toHaveLength(2);
  } finally {
    runner.child.kill('SIGINT');
  }
});
