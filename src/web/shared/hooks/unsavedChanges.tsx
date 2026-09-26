import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { UnsavedChangesDialog } from '../ui/UnsavedChangesDialog';

/** What a form with something in it tells the page, so that leaving it can be asked about. */
export interface UnsavedChanges {
  /** Whether there is anything to lose. A form with nothing unsaved is never asked about. */
  dirty: boolean;
  /** What is unsaved, as the end of "You have unsaved changes to …". */
  what: string;
  /** A note for the question, when saving means more than it seems (it replaces a change). */
  note?: string | undefined;
  /** Saves. Resolves to why it did not work, or to nothing when it did; it must not throw. */
  save: () => Promise<string | undefined>;
  /** Throws the changes away, without saving. */
  discard: () => void;
}

type Registry = Map<string, RefObject<UnsavedChanges>>;

interface Guard {
  registry: Registry;
  /** Runs `proceed` — now if nothing is unsaved, else once the person has answered. */
  leave: (proceed: () => void) => void;
}

const GuardContext = createContext<Guard | null>(null);

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The page's memory of which forms hold changes, and the one place that asks what to do with
 * them: Save, Discard or Cancel. Every form that can be left with something in it registers
 * with `useUnsavedChanges`; every way of leaving goes through `useLeaveGuard`. So the boards's
 * settings and a task's settings ask the same question, in the same words, and a way out that
 * forgets to ask is the one that does not call the guard.
 */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [registry] = useState<Registry>(() => new Map());
  // What the question says is worked out when it is asked, in the handler, not while drawing.
  const [asking, setAsking] = useState<
    { proceed: () => void; message: string; note: string | undefined } | undefined
  >(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const dirtyForms = useCallback(
    (): UnsavedChanges[] =>
      [...registry.values()].flatMap((form) => (form.current.dirty ? [form.current] : [])),
    [registry],
  );

  const leave = useCallback(
    (proceed: () => void): void => {
      const forms = dirtyForms();
      if (forms.length === 0) {
        proceed();
        return;
      }
      const notes = forms.flatMap((form) => (form.note === undefined ? [] : [form.note]));
      setError(undefined);
      setAsking({
        proceed,
        message: `You have unsaved changes to ${listOf(forms.map((form) => form.what))}.`,
        note: notes.length === 0 ? undefined : notes.join(' '),
      });
    },
    [dirtyForms],
  );

  // The browser's own question, for the ways out of the page that this one cannot intercept.
  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent): void => {
      if (dirtyForms().length === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirtyForms]);

  const guard = useMemo<Guard>(() => ({ registry, leave }), [registry, leave]);

  const finish = (): void => {
    const next = asking;
    setAsking(undefined);
    next?.proceed();
  };

  const save = async (): Promise<void> => {
    setPending(true);
    setError(undefined);
    try {
      // What is dirty now, not when the question was asked: a form saved on the way is done.
      for (const form of dirtyForms()) {
        const failure = await form.save();
        if (failure !== undefined) {
          setError(failure);
          return;
        }
      }
    } finally {
      setPending(false);
    }
    finish();
  };

  const discard = (): void => {
    for (const form of dirtyForms()) form.discard();
    finish();
  };

  return (
    <GuardContext value={guard}>
      {children}
      {asking === undefined ? null : (
        <UnsavedChangesDialog
          message={asking.message}
          note={asking.note}
          error={error}
          pending={pending}
          onSave={() => void save()}
          onDiscard={discard}
          onCancel={() => setAsking(undefined)}
        />
      )}
    </GuardContext>
  );
}

function useGuard(): Guard {
  const guard = use(GuardContext);
  if (!guard) throw new Error('This page must be rendered inside an UnsavedChangesProvider.');
  return guard;
}

/** Tells the page what this form holds; call it on every render with what is true now. */
export function useUnsavedChanges(changes: UnsavedChanges): void {
  const { registry } = useGuard();
  const id = useId();
  const latestRef = useRef(changes);
  useEffect(() => {
    latestRef.current = changes;
  });
  useEffect(() => {
    registry.set(id, latestRef);
    return () => {
      registry.delete(id);
    };
  }, [registry, id]);
}

/** The way out of a place that may hold changes: `leave(() => …)` runs it once it is allowed. */
export function useLeaveGuard(): (proceed: () => void) => void {
  return useGuard().leave;
}
