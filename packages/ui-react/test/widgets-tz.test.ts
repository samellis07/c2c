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

for (const zone of ['Asia/Kolkata', 'America/Los_Angeles']) {
  test(`widget load→save holds under TZ=${zone}`, { timeout: 300000 }, () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
    const run = spawnSync(process.execPath, ['--test', SUITE], {
      env: { ...env, TZ: zone },
      encoding: 'utf8',
    });
    const summary = `${run.stdout ?? ''}${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    const failed = Number(/# fail (\d+)/.exec(summary)?.[1] ?? 0);
    const passed = Number(/# pass (\d+)/.exec(summary)?.[1] ?? 0);
    assert.equal(run.status, 0, `TZ=${zone} exited ${run.status} (signal ${run.signal}):\n${summary.slice(-2000)}`);
    assert.equal(failed, 0, `TZ=${zone} reported ${failed} failure(s):\n${summary.slice(-2000)}`);
    assert.ok(passed >= 5, `TZ=${zone} ran only ${passed} test(s)`);
  });
}
