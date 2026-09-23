import type { Storage } from '../../src/core/ports.js';
import { runStorageConformance } from '../conformance/storage.js';
import {
  createMemoryStore,
  inMemoryStorage,
  type MemoryStore,
} from '../support/inMemoryStorage.js';

const stores = new Map<Storage, MemoryStore>();

describe('in-memory storage', () => {
  it('drops the documents of a deleted task', async () => {
    const store = createMemoryStore();
    const storage = inMemoryStorage(store);
    await storage.init();
    const task = await storage.createTask({
      title: 'x',
      status: 'todo',
      rank: 'a0',
      body: '',
      labels: [],
    });
    await storage.writeDocument(task.id, 'plan.md', '# Plan\n');
    await storage.deleteTask(task.id);
    expect(store.documents.has(task.id)).toBe(false);
  });
});

runStorageConformance({
  name: 'in-memory',
  create: async (options = {}) => {
    const store = createMemoryStore();
    const storage = inMemoryStorage(store, options);
    stores.set(storage, store);
    return storage;
  },
  reopen: async (previous) => {
    const store = stores.get(previous);
    if (!store) throw new Error('Unknown storage instance');
    const storage = inMemoryStorage(store);
    stores.set(storage, store);
    return storage;
  },
  cleanup: async () => {
    stores.clear();
  },
});
