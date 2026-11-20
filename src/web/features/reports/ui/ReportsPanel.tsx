import { useState } from 'react';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { useT } from '../../../shared/i18n/index';
import { formatDate } from '../../../shared/lib/format';
import { Badge, Button, ConfirmDialog, EmptyState, Panel } from '../../../shared/ui/index';
import { useReportsT } from '../i18n';
import { ReportView } from './ReportView';

export interface ReportsPanelProps {
  onClose: () => void;
}

/** What an agent left behind: audits, summaries, anything it wrote as a file (§10). */
export function ReportsPanel({ onClose }: ReportsPanelProps) {
  const { state, store } = useBoard();
  const t = useReportsT();
  const common = useT();
  const [open, setOpen] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = useAsyncAction((id: string) => store.deleteReport(id));
  // The board stores reports oldest first; the newest one is the one you want to read.
  const reports = [...state.reports].reverse();

  return (
    <Panel label={t('title')}>
      <header className="panel__head">
        <h2 className="panel__title">{t('title')}</h2>
        <Button size="small" onClick={onClose}>
          {common('ui.close')}
        </Button>
      </header>

      {reports.length === 0 ? (
        <EmptyState title={t('empty.title')}>
          <p>{t('empty.text')}</p>
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
                aria-label={t('delete.label', { id: report.id })}
                onClick={() => setDeleting(report.id)}
              >
                {common('ui.delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {open === null ? null : <ReportView key={open} id={open} onClose={() => setOpen(null)} />}

      {deleting === null ? null : (
        <ConfirmDialog
          title={t('delete.title', { id: deleting })}
          message={t('delete.message')}
          confirmLabel={common('ui.delete')}
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
    </Panel>
  );
}
