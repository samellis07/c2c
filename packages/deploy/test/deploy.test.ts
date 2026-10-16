import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { deriveIr, parse } from '../../core/src/index.js';
import { emptyCheckpoint, type FetchLike, type MigrateResponse } from '../../data/src/migrate.js';
import {
  GuardError,
  applyTablePlan,
  assertProjectDetails,
  assertProjectPath,
  assertReportedScope,
  buildDeploy,
  deployFiles,
  catalystProjectName,
  catalystSpawn,
  checkGuards,
  cliRenderedProjectId,
  decideMail,
  decodeRestPayload,
  DEPLOY_REPORT,
  LOADER_REPORT,
  confirmedLoadExit,
  deployCli,
  exactId,
  executeSmoke,
  postDeploySteps,
  servicesTouched,
  formatCsvPlan,
  formatTableCreate,
  mandatoryRelaxedLine,
  loadRegistry,
  mailConfig,
  migrateCsv as migrateCsvReal,
  migrateSeed as migrateSeedReal,
  parseCsv,
  parseJsonExact,
  planSmoke,
  readSourceCsv,
  seedMigrateCli as seedMigrateCliReal,
  smokeCli,
  sourceCsvCli as sourceCsvCliReal,
  sourceIdCountQueries,
  tableCreatePlan,
  type Io,
  type ProjectRegistry,
  type RestFn,
  type SpawnResult,
} from '../src/index.js';
import { generateSchema } from '../../schema/src/index.js';
import { catalystFailure, catalystRows, quirkRowServer, rowEndpoint, ROW_PATH } from '../../data/test/catalyst-row-fake.js';
import { c2cVersion, GATE_REQUIRED_CHECKS } from '../../doctor/src/index.js';
import { generateUi } from '../../ui/src/generate.js';
import { repoRoot } from '../../core/src/toolchain.js';

// Older fakes model writes as { rows } → { ids }; rowEndpoint checks the real /row shape around them.
const migrateCsv: typeof migrateCsvReal = (opts) => migrateCsvReal({ ...opts, fetch: rowEndpoint(opts.fetch) });
const migrateSeed: typeof migrateSeedReal = (opts) => migrateSeedReal({ ...opts, fetch: rowEndpoint(opts.fetch) });
const seedMigrateCli: typeof seedMigrateCliReal = (args, io) => seedMigrateCliReal(args, { ...io, fetch: rowEndpoint(io.fetch) });
const sourceCsvCli: typeof sourceCsvCliReal = (args, io) => sourceCsvCliReal(args, { ...io, fetch: rowEndpoint(io.fetch) });

const execFileAsync = promisify(execFile);
const SECRET = '/tmp/cred-DO-NOT-PRINT';
const CLI_TOKEN = 'test-cli-token';
const SCOPE = { org: '10000000000', projectId: '1001', token: CLI_TOKEN };
/** Another decimal org. Used to prove a chosen org is not refused, and that a mismatched report is. */
const WRONG_ORG = '10000000001';
/** Project id the fixture registry lists under never_touch. */
const PROTECTED = '10000000000000001';

// zcatalyst-cli 1.27.2 lib/commands/project/list.js (quoted):
//   listTable.push([
//     { hAlign: 'center', content: red.bold('Project Name') },
//     { hAlign: 'center', content: red.bold('Project ID') }
//   ]);
//   if (activeProjectId === displayId) enhance = ' (active)';
//   if (defaultProjectId === displayId) enhance += ' (base)';
//   if (enhance !== '') { displayName = cyan(displayName + enhance); displayId = cyan(displayId); }
//   listTable.push([displayName, displayId]);
//   info('\n' + listTable.toString());
// The table has no org column. Strings below are that cli-table3 toString().
const FAITHFUL_PROJECT_LIST = `
┌─────────────────────┬────────────┐
│    Project Name     │ Project ID │
├─────────────────────┼────────────┤
│ widget-1001         │ 9999       │
├─────────────────────┼────────────┤
│ c2c-widget (active) │ 1001       │
├─────────────────────┼────────────┤
│ other (base)        │ 1002       │
└─────────────────────┴────────────┘`;
const COLLISION_PROJECT_LIST = `
┌──────────────────────┬────────────┐
│     Project Name     │ Project ID │
├──────────────────────┼────────────┤
│ widget-1001 (active) │ 9999       │
├──────────────────────┼────────────┤
│ other                │ 1002       │
└──────────────────────┴────────────┘`;
const ABSENT_PROJECT_LIST = `
┌────────────────┬────────────┐
│  Project Name  │ Project ID │
├────────────────┼────────────┤
│ other (active) │ 1002       │
└────────────────┴────────────┘`;
const COLORED_PROJECT_LIST =
  '\n┌─────────────────────┬────────────┐\n│    \u001b[31m\u001b[1mProject Name\u001b[22m\u001b[39m     │ \u001b[31m\u001b[1mProject ID\u001b[22m\u001b[39m │\n├─────────────────────┼────────────┤\n│ \u001b[36mc2c-widget (active)\u001b[39m │ \u001b[36m1001\u001b[39m       │\n└─────────────────────┴────────────┘';
const SELECTED_PROJECT_LIST = `
┌──────────────┬────────────┐
│ Project Name │ Project ID │
├──────────────┼────────────┤
│ c2c-widget   │ 1001       │
├──────────────┼────────────┤
│ other        │ 1002       │
└──────────────┴────────────┘`;

function projectDetails(projectId: string, org: string, name = 'c2c-widget') {
  return {
    status: 'success',
    data: {
      id: projectId,
      project_name: name,
      project_type: 'Live',
      timezone: 'Asia/Kolkata',
      project_domain_details: { project_domain_id: '10', project_domain_name: name },
      env_details: [
        {
          env_name: 'Development',
          env_type: 1,
          env_zgid: org,
          id: org,
          is_default: true,
          project_details: { id: projectId, project_name: name },
        },
      ],
    },
  };
}
const DS = `application "Widget"
{
	time zone = "Asia/Kolkata"
	section S
	{
		form Item
		{
			Name
			(
				type = text
				initial value = "SECRET_VALUE_SHOULD_NOT_PRINT"
			)
		}
		list Open_Items
		{
			displayName = "Open"
			show all rows from Item
		}
	}
	workflow
	{
	form
	{
		On_Add as "On add"
		{
			type = form
			form = Item
			on add
			{
				actions
				{
				on success
				(
					x = 1;
				)
				}
			}
		}
	}
	}
}
`;

const registry: ProjectRegistry = {
  org: '10000000000',
  dc: 'in',
  env: 'Development',
  projects: {
    'c2c-widget': '1001',
    'c2c-other': '1002',
  },
  never_touch: { 'Example-Protected': PROTECTED },
};

function response(body: unknown, status = 200): MigrateResponse {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

function assertScopedCall(url: string, init: { headers?: Record<string, string> } | undefined, org: string = SCOPE.org): void {
  const path = new URL(url).pathname;
  assert.match(path, /\/baas\/v1\/project\/1001\//);
  assert.equal(init?.headers?.['CATALYST-ORG'], org);
  assert.equal(init?.headers?.Authorization, `Bearer ${SCOPE.token}`);
  assert.equal(init?.headers?.['X-CATALYST-Environment'], 'Development');
}

function memoryRest(detailsOrg: string = SCOPE.org): { rest: RestFn; calls: { method: string; path: string; body?: unknown }[] } {
  const tables = new Map<string, { id: string; columns: Set<string> }>();
  const users: Record<string, unknown>[] = [];
  let seq = 1;
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const rest: RestFn = async (call) => {
    calls.push({ method: call.method, path: call.path, body: call.body });
    if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+$/.test(call.path)) {
      return { status: 200, body: projectDetails(call.path.split('/').at(-1) ?? '', detailsOrg) };
    }
    if (call.method === 'GET' && call.path.endsWith('/table')) {
      return {
        status: 200,
        body: {
          data: [...tables].map(([name, table]) => ({
            table_name: name,
            table_id: table.id,
            column_details: [...table.columns].map((column_name) => ({ column_name })),
          })),
        },
      };
    }
    if (call.method === 'POST' && call.path.endsWith('/table')) {
      const name = (call.body as { table_name: string }).table_name;
      const id = `t${seq++}`;
      tables.set(name, { id, columns: new Set() });
      return { status: 200, body: { data: { table_id: id } } };
    }
    if (call.method === 'GET' && /\/table\/[^/]+$/.test(call.path)) {
      const id = call.path.split('/table/')[1]?.split('/')[0];
      const found = [...tables.values()].find((table) => table.id === id);
      if (!found) return { status: 404, body: {} };
      return { status: 200, body: { data: { column_details: [...found.columns].map((column_name) => ({ column_name })) } } };
    }
    if (call.method === 'POST' && call.path.includes('/column')) {
      const id = call.path.split('/table/')[1]?.split('/')[0];
      const found = [...tables.values()].find((table) => table.id === id);
      for (const column of call.body as { column_name: string; data_type: string }[]) {
        if (column.data_type === 'decimal') throw new Error('decimal column');
        found?.columns.add(column.column_name);
      }
      return { status: 200, body: { status: 'success' } };
    }
    // Auth endpoints, recorded shapes for enable, CORS, Add User and user read-back.
    if (call.method === 'GET' && call.path.endsWith('/project-user')) {
      return { status: 200, body: { data: users.filter((user) => user.is_confirmed === true) } };
    }
    const invited = call.method === 'GET' ? /\/project-user\/([^/?]+)$/.exec(call.path) : null;
    if (invited) {
      const user = users.find((entry) => entry.user_id === invited[1]);
      return user ? { status: 200, body: { data: user } } : { status: 404, body: { data: { error_code: 'INVALID_USER' } } };
    }
    if (call.method === 'GET' && call.path.endsWith('/role')) {
      return { status: 401, body: { status: 'failure', data: { error_code: 'OAUTH_SCOPE_MISMATCH' } } };
    }
    // The CLI token cannot read the auth config or the domain list.
    if (call.method === 'GET' && call.path.endsWith('/authentication/configuration')) {
      return { status: 401, body: { status: 'failure', data: { error_code: 'OAUTH_SCOPE_MISMATCH', message: 'You are not authorized to perform this operation' } } };
    }
    if (call.method === 'GET' && call.path.endsWith('/cors-domain')) {
      return { status: 401, body: { status: 'failure', data: { error_code: 'OAUTH_SCOPE_MISMATCH', message: 'You are not authorized to perform this operation' } } };
    }
    if (call.method === 'POST' && call.path.endsWith('/project-user')) {
      const details = (call.body as { user_details?: { email_id?: string; role_id?: string } }).user_details ?? {};
      users.push({ user_id: '10000000000000004', email_id: details.email_id, is_confirmed: false, role_details: { role_id: details.role_id, role_name: 'App Administrator' } });
      return { status: 200, body: { data: { user_details: { user_id: '10000000000000004', email_id: details.email_id, is_confirmed: false, source: 'Email' } } } };
    }
    if (call.method === 'POST' && call.path.includes('/authentication/enable')) {
      return { status: 200, body: { data: { hosted_auth: true, embedded_auth: true, public_signup: false, app_account_meta: {} } } };
    }
    if (call.method === 'POST' && call.path.endsWith('/cors-domain')) {
      return { status: 200, body: { data: { id: '10000000000000005', cors: true, iframe: true } } };
    }
    // An opened Slate service lists its apps (none yet): the first-use gate is open.
    if (call.method === 'GET' && /^\/slate\/v1\/project\/[0-9]+\/app$/.test(call.path)) {
      return { status: 200, body: { status: 'success', data: [] } };
    }
    return { status: 404, body: {} };
  };
  return { rest, calls };
}

function capture(env: NodeJS.ProcessEnv = { X_ZC_CREDENTIAL_PATH: SECRET }, detailsOrg: string = SCOPE.org): {
  io: Io;
  stdout: () => string;
  stderr: () => string;
  spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv }[];
  fetched: string[];
  restCalls: { method: string; path: string; body?: unknown }[];
} {
  let out = '';
  let err = '';
  const spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const fetched: string[] = [];
  const store = memoryRest(detailsOrg);
  const fetch: FetchLike = async (url) => {
    fetched.push(url);
    throw new Error('network refused in this test');
  };
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env,
    cliDc: () => undefined,
    spawn: async (command, args, opts) => {
      spawned.push({ command, args, env: opts.env });
      if (args.includes('project:list')) {
        return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' } satisfies SpawnResult;
    },
    fetch,
    rest: store.rest,
    accessToken: async () => CLI_TOKEN,
  };
  return { io, stdout: () => out, stderr: () => err, spawned, fetched, restCalls: store.calls };
}

/** Persist a green doctor.json for one scope so a confirmed bin run passes the doctor gate. */
function writeGreenDoctor(workspace: string, scope: { dc: string; org: string; project: string }): void {
  const dir = join(workspace, 'c2c-out', '.c2c');
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(
    join(dir, 'doctor.json'),
    `${JSON.stringify(
      {
        c2c: c2cVersion(),
        at,
        scope,
        checks: GATE_REQUIRED_CHECKS.map((id) => ({ id, status: 'pass', detail: 'ok', fix: null })),
        mcp: { server: 'catalyst-mcp', host: 'mcp.example.invalid', at, scope },
        green: true,
      },
      null,
      2,
    )}\n`,
  );
}

function writeDs(dir = mkdtempSync(join(tmpdir(), 'c2c-ds-')), ds = DS): string {
  const path = join(dir, 'widget.ds');
  writeFileSync(path, ds);
  return path;
}

function projectsFile(reg: ProjectRegistry = registry): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-projects-'));
  const path = join(dir, 'projects.json');
  writeFileSync(path, JSON.stringify(reg));
  return path;
}

function baseArgs(ds: string, extra: string[] = []): string[] {
  // These tests cover the vanilla deploy path, so they pin the fallback
  // explicitly instead of following the default UI.
  return [ds, '--project', '1001', '--org', '10000000000', '--projects', projectsFile(), '--ui', 'vanilla', ...extra];
}

test('project name matches projects.json keys', () => {
  assert.equal(catalystProjectName('Bill Of Materials'), 'c2c-bill-of-materials');
  assert.equal(catalystProjectName('Widget'), 'c2c-widget');
  const bill: ProjectRegistry = {
    org: '10000000000',
    dc: 'us',
    env: 'Development',
    projects: { 'c2c-bill-of-materials': '10000000000000099' },
  };
  const guard = checkGuards({
    org: '10000000000',
    projectId: '10000000000000099',
    appLink: 'Bill Of Materials',
    credentialPath: SECRET,
    registry: bill,
  });
  assert.equal(guard.projectName, 'c2c-bill-of-materials');
  assert.equal(guard.environment, 'Development');
  assert.equal(guard.dc, 'us');
});

test('guards refuse before any later step', () => {
  const base = { appLink: 'Widget', credentialPath: SECRET, registry };
  const otherOrg = checkGuards({ ...base, org: WRONG_ORG, projectId: '1001' });
  assert.equal(otherOrg.org, WRONG_ORG);
  assert.equal(otherOrg.projectName, 'c2c-widget');
  const small = checkGuards({ ...base, org: '111', projectId: '1001' });
  assert.equal(small.org, '111');
  const unlisted = checkGuards({ ...base, org: '10000000000', projectId: '999' });
  assert.equal(unlisted.projectId, '999');
  assert.equal(unlisted.projectName, 'c2c-widget');
  assert.equal(assertGuard({ ...base, org: '10000000000', projectId: PROTECTED }), 'deny-project');
  assert.equal(
    assertGuard({
      ...base,
      org: '10000000000',
      projectId: PROTECTED,
      registry: { ...registry, projects: { 'c2c-widget': PROTECTED } },
    }),
    'deny-project',
  );
  assert.equal(assertGuard({ ...base, org: '10000000000', projectId: '1002' }), 'name-mismatch');
  assert.equal(assertGuard({ ...base, org: '', projectId: '1001' }), 'configuration');
  assert.equal(assertGuard({ ...base, org: '10000000000', projectId: '1001', environment: 'Production' }), 'environment');
  assert.equal(assertGuard({ ...base, org: '10000000000', projectId: '1001', credentialPath: undefined }), 'credential');
  assert.equal(assertGuard({ ...base, org: '10000000000', projectId: '1001', credentialPath: '   ' }), 'credential');
  const message = new GuardError('credential', 'X_ZC_CREDENTIAL_PATH is unset').message;
  assert.equal(message.includes(SECRET), false);
});

test('a projects.json alias maps an app link to a differently named project', () => {
  const aliased = { ...registry, projects: { ...registry.projects, 'c2c-sample': '3001' }, aliases: { 'c2c-sample-app': 'c2c-sample' } };
  const guard = checkGuards({ org: '10000000000', projectId: '3001', appLink: 'c2c-sample-app', credentialPath: SECRET, registry: aliased });
  assert.equal(guard.projectName, 'c2c-sample');
  assert.equal(assertGuard({ org: '10000000000', projectId: '3001', appLink: 'c2c-other', credentialPath: SECRET, registry: aliased }), 'name-mismatch');
  assert.equal(assertGuard({ org: '10000000000', projectId: '1001', appLink: 'c2c-sample-app', credentialPath: SECRET, registry: aliased }), 'name-mismatch');
});

test('a stuck_unusable id is refused even when projects and an alias both name it', () => {
  const stuck = '10000000000000002';
  const listed: ProjectRegistry = {
    org: '10000000000',
    dc: 'in',
    env: 'Development',
    projects: { 'c2c-approval-management': stuck },
    stuck_unusable: { 'c2c-approval-management': stuck },
    aliases: { 'approval-management': 'c2c-approval-management' },
  };
  const base = { org: '10000000000', projectId: stuck, credentialPath: SECRET, registry: listed };
  assert.equal(assertGuard({ ...base, appLink: 'approval-management' }), 'deny-project');
  assert.equal(assertGuard({ ...base, appLink: 'c2c-approval-management' }), 'deny-project');
  const custom = { ...registry, projects: { ...registry.projects, 'c2c-widget': '4001' }, stuck_unusable: { old: ' 4001 (stuck) ' } };
  assert.equal(assertGuard({ org: '10000000000', projectId: '4001', appLink: 'Widget', credentialPath: SECRET, registry: custom }), 'deny-project');
});

function assertGuard(input: Parameters<typeof checkGuards>[0]): string {
  try {
    checkGuards(input);
  } catch (err) {
    assert.ok(err instanceof GuardError);
    return err.code;
  }
  assert.fail('guard allowed a bad target');
}

test('deploy refuses --mail-sender-verified before any spawn or fetch', async () => {
  const ds = writeDs();
  const cap = capture();
  const code = await deployCli([...baseArgs(ds), '--mail', '--mail-from', 'sender@example.test', '--mail-sender-verified'], cap.io);
  assert.equal(code, 1, `exit 1 with the refusal, got ${code}:\n${cap.stdout()}\n${cap.stderr()}`);
  assert.match(cap.stderr(), /--mail-sender-verified is not taken.*pass --mail-from <address> only/);
  assert.equal(cap.fetched.length, 0, 'refused before any network call');
  assert.equal(cap.spawned.length, 0, 'refused before any spawn');
});

test('deploy without --confirm writes the plan and does not spawn', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-out-'));
  const cap = capture();
  const code = await deployCli([...baseArgs(ds), '--out', out], cap.io);
  assert.equal(code, 0);
  assert.equal(cap.spawned.length, 0);
  assert.equal(cap.fetched.length, 0);
  const plan = cap.stdout();
  assert.equal(plan.includes(SECRET), false);
  assert.equal(plan.includes('SECRET_VALUE_SHOULD_NOT_PRINT'), false);
  assert.match(plan, /project: c2c-widget/);
  assert.match(plan, /project_id: 1001/);
  assert.match(plan, /org: 10000000000/);
  assert.match(plan, /environment: Development/);
  assert.match(plan, /credential: not checked/);
  assert.match(plan, /mail: disabled/);
  assert.match(plan, /confirm: no/);
  assert.match(plan, /table-create \(Development only; not run\)/);
  assert.match(plan, /create table Item if missing/);
  assert.match(plan, /create column Item.c2c_source_id data_type=varchar max_length=255 if missing/);
  assert.match(plan, /iac:import: not run/);
  assert.match(plan, /not run/);
  assert.equal(cap.restCalls.length, 0);
  assert.match(plan, /- Item form=Item/);
  assert.match(plan, /c2c_source_id VarChar/);
  assert.match(plan, /- Name /);
  // Widget sends no mail: no mail module ships and no delivery log table is planned.
  assert.doesNotMatch(plan, /c2c-mail\.mjs/);
  assert.doesNotMatch(plan, /c2c_mail_log/);
  assert.match(plan, /slate\/index\.html/);
  assert.match(plan, /catalyst --org 10000000000 --project 1001 slate:link --name c2c-widget/);
  assert.match(plan, /npm install --omit=dev --no-audit --no-fund \(in functions\/c2c_api\)/);
  assert.match(plan, /catalyst --org 10000000000 --project 1001 deploy --only functions:c2c_api -ni/);
  assert.match(plan, /catalyst --org 10000000000 --project 1001 deploy slate c2c-widget -ni/);
  const rc = JSON.parse(readFileSync(join(out, '.catalystrc'), 'utf8')) as {
    project_id?: string;
    org_id?: string;
    defaults: { project: number; env: number };
    projects: { idx: number; id: string; env: { id: string; name: string; idx: number }[] }[];
  };
  assert.equal(rc.project_id, undefined);
  assert.equal(rc.org_id, undefined);
  assert.deepEqual(rc.defaults, { project: 1, env: 1 });
  assert.equal(rc.projects[0].idx, 1);
  assert.equal(rc.projects[0].id, '1001');
  assert.equal(rc.projects[0].env[0].id, '10000000000');
  assert.equal(rc.projects[0].env[0].name, 'Development');
  assert.equal(rc.projects[0].env[0].idx, 1);
  const catalyst = JSON.parse(readFileSync(join(out, 'catalyst.json'), 'utf8')) as { environment: string; org_id: string; mail: { enabled: boolean } };
  assert.equal(catalyst.environment, 'Development');
  assert.equal(catalyst.org_id, '10000000000');
  assert.equal(catalyst.mail.enabled, false);
  const mail = JSON.parse(readFileSync(join(out, 'c2c-mail.json'), 'utf8')) as { enabled: boolean; allowlist: string[] };
  assert.deepEqual(mail.allowlist, []);
  assert.equal(mail.enabled, false);
  const sources = walk(join(out, 'functions'))
    .filter((path) => path.endsWith('.mjs') && !path.endsWith(`${join('c2c_api', 'c2c-mail.mjs')}`) && !path.includes(`${join('c2c_api', 'vendor')}`))
    .map((path) => readFileSync(path, 'utf8'));
  // Widget sends no mail: no function loads the mail module or names its log table.
  assert.ok(sources.some((source) => source.includes('createRuntime(')));
  assert.equal(sources.some((source) => source.includes('c2cGuardedMail') || source.includes('c2c_mail_log')), false);
  assert.equal(existsSync(join(out, 'functions', 'c2c_api', 'c2c-mail.mjs')), false);
  assert.equal(sources.some((source) => source.includes(SECRET)), false);
  rmSync(out, { recursive: true, force: true });
});

test('blocker 3: --async-on-success warns in plan mode and refuses --confirm without --triggers-wired', async () => {
  // The default DS has a deferrable `on success (x = 1;)`, so the flag opens the lane.
  const ds = writeDs();
  const planCap = capture();
  const planOut = mkdtempSync(join(tmpdir(), 'c2c-out-'));
  const planCode = await deployCli([...baseArgs(ds), '--async-on-success', '--out', planOut], planCap.io);
  assert.equal(planCode, 0);
  assert.match(planCap.stdout(), /async on-success triggers \(opt-in lane\):/);
  assert.match(planCap.stderr(), /warning event-async-triggers:/);
  rmSync(planOut, { recursive: true, force: true });

  const refusedCap = capture();
  const refused = await deployCli([...baseArgs(ds), '--async-on-success', '--confirm', '--function-env', 'new'], refusedCap.io);
  assert.equal(refused, 1);
  assert.match(refusedCap.stderr(), /blocker event-async-triggers:.*--triggers-wired/);

  const wiredCap = capture();
  const wired = await deployCli(
    [...baseArgs(ds), '--async-on-success', '--triggers-wired', '--confirm', '--function-env', 'new'],
    wiredCap.io,
  );
  assert.equal(wired, 0);
  assert.equal(wiredCap.stderr().includes('blocker event-async-triggers'), false);
});

