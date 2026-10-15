/**
 * The W4 smoke contract: file upload, an update through the submit endpoint
 * ({ record, ROWID }), read-back of subform rows, lookup displays and file
 * keys, marker-checked cleanup, and the admin smoke endpoint every generated
 * app serves (`POST /admin/smoke`).
 *
 * Same in-process harness as smoke-live.test.ts — the real deploy tree plus
 * the offline zcatalyst fake — with a Stratus file-store stand-in and a log
 * of every HTTP request the run made.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import type { FetchLike } from '../../data/src/migrate.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';
import { smokeCli, type Io } from '../src/cli.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';

const root = repoRoot();
const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
const SECRET = '/tmp/cred-DO-NOT-PRINT';
const CLI_TOKEN = 'test-cli-token';
const TEST_ORG = '10000000000';

const registry: ProjectRegistry = {
  org: TEST_ORG,
  dc: 'in',
  env: 'Development',
  projects: { 'c2c-widget': '1001' },
};

/**
 * These suites drive the enabled (cutover) endpoint: a generated app answers
 * POST /admin/smoke only when C2C_SMOKE_ENABLED=1. The gate test below
 * toggles the flag itself and restores it.
 */
process.env.C2C_SMOKE_ENABLED ??= '1';

/**
 * Two forms: a required lookup parent, a required text (the run marker), a
 * dropdown (the update target: second choice), an optional file field and a
 * required subform, plus a number field the arithmetic check writes and reads back.
 * 'Reader' is a non-admin profile for the endpoint gate.
 */
const L2_DS = `application "Widget"
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
		"Reader"
		{
			name = "Reader"
			type = Users_Permissions
			description = "read permission for all components"
		}
	}
	section S
	{
		form Vendor
		{
			must have Vendor_Name
			(
				type = text
			)
		}
		form Item
		{
			Status
			(
				type = dropdown
				values = {"Open","Closed"}
			)
			Qty
			(
				type = number
			)
			must have Item_Name
			(
				type = text
			)
			must have Vendor
			(
				type = picklist
				values = Vendor.Vendor_Name
			)
			Photo
			(
				type = file
			)
			must have Lines
			(
				type = grid
				must have Note
				(
					type = text
				)
			)
		}
		list Item_Report
		{
			show all rows from Item
		}
	}
}
`;

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  executeZCQLQuery(sql: string): Promise<unknown>;
  state(): { tables: Record<string, Record<string, unknown>[]>; calls: unknown[] };
}

function guardFor(app: ReturnType<typeof deriveIr>): GuardOk {
  return {
    org: TEST_ORG,
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry,
  };
}

function projectsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-projects-'));
  const path = join(dir, 'projects.json');
  writeFileSync(path, JSON.stringify(registry));
  return path;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

interface Harness {
  port: number;
  sdk: FakeSdk;
  /** method, pathname, parsed JSON body for every request the server saw. */
  requests: { method: string; path: string; body: unknown }[];
  close(): Promise<void>;
}

