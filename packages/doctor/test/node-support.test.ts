/**
 * Doctor Node support tracks package.json engines (the single source of
 * truth). CI runs both the pinned leg (20.20.1) and the 22 leg, so both
 * majors are fully supported: D-E1 passes on either, and no D-E2 warning
 * follows a supported version.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nodeSatisfies, repoRoot } from '../../core/src/toolchain.js';
import compat from '../data/compat.json' with { type: 'json' };
import { runDoctorChecks, type DoctorIo } from '../src/index.js';

const ORG = '10000000000';
const PROJECT = '10000000000013200';

function fakeIo(env: NodeJS.ProcessEnv): DoctorIo {
  return {
    stdout: () => {},
    stderr: () => {},
    env,
    spawn: async (command, args) => ({ code: 127, stdout: '', stderr: `${command}: not found` }),
  };
}

function enginesNode(): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as { engines: { node: string } };
  return pkg.engines.node;
}

test("doctor's accepted Node range is package.json engines", () => {
  const engines = enginesNode();
  assert.equal(compat.node.range, engines, `compat.json node.range must equal engines.node (${engines})`);
  const pinned = readFileSync(join(repoRoot(), '.nvmrc'), 'utf8').trim();
  assert.equal(compat.node.pinned, pinned, 'compat.json node.pinned must equal the .nvmrc pin');
  assert.ok(nodeSatisfies(pinned, engines), `the .nvmrc pin ${pinned} must satisfy engines ${engines}`);
});

test('D-E1 follows engines on both CI legs and fails outside it, with no D-E2 on supported versions', async () => {
  const engines = enginesNode();
  const dir = mkdtempSync(join(tmpdir(), 'c2c-doctor-node-'));
  // Both CI legs plus in-range patches pass; out-of-range majors fail.
  const supported = ['20.20.1', '20.20.0', '22.0.0', '22.12.0', '22.99.9'];
  const unsupported = ['18.20.4', '20.19.9', '23.0.0', '24.1.0'];
  for (const nodeVersion of [...supported, ...unsupported]) {
    const scope = { dc: 'in', org: ORG, project: PROJECT, ui: 'vanilla' as const, neverTouch: [] };
    const run = await runDoctorChecks({ io: fakeIo({}), workspace: dir, scope, local: true, nodeVersion });
    const expected = nodeSatisfies(nodeVersion, engines) ? 'pass' : 'fail';
    const de1 = run.checks.find((c) => c.id === 'D-E1');
    assert.equal(de1?.status, expected, `${nodeVersion}: ${JSON.stringify(de1)}`);
    if (expected === 'pass') {
      assert.equal(
        run.checks.find((c) => c.id === 'D-E2'),
        undefined,
        `${nodeVersion}: supported Node must not warn`,
      );
    }
  }
});
