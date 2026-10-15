/**
 * One admin REST call through the Catalyst CLI's own authenticated client.
 * The credential directory is never opened or printed. The hook refuses any
 * path outside /baas/v1/project/<id> or /baas/v1/project/<id>/.
 * The token and REST results travel over an inherited pipe (fd 3) into
 * memory: no secret or response body ever touches the filesystem, so a
 * SIGKILL between write and cleanup cannot leave a live token on disk.
 * (mkdtempSync dirs are already owner-only; the hook file itself, which
 * carries no secrets, is written mode 0600.)
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseJsonExact } from './json-exact.js';
import { invalidTokenAnswer, readWithNewerToken } from './retry.js';
import { catalystScopeArgs, scrubCatalystEnv } from './scope.js';
import type { RestCall, RestResult } from './tables.js';
import type { ListedProject } from './stuck-import.js';

const HOOK = `const fs = require('fs');
const path = require('path');
const realExit = process.exit.bind(process);
let pending = null;
function run() {
  if (!pending) pending = run0();
  return pending;
}
async function run0() {
  const spec = JSON.parse(process.env.C2C_REQ);
  const allowed = process.env.C2C_ALLOWED_PREFIX || '';
  const exact = allowed.endsWith('/') ? allowed.slice(0, -1) : allowed;
  const write = (line) => fs.writeSync(3, line + '\\n');
  // Numeric Retry-After header (seconds) → ms. An HTTP-date hint is ignored.
  function retryAfterMs(res, err) {
    const headers =
      (res && res.response && res.response.headers) ||
      (res && res.headers) ||
      (err && err.context && err.context.response && err.context.response.headers) ||
      {};
    const raw = headers['retry-after'];
    const secs = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isFinite(secs) && secs >= 0 ? Math.round(secs * 1000) : undefined;
  }
  const exactOnly = process.env.C2C_EXACT_ONLY === '1';
  const method = String(spec.method || 'GET').toUpperCase();
  if (exactOnly) {
    if (method !== 'GET' || !spec.path || spec.path.includes('..') || spec.path !== exact) {
      write('C2C_REFUSED');
      return;
    }
  } else if (!allowed || !spec.path || spec.path.includes('..') || (spec.path !== exact && !spec.path.startsWith(allowed)) || ((spec.path.startsWith('/slate/') || spec.path.startsWith('/browser360/')) && method !== 'GET')) {
    write('C2C_REFUSED');
    return;
  }
  // A one-way tag of the token this call carries (never the token itself):
  // the caller retries a 401 INVALID_TOKEN only when the store holds another.
  let tokenTag;
  try {
    const lib = process.env.C2C_CLI_LIB;
    const API = require(path.join(lib, 'internal', 'api')).default;
    const api = new API({ resolveOnError: true, printError: false, env: 'Development', envId: process.env.C2C_ORG });
    try {
      const credential = require(path.join(lib, 'authentication', 'credential.js')).default;
      const used = await credential.getAccessToken();
      if (used) tokenTag = require('crypto').createHash('sha256').update(String(used)).digest('hex').slice(0, 16);
    } catch (e) {}
    const method = String(spec.method || 'GET').toLowerCase();
    // api.js JSON.parse rounds ids past MAX_SAFE_INTEGER. Record the raw
    // text (the parse result itself is left alone) and keep that text.
    const realParse = JSON.parse;
    let rawBody = null;
    let seq = 0;
    JSON.parse = function (text, reviver) {
      if (typeof text === 'string') {
        const trimmed = text.trim();
        if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
          rawBody = text;
          seq += 1;
        }
      }
      return reviver === undefined ? realParse(text) : realParse(text, reviver);
    };
    const seqBefore = seq;
    const callOpts = {};
    if (spec.body !== undefined) callOpts.body = spec.body;
    if (spec.origin === 'zgraphql') {
      // The Slate deployment read lives on the zgraphql origin, not admin.
      try { callOpts.origin = require(path.join(lib, 'util_modules', 'constants')).ORIGIN.zgraphql; } catch (e) {}
    }
    let res;
    try {
      res = await api[method](spec.path, callOpts);
    } finally {
      JSON.parse = realParse;
    }
    const status = res.statusCode || res.status || 200;
    const captured = seq > seqBefore ? rawBody : null;
    const payload = captured !== null ? { status: status, raw: captured } : { status: status, body: res.body };
    const wait = retryAfterMs(res, null);
    if (wait !== undefined) payload.retryAfterMs = wait;
    if (tokenTag) payload.tokenTag = tokenTag;
    write('C2C_RESULT ' + JSON.stringify(payload));
  } catch (err) {
    const status = err.status || (err.context && err.context.status) || 0;
    const body = (err.context && err.context.body) || (err.original && err.original.body) || { message: err.message };
    const payload = { status, body };
    const wait = retryAfterMs(null, err);
    if (wait !== undefined) payload.retryAfterMs = wait;
    if (tokenTag) payload.tokenTag = tokenTag;
    write('C2C_RESULT ' + JSON.stringify(payload));
  }
}
process.exit = (code) => { run().finally(() => realExit(code)); };
process.on('beforeExit', () => { run().finally(() => realExit(0)); });
`;

export function projectResourcePath(projectId: string): string {
  return `/baas/v1/project/${projectId}`;
}

export function projectPrefix(projectId: string): string {
  return `${projectResourcePath(projectId)}/`;
}

/** Envelope from the CLI hook. `raw` is the response text; integer literals stay strings. */
export function decodeRestPayload(payload: { status?: number; raw?: unknown; body?: unknown; retryAfterMs?: unknown }): {
  status: number;
  body: unknown;
  retryAfterMs?: number;
} {
  const base =
    typeof payload.raw === 'string'
      ? { status: payload.status ?? 0, body: parseJsonExact(payload.raw) }
      : { status: payload.status ?? 0, body: payload.body };
  const wait = typeof payload.retryAfterMs === 'number' && payload.retryAfterMs >= 0 ? Math.round(payload.retryAfterMs) : undefined;
  return wait === undefined ? base : { ...base, retryAfterMs: wait };
}

