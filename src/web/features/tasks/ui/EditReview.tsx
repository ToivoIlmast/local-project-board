import { useState } from 'react';
import {
  applyContentPatch,
  contentOf,
  type FromCheck,
  type Task,
} from '../../../../contract/v1/index';
import { ApiError } from '../../../api/index';
import { useBoard } from '../../../api/react';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { Button, Text } from '../../../shared/ui/index';
import { currentHash, draftChanges, hasChanges, type TaskDraft } from '../model/history';
import {
  describeMove,
  needsStatusConfirmation,
  placementPatch,
  placementRefusal,
  type FieldErrors,
  type PlacementValues,
} from '../model/placement';
import { reasonText } from '../model/readinessText';
import { ContentDiffView } from './ContentDiffView';

export interface EditReviewProps {
  /** The task as the board has it now; it moves under the page when an agent writes. */
  task: Task;
  /** The task the draft was started from: what the person changed is measured against it. */
  original: Task;
  draft: TaskDraft;
  /** Where the task is to be placed and what it is to wait for; not content, so no version. */
  placement: PlacementValues;
  /** The board refused the topic, the block or the dependencies: the form says it at the field. */
  onRefused: (errors: FieldErrors) => void;
  /** Where the content came from, when it came from a recommendation (ADR-0030 §7). */
  fromCheck?: FromCheck | undefined;
  onBack: () => void;
  onCancel: () => void;
  onSaved: () => void;
}

/**
 * The step before a save (T46): the draft against the content the task has now, as a diff, with
 * Save and Cancel. What is saved is what is shown: the fields the person changed, put over the
 * content the board has now, and only those fields are sent, with the hash of the content that
 * was shown. If the board's content moves again before the save lands, the board refuses it
 * (409) and nothing is written; the draft stays here, against the new content, and nothing is
 * merged on the person's behalf.
 */
export function EditReview({
  task,
  original,
  draft,
  placement,
  onRefused,
  fromCheck,
  onBack,
  onCancel,
  onSaved,
}: EditReviewProps) {
  const { client, store, state } = useBoard();
  const [conflict, setConflict] = useState(false);

  const changes = draftChanges(original, draft);
  const placed = placementPatch(original, placement);
  const placeChanged = Object.keys(placed).length > 0;
  const reasons = state.readiness[task.id] ?? [];
  // A status change of a blocked task, and a move to another topic or block, are confirmed here:
  // this review is the question, with what the change would mean, and Save the answer (§8).
  const statusAsked =
    changes.status !== undefined && needsStatusConfirmation(task, reasons, changes.status);
  const move =
    placed.topic !== undefined || placed.block !== undefined
      ? describeMove(
          {
            tasks: state.tasks,
            topics: state.topics,
            readIssues: state.project?.readIssues ?? [],
            statuses: state.project?.statuses ?? [],
          },
          task.id,
          { topic: placement.topic, block: placement.block },
        )
      : undefined;
  const now = contentOf(task);
  const proposed = applyContentPatch(now, changes.content);
  const contentChanged = Object.keys(changes.content).length > 0;
  const movedUnderneath = currentHash(task) !== currentHash(original);

  const save = useAsyncAction(async () => {
    try {
      await store.updateTask(task.id, {
        ...changes.content,
        ...(changes.status === undefined ? {} : { status: changes.status }),
        ...(changes.branch === undefined ? {} : { branch: changes.branch }),
        ...placed,
        // The hash of what the diff above shows as the current content.
        ifContentHash: currentHash(task),
        ...(fromCheck !== undefined && contentChanged ? { fromCheck } : {}),
      });
    } catch (error) {
      const refusal = placementRefusal(error);
      if (refusal !== undefined) {
        // Nothing was written. Back to the form, with the entries, and the refusal at its field.
        onRefused(refusal);
        return;
      }
      if (error instanceof ApiError && error.code === 'TASK_CONTENT_CHANGED') {
        // Read the task again, so that the diff is against what is there now.
        const fresh = await client.getTask(task.id).catch(() => undefined);
        if (fresh !== undefined) {
          // The task as the event carries it; its readiness is the store's to read.
          const { readiness: _readiness, ...current } = fresh;
          await store.handleEvent({ type: 'task.updated', task: current });
        }
        setConflict(true);
        throw new Error(
          'The task changed while you were reviewing. Your changes are kept below, against its ' +
            'current content; save again, or cancel.',
          { cause: error },
        );
      }
      throw error;
    }
    onSaved();
  });

  return (
    <div className="review">
      <h3 className="review__title">Review changes to {task.id}</h3>
      {movedUnderneath && !conflict ? (
        <p className="notice" role="status">
          The task changed since you started editing. Below are your changes put over its current
          content.
        </p>
      ) : null}

      {contentChanged ? (
        <ContentDiffView before={now} after={proposed} label={`Changes to ${task.id}`} />
      ) : (
        <Text tone="muted">No changes to the title, the labels or the description.</Text>
      )}

      {changes.status === undefined && changes.branch === undefined ? null : (
        <ul className="review__other">
          {changes.status === undefined ? null : (
            <li>
              Status: {task.status} → {changes.status}
            </li>
          )}
          {changes.branch === undefined ? null : (
            <li>
              Branch: {task.branch ?? 'none'} → {changes.branch ?? 'none'}
            </li>
          )}
        </ul>
      )}

      {statusAsked ? (
        <div className="notice" role="status">
          <p>
            {task.id} is blocked. Changing its status from {task.status} to {changes.status} by hand
            is allowed; the board will not stop it.
          </p>
          <ul>
            {reasons.map((reason) => (
              <li key={reasonText(reason)}>{reasonText(reason)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {move === undefined ? null : (
        <section className="review__move" aria-label="Move">
          <h4 className="review__title">Move {task.id}</h4>
          <dl className="review__places">
            <dt>From</dt>
            <dd>{move.from}</dd>
            <dt>To</dt>
            <dd>{move.to}</dd>
          </dl>
          <p>
            Readiness now:{' '}
            {move.before.length === 0 ? 'ready' : `blocked — ${move.before.join('; ')}`}
          </p>
          <p>
            Readiness after:{' '}
            {move.after.length === 0 ? 'ready' : `blocked — ${move.after.join('; ')}`}
          </p>
          <ul>
            {move.blocks.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      {save.error === undefined ? null : (
        <p className="form__error" role="alert">
          {save.error}
        </p>
      )}
      <div className="form__actions">
        <Button onClick={onBack}>Back to editing</Button>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant="primary"
          disabled={save.pending || !(hasChanges(changes) || placeChanged)}
          onClick={() => void save.run()}
        >
          {save.pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
