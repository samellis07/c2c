/**
 * A generated on-success handler whose invokeurl has no `connection:` (a
 * third-party URL) runs live through the shims invokeUrl wrapper: only hosts in
 * c2c-deploy.json `outboundHosts`, 429 Retry-After honoured, one idempotency
 * key per call seeded by the caller's Idempotency-Key.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { buildUi } from '../../ui/src/index.js';

const root = repoRoot();
const CONNECTION_APPS = join(root, 'fixtures/sample-app/connections');
/** A synthetic Creator app that calls another Zoho service (committed fixture). */
const connectionsApp = (name: string): string => readFileSync(join(CONNECTION_APPS, `${name}.ds`), 'utf8');

const HOST = 'https://api.example.com';
const HANDLER = 'functions/aio/conn-rest-read-write/on-success.mjs';

/** The REST GET/POST feature app with its connection removed and its URLs pointed at a third-party host. */
function outboundApp(host = HOST): App {
  let source = connectionsApp('c2c-conn-rest-getpost');
  assert.ok(source.includes('\tconnection:"c2c_crm"\n'));
  source = source.split('\tconnection:"c2c_crm"\n').join('').split('https://www.zohoapis.in/crm/v7').join(`${host}/v1`);
  const needle = '\tshare_settings\n\t{';
  const at = source.indexOf(needle);
  const block = ['\t\t"Administrator"', '\t\t{', '\t\t\tname = "Administrator"', '\t\t\ttype = Users_Permissions', '\t\t\tdescription = "This profile will have all the permissions."', '\t\t}', ''].join('\n');
  return deriveIr(parse(`${source.slice(0, at + needle.length)}\n${block}${source.slice(at + needle.length)}`));
}

function files(app: App): Map<string, string> {
  return new Map(buildUi(app).files.map((f) => [f.path, String(f.data)]));
}

function writeTree(app: App, deploy: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-outbound-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(root, join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of buildUi(app).files) {
    const dest = join(dir, ...file.path.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.data);
  }
  writeFileSync(join(dir, 'functions/c2c-deploy.json'), `${JSON.stringify(deploy, null, 2)}\n`);
  return dir;
}

function memoryStore() {
  let next = 1;
  return {
    now: new Date('2026-10-07T08:30:00.000Z'),
    async insert(_form: string, input: Record<string, unknown>[]) {
      return input.map((row) => ({ ...row, ROWID: String(next++) }));
    },
    async update(_form: string, input: Record<string, unknown>[]) {
      return input;
    },
    async delete() {
      return [];
    },
    async query() {
      return [];
    },
  };
}

async function run(dir: string, req: unknown): Promise<{ status: number; body: Record<string, unknown>; logged: Record<string, unknown>[] }> {
  (await import(pathToFileURL(join(dir, 'functions/c2c-store.mjs')).href)).setDatastore(memoryStore());
  const handler = (await import(pathToFileURL(join(dir, HANDLER)).href)).default as (req: unknown, res: unknown) => unknown;
  let status = 0;
  let raw = '';
  const logged: Record<string, unknown>[] = [];
  const realError = console.error;
  console.error = (line: unknown) => {
    try {
      logged.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      /* not a structured line */
    }
  };
  try {
    await handler(req, { writeHead: (code: number) => (status = code), end: (body: string) => (raw = body) });
  } finally {
    console.error = realError;
  }
  return { status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, logged };
}

/** A post-commit refusal: the row stays, the reply is 200 with a warning, and the log names the refusal code. */
function assertPostCommitWarning(res: { status: number; body: Record<string, unknown>; logged: Record<string, unknown>[] }, code: string): void {
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.wrote, true, 'the row is persisted before the script runs');
  assert.equal((res.body.warning as { code?: unknown } | undefined)?.code, 'POST_COMMIT_FAILED');
  assert.equal(Object.hasOwn(res.body, 'error'), false);
  assert.deepEqual(res.logged.filter((line) => line.event === 'post-commit-failed').map((line) => line.code), [code]);
}

