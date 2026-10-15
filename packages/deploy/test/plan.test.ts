/**
 * Offline `c2c plan` — no credentials, no project.
 *
 * A customer must be able to plan before a project exists: plan of the L1 and
 * bill-of-materials fixtures with `env -u X_ZC_CREDENTIAL_PATH` exits 0, makes
 * zero network calls (fetch/spawn trap), and is byte-identical across two runs.
 * No hard-coded org/project/DC: DC comes from `--dc` or c2c-deploy.json and
 * plan.md says which.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openZip } from '../src/zipfile.js';
import { buildOfflinePlan, planCli, PLAN_STEP_TOOLS, resolveDc, type ProvisionStep } from '../src/offline-plan.js';
import { ALL_REQUIRED_MCP_TOOLS, REQUIRED_MCP_TOOLS } from '../../doctor/src/required-tools.js';
import { f5TableBudgets } from '../../doctor/src/checks.js';
import { loadApp, type Io } from '../src/cli.js';
import { deriveIr, parse, parseFile, type App } from '../../core/src/index.js';
import { generateSchema, type SourceTableData } from '../../schema/src/generator.js';
import { limitValue, selectListOf } from '../../schema/src/limits.js';
import { SOURCE_ID_COLUMN } from '../../schema/src/mapping.js';
import { generateUi } from '../../ui/src/generate.js';
import { pathToFileURL } from 'node:url';
import { repoRoot } from '../../core/src/toolchain.js';

const execFileAsync = promisify(execFile);

const DS = `application "Widget"
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
\t\tlist Open_Items
\t\t{
\t\t\tdisplayName = "Open"
\t\t\tshow all rows from Item
\t\t}
\t}
}
`;

const DS_UNIQUE = `application "Widget"
{
\ttime zone = "Asia/Kolkata"
\tsection S
\t{
\t\tform Contact
\t\t{
\t\t\tmust have unique Mail_Id
\t\t\t(
\t\t\t\ttype = email
\t\t\t)
\t\t\tmust have unique Phone
\t\t\t(
\t\t\t\ttype = phonenumber
\t\t\t)
\t\t\tmust have unique Code
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t}
}
`;

const fixtures = process.env.C2C_FIXTURES_DIR;
const l1Ds = fixtures ? join(fixtures, 'synthetic', 's01-purchase-orders', 'L1', 'c2c-syn-po-l1.exported.ds') : '';
const bomDs = fixtures ? join(fixtures, 'gallery', 'bill-of-materials', 'Bill_Of_Materials.ds') : '';
const hasL1 = !!fixtures && !!statSync(l1Ds, { throwIfNoEntry: false })?.isFile();
const hasBom = !!fixtures && !!statSync(bomDs, { throwIfNoEntry: false })?.isFile();
const fleetHubDs = fixtures ? join(fixtures, 'gallery', 'fleet-hub', 'Fleet_Hub.ds') : '';
const hasFleetHub = !!fixtures && !!statSync(fleetHubDs, { throwIfNoEntry: false })?.isFile();
const skipFleetHub = !hasFleetHub || !hasBom ? 'C2C_FIXTURES_DIR fleet-hub fixture not available' : false;
const skipFixtures = !hasL1 || !hasBom ? 'C2C_FIXTURES_DIR L1/BOM fixtures not available' : false;

/** Offline trap: any spawn or fetch is a failure, not a fallback. */
function offlineIo(env: NodeJS.ProcessEnv = {}): { io: Io; stdout: () => string; stderr: () => string; calls: string[] } {
  let out = '';
  let err = '';
  const calls: string[] = [];
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env,
    spawn: async (command, args) => {
      calls.push(`spawn ${command} ${args.join(' ')}`);
      throw new Error(`network refused in plan test: spawn ${command}`);
    },
    fetch: async (url) => {
      calls.push(`fetch ${url}`);
      throw new Error(`network refused in plan test: fetch ${url}`);
    },
  };
  return { io, stdout: () => out, stderr: () => err, calls };
}

function writeDs(body: string = DS): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-plan-ds-'));
  const path = join(dir, 'app.ds');
  writeFileSync(path, body);
  return path;
}

function hashTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (base: string, rel: string) => {
    for (const entry of readdirSync(join(base, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(base, next);
      else out.push(`${createHash('sha256').update(readFileSync(join(base, next))).digest('hex')}  ${next}`);
    }
  };
  walk(dir, '');
  return out;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

test('resolveDc: --dc wins, then c2c-deploy.json, never a silent default', () => {
  assert.deepEqual(resolveDc(['--dc', 'in'], '/nonexistent-cwd'), { dc: 'in', source: '--dc' });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-plan-cfg-'));
  writeFileSync(join(dir, 'c2c-deploy.json'), JSON.stringify({ dc: 'eu', org: '1', apps: {} }));
  assert.deepEqual(resolveDc([], dir), { dc: 'eu', source: 'c2c-deploy.json' });
  // --dc wins over the file.
  assert.deepEqual(resolveDc(['--dc', 'us'], dir), { dc: 'us', source: '--dc' });
  rmSync(dir, { recursive: true, force: true });
  assert.throws(() => resolveDc([], '/nonexistent-cwd'), /no data centre set.*--dc.*c2c-deploy\.json/);
  assert.throws(() => resolveDc(['--dc', 'moon'], '/nonexistent-cwd'), /unknown data centre/);
});

test('plan is offline: no credentials, no project, zero network calls', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-out-'));
  // Feed the configured org, project and account through every input a plan
  // run could read them from — c2c-deploy.json, --org/--project and the
  // environment — so the absence assertion below can actually fail.
  const cwd = mkdtempSync(join(tmpdir(), 'c2c-plan-cwd-'));
  writeFileSync(
    join(cwd, 'c2c-deploy.json'),
    JSON.stringify({ dc: 'in', org: '10000000000', project: '10000', account: 'example-account', apps: {} }),
  );
  const trap = offlineIo({ CATALYST_ORG: '10000000000' });
  assert.equal('X_ZC_CREDENTIAL_PATH' in trap.io.env, false);
  const previous = process.cwd();
  process.chdir(cwd);
  let code: number;
  try {
    code = await planCli([ds, '--out', out, '--dc', 'in', '--org', '10000000000', '--project', '10000'], trap.io);
  } finally {
    process.chdir(previous);
  }
  assert.equal(code, 0);
  assert.deepEqual(trap.calls, []);
  for (const file of ['plan.md', 'plan.json', 'provision/plan.json', 'c2c-manifest.json']) {
    assert.ok(statSync(join(out, file), { throwIfNoEntry: false })?.isFile(), `missing ${file}`);
  }
  const planMd = readFileSync(join(out, 'plan.md'), 'utf8');
  assert.match(planMd, /dc: in \(from --dc\)/);
  assert.match(planMd, /doctor: not-run/);
  const body = `${planMd}\n${readFileSync(join(out, 'plan.json'), 'utf8')}\n${readFileSync(join(out, 'provision/plan.json'), 'utf8')}`;
  for (const secret of ['10000000000', '10000', 'example-account']) {
    assert.equal(body.includes(secret), false, `plan output leaks ${secret}`);
  }
  rmSync(out, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test('plan is byte-identical across two runs', async () => {
  const ds = writeDs();
  const first = mkdtempSync(join(tmpdir(), 'c2c-plan-a-'));
  const second = mkdtempSync(join(tmpdir(), 'c2c-plan-b-'));
  assert.equal(await planCli([ds, '--out', first, '--dc', 'in'], offlineIo({}).io), 0);
  assert.equal(await planCli([ds, '--out', second, '--dc', 'in'], offlineIo({}).io), 0);
  assert.deepEqual(hashTree(first), hashTree(second));
  assert.ok(hashTree(first).length >= 4);
  rmSync(first, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
});

test('provision steps carry via, tool|command, args and a read-back', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-steps-'));
  assert.equal(await planCli([ds, '--out', out, '--dc', 'in'], offlineIo({}).io), 0);
  const steps = readJson(join(out, 'provision/plan.json')) as { steps: ProvisionStep[] };
  assert.ok(Array.isArray(steps.steps) && steps.steps.length > 0);
  for (const step of steps.steps) {
    assert.ok(typeof step.id === 'string' && step.id.length > 0);
    assert.ok(step.via === 'cli' || step.via === 'mcp' || step.via === 'console', `step ${step.id}: bad via`);
    assert.equal(!!step.tool !== !!step.command, true, `step ${step.id}: exactly one of tool|command`);
    assert.equal(typeof step.args, 'object');
    assert.ok(step.readBack && (step.readBack.via === 'cli' || step.readBack.via === 'mcp' || step.readBack.via === 'console'));
    assert.equal(!!step.readBack.tool !== !!step.readBack.command, true, `step ${step.id}: read-back needs tool|command`);
    assert.equal(typeof step.readBack.match, 'object');
  }
  const ids = steps.steps.map((step) => step.id);
  // No configured project: the create step is the single IaC import.
  assert.ok(ids.includes('import') && ids.includes('tables'));
  rmSync(out, { recursive: true, force: true });
});

const DS_WITH_PAGE = `application "Widget"
{
\ttime zone = "Asia/Kolkata"
\tsection S
\t{
\t\tdisplayname= "Dashboard"
\t\tpage Home
\t\t{
\t\t\tdisplayname = "Home"
\t\t\tContent="<zml>\\n\\t<layout width=\\"100%\\"></layout></zml>"
\t\t}
\t\tform Item
\t\t{
\t\t\tName
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t}
}
`;

test('a Slate client adds a slate-enable console step; Data Store and Functions get no activation step', async () => {
  const ds = writeDs(DS_WITH_PAGE);
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-slate-'));
  assert.equal(await planCli([ds, '--out', out, '--dc', 'in'], offlineIo({}).io), 0);
  const steps = (readJson(join(out, 'provision/plan.json')) as { steps: ProvisionStep[] }).steps;
  const slate = steps.find((step) => step.id === 'slate-enable');
  assert.ok(slate, 'slate-enable step missing');
  assert.equal(slate.via, 'console');
  assert.match(slate.command ?? '', /Slate/);
  assert.match(slate.command ?? '', /Start Exploring/);
  // c2c verifies the gate itself: a GET of the Slate app list, closed until opened.
  assert.equal(slate.readBack.via, 'cli');
  assert.deepEqual(slate.readBack.args, { call: { method: 'GET', path: '/slate/v1/project/<project>/app' } });
  assert.deepEqual(slate.readBack.match, { gate: 'open' });
  // First-use gates: Cloud Scale (verified by its own read, usually already
  // open) and Slate for a client app. Data Store and Functions get no step.
  const activation = steps.filter((step) => /Start Exploring/i.test(step.command ?? ''));
  assert.deepEqual(activation.map((step) => step.id), ['cloudscale-enable', 'slate-enable']);
  rmSync(out, { recursive: true, force: true });

  const noPage = mkdtempSync(join(tmpdir(), 'c2c-plan-noslate-'));
  assert.equal(await planCli([writeDs(), '--out', noPage, '--dc', 'in'], offlineIo({}).io), 0);
  const plain = (readJson(join(noPage, 'provision/plan.json')) as { steps: ProvisionStep[] }).steps;
  assert.equal(plain.some((step) => step.id === 'slate-enable'), false);
  rmSync(noPage, { recursive: true, force: true });
});

const DS_PORTAL_APP = `application "Portal App"
{
\tsection S
\t{
\t\tpage Home
\t\t{
\t\t\tdisplayname = "Home"
\t\t\tContent="<zml></zml>"
\t\t}
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
\t\t"Customers"
\t\t{
\t\t\tname = "Customers"
\t\t\ttype = Customer_Portal
\t\t}
\t}
}
`;

test('a client app with portal users orders its auth chain: Slate host, authorised domain, invites, sign-in check', async () => {
  const ds = writeDs(DS_PORTAL_APP);
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-order-'));
  assert.equal(await planCli([ds, '--out', out, '--dc', 'in'], offlineIo({}).io), 0);
  const steps = (readJson(join(out, 'provision/plan.json')) as { steps: ProvisionStep[] }).steps;
  const ids = steps.map((step) => step.id);
  const at = (id: string) => ids.indexOf(id);
  for (const id of ['slate-enable', 'authorized-domain', 'app-users', 'sign-in-check']) {
    assert.ok(at(id) >= 0, `the plan carries ${id}`);
  }
  assert.ok(at('slate-enable') < at('authorized-domain'), 'the host must exist before it is authorised');
  assert.ok(at('authorized-domain') < at('app-users'), 'the invites redirect into the hosted app — the domain is authorised first');
  assert.ok(at('app-users') < at('sign-in-check'), 'the sign-in check closes the chain');

  const domain = steps[at('authorized-domain')]!;
  assert.equal(domain.via, 'cli');
  // iFrame on is what lets the embedded sign-in frame load.
  assert.deepEqual((domain.args?.call as { body?: unknown } | undefined)?.body, { domain: '<slate-app-url-host>', cors: true, iframe: true });

  const check = steps[at('sign-in-check')]!;
  assert.equal(check.via, 'console');
  assert.deepEqual(check.readBack.match, { sign_in_page: true });
  assert.match(check.command ?? '', /iFrame/);
  rmSync(out, { recursive: true, force: true });
});

test('a bare client app still ends in the sign-in check', async () => {
  const ds = writeDs(DS_WITH_PAGE);
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-check-'));
  assert.equal(await planCli([ds, '--out', out, '--dc', 'in'], offlineIo({}).io), 0);
  const steps = (readJson(join(out, 'provision/plan.json')) as { steps: ProvisionStep[] }).steps;
  const ids = steps.map((step) => step.id);
  assert.ok(ids.indexOf('authorized-domain') < ids.indexOf('sign-in-check'), 'the sign-in check follows the authorised domain');
  assert.equal(ids.includes('app-users'), false, 'no portal users — no invites');
  rmSync(out, { recursive: true, force: true });
});


test('a Slate client adds a slate-enable console step; Data Store and Functions get no activation step', async () => {
  const ds = writeDs(DS_WITH_PAGE);
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-slate-'));
  assert.equal(await planCli([ds, '--out', out, '--dc', 'in'], offlineIo({}).io), 0);
  const steps = (readJson(join(out, 'provision/plan.json')) as { steps: ProvisionStep[] }).steps;
  const slate = steps.find((step) => step.id === 'slate-enable');
  assert.ok(slate, 'slate-enable step missing');
  assert.equal(slate.via, 'console');
  assert.match(slate.command ?? '', /Slate/);
  assert.match(slate.command ?? '', /Start Exploring/);
  // The ask carries the project's own Slate page — the console host is a token
  // resolved from the plan's data centre, never a hard-coded DC.
  assert.match(slate.command ?? '', /<console>\/baas\/<org>\/project\/<project>\/Development#\/slate/);
  // c2c verifies the gate itself: a GET of the Slate app list, closed until opened.
  assert.equal(slate.readBack.via, 'cli');
  assert.deepEqual(slate.readBack.args, { call: { method: 'GET', path: '/slate/v1/project/<project>/app' } });
  assert.deepEqual(slate.readBack.match, { gate: 'open' });
  // First-use gates: Cloud Scale (verified by its own read, usually already
  // open) and Slate for a client app. Data Store and Functions get no step.
  const activation = steps.filter((step) => /Start Exploring/i.test(step.command ?? ''));
  assert.deepEqual(activation.map((step) => step.id), ['cloudscale-enable', 'slate-enable']);
  rmSync(out, { recursive: true, force: true });

  const noPage = mkdtempSync(join(tmpdir(), 'c2c-plan-noslate-'));
  assert.equal(await planCli([writeDs(), '--out', noPage, '--dc', 'in'], offlineIo({}).io), 0);
  const plain = (readJson(join(noPage, 'provision/plan.json')) as { steps: ProvisionStep[] }).steps;
  assert.equal(plain.some((step) => step.id === 'slate-enable'), false);
  rmSync(noPage, { recursive: true, force: true });
});


test('a client app with portal users orders its auth chain: Slate host, authorised domain, invites, sign-in check', async () => {
  const ds = writeDs(DS_PORTAL_APP);
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-order-'));
  assert.equal(await planCli([ds, '--out', out, '--dc', 'in'], offlineIo({}).io), 0);
  const steps = (readJson(join(out, 'provision/plan.json')) as { steps: ProvisionStep[] }).steps;
  const ids = steps.map((step) => step.id);
  const at = (id: string) => ids.indexOf(id);
  for (const id of ['slate-enable', 'authorized-domain', 'app-users', 'sign-in-check']) {
    assert.ok(at(id) >= 0, `the plan carries ${id}`);
  }
  assert.ok(at('slate-enable') < at('authorized-domain'), 'the host must exist before it is authorised');
  assert.ok(at('authorized-domain') < at('app-users'), 'the invites redirect into the hosted app — the domain is authorised first');
  assert.ok(at('app-users') < at('sign-in-check'), 'the sign-in check closes the chain');

  const domain = steps[at('authorized-domain')]!;
  assert.equal(domain.via, 'cli');
  // iFrame on is what lets the embedded sign-in frame load.
  assert.deepEqual((domain.args?.call as { body?: unknown } | undefined)?.body, { domain: '<slate-app-url-host>', cors: true, iframe: true });

  const check = steps[at('sign-in-check')]!;
  assert.equal(check.via, 'console');
  assert.deepEqual(check.readBack.match, { sign_in_page: true });
  assert.match(check.command ?? '', /iFrame/);
  rmSync(out, { recursive: true, force: true });
});

test('a bare client app still ends in the sign-in check', async () => {
  const ds = writeDs(DS_WITH_PAGE);
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-check-'));
  assert.equal(await planCli([ds, '--out', out, '--dc', 'in'], offlineIo({}).io), 0);
  const steps = (readJson(join(out, 'provision/plan.json')) as { steps: ProvisionStep[] }).steps;
  const ids = steps.map((step) => step.id);
  assert.ok(ids.indexOf('authorized-domain') < ids.indexOf('sign-in-check'), 'the sign-in check follows the authorised domain');
  assert.equal(ids.includes('app-users'), false, 'no portal users — no invites');
  rmSync(out, { recursive: true, force: true });
});

/** One text form named Wide, plus a list of every row, so a read is generated. */
function wideApp(userFields: number): App {
  const fields = Array.from({ length: userFields }, (_, index) => {
    const name = `F${String(index).padStart(2, '0')}`;
    return `\t\t\t${name}\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)`;
  }).join('\n');
  return deriveIr(
    parse(
      `application "Widget"\n{\n\ttime zone = "Asia/Kolkata"\n\tsection S\n\t{\n\t\tform Wide\n\t\t{\n${fields}\n\t\t}\n\t\tlist All_Wide\n\t\t{\n\t\t\tshow all rows from Wide\n\t\t}\n\t}\n}\n`,
    ),
  );
}

function wideColumnCount(userFields: number): number {
  return generateSchema(wideApp(userFields)).tables.find((table) => table.name === 'Wide')?.columns.length ?? 0;
}

test('a table of 31 columns warns select-width, never fails: each generated read lists at most 30 columns', async () => {
  const overhead = wideColumnCount(1) - 1;
  const userFields = 31 - overhead;
  assert.ok(userFields > 0, 'schema columns include more than the declared fields');
  const app = wideApp(userFields);
  const schema = generateSchema(app);
  const wide = schema.tables.find((table) => table.name === 'Wide');
  assert.ok(wide);
  assert.equal(wide.columns.length, 31);

  const built = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false });
  assert.equal(built.plan.budgetsOk, true);
  const budget = built.plan.budgets.find((item) => item.id === 'select-width');
  assert.ok(budget);
  assert.equal(budget.status, 'warn');
  assert.equal(budget.table, 'Wide');
  assert.match(budget.detail, /widest generated read of Wide selects 30 columns per statement/);
  assert.match(budget.detail, /staged into 2 reads/);
  assert.match(built.files.find((file) => file.path === 'plan.md')?.data ?? '', /\[WARN\] \(select-width\) Wide: widest generated read of Wide selects 30 columns/);

  const ui = generateUi(app);
  const report = ui.files.find((file) => file.path.includes('/reports/'));
  assert.ok(report, ui.files.map((file) => file.path).join('\n'));
  const text = String(report.data);
  assert.equal(text.includes('SELECT *'), false);
  const staged = /export const zcqlStages = (\[[\s\S]*?\]);/.exec(text);
  assert.ok(staged, 'the generated read is not staged');
  const queries = JSON.parse(staged[1]!) as string[];
  assert.ok(queries.length >= 2);
  const selected = new Set<string>();
  for (const sql of queries) {
    const columns = selectListOf(sql);
    assert.ok(columns.length > 0 && columns.length <= limitValue('zcql.select_columns'), sql);
    assert.match(sql, / FROM Wide\b/, sql);
    assert.equal(sql.includes('SELECT *'), false);
    for (const column of columns) selected.add(column);
  }
  assert.equal(selected.has('ROWID'), true);
  for (const column of wide.columns) assert.equal(selected.has(column.name), true, column.name);

  const adapter = (await import(pathToFileURL(join(repoRoot(), 'packages/deploy/fn/c2c-sdk-datastore.mjs')).href)) as {
    LIMITS: { selectColumns: number };
    createSdkDatastore(app: unknown, opts?: Record<string, unknown>): {
      query(form: string, where: string, limit: number, offset?: number, orderBy?: string, columns?: string[]): Promise<Record<string, unknown>[]>;
    };
  };
  assert.equal(adapter.LIMITS.selectColumns, limitValue('zcql.select_columns'));
  const projection = ['ROWID', ...wide.columns.map((column) => column.name)];
  const sqls: string[] = [];
  const fake = {
    zcql: () => ({
      executeZCQLQuery: async (sql: string) => {
        sqls.push(sql);
        const row: Record<string, string> = {};
        for (const column of selectListOf(sql)) row[column] = column === 'ROWID' ? '1' : 'v';
        return [{ Wide: row }];
      },
    }),
  };
  const rows = await adapter.createSdkDatastore(fake, { projections: { Wide: projection } }).query('Wide', '', 1, 0, 'ORDER BY ROWID');
  assert.equal(rows.length, 1);
  assert.ok(sqls.length >= 2);
  const read = new Set<string>();
  for (const sql of sqls) {
    const columns = selectListOf(sql);
    assert.ok(columns.length > 0 && columns.length <= limitValue('zcql.select_columns'), sql);
    assert.match(sql, / FROM Wide\b/, sql);
    for (const column of columns) read.add(column);
  }
  for (const column of projection) {
    assert.equal(read.has(column), true, column);
    assert.equal(rows[0]?.[column], column === 'ROWID' ? '1' : 'v', column);
  }
});

test('the columns budget warns over the unverified default and fails only over the raised cap', () => {
  const overhead = wideColumnCount(1) - 1;
  const app = wideApp(120 - overhead);
  const built = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false });
  const budget = built.plan.budgets.find((item) => item.id === 'columns' && item.table === 'Wide');
  assert.ok(budget);
  assert.equal(budget.status, 'warn');
  assert.match(budget.detail, /120\/250 columns/);
  assert.match(budget.detail, /P-COLS/);
  // No table under the raised column cap may fail the columns budget.
  assert.equal(
    built.plan.budgets.some((item) => item.id === 'columns' && item.status === 'fail'),
    false,
  );
});

test('doctor, plan and the limits facts agree at the 250-column hard cap', () => {
  const cap = limitValue('datastore.columns_per_table');
  const columnsDefault = limitValue('datastore.columns_per_table_default');
  const facts = readFileSync(join(repoRoot(), 'plugin/references/facts/limits.md'), 'utf8');
  const columnsRule = /^Rule: (.+)$/m.exec(facts)?.[1];
  assert.ok(columnsRule, 'facts ledger must have a Rule line for columns per table');
  const documentedCap = /Plan for (\d+) columns per table \[UNVERIFIED\]/.exec(columnsRule)?.[1];
  const documentedDefault = /stated default is (\d+) columns per table \[UNVERIFIED\]/.exec(columnsRule)?.[1];
  assert.ok(documentedCap, 'facts ledger must document the raised column cap');
  assert.ok(documentedDefault, 'facts ledger must document the default column cap');
  assert.equal(Number(documentedCap), cap, 'facts ledger raised cap must match the code');
  assert.equal(Number(documentedDefault), columnsDefault, 'facts ledger default must match the code');
  assert.match(columnsRule, /c2c plan warns when a table exceeds/);
  assert.match(columnsRule, /c2c plan splits overflow fields/);
  assert.match(columnsRule, /c2c doctor refuses a live table over/);

  const overhead = wideColumnCount(1) - 1;
  const atCapApp = wideApp(cap - overhead);
  const atCapTables = generateSchema(atCapApp).tables;
  const atCapPlan = buildOfflinePlan(atCapApp, { dc: 'in', dcSource: '--dc', mail: false }).plan.budgets.find(
    (item) => item.id === 'columns' && item.table === 'Wide',
  );
  assert.ok(atCapPlan);
  assert.equal(atCapPlan.status, 'warn', atCapPlan.detail);
  assert.match(atCapPlan.detail, new RegExp(`${cap}/${cap} columns`));
  assert.equal(atCapTables.find((table) => table.name === 'Wide')?.columns.length, cap);
  assert.equal(f5TableBudgets(atCapTables).status, 'warn');

  const overCapApp = wideApp(cap + 1 - overhead);
  const generatedOver = generateSchema(overCapApp).tables;
  assert.ok(generatedOver.length > 1, 'schema splits a source form at the hard cap');
  assert.ok(generatedOver.every((table) => table.columns.length <= cap));
  const overCapPlan = buildOfflinePlan(overCapApp, { dc: 'in', dcSource: '--dc', mail: false });
  assert.ok(overCapPlan.plan.budgets.filter((item) => item.id === 'columns').every((item) => item.status !== 'fail'));

  const syntheticOverCap = { ...atCapTables[0]!, name: 'Over_Cap', columns: [...atCapTables[0]!.columns, atCapTables[0]!.columns[0]!] };
  const doctorOver = f5TableBudgets([syntheticOverCap]);
  assert.equal(doctorOver.status, 'fail', doctorOver.detail);
  assert.equal(doctorOver.detail, `table Over_Cap needs ${cap + 1} columns (max ${cap})`);
});

test('the plan budgets the mover write calls against the stated Dev write rate', () => {
  const app = loadApp(writeDs());
  const rows = (count: number) => ({ table: 'Item', rows: Array.from({ length: count }, () => ({ columns: {} })) });
  const rate = limitValue('datastore.write_requests_per_minute');

  const noSource = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false });
  const unmeasured = noSource.plan.budgets.find((item) => item.id === 'dev-write-rate');
  assert.ok(unmeasured, 'a dev-write-rate budget is listed');
  assert.equal(unmeasured.status, 'pass');
  assert.match(unmeasured.detail ?? '', /dev-api-calls budget carries the missing-source warning/);

  const over = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source: [rows(rate * 200)] });
  const overBudget = over.plan.budgets.find((item) => item.id === 'dev-write-rate');
  assert.ok(overBudget);
  assert.equal(overBudget.status, 'warn');
  assert.match(overBudget.detail ?? '', new RegExp(`${rate} insert calls`));
  assert.match(overBudget.fix ?? '', /P-RATE/);

  const under = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source: [rows(10)] });
  const underBudget = under.plan.budgets.find((item) => item.id === 'dev-write-rate');
  assert.ok(underBudget);
  assert.equal(underBudget.status, 'pass');
  assert.match(underBudget.detail ?? '', /1 insert call/);
});

