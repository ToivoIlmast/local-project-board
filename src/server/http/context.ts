import type {
  DocumentService,
  ProjectService,
  ReportService,
  TaskService,
} from '../../core/index.js';
import type { GitReader } from '../../core/ports.js';
import type { EventStream } from './sse.js';

/** What this run of the server knows about itself; two routes hand it out, nothing else. */
export interface SessionInfo {
  /** Where the board answers, e.g. http://127.0.0.1:7432 — the instructions quote it. */
  baseUrl: string;
  /** This run's token. It is answered, never logged, never put in a page and never in a URL. */
  token: string;
}

/**
 * Everything the HTTP layer is allowed to reach. It is handed in, so a route can do nothing
 * the application services do not already offer, and Express stays a detail (§20).
 */
export interface BoardContext {
  tasks: TaskService;
  documents: DocumentService;
  reports: ReportService;
  project: ProjectService;
  git: GitReader;
  /** What the open clients are told about; the services publish, this only hands out. */
  events: EventStream;
}

/**
 * The context a route runs with: the board, plus the two facts about the running server that
 * the session and instructions routes exist to hand out. The composition root puts it
 * together, so a service never learns that there is a token at all.
 */
export interface RouteContext extends BoardContext {
  session: SessionInfo;
}
