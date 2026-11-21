import { useMemo, useRef } from 'react';
import {
  launchState,
  type BlockingReason,
  type Task,
  type Topic,
} from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { withoutArchived } from '../../../api/index';
import { Badge, EmptyState } from '../../../shared/ui/index';
import { NO_TOPIC } from '../../board/index';
import { blockSummary, useReasonText, useSeries, type BlockSummary } from '../../tasks/index';
import { useBlocksT } from '../i18n';
import { BlockMenu } from './BlockMenu';

export interface BlocksViewProps {
  /** `?topic=` of the address: none for All, `none`, or a topic id. */
  topicFilter: string | null;
  onOpen: (id: string) => void;
}

const STATE_TEXT = {
  completed: 'blocks.state.completed',
  waiting: 'blocks.state.waiting',
  empty: 'blocks.state.empty',
} as const satisfies Record<NonNullable<BlockSummary['state']>, string>;

/** An empty list for a task without reasons, so a row is not told something new for nothing. */
const NONE: readonly BlockingReason[] = [];

/**
 * The main view of the board when `?view=blocks`: every topic with its blocks in their order,
 * and the tasks in them (T91, T92). It reads what the board already knows — the statuses, the
 * runs, the reasons — and adds no rule of its own: a block is completed or empty by its tasks,
 * and waits when the board says an earlier block holds its tasks (ADR-0032 §5, §7). Tasks with
 * neither a topic nor a block come last, in one section of their own.
 */
export function BlocksView({ topicFilter, onOpen }: BlocksViewProps) {
  const t = useBlocksT();
  const { state } = useBoard();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const topics =
    topicFilter === null ? state.topics : state.topics.filter((topic) => topic.id === topicFilter);
  const showGlobal = topicFilter === null || topicFilter === NO_TOPIC;
  // An archived task is not on the board, so it is in no block (T10).
  const shown = useMemo(() => withoutArchived(state.tasks), [state.tasks]);
  const unplaced = shown.filter((task) => task.topic === undefined && task.block === undefined);

  return (
    <section className="blocks" aria-label={t('blocks.title')}>
      <h2 className="blocks__title-main" tabIndex={-1} ref={headingRef}>
        {t('blocks.title')}
      </h2>

      {state.topics.length === 0 && topicFilter === null ? (
        <EmptyState title={t('blocks.noTopics.title')}>
          <p>{t('blocks.noTopics.hint')}</p>
        </EmptyState>
      ) : null}

      {topics.map((topic) => (
        <TopicBlocks
          key={topic.id}
          topic={topic}
          tasks={shown}
          readiness={state.readiness}
          onOpen={onOpen}
          onDeleted={() => headingRef.current?.focus()}
        />
      ))}

      {showGlobal ? (
        <section className="blocks__topic" aria-label={t('blocks.noBlock')}>
          <h3 className="blocks__topic-title">{t('blocks.noBlock')}</h3>
          {unplaced.length === 0 ? (
            <p className="blocks__none">{t('blocks.noneUnplaced')}</p>
          ) : (
            <TaskRows tasks={unplaced} readiness={state.readiness} onOpen={onOpen} />
          )}
        </section>
      ) : null}
    </section>
  );
}

interface TopicBlocksProps {
  topic: Topic;
  tasks: readonly Task[];
  readiness: Readonly<Record<string, readonly BlockingReason[]>>;
  onOpen: (id: string) => void;
  /** A block was deleted with its menu: its button is gone, and the focus must go somewhere. */
  onDeleted: () => void;
}

