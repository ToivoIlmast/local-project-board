import { z } from 'zod';

/** How the run of an agent went, in its own words (T20). */
export const AI_RUN_STATES = ['working', 'finished', 'failed', 'needs-review'] as const;
/** What the checks of the project said, as far as the agent ran them. */
export const AI_RUN_CHECKS = ['passed', 'failed', 'skipped'] as const;

/**
 * What an agent reports about its run on a task, written with the PATCH of that task (T27, the
 * model of T20). It is the agent's self-report: the board keeps it and shows it, and checks
 * nothing of it. The branch is `task.branch` and the report is the document `report.md`, so
 * neither is repeated here.
 */
export const aiRunSchema = z.strictObject({
  /** Who ran: `claude-code`, or whatever another agent calls itself. */
  agent: z.string().regex(/\S/, 'Must not be blank').max(100),
  state: z.enum(AI_RUN_STATES),
  checks: z.enum(AI_RUN_CHECKS).optional(),
  /** A commit the agent made, as an abbreviated or full SHA; not looked up in git. */
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/, 'Must be a commit SHA')
    .optional(),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  finishedAt: z.iso.datetime({ offset: true }).optional(),
});

export type AiRun = z.infer<typeof aiRunSchema>;
