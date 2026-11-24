import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, lstatSync, statSync, symlinkSync, writeFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeSafeState } from '../src/safe-write.js';

test('safe state writes are owner-only and replace a final symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-safe-write-'));
  try {
    const target = join(dir, 'victim');
    const path = join(dir, 'nested', 'state.json');
    writeFileSync(target, 'keep');
    writeSafeState(path, '{"ok":true}\n');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    unlinkSync(path);
    symlinkSync(target, path);
    writeSafeState(path, '{"new":true}\n');
    assert.equal(readFileSync(target, 'utf8'), 'keep');
    assert.equal(lstatSync(path).isFile(), true);
    assert.equal(readFileSync(path, 'utf8'), '{"new":true}\n');
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp-')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
