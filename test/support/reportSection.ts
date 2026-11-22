/**
 * The instruction about the mandatory section of `report.md` (T15), written out in full on
 * purpose: the tests hold the text of the `report` step against it rather than derive it.
 */
export const REPORT_SECTION_HEADING = '## Deviations and impact on related tasks';

export const REPORT_SECTION =
  `The report must contain the section \`${REPORT_SECTION_HEADING}\`: keep this heading exactly ` +
  'as written, in English, whatever the report is written in; write the content of the ' +
  'section in the language of the report. The section describes: (1) deviations from the ' +
  'original description of the task or its acceptance criteria — what exactly and why; (2) the ' +
  'technical decisions made and their reasons; (3) the remaining limitations and unfinished ' +
  'points; (4) the affected tasks (by ID) and components (modules, files, APIs, contracts); ' +
  '(5) what the next agents must take into account. Be concrete: name files, functions, routes, ' +
  'task IDs and changed contracts, not general phrases like "everything works" or "the impact ' +
  'is minimal". If there are no significant deviations and no impact, say so in the section ' +
  'directly (for example: "No deviations from the description; no impact on other tasks or ' +
  'components.") instead of leaving the section out.';

/** The parts of the instruction a weakened version would lose. */
export const REPORT_SECTION_PARTS: readonly string[] = [
  REPORT_SECTION_HEADING,
  'exactly as written, in English',
  'in the language of the report',
  '(1) deviations from the original description of the task or its acceptance criteria',
  '(2) the technical decisions made and their reasons',
  '(3) the remaining limitations and unfinished points',
  '(4) the affected tasks (by ID) and components (modules, files, APIs, contracts)',
  '(5) what the next agents must take into account',
  'Be concrete: name files, functions, routes, task IDs and changed contracts',
  'instead of leaving the section out',
];
