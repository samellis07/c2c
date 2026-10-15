/**
 * The Slate token bridge (design d') on the client: fragment intake with the
 * state check, the Authorization header with no cookies, and the loop-guarded
 * redirect on a missing or refused token.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  apiCall,
  bridgeRedirect,
  createApi,
  hasBridgeToken,
  intakeBridgeFragment,
  SESSION_EXPIRED_EVENT,
  type AppWindow,
} from '../template/lib/c2c-ui/runtime/api.js';

const BRIDGE = 'https://fn.example.test/server/c2c_auth/bridge';
const BASE = 'https://fn.example.test/server/c2c_api';

interface Sent {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string; credentials?: string };
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

function fakeWindow(opts: { hash?: string; replies?: Array<{ status: number; text?: string }>; storage?: Storage } = {}) {
  const sent: Sent[] = [];
  const assigned: string[] = [];
  const replaced: string[] = [];
  const storage = opts.storage ?? memoryStorage();
  const replies = [...(opts.replies ?? [])];
  const events: Event[] = [];
  const view = {
    C2C_API_BASE: BASE,
    C2C_AUTH_BRIDGE: BRIDGE,
    crypto: globalThis.crypto,
    sessionStorage: storage,
    location: {
      href: `https://app.example.test/app/${opts.hash ?? ''}`,
      pathname: '/app/',
      hash: opts.hash ?? '',
      assign: (url: string) => void assigned.push(url),
    },
    history: { replaceState: (_s: unknown, _t: unknown, url: string) => void replaced.push(url) },
    dispatchEvent(event: Event) {
      events.push(event);
      return !event.defaultPrevented;
    },
    CustomEvent,
    fetch: async (url: string, init: Sent['init']) => {
      sent.push({ url, init });
      const next = replies.shift() ?? { status: 200, text: '{}' };
      return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => next.text ?? '' };
    },
  };
  return { view: view as unknown as AppWindow, sent, assigned, replaced, storage, events };
}

/** Stand a state in storage like a real bridgeRedirect did. */
function armedState(storage: Storage, state: string): void {
  storage.setItem('c2c.bridge.state', state);
}

test('a fragment with the matching state stores the token, strips the fragment and restores the route', () => {
  const { view, replaced, storage } = fakeWindow({ hash: '#c2c_auth=Bearer%20tok-1&state=s-43' });
  armedState(storage, 's-43');
  storage.setItem('c2c.bridge.route', '/#/admin/smoke');
  intakeBridgeFragment(view);
  assert.equal(storage.getItem('c2c.bridge.token'), 'Bearer tok-1');
  assert.equal(storage.getItem('c2c.bridge.state'), null, 'a state is consumed once');
  assert.deepEqual(replaced, ['/app//#/admin/smoke']);
  assert.equal(hasBridgeToken(view), true);
});

test('a fragment whose state does not match is refused — the token is dropped', () => {
  const { view, replaced, storage } = fakeWindow({ hash: '#c2c_auth=bogus&state=bogus' });
  // No stored state at all (an attacker link in a fresh tab).
  intakeBridgeFragment(view);
  assert.equal(storage.getItem('c2c.bridge.token'), null);
  assert.deepEqual(replaced, ['/app/'], 'the fragment is still stripped');

  const mismatch = fakeWindow({ hash: '#c2c_auth=bogus&state=wrong' });
  armedState(mismatch.storage, 'right');
  intakeBridgeFragment(mismatch.view);
  assert.equal(mismatch.storage.getItem('c2c.bridge.token'), null, 'a foreign token never lands');
});

test('bridge calls carry the token as Authorization and never send cookies', async () => {
  const { view, sent, storage } = fakeWindow();
  storage.setItem('c2c.bridge.token', 'Bearer tok-2');
  const res = await apiCall(view, '/admin/smoke', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(sent[0]?.init.headers?.authorization, 'Bearer tok-2');
  assert.equal(sent[0]?.init.credentials, 'omit');
});

test('a 401 drops the token and takes exactly one bridge trip; the next one inside the window is refused', async () => {
  const { view, assigned, storage } = fakeWindow({ replies: [{ status: 401 }, { status: 401 }] });
  storage.setItem('c2c.bridge.token', 'Bearer stale');
  const api = createApi(view);
  const reply = await api.post('/forms/Book/submit', {});
  assert.equal(reply.status, 401);
  assert.equal(storage.getItem('c2c.bridge.token'), null, 'the refused token is dropped');
  assert.equal(assigned.length, 1);
  assert.match(assigned[0] ?? '', /^https:\/\/fn\.example\.test\/server\/c2c_auth\/bridge\?state=[A-Za-z0-9_-]{43}$/);
  assert.equal(storage.getItem('c2c.bridge.state')?.length, 43, 'the state waits for the fragment');
  // A second refusal inside the window must not redirect again — the
  // session-expired event fires for the prompt instead.
  const again = await api.post('/forms/Book/submit', {});
  assert.equal(again.status, 401);
  assert.equal(assigned.length, 1, 'no second navigation inside the loop window');
});

test('bridgeRedirect refuses a non-https bridge and navigates once', () => {
  const { view, assigned, storage } = fakeWindow();
  view.C2C_AUTH_BRIDGE = 'javascript:alert(1)';
  assert.equal(bridgeRedirect(view), false);
  assert.equal(assigned.length, 0);
  view.C2C_AUTH_BRIDGE = BRIDGE;
  assert.equal(bridgeRedirect(view), true);
  assert.equal(assigned.length, 1);
  assert.match(assigned[0] ?? '', /\?state=[A-Za-z0-9_-]{43}$/);
  assert.equal(storage.getItem('c2c.bridge.route'), '/app/', 'the route is remembered for the return');
  assert.equal(bridgeRedirect(view), false, 'loop guard refuses a second trip');
  assert.equal(bridgeRedirect(view, true), true, 'a deliberate sign-in retries anyway');
});

test('the session-expired event still fires when the bridge trip is refused', async () => {
  const { view, events, storage } = fakeWindow({ replies: [{ status: 401 }] });
  storage.setItem('c2c.bridge.at', String(Date.now()), );
  storage.setItem('c2c.bridge.token', 'Bearer stale');
  const reply = await createApi(view).get('/lookups/Book/Genre');
  assert.equal(reply.status, 401);
  assert.equal(events.filter((event) => event.type === SESSION_EXPIRED_EVENT).length, 1);
});
