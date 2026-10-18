import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-ignore shared JavaScript test helper
import { cleanCliEnv } from '../../../tests/cli-test-env.mjs';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'dist/cli/src/c2c.js');
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/redistributable/library-application-system/library_application.ds');

function runAnalyze(...args: string[]) {
  return spawnSync(process.execPath, [cli, 'analyze', fixture, ...args], { encoding: 'utf8', env: cleanCliEnv() });
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
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8', env: cleanCliEnv() });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: c2c parse/);
  assert.match(result.stderr, /\(when some tables are blocked, seed\.json and the CSVs for unblocked tables are still written; blocked tables get no CSV, junction rows or fixture files\)/);
});

test('cutover-checklist, proof, rollback-export and iac-drift refuse an unknown flag with exit 2 before running', () => {
  const cases: [string[], string][] = [
    [['cutover-checklist', fixture, '--rollback-dir', 'rollback'], 'c2c cutover-checklist: unknown flag --rollback-dir'],
    [['proof', fixture, '--rollback-dir', 'rollback'], 'c2c proof: unknown flag --rollback-dir'],
    [['rollback-export', '--ds', fixture, '--out', 'out', '--rows', 'rows', '--bogus'], 'c2c rollback-export: unknown flag --bogus'],
    [['iac-drift', 'a.json', 'b.json', '--json'], 'c2c iac-drift: unknown flag --json'],
  ];
  for (const [args, message] of cases) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: cleanCliEnv() });
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stderr.trim(), message);
    assert.equal(result.stdout, '');
  }
});

test('--help prints the command usage and exits 0 wherever it appears', () => {
  for (const args of [['iac-drift', '--help'], ['iac-drift', 'a.json', '--help'], ['deploy', '--help'], ['deploy', fixture, '--backfill-shadows', '--help']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: cleanCliEnv() });
    assert.equal(result.status, 0, args.join(' '));
    assert.match(result.stdout, new RegExp(`c2c ${args[0]} `));
    assert.equal(result.stderr, '');
  }
});

test('plan and deploy help list the schema-change flags and say deploy --previous is plan-only for a rename, drop or alter', () => {
  const plan = spawnSync(process.execPath, [cli, 'plan', '--help'], { encoding: 'utf8', env: cleanCliEnv() });
  assert.equal(plan.status, 0);
  for (const flag of ['--previous', '--rename', '--allow-destructive', '--backup']) assert.match(plan.stdout, new RegExp(`${flag} `), `plan --help lists ${flag}`);
  const deploy = spawnSync(process.execPath, [cli, 'deploy', '--help'], { encoding: 'utf8', env: cleanCliEnv() });
  assert.equal(deploy.status, 0);
  for (const flag of ['--previous', '--rename', '--allow-destructive', '--backup']) assert.match(deploy.stdout, new RegExp(`${flag} `), `deploy --help names ${flag}`);
  assert.match(deploy.stdout, /--previous refuses a rename, drop or alter today and changes nothing: those are plan-only/);
  const global = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', env: cleanCliEnv() });
  for (const flag of ['--previous', '--rename', '--allow-destructive', '--backup']) assert.match(global.stdout, new RegExp(`${flag} `), `c2c --help lists ${flag}`);
});

test('plan and deploy refuse a misspelled schema-change flag with exit 2 before running', () => {
  for (const cmd of ['plan', 'deploy']) {
    const result = spawnSync(process.execPath, [cli, cmd, fixture, '--out', 'out', '--previus', fixture], { encoding: 'utf8', env: cleanCliEnv() });
    assert.equal(result.status, 2, cmd);
    assert.equal(result.stderr.trim(), `c2c ${cmd}: unknown flag --previus`);
    assert.equal(result.stdout, '');
  }
  // plan writes nothing and never asks for --confirm: it is refused like any other unknown flag.
  const confirm = spawnSync(process.execPath, [cli, 'plan', fixture, '--out', 'out', '--confirm'], { encoding: 'utf8', env: cleanCliEnv() });
  assert.equal(confirm.status, 2);
  assert.equal(confirm.stderr.trim(), 'c2c plan: unknown flag --confirm');
});
