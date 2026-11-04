/**
 * A bulk import write (body.import === true — the seed/migrate-data path)
 * skips the on-load field-rule denials: show/hide/enable/disable rules are UI
 * state, not data rules. Everything else still binds the write: the profile
 * grant, a mandatory column, the on-validate scripts, and the posted shape.
 *
 * The export: Booking_Form.Title is mandatory; a field rule hides
 * Official_Email on add; On Validate cancels a Title of "reject".
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

test('a bulk import write skips the on-load field rule but keeps grant, required and on-validate checks', async () => {
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
    writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const req = createRequire(import.meta.url);
    const sdk = req(fake) as FakeSdk;
    sdk.setSession('admin', { user_id: '1', email_id: 'admin@example.test', role_details: { role_name: 'App Administrator' } });

    const entry = req(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const post = async (body: Record<string, unknown>): Promise<PostReply> => {
      const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api/forms/Booking_Form/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=admin' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
    };
    const row = (title: string) => (sdk.state().tables.Booking_Form ?? []).find((r) => r.Title === title);

    // A plain client post of the hidden field is still refused.
    const client = await post({ record: { Title: 'client-sets', Official_Email: 'a@example.test' } });
    assert.equal(client.status, 403, JSON.stringify(client.body));
    assert.match(String(client.body.message), /Booking_Form\.Official_Email is hidden by a field rule/);
    assert.equal(row('client-sets'), undefined, 'a refused submit must not write');

    // The same record as a bulk import write stores the hidden field's value.
    const imported = await post({ record: { Title: 'imported', Official_Email: 'a@example.test', Status: 'Open' }, import: true });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.wrote, true);
    assert.equal(row('imported')?.Official_Email, 'a@example.test');
    assert.equal(row('imported')?.Status, 'Open');

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
