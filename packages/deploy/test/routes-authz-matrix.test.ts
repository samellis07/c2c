/**
 * Authorization matrix over every generated route. The kitchen-sink app
 * (fixtures/synthetic/kitchen-sink) and a small companion app for the route
 * families the kitchen sink does not emit (prefetch, flows, published custom
 * functions, report custom actions) are deployed offline, live mode, and served
 * through the real functions/c2c_api/index.js over the fake zcatalyst SDK.
 *
 * Every routes.json key is called three ways: anonymous (401), a role whose
 * profile has no grant (403, no Data Store write, no signed URL), and a
 * granted role (2xx). The table is keyed by route family: a routes.json key
 * that no family matches, or a family no app emits, fails the test. A role
 * with a partial grant (Desk_Staff, Agent) is also refused outside it.
 *
 * The test adds one grantless profile to each app's IR before deploy; the
 * kitchen-sink fixture itself is unchanged.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse, parseFile, type App } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';

const root = repoRoot();
const FAKE_SDK = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
const KITCHEN_SINK = join(root, 'fixtures/synthetic/kitchen-sink/kitchen_sink.ds');
/** A profile with no module grant, added to each app so every route has a role without the grant. */
const NOBODY = 'Route_Matrix_Nobody';
const SHA = 'a'.repeat(64);

/** Prefetch, flows, a published custom function, and a report custom action: the families the kitchen sink does not emit. */
const COMPANION_DS = `application "c2c-route-matrix-companion"
{
	time zone = "Asia/Kolkata"
	forms
	{
		form Ticket
		{
			Title
			(
				type = text
			)
			Status
			(
				type = text
			)
			Attachment
			(
				type = upload file
			)
		}
	}
	reports
	{
		list All_Tickets
		{
			displayName = "All Tickets"
			show all rows from Ticket
			(
				Title as "Title"
				Status as "Status"
			)
			custom actions
			(
				"Close"
				(
				workflow = Close_Ticket
				)
			)
		}
	}
	functions
	{
		Deluge
		{
			int Helpers.twice(int n)
			{
				return n * 2;
			}
			void Close_Ticket(int id)
			{
				info id;
			}
		}
	}
	api Get_Twice
	{
		method = POST
		scope = "Admin only"
		actions
		(
			c2c-route-matrix-companion.Helpers.twice(4)
		)
	}
	workflow
	{
		form
		{
			Ticket_Open as "Ticket open"
			{
				type = form
				form = Ticket
				record event = on add
				on load
				{
					actions
					{
						custom deluge script
						(
							if (Ticket[Status == "Open"].count() > 0) { alert "open"; }
						)
					}
				}
			}
		}
		approval
		{
			Ticket_Approval as "Ticket Approval"
			{
				type = approval
				form = Ticket
				on level 1
				{
					approvers
					(
						profile = "Administrator"
					)
					on approve
					{
						actions
						{
							on load
							(
								input.Title = "approved";
							)
						}
					}
					on reject
					{
						actions
						{
							on load
							(
								input.Title = "rejected";
							)
						}
					}
				}
			}
		}
	}
	share_settings
	{
		"Administrator"
		{
			name = "Administrator"
			type = Users_Permissions
			description = "Admin"
		}
		"Agent"
		{
			name = "Agent"
			type = Users_Permissions
			ModulePermissions
			{
				Ticket
				{
					enabled = true
					ReportPermissions
					{
						All_Tickets = {"View"}
					}
				}
			}
		}
	}
}
`;

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  /**
   * What the granted caller gets when it is not 2xx: a business refusal that
   * runs only after authorization passed (its message is not an access error).
   */
  granted?: { status: number; error: RegExp };
}

/** Seeded rows: `keep` is read, signed, and transitioned; `victim` is the row the granted delete removes. */
interface Rows {
  keep: string;
  victim: string;
}

