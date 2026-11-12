import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from '../src/runtime.js';
import { IDEMPOTENCY_HEADER, InvokeUrlError, idempotencyKeys, invokeUrl, type InvokeUrlFetch } from '../src/invoke-url.js';
import { hostAllowed, outboundGetUrl, outboundHostsProblem, outboundHttp } from '../src/outbound.js';
import { ZohoConnectionRefused, send } from '../src/zoho-adapters.js';
import type { RestRequest } from '../src/zoho-adapters.js';

interface Step {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Throw this instead of replying. */
  fail?: Error;
  /** Never reply; only an abort ends the attempt. */
  hang?: boolean;
}

/** Scripted fetch: one step per attempt, the last step repeats. */
function scripted(steps: Step[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string; redirect?: string }[] = [];
  const fetch: InvokeUrlFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), ...(init.redirect ? { redirect: init.redirect } : {}) });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step.hang) {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    if (step.fail) throw step.fail;
    const headers = Object.fromEntries(Object.entries(step.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: step.status ?? 200,
      headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
        forEach: (cb: (value: string, name: string) => void) => Object.entries(headers).forEach(([k, v]) => cb(v, k)),
      },
      text: async () => step.body ?? '',
    };
  };
  return { fetch, calls };
}

/** Virtual clock: sleeping advances it, nothing really waits. */
function clock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept };
}

const get = (url = 'https://api.example.com/v1/x'): RestRequest => ({ method: 'GET', url, headers: {} });
const post = (headers: Record<string, string> = {}): RestRequest => ({ method: 'POST', url: 'https://api.example.com/v1/x', headers, body: '{"a":1}' });

test('a hung attempt is aborted at timeoutMs and a GET is retried', async () => {
  const { fetch, calls } = scripted([{ hang: true }, { body: '{"ok":true}' }]);
  const c = clock();
  const reply = await invokeUrl(get(), { fetch, sleep: c.sleep, timeoutMs: 20 });
  assert.deepEqual(reply, { status: 200, body: { ok: true } });
  assert.equal(calls.length, 2);
  assert.deepEqual(c.slept, [200]);
});

test('a hung final attempt throws a timeout, not a hang', async () => {
  const { fetch } = scripted([{ hang: true }]);
  const c = clock();
  await assert.rejects(invokeUrl(get(), { fetch, sleep: c.sleep, timeoutMs: 10, maxRetries: 1 }), (err: InvokeUrlError) => err.reason === 'timeout' && err.attempts === 2);
});

test('429 waits exactly Retry-After, then succeeds', async () => {
  const { fetch, calls } = scripted([{ status: 429, headers: { 'Retry-After': '3' } }, { body: '[1]' }]);
  const c = clock();
  const reply = await invokeUrl(get(), { fetch, sleep: c.sleep, now: c.now });
  assert.deepEqual(reply.body, [1]);
  assert.equal(calls.length, 2);
  assert.deepEqual(c.slept, [3000]);
});

test('503 is retried with exponential backoff when no Retry-After is sent', async () => {
  const { fetch, calls } = scripted([{ status: 503 }, { status: 503 }, { status: 503 }, { body: 'done' }]);
  const c = clock();
  const reply = await invokeUrl(post(), { fetch, sleep: c.sleep, now: c.now });
  assert.deepEqual(reply, { status: 200, body: 'done' });
  assert.equal(calls.length, 4);
  assert.deepEqual(c.slept, [200, 400, 800]);
});

test('a Retry-After past maxWaitMs fails at once without sleeping', async () => {
  const { fetch, calls } = scripted([{ status: 429, headers: { 'Retry-After': '120' } }]);
  const c = clock();
  await assert.rejects(invokeUrl(get(), { fetch, sleep: c.sleep, now: c.now }), (err: InvokeUrlError) => err.reason === 'rate-limit' && /120s/.test(err.message));
  assert.equal(calls.length, 1);
  assert.deepEqual(c.slept, []);
});

