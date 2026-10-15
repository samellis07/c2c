#!/usr/bin/env node
/**
 * Locate or install the c2c runtime for bin/c2c, then print its directory.
 *
 *   node fetch-runtime.mjs
 *
 * A plugin installed from GitHub has no vendor/ tree (it is built, not
 * committed). runtime.json beside this file pins one release archive by URL
 * and sha256. On first use it is fetched once, checked, and unpacked into
 * the user cache, never into the plugin directory:
 *
 *   $C2C_RUNTIME_DIR, else $XDG_CACHE_HOME/c2c/runtime, else
 *   <home>/.cache/c2c/runtime (Windows: %LOCALAPPDATA%\c2c\runtime)
 *   └── <sha256>/c2c/...
 *
 * C2C_RUNTIME_ARCHIVE=<file> installs from a local copy of the archive
 * (offline machines); C2C_RUNTIME_URL=<url> fetches from a mirror. Both are
 * still checked against the pinned sha256.
 *
 * Exit 0 prints the runtime directory; exit 6 prints one `c2c: ...` line.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV_EXIT = 6;
// Unreadable lock files can be left by a crash between O_EXCL and write.
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 120;

class RuntimeError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cacheRoot(env) {
  if (env.C2C_RUNTIME_DIR) return path.resolve(env.C2C_RUNTIME_DIR);
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, 'c2c', 'runtime');
  if (process.platform === 'win32' && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'c2c', 'runtime');
  return path.join(homedir(), '.cache', 'c2c', 'runtime');
}

function readLock() {
  let lock;
  try {
    lock = JSON.parse(readFileSync(path.join(here, 'runtime.json'), 'utf8'));
  } catch {
    throw new RuntimeError('c2c: plugin/runtime/runtime.json is missing or unreadable. Reinstall the c2c plugin.');
  }
  if (typeof lock.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(lock.sha256) || typeof lock.url !== 'string' || typeof lock.asset !== 'string') {
    throw new RuntimeError('c2c: plugin/runtime/runtime.json is malformed. Reinstall the c2c plugin.');
  }
  return lock;
}

function offlineHint(lock) {
  return `If this machine is offline, download ${lock.asset} (${lock.url}) on a connected machine, then run c2c with C2C_RUNTIME_ARCHIVE=<path to ${lock.asset}>.`;
}

/** The repository the pinned release asset belongs to, for fallback hints. */
function repoUrl(url) {
  const marker = '/releases/download/';
  const base = String(url).split(marker)[0];
  return base === url ? undefined : base;
}

function notPublished(url, lock) {
  const repo = repoUrl(url);
  const where = repo ? `${repo}/releases` : 'the release page';
  const steps = repo
    ? `git clone ${repo} && cd ${path.basename(repo)} && npm ci && npm run build && node scripts/vendor-plugin.mjs --pack`
    : 'npm ci && npm run build && node scripts/vendor-plugin.mjs --pack';
  return new RuntimeError(`c2c: the c2c ${lock.version} runtime asset ${lock.asset} is not published at ${url} (HTTP 404). The pinned runtime for this checkout has no release asset; check ${where}. To run from this checkout anyway, build the archive from source: ${steps} — then run c2c with C2C_RUNTIME_ARCHIVE=<path to ${lock.asset}>.`);
}

/** curl first (it honours proxy settings), then Node's fetch. */
async function download(url, lock) {
  const curl = spawnSync('curl', ['-fsSL', '--retry', '2', '--connect-timeout', '20', url], { maxBuffer: 1 << 30 });
  if (!curl.error && curl.status === 0) return curl.stdout;
  let status = Number(String(curl.stderr).match(/returned error: (\d{3})/)?.[1]);
  let reason = curl.error ? undefined : `curl exit ${curl.status}: ${String(curl.stderr).trim().split('\n').pop()}`;
  if (curl.error) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      status = res.status;
      reason = `HTTP ${res.status}`;
    } catch (error) {
      reason = error instanceof Error ? (error.cause?.code ?? error.message) : 'network error';
    }
  }
  if (status === 404) throw notPublished(url, lock);
  throw new RuntimeError(`c2c: could not download the c2c ${lock.version} runtime from ${url} (${reason}). c2c needs this one-time download on first run. ${offlineHint(lock)}`);
}

