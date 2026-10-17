import { screen, waitFor, within } from '@testing-library/react';
import { contentHash } from '../../../src/contract/v1/index';
import { ApiError } from '../../../src/web/api/index';
import { aCheck, aTask } from '../support/fixtures';
import { renderBoard } from '../support/render';

/**
 * The history of a task in its panel (T46, ADR-0030): the version select, the historical view,
 * restore, the diff before a save, and the checks with their reports and decisions.
 */

const dialog = () => screen.getByRole('dialog');
const panel = () => screen.getByRole('complementary', { name: /^Task T1$/ });

const content = (over: object = {}) => ({
  title: 'Extract the git adapter',
  body: 'See `src/git.ts` for the parser.\n',
  labels: ['refactor'],
  ...over,
});

const aTaskWithHistory = (over: object = {}) => aTask({ id: 'T1', ...content(), ...over });

/** T1 at v2 with a first version before it. */
const twoVersions = {
  T1: [
    {
      source: 'create' as const,
      changed: [],
      snapshot: content({ title: 'Extract the adapter', body: 'First text.\n', labels: [] }),
    },
    {
      source: 'edit' as const,
      changed: ['title' as const, 'body' as const, 'labels' as const],
      snapshot: content(),
    },
  ],
};

async function openTask(rendered: Awaited<ReturnType<typeof renderBoard>>) {
  await rendered.user.click(screen.getByRole('button', { name: 'Extract the git adapter' }));
  return screen.findByRole('complementary', { name: /^Task T1$/ });
}

describe('the version select', () => {
  it('has the current version first, called so, and the others historical (INVARIANT)', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()], versions: twoVersions });
    await openTask(rendered);

    const select = await within(panel()).findByLabelText('Version');
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['v2 · Current', 'v1 · historical']),
    );
    expect(select).toHaveValue('current');
  });

  it('says so when the content is not that of the latest version: changed outside history', async () => {
    const rendered = await renderBoard({
      tasks: [aTaskWithHistory({ body: 'Edited in an editor.\n' })],
      versions: twoVersions,
    });
    await openTask(rendered);

    const select = await within(panel()).findByLabelText('Version');
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['Current (changed outside history)', 'v2 · historical', 'v1 · historical']),
    );
  });

  it('is just "Current", and cannot be changed, for a task with no history yet', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()] });
    await openTask(rendered);
    const select = await within(panel()).findByLabelText('Version');
    expect(within(select).getAllByRole('option')).toHaveLength(1);
    expect(select).toBeDisabled();
  });

  it('shows a historical version without touching the task, and offers Restore in place of Edit (INVARIANT)', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()], versions: twoVersions });
    const { user, board } = rendered;
    await openTask(rendered);
    const select = await within(panel()).findByLabelText('Version');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    const before = structuredClone(board.tasks[0]);

    await user.selectOptions(select, 'v1 · historical');

    await waitFor(() =>
      expect(panel().querySelector('.panel__body')).toHaveTextContent('First text.'),
    );
    expect(within(panel()).getByRole('heading', { name: 'Extract the adapter' })).toBeVisible();
    expect(within(panel()).getByRole('status')).toHaveTextContent(
      /looking at v1, a historical version/,
    );
    expect(within(panel()).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(panel()).getByRole('button', { name: 'Restore this version' })).toBeEnabled();
    expect(board.tasks[0]).toEqual(before);
    expect(board.calls).not.toContain('updateTask');
  });

  it('goes back to the task when Current is chosen again', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()], versions: twoVersions });
    const { user } = rendered;
    await openTask(rendered);
    const select = await within(panel()).findByLabelText('Version');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(select, 'v1 · historical');
    await user.selectOptions(select, 'v2 · Current');

    expect(await within(panel()).findByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(panel().querySelector('.panel__body')).toHaveTextContent('for the parser.');
  });
});

