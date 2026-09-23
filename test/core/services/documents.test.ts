import type { BoardError } from '../../../src/core/errors.js';
import type { Storage } from '../../../src/core/ports.js';
import {
  createDocumentService,
  type DocumentService,
} from '../../../src/core/services/documents.js';
import { createTaskService } from '../../../src/core/services/tasks.js';
import { recordingEventSink, type RecordingEventSink } from '../../support/events.js';
import { createMemoryStore, inMemoryStorage } from '../../support/inMemoryStorage.js';

describe('DocumentService', () => {
  let storage: Storage;
  let events: RecordingEventSink;
  let documents: DocumentService;
  let taskId: string;

  beforeEach(async () => {
    storage = inMemoryStorage(createMemoryStore());
    await storage.init();
    events = recordingEventSink();
    documents = createDocumentService({ storage, events });
    const tasks = createTaskService({ storage, events, statuses: ['todo'] });
    taskId = (await tasks.create({ title: 'One' })).id;
    events.events.length = 0;
  });

  async function code(action: Promise<unknown>): Promise<string> {
    return action.then(
      () => 'no error',
      (error: unknown) => (error as BoardError).code,
    );
  }

  it('writes, reads and lists a document', async () => {
    const meta = await documents.write(taskId, 'plan.md', '# Plan\n');
    expect(await documents.read(taskId, 'plan.md')).toBe('# Plan\n');
    expect(await documents.list(taskId)).toEqual([meta]);
    expect(events.last()).toEqual({ type: 'document.written', document: meta });
  });

  it('deletes a document and announces it', async () => {
    await documents.write(taskId, 'plan.md', '# Plan\n');
    await documents.remove(taskId, 'plan.md');
    expect(await documents.list(taskId)).toEqual([]);
    expect(events.last()).toEqual({ type: 'document.deleted', taskId, name: 'plan.md' });
  });

  it('fails when the document does not exist', async () => {
    expect(await code(documents.read(taskId, 'missing.md'))).toBe('DOCUMENT_NOT_FOUND');
    expect(await code(documents.remove(taskId, 'missing.md'))).toBe('DOCUMENT_NOT_FOUND');
  });

  it('fails for an unsafe name and announces nothing', async () => {
    expect(await code(documents.write(taskId, '../escape.md', 'x'))).toBe('INVALID_DOCUMENT_NAME');
    expect(events.events).toEqual([]);
  });

  it('fails for a task that does not exist', async () => {
    expect(await code(documents.write('T404', 'plan.md', 'x'))).toBe('TASK_NOT_FOUND');
    expect(await code(documents.list('T404'))).toBe('TASK_NOT_FOUND');
    expect(events.events).toEqual([]);
  });
});
