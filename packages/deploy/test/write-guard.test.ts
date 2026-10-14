/**
 * Every confirmed write must prove the project belongs to the resolved org
 * before the first row, table, function, cron, auth, or Slate call.
 * These cases cover the regressions where migrate and backfill skipped the
 * project details read, a projects.json map was accepted under a different
 * --org, a never_touch name was refused only when its id matched, and a dry-run
 * name lookup was silent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MigrateResponse } from '../../data/src/migrate.js';
import { deployCli, seedMigrateCli, sourceCsvCli, type Io } from '../src/cli.js';

const SECRET = '/tmp/cred-DO-NOT-PRINT';
const ORG_A = '4242424242';
const ORG_B = '1111111111';
const PROJECT_P = '555';
const PROJECT_Q = '9999';

const DS = `application "Widget"
{
form Item
{
Name
(
type = text
)
}
}
`;

const DECIMAL_DS = `application "Widget"
{
form Item
{
Rate
(
type = decimal
decimalplace = 2
)
}
}
`;

/** Write calls a confirmed run can make. Each must sit after assertLiveProject in cli.ts. */
const WRITE_ENTRY_POINTS = [
  { kind: 'rows', owner: 'seedMigrateCli', call: 'migrateSeed(' },
  { kind: 'rows', owner: 'sourceCsvCli', call: 'migrateCsv(' },
  { kind: 'rows', owner: 'backfillCli', call: 'backfillShadows(' },
  { kind: 'rows', owner: 'smokeCli', call: 'executeSmoke(' },
  { kind: 'tables', owner: 'deployCli', call: 'applyTablePlan(' },
  { kind: 'functions', owner: 'deployCli', call: 'for (const command of bundle.commands)' },
  { kind: 'crons', owner: 'deployCli', call: 'for (const command of bundle.commands)' },
  { kind: 'auth', owner: 'deployCli', call: 'for (const command of bundle.commands)' },
  { kind: 'slate', owner: 'deployCli', call: 'for (const command of bundle.commands)' },
] as const;

function cliSourcePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '../src/cli.ts'), join(here, '../../../packages/deploy/src/cli.ts')];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('packages/deploy/src/cli.ts not found from the test');
  return found;
}

function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`(?:export )?async function ${name}\\b`));
  assert.ok(start >= 0, `missing function ${name}`);
  const rest = source.slice(start + name.length);
  const next = rest.search(/\n(?:export )?async function |\nfunction /);
  return next < 0 ? source.slice(start) : source.slice(start, start + name.length + next);
}

function projectDetails(projectId: string, org: string) {
  return {
    status: 'success',
    data: {
      id: projectId,
      project_name: 'widget',
      env_details: [{ env_name: 'Development', env_zgid: org, id: org, project_details: { id: projectId, project_name: 'widget' } }],
    },
  };
}