export function assertProjectPath(projectId: string, path: string): void {
  if (!/^[0-9]+$/.test(projectId)) throw new Error('refusing a path outside the project');
  const exact = projectResourcePath(projectId);
  const prefix = `${exact}/`;
  if (path.includes('..') || (path !== exact && !path.startsWith(prefix))) {
    throw new Error('refusing a path outside the project');
  }
}

/**
 * GET-only Slate reads: /slate/v1/project/<id>/app and …/deployment/<id>.
 * The deployment read sits on the zgraphql origin; the app list on admin.
 */
export function assertSlatePath(projectId: string, path: string, method: string): void {
  if (!/^[0-9]+$/.test(projectId)) throw new Error('refusing a path outside the project');
  if (method !== 'GET') throw new Error('refusing a non-GET slate call');
  const prefix = `/slate/v1/project/${projectId}/`;
  if (path.includes('..') || !path.startsWith(prefix)) {
    throw new Error('refusing a path outside the project');
  }
}

function slatePrefix(projectId: string): string {
  return `/slate/v1/project/${projectId}/`;
}

/** GET-only SmartBrowz reads under /browser360/v1/project/<id>/ (the first-use gate probe). */
export function assertBrowserPath(projectId: string, path: string, method: string): void {
  if (!/^[0-9]+$/.test(projectId)) throw new Error('refusing a path outside the project');
  if (method !== 'GET') throw new Error('refusing a non-GET SmartBrowz call');
  if (path.includes('..') || !path.startsWith(browserPrefix(projectId))) throw new Error('refusing a path outside the project');
}

function browserPrefix(projectId: string): string {
  return `/browser360/v1/project/${projectId}/`;
}

/** Rows of GET /baas/v1/project. A non-decimal id (a rounded double) is dropped, not coerced. Only name, id, project_type and created_time survive — the raw listing carries other projects' secrets. */
export function parseProjectList(body: unknown): ListedProject[] {
  if (!body || typeof body !== 'object') throw new Error('catalyst project list did not return projects');
  const record = body as Record<string, unknown>;
  const data = Array.isArray(record.data) ? record.data : Array.isArray(body) ? (body as unknown[]) : undefined;
  if (!data) throw new Error('catalyst project list did not return projects');
  const out: ListedProject[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = decimalString(row.id ?? row.project_id);
    const nameValue = row.project_name ?? row.name;
    const name = typeof nameValue === 'string' ? nameValue.trim() : '';
    if (!id || !name) continue;
    out.push({
      id,
      name,
      ...(typeof row.project_type === 'string' ? { projectType: row.project_type } : {}),
      ...(typeof row.created_time === 'string' ? { createdTime: row.created_time } : {}),
    });
  }
  return out;
}

