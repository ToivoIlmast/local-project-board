import { z } from 'zod';

/**
 * Why a work run that was handed to a runner did not begin, as the runner reported it (ADR-0029
 * T94, K9): `claude` was not found, there was no finished session to resume, the board refused
 * the begin, or anything else before a successful begin.
 */
export const LAUNCH_FAILURE_KINDS = [
  'claude-missing',
  'resume-refused',
  'begin-refused',
  'runner-error',
] as const;

/** The most a runner may send as the message of a failed start, and the most that is kept (K8, K10). */
export const LAUNCH_MESSAGE_MAX_LENGTH = 500;

export const launchFailureSchema = z.strictObject({
  kind: z.enum(LAUNCH_FAILURE_KINDS),
  /** One line, cleaned by the board (K10); absent when nothing was left of it. */
  message: z.string().min(1).max(LAUNCH_MESSAGE_MAX_LENGTH).optional(),
  at: z.iso.datetime({ offset: true }),
});

/**
 * The last request of a work run that the board handed to a runner (ADR-0029 T94, K3). Written
 * by the board only: by `/run` when it hands the request, by `run-failure` once, and removed by
 * begin. It is not content: no version, no hash, never given to agents.
 */
export const launchSchema = z.strictObject({
  requestId: z.uuid(),
  requestedAt: z.iso.datetime({ offset: true }),
  /** The runId of the task's run when the request was made; 0 when there was none (K4). */
  afterRunId: z.int().min(0),
  /** Whether the runner that took it declared `signals=run-failure`, and so can report (K11). */
  reports: z.boolean(),
  failure: launchFailureSchema.optional(),
});

export type Launch = z.infer<typeof launchSchema>;
export type LaunchFailure = z.infer<typeof launchFailureSchema>;
export type LaunchFailureKind = (typeof LAUNCH_FAILURE_KINDS)[number];
