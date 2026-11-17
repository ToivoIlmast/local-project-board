import { act, screen, waitFor, within } from '@testing-library/react';
import type { Check } from '../../../src/contract/v1/index';
import { formatDate } from '../../../src/web/shared/lib/format';
import { ApiError } from '../../../src/web/api/index';
import { aCheck, aTask, aTopic } from '../support/fixtures';
import { renderBoard } from '../support/render';

/**
 * The series panel of a completed task and the indicator in the Blocks View (T100): what a
 * completion asks to check again, what has been checked, and the soft rule Q9c that asks before a
 * second check is started while one is marked as working.
 */

const DONE_AT = '2026-11-10T10:00:00.000Z';
const trigger = { reason: 'task-done' as const, task: 'T1', doneAt: DONE_AT };
const topic = aTopic({ id: 'P1', title: 'Alpha', blocks: [{ id: 'K1', title: 'Design' }] });
const at = { topic: 'P1', block: 'K1' };

const tasks = (over: object = {}) => [
  aTask({ id: 'T1', title: 'Source', status: 'done', doneAt: DONE_AT, rank: 'a0', ...at, ...over }),
  aTask({ id: 'T2', title: 'Second', status: 'todo', rank: 'a1', ...at }),
  aTask({ id: 'T3', title: 'Third', status: 'todo', rank: 'a2', ...at }),
  aTask({
    id: 'T4',
    title: 'Fourth',
    status: 'done',
    doneAt: DONE_AT,
    dependsOn: ['T1'],
    rank: 'a3',
    ...at,
  }),
  aTask({
    id: 'T5',
    title: 'Fifth',
    status: 'todo',
    rank: 'a4',
    aiRun: { agent: 'claude-code', state: 'working', runId: 1 },
    ...at,
  }),
];

const made = (
  taskId: string,
  number: number,
  state: Check['state'],
  over: { trigger?: object | undefined; createdAt?: string } = {},
): Check => {
  const base = aCheck({}, taskId, number);
  const { report: _report, ...rest } = base;
  return {
    ...rest,
    state,
    begin: {
      ...base.begin,
      createdAt: over.createdAt ?? base.begin.createdAt,
      ...('trigger' in over ? (over.trigger ? { trigger: over.trigger } : {}) : { trigger }),
    },
  } as Check;
};

async function openSource(options: Parameters<typeof renderBoard>[0] = {}) {
  const rendered = await renderBoard({ topics: [topic], tasks: tasks(), ...options });
  await rendered.user.click(screen.getByRole('button', { name: 'Source' }));
  await screen.findByRole('complementary', { name: 'Task T1' });
  return rendered;
}

const panel = () => screen.getByRole('region', { name: 'Series of checks' });
const item = (id: string) => panel().querySelector(`[data-task-id="${id}"]`) as HTMLElement;
const runs = (board: { runs: unknown[] }) => board.runs;

