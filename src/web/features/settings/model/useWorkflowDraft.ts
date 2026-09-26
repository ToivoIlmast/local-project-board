import { useCallback, useState } from 'react';
import type { WorkflowOverrides, WorkflowState } from '../../../../contract/v1/index';
import { normalizeOverrides, sameOverrides } from './draft';

/**
 * What a form of overrides needs to know about its own shape: how to take a draft out of what
 * the board said, how to tell two drafts apart, and what is sent. The board and its columns
 * have one shape (`WorkflowOverrides`), a task another; the rules of a draft are the same.
 */
export interface DraftKit<Source, Value> {
  read: (source: Source) => Value;
  same: (a: Value, b: Value) => boolean;
  /** What is sent: the draft without what says nothing. */
  normalize: (value: Value) => Value;
}

/** What the form holds: the person's draft, and the settings it was started from. */
interface Session<Source, Value> {
  draft: Value;
  /** The settings the draft is measured against: what the board last said. */
  baseline: Value;
  /** The last thing the board said that this session has looked at. */
  seen: Source;
  /** What the board says now, when it differs from `baseline` while the draft holds changes. */
  elsewhere: Value | undefined;
  /** What this form has sent and not yet had an answer to. */
  sending: Value | undefined;
  saved: boolean;
}

function start<Source, Value>(
  source: Source,
  kit: DraftKit<Source, Value>,
): Session<Source, Value> {
  const value = kit.read(source);
  return {
    draft: value,
    baseline: structuredClone(value),
    seen: source,
    elsewhere: undefined,
    sending: undefined,
    saved: false,
  };
}

/**
 * The board said something. A form with nothing unsaved takes it. A form with changes keeps
 * them — silently replacing what someone is typing is the one thing to avoid — and remembers
 * that the board moved on, so the page can say so. What the form itself has just saved is the
 * board agreeing with it, not somebody else.
 */
function reconcile<Source, Value>(
  session: Session<Source, Value>,
  source: Source,
  kit: DraftKit<Source, Value>,
): Session<Source, Value> {
  const incoming = kit.read(source);
  const seen = { ...session, seen: source };
  if (kit.same(incoming, session.baseline)) return { ...seen, elsewhere: undefined };
  if (kit.same(session.draft, session.baseline)) {
    return { ...seen, draft: incoming, baseline: incoming, elsewhere: undefined };
  }
  if (session.sending !== undefined && kit.same(incoming, session.sending)) {
    return { ...seen, baseline: incoming, elsewhere: undefined };
  }
  return { ...seen, elsewhere: incoming };
}

export interface OverridesDraft<Value> {
  draft: Value;
  dirty: boolean;
  /** Set when the board changed under a form that has unsaved changes. */
  changedElsewhere: boolean;
  saved: boolean;
  edit: (change: (current: Value) => Value) => void;
  /** Throws away the draft for what the board says now. */
  takeElsewhere: () => void;
  /** Throws the changes away: the draft is what the board last said, or says now. */
  discard: () => void;
  /**
   * Sends the draft as overrides; what the board answers becomes the baseline. With a `value`
   * it sends that instead and the draft is dropped for the answer: a reset is a save of
   * "nothing" that does not care what was typed.
   */
  save: (send: (value: Value) => Promise<unknown>, value?: Value) => Promise<void>;
}

/**
 * The state of a form of overrides, kept apart from the board's: the store mirrors the server,
 * this is what a person is in the middle of typing (ADR-0025). It never writes to the store —
 * only the answer of the board does. `source` is what the board last said; a new one is
 * reconciled with the draft. The kit must be the same object on every render.
 */
export function useOverridesDraft<Source, Value>(
  source: Source,
  kit: DraftKit<Source, Value>,
): OverridesDraft<Value> {
  const [session, setSession] = useState(() => start(source, kit));

  // Adjusting state while rendering, as React documents it: no effect, no frame in between.
  if (source !== session.seen) setSession(reconcile(session, source, kit));

  const edit = useCallback((change: (current: Value) => Value) => {
    setSession((current) => ({ ...current, draft: change(current.draft), saved: false }));
  }, []);

  const takeElsewhere = useCallback(() => {
    setSession((current) =>
      current.elsewhere === undefined
        ? current
        : {
            ...current,
            draft: structuredClone(current.elsewhere),
            baseline: current.elsewhere,
            elsewhere: undefined,
          },
    );
  }, []);

  const discard = useCallback(() => {
    setSession((current) => {
      const board = current.elsewhere ?? current.baseline;
      return {
        ...current,
        draft: structuredClone(board),
        baseline: board,
        elsewhere: undefined,
        saved: false,
      };
    });
  }, []);

  const save = useCallback(
    async (send: (value: Value) => Promise<unknown>, value?: Value) => {
      const sending = kit.normalize(value ?? session.draft);
      setSession((current) => ({ ...current, sending, saved: false }));
      try {
        await send(sending);
      } catch (error) {
        setSession((current) => ({ ...current, sending: undefined }));
        throw error;
      }
      setSession((current) => ({
        ...current,
        sending: undefined,
        // The answer is already the baseline (it arrived as an event before this line); a
        // draft that is just what was sent is now the baseline's twin.
        draft:
          value !== undefined || kit.same(current.draft, sending)
            ? current.baseline
            : current.draft,
        saved: kit.same(current.draft, sending),
      }));
    },
    [kit, session.draft],
  );

  return {
    draft: session.draft,
    dirty: !kit.same(session.draft, session.baseline),
    changedElsewhere: session.elsewhere !== undefined,
    saved: session.saved,
    edit,
    takeElsewhere,
    discard,
    save,
  };
}

const workflowKit: DraftKit<WorkflowState, WorkflowOverrides> = {
  read: (state) => structuredClone({ board: state.board, statuses: state.statuses }),
  same: sameOverrides,
  normalize: normalizeOverrides,
};

export type WorkflowDraft = OverridesDraft<WorkflowOverrides>;

/** The draft of the settings of the board and of its columns. */
export function useWorkflowDraft(state: WorkflowState): WorkflowDraft {
  return useOverridesDraft(state, workflowKit);
}
