/**
 * A field an unconditional Creator field rule hides is refused when the
 * client posts it, but the app's own On Success script may still set it:
 * Creator stores On Success input assignments with the record, and a field
 * rule is a form behaviour, not a write permission. The profile's field
 * permissions apply to both paths.
 *
 * The export: Ticket.Status is hidden on add; On Success sets
 * input.Status = "Assigned". Lead may write every field; Agent has Status
 * read-only.
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
import { generate } from '../../deluge/src/generate.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';

const root = repoRoot();
const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');

const t = (n: number) => '\t'.repeat(n);

function field(name: string): string {
  return `${t(3)}${name}\n${t(3)}(\n${t(4)}type = text\n${t(3)})`;
}

function profile(name: string, statusReadonly: boolean): string {
  return [
    `${t(2)}"${name}"`,
    `${t(2)}{`,
    `${t(3)}name = "${name}"`,
    `${t(3)}type = Users_Permissions`,
    `${t(3)}permissions = {Chat:false, Predefined:false, ApiAccess:true, PIIAccess:true, ePHIAccess:true}`,
    `${t(3)}ModulePermissions`,
    `${t(3)}{`,
    `${t(5)}Ticket`,
    `${t(5)}{`,
    `${t(6)}enabled= Create,Viewall,Modifyall,Tab `,
    `${t(6)}allFieldsVisible= false `,
    `${t(6)}ReportPermissions`,
    `${t(6)}{`,
    `${t(7)}All_Tickets={"View","Edit"}`,
    `${t(6)}}`,
    `${t(6)}FieldPermissions`,
    `${t(6)}{`,
    `${t(7)}Title\n${t(7)}{\n${t(8)}visibility:true,readonly:false\n${t(7)}}`,
    `${t(7)}Status\n${t(7)}{\n${t(8)}visibility:true,readonly:${statusReadonly}\n${t(7)}}`,
    `${t(6)}}`,
    `${t(5)}}`,
    `${t(3)}}`,
    `${t(2)}}`,
  ].join('\n');
}

const DS = `application "Desk"
{
${t(1)}time zone = "Asia/Kolkata"
${t(1)}forms
${t(1)}{
${t(2)}form Ticket
${t(2)}{
${field('Title')}
${field('Status')}
${t(2)}}
${t(1)}}
${t(1)}reports
${t(1)}{
${t(2)}list All_Tickets
${t(2)}{
${t(3)}show all rows from Ticket
${t(3)}(
${t(4)}Title
${t(4)}Status
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
${t(4)}form = Ticket
${t(4)}record event = on add
${t(4)}field rules
${t(4)}{
${t(5)}actions
${t(5)}{
${t(6)}hide Status;
${t(5)}}
${t(4)}}
${t(3)}}
${t(3)}Assign as "Assign"
${t(3)}{
${t(4)}type = form
${t(4)}form = Ticket
${t(4)}record event = on add
${t(4)}on success
${t(4)}{
${t(5)}actions
${t(5)}{
${t(6)}custom deluge script
${t(6)}(
${t(7)}input.Status = "Assigned";
${t(6)})
${t(5)}}
${t(4)}}
${t(3)}}
${t(2)}}
${t(1)}}
${t(1)}share_settings
${t(1)}{
${profile('Lead', false)}
${profile('Agent', true)}
${t(1)}}
}
`;

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Record<string, unknown>[]> };
}

const USERS = {
  lead: { user_id: '21', email_id: 'lead@example.test', role_details: { role_name: 'Lead' } },
  agent: { user_id: '22', email_id: 'agent@example.test', role_details: { role_name: 'Agent' } },
};

function guardFor(app: ReturnType<typeof deriveIr>): GuardOk {
  return {
    org: '10000000000',
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry: { org: '10000000000', env: 'Development', projects: {}, dc: 'in' },
  };
}

test('a field rule refuses the client value; the On Success script still sets the field; profile permissions bind both', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-field-rule-workflow-'));
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
    for (const [token, user] of Object.entries(USERS)) sdk.setSession(token, user);
    const entry = require(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const submit = async (who: string, record: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api/forms/Ticket/success`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `c2c-harness-session=${who}` },
        body: JSON.stringify({ record }),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
    };
    const row = (title: string) => (sdk.state().tables.Ticket ?? []).find((r) => r.Title === title);

    // Client input for the hidden field: refused before anything is written.
    const client = await submit('lead', { Title: 'client-sets', Status: 'Closed' });
    assert.equal(client.status, 403, JSON.stringify(client.body));
    assert.match(String(client.body.message), /Ticket\.Status is hidden by a field rule/);
    assert.equal(row('client-sets'), undefined, 'a refused submit must not write');

    // The form's submission: the On Success assignment is stored.
    const form = await submit('lead', { Title: 'form-sends' });
    assert.equal(form.status, 200, JSON.stringify(form.body));
    assert.equal(form.body.wrote, true);
    assert.equal(form.body.warning, undefined, JSON.stringify(form.body));
    assert.equal(row('form-sends')?.Status, 'Assigned');
    assert.equal((form.body.values as Record<string, unknown>).Status, 'Assigned');

    // Agent has Status read-only: the client value is refused, and the
    // script's write is refused too — the row stays, the reply warns.
    const agentClient = await submit('agent', { Title: 'agent-client', Status: 'Closed' });
    assert.equal(agentClient.status, 403, JSON.stringify(agentClient.body));
    assert.equal(row('agent-client'), undefined);
    const agentForm = await submit('agent', { Title: 'agent-form' });
    assert.equal(agentForm.status, 200, JSON.stringify(agentForm.body));
    assert.equal(agentForm.body.wrote, true);
    assert.ok(agentForm.body.warning, 'the refused script write is a post-commit warning');
    assert.ok(row('agent-form'), 'the committed row stays');
    assert.notEqual(row('agent-form')?.Status, 'Assigned', 'profile read-only binds the script write');
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    moduleAny._resolveFilename = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the On Success write-back is generated only for a script that assigns input fields', () => {
  const app = deriveIr(parse(DS));
  const files = generate(app).files;
  const success = files.find((file) => file.path === 'functions/aio/ticket/on-success.mjs');
  assert.ok(success);
  assert.match(success.source, /if \(committed\) await saveSuccessSets\(ctx, formName, committed\);/);
  assert.match(success.source, /const successSkip = new Set\(\["ROWID",/);
  // MUST-FAIL guard: a success script with no input assignment gets no write-back.
  const quiet = deriveIr(parse(DS.replace('input.Status = "Assigned";', 'x = 1;')));
  const plain = generate(quiet).files.find((file) => file.path === 'functions/aio/ticket/on-success.mjs');
  assert.ok(plain);
  assert.doesNotMatch(plain.source, /saveSuccessSets/);
});

test('the migration report says fields hidden or disabled in forms are enforced on the server', () => {
  const report = (ds: string) =>
    JSON.parse(generate(deriveIr(parse(ds))).files.find((file) => file.path === 'migration-report.json')!.source) as { security: { notes: string[] } };
  const with_ = report(DS).security.notes;
  assert.ok(with_.some((line) => line.startsWith('Fields hidden or disabled in forms are enforced on the server: 1 field is')), JSON.stringify(with_));
  const without = report(DS.replace('hide Status;', 'show Status;')).security.notes;
  assert.equal(without.some((line) => line.startsWith('Fields hidden or disabled in forms')), false);
});
