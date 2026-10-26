/**
 * The pure functions of the task history, for the page (ADR-0030 §9, ADR-0013): the page reaches
 * the core only through the contract, and runs the very functions the server does, so it never
 * asks for a hash or a diff.
 */
export {
  applyContentPatch,
  applyRecommendations,
  changedFields,
  contentHash,
  contentOf,
  diffContent,
  diffLines,
  isReportStale,
  isSuperseded,
  latestDecisions,
  occurrences,
  recommendationAxes,
  sameContent,
  summarizeCheck,
} from '../../core/rules/history.js';
export type {
  AppliedRecommendations,
  ContentDiff,
  DiffKind,
  DiffLine,
  NotApplied,
  RecommendationAxes,
} from '../../core/rules/history.js';
