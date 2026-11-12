/**
 * Fixture: further rejected inline-argument shapes for the hygiene guard.
 * One case builds `-e` from a file read; the other passes a runtime value
 * through `--eval` and the child env. Both exceed one Linux argument on a
 * real source and pass only on macOS, so the guard must flag this file.
 *
 * This file is never executed. It lives under the inline-arg guard's own
 * test data, which the tree scan skips; tests/plugin/hygiene.test.mjs feeds
 * it to scanInlineArgs directly and requires one hit per case.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('a file read feeds the eval script', () => {
  const probe = '/tmp/zone-probe.mjs';
  const out = execFileSync(process.execPath, ['-e', readFileSync(probe, 'utf8')], { encoding: 'utf8' });
  assert.match(out, /17-Oct-2026/);
});

test('a runtime value travels through eval and env', async () => {
  const runtimeSource = 'export const displayDateValue = () => "17-Oct-2026";';
  const child = spawn(process.execPath, ['--eval', runtimeSource], {
    env: { ...process.env, C2C_RUNTIME: runtimeSource },
  });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  await new Promise((resolve) => child.on('close', resolve));
  assert.match(out, /17-Oct-2026/);
});