describe('a history that cannot be read', () => {
  it('says so instead of showing an empty list, and reads it again on Try again', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()], versions: twoVersions });
    const { user, board } = rendered;
    board.fail('versions', new ApiError(0, 'NETWORK_ERROR', 'The board is not answering.'));
    await openTask(rendered);

    const versions = await within(panel()).findByRole('region', { name: 'Versions' });
    expect(await within(versions).findByRole('alert')).toHaveTextContent('not answering');
    expect(within(versions).queryByRole('listitem')).not.toBeInTheDocument();

    await user.click(within(versions).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(within(versions).queryByRole('alert')).not.toBeInTheDocument());
    expect(within(versions).getAllByRole('listitem')).toHaveLength(2);
  });

  it('takes the message away when the board answers by itself, as after a reconnect', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()], versions: twoVersions });
    const { board, store } = rendered;
    board.fail('versions', new ApiError(0, 'NETWORK_ERROR', 'The board is not answering.'));
    await openTask(rendered);
    const versions = await within(panel()).findByRole('region', { name: 'Versions' });
    expect(await within(versions).findByRole('alert')).toBeInTheDocument();

    // The page reads the whole board again, as it does when the stream comes back.
    await store.load();

    await waitFor(() => expect(within(versions).queryByRole('alert')).not.toBeInTheDocument());
    expect(within(versions).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('restoring a version', () => {
  it('asks first, says that a new version is made, and keeps the status (INVARIANT)', async () => {
    const rendered = await renderBoard({
      tasks: [aTaskWithHistory({ status: 'in-progress' })],
      versions: twoVersions,
    });
    const { user, board } = rendered;
    await openTask(rendered);
    const select = await within(panel()).findByLabelText('Version');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(select, 'v1 · historical');

    await user.click(within(panel()).getByRole('button', { name: 'Restore this version' }));
    expect(within(dialog()).getByText(/A new version is made/)).toBeInTheDocument();
    expect(board.calls).not.toContain('restoreVersion');
    await user.click(within(dialog()).getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(board.tasks[0]?.title).toBe('Extract the adapter'));
    expect(board.tasks[0]).toMatchObject({ status: 'in-progress', body: 'First text.\n' });
    expect(board.versions.get('T1')?.at(-1)).toMatchObject({ source: 'restore', restoredFrom: 1 });
    // Back on the current version, which is now the restored one.
    await waitFor(() => expect(within(panel()).getByLabelText('Version')).toHaveValue('current'));
    expect(within(panel()).getByText('Restored v1 as a new version.')).toBeInTheDocument();
  });

  it('can be cancelled without writing anything', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()], versions: twoVersions });
    const { user, board } = rendered;
    await openTask(rendered);
    const select = await within(panel()).findByLabelText('Version');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(select, 'v1 · historical');
    await user.click(within(panel()).getByRole('button', { name: 'Restore this version' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    expect(board.calls).not.toContain('restoreVersion');
  });

  it('says what the board said when the content moved on, and offers the restore again', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()], versions: twoVersions });
    const { user, board } = rendered;
    await openTask(rendered);
    const select = await within(panel()).findByLabelText('Version');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(select, 'v1 · historical');
    await user.click(within(panel()).getByRole('button', { name: 'Restore this version' }));
    board.fail(
      'restoreVersion',
      new ApiError(409, 'TASK_CONTENT_CHANGED', 'The content is no longer the one asked for.'),
    );
    await user.click(within(dialog()).getByRole('button', { name: 'Restore' }));

    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('no longer the one');
    expect(board.tasks[0]?.title).toBe('Extract the git adapter');
  });
});