describe('the series panel', () => {
  it('lists the scope with the ground, the state and the reason a task is not checked', async () => {
    await openSource({
      checks: { T2: [made('T2', 1, 'reported')], T3: [made('T3', 1, 'failed')] },
    });

    await within(panel()).findByText('1 of 2 checked');
    expect(within(item('T2')).getByText('Checked')).toBeVisible();
    expect(within(item('T3')).getByText('Failed')).toBeVisible();
    expect(within(item('T4')).getByText(/done/i)).toBeVisible();
    expect(within(item('T5')).getByText(/AI run working/)).toBeVisible();
    expect(within(item('T2')).getByText(/same block/i)).toBeVisible();
    // An excluded task is not offered a check.
    expect(within(item('T4')).queryByRole('button')).toBeNull();
    expect(within(item('T5')).queryByRole('button')).toBeNull();
  });

  it('says it is loading, not 0, until the history is read', async () => {
    const rendered = await renderBoard({ topics: [topic], tasks: tasks() });
    const release = rendered.board.hold('checks');
    await rendered.user.click(screen.getByRole('button', { name: 'Source' }));
    await screen.findByRole('complementary', { name: 'Task T1' });
    expect(await within(panel()).findByText('Loading checks…')).toBeVisible();
    expect(within(panel()).queryByText(/0 of/)).toBeNull();
    release();
    await within(panel()).findByText('0 of 2 checked');
  });

  it('is not there for a task that is not done, or has an empty scope', async () => {
    const open = await renderBoard({ topics: [topic], tasks: tasks({ status: 'todo' }) });
    await open.user.click(screen.getByRole('button', { name: 'Source' }));
    await screen.findByRole('complementary', { name: 'Task T1' });
    expect(screen.queryByRole('region', { name: 'Series of checks' })).toBeNull();
    open.unmount();

    const lone = await renderBoard({
      tasks: [aTask({ id: 'T1', title: 'Source', status: 'done', doneAt: DONE_AT })],
    });
    await lone.user.click(screen.getByRole('button', { name: 'Source' }));
    await screen.findByRole('complementary', { name: 'Task T1' });
    expect(screen.queryByRole('region', { name: 'Series of checks' })).toBeNull();
  });

  it('starts nothing when it is mounted (INVARIANT)', async () => {
    const rendered = await openSource();
    await within(panel()).findByText('0 of 2 checked');
    expect(runs(rendered.board)).toEqual([]);
  });

  it('Check runs at once, with the exact trigger, when nothing is working', async () => {
    const rendered = await openSource({ checks: { T2: [made('T2', 1, 'reported')] } });
    await within(item('T2')).findByText('Checked');

    // A checked task can be checked again: there is no limit.
    await rendered.user.click(within(item('T2')).getByRole('button', { name: 'Check T2' }));
    await waitFor(() => expect(rendered.board.runs).toHaveLength(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rendered.board.runs[0]).toEqual({
      taskId: 'T2',
      agent: 'claude-code',
      kind: 'check',
      trigger,
    });
  });

  it('takes the commit of the run into the trigger only when there is one', async () => {
    const aiRun = { agent: 'claude-code', state: 'finished' as const, commit: 'abc1234' };
    const rendered = await openSource({ tasks: tasks({ aiRun }) });
    await rendered.user.click(await screen.findByRole('button', { name: 'Check T2' }));
    await waitFor(() => expect(rendered.board.runs).toHaveLength(1));
    expect(rendered.board.runs[0]).toMatchObject({ trigger: { ...trigger, commit: 'abc1234' } });
  });

  it('a failed task has Retry, not Check', async () => {
    await openSource({ checks: { T3: [made('T3', 1, 'failed')] } });
    await within(item('T3')).findByText('Failed');
    expect(within(item('T3')).getByRole('button', { name: 'Retry T3' })).toBeVisible();
    expect(within(item('T3')).queryByRole('button', { name: 'Check T3' })).toBeNull();
    expect(within(item('T2')).getByRole('button', { name: 'Check T2' })).toBeVisible();
  });

  it('Check next takes the first task not checked', async () => {
    const rendered = await openSource({ checks: { T2: [made('T2', 1, 'reported')] } });
    await within(item('T2')).findByText('Checked');
    await rendered.user.click(within(panel()).getByRole('button', { name: 'Check next' }));
    await waitFor(() => expect(rendered.board.runs).toHaveLength(1));
    expect(rendered.board.runs[0]).toMatchObject({ taskId: 'T3', trigger });
  });

  it('a check of another series does not count', async () => {
    await openSource({
      checks: {
        T2: [
          made('T2', 1, 'reported', {
            trigger: { ...trigger, doneAt: '2026-11-01T00:00:00.000Z' },
          }),
        ],
        T3: [made('T3', 1, 'reported', { trigger: undefined })],
      },
    });
    await within(panel()).findByText('0 of 2 checked');
  });
});

describe('Q9c: a check that is still working', () => {
  const working = { T2: [made('T2', 3, 'working', { createdAt: '2026-11-10T12:30:00.000Z' })] };

  it.each([
    ['Check', 'Check T2'],
    ['Check next', 'Check next'],
  ])('%s asks first, in words, and sends nothing before the answer', async (_name, label) => {
    const rendered = await openSource({ checks: working });
    await within(item('T2')).findByText('Working');
    const button = label === 'Check next' ? panel() : item('T2');
    await rendered.user.click(within(button).getByRole('button', { name: label }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(
      `Check #3 for task T2 is still marked as working since ${formatDate('2026-11-10T12:30:00.000Z')}. ` +
        'If its session is still running, the new check will run in parallel and repeat the cost. Start anyway?',
    );
    expect(rendered.board.runs).toEqual([]);
  });

  it('Retry asks too when another check of the task is working', async () => {
    const rendered = await openSource({
      checks: { T2: [made('T2', 1, 'failed'), made('T2', 2, 'working')], T3: [] },
    });
    await within(item('T2')).findByText('Working');
    // The last check decides: working. Retry belongs to a last result that failed.
    expect(within(item('T2')).queryByRole('button', { name: 'Retry T2' })).toBeNull();
    await rendered.user.click(within(item('T2')).getByRole('button', { name: 'Check T2' }));
    expect(await screen.findByRole('dialog')).toBeVisible();
  });

  it('Retry asks when the working check is of another task of the series', async () => {
    const rendered = await openSource({
      checks: { T2: [made('T2', 1, 'working')], T3: [made('T3', 1, 'failed')] },
    });
    await within(item('T3')).findByText('Failed');
    await rendered.user.click(within(item('T3')).getByRole('button', { name: 'Retry T3' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Check #1 for task T2');
    expect(rendered.board.runs).toEqual([]);
  });

  it('Cancel sends nothing', async () => {
    const rendered = await openSource({ checks: working });
    await within(item('T2')).findByText('Working');
    await rendered.user.click(within(item('T2')).getByRole('button', { name: 'Check T2' }));
    await rendered.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rendered.board.runs).toEqual([]);
  });

  it('Confirm starts the check with the exact trigger', async () => {
    const rendered = await openSource({ checks: working });
    await within(item('T2')).findByText('Working');
    await rendered.user.click(within(item('T2')).getByRole('button', { name: 'Check T2' }));
    await rendered.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Start anyway' }),
    );
    await waitFor(() => expect(rendered.board.runs).toHaveLength(1));
    expect(rendered.board.runs[0]).toEqual({
      taskId: 'T2',
      agent: 'claude-code',
      kind: 'check',
      trigger,
    });
  });

  it('a working check of another series does not ask', async () => {
    const rendered = await openSource({
      checks: {
        T2: [
          made('T2', 1, 'working', { trigger: { ...trigger, doneAt: '2026-11-01T00:00:00.000Z' } }),
        ],
      },
    });
    await within(panel()).findByText('0 of 2 checked');
    await rendered.user.click(within(item('T2')).getByRole('button', { name: 'Check T2' }));
    await waitFor(() => expect(rendered.board.runs).toHaveLength(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('what the series shows after the board says something', () => {
  it('a check from another client appears through check.updated, with no action here', async () => {
    const rendered = await openSource();
    await within(panel()).findByText('0 of 2 checked');

    rendered.board.checks.set('T2', [made('T2', 1, 'reported')]);
    act(() => rendered.board.emit({ type: 'check.updated', taskId: 'T2', number: 1 }));

    await within(panel()).findByText('1 of 2 checked');
    expect(rendered.board.runs).toEqual([]);
  });

  it('shows the error of a refused run, through the alert', async () => {
    const rendered = await openSource();
    await within(panel()).findByText('0 of 2 checked');
    rendered.board.fail(
      'runTask',
      new ApiError(400, 'INVALID_REQUEST', 'The trigger is not current.'),
    );
    await rendered.user.click(within(item('T2')).getByRole('button', { name: 'Check T2' }));
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(/trigger is not current/i);
  });
});

describe('the indicator in the Blocks View', () => {
  async function openBlocks(options: Parameters<typeof renderBoard>[0] = {}) {
    window.history.replaceState({}, '', '/?view=blocks');
    const rendered = await renderBoard({ topics: [topic], tasks: tasks(), ...options });
    await screen.findByRole('region', { name: 'Blocks' });
    return rendered;
  }
  const row = (id: string) =>
    screen
      .getByRole('region', { name: 'Blocks' })
      .querySelector(`[data-task-id="${id}"]`) as HTMLElement;

  it('shows ↻ checked/total for a task with a series, with a spoken text and a title', async () => {
    await openBlocks({
      checks: { T2: [made('T2', 1, 'reported')], T3: [made('T3', 1, 'working')] },
    });

    expect(await within(row('T1')).findByText('↻ 1/2')).toBeVisible();
    expect(within(row('T1')).getByText('1 of 2 checked')).toHaveClass('visually-hidden');
    expect(within(row('T1')).getByTitle('Series of checks')).toBeVisible();
    // Working is not checked.
    // A task that is not the source of a series has none.
    expect(within(row('T2')).queryByText(/↻/)).toBeNull();
  });

  it('is not a count of dependencies any more', async () => {
    await openBlocks({
      tasks: [
        aTask({ id: 'T1', title: 'A', status: 'done', ...at }),
        aTask({ id: 'T2', title: 'B', status: 'todo', dependsOn: ['T1'], ...at }),
      ],
    });
    const stack = screen.getByRole('region', { name: 'Blocks' });
    expect(within(stack).queryByText(/↻/)).toBeNull();
    expect(within(stack).queryByText(/dependencies done/)).toBeNull();
  });

  it('is not on the Kanban cards', async () => {
    window.history.replaceState({}, '', '/');
    await renderBoard({ topics: [topic], tasks: tasks() });
    const board = screen.getByRole('main');
    expect(within(board).queryByText(/↻/)).toBeNull();
    expect(within(board).queryByText(/checked/)).toBeNull();
  });
});
