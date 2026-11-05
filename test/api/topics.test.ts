import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { errorResponseSchema, routes, API_BASE_PATH as API } from '../../src/contract/v1/index.js';
import type { Topic } from '../../src/core/model/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs } from '../support/tmp.js';

let board: TestBoard;

beforeEach(async () => {
  board = await createTestBoard();
});

afterEach(async () => {
  await board.close();
  await cleanTmpDirs();
});

async function createTopic(title = 'M1', body?: string): Promise<Topic> {
  const response = await board
    .post(`${API}/topics`, body === undefined ? { title } : { title, body })
    .expect(201);
  return response.body as Topic;
}

async function createBlock(
  topicId: string,
  title = 'Block',
): Promise<{ id: string; title: string }> {
  const response = await board.post(`${API}/topics/${topicId}/blocks`, { title }).expect(201);
  return response.body as { id: string; title: string };
}

/** Written through the port, so these tests do not lean on the task routes (T85). */
async function createTask(place: { topic?: string; block?: string }): Promise<string> {
  const task = await board.storage.createTask({
    title: 'A task',
    status: 'todo',
    rank: 'a0',
    body: '',
    labels: [],
    ...place,
  });
  return task.id;
}

/** The topics, tasks and events as they are: what a refusal must leave alone. */
async function state(): Promise<unknown> {
  const topics = await Promise.all(['P1', 'P2', 'P3'].map((id) => board.storage.getTopic(id)));
  return {
    topics,
    tasks: await board.storage.listTasks(),
    events: structuredClone(board.events.events),
  };
}

async function errorCode(response: { body: unknown }): Promise<string> {
  return errorResponseSchema.parse(response.body).error.code;
}

