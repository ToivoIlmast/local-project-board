import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { taskSchema, type Task } from '../../../core/model/index.js';

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

/** Fields the board owns; anything else in the frontmatter is the user's and is kept as `extra`. */
const KNOWN = [
  'id',
  'title',
  'status',
  'rank',
  'labels',
  'branch',
  'workflow',
  'createdAt',
  'updatedAt',
];

export function serializeTask(task: Task): string {
  const { body, extra, ...fields } = task;
  const frontmatter = stringifyYaml({ ...fields, ...extra }, { lineWidth: 0 });
  return `---\n${frontmatter}---\n${body}`;
}

/** Returns the task, or a reason why the file cannot be read as one (never throws). */
export function parseTask(id: string, text: string): { task: Task } | { error: string } {
  const match = FRONTMATTER.exec(text);
  if (!match?.[1]) return { error: 'No frontmatter: the file must start with a --- block.' };

  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]);
  } catch (error) {
    return { error: `Invalid YAML frontmatter: ${(error as Error).message}` };
  }
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return { error: 'The frontmatter must be a mapping.' };
  }

  const fields = frontmatter as Record<string, unknown>;
  const extra = Object.fromEntries(Object.entries(fields).filter(([key]) => !KNOWN.includes(key)));
  const candidate = {
    ...Object.fromEntries(Object.entries(fields).filter(([key]) => KNOWN.includes(key))),
    // The directory name is the id: the file may disagree, the layout may not.
    id,
    body: text.slice(match[0].length),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };

  const result = taskSchema.safeParse(candidate);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { error: `${issue?.path.join('.') ?? 'task'}: ${issue?.message ?? 'invalid'}` };
  }
  return { task: result.data };
}
