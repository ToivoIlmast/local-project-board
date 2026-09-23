import { documentFormat, isDocumentName } from '../../../src/core/rules/documentName.js';

describe('isDocumentName', () => {
  it.each(['notes.md', 'plan-v2.md', 'a.b.md', 'A_1.md', 'report.html', `${'x'.repeat(64)}.md`])(
    'accepts %p',
    (name) => {
      expect(isDocumentName(name)).toBe(true);
    },
  );

  it.each([
    ['', 'empty'],
    ['..', 'parent directory'],
    ['../x.md', 'traversal'],
    ['a/b.md', 'slash'],
    ['a\\b.md', 'backslash'],
    ['a\0.md', 'NUL'],
    ['/abs.md', 'absolute path'],
    ['C:\\x.md', 'drive path'],
    ['.hidden.md', 'hidden file'],
    ['..md', 'leading dot'],
    ['notes.txt', 'other extension'],
    ['notes.MD', 'uppercase extension'],
    ['notes', 'no extension'],
    ['my notes.md', 'space'],
    [`${'x'.repeat(65)}.md`, 'too long'],
    ['task.md', 'reserved: task metadata file'],
    ['TASK.md', 'reserved, case-insensitive file systems'],
  ])('rejects %p (%s)', (name) => {
    expect(isDocumentName(name)).toBe(false);
  });
});

describe('documentFormat', () => {
  it('derives the format from the extension', () => {
    expect(documentFormat('notes.md')).toBe('md');
    expect(documentFormat('report.html')).toBe('html');
  });
});
