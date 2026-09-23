import type {
  DocumentService,
  ProjectService,
  ReportService,
  TaskService,
} from '../../core/index.js';
import type { GitReader } from '../../core/ports.js';

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
}
