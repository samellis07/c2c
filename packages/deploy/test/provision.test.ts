/**
 * `c2c provision` drives the offline plan's steps to done.
 *
 * c2c never calls MCP itself: MCP steps are emitted for the host agent, whose
 * read-back results are recorded with `--record <id> --result <file>`. A step is
 * done only when its read-back matches. A read-back that already matches marks
 * the step `existing` and nothing is written (list → match → create-missing).
 * `--run <id>` is for `via: cli` steps only and needs `--confirm`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchReadBack, provisionCli, redactEvidence, redactString, type ProvisionState } from '../src/provision.js';
import { PLAN_CLI_PATH, PLAN_EMITTED_CLI_PATHS, PLAN_STEP_TOOLS, STEP_KINDS, planCli } from '../src/offline-plan.js';
import { resolveProvisionScope } from '../src/provision-config.js';
import { assertDeployRedirectUrl, IAC_DEPLOY_REDIRECT_URL, zipStore } from '../src/iac-import.js';
import { type Io } from '../src/cli.js';
import type { RestCall, RestResult } from '../src/tables.js';
import { FIRST_USE_GATES, type FirstUseGateId } from '../src/first-use.js';

const ORG = '10000000000';
const PROJECT = '10000000000013200';
const SCOPE = ['--org', ORG, '--project', PROJECT, '--dc', 'in'];

/** In-memory Catalyst project. `rest` is the CLI-token REST the deploy package already uses. */
interface Sandbox {
  tables: Map<string, { id: string; columns: Set<string> }>;
  nextTableId: number;
  hosted: boolean;
  embedded: boolean;
  corsDomains: Set<string>;
  users: { email_id: string; role_id: string }[];
  roles: { role_id: string; role_name: string }[];
  pools: { jobpool_id: string; name: string }[];
  buckets: { bucket_name: string }[];
  crons: { cron_name: string }[];
}

function emptySandbox(): Sandbox {
  return {
    tables: new Map(),
    nextTableId: 9000,
    hosted: false,
    embedded: false,
    corsDomains: new Set(),
    users: [],
    roles: [
      { role_id: '5001', role_name: 'App Administrator' },
      { role_id: '5002', role_name: 'App User' },
    ],
    pools: [],
    buckets: [],
    crons: [],
  };
}

/** The host-side write for an mcp/console step, faked by mutating the sandbox. */
function applyWrite(sandbox: Sandbox, step: PlanStep): void {
  if (step.id === 'custom-roles') {
    const roles = (step.args as { roles?: string[] }).roles ?? [];
    let id = 5100;
    for (const role of roles) {
      if (!sandbox.roles.some((r) => r.role_name === role)) sandbox.roles.push({ role_id: String(id++), role_name: role });
    }
  }
  if (step.tool === 'CatalystbyZoho_Create_Bucket') {
    sandbox.buckets.push({ bucket_name: String((step.args.body as { bucket_name?: string }).bucket_name) });
  }
  if (step.tool === 'CatalystbyZoho_Create_Job_Pool') {
    sandbox.pools.push({ jobpool_id: '6001', name: String((step.args.body as { name?: string }).name) });
  }
}

function projectDetails(projectId: string): RestResult {
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
            env_zgid: ORG,
            id: ORG,
            project_details: { id: projectId, project_name: 'c2c-widget' },
          },
        ],
      },
    },
  };
}

/** A confirmed run reads project details before it writes. Test fakes answer that GET, then the step. */
function guardedRest(inner: (call: RestCall) => Promise<RestResult>): (call: RestCall) => Promise<RestResult> {
  return async (call) => {
    const projectId = call.method === 'GET' ? /^\/baas\/v1\/project\/([0-9]+)$/.exec(call.path)?.[1] : undefined;
    if (projectId) return projectDetails(projectId);
    return inner(call);
  };
}

function sandboxRest(sandbox: Sandbox): { rest: (call: RestCall) => Promise<RestResult>; calls: string[] } {
  const calls: string[] = [];
  const rest = async (call: RestCall): Promise<RestResult> => {
    calls.push(`${call.method} ${call.path}`);
    // An opened Slate service lists its apps: the first-use gate probe answers open.
    if (call.method === 'GET' && call.path === `/slate/v1/project/${PROJECT}/app`) return { status: 200, body: { status: 'success', data: [] } };
    const prefix = `/baas/v1/project/${PROJECT}`;
    assert.ok(call.path.startsWith(prefix), `rest path outside the project: ${call.path}`);
    const path = call.path.slice(prefix.length);
    if (call.method === 'GET' && path === '') return projectDetails(PROJECT);
    const findTable = (id: string) => [...sandbox.tables.entries()].find(([, t]) => t.id === id);
    if (call.method === 'GET' && path === '/table') {
      return {
        status: 200,
        body: {
          data: [...sandbox.tables.entries()].map(([name, t]) => ({
            table_name: name,
            table_id: t.id,
            column_details: [...t.columns].map((column_name) => ({ column_name })),
          })),
        },
      };
    }
    const tableMatch = /^\/table\/([0-9]+)(\/column)?$/.exec(path);
    if (call.method === 'POST' && path === '/table') {
      const name = String((call.body as { table_name?: string }).table_name ?? '');
      if (sandbox.tables.has(name)) return { status: 409, body: { data: { error_code: 'DUPLICATE', message: 'table exists' } } };
      const id = String(sandbox.nextTableId++);
      sandbox.tables.set(name, { id, columns: new Set() });
      return { status: 200, body: { data: { table_id: id } } };
    }
    if (tableMatch) {
      const entry = findTable(tableMatch[1]!);
      if (!entry) return { status: 404, body: { data: { message: 'no table' } } };
      const [, table] = entry;
      if (call.method === 'GET') {
        return { status: 200, body: { data: { column_details: [...table.columns].map((column_name) => ({ column_name })) } } };
      }
      const bodies = Array.isArray(call.body) ? call.body : [call.body];
      for (const item of bodies) table.columns.add(String((item as { column_name?: string }).column_name));
      return { status: 200, body: { data: { added: bodies.length } } };
    }
    const auth = /^\/authentication\/enable\?auth_type=(hosted|embedded)$/.exec(path);
    if (call.method === 'POST' && auth) {
      if (auth[1] === 'hosted') sandbox.hosted = true;
      else sandbox.embedded = true;
      return { status: 200, body: { data: { [`${auth[1]}_auth`]: true } } };
    }
    if (call.method === 'POST' && path === '/cors-domain') {
      const domain = String((call.body as { domain?: string }).domain ?? '');
      if (sandbox.corsDomains.has(domain)) return { status: 409, body: { data: { message: 'domain already exists' } } };
      sandbox.corsDomains.add(domain);
      return { status: 200, body: { data: { domain } } };
    }
    if (call.method === 'GET' && path === '/project-user') return { status: 200, body: { data: { users: [...sandbox.users] } } };
    if (call.method === 'POST' && path === '/project-user') {
      const details = (call.body as { user_details?: { email_id?: string; role_id?: string } }).user_details ?? {};
      if (sandbox.users.some((user) => user.email_id === details.email_id)) {
        return { status: 409, body: { data: { message: 'user already exists' } } };
      }
      sandbox.users.push({ email_id: String(details.email_id), role_id: String(details.role_id) });
      return { status: 200, body: { data: { user_id: '7001' } } };
    }
    if (call.method === 'GET' && path === '/connections') return { status: 200, body: { data: { connections: [] } } };
    if (call.method === 'GET' && path === '/job_scheduling/cron') return { status: 200, body: { data: [...sandbox.crons] } };
    if (call.method === 'POST' && path === '/job_scheduling/cron') {
      const body = call.body as { cron_name?: string };
      sandbox.crons.push({ cron_name: String(body.cron_name) });
      return { status: 200, body: { data: { cron_name: body.cron_name } } };
    }
    return { status: 404, body: { data: { message: `no fake route ${call.method} ${path}` } } };
  };
  return { rest, calls };
}

/**
 * The envelope every CatalystbyZoho list tool answers: rows live nested under
 * `data.data[]`, inside `status: 'success'` at both levels. Synthetic rows —
 * same field names the recorded tools use, placeholder ids.
 */
function mcpRows(rows: Record<string, unknown>[]): unknown {
  return { status: 'success', data: { status: 'success', data: rows } };
}

/** The role rows Get_Table_Permissions/Scopes answer per call — role_name plus a grant field, never the table id. */
function roleRows(grantField: 'table_permissions' | 'table_scope'): Record<string, unknown>[] {
  const roles = ['App Administrator', 'App User', 'Member', 'Administrator', 'CEO'];
  return roles.map((role_name) => ({
    role_name,
    [grantField]: grantField === 'table_scope' ? 'GLOBAL' : role_name === 'App User' ? ['SELECT'] : ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  }));
}

/** The MCP read-back results a host agent would produce, read from the fake project. */
function mcpResult(sandbox: Sandbox, tool: string, args?: Record<string, unknown>): unknown {
  switch (tool) {
    case 'cli:project:list':
      return mcpRows([{ project_name: String((args as { name?: string })?.name ?? 'c2c-x'), id: PROJECT }]);
    case 'CatalystbyZoho_List_All_Tables':
      return mcpRows([...sandbox.tables.entries()].map(([table_name, t]) => ({ table_name, table_id: t.id })));
    case 'CatalystbyZoho_Get_All_Buckets':
      return mcpRows(sandbox.buckets.map((bucket) => ({ bucket_name: bucket.bucket_name })));
    case 'CatalystbyZoho_List_All_Jobpools':
      return mcpRows(sandbox.pools.map((pool) => ({ jobpool_id: pool.jobpool_id, name: pool.name })));
    case 'CatalystbyZoho_Get_Authentication_Configurations':
      return { status: 'success', data: { status: 'success', data: { hosted_auth: sandbox.hosted, embedded_auth: sandbox.embedded, public_signup: false } } };
    case 'CatalystbyZoho_List_All_Roles':
      return mcpRows(sandbox.roles.map((role) => ({ role_name: role.role_name, role_id: role.role_id })));
    case 'CatalystbyZoho_List_All_Project_Users':
      return mcpRows(sandbox.users.map((user) => ({ user_id: '7001', email_id: user.email_id, role_id: user.role_id })));
    case 'CatalystbyZoho_List_All_CORS_Domains':
      return mcpRows([...sandbox.corsDomains].map((domain) => ({ domain, cors: true, iframe: true })));
    case 'CatalystbyZoho_Get_Table_Permissions':
    case 'CatalystbyZoho_Get_Table_Scopes': {
      // One success envelope per read-back call, in call order — the rows
      // carry no table id, the call's path_variables.id is the table.
      const grantField = tool.endsWith('Scopes') ? 'table_scope' : 'table_permissions';
      const calls = (args as { calls?: unknown[] } | undefined)?.calls;
      const count = calls?.length || sandbox.tables.size || 1;
      return Array.from({ length: count }, () => mcpRows(roleRows(grantField)));
    }
    case 'CatalystbyZoho_List_All_Functions':
      return { status: 'success', data: { status: 'success', data: [{ name: 'c2c_api', api_name: 'c2c_api', id: '4001', is_authenticated: true, authentication: [] }], total_size: 1 } };
    case 'CatalystbyZoho_List_All_Slate_Apps':
      return { status: 'success', data: { status: 'success', data: { slate_apps: [] } } };
    case 'CatalystbyZoho_List_All_Emails_Configuration':
      return mcpRows([{ email_address: 'noreply@example.com', status: 'verified' }]);
    case 'CatalystbyZoho_List_All_Crons':
      return mcpRows(sandbox.crons.map((cron) => ({ cron_name: cron.cron_name })));
    default:
      return {};
  }
}

interface Cap {
  io: Io;
  out: () => string;
  err: () => string;
  restCalls: string[];
  spawned: string[];
}

function cap(sandbox?: Sandbox, importFetch?: Io['fetch']): Cap {
  let out = '';
  let err = '';
  const fake = sandbox ? sandboxRest(sandbox) : { rest: guardedRest(async () => ({ status: 500, body: {} })), calls: [] };
  const spawned: string[] = [];
  return {
    out: () => out,
    err: () => err,
    restCalls: fake.calls,
    spawned,
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      env: {},
      rest: fake.rest,
      spawn: async (command, args) => {
        spawned.push(`${command} ${args.join(' ')}`);
        return { code: 0, stdout: '', stderr: '' };
      },
      ...(importFetch ? { fetch: importFetch, accessToken: async () => 'test-token', sleep: async () => {} } : {
        fetch: async () => {
          throw new Error('fetch is never allowed in provision');
        },
      }),
    },
  };
}

function writeResult(out: string, id: string, value: unknown): string {
  const dir = join(out, 'provision', 'results');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function readState(out: string): ProvisionState {
  try {
    return JSON.parse(readFileSync(join(out, 'provision', 'state.json'), 'utf8')) as ProvisionState;
  } catch {
    return { version: 1, app: '', planSha256: '', learned: { byName: {} }, steps: {} };
  }
}

interface PlanStep {
  id: string;
  via: string;
  tool?: string;
  command?: string;
  args: Record<string, unknown>;
  readBack: { via: string; tool?: string; command?: string; args?: Record<string, unknown>; match: Record<string, unknown> };
}

interface PlanFile {
  version: 1;
  app: string;
  steps: PlanStep[];
}

/** A small hand-written plan: one step per via plus an mcp create. */
const MINI_PLAN: PlanFile = {
  version: 1,
  app: 'widget',
  steps: [
    {
      id: 'project',
      via: 'console',
      command: 'Create project "c2c-widget" (Development) in the Catalyst console',
      args: { name: 'c2c-widget', environment: 'Development' },
      readBack: { via: 'cli', command: 'c2c provision --record project', match: { project_name: 'c2c-widget', id: '<project>' } },
    },
    {
      id: 'tables',
      via: 'cli',
      command: 'c2c provision --confirm --run tables',
      args: { plan: 'provision/tables.json', tables: ['Item'] },
      readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Tables', match: { table_name: ['Item'] } },
    },
    {
      id: 'bucket',
      via: 'mcp',
      tool: 'CatalystbyZoho_Create_Bucket',
      args: {
        path_variables: { projectId: '<project>' },
        headers: { 'Catalyst-org': '<org>', Environment: 'Development' },
        body: { bucket_name: 'c2c-widget-deadbeef', bucket_meta: { type: 'protected' } },
      },
      readBack: { via: 'mcp', tool: 'CatalystbyZoho_Get_All_Buckets', match: { bucket_name: 'c2c-widget-deadbeef' } },
    },
    {
      id: 'auth-hosted',
      via: 'cli',
      command: 'c2c provision --confirm --run auth-hosted',
      args: { call: { method: 'POST', path: '/baas/v1/project/<project>/authentication/enable?auth_type=hosted', body: { public_signup: false } } },
      readBack: { via: 'mcp', tool: 'CatalystbyZoho_Get_Authentication_Configurations', match: { hosted_auth: true } },
    },
  ],
};

function writeMiniPlan(): string {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-'));
  mkdirSync(join(out, 'provision'), { recursive: true });
  writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify(MINI_PLAN, null, 2)}\n`);
  writeFileSync(
    join(out, 'provision', 'tables.json'),
    `${JSON.stringify(
      [
        {
          table: 'Item',
          form: 'Item',
          nosql: false,
          columns: [{ table: 'Item', column_name: 'Name', data_type: 'varchar', max_length: 255, is_unique: false, is_mandatory: false }],
        },
      ],
      null,
      2,
    )}\n`,
  );
  return out;
}

function lastJson(out: string): Record<string, unknown> {
  // --next/--record/--run print exactly one JSON document.
  const start = out.indexOf('{');
  assert.ok(start >= 0, `no JSON in: ${out}`);
  return JSON.parse(out.slice(start).trim()) as Record<string, unknown>;
}

test('matchReadBack: scalars, key names, arrays, objects; mismatch lists what is missing', () => {
  const result = { data: { tables: [{ table_name: 'Item', table_id: '1' }] }, hosted_auth: true };
  assert.deepEqual(matchReadBack(result, { tables: ['Item'] }), { ok: true, missing: [] });
  assert.deepEqual(matchReadBack(result, { hosted_auth: true }), { ok: true, missing: [] });
  assert.equal(matchReadBack(result, { table_name: 'Item' }).ok, true);
  assert.equal(matchReadBack(result, { tables: ['Item', 'Other'] }).ok, false);
  const miss = matchReadBack(result, { tables: ['Item', 'Other'], hosted_auth: false });
  assert.equal(miss.ok, false);
  assert.equal(miss.missing.length, 2);
  assert.equal(matchReadBack(result, { data: { tables: ['Item'] } }).ok, true);
  // hosted_auth is a sibling of "data", not under it — the bound node must contain the expected value.
  assert.equal(matchReadBack(result, { data: { hosted_auth: true } }).ok, false);
  // Big-int ids arrive as strings through parseJsonExact; digits compare loosely.
  assert.equal(matchReadBack({ id: PROJECT }, { id: PROJECT }).ok, true);
});

// --- key-bound read-backs, PII hygiene, cron idempotency ---

test('matchReadBack is key-bound: the forged auth read-back and a missing key both fail', () => {
  // B1: {hosted_auth:false, public_signup:true} must NOT satisfy hosted_auth:true —
  // a value under a different key never counts.
  const forged = matchReadBack({ hosted_auth: false, public_signup: true }, { hosted_auth: true });
  assert.equal(forged.ok, false, 'forged auth read-back must not match');
  assert.equal(matchReadBack({ embedded_auth: true }, { hosted_auth: true }).ok, false);
  // A missing key fails and says so.
  const absent = matchReadBack({ data: { connections: [] } }, { link_name: ['zoho_workdrive'] });
  assert.equal(absent.ok, false);
  assert.match(absent.missing[0]!, /no "link_name" key/);
  // A key elsewhere with the expected value under the wrong key is not enough.
  assert.equal(matchReadBack(mcpRows([{ bucket_name: 'c2c-x' }]), { link_name: ['c2c-x'] }).ok, false);
});

test('matchReadBack binds a grant to its role key: App Administrator permissions never satisfy App User', () => {
  // B1: the forged read-back grants App User only SELECT while App Administrator
  // holds the full set — the old label-only matcher accepted it.
  const forged = { 'App User': ['SELECT'], 'App Administrator': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] };
  assert.equal(matchReadBack(forged, { 'App User': ['SELECT', 'INSERT'] }).ok, false);
  const real = { 'App User': ['SELECT', 'INSERT'], 'App Administrator': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] };
  assert.equal(matchReadBack(real, { 'App User': ['SELECT', 'INSERT'] }).ok, true);
});

test('provision: dry run prints the plan and an all-pending status without writing state', async () => {
  const out = writeMiniPlan();
  const c = cap();
  assert.equal(await provisionCli(['--out', out, ...SCOPE], c.io), 0);
  assert.match(c.out(), /project.*pending/);
  assert.match(c.out(), /tables.*pending/);
  assert.match(c.out(), /0\/4/);
  assert.equal(statSync(join(out, 'provision', 'state.json'), { throwIfNoEntry: false })?.isFile() ?? false, false);
  assert.deepEqual(c.restCalls, []);
  rmSync(out, { recursive: true, force: true });
});

test('--next emits the first pending step with resolved args; MCP steps carry tool + args + read-back', async () => {
  const out = writeMiniPlan();
  const c = cap();
  assert.equal(await provisionCli(['--out', out, '--next', ...SCOPE], c.io), 0);
  const next = lastJson(c.out()) as { done: boolean; step: { id: string; via: string; command: string } };
  assert.equal(next.done, false);
  assert.equal(next.step.id, 'project');
  assert.equal(next.step.via, 'console');
  // Record the console step: the project already exists.
  const result = writeResult(out, 'project', mcpRows([{ project_name: 'c2c-widget', id: PROJECT }]));
  assert.equal(await provisionCli(['--out', out, '--record', 'project', '--result', result, ...SCOPE], c.io), 0);
  assert.equal(readState(out).steps.project.status, 'existing');
  assert.equal(readState(out).learned.byName['c2c-widget'], PROJECT);
  const c2 = cap();
  assert.equal(await provisionCli(['--out', out, '--next', '--org', ORG, '--dc', 'in'], c2.io), 0);
  const next2 = lastJson(c2.out());
  assert.equal((next2.step as { id: string }).id, 'tables');
  // The learned project id resolves <project> even without --project.
  assert.equal(readState(out).learned.projectId, PROJECT);
  rmSync(out, { recursive: true, force: true });
});

test('--record with a matching read-back marks done/existing; a mismatch keeps the step open', async () => {
  const out = writeMiniPlan();
  const c = cap();
  // MCP step: the bucket does not exist yet.
  const missing = writeResult(out, 'bucket', mcpRows([]));
  assert.equal(await provisionCli(['--out', out, '--record', 'bucket', '--result', missing, ...SCOPE], c.io), 1);
  assert.equal(readState(out).steps.bucket, undefined, 'a mismatched read-back must not record');
  assert.match(c.err(), /bucket_name/);
  // The agent creates it, then records the read-back: applied → done.
  const created = writeResult(out, 'bucket2', mcpRows([{ bucket_name: 'c2c-widget-deadbeef' }]));
  assert.equal(await provisionCli(['--out', out, '--record', 'bucket', '--result', created, '--applied', ...SCOPE], c.io), 0);
  assert.equal(readState(out).steps.bucket.status, 'done');
  rmSync(out, { recursive: true, force: true });
});

test('--run refuses mcp and console steps, and refuses without --confirm', async () => {
  const out = writeMiniPlan();
  const c = cap();
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'bucket', ...SCOPE], c.io), 2);
  assert.match(c.err(), /bucket.*mcp|--run.*cli/);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'project', ...SCOPE], c.io), 2);
  assert.equal(await provisionCli(['--out', out, '--run', 'tables', ...SCOPE], c.io), 2);
  assert.match(c.err(), /--confirm/);
  assert.deepEqual(c.restCalls, []);
  rmSync(out, { recursive: true, force: true });
});

test('--run tables creates only missing tables and closes the step itself', async () => {
  const out = writeMiniPlan();
  const sandbox = emptySandbox();
  const c = cap(sandbox);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'tables', ...SCOPE], c.io), 0);
  assert.equal(sandbox.tables.has('Item'), true);
  assert.ok(c.restCalls.some((call) => call === `POST /baas/v1/project/${PROJECT}/table`));
  // A confirmed run is its own evidence: done, not "awaiting read-back".
  const ran = lastJson(c.out());
  assert.equal(ran.status, 'done');
  assert.equal(ran.verified, true);
  assert.equal(readState(out).steps.tables.status, 'done');
  // The run publishes the table id it observed — <id:Item> now resolves.
  assert.equal(readState(out).learned.byName['Item'], '9000');
  // A later MCP read-back still re-proves it without disturbing the state.
  const proof = writeResult(out, 'tables', mcpResult(sandbox, 'CatalystbyZoho_List_All_Tables'));
  assert.equal(await provisionCli(['--out', out, '--record', 'tables', '--result', proof, ...SCOPE], c.io), 0);
  assert.equal(readState(out).steps.tables.status, 'done');
  // Re-running the same step is a no-op.
  const again = cap(sandbox);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'tables', ...SCOPE], again.io), 0);
  assert.equal(sandbox.tables.size, 1);
  assert.match(again.out(), /done|existing|skip/);
  rmSync(out, { recursive: true, force: true });
});

test('the mini plan completes end to end; a second run over the same resources is all existing', async () => {
  const out = writeMiniPlan();
  const sandbox = emptySandbox();
  const c = cap(sandbox);
  // project (console, done by the user)
  const project = writeResult(out, 'project', mcpResult(sandbox, 'cli:project:list', { name: 'c2c-widget' }));
  assert.equal(await provisionCli(['--out', out, '--record', 'project', '--result', project, '--applied', ...SCOPE], c.io), 0);
  // tables (cli)
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'tables', ...SCOPE], c.io), 0);
  const tables = writeResult(out, 'tables', mcpResult(sandbox, 'CatalystbyZoho_List_All_Tables'));
  assert.equal(await provisionCli(['--out', out, '--record', 'tables', '--result', tables, ...SCOPE], c.io), 0);
  // bucket (mcp): the agent created it, so --applied.
  sandbox.buckets.push({ bucket_name: 'c2c-widget-deadbeef' });
  const bucket = writeResult(out, 'bucket', mcpResult(sandbox, 'CatalystbyZoho_Get_All_Buckets'));
  assert.equal(await provisionCli(['--out', out, '--record', 'bucket', '--result', bucket, '--applied', ...SCOPE], c.io), 0);
  // auth-hosted (cli): --run then record the MCP read-back.
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'auth-hosted', ...SCOPE], c.io), 0);
  assert.equal(sandbox.hosted, true);
  const auth = writeResult(out, 'auth-hosted', mcpResult(sandbox, 'CatalystbyZoho_Get_Authentication_Configurations'));
  assert.equal(await provisionCli(['--out', out, '--record', 'auth-hosted', '--result', auth, ...SCOPE], c.io), 0);

  const status = cap();
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], status.io), 0);
  assert.match(status.out(), /4\/4/);
  const done = cap();
  assert.equal(await provisionCli(['--out', out, '--next', ...SCOPE], done.io), 0);
  assert.equal(lastJson(done.out()).done, true);

  // Second run over a project that already has everything: zero writes, all existing.
  const out2 = writeMiniPlan();
  const c2 = cap(sandbox);
  for (const step of MINI_PLAN.steps) {
    if (step.id === 'project') {
      // The project read-back goes through c2c's own Catalyst CLI list (fake here).
      c2.io.listProjects = async () => [{ name: 'c2c-widget', id: PROJECT }];
      assert.equal(await provisionCli(['--out', out2, '--record', step.id, ...SCOPE], c2.io), 0, `record ${step.id}`);
      continue;
    }
    const result = writeResult(out2, step.id, mcpResult(sandbox, step.readBack.tool ?? '', { name: 'c2c-widget' }));
    assert.equal(await provisionCli(['--out', out2, '--record', step.id, '--result', result, ...SCOPE], c2.io), 0, `record ${step.id}`);
  }
  const state2 = readState(out2);
  for (const step of MINI_PLAN.steps) assert.equal(state2.steps[step.id]?.status, 'existing', step.id);
  assert.equal(c2.restCalls.filter((call) => call.startsWith('POST')).length, 0, 'second run must not write');
  assert.deepEqual(
    c2.spawned.filter((line) => /CatalystbyZoho/i.test(line)),
    [],
    'c2c never invokes MCP tools',
  );
  rmSync(out, { recursive: true, force: true });
  rmSync(out2, { recursive: true, force: true });
});

test('a kill mid-plan resumes from the first incomplete step', async () => {
  const out = writeMiniPlan();
  const sandbox = emptySandbox();
  const c = cap(sandbox);
  const project = writeResult(out, 'project', mcpResult(sandbox, 'cli:project:list', { name: 'c2c-widget' }));
  assert.equal(await provisionCli(['--out', out, '--record', 'project', '--result', project, '--applied', ...SCOPE], c.io), 0);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'tables', ...SCOPE], c.io), 0);
  // The run closed the step in state.json before exiting — a resumed process
  // continues at the next open step, no read-back owed.
  const resumed = cap(sandbox);
  assert.equal(await provisionCli(['--out', out, '--next', ...SCOPE], resumed.io), 0);
  const next = lastJson(resumed.out());
  assert.equal((next.step as { id: string }).id, 'bucket');
  const c2 = cap(sandbox);
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], c2.io), 0);
  assert.equal(readState(out).steps.tables.status, 'done');
  rmSync(out, { recursive: true, force: true });
});

test('a plan file written by a different plan refuses (state belongs to one plan)', async () => {
  const out = writeMiniPlan();
  const c = cap();
  const project = writeResult(out, 'project', mcpRows([{ id: PROJECT, project_name: 'c2c-widget' }]));
  assert.equal(await provisionCli(['--out', out, '--record', 'project', '--result', project, ...SCOPE], c.io), 0);
  writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify({ ...MINI_PLAN, steps: MINI_PLAN.steps.slice(1) }, null, 2)}\n`);
  const c2 = cap();
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], c2.io), 1);
  assert.match(c2.err(), /plan.*changed|sha/i);
  rmSync(out, { recursive: true, force: true });
});

