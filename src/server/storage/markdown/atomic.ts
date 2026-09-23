import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Write through a temporary file in the same directory and rename over the target.
 * A reader sees either the old file or the new one, never a half-written one.
 */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const temp = join(dirname(file), `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, content, 'utf8');
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
