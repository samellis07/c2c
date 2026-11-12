/**
 * Golden: approvals and blueprints are a real state machine on the Data Store.
 * A record's Status column moves through the machine, the configured approver
 * is enforced, and every transition lands in C2C_Flow_History. The run goes
 * through the generated c2c_api entry and fake zcatalyst-sdk-node — the same
 * path a deployed Catalyst request takes, in memory only.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { generateSchema } from '../../schema/src/generator.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';

const FIXTURE_ORG = '10000000000';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'in' };

const root = repoRoot();
const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');

const DS = `application "FlowState"
{
	time zone = "Asia/Kolkata"
	share_settings
	{
		"Administrator"
		{
			name = "Administrator"
			type = Users_Permissions
			description = "This profile will have all the permissions."
		}
		"User"
		{
			name = "User"
			type = Users_Permissions
			description = "Requesters and approvers"
			ModulePermissions
			{
				Request
				{
					enabled = viewall
					FieldPermissions
					{
						Title{visibility:true,readonly:false}
						Approver_1{visibility:true,readonly:false}
						Approver_2{visibility:true,readonly:false}
					}
				}
				Order
				{
					enabled = viewall
				}
			}
		}
	}
	forms
	{
		form Request
		{
			Title
			(
				type = text
			)
			Approver_1
			(
				type = picklist
				module = users
				displayformat = [username]
			)
			Approver_2
			(
				type = picklist
				module = users
				displayformat = [username]
			)
		}
		form Order
		{
			Title
			(
				type = text
			)
		}
	}
	workflow
	{
		approval
		{
			Request_Approval as "Request Approval"
			{
				type = approval
				form = Request[Approver_1 is not null && Approver_2 is not null]
				on start
				{
				}
				on level 1
				{
					approvers
					(
						field = Approver_1
					)
					on approve
					{
						actions
						{
							note1 = "lead approved";
						}
					}
					on reject
					{
						actions
						{
							note1 = "lead rejected";
						}
					}
				}
				on level 2
				{
					approvers
					(
						field = Approver_2
					)
					on approve
					{
						actions
						{
							note2 = "manager approved";
						}
					}
					on reject
					{
						actions
						{
							note2 = "manager rejected";
						}
					}
				}
			}
		}
	}
	workflow
	{
		blueprint
		{
			Order_Flow as "Order Flow"
			{
				type = Blueprint
				form = Order
				start
				{
					start stage = "Draft"
				}
				stages
				{
					"Draft"
					{
					}
					"Review"
					{
					}
					"Done"
					{
					}
				}
				transitions
				{
					Send as "Send"
					{
						type = normal
						from stage = "Draft"
						to stage = "Review"
					}
					Finish as "Finish"
					{
						type = normal
						from stage = "Review"
						to stage = "Done"
					}
				}
			}
		}
	}
}
`;

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[][] };
}

let dir = '';
let server: Server | undefined;
let port = 0;
let sdk: FakeSdk;
let restoreResolve: (() => void) | undefined;

async function post(path: string, body: unknown, session?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(session ? { cookie: `c2c-harness-session=${session}` } : {}) },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function tableRows(name: string): Record<string, unknown>[] {
  return sdk.state().tables[name] ?? [];
}

function historyRows(): Record<string, unknown>[] {
  return tableRows('C2C_Flow_History');
}

before(async () => {
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  restoreResolve = () => {
    moduleAny._resolveFilename = original;
  };
  const app = deriveIr(parse(DS));
  const guard: GuardOk = {
    org: FIXTURE_ORG,
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry: FIXTURE_REGISTRY,
  };
  dir = mkdtempSync(join(tmpdir(), 'c2c-approval-live-'));
  writeDeployTree(dir, deployFiles(app, guard, false, { mode: 'live' }).files);
  const req = createRequire(import.meta.url);
  sdk = req(fake) as FakeSdk;
  sdk.setSession('admin', { user_id: '1', email_id: 'admin@example.test', role_details: { role_name: 'App Administrator' } });
  sdk.setSession('lead', { user_id: '1001', email_id: 'lead@example.test', role_details: { role_name: 'App User' } });
  sdk.setSession('manager', { user_id: '1002', email_id: 'manager@example.test', role_details: { role_name: 'App User' } });
  sdk.setSession('eve', { user_id: '1003', email_id: 'eve@example.test', role_details: { role_name: 'App User' } });
  const entry = req(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
  server = createServer((rq, rs) => void entry(rq, rs));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  port = (server!.address() as { port: number }).port;
});

after(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  restoreResolve?.();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('submit stamps the record Pending and records the submit history row', async () => {
  const res = await post('/forms/Request/submit', { record: { Title: 'one', Approver_1: 'lead@example.test', Approver_2: 'manager@example.test' } }, 'admin');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = tableRows('Request');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.Status, 'Pending');
  const history = historyRows().filter((row) => row.Form === 'Request');
  assert.equal(history.length, 1);
  assert.equal(history[0]!.Action, 'submit');
  assert.equal(history[0]!.To_Status, 'Pending');
  assert.equal(history[0]!.Machine, 'Request_Approval');
});

test('level 1 approver advances to Pending level 2; the level 2 approver is refused first', async () => {
  const row = tableRows('Request')[0]!;
  const rowid = String(row.ROWID);
  const early = await post('/flows/Request_Approval', { action: 'approve', rowid }, 'manager');
  assert.equal(early.status, 403);
  const first = await post('/flows/Request_Approval', { action: 'approve', rowid }, 'lead');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // No live reply carries the runtime transcript (record values).
  assert.equal(Object.hasOwn(first.body, 'transcript'), false, JSON.stringify(first.body));
  assert.equal(tableRows('Request')[0]!.Status, 'Pending level 2');
  const second = await post('/flows/Request_Approval', { action: 'approve', rowid }, 'manager');
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(tableRows('Request')[0]!.Status, 'Approved');
  const history = historyRows().filter((item) => item.Form === 'Request');
  assert.deepEqual(
    history.map((item) => [item.Action, item.From_Status ?? '', item.To_Status]),
    [
      ['submit', '', 'Pending'],
      ['approve', 'Pending', 'Pending level 2'],
      ['approve', 'Pending level 2', 'Approved'],
    ],
  );
  assert.deepEqual(history.map((item) => item.Actor), ['admin@example.test', 'lead@example.test', 'manager@example.test']);
});

test('a caller who is not the stage approver is refused and nothing is written', async () => {
  const submitted = await post('/forms/Request/submit', { record: { Title: 'two', Approver_1: 'lead@example.test', Approver_2: 'manager@example.test' } }, 'admin');
  assert.equal(submitted.status, 200);
  const rows = tableRows('Request');
  const rowid = String(rows[1]!.ROWID);
  const denied = await post('/flows/Request_Approval', { action: 'approve', rowid }, 'eve');
  assert.equal(denied.status, 403);
  assert.equal(tableRows('Request')[1]!.Status, 'Pending');
  const history = historyRows().filter((item) => item.Form === 'Request' && item.Action === 'approve' && item.Record_ID === rowid);
  assert.equal(history.length, 0);
});

test('reject persists Rejected and the record cannot transition again', async () => {
  const rows = tableRows('Request');
  const rowid = String(rows[1]!.ROWID);
  const rejected = await post('/flows/Request_Approval', { action: 'reject', rowid }, 'lead');
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(tableRows('Request')[1]!.Status, 'Rejected');
  const again = await post('/flows/Request_Approval', { action: 'approve', rowid }, 'manager');
  assert.equal(again.status, 403);
  const history = historyRows().filter((item) => item.Form === 'Request' && item.Record_ID === rowid);
  assert.deepEqual(
    history.map((item) => [item.Action, item.To_Status]),
    [
      ['submit', 'Pending'],
      ['reject', 'Rejected'],
    ],
  );
});

test('a decision comment is stored on the history row, capped at the column length', async () => {
  const submitted = await post('/forms/Request/submit', { record: { Title: 'three', Approver_1: 'lead@example.test', Approver_2: 'manager@example.test' } }, 'admin');
  assert.equal(submitted.status, 200);
  const rows = tableRows('Request');
  const rowid = String(rows[rows.length - 1]!.ROWID);
  const res = await post('/flows/Request_Approval', { action: 'approve', rowid, comment: '  shipped on time  ' }, 'lead');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const history = historyRows().filter((item) => item.Form === 'Request' && item.Record_ID === rowid && item.Action === 'approve');
  assert.equal(history.length, 1);
  assert.equal(history[0]!.Comment, 'shipped on time');
  assert.equal(history[0]!.Name, 'level 1');

  // A comment past the column length is truncated, and a non-string is dropped.
  const count = rows.length;
  const second = await post('/forms/Request/submit', { record: { Title: 'four', Approver_1: 'lead@example.test', Approver_2: 'manager@example.test' } }, 'admin');
  assert.equal(second.status, 200);
  const rowid2 = String(tableRows('Request')[count]!.ROWID);
  const long = await post('/flows/Request_Approval', { action: 'approve', rowid: rowid2, comment: `x${'y'.repeat(300)}` }, 'lead');
  assert.equal(long.status, 200, JSON.stringify(long.body));
  const capped = historyRows().find((item) => item.Record_ID === rowid2 && item.Action === 'approve');
  assert.equal(String(capped!.Comment).length, 255);
});

test('every key a history row carries is a column the generated schema declares', async () => {
  const schema = generateSchema(deriveIr(parse(DS)));
  const table = schema.tables.find((item) => item.name === 'C2C_Flow_History');
  assert.ok(table, 'the app declares a flow history table');
  const declared = new Set(table.columns.map((column) => column.name));
  assert.ok(declared.has('Name'), 'the schema declares the transition Name column');
  assert.ok(declared.has('Comment'), 'the schema declares the Comment column');
  const rows = historyRows();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key === 'ROWID' || key === 'CREATEDTIME' || key === 'MODIFIEDTIME' || key === 'CREATORID') continue;
      assert.ok(declared.has(key), `history row key ${key} is not a declared C2C_Flow_History column`);
    }
  }
});

test('a blueprint transition writes Status and history, and skips no stage', async () => {
  const submitted = await post('/forms/Order/submit', { record: { Title: 'o1' } }, 'admin');
  assert.equal(submitted.status, 200);
  const row = tableRows('Order')[0]!;
  assert.equal(row.Status, 'Draft');
  const rowid = String(row.ROWID);
  const skipped = await post('/flows/Order_Flow', { action: 'transition', status: 'Done', rowid }, 'lead');
  assert.equal(skipped.status, 403);
  assert.equal(tableRows('Order')[0]!.Status, 'Draft');
  const sent = await post('/flows/Order_Flow', { action: 'transition', status: 'Review', rowid }, 'lead');
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(Object.hasOwn(sent.body, 'transcript'), false, 'a live blueprint reply never carries the runtime transcript');
  assert.equal(tableRows('Order')[0]!.Status, 'Review');
  const history = historyRows().filter((item) => item.Machine === 'Order_Flow');
  assert.deepEqual(
    history.map((item) => [item.Action, item.From_Status ?? '', item.To_Status]),
    [
      ['transition', 'Draft', 'Review'],
    ],
  );
});
