import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'dist/cli/src/c2c.js');
// The `node c2c.js` children below share a V8 compile cache so each e2e spawn
// does not recompile the whole CLI (ignored on runtimes without it).
process.env.NODE_COMPILE_CACHE ??= join(tmpdir(), 'c2c-node-compile-cache');

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('precheck on a missing file keeps exit 3 and points at the next step', () => {
  const result = run('precheck', '/tmp/does-not-exist.ds');
  assert.equal(result.status, 3);
  assert.match(result.stderr, /no such file or directory: \/tmp\/does-not-exist\.ds/);
  assert.match(result.stderr, /next step: check the path, or pass the export with --app/);
  assert.equal(result.stdout, '');
});

test('precheck on a non-export file keeps exit 4 and points at re-export', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'c2c-error-next-step-'));
  try {
    const garbage = resolve(dir, 'garbage.ds');
    writeFileSync(garbage, 'not a ds file');
    const result = run('precheck', garbage);
    assert.equal(result.status, 4);
    assert.match(result.stderr, /is not a Creator \.ds application export/);
    assert.match(result.stderr, /next step: re-export the app from Creator \(Settings -> Export\) and confirm the file is non-empty/);
    assert.equal(result.stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown verb keeps exit 2 and prints the short customer entry', () => {
  const result = run('frobnicate');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command 'frobnicate'/);
  for (const step of ['c2c doctor', 'c2c analyze', 'c2c plan', 'c2c migrate-data', 'c2c verify']) {
    assert.match(result.stderr, new RegExp(step), `missing journey step: ${step}`);
  }
  assert.match(result.stderr, /docs\/guide\//);
  assert.doesNotMatch(result.stderr, /usage: c2c parse/);
  const lines = result.stderr.trimEnd().split('\n');
  assert.ok(lines.length < 10, `unknown-verb output is ${lines.length} lines, want under 10`);
  assert.equal(result.stdout, '');
});

test('an unknown verb with --help still prints the full usage and exits 0', () => {
  const result = run('frobnicate', '--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /usage: c2c parse/);
  assert.equal(result.stderr, '');
});