test('deploy --confirm spawns the Development CLI and still hides the credential path', async () => {
  const ds = writeDs();
  const cap = capture({
    X_ZC_CREDENTIAL_PATH: SECRET,
    CATALYST_ORG: WRONG_ORG,
    ZC_ORG_ID: WRONG_ORG,
    CATALYST_PROJECT_ID: PROTECTED,
    CATALYST_PROJECT: 'other',
    ZC_PROJECT_ID: PROTECTED,
    CATALYST_TOKEN: 'not-kept',
    ZC_PROJECT_SECRET_KEY: 'sekrit',
    PATH: process.env.PATH,
  });
  const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--mail'], cap.io);
  assert.equal(code, 0);
  const scope = ['--org', '10000000000', '--project', '1001'];
  assert.deepEqual(
    cap.spawned.map((call) => call.args),
    [
      [...scope, 'project:list'],
      ['install', '--omit=dev', '--no-audit', '--no-fund'],
      [...scope, 'deploy', '--only', 'functions:c2c_api', '-ni'],
      [...scope, 'slate:link', '--name', 'c2c-widget', '--framework', 'static', '--source', './slate', '-ni'],
      [...scope, 'deploy', 'slate', 'c2c-widget', '-ni'],
    ],
  );
  assert.deepEqual(cap.spawned.map((call) => call.command), ['catalyst', 'npm', 'catalyst', 'catalyst', 'catalyst']);
  assert.equal(cap.spawned.every((call) => call.env.X_ZC_CREDENTIAL_PATH === SECRET), true);
  for (const call of cap.spawned) {
    assert.equal(call.env.PATH, process.env.PATH);
    for (const key of Object.keys(call.env)) {
      if (key === 'X_ZC_CREDENTIAL_PATH') continue;
      assert.equal(key.startsWith('CATALYST_') || key.startsWith('ZC_'), false, key);
    }
  }
  assert.equal(cap.stdout().includes(SECRET), false);
  assert.match(cap.stdout(), /mail: enabled/);
  assert.match(cap.stdout(), /confirm: yes/);
  assert.equal(cap.stdout().includes('--production'), false);
  assert.equal(cap.fetched.length, 0);
  assert.match(cap.stdout(), /table-create \(Development only\):/);
  assert.match(cap.stdout(), /commands \(Development only\):/);
  assert.equal(cap.stdout().includes('table-create (Development only; not run)'), false);
  assert.equal(cap.stdout().includes('commands (Development only; not run)'), false);
  assert.deepEqual(cap.restCalls[0], { method: 'GET', path: '/baas/v1/project/1001', body: undefined });
  assert.ok(cap.restCalls.some((call) => call.method === 'GET' && call.path === '/baas/v1/project/1001/table'));
  assert.ok(cap.restCalls.some((call) => call.method === 'POST' && (call.body as { table_name?: string }).table_name === 'Item'));
  const columnPosts = cap.restCalls.filter((call) => call.path.includes('/column'));
  const posted = columnPosts.flatMap((call) => call.body as { column_name: string; data_type: string; max_length?: string }[]);
  assert.ok(posted.some((column) => column.column_name === 'c2c_source_id' && column.data_type === 'varchar' && column.max_length === '255'));
  assert.equal(posted.some((column) => column.data_type === 'decimal'), false);
  assert.match(cap.stdout(), /table-diff:/);
  assert.match(cap.stdout(), /created-tables:\n- Item/);
});

test('a name-collision project:list aborts before REST', async () => {
  const ds = writeDs();
  const cap = capture({
    X_ZC_CREDENTIAL_PATH: SECRET,
    CATALYST_ORG: WRONG_ORG,
    ZC_PROJECT_ID: PROTECTED,
    PATH: process.env.PATH,
  });
  cap.io.spawn = async (command, args, opts) => {
    cap.spawned.push({ command, args, env: opts.env });
    return { code: 0, stdout: COLLISION_PROJECT_LIST, stderr: '' };
  };
  const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new'], cap.io);
  assert.equal(code, 1);
  assert.equal(cap.spawned.length, 1);
  assert.deepEqual(cap.spawned[0].args, ['--org', '10000000000', '--project', '1001', 'project:list']);
  assert.equal(cap.spawned[0].env.CATALYST_ORG, undefined);
  assert.equal(cap.spawned[0].env.ZC_PROJECT_ID, undefined);
  assert.equal(cap.spawned[0].env.X_ZC_CREDENTIAL_PATH, SECRET);
  assert.equal(cap.restCalls.length, 0);
  assert.match(cap.stderr(), /did not report the guarded org and project/);
});

test('a project:list without the guarded id aborts before REST', async () => {
  const ds = writeDs();
  const cap = capture();
  cap.io.spawn = async (command, args, opts) => {
    cap.spawned.push({ command, args, env: opts.env });
    return { code: 0, stdout: ABSENT_PROJECT_LIST, stderr: '' };
  };
  const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new'], cap.io);
  assert.equal(code, 1);
  assert.equal(cap.spawned.length, 1);
  assert.equal(cap.restCalls.length, 0);
  assert.match(cap.stderr(), /did not report the guarded org and project/);
});

test('org mismatch from project details aborts before any deploy command', async () => {
  const ds = writeDs();
  const cap = capture();
  const calls: { method: string; path: string }[] = [];
  cap.io.rest = async (call) => {
    calls.push({ method: call.method, path: call.path });
    if (call.method === 'GET' && call.path === '/baas/v1/project/1001') {
      return { status: 200, body: projectDetails('1001', WRONG_ORG, 'widget-1001') };
    }
    return { status: 500, body: {} };
  };
  const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new'], cap.io);
  assert.equal(code, 1);
  assert.equal(cap.spawned.length, 1);
  assert.deepEqual(calls, [{ method: 'GET', path: '/baas/v1/project/1001' }]);
  assert.match(cap.stderr(), /project details did not report the guarded org and project/);
});

test('project:list is matched on the Project ID cell, never the name', () => {
  assertReportedScope(FAITHFUL_PROJECT_LIST, '1001');
  assertReportedScope(COLORED_PROJECT_LIST, '1001');
  assertReportedScope(SELECTED_PROJECT_LIST, '1001', '1001');
  assert.throws(() => assertReportedScope(SELECTED_PROJECT_LIST, '1001'), /did not report the guarded org and project/);
  assert.throws(() => assertReportedScope(COLLISION_PROJECT_LIST, '1001', '1001'), /did not report the guarded org and project/);
  assert.throws(() => assertReportedScope(ABSENT_PROJECT_LIST, '1001', '1001'), /did not report the guarded org and project/);
  assert.throws(() => assertReportedScope('org: 10000000000\nproject: 1001 (active)\n', '1001', '1001'), /did not report the guarded org and project/);
  assert.throws(() => assertReportedScope(FAITHFUL_PROJECT_LIST, '9999', '9999'), /did not report the guarded org and project/);
  assertProjectDetails(projectDetails('1001', SCOPE.org, 'widget-1001'), SCOPE.org, '1001');
  assert.throws(() => assertProjectDetails(projectDetails('1001', WRONG_ORG), SCOPE.org, '1001'), /project details did not report/);
  assert.throws(() => assertProjectDetails(projectDetails('9999', SCOPE.org, 'widget-1001'), SCOPE.org, '1001'), /project details did not report/);
  assertProjectDetails({ data: { id: '1001', org_id: SCOPE.org } }, SCOPE.org, '1001');
  assert.throws(
    () => assertProjectDetails({ data: { id: '1001', org_id: SCOPE.org, env_details: [{ env_name: 'Production', env_zgid: SCOPE.org }] } }, SCOPE.org, '1001'),
    /project details did not report/,
  );
  assertProjectPath('1001', '/baas/v1/project/1001');
  assertProjectPath('1001', '/baas/v1/project/1001/table');
  assert.throws(() => assertProjectPath('1001', '/baas/v1/project/1002'), /outside the project/);
  assert.throws(() => assertProjectPath('1001', '/baas/v1/project/1001/../1002'), /outside the project/);
  assert.throws(() => assertProjectPath('1001', '/baas/v1/project/10010'), /outside the project/);
});

// Unquoted digits, the way GET /baas/v1/project/<id> writes them. Do not JSON.stringify the ids.
function rawProject(projectId: string, org: string): string {
  return `{"status":"success","data":{"id":${projectId},"project_name":"c2c-widget","env_details":[{"env_name":"Development","env_type":1,"env_zgid":${org},"id":${org},"is_default":true,"project_details":{"id":${projectId},"project_name":"c2c-widget"}}]}}`;
}

function listTable(rows: { name: string; id: string }[]): string {
  const lines = ['│ Project Name │ Project ID │', ...rows.map((row) => `│ ${row.name} │ ${row.id} │`)];
  return lines.join('\n');
}

test('17-digit project and org ids stay exact strings', () => {
  const docs = '10000000000315013';
  const ours = '10000000000013003';
  const protectedProject = '10000000000013007';
  const org = '10000000000';
  assert.equal(cliRenderedProjectId(docs), '10000000000315012');
  assert.equal(cliRenderedProjectId(ours), '10000000000013004');
  assert.equal(cliRenderedProjectId(protectedProject), '10000000000013008');
  assert.equal(cliRenderedProjectId(org), org);
  assert.equal(cliRenderedProjectId('1001'), '1001');

  const docsRaw = rawProject(docs, org);
  const docsBody = parseJsonExact(docsRaw) as { data: { id: string; env_details: { env_zgid: string }[] } };
  assert.equal(docsBody.data.id, docs);
  assert.equal(docsBody.data.env_details[0].env_zgid, org);
  assert.equal(String(JSON.parse(docsRaw).data.id), '10000000000315012');
  assert.notEqual(String(JSON.parse(docsRaw).data.id), docs);
  assertProjectDetails(docsBody, org, docs);
  // Last digit, and the exact digits JSON.parse would have invented.
  assert.throws(() => assertProjectDetails(docsBody, org, '10000000000315012'), /project details did not report/);
  assert.throws(() => assertProjectDetails(docsBody, org, '10000000000315014'), /project details did not report/);
  assert.throws(() => assertProjectDetails(JSON.parse(docsRaw), org, docs), /project details did not report/);
  assert.throws(() => assertProjectDetails(JSON.parse(docsRaw), org, '10000000000315012'), /project details did not report/);

  const oursRaw = rawProject(ours, org);
  assertProjectDetails(parseJsonExact(oursRaw), org, ours);
  assert.throws(() => assertProjectDetails(parseJsonExact(oursRaw), org, '10000000000013005'), /project details did not report/);
  assert.throws(() => assertProjectDetails(parseJsonExact(rawProject(protectedProject, org)), org, ours), /project details did not report/);

  const bigOrg = protectedProject;
  const bigOrgNeighbor = '10000000000013009';
  const orgRaw = rawProject(ours, bigOrg);
  assert.equal(String(JSON.parse(orgRaw).data.env_details[0].env_zgid), String(JSON.parse(rawProject(ours, bigOrgNeighbor)).data.env_details[0].env_zgid));
  assertProjectDetails(parseJsonExact(orgRaw), bigOrg, ours);
  assert.throws(() => assertProjectDetails(parseJsonExact(orgRaw), bigOrgNeighbor, ours), /project details did not report/);

  const wire = JSON.parse(JSON.stringify({ status: 200, raw: oursRaw })) as { status: number; raw: string };
  const decoded = decodeRestPayload(wire);
  assertProjectDetails(decoded.body, org, ours);
  assert.equal((decoded.body as { data: { id: string } }).data.id, ours);

  const printed = cliRenderedProjectId(ours);
  assertReportedScope(listTable([{ name: 'c2c-widget (active)', id: printed }]), ours, ours);
  assertReportedScope(listTable([{ name: 'c2c-widget', id: printed }]), ours, ours);
  assert.throws(() => assertReportedScope(listTable([{ name: 'c2c-widget', id: printed }]), ours), /did not report the guarded org and project/);
  assert.throws(
    () => assertReportedScope(listTable([{ name: 'c2c-widget (active)', id: cliRenderedProjectId('10000000000013011') }]), ours, ours),
    /did not report the guarded org and project/,
  );
  assert.throws(
    () =>
      assertReportedScope(
        listTable([
          { name: 'other (active)', id: '1002' },
          { name: 'c2c-widget', id: printed },
        ]),
        ours,
        ours,
      ),
    /did not report the guarded org and project/,
  );
  assert.throws(
    () =>
      assertReportedScope(
        listTable([
          { name: 'c2c-widget (active)', id: printed },
          { name: 'neighbor', id: printed },
        ]),
        ours,
        ours,
      ),
    /did not report the guarded org and project/,
  );
});

test('projects.json keeps unquoted 17-digit ids as strings', () => {
  const ours = '10000000000013003';
  const neighbor = '10000000000013005';
  const dir = mkdtempSync(join(tmpdir(), 'c2c-projects-'));
  const path = join(dir, 'projects.json');
  writeFileSync(
    path,
    `{"org":"10000000000","dc":"in","env":"Development","projects":{"c2c-widget":${ours}},"never_touch":{"Example-Protected":${PROTECTED}}}`,
  );
  const loaded = loadRegistry(path);
  assert.equal(loaded.projects['c2c-widget'], ours);
  assert.equal(loaded.never_touch?.['Example-Protected'], PROTECTED);
  assert.notEqual(String(JSON.parse(readFileSync(path, 'utf8')).projects['c2c-widget']), ours);
  const guard = checkGuards({ org: '10000000000', projectId: ours, appLink: 'Widget', credentialPath: SECRET, registry: loaded });
  assert.equal(guard.projectId, ours);
  const neighborGuard = checkGuards({ org: '10000000000', projectId: neighbor, appLink: 'Widget', credentialPath: SECRET, registry: loaded });
  assert.equal(neighborGuard.projectId, neighbor);
  assert.equal(neighborGuard.projectName, 'c2c-widget');
  assert.equal(
    assertGuard({ org: '10000000000', projectId: PROTECTED, appLink: 'Widget', credentialPath: SECRET, registry: loaded }),
    'deny-project',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('a lossy project:list still fails closed when REST ids differ by one digit', async () => {
  const projectId = '10000000000013003';
  const neighbor = '10000000000013005';
  const printed = cliRenderedProjectId(projectId);
  assert.equal(printed, cliRenderedProjectId(neighbor));
  assert.notEqual(printed, projectId);
  const ds = writeDs();
  const projects = projectsFile({
    org: '10000000000',
    dc: 'in',
    env: 'Development',
    projects: { 'c2c-widget': projectId },
    never_touch: { 'Example-Protected': PROTECTED },
  });
  const table = listTable([{ name: 'c2c-widget (active)', id: printed }]);
  const ok = capture();
  ok.io.spawn = async (command, args, opts) => {
    ok.spawned.push({ command, args, env: opts.env });
    if (args.includes('project:list')) return { code: 0, stdout: table, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const code = await deployCli([ds, '--project', projectId, '--org', '10000000000', '--projects', projects, '--confirm', '--function-env', 'new', '--ui', 'vanilla'], ok.io);
  assert.equal(code, 0);
  assert.equal(ok.restCalls[0]?.path, `/baas/v1/project/${projectId}`);
  assert.ok(ok.spawned.some((call) => call.args.includes('deploy')));

  const bad = capture();
  bad.io.spawn = async (command, args, opts) => {
    bad.spawned.push({ command, args, env: opts.env });
    if (args.includes('project:list')) return { code: 0, stdout: table, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  bad.io.rest = async (call) => {
    if (call.method === 'GET' && call.path === `/baas/v1/project/${projectId}`) {
      return { status: 200, body: projectDetails(neighbor, SCOPE.org) };
    }
    return { status: 500, body: {} };
  };
  const refused = await deployCli([ds, '--project', projectId, '--org', '10000000000', '--projects', projects, '--confirm', '--function-env', 'new', '--ui', 'vanilla'], bad.io);
  assert.equal(refused, 1);
  assert.equal(bad.spawned.length, 1);
  assert.match(bad.stderr(), /project details did not report/);
});

test('a fake catalyst binary records argv and env, and a mismatched report aborts', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'c2c-fake-catalyst-'));
  // Pin CommonJS so a TMPDIR under a {"type":"module"} package.json cannot change how these fixtures load.
  writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}');
  const log = join(bin, 'calls.log');
  const script = join(bin, 'catalyst');
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const keys = Object.keys(process.env).filter((key) => key.startsWith('CATALYST_') || key.startsWith('ZC_') || key === 'X_ZC_CREDENTIAL_PATH').sort();
const picked = {};
for (const key of keys) picked[key] = process.env[key];
fs.appendFileSync(process.env.C2C_FAKE_LOG, JSON.stringify({ args, env: picked }) + '\\n');
if (args.includes('project:list')) {
  process.stdout.write(process.env.C2C_FAKE_MISMATCH === '1' ? ${JSON.stringify(COLLISION_PROJECT_LIST)} : ${JSON.stringify(FAITHFUL_PROJECT_LIST)});
}
process.exit(0);
`,
  );
  chmodSync(script, 0o755);
  // The function's dependency install runs before the functions deploy. A fake npm records it; nothing is installed.
  const npmLog = join(bin, 'npm.log');
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
`,
  );
  chmodSync(join(bin, 'npm'), 0o755);
  const ds = writeDs();
  const env = {
    X_ZC_CREDENTIAL_PATH: SECRET,
    CATALYST_ORG: WRONG_ORG,
    ZC_ORG_ID: WRONG_ORG,
    CATALYST_PROJECT_ID: PROTECTED,
    CATALYST_PROJECT: 'other',
    ZC_PROJECT_ID: PROTECTED,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: process.env.HOME,
    C2C_FAKE_LOG: log,
  };
  const mismatch = capture(env);
  mismatch.io.spawn = catalystSpawn;
  mismatch.io.env = { ...env, C2C_FAKE_MISMATCH: '1' };
  const refused = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new'], mismatch.io);
  assert.equal(refused, 1);
  assert.match(mismatch.stderr(), /did not report the guarded org and project/);
  assert.equal(mismatch.restCalls.length, 0);
  const refusedCalls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
  assert.equal(refusedCalls.length, 1);
  assert.ok(refusedCalls[0].args.includes('--org') && refusedCalls[0].args.includes('10000000000'));
  assert.ok(refusedCalls[0].args.includes('--project') && refusedCalls[0].args.includes('1001'));
  assert.equal(refusedCalls[0].env.CATALYST_ORG, undefined);
  assert.equal(refusedCalls[0].env.ZC_PROJECT_ID, undefined);
  assert.equal(refusedCalls[0].env.X_ZC_CREDENTIAL_PATH, SECRET);
  writeFileSync(log, '');
  const ok = capture(env);
  ok.io.spawn = catalystSpawn;
  const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new'], ok.io);
  assert.equal(code, 0);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
  assert.deepEqual(
    calls.map((call) => call.args.filter((arg) => arg === 'project:list' || arg === 'slate:link' || arg === 'deploy')),
    [['project:list'], ['deploy'], ['slate:link'], ['deploy']],
  );
  const npmCalls = readFileSync(npmLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; cwd: string });
  assert.equal(npmCalls.length, 1);
  assert.deepEqual(npmCalls[0].args, ['install', '--omit=dev', '--no-audit', '--no-fund']);
  assert.ok(npmCalls[0].cwd.endsWith(join('functions', 'c2c_api')));
  for (const call of calls) {
    const orgAt = call.args.indexOf('--org');
    const projectAt = call.args.indexOf('--project');
    assert.ok(orgAt >= 0 && orgAt < call.args.indexOf(call.args.includes('project:list') ? 'project:list' : call.args.includes('slate:link') ? 'slate:link' : 'deploy'));
    assert.equal(call.args[orgAt + 1], '10000000000');
    assert.equal(call.args[projectAt + 1], '1001');
    assert.equal(call.env.X_ZC_CREDENTIAL_PATH, SECRET);
    assert.equal(call.env.CATALYST_ORG, undefined);
    assert.equal(call.env.ZC_ORG_ID, undefined);
    assert.equal(call.env.CATALYST_PROJECT_ID, undefined);
    assert.equal(call.env.CATALYST_PROJECT, undefined);
    assert.equal(call.env.ZC_PROJECT_ID, undefined);
  }
  rmSync(bin, { recursive: true, force: true });
});

test('deploy guards refuse and do not spawn', async () => {
  const ds = writeDs();
  const cases: { args: string[]; env?: NodeJS.ProcessEnv; code: string }[] = [
    { args: ['--project', '1001', '--org', 'not-an-id'], code: 'is not a decimal id' },
    { args: ['--project', PROTECTED, '--org', '10000000000'], code: 'denylist' },
    { args: ['--project', '1002', '--org', '10000000000'], code: 'does not match' },
    { args: ['--project', '1001', '--org', '10000000000', '--env', 'Production'], code: 'Development' },
    { args: ['--project', '1001', '--org', '10000000000'], env: {}, code: 'X_ZC_CREDENTIAL_PATH is unset' },
  ];
  for (const item of cases) {
    const cap = capture(item.env ?? { X_ZC_CREDENTIAL_PATH: SECRET });
    const code = await deployCli([ds, ...item.args, '--projects', projectsFile(), '--confirm', '--function-env', 'new'], cap.io);
    assert.equal(code, 2, item.code);
    assert.equal(cap.spawned.length, 0, item.code);
    assert.equal(cap.fetched.length, 0, item.code);
    assert.equal(cap.restCalls.length, 0, item.code);
    assert.match(cap.stderr(), new RegExp(item.code));
    assert.equal(cap.stderr().includes(SECRET), false);
  }
});

test('post-deploy: a deploy that creates tables and functions lists exactly Data Store and Functions', () => {
  const services = servicesTouched({
    createdTables: ['Item'],
    createdColumns: ['Item.Name'],
    commands: [{ argv: ['--org', '10000000000', '--project', '1001', 'deploy', '--only', 'functions', '-ni'] }],
  });
  assert.deepEqual(services, ['Data Store', 'Functions']);
  // Created Data Store and Functions resources are listed with no extra console click.
  assert.deepEqual(postDeploySteps('1001', services), []);
  // Nothing created (tables already there, no deploy command) → no step.
  assert.deepEqual(postDeploySteps('1001', servicesTouched({ createdTables: [], createdColumns: [], commands: [] })), []);
  assert.deepEqual(servicesTouched({ commands: [{ argv: ['deploy', '--only', 'functions,client,cron'] }], extra: ['Cache', 'Stratus'] }), ['Functions', 'Web Client Hosting (Slate)', 'Cron', 'Cache', 'Stratus']);

  // A deploy that touched Slate + Authentication closes with the sign-in check.
  const slateAuth = postDeploySteps('1001', ['Functions', 'Authentication', 'Web Client Hosting (Slate)']);
  const signIn = slateAuth.find((step) => step.services.includes('Web Client Hosting (Slate)'));
  assert.match(signIn?.text ?? '', /the sign-in box must show the Catalyst sign-in page/);
  assert.match(signIn?.text ?? '', /iFrame on/);
  // A deploy that never touched Slate carries no sign-in check.
  assert.equal(postDeploySteps('1001', ['Functions', 'Authentication']).some((step) => /sign-in box/.test(step.text)), false);
});

test('post-deploy: deploy --confirm prints the configure steps and writes them to the deploy report', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-out-'));
  const cap = capture();
  const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out], cap.io);
  assert.equal(code, 0);
  // Created resources are not hidden behind a console click: the post-deploy
  // configure block lists no Slate start (the end-of-run human checklist is a
  // separate recap and may name it). The Slate client still lists Authentication settings.
  const postDeploy = cap.stdout().split('human checklist:')[0]!;
  assert.equal(postDeploy.includes('Start Exploring'), false);
  assert.match(cap.stdout(), /post-deploy \(console\):\n- Authentication: deploy POSTs \/authentication\/enable/);
  const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { exitCode: number; postDeploySteps: { kind: string; projectId: string; services: string[]; text: string }[] };
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.postDeploySteps.slice(0, 4), [
    {
      kind: 'configure',
      projectId: '1001',
      services: ['Authentication'],
      text: 'Authentication: deploy POSTs /authentication/enable (hosted + embedded, public signup off) and /cors-domain (Slate host, CORS on, iFrame on — the embedded sign-in frame needs it) — the CLI token cannot read them back, so confirm them in the console.',
    },
    {
      kind: 'configure',
      projectId: '1001',
      services: ['Functions'],
      text: "Serverless > Security Rules JSON: c2c_api '.*' authentication = required (List_All_Functions cannot verify it)",
    },
    {
      kind: 'configure',
      projectId: '1001',
      services: ['Authentication'],
      text: 'Users: on a fresh project (no app users yet, GET /role refused for the CLI token) the first admin is added with console Add User — deploy prints the exact values (Role, Platform = Web, Component = Slate + the app, Deployment = default, Redirect URL = the Slate app URL); with --admin-role-id or a role-readable token deploy sends POST /project-user instead. Either way deploy verifies the admin through GET /project-user once they accept the invite and sign in.',
    },
    {
      kind: 'configure',
      projectId: '1001',
      services: ['Web Client Hosting (Slate)'],
      text: 'Sign-in check: open the Slate app URL — the sign-in box must show the Catalyst sign-in page, not the app itself or a blank box. A blank box means iFrame is off for the host: Authentication > Whitelisting > the Slate host > Edit > iFrame on, then reload.',
    },
  ]);
  // The auth provisioning run appends one console step per op it could not do or confirm.
  for (const step of report.postDeploySteps.slice(4)) {
    assert.equal(step.kind, 'configure');
    assert.deepEqual(step.services, ['Authentication']);
  }
  rmSync(out, { recursive: true, force: true });
});

