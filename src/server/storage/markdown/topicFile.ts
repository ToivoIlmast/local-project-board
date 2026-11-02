import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { topicSchema, type Topic } from '../../../core/model/index.js';

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export function serializeTopic(topic: Topic): string {
  const { body, ...fields } = topic;
  return `---\n${stringifyYaml(fields, { lineWidth: 0 })}---\n${body}`;
}

/**
 * Returns the topic, or a reason why the file cannot be read as one (never throws). A field the
 * board does not know makes the file unreadable for now, so a write never drops it.
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
  const candidate = { ...frontmatter, id, body: text.slice(match[0].length) };
  const result = topicSchema.safeParse(candidate);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { error: `${issue?.path.join('.') ?? 'topic'}: ${issue?.message ?? 'invalid'}` };
  }
  return { topic: result.data };
}