describe('topics over HTTP', () => {
  it('creates a topic: 201, the topic as stored, and topic.created', async () => {
    const response = await board
      .post(`${API}/topics`, { title: 'M1 Core', body: '## Goal\n' })
      .expect(201);
    expect(response.body).toEqual({ id: 'P1', title: 'M1 Core', body: '## Goal\n', blocks: [] });
    expect(await board.storage.getTopic('P1')).toEqual(response.body);
    expect(board.events.events).toEqual([{ type: 'topic.created', topic: response.body }]);
  });

  it('defaults the body, and numbers topics P1, P2', async () => {
    expect(await createTopic('a')).toEqual({ id: 'P1', title: 'a', body: '', blocks: [] });
    expect((await createTopic('b')).id).toBe('P2');
  });

  it('refuses a topic the contract does not describe: 400, nothing written', async () => {
    for (const body of [
      {},
      { title: ' ' },
      { title: 'x', body: 3 },
      { title: 'x', blocks: [] },
      { title: 'x', id: 'P7' },
    ]) {
      const response = await board.post(`${API}/topics`, body).expect(400);
      expect(await errorCode(response)).toBe('INVALID_REQUEST');
    }
    expect(await board.storage.getTopic('P1')).toBeNull();
    expect(board.events.events).toEqual([]);
  });

  it('changes a topic: PATCH title and body, blocks kept, topic.updated', async () => {
    await createTopic('M1', 'old\n');
    await createBlock('P1', 'A');
    const response = await board.patch(`${API}/topics/P1`, { title: 'M2' }).expect(200);
    expect(response.body).toEqual({
      id: 'P1',
      title: 'M2',
      body: 'old\n',
      blocks: [{ id: 'K1', title: 'A' }],
    });
    await board.patch(`${API}/topics/P1`, { body: 'new\n' }).expect(200);
    expect(await board.storage.getTopic('P1')).toMatchObject({ title: 'M2', body: 'new\n' });
    expect(board.events.types()).toEqual([
      'topic.created',
      'topic.updated',
      'topic.updated',
      'topic.updated',
    ]);
    expect(board.events.last()).toEqual({
      type: 'topic.updated',
      topic: await board.storage.getTopic('P1'),
    });
  });

  it('refuses a PATCH that changes the id or the blocks, or nothing at all', async () => {
    await createTopic();
    for (const body of [{ id: 'P2' }, { blocks: [] }, {}, { title: '' }]) {
      const response = await board.patch(`${API}/topics/P1`, body).expect(400);
      expect(await errorCode(response)).toBe('INVALID_REQUEST');
    }
    expect(await board.storage.getTopic('P1')).toMatchObject({ title: 'M1' });
  });

  it('answers 404 TOPIC_NOT_FOUND for a topic that does not exist, 400 for a bad id', async () => {
    const missing = await board.patch(`${API}/topics/P9`, { title: 'x' }).expect(404);
    expect(await errorCode(missing)).toBe('TOPIC_NOT_FOUND');
    expect(await errorCode(await board.del(`${API}/topics/P9`).expect(404))).toBe(
      'TOPIC_NOT_FOUND',
    );
    await board.patch(`${API}/topics/T1`, { title: 'x' }).expect(400);
    await board.del(`${API}/topics/nope`).expect(400);
    expect(board.events.events).toEqual([]);
  });

  describe('listing topics (T90)', () => {
    it('answers every topic with its blocks, by number, and nothing else changes', async () => {
      await createTopic('first', 'body\n');
      await createTopic('second');
      await createBlock('P1', 'A');
      const before = await state();
      const response = await board.get(`${API}/topics`).expect(200);
      expect(response.body).toEqual([
        { id: 'P1', title: 'first', body: 'body\n', blocks: [{ id: 'K1', title: 'A' }] },
        { id: 'P2', title: 'second', body: '', blocks: [] },
      ]);
      expect(() => routes['topics.list'].response.schema.parse(response.body)).not.toThrow();
      expect(await state()).toEqual(before);
    });

    it('answers an empty list for a board without topics', async () => {
      expect((await board.get(`${API}/topics`).expect(200)).body).toEqual([]);
    });

    it('leaves out a topic that cannot be read, and keeps the others in order', async () => {
      await createTopic('first');
      await createTopic('broken');
      await createTopic('third');
      await writeFile(
        join(board.root, '.board', 'topics', 'P2', 'topic.md'),
        'A topic.md without frontmatter.\n',
        'utf8',
      );
      const response = await board.get(`${API}/topics`).expect(200);
      expect((response.body as Topic[]).map((topic) => topic.id)).toEqual(['P1', 'P3']);
    });
  });

  describe('deleting a topic (ADR-0032 §4)', () => {
    it('deletes an empty topic: 200, topic.deleted, the id is not reused', async () => {
      await createTopic();
      expect((await board.del(`${API}/topics/P1`).expect(200)).body).toEqual({ deleted: true });
      expect(await board.storage.getTopic('P1')).toBeNull();
      expect(board.events.last()).toEqual({ type: 'topic.deleted', topicId: 'P1' });
      expect((await createTopic()).id).toBe('P2');
    });

    it('answers 409 TOPIC_NOT_EMPTY for a topic with a task, and changes nothing', async () => {
      await createTopic();
      await createTask({ topic: 'P1' });
      const before = await state();
      const response = await board.del(`${API}/topics/P1`).expect(409);
      expect(await errorCode(response)).toBe('TOPIC_NOT_EMPTY');
      expect(await state()).toEqual(before);
    });

    it('answers 409 for a topic with only an empty block, and changes nothing', async () => {
      await createTopic();
      await createBlock('P1');
      const before = await state();
      const response = await board.del(`${API}/topics/P1`).expect(409);
      expect(await errorCode(response)).toBe('TOPIC_NOT_EMPTY');
      expect(errorResponseSchema.parse(response.body).error.details).toMatchObject({
        blocks: ['K1'],
      });
      expect(await state()).toEqual(before);
    });

    it('answers 409 for a topic with a block that has a task, and changes nothing', async () => {
      await createTopic();
      const block = await createBlock('P1');
      await createTask({ topic: 'P1', block: block.id });
      const before = await state();
      expect(await errorCode(await board.del(`${API}/topics/P1`).expect(409))).toBe(
        'TOPIC_NOT_EMPTY',
      );
      expect(await state()).toEqual(before);
    });

    it('does not touch the tasks of other topics, and deletes once it is empty', async () => {
      await createTopic();
      await createTopic('second');
      const block = await createBlock('P1');
      const task = await createTask({ topic: 'P1', block: block.id });
      await board.del(`${API}/topics/P2`).expect(200);
      await board.del(`${API}/topics/P1`).expect(409);
      await board.del(`${API}/tasks/${task}`).expect(200);
      await board.del(`${API}/topics/P1`).expect(409);
      await board.del(`${API}/topics/P1/blocks/${block.id}`).expect(200);
      await board.del(`${API}/topics/P1`).expect(200);
      expect(await board.storage.getTopic('P1')).toBeNull();
    });
  });

  describe('blocks', () => {
    it('creates a block at the end: 201, topic.updated with the topic', async () => {
      await createTopic();
      const first = await board.post(`${API}/topics/P1/blocks`, { title: 'A' }).expect(201);
      expect(first.body).toEqual({ id: 'K1', title: 'A' });
      await createBlock('P1', 'B');
      expect((await board.storage.getTopic('P1'))?.blocks.map((b) => b.title)).toEqual(['A', 'B']);
      expect(board.events.last()).toEqual({
        type: 'topic.updated',
        topic: await board.storage.getTopic('P1'),
      });
    });

    it('gives block ids that are unique across topics', async () => {
      await createTopic();
      await createTopic('second');
      const ids = [
        (await createBlock('P1')).id,
        (await createBlock('P2')).id,
        (await createBlock('P1')).id,
        (await createBlock('P2')).id,
      ];
      expect(ids).toEqual(['K1', 'K2', 'K3', 'K4']);
    });

    it('refuses a block for a topic that does not exist, or a blank title', async () => {
      await createTopic();
      const missing = await board.post(`${API}/topics/P9/blocks`, { title: 'x' }).expect(404);
      expect(await errorCode(missing)).toBe('TOPIC_NOT_FOUND');
      await board.post(`${API}/topics/P1/blocks`, { title: '' }).expect(400);
      await board.post(`${API}/topics/P1/blocks`, { title: 'x', id: 'K7' }).expect(400);
      expect((await board.storage.getTopic('P1'))?.blocks).toEqual([]);
    });

    it('renames a block in place', async () => {
      await createTopic();
      await createBlock('P1', 'A');
      await createBlock('P1', 'B');
      const response = await board.patch(`${API}/topics/P1/blocks/K1`, { title: 'A2' }).expect(200);
      expect(response.body).toEqual({ id: 'K1', title: 'A2' });
      expect((await board.storage.getTopic('P1'))?.blocks).toEqual([
        { id: 'K1', title: 'A2' },
        { id: 'K2', title: 'B' },
      ]);
      expect(board.events.types().at(-1)).toBe('topic.updated');
    });

    it('answers 404 BLOCK_NOT_FOUND for a block that is not in that topic', async () => {
      await createTopic();
      await createTopic('second');
      await createBlock('P1');
      const before = await state();
      const other = await board.patch(`${API}/topics/P2/blocks/K1`, { title: 'x' }).expect(404);
      expect(await errorCode(other)).toBe('BLOCK_NOT_FOUND');
      expect(await errorCode(await board.del(`${API}/topics/P2/blocks/K1`).expect(404))).toBe(
        'BLOCK_NOT_FOUND',
      );
      await board.patch(`${API}/topics/P1/blocks/K9`, { title: 'x' }).expect(404);
      await board.patch(`${API}/topics/P1/blocks/P1`, { title: 'x' }).expect(400);
      expect(await state()).toEqual(before);
    });

    it('reorders the blocks, answers with the topic, and the order survives a read', async () => {
      await createTopic();
      for (const title of ['A', 'B', 'C']) await createBlock('P1', title);
      const response = await board
        .put(`${API}/topics/P1/blocks/order`, { blocks: ['K3', 'K1', 'K2'] })
        .expect(200);
      expect((response.body as Topic).blocks.map((b) => b.id)).toEqual(['K3', 'K1', 'K2']);
      expect((await board.storage.getTopic('P1'))?.blocks.map((b) => b.id)).toEqual([
        'K3',
        'K1',
        'K2',
      ]);
      expect(board.events.last()).toEqual({
        type: 'topic.updated',
        topic: await board.storage.getTopic('P1'),
      });
    });

    it('refuses an order that is not exactly the blocks of the topic: 400, nothing changes', async () => {
      await createTopic();
      await createTopic('second');
      for (const title of ['A', 'B']) await createBlock('P1', title);
      await createBlock('P2', 'C');
      const before = await state();
      for (const blocks of [['K1'], ['K1', 'K1'], ['K1', 'K2', 'K3'], ['K2', 'K9'], []]) {
        const response = await board.put(`${API}/topics/P1/blocks/order`, { blocks }).expect(400);
        expect(await errorCode(response)).toBe('INVALID_REQUEST');
      }
      await board.put(`${API}/topics/P1/blocks/order`, { blocks: 'K1' }).expect(400);
      await board.put(`${API}/topics/P9/blocks/order`, { blocks: ['K1'] }).expect(404);
      expect(await state()).toEqual(before);
    });

    it('deletes a block that has no tasks', async () => {
      await createTopic();
      for (const title of ['A', 'B', 'C']) await createBlock('P1', title);
      expect((await board.del(`${API}/topics/P1/blocks/K2`).expect(200)).body).toEqual({
        deleted: true,
      });
      expect((await board.storage.getTopic('P1'))?.blocks.map((b) => b.id)).toEqual(['K1', 'K3']);
      expect(board.events.last()).toEqual({
        type: 'topic.updated',
        topic: await board.storage.getTopic('P1'),
      });
      expect((await createBlock('P1')).id).toBe('K4');
    });

    it('answers 409 BLOCK_NOT_EMPTY for a block with a task, and changes nothing', async () => {
      await createTopic();
      await createBlock('P1');
      const task = await createTask({ topic: 'P1', block: 'K1' });
      const before = await state();
      const response = await board.del(`${API}/topics/P1/blocks/K1`).expect(409);
      expect(await errorCode(response)).toBe('BLOCK_NOT_EMPTY');
      expect(errorResponseSchema.parse(response.body).error.details).toMatchObject({
        tasks: [task],
      });
      expect(await state()).toEqual(before);
    });
  });

  it('publishes exactly the topic.* events of the operations that succeeded, in order', async () => {
    await createTopic();
    await createBlock('P1', 'A');
    await createBlock('P1', 'B');
    await board.patch(`${API}/topics/P1/blocks/K1`, { title: 'A2' });
    await board.put(`${API}/topics/P1/blocks/order`, { blocks: ['K2', 'K1'] });
    await board.del(`${API}/topics/P1/blocks/K2`);
    await board.del(`${API}/topics/P1/blocks/K1`);
    await board.patch(`${API}/topics/P1`, { title: 'M2' });
    await board.del(`${API}/topics/P1`);
    expect(board.events.types()).toEqual([
      'topic.created',
      'topic.updated',
      'topic.updated',
      'topic.updated',
      'topic.updated',
      'topic.updated',
      'topic.updated',
      'topic.updated',
      'topic.deleted',
    ]);
    expect(board.events.last()).toEqual({ type: 'topic.deleted', topicId: 'P1' });
  });

  it('keeps the other routes of the topic paths on the methods they allow', async () => {
    await createTopic();
    const response = await board.put(`${API}/topics/P1`, { title: 'x' }).expect(405);
    expect(response.headers.allow).toContain('PATCH');
    expect(response.headers.allow).toContain('DELETE');
  });

  it('needs the session token to write', async () => {
    await board.agent().post(`${API}/topics`).send({ title: 'x' }).expect(401);
    expect(await board.storage.getTopic('P1')).toBeNull();
  });
});
