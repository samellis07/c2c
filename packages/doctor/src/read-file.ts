/**
 * One read of a path that should be a regular file, classified by the open
 * itself: no stat or exists check runs before it, so a swap between a check
 * and the read cannot change the outcome. The descriptor is opened with
 * O_NONBLOCK and checked with fstat, so a FIFO is reported, never read.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';

export type FileRead = { kind: 'file'; bytes: Buffer } | { kind: 'missing' } | { kind: 'not-file' };

const { errno } = osConstants;

/** errno of a failed fs call, by number: libuv has no name for every code (EOPNOTSUPP on macOS). */
export function errnoOf(err: unknown): number | undefined {
  const value = (err as { errno?: unknown } | null)?.errno;
  return typeof value === 'number' ? Math.abs(value) : undefined;
}

/**
 * Read `path` when it opens as a regular file. ENOENT/ENOTDIR are `missing`;
 * a directory, a socket (ENXIO, EOPNOTSUPP) or any other non-file is
 * `not-file`. With O_NOFOLLOW in `extraFlags`, a symlink (ELOOP) is `not-file`
 * too. Any other error is thrown.
 */
export function readRegularFile(path: string, extraFlags = 0): FileRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | extraFlags);
  } catch (err) {
    const code = errnoOf(err);
    if (code === errno.ENOENT || code === errno.ENOTDIR) return { kind: 'missing' };
    if (code === errno.EISDIR || code === errno.ENXIO || code === errno.EOPNOTSUPP) return { kind: 'not-file' };
    if (code === errno.ELOOP && (extraFlags & constants.O_NOFOLLOW) !== 0) return { kind: 'not-file' };
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) return { kind: 'not-file' };
    return { kind: 'file', bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}
