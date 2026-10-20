import {
  CLAUDE_MODEL_ALIASES,
  claudeModelSchema,
  type AiRun,
  type RunTaskRequest,
} from '../../../../contract/v1/index';

/**
 * The parameters of a start of Claude Code (T38), apart from the dialog that asks for them: what
 * the dialog starts with, what it may send, and when it may send it.
 */

/** The model control: the default of Claude Code (''), an alias, or a name typed in. */
export type ModelChoice = '' | (typeof CLAUDE_MODEL_ALIASES)[number] | 'other';

export interface ModelDraft {
  choice: ModelChoice;
  /** What was typed for another model; kept while another choice is made, as typed. */
  name: string;
}

const isAlias = (model: string): model is (typeof CLAUDE_MODEL_ALIASES)[number] =>
  (CLAUDE_MODEL_ALIASES as readonly string[]).includes(model);

/**
 * The model of the last run, when it can be sent again; otherwise the default of Claude Code.
 * What the runner recorded is not checked by the contract of a request, so it is checked here.
 */
export function initialModel(run: AiRun | undefined): ModelDraft {
  const last = run?.model;
  if (last === undefined) return { choice: '', name: '' };
  if (isAlias(last)) return { choice: last, name: '' };
  if (claudeModelSchema.safeParse(last).success) return { choice: 'other', name: last };
  return { choice: '', name: '' };
}

/**
 * The model to send: nothing for the default — never a value that stands for it — one string
 * otherwise, or `null` when what was typed is not a model the contract accepts.
 */
export function chosenModel(draft: ModelDraft): string | undefined | null {
  if (draft.choice === '') return undefined;
  if (draft.choice !== 'other') return draft.choice;
  return claudeModelSchema.safeParse(draft.name).success ? draft.name : null;
}

/**
 * The body of `POST /tasks/:id/run`: the agent, the model only when one was chosen, and the mode
 * only when the session is continued or started over — a new session is asked for as it always
 * was, with no word about it (T36, T37, T39).
 */
export function runRequest(model: string | undefined, mode: SessionMode = 'new'): RunTaskRequest {
  return {
    agent: 'claude-code',
    ...(model === undefined ? {} : { model }),
    ...(mode === 'new' ? {} : { mode }),
  };
}

/** How the session of a start relates to the last one. */
export type SessionMode = 'new' | 'resume' | 'restart';

/** Whether nothing may be started now: Claude Code is still working on the task. */
export const isWorking = (run: AiRun | undefined): boolean => run?.state === 'working';

export type ResumeBlocked = 'noSession' | 'working';

/**
 * Why the last session cannot be continued, or nothing when it can. The reasons that depend on
 * the task come first, so that what is said stays true: a run before the sessions of T31 has no
 * session to name, and none can be continued while Claude Code is working in it.
 */
export function resumeBlocked(run: AiRun | undefined): ResumeBlocked | undefined {
  if (run?.sessionId === undefined) return 'noSession';
  if (isWorking(run)) return 'working';
  return undefined;
}
