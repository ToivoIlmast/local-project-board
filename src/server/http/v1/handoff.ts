import {
  generateHandoff,
  generateInstructions,
  type BoardFacts,
} from '../../../contract/v1/index.js';
import type { DocumentService, TaskService, WorkflowService } from '../../../core/index.js';

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
  /** ai.rules from the configuration. */
  rules: readonly string[];
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
  { baseUrl, board, rules }: HandoffSource,
): Promise<string> {
  const task = await tasks.get(id);
  const [attached, effective] = await Promise.all([documents.list(id), workflow.forTask(id)]);
  return generateHandoff({
    task,
    documents: attached,
    effective,
    instructions: generateInstructions({ baseUrl, board, rules }),
  });
}
