import {
  launchState,
  type BlockingReason,
  type Task,
  type Topic,
} from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { Badge, Button, EmptyState, Panel } from '../../../shared/ui/index';
import { blockSummary, reasonText, type BlockSummary } from '../../tasks/index';

export interface BlocksPanelProps {
  onClose: () => void;
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
 * Every topic with its blocks in their order, and the tasks in them (T91). It reads what the
 * board already knows — the statuses, the runs, the reasons — and adds no rule of its own: a
 * block is completed or empty by its tasks, and waits when the board says an earlier block holds
 * its tasks (ADR-0032 §5, §7).
 */
export function BlocksPanel({ onClose, onOpen }: BlocksPanelProps) {
  const { state } = useBoard();

  return (
    <Panel label="Blocks">
      <header className="panel__head">
        <h2 className="panel__title">Blocks</h2>
        <Button size="small" onClick={onClose}>
          Close
        </Button>
      </header>

      {state.topics.length === 0 ? (
        <EmptyState title="No topics">
          <p>Blocks belong to topics. Create a topic in “Topics” first.</p>
        </EmptyState>
      ) : (
        state.topics.map((topic) => (
          <TopicBlocks
            key={topic.id}
            topic={topic}
            tasks={state.tasks}
            readiness={state.readiness}
            onOpen={onOpen}
          />
        ))
      )}
    </Panel>
  );
}

interface TopicBlocksProps {
  topic: Topic;
  tasks: readonly Task[];
  readiness: Readonly<Record<string, readonly BlockingReason[]>>;
  onOpen: (id: string) => void;
}

function TopicBlocks({ topic, tasks, readiness, onOpen }: TopicBlocksProps) {
  const label = `${topic.id} · ${topic.title}`;
  const ofTopic = tasks.filter((task) => task.topic === topic.id);
  // A task of the topic that is in none of its blocks is outside their order (ADR-0032 §5).
  const loose = ofTopic.filter(
    (task) => task.block === undefined || !topic.blocks.some((block) => block.id === task.block),
  );

  return (
    <section className="blocks__topic" aria-label={label}>
      <h3 className="blocks__topic-title">{label}</h3>
      {topic.blocks.map((block) => {
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
