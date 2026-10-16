/**
 * Launcher Node gate. plugin/bin/c2c must accept Node 20.20+ and Node 22
 * (mirroring engines.node / compat.json node.range ">=20.20 <23") and keep
 * refusing anything else with exit 6 — probed with a stub `node` on PATH so
 * no other toolchain is needed. Accepted versions proceed past the gate
 * (they stop later at the missing vendored converter in a source checkout);
 * refused versions stop at the gate with "is not supported".
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const launcher = path.join(root, 'plugin/bin/c2c');

function stubNodeDir(version) {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-stub-node-'));
  const file = path.join(dir, 'node');
  writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = "-p" ]; then\n  printf '%s\\n' "$STUB_NODE_VERSION"\n  exit 0\nfi\nexit 0\n`,
  );
  chmodSync(file, 0o755);
  return dir;
}

function run(version) {
  const stub = stubNodeDir(version);
  const workspace = mkdtempSync(path.join(tmpdir(), 'c2c-launcher-ws-'));
  return spawnSync('sh', [launcher, 'doctor'], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      PATH: `${stub}:/usr/bin:/bin`,
      STUB_NODE_VERSION: version,
      C2C_WORKSPACE: workspace,
      C2C_QUIET_NODE_WARN: '1',
    },
  });
}

for (const version of ['20.20.0', '20.20.1', '22.0.0', '22.12.0', '22.99.9']) {
  test(`launcher passes the Node gate on ${version}`, () => {
    const res = run(version);
    assert.doesNotMatch(res.stderr, /is not supported/, `stderr: ${res.stderr}`);
  });
}

for (const version of ['18.20.4', '20.0.0', '20.19.9', '21.5.0', '23.0.0', '24.1.0', '', 'v22', 'node']) {
  test(`launcher refuses Node ${version === '' ? '(empty)' : version} with exit 6`, () => {
    const res = run(version);
    assert.equal(res.status, 6, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /is not supported/);
    assert.match(res.stderr, /Node 20 or 22/);
  });
}

test('launcher exits 6 when node is missing', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'c2c-launcher-ws-'));
  const res = spawnSync('sh', [launcher, 'doctor'], {
    cwd: workspace,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', C2C_WORKSPACE: workspace },
  });
  assert.equal(res.status, 6, `stderr: ${res.stderr}`);
  assert.match(res.stderr, /not installed/);
});
