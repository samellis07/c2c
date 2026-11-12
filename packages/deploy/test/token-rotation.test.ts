/**
 * A read that meets 401 INVALID_TOKEN must never rotate a shared credential.
 *
 * The Catalyst CLI's forced refresh (getAccessToken(true)) POSTs the refresh
 * token and stores the answer; when the token endpoint rotates the refresh
 * token, every other holder of the old one (an outside refresher, a sibling
 * run) then fails with "Error when refreshing the access token" until a new
 * login. Its non-forced getAccessToken() refreshes the same way when the
 * stored token is close to expiry, so it is not a safe re-read either.
 *
 * These tests run the real spawn path against a fake CLI library that keeps
 * those semantics: a rotating token endpoint, one credential store file, and
 * a log of every refresh POST.
 *
 *  A  default: a 401 whose stored token is unchanged is not retried and
 *     sends no refresh POST; the outside refresher keeps working.
 *  B  default: the store holds a newer token (an outside refresher ran):
 *     the read is retried once with it, with no refresh POST.
 *  C  default: a stale store at re-read time sends no refresh POST.
 *  D  C2C_ALLOW_LOCAL_REFRESH=1 (one user, one credential): the retry may
 *     force a refresh; any other holder of the old refresh token (a
 *     concurrent run on the same credential) then fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { catalystRestCall, readCliAccessToken } from '../src/rest.js';

const ORG = '10000000000';
const PROJECT = '10000000001';
const MINUTE = 60_000;

/** The token endpoint and its access tokens. Every refresh POST rotates the refresh token. */
const FAKE_ZOHO = `'use strict';
const fs = require('fs');
const path = require('path');
// Bound at load: the REST hook records the JSON.parse text of a call's answer.
const parse = JSON.parse.bind(JSON);
const dir = () => process.env.C2C_FAKE_DIR;
const serverFile = () => path.join(dir(), 'server.json');
function server() { return parse(fs.readFileSync(serverFile(), 'utf8')); }
function save(s) { fs.writeFileSync(serverFile(), JSON.stringify(s)); }
function readStore(file) { return parse(fs.readFileSync(file, 'utf8')); }
function writeStore(file, credential) { const s = readStore(file); s.credential = credential; fs.writeFileSync(file, JSON.stringify(s)); }
/** POST /oauth/v2/token: rotates, or invalid_grant for a refresh token that is no longer live. */
function refresh(actor, rToken) {
  const s = server();
  const ok = rToken === s.live;
  fs.appendFileSync(path.join(dir(), 'posts.log'), actor + ' ' + rToken + ' ' + (ok ? 'ok' : 'invalid_grant') + '\\n');
  if (!ok) return null;
  s.seq += 1;
  s.live = 'r' + s.seq;
  const access = 'a' + s.seq;
  s.valid.push(access);
  save(s);
  return { refresh_token: s.live, access_token: access, expires_at: Date.now() + 60 * 60 * 1000 };
}
function accessValid(token) { return server().valid.includes(token); }
module.exports = { refresh, accessValid, readStore, writeStore };
`;

/** credential.js: rToken frozen at init; accessToken is a pure read; getAccessToken refreshes when forced or stale. */
const FAKE_CREDENTIAL = `'use strict';
const zoho = require('../fake-zoho.js');
const parse = JSON.parse.bind(JSON);
const SKEW = 15 * 60 * 1000;
class Credential {
  constructor(obj) { this.rToken = obj.refresh_token; }
  static init(raw) { Credential.globalSelf = new Credential(parse(raw)); return Credential.globalSelf; }
  get accessToken() {
    const c = zoho.readStore(process.env.C2C_FAKE_STORE).credential;
    if (c && c.refresh_token === this.rToken && c.expires_at > Date.now() + SKEW) return c.access_token;
    return null;
  }
  async refreshAccessToken() {
    const next = zoho.refresh(process.env.C2C_FAKE_ACTOR || 'cli', this.rToken);
    if (!next) throw new Error('Error when refreshing the access token');
    zoho.writeStore(process.env.C2C_FAKE_STORE, next);
    this.rToken = next.refresh_token;
    return next;
  }
  static async getAccessToken(force = false) {
    if (!Credential.globalSelf) Credential.init(JSON.stringify(zoho.readStore(process.env.C2C_FAKE_STORE).credential));
    const token = Credential.globalSelf.accessToken;
    if (token === null || force) return (await Credential.globalSelf.refreshAccessToken()).access_token;
    return token;
  }
}
Credential.globalSelf = null;
module.exports = { default: Credential };
`;

