/** Dry-run commands must remain offline even if code bypasses the injected Io. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync, symlinkSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { planCli } from '../src/offline-plan.js';
import { provisionCli } from '../src/provision.js';
import { deployCli, type Io } from '../src/cli.js';
import { trapNetwork } from '../../cli/test/helpers/no-network.js';
const require = createRequire(import.meta.url);
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


test('network trap refuses workers before they can reach a loopback listener', async () => {
  const server = createServer((_req, res) => { res.end('reached'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const trap = trapNetwork();
  let reached = false;
  const onRequest = () => { reached = true; };
  server.on('request', onRequest);
  try {
    const { Worker } = require('node:worker_threads') as typeof import('node:worker_threads');
    assert.throws(() => new Worker(`fetch('http://127.0.0.1:${address.port}/')`, { eval: true }), /unexpected network attempt: node:worker_threads.Worker/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(reached, false);
  } finally {
    trap.restore();
    server.close();
  }
});

test('allowExec matches the resolved executable and refuses shell injection modes', () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-exec-guard-'));
  const symlink = join(out, 'git');
  try {
    // Use the system curl resolved by PATH so the test does not depend on its location.
    const curlPath = process.env.PATH!.split(process.platform === 'win32' ? ';' : ':').map((dir) => join(dir, 'curl')).find((path) => {
      try { return realpathSync(path).endsWith('/curl'); } catch { return false; }
    });
    assert.ok(curlPath);
    const realCurl = realpathSync(curlPath);
    symlinkSync(realCurl, symlink);
    const trap = trapNetwork({ allowExec: ['git'] });
    try {
      const cp = require('node:child_process') as typeof import('node:child_process');
      assert.throws(() => cp.spawnSync(symlink, ['--version']), /unexpected network attempt: node:child_process.spawnSync/);
      const gitPath = process.env.PATH!.split(process.platform === 'win32' ? ';' : ':').map((dir) => join(dir, 'git')).find((path) => {
        try { return realpathSync(path).endsWith('/git'); } catch { return false; }
      });
      if (gitPath) assert.equal(cp.spawnSync(gitPath, ['--version']).status, 0);
      assert.throws(() => cp.execSync('git --version; curl http://127.0.0.1/'), /unexpected network attempt: node:child_process.execSync/);
      assert.throws(() => cp.spawnSync('git', ['--version'], { shell: true }), /unexpected network attempt: node:child_process.spawnSync/);
      assert.ok(gitPath, 'git must be on PATH so the allowlist contains a real git');
      const canonicalGit = realpathSync(gitPath);

      // The refusal must name the git resolved from the child PATH. A parent-PATH
      // lookup finds the allowlisted git and would run it instead of throwing.
      const plantedPath = join(out, 'planted-path');
      mkdirSync(plantedPath);
      const pathMarker = join(out, 'path-marker');
      writeFileSync(join(plantedPath, 'git'), '#!/bin/sh\nprintf planted > "$C2C_GUARD_MARKER"\n');
      chmodSync(join(plantedPath, 'git'), 0o755);
      const refusedResolved = (fragment: RegExp) => (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /unexpected network attempt: node:child_process\.spawnSync \(/);
        assert.match(message, fragment);
        return true;
      };
      assert.throws(() => cp.spawnSync('git', ['--version'], {
        env: { PATH: plantedPath, C2C_GUARD_MARKER: pathMarker },
      }), refusedResolved(/\/planted-path\/git\)/));
      assert.equal(existsSync(pathMarker), false);

      // Parent cwd holds an allowlisted ./git. Child cwd holds a different ./git.
      // Ignoring options.cwd resolves the parent binary and the call succeeds.
      const parentCwd = join(out, 'parent-cwd');
      const childCwd = join(out, 'child-cwd');
      mkdirSync(parentCwd);
      mkdirSync(childCwd);
      symlinkSync(canonicalGit, join(parentCwd, 'git'));
      const cwdMarker = join(out, 'cwd-marker');
      writeFileSync(join(childCwd, 'git'), '#!/bin/sh\nprintf planted > "$C2C_GUARD_MARKER"\n');
      chmodSync(join(childCwd, 'git'), 0o755);
      const previousCwd = process.cwd();
      process.chdir(parentCwd);
      try {
        assert.throws(() => cp.spawnSync('./git', ['--version'], {
          cwd: childCwd,
          env: { PATH: process.env.PATH, C2C_GUARD_MARKER: cwdMarker },
        }), refusedResolved(/\/child-cwd\/git\)/));
        assert.equal(existsSync(cwdMarker), false);
      } finally {
        process.chdir(previousCwd);
      }

    } finally {
      trap.restore();
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});


test('allowExec pins the checked executable when its symlink changes before spawn', () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-exec-swap-'));
  const swap = join(out, 'command');
  const safe = join(out, 'safe');
  const evil = join(out, 'evil');
  const marker = join(out, 'result');
  const cp = require('node:child_process') as typeof import('node:child_process');
  const nativeSpawnSync = cp.spawnSync;
  try {
    writeFileSync(safe, '#!/bin/sh\nprintf safe > "$C2C_GUARD_MARKER"\n');
    writeFileSync(evil, '#!/bin/sh\nprintf evil > "$C2C_GUARD_MARKER"\n');
    chmodSync(safe, 0o755);
    chmodSync(evil, 0o755);
    symlinkSync(safe, swap);

    // Install a shim below the trap. It changes the original symlink after
    // guard validation but before Node receives the command.
    (cp as unknown as { spawnSync: typeof cp.spawnSync }).spawnSync = ((command: Parameters<typeof cp.spawnSync>[0], ...args: unknown[]) => {
      rmSync(swap);
      symlinkSync(evil, swap);
      return nativeSpawnSync(command, ...args as Parameters<typeof nativeSpawnSync> extends [unknown, ...infer Rest] ? Rest : never);
    }) as typeof cp.spawnSync;
    const trap = trapNetwork({ allowExec: [safe] });
    try {
      const result = cp.spawnSync(swap, [], { env: { ...process.env, C2C_GUARD_MARKER: marker } });
      assert.equal(result.status, 0);
      assert.equal(readFileSync(marker, 'utf8'), 'safe');
    } finally {
      trap.restore();
    }
  } finally {
    (cp as unknown as { spawnSync: typeof cp.spawnSync }).spawnSync = nativeSpawnSync;
    rmSync(out, { recursive: true, force: true });
  }
});
