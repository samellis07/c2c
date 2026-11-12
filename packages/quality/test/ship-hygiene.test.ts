/**
 * Compiled runtime hygiene. The scan is scripts/check-hygiene.mjs.
 * Compiled tests are skipped: they carry fixture values and do not ship.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../../core/src/toolchain.js';

const root = repoRoot();
const script = path.join(root, 'scripts/check-hygiene.mjs');

test('compiled runtime passes the generic hygiene scan', () => {
  const dist = path.join(root, 'dist');
  assert.ok(lstatSync(dist, { throwIfNoEntry: false })?.isDirectory(), 'dist/ is missing: run npm run build first');
  const res = spawnSync(process.execPath, [script, '--scan-dir', dist, '--skip-segment', 'test'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /0 hit\(s\)/);
});