/** The local fixture directory: C2C_FIXTURES_DIR, or undefined (same convention as tests/golden). */
function fixturesDir(): string | undefined {
  return process.env.C2C_FIXTURES_DIR || undefined;
}
const FIXTURES = fixturesDir();
const L1_DS = FIXTURES ? join(FIXTURES, 'synthetic', 's01-purchase-orders', 'L1', 'c2c-syn-po-l1.exported.ds') : '';
const fixtureSkip = !FIXTURES || !statSync(L1_DS, { throwIfNoEntry: false })?.isFile() ? 'C2C_FIXTURES_DIR L1 fixture not available' : false;

test('the generated plan: bucket reads back via Get_All_Buckets, custom roles stay console, permissions split by eligible role', { skip: fixtureSkip }, async () => {
  const l1 = L1_DS;
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-plan-'));
  const c = cap();
  // --project marks the plan as for an existing project: the per-step path stays.
  assert.equal(await planCli([l1, '--out', out, '--dc', 'in', '--project', PROJECT], c.io), 0);
  const plan = JSON.parse(readFileSync(join(out, 'provision', 'plan.json'), 'utf8')) as PlanFile;
  for (const step of plan.steps) {
    assert.notEqual(step.readBack.tool, 'CatalystbyZoho_Head_Bucket', `${step.id} must not read back with Head_Bucket`);
  }
  const roles = plan.steps.find((step) => step.id === 'custom-roles');
  assert.ok(roles, 'custom-roles step missing');
  assert.equal(roles.via, 'console');
  // L1 grants are all on the custom "Administrator" role: no Update_Table_Permissions step.
  const mcpGrants = plan.steps.filter((step) => step.tool === 'CatalystbyZoho_Update_Table_Permissions');
  assert.equal(mcpGrants.length, 0, 'custom-role grants must not go through Update_Table_Permissions');
  const consoleGrants = plan.steps.filter((step) => step.id.startsWith('table-permissions'));
  assert.ok(consoleGrants.length > 0 && consoleGrants.every((step) => step.via === 'console'));
  // Every MCP step emits the connector envelope.
  for (const step of plan.steps.filter((s) => s.via === 'mcp')) {
    const args = step.args as { path_variables?: { projectId?: string }; headers?: Record<string, string> };
    assert.equal(args.path_variables?.projectId, '<project>', `${step.id}: projectId placeholder`);
    assert.equal(args.headers?.Environment, 'Development', `${step.id}: Environment header`);
  }
  // Detail files the cli steps need.
  assert.ok(statSync(join(out, 'provision', 'tables.json'), { throwIfNoEntry: false })?.isFile());
  rmSync(out, { recursive: true, force: true });
});

test('L1 provisions end to end in the fake project, every step read back', { skip: fixtureSkip }, async () => {
  const l1 = L1_DS;
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-l1-'));
  const planner = cap();
  // An existing project provisions step by step (no IaC import).
  assert.equal(await planCli([l1, '--out', out, '--dc', 'in', '--project', PROJECT], planner.io), 0);
  const plan = JSON.parse(readFileSync(join(out, 'provision', 'plan.json'), 'utf8')) as PlanFile;
  const sandbox = emptySandbox();
  const c = cap(sandbox);
  mkdirSync(join(out, 'provision'), { recursive: true });
  writeFileSync(join(out, 'provision', 'inputs.json'), JSON.stringify({ slateDomain: 'app-123.onslate.in' }));

  for (let guard = 0; guard < 40; guard++) {
    const nextCap = cap(sandbox);
    assert.equal(await provisionCli(['--out', out, '--next', ...SCOPE], nextCap.io), 0);
    const next = lastJson(nextCap.out()) as { done: boolean; step?: PlanStep };
    if (next.done === true) break;
    const step = next.step!;
    if (step.via === 'cli') {
      assert.equal(await provisionCli(['--out', out, '--confirm', '--run', step.id, ...SCOPE], c.io), 0, `run ${step.id}: ${c.err()}`);
    } else {
      // The host performs the write (console clicks / the MCP tool) here — faked by mutating the sandbox.
      applyWrite(sandbox, step);
    }
    const recorded = await (async () => {
      if (step.id === 'project') {
        // The project read-back is c2c's own Catalyst CLI list (fake here): name and id only.
        c.io.listProjects = async () => [{ name: String((step.args as { name?: string }).name), id: PROJECT }];
        return provisionCli(['--out', out, '--record', step.id, ...SCOPE], c.io);
      }
      // A first-use gate is verified by c2c's own read, like a cli read-back.
      if (step.readBack.via === 'cli' && (step.via === 'cli' || step.id.endsWith('-enable'))) {
        return provisionCli(['--out', out, '--record', step.id, ...SCOPE], c.io);
      }
      const result = writeResult(
        out,
        `${step.id}-rb`,
        mcpResult(sandbox, step.readBack.tool ?? '', {
          name: (step.args as { name?: string }).name ?? 'x',
          calls: (step.readBack.args as { calls?: unknown[] } | undefined)?.calls,
        }),
      );
      return provisionCli(['--out', out, '--record', step.id, '--result', result, ...(step.via === 'cli' ? [] : ['--applied']), ...SCOPE], c.io);
    })();
    assert.equal(recorded, 0, `record ${step.id}: ${c.err()}`);
  }
  const state = readState(out);
  for (const step of plan.steps) assert.ok(['done', 'existing'].includes(state.steps[step.id]?.status ?? ''), `${step.id} not terminal`);
  const status = cap();
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], status.io), 0);
  assert.match(status.out(), new RegExp(`${plan.steps.length}/${plan.steps.length}`));
  // c2c itself never called an MCP tool.
  assert.equal(c.spawned.filter((line) => /CatalystbyZoho/i.test(line)).length, 0);
  rmSync(out, { recursive: true, force: true });
});

/** A two-step plan: the cli `crons` step plus a spec file keyed by display name. */
function writeCronPlan(out: string): void {
  mkdirSync(join(out, 'provision'), { recursive: true });
  const plan: PlanFile = {
    version: 1,
    app: 'widget',
    steps: [
      {
        id: 'crons',
        via: 'cli',
        command: 'c2c provision --confirm --run crons',
        args: { plan: 'provision/crons.json', schedules: 1, enabled: false },
        readBack: {
          via: 'mcp',
          tool: 'CatalystbyZoho_List_All_Crons',
          match: { cron_name: ['daily_report'] },
        },
      },
    ],
  };
  writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  // The generated spec shape: a display `name` plus a body whose cron_name is snake_case.
  writeFileSync(
    join(out, 'provision', 'crons.json'),
    `${JSON.stringify(
      [
        {
          name: 'Daily Report',
          jobModule: 'functions/job/daily-report.mjs',
          body: { cron_name: 'daily_report', cron_type: 'OneTime', cron_status: false, cron_details: { time_of_execution: '2030-01-01T00:00:00Z' } },
        },
      ],
      null,
      2,
    )}\n`,
  );
}

test('crons: a spaced display name is keyed by cron_name — a rerun posts zero writes and the read-back completes', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-cron-'));
  writeCronPlan(out);
  const sandbox = emptySandbox();
  const c = cap(sandbox);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'crons', ...SCOPE], c.io), 0, c.err());
  assert.equal(c.restCalls.filter((call) => call.startsWith('POST')).length, 1, 'first run creates the cron once');
  assert.deepEqual(sandbox.crons, [{ cron_name: 'daily_report' }]);
  // The read-back binds cron_name, so the step can reach done.
  const cronRb = writeResult(out, 'crons-rb', mcpRows([{ cron_name: 'daily_report', cron_id: '8001' }]));
  assert.equal(await provisionCli(['--out', out, '--record', 'crons', '--result', cronRb, ...SCOPE], c.io), 0, c.err());
  assert.equal(readState(out).steps.crons?.status, 'done');

  // A rerun over a project that already has the cron (state lost, e.g. a kill
  // before --record): the listing's cron_name must suppress the POST.
  const out2 = mkdtempSync(join(tmpdir(), 'c2c-prov-cron2-'));
  writeCronPlan(out2);
  const c2 = cap(sandbox);
  assert.equal(await provisionCli(['--out', out2, '--confirm', '--run', 'crons', ...SCOPE], c2.io), 0, c2.err());
  assert.equal(c2.restCalls.filter((call) => call.startsWith('POST')).length, 0, 'an existing cron must not be POSTed again');
  assert.equal(sandbox.crons.length, 1, 'no duplicate cron');
  rmSync(out, { recursive: true, force: true });
  rmSync(out2, { recursive: true, force: true });
});

test('tables: a crons-shaped spec is refused by name, not a TypeError, and writes nothing', async () => {
  const out = writeMiniPlan();
  // Hand-edited or misplaced spec: cron entries where the table spec belongs.
  writeFileSync(
    join(out, 'provision', 'tables.json'),
    `${JSON.stringify(
      [
        {
          name: 'Daily Report',
          jobModule: 'functions/job/daily-report.mjs',
          body: { cron_name: 'daily_report', cron_type: 'OneTime', cron_status: false },
        },
      ],
      null,
      2,
    )}\n`,
  );
  const c = cap();
  const code = await provisionCli(['--out', out, '--confirm', '--run', 'tables', ...SCOPE], c.io);
  assert.equal(code, 1);
  assert.match(c.err(), /table spec/);
  assert.equal(c.restCalls.filter((call) => call.startsWith('POST')).length, 0, 'a bad spec must write nothing');
  rmSync(out, { recursive: true, force: true });
});

/** The plan steps `c2c plan` writes for the gates, in plan order, with a cli step between them. */
function writeGatePlan(out: string, gates: FirstUseGateId[]): void {
  mkdirSync(join(out, 'provision'), { recursive: true });
  const gateStep = (id: FirstUseGateId): PlanStep => {
    const gate = FIRST_USE_GATES[id];
    return {
      id: gate.stepId,
      via: 'console',
      command: gate.console,
      args: { service: gate.service },
      readBack: { via: 'cli', command: `c2c provision --record ${gate.stepId}`, args: { call: { method: 'GET', path: gate.probe } }, match: { gate: 'open' } },
    };
  };
  const plan: PlanFile = {
    version: 1,
    app: 'widget',
    steps: [
      ...gates.map(gateStep),
      {
        id: 'auth-hosted',
        via: 'cli',
        command: 'c2c provision --confirm --run auth-hosted',
        args: { call: { method: 'POST', path: '/baas/v1/project/<project>/authentication/enable?auth_type=hosted', body: { public_signup: false } } },
        readBack: { via: 'mcp', tool: 'CatalystbyZoho_Get_Authentication_Configurations', match: { hosted_auth: true } },
      },
    ],
  };
  writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
}

/** Closed-gate answers: the "access the service" refusal and the INVALID_URL_PATTERN list answer. */
const CLOSED_SHAPES: Record<FirstUseGateId, RestResult> = {
  slate: { status: 400, body: { status: 'failure', data: { message: "Please access the Slate service in your project's console before deploying via the CLI.", error_code: 'INVALID_INPUT' } } },
  cloudscale: { status: 400, body: { status: 'failure', data: { message: "Please access the Cloud Scale service in your project's console.", error_code: 'INVALID_INPUT' } } },
  stratus: { status: 404, body: { status: 'failure', data: { message: 'Please check if the URL trying to access is a correct one', error_code: 'INVALID_URL_PATTERN' } } },
  smartbrowz: { status: 400, body: { status: 'failure', data: { message: "Please access the SmartBrowz service in your project's console.", error_code: 'INVALID_INPUT' } } },
};
const OPEN_SHAPES: Record<FirstUseGateId, RestResult> = {
  slate: { status: 200, body: { status: 'success', data: [] } },
  cloudscale: { status: 200, body: { status: 'success', data: [] } },
  stratus: { status: 200, body: { status: 'success', data: [] } },
  smartbrowz: { status: 200, body: { status: 'success', data: [] } },
};

for (const id of ['slate', 'cloudscale', 'stratus', 'smartbrowz'] as const) {
  const gate = FIRST_USE_GATES[id];
  test(`${gate.stepId}: a closed gate keeps the step open with the checklist line; an open answer closes it`, async () => {
    const out = mkdtempSync(join(tmpdir(), `c2c-prov-gate-${id}-`));
    writeGatePlan(out, [id]);
    let open = false;
    const probes: string[] = [];
    const c = cap();
    c.io.rest = guardedRest(async (call) => {
      c.restCalls.push(`${call.method} ${call.path}`);
      if (call.method === 'GET' && call.path === gate.probe.replace('<project>', PROJECT)) {
        probes.push(call.path);
        return open ? OPEN_SHAPES[id] : CLOSED_SHAPES[id];
      }
      return { status: 500, body: {} };
    });
    // --next names the one console line and the c2c verify command.
    assert.equal(await provisionCli(['--out', out, '--next', ...SCOPE], c.io), 0);
    const next = lastJson(c.out()) as { instructions: string };
    assert.match(next.instructions, new RegExp(`${gate.service} → Start Exploring`));
    assert.match(next.instructions, new RegExp(`c2c provision --record ${gate.stepId}`));
    // Closed: c2c reads the probe itself, the step stays open, exit 1.
    assert.equal(await provisionCli(['--out', out, '--record', gate.stepId, ...SCOPE], c.io), 1);
    assert.equal(readState(out).steps[gate.stepId], undefined);
    assert.match(c.err(), new RegExp(`${gate.service} first-use gate is closed`));
    assert.match(c.err(), /Start Exploring \(https:\/\/console\.catalyst\.zoho\.in\/baas\//);
    // A later cli step never runs past the closed gate — no write is sent.
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'auth-hosted', ...SCOPE], c.io), 1);
    assert.match(c.err(), new RegExp(`step auth-hosted waits on ${gate.stepId}`));
    assert.equal(c.restCalls.filter((call) => call.startsWith('POST')).length, 0);
    // A result file someone else produced never closes a gate.
    const forged = writeResult(out, `${id}-forged`, { gate: 'open' });
    assert.equal(await provisionCli(['--out', out, '--record', gate.stepId, '--result', forged, ...SCOPE], c.io), 2);
    assert.equal(readState(out).steps[gate.stepId], undefined);
    // The user says done: the same read answers open, the step closes verified.
    open = true;
    assert.equal(await provisionCli(['--out', out, '--record', gate.stepId, ...SCOPE], c.io), 0, c.err());
    assert.equal(readState(out).steps[gate.stepId]?.status, 'existing');
    assert.match(c.out(), new RegExp(`${gate.service} first-use gate verified open`));
    // --next probes the gate (closed), --record probes it (closed), --run's
    // gatesBefore probes it (closed), --record probes it (open).
    assert.equal(probes.length, 4);
    rmSync(out, { recursive: true, force: true });
  });
}

test('--next probes an open gate past with no console line: no gate step, no Start Exploring', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-gate-next-open-'));
  writeGatePlan(out, ['cloudscale']);
  const c = cap();
  c.io.rest = guardedRest(async (call) => {
    c.restCalls.push(`${call.method} ${call.path}`);
    if (call.method === 'GET' && call.path === `/baas/v1/project/${PROJECT}/table`) return OPEN_SHAPES.cloudscale;
    return { status: 500, body: {} };
  });
  // The Cloud Scale gate verifies open, so --next presents the following cli
  // step and prints no console text for the gate — one JSON document only.
  assert.equal(await provisionCli(['--out', out, '--next', ...SCOPE], c.io), 0);
  const next = lastJson(c.out()) as { done: boolean; step: { id: string } };
  assert.equal(next.done, false);
  assert.equal(next.step.id, 'auth-hosted');
  assert.ok(!c.out().includes('cloudscale-enable'), '--next must not name the skipped gate step');
  assert.ok(!c.out().includes('Start Exploring'), '--next must print no console line for an open gate');
  assert.ok(!c.out().includes('Cloud Scale'), '--next must print no gate text for an open gate');
  assert.equal(readState(out).steps['cloudscale-enable']?.status, 'existing');
  // A second --next does not probe the closed gate again.
  const probes = c.restCalls.filter((call) => call.endsWith('/table')).length;
  const c2 = cap();
  c2.io.rest = c.io.rest;
  assert.equal(await provisionCli(['--out', out, '--next', ...SCOPE], c2.io), 0);
  assert.equal((lastJson(c2.out()).step as { id: string }).id, 'auth-hosted');
  assert.equal(c.restCalls.filter((call) => call.endsWith('/table')).length, probes);
  rmSync(out, { recursive: true, force: true });
});

test('--next stops at an unverified gate with the guided step, as before', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-gate-next-unknown-'));
  writeGatePlan(out, ['slate']);
  const c = cap();
  c.io.rest = guardedRest(async () => ({ status: 500, body: { status: 'failure', data: { message: 'internal error' } } }));
  assert.equal(await provisionCli(['--out', out, '--next', ...SCOPE], c.io), 0);
  const next = lastJson(c.out()) as { done: boolean; step: { id: string }; instructions: string };
  assert.equal(next.done, false);
  assert.equal(next.step.id, 'slate-enable');
  assert.match(next.instructions, /Slate → Start Exploring/);
  assert.match(next.instructions, /c2c provision --record slate-enable/);
  assert.equal(readState(out).steps['slate-enable'], undefined, 'an unverified gate must stay open');
  rmSync(out, { recursive: true, force: true });
});

test('an open first-use gate before a cli step is verified by its probe and the run continues', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-gate-auto-'));
  writeGatePlan(out, ['cloudscale']);
  const c = cap();
  c.io.rest = guardedRest(async (call) => {
    c.restCalls.push(`${call.method} ${call.path}`);
    if (call.method === 'GET' && call.path === `/baas/v1/project/${PROJECT}/table`) return OPEN_SHAPES.cloudscale;
    if (call.method === 'POST' && call.path.includes('/authentication/enable')) return { status: 200, body: { data: { hosted_auth: true } } };
    return { status: 500, body: {} };
  });
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'auth-hosted', ...SCOPE], c.io), 0, c.err());
  assert.equal(readState(out).steps['cloudscale-enable']?.status, 'existing');
  assert.equal(readState(out).steps['auth-hosted']?.status, 'done');
  // A verified gate is not probed again on the next run.
  const before = c.restCalls.filter((call) => call.endsWith('/table')).length;
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'auth-hosted', ...SCOPE], c.io), 0, c.err());
  assert.equal(c.restCalls.filter((call) => call.endsWith('/table')).length, before);
  rmSync(out, { recursive: true, force: true });
});

test('an unrecognised probe answer is never read as an open gate', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-gate-unknown-'));
  writeGatePlan(out, ['slate']);
  const c = cap();
  c.io.rest = guardedRest(async () => ({ status: 500, body: { status: 'failure', data: { message: 'internal error' } } }));
  assert.equal(await provisionCli(['--out', out, '--record', 'slate-enable', ...SCOPE], c.io), 1);
  assert.match(c.err(), /Slate first-use gate could not be verified/);
  assert.equal(readState(out).steps['slate-enable'], undefined);
  rmSync(out, { recursive: true, force: true });
});

test('a 4xx saying the resource "does not exist" is not treated as already-there', async () => {
  const out = writeMiniPlan();
  let outLog = '';
  const io: Io = {
    stdout: (text) => {
      outLog += text;
    },
    stderr: (text) => {
      outLog += text;
    },
    env: {},
    rest: guardedRest(async (call: RestCall) => {
      if (call.method === 'POST' && call.path.endsWith('/authentication/enable?auth_type=hosted')) {
        return { status: 409, body: { data: { message: 'hosted auth does not exist for this project' } } };
      }
      return { status: 404, body: {} };
    }),
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: async () => {
      throw new Error('fetch is never allowed in provision');
    },
  };
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'auth-hosted', ...SCOPE], io), 1);
  assert.match(outLog, /failed|409/);
  rmSync(out, { recursive: true, force: true });
});

/** Run `auth-hosted` against a rest that answers the POST with `reply`. */
async function runAuthHosted(out: string, reply: { status: number; body: unknown }): Promise<{ code: number; log: string }> {
  let log = '';
  const io: Io = {
    stdout: (text) => {
      log += text;
    },
    stderr: (text) => {
      log += text;
    },
    env: {},
    rest: guardedRest(async (call: RestCall) => {
      if (call.method === 'POST' && call.path.endsWith('/authentication/enable?auth_type=hosted')) return reply;
      return { status: 404, body: {} };
    }),
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: async () => {
      throw new Error('fetch is never allowed in provision');
    },
  };
  const code = await provisionCli(['--out', out, '--confirm', '--run', 'auth-hosted', ...SCOPE], io);
  return { code, log };
}

test('a cli step closes only on proof: a refusal or a failure envelope keeps it open', async () => {
  const out = writeMiniPlan();
  // A 400 that only looks like "exists" text is a refusal, not an already-there claim.
  const nonExistent = await runAuthHosted(out, { status: 400, body: { message: 'non-existent authentication type' } });
  assert.equal(nonExistent.code, 1);
  assert.match(nonExistent.log, /failed/);
  assert.equal(readState(out).steps['auth-hosted'], undefined);
  const invalid = await runAuthHosted(out, { status: 400, body: { message: 'cannot modify existing configuration: invalid value' } });
  assert.equal(invalid.code, 1);
  assert.match(invalid.log, /failed/);
  assert.equal(readState(out).steps['auth-hosted'], undefined);
  // A 200 failure envelope is not a successful run either.
  const failed = await runAuthHosted(out, { status: 200, body: { status: 'failure', data: { message: 'refused' } } });
  assert.equal(failed.code, 1);
  assert.match(failed.log, /failure/);
  assert.equal(readState(out).steps['auth-hosted'], undefined);
  rmSync(out, { recursive: true, force: true });
});

test('an already-there 4xx closes only when the answer proves the read-back match', async () => {
  const out = writeMiniPlan();
  // A duplicate answer that carries no auth flag is a claim, not proof: the
  // step stays open until a read-back is recorded.
  const claim = await runAuthHosted(out, { status: 409, body: { data: { error_code: 'DUPLICATE', message: 'already enabled' } } });
  assert.equal(claim.code, 0, claim.log);
  const claimJson = lastJson(claim.log);
  assert.equal(claimJson.status, 'applied');
  assert.equal(claimJson.verified, false);
  assert.match(String(claimJson.next), /read-back/);
  assert.equal(readState(out).steps['auth-hosted']?.status, 'applied');
  // Recording the real read-back then closes the step as existing.
  const auth = writeResult(out, 'auth-hosted-rb', { status: 'success', data: { status: 'success', data: { hosted_auth: true, embedded_auth: false } } });
  const c = cap();
  assert.equal(await provisionCli(['--out', out, '--record', 'auth-hosted', '--result', auth, ...SCOPE], c.io), 0, c.err());
  assert.equal(readState(out).steps['auth-hosted']?.status, 'existing');
  rmSync(out, { recursive: true, force: true });

  // An already-there answer that echoes the flag is its own proof.
  const out2 = writeMiniPlan();
  const proof = await runAuthHosted(out2, { status: 409, body: { data: { message: 'already enabled', hosted_auth: true } } });
  assert.equal(proof.code, 0, proof.log);
  assert.equal(lastJson(proof.log).status, 'existing');
  assert.equal(readState(out2).steps['auth-hosted']?.status, 'existing');
  rmSync(out2, { recursive: true, force: true });
});

test('an already-there 4xx inside a failure envelope is a claim, not a fatal error', async (t) => {
  const out = writeMiniPlan();
  t.after(() => rmSync(out, { recursive: true, force: true }));
  // The recorded duplicate shape: HTTP 409 whose body is the failure envelope
  // with the DUPLICATE_ENTRY error_code — it must not abort the run.
  const dup = await runAuthHosted(out, {
    status: 409,
    body: { status: 'failure', data: { message: 'hosted auth is already enabled', error_code: 'DUPLICATE_ENTRY' } },
  });
  assert.equal(dup.code, 0, dup.log);
  // No auth flag echoed: a claim stays open for the recorded read-back, and
  // the state write means a resumed run does not re-POST into the same 409.
  assert.equal(lastJson(dup.log).status, 'applied');
  assert.equal(readState(out).steps['auth-hosted']?.status, 'applied');
  const auth = writeResult(out, 'auth-hosted-rb', { status: 'success', data: { status: 'success', data: { hosted_auth: true, embedded_auth: false } } });
  const c = cap();
  assert.equal(await provisionCli(['--out', out, '--record', 'auth-hosted', '--result', auth, ...SCOPE], c.io), 0, c.err());
  assert.equal(readState(out).steps['auth-hosted']?.status, 'existing');
});

test('a non-duplicate 409 in a failure envelope still fails the run', async (t) => {
  const out = writeMiniPlan();
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const run = await runAuthHosted(out, { status: 409, body: { status: 'failure', data: { message: 'request conflicts with the current configuration' } } });
  assert.equal(run.code, 1);
  assert.match(run.log, /failure|409/);
  assert.equal(readState(out).steps['auth-hosted'], undefined);
});

test('crons: a 409 duplicate in the failure envelope is confirmed by the re-read, not fatal', async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-cron409-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  writeCronPlan(out);
  // The cron landed in an earlier run: the create answers the recorded 409
  // duplicate shape (status 'failure' envelope) and the re-read then finds it.
  let landed = false;
  const cronCalls: string[] = [];
  let log = '';
  const io: Io = {
    stdout: (text) => {
      log += text;
    },
    stderr: (text) => {
      log += text;
    },
    env: {},
    rest: guardedRest(async (call: RestCall) => {
      const path = call.path.slice(`/baas/v1/project/${PROJECT}`.length);
      cronCalls.push(`${call.method} ${path}`);
      if (call.method === 'GET' && path === '/job_scheduling/cron') {
        return { status: 200, body: { data: landed ? [{ cron_name: 'daily_report' }] : [] } };
      }
      if (call.method === 'POST' && path === '/job_scheduling/cron') {
        landed = true;
        return { status: 409, body: { status: 'failure', data: { message: 'cron already exists', error_code: 'DUPLICATE_ENTRY' } } };
      }
      return { status: 404, body: {} };
    }),
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: async () => {
      throw new Error('fetch is never allowed in provision');
    },
  };
  const code = await provisionCli(['--out', out, '--confirm', '--run', 'crons', ...SCOPE], io);
  assert.equal(code, 0, log);
  // The re-read ran after the duplicate answer and confirmed the cron's identity.
  assert.equal(cronCalls.filter((call) => call.startsWith('GET')).length, 2);
  assert.ok(['done', 'existing'].includes(readState(out).steps.crons?.status ?? ''), log);
});

const DUP_ENVELOPE = { status: 'failure', data: { message: 'already exists', error_code: 'DUPLICATE_ENTRY' } };

/**
 * A fake project-user/cron REST where the POST answers the recorded duplicate
 * failure envelope. `land` controls the resend: 'never' keeps the POST a 409
 * that creates nothing, 'second' lets the one resend apply the write.
 */
function dupEnvelopeRest(opts: {
  /** Rows the listing answers on GET number `read` (1 = the step's first list). */
  list: (read: number) => unknown[];
  land: 'never' | 'second' | 'resend-5xx';
  unreadableRead?: boolean;
  onStored?: () => void;
}): { rest: (call: RestCall) => Promise<RestResult>; calls: string[] } {
  const calls: string[] = [];
  let posts = 0;
  let reads = 0;
  return {
    calls,
    rest: guardedRest(async (call: RestCall): Promise<RestResult> => {
      calls.push(`${call.method} ${call.path}`);
      const isCron = call.path.endsWith('/job_scheduling/cron');
      const isUser = call.path.endsWith('/project-user');
      if (call.method === 'GET' && (isCron || isUser)) {
        reads++;
        if (opts.unreadableRead && reads > 1) return { status: 503, body: INTERNAL_500 };
        return { status: 200, body: { data: isUser ? { users: opts.list(reads) } : opts.list(reads) } };
      }
      if (call.method === 'POST' && (isCron || isUser)) {
        posts++;
        if (opts.land === 'resend-5xx' && posts === 2) return { status: 503, body: INTERNAL_500 };
        if (opts.land === 'second' && posts === 2) {
          opts.onStored?.();
          return { status: 200, body: { data: {} } };
        }
        return { status: 409, body: DUP_ENVELOPE };
      }
      return { status: 404, body: {} };
    }),
  };
}