test('the dry-run plan lists the auth provisioning calls and sends nothing', async () => {
  const ds = writeDs();
  const cap = capture();
  const code = await deployCli(
    [...baseArgs(ds), '--slate-domain', 'https://c2c-widget-xyz.onslate.in/', '--admin-email', 'owner@example.test', '--admin-name', 'Owner', '--admin-role-id', '10000000000000003'],
    cap.io,
  );
  assert.equal(code, 0);
  const plan = cap.stdout();
  assert.match(plan, /auth provisioning \(API; not run\):\n/);
  assert.match(plan, /- GET \/baas\/v1\/project\/1001\/project-user —/);
  assert.match(plan, /- POST \/baas\/v1\/project\/1001\/authentication\/enable\?auth_type=hosted —/);
  assert.match(plan, /- POST \/baas\/v1\/project\/1001\/authentication\/enable\?auth_type=embedded —/);
  // The --slate-domain flag (URL form) normalises to the bare host in the plan.
  assert.match(plan, /- POST \/baas\/v1\/project\/1001\/cors-domain — authorise c2c-widget-xyz\.onslate\.in/);
  assert.match(plan, /- POST \/baas\/v1\/project\/1001\/project-user — invite the first admin/);
  assert.equal(cap.restCalls.length, 0);
  assert.equal(cap.spawned.length, 0);
});

test('deploy --confirm provisions auth with the recorded calls and reports them', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-out-'));
  const cap = capture();
  cap.io.spawn = async (command, args, opts) => {
    cap.spawned.push({ command, args, env: opts.env });
    if (args.includes('project:list')) return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
    if (args.includes('slate:link')) return { code: 0, stdout: 'Linking…\nApp Url: https://c2c-widget-xyz.onslate.in\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const code = await deployCli(
    [...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out, '--admin-email', 'owner@example.test', '--admin-name', 'Owner', '--admin-role-id', '10000000000000003'],
    cap.io,
  );
  assert.equal(code, 0, cap.stdout().slice(-800) + cap.stderr());
  const base = '/baas/v1/project/1001';
  const call = (method: string, path: string) => cap.restCalls.find((c) => c.method === method && c.path === path);
  // The config read is refused for the CLI token, so public_signup is omitted —
  // never written over a user setting deploy cannot see.
  assert.deepEqual(call('POST', `${base}/authentication/enable?auth_type=hosted`)?.body, {});
  assert.deepEqual(call('POST', `${base}/authentication/enable?auth_type=embedded`)?.body, {});
  // No --slate-domain flag: the host came from the captured slate:link "App Url:".
  assert.deepEqual(call('POST', `${base}/cors-domain`)?.body, { domain: 'c2c-widget-xyz.onslate.in', cors: true, iframe: true });
  assert.deepEqual(call('POST', `${base}/project-user`)?.body, {
    platform_type: 'web',
    redirect_url: 'https://c2c-widget-xyz.onslate.in',
    user_details: { email_id: 'owner@example.test', first_name: 'Owner', last_name: '', role_id: '10000000000000003' },
  });
  assert.equal(cap.restCalls.filter((c) => c.method === 'GET' && c.path === `${base}/project-user`).length, 1);
  assert.equal(cap.restCalls.filter((c) => c.method === 'GET' && c.path === `${base}/project-user/10000000000000004`).length, 1);
  // An explicit --admin-role-id skips role discovery entirely.
  assert.equal(cap.restCalls.some((c) => c.path.endsWith('/role')), false);
  assert.equal(cap.restCalls.some((c) => c.path.endsWith('/project-user/signup')), false);
  assert.match(cap.stdout(), /slate url: https:\/\/c2c-widget-xyz\.onslate\.in/);
  assert.match(cap.stdout(), /auth provisioning:/);
  assert.match(cap.stdout(), /enable-hosted: applied/);
  // The email is on the wire and nowhere else: output and report name "the
  // --admin-email user", and the persisted op entries carry no request body.
  assert.match(cap.stdout(), /admin-signup: applied — 200 — invite sent to the --admin-email user by POST \/project-user/);
  assert.match(cap.stdout(), /verify-users: console — the --admin-email user is unconfirmed in GET \/project-user\/<id>/);
  assert.equal(cap.stdout().includes('owner@example.test'), false);
  const state = JSON.parse(readFileSync(join(out, '.c2c-deploy-state.json'), 'utf8')) as { slateUrl?: string; authDone?: string[]; authAdminUserId?: string };
  assert.equal(state.slateUrl, 'https://c2c-widget-xyz.onslate.in');
  assert.equal(state.authAdminUserId, '10000000000000004');
  assert.deepEqual(state.authDone, ['admin-signup', 'cors-domain', 'enable-embedded', 'enable-hosted']);
  const reportText = readFileSync(join(out, DEPLOY_REPORT), 'utf8');
  const report = JSON.parse(reportText) as { exitCode: number; auth?: { id: string; status: string }[] };
  assert.equal(report.exitCode, 0);
  assert.deepEqual(
    report.auth?.map((op) => `${op.id}:${op.status}`),
    ['enable-hosted:applied', 'enable-embedded:applied', 'cors-domain:applied', 'admin-signup:applied', 'verify-users:pending'],
  );
  // Report entries are op/status/code/message only — no request bodies, so the
  // admin email and the role id never persist.
  for (const entry of report.auth ?? []) {
    for (const key of Object.keys(entry)) assert.ok(['id', 'status', 'code', 'message'].includes(key), key);
  }
  assert.equal(reportText.includes('owner@example.test'), false);
  assert.equal(reportText.includes('10000000000000003'), false);
  const stateText = readFileSync(join(out, '.c2c-deploy-state.json'), 'utf8');
  assert.equal(stateText.includes('owner@example.test'), false);
  assert.equal(cap.stdout().includes(SECRET), false);
  rmSync(out, { recursive: true, force: true });
});

test('a failed deploy command still provisions auth and writes the report', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-out-'));
  const cap = capture();
  cap.io.spawn = async (command, args, opts) => {
    cap.spawned.push({ command, args, env: opts.env });
    if (args.includes('project:list')) return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
    if (args.includes('slate:link')) return { code: 0, stdout: 'App Url: https://c2c-widget-xyz.onslate.in\n', stderr: '' };
    if (args.includes('slate')) return { code: 7, stdout: '', stderr: 'deploy slate blew up' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out, '--slate-domain', 'c2c-widget-xyz.onslate.in'], cap.io);
  assert.equal(code, 7);
  // The slate URL captured before the failure still drives the CORS write.
  assert.deepEqual(
    cap.restCalls.find((c) => c.method === 'POST' && c.path.endsWith('/cors-domain'))?.body,
    { domain: 'c2c-widget-xyz.onslate.in', cors: true, iframe: true },
  );
  const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { exitCode: number; auth?: { id: string; status: string }[]; postDeploySteps: { kind: string }[] };
  assert.equal(report.exitCode, 7);
  assert.equal(report.auth?.find((op) => op.id === 'enable-hosted')?.status, 'applied');
  assert.equal(report.auth?.find((op) => op.id === 'admin-signup')?.status, 'pending');
  // The resume step stays last; auth console steps sit before it.
  assert.equal(report.postDeploySteps.at(-1)?.kind, 'resume');
  rmSync(out, { recursive: true, force: true });
});

