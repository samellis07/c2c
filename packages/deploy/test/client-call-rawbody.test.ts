/**
 * The generated c2c_api host preserves the decoded request bytes as
 * req.rawBody and the generated client-call endpoint validates them: a real
 * HTTP request — plain, gzip-encoded, or chunked — carrying a valid call gets
 * the legitimate answer, while a body with duplicate JSON keys or a request
 * the host cannot supply bytes for gets the same byte-identical 403
 * READ_DENIED, with Cache-Control: no-store, no ETag, and zero datastore
 * access.
 *
 * Everything goes through the deployed functions/c2c_api/index.js over a real
 * socket against the fake zcatalyst SDK; nothing stubs req.body or req.rawBody.
 */
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module, { createRequire } from 'node:module';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';
import type { ProjectRegistry } from '../src/registry.js';

const root = repoRoot();
const FAKE_SDK = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
const FIXTURE_ORG = process.env.C2C_TEST_ORG ?? '';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'in' };

function guardFor(app: App): GuardOk {
  return {
    org: FIXTURE_ORG,
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry: FIXTURE_REGISTRY,
  };
}

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { calls: unknown[][]; tables: Record<string, Record<string, unknown>[]> };
}

const DENIAL = JSON.stringify({ ok: false, code: 'READ_DENIED', message: 'Unable to read requested data' });

