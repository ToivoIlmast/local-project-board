import { useEffect, useState } from 'react';
import { useBoard } from '../../../api/react';
import { Markdown } from '../../../shared/lib/Markdown';
import { Button, ErrorState, Spinner } from '../../../shared/ui/index';

export interface DocumentViewProps {
  taskId: string;
  name: string;
  onClose: () => void;
}

/**
 * A document as what it is. Markdown is rendered; an `.html` document is shown in a frame
 * the server sandboxes, so a page written by an agent cannot touch the board (ADR-0023).
 */
export function DocumentView({ taskId, name, onClose }: DocumentViewProps) {
  const { client } = useBoard();
  const html = name.endsWith('.html');
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (html) return undefined;
    let alive = true;
    client.readDocument(taskId, name).then(
      (content) => alive && setText(content),
      (failure: Error) => alive && setError(failure.message),
    );
    return () => {
      alive = false;
    };
  }, [client, taskId, name, html]);

  return (
    <section className="document" aria-label={`Document ${name}`}>
      <header className="document__head">
        <h4 className="document__name">{name}</h4>
        <Button size="small" onClick={onClose}>
          Close
        </Button>
      </header>
      {html ? (
        <iframe
          className="document__frame"
          title={`Document ${name}`}
          src={client.documentUrl(taskId, name)}
          // The server sandboxes it too (ADR-0023); this page says the same thing itself,
          // and `allow-same-origin` is exactly what must never be here.
          sandbox="allow-scripts"
        />
      ) : error !== undefined ? (
        <ErrorState title="This document could not be read" message={error} />
      ) : text === null ? (
        <Spinner label="Loading the document…" />
      ) : (
        <Markdown>{text}</Markdown>
      )}
    </section>
  );
}
