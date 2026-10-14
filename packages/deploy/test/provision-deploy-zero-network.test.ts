/** Dry-run commands must remain offline even if code bypasses the injected Io. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planCli } from '../src/offline-plan.js';
import { provisionCli } from '../src/provision.js';
import { deployCli, type Io } from '../src/cli.js';
import { trapNetwork } from '../../cli/test/helpers/no-network.js';
const fixture = new URL('../../../packages/deploy/test/fixtures/offline-widget.ds', import.meta.url);

function silentIo(): Io {
  return {
    stdout: () => {},
    stderr: () => {},
    env: { PATH: process.env.PATH },
    fetch: async (url: string) => { throw new Error(`injected fetch: ${url}`); },
    spawn: async (command: string) => { throw new Error(`injected spawn: ${command}`); },
  } as Io;
}

test('provision dry-run and deploy plan make zero network attempts on a redistributable fixture', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-zero-network-'));
  const calls = trapNetwork();
  try {
    calls.assertTrapsWork();
    const io = silentIo();
    const ds = readFileSync(fixture, 'utf8');
    const source = join(out, 'widget.ds');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(source, ds);

    assert.equal(await planCli([source, '--out', join(out, 'plan'), '--dc', 'in'], io), 0);
    assert.equal(await provisionCli(['--out', join(out, 'plan')], io), 0);
    assert.equal(await deployCli([source, '--out', join(out, 'deploy')], io), 0);
    assert.deepEqual(calls.calls, []);
  } finally {
    calls.restore();
    rmSync(out, { recursive: true, force: true });
  }
});