async function harness(ds: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-smoke-contract-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  const requests: Harness['requests'] = [];
  let server: Server | undefined;
  try {
    const app = deriveIr(parse(ds));
    writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const req = createRequire(import.meta.url);
    const sdk = req(fake) as FakeSdk;
    sdk.setSession('admin', { user_id: '1', email_id: 'admin@example.test', role_details: { role_name: 'App Administrator' } });
    sdk.setSession('reader', { user_id: '2', email_id: 'reader@example.test', role_details: { role_name: 'Reader' } });
    const entry = req(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    // Stratus stand-in: the upload/download endpoints sign URLs under
    // /stratus/<action>/<key>; a PUT proves the bytes path.
    const filesMod = (await import(pathToFileURL(join(dir, 'functions/c2c_api/c2c-files.mjs')).href)) as {
      setFileStore(store: unknown): void;
    };
    let port = 0;
    filesMod.setFileStore({
      signedUrl: async (key: string, action: string) => `http://127.0.0.1:${port}/stratus/${String(action).toLowerCase()}/${key}`,
    });
    server = createServer(async (rq, rs) => {
      const url = new URL(rq.url || '/', 'http://127.0.0.1');
      try {
        if (url.pathname === '/') {
          rs.writeHead(200, {
            'content-type': 'text/html',
            'set-cookie': 'c2c-harness-session=admin; Path=/; HttpOnly; SameSite=Lax',
          });
          rs.end('<html></html>');
          return;
        }
        if (url.pathname.startsWith('/stratus/')) {
          const body = await readBody(rq);
          requests.push({ method: String(rq.method), path: url.pathname, body: body ? `[${body.length} bytes]` : '' });
          rs.writeHead(200, { 'content-type': 'application/octet-stream' });
          rs.end('ok');
          return;
        }
        const bodyText = rq.method === 'GET' || rq.method === 'HEAD' ? '' : await readBody(rq);
        let body: unknown = '';
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = bodyText.slice(0, 200);
        }
        requests.push({ method: String(rq.method), path: url.pathname, body });
        // readBody consumed the stream: hand the parsed body to index.js's
        // own readBody, which honours a pre-set req.body.
        (rq as { body?: unknown }).body = bodyText;
        const queryMatch = /^\/baas\/v1\/project\/\d+\/query$/.exec(url.pathname);
        if (queryMatch && rq.method === 'POST') {
          try {
            const data = await sdk.executeZCQLQuery(String((body as { query?: string }).query ?? ''));
            rs.writeHead(200, { 'content-type': 'application/json' });
            rs.end(JSON.stringify({ status: 'success', data }));
          } catch (err) {
            rs.writeHead(400, { 'content-type': 'application/json' });
            rs.end(JSON.stringify({ status: 'failure', error: String((err as Error).message) }));
          }
          return;
        }
        await entry(rq, rs);
      } catch (err) {
        if (!rs.headersSent) {
          rs.writeHead(500, { 'content-type': 'application/json' });
          rs.end(JSON.stringify({ error: String((err as Error).message) }));
        }
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    return {
      port,
      sdk,
      requests,
      async close() {
        server!.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        moduleAny._resolveFilename = original;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    moduleAny._resolveFilename = original;
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function io(port: number, env: NodeJS.ProcessEnv = { X_ZC_CREDENTIAL_PATH: SECRET }): { io: Io; stdout: () => string; stderr: () => string } {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      env,
      cliDc: () => 'in',
      cliOrg: () => TEST_ORG,
      listProjects: async () => [{ name: 'c2c-widget', id: '1001' }],
      spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
      fetch: (async (url: string, init?: RequestInit) => {
        const target = new URL(String(url));
        // The admin REST calls build against api.catalyst.zoho.in; the test
        // fetch maps them onto the loopback harness, like smoke-live.test.ts.
        if (target.hostname === 'api.catalyst.zoho.in') {
          return fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, init);
        }
        return fetch(url, init);
      }) as FetchLike,
      rest: async (call: { method: string; path: string }) => {
        if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+$/.test(call.path)) {
          const projectId = call.path.split('/').at(-1) ?? '';
          return {
            status: 200,
            body: {
              status: 'success',
              data: {
                id: projectId,
                project_name: 'c2c-widget',
                env_details: [{ env_name: 'Development', env_zgid: TEST_ORG, id: TEST_ORG, project_details: { id: projectId, project_name: 'c2c-widget' } }],
              },
            },
          };
        }
        return { status: 404, body: {} };
      },
      accessToken: async () => CLI_TOKEN,
    } as Io,
    stdout: () => out,
    stderr: () => err,
  };
}

function smokeArgs(dir: string, port: number, extra: string[] = []): string[] {
  return [join(dir, 'widget.ds'), '--org', TEST_ORG, '--project', 'c2c-widget', '--dc', 'in', '--projects', projectsFile(), '--url', `http://127.0.0.1:${port}/server/c2c_api`, '--confirm', ...extra];
}

function dsFile(ds: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-ds-'));
  const path = join(dir, 'widget.ds');
  writeFileSync(path, ds);
  return dir;
}

/** The body of the nth recorded request to a path, parsed JSON. */
function calls(requests: Harness['requests'], method: string, path: string): { method: string; path: string; body: unknown }[] {
  return requests.filter((req) => req.method === method && req.path === path);
}

test('POST /admin/smoke answers only when C2C_SMOKE_ENABLED=1', async () => {
  const h = await harness(L2_DS);
  const saved = process.env.C2C_SMOKE_ENABLED;
  try {
    const call = async (body: unknown, cookie?: string) => {
      const res = await fetch(`http://127.0.0.1:${h.port}/server/c2c_api/admin/smoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
      let parsed: unknown = {};
      try {
        parsed = await res.json();
      } catch {
        /* non-JSON */
      }
      return { status: res.status, body: parsed as Record<string, unknown> };
    };
    const marked = (op: string) =>
      op === 'arith'
        ? { op, form: 'Item', rowId: '1', marker: { field: 'Item_Name', tag: 'c2c smoke x' }, field: 'Qty' }
        : op === 'update'
          ? { op, form: 'Item', rowId: '1', marker: { field: 'Item_Name', tag: 'c2c smoke x' }, fields: { Status: 'Closed' } }
          : { op, form: 'Item', rowId: '1', marker: { field: 'Item_Name', tag: 'c2c smoke x' } };

    // Flag unset: the endpoint is absent — 404 for every op, even as
    // Administrator, with the same body an unknown route gets (no record
    // data, no session material, no dry-run flag).
    delete process.env.C2C_SMOKE_ENABLED;
    for (const op of ['status', 'update', 'arith', 'delete']) {
      assert.equal((await call(op === 'status' ? { op } : marked(op), 'c2c-harness-session=admin')).status, 404, op);
    }
    assert.deepEqual((await call({ op: 'status' }, 'c2c-harness-session=admin')).body, { code: 'NOT_FOUND', message: 'no such endpoint' });
    // Fail closed: anything but exactly '1' stays dark.
    for (const value of ['0', 'true', 'yes', '']) {
      process.env.C2C_SMOKE_ENABLED = value;
      assert.equal((await call({ op: 'status' }, 'c2c-harness-session=admin')).status, 404, `flag=${JSON.stringify(value)}`);
    }

    // Flag set: current behaviour — the admin status shape answers, and the
    // auth gates still apply.
    process.env.C2C_SMOKE_ENABLED = '1';
    const status = await call({ op: 'status' }, 'c2c-harness-session=admin');
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.ok, true);
    assert.equal((await call({ op: 'status' })).status, 401);
    assert.equal((await call({ op: 'status' }, 'c2c-harness-session=reader')).status, 403);
  } finally {
    if (saved === undefined) delete process.env.C2C_SMOKE_ENABLED;
    else process.env.C2C_SMOKE_ENABLED = saved;
    await h.close();
  }
});

test('contract run: upload, submit, read-back extras, update, marked cleanup', async () => {
  const dir = dsFile(L2_DS);
  const h = await harness(L2_DS);
  try {
    const cap = io(h.port);
    const code = await smokeCli(smokeArgs(dir, h.port, ['--auth-token', 'admin']), cap.io);
    assert.equal(code, 0, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    const out = cap.stdout();
    assert.match(out, /upload Item\.Photo: \d+/);
    assert.match(out, /submit Vendor: 200 wrote/);
    assert.match(out, /submit Item: 200 wrote/);
    assert.match(out, /read-back Vendor: row \d+ present/);
    assert.match(out, /read-back Item: row \d+ present/);
    assert.match(out, /child Lines: 1 row/);
    assert.match(out, /lookup Vendor: display resolved/);
    assert.match(out, /file Photo: key resolves/);
    // Vendor's only writable field is the marker itself — a marker update would
    // defeat cleanup, so the run skips its update. Item patches Status.
    assert.doesNotMatch(out, /^update Vendor/m);
    assert.match(out, /update Item: 200 updated/);
    assert.match(out, /read-back Item \(after update\): row \d+ present/);
    // The store returns integer columns as text; the live read must still add and compare as a number.
    assert.match(out, /arithmetic Item\.Qty: 200 the live read is a number/);
    assert.match(out, /report Item_Report: 200/);
    assert.match(out, /delete Item: row \d+ deleted/);
    assert.match(out, /delete Vendor: row \d+ deleted/);
    assert.match(out, /created 2, deleted 2, left 0/);

    // The upload request signs a PUT and the run PUTs the bytes to it.
    const uploads = calls(h.requests, 'POST', '/server/c2c_api/uploads/Item/Photo');
    assert.equal(uploads.length, 1, 'one upload request');
    const uploadBody = uploads[0]!.body as { filename?: string; sha256?: string; contentType?: string };
    assert.match(String(uploadBody.filename), /^c2c-smoke-/);
    assert.match(String(uploadBody.sha256), /^[0-9a-f]{64}$/);
    assert.ok(h.requests.some((req) => req.method === 'PUT' && req.path.startsWith('/stratus/put/uploads/Item/Photo/')), 'the signed PUT carried bytes');

    // The submit record carries the uploaded { key } reference and a subform row.
    const submits = calls(h.requests, 'POST', '/server/c2c_api/forms/Item/submit');
    const insert = submits.find((req) => !(req.body as { ROWID?: unknown }).ROWID);
    assert.ok(insert, 'the insert submit');
    const record = (insert!.body as { record: Record<string, unknown> }).record;
    assert.match(String(record.Item_Name), /^c2c smoke /);
    assert.match(String((record.Photo as { key?: string }).key), /^uploads\/Item\/Photo\//);
    assert.ok(Array.isArray(record.Lines) && record.Lines.length === 1, 'one subform row');
    assert.match(String(record.Vendor), /^\d+$/);

    // The generated app has no edit route: the update goes through the
    // admin-only smoke endpoint, scoped to this run's marker.
    const updates = calls(h.requests, 'POST', '/server/c2c_api/admin/smoke').filter((req) => (req.body as { op?: string }).op === 'update');
    assert.equal(updates.length, 1, 'one marker-scoped update');
    const updateBody = updates[0]!.body as { form: string; rowId: string; marker: { field: string; tag: string }; fields: Record<string, unknown> };
    assert.equal(updateBody.form, 'Item');
    assert.match(updateBody.rowId, /^\d+$/);
    assert.equal(updateBody.marker.field, 'Item_Name');
    assert.match(updateBody.marker.tag, /^c2c smoke /);
    assert.equal(updateBody.fields.Status, 'Closed');
    assert.equal(Object.keys(updateBody.fields).length, 1, 'the update rewrites one field');

    // Read-back extras called the lookup and file endpoints.
    assert.ok(calls(h.requests, 'GET', '/server/c2c_api/lookups/Vendor/Vendor_Name').length >= 1, 'lookup display read');
    const files = calls(h.requests, 'POST', '/server/c2c_api/files/Item/Photo');
    assert.ok(files.length >= 1, 'file metadata read');
    assert.match(String((files[0]!.body as { rowId?: string }).rowId), /^\d+$/);

    // Cleanup removed exactly the rows this run created.
    const state = h.sdk.state();
    assert.equal(state.tables.Item?.length ?? 0, 0, 'Item rows cleaned up');
    assert.equal(state.tables.Vendor?.length ?? 0, 0, 'Vendor rows cleaned up');
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /admin/smoke gates on the Administrator profile and runs marker-checked deletes', async () => {
  const h = await harness(L2_DS);
  try {
    const call = async (body: unknown, cookie?: string) => {
      const res = await fetch(`http://127.0.0.1:${h.port}/server/c2c_api/admin/smoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
      let parsed: unknown = {};
      try {
        parsed = await res.json();
      } catch {
        /* non-JSON */
      }
      return { status: res.status, body: parsed as Record<string, unknown> };
    };

    // Unauthenticated, a non-admin profile, and a spoofed body identity all deny.
    assert.equal((await call({ op: 'status' })).status, 401);
    assert.equal((await call({ op: 'status' }, 'c2c-harness-session=reader')).status, 403);
    const spoof = await call({ op: 'status', user: { profile: 'Administrator' }, catalyst: { user: { profile: 'Administrator' } } }, 'c2c-harness-session=reader');
    assert.equal(spoof.status, 403);

    const status = await call({ op: 'status' }, 'c2c-harness-session=admin');
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.ok, true);
    assert.equal(status.body.mode, 'live');
    assert.equal(status.body.forms, 2);
    // The reply is status and counts only: no session, token or record data.
    const statusText = JSON.stringify(status.body);
    assert.equal(statusText.includes('c2c-harness-session'), false);
    assert.equal(statusText.includes('admin@example.test'), false);

    // A delete needs the form, a digits ROWID, the run marker field and tag.
    assert.equal((await call({ op: 'delete', form: 'Nope', rowId: '1', marker: { field: 'Item_Name', tag: 'c2c smoke x' } }, 'c2c-harness-session=admin')).status, 404);
    assert.equal((await call({ op: 'delete', form: 'Item', rowId: 'abc', marker: { field: 'Item_Name', tag: 'c2c smoke x' } }, 'c2c-harness-session=admin')).status, 400);
    assert.equal((await call({ op: 'delete', form: 'Item', rowId: '1', marker: { field: 'Added_User', tag: 'c2c smoke x' } }, 'c2c-harness-session=admin')).status, 400);
    assert.equal((await call({ op: 'delete', form: 'Item', rowId: '1', marker: { field: 'Item_Name', tag: 'not-a-smoke-tag' } }, 'c2c-harness-session=admin')).status, 400);

    // A row without this run's marker survives a delete call.
    const submit = async (path: string, record: unknown) => {
      const res = await fetch(`http://127.0.0.1:${h.port}/server/c2c_api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=admin' },
        body: JSON.stringify({ record }),
      });
      return { status: res.status, body: (await res.json()) as { values?: { ROWID?: string }; wrote?: boolean } };
    };
    const vendor = await submit('/forms/Vendor/submit', { Vendor_Name: 'keep me' });
    assert.equal(vendor.status, 200);
    const vendorId = String(vendor.body.values?.ROWID);
    const item = await submit('/forms/Item/submit', { Item_Name: 'keep me', Vendor: vendorId, Lines: [{ Note: 'x' }] });
    assert.equal(item.status, 200);
    const itemId = String(item.body.values?.ROWID);

    const refused = await call({ op: 'delete', form: 'Item', rowId: itemId, marker: { field: 'Item_Name', tag: 'c2c smoke run1' } }, 'c2c-harness-session=admin');
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal((h.sdk.state().tables.Item ?? []).length, 1, 'the unmarked row stays');

    // A tagged row deletes; a second delete of the same row is a 404.
    const tagged = await submit('/forms/Item/submit', { Item_Name: 'c2c smoke run1', Vendor: vendorId, Lines: [{ Note: 'x' }] });
    const taggedId = String(tagged.body.values?.ROWID);
    const marker = { field: 'Item_Name', tag: 'c2c smoke run1' };

    // The update op obeys the same gates: admin profile, marker match, no system columns.
    assert.equal((await call({ op: 'update', form: 'Item', rowId: taggedId, marker, fields: { Status: 'Closed' } }, 'c2c-harness-session=reader')).status, 403);
    assert.equal((await call({ op: 'update', form: 'Item', rowId: itemId, marker, fields: { Status: 'Closed' } }, 'c2c-harness-session=admin')).status, 409, 'an unmarked row refuses the patch');
    assert.equal((await call({ op: 'update', form: 'Item', rowId: taggedId, marker, fields: { Added_User: 'x' } }, 'c2c-harness-session=admin')).status, 400);
    assert.equal((await call({ op: 'update', form: 'Item', rowId: taggedId, marker, fields: {} }, 'c2c-harness-session=admin')).status, 400);
    const patched = await call({ op: 'update', form: 'Item', rowId: taggedId, marker, fields: { Status: 'Closed' } }, 'c2c-harness-session=admin');
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.updated, true);
    assert.equal((h.sdk.state().tables.Item ?? []).find((row) => String(row.ROWID) === taggedId)?.Status, 'Closed');
    // A read-only or unknown field in the patch is denied by authorizeWrite.
    assert.equal((await call({ op: 'update', form: 'Item', rowId: taggedId, marker, fields: { ROWID: '1' } }, 'c2c-harness-session=admin')).status, 400);

    // op "arith" stores 41 in the number field and checks the live read adds and compares as a number.
    assert.equal((await call({ op: 'arith', form: 'Item', rowId: taggedId, marker, field: 'Qty' }, 'c2c-harness-session=reader')).status, 403);
    assert.equal((await call({ op: 'arith', form: 'Item', rowId: taggedId, marker, field: 'Status' }, 'c2c-harness-session=admin')).status, 400);
    assert.equal((await call({ op: 'arith', form: 'Item', rowId: itemId, marker, field: 'Qty' }, 'c2c-harness-session=admin')).status, 409, 'an unmarked row is not touched');
    const arith = await call({ op: 'arith', form: 'Item', rowId: taggedId, marker, field: 'Qty' }, 'c2c-harness-session=admin');
    assert.equal(arith.status, 200, JSON.stringify(arith.body));
    assert.deepEqual(arith.body, { dryRun: false, arithmetic: true });
    assert.equal((h.sdk.state().tables.Item ?? []).find((row) => String(row.ROWID) === taggedId)?.Qty, '41');

    const gone = await call({ op: 'delete', form: 'Item', rowId: taggedId, marker }, 'c2c-harness-session=admin');
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(gone.body.deleted, true);
    assert.equal((await call({ op: 'delete', form: 'Item', rowId: taggedId, marker }, 'c2c-harness-session=admin')).status, 404);
    assert.equal((h.sdk.state().tables.Item ?? []).length, 1, 'only the marked row went');
  } finally {
    await h.close();
  }
});
