/**
 * A bulk import write (body.import === true — the seed/migrate-data path)
 * skips the on-load field-rule denials: show/hide/enable/disable rules are UI
 * state, not data rules. Everything else still binds the write: the profile
 * grant, a mandatory column, the on-validate scripts, and the posted shape.
 *
 * The field-rule skip is a server-side capability: only an
 * Administrator-profile caller may post an import write. A body flag alone
 * grants nothing — a normal profile gets the same refusal as a plain post.
 *
 * The export: Booking_Form.Title is mandatory; a field rule hides
 * Official_Email on add; On Validate cancels a Title of "reject". The "User"
 * profile may view, create and edit but is not an administrator.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';

const root = repoRoot();
const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
const FIXTURE_ORG = '10000000000';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'in' };

const t = (n: number) => '\t'.repeat(n);

const DS = `application "Imports"
{
${t(1)}time zone = "Asia/Kolkata"
${t(1)}share_settings
${t(1)}{
${t(2)}"Administrator"
${t(2)}{
${t(3)}name = "Administrator"
${t(3)}type = Users_Permissions
${t(3)}description = "This profile will have all the permissions."
${t(2)}}
${t(2)}"User"
${t(2)}{
${t(3)}name = "User"
${t(3)}type = Users_Permissions
${t(3)}ModulePermissions
${t(3)}{
${t(4)}Booking_Form
${t(4)}{
${t(5)}enabled = true
${t(5)}ReportPermissions
${t(5)}{
${t(6)}All_Bookings = {"View","Create","Edit"}
${t(5)}}
${t(4)}}
${t(3)}}
${t(2)}}
${t(1)}}
${t(1)}forms
${t(1)}{
${t(2)}form Booking_Form
${t(2)}{
${t(3)}must have Title
${t(3)}(
${t(4)}type = text
${t(3)})
${t(3)}Status
${t(3)}(
${t(4)}type = text
${t(3)})
${t(3)}Official_Email
${t(3)}(
${t(4)}type = text
${t(3)})
${t(2)}}
${t(1)}}
${t(1)}reports
${t(1)}{
${t(2)}list All_Bookings
${t(2)}{
${t(3)}show all rows from Booking_Form
${t(3)}(
${t(4)}Title
${t(4)}Status
${t(4)}Official_Email
${t(3)})
${t(2)}}
${t(1)}}
${t(1)}workflow
${t(1)}{
${t(2)}form
${t(2)}{
${t(3)}Rules as "Rules"
${t(3)}{
${t(4)}type = form
${t(4)}form = Booking_Form
${t(4)}record event = on add
${t(4)}field rules
${t(4)}{
${t(5)}actions
${t(5)}{
${t(6)}hide Official_Email;
${t(6)}disable Status;
${t(5)}}
${t(4)}}
${t(3)}}
${t(3)}Gate as "Gate"
${t(3)}{
${t(4)}type = form
${t(4)}form = Booking_Form
${t(4)}record event = on add
${t(4)}on validate
${t(4)}{
${t(5)}actions
${t(5)}{
${t(6)}custom deluge script
${t(6)}(
${t(7)}if (input.Title == "reject")
${t(7)}{
${t(8)}cancel submit;
${t(7)}}
${t(6)})
${t(5)}}
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

interface PostReply {
  status: number;
  body: Record<string, unknown>;
}

test('a bulk import write skips the on-load field rule but keeps grant, required and on-validate checks', async (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-import-field-rules-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  let server: Server | undefined;
  try {
    const app = deriveIr(parse(DS));
    const userProfile = app.profiles.find((profile) => profile.name === 'User')!;
    const mutations = [
      { session: 'trailing', role: 'Trailing administrator', profile: 'Administrator ' },
      { session: 'case', role: 'Case administrator', profile: 'administrator' },
      { session: 'developer', role: 'Developer', profile: 'Developer' },
    ];
    for (const { profile } of mutations) app.profiles.push({ ...userProfile, name: profile });
    writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const policy = JSON.parse(readFileSync(join(dir, 'functions/c2c_api/access-policy.json'), 'utf8'));
    assert.deepEqual(policy.admins, ['Administrator']);
    const mapPath = join(dir, 'functions/c2c_api/principal-map.json');
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    for (const { role, profile } of mutations) map.roles[role] = profile;
    writeFileSync(mapPath, JSON.stringify(map));
    const req = createRequire(import.meta.url);
    const sdk = req(fake) as FakeSdk;
    sdk.setSession('admin', { user_id: '1', email_id: 'admin@example.test', role_details: { role_name: 'App Administrator' } });
    sdk.setSession('user', { user_id: '2', email_id: 'user@example.test', role_details: { role_name: 'App User' } });
    for (const { session, role } of mutations) {
      sdk.setSession(session, { user_id: session, email_id: `${session}@example.test`, role_details: { role_name: role } });
    }

    const entry = req(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const post = async (body: Record<string, unknown>, session = 'admin', headers: Record<string, string> = {}): Promise<PostReply> => {
      const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api/forms/Booking_Form/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(session ? { cookie: `c2c-harness-session=${session}` } : {}), ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
    };
    const row = (title: string) => (sdk.state().tables.Booking_Form ?? []).find((r) => r.Title === title);

    for (const { session, profile } of mutations) {
      await context.test(`verified profile ${JSON.stringify(profile)} cannot import`, async () => {
        for (const field of ['Official_Email', 'Status']) {
          const title = `${session}-${field}`;
          const result = await post({ record: { Title: title, [field]: 'blocked' }, import: true }, session);
          assert.equal(result.status, 403, JSON.stringify(result.body));
          assert.equal(row(title), undefined, 'a refused import must not write');
        }
      });
    }
    await context.test('body profile cannot promote a normal user', async () => {
      const result = await post({ record: { Title: 'body-spoof', Official_Email: 'blocked' }, import: true, profile: 'Administrator' }, 'user');
      assert.equal(result.status, 403, JSON.stringify(result.body));
      assert.equal(row('body-spoof'), undefined);
    });
    await context.test('X-Profile and X-Admin cannot promote a normal user', async () => {
      const result = await post({ record: { Title: 'header-spoof', Official_Email: 'blocked' }, import: true }, 'user', { 'X-Profile': 'Administrator', 'X-Admin': 'true' });
      assert.equal(result.status, 403, JSON.stringify(result.body));
      assert.equal(row('header-spoof'), undefined);
    });

    // A plain client post of the hidden field is still refused.
    const client = await post({ record: { Title: 'client-sets', Official_Email: 'a@example.test' } });
    assert.equal(client.status, 403, JSON.stringify(client.body));
    assert.match(String(client.body.message), /Booking_Form\.Official_Email is hidden by a field rule/);
    assert.equal(row('client-sets'), undefined, 'a refused submit must not write');

    // The flag alone grants nothing: a non-administrator principal posting
    // import:true gets the same field-rule refusal as a plain post.
    const userImport = await post({ record: { Title: 'user-import', Official_Email: 'a@example.test' }, import: true }, 'user');
    assert.equal(userImport.status, 403, JSON.stringify(userImport.body));
    assert.match(String(userImport.body.message), /Booking_Form\.Official_Email is hidden by a field rule/);
    assert.equal(row('user-import'), undefined, 'a refused import write must not write');

    // A disabled-by-rule field is refused the same way for a normal profile.
    const userDisable = await post({ record: { Title: 'user-status', Status: 'Approved' }, import: true }, 'user');
    assert.equal(userDisable.status, 403, JSON.stringify(userDisable.body));
    assert.match(String(userDisable.body.message), /Booking_Form\.Status is disabled by a field rule/);
    assert.equal(row('user-status'), undefined, 'a refused import write must not write');

    // Anonymous is refused before the body flag is read.
    const anonymous = await post({ record: { Title: 'anon', Official_Email: 'a@example.test' }, import: true }, '');
    assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body));
    assert.equal(row('anon'), undefined, 'a refused import write must not write');

    // The same record as a bulk import write from an administrator stores the hidden field's value.
    await context.test('exact Administrator imports and stores hidden and disabled fields', async () => {
      const imported = await post({ record: { Title: 'imported', Official_Email: 'a@example.test', Status: 'Open' }, import: true });
      assert.equal(imported.status, 200, JSON.stringify(imported.body));
      assert.equal(imported.body.wrote, true);
      assert.equal(row('imported')?.Official_Email, 'a@example.test');
      assert.equal(row('imported')?.Status, 'Open');
    });

    // A required column missing from an import write is still refused.
    const mandatory = await post({ record: { Official_Email: 'b@example.test' }, import: true });
    assert.equal(mandatory.status, 422, JSON.stringify(mandatory.body));
    assert.equal(mandatory.body.code, 'MANDATORY_MISSING');

    // An on-validate rule still rejects bad data on an import write.
    const validated = await post({ record: { Title: 'reject' }, import: true });
    assert.equal(validated.status, 422, JSON.stringify(validated.body));
    assert.equal(validated.body.refused, true);
    assert.equal(row('reject'), undefined, 'a refused import write must not write');
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    moduleAny._resolveFilename = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
