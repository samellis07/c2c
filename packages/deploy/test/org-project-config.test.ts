/**
 * A customer's org and project come from config. Nothing in the product
 * pins a fixed org or pre-registered projects; the guard does not require a
 * project map.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployCli, type Io, type SpawnResult } from '../src/cli.js';

const SECRET = '/tmp/cred-DO-NOT-PRINT';
const CUSTOMER_ORG = '4242424242';
const OTHER_ORG = '1111111111';
const PROJECT_ID = '555';
const PROTECTED = '10000000000000001';

function orgIdShaped(text: string): string[] {
  return text.match(/\b\d{11}\b/g) ?? [];
}
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
}
`;

function projectList(name: string, id: string): string {
  return `
┌─────────────────────┬────────────┐
│    Project Name     │ Project ID │
├─────────────────────┼────────────┤
│ ${name} (active)    │ ${id}       │
└─────────────────────┴────────────┘`;
}

function projectDetails(projectId: string, org: string, name: string) {
  return {
    status: 'success',
    data: {
      id: projectId,
      project_name: name,
      env_details: [{ env_name: 'Development', env_type: 1, env_zgid: org, id: org, project_details: { id: projectId, project_name: name } }],
    },
  };
}

function workspace(): { dir: string; ds: string } {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-org-'));
  const ds = join(dir, 'widget.ds');
  writeFileSync(ds, DS);
  return { dir, ds };
}

function capture(opts: {
  list?: { name: string; id: string }[];
  detailsOrg?: string;
  detailsId?: string;
  cliOrg?: string;
} = {}): {
  io: Io;
  stdout: () => string;
  stderr: () => string;
  spawned: { args: string[] }[];
  restCalls: { method: string; path: string }[];
} {
  let out = '';
  let err = '';
  const spawned: { args: string[] }[] = [];
  const restCalls: { method: string; path: string }[] = [];
  const tables = new Map<string, { id: string; columns: Set<string> }>();
  let seq = 1;
  const detailsOrg = opts.detailsOrg ?? CUSTOMER_ORG;
  const detailsId = opts.detailsId ?? PROJECT_ID;
  const rest = async (call: { method: string; path: string; body?: unknown }) => {
    restCalls.push({ method: call.method, path: call.path });
    if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+$/.test(call.path)) {
      return { status: 200, body: projectDetails(detailsId, detailsOrg, 'acme-app') };
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
    if (call.method === 'POST' && call.path.includes('/column')) {
      const id = call.path.split('/table/')[1]?.split('/')[0];
      const found = [...tables.values()].find((table) => table.id === id);
      for (const column of call.body as { column_name: string }[]) found?.columns.add(column.column_name);
      return { status: 200, body: { status: 'success' } };
    }
    // Opened services answer their first-use gate probes (Slate app list, Stratus bucket list).
    if (call.method === 'GET' && /^\/(slate|baas)\/v1\/project\/[0-9]+\/(app|bucket)$/.test(call.path)) return { status: 200, body: { status: 'success', data: [] } };
    return { status: 404, body: {} };
  };
  const io = {
    stdout: (text: string) => {
      out += text;
    },
    stderr: (text: string) => {
      err += text;
    },
    env: { X_ZC_CREDENTIAL_PATH: SECRET },
    cliDc: () => 'eu',
    cliOrg: () => opts.cliOrg,
    listProjects: async () => opts.list ?? [],
    spawn: async (_command: string, args: string[]) => {
      spawned.push({ args });
      if (args.includes('project:list')) return { code: 0, stdout: projectList('acme-app', PROJECT_ID), stderr: '' } satisfies SpawnResult;
      return { code: 0, stdout: '', stderr: '' } satisfies SpawnResult;
    },
    fetch: async () => {
      throw new Error('network refused in this test');
    },
    rest,
    accessToken: async () => 'test-cli-token',
  } as Io;
  return { io, stdout: () => out, stderr: () => err, spawned, restCalls };
}

test('a customer org and project name with no projects.json deploys against that pair', async () => {
  const { dir, ds } = workspace();
  // This test covers the vanilla deploy path, so it pins the fallback explicitly.
  writeFileSync(join(dir, 'c2c-deploy.json'), JSON.stringify({ org: CUSTOMER_ORG, project: 'acme-app', dc: 'eu', ui: 'vanilla' }));
  const dry = capture({ list: [{ name: 'acme-app', id: PROJECT_ID }] });
  const dryOut = join(dir, 'out');
  const planned = await deployCli([ds, '--out', dryOut], dry.io);
  assert.equal(planned, 0, dry.stderr());
  assert.match(dry.stdout(), /org: <org-id>/);
  assert.match(dry.stdout(), /project_id: <project-id>/);
  assert.match(dry.stdout(), /confirm enforces:/);
  assert.equal(dry.stdout().includes(CUSTOMER_ORG), false);
  // The plan prints the output directory. Match the project id as its own number so a longer id in that path is not read as this project.
  assert.equal(new RegExp(`(?<!\\d)${PROJECT_ID}(?!\\d)`).test(dry.stdout()), false);
  assert.equal(dry.stdout().includes('name lookup:'), false);
  assert.equal(dry.spawned.length, 0);
  const plannedCatalyst = JSON.parse(readFileSync(join(dryOut, 'catalyst.json'), 'utf8')) as { org_id: string; project_id: string };
  assert.equal(plannedCatalyst.org_id, '<org-id>');
  assert.equal(plannedCatalyst.project_id, '<project-id>');
  const out = join(dir, 'live');
  const live = capture({ list: [{ name: 'acme-app', id: PROJECT_ID }] });
  const code = await deployCli([ds, '--out', out, '--confirm', '--function-env', 'new'], live.io);
  assert.equal(code, 0, live.stderr());
  assert.ok(live.spawned.some((call) => call.args.includes('deploy')));
  assert.ok(live.restCalls.some((call) => call.method === 'POST' && call.path === `/baas/v1/project/${PROJECT_ID}/table`));
  const catalyst = JSON.parse(readFileSync(join(out, 'catalyst.json'), 'utf8')) as { org_id: string; project_id: string };
  assert.equal(catalyst.org_id, CUSTOMER_ORG);
  assert.equal(catalyst.project_id, PROJECT_ID);
});

test('a write to a different org than the resolved pair is refused', async () => {
  const { dir, ds } = workspace();
  writeFileSync(join(dir, 'c2c-deploy.json'), JSON.stringify({ org: CUSTOMER_ORG, project: PROJECT_ID, dc: 'eu' }));
  const cap = capture({ detailsOrg: OTHER_ORG });
  const code = await deployCli([ds, '--confirm', '--function-env', 'new'], cap.io);
  assert.notEqual(code, 0);
  assert.match(cap.stderr(), /did not report the guarded org and project/);
  assert.equal(cap.restCalls.some((call) => call.method === 'POST'), false);
  assert.equal(cap.spawned.some((call) => call.args.includes('deploy')), false);
});

test('never_touch is still refused when projects.json names it', async () => {
  const { dir, ds } = workspace();
  const projects = join(dir, 'projects.json');
  writeFileSync(
    projects,
    JSON.stringify({
      org: CUSTOMER_ORG,
      dc: 'eu',
      env: 'Development',
      projects: { 'c2c-widget': PROJECT_ID },
      never_touch: { 'Example-Protected': PROTECTED },
    }),
  );
  const cap = capture();
  const code = await deployCli([ds, '--project', PROTECTED, '--org', CUSTOMER_ORG, '--projects', projects, '--dc', 'eu'], cap.io);
  assert.equal(code, 2);
  assert.match(cap.stderr(), /denylist/);
  assert.equal(cap.spawned.length, 0);
  assert.equal(cap.restCalls.length, 0);
});

test('a plan with no org or project uses placeholders; confirm says how to set them', async () => {
  const { ds } = workspace();
  const cap = capture();
  const code = await deployCli([ds], cap.io);
  assert.equal(code, 0, cap.stderr());
  assert.match(cap.stdout(), /org: <org-id>/);
  assert.match(cap.stdout(), /project_id: <project-id>/);
  assert.match(cap.stdout(), /confirm enforces:/);
  assert.match(cap.stdout(), /--org/);
  assert.match(cap.stdout(), /c2c-deploy.json/);
  assert.equal(cap.spawned.length, 0);
  assert.deepEqual(orgIdShaped(cap.stdout()), []);
  assert.deepEqual(orgIdShaped(cap.stderr()), []);
  const confirm = capture();
  const confirmed = await deployCli([ds, '--confirm', '--function-env', 'new'], confirm.io);
  assert.equal(confirmed, 2);
  assert.match(confirm.stderr(), /org is not configured/);
  assert.match(confirm.stderr(), /--org/);
  assert.match(confirm.stderr(), /c2c-deploy.json/);
  assert.equal(confirm.spawned.length, 0);
  assert.equal(confirm.stdout().includes('c2c deploy plan'), false);
});

test('a project name that does not exist is a guided step and is not created', async () => {
  const { dir, ds } = workspace();
  writeFileSync(join(dir, 'c2c-deploy.json'), JSON.stringify({ org: CUSTOMER_ORG, project: 'missing-app', dc: 'eu' }));
  const cap = capture({ list: [] });
  const code = await deployCli([ds, '--confirm'], cap.io);
  assert.equal(code, 2);
  assert.match(cap.stderr(), /Guided step/);
  assert.match(cap.stderr(), /does not create projects/);
  assert.equal(cap.restCalls.some((call) => call.method === 'POST'), false);
  assert.equal(cap.spawned.some((call) => call.args.includes('deploy')), false);
});

test('a plan does not read the Catalyst CLI login; confirm uses it as the last resort', async () => {
  const { ds } = workspace();
  const cap = capture({ cliOrg: CUSTOMER_ORG });
  const planned = await deployCli([ds, '--project', PROJECT_ID, '--dc', 'eu'], cap.io);
  assert.equal(planned, 0, cap.stderr());
  assert.match(cap.stdout(), /org: <org-id>/);
  assert.equal(cap.stdout().includes(CUSTOMER_ORG), false);
  assert.match(cap.stdout(), new RegExp(`project_id: ${PROJECT_ID}`));
  assert.equal(cap.spawned.length, 0);
  const live = capture({ cliOrg: CUSTOMER_ORG });
  // This test covers the vanilla deploy path, so it pins the fallback explicitly.
  const code = await deployCli([ds, '--project', PROJECT_ID, '--dc', 'eu', '--confirm', '--function-env', 'new', '--ui', 'vanilla'], live.io);
  assert.equal(code, 0, live.stderr());
  assert.match(live.stdout(), new RegExp(`org: ${CUSTOMER_ORG} \\(from catalyst CLI login \\(active_org\\)\\)`));
  assert.match(live.stdout(), new RegExp(`project: c2c-widget ${PROJECT_ID} \\(from --project\\)`));
});
