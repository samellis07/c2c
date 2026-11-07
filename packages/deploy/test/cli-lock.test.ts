import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  acquireCliLock,
  canonicalCred,
  cliLockFallbackPath,
  cliLockPath,
  cliLockPaths,
  withCliLock,
  CliLockTimeout,
} from '../src/cli-lock.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'c2c-cli-lock-test-'));
}

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

test('canonicalCred resolves symlinks and canonical paths', () => {
  const dir = tmpDir();
  try {
    const target = join(dir, 'real-cred.json');
    writeFileSync(target, '{}');
    const link = join(dir, 'link-cred.json');
    symlinkSync(target, link);

    assert.equal(canonicalCred(link), canonicalCred(target));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cliLockPath and fallback naming conventions', () => {
  const dir = tmpDir();
  try {
    const cred = join(dir, 'cred.json');
    writeFileSync(cred, '{}');
    const env = { X_ZC_CREDENTIAL_PATH: cred };

    assert.equal(cliLockPath(env), `${canonicalCred(cred)}.c2c-cli.lock`);
    assert.match(cliLockFallbackPath(env, dir), /\.c2c-cli-locks[/\\][a-f0-9]{32}\.lock$/);

    const paths = cliLockPaths(env, dir);
    assert.equal(paths[0], `${canonicalCred(cred)}.c2c-cli.lock`);
    assert.equal(paths.length >= 2, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock left by a dead process on this host is reclaimed', async () => {
  const dir = tmpDir();
  try {
    const lockPath = join(dir, 'test.c2c-cli.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        purpose: 'catalyst-cli',
        pid: deadPid(),
        host: hostname(),
        started: new Date().toISOString(),
        nonce: 'dead-nonce',
      }),
    );

    const handle = await acquireCliLock(lockPath, { waitMs: 2000, pollMs: 10 });
    const content = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(content.pid, process.pid);
    assert.notEqual(content.nonce, 'dead-nonce');
    handle.release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock whose heartbeat stopped longer than stale timeout is reclaimed', async () => {
  const dir = tmpDir();
  try {
    const lockPath = join(dir, 'test.c2c-cli.lock');
    // Live pid (this process) but heartbeat far in the past
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        purpose: 'catalyst-cli',
        pid: process.pid,
        host: hostname(),
        started: new Date().toISOString(),
        nonce: 'frozen-nonce',
      }),
    );
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);

    const handle = await acquireCliLock(lockPath, { staleMs: 1000, waitMs: 2000, pollMs: 10 });
    const content = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.notEqual(content.nonce, 'frozen-nonce');
    handle.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock held by another host is never reclaimed as stale', async () => {
  const dir = tmpDir();
  try {
    const lockPath = join(dir, 'test.c2c-cli.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        purpose: 'catalyst-cli',
        pid: deadPid(),
        host: 'remote-worker-host.invalid',
        started: new Date().toISOString(),
        nonce: 'remote-nonce',
      }),
    );
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);

    await assert.rejects(
      acquireCliLock(lockPath, { staleMs: 100, waitMs: 200, pollMs: 10 }),
      (err) => err instanceof CliLockTimeout && /remote-worker-host\.invalid/.test(err.message),
    );
    const content = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(content.nonce, 'remote-nonce');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live holder is waited for and timeout names the holder', async () => {
  const dir = tmpDir();
  try {
    const lockPath = join(dir, 'test.c2c-cli.lock');
    const first = await acquireCliLock(lockPath, { heartbeatMs: 20, staleMs: 200 });

    await assert.rejects(
      acquireCliLock(lockPath, { staleMs: 200, waitMs: 150, pollMs: 10 }),
      (err) => err instanceof CliLockTimeout && new RegExp(`pid ${process.pid}`).test(err.message),
    );

    first.release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withCliLock supports in-process re-entrancy without deadlocking', async () => {
  const dir = tmpDir();
  try {
    const cred = join(dir, 'cred.json');
    writeFileSync(cred, '{}');
    const env = { X_ZC_CREDENTIAL_PATH: cred };

    let insideNested = false;
    await withCliLock(env, async () => {
      assert.equal(existsSync(cliLockPath(env)), true);
      // Nested call under the same credential lock
      await withCliLock(env, async () => {
        insideNested = true;
      });
      assert.equal(insideNested, true);
      // Still locked until outer returns
      assert.equal(existsSync(cliLockPath(env)), true);
    });

    // Released after outermost finishes
    assert.equal(existsSync(cliLockPath(env)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withCliLock falls back to secondary path when primary dir is read-only', async () => {
  const dir = tmpDir();
  try {
    const credDir = join(dir, 'readonly-cred');
    mkdirSync(credDir, { recursive: true });
    const cred = join(credDir, 'cred.json');
    writeFileSync(cred, '{}');
    chmodSync(credDir, 0o555); // read-only directory

    const fallbackBase = join(dir, 'fallback');
    mkdirSync(fallbackBase, { recursive: true });
    const env = { X_ZC_CREDENTIAL_PATH: cred, C2C_CLI_LOCK_DIR: fallbackBase };

    let executed = false;
    await withCliLock(env, async () => {
      executed = true;
    });
    assert.equal(executed, true);

    chmodSync(credDir, 0o755);
  } finally {
    try {
      chmodSync(join(dir, 'readonly-cred'), 0o755);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C2C_NO_CLI_LOCK=1 bypasses locking', async () => {
  const dir = tmpDir();
  try {
    const cred = join(dir, 'cred.json');
    writeFileSync(cred, '{}');
    const env = { X_ZC_CREDENTIAL_PATH: cred, C2C_NO_CLI_LOCK: '1' };

    let ran = false;
    await withCliLock(env, async () => {
      ran = true;
      assert.equal(existsSync(cliLockPath(env)), false);
    });
    assert.equal(ran, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
