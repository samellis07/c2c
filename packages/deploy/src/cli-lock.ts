/**
 * One Catalyst CLI at a time per credential (#140 CLI lock).
 *
 * The Catalyst CLI refreshes its access token in whichever process runs after
 * the token expires, and rewrites the credential file. Two processes on the
 * same credential refreshing at once race: one rotates the token, the others
 * fail with "Error when refreshing the access token" (or read an empty token)
 * and may write a stale credential back.
 *
 * Every command that drives the Catalyst CLI — doctor checks, deploy steps,
 * REST helper queries, and token reads/refreshes — runs under a single-flight
 * lock file keyed by the credential path, shared by every runner/process on the host.
 *
 * The lock is a pathname lease: created with its holder (pid, host, nonce)
 * already written, kept fresh by a heartbeat while held, and reclaimed only on
 * the same host when the holder pid is gone or the heartbeat stopped for longer
 * than the stale timeout. A lock naming another host is never stale.
 *
 * In-process re-entrancy is supported so nested calls in the same process do
 * not self-deadlock.
 */
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, unlinkSync, utimesSync, statSync, writeSync, linkSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

/** Catalyst CLI output that indicates concurrent refresh token failure. */
export const REFRESH_ERROR_RE = /Error when refreshing the access token|catalyst token was empty/i;

export interface CliLockOptions {
  /** A holder whose heartbeat is older than this (same host) is stale. Default 120s. */
  staleMs?: number;
  /** How often a holder refreshes the lock file's modification time. Default 15s. */
  heartbeatMs?: number;
  /** How long a step waits for the lock before giving up. Default 60s. */
  waitMs?: number;
  /** Poll interval while waiting. Default 50ms. */
  pollMs?: number;
  /** Pause after a refresh error before recheck in ms. Default 5s. */
  recheckDelayMs?: number;
  /** Real or mock sleep function. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Real or mock wall-clock millisecond time source. Defaults to Date.now. */
  now?: () => number;
  /** Optional working directory for fallback lock path determination. */
  work?: string;
}

export const CLI_LOCK_DEFAULTS: Required<Omit<CliLockOptions, 'sleep' | 'now' | 'work'>> = {
  staleMs: 120_000,
  heartbeatMs: 15_000,
  waitMs: 60_000,
  pollMs: 50,
  recheckDelayMs: 5_000,
};

export class CliLockTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliLockTimeout';
  }
}

export interface CliLockHolder {
  version: number;
  purpose: string;
  pid: number;
  host: string;
  started: string;
  nonce: string;
}

