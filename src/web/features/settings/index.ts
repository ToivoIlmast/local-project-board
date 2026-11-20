export { SettingsPanel, type SettingsPanelProps } from './ui/SettingsPanel';
// What the page for one task shares with this one: the words, the control, the draft and its
// rules. A task is overridden in the same three states as a column, so none of it is copied.
export {
  WORKFLOW_LABELS,
  boardValueText,
  inEffectText,
  inactiveNote,
  languageLabel,
  languageOptionLabel,
  onOff,
  sourceLabel,
} from './model/labels';
// The sentences of the AI block of a task that are made of the words of this catalog.
export { useSettingsT } from './i18n/index';
export { FlagChoice, type FlagChoiceProps } from './ui/FlagChoice';
export { effectiveFlag, effectiveLanguage, setFlag, setTaskLanguage } from './model/draft';
export { LanguageChoice, type LanguageChoiceProps } from './ui/LanguageChoice';
export { useOverridesDraft, type DraftKit, type OverridesDraft } from './model/useWorkflowDraft';