test('a wait that would pass the deadline fails instead of sleeping past the Function budget', async () => {
  const { fetch, calls } = scripted([{ status: 429, headers: { 'Retry-After': '15' } }, { status: 429, headers: { 'Retry-After': '15' } }]);
  const c = clock();
  await assert.rejects(invokeUrl(get(), { fetch, sleep: c.sleep, now: c.now, deadlineMs: 25_000 }), (err: InvokeUrlError) => err.reason === 'rate-limit' && /deadline/.test(err.message));
  assert.equal(calls.length, 2);
  assert.deepEqual(c.slept, [15_000]);
});

test('retries stop at maxRetries and return the last reply', async () => {
  const { fetch, calls } = scripted([{ status: 429, body: '{"code":"LIMIT"}' }]);
  const c = clock();
  const reply = await invokeUrl(get(), { fetch, sleep: c.sleep, now: c.now, maxRetries: 2 });
  assert.deepEqual(reply, { status: 429, body: { code: 'LIMIT' } });
  assert.equal(calls.length, 3);
});

test('502/504 and network errors retry a GET but never a POST without its own key', async () => {
  const c = clock();
  const g = scripted([{ status: 502 }, { status: 504 }, { body: 'ok' }]);
  assert.equal((await invokeUrl(get(), { fetch: g.fetch, sleep: c.sleep, now: c.now })).body, 'ok');
  assert.equal(g.calls.length, 3);

  const p = scripted([{ status: 502 }, { body: 'ok' }]);
  assert.equal((await invokeUrl(post(), { fetch: p.fetch, sleep: c.sleep, now: c.now, idempotency: idempotencyKeys('s') })).status, 502);
  assert.equal(p.calls.length, 1);

  const n = scripted([{ fail: new Error('ECONNRESET') }, { body: 'ok' }]);
  await assert.rejects(invokeUrl(post(), { fetch: n.fetch, sleep: c.sleep, now: c.now }), (err: InvokeUrlError) => err.reason === 'network' && /ECONNRESET/.test(err.message));
  assert.equal(n.calls.length, 1);
});

test('a POST carrying its own Idempotency-Key is retried on 502 and network errors, with that key', async () => {
  const c = clock();
  const { fetch, calls } = scripted([{ fail: new Error('ECONNRESET') }, { status: 502 }, { body: 'ok' }]);
  const reply = await invokeUrl(post({ 'idempotency-key': 'mine-1' }), { fetch, sleep: c.sleep, now: c.now, idempotency: idempotencyKeys('s') });
  assert.equal(reply.body, 'ok');
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.headers['idempotency-key'], 'mine-1');
    assert.equal(call.headers[IDEMPOTENCY_HEADER], undefined);
  }
});

test('writes get one key that is stable across retries; a seed makes it derivable; reads get none', async () => {
  const c = clock();
  const run = async (seed: string | null) => {
    const keys = idempotencyKeys(seed);
    const w = scripted([{ status: 429, headers: { 'Retry-After': '0' } }, { body: 'ok' }]);
    await invokeUrl(post(), { fetch: w.fetch, sleep: c.sleep, now: c.now, idempotency: keys });
    const second = scripted([{ body: 'ok' }]);
    await invokeUrl(post(), { fetch: second.fetch, sleep: c.sleep, now: c.now, idempotency: keys });
    const r = scripted([{ body: 'ok' }]);
    await invokeUrl(get(), { fetch: r.fetch, sleep: c.sleep, now: c.now, idempotency: keys });
    return { first: w.calls.map((x) => x.headers[IDEMPOTENCY_HEADER]), second: second.calls[0]!.headers[IDEMPOTENCY_HEADER], read: r.calls[0]!.headers[IDEMPOTENCY_HEADER] };
  };
  const a = await run('req-7');
  assert.match(a.first[0]!, /^c2c-[0-9a-f]{32}$/);
  assert.equal(a.first[0], a.first[1]);
  assert.notEqual(a.second, a.first[0], 'a second identical call is a different operation');
  assert.equal(a.read, undefined);
  assert.deepEqual(await run('req-7'), a, 'same seed, same calls → same keys');
  const r = await run(null);
  assert.equal(r.first[0], r.first[1]);
  assert.notEqual(r.first[0], (await run(null)).first[0], 'without a seed keys are per call');
});

