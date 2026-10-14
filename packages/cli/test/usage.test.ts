import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'dist/cli/src/c2c.js');
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/redistributable/library-application-system/library_application.ds');

function runAnalyze(...args: string[]) {
  return spawnSync(process.execPath, [cli, 'analyze', fixture, ...args], { encoding: 'utf8' });
}

function assertLockError(args: string[], message: string) {
  const result = runAnalyze(...args);
  assert.equal(result.status, 2);
  assert.equal(result.stderr.trim(), `c2c: ${message}`);
  assert.doesNotMatch(result.stderr, /^\s*at /m);
}

test('analyze --lock rejects a missing path without a stack', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'c2c-analyze-lock-'));
  try {
    const missing = resolve(dir, 'missing.json');
    assertLockError(['--lock', missing], `no such lock file: ${missing}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze --lock rejects a bare flag without a stack', () => {
  assertLockError(['--lock'], 'needs a value');
});

test('analyze --lock rejects malformed JSON without a stack', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'c2c-analyze-lock-'));
  try {
    const malformed = resolve(dir, 'malformed.json');
    writeFileSync(malformed, '{');
    assertLockError(['--lock', malformed], 'lock file is not valid JSON');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze --lock rejects a wrong version without a stack', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'c2c-analyze-lock-'));
  try {
    const wrongVersion = resolve(dir, 'wrong-version.json');
    writeFileSync(wrongVersion, '{"version":2,"entries":{}}');
    assertLockError(['--lock', wrongVersion], 'c2c.lock.json is not version 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze without --lock keeps the implicit default behavior', () => {
  const result = runAnalyze();
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /deterministic/);
});
// The `node c2c.js` children below share a V8 compile cache so each e2e spawn
// does not recompile the whole CLI (ignored on runtimes without it).
process.env.NODE_COMPILE_CACHE ??= join(tmpdir(), 'c2c-node-compile-cache');

test('cli without arguments prints usage and exits 2', () => {
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: c2c parse/);
  assert.match(result.stderr, /\(when some tables are blocked, seed\.json and the CSVs for unblocked tables are still written; blocked tables get no CSV, junction rows or fixture files\)/);
});