interface Family {
  name: string;
  pattern: RegExp;
  /** Concrete calls for one routes.json key. `m` is the pattern match, `rows(form)` the seeded ROWIDs. */
  calls(m: RegExpExecArray, rows: (form: string) => Rows): Call[];
  /** Restore the seeded rows before the granted call (the call itself changes them). */
  reset?: boolean;
}

const form = (m: RegExpExecArray) => decodeURIComponent(m[1] as string);

/**
 * One row per generated route family. Parameterised routes are instantiated on
 * a form and field the app declares (APP_PARAMS); the rest take their form
 * from the path.
 */
const FAMILIES: Family[] = [
  {
    name: 'crud-submit',
    pattern: /^POST \/forms\/([^/]+)\/submit$/,
    // An On Edit submit names the row it edits; a create ignores ROWID.
    calls: (m, rows) => [{ method: 'POST', path: m.input.slice(5), body: { record: submitRecord(form(m)), ROWID: rows(form(m)).keep } }],
  },
  {
    name: 'crud-record',
    pattern: /^POST \/forms\/([^/]+)\/record$/,
    calls: (m, rows) => [{ method: 'POST', path: m.input.slice(5), body: { ROWID: rows(form(m)).keep } }],
  },
  {
    name: 'crud-delete',
    pattern: /^POST \/forms\/([^/]+)\/delete$/,
    calls: (m, rows) => [{ method: 'POST', path: m.input.slice(5), body: { ROWID: rows(form(m)).victim } }],
  },
  {
    name: 'event-handler',
    pattern: /^POST \/forms\/([^/]+)\/(addrow|click|delete-script|deleterow|input|load|success|validate)$/,
    calls: (m, rows) => [{ method: 'POST', path: m.input.slice(5), body: { record: submitRecord(form(m)), ROWID: rows(form(m)).keep } }],
  },
  {
    name: 'prefetch',
    pattern: /^POST \/forms\/([^/]+)\/[a-z-]+\/prefetch$/,
    calls: (m) => [{ method: 'POST', path: m.input.slice(5), body: { record: {}, nonce: 'n1' } }],
  },
  {
    name: 'report-query',
    pattern: /^POST \/reports\/([^/]+)$/,
    calls: (m) => [{ method: 'POST', path: m.input.slice(5), body: { op: 'query' } }],
  },
  {
    name: 'report-custom-action',
    pattern: /^POST \/reports\/([^/]+)\/actions\/[^/]+$/,
    calls: (m) => [{ method: 'POST', path: m.input.slice(5), body: { rows: [] } }],
  },
  {
    name: 'lookup',
    pattern: /^GET \/lookups\/:form\/:field$/,
    calls: () => [{ method: 'GET', path: '/lookups/@form/@text' }],
  },
  {
    name: 'stratus-upload',
    pattern: /^POST \/uploads\/:form\/:field$/,
    calls: () => [{ method: 'POST', path: '/uploads/@form/@file', body: { filename: 'cover.png', sha256: SHA, contentType: 'image/png' } }],
  },
  {
    name: 'stratus-download',
    pattern: /^POST \/files\/:form\/:field$/,
    calls: () => [{ method: 'POST', path: '/files/@form/@file', body: { rowId: '@keep' } }],
  },
  {
    name: 'transition',
    pattern: /^POST \/flows\/([^/]+)(\/(approve|reject|transition))?$/,
    // The bare /flows/<name> path dispatches on body.action; the suffixed aliases on the leaf.
    // An approval machine has only approve and reject rows, so /transition (a
    // blueprint verb) refuses the granted caller on the stage, after the gate.
    calls: (m) => [
      {
        method: 'POST',
        path: m.input.slice(5),
        body: { ROWID: '@keep', action: m[3] ?? 'approve', status: m[3] === 'reject' ? 'Rejected' : 'Approved' },
        ...(m[3] === 'transition' ? { granted: { status: 403, error: /^status is not a transition of this stage$/ } } : {}),
      },
    ],
    // Each granted call moves the row out of its start stage; put it back first.
    reset: true,
  },
  {
    name: 'custom-function',
    pattern: /^POST \/functions\/([^/]+)$/,
    calls: (m) => [{ method: 'POST', path: m.input.slice(5), body: { args: [4] } }],
  },
  {
    name: 'admin-smoke',
    pattern: /^POST \/admin\/smoke$/,
    calls: () => [{ method: 'POST', path: '/admin/smoke', body: { op: 'status' } }],
  },
];

