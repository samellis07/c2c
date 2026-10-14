import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'dist/cli/src/c2c.js');

test('cli without arguments prints usage and exits 2', () => {
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: c2c parse/);
  assert.match(result.stderr, /\(when some tables are blocked, seed\.json and the CSVs for unblocked tables are still written; blocked tables get no CSV, junction rows or fixture files\)/);
});
