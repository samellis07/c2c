/**
 * Browser driver for `c2c smoke --in-browser`.
 *
 * The generated app ships a hidden `#/admin/smoke` page that runs the smoke
 * contract with the sign-in the browser already holds. This module attaches
 * to a local browser over the DevTools protocol, opens that page, polls the
 * `[data-smoke-state]` marker until the run reaches a terminal state, and
 * reads back the step table and the `c2c-smoke/1` JSON block.
 *
 * It evaluates read-only expressions. It never reads cookies, storage, or
 * tokens — the session stays inside the browser.
 *
 * `runBrowserSmoke` is transport-agnostic (any SmokeBrowser works); the only
 * concrete transport here is `cdpBrowser`, a minimal WebSocket client over
 * node:net/node:tls so the CLI carries no runtime dependency.
 */
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import type { Duplex } from 'node:stream';

export interface SmokePage {
  evaluate(expression: string): Promise<unknown>;
  /** evaluate, awaiting a promise result (Runtime.evaluate awaitPromise). */
  evaluateAsync?(expression: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface SmokeBrowser {
  open(url: string): Promise<SmokePage>;
}

/** The machine-readable verdict — what a runner maps to a blocker. */
export type BrowserSmokeState = 'passed' | 'denied' | 'not-signed-in' | 'failed';

export interface BrowserSmokeResult {
  ok: boolean;
  /** passed, denied, not-signed-in, or failed — independent of the page's painted markers. */
  state: BrowserSmokeState;
  lines: string[];
  /** The c2c-smoke/1 block, parsed. Absent when the page never produced one. */
  json?: unknown;
}

const STATE_EXPR =
  "(function(){var el=document.querySelector('[data-smoke-state]');return el?el.getAttribute('data-smoke-state'):'';})()";
const ORIGIN_EXPR = "(function(){try{return String(window.location&&window.location.origin||'');}catch(e){return '';}})()";
const LINES_EXPR =
  "(function(){return Array.prototype.map.call(document.querySelectorAll('[data-smoke-steps] td'),function(td){return td.textContent||'';});})()";
const JSON_EXPR = "(function(){var el=document.getElementById('c2c-smoke-json');return el?(el.textContent||''):'';})()";

const TERMINAL = new Set(['done', 'failed', 'denied', 'unavailable', 'not-signed-in']);
const POLL_MS = 1500;

function smokePageUrl(appUrl: string): string {
  const base = appUrl.replace(/\/+$/, '');
  return `${base}#/admin/smoke`;
}

async function readLines(page: SmokePage): Promise<string[]> {
  const value = await page.evaluate(LINES_EXPR);
  if (!Array.isArray(value)) return [];
  return value.filter((line): line is string => typeof line === 'string' && line.length > 0);
}

async function readJson(page: SmokePage): Promise<unknown> {
  const text = String((await page.evaluate(JSON_EXPR)) ?? '').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A navigated tab reports a real origin; 'null'/'' is about:blank mid-navigation, never content to trust. */
function offOrigin(pageOrigin: string, origin: string): boolean {
  return pageOrigin !== '' && pageOrigin !== 'null' && pageOrigin !== origin;
}

/**
 * The pass verdict, from the CLI's own checks on the c2c-smoke/1 block — never
 * from the painted marker alone. A page that says "done" without a consistent
 * JSON block, or a run that exercised nothing, is a failure, not a pass.
 */
export function verdict(json: unknown, expectSubmits: number): { ok: true } | { ok: false; reason: string } {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'no c2c-smoke/1 JSON block' };
  const block = json as Record<string, unknown>;
  if (block.version !== 'c2c-smoke/1') return { ok: false, reason: 'the JSON block is not version c2c-smoke/1' };
  if (block.ok !== true) return { ok: false, reason: 'the run reported failure' };
  const { created, deleted, left, steps, exercised } = block as Record<string, unknown>;
  if (!Number.isSafeInteger(created) || !Number.isSafeInteger(deleted) || !Number.isSafeInteger(left)) {
    return { ok: false, reason: 'the JSON block counts are not integers' };
  }
  if (created !== deleted || left !== (created as number) - (deleted as number)) {
    return { ok: false, reason: 'the JSON block counts do not add up' };
  }
  if (!Array.isArray(steps) || !steps.length) return { ok: false, reason: 'the JSON block lists no steps' };
  for (const step of steps) {
    if (!step || typeof step !== 'object' || typeof (step as { label?: unknown }).label !== 'string' || (step as { ok?: unknown }).ok === false) {
      return { ok: false, reason: 'a step in the JSON block is not ok' };
    }
  }
  if (typeof exercised !== 'number' || exercised < 1) return { ok: false, reason: 'the run exercised nothing' };
  if (expectSubmits > 0 && (created as number) < 1) {
    return { ok: false, reason: `the plan had ${expectSubmits} submit(s) but the run created nothing` };
  }
  return { ok: true };
}

/**
 * Poll the smoke page to a terminal state; collect the step lines and the JSON
 * block. The tab is re-checked against the app origin on every poll and again
 * before any marker is trusted: a redirect off-origin (a sign-in hop, a
 * hijacked domain, a wrong --url) is refused on sight as 'denied: off-origin',
 * not waited out.
 */
export async function runBrowserSmoke(opts: {
  browser: SmokeBrowser;
  appUrl: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** What the plan expects — a done verdict with fewer is never ok. */
  expect?: { submits?: number };
}): Promise<BrowserSmokeResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? (() => {});
  const expectSubmits = opts.expect?.submits ?? 0;
  const url = new URL(opts.appUrl);
  if (!/^https?:$/.test(url.protocol)) throw new Error('smoke url must be http or https');
  // A --url fragment would eat the appended #/admin/smoke route.
  url.hash = '';
  const origin = url.origin;
  const page = await opts.browser.open(smokePageUrl(url.toString()));
  const denied = (lines: string[], detail: string): BrowserSmokeResult => ({
    ok: false,
    state: 'denied',
    lines: [...lines, `denied: off-origin — ${detail}`],
  });
  const deadline = Date.now() + timeoutMs;
  let waited = 0;
  let state = '';
  try {
    for (;;) {
      const pageOrigin = String((await page.evaluate(ORIGIN_EXPR)) ?? '');
      if (offOrigin(pageOrigin, origin)) {
        const lines = await readLines(page);
        return denied(lines, `the tab is on ${pageOrigin}, not ${origin}`);
      }
      state = String((await page.evaluate(STATE_EXPR)) ?? '');
      if (TERMINAL.has(state)) {
        // The marker counts only from the app's own origin.
        if (pageOrigin !== origin) {
          const lines = await readLines(page);
          return denied(lines, `the tab is on ${pageOrigin || '(no origin)'}, not ${origin}`);
        }
        break;
      }
      if (Date.now() >= deadline || waited >= timeoutMs) {
        const lines = await readLines(page);
        return { ok: false, state: 'failed', lines: [...lines, `timed out after ${timeoutMs} ms waiting for the smoke page (state: ${state || '?'})`] };
      }
      const wait = Math.min(POLL_MS, Math.max(50, deadline - Date.now()));
      waited += wait;
      await sleep(wait);
    }
    log(`smoke page finished (state: ${state})`);
    const lines = await readLines(page);
    const json = await readJson(page);
    const block = json === undefined ? {} : { json };
    if (state === 'denied') return { ok: false, state: 'denied', lines, ...block };
    if (state === 'not-signed-in') return { ok: false, state: 'not-signed-in', lines, ...block };
    if (state !== 'done') return { ok: false, state: 'failed', lines, ...block };
    const check = verdict(json, expectSubmits);
    if (!check.ok) return { ok: false, state: 'failed', lines: [...lines, `failed: ${check.reason}`], ...block };
    return { ok: true, state: 'passed', lines, ...block };
  } finally {
    await page.close();
  }
}

// ---- owner session: requests made by the page itself -----------------------

export interface PageResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Request headers a page fetch never forwards: the browser supplies its own session. */
const SESSION_HEADERS = new Set(['cookie', 'authorization', 'x-zcsrf-token']);

/**
 * A fetch that runs INSIDE `page` with `credentials: 'include'`, so the
 * browser attaches the session it already holds for the page's origin. Only
 * the reply status and body text come back. Nothing here reads cookies,
 * storage or tokens, and a caller-supplied cookie or authorization header is
 * dropped rather than forwarded. Bodies are strings (the smoke contract sends
 * JSON).
 */
export function pageFetch(page: SmokePage): (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<PageResponse> {
  return async (url, init) => {
    if (!page.evaluateAsync) throw new Error('the browser page cannot run requests');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init?.headers ?? {})) {
      if (!SESSION_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
    const request = {
      method: init?.method ?? 'GET',
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      credentials: 'include',
    };
    const expression = `(async function(){var r=await fetch(${JSON.stringify(url)},${JSON.stringify(request)});return {status:r.status,body:await r.text()};})()`;
    const value = (await page.evaluateAsync(expression)) as { status?: unknown; body?: unknown } | undefined;
    const status = value && typeof value.status === 'number' ? value.status : 0;
    const body = value && typeof value.body === 'string' ? value.body : '';
    return { status, headers: { get: () => null }, text: async () => body };
  };
}

/**
 * Open a tab on `url` and wait until the document is on that URL's origin.
 * A tab that lands elsewhere (a sign-in redirect) or never loads resolves to
 * `undefined` after closing the tab.
 */
export async function openOnOrigin(
  browser: SmokeBrowser,
  url: string,
  opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SmokePage | undefined> {
  const origin = new URL(url).origin;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const page = await browser.open(url);
  for (let waited = 0; ; waited += 250) {
    const at = String((await page.evaluate(ORIGIN_EXPR)) ?? '');
    if (at === origin) return page;
    if (waited >= timeoutMs) break;
    await sleep(250);
  }
  await page.close();
  return undefined;
}

// ---- DevTools protocol over a hand-rolled websocket ------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** A hostile endpoint cannot grow these buffers past the caps. */
const MAX_HTTP_HEAD = 64 * 1024;
const MAX_WS_MESSAGE = 8 * 1024 * 1024;

interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  rest: Buffer;
}

/** Decode one frame from the head of `buffer`; undefined until a whole frame is in. */
function decodeWsFrame(buffer: Buffer): WsFrame | undefined {
  if (buffer.length < 2) return undefined;
  const fin = !!(buffer[0]! & 0x80);
  const opcode = buffer[0]! & 0x0f;
  const masked = !!(buffer[1]! & 0x80);
  let len = buffer[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return undefined;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return undefined;
    len = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (len > MAX_WS_MESSAGE) throw new Error('browser sent an oversized websocket frame');
  const maskLen = masked ? 4 : 0;
  if (buffer.length < offset + maskLen + len) return undefined;
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  const payload = Buffer.from(buffer.subarray(offset + maskLen, offset + maskLen + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
  return { fin, opcode, payload, rest: buffer.subarray(offset + maskLen + len) };
}

/** A client frame is always masked (RFC 6455 §5.3). */
function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const len = payload.length;
  let head: Buffer;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = 0x80 | len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i]! ^= mask[i % 4]!;
  return Buffer.concat([head, mask, masked]);
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** One browser-level CDP connection: request/response by id, events ignored. */
class CdpSocket {
  private readonly socket: Duplex;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  private constructor(socket: Duplex, leftover: Buffer) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.failAll(new Error('browser connection failed')));
    socket.on('close', () => this.failAll(new Error('browser connection closed')));
    if (leftover.length) this.onData(leftover);
  }

  static async open(wsUrl: string): Promise<CdpSocket> {
    const url = new URL(wsUrl);
    const secure = url.protocol === 'wss:';
    if (!secure && url.protocol !== 'ws:') throw new Error('browser websocket must be ws or wss');
    const host = url.hostname;
    const port = url.port ? Number(url.port) : secure ? 443 : 80;
    const socket = secure
      ? connectTls({ host, port, servername: host })
      : connectTcp({ host, port });
    await new Promise<void>((resolve, reject) => {
      socket.once(secure ? 'secureConnect' : 'connect', () => resolve());
      socket.once('error', (err: Error) => reject(err));
    });
    const key = randomBytes(16).toString('base64');
    const path = `${url.pathname || '/'}${url.search}`;
    const headPromise = readHttpHead(socket);
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    const { head, rest } = await headPromise;
    if (!/^HTTP\/1\.1 101/i.test(head)) {
      socket.destroy();
      throw new Error('browser did not accept the websocket upgrade');
    }
    return new CdpSocket(socket, rest);
  }

  async call(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (this.closed) throw new Error('browser connection is closed');
    const id = ++this.nextId;
    const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(encodeWsFrame(0x1, Buffer.from(message, 'utf8')));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(encodeWsFrame(0x8, Buffer.alloc(0)));
    } catch {
      /* the socket may already be gone */
    }
    this.socket.destroy();
    this.failAll(new Error('browser connection closed'));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      let frame: WsFrame | undefined;
      try {
        frame = decodeWsFrame(this.buffer);
      } catch (err) {
        this.socket.destroy();
        this.failAll(err instanceof Error ? err : new Error('browser protocol error'));
        return;
      }
      if (!frame) break;
      this.buffer = frame.rest;
      this.onFrame(frame);
    }
  }

