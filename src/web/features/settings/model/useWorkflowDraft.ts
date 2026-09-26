import { useCallback, useState } from 'react';
import type { WorkflowOverrides, WorkflowState } from '../../../../contract/v1/index';
import { normalizeOverrides, sameOverrides } from './draft';

/** What the form holds: the person's draft, and the settings it was started from. */
interface Session {
  draft: WorkflowOverrides;
  /** The settings the draft is measured against: what the board last said. */
  baseline: WorkflowOverrides;
  /** The last state of the board this session has looked at. */
  seen: WorkflowState;
  /** What the board says now, when it differs from `baseline` while the draft holds changes. */
  elsewhere: WorkflowOverrides | undefined;
  /** What this form has sent and not yet had an answer to. */
  sending: WorkflowOverrides | undefined;
  saved: boolean;
}

const overridesOf = (state: WorkflowState): WorkflowOverrides =>
  structuredClone({ board: state.board, statuses: state.statuses });

function start(state: WorkflowState): Session {
  const overrides = overridesOf(state);
  return {
    draft: overrides,
    baseline: structuredClone(overrides),
    seen: state,
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
function reconcile(session: Session, state: WorkflowState): Session {
  const incoming = overridesOf(state);
  const seen = { ...session, seen: state };
  if (sameOverrides(incoming, session.baseline)) return { ...seen, elsewhere: undefined };
  if (sameOverrides(session.draft, session.baseline)) {
    return { ...seen, draft: incoming, baseline: incoming, elsewhere: undefined };
  }
  if (session.sending !== undefined && sameOverrides(incoming, session.sending)) {
    return { ...seen, baseline: incoming, elsewhere: undefined };
  }
  return { ...seen, elsewhere: incoming };
}

export interface WorkflowDraft {
  draft: WorkflowOverrides;
  dirty: boolean;
  /** Set when the board changed under a form that has unsaved changes. */
  changedElsewhere: boolean;
  saved: boolean;
  edit: (change: (current: WorkflowOverrides) => WorkflowOverrides) => void;
  /** Throws away the draft for what the board says now. */
  takeElsewhere: () => void;
  /** Sends the draft as overrides; what the board answers becomes the baseline. */
  save: (send: (overrides: WorkflowOverrides) => Promise<unknown>) => Promise<void>;
}

/**
 * The form's state, kept apart from the board's: the store mirrors the server, this is what a
 * person is in the middle of typing (ADR-0025). It never writes to the store — only the answer
 * of the board does.
 */
export function useWorkflowDraft(state: WorkflowState): WorkflowDraft {
  const [session, setSession] = useState(() => start(state));

  // Adjusting state while rendering, as React documents it: no effect, no frame in between.
  if (state !== session.seen) setSession(reconcile(session, state));

  const edit = useCallback((change: (current: WorkflowOverrides) => WorkflowOverrides) => {
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

  const save = useCallback(
    async (send: (overrides: WorkflowOverrides) => Promise<unknown>) => {
      const sending = normalizeOverrides(session.draft);
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
        draft: sameOverrides(current.draft, sending) ? current.baseline : current.draft,
        saved: sameOverrides(current.draft, sending),
      }));
    },
    [session.draft],
  );

  return {
    draft: session.draft,
    dirty: !sameOverrides(session.draft, session.baseline),
    changedElsewhere: session.elsewhere !== undefined,
    saved: session.saved,
    edit,
    takeElsewhere,
    save,
  };
}