const FAKE_CONFIG_STORE = `'use strict';
const zoho = require('../fake-zoho.js');
class Store {
  static get(key, fallback) {
    if (key !== 'in.credential') return fallback;
    const c = zoho.readStore(process.env.C2C_FAKE_STORE).credential;
    return c ? JSON.stringify(c) : fallback;
  }
  static set() {}
}
module.exports = { default: Store };
`;

const FAKE_DC = `'use strict';
module.exports = { getActiveDC: () => 'in' };
`;

/** api.js: the auth header comes from the lazy getAccessToken(); a lapsed token answers the recorded 401. */
const FAKE_API = `'use strict';
const fs = require('fs');
const path = require('path');
const zoho = require('../fake-zoho.js');
const Credential = require('../authentication/credential.js').default;
class FakeAPI {
  constructor() {}
  async get() { return this.answer('GET'); }
  async post() { return this.answer('POST'); }
  async answer(method) {
    const token = await Credential.getAccessToken();
    fs.appendFileSync(path.join(process.env.C2C_FAKE_DIR, 'calls.log'), method + '\\n');
    if (zoho.accessValid(token)) return { statusCode: 200, body: { data: { id: process.env.C2C_FAKE_PROJECT } } };
    // What happens elsewhere while this answer travels back.
    if (process.env.C2C_FAKE_ON_401 === 'outside-refresh') {
      const store = process.env.C2C_FAKE_STORE;
      const next = zoho.refresh('outside', zoho.readStore(store).credential.refresh_token);
      if (next) zoho.writeStore(store, next);
    } else if (process.env.C2C_FAKE_ON_401 === 'store-goes-stale') {
      const store = process.env.C2C_FAKE_STORE;
      zoho.writeStore(store, { ...zoho.readStore(store).credential, expires_at: 0 });
    }
    return { statusCode: 401, body: { error_code: 'INVALID_TOKEN', message: 'invalid oauth token' } };
  }
}
module.exports = { default: FakeAPI };
`;

interface Rig {
  env: NodeJS.ProcessEnv;
  dir: string;
  store: string;
  /** Every refresh POST: `<actor> <refresh-token> ok|invalid_grant`. */
  posts: () => string[];
  calls: () => string[];
  /** Every CLI command line, one per spawned process. */
  argv: () => string[];
  live: () => string;
  lines: string[];
  log: (line: string) => void;
  zoho: { refresh: (actor: string, rToken: string) => { refresh_token: string; access_token: string; expires_at: number } | null };
}

/**
 * One credential: refresh token r0, access token a0 that the store still
 * calls fresh but the service already treats as lapsed (the hourly edge).
 */