test('generated handlers wire outboundHttp only when an invokeurl has no connection (others are byte-unchanged)', () => {
  const generated = files(outboundApp());
  const src = generated.get(HANDLER)!;
  assert.match(src, /import \{ authorizeRead, authorizeWrite, applyInitialValues, compileCriteria, createRuntime, outboundHttp, postCommitWarning, principalFromRequest, projectFields, projectReadable, replyStoreError \} from "creator-to-catalyst\/shims";/);
  assert.match(generated.get('functions/aio/_lib.mjs')!, /import \{ jsonReplacer \} from "creator-to-catalyst\/shims";[\s\S]*JSON\.stringify\(body, jsonReplacer\)/);
  assert.match(src, /\.\.\.\(live \? \{ http: outboundHttp\(outboundConfig\(req\)\) \} : \{\}\),/);
  assert.match(src, /parsed\.outboundHosts/);
  const withConnection = files(deriveIr(parse(connectionsApp('c2c-conn-rest-getpost')))).get(HANDLER)!;
  assert.doesNotMatch(withConnection, /outboundHttp|outboundConfig/);
});

/** The same app, but the GET branch uses the legacy `getUrl` task instead of invokeurl. */
function getUrlApp(): App {
  let source = connectionsApp('c2c-conn-rest-getpost');
  const getBlock = /(?<indent>\t+)got = invokeurl\n\t+\[\n\t+url :apiUrl\n\t+type :GET\n\t+connection:"c2c_crm"\n\t+\];/;
  const stripped = source.replace(getBlock, '$<indent>got = getUrl(apiUrl);');
  assert.notEqual(stripped, source, 'the GET invokeurl block was found and replaced');
  source = stripped.split('https://www.zohoapis.in/crm/v7').join(`${HOST}/v1`);
  const needle = '\tshare_settings\n\t{';
  const at = source.indexOf(needle);
  const block = ['\t\t"Administrator"', '\t\t{', '\t\t\tname = "Administrator"', '\t\t\ttype = Users_Permissions', '\t\t\tdescription = "This profile will have all the permissions."', '\t\t}', ''].join('\n');
  return deriveIr(parse(`${source.slice(0, at + needle.length)}\n${block}${source.slice(at + needle.length)}`));
}

test('a generated handler whose script calls getUrl wires httpGetUrl to outboundGetUrl under the same allowlist', async () => {
  const src = files(getUrlApp()).get(HANDLER)!;
  assert.match(src, /shim\.http\.getUrl\(ctx, apiUrl\)/);
  assert.match(src, /outboundGetUrl/);
  assert.match(src, /\.\.\.\(live \? \{ httpGetUrl: outboundGetUrl\(outboundConfig\(req\)\) \} : \{\}\),/);
  assert.match(src, /parsed\.outboundHosts/);
});

test('generated live getUrl: unlisted host refused before any request; listed host returns the body text', async () => {
  const seen: { method?: string; url?: string }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ Last_Name: 'C2C-G1' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.startsWith(`${HOST}/`), `unexpected fetch ${url}`);
    return realFetch(origin + url.slice(HOST.length), init);
  }) as typeof fetch;
  const app = getUrlApp();
  const req = { user: { profile: 'Administrator' }, headers: {}, body: { record: { Rest_Verb: 'GET', Rest_Last_Name: 'C2C-G1' } } };
  try {
    const refused = await run(writeTree(app, { mode: 'live', appTimeZone: 'Asia/Kolkata' }), req);
    assertPostCommitWarning(refused, 'ZOHO_CONNECTION_REFUSED');
    assert.equal(seen.length, 0);

    const ok = await run(writeTree(app, { mode: 'live', appTimeZone: 'Asia/Kolkata', outboundHosts: ['api.example.com'] }), req);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0]!.method, seen[0]!.url], ['GET', '/v1/Leads?fields=Last_Name,Email,Company&per_page=5']);
    assert.equal((ok.body.values as Record<string, unknown>).Rest_Response, '{"data":[{"Last_Name":"C2C-G1"}]}');
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});

