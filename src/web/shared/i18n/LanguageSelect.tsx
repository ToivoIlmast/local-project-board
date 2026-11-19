import { useT } from './common';
import { LANGUAGE_ENDONYMS, UI_LANGUAGES, isUiLanguage } from './languages';
import { setLanguage } from './store';
import { useLanguage } from './useLanguage';

/** The list of languages of the interface, each in its own name. */
export function LanguageSelect() {
  const t = useT();
  const language = useLanguage();
  return (
    <select
      className="input select language-select"
      aria-label={t('language.label')}
      value={language}
      onChange={(event) => {
        if (isUiLanguage(event.target.value)) setLanguage(event.target.value);
      }}
    >
      {UI_LANGUAGES.map((code) => (
        <option key={code} value={code} lang={code}>
          {LANGUAGE_ENDONYMS[code]}
        </option>
      ))}
    </select>
  );
}
