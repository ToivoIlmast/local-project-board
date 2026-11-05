import type { Block, Topic } from '../model/topic.js';
import type { EventSink, NewBlock, NewTopic, Storage, TopicPatch } from '../ports.js';

export interface TopicServiceOptions {
  storage: Storage;
  events: EventSink;
}

/** The body is optional: a topic may be only a title to begin with. */
export interface CreateTopicInput {
  title: string;
  body?: string | undefined;
}

/**
 * Writes of topics and blocks (ADR-0032 §4). The rules (what may be deleted, which order is
 * whole) are the provider's, kept inside its one-at-a-time section; this announces what it did,
 * after the write and only when there was one. A block change is a change of its topic, so it is
 * announced as `topic.updated` with the topic as it is then.
 */
export interface TopicService {
  /** Every topic that can be read, by number. */
  list(): Promise<Topic[]>;
  create(input: CreateTopicInput): Promise<Topic>;
  update(id: string, patch: TopicPatch): Promise<Topic>;
  remove(id: string): Promise<void>;
  createBlock(topicId: string, input: NewBlock): Promise<Block>;
  updateBlock(topicId: string, blockId: string, patch: NewBlock): Promise<Block>;
  reorderBlocks(topicId: string, order: readonly string[]): Promise<Topic>;
  removeBlock(topicId: string, blockId: string): Promise<void>;
}

export function createTopicService({ storage, events }: TopicServiceOptions): TopicService {
  /** The topic after a block change, read back so the event carries what is stored. */
  async function announce(topicId: string): Promise<void> {
    const topic = await storage.getTopic(topicId);
    if (topic) events.publish({ type: 'topic.updated', topic });
  }

  return {
    list: () => storage.listTopics(),

    async create(input) {
      const topic = await storage.createTopic({
        title: input.title,
        body: input.body ?? '',
      } satisfies NewTopic);
      events.publish({ type: 'topic.created', topic });
      return topic;
    },

    async update(id, patch) {
      const topic = await storage.updateTopic(id, patch);
      events.publish({ type: 'topic.updated', topic });
      return topic;
    },

    async remove(id) {
      await storage.deleteTopic(id);
      events.publish({ type: 'topic.deleted', topicId: id });
    },

    async createBlock(topicId, input) {
      const block = await storage.createBlock(topicId, input);
      await announce(topicId);
      return block;
    },

    async updateBlock(topicId, blockId, patch) {
      const block = await storage.updateBlock(topicId, blockId, patch);
      await announce(topicId);
      return block;
    },

    async reorderBlocks(topicId, order) {
      const topic = await storage.reorderBlocks(topicId, order);
      events.publish({ type: 'topic.updated', topic });
      return topic;
    },

    async removeBlock(topicId, blockId) {
      await storage.deleteBlock(topicId, blockId);
      await announce(topicId);
    },
  };
}
