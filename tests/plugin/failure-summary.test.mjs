import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const RUNNER = join(ROOT, 'scripts/run-tests.mjs');

function runRunner(files) {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-failure-summary-'));
  const paths = files.map(({ name, source }) => {
    const path = join(dir, name);
    writeFileSync(path, source);
    return path;
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  let result;
  try {
    result = { status: 0, output: execFileSync(process.execPath, [RUNNER, ...paths], { encoding: 'utf8', cwd: ROOT, env }) };
  } catch (error) {
    result = { status: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
  return { dir, ...result };
}

const FAILING = `
import test from 'node:test';
import assert from 'node:assert';
test('outer', async (t) => {
  await t.test('the deliberately failing leaf test', () => {
    assert.equal(1, 2, 'expected one to equal two');
  });
});
`;

test('failing test names print in the closing summary', (t) => {
  const { dir, status, output } = runRunner([{ name: 'fixture-fail.test.mjs', source: FAILING }]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.notEqual(status, 0);
  const section = output.split('--- failing tests (1) ---')[1];
  assert.ok(section, `missing summary section in output:\n${output.slice(-2000)}`);
  assert.ok(section.includes('outer > the deliberately failing leaf test'), `missing full test name:\n${section}`);
  assert.ok(section.includes('fixture-fail.test.mjs'), `missing file name:\n${section}`);
  assert.ok(section.includes('expected one to equal two'), `missing first error line:\n${section}`);
});

const FAILING_AND_TODO = `
import test from 'node:test';
import assert from 'node:assert';
test('the deliberately failing real test', () => {
  assert.equal(1, 2, 'expected one to equal two');
});
test('the deliberately failing todo test', { todo: true }, () => {
  assert.equal(1, 2);
});
`;

test('failing todo tests are counted but not listed as failures', (t) => {
  const { dir, status, output } = runRunner([{ name: 'fixture-todo.test.mjs', source: FAILING_AND_TODO }]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.notEqual(status, 0);
  const section = output.split('--- failing tests (1) ---')[1];
  assert.ok(section, `missing summary section in output:\n${output.slice(-2000)}`);
  assert.ok(section.includes('the deliberately failing real test'), `missing real failure:\n${section}`);
  assert.ok(!section.includes('the deliberately failing todo test'), `todo test listed as failure:\n${section}`);
  assert.ok(output.includes('todo-failing: 1'), `missing todo count:\n${output.slice(-2000)}`);
});

const TODO_ONLY = `
import test from 'node:test';
import assert from 'node:assert';
test('the deliberately failing todo test', { todo: true }, () => {
  assert.equal(1, 2);
});
`;

test('a run with only a failing todo test prints no failing-tests section', (t) => {
  const { dir, status, output } = runRunner([
    { name: 'fixture-todo-only.test.mjs', source: TODO_ONLY },
  ]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(status, 0);
  assert.ok(!output.includes('--- failing tests'), `unexpected summary in output:\n${output.slice(-1000)}`);
  assert.ok(output.includes('todo-failing: 1'), `missing todo count:\n${output.slice(-1000)}`);
});

test('a clean run prints no failing-tests section', (t) => {
  const { dir, status, output } = runRunner([
    { name: 'fixture-pass.test.mjs', source: "import test from 'node:test'; test('ok', () => {});\n" },
  ]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(status, 0);
  assert.ok(!output.includes('--- failing tests'), `unexpected summary in output:\n${output.slice(-1000)}`);
});