test('zoho send() retries 503 and times out a hung Zoho call (was: 429 only, no timeout)', async () => {
  const c = clock();
  const { fetch, calls } = scripted([{ status: 503 }, { body: '{"data":[{"id":"1"}]}' }]);
  const reply = await send({ fetch, sleep: c.sleep }, get('https://www.zohoapis.in/crm/v7/Leads/1'), 'tok');
  assert.deepEqual(reply.body, { data: [{ id: '1' }] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.headers.Authorization, 'Zoho-oauthtoken tok');
  assert.equal(calls[0]!.headers[IDEMPOTENCY_HEADER], undefined, 'Zoho calls get no key');

  const hung = scripted([{ hang: true }]);
  await assert.rejects(send({ fetch: hung.fetch, sleep: c.sleep, maxRetries: 0, timeoutMs: 10 }, get('https://www.zohoapis.in/crm/v7/Leads/1'), 'tok'),
    (err: ZohoConnectionRefused) => err instanceof ZohoConnectionRefused && err.missing === 'timeout');
});

test('hostAllowed: exact and *.suffix, case-insensitive, no bare-suffix match', () => {
  assert.equal(hostAllowed('API.Example.com', ['api.example.com']), true);
  assert.equal(hostAllowed('a.b.example.com', ['*.example.com']), true);
  assert.equal(hostAllowed('example.com', ['*.example.com']), false);
  assert.equal(hostAllowed('evilexample.com', ['*.example.com']), false);
  assert.equal(hostAllowed('api.example.com', null), false);
});

test('outboundHttp refuses unlisted hosts and non-https before any request', async () => {
  const { fetch, calls } = scripted([{ body: 'ok' }]);
  const http = outboundHttp({ fetch, allowHosts: ['api.example.com'] });
  await assert.rejects(http({ url: 'https://other.example.com/x' }), (err: ZohoConnectionRefused) => err.missing === 'outbound-host' && /other\.example\.com/.test(err.message));
  await assert.rejects(http({ url: 'http://api.example.com/x' }), (err: ZohoConnectionRefused) => err.missing === 'outbound-host' && /https/.test(err.message));
  await assert.rejects(outboundHttp({ fetch })({ url: 'https://api.example.com/x' }), (err: ZohoConnectionRefused) => err.missing === 'outbound-host');
  assert.equal(calls.length, 0);
});

test('a live connectionless invokeurl goes through the wrapper: retry, key, Deluge value', async () => {
  const c = clock();
  const { fetch, calls } = scripted([{ status: 429, headers: { 'Retry-After': '1' } }, { body: '{"id":12345678901234567890}' }]);
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'Asia/Kolkata', http: outboundHttp({ fetch, sleep: c.sleep, now: c.now, allowHosts: ['api.example.com'], idempotencySeed: 'sub-1' }) });
  const ctx = runtime.context({ record: {} });
  const value = (await runtime.shim.http.invokeurl(ctx, { url: 'https://api.example.com/hook', type: 'POST', parameters: { a: 'b' } })) as { id: unknown };
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.body, 'a=b');
  assert.match(calls[0]!.headers[IDEMPOTENCY_HEADER]!, /^c2c-[0-9a-f]{32}$/);
  assert.equal(calls[1]!.headers[IDEMPOTENCY_HEADER], calls[0]!.headers[IDEMPOTENCY_HEADER]);
  assert.equal(String(value.id), '12345678901234567890', '19+ digit ids survive (lossless JSON)');
  assert.equal(String(value), '{"id":"12345678901234567890"}', 'same lossless id text as the connection path');
});

// Following a 3xx past the allowlist would forward the body, custom headers and the key.

test('the transport never follows redirects itself; send() returns a 3xx as the reply (token never leaves the named host)', async () => {
  const c = clock();
  const { fetch, calls } = scripted([{ status: 307, headers: { Location: 'https://evil.example.net/x' } }]);
  const reply = await send({ fetch, sleep: c.sleep }, { method: 'POST', url: 'https://www.zohoapis.in/crm/v7/Leads', headers: { 'X-Custom': 's' }, body: '{"a":1}' }, 'tok');
  assert.equal(reply.status, 307);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.redirect, 'manual');
});

