/**
 * Plan mode (no --confirm) for deploy, migrate-data and smoke.
 * A review of the plan does not need a credential directory, an org or a project.
 * --confirm still refuses before any fetch or spawn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployCli, loadApp, seedMigrateCli, smokeCli, sourceCsvCli, type Io } from '../src/cli.js';
import { buildOfflinePlan, PLAN_BUDGET_IDS } from '../src/offline-plan.js';

const DECOY_ORG = '10000000001';
const DECOY_PROJECT = '10000000000000002';
const PASSED_ORG = '10000000000';
const PASSED_PROJECT = '1001';
const OTHER_ORG = '2222222222';
const MAP_ORG = '1111111111';
const DENY_PROJECT = '10000000000000001';

const DS = `application "Widget"
{
time zone = "Asia/Kolkata"
form Item
{
Name
(
type = text
)
}
list Open_Items
{
show all rows from Item
}
}
`;

test('offline plan budget row IDs match the reference in both directions', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-plan-budget-ids-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ds = join(dir, 'widget.ds');
  writeFileSync(ds, DS);
  const { files, plan } = buildOfflinePlan(loadApp(ds), {
    dc: 'in',
    dcSource: '--dc',
    mail: false,
    newProject: true,
  });
  const emittedIds = [...new Set(plan.budgets.map((budget) => budget.id))].sort();
  const planIds = [...PLAN_BUDGET_IDS].sort();
  const reference = readFileSync('plugin/references/plan-budget-ids.md', 'utf8');
  const documentedIds = [...reference.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]!).sort();
  assert.deepEqual(emittedIds, planIds, 'every declared budget ID is emitted');
  assert.deepEqual(emittedIds, documentedIds, 'every emitted budget ID is documented, with no undocumented IDs');
  const markdown = files.find((file) => file.path === 'plan.md')?.data ?? '';
  for (const id of emittedIds) assert.match(markdown, new RegExp(`\\(${id}\\)`));
});

function workspace(): { dir: string; ds: string; seed: string; csv: string } {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-offline-plan-'));
  const ds = join(dir, 'widget.ds');
  writeFileSync(ds, DS);
  const seed = join(dir, 'seed.json');
  writeFileSync(seed, JSON.stringify({ version: 1, tables: [{ table: 'Item', rows: [{ c2c_source_id: 's1', Name: 'Bolt' }] }] }));
  const csv = join(dir, 'csv');
  writeFileSync(join(csvDir(csv), 'Item.csv'), 'ID,Name\n1,Bolt\n');
  writeFileSync(join(csv, 'counts.json'), JSON.stringify({ Item: 1 }));
  // Ids the user did not pass on the command. The plan must not repeat them.
  writeFileSync(join(dir, 'c2c-deploy.json'), JSON.stringify({ dc: 'eu', org: DECOY_ORG, project: DECOY_PROJECT }));
  writeFileSync(
    join(dir, 'projects.json'),
    JSON.stringify({
      org: DECOY_ORG,
      dc: 'eu',
      env: 'Development',
      projects: { 'c2c-widget': DECOY_PROJECT },
      never_touch: { 'Project-Guarded': DENY_PROJECT },
    }),
  );
  return { dir, ds, seed, csv };
}

function csvDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

function trap(env: NodeJS.ProcessEnv = {}): { io: Io; stdout: () => string; stderr: () => string; calls: string[] } {
  let out = '';
  let err = '';
  const calls: string[] = [];
  const io = {
    stdout: (text: string) => {
      out += text;
    },
    stderr: (text: string) => {
      err += text;
    },
    env,
    cliDc: () => {
      calls.push('cliDc');
      throw new Error('plan read the CLI login data centre');
    },
    cliOrg: () => {
      calls.push('cliOrg');
      throw new Error('plan read the CLI login org');
    },
    listProjects: async () => {
      calls.push('listProjects');
      throw new Error('plan listed projects');
    },
    spawn: async (command: string) => {
      calls.push(`spawn ${command}`);
      throw new Error(`plan spawned ${command}`);
    },
    fetch: async (url: string) => {
      calls.push(`fetch ${url}`);
      throw new Error(`plan fetched ${url}`);
    },
    rest: async () => {
      calls.push('rest');
      throw new Error('plan called admin REST');
    },
    accessToken: async () => {
      calls.push('token');
      throw new Error('plan read a token');
    },
  } as Io;
  return { io, stdout: () => out, stderr: () => err, calls };
}

function treeText(dir: string): string {
  const out: string[] = [];
  const walk = (base: string) => {
    for (const name of readdirSync(base)) {
      const path = join(base, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(readFileSync(path, 'utf8'));
    }
  };
  walk(dir);
  return out.join('\n');
}

function assertNoDecoy(text: string, label: string): void {
  assert.equal(text.includes(DECOY_ORG), false, `${label} contains the config org`);
  assert.equal(text.includes(DECOY_PROJECT), false, `${label} contains the config project`);
}

function assertPlaceholders(text: string): void {
  assert.match(text, /<org-id>/);
  assert.match(text, /<project-id>/);
  assert.match(text, /confirm enforces:/);
  assert.match(text, /X_ZC_CREDENTIAL_PATH is set/);
  assert.match(text, /data centre is configured/);
  assert.match(text, /denylist/);
}

test('deploy plan mode writes the tree with placeholder scope and does not call out', async () => {
  const { dir, ds } = workspace();
  const out = join(dir, 'out');
  const cap = trap({
    CATALYST_ORG: DECOY_ORG,
    ZC_ORG_ID: DECOY_ORG,
    CATALYST_PROJECT_ID: DECOY_PROJECT,
    PATH: process.env.PATH,
  });
  const code = await deployCli([ds, '--out', out, '--projects', join(dir, 'projects.json')], cap.io);
  assert.equal(code, 0, cap.stderr());
  assert.deepEqual(cap.calls, []);
  const plan = cap.stdout();
  assertPlaceholders(plan);
  assert.match(plan, /c2c deploy plan v1/);
  assert.match(plan, /confirm: no/);
  assert.match(plan, /data_centre: eu \(from /);
  assertNoDecoy(plan, 'deploy plan');
  const catalyst = JSON.parse(readFileSync(join(out, 'catalyst.json'), 'utf8')) as { org_id: string; project_id: string };
  assert.equal(catalyst.org_id, '<org-id>');
  assert.equal(catalyst.project_id, '<project-id>');
  assertNoDecoy(`${plan}\n${treeText(out)}`, 'deploy tree');
  rmSync(dir, { recursive: true, force: true });
});

test('deploy plan mode prints an org and project the user passed, as given', async () => {
  const { dir, ds } = workspace();
  const out = join(dir, 'out');
  const cap = trap();
  const code = await deployCli(
    [ds, '--out', out, '--org', PASSED_ORG, '--project', 'acme-app', '--dc', 'eu'],
    cap.io,
  );
  assert.equal(code, 0, cap.stderr());
  assert.deepEqual(cap.calls, []);
  assert.match(cap.stdout(), new RegExp(`org: ${PASSED_ORG} \\(from --org\\)`));
  assert.match(cap.stdout(), /project_id: acme-app/);
  assert.match(cap.stdout(), /acme-app \(from --project\)/);
  assert.equal(cap.stdout().includes('name lookup:'), false);
  const catalyst = JSON.parse(readFileSync(join(out, 'catalyst.json'), 'utf8')) as { org_id: string; project_id: string };
  assert.equal(catalyst.org_id, PASSED_ORG);
  assert.equal(catalyst.project_id, 'acme-app');
  assertNoDecoy(cap.stdout() + treeText(out), 'passed deploy plan');
  rmSync(dir, { recursive: true, force: true });
});

test('migrate-data --seed plan mode counts rows with placeholder scope and does not call out', async () => {
  const { dir, ds, seed } = workspace();
  const cap = trap({ CATALYST_ORG: DECOY_ORG, CATALYST_PROJECT_ID: DECOY_PROJECT });
  const code = await seedMigrateCli(
    ['--seed', seed, '--ds', ds, '--app', 'Widget', '--projects', join(dir, 'projects.json')],
    cap.io,
  );
  assert.equal(code, 0, cap.stderr());
  assert.deepEqual(cap.calls, []);
  assert.match(cap.stdout(), /c2c migrate-data plan v1/);
  assert.match(cap.stdout(), /source: seed/);
  assert.match(cap.stdout(), /- Item source 1/);
  assert.match(cap.stdout(), /writes: no/);
  assertPlaceholders(cap.stdout());
  assertNoDecoy(cap.stdout(), 'seed plan');
  rmSync(dir, { recursive: true, force: true });
});

test('migrate-data --source-csv plan mode counts rows with placeholder scope and does not call out', async () => {
  const { dir, ds, csv } = workspace();
  const cap = trap({ CATALYST_ORG: DECOY_ORG, CATALYST_PROJECT_ID: DECOY_PROJECT });
  const code = await sourceCsvCli(
    ['--source-csv', csv, '--ds', ds, '--projects', join(dir, 'projects.json')],
    cap.io,
  );
  assert.equal(code, 0, cap.stderr());
  assert.deepEqual(cap.calls, []);
  assert.match(cap.stdout(), /source: csv/);
  assert.match(cap.stdout(), /- Item source 1/);
  assert.match(cap.stdout(), /- Item 1/);
  assert.match(cap.stdout(), /writes: no/);
  assertPlaceholders(cap.stdout());
  assertNoDecoy(cap.stdout(), 'csv plan');
  rmSync(dir, { recursive: true, force: true });
});

test('smoke plan mode lists the planned calls with placeholder scope and does not call out', async () => {
  const { dir, ds } = workspace();
  const cap = trap({ CATALYST_ORG: DECOY_ORG, CATALYST_PROJECT_ID: DECOY_PROJECT });
  const code = await smokeCli([ds, '--projects', join(dir, 'projects.json')], cap.io);
  assert.equal(code, 0, cap.stderr());
  assert.deepEqual(cap.calls, []);
  assert.match(cap.stdout(), /c2c smoke plan v2/);
  assert.match(cap.stdout(), /session bootstrap: GET <origin>\//);
  assert.match(cap.stdout(), /submit Item: POST \/forms\/Item\/submit/);
  assert.match(cap.stdout(), /read-back Item: SELECT \* FROM Item/);
  assert.match(cap.stdout(), /report Open_Items: POST \/reports\/Open_Items/);
  assert.match(cap.stdout(), /executed: no/);
  assertPlaceholders(cap.stdout());
  assertNoDecoy(cap.stdout(), 'smoke plan');
  rmSync(dir, { recursive: true, force: true });
});

test('--confirm still refuses a missing credential, another org and another project before any call', async () => {
  const { dir, ds, seed } = workspace();
  const projects = join(dir, 'projects.json');
  const missing = trap({ PATH: process.env.PATH });
  const missingCode = await deployCli(
    [ds, '--org', PASSED_ORG, '--project', PASSED_PROJECT, '--projects', projects, '--confirm', '--function-env', 'new'],
    missing.io,
  );
  assert.equal(missingCode, 2, missing.stderr());
  assert.match(missing.stderr(), /X_ZC_CREDENTIAL_PATH is unset/);
  assert.equal(missing.stdout().includes('c2c deploy plan'), false);
  assert.deepEqual(missing.calls, []);

  // A project in c2c-deploy.json wins over projects.json, so this case keeps only the data centre there.
  writeFileSync(join(dir, 'c2c-deploy.json'), JSON.stringify({ dc: 'eu' }));
  writeFileSync(
    projects,
    JSON.stringify({
      org: MAP_ORG,
      dc: 'eu',
      env: 'Development',
      projects: { 'c2c-widget': PASSED_PROJECT },
    }),
  );
  const otherOrg = trap({ X_ZC_CREDENTIAL_PATH: join(dir, 'cred') });
  const otherOrgCode = await seedMigrateCli(
    ['--seed', seed, '--ds', ds, '--app', 'Widget', '--org', OTHER_ORG, '--projects', projects, '--dc', 'eu', '--confirm'],
    otherOrg.io,
  );
  assert.equal(otherOrgCode, 2, otherOrg.stderr());
  assert.match(otherOrg.stderr(), /refusing a project id taken from that map/);
  assert.deepEqual(otherOrg.calls, []);

  writeFileSync(
    projects,
    JSON.stringify({
      org: PASSED_ORG,
      dc: 'eu',
      env: 'Development',
      projects: { 'c2c-widget': PASSED_PROJECT },
      never_touch: { 'Project-Guarded': DENY_PROJECT },
    }),
  );
  const otherProject = trap({ X_ZC_CREDENTIAL_PATH: join(dir, 'cred') });
  const otherProjectCode = await deployCli(
    [ds, '--org', PASSED_ORG, '--project', DENY_PROJECT, '--projects', projects, '--dc', 'eu', '--confirm', '--function-env', 'new'],
    otherProject.io,
  );
  assert.equal(otherProjectCode, 2, otherProject.stderr());
  assert.match(otherProject.stderr(), /denylist/);
  assert.equal(otherProject.stdout().includes('c2c deploy plan'), false);
  assert.deepEqual(otherProject.calls, []);
  rmSync(dir, { recursive: true, force: true });
});

test('existing-project plan writes an explicit security.json row for App User and every custom role, none for App Administrator', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-plan-security-rows-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ds = join(dir, 'widget.ds');
  const profiles = `share_settings
{
"Read"
{
name = "Read"
type = Users_Permissions
}
"Developer"
{
name = "Developer"
type = Developer
}
}
}
`;
  writeFileSync(ds, DS.replace(/}\n$/, profiles));
  const { files } = buildOfflinePlan(loadApp(ds), { dc: 'in', dcSource: '--dc', mail: false, newProject: false });
  const security = JSON.parse(files.find((file) => file.path === 'provision/security.json')!.data) as {
    roles: { role_name: string }[];
    tablePermissions: { table: string; role: string; permissions: string[]; scope: string }[];
  };
  const rowFor = (role: string) => security.tablePermissions.filter((grant) => grant.table === 'Item' && grant.role === role);
  assert.deepEqual(security.roles.map((role) => role.role_name).sort(), ['Developer', 'Read']);
  // App Administrator is out of scope: never diffed, so it carries no row.
  assert.deepEqual(rowFor('App Administrator'), []);
  for (const role of ['App User', 'Read', 'Developer']) assert.equal(rowFor(role).length, 1, role);
  assert.deepEqual(rowFor('Read')[0]!.permissions, ['SELECT']);
  // The same rows the greenfield IaC template writes (clone-base default where the plan grants nothing).
  assert.deepEqual(rowFor('App User')[0], { table: 'Item', role: 'App User', permissions: ['SELECT'], scope: 'GLOBAL' });
});
