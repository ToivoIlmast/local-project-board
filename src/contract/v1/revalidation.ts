/**
 * The scope of a completed task, for the page (ADR-0032, M1 §2.5): the page reaches the core only
 * through the contract and runs the very function the server does, so the two cannot disagree on
 * what a completed task asks to check again.
 */
export { finishingTask, revalidationScope } from '../../core/rules/revalidation.js';
export type {
  RevalidationInput,
  RevalidationTask,
  ScopeBasis,
  ScopeExclusion,
  ScopeItem,
} from '../../core/rules/revalidation.js';
