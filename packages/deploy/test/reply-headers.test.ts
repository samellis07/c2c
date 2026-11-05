/**
 * Every reply of the deployed c2c_api entry carries nosniff and no-store,
 * including generated handlers that write only Content-Type themselves. The
 * htmlpage endpoint is such a handler: its send() writes one header, and the
 * entry sets the other two on the response before the handler runs.
 *
 * The request goes through the deployed index.js router with the fake
 * Catalyst SDK, like csrf-content-type.test.ts.
 */
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
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
const ZML = `<zml><layout><row><column width='100%'><dsp id='hp1'><![CDATA[htmlpage hp1()\ncontent\n<p>Hello <%= input.value %></p>]]></dsp></column></row></layout></zml>`;

const DS = `application "HeaderProbe"
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
${t(1)}pages
${t(1)}{
${t(2)}page Home
${t(2)}{
${t(3)}Content=${JSON.stringify(ZML)}
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

interface FakeSdk {
  setSession(token: string, user: unknown): void;
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

async function withApp(run: (post: (path: string, body: string, who: string | null) => Promise<Reply>, pagePath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-reply-headers-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  let server: Server | undefined;
  try {
    const app = deriveIr(parse(DS));
    // An Administrator profile lets the page's server snippet translate (as in function-dir.test.ts).
    app.profiles.push({ name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } });
    const guard: GuardOk = { org: FIXTURE_ORG, projectId: '1001', environment: ALLOWED_ENV, projectName: catalystProjectName(app.name || 'app'), dc: 'in', registry: FIXTURE_REGISTRY };
    writeDeployTree(dir, deployFiles(app, guard, false, { mode: 'live' }).files);
    const fnDir = join(dir, 'functions/c2c_api');
    // The page handler re-parses its HTML with the pinned parser; resolve it from the repo install.
    symlinkSync(join(root, 'node_modules'), join(fnDir, 'node_modules'), 'dir');
    const pages = readdirSync(join(fnDir, 'htmlpages')).filter((name) => name.endsWith('.mjs'));
    assert.equal(pages.length, 1, `one htmlpage handler, found ${pages.join(', ')}`);
    const source = readFileSync(join(fnDir, 'htmlpages', pages[0]!), 'utf8');
    // The handler under test writes only Content-Type itself.
    assert.match(source, /res\.writeHead\(status, \{ "Content-Type": "application\/json" \}\)/);
    const pagePath = /export const endpoint = \{[^}]*path: "([^"]+)"/.exec(source)?.[1];
    assert.ok(pagePath, 'the htmlpage handler names its endpoint path');
    const require = createRequire(import.meta.url);
    const sdk = require(fake) as FakeSdk;
    const roles = JSON.parse(readFileSync(join(fnDir, 'principal-map.json'), 'utf8')) as { roles: Record<string, string> };
    const policy = JSON.parse(readFileSync(join(fnDir, 'access-policy.json'), 'utf8')) as { profiles: Record<string, unknown> };
    const role = Object.keys(roles.roles).find((name) => Object.hasOwn(policy.profiles, roles.roles[name]!));
    assert.ok(role, 'the tree maps at least one role to a profile');
    sdk.setSession('clerk', { user_id: '11', email_id: 'clerk@example.test', role_details: { role_name: role } });
    const entry = require(join(fnDir, 'index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const post = (path: string, body: string, who: string | null) =>
      new Promise<Reply>((resolve, reject) => {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (who) headers.cookie = `c2c-harness-session=${who}`;
        const rq = httpRequest({ host: '127.0.0.1', port, path: `/server/c2c_api${path}`, method: 'POST', headers }, (rs) => {
          let text = '';
          rs.on('data', (chunk) => {
            text += chunk;
          });
          rs.on('end', () => resolve({ status: rs.statusCode ?? 0, headers: rs.headers, text }));
        });
        rq.on('error', reject);
        rq.end(body);
      });
    await run(post, pagePath);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    moduleAny._resolveFilename = original;
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertHardened(reply: Reply, label: string): void {
  assert.equal(reply.headers['x-content-type-options'], 'nosniff', `${label}: ${reply.status} ${reply.text}`);
  assert.equal(reply.headers['cache-control'], 'no-store', `${label}: ${reply.status} ${reply.text}`);
  assert.match(String(reply.headers['content-type']), /^application\/json/, label);
}

test('a generated htmlpage reply through the deployed entry carries nosniff and no-store', async () => {
  await withApp(async (post, pagePath) => {
    const ok = await post(pagePath, '{}', 'clerk');
    assert.equal(ok.status, 200, ok.text);
    assert.match(JSON.parse(ok.text).html, /Hello/);
    assertHardened(ok, 'rendered page');
  });
});

test('entry refusals and unknown routes carry nosniff and no-store', async () => {
  await withApp(async (post, pagePath) => {
    assertHardened(await post(pagePath, '{}', null), 'signed out');
    assertHardened(await post('/no/such/endpoint', '{}', 'clerk'), 'unknown route');
  });
});
