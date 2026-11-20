import { useEffect, useState } from 'react';
import { useBoard } from '../api/react';
import { useCopyToClipboard } from '../shared/hooks/useCopyToClipboard';
import { useT } from '../shared/i18n/index';
import { Button, ErrorState, Panel, Spinner, Text } from '../shared/ui/index';
import { useTaskT } from './tasks/i18n/details';

export interface InstructionsPanelProps {
  onClose: () => void;
}

/**
 * The instructions the board generates for an agent, taken from the board itself — the page
 * keeps no copy of them (§16). They hold no token: an agent asks `GET /session` for it, and the
 * instructions say how to do that without leaving it anywhere (ADR-0008).
 */
export function InstructionsPanel({ onClose }: InstructionsPanelProps) {
  const t = useTaskT();
  const common = useT();
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
    <Panel label={t('ai.instructions.title')}>
      <header className="panel__head">
        <h2 className="panel__title">{t('ai.instructions.title')}</h2>
        <Button size="small" onClick={onClose}>
          {common('ui.close')}
        </Button>
      </header>

      <Text tone="muted">{t('ai.instructions.intro')}</Text>

      {error !== undefined ? (
        <ErrorState title={t('ai.instructions.failed')} message={error} />
      ) : text === null ? (
        <Spinner label={t('ai.instructions.loading')} />
      ) : (
        <>
          <div className="panel__actions">
            <Button variant="primary" onClick={() => void copy(text)}>
              {state === 'copied'
                ? t('ai.instructions.copied')
                : state === 'failed'
                  ? t('ai.instructions.copyFailed')
                  : t('ai.instructions.copy')}
            </Button>
          </div>
          <pre
            className="instructions"
            tabIndex={0}
            role="region"
            aria-label={t('ai.instructions.region')}
          >
            {text}
          </pre>
        </>
      )}
    </Panel>
  );
}