export interface CliLockHandle {
  path: string;
  release: () => void;
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const UNWRITABLE_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR']);

/** The credential's real path, so every spelling of it (relative, symlinked) names one lock. */
export function canonicalCred(cred: string): string {
  const abs = resolve(cred);
  try {
    return realpathSync(abs);
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

/**
 * The lock for a credential sits next to it, so every runner and work dir
 * using that credential shares it. Without X_ZC_CREDENTIAL_PATH the CLI uses
 * its own default store, and the lock is the shared fallback below.
 */
export function cliLockPath(env?: NodeJS.ProcessEnv, work?: string): string {
  const cred = env?.X_ZC_CREDENTIAL_PATH;
  return cred ? `${canonicalCred(cred)}.c2c-cli.lock` : cliLockFallbackPath(env, work);
}

/**
 * The fallback when the credential's directory is not writable (or no
 * credential path is set): one lock per credential in `.c2c-cli-locks` beside
 * the work dir or TMPDIR, named by a hash of the credential's real path.
 */
export function cliLockFallbackPath(env?: NodeJS.ProcessEnv, work?: string): string {
  const cred = env?.X_ZC_CREDENTIAL_PATH;
  const key = cred ? createHash('sha256').update(canonicalCred(cred)).digest('hex').slice(0, 32) : 'default-credential';
  const base = env?.C2C_CLI_LOCK_DIR ?? (work ? dirname(resolve(work)) : (env?.TMPDIR || tmpdir()));
  return join(base, '.c2c-cli-locks', `${key}.lock`);
}

/** Where to try taking the lock, in preference order. */
export function cliLockPaths(env?: NodeJS.ProcessEnv, work?: string): string[] {
  const paths: string[] = [];
  if (env?.C2C_CLI_LOCK_PATH) paths.push(resolve(env.C2C_CLI_LOCK_PATH));
  paths.push(cliLockPath(env, work));
  paths.push(cliLockFallbackPath(env, work));
  if (work) paths.push(cliLockFallbackPath(env, undefined));
  return [...new Set(paths)];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function readRaw(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function parseHolder(text: string): CliLockHolder | undefined {
  try {
    return JSON.parse(text) as CliLockHolder;
  } catch {
    return undefined;
  }
}

function ageMs(path: string, now: number): number {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function holderText(h?: CliLockHolder): string {
  if (!h) return 'an unreadable holder';
  return `pid ${h.pid ?? '?'} on ${h.host ?? '?'} since ${h.started ?? '?'}`;
}

/**
 * One claim attempt: create the lock exclusively, or reclaim a stale one.
 */
function tryClaim(
  path: string,
  holder: CliLockHolder,
  staleMs: number,
  now: number,
): { ok: true } | { ok: false; holder?: CliLockHolder } {
  const body = `${JSON.stringify(holder)}\n`;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (UNWRITABLE_CODES.has(code ?? '')) throw err;
  }

  try {
    const fd = openSync(path, 'wx', 0o600);
    writeSync(fd, body);
    closeSync(fd);
    return { ok: true };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
  }

  const seen = readRaw(path);
  if (seen === undefined) return { ok: false };

  const existing = parseHolder(seen);
  const age = ageMs(path, now);
  const pid = typeof existing?.pid === 'number'
    ? existing.pid
    : /^[0-9]+$/.test(String(existing?.pid ?? ''))
      ? Number(existing?.pid)
      : undefined;

  // Remote host lock: never treat as stale.
  if (existing?.host !== undefined && existing.host !== holder.host) {
    return { ok: false, holder: existing };
  }

  const live = existing?.host === holder.host && pid !== undefined && pidAlive(pid);
  if (live && age <= staleMs) {
    return { ok: false, holder: existing };
  }
  if (!existing && age <= staleMs) {
    return { ok: false, holder: existing };
  }

  // Stale lock: move aside
  const aside = `${path}.stale.${holder.nonce}`;
  try {
    renameSync(path, aside);
  } catch (move: unknown) {
    if ((move as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: false };
    throw move;
  }

  if (readRaw(aside) !== seen) {
    try {
      linkSync(aside, path);
    } catch {}
    try {
      unlinkSync(aside);
    } catch {}
    return { ok: false };
  }

  try {
    unlinkSync(aside);
  } catch {}

  try {
    const fd = openSync(path, 'wx', 0o600);
    writeSync(fd, body);
    closeSync(fd);
    return { ok: true };
  } catch (retry: unknown) {
    if ((retry as NodeJS.ErrnoException)?.code === 'EEXIST') return { ok: false };
    throw retry;
  }
}

/**
 * Wait for and take the credential's CLI lock. Resolves to `{ path, release }`.
 * Throws CliLockTimeout naming the holder when waitMs runs out.
 */
export async function acquireCliLock(path: string, opts: CliLockOptions = {}): Promise<CliLockHandle> {
  const o = { ...CLI_LOCK_DEFAULTS, ...opts };
  const getNow = o.now ?? Date.now;
  const holder: CliLockHolder = {
    version: 1,
    purpose: 'catalyst-cli',
    pid: process.pid,
    host: hostname(),
    started: new Date(getNow()).toISOString(),
    nonce: randomBytes(8).toString('hex'),
  };
  const start = getNow();
  const deadline = start + o.waitMs;
  let last: CliLockHolder | undefined;

  for (;;) {
    const claim = tryClaim(path, holder, o.staleMs, getNow());
    if (claim.ok) break;
    last = claim.holder ?? last;
    if (getNow() >= deadline) {
      throw new CliLockTimeout(
        `timed out after ${Math.round(o.waitMs / 1000)}s waiting for the Catalyst CLI lock ${path} (held by ${holderText(last)})`,
      );
    }
    await (o.sleep ? o.sleep(o.pollMs) : delay(o.pollMs));
  }

  const owned = () => {
    const content = readRaw(path);
    if (!content) return false;
    const parsed = parseHolder(content);
    return parsed?.nonce === holder.nonce;
  };

  const beat = setInterval(() => {
    try {
      if (owned()) {
        const now = new Date();
        utimesSync(path, now, now);
      }
    } catch {
      // a missed beat only ages the lock
    }
  }, o.heartbeatMs);
  beat.unref?.();

  return {
    path,
    release() {
      clearInterval(beat);
      try {
        if (owned()) {
          unlinkSync(path);
        }
      } catch {}
    },
  };
}

/** In-process lock tracker to allow re-entrant locking within the same process. */
const heldInProcess = new Map<string, { depth: number; handle: CliLockHandle }>();

/**
 * Execute `fn` under the #140 Catalyst CLI lock for the active credential.
 * Automatically selects the appropriate lock path, supports in-process
 * re-entrancy, and gracefully falls back if a directory is read-only.
 */
export async function withCliLock<T>(
  env: NodeJS.ProcessEnv | undefined,
  fn: () => Promise<T>,
  opts: CliLockOptions = {},
): Promise<T> {
  if (env?.C2C_NO_CLI_LOCK === '1') {
    return await fn();
  }

  const candidatePaths = cliLockPaths(env, opts.work);

  // Check if current process already holds a lock on any of the candidate paths
  for (const candidate of candidatePaths) {
    if (heldInProcess.has(candidate)) {
      const entry = heldInProcess.get(candidate)!;
      entry.depth++;
      try {
        return await fn();
      } finally {
        entry.depth--;
        if (entry.depth === 0) {
          heldInProcess.delete(candidate);
          entry.handle.release();
        }
      }
    }
  }

  let handle: CliLockHandle | null = null;
  let chosenPath = '';

  for (let i = 0; i < candidatePaths.length; i++) {
    const candidate = candidatePaths[i];
    try {
      handle = await acquireCliLock(candidate, opts);
      chosenPath = candidate;
      break;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (UNWRITABLE_CODES.has(code ?? '') && i + 1 < candidatePaths.length) {
        continue;
      }
      throw err;
    }
  }

  if (!handle) {
    throw new Error('failed to acquire Catalyst CLI lock: no writable lock path found');
  }

  heldInProcess.set(chosenPath, { depth: 1, handle });
  try {
    return await fn();
  } finally {
    const entry = heldInProcess.get(chosenPath);
    if (entry) {
      entry.depth--;
      if (entry.depth === 0) {
        heldInProcess.delete(chosenPath);
        entry.handle.release();
      }
    }
  }
}