test('a connection invokeurl whose literal parameters map comes before connection: is wired to Connections, not outbound', () => {
  let source = connectionsApp('c2c-conn-rest-getpost');
  const getType = '\t\t\t\t\t\t\t\t\ttype :GET\n';
  const postBody = '\t\t\t\t\t\t\t\t\tbody:payload.toString()\n\t\t\t\t\t\t\t\t\theaders:hdr\n';
  assert.ok(source.includes(getType) && source.includes(postBody));
  source = source.replace(getType, `${getType}\t\t\t\t\t\t\t\t\tparameters:{"per_page":"5"}\n`).replace(postBody, '\t\t\t\t\t\t\t\t\tparameters:{"Last_Name":input.Rest_Last_Name}\n');
  const src = files(deriveIr(parse(source))).get(HANDLER)!;
  assert.match(src, /"parameters": \{ \["Last_Name"\]: [^}]*\}, "connection": "c2c_crm" \}/);
  assert.match(src, /zohoConnections: await zohoConnections\(req, live\),/);
  assert.doesNotMatch(src, /outboundHttp|outboundConfig/);
});

test('generated live invokeurl: unlisted host refused before any request; listed host retried on 429 with one stable key', async () => {
  const seen: { method?: string; url?: string; key?: string; body: string }[] = [];
  let throttled = false;
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['idempotency-key'] as string | undefined, body });
      if (!throttled) {
        throttled = true;
        res.writeHead(429, { 'Retry-After': '0' });
        res.end();
        return;
      }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.startsWith(`${HOST}/`), `unexpected fetch ${url}`);
    return realFetch(origin + url.slice(HOST.length), init);
  }) as typeof fetch;
  const app = outboundApp();
  const req = { user: { profile: 'Administrator' }, headers: { 'idempotency-key': 'submit-42' }, body: { record: { Rest_Verb: 'POST', Rest_Last_Name: 'C2C-O1' } } };
  try {
    const refused = await run(writeTree(app, { mode: 'live', appTimeZone: 'Asia/Kolkata' }), req);
    assertPostCommitWarning(refused, 'ZOHO_CONNECTION_REFUSED');
    assert.equal(seen.length, 0);

    const ok = await run(writeTree(app, { mode: 'live', appTimeZone: 'Asia/Kolkata', outboundHosts: ['api.example.com'] }), req);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(seen.length, 2);
    assert.deepEqual([seen[0]!.method, seen[0]!.url], ['POST', '/v1/Leads']);
    assert.match(seen[0]!.key!, /^c2c-[0-9a-f]{32}$/);
    assert.equal(seen[1]!.key, seen[0]!.key);
    assert.equal((ok.body.values as Record<string, unknown>).Rest_Response, '{"accepted":true}');

    // Same caller key, same call → same downstream key (a client retry is deduplicated downstream).
    throttled = true;
    await run(writeTree(app, { mode: 'live', appTimeZone: 'Asia/Kolkata', outboundHosts: ['api.example.com'] }), req);
    assert.equal(seen[2]!.key, seen[0]!.key);
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});

// An allowlisted URL carrying userinfo made undici's
// fetch throw "…URL that includes credentials: <raw url>"; the persisted error
// field then carried user, password, secret query and fragment.

test('generated live invokeurl to an allowlisted URL carrying userinfo: refused before fetch, no canary in error or transcript', async () => {
  const USERINFO_HOST = 'https://SEKUSER:SEKPASS@api.example.com';
  const CANARIES = /SEKUSER|SEKPASS/;
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    fetches += 1;
    const url = new URL(String(input));
    // undici throws before any connection when the URL includes credentials;
    // delegate to the real fetch so the thrown message is Node's own.
    if (url.username || url.password) return realFetch(input, init);
    throw new Error(`unexpected fetch ${input}`);
  }) as typeof fetch;
  const app = outboundApp(USERINFO_HOST);
  const req = { user: { profile: 'Administrator' }, headers: {}, body: { record: { Rest_Verb: 'POST', Rest_Last_Name: 'C2C-O1' } } };
  try {
    const res = await run(writeTree(app, { mode: 'live', appTimeZone: 'Asia/Kolkata', outboundHosts: ['api.example.com'] }), req);
    assert.equal(fetches, 0, 'refused before fetch was called');
    assertPostCommitWarning(res, 'ZOHO_CONNECTION_REFUSED');
    assert.doesNotMatch(JSON.stringify(res.body), CANARIES, 'error, values and transcript carry no credential');
  } finally {
    globalThis.fetch = realFetch;
  }
});
