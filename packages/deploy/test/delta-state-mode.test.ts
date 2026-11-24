import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, fstatSync, linkSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeState } from '../src/delta-cli.js';

// Mode, inode and content come from one open descriptor so no path is checked and then re-used.
function inspect(path: string): { mode: number; ino: number; text: string } {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    return { mode: stat.mode & 0o777, ino: stat.ino, text: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

test('the delta checkpoint state file is written owner-only (0600) on create and on update', () => {
  const previous = process.umask(0o022);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-delta-state-mode-'));
  const snapshotDir = mkdtempSync(join(tmpdir(), 'c2c-delta-state-mode-snapshot-'));
  const path = join(dir, 'state.json');
  try {
    writeState(path, { delta: { cursor: 'c1' } });
    assert.equal(inspect(path).mode, 0o600);
    assert.deepEqual(readdirSync(dir), ['state.json'], 'no temp file is left behind');

    // An older state file left world-readable is tightened on the next write.
    writeFileSync(path, `${JSON.stringify({ delta: { cursor: 'c1' } })}\n`);
    chmodSync(path, 0o644);

    // A hard link to the pre-update inode: if the update ever mutates the
    // file in place (write, then chmod - the reverted, vulnerable shape),
    // this link observes the same content and mode change. If the update
    // replaces the directory entry with a fresh, already-owner-only inode
    // (atomic create-temp-then-rename - the fix), this link is untouched:
    // the old, loose-mode inode just sits there with its original bytes.
    const beforeIno = inspect(path).ino;
    const snapshotPath = join(snapshotDir, 'before-update.json');
    linkSync(path, snapshotPath);

    writeState(path, { delta: { cursor: 'c2' } });

    const after = inspect(path);
    assert.equal(after.mode, 0o600);
    const written = JSON.parse(after.text) as { delta?: unknown };
    assert.deepEqual(written.delta, { cursor: 'c2' });
    assert.deepEqual(readdirSync(dir), ['state.json'], 'no temp file is left behind');

    assert.notEqual(after.ino, beforeIno, 'the update replaces the directory entry rather than mutating the existing (once world-readable) file in place');
    const before = inspect(snapshotPath);
    assert.equal(before.mode, 0o644, 'the pre-update inode, reachable only through the snapshot link, must never have been chmod-ed to 0600: that would mean the update wrote through the existing file instead of swapping in a fresh owner-only one');
    const beforeContent = JSON.parse(before.text) as { delta?: unknown };
    assert.deepEqual(beforeContent.delta, { cursor: 'c1' }, 'the pre-update inode must keep its original content: the update must not have written through it');
  } finally {
    process.umask(previous);
    rmSync(dir, { recursive: true, force: true });
    rmSync(snapshotDir, { recursive: true, force: true });
  }
});