test('the write-rate warning says a minute or more at exactly the stated rate', () => {
  const app = loadApp(writeDs());
  const rows = (count: number) => ({ table: 'Item', rows: Array.from({ length: count }, () => ({ columns: {} })) });
  const rate = limitValue('datastore.write_requests_per_minute');

  // Exactly rate batches: rate calls at rate calls/min is exactly a minute, not more.
  const atCap = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source: [rows(rate * 200)] });
  const atCapBudget = atCap.plan.budgets.find((item) => item.id === 'dev-write-rate');
  assert.ok(atCapBudget);
  assert.equal(atCapBudget.status, 'warn');
  assert.match(atCapBudget.detail ?? '', /a minute or more at the cap/);

  // One batch under the rate passes.
  const below = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source: [rows((rate - 1) * 200)] });
  const belowBudget = below.plan.budgets.find((item) => item.id === 'dev-write-rate');
  assert.ok(belowBudget);
  assert.equal(belowBudget.status, 'pass');
  assert.match(belowBudget.detail ?? '', new RegExp(`Item ${rate - 1} insert calls`));
});

test('missing source row counts warn once across the mover-call budgets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-plan-ds-pair-'));
  const dsPath = join(dir, 'app.ds');
  writeFileSync(
    dsPath,
    'application "Widget"\n{\n\tform Author\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n\tform Book\n\t{\n\t\tTitle\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n}\n',
  );
  const app = loadApp(dsPath);
  const schema = generateSchema(app);
  const storeTables = schema.tables.filter((table) => !table.nosql && table.role !== 'system');
  assert.deepEqual(
    storeTables.map((table) => table.name).sort(),
    ['Author', 'Book'],
  );

  // No source at all: only dev-api-calls warns; dev-write-rate refers to it.
  const noSource = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false });
  const apiWarn = noSource.plan.budgets.find((item) => item.id === 'dev-api-calls');
  const rateRow = noSource.plan.budgets.find((item) => item.id === 'dev-write-rate');
  assert.ok(apiWarn && rateRow);
  assert.equal(apiWarn.status, 'warn');
  assert.equal(rateRow.status, 'pass');
  assert.match(rateRow.detail ?? '', /dev-api-calls/);

  // Partial source: only dev-api-calls warns for the unmeasured table.
  const partial: SourceTableData[] = storeTables.slice(1).map((table) => ({ table: table.name, rows: [{ columns: {} }] }));
  const partialPlan = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source: partial });
  const apiPartial = partialPlan.plan.budgets.find((item) => item.id === 'dev-api-calls');
  const ratePartial = partialPlan.plan.budgets.find((item) => item.id === 'dev-write-rate');
  assert.ok(apiPartial && ratePartial);
  assert.equal(apiPartial.status, 'warn');
  assert.match(apiPartial.detail ?? '', new RegExp(`row counts are unknown for ${storeTables[0]!.name}`));
  assert.equal(ratePartial.status, 'pass');
  assert.match(ratePartial.detail ?? '', /counted in the dev-api-calls warning/);
  rmSync(dir, { recursive: true, force: true });
});

