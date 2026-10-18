import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-ignore shared JavaScript test helper
import { cleanCliEnv } from '../../../tests/cli-test-env.mjs';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'dist/cli/src/c2c.js');

/** Run c2c in an empty workspace with no inherited credentials or config (coverage collection still passes through). */
function run(args: string[]): { status: number | null; stdout: string; stderr: string; written: string[] } {
  const home = mkdtempSync(join(tmpdir(), 'c2c-guards-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'c2c-guards-'));
  try {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: workspace,
      encoding: 'utf8',
            env: cleanCliEnv({
        PATH: process.env.PATH ?? '',
        HOME: home,
        C2C_WORKSPACE: workspace,
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
            }),
      input: '',
      timeout: 30_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, written: readdirSync(workspace) };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

const GATED: string[][] = [
  ['deploy', 'app.ds', '--confirm', '--function-env', 'new'],
  ['users', '--confirm'],
  ['smoke', 'app.ds', '--confirm'],
  ['provision', '--out', 'out', '--confirm', '--run', 'import'],
  ['provision', '--out', 'out', '--confirm', '--run', 'tables', '--project', '<project-id>'],
  ['sync-delta', '--confirm'],
  ['rollback-export', '--confirm'],
  ['migrate-data', '--confirm'],
  ['migrate-data', '--source-csv', 'data', '--ds', 'app.ds', '--confirm'],
  ['migrate-data', '--seed', 'seed.json', '--ds', 'app.ds', '--confirm'],
  ['edit', 'app.ds', 'rename-field', 'A', 'b', 'c', '--apply', '--confirm'],
];

for (const args of GATED) {
  test(`c2c ${args.join(' ')} is refused before any work when doctor has never run`, () => {
    const result = run(args);
    assert.equal(result.status, 5, result.stderr);
    assert.match(result.stderr, /^c2c: doctor is not green for .* \(run c2c doctor; last: never run\)\n$/);
    assert.equal(result.stdout, '');
    assert.deepEqual(result.written, [], 'a refused live command writes nothing to the workspace');
  });
}

test('edit --confirm without --apply is not doctor-gated (it only records locally)', () => {
  const result = run(['edit', 'missing.ds', 'rename-field', 'A', 'b', 'c', '--confirm']);
  assert.notEqual(result.status, 5);
  assert.doesNotMatch(result.stderr, /doctor is not green/);
});

test('a live command without --confirm is not doctor-gated', () => {
  const result = run(['deploy', 'missing.ds']);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'c2c: no such file or directory: missing.ds\n');
});

test('an unknown flag is refused with exit 2 before the command runs', () => {
  for (const cmd of ['deploy', 'migrate-data', 'smoke']) {
    const result = run([cmd, 'app.ds', '--no-such-flag']);
    assert.equal(result.status, 2, `${cmd}: ${result.stderr}`);
    assert.equal(result.stderr, `c2c ${cmd}: unknown flag --no-such-flag\n`);
    assert.deepEqual(result.written, []);
  }
});

test('parse and analyze report a missing source in one line without a stack', () => {
  for (const cmd of ['parse', 'analyze']) {
    const result = run([cmd, 'nope/missing.ds']);
    assert.equal(result.status, 1, `${cmd}: ${result.stderr}`);
    assert.equal(result.stderr, 'c2c: no such file or directory: nope/missing.ds\n');
    assert.equal(result.stdout, '');
  }
});