function ioOf(rest: (call: RestCall) => Promise<RestResult>, log: { text: string }): Io {
  return {
    stdout: (text) => {
      log.text += text;
    },
    stderr: (text) => {
      log.text += text;
    },
    env: {},
    rest,
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: async () => {
      throw new Error('fetch is never allowed in provision');
    },
    sleep: async () => {},
  };
}

test('a duplicate-envelope re-read that finds nothing resends once, then fails closed — invite and cron', async (t) => {
  const email = 'person@example.test';

  // Cron: re-read absent, the one resend lands — the step closes as done.
  {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-cron-dup-absent-'));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    writeCronPlan(out);
    const crons: { cron_name: string }[] = [];
    const { rest, calls } = dupEnvelopeRest({ list: () => crons, land: 'second', onStored: () => crons.push({ cron_name: 'daily_report' }) });
    const log = { text: '' };
    const code = await provisionCli(['--out', out, '--confirm', '--run', 'crons', ...SCOPE], ioOf(rest, log));
    assert.equal(code, 0, log.text);
    assert.equal(calls.filter((call) => call.startsWith('POST')).length, 2, 'one resend, never more');
    assert.equal(readState(out).steps.crons?.status, 'done', log.text);
  }

  // Cron: re-read absent and the resend answers duplicate again while the
  // re-read still finds nothing — fail closed, the step stays open.
  {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-cron-dup-fail-'));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    writeCronPlan(out);
    const { rest, calls } = dupEnvelopeRest({ list: () => [], land: 'never' });
    const log = { text: '' };
    const code = await provisionCli(['--out', out, '--confirm', '--run', 'crons', ...SCOPE], ioOf(rest, log));
    assert.equal(code, 1, 'an unproven duplicate must not close the step');
    assert.match(log.text, /still finds nothing|did not land/);
    assert.equal(calls.filter((call) => call.startsWith('POST')).length, 2, 'exactly one resend');
    assert.equal(readState(out).steps.crons, undefined, 'the step stays open');
  }

  // Cron: an unreadable re-read aborts — no resend at all.
  {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-cron-dup-unread-'));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    writeCronPlan(out);
    const { rest, calls } = dupEnvelopeRest({ list: () => [], land: 'second', unreadableRead: true });
    const log = { text: '' };
    const code = await provisionCli(['--out', out, '--confirm', '--run', 'crons', ...SCOPE], ioOf(rest, log));
    assert.equal(code, 1, 'an unreadable re-read aborts');
    assert.match(log.text, /re-read refused/);
    assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1, 'no resend on an unreadable re-read');
  }

  // Invite: the re-read finds the user — the landed invite is adopted.
  {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-user-dup-found-'));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    writeUsersPlan(out, email);
    const users = [{ email_id: email, role_id: '5002' }];
    // The first list is empty; the invite lands despite the duplicate answer,
    // so the re-read list carries it.
    const { rest, calls } = dupEnvelopeRest({ list: (read) => (read === 1 ? [] : users), land: 'never' });
    const log = { text: '' };
    const code = await provisionCli(['--out', out, '--confirm', '--run', 'app-users', ...SCOPE], ioOf(rest, log));
    assert.equal(code, 0, log.text);
    assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1, 'a found invite is never resent');
  }

  // Invite: re-read absent, the one resend lands.
  {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-user-dup-absent-'));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    writeUsersPlan(out, email);
    const users: { email_id: string; role_id: string }[] = [];
    const { rest, calls } = dupEnvelopeRest({ list: () => users, land: 'second', onStored: () => users.push({ email_id: email, role_id: '5002' }) });
    const log = { text: '' };
    const code = await provisionCli(['--out', out, '--confirm', '--run', 'app-users', ...SCOPE], ioOf(rest, log));
    assert.equal(code, 0, log.text);
    assert.equal(calls.filter((call) => call.startsWith('POST')).length, 2, 'one resend, never more');
    assert.equal(readState(out).steps['app-users']?.status, 'done', log.text);
  }

  // Invite: absent re-read, resent duplicate, still-absent re-read — fail closed.
  {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-user-dup-fail-'));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    writeUsersPlan(out, email);
    const { rest, calls } = dupEnvelopeRest({ list: () => [], land: 'never' });
    const log = { text: '' };
    const code = await provisionCli(['--out', out, '--confirm', '--run', 'app-users', ...SCOPE], ioOf(rest, log));
    assert.equal(code, 1, 'an unproven duplicate must not close the step');
    assert.match(log.text, /still finds nothing|did not land/);
    assert.equal(calls.filter((call) => call.startsWith('POST')).length, 2, 'exactly one resend');
    assert.equal(readState(out).steps['app-users'], undefined, 'the step stays open');
  }

  // Invite: an unreadable re-read aborts — no resend.
  {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-user-dup-unread-'));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    writeUsersPlan(out, email);
    const { rest, calls } = dupEnvelopeRest({ list: () => [], land: 'second', unreadableRead: true });
    const log = { text: '' };
    const code = await provisionCli(['--out', out, '--confirm', '--run', 'app-users', ...SCOPE], ioOf(rest, log));
    assert.equal(code, 1, 'an unreadable re-read aborts');
    assert.match(log.text, /re-read refused/);
    assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1, 'no resend on an unreadable re-read');
  }

  // A transient resend failure cannot start another retry cycle. Both write
  // shapes retain the two-POST ceiling and leave the step unrecorded.
  for (const step of ['crons', 'app-users'] as const) {
    const out = mkdtempSync(join(tmpdir(), `c2c-prov-${step}-dup-5xx-`));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    if (step === 'crons') writeCronPlan(out);
    else writeUsersPlan(out, email);
    const { rest, calls } = dupEnvelopeRest({ list: () => [], land: 'resend-5xx' });
    const log = { text: '' };
    const code = await provisionCli(['--out', out, '--confirm', '--run', step, ...SCOPE], ioOf(rest, log));
    assert.equal(code, 1, log.text);
    assert.equal(calls.filter((call) => call.startsWith('POST')).length, 2, `${step}: no third POST after resend 5xx`);
    assert.equal(readState(out).steps[step], undefined, `${step}: step stays open`);
  }
});

test('a project read-back that matches more than one entry is refused, not picked from', async () => {
  const out = writeMiniPlan();
  const c = cap();
  // A same-named pair (here the same row listed twice) must never let the
  // run learn whichever id came last.
  const dup = writeResult(out, 'project-dup', mcpRows([
    { id: PROJECT, project_name: 'c2c-widget' },
    { id: PROJECT, project_name: 'c2c-widget' },
  ]));
  const code = await provisionCli(['--out', out, '--record', 'project', '--result', dup, ...SCOPE], c.io);
  assert.equal(code, 1);
  assert.match(c.err(), /more than one/);
  assert.equal(readState(out).steps.project, undefined);
  assert.equal(readState(out).learned.projectId, undefined);
  // A unique entry records and learns the id.
  const one = writeResult(out, 'project-one', mcpRows([{ id: PROJECT, project_name: 'c2c-widget' }]));
  assert.equal(await provisionCli(['--out', out, '--record', 'project', '--result', one, ...SCOPE], c.io), 0, c.err());
  assert.equal(readState(out).steps.project?.status, 'existing');
  assert.equal(readState(out).learned.projectId, PROJECT);
  rmSync(out, { recursive: true, force: true });
});

/** A one-step plan with the app-users shape: emails live in provision/inputs.json. */
function writeUsersPlan(out: string, email: string): void {
  mkdirSync(join(out, 'provision'), { recursive: true });
  const plan: PlanFile = {
    version: 1,
    app: 'widget',
    steps: [
      {
        id: 'app-users',
        via: 'cli',
        command: 'c2c provision --confirm --run app-users',
        args: { invites: 1, spec: 'provision/inputs.json users[] ({email_id, role})' },
        readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Project_Users', match: { email_id: ['<user-emails>'] } },
      },
    ],
  };
  writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(join(out, 'provision', 'inputs.json'), `${JSON.stringify({ slateDomain: 'app.example.test', users: [{ email_id: email, role_id: '5002' }] }, null, 2)}\n`);
}

test('emails never reach --next/--run output, state.json, learned ids or the stored result', async () => {
  const email = 'person@example.com';
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-pii-'));
  writeUsersPlan(out, email);
  const sandbox = emptySandbox();

  // --next prints the placeholder, not the address.
  const next = cap(sandbox);
  assert.equal(await provisionCli(['--out', out, '--next', ...SCOPE], next.io), 0);
  assert.ok(!next.out().includes(email), '--next must not print the email');
  assert.ok(!next.out().includes('@'), '--next must not print an address at all');
  assert.match(next.out(), /<user-emails>/);

  // --run performs the real call internally but prints placeholders only.
  const run = cap(sandbox);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'app-users', ...SCOPE], run.io), 0, run.err());
  assert.ok(!run.out().includes(email), '--run must not print the email');
  assert.ok(!run.out().includes('@'), '--run must not print an address at all');
  assert.equal(sandbox.users.length, 1, 'the invite used the real email internally');
  const runResult = readFileSync(join(out, 'provision', 'results', 'app-users.run.json'), 'utf8');
  assert.ok(!runResult.includes(email), 'the run result must not store the email');

  // --record stores the host's read-back — redacted.
  const rb = writeResult(out, 'users-rb', mcpRows([{ user_id: '7001', email_id: email, role_id: '5002' }]));
  const rec = cap(sandbox);
  assert.equal(await provisionCli(['--out', out, '--record', 'app-users', '--result', rb, ...SCOPE], rec.io), 0, rec.err());
  const stored = readFileSync(join(out, 'provision', 'results', 'app-users.json'), 'utf8');
  assert.ok(!stored.includes(email), 'stored result must not carry the email');
  assert.ok(!stored.includes('@'), 'stored result must not carry an address at all');
  assert.ok(!stored.includes('email_id'), 'stored result drops the email field entirely');
  assert.ok(!stored.includes('user_id'), 'stored result drops the person id');
  const stateRaw = readFileSync(join(out, 'provision', 'state.json'), 'utf8');
  assert.ok(!stateRaw.includes('@'), 'state.json must not carry an address');
  assert.equal(readState(out).learned.byName[email], undefined, 'email_id is not a learned resource name');
  rmSync(out, { recursive: true, force: true });
});

test('--record redacts tokens, urls and secret-named values in the stored result file', async () => {
  const out = writeMiniPlan();
  const c = cap();
  const dirty = writeResult(out, 'project', {
    status: 'success',
    data: {
      status: 'success',
      data: [
        {
          project_name: 'c2c-widget',
          id: PROJECT,
          note: 'token was 1000.abcdef0123456789abcdef0123456789',
          client_secret: 'shh-secret',
          contact: 'person@example.com',
        },
      ],
    },
    hint: 'token was 1000.abcdef0123456789abcdef0123456789',
    redirect: 'https://accounts.example.com/oauth/callback?state=abc',
    nested: { client_secret: 'shh-secret', authorization: 'Bearer abcdef123456', contact: 'person@example.com' },
  });
  assert.equal(await provisionCli(['--out', out, '--record', 'project', '--result', dirty, ...SCOPE], c.io), 0, c.err());
  const stored = readFileSync(join(out, 'provision', 'results', 'project.json'), 'utf8');
  assert.ok(!stored.includes('1000.'), 'no token-shaped value');
  assert.ok(!stored.includes('https://'), 'no URL');
  assert.ok(!stored.includes('@'), 'no email');
  assert.ok(!stored.includes('shh-secret'), 'no secret value');
  assert.ok(!stored.includes('abcdef123456'), 'no bearer value');
  assert.match(stored, /<redacted>|<token>|<url>|<email>/);
  const stateRaw = readFileSync(join(out, 'provision', 'state.json'), 'utf8');
  assert.ok(!stateRaw.includes('@') && !stateRaw.includes('https://') && !stateRaw.includes('1000.'));
  rmSync(out, { recursive: true, force: true });
});

test('--record project: the project listing is reduced to the target entry and no other project reaches disk', async () => {
  const out = writeMiniPlan();
  const c = cap();
  // A hand-supplied project listing carrying every project in the org, each
  // entry with fields a consumer must never keep.
  const raw = writeResult(out, 'project', {
    status: 'success',
    data: {
      status: 'success',
      data: [
        {
          id: '10000000000000099',
          project_name: 'other-app',
          jwtSecret: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5OTkifQ.c2lnbmF0dXJl',
          clientId: 'cid-other-canary',
          clientSecret: 'css-other-canary',
          authentication: { oauth: { client_secret: 'nested-secret-canary', redirect: 'https://other.example.test/cb' } },
        },
        {
          id: PROJECT,
          project_name: 'c2c-widget',
          jwtSecret: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.b3RoZXI',
          clientId: 'cid-target-canary',
          clientSecret: 'css-target-canary',
          auth: { bearer: 'Bearer target-bearer-canary' },
        },
      ],
    },
  });
  // The sanitized read-back still matches the plan's project name + id.
  assert.equal(await provisionCli(['--out', out, '--record', 'project', '--result', raw, ...SCOPE], c.io), 0, c.err());
  const stored = JSON.parse(readFileSync(join(out, 'provision', 'results', 'project.json'), 'utf8')) as {
    data: { data: Record<string, unknown>[] };
  };
  assert.deepEqual(stored.data.data, [{ id: PROJECT, project_name: 'c2c-widget' }]);
  assert.equal(readState(out).learned.projectId, PROJECT);
  // No secret field name, secret value or other-project identity exists in any written file.
  const blob = readdirSync(out, { recursive: true })
    .map(String)
    .map((rel) => (statSync(join(out, rel)).isFile() ? readFileSync(join(out, rel), 'utf8') : ''))
    .join('\n');
  for (const canary of [
    'other-app',
    '10000000000000099',
    'jwtSecret',
    'clientId',
    'clientSecret',
    'client_secret',
    'cid-other-canary',
    'css-other-canary',
    'nested-secret-canary',
    'cid-target-canary',
    'css-target-canary',
    'target-bearer-canary',
    'c2lnbmF0dXJl',
    'b3RoZXI',
    'other.example.test',
  ]) {
    assert.ok(!blob.includes(canary), `written files carry ${canary}`);
  }
  rmSync(out, { recursive: true, force: true });
});

test('a corrupt provision/state.json refuses instead of silently resetting', async () => {
  const out = writeMiniPlan();
  const c = cap();
  const project = writeResult(out, 'project', mcpRows([{ id: PROJECT, project_name: 'c2c-widget' }]));
  assert.equal(await provisionCli(['--out', out, '--record', 'project', '--result', project, ...SCOPE], c.io), 0);
  writeFileSync(join(out, 'provision', 'state.json'), '{ not json');
  const c2 = cap();
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], c2.io), 1);
  assert.match(c2.err(), /corrupt|unreadable/i);
  rmSync(out, { recursive: true, force: true });
});

test('a changed pinned side file refuses a resumed state', async () => {
  const out = writeMiniPlan();
  const c = cap();
  const project = writeResult(out, 'project', mcpRows([{ id: PROJECT, project_name: 'c2c-widget' }]));
  assert.equal(await provisionCli(['--out', out, '--record', 'project', '--result', project, ...SCOPE], c.io), 0);
  // tables.json is folded into the pin; rewriting it must refuse like a plan change.
  writeFileSync(join(out, 'provision', 'tables.json'), '[]\n');
  const c2 = cap();
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], c2.io), 1);
  assert.match(c2.err(), /changed/i);
  rmSync(out, { recursive: true, force: true });
});

test('--run refuses with no data centre from any source', async () => {
  const out = writeMiniPlan();
  const sandbox = emptySandbox();
  const c = cap(sandbox);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'tables', '--org', ORG, '--project', PROJECT], c.io), 2);
  assert.match(c.err(), /data centre|--dc/i);
  assert.equal(c.restCalls.length, 0, 'no REST call without a DC');
  rmSync(out, { recursive: true, force: true });
});

// --- redaction order, error echo, inputs pinning, per-table grants ---

test('redactEvidence: a URL keeps no userinfo/query secret; JWT, Basic/Bearer and secret-keyed subtrees mask', () => {
  const text = JSON.stringify(
    redactEvidence({
      // Regression: the email pass ran before the URL pass, so the '@' cut the URL
      // short and the query secret survived verbatim.
      auth_url: 'https://admin:hunter2pw@connector.example.test/x?k=s3cr3tq',
      invite: 'see https://app.test/i?email=canary@example.test&token=t0kcanary now',
      blob: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      scheme: 'Basic YWRtaW46aHVudGVyMg==',
      note: 'Bearer zzz-yyy-xxx-token',
      // the secret-named key is the parent; the leaf key "value" is not secret-named
      pw: { value: 'hunter2pw' },
      deep: { nested: { api_key: 'kkk-canary' } },
      plain: 'kept',
    }),
  );
  for (const canary of [
    'hunter2pw',
    'connector.example.test',
    's3cr3tq',
    'canary@example.test',
    't0kcanary',
    'c2lnbmF0dXJl',
    'YWRtaW46aHVudGVyMg',
    'zzz-yyy-xxx',
    'kkk-canary',
  ]) {
    assert.ok(!text.includes(canary), `redaction leaks ${canary}: ${text}`);
  }
  assert.match(text, /kept/);
});

test('a stored result carries no url-with-userinfo, jwt or credential string', async () => {
  const out = writeMiniPlan();
  const c = cap();
  const dirty = writeResult(out, 'project', {
    ...mcpRows([{ id: PROJECT, project_name: 'c2c-widget' }]) as object,
    invite: 'https://admin:hunter2pw@connector.example.test/x?k=s3cr3tq',
    token_line: 'Basic YWRtaW46aHVudGVyMg==',
  });
  assert.equal(await provisionCli(['--out', out, '--record', 'project', '--result', dirty, ...SCOPE], c.io), 0, c.err());
  const stored = readFileSync(join(out, 'provision', 'results', 'project.json'), 'utf8');
  for (const canary of ['hunter2pw', 's3cr3tq', 'connector.example.test', 'YWRtaW46aHVudGVyMg']) {
    assert.ok(!stored.includes(canary), `stored result leaks ${canary}`);
  }
  rmSync(out, { recursive: true, force: true });
});

test('a failing REST body is echoed to stderr redacted — no email, token or url', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-err-'));
  writeUsersPlan(out, 'person@example.com');
  const canaryBody = 'invalid email canary.user@example.test token 1000.c4n4ryt0k3nabcdef0123456789 at https://admin:hunter2pw@connector.example.test/x?k=s3cr3tq';
  const c = cap();
  c.io.rest = guardedRest(async (call: RestCall): Promise<RestResult> =>
    call.method === 'GET' ? { status: 200, body: { data: { users: [] } } } : { status: 400, body: { data: { message: canaryBody } } },
  );
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'app-users', ...SCOPE], c.io), 1);
  for (const canary of ['canary.user@example.test', 'c4n4ryt0k3n', 'hunter2pw', 'connector.example.test', 's3cr3tq']) {
    assert.ok(!c.err().includes(canary), `stderr leaks ${canary}: ${c.err()}`);
  }
  assert.match(c.err(), /<email>|<url>|<token>/);
  rmSync(out, { recursive: true, force: true });
});

test('app-users invites carry redirect_url = the Slate app URL; without a host the run refuses', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-redir-'));
  writeUsersPlan(out, 'person@example.test');
  // The invite mail's link defaults to a page that does not exist when
  // redirect_url is missing — the run refuses before any write goes out.
  writeFileSync(join(out, 'provision', 'inputs.json'), JSON.stringify({ users: [{ email_id: 'person@example.test', role_id: '5002' }] }));
  const noHost = cap(emptySandbox());
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'app-users', ...SCOPE], noHost.io), 1);
  assert.match(noHost.err(), /redirect_url/);
  assert.equal(noHost.restCalls.filter((call) => call.startsWith('POST')).length, 0);

  // --domain (or inputs.json slateDomain) resolves it: the invite body carries
  // the Slate app URL.
  const bodies: unknown[] = [];
  const withHost = cap();
  withHost.io.rest = guardedRest(async (call) => {
    if (call.method === 'POST') bodies.push(call.body);
    return call.method === 'GET' ? { status: 200, body: { data: { users: [] } } } : { status: 200, body: { data: { user_id: '7001' } } };
  });
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'app-users', '--domain', 'app.example.test', ...SCOPE], withHost.io), 0, withHost.err());
  assert.deepEqual(
    bodies.map((body) => (body as { redirect_url?: string }).redirect_url),
    ['https://app.example.test'],
  );
  rmSync(out, { recursive: true, force: true });
});

test('a failing cli read-back echoes a redacted body, and a failed catalyst child echoes redacted output', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-errrb-'));
  mkdirSync(join(out, 'provision'), { recursive: true });
  const plan: PlanFile = {
    version: 1,
    app: 'widget',
    steps: [
      {
        id: 'connections',
        via: 'console',
        command: 'connect zcrm',
        args: { integrations: ['zcrm'] },
        readBack: { via: 'cli', command: 'x', args: { call: { method: 'GET', path: '/baas/v1/project/<project>/connections' } }, match: { link_name: ['zcrm'] } },
      },
      {
        id: 'apig-enable',
        via: 'cli',
        command: 'catalyst apig:enable',
        args: { argv: ['apig:enable'] },
        readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_API_route', match: { routes: ['x'] } },
      },
    ],
  };
  writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  const bad = cap();
  bad.io.rest = async (): Promise<RestResult> => ({ status: 500, body: { data: { message: 'boom 1000.c4n4ryt0k3nabcdef https://admin:hunter2pw@connector.example.test canary.user@example.test' } } });
  assert.equal(await provisionCli(['--out', out, '--record', 'connections', ...SCOPE], bad.io), 1);
  for (const canary of ['canary.user@example.test', 'c4n4ryt0k3n', 'hunter2pw', 'connector.example.test']) {
    assert.ok(!bad.err().includes(canary), `read-back stderr leaks ${canary}: ${bad.err()}`);
  }
  const spawned = cap();
  spawned.io.spawn = async () => ({ code: 1, stdout: '', stderr: 'failed: token 1000.c4n4ryt0k3nabcdef for canary.user@example.test' });
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'apig-enable', ...SCOPE], spawned.io), 1);
  for (const canary of ['canary.user@example.test', 'c4n4ryt0k3n']) {
    assert.ok(!spawned.err().includes(canary), `spawn stderr leaks ${canary}: ${spawned.err()}`);
  }
  rmSync(out, { recursive: true, force: true });
});

test('inputs.json is customer input: filling it after the first record is allowed; a changed consumed input reopens the step', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-inputs-'));
  mkdirSync(join(out, 'provision'), { recursive: true });
  const plan: PlanFile = {
    version: 1,
    app: 'widget',
    steps: [
      {
        id: 'project',
        via: 'console',
        command: 'create the project',
        args: { name: 'c2c-widget' },
        readBack: { via: 'cli', command: 'c2c provision --record project', match: { project_name: 'c2c-widget', id: '<project>' } },
      },
      {
        id: 'app-users',
        via: 'cli',
        command: 'c2c provision --confirm --run app-users',
        args: { invites: 1, spec: 'provision/inputs.json users[]' },
        readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Project_Users', match: { email_id: ['<user-emails>'] } },
      },
    ],
  };
  writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  // The documented flow: c2c plan writes inputs.json empty; the customer fills it.
  writeFileSync(join(out, 'provision', 'inputs.json'), '{ "slateDomain": "", "senderEmail": "", "users": [] }\n');

  const c = cap();
  const project = writeResult(out, 'project', mcpRows([{ id: PROJECT, project_name: 'c2c-widget' }]));
  assert.equal(await provisionCli(['--out', out, '--record', 'project', '--result', project, ...SCOPE], c.io), 0, c.err());

  // Filling inputs.json after a record must not refuse every later step.
  writeFileSync(join(out, 'provision', 'inputs.json'), JSON.stringify({ slateDomain: 'app.example.test', users: [{ email_id: 'a@example.test', role_id: '5002' }] }));
  const status = cap();
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], status.io), 0, status.err());
  const next = cap();
  assert.equal(await provisionCli(['--out', out, '--next', ...SCOPE], next.io), 0, next.err());
  assert.equal((lastJson(next.out()).step as { id: string }).id, 'app-users');

  // Record app-users, then change the users list — only that step reopens.
  const sandbox = emptySandbox();
  const run = cap(sandbox);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'app-users', ...SCOPE], run.io), 0, run.err());
  const rb = writeResult(out, 'users-rb', mcpRows([{ user_id: '7001', email_id: 'a@example.test', role_id: '5002' }]));
  assert.equal(await provisionCli(['--out', out, '--record', 'app-users', '--result', rb, ...SCOPE], run.io), 0, run.err());
  assert.equal(readState(out).steps['app-users']?.status, 'done');

  // An input this step does not consume changes nothing.
  writeFileSync(
    join(out, 'provision', 'inputs.json'),
    JSON.stringify({ slateDomain: 'app.example.test', senderEmail: 's@example.test', users: [{ email_id: 'a@example.test', role_id: '5002' }] }),
  );
  const same = cap();
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], same.io), 0, same.err());
  assert.equal(readState(out).steps['app-users']?.status, 'done', 'an unconsumed input change must not reopen a step');

  // A consumed input changed: the stored read-back no longer proves the match.
  writeFileSync(
    join(out, 'provision', 'inputs.json'),
    JSON.stringify({ slateDomain: 'app.example.test', users: [{ email_id: 'a@example.test', role_id: '5002' }, { email_id: 'b@example.test', role_id: '5002' }] }),
  );
  const changed = cap();
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], changed.io), 0, changed.err());
  assert.equal(readState(out).steps['app-users'], undefined, 'a changed input must reopen the recorded step');
  assert.match(changed.err(), /reopen|changed/i);
  const reopenedNext = cap();
  assert.equal(await provisionCli(['--out', out, '--next', ...SCOPE], reopenedNext.io), 0);
  assert.equal((lastJson(reopenedNext.out()).step as { id: string }).id, 'app-users');
  rmSync(out, { recursive: true, force: true });
});