test('the plan reports the app table count against the org-wide table limit', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-tables-'));
  assert.equal(await planCli([ds, '--out', out, '--dc', 'in'], offlineIo({}).io), 0);
  const plan = readJson(join(out, 'plan.json')) as { counts: { tables: number; dataStoreTables: number }; budgets: { id: string; status: string; detail: string }[] };
  assert.ok(plan.counts.dataStoreTables > 0);
  const budget = plan.budgets.find((item) => item.id === 'org-tables');
  assert.ok(budget, 'an org-tables budget is listed');
  assert.match(budget.detail, new RegExp(`this app creates ${plan.counts.dataStoreTables} Data Store table\\(s\\)`));
  assert.match(budget.detail, /403 API_LIMIT_REACHED/);
  assert.match(budget.detail, /retry after 30\/60\/120 minutes/);
  assert.match(readFileSync(join(out, 'plan.md'), 'utf8'), /org-wide limit on table creates/);
  rmSync(out, { recursive: true, force: true });
});

test('the plan measures source string values against varchar column lengths', () => {
  const app = loadApp(writeDs());
  const item = generateSchema(app).tables.find((table) => table.name === 'Item');
  assert.ok(item);
  const name = item.columns.find((column) => column.name === 'Name');
  assert.ok(name && name.dataType === 'VarChar', 'Name maps to a varchar column');
  const cap = name.length ?? 255;
  const rows = (value: string, complete?: boolean) => ({ table: 'Item', complete, rows: [{ columns: { [name.name]: value } }] });

  const noSource = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false });
  const unmeasured = noSource.plan.budgets.find((budget) => budget.id === 'varchar-length');
  assert.ok(unmeasured, 'a varchar-length budget is listed');
  assert.equal(unmeasured.status, 'warn');
  assert.match(unmeasured.detail ?? '', /unmeasured/);
  assert.match(unmeasured.fix ?? '', /--source-/);

  const long = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source: [rows('x'.repeat(cap + 1), true)] });
  const budget = long.plan.budgets.find((item) => item.id === 'varchar-length');
  assert.ok(budget, 'a varchar-length budget names the over-length value');
  assert.equal(budget.status, 'warn');
  assert.match(budget.detail ?? '', new RegExp(`Item\\.${name.name}`));
  assert.match(budget.detail ?? '', new RegExp(`${cap + 1}/${cap}`));
  assert.match(budget.detail ?? '', /silently truncat/);
  assert.match(budget.fix ?? '', /shorten/);
  assert.match(long.files.find((file) => file.path === 'plan.md')?.data ?? '', /\[WARN\] \(varchar-length\) source values over a varchar/);
  assert.equal(long.plan.budgetsOk, true, 'a varchar-length warn never fails the plan');

  const fits = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source: [rows('ok', true)] });
  const pass = fits.plan.budgets.find((item) => item.id === 'varchar-length');
  assert.ok(pass);
  assert.equal(pass.status, 'pass');
});

test('an incomplete source warns even when every observed varchar value fits', () => {
  const app = loadApp(writeDs());
  const item = generateSchema(app).tables.find((table) => table.name === 'Item');
  assert.ok(item);
  const name = item.columns.find((column) => column.name === 'Name');
  assert.ok(name && name.dataType === 'VarChar');
  const cap = name.length ?? 255;
  const budgetOf = (source: { table: string; complete?: boolean; rows: { columns: Record<string, unknown> }[] }[]) =>
    buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source }).plan.budgets.find((item) => item.id === 'varchar-length');

  // A report/CSV source cannot prove it holds every record: observed fits
  // are a sample, not a measurement — warn, never pass.
  const partial = budgetOf([{ table: 'Item', rows: [{ columns: { Name: 'ok' } }] }]);
  assert.ok(partial);
  assert.equal(partial.status, 'warn');
  assert.match(partial.detail ?? '', /not fully measured/);

  // Observed offenders in a partial source still warn by name.
  const partialOver = budgetOf([{ table: 'Item', rows: [{ columns: { Name: 'x'.repeat(cap + 1) } }] }]);
  assert.ok(partialOver);
  assert.equal(partialOver.status, 'warn');
  assert.match(partialOver.detail ?? '', /Item\.Name/);
  assert.match(partialOver.detail ?? '', /not fully measured/);

  // Only a complete source can pass.
  const complete = budgetOf([{ table: 'Item', complete: true, rows: [{ columns: { Name: 'ok' } }] }]);
  assert.ok(complete);
  assert.equal(complete.status, 'pass');
});

