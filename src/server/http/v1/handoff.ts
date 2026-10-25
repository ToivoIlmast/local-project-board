import {
  generateCheckHandoff,
  type CheckHandoffHistory,
  generateHandoff,
  generateInstructions,
  type BoardFacts,
} from '../../../contract/v1/index.js';
import type {
  DocumentService,
  HistoryService,
  TaskService,
  WorkflowService,
} from '../../../core/index.js';

/** The reads a handoff is made of; nothing here can change the board. */
export interface HandoffServices {
  tasks: Pick<TaskService, 'get'>;
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
 */
export async function composeHandoff(
  { tasks, documents, workflow }: HandoffServices,
  id: string,
  { baseUrl, board, projectRules }: HandoffSource,
): Promise<string> {
  const task = await tasks.get(id);
  const [attached, effective] = await Promise.all([documents.list(id), workflow.forTask(id)]);
  return generateHandoff({
    task,
    documents: attached,
    effective,
    instructions: generateInstructions({ baseUrl, board, projectRules }),
  });
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
