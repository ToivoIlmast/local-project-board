import { indexAt, intentFor, isNoop } from '../../../src/web/features/board/model/dnd';
import { aTask } from '../support/fixtures';

const boxes = [
  { id: 'T1', top: 0, height: 100 },
  { id: 'T2', top: 100, height: 100 },
  { id: 'T3', top: 200, height: 100 },
];

describe('where a dragged card lands', () => {
  it('counts the cards whose middle the pointer has passed', () => {
    expect(indexAt(boxes, 10)).toBe(0);
    expect(indexAt(boxes, 60)).toBe(1);
    expect(indexAt(boxes, 160)).toBe(2);
    expect(indexAt(boxes, 999)).toBe(3);
  });

  it('does not count the card being dragged (INVARIANT: it is not its own neighbour)', () => {
    expect(indexAt(boxes, 160, 'T1')).toBe(1);
    expect(indexAt(boxes, 999, 'T2')).toBe(2);
  });

  it('lands at the top of an empty column', () => {
    expect(indexAt([], 500)).toBe(0);
  });
});

describe('what the board asks the server to do', () => {
  const column = [aTask({ id: 'T1', rank: 'a0' }), aTask({ id: 'T2', rank: 'a1' })];

  it('names the card to land before when the card goes first', () => {
    expect(intentFor(column, 'T2', 0, 'todo')).toEqual({ status: 'todo', before: 'T1' });
  });

  it('names the card to land after everywhere else', () => {
    expect(intentFor(column, 'T2', 1, 'todo')).toEqual({ status: 'todo', after: 'T1' });
    expect(intentFor(column, 'T1', 2, 'todo')).toEqual({ status: 'todo', after: 'T2' });
  });

  it('never names the dragged card as its own neighbour (INVARIANT)', () => {
    const three = [...column, aTask({ id: 'T3', rank: 'a2' })];

    for (const id of ['T1', 'T2', 'T3']) {
      for (const index of [0, 1, 2]) {
        const intent = intentFor(three, id, index, 'todo');
        expect(intent.after).not.toBe(id);
        expect(intent.before).not.toBe(id);
      }
    }
  });

  it('asks for the end of an empty column without naming anyone', () => {
    expect(intentFor([], 'T9', 0, 'done')).toEqual({ status: 'done' });
    // A card arriving from another column lands before the card that is first there.
    expect(intentFor(column, 'T9', 0, 'done')).toEqual({ status: 'done', before: 'T1' });
  });

  it('never computes a rank: the server owns the order (INVARIANT)', () => {
    const intent = intentFor(column, 'T2', 0, 'todo');

    expect('rank' in intent).toBe(false);
    expect(Object.keys(intent).sort()).toEqual(['before', 'status']);
  });

  it('says when a drop changes nothing, so the board is not written to for nothing', () => {
    const [first, second] = column;
    expect(isNoop(first!, column, { status: 'todo', before: 'T2' })).toBe(true);
    expect(isNoop(second!, column, { status: 'todo', after: 'T1' })).toBe(true);
    expect(isNoop(second!, column, { status: 'todo', before: 'T1' })).toBe(false);
    expect(isNoop(second!, column, { status: 'done', after: 'T1' })).toBe(false);
  });
});