test('every varchar-length pass and warning explains unverified character semantics', () => {
  const app = loadApp(writeDs());
  const item = generateSchema(app).tables.find((table) => table.name === 'Item');
  assert.ok(item);
  const name = item.columns.find((column) => column.name === 'Name');
  assert.ok(name && name.dataType === 'VarChar');
  const cap = name.length ?? 255;
  const budgetOf = (source?: { table: string; complete?: boolean; rows: { columns: Record<string, unknown> }[] }[]) =>
    buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source }).plan.budgets.find((item) => item.id === 'varchar-length');
  const cases = [
    budgetOf(),
    budgetOf([{ table: 'Item', complete: true, rows: [] }]),
    budgetOf([{ table: 'Item', complete: true, rows: [{ columns: { Name: 'ok' } }] }]),
    budgetOf([{ table: 'Item', rows: [{ columns: { Name: 'ok' } }] }]),
    budgetOf([{ table: 'Item', complete: true, rows: [{ columns: { Name: 'x'.repeat(cap + 1) } }] }]),
  ];
  for (const budget of cases) {
    assert.ok(budget);
    assert.ok(budget.status === 'pass' || budget.status === 'warn');
    assert.match(budget.detail, /JavaScript code points/);
    assert.match(budget.detail, /unverified/);
  }

  // cap emoji are cap code points but 2*cap UTF-16 code units: they fit.
  const emoji = budgetOf([{ table: 'Item', complete: true, rows: [{ columns: { Name: '😀'.repeat(cap) } }] }]);
  assert.ok(emoji);
  assert.equal(emoji.status, 'pass');

  // cap - 2 emoji plus "tail" and CRLF: cap + 4 code points.
  const over = budgetOf([{ table: 'Item', complete: true, rows: [{ columns: { Name: '😀'.repeat(cap - 2) + 'tail\r\n' } }] }]);
  assert.ok(over);
  assert.equal(over.status, 'warn');
  assert.match(over.detail ?? '', /Item\.Name/);
  assert.match(over.detail ?? '', /code points/);
  assert.match(over.detail ?? '', /unverified/);
});

test('unique-varchar budget warns app-level extras and the plan still exits 0', async () => {
  const ds = writeDs(DS_UNIQUE);

  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-budget-'));
  const io = offlineIo({});
  const code = await planCli([ds, '--out', out, '--dc', 'in'], io.io);
  assert.equal(code, 0);
  assert.equal(io.stderr().includes('budget failed'), false, 'no budget may fail on app-level uniques');

  const plan = readJson(join(out, 'plan.json')) as { budgetsOk: boolean; budgets: { id: string; status: string; table?: string; detail: string }[] };
  assert.equal(plan.budgetsOk, true);
  assert.equal(plan.budgets.some((budget) => budget.status === 'fail'), false);
  const budget = plan.budgets.find((item) => item.id === 'unique-varchar' && item.table === 'Contact');
  assert.ok(budget, 'expected a unique-varchar budget for Contact');
  assert.equal(budget.status, 'warn');
  assert.match(budget.detail, /unique varchar/i);
  assert.match(budget.detail, /Checked by the c2c handler instead/);
  assert.match(budget.detail, /not atomic/);
  assert.match(readFileSync(join(out, 'plan.md'), 'utf8'), /\[WARN\] \(unique-varchar\) Contact: .*unique varchar/i);
  rmSync(out, { recursive: true, force: true });
});

test('the plan warns when Dev per-table row counts are unknown or measured', () => {
  const app = loadApp(writeDs());
  const rows = (count: number) => ({ table: 'Item', rows: Array.from({ length: count }, () => ({ columns: {} })) });

  const noSource = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false });
  const unmeasured = noSource.plan.budgets.find((item) => item.id === 'dev-row-cap');
  assert.ok(unmeasured, 'a dev-row-cap budget is listed');
  assert.equal(unmeasured.status, 'warn');
  assert.match(unmeasured.detail ?? '', /source row counts/);
  assert.match(unmeasured.fix ?? '', /--source-/);

  const loaded = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source: [rows(450)] });
  const budget = loaded.plan.budgets.find((item) => item.id === 'dev-row-cap');
  assert.ok(budget);
  assert.equal(budget.status, 'warn');
  assert.match(budget.detail ?? '', /Item 450 rows/);
  assert.match(budget.detail ?? '', /3 insert batches/);
  assert.match(budget.detail ?? '', /API_LIMIT_REACHED/);
  assert.match(budget.fix ?? '', /rehearse/);

  const empty = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source: [rows(0)] });
  const emptyBudget = empty.plan.budgets.find((item) => item.id === 'dev-row-cap');
  assert.ok(emptyBudget);
  assert.equal(emptyBudget.status, 'warn');
  assert.match(emptyBudget.detail ?? '', /row counts are unknown for Item/);
  assert.doesNotMatch(emptyBudget.detail ?? '', /figures are higher/);

  const twoTableApp = loadApp(writeDs(DS.replace('\t\tlist Open_Items', '\t\tform Other\n\t\t{\n\t\t\tTitle (type = text)\n\t\t}\n\t\tlist Open_Items')));
  const partial = buildOfflinePlan(twoTableApp, {
    dc: 'in', dcSource: '--dc', mail: false,
    source: [rows(2)],
  });
  const partialBudget = partial.plan.budgets.find((item) => item.id === 'dev-row-cap');
  assert.ok(partialBudget);
  assert.equal(partialBudget.status, 'warn');
  assert.match(partialBudget.detail ?? '', /largest measured table\(s\): Item 2 rows/);
  assert.match(partialBudget.detail ?? '', /row counts are unknown for .*Other/);

  const complete = buildOfflinePlan(app, {
    dc: 'in', dcSource: '--dc', mail: false,
    source: [{ ...rows(0), complete: true }],
  });
  const completeBudget = complete.plan.budgets.find((item) => item.id === 'dev-row-cap');
  assert.ok(completeBudget);
  assert.equal(completeBudget.status, 'pass');
  assert.match(completeBudget.detail ?? '', /no source rows/);
});

test('dev-api-calls budget warns without source and estimates mover calls with source', () => {
  const app = loadApp(writeDs());
  const noSource = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false });
  const unknown = noSource.plan.budgets.find((budget) => budget.id === 'dev-api-calls');
  assert.ok(unknown, 'a dev-api-calls budget is listed');
  assert.equal(unknown.status, 'warn');
  assert.match(unknown.detail, /needs source row counts/);
  assert.match(unknown.detail, /api\.calls_dev/);
  assert.equal(noSource.plan.budgetsOk, true);

  const schema = generateSchema(app);
  const measured = schema.tables.filter((table) => !table.nosql && table.role !== 'system');
  assert.ok(measured.length > 0);
  // 450 rows per table -> 3 batches of 200 plus 2 slices of 300 ids:
  // 3 reconcile/insert/write-recount calls per batch and 3
  // verification/remap/count reads per slice, plus a 2-call conservative
  // allowance per non-empty table -> 17 mover calls per table.
  const source: SourceTableData[] = measured.map((table) => ({
    table: table.name,
    rows: Array.from({ length: 450 }, () => ({ columns: {} })),
  }));
  const withSource = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source });
  const budget = withSource.plan.budgets.find((item) => item.id === 'dev-api-calls');
  assert.ok(budget);
  assert.equal(budget.status, 'pass');
  assert.match(budget.detail, new RegExp(`about ${17 * measured.length} API calls`));
  assert.match(budget.detail, /per 200-row batch: reconcile read plus insert plus write-recount/);
  assert.match(budget.detail, /per 300 ids: verification plus remap plus count reads/);
  assert.match(budget.detail, /2 conservative fixed-call allowance per non-empty table/);
  assert.match(withSource.files.find((file) => file.path === 'plan.md')?.data ?? '', /API calls/);
});

test('dev-api-calls budget counts verification, remap and count reads per 300 ids', () => {
  const app = loadApp(writeDs());
  const callsFor = (count: number): number => {
    const source: SourceTableData[] = [{ table: 'Item', rows: Array.from({ length: count }, () => ({ columns: {} })) }];
    const plan = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source });
    const budget = plan.plan.budgets.find((item) => item.id === 'dev-api-calls');
    assert.ok(budget);
    const match = (budget.detail ?? '').match(/about (\d+) API calls/);
    assert.ok(match, `no call estimate in: ${budget.detail}`);
    return Number(match[1]);
  };
  // One table: 300 rows -> 2 batches + 1 id slice + 2 fixed = 11;
  // 301 rows opens a second id slice for the verification, remap and count reads -> 14.
  assert.equal(callsFor(300), 11);
  assert.equal(callsFor(301), 14);
});

