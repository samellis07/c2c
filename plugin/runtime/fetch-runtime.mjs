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
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV_EXIT = 6;

class RuntimeError extends Error {}

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

/** curl first (it honours proxy settings), then Node's fetch. */
async function download(url, lock) {
  const curl = spawnSync('curl', ['-fsSL', '--retry', '2', '--connect-timeout', '20', url], { maxBuffer: 1 << 30 });
  if (!curl.error && curl.status === 0) return curl.stdout;
  let reason = curl.error ? undefined : `curl exit ${curl.status}: ${String(curl.stderr).trim().split('\n').pop()}`;
  if (curl.error) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      reason = `HTTP ${res.status}`;
    } catch (error) {
      reason = error instanceof Error ? (error.cause?.code ?? error.message) : 'network error';
    }
  }
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

export async function ensureRuntime(env = process.env) {
  const lock = readLock();
  const root = cacheRoot(env);
  const installed = path.join(root, lock.sha256);
  const runtime = path.join(installed, 'c2c');
  if (lstatSync(path.join(runtime, 'MANIFEST.sha256'), { throwIfNoEntry: false })?.isFile()) return runtime;

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
  const staging = `${installed}.partial-${process.pid}`;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    unpack(tar, staging);
    // A directory left by an interrupted older run has no manifest; replace it.
    if (lstatSync(installed, { throwIfNoEntry: false })) rmSync(installed, { recursive: true, force: true });
    try {
      renameSync(staging, installed);
    } catch (error) {
      // Another c2c finished first; keep its copy.
      if (!lstatSync(path.join(runtime, 'MANIFEST.sha256'), { throwIfNoEntry: false })?.isFile()) throw error;
    }
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError(`c2c: could not unpack the c2c runtime into ${root} (${error instanceof Error ? error.message : error}). Set C2C_RUNTIME_DIR to a writable directory.`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return runtime;
}

ensureRuntime().then(
  (dir) => process.stdout.write(`${dir}\n`),
  (error) => {
    process.stderr.write(`${error instanceof RuntimeError ? error.message : `c2c: runtime setup failed (${error instanceof Error ? error.message : error})`}\n`);
    process.exit(ENV_EXIT);
  },
);
