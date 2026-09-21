import { readFileSync } from 'node:fs';
import type { Task } from '../../core/model.js';
export const read = (path: string): Task => JSON.parse(readFileSync(path, 'utf8')) as Task;
