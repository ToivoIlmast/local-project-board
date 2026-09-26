export { SettingsPanel, type SettingsPanelProps } from './ui/SettingsPanel';
// What the page for one task shares with this one: the words, the control, the draft and its
// rules. A task is overridden in the same three states as a column, so none of it is copied.
export { INACTIVE_NOTE, WORKFLOW_LABELS, boardValueText, onOff, sourceLabel } from './model/labels';
export { FlagChoice, type FlagChoiceProps } from './ui/FlagChoice';
export { effectiveFlag, setFlag } from './model/draft';
export { useOverridesDraft, type DraftKit, type OverridesDraft } from './model/useWorkflowDraft';
