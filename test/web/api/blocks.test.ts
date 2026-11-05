import { routes } from '../../../src/contract/v1/index';
import { ApiError, createBoardClient } from '../../../src/web/api/index';
import { createBoardStore } from '../../../src/web/api/store';
import { errorBody, fakeFetch } from '../support/fetch';
import { fakeBoard } from '../support/fakeBoard';
import { aTask, aTopic } from '../support/fixtures';

/** The four operations on the blocks of a topic, over the routes the contract already has (T92). */

const BASE = 'http://127.0.0.1:7432';
const topic = aTopic({
  id: 'P1',
  blocks: [
    { id: 'K1', title: 'Design' },
    { id: 'K2', title: 'Build' },
  ],
});

function clientOver(answer: (method: string, url: string) => object | undefined) {
  const fake = fakeFetch((call) => {
    if (call.url.endsWith('/api/v1/session')) return { json: { token: 'tok' } };
    const json = answer(call.method, call.url);
    return json === undefined ? { status: 404, json: errorBody('NOT_FOUND') } : { json };
  });
  return { fake, client: createBoardClient({ baseUrl: BASE, fetch: fake.fetch }) };
}

describe('the board client and the blocks of a topic', () => {
  it('creates a block with POST on the blocks of the topic, one call', async () => {
    const { fake, client } = clientOver(() => ({ id: 'K3', title: 'Ship' }));

    expect(await client.createBlock('P1', { title: 'Ship' })).toEqual({ id: 'K3', title: 'Ship' });

    const calls = fake.calls.filter((call) => !call.url.endsWith('/session'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/api/v1/topics/P1/blocks` });
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ title: 'Ship' });
  });

  it('renames a block with PATCH on the block, sending the title alone', async () => {
    const { fake, client } = clientOver(() => ({ id: 'K2', title: 'Make' }));

    await client.updateBlock('P1', 'K2', { title: 'Make' });

    const call = fake.calls.find((candidate) => candidate.method === 'PATCH');
    expect(call).toMatchObject({ url: `${BASE}/api/v1/topics/P1/blocks/K2` });
    expect(JSON.parse(call?.body ?? '')).toEqual({ title: 'Make' });
  });

  it('reorders with one PUT of the block ids', async () => {
    const { fake, client } = clientOver(() => ({ ...topic, blocks: [...topic.blocks].reverse() }));

    await client.reorderBlocks('P1', ['K2', 'K1']);

    const call = fake.calls.find((candidate) => candidate.method === 'PUT');
    expect(call).toMatchObject({ url: `${BASE}/api/v1/topics/P1/blocks/order` });
    expect(JSON.parse(call?.body ?? '')).toEqual({ blocks: ['K2', 'K1'] });
  });

  it('deletes with DELETE on the block, and says nothing when it worked', async () => {
    const { fake, client } = clientOver(() => ({ deleted: true }));

    expect(await client.deleteBlock('P1', 'K2')).toBeUndefined();

    const call = fake.calls.find((candidate) => candidate.method === 'DELETE');
    expect(call).toMatchObject({ url: `${BASE}/api/v1/topics/P1/blocks/K2` });
  });

  it('uses the routes the contract has, and adds none', () => {
    expect(
      [
        'topics.createBlock',
        'topics.updateBlock',
        'topics.reorderBlocks',
        'topics.deleteBlock',
      ].map((id) => routes[id as keyof typeof routes].path),
    ).toEqual([
      '/topics/:id/blocks',
      '/topics/:id/blocks/:blockId',
      '/topics/:id/blocks/order',
      '/topics/:id/blocks/:blockId',
    ]);
  });
});

async function storeOf(tasks = [aTask({ id: 'T1', topic: 'P1', block: 'K1' })]) {
  const board = fakeBoard({ topics: [topic], tasks });
  const store = createBoardStore(board.client);
  await store.load();
  return { board, store };
}

const titles = (store: { getState(): { topics: { blocks: { title: string }[] }[] } }) =>
  store.getState().topics[0]?.blocks.map((block) => block.title);

describe('the store and the blocks of a topic', () => {
  it('createBlock asks the board once and shows the topic with the new block last', async () => {
    const { board, store } = await storeOf();

    const block = await store.createBlock('P1', 'Ship');

    expect(block).toMatchObject({ title: 'Ship' });
    expect(board.calls.filter((call) => call === 'createBlock')).toHaveLength(1);
    expect(titles(store)).toEqual(['Design', 'Build', 'Ship']);
  });

  it('updateBlock changes the title and keeps the id and the place', async () => {
    const { store } = await storeOf();

    await store.updateBlock('P1', 'K1', 'Sketch');

    expect(store.getState().topics[0]?.blocks).toEqual([
      { id: 'K1', title: 'Sketch' },
      { id: 'K2', title: 'Build' },
    ]);
  });

  it('reorderBlocks takes the topic the board returned, with one call', async () => {
    const { board, store } = await storeOf();

    const returned = await store.reorderBlocks('P1', ['K2', 'K1']);

    expect(returned.blocks.map((block) => block.id)).toEqual(['K2', 'K1']);
    expect(board.calls.filter((call) => call === 'reorderBlocks')).toHaveLength(1);
    expect(titles(store)).toEqual(['Build', 'Design']);
  });

  it('deleteBlock removes an empty block from the topic', async () => {
    const { store } = await storeOf();

    await store.deleteBlock('P1', 'K2');

    expect(titles(store)).toEqual(['Design']);
  });

  it('deleteBlock rejects with BLOCK_NOT_EMPTY and leaves the block where it is', async () => {
    const { store } = await storeOf();

    await expect(store.deleteBlock('P1', 'K1')).rejects.toMatchObject({
      code: 'BLOCK_NOT_EMPTY',
    });
    expect(titles(store)).toEqual(['Design', 'Build']);
  });

  it('shows nothing before the board has answered (INVARIANT: no optimistic update)', async () => {
    const { board, store } = await storeOf();
    const release = board.hold('reorderBlocks');

    const pending = store.reorderBlocks('P1', ['K2', 'K1']);
    await Promise.resolve();
    expect(titles(store)).toEqual(['Design', 'Build']);

    release();
    await pending;
    expect(titles(store)).toEqual(['Build', 'Design']);
  });

  it('shows nothing when the board refuses', async () => {
    const { board, store } = await storeOf();
    board.fail('reorderBlocks', new ApiError(400, 'INVALID_REQUEST', 'No.'));

    await expect(store.reorderBlocks('P1', ['K2', 'K1'])).rejects.toBeInstanceOf(ApiError);

    expect(titles(store)).toEqual(['Design', 'Build']);
  });

  it('still takes topic.updated from the stream', async () => {
    const { store } = await storeOf();

    await store.handleEvent({
      type: 'topic.updated',
      topic: { ...topic, blocks: [{ id: 'K2', title: 'Build' }] },
    });

    expect(titles(store)).toEqual(['Build']);
  });
});