test('a slate deploy refused because the service was never opened names the console activation step', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-out-'));
  const cap = capture();
  cap.io.spawn = async (command, args, opts) => {
    cap.spawned.push({ command, args, env: opts.env });
    if (args.includes('project:list')) return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
    if (args.includes('slate:link')) return { code: 0, stdout: 'Linked\n', stderr: '' };
    if (args.includes('slate')) {
      // The recorded fresh-project response: the Slate service was never opened
      // in the console, so the first CLI deploy gets a 400 with this message.
      return {
        code: 1,
        stdout: '',
        stderr:
          'Deploy failed with status code 400. {"status":"failure","data":{"error_code":"INVALID_REQUEST","message":"Please access the Slate service in your project\'s console before deploying via the CLI."}}',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out], cap.io);
  assert.equal(code, 1);
  assert.match(cap.stderr(), /Start Exploring/, 'the refusal must name the console activation action');
  assert.match(cap.stderr(), /slate-enable/, 'the refusal must name the provision step that tracks it');
  // The guided ask carries the project's own Slate page.
  assert.match(cap.stderr(), /console\.catalyst\.zoho\.in\/baas\/10000000000\/project\/1001\/Development#\/slate/);
  const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { exitCode: number };
  assert.equal(report.exitCode, 1);
  rmSync(out, { recursive: true, force: true });
});

test('deploy --confirm verifies the Slate first-use gate before any write: closed stops with the checklist line, open continues', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-out-'));
  const cap = capture();
  cap.io.spawn = async (command, args, opts) => {
    cap.spawned.push({ command, args, env: opts.env });
    if (args.includes('project:list')) return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
    if (args.includes('slate:link')) return { code: 0, stdout: 'App Url: https://c2c-widget-xyz.onslate.in\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const inner = cap.io.rest!;
  let opened = false;
  cap.io.rest = async (call) => {
    if (!opened && call.method === 'GET' && call.path === '/slate/v1/project/1001/app') {
      cap.restCalls.push({ method: call.method, path: call.path });
      // A never-opened Slate service answers the "access the service" refusal.
      return { status: 400, body: { status: 'failure', data: { error_code: 'INVALID_REQUEST', message: "Please access the Slate service in your project's console before deploying via the CLI." } } };
    }
    return inner(call);
  };
  const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out], cap.io);
  assert.equal(code, 1);
  assert.match(cap.stderr(), /Slate first-use gate is closed \(GET \/slate\/v1\/project\/<project>\/app → 400 Please access the Slate service/);
  assert.match(cap.stderr(), /Checklist: Catalyst console → the project → Slate → Start Exploring \(https:\/\/console\.catalyst\.zoho\.in\/baas\/10000000000\/project\/1001\/Development#\/slate\)/);
  assert.match(cap.stderr(), /--resume --out /);
  assert.match(cap.stdout(), /Cloud Scale first-use gate verified open/);
  // Nothing was written: no table, auth or deploy step ran past the gate.
  assert.equal(cap.restCalls.filter((call) => call.method !== 'GET').length, 0);
  assert.equal(cap.spawned.some((item) => item.args.includes('deploy') || item.args.includes('slate:link')), false);
  // The user opens Slate; the same read answers open and the run continues.
  opened = true;
  const again = await deployCli([...baseArgs(ds), '--confirm', '--resume', '--function-env', 'new', '--out', out], cap.io);
  assert.equal(again, 0, cap.stderr());
  assert.match(cap.stdout(), /Slate first-use gate verified open \(GET \/slate\/v1\/project\/<project>\/app → 200\)/);
  assert.ok(cap.spawned.some((item) => item.args.includes('slate:link')));
  rmSync(out, { recursive: true, force: true });
});

test('an unrecognised Slate probe answer stops deploy --confirm like a closed gate', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-out-'));
  const cap = capture();
  cap.io.spawn = async (command, args, opts) => {
    cap.spawned.push({ command, args, env: opts.env });
    if (args.includes('project:list')) return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const inner = cap.io.rest!;
  cap.io.rest = async (call) => (call.path === '/slate/v1/project/1001/app' ? { status: 503, body: {} } : inner(call));
  assert.equal(await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out], cap.io), 1);
  assert.match(cap.stderr(), /Slate first-use gate could not be verified/);
  assert.equal(cap.restCalls.filter((call) => call.method !== 'GET').length, 0);
  rmSync(out, { recursive: true, force: true });
});

test('a plain second --confirm re-runs the deploy commands but never re-posts auth ops', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-out-'));
  const cap = capture();
  cap.io.spawn = async (command, args, opts) => {
    cap.spawned.push({ command, args, env: opts.env });
    if (args.includes('project:list')) return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
    if (args.includes('slate:link')) return { code: 0, stdout: 'App Url: https://c2c-widget-xyz.onslate.in\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const args = [...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out, '--admin-email', 'owner@example.test', '--admin-role-id', '10000000000000003'];
  assert.equal(await deployCli(args, cap.io), 0);
  const restCount = cap.restCalls.length;
  const spawnCount = cap.spawned.length;
  // Same run again, no --resume: the state file alone makes auth idempotent.
  assert.equal(await deployCli(args, cap.io), 0);
  const second = cap.restCalls.slice(restCount);
  assert.equal(second.filter((call) => call.method === 'POST').length, 0);
  // The deploy commands still ran — idempotency is scoped to the auth ops.
  assert.ok(cap.spawned.length > spawnCount);
  const state = JSON.parse(readFileSync(join(out, '.c2c-deploy-state.json'), 'utf8')) as { authDone?: string[]; authAdminUserId?: string };
  assert.equal(state.authAdminUserId, '10000000000000004');
  assert.deepEqual(state.authDone, ['admin-signup', 'cors-domain', 'enable-embedded', 'enable-hosted']);
  rmSync(out, { recursive: true, force: true });
});

test('a mid-provision failure persists the landed ops, and --resume posts only the rest', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-out-'));
  const cap = capture();
  cap.io.spawn = async (command, args, opts) => {
    cap.spawned.push({ command, args, env: opts.env });
    if (args.includes('project:list')) return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
    if (args.includes('slate:link')) return { code: 0, stdout: 'App Url: https://c2c-widget-xyz.onslate.in\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const inner = cap.io.rest!;
  let corsDown = true;
  cap.io.rest = async (call) => {
    if (corsDown && call.method === 'POST' && call.path.endsWith('/cors-domain')) {
      return { status: 500, body: { data: { error_code: 'INTERNAL_ERROR', message: 'upstream blew up' } } };
    }
    return inner(call);
  };
  const args = [...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out, '--admin-email', 'owner@example.test', '--admin-role-id', '10000000000000003'];
  // The ops that landed stay landed; a partial auth failure warns but does not fail the deploy.
  assert.equal(await deployCli(args, cap.io), 0);
  const stateAfter = JSON.parse(readFileSync(join(out, '.c2c-deploy-state.json'), 'utf8')) as { authDone?: string[] };
  assert.ok(stateAfter.authDone?.includes('enable-hosted'));
  assert.ok(stateAfter.authDone?.includes('enable-embedded'));
  assert.equal(stateAfter.authDone?.includes('cors-domain'), false);
  assert.match(cap.stdout(), /warning: 1 auth op failed/);
  corsDown = false;
  const restCount = cap.restCalls.length;
  assert.equal(await deployCli([...args, '--resume'], cap.io), 0);
  const second = cap.restCalls.slice(restCount);
  assert.deepEqual(
    second.filter((call) => call.method === 'POST').map((call) => call.path),
    ['/baas/v1/project/1001/cors-domain'],
  );
  const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { exitCode: number };
  assert.equal(report.exitCode, 0);
  rmSync(out, { recursive: true, force: true });
});

test('when every auth call fails the deploy writes the report and exits non-zero', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-out-'));
  const cap = capture();
  const inner = cap.io.rest!;
  cap.io.rest = async (call) => {
    if (/\/(authentication|project-user|cors-domain)/.test(call.path)) {
      return { status: 500, body: { data: { error_code: 'INTERNAL_ERROR', message: 'backend down' } } };
    }
    return inner(call);
  };
  const code = await deployCli(
    [
      ...baseArgs(ds),
      '--confirm',
      '--function-env',
      'new',
      '--out',
      out,
      '--slate-domain',
      'c2c-widget-xyz.onslate.in',
      '--admin-email',
      'owner@example.test',
      '--admin-role-id',
      '10000000000000003',
    ],
    cap.io,
  );
  assert.equal(code, 1);
  const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as {
    exitCode: number;
    auth?: { id: string; status: string; code?: string; message?: string }[];
  };
  assert.equal(report.exitCode, 1);
  assert.ok(report.auth && report.auth.length > 0);
  assert.equal(report.auth?.every((op) => op.status === 'failed'), true);
  // Failures report code AND sanitised message — never a bare "HTTP 500".
  const hosted = report.auth?.find((op) => op.id === 'enable-hosted');
  assert.equal(hosted?.code, 'INTERNAL_ERROR');
  assert.match(hosted?.message ?? '', /HTTP 500 INTERNAL_ERROR — backend down/);
  rmSync(out, { recursive: true, force: true });
});

test('a thrown auth transport still writes the report and exits non-zero', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-out-'));
  const cap = capture();
  const inner = cap.io.rest!;
  cap.io.rest = async (call) => {
    if (/\/(authentication|project-user|cors-domain)/.test(call.path)) throw new Error('socket hang up');
    return inner(call);
  };
  const code = await deployCli(
    [
      ...baseArgs(ds),
      '--confirm',
      '--function-env',
      'new',
      '--out',
      out,
      '--slate-domain',
      'c2c-widget-xyz.onslate.in',
      '--admin-email',
      'owner@example.test',
      '--admin-role-id',
      '10000000000000003',
    ],
    cap.io,
  );
  assert.equal(code, 1);
  const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as {
    exitCode: number;
    auth?: { id: string; status: string; message?: string }[];
  };
  assert.equal(report.exitCode, 1);
  assert.equal(report.auth?.every((op) => op.status === 'failed'), true);
  assert.match(report.auth?.find((op) => op.id === 'enable-hosted')?.message ?? '', /transport error/);
  rmSync(out, { recursive: true, force: true });
});

test('the plan is stable across a re-run', () => {
  const guard = checkGuards({ org: '10000000000', projectId: '1001', appLink: 'Widget', credentialPath: SECRET, registry });
  const app = deriveIr(parse(DS));
  const first = buildDeploy(app, guard, false);
  const second = buildDeploy(app, guard, false);
  assert.equal(first.plan, second.plan);
  assert.equal(first.plan.includes('SECRET_VALUE_SHOULD_NOT_PRINT'), false);
});

test('mail stays disabled unless enabled, and then only configured test recipients pass', () => {
  const configured = ['owner@example.com'];
  assert.equal(decideMail(mailConfig(false), configured).ok, false);
  assert.equal(decideMail(mailConfig(false, configured), configured).ok, false);
  // Fail-closed: no testRecipients means nobody can receive, even with --mail.
  assert.equal(decideMail(mailConfig(true), configured).ok, false);
  assert.equal(decideMail(mailConfig(true), []).ok, false);
  assert.equal(decideMail(mailConfig(true, configured), configured).ok, true);
  assert.equal(decideMail(mailConfig(true, configured), ['other@example.com']).ok, false);
  assert.equal(decideMail(mailConfig(true, configured), [...configured, 'other@example.com']).ok, false);
  assert.equal(decideMail(mailConfig(true, configured), []).ok, false);
  assert.equal(decideMail(undefined, configured).ok, false);
});

test('buildDeploy bakes configured test recipients into the mail files, default none', () => {
  const guard = checkGuards({ org: '10000000000', projectId: '1001', appLink: 'Widget', credentialPath: SECRET, registry });
  // The mail module ships only when a generated function sends mail.
  const mailDs = DS.replace(
    'x = 1;',
    'sendmail [ from: zoho.adminuserid to: "owner@example.com" subject: "s" message: "m" ];',
  );
  const app = deriveIr(parse(mailDs));
  const empty = buildDeploy(app, guard, true);
  assert.deepEqual(empty.mail.allowlist, []);
  assert.match(empty.plan, /^allowlist:\s*$/m);
  const emptyMailFile = empty.files.find((file) => file.path === 'c2c-mail.json');
  assert.deepEqual((JSON.parse(String(emptyMailFile?.data)) as { allowlist: string[] }).allowlist, []);
  const emptyModule = empty.files.find((file) => file.path.endsWith('c2c-mail.mjs'));
  assert.ok(String(emptyModule?.data).includes('export const MAIL_ALLOWLIST = []'));
  assert.ok(String(emptyModule?.data).includes('no test recipients configured'));

  const configured = buildDeploy(app, guard, true, false, undefined, undefined, {}, undefined, ['owner@example.com']);
  assert.deepEqual(configured.mail.allowlist, ['owner@example.com']);
  assert.match(configured.plan, /^allowlist: owner@example.com$/m);
  const module = configured.files.find((file) => file.path.endsWith('c2c-mail.mjs'));
  assert.ok(String(module?.data).includes('"owner@example.com"'));
});

test('seed migrate without --confirm does not call the network', async () => {
  const seed = writeSeed();
  const cap = capture();
  const code = await seedMigrateCli(
    ['--seed', seed, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile()],
    cap.io,
  );
  assert.equal(code, 0);
  assert.equal(cap.fetched.length, 0);
  assert.match(cap.stdout(), /writes: no/);
  assert.match(cap.stdout(), /Item source 2/);
  assert.match(cap.stdout(), /skipped:\n- none/);
  assert.equal(cap.stdout().includes(SECRET), false);
});

test('seed migrate is idempotent via c2c_source_id and fails a short count', async () => {
  const tables = [
    {
      table: 'Item',
      rows: [
        { id: 's1', columns: { Name: 'a' } },
        { id: 's2', columns: { Name: 'b' } },
      ],
    },
  ];
  const stored = new Map<string, Record<string, unknown>>();
  const posts: string[][] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') throw new Error('seed migrate called Creator');
    assertScopedCall(url, init);
    if (new URL(url).pathname.endsWith('/query')) {
      return response({ data: [...stored.values()].map((columns) => ({ ...columns })) });
    }
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns: Record<string, unknown> }[] };
    posts.push(body.rows.map((row) => row.id));
    for (const row of body.rows) stored.set(row.id, { ...row.columns });
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const first = await migrateSeed({
    tables,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(first.ok, true);
  assert.equal(first.tables[0].sourceCount, 2);
  assert.equal(first.tables[0].writtenCount, 2);
  assert.deepEqual(posts, [['s1', 's2']]);
  const second = await migrateSeed({
    tables,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(second.ok, true);
  assert.equal(second.tables[0].sourceCount, second.tables[0].writtenCount);
  assert.deepEqual(posts, [['s1', 's2']]);
  const short = await migrateSeed({
    tables,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch: async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') throw new Error('seed migrate called Creator');
      assertScopedCall(url, init);
      if (new URL(url).pathname.endsWith('/query')) return response({ data: [] });
      return response({ ids: [] });
    },
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(short.ok, false);
  assert.equal(short.tables[0].mismatch, true);
  assert.notEqual(short.tables[0].sourceCount, short.tables[0].writtenCount);
});

test('seed migrate --confirm reports counts and a guard skips the write', async () => {
  const seed = writeSeed();
  const stored = new Map<string, Record<string, unknown>>();
  const cap = capture(undefined, '10000000000');
  cap.io.fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') throw new Error('seed migrate called Creator');
    assertScopedCall(url, init, '10000000000');
    if (new URL(url).pathname.endsWith('/query')) return response({ data: [...stored.values()].map((columns) => ({ ...columns })) });
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns: Record<string, unknown> }[] };
    for (const row of body.rows) stored.set(row.columns.c2c_source_id as string, { ...row.columns });
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const args = ['--seed', seed, '--ds', itemDs(dirname(seed)), '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile(), '--confirm'];
  const code = await seedMigrateCli(args, cap.io);
  assert.equal(code, 0);
  assert.match(cap.stdout(), /Item: source 2 written 2 mismatch false/);
  assert.match(cap.stdout(), /skipped:\n- none/);
  const blocked = capture();
  const refused = await seedMigrateCli(
    ['--seed', seed, '--app', 'Widget', '--project', PROTECTED, '--org', '10000000000', '--projects', projectsFile(), '--confirm'],
    blocked.io,
  );
  assert.equal(refused, 2);
  assert.equal(blocked.fetched.length, 0);
});

const SMOKE_DS = `application "Widget"
{
	time zone = "Asia/Kolkata"
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
			Status
			(
				type = picklist
				values = {"Draft","Closed"}
			)
		}
		list Open_Items
		{
			displayName = "Open"
			show all rows from Item
		}
	}
}
`;

function smokeGuard(app: ReturnType<typeof deriveIr>) {
  return checkGuards({ org: SCOPE.org, projectId: '1001', appLink: app.name ?? '', credentialPath: SECRET, registry });
}

function smokeInputs(app: ReturnType<typeof deriveIr>) {
  const { files, schema } = deployFiles(app, smokeGuard(app), false, { mode: 'dry-run' });
  const routesFile = files.find((file) => file.path === 'functions/c2c_api/routes.json');
  assert.ok(routesFile, 'deploy bundle writes functions/c2c_api/routes.json');
  const routes = JSON.parse(String(routesFile.data)) as Record<string, string>;
  return { routes, model: generateUi(app).model, schema };
}

/** In-memory answer to the smoke calls: function paths + the /baas/v1 query surface. */
function smokeFetch(store: Record<string, Record<string, string>[]>, calls: { method: string; url: string; headers?: Record<string, string>; body?: string }[]): FetchLike {
  const query = (sql: string) => {
    const del = /^DELETE FROM (\w+) WHERE ROWID = (\d+)$/.exec(sql);
    if (del) {
      const rows = store[del[1]] ?? [];
      const at = rows.findIndex((row) => row.ROWID === del[2]);
      if (at >= 0) rows.splice(at, 1);
      return response({ status: 'success', data: { DELETED_ROWS_COUNT: at >= 0 ? 1 : 0 } });
    }
    const sel = /^SELECT \* FROM (\w+)(?: WHERE ROWID = (\d+))?(?: ORDER BY ROWID)? LIMIT 0, (\d+)$/.exec(sql);
    assert.ok(sel, `unexpected ZCQL: ${sql}`);
    const rows = (store[sel[1]] ?? []).filter((row) => !sel[2] || row.ROWID === sel[2]).slice(0, Number(sel[3]));
    return response({ status: 'success', data: rows.map((row) => ({ [sel[1]]: { ...row } })) });
  };
  return async (url, init) => {
    calls.push({ method: init?.method ?? 'GET', url, headers: init?.headers, body: init?.body });
    const u = new URL(url);
    if (u.pathname === '/') return { status: 404, headers: { get: () => null }, text: async () => '' };
    if (u.pathname.endsWith('/baas/v1/project/1001/query')) {
      assertScopedCall(url, init);
      return query(JSON.parse(init?.body ?? '{}').query);
    }
    const submit = /^\/server\/c2c_api\/forms\/(\w+)\/submit$/.exec(u.pathname);
    if (submit) {
      const record = JSON.parse(init?.body ?? '{}').record ?? {};
      const rowid = `10000000000100${(store[submit[1]] ?? []).length + 1}1`;
      const row = { ...record, ROWID: rowid };
      (store[submit[1]] ??= []).push(row);
      return response({ dryRun: false, wrote: true, values: row });
    }
    const lookup = /^\/server\/c2c_api\/lookups\/(\w+)\/(\w+)$/.exec(u.pathname);
    if (lookup) {
      const rows = store[lookup[1]] ?? [];
      return response({ dryRun: false, rows: rows.map((row) => ({ ROWID: row.ROWID, [lookup[2]]: row[lookup[2]] })) });
    }
    if (u.pathname === '/server/c2c_api/admin/smoke') {
      const body = JSON.parse(init?.body ?? '{}') as { op?: string; form?: string; rowId?: string; fields?: Record<string, string> };
      if (body.op === 'update') {
        const row = (store[body.form ?? ''] ?? []).find((item) => item.ROWID === String(body.rowId));
        if (!row) return response({ error: 'no such row' }, 404);
        Object.assign(row, body.fields ?? {});
        return response({ dryRun: false, updated: true });
      }
      return response({ dryRun: false, ok: true });
    }
    const report = /^\/server\/c2c_api\/reports\/(\w+)$/.exec(u.pathname);
    if (report) return response({ dryRun: false, rows: [] });
    return response({ error: 'no such endpoint' }, 404);
  };
}

test('smoke dry-run plans the generated routes and calls nothing', async () => {
  const ds = writeDs(undefined, SMOKE_DS);
  const cap = capture();
  const planned = await smokeCli(baseArgs(ds), cap.io);
  assert.equal(planned, 0);
  assert.equal(cap.fetched.length, 0, 'a dry run makes no network calls');
  assert.match(cap.stdout(), /confirm: no/);
  assert.match(cap.stdout(), /executed: no/);
  // The route and method come from the generated routes.json: reports are POST, not GET.
  assert.match(cap.stdout(), /submit Item: POST \/forms\/Item\/submit/);
  assert.match(cap.stdout(), /report Open_Items: POST \/reports\/Open_Items/);
  assert.equal(cap.stdout().includes('SECRET_VALUE_SHOULD_NOT_PRINT'), false);
});

test('smoke plans the deluge submit endpoint when on success replaces /submit', async () => {
  // The default DS has an `on success` handler: the generated submit route is
  // POST /forms/Item/success and there is no /forms/Item/submit at all.
  const ds = writeDs();
  const cap = capture();
  const planned = await smokeCli(baseArgs(ds), cap.io);
  assert.equal(planned, 0);
  assert.equal(cap.fetched.length, 0);
  assert.match(cap.stdout(), /submit Item: POST \/forms\/Item\/success/, 'the real generated route is the submit step');
  assert.equal(cap.stdout().includes('/forms/Item/submit —'), false, 'no invented submit path');
  const refused = capture();
  const status = await smokeCli(
    [ds, '--project', '1001', '--org', '10000000000', '--projects', projectsFile(), '--env', 'Production', '--confirm', '--url', 'https://app.example.test'],
    refused.io,
  );
  assert.equal(status, 2);
  assert.equal(refused.fetched.length, 0);
});

test('smoke --confirm reports confirm: yes, sends the session, and deletes only its rows', async () => {
  const ds = writeDs(undefined, SMOKE_DS);
  const live = capture();
  const store: Record<string, Record<string, string>[]> = {};
  const calls: { method: string; url: string; headers?: Record<string, string>; body?: string }[] = [];
  live.io.fetch = smokeFetch(store, calls);
  const code = await smokeCli(
    [...baseArgs(ds), '--confirm', '--url', 'https://app.example.test/server/c2c_api', '--session-cookie', 'sess=abc123'],
    live.io,
  );
  assert.equal(code, 0, live.stdout());
  assert.match(live.stdout(), /confirm: yes/);
  assert.match(live.stdout(), /executed: yes/);
  // Item's required lookup resolves to the Vendor row this run created.
  const itemSubmit = calls.find((call) => call.url.endsWith('/forms/Item/submit'));
  assert.ok(itemSubmit);
  const record = JSON.parse(itemSubmit.body ?? '{}').record;
  assert.equal(typeof record.Item_Name, 'string');
  assert.ok(record.Item_Name.length > 0, 'a must-have field is filled');
  assert.equal(record.Vendor, '1000000000010011', 'lookup resolves to the smoke-created Vendor row');
  // The session cookie rides on the function calls; nothing hits an ungenerated route.
  assert.equal(itemSubmit.headers?.cookie, 'sess=abc123');
  assert.equal(calls.some((call) => call.url.includes('/success')), false, 'no call to a route that is not in routes.json');
  assert.equal(calls.some((call) => call.url.includes('/reports/') && call.method !== 'POST'), false, 'reports are POST');
  // Every row this run created is gone.
  assert.equal((store.Item ?? []).length, 0);
  assert.equal((store.Vendor ?? []).length, 0);
});

test('smoke --confirm fails when every endpoint answers 200 non-JSON', async () => {
  // A 200 HTML reply is not authorization and not a write — a run that touched
  // only such endpoints must not report a pass.
  const ds = writeDs(undefined, SMOKE_DS);
  const cap = capture();
  cap.io.fetch = async () => ({ status: 200, headers: { get: () => null }, text: async () => '<html><body>Sign in</body></html>' });
  const code = await smokeCli(
    [...baseArgs(ds), '--confirm', '--url', 'https://app.example.test/server/c2c_api', '--auth-token', 'tok-1'],
    cap.io,
  );
  assert.equal(code, 1, cap.stdout());
  assert.match(cap.stdout(), /nothing was exercised|dry-run/);
});

test('smoke --confirm fails a report-only plan whose report answers 200 non-JSON', async () => {
  // A sign-in page answers 200 HTML — a report step must require the
  // documented rows shape, or a submit-less plan passes on the login wall.
  const app = deriveIr(parse(SMOKE_DS));
  const steps = planSmoke(app, smokeInputs(app)).filter((step) => step.kind === 'session' || step.kind === 'report');
  assert.ok(steps.some((step) => step.kind === 'report'), 'the plan carries a report step');
  const walled = await executeSmoke(steps, {
    fetch: async () => ({ status: 200, headers: { get: () => null }, text: async () => '<html><body>Sign in</body></html>' }),
    base: 'https://app.example.test/server/c2c_api',
    auth: { token: 'tok-1' },
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
  });
  assert.equal(walled.ok, false, `a 200 HTML report answer is not a pass:\n${walled.lines.join('\n')}`);
  // The same plan on the documented report shape passes.
  const fine = await executeSmoke(steps, {
    fetch: async () => ({ status: 200, headers: { get: () => null }, text: async () => '{"rows":[]}' }),
    base: 'https://app.example.test/server/c2c_api',
    auth: { token: 'tok-1' },
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
  });
  assert.equal(fine.ok, true, fine.lines.join('\n'));
});

test('smoke --confirm without an app credential calls nothing and gives the in-browser step instead', async () => {
  const ds = writeDs(undefined, SMOKE_DS);
  const live = capture();
  const calls: string[] = [];
  live.io.fetch = async (url) => {
    calls.push(new URL(url).pathname);
    return { status: 404, headers: { get: () => null }, text: async () => '' };
  };
  const code = await smokeCli([...baseArgs(ds), '--confirm', '--url', 'https://app.example.test/server/c2c_api'], live.io);
  assert.equal(code, 4);
  assert.match(live.stdout(), /#\/admin\/smoke.* in your own browser/);
  assert.match(live.stdout(), /--result-code <code>/);
  assert.match(live.stdout(), /--result smoke-result\.txt/);
  assert.doesNotMatch(live.stdout(), /--auth-token|--session-cookie/);
  assert.deepEqual(calls, [], 'nothing is called without an app credential');
});

test('smoke sends the customer token as the authorization header and never prints it', async () => {
  const ds = writeDs(undefined, SMOKE_DS);
  const cap = capture({ X_ZC_CREDENTIAL_PATH: SECRET, C2C_SMOKE_AUTH_TOKEN: 'tok-77-SECRET' });
  const store: Record<string, Record<string, string>[]> = {};
  const calls: { method: string; url: string; headers?: Record<string, string>; body?: string }[] = [];
  cap.io.fetch = smokeFetch(store, calls);
  const code = await smokeCli([...baseArgs(ds), '--confirm', '--url', 'https://app.example.test/server/c2c_api'], cap.io);
  assert.equal(code, 0, cap.stdout());
  const submit = calls.find((call) => call.url.includes('/forms/'));
  assert.equal(submit?.headers?.authorization, 'tok-77-SECRET', 'the token is sent like the generated client sends it');
  assert.equal(cap.stdout().includes('tok-77-SECRET'), false, 'the token is never printed');
  assert.equal(cap.stderr().includes('tok-77-SECRET'), false);
});

test('smoke resolves a lookup to an existing parent row and never deletes it', async () => {
  const ds = writeDs(undefined, SMOKE_DS);
  const live = capture();
  // Vendor submit fails, so Item's required lookup falls back to a row that was already there.
  const store: Record<string, Record<string, string>[]> = { Vendor: [{ Vendor_Name: 'old', ROWID: '10000000000099001' }] };
  const calls: { method: string; url: string; headers?: Record<string, string>; body?: string }[] = [];
  const base = smokeFetch(store, calls);
  live.io.fetch = async (url, init) => {
    if (url.includes('/forms/Vendor/submit')) return response({ dryRun: false, wrote: false, error: 'refused' }, 403);
    return base(url, init);
  };
  const code = await smokeCli(
    [...baseArgs(ds), '--confirm', '--url', 'https://app.example.test/server/c2c_api', '--session-cookie', 'sess=abc123'],
    live.io,
  );
  assert.equal(code, 1, 'the failed submit fails the run');
  const itemSubmit = calls.find((call) => call.url.endsWith('/forms/Item/submit'));
  assert.equal(JSON.parse(itemSubmit?.body ?? '{}').record?.Vendor, '10000000000099001', 'lookup falls back to an existing parent row');
  const deletes = calls.filter((call) => (call.body ?? '').includes('DELETE FROM')).map((call) => call.body ?? '');
  assert.equal(deletes.some((body) => body.includes('10000000000099001')), false, 'a pre-existing row is never deleted');
  assert.ok(deletes.some((body) => body.includes('DELETE FROM Item')), 'the created Item row is deleted');
  assert.equal((store.Vendor ?? []).length, 1, 'the pre-existing Vendor row survives');
});

test('smoke skips a required lookup whose target has no table, with a reason', async () => {
  const ds = writeDs(
    undefined,
    `application "Widget"
{
	time zone = "Asia/Kolkata"
	section S
	{
		form Item
		{
			must have Item_Name
			(
				type = text
			)
			must have Ghost
			(
				type = picklist
				values = Ghost.Name
			)
		}
	}
}
`,
  );
  const live = capture();
  const calls: { method: string; url: string; body?: string }[] = [];
  live.io.fetch = smokeFetch({}, calls);
  const code = await smokeCli(
    [...baseArgs(ds), '--confirm', '--url', 'https://app.example.test/server/c2c_api', '--session-cookie', 'sess=abc123'],
    live.io,
  );
  assert.equal(code, 0, live.stdout());
  assert.match(live.stdout(), /Ghost: skipped|skipped.*Ghost/i, 'the lookup is skipped with a reason');
  const submit = calls.find((call) => call.url.endsWith('/forms/Item/submit'));
  const record = JSON.parse(submit?.body ?? '{}').record;
  assert.equal(typeof record.Item_Name, 'string');
  assert.equal(record.Ghost, undefined, 'the unresolvable lookup is not invented');
});

test('smoke cleanup runs only after a successful read-back', async () => {
  const ds = writeDs(undefined, SMOKE_DS);
  const live = capture();
  const store: Record<string, Record<string, string>[]> = {};
  const calls: { method: string; url: string; body?: string }[] = [];
  const base = smokeFetch(store, calls);
  live.io.fetch = async (url, init) => {
    // read-back queries see nothing, so nothing may be deleted.
    if (url.includes('/query') && (init?.body ?? '').includes('SELECT')) {
      return response({ status: 'success', data: [] });
    }
    return base(url, init);
  };
  const code = await smokeCli(
    [...baseArgs(ds), '--confirm', '--url', 'https://app.example.test/server/c2c_api', '--session-cookie', 'sess=abc123'],
    live.io,
  );
  assert.equal(code, 1);
  const deletes = calls.filter((call) => (call.body ?? '').includes('DELETE FROM'));
  assert.equal(deletes.length, 0, 'no delete without a verified read-back');
  assert.match(live.stdout(), /read-back .*(missing|failed)/i);
});

test('planSmoke lists a submit and read-back per form, report queries, skips and cleanup', () => {
  const app = deriveIr(parse(SMOKE_DS));
  const inputs = smokeInputs(app);
  // One route that is neither a submit nor a report: it must appear as a skip, never a call.
  inputs.routes['POST /reports/Open_Items/actions/export'] = './reports/open-items-action-export.mjs';
  const steps = planSmoke(app, inputs);
  assert.deepEqual(
    steps.map((step) => step.kind).filter((kind) => kind !== 'skip'),
    // Vendor's only writable field is the run marker — updating it would defeat
    // marker-scoped cleanup, so only Item gets an update + re-read.
    ['session', 'submit', 'read-back', 'submit', 'read-back', 'update', 'read-back', 'report', 'cleanup', 'cleanup'],
  );
  assert.equal(steps[1].method, 'POST');
  assert.equal(steps[1].path, '/forms/Vendor/submit');
  const report = steps.find((step) => step.kind === 'report');
  assert.equal(report?.path, '/reports/Open_Items');
  assert.equal(report?.method, 'POST');
  const skipped = steps.filter((step) => step.kind === 'skip');
  // The upload route is generated but unused (no file field here): a skip.
  // The lookup route is claimed — the Item read-back resolves the display value.
  assert.equal(
    skipped.some((step) => step.path === '/lookups/:form/:field'),
    false,
    'the read-back claims the lookup route',
  );
  const itemReadBack = steps.find((step) => step.kind === 'read-back' && step.form === 'Item');
  assert.ok(itemReadBack?.lookups?.some((check) => check.endpoint === '/lookups/Vendor/Vendor_Name'), 'lookup display check planned');
  assert.ok(skipped.some((step) => step.path === '/uploads/:form/:field'));
  const action = skipped.find((step) => step.path === '/reports/Open_Items/actions/export');
  assert.ok(action, 'a custom action is a skip, never a call');
  assert.ok(skipped.every((step) => step.reason), 'every skip names a reason');
});

/**
 * The call-logs shape: a composite name, a required email (the run marker), a
 * choice field whose validate rule keys on the initial value, two datetimes an
 * on-validate rule orders (start < end), a lookup parent, and an owner-scoped
 * report criteria (`Call_Owner.Email == zoho.loginuserid`).
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
}
`;

test('planSmoke gives every datetime a distinct stamp and the choice field its initial value', () => {
  const app = deriveIr(parse(CALLS_DS));
  const steps = planSmoke(app, smokeInputs(app));
  const call = steps.find((step) => step.kind === 'submit' && step.form === 'Call');
  const start = call?.record?.find((plan) => plan.name === 'Call_Start_Time');
  const end = call?.record?.find((plan) => plan.name === 'Call_End_Time');
  assert.equal(typeof start?.value, 'string');
  assert.equal(typeof end?.value, 'string');
  assert.ok(String(start?.value) < String(end?.value), 'a start >= end pair fails the fixture on-validate rule');
  const followUp = call?.record?.find((plan) => plan.name === 'Follow_up_Required');
  assert.equal(followUp?.value, 'No', 'the field initial value wins over the first choice');
});

test('planSmoke marks the marker field for the run tag, never a canned value', () => {
  const app = deriveIr(parse(CALLS_DS));
  const steps = planSmoke(app, smokeInputs(app));
  const rep = steps.find((step) => step.kind === 'submit' && step.form === 'Rep');
  const email = rep?.record?.find((plan) => plan.name === 'Email');
  assert.ok(email, 'Email is the marker field — required, writable, text-family');
  assert.equal(email?.value, undefined, 'recordFor writes "c2c smoke <tag>", not a canned email');
  const name = rep?.record?.find((plan) => plan.name === 'Name');
  assert.ok(name?.children?.some((child) => child.name === 'first_name'));
  assert.ok(name?.children?.some((child) => child.name === 'last_name'));
});

test('a submit that writes then fails still tracks the row for cleanup', async () => {
  const ds = writeDs(undefined, SMOKE_DS);
  const live = capture();
  const store: Record<string, Record<string, string>[]> = {};
  const calls: { method: string; url: string; headers?: Record<string, string>; body?: string }[] = [];
  const base = smokeFetch(store, calls);
  live.io.fetch = async (url, init) => {
    if (url.endsWith('/forms/Vendor/submit')) {
      // The row committed but a post-write handler refused — the 500 reply
      // still carries values.ROWID.
      const record = JSON.parse(init?.body ?? '{}').record ?? {};
      const row = { ...record, ROWID: '999001' };
      (store.Vendor ??= []).push(row);
      return response({ dryRun: false, wrote: true, values: row, error: 'post-write handler refused' }, 500);
    }
    return base(url, init);
  };
  const code = await smokeCli(
    [...baseArgs(ds), '--confirm', '--url', 'https://app.example.test/server/c2c_api', '--session-cookie', 'sess=abc123'],
    live.io,
  );
  assert.equal(code, 1, 'the failed submit still fails the run');
  assert.match(live.stdout(), /submit Vendor: 500 .*tracked for cleanup/);
  const deletes = calls.filter((call) => (call.body ?? '').includes('DELETE FROM Vendor'));
  assert.equal(deletes.length, 1, 'the written row is deleted, not orphaned');
  assert.equal((store.Vendor ?? []).length, 0);
});

test('a committed submit answered 200 with a post-commit warning is tracked, named, and deleted', async () => {
  const ds = writeDs(undefined, SMOKE_DS);
  const live = capture();
  const store: Record<string, Record<string, string>[]> = {};
  const calls: { method: string; url: string; headers?: Record<string, string>; body?: string }[] = [];
  const base = smokeFetch(store, calls);
  live.io.fetch = async (url, init) => {
    if (url.endsWith('/forms/Vendor/submit')) {
      const record = JSON.parse(init?.body ?? '{}').record ?? {};
      const row = { ...record, ROWID: '999002' };
      (store.Vendor ??= []).push(row);
      return response({ dryRun: false, wrote: true, values: row, warning: { code: 'POST_COMMIT_FAILED', message: 'The record was saved. An action after the save did not complete.', requestId: 'r1' } });
    }
    return base(url, init);
  };
  await smokeCli([...baseArgs(ds), '--confirm', '--url', 'https://app.example.test/server/c2c_api', '--session-cookie', 'sess=abc123'], live.io);
  assert.match(live.stdout(), /submit Vendor: 200 wrote 999002 \(warning POST_COMMIT_FAILED/);
  const deletes = calls.filter((call) => (call.body ?? '').includes('DELETE FROM Vendor'));
  assert.equal(deletes.length, 1, 'the written row is deleted, not orphaned');
  assert.equal((store.Vendor ?? []).length, 0);
});

test('the smoke plan deletes every form it submits into (redistributable fixtures and the smoke apps)', () => {
  const sources: [string, string][] = [
    ['SMOKE_DS', SMOKE_DS],
    ['CALLS_DS', CALLS_DS],
  ];
  const fixtures = join(repoRoot(), 'fixtures/redistributable');
  for (const dir of readdirSync(fixtures).sort()) {
    for (const file of readdirSync(join(fixtures, dir)).filter((name) => name.endsWith('.ds')).sort()) sources.push([`${dir}/${file}`, readFileSync(join(fixtures, dir, file), 'utf8')]);
  }
  assert.ok(sources.some(([name]) => name.startsWith('library-application-system/')), 'the library fixture is covered');
  // Each app gets its own registry row so the guard accepts its project name.
  const inputsFor = (app: ReturnType<typeof deriveIr>) => {
    const guard = checkGuards({ org: SCOPE.org, projectId: '1001', appLink: app.name ?? '', credentialPath: SECRET, registry: { ...registry, projects: { [catalystProjectName(app.name ?? '')]: '1001' } } });
    const { files, schema } = deployFiles(app, guard, false, { mode: 'dry-run' });
    const routes = JSON.parse(String(files.find((file) => file.path === 'functions/c2c_api/routes.json')!.data)) as Record<string, string>;
    return { routes, model: generateUi(app).model, schema };
  };
  for (const [name, source] of sources) {
    const app = deriveIr(parse(source));
    const steps = planSmoke(app, inputsFor(app));
    const submitted = steps.filter((step) => step.kind === 'submit').map((step) => step.form);
    assert.ok(submitted.length > 0, `${name}: the plan submits at least one form`);
    const cleaned = steps.filter((step) => step.kind === 'cleanup').map((step) => step.form);
    for (const form of submitted) assert.ok(cleaned.includes(form), `${name}: ${form} is submitted but never deleted`);
    const lastSubmit = Math.max(...steps.map((step, index) => (step.kind === 'submit' ? index : -1)));
    assert.ok(steps.every((step, index) => step.kind !== 'cleanup' || index > lastSubmit), `${name}: deletes run after every submit`);
  }
  const library = deriveIr(parse(readFileSync(join(fixtures, 'library-application-system/library_application.ds'), 'utf8')));
  const memberCleanup = planSmoke(library, inputsFor(library)).find((step) => step.kind === 'cleanup' && step.form === 'Member_Info');
  assert.equal(memberCleanup?.table, 'Member_Info', 'the Member_Info row the smoke writes is deleted by table');
});

test('smoke never relays the token or cookie when a server error echoes them', async () => {
  const ds = writeDs(undefined, SMOKE_DS);
  const cap = capture();
  const token = 'canary-tok-4f2a9c1e77';
  const cookieValue = 'canary-ck-8b3d5f02aa';
  const cookie = `sesscan=${cookieValue}`;
  const store: Record<string, Record<string, string>[]> = {};
  const calls: { method: string; url: string; headers?: Record<string, string>; body?: string }[] = [];
  const base = smokeFetch(store, calls);
  // A WAF/proxy-style endpoint that reflects the auth it received in the error text.
  cap.io.fetch = async (url, init) => {
    const headers = init?.headers ?? {};
    if (url.includes('/forms/') && url.includes('/submit')) {
      return response({ error: `denied: authorization=${headers.authorization ?? ''} cookie=${headers.cookie ?? ''}` }, 403);
    }
    if (url.includes('/reports/')) {
      return response({ error: `refused: Authorization: Bearer ${headers.authorization ?? ''} (Cookie: ${headers.cookie ?? ''})` }, 403);
    }
    return base(url, init);
  };
  const code = await smokeCli(
    [...baseArgs(ds), '--confirm', '--url', 'https://app.example.test/server/c2c_api', '--auth-token', token, '--session-cookie', cookie],
    cap.io,
  );
  assert.equal(code, 1, cap.stdout());
  assert.match(cap.stdout(), /submit Vendor: 403/, 'the status is still reported');
  assert.match(cap.stdout(), /report Open_Items: 403/, 'the report status is still reported');
  for (const secret of [token, cookieValue, cookie]) {
    assert.equal(cap.stdout().includes(secret), false, `stdout must not relay ${secret.slice(0, 12)}…`);
    assert.equal(cap.stderr().includes(secret), false, `stderr must not relay ${secret.slice(0, 12)}…`);
  }
});

test('smoke never prints a server-reflected ROWID on the success path', async () => {
  const ds = writeDs(undefined, SMOKE_DS);
  const cap = capture();
  const token = 'canary-tok-4f2a9c1e77';
  const cookieValue = 'canary-ck-8b3d5f02aa';
  const cookie = `sesscan=${cookieValue}`;
  // A debugging proxy-style endpoint that answers 200 and reflects the auth
  // it received inside values.ROWID.
  cap.io.fetch = async (url, init) => {
    const headers = init?.headers ?? {};
    if (url.includes('/forms/') && url.includes('/submit')) {
      return response({ dryRun: false, wrote: true, values: { ROWID: headers.authorization ?? 'none' } });
    }
    return response({ dryRun: false, rows: [] });
  };
  const code = await smokeCli(
    [...baseArgs(ds), '--confirm', '--url', 'https://app.example.test/server/c2c_api', '--auth-token', token, '--session-cookie', cookie],
    cap.io,
  );
  assert.equal(code, 1, cap.stdout());
  for (const secret of [token, cookieValue, cookie]) {
    assert.equal(cap.stdout().includes(secret), false, `stdout must not relay ${secret.slice(0, 12)}…`);
    assert.equal(cap.stderr().includes(secret), false, `stderr must not relay ${secret.slice(0, 12)}…`);
  }
  assert.match(cap.stdout(), /no (usable )?ROWID/, 'a non-numeric ROWID is reported as missing, never printed');
});

test('smoke redacts auth material from a thrown step error', async () => {
  const ds = writeDs(undefined, SMOKE_DS);
  const cap = capture();
  const token = 'canary-tok-4f2a9c1e77';
  const cookieValue = 'canary-ck-8b3d5f02aa';
  const cookie = `sesscan=${cookieValue}`;
  // A transport failure whose message embeds the request detail.
  cap.io.fetch = async (_url, init) => {
    const headers = init?.headers ?? {};
    throw new Error(`upstream rejected authorization=${headers.authorization ?? ''} cookie=${headers.cookie ?? ''}`);
  };
  const code = await smokeCli(
    [...baseArgs(ds), '--confirm', '--url', 'https://app.example.test/server/c2c_api', '--auth-token', token, '--session-cookie', cookie],
    cap.io,
  );
  assert.equal(code, 1, cap.stdout());
  for (const secret of [token, cookieValue, cookie]) {
    assert.equal(cap.stdout().includes(secret), false, `stdout must not relay ${secret.slice(0, 12)}…`);
    assert.equal(cap.stderr().includes(secret), false, `stderr must not relay ${secret.slice(0, 12)}…`);
  }
});

test('smoke refuses a session cookie without name=value and never prints it', async () => {
  const ds = writeDs(undefined, SMOKE_DS);
  const secret = 'WHOLE-VALUE-SECRET-9f8e7d6c5b';
  const cap = capture();
  const code = await smokeCli(
    [...baseArgs(ds), '--confirm', '--url', 'https://app.example.test/server/c2c_api', '--session-cookie', secret],
    cap.io,
  );
  assert.equal(code, 2, `exit 2 with a usage error, got ${code}:\n${cap.stdout()}\n${cap.stderr()}`);
  assert.match(cap.stderr(), /name=value/);
  assert.equal(cap.stdout().includes(secret), false, 'the malformed value is never printed on stdout');
  assert.equal(cap.stderr().includes(secret), false, 'the malformed value is never printed on stderr');
  assert.equal(cap.fetched.length, 0, 'refused before any network call');
  // The same shape is refused when it arrives through the environment.
  const envCap = capture({ X_ZC_CREDENTIAL_PATH: SECRET, C2C_SMOKE_SESSION_COOKIE: secret });
  const envCode = await smokeCli(
    [...baseArgs(ds), '--confirm', '--url', 'https://app.example.test/server/c2c_api'],
    envCap.io,
  );
  assert.equal(envCode, 2, `exit 2 with a usage error, got ${envCode}:\n${envCap.stdout()}\n${envCap.stderr()}`);
  assert.match(envCap.stderr(), /C2C_SMOKE_SESSION_COOKIE.*name=value/);
  assert.equal(envCap.stdout().includes(secret), false);
  assert.equal(envCap.stderr().includes(secret), false);
});

test('smoke plan prints only the cookie name, never its value', async () => {
  const ds = writeDs(undefined, SMOKE_DS);
  const cap = capture();
  const code = await smokeCli(baseArgs(ds, ['--session-cookie', 'sess=abc123']), cap.io);
  assert.equal(code, 0, cap.stderr());
  assert.match(cap.stdout(), /auth: session cookie sess \(--session-cookie\)/);
  assert.equal(cap.stdout().includes('abc123'), false, 'the cookie value is never printed');
});

test('planSmoke prefers POST when a path is registered under several methods', () => {
  const app = deriveIr(parse(SMOKE_DS));
  const inputs = smokeInputs(app);
  const submitKey = 'POST /forms/Vendor/submit';
  assert.ok(inputs.routes[submitKey], 'the fixture registers a Vendor submit route');
  const routes: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs.routes)) {
    if (key.endsWith('/forms/Vendor/submit')) continue;
    routes[key] = value;
  }
  routes['GET /forms/Vendor/submit'] = './forms/vendor-get.mjs';
  routes[submitKey] = inputs.routes[submitKey];
  const steps = planSmoke(app, { ...inputs, routes });
  const submit = steps.find((step) => step.kind === 'submit' && step.form === 'Vendor');
  assert.equal(submit?.method, 'POST', 'smoke only ever calls POST, so POST wins a shared path');
});

test('planSmoke lists a report without a query endpoint as a skip, not silence', () => {
  const app = deriveIr(parse(SMOKE_DS));
  const inputs = smokeInputs(app);
  assert.ok(inputs.model.reports.length > 0, 'the fixture has a report');
  const model = { ...inputs.model, reports: inputs.model.reports.map((report) => ({ ...report, queryEndpoint: '' })) };
  const steps = planSmoke(app, { ...inputs, model });
  const skipped = steps.filter((step) => step.kind === 'skip' && step.label.startsWith('report '));
  assert.equal(skipped.length, inputs.model.reports.length, 'every endpoint-less report is said so in the plan');
  assert.ok(skipped.every((step) => step.reason), 'every omitted report names a reason');
});

test('the c2c bin plans without a credential; confirm still refuses before the plan', async () => {
  const ds = writeDs();
  const env: NodeJS.ProcessEnv = { ...process.env, C2C_WORKSPACE: mkdtempSync(join(tmpdir(), 'c2c-bin-workspace-')) };
  delete env.X_ZC_CREDENTIAL_PATH;
  const run = (args: string[]) =>
    execFileAsync(process.execPath, [join('dist/cli/src/c2c.js'), 'deploy', ...args], {
      cwd: process.cwd(),
      env,
    }).then(
      (out) => ({ code: 0, stderr: out.stderr, stdout: out.stdout }),
      (err: { code?: number; stderr?: string; stdout?: string }) => ({ code: err.code ?? 1, stderr: err.stderr ?? '', stdout: err.stdout ?? '' }),
    );
  const planned = await run(baseArgs(ds));
  assert.equal(planned.code, 0, planned.stderr);
  assert.match(planned.stdout, /c2c deploy plan v1/);
  assert.match(planned.stdout, /confirm enforces:/);
  assert.match(planned.stdout, /X_ZC_CREDENTIAL_PATH is set/);
  assert.equal(planned.stderr.includes('X_ZC_CREDENTIAL_PATH is unset'), false);
  // --confirm stops at the doctor gate before its own guards.
  const gated = await run([...baseArgs(ds), '--confirm', '--function-env', 'new']);
  assert.equal(gated.code, 5, gated.stderr);
  assert.match(gated.stderr, /doctor is not green/);
  assert.equal(gated.stdout.includes('c2c deploy plan'), false);
  // A green doctor for this scope lets the run reach the credential guard.
  writeGreenDoctor(env.C2C_WORKSPACE as string, { dc: 'in', org: '10000000000', project: '1001' });
  const confirmed = await run([...baseArgs(ds), '--confirm', '--function-env', 'new']);
  assert.equal(confirmed.code, 2);
  assert.match(confirmed.stderr, /X_ZC_CREDENTIAL_PATH is unset/);
  assert.equal(confirmed.stdout.includes('c2c deploy plan'), false);
});

const RICH = `application "Widget"
{
	form Author
	{
		Name
		(
			type = text
		)
	}
	form Book
	{
		must have Author
		(
			type = picklist
			values = Author.Name
		)
		When
		(
			type = date
		)
		Amount
		(
			type = decimal
		)
		Tags
		(
			type = list
			values = {"red","blue"}
		)
		Photo
		(
			type = image
		)
	}
	form Order
	{
		Title
		(
			type = text
		)
		Lines
		(
			type = grid
			Qty
			(
				type = decimal
			)
		)
	}
}
`;

const BOM = `application "Widget"
{
	form Item
	{
		Name
		(
			type = text
		)
	}
	form Create_BOM
	{
		Lines
		(
			type = grid
			Item
			(
				type = text
			)
		)
		Notes
		(
			type = grid
			Body
			(
				type = textarea
			)
		)
	}
}
`;

test('table create orders foreign keys and skips an existing table', async () => {
  const steps = tableCreatePlan(generateSchema(deriveIr(parse(RICH))));
  const names = steps.filter((step) => !step.nosql).map((step) => step.table);
  assert.ok(names.indexOf('Author') < names.indexOf('Book'));
  assert.ok(names.indexOf('Order') < names.indexOf('Order__Lines'));
  const bookColumns = steps.filter((step) => step.table === 'Book').flatMap((step) => step.columns);
  const author = bookColumns.find((column) => column.column_name === 'Author');
  assert.equal(author?.data_type, 'foreign key');
  assert.equal(author?.parent_table, 'Author');
  assert.equal(author?.constraint_type, 'ON-DELETE-CASCADE');
  const amount = bookColumns.find((column) => column.column_name === 'Amount');
  assert.equal(amount?.data_type, 'varchar');
  assert.equal(amount?.max_length, 64);
  assert.equal(amount?.decimal_digits, undefined);
  assert.notEqual(amount?.data_type, 'decimal');
  const store = memoryRest();
  const first = await applyTablePlan('1001', steps, store.rest);
  assert.deepEqual(first.createdTables, ['Author', 'Book', 'Order', 'Order__Lines']);
  const bookColumn = store.calls.find((call) => call.path.endsWith('/column') && JSON.stringify(call.body).includes('"Author"'));
  const authorId = (store.calls.find((call) => call.method === 'POST' && (call.body as { table_name?: string })?.table_name === 'Author')?.body as undefined);
  void authorId;
  const createdAuthor = store.calls.find((call) => (call.body as { table_name?: string })?.table_name === 'Author');
  const authorIndex = store.calls.indexOf(createdAuthor!);
  const authorTableId = `t${store.calls.slice(0, authorIndex + 1).filter((call) => call.method === 'POST' && String(call.path).endsWith('/table')).length}`;
  const fk = (bookColumn?.body as { column_name: string; data_type: string; parent_table: string; constraint_type: string }[]).find((column) => column.column_name === 'Author');
  assert.equal(fk?.data_type, 'foreign key');
  assert.equal(fk?.constraint_type, 'ON-DELETE-CASCADE');
  assert.equal(fk?.parent_table, authorTableId);
  const posts = store.calls.filter((call) => call.method === 'POST').length;
  const second = await applyTablePlan('1001', steps, store.rest);
  assert.deepEqual(second.createdTables, []);
  assert.deepEqual(second.createdColumns, []);
  assert.ok(second.unchanged.includes('Book.Author'));
  assert.equal(store.calls.filter((call) => call.method === 'POST').length, posts);
});

const CYCLE_AB = `application "Widget"
{
	form A
	{
		Name
		(
			type = text
		)
		Peer
		(
			type = picklist
			values = B.Name
		)
	}
	form B
	{
		Name
		(
			type = text
		)
		Peer
		(
			type = picklist
			values = A.Name
		)
	}
}
`;

const CYCLE_SELF = `application "Widget"
{
	form Node
	{
		Name
		(
			type = text
		)
		Parent
		(
			type = picklist
			values = Node.Name
		)
	}
}
`;

const CYCLE_ABC = `application "Widget"
{
	form A
	{
		Name
		(
			type = text
		)
		Next
		(
			type = picklist
			values = B.Name
		)
	}
	form B
	{
		Name
		(
			type = text
		)
		Next
		(
			type = picklist
			values = C.Name
		)
	}
	form C
	{
		Name
		(
			type = text
		)
		Next
		(
			type = picklist
			values = A.Name
		)
	}
}
`;

function assertFkPhase(steps: { nosql: boolean; columns: { data_type: string }[] }[]): void {
  let seenFk = false;
  for (const step of steps) {
    if (step.nosql) continue;
    const hasFk = step.columns.some((column) => column.data_type === 'foreign key');
    const hasOther = step.columns.some((column) => column.data_type !== 'foreign key');
    assert.equal(hasFk && hasOther, false);
    if (hasOther) assert.equal(seenFk, false);
    if (hasFk) seenFk = true;
  }
  assert.equal(seenFk, true);
}

test('table create plans a lookup cycle, a self-lookup, and a 3-cycle in two phases', async () => {
  for (const source of [CYCLE_AB, CYCLE_SELF, CYCLE_ABC]) {
    const steps = tableCreatePlan(generateSchema(deriveIr(parse(source))));
    assertFkPhase(steps);
    const store = memoryRest();
    const diff = await applyTablePlan('1001', steps, store.rest);
    let lastTable = -1;
    for (let i = 0; i < store.calls.length; i++) {
      const call = store.calls[i]!;
      if (call.method === 'POST' && call.path.endsWith('/table')) lastTable = i;
    }
    const fkCalls = store.calls.filter((call) => call.method === 'POST' && call.path.includes('/column') && JSON.stringify(call.body).includes('"foreign key"'));
    assert.ok(lastTable >= 0);
    assert.ok(fkCalls.length > 0);
    assert.ok(store.calls.indexOf(fkCalls[0]!) > lastTable);
    const expectedTables: string[] = [];
    for (const step of steps) {
      if (step.nosql || expectedTables.includes(step.table)) continue;
      expectedTables.push(step.table);
    }
    assert.deepEqual(diff.createdTables, expectedTables);
    const again = await applyTablePlan('1001', steps, store.rest);
    assert.deepEqual(again.createdTables, []);
    assert.deepEqual(again.createdColumns, []);
  }

  const mutual = tableCreatePlan(generateSchema(deriveIr(parse(CYCLE_AB))));
  const mutualStore = memoryRest();
  await applyTablePlan('1001', mutual, mutualStore.rest);
  const ids = new Map<string, string>();
  for (const call of mutualStore.calls) {
    if (call.method === 'POST' && call.path.endsWith('/table')) {
      const name = (call.body as { table_name: string }).table_name;
      const prior = mutualStore.calls.slice(0, mutualStore.calls.indexOf(call) + 1).filter((item) => item.method === 'POST' && item.path.endsWith('/table')).length;
      ids.set(name, `t${prior}`);
    }
  }
  for (const call of mutualStore.calls) {
    if (!call.path.includes('/column') || !Array.isArray(call.body)) continue;
    const fk = (call.body as { column_name: string; data_type: string; parent_table?: string; constraint_type?: string }[]).find((column) => column.data_type === 'foreign key');
    if (!fk) continue;
    const tableId = call.path.split('/table/')[1]?.split('/')[0];
    const table = [...ids.entries()].find(([, id]) => id === tableId)?.[0];
    assert.equal(fk.constraint_type, 'ON-DELETE-SET-NULL');
    assert.equal(fk.parent_table, ids.get(table === 'A' ? 'B' : 'A'));
    assert.notEqual(fk.parent_table, tableId);
  }

  const self = tableCreatePlan(generateSchema(deriveIr(parse(CYCLE_SELF))));
  const selfStore = memoryRest();
  await applyTablePlan('1001', self, selfStore.rest);
  const selfFk = selfStore.calls.find((call) => call.path.includes('/column') && JSON.stringify(call.body).includes('"Parent"'));
  const selfBody = (selfFk?.body as { column_name: string; parent_table: string; constraint_type: string }[]).find((column) => column.column_name === 'Parent');
  const selfTable = selfStore.calls.find((call) => (call.body as { table_name?: string })?.table_name === 'Node');
  const selfIndex = selfStore.calls.indexOf(selfTable!);
  const selfId = `t${selfStore.calls.slice(0, selfIndex + 1).filter((call) => call.method === 'POST' && call.path.endsWith('/table')).length}`;
  assert.equal(selfBody?.parent_table, selfId);
  assert.equal(selfBody?.constraint_type, 'ON-DELETE-SET-NULL');

  const triple = tableCreatePlan(generateSchema(deriveIr(parse(CYCLE_ABC))));
  const tripleStore = memoryRest();
  await applyTablePlan('1001', triple, tripleStore.rest);
  const tripleIds = new Map<string, string>();
  for (const call of tripleStore.calls) {
    if (call.method !== 'POST' || !call.path.endsWith('/table')) continue;
    const name = (call.body as { table_name: string }).table_name;
    const prior = tripleStore.calls.slice(0, tripleStore.calls.indexOf(call) + 1).filter((item) => item.method === 'POST' && item.path.endsWith('/table')).length;
    tripleIds.set(name, `t${prior}`);
  }
  const parentOf = (table: string) => (table === 'A' ? 'B' : table === 'B' ? 'C' : 'A');
  const seen = new Set<string>();
  for (const call of tripleStore.calls) {
    if (!call.path.includes('/column') || !Array.isArray(call.body)) continue;
    const fk = (call.body as { data_type: string; parent_table?: string }[]).find((column) => column.data_type === 'foreign key');
    if (!fk) continue;
    const tableId = call.path.split('/table/')[1]?.split('/')[0];
    const table = [...tripleIds.entries()].find(([, id]) => id === tableId)?.[0];
    assert.ok(table);
    seen.add(table);
    assert.equal(fk.parent_table, tripleIds.get(parentOf(table)));
  }
  assert.deepEqual([...seen].sort(), ['A', 'B', 'C']);

  for (const file of [
    'fixtures/redistributable/freight-forwarding/Creator_app_source_code.ds',
    'fixtures/redistributable/library-application-system/library_application.ds',
  ]) {
    const steps = tableCreatePlan(generateSchema(deriveIr(parse(readFileSync(file, 'utf8')))));
    assertFkPhase(steps);
    assert.ok(steps.some((step) => !step.nosql && step.columns.some((column) => column.column_name === 'c2c_source_id')));
  }
});

test('csv migration inserts cyclic lookups null, then updates them to ROWIDs', async () => {
  const app = deriveIr(parse(`${CYCLE_AB}\n`));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-cycle-'));
  writeFileSync(join(dir, 'A.csv'), 'ID,Name,Peer\n1,alpha,2\n');
  writeFileSync(join(dir, 'B.csv'), 'ID,Name,Peer\n2,beta,1\n');
  writeFileSync(join(dir, 'counts.json'), JSON.stringify({ A: 1, B: 1 }));
  const events: string[] = [];
  const stored = new Map<string, Map<string, { rowid: string; columns: Record<string, string> }>>();
  let seq = 1;
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') throw new Error('csv migrate called Creator');
    assertScopedCall(url, init);
    const path = new URL(url).pathname;
    if (path.endsWith('/query')) {
      const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
      const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1] ?? '';
      const rows = stored.get(table) ?? new Map<string, { rowid: string; columns: Record<string, string> }>();
      if (/COUNT\(/i.test(sql)) return response({ data: [{ 'COUNT(ROWID)': String(rows.size) }] });
      if (/^SELECT ROWID, c2c_source_id FROM /i.test(sql)) {
        return response({ data: [...rows].map(([source, row]) => ({ c2c_source_id: source, ROWID: row.rowid })) });
      }
      return response({ data: [...rows].map(([source, row]) => ({ ...row.columns, c2c_source_id: source, ROWID: row.rowid })) });
    }
    if (method === 'PUT' && path.endsWith('/row')) {
      const table = decodeURIComponent(path.split('/').at(-2) ?? '');
      const body = JSON.parse(init?.body ?? '[]') as { ROWID: string; Peer?: string }[];
      const bucket = stored.get(table) ?? new Map<string, { rowid: string; columns: Record<string, string> }>();
      for (const row of body) {
        const found = [...bucket.values()].find((item) => item.rowid === row.ROWID);
        assert.ok(found);
        if (row.Peer) found.columns.Peer = row.Peer;
        events.push(`update ${table}`);
      }
      return response(body);
    }
    const table = decodeURIComponent(path.split('/').at(-2) ?? '');
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns: Record<string, string> }[] };
    const bucket = stored.get(table) ?? new Map<string, { rowid: string; columns: Record<string, string> }>();
    for (const row of body.rows) {
      assert.equal(row.columns.Peer, undefined);
      const rowid = `r${seq++}`;
      bucket.set(row.columns.c2c_source_id, { rowid, columns: { ...row.columns } });
      events.push(`insert ${table}`);
    }
    stored.set(table, bucket);
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const migrated = await migrateCsv({ app, dir, dc: 'in', catalystBase: 'https://api.catalyst.zoho.in', fetch, checkpoint: emptyCheckpoint(), scope: SCOPE });
  assert.equal(migrated.ok, true);
  assert.deepEqual(events.filter((event) => event.startsWith('insert')), ['insert A', 'insert B']);
  assert.ok(events.indexOf('update A') > events.indexOf('insert B'));
  assert.ok(events.indexOf('update B') > events.indexOf('insert B'));
  assert.equal(stored.get('A')?.get('1')?.columns.Peer, stored.get('B')?.get('2')?.rowid);
  assert.equal(stored.get('B')?.get('2')?.columns.Peer, stored.get('A')?.get('1')?.rowid);
  assert.equal(migrated.counts.find((item) => item.form === 'A')?.catalyst, 1);
  assert.equal(migrated.counts.find((item) => item.form === 'B')?.catalyst, 1);
  assert.ok(migrated.counts.every((item) => item.mismatch === false));
  const inserts = events.filter((event) => event.startsWith('insert')).length;
  const second = await migrateCsv({ app, dir, dc: 'in', catalystBase: 'https://api.catalyst.zoho.in', fetch, checkpoint: emptyCheckpoint(), scope: SCOPE });
  assert.equal(second.ok, true);
  assert.equal(events.filter((event) => event.startsWith('insert')).length, inserts);
  assert.equal(stored.get('A')?.size, 1);
  assert.equal(stored.get('B')?.size, 1);

  const selfApp = deriveIr(parse(CYCLE_SELF));
  const selfDir = mkdtempSync(join(tmpdir(), 'c2c-self-'));
  writeFileSync(join(selfDir, 'Node.csv'), 'ID,Name,Parent\n1,root,\n2,child,1\n');
  writeFileSync(join(selfDir, 'counts.json'), JSON.stringify({ Node: 2 }));
  const selfStored = new Map<string, { rowid: string; columns: Record<string, string> }>();
  let selfSeq = 1;
  const selfEvents: string[] = [];
  const selfFetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') throw new Error('csv migrate called Creator');
    assertScopedCall(url, init);
    const path = new URL(url).pathname;
    if (path.endsWith('/query')) {
      const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
      if (/COUNT\(/i.test(sql)) return response({ data: [{ 'COUNT(ROWID)': String(selfStored.size) }] });
      if (/^SELECT ROWID, c2c_source_id FROM /i.test(sql)) return response({ data: [...selfStored].map(([source, row]) => ({ c2c_source_id: source, ROWID: row.rowid })) });
      return response({ data: [...selfStored].map(([source, row]) => ({ ...row.columns, c2c_source_id: source, ROWID: row.rowid })) });
    }
    if (method === 'PUT') {
      const body = JSON.parse(init?.body ?? '[]') as { ROWID: string; Parent?: string }[];
      for (const row of body) {
        const found = [...selfStored.values()].find((item) => item.rowid === row.ROWID);
        assert.ok(found);
        if (row.Parent) found.columns.Parent = row.Parent;
      }
      selfEvents.push('update');
      return response(body);
    }
    const body = JSON.parse(init?.body ?? '{}') as { rows: { columns: Record<string, string> }[] };
    for (const row of body.rows) {
      assert.equal(row.columns.Parent, undefined);
      selfStored.set(row.columns.c2c_source_id, { rowid: `r${selfSeq++}`, columns: { ...row.columns } });
      selfEvents.push('insert');
    }
    return response({ ids: body.rows.map((row) => row.columns.c2c_source_id) });
  };
  const selfMigrated = await migrateCsv({
    app: selfApp,
    dir: selfDir,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: selfFetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(selfMigrated.ok, true);
  assert.deepEqual(selfEvents, ['insert', 'insert', 'update']);
  assert.equal(selfStored.get('2')?.columns.Parent, selfStored.get('1')?.rowid);
  assert.equal(selfStored.get('1')?.columns.Parent, undefined);
  assert.equal(selfMigrated.counts[0]?.catalyst, 2);
  assert.equal(selfMigrated.counts[0]?.expected, 2);
  assert.equal(selfMigrated.counts[0]?.mismatch, false);
});

const PROBE_ROWIDS = ['10000000000315013', '10000000000315015'] as const;

test('cyclic lookup PUT keeps unquoted 17-digit ROWIDs exact', async () => {
  const rounded = PROBE_ROWIDS.map((digits) => String(JSON.parse(digits)));
  assert.deepEqual(rounded, ['10000000000315012', '10000000000315016']);
  for (const digits of PROBE_ROWIDS) {
    assert.throws(() => exactId(JSON.parse(digits), 'ROWID'), /numeric id beyond MAX_SAFE_INTEGER/);
    assert.equal(exactId(digits, 'ROWID'), digits);
  }
  const app = deriveIr(parse(CYCLE_AB));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-rowid-'));
  writeFileSync(join(dir, 'A.csv'), 'ID,Name,Peer\n1,alpha,2\n');
  writeFileSync(join(dir, 'B.csv'), 'ID,Name,Peer\n2,beta,1\n');
  writeFileSync(join(dir, 'counts.json'), JSON.stringify({ A: 1, B: 1 }));
  const assigned = new Map<string, string>([
    ['A', PROBE_ROWIDS[0]],
    ['B', PROBE_ROWIDS[1]],
  ]);
  const stored = new Map<string, Map<string, { rowid: string; columns: Record<string, string> }>>();
  const puts: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') throw new Error('csv migrate called Creator');
    assertScopedCall(url, init);
    const path = new URL(url).pathname;
    if (path.endsWith('/query')) {
      const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
      const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1] ?? '';
      const rows = stored.get(table) ?? new Map<string, { rowid: string; columns: Record<string, string> }>();
      if (/COUNT\(/i.test(sql)) return response({ data: [{ 'COUNT(ROWID)': String(rows.size) }] });
      if (/^SELECT ROWID, c2c_source_id FROM /i.test(sql)) {
        const data = [...rows].map(([source, row]) => `{"c2c_source_id":${JSON.stringify(source)},"ROWID":${row.rowid}}`).join(',');
        return { status: 200, headers: { get: () => null }, text: async () => `{"data":[${data}]}` };
      }
      return response({ data: [...rows].map(([source, row]) => ({ ...row.columns, c2c_source_id: source, ROWID: row.rowid })) });
    }
    if (method === 'PUT' && path.endsWith('/row')) {
      const table = decodeURIComponent(path.split('/').at(-2) ?? '');
      const text = init?.body ?? '[]';
      puts.push(text);
      const body = JSON.parse(text) as { ROWID: string; Peer?: string }[];
      const bucket = stored.get(table) ?? new Map<string, { rowid: string; columns: Record<string, string> }>();
      for (const row of body) {
        const found = [...bucket.values()].find((item) => item.rowid === row.ROWID);
        assert.ok(found);
        if (row.Peer) found.columns.Peer = row.Peer;
      }
      return response(body);
    }
    const table = decodeURIComponent(path.split('/').at(-2) ?? '');
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns: Record<string, string> }[] };
    const bucket = stored.get(table) ?? new Map<string, { rowid: string; columns: Record<string, string> }>();
    for (const row of body.rows) {
      assert.equal(row.columns.Peer, undefined);
      bucket.set(row.columns.c2c_source_id, { rowid: assigned.get(table)!, columns: { ...row.columns } });
    }
    stored.set(table, bucket);
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const migrated = await migrateCsv({ app, dir, dc: 'in', catalystBase: 'https://api.catalyst.zoho.in', fetch, checkpoint: emptyCheckpoint(), scope: SCOPE });
  assert.equal(migrated.ok, true);
  assert.equal(stored.get('A')?.get('1')?.columns.Peer, PROBE_ROWIDS[1]);
  assert.equal(stored.get('B')?.get('2')?.columns.Peer, PROBE_ROWIDS[0]);
  const put = puts.join('\n');
  for (const digits of PROBE_ROWIDS) assert.equal(put.includes(digits), true, digits);
  for (const digits of rounded) assert.equal(put.includes(digits), false, digits);
});

const CYCLE_MUST = `application "Widget"
{
	form Parent
	{
		Name
		(
			type = text
		)
	}
	form A
	{
		Name
		(
			type = text
		)
		must have Peer
		(
			type = picklist
			values = B.Name
		)
	}
	form B
	{
		Name
		(
			type = text
		)
		Peer
		(
			type = picklist
			values = A.Name
		)
	}
	form Child
	{
		must have Parent_Name
		(
			type = picklist
			values = Parent.Name
		)
	}
}
`;

function columnOf(steps: { table: string; columns: { column_name: string; data_type: string; is_mandatory: boolean; mandatoryRelaxed?: boolean; parent_table?: string; constraint_type?: string }[] }[], table: string, column: string) {
  for (const step of steps) {
    if (step.table !== table) continue;
    const found = step.columns.find((item) => item.column_name === column);
    if (found) return found;
  }
  return undefined;
}

test('a cyclic must-have lookup is created not mandatory and recorded as a coverage gap', async () => {
  const app = deriveIr(parse(CYCLE_MUST));
  const steps = tableCreatePlan(generateSchema(app));
  const peer = columnOf(steps, 'A', 'Peer');
  const back = columnOf(steps, 'B', 'Peer');
  const child = columnOf(steps, 'Child', 'Parent_Name');
  const source = columnOf(steps, 'A', 'c2c_source_id');
  assert.equal(peer?.data_type, 'foreign key');
  assert.equal(peer?.is_mandatory, false);
  assert.equal(peer?.mandatoryRelaxed, true);
  assert.equal(peer?.constraint_type, 'ON-DELETE-CASCADE');
  assert.equal(peer?.parent_table, 'B');
  assert.equal(back?.is_mandatory, false);
  assert.equal(back?.mandatoryRelaxed, undefined);
  assert.equal(back?.constraint_type, 'ON-DELETE-SET-NULL');
  assert.equal(child?.is_mandatory, true);
  assert.equal(child?.mandatoryRelaxed, undefined);
  assert.equal(child?.constraint_type, 'ON-DELETE-CASCADE');
  assert.equal(source?.is_mandatory, false); // nullable so app inserts can leave it NULL
  assert.equal(source?.mandatoryRelaxed, undefined);
  const lines = formatTableCreate('1001', steps, false);
  assert.ok(lines.includes(`- ${mandatoryRelaxedLine('A', 'Peer')}`));
  assert.equal(lines.some((line) => line.includes('mandatory relaxed: Child.Parent_Name')), false);
  assert.equal(lines.some((line) => line.includes('mandatory relaxed: B.Peer')), false);
  const peerLine = lines.find((line) => line.startsWith('- create column A.Peer '));
  const childLine = lines.find((line) => line.startsWith('- create column Child.Parent_Name '));
  assert.equal(peerLine?.includes(' mandatory'), false);
  assert.equal(childLine?.includes(' mandatory'), true);
  const guard = checkGuards({ org: '10000000000', projectId: '1001', appLink: 'Widget', credentialPath: SECRET, registry });
  const plan = buildDeploy(app, guard, false).plan;
  assert.ok(plan.includes(mandatoryRelaxedLine('A', 'Peer')));
  assert.equal(plan.includes('mandatory relaxed: Child.Parent_Name'), false);
  const store = memoryRest();
  await applyTablePlan('1001', steps, store.rest);
  assert.equal(store.calls.some((call) => call.method !== 'GET' && call.method !== 'POST'), false);
  const bodies = store.calls.filter((call) => Array.isArray(call.body)).flatMap((call) => call.body as { column_name: string; is_mandatory?: boolean; parent_table?: string }[]);
  const postedPeer = bodies.find((column) => column.column_name === 'Peer' && column.parent_table !== undefined);
  const postedChild = bodies.find((column) => column.column_name === 'Parent_Name');
  assert.equal(postedPeer?.is_mandatory, false);
  assert.equal(postedChild?.is_mandatory, true);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-must-'));
  writeFileSync(join(dir, 'Parent.csv'), 'ID,Name\n9,root\n');
  writeFileSync(join(dir, 'A.csv'), 'ID,Name,Peer\n1,alpha,2\n');
  writeFileSync(join(dir, 'B.csv'), 'ID,Name,Peer\n2,beta,1\n');
  writeFileSync(join(dir, 'Child.csv'), 'ID,Parent_Name\n3,9\n');
  writeFileSync(join(dir, 'counts.json'), JSON.stringify({ Parent: 1, A: 1, B: 1, Child: 1 }));
  const loaded = readSourceCsv(dir, app);
  const csvPlan = formatCsvPlan(loaded, { projectName: 'c2c-widget', projectId: '1001', org: '10000000000', environment: 'Development', dc: 'eu' });
  assert.ok(csvPlan.includes(`coverage:\n- ${mandatoryRelaxedLine('A', 'Peer')}`));
  assert.equal(csvPlan.includes('mandatory relaxed: Child.Parent_Name'), false);
  const inserted: { table: string; columns: Record<string, string> }[] = [];
  const migrated = await migrateCsv({
    app,
    dir,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') throw new Error('csv migrate called Creator');
      assertScopedCall(url, init);
      const path = new URL(url).pathname;
      if (path.endsWith('/query')) {
        const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
        const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1] ?? '';
        if (/COUNT\(/i.test(sql)) return response({ data: [{ 'COUNT(ROWID)': '1' }] });
        if (/^SELECT ROWID, c2c_source_id FROM /i.test(sql)) {
          const id = table === 'Parent' ? '9' : table === 'A' ? '1' : table === 'B' ? '2' : '3';
          return response({ data: [{ c2c_source_id: id, ROWID: `row-${table}` }] });
        }
        return response({ data: inserted.filter((post) => post.table === table).map((post) => ({ ...post.columns })) });
      }
      if (method === 'PUT') return response([]);
      const table = decodeURIComponent(path.split('/').at(-2) ?? '');
      const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns: Record<string, string> }[] };
      for (const row of body.rows) inserted.push({ table, columns: row.columns });
      return response({ ids: body.rows.map((row) => row.id) });
    },
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(migrated.ok, true);
  assert.equal(inserted.find((row) => row.table === 'A')?.columns.Peer, undefined);
  assert.equal(inserted.find((row) => row.table === 'Child')?.columns.Parent_Name, 'row-Parent');
  assert.deepEqual(migrated.relaxed, [{ table: 'A', column: 'Peer' }]);
});

test('gallery cyclic must-have lookups stay not mandatory', (t) => {
  const cases = [
    {
      path: galleryDs('customer-relationship-manager', 'Customer_Relationship_Manager.ds'),
      table: 'Create_Opportunity',
      column: 'Account_Name',
      parent: 'Create_Accounts',
    },
    {
      path: galleryDs('distributor-management', 'Distributor_Management.ds'),
      table: 'Company_Details',
      column: 'Head_Distributor_Name',
      parent: 'Add_Distributor_Details',
    },
  ];
  if (cases.some((item) => !item.path)) {
    t.skip('local gallery fixtures are not available');
    return;
  }
  for (const item of cases) {
    const steps = tableCreatePlan(generateSchema(deriveIr(parse(readFileSync(item.path!, 'utf8')))));
    const column = columnOf(steps, item.table, item.column);
    assert.ok(column, `${item.table}.${item.column}`);
    assert.equal(column?.data_type, 'foreign key');
    assert.equal(column?.is_mandatory, false);
    assert.equal(column?.mandatoryRelaxed, true);
    assert.equal(column?.parent_table, item.parent);
    assert.equal(column?.constraint_type, 'ON-DELETE-CASCADE');
    const source = columnOf(steps, item.table, 'c2c_source_id');
    assert.equal(source?.is_mandatory, false); // nullable so app inserts can leave it NULL
    assert.equal(source?.mandatoryRelaxed, undefined);
    const lines = formatTableCreate('1001', steps, false);
    assert.ok(lines.includes(`- ${mandatoryRelaxedLine(item.table, item.column)}`));
    const createLine = lines.find((line) => line.startsWith(`- create column ${item.table}.${item.column} `));
    assert.equal(createLine?.includes(' mandatory'), false);
  }
});

function galleryDs(appDir: string, file: string): string | undefined {
  const fixtures = process.env.C2C_FIXTURES_DIR;
  const roots = [process.env.C2C_GALLERY, fixtures ? join(fixtures, 'gallery') : ''].filter((item): item is string => Boolean(item));
  for (const root of roots) {
    const path = join(root, appDir, file);
    if (existsSync(path)) return path;
  }
  return undefined;
}

test('csv maps each field kind and fails a count mismatch', async () => {
  assert.deepEqual(parseCsv('ID,Photo\n1,"files/a,b.png"\n'), [
    ['ID', 'Photo'],
    ['1', 'files/a,b.png'],
  ]);
  const app = deriveIr(parse(RICH));
  const dir = writeRichCsv();
  const loaded = readSourceCsv(dir, app);
  const book = loaded.tables.find((table) => table.table === 'Book');
  assert.equal(book?.rows[0].id, 'b1');
  assert.equal(book?.rows[0].columns.Author, '42');
  assert.equal(book?.rows[0].columns.When, '2026-10-05');
  assert.equal(book?.rows[0].columns.Amount, '1234.50');
  assert.equal(book?.rows[0].columns.Tags, '["red","blue"]');
  assert.equal(book?.rows[0].columns.Photo, 'files/a.png');
  assert.ok(loaded.tables.findIndex((table) => table.table === 'Author') < loaded.tables.findIndex((table) => table.table === 'Book'));
  const bad = writeRichCsv({ authorCell: 'Ada Lovelace' });
  assert.throws(() => readSourceCsv(bad, app), /record ID/);
  const noId = writeRichCsv({ dropId: true });
  const derived = readSourceCsv(noId, app);
  const derivedBook = derived.tables.find((table) => table.table === 'Book');
  assert.match(derivedBook?.rows[0]?.id ?? '', /^d_[0-9a-f]{64}$/);
  assert.equal(derivedBook?.rows[0]?.columns.Author, '42');
  const derivedAgain = readSourceCsv(noId, app).tables.find((table) => table.table === 'Book')?.rows[0]?.id;
  assert.equal(derivedAgain, derivedBook?.rows[0]?.id);

  const posts: { table: string; columns: Record<string, string> }[] = [];
  const stored = new Map<string, Map<string, { rowid: string; columns: Record<string, string> }>>();
  let seq = 1;
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') throw new Error('csv migrate called Creator');
    assertScopedCall(url, init);
    if (new URL(url).pathname.endsWith('/query')) {
      const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
      const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1] ?? '';
      const rows = stored.get(table) ?? new Map<string, { rowid: string; columns: Record<string, string> }>();
      const stale = /WHERE ([A-Za-z_]+__n) IS NULL AND ([A-Za-z_]+) IS NOT NULL$/.exec(sql);
      if (stale) {
        const n = posts.filter((post) => post.table === table && post.columns[stale[2]!] != null && post.columns[stale[1]!] == null).length;
        return response({ data: [{ 'COUNT(ROWID)': String(n) }] });
      }
      if (/COUNT\(/i.test(sql)) {
        assert.match(sql, /WHERE c2c_source_id IN \(/);
        return response({ data: [{ 'COUNT(ROWID)': String(rows.size) }] });
      }
      if (/^SELECT ROWID, c2c_source_id FROM /i.test(sql)) return response({ data: [...rows].map(([source, row]) => ({ c2c_source_id: source, ROWID: row.rowid })) });
      return response({ data: [...rows].map(([source, row]) => ({ ...row.columns, c2c_source_id: source, ROWID: row.rowid })) });
    }
    const table = decodeURIComponent(new URL(url).pathname.split('/').at(-2) ?? '');
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns: Record<string, string> }[] };
    const bucket = stored.get(table) ?? new Map<string, { rowid: string; columns: Record<string, string> }>();
    for (const row of body.rows) {
      const rowid = `r${seq++}`;
      bucket.set(row.columns.c2c_source_id, { rowid, columns: { ...row.columns } });
      posts.push({ table, columns: row.columns });
    }
    stored.set(table, bucket);
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const migrated = await migrateCsv({ app, dir, dc: 'in', catalystBase: 'https://api.catalyst.zoho.in', fetch, checkpoint: emptyCheckpoint(), scope: SCOPE });
  assert.equal(migrated.ok, true);
  // Every CSV row carries its shadow, so there is nothing to backfill.
  assert.equal(migrated.warnings, undefined);
  const bookPost = posts.find((post) => post.table === 'Book');
  assert.equal(bookPost?.columns.Author, 'r1');
  assert.notEqual(bookPost?.columns.Author, '42');
  assert.equal(bookPost?.columns.Photo, 'files/a.png');
  const line = posts.find((post) => post.table === 'Order__Lines');
  assert.equal(line?.columns.Qty, '2.50');
  assert.match(line?.columns.parent_id ?? '', /^r/);
  const again = posts.length;
  const second = await migrateCsv({ app, dir, dc: 'in', catalystBase: 'https://api.catalyst.zoho.in', fetch, checkpoint: emptyCheckpoint(), scope: SCOPE });
  assert.equal(second.ok, true);
  assert.equal(posts.length, again);
  // A Book row stored before the shadow column existed: the run does not rewrite it, so it warns and names the backfill.
  posts.push({ table: 'Book', columns: { c2c_source_id: 'old', Amount: '7.00' } });
  const third = await migrateCsv({ app, dir, dc: 'in', catalystBase: 'https://api.catalyst.zoho.in', fetch, checkpoint: emptyCheckpoint(), scope: SCOPE });
  assert.equal(third.ok, true);
  assert.deepEqual(third.warnings, [
    `Book.Amount__n: 1 rows have a NULL shadow but a value in Amount; decimal criteria read them all until you run c2c deploy <app> --project ${SCOPE.projectId} --org ${SCOPE.org} --backfill-shadows --confirm`,
  ]);
  posts.pop();
  const short = writeRichCsv({ bookCount: 9 });
  await assert.rejects(
    () => migrateCsv({ app, dir: short, dc: 'in', catalystBase: 'https://api.catalyst.zoho.in', fetch, checkpoint: emptyCheckpoint(), scope: SCOPE }),
    /CSV row count for Book is 1 but counts.json says 9/,
  );
});

test('source csv plans locally and a guard does not fetch', async () => {
  const ds = join(mkdtempSync(join(tmpdir(), 'c2c-rich-')), 'widget.ds');
  writeFileSync(ds, RICH);
  const dir = writeRichCsv();
  const cap = capture();
  const planned = await sourceCsvCli(
    ['--source-csv', dir, '--ds', ds, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile()],
    cap.io,
  );
  assert.equal(planned, 0);
  assert.equal(cap.fetched.length, 0);
  assert.equal(cap.restCalls.length, 0);
  assert.match(cap.stdout(), /source: csv/);
  assert.match(cap.stdout(), /writes: no/);
  assert.match(cap.stdout(), /Book source 1/);
  assert.match(cap.stdout(), /skipped:\n- none/);
  assert.equal(cap.stdout().includes(SECRET), false);
  const blocked = capture();
  const refused = await sourceCsvCli(
    ['--source-csv', dir, '--ds', ds, '--project', PROTECTED, '--org', '10000000000', '--projects', projectsFile(), '--confirm'],
    blocked.io,
  );
  assert.equal(refused, 2);
  assert.equal(blocked.fetched.length, 0);
  assert.equal(blocked.restCalls.length, 0);
});

test('source id counts are chunked at 300 and a total table count does not pass', async () => {
  const ids = Array.from({ length: 301 }, (_, index) => `s${index}`);
  const queries = sourceIdCountQueries('Book', ids);
  assert.equal(queries.length, 2);
  assert.match(queries[0], /SELECT COUNT\(ROWID\) FROM Book WHERE c2c_source_id IN \(/);
  assert.equal(queries[0].includes("'s300'"), false);
  assert.match(queries[1], /'s300'/);
  assert.deepEqual(sourceIdCountQueries('Book', []), []);
  assert.throws(() => sourceIdCountQueries('Book;drop', ['s0']), /not a ZCQL identifier/);

  const app = deriveIr(parse(RICH));
  const dir = writeRichCsv();
  const posts: string[] = [];
  const stored = new Map<string, Map<string, { rowid: string; columns: Record<string, string> }>>();
  let seq = 1;
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') throw new Error('csv migrate called Creator');
    assertScopedCall(url, init);
    if (new URL(url).pathname.endsWith('/query')) {
      const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
      const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1] ?? '';
      const rows = stored.get(table) ?? new Map<string, { rowid: string; columns: Record<string, string> }>();
      if (/COUNT\(/i.test(sql)) {
        // An unfiltered COUNT(ROWID) of the whole table would equal this CSV and pass vacuously.
        if (!/WHERE c2c_source_id IN \(/.test(sql)) return response({ data: [{ 'COUNT(ROWID)': '1' }] });
        return response({ data: [{ 'COUNT(ROWID)': '0' }] });
      }
      if (/^SELECT ROWID, c2c_source_id FROM /i.test(sql)) return response({ data: [...rows].map(([source, row]) => ({ c2c_source_id: source, ROWID: row.rowid })) });
      return response({ data: [...rows].map(([source, row]) => ({ ...row.columns, c2c_source_id: source, ROWID: row.rowid })) });
    }
    const table = decodeURIComponent(new URL(url).pathname.split('/').at(-2) ?? '');
    posts.push(table);
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns: Record<string, string> }[] };
    const bucket = stored.get(table) ?? new Map<string, { rowid: string; columns: Record<string, string> }>();
    for (const row of body.rows) bucket.set(row.columns.c2c_source_id, { rowid: `r${seq++}`, columns: { ...row.columns } });
    stored.set(table, bucket);
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const migrated = await migrateCsv({
    app,
    dir,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.ok(posts.includes('Book'));
  assert.equal(migrated.ok, false);
  const book = migrated.counts.find((item) => item.form === 'Book');
  assert.equal(book?.catalyst, 0);
  assert.equal(book?.expected, 1);
  assert.equal(book?.mismatch, true);
});

test('source csv refuses an empty or all-zero export unless --allow-empty', async () => {
  const app = deriveIr(parse(RICH));
  const emptyBook = writeRichCsv({ dropBookRow: true });
  assert.throws(() => readSourceCsv(emptyBook, app), /refusing an empty export for Book; counts.json says 1/);
  const zeros = writeRichCsv({ zeros: true });
  assert.throws(() => readSourceCsv(zeros, app), /refusing an all-zero export; pass --allow-empty/);
  const allowed = readSourceCsv(zeros, app, true);
  assert.ok(allowed.tables.every((table) => table.rows.length === 0));

  const ds = join(mkdtempSync(join(tmpdir(), 'c2c-rich-')), 'widget.ds');
  writeFileSync(ds, RICH);
  const args = ['--source-csv', zeros, '--ds', ds, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile()];
  const refused = capture();
  const code = await sourceCsvCli(args, refused.io);
  assert.equal(code, 1);
  assert.equal(refused.fetched.length, 0);
  assert.match(refused.stderr(), /refusing an all-zero export; pass --allow-empty/);
  const planned = capture();
  const ok = await sourceCsvCli([...args, '--allow-empty'], planned.io);
  assert.equal(ok, 0);
  assert.equal(planned.fetched.length, 0);
  assert.match(planned.stdout(), /writes: no/);
});

test('a form with two subforms is a Data Store form: counts.json must list it, no nosql gap, csv writes only rows it has', async () => {
  const ds = join(mkdtempSync(join(tmpdir(), 'c2c-bom-')), 'widget.ds');
  writeFileSync(ds, BOM);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-bom-csv-'));
  writeFileSync(join(dir, 'Item.csv'), 'ID,Name\n1,Bolt\n');
  writeFileSync(join(dir, 'counts.json'), JSON.stringify({ Item: 1, Create_BOM: 0 }));
  const gap = '- skip nosql Create_BOM (POST /nosqltable is refused)';
  const planned = capture();
  const planCode = await sourceCsvCli(
    ['--source-csv', dir, '--ds', ds, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile()],
    planned.io,
  );
  assert.equal(planCode, 0, planned.stderr());
  assert.equal(planned.fetched.length, 0);
  assert.match(planned.stdout(), /source: csv/);
  assert.ok(!planned.stdout().includes(gap), planned.stdout());
  assert.ok(!/skip nosql/.test(planned.stdout()), planned.stdout());

  const written: string[] = [];
  const stored: Record<string, string>[] = [];
  const live = capture();
  live.io.fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') throw new Error('csv migrate called Creator');
    assertScopedCall(url, init);
    const path = new URL(url).pathname;
    if (path.endsWith('/query')) {
      const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
      if (/COUNT\(/i.test(sql)) {
        assert.match(sql, /WHERE c2c_source_id IN \('1'\)/);
        assert.equal(/FROM Create_BOM/.test(sql), false);
        return response({ data: [{ 'COUNT(ROWID)': '1' }] });
      }
      if (/^SELECT ROWID, c2c_source_id FROM /i.test(sql)) return response({ data: [{ c2c_source_id: '1', ROWID: 'r1' }] });
      return response({ data: stored.map((row) => ({ ...row })) });
    }
    const table = decodeURIComponent(path.split('/').at(-2) ?? '');
    written.push(table);
    const body = JSON.parse(init?.body ?? '{}') as { rows: { id: string; columns: Record<string, string> }[] };
    for (const row of body.rows) stored.push({ ...row.columns });
    return response({ ids: body.rows.map((row) => row.id) });
  };
  const code = await sourceCsvCli(
    ['--source-csv', dir, '--ds', ds, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile(), '--confirm'],
    live.io,
  );
  assert.equal(code, 0, live.stderr());
  assert.deepEqual(written, ['Item']);
  assert.ok(!/skip nosql/.test(live.stdout()), live.stdout());
  assert.match(live.stdout(), /Item: catalyst 1 expected 1 mismatch false/);
});

test('csv copies Creator system columns and records a gap when the headers omit them', () => {
  const src = `application "Widget"
{
	form Item
	{
		Name
		(
			type = text
		)
		Lines
		(
			type = grid
			Item
			(
				type = text
			)
		)
	}
}
`;
  const app = deriveIr(parse(src));
  const guard = { projectName: 'c2c-widget', projectId: '1001', org: '10000000000', environment: 'Development', dc: 'eu' };
  const withHeaders = mkdtempSync(join(tmpdir(), 'c2c-sys-'));
  writeFileSync(
    join(withHeaders, 'Item.csv'),
    'ID,Name,Added User,CREATEDTIME,Modified User,MODIFIEDTIME\n7,widget,ada,13-Apr-2023 17:21:24,ada,13-Apr-2023 17:21:24\n',
  );
  writeFileSync(join(withHeaders, 'counts.json'), JSON.stringify({ Item: 1 }));
  const loaded = readSourceCsv(withHeaders, app);
  const row = loaded.tables.find((table) => table.table === 'Item')?.rows[0];
  assert.equal(row?.columns.Added_User, 'ada');
  assert.equal(row?.columns.Added_Time, '2023-04-13 17:21:24');
  assert.equal(row?.columns.Modified_User, 'ada');
  assert.equal(row?.columns.Modified_Time, '2023-04-13 17:21:24');
  assert.equal(loaded.systemFieldGaps?.length ?? 0, 0);
  const plan = formatCsvPlan(loaded, guard);
  assert.equal(plan.includes('system fields:'), false);
  assert.match(plan, /writes: no/);

  const missing = mkdtempSync(join(tmpdir(), 'c2c-sys-gap-'));
  writeFileSync(join(missing, 'Item.csv'), 'ID,Name\n7,widget\n');
  writeFileSync(join(missing, 'counts.json'), JSON.stringify({ Item: 1 }));
  const gapped = readSourceCsv(missing, app);
  assert.equal(gapped.systemFieldGaps?.length, 1);
  assert.equal(gapped.systemFieldGaps?.[0]?.table, 'Item');
  assert.deepEqual(gapped.systemFieldGaps?.[0]?.missing, ['Added_User', 'Added_Time', 'Modified_User', 'Modified_Time']);
  assert.equal(gapped.skipped.some((gap) => /Added_User/.test(gap.detail)), false);
  const gapPlan = formatCsvPlan(gapped, guard);
  assert.match(gapPlan, /system fields:\n- Item missing Added_User, Added_Time, Modified_User, Modified_Time/);
  assert.match(gapPlan, /writes: no/);
  assert.ok(gapPlan.indexOf('system fields:') < gapPlan.indexOf('writes: no'));
  assert.match(gapPlan, /skipped:\n- none/);
});

function writeRichCsv(opts: { authorCell?: string; dropId?: boolean; bookCount?: number; dropBookRow?: boolean; zeros?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-csv-'));
  if (opts.zeros) {
    writeFileSync(join(dir, 'Author.csv'), 'ID,Name\n');
    writeFileSync(join(dir, 'Book.csv'), 'ID,Author,When,Amount,Tags,Photo\n');
    writeFileSync(join(dir, 'Order.csv'), 'ID,Title\n');
    writeFileSync(join(dir, 'Order__Lines.csv'), 'ID,Parent_ID,Qty\n');
    writeFileSync(join(dir, 'counts.json'), JSON.stringify({ Author: 0, Book: 0, Order: 0 }));
    return dir;
  }
  const bookHeader = opts.dropId ? 'Author,When,Amount,Tags,Photo' : 'ID,Author,When,Amount,Tags,Photo';
  const bookRow = opts.dropId ? `${opts.authorCell ?? '42'},05-Oct-2026,"1,234.50","red, blue",files/a.png` : `b1,${opts.authorCell ?? '42'},05-Oct-2026,"1,234.50","red, blue",files/a.png`;
  writeFileSync(join(dir, 'Author.csv'), 'ID,Name\n42,Ada\n');
  writeFileSync(join(dir, 'Book.csv'), opts.dropBookRow ? `${bookHeader}\n` : `${bookHeader}\n${bookRow}\n`);
  writeFileSync(join(dir, 'Order.csv'), 'ID,Title\n100,Batch\n');
  writeFileSync(join(dir, 'Order__Lines.csv'), 'ID,Parent_ID,Qty\n300,100,2.50\n');
  writeFileSync(join(dir, 'counts.json'), JSON.stringify({ Author: 1, Book: opts.bookCount ?? 1, Order: 1 }));
  return dir;
}

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

function itemDs(dir: string): string {
  const path = join(dir, 'widget.ds');
  writeFileSync(path, 'application "Widget"\n{\n\tform Item\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t\tmaxchar = 255\n\t\t)\n\t}\n}\n');
  return path;
}

function writeSeed(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'c2c-seed-')), 'seed.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      tables: [
        {
          table: 'Item',
          rows: [
            { c2c_source_id: 's1', Name: 'a' },
            { c2c_source_id: 's2', Name: 'b' },
          ],
        },
      ],
    }),
  );
  return path;
}

// Row insert, nullable source id, unique varchar budget, and a failed table step. Catalyst shapes are the recorded ones.

/** Catalyst as observed: /rows → 404 INVALID_URL_PATTERN; /row takes an array and echoes stored rows. */
function liveRowStore(stored: Map<string, Record<string, unknown>>, org: string = SCOPE.org): FetchLike {
  return async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') throw new Error('migrate called Creator');
    assertScopedCall(url, init, org);
    const path = new URL(url).pathname;
    if (path.endsWith('/query')) return response({ status: 'success', data: [...stored.values()].map((row) => ({ ...row })) });
    if (path.endsWith('/rows')) return catalystFailure(404, 'INVALID_URL_PATTERN', 'Please check if the URL trying to access is a correct one');
    assert.match(path, ROW_PATH);
    const rows = JSON.parse(init?.body ?? 'null') as Record<string, unknown>[];
    assert.ok(Array.isArray(rows) && rows.length <= 200);
    for (const row of rows) stored.set(String(row.c2c_source_id), { ...row });
    return catalystRows(rows);
  };
}

test('migrate-data --seed --confirm writes through /row against the recorded Catalyst shapes', async () => {
  const stored = new Map<string, Record<string, unknown>>();
  const cap = capture(undefined, '10000000000');
  cap.io.fetch = liveRowStore(stored, '10000000000');
  const seed = writeSeed();
  const args = ['--seed', seed, '--ds', itemDs(dirname(seed)), '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile(), '--confirm'];
  const code = await seedMigrateCliReal(args, cap.io);
  assert.equal(cap.stderr(), '');
  assert.equal(code, 0);
  assert.match(cap.stdout(), /Item: source 2 written 2 mismatch false/);
  assert.deepEqual([...stored.keys()].sort(), ['s1', 's2']);
});

test('loader integrity: seed --confirm --ds refuses over-long text and writes the report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-integrity-seed-'));
  const seed = join(dir, 'seed.json');
  writeFileSync(
    seed,
    JSON.stringify({ version: 1, tables: [{ table: 'Item', rows: [{ c2c_source_id: 's1', Name: 'toolong' }] }] }),
  );
  const ds = join(dir, 'widget.ds');
  writeFileSync(ds, 'application "Widget"\n{\n\tform Item\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t\tmaxchar = 4\n\t\t)\n\t}\n}\n');
  const store = quirkRowServer({ truncate: { Name: 4 } });
  const cap = capture(undefined, '10000000000');
  cap.io.fetch = store.fetch;
  const code = await seedMigrateCliReal(
    ['--seed', seed, '--ds', ds, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile(), '--confirm'],
    cap.io,
  );
  assert.equal(code, 1);
  assert.equal(store.posts.length, 0);
  const report = JSON.parse(readFileSync(join(dir, LOADER_REPORT), 'utf8')) as {
    kind: string;
    integrity: { refusedByRule: { rule: string; rows: { table: string; column: string; sourceId: string }[] }[] };
  };
  assert.equal(report.kind, 'loader-integrity');
  assert.equal(report.integrity.refusedByRule[0]?.rule, 'text-length');
  assert.deepEqual(report.integrity.refusedByRule[0]?.rows[0], { table: 'Item', column: 'Name', sourceId: 's1' });
  assert.equal(JSON.stringify(report).includes('toolong'), false);
  assert.equal(existsSync(join(dir, DEPLOY_REPORT)), false);
  assert.match(cap.stderr(), /Item\.Name s1 refused text-length/);
});

test('seed --confirm without --ds names the flag and does not write', async () => {
  const seed = writeSeed();
  const cap = capture();
  let called = false;
  cap.io.fetch = async () => {
    called = true;
    return response({});
  };
  const code = await seedMigrateCliReal(
    ['--seed', seed, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile(), '--confirm'],
    cap.io,
  );
  assert.equal(code, 2);
  assert.equal(called, false);
  assert.match(cap.stderr(), /requires --ds/);
  assert.equal(existsSync(join(dirname(seed), LOADER_REPORT)), false);
});

test('seed --confirm --ds refuses before any fetch when a seed table is not in the app schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-missing-schema-'));
  const seed = join(dir, 'seed.json');
  const longName = 'abcdefghijklmnopqrstuvwxyz'.repeat(20);
  assert.equal(longName.length, 520);
  writeFileSync(
    seed,
    JSON.stringify({
      version: 1,
      tables: [
        { table: 'Item', rows: [{ c2c_source_id: 's0', Name: 'ok' }] },
        { table: 'Other', rows: [{ c2c_source_id: 's1', Name: longName }] },
        { table: 'Extra', rows: [{ c2c_source_id: 's2', Name: 'x' }] },
      ],
    }),
  );
  const ds = join(dir, 'widget.ds');
  writeFileSync(ds, 'application "Widget"\n{\n\tform Item\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t\tmaxchar = 255\n\t\t)\n\t}\n}\n');
  const cap = capture();
  const store = quirkRowServer();
  let tokens = 0;
  cap.io.fetch = store.fetch;
  cap.io.accessToken = async () => {
    tokens += 1;
    return CLI_TOKEN;
  };
  const code = await seedMigrateCliReal(
    ['--seed', seed, '--ds', ds, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile(), '--confirm'],
    cap.io,
  );
  assert.equal(code, 1);
  assert.equal(store.posts.length, 0);
  assert.equal(tokens, 0);
  assert.match(cap.stderr(), /seed table Other is not in the app schema/);
  assert.equal(cap.stderr().includes(longName), false);
  assert.equal(cap.stdout(), '');
  assert.equal(existsSync(join(dir, LOADER_REPORT)), false);
});

