import { useState } from 'react';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { formatDate } from '../../../shared/lib/format';
import { Badge, Button, ConfirmDialog, EmptyState } from '../../../shared/ui/index';
import { ReportView } from './ReportView';

export interface ReportsPanelProps {
  onClose: () => void;
}

/** What an agent left behind: audits, summaries, anything it wrote as a file (§10). */
export function ReportsPanel({ onClose }: ReportsPanelProps) {
  const { state, store } = useBoard();
  const [open, setOpen] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = useAsyncAction((id: string) => store.deleteReport(id));
  // The board stores reports oldest first; the newest one is the one you want to read.
  const reports = [...state.reports].reverse();

  return (
    <aside className="panel" aria-label="Reports">
      <header className="panel__head">
        <h2 className="panel__title">Reports</h2>
        <Button size="small" onClick={onClose}>
          Close
        </Button>
      </header>

      {reports.length === 0 ? (
        <EmptyState title="No reports">
          <p>An agent can store one through the API.</p>
        </EmptyState>
      ) : (
        <ul className="reports__list">
          {reports.map((report) => (
            <li key={report.id} className="reports__item">
              <button
                type="button"
                className="reports__open"
                onClick={() => setOpen(open === report.id ? null : report.id)}
              >
                {report.title}
              </button>
              <Badge>{report.format}</Badge>
              <span className="reports__date">{formatDate(report.createdAt)}</span>
              <Button
                size="small"
                aria-label={`Delete ${report.id}`}
                onClick={() => setDeleting(report.id)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {open === null ? null : <ReportView key={open} id={open} onClose={() => setOpen(null)} />}

      {deleting === null ? null : (
        <ConfirmDialog
          title={`Delete ${deleting}?`}
          message="The report file is removed from the board. This cannot be undone."
          confirmLabel="Delete"
          pending={remove.pending}
          error={remove.error}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            void remove.run(deleting).then((ok) => {
              if (!ok) return;
              if (open === deleting) setOpen(null);
              setDeleting(null);
            });
          }}
        />
      )}
    </aside>
  );
}