describe('editing a task: the diff before the save', () => {
  async function edit(rendered: Awaited<ReturnType<typeof renderBoard>>) {
    await rendered.user.click(screen.getByRole('button', { name: 'Actions for T1' }));
    await rendered.user.click(screen.getByRole('button', { name: 'Edit' }));
  }

  it('shows the draft as a diff against the current content, with Save and Cancel (INVARIANT)', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()], versions: twoVersions });
    const { user, board } = rendered;
    await edit(rendered);
    const title = within(dialog()).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Extract the git reader');
    await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));

    const diff = within(dialog()).getByRole('group', { name: 'Changes to T1' });
    expect(within(diff).getByText(/Removed:/).parentElement).toHaveTextContent(
      'Extract the git adapter',
    );
    expect(within(diff).getByText(/Added:/).parentElement).toHaveTextContent(
      'Extract the git reader',
    );
    expect(within(dialog()).getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    // Nothing is written until Save.
    expect(board.calls).not.toContain('updateTask');
  });

  it('writes nothing when Cancel is pressed, and keeps the draft when going back', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()], versions: twoVersions });
    const { user, board } = rendered;
    await edit(rendered);
    const title = within(dialog()).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Draft title');
    await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Back to editing' }));

    expect(within(dialog()).getByLabelText('Title')).toHaveValue('Draft title');
    await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(board.calls).not.toContain('updateTask');
  });

  it('sends only the fields that were changed, with the hash of the content it was shown (INVARIANT)', async () => {
    const task = aTaskWithHistory({ branch: 'feat/x' });
    const rendered = await renderBoard({ tasks: [task], versions: twoVersions });
    const { user, board } = rendered;
    await edit(rendered);
    const title = within(dialog()).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'New title');
    await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(board.patches).toHaveLength(1));
    expect(board.patches[0]).toEqual({
      id: 'T1',
      patch: { title: 'New title', ifContentHash: contentHash(content()) },
    });
  });

  it('sends the status or the branch only when the person changed them', async () => {
    const rendered = await renderBoard({
      tasks: [aTaskWithHistory({ status: 'todo' })],
      versions: twoVersions,
    });
    const { user, board } = rendered;
    await edit(rendered);
    await user.selectOptions(within(dialog()).getByLabelText('Status'), 'done');
    await user.type(within(dialog()).getByLabelText('Branch'), 'feat/y');
    await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));

    expect(within(dialog()).getByText('Status: todo → done')).toBeInTheDocument();
    expect(within(dialog()).getByText('Branch: none → feat/y')).toBeInTheDocument();
    expect(within(dialog()).getByText(/No changes to the title/)).toBeInTheDocument();
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(board.patches).toHaveLength(1));
    expect(board.patches[0]?.patch).toEqual({
      status: 'done',
      branch: 'feat/y',
      ifContentHash: contentHash(content()),
    });
  });

  it('does not let a form with no change be saved', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()], versions: twoVersions });
    const { user } = rendered;
    await edit(rendered);
    await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
    expect(within(dialog()).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('puts the changes over what an agent did meanwhile, and says so', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()], versions: twoVersions });
    const { user, board } = rendered;
    await edit(rendered);
    const title = within(dialog()).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'My title');
    // An agent changes the body while the form is open; the page is told.
    board.tasks[0]!.body = 'The agent wrote this.\n';
    board.emit({ type: 'task.updated', task: { ...board.tasks[0]! } });
    await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));

    expect(within(dialog()).getByRole('status')).toHaveTextContent(/changed since you started/);
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(board.patches).toHaveLength(1));
    // Only the title is sent: the agent's body is not reverted by the form.
    expect(board.patches[0]?.patch).toEqual({
      title: 'My title',
      ifContentHash: contentHash(content({ body: 'The agent wrote this.\n' })),
    });
    expect(board.tasks[0]).toMatchObject({ title: 'My title', body: 'The agent wrote this.\n' });
  });

  it('keeps the draft on a 409, shows it against the new content, and saves on the second try (INVARIANT)', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()], versions: twoVersions });
    const { user, board } = rendered;
    await edit(rendered);
    const title = within(dialog()).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'My title');
    await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
    // The content moves after the diff was shown, and the page is not told in time.
    board.tasks[0]!.body = 'Written behind the page.\n';

    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      /changed while you were reviewing/,
    );
    expect(board.tasks[0]?.title).toBe('Extract the git adapter');
    // The draft is still here, now against the new content.
    const diff = within(dialog()).getByRole('group', { name: 'Changes to T1' });
    expect(diff).toHaveTextContent('My title');
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(board.tasks[0]?.title).toBe('My title'));
    expect(board.tasks[0]?.body).toBe('Written behind the page.\n');
    expect(board.patches).toHaveLength(2);
  });

  it('creates a new task at once, with no review: there is nothing to compare', async () => {
    const { user, board } = await renderBoard();
    await user.click(screen.getByRole('button', { name: 'New task' }));
    await user.type(within(dialog()).getByLabelText('Title'), 'Brand new');
    await user.click(within(dialog()).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(board.tasks).toHaveLength(1));
  });
});