test('outbound redirect to an unlisted or non-https host is refused before the second fetch', async () => {
  for (const location of ['https://evil.example.net/exfil', 'http://api.example.com/plain', '//evil.example.net/x', 'https://api.example.com' + '@evil.example.net/']) {
    const { fetch, calls } = scripted([{ status: 302, headers: { Location: location } }, { body: 'reached' }]);
    const http = outboundHttp({ fetch, allowHosts: ['api.example.com'] });
    await assert.rejects(http({ url: 'https://api.example.com/redir' }), (err: ZohoConnectionRefused) => err.missing === 'outbound-host' && /redirect/.test(err.message), location);
    assert.equal(calls.length, 1, location);
    assert.equal(calls[0]!.redirect, 'manual');
  }
});

test('outbound redirects: cross-origin hops drop body and every header; a cross-origin 307 write is not followed; same-origin 307 keeps them', async () => {
  const c = clock();
  const opts = { sleep: c.sleep, now: c.now, allowHosts: ['api.example.com', '*.ok.example.org'], idempotencySeed: 's' };
  const write = { url: 'https://api.example.com/hook', type: 'POST', parameters: { a: 'payload' }, headers: { 'X-Custom-Secret': 'sekrit-123' } };

  const cross307 = scripted([{ status: 307, headers: { Location: 'https://b.ok.example.org/x' } }, { body: 'reached' }]);
  assert.equal(await outboundHttp({ ...opts, fetch: cross307.fetch })(write), null, 'the 3xx is the reply');
  assert.equal(cross307.calls.length, 1);

  const cross302 = scripted([{ status: 302, headers: { Location: 'https://b.ok.example.org/x' } }, { body: 'reached' }]);
  assert.equal(await outboundHttp({ ...opts, fetch: cross302.fetch })(write), 'reached');
  assert.deepEqual(cross302.calls[1], { url: 'https://b.ok.example.org/x', method: 'GET', headers: {}, redirect: 'manual' });

  const same307 = scripted([{ status: 307, headers: { Location: '/v2/hook' } }, { body: 'reached' }]);
  assert.equal(await outboundHttp({ ...opts, fetch: same307.fetch })(write), 'reached');
  assert.equal(same307.calls[1]!.url, 'https://api.example.com/v2/hook');
  assert.equal(same307.calls[1]!.method, 'POST');
  assert.equal(same307.calls[1]!.body, 'a=payload');
  assert.equal(same307.calls[1]!.headers['X-Custom-Secret'], 'sekrit-123');
  assert.equal(same307.calls[1]!.headers[IDEMPOTENCY_HEADER], same307.calls[0]!.headers[IDEMPOTENCY_HEADER]);

  const loop = scripted([{ status: 302, headers: { Location: '/again' } }]);
  await outboundHttp({ ...opts, fetch: loop.fetch })({ url: 'https://api.example.com/again' });
  assert.equal(loop.calls.length, 4, 'at most MAX_REDIRECTS (3) hops, then the 3xx is the reply');
});

test('outboundGetUrl refuses unlisted hosts, non-https, and userinfo before any request', async () => {
  const { fetch, calls } = scripted([{ body: 'ok' }]);
  const getUrl = outboundGetUrl({ fetch, allowHosts: ['api.example.com'] });
  await assert.rejects(getUrl({ url: 'https://other.example.com/x' }), (err: ZohoConnectionRefused) => err.missing === 'outbound-host' && /other\.example\.com/.test(err.message));
  await assert.rejects(getUrl({ url: 'http://api.example.com/x' }), (err: ZohoConnectionRefused) => err.missing === 'outbound-host' && /https/.test(err.message));
  await assert.rejects(getUrl({ url: USERINFO_URL }), (err: ZohoConnectionRefused) => err.missing === 'outbound-host' && !CANARIES.test(err.message));
  await assert.rejects(outboundGetUrl({ fetch })({ url: 'https://api.example.com/x' }), (err: ZohoConnectionRefused) => err.missing === 'outbound-host');
  assert.equal(calls.length, 0);
});

