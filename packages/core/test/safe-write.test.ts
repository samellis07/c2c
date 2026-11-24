import assert from 'node:assert/strict';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, symlinkSync, writeFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeSafeState } from '../src/safe-write.js';

// Kind, mode and content come from one descriptor opened with O_NOFOLLOW, so the
// final path component is never a symlink and no path is checked then re-used.
function inspect(path: string): { isFile: boolean; mode: number; text: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    return { isFile: stat.isFile(), mode: stat.mode & 0o777, text: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

test('safe state writes are owner-only and replace a final symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-safe-write-'));
  try {
    const target = join(dir, 'victim');
    const path = join(dir, 'nested', 'state.json');
    writeFileSync(target, 'keep');
    writeSafeState(path, '{"ok":true}\n');
    assert.equal(inspect(path).mode, 0o600);
    unlinkSync(path);
    symlinkSync(target, path);
    writeSafeState(path, '{"new":true}\n');
    assert.equal(readFileSync(target, 'utf8'), 'keep');
    const replaced = inspect(path);
    assert.equal(replaced.isFile, true);
    assert.equal(replaced.text, '{"new":true}\n');
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp-')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