describe('the versions and the comparison of any two', () => {
  it('lists every version with where it came from and what it changed', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()], versions: twoVersions });
    await openTask(rendered);

    const versions = await within(panel()).findByRole('region', { name: 'Versions' });
    const items = within(versions).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('v2');
    expect(items[0]).toHaveTextContent('edited · changed: title, body, labels');
    expect(items[1]).toHaveTextContent('v1');
    expect(items[1]).toHaveTextContent('created');
  });

  it('compares two versions as a diff, and the current content with a version', async () => {
    const rendered = await renderBoard({
      tasks: [aTaskWithHistory()],
      versions: {
        T1: [
          ...twoVersions.T1,
          {
            source: 'edit' as const,
            changed: ['body' as const],
            snapshot: content({ body: 'Third text.\n' }),
          },
        ],
      },
    });
    // The task is at v2's content while v3 exists: so the current content is "outside history".
    await openTask(rendered);
    const versions = await within(panel()).findByRole('region', { name: 'Versions' });

    expect(
      await within(versions).findByRole('group', { name: /Changes from v/ }),
    ).toBeInTheDocument();
  });
});

describe('Check actuality', () => {
  it('asks the board to hand a check to the runner, for a task in any status', async () => {
    const rendered = await renderBoard({
      tasks: [aTaskWithHistory({ status: 'done' })],
      versions: twoVersions,
    });
    const { user, board } = rendered;
    await openTask(rendered);

    await user.click(within(panel()).getByRole('button', { name: 'Check actuality' }));

    await waitFor(() => expect(board.runs).toHaveLength(1));
    expect(board.runs[0]).toEqual({ taskId: 'T1', agent: 'claude-code', kind: 'check' });
    expect(
      await within(panel()).findByText('A check of T1 was handed to Claude Code.'),
    ).toBeInTheDocument();
  });

  it('says what the board said when no runner waits', async () => {
    const rendered = await renderBoard({ tasks: [aTaskWithHistory()], versions: twoVersions });
    const { user, board } = rendered;
    await openTask(rendered);
    board.fail(
      'runTask',
      new ApiError(409, 'NO_AGENT_RUNNER', 'Nothing is waiting to start Claude Code.'),
    );

    await user.click(within(panel()).getByRole('button', { name: 'Check actuality' }));

    expect(await within(panel()).findByRole('alert')).toHaveTextContent('Nothing is waiting');
  });
});