test('a load whose integrity report is not verified exits non-zero', async () => {
  const store = quirkRowServer();
  const result = await migrateSeedReal({
    tables: [{ table: 'Other', rows: [{ id: 's1', columns: { Name: 'a'.repeat(520) } }] }],
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, true);
  assert.equal(result.integrity?.verified, false);
  assert.equal(result.integrity?.unverified, 1);
  assert.equal(store.posts.length, 1);
  assert.equal(String(store.posts[0]?.[0]?.Name).length, 520);
  assert.equal(confirmedLoadExit(true, result.integrity), 1);
});

test('a refused --seed write prints Catalyst code and message, not just the status', async () => {
  const cap = capture(undefined, '10000000000');
  cap.io.fetch = async (url) => {
    if (new URL(url).pathname.endsWith('/query')) return response({ status: 'success', data: [] });
    return catalystFailure(400, 'INVALID_INPUT', 'Invalid input value for Order_Date. date value expected');
  };
  const seed = writeSeed();
  const args = ['--seed', seed, '--ds', itemDs(dirname(seed)), '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile(), '--confirm'];
  const code = await seedMigrateCliReal(args, cap.io);
  assert.equal(code, 1);
  assert.match(cap.stderr(), /catalyst write failed: 400 INVALID_INPUT: Invalid input value for Order_Date\. date value expected \(POST \/baas\/v1\/project\/1001\/table\/Item\/row\)/);
  assert.equal(cap.stderr().includes(CLI_TOKEN), false);
});

test('migrate-data --source-csv --confirm writes every table through /row', async () => {
  const ds = join(mkdtempSync(join(tmpdir(), 'c2c-rich-')), 'widget.ds');
  writeFileSync(ds, RICH);
  const stored = new Map<string, Record<string, unknown>>();
  const live = liveRowStore(stored, '10000000000');
  const posts: string[] = [];
  const cap = capture(undefined, '10000000000');
  cap.io.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if ((init?.method ?? 'GET') === 'POST' && !path.endsWith('/query')) posts.push(path);
    if (path.endsWith('/query')) {
      const query = String((JSON.parse(init?.body ?? '{}') as { query?: string }).query ?? '');
      const ids = [...query.matchAll(/'([^']*)'/g)].map((m) => m[1]!).filter((id) => stored.has(id));
      if (/COUNT\(ROWID\)/.test(query)) return response({ status: 'success', data: [{ T: { 'COUNT(ROWID)': String(ids.length) } }] });
      if (/^SELECT ROWID, c2c_source_id FROM /.test(query)) {
        return response({ status: 'success', data: ids.map((id, i) => ({ T: { ROWID: String(10000000000000001 + i), c2c_source_id: id } })) });
      }
      return response({ status: 'success', data: ids.map((id) => ({ T: { ...stored.get(id), ROWID: 'r' + id } })) });
    }
    if ((init?.method ?? 'GET') === 'PUT') return response({ status: 'success', data: [] });
    return live(url, init);
  };
  const code = await sourceCsvCliReal(
    ['--source-csv', writeRichCsv(), '--ds', ds, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile(), '--confirm'],
    cap.io,
  );
  assert.equal(code, 0, cap.stderr());
  assert.ok(posts.length > 0);
  for (const path of posts) assert.match(path, ROW_PATH);
  assert.ok(stored.has('b1') && stored.has('42'));
});

test('c2c_source_id is created nullable and not unique on every table', () => {
  const steps = tableCreatePlan(generateSchema(deriveIr(parse(RICH))));
  const source = steps.flatMap((step) => step.columns.filter((column) => column.column_name === 'c2c_source_id'));
  assert.ok(source.length >= 3);
  for (const column of source) {
    assert.equal(column.is_mandatory, false);
    assert.equal(column.is_unique, false);
  }
});

test('deploy never sends a column batch with more unique varchar columns than Data Store allows', async () => {
  const store = memoryRest();
  const step = {
    table: 'Add_User',
    form: 'Add_User',
    nosql: false,
    columns: ['Mail_ID', 'Phone', 'Code'].map((name) => ({ table: 'Add_User', column_name: name, data_type: 'varchar', max_length: 255, is_unique: true, is_mandatory: false })),
  };
  await assert.rejects(() => applyTablePlan('1001', [step], store.rest), /refusing to create Add_User: 3 unique varchar columns \(Mail_ID, Phone, Code\); Data Store allows 2/);
  assert.equal(store.calls.filter((call) => call.method === 'POST').length, 0);
});

test('a failed table step still writes c2c-deploy-report.json and the post-deploy steps', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-out-'));
  const cap = capture();
  const inner = cap.io.rest!;
  let columnPosts = 0;
  cap.io.rest = async (call) => {
    if (call.method === 'POST' && call.path.endsWith('/column') && ++columnPosts === 1) {
      return {
        status: 403,
        body: { status: 'failure', data: { error_code: 'INVALID_OPERATION', message: 'You cannot perform this operation. Reached max number of columns of Unique varchar type' } },
      };
    }
    return inner(call);
  };
  const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out], cap.io);
  assert.equal(code, 1);
  assert.match(cap.stderr(), /create columns on \w+ failed: 403 INVALID_OPERATION: You cannot perform this operation\. Reached max number of columns of Unique varchar type/);
  assert.equal(cap.stdout().includes('Start Exploring'), false);
  assert.match(cap.stdout(), /post-deploy \(console\):\n- Authentication > Authorized Domains:/);
  assert.match(cap.stdout(), /then re-run this command with --resume/);
  const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { exitCode: number; tableError?: string; tableDiff: { createdTables: string[] }; commands: unknown[] };
  assert.equal(report.exitCode, 1);
  assert.match(report.tableError ?? '', /INVALID_OPERATION/);
  assert.ok(report.tableDiff.createdTables.length >= 1);
  assert.deepEqual(report.commands, []);
  assert.equal(cap.spawned.filter((call) => !call.args.includes('project:list')).length, 0);
  rmSync(out, { recursive: true, force: true });
});

