import { listTasks } from '../api/client.js';
import { Alpha } from '../features/alpha/index.js';
import { Button } from '../shared/ui/Button.js';
export const used = [listTasks, Alpha, Button] as const;
