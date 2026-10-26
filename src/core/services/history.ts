import { BoardError } from '../errors.js';
import type {
  Check,
  CheckKind,
  CheckReportContent,
  CheckSummary,
  CheckVerdict,
  Decision,
  RepoState,
  ResearchReportContent,
  TaskVersion,
  VersionList,
} from '../model/history.js';
import type { Task } from '../model/task.js';
import type { EventSink, GitReader, Storage } from '../ports.js';
import {
  changedFields,
  contentHash,
  contentOf,
  reportKindProblems,
  reportProblems,
  sameContent,
  summarizeCheck,
} from '../rules/history.js';
import { assertContentHash, latestVersion, syncHistory } from './taskHistory.js';
import { createTaskLocks, type TaskLocks } from './taskLocks.js';

export interface HistoryServiceOptions {
  storage: Storage;
  events: EventSink;
  /** Read-only; the repository as it stands when a check begins and when its report comes. */
  git?: GitReader | undefined;
  /** Shared with the task service: one lock per task, taken once per request (ADR-0030 §3). */
  locks?: TaskLocks | undefined;
}

export interface BeginCheckInput {
  agent: string;
  sessionId: string;
  model?: string | undefined;
  /** Absent for an actuality check (ADR-0030 R1). */
  kind?: CheckKind | undefined;
  /** The focus of a research, as sent (ADR-0030 R2). */
  comment?: string | undefined;
}

/**
 * What an agent sends as a report: an actuality check's has a `verdict`, a research's has its
 * `markdown`. Which one is right is the check's to say (`reportKindProblems`), not the type's.
 */
export type ReportInput = Omit<CheckReportContent, 'verdict'> & {
  verdict?: CheckReportContent['verdict'] | undefined;
  markdown?: ResearchReportContent['markdown'] | undefined;
};

export interface EndCheckInput {
  sessionId: string;
  exitCode?: number | undefined;
  endedAt?: string | undefined;
}

export interface DecisionInput {
  recommendation: string;
  decision: 'accepted' | 'rejected';
  note?: string | undefined;
}

export interface HistoryService {
  versions(taskId: string): Promise<VersionList>;
  version(taskId: string, number: number): Promise<TaskVersion>;
  /** Writes the snapshot of a version as the content, as a new version (ADR-0030 §5). */
  restore(
    taskId: string,
    number: number,
    input: { ifContentHash: string },
  ): Promise<{ task: Task; changed: boolean }>;

  checks(taskId: string): Promise<CheckSummary[]>;
  check(taskId: string, number: number): Promise<Check>;
  /** Runner: pins the check to a version that exists and equals what is on disk. */
  beginCheck(taskId: string, input: BeginCheckInput): Promise<{ number: number; version: number }>;
  /** Agent: the one report of a check that works. */
  report(taskId: string, number: number, content: ReportInput): Promise<Check>;
  /**
   * The markdown of a published research report, as written (ADR-0030 R3); null for a check
   * that has none. Refuses with `CHECK_NOT_REPORTED` until the report is published.
   */
  reportMarkdown(taskId: string, number: number): Promise<string | null>;
  /** Runner: the one end of a check. */
  endCheck(taskId: string, number: number, input: EndCheckInput): Promise<Check>;
  decide(taskId: string, number: number, input: DecisionInput): Promise<Decision>;
}