  private onFrame(frame: WsFrame): void {
    if (frame.opcode === 0x9) {
      this.socket.write(encodeWsFrame(0xa, frame.payload));
      return;
    }
    if (frame.opcode === 0x8) {
      this.failAll(new Error('browser closed the connection'));
      return;
    }
    if (frame.opcode === 0x0 || frame.opcode === 0x1) {
      this.fragments.push(frame.payload);
      this.fragmentBytes += frame.payload.length;
      if (this.fragmentBytes > MAX_WS_MESSAGE) {
        this.socket.destroy();
        this.failAll(new Error('browser sent an oversized websocket message'));
        return;
      }
      if (!frame.fin) return;
      const payload = Buffer.concat(this.fragments);
      this.fragments = [];
      this.fragmentBytes = 0;
      let message: { id?: unknown; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(payload.toString('utf8')) as typeof message;
      } catch {
        return;
      }
      if (!message || typeof message.id !== 'number') return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || 'browser protocol error'));
      else waiter.resolve(message.result);
    }
  }

  private failAll(err: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }
}

/** Read through the CRLFCRLF that ends the upgrade response. */
function readHttpHead(socket: Duplex): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffer.length > MAX_HTTP_HEAD) {
          socket.off('data', onData);
          socket.destroy();
          reject(new Error('the websocket upgrade answer exceeded 64 KiB'));
        }
        return;
      }
      socket.off('data', onData);
      resolve({ head: buffer.subarray(0, end).toString('utf8'), rest: buffer.subarray(end + 4) });
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('browser closed before the websocket upgrade')));
  });
}

