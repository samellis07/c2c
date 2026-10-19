/**
 * Hygiene check. A bad sample is rejected. The tracked tree is checked by
 * `npm run check:hygiene`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanInlineArgs } from '../../scripts/check-hygiene.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/check-hygiene.mjs');

test('hygiene canary rejects a home path, a non-placeholder address, and an id', () => {
  const res = spawnSync(process.execPath, [script, '--canary'], { cwd: root, encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /rejected bad samples/);
});

const inlineArgFixture = (name) =>
  readFileSync(path.join(root, 'tests/plugin/fixtures/inline-arg', name), 'utf8');

test('inline-arg guard flags the old test that inlined a source in one -e argument', () => {
  const hits = scanInlineArgs('tests/plugin/fixtures/inline-arg/old-date-zone.fixture.mjs', inlineArgFixture('old-date-zone.fixture.mjs'));
  assert.ok(hits.length >= 1, 'the old -e shape was accepted');
  for (const hit of hits) {
    assert.match(hit, /inline-arg/);
    assert.match(hit, /mkdtempSync/);
  }
});

test('inline-arg guard flags file-read and runtime-variable spawn shapes', () => {
  const hits = scanInlineArgs('tests/plugin/fixtures/inline-arg/other-shapes.fixture.mjs', inlineArgFixture('other-shapes.fixture.mjs'));
  assert.equal(hits.length, 2, `expected one hit per spawn, got:\n${hits.join('\n')}`);
  for (const hit of hits) assert.match(hit, /mkdtempSync/);
});

test('inline-arg guard accepts the small-script and spawn-a-file shapes on main', () => {
  const hits = scanInlineArgs('tests/plugin/fixtures/inline-arg/pass-shapes.fixture.mjs', inlineArgFixture('pass-shapes.fixture.mjs'));
  assert.deepEqual(hits, []);
});

test('the tracked tree passes the hygiene check with the inline-arg guard', () => {
  const res = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /0 hit\(s\)/);
});