test('generated submit handlers carry the app-unique fields to the runtime', () => {
  const src = `application "Users"
{
	form Add_User
	{
		must have unique Mail_ID
		(
			type = email
		)
		unique Phone
		(
			type = phonenumber
		)
		unique Code
		(
			type = text
		)
	}
}
`;
  const bundle = buildDeploy(deriveIr(parse(src)), checkGuards({ org: '10000000000', projectId: '1003', appLink: 'Users', credentialPath: SECRET, registry: { ...registry, projects: { ...registry.projects, 'c2c-Users': '1003' } } }), false, false);
  const submit = bundle.files.find((file) => file.path.endsWith('add-user/submit.mjs'));
  assert.ok(submit, bundle.files.map((file) => file.path).join('\n'));
  assert.match(String(submit.data), /appUniqueColumns: \{"Add_User":\["Code"\]\}/);
  assert.match(bundle.plan, /- Code VarChar.* app-unique/);
});

test('migrateSeed refuses a table that repeats a source id before any write', async () => {
  const stored = new Map<string, Record<string, unknown>>();
  const live = liveRowStore(stored);
  let posts = 0;
  const result = await migrateSeedReal({
    tables: [{ table: 'Item', rows: [{ id: 's1', columns: { Name: 'a' } }, { id: 's2', columns: { Name: 'b' } }, { id: 's1', columns: { Name: 'c' } }] }],
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch: async (url, init) => {
      posts += 1;
      return live(url, init);
    },
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.tables[0]!.duplicateIds, ['s1']);
  assert.equal(posts, 0);
});

test('catalyst.json writes slate as an array the CLI can link against', () => {
  const guard = checkGuards({ org: '10000000000', projectId: '1001', appLink: 'Widget', credentialPath: SECRET, registry });
  const app = deriveIr(parse(DS));
  const { files } = buildDeploy(app, guard, false);
  const raw = files.find((file) => file.path === 'catalyst.json');
  assert.ok(raw, 'missing catalyst.json');
  const catalyst = JSON.parse(typeof raw.data === 'string' ? raw.data : raw.data.toString('utf8')) as { slate: unknown };
  // zcatalyst-cli 1.27.2 addExistingSlate calls existingSlates.findIndex: an
  // object here crashes every re-run behind "contact Catalyst support".
  assert.ok(Array.isArray(catalyst.slate), `slate must be an array, got ${JSON.stringify(catalyst.slate)}`);
});

test('a resume migrates an object-shaped slate field instead of crashing again', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-migrate-'));
  try {
    const first = capture();
    assert.equal(await deployCli([...baseArgs(ds), '--out', out, '--confirm', '--function-env', 'new'], first.io), 0);
    const path = join(out, 'catalyst.json');
    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    written.slate = { name: 'c2c-widget', framework: 'static', source: 'slate' };
    writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
    const second = capture();
    assert.equal(await deployCli([...baseArgs(ds), '--out', out, '--confirm', '--function-env', 'new', '--resume'], second.io), 0);
    const migrated = JSON.parse(readFileSync(path, 'utf8')) as { slate: unknown };
    assert.ok(Array.isArray(migrated.slate), `resume kept the object slate: ${JSON.stringify(migrated.slate)}`);
    assert.ok(second.spawned.some((call) => call.args.includes('slate:link')), 'slate:link never ran');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

function slateIo(appUrl: string, slateFails: { code: number; stderr: string } | undefined) {
  const cap = capture();
  const spawned = cap.spawned;
  cap.io.spawn = async (command, args, opts) => {
    if (args.includes('project:list')) {
      spawned.push({ command, args, env: opts.env });
      return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
    }
    if (args.includes('slate') && !args.includes('--only')) {
      spawned.push({ command, args, env: opts.env });
      if (slateFails && args[args.length - 2] === 'c2c-widget') {
        return { code: slateFails.code, stdout: `App Url: ${appUrl}\n`, stderr: slateFails.stderr };
      }
      return { code: 0, stdout: `App Url: ${appUrl}\n`, stderr: '' };
    }
    spawned.push({ command, args, env: opts.env });
    return { code: 0, stdout: '', stderr: '' };
  };
  return cap;
}

test('a slate deploy prints the App URL and writes it to the deploy report', async () => {
  const url = 'https://c2c-widget-abc123.onslate.in';
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-url-'));
  try {
    const cap = slateIo(url, undefined);
    assert.equal(await deployCli([...baseArgs(ds), '--out', out, '--confirm', '--function-env', 'new'], cap.io), 0);
    assert.match(cap.stdout(), new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { slate?: { appUrl?: string } };
    assert.equal(report.slate?.appUrl, url);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a 404 after a live Slate build is explained, not a plain failure', async () => {
  const url = 'https://c2c-widget-abc123.onslate.in';
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-404-'));
  try {
    // Trial sandbox shape: the build goes live (App Url printed), then the CLI
    // fails polling the app id. The app is served; c2c must say so.
    const cap = slateIo(url, { code: 1, stderr: '✖ HTTP Error: 404, No such app with the given id exists' });
    const code = await deployCli([...baseArgs(ds), '--out', out, '--confirm', '--function-env', 'new'], cap.io);
    assert.equal(code, 0, `classified failure should not fail the deploy\n${cap.stderr()}`);
    assert.match(cap.stdout(), /No such app with the given id/);
    assert.match(cap.stdout(), new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { slate?: { appUrl?: string; notice?: string } };
    assert.equal(report.slate?.appUrl, url);
    assert.match(report.slate?.notice ?? '', /No such app with the given id/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a slate 404 with no built URL still fails the deploy', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-404bare-'));
  try {
    const cap = capture();
    cap.io.spawn = async (command, args, opts) => {
      cap.spawned.push({ command, args, env: opts.env });
      if (args.includes('project:list')) return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
      if (args.includes('slate')) {
        return { code: 1, stdout: '', stderr: '✖ HTTP Error: 404, No such app with the given id exists' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    assert.equal(await deployCli([...baseArgs(ds), '--out', out, '--confirm', '--function-env', 'new'], cap.io), 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// What slate:link writes: the CLI appends the registered app to the array.
const LINKED_SLATE = [{ name: 'c2c-widget', framework: 'static', source: 'slate', id: '9001' }];

async function linkedOut(ds: string, out: string): Promise<string> {
  const first = capture();
  assert.equal(await deployCli([...baseArgs(ds), '--out', out, '--confirm', '--function-env', 'new'], first.io), 0);
  const path = join(out, 'catalyst.json');
  const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  written.slate = LINKED_SLATE;
  writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
  return path;
}

test('a CLI-extended slate array survives a bundle-changed resume and a plain re-run', async () => {
  for (const flow of ['changed-resume', 'plain-rerun'] as const) {
    const ds = writeDs();
    const out = mkdtempSync(join(tmpdir(), 'c2c-slate-keep-'));
    try {
      const path = await linkedOut(ds, out);
      if (flow === 'changed-resume') writeFileSync(ds, readFileSync(ds, 'utf8').replace('SECRET_VALUE_SHOULD_NOT_PRINT', 'CHANGED_VALUE'));
      const second = capture();
      const args = [...baseArgs(ds), '--out', out, '--confirm', '--function-env', 'new', ...(flow === 'changed-resume' ? ['--resume'] : [])];
      assert.equal(await deployCli(args, second.io), 0, flow);
      if (flow === 'changed-resume') assert.match(second.stdout(), /bundle changed since the last run/);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).slate, LINKED_SLATE, `${flow} dropped the linked slate array`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
});

test('a plain re-run still replaces an object-shaped slate with an array', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-obj-'));
  try {
    const path = await linkedOut(ds, out);
    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    written.slate = { name: 'c2c-widget', framework: 'static', source: 'slate' };
    writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
    const second = capture();
    assert.equal(await deployCli([...baseArgs(ds), '--out', out, '--confirm', '--function-env', 'new'], second.io), 0);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).slate, []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

function slateStepIo(linkStdout: string, slate: { code: number; stdout: string; stderr: string }) {
  const cap = capture();
  cap.io.spawn = async (command, args, opts) => {
    cap.spawned.push({ command, args, env: opts.env });
    if (args.includes('project:list')) return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
    if (args.includes('slate:link')) return { code: 0, stdout: linkStdout, stderr: '' };
    if (args.includes('slate')) return slate;
    return { code: 0, stdout: '', stderr: '' };
  };
  return cap;
}

test('a slate 404 is not excused by an App Url that slate:link printed', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-linkurl-'));
  try {
    const cap = slateStepIo('App Url: https://stale-widget.onslate.in\n', { code: 1, stdout: '', stderr: '✖ HTTP Error: 404, No such app with the given id exists' });
    assert.equal(await deployCli([...baseArgs(ds), '--out', out, '--confirm', '--function-env', 'new'], cap.io), 1);
    const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { slate?: { appUrl?: string; notice?: string } };
    assert.deepEqual(report.slate, {});
    assert.doesNotMatch(cap.stdout(), /stale-widget/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('an ANSI-coloured App Url from the slate build is captured', async () => {
  const ds = writeDs();
  for (const failing of [false, true]) {
    const out = mkdtempSync(join(tmpdir(), 'c2c-slate-ansi-'));
    try {
      const stdout = '\u001b[1m\u001b[32m✔\u001b[39m\u001b[22m App Url: \u001b[36mhttps://c2c-widget-abc123.onslate.in\u001b[39m\n';
      const cap = slateStepIo('', failing
        ? { code: 1, stdout, stderr: '✖ HTTP Error: 404, No such app with the given id exists' }
        : { code: 0, stdout, stderr: '' });
      assert.equal(await deployCli([...baseArgs(ds), '--out', out, '--confirm', '--function-env', 'new'], cap.io), 0);
      const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { slate?: { appUrl?: string; notice?: string } };
      assert.equal(report.slate?.appUrl, 'https://c2c-widget-abc123.onslate.in');
      assert.equal(!!report.slate?.notice, failing);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Transient Catalyst failures and the Slate URL read-back.
// A transient failure on a column create:
//   POST /baas/v1/project/<id>/table/<id>/column →
//   500 {"status":"failure","data":{"message":"Internal server error has occurred. Please try again after some time","error_code":"INTERNAL_SERVER_ERROR"}}
// and CLI output where slate:link prints only "Slate linked successfully"
// and deploy slate prints no "App Url:" line at all.

const TRANSIENT_500 = {
  status: 'failure',
  data: { message: 'Internal server error has occurred. Please try again after some time', error_code: 'INTERNAL_SERVER_ERROR' },
};

const SLATE_DOMAIN = 'c2c-widget-abc123.onslate.in';

function slateAppList(domain?: string) {
  return {
    data: domain
      ? [{ id: '3000000000000123', name: 'c2c-widget', domain, deployment_type_config: { id: '9001', domain, current_build: { deployment_id: '9001' } } }]
      : [],
  };
}

/** No "App Url:" anywhere: slate:link reports only the link, deploy slate prints a bare build log. */
function noSlateUrlIo(listBody: () => unknown): ReturnType<typeof capture> {
  const cap = capture();
  cap.io.sleep = async () => {};
  const inner = cap.io.rest!;
  cap.io.rest = async (call) => {
    if (call.method === 'GET' && call.path === '/slate/v1/project/1001/app') return { status: 200, body: listBody() };
    return inner(call);
  };
  cap.io.spawn = async (command, args, opts) => {
    cap.spawned.push({ command, args, env: opts.env });
    if (args.includes('project:list')) return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
    if (args.includes('slate:link')) return { code: 0, stdout: 'Slate linked successfully\n', stderr: '' };
    return { code: 0, stdout: 'building slate app… done\n', stderr: '' };
  };
  return cap;
}

test('a deploy whose CLI output has no "App Url:" reads the URL from the Slate API and uses it for CORS', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-api-'));
  try {
    const cap = noSlateUrlIo(() => slateAppList(SLATE_DOMAIN));
    const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out], cap.io);
    assert.equal(code, 0, cap.stdout().slice(-800) + cap.stderr());
    assert.match(cap.stdout(), /slate url \(from the Slate API\): https:\/\/c2c-widget-abc123\.onslate\.in/);
    const state = JSON.parse(readFileSync(join(out, '.c2c-deploy-state.json'), 'utf8')) as { slateUrl?: string };
    assert.equal(state.slateUrl, `https://${SLATE_DOMAIN}`);
    assert.deepEqual(cap.restCalls.find((c) => c.method === 'POST' && c.path.endsWith('/cors-domain'))?.body, {
      domain: SLATE_DOMAIN,
      cors: true,
      iframe: true,
    });
    const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { slate?: { appUrl?: string } };
    assert.equal(report.slate?.appUrl, `https://${SLATE_DOMAIN}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a resumed run recovers the Slate URL from the API when the earlier run never captured it', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-resume-'));
  try {
    let listed = slateAppList();
    const first = noSlateUrlIo(() => listed);
    assert.equal(await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out, '--resume'], first.io), 0);
    assert.equal((JSON.parse(readFileSync(join(out, '.c2c-deploy-state.json'), 'utf8')) as { slateUrl?: string }).slateUrl, undefined);
    // The app is deployed now; the resumed run skips every command but must still find the URL.
    listed = slateAppList(SLATE_DOMAIN);
    const second = noSlateUrlIo(() => listed);
    assert.equal(await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out, '--resume'], second.io), 0);
    assert.match(second.stdout(), /skip slate \(done in an earlier run\)/);
    assert.match(second.stdout(), /slate url \(from the Slate API\): https:\/\/c2c-widget-abc123\.onslate\.in/);
    const state = JSON.parse(readFileSync(join(out, '.c2c-deploy-state.json'), 'utf8')) as { slateUrl?: string };
    assert.equal(state.slateUrl, `https://${SLATE_DOMAIN}`);
    assert.deepEqual(second.restCalls.find((c) => c.method === 'POST' && c.path.endsWith('/cors-domain'))?.body, {
      domain: SLATE_DOMAIN,
      cors: true,
      iframe: true,
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a transient 500 on the column create is retried and the deploy still finishes', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-retry-col-'));
  try {
    const cap = capture();
    cap.io.sleep = async () => {};
    const inner = cap.io.rest!;
    let posts = 0;
    cap.io.rest = async (call) => {
      if (call.method === 'POST' && call.path.includes('/column')) {
        posts += 1;
        if (posts === 1) return { status: 500, body: TRANSIENT_500 };
      }
      return inner(call);
    };
    const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out], cap.io);
    assert.equal(code, 0, cap.stdout().slice(-800) + cap.stderr());
    assert.equal(posts, 2);
    assert.match(cap.stdout(), /retry 1\/3 in \d+ms: POST \/baas\/v1\/project\/1001\/table\/t1\/column \(HTTP 500\)/);
    const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { exitCode: number };
    assert.equal(report.exitCode, 0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a table create that fails after it landed is found by the re-list, not re-posted', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-retry-tbl-'));
  try {
    const cap = capture();
    cap.io.sleep = async () => {};
    const inner = cap.io.rest!;
    let posts = 0;
    cap.io.rest = async (call) => {
      if (call.method === 'POST' && call.path.endsWith('/table')) {
        posts += 1;
        // The write landed; the response was still the transient failure.
        await inner(call);
        return { status: 500, body: TRANSIENT_500 };
      }
      return inner(call);
    };
    const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out], cap.io);
    assert.equal(code, 0, cap.stdout().slice(-800) + cap.stderr());
    assert.equal(posts, 1);
    assert.match(cap.stdout(), /created-tables:\n- Item/);
    assert.ok(cap.restCalls.some((c) => c.method === 'POST' && c.path.includes('/column')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a persistent 500 gives up after four tries and reports the original error', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-retry-exhaust-'));
  try {
    const cap = capture();
    cap.io.sleep = async () => {};
    const inner = cap.io.rest!;
    let posts = 0;
    cap.io.rest = async (call) => {
      if (call.method === 'POST' && call.path.includes('/column')) {
        posts += 1;
        return { status: 500, body: TRANSIENT_500 };
      }
      return inner(call);
    };
    const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out], cap.io);
    assert.equal(code, 1);
    assert.equal(posts, 4);
    assert.equal(cap.stdout().match(/retry \d\/3 in \d+ms: POST \/baas\/v1\/project\/1001\/table\/t1\/column \(HTTP 500\)/g)?.length, 3);
    assert.match(cap.stderr(), /create columns on Item failed: 500 INTERNAL_SERVER_ERROR/);
    const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { exitCode: number; tableError?: string };
    assert.equal(report.exitCode, 1);
    assert.match(report.tableError ?? '', /create columns on Item failed: 500/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a transient 500 from the functions deploy re-runs the command and deploys', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-retry-fn-'));
  try {
    const cap = capture();
    cap.io.sleep = async () => {};
    let deploys = 0;
    cap.io.spawn = async (command, args, opts) => {
      cap.spawned.push({ command, args, env: opts.env });
      if (args.includes('project:list')) return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
      if (args.includes('--only')) {
        deploys += 1;
        if (deploys === 1) {
          return { code: 2, stdout: '', stderr: 'HTTP Error: 500, Internal server error has occurred. Please try again after some time' };
        }
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out], cap.io);
    assert.equal(code, 0, cap.stdout().slice(-800) + cap.stderr());
    assert.equal(deploys, 2);
    assert.match(cap.stdout(), /retry 1\/3 in \d+ms: catalyst --org 10000000000 --project 1001 deploy --only functions:c2c_api -ni \(exit 2\)/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a transient slate deploy failure re-reads the app URL before retrying', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-retry-'));
  try {
    const cap = noSlateUrlIo(() => slateAppList(SLATE_DOMAIN));
    let slates = 0;
    const innerSpawn = cap.io.spawn;
    cap.io.spawn = async (command, args, opts) => {
      if (args.includes('deploy') && args.includes('slate')) {
        slates += 1;
        if (slates === 1) {
          cap.spawned.push({ command, args, env: opts.env });
          return { code: 2, stdout: '', stderr: 'HTTP Error: 503, Service Unavailable' };
        }
      }
      return innerSpawn(command, args, opts);
    };
    const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out], cap.io);
    assert.equal(code, 0, cap.stdout().slice(-800) + cap.stderr());
    assert.equal(slates, 2);
    assert.match(cap.stdout(), /slate url \(from the Slate API\): https:\/\/c2c-widget-abc123\.onslate\.in/);
    assert.deepEqual(cap.restCalls.find((c) => c.method === 'POST' && c.path.endsWith('/cors-domain'))?.body, {
      domain: SLATE_DOMAIN,
      cors: true,
      iframe: true,
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Retries must never duplicate a write that may have landed. These fakes do
// not enforce name uniqueness: a blind re-send shows up as a second table,
// a doubled column batch, or a second same-name Slate app.

/** A Data Store fake whose table list is an array: a re-POSTed create adds a second same-name table. */
function noUniqueTables(opts: {
  listStatus?: () => number;
  /** List reads after a write that still report the pre-write state. */
  staleReadsAfterWrite?: number;
  detailStatus?: () => number;
  columnStatus?: () => number;
}): {
  rest: RestFn;
  tables: { name: string; id: string; columns: string[] }[];
  calls: { method: string; path: string; body?: unknown }[];
} {
  const tables: { name: string; id: string; columns: string[] }[] = [];
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let stale = 0;
  const listBody = (view: typeof tables) => ({
    data: view.map((table) => ({
      table_name: table.name,
      table_id: table.id,
      column_details: table.columns.map((column_name) => ({ column_name })),
    })),
  });
  const rest: RestFn = async (call) => {
    calls.push(call);
    if (call.method === 'GET' && call.path.endsWith('/table')) {
      const status = opts.listStatus?.() ?? 200;
      if (status !== 200) return { status, body: TRANSIENT_500 };
      if (stale > 0) {
        stale -= 1;
        return { status: 200, body: listBody(tables.slice(0, -1)) };
      }
      return { status: 200, body: listBody(tables) };
    }
    if (call.method === 'GET' && /\/table\/[^/]+$/.test(call.path)) {
      const status = opts.detailStatus?.() ?? 200;
      if (status !== 200) return { status, body: TRANSIENT_500 };
      const id = call.path.split('/table/')[1]?.split('/')[0];
      const found = tables.find((table) => table.id === id);
      if (!found) return { status: 404, body: {} };
      return { status: 200, body: { data: { column_details: found.columns.map((column_name) => ({ column_name })) } } };
    }
    if (call.method === 'POST' && call.path.endsWith('/table')) {
      const name = (call.body as { table_name: string }).table_name;
      tables.push({ name, id: `t${tables.length + 1}`, columns: [] });
      stale = opts.staleReadsAfterWrite ?? 0;
      return { status: 500, body: TRANSIENT_500 };
    }
    if (call.method === 'POST' && call.path.includes('/column')) {
      const id = call.path.split('/table/')[1]?.split('/')[0];
      const found = tables.find((table) => table.id === id);
      for (const column of call.body as { column_name: string }[]) found?.columns.push(column.column_name);
      const status = opts.columnStatus?.() ?? 200;
      return { status, body: status === 200 ? { status: 'success' } : TRANSIENT_500 };
    }
    return { status: 404, body: {} };
  };
  return { rest, tables, calls };
}

const RETRY_STEP = {
  table: 'Item',
  form: 'Item',
  nosql: false,
  columns: [
    { table: 'Item', column_name: 'a', data_type: 'varchar', max_length: 255, is_unique: false, is_mandatory: false },
    { table: 'Item', column_name: 'b', data_type: 'varchar', max_length: 255, is_unique: false, is_mandatory: false },
  ],
};

test('a table create whose re-list fails stops instead of re-posting blind', async () => {
  const store = noUniqueTables({ listStatus: () => (store.calls.some((call) => call.method === 'POST') ? 500 : 200) });
  await assert.rejects(() => applyTablePlan('1001', [RETRY_STEP], store.rest, { sleep: async () => {} }), /create table Item failed: 500/);
  // The write landed once; every re-list failed, so nothing can prove absence — no second POST.
  assert.equal(store.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/table')).length, 1);
  assert.equal(store.tables.filter((table) => table.name === 'Item').length, 1);
});

test('a table create whose list lags one read is re-read after the backoff, never re-created', async () => {
  const store = noUniqueTables({ staleReadsAfterWrite: 1 });
  const diff = await applyTablePlan('1001', [RETRY_STEP], store.rest, { sleep: async () => {} });
  assert.equal(store.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/table')).length, 1);
  assert.equal(store.tables.filter((table) => table.name === 'Item').length, 1);
  assert.deepEqual(diff.createdTables, ['Item']);
  assert.deepEqual(diff.createdColumns, ['Item.a', 'Item.b']);
});

test('a column batch whose table re-read fails stops instead of re-sending the whole batch', async () => {
  const store = noUniqueTables({ detailStatus: () => 500, columnStatus: () => 500 });
  // The table already exists; the detail read and the column POST both fail.
  store.tables.push({ name: 'Item', id: 't1', columns: [] });
  await assert.rejects(() => applyTablePlan('1001', [RETRY_STEP], store.rest, { sleep: async () => {} }), /create columns on Item failed: 500/);
  const posts = store.calls.filter((call) => call.method === 'POST' && call.path.includes('/column'));
  // The failed re-read proves nothing — the batch is never re-sent blind.
  assert.equal(posts.length, 1);
  assert.deepEqual(store.tables[0]?.columns, ['a', 'b']);
});

test('a column batch that partially landed is narrowed to the missing columns', async () => {
  const columns: string[] = [];
  let posts = 0;
  const rest: RestFn = async (call) => {
    if (call.method === 'GET' && call.path.endsWith('/table')) {
      return { status: 200, body: { data: [{ table_name: 'Item', table_id: 't1', column_details: [] }] } };
    }
    if (call.method === 'GET' && call.path.endsWith('/table/t1')) {
      return { status: 200, body: { data: { column_details: columns.map((column_name) => ({ column_name })) } } };
    }
    if (call.method === 'POST' && call.path.includes('/column')) {
      posts += 1;
      // The first batch lands 'a' only, then fails; the narrowed retry lands 'b'.
      if (posts === 1) {
        columns.push('a');
        return { status: 500, body: TRANSIENT_500 };
      }
      for (const column of call.body as { column_name: string }[]) columns.push(column.column_name);
      return { status: 200, body: { status: 'success' } };
    }
    return { status: 404, body: {} };
  };
  const diff = await applyTablePlan('1001', [RETRY_STEP], rest, { sleep: async () => {} });
  assert.equal(posts, 2);
  assert.deepEqual(columns, ['a', 'b']);
  assert.deepEqual(diff.createdColumns, ['Item.a', 'Item.b']);
});

test('a slate:link that fails after creating the app is not re-run — the read-back ends it', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-link-retry-'));
  try {
    const apps: { id: string; name: string; domain?: string }[] = [];
    const cap = noSlateUrlIo(() => ({ data: apps }));
    const innerSpawn = cap.io.spawn;
    cap.io.spawn = async (command, args, opts) => {
      if (args.includes('slate:link')) {
        // The link landed (the app exists, no name uniqueness) but the CLI still failed transiently.
        apps.push({ id: `900${apps.length + 1}`, name: 'c2c-widget', domain: `c2c-widget-${apps.length}00.onslate.in` });
        cap.spawned.push({ command, args, env: opts.env });
        return { code: 2, stdout: '', stderr: 'HTTP Error: 500, Internal server error has occurred. Please try again after some time' };
      }
      return innerSpawn(command, args, opts);
    };
    const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out], cap.io);
    assert.equal(code, 0, cap.stdout().slice(-800) + cap.stderr());
    assert.equal(cap.spawned.filter((call) => call.args.includes('slate:link')).length, 1);
    assert.equal(apps.length, 1);
    assert.match(cap.stdout(), /slate url \(from the Slate API\): https:\/\/c2c-widget-000\.onslate\.in/);
    const state = JSON.parse(readFileSync(join(out, '.c2c-deploy-state.json'), 'utf8')) as { done: string[] };
    assert.ok(state.done.includes('slate-link'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('two Slate apps with the same name are reported and never guessed at', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-ambig-'));
  try {
    const cap = noSlateUrlIo(() => ({
      data: [
        { id: '3000000000000123', name: 'c2c-widget', domain: 'first-aa11.onslate.in' },
        { id: '3000000000000456', name: 'c2c-widget', domain: 'second-bb22.onslate.in' },
      ],
    }));
    const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out], cap.io);
    assert.equal(code, 0, cap.stdout().slice(-800) + cap.stderr());
    assert.match(cap.stdout(), /2 Slate apps named "c2c-widget"/);
    assert.match(cap.stdout(), /--slate-domain/);
    // Nothing is stored and CORS never runs with a guessed host.
    assert.equal(cap.restCalls.find((call) => call.method === 'POST' && call.path.endsWith('/cors-domain')), undefined);
    const state = JSON.parse(readFileSync(join(out, '.c2c-deploy-state.json'), 'utf8')) as { slateUrl?: string };
    assert.equal(state.slateUrl, undefined);
    const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { slate?: { appUrl?: string } };
    assert.equal(report.slate?.appUrl, undefined);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a missing Slate app reports that the URL was not found', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-missing-'));
  try {
    const cap = noSlateUrlIo(() => ({ data: [{ id: '3000000000000123', name: 'other-app', domain: 'other-aa11.onslate.in' }] }));
    const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--out', out], cap.io);
    assert.equal(code, 0, cap.stdout().slice(-800) + cap.stderr());
    assert.match(cap.stdout(), /slate url not found: no app named "c2c-widget"/);
    assert.equal(cap.restCalls.find((call) => call.method === 'POST' && call.path.endsWith('/cors-domain')), undefined);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the first-admin role is pinned: --admin-role accepts only App Administrator', async () => {
  const ds = writeDs();
  const cap = capture();
  const code = await deployCli([...baseArgs(ds), '--admin-email', 'owner@example.test', '--admin-role', 'CEO'], cap.io);
  assert.equal(code, 1);
  assert.match(cap.stderr(), /--admin-role.*App Administrator/);
  const ok = await deployCli([...baseArgs(ds), '--admin-email', 'owner@example.test', '--admin-role', 'App Administrator'], capture().io);
  assert.equal(ok, 0);
});

// Live deploy blockers: reserved env names, the Slate app name, and the
// Slate list lagging a build that printed its App Url.

function noNetwork(cap: ReturnType<typeof capture>): void {
  assert.deepEqual(cap.spawned, [], 'no catalyst command may run');
  assert.deepEqual(cap.restCalls, [], 'no REST call may run');
  assert.deepEqual(cap.fetched, [], 'no fetch may run');
}

test('a --function-env file with a reserved name is refused before any network call', async () => {
  const ds = writeDs();
  const dir = mkdtempSync(join(tmpdir(), 'c2c-fenv-reserved-'));
  try {
    for (const reserved of ['PROJECT_ID', 'CATALYST_ENV', 'DC']) {
      const file = join(dir, `${reserved}.json`);
      writeFileSync(file, JSON.stringify({ [reserved]: 'x', C2C_ZOHO_DC: 'in' }));
      const cap = capture();
      const code = await deployCli([...baseArgs(ds), '--out', join(dir, 'out'), '--confirm', '--function-env', file], cap.io);
      assert.notEqual(code, 0);
      assert.match(cap.stderr(), new RegExp(`c2c: function env: ${reserved} is a name Catalyst reserves`));
      noNetwork(cap);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the deploy derives a valid Slate app name from a project name with underscores', () => {
  const guard = checkGuards({ org: '10000000000', projectId: '4242', appLink: 'library_system_application', credentialPath: SECRET, registry: { ...registry, projects: {} } });
  assert.equal(guard.projectName, 'c2c-library_system_application');
  const { commands } = buildDeploy(deriveIr(parse(DS)), guard, false);
  const link = commands.find((command) => command.id === 'slate-link')!;
  assert.equal(link.argv[link.argv.indexOf('--name') + 1], 'c2c-library-system-application');
  assert.deepEqual(commands.find((command) => command.id === 'slate')!.argv.slice(-2), ['c2c-library-system-application', '-ni']);
});

test('--slate-name overrides the Slate app name and is validated before any network call', async () => {
  const ds = writeDs();
  for (const bad of ['my_app', '-app', 'a--b']) {
    const cap = capture();
    const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--slate-name', bad], cap.io);
    assert.notEqual(code, 0);
    assert.match(cap.stderr(), /c2c: --slate-name: .* is not a Slate app name/);
    noNetwork(cap);
  }
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-name-'));
  try {
    const cap = capture();
    assert.equal(await deployCli([...baseArgs(ds), '--out', out, '--confirm', '--function-env', 'new', '--slate-name', 'c2c-library-app'], cap.io), 0, cap.stderr());
    const link = cap.spawned.find((call) => call.args.includes('slate:link'))!;
    assert.equal(link.args[link.args.indexOf('--name') + 1], 'c2c-library-app');
    assert.ok(cap.spawned.some((call) => call.args.join(' ').endsWith('deploy slate c2c-library-app -ni')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

/** deploy slate prints "App Url(<name>): …" then exits 1; the app list names the app only after `listedAfter` reads. */
function laggingSlateIo(listedAfter: number) {
  const cap = capture();
  const waits: number[] = [];
  cap.io.sleep = async (ms) => {
    waits.push(ms);
  };
  let built = false;
  let reads = 0;
  const inner = cap.io.rest!;
  cap.io.rest = async (call) => {
    if (call.method === 'GET' && call.path === '/slate/v1/project/1001/app') {
      if (built) reads += 1;
      return { status: 200, body: slateAppList(built && reads > listedAfter ? SLATE_DOMAIN : undefined) };
    }
    return inner(call);
  };
  cap.io.spawn = async (command, args, opts) => {
    cap.spawned.push({ command, args, env: opts.env });
    if (args.includes('project:list')) return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
    if (args.includes('slate:link')) return { code: 0, stdout: 'Slate linked successfully\n', stderr: '' };
    if (args.includes('slate') && !args.includes('--only')) {
      built = true;
      return { code: 1, stdout: `App Url(c2c-widget): https://${SLATE_DOMAIN}\n`, stderr: '✖ Error: could not read the app status' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { cap, waits };
}

test('a Slate build that printed its App Url succeeds once the lagging app list names it', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-lag-'));
  try {
    const { cap, waits } = laggingSlateIo(1);
    const code = await deployCli([...baseArgs(ds), '--out', out, '--confirm', '--function-env', 'new'], cap.io);
    assert.equal(code, 0, cap.stdout().slice(-800) + cap.stderr());
    assert.ok(waits.includes(2000), `the list read waited 2 s before it named the app: ${waits.join(',')}`);
    const report = JSON.parse(readFileSync(join(out, DEPLOY_REPORT), 'utf8')) as { slate?: { appUrl?: string; notice?: string } };
    assert.equal(report.slate?.appUrl, `https://${SLATE_DOMAIN}`);
    assert.match(report.slate?.notice ?? '', /Slate app list names "c2c-widget"/);
    assert.equal((JSON.parse(readFileSync(join(out, '.c2c-deploy-state.json'), 'utf8')) as { slateUrl?: string }).slateUrl, `https://${SLATE_DOMAIN}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a Slate build whose app never appears in the list still fails, after a bounded wait', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-slate-never-'));
  try {
    const { cap, waits } = laggingSlateIo(Number.POSITIVE_INFINITY);
    assert.equal(await deployCli([...baseArgs(ds), '--out', out, '--confirm', '--function-env', 'new'], cap.io), 1);
    for (const ms of [2000, 4000, 8000]) assert.ok(waits.includes(ms), `missing the ${ms} ms wait: ${waits.join(',')}`);
    assert.equal(waits.filter((ms) => ms >= 2000).length, 3, 'the poll is bounded to three waits');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
