import path from 'node:path';
import express, { type Express } from 'express';

export interface AppOptions {
  /** Directory with the built SPA (dist/web). */
  webRoot: string;
}

export function createApp({ webRoot }: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(webRoot));
  // SPA fallback: client-side routes are served index.html.
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(webRoot, 'index.html'));
  });
  return app;
}
