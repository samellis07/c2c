/**
 * The React runtime's API origin guard: an authenticated request goes only to
 * the page origin or the configured API origin (https, or http to an exact
 * loopback address on a local dev stack). Anything else is refused before the
 * session token is requested. Same rule and cases as the vanilla runtime; the
 * template sources are transpiled here so the tests run the shipped bytes.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { TEMPLATE_DIR } from '../src/index.js';

interface ApiInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface Runtime {
  apiCall(view: unknown, endpoint: string, init?: ApiInit): Promise<{ ok: boolean; status: number }>;
  apiUrl(view: unknown, endpoint: string): string;
  createApi(view: unknown): { post(endpoint: string, body: unknown): Promise<{ ok: boolean; status: number }> };
  runSmokePlan(model: unknown, plan: unknown, view: unknown): Promise<{ ok: boolean; lines: string[] }>;
  smokeModel(spec: { name?: string }): unknown;
}

/** Transpile runtime/api.ts and smoke/run.ts into a tmp dir and import them. */
async function loadRuntime(t: TestContext): Promise<Runtime> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-react-origin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const emit = (rel: string, out: string, rewrite?: (text: string) => string) => {
    const source = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui', rel), 'utf8');
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: rel,
    }).outputText;
    writeFileSync(join(dir, out), rewrite ? rewrite(js) : js);
  };
  emit('runtime/api.ts', 'api.mjs');
  emit('smoke/run.ts', 'run.mjs', (text) => text.replace(/from\s+['"]\.\.\/runtime\/api['"]/, "from './api.mjs'"));
  const api = await import(pathToFileURL(join(dir, 'api.mjs')).href);
  const run = await import(pathToFileURL(join(dir, 'run.mjs')).href);
  return { ...api, ...run } as Runtime;
}

interface Hit {
  url: string;
  authorization: string | undefined;
}

interface Probe {
  url: string;
  hits: Hit[];
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
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${port}`, hits };
}

const TOKEN = 'session-token';

/** A signed-in page at `pageHref`; `apiBase` stands in for a configured api base. */
function viewAt(pageHref: string, apiBase?: string, fetchImpl?: unknown) {
  const view: Record<string, unknown> = {
    location: { href: pageHref, origin: new URL(pageHref).origin },
    catalyst: {
      auth: {
        isUserAuthenticated: async () => undefined,
        generateAuthToken: async () => ({ access_token: TOKEN }),
      },
    },
  };
  if (apiBase !== undefined) view.C2C_API_BASE = apiBase;
  // What a browser does with the request string: resolve it against the page.
  view.fetch = fetchImpl ?? ((url: string, init?: RequestInit) => fetch(new URL(url, pageHref), init));
  return view;
}

/** A fetch stand-in that records each request and answers 200 {}. */
function recorder() {
  const sent: { url: string; authorization: string | undefined }[] = [];
  const call = (url: string, init?: { headers?: Record<string, string> }) => {
    sent.push({ url, authorization: init?.headers?.authorization });
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  return { sent, call };
}

test('an absolute lookup endpoint in a smoke plan is refused — the token never reaches a foreign host', async (t) => {
  const runtime = await loadRuntime(t);
  const page = await startProbe(t);
  const foreign = await startProbe(t);
  const view = viewAt(`${page.url}/app/index.html`);
  const plan = [
    {
      kind: 'submit',
      label: 'submit Item',
      form: 'Item',
      table: 'Item',
      method: 'POST',
      path: '/forms/Item/submit',
      record: [{ name: 'Vendor', source: 'lookup Vendor', lookupForm: 'Vendor', lookupTable: 'Vendor', lookupEndpoint: `${foreign.url}/exfil` }],
      marker: { field: 'Item_Name' },
    },
  ];
  let run: { ok: boolean } | undefined;
  try {
    run = await runtime.runSmokePlan(runtime.smokeModel({ name: 'Widget' }), plan, view);
  } catch (err) {
    assert.match(String(err), /refused/i);
  }
  assert.notEqual(run?.ok, true, 'the run does not pass');
  assert.equal(foreign.hits.length, 0, 'nothing was sent to the foreign host');
});

test('a protocol-relative endpoint is refused when no api base is configured', async (t) => {
  const runtime = await loadRuntime(t);
  const page = await startProbe(t);
  const foreign = await startProbe(t);
  const view = viewAt(`${page.url}/app/index.html`);
  // `//host/path` names the foreign host as soon as the browser resolves it.
  const endpoint = `//${foreign.url.slice('http://'.length)}/exfil`;
  await assert.rejects(runtime.apiCall(view, endpoint, { method: 'GET' }), /refused/i);
  await assert.rejects(runtime.createApi(view).post(endpoint, {}), /refused/i);
  assert.equal(foreign.hits.length, 0, 'nothing was sent to the foreign host');
});

test('foreign, protocol-relative and non-web endpoints are refused before fetch runs', async (t) => {
  const runtime = await loadRuntime(t);
  const { sent, call } = recorder();
  const view = viewAt('https://app.example.test/index.html', 'https://api.example.test/server/c2c_api', call);
  for (const endpoint of ['https://foreign.example.test/exfil', '//foreign.example.test/exfil', 'javascript:alert(1)', 'data:text/plain,x']) {
    await assert.rejects(runtime.apiCall(view, endpoint, { method: 'GET' }), /refused/i, endpoint);
    await assert.rejects(runtime.createApi(view).post(endpoint, {}), /refused/i, endpoint);
    assert.throws(() => runtime.apiUrl(view, endpoint), /refused/i, endpoint);
  }
  assert.deepEqual(sent, [], 'no request was made');
});

test('an api base on plain http to a non-loopback host is refused', async (t) => {
  const runtime = await loadRuntime(t);
  const { sent, call } = recorder();
  const view = viewAt('https://app.example.test/index.html', 'http://plain-http.example.test/server/c2c_api', call);
  await assert.rejects(runtime.apiCall(view, '/forms/F/submit', { method: 'POST' }), /refused/i);
  await assert.rejects(runtime.createApi(view).post('/forms/F/submit', {}), /refused/i);
  assert.deepEqual(sent, []);
});

test('the token is not requested for a refused endpoint', async (t) => {
  const runtime = await loadRuntime(t);
  const { sent, call } = recorder();
  const view = viewAt('https://app.example.test/index.html', undefined, call);
  let asked = 0;
  (view.catalyst as { auth: { generateAuthToken: () => Promise<unknown> } }).auth.generateAuthToken = async () => {
    asked += 1;
    return { access_token: TOKEN };
  };
  await assert.rejects(runtime.apiCall(view, 'https://foreign.example.test/x'), /refused/i);
  await assert.rejects(runtime.createApi(view).post('https://foreign.example.test/x', {}), /refused/i);
  assert.equal(asked, 0);
  assert.deepEqual(sent, []);
});

test('a same-origin request still carries the session token', async (t) => {
  const runtime = await loadRuntime(t);
  const page = await startProbe(t);
  const view = viewAt(`${page.url}/app/index.html`);
  await runtime.apiCall(view, '/forms/F/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await runtime.createApi(view).post('/forms/F/submit', {});
  assert.equal(page.hits.length, 2, 'both requests reached the page origin');
  assert.deepEqual(
    page.hits.map((hit) => hit.authorization),
    [TOKEN, TOKEN],
    'the session token was attached',
  );
});

test('the configured api origin still carries the session token on a dev stack', async (t) => {
  const runtime = await loadRuntime(t);
  const page = await startProbe(t);
  const api = await startProbe(t);
  const view = viewAt(`${page.url}/app/index.html`, `${api.url}/server/c2c_api`);
  await runtime.apiCall(view, '/forms/F/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(api.hits.length, 1, 'the request reached the configured api origin');
  assert.equal(api.hits[0]?.url, '/server/c2c_api/forms/F/submit');
  assert.equal(api.hits[0]?.authorization, TOKEN, 'the session token was attached');
  assert.equal(page.hits.length, 0);
});

test('an absolute endpoint on the configured api origin is allowed', async (t) => {
  const runtime = await loadRuntime(t);
  const { sent, call } = recorder();
  const view = viewAt('https://app.example.test/index.html', 'https://api.example.test/server/c2c_api', call);
  await runtime.apiCall(view, 'https://api.example.test/server/c2c_api/reports/R', { method: 'GET' });
  assert.deepEqual(
    sent.map((s) => s.url),
    ['https://api.example.test/server/c2c_api/reports/R'],
  );
});
