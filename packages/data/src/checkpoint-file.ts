import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Write a load checkpoint to `path` as one JSON line. The parent directory is
 * created first (a fresh workspace has no `state/` yet), and the file is
 * replaced atomically: the JSON goes to a temp file in the same directory and
 * is renamed over the target, so a crash mid-write never leaves a torn
 * checkpoint behind.
 */
export function writeCheckpointFile(path: string, checkpoint: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(checkpoint)}\n`);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
