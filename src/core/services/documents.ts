import { BoardError } from '../errors.js';
import type { DocumentMeta } from '../model/document.js';
import type { EventSink, Storage } from '../ports.js';

export interface DocumentServiceOptions {
  storage: Storage;
  events: EventSink;
}

export interface DocumentService {
  list(taskId: string): Promise<DocumentMeta[]>;
  read(taskId: string, name: string): Promise<string>;
  write(taskId: string, name: string, content: string): Promise<DocumentMeta>;
  remove(taskId: string, name: string): Promise<void>;
}

export function createDocumentService({
  storage,
  events,
}: DocumentServiceOptions): DocumentService {
  return {
    list: (taskId) => storage.listDocuments(taskId),

    async read(taskId, name) {
      const content = await storage.readDocument(taskId, name);
      if (content === null) {
        throw new BoardError('DOCUMENT_NOT_FOUND', `Document "${name}" does not exist.`, {
          taskId,
          name,
        });
      }
      return content;
    },

    async write(taskId, name, content) {
      const document = await storage.writeDocument(taskId, name, content);
      events.publish({ type: 'document.written', document });
      return document;
    },

    async remove(taskId, name) {
      await storage.deleteDocument(taskId, name);
      events.publish({ type: 'document.deleted', taskId, name });
    },
  };
}
