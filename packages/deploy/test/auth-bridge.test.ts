/**
 * The c2c_auth token bridge: a Slate page cannot mint a functions
 * token (its init.js leaves api_domain empty), so this function serves the
 * bridge page on the function origin. These tests load the generated index.js
 * and drive it with fake req/res — the page itself runs the Web SDK in a
 * browser, which the offline suite cannot do.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AUTH_FUNCTION, authBridgeFiles, slateOriginOf } from '../src/auth-bridge.js';

const STATE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'; // 43 chars
assert.equal(STATE.length, 43);

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function loadHandler(slateOrigin: string | undefined): { handler: (req: unknown, res: unknown) => Promise<void> | void; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-auth-bridge-'));
  const files = authBridgeFiles('in', slateOrigin);
  const index = files.find((file) => file.path.endsWith('/index.js'));
  assert.ok(index, 'authBridgeFiles emits index.js');
  writeFileSync(join(dir, 'index.cjs'), String(index.data));
  const require = createRequire(join(dir, 'index.cjs'));
  const handler = require(join(dir, 'index.cjs')) as (req: unknown, res: unknown) => Promise<void> | void;
  return { handler, dir };
}

async function call(
  handler: (req: unknown, res: unknown) => unknown,
  url: string,
  env: Record<string, string | undefined>,
  opts: { method?: string; headers?: Record<string, string>; logs?: string[] } = {},
): Promise<Captured> {
  const previous = process.env.C2C_SLATE_ORIGIN;
  const originalError = console.error;
  if (opts.logs) {
    const logs = opts.logs;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
  }
  if (env.C2C_SLATE_ORIGIN === undefined) delete process.env.C2C_SLATE_ORIGIN;
  else process.env.C2C_SLATE_ORIGIN = env.C2C_SLATE_ORIGIN;
  try {
    const res: Captured = { status: 0, headers: {}, body: '' };
    const fakeRes = {
      writeHead(status: number, headers: Record<string, string>) {
        res.status = status;
        res.headers = headers;
      },
      end(body?: string) {
        res.body = body ?? '';
      },
    };
    await handler({ method: opts.method ?? 'GET', url, headers: opts.headers ?? {} }, fakeRes);
    return res;
  } finally {
    console.error = originalError;
    if (previous === undefined) delete process.env.C2C_SLATE_ORIGIN;
    else process.env.C2C_SLATE_ORIGIN = previous;
  }
}

const SLATE = 'https://app-abc123.onslate.in';

test('the bridge answers GET /bridge with the strict headers and the configured origin', async () => {
  const { handler, dir } = loadHandler(SLATE);
  try {
    const res = await call(handler, `/server/${AUTH_FUNCTION}/bridge?state=${STATE}`, { C2C_SLATE_ORIGIN: SLATE });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] ?? '', /text\/html/);
    const csp = res.headers['content-security-policy'] ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]+' 'self' https:\/\/static\.zohocdn\.com/);
    assert.match(csp, /connect-src 'self' https:\/\/accounts\.zoho\.in https:\/\/accounts\.zohoportal\.in/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    // The page redirects to exactly the configured Slate origin, fragment-bound.
    assert.ok(res.body.includes(JSON.stringify(SLATE)));
    assert.ok(res.body.includes('/#c2c_auth='));
    assert.ok(res.body.includes('generateAuthToken'));
    assert.ok(res.body.includes('/__catalyst/sdk/init.js'));
    assert.ok(res.body.includes('/__catalyst/auth/login?service_url='));
    // The only reflected value is the validated state.
    assert.ok(res.body.includes(JSON.stringify(STATE)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed, short or missing state answers 400', async () => {
  const { handler, dir } = loadHandler(SLATE);
  try {
    for (const state of ['x', `${STATE}<`, STATE.slice(0, 42), `${STATE}~`]) {
      const res = await call(handler, `/server/${AUTH_FUNCTION}/bridge?state=${encodeURIComponent(state)}`, { C2C_SLATE_ORIGIN: SLATE });
      assert.equal(res.status, 400, `state ${JSON.stringify(state)} must refuse`);
    }
    const missing = await call(handler, `/server/${AUTH_FUNCTION}/bridge`, { C2C_SLATE_ORIGIN: SLATE });
    assert.equal(missing.status, 400);
    const otherPath = await call(handler, `/server/${AUTH_FUNCTION}/anything?state=${STATE}`, { C2C_SLATE_ORIGIN: SLATE });
    assert.equal(otherPath.status, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or invalid C2C_SLATE_ORIGIN answers 500 and never redirects', async () => {
  const { handler, dir } = loadHandler(undefined);
  try {
    for (const env of [undefined, '', 'https://*.onslate.in', 'https://evil.test/path', 'http://app-abc123.onslate.in', 'app-abc123.onslate.in']) {
      const res = await call(handler, `/server/${AUTH_FUNCTION}/bridge?state=${STATE}`, { C2C_SLATE_ORIGIN: env });
      assert.equal(res.status, 500, `env ${JSON.stringify(env)} must refuse`);
      assert.equal(res.headers.location, undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('?action=signout answers 200 with the signOut call and needs no state', async () => {
  const { handler, dir } = loadHandler(SLATE);
  try {
    const res = await call(handler, `/server/${AUTH_FUNCTION}/bridge?action=signout`, { C2C_SLATE_ORIGIN: SLATE });
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('signOut'));
    assert.ok(res.body.includes(JSON.stringify(SLATE)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authBridgeFiles emits the function tree and catalyst-config carries the origin', () => {
  const files = authBridgeFiles('in', SLATE);
  const paths = files.map((file) => file.path).sort();
  assert.deepEqual(paths, [`functions/${AUTH_FUNCTION}/catalyst-config.json`, `functions/${AUTH_FUNCTION}/index.js`, `functions/${AUTH_FUNCTION}/package.json`].sort());
  const config = JSON.parse(String(files.find((file) => file.path.endsWith('catalyst-config.json'))?.data)) as {
    deployment: { name: string; type: string; env_variables: Record<string, string> };
  };
  assert.equal(config.deployment.name, AUTH_FUNCTION);
  assert.equal(config.deployment.type, 'advancedio');
  assert.deepEqual(config.deployment.env_variables, { C2C_SLATE_ORIGIN: SLATE });
  // No origin known yet: the env is empty — the function refuses until set.
  const unconfigured = JSON.parse(String(authBridgeFiles('in', undefined).find((file) => file.path.endsWith('catalyst-config.json'))?.data)) as {
    deployment: { env_variables: Record<string, string> };
  };
  assert.deepEqual(unconfigured.deployment.env_variables, {});
});

test('authBridgeFiles can render a dry-run with an unresolved DC placeholder', () => {
  const files = authBridgeFiles('<dc>', undefined);
  assert.equal(files.length, 3);
  assert.match(String(files.find((file) => file.path.endsWith('/index.js'))?.data), /connect-src/);
});

test('slateOriginOf returns https://host for a valid Slate host and undefined otherwise', () => {
  assert.equal(slateOriginOf('app-abc123.onslate.in'), 'https://app-abc123.onslate.in');
  assert.equal(slateOriginOf('https://app-abc123.onslate.in'), 'https://app-abc123.onslate.in');
  assert.equal(slateOriginOf('*.onslate.in'), undefined);
  assert.equal(slateOriginOf('http://app-abc123.onslate.in'), undefined);
  assert.equal(slateOriginOf(undefined), undefined);
});

/** The structured failure lines the handler wrote, parsed. */
function failures(logs: string[]): Array<Record<string, unknown>> {
  return logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === 'c2c_auth.bridge_failure');
}

