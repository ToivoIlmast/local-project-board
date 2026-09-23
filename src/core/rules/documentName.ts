// A document name is a plain file name inside the task directory: no paths, no hidden files.
const DOCUMENT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}\.(md|html)$/;

// The Markdown storage keeps task metadata in task.md next to the documents.
// Case-insensitive so that TASK.md can't overwrite it on macOS/Windows.
const RESERVED = new Set(['task.md']);

export type DocumentFormat = 'md' | 'html';

export function isDocumentName(name: string): boolean {
  return DOCUMENT_NAME.test(name) && !RESERVED.has(name.toLowerCase());
}

export function documentFormat(name: string): DocumentFormat {
  return name.endsWith('.html') ? 'html' : 'md';
}
