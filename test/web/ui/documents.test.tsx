import { screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '../../../src/web/api/index';
import { aTask } from '../support/fixtures';
import { renderBoard } from '../support/render';

const task = aTask({ id: 'T1', title: 'Extract the git adapter' });

async function openTask() {
  const rendered = await renderBoard({
    tasks: [task],
    documents: [
      { taskId: 'T1', name: 'plan.md', content: '# Plan\n\n1. Move the parser.\n' },
      { taskId: 'T1', name: 'design.html', content: '<h1>Design</h1>' },
    ],
  });
  await rendered.user.click(screen.getByRole('button', { name: 'Extract the git adapter' }));
  await screen.findByRole('complementary', { name: 'Task T1' });
  return rendered;
}

describe('the documents of a task', () => {
  it('are listed when the task is opened', async () => {
    await openTask();

    const documents = screen.getByRole('region', { name: 'Documents' });
    expect(within(documents).getByRole('button', { name: 'plan.md' })).toBeInTheDocument();
    expect(within(documents).getByRole('button', { name: 'design.html' })).toBeInTheDocument();
  });

  it('show markdown as markdown', async () => {
    const { user } = await openTask();

    await user.click(screen.getByRole('button', { name: 'plan.md' }));

    const view = await screen.findByRole('region', { name: 'Document plan.md' });
    expect(within(view).getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(within(view).getByRole('listitem')).toHaveTextContent('Move the parser');
  });

  it('show an .html document in a frame the server sandboxes, never inline (ADR-0023)', async () => {
    const { user } = await openTask();

    await user.click(screen.getByRole('button', { name: 'design.html' }));

    const frame = await screen.findByTitle('Document design.html');
    expect(frame).toHaveAttribute('src', '/api/v1/tasks/T1/documents/design.html');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    // The document's own markup is never part of this page.
    expect(document.body.innerHTML).not.toContain('<h1>Design</h1>');
  });

  it('are written through the board', async () => {
    const { user, board } = await openTask();

    await user.click(screen.getByRole('button', { name: 'New document' }));
    const dialog = screen.getByRole('dialog', { name: 'New document' });
    await user.type(within(dialog).getByLabelText('File name'), 'notes.md');
    await user.type(within(dialog).getByLabelText('Content'), '# Notes');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'notes.md' })).toBeInTheDocument();
    expect(board.documents.get('T1/notes.md')?.content).toBe('# Notes');
  });

  it('are edited with what the board has, and keep their name', async () => {
    const { user, board } = await openTask();

    await user.click(screen.getByRole('button', { name: 'Edit plan.md' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit plan.md' });
    expect(within(dialog).getByLabelText('File name')).toBeDisabled();
    const content = within(dialog).getByLabelText('Content');
    expect(content).toHaveValue('# Plan\n\n1. Move the parser.\n');
    await user.clear(content);
    await user.type(content, '# Plan v2');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(board.documents.get('T1/plan.md')?.content).toBe('# Plan v2'));
  });

  it('are deleted only after the question is answered', async () => {
    const { user, board } = await openTask();

    await user.click(screen.getByRole('button', { name: 'Delete plan.md' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Delete plan.md?' })).getByRole('button', {
        name: 'Delete',
      }),
    );

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'plan.md' })).not.toBeInTheDocument(),
    );
    expect(board.documents.has('T1/plan.md')).toBe(false);
  });

  it('say what the board said when a name is refused', async () => {
    const { user, board } = await openTask();
    board.fail(
      'writeDocument',
      new ApiError(422, 'INVALID_DOCUMENT_NAME', 'A document name must end in .md or .html.'),
    );

    await user.click(screen.getByRole('button', { name: 'New document' }));
    const dialog = screen.getByRole('dialog', { name: 'New document' });
    await user.type(within(dialog).getByLabelText('File name'), 'notes.txt');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('.md or .html');
  });

  it('show a document another process wrote, without a reload', async () => {
    const { board } = await openTask();

    board.emit({
      type: 'document.written',
      document: { taskId: 'T1', name: 'audit.md', size: 12, updatedAt: '2026-09-22T10:00:00.000Z' },
    });

    expect(await screen.findByRole('button', { name: 'audit.md' })).toBeInTheDocument();
  });

  it('say when there are none', async () => {
    const { user } = await renderBoard({ tasks: [task] });

    await user.click(screen.getByRole('button', { name: 'Extract the git adapter' }));

    expect(await screen.findByText('No documents')).toBeInTheDocument();
  });

  it('say that they are being read', async () => {
    const rendered = await renderBoard({ tasks: [task] });
    const release = rendered.board.hold('listDocuments');

    await rendered.user.click(screen.getByRole('button', { name: 'Extract the git adapter' }));

    expect(await screen.findByText('Loading documents…')).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.getByText('No documents')).toBeInTheDocument());
  });
});
