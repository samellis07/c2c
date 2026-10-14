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

async function authToken(view: AppWindow): Promise<string> {
  const auth = view.catalyst?.auth;
  if (!auth || typeof auth.generateAuthToken !== 'function') return '';
  try {
    // generateAuthToken needs a session; isUserAuthenticated fails fast without one.
    if (typeof auth.isUserAuthenticated === 'function') await auth.isUserAuthenticated();
    const token = (await auth.generateAuthToken())?.access_token;
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
  const detail: SessionExpiredDetail = { login: loginUrl(view), looping: recentSignIn(view) };
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
  const remote = apiBase(view) !== '' || token !== '';
  return await call(url, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    ...(remote ? { credentials: 'include' as const } : {}),
  });
}

export function createApi(view: AppWindow, extraHeaders?: HeaderHook): Api {
  async function attempt<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<ApiReply<T>> {
    const call = view.fetch?.bind(view);
    if (typeof call !== 'function') return { ok: false, status: 0, body: undefined };
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(extraHeaders ? await extraHeaders() : {}) };
    const token = await authToken(view);
    // Catalyst Web SDK v4.6.1+: the raw token, no prefix.
    if (token) headers.authorization = token;
    const remote = apiBase(view) !== '' || token !== '';
    let res: Response;
    try {
      res = await call(url, {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify(body, jsonReplacer) } : {}),
        ...(remote ? { credentials: 'include' as const } : {}),
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
    if (reply.status === 401) {
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