/** Minimal valid records: the kitchen sink's validations accept these. */
function submitRecord(name: string): Record<string, unknown> {
  return SUBMIT_RECORDS[name] ?? {};
}
const SUBMIT_RECORDS: Record<string, Record<string, unknown>> = {
  Gear: { Gear_Label: 'Tripod' },
  Guest: { Guest_Name: 'Ada' },
  Media_Kit: { Kit_Name: 'Press kit' },
  Room: { Room_Code: 'R1' },
  Ticket: { Title: 'Broken lamp' },
};

interface AppCase {
  label: string;
  app: App;
  /** The form and fields the parameterised routes are instantiated on. */
  params: { form: string; text: string; file: string };
  /** Seed rows per table, keyed by form. */
  seed: Record<string, Record<string, unknown>>;
}

function withNobody(app: App): App {
  const span = { start: 0, end: 0 };
  return { ...app, profiles: [...app.profiles, { name: NOBODY, type: 'Users_Permissions', properties: [], modules: [], span }] } as App;
}

function guardFor(app: App): GuardOk {
  const org = '10000000000';
  return {
    org,
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry: { org, env: 'Development', projects: {}, dc: 'in' },
  };
}

interface FakeSdk {
  initialize(req: unknown, opts?: Record<string, unknown>): {
    datastore(): {
      table(name: string): {
        insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
        updateRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
      };
    };
  };
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[][] };
}

const WRITES = new Set(['insertRows', 'updateRows', 'deleteRows']);

