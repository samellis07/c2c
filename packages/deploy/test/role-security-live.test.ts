/**
 * Field and record security is enforced by the generated c2c_api, per signed-in
 * app user. Each caller is a Catalyst Authentication user whose Catalyst role
 * maps to a Creator profile through principal-map.json; the request goes
 * through the deployed index.js router, so nothing in the request body or
 * headers can pick the profile.
 *
 * The export declares, per profile:
 * - Lead: View All and Modify All on Ticket (every row, edit and delete any).
 * - Agent: View All without Modify All on Ticket (read every row, edit only
 *   own), Priority read-only.
 * - Requester: Create, View, Edit and Delete without View All on Ticket, a
 *   form shared through the role hierarchy (own rows only); Create only on
 *   Feedback (add, never read).
 * - Customer (portal): Create, View and Edit without View All (own rows
 *   only), Internal_Notes hidden.
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
import type { ProjectRegistry } from '../src/registry.js';

const FIXTURE_ORG = '10000000000';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'in' };

const root = repoRoot();
const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');

const t = (n: number) => '\t'.repeat(n);

function field(name: string, type = 'text'): string {
  return `${t(3)}${name}\n${t(3)}(\n${t(4)}type = ${type}\n${t(3)})`;
}

function fieldFlags(flags: Record<string, string>): string {
  return `${t(6)}FieldPermissions\n${t(6)}{\n${Object.entries(flags)
    .map(([name, value]) => `${t(7)}${name}\n${t(7)}{\n${t(8)}${value}\n${t(7)}}`)
    .join('\n')}\n${t(6)}}`;
}

function mod(form: string, enabled: string, reports: Record<string, string>, flags?: Record<string, string>): string {
  const lines = [`${t(5)}${form}`, `${t(5)}{`];
  if (enabled) lines.push(`${t(6)}enabled= ${enabled} `);
  lines.push(`${t(6)}allFieldsVisible= ${flags ? 'false' : 'true'} `);
  if (Object.keys(reports).length) {
    lines.push(`${t(6)}ReportPermissions`, `${t(6)}{`);
    for (const [report, verbs] of Object.entries(reports)) lines.push(`${t(7)}${report}={${verbs}}`);
    lines.push(`${t(6)}}`);
  }
  if (flags) lines.push(fieldFlags(flags));
  lines.push(`${t(5)}}`);
  return lines.join('\n');
}

function profile(name: string, type: string, modules: string[]): string {
  return [
    `${t(2)}"${name}"`,
    `${t(2)}{`,
    `${t(3)}name = "${name}"`,
    `${t(3)}type = ${type}`,
    `${t(3)}permissions = {Chat:false, Predefined:false, ApiAccess:true, PIIAccess:true, ePHIAccess:true}`,
    `${t(3)}ModulePermissions`,
    `${t(3)}{`,
    ...modules,
    `${t(3)}}`,
    `${t(2)}}`,
  ].join('\n');
}

const ALL = { Title: 'visibility:true,readonly:false', Priority: 'visibility:true,readonly:false', Internal_Notes: 'visibility:true,readonly:false' };

const DS = `application "Helpdesk"
{
${t(1)}time zone = "Asia/Kolkata"
${t(1)}forms
${t(1)}{
${t(2)}form Ticket
${t(2)}{
${field('Title')}
${field('Priority')}
${field('Internal_Notes')}
${t(2)}}
${t(2)}form Feedback
${t(2)}{
${field('Comment')}
${t(2)}}
${t(1)}}
${t(1)}reports
${t(1)}{
${t(2)}list All_Tickets
${t(2)}{
${t(3)}show all rows from Ticket
${t(3)}(
${t(4)}Title
${t(4)}Priority
${t(4)}Internal_Notes
${t(3)})
${t(2)}}
${t(2)}list All_Feedback
${t(2)}{
${t(3)}show all rows from Feedback
${t(3)}(
${t(4)}Comment
${t(3)})
${t(2)}}
${t(1)}}
${t(1)}share_settings
${t(1)}{
${profile('Lead', 'Users_Permissions', [
  mod('Ticket', 'Create,Viewall,Modifyall,Tab', { All_Tickets: '"View","Edit","Delete"' }),
  mod('Feedback', 'Viewall,Tab', { All_Feedback: '"View"' }),
])}
${profile('Agent', 'Users_Permissions', [
  mod('Ticket', 'Create,Viewall,Tab', { All_Tickets: '"View","Edit","Delete"' }, { ...ALL, Priority: 'visibility:true,readonly:true' }),
])}
${profile('Requester', 'Users_Permissions', [
  mod('Ticket', 'Create,Tab', { All_Tickets: '"View","Edit","Delete"' }),
  mod('Feedback', 'Create,Tab', {}),
])}
${profile('Customer', 'Customer_Portal', [
  mod('Ticket', 'Create,Tab', { All_Tickets: '"View","Edit"' }, { ...ALL, Internal_Notes: 'visibility:false,readonly:false' }),
])}
${t(2)}roles
${t(2)}{
${t(3)}"CEO"
${t(3)}{
${t(4)}description = "Top"
${t(3)}}
${t(2)}}
${t(2)}role Hierarchy = {Ticket}
${t(1)}}
}
`;

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Record<string, unknown>[]> };
  initialize(req: unknown): { datastore(): { table(name: string): { insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> } } };
}

/** One signed-in app user per Catalyst role; the role picks the profile. */
const USERS: Record<string, { user_id: string; email_id: string; role_details: { role_name: string } }> = {
  lead: { user_id: '11', email_id: 'lead@example.test', role_details: { role_name: 'Lead' } },
  agent: { user_id: '12', email_id: 'agent@example.test', role_details: { role_name: 'Agent' } },
  req1: { user_id: '13', email_id: 'req1@example.test', role_details: { role_name: 'Requester' } },
  req2: { user_id: '14', email_id: 'req2@example.test', role_details: { role_name: 'Requester' } },
  cust: { user_id: '15', email_id: 'cust@example.test', role_details: { role_name: 'Customer' } },
  stray: { user_id: '16', email_id: 'stray@example.test', role_details: { role_name: 'Unmapped Role' } },
};

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