test('every server-side refusal writes one structured failure line without the state or origin', async () => {
  const { handler, dir } = loadHandler(SLATE);
  try {
    const cases: Array<{ url: string; env?: string; method?: string; reason: string; status: number }> = [
      { url: `/server/${AUTH_FUNCTION}/bridge?state=${STATE}`, method: 'POST', reason: 'method_not_allowed', status: 400 },
      { url: `/server/${AUTH_FUNCTION}/elsewhere?state=${STATE}`, reason: 'unknown_path', status: 400 },
      { url: `/server/${AUTH_FUNCTION}/bridge?state=${STATE.slice(0, 40)}`, reason: 'bad_state', status: 400 },
      { url: `/server/${AUTH_FUNCTION}/bridge?state=${STATE}`, env: '', reason: 'slate_origin_unset', status: 500 },
    ];
    for (const item of cases) {
      const logs: string[] = [];
      const res = await call(handler, item.url, { C2C_SLATE_ORIGIN: item.env ?? SLATE }, { method: item.method, logs });
      assert.equal(res.status, item.status, item.reason);
      const lines = failures(logs);
      assert.equal(lines.length, 1, `${item.reason} logs exactly one failure line`);
      assert.equal(lines[0]?.side, 'server');
      assert.equal(lines[0]?.reason, item.reason);
      for (const line of logs) {
        assert.ok(!line.includes(STATE.slice(0, 40)), 'the state value never reaches the log');
        assert.ok(!line.includes('onslate'), 'the Slate origin never reaches the log');
      }
    }
    // A served page is not a failure: no line.
    const logs: string[] = [];
    const ok = await call(handler, `/server/${AUTH_FUNCTION}/bridge?state=${STATE}`, { C2C_SLATE_ORIGIN: SLATE }, { logs });
    assert.equal(ok.status, 200);
    assert.deepEqual(failures(logs), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a thrown handler error logs the error class only and answers 500', async () => {
  const { handler, dir } = loadHandler(SLATE);
  try {
    const logs: string[] = [];
    const res: Captured = { status: 0, headers: {}, body: '' };
    let first = true;
    const fakeRes = {
      writeHead(status: number, headers: Record<string, string>) {
        if (first) {
          first = false;
          throw new TypeError(`secret-${STATE}`);
        }
        res.status = status;
        res.headers = headers;
      },
      end(body?: string) {
        res.body = body ?? '';
      },
    };
    const originalError = console.error;
    const previous = process.env.C2C_SLATE_ORIGIN;
    process.env.C2C_SLATE_ORIGIN = SLATE;
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await handler({ method: 'GET', url: `/server/${AUTH_FUNCTION}/bridge?state=${STATE}`, headers: {} }, fakeRes);
    } finally {
      console.error = originalError;
      if (previous === undefined) delete process.env.C2C_SLATE_ORIGIN;
      else process.env.C2C_SLATE_ORIGIN = previous;
    }
    assert.equal(res.status, 500);
    const lines = failures(logs);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.reason, 'exception');
    assert.equal(lines[0]?.error, 'TypeError');
    assert.ok(!logs.join('\n').includes('secret-'), 'the error message never reaches the log');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /bridge/report logs an allowlisted client failure and answers 204', async () => {
  const { handler, dir } = loadHandler(SLATE);
  try {
    const logs: string[] = [];
    const res = await call(
      handler,
      `/server/${AUTH_FUNCTION}/bridge/report?reason=signin_not_finished&status=401&code=AUTHENTICATION_FAILURE&sdk=net-issue`,
      { C2C_SLATE_ORIGIN: SLATE },
      { logs },
    );
    assert.equal(res.status, 204);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(failures(logs), [
      { event: 'c2c_auth.bridge_failure', side: 'client', reason: 'signin_not_finished', status: 401, code: 'AUTHENTICATION_FAILURE', sdk: 'net-issue' },
    ]);
    for (const reason of ['sdk_unavailable', 'no_token', 'token_failed']) {
      const more: string[] = [];
      const ok = await call(handler, `/server/${AUTH_FUNCTION}/bridge/report?reason=${reason}`, { C2C_SLATE_ORIGIN: SLATE }, { logs: more });
      assert.equal(ok.status, 204, reason);
      assert.equal(failures(more)[0]?.reason, reason);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /bridge/report refuses unknown reasons and drops values that are not short codes', async () => {
  const { handler, dir } = loadHandler(SLATE);
  try {
    const logs: string[] = [];
    const bad = await call(handler, `/server/${AUTH_FUNCTION}/bridge/report?reason=${encodeURIComponent('<script>')}`, { C2C_SLATE_ORIGIN: SLATE }, { logs });
    assert.equal(bad.status, 400);
    assert.deepEqual(failures(logs).map((line) => line.reason), ['bad_report']);
    assert.ok(!logs.join('\n').includes('script'));

    const token = 'x'.repeat(200);
    const noisy: string[] = [];
    const res = await call(
      handler,
      `/server/${AUTH_FUNCTION}/bridge/report?reason=no_token&status=9999&code=${token}&sdk=${encodeURIComponent('a b@c.d')}`,
      { C2C_SLATE_ORIGIN: SLATE },
      { logs: noisy },
    );
    assert.equal(res.status, 204);
    assert.deepEqual(failures(noisy), [{ event: 'c2c_auth.bridge_failure', side: 'client', reason: 'no_token' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Run the bridge page's inline script against a fake browser. */
async function runPage(
  body: string,
  opts: { authenticated: boolean; marked: boolean; token?: string; currentUser?: { status: number; error_code?: string } },
): Promise<{ fetched: string[]; message: string; navigatedTo: string[]; marker: string | null }> {
  const scripts = [...body.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '');
  const inline = scripts[scripts.length - 1] ?? '';
  const storage = new Map<string, string>();
  if (opts.marked) storage.set('c2c.bridge.login-at', String(Date.now() - 1000));
  const fetched: string[] = [];
  const navigatedTo: string[] = [];
  const msg = { textContent: '' };
  const auth = {
    isUserAuthenticated: () => (opts.authenticated ? Promise.resolve({ status: 200 }) : Promise.reject({ code: 'net-issue', message: 'x' })),
    generateAuthToken: () => Promise.resolve(opts.token ? { access_token: opts.token } : {}),
  };
  const sandbox = {
    window: { catalyst: { auth } },
    document: { getElementById: () => msg },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
    location: {
      pathname: `/server/${AUTH_FUNCTION}/bridge`,
      search: `?state=${STATE}`,
      assign: (url: string) => void navigatedTo.push(url),
      replace: (url: string) => void navigatedTo.push(url),
    },
    fetch: (url: string) => {
      fetched.push(url);
      const user = opts.currentUser ?? { status: 401, error_code: 'AUTHENTICATION_FAILURE' };
      return Promise.resolve({ status: user.status, json: () => Promise.resolve({ data: { error_code: user.error_code } }) });
    },
    encodeURIComponent,
    Date,
    Number,
    String,
    Promise,
    isFinite,
  };
  const { runInNewContext } = await import('node:vm');
  runInNewContext(inline, sandbox);
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  return { fetched, message: msg.textContent, navigatedTo, marker: storage.get('c2c.bridge.login-at') ?? null };
}

test('the page reports a sign-in that did not finish with the current-user status and clears the marker', async () => {
  const { handler, dir } = loadHandler(SLATE);
  try {
    const page = await call(handler, `/server/${AUTH_FUNCTION}/bridge?state=${STATE}`, { C2C_SLATE_ORIGIN: SLATE }, { headers: { 'x-zc-projectid': '12345' } });
    const run = await runPage(page.body, { authenticated: false, marked: true });
    assert.match(run.message, /Sign-in did not finish/);
    assert.deepEqual(run.navigatedTo, [], 'no redirect loop');
    assert.ok(run.fetched.includes('/baas/v1/project/12345/project-user/current'), 'probes the current user');
    const report = run.fetched.find((url) => url.includes('/bridge/report?'));
    assert.equal(report, `/server/${AUTH_FUNCTION}/bridge/report?reason=signin_not_finished&status=401&code=AUTHENTICATION_FAILURE&sdk=net-issue`);
    assert.equal(run.marker, null, 'a reload starts a fresh sign-in instead of failing again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the page sends the first unauthenticated visit to hosted login without a report', async () => {
  const { handler, dir } = loadHandler(SLATE);
  try {
    const page = await call(handler, `/server/${AUTH_FUNCTION}/bridge?state=${STATE}`, { C2C_SLATE_ORIGIN: SLATE });
    const run = await runPage(page.body, { authenticated: false, marked: false });
    assert.equal(run.navigatedTo.length, 1);
    assert.ok(run.navigatedTo[0]?.startsWith('/__catalyst/auth/login?service_url='));
    assert.deepEqual(run.fetched, []);
    assert.notEqual(run.marker, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the page reports a missing token and hands a real token back to Slate without reporting', async () => {
  const { handler, dir } = loadHandler(SLATE);
  try {
    const page = await call(handler, `/server/${AUTH_FUNCTION}/bridge?state=${STATE}`, { C2C_SLATE_ORIGIN: SLATE });
    const missing = await runPage(page.body, { authenticated: true, marked: false });
    assert.deepEqual(missing.fetched, [`/server/${AUTH_FUNCTION}/bridge/report?reason=no_token`]);
    const ok = await runPage(page.body, { authenticated: true, marked: true, token: 'tok' });
    assert.deepEqual(ok.fetched, []);
    assert.deepEqual(ok.navigatedTo, [`${SLATE}/#c2c_auth=tok&state=${STATE}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
