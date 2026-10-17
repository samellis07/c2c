/**
 * Re-runs the widget record tests in zones east and west of UTC. The widget
 * suite builds its bundle and renders once per process, so the zone is set
 * on a spawned `node --test` of the compiled widgets.test.js — the only way
 * a zone reliably applies to every Date the widgets make. A missing template
 * install is a failure inside the spawned suite, not a skip here.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SUITE = fileURLToPath(new URL('./widgets.test.js', import.meta.url));
/** Heap cap and per-test timeout for the child suite (see scripts/test-limits.mjs). */
const CHILD_LIMITS = ['--max-old-space-size=2048', '--test-timeout=120000'];

/**
 * Every failing subtest of the child TAP run, each with its own diagnostic
 * block, so a CI log names what broke instead of only the output tail.
 */
function failingSubtests(tap: string): string[] {
  const lines = tap.split('\n');
  const failures: string[] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)not ok \d+ - (.*)$/.exec(line);
    if (!m || m[2] === SUITE) return;
    const block = [line.trim()];
    for (let j = i + 1; j < lines.length && block.length < 40; j++) {
      const indent = /^(\s*)/.exec(lines[j])![1].length;
      if (indent <= m[1].length && lines[j].trim() !== '') break;
      block.push(lines[j]);
    }
    failures.push(block.join('\n'));
  });
  return failures;
}

test('a failing child subtest is named with its own diagnostic, passing ones are not', () => {
  const tap = [
    '# Subtest: a passing check',
    'ok 1 - a passing check',
    '  ---',
    '  duration_ms: 1',
    '  ...',
    '# Subtest: a lazy check',
    'not ok 2 - a lazy check',
    '  ---',
    "  error: 'a lazy widget never mounted'",
    '  ...',
    '# Subtest: a later check',
    'ok 3 - a later check',
    `not ok 1 - ${SUITE}`,
    '# fail 1',
  ].join('\n');
  const failures = failingSubtests(tap);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^not ok 2 - a lazy check\n/);
  assert.match(failures[0], /a lazy widget never mounted/);
  assert.doesNotMatch(failures[0], /later check/);
  assert.deepEqual(failingSubtests(tap.replace('not ok 2', 'ok 2')), []);
});

for (const zone of ['Asia/Kolkata', 'America/Los_Angeles']) {
  test(`widget load→save holds under TZ=${zone}`, { timeout: 300000 }, () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
    // A capped heap and a hard deadline: a runaway child fails this test
    // with its output instead of exhausting the machine or hanging CI.
    const run = spawnSync(process.execPath, [...CHILD_LIMITS, '--test', '--test-reporter=tap', SUITE], {
      env: { ...env, TZ: zone },
      encoding: 'utf8',
      timeout: 240000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
    });
    const summary = `${run.stdout ?? ''}${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    const failed = Number(/# fail (\d+)/.exec(summary)?.[1] ?? 0);
    const passed = Number(/# pass (\d+)/.exec(summary)?.[1] ?? 0);
    const failures = failingSubtests(summary);
    const detail = failures.length ? `failing subtests:\n${failures.join('\n')}` : summary.slice(-2000);
    assert.equal(run.status, 0, `TZ=${zone} exited ${run.status} (signal ${run.signal}):\n${detail}`);
    assert.equal(failed, 0, `TZ=${zone} reported ${failed} failure(s):\n${detail}`);
    assert.ok(passed >= 5, `TZ=${zone} ran only ${passed} test(s)`);
  });
}