function loopbackHttp(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('browser endpoint is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('browser endpoint must be http');
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    // Driving a remote debug port runs script in someone else's browser.
    throw new Error('browser endpoint must be loopback — remote debugging gives script access to that browser');
  }
  return endpoint.replace(/\/+$/, '');
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]']);

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || address.startsWith('127.') || /^::ffff:127\./i.test(address);
}

/**
 * The endpoint-supplied webSocketDebuggerUrl, checked before anything is
 * dialled: ws/wss on a loopback host — `localhost` only when every resolver
 * answer is loopback — and on the same port as the checked endpoint. A
 * process that squat-took the debug port cannot aim the client at someone
 * else's browser.
 */
async function assertLoopbackDebugger(wsUrl: string, endpoint: URL): Promise<URL> {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    throw new Error('the endpoint returned a websocket url that is not a URL');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('browser websocket must be ws or wss');
  // The handshake has no way to send userinfo — refuse rather than drop it.
  if (url.username || url.password) throw new Error('browser websocket must not carry credentials');
  const host = url.hostname;
  if (!LOOPBACK_HOSTS.has(host)) {
    if (host !== 'localhost') {
      throw new Error(`browser websocket must be loopback (got ${host}) — remote debugging gives script access to that browser`);
    }
    let answers: { address: string }[] = [];
    try {
      answers = await lookup('localhost', { all: true });
    } catch {
      answers = [];
    }
    if (!answers.length || !answers.every((entry) => isLoopbackAddress(entry.address))) {
      throw new Error('browser websocket must be loopback — localhost does not resolve to loopback only');
    }
  }
  const want = endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80;
  const got = url.port ? Number(url.port) : url.protocol === 'wss:' ? 443 : 80;
  if (got !== want) throw new Error(`browser websocket must be on the checked endpoint's port ${want} (got ${got})`);
  return url;
}