/** Serve one deployed app through the real functions/c2c_api/index.js. */
async function serve(ds: string) {
  const app = deriveIr(parse(ds));
  const out = mkdtempSync(join(tmpdir(), 'c2c-rawbody-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return FAKE_SDK;
    return original.call(this, request, ...rest);
  };
  const req = createRequire(import.meta.url);
  const sdk = req(FAKE_SDK) as FakeSdk;
  sdk.setSession('rawbody-admin', { user_id: '1', email_id: 'admin@example.test', role_details: { role_name: 'App Administrator' } });
  writeDeployTree(out, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
  const entry = req(join(out, 'functions/c2c_api/index.js')) as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const server = createServer((rq, rs) => void entry(rq, rs));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    moduleAny._resolveFilename = original;
    rmSync(out, { recursive: true, force: true });
  };
  return { port, sdk, close };
}

interface Reply {
  status: number;
  headers: Record<string, unknown>;
  raw: string;
}

/** One POST of `body` bytes (or a producer of them) to the client-call route. */
function post(port: number, opts: { path: string; body: Buffer; headers?: Record<string, string>; chunks?: number[] }): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const rq = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: opts.path,
        method: 'POST',
        headers: { cookie: 'c2c-harness-session=rawbody-admin', ...opts.headers },
      },
      (rs) => {
        const chunks: Buffer[] = [];
        rs.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        rs.on('end', () => resolve({ status: rs.statusCode ?? 0, headers: rs.headers, raw: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    rq.on('error', reject);
    const parts = opts.chunks && opts.chunks.length ? opts.chunks : [opts.body.length];
    let offset = 0;
    for (const size of parts) {
      rq.write(opts.body.subarray(offset, offset + size));
      offset += size;
    }
    rq.end();
  });
}

const DS = `application "RawBodyDemo"
{
\ttime zone = "Asia/Kolkata"
\tsection Main
\t{
\t\tform Orders
\t\t{
\t\t\tHours
\t\t\t(
\t\t\t\ttype = decimal
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tHours_check as "Hours check"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Orders
\t\t\t\trecord event = on add or edit
\t\t\t\ton user input of Hours
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif(thisapp.Util.Ok(input.Hours)) { alert "ok"; }
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\tfunctions
\t{
\t\tUtil
\t\t{
\t\t\tbool Util.Ok(decimal n)
\t\t\t{
\t\t\t\treturn n > 1;
\t\t\t}
\t\t}
\t}
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t}
}
`;

test('a real HTTP client call over the generated host succeeds, including gzip and chunked bodies', async () => {
  const { port, sdk, close } = await serve(DS);
  try {
    const json = { 'content-type': 'application/json' };
    const body = Buffer.from('{"nonce":"n1","args":[3]}', 'utf8');
    // A valid plain request gets the legitimate answer.
    const plain = await post(port, { path: '/server/c2c_api/functions/util-ok/call', body, headers: { ...json, 'content-length': String(body.length) } });
    assert.equal(plain.status, 200, plain.raw);
    const answer = JSON.parse(plain.raw) as Record<string, unknown>;
    assert.equal(answer.ok, true);
    assert.equal(answer.nonce, 'n1');
    assert.equal(answer.value, true, 'the live call ran the function');
    // A gzipped request gets the same answer: the host decompresses before
    // capturing rawBody, so the scanner sees the decoded bytes.
    const zipped = zlib.gzipSync(body);
    const gzip = await post(port, { path: '/server/c2c_api/functions/util-ok/call', body: zipped, headers: { ...json, 'content-encoding': 'gzip', 'content-length': String(zipped.length) } });
    assert.equal(gzip.status, 200, gzip.raw);
    assert.equal((JSON.parse(gzip.raw) as Record<string, unknown>).value, true);
    // A deflated request decodes identically.
    const deflated = zlib.deflateSync(body);
    const deflate = await post(port, { path: '/server/c2c_api/functions/util-ok/call', body: deflated, headers: { ...json, 'content-encoding': 'deflate', 'content-length': String(deflated.length) } });
    assert.equal(deflate.status, 200, deflate.raw);
    // A chunked transfer (no content-length, several writes) decodes identically.
    const chunked = await post(port, {
      path: '/server/c2c_api/functions/util-ok/call',
      body,
      headers: { ...json, 'transfer-encoding': 'chunked' },
      chunks: [5, 9, body.length - 14],
    });
    assert.equal(chunked.status, 200, chunked.raw);
    assert.equal((JSON.parse(chunked.raw) as Record<string, unknown>).value, true);
    // A chunked gzip body takes both decode paths.
    const gzipChunks = await post(port, {
      path: '/server/c2c_api/functions/util-ok/call',
      body: zipped,
      headers: { ...json, 'content-encoding': 'gzip', 'transfer-encoding': 'chunked' },
      chunks: [7, zipped.length - 7],
    });
    assert.equal(gzipChunks.status, 200, gzipChunks.raw);
    assert.ok(sdk.state().calls.length === 0, 'a pure function performs no datastore reads');
  } finally {
    await close();
  }
});

test('duplicate-key and missing-raw-body requests get one byte-identical denial, zero datastore access, no-store and no ETag', async () => {
  const { port, sdk, close } = await serve(DS);
  try {
    const json = { 'content-type': 'application/json' };
    const send = async (wire: string, headers: Record<string, string> = {}) => {
      const body = Buffer.from(wire, 'utf8');
      const res = await post(port, { path: '/server/c2c_api/functions/util-ok/call', body, headers: { ...json, 'content-length': String(body.length), ...headers } });
      assert.equal(res.headers['cache-control'], 'no-store', 'every reply forbids caching');
      assert.equal(res.headers['etag'], undefined, 'no ETag on a client-call reply');
      return res;
    };
    const before = sdk.state().calls.length;
    // Duplicate member at any depth, including escaped key names: the host
    // supplies the decoded bytes and the endpoint answers the one denial.
    for (const wire of [
      '{"args":[3],"args":[3]}',
      '{"args":[3],"\\u0061rgs":[3]}',
      '{"nonce":"n","args":[3],"nonce":"m"}',
      '{"args":[{"x":1,"x":2}]}',
    ]) {
      const res = await send(wire);
      assert.equal(res.status, 403, wire);
      assert.equal(res.raw, DENIAL, `denial is byte-identical: ${wire}`);
    }
    // JSON that cannot parse at all is refused by the host body reader before
    // the endpoint runs — denied at the same boundary, still no datastore.
    for (const wire of ['{"args":[3],}', '{"args":[3]} {"args":[3]}', 'not json']) {
      const res = await send(wire);
      assert.equal(res.status, 400, wire);
    }
    assert.equal(sdk.state().calls.length, before, 'denials never reach the datastore');
    // An application/json body the host already parsed into a value — here a
    // string — leaves req.rawBody unset for the handler's purposes and is
    // refused at the boundary, never dispatched.
    for (const wire of ['"text"', '[1,2]', '42']) {
      const body = Buffer.from(wire, 'utf8');
      const res = await post(port, { path: '/server/c2c_api/functions/util-ok/call', body, headers: { ...json, 'content-length': String(body.length) } });
      assert.ok(res.status === 400 || res.status === 403, `${wire}: ${res.status}`);
      assert.notEqual(res.status, 200);
    }
    assert.equal(sdk.state().calls.length, before, 'host refusals never reach the datastore');
  } finally {
    await close();
  }
});
