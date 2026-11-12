import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

interface Runtime {
  apiCall(call: unknown, view: unknown, endpoint: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<unknown>;
  apiUrl(endpoint: string, view: unknown): string;
  loadLookupOptions(view: unknown, endpoint: string): Promise<{ value: string; label: string }[]>;
  uploadReference(viewRef: unknown, field: unknown, file: unknown): Promise<{ key: string }>;
}

async function loadRuntime(): Promise<Runtime> {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as Runtime;
}

interface Hit {
  url: string;
  authorization: string | undefined;
}

interface Probe {
  url: string;
  hits: Hit[];
  close(): Promise<void>;
}

/** A 127.0.0.1-only server that records the URL and token header of every request. */
async function startProbe(t: TestContext): Promise<Probe> {
  const hits: Hit[] = [];
  const server: Server = createServer((rq: IncomingMessage, rs: ServerResponse) => {
    hits.push({ url: String(rq.url), authorization: rq.headers.authorization });
    rs.setHeader('content-type', 'application/json');
    rs.end(JSON.stringify({ rows: [{ ROWID: '1', Name: 'Acme' }], field: 'Name' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const probe = {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  t.after(probe.close);
  return probe;
}

const TOKEN = 'session-token';

/** A signed-in page at `pageHref`; `apiBase` stands in for a configured api base. */
function viewAt(pageHref: string, apiBase?: string) {
  const view: Record<string, unknown> = {
    location: { href: pageHref },
    catalyst: {
      auth: {
        isUserAuthenticated: async () => undefined,
        generateAuthToken: async () => ({ access_token: TOKEN }),
      },
    },
  };
  if (apiBase !== undefined) view.C2C_API_BASE = apiBase;
  return view;
}

/** What a browser does with the request string: resolve it against the page. */
function browserCall(pageHref: string) {
  return (url: string, init?: RequestInit) => fetch(new URL(url, pageHref), init);
}

test('an absolute lookup endpoint is refused — the token never reaches a foreign host', async (t) => {
  const runtime = await loadRuntime();
  const page = await startProbe(t);
  const foreign = await startProbe(t);
  const view = viewAt(`${page.url}/app/index.html`);
  view.fetch = browserCall(`${page.url}/`);
  await assert.rejects(runtime.loadLookupOptions(view, `${foreign.url}/exfil`), /refused/i);
  assert.equal(foreign.hits.length, 0, 'nothing was sent to the foreign host');
  assert.equal(foreign.hits.some((hit) => hit.authorization !== undefined), false, 'no authorization header reached the foreign host');
});

test('a protocol-relative endpoint is refused when no api base is configured', async (t) => {
  const runtime = await loadRuntime();
  const page = await startProbe(t);
  const foreign = await startProbe(t);
  const view = viewAt(`${page.url}/app/index.html`);
  // `//host/path` names the foreign host as soon as the browser resolves it.
  const endpoint = `//${foreign.url.slice('http://'.length)}/exfil`;
  await assert.rejects(runtime.apiCall(browserCall(`${page.url}/`), view, endpoint, { method: 'GET' }), /refused/i);
  assert.equal(foreign.hits.length, 0, 'nothing was sent to the foreign host');
  assert.equal(foreign.hits.some((hit) => hit.authorization !== undefined), false, 'no authorization header reached the foreign host');
});

test('foreign, protocol-relative and non-web endpoints are refused before fetch runs', async () => {
  const runtime = await loadRuntime();
  const sent: { url: string; authorization: string | undefined }[] = [];
  const call = (url: string, init?: { headers?: Record<string, string> }) => {
    sent.push({ url, authorization: init && init.headers ? init.headers.authorization : undefined });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
  const view = viewAt('https://app.example.test/index.html', 'https://api.example.test/server/c2c_api');
  for (const endpoint of [
    'https://foreign.example.test/exfil',
    '//foreign.example.test/exfil',
    'javascript:alert(1)',
    'data:text/plain,x',
  ]) {
    await assert.rejects(runtime.apiCall(call, view, endpoint, { method: 'GET' }), /refused/i, endpoint);
  }
  assert.deepEqual(sent, [], 'no request was made');
});

test('an api base on plain http to a non-loopback host is refused', async () => {
  const runtime = await loadRuntime();
  const sent: string[] = [];
  const call = (url: string) => {
    sent.push(url);
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
  const view = viewAt('https://app.example.test/index.html', 'http://plain-http.example.test/server/c2c_api');
  await assert.rejects(runtime.apiCall(call, view, '/forms/F/submit', { method: 'POST' }), /refused/i);
  assert.deepEqual(sent, []);
});

test('a same-origin request still carries the session token', async (t) => {
  const runtime = await loadRuntime();
  const page = await startProbe(t);
  const view = viewAt(`${page.url}/app/index.html`);
  await runtime.apiCall(browserCall(`${page.url}/`), view, '/forms/F/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(page.hits.length, 1, 'the request reached the page origin');
  assert.equal(page.hits[0]?.authorization, TOKEN, 'the session token was attached');
});

test('the configured api origin still carries the session token on a dev stack', async (t) => {
  const runtime = await loadRuntime();
  const page = await startProbe(t);
  const api = await startProbe(t);
  const view = viewAt(`${page.url}/app/index.html`, `${api.url}/server/c2c_api`);
  await runtime.apiCall(browserCall(`${page.url}/`), view, '/forms/F/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(api.hits.length, 1, 'the request reached the configured api origin');
  assert.equal(api.hits[0]?.url, '/server/c2c_api/forms/F/submit');
  assert.equal(api.hits[0]?.authorization, TOKEN, 'the session token was attached');
});

test('an absolute endpoint on the configured api origin is allowed', async () => {
  const runtime = await loadRuntime();
  const sent: string[] = [];
  const call = (url: string) => {
    sent.push(url);
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
  const view = viewAt('https://app.example.test/index.html', 'https://api.example.test/server/c2c_api');
  await runtime.apiCall(call, view, 'https://api.example.test/server/c2c_api/reports/R', { method: 'GET' });
  assert.deepEqual(sent, ['https://api.example.test/server/c2c_api/reports/R']);
});

test('uploadReference refuses a non-https, non-loopback signed URL', async (t) => {
  const runtime = await loadRuntime();
  const probe = await startProbe(t);

  const file = {
    name: 'test.png',
    type: 'image/png',
    size: 4,
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  };

  const field = { uploadEndpoint: '/upload/init' };
  let uploadUrl = 'http://example.test/put';

  const httpsCallSent: string[] = [];
  const mockFetch = (url: string, init?: RequestInit) => {
    if (url === '/upload/init') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          reference: { key: 'ref-key' },
          upload: { url: uploadUrl, headers: {} },
        }),
      });
    }
    if (url === uploadUrl && url.startsWith('https:')) {
      httpsCallSent.push(url);
      return Promise.resolve({ ok: true });
    }
    return fetch(url, init);
  };

  const view = { fetch: mockFetch };

  // 1. FAILS on 27044b83 (an http://example.test upload URL is attempted) and passes after (refused before fetch)
  await assert.rejects(
    runtime.uploadReference(view, field, file),
    /the signed upload url is not an https target/i
  );

  // 2. an https URL still uploads
  uploadUrl = 'https://example.test/put';
  const resHttps = await runtime.uploadReference(view, field, file);
  assert.equal(resHttps.key, 'ref-key');
  assert.deepEqual(httpsCallSent, ['https://example.test/put']);

  // 3. an http://127.0.0.1 URL still uploads
  uploadUrl = `${probe.url}/put`;
  const resLoopback = await runtime.uploadReference(view, field, file);
  assert.equal(resLoopback.key, 'ref-key');
  // uploadReference sends PUT to the probe, check probe hits
  assert.equal(probe.hits.length, 1);
  assert.equal(probe.hits[0].url, '/put');
});
