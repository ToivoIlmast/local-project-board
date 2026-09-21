import { Alpha } from '../alpha/index.js';
import { Gamma } from '../gamma.js';
import { Button } from '../../shared/ui/Button.js';
import type { TaskResponse } from '../../../contract/routes.js';
export const used = [Alpha, Gamma, Button] as const;
export type Used = TaskResponse;
