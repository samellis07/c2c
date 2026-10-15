/**
 * D-E3 / `c2c --verify-vendor <dir>`: recompute sha256 of every vendored file
 * against MANIFEST.sha256. bin/c2c runs this once per version per workspace
 * before it execs the vendored CLI; a mismatch is a hard stop (exit 6).
 *
 * MANIFEST.sha256 is canonical: one `<64-hex>  <relative-path>` line per
 * vendored file (two spaces, sha256sum format), newline-terminated, no
 * duplicates, no path that escapes the root, and the manifest never lists
 * itself. Files listed but missing or changed, files present but not listed
 * (except the manifest itself), symlinks of any kind, and non-file entries
 * all refuse.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST_NAME = 'MANIFEST.sha256';

export interface VendorVerdict {
  ok: boolean;
  checked: number;
  /** Missing, changed or unlisted paths. */
  mismatched: string[];
  error?: string;
}

/**
 * Every regular file under `dir`, relative with `/`. A symlink (file or
 * directory), a non-file entry, or an unreadable directory is a refusal, not
 * a difference — the tree is only ever a flat set of real files.
 */
function walk(dir: string, base: string, out: string[]): string | undefined {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return `vendor directory is not readable: ${base || dir}`;
  }
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) return `vendor tree contains a symlink: ${rel}`;
    if (entry.isDirectory()) {
      const err = walk(join(dir, entry.name), rel, out);
      if (err) return err;
    } else if (entry.isFile()) {
      out.push(rel);
    } else {
      return `vendor tree contains a non-file entry: ${rel}`;
    }
  }
  return undefined;
}

/**
 * A regular file's bytes, read through one descriptor opened with O_NOFOLLOW
 * and O_NONBLOCK: a symlink, FIFO or directory swapped in after the walk
 * throws instead of being followed or blocking the read.
 */
function readNoFollow(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function verifyVendorDir(dir: string): VendorVerdict {
  const manifestPath = join(dir, MANIFEST_NAME);
  let text: string;
  try {
    text = readNoFollow(manifestPath).toString('utf8');
  } catch {
    return { ok: false, checked: 0, mismatched: [], error: `no readable ${MANIFEST_NAME}` };
  }
  // Canonical form: newline-terminated, one "<sha256>  <path>" line per file.
  if (!text.endsWith('\n')) {
    return { ok: false, checked: 0, mismatched: [], error: `${MANIFEST_NAME} is not canonical (want one "<sha256>  <path>" line per file, newline-terminated)` };
  }
  const listed = new Map<string, string>();
  for (const line of text.slice(0, -1).split('\n')) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) return { ok: false, checked: 0, mismatched: [], error: `${MANIFEST_NAME} has a malformed line` };
    const [, sha, rel] = match;
    if (rel !== rel.trim() || rel.startsWith('/') || rel.includes('\\') || rel.split('/').includes('..') || rel === MANIFEST_NAME) {
      return { ok: false, checked: 0, mismatched: [], error: `${MANIFEST_NAME} lists a bad path` };
    }
    if (listed.has(rel)) return { ok: false, checked: 0, mismatched: [], error: `${MANIFEST_NAME} lists ${rel} twice` };
    listed.set(rel, sha!);
  }

  const present: string[] = [];
  const treeError = walk(dir, '', present);
  if (treeError) return { ok: false, checked: 0, mismatched: [], error: treeError };
  present.sort();
  const found = new Set(present);

  const mismatched: string[] = [];
  let checked = 0;
  for (const [rel, sha] of listed) {
    if (!found.has(rel)) {
      mismatched.push(rel);
      continue;
    }
    checked += 1;
    let actual: string;
    try {
      actual = createHash('sha256').update(readNoFollow(join(dir, rel))).digest('hex');
    } catch {
      mismatched.push(rel);
      continue;
    }
    if (actual !== sha) mismatched.push(rel);
  }
  for (const rel of present) {
    if (rel !== MANIFEST_NAME && !listed.has(rel)) mismatched.push(rel);
  }
  return { ok: mismatched.length === 0, checked, mismatched };
}
