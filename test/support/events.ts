import type { BoardEvent } from '../../src/core/events.js';
import type { EventSink } from '../../src/core/ports.js';

export interface RecordingEventSink extends EventSink {
  events: BoardEvent[];
  types(): string[];
  last(): BoardEvent | undefined;
}

export function recordingEventSink(): RecordingEventSink {
  const events: BoardEvent[] = [];
  return {
    events,
    publish: (event) => events.push(event),
    types: () => events.map((event) => event.type),
    last: () => events.at(-1),
  };
}
