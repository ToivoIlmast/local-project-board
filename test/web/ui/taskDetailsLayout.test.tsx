import { screen, waitFor, within } from '@testing-library/react';
import { WORKFLOW_LABELS } from '../../../src/web/features/settings/index';
import { aTask } from '../support/fixtures';
import { renderBoard } from '../support/render';
import { findTaskDetails, queryTaskDetails } from '../support/taskDetails';

/** The details of a task (T13): a window by default, the panel beside the board by choice. */

afterEach(() => window.history.replaceState({}, '', '/'));

type User = Awaited<ReturnType<typeof renderBoard>>['user'];

const search = () => new URLSearchParams(window.location.search);
const content = (over: object = {}) => ({
  title: 'Ship it',
  body: 'The text.\n',
  labels: [],
  ...over,
});
const one = (over: object = {}) => aTask({ id: 'T1', ...content(), status: 'todo', ...over });
const two = () => aTask({ id: 'T2', title: 'Other task', status: 'todo', rank: 'a1' });
const versions = {
  T1: [
    { source: 'create' as const, changed: [], snapshot: content({ body: 'First text.\n' }) },
    { source: 'edit' as const, changed: ['body' as const], snapshot: content() },
  ],
};

const card = (name = 'Ship it') => screen.getByRole('button', { name });
const windowOf = (id = 'T1') => screen.getByRole('dialog', { name: `Task ${id}` });
const panelOf = (id = 'T1') => screen.getByRole('complementary', { name: `Task ${id}` });
const toPanel = (user: User) =>
  user.click(within(windowOf()).getByRole('button', { name: 'Open in side panel' }));
const toWindow = (user: User) =>
  user.click(within(panelOf()).getByRole('button', { name: 'Open in window' }));

describe('opening a task', () => {
  it('shows it in a window, a dialog named after the task', async () => {
    const { user } = await renderBoard({ tasks: [one()] });

    await user.click(card());

    const dialog = await screen.findByRole('dialog', { name: 'Task T1' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { name: 'Ship it' })).toBeVisible();
    expect(screen.queryByRole('complementary', { name: 'Task T1' })).not.toBeInTheDocument();
  });

  it('opens by its address, and the focus goes to the window', async () => {
    window.history.replaceState({}, '', '/?task=T1');
    await renderBoard({ tasks: [one()] });

    const dialog = await screen.findByRole('dialog', { name: 'Task T1' });
    await waitFor(() => expect(dialog).toHaveFocus());
  });

  it('locks the scrolling of the page behind the window, and gives it back', async () => {
    const { user } = await renderBoard({ tasks: [one()] });

    await user.click(card());
    await findTaskDetails('Task T1');
    expect(document.documentElement.style.overflow).toBe('hidden');

    await user.click(within(windowOf()).getByRole('button', { name: 'Close' }));
    expect(document.documentElement.style.overflow).not.toBe('hidden');
  });

  it('says a task that is not there, in the window', async () => {
    window.history.replaceState({}, '', '/?task=T99');
    await renderBoard({ tasks: [one()] });

    const dialog = await screen.findByRole('dialog', { name: 'Task' });
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeVisible();
  });

  it('shows an archived task in the window, with the notice', async () => {
    const archived = one({ archived: { at: '2026-09-22T10:00:00.000Z' } });
    window.history.replaceState({}, '', '/?view=archive');
    const { user } = await renderBoard({ tasks: [archived] });

    await user.click(await screen.findByRole('button', { name: 'Ship it' }));

    const dialog = await screen.findByRole('dialog', { name: 'Task T1' });
    expect(within(dialog).getByText(/archived/i)).toBeInTheDocument();
  });
});

