import type { Task } from '../../../../contract/v1/index';

export interface CardBox {
  id: string;
  top: number;
  height: number;
}

/** What the board asks the server for; the rank is the server's to compute (ADR-0011). */
export interface MoveIntent {
  status: string;
  after?: string;
  before?: string;
}

/**
 * The place in a column a pointer at `y` is over: one past every card whose middle it has
 * passed. The card being dragged does not count — it is still in the list, but it cannot
 * be its own neighbour.
 */
export function indexAt(boxes: CardBox[], y: number, dragged?: string): number {
  return boxes.filter((box) => box.id !== dragged && y > box.top + box.height / 2).length;
}

/**
 * The move a drop means, said in the only terms the API takes: the neighbour to land after,
 * or the one to land before. The board never computes a position itself (§18).
 */
export function intentFor(
  column: Task[],
  dragged: string,
  index: number,
  status: string,
): MoveIntent {
  const others = column.filter((task) => task.id !== dragged);
  const first = others[0];
  if (first === undefined) return { status };
  if (index <= 0) return { status, before: first.id };
  const previous = others[Math.min(index, others.length) - 1];
  return previous === undefined ? { status } : { status, after: previous.id };
}

/** Whether the board would end up exactly as it already is. */
export function isNoop(task: Task, column: Task[], intent: MoveIntent): boolean {
  if (task.status !== intent.status) return false;
  const index = column.findIndex((candidate) => candidate.id === task.id);
  if (index === -1) return false;
  if (intent.before !== undefined) return column[index + 1]?.id === intent.before;
  if (intent.after !== undefined) return column[index - 1]?.id === intent.after;
  return index === column.length - 1;
}
