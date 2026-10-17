import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHILD_HEAP_MB,
  TEST_HEAP_MB,
  TEST_TIMEOUT_MS,
  findUnlimitedTestScripts,
  getChildTestLimitArgs,
  getTestLimitArgs,
  withHeapCap,
} from '../../scripts/test-limits.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

function packageJsonFiles() {
  const files = [join(root, 'package.json'), join(root, 'packages/ui-react/template/package.json')];
  for (const name of readdirSync(join(root, 'packages'))) {
    const file = join(root, 'packages', name, 'package.json');
    if (existsSync(file)) files.push(file);
  }
  return files.filter((file) => existsSync(file));
}

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(abs, out);
    else if (/\.(?:ts|mjs|cjs|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

test('limit flags carry the documented values', () => {
  assert.deepEqual(getTestLimitArgs(), [`--max-old-space-size=${TEST_HEAP_MB}`, `--test-timeout=${TEST_TIMEOUT_MS}`]);
  assert.deepEqual(getChildTestLimitArgs(), [`--max-old-space-size=${CHILD_HEAP_MB}`, `--test-timeout=${TEST_TIMEOUT_MS}`]);
  assert.equal(TEST_HEAP_MB, 4096);
  assert.equal(CHILD_HEAP_MB, 2048);
  assert.equal(TEST_TIMEOUT_MS, 600000);
});

test('withHeapCap appends the cap after any existing NODE_OPTIONS', () => {
  assert.equal(withHeapCap(undefined), '--max-old-space-size=4096');
  assert.equal(withHeapCap(''), '--max-old-space-size=4096');
  assert.equal(withHeapCap('--max-old-space-size=9000'), '--max-old-space-size=9000 --max-old-space-size=4096');
});

test('every package test script carries the heap cap and timeout', () => {
  const files = packageJsonFiles();
  assert.ok(files.length >= 2, 'expected the root and template package.json');
  for (const file of files) {
    const { scripts } = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(findUnlimitedTestScripts(scripts), [], relative(root, file));
  }
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.match(scripts.test, /node scripts\/run-tests\.mjs\b/, 'npm test must run through scripts/run-tests.mjs');
});

test('a test script without the cap or timeout is reported', () => {
  assert.deepEqual(findUnlimitedTestScripts({ ok: 'npm run build && node scripts/run-tests.mjs --list x' }), []);
  assert.deepEqual(
    findUnlimitedTestScripts({ ok: 'node --max-old-space-size=2048 --test-timeout=60000 --test dist/a' }),
    [],
  );
  assert.equal(findUnlimitedTestScripts({ bare: 'node --test dist/a' }).length, 2);
  assert.match(findUnlimitedTestScripts({ t: 'node --test-timeout=1000 --test x' })[0], /max-old-space-size/);
  assert.match(findUnlimitedTestScripts({ t: 'node --max-old-space-size=4096 --test x' })[0], /test-timeout/);
  assert.match(
    findUnlimitedTestScripts({ t: 'node --max-old-space-size=8192 --test-timeout=1000 --test x' })[0],
    /max-old-space-size<=4096/,
  );
  assert.match(
    findUnlimitedTestScripts({ t: 'node --max-old-space-size=4096 --test-timeout=999999 --test x' })[0],
    /test-timeout<=600000/,
  );
  assert.match(
    findUnlimitedTestScripts({ t: 'node --max-old-space-size=4096 --test-timeout=600001 --test x' })[0],
    /test-timeout<=600000/,
  );
  assert.deepEqual(
    findUnlimitedTestScripts({ ok: 'node --max-old-space-size=4096 --test-timeout=600000 --test x' }),
    [],
  );
  assert.equal(findUnlimitedTestScripts({ t: 'npm run build && vitest run' }).length, 2);
  assert.deepEqual(findUnlimitedTestScripts({ build: 'tsc -p tsconfig.json', serve: 'node dist/cli.js --test-mode' }), []);
});

test('run-tests.mjs starts node --test with the limits and caps NODE_OPTIONS', () => {
  const source = readFileSync(join(root, 'scripts/run-tests.mjs'), 'utf8');
  assert.match(source, /\.\.\.getTestLimitArgs\(\),\s*'--test',/);
  assert.match(source, /NODE_OPTIONS: withHeapCap\(process\.env\.NODE_OPTIONS\)/);
});

test('a test run through run-tests.mjs sees the heap cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-test-limits-'));
  try {
    const probe = join(dir, 'probe.test.mjs');
    writeFileSync(
      probe,
      [
        "import test from 'node:test';",
        "import { getHeapStatistics } from 'node:v8';",
        "test('probe', () => { console.log(`HEAP_LIMIT_MB=${Math.round(getHeapStatistics().heap_size_limit / 1048576)}`); console.log(`NODE_OPTIONS=${process.env.NODE_OPTIONS}`); });",
        '',
      ].join('\n'),
    );
    const env = { ...process.env, NODE_OPTIONS: '' };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, [join(root, 'scripts/run-tests.mjs'), probe], { encoding: 'utf8', env, timeout: 60000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const limit = Number(/HEAP_LIMIT_MB=(\d+)/.exec(run.stdout)?.[1]);
    assert.ok(limit > 0 && limit <= TEST_HEAP_MB + 256, `heap limit ${limit} MB exceeds the ${TEST_HEAP_MB} MB cap`);
    assert.match(run.stdout, /NODE_OPTIONS=--max-old-space-size=4096/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hung test is stopped by the per-test timeout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-test-limits-hang-'));
  try {
    const hang = join(dir, 'hang.test.mjs');
    writeFileSync(hang, "import test from 'node:test';\ntest('hangs', () => new Promise(() => { setInterval(() => {}, 1000); setTimeout(() => process.exit(1), 30000); }));\n");
    const env = { ...process.env, NODE_OPTIONS: '' };
    delete env.NODE_TEST_CONTEXT;
    const start = Date.now();
    const run = spawnSync(
      process.execPath,
      ['--max-old-space-size=2048', '--test-timeout=10000', '--test', hang],
      { encoding: 'utf8', env, timeout: 60000 },
    );
    const elapsed = Date.now() - start;
    assert.notEqual(run.status, 0, 'a hung test must fail');
    assert.match(run.stdout + run.stderr, /test timed out after 10000ms/);
    assert.ok(elapsed < 60000, `the hung test was not stopped promptly (${elapsed} ms)`);

    const noFlag = spawnSync(
      process.execPath,
      ['--max-old-space-size=2048', '--test', hang],
      { encoding: 'utf8', env, timeout: 15000, killSignal: 'SIGKILL' },
    );
    assert.equal(noFlag.status, null, 'without --test-timeout the hung test must not finish by itself');
    assert.equal(noFlag.signal, 'SIGKILL', 'the hung test was killed by the spawn timeout, not by node --test');
    assert.doesNotMatch(noFlag.stdout + noFlag.stderr, /test timed out after/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every spawned node --test child carries a heap cap and timeout', () => {
  const dirs = ['packages', 'tests', 'scripts', 'tools'].map((d) => join(root, d)).filter((d) => existsSync(d) && statSync(d).isDirectory());
  const spawners = [];
  for (const dir of dirs) {
    for (const file of sourceFiles(dir)) {
      const rel = relative(root, file).replace(/\\/g, '/');
      if (rel === 'scripts/run-tests.mjs' || rel === 'tests/plugin/test-limits.test.mjs') continue;
      const source = readFileSync(file, 'utf8');
      if (!/process\.execPath/.test(source) || !/['"]--test['"]/.test(source)) continue;
      spawners.push(rel);
      assert.match(source, new RegExp(`['"]--max-old-space-size=${CHILD_HEAP_MB}['"]`), `${rel} spawns node --test without --max-old-space-size=${CHILD_HEAP_MB}`);
      assert.match(source, new RegExp(`['"]--test-timeout=${TEST_TIMEOUT_MS}['"]`), `${rel} spawns node --test without --test-timeout=${TEST_TIMEOUT_MS}`);
    }
  }
  assert.ok(spawners.includes('packages/ui-react/test/widgets-tz.test.ts'), `spawners found: ${spawners.join(', ')}`);
});
