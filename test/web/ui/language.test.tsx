import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider, LanguageSelect } from '../../../src/web/shared/i18n/index';
import { renderBoard } from '../support/render';

describe('the language of the interface', () => {
  it('is chosen in the header from the 14 languages, each by its own name', async () => {
    await renderBoard();
    const select = screen.getByRole('combobox', { name: 'Language' });
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual([
      'English',
      'Suomi',
      'Svenska',
      'Norsk',
      'Dansk',
      'Íslenska',
      'Deutsch',
      'Français',
      'Español',
      'Polski',
      'Português',
      'Русский',
      'العربية',
      '日本語',
    ]);
    expect(select).toHaveValue('en');
    expect(document.documentElement).toHaveAttribute('lang', 'en');
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
  });

  it('redraws the interface at once, and sets lang and dir on the page', async () => {
    const { user } = await renderBoard();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'ar');
    expect(screen.getByRole('combobox', { name: 'اللغة' })).toHaveValue('ar');
    expect(document.documentElement).toHaveAttribute('lang', 'ar');
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    await user.selectOptions(screen.getByRole('combobox', { name: 'اللغة' }), 'ja');
    expect(screen.getByRole('combobox', { name: '言語' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
  });

  it('survives unmounting and mounting again', async () => {
    const first = render(
      <I18nProvider>
        <LanguageSelect />
      </I18nProvider>,
    );
    await userEvent.setup().selectOptions(screen.getByRole('combobox'), 'fi');
    expect(window.localStorage.getItem('board.language')).toBe('fi');
    first.unmount();
    render(
      <I18nProvider>
        <LanguageSelect />
      </I18nProvider>,
    );
    expect(screen.getByRole('combobox', { name: 'Kieli' })).toHaveValue('fi');
    expect(document.documentElement).toHaveAttribute('lang', 'fi');
  });
});
