import { BoardError } from '../errors.js';
import type { Report } from '../model/report.js';
import type { EventSink, NewReport, Storage } from '../ports.js';

export interface ReportServiceOptions {
  storage: Storage;
  events: EventSink;
}

export interface ReportService {
  list(): Promise<Report[]>;
  read(id: string): Promise<string>;
  create(input: NewReport): Promise<Report>;
  remove(id: string): Promise<void>;
}

export function createReportService({ storage, events }: ReportServiceOptions): ReportService {
  return {
    list: () => storage.listReports(),

    async read(id) {
      const content = await storage.readReport(id);
      if (content === null) {
        throw new BoardError('REPORT_NOT_FOUND', `Report "${id}" does not exist.`, { id });
      }
      return content;
    },

    async create(input) {
      const report = await storage.writeReport(input);
      events.publish({ type: 'report.created', report });
      return report;
    },

    async remove(id) {
      await storage.deleteReport(id);
      events.publish({ type: 'report.deleted', reportId: id });
    },
  };
}
