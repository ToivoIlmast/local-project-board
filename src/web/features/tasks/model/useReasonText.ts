import { useMemo } from 'react';
import type { BlockingReason } from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { isArchived } from '../../../api/index';
import { reasonText } from './readinessText';

/**
 * `reasonText` that knows which tasks are in the archive, so a task that waits for an archived one
 * says so (T10). The set is read from the board the page holds.
 */
export function useReasonText(): (reason: BlockingReason) => string {
  const { state } = useBoard();
  const archived = useMemo(
    () => new Set(state.tasks.filter(isArchived).map((task) => task.id)),
    [state.tasks],
  );
  return useMemo(() => (reason: BlockingReason) => reasonText(reason, archived), [archived]);
}
