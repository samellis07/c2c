/**
 * Optional-file reads in tests/golden/parity.mjs (also used by baseline.mjs):
 * a missing file reads as absent, a directory still throws EISDIR.
 * Imports compiled dist/ through parity.mjs, so `npm run build` must have run.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BASELINE_FILE, loadBaselineIds, loadVectorBundle, readTextIfPresent } from './parity.mjs';

function tempDir(t, label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const vectors = (...ids) => JSON.stringify({ cases: Object.fromEntries(ids.map((id) => [id, {}])) });

test('readTextIfPresent: missing or under a file is null, a directory throws, a symlink is followed', (t) => {
  const dir = tempDir(t, 'golden-read');
  write(path.join(dir, 'file.txt'), 'text\n');
  assert.equal(readTextIfPresent(path.join(dir, 'absent.txt')), null);
  assert.equal(readTextIfPresent(path.join(dir, 'file.txt', 'child')), null);
  assert.equal(readTextIfPresent(path.join(dir, 'file.txt')), 'text\n');
  symlinkSync('file.txt', path.join(dir, 'link.txt'));
  assert.equal(readTextIfPresent(path.join(dir, 'link.txt')), 'text\n');
  symlinkSync('absent.txt', path.join(dir, 'dangling.txt'));
  assert.equal(readTextIfPresent(path.join(dir, 'dangling.txt')), null);
  mkdirSync(path.join(dir, 'dir.txt'));
  assert.throws(() => readTextIfPresent(path.join(dir, 'dir.txt')), { code: 'EISDIR' });
});

test('loadVectorBundle overlays only fixture files that exist and throws on a directory', (t) => {
  const rootDir = tempDir(t, 'golden-root');
  const fixtures = tempDir(t, 'golden-fixtures');
  write(path.join(rootDir, 'tests/golden/vectors.json'), vectors('a', 'b'));
  const env = { C2C_FIXTURES_DIR: fixtures };

  let bundle = loadVectorBundle(rootDir, env);
  assert.equal(bundle.base.kind, 'committed');
  assert.equal(bundle.base.count, 2);
  assert.deepEqual([bundle.recapture, bundle.residual, bundle.submit], [null, null, null]);

  write(path.join(fixtures, 'golden/vectors.json'), vectors('a', 'b', 'c'));
  write(path.join(fixtures, 'golden/recapture.json'), vectors('d'));
  write(path.join(fixtures, 'golden/residual.json'), vectors('e'));
  write(path.join(fixtures, 'golden/submit.json'), vectors('f'));
  bundle = loadVectorBundle(rootDir, env);
  assert.equal(bundle.base.kind, 'local');
  assert.equal(bundle.base.count, 3);
  assert.deepEqual([bundle.recapture.count, bundle.residual.count, bundle.submit.count], [1, 1, 1]);
  assert.deepEqual(Object.keys(JSON.parse(bundle.text).cases), ['a', 'b', 'c', 'd', 'e', 'f']);

  for (const name of ['vectors.json', 'recapture.json', 'residual.json', 'submit.json']) {
    const file = path.join(fixtures, 'golden', name);
    rmSync(file);
    mkdirSync(file);
    assert.throws(() => loadVectorBundle(rootDir, env), { code: 'EISDIR' }, name);
    rmSync(file, { recursive: true });
  }
  bundle = loadVectorBundle(rootDir, env);
  assert.equal(bundle.base.kind, 'committed');
  assert.deepEqual([bundle.recapture, bundle.residual, bundle.submit], [null, null, null]);
});

test('loadBaselineIds: a missing baseline is empty, a directory throws', (t) => {
  const rootDir = tempDir(t, 'golden-baseline');
  assert.deepEqual(loadBaselineIds(rootDir), []);
  write(path.join(rootDir, BASELINE_FILE), '// header\n["b", "a"]\n');
  assert.deepEqual(loadBaselineIds(rootDir), ['b', 'a']);
  rmSync(path.join(rootDir, BASELINE_FILE));
  mkdirSync(path.join(rootDir, BASELINE_FILE));
  assert.throws(() => loadBaselineIds(rootDir), { code: 'EISDIR' });
});