describe('the checks and their reports', () => {
  // The report of aCheck() names version 1; these tests check version 2, the current one.
  const current = (over: Parameters<typeof aCheck>[0] = {}) => {
    const check = aCheck(over);
    check.begin.version = 2;
    if (check.report) check.report.version = 2;
    return { tasks: [aTaskWithHistory()], versions: twoVersions, checks: { T1: [check] } };
  };

  it('lists the checks apart from the versions, with state, verdict and the version read', async () => {
    const rendered = await renderBoard(current());
    await openTask(rendered);

    const checks = await within(panel()).findByRole('region', { name: 'Checks' });
    const item = await within(checks).findByRole('listitem');
    expect(item).toHaveTextContent('T1-C1');
    expect(item).toHaveTextContent('Reported · Partly outdated · v2');
    expect(within(item).queryByText('Stale')).not.toBeInTheDocument();
  });

  it('opens the report as it was stored: findings, evidence, uncertainty and recommendations', async () => {
    const rendered = await renderBoard(current());
    const { user } = rendered;
    await openTask(rendered);

    await user.click(await within(panel()).findByRole('button', { name: 'Open T1-C1' }));

    const report = within(dialog());
    expect(await report.findByText('One path moved.')).toBeInTheDocument();
    expect(report.getByText(/The tests were not run/)).toBeInTheDocument();
    expect(report.getByText('The adapter was moved')).toBeInTheDocument();
    expect(report.getByText('src/server/git/reader.ts', { selector: 'code' })).toBeInTheDocument();
    expect(report.getByText(/Update the path\./)).toBeInTheDocument();
    expect(report.getByText(/Advice: there is nothing to apply/)).toBeInTheDocument();
    expect(report.queryByText(/stale|is for v/i)).not.toBeInTheDocument();
  });

  it('says plainly when the task has moved on since the version the report read (INVARIANT)', async () => {
    const rendered = await renderBoard({
      ...current(),
      tasks: [aTaskWithHistory({ body: 'Edited in an editor.\n' })],
    });
    const { user } = rendered;
    await openTask(rendered);

    const checks = await within(panel()).findByRole('region', { name: 'Checks' });
    expect(await within(checks).findByText('Stale')).toBeInTheDocument();
    await user.click(within(checks).getByRole('button', { name: 'Open T1-C1' }));

    expect(await within(dialog()).findByRole('status')).toHaveTextContent(
      'This report is for v2; the task was changed outside the history since.',
    );
    // No Apply: a stale report offers a new check or a manual reconciliation instead.
    expect(
      within(dialog()).queryByRole('button', { name: 'Apply accepted' }),
    ).not.toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: 'Reconcile by hand' })).toBeDisabled();
  });

  it('names the version the task is at when it is another recorded version', async () => {
    const rendered = await renderBoard({
      tasks: [
        aTaskWithHistory({ title: 'Extract the adapter', body: 'First text.\n', labels: [] }),
      ],
      versions: twoVersions,
      checks: {
        T1: [
          (() => {
            const check = aCheck();
            check.begin.version = 2;
            return check;
          })(),
        ],
      },
    });
    // The task has the content of v1 while v2 is the latest: not the current version either.
    const { user } = rendered;
    await user.click(screen.getByRole('button', { name: 'Extract the adapter' }));
    await user.click(await screen.findByRole('button', { name: 'Open T1-C1' }));
    expect(await within(dialog()).findByRole('status')).toHaveTextContent(
      'This report is for v2; the task was changed outside the history since.',
    );
  });

  it('says when the repository changed while the check ran', async () => {
    const check = aCheck();
    check.begin.version = 2;
    if (check.report) check.report.repo = { branch: 'main', head: 'ffffffffffff', clean: false };
    const rendered = await renderBoard({
      tasks: [aTaskWithHistory()],
      versions: twoVersions,
      checks: { T1: [check] },
    });
    const { user } = rendered;
    await openTask(rendered);
    await user.click(await within(panel()).findByRole('button', { name: 'Open T1-C1' }));

    expect(
      await within(dialog()).findByText(/The repository changed while the check ran/),
    ).toBeInTheDocument();
  });

  it('says a check that never reported has no report, and one that failed says how', async () => {
    const working = aCheck({ state: 'working' });
    delete working.report;
    const failed = aCheck({ state: 'failed' }, 'T1', 2);
    delete failed.report;
    failed.end = {
      taskId: 'T1',
      check: 2,
      sessionId: failed.begin.sessionId,
      exitCode: 3,
      endedAt: '2026-10-17T10:09:00.000Z',
    };
    const rendered = await renderBoard({
      tasks: [aTaskWithHistory()],
      versions: twoVersions,
      checks: { T1: [working, failed] },
    });
    const { user } = rendered;
    await openTask(rendered);

    await user.click(await within(panel()).findByRole('button', { name: 'Open T1-C2' }));
    expect(
      await within(dialog()).findByText(/ended without a report \(exit code 3\)/),
    ).toBeInTheDocument();
    await user.click(within(dialog()).getAllByRole('button', { name: 'Close' }).at(-1)!);
    await user.click(within(panel()).getByRole('button', { name: 'Open T1-C1' }));
    expect(await within(dialog()).findByText(/has no report yet/)).toBeInTheDocument();
  });

  it('accepts and rejects a recommendation, one at a time, and a decision changes no task (INVARIANT)', async () => {
    const rendered = await renderBoard(current());
    const { user, board } = rendered;
    await openTask(rendered);
    const before = structuredClone(board.tasks[0]);
    await user.click(await within(panel()).findByRole('button', { name: 'Open T1-C1' }));

    await user.click(await within(dialog()).findByRole('button', { name: 'Accept r1' }));
    await waitFor(() => expect(board.checks.get('T1')?.[0]?.decisions).toHaveLength(1));
    expect(board.checks.get('T1')?.[0]?.decisions[0]).toMatchObject({
      recommendation: 'r1',
      decision: 'accepted',
    });
    expect(await within(dialog()).findByText('Accepted')).toBeInTheDocument();

    await user.click(within(dialog()).getByRole('button', { name: 'Reject r1' }));
    await waitFor(() => expect(board.checks.get('T1')?.[0]?.decisions).toHaveLength(2));
    expect(within(dialog()).getByText('Rejected')).toBeInTheDocument();
    expect(board.tasks[0]).toEqual(before);
    expect(board.calls).not.toContain('updateTask');
  });

  it('applies the accepted recommendations through the editor, shows the diff, and saves only on Save (INVARIANT)', async () => {
    const check = aCheck({
      decisions: [
        {
          taskId: 'T1',
          check: 1,
          number: 1,
          recommendation: 'r1',
          decision: 'accepted',
          createdAt: '2026-10-17T10:06:00.000Z',
        },
      ],
    });
    check.begin.version = 2;
    if (check.report) check.report.version = 2;
    const rendered = await renderBoard({
      tasks: [aTaskWithHistory()],
      versions: twoVersions,
      checks: { T1: [check] },
    });
    const { user, board } = rendered;
    await openTask(rendered);
    await user.click(await within(panel()).findByRole('button', { name: 'Open T1-C1' }));
    await user.click(await within(dialog()).findByRole('button', { name: 'Apply accepted' }));

    // The editor, with the recommendation applied to the draft and not to the task.
    expect(board.tasks[0]?.body).toBe('See `src/git.ts` for the parser.\n');
    const body = await within(dialog()).findByLabelText('Description');
    expect(body).toHaveValue('See `src/server/git/reader.ts` for the parser.\n');
    expect(within(dialog()).getByText(/Update the path\./)).toBeInTheDocument();
    expect(board.calls).not.toContain('updateTask');

    await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
    expect(within(dialog()).getByRole('group', { name: 'Changes to T1' })).toHaveTextContent(
      'src/server/git/reader.ts',
    );
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(board.patches).toHaveLength(1));
    expect(board.patches[0]?.patch).toEqual({
      body: 'See `src/server/git/reader.ts` for the parser.\n',
      ifContentHash: contentHash(content()),
      fromCheck: { check: 1, recommendations: ['r1'], basis: 'report' },
    });
    expect(board.versions.get('T1')?.at(-1)?.fromCheck).toMatchObject({
      check: 1,
      basis: 'report',
    });
  });

  it('names a recommendation that cannot be applied any more, and applies the rest', async () => {
    const check = aCheck({
      decisions: [
        {
          taskId: 'T1',
          check: 1,
          number: 1,
          recommendation: 'r1',
          decision: 'accepted',
          createdAt: '2026-10-17T10:06:00.000Z',
        },
        {
          taskId: 'T1',
          check: 1,
          number: 2,
          recommendation: 'r3',
          decision: 'accepted',
          createdAt: '2026-10-17T10:07:00.000Z',
        },
      ],
    });
    check.begin.version = 2;
    if (check.report) {
      check.report.version = 2;
      check.report.recommendations.push({
        id: 'r3',
        findings: [],
        text: 'Rename the file.',
        edit: { field: 'body', find: 'src/git.ts', replace: 'src/other.ts' },
      });
    }
    const rendered = await renderBoard({
      tasks: [aTaskWithHistory()],
      versions: twoVersions,
      checks: { T1: [check] },
    });
    const { user } = rendered;
    await openTask(rendered);
    await user.click(await within(panel()).findByRole('button', { name: 'Open T1-C1' }));
    await user.click(await within(dialog()).findByRole('button', { name: 'Apply accepted' }));

    // After r1 the text r3 replaces is gone: r3 is left out, and named.
    expect(await within(dialog()).findByLabelText('Description')).toHaveValue(
      'See `src/server/git/reader.ts` for the parser.\n',
    );
    expect(
      within(dialog()).getByText(/r3: the text it replaces is no longer in the description/),
    ).toBeInTheDocument();
  });

  it('offers a manual reconciliation of a stale report, with the editor on the current content', async () => {
    const check = aCheck({
      decisions: [
        {
          taskId: 'T1',
          check: 1,
          number: 1,
          recommendation: 'r1',
          decision: 'accepted',
          createdAt: '2026-10-17T10:06:00.000Z',
        },
      ],
    });
    check.begin.version = 2;
    const rendered = await renderBoard({
      tasks: [aTaskWithHistory({ body: 'Edited in an editor, src/git.ts.\n' })],
      versions: twoVersions,
      checks: { T1: [check] },
    });
    const { user, board } = rendered;
    await openTask(rendered);
    await user.click(await within(panel()).findByRole('button', { name: 'Open T1-C1' }));
    await user.click(await within(dialog()).findByRole('button', { name: 'Reconcile by hand' }));

    // Nothing is applied: the editor holds the content as it is, with the list beside it.
    expect(await within(dialog()).findByLabelText('Description')).toHaveValue(
      'Edited in an editor, src/git.ts.\n',
    );
    expect(within(dialog()).getByText(/nothing is applied for you/)).toBeInTheDocument();
    expect(
      within(dialog()).getByText('Ask the owner about the second criterion.'),
    ).toBeInTheDocument();

    const body = within(dialog()).getByLabelText('Description');
    await user.clear(body);
    await user.type(body, 'By hand.');
    await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(board.patches).toHaveLength(1));
    expect(board.patches[0]?.patch).toMatchObject({
      body: 'By hand.',
      fromCheck: { check: 1, recommendations: ['r1'], basis: 'manual' },
    });
  });

  it('shows where a recommendation was applied, derived from the versions', async () => {
    const check = aCheck({
      decisions: [
        {
          taskId: 'T1',
          check: 1,
          number: 1,
          recommendation: 'r1',
          decision: 'accepted',
          createdAt: '2026-10-17T10:06:00.000Z',
        },
      ],
    });
    check.begin.version = 1;
    if (check.report) check.report.version = 1;
    const rendered = await renderBoard({
      tasks: [aTaskWithHistory()],
      versions: {
        T1: [
          { source: 'create', changed: [], snapshot: content({ body: 'See src/git.ts.\n' }) },
          {
            source: 'edit',
            changed: ['body'],
            snapshot: content(),
            fromCheck: { check: 1, recommendations: ['r1'], basis: 'report' },
          },
        ],
      },
      checks: { T1: [check] },
    });
    const { user } = rendered;
    await openTask(rendered);
    await user.click(await within(panel()).findByRole('button', { name: 'Open T1-C1' }));
    expect(await within(dialog()).findByText(/Applied in v2/)).toBeInTheDocument();
  });

  it('keeps Apply from a recommendation that is only advice', async () => {
    const check = aCheck({
      decisions: [
        {
          taskId: 'T1',
          check: 1,
          number: 1,
          recommendation: 'r2',
          decision: 'accepted',
          createdAt: '2026-10-17T10:06:00.000Z',
        },
      ],
    });
    check.begin.version = 2;
    const rendered = await renderBoard({
      tasks: [aTaskWithHistory()],
      versions: twoVersions,
      checks: { T1: [check] },
    });
    const { user } = rendered;
    await openTask(rendered);
    await user.click(await within(panel()).findByRole('button', { name: 'Open T1-C1' }));
    expect(await within(dialog()).findByRole('button', { name: 'Apply accepted' })).toBeDisabled();
  });

  it('follows the board: a decision made elsewhere shows without reopening the report', async () => {
    const rendered = await renderBoard(current());
    const { user, board } = rendered;
    await openTask(rendered);
    await user.click(await within(panel()).findByRole('button', { name: 'Open T1-C1' }));
    expect(await within(dialog()).findAllByText('Undecided')).toHaveLength(2);

    board.checks.get('T1')?.[0]?.decisions.push({
      taskId: 'T1',
      check: 1,
      number: 1,
      recommendation: 'r1',
      decision: 'rejected',
      createdAt: '2026-10-17T10:06:00.000Z',
    });
    board.emit({ type: 'check.updated', taskId: 'T1', number: 1 });

    expect(await within(dialog()).findByText('Rejected')).toBeInTheDocument();
  });
});
