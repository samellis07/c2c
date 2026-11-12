import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadBackError, readBack, readBackUrl } from '../api-readback.mjs';

const INVOKE = 'https://app.example.test/server/c2c_api/';
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
  assert.equal(readBackUrl(INVOKE, '/reports/Items?page=0'), 'https://app.example.test/server/c2c_api/reports/Items?page=0');
  assert.throws(() => readBackUrl('nope', '/x'), ReadBackError);
});

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
