import type { BoardEvent } from '../../../src/contract/v1/index';
import { ApiError } from '../../../src/web/api/index';
import {
  applyEvent,
  columnsOf,
  createBoardStore,
  emptyState,
  type BoardState,
} from '../../../src/web/api/store';
import { fakeBoard } from '../support/fakeBoard';
import { aDocument, aProject, aReport, aTask, aWorkflow } from '../support/fixtures';

const state = (overrides: Partial<BoardState> = {}): BoardState => ({
  ...emptyState(),
  project: aProject(),
  ...overrides,
});

describe('what an event does to the board the page is showing', () => {
  it('adds a task the moment the board says it exists', () => {
    const task = aTask();

    const next = applyEvent(state(), { type: 'task.created', task });

    expect(next.tasks).toEqual([task]);
  });

  it('replaces a task instead of showing it twice (INVARIANT: idempotent)', () => {
    const task = aTask({ id: 'T1', title: 'Before' });
    const renamed = { ...task, title: 'After' };

    let next = applyEvent(state({ tasks: [task] }), { type: 'task.updated', task: renamed });
    next = applyEvent(next, { type: 'task.updated', task: renamed });

    expect(next.tasks).toEqual([renamed]);
  });

  it('takes a task it has never seen as news, not as an error', () => {
    const task = aTask({ id: 'T9' });

    const next = applyEvent(state(), { type: 'task.updated', task });

    expect(next.tasks).toEqual([task]);
  });

  it('removes a deleted task and forgets its documents', () => {
    const task = aTask({ id: 'T1' });
    const before = state({ tasks: [task], documents: { T1: [aDocument({ taskId: 'T1' })] } });

    const next = applyEvent(before, { type: 'task.deleted', taskId: 'T1' });

    expect(next.tasks).toEqual([]);
    expect(next.documents['T1']).toBeUndefined();
  });

  it('keeps a task list it was given alone when another task is deleted', () => {
    const before = state({ tasks: [aTask({ id: 'T1' }), aTask({ id: 'T2' })] });

    const next = applyEvent(before, { type: 'task.deleted', taskId: 'T2' });

    expect(next.tasks.map((task) => task.id)).toEqual(['T1']);
  });

  it('adds a written document to the list it is showing, in the board’s own order', () => {
    // The board lists documents by name, so a new one belongs where its name puts it.
    const before = state({ documents: { T1: [aDocument({ name: 'b.md' })] } });
    const written = aDocument({ name: 'a.md', size: 9 });

    const next = applyEvent(before, { type: 'document.written', document: written });

    expect(next.documents['T1']?.map((d) => d.name)).toEqual(['a.md', 'b.md']);
  });

  it('replaces a document that was written again', () => {
    const before = state({ documents: { T1: [aDocument({ name: 'a.md', size: 1 })] } });

    const next = applyEvent(before, {
      type: 'document.written',
      document: aDocument({ name: 'a.md', size: 99 }),
    });

    expect(next.documents['T1']).toEqual([expect.objectContaining({ size: 99 })]);
  });

  it('does not invent a document list for a task whose documents were never read', () => {
    const next = applyEvent(state(), {
      type: 'document.written',
      document: aDocument({ taskId: 'T7' }),
    });

    expect(next.documents['T7']).toBeUndefined();
  });

  it('removes a deleted document', () => {
    const before = state({
      documents: { T1: [aDocument({ name: 'a.md' }), aDocument({ name: 'b.md' })] },
    });

    const next = applyEvent(before, { type: 'document.deleted', taskId: 'T1', name: 'a.md' });

    expect(next.documents['T1']?.map((d) => d.name)).toEqual(['b.md']);
  });

  it('adds and removes reports', () => {
    const report = aReport({ id: 'R2' });

    const added = applyEvent(state({ reports: [aReport({ id: 'R1' })] }), {
      type: 'report.created',
      report,
    });
    expect(added.reports.map((r) => r.id)).toEqual(['R1', 'R2']);

    // The same event twice — the answer to a request and the stream — is still one report.
    const again = applyEvent(added, { type: 'report.created', report });
    expect(again.reports.map((r) => r.id)).toEqual(['R1', 'R2']);

    const removed = applyEvent(added, { type: 'report.deleted', reportId: 'R1' });
    expect(removed.reports.map((r) => r.id)).toEqual(['R2']);
  });

  it('keeps the very objects of the tasks it did not touch (so the page can skip them)', () => {
    const kept = aTask({ id: 'T1' });
    const changed = aTask({ id: 'T2' });
    const before = state({ tasks: [kept, changed] });

    const next = applyEvent(before, { type: 'task.updated', task: { ...changed, title: 'New' } });

    expect(next.tasks[0]).toBe(kept);
    expect(next.tasks[1]).not.toBe(changed);
  });

  it('leaves the state alone on board.changed: that event is a request to read again', () => {
    const before = state({ tasks: [aTask()] });

    expect(applyEvent(before, { type: 'board.changed' })).toEqual(before);
  });
});

