import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeState } from '../src/delta-cli.js';

test('the delta checkpoint state file is written owner-only (0600) on create and on update', () => {
  const previous = process.umask(0o022);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-delta-state-mode-'));
  const snapshotDir = mkdtempSync(join(tmpdir(), 'c2c-delta-state-mode-snapshot-'));
  const path = join(dir, 'state.json');
  try {
    writeState(path, { delta: { cursor: 'c1' } });
    assert.equal(statSync(path).mode & 0o777, 0o600);
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
    const beforeIno = statSync(path).ino;
    const snapshotPath = join(snapshotDir, 'before-update.json');
    linkSync(path, snapshotPath);

    writeState(path, { delta: { cursor: 'c2' } });

    assert.equal(statSync(path).mode & 0o777, 0o600);
    const written = JSON.parse(readFileSync(path, 'utf8')) as { delta?: unknown };
    assert.deepEqual(written.delta, { cursor: 'c2' });
    assert.deepEqual(readdirSync(dir), ['state.json'], 'no temp file is left behind');

    assert.notEqual(statSync(path).ino, beforeIno, 'the update replaces the directory entry rather than mutating the existing (once world-readable) file in place');
    assert.equal(statSync(snapshotPath).mode & 0o777, 0o644, 'the pre-update inode, reachable only through the snapshot link, must never have been chmod-ed to 0600: that would mean the update wrote through the existing file instead of swapping in a fresh owner-only one');
    const beforeContent = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { delta?: unknown };
    assert.deepEqual(beforeContent.delta, { cursor: 'c1' }, 'the pre-update inode must keep its original content: the update must not have written through it');
  } finally {
    process.umask(previous);
    rmSync(dir, { recursive: true, force: true });
    rmSync(snapshotDir, { recursive: true, force: true });
  }
});
