import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTestList, readTestListLines } from '../../scripts/test-list.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const RUNNER = join(ROOT, 'scripts/run-tests.mjs');

test('comments and blank lines are ignored', () => {
  const entries = readTestListLines('# header\n\n  # indented\n\n  dist/core/test  \n./dist/cli/test/\n');
  assert.deepEqual(entries, [
    { path: 'dist/core/test', line: 5 },
    { path: 'dist/cli/test', line: 6 },
  ]);
});

test('scripts/test-files.txt paths are unique', () => {
  const text = readFileSync(new URL('../../scripts/test-files.txt', import.meta.url), 'utf8');
  const paths = parseTestList(text, 'scripts/test-files.txt').map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(paths.length > 0);
});

test('a duplicate path names both lines', () => {
  assert.throws(
    () => parseTestList('dist/core/test\n# skip\ndist/core/test/\n', 'scripts/test-files.txt'),
    /scripts\/test-files\.txt:3: duplicate path dist\/core\/test \(first at line 1\)/,
  );
});

function runList(lines, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-test-list-'));
  const list = join(dir, 'list.txt');
  writeFileSync(list, lines.join('\n') + '\n');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [RUNNER, '--list', list, ...extraArgs], {
    encoding: 'utf8',
    cwd: ROOT,
    env,
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test('a missing list path fails with its line number', () => {
  const result = runList(['# comment', '', 'not/a/real/path.test.mjs']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /list\.txt:3: missing path not\/a\/real\/path\.test\.mjs/);
});

test('a duplicate list path fails before any test runs', () => {
  const result = runList(['scripts/run-tests.mjs', 'scripts/run-tests.mjs']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /list\.txt:2: duplicate path scripts\/run-tests\.mjs \(first at line 1\)/);
  assert.equal(result.stdout ?? '', '');
});

test('--dry-run prints the resolved file and does not execute it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-test-list-dry-'));
  const file = join(dir, 'boom.test.mjs');
  const list = join(dir, 'list.txt');
  writeFileSync(file, 'throw new Error("should-not-run");\n');
  writeFileSync(list, `# c\n\n${file}\n`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [RUNNER, '--dry-run', '--list', list], {
    encoding: 'utf8',
    cwd: ROOT,
    env,
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('boom.test.mjs'), result.stdout);
  assert.ok(!`${result.stdout}${result.stderr ?? ''}`.includes('should-not-run'));
});
