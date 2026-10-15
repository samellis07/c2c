import { closeSync, constants, fstatSync, openSync, type Dirent } from 'node:fs';
import { constants as osConstants } from 'node:os';

/** What a path is, as read from one descriptor or one directory entry. */
export type PathKind = 'file' | 'directory' | 'other';

/**
 * Open flags for reading a path that must not be a symlink: O_NOFOLLOW makes
 * the open fail with ELOOP on a link, and O_NONBLOCK keeps a FIFO from
 * blocking it.
 */
export const NO_FOLLOW_READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

/** The string `code` of a Node fs error, if any. */
export function errnoCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

// Node reports errno negated. A socket exists but cannot be opened: Linux
// gives ENXIO, macOS gives EOPNOTSUPP (102), which libuv names
// 'Unknown system error -102', so the number is matched, not the code.
const UNOPENABLE_ERRNOS = new Set<number>([
  -osConstants.errno.ENXIO,
  -osConstants.errno.EOPNOTSUPP,
  ...(process.platform === 'darwin' ? [-102] : []),
]);

/** ENOENT, or ENOTDIR (a path under a file): nothing is there. */
export function isAbsentError(err: unknown): boolean {
  const code = errnoCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** An open error for a path that exists but is not openable, such as a socket. */
export function isUnopenableError(err: unknown): boolean {
  const errno = (err as { errno?: unknown } | null)?.errno;
  if (typeof errno === 'number' && UNOPENABLE_ERRNOS.has(errno)) return true;
  const code = errnoCode(err);
  return code === 'ENXIO' || code === 'EOPNOTSUPP';
}

/** The open error O_NOFOLLOW gives for a symlink (ELOOP). */
export function isSymlinkRefusedError(err: unknown): boolean {
  const errno = (err as { errno?: unknown } | null)?.errno;
  return errnoCode(err) === 'ELOOP' || errno === -osConstants.errno.ELOOP;
}

/**
 * The kind of `path`, from one {@link NO_FOLLOW_READ_FLAGS} open and an fstat
 * of that descriptor. Symlinks are not followed: a link is `other`. Absent
 * (ENOENT/ENOTDIR) is `undefined`; an unopenable path such as a socket is
 * `other`; EISDIR is `directory`. Any other error is thrown.
 */
export function openKind(path: string): PathKind | undefined {
  let fd: number;
  try {
    fd = openSync(path, NO_FOLLOW_READ_FLAGS);
  } catch (err) {
    if (isAbsentError(err)) return undefined;
    if (isUnopenableError(err) || isSymlinkRefusedError(err)) return 'other';
    if (errnoCode(err) === 'EISDIR') return 'directory';
    throw err;
  }
  try {
    const st = fstatSync(fd);
    return st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other';
  } finally {
    closeSync(fd);
  }
}

/**
 * A directory entry's kind, from the Dirent alone (readdir does not follow
 * links). Walks do not follow symlinks: a link, like a socket or FIFO, is
 * `other` and is never resolved. A file is read through its own no-follow
 * open, which also refuses an entry swapped for a link after the readdir.
 */
export function entryKind(entry: Dirent): PathKind {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
}