async function archiveBytes(lock, env) {
  if (env.C2C_RUNTIME_ARCHIVE) {
    try {
      return readFileSync(env.C2C_RUNTIME_ARCHIVE);
    } catch {
      throw new RuntimeError(`c2c: C2C_RUNTIME_ARCHIVE=${env.C2C_RUNTIME_ARCHIVE} is not a readable file. ${offlineHint(lock)}`);
    }
  }
  return download(env.C2C_RUNTIME_URL || lock.url, lock);
}

function field(block, offset, length) {
  const end = block.indexOf(0, offset);
  return block.toString('utf8', offset, end < 0 || end > offset + length ? offset + length : end);
}

/** Unpack the ustar/pax archive scripts/vendor-plugin.mjs --pack writes. */
function unpack(tar, dest) {
  let offset = 0;
  let paxPath;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const size = parseInt(field(block, 124, 12).trim() || '0', 8);
    const type = field(block, 156, 1) || '0';
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const match = body.toString('utf8').match(/^\d+ path=(.*)\n$/s);
      paxPath = match ? match[1] : undefined;
      continue;
    }
    if (type !== '0') throw new RuntimeError(`c2c: the runtime archive has an unexpected entry type ${type}. Reinstall the c2c plugin.`);
    const prefix = field(block, 345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    paxPath = undefined;
    const target = path.resolve(dest, name);
    if (!target.startsWith(`${path.resolve(dest)}${path.sep}`)) throw new RuntimeError(`c2c: the runtime archive has an unsafe path ${name}. Reinstall the c2c plugin.`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body, { mode: parseInt(field(block, 100, 8).trim() || '644', 8) & 0o755 });
  }
}

function manifestPresent(installed) {
  return lstatSync(path.join(installed, 'c2c', 'MANIFEST.sha256'), { throwIfNoEntry: false })?.isFile();
}

function assertTrustedDirectory(dir, label) {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return;
  const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    throw new RuntimeError(`c2c: ${label} ${dir} must be a real directory owned by the current user and not writable by group or others. Set C2C_RUNTIME_DIR to a private directory.`);
  }
}

/** Read the lock holder; {} when the file is gone or not yet fully written. */
function lockHolder(lockPath) {
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    return typeof holder?.pid === 'number' ? holder : {};
  } catch {
    return {};
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Exclusive install lock: O_EXCL creates the lock. Stale locks are atomically
 * renamed out of the way so only one waiter can reclaim a given lock file.
 */
async function acquireInstallLock(lockPath, isReady) {
  const token = randomBytes(16).toString('hex');
  for (;;) {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    let fd;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new RuntimeError(`c2c: could not create the runtime install lock ${lockPath} (${error.message}). Set C2C_RUNTIME_DIR to a writable directory.`);
      }
      if (isReady()) return undefined;
      const stat = lstatSync(lockPath, { throwIfNoEntry: false });
      if (!stat) continue;
      const holder = lockHolder(lockPath);
      const age = Date.now() - stat.mtimeMs;
      // A live process is never timed out, regardless of how long it has run.
      const stale = holder.pid ? !pidAlive(holder.pid) : age > LOCK_STALE_MS;
      if (stale) {
        // Test-only seam: pause between judging the lock stale and moving it
        // aside so a test can interleave a fresh lock creation.
        const barrier = process.env.C2C_TEST_LOCK_RECLAIM_BARRIER;
        if (barrier) {
          writeFileSync(barrier, `${process.pid}\n`);
          for (let i = 0; i < 3000 && !existsSync(`${barrier}.go`); i++) await sleep(10);
        }
        const reclaimed = `${lockPath}.stale-${process.pid}-${randomBytes(8).toString('hex')}`;
        try {
          renameSync(lockPath, reclaimed);
          // The lock may have been replaced since our inspection: a newer live
          // lock must be restored, never removed as if it were the stale one.
          const moved = lstatSync(reclaimed, { throwIfNoEntry: false });
          const movedHolder = moved ? lockHolder(reclaimed) : {};
          const same = moved
            && moved.ino === stat.ino && moved.dev === stat.dev && moved.mtimeMs === stat.mtimeMs
            && movedHolder.pid === holder.pid && movedHolder.token === holder.token && movedHolder.time === holder.time;
          if (!same) {
            try {
              linkSync(reclaimed, lockPath);
            } catch { /* a newer lock already holds the path */ }
          }
          rmSync(reclaimed, { force: true });
        } catch { /* another waiter reclaimed it; retry */ }
        continue;
      }
      await sleep(LOCK_POLL_MS);
      continue;
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, time: Date.now(), token }));
    } finally {
      closeSync(fd);
    }
    // Test-only seams: signal acquisition and hold the lock briefly so a test
    // can observe interleavings between holders and waiters.
    if (process.env.C2C_TEST_LOCK_ACQUIRED_FILE) writeFileSync(process.env.C2C_TEST_LOCK_ACQUIRED_FILE, `${process.pid}\n`);
    const hold = Number(process.env.C2C_TEST_LOCK_HOLD_MS);
    if (hold > 0) await sleep(hold);
    return token;
  }
}

