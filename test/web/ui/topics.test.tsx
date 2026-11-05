import { screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '../../../src/web/api/index';
import { aTask, aTopic } from '../support/fixtures';
import { cardsIn, renderBoard } from '../support/render';

const search = () => new URLSearchParams(window.location.search);

const m1 = aTopic({ id: 'P1', title: 'M1 Core' });
const m2 = aTopic({ id: 'P2', title: 'M2 Rollout' });
const inM1 = aTask({ id: 'T1', title: 'In M1', topic: 'P1' });
const inM2 = aTask({ id: 'T2', title: 'In M2', topic: 'P2' });
const loose = aTask({ id: 'T3', title: 'Loose' });

const seeded = { topics: [m1, m2], tasks: [inM1, inM2, loose] };

const filter = () => screen.getByRole('combobox', { name: 'Topic' });
const panel = () => screen.getByRole('complementary', { name: 'Topics' });

async function openTopics(options: Parameters<typeof renderBoard>[0] = seeded) {
  const rendered = await renderBoard(options);
  await rendered.user.click(screen.getByRole('button', { name: 'Topics' }));
  await screen.findByRole('complementary', { name: 'Topics' });
  return rendered;
}

describe('the board filter by topic (T90)', () => {
  it('shows every task for All, and offers All, No topic and each topic', async () => {
    await renderBoard(seeded);

    expect(filter()).toHaveValue('');
    expect(
      within(filter())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All topics', 'No topic', 'P1 · M1 Core', 'P2 · M2 Rollout']);
    expect(cardsIn('todo')).toEqual(['T1', 'T2', 'T3']);
  });

  it('shows only the tasks without a topic for "No topic"', async () => {
    const { user } = await renderBoard(seeded);

    await user.selectOptions(filter(), 'No topic');

    expect(cardsIn('todo')).toEqual(['T3']);
    expect(search().get('topic')).toBe('none');
  });

  it('shows only the tasks of the selected topic', async () => {
    const { user } = await renderBoard(seeded);

    await user.selectOptions(filter(), 'P1 · M1 Core');

    expect(cardsIn('todo')).toEqual(['T1']);
    expect(search().get('topic')).toBe('P1');
  });

  it('returns to every task, and out of the address, when All is chosen again', async () => {
    const { user } = await renderBoard(seeded);
    await user.selectOptions(filter(), 'P1 · M1 Core');

    await user.selectOptions(filter(), 'All topics');

    expect(cardsIn('todo')).toEqual(['T1', 'T2', 'T3']);
    expect(search().get('topic')).toBeNull();
  });

  it('survives a reload: a page opened on ?topic= shows that filter', async () => {
    const first = await renderBoard(seeded);
    await first.user.selectOptions(filter(), 'P2 · M2 Rollout');
    first.unmount();

    // The address bar is all a reload keeps.
    await renderBoard(seeded);

    expect(filter()).toHaveValue('P2');
    expect(cardsIn('todo')).toEqual(['T2']);
  });

  it('survives a reload for "No topic" as well', async () => {
    window.history.replaceState({}, '', '/?topic=none');
    await renderBoard(seeded);

    expect(filter()).toHaveValue('none');
    expect(cardsIn('todo')).toEqual(['T3']);
  });

  it('says so, and offers Show all, for a topic that is not on the board', async () => {
    window.history.replaceState({}, '', '/?topic=P9');
    const { user } = await renderBoard(seeded);

    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent('Topic P9 is not on the board');
    expect(cardsIn('todo')).toEqual([]);

    await user.click(within(notice).getByRole('button', { name: 'Show all' }));

    expect(search().get('topic')).toBeNull();
    expect(cardsIn('todo')).toEqual(['T1', 'T2', 'T3']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says so for a malformed value too, instead of showing an unexplained empty board', async () => {
    window.history.replaceState({}, '', '/?topic=banana');
    await renderBoard(seeded);

    expect(screen.getByRole('alert')).toHaveTextContent('Topic banana is not on the board');
  });

  it('says so when the selected topic is deleted elsewhere while the page is open', async () => {
    window.history.replaceState({}, '', '/?topic=P2');
    const { board } = await renderBoard(seeded);
    expect(cardsIn('todo')).toEqual(['T2']);

    board.emit({ type: 'topic.deleted', topicId: 'P2' });

    expect(await screen.findByRole('alert')).toHaveTextContent('Topic P2 is not on the board');
  });

  it('keeps a task of a topic nobody can read in All, and in no other filter', async () => {
    const orphan = aTask({ id: 'T4', title: 'Of a lost topic', topic: 'P7' });
    const { user } = await renderBoard({ topics: [m1], tasks: [inM1, loose, orphan] });

    expect(cardsIn('todo')).toEqual(['T1', 'T3', 'T4']);
    await user.selectOptions(filter(), 'No topic');
    expect(cardsIn('todo')).toEqual(['T3']);
  });

  it('does not say "No tasks yet" about a topic that only has no tasks', async () => {
    const { user } = await renderBoard({ topics: [m1, m2], tasks: [inM1] });

    await user.selectOptions(filter(), 'P2 · M2 Rollout');

    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
    expect(screen.getByText('No tasks match this filter')).toBeInTheDocument();
  });
});

describe('the topics panel (T90)', () => {
  it('lists the topics, and survives a reload at ?panel=topics', async () => {
    window.history.replaceState({}, '', '/?panel=topics');
    await renderBoard(seeded);

    const items = within(panel()).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('M1 Core'),
      expect.stringContaining('M2 Rollout'),
    ]);
    expect(search().get('panel')).toBe('topics');
  });

  it('opens from the header and closes again', async () => {
    const { user } = await openTopics();
    expect(search().get('panel')).toBe('topics');

    await user.click(within(panel()).getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('complementary', { name: 'Topics' })).not.toBeInTheDocument();
    expect(search().get('panel')).toBeNull();
  });

  it('says there are no topics when there are none', async () => {
    await openTopics({});
    expect(within(panel()).getByText('No topics')).toBeInTheDocument();
  });

  it('creates a topic from the server’s answer, not before it', async () => {
    const { user, board } = await openTopics({});
    const release = board.hold('createTopic');

    await user.click(within(panel()).getByRole('button', { name: 'New topic' }));
    expect(within(panel()).getByLabelText('Title')).toHaveFocus();
    await user.type(within(panel()).getByLabelText('Title'), 'M3 Launch');
    await user.type(within(panel()).getByLabelText('Description'), 'Ship it');
    await user.click(within(panel()).getByRole('button', { name: 'Create' }));

    // No optimistic update: nothing is listed while the board has not answered.
    expect(within(panel()).queryByText('M3 Launch')).not.toBeInTheDocument();
    release();

    expect(await within(panel()).findByText('M3 Launch')).toBeInTheDocument();
    expect(board.topics).toEqual([{ id: 'P1', title: 'M3 Launch', body: 'Ship it', blocks: [] }]);
    // The new topic can be filtered by at once.
    expect(
      within(filter())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toContain('P1 · M3 Launch');
  });

  it('shows the board’s refusal of a create and keeps what was typed', async () => {
    const { user, board } = await openTopics({});
    board.fail('createTopic', new ApiError(400, 'INVALID_REQUEST', 'The title is not valid.'));

    await user.click(within(panel()).getByRole('button', { name: 'New topic' }));
    await user.type(within(panel()).getByLabelText('Title'), 'Nope');
    await user.click(within(panel()).getByRole('button', { name: 'Create' }));

    expect(await within(panel()).findByRole('alert')).toHaveTextContent('The title is not valid.');
    expect(within(panel()).getByLabelText('Title')).toHaveValue('Nope');
  });

  it('edits the title and the body of a topic', async () => {
    const { user, board } = await openTopics();

    await user.click(within(panel()).getByRole('button', { name: 'Edit P1' }));
    const title = within(panel()).getByLabelText('Title');
    expect(title).toHaveValue('M1 Core');
    await user.clear(title);
    await user.type(title, 'M1 Renamed');
    await user.type(within(panel()).getByLabelText('Description'), 'New goal');
    await user.click(within(panel()).getByRole('button', { name: 'Save' }));

    expect(await within(panel()).findByText('M1 Renamed')).toBeInTheDocument();
    expect(board.topics[0]).toMatchObject({ id: 'P1', title: 'M1 Renamed', body: 'New goal' });
    expect(within(panel()).queryByLabelText('Title')).not.toBeInTheDocument();
  });

  it('asks before an edit with unsaved changes is left, through the page’s own question', async () => {
    const { user, board } = await openTopics();
    await user.click(within(panel()).getByRole('button', { name: 'Edit P1' }));
    await user.type(within(panel()).getByLabelText('Title'), ' typed');

    await user.click(within(panel()).getByRole('button', { name: 'Close' }));

    const question = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(question).toHaveTextContent('You have unsaved changes to the topic P1');
    await user.click(within(question).getByRole('button', { name: 'Discard' }));

    expect(screen.queryByRole('complementary', { name: 'Topics' })).not.toBeInTheDocument();
    expect(board.topics[0]?.title).toBe('M1 Core');
  });

  it('does not ask when nothing was typed', async () => {
    const { user } = await openTopics();
    await user.click(within(panel()).getByRole('button', { name: 'Edit P1' }));

    await user.click(within(panel()).getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('deletes an empty topic after the question, and it is gone from the list and the filter', async () => {
    const { user, board } = await openTopics({ topics: [m1, m2], tasks: [inM1] });

    await user.click(within(panel()).getByRole('button', { name: 'Delete P2' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(within(panel()).queryByText('M2 Rollout')).not.toBeInTheDocument());
    expect(board.topics.map((topic) => topic.id)).toEqual(['P1']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(filter()).queryByRole('option', { name: /P2/ })).not.toBeInTheDocument();
  });

  it('shows the board’s refusal for a topic with tasks, and keeps the topic', async () => {
    const { user, board } = await openTopics({ topics: [m1], tasks: [inM1] });

    await user.click(within(panel()).getByRole('button', { name: 'Delete P1' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));

    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
      'Topic "P1" is not empty',
    );
    expect(board.topics.map((topic) => topic.id)).toEqual(['P1']);
    expect(within(panel()).getByText('M1 Core')).toBeInTheDocument();
  });

  it('resets the filter to All when the selected topic is deleted', async () => {
    window.history.replaceState({}, '', '/?panel=topics&topic=P2');
    const { user } = await renderBoard({ topics: [m1, m2], tasks: [inM1] });
    expect(cardsIn('todo')).toEqual([]);

    await user.click(within(panel()).getByRole('button', { name: 'Delete P2' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(search().get('topic')).toBeNull());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(filter()).toHaveValue('');
    expect(cardsIn('todo')).toEqual(['T1']);
  });

  it('follows topic.created, topic.updated and topic.deleted from the stream', async () => {
    const { board } = await openTopics();

    board.emit({ type: 'topic.created', topic: aTopic({ id: 'P3', title: 'M3 Launch' }) });
    expect(await within(panel()).findByText('M3 Launch')).toBeInTheDocument();

    board.emit({ type: 'topic.updated', topic: aTopic({ id: 'P1', title: 'M1 Renamed' }) });
    expect(await within(panel()).findByText('M1 Renamed')).toBeInTheDocument();
    expect(within(panel()).queryByText('M1 Core')).not.toBeInTheDocument();

    board.emit({ type: 'topic.deleted', topicId: 'P2' });
    await waitFor(() => expect(within(panel()).queryByText('M2 Rollout')).not.toBeInTheDocument());
    expect(
      within(panel())
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining('M1 Renamed'), expect.stringContaining('M3 Launch')]);
  });
});