test('outboundGetUrl: default returns the raw body text; simple:false returns the response map', async () => {
  const { fetch, calls } = scripted([{ status: 200, body: '<cd><x>1</x></cd>', headers: { 'Content-Type': 'text/xml', ETag: 'abc' } }]);
  const getUrl = outboundGetUrl({ fetch, allowHosts: ['api.example.com'] });
  assert.equal(await getUrl({ url: 'https://api.example.com/feed', simple: true }), '<cd><x>1</x></cd>');
  assert.equal(await getUrl({ url: 'https://api.example.com/feed' }), '<cd><x>1</x></cd>', 'simple is the default');
  assert.equal(calls[0]!.method, 'GET');
  const full = (await getUrl({ url: 'https://api.example.com/feed', headers: { 'X-Key': 'v' }, simple: false })) as {
    responseText: string;
    responseHeader: Record<string, string>;
    responseCode: number;
  };
  assert.equal(full.responseText, '<cd><x>1</x></cd>');
  assert.equal(full.responseCode, 200);
  assert.equal(full.responseHeader['content-type'], 'text/xml');
  assert.equal(full.responseHeader.etag, 'abc');
  assert.equal(calls[2]!.headers['X-Key'], 'v');
});

test('outboundGetUrl shares the invokeurl transport: 429 honouring Retry-After, redirect host re-checked', async () => {
  const c = clock();
  const retry = scripted([{ status: 429, headers: { 'Retry-After': '0' } }, { body: 'done' }]);
  assert.equal(await outboundGetUrl({ fetch: retry.fetch, sleep: c.sleep, now: c.now, allowHosts: ['api.example.com'] })({ url: 'https://api.example.com/x', simple: true }), 'done');
  assert.equal(retry.calls.length, 2);

  const { fetch, calls } = scripted([{ status: 302, headers: { Location: 'https://evil.example.net/exfil' } }, { body: 'reached' }]);
  await assert.rejects(outboundGetUrl({ fetch, allowHosts: ['api.example.com'] })({ url: 'https://api.example.com/redir' }),
    (err: ZohoConnectionRefused) => err.missing === 'outbound-host' && /redirect/.test(err.message));
  assert.equal(calls.length, 1);
});

test('runtime shim.http.getUrl: dry-run records the redacted request; live runs through options.httpGetUrl', async () => {
  const dry = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata' });
  const ctx = dry.context({ record: {} });
  const stub = await dry.shim.http.getUrl(ctx, 'https://api.example.com/x?token=sekrit-1', { 'X-Api-Key': 'sekrit-2' });
  assert.deepEqual(stub, { dryRun: true, performed: false });
  const entry = dry.transcript.find((e) => e.op === 'getUrl') as unknown as { request: { url: string; headers: Record<string, string> } };
  assert.doesNotMatch(JSON.stringify(dry.transcript), /sekrit/);
  assert.equal(entry.request.headers['X-Api-Key'], '[redacted]');

  // The dry-run placeholder is response text the runtime cannot know:
  // `.toJSONList()` on it is an empty list so `for each` no-ops, not a throw.
  assert.deepEqual(dry.shim.convert.toJSONList(stub, ctx), []);
  assert.deepEqual(dry.shim.each(ctx, dry.shim.convert.toJSONList(stub, ctx)), []);

  const { fetch, calls } = scripted([{ body: '[{"id":1}]' }]);
  const live = createRuntime({ dryRun: false, appTimeZone: 'Asia/Kolkata', httpGetUrl: outboundGetUrl({ fetch, allowHosts: ['api.example.com'] }) });
  const liveCtx = live.context({ record: {} });
  assert.equal(await live.shim.http.getUrl(liveCtx, 'https://api.example.com/list'), '[{"id":1}]');
  // The two-argument boolean form: getUrl(url, simple) — no header map.
  const full = (await live.shim.http.getUrl(liveCtx, 'https://api.example.com/list', false)) as { responseCode: number; responseText: string };
  assert.equal(full.responseCode, 200);
  assert.equal(full.responseText, '[{"id":1}]');
  await assert.rejects(live.shim.http.getUrl(liveCtx, 'https://evil.example.net/x'), ZohoConnectionRefused);
  assert.equal(calls.length, 2, 'the unlisted host never reached fetch');
});

