import type { BoardError } from '../../../src/core/errors.js';
import type { Storage } from '../../../src/core/ports.js';
import { createReportService, type ReportService } from '../../../src/core/services/reports.js';
import { recordingEventSink, type RecordingEventSink } from '../../support/events.js';
import { createMemoryStore, inMemoryStorage } from '../../support/inMemoryStorage.js';

describe('ReportService', () => {
  let storage: Storage;
  let events: RecordingEventSink;
  let reports: ReportService;

  beforeEach(async () => {
    storage = inMemoryStorage(createMemoryStore());
    await storage.init();
    events = recordingEventSink();
    reports = createReportService({ storage, events });
  });

  async function code(action: Promise<unknown>): Promise<string> {
    return action.then(
      () => 'no error',
      (error: unknown) => (error as BoardError).code,
    );
  }

  it('stores a report and announces it', async () => {
    const report = await reports.create({
      title: 'Audit',
      format: 'html',
      content: '<h1>A</h1>\n',
    });
    expect(report).toMatchObject({ title: 'Audit', format: 'html' });
    expect(await reports.read(report.id)).toBe('<h1>A</h1>\n');
    expect(await reports.list()).toEqual([report]);
    expect(events.last()).toEqual({ type: 'report.created', report });
  });

  it('deletes a report and announces it', async () => {
    const report = await reports.create({ title: 'Audit', format: 'md', content: '# A\n' });
    await reports.remove(report.id);
    expect(await reports.list()).toEqual([]);
    expect(events.last()).toEqual({ type: 'report.deleted', reportId: report.id });
  });

  it('fails for a report that does not exist', async () => {
    expect(await code(reports.read('R404'))).toBe('REPORT_NOT_FOUND');
    expect(await code(reports.remove('R404'))).toBe('REPORT_NOT_FOUND');
    expect(events.events).toEqual([]);
  });
});
