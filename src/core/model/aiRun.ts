import { z } from 'zod';

/** How the run of an agent went, in its own words (T20). */
export const AI_RUN_STATES = ['working', 'finished', 'failed', 'needs-review'] as const;
/** What the checks of the project said, as far as the agent ran them. */
export const AI_RUN_CHECKS = ['passed', 'failed', 'skipped'] as const;
export const AI_RUN_MODES = ['new', 'resume', 'restart'] as const;
export const AI_RUN_FAILURE_KINDS = ['launch', 'exit', 'agent'] as const;

/** What the runner records when a process failed (T31). */
export const aiRunFailureSchema = z.strictObject({
  kind: z.enum(AI_RUN_FAILURE_KINDS),
  message: z.string().min(1),
  exitCode: z.number().int().optional(),
});

/**
 * What an agent reports about its run on a task, written with the PATCH of that task (T27, the
 * model of T20). Extended with runner fields in T31: runId, sessionId, mode, model, failure,
 * endedAt are written by the runner process, not the agent.
 */
export const aiRunSchema = z.strictObject({
  /** Who ran: `claude-code`, or whatever another agent calls itself. */
  agent: z.string().regex(/\S/, 'Must not be blank').max(100),
  state: z.enum(AI_RUN_STATES),
  /** Runner-assigned sequence number, monotonically increasing per task (T31). */
  runId: z.number().int().nonnegative().optional(),
  /** UUID identifying the Claude Code session; set by the runner on begin (T31). */
  sessionId: z.string().uuid().optional(),
  /** How the session was started; set by the runner on begin (T31). */
  mode: z.enum(AI_RUN_MODES).optional(),
  /** Which model ran; set by the runner on begin (T31). */
  model: z.string().min(1).max(200).optional(),
  checks: z.enum(AI_RUN_CHECKS).optional(),
  /** A commit the agent made, as an abbreviated or full SHA; not looked up in git. */
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/, 'Must be a commit SHA')
    .optional(),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  finishedAt: z.iso.datetime({ offset: true }).optional(),
  /** What went wrong; set by the runner on end when the process failed (T31). */
  failure: aiRunFailureSchema.optional(),
  /** When the runner process ended, by the runner's clock (T31). */
  endedAt: z.iso.datetime({ offset: true }).optional(),
});

export type AiRun = z.infer<typeof aiRunSchema>;
export type AiRunFailure = z.infer<typeof aiRunFailureSchema>;
