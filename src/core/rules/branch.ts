/** The longest slug a branch name gets; a title is a sentence, a branch name is a label. */
const MAX_SLUG_LENGTH = 40;

/**
 * The name of the branch an agent works in for a task: `task/<ID>-<slug>` (ADR-0028). One
 * function, so that the handoff and anyone else agree on it.
 *
 * The slug is the Latin words of the title, lower-cased and joined by dashes. Accents are
 * dropped (`ä` is `a`), but no other script is transliterated: a Cyrillic title keeps only its
 * Latin words, and a title without any gives just `task/<ID>`. That keeps the name a valid ref
 * without a table that one owner's language would grow and another's would miss.
 */
export function taskBranchName(id: string, title: string): string {
  const words =
    title
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];

  let slug = '';
  for (const word of words) {
    const next = slug === '' ? word : `${slug}-${word}`;
    if (next.length > MAX_SLUG_LENGTH) {
      // Whole words only; a first word that alone is too long is cut, so the slug is never empty.
      if (slug === '') slug = word.slice(0, MAX_SLUG_LENGTH);
      break;
    }
    slug = next;
  }
  return slug === '' ? `task/${id}` : `task/${id}-${slug}`;
}
