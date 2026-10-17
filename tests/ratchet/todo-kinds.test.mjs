import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  UPDATE_COMMAND,
  analyzeFixture,
  baselineFile,
  collectAllFixtureCounts,
  compareCounts,
  enforceRatchet,
  loadBaselineFile,
  parseBaseline,
  planBaselineWrite,
  repoRoot,
} from './todo-kinds-lib.mjs';

let cachedFreight;

function freightCounts() {
  if (!cachedFreight) {
    cachedFreight = analyzeFixture('fixtures/redistributable/freight-forwarding');
  }
  return cachedFreight;
}

function childEnv() {
  const env = {
    ...process.env,
    UPDATE_TODO_RATCHET: '1',
    TODO_RATCHET_PROOF: '1',
  };
  // The parent test run sets this. Leaving it set makes node skip nested --test files.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function risenFreight() {
  const fixture = 'fixtures/redistributable/freight-forwarding';
  const real = freightCounts();
  const construct = Object.keys(real).sort()[0];
  assert.ok(construct, `${fixture} must report at least one TODO kind`);
  assert.ok(real[construct] >= 1, `${construct} must have a positive count to mutate`);
  return {
    fixture,
    construct,
    current: { [fixture]: { ...real, [construct]: real[construct] + 1 } },
    baseline: { [fixture]: { ...real } },
  };
}


// Read the content and the modification time through one descriptor, so both
// describe the same file.
function readWithMtime(file) {
  const fd = openSync(file, 'r');
  try {
    return [readFileSync(fd, 'utf8'), fstatSync(fd).mtimeMs];
  } finally {
    closeSync(fd);
  }
}

test('TODO kinds ratchet on committed fixtures', () => {
  const before = readFileSync(baselineFile, 'utf8');
  const baseline = loadBaselineFile(baselineFile);
  const current = collectAllFixtureCounts(repoRoot);
  // Proof-only. Adding a count can only fail the gate; it cannot bless a rise.
  if (process.env.TODO_RATCHET_PROOF === '1') {
    const fixture = 'fixtures/redistributable/freight-forwarding';
    const construct = Object.keys(current[fixture] || {}).sort()[0];
    assert.ok(construct, `${fixture} must report at least one TODO kind`);
    current[fixture] = { ...current[fixture], [construct]: current[fixture][construct] + 1 };
  }
  enforceRatchet(current, baseline);
  assert.equal(readFileSync(baselineFile, 'utf8'), before);
  assert.equal(UPDATE_COMMAND, 'npm run ratchet:update');
});

test('ratchet fails when an extra TODO kind appears or increases', () => {
  const baseline = {
    'fixtures/dialects/d1-minimal.ds': {},
    'fixtures/redistributable/freight-forwarding': { 'client-condition-uses-server': 13 },
  };
  const currentWithNew = {
    'fixtures/dialects/d1-minimal.ds': { 'unexpected-new-kind': 1 },
    'fixtures/redistributable/freight-forwarding': { 'client-condition-uses-server': 13 },
  };
  const res1 = compareCounts(currentWithNew, baseline);
  assert.equal(res1.increases.length, 1);
  assert.equal(res1.increases[0].construct, 'unexpected-new-kind');
  assert.equal(res1.increases[0].baseline, 0);

  const currentWithIncreased = {
    'fixtures/dialects/d1-minimal.ds': {},
    'fixtures/redistributable/freight-forwarding': { 'client-condition-uses-server': 14 },
  };
  const res2 = compareCounts(currentWithIncreased, baseline);
  assert.equal(res2.increases.length, 1);
  assert.equal(res2.increases[0].construct, 'client-condition-uses-server');
  assert.equal(res2.increases[0].current, 14);
  assert.equal(res2.increases[0].baseline, 13);
});

test('ratchet fails when a TODO kind decreases (stale baseline)', () => {
  const baseline = {
    'fixtures/redistributable/freight-forwarding': { 'client-condition-uses-server': 13 },
  };
  const currentWithDecreased = {
    'fixtures/redistributable/freight-forwarding': { 'client-condition-uses-server': 12 },
  };
  const { increases, decreases } = compareCounts(currentWithDecreased, baseline);
  assert.equal(increases.length, 0);
  assert.equal(decreases.length, 1);
  assert.equal(decreases[0].construct, 'client-condition-uses-server');
  assert.equal(decreases[0].current, 12);
  assert.equal(decreases[0].baseline, 13);
});

