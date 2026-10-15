/**
 * Calls to the existing c2c_api Advanced I/O function. Same contract as the
 * generated vanilla runtime: the base comes from public/c2c-config.js
 * (globalThis.C2C_API_BASE, rewritten by `c2c deploy`), each call carries the
 * signed-in user's Catalyst token when the Web SDK is loaded, and cross-origin
 * calls send cookies. With no base the endpoints stay root-relative. A call
 * goes only to the page origin or the configured API origin (see apiUrl).
 */

export interface CatalystAuth {
  isUserAuthenticated?: () => Promise<unknown>;
  getCurrentUser?: () => Promise<unknown>;
  generateAuthToken?: () => Promise<{ access_token?: string } | undefined>;
  signIn?: (elementId: string, opts: { service_url: string }) => void;
  signOut?: (redirect?: string) => void;
}

/** The browser window the app runs in, with the globals c2c-config.js sets. */
export interface AppWindow extends Window {
  C2C_API_BASE?: string;
  C2C_APP_TIMEZONE?: string;
  C2C_LOGIN_WAIT_MS?: number;
  /** The smoke plan a deploy embeds for the hidden #/admin/smoke page. */
  C2C_SMOKE_PLAN?: unknown;
  /** The Catalyst project id the deploy targeted, for the smoke block's binding. */
  C2C_SMOKE_PROJECT?: string;
  /** Bound on the auth-token wait — see authToken. Default 5000 ms. */
  C2C_AUTH_TIMEOUT_MS?: number;
  /** Bound on the smoke page's access check — see smoke/run.ts. Default 30000 ms. */
  C2C_SMOKE_STATUS_TIMEOUT_MS?: number;
  /**
   * The c2c_auth token bridge on the function origin (c2c-config.js, set on a
   * deployed app). When present, the app carries the token the bridge returned
   * in the #c2c_auth fragment and sends no cookies.
   */
  C2C_AUTH_BRIDGE?: string;
  catalyst?: { auth?: CatalystAuth };
}

export interface ApiReply<T = unknown> {
  ok: boolean;
  status: number;
  body: T | undefined;
}

export interface Api {
  post<T = unknown>(endpoint: string, body: unknown): Promise<ApiReply<T>>;
  /** A read with no body: the lookup endpoints (GET /lookups/<form>/<field>?page=&pageSize=). */
  get<T = unknown>(endpoint: string): Promise<ApiReply<T>>;
}

export function apiBase(view: AppWindow): string {
  return typeof view.C2C_API_BASE === 'string' ? view.C2C_API_BASE.replace(/\/+$/, '') : '';
}

/** Exact loopback names — a host that only starts with one (`127.0.0.1.evil.test`) is not loopback. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** The page's own address — the origin a relative endpoint belongs to. */
function pageUrl(view: AppWindow): URL {
  const href = typeof view.location?.href === 'string' ? view.location.href : '';
  try {
    return new URL(href || 'https://localhost/');
  } catch {
    return new URL('https://localhost/');
  }
}

/**
 * Where an authenticated request may go. The endpoint joins the configured
 * API base, or the page origin when no base is set, and the result must land
 * on the page origin or the configured API origin itself. That configured
 * origin is trusted only as https — or http to an exact loopback address on
 * a local dev stack, the same rule the signed-upload check uses. Anything
 * else — an absolute URL to another host, a protocol-relative `//host/path`,
 * or a non-web scheme such as `javascript:` or `data:` — throws here, so the
 * session token is never attached to a request for a different origin.
 */