test('every role is enforced server-side: owner sharing, hidden and read-only fields, add-only and edit grants', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-role-security-'));
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
    const call = async (who: string | null, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(who ? { cookie: `c2c-harness-session=${who}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
    };
    const tickets = () => sdk.state().tables.Ticket ?? [];
    const report = async (who: string) => {
      const res = await call(who, '/reports/All_Tickets', { op: 'query' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.rows as Record<string, unknown>[];
    };
    const titles = (rows: Record<string, unknown>[]) => rows.map((row) => row.Title).sort();

    // Rows owned by different users, as the server stamps them.
    const seeded = await sdk.initialize({}).datastore().table('Ticket').insertRows([
      { Title: 'r1-own', Priority: 'low', Internal_Notes: 'n1', Added_User: 'req1@example.test' },
      { Title: 'r2-own', Priority: 'high', Internal_Notes: 'n2', Added_User: 'req2@example.test' },
      { Title: 'cust-own', Priority: 'low', Internal_Notes: 'secret', Added_User: 'cust@example.test' },
    ]);
    const [r1Id, r2Id, custId] = seeded.map((row) => String(row.ROWID));

    // No session, or a role with no profile in principal-map.json: 401 before any handler.
    assert.equal((await call(null, '/reports/All_Tickets', { op: 'query' })).status, 401);
    assert.equal((await call('stray', '/reports/All_Tickets', { op: 'query' })).status, 401);
    // A client-supplied profile is not a principal.
    assert.equal((await call(null, '/reports/All_Tickets', { op: 'query', user: { profile: 'Lead' } })).status, 401);

    // Record sharing on reads.
    assert.deepEqual(titles(await report('lead')), ['cust-own', 'r1-own', 'r2-own']);
    assert.deepEqual(titles(await report('agent')), ['cust-own', 'r1-own', 'r2-own']);
    assert.deepEqual(titles(await report('req1')), ['r1-own'], 'no View All: only the caller\'s own rows');
    assert.deepEqual(titles(await report('req2')), ['r2-own']);
    const custRows = await report('cust');
    assert.deepEqual(titles(custRows), ['cust-own'], 'portal user sees only their own rows');
    // Field-level read: the hidden field never leaves the server.
    for (const row of custRows) assert.equal(Object.hasOwn(row, 'Internal_Notes'), false, 'hidden field leaked in a report');
    const custRecord = await call('cust', '/forms/Ticket/record', { ROWID: custId });
    assert.equal(custRecord.status, 200, JSON.stringify(custRecord.body));
    assert.equal(Object.hasOwn(custRecord.body.record as object, 'Internal_Notes'), false, 'hidden field leaked in a record read');
    assert.equal((await call('req1', '/forms/Ticket/record', { ROWID: r2Id })).status, 404, 'another user\'s row is not found');

    // Field-level write: hidden and read-only fields are refused, not dropped.
    const hiddenWrite = await call('cust', '/forms/Ticket/submit', { record: { Title: 'c2', Internal_Notes: 'x' } });
    assert.equal(hiddenWrite.status, 403, JSON.stringify(hiddenWrite.body));
    const readOnlyWrite = await call('agent', '/forms/Ticket/submit', { record: { Title: 'a1', Priority: 'urgent' } });
    assert.equal(readOnlyWrite.status, 403, JSON.stringify(readOnlyWrite.body));
    assert.equal(readOnlyWrite.body.code, 'FORBIDDEN');
    assert.match(String(readOnlyWrite.body.message), /Ticket\.Priority/);
    assert.equal(Object.hasOwn(readOnlyWrite.body, 'error'), false);

    // Create is its own grant: the portal user adds a row they then own.
    const added = await call('cust', '/forms/Ticket/submit', { record: { Title: 'cust-new' } });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(Object.hasOwn(added.body.values as object, 'Internal_Notes'), false, 'hidden field leaked in a submit reply');
    assert.equal(tickets().find((row) => row.Title === 'cust-new')?.Added_User, 'cust@example.test');
    assert.deepEqual(titles(await report('cust')), ['cust-new', 'cust-own']);

    // Edit: own row only without View All or Modify All.
    const foreignEdit = await call('req1', '/forms/Ticket/submit', { ROWID: r2Id, record: { Title: 'hijack' } });
    assert.equal(foreignEdit.status, 403, JSON.stringify(foreignEdit.body));
    assert.equal(tickets().find((row) => String(row.ROWID) === r2Id)?.Title, 'r2-own', 'a refused edit must not write');
    const ownEdit = await call('req1', '/forms/Ticket/submit', { ROWID: r1Id, record: { Title: 'r1-edited' } });
    assert.equal(ownEdit.status, 200, JSON.stringify(ownEdit.body));
    // View All without Modify All: the agent reads every row but edits only its own.
    const agentEdit = await call('agent', '/forms/Ticket/submit', { ROWID: r2Id, record: { Title: 'agent-edit' } });
    assert.equal(agentEdit.status, 403, JSON.stringify(agentEdit.body));
    // Modify All: the lead edits any row.
    const leadEdit = await call('lead', '/forms/Ticket/submit', { ROWID: r2Id, record: { Title: 'r2-lead' } });
    assert.equal(leadEdit.status, 200, JSON.stringify(leadEdit.body));

    // Delete: own row only without Modify All; the agent's grant has Delete but not Modify All.
    assert.equal((await call('req1', '/forms/Ticket/delete', { ROWID: r2Id })).status, 404);
    assert.equal((await call('agent', '/forms/Ticket/delete', { ROWID: r2Id })).status, 404);
    assert.ok(tickets().some((row) => String(row.ROWID) === r2Id), 'a refused delete must leave the row');
    assert.equal((await call('cust', '/forms/Ticket/delete', { ROWID: custId })).status, 403, 'no Delete grant');
    assert.equal((await call('req1', '/forms/Ticket/delete', { ROWID: r1Id })).status, 200);
    assert.equal((await call('lead', '/forms/Ticket/delete', { ROWID: r2Id })).status, 200);

    // Add-only: Create without View on Feedback adds a row and reads nothing.
    const feedback = await call('req1', '/forms/Feedback/submit', { record: { Comment: 'hello' } });
    assert.equal(feedback.status, 200, JSON.stringify(feedback.body));
    assert.equal((sdk.state().tables.Feedback ?? []).length, 1);
    const feedbackRows = await call('req1', '/reports/All_Feedback', { op: 'query' });
    assert.equal(feedbackRows.status, 403, JSON.stringify(feedbackRows.body));
    const feedbackId = String((sdk.state().tables.Feedback ?? [])[0]?.ROWID);
    assert.equal((await call('req1', '/forms/Feedback/record', { ROWID: feedbackId })).status, 403);
    assert.equal((await call('req1', '/forms/Feedback/submit', { ROWID: feedbackId, record: { Comment: 'edit' } })).status, 403, 'Create does not grant Edit');
    // The Agent profile has no Feedback grant at all.
    assert.equal((await call('agent', '/forms/Feedback/submit', { record: { Comment: 'x' } })).status, 403);
    assert.equal((await call('lead', '/reports/All_Feedback', { op: 'query' })).status, 200);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    moduleAny._resolveFilename = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the migration report states what is enforced and lists every rule that is not', () => {
  const app = deriveIr(parse(DS));
  const files = generate(app).files;
  const report = JSON.parse(files.find((file) => file.path === 'migration-report.json')!.source) as {
    security: { enforced: Record<string, number>; notEnforced: string[]; notes: string[] };
  };
  const { enforced, notEnforced } = report.security;
  assert.equal(enforced.profiles, 4);
  assert.equal(enforced.ownRecordsOnly, 2, 'Requester and Customer on Ticket');
  assert.equal(enforced.modifyOwnOnly, 1, 'Agent on Ticket');
  assert.equal(enforced.addOnly, 1, 'Requester on Feedback');
  assert.equal(enforced.hiddenFields, 1);
  assert.equal(enforced.readOnlyFields, 1);
  for (const line of notEnforced) assert.match(line, /^not enforced/);
  assert.ok(notEnforced.some((line) => /role-hierarchy record sharing up the hierarchy on Ticket/.test(line)));
  assert.ok(notEnforced.some((line) => /not enforced at the Data Store/.test(line) && /Customer\/Ticket/.test(line)));
  assert.ok(notEnforced.some((line) => /module permission flags tab \(Agent, Customer, Lead, Requester\)/.test(line)));
  assert.equal(notEnforced.some((line) => /PIIAccess/.test(line)), false);
  // The first profile (Lead) without personal-data access is listed, not silently ignored.
  const noPii = generate(deriveIr(parse(DS.replace('PIIAccess:true', 'PIIAccess:false')))).files;
  const piiReport = JSON.parse(noPii.find((file) => file.path === 'migration-report.json')!.source) as { security: { notEnforced: string[] } };
  assert.ok(piiReport.security.notEnforced.includes('not enforced: PIIAccess false for profile Lead. Personal-data fields are not hidden by it.'));
});
