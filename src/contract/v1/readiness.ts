/**
 * Readiness, for the page (ADR-0032 §5, ADR-0013): the page reaches the core only through the
 * contract and runs the very functions the server does, so the two cannot disagree on whether a
 * task may start. The words for the reasons are the page's own.
 */
export { findCycles, launchState, readiness } from '../../core/rules/readiness.js';
export type {
  BlockingReason,
  BlockingReasonCode,
  LaunchState,
  ReadinessInput,
  ReadinessTask,
  ReadinessTopic,
} from '../../core/rules/readiness.js';