function response(body: unknown, status = 200): MigrateResponse {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

function capture(opts: { list?: { name: string; id: string }[]; detailsOrg?: string; detailsId?: string } = {}): {
  io: Io;
  stdout: () => string;
  stderr: () => string;
  fetched: { method: string; url: string }[];
  restCalls: { method: string; path: string }[];
  spawned: string[];
} {
  let out = '';
  let err = '';
  const fetched: { method: string; url: string }[] = [];
  const restCalls: { method: string; path: string }[] = [];
  const spawned: string[] = [];
  const stored = new Map<string, Record<string, unknown>>();
  const detailsOrg = opts.detailsOrg ?? ORG_A;
  const detailsId = opts.detailsId ?? PROJECT_P;
  const io = {
    stdout: (text: string) => {
      out += text;
    },
    stderr: (text: string) => {
      err += text;
    },
    env: { X_ZC_CREDENTIAL_PATH: SECRET },
    cliDc: () => 'eu',
    listProjects: async () => opts.list ?? [],
    spawn: async (_command: string, args: string[]) => {
      spawned.push(args.join(' '));
      if (args.includes('project:list')) {
        return {
          code: 0,
          stdout: `│ Project Name │ Project ID │\n│ widget (active) │ ${PROJECT_P} │`,
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      fetched.push({ method, url });
      if (new URL(url).pathname.endsWith('/query')) {
        const sql = (JSON.parse(init?.body ?? '{}') as { query?: string }).query ?? '';
        if (/COUNT\(/i.test(sql)) return response({ data: [{ 'COUNT(ROWID)': String(stored.size) }] });
        return response({ data: [...stored].map(([id, columns]) => ({ ...columns, c2c_source_id: id, ROWID: `r${id}` })) });
      }
      const body = JSON.parse(init?.body ?? '{}') as { rows?: { id: string; columns?: Record<string, unknown> }[] };
      for (const row of body.rows ?? []) {
        const id = String(row.columns?.c2c_source_id ?? row.id);
        stored.set(id, { ...row.columns, c2c_source_id: id });
      }
      return response({ data: [], ids: (body.rows ?? []).map((row) => row.id) });
    },
    rest: async (call: { method: string; path: string; body?: unknown }) => {
      restCalls.push({ method: call.method, path: call.path });
      if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+$/.test(call.path)) {
        return { status: 200, body: projectDetails(detailsId, detailsOrg) };
      }
      if (call.method === 'GET' && call.path.endsWith('/table')) return { status: 200, body: { data: [] } };
      if (call.method === 'POST' && call.path.endsWith('/table')) return { status: 200, body: { data: { table_id: 't1' } } };
      if (call.method === 'POST' && call.path.includes('/column')) return { status: 200, body: { status: 'success' } };
      return { status: 404, body: {} };
    },
    accessToken: async () => 'test-cli-token',
    sleep: async () => {},
  } as Io;
  return { io, stdout: () => out, stderr: () => err, fetched, restCalls, spawned };
}

/** Catalyst calls that create or change rows, tables, or columns. A project-details GET is not one. */
function writes(cap: { fetched: { method: string }[]; restCalls: { method: string; path: string }[] }): number {
  const fetched = cap.fetched.filter((call) => call.method !== 'GET').length;
  const rest = cap.restCalls.filter((call) => call.method !== 'GET' || !/^\/baas\/v1\/project\/[0-9]+$/.test(call.path)).length;
  return fetched + rest;
}

function workspace(source = DS): { dir: string; ds: string } {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-guard-'));
  const ds = join(dir, 'widget.ds');
  writeFileSync(ds, source);
  return { dir, ds };
}

function projectsFile(dir: string, org: string, projects: Record<string, string>, extra: Record<string, unknown> = {}): string {
  const path = join(dir, 'projects.json');
  writeFileSync(path, JSON.stringify({ org, dc: 'eu', env: 'Development', projects, ...extra }));
  return path;
}

test('write entry points call the shared project-details guard before they write', () => {
  const sourcePath = cliSourcePath();
  const source = readFileSync(sourcePath, 'utf8');
  const kinds = new Set<string>();
  for (const entry of WRITE_ENTRY_POINTS) {
    kinds.add(entry.kind);
    const body = functionBody(source, entry.owner);
    const guardAt = body.indexOf('assertLiveProject(');
    const callAt = body.indexOf(entry.call);
    assert.ok(callAt >= 0, `${entry.owner} does not contain ${entry.call}`);
    assert.ok(guardAt >= 0 && guardAt < callAt, `${entry.kind} via ${entry.owner} ${entry.call} is not behind assertLiveProject`);
  }
  assert.deepEqual([...kinds].sort(), ['auth', 'crons', 'functions', 'rows', 'slate', 'tables']);
  const srcDir = dirname(sourcePath);
  const allowedElsewhere: Record<string, string[]> = { 'migrateSeed(': ['csv.ts'], 'applyTablePlan(': ['provision.ts'] };
  const runBody = functionBody(readFileSync(join(srcDir, 'provision.ts'), 'utf8'), 'runStep');
  const provisionGuard = runBody.indexOf('assertLiveProject(');
  const provisionWrite = runBody.indexOf('executeCliStep(');
  assert.ok(provisionGuard >= 0 && provisionWrite > provisionGuard, 'provision run calls assertLiveProject before the step that writes');
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith('.ts') || file === 'cli.ts') continue;
    const text = readFileSync(join(srcDir, file), 'utf8');
    for (const entry of WRITE_ENTRY_POINTS) {
      const re = new RegExp(`(?<!function )${entry.call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
      if (!re.test(text)) continue;
      assert.ok(allowedElsewhere[entry.call]?.includes(file), `${file} calls ${entry.call} outside the guarded CLI entry`);
    }
  }
});

test('an ambiguous project name is refused and nothing is written', async () => {
  const { dir, ds } = workspace();
  writeFileSync(join(dir, 'c2c-deploy.json'), JSON.stringify({ org: ORG_A, project: 'acme', dc: 'eu' }));
  const cap = capture({ list: [{ name: 'acme', id: '1' }, { name: 'ACME', id: '2' }] });
  const code = await deployCli([ds, '--confirm'], cap.io);
  assert.equal(code, 2);
  assert.match(cap.stderr(), /matches more than one/);
  assert.equal(writes(cap), 0);
  assert.equal(cap.spawned.length, 0);
});

test('a plan prints a project name as given; confirm looks it up before any write', async () => {
  const { ds } = workspace();
  const cap = capture({ list: [{ name: 'acme-app', id: PROJECT_P }] });
  const code = await deployCli([ds, '--project', 'acme-app', '--org', ORG_A, '--dc', 'eu'], cap.io);
  assert.equal(code, 0, cap.stderr());
  assert.match(cap.stdout(), /project_id: acme-app/);
  assert.equal(cap.stdout().includes('name lookup:'), false);
  assert.equal(writes(cap), 0);
  assert.equal(cap.restCalls.length, 0);
  const byId = capture();
  assert.equal(await deployCli([ds, '--project', PROJECT_P, '--org', ORG_A, '--dc', 'eu'], byId.io), 0, byId.stderr());
  assert.equal(byId.stdout().includes('name lookup:'), false);
  const confirmed = capture({ list: [{ name: 'acme-app', id: PROJECT_P }] });
  let lookups = 0;
  confirmed.io.listProjects = async () => {
    lookups += 1;
    return [{ name: 'acme-app', id: PROJECT_P }];
  };
  const confirmedCode = await deployCli([ds, '--project', 'acme-app', '--org', ORG_A, '--dc', 'eu', '--confirm'], confirmed.io);
  assert.equal(confirmedCode, 1, confirmed.stderr());
  assert.match(confirmed.stderr(), /--confirm needs --function-env/);
  assert.equal(lookups, 1);
  assert.equal(writes(confirmed), 0);
  assert.equal(confirmed.restCalls.length, 0);
});

test('a never_touch name is refused when the resolved id is not the denylisted id', async () => {
  const { dir, ds } = workspace();
  const projects = projectsFile(dir, ORG_A, { 'c2c-widget': PROJECT_P }, { never_touch: { 'Example-Protected': '111' } });
  const cap = capture({ list: [{ name: 'Example-Protected', id: PROJECT_P }] });
  const code = await deployCli([ds, '--project', 'Example-Protected', '--org', ORG_A, '--projects', projects, '--dc', 'eu', '--confirm'], cap.io);
  assert.equal(code, 2, cap.stderr());
  assert.match(cap.stderr(), /denylist/);
  assert.equal(writes(cap), 0);
  assert.equal(cap.restCalls.length, 0);
  assert.equal(cap.fetched.length, 0);
});

test('a stuck_unusable name is refused when the resolved id is not the stuck id', async () => {
  const { dir, ds } = workspace();
  const projects = projectsFile(dir, ORG_A, { 'c2c-widget': PROJECT_P }, { stuck_unusable: { 'Old-Widget': '111' } });
  const cap = capture({ list: [{ name: 'Old-Widget', id: PROJECT_P }] });
  const code = await deployCli([ds, '--project', 'Old-Widget', '--org', ORG_A, '--projects', projects, '--dc', 'eu', '--confirm'], cap.io);
  assert.equal(code, 2, cap.stderr());
  assert.match(cap.stderr(), /stuck_unusable/);
  assert.equal(writes(cap), 0);
});

test('a project id taken from projects.json is refused when that file names a different org', async () => {
  const { dir, ds } = workspace();
  const projects = projectsFile(dir, ORG_A, { 'c2c-widget': PROJECT_P });
  const seed = join(dir, 'seed.json');
  writeFileSync(seed, JSON.stringify({ version: 1, tables: [{ table: 'Item', rows: [{ c2c_source_id: 's1', Name: 'a' }] }] }));
  const migrate = capture({ detailsOrg: ORG_B, detailsId: PROJECT_P });
  const migrateCode = await seedMigrateCli(
    ['--seed', seed, '--app', 'Widget', '--org', ORG_B, '--projects', projects, '--dc', 'eu', '--confirm'],
    migrate.io,
  );
  assert.equal(migrateCode, 2, migrate.stderr());
  assert.match(migrate.stderr(), /project registry org/);
  assert.equal(writes(migrate), 0);
  assert.equal(migrate.fetched.length, 0);
  const deploy = capture({ detailsOrg: ORG_B, detailsId: PROJECT_P });
  const deployCode = await deployCli([ds, '--org', ORG_B, '--projects', projects, '--dc', 'eu', '--confirm'], deploy.io);
  assert.equal(deployCode, 2, deploy.stderr());
  assert.match(deploy.stderr(), /project registry org/);
  assert.equal(writes(deploy), 0);
});

for (const [label, details] of [
  ['org', { detailsOrg: ORG_B, detailsId: PROJECT_P }],
  ['project', { detailsOrg: ORG_A, detailsId: PROJECT_Q }],
] as const) {
  test(`seed migrate --confirm refuses when project details report a different ${label}, before any row write`, async () => {
    const { dir, ds } = workspace();
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, JSON.stringify({ version: 1, tables: [{ table: 'Item', rows: [{ c2c_source_id: 's1', Name: 'a' }] }] }));
    const cap = capture(details);
    const code = await seedMigrateCli(
      ['--seed', seed, '--ds', ds, '--app', 'Widget', '--project', PROJECT_P, '--org', ORG_A, '--dc', 'eu', '--confirm'],
      cap.io,
    );
    assert.notEqual(code, 0);
    assert.match(cap.stderr(), /project details did not report/);
    assert.equal(cap.fetched.length, 0);
    assert.equal(writes(cap), 0);
    assert.ok(cap.restCalls.some((call) => call.method === 'GET' && call.path === `/baas/v1/project/${PROJECT_P}`));
  });

  test(`source csv --confirm refuses when project details report a different ${label}, before any row write`, async () => {
    const { ds } = workspace();
    const csvDir = mkdtempSync(join(tmpdir(), 'c2c-guard-csv-'));
    writeFileSync(join(csvDir, 'Item.csv'), 'ID,Name\n1,Bolt\n');
    writeFileSync(join(csvDir, 'counts.json'), JSON.stringify({ Item: 1 }));
    const cap = capture(details);
    const code = await sourceCsvCli(
      ['--source-csv', csvDir, '--ds', ds, '--project', PROJECT_P, '--org', ORG_A, '--dc', 'eu', '--confirm'],
      cap.io,
    );
    assert.notEqual(code, 0);
    assert.match(cap.stderr(), /project details did not report/);
    assert.equal(cap.fetched.length, 0);
    assert.equal(writes(cap), 0);
    assert.ok(cap.restCalls.some((call) => call.method === 'GET' && call.path === `/baas/v1/project/${PROJECT_P}`));
  });

  test(`backfill --confirm refuses when project details report a different ${label}, before any row write`, async () => {
    const { ds } = workspace(DECIMAL_DS);
    const cap = capture(details);
    const code = await deployCli([ds, '--project', PROJECT_P, '--org', ORG_A, '--dc', 'eu', '--backfill-shadows', '--confirm'], cap.io);
    assert.notEqual(code, 0);
    assert.match(cap.stderr(), /project details did not report/);
    assert.equal(cap.fetched.length, 0);
    assert.equal(writes(cap), 0);
    assert.ok(cap.restCalls.some((call) => call.method === 'GET' && call.path === `/baas/v1/project/${PROJECT_P}`));
  });
}
