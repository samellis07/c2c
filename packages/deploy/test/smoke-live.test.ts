/**
 * c2c smoke --confirm against a live deploy tree, served in-process.
 *
 * The function side is exactly what `c2c deploy --confirm` writes: index.js,
 * routes.json, the vendored shims and the generated handlers, with the
 * zcatalyst-sdk-node import resolved to the offline fake (in-memory Data
 * Store + ZCQL subset, one App Administrator session). The same server also
 * stands in for the Data Store REST surface smoke uses to verify and clean up
 * (`POST /baas/v1/project/<id>/query`, SELECT and DELETE), like the recorded
 * Catalyst shapes.
 *
 * `--url` is http://127.0.0.1 — loopback is the only http the smoke URL check
 * allows. The admin-scope calls are built against api.catalyst.zoho.in and the
 * test fetch maps them onto the loopback server, so the DC allow-list is still
 * exercised.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import type { FetchLike } from '../../data/src/migrate.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';
import { smokeCli, smokePlanOf, type Io } from '../src/cli.js';
import { executeSmoke } from '../src/smoke.js';
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

/** These suites run the full smoke flow against the enabled (cutover) endpoint (C2C_SMOKE_ENABLED=1). */
process.env.C2C_SMOKE_ENABLED ??= '1';

/** L1 shape: two forms, one mandatory lookup, one list report, an Administrator profile. */
const L1_DS = `application "Widget"
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
			must have Item_Name
			(
				type = text
			)
			must have Vendor
			(
				type = picklist
				values = Vendor.Vendor_Name
			)
		}
		list Open_Items
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
  close(): Promise<void>;
}

/** The deployed function plus the session page and the admin query surface. */
async function harness(ds: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-smoke-live-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  let server: Server | undefined;
  try {
    const app = deriveIr(parse(ds));
    writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const req = createRequire(import.meta.url);
    const sdk = req(fake) as FakeSdk;
    sdk.setSession('admin', { user_id: '1', email_id: 'admin@example.test', role_details: { role_name: 'App Administrator' } });
    const entry = req(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
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
        const queryMatch = /^\/baas\/v1\/project\/\d+\/query$/.exec(url.pathname);
        if (queryMatch && rq.method === 'POST') {
          const body = JSON.parse((await readBody(rq)) || '{}') as { query?: string };
          try {
            const data = await sdk.executeZCQLQuery(String(body.query ?? ''));
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
    const port = (server.address() as { port: number }).port;
    return {
      port,
      sdk,
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
  // Admin-scope calls are minted for the DC host; map them onto the loopback harness.
  const fetcher: FetchLike = async (url, init) => {
    const target = url.startsWith('https://api.catalyst.zoho.in') ? `http://127.0.0.1:${port}${new URL(url).pathname}` : url;
    const res = await fetch(target, init);
    return { status: res.status, headers: res.headers, text: () => res.text() };
  };
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      env,
      spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
      fetch: fetcher,
      accessToken: async () => CLI_TOKEN,
      rest: async (call) => {
        if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+$/.test(call.path)) {
          const projectId = call.path.split('/').at(-1) ?? '';
          return {
            status: 200,
            body: {
              status: 'success',
              data: {
                id: projectId,
                project_name: 'c2c-widget',
                env_details: [
                  {
                    env_name: 'Development',
                    env_zgid: TEST_ORG,
                    id: TEST_ORG,
                    project_details: { id: projectId, project_name: 'c2c-widget' },
                  },
                ],
              },
            },
          };
        }
        return { status: 404, body: {} };
      },
    },
    stdout: () => out,
    stderr: () => err,
  };
}

function smokeArgs(dir: string, port: number, extra: string[] = []): string[] {
  return [
    join(dir, 'app.ds'),
    '--project',
    '1001',
    '--org',
    TEST_ORG,
    '--projects',
    projectsFile(),
    '--confirm',
    '--url',
    `http://127.0.0.1:${port}/server/c2c_api`,
    ...extra,
  ];
}

