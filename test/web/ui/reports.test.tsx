import { screen, waitFor, within } from '@testing-library/react';
import { aReport } from '../support/fixtures';
import { renderBoard } from '../support/render';

async function openReports(reports = [aReport({ id: 'R1', title: 'Dependency audit' })]) {
  const rendered = await renderBoard({ reports });
  await rendered.user.click(screen.getByRole('button', { name: 'Reports' }));
  await screen.findByRole('complementary', { name: 'Reports' });
  return rendered;
}

describe('the reports an agent left on the board', () => {
  it('are listed newest first', async () => {
    await openReports([
      aReport({ id: 'R1', title: 'First audit' }),
      aReport({ id: 'R2', title: 'Second audit' }),
    ]);

    const panel = screen.getByRole('complementary', { name: 'Reports' });
    const titles = within(panel)
      .getAllByRole('button', { name: /audit/ })
      .map((button) => button.textContent);
    expect(titles).toEqual(['Second audit', 'First audit']);
  });

  it('open in a frame of their own origin, never in this page (ADR-0023)', async () => {
    const { user } = await openReports();

    await user.click(screen.getByRole('button', { name: 'Dependency audit' }));

    const frame = await screen.findByTitle('Report R1');
    expect(frame).toHaveAttribute('src', '/api/v1/reports/R1');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('are rendered as markdown when that is what they are', async () => {
    const { user } = await openReports([aReport({ id: 'R2', title: 'Notes', format: 'md' })]);

    await user.click(screen.getByRole('button', { name: 'Notes' }));

    const view = await screen.findByRole('region', { name: 'Report R2' });
    expect(within(view).getByRole('heading', { name: 'Audit' })).toBeInTheDocument();
    expect(within(view).queryByTitle('Report R2')).not.toBeInTheDocument();
  });

  it('are deleted only after the question is answered', async () => {
    const { user, board } = await openReports();

    await user.click(screen.getByRole('button', { name: 'Delete R1' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByText('No reports')).toBeInTheDocument());
    expect(board.reports).toEqual([]);
  });

  it('show a report an agent stored while the page was open', async () => {
    const { board } = await openReports([]);

    board.emit({ type: 'report.created', report: aReport({ id: 'R9', title: 'Fresh audit' }) });

    expect(await screen.findByRole('button', { name: 'Fresh audit' })).toBeInTheDocument();
  });
});