function decimalString(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

/**
 * List projects in one org. One GET /baas/v1/project, nothing else: the hook
 * refuses every other method and path. Ids stay the digit strings from the body.
 */
export async function listCatalystProjects(env: NodeJS.ProcessEnv, org: string, opts: { log?: (line: string) => void } = {}): Promise<ListedProject[]> {
  if (!/^[0-9]+$/.test(org)) throw new Error('refusing to list projects without a decimal org id');
  const decoded = await catalystRestCall(env, org, org, { method: 'GET', path: '/baas/v1/project' }, { exact: true, ...opts });
  if (decoded.status < 200 || decoded.status >= 300) throw new Error('catalyst project list failed');
  return parseProjectList(decoded.body);
}

/**
 * One admin REST call. A GET that answers 401 INVALID_TOKEN (the access token
 * lapsed as the call landed) is sent once more only when a newer token is at
 * hand: by default the CLI credential store is re-read without a refresh, and
 * the call is retried only when the stored token differs from the one that
 * failed. With C2C_ALLOW_LOCAL_REFRESH=1 the retry forces one CLI refresh
 * instead. A write is never re-sent. The outcome line goes to `opts.log`
 * (stderr by default).
 */
export async function catalystRestCall(
  env: NodeJS.ProcessEnv,
  org: string,
  projectId: string,
  call: RestCall,
  opts: { exact?: boolean; log?: (line: string) => void } = {},
): Promise<RestResult> {
  let failedTag: string | undefined;
  return readWithNewerToken({
    readOnly: call.method === 'GET',
    attempt: async () => {
      const { result, tokenTag } = await restOnce(env, org, projectId, call, opts);
      failedTag = tokenTag;
      return result;
    },
    expired: (res) => invalidTokenAnswer(res.status, res.body),
    renew: async () => {
      if (localRefreshAllowed(env)) {
        await refreshCliAccessToken(env, org, opts.exact ? undefined : projectId);
        return true;
      }
      const stored = await peekCliTokenTag(env);
      return stored !== undefined && failedTag !== undefined && stored !== failedTag;
    },
    describe: `${call.method} ${call.path}`,
    log: opts.log ?? ((line) => process.stderr.write(`${line}\n`)),
  });
}

async function restOnce(
  env: NodeJS.ProcessEnv,
  org: string,
  projectId: string,
  call: RestCall,
  opts: { exact?: boolean },
): Promise<{ result: RestResult; tokenTag?: string }> {
  if (opts.exact) {
    if (call.method !== 'GET' || call.path !== '/baas/v1/project') throw new Error('refusing a path outside the project list');
  } else if (call.path.startsWith('/slate/')) {
    assertSlatePath(projectId, call.path, call.method);
  } else if (call.path.startsWith('/browser360/')) {
    assertBrowserPath(projectId, call.path, call.method);
  } else {
    assertProjectPath(projectId, call.path);
  }
  const located = resolveCatalyst(env);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-rest-'));
  const hook = join(dir, 'cli-hook.cjs');
  writeFileSync(hook, HOOK, { mode: 0o600 });
  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...scrubCatalystEnv(env),
      C2C_REQ: JSON.stringify({
        method: call.method,
        path: call.path,
        ...(call.body !== undefined ? { body: call.body } : {}),
        ...(call.origin ? { origin: call.origin } : {}),
      }),
      C2C_ALLOWED_PREFIX: opts.exact
        ? '/baas/v1/project'
        : call.path.startsWith('/slate/')
          ? slatePrefix(projectId)
          : call.path.startsWith('/browser360/')
            ? browserPrefix(projectId)
            : projectPrefix(projectId),
      ...(opts.exact ? { C2C_EXACT_ONLY: '1' } : {}),
      C2C_CLI_LIB: located.lib,
      C2C_ORG: org,
    };
    const scopeArgs = opts.exact ? ['--org', org] : catalystScopeArgs(org, projectId);
    const result = await run(process.execPath, ['-r', hook, located.bin, ...scopeArgs, 'project:list'], childEnv);
    const text = result.extra;
    const line = text.split('\n').find((item) => item.startsWith('C2C_RESULT ') || item === 'C2C_REFUSED');
    if (!line) throw new Error(`catalyst rest printed no result (${describeExit(result)})`);
    if (line === 'C2C_REFUSED') throw new Error('catalyst rest refused the path');
    const parsed = JSON.parse(line.slice('C2C_RESULT '.length)) as { status?: number; raw?: unknown; body?: unknown; tokenTag?: unknown };
    const decoded = decodeRestPayload(parsed);
    if (result.code !== 0 && (parsed.status === undefined || parsed.status === 0)) {
      throw new Error('catalyst rest failed');
    }
    return {
      result: { status: parsed.status ?? result.code, body: decoded.body, ...(decoded.retryAfterMs !== undefined ? { retryAfterMs: decoded.retryAfterMs } : {}) },
      ...(typeof parsed.tokenTag === 'string' ? { tokenTag: parsed.tokenTag } : {}),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * C2C_TOKEN_MODE picks what the hook writes on fd 3:
 * - read:    getAccessToken() — the cached token, refreshed by the CLI when it
 *            is close to expiry (the first token of a run).
 * - refresh: getAccessToken(true) — a forced refresh (C2C_ALLOW_LOCAL_REFRESH=1 only).
 * - peek:    the pure accessToken getter on the stored credential: the stored
 *            token when it is still fresh, else nothing. It never POSTs.
 * - tag:     peek, written as a one-way tag instead of the token.
 * peek and tag run on `catalyst --version`, a command that makes no API call,
 * so the CLI's own lazy refresh never runs in that process either.
 */
const TOKEN_HOOK = `const fs = require('fs');
const path = require('path');
const realExit = process.exit.bind(process);
let pending = null;
function run() {
  if (!pending) pending = run0();
  return pending;
}
async function stored(lib, Credential) {
  const store = require(path.join(lib, 'util_modules', 'config-store.js')).default;
  const dc = require(path.join(lib, 'util_modules', 'dc.js'));
  const raw = store.get(dc.getActiveDC() + '.credential', null);
  if (typeof raw !== 'string') return null;
  return Credential.init(raw, false).accessToken;
}
async function run0() {
  try {
    const lib = process.env.C2C_CLI_LIB;
    const mode = process.env.C2C_TOKEN_MODE || 'read';
    const Credential = require(path.join(lib, 'authentication', 'credential.js')).default;
    let token;
    if (mode === 'peek' || mode === 'tag') token = await stored(lib, Credential);
    else token = await Credential.getAccessToken(mode === 'refresh');
    if (token && mode === 'tag') token = require('crypto').createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
    fs.writeSync(3, token ? String(token) : '');
  } catch (err) {
    fs.writeSync(3, '');
  }
}
process.exit = (code) => { run().finally(() => realExit(code)); };
process.on('beforeExit', () => { run().finally(() => realExit(0)); });
`;

type TokenMode = 'read' | 'refresh' | 'peek' | 'tag';

/** C2C_ALLOW_LOCAL_REFRESH=1: the user owns the only copy of this CLI credential, so a retry may force a refresh. */
export function localRefreshAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.C2C_ALLOW_LOCAL_REFRESH === '1';
}

/** Read the CLI access token through the Catalyst process. The token is not printed and the credential directory is not opened here. */
export async function readCliAccessToken(env: NodeJS.ProcessEnv, org: string, projectId: string): Promise<string> {
  const token = await cliToken(env, 'read', org, projectId);
  if (!token) throw new Error('catalyst token was empty');
  return token;
}

/**
 * Force a CLI token refresh now and return the new token. The CLI POSTs its
 * refresh token and stores the answer; when the service rotates the refresh
 * token, every other holder of the old one (another run on the same
 * credential, an outside refresher) fails its next refresh. Used only with
 * C2C_ALLOW_LOCAL_REFRESH=1. Without a project id the CLI runs org-scoped.
 */
export async function refreshCliAccessToken(env: NodeJS.ProcessEnv, org?: string, projectId?: string): Promise<string> {
  const token = await cliToken(env, 'refresh', org, projectId);
  if (!token) throw new Error('catalyst token was empty');
  return token;
}

/** The token in the CLI credential store when it is still fresh, read without any refresh POST; undefined otherwise. */
export async function peekCliAccessToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return (await cliToken(env, 'peek')) || undefined;
}

