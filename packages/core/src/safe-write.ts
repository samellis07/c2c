import { closeSync, constants, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write owner-only state atomically; rename replaces (rather than follows) a final symlink. */
export function writeSafeState(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    for (let offset = 0; offset < bytes.byteLength;) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // renameSync atomically replaces a destination symlink itself, never its target.
    renameSync(temp, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* no temp, or already renamed */ }
    throw error;
  }
}
