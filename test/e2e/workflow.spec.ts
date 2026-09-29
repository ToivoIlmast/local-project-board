import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './board';

const CLI = fileURLToPath(new URL('../../bin/board.js', import.meta.url));

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

test('the AI workflow settings are changed with the keyboard and are what the board stored', async ({
  page,
  board,
}) => {
  await page.goto(board.url);

  await page.getByRole('button', { name: 'Settings' }).focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('complementary', { name: 'Settings' });
  await expect(panel).toBeFocused();

  // The board group first: a checkbox with the keyboard, then the text fields, in reading order.
  const boardGroup = panel.getByRole('group', { name: 'Board' });
  await boardGroup.getByRole('checkbox', { name: 'Push' }).focus();
  await page.keyboard.press('Space');
  await expect(boardGroup.getByRole('checkbox', { name: 'Push' })).toBeChecked();
  await boardGroup.getByLabel('Check command').focus();
  await page.keyboard.type('npm test');

  // A column, through its select, without the mouse.
  await panel
    .getByRole('group', { name: 'Column backlog' })
    .getByLabel('Edit code')
    .selectOption('Off');
  await expect(
    panel.getByRole('group', { name: 'Column backlog' }).getByLabel('Push'),
  ).toHaveAccessibleDescription(/Not used while “Edit code” is off/);

  await boardGroup.getByLabel('Check command').focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByText('Saved.')).toBeVisible();

  // The board stored overrides and nothing else.
  const stored = (await board.api('/api/v1/workflow')) as Record<string, unknown>;
  expect(stored).toMatchObject({
    board: { push: true, checkCommand: 'npm test' },
    statuses: { backlog: { editCode: false } },
  });

  // A reload shows what is written.
  await page.reload();
  const again = page.getByRole('complementary', { name: 'Settings' });
  await expect(again.getByRole('checkbox', { name: 'Push' })).toBeChecked();
  await expect(again.getByLabel('Check command')).toHaveValue('npm test');
  await expect(
    again.getByRole('group', { name: 'Column backlog' }).getByLabel('Edit code'),
  ).toHaveValue('off');

  // Somebody else changes it through the API: a form with nothing unsaved follows.
  await board.api('/api/v1/workflow', {
    method: 'PUT',
    body: { board: { baseBranch: 'develop' }, statuses: {} },
  });
  await expect(again.getByLabel('Base branch')).toHaveValue('develop');
  await expect(again.getByRole('checkbox', { name: 'Push' })).not.toBeChecked();
});

