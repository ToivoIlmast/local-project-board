import { useMemo } from 'react';
import type { Task } from '../../../../contract/v1/index';
import { Button, Text } from '../../../shared/ui/index';
import { useTaskT } from '../i18n/details';
import {
  buildConsoleItems,
  consoleStatus,
  messageStatusText,
  processText,
  turnText,
  userNote,
  type ConsoleItem,
} from '../model/consoleView';
import { useConsole } from '../model/useConsole';

export interface TaskConsoleProps {
  task: Task;
}

type ItemOf<K extends ConsoleItem['kind']> = Extract<ConsoleItem, { kind: K }>;

/**
 * The console of a Console mode run, read only (plan C9, §10): what the person said, what Claude
 * said and did, what the tools answered and what the subagents did. Every text of the journal is
 * drawn as text — React escapes it, and nothing here sets HTML — and each kind of item names its
 * role in words, so the roles are told apart without the colours.
 */
export function TaskConsole({ task }: TaskConsoleProps) {
  const run = task.aiRun;
  if (run?.console !== true || run.runId === undefined) return null;
  return <ConsoleFeed taskId={task.id} runId={run.runId} />;
}

function ConsoleFeed({ taskId, runId }: { taskId: string; runId: number }) {
  const t = useTaskT();
  const { journal, error, retry } = useConsole(taskId, runId);
  const items = useMemo(
    () => (journal === undefined ? [] : buildConsoleItems(journal.entries, journal.state)),
    [journal],
  );
  const status = journal === undefined ? undefined : consoleStatus(journal.state);
  const heading = `console-${taskId}`;

  return (
    <section className="ai console" aria-labelledby={heading}>
      <h3 className="ai__title" id={heading}>
        {t('console.title')}
      </h3>
      {status === undefined ? null : (
        <p className={`console__status console__status--${status.tone}`} role="status">
          {status.text}
        </p>
      )}
      {error === undefined ? null : (
        <div className="notice" role="alert">
          <span>{error}</span>
          <Button size="small" onClick={retry}>
            {t('console.retry')}
          </Button>
        </div>
      )}
      {journal === undefined ? (
        error === undefined ? (
          <Text tone="muted">{t('console.loading')}</Text>
        ) : null
      ) : items.length === 0 ? (
        <Text tone="muted">{t('console.empty')}</Text>
      ) : (
        <ol className="console__feed" aria-label={t('console.feed')}>
          {items.map((item) => (
            <ConsoleRow key={item.key} item={item} />
          ))}
        </ol>
      )}
    </section>
  );
}

function Role({ children }: { children: string }) {
  return <span className="console__role">{children}</span>;
}

function ConsoleRow({ item }: { item: ConsoleItem }) {
  const t = useTaskT();
  switch (item.kind) {
    case 'user': {
      const note = userNote(item);
      const status = messageStatusText(item.status);
      return (
        <li className="console__item console__item--user">
          <Role>{t('console.role.user')}</Role>
          <p className="console__text">{item.text}</p>
          {note === undefined ? null : <span className="console__note">{note}</span>}
          {status === undefined ? null : <span className="console__note">{status}</span>}
        </li>
      );
    }
    case 'assistant':
      return (
        <li className="console__item console__item--assistant">
          <Role>{t('console.role.assistant')}</Role>
          <p className="console__text">{item.text}</p>
        </li>
      );
    case 'tool':
      return item.tool === 'Agent' || item.children.length > 0 ? (
        <li className="console__item console__item--subagent">
          <SubagentCard item={item} />
        </li>
      ) : (
        <li className="console__item console__item--tool">
          <ToolCall item={item} />
        </li>
      );
    case 'job':
      return (
        <li className="console__item console__item--job">
          <Role>{t('console.role.job')}</Role>
          <span className="console__text">{item.description}</span>
          <span className="console__note">
            {t(item.ended ? 'console.job.completed' : 'console.job.running')}
          </span>
        </li>
      );
    case 'turn':
      return (
        <li className={`console__item console__item--turn${item.isError ? ' is-error' : ''}`}>
          <span className="console__note">{turnText(item)}</span>
        </li>
      );
    case 'notice':
      return <NoticeRow item={item} />;
    case 'series':
      return (
        <li className="console__item console__item--series">
          <span className="console__note">
            {t(item.what === 'stderr' ? 'console.series.stderr' : 'console.series.unknown', {
              count: item.count,
            })}
          </span>
        </li>
      );
    case 'denied':
      return (
        <li className="console__item console__item--denied">
          <Role>{t('console.role.denied')}</Role>
          <strong className="console__tool">{item.tool}</strong>
          <p className="console__text">{item.message}</p>
        </li>
      );
    case 'process':
      return (
        <li className="console__item console__item--process">
          <Role>{t('console.role.process')}</Role>
          <span className="console__text">{processText(item)}</span>
        </li>
      );
  }
}

/** The call of a tool, and what it answered, in the same item. */
function ToolCall({ item }: { item: ItemOf<'tool'> }) {
  const t = useTaskT();
  return (
    <>
      {item.tool === undefined ? null : (
        <>
          <Role>{t('console.role.tool')}</Role>
          <strong className="console__tool">{item.tool}</strong>
          {item.summary === undefined || item.summary === '' ? null : (
            <code className="console__summary">{item.summary}</code>
          )}
        </>
      )}
      {item.result === undefined ? null : (
        <div className={`console__result${item.result.isError ? ' is-error' : ''}`}>
          <Role>{t(item.result.isError ? 'console.role.resultError' : 'console.role.result')}</Role>
          <pre className="console__preview">{item.result.preview}</pre>
        </div>
      )}
    </>
  );
}

/** The `Agent` call, with what the subagent did in it, however late it was said. */
function SubagentCard({ item }: { item: ItemOf<'tool'> }) {
  const t = useTaskT();
  return (
    <div role="group" aria-label={t('console.subagent.label', { summary: item.summary ?? '' })}>
      <Role>{t('console.role.subagent')}</Role>
      {item.summary === undefined || item.summary === '' ? null : (
        <span className="console__summary">{item.summary}</span>
      )}
      {item.children.length === 0 ? null : (
        <ol className="console__feed console__feed--nested">
          {item.children.map((child) => (
            <ConsoleRow key={child.key} item={child} />
          ))}
        </ol>
      )}
      {item.result === undefined ? null : (
        <div className={`console__result${item.result.isError ? ' is-error' : ''}`}>
          <Role>{t(item.result.isError ? 'console.role.resultError' : 'console.role.result')}</Role>
          <pre className="console__preview">{item.result.preview}</pre>
        </div>
      )}
    </div>
  );
}

const LEVEL_MARK = { info: 'ℹ', warning: '⚠', error: '✖' } as const;

function NoticeRow({ item }: { item: ItemOf<'notice'> }) {
  const t = useTaskT();
  return (
    <li className={`console__item console__item--notice console__item--${item.level}`}>
      <span aria-hidden="true">{LEVEL_MARK[item.level]} </span>
      <Role>{t('console.role.notice')}</Role>
      <strong className="console__tool">{t(`console.notice.${item.code}`)}</strong>
      {item.detail === undefined ? null : <span className="console__summary">{item.detail}</span>}
      {item.text === undefined ? null : <span className="console__text">{item.text}</span>}
      {item.count > 1 ? <span className="console__note">×{item.count}</span> : null}
    </li>
  );
}
