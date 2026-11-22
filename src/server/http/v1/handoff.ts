import {
  generateCheckHandoff,
  type CheckHandoffHistory,
  generateHandoff,
  generateInstructions,
  type BoardFacts,
  type HandoffRelatedTask,
} from '../../../contract/v1/index.js';
import {
  assertNotArchived,
  selectRelatedTasks,
  type Task,
  taskBlocked,
  type DocumentService,
  type HistoryService,
  type TaskService,
  type WorkflowService,
} from '../../../core/index.js';

/** The reads a handoff is made of; nothing here can change the board. */
export interface HandoffServices {
  tasks: Pick<TaskService, 'getWithReadiness' | 'list'>;
  documents: Pick<DocumentService, 'list'>;
  workflow: Pick<WorkflowService, 'forTask'>;
}

export interface HandoffSource {
  /** Where the board answers; the instructions quote it. */
  baseUrl: string;
  board: BoardFacts;
  /** ai.rules from the configuration: the project's own rules, added to the API's. */
  projectRules: readonly string[];
}

/**
 * The handoff of one task, put together from what the services read now. It is the one place
 * that does this, so `GET /tasks/:id/handoff` and `local-project-board handoff` give the same
 * text: the task, its documents, the effective settings from `WorkflowService.forTask` (the
 * route of `GET /tasks/:id/workflow` answers the same) and the general instructions — made
 * without a token, because a handoff is passed around and a token is for whoever asks for it.
 * Nothing is written and nothing is kept.
 *
 * A blocked task has no handoff, `TASK_BLOCKED` with its reasons instead, unless a run of it
 * works: a run that has started keeps its handoff, a resumed one too (ADR-0032 §8, F1).
 */
export async function composeHandoff(
  { tasks, documents, workflow }: HandoffServices,
  id: string,
  { baseUrl, board, projectRules }: HandoffSource,
): Promise<string> {
  const { readiness, ...task } = await tasks.getWithReadiness(id);
  assertNotArchived(task);
  if (readiness.reasons.length > 0 && task.aiRun?.state !== 'working') {
    throw taskBlocked(id, readiness.reasons);
  }
  const [attached, effective, related] = await Promise.all([
    documents.list(id),
    workflow.forTask(id),
    relatedOf(tasks, documents, task),
  ]);
  return generateHandoff({
    ...related,
    task,
    documents: attached,
    effective,
    instructions: generateInstructions({ baseUrl, board, projectRules }),
  });
}

const REPORT = 'report.md';

/**
 * The related tasks of one task (T14), read now: who they are from `selectRelatedTasks`, whether
 * each has a `report.md` and which commits its runs recorded — from the task itself, never from
 * git. Whatever cannot be read leaves the task out or its report unlinked; it never fails a handoff.
 */
async function relatedOf(
  tasks: HandoffServices['tasks'],
  documents: HandoffServices['documents'],
  task: Task,
): Promise<{ related?: HandoffRelatedTask[]; relatedOmitted?: number }> {
  let all: Task[];
  try {
    all = await tasks.list();
  } catch {
    return {};
  }
  const { related, omitted } = selectRelatedTasks(task, all);
  if (related.length === 0) return {};
  const entries = await Promise.all(
    related.map(async ({ task: other, reason }): Promise<HandoffRelatedTask> => {
      const hasReport = await documents
        .list(other.id)
        .then((list) => list.some((document) => document.name === REPORT))
        .catch(() => false);
      return {
        id: other.id,
        title: other.title,
        status: other.status,
        archived: other.archived !== undefined,
        reason,
        hasReport,
        commits: commitsOf(other),
      };
    }),
  );
  return { related: entries, relatedOmitted: omitted };
}

/** The SHAs of the runs in the order of the runs, the current one last, each once. */
function commitsOf(task: Task): string[] {
  const runs = [...(task.aiRunHistory ?? []), ...(task.aiRun === undefined ? [] : [task.aiRun])];
  const shas = runs.flatMap((run) => (run.commit === undefined ? [] : [run.commit]));
  return [...new Set(shas)];
}

export interface CheckHandoffServices {
  history: Pick<HistoryService, 'check' | 'checks' | 'version' | 'versions'>;
  documents: Pick<DocumentService, 'list'>;
  workflow: Pick<WorkflowService, 'forTask'>;
}

/**
 * What the agent of one check reads (ADR-0030 §6): the snapshot of the version the check is
 * pinned to, the documents, the rules and the report format. Of the workflow settings only the
 * language of the report applies. Nothing is written and nothing is kept.
 */
export async function composeCheckHandoff(
  { history, documents, workflow }: CheckHandoffServices,
  id: string,
  number: number,
  { baseUrl }: { baseUrl: string },
): Promise<string> {
  const check = await history.check(id, number);
  const [version, attached, effective] = await Promise.all([
    history.version(id, check.begin.version),
    documents.list(id),
    workflow.forTask(id),
  ]);
  const research = check.begin.kind === 'research';
  return generateCheckHandoff({
    baseUrl,
    taskId: id,
    check: number,
    version,
    documents: attached,
    reportLanguage: effective.values.reportLanguage,
    ...(research ? { kind: 'research' as const } : {}),
    ...(check.begin.trigger === undefined ? {} : { trigger: check.begin.trigger }),
    ...(check.begin.comment === undefined ? {} : { comment: check.begin.comment }),
    // What the task had before is for a research to read; a check is told nothing of it.
    ...(research ? { history: await pastOf(history, id, number) } : {}),
  });
}

/** The checks before this one, whole, and the versions that say where they were applied. */
async function pastOf(
  history: CheckHandoffServices['history'],
  id: string,
  before: number,
): Promise<CheckHandoffHistory> {
  const [summaries, { versions }] = await Promise.all([history.checks(id), history.versions(id)]);
  const checks = await Promise.all(
    summaries
      .filter(({ number }) => number < before)
      .map(({ number }) => history.check(id, number)),
  );
  return { checks, versions };
}
