import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadBackError, readBack, readBackUrl } from '../api-readback.mjs';

// A real Catalyst Advanced I/O function host shape (Development-DC .in,
// documented in plugin/references/facts/functions.md): the fixture host
// must look like a genuine Catalyst function origin now that readBackUrl
// refuses anything else.
const INVOKE = 'https://c2c-bom-1001.development.catalystserverless.in/server/c2c_api/';
const reply = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
/** A stub that records requests and answers 401 unless the raw token matches. */
function stub(good) {
  const hits = [];
  const fetchImpl = async (url, init) => {
    hits.push({ url, init });
    return init.headers.authorization === good ? reply(200, { rows: [{ Name: 'Steel' }] }) : reply(401, { code: 'NO_ACCESS' });
  };
  return { fetchImpl, hits };
}

test('the url join keeps one slash and refuses a non-URL', () => {
  assert.equal(readBackUrl(INVOKE, '/reports/Items?page=0'), `${INVOKE.replace(/\/+$/, '')}/reports/Items?page=0`);
  assert.throws(() => readBackUrl('nope', '/x'), ReadBackError);
});

test('readBackUrl accepts every real Catalyst DC and refuses the attack scenarios the restriction exists for', () => {
  for (const dc of ['com.au', 'com', 'eu', 'in', 'jp', 'ca', 'sa', 'ae']) {
    assert.doesNotThrow(() => readBackUrl(`https://c2c-widget-1001.development.catalystserverless.${dc}/server/c2c_api`, '/x'), dc);
  }
  const rejected = [
    'http://c2c-widget-1001.development.catalystserverless.in/server/c2c_api',
    'http://evil.example/server/c2c_api',
    'https://user:pass@evil.example/server/c2c_api',
    'https://c2c-widget-1001.development.catalystserverless.com.evil.com/server/c2c_api',
    'https://evilcatalystserverless.com/server/c2c_api',
    'https://c2c-widget-1001.development.catalystserverless.in./server/c2c_api',
    'https://not-a-catalyst-host.example/server/c2c_api',
    'http://other-host.example:8080/server/c2c_api',
  ];
  for (const url of rejected) assert.throws(() => readBackUrl(url, '/x'), ReadBackError, url);
  // The localhost HTTP exception never leaks to another host or port.
  assert.doesNotThrow(() => readBackUrl('http://localhost:3000/server/c2c_api', '/x'));
  assert.doesNotThrow(() => readBackUrl('http://127.0.0.1:3000/server/c2c_api', '/x'));
  // userinfo on an otherwise-allowed host is benign: URL.hostname is parsed
  // correctly regardless, and the request target is not redirected.
  assert.doesNotThrow(() => readBackUrl('https://user:pass@c2c-widget-1001.development.catalystserverless.com/server/c2c_api', '/x'));
});

test('the Catalyst-function-origin allow-list never drifts from packages/ui/src/csp.ts', async () => {
  const { FUNCTION_HOST } = await import('../../../dist/ui/src/csp.js');
  const hosts = [
    'c2c-widget-1001.development.catalystserverless.in',
    'c2c-widget-1001.catalystserverless.com',
    'c2c-widget-1001.development.catalystserverless.com.au',
    'c2c-widget-1001.catalystserverless.eu',
    'c2c-widget-1001.catalystserverless.jp',
    'c2c-widget-1001.catalystserverless.ca',
    'c2c-widget-1001.catalystserverless.sa',
    'c2c-widget-1001.catalystserverless.ae',
    'evilcatalystserverless.com',
    'not-a-catalyst-host.example',
    'c2c-widget-1001.development.catalystserverless.in.',
  ];
  for (const host of hosts) {
    assert.equal(readBackUrlAccepts(host), FUNCTION_HOST.test(host), host);
  }
});

function readBackUrlAccepts(hostname) {
  try {
    readBackUrl(`https://${hostname}/server/c2c_api`, '/x');
    return true;
  } catch {
    return false;
  }
}

test('a valid token reads back 200 rows with the raw token as Authorization', async () => {
  const { fetchImpl, hits } = stub('tok-ok');
  const res = await readBack({ project: 'bom', invokeUrl: INVOKE, token: 'tok-ok', path: '/reports/Items', expectText: 'Steel', fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(hits[0].init.headers.authorization, 'tok-ok');
  assert.equal(hits[0].init.method, 'GET');
});

test('a 401 fails with a message naming the project and the fix, never the token', async () => {
  const { fetchImpl } = stub('tok-ok');
  await assert.rejects(
    readBack({ project: 'bom', invokeUrl: INVOKE, token: 'tok-secret-stale', fetchImpl }),
    (err) => err instanceof ReadBackError && err.status === 401 && /project bom/.test(err.message) && /Authentication is enabled/.test(err.message) && !err.message.includes('tok-secret-stale'),
  );
});

test('a missing token fails before any request', async () => {
  const { fetchImpl, hits } = stub('x');
  await assert.rejects(readBack({ project: 'bom', invokeUrl: INVOKE, token: '', fetchImpl }), /no app-user token/);
  assert.equal(hits.length, 0);
});

test('a non-200, a non-JSON body, a missing rows array and absent expected text each fail', async () => {
  const run = (r, extra = {}) => readBack({ project: 'bom', invokeUrl: INVOKE, token: 't', fetchImpl: async () => r, ...extra });
  await assert.rejects(run(reply(500, {})), /got 500/);
  await assert.rejects(run(reply(200, 'oops')), /not JSON/);
  await assert.rejects(run(reply(200, { ok: true })), /no rows array/);
  await assert.rejects(run(reply(200, { rows: [] }), { expectText: 'Steel' }), /expected text/);
});
