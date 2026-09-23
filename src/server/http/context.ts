import type {
  DocumentService,
  ProjectService,
  ReportService,
  TaskService,
} from '../../core/index.js';
import type { GitReader } from '../../core/ports.js';
import type { EventStream } from './sse.js';

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