describe('closing the window', () => {
  it('by Close, and the address goes back', async () => {
    const { user } = await renderBoard({ tasks: [one()] });
    await user.click(card());
    await findTaskDetails('Task T1');

    await user.click(within(windowOf()).getByRole('button', { name: 'Close' }));

    expect(queryTaskDetails('Task T1')).toBeNull();
    expect(search().has('task')).toBe(false);
    expect(card()).toHaveFocus();
  });

  it('by Escape', async () => {
    const { user } = await renderBoard({ tasks: [one()] });
    await user.click(card());
    await findTaskDetails('Task T1');

    await user.keyboard('{Escape}');

    expect(queryTaskDetails('Task T1')).toBeNull();
    expect(search().has('task')).toBe(false);
  });

  it('by a press on the backdrop, but not by a press inside the window', async () => {
    const { user } = await renderBoard({ tasks: [one()] });
    await user.click(card());
    await findTaskDetails('Task T1');

    await user.click(within(windowOf()).getByRole('heading', { name: 'Ship it' }));
    expect(windowOf()).toBeInTheDocument();

    const backdrop = windowOf().parentElement;
    if (backdrop === null) throw new Error('the window has no backdrop');
    await user.pointer({ keys: '[MouseLeft]', target: backdrop });

    expect(queryTaskDetails('Task T1')).toBeNull();
  });

  it('Escape in a dialog inside the window closes only that dialog', async () => {
    const { user } = await renderBoard({ tasks: [one()] });
    await user.click(card());
    await findTaskDetails('Task T1');
    await user.click(within(windowOf()).getByRole('button', { name: 'Delete' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(2);

    await user.keyboard('{Escape}');

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(windowOf()).toBeInTheDocument();
    expect(search().get('task')).toBe('T1');
  });

  it('opens as a window again the next time', async () => {
    const { user } = await renderBoard({ tasks: [one()] });
    await user.click(card());
    await findTaskDetails('Task T1');
    await toPanel(user);
    await user.click(within(panelOf()).getByRole('button', { name: 'Close' }));

    await user.click(card());

    expect(await screen.findByRole('dialog', { name: 'Task T1' })).toBeInTheDocument();
  });

  it('follows Back and Forward', async () => {
    const { user } = await renderBoard({ tasks: [one()] });
    await user.click(card());
    await findTaskDetails('Task T1');

    window.history.back();
    await waitFor(() => expect(queryTaskDetails('Task T1')).toBeNull());
    window.history.forward();

    expect(await screen.findByRole('dialog', { name: 'Task T1' })).toBeInTheDocument();
  });
});

describe('moving to the panel and back', () => {
  it('shows the same task beside the board, without a step in the history', async () => {
    const { user } = await renderBoard({ tasks: [one()] });
    await user.click(card());
    await findTaskDetails('Task T1');
    const steps = window.history.length;

    await toPanel(user);

    expect(screen.queryByRole('dialog', { name: 'Task T1' })).not.toBeInTheDocument();
    expect(within(panelOf()).getByRole('heading', { name: 'Ship it' })).toBeVisible();
    expect(window.history.length).toBe(steps);
    expect(search().get('task')).toBe('T1');
    expect(document.documentElement.style.overflow).not.toBe('hidden');

    await toWindow(user);
    expect(windowOf()).toBeInTheDocument();
    expect(window.history.length).toBe(steps);
  });

  it('does not remount: the version chosen stays, and the task is not read again', async () => {
    const { user, board } = await renderBoard({ tasks: [one()], versions });
    await user.click(card());
    const select = await within(await findTaskDetails('Task T1')).findByLabelText('Version');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(select, 'v1 · historical');
    const before = window.history.length;
    const calls = board.calls.length;

    await toPanel(user);

    const same = within(panelOf()).getByLabelText('Version');
    expect(same).toBe(select);
    expect(same).toHaveDisplayValue('v1 · historical');
    expect(board.calls.length).toBe(calls);

    await toWindow(user);
    expect(within(windowOf()).getByLabelText('Version')).toBe(select);
    expect(window.history.length).toBe(before);
  });

  it('keeps a draft of the AI settings, and does not ask about it', async () => {
    const { user } = await renderBoard({ tasks: [one()] });
    await user.click(card());
    await findTaskDetails('Task T1');
    const customize = within(windowOf()).queryByRole('button', { name: 'Customize for this task' });
    if (customize !== null) await user.click(customize);
    const ai = within(windowOf()).getByRole('region', { name: 'AI' });
    const push = within(ai).getByLabelText(WORKFLOW_LABELS.push.label);
    await user.selectOptions(push, 'On');

    await toPanel(user);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const same = within(within(panelOf()).getByRole('region', { name: 'AI' })).getByLabelText(
      WORKFLOW_LABELS.push.label,
    );
    expect(same).toBe(push);
    expect(same).toHaveDisplayValue('On');
  });

  it('keeps the panel when another card is opened', async () => {
    const { user } = await renderBoard({ tasks: [one(), two()] });
    await user.click(card());
    await findTaskDetails('Task T1');
    await toPanel(user);

    await user.click(card('Other task'));

    expect(await screen.findByRole('complementary', { name: 'Task T2' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
