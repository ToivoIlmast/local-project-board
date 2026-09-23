import type { BoardEvent } from '../../src/core/events.js';
import { createEventBus } from '../../src/server/events/index.js';

const created: BoardEvent = { type: 'task.deleted', taskId: 'T1' };
const changed: BoardEvent = { type: 'board.changed' };

describe('the in-process event bus', () => {
  it('gives every subscriber every event, in order', () => {
    const bus = createEventBus();
    const first: BoardEvent[] = [];
    const second: BoardEvent[] = [];
    bus.subscribe((event) => first.push(event));
    bus.subscribe((event) => second.push(event));

    bus.publish(created);
    bus.publish(changed);

    expect(first).toEqual([created, changed]);
    expect(second).toEqual([created, changed]);
  });

  it('forgets a subscriber that unsubscribes, and frees its place', () => {
    const bus = createEventBus();
    const seen: BoardEvent[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event));
    expect(bus.size).toBe(1);

    bus.publish(created);
    unsubscribe();
    bus.publish(changed);

    expect(seen).toEqual([created]);
    expect(bus.size).toBe(0);
  });

  it('unsubscribes only once, however often it is called', () => {
    const bus = createEventBus();
    const unsubscribe = bus.subscribe(() => undefined);
    bus.subscribe(() => undefined);

    unsubscribe();
    unsubscribe();

    expect(bus.size).toBe(1);
  });

  /** A browser tab that has gone away must not be able to fail a write to the board. */
  it('keeps publishing when a subscriber throws, and reports the failure apart', () => {
    const failures: unknown[] = [];
    const bus = createEventBus({ onListenerError: (error) => failures.push(error) });
    const seen: BoardEvent[] = [];
    bus.subscribe(() => {
      throw new Error('socket is gone');
    });
    bus.subscribe((event) => seen.push(event));

    expect(() => bus.publish(created)).not.toThrow();

    expect(seen).toEqual([created]);
    expect((failures[0] as Error).message).toBe('socket is gone');
  });

  it('delivers to the subscribers of the moment, not to ones added while publishing', () => {
    const bus = createEventBus();
    const late: BoardEvent[] = [];
    bus.subscribe(() => {
      bus.subscribe((event) => late.push(event));
    });

    bus.publish(created);

    expect(late).toEqual([]);
    bus.publish(changed);
    expect(late).toEqual([changed]);
  });
});
