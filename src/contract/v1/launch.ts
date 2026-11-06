/**
 * Whether a task's `launch` still speaks for it, for the page (ADR-0029 T94, K4, K12): the same
 * function the board runs, reached through the contract (ADR-0013), so the two cannot disagree.
 */
export { isLaunchCurrent } from '../../core/rules/launch.js';
