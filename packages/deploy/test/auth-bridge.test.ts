/**
 * The c2c_auth token bridge (design d'): a Slate page cannot mint a functions
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

async function call(handler: (req: unknown, res: unknown) => unknown, url: string, env: Record<string, string | undefined>): Promise<Captured> {
  const previous = process.env.C2C_SLATE_ORIGIN;
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
    await handler({ method: 'GET', url, headers: {} }, fakeRes);
    return res;
  } finally {
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
