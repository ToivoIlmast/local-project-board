import {
  SUPPORTED_LANGUAGES,
  languageName,
  type SupportedLanguage,
} from '../../../../contract/v1/index';
import { Field, Select, type SelectOption } from '../../../shared/ui/index';
import { WORKFLOW_LABELS } from '../model/labels';

const INHERIT = 'inherit';

export interface LanguageChoiceProps {
  /** What this task says; `undefined` is "says nothing", the board's language applies. */
  own: SupportedLanguage | undefined;
  /** The text of "says nothing", with what that gives now. */
  inheritLabel: string;
  /** What is in effect and where it comes from. */
  hint: string;
  onChange: (value: SupportedLanguage | 'inherit') => void;
}

/**
 * The language of one task's report: like the board, or one of the 14 languages. English is a
 * language here like any other — on a task it is a value, because the board may say another.
 */
export function LanguageChoice({ own, inheritLabel, hint, onChange }: LanguageChoiceProps) {
  const options: SelectOption[] = [
    { value: INHERIT, label: inheritLabel },
    ...SUPPORTED_LANGUAGES.map((code) => ({ value: code, label: languageName(code) })),
  ];
  return (
    <Field
      label={WORKFLOW_LABELS.reportLanguage.label}
      hint={`${WORKFLOW_LABELS.reportLanguage.description} ${hint}`}
    >
      {(id, hintId) => (
        <Select
          id={id}
          aria-describedby={hintId}
          options={options}
          value={own ?? INHERIT}
          onChange={(event) => {
            const chosen = event.target.value;
            onChange(chosen === INHERIT ? INHERIT : (chosen as SupportedLanguage));
          }}
        />
      )}
    </Field>
  );
}

export interface BoardLanguageProps {
  value: SupportedLanguage | null | undefined;
  onChange: (value: SupportedLanguage | undefined) => void;
}

/** The language of the board's report: English (the default) first, then the other 13. */
export function BoardLanguage({ value, onChange }: BoardLanguageProps) {
  const options: SelectOption[] = [
    { value: '', label: `${languageName('en')} (default)` },
    ...SUPPORTED_LANGUAGES.filter((code) => code !== 'en').map((code) => ({
      value: code,
      label: languageName(code),
    })),
  ];
  return (
    <Field
      label={WORKFLOW_LABELS.reportLanguage.label}
      hint={WORKFLOW_LABELS.reportLanguage.description}
    >
      {(id, hintId) => (
        <Select
          id={id}
          aria-describedby={hintId}
          options={options}
          value={value === undefined || value === null || value === 'en' ? '' : value}
          onChange={(event) => {
            const chosen = event.target.value;
            onChange(chosen === '' ? undefined : (chosen as SupportedLanguage));
          }}
        />
      )}
    </Field>
  );
}

export interface CommitLanguageProps {
  value: SupportedLanguage | null | undefined;
  onChange: (value: SupportedLanguage | undefined) => void;
}

/**
 * The language of the board's commit messages: "not set" (the project's own convention) first,
 * then all 14. English is a language here, because choosing it gives the agent an instruction.
 */
export function CommitLanguage({ value, onChange }: CommitLanguageProps) {
  const options: SelectOption[] = [
    { value: '', label: 'Not set (the convention of the project)' },
    ...SUPPORTED_LANGUAGES.map((code) => ({ value: code, label: languageName(code) })),
  ];
  return (
    <Field
      label={WORKFLOW_LABELS.commitLanguage.label}
      hint={WORKFLOW_LABELS.commitLanguage.description}
    >
      {(id, hintId) => (
        <Select
          id={id}
          aria-describedby={hintId}
          options={options}
          value={value ?? ''}
          onChange={(event) => {
            const chosen = event.target.value;
            onChange(chosen === '' ? undefined : (chosen as SupportedLanguage));
          }}
        />
      )}
    </Field>
  );
}
