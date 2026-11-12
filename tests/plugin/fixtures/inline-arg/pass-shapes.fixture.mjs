/**
 * Fixture: spawn shapes the inline-arg guard must accept. Each mirrors a
 * shape already on main: a small inline script, a script held in a plainly
 * named variable, JSON.stringify of a small name, a spawned file with only
 * zone settings in env, a child that reads stdin, and small values under
 * short names such as `src` (which is not *SOURCE*).
 *
 * This file is never executed. tests/plugin/hygiene.test.mjs feeds it to
 * scanInlineArgs directly and requires zero hits.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('a small inline script is fine', () => {
  const run = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
});

test('a script in a plainly named variable is fine', () => {
  const script = 'process.stdout.write("ok")';
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(run.status, 0);
});

test('stringify of a small name is fine', () => {
  const name = 'zone-probe';
  const out = execFileSync(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(name)})`], { encoding: 'utf8' });
  assert.equal(out, 'zone-probe');
});

test('spawning a file with zone settings is fine', () => {
  const probe = '/tmp/zone-probe.mjs';
  const seen = ['America/Los_Angeles', 'Asia/Kolkata'].map((zone) => {
    const run = spawnSync(process.execPath, [probe], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  });
  assert.deepEqual(seen, ['17-Oct-2026', '17-Oct-2026']);
});

test('a child reading stdin is fine', () => {
  const childScript = `
    const text = require('node:fs').readFileSync(0, 'utf8');
    process.stdout.write(text.trim());
  `;
  const child = spawnSync(process.execPath, ['-e', childScript], { encoding: 'utf8', input: '17-Oct-2026' });
  assert.equal(child.stdout, '17-Oct-2026');
});

test('small values under short names are fine', () => {
  const script = 'process.stdout.write(process.env.C2C_SRC)';
  const src = 'application "Sample" { }';
  const guard = { mode: 'live' };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, C2C_SRC: src, C2C_GUARD: JSON.stringify(guard) },
  });
  assert.equal(child.status, 0);
});
