import { resolve } from 'node:path';
import { routes } from '../../contract/routes.js';
import type { Task } from '../../core/model.js';
import { app } from '../http/app.js';
import { read } from '../storage/ok-core.js';

/** The composition root may know every adapter; that is what makes it the composition root. */
export const compose = (path: string): { task: Task; routes: typeof routes; app: typeof app } => ({
  task: read(resolve(path)),
  routes,
  app,
});
