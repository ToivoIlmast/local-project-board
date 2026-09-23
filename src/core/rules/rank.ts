import { generateKeyBetween } from 'fractional-indexing';
import { BoardError } from '../errors.js';

export interface Ranked {
  id: string;
  rank: string;
}

/** Neighbour ids in the target column. `after` wins if both are given and not adjacent. */
export interface Position {
  after?: string | undefined;
  before?: string | undefined;
}

const RANK_CHARS = /^[0-9A-Za-z]+$/;

export function isValidRank(rank: string): boolean {
  if (!RANK_CHARS.test(rank)) return false;
  try {
    generateKeyBetween(rank, null);
    return true;
  } catch {
    return false;
  }
}

/** Code-unit order (ranks are not locale text), ties broken by id. */
export function compareByRank(a: Ranked, b: Ranked): number {
  return compare(a.rank, b.rank) || compare(a.id, b.id);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rank for a card placed in `column` at `position`. The moving card itself is ignored,
 * so the same call works for creating, moving between columns and reordering.
 * Cards with equal ranks (possible after concurrent creates) are treated as one group.
 */
export function rankForPosition(
  column: readonly Ranked[],
  position: Position,
  movingId?: string,
): string {
  const cards = column.filter((c) => c.id !== movingId).sort(compareByRank);
  const indexOf = (id: string): number => {
    if (id === movingId) {
      throw new BoardError('INVALID_POSITION', 'A card cannot be placed next to itself.', { id });
    }
    const i = cards.findIndex((c) => c.id === id);
    if (i === -1) {
      throw new BoardError('NEIGHBOR_NOT_FOUND', `Card "${id}" is not in the target column.`, {
        id,
      });
    }
    return i;
  };

  const after = position.after === undefined ? undefined : indexOf(position.after);
  const before = position.before === undefined ? undefined : indexOf(position.before);
  if (after !== undefined && before !== undefined && after >= before) {
    throw new BoardError('INVALID_POSITION', '`after` must come before `before`.', {
      after: position.after,
      before: position.before,
    });
  }

  if (after !== undefined) {
    const lower = rankAt(cards, after);
    return generateKeyBetween(lower, cards.find((c) => c.rank > lower)?.rank ?? null);
  }
  if (before !== undefined) {
    const upper = rankAt(cards, before);
    return generateKeyBetween(cards.findLast((c) => c.rank < upper)?.rank ?? null, upper);
  }
  return generateKeyBetween(cards.at(-1)?.rank ?? null, null);
}

function rankAt(cards: readonly Ranked[], index: number): string {
  const card = cards[index];
  if (card === undefined) throw new RangeError(`No card at ${index}.`);
  return card.rank;
}