function dsFile(ds: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-smoke-ds-'));
  writeFileSync(join(dir, 'app.ds'), ds);
  return dir;
}

test('L1 smoke passes end to end on a live deployment: session cookie', async () => {
  const h = await harness(L1_DS);
  const dir = dsFile(L1_DS);
  try {
    const cap = io(h.port);
    const code = await smokeCli(smokeArgs(dir, h.port, ['--session-cookie', 'c2c-harness-session=admin']), cap.io);
    assert.equal(code, 0, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.match(cap.stdout(), /confirm: yes/);
    assert.match(cap.stdout(), /executed: yes/);
    assert.match(cap.stdout(), /submit Vendor: 200 wrote/);
    assert.match(cap.stdout(), /read-back Vendor: row \d+ present/);
    assert.match(cap.stdout(), /submit Item: 200 wrote/);
    assert.match(cap.stdout(), /read-back Item: row \d+ present/);
    assert.match(cap.stdout(), /report Open_Items: 200/);
    assert.match(cap.stdout(), /delete Item: .*deleted/);
    assert.match(cap.stdout(), /delete Vendor: .*deleted/);
    // Nothing this run created is left behind.
    const tables = h.sdk.state().tables;
    assert.equal((tables.Item ?? []).length, 0, JSON.stringify(tables));
    assert.equal((tables.Vendor ?? []).length, 0, JSON.stringify(tables));
  } finally {
    await h.close();
  }
});

test('L1 smoke passes with an explicit app token (--auth-token)', async () => {
  const h = await harness(L1_DS);
  const dir = dsFile(L1_DS);
  try {
    const cap = io(h.port);
    const code = await smokeCli(smokeArgs(dir, h.port, ['--auth-token', 'admin']), cap.io);
    assert.equal(code, 0, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    assert.equal((h.sdk.state().tables.Item ?? []).length, 0);
  } finally {
    await h.close();
  }
});

test('L1 smoke harvests the embedded session cookie from the app origin', async () => {
  const h = await harness(L1_DS);
  try {
    // The runner still picks up a session the app origin grants on its own;
    // the CLI's no-credential default is the in-browser step instead.
    const app = deriveIr(parse(L1_DS));
    const cap = io(h.port);
    const result = await executeSmoke(smokePlanOf(app, guardFor(app)), {
      fetch: cap.io.fetch,
      base: `http://127.0.0.1:${h.port}/server/c2c_api`,
      auth: {},
      dc: 'in',
      catalystBase: 'https://api.catalyst.zoho.in',
      scope: async () => ({ org: TEST_ORG, projectId: '1001', token: CLI_TOKEN }),
    });
    assert.equal(result.ok, true, result.lines.join('\n'));
    assert.match(result.lines.join('\n'), /session bootstrap: .*c2c-harness-session/);
  } finally {
    await h.close();
  }
});

/**
 * A call-logs app shape: a composite name whose
 * submit posts `{ Name: { first_name, last_name } }` onto `Name_first_name` /
 * `Name_last_name` columns, two datetimes an on-validate rule orders
 * (`start < end`), a choice whose validate branch keys on the initial value,
 * a lookup parent, and an owner-scoped report
 * `Call_Owner.Email == zoho.loginuserid`. Before these fixes both submits
 * failed with 422 and the report with 500.
 */
const CALLS_DS = `application "Widget"
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
	}
	section S
	{
		form Rep
		{
			must have Name
			(
				type = name
				first_name
				(
					type = first_name
				)
				last_name
				(
					type = last_name
				)
			)
			must have Email
			(
				type = email
			)
		}
		form Call
		{
			must have Purpose
			(
				type = text
			)
			must have Follow_up_Required
			(
				type = picklist
				values = {"Yes","No"}
				initial value = "No"
			)
			must have Call_Start_Time
			(
				type = datetime
			)
			must have Call_End_Time
			(
				type = datetime
			)
			must have Call_Owner
			(
				type = picklist
				values = Rep.ID
				displayformat = [Email]
			)
		}
		list My_Calls
		{
			displayName = "Calls"
			show all rows from Call [Call_Owner.Email == zoho.loginuserid]
		}
	}
	workflow
	{
		form
		{
			Call_Validate as "Call Validate"
			{
				type = form
				form = Call
				record event = on add
				on validate
				{
					actions
					{
						custom deluge script
						(
							if(input.Call_Start_Time >= input.Call_End_Time || input.Call_Start_Time > zoho.currenttime || input.Call_End_Time > zoho.currenttime)
							{
								alert "Please check the call time";
								cancel submit;
							}
						)
					}
				}
			}
		}
	}
}
`;

async function postRow(port: number, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=admin' },
    body: JSON.stringify(body),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed };
}

test('call-logs smoke: composite and datetime submits write, owner report answers 200 empty', async () => {
  const h = await harness(CALLS_DS);
  const dir = dsFile(CALLS_DS);
  try {
    const cap = io(h.port);
    const code = await smokeCli(smokeArgs(dir, h.port, ['--session-cookie', 'c2c-harness-session=admin']), cap.io);
    const out = cap.stdout();
    assert.equal(code, 0, out);
    // The three earlier failures: 422 "Name_first_name is required", 422
    // "Please check the call time", 500 on the owner-scoped report.
    assert.match(out, /submit Rep: 200 wrote/, out);
    assert.match(out, /submit Call: 200 wrote/, out);
    assert.match(out, /report My_Calls: 200/, out);
    assert.doesNotMatch(out, /Name_first_name.*required/, out);
    assert.doesNotMatch(out, /Please check the call time/, out);
    // The signed-in admin owns no rep row (the smoke rep's marker Email is a
    // run tag), so My_Calls is a well-formed empty answer, not an error.
    assert.match(out, /report My_Calls: 200 \(0 rows\)/, out);
  } finally {
    await h.close();
  }
});

test('the owner report resolves the login bind through the lookup parent', async () => {
  const h = await harness(CALLS_DS);
  try {
    // A rep row whose Email is the signed-in user's (zoho.loginuserid is the
    // email, not the numeric Catalyst user id) and a call owned by it.
    const rep = await postRow(h.port, '/forms/Rep/submit', { record: { Name: { first_name: 'Ada', last_name: 'Rep' }, Email: 'admin@example.test' } });
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    const repId = String((rep.body.values as Record<string, unknown> | undefined)?.ROWID ?? '');
    const call = await postRow(h.port, '/forms/Call/submit', {
      record: {
        Purpose: 'seeded',
        Follow_up_Required: 'No',
        Call_Start_Time: '2026-01-15 10:00:00',
        Call_End_Time: '2026-01-15 11:00:00',
        Call_Owner: repId,
      },
    });
    assert.equal(call.status, 200, JSON.stringify(call.body));
    const mine = await postRow(h.port, '/reports/My_Calls', { op: 'query', page: 0, pageSize: 300 });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const rows = Array.isArray(mine.body.rows) ? mine.body.rows : [];
    assert.equal(rows.length, 1, JSON.stringify(mine.body).slice(0, 400));
  } finally {
    await h.close();
  }
});

test('smoke --confirm with no session and no token calls nothing and prints the in-browser step', async () => {
  const dir = dsFile(L1_DS);
  // A bare server that grants no cookie.
  const server = createServer((_rq, rs) => {
    rs.writeHead(404);
    rs.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const cap = io(port);
    let hits = 0;
    server.on('request', () => {
      hits += 1;
    });
    const code = await smokeCli(smokeArgs(dir, port), cap.io);
    assert.equal(code, 4, cap.stdout() + cap.stderr());
    assert.match(cap.stdout(), /#\/admin\/smoke.* in your own browser/);
    assert.doesNotMatch(cap.stdout(), /--auth-token|--session-cookie/);
    assert.equal(hits, 0, 'the function is never called');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