export function apiUrl(view: AppWindow, endpoint: string): string {
  if (typeof endpoint !== 'string' || !endpoint) throw new Error('api request refused: the endpoint is not an address');
  const page = pageUrl(view);
  const base = apiBase(view);
  let baseOrigin = '';
  if (base) {
    try {
      const parsedBase = new URL(base, page);
      if (parsedBase.protocol === 'https:' || (parsedBase.protocol === 'http:' && LOOPBACK_HOSTS.has(parsedBase.hostname))) {
        baseOrigin = parsedBase.origin;
      }
    } catch {
      baseOrigin = '';
    }
  }
  // A scheme (`https:`) or leading `//` names its own host — it never joins the base.
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(endpoint) || endpoint.startsWith('//');
  const request = !base || absolute ? endpoint : `${base}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  let target: URL | null = null;
  try {
    target = new URL(request, page);
  } catch {
    target = null;
  }
  const webTarget = target !== null && (target.protocol === 'http:' || target.protocol === 'https:');
  const allowed = webTarget && target !== null && (target.origin === page.origin || (baseOrigin !== '' && target.origin === baseOrigin));
  if (!allowed) throw new Error(`api request refused: ${endpoint} is not on the page or configured API origin`);
  return request;
}

/**
 * Token bridge (design d'). The Slate origin serves no /baas routes, so the
 * Web SDK cannot mint a functions token on it. The configured C2C_AUTH_BRIDGE
 * page runs on the function origin — where the SDK is first-party — and
 * returns the token in `#c2c_auth=<token>&state=<state>`. The state binds the
 * fragment to this tab: a link carrying a foreign token is refused because
 * its state never equals the sessionStorage value written here.
 */
const BRIDGE_STATE_KEY = 'c2c.bridge.state';
const BRIDGE_TOKEN_KEY = 'c2c.bridge.token';
const BRIDGE_ROUTE_KEY = 'c2c.bridge.route';
/** sessionStorage timestamp of the last bridge redirect, for the loop guard. */
const BRIDGE_MARK = 'c2c.bridge.at';
/** Two bridge round trips inside this window mean the trip itself fails. */
const BRIDGE_LOOP_MS = 60_000;

function bridgeConfigured(view: AppWindow): boolean {
  return typeof view.C2C_AUTH_BRIDGE === 'string' && view.C2C_AUTH_BRIDGE.length > 0;
}

/** A fixed-time compare so a fragment's state is checked without an early exit. */
function sameState(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function storedBridgeToken(view: AppWindow): string {
  try {
    return sessionStore(view)?.getItem(BRIDGE_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function forgetBridgeToken(view: AppWindow): void {
  try {
    sessionStore(view)?.removeItem(BRIDGE_TOKEN_KEY);
  } catch {
    // storage refused
  }
}

/**
 * Read `#c2c_auth=<token>&state=<state>` off the address bar. A matching
 * fragment is consumed exactly once: the token is kept in sessionStorage for
 * reloads, the route saved before the bridge trip is restored, and the
 * fragment is stripped with replaceState so it never reaches the router, a
 * log, or a referrer. A mismatched or unsigned state drops the token.
 */
export function intakeBridgeFragment(view: AppWindow): void {
  const hash = typeof view.location?.hash === 'string' ? view.location.hash : '';
  if (!hash.startsWith('#c2c_auth=')) return;
  let token = '';
  let state = '';
  try {
    const params = new URLSearchParams(hash.slice(1));
    token = params.get('c2c_auth') ?? '';
    state = params.get('state') ?? '';
  } catch {
    return;
  }
  // Strip the fragment before anything else can see it, restoring the route
  // the tab was on when it left for the bridge.
  let route = '/';
  try {
    const stored = sessionStore(view);
    const saved = stored?.getItem(BRIDGE_ROUTE_KEY);
    if (saved && saved.startsWith('/')) route = saved;
    stored?.removeItem(BRIDGE_ROUTE_KEY);
  } catch {
    // storage refused: fall back to the root route
  }
  let replaceError: unknown;
  try {
    if (typeof view.history?.replaceState !== 'function') throw new Error('history.replaceState is unavailable');
    view.history.replaceState(null, '', new URL(route, pageUrl(view).origin).href);
  } catch (error) {
    replaceError = error;
    forgetBridgeToken(view);
    try { view.location.hash = ''; } catch { /* location is read-only in some hosts */ }
  }
  let expected = '';
  try {
    expected = sessionStore(view)?.getItem(BRIDGE_STATE_KEY) ?? '';
    sessionStore(view)?.removeItem(BRIDGE_STATE_KEY);
  } catch {
    // storage refused
  }
  if (replaceError) throw replaceError;
  if (!token || !expected || !sameState(state, expected)) return;
  try {
    sessionStore(view)?.setItem(BRIDGE_TOKEN_KEY, token);
  } catch {
    // storage refused: the token stays in this page only
  }
}

function recentBridge(view: AppWindow): boolean {
  try {
    const at = Number(sessionStore(view)?.getItem(BRIDGE_MARK));
    return Number.isFinite(at) && at > 0 && Date.now() - at < BRIDGE_LOOP_MS;
  } catch {
    return false;
  }
}

/**
 * Send the tab to the token bridge, remembering where it was. The bridge URL
 * is the deploy-generated C2C_AUTH_BRIDGE: trusted config, https only (or a
 * loopback host on a local stack). Returns false when the round trip would
 * loop — a bridge return without a token lands on the signed-out prompt
 * instead of redirecting forever.
 */
export function bridgeRedirect(view: AppWindow, force = false): boolean {
  const bridge = view.C2C_AUTH_BRIDGE;
  if (typeof bridge !== 'string' || !bridge) return false;
  let parsed: URL;
  try {
    parsed = new URL(bridge, pageUrl(view));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) return false;
  if (!force && recentBridge(view)) return false;
  const store = sessionStore(view);
  let state = '';
  try {
    const bytes = new Uint8Array(32);
    (view.crypto ?? globalThis.crypto)?.getRandomValues(bytes);
    state = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch {
    return false;
  }
  try {
    const here = `${view.location.pathname}${view.location.hash && !view.location.hash.startsWith('#c2c_auth=') ? view.location.hash : ''}`;
    store?.setItem(BRIDGE_ROUTE_KEY, here || '/');
    store?.setItem(BRIDGE_STATE_KEY, state);
    store?.setItem(BRIDGE_MARK, String(Date.now()));
  } catch {
    // storage refused: the fragment's state check will refuse the return — do not leave
    return false;
  }
  const target = `${parsed.origin}${parsed.pathname}?state=${state}`;
  const location = view.location as Location & { assign?: (url: string) => void };
  try {
    if (typeof location.assign === 'function') location.assign(target);
    else location.href = target;
    return true;
  } catch {
    return false;
  }
}

/** True when the tab holds a bridge token (from intake or an earlier trip). */
export function hasBridgeToken(view: AppWindow): boolean {
  intakeBridgeFragment(view);
  return storedBridgeToken(view) !== '';
}

async function authToken(view: AppWindow): Promise<string> {
  intakeBridgeFragment(view);
  if (bridgeConfigured(view)) return storedBridgeToken(view);
  const auth = view.catalyst?.auth;
  if (!auth || typeof auth.generateAuthToken !== 'function') return '';
  // The SDK token chain is best-effort: on a host where the SDK's auth
  // endpoints are not served (e.g. a Slate domain, where the BaaS routes the
  // SDK calls root-relative answer 404), generateAuthToken can stay pending
  // forever — and awaiting it would hang every API call. Bound the wait and
  // send the call without a token instead; the server still refuses or
  // accepts on the session cookie.
  const wait = typeof view.C2C_AUTH_TIMEOUT_MS === 'number' ? view.C2C_AUTH_TIMEOUT_MS : 5000;
  const generate = auth.generateAuthToken;
  try {
    const token = await Promise.race([
      (async () => {
        // generateAuthToken needs a session; isUserAuthenticated fails fast without one.
        if (typeof auth.isUserAuthenticated === 'function') await auth.isUserAuthenticated();
        return (await generate.call(auth))?.access_token;
      })(),
      new Promise<unknown>((resolve) => setTimeout(() => resolve(''), wait)),
    ]);
    return typeof token === 'string' ? token : '';
  } catch {
    return '';
  }
}

/**
 * A 403 from the API. Screens hand it to the per-route boundary (useAccessDenied),
 * which shows the access-denied screen instead of the screen's own error state.
 */
export class AccessDenied extends Error {
  constructor() {
    super('access denied');
    this.name = 'AccessDenied';
  }
}

/** Fired on the window when a call answers 401 twice; cancel it to show your own prompt. */
export const SESSION_EXPIRED_EVENT = 'c2c:session-expired';

export interface SessionExpiredDetail {
  /** Catalyst's hosted sign-in, returning to this page. */
  login: string;
  /** This tab came back from sign-in moments ago and is still refused: do not send it round again. */
  looping: boolean;
}

/** sessionStorage key of the last sign-in redirect (a timestamp), for the loop guard. */
const SIGN_IN_MARK = 'c2c-auth:sign-in-at';
/** A 401 this soon after a sign-in round trip means signing in does not help (for example a user with no app role). */
const SIGN_IN_LOOP_MS = 120_000;

function sessionStore(view: AppWindow): Storage | null {
  try {
    return view.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The hosted sign-in page, returning to the page the user is on. */
export function loginUrl(view: AppWindow): string {
  const href = typeof view.location?.href === 'string' && view.location.href ? view.location.href : '/';
  return `/__catalyst/auth/login?service_url=${encodeURIComponent(href)}`;
}

function recentSignIn(view: AppWindow): boolean {
  try {
    const at = Number(sessionStore(view)?.getItem(SIGN_IN_MARK));
    return Number.isFinite(at) && at > 0 && Date.now() - at < SIGN_IN_LOOP_MS;
  } catch {
    return false;
  }
}

function forgetSignIn(view: AppWindow): void {
  try {
    sessionStore(view)?.removeItem(SIGN_IN_MARK);
  } catch {
    // storage refused: nothing to forget
  }
}

/** Send the page to sign-in, marking the time so a refused return does not loop. */
export function goToSignIn(view: AppWindow, login: string = loginUrl(view)): void {
  try {
    sessionStore(view)?.setItem(SIGN_IN_MARK, String(Date.now()));
  } catch {
    // storage refused: the redirect still happens
  }
  const location = view.location as Location & { assign?: (url: string) => void };
  try {
    if (typeof location.assign === 'function') location.assign(login);
    else location.href = login;
  } catch {
    // a host that refuses navigation keeps the prompt on screen
  }
}

/** One automatic redirect per window when no prompt handles the event. */
const redirected = new WeakSet<object>();

/**
 * The session is gone. Listeners (the open form saves its draft; the shell
 * shows the "Your session ended" prompt and cancels the event) run first. With
 * no prompt mounted the page goes straight to sign-in, unless it just came
 * back from there, which would loop.
 */
export function sessionExpired(view: AppWindow): void {
  const detail: SessionExpiredDetail = { login: loginUrl(view), looping: bridgeConfigured(view) ? recentBridge(view) : recentSignIn(view) };
  let handled = false;
  try {
    const Event = (view as unknown as { CustomEvent?: typeof CustomEvent }).CustomEvent ?? globalThis.CustomEvent;
    if (typeof Event === 'function' && typeof view.dispatchEvent === 'function') {
      handled = !view.dispatchEvent(new Event(SESSION_EXPIRED_EVENT, { cancelable: true, detail }));
    }
  } catch {
    handled = false;
  }
  if (handled || detail.looping || redirected.has(view)) return;
  redirected.add(view);
  // Bridge mode never parks on a hosted-login URL — Slate has none. The
  // refused bridge trip leaves the page to its prompt, whose button forces it.
  if (bridgeConfigured(view)) return;
  goToSignIn(view, detail.login);
}

/** A bigint (a toLong id) is written as its digit string. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function readBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

export type HeaderHook = () => Record<string, string> | Promise<Record<string, string>>;

export interface ApiInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** The response shape the smoke runner reads: fetch Response minus json(). */
export interface ApiResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/**
 * One fetch through the app's base and session — any method, for callers the
 * form/report helpers do not cover (the hidden smoke page reads with GET).
 * It hands back the raw status: the smoke page names 401 and 403 itself.
 * The base comes from C2C_API_BASE, the signed-in user's token rides as
 * `authorization`, and a remote call sends cookies.
 */
export async function apiCall(view: AppWindow, endpoint: string, init: ApiInit = {}): Promise<ApiResponse> {
  // Resolve and check the target before the token is even requested: a
  // refused endpoint throws here and no authorization header is attached.
  const url = apiUrl(view, endpoint);
  const call = view.fetch?.bind(view);
  if (typeof call !== 'function') return { ok: false, status: 0, text: async () => '' };
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const token = await authToken(view);
  if (token) headers.authorization = token;
  // Bridge mode sends no cookies at all: the Authorization header is the only
  // authority, so a cross-site form cannot ride an ambient session.
  const remote = apiBase(view) !== '' || token !== '';
  return await call(url, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    ...(bridgeConfigured(view) ? { credentials: 'omit' as const } : remote ? { credentials: 'include' as const } : {}),
  });
}

export function createApi(view: AppWindow, extraHeaders?: HeaderHook): Api {
  async function attempt<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<ApiReply<T>> {
    const call = view.fetch?.bind(view);
    if (typeof call !== 'function') return { ok: false, status: 0, body: undefined };
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(extraHeaders ? await extraHeaders() : {}) };
    const token = await authToken(view);
    // Catalyst Web SDK v4.6.2+: the raw token, no prefix.
    if (token) headers.authorization = token;
    const remote = apiBase(view) !== '' || token !== '';
    let res: Response;
    try {
      res = await call(url, {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify(body, jsonReplacer) } : {}),
        ...(bridgeConfigured(view) ? { credentials: 'omit' as const } : remote ? { credentials: 'include' as const } : {}),
      });
    } catch {
      // The network dropped or the host is unreachable: status 0, its own message.
      return { ok: false, status: 0, body: undefined };
    }
    // The server's text for 401, 403 and 5xx never reaches a screen: each
    // status has the app's own copy (failureText), so the body is dropped here.
    const masked = res.status === 401 || res.status === 403 || res.status >= 500;
    return { ok: res.ok, status: res.status, body: masked ? undefined : ((await readBody(res)) as T | undefined) };
  }
  async function send<T>(method: 'GET' | 'POST', endpoint: string, body?: unknown): Promise<ApiReply<T>> {
    // Resolve and check the target before the token is even requested: a
    // refused endpoint throws here and no authorization header is attached.
    const url = apiUrl(view, endpoint);
    let reply = await attempt<T>(method, url, body);
    // 401: one retry with a freshly generated token (a stale token renews
    // silently); a second 401 means the session is gone — the open form saves
    // its draft and the page goes to sign-in. 403 is never retried.
    // Bridge mode: drop the stored token and take one bridge round trip
    // (loop-guarded); a refused trip lands on the session-expired prompt.
    if (reply.status === 401) {
      if (bridgeConfigured(view)) {
        forgetBridgeToken(view);
        if (!bridgeRedirect(view)) sessionExpired(view);
        return reply;
      }
      reply = await attempt<T>(method, url, body);
      if (reply.status === 401) sessionExpired(view);
    }
    if (reply.ok) forgetSignIn(view);
    return reply;
  }
  return {
    post: <T>(endpoint: string, body: unknown) => send<T>('POST', endpoint, body),
    get: <T>(endpoint: string) => send<T>('GET', endpoint),
  };
}