test('dev-api-calls budget counts zero calls for a measured empty table', () => {
  const app = loadApp(writeDs());
  const source: SourceTableData[] = [{ table: 'Item', rows: [] }];
  const plan = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source });
  const budget = plan.plan.budgets.find((item) => item.id === 'dev-api-calls');
  assert.ok(budget);
  assert.equal(budget.status, 'pass');
  assert.match(budget.detail ?? '', /about 0 API calls/);
});

test('dev-api-calls budget counts a deferred-update write per batch for self-lookup tables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-plan-ds-self-'));
  const path = join(dir, 'app.ds');
  writeFileSync(
    path,
    'application "Widget"\n{\n\tform Node\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t\tParent\n\t\t(\n\t\t\ttype = picklist\n\t\t\tvalues = Node.Name\n\t\t)\n\t}\n}\n',
  );
  const app = loadApp(path);
  const source: SourceTableData[] = [{ table: 'Node', rows: Array.from({ length: 450 }, () => ({ columns: {} })) }];
  const plan = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source });
  const budget = plan.plan.budgets.find((item) => item.id === 'dev-api-calls');
  assert.ok(budget);
  // 17 base calls for 450 rows plus one deferred-update write per 200-row batch -> 20.
  assert.match(budget.detail ?? '', /about 20 API calls/);
  assert.match(budget.detail ?? '', /deferred-lookup updates on Node/);
  rmSync(dir, { recursive: true, force: true });
});

test('dev-api-calls budget warns on unmeasured tables and at the Development allowance', () => {
  const twoFormDs = DS.replace(
    '\t\tlist Open_Items',
    '\t\tform Other\n\t\t{\n\t\t\tTitle\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t}\n\t\tlist Open_Items',
  );
  const app = loadApp(writeDs(twoFormDs));
  const schema = generateSchema(app);
  const storeTables = schema.tables.filter((table) => !table.nosql && table.role !== 'system');
  const partial: SourceTableData[] = storeTables.slice(1).map((table) => ({ table: table.name, rows: [{ columns: {} }] }));
  const partialPlan = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source: partial });
  const missing = partialPlan.plan.budgets.find((budget) => budget.id === 'dev-api-calls');
  assert.ok(missing);
  assert.equal(missing.status, 'warn');
  assert.match(missing.detail, /row counts are unknown for/);

  // A source-shaped row count at the cap without materialising 20M rows:
  // the budget reads only rows.length. The plan never iterates these rows
  // because no source column is store-mandatory or store-unique. Each table
  // counts far more than the old 2-calls-per-batch floor, so the old cap
  // row count still lands well over the allowance.
  const capCalls = limitValue('api.calls_dev');
  const rowsPerTable = (capCalls / 2) * 200;
  const over: SourceTableData[] = storeTables.map((table) => ({
    table: table.name,
    rows: { length: rowsPerTable } as unknown as SourceTableData['rows'],
  }));
  const overPlan = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source: over });
  const overBudget = overPlan.plan.budgets.find((budget) => budget.id === 'dev-api-calls');
  assert.ok(overBudget);
  assert.equal(overBudget.status, 'warn');
  assert.match(overBudget.detail, /at or over the Development allowance/);

  // An over-limit measured table must retain the missing-table explanation;
  // otherwise dev-write-rate's cross-reference has no corresponding detail.
  const overPartial: SourceTableData[] = [{
    table: storeTables[0].name,
    rows: { length: rowsPerTable } as unknown as SourceTableData['rows'],
  }];
  const overPartialPlan = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, source: overPartial });
  const overPartialBudget = overPartialPlan.plan.budgets.find((budget) => budget.id === 'dev-api-calls');
  assert.ok(overPartialBudget);
  assert.equal(overPartialBudget.status, 'warn');
  assert.match(overPartialBudget.detail, /at or over the Development allowance/);
  assert.match(overPartialBudget.detail, new RegExp(`row counts are unknown for ${storeTables.slice(1).map((table) => table.name).join(', ')}`));
  const overPartialWriteRate = overPartialPlan.plan.budgets.find((budget) => budget.id === 'dev-write-rate');
  assert.ok(overPartialWriteRate);
  assert.match(overPartialWriteRate.detail ?? '', /counted in the dev-api-calls warning/);
});

test('plan records the required MCP tool set and the probe list', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-tools-'));
  assert.equal(await planCli([ds, '--out', out, '--dc', 'in'], offlineIo({}).io), 0);
  const plan = readJson(join(out, 'plan.json')) as { mcpTools: { base: string[]; plan: string[] }; probes: { id: string; needed: boolean }[] };
  assert.ok(plan.mcpTools.base.includes('CatalystbyZoho_List_All_Tables'));
  assert.ok(plan.mcpTools.base.includes('CatalystbyZoho_Get_Authentication_Configurations'));
  // A feature-free app demands no extra tools: the CLI table fallback
  // (Create_Table/Create_Column) is never seeded into the plan.
  assert.deepEqual(plan.mcpTools.plan, []);
  for (const probe of ['P-LIKE', 'P-OFFSET', 'P-UPD300', 'P-JOIN', 'P-WIDTH', 'P-COLS', 'P-401']) {
    assert.ok(plan.probes.some((entry) => entry.id === probe), `missing probe ${probe}`);
  }
  rmSync(out, { recursive: true, force: true });
});

test('every MCP tool a plan step names is in the one required-tool list and in that plan\'s mcpTools', () => {
  // A new step tool must be added to doctor/data/required-mcp-tools.json, or D-B5 never asks for it.
  const known = new Set(ALL_REQUIRED_MCP_TOOLS.map((name) => `CatalystbyZoho_${name}`));
  for (const tool of PLAN_STEP_TOOLS) assert.ok(known.has(tool), `${tool} is a plan step tool but not in required-mcp-tools.json`);
  const sources: string[] = [
    DS,
    readFileSync(join(repoRoot(), 'fixtures/redistributable/freight-forwarding/Creator_app_source_code.ds'), 'utf8'),
    readFileSync(join(repoRoot(), 'fixtures/redistributable/library-application-system/library_application.ds'), 'utf8'),
  ];
  for (const text of sources) {
    const app = deriveIr(parse(text));
    for (const mail of [false, true]) {
      for (const newProject of [false, true]) {
        const { plan } = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail, newProject });
        const declared = new Set([...plan.mcpTools.base, ...plan.mcpTools.plan]);
        for (const step of plan.steps) {
          for (const tool of [step.via === 'mcp' ? step.tool : undefined, step.readBack.via === 'mcp' ? step.readBack.tool : undefined]) {
            if (tool) assert.ok(declared.has(tool), `${app.name} mail=${mail} new=${newProject}: step ${step.id} uses ${tool}, missing from plan.mcpTools`);
          }
        }
        for (const tool of declared) assert.ok(known.has(tool), `${tool} in plan.mcpTools but not in required-mcp-tools.json`);
        assert.equal(plan.mcpTools.plan.includes('CatalystbyZoho_Create_Email_Configuration'), plan.steps.some((step) => step.id === 'mail-sender'));
        // The MCP project tools return project secrets into the transcript:
        // a plan never names them anywhere — steps, read-backs or mcpTools.
        assert.doesNotMatch(JSON.stringify(plan), /List_All_Projects|Get_Project_By_Id/, `${app.name} mail=${mail} new=${newProject}: the plan names an MCP project tool`);
      }
    }
  }
});

test('every required byFeature tool has a call site in a provision step or a shipped skill', () => {
  // D-B5 demands each byFeature tool when its signal fires; a listed tool that
  // nothing calls can never be exercised — it must be dropped, never FAIL a
  // customer. Call sites: PLAN_STEP_TOOLS (plan/provision steps) and the shipped
  // plugin skills that instruct the agent.
  const skillsDir = join(repoRoot(), 'plugin', 'skills');
  const corpus = (readdirSync(skillsDir, { recursive: true }) as string[])
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => readFileSync(join(skillsDir, entry), 'utf8'))
    .join('\n');
  const stepTools = new Set<string>(PLAN_STEP_TOOLS);
  for (const [group, names] of Object.entries(REQUIRED_MCP_TOOLS.byFeature)) {
    assert.ok(names.length > 0, `byFeature.${group} is empty — drop the group`);
    for (const name of names) {
      assert.ok(
        stepTools.has(`CatalystbyZoho_${name}`) || corpus.includes(name),
        `${name} (byFeature.${group}) has no call site in a plan step or plugin/skills — drop it`,
      );
    }
  }
});