describe('the workflow settings the board shows', () => {
  it('replaces them the moment the board says they changed (idempotent)', () => {
    const workflow = aWorkflow({ board: { push: true } });

    let next = applyEvent(state(), { type: 'workflow.updated', workflow });
    next = applyEvent(next, { type: 'workflow.updated', workflow });

    expect(next.workflow).toEqual(workflow);
  });

  it('keeps everything else as it was', () => {
    const before = state({ tasks: [aTask()], reports: [aReport()] });

    const next = applyEvent(before, { type: 'workflow.updated', workflow: aWorkflow() });

    expect(next.tasks).toBe(before.tasks);
    expect(next.reports).toBe(before.reports);
    expect(next.project).toBe(before.project);
  });
});

describe('the columns the board shows', () => {
  it('follows the order the board is configured with, not the order tasks arrived in', () => {
    const tasks = [aTask({ status: 'done' }), aTask({ status: 'backlog' })];

    const { columns } = columnsOf(aProject(), tasks);

    expect(columns.map((column) => column.status)).toEqual([
      'backlog',
      'todo',
      'in-progress',
      'done',
    ]);
    expect(columns[0]?.tasks).toHaveLength(1);
    expect(columns[1]?.tasks).toEqual([]);
  });

  it('orders the cards of a column by rank, and by id when ranks tie', () => {
    const tasks = [
      aTask({ id: 'T3', status: 'todo', rank: 'a2' }),
      aTask({ id: 'T2', status: 'todo', rank: 'a1' }),
      aTask({ id: 'T1', status: 'todo', rank: 'a1' }),
    ];

    const { columns } = columnsOf(aProject(), tasks);

    expect(columns[1]?.tasks.map((task) => task.id)).toEqual(['T1', 'T2', 'T3']);
  });

  it('shows a task whose status is not on this board instead of hiding it (INVARIANT)', () => {
    const stray = aTask({ status: 'archived' });

    const { columns, orphans } = columnsOf(aProject(), [stray, aTask({ status: 'todo' })]);

    expect(orphans).toEqual([stray]);
    expect(columns.flatMap((column) => column.tasks)).toHaveLength(1);
  });
});

