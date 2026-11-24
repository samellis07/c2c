import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATE_FILE, writeState } from '../src/cli.js';

// Mode and content come from one open descriptor so no path is checked and then re-used.
function inspect(path: string): { mode: number; text: string } {
  const fd = openSync(path, 'r');
  try {
    return { mode: fstatSync(fd).mode & 0o777, text: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

const STATE = { version: 1 as const, projectId: '1001', digest: 'd', done: ['functions'] };

test('the deploy state file is written owner-only (0600) on create and on update, keeping the delta checkpoint', () => {
  const previous = process.umask(0o022);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-state-mode-'));
  try {
    writeState(dir, STATE);
    const path = join(dir, STATE_FILE);
    assert.equal(inspect(path).mode, 0o600);
    // An older state file left world-readable is tightened on the next write.
    writeFileSync(path, `${JSON.stringify({ ...STATE, delta: { cursor: 'c1' } })}\n`);
    chmodSync(path, 0o644);
    writeState(dir, { ...STATE, done: ['functions', 'slate'] });
    const after = inspect(path);
    assert.equal(after.mode, 0o600);
    const written = JSON.parse(after.text) as { done: string[]; delta?: unknown };
    assert.deepEqual(written.done, ['functions', 'slate']);
    assert.deepEqual(written.delta, { cursor: 'c1' });
    assert.deepEqual(readdirSync(dir), [STATE_FILE], 'no temp file is left behind');
  } finally {
    process.umask(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
