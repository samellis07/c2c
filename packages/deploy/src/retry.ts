/**
 * Bounded retry for transient Catalyst failures: HTTP 429 and 5xx.
 * REST calls retry through a re-read so a write that may have landed is
 * never re-sent blind — the re-read either proves the effect is already
 * there or narrows the next request to what is still missing.
 * Spawned CLI commands retry only when the output names a transient
 * status (429 or 5xx). Backoff is exponential with jitter; a Retry-After
 * hint from the server waits at least that long, capped.
 */
import type { RestCall, RestFn, RestResult } from './tables.js';

export interface RetryOptions {
  /** Total attempts, first call included. Default 4. */
  tries?: number;
  /** First wait in ms. Default 400. */
  baseDelayMs?: number;
  /** Longest exponential wait in ms. Default 8000. */
  maxDelayMs?: number;
  /** Waits between attempts. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0,1). Defaults to Math.random. */
  random?: () => number;
  /** Receives one line per retry. */
  log?: (line: string) => void;
}

const TRIES = 4;
const BASE_MS = 400;
const MAX_MS = 8000;
/** A Retry-After hint beyond this waits no longer: the hint is honoured, the run is not stalled. */
const RETRY_AFTER_CAP_MS = 30_000;

export function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// CSI and OSC escape sequences, as a CLI prints them for colour and links.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** zcatalyst-cli prints "HTTP Error: <code>, <message>" and relays the body error_code. */
export function transientCatalystOutput(output: string): boolean {
  const text = output.replace(ANSI, '');
  return (
    /HTTP Error:\s*(?:429|5\d\d)\b/i.test(text) ||
    /"error_code"\s*:\s*"(?:INTERNAL_SERVER_ERROR|RATE_LIMIT|THROTTLED)"/i.test(text) ||
    /\b(?:429|5\d\d)\b[^\n]*\btry again\b/i.test(text) ||
    /\btoo many requests\b|\brate[\s-]?limit(?:ed|ing)?\b/i.test(text)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** attempt is the 1-based retry index (1 = first retry). Jittered to 50–150% of the slot. */
export function retryDelayMs(attempt: number, retryAfterMs: number | undefined, opts: RetryOptions = {}): number {
  const base = opts.baseDelayMs ?? BASE_MS;
  const cap = opts.maxDelayMs ?? MAX_MS;
  const slot = Math.min(cap, base * 2 ** (attempt - 1));
  const jitter = (opts.random ?? Math.random)() * slot;
  const backoff = Math.min(cap, Math.round(slot / 2 + jitter));
  return Math.max(backoff, Math.min(retryAfterMs ?? 0, RETRY_AFTER_CAP_MS));
}

export function logRetry(opts: RetryOptions, retry: number, tries: number, describe: string, status: number | string, delay: number): void {
  opts.log?.(`retry ${retry}/${tries - 1} in ${delay}ms: ${describe} (${status})`);
}

/**
 * What a re-read can decide before a retry of a non-idempotent call:
 * the effect already landed (`applied`), a — possibly narrowed — call to
 * send instead of the original (`resend`), or give up with the recorded
 * failure (`abort`). Undefined means the re-read proved nothing, so the
 * next attempt re-reads instead of re-sending a write blind.
 */
export type ReRead<T> = { applied: T } | { resend: RestCall } | { abort: true } | undefined;

export interface RestRetry<T> {
  /** The last response received. With `applied` set it is the failing response that prompted the re-read. */
  result: RestResult;
  /** Set when a re-read proved the write already landed; `result` is then the failure, not a success. */
  applied?: T;
}

/**
 * Call `rest` until the result is not 429/5xx or `tries` attempts ran out.
 * GETs pass no reRead and retry as-is. Writes pass a reRead that runs after
 * the backoff — a write that landed late is only visible then — and decides
 * what happens next: applied ends the loop, resend sends a (narrowed) call,
 * abort returns the original failure, and an indecisive re-read waits and
 * reads again rather than re-sending blind. The final result is returned,
 * failure and all — callers report it the way they did before.
 */
export async function restWithRetry<T = never>(
  rest: RestFn,
  call: RestCall,
  opts: RetryOptions & { reRead?: (failure: RestResult, attempt: number) => Promise<ReRead<T>> } = {},
): Promise<RestRetry<T>> {
  const tries = Math.max(1, Math.floor(opts.tries ?? TRIES));
  let current = call;
  let result = await rest(current);
  for (let retry = 1; retry < tries && retryableStatus(result.status); retry++) {
    const delay = retryDelayMs(retry, result.retryAfterMs, opts);
    logRetry(opts, retry, tries, `${call.method} ${call.path}`, `HTTP ${result.status}`, delay);
    await (opts.sleep ?? sleep)(delay);
    if (opts.reRead) {
      const seen = await opts.reRead(result, retry);
      if (seen && 'applied' in seen) return { result, applied: seen.applied };
      if (seen && 'abort' in seen) return { result };
      if (seen && 'resend' in seen) current = seen.resend;
      else continue;
    }
    result = await rest(current);
  }
  return { result };
}

export interface SpawnedResult {
  code: number;
  stdout: string;
  stderr: string;
  /** beforeRetry proved the step's effect already landed; the command was not re-run. */
  skipped?: boolean;
}

/**
 * Re-run a CLI command whose output names a transient Catalyst status.
 * beforeRetry runs after each backoff — a re-read can mark the step done
 * (return a result to stop retrying, e.g. a skipped success) or return the
 * failure unchanged to stop without another spawn.
 */
export async function spawnWithRetry<T extends SpawnedResult>(
  invoke: () => Promise<T>,
  describe: string,
  opts: RetryOptions & { beforeRetry?: (failure: T, attempt: number) => Promise<T | void> } = {},
): Promise<T> {
  const tries = Math.max(1, Math.floor(opts.tries ?? TRIES));
  let result = await invoke();
  for (let retry = 1; retry < tries && result.code !== 0 && transientCatalystOutput(result.stdout + result.stderr); retry++) {
    const delay = retryDelayMs(retry, undefined, opts);
    logRetry(opts, retry, tries, describe, `exit ${result.code}`, delay);
    await (opts.sleep ?? sleep)(delay);
    const done = await opts.beforeRetry?.(result, retry);
    if (done) return done;
    result = await invoke();
  }
  return result;
}

/**
 * The hourly token-expiry edge: a call that lands just as the ~1 h access
 * token lapses answers 401 {"error_code":"INVALID_TOKEN","message":"invalid
 * oauth token"}, and the same call with a newer token succeeds. Only a
 * read-only call (a GET, or a CLI read such as whoami or project:list) is
 * re-sent, once, and only when a newer token than the one that failed is at
 * hand. A write is never re-sent, and a second 401 is a real failure.
 */
export const TOKEN_RETRY_NOTE = 'retried once with a newer token';
/** The line for a 401 INVALID_TOKEN that found no newer token: the read fails as it is. */
export const TOKEN_NOT_RETRIED = 'not retried: no newer token in the CLI credential store';
/** The line for a read whose one retry met 401 INVALID_TOKEN again. */
export const TOKEN_STILL_EXPIRED = 'still 401 INVALID_TOKEN after one retry';

/** 401 whose error_code is INVALID_TOKEN (top level or under data). Other 401 codes are real auth failures. */
export function invalidTokenAnswer(status: number, body: unknown): boolean {
  if (status !== 401 || !body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : undefined;
  return record.error_code === 'INVALID_TOKEN' || data?.error_code === 'INVALID_TOKEN';
}

/** CLI output that relays the expired-token answer: a 401 carrying INVALID_TOKEN. */
export function invalidTokenOutput(output: string): boolean {
  const text = output.replace(ANSI, '');
  return /\b401\b/.test(text) && /"error_code"\s*:\s*"INVALID_TOKEN"|\bINVALID_TOKEN\b|\binvalid oauth token\b/i.test(text);
}

/**
 * Run a read once; when `expired` says the token lapsed under it, ask
 * `renew` for a newer token and, only when it has one, run the same read
 * once more. `renew` answers false (or throws) when nothing newer than the
 * failed token is at hand: the first answer is returned as it is.
 * `readOnly: false` never renews and never retries. Every outcome after a
 * 401 INVALID_TOKEN is logged as one line; the retry line is logged before
 * the second attempt runs.
 */
export async function readWithNewerToken<T>(opts: {
  readOnly: boolean;
  attempt: () => Promise<T>;
  expired: (result: T) => boolean;
  renew: () => Promise<boolean>;
  describe: string;
  log?: (line: string) => void;
}): Promise<T> {
  const first = await opts.attempt();
  if (!opts.readOnly || !opts.expired(first)) return first;
  let renewed = false;
  try {
    renewed = await opts.renew();
  } catch {
    renewed = false;
  }
  if (!renewed) {
    opts.log?.(`${opts.describe}: 401 INVALID_TOKEN, ${TOKEN_NOT_RETRIED}`);
    return first;
  }
  opts.log?.(`${opts.describe}: 401 INVALID_TOKEN, ${TOKEN_RETRY_NOTE}`);
  const second = await opts.attempt();
  if (opts.expired(second)) opts.log?.(`${opts.describe}: ${TOKEN_STILL_EXPIRED}`);
  return second;
}
