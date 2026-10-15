/**
 * c2c-sec-csrf-415 (AUDIT A F8): the generated c2c_api entry refuses a
 * non-JSON content type on writes with 415, so a cookie-only cross-site
 * form post (text/plain, urlencoded, multipart — the only content types a
 * browser sends without a CORS preflight) can never reach a handler.
 * Both clients always send application/json.
 *
 * The request goes through the deployed index.js router with the fake
 * Catalyst SDK, exactly like role-security-live.test.ts.
 */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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

const root = repoRoot();
const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');

const t = (n: number) => '\t'.repeat(n);

const DS = `application "CsrfProbe"
{
${t(1)}time zone = "Asia/Kolkata"
${t(1)}forms
${t(1)}{
${t(2)}form Note
${t(2)}{
${t(3)}Title
${t(3)}(
${t(4)}type = text
${t(3)})
${t(2)}}
${t(1)}}
${t(1)}share_settings
${t(1)}{
${t(2)}"Clerk"
${t(2)}{
${t(3)}name = "Clerk"
${t(3)}type = Users_Permissions
${t(3)}permissions = {Chat:false, Predefined:false, ApiAccess:true, PIIAccess:true, ePHIAccess:true}
${t(3)}ModulePermissions
${t(3)}{
${t(4)}Note
${t(4)}{
${t(5)}enabled= Create,Viewall,Tab
${t(5)}allFieldsVisible= true
${t(4)}}
${t(3)}}
${t(2)}}
${t(1)}}
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

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Record<string, unknown>[]> };
}

interface Client {
  post(path: string, body: string, contentType: string | undefined, who: string | null): Promise<{ status: number; text: string }>;
  noteRows(): Record<string, unknown>[];
}

async function withApp(run: (client: Client) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-csrf-415-'));
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
    const sdk = require(fake) as FakeSdk;
    // Whatever role the auth plan maps to the Clerk profile signs in here;
    // the mapping itself is not under test, so discover it from the tree.
    const fnDir = join(dir, 'functions/c2c_api');
    const roles = JSON.parse(readFileSync(join(fnDir, 'principal-map.json'), 'utf8')) as { roles: Record<string, string> };
    const policy = JSON.parse(readFileSync(join(fnDir, 'access-policy.json'), 'utf8')) as { profiles: Record<string, unknown> };
    const role = Object.keys(roles.roles).find((name) => Object.hasOwn(policy.profiles, roles.roles[name]!));
    assert.ok(role, 'the tree maps at least one role to a profile');
    sdk.setSession('clerk', { user_id: '11', email_id: 'clerk@example.test', role_details: { role_name: role } });
    const entry = require(join(fnDir, 'index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const post: Client['post'] = (path, body, contentType, who) =>
      new Promise((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (contentType !== undefined) headers['content-type'] = contentType;
        if (who) headers.cookie = `c2c-harness-session=${who}`;
        const rq = httpRequest(
          { host: '127.0.0.1', port, path: `/server/c2c_api${path}`, method: 'POST', headers },
          (rs) => {
            let text = '';
            rs.on('data', (chunk) => {
              text += chunk;
            });
            rs.on('end', () => resolve({ status: rs.statusCode ?? 0, text }));
          },
        );
        rq.on('error', reject);
        rq.end(body);
      });
    await run({ post, noteRows: () => sdk.state().tables.Note ?? [] });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    moduleAny._resolveFilename = original;
    rmSync(dir, { recursive: true, force: true });
  }
}

const SMUGGLED = '{"record":{"Title":"csrf-pwned"}}';

test('a text/plain cross-site-shaped write is refused with 415 and writes nothing', async () => {
  await withApp(async ({ post, noteRows }) => {
    const res = await post('/forms/Note/submit', SMUGGLED, 'text/plain', 'clerk');
    assert.equal(res.status, 415, res.text);
    assert.deepEqual(JSON.parse(res.text), { code: 'REQUEST_FAILED', message: 'Invalid request' });
    assert.doesNotMatch(res.text, /csrf-pwned/, 'the refusal echoes no record data');
    assert.equal(noteRows().length, 0, 'a refused write must not write');
  });
});

test('urlencoded, multipart and missing content types are refused with 415', async () => {
  await withApp(async ({ post, noteRows }) => {
    for (const contentType of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=----x', undefined]) {
      const res = await post('/forms/Note/submit', SMUGGLED, contentType, 'clerk');
      assert.equal(res.status, 415, `${String(contentType)}: ${res.text}`);
    }
    assert.equal(noteRows().length, 0, 'a refused write must not write');
  });
});

test('application/json still submits (charset and case included); anonymous JSON is still 401', async () => {
  await withApp(async ({ post, noteRows }) => {
    for (const contentType of ['application/json', 'application/json; charset=utf-8', 'Application/JSON; Charset=UTF-8']) {
      const res = await post('/forms/Note/submit', '{"record":{"Title":"legit"}}', contentType, 'clerk');
      assert.equal(res.status, 200, `${contentType}: ${res.text}`);
    }
    assert.equal(noteRows().length, 3);
    const anon = await post('/forms/Note/submit', '{"record":{"Title":"anon"}}', 'application/json', null);
    assert.equal(anon.status, 401, anon.text);
    assert.equal(noteRows().length, 3, 'an unauthenticated write must not write');
  });
});