test('matchReadBack row spec: per-(table, role) binding and exact permission sets', () => {
  // The plan keys each grant row by the resolved table id.
  const rows = [
    { table_id: '9000', 'App User': ['SELECT', 'INSERT'], 'App Administrator': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
    { table_id: '9001', 'App User': ['SELECT'] },
  ];
  assert.equal(matchReadBack(rows, { '9000': { 'App User': ['SELECT', 'INSERT'] }, '9001': { 'App User': ['SELECT'] } }).ok, true);
  // Cross-table: Order's INSERT must not satisfy Item's row.
  assert.equal(matchReadBack(rows, { '9000': { 'App User': ['SELECT'] }, '9001': { 'App User': ['SELECT', 'INSERT'] } }).ok, false);
  // Over-grant is a mismatch — Update_Table_Permissions replaces the set — and the report names what to remove.
  const over = matchReadBack([{ table_id: '9000', 'App User': ['SELECT', 'INSERT', 'DELETE'] }], { '9000': { 'App User': ['SELECT', 'INSERT'] } });
  assert.equal(over.ok, false);
  assert.match(over.missing.join(' '), /extra.*DELETE/);
  // A granted/denied object is not a permission list.
  assert.equal(matchReadBack([{ table_id: '9000', 'App User': { granted: ['SELECT'], denied: ['INSERT'] } }], { '9000': { 'App User': ['SELECT', 'INSERT'] } }).ok, false);
  // A scope read-back may arrive as a scalar — the set is still exact.
  assert.equal(matchReadBack([{ table_id: '9000', 'App User': 'GLOBAL' }], { '9000': { 'App User': ['GLOBAL'] } }).ok, true);
  // A map keyed by the id binds as a row too.
  assert.equal(matchReadBack({ data: { '9000': { 'App User': ['SELECT'] } } }, { '9000': { 'App User': ['SELECT'] } }).ok, true);
  // No row for the table at all fails closed.
  const absent = matchReadBack([{ table_id: '9001', 'App User': ['SELECT'] }], { '9000': { 'App User': ['SELECT'] } });
  assert.equal(absent.ok, false);
  assert.match(absent.missing[0]!, /9000/);
});

test('--record project without --result reads the project through the Catalyst CLI list: name and id only, no MCP project tool', async () => {
  const out = writeMiniPlan();
  const c = cap();
  const asked: string[] = [];
  // The fake CLI list answers the way listCatalystProjects does: {name, id} rows only.
  c.io.listProjects = async (org) => {
    asked.push(org);
    return [
      { name: 'other-app', id: '10000000000000099' },
      { name: 'c2c-widget', id: PROJECT },
    ];
  };
  assert.equal(await provisionCli(['--out', out, '--record', 'project', ...SCOPE], c.io), 0, c.err());
  assert.deepEqual(asked, [ORG]);
  assert.equal(readState(out).steps.project?.status, 'existing');
  const storedText = readFileSync(join(out, 'provision', 'results', 'project.json'), 'utf8');
  assert.deepEqual(JSON.parse(storedText), { data: [{ project_name: 'c2c-widget', id: PROJECT }] });
  // Nothing secret-looking reaches disk or the output.
  for (const text of [storedText, c.out(), c.err(), readFileSync(join(out, 'provision', 'state.json'), 'utf8')]) {
    assert.doesNotMatch(text, /secret|jwt|client_?id|token|List_All_Projects|Get_Project_By_Id/i);
  }
  assert.equal(c.restCalls.length, 0, 'the project read-back is the CLI list, not a project-scoped REST call');
  rmSync(out, { recursive: true, force: true });
});

test('--record project through the CLI list keeps the step open when the configured id is not listed', async () => {
  const out = writeMiniPlan();
  const c = cap();
  c.io.listProjects = async () => [{ name: 'c2c-widget', id: '10000000000000099' }];
  assert.equal(await provisionCli(['--out', out, '--record', 'project', ...SCOPE], c.io), 1);
  assert.equal(readState(out).steps.project, undefined);
  rmSync(out, { recursive: true, force: true });
});

test('a stale plan whose project read-back names an MCP project tool is refused — re-plan', async () => {
  for (const tool of ['CatalystbyZoho_List_All_Projects', 'CatalystbyZoho_Get_Project_By_Id']) {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-'));
    mkdirSync(join(out, 'provision'), { recursive: true });
    const stale = { ...MINI_PLAN, steps: MINI_PLAN.steps.map((step) => (step.id === 'project' ? { ...step, readBack: { via: 'mcp', tool, match: step.readBack.match } } : step)) };
    writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify(stale, null, 2)}\n`);
    const c = cap();
    assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], c.io), 2, c.err());
    assert.match(c.err(), /not one c2c plan emits/);
    rmSync(out, { recursive: true, force: true });
  }
});

// --- real Catalyst MCP response shapes: what each planner read-back must accept ---

test('project list: the nested data.data[] envelope matches name+id; the old {projects:[{name}]} shape does not', async () => {
  const out = writeMiniPlan();
  const c = cap();
  // The recorded operator shape: rows under data.data, keyed project_name/id.
  const real = writeResult(
    out,
    'project-rb',
    mcpRows([
      { project_name: 'other-app', id: '10000000000000099' },
      { project_name: 'c2c-widget', id: PROJECT, created_time: 'Oct 08, 2026 05:00 AM', project_type: 'Web' },
    ]),
  );
  assert.equal(await provisionCli(['--out', out, '--record', 'project', '--result', real, ...SCOPE], c.io), 0, c.err());
  assert.equal(readState(out).steps.project?.status, 'existing');
  // The listing reduces to the target entry before it is stored.
  const stored = JSON.parse(readFileSync(join(out, 'provision', 'results', 'project.json'), 'utf8')) as {
    data: { data: Record<string, unknown>[] };
  };
  assert.equal(stored.data.data.length, 1, 'the sibling project is dropped, not stored');
  assert.equal(stored.data.data[0]!.project_name, 'c2c-widget');

  // A same-named project under a different id is not the configured target.
  const out2 = writeMiniPlan();
  const c2 = cap();
  const wrongId = writeResult(out2, 'project-rb', mcpRows([{ project_name: 'c2c-widget', id: '10000000000000099' }]));
  assert.equal(await provisionCli(['--out', out2, '--record', 'project', '--result', wrongId, ...SCOPE], c2.io), 1);
  assert.equal(readState(out2).steps.project, undefined);
  // The legacy shape never counts.
  const legacy = writeResult(out2, 'project-legacy', { projects: [{ id: PROJECT, name: 'c2c-widget' }] });
  assert.equal(await provisionCli(['--out', out2, '--record', 'project', '--result', legacy, ...SCOPE], c2.io), 1);
  assert.equal(readState(out2).steps.project, undefined);
  rmSync(out, { recursive: true, force: true });
  rmSync(out2, { recursive: true, force: true });
});

test('a project row carrying created_by/modified_by leaves no person field in any written file', async () => {
  const out = writeMiniPlan();
  // The read-back input lives outside --out so only provision's own writes are scanned.
  const rbDir = mkdtempSync(join(tmpdir(), 'c2c-rb-'));
  const person = {
    first_name: 'Ada',
    last_name: 'Byron',
    email_id: 'ada.byron@example.test',
    user_id: '700000001',
    zuid: '800000001',
    phone: '+15550100',
  };
  const rb = writeResult(
    rbDir,
    'project-rb',
    mcpRows([
      {
        project_name: 'c2c-widget',
        id: PROJECT,
        created_time: 'Oct 08, 2026 05:00 AM',
        created_by: { ...person },
        modified_by: { ...person, user_type: 'admin' },
        project_domain_details: { project_domain_id: '6001', user_auth: { createdBy: '800000001' } },
      },
      { project_name: 'sibling-app', id: '10000000000000002', created_by: { ...person } },
    ]),
  );
  const c = cap();
  assert.equal(await provisionCli(['--out', out, '--record', 'project', '--result', rb, ...SCOPE], c.io), 0, c.err());
  // Every file provision wrote — results, state, plan, tables — holds no person value.
  const written: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else written.push(path);
    }
  };
  walk(out);
  for (const file of written) {
    const text = readFileSync(file, 'utf8');
    for (const value of ['Ada', 'Byron', 'ada.byron@example.test', '700000001', '800000001', '5550100']) {
      assert.ok(!text.includes(value), `${file} keeps a person field (${value})`);
    }
  }
  // The match evidence survives: project name and id are still stored.
  const stored = JSON.parse(readFileSync(join(out, 'provision', 'results', 'project.json'), 'utf8')) as {
    data: { data: Record<string, unknown>[] };
  };
  assert.equal(stored.data.data.length, 1);
  assert.equal(stored.data.data[0]!.project_name, 'c2c-widget');
  assert.equal(stored.data.data[0]!.id, PROJECT);
  rmSync(out, { recursive: true, force: true });
  rmSync(rbDir, { recursive: true, force: true });
});

test('a person row in a role read-back seeds neither the stored evidence nor state.json', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-person-'));
  const rbDir = mkdtempSync(join(tmpdir(), 'c2c-rb-'));
  writeStepPlan(out, {
    id: 'custom-roles',
    via: 'console',
    command: 'add the roles',
    args: { roles: ['Clerk'] },
    readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Roles', match: { role_name: ['Clerk'] } },
  });
  const c = cap();
  const rb = writeResult(
    rbDir,
    'roles-rb',
    mcpRows([
      {
        role_name: 'Clerk',
        role_id: '5009',
        created_by: { zuid: '800000001', first_name: 'Ada', last_name: 'Byron', email_id: 'ada.byron@example.test', user_id: '700000001' },
      },
      // A bare person row — its `name` is a person's name and `user_id` is not a learned id.
      { name: 'Ada Byron', user_id: '700000002', phone_number: '+15550100' },
    ]),
  );
  assert.equal(await provisionCli(['--out', out, '--record', 'custom-roles', '--result', rb, ...SCOPE], c.io), 0, c.err());
  const stored = readFileSync(join(out, 'provision', 'results', 'custom-roles.json'), 'utf8');
  const state = readFileSync(join(out, 'provision', 'state.json'), 'utf8');
  for (const text of [stored, state]) {
    for (const value of ['Ada', 'Byron', 'ada.byron@example.test', '700000001', '700000002', '800000001', '5550100']) {
      assert.ok(!text.includes(value), `a written file keeps a person field (${value})`);
    }
  }
  // The role's own name and id still match and learn.
  assert.ok(stored.includes('Clerk') && stored.includes('5009'), 'role evidence survives the person scrub');
  assert.equal(readState(out).learned.byName['Clerk'], '5009');
  rmSync(out, { recursive: true, force: true });
  rmSync(rbDir, { recursive: true, force: true });
});

test('List_All_Roles: required roles bind role_name rows; a missing role keeps custom-roles open', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-roles-'));
  writeStepPlan(out, {
    id: 'custom-roles',
    via: 'console',
    command: 'add the roles',
    args: { roles: ['Clerk', 'User'] },
    readBack: { via: 'mcp', tool: LIST_ROLES, match: { role_name: ['Clerk', 'User'] } },
  });
  const c = cap();
  const rows = ['App Administrator', 'App User', 'Developer', 'Moderator', 'Clerk', 'User'].map((role_name, i) => ({
    role_name,
    role_id: `500${i}`,
    user_id: `700${i}`,
    created_by: { zuid: '100', first_name: 'A', last_name: 'B', email_id: 'op@example.test' },
    created_time: 'Oct 08, 2026 05:00 AM',
  }));
  const real = writeResult(out, 'roles-rb', { status: 'success', data: { status: 'success', data: rows, more_records: false } });
  assert.equal(await provisionCli(['--out', out, '--record', 'custom-roles', '--result', real, ...SCOPE], c.io), 0, c.err());
  assert.equal(readState(out).steps['custom-roles']?.status, 'existing');
  // The stored evidence keeps no operator address.
  const stored = readFileSync(join(out, 'provision', 'results', 'custom-roles.json'), 'utf8');
  assert.ok(!stored.includes('@'), 'role rows carry a created_by email — it must be redacted');

  const out2 = mkdtempSync(join(tmpdir(), 'c2c-prov-roles2-'));
  writeStepPlan(out2, {
    id: 'custom-roles',
    via: 'console',
    command: 'add the roles',
    args: { roles: ['Clerk', 'User'] },
    readBack: { via: 'mcp', tool: LIST_ROLES, match: { role_name: ['Clerk', 'User'] } },
  });
  const c2 = cap();
  const absent = writeResult(out2, 'roles-rb', mcpRows(rows.filter((row) => row.role_name !== 'User')));
  assert.equal(await provisionCli(['--out', out2, '--record', 'custom-roles', '--result', absent, ...SCOPE], c2.io), 1);
  assert.equal(readState(out2).steps['custom-roles'], undefined);
  // Rows under a different field name never bind: `name` is not `role_name`.
  const wrongField = writeResult(out2, 'roles-wf', mcpRows([{ name: 'Clerk' }, { name: 'User' }]));
  assert.equal(await provisionCli(['--out', out2, '--record', 'custom-roles', '--result', wrongField, ...SCOPE], c2.io), 1);
  assert.equal(readState(out2).steps['custom-roles'], undefined);
  rmSync(out, { recursive: true, force: true });
  rmSync(out2, { recursive: true, force: true });
});

/**
 * A two-step plan: cli `tables` (learns ids) plus a console grant step of the
 * emitted shape — `table-permissions-console` or `table-scopes-console` —
 * whose read-back asks for two tables through args.calls.
 */
function writeGrantPlanWithCalls(out: string, kind: 'permissions' | 'scopes', grant: unknown): { stepId: string } {
  mkdirSync(join(out, 'provision'), { recursive: true });
  const stepId = `table-${kind}-console`;
  const tool = kind === 'permissions' ? GET_PERMS : 'CatalystbyZoho_Get_Table_Scopes';
  writeFileSync(
    join(out, 'provision', 'plan.json'),
    `${JSON.stringify(
      {
        version: 1,
        app: 'widget',
        steps: [
          {
            id: 'tables',
            via: 'cli',
            command: 'c2c provision --confirm --run tables',
            args: { plan: 'provision/tables.json', tables: ['Item', 'Order'] },
            readBack: { via: 'mcp', tool: LIST_TABLES, match: { table_name: ['Item', 'Order'] } },
          },
          {
            id: stepId,
            via: 'console',
            command: 'set the grants',
            args: { grants: [] },
            readBack: {
              via: 'mcp',
              tool,
              args: { calls: [{ path_variables: { id: '<id:Item>' } }, { path_variables: { id: '<id:Order>' } }] },
              match: { '<id:Item>': { 'App User': grant }, '<id:Order>': { 'App User': grant } },
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(out, 'provision', 'tables.json'),
    `${JSON.stringify([{ table: 'Item', form: 'Item', nosql: false, columns: [] }, { table: 'Order', form: 'Order', nosql: false, columns: [] }], null, 2)}\n`,
  );
  return { stepId };
}

test('Get_Table_Permissions: per-call envelopes bind positionally to args.calls table ids', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-grants-'));
  const { stepId } = writeGrantPlanWithCalls(out, 'permissions', ['SELECT', 'UPDATE']);
  const c = cap();
  const tables = writeResult(out, 'tables-rb', mcpRows([{ table_name: 'Item', table_id: '9000' }, { table_name: 'Order', table_id: '9001' }]));
  assert.equal(await provisionCli(['--out', out, '--record', 'tables', '--result', tables, ...SCOPE], c.io), 0, c.err());
  // Real shape: an array of one envelope per call — the rows carry role_name
  // and table_permissions, never the table id. Call order is args.calls order.
  const permRows = (perms: string[]): Record<string, unknown>[] => [
    { role_name: 'App Administrator', table_permissions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
    { role_name: 'App User', table_permissions: perms },
    { role_name: 'Administrator', table_permissions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], role_id: '5101' },
  ];
  const real = writeResult(out, 'perms-rb', [mcpRows(permRows(['SELECT', 'UPDATE'])), mcpRows(permRows(['SELECT', 'UPDATE']))]);
  assert.equal(await provisionCli(['--out', out, '--record', stepId, '--result', real, ...SCOPE], c.io), 0, c.err());
  assert.equal(readState(out).steps[stepId]?.status, 'existing');

  // An over-grant on the bound role fails and names the extra; a grant on the
  // wrong call's rows never satisfies the other table.
  const out2 = mkdtempSync(join(tmpdir(), 'c2c-prov-grants2-'));
  const g2 = writeGrantPlanWithCalls(out2, 'permissions', ['SELECT', 'UPDATE']);
  const c2 = cap();
  const tables2 = writeResult(out2, 'tables-rb', mcpRows([{ table_name: 'Item', table_id: '9000' }, { table_name: 'Order', table_id: '9001' }]));
  assert.equal(await provisionCli(['--out', out2, '--record', 'tables', '--result', tables2, ...SCOPE], c2.io), 0);
  const over = writeResult(out2, 'perms-rb', [mcpRows(permRows(['SELECT', 'UPDATE', 'DELETE'])), mcpRows(permRows(['SELECT', 'UPDATE']))]);
  assert.equal(await provisionCli(['--out', out2, '--record', g2.stepId, '--result', over, ...SCOPE], c2.io), 1);
  assert.match(c2.err(), /extra.*DELETE/);
  rmSync(out, { recursive: true, force: true });
  rmSync(out2, { recursive: true, force: true });
});

test('Get_Table_Scopes: role rows bind table_scope; only GLOBAL satisfies a GLOBAL spec', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-scopes-'));
  const { stepId } = writeGrantPlanWithCalls(out, 'scopes', ['GLOBAL']);
  const c = cap();
  const tables = writeResult(out, 'tables-rb', mcpRows([{ table_name: 'Item', table_id: '9000' }, { table_name: 'Order', table_id: '9001' }]));
  assert.equal(await provisionCli(['--out', out, '--record', 'tables', '--result', tables, ...SCOPE], c.io), 0, c.err());
  const scopeRows = (scope: string): Record<string, unknown>[] => [
    { role_name: 'App Administrator', table_scope: 'GLOBAL' },
    { role_name: 'App User', table_scope: scope },
  ];
  // ORG where GLOBAL is required stays open.
  const wrong = writeResult(out, 'scopes-rb', [mcpRows(scopeRows('ORG')), mcpRows(scopeRows('GLOBAL'))]);
  assert.equal(await provisionCli(['--out', out, '--record', stepId, '--result', wrong, ...SCOPE], c.io), 1);
  assert.equal(readState(out).steps[stepId], undefined);
  const good = writeResult(out, 'scopes-rb2', [mcpRows(scopeRows('GLOBAL')), mcpRows(scopeRows('GLOBAL'))]);
  assert.equal(await provisionCli(['--out', out, '--record', stepId, '--result', good, ...SCOPE], c.io), 0, c.err());
  assert.equal(readState(out).steps[stepId]?.status, 'existing');
  rmSync(out, { recursive: true, force: true });
});

test('List_All_Functions: the security-rule step binds the c2c_api row and requires is_authenticated', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-fn-'));
  writeStepPlan(out, {
    id: 'security-rule',
    via: 'console',
    command: 'set the rule',
    args: { rule: 'authentication required', function: 'c2c_api' },
    readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Functions', match: { c2c_api: { is_authenticated: true } } },
  });
  const c = cap();
  // The real row: name/api_name leaf binds the row spec; is_authenticated must be true.
  const real = writeResult(
    out,
    'fn-rb',
    mcpRows([
      { id: '4001', name: 'c2c_api', api_name: 'c2c_api', is_authenticated: true, authentication: [], type: 'standalone' },
      { id: '4002', name: 'other_fn', is_authenticated: false },
    ]),
  );
  assert.equal(await provisionCli(['--out', out, '--record', 'security-rule', '--result', real, ...SCOPE], c.io), 0, c.err());
  assert.equal(readState(out).steps['security-rule']?.status, 'existing');

  // is_authenticated false is a different function state — the rule stays open.
  const out2 = mkdtempSync(join(tmpdir(), 'c2c-prov-fn2-'));
  writeStepPlan(out2, {
    id: 'security-rule',
    via: 'console',
    command: 'set the rule',
    args: { rule: 'authentication required', function: 'c2c_api' },
    readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Functions', match: { c2c_api: { is_authenticated: true } } },
  });
  const c2 = cap();
  const off = writeResult(out2, 'fn-rb', mcpRows([{ id: '4001', name: 'c2c_api', is_authenticated: false }]));
  assert.equal(await provisionCli(['--out', out2, '--record', 'security-rule', '--result', off, ...SCOPE], c2.io), 1);
  assert.equal(readState(out2).steps['security-rule'], undefined);
  rmSync(out, { recursive: true, force: true });
  rmSync(out2, { recursive: true, force: true });
});

test('the generated security-rule step states the tool cannot read the rule itself', { skip: fixtureSkip }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-sr-'));
  const c = cap();
  // --project keeps the existing-project path whose console step this is.
  assert.equal(await planCli([L1_DS, '--out', out, '--dc', 'in', '--project', PROJECT], c.io), 0, c.err());
  const plan = JSON.parse(readFileSync(join(out, 'provision', 'plan.json'), 'utf8')) as PlanFile;
  const rule = plan.steps.find((step) => step.id === 'security-rule');
  assert.ok(rule);
  assert.equal(rule.via, 'console');
  assert.match(rule.command ?? '', /cannot read the rule itself|only exposes the function authentication/i);
  rmSync(out, { recursive: true, force: true });
});

test('the generated plan keys grant matches per table, not merged per role', { skip: fixtureSkip }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-plan-'));
  const c = cap();
  assert.equal(await planCli([L1_DS, '--out', out, '--dc', 'in'], c.io), 0);
  const plan = JSON.parse(readFileSync(join(out, 'provision', 'plan.json'), 'utf8')) as PlanFile;
  for (const step of plan.steps.filter((s) => /table-(permissions|scopes)/.test(s.id))) {
    const keys = Object.keys(step.readBack.match);
    assert.ok(keys.length > 1 || keys.every((key) => key.startsWith('<id:')), `${step.id}: match must be keyed per table, got ${keys.join(', ')}`);
    for (const [rowKey, spec] of Object.entries(step.readBack.match)) {
      assert.ok(rowKey.startsWith('<id:'), `${step.id}: match key "${rowKey}" is not a table id token`);
      assert.ok(spec && typeof spec === 'object' && !Array.isArray(spec), `${step.id}: "${rowKey}" must be a role→set row`);
    }
  }
  rmSync(out, { recursive: true, force: true });
});

test('a non-GET cli read-back is refused, not collapsed to POST', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-rb-'));
  mkdirSync(join(out, 'provision'), { recursive: true });
  const plan: PlanFile = {
    version: 1,
    app: 'widget',
    steps: [
      {
        id: 'sneaky',
        via: 'cli',
        command: 'x',
        args: {},
        readBack: { via: 'cli', command: 'x', args: { call: { method: 'DELETE', path: '/baas/v1/project/<project>/connections' } }, match: {} },
      },
    ],
  };
  writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  const c = cap();
  assert.equal(await provisionCli(['--out', out, '--record', 'sneaky', ...SCOPE], c.io), 2);
  assert.match(c.err(), /GET/);
  assert.equal(c.restCalls.length, 0, 'a non-GET read-back must issue no call');
  rmSync(out, { recursive: true, force: true });
});

// --- plan-load gate: grant read-backs must be per-(table, role) row specs ---

/** A two-step grant plan like older c2c plan output or a hand edit: the match is whatever the caller supplies. */
function writeGrantPlan(out: string, match: Record<string, unknown>): void {
  mkdirSync(join(out, 'provision'), { recursive: true });
  const plan: PlanFile = {
    version: 1,
    app: 'widget',
    steps: [
      {
        id: 'table-permissions',
        via: 'mcp',
        tool: 'CatalystbyZoho_Update_Table_Permissions',
        args: {},
        readBack: { via: 'mcp', tool: 'CatalystbyZoho_Get_Table_Permissions', match },
      },
      {
        id: 'table-scopes',
        via: 'mcp',
        tool: 'CatalystbyZoho_Update_Table_Scopes',
        args: {},
        readBack: { via: 'mcp', tool: 'CatalystbyZoho_Get_Table_Scopes', match },
      },
    ],
  };
  writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
}

test('a grant read-back match that is not per-row is refused at plan load, naming the step', async () => {
  // The table-name list older plan output wrote (and a hand edit can still
  // write) is presence-only: any grant set "matches", so an over-grant would
  // record as existing. The plan must refuse at load, before any read-back.
  for (const [label, match] of [
    ['table names only', { tables: ['Item', 'Order'] }],
    ['a flat role map', { 'App User': ['SELECT'] }],
    ['an empty match', {}],
    ['an empty row spec', { '<id:Item>': {} }],
    ['a scalar grant', { '<id:Item>': { 'App User': 'SELECT' } }],
  ] as [string, Record<string, unknown>][]) {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-gate-'));
    writeGrantPlan(out, match);
    const c = cap();
    assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], c.io), 2, `${label} must refuse at load`);
    assert.match(c.err(), /table-permissions/, `${label}: the refusal names the step`);
    assert.match(c.err(), /c2c plan|--out/i, `${label}: the refusal says to re-plan`);
    assert.equal(statSync(join(out, 'provision', 'state.json'), { throwIfNoEntry: false })?.isFile() ?? false, false, `${label}: no state written`);
    rmSync(out, { recursive: true, force: true });
  }
});

test('a pre-row plan refuses --record too — a full-CRUD read-back never reaches the matcher', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-gate-rec-'));
  writeGrantPlan(out, { tables: ['Item'] });
  const over = writeResult(out, 'rb', [
    { table_id: '9', 'App User': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], 'App Administrator': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  ]);
  const c = cap();
  assert.equal(await provisionCli(['--out', out, '--record', 'table-permissions', '--result', over, ...SCOPE], c.io), 2);
  assert.match(c.err(), /table-permissions/);
  assert.equal(readState(out).steps['table-permissions'], undefined, 'a refused plan records nothing');
  rmSync(out, { recursive: true, force: true });
});

