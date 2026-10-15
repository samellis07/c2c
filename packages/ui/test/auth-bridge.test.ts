/**
 * The vanilla client's token bridge (design d'), mirroring
 * packages/ui-react/test/auth-bridge.test.ts: fragment intake with the state
 * check, Authorization with no cookies, and the loop-guarded redirect.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

interface Runtime {
  apiCall(call: (url: string, init: Record<string, unknown>) => Promise<{ status: number }>, view: unknown, endpoint: string, init?: Record<string, unknown>): Promise<{ status: number }>;
  intakeBridgeFragment(view: unknown): void;
  bridgeRedirect(view: unknown, force?: boolean): boolean;
  hasBridgeToken(view: unknown): boolean;
}

async function loadRuntime(): Promise<Runtime> {
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return (await import(url)) as Runtime;
}

const BRIDGE = 'https://fn.example.test/server/c2c_auth/bridge';
const BASE = 'https://fn.example.test/server/c2c_api';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
  };
}

function fakeView(opts: { hash?: string } = {}) {
  const assigned: string[] = [];
  const replaced: string[] = [];
  const sessionStorage = memoryStorage();
  const view = {
    C2C_API_BASE: BASE,
    C2C_AUTH_BRIDGE: BRIDGE,
    crypto: globalThis.crypto,
    sessionStorage,
    location: {
      href: `https://app.example.test/app/${opts.hash ?? ''}`,
      pathname: '/app/',
      hash: opts.hash ?? '',
      assign: (url: string) => void assigned.push(url),
    },
    history: { replaceState: (_s: unknown, _t: unknown, url: string) => void replaced.push(url) },
  };
  return { view, assigned, replaced, sessionStorage };
}

test('a fragment with the matching state stores the token and strips the fragment', async () => {
  const runtime = await loadRuntime();
  const { view, replaced, sessionStorage } = fakeView({ hash: '#c2c_auth=tok-1&state=s-1' });
  sessionStorage.setItem('c2c.bridge.state', 's-1');
  sessionStorage.setItem('c2c.bridge.route', '/#/form/Book');
  runtime.intakeBridgeFragment(view);
  assert.equal(sessionStorage.getItem('c2c.bridge.token'), 'tok-1');
  assert.deepEqual(replaced, ['/app//#/form/Book']);
});

test('a mismatched or unsigned state drops the token (must fail without the compare)', async () => {
  const runtime = await loadRuntime();
  const noState = fakeView({ hash: '#c2c_auth=bogus&state=x' });
  runtime.intakeBridgeFragment(noState.view);
  assert.equal(noState.sessionStorage.getItem('c2c.bridge.token'), null);
  const wrong = fakeView({ hash: '#c2c_auth=bogus&state=x' });
  wrong.sessionStorage.setItem('c2c.bridge.state', 'y');
  runtime.intakeBridgeFragment(wrong.view);
  assert.equal(wrong.sessionStorage.getItem('c2c.bridge.token'), null);
});

test('a bridge call sends Authorization and credentials omit; a 401 drops the token and redirects once', async () => {
  const runtime = await loadRuntime();
  const { view, assigned, sessionStorage } = fakeView();
  sessionStorage.setItem('c2c.bridge.token', 'Bearer tok');
  const sent: Array<{ url: string; init: Record<string, unknown> }> = [];
  const call = async (url: string, init: Record<string, unknown>) => {
    sent.push({ url, init });
    return { status: 401 };
  };
  const res = await runtime.apiCall(call, view, '/admin/smoke', { method: 'POST' });
  assert.equal(res.status, 401);
  assert.equal((sent[0]?.init.headers as Record<string, string>).authorization, 'Bearer tok');
  assert.equal(sent[0]?.init.credentials, 'omit');
  assert.equal(sessionStorage.getItem('c2c.bridge.token'), null);
  assert.equal(assigned.length, 1);
  assert.match(assigned[0] ?? '', /^https:\/\/fn\.example\.test\/server\/c2c_auth\/bridge\?state=[A-Za-z0-9_-]{43}$/);
  // Inside the loop window a second refusal must not navigate again.
  await runtime.apiCall(call, view, '/admin/smoke', { method: 'POST' });
  assert.equal(assigned.length, 1);
});

test('bridgeRedirect remembers the route and refuses a non-web bridge', async () => {
  const runtime = await loadRuntime();
  const { view, assigned, sessionStorage } = fakeView();
  assert.equal(runtime.bridgeRedirect(view), true);
  assert.equal(assigned.length, 1);
  assert.equal(sessionStorage.getItem('c2c.bridge.route'), '/app/');
  const evil = fakeView();
  (evil.view as Record<string, unknown>).C2C_AUTH_BRIDGE = 'javascript:alert(1)';
  assert.equal(runtime.bridgeRedirect(evil.view), false);
});
