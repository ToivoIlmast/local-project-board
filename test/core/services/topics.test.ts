import { boardEventSchema } from '../../../src/core/events.js';
import type { BoardError } from '../../../src/core/errors.js';
import type { Storage } from '../../../src/core/ports.js';
import { createTopicService, type TopicService } from '../../../src/core/services/topics.js';
import { recordingEventSink, type RecordingEventSink } from '../../support/events.js';
import { createMemoryStore, inMemoryStorage } from '../../support/inMemoryStorage.js';

describe('TopicService', () => {
  let storage: Storage;
  let events: RecordingEventSink;
  let topics: TopicService;

  beforeEach(async () => {
    storage = inMemoryStorage(createMemoryStore());
    await storage.init();
    events = recordingEventSink();
    topics = createTopicService({ storage, events });
  });

  async function code(action: Promise<unknown>): Promise<string> {
    return action.then(
      () => 'no error',
      (error: unknown) => (error as BoardError).code,
    );
  }

  it('creates a topic and announces it with the topic as stored', async () => {
    const topic = await topics.create({ title: 'M1', body: 'Goal\n' });
    expect(topic).toEqual({ id: 'P1', title: 'M1', body: 'Goal\n', blocks: [] });
    expect(events.events).toEqual([{ type: 'topic.created', topic }]);
    expect(await storage.getTopic('P1')).toEqual(topic);
  });

  it('defaults the body to empty', async () => {
    expect((await topics.create({ title: 'M1' })).body).toBe('');
  });

  it('updates a topic and announces the whole topic', async () => {
    await topics.create({ title: 'M1' });
    const updated = await topics.update('P1', { title: 'M2' });
    expect(events.events.at(-1)).toEqual({ type: 'topic.updated', topic: updated });
    expect(updated.title).toBe('M2');
  });

  it('announces block changes as topic.updated with the topic after the change', async () => {
    await topics.create({ title: 'M1' });
    const block = await topics.createBlock('P1', { title: 'A' });
    await topics.createBlock('P1', { title: 'B' });
    await topics.updateBlock('P1', block.id, { title: 'A2' });
    await topics.reorderBlocks('P1', ['K2', 'K1']);
    await topics.removeBlock('P1', 'K2');
    expect(events.types()).toEqual([
      'topic.created',
      'topic.updated',
      'topic.updated',
      'topic.updated',
      'topic.updated',
      'topic.updated',
    ]);
    const published = events.events
      .slice(1)
      .map((event) => (event as { topic: { blocks: unknown[] } }).topic.blocks);
    expect(published).toEqual([
      [{ id: 'K1', title: 'A' }],
      [
        { id: 'K1', title: 'A' },
        { id: 'K2', title: 'B' },
      ],
      [
        { id: 'K1', title: 'A2' },
        { id: 'K2', title: 'B' },
      ],
      [
        { id: 'K2', title: 'B' },
        { id: 'K1', title: 'A2' },
      ],
      [{ id: 'K1', title: 'A2' }],
    ]);
    expect(published.at(-1)).toEqual((await storage.getTopic('P1'))?.blocks);
  });

  it('announces a deleted topic by its id', async () => {
    await topics.create({ title: 'M1' });
    await topics.remove('P1');
    expect(events.events.at(-1)).toEqual({ type: 'topic.deleted', topicId: 'P1' });
    expect(await storage.getTopic('P1')).toBeNull();
  });

  it('announces nothing when a delete is refused, and changes nothing', async () => {
    await topics.create({ title: 'M1' });
    await topics.createBlock('P1', { title: 'empty' });
    const before = structuredClone(await storage.getTopic('P1'));
    const count = events.events.length;
    expect(await code(topics.remove('P1'))).toBe('TOPIC_NOT_EMPTY');
    expect(await code(topics.remove('P9'))).toBe('TOPIC_NOT_FOUND');
    await storage.createTask({
      title: 't',
      status: 'todo',
      rank: 'a0',
      body: '',
      labels: [],
      topic: 'P1',
      block: 'K1',
    });
    expect(await code(topics.removeBlock('P1', 'K1'))).toBe('BLOCK_NOT_EMPTY');
    expect(await code(topics.removeBlock('P1', 'K9'))).toBe('BLOCK_NOT_FOUND');
    expect(await code(topics.reorderBlocks('P1', []))).toBe('INVALID_REQUEST');
    expect(await code(topics.update('P9', { title: 'x' }))).toBe('TOPIC_NOT_FOUND');
    expect(events.events).toHaveLength(count);
    expect(await storage.getTopic('P1')).toEqual(before);
  });

  it('publishes only events the contract describes', async () => {
    await topics.create({ title: 'M1' });
    await topics.createBlock('P1', { title: 'A' });
    await topics.remove('P1').catch(() => undefined);
    await topics.removeBlock('P1', 'K1');
    await topics.remove('P1');
    expect(events.types()).toEqual([
      'topic.created',
      'topic.updated',
      'topic.updated',
      'topic.deleted',
    ]);
    for (const event of events.events) expect(() => boardEventSchema.parse(event)).not.toThrow();
  });

  it('announces nothing when the storage fails to write', async () => {
    await topics.create({ title: 'M1' });
    const count = events.events.length;
    const failing = { ...storage, updateTopic: () => Promise.reject(new Error('disk full')) };
    const service = createTopicService({ storage: failing, events });
    await expect(service.update('P1', { title: 'x' })).rejects.toThrow('disk full');
    expect(events.events).toHaveLength(count);
  });
});