function TopicBlocks({ topic, tasks, readiness, onOpen, onDeleted }: TopicBlocksProps) {
  const t = useBlocksT();
  const label = `${topic.id} · ${topic.title}`;
  const ofTopic = tasks.filter((task) => task.topic === topic.id);
  // A task of the topic that is in none of its blocks is outside their order (ADR-0032 §5).
  const loose = ofTopic.filter(
    (task) => task.block === undefined || !topic.blocks.some((block) => block.id === task.block),
  );

  return (
    <section className="blocks__topic" aria-label={label}>
      <h3 className="blocks__topic-title">{label}</h3>
      {topic.blocks.map((block, index) => {
        const inBlock = ofTopic.filter((task) => task.block === block.id);
        const summary = blockSummary(inBlock, readiness);
        const name = `${block.id} · ${block.title}`;
        return (
          <section key={block.id} className="blocks__block" aria-label={name}>
            <header className="blocks__block-head">
              <h4 className="blocks__block-title">{name}</h4>
              <span className="blocks__count" title={t('blocks.doneOfAll')}>
                {summary.done}/{summary.total}
              </span>
              {summary.state === undefined ? null : (
                <Badge tone={summary.state === 'waiting' ? 'warning' : 'neutral'}>
                  {t(STATE_TEXT[summary.state])}
                </Badge>
              )}
              <BlockMenu topic={topic} block={block} position={index} onDeleted={onDeleted} />
            </header>
            <TaskRows tasks={inBlock} readiness={readiness} onOpen={onOpen} />
          </section>
        );
      })}
      {loose.length === 0 ? null : (
        <section className="blocks__block" aria-label={t('blocks.notInBlock')}>
          <header className="blocks__block-head">
            <h4 className="blocks__block-title">{t('blocks.notInBlock')}</h4>
          </header>
          <TaskRows tasks={loose} readiness={readiness} onOpen={onOpen} />
        </section>
      )}
    </section>
  );
}

interface TaskRowsProps {
  tasks: readonly Task[];
  readiness: Readonly<Record<string, readonly BlockingReason[]>>;
  onOpen: (id: string) => void;
}

function TaskRows({ tasks, readiness, onOpen }: TaskRowsProps) {
  const t = useBlocksT();
  const { views } = useSeries(tasks);
  const reasonText = useReasonText();
  if (tasks.length === 0) return null;
  return (
    <ul className="blocks__tasks">
      {tasks.map((task) => {
        const reasons = readiness[task.id] ?? NONE;
        const launch = launchState(task, reasons);
        const series = views.get(task.id);
        const why = t('blocks.mark.blockedWhy', { reasons: reasons.map(reasonText).join('; ') });
        const first = reasons[0];
        return (
          <li key={task.id} className="blocks__task" data-task-id={task.id}>
            <span className="blocks__marks">
              {launch.done ? <Mark title={t('blocks.mark.done')} glyph="✓" /> : null}
              {launch.running ? <Mark title={t('blocks.mark.running')} glyph="●" /> : null}
              {launch.blocked ? (
                <Mark title={why} glyph="🔒" spoken={t('blocks.mark.blocked')} />
              ) : null}
              {launch.launchable ? <Mark title={t('blocks.mark.ready')} glyph="▷" /> : null}
            </span>
            <button type="button" className="blocks__title" onClick={() => onOpen(task.id)}>
              {task.title}
            </button>
            <Badge>{task.id}</Badge>
            {series === undefined ? null : (
              <span className="blocks__deps" title={t('blocks.series.title')}>
                <span aria-hidden="true">
                  ↻ {series.loaded ? series.checked : '…'}/{series.total}
                </span>
                <span className="visually-hidden">
                  {series.loaded
                    ? t('blocks.series.checked', { checked: series.checked, total: series.total })
                    : t('blocks.series.loading', { id: task.id })}
                </span>
              </span>
            )}
            {launch.blocked && first !== undefined ? (
              <span className="blocks__reason">{reasonText(first)}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Mark({ title, glyph, spoken = title }: { title: string; glyph: string; spoken?: string }) {
  return (
    <span className="blocks__mark" title={title}>
      <span aria-hidden="true">{glyph}</span>
      <span className="visually-hidden">{spoken}</span>
    </span>
  );
}