/** Serves one app's deploy tree; returns the call helper and the side-effect probes. */
async function serve(c: AppCase, sdk: FakeSdk, out: string) {
  writeDeployTree(out, deployFiles(withNobody(c.app), guardFor(c.app), false, { mode: 'live' }).files);
  const base = join(out, 'functions/c2c_api');
  const routes = JSON.parse(readFileSync(join(base, 'routes.json'), 'utf8')) as Record<string, string>;
  const signed: string[] = [];
  const files = (await import(pathToFileURL(join(base, 'c2c-files.mjs')).href)) as { setFileStore(store: unknown): unknown };
  files.setFileStore({
    async signedUrl(key: string, action: string) {
      signed.push(`${action} ${key}`);
      return `https://stratus.example.test/${key}?${action}`;
    },
  });
  const shims = (await import(pathToFileURL(join(base, 'vendor/shims/index.js')).href)) as {
    uploadObjectKey(form: string, field: string, sha: string, name: string): string;
  };
  const ids: Record<string, Rows> = {};
  const tables = sdk.initialize({}).datastore();
  const seedRow = (name: string) => {
    const values = c.seed[name] ?? {};
    return name === c.params.form ? { ...values, [c.params.file]: shims.uploadObjectKey(name, c.params.file, SHA, 'seed.png') } : { ...values };
  };
  for (const name of Object.keys(c.seed)) {
    const inserted = await tables.table(name).insertRows([seedRow(name), seedRow(name)]);
    ids[name] = { keep: String(inserted[0]?.ROWID), victim: String(inserted[1]?.ROWID) };
  }
  const reseed = async () => {
    for (const name of Object.keys(c.seed)) await tables.table(name).updateRows([{ ...seedRow(name), ROWID: ids[name]!.keep }]);
  };
  const require = createRequire(import.meta.url);
  const entry = require(join(base, 'index.js')) as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const server = createServer((rq, rs) => void entry(rq, rs));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const resolve = (value: string) =>
    value
      .replace('@form', c.params.form)
      .replace('@text', c.params.text)
      .replace('@file', c.params.file)
      .replace('@keep', ids[c.params.form]?.keep ?? '')
      .replace('@booking', ids.Booking?.keep ?? '')
      .replace('@room', ids.Room?.keep ?? '');
  const send = async (call: Call, session?: string) => {
    const body = call.body ? JSON.parse(resolve(JSON.stringify(call.body))) : undefined;
    const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api${resolve(call.path)}`, {
      method: call.method,
      headers: { 'content-type': 'application/json', ...(session ? { cookie: `c2c-harness-session=${session}` } : {}) },
      ...(call.method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = await res.text();
    return { status: res.status, text };
  };
  const effects = () => ({
    tables: JSON.stringify(sdk.state().tables),
    writes: sdk.state().calls.filter((call) => WRITES.has(String(call[0]))).length,
    signed: signed.length,
  });
  const rows = (name: string): Rows => ids[name] ?? { keep: '1', victim: '2' };
  const close = () => new Promise<void>((done) => server.close(() => done()));
  return { routes, send, effects, rows, reseed, close };
}

function familyOf(key: string): { family: Family; match: RegExpExecArray }[] {
  return FAMILIES.flatMap((family) => {
    const match = family.pattern.exec(key);
    return match ? [{ family, match }] : [];
  });
}


/** Anonymous, grantless, and granted calls for every route of one app. */
async function matrix(c: AppCase, granted: string, seen: Set<string>, partial?: Partial) {
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'c2c-authz-matrix-')));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return FAKE_SDK;
    return original.call(this, request, ...rest);
  };
  const sdk = createRequire(import.meta.url)(FAKE_SDK) as FakeSdk;
  sdk.setSession(`${c.label}-admin`, { user_id: '1', email_id: 'admin@example.test', role_details: { role_name: granted } });
  sdk.setSession(`${c.label}-nobody`, { user_id: '2', email_id: 'nobody@example.test', role_details: { role_name: NOBODY } });
  if (partial) sdk.setSession(`${c.label}-${partial.role}`, { user_id: '3', email_id: 'staff@example.test', role_details: { role_name: partial.role } });
  const h = await serve(c, sdk, out);
  const failures: string[] = [];
  try {
    const keys = Object.keys(h.routes);
    assert.ok(keys.length > 0, `${c.label}: routes.json is empty`);
    for (const key of keys) {
      const matched = familyOf(key);
      assert.equal(matched.length, 1, `${c.label}: ${key} must match exactly one route family, matched ${matched.map((m) => m.family.name).join(', ') || 'none'}`);
      const { family, match } = matched[0]!;
      seen.add(family.name);
      for (const call of family.calls(match, h.rows)) {
        const label = `${c.label} ${family.name} ${key}`;
        const anon = await h.send(call);
        if (anon.status !== 401) failures.push(`${label}: anonymous got ${anon.status} ${anon.text}`);
        const before = h.effects();
        const denied = await h.send(call, `${c.label}-nobody`);
        if (denied.status !== 403) failures.push(`${label}: grantless role got ${denied.status} ${denied.text}`);
        const after = h.effects();
        if (JSON.stringify(after) !== JSON.stringify(before)) failures.push(`${label}: a refused call changed rows or signed a URL`);
        if (family.reset) await h.reseed();
        const ok = await h.send(call, `${c.label}-admin`);
        if (call.granted) {
          const error = String((JSON.parse(ok.text) as { error?: unknown }).error ?? '');
          if (ok.status !== call.granted.status || !call.granted.error.test(error)) failures.push(`${label}: granted role got ${ok.status} ${ok.text}`);
        } else if (ok.status < 200 || ok.status >= 300) failures.push(`${label}: granted role got ${ok.status} ${ok.text}`);
      }
    }
    assert.deepEqual(failures, [], `${c.label}: authorization matrix failures`);
    if (partial) await partialGrants(h, c.label, partial);
  } finally {
    await h.close();
    moduleAny._resolveFilename = original;
    rmSync(out, { recursive: true, force: true });
  }
}

const seen = new Set<string>();

/** A role whose profile grants something, called on routes outside that grant (403, no effect) and inside it (2xx). */
interface Partial {
  role: string;
  denied: Call[];
  granted: Call[];
}

async function partialGrants(h: Awaited<ReturnType<typeof serve>>, label: string, p: Partial): Promise<void> {
  const failures: string[] = [];
  for (const call of p.denied) {
    const before = h.effects();
    const res = await h.send(call, `${label}-${p.role}`);
    if (res.status !== 403) failures.push(`${p.role} ${call.method} ${call.path}: got ${res.status} ${res.text}`);
    if (JSON.stringify(h.effects()) !== JSON.stringify(before)) failures.push(`${p.role} ${call.method} ${call.path}: a refused call changed rows or signed a URL`);
  }
  for (const call of p.granted) {
    const res = await h.send(call, `${label}-${p.role}`);
    if (res.status < 200 || res.status >= 300) failures.push(`${p.role} ${call.method} ${call.path}: granted got ${res.status} ${res.text}`);
  }
  assert.deepEqual(failures, [], `${label}: partial-grant failures`);
}

test('kitchen sink: every generated route refuses anonymous and grantless callers and serves a granted one', async () => {
  const app = parseFile(KITCHEN_SINK).ir;
  const seed: Record<string, Record<string, unknown>> = {};
  for (const f of app.forms) seed[f.name] = {};
  // Desk_Staff may write Booking (no delete) and read its two reports, nothing else.
  await matrix({ label: 'kitchen-sink', app, params: { form: 'Media_Kit', text: 'Kit_Name', file: 'Cover' }, seed }, 'App Administrator', seen, {
    role: 'Desk_Staff',
    denied: [
      { method: 'POST', path: '/forms/Booking/delete', body: { ROWID: '@booking' } },
      { method: 'POST', path: '/forms/Room/submit', body: { record: { Room_Code: 'R9' } } },
      { method: 'POST', path: '/forms/Room/record', body: { ROWID: '@room' } },
      { method: 'POST', path: '/reports/All_Rooms', body: { op: 'query' } },
      { method: 'GET', path: '/lookups/Room/Room_Code' },
      { method: 'POST', path: '/uploads/Media_Kit/Cover', body: { filename: 'cover.png', sha256: SHA, contentType: 'image/png' } },
      { method: 'POST', path: '/files/Media_Kit/Cover', body: { rowId: '@keep' } },
      { method: 'POST', path: '/admin/smoke', body: { op: 'status' } },
    ],
    granted: [
      { method: 'POST', path: '/forms/Booking/record', body: { ROWID: '@booking' } },
      { method: 'POST', path: '/reports/Held_Bookings', body: { op: 'query' } },
      { method: 'GET', path: '/lookups/Booking/Status' },
    ],
  });
});

test('companion app: prefetch, flow, custom-function and report-action routes are gated the same way', async () => {
  const app = deriveIr(parse(COMPANION_DS));
  await matrix(
    { label: 'companion', app, params: { form: 'Ticket', text: 'Title', file: 'Attachment' }, seed: { Ticket: { Title: 't', Status: 'Open', Flow_Status: 'Pending' } } },
    'App Administrator',
    seen,
    {
      // Agent can view Ticket but cannot edit it, approve it, or run admin functions.
      role: 'Agent',
      denied: [
        { method: 'POST', path: '/flows/ticket-approval/approve', body: { ROWID: '@keep', status: 'Approved' } },
        { method: 'POST', path: '/functions/helpers-twice', body: { args: [4] } },
        { method: 'POST', path: '/forms/Ticket/load/prefetch', body: { record: {}, nonce: 'n1' } },
      ],
      granted: [
        { method: 'POST', path: '/reports/All_Tickets', body: { op: 'query' } },
      ],
    },
  );
});

test('every route family has a row and every row is exercised by a generated route', () => {
  assert.deepEqual([...seen].sort(), FAMILIES.map((f) => f.name).sort(), 'route families no app emitted');
});