/**
 * A DevTools endpoint (`--browser-cdp`, default http://127.0.0.1:9222). Each
 * open() creates a tab target and returns a page whose evaluate() is
 * Runtime.evaluate with returnByValue — strings and plain JSON only.
 */
export function cdpBrowser(endpoint: string, opts: { fetch?: typeof fetch } = {}): SmokeBrowser {
  const base = loopbackHttp(endpoint);
  const endpointUrl = new URL(base);
  const call = opts.fetch ?? globalThis.fetch;
  if (typeof call !== 'function') throw new Error('fetch is not available');
  return {
    async open(url: string): Promise<SmokePage> {
      const res = await call(`${base}/json/version`);
      if (!res.ok) throw new Error(`browser answered /json/version with ${res.status}`);
      const version = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (typeof version.webSocketDebuggerUrl !== 'string' || !version.webSocketDebuggerUrl) {
        throw new Error('the endpoint is not a DevTools browser (no webSocketDebuggerUrl)');
      }
      const cdp = await CdpSocket.open((await assertLoopbackDebugger(version.webSocketDebuggerUrl, endpointUrl)).toString());
      const created = (await cdp.call('Target.createTarget', { url })) as { targetId?: string };
      if (!created || typeof created.targetId !== 'string') throw new Error('the browser did not open a tab');
      const attached = (await cdp.call('Target.attachToTarget', { targetId: created.targetId, flatten: true })) as {
        sessionId?: string;
      };
      if (!attached || typeof attached.sessionId !== 'string') throw new Error('the browser did not attach to the tab');
      const { targetId } = created;
      const { sessionId } = attached;
      return {
        async evaluate(expression: string): Promise<unknown> {
          const out = (await cdp.call('Runtime.evaluate', { expression, returnByValue: true }, sessionId)) as {
            result?: { value?: unknown };
          };
          return out && out.result ? out.result.value : undefined;
        },
        async evaluateAsync(expression: string): Promise<unknown> {
          const out = (await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)) as {
            result?: { value?: unknown };
          };
          return out && out.result ? out.result.value : undefined;
        },
        async close(): Promise<void> {
          try {
            await cdp.call('Target.closeTarget', { targetId });
          } catch {
            /* the tab may already be gone */
          }
          cdp.close();
        },
      };
    },
  };
}
