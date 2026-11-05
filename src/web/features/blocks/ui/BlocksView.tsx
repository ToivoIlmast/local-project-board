import { useRef } from 'react';
import {
  launchState,
  type BlockingReason,
  type Task,
  type Topic,
} from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { Badge, EmptyState } from '../../../shared/ui/index';
import { NO_TOPIC } from '../../board/index';
import { blockSummary, reasonText, type BlockSummary } from '../../tasks/index';
import { BlockMenu } from './BlockMenu';

export interface BlocksViewProps {
  /** `?topic=` of the address: none for All, `none`, or a topic id. */
  topicFilter: string | null;
  onOpen: (id: string) => void;
}

const STATE_TEXT: Record<NonNullable<BlockSummary['state']>, string> = {
  completed: 'completed',
  waiting: 'waiting for previous Block',
  empty: 'empty',
};

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
  const { state } = useBoard();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const topics =
    topicFilter === null ? state.topics : state.topics.filter((topic) => topic.id === topicFilter);
  const showGlobal = topicFilter === null || topicFilter === NO_TOPIC;
  const unplaced = state.tasks.filter(
    (task) => task.topic === undefined && task.block === undefined,
  );

  return (
    <section className="blocks" aria-label="Blocks">
      <h2 className="blocks__title-main" tabIndex={-1} ref={headingRef}>
        Blocks
      </h2>

      {state.topics.length === 0 && topicFilter === null ? (
        <EmptyState title="No topics">
          <p>Blocks belong to topics. Create a topic in “Topics” first.</p>
        </EmptyState>
      ) : null}

      {topics.map((topic) => (
        <TopicBlocks
          key={topic.id}
          topic={topic}
          tasks={state.tasks}
          readiness={state.readiness}
          onOpen={onOpen}
          onDeleted={() => headingRef.current?.focus()}
        />
      ))}

      {showGlobal ? (
        <section className="blocks__topic" aria-label="No block">
          <h3 className="blocks__topic-title">No block</h3>
          {unplaced.length === 0 ? (
            <p className="blocks__none">No tasks without a topic and a block.</p>
          ) : (
            <TaskRows
              tasks={unplaced}
              all={state.tasks}
              readiness={state.readiness}
              onOpen={onOpen}
            />
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
              <span className="blocks__count" title="Tasks done of all">
                {summary.done}/{summary.total}
              </span>
              {summary.state === undefined ? null : (
                <Badge tone={summary.state === 'waiting' ? 'warning' : 'neutral'}>
                  {STATE_TEXT[summary.state]}
                </Badge>
              )}
              <BlockMenu topic={topic} block={block} position={index} onDeleted={onDeleted} />
            </header>
            <TaskRows tasks={inBlock} all={tasks} readiness={readiness} onOpen={onOpen} />
          </section>
        );
      })}
      {loose.length === 0 ? null : (
        <section className="blocks__block" aria-label="Not in a block">
          <header className="blocks__block-head">
            <h4 className="blocks__block-title">Not in a block</h4>
          </header>
          <TaskRows tasks={loose} all={tasks} readiness={readiness} onOpen={onOpen} />
        </section>
      )}
    </section>
  );
}

interface TaskRowsProps {
  tasks: readonly Task[];
  /** Every task of the board: a dependency may be anywhere. */
  all: readonly Task[];
  readiness: Readonly<Record<string, readonly BlockingReason[]>>;
  onOpen: (id: string) => void;
}

function TaskRows({ tasks, all, readiness, onOpen }: TaskRowsProps) {
  if (tasks.length === 0) return null;
  return (
    <ul className="blocks__tasks">
      {tasks.map((task) => {
        const reasons = readiness[task.id] ?? NONE;
        const launch = launchState(task, reasons);
        const dependencies = [...new Set(task.dependsOn ?? [])];
        const doneDependencies = dependencies.filter((id) => {
          const dependency = all.find((candidate) => candidate.id === id);
          return dependency !== undefined && launchState(dependency, []).done;
        }).length;
        const why = `Blocked: ${reasons.map(reasonText).join('; ')}`;
        const first = reasons[0];
        return (
          <li key={task.id} className="blocks__task" data-task-id={task.id}>
            <span className="blocks__marks">
              {launch.done ? <Mark title="Done" glyph="✓" /> : null}
              {launch.running ? <Mark title="An AI run is working" glyph="●" /> : null}
              {launch.blocked ? <Mark title={why} glyph="🔒" spoken="Blocked" /> : null}
              {launch.launchable ? <Mark title="Ready to start" glyph="▷" /> : null}
            </span>
            <button type="button" className="blocks__title" onClick={() => onOpen(task.id)}>
              {task.title}
            </button>
            <Badge>{task.id}</Badge>
            {dependencies.length === 0 ? null : (
              <span className="blocks__deps" title="Dependencies done">
                <span aria-hidden="true">
                  ↻ {doneDependencies}/{dependencies.length}
                </span>
                <span className="visually-hidden">
                  {doneDependencies} of {dependencies.length} dependencies done
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
