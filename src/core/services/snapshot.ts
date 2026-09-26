import type { BoardSnapshot } from '../model/snapshot.js';
import type { Storage } from '../ports.js';

export interface SnapshotProject {
  name: string;
  statuses: string[];
  idPrefix: string;
}

/**
 * A portable copy of the board for backup or transfer (ADR-0009). It is read-only and it is
 * not a persistence model: no provider stores a snapshot, and nothing reads one back yet.
 */
export async function createSnapshot(
  storage: Storage,
  project: SnapshotProject,
): Promise<BoardSnapshot> {
  const tasks = await storage.listTasks();

  const documents: BoardSnapshot['documents'] = [];
  for (const task of tasks) {
    for (const meta of await storage.listDocuments(task.id)) {
      const content = await storage.readDocument(task.id, meta.name);
      if (content !== null) documents.push({ taskId: task.id, name: meta.name, content });
    }
  }

  const reports: BoardSnapshot['reports'] = [];
  for (const report of await storage.listReports()) {
    const content = await storage.readReport(report.id);
    if (content !== null) reports.push({ ...report, content });
  }

  return {
    formatVersion: 2,
    exportedAt: new Date().toISOString(),
    project: { name: project.name, statuses: [...project.statuses], idPrefix: project.idPrefix },
    workflow: await storage.readWorkflow(),
    tasks,
    documents,
    reports,
  };
}
