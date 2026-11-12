/**
 * `invokeurl` transport: one HTTP call with a per-attempt timeout, an overall
 * deadline under the 30 s Function budget, retry with backoff, and an
 * idempotency key.
 *
 * - 429 and 503 are retried for every method (the request was not processed).
 *   Retry-After is a floor and is never shortened; a wait past `maxWaitMs`, or
 *   one that would end after the deadline, fails at once without sleeping.
 * - 502, 504, a network error and a timed-out attempt are retried only when the
 *   call is safe to repeat: GET/HEAD/OPTIONS/PUT/DELETE, or a POST/PATCH whose
 *   script set its own `Idempotency-Key` header (the script vouches the server
 *   honours it). A key c2c adds itself does not make a POST retryable.
 * - Backoff is `baseDelayMs * 2^attempt`, capped at `maxDelayMs`. No jitter, so
 *   tests and transcripts are repeatable.
 * - With `idempotency`, a write (POST/PUT/PATCH/DELETE) without the header gets
 *   one key, the same on every retry of that call. With `idempotency.seed` the
 *   key is derived from seed, call ordinal, method, URL and body; without a seed
 *   it is random per call.
 * - Redirects are never followed by the transport (`redirect: 'manual'`). By
 *   default a 3xx is the reply. With `followRedirect`, up to
 *   {@link MAX_REDIRECTS} hops are followed and each `Location` is passed to it
 *   first; it throws to refuse the hop before any request. 301/302/303 become a
 *   bodiless GET; a cross-origin hop also drops every header (auth, custom,
 *   idempotency key), and a cross-origin 307/308 of a write is not followed.
 *
 * Generation is not involved: this runs in the deployed function.
 */
import { createHash, randomUUID } from 'node:crypto';
import { redactUrlText } from './redact.js';
import type { RestReply, RestRequest } from './zoho-adapters.js';

export const INVOKE_URL_DEFAULTS = {
  timeoutMs: 10_000,
  deadlineMs: 25_000,
  maxRetries: 4,
  baseDelayMs: 200,
  maxDelayMs: 8_000,
  maxWaitMs: 20_000,
};

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export const MAX_REDIRECTS = 3;

export type InvokeUrlFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'manual' },
) => Promise<{
  status: number;
  headers?: { get(name: string): string | null; forEach?(callback: (value: string, name: string) => void): void };
  text(): Promise<string>;
}>;

export interface InvokeUrlOptions {
  /** Defaults to global fetch. */
  fetch?: InvokeUrlFetch;
  /** Test hook. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Test hook for the deadline. Defaults to Date.now. */
  now?: () => number;
  timeoutMs?: number;
  deadlineMs?: number;
  maxRetries?: number;
  maxWaitMs?: number;
  /** Attach an idempotency key to writes. `seed` makes the key derivable; `next` numbers calls. */
  idempotency?: IdempotencyKeys | null;
  /** Vets each redirect target (absolute URL) before it is fetched; throw to refuse. Without it a 3xx is returned. */
  followRedirect?: ((url: string) => void) | null;
}

export class InvokeUrlError extends Error {
  readonly code = 'INVOKE_URL_FAILED';
  /** `rate-limit`, `timeout`, `network`, or `fetch` (no fetch available). */
  readonly reason: 'rate-limit' | 'timeout' | 'network' | 'fetch';
  readonly attempts: number;
  constructor(reason: InvokeUrlError['reason'], message: string, attempts: number) {
    super(message);
    this.name = 'InvokeUrlError';
    this.reason = reason;
    this.attempts = attempts;
  }
}

/** Per-runtime key source: calls are numbered in the order they are made. */
export interface IdempotencyKeys {
  seed?: string | null;
  next(): number;
}

export function idempotencyKeys(seed?: string | null): IdempotencyKeys {
  let ordinal = 0;
  return { seed: seed ?? null, next: () => (ordinal += 1) };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

type Hop = { method: string; headers: Record<string, string>; body?: string };

/** A refusal from `followRedirect`: rethrown as is, never retried as a network error. */
class HopRefused {
  constructor(readonly error: unknown) {}
}

/** The next request for a redirect, or null when it is not followed. */
function redirectHop(from: string, location: string, status: number, hop: Hop): { url: string; init: Hop } | null {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return null;
  }
  const crossOrigin = next.origin !== new URL(from).origin;
  const read = hop.method === 'GET' || hop.method === 'HEAD';
  const rewrite = !read && status !== 307 && status !== 308;
  if (crossOrigin && !read && !rewrite) return null;
  if (crossOrigin) return { url: next.href, init: { method: rewrite ? 'GET' : hop.method, headers: {} } };
  if (!rewrite) return { url: next.href, init: hop };
  const headers = Object.fromEntries(Object.entries(hop.headers).filter(([k]) => !/^content-/i.test(k)));
  return { url: next.href, init: { method: 'GET', headers } };
}

function headerName(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === lower) return key;
  return null;
}

/** The key a write is sent with, or null for a read or when keys are off. A script-set header is kept. */
export function idempotencyKeyFor(request: RestRequest, keys: IdempotencyKeys | null | undefined): string | null {
  const own = headerName(request.headers, IDEMPOTENCY_HEADER);
  if (own) return request.headers[own];
  if (!keys || !WRITE_METHODS.has(request.method)) return null;
  const ordinal = keys.next();
  if (!keys.seed) return `c2c-${randomUUID()}`;
  const digest = createHash('sha256').update([keys.seed, String(ordinal), request.method, request.url, request.body ?? ''].join('\n')).digest('hex');
  return `c2c-${digest.slice(0, 32)}`;
}