describe('the store', () => {
  it('reads the board once and is then ready', async () => {
    const board = fakeBoard({ tasks: [aTask()], reports: [aReport()] });
    const store = createBoardStore(board.client);

    await store.load();

    const current = store.getState();
    expect(current.phase).toBe('ready');
    expect(current.project?.name).toBe('dep-health');
    expect(current.tasks).toHaveLength(1);
    expect(current.reports).toHaveLength(1);
    expect(current.git).toMatchObject({ branch: 'main' });
  });

  it('tells the page it could not read the board, and recovers on a retry', async () => {
    const board = fakeBoard();
    board.fail('project', new ApiError(0, 'NETWORK_ERROR', 'The board is not answering.'));
    const store = createBoardStore(board.client);

    await store.load();
    expect(store.getState()).toMatchObject({ phase: 'failed', error: { code: 'NETWORK_ERROR' } });

    await store.load();
    expect(store.getState()).toMatchObject({ phase: 'ready', error: undefined });
  });

  it('keeps the board it has already read when a later read fails (INVARIANT)', async () => {
    const board = fakeBoard({ tasks: [aTask({ id: 'T1', title: 'Already on the board' })] });
    const store = createBoardStore(board.client);
    await store.load();

    // The board was stopped in its terminal while the page was open.
    board.fail('project', new ApiError(0, 'NETWORK_ERROR', 'The board is not answering.'));
    await store.load();

    const current = store.getState();
    // What the page knows is worth more than nothing, so it is not thrown away (ADR-0025).
    expect(current.phase).toBe('ready');
    expect(current.project).toBeDefined();
    expect(current.tasks).toHaveLength(1);
    expect(current.error).toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('forgets the failure once the board answers again', async () => {
    const board = fakeBoard({ tasks: [aTask()] });
    const store = createBoardStore(board.client);
    await store.load();
    board.fail('listTasks', new ApiError(0, 'NETWORK_ERROR', 'The board is not answering.'));
    await store.load();

    await store.load();

    expect(store.getState()).toMatchObject({ phase: 'ready', error: undefined });
    expect(store.getState().tasks).toHaveLength(1);
  });

  it('still shows the board when git alone cannot be read', async () => {
    const board = fakeBoard({ tasks: [aTask()] });
    board.fail('gitStatus', new ApiError(500, 'INTERNAL_ERROR', 'git failed'));
    const store = createBoardStore(board.client);

    await store.load();

    expect(store.getState().phase).toBe('ready');
    expect(store.getState().git).toBeUndefined();
    expect(store.getState().tasks).toHaveLength(1);
  });

  it('shows a created task at once, and the event about it does not duplicate it', async () => {
    const board = fakeBoard();
    const store = createBoardStore(board.client);
    board.onEvent((event) => store.handleEvent(event));
    await store.load();

    await store.createTask({ title: 'Extract the git adapter' });

    expect(store.getState().tasks).toHaveLength(1);
    expect(store.getState().tasks[0]?.title).toBe('Extract the git adapter');
  });

  it('asks the server to move a card and never computes the order itself (INVARIANT)', async () => {
    const first = aTask({ id: 'T1', status: 'todo', rank: 'a0' });
    const second = aTask({ id: 'T2', status: 'todo', rank: 'a1' });
    const board = fakeBoard({ tasks: [first, second] });
    const store = createBoardStore(board.client);
    await store.load();

    await store.moveTask('T2', { status: 'todo', before: 'T1' });

    const moved = store.getState().tasks.find((task) => task.id === 'T2');
    expect(moved?.rank).not.toBe('a1');
    expect(
      columnsOf(aProject(), store.getState().tasks).columns[1]?.tasks.map((t) => t.id),
    ).toEqual(['T2', 'T1']);
  });

  it('marks a card busy while its change is in flight, and clears it when it fails', async () => {
    const board = fakeBoard({ tasks: [aTask({ id: 'T1' })] });
    const store = createBoardStore(board.client);
    await store.load();
    const release = board.hold('moveTask');
    board.fail('moveTask', new ApiError(422, 'UNKNOWN_STATUS', 'No such status.'));

    const moving = store.moveTask('T1', { status: 'done' });
    expect(store.getState().busy).toEqual(['T1']);

    release();
    await expect(moving).rejects.toMatchObject({ code: 'UNKNOWN_STATUS' });
    expect(store.getState().busy).toEqual([]);
    // The board is what the server says it is: a failed move changed nothing.
    expect(store.getState().tasks[0]?.status).toBe('todo');
  });

  it('reads the whole board again when something changed on disk (§14)', async () => {
    const board = fakeBoard();
    const store = createBoardStore(board.client);
    await store.load();
    board.calls.length = 0;

    await store.handleEvent({ type: 'board.changed' });

    expect(board.calls).toEqual(expect.arrayContaining(['project', 'listTasks', 'listReports']));
  });

  it('reads the workflow settings with the board', async () => {
    const board = fakeBoard({ workflow: { board: { push: true }, statuses: {} } });
    const store = createBoardStore(board.client);

    await store.load();

    expect(board.calls).toContain('workflow');
    expect(store.getState().workflow).toMatchObject({ board: { push: true }, statuses: {} });
    expect(store.getState().workflow?.defaults.push).toBe(false);
  });

  it('reads them again when something changed on disk, so a hand edit of workflow.yaml shows', async () => {
    const board = fakeBoard();
    const store = createBoardStore(board.client);
    await store.load();
    board.workflow.board = { push: true };

    await store.handleEvent({ type: 'board.changed' });

    expect(store.getState().workflow?.board).toEqual({ push: true });
  });

  it('shows new settings only when the server has answered, not before (INVARIANT)', async () => {
    const board = fakeBoard();
    const store = createBoardStore(board.client);
    await store.load();
    const release = board.hold('updateWorkflow');

    const saving = store.updateWorkflow({ board: { push: true }, statuses: {} });
    await Promise.resolve();
    expect(store.getState().workflow?.board).toEqual({});

    release();
    await saving;
    expect(store.getState().workflow?.board).toEqual({ push: true });
  });

  it('keeps what it showed when the board refuses the settings', async () => {
    const board = fakeBoard({ workflow: { board: { push: true }, statuses: {} } });
    const store = createBoardStore(board.client);
    await store.load();
    board.fail('updateWorkflow', new ApiError(422, 'UNKNOWN_STATUS', 'Unknown status "nope".'));

    await expect(
      store.updateWorkflow({ board: {}, statuses: { nope: { push: true } } }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_STATUS' });

    expect(store.getState().workflow?.board).toEqual({ push: true });
    expect(board.workflow.board).toEqual({ push: true });
  });

  it('takes the state once when the answer and the event both arrive', async () => {
    const board = fakeBoard();
    const store = createBoardStore(board.client);
    await store.load();
    const seen: unknown[] = [];
    store.subscribe(() => seen.push(store.getState().workflow?.board));

    await store.updateWorkflow({ board: { push: true }, statuses: {} });
    await store.handleEvent({
      type: 'workflow.updated',
      workflow: aWorkflow({ board: { push: true } }),
    });

    expect(new Set(seen.map((board) => JSON.stringify(board)))).toEqual(
      new Set([JSON.stringify({ push: true })]),
    );
  });

  it('does not put back settings that a read which began before a change had seen (INVARIANT)', async () => {
    const board = fakeBoard();
    const store = createBoardStore(board.client);
    await store.load();
    board.calls.length = 0;
    const release = board.hold('gitStatus');
    const reading = store.load();
    while (!board.calls.includes('gitStatus')) await Promise.resolve();

    await store.updateWorkflow({ board: { push: true }, statuses: {} });
    release();
    await reading;

    expect(store.getState().workflow?.board).toEqual({ push: true });
  });

  it('does not put back what a read that began before a change had seen (INVARIANT)', async () => {
    const board = fakeBoard({ tasks: [aTask({ id: 'T1', status: 'todo' })] });
    const store = createBoardStore(board.client);
    await store.load();
    board.calls.length = 0;
    // The read has the task in "todo" and waits for git, as a slow `git status` makes it.
    const release = board.hold('gitStatus');
    const reading = store.load();
    while (!board.calls.includes('gitStatus')) await Promise.resolve();

    await store.moveTask('T1', { status: 'done' });
    const shown: string[] = [];
    store.subscribe(() => shown.push(store.getState().tasks[0]?.status ?? 'gone'));
    release();
    await reading;

    // The move is what the board said last; the older answer must not show, not even for a
    // moment, or the card is taken out of the page and the focus goes with it.
    expect(shown).not.toContain('todo');
    expect(store.getState().tasks[0]?.status).toBe('done');
  });

  it('reads the documents of a task once and keeps them live', async () => {
    const board = fakeBoard({ tasks: [aTask({ id: 'T1' })] });
    const store = createBoardStore(board.client);
    board.onEvent((event) => store.handleEvent(event));
    await store.load();

    await store.loadDocuments('T1');
    expect(store.getState().documents['T1']).toEqual([]);

    await store.writeDocument('T1', 'plan.md', '# Plan\n');
    expect(store.getState().documents['T1']?.map((d) => d.name)).toEqual(['plan.md']);

    await store.deleteDocument('T1', 'plan.md');
    expect(store.getState().documents['T1']).toEqual([]);
  });

  it('reads the documents of a task again when the first read failed and the board is read again', async () => {
    const board = fakeBoard({ tasks: [aTask({ id: 'T1' })] });
    const store = createBoardStore(board.client);
    await store.load();

    // The person opened the task while the board was gone, so its list was never read.
    board.fail('listDocuments', new ApiError(0, 'NETWORK_ERROR', 'The board is not answering.'));
    await expect(store.loadDocuments('T1')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(store.getState().documents['T1']).toBeUndefined();

    // The stream came back and the page read the whole board (§14): what was asked for is
    // read too, or the list stays "loading" for as long as the page is open.
    await store.load();

    expect(store.getState().documents['T1']).toEqual([]);
  });

  it('notifies the page whenever the state changes, and stops when it unsubscribes', async () => {
    const board = fakeBoard();
    const store = createBoardStore(board.client);
    let notifications = 0;
    const stop = store.subscribe(() => (notifications += 1));

    await store.load();
    expect(notifications).toBeGreaterThan(0);

    stop();
    const before = notifications;
    store.handleEvent({ type: 'task.created', task: aTask() } satisfies BoardEvent);
    expect(notifications).toBe(before);
  });

  it('remembers whether the live connection is there', () => {
    const store = createBoardStore(fakeBoard().client);

    expect(store.getState().connection).toBe('connecting');
    store.setConnection('offline');
    expect(store.getState().connection).toBe('offline');
  });
});
