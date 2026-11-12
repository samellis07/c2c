/**
 * c2c-generated-routes-session-check: every generated c2c_api route needs a
 * signed-in Catalyst user, and no route changes state on GET.
 *
 * The generator has no public-form grant, so no route is a declared public
 * form: an anonymous call to each route in routes.json, with its declared
 * method, is 401 and runs no handler. A GET is a safe method (sent cross-site
 * with cookies, no CORS preflight), so the only GET routes are the lookup
 * read and a custom API whose function only reads; a custom API declared GET
 * whose function writes is routed as POST. Per-profile allow/deny is the
 * authz matrix test's job, not this file's.
 *
 * The request goes through the deployed index.js router with the fake
 * Catalyst SDK, like role-security-live.test.ts.
 */
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const fake = join(repoRoot(), 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');

const DS = `application "Anon_Probe"
{
\ttime zone = "Asia/Kolkata"
\tfunctions
\t{
\t\tDeluge
\t\t{
\t\t\tstring Probe.readTitle(string t)
\t\t\t{
\t\t\t\treturn t;
\t\t\t}
\t\t\tstring Probe.writeNote(string t)
\t\t\t{
\t\t\t\tinsert into Note [ Title = t ];
\t\t\t\treturn t;
\t\t\t}
\t\t}
\t}
\tform Vendor
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Note
\t{
\t\tTitle
\t\t(
\t\t\ttype = text
\t\t)
\t\tSupplier
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Vendor.Name
\t\t)
\t\tScan
\t\t(
\t\t\ttype = file
\t\t)
\t}
\tlist All_Notes
\t{
\t\tshow all rows from Note
\t\t(
\t\t\tTitle
\t\t)
\t}
\tapi Read_Title
\t{
\t\tmethod = GET
\t\tscope = "Admin only"
\t\tactions
\t\t(
\t\t\tanon-probe.Probe.readTitle(t)
\t\t)
\t}
\tapi Write_Note
\t{
\t\tmethod = GET
\t\tscope = "Admin only"
\t\tactions
\t\t(
\t\t\tanon-probe.Probe.writeNote(t)
\t\t)
\t}
\tshare_settings
\t{
\t\tAdministrator
\t\t{
\t\t\ttype = Users_Permissions
\t\t}
\t}
}
`;

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

interface Tree {
  routes: Record<string, string>;
  source(spec: string): string;
  call(method: string, path: string): Promise<{ status: number; text: string }>;
  writes(): number;
}

async function withTree(run: (tree: Tree) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-anon-routes-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  let server: Server | undefined;
  try {
    const app = deriveIr(parse(DS));
    writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const require = createRequire(import.meta.url);
    const sdk = require(fake) as { state(): { tables: Record<string, unknown[]> } };
    const fnDir = join(dir, 'functions/c2c_api');
    const routes = JSON.parse(readFileSync(join(fnDir, 'routes.json'), 'utf8')) as Record<string, string>;
    const entry = require(join(fnDir, 'index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    // Anonymous: no session cookie and no authorization header.
    const call: Tree['call'] = (method, path) =>
      new Promise((resolve, reject) => {
        const rq = httpRequest(
          { host: '127.0.0.1', port, path: `/server/c2c_api${path}`, method, headers: { 'content-type': 'application/json' } },
          (rs) => {
            let text = '';
            rs.on('data', (chunk) => {
              text += chunk;
            });
            rs.on('end', () => resolve({ status: rs.statusCode ?? 0, text }));
          },
        );
        rq.on('error', reject);
        rq.end(method === 'GET' || method === 'HEAD' ? undefined : '{"record":{"Title":"anon"},"args":["anon"]}');
      });
    const writes = () => Object.values(sdk.state().tables).reduce((n, rows) => n + rows.length, 0);
    await run({ routes, source: (spec) => readFileSync(join(fnDir, spec), 'utf8'), call, writes });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    moduleAny._resolveFilename = original;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A concrete path for a routes.json path: each `:param` segment gets a placeholder. */
function concrete(path: string): string {
  return path.replace(/:(form)\b/g, 'Note').replace(/:(field)\b/g, 'Supplier').replace(/:[A-Za-z_]+/g, 'x');
}

/** The route family: the first path segment ("/forms/Note/submit" -> "forms"). */
function family(key: string): string {
  return key.slice(key.indexOf(' ') + 2).split('/')[0]!;
}

test('every generated route family answers an anonymous call with 401 and writes nothing', async () => {
  await withTree(async ({ routes, call, writes }) => {
    const families = new Set(Object.keys(routes).map(family));
    // The probe app covers each route family the generator writes for it.
    for (const expected of ['admin', 'files', 'forms', 'functions', 'lookups', 'reports', 'uploads']) {
      assert.ok(families.has(expected), `routes.json has a ${expected} route: ${Object.keys(routes).join(', ')}`);
    }
    for (const key of Object.keys(routes)) {
      const [method, path] = key.split(' ') as [string, string];
      const res = await call(method, concrete(path));
      assert.equal(res.status, 401, `${key}: ${res.text}`);
      assert.deepEqual(JSON.parse(res.text), { code: 'UNAUTHENTICATED', message: 'Sign in required' }, key);
    }
    assert.equal(writes(), 0, 'an anonymous call must not write');
  });
});

test('state changes are never routed on GET; a GET-declared writing custom API is routed as POST', async () => {
  await withTree(async ({ routes, source, call }) => {
    const methods = new Set(Object.keys(routes).map((key) => key.slice(0, key.indexOf(' '))));
    for (const method of methods) assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method), method);
    const gets = Object.keys(routes)
      .filter((key) => key.startsWith('GET '))
      .sort();
    assert.deepEqual(gets, ['GET /functions/probe-readtitle', 'GET /lookups/:form/:field']);
    for (const key of gets) {
      assert.doesNotMatch(
        source(routes[key]!),
        /\bshim\.(?:datastore\.(?:insert|insertRow|update|delete|flush|setField|writeRow)|mail\.send|http\.invokeurl|zoho\.task|thisapp\.call|todo)\(/,
        `${key} is a GET and must not change state`,
      );
    }
    assert.ok(routes['POST /functions/probe-writenote'], 'the writing custom API is routed as POST');
    assert.equal(routes['GET /functions/probe-writenote'], undefined);
    // A GET to a POST-only route is 405 before the session is even read.
    for (const path of ['/forms/Note/submit', '/functions/probe-writenote', '/admin/smoke']) {
      const res = await call('GET', path);
      assert.equal(res.status, 405, `GET ${path}: ${res.text}`);
    }
  });
});