/** Retry-After in milliseconds (delta-seconds or an HTTP date), or -1 when absent or unreadable. */
export function retryAfterMs(raw: string | null | undefined, nowMs = Date.now()): number {
  if (!raw) return -1;
  const value = raw.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : -1;
}

function parseBody(raw: string, parse: (raw: string) => unknown): unknown {
  try {
    return parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Send `request` (already authorised) and return the last reply. Throws
 * {@link InvokeUrlError} only when no reply can be returned: a Retry-After past
 * the limit, or a timeout / network error on the final attempt.
 */
export async function invokeUrl(request: RestRequest, options: InvokeUrlOptions = {}, parse: (raw: string) => unknown = JSON.parse): Promise<RestReply> {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as InvokeUrlFetch | undefined);
  if (!doFetch) throw new InvokeUrlError('fetch', 'no fetch available', 0);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? INVOKE_URL_DEFAULTS.timeoutMs;
  const deadlineMs = options.deadlineMs ?? INVOKE_URL_DEFAULTS.deadlineMs;
  const maxRetries = options.maxRetries ?? INVOKE_URL_DEFAULTS.maxRetries;
  const maxWaitMs = options.maxWaitMs ?? INVOKE_URL_DEFAULTS.maxWaitMs;
  const started = now();
  const ownKey = headerName(request.headers, IDEMPOTENCY_HEADER) !== null;
  const key = idempotencyKeyFor(request, options.idempotency);
  const headers = key && !ownKey ? { ...request.headers, [IDEMPOTENCY_HEADER]: key } : request.headers;
  const repeatable = SAFE_METHODS.has(request.method) || ownKey;
  const init: Hop = { method: request.method, headers, ...(request.body !== undefined ? { body: request.body } : {}) };
  const follow = options.followRedirect ?? null;

  /** One attempt: the request plus any vetted redirect hops, under one abort signal. */
  async function exchange(signal: AbortSignal): Promise<{ res: Awaited<ReturnType<InvokeUrlFetch>>; raw: string }> {
    let url = request.url;
    let hop = init;
    for (let hops = 0; ; hops += 1) {
      const res = await doFetch!(url, { ...hop, redirect: 'manual', signal });
      const raw = await res.text();
      const location = follow && hops < MAX_REDIRECTS && REDIRECTS.has(res.status) ? res.headers?.get?.('location') : null;
      const next = location ? redirectHop(url, location, res.status, hop) : null;
      if (!next) return { res, raw };
      try {
        follow!(next.url);
      } catch (err) {
        throw new HopRefused(err);
      }
      url = next.url;
      hop = next.init;
    }
  }

  for (let attempt = 0; ; attempt += 1) {
    const last = attempt >= maxRetries;
    const left = deadlineMs - (now() - started);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, left)));
    let res: Awaited<ReturnType<InvokeUrlFetch>>;
    let raw: string;
    try {
      ({ res, raw } = await exchange(controller.signal));
    } catch (err) {
      if (err instanceof HopRefused) throw err.error;
      const timedOut = controller.signal.aborted;
      const reason = timedOut ? 'timeout' : 'network';
      // A thrown message can embed the request URL (undici's "…URL that
      // includes credentials" TypeError does); it never leaves unredacted.
      const detail = timedOut ? `no reply within ${Math.min(timeoutMs, left)}ms` : redactUrlText((err as Error)?.message ?? String(err));
      if (last || !repeatable) throw new InvokeUrlError(reason, `invokeurl ${request.method} ${reason}: ${detail}`, attempt + 1);
      await wait(backoff(attempt), attempt);
      continue;
    } finally {
      clearTimeout(timer);
    }
    const reply: RestReply = { status: res.status, body: raw.length ? parseBody(raw, parse) : null };
    const replyHeaders: Record<string, string> = {};
    res.headers?.forEach?.((value, name) => {
      replyHeaders[name.toLowerCase()] = value;
    });
    if (Object.keys(replyHeaders).length) reply.headers = replyHeaders;
    const throttled = res.status === 429 || res.status === 503;
    const transient = res.status === 502 || res.status === 504;
    if (last || !(throttled || (transient && repeatable))) return reply;
    const hinted = throttled ? retryAfterMs(res.headers?.get?.('retry-after') ?? null, now()) : -1;
    if (hinted > maxWaitMs) {
      throw new InvokeUrlError('rate-limit', `rate limited (${res.status}); Retry-After asks for ${Math.ceil(hinted / 1000)}s, more than the ${Math.floor(maxWaitMs / 1000)}s max wait`, attempt + 1);
    }
    await wait(hinted >= 0 ? hinted : backoff(attempt), attempt, res.status);
  }

  function backoff(attempt: number): number {
    return Math.min(INVOKE_URL_DEFAULTS.maxDelayMs, INVOKE_URL_DEFAULTS.baseDelayMs * 2 ** attempt);
  }

  async function wait(ms: number, attempt: number, status?: number): Promise<void> {
    if (now() - started + ms >= deadlineMs) {
      const why = status ? `status ${status}` : 'error';
      throw new InvokeUrlError(status === 429 || status === 503 ? 'rate-limit' : 'timeout', `invokeurl ${request.method}: retry after ${why} would pass the ${deadlineMs}ms deadline`, attempt + 1);
    }
    await sleep(ms);
  }
}
