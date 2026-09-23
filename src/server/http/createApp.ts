import path from 'node:path';
import express, { type Express } from 'express';
import { API_BASE_PATH } from '../../contract/v1/index.js';
import type { BoardContext } from './context.js';
import { errorHandler, HttpError } from './errors.js';
import {
  API_CSP,
  APP_CSP,
  createHostOriginGuard,
  createTokenGuard,
  securityHeaders,
} from './security.js';
import { createV1Router } from './v1/router.js';

export interface AppOptions {
  context: BoardContext;
  /** This session's token; every mutation must carry it (ADR-0008). */
  token: string;
  /** The port the server is bound to, so the Host header can be checked against it. */
  port?: number | undefined;
  /** Directory with the built SPA (dist/web). Without it the board serves the API only. */
  webRoot?: string | undefined;
  /** Where a failure the client is not told about goes; never the response. */
  onInternalError?: ((error: unknown) => void) | undefined;
}

/**
 * The only place that knows Express. The order is the security order: who is asking,
 * then may they change anything, then what did they ask for (§15).
 */
export function createApp(options: AppOptions): Express {
  const { context, token, webRoot } = options;
  const onInternalError = options.onInternalError ?? ((error: unknown) => console.error(error));

  const app = express();
  app.disable('x-powered-by');
  app.use(createHostOriginGuard({ port: options.port }));

  app.use('/api', securityHeaders(API_CSP), noStore);
  app.use(API_BASE_PATH, createTokenGuard(token), createV1Router(context));
  // There is one API, and it is /api/v1: no other version answers anything (ADR-0012).
  app.use('/api', notFound);

  if (webRoot !== undefined) {
    app.use(securityHeaders(APP_CSP), express.static(webRoot));
    // Client-side routes are served index.html.
    app.get('/{*path}', (_request, response) => {
      response.sendFile(path.join(webRoot, 'index.html'));
    });
  }

  app.use(notFound);
  app.use(errorHandler(onInternalError));
  return app;
}

const noStore: express.RequestHandler = (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  next();
};

const notFound: express.RequestHandler = () => {
  throw new HttpError(404, 'NOT_FOUND', 'This endpoint does not exist.');
};
