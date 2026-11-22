export { TaskCard, type TaskCardProps } from './ui/TaskCard';
export { TaskDetails } from './ui/TaskDetails';
export { TaskDetailsSurface, type TaskDetailsLayout } from './ui/TaskDetailsSurface';
export { TaskDialog } from './ui/TaskDialog';
export { TaskForm, type TaskValues } from './ui/TaskForm';
export { SendToAi, type SendToAiProps } from './ui/SendToAi';
export { AGENT_TARGETS } from './model/useSendToAi';
export type { AgentTarget, DialogTarget, RunTarget, TargetDialogProps } from './model/agentTarget';
export { TaskAiSettings, type TaskAiSettingsProps } from './ui/TaskAiSettings';
export { reasonText } from './model/readinessText';
export { useReasonText } from './model/useReasonText';
export {
  blockSummary,
  needsStatusConfirmation,
  placeLabel,
  type BlockSummary,
} from './model/placement';
export { useSeries, type SeriesView } from './model/useSeries';
