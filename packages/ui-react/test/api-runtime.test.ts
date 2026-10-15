/**
 * The React runtime's API client edges the screen tests do not reach: the
 * endpoint guard's malformed inputs, a token source that fails, the session
 * expiry hand-off (cancelled, once per window, no assign(), refused storage),
 * the raw apiCall path and the reply body decoding.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiCall, apiUrl, createApi, goToSignIn, loginUrl, sessionExpired, SESSION_EXPIRED_EVENT, type AppWindow, type CatalystAuth } from '../template/lib/c2c-ui/runtime/api.js';

interface Sent {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string; credentials?: string };
}

interface FakeOptions {
  href?: string;
  base?: string;
  auth?: CatalystAuth;
  replies?: Array<{ status: number; text?: string } | Error>;
  storage?: Storage | 'throws' | null;
  assign?: boolean;
  noFetch?: boolean;
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
  };
}

function fakeWindow(opts: FakeOptions = {}) {
  const sent: Sent[] = [];
  const assigned: string[] = [];
  const events: Event[] = [];
  const listeners: Array<(e: Event) => void> = [];
  const replies = [...(opts.replies ?? [])];
  const storage = opts.storage === undefined ? memoryStorage() : opts.storage;
  const location: Record<string, unknown> = { href: opts.href ?? 'https://app.example.test/app/#/form/Orders' };
  if (opts.assign !== false) location.assign = (url: string) => void assigned.push(url);
  const view: Record<string, unknown> = {
    location,
    CustomEvent,
    dispatchEvent(event: Event) {
      events.push(event);
      for (const listener of listeners) listener(event);
      return !event.defaultPrevented;
    },
  };
  Object.defineProperty(view, 'sessionStorage', {
    get() {
      if (storage === 'throws') throw new Error('SecurityError');
      return storage;
    },
  });
  if (opts.base !== undefined) view.C2C_API_BASE = opts.base;
  if (opts.auth) view.catalyst = { auth: opts.auth };
  if (!opts.noFetch) {
    view.fetch = async (url: string, init: Sent['init']) => {
      sent.push({ url, init });
      const next = replies.shift() ?? { status: 200, text: '' };
      if (next instanceof Error) throw next;
      return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => next.text ?? '' };
    };
  }
  return { view: view as unknown as AppWindow, sent, assigned, events, listeners, location, storage };
}

test('apiUrl refuses an empty or non-string endpoint before anything else runs', () => {
  const { view } = fakeWindow();
  assert.throws(() => apiUrl(view, ''), /not an address/);
  assert.throws(() => apiUrl(view, undefined as unknown as string), /not an address/);
});

test('apiUrl joins a relative endpoint onto the base, trimming its trailing slashes', () => {
  const { view } = fakeWindow({ base: 'https://api.example.test/server/c2c_api///' });
  assert.equal(apiUrl(view, 'forms/Orders'), 'https://api.example.test/server/c2c_api/forms/Orders');
  assert.equal(apiUrl(view, '/forms/Orders'), 'https://api.example.test/server/c2c_api/forms/Orders');
});

test('a page whose address does not parse falls back to a fixed origin, which is not trusted for another host', () => {
  const { view } = fakeWindow({ href: 'not a url' });
  assert.equal(apiUrl(view, '/forms/Orders'), '/forms/Orders');
  assert.throws(() => apiUrl(view, 'https://evil.example.test/forms/Orders'), /refused/);
});

test('an api base that is not a web address grants no origin of its own', () => {
  // A javascript: base parses but is not https, so only the page origin stays allowed.
  const { view } = fakeWindow({ base: 'javascript:alert(1)//' });
  assert.throws(() => apiUrl(view, 'https://evil.example.test/x'), /refused/);
  assert.throws(() => apiUrl(view, '/forms/Orders'), /refused/, 'a relative endpoint joined onto it is no web request');
  // A base that cannot be parsed at all is also no trusted origin.
  const broken = fakeWindow({ base: 'https://[bad', href: 'https://app.example.test/' });
  assert.throws(() => apiUrl(broken.view, 'https://[bad/x'), /refused/);
});

test('a token source that throws or returns no string sends the call without authorization', async () => {
  const failing = fakeWindow({
    auth: {
      isUserAuthenticated: async () => {
        throw new Error('no session');
      },
      generateAuthToken: async () => ({ access_token: 'never' }),
    },
  });
  await createApi(failing.view).post('/forms/Orders', {});
  assert.equal(failing.sent[0]?.init.headers?.authorization, undefined, 'a failed session check attaches no token');
  assert.equal(failing.sent[0]?.init.credentials, undefined, 'a same-origin call with no token sends no cookies cross-site');

  const odd = fakeWindow({ auth: { generateAuthToken: async () => ({ access_token: 42 as unknown as string }) } });
  await createApi(odd.view).get('/lookups/Orders/Customer');
  assert.equal(odd.sent[0]?.init.headers?.authorization, undefined, 'a non-string token is not sent');
});

test('the request body writes a bigint id as its digit string, and extra headers ride along', async () => {
  const { view, sent } = fakeWindow({ auth: { generateAuthToken: async () => ({ access_token: 'tok' }) } });
  await createApi(view, async () => ({ 'x-c2c-route': 'form/Orders' })).post('/forms/Orders', { ID: 9007199254740993n });
  assert.equal(sent[0]?.init.body, '{"ID":"9007199254740993"}');
  assert.equal(sent[0]?.init.headers?.['x-c2c-route'], 'form/Orders');
  assert.equal(sent[0]?.init.headers?.authorization, 'tok');
  assert.equal(sent[0]?.init.credentials, 'include');
});

test('a reply body that is not JSON reads as undefined; an empty body too', async () => {
  const { view } = fakeWindow({ replies: [{ status: 400, text: '<html>oops' }, { status: 200, text: '' }] });
  const api = createApi(view);
  assert.deepEqual(await api.post('/forms/Orders', {}), { ok: false, status: 400, body: undefined });
  assert.deepEqual(await api.get('/lookups/Orders/Customer'), { ok: true, status: 200, body: undefined });
});

test('with no fetch the call fails with status 0 instead of throwing', async () => {
  const { view } = fakeWindow({ noFetch: true });
  assert.deepEqual(await createApi(view).post('/forms/Orders', {}), { ok: false, status: 0, body: undefined });
  const raw = await apiCall(view, '/forms/Orders');
  assert.equal(raw.status, 0);
  assert.equal(await raw.text(), '');
});

test('apiCall sends the method, headers and body it is given, and a configured base sends cookies', async () => {
  const { view, sent } = fakeWindow({ base: 'https://api.example.test', replies: [{ status: 204 }] });
  const res = await apiCall(view, '/smoke', { method: 'POST', headers: { 'x-a': '1' }, body: '{}' });
  assert.equal(res.status, 204);
  assert.deepEqual(sent[0], {
    url: 'https://api.example.test/smoke',
    init: { method: 'POST', headers: { 'x-a': '1' }, body: '{}', credentials: 'include' },
  });
  const bare = fakeWindow();
  await apiCall(bare.view, '/smoke');
  assert.deepEqual(bare.sent[0]?.init, { method: 'GET', headers: {} }, 'GET by default, no body, no cookies');
  await assert.rejects(apiCall(bare.view, 'https://evil.example.test/smoke'), /refused/);
  assert.equal(bare.sent.length, 1, 'a refused endpoint never reaches fetch');
});

test('a listener that cancels the session-expired event keeps the page where it is', () => {
  const { view, assigned, listeners } = fakeWindow();
  let detail: { login: string; looping: boolean } | undefined;
  listeners.push((e) => {
    detail = (e as CustomEvent).detail;
    e.preventDefault();
  });
  sessionExpired(view);
  assert.equal(detail?.login, loginUrl(view));
  assert.equal(detail?.looping, false);
  assert.deepEqual(assigned, [], 'a handled event does not redirect');
});

test('an unhandled session expiry redirects once per window, never twice', () => {
  const { view, assigned, events, storage } = fakeWindow();
  sessionExpired(view);
  // The sign-in mark is cleared so the loop guard does not stop the second call.
  (storage as Storage).removeItem('c2c-auth:sign-in-at');
  sessionExpired(view);
  assert.equal(events.length, 2, 'every expiry still tells the listeners');
  assert.deepEqual(assigned, ['/__catalyst/auth/login?service_url=https%3A%2F%2Fapp.example.test%2Fapp%2F%23%2Fform%2FOrders']);
});

test('sign-in without location.assign sets href, and refused storage does not stop the redirect', () => {
  const { view, location } = fakeWindow({ assign: false, storage: 'throws' });
  goToSignIn(view, '/__catalyst/auth/login?service_url=x');
  assert.equal(location.href, '/__catalyst/auth/login?service_url=x');
  // With storage refused the loop guard cannot read a mark: the expiry still redirects.
  const second = fakeWindow({ assign: false, storage: 'throws' });
  sessionExpired(second.view);
  assert.match(String(second.location.href), /^\/__catalyst\/auth\/login\?service_url=/);
});

test('a host that refuses navigation keeps the page without throwing', () => {
  const { view, location } = fakeWindow();
  location.assign = () => {
    throw new Error('navigation blocked');
  };
  assert.doesNotThrow(() => goToSignIn(view));
});

test('a page with no address signs in back to the site root', () => {
  const { view } = fakeWindow({ href: '' });
  assert.equal(loginUrl(view), '/__catalyst/auth/login?service_url=%2F');
});

test('a successful reply clears the sign-in mark so a later 401 may sign in again', async () => {
  const { view, storage } = fakeWindow({ replies: [{ status: 200, text: '{"ok":true}' }] });
  (storage as Storage).setItem('c2c-auth:sign-in-at', String(Date.now()));
  const reply = await createApi(view).get('/lookups/Orders/Customer');
  assert.deepEqual(reply.body, { ok: true });
  assert.equal((storage as Storage).getItem('c2c-auth:sign-in-at'), null);
});

test('the session-expired event name is the documented one', () => {
  assert.equal(SESSION_EXPIRED_EVENT, 'c2c:session-expired');
});