/** peekCliAccessToken as a one-way tag: compares tokens without the token leaving the CLI process. */
export async function peekCliTokenTag(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return (await cliToken(env, 'tag')) || undefined;
}

/**
 * A newer access token for a read that met 401 INVALID_TOKEN. By default
 * the stored token, re-read without a refresh (the caller compares it with
 * the one that failed); with C2C_ALLOW_LOCAL_REFRESH=1, a forced refresh.
 */
export async function renewCliAccessToken(env: NodeJS.ProcessEnv, org?: string): Promise<string | undefined> {
  return localRefreshAllowed(env) ? refreshCliAccessToken(env, org) : peekCliAccessToken(env);
}

async function cliToken(env: NodeJS.ProcessEnv, mode: TokenMode, org?: string, projectId?: string): Promise<string> {
  const located = resolveCatalyst(env);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-token-'));
  const hook = join(dir, 'token-hook.cjs');
  writeFileSync(hook, TOKEN_HOOK, { mode: 0o600 });
  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...scrubCatalystEnv(env),
      C2C_CLI_LIB: located.lib,
      C2C_TOKEN_MODE: mode,
      ...(org !== undefined ? { C2C_ORG: org } : {}),
    };
    const command =
      mode === 'peek' || mode === 'tag'
        ? ['--version']
        : [...(org === undefined ? [] : projectId === undefined ? ['--org', org] : catalystScopeArgs(org, projectId)), 'project:list'];
    const result = await run(process.execPath, ['-r', hook, located.bin, ...command], childEnv);
    if (!result.extra && (result.code !== 0 || result.signal)) throw new Error(`catalyst token hook printed nothing (${describeExit(result)})`);
    return result.extra.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function resolveCatalyst(env: NodeJS.ProcessEnv): { bin: string; lib: string } {
  const which = spawnSync('/usr/bin/which', ['catalyst'], { env, encoding: 'utf8' });
  const found = which.status === 0 ? which.stdout.trim() : '';
  if (!found) throw new Error('catalyst CLI was not found on PATH');
  const bin = realpathSync(found);
  let dir = dirname(bin);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'internal'))) return { bin, lib: dir };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('catalyst CLI library was not found');
}

