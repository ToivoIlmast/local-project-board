import type { Page } from '@playwright/test';
import { expect, test, type RunningBoard } from './board';

/**
 * Many tabs of one board in one browser (T62). A browser keeps six HTTP/1.1 connections to a
 * host:port and shares them between its tabs; a stream per tab used them all up, and every
 * other request — even the page itself — waited in the browser's queue for ever. One stream per
 * browser is what makes the seventh tab work; these tests fail when the streams grow with tabs.
 */
const TABS = 7;
const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';

/** A task with a document, two versions and a research, so every part of the panel has data. */
async function seed(board: RunningBoard): Promise<void> {
  await board.api('/api/v1/tasks', {
    method: 'POST',
    body: { title: 'Survive many tabs', status: 'todo', body: 'First.\n' },
  });
  await board.api('/api/v1/tasks/T1', { method: 'PATCH', body: { body: 'Second.\n' } });
  await board.api('/api/v1/tasks/T1/documents/plan.md', {
    method: 'PUT',
    body: { content: '# Plan\n' },
  });
  await board.api('/api/v1/tasks/T1/checks', {
    method: 'POST',
    body: { agent: 'claude-code', sessionId: SESSION, kind: 'research', comment: 'Tabs' },
  });
}

async function openTabs(page: Page, url: string): Promise<Page[]> {
  const pages = [page];
  for (let index = 1; index < TABS; index += 1) pages.push(await page.context().newPage());
  // One after another, like a person opening tabs; each must load before the next is opened.
  for (const tab of pages) {
    await tab.goto(url);
    await expect(tab.getByRole('button', { name: 'Survive many tabs' })).toBeVisible();
  }
  return pages;
}

/** Asks the board for something from the page, as the page itself would, with a deadline. */
function answersWithin(tab: Page, ms: number): Promise<number> {
  return tab.evaluate(async (deadline) => {
    const response = await fetch('/api/v1/project', { signal: AbortSignal.timeout(deadline) });
    return response.status;
  }, ms);
}

test(`${TABS} tabs of one board: every tab loads the board, the documents and the history`, async ({
  page,
  board,
}) => {
  await seed(board);
  const tabs = await openTabs(page, board.url);

  for (const tab of tabs) {
    await tab.getByRole('button', { name: 'Survive many tabs' }).click();
    const details = tab.getByRole('complementary', { name: 'Task T1' });
    await expect(
      details.getByRole('region', { name: 'Documents' }).getByText('plan.md'),
    ).toBeVisible();
    await expect(details.getByRole('button', { name: 'View v1' })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Open T1-C1' })).toBeVisible();
  }

  // The first tab is not starved by the streams of the others.
  expect(await answersWithin(tabs[0] as Page, 5_000)).toBe(200);
});

test(`${TABS} tabs follow the board after a tab is closed and after the board restarts`, async ({
  page,
  board,
}) => {
  await seed(board);
  const tabs = await openTabs(page, board.url);

  // The tab that opened the stream first goes away; the others keep hearing the board.
  await (tabs.shift() as Page).close();
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'After a close' } });
  for (const tab of tabs) {
    await expect(tab.getByRole('button', { name: 'After a close' })).toBeVisible();
  }

  // A restart: a new token, the same port. The stream comes back and every tab hears the board.
  await board.restart();
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'After a restart' } });
  for (const tab of tabs) {
    await expect(tab.getByRole('button', { name: 'After a restart' })).toBeVisible({
      timeout: 20_000,
    });
  }
  expect(await answersWithin(tabs[0] as Page, 5_000)).toBe(200);
});
