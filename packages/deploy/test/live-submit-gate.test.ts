/**
 * Golden: a .ds without the `time zone` application setting is reported at
 * generate time, not at request time — a live tree built from it fails every
 * live handler with 500 (TimeZoneRequired inside createRuntime). And a 500
 * response never echoes an internal error to the client: only Creator's own
 * Deluge runtime texts and named live-refused denials may cross the wire.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';

const FIXTURE_ORG = '10000000000';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'in' };

const root = repoRoot();
const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');

/** Smallest failing app shape: one form, no machines, no `time zone` setting. */
const DS_NO_ZONE = `application "NoZone"
{
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t}
\tforms
\t{
\t\tform Book
\t\t{
\t\t\tTitle
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t}
}
`;

function throwOnSuccess(script: string): string {
  return `application "ThrowOnSuccess"
{
\ttime zone = "Asia/Kolkata"
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t}
\tforms
\t{
\t\tform Book
\t\t{
\t\t\tTitle
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tBook_Success as "Book Success"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Book
\t\t\t\trecord event = on add
\t\t\t\ton success
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
${script}
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
}

/** Internal error: `for each` over a number throws UncapturedDelugeError — no Creator text exists for it. */
const DS_INTERNAL = throwOnSuccess('\t\t\t\t\t\t\tfor each k in 42\n\t\t\t\t\t\t\t{\n\t\t\t\t\t\t\t\tinput.Title = k;\n\t\t\t\t\t\t\t}');
/** Creator-text error: toLong on non-numeric text throws DelugeConversionError, a DelugeRuntimeError. */
const DS_DELUGE = throwOnSuccess('\t\t\t\t\t\t\tinput.Title = input.Title.toLong();');

function guardFor(app: ReturnType<typeof deriveIr>): GuardOk {
  return {
    org: FIXTURE_ORG,
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry: FIXTURE_REGISTRY,
  };
}

test('a live deploy of an app without a `time zone` setting fails at generate time and names the fix', () => {
  const app = deriveIr(parse(DS_NO_ZONE));
  assert.throws(
    () => deployFiles(app, guardFor(app), false, { mode: 'live' }),
    /time zone/,
    'live deployFiles must refuse a tree whose every live handler would 500',
  );
});

test('the same app still generates a dry-run tree (labelled UTC fallback, no live write)', () => {
  const app = deriveIr(parse(DS_NO_ZONE));
  const { files } = deployFiles(app, guardFor(app), false, { mode: 'dry-run' });
  assert.ok(files.some((file) => file.path === 'functions/c2c_api/c2c-deploy.json'));
});

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Record<string, unknown>[]> };
}

async function liveSubmit(ds: string): Promise<{ status: number; body: Record<string, unknown>; rows: Record<string, unknown>[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-nozone-gate-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  let server: Server | undefined;
  try {
    const app = deriveIr(parse(ds));
    writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const req = createRequire(import.meta.url);
    const sdk = req(fake) as FakeSdk;
    sdk.setSession('admin', { user_id: '1', email_id: 'admin@example.test', role_details: { role_name: 'App Administrator' } });
    const entry = req(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api/forms/Book/success`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=admin' },
      body: JSON.stringify({ record: { Title: 'abc' } }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    return { status: res.status, body, rows: sdk.state().tables.Book ?? [] };
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    moduleAny._resolveFilename = original;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a 500 hides handler details after an uncaptured for-each throw', async () => {
  const res = await liveSubmit(DS_INTERNAL);
  assert.equal(res.status, 500, JSON.stringify(res.body));
  assert.equal(res.body.code, 'INTERNAL_ERROR');
  assert.equal(res.body.wrote, true, 'the row write precedes the on-success script');
  assert.equal(res.body.message, 'Internal server error', 'an internal error message must not reach the client');
  assert.match(String(res.body.correlationId), /^[0-9a-f-]{36}$/i);
  assert.deepEqual(Object.keys(res.body).sort(), ['code', 'correlationId', 'message', 'wrote']);
  assert.equal(Object.hasOwn(res.body, 'error'), false);
  assert.equal(res.rows.length, 1, 'the write is not rolled back');
});

test('a Creator-text Deluge error stays out of the client response after the write', async () => {
  const res = await liveSubmit(DS_DELUGE);
  assert.equal(res.status, 500, JSON.stringify(res.body));
  assert.equal(res.body.code, 'INTERNAL_ERROR');
  assert.equal(res.body.wrote, true);
  assert.equal(res.body.message, 'Internal server error');
  assert.match(String(res.body.correlationId), /^[0-9a-f-]{36}$/i);
  assert.deepEqual(Object.keys(res.body).sort(), ['code', 'correlationId', 'message', 'wrote']);
  assert.doesNotMatch(JSON.stringify(res.body), /Unable to cast|abc/);
  assert.equal(Object.hasOwn(res.body, 'error'), false);
});