test('plan needs --out and a data centre', async () => {
  const ds = writeDs();
  const missing = await planCli([ds, '--dc', 'in'], offlineIo({}).io);
  assert.equal(missing, 2);
  const noDc = await planCli([ds, '--out', mkdtempSync(join(tmpdir(), 'c2c-plan-nodc-'))], offlineIo({}).io);
  assert.equal(noDc, 2);
});

test('c2c-deploy.json supplies the DC and plan.md says so', async () => {
  const ds = writeDs();
  const cwd = mkdtempSync(join(tmpdir(), 'c2c-plan-cwd-'));
  writeFileSync(join(cwd, 'c2c-deploy.json'), JSON.stringify({ dc: 'eu', org: '1', apps: {} }));
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-eu-'));
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    assert.equal(await planCli([ds, '--out', out], offlineIo({}).io), 0);
  } finally {
    process.chdir(previous);
  }
  assert.match(readFileSync(join(out, 'plan.md'), 'utf8'), /dc: eu \(from c2c-deploy\.json\)/);
  assert.equal((readJson(join(out, 'plan.json')) as { dc: string }).dc, 'eu');
  rmSync(cwd, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test('the c2c bin plans L1 and BOM with no credential path: exit 0, identical twice', { skip: skipFixtures }, async () => {
  for (const ds of [l1Ds, bomDs]) {
    const first = mkdtempSync(join(tmpdir(), 'c2c-plan-bin-a-'));
    const second = mkdtempSync(join(tmpdir(), 'c2c-plan-bin-b-'));
    const env = { ...process.env, DC: undefined } as NodeJS.ProcessEnv;
    delete env.X_ZC_CREDENTIAL_PATH;
    for (const out of [first, second]) {
      const result = await execFileAsync(process.execPath, [join('dist/cli/src/c2c.js'), 'plan', ds, '--out', out, '--dc', 'in'], {
        cwd: process.cwd(),
        env,
      }).then(
        (ok) => ({ code: 0, stderr: ok.stderr }),
        (err: { code?: number; stderr?: string }) => ({ code: err.code ?? 1, stderr: err.stderr ?? '' }),
      );
      assert.equal(result.code, 0, `plan ${ds}: ${result.stderr}`);
    }
    assert.deepEqual(hashTree(first), hashTree(second), `plan ${ds} is not deterministic`);
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});


test('fleet-hub plan exits 0 and warns the app-level unique; a passing app still exits 0', { skip: skipFleetHub }, async () => {
  const outFail = mkdtempSync(join(tmpdir(), 'c2c-plan-fleet-'));
  const failIo = offlineIo({});
  const codeFail = await planCli([fleetHubDs, '--out', outFail, '--dc', 'in'], failIo.io);
  assert.equal(codeFail, 0);
  assert.equal(failIo.stderr().includes('budget failed'), false, 'no budget may fail on app-level uniques');
  const plan = readJson(join(outFail, 'plan.json')) as { budgetsOk: boolean; budgets: { id: string; status: string; table?: string; detail: string }[] };
  assert.equal(plan.budgetsOk, true);
  const budget = plan.budgets.find((item) => item.id === 'unique-varchar' && item.table === 'Add_Vehicle');
  assert.ok(budget, 'expected a unique-varchar budget for Add_Vehicle');
  assert.equal(budget.status, 'warn');
  assert.match(budget.detail, /Checked by the c2c handler instead/);
  
  const outPass = mkdtempSync(join(tmpdir(), 'c2c-plan-bom-pass-'));
  const passIo = offlineIo({});
  const codePass = await planCli([bomDs, '--out', outPass, '--dc', 'in'], passIo.io);
  assert.equal(codePass, 0);
});

test('L1 and BOM budgets pass; Add_User sits on the unique-varchar cap', { skip: skipFixtures }, () => {
  const l1 = buildOfflinePlan(loadApp(l1Ds), { dc: 'in', dcSource: '--dc', mail: false });
  assert.equal(l1.plan.budgetsOk, true);
  const bomApp = loadApp(bomDs);
  const bom = buildOfflinePlan(bomApp, { dc: 'in', dcSource: '--dc', mail: false });
  assert.equal(bom.plan.budgetsOk, true);
  const add = bom.plan.budgets.find((budget) => budget.id === 'unique-varchar' && budget.table === 'Add_User');
  assert.ok(add);
  assert.equal(add.status, 'pass');
  assert.match(add.detail, /2\/2 unique varchar/);
  const columns = generateSchema(bomApp).tables.find((table) => table.name === 'Add_User')?.columns ?? [];
  const unique = columns.filter((column) => column.unique && column.dataType === 'VarChar').map((column) => column.name);
  assert.deepEqual(unique, ['Mail_ID', 'Phone']);
  // c2c_source_id is nullable and not store-unique, so it does not consume the budget.
  const source = columns.find((column) => column.name === SOURCE_ID_COLUMN);
  assert.ok(source);
  assert.equal(source.unique, false);
  assert.equal(source.appUnique, undefined);
  assert.ok(parseFile(l1Ds).ir.forms.length > 0 && parseFile(bomDs).ir.forms.length > 0);
});

// --- new-project IaC import plan ------------------------------------------------

const DS_ROLE = `application "Widget"
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
\t\tlist L
\t\t{
\t\t\tshow all rows from Item
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tL = {"View","Edit"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

test('a plan with no configured project provisions by one IaC import', async () => {
  const ds = writeDs(DS_ROLE);
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-import-'));
  assert.equal(await planCli([ds, '--out', out, '--dc', 'in'], offlineIo({}).io), 0);
  const steps = (readJson(join(out, 'provision/plan.json')) as { steps: ProvisionStep[] }).steps;
  const ids = steps.map((step) => step.id);
  // The import replaces the console project step; what the import writes is
  // verified, not re-done by hand.
  assert.ok(ids.includes('import'), 'no import step');
  for (const gone of ['project', 'custom-roles', 'table-permissions-console', 'table-scopes-console', 'security-rule']) {
    assert.equal(ids.includes(gone), false, `${gone} should not be in a new-project plan`);
  }
  assert.ok(ids.includes('import-roles'), 'imported custom roles need a verify step');
  assert.ok(ids.includes('import-table-permissions'), 'imported grants need a verify step');
  assert.ok(ids.includes('import-table-scopes'), 'imported scopes need a verify step');
  assert.ok(ids.includes('import-security-rule'), 'the imported security rule needs a verify step');
  const imp = steps.find((step) => step.id === 'import')!;
  assert.equal(imp.via, 'cli');
  assert.equal(imp.args.dir, 'provision/iac');
  assert.equal(imp.readBack.via, 'cli');
  assert.equal(imp.readBack.tool, undefined);
  assert.equal(imp.readBack.command, 'c2c provision --record import');
  // The template and the function code tree are emitted under provision/iac.
  const template = readJson(join(out, 'provision/iac/project-template-1.0.0.json')) as { components: Record<string, { type: string; name: string }[]> };
  assert.ok(template.components.Authentication.length > 0, 'template has no Authentication component');
  assert.ok(template.components.SecurityRules.length > 0, 'template has no SecurityRules component');
  assert.ok(template.components.Datastore.some((i) => i.type === 'tableScope' && i.name === 'Item-Staff'));
  const fnZip = statSync(join(out, 'provision/iac/functions/c2c_api.zip'), { throwIfNoEntry: false });
  assert.ok(fnZip?.isFile() && fnZip.size > 1000, 'no function code zip under provision/iac');
  rmSync(out, { recursive: true, force: true });
});

test('the import verify steps expect the full grant set: every role on every table', async () => {
  const ds = writeDs(DS_ROLE);
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-grants-'));
  assert.equal(await planCli([ds, '--out', out, '--dc', 'in'], offlineIo({}).io), 0);
  const steps = (readJson(join(out, 'provision/plan.json')) as { steps: ProvisionStep[] }).steps;
  const perms = steps.find((step) => step.id === 'import-table-permissions')!;
  const scopes = steps.find((step) => step.id === 'import-table-scopes')!;
  const permMatch = perms.readBack.match as Record<string, Record<string, string[]>>;
  const scopeMatch = scopes.readBack.match as Record<string, Record<string, string[]>>;
  // The import writes a row for every role the template defines — the built-ins
  // included — so a grant the import dropped fails the verify, not silently absent.
  assert.deepEqual(Object.keys(permMatch), ['<id:Item>']);
  assert.deepEqual(Object.keys(permMatch['<id:Item>']!).sort(), ['App Administrator', 'App User', 'Staff']);
  assert.deepEqual(permMatch['<id:Item>']!['App Administrator'], ['SELECT', 'UPDATE', 'INSERT', 'DELETE']);
  assert.deepEqual(permMatch['<id:Item>']!['App User'], ['SELECT']);
  assert.deepEqual(permMatch['<id:Item>']!['Staff'], ['SELECT', 'UPDATE']);
  assert.deepEqual(Object.keys(scopeMatch), ['<id:Item>']);
  assert.deepEqual(Object.keys(scopeMatch['<id:Item>']!).sort(), ['App Administrator', 'App User', 'Staff']);
  assert.deepEqual(scopeMatch['<id:Item>']!['App User'], ['GLOBAL']);
  assert.deepEqual(scopeMatch['<id:Item>']!['Staff'], ['ORG']);
  rmSync(out, { recursive: true, force: true });
});

test('a configured project keeps the per-step plan (no import step)', async () => {
  const ds = writeDs(DS_ROLE);
  const cwd = mkdtempSync(join(tmpdir(), 'c2c-plan-existing-'));
  writeFileSync(join(cwd, 'c2c-deploy.json'), JSON.stringify({ dc: 'in', apps: { Widget: { project: '10000000000013200' } } }));
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-existing-out-'));
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    assert.equal(await planCli([ds, '--out', out], offlineIo({}).io), 0);
  } finally {
    process.chdir(previous);
  }
  const steps = (readJson(join(out, 'provision/plan.json')) as { steps: ProvisionStep[] }).steps;
  const ids = steps.map((step) => step.id);
  assert.ok(ids.includes('project'), 'existing project keeps the project step');
  assert.equal(ids.includes('import'), false, 'an existing project never imports');
  assert.ok(ids.includes('custom-roles'));
  assert.equal(statSync(join(out, 'provision/iac'), { throwIfNoEntry: false }), undefined, 'no import tree for an existing project');
  rmSync(cwd, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test('--production adds a console promote step with an /environment read-back', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-prod-'));
  assert.equal(await planCli([ds, '--out', out, '--dc', 'in', '--production'], offlineIo({}).io), 0);
  const steps = (readJson(join(out, 'provision/plan.json')) as { steps: ProvisionStep[] }).steps;
  const prod = steps.find((step) => step.id === 'production');
  assert.ok(prod, 'no production step');
  assert.equal(prod.via, 'console');
  assert.match(prod.command ?? '', /Development.*Production|Production/);
  assert.equal(prod.readBack.via, 'cli');
  assert.equal((prod.readBack.args as { call: { method: string; path: string } }).call.method, 'GET');
  assert.match((prod.readBack.args as { call: { method: string; path: string } }).call.path, /\/environment$/);
  // Without the flag there is no promote step.
  const out2 = mkdtempSync(join(tmpdir(), 'c2c-plan-noprod-'));
  assert.equal(await planCli([ds, '--out', out2, '--dc', 'in'], offlineIo({}).io), 0);
  assert.equal((readJson(join(out2, 'provision/plan.json')) as { steps: ProvisionStep[] }).steps.some((step) => step.id === 'production'), false);
  rmSync(out, { recursive: true, force: true });
  rmSync(out2, { recursive: true, force: true });
});

test('the Slate first-open step is one guided console line that c2c then verifies', async () => {
  const ds = writeDs(DS_WITH_PAGE);
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-slate2-'));
  assert.equal(await planCli([ds, '--out', out, '--dc', 'in'], offlineIo({}).io), 0);
  const steps = (readJson(join(out, 'provision/plan.json')) as { steps: ProvisionStep[] }).steps;
  const slate = steps.find((step) => step.id === 'slate-enable')!;
  assert.match(slate.command ?? '', /Catalyst console → the project → Slate → Start Exploring/);
  assert.match(slate.command ?? '', /c2c provision --record slate-enable/);
  // No console-session call is asked of anyone: the user opens the page, c2c reads.
  assert.doesNotMatch(slate.command ?? '', /PATCH/);
  assert.equal(slate.command?.includes('\n'), false);
  rmSync(out, { recursive: true, force: true });
});

test('IaC import zip mail config respects the mail boolean (not forced on by sendmail)', () => {
  const ds = `application "MailApp" {
    workflow {
      schedule {
        Daily as "Daily" {
          type = schedule
          start = "2020-01-01 10:00:00"
          frequency = daily
          on start {
            actions {
              on load ( sendmail [ from: zoho.adminuserid to: "test@example.com" subject: "hi" message: "hi" ] )
            }
          }
        }
      }
    }
  }`;
  
  const dir = mkdtempSync(join(tmpdir(), 'c2c-plan-mail-'));
  const dsPath = join(dir, 'test-mail.ds');
  writeFileSync(dsPath, ds);
  const app = loadApp(dsPath);
  const withoutMail = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, newProject: true });
  
  const fnZip = withoutMail.files.find((f) => f.path === 'provision/iac/functions/c2c_api.zip');
  assert.ok(fnZip);
  const withoutMailZip = openZip(fnZip.bytes ?? Buffer.alloc(0));
  const mailJsonOff = JSON.parse(withoutMailZip.read('c2c-mail.json').toString('utf8'));
  assert.equal(mailJsonOff.enabled, false);

  const withMail = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: true, newProject: true });
  const fnZip2 = withMail.files.find((f) => f.path === 'provision/iac/functions/c2c_api.zip');
  const withMailZip = openZip(fnZip2!.bytes ?? Buffer.alloc(0));
  const mailJsonOn = JSON.parse(withMailZip.read('c2c-mail.json').toString('utf8'));
  assert.equal(mailJsonOn.enabled, true);
  rmSync(dir, { recursive: true, force: true });
});

const SENDS_MAIL = `application "MailApp" {
  workflow {
    schedule {
      Daily as "Daily" {
        type = schedule
        start = "2020-01-01 10:00:00"
        frequency = daily
        on start {
          actions {
            on load ( sendmail [ from: zoho.adminuserid to: "test@example.com" subject: "hi" message: "hi" ] )
          }
        }
      }
    }
  }
}`;

function planMailLines(md: string): { summary: string; probe: string } {
  const summary = md.split('\n').find((line) => line.startsWith('mail: '));
  const probe = md.split('\n').find((line) => line.startsWith('- P-MAIL '));
  assert.ok(summary, md);
  assert.ok(probe, md);
  return { summary, probe };
}

function zipMailEnabled(files: { path: string; bytes?: Buffer }[]): boolean | undefined {
  const zipFile = files.find((file) => file.path === 'provision/iac/functions/c2c_api.zip');
  assert.ok(zipFile?.bytes, 'a new project plan packs the function zip');
  const zip = openZip(zipFile.bytes);
  if (!zip.has('c2c-mail.json')) return undefined;
  return (JSON.parse(zip.read('c2c-mail.json').toString('utf8')) as { enabled: boolean }).enabled;
}

test('plan.md and P-MAIL agree whether the app sends mail, and the zip mail config follows --mail', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-plan-mail-agree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases = [
    { file: join(dir, 'sends.ds'), source: SENDS_MAIL, sends: true },
    { file: join(dir, 'quiet.ds'), source: DS, sends: false },
  ];
  for (const item of cases) writeFileSync(item.file, item.source);
  for (const mail of [false, true]) {
    for (const item of cases) {
      const built = buildOfflinePlan(loadApp(item.file), { dc: 'in', dcSource: '--dc', mail, newProject: true });
      const md = built.files.find((file) => file.path === 'plan.md')?.data ?? '';
      const { summary, probe } = planMailLines(md);
      const enabled = zipMailEnabled(built.files);
      if (item.sends || mail) {
        assert.equal(probe.includes('[needed]'), true, probe);
        assert.equal(probe.endsWith('the app sends mail'), true, probe);
        assert.equal(summary, mail ? 'mail: sender step planned (--mail)' : 'mail: the app sends mail, so a sender step is planned');
      } else {
        assert.equal(summary, 'mail: none');
        assert.equal(probe.includes('[skip]'), true, probe);
        assert.equal(probe.endsWith('the app sends no mail'), true, probe);
      }
      // The zip enables delivery only when --mail is set and a handler sends mail.
      assert.equal(enabled, item.sends ? mail : undefined);
    }
  }
});

test('a plan with no data centre prints the plan prefix once', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'c2c-plan-prefix-'));
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-prefix-out-'));
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
  writeFileSync(join(cwd, 'app.ds'), DS);
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const trap = offlineIo({});
    const code = await planCli([join(cwd, 'app.ds'), '--out', out], trap.io);
    assert.equal(code, 2);
    assert.equal(trap.stderr(), 'c2c plan: no data centre set (pass --dc <dc> or add "dc" to c2c-deploy.json)\n');
  } finally {
    process.chdir(previous);
  }
});