type RunResult = { code: number; signal?: string; extra: string; stderr: string };

const STDERR_KEEP = 4096;
const STDERR_EXCERPT_MAX = 200;

export const URL_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>)\]}]+/g;
// Bounded runs: an unanchored `+@` pattern backtracks over the whole tail at
// every offset, which is quadratic on megabyte inputs.
export const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}/g;
/** xxx.yyy.zzz with base64url segments — a JWT. */
export const JWT_RE = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
export const AUTH_RE = /\b(?:Basic|Bearer|Zoho-oauthtoken)\s+[^\s"'<>)\]},;]+/gi;
export const ZOHO_TOKEN_RE = /\b[0-9]{3,16}\.[0-9a-zA-Z]{8,}[0-9a-zA-Z._-]*/g;
/**
 * A secret-named parameter value. The key may sit at the start of the text or
 * after whitespace, `?`, `&`, `#`, `;`, `,`, `:`, a quote, `=`, `+`, or a markup /
 * bracket delimiter (`<`, `>`, `)`, `]`, `}`). The separator between key and value
 * is `=` or `:` (a header or a raw JSON pair), and the value may be wrapped in
 * quotes (with backslash-escaped quotes inside): `client_secret="…"`, `"refresh_token=…"`.
 */
export const PARAM_SECRET_RE =
  /((?:^|["'=+?&#\s;,:<>)\]}]))((?:[^=\s&"'<>)\]}:]{0,128})(?:secret|token|password|passwd|pwd|credentials?|authorization|auth|api[-_]?key|session|cookie|private[-_]?key|access[-_]?key|signature|key|sig|code|pw|otp|bearer|jwt)(?:[^=\s&"'<>)\]}:]{0,128}))(["']?)(\s*[:=]\s*)("(?:\\+["']|\\.|[^"\\])*"?|'(?:\\+["']|\\.|[^'\\])*'?|(?:\\+["']|[^&\s"'<>)\]},])+)/gi;
/** Long hex, base64, or token-shaped credential runs. */
export const HEX_B64_TOKEN_RE =
  /\b(?:[A-Za-z0-9+/]{16,}={1,2}|(?=[0-9a-fA-F]*[0-9])(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{16,}|(?=[A-Za-z0-9._-]*[0-9])(?=[A-Za-z0-9._-]*[A-Za-z])[A-Za-z0-9._-]{20,}|(?=[A-Za-z0-9._-]*[0-9])[A-Za-z0-9._-]*(?:token|secret|passwd|password|apikey|oauth)[A-Za-z0-9._-]*)/gi;
/** Diagnostic codes a caller reads to act on a failure — not secrets. */
export const SAFE_CODE_KEY_RE = /^(?:error|status|exit|http|reason)[-_]?code$/i;
const SECRET_KEY_TOKEN_RE =
  /secret|token|password|passwd|pwd|credentials?|authorization|auth|api[-_]?key|session|cookie|private[-_]?key|access[-_]?key|signature|key|sig|code|pw|otp|bearer|jwt/i;
const PERCENT_HEX_RE = /%(?:25){0,4}([0-9a-fA-F]{2})/gi;
const UNICODE_HEX_RE = /\\u([0-9a-fA-F]{4})/gi;

/**
 * Bounded percent-decoder that tolerates malformed `%` sequences and folds
 * repeated `%25` prefixes (such as `%2563`). When `wordOnly` is true, only
 * identifier characters (`[A-Za-z0-9._~+-]`) are decoded so encoded quotes,
 * whitespace, or `&` inside a value cannot split it before matching.
 */
function decodePercentBounded(input: string, wordOnly = false): string {
  if (!input.includes('%')) return input;
  let current = input.length > STDERR_KEEP ? input.slice(0, STDERR_KEEP) : input;
  for (let pass = 0; pass < 3 && current.includes('%'); pass++) {
    const next = current.replace(PERCENT_HEX_RE, (full, hex: string) => {
      const code = parseInt(hex, 16);
      if (wordOnly) {
        const ch = String.fromCharCode(code);
        return /[A-Za-z0-9._~+-]/.test(ch) ? ch : full;
      }
      if (code === 0x09 || code === 0x0a || code === 0x0d) return ' ';
      if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code);
      return full;
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

function decodeIdentifierEscapes(input: string): string {
  return decodePercentBounded(
    input.replace(UNICODE_HEX_RE, (full, hex: string) => {
      const code = parseInt(hex, 16);
      const ch = String.fromCharCode(code);
      return /[A-Za-z0-9._~+-]/.test(ch) ? ch : full;
    }),
    true,
  );
}

function isSecretKeyName(rawKey: string): boolean {
  const decoded = decodePercentBounded(
    rawKey.replace(UNICODE_HEX_RE, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
  ).trim();
  if (SAFE_CODE_KEY_RE.test(decoded)) return false;
  return SECRET_KEY_TOKEN_RE.test(decoded);
}

/** Chars that may sit immediately before a secret-named key (or the start of the text). */
const PARAM_SEP_CHARS = new Set([...`"'=+?&#;,:<>)]}`]);
/** Chars that end a key run — everything else is a key char. */
const PARAM_KEY_STOP_CHARS = new Set([...`=&"'<>)]}:`]);

function isParamSep(ch: string | undefined): boolean {
  return ch !== undefined && (PARAM_SEP_CHARS.has(ch) || /\s/.test(ch));
}
function isParamKeyChar(ch: string | undefined): boolean {
  return ch !== undefined && !PARAM_KEY_STOP_CHARS.has(ch) && !/\s/.test(ch);
}
function isParamValueStop(ch: string): boolean {
  return ch === '&' || ch === '"' || ch === "'" || ch === '<' || ch === '>' ||
    ch === ')' || ch === ']' || ch === '}' || ch === ',' || /\s/.test(ch);
}

/**
 * Scan the value that starts at `vStart`: a `"`/`'`-quoted run (backslash
 * escapes honoured, closing quote optional) or an unquoted run that stops at
 * `&`, whitespace, quotes, markup or bracket delimiters. A backslash followed
 * by a quote is consumed as a unit. Linear in the value length.
 */
function scanParamValue(input: string, vStart: number): number {
  const n = input.length;
  const q = input[vStart];
  if (q === '"' || q === "'") {
    let m = vStart + 1;
    while (m < n) {
      const c = input[m];
      if (c === q) {
        m++;
        break;
      }
      if (c === '\\') {
        // `\\+["']`: a run of backslashes followed by a quote is one unit, so a
        // quote right after backslashes never closes the value.
        let e = m;
        while (e < n && input[e] === '\\') e++;
        if (e < n && (input[e] === '"' || input[e] === "'")) {
          m = e + 1;
        } else {
          m += 2; // `\\.`
        }
      } else {
        m++;
      }
    }
    return m;
  }
  let m = vStart;
  while (m < n) {
    const c = input[m];
    if (c === '\\' && m + 1 < n && (input[m + 1] === '"' || input[m + 1] === "'")) {
      m += 2;
    } else if (isParamValueStop(c)) {
      break;
    } else {
      m++;
    }
  }
  return m;
}

type ParamCandidate = { start: number; keyEnd: number; vStart: number; vEnd: number };

/**
 * Linear scan for `key<delim>value` pairs whose key is secret-named. The key
 * may sit at the start of the text or right after a separator char — including
 * `=`/`?`/`&` inside another pair's value, so `body: token=x` still yields
 * `token`. There is no key-length bound: a >128-char secret-named key cannot
 * slip past. The value span is only scanned once the key qualifies, so a long
 * run of non-secret `k=v` pairs cannot force quadratic work. Scanning resumes
 * past a masked value, or past the key when the pair does not qualify, so
 * nested `key=value` pairs inside a non-secret value are still found.
 */
function* paramSecretCandidates(input: string): Generator<ParamCandidate> {
  const n = input.length;
  let i = 0;
  while (i < n) {
    if (!isParamKeyChar(input[i]) || (i !== 0 && !isParamSep(input[i - 1]))) {
      i++;
      continue;
    }
    let keyEnd = i;
    while (keyEnd < n && isParamKeyChar(input[keyEnd])) keyEnd++;
    let k = keyEnd;
    if (input[k] === '"' || input[k] === "'") k++;
    while (k < n && /\s/.test(input[k])) k++;
    if (k >= n || (input[k] !== '=' && input[k] !== ':')) {
      i = keyEnd;
      continue;
    }
    k++;
    while (k < n && /\s/.test(input[k])) k++;
    const vStart = k;
    const vFirst = input[vStart];
    const hasValue =
      vFirst !== undefined &&
      (vFirst === '"' || vFirst === "'" || !isParamValueStop(vFirst));
    if (!hasValue || !isSecretKeyName(input.slice(i, keyEnd))) {
      i = keyEnd;
      continue;
    }
    const vEnd = scanParamValue(input, vStart);
    const val = input.slice(vStart, vEnd);
    if (val === '<redacted>' || val === '"<redacted>"' || val === "'<redacted>'") {
      i = vEnd;
      continue;
    }
    yield { start: i, keyEnd, vStart, vEnd };
    i = vEnd;
  }
}

/** True when the text carries a `secret-named-key=value` pair. */
export function hasParamSecret(input: string): boolean {
  for (const _cand of paramSecretCandidates(input)) return true;
  return false;
}

function redactParamSecrets(input: string): string {
  let out = '';
  let cursor = 0;
  for (const cand of paramSecretCandidates(input)) {
    const val = input.slice(cand.vStart, cand.vEnd);
    const quote = val.startsWith('"') && val.endsWith('"') ? '"' : val.startsWith("'") && val.endsWith("'") ? "'" : '';
    out += input.slice(cursor, cand.vStart) + quote + '<redacted>' + quote;
    cursor = cand.vEnd;
  }
  return cursor === 0 ? input : out + input.slice(cursor);
}

function redactJsonNode(node: unknown, depth: number): { value: unknown; changed: boolean } {
  if (typeof node === 'string') {
    const redacted = redactStringInner(node, depth + 1);
    return { value: redacted, changed: redacted !== node };
  }
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((item) => {
      const res = redactJsonNode(item, depth + 1);
      if (res.changed) changed = true;
      return res.value;
    });
    return { value: out, changed };
  }
  if (node && typeof node === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const redactedKey = redactStringInner(key, depth + 1);
      if (redactedKey !== key) changed = true;
      if (isSecretKeyName(key)) {
        if (child !== '<redacted>') changed = true;
        out[redactedKey] = '<redacted>';
      } else {
        const res = redactJsonNode(child, depth + 1);
        if (res.changed) changed = true;
        out[redactedKey] = res.value;
      }
    }
    return { value: out, changed };
  }
  return { value: node, changed: false };
}

/** A single JSON fragment may span at most this many characters. */
const JSON_FRAGMENT_MAX = 256 * 1024;
/** Total characters the fragment scanner may inspect per call, across all attempts. */
const JSON_SCAN_BUDGET = 2 * 1024 * 1024;

/**
 * Scan for balanced `{...}` or `[...]` JSON fragments and redact secret keys
 * recursively via `JSON.parse` before falling back to key=value regexes.
 * Fragment size, attempt count, and total scanned characters are all capped so
 * the pass stays linear on inputs full of unbalanced openers.
 */
function redactJsonFragments(input: string, depth: number): string {
  if (depth > 3 || (!input.includes('{') && !input.includes('['))) return input;
  let out = '';
  let cursor = 0;
  let attempts = 0;
  let scanBudget = JSON_SCAN_BUDGET;
  let i = 0;
  for (; i < input.length && scanBudget > 0; i++) {
    const startChar = input[i];
    if (startChar !== '{' && startChar !== '[') continue;
    if (++attempts > 64) break;
    const stack: string[] = [startChar === '{' ? '}' : ']'];
    let inString = false;
    let matchedEnd = -1;
    const limit = Math.min(input.length, i + 1 + JSON_FRAGMENT_MAX);
    for (let j = i + 1; j < limit && scanBudget-- > 0; j++) {
      const ch = input[j];
      if (inString) {
        if (ch === '\\') {
          j++;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        stack.push('}');
      } else if (ch === '[') {
        stack.push(']');
      } else if (ch === '}' || ch === ']') {
        if (stack[stack.length - 1] !== ch) break;
        stack.pop();
        if (stack.length === 0) {
          matchedEnd = j;
          break;
        }
      }
    }
    if (matchedEnd !== -1) {
      const candidate = input.slice(i, matchedEnd + 1);
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') {
          const redacted = redactJsonNode(parsed, depth);
          out += input.slice(cursor, i) + (redacted.changed ? JSON.stringify(redacted.value) : candidate);
          cursor = matchedEnd + 1;
          i = matchedEnd;
        }
      } catch {
        // Not valid JSON starting at `i`; continue scanning or fall back to regexes.
      }
    }
  }
  if (i < input.length) {
    // The attempt count or scan budget ran out before the end of the input —
    // fail closed rather than return text the scanner never inspected.
    return out + '<redacted>';
  }
  return cursor === 0 ? input : out + input.slice(cursor);
}

function redactStringInner(value: string, depth: number): string {
  if (depth > 4) return value;
  // 1. Parse any JSON or JSON fragment first and redact secret keys recursively.
  // 2. Decode identifier escapes and URL scheme delimiters so URLs and encoded
  //    key=value pairs match before full percent-decoding can split values on
  //    encoded spaces, quotes, or `&`.
  // 3. Decode remaining printable percent-encodings and run the JSON / URL /
  //    auth / parameter / token passes on the decoded text.
  const stage1 = redactParamSecrets(
    decodeIdentifierEscapes(redactJsonFragments(value, depth))
      .replace(/\\\//g, '/')
      .replace(/\\u002f/gi, '/')
      .replace(/%(?:25){0,4}(?:2f|3a)/gi, (hex) => String.fromCharCode(parseInt(hex.slice(-2), 16)))
      .replace(URL_RE, '<url>')
      .replace(AUTH_RE, '<auth>'),
  );
  const stage2 = decodePercentBounded(stage1, false);
  let out = redactParamSecrets(
    redactJsonFragments(stage2, depth)
      .replace(URL_RE, '<url>')
      .replace(AUTH_RE, '<auth>'),
  ).replace(HEX_B64_TOKEN_RE, '<token>');
  // These patterns all require a literal `.` or `@`; skip the scan when the
  // trigger character is absent so plain text stays a single linear pass.
  if (out.includes('.')) {
    out = out.replace(JWT_RE, '<token>').replace(ZOHO_TOKEN_RE, '<token>');
  }
  if (out.includes('@')) out = out.replace(EMAIL_RE, '<email>');
  return out;
}

export function redactString(value: string): string {
  return redactStringInner(value, 0);
}

/** True when a trimmed stderr line looks like an environment dump rather than an error message. */
function isEnvDumpLine(line: string): boolean {
  if (/^[{}[\],]+$/.test(line)) return true;
  if (/^(?:export\s+|set\s+)?[A-Z_][A-Z0-9_]{2,}=/.test(line)) return true;
  if (/^["']?[A-Z_][A-Z0-9_]{2,}["']?\s*:\s*["']/.test(line)) return true;
  const assignments = line.match(/(?:^|[\s{,"'])[A-Z_][A-Z0-9_]{2,}["']?\s*[:=]/g);
  return (assignments?.length ?? 0) >= 2;
}

/** First non-empty, non-env-dump stderr line, redacted and length-capped. */
export function redactStderrExcerpt(stderr: string): string {
  const first = stderr
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item !== '' && !isEnvDumpLine(item));
  if (!first) return '';
  return redactString(first)
    .replace(/\b[A-Z_][A-Z0-9_]{2,}=[^\s"'<>)\]},;]+/g, '<redacted>')
    .slice(0, STDERR_EXCERPT_MAX);
}

/** Exit code or signal plus the first redacted stderr line, for a child that wrote no result. */
function describeExit(result: RunResult): string {
  const how = result.signal ? `killed by ${result.signal}` : `exit code ${result.code}`;
  const first = redactStderrExcerpt(result.stderr);
  return first ? `${how}: ${first}` : how;
}

/** Spawn with an inherited pipe on fd 3; the hook writes secrets/results there, never to disk. Only the head of stderr is kept, for error messages. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdio[3]?.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_KEEP) stderr += chunk.toString('utf8').slice(0, STDERR_KEEP - stderr.length);
    });
    child.on('error', reject);
    child.on('close', (code, signal) =>
      resolve({ code: code ?? 1, ...(signal ? { signal } : {}), extra: Buffer.concat(chunks).toString('utf8'), stderr }),
    );
  });
}
