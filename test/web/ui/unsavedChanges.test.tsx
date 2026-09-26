import { jest } from '@jest/globals';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import {
  UnsavedChangesProvider,
  useLeaveGuard,
  useUnsavedChanges,
  type UnsavedChanges,
} from '../../../src/web/shared/hooks/unsavedChanges';

/** A stand-in for any form: it says what it holds and what saving and discarding do. */
function Form({ changes }: { changes: UnsavedChanges }) {
  useUnsavedChanges(changes);
  return <p>a form</p>;
}

function Leave({ onLeave }: { onLeave: () => void }) {
  const guard = useLeaveGuard();
  return <button onClick={() => guard(onLeave)}>Leave</button>;
}

const aForm = (extra: Partial<UnsavedChanges> = {}): UnsavedChanges => ({
  dirty: true,
  what: 'the settings of T1',
  save: jest.fn<UnsavedChanges['save']>().mockResolvedValue(undefined),
  discard: jest.fn(),
  ...extra,
});

function setup(forms: UnsavedChanges[]) {
  const onLeave = jest.fn();
  const user = userEvent.setup();
  const view = render(
    <UnsavedChangesProvider>
      {forms.map((changes, index) => (
        <Form key={index} changes={changes} />
      ))}
      <Leave onLeave={onLeave} />
    </UnsavedChangesProvider>,
  );
  return { onLeave, user, ...view };
}

const dialog = () => screen.getByRole('dialog', { name: 'Unsaved changes' });
const choice = (name: string) => within(dialog()).getByRole('button', { name });