test('a bare * (or *.tld) in outboundHosts is refused before any request', async () => {
  const { fetch, calls } = scripted([{ body: 'ok' }]);
  for (const hosts of [['*'], [' * '], ['api.example.com', '*.com'], ['*example.com'], ['api.*.example.com']]) {
    assert.ok(outboundHostsProblem(hosts), JSON.stringify(hosts));
    await assert.rejects(outboundHttp({ fetch, allowHosts: hosts })({ url: 'https://api.example.com/x' }),
      (err: ZohoConnectionRefused) => err.missing === 'outbound-config' && /outboundHosts entry .* is refused: list each host explicitly/.test(err.message));
  }
  assert.equal(calls.length, 0);
  assert.equal(outboundHostsProblem(['api.example.com', '*.example.com']), null);
});

test('URL userinfo and secret query values are not echoed in a refusal', async () => {
  const { fetch, calls } = scripted([{ body: 'ok' }]);
  const http = outboundHttp({ fetch, allowHosts: ['api.example.com'] });
  for (const url of ['https//user:sekrit-pw@api.example.com/x?authtoken=sekrit-tok', 'user:sekrit-pw@api.example.com', 'not a url sekrit-pw@x?k=sekrit-tok']) {
    await assert.rejects(http({ url }), (err: ZohoConnectionRefused) => err.missing === 'outbound-host' && !/sekrit/.test(err.message), url);
  }
  await assert.rejects(http({ url: 'https//user:sekrit-pw@api.example.com/x?k=1' }), (err: ZohoConnectionRefused) => /\[redacted\]@api\.example\.com\/x\?\[redacted\]$/.test(err.message));
  await assert.rejects(http({ url: 'https://user:sekrit-pw@evil.example.net/?token=sekrit-tok' }), (err: ZohoConnectionRefused) => !/sekrit/.test(err.message));
  assert.equal(calls.length, 0);
});

test('script-set Authorization and secret-named headers/parameters/URL parts are redacted in the transcript', async () => {
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata' });
  const ctx = runtime.context({ record: {} });
  await runtime.shim.http.invokeurl(ctx, {
    url: 'https://user:sekrit-pw@api.example.com/x?authtoken=sekrit-q&page=2#access_token=sekrit-frag',
    type: 'POST',
    headers: { Authorization: 'BEARER-sekrit-1', 'X-Api-Key': 'sekrit-2', Cookie: 'sid=sekrit-3', Accept: 'application/json' },
    parameters: { client_secret: 'sekrit-4', name: 'kept' },
  });
  const entry = runtime.transcript.find((e) => e.op === 'invokeurl') as unknown as { request: { url: string; headers: Record<string, string>; parameters: Record<string, string> } };
  assert.doesNotMatch(JSON.stringify(runtime.transcript), /sekrit/);
  assert.equal(entry.request.headers.Authorization, '[redacted]');
  assert.equal(entry.request.headers.Accept, 'application/json');
  assert.equal(entry.request.parameters.name, 'kept');
  assert.match(entry.request.url, /page=2/);

  // The connection path records the same redacted raw map: parameters a
  // connection invokeurl folds into the sent body are not echoed either.
  const conn = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata', zohoConnections: { dc: null, connections: {} } });
  const connCtx = conn.context({ record: {} });
  await conn.shim.http.invokeurl(connCtx, {
    url: 'https://www.zohoapis.in/crm/v7/Leads',
    type: 'POST',
    connection: 'c2c_crm',
    parameters: { client_secret: 'sekrit-5', Last_Name: 'kept' },
  });
  assert.doesNotMatch(JSON.stringify(conn.transcript), /sekrit-5|client_secret=sekrit/);
  const connEntry = conn.transcript.find((e) => e.op === 'invokeurl') as unknown as { request: { parameters: Record<string, string> } };
  assert.equal(connEntry.request.parameters.Last_Name, 'kept');
});

// An allowlisted URL carrying userinfo passed
// checkOutbound, then undici's fetch threw "…URL that includes credentials:
// <raw url>" and that message reached the caller (and the persisted error
// field) with the user, password, secret query and fragment intact.