test('a plan from c2c plan loads under the grant-match gate and an exact read-back records', async () => {
  // A ds whose profile is literally named "App User" spells a built-in role —
  // the auth plan renames it to the custom role "Creator App User", so the
  // form grants are console steps (the mcp grant tools take built-ins only)
  // with <id:Table> → {role: [set]} matches keyed by the custom name.
  const dir = mkdtempSync(join(tmpdir(), 'c2c-prov-ds-'));
  const ds = join(dir, 'app.ds');
  writeFileSync(
    ds,
    `application "Widget"
{
\ttime zone = "Asia/Kolkata"
\tsection S
\t{
\t\tform Item
\t\t{
\t\t\tName
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t}
\tshare_settings
\t{
\t\t"App User"
\t\t{
\t\t\tname = "App User"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled= View,Tab
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Items={"View","Edit"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`,
  );
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-gate-gen-'));
  const planner = cap();
  // --project keeps the existing-project path: table-permissions/-scopes are
  // mcp steps; greenfield verifies them through the import read-backs instead.
  assert.equal(await planCli([ds, '--out', out, '--dc', 'in', '--project', PROJECT], planner.io), 0, planner.err());
  const plan = JSON.parse(readFileSync(join(out, 'provision', 'plan.json'), 'utf8')) as PlanFile;
  const kindIds = STEP_KINDS.map((kind) => kind.id);
  assert.equal(new Set(kindIds).size, kindIds.length);
  assert.ok(!PLAN_EMITTED_CLI_PATHS.includes(PLAN_CLI_PATH.projectUser));
  assert.ok(!PLAN_EMITTED_CLI_PATHS.includes(PLAN_CLI_PATH.cron));
  for (const step of plan.steps) {
    const kind = STEP_KINDS.find((item) => item.id === step.id);
    assert.ok(kind, `${step.id} is not a step c2c plan emits`);
    assert.equal(step.via, kind.via, step.id);
    assert.equal(step.tool, kind.tool, step.id);
    assert.equal(step.readBack.via, kind.readBack.via, step.id);
    assert.equal(step.readBack.tool, kind.readBack.tool, step.id);
    assert.equal(kind.validateMatch(step.readBack.match), true, step.id);
  }
  const perms = plan.steps.find((step) => step.id === 'table-permissions-console');
  const scopes = plan.steps.find((step) => step.id === 'table-scopes-console');
  assert.ok(perms && scopes, "the colliding profile's grants produce the console grant steps on the custom role");
  assert.deepEqual(perms.readBack.match, { '<id:Item>': { 'Creator App User': ['SELECT', 'UPDATE'] } });
  assert.deepEqual(scopes.readBack.match, { '<id:Item>': { 'Creator App User': ['ORG'] } });
  // The grant is never keyed by the built-in the profile name spells.
  assert.equal(plan.steps.some((step) => step.id === 'table-permissions' || step.id === 'table-scopes'), false);

  // The generated plan loads under the gate.
  const status = cap();
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], status.io), 0, status.err());

  // Learn the table id, then record exact read-backs: both grant steps close.
  const c = cap();
  const tables = writeResult(out, 'tables', mcpRows([{ table_name: 'Item', table_id: '9000' }]));
  assert.equal(await provisionCli(['--out', out, '--record', 'tables', '--result', tables, ...SCOPE], c.io), 0, c.err());
  const permRb = writeResult(out, 'perm-rb', [{ table_id: '9000', 'Creator App User': ['SELECT', 'UPDATE'] }]);
  assert.equal(await provisionCli(['--out', out, '--record', 'table-permissions-console', '--result', permRb, ...SCOPE], c.io), 0, c.err());
  assert.equal(readState(out).steps['table-permissions-console']?.status, 'existing');
  const scopeRb = writeResult(out, 'scope-rb', [{ table_id: '9000', 'Creator App User': ['ORG'] }]);
  assert.equal(await provisionCli(['--out', out, '--record', 'table-scopes-console', '--result', scopeRb, ...SCOPE], c.io), 0, c.err());
  assert.equal(readState(out).steps['table-scopes-console']?.status, 'existing');
  rmSync(dir, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

// --- redactor: remaining secret key names and raw-text value shapes ---

test('redactEvidence masks private_key/access_key/signature/session/code subtrees', () => {
  const text = JSON.stringify(
    redactEvidence({
      private_key: 'pk-canary-x',
      access_key: 'ak-canary-x',
      signature: 'sig-canary-x',
      'X-Zoho-Signature': 'xzs-canary-x',
      session: 'sess-canary-x',
      session_id: 'sessid-canary-x',
      code: 'oauth-code-canary',
      nested: { oauth: { code: 'deep-code-canary' } },
      error_code: 'kept-code-field',
      plain: 'kept',
    }),
  );
  for (const canary of ['pk-canary-x', 'ak-canary-x', 'sig-canary-x', 'xzs-canary-x', 'sess-canary-x', 'sessid-canary-x', 'oauth-code-canary', 'deep-code-canary']) {
    assert.ok(!text.includes(canary), `redaction leaks ${canary}: ${text}`);
  }
  assert.match(text, /kept-code-field/, 'error_code is not a secret key');
  assert.match(text, /kept/);
});

test('redactString masks a schemeless ?access_token=, a form-encoded secret and an escaped URL', () => {
  for (const [raw, canaries] of [
    ['host.test/x?access_token=qs-canary-x', ['qs-canary-x']],
    ['next:/cb?code=oc-canary-x&state=1', ['oc-canary-x']],
    ['grant=a&client_secret=cs-canary-x&code=oc2-canary-x', ['cs-canary-x', 'oc2-canary-x']],
    ['{"u":"https:\\/\\/admin:hunter2pw@host.test\\/x?k=esc-canary-x"}', ['esc-canary-x', 'hunter2pw']],
    ['#access_token=frag-canary-x', ['frag-canary-x']],
  ] as [string, string[]][]) {
    const redacted = redactString(raw);
    for (const canary of canaries) assert.ok(!redacted.includes(canary), `redactString leaks ${canary}: ${redacted}`);
  }
});

test('a stored result carries no secret-keyed value or schemeless token', async () => {
  const out = writeMiniPlan();
  const c = cap();
  const dirty = writeResult(out, 'project', {
    ...mcpRows([{ id: PROJECT, project_name: 'c2c-widget' }]) as object,
    private_key: 'pk-canary-y',
    session: { session_id: 'sess-canary-y' },
    callback: 'host.test/x?access_token=qs-canary-y',
  });
  assert.equal(await provisionCli(['--out', out, '--record', 'project', '--result', dirty, ...SCOPE], c.io), 0, c.err());
  const stored = readFileSync(join(out, 'provision', 'results', 'project.json'), 'utf8');
  for (const canary of ['pk-canary-y', 'sess-canary-y', 'qs-canary-y']) {
    assert.ok(!stored.includes(canary), `stored result leaks ${canary}`);
  }
  rmSync(out, { recursive: true, force: true });
});

// --- grant gate: a hand edit can rename the id, so the gate keys on every signal ---

/** A one-step plan of whatever shape the caller supplies. */
function writeStepPlan(out: string, step: PlanStep): void {
  mkdirSync(join(out, 'provision'), { recursive: true });
  writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify({ version: 1, app: 'widget', steps: [step] }, null, 2)}\n`);
}

async function assertRefusedAtLoad(step: PlanStep, label: string): Promise<void> {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-gate-sig-'));
  writeStepPlan(out, step);
  const c = cap();
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], c.io), 2, `${label} must refuse at load`);
  assert.match(c.err(), new RegExp(`step ${step.id}`), `${label}: the refusal names the step`);
  assert.equal(statSync(join(out, 'provision', 'state.json'), { throwIfNoEntry: false })?.isFile() ?? false, false, `${label}: no state written`);
  rmSync(out, { recursive: true, force: true });
}

const FLAT_GRANT = { 'App User': ['SELECT'] };

test('the grant gate follows the tools: a renamed id still refuses a flat grant match', async () => {
  for (const [label, step] of [
    // The write tool names the grant surface on its own — no read-back tool needed.
    ['write tool only', { id: 'perms', via: 'mcp', tool: 'CatalystbyZoho_Update_Table_Permissions', args: {}, readBack: { via: 'mcp', match: FLAT_GRANT } }],
    // A read-back tool match is case- and whitespace-insensitive.
    ['lowercase read-back tool', { id: 'perms', via: 'mcp', args: {}, readBack: { via: 'mcp', tool: 'catalystbyzoho_get_table_permissions', match: FLAT_GRANT } }],
    ['padded read-back tool', { id: 'perms', via: 'mcp', args: {}, readBack: { via: 'mcp', tool: '  CatalystbyZoho_Get_Table_Scopes ', match: FLAT_GRANT } }],
    ['scopes write tool', { id: 'scopes', via: 'mcp', tool: 'CatalystbyZoho_Update_Table_Scopes', args: {}, readBack: { via: 'mcp', match: FLAT_GRANT } }],
  ] as [string, PlanStep][]) {
    await assertRefusedAtLoad(step, label);
  }
});

test('the grant gate follows id variants and /table/<id>/(permissions|scopes) call paths', async () => {
  for (const [label, step] of [
    ['capitalised id', { id: 'Table-Permissions', via: 'mcp', args: {}, readBack: { via: 'mcp', match: FLAT_GRANT } }],
    ['underscored id', { id: 'table_permissions', via: 'mcp', args: {}, readBack: { via: 'mcp', match: FLAT_GRANT } }],
    [
      'cli write and read-back paths',
      {
        id: 'grants',
        via: 'cli',
        args: { call: { method: 'POST', path: '/baas/v1/project/<project>/table/9000/permissions', body: FLAT_GRANT } },
        readBack: { via: 'cli', args: { call: { method: 'GET', path: '/baas/v1/project/<project>/table/9000/permissions' } }, match: FLAT_GRANT },
      },
    ],
    [
      'read-back path only',
      {
        id: 'grants',
        via: 'cli',
        args: {},
        readBack: { via: 'cli', args: { call: { method: 'GET', path: '/baas/v1/project/<project>/table/9000/scopes' } }, match: FLAT_GRANT },
      },
    ],
    [
      'a calls[] entry path',
      {
        id: 'grants',
        via: 'cli',
        args: {},
        readBack: { via: 'cli', args: { calls: [{ method: 'GET', path: '/baas/v1/project/<project>/table/9000/permissions' }] }, match: FLAT_GRANT },
      },
    ],
  ] as [string, PlanStep][]) {
    await assertRefusedAtLoad(step, label);
  }
});

test('a step the gate cannot classify is still refused when its match is role-shaped', async () => {
  // A {role: [grants]} map is a grant spec whatever the step calls itself —
  // on an unrecognised step it is presence-only, so it must not load either.
  await assertRefusedAtLoad(
    { id: 'grants', via: 'mcp', tool: 'T', args: {}, readBack: { via: 'mcp', tool: 'RB', match: { 'App User': ['SELECT', 'INSERT'] } } },
    'flat role map',
  );
  await assertRefusedAtLoad(
    { id: 'grants', via: 'mcp', tool: 'T', args: {}, readBack: { via: 'mcp', tool: 'RB', match: { 'App User': ['ORG'] } } },
    'flat scope map',
  );
  // A tool c2c plan does not emit refuses even when the match is not a grant list.
  await assertRefusedAtLoad(
    { id: 'tables', via: 'mcp', tool: 'T', args: {}, readBack: { via: 'mcp', tool: 'RB', match: { tables: ['Item'] } } },
    'unknown tool',
  );
  // The same match on the tables step c2c plan emits still loads.
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-gate-ok-'));
  writeStepPlan(out, {
    id: 'tables',
    via: 'cli',
    command: 'c2c provision --confirm --run tables',
    args: { plan: 'provision/tables.json', tables: ['Item'] },
    readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Tables', match: { table_name: ['Item'] } },
  });
  const c = cap();
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], c.io), 0, c.err());
  rmSync(out, { recursive: true, force: true });
});

test('a grant-classified step with a per-row match still loads', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-gate-row-'));
  writeStepPlan(out, {
    id: 'table-permissions',
    via: 'mcp',
    tool: 'CatalystbyZoho_Update_Table_Permissions',
    args: {},
    readBack: { via: 'mcp', tool: 'CatalystbyZoho_Get_Table_Permissions', match: { '<id:Item>': { 'App User': ['SELECT'] } } },
  });
  const c = cap();
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], c.io), 0, c.err());
  rmSync(out, { recursive: true, force: true });
});

// --- redactor: secrets at the string start, after whitespace, and escaped ---

test('redactString masks a secret parameter at the string start and after whitespace', () => {
  for (const [raw, canaries] of [
    ['client_secret=cs0-canary&grant_type=refresh_token&refresh_token=rt-canary', ['cs0-canary', 'rt-canary']],
    ['body: refresh_token=rt2-canary', ['rt2-canary']],
    ['err; access_token=at-canary,x', ['at-canary']],
    ['?pwd=pw-canary-x', ['pw-canary-x']],
    ['?otp=otp-canary-x', ['otp-canary-x']],
  ] as [string, string[]][]) {
    const redacted = redactString(raw);
    for (const canary of canaries) assert.ok(!redacted.includes(canary), `redactString leaks ${canary}: ${redacted}`);
  }
});

test('redactString masks percent-encoded and unicode-escaped URL secrets', () => {
  for (const [raw, canaries] of [
    ['redirect=https%3A%2F%2Fh.test%2Fx%3Faccess_token%3Dpe-canary', ['pe-canary']],
    ['err https:\\u002F\\u002Fadmin:pwu-canary@h.test\\u002Fx?k=ue-canary', ['pwu-canary', 'ue-canary']],
  ] as [string, string[]][]) {
    const redacted = redactString(raw);
    for (const canary of canaries) assert.ok(!redacted.includes(canary), `redactString leaks ${canary}: ${redacted}`);
  }
});

test('redactEvidence masks auth_code/verification_code/code_verifier/otp/pwd subtrees', () => {
  const text = JSON.stringify(
    redactEvidence({
      auth_code: 'ac-canary',
      verification_code: 'vc-canary',
      code_verifier: 'cv-canary',
      otp: 'otp-canary',
      pwd: 'pwd-canary',
      error_code: 'kept-error-code',
      status_code: 'kept-status-code',
    }),
  );
  for (const canary of ['ac-canary', 'vc-canary', 'cv-canary', 'otp-canary', 'pwd-canary']) {
    assert.ok(!text.includes(canary), `redaction leaks ${canary}: ${text}`);
  }
  assert.match(text, /kept-error-code/, 'error_code is diagnostic, not a secret');
  assert.match(text, /kept-status-code/, 'status_code is diagnostic, not a secret');
});

// --- plan load accepts only tools and call shapes c2c plan emits ---

const OVER_GRANT = [{ table_id: '9000', table_name: 'Item', 'App User': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] }];

/** Load and a self-read both refuse, and neither issues a REST call or writes state. */
async function assertClosed(step: PlanStep, label: string): Promise<void> {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-allow-'));
  writeStepPlan(out, step);
  const status = cap();
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], status.io), 2, `${label}: ${status.err()}`);
  assert.match(status.err(), new RegExp(`step ${step.id}`), label);
  assert.match(status.err(), /c2c plan/, label);
  assert.equal(status.restCalls.length, 0, label);
  assert.equal(statSync(join(out, 'provision', 'state.json'), { throwIfNoEntry: false })?.isFile() ?? false, false, label);
  const recorded = cap();
  assert.equal(await provisionCli(['--out', out, '--record', step.id, ...SCOPE], recorded.io), 2, `${label} record: ${recorded.err()}`);
  assert.equal(recorded.restCalls.length, 0, `${label} record issued ${recorded.restCalls.join(',')}`);
  rmSync(out, { recursive: true, force: true });
}

test('a tool c2c plan does not emit is refused, including a scalar grant on that step', async () => {
  const scalar = { 'App User': 'SELECT' };
  const flat = { 'App User': ['SELECT'] };
  const tables = { tables: ['Item'] };
  const tools: [string, string][] = [
    ['zwsp', 'CatalystbyZoho_Update_Table\u200b_Permissions'],
    ['inner nbsp', 'CatalystbyZoho_Update_Table\u00a0Permissions'],
    ['trailing tab', 'CatalystbyZoho_Update_Table_Permissions\t'],
    ['leading nbsp', '\u00a0CatalystbyZoho_Update_Table_Permissions'],
    ['fullwidth underscore', 'CatalystbyZoho_Update_Table\uff3fPermissions'],
    ['cyrillic e', 'CatalystbyZoho_Update_Table_P\u0435rmissions'],
    ['hyphenated', 'CatalystbyZoho-Update-Table-Permissions'],
    ['camel', 'CatalystbyZohoUpdateTablePermissions'],
    ['singular', 'CatalystbyZoho_Update_Table_Permission'],
    ['upper case', 'CATALYSTBYZOHO_UPDATE_TABLE_PERMISSIONS'],
  ];
  for (const [label, tool] of tools) {
    for (const [matchLabel, match] of [
      ['scalar', scalar],
      ['flat', flat],
      ['tables', tables],
    ] as [string, Record<string, unknown>][]) {
      await assertClosed(
        { id: 'perms', via: 'mcp', tool, args: {}, readBack: { via: 'mcp', match } },
        `${label} / ${matchLabel}`,
      );
    }
  }
  const mixed: [string, Record<string, unknown>][] = [
    ['mixed Select', { 'App User': ['Select'] }],
    ['mixed insert', { 'App User': ['select', 'Insert'] }],
    ['spaced word', { 'App User': [' SELECT'] }],
    ['scalar scope', { 'App User': 'GLOBAL' }],
    ['nested list', { 'App User': [['SELECT']] }],
    ['id key list', { '<id:Item>': ['SELECT'] }],
    ['wrapped row', { roles: { 'App User': ['SELECT'] } }],
    ['lower role', { 'app user': ['SELECT'] }],
  ];
  for (const [label, match] of mixed) {
    await assertClosed(
      { id: 'perms', via: 'mcp', tool: 'X', args: {}, readBack: { via: 'mcp', tool: 'Y', match } },
      label,
    );
  }
  // A canonical write tool with a scalar row still refuses, and so does an unknown word in an otherwise per-row list.
  await assertClosed(
    {
      id: 'perms',
      via: 'mcp',
      tool: 'CatalystbyZoho_Update_Table_Permissions',
      args: {},
      readBack: { via: 'mcp', tool: 'CatalystbyZoho_Get_Table_Permissions', match: { '<id:Item>': { 'App User': 'SELECT' } } },
    },
    'canonical scalar',
  );
  await assertClosed(
    {
      id: 'perms',
      via: 'mcp',
      tool: 'CatalystbyZoho_Update_Table_Permissions',
      args: {},
      readBack: { via: 'mcp', tool: 'CatalystbyZoho_Get_Table_Permissions', match: { '<id:Item>': { 'App User': ['SELECT', 'DROP'] } } },
    },
    'unknown grant word',
  );
});

test('a cli or read-back call refuses shapes and paths c2c plan does not emit, and issues no request', async () => {
  const scalar = { 'App User': 'SELECT' };
  const project = '/baas/v1/project/<project>';
  const paths: [string, string][] = [
    ['encoded slash', `${project}/table/9000%2Fpermissions`],
    ['encoded letter', `${project}/table/9000/%70ermissions`],
    ['dot segment', `${project}/table/9000/./permissions`],
    ['double slash', `${project}/table/9000//permissions`],
    ['query', `${project}/table/9000/permissions?x=1`],
    ['upper path', `${project}/TABLE/9000/PERMISSIONS`],
    ['scopes dot', `${project}/table/9000/./scopes`],
    ['encoded whole', `${project}%2Ftable%2F9000%2Fpermissions`],
    ['connections dot', `${project}/./connections`],
  ];
  for (const [label, path] of paths) {
    await assertClosed(
      {
        id: 'grants',
        via: 'cli',
        args: {},
        readBack: { via: 'cli', args: { call: { method: 'GET', path } }, match: scalar },
      },
      label,
    );
  }
  await assertClosed(
    {
      id: 'grants',
      via: 'cli',
      args: { calls: [[{ method: 'POST', path: `${project}/table/9000/permissions` }]] },
      readBack: { via: 'mcp', match: scalar },
    },
    'nested calls',
  );
  await assertClosed(
    {
      id: 'grants',
      via: 'cli',
      args: { call: { request: { method: 'POST', path: `${project}/table/9000/permissions` } } },
      readBack: { via: 'mcp', match: scalar },
    },
    'nested request',
  );
  await assertClosed(
    {
      id: 'grants',
      via: 'cli',
      args: { argv: ['api', 'POST', `${project}/table/9000/permissions`] },
      readBack: { via: 'mcp', match: scalar },
    },
    'argv path',
  );
  await assertClosed(
    {
      id: 'grants',
      via: 'mcp',
      tool: 'X',
      args: { url: `https://api.example.test${project}/table/9000/permissions` },
      readBack: { via: 'mcp', match: scalar },
    },
    'args url',
  );
  // An exact auth call plus an extra url field is not the emitted shape.
  await assertClosed(
    {
      id: 'auth-hosted',
      via: 'cli',
      args: {
        call: { method: 'POST', path: `${project}/authentication/enable?auth_type=hosted`, body: { public_signup: false } },
        url: `${project}/table/9000/permissions`,
      },
      readBack: { via: 'mcp', tool: 'CatalystbyZoho_Get_Authentication_Configurations', match: { hosted_auth: true } },
    },
    'extra url beside auth call',
  );
  // The canonical grant path is not a path c2c builds, so a self-read refuses before any GET.
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-allow-'));
  writeStepPlan(out, {
    id: 'grants',
    via: 'cli',
    args: {},
    readBack: { via: 'cli', args: { call: { method: 'GET', path: `${project}/table/9000/permissions` } }, match: scalar },
  });
  const c = cap();
  const result = writeResult(out, 'rb', OVER_GRANT);
  assert.equal(await provisionCli(['--out', out, '--record', 'grants', '--result', result, ...SCOPE], c.io), 2, c.err());
  assert.equal(c.restCalls.length, 0);
  assert.equal(readState(out).steps.grants, undefined);
  rmSync(out, { recursive: true, force: true });
});

test('redactString masks a quote-led key, a quoted value, a raw JSON pair and a header', () => {
  const canary = 'quote-canary-x';
  for (const raw of [
    `stderr: "client_secret=${canary}&x=1"`,
    `body='refresh_token=${canary}'`,
    `data=client_secret=${canary}`,
    `a=1+client_secret=${canary}`,
    `client_secret="${canary}"`,
    `password='${canary}'`,
    `{"client_secret":"${canary}"}`,
    `X-Api-Key: ${canary}`,
    `request body "refresh_token=${canary}"`,
  ]) {
    const redacted = redactString(raw);
    assert.ok(!redacted.includes(canary), `redactString leaks ${canary}: ${redacted}`);
  }
  assert.equal(redactString('error_code=INVALID_INPUT'), 'error_code=INVALID_INPUT');
});

test('redactString masks a secret right after a markup or bracket delimiter', () => {
  const canary = 'delim-canary-x';
  for (const raw of [
    `<pre>client_secret=${canary}</pre>`,
    `body>refresh_token=${canary}`,
    `)client_secret=${canary}`,
    `]access_token=${canary}`,
    `}api_key=${canary}`,
    `<session_key=${canary}`,
  ]) {
    const redacted = redactString(raw);
    assert.ok(!redacted.includes(canary), `redactString leaks ${canary}: ${redacted}`);
  }
});

test('every tool c2c plan emits for the fixture plans is on the plan tool list and the plan loads', { skip: fixtureSkip }, async () => {
  const gallery = join(FIXTURES!, 'gallery');
  const targets = readdirSync(gallery)
    .filter((name) => !name.startsWith('.') && statSync(join(gallery, name), { throwIfNoEntry: false })?.isDirectory())
    .filter((name) => readdirSync(join(gallery, name)).some((child) => child.toLowerCase().endsWith('.ds')))
    .map((name) => join(gallery, name));
  targets.push(L1_DS);
  assert.equal(targets.length, 68);
  const allowed = new Set(PLAN_STEP_TOOLS);
  for (const target of targets) {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-tools-'));
    const planner = cap();
    const planned = await planCli([target, '--out', out, '--dc', 'in', '--allow-budget-fail'], planner.io);
    assert.equal(planned, 0, planner.err());
    const plan = JSON.parse(readFileSync(join(out, 'provision', 'plan.json'), 'utf8')) as PlanFile;
    for (const step of plan.steps) {
      if (step.tool) assert.ok(allowed.has(step.tool), `${step.id} tool ${step.tool}`);
      if (step.readBack.tool) assert.ok(allowed.has(step.readBack.tool), `${step.id} read-back tool ${step.readBack.tool}`);
      const kind = STEP_KINDS.find((item) => item.id === step.id);
      assert.ok(kind, `${step.id} is not a step c2c plan emits`);
      assert.equal(step.via, kind!.via, step.id);
      assert.equal(step.tool, kind!.tool, step.id);
      assert.equal(step.readBack.via, kind!.readBack.via, step.id);
      assert.equal(step.readBack.tool, kind!.readBack.tool, step.id);
      assert.equal(kind!.validateMatch(step.readBack.match), true, `${step.id} match`);
    }
    const status = cap();
    assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], status.io), 0, status.err());
    rmSync(out, { recursive: true, force: true });
  }
});

test('a catalyst child failure does not print a quoted request-body secret', async () => {
  const canary = 'spawn-canary-x';
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-spawn-'));
  mkdirSync(join(out, 'provision'), { recursive: true });
  writeFileSync(
    join(out, 'provision', 'plan.json'),
    `${JSON.stringify({
      version: 1,
      app: 'widget',
      steps: [
        {
          id: 'apig-enable',
          via: 'cli',
          command: 'catalyst apig:enable',
          args: { argv: ['apig:enable'] },
          readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_API_route', match: { routes: ['x'] } },
        },
      ],
    })}\n`,
  );
  const c = cap();
  c.io.spawn = async () => ({ code: 1, stdout: '', stderr: `client_secret=${canary}&grant_type=refresh_token\nrequest body "refresh_token=${canary}2"\nbody:client_secret=${canary}3` });
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'apig-enable', ...SCOPE], c.io), 1);
  assert.ok(!c.err().includes(canary), c.err());
  assert.ok(!c.err().includes(`${canary}2`), c.err());
  assert.ok(!c.err().includes(`${canary}3`), c.err());
  rmSync(out, { recursive: true, force: true });
});

test('redactString masks a secret parameter written after a colon', () => {
  const canary = 'colon-canary-x';
  for (const raw of [`body:client_secret=${canary}`, `note:refresh_token=${canary}`, `=client_secret=${canary}`]) {
    const redacted = redactString(raw);
    assert.ok(!redacted.includes(canary), `redactString leaks ${canary}: ${redacted}`);
  }
  assert.equal(redactString('error_code=INVALID_INPUT'), 'error_code=INVALID_INPUT');
  assert.equal(redactString('status_code: 404'), 'status_code: 404');
});

test('redactString masks adversarial encodings: quad-%25 nesting, unbalanced JSON, \\u keys, array objects, Bearer forms', () => {
  for (const [raw, canaries] of [
    ['diag %2525252563redential=CANARY-QUAD-ENCODED', ['CANARY-QUAD-ENCODED']],
    ['diag {"token":"CANARY-UNBALANCED","a":{', ['CANARY-UNBALANCED']],
    ['diag {"\\u0074oken":"CANARY-UNICODE-KEY"}', ['CANARY-UNICODE-KEY']],
    ['diag \\u0074oken=CANARY-UNICODE-KEY-RAW', ['CANARY-UNICODE-KEY-RAW']],
    ['diag {"items":[{"secret":"CANARY-IN-ARRAY"},{"auth":"CANARY-IN-ARRAY-2"}]}', ['CANARY-IN-ARRAY', 'CANARY-IN-ARRAY-2']],
    ['diag Authorization: Bearer CANARY-HEADER-TOKEN tail', ['CANARY-HEADER-TOKEN']],
    ['diag authorization=bearer%20CANARY-ENCODED-BEARER tail', ['CANARY-ENCODED-BEARER']],
  ] as [string, string[]][]) {
    const redacted = redactString(raw);
    for (const canary of canaries) assert.ok(!redacted.includes(canary), `redactString leaks ${canary}: ${redacted}`);
  }
});

test('redactString stays linear on 1 MiB inputs of hostile shapes', () => {
  const mib = 1024 * 1024;
  for (const [label, make] of [
    ['plain text', (n: number) => 'x'.repeat(n)],
    ['repeated %25', (n: number) => '%25'.repeat(Math.ceil(n / 3)).slice(0, n)],
    ['open braces', (n: number) => '{'.repeat(n)],
    ['key=value runs', (n: number) => 'k=v&'.repeat(Math.ceil(n / 4)).slice(0, n)],
  ] as [string, (n: number) => string][]) {
    const small = make(256 * 1024);
    const large = make(mib);
    const t0 = performance.now();
    redactString(small);
    const smallMs = performance.now() - t0;
    const t1 = performance.now();
    redactString(large);
    const largeMs = performance.now() - t1;
    assert.ok(largeMs < 1000, `${label}: 1 MiB redaction took ${largeMs.toFixed(0)}ms`);
    assert.ok(
      largeMs < Math.max(250, smallMs * 6),
      `${label}: not linear — 256 KiB took ${smallMs.toFixed(0)}ms, 1 MiB took ${largeMs.toFixed(0)}ms`,
    );
  }
});

const LIST_TABLES = 'CatalystbyZoho_List_All_Tables';
const LIST_ROLES = 'CatalystbyZoho_List_All_Roles';
const LIST_JOBPOOLS = 'CatalystbyZoho_List_All_Jobpools';
const CREATE_JOBPOOL = 'CatalystbyZoho_Create_Job_Pool';
const GET_PERMS = 'CatalystbyZoho_Get_Table_Permissions';
const UPDATE_PERMS = 'CatalystbyZoho_Update_Table_Permissions';
const LIST_ROUTES = 'CatalystbyZoho_List_All_API_route';
const LIST_CORS = 'CatalystbyZoho_List_All_CORS_Domains';
const CORS_PATH = '/baas/v1/project/<project>/cors-domain';
const USER_PATH = '/baas/v1/project/<project>/project-user';
const CRON_PATH = '/baas/v1/project/<project>/job_scheduling/cron';
const CORS_BODY = { domain: '<slate-app-url-host>', cors: true, iframe: true };
const CORS_MATCH = { '<slate-app-url-host>': { cors: true, iframe: true } };

