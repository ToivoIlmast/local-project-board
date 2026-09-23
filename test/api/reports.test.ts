import { z } from 'zod';
import {
  API_BASE_PATH as API,
  errorResponseSchema,
  reportSchema,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs } from '../support/tmp.js';

let board: TestBoard;

beforeEach(async () => {
  board = await createTestBoard();
});

afterEach(async () => {
  await board.close();
  await cleanTmpDirs();
});

const html = '<h1>Dependency audit</h1>\n<p>3 outdated packages.</p>\n';

async function createReport(body: Record<string, unknown>): Promise<string> {
  const response = await board.post(`${API}/reports`, body).expect(201);
  return reportSchema.parse(response.body).id;
}

describe('reports over HTTP', () => {
  it('stores a report, lists it and reads it back verbatim', async () => {
    const id = await createReport({ title: 'Dependency audit', format: 'html', content: html });

    const listed = await board.get(`${API}/reports`).expect(200);
    expect(z.array(reportSchema).parse(listed.body)).toEqual([
      expect.objectContaining({ id, title: 'Dependency audit', format: 'html' }),
    ]);

    const read = await board.get(`${API}/reports/${id}`).expect(200);
    expect(read.headers['content-type']).toMatch(/^text\/html/);
    expect(read.text).toBe(html);
    expect(board.events.types()).toEqual(['report.created']);
  });

  it('serves a markdown report as markdown, not as HTML', async () => {
    const id = await createReport({ title: 'Plan', format: 'md', content: '# Plan\n' });
    const read = await board.get(`${API}/reports/${id}`).expect(200);
    expect(read.headers['content-type']).toMatch(/^text\/markdown/);
    expect(read.text).toBe('# Plan\n');
  });

  it('deletes a report', async () => {
    const id = await createReport({ title: 'Audit', format: 'html', content: html });
    expect((await board.del(`${API}/reports/${id}`).expect(200)).body).toEqual({ deleted: true });
    await board.get(`${API}/reports/${id}`).expect(404);
    expect((await board.get(`${API}/reports`).expect(200)).body).toEqual([]);
    expect(board.events.types()).toEqual(['report.created', 'report.deleted']);
  });

  it('answers 404 for a report that does not exist and 400 for a bad id', async () => {
    const missing = await board.get(`${API}/reports/R9`).expect(404);
    expect(errorResponseSchema.parse(missing.body).error.code).toBe('REPORT_NOT_FOUND');
    await board.del(`${API}/reports/R9`).expect(404);

    const bad = await board.get(`${API}/reports/not-an-id`).expect(400);
    expect(errorResponseSchema.parse(bad.body).error.code).toBe('INVALID_REQUEST');
  });

  it('refuses a report the contract does not describe', async () => {
    await board.post(`${API}/reports`, { title: 'x', format: 'pdf', content: 'x' }).expect(400);
    await board.post(`${API}/reports`, { title: 'x', format: 'html' }).expect(400);
    await board.post(`${API}/reports`, { title: ' ', format: 'html', content: 'x' }).expect(400);
    expect((await board.get(`${API}/reports`).expect(200)).body).toEqual([]);
  });
});
