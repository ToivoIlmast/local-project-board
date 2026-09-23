import { BoardError } from '../errors.js';

export function isKnownStatus(status: string, statuses: readonly string[]): boolean {
  return statuses.includes(status);
}

export function assertKnownStatus(status: string, statuses: readonly string[]): void {
  if (!isKnownStatus(status, statuses)) {
    throw new BoardError('UNKNOWN_STATUS', `Unknown status "${status}".`, {
      status,
      allowed: [...statuses],
    });
  }
}
