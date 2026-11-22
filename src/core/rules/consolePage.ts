/**
 * Which entries of a journal a read answers (plan C7). Pure, so the service and a test say the
 * same thing: `after` keeps the entries with a greater `seq` and answers the first `limit` of
 * them; `before` alone keeps those with a smaller `seq` and answers the last `limit`, the way
 * back through a long journal; both keep what lies between and answer the first `limit`.
 */
export interface ConsolePageQuery {
  after?: number | undefined;
  before?: number | undefined;
  limit: number;
}

export function pageConsole<T extends { seq: number }>(
  entries: readonly T[],
  query: ConsolePageQuery,
): T[] {
  const kept = entries.filter(
    (entry) =>
      (query.after === undefined || entry.seq > query.after) &&
      (query.before === undefined || entry.seq < query.before),
  );
  return query.before !== undefined && query.after === undefined
    ? kept.slice(Math.max(0, kept.length - query.limit))
    : kept.slice(0, query.limit);
}