test('a step loads only when its id is bound to the via and tool pair c2c plan emits', async () => {
  const flat = { 'App User': ['SELECT'] };
  const scalar = { 'App User': 'SELECT' };
  const perRow = { '<id:Item>': { 'App User': ['SELECT'] } };
  for (const [label, step] of [
    [
      'console permissions read back with List_All_Tables and a flat grant',
      { id: 'table-permissions', via: 'console', command: 'set permissions', args: { grants: [] }, readBack: { via: 'mcp', tool: LIST_TABLES, match: flat } },
    ],
    [
      'console permissions read back with List_All_Tables and a scalar grant',
      { id: 'table-permissions', via: 'console', command: 'set permissions', args: { grants: [] }, readBack: { via: 'mcp', tool: LIST_TABLES, match: scalar } },
    ],
    [
      'console permissions read back with List_All_Roles',
      { id: 'table-permissions', via: 'console', command: 'set permissions', args: { grants: [] }, readBack: { via: 'mcp', tool: LIST_ROLES, match: flat } },
    ],
    [
      'console permissions read back with List_All_Jobpools',
      { id: 'table-permissions', via: 'console', command: 'set permissions', args: { grants: [] }, readBack: { via: 'mcp', tool: LIST_JOBPOOLS, match: scalar } },
    ],
    [
      'permissions id whose tool is Create_Job_Pool',
      {
        id: 'table-permissions',
        via: 'mcp',
        tool: CREATE_JOBPOOL,
        args: { calls: [{ path_variables: { id: '<id:Item>' }, body: flat }] },
        readBack: { via: 'mcp', tool: LIST_JOBPOOLS, match: flat },
      },
    ],
    [
      'jobpool id with a flat grant match',
      {
        id: 'jobpool',
        via: 'mcp',
        tool: CREATE_JOBPOOL,
        args: { path_variables: { projectId: '<project>' }, headers: { 'Catalyst-org': '<org>', Environment: 'Development' }, body: { name: 'pool', type: 'Function' } },
        readBack: { via: 'mcp', tool: LIST_JOBPOOLS, match: flat },
      },
    ],
    [
      'jobpool id with a scalar grant match',
      {
        id: 'jobpool',
        via: 'mcp',
        tool: CREATE_JOBPOOL,
        args: { body: { name: 'pool', type: 'Function' } },
        readBack: { via: 'mcp', tool: LIST_JOBPOOLS, match: scalar },
      },
    ],
    [
      'jobpool id whose match value is a grant word',
      { id: 'jobpool', via: 'mcp', tool: CREATE_JOBPOOL, args: { body: { name: 'pool', type: 'Function' } }, readBack: { via: 'mcp', tool: LIST_JOBPOOLS, match: { name: 'Select' } } },
    ],
    [
      'project read-back via console',
      { id: 'project', via: 'console', command: 'create the project', args: { name: 'c2c-widget' }, readBack: { via: 'console', match: scalar } },
    ],
    [
      'renamed id with a per-row grant match',
      { id: 'perms', via: 'mcp', tool: UPDATE_PERMS, args: {}, readBack: { via: 'mcp', tool: GET_PERMS, match: perRow } },
    ],
    [
      'custom-roles whose role list is a grant word',
      { id: 'custom-roles', via: 'console', command: 'add a role', args: { roles: ['SELECT'] }, readBack: { via: 'mcp', tool: LIST_ROLES, match: { roles: ['SELECT'] } } },
    ],
  ] as [string, PlanStep][]) {
    await assertClosed(step, label);
  }
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-roles-'));
  writeStepPlan(out, {
    id: 'custom-roles',
    via: 'console',
    command: 'add a role',
    args: { roles: ['User', 'Clerk'] },
    readBack: { via: 'mcp', tool: LIST_ROLES, match: { role_name: ['User', 'Clerk'] } },
  });
  const c = cap();
  assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], c.io), 0, c.err());
  rmSync(out, { recursive: true, force: true });
});

test('the cors-domain POST body is the domain token with cors true and iframe true', async () => {
  const domainStep = (body: Record<string, unknown>): PlanStep => ({
    id: 'authorized-domain',
    via: 'cli',
    command: 'c2c provision --confirm --run authorized-domain',
    args: { call: { method: 'POST', path: CORS_PATH, body } },
    readBack: { via: 'mcp', tool: LIST_CORS, match: CORS_MATCH },
  });
  await assertClosed(domainStep({ domain: 'evil.example', cors: true, iframe: true }), 'foreign origin');
  await assertClosed(domainStep({ domain: 'evil.example', cors: true, iframe: false }), 'foreign origin with iframe false');
  await assertClosed(domainStep({ domain: 'a<project>b', cors: true, iframe: true }), 'token spliced into the domain');
  await assertClosed(domainStep({ domain: '<slate-app-url-host>', cors: true, iframe: false }), 'iframe false — the sign-in frame cannot load');
  await assertClosed(domainStep({ domain: '<slate-app-url-host>', cors: false, iframe: true }), 'cors false');

  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-cors-'));
  writeStepPlan(out, domainStep(CORS_BODY));
  const calls: string[] = [];
  const c = cap();
  c.io.rest = guardedRest(async (call) => {
    calls.push(`${call.method} ${call.path} ${JSON.stringify(call.body ?? null)}`);
    return { status: 200, body: {} };
  });
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'authorized-domain', '--domain', 'app.example.test', ...SCOPE], c.io), 0, c.err());
  assert.equal(calls.length, 1, 'the project-details read is not the cors write');
  assert.match(calls[0]!, /POST \/baas\/v1\/project\/\d+\/cors-domain/);
  assert.match(calls[0]!, /"domain":"app\.example\.test"/);
  assert.match(calls[0]!, /"cors":true/);
  assert.match(calls[0]!, /"iframe":true/);
  assert.ok(!calls[0]!.includes('evil.example'));
  rmSync(out, { recursive: true, force: true });
});

test('--domain and inputs.json slateDomain must be a plain Slate host', async () => {
  const domainStep = (body: Record<string, unknown>): PlanStep => ({
    id: 'authorized-domain',
    via: 'cli',
    command: 'c2c provision --confirm --run authorized-domain',
    args: { call: { method: 'POST', path: CORS_PATH, body } },
    readBack: { via: 'mcp', tool: LIST_CORS, match: CORS_MATCH },
  });
  // Wildcard, userinfo, path/query, port and quoted-JSON shapes refuse at the
  // flag — before any write goes out. The user@host:port/path probe must never
  // reach an invite redirect_url or a cors body.
  for (const bad of ['*.onslate.in', ['app.example.test', 'evil.example'].join('@'), ['user', 'evil.com:99/x'].join('@'), 'evil.example/x?a=', 'app.example.test:8443', 'app.example.test","iframe":false,"x":"']) {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-dom-'));
    writeStepPlan(out, domainStep(CORS_BODY));
    const c = cap();
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'authorized-domain', '--domain', bad, ...SCOPE], c.io), 2, bad);
    assert.match(c.err(), /--domain/);
    assert.equal(c.restCalls.filter((call) => call.startsWith('POST')).length, 0, `${bad}: no write`);
    rmSync(out, { recursive: true, force: true });
  }
  // The same probes refuse on the app-users path — no invite is posted.
  {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-dom-'));
    writeUsersPlan(out, 'person@example.test');
    const c = cap(emptySandbox());
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'app-users', '--domain', ['user', 'evil.com:99/x'].join('@'), ...SCOPE], c.io), 2);
    assert.match(c.err(), /--domain/);
    assert.equal(c.restCalls.filter((call) => call.startsWith('POST')).length, 0, 'no invite posts');
    rmSync(out, { recursive: true, force: true });
  }
  // An explicitly empty --domain refuses too, even when inputs.json has a host.
  {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-dom-'));
    writeStepPlan(out, domainStep(CORS_BODY));
    writeFileSync(join(out, 'provision', 'inputs.json'), JSON.stringify({ slateDomain: 'app.example.test' }));
    const c = cap();
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'authorized-domain', '--domain', '', ...SCOPE], c.io), 2);
    assert.match(c.err(), /--domain/);
    rmSync(out, { recursive: true, force: true });
  }
  // inputs.json slateDomain answers to the same rule — the file is user input.
  for (const bad of ['*.onslate.in', ['app.example.test', 'evil.example'].join('@'), 'evil.example/phish?x=', 'evil.example/x?a=']) {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-dom-'));
    writeStepPlan(out, domainStep(CORS_BODY));
    writeFileSync(join(out, 'provision', 'inputs.json'), JSON.stringify({ slateDomain: bad }));
    const c = cap();
    assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], c.io), 2, bad);
    assert.match(c.err(), /slateDomain/);
    rmSync(out, { recursive: true, force: true });
  }
  // A pasted https URL still resolves to the bare host.
  {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-dom-'));
    writeStepPlan(out, domainStep(CORS_BODY));
    const calls: string[] = [];
    const c = cap();
    c.io.rest = guardedRest(async (call) => {
      calls.push(`${call.method} ${call.path} ${JSON.stringify(call.body ?? null)}`);
      return { status: 200, body: {} };
    });
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'authorized-domain', '--domain', 'https://app.example.test', ...SCOPE], c.io), 0, c.err());
    assert.match(calls[0]!, /"domain":"app\.example\.test"/);
    rmSync(out, { recursive: true, force: true });
  }
});

test('the authorized-domain read-back binds the domain row and requires cors and iframe on', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-cors-rb-'));
  writeStepPlan(out, {
    id: 'authorized-domain',
    via: 'cli',
    command: 'c2c provision --confirm --run authorized-domain',
    args: { call: { method: 'POST', path: CORS_PATH, body: CORS_BODY } },
    readBack: { via: 'mcp', tool: LIST_CORS, match: CORS_MATCH },
  });
  const domainArgs = ['--out', out, '--record', 'authorized-domain', '--domain', 'app.example.test', ...SCOPE];

  // The row exists but iFrame is off — the sign-in frame cannot load, so the
  // step stays open and says why.
  const off = writeResult(out, 'cors-off', mcpRows([{ domain: 'app.example.test', cors: true, iframe: false }]));
  const refused = cap();
  assert.equal(await provisionCli([...domainArgs, '--result', off], refused.io), 1);
  assert.match(refused.err(), /iframe/);
  assert.equal(readState(out).steps['authorized-domain'], undefined);

  // iFrame on another domain does not count — the row is bound by its domain.
  const other = writeResult(
    out,
    'cors-other',
    mcpRows([
      { domain: 'other.example.test', cors: true, iframe: true },
      { domain: 'app.example.test', cors: true, iframe: false },
    ]),
  );
  const still = cap();
  assert.equal(await provisionCli([...domainArgs, '--result', other], still.io), 1);
  assert.equal(readState(out).steps['authorized-domain'], undefined);

  const on = writeResult(out, 'cors-on', mcpRows([{ domain: 'app.example.test', cors: true, iframe: true }]));
  const recorded = cap();
  assert.equal(await provisionCli([...domainArgs, '--result', on], recorded.io), 0, recorded.err());
  // Recorded without --applied: the domain was already right — 'existing'.
  assert.equal(readState(out).steps['authorized-domain']?.status, 'existing');
  rmSync(out, { recursive: true, force: true });
});

test('the authorized-domain read-back accepts a bare domains payload and records once applied', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-cors-raw-'));
  writeStepPlan(out, {
    id: 'authorized-domain',
    via: 'cli',
    command: 'c2c provision --confirm --run authorized-domain',
    args: { call: { method: 'POST', path: CORS_PATH, body: CORS_BODY } },
    readBack: { via: 'mcp', tool: LIST_CORS, match: CORS_MATCH },
  });
  const c = cap();
  // A row for another domain never satisfies the host's spec.
  const other = writeResult(out, 'cors-rb-other', { domains: [{ domain: 'other.example', cors: true, iframe: true }] });
  assert.equal(await provisionCli(['--out', out, '--record', 'authorized-domain', '--domain', 'app.example.test', '--result', other, ...SCOPE], c.io), 1);
  assert.equal(readState(out).steps['authorized-domain'], undefined);
  // The host's row with iFrame off is the blank sign-in box — still open.
  const off = writeResult(out, 'cors-rb-off', { domains: [{ domain: 'app.example.test', cors: true, iframe: false }] });
  assert.equal(await provisionCli(['--out', out, '--record', 'authorized-domain', '--domain', 'app.example.test', '--result', off, ...SCOPE], c.io), 1);
  assert.equal(readState(out).steps['authorized-domain'], undefined);
  // The host's row with both flags on closes the step.
  const good = writeResult(out, 'cors-rb', { domains: [{ domain: 'app.example.test', cors: true, iframe: true }] });
  assert.equal(await provisionCli(['--out', out, '--record', 'authorized-domain', '--domain', 'app.example.test', '--result', good, '--applied', ...SCOPE], c.io), 0, c.err());
  assert.equal(readState(out).steps['authorized-domain']?.status, 'done');
  rmSync(out, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test('the security-rule read-back proves authentication is required, not just that c2c_api exists', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-secrule-'));
  writeStepPlan(out, {
    id: 'security-rule',
    via: 'console',
    command: 'Catalyst console → Functions → c2c_api → Security Rules → "Authentication required"',
    args: { rule: 'authentication required', function: 'c2c_api' },
    readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Functions', match: { c2c_api: { is_authenticated: true } } },
  });
  const c = cap();
  // The function row exists but its authentication flag is off — presence is
  // not proof the rule landed, so the step stays open.
  const off = writeResult(out, 'fn-rb-off', { functions: [{ function_name: 'c2c_api', is_authenticated: false }] });
  assert.equal(await provisionCli(['--out', out, '--record', 'security-rule', '--result', off, ...SCOPE], c.io), 1);
  assert.equal(readState(out).steps['security-rule'], undefined);
  // A differently-named row never satisfies the c2c_api spec.
  const other = writeResult(out, 'fn-rb-other', { functions: [{ function_name: 'other_fn', is_authenticated: true }] });
  assert.equal(await provisionCli(['--out', out, '--record', 'security-rule', '--result', other, ...SCOPE], c.io), 1);
  assert.equal(readState(out).steps['security-rule'], undefined);
  const good = writeResult(out, 'fn-rb', { functions: [{ function_name: 'c2c_api', is_authenticated: true }] });
  assert.equal(await provisionCli(['--out', out, '--record', 'security-rule', '--result', good, '--applied', ...SCOPE], c.io), 0, c.err());
  assert.equal(readState(out).steps['security-rule']?.status, 'done');
  rmSync(out, { recursive: true, force: true });
});

test('a plan call does not GET the project-user or cron templates', async () => {
  await assertClosed(
    {
      id: 'authorized-domain',
      via: 'cli',
      args: { call: { method: 'GET', path: USER_PATH } },
      readBack: { via: 'mcp', tool: LIST_CORS, match: CORS_MATCH },
    },
    'GET project-user',
  );
  await assertClosed(
    {
      id: 'authorized-domain',
      via: 'cli',
      args: { call: { method: 'GET', path: CRON_PATH } },
      readBack: { via: 'mcp', tool: LIST_CORS, match: CORS_MATCH },
    },
    'GET cron',
  );
  await assertClosed(
    {
      id: 'connections',
      via: 'console',
      command: 'connect zcrm',
      args: { integrations: ['zcrm'] },
      readBack: { via: 'cli', args: { call: { method: 'GET', path: USER_PATH } }, match: { link_name: ['zcrm'] } },
    },
    'read-back GET project-user',
  );
  await assertClosed(
    {
      id: 'connections',
      via: 'console',
      command: 'connect zcrm',
      args: { integrations: ['zcrm'] },
      readBack: { via: 'cli', args: { call: { method: 'GET', path: CRON_PATH } }, match: { link_name: ['zcrm'] } },
    },
    'read-back GET cron',
  );
});

test('plan JSON refuses __proto__, constructor and prototype keys', async () => {
  const tool = LIST_TABLES;
  const docs = [
    ['__proto__ in the match', `{"version":1,"app":"widget","steps":[{"id":"tables","via":"cli","args":{"plan":"provision/tables.json","tables":["Item"]},"readBack":{"via":"mcp","tool":"${tool}","match":{"__proto__":{"App User":["SELECT"]}}}}]}`],
    ['constructor in the match', `{"version":1,"app":"widget","steps":[{"id":"tables","via":"cli","args":{"plan":"provision/tables.json","tables":["Item"]},"readBack":{"via":"mcp","tool":"${tool}","match":{"constructor":"x","tables":["Item"]}}}]}`],
    ['prototype in the args', `{"version":1,"app":"widget","steps":[{"id":"tables","via":"cli","args":{"plan":"provision/tables.json","tables":["Item"],"prototype":{"url":"https://evil.example"}},"readBack":{"via":"mcp","tool":"${tool}","match":{"tables":["Item"]}}}]}`],
  ] as [string, string][];
  for (const [label, raw] of docs) {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-key-'));
    mkdirSync(join(out, 'provision'), { recursive: true });
    writeFileSync(join(out, 'provision', 'plan.json'), raw);
    const c = cap();
    assert.equal(await provisionCli(['--out', out, '--status', ...SCOPE], c.io), 2, `${label}: ${c.err()}`);
    assert.match(c.err(), /c2c plan/, label);
    assert.equal(c.restCalls.length, 0, label);
    assert.equal(statSync(join(out, 'provision', 'state.json'), { throwIfNoEntry: false })?.isFile() ?? false, false, label);
    rmSync(out, { recursive: true, force: true });
  }
});

test('a project whose name is __proto__ records a decimal project id', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-name-'));
  mkdirSync(join(out, 'provision'), { recursive: true });
  writeFileSync(
    join(out, 'provision', 'plan.json'),
    `${JSON.stringify({
      version: 1,
      app: 'widget',
      steps: [
        {
          id: 'project',
          via: 'console',
          command: 'create the project',
          args: { name: '__proto__', environment: 'Development', app: 'widget' },
          readBack: { via: 'cli', command: 'c2c provision --record project', match: { project_name: '__proto__', id: '<project>' } },
        },
        {
          id: 'apig-enable',
          via: 'cli',
          command: 'catalyst apig:enable',
          args: { argv: ['apig:enable'] },
          readBack: { via: 'mcp', tool: LIST_ROUTES, match: { routes: ['items'] } },
        },
      ],
    })}\n`,
  );
  const result = writeResult(out, 'project-rb', mcpRows([{ project_name: '__proto__', id: '123' }]));
  const recorded = cap();
  assert.equal(
    await provisionCli(['--out', out, '--record', 'project', '--result', result, '--org', ORG, '--project', '123', '--dc', 'in'], recorded.io),
    0,
    recorded.err(),
  );
  const learned = readState(out).learned.projectId;
  assert.equal(typeof learned, 'string');
  assert.match(String(learned), /^[0-9]+$/);
  const run = cap();
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'apig-enable', '--org', ORG, '--dc', 'in'], run.io), 0, run.err());
  assert.equal(run.spawned.length, 1);
  assert.match(run.spawned[0]!, /--project 123\b/);
  assert.ok(!run.spawned[0]!.includes('[object Object]'), run.spawned[0]);
  rmSync(out, { recursive: true, force: true });
});

// --- the new-project IaC import ------------------------------------------------

/**
 * A fake POST /baas/v1/project/import + deploy + status poll. Names in `taken`
 * answer the recorded 409 duplicate-name body; `stuck` keeps the status at
 * Processing forever; `adoptStuck` answers a re-poll of the earlier stuck id
 * (imp-1) as Completed; `deployError` makes the first `times` (default 1)
 * deploy confirms answer that status/body after the redirect_url check
 * passes, and the import reads Staged until a confirm is accepted. The deploy
 * confirm takes only a loopback success redirect_url — the recorded
 * INVALID_REDIRECT_URL refusal answers anything else. `importError` makes
 * every import POST answer that status/body instead of staging an import.
 * Ids are placeholders.
 */
function fakeImportApi(
  opts: {
    taken?: string[];
    stuck?: boolean;
    pollStates?: string[];
    adoptStuck?: boolean;
    adoptData?: Record<string, unknown>;
    mintedName?: string;
    importError?: { status: number; body: unknown };
    deployError?: { status: number; body: unknown; times?: number };
    onDeploy?: () => void;
  } = {},
): { fetch: Io['fetch']; calls: string[]; requests: { method: string; path: string; headers?: Record<string, string> }[] } {
  const calls: string[] = [];
  const requests: { method: string; path: string; headers?: Record<string, string> }[] = [];
  const taken = new Set(opts.taken ?? []);
  const states = opts.pollStates ?? ['Scheduled', 'Processing', 'Completed'];
  let polls = 0;
  let refusals = opts.deployError?.times ?? 1;
  let confirmed = !opts.deployError;
  let postedName = 'c2c-widget';
  const ok = (body: unknown) => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const fetch: Io['fetch'] = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const u = new URL(url);
    requests.push({ method, path: u.pathname, ...(init?.headers ? { headers: init.headers } : {}) });
    if (method === 'POST' && u.pathname === '/baas/v1/project/import') {
      const body = init?.body as unknown;
      const raw = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('latin1') : '';
      const name = /name="project_name"\r\n\r\n([^\r\n]+)/.exec(raw)?.[1] ?? '';
      const importError = opts.importError;
      if (importError) {
        return { status: importError.status, headers: { get: () => null }, text: async () => JSON.stringify(importError.body) };
      }
      if (taken.has(name)) {
        return {
          status: 409,
          headers: { get: () => null },
          text: async () => JSON.stringify({ status: 'failure', data: { message: 'The given project name already exists. Please give a different name', error_code: 'DUPLICATE_ENTRY' } }),
        };
      }
      taken.add(name);
      postedName = name;
      return ok({ status: 'success', data: { id: 'imp-1', project_details: { project_name: name, id: PROJECT, project_type: 'Importing' }, status: 'Staged' } });
    }
    const deploy = /^\/baas\/v1\/project\/import\/[^/]+\/deploy$/.exec(u.pathname);
    if (method === 'GET' && deploy) {
      opts.onDeploy?.();
      if (init?.headers?.Authorization !== 'Bearer test-token') {
        return { status: 401, headers: { get: () => null }, text: async () => '{"status":"failure"}' };
      }
      if (!/^http:\/\/localhost:\d+\/success$/.test(u.searchParams.get('redirect_url') ?? '')) {
        return {
          status: 400,
          headers: { get: () => null },
          text: async () =>
            JSON.stringify({
              status: 'failure',
              data: { message: 'The redirect URL you entered is invalid. Please check the URL and try again.', error_code: 'INVALID_REDIRECT_URL' },
            }),
        };
      }
      if (opts.deployError && refusals > 0) {
        refusals--;
        const { status, body } = opts.deployError;
        return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
      }
      confirmed = true;
      return ok({ status: 'success' });
    }
    if (method === 'GET' && /^\/baas\/v1\/project\/import\/[^/]+$/.test(u.pathname)) {
      if (opts.adoptStuck && u.pathname.endsWith('/imp-1')) {
        return ok({ status: 'success', data: opts.adoptData ?? { status: 'Completed', project_details: { project_name: 'c2c-widget', id: PROJECT, project_type: 'Live' } } });
      }
      if (!confirmed) return ok({ status: 'success', data: { id: 'imp-1', status: 'Staged', project_details: { project_name: postedName, id: PROJECT, project_type: 'Importing' } } });
      const status = opts.stuck ? 'Processing' : states[Math.min(polls++, states.length - 1)];
      return ok({ status: 'success', data: { status, project_details: { project_name: opts.mintedName ?? postedName, id: PROJECT, project_type: status === 'Completed' ? 'Live' : 'Importing' } } });
    }
    return { status: 404, headers: { get: () => null }, text: async () => '{}' };
  };
  return { fetch, calls, requests };
}

const IMPORT_PLAN: PlanFile = {
  version: 1,
  app: 'widget',
  steps: [
    {
      id: 'import',
      via: 'cli',
      command: 'c2c provision --confirm --run import',
      args: { name: 'c2c-widget', environment: 'Development', app: 'widget', dir: 'provision/iac' },
      readBack: { via: 'cli', command: 'c2c provision --record import', match: { project_name: '<import-name>', id: '<project>' } },
    },
    {
      id: 'tables',
      via: 'cli',
      command: 'c2c provision --confirm --run tables',
      args: { plan: 'provision/tables.json', tables: ['Item'] },
      readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Tables', match: { table_name: ['Item'] } },
    },
    {
      id: 'import-roles',
      via: 'mcp',
      tool: 'CatalystbyZoho_List_All_Roles',
      args: { path_variables: { projectId: '<project>' }, headers: { 'Catalyst-org': '<org>', Environment: 'Development' } },
      readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Roles', match: { role_name: ['App Administrator', 'App User'] } },
    },
  ],
};

function writeImportPlan(): string {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-import-'));
  mkdirSync(join(out, 'provision', 'iac', 'functions'), { recursive: true });
  writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify(IMPORT_PLAN, null, 2)}\n`);
  writeFileSync(
    join(out, 'provision', 'tables.json'),
    `${JSON.stringify(
      [{ table: 'Item', form: 'Item', nosql: false, columns: [{ table: 'Item', column_name: 'Name', data_type: 'varchar', max_length: 255, is_unique: false, is_mandatory: false }] }],
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(out, 'provision', 'iac', 'project-template-1.0.0.json'), '{"name":"project-template","version":"1.0.0","parameters":{},"components":{}}\n');
  writeFileSync(join(out, 'provision', 'iac', 'functions', 'c2c_api.zip'), zipStore([{ name: 'index.js', data: 'module.exports = () => {};\n' }]));
  return out;
}

test('--run import creates the project through one IaC import and learns its id', async () => {
  const out = writeImportPlan();
  const api = fakeImportApi();
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 0, c.err());
  // POST the multipart bundle, confirm the deploy, then poll to Completed.
  assert.ok(api.calls.some((line) => line === 'POST https://api.catalyst.zoho.in/baas/v1/project/import'), api.calls.join('\n'));
  assert.ok(api.calls.some((line) => /GET .*\/baas\/v1\/project\/import\/imp-1\/deploy\?/.test(line) && /catalyst_org=10000000000/.test(line)), api.calls.join('\n'));
  assert.ok(api.calls.filter((line) => /GET .*\/baas\/v1\/project\/import\/imp-1$/.test(line)).length >= 3, 'expected every poll state observed');
  assert.ok(api.requests.length > 0);
  assert.ok(api.requests.every((request) => request.headers?.['CATALYST-ORG'] === ORG), JSON.stringify(api.requests));
  assert.match(c.out(), /Completed/);
  const state = readState(out);
  assert.equal(state.learned.projectId, PROJECT);
  assert.equal(state.learned.importName, 'c2c-widget');
  assert.equal(state.steps.import.status, 'done');
  // The learned id drives the next cli step without any --project flag.
  const sandbox = emptySandbox();
  const c2 = cap(sandbox, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'tables', '--org', ORG, '--dc', 'in'], c2.io), 0, c2.err());
  assert.ok(c2.restCalls.some((call) => call.startsWith(`GET /baas/v1/project/${PROJECT}`) || call === `GET /baas/v1/project/${PROJECT}/table`));
  // The mcp verify step records its read-back.
  const roles = writeResult(out, 'import-roles', mcpResult(sandbox, 'CatalystbyZoho_List_All_Roles'));
  assert.equal(await provisionCli(['--out', out, '--record', 'import-roles', '--result', roles, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);
  rmSync(out, { recursive: true, force: true });
});

test('--run import refuses a missing target org before making any Catalyst request', async () => {
  const out = writeImportPlan();
  let requests = 0;
  const c = cap(undefined, async () => {
    requests++;
    return importRes(500, {});
  });
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--dc', 'in'], c.io), 2);
  assert.match(c.err(), /no org/);
  assert.equal(requests, 0);
  rmSync(out, { recursive: true, force: true });
});

test('the deploy confirm sends a loopback success redirect_url — a bare origin or other URL is refused', async () => {
  const out = writeImportPlan();
  const api = fakeImportApi();
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 0, c.err());
  const deploy = api.calls.find((line) => /GET .*\/deploy\?/.test(line));
  assert.ok(deploy, api.calls.join('\n'));
  // A full URL with a path — the recorded refusal answers a bare origin
  // (e.g. the console URL) with 400 INVALID_REDIRECT_URL.
  const redirect = new URL(deploy.slice('GET '.length)).searchParams.get('redirect_url');
  const parsed = new URL(redirect ?? '');
  assert.equal(parsed.hostname, 'localhost');
  assert.equal(parsed.pathname, '/success');
  assert.match(redirect ?? '', /^http:\/\/localhost:\d+\/success$/, `deploy confirm redirect_url: ${redirect}`);
  rmSync(out, { recursive: true, force: true });
});

