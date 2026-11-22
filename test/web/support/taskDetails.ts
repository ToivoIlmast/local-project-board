import { screen, waitFor } from '@testing-library/react';

type Name = string | RegExp;

/**
 * The details of a task, wherever they are shown: the window over the board (a dialog) or the
 * panel beside it (a complementary region). Both carry the same accessible name, `Task T1`
 * (or its translation), so a test asks for the task and not for the way it is shown.
 */
export function queryTaskDetails(name: Name): HTMLElement | null {
  return (
    screen.queryByRole('dialog', { name }) ?? screen.queryByRole('complementary', { name }) ?? null
  );
}

export function taskDetails(name: Name): HTMLElement {
  const found = queryTaskDetails(name);
  if (found === null) {
    // Throws the testing library's own message, with the roles that are there.
    return screen.getByRole('dialog', { name });
  }
  return found;
}

export async function findTaskDetails(name: Name): Promise<HTMLElement> {
  return waitFor(() => taskDetails(name));
}

const isTaskWindow = (element: HTMLElement): boolean =>
  element.classList.contains('task-modal__dialog');

/**
 * The dialog on top of the page, not counting the window of a task: a form or a question is
 * asked in front of it, inside it or beside it, and the last one in the page is the newest.
 */
export function queryTopDialog(): HTMLElement | null {
  const dialogs = screen.queryAllByRole('dialog').filter((element) => !isTaskWindow(element));
  return dialogs[dialogs.length - 1] ?? null;
}

export function topDialog(): HTMLElement {
  const found = queryTopDialog();
  if (found === null) return screen.getByRole('dialog');
  return found;
}

export async function findTopDialog(): Promise<HTMLElement> {
  return waitFor(() => topDialog());
}