export function createHistoryService({
  storage,
  events,
  git,
  locks = createTaskLocks(),
}: HistoryServiceOptions): HistoryService {
  async function requireTask(id: string): Promise<Task> {
    const task = await storage.getTask(id);
    if (!task) throw new BoardError('TASK_NOT_FOUND', `Task "${id}" does not exist.`, { id });
    return task;
  }

  async function requireCheck(taskId: string, number: number): Promise<Check> {
    await requireTask(taskId);
    const check = await storage.readCheck(taskId, number);
    if (check === null) {
      throw new BoardError('CHECK_NOT_FOUND', `Task "${taskId}" has no check ${number}.`, {
        id: taskId,
        check: number,
      });
    }
    return check;
  }

  async function repoState(): Promise<RepoState> {
    if (git === undefined) return null;
    try {
      if (!(await git.available())) return null;
      const [branch, status, commits] = await Promise.all([
        git.currentBranch(),
        git.status(),
        git.commits({ limit: 1 }),
      ]);
      return { branch: branch.name, head: commits[0]?.sha ?? null, clean: status.clean };
    } catch {
      // A repository that cannot be read is no reason to refuse a check; it is shown as absent.
      return null;
    }
  }

  const announceVersions = (taskId: string, versions: readonly { number: number }[]): void => {
    for (const version of versions) {
      events.publish({ type: 'version.created', taskId, number: version.number });
    }
  };

  return {
    async versions(taskId) {
      const task = await requireTask(taskId);
      const content = contentOf(task);
      const versions = await storage.listVersions(taskId);
      const latest = latestVersion(versions);
      return {
        current: {
          hash: contentHash(content),
          version:
            latest !== undefined && sameContent(latest.snapshot, content) ? latest.number : null,
        },
        versions: [...versions]
          .sort((a, b) => a.number - b.number)
          .map(({ snapshot, ...rest }) => ({ ...rest, hash: contentHash(snapshot) })),
      };
    },

    async version(taskId, number) {
      await requireTask(taskId);
      const version = await storage.readVersion(taskId, number);
      if (version === null) {
        throw new BoardError('VERSION_NOT_FOUND', `Task "${taskId}" has no version ${number}.`, {
          id: taskId,
          version: number,
        });
      }
      return version;
    },

    restore: (taskId, number, { ifContentHash }) =>
      locks.run(taskId, async () => {
        const task = await requireTask(taskId);
        const before = contentOf(task);
        await assertContentHash(storage, taskId, before, ifContentHash);
        const target = await storage.readVersion(taskId, number);
        if (target === null) {
          throw new BoardError('VERSION_NOT_FOUND', `Task "${taskId}" has no version ${number}.`, {
            id: taskId,
            version: number,
          });
        }
        // Already what was asked for: nothing is written, and the answer says so.
        if (sameContent(target.snapshot, before)) return { task, changed: false };

        const appended = await syncHistory(storage, taskId, before);
        const restored = await storage.updateTask(taskId, {
          title: target.snapshot.title,
          body: target.snapshot.body,
          labels: [...target.snapshot.labels],
        });
        appended.push(
          await storage.appendVersion(taskId, {
            source: 'restore',
            changed: changedFields(before, target.snapshot),
            snapshot: contentOf(target.snapshot),
            restoredFrom: number,
          }),
        );
        announceVersions(taskId, appended);
        events.publish({ type: 'task.updated', task: restored });
        return { task: restored, changed: true };
      }),

    async checks(taskId) {
      await requireTask(taskId);
      return (await storage.listChecks(taskId))
        .map(summarizeCheck)
        .sort((a, b) => a.number - b.number);
    },

    check: requireCheck,

    beginCheck: (taskId, input) =>
      locks.run(taskId, async () => {
        const task = await requireTask(taskId);
        // Pinned to a version that exists and equals what is on disk (ADR-0030 §6).
        const appended = await syncHistory(storage, taskId, contentOf(task));
        const pinned = latestVersion([...(await storage.listVersions(taskId))]) as TaskVersion;
        if (input.comment !== undefined && input.kind === undefined) {
          throw new BoardError(
            'INVALID_REQUEST',
            'A comment belongs to a research: send kind "research" with it.',
            { issues: [{ path: 'comment', message: 'Only with kind "research".' }] },
          );
        }
        // What the research saw of the documents: names, sizes and times, never the text.
        const documents =
          input.kind === 'research'
            ? (await storage.listDocuments(taskId))
                .map(({ name, size, updatedAt }) => ({ name, size, updatedAt }))
                .sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name))
            : undefined;
        const begin = await storage.beginCheck(taskId, {
          version: pinned.number,
          agent: input.agent,
          sessionId: input.sessionId,
          ...(input.model === undefined ? {} : { model: input.model }),
          repo: await repoState(),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.comment === undefined ? {} : { comment: input.comment }),
          ...(documents === undefined ? {} : { documents }),
        });
        announceVersions(taskId, appended);
        events.publish({ type: 'check.updated', taskId, number: begin.number });
        return { number: begin.number, version: begin.version };
      }),

    report: (taskId, number, content) =>
      locks.run(taskId, async () => {
        const check = await requireCheck(taskId, number);
        if (check.state !== 'working') {
          throw new BoardError(
            'CHECK_ALREADY_FINAL',
            `Check ${number} of task "${taskId}" is no longer working; a report is taken once.`,
            { id: taskId, check: number, state: check.state },
          );
        }
        const pinned = await storage.readVersion(taskId, check.begin.version);
        if (pinned === null) {
          throw new BoardError(
            'VERSION_NOT_FOUND',
            `Version ${check.begin.version} that check ${number} was made on cannot be read.`,
            { id: taskId, version: check.begin.version },
          );
        }
        // The kind is the one the check began as; the report cannot choose another (R1).
        const problems = [
          ...reportKindProblems(check.begin.kind, content),
          ...reportProblems(content, pinned.snapshot),
        ];
        if (problems.length > 0) {
          throw new BoardError(
            'INVALID_CHECK_REPORT',
            `The report does not hold against version ${pinned.number}: ${problems.join(' ')}`,
            { id: taskId, check: number, version: pinned.number, problems },
          );
        }
        // `reportKindProblems` has seen to it that the report holds what its kind needs.
        const { verdict, markdown, ...rest } = content;
        await storage.writeCheckReport(taskId, number, {
          ...rest,
          ...(check.begin.kind === 'research'
            ? { markdown: markdown as string }
            : { verdict: verdict as CheckVerdict }),
          version: check.begin.version,
          repo: await repoState(),
        });
        events.publish({ type: 'check.updated', taskId, number });
        return requireCheck(taskId, number);
      }),

    async reportMarkdown(taskId, number) {
      const check = await requireCheck(taskId, number);
      if (check.state !== 'reported') {
        throw new BoardError(
          'CHECK_NOT_REPORTED',
          `Check ${number} of task "${taskId}" has no published report.`,
          { id: taskId, check: number, state: check.state },
        );
      }
      return storage.readCheckMarkdown(taskId, number);
    },

    endCheck: (taskId, number, input) =>
      locks.run(taskId, async () => {
        const check = await requireCheck(taskId, number);
        if (check.begin.sessionId !== input.sessionId) {
          throw new BoardError(
            'STALE_CHECK',
            `Check ${number} of task "${taskId}" belongs to another session.`,
            { id: taskId, check: number },
          );
        }
        if (check.end !== undefined) {
          throw new BoardError(
            'CHECK_ALREADY_FINAL',
            `Check ${number} of task "${taskId}" has ended already.`,
            { id: taskId, check: number },
          );
        }
        await storage.endCheck(taskId, number, {
          sessionId: input.sessionId,
          ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
          ...(input.endedAt === undefined ? {} : { endedAt: input.endedAt }),
        });
        events.publish({ type: 'check.updated', taskId, number });
        return requireCheck(taskId, number);
      }),

    decide: (taskId, number, input) =>
      locks.run(taskId, async () => {
        const check = await requireCheck(taskId, number);
        if (check.state !== 'reported' || check.report === undefined) {
          throw new BoardError(
            'CHECK_NOT_REPORTED',
            `Check ${number} of task "${taskId}" has no report to decide on.`,
            { id: taskId, check: number, state: check.state },
          );
        }
        if (!check.report.recommendations.some(({ id }) => id === input.recommendation)) {
          throw new BoardError(
            'RECOMMENDATION_NOT_FOUND',
            `Check ${number} of task "${taskId}" has no recommendation "${input.recommendation}".`,
            { id: taskId, check: number, recommendation: input.recommendation },
          );
        }
        const decision = await storage.appendDecision(taskId, number, {
          recommendation: input.recommendation,
          decision: input.decision,
          ...(input.note === undefined ? {} : { note: input.note }),
        });
        events.publish({ type: 'check.updated', taskId, number });
        return decision;
      }),
  };
}
