import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeState } from '../src/delta-cli.js';

test('the delta checkpoint state file is written owner-only (0600) on create and on update', () => {
  const previous = process.umask(0o022);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-delta-state-mode-'));
  const path = join(dir, 'state.json');
  try {
    writeState(path, { delta: { cursor: 'c1' } });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['state.json'], 'no temp file is left behind');

    // An older state file left world-readable is tightened on the next write.
    writeFileSync(path, `${JSON.stringify({ delta: { cursor: 'c1' } })}\n`);
    chmodSync(path, 0o644);
    writeState(path, { delta: { cursor: 'c2' } });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const written = JSON.parse(readFileSync(path, 'utf8')) as { delta?: unknown };
    assert.deepEqual(written.delta, { cursor: 'c2' });
    assert.deepEqual(readdirSync(dir), ['state.json'], 'no temp file is left behind');
  } finally {
    process.umask(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
