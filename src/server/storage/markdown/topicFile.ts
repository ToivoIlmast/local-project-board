import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { topicSchema, type Topic } from '../../../core/model/index.js';

/** Fields the board owns; anything else in the frontmatter is the user's and is kept as `extra`. */
const KNOWN = ['id', 'title', 'blocks'];

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export function serializeTopic(topic: Topic): string {
  const { body, extra, ...fields } = topic;
  return `---\n${stringifyYaml({ ...fields, ...extra }, { lineWidth: 0 })}---\n${body}`;
}

/**
 * Returns the topic, or a reason why the file cannot be read as one (never throws). A field the
 * board does not know is kept in `extra`, so a write never drops it.
 */
export function parseTopic(id: string, text: string): { topic: Topic } | { error: string } {
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

  // The directory name is the id: the file may disagree, the layout may not.
  const fields = frontmatter as Record<string, unknown>;
  const extra = Object.fromEntries(Object.entries(fields).filter(([key]) => !KNOWN.includes(key)));
  const candidate = {
    ...Object.fromEntries(Object.entries(fields).filter(([key]) => KNOWN.includes(key))),
    id,
    body: text.slice(match[0].length),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
  const result = topicSchema.safeParse(candidate);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { error: `${issue?.path.join('.') ?? 'topic'}: ${issue?.message ?? 'invalid'}` };
  }
  return { topic: result.data };
}
