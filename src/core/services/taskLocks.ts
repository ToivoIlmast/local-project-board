/**
 * One queue per task for the changes of its AI run (T45). A change of the lifecycle reads the
 * run and writes it back; two of them at once must not both read the same run. The board is
 * one process (ADR-0024), so a promise chain per task is lock enough, as in the storage.
 */
export interface TaskLocks {
  run<T>(taskId: string, action: () => Promise<T>): Promise<T>;
}

export function createTaskLocks(): TaskLocks {
  const queues = new Map<string, Promise<unknown>>();
  return {
    run(taskId, action) {
      const previous = queues.get(taskId) ?? Promise.resolve();
      const result = previous.then(action, action);
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      queues.set(taskId, settled);
      // The last one out leaves no queue behind.
      void settled.then(() => {
        if (queues.get(taskId) === settled) queues.delete(taskId);
      });
      return result;
    },
  };
}
