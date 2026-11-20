import { languageName } from '../../../../contract/v1/index';
import type {
  BoardWorkflowKey,
  WorkflowKey,
  WorkflowSettings,
  WorkflowSource,
} from '../../../../contract/v1/index';
import { getLanguage, type UiLanguage } from '../../../shared/i18n/index';
import { settingsT } from '../i18n/index';

/** Every setting of the model; the object below does not compile when one is missing. */
const KEYS = [
  'editCode',
  'branch',
  'checks',
  'commit',
  'push',
  'report',
  'startStatus',
  'finishStatus',
  'baseBranch',
  'checkCommand',
  'commitLanguage',
  'reportLanguage',
] as const satisfies readonly WorkflowKey[];

type Covered = (typeof KEYS)[number];
// A setting added to the model without a name and an explanation is an error here.
const _everyKeyIsCovered: [WorkflowKey] extends [Covered] ? true : never = true;
void _everyKeyIsCovered;

/**
 * The words for every AI workflow setting, in the language shown at the moment they are read:
 * the page for the board and its columns uses them, and so does the page for a task. The
 * texts live in the catalog of the settings; this object is only the way to reach them.
 */
export const WORKFLOW_LABELS: Record<WorkflowKey, { label: string; description: string }> =
  Object.fromEntries(
    KEYS.map((key) => [
      key,
      {
        get label(): string {
          return settingsT(`label.${key}`);
        },
        get description(): string {
          return settingsT(`description.${key}`);
        },
      },
    ]),
  ) as Record<WorkflowKey, { label: string; description: string }>;

/**
 * Where the value in effect comes from, for the sentence "In effect: on, from …". A column is
 * "this column" on the page of the columns, and it is named on the page of a task, where there
 * is more than one column to mean.
 */
export function sourceLabel(source: WorkflowSource, column?: string): string {
  switch (source) {
    case 'default':
      return settingsT('source.default');
    case 'board':
      return settingsT('source.board');
    case 'status':
      return column === undefined
        ? settingsT('source.column')
        : settingsT('source.columnNamed', { column });
    case 'task':
      return settingsT('source.task');
  }
}

/** The whole sentence "In effect: {value}, from {source}." in the language shown. */
export function inEffectText(value: string, source: string): string {
  return settingsT('inEffect', { value, source });
}

/** Why a muted setting is muted; it is said in words, not only by how it is drawn. */
export function inactiveNote(): string {
  return settingsT('inactive', { label: WORKFLOW_LABELS.editCode.label });
}

export const onOff = (value: boolean): string => settingsT(value ? 'on' : 'off');

const NO_VALUE: Record<BoardWorkflowKey, () => string> = {
  startStatus: () => settingsT('novalue.status'),
  finishStatus: () => settingsT('novalue.status'),
  baseBranch: () => settingsT('novalue.baseBranch'),
  checkCommand: () => settingsT('novalue.checkCommand'),
  commitLanguage: () => settingsT('novalue.commitLanguage'),
  reportLanguage: () => languageLabel('en'),
};

const displayNames = new Map<UiLanguage, Intl.DisplayNames | null>();

function namesIn(language: UiLanguage): Intl.DisplayNames | null {
  const known = displayNames.get(language);
  if (known !== undefined) return known;
  let names: Intl.DisplayNames | null;
  try {
    names = new Intl.DisplayNames([language], { type: 'language' });
  } catch {
    names = null;
  }
  displayNames.set(language, names);
  return names;
}

/**
 * The name of a language of the reports in the language of the page. Only the name is
 * translated: the value stored is always the code. English keeps the names of the contract.
 */
export function languageLabel(code: string): string {
  const language = getLanguage();
  if (language === 'en') return languageName(code);
  try {
    const name = namesIn(language)?.of(code);
    if (name !== undefined && name !== code) return name;
  } catch {
    // A code the runtime does not know: the name of the contract is as good as any.
  }
  return languageName(code);
}

/**
 * The same name as an item of a list, where it starts the text: "Englisch", "Английский". Many
 * languages write it in lower case inside a sentence, which `languageLabel` keeps.
 */
export function languageOptionLabel(code: string): string {
  const name = languageLabel(code);
  return name.charAt(0).toLocaleUpperCase(getLanguage()) + name.slice(1);
}

/**
 * The value of a board-only setting as a person reads it: `null` is a meaning, not a blank. A
 * status is shown through `statusLabel` (the hook `useStatusLabel`), which names the four
 * standard ones in the language of the page and leaves the others as they are.
 */
export function boardValueText(
  key: BoardWorkflowKey,
  settings: WorkflowSettings,
  statusLabel: (status: string) => string = (status) => status,
): string {
  const value = settings[key];
  if (value === null) return NO_VALUE[key]();
  if (key === 'reportLanguage' || key === 'commitLanguage') return languageLabel(value);
  return key === 'startStatus' || key === 'finishStatus' ? statusLabel(value) : value;
}
