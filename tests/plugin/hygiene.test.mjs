/**
 * Hygiene check. A bad sample is rejected. The tracked tree is checked by
 * `npm run check:hygiene`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/check-hygiene.mjs');

test('hygiene canary rejects a home path, a non-placeholder address, and an id', () => {
  const res = spawnSync(process.execPath, [script, '--canary'], { cwd: root, encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /rejected bad samples/);
});