test('a refused deploy confirm keeps the staged import recorded — the re-run re-issues its confirm, never a second POST or a -2 name', async () => {
  const out = writeImportPlan();
  // One fake across both runs: the POST stages imp-1 and takes the name, so
  // a second POST of "c2c-widget" would answer 409 and move to "-2".
  const api = fakeImportApi({ deployError: { status: 503, body: { status: 'failure', data: { message: 'Service unavailable', error_code: 'INTERNAL_ERROR' } } } });
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  // The report names the staged import, its name and the refusal, and says a
  // re-run retries the confirm — it never says the name is free.
  assert.match(c.err(), /staged as imp-1 \("c2c-widget"\)/);
  assert.match(c.err(), /503/);
  assert.match(c.err(), /re-run to retry the confirm/);
  assert.doesNotMatch(c.err(), /free|no project/i);
  assert.equal(api.calls.filter((line) => /GET .*\/import\/imp-1$/.test(line)).length, 0, 'no status poll after a refused confirm');
  const state = readState(out);
  assert.equal(state.learned.projectId, undefined);
  assert.equal(state.steps.import, undefined);
  assert.deepEqual(state.learned.imports?.['c2c-widget'], { status: 'stuck', importId: 'imp-1' });
  // Run 2 on the same fake: imp-1 reads Staged, its confirm is re-issued with
  // the loopback redirect_url, and the same import completes under the name.
  const before = api.calls.length;
  const c2 = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c2.io), 0, c2.err());
  const rerun = api.calls.slice(before);
  assert.equal(rerun.filter((line) => line.startsWith('POST')).length, 0, `no second import POST:\n${rerun.join('\n')}`);
  assert.doesNotMatch(rerun.join('\n') + c2.out(), /c2c-widget-2/);
  const reissued = rerun.find((line) => /GET .*\/import\/imp-1\/deploy\?/.test(line));
  assert.ok(reissued, `the staged import's confirm is re-issued:\n${rerun.join('\n')}`);
  assert.equal(new URL(reissued.slice('GET '.length)).searchParams.get('redirect_url'), 'http://localhost:3999/success');
  assert.match(c2.out(), /Completed/);
  const after = readState(out);
  assert.equal(after.learned.importName, 'c2c-widget');
  assert.equal(after.learned.projectId, PROJECT);
  assert.deepEqual(after.learned.imports?.['c2c-widget'], { status: 'completed', importId: 'imp-1' });
  rmSync(out, { recursive: true, force: true });
});

test('a 5xx on the import POST or its confirm fails closed inside the run — each call is sent exactly once', async () => {
  // A 503 on the import POST: the run reports the failure and sends the POST
  // once — a re-sent import could stage a second project under a -2 name.
  const out = writeImportPlan();
  const api = fakeImportApi({ importError: { status: 503, body: { status: 'failure', data: { message: 'Service unavailable', error_code: 'INTERNAL_ERROR' } } } });
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  assert.match(c.err(), /POST \/baas\/v1\/project\/import failed: 503/);
  assert.equal(api.calls.filter((line) => line.startsWith('POST')).length, 1, `the import POST is sent once:\n${api.calls.join('\n')}`);
  assert.equal(api.calls.filter((line) => /\/deploy\?/.test(line)).length, 0, 'no deploy confirm after a refused POST');
  const state = readState(out);
  assert.equal(state.steps.import, undefined);
  assert.equal(state.learned.imports, undefined, 'a POST that answered no id records nothing');
  rmSync(out, { recursive: true, force: true });

  // A 503 on the deploy confirm: one POST, one confirm, then the run stops —
  // the staged import is recorded so a re-run re-issues that same confirm.
  const out2 = writeImportPlan();
  const api2 = fakeImportApi({ deployError: { status: 503, body: { status: 'failure', data: { message: 'Service unavailable', error_code: 'INTERNAL_ERROR' } } } });
  const c2 = cap(undefined, api2.fetch);
  assert.equal(await provisionCli(['--out', out2, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c2.io), 1);
  assert.match(c2.err(), /staged as imp-1 \("c2c-widget"\)/);
  assert.match(c2.err(), /confirm failed with 503/);
  assert.equal(api2.calls.filter((line) => line.startsWith('POST')).length, 1, `the import POST is sent once:\n${api2.calls.join('\n')}`);
  assert.equal(api2.calls.filter((line) => /\/import\/imp-1\/deploy\?/.test(line)).length, 1, `the deploy confirm is sent once:\n${api2.calls.join('\n')}`);
  const state2 = readState(out2);
  assert.equal(state2.steps.import, undefined);
  assert.deepEqual(state2.learned.imports?.['c2c-widget'], { status: 'stuck', importId: 'imp-1' });
  rmSync(out2, { recursive: true, force: true });
});

test('the deploy confirm redirect_url is checked locally — only a full http://localhost:<port>/success URL passes', () => {
  assert.equal(assertDeployRedirectUrl(IAC_DEPLOY_REDIRECT_URL), 'http://localhost:3999/success');
  assert.equal(assertDeployRedirectUrl('http://localhost:3000/success'), 'http://localhost:3000/success');
  for (const bad of [
    '',
    'https://console.catalyst.zoho.in',
    'http://localhost:3999',
    'http://localhost:3999/',
    'http://localhost/success',
    'https://localhost:3999/success',
    'http://127.0.0.1:3999/success',
    'http://localhost:3999/success/',
    'http://localhost:3999/success?x=1',
    'http://localhost:3999/success#x',
    'http://user@localhost:3999/success',
    'http://localhost:0/success',
    'http://localhost:03999/success',
    'http://localhost:65536/success',
    'http://localhost.example.test:3999/success',
  ]) {
    assert.throws(() => assertDeployRedirectUrl(bad), /must be a full http:\/\/localhost:<port>\/success URL/, bad);
  }
});

test('a re-issued confirm that is refused again keeps the staged import recorded and says to re-run', async () => {
  const out = writeImportPlan();
  const api = fakeImportApi({ deployError: { status: 503, body: { status: 'failure', data: { message: 'Service unavailable', error_code: 'INTERNAL_ERROR' } }, times: 2 } });
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], cap(undefined, api.fetch).io), 1);
  const c2 = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c2.io), 1);
  assert.match(c2.err(), /staged as imp-1 \("c2c-widget"\); the confirm failed with 503 .*re-run to retry the confirm/);
  assert.equal(api.calls.filter((line) => line.startsWith('POST')).length, 1, 'the staged import is never re-posted');
  assert.deepEqual(readState(out).learned.imports?.['c2c-widget'], { status: 'stuck', importId: 'imp-1' });
  // The third run's confirm is accepted: the same import completes under the name.
  const c3 = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c3.io), 0, c3.err());
  assert.equal(readState(out).learned.importName, 'c2c-widget');
  rmSync(out, { recursive: true, force: true });
});

test('a taken project name reports the queried org before retrying with the -2 suffix', async () => {
  const out = writeImportPlan();
  const api = fakeImportApi({ taken: ['c2c-widget'] });
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 0, c.err());
  assert.match(c.out(), new RegExp(`taken in org ${ORG}.*c2c-widget-2`));
  assert.match(c.out(), /c2c-widget-2/);
  assert.equal(readState(out).learned.importName, 'c2c-widget-2');
  assert.equal(readState(out).learned.projectId, PROJECT);
  rmSync(out, { recursive: true, force: true });
});

test('a name held by a still-"Importing" project is skipped for the next suffix — never POSTed into the collision', async () => {
  const out = writeImportPlan();
  const api = fakeImportApi();
  const c = cap(undefined, api.fetch);
  // The org list shows a project still mid-import under the wanted name — it
  // cannot be deleted, so the name stays taken and the run takes the -2 name.
  c.io.listProjects = async () => [
    { name: 'c2c-widget', id: '777', projectType: 'Importing', createdTime: 'Oct 08, 2026 05:00 AM' },
    { name: 'other-app', id: '778', projectType: 'Live' },
  ];
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 0, c.err());
  // The held name never reaches a POST — the one POST is the -2 name.
  const posts = api.calls.filter((line) => line.startsWith('POST'));
  assert.equal(posts.length, 1, `one import POST:\n${api.calls.join('\n')}`);
  assert.match(c.out(), /project name "c2c-widget" is held by a project still "Importing" in org 10000000000 — trying "c2c-widget-2"/);
  const state = readState(out);
  assert.equal(state.learned.importName, 'c2c-widget-2');
  assert.equal(state.learned.projectId, PROJECT);
  rmSync(out, { recursive: true, force: true });
});

test('a project still "Importing" with known age past the stuck bound refuses with support guidance', async () => {
  const out = writeMiniPlan();
  const c = cap();
  const paths: string[] = [];
  c.io.rest = async (call) => {
    paths.push(`${call.method} ${call.path}`);
    if (call.method === 'GET' && call.path === `/baas/v1/project/${PROJECT}`) {
      return {
        status: 200,
        body: {
          status: 'success',
          data: {
            id: PROJECT,
            project_name: 'c2c-widget',
            project_type: 'Importing',
            created_time: 'Oct 08, 2026 05:00 AM',
            env_details: [{ env_name: 'Development', env_zgid: ORG, id: ORG }],
          },
        },
      };
    }
    return { status: 500, body: {} };
  };
  const code = await provisionCli(['--out', out, '--confirm', '--run', 'tables', ...SCOPE], c.io);
  assert.equal(code, 1);
  assert.match(c.err(), /still "Importing"/);
  assert.match(c.err(), /check the project in the Catalyst console; if it stays Importing, contact Catalyst support/);
  assert.deepEqual(paths, [`GET /baas/v1/project/${PROJECT}`], 'one details read — the branch stops; nothing is retried or deleted');
  rmSync(out, { recursive: true, force: true });
});

test('an Importing project with unknown age stops writes with neutral guidance', async () => {
  const out = writeMiniPlan();
  const c = cap();
  const paths: string[] = [];
  c.io.rest = async (call) => {
    paths.push(`${call.method} ${call.path}`);
    if (call.method === 'GET' && call.path === `/baas/v1/project/${PROJECT}`) {
      return { status: 200, body: { status: 'success', data: { id: PROJECT, project_name: 'c2c-widget', project_type: 'Importing', created_time: 'unreadable', env_details: [{ env_name: 'Development', env_zgid: ORG, id: ORG }] } } };
    }
    return { status: 500, body: {} };
  };
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'tables', ...SCOPE], c.io), 1);
  assert.match(c.err(), /still importing; check its status in the Catalyst console and re-run later/);
  assert.doesNotMatch(c.err(), /contact Catalyst support/);
  assert.deepEqual(paths, [`GET /baas/v1/project/${PROJECT}`]);
  rmSync(out, { recursive: true, force: true });
});

test('--next reaches the import when a plan has a stale project-creation row ahead of it', async () => {
  const out = writeImportPlan();
  const planPath = join(out, 'provision', 'plan.json');
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as { steps: Record<string, unknown>[] };
  plan.steps.unshift({
    id: 'project',
    via: 'console',
    command: 'Create project in the Catalyst console',
    args: { name: 'c2c-widget' },
    readBack: { via: 'cli', command: 'c2c provision --record project', match: { project_name: 'c2c-widget', id: '<project>' } },
  });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const c = cap();
  assert.equal(await provisionCli(['--out', out, '--next', '--org', ORG, '--dc', 'in'], c.io), 0, c.err());
  assert.equal((lastJson(c.out()).step as { id: string }).id, 'import');
  rmSync(out, { recursive: true, force: true });
});

test('an import that never leaves Importing fails the run and keeps its name recorded — a re-run re-polls it, never mints a suffix', async () => {
  const out = writeImportPlan();
  const api = fakeImportApi({ stuck: true });
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  assert.match(c.err(), /c2c-widget.*(blocked|Importing|finishes)/i);
  // The stuck attempt is remembered: the next run re-polls the same import id.
  const state = readState(out);
  assert.equal(state.steps.import, undefined);
  assert.deepEqual(state.learned.imports?.['c2c-widget'], { status: 'stuck', importId: 'imp-1' });
  const c2 = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c2.io), 1);
  assert.equal(api.calls.filter((line) => line.startsWith('POST')).length, 1, 'the recorded import is re-polled, not re-posted as "-2"');
  assert.equal(readState(out).learned.imports?.['c2c-widget']?.status, 'stuck');
  rmSync(out, { recursive: true, force: true });
});

test('a recorded import still running is polled to completion and adopted — never duplicated under a suffix', async () => {
  const out = writeImportPlan();
  const stuck = fakeImportApi({ stuck: true });
  const c = cap(undefined, stuck.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  // The recorded import is still live on the next run: the run keeps polling
  // it and adopts the project it minted instead of minting "c2c-widget-2".
  const api = fakeImportApi({ pollStates: ['Processing', 'Processing', 'Completed'] });
  const c2 = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c2.io), 0, c2.err());
  assert.equal(api.calls.filter((line) => line.startsWith('POST')).length, 0, 'no second import POST');
  assert.equal(readState(out).learned.importName, 'c2c-widget');
  assert.equal(readState(out).learned.projectId, PROJECT);
  rmSync(out, { recursive: true, force: true });
});

test('a stuck import that finished meanwhile is re-polled and adopted, not orphaned by a suffixed retry', async () => {
  const out = writeImportPlan();
  const stuck = fakeImportApi({ stuck: true });
  const c = cap(undefined, stuck.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  // The recorded stuck import completed since: the retry re-polls it and binds
  // the project it minted instead of posting a second import under "-2".
  const api = fakeImportApi({ adoptStuck: true });
  const c2 = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c2.io), 0, c2.err());
  assert.equal(api.calls.filter((line) => line.startsWith('POST')).length, 0, 'no second import POST');
  assert.equal(readState(out).learned.importName, 'c2c-widget');
  assert.equal(readState(out).learned.projectId, PROJECT);
  rmSync(out, { recursive: true, force: true });
});

const importRes = (status: number, body: unknown) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

test('a failed import poll keeps the posted import recorded — the re-run re-polls and adopts it', async () => {
  const out = writeImportPlan();
  // Run 1: the POST and the deploy confirm succeed; the first status read 503s.
  let firstPoll = true;
  const down: Io['fetch'] = async (url, init) => {
    const u = new URL(String(url));
    if (init?.method === 'POST') return importRes(200, { status: 'success', data: { id: 'imp-1', status: 'Staged' } });
    if (u.pathname.endsWith('/deploy')) return importRes(200, { status: 'success' });
    if (firstPoll) {
      firstPoll = false;
      return importRes(503, { status: 'failure', message: 'please try after some time' });
    }
    return importRes(200, { status: 'success', data: { status: 'Processing' } });
  };
  const c = cap(undefined, down);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  // The posted import stays recorded — a failed read must not free the name
  // into a second POST under another name.
  assert.deepEqual(readState(out).learned.imports?.['c2c-widget'], { status: 'stuck', importId: 'imp-1' });
  const api = fakeImportApi({ adoptStuck: true });
  const c2 = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c2.io), 0, c2.err());
  assert.equal(api.calls.filter((line) => line.startsWith('POST')).length, 0, 'no second import POST');
  assert.equal(readState(out).learned.importName, 'c2c-widget');
  assert.equal(readState(out).learned.projectId, PROJECT);
  rmSync(out, { recursive: true, force: true });
});

test('a failed deploy confirm keeps the posted import recorded — the re-run re-issues it from Staged', async () => {
  const out = writeImportPlan();
  // Run 1: the POST succeeds, the deploy confirm 503s.
  const down: Io['fetch'] = async (_url, init) => {
    if (init?.method === 'POST') return importRes(200, { status: 'success', data: { id: 'imp-1', status: 'Staged' } });
    return importRes(503, { status: 'failure', message: 'please try after some time' });
  };
  const c = cap(undefined, down);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  assert.deepEqual(readState(out).learned.imports?.['c2c-widget'], { status: 'stuck', importId: 'imp-1' });
  // Run 2 reads imp-1 as Staged — its deploy confirm never ran — re-issues
  // it, then polls the same import to Completed.
  const calls: string[] = [];
  let confirmed = false;
  const up: Io['fetch'] = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const u = new URL(String(url));
    if (init?.method === 'POST') return importRes(500, {});
    if (u.pathname.endsWith('/deploy')) {
      confirmed = true;
      return importRes(200, { status: 'success' });
    }
    return importRes(200, { status: 'success', data: { status: confirmed ? 'Completed' : 'Staged', project_details: { project_name: 'c2c-widget', id: PROJECT } } });
  };
  const c2 = cap(undefined, up);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c2.io), 0, c2.err());
  assert.equal(calls.filter((line) => line.startsWith('POST')).length, 0, 'no second import POST');
  assert.ok(calls.some((line) => /GET .*\/import\/imp-1\/deploy/.test(line)), 'the interrupted deploy confirm is re-issued');
  assert.equal(readState(out).learned.importName, 'c2c-widget');
  rmSync(out, { recursive: true, force: true });
});

test('a re-poll that cannot read the recorded import keeps the name — nothing is posted over an unknown outcome', async () => {
  const out = await stuckImportOut();
  const calls: string[] = [];
  const down: Io['fetch'] = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return importRes(503, { status: 'failure', message: 'please try after some time' });
  };
  const c = cap(undefined, down);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  assert.equal(calls.filter((line) => line.startsWith('POST')).length, 0, 'an unreadable re-poll must not mint a second name');
  assert.equal(readState(out).learned.imports?.['c2c-widget']?.status, 'stuck');
  rmSync(out, { recursive: true, force: true });
});

test('a recorded import that verifiably ended frees its name — the retry posts the same name again', async () => {
  const out = await stuckImportOut();
  const calls: string[] = [];
  const api: Io['fetch'] = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const u = new URL(String(url));
    if (init?.method === 'POST') {
      const body = init.body as unknown;
      const raw = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('latin1') : '';
      assert.equal(/name="project_name"\r\n\r\n([^\r\n]+)/.exec(raw)?.[1], 'c2c-widget', 'the freed name is retried — no "-2" suffix');
      return importRes(200, { status: 'success', data: { id: 'imp-2', status: 'Staged' } });
    }
    if (u.pathname.endsWith('/deploy')) return importRes(200, { status: 'success' });
    if (u.pathname.endsWith('/imp-1')) return importRes(200, { status: 'success', data: { status: 'Error_Processing' } });
    return importRes(200, { status: 'success', data: { status: 'Completed', project_details: { project_name: 'c2c-widget', id: PROJECT } } });
  };
  const c = cap(undefined, api);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 0, c.err());
  assert.equal(calls.filter((line) => line.startsWith('POST')).length, 1);
  assert.equal(readState(out).learned.importName, 'c2c-widget');
  assert.deepEqual(readState(out).learned.imports?.['c2c-widget'], { status: 'completed', importId: 'imp-2' });
  rmSync(out, { recursive: true, force: true });
});

test('a fresh import whose Completed read names another project is refused — nothing is bound', async () => {
  const out = writeImportPlan();
  const api = fakeImportApi({ mintedName: 'Some-Other-Project', pollStates: ['Completed'] });
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  assert.match(c.err(), /names project "Some-Other-Project", not "c2c-widget"/);
  const state = readState(out);
  assert.equal(state.learned.projectId, undefined, 'nothing learned');
  assert.equal(state.steps.import, undefined);
  rmSync(out, { recursive: true, force: true });
});

test('a 4xx that is not a project-name clash fails on the first POST — it does not burn the name list', async () => {
  const out = writeImportPlan();
  const calls: string[] = [];
  const api: Io['fetch'] = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return importRes(400, { status: 'failure', data: { message: 'duplicate column name in table Item', error_code: 'INVALID_DATA' } });
  };
  const c = cap(undefined, api);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  assert.equal(calls.filter((line) => line.startsWith('POST')).length, 1, 'an unrelated "duplicate" error must not consume the name list');
  assert.match(c.err(), /project\/import failed: 400/);
  rmSync(out, { recursive: true, force: true });
});

/** An --out whose first import stuck at Processing: state.json holds the c2c-widget row with import imp-1. */
async function stuckImportOut(): Promise<string> {
  const out = writeImportPlan();
  const stuck = fakeImportApi({ stuck: true });
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], cap(undefined, stuck.fetch).io), 1);
  assert.deepEqual(readState(out).learned.imports?.['c2c-widget'], { status: 'stuck', importId: 'imp-1' });
  return out;
}

/** Re-run the import against a re-poll answering `adoptData`; it must refuse, POST nothing and learn nothing. */
async function assertAdoptionRefused(out: string, adoptData: Record<string, unknown> | undefined, why: RegExp, extra: string[] = []): Promise<void> {
  const api = fakeImportApi({ adoptStuck: true, ...(adoptData ? { adoptData } : {}) });
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in', ...extra], c.io), 1, c.out());
  assert.match(c.err(), why);
  assert.equal(api.calls.filter((line) => line.startsWith('POST')).length, 0, 'no import POST');
  const state = readState(out);
  assert.equal(state.learned.projectId, undefined, 'nothing learned');
  assert.equal(state.steps.import, undefined);
  assert.equal(state.learned.imports?.['c2c-widget']?.status, 'stuck', 'the recorded row stays for a later re-poll');
}

test('the import id is on disk before the deploy confirm, so an interrupted run re-polls it', async () => {
  const out = writeImportPlan();
  let recorded: unknown;
  const api = fakeImportApi({ onDeploy: () => (recorded = JSON.parse(readFileSync(join(out, 'provision', 'state.json'), 'utf8')).learned.imports) });
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 0, c.err());
  assert.deepEqual(recorded, { 'c2c-widget': { status: 'stuck', importId: 'imp-1' } });
  assert.deepEqual(readState(out).learned.imports, { 'c2c-widget': { status: 'completed', importId: 'imp-1' } });
  rmSync(out, { recursive: true, force: true });
});

test('re-poll adoption refuses a completed import that names another project', async () => {
  const out = await stuckImportOut();
  await assertAdoptionRefused(out, { status: 'Completed', project_details: { project_name: 'Some-Other-Project', id: '4242', project_type: 'Live' } }, /refusing to adopt.*"Some-Other-Project", not "c2c-widget"/);
  // Case and suffix differences are a different name too.
  await assertAdoptionRefused(out, { status: 'Completed', project_details: { project_name: 'C2C-Widget', id: PROJECT } }, /not "c2c-widget"/);
  await assertAdoptionRefused(out, { status: 'Completed', project_details: { id: PROJECT } }, /names project null/);
  rmSync(out, { recursive: true, force: true });
});

test('re-poll adoption refuses a project id that is not a well-formed project id', async () => {
  const out = await stuckImportOut();
  for (const id of ['../../project/1', '7777x', '', -5, 1.5, null]) {
    await assertAdoptionRefused(out, { status: 'Completed', project_details: { project_name: 'c2c-widget', id } }, /no well-formed project id/);
  }
  rmSync(out, { recursive: true, force: true });
});

test('re-poll adoption refuses a status read that names a different import', async () => {
  const out = await stuckImportOut();
  await assertAdoptionRefused(out, { id: 'imp-9', status: 'Completed', project_details: { project_name: 'c2c-widget', id: PROJECT } }, /names import "imp-9", not the recorded imp-1/);
  rmSync(out, { recursive: true, force: true });
});

test('re-poll adoption refuses a recorded import id that is not an import id — no call carries it', async () => {
  const out = await stuckImportOut();
  for (const importId of ['../../project/4242', 'imp 1', 42]) {
    const state = readState(out);
    (state.learned.imports as Record<string, unknown>)['c2c-widget'] = { status: 'stuck', importId };
    writeFileSync(join(out, 'provision', 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    const api = fakeImportApi({ adoptStuck: true });
    const c = cap(undefined, api.fetch);
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1, String(importId));
    assert.match(c.err(), /recorded import id is not an import id/);
    assert.equal(api.calls.length, 0, `${String(importId)}: no call may leave`);
    assert.equal(readState(out).learned.projectId, undefined);
  }
  rmSync(out, { recursive: true, force: true });
});

test('re-poll adoption refuses a never_touch or stuck_unusable project, by id or by name', async () => {
  const out = await stuckImportOut();
  const configs: [Record<string, unknown>, RegExp][] = [
    [{ never_touch: [PROJECT] }, /refusing to bind.*denylist/],
    [{ never_touch: { 'Kept-Project': PROJECT } }, /refusing to bind.*denylist/],
    [{ never_touch: { 'c2c-widget': '1' } }, /refusing to bind.*c2c-widget \(denylist\)/],
    [{ stuck_unusable: { 'Old-Project': PROJECT } }, /refusing to bind.*stuck_unusable/],
    [{ stuck_unusable: { 'C2C-WIDGET': '1' } }, /refusing to bind.*stuck_unusable/],
  ];
  for (const [config, why] of configs) {
    const path = join(out, 'c2c-deploy.json');
    writeFileSync(path, `${JSON.stringify(config)}\n`);
    await assertAdoptionRefused(out, undefined, why, ['--config', path]);
  }
  rmSync(out, { recursive: true, force: true });
});

test('a fresh import that mints a never_touch project is refused before anything is learned', async () => {
  const out = writeImportPlan();
  const path = join(out, 'c2c-deploy.json');
  writeFileSync(path, `${JSON.stringify({ never_touch: [PROJECT] })}\n`);
  const api = fakeImportApi();
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in', '--config', path], c.io), 1);
  assert.match(c.err(), /refusing to bind the imported project "c2c-widget".*denylist/);
  const state = readState(out);
  assert.equal(state.learned.projectId, undefined);
  assert.equal(state.steps.import, undefined);
  rmSync(out, { recursive: true, force: true });
});

test('a stuck import on a freed base name is resolved before any POST — the completed project is adopted, not orphaned', async () => {
  const out = writeImportPlan();
  // Run 1: c2c-widget is taken (409), c2c-widget-2 posts imp-1 and sticks.
  const first = fakeImportApi({ taken: ['c2c-widget'], stuck: true });
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], cap(undefined, first.fetch).io), 1);
  assert.deepEqual(readState(out).learned.imports?.['c2c-widget-2'], { status: 'stuck', importId: 'imp-1' });
  // Meanwhile the unrelated c2c-widget was deleted and imp-1 finished as
  // c2c-widget-2: the re-run must adopt it before posting the freed base name.
  const calls: string[] = [];
  const api: Io['fetch'] = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const u = new URL(String(url));
    if (init?.method === 'POST') return importRes(200, { status: 'success', data: { id: 'imp-2', status: 'Staged' } });
    if (u.pathname.endsWith('/deploy')) return importRes(200, { status: 'success' });
    if (u.pathname.endsWith('/imp-1')) return importRes(200, { status: 'success', data: { status: 'Completed', project_details: { project_name: 'c2c-widget-2', id: PROJECT } } });
    return importRes(200, { status: 'success', data: { status: 'Completed', project_details: { project_name: 'c2c-widget', id: '4243' } } });
  };
  const c = cap(undefined, api);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 0, c.err());
  assert.equal(calls.filter((line) => line.startsWith('POST')).length, 0, 'the recorded import is adopted before any name is posted');
  assert.equal(readState(out).learned.importName, 'c2c-widget-2');
  assert.equal(readState(out).learned.projectId, PROJECT);
  rmSync(out, { recursive: true, force: true });
});

test('a completed stuck import outside the --name sequence refuses rather than orphan its project', async () => {
  const out = await stuckImportOut();
  const calls: string[] = [];
  const api: Io['fetch'] = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const u = new URL(String(url));
    if (init?.method === 'POST') return importRes(200, { status: 'success', data: { id: 'imp-2', status: 'Staged' } });
    if (u.pathname.endsWith('/deploy')) return importRes(200, { status: 'success' });
    if (u.pathname.endsWith('/imp-1')) return importRes(200, { status: 'success', data: { status: 'Completed', project_details: { project_name: 'c2c-widget', id: PROJECT } } });
    return importRes(200, { status: 'success', data: { status: 'Completed', project_details: { project_name: 'c2c-shop', id: '4243' } } });
  };
  const c = cap(undefined, api);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in', '--name', 'c2c-shop'], c.io), 1, c.out());
  assert.match(c.err(), /imp-1/);
  assert.match(c.err(), /c2c-widget/);
  assert.match(c.err(), /orphaned/);
  assert.equal(calls.filter((line) => line.startsWith('POST')).length, 0, 'no POST while a recorded import is unresolved');
  assert.equal(readState(out).learned.imports?.['c2c-widget']?.status, 'stuck');
  rmSync(out, { recursive: true, force: true });
});

