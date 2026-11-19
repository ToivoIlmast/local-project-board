import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Why a rename fails for a moment on Windows (T105, measured on Windows 10 19045): `rename` is
 * `MoveFileExW`, which will not replace a target that any handle is open on — even a reader that
 * shares delete, as every Node reader does — and answers EPERM. The board reads its files outside
 * the write queue (ADR-0019), so the reader can be its own. A temp file that someone opened
 * without delete sharing (an antivirus scan, the indexer) makes it EBUSY. Both pass when the
 * handle is closed. Anywhere else these codes mean something that lasts, so only Windows waits.
 */
const PASSING_ON_WINDOWS = new Set(['EPERM', 'EBUSY']);

/** The waits between attempts: about one second in all, then the error stands. */
const RETRY_DELAYS_MS = [5, 10, 20, 40, 80, 100, 100, 100, 100, 100, 100, 100, 100, 100];

export interface AtomicWriteOptions {
  /** Which platform's rename to expect; for tests. */
  platform?: NodeJS.Platform;
}

/**
 * Write through a temporary file in the same directory and rename over the target.
 * A reader sees either the old file or the new one, never a half-written one.
 */
export async function writeFileAtomic(
  file: string,
  content: string,
  { platform = process.platform }: AtomicWriteOptions = {},
): Promise<void> {
  const temp = join(dirname(file), `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, content, 'utf8');
    await replace(temp, file, platform === 'win32' ? RETRY_DELAYS_MS : []);
  } catch (error) {
    // The temp file may be held too; the error of the write is the one to tell.
    await rm(temp, { force: true, maxRetries: 3 }).catch(() => undefined);
    throw error;
  }
}

async function replace(temp: string, file: string, delays: readonly number[]): Promise<void> {
  for (const delay of delays) {
    try {
      return await rename(temp, file);
    } catch (error) {
      if (!PASSING_ON_WINDOWS.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    await sleep(delay);
  }
  await rename(temp, file);
}
