import { blockingReasonSchema } from '../../../../contract/v1/index';
import { ApiError } from '../../../api/index';
import { taskT } from '../i18n/details';
import { reasonText } from './readinessText';

/**
 * What the page says of a failure. A `TASK_BLOCKED` carries the reasons as codes in its details;
 * the page words them, as it does on the cards, so the person is told what to do and not only
 * that the board refused. Anything else is left as it came.
 */
export function explainError<E>(error: E): E | ApiError {
  if (!(error instanceof ApiError) || error.code !== 'TASK_BLOCKED') return error;
  const parsed = blockingReasonSchema.array().safeParse(error.details['reasons']);
  if (!parsed.success || parsed.data.length === 0) return error;
  const id = error.details['id'];
  const reasons = parsed.data.map(reasonText).join('; ');
  return new ApiError(
    error.status,
    error.code,
    typeof id === 'string'
      ? taskT('error.blockedTask', { id, reasons })
      : taskT('error.blocked', { reasons }),
    error.details,
  );
}
