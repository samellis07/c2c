import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATE_FILE, writeState } from '../src/cli.js';

const STATE = { version: 1 as const, projectId: '1001', digest: 'd', done: ['functions'] };

test('the deploy state file is written owner-only (0600) on create and on update, keeping the delta checkpoint', () => {
  const previous = process.umask(0o022);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-state-mode-'));
  try {
    writeState(dir, STATE);
    const path = join(dir, STATE_FILE);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    // An older state file left world-readable is tightened on the next write.
    writeFileSync(path, `${JSON.stringify({ ...STATE, delta: { cursor: 'c1' } })}\n`);
    chmodSync(path, 0o644);
    writeState(dir, { ...STATE, done: ['functions', 'slate'] });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const written = JSON.parse(readFileSync(path, 'utf8')) as { done: string[]; delta?: unknown };
    assert.deepEqual(written.done, ['functions', 'slate']);
    assert.deepEqual(written.delta, { cursor: 'c1' });
    assert.deepEqual(readdirSync(dir), [STATE_FILE], 'no temp file is left behind');
  } finally {
    process.umask(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