const USERINFO_URL = 'https://SEKUSER:SEKPASS@api.example.com/x?token=SEKQUERY&page=1#SEKFRAG';
const CANARIES = /SEKUSER|SEKPASS|SEKQUERY|SEKFRAG/;

test('an allowlisted outbound URL carrying userinfo is refused before any fetch, echoing nothing', async () => {
  const { fetch, calls } = scripted([{ body: 'ok' }]);
  const http = outboundHttp({ fetch, allowHosts: ['api.example.com'] });
  await assert.rejects(http({ url: USERINFO_URL }), (err: ZohoConnectionRefused) => {
    assert.equal(err.missing, 'outbound-host');
    assert.match(err.message, /api\.example\.com/);
    assert.doesNotMatch(err.message, CANARIES);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('a redirect Location carrying userinfo to a listed host is refused before the second fetch', async () => {
  const { fetch, calls } = scripted([{ status: 302, headers: { Location: USERINFO_URL } }, { body: 'reached' }]);
  const http = outboundHttp({ fetch, allowHosts: ['api.example.com'] });
  await assert.rejects(http({ url: 'https://api.example.com/redir' }),
    (err: ZohoConnectionRefused) => err.missing === 'outbound-host' && /redirect/.test(err.message) && !CANARIES.test(err.message));
  assert.equal(calls.length, 1);
});

test('send() refuses a userinfo URL before any fetch', async () => {
  const { fetch, calls } = scripted([{ body: 'ok' }]);
  await assert.rejects(
    send({ fetch }, { method: 'GET', url: 'https://SEKUSER:SEKPASS@www.zohoapis.in/crm/v7/Leads/1?token=SEKQUERY#SEKFRAG', headers: {} }, 'tok'),
    (err: ZohoConnectionRefused) => err.missing === 'userinfo' && !CANARIES.test(err.message),
  );
  assert.equal(calls.length, 0);
});

test('a thrown fetch message that embeds a URL is redacted in InvokeUrlError and in the ZohoConnectionRefused above it', async () => {
  const c = clock();
  const boom = () => new TypeError('Request cannot be constructed from a URL that includes credentials: https://SEKUSER:SEKPASS@api.example.com/x?token=SEKQUERY&page=1#SEKFRAG');
  const n = scripted([{ fail: boom() }]);
  await assert.rejects(invokeUrl(get('https://api.example.com/x'), { fetch: n.fetch, sleep: c.sleep, now: c.now, maxRetries: 0 }),
    (err: InvokeUrlError) => err.reason === 'network' && /\[redacted\]@api\.example\.com\/x\?\[redacted\]/.test(err.message) && !CANARIES.test(err.message));
  assert.equal(n.calls.length, 1);

  const o = scripted([{ fail: boom() }]);
  await assert.rejects(outboundHttp({ fetch: o.fetch, sleep: c.sleep, now: c.now, allowHosts: ['api.example.com'], maxRetries: 0 })({ url: 'https://api.example.com/x' }),
    (err: ZohoConnectionRefused) => !CANARIES.test(err.message));
  assert.equal(o.calls.length, 1);

  const s = scripted([{ fail: boom() }]);
  await assert.rejects(send({ fetch: s.fetch, sleep: c.sleep, maxRetries: 0 }, get('https://www.zohoapis.in/crm/v7/Leads/1'), 'tok'),
    (err: ZohoConnectionRefused) => !CANARIES.test(err.message));
  assert.equal(s.calls.length, 1);
});

test('a live invokeurl refused on userinfo leaves no credentials in the transcript', async () => {
  const c = clock();
  const { fetch, calls } = scripted([{ body: 'ok' }]);
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'Asia/Kolkata', http: outboundHttp({ fetch, sleep: c.sleep, now: c.now, allowHosts: ['api.example.com'] }) });
  const ctx = runtime.context({ record: {} });
  await assert.rejects(runtime.shim.http.invokeurl(ctx, { url: USERINFO_URL, type: 'GET' }), (err: ZohoConnectionRefused) => !CANARIES.test(err.message));
  assert.equal(calls.length, 0);
  assert.doesNotMatch(JSON.stringify(runtime.transcript), CANARIES);
});