test('the AI settings of a task are changed with the keyboard, and the handoff copied is what the board serves', async ({
  page,
  board,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await board.api('/api/v1/workflow', {
    method: 'PUT',
    body: { board: { push: false }, statuses: { todo: { report: false } } },
  });
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Ship it', status: 'todo' } });
  await page.goto(board.url);

  await page.getByRole('button', { name: 'Ship it' }).focus();
  await page.keyboard.press('Enter');
  const task = page.getByRole('complementary', { name: 'Task T1' });
  await expect(task).toBeFocused();
  const ai = task.getByRole('region', { name: 'AI' });

  // A task with nothing of its own is one line, and the handoff is one menu away.
  await expect(ai).toContainText('Uses the settings of column todo');
  await ai.getByRole('button', { name: 'Customize for this task' }).focus();
  await page.keyboard.press('Enter');
  await expect(ai.getByLabel('Push')).toHaveAccessibleDescription(
    'In effect: off, from the board.',
  );
  await expect(ai.getByLabel('Write a report')).toHaveAccessibleDescription(
    'In effect: off, from the column todo.',
  );

  // One setting, chosen without the mouse and saved with the keyboard.
  await ai.getByLabel('Push').focus();
  await ai.getByLabel('Push').selectOption('On');
  // A select does not submit a form: the way on is Tab, past the last setting, to Save.
  await page.keyboard.press('Tab');
  await expect(ai.getByLabel('Write a report')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(ai.getByRole('button', { name: 'Save' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(ai.getByText('Saved.')).toBeVisible();
  await expect(ai.getByLabel('Push')).toHaveAccessibleDescription('In effect: on, from this task.');

  // The task stored its override; the board and the column are what they were.
  const stored = (await board.api('/api/v1/tasks/T1')) as { workflow?: unknown };
  expect(stored.workflow).toEqual({ push: true });
  expect(await board.api('/api/v1/workflow')).toMatchObject({
    board: { push: false },
    statuses: { todo: { report: false } },
  });
  await expect(
    page.getByRole('region', { name: /^todo/ }).getByTitle('This task has AI settings of its own'),
  ).toBeVisible();

  // The handoff that is copied is the one the board serves, with this override in it.
  await ai.getByRole('button', { name: 'Send to AI' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(ai.getByText('Handoff copied to the clipboard.')).toBeVisible();
  await expect(ai.getByRole('button', { name: 'Send to AI' })).toBeFocused();
  const copied = (await page.evaluate('navigator.clipboard.readText()')) as string;
  const served = await (
    await fetch(`${board.url.replace(/\/$/, '')}/api/v1/tasks/T1/handoff`)
  ).text();
  expect(copied).toBe(served);
  expect(copied).toContain('Push your commits to the remote. _(source: this task)_');

  // Back to what the column and the board say, with one button; the focus is not lost.
  await ai.getByRole('button', { name: 'Reset to the settings of column todo' }).focus();
  await page.keyboard.press('Enter');
  await expect(ai).toContainText('Uses the settings of column todo');
  await expect(ai.getByRole('button', { name: 'Customize for this task' })).toBeFocused();
  expect(
    ((await board.api('/api/v1/tasks/T1')) as { workflow?: unknown }).workflow,
  ).toBeUndefined();

  // Somebody changes the task through the API: the block follows.
  await board.api('/api/v1/tasks/T1', { method: 'PATCH', body: { workflow: { checks: false } } });
  await expect(ai.getByLabel('Run the checks')).toHaveValue('off');
});

test('the handoff is copied from the menu of a card, and is the one the board serves', async ({
  page,
  board,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await board.api('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Ship it', status: 'todo', workflow: { push: true } },
  });
  await page.goto(board.url);

  await page.getByRole('button', { name: 'Actions for T1' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Send to AI: Copy handoff' }).focus();
  await page.keyboard.press('Enter');

  const card = page.getByRole('button', { name: 'Ship it' }).locator('xpath=ancestor::li');
  await expect(card.getByText('Handoff copied to the clipboard.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Actions for T1' })).toBeFocused();
  const copied = (await page.evaluate('navigator.clipboard.readText()')) as string;
  const served = await (
    await fetch(`${board.url.replace(/\/$/, '')}/api/v1/tasks/T1/handoff`)
  ).text();
  expect(copied).toBe(served);
  expect(copied).toContain('Push your commits to the remote. _(source: this task)_');
  // Nothing was opened by it.
  await expect(page.getByRole('complementary')).toHaveCount(0);
});

test('Send to AI → Claude Code: the click starts a session of that task in the runner, and its result comes back to the page (T27)', async ({
  page,
  board,
}) => {
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Ship it', status: 'todo' } });
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Not this', status: 'todo' } });

  // A `claude` stand-in (the real one is never run by a test). It knows only its prompt: it
  // reads the handoff at that address and reports its run through the API, as it is told there.
  const bin = join(board.root, 'fake-bin');
  await mkdir(bin);
  const log = join(board.root, 'claude-call.json');
  await writeFile(
    join(bin, 'claude'),
    [
      `#!${process.execPath}`,
      "const { writeFileSync } = require('node:fs');",
      '(async () => {',
      '  const prompt = process.argv[process.argv.length - 1];',
      '  const url = /read GET (\\S+) and follow it/.exec(prompt)[1];',
      '  const handoff = await (await fetch(url)).text();',
      `  writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), handoff }));`,
      '  const [, api, id] = /^(.*)\\/tasks\\/([^/]+)\\/handoff$/.exec(url);',
      "  const { token } = await (await fetch(api + '/session')).json();",
      '  const send = (method, path, body) => fetch(api + path, { method,',
      "    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },",
      '    body: JSON.stringify(body) });',
      '  const reportMatch = /`PATCH \\/api\\/v1(\\/tasks\\/[^`]+\\/ai-run\\/(\\d+)\\/report)`/.exec(handoff);',
      '  const reportPath = reportMatch?.[1];',
      '  if (reportPath) {',
      "    await send('PATCH', reportPath, { agent: 'claude-code', state: 'needs-review', checks: 'passed' });",
      '  } else {',
      "    const begun = await (await send('POST', '/tasks/' + id + '/ai-run',",
      "      { sessionId: '00000000-0000-0000-0000-000000000000', mode: 'new' })).json();",
      "    await send('PATCH', '/tasks/' + id + '/ai-run/' + begun.runId + '/report',",
      "      { agent: 'claude-code', state: 'needs-review', checks: 'passed' });",
      '  }',
      '})();',
      '',
    ].join('\n'),
  );
  await chmod(join(bin, 'claude'), 0o755);

  // The runner, started once by the person in a terminal of the project.
  const runner = spawn(process.execPath, [CLI, 'claude', '--wait'], {
    cwd: board.root,
    env: { ...process.env, PATH: bin, XDG_CONFIG_HOME: join(board.root, 'no-user-config') },
  });
  let printed = '';
  runner.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  runner.stderr.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  try {
    await expect.poll(() => printed, { timeout: 15_000 }).toContain('Waiting for Send to AI');

    await page.goto(board.url);
    await page.getByRole('button', { name: 'Ship it' }).click();
    const details = page.getByRole('complementary', { name: 'Task T1' });

    // From the keyboard, like the other entries of the menu.
    await details.getByRole('button', { name: 'Send to AI' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Claude Code', exact: true }).focus();
    await page.keyboard.press('Enter');

    await expect(details.getByText(/Claude Code is starting on T1/)).toBeVisible();
    await expect(details.getByRole('button', { name: 'Send to AI' })).toBeFocused();

    // The runner started `claude` with the prompt of T1, in the project, and the session read
    // the handoff of T1 from the board.
    await expect
      .poll(() => readFile(log, 'utf8').catch(() => ''), { timeout: 15_000 })
      .not.toBe('');
    const call = JSON.parse(await readFile(log, 'utf8')) as {
      argv: string[];
      cwd: string;
      handoff: string;
    };
    const address = board.url.replace(/\/$/, '').replace('localhost', '127.0.0.1');
    expect(call.argv).toHaveLength(3);
    expect(call.argv[0]).toBe('--session-id');
    expect(call.argv[2]).toBe(
      `Work on task T1 of the local board: read GET ${address}/api/v1/tasks/T1/handoff and follow it.`,
    );
    expect(call.cwd).toBe(await realpath(board.root));
    expect(call.handoff).toMatch(/^# Task T1: Ship it\n/);
    expect(call.handoff).toContain('# local-project-board API (v1)');

    // What the agent reported is on the page, without a reload.
    const reported = details.getByRole('region', { name: 'AI run' });
    await expect(reported).toBeVisible();
    await expect(reported.getByText('needs-review')).toBeVisible();

    // The token of this run is not in what the runner gave `claude`.
    const runtime = JSON.parse(
      await readFile(join(board.root, '.board', 'runtime.json'), 'utf8'),
    ) as { token: string };
    expect(JSON.stringify(call.argv) + printed).not.toContain(runtime.token);
  } finally {
    runner.kill('SIGINT');
  }
});
