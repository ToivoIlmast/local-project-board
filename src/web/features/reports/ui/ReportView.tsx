import { useEffect, useState } from 'react';
import { useBoard } from '../../../api/react';
import { Markdown } from '../../../shared/lib/Markdown';
import { Button, ErrorState, Spinner } from '../../../shared/ui/index';

export interface ReportViewProps {
  id: string;
  onClose: () => void;
}

/**
 * An HTML report is written by an agent, so it is never part of this page: it is framed,
 * and the server's own headers sandbox it without `allow-same-origin` (ADR-0023). Markdown
 * reports are rendered here, where there is nothing to sandbox.
 */
export function ReportView({ id, onClose }: ReportViewProps) {
  const { state, client } = useBoard();
  const report = state.reports.find((candidate) => candidate.id === id);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const markdown = report?.format === 'md';

  useEffect(() => {
    if (!markdown) return undefined;
    let alive = true;
    client.readReport(id).then(
      (content) => alive && setText(content),
      (failure: Error) => alive && setError(failure.message),
    );
    return () => {
      alive = false;
    };
  }, [client, id, markdown]);

  return (
    <section className="report" aria-label={`Report ${id}`}>
      <header className="report__head">
        <h3 className="report__title">{report?.title ?? id}</h3>
        <Button size="small" onClick={onClose}>
          Close
        </Button>
      </header>
      {markdown ? (
        error !== undefined ? (
          <ErrorState title="This report could not be read" message={error} />
        ) : text === null ? (
          <Spinner label="Loading the report…" />
        ) : (
          <Markdown>{text}</Markdown>
        )
      ) : (
        <iframe
          className="report__frame"
          title={`Report ${id}`}
          src={client.reportUrl(id)}
          // A report is HTML someone else wrote: it runs in an origin of its own, never in
          // this one. `allow-same-origin` would hand it the board's DOM (ADR-0023).
          sandbox="allow-scripts"
        />
      )}
    </section>
  );
}
