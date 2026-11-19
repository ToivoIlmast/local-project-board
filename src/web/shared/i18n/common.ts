import { defineCatalogs } from './catalog';
import { createUseT } from './createUseT';

/** The words shared by every feature. */
export const commonCatalogs = defineCatalogs({
  en: { 'language.label': 'Language' },
  fi: { 'language.label': 'Kieli' },
  sv: { 'language.label': 'Språk' },
  no: { 'language.label': 'Språk' },
  da: { 'language.label': 'Sprog' },
  is: { 'language.label': 'Tungumál' },
  de: { 'language.label': 'Sprache' },
  fr: { 'language.label': 'Langue' },
  es: { 'language.label': 'Idioma' },
  pl: { 'language.label': 'Język' },
  pt: { 'language.label': 'Idioma' },
  ru: { 'language.label': 'Язык' },
  ar: { 'language.label': 'اللغة' },
  ja: { 'language.label': '言語' },
});

export const useT = createUseT(commonCatalogs);