function rig(opts: { onUnauthorized?: 'outside-refresh' | 'store-goes-stale'; storeExpiresAt?: number } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-rotation-test-'));
  // Pin CommonJS so a TMPDIR under a {"type":"module"} package.json cannot change how these fixtures load.
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
  const binDir = join(dir, 'bin');
  for (const sub of ['internal', 'authentication', 'util_modules']) mkdirSync(join(binDir, sub), { recursive: true });
  const bin = join(binDir, 'catalyst');
  // Fake catalyst bin: records its command line and exits; the -r hook does the work.
  writeFileSync(bin, `'use strict';\nrequire('fs').appendFileSync(require('path').join(process.env.C2C_FAKE_DIR, 'argv.log'), process.argv.slice(2).join(' ') + '\\n');\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(binDir, 'fake-zoho.js'), FAKE_ZOHO);
  writeFileSync(join(binDir, 'authentication', 'credential.js'), FAKE_CREDENTIAL);
  writeFileSync(join(binDir, 'util_modules', 'config-store.js'), FAKE_CONFIG_STORE);
  writeFileSync(join(binDir, 'util_modules', 'dc.js'), FAKE_DC);
  writeFileSync(join(binDir, 'internal', 'api.js'), FAKE_API);
  writeFileSync(join(dir, 'server.json'), JSON.stringify({ live: 'r0', seq: 0, valid: [] }));
  writeFileSync(join(dir, 'posts.log'), '');
  writeFileSync(join(dir, 'calls.log'), '');
  writeFileSync(join(dir, 'argv.log'), '');
  const store = join(dir, 'store.json');
  writeFileSync(store, JSON.stringify({ credential: { refresh_token: 'r0', access_token: 'a0', expires_at: opts.storeExpiresAt ?? Date.now() + 40 * MINUTE } }));
  const env: NodeJS.ProcessEnv = {
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    C2C_FAKE_DIR: dir,
    C2C_FAKE_STORE: store,
    C2C_FAKE_ACTOR: 'run',
    C2C_FAKE_PROJECT: PROJECT,
    ...(opts.onUnauthorized ? { C2C_FAKE_ON_401: opts.onUnauthorized } : {}),
  };
  const read = (name: string) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean);
  const lines: string[] = [];
  const zoho = createRequire(import.meta.url)(join(binDir, 'fake-zoho.js')) as Rig['zoho'];
  return {
    env,
    dir,
    store,
    posts: () => read('posts.log'),
    calls: () => read('calls.log'),
    argv: () => read('argv.log'),
    live: () => (JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')) as { live: string }).live,
    lines,
    log: (line) => lines.push(line),
    zoho,
  };
}

/** One tick of an outside refresher holding refresh token `rToken` (its own copy of the credential). */
function outsideRefresh(r: Rig, rToken: string): 'ok' | 'Error when refreshing the access token' {
  const env = process.env;
  process.env = { ...env, C2C_FAKE_DIR: r.dir };
  try {
    return r.zoho.refresh('outside', rToken) ? 'ok' : 'Error when refreshing the access token';
  } finally {
    process.env = env;
  }
}

const GET_PROJECT = { method: 'GET' as const, path: `/baas/v1/project/${PROJECT}` };

test('A: a 401 INVALID_TOKEN whose stored token is unchanged is not retried and sends no refresh POST', async () => {
  const r = rig();
  const res = await catalystRestCall(r.env, ORG, PROJECT, GET_PROJECT, { log: r.log });
  assert.equal(res.status, 401);
  assert.deepEqual(r.calls(), ['GET']);
  assert.deepEqual(r.posts(), [], 'the read must never refresh the shared credential');
  assert.equal(r.live(), 'r0');
  // The outside refresher and a sibling holding r0 keep working.
  assert.equal(outsideRefresh(r, 'r0'), 'ok');
  assert.ok(r.lines.some((line) => /INVALID_TOKEN/.test(line) && /not retried/.test(line)), r.lines.join('\n'));
});

test('B: the store holds a newer token from an outside refresh — one retry with it, no refresh POST from the run', async () => {
  const r = rig({ onUnauthorized: 'outside-refresh' });
  const res = await catalystRestCall(r.env, ORG, PROJECT, GET_PROJECT, { log: r.log });
  assert.equal(res.status, 200);
  assert.deepEqual(r.calls(), ['GET', 'GET']);
  assert.deepEqual(r.posts(), ['outside r0 ok'], 'only the outside refresher POSTs');
  // The re-read runs on a command that makes no API call.
  assert.deepEqual(r.argv(), [`--org ${ORG} --project ${PROJECT} project:list`, '--version', `--org ${ORG} --project ${PROJECT} project:list`]);
  // The outside refresher's chain is intact.
  assert.equal(outsideRefresh(r, 'r1'), 'ok');
  assert.ok(r.lines.some((line) => /retried once/.test(line)), r.lines.join('\n'));
  assert.ok(r.lines.every((line) => !/\ba\d+\b|\br\d+\b/.test(line)), 'no token in the output');
});

test('C: a store that is stale at re-read time is not refreshed by the re-read', async () => {
  const r = rig({ onUnauthorized: 'store-goes-stale' });
  const res = await catalystRestCall(r.env, ORG, PROJECT, GET_PROJECT, { log: r.log });
  assert.equal(res.status, 401);
  assert.deepEqual(r.calls(), ['GET']);
  assert.deepEqual(r.posts(), []);
  assert.equal(outsideRefresh(r, 'r0'), 'ok');
});

test('C: the CLI getAccessToken() on a stale store is itself a refresh POST — why the re-read uses the pure getter', async () => {
  const r = rig({ storeExpiresAt: 0 });
  await readCliAccessToken(r.env, ORG, PROJECT);
  assert.deepEqual(r.posts(), ['run r0 ok']);
  assert.equal(outsideRefresh(r, 'r0'), 'Error when refreshing the access token');
});

test('D: with C2C_ALLOW_LOCAL_REFRESH=1 the retry forces one refresh; another holder of the old refresh token then fails', async () => {
  const r = rig();
  r.env.C2C_ALLOW_LOCAL_REFRESH = '1';
  const res = await catalystRestCall(r.env, ORG, PROJECT, GET_PROJECT, { log: r.log });
  assert.equal(res.status, 200);
  assert.deepEqual(r.calls(), ['GET', 'GET']);
  assert.deepEqual(r.posts(), ['run r0 ok']);
  // Safe for the only holder of the credential; a concurrent run that read
  // r0 before the rotation breaks itself. Serialize runs on one credential.
  assert.equal(outsideRefresh(r, 'r0'), 'Error when refreshing the access token');
});