test('malformed or missing baseline fails closed', () => {
  const committed = readFileSync(baselineFile, 'utf8');
  const previous = process.env.UPDATE_TODO_RATCHET;
  process.env.UPDATE_TODO_RATCHET = '1';
  try {
    try {
      parseBaseline('{', 'tests/ratchet/todo-kinds.json');
      assert.fail('expected malformed JSON to throw');
    } catch (err) {
      assert.equal(err.name, 'TodoRatchetError');
      assert.equal(err.code, 'TODO_RATCHET_BASELINE_MALFORMED');
    }

    try {
      parseBaseline('[]', 'tests/ratchet/todo-kinds.json');
      assert.fail('expected a non-object baseline to throw');
    } catch (err) {
      assert.equal(err.name, 'TodoRatchetError');
      assert.equal(err.code, 'TODO_RATCHET_BASELINE_MALFORMED');
    }

    const dir = mkdtempSync(path.join(tmpdir(), 'todo-ratchet-'));
    const missing = path.join(dir, 'missing.json');
    try {
      loadBaselineFile(missing);
      assert.fail('expected a missing baseline to throw');
    } catch (err) {
      assert.equal(err.name, 'TodoRatchetError');
      assert.equal(err.code, 'TODO_RATCHET_BASELINE_MISSING');
    }

    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{');
    try {
      loadBaselineFile(bad);
      assert.fail('expected a malformed baseline file to throw');
    } catch (err) {
      assert.equal(err.name, 'TodoRatchetError');
      assert.equal(err.code, 'TODO_RATCHET_BASELINE_MALFORMED');
    }
    assert.equal(readFileSync(bad, 'utf8'), '{');

    try {
      planBaselineWrite({ exists: true, raw: '{', current: {}, allowIncrease: true });
      assert.fail('expected the update planner to refuse malformed JSON');
    } catch (err) {
      assert.equal(err.name, 'TodoRatchetError');
      assert.equal(err.code, 'TODO_RATCHET_BASELINE_MALFORMED');
    }

    assert.equal(readFileSync(baselineFile, 'utf8'), committed);
  } finally {
    if (previous === undefined) delete process.env.UPDATE_TODO_RATCHET;
    else process.env.UPDATE_TODO_RATCHET = previous;
  }
});

test('a real fixture count mutation fails the ratchet', () => {
  const before = readFileSync(baselineFile, 'utf8');
  const { construct, current, baseline } = risenFreight();
  try {
    enforceRatchet(current, baseline);
    assert.fail('expected a risen fixture count to throw');
  } catch (err) {
    assert.equal(err.name, 'TodoRatchetError');
    assert.equal(err.code, 'TODO_RATCHET_INCREASE');
    assert.match(err.message, new RegExp(construct.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(readFileSync(baselineFile, 'utf8'), before);
});

test('UPDATE_TODO_RATCHET=1 still fails when a fixture count rises', () => {
  const [before, beforeMtime] = readWithMtime(baselineFile);
  const child = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=2048',
      '--test-timeout=120000',
      '--test',
      '--test-name-pattern',
      '^TODO kinds ratchet on committed fixtures$',
      'tests/ratchet/todo-kinds.test.mjs',
    ],
    {
      cwd: repoRoot,
      env: childEnv(),
      encoding: 'utf8',
    },
  );
  const output = `${child.stdout}\n${child.stderr}`;
  assert.equal(child.status, 1, output);
  assert.match(output, /TodoRatchetError/);
  assert.match(output, /TODO_RATCHET_INCREASE/);
  assert.doesNotMatch(output, /Updated tests\/ratchet\/todo-kinds\.json/);
  const [after, afterMtime] = readWithMtime(baselineFile);
  assert.equal(after, before);
  assert.equal(afterMtime, beforeMtime);
});
