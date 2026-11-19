import { jest } from '@jest/globals';
import { SUPPORTED_LANGUAGES } from '../../../src/contract/v1/index';
import {
  UI_LANGUAGES,
  directionOf,
  formatMessage,
  registeredCatalogs,
} from '../../../src/web/shared/i18n/index';
import { placeholdersOf } from '../../../src/web/shared/i18n/messages';
import { LANGUAGE_STORAGE_KEY, readStoredLanguage } from '../../../src/web/shared/i18n/storage';
import { getLanguage, setLanguage } from '../../../src/web/shared/i18n/store';
import { formatDate, formatSize } from '../../../src/web/shared/lib/format';

describe('the languages of the interface', () => {
  it('are the languages the contract supports, in the same order', () => {
    expect([...UI_LANGUAGES]).toEqual([...SUPPORTED_LANGUAGES]);
  });

  it('read right to left only in Arabic', () => {
    expect(UI_LANGUAGES.filter((language) => directionOf(language) === 'rtl')).toEqual(['ar']);
  });
});

describe('the saved language', () => {
  it('is the saved one when it is a known language', () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ru');
    expect(readStoredLanguage()).toBe('ru');
  });

  it.each([null, '', 'xx', 'EN', '{"a":1}'])('is English for %p', (value) => {
    if (value !== null) window.localStorage.setItem(LANGUAGE_STORAGE_KEY, value);
    expect(readStoredLanguage()).toBe('en');
  });

  it('is English, and setting one does not throw, when the storage throws', () => {
    const boom = () => {
      throw new Error('denied');
    };
    const read = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    const write = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    try {
      expect(readStoredLanguage()).toBe('en');
      expect(() => setLanguage('de')).not.toThrow();
      expect(getLanguage()).toBe('de');
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });
});

describe('messages', () => {
  it('substitute parameters, and leave an unknown one as it is', () => {
    expect(formatMessage('en', 'Task {id} has {count} files', { id: 'T1', count: 3 })).toBe(
      'Task T1 has 3 files',
    );
    expect(formatMessage('en', 'Hello {name}', {})).toBe('Hello {name}');
  });

  const files = {
    one: '{count} файл',
    few: '{count} файла',
    many: '{count} файлов',
    other: '{count} файла',
  };
  it.each([
    [1, '1 файл'],
    [2, '2 файла'],
    [5, '5 файлов'],
    [21, '21 файл'],
    [11, '11 файлов'],
  ])('choose the Russian form for %p', (count, text) => {
    expect(formatMessage('ru', files, { count })).toBe(text);
  });

  it.each([
    [1, 'one'],
    [2, 'few'],
    [5, 'many'],
    [22, 'few'],
  ])('choose the Polish form for %p', (count, form) => {
    const forms = { one: 'one', few: 'few', many: 'many', other: 'other' };
    expect(formatMessage('pl', forms, { count })).toBe(form);
  });

  it.each([
    [0, 'zero'],
    [1, 'one'],
    [2, 'two'],
    [5, 'few'],
    [11, 'many'],
    [100, 'other'],
  ])('choose the Arabic form for %p', (count, form) => {
    const forms = {
      zero: 'zero',
      one: 'one',
      two: 'two',
      few: 'few',
      many: 'many',
      other: 'other',
    };
    expect(formatMessage('ar', forms, { count })).toBe(form);
  });
});

describe('formatting', () => {
  it('follows the language', () => {
    const iso = '2026-03-05T14:07:00Z';
    const english = formatDate(iso);
    setLanguage('ru');
    expect(formatDate(iso)).not.toBe(english);
    expect(formatSize(1536)).toBe('2 kB');
    setLanguage('en');
    expect(formatDate(iso)).toBe(english);
  });
});

describe('the catalogs', () => {
  it('give every language every key of English, with text and the same placeholders', () => {
    expect(registeredCatalogs().length).toBeGreaterThan(0);
    for (const catalogs of registeredCatalogs()) {
      const english = catalogs.en;
      for (const language of UI_LANGUAGES) {
        const catalog = catalogs[language];
        expect(Object.keys(catalog).sort()).toEqual(Object.keys(english).sort());
        for (const [key, message] of Object.entries(catalog)) {
          const texts = typeof message === 'string' ? [message] : Object.values(message);
          for (const text of texts)
            expect([language, key, text.trim() === '']).toEqual([language, key, false]);
          expect([language, key, placeholdersOf(message)]).toEqual([
            language,
            key,
            placeholdersOf(english[key] ?? ''),
          ]);
        }
      }
    }
  });
});