describe('leaving a form that has unsaved changes', () => {
  it('goes straight on when nothing is unsaved: no question (INVARIANT)', async () => {
    const { user, onLeave } = setup([aForm({ dirty: false })]);

    await user.click(screen.getByRole('button', { name: 'Leave' }));

    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('goes straight on when there is no form at all', async () => {
    const { user, onLeave } = setup([]);

    await user.click(screen.getByRole('button', { name: 'Leave' }));

    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('asks first, says what is unsaved, and offers Save, Discard and Cancel in that order', async () => {
    const { user, onLeave } = setup([aForm()]);

    await user.click(screen.getByRole('button', { name: 'Leave' }));

    expect(dialog()).toHaveTextContent('You have unsaved changes to the settings of T1.');
    expect(
      within(dialog())
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['✕', 'Save', 'Discard', 'Cancel']);
    // Nothing has happened yet, and the safe choice has the focus.
    expect(onLeave).not.toHaveBeenCalled();
    expect(choice('Save')).toHaveFocus();
  });

  describe('Save', () => {
    it('saves, and only then goes on', async () => {
      const form = aForm();
      const { user, onLeave } = setup([form]);
      await user.click(screen.getByRole('button', { name: 'Leave' }));

      await user.click(choice('Save'));

      await waitFor(() => expect(onLeave).toHaveBeenCalledTimes(1));
      expect(form.save).toHaveBeenCalledTimes(1);
      expect(form.discard).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('waits for the answer: nothing moves, and the buttons are off while it is on its way', async () => {
      let answer: (message: string | undefined) => void = () => undefined;
      const form = aForm({
        save: () => new Promise<string | undefined>((resolve) => (answer = resolve)),
      });
      const { user, onLeave } = setup([form]);
      await user.click(screen.getByRole('button', { name: 'Leave' }));

      await user.click(choice('Save'));

      expect(within(dialog()).getByRole('button', { name: 'Saving…' })).toBeDisabled();
      expect(choice('Discard')).toBeDisabled();
      expect(choice('Cancel')).toBeDisabled();
      expect(onLeave).not.toHaveBeenCalled();
      await act(async () => answer(undefined));
      await waitFor(() => expect(onLeave).toHaveBeenCalledTimes(1));
    });

    it('does not go on when saving fails: the question stays, says why, and nothing is lost (INVARIANT)', async () => {
      const form = aForm({
        save: jest.fn<UnsavedChanges['save']>().mockResolvedValueOnce('The board said no.'),
      });
      const { user, onLeave } = setup([form]);
      await user.click(screen.getByRole('button', { name: 'Leave' }));

      await user.click(choice('Save'));

      expect(await within(dialog()).findByRole('alert')).toHaveTextContent('The board said no.');
      expect(onLeave).not.toHaveBeenCalled();
      expect(form.discard).not.toHaveBeenCalled();
      expect(choice('Save')).toBeEnabled();

      // Trying again is possible, and the old message does not outlive it.
      await user.click(choice('Save'));
      await waitFor(() => expect(onLeave).toHaveBeenCalledTimes(1));
      expect(form.save).toHaveBeenCalledTimes(2);
    });

    it('can still be cancelled after a failure, with the form as it was', async () => {
      const form = aForm({
        save: jest.fn<UnsavedChanges['save']>().mockResolvedValue('The board said no.'),
      });
      const { user, onLeave } = setup([form]);
      await user.click(screen.getByRole('button', { name: 'Leave' }));
      await user.click(choice('Save'));
      await within(dialog()).findByRole('alert');

      await user.click(choice('Cancel'));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(onLeave).not.toHaveBeenCalled();
      expect(form.discard).not.toHaveBeenCalled();
      expect(screen.getByText('a form')).toBeInTheDocument();
    });

    it('saves every form that has changes, and goes on once', async () => {
      const first = aForm();
      const second = aForm({ what: 'the settings of the board' });
      const clean = aForm({ dirty: false });
      const { user, onLeave } = setup([first, second, clean]);
      await user.click(screen.getByRole('button', { name: 'Leave' }));
      expect(dialog()).toHaveTextContent(
        'You have unsaved changes to the settings of T1 and the settings of the board.',
      );

      await user.click(choice('Save'));

      await waitFor(() => expect(onLeave).toHaveBeenCalledTimes(1));
      expect(first.save).toHaveBeenCalledTimes(1);
      expect(second.save).toHaveBeenCalledTimes(1);
      expect(clean.save).not.toHaveBeenCalled();
    });

    it('stops at the first form that cannot be saved', async () => {
      const first = aForm({
        save: jest.fn<UnsavedChanges['save']>().mockResolvedValue('First failed.'),
      });
      const second = aForm();
      const { user, onLeave } = setup([first, second]);
      await user.click(screen.getByRole('button', { name: 'Leave' }));

      await user.click(choice('Save'));

      expect(await within(dialog()).findByRole('alert')).toHaveTextContent('First failed.');
      expect(second.save).not.toHaveBeenCalled();
      expect(onLeave).not.toHaveBeenCalled();
    });
  });

  describe('Discard', () => {
    it('drops the changes without saving, and goes on', async () => {
      const form = aForm();
      const { user, onLeave } = setup([form]);
      await user.click(screen.getByRole('button', { name: 'Leave' }));

      await user.click(choice('Discard'));

      expect(form.discard).toHaveBeenCalledTimes(1);
      expect(form.save).not.toHaveBeenCalled();
      expect(onLeave).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('Cancel', () => {
    it('stays: nothing is saved, dropped or left, and the focus goes back where it was', async () => {
      const form = aForm();
      const { user, onLeave } = setup([form]);
      const leave = screen.getByRole('button', { name: 'Leave' });
      await user.click(leave);

      await user.click(choice('Cancel'));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(form.save).not.toHaveBeenCalled();
      expect(form.discard).not.toHaveBeenCalled();
      expect(onLeave).not.toHaveBeenCalled();
      expect(leave).toHaveFocus();
    });

    it('is what Escape and the close button of the dialog do', async () => {
      const { user, onLeave } = setup([aForm()]);
      const leave = screen.getByRole('button', { name: 'Leave' });

      await user.click(leave);
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      await user.click(leave);
      await user.click(within(dialog()).getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(onLeave).not.toHaveBeenCalled();
    });

    it('asks again the next time', async () => {
      const { user, onLeave } = setup([aForm()]);
      const leave = screen.getByRole('button', { name: 'Leave' });
      await user.click(leave);
      await user.click(choice('Cancel'));

      await user.click(leave);

      expect(dialog()).toBeInTheDocument();
      expect(onLeave).not.toHaveBeenCalled();
    });
  });

  it('says so when the settings were also changed elsewhere, because saving replaces that change', async () => {
    const { user } = setup([aForm({ note: 'They were also changed elsewhere.' })]);

    await user.click(screen.getByRole('button', { name: 'Leave' }));

    expect(dialog()).toHaveTextContent('They were also changed elsewhere.');
  });

  it('forgets a form that is gone: it cannot be asked about', async () => {
    function Toggle() {
      const [shown, setShown] = useState(true);
      return (
        <>
          {shown ? <Form changes={aForm()} /> : null}
          <button onClick={() => setShown(false)}>Remove</button>
        </>
      );
    }
    const onLeave = jest.fn();
    const user = userEvent.setup();
    render(
      <UnsavedChangesProvider>
        <Toggle />
        <Leave onLeave={onLeave} />
      </UnsavedChangesProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await user.click(screen.getByRole('button', { name: 'Leave' }));

    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('follows what the form says now, not what it said when it was drawn first', async () => {
    function Editing() {
      const [dirty, setDirty] = useState(false);
      useUnsavedChanges({ ...aForm(), dirty });
      return <button onClick={() => setDirty(!dirty)}>Edit</button>;
    }
    const onLeave = jest.fn();
    const user = userEvent.setup();
    render(
      <UnsavedChangesProvider>
        <Editing />
        <Leave onLeave={onLeave} />
      </UnsavedChangesProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Leave' }));
    expect(dialog()).toBeInTheDocument();
    await user.click(choice('Cancel'));

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Leave' }));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  describe('closing the tab or reloading', () => {
    const leaving = (): Event => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event;
    };

    it('is held back by the browser’s own question while something is unsaved', () => {
      setup([aForm()]);
      expect(leaving().defaultPrevented).toBe(true);
    });

    it('is not held back when nothing is unsaved', () => {
      setup([aForm({ dirty: false })]);
      expect(leaving().defaultPrevented).toBe(false);
    });
  });
});
