/**
 * The rule about text that is not ASCII, written out in full on purpose, like the rule about the
 * token: the tests hold the text against the constant of the contract rather than derive it.
 */
export const TEXT_RULE =
  'Never pass the content of a document, or any other text that is not plain ASCII, through ' +
  'command-line arguments (`node -e ... process.argv`, `curl -d "..."`): on Windows they go ' +
  'through the ANSI codepage and Cyrillic and other letters turn into `?`. Write the content to a ' +
  'UTF-8 file and send it from the file, like `curl --data-binary @file.json` with the header ' +
  '`Content-Type: application/json; charset=utf-8`, or with Node reading the file with `fs`.';

/** The parts of the rule a weakened version would lose. */
export const TEXT_RULE_PARTS: readonly string[] = [
  'through command-line arguments',
  'process.argv',
  'ANSI codepage',
  'UTF-8 file',
  'curl --data-binary @file.json',
  'charset=utf-8',
  'reading the file with `fs`',
];
