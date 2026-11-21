import { jest } from '@jest/globals';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { useDialog } from '../../../src/web/shared/hooks/useDialog';
import { Menu, Modal } from '../../../src/web/shared/ui/index';

const root = document.documentElement;

function Nested({ withMenu = false }: { withMenu?: boolean }) {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(false);
  return (
    <>
      <button type="button">page</button>
      {!outer ? null : (
        <Modal title="Outer" onClose={() => setOuter(false)}>
          <input aria-label="outer field" />
          <button type="button" onClick={() => setInner(true)}>
            open inner
          </button>
          {withMenu ? (
            <Menu label="More" items={[{ label: 'Act', onSelect: () => undefined }]} />
          ) : null}
          {!inner ? null : (
            <Modal title="Inner" onClose={() => setInner(false)}>
              <input aria-label="inner field" />
            </Modal>
          )}
        </Modal>
      )}
    </>
  );
}

beforeEach(() => {
  root.style.overflow = '';
});

describe('nested dialogs', () => {
  it('closes only the top one on Escape, then the next', async () => {
    const user = userEvent.setup();
    render(<Nested />);
    await user.click(screen.getByRole('button', { name: 'open inner' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(2);

    await user.keyboard('{Escape}');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'open inner' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps Tab inside the top dialog', async () => {
    const user = userEvent.setup();
    render(<Nested />);
    await user.click(screen.getByRole('button', { name: 'open inner' }));
    const inner = screen.getByRole('dialog', { name: 'Inner' });
    expect(within(inner).getByLabelText('inner field')).toHaveFocus();
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(inner.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 6; i += 1) {
      await user.tab({ shift: true });
      expect(inner.contains(document.activeElement)).toBe(true);
    }
  });

  it('locks scrolling while any dialog is open and restores the old value', async () => {
    const user = userEvent.setup();
    root.style.overflow = 'scroll';
    render(<Nested />);
    expect(root.style.overflow).toBe('hidden');
    await user.click(screen.getByRole('button', { name: 'open inner' }));
    expect(root.style.overflow).toBe('hidden');
    await user.keyboard('{Escape}');
    expect(root.style.overflow).toBe('hidden');
    await user.keyboard('{Escape}');
    expect(root.style.overflow).toBe('scroll');
  });

  it('lets go of the lock and the stack when unmounted without closing', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Nested />);
    unmount();
    expect(root.style.overflow).toBe('');

    // A dialog opened later is the top one, so the old one left nothing behind.
    const onClose = jest.fn();
    render(
      <Modal title="Later" onClose={onClose}>
        <input aria-label="f" />
      </Modal>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes only the menu on Escape inside a dialog', async () => {
    const user = userEvent.setup();
    render(<Nested withMenu />);
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('button', { name: 'Act' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Act' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

function Switchable({ onClose }: { onClose: () => void }) {
  const [active, setActive] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDialog({ ref, onClose, active, initialFocus: (container) => container });
  return (
    <>
      <button type="button" onClick={() => setActive(!active)}>
        toggle
      </button>
      <div ref={ref} tabIndex={-1} data-testid="box">
        <button type="button">inside</button>
      </div>
    </>
  );
}

describe('useDialog active', () => {
  it('does nothing while inactive and behaves like an opening when it turns on', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(<Switchable onClose={onClose} />);
    expect(root.style.overflow).toBe('');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(root.style.overflow).toBe('hidden');
    expect(screen.getByTestId('box')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    // Tab stays inside the container.
    await user.tab();
    await user.tab();
    expect(screen.getByTestId('box').contains(document.activeElement)).toBe(true);

    screen.getByRole('button', { name: 'toggle' }).focus();
    await user.keyboard('{Enter}');
    expect(root.style.overflow).toBe('');
    expect(screen.getByRole('button', { name: 'toggle' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
