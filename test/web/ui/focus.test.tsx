import { act, screen, waitFor, within } from '@testing-library/react';
import { aTask } from '../support/fixtures';
import { renderBoard } from '../support/render';

const dialog = () => screen.getByRole('dialog');

describe('a dialog and the keyboard', () => {
  it('starts on the first field, so typing a title with spaces in it presses nothing', async () => {
    const { user } = await renderBoard();

    await user.click(screen.getByRole('button', { name: 'New task' }));
    expect(within(dialog()).getByLabelText('Title')).toHaveFocus();

    await user.keyboard('Extract the git adapter');
    expect(dialog()).toBeInTheDocument();
    expect(within(dialog()).getByLabelText('Title')).toHaveValue('Extract the git adapter');
  });

  it('starts on the safe answer when it only asks a question', async () => {
    const { user } = await renderBoard({ tasks: [aTask({ id: 'T1' })] });

    await user.click(screen.getByRole('button', { name: 'Actions for T1' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('keeps Tab inside itself and wraps round in both directions', async () => {
    const { user } = await renderBoard();
    await user.click(screen.getByRole('button', { name: 'New task' }));
    await user.type(within(dialog()).getByLabelText('Title'), 'x');

    const close = within(dialog()).getByRole('button', { name: 'Close' });
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    await user.tab();
    expect(within(dialog()).getByLabelText('Title')).toHaveFocus();

    // Every stop on the way round is in the dialog, and there are as many as it has.
    const seen = new Set<Element | null>();
    for (let stop = 0; stop < 12; stop++) {
      await user.tab();
      seen.add(document.activeElement);
      expect(dialog()).toContainElement(document.activeElement as HTMLElement);
    }
    expect(seen.size).toBe(8);
  });

  it('gives the focus back to what opened it when Escape closes it', async () => {
    const { user } = await renderBoard();
    const opener = screen.getByRole('button', { name: 'New task' });

    await user.click(opener);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('does not lose the field the person is typing in when the board changes under it', async () => {
    const { user, board } = await renderBoard();
    await user.click(screen.getByRole('button', { name: 'New task' }));
    await user.type(within(dialog()).getByLabelText('Labels'), 'half typed');

    // An agent adds a task: the page re-renders, and with it the dialog's parent.
    await act(async () => {
      board.emit({ type: 'task.created', task: aTask({ id: 'T9', title: 'Made by an agent' }) });
    });
    await screen.findByText('Made by an agent');

    expect(within(dialog()).getByLabelText('Labels')).toHaveFocus();
    expect(within(dialog()).getByLabelText('Labels')).toHaveValue('half typed');
  });
});

describe('a card menu and the keyboard', () => {
  it('returns to its button when Escape closes it', async () => {
    const { user } = await renderBoard({ tasks: [aTask({ id: 'T1' })] });
    const button = screen.getByRole('button', { name: 'Actions for T1' });

    await user.click(button);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('closes when the focus leaves it', async () => {
    const { user } = await renderBoard({ tasks: [aTask({ id: 'T1', title: 'Only card' })] });

    await user.click(screen.getByRole('button', { name: 'Actions for T1' }));
    await user.tab({ shift: true });
    await user.tab({ shift: true });

    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
  });

  it('follows a card that it moves to another column', async () => {
    const { user } = await renderBoard({
      tasks: [aTask({ id: 'T1', title: 'Moving card', status: 'todo' })],
    });

    await user.click(screen.getByRole('button', { name: 'Actions for T1' }));
    await user.click(screen.getByRole('button', { name: 'Move to done' }));

    const card = await waitFor(() => {
      const moved = screen
        .getByRole('region', { name: /^done \(1\)/ })
        .querySelector<HTMLElement>('[data-task-id="T1"] .card__title');
      if (moved === null) throw new Error('the card has not arrived');
      return moved;
    });
    await waitFor(() => expect(card).toHaveFocus());
  });
});

describe('the panel beside the board and the keyboard', () => {
  it('takes the focus when it is opened, and gives it back when it is closed', async () => {
    const { user } = await renderBoard({ tasks: [aTask({ id: 'T1', title: 'Open me' })] });
    const card = screen.getByRole('button', { name: 'Open me' });

    await user.click(card);
    const panel = screen.getByRole('complementary', { name: 'Task T1' });
    await waitFor(() => expect(panel).toHaveFocus());

    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(card).toHaveFocus();
  });

  it('does not take the focus from a page that was loaded on it', async () => {
    window.history.replaceState({}, '', '/?task=T1');
    await renderBoard({ tasks: [aTask({ id: 'T1', title: 'Deep link' })] });

    expect(screen.getByRole('complementary', { name: 'Task T1' })).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });
});