function releaseInstallLock(lockPath, token) {
  if (!token) return;
  try {
    const holder = lockHolder(lockPath);
    if (holder.token === token) rmSync(lockPath, { force: true });
  } catch { /* best effort; never release another holder's lock */ }
}

export async function ensureRuntime(env = process.env) {
  const lock = readLock();
  const root = cacheRoot(env);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assertTrustedDirectory(root, 'runtime directory');
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError(`c2c: could not prepare runtime directory ${root} (${error instanceof Error ? error.message : error}). Set C2C_RUNTIME_DIR to a writable private directory.`);
  }
  const installed = path.join(root, lock.sha256);
  const runtime = path.join(installed, 'c2c');
  try {
    assertTrustedDirectory(installed, 'runtime cache entry');
    if (manifestPresent(installed)) return runtime;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError(`c2c: could not inspect runtime cache entry ${installed} (${error instanceof Error ? error.message : error}).`);
  }

  const lockPath = `${installed}.lock`;
  const token = await acquireInstallLock(lockPath, () => manifestPresent(installed));
  if (!token) return runtime; // a concurrent run finished the install
  const staging = `${installed}.partial-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    if (manifestPresent(installed)) return runtime;
    const bytes = await archiveBytes(lock, env);
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== lock.sha256) {
      throw new RuntimeError(`c2c: the c2c ${lock.version} runtime archive failed its checksum (expected sha256 ${lock.sha256}, got ${got}). It is corrupt or not ${lock.asset}. ${offlineHint(lock)}`);
    }
    let tar;
    try {
      tar = gunzipSync(bytes);
    } catch {
      throw new RuntimeError(`c2c: the c2c ${lock.version} runtime archive is not a gzip file. Reinstall the c2c plugin.`);
    }
    try {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      unpack(tar, staging);
      if (manifestPresent(installed)) return runtime; // never delete a complete install
      if (lstatSync(installed, { throwIfNoEntry: false })) {
        assertTrustedDirectory(installed, 'runtime cache entry');
        // A directory left by an interrupted older run has no manifest; move it
        // aside first so a reader never sees a half-deleted tree.
        const stale = `${installed}.stale-${process.pid}-${randomBytes(8).toString('hex')}`;
        renameSync(installed, stale);
        rmSync(stale, { recursive: true, force: true });
      }
      renameSync(staging, installed);
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(`c2c: could not unpack the c2c runtime into ${root} (${error instanceof Error ? error.message : error}). Set C2C_RUNTIME_DIR to a writable directory.`);
    }
    return runtime;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    releaseInstallLock(lockPath, token);
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))) {
  ensureRuntime().then(
    (dir) => process.stdout.write(`${dir}\n`),
    (error) => {
      process.stderr.write(`${error instanceof RuntimeError ? error.message : `c2c: runtime setup failed (${error instanceof Error ? error.message : error})`}\n`);
      process.exit(ENV_EXIT);
    },
  );
}

export { unpack };