test('a stuck row that ended outside the --name sequence is re-polled, dropped, and the run proceeds', async () => {
  const out = await stuckImportOut();
  const calls: string[] = [];
  const api: Io['fetch'] = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const u = new URL(String(url));
    if (init?.method === 'POST') return importRes(200, { status: 'success', data: { id: 'imp-2', status: 'Staged' } });
    if (u.pathname.endsWith('/deploy')) return importRes(200, { status: 'success' });
    if (u.pathname.endsWith('/imp-1')) return importRes(200, { status: 'success', data: { status: 'Error_Processing' } });
    return importRes(200, { status: 'success', data: { status: 'Completed', project_details: { project_name: 'c2c-shop', id: '4243' } } });
  };
  const c = cap(undefined, api);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in', '--name', 'c2c-shop'], c.io), 0, c.err());
  assert.ok(calls.some((line) => /GET .*\/import\/imp-1$/.test(line)), 'the recorded import is re-polled even though its name is not minted this run');
  assert.equal(calls.filter((line) => line.startsWith('POST')).length, 1);
  assert.equal(readState(out).learned.importName, 'c2c-shop');
  assert.equal(readState(out).learned.imports?.['c2c-widget'], undefined, 'the verifiably-ended row is dropped');
  rmSync(out, { recursive: true, force: true });
});

test('a stuck import still running outside the --name sequence refuses the whole run — nothing is posted', async () => {
  const out = await stuckImportOut();
  const api = fakeImportApi({ stuck: true });
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in', '--name', 'c2c-shop'], c.io), 1, c.out());
  assert.match(c.err(), /c2c-widget.*did not finish|did not finish.*c2c-widget/);
  assert.equal(api.calls.filter((line) => line.startsWith('POST')).length, 0, 'a live recorded import blocks every POST, whatever the name');
  assert.equal(readState(out).learned.imports?.['c2c-widget']?.status, 'stuck');
  rmSync(out, { recursive: true, force: true });
});

test('a stuck import that cannot be read outside the --name sequence refuses — nothing is posted over an unknown outcome', async () => {
  const out = await stuckImportOut();
  const calls: string[] = [];
  const down: Io['fetch'] = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return importRes(503, { status: 'failure', message: 'please try after some time' });
  };
  const c = cap(undefined, down);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in', '--name', 'c2c-shop'], c.io), 1);
  assert.equal(calls.filter((line) => line.startsWith('POST')).length, 0, 'an unreadable recorded import must not mint a new name');
  assert.equal(readState(out).learned.imports?.['c2c-widget']?.status, 'stuck');
  rmSync(out, { recursive: true, force: true });
});

test('a stuck row with no import id refuses before any call — a recorded name is never skipped', async () => {
  const out = await stuckImportOut();
  const state = readState(out);
  (state.learned.imports as Record<string, unknown>)['c2c-widget'] = { status: 'stuck' };
  writeFileSync(join(out, 'provision', 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  const api = fakeImportApi();
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  assert.match(c.err(), /no import id was recorded/);
  assert.equal(api.calls.length, 0, 'the refusal happens before any request');
  rmSync(out, { recursive: true, force: true });
});

test('--run import refuses a file link inside provision/iac before any call', async () => {
  for (const member of ['project-template-1.0.0.json', 'functions/c2c_api.zip']) {
    const out = writeImportPlan();
    const outside = mkdtempSync(join(tmpdir(), 'c2c-iac-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'outside-bytes\n');
    rmSync(join(out, 'provision', 'iac', member));
    symlinkSync(join(outside, 'secret.txt'), join(out, 'provision', 'iac', member));
    const api = fakeImportApi();
    const c = cap(undefined, api.fetch);
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1, member);
    assert.match(c.err(), /is a link/, member);
    assert.equal(api.calls.length, 0, `${member}: a linked member must not upload`);
    rmSync(out, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('--run import refuses when a project id is configured — no import POST may leave', async () => {
  const out = writeImportPlan();
  const api = fakeImportApi();
  const c = cap(undefined, api.fetch);
  // A configured project means the plan is for that project: running the
  // import anyway would create a second, orphaned project.
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--project', PROJECT, '--dc', 'in'], c.io), 2);
  assert.match(c.err(), /already configured|existing project/i);
  assert.equal(api.calls.length, 0, 'no call may leave the process');
  rmSync(out, { recursive: true, force: true });
});

test('--run import refuses when the project id is learned state — a lost step record is not a fresh start', async () => {
  const out = writeImportPlan();
  const api = fakeImportApi();
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 0, c.err());
  const posts = api.calls.filter((line) => line.startsWith('POST')).length;
  // The import completed but its step record was lost (state repaired by hand).
  // The learned project id must stop a re-import — the run would orphan a
  // second project.
  const state = readState(out);
  delete state.steps.import;
  writeFileSync(join(out, 'provision', 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  const c2 = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c2.io), 2);
  assert.match(c2.err(), /already configured|existing project|learned/i);
  assert.equal(api.calls.filter((line) => line.startsWith('POST')).length, posts, 'no second import POST');
  rmSync(out, { recursive: true, force: true });
});

test('the import args.dir is pinned to provision/iac — any other path refuses the plan', async () => {
  for (const dir of ['data', 'provision', 'provision/iac/nested', 'provision/../elsewhere', join(tmpdir(), 'c2c-abs')]) {
    const out = writeImportPlan();
    const plan = JSON.parse(readFileSync(join(out, 'provision', 'plan.json'), 'utf8')) as PlanFile;
    plan.steps[0]!.args.dir = dir;
    writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    const api = fakeImportApi();
    const c = cap(undefined, api.fetch);
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 2, `dir ${dir}`);
    assert.match(c.err(), /provision\/plan\.json/, `dir ${dir}: ${c.err()}`);
    assert.equal(api.calls.length, 0, `dir ${dir}: no call may leave`);
    rmSync(out, { recursive: true, force: true });
  }
});

test('--run import refuses a provision/iac that resolves outside --out', async () => {
  const out = writeImportPlan();
  // Replace the generated tree with a link to an outside directory that holds a
  // real bundle — only the realpath check can stop the upload.
  const outside = mkdtempSync(join(tmpdir(), 'c2c-iac-outside-'));
  mkdirSync(join(outside, 'functions'), { recursive: true });
  writeFileSync(join(outside, 'project-template-1.0.0.json'), '{"name":"project-template"}\n');
  writeFileSync(join(outside, 'functions', 'c2c_api.zip'), zipStore([{ name: 'index.js', data: 'module.exports = () => {};\n' }]));
  rmSync(join(out, 'provision', 'iac'), { recursive: true, force: true });
  symlinkSync(outside, join(out, 'provision', 'iac'), 'dir');
  const api = fakeImportApi();
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  assert.match(c.err(), /provision\/iac|link|resolve/i);
  assert.equal(api.calls.length, 0, 'a linked directory must not upload');
  rmSync(out, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('--record import binds the project id its read-back names', async () => {
  const out = writeImportPlan();
  const c = cap();
  const result = writeResult(out, 'import', mcpRows([{ project_name: 'c2c-widget', id: PROJECT }]));
  assert.equal(await provisionCli(['--out', out, '--record', 'import', '--result', result, '--org', ORG, '--project', PROJECT, '--dc', 'in'], c.io), 0, c.err());
  assert.equal(readState(out).learned.projectId, PROJECT);
  rmSync(out, { recursive: true, force: true });
});

test('--record import refuses a name-keyed protected project — the scope check has only ids', async () => {
  const configs: [Record<string, unknown>, RegExp][] = [
    [{ never_touch: { 'c2c-widget': '1' } }, /refusing project c2c-widget \(denylist\)/],
    [{ stuck_unusable: { 'C2C-Widget': '9' } }, /refusing project c2c-widget \(stuck_unusable\)/],
  ];
  for (const [config, why] of configs) {
    const out = writeImportPlan();
    const path = join(out, 'c2c-deploy.json');
    writeFileSync(path, `${JSON.stringify(config)}\n`);
    const result = writeResult(out, 'import', mcpRows([{ project_name: 'c2c-widget', id: PROJECT }]));
    const c = cap();
    assert.equal(
      await provisionCli(['--out', out, '--record', 'import', '--result', result, '--org', ORG, '--project', PROJECT, '--dc', 'in', '--config', path], c.io),
      2,
      `${JSON.stringify(config)}: ${c.err()}`,
    );
    assert.match(c.err(), why);
    const state = readState(out);
    assert.equal(state.steps.import, undefined);
    assert.equal(state.learned.projectId, undefined);
    rmSync(out, { recursive: true, force: true });
  }
});

test('an all-done provision prints the remaining human checklist', async () => {
  const out = writeImportPlan();
  const api = fakeImportApi();
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 0, c.err());
  const sandbox = emptySandbox();
  const c2 = cap(sandbox, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'tables', '--org', ORG, '--dc', 'in'], c2.io), 0, c2.err());
  const roles = writeResult(out, 'import-roles', mcpResult(sandbox, 'CatalystbyZoho_List_All_Roles'));
  assert.equal(await provisionCli(['--out', out, '--record', 'import-roles', '--result', roles, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);
  const status = cap();
  assert.equal(await provisionCli(['--out', out, '--status', '--org', ORG, '--dc', 'in'], status.io), 0);
  assert.match(status.out(), /3\/3/);
  assert.match(status.out(), /checklist|invite|sign in/i);
  rmSync(out, { recursive: true, force: true });
});

test('--run import --name creates that project and prints the c2c-field project id and name, also on a re-run', async () => {
  const out = writeImportPlan();
  const api = fakeImportApi({ taken: ['c2c-order-track'] });
  const c = cap(undefined, api.fetch);
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--name', 'c2c-order-track', '--org', ORG, '--dc', 'in'], c.io), 0, c.err());
  // The name was taken: the import suffixed it, and the fields say so.
  assert.match(c.out(), new RegExp(`^c2c-field project_id ${PROJECT}$`, 'm'));
  assert.match(c.out(), /^c2c-field project_name c2c-order-track-2$/m);
  assert.equal(readState(out).learned.importName, 'c2c-order-track-2');
  // A re-run creates nothing and reports the same fields.
  const again = cap(undefined, api.fetch);
  const posts = api.calls.filter((line) => line.startsWith('POST ')).length;
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--name', 'c2c-order-track', '--org', ORG, '--dc', 'in'], again.io), 0, again.err());
  assert.equal(api.calls.filter((line) => line.startsWith('POST ')).length, posts, 'no second import POST');
  assert.match(again.out(), /^c2c-field project_name c2c-order-track-2$/m);
  rmSync(out, { recursive: true, force: true });
});

test('provision refuses the --import one-shot form and a --name outside --run import, before any call', async () => {
  const out = writeImportPlan();
  const api = fakeImportApi();
  for (const args of [
    ['--confirm', '--name', 'c2c-widget', '--org', ORG, '--import', join(out, 'provision', 'iac')],
    ['--out', out, '--confirm', '--run', 'import', '--import', join(out, 'provision', 'iac'), '--org', ORG, '--dc', 'in'],
  ]) {
    const c = cap(undefined, api.fetch);
    assert.equal(await provisionCli(args, c.io), 2, args.join(' '));
    assert.match(c.err(), /--import is not a provision mode .*--run import --confirm/);
  }
  for (const args of [
    ['--out', out, '--confirm', '--run', 'tables', '--name', 'c2c-widget', '--org', ORG, '--dc', 'in'],
    ['--out', out, '--confirm', '--run', 'import', '--name', 'Bad Name', '--org', ORG, '--dc', 'in'],
    ['--out', out, '--confirm', '--run', 'import', '--name', '--org', ORG, '--dc', 'in'],
  ]) {
    const c = cap(undefined, api.fetch);
    assert.equal(await provisionCli(args, c.io), 2, args.join(' '));
    assert.match(c.err(), /--name/);
  }
  assert.deepEqual(api.calls, [], 'nothing left the machine');
  rmSync(out, { recursive: true, force: true });
});

// --- protected project lists in c2c-deploy.json ------------------------------

test('never_touch and stuck_unusable protect by the same rule — a trailing note does not change the id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-scope-'));
  const config = join(dir, 'c2c-deploy.json');
  const scope = (project: string) => resolveProvisionScope({ args: ['--config', config, '--org', ORG, '--project', project, '--dc', 'in'], cwd: dir, app: 'widget' });
  for (const entry of [
    { never_touch: { prod: '777 keep out' } },
    { never_touch: ['777 keep out'] },
    { stuck_unusable: { old: '777 broken' } },
    { stuck_unusable: ['777 broken'] },
  ]) {
    writeFileSync(config, `${JSON.stringify(entry)}\n`);
    assert.throws(() => scope('777'), /refusing project 777/, JSON.stringify(entry));
    assert.equal(scope('555').projectId, '555', JSON.stringify(entry));
  }
  rmSync(dir, { recursive: true, force: true });
});

test('a protected-list entry with no decimal id refuses the config — an ambiguous entry is never ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-scope-'));
  const config = join(dir, 'c2c-deploy.json');
  for (const entry of [{ never_touch: { prod: 'keep out' } }, { never_touch: ['keep out'] }, { stuck_unusable: { old: 'gone' } }, { stuck_unusable: ['gone'] }]) {
    writeFileSync(config, `${JSON.stringify(entry)}\n`);
    assert.throws(
      () => resolveProvisionScope({ args: ['--config', config, '--org', ORG, '--project', '555', '--dc', 'in'], cwd: dir, app: 'widget' }),
      /not a decimal id/,
      JSON.stringify(entry),
    );
  }
  rmSync(dir, { recursive: true, force: true });
});

// --- the hourly token-expiry edge on the import --------------------------------

/** The recorded answer when the access token lapses as a call lands. */
const INVALID_TOKEN_BODY = { error_code: 'INVALID_TOKEN', message: 'invalid oauth token' };

/** fakeImportApi behind a gate: `deny(method, path, auth)` answers 401 INVALID_TOKEN when it returns true. */
function expiringImportApi(deny: (method: string, path: string, auth: string) => boolean): { fetch: Io['fetch']; calls: string[]; auths: string[] } {
  const api = fakeImportApi();
  const auths: string[] = [];
  const fetch: Io['fetch'] = async (url, init) => {
    const method = init?.method ?? 'GET';
    const auth = String(init?.headers?.Authorization ?? '');
    auths.push(`${method} ${new URL(String(url)).pathname} ${auth}`);
    if (deny(method, new URL(String(url)).pathname, auth)) {
      api.calls.push(`${method} ${url}`);
      return importRes(401, INVALID_TOKEN_BODY);
    }
    // The deploy confirm in the fake checks the first token only.
    const headers = { ...(init?.headers ?? {}), Authorization: 'Bearer test-token' };
    return api.fetch(url, { ...init, headers });
  };
  return { fetch, calls: api.calls, auths };
}

test('an import poll that meets 401 INVALID_TOKEN re-reads once with the newer stored token', async () => {
  const out = writeImportPlan();
  let denied = 0;
  const api = expiringImportApi((method, path) => method === 'GET' && /\/import\/imp-1$/.test(path) && denied++ === 0);
  const c = cap(undefined, api.fetch);
  let renewals = 0;
  c.io.renewAccessToken = async () => {
    renewals++;
    return 'test-token-2';
  };
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 0, c.err());
  assert.equal(renewals, 1);
  assert.equal(readState(out).learned.projectId, PROJECT);
  // The denied poll is re-sent once, and every later call carries the new token.
  const polls = api.auths.filter((line) => /^GET \/baas\/v1\/project\/import\/imp-1 /.test(line));
  assert.equal(polls[0], 'GET /baas/v1/project/import/imp-1 Bearer test-token');
  assert.ok(polls.slice(1).every((line) => line.endsWith('Bearer test-token-2')), polls.join('\n'));
  assert.match(c.out(), /retried once with a newer token/);
  rmSync(out, { recursive: true, force: true });
});

test('an import POST that meets 401 INVALID_TOKEN is never retried — no renewal, no second POST', async () => {
  const out = writeImportPlan();
  const api = expiringImportApi((method) => method === 'POST');
  const c = cap(undefined, api.fetch);
  let renewals = 0;
  c.io.renewAccessToken = async () => {
    renewals++;
    return 'test-token-2';
  };
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  assert.equal(renewals, 0);
  assert.equal(api.calls.filter((line) => line.startsWith('POST')).length, 1);
  assert.doesNotMatch(c.out(), /retried once/);
  rmSync(out, { recursive: true, force: true });
});

test('a second 401 INVALID_TOKEN on the import poll fails the run and keeps the import recorded', async () => {
  const out = writeImportPlan();
  const api = expiringImportApi((method, path) => method === 'GET' && /\/import\/imp-1$/.test(path));
  const c = cap(undefined, api.fetch);
  let renewals = 0;
  c.io.renewAccessToken = async () => {
    renewals++;
    return 'test-token-2';
  };
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  assert.equal(renewals, 1);
  assert.equal(api.calls.filter((line) => /GET .*\/import\/imp-1$/.test(line)).length, 2);
  assert.match(c.err(), /INVALID_TOKEN/);
  assert.deepEqual(readState(out).learned.imports?.['c2c-widget'], { status: 'stuck', importId: 'imp-1' });
  rmSync(out, { recursive: true, force: true });
});

test('an import poll whose stored token is the one that failed is not re-read — the run fails and keeps the import recorded', async () => {
  const out = writeImportPlan();
  const api = expiringImportApi((method, path) => method === 'GET' && /\/import\/imp-1$/.test(path));
  const c = cap(undefined, api.fetch);
  let renewals = 0;
  c.io.renewAccessToken = async () => {
    renewals++;
    return 'test-token';
  };
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c.io), 1);
  assert.equal(renewals, 1);
  assert.equal(api.calls.filter((line) => /GET .*\/import\/imp-1$/.test(line)).length, 1);
  assert.match(c.out(), /401 INVALID_TOKEN, not retried: no newer token/);
  assert.deepEqual(readState(out).learned.imports?.['c2c-widget'], { status: 'stuck', importId: 'imp-1' });
  rmSync(out, { recursive: true, force: true });
});

// --- transient 429/5xx retry on the cli steps ---

const INTERNAL_500 = { status: 'failure', data: { message: 'Internal server error has occurred. Please try again after some time', error_code: 'INTERNAL_SERVER_ERROR' } };

/**
 * `base` answers calls; `fail` maps a call to the failure it returns instead
 * (consumed in order, then the call goes to base). `calls` records everything.
 */
function flakyRest(base: (call: RestCall) => Promise<RestResult>, fail: (call: RestCall) => RestResult | undefined): { rest: (call: RestCall) => Promise<RestResult>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rest: async (call) => {
      calls.push(`${call.method} ${call.path}`);
      return fail(call) ?? base(call);
    },
  };
}

function flakyCap(sandbox: Sandbox, fail: (call: RestCall) => RestResult | undefined): Cap & { calls: string[] } {
  const c = cap(sandbox);
  const flaky = flakyRest(c.io.rest!, fail);
  c.io.rest = flaky.rest;
  c.io.sleep = async () => {};
  return Object.assign(c, { calls: flaky.calls });
}

test('cli steps retry a transient 5xx: the table list is re-read, a landed create is adopted, an unlanded one is never re-sent', async () => {
  const sandbox = emptySandbox();
  const posts = (calls: string[]) => calls.filter((call) => call === `POST /baas/v1/project/${PROJECT}/table`);
  const lists = (calls: string[]) => calls.filter((call) => call === `GET /baas/v1/project/${PROJECT}/table`);

  // GET list answers 503 twice, then 200 — the run completes on the retry.
  {
    const out = writeMiniPlan();
    let failures = 2;
    const c = flakyCap(sandbox, (call) => (call.method === 'GET' && call.path.endsWith('/table') && failures-- > 0 ? { status: 503, body: INTERNAL_500 } : undefined));
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'tables', ...SCOPE], c.io), 0, c.err());
    assert.ok(sandbox.tables.has('Item'));
    assert.equal(lists(c.calls).length, 3, 'the list retried twice before the 200');
    rmSync(out, { recursive: true, force: true });
  }

  // POST /table answers 500 but the create landed: the backoff re-list sees
  // the table and the run adopts it — the POST is never re-sent.
  {
    const out = writeMiniPlan();
    const s2 = emptySandbox();
    const c = cap(s2);
    const calls: string[] = [];
    let failed = false;
    const inner = c.io.rest!;
    c.io.rest = async (call) => {
      calls.push(`${call.method} ${call.path}`);
      if (call.method === 'POST' && call.path.endsWith('/table') && !failed) {
        failed = true;
        const applied = await inner(call);
        assert.ok(applied.status < 300);
        return { status: 500, body: INTERNAL_500 };
      }
      return inner(call);
    };
    c.io.sleep = async () => {};
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'tables', ...SCOPE], c.io), 0, c.err());
    assert.equal(posts(calls).length, 1, 'a landed create must not be POSTed again');
    assert.ok(s2.tables.has('Item'));
    rmSync(out, { recursive: true, force: true });
  }

  // POST /table answers 500 forever and nothing lands: bounded re-reads, the
  // recorded failure stands, the write went out exactly once.
  {
    const out = writeMiniPlan();
    const c = flakyCap(emptySandbox(), (call) => (call.method === 'POST' && call.path.endsWith('/table') ? { status: 500, body: INTERNAL_500 } : undefined));
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'tables', ...SCOPE], c.io), 1);
    assert.match(c.err(), /create table Item failed: 500/);
    assert.equal(posts(c.calls).length, 1, 'an unproven create is never re-sent blind');
    assert.equal(lists(c.calls).length, 1 + 3, 'each backoff re-reads the list instead');
    rmSync(out, { recursive: true, force: true });
  }

  // A 400 is a refusal, not transient: one attempt, no retry.
  {
    const out = writeMiniPlan();
    const c = flakyCap(emptySandbox(), (call) => (call.method === 'POST' && call.path.endsWith('/table') ? { status: 400, body: { data: { message: 'bad table' } } } : undefined));
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'tables', ...SCOPE], c.io), 1);
    assert.equal(posts(c.calls).length, 1);
    assert.equal(lists(c.calls).length, 1);
    rmSync(out, { recursive: true, force: true });
  }
});

test('crons: a POST answered 500 that landed is adopted from the re-list; the invite POST re-reads project users the same way', async () => {
  // Cron create lands despite the 500.
  {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-cron5xx-'));
    writeCronPlan(out);
    const sandbox = emptySandbox();
    const c = cap(sandbox);
    const inner = c.io.rest!;
    const calls: string[] = [];
    let failed = false;
    c.io.rest = async (call) => {
      calls.push(`${call.method} ${call.path}`);
      if (call.method === 'POST' && call.path.endsWith('/job_scheduling/cron') && !failed) {
        failed = true;
        await inner(call);
        return { status: 500, body: INTERNAL_500 };
      }
      return inner(call);
    };
    c.io.sleep = async () => {};
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'crons', ...SCOPE], c.io), 0, c.err());
    assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1);
    assert.equal(sandbox.crons.length, 1, 'the landed cron is adopted, not duplicated');
    rmSync(out, { recursive: true, force: true });
  }

  // Invite POST lands despite the 503: the user list re-read finds the email.
  {
    const out = mkdtempSync(join(tmpdir(), 'c2c-prov-user5xx-'));
    writeUsersPlan(out, 'person@example.test');
    const sandbox = emptySandbox();
    const c = cap(sandbox);
    const inner = c.io.rest!;
    let failed = false;
    let posts = 0;
    c.io.rest = async (call) => {
      if (call.method === 'POST' && call.path.endsWith('/project-user')) {
        posts++;
        if (!failed) {
          failed = true;
          await inner(call);
          return { status: 503, body: INTERNAL_500 };
        }
      }
      return inner(call);
    };
    c.io.sleep = async () => {};
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'app-users', ...SCOPE], c.io), 0, c.err());
    assert.equal(posts, 1, 'the landed invite is never re-sent');
    assert.equal(sandbox.users.length, 1);
    rmSync(out, { recursive: true, force: true });
  }
});

test('cli write steps resend an idempotent POST on a 5xx: a landed write answers already-there, a lost write applies once', async () => {
  // authorized-domain (the emitted cors step): the POST lands but answers 500;
  // the resend gets the recorded already-there 409 — the step stays open for
  // its read-back instead of duplicating the write.
  const plan: PlanFile = {
    version: 1,
    app: 'widget',
    steps: [
      {
        id: 'authorized-domain',
        via: 'cli',
        command: 'c2c provision --confirm --run authorized-domain',
        args: { call: { method: 'POST', path: '/baas/v1/project/<project>/cors-domain', body: { domain: '<slate-app-url-host>', cors: true, iframe: true } } },
        readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_CORS_Domains', match: { '<slate-app-url-host>': { cors: true, iframe: true } } },
      },
    ],
  };
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-cors5xx-'));
  mkdirSync(join(out, 'provision'), { recursive: true });
  writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(join(out, 'provision', 'inputs.json'), `${JSON.stringify({ slateDomain: 'app.example.test' }, null, 2)}\n`);
  const sandbox = emptySandbox();
  const c = cap(sandbox);
  const inner = c.io.rest!;
  let posts = 0;
  c.io.rest = async (call) => {
    if (call.method === 'POST' && call.path.endsWith('/cors-domain')) {
      posts++;
      if (posts === 1) {
        await inner(call);
        return { status: 500, body: INTERNAL_500 };
      }
    }
    return inner(call);
  };
  c.io.sleep = async () => {};
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'authorized-domain', ...SCOPE], c.io), 0, c.err());
  assert.equal(posts, 2, 'the lost-write resend answers already-there');
  assert.equal(sandbox.corsDomains.size, 1, 'no duplicate domain');
  assert.equal(readState(out).steps['authorized-domain']?.status, 'applied');
  rmSync(out, { recursive: true, force: true });

  // auth-hosted (mini plan): the first POST 500s without landing; the resend
  // applies the write once and the step closes on its own answer.
  const out2 = writeMiniPlan();
  const posts2 = { done: false };
  const c2 = flakyCap(emptySandbox(), (call) => (call.method === 'POST' && call.path.includes('/authentication/enable') && !posts2.done ? ((posts2.done = true), { status: 500, body: INTERNAL_500 }) : undefined));
  assert.equal(await provisionCli(['--out', out2, '--confirm', '--run', 'auth-hosted', ...SCOPE], c2.io), 0, c2.err());
  assert.equal(c2.calls.filter((call) => call.startsWith('POST')).length, 2);
  rmSync(out2, { recursive: true, force: true });
});

test('apig:enable re-runs on a transient CLI failure and stops on success', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-apig-'));
  mkdirSync(join(out, 'provision'), { recursive: true });
  const plan: PlanFile = {
    version: 1,
    app: 'widget',
    steps: [
      {
        id: 'apig-enable',
        via: 'cli',
        command: 'catalyst apig:enable',
        args: { argv: ['apig:enable'] },
        readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_API_route', match: { routes: ['/server/c2c_api'] } },
      },
    ],
  };
  writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  const c = cap(emptySandbox());
  c.io.sleep = async () => {};
  let attempts = 0;
  const innerSpawn = c.io.spawn;
  c.io.spawn = async (command, args, opts) => {
    if (args.includes('apig:enable')) {
      attempts++;
      return attempts === 1 ? { code: 2, stdout: '', stderr: 'HTTP Error: 503, Service Unavailable' } : { code: 0, stdout: 'API Gateway enabled', stderr: '' };
    }
    return innerSpawn(command, args, opts);
  };
  assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'apig-enable', ...SCOPE], c.io), 0, c.err());
  assert.equal(attempts, 2);
  rmSync(out, { recursive: true, force: true });
});
