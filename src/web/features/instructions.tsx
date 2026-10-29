import { useEffect, useState } from 'react';
import { useBoard } from '../api/react';
import { useCopyToClipboard } from '../shared/hooks/useCopyToClipboard';
import { Button, ErrorState, Panel, Spinner, Text } from '../shared/ui/index';

export interface InstructionsPanelProps {
  onClose: () => void;
}

/**
 * The instructions the board generates for an agent, taken from the board itself — the page
 * keeps no copy of them (§16). They hold no token: an agent asks `GET /session` for it, and the
 * instructions say how to do that without leaving it anywhere (ADR-0008).
 */
export function InstructionsPanel({ onClose }: InstructionsPanelProps) {
  const { client } = useBoard();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const { copy, state } = useCopyToClipboard();

  useEffect(() => {
    let alive = true;
    client.instructions().then(
      (instructions) => alive && setText(instructions),
      (failure: Error) => alive && setError(failure.message),
    );
    return () => {
      alive = false;
    };
  }, [client]);

  return (
    <Panel label="AI instructions">
      <header className="panel__head">
        <h2 className="panel__title">AI instructions</h2>
        <Button size="small" onClick={onClose}>
          Close
        </Button>
      </header>

      <Text tone="muted">
        Everything an agent needs to use this board through its API. It holds no token, only a
        placeholder: the agent gets the token from the board itself, as the text explains.
      </Text>

      {error !== undefined ? (
        <ErrorState title="The instructions could not be read" message={error} />
      ) : text === null ? (
        <Spinner label="Loading the instructions…" />
      ) : (
        <>
          <div className="panel__actions">
            <Button variant="primary" onClick={() => void copy(text)}>
              {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
            </Button>
          </div>
          <pre className="instructions" tabIndex={0} role="region" aria-label="Instructions text">
            {text}
          </pre>
        </>
      )}
    </Panel>
  );
}
