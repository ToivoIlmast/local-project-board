import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from './board';

for (const [language, dir] of [
  ['ar', 'rtl'],
  ['ja', 'ltr'],
] as const) {
  test(`the board in ${language} has lang and dir on the page, survives a reload and passes axe`, async ({
    page,
    board,
  }) => {
    await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Seed', status: 'todo' } });
    await page.goto(board.url);
    await page.getByRole('combobox', { name: 'Language' }).selectOption(language);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', language);
    await expect(html).toHaveAttribute('dir', dir);

    await page.reload();
    await expect(html).toHaveAttribute('lang', language);
    await expect(html).toHaveAttribute('dir', dir);
    await expect(page.locator('h1.header__title')).toBeVisible();

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const result = await new AxeBuilder({ page }).analyze();
      const found = result.violations.flatMap((violation) =>
        violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')}`),
      );
      expect(found, `${language}, ${scheme} theme`).toEqual([]);
    }
  });
}
