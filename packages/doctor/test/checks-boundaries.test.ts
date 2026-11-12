/**
 * Check boundaries the main suite does not pin: count thresholds, exit-code
 * guards, malformed inputs and the branches that only a specific plan or
 * evidence shape reaches. Each case fails if the matching guard is dropped.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEPLOY_CONFIG,
  f5TableBudgets,
  maskEmail,
  parseEvidence,
  resolveScope,
  runDoctorChecks,
  type DoctorContext,
  type DoctorIo,
  type McpEvidence,
  type ScopeHooks,
  type SpawnResult,
} from '../src/index.js';
import type { SchemaColumn, SchemaTable } from '../../schema/src/generator.js';
import requiredTools from '../data/required-mcp-tools.json' with { type: 'json' };

const ORG = '10000000000';
const PROJECT = '10000000000013200';
const NO_HOOKS: ScopeHooks = { cliDc: () => undefined, cliOrg: () => undefined };
const SKILLS = [
  'catalyst-by-zoho',
  'catalyst-zoho-mcp',
  'catalyst-basics',
  'catalyst-datastore',
  'catalyst-functions',
  'catalyst-slate',
  'catalyst-authentication',
  'catalyst-stratus',
];

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-checks-edges-'));
  dirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function table(ids: readonly string[]): string {
  const rows = ids.map((id) => `│ ${id} │ app │`).join('\n');
  return `┌──┬──┐\n│ Project ID │ Name │\n├──┼──┤\n${rows}\n└──┴──┘\n`;
}

type Spawn = (cmd: string, args: string[]) => SpawnResult;

function catalyst(overrides: { version?: SpawnResult; whoami?: SpawnResult; projects?: readonly string[] } = {}): Spawn {
  return (cmd, args) => {
    if (cmd !== 'catalyst') return { code: 127, stdout: '', stderr: 'not found' };
    const key = args.join(' ');
    if (key === '--version') return overrides.version ?? { code: 0, stdout: '1.28.0\n', stderr: '' };
    if (key === 'whoami') return overrides.whoami ?? { code: 0, stdout: 'Logged as: user@example.com\n', stderr: '' };
    if (key.endsWith('project:list')) return { code: 0, stdout: table(overrides.projects ?? [PROJECT]), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
}

function io(env: NodeJS.ProcessEnv, spawn: Spawn = catalyst()): DoctorIo {
  return { stdout: () => {}, stderr: () => {}, env, spawn: async (command, args) => spawn(command, args) };
}

function workspace(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tmp();
  const home = join(dir, 'home');
  const skill = join(home, 'skills', 'catalyst-by-zoho');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: catalyst-by-zoho\nmetadata:\n  version: "0.0.2"\n---\nbody\n');
  writeFileSync(join(dir, DEPLOY_CONFIG), JSON.stringify({ dc: 'in', org: ORG, project: PROJECT, env: 'Development', ui: 'vanilla' }));
  return { dir, env: { HOME: home, C2C_WORKSPACE: dir, C2C_CATALYST_SKILLS_DIR: join(home, 'skills') } };
}

function evidence(overrides: Record<string, unknown> = {}): McpEvidence {
  return parseEvidence(
    JSON.stringify({
      host: 'claude-code',
      server: 'catalyst-by-zoho',
      host_of_url: 'catalystbyzoho.zohomcp.in',
      transport: 'http',
      shape: 'meta',
      features: ['catalyst_datastore'],
      tools: [...requiredTools.base.map((name) => `CatalystbyZoho_${name}`), 'ZohoMCP_getFeatures', 'ZohoMCP_executeTool'],
      orgs: [ORG],
      tables: [],
      orgTableCount: 4,
      catalyst_skills_visible: SKILLS,
      at: new Date().toISOString(),
      ...overrides,
    }),
  );
}

async function check(id: string, ctx: Partial<DoctorContext> & { spawn?: Spawn } = {}) {
  const ws = ctx.workspace ? { dir: ctx.workspace, env: ctx.io?.env ?? {} } : workspace();
  const scope = ctx.scope ?? resolveScope({ cwd: ws.dir, flags: {}, hooks: NO_HOOKS });
  const run = await runDoctorChecks({
    io: ctx.io ?? io(ws.env, ctx.spawn),
    workspace: ws.dir,
    local: false,
    cliDc: () => undefined,
    cliOrg: () => undefined,
    ...ctx,
    scope,
  });
  const found = run.checks.find((c) => c.id === id);
  assert.ok(found, `${id} missing`);
  return found;
}

function provisionPlan(dir: string, plan: Record<string, unknown>): void {
  mkdirSync(join(dir, 'c2c-out', 'provision'), { recursive: true });
  writeFileSync(join(dir, 'c2c-out', 'provision', 'plan.json'), JSON.stringify(plan));
}

// ---------- D-A ----------

test('D-A1: a skill directory symlinked inside the skills root is refused', async () => {
  const { dir, env } = workspace();
  const root = env.C2C_CATALYST_SKILLS_DIR!;
  rmSync(join(root, 'catalyst-by-zoho'), { recursive: true });
  mkdirSync(join(root, 'real'), { recursive: true });
  writeFileSync(join(root, 'real', 'SKILL.md'), '---\nname: catalyst-by-zoho\n---\n');
  symlinkSync(join(root, 'real'), join(root, 'catalyst-by-zoho'));
  const result = await check('D-A1', { workspace: dir, io: io(env) });
  assert.equal(result.status, 'fail', result.detail);
});

test('D-A1: a copy nested under the ~/.claude/skills router directory is not searched', async () => {
  const { dir, env } = workspace();
  const nested = join(env.HOME!, '.claude', 'skills', 'catalyst-by-zoho', 'skills', 'catalyst-by-zoho');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'SKILL.md'), '---\nname: catalyst-by-zoho\n---\n');
  const result = await check('D-A1', { workspace: dir, io: io({ ...env, C2C_CATALYST_SKILLS_DIR: join(dir, 'none') }) });
  assert.equal(result.status, 'fail', result.detail);
  assert.ok(!result.detail.includes(join(nested, 'SKILL.md')), result.detail);
});

test('D-A2: two installed copies warn even when one is enabled', async () => {
  const list = [
    { name: 'catalyst-by-zoho@one', enabled: true, version: '0.0.2' },
    { name: 'catalyst-by-zoho@two', enabled: false },
  ];
  const spawn: Spawn = (cmd, args) => (cmd === 'claude' ? { code: 0, stdout: JSON.stringify(list), stderr: '' } : catalyst()(cmd, args));
  const result = await check('D-A2', { spawn });
  assert.equal(result.status, 'warn');
  assert.match(result.detail, /2 copies are installed/);
});

// ---------- D-C ----------

test('D-C1: a catalyst --version that exits non-zero is not installed, even if it prints a version', async () => {
  const result = await check('D-C1', { spawn: catalyst({ version: { code: 1, stdout: '1.28.0\n', stderr: 'broken' } }) });
  assert.equal(result.status, 'fail');
});

test('D-C3: whoami that exits non-zero is not signed in, even if it prints an account', async () => {
  const result = await check('D-C3', { spawn: catalyst({ whoami: { code: 1, stdout: 'Logged as: user@example.com\n', stderr: '' } }) });
  assert.equal(result.status, 'fail');
});

test('maskEmail: an address with nothing before @ prints no part of it', () => {
  assert.equal(maskEmail('@example.com'), 'signed in');
  assert.equal(maskEmail('user@example.com'), 'u***@example.com');
});

// ---------- D-F ----------

test('D-F1: a project id past MAX_SAFE_INTEGER matches the CLI’s rounded rendering', async () => {
  const id = `${Number.MAX_SAFE_INTEGER}1`;
  const rendered = String(Number(id));
  assert.notEqual(rendered, id);
  const { dir, env } = workspace();
  const scope = { ...resolveScope({ cwd: dir, flags: {}, hooks: NO_HOOKS }), project: id };
  const result = await check('D-F1', { workspace: dir, scope, io: io(env, catalyst({ projects: [rendered] })) });
  assert.equal(result.status, 'pass');
  assert.match(result.detail, /exists/);
});

test('D-F1: 44 projects pass, 45 warn, 50 fail', async () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `3${String(i).padStart(16, '0')}`);
  assert.equal((await check('D-F1', { spawn: catalyst({ projects: ids(44) }) })).status, 'pass');
  assert.equal((await check('D-F1', { spawn: catalyst({ projects: ids(45) }) })).status, 'warn');
  assert.equal((await check('D-F1', { spawn: catalyst({ projects: ids(50) }) })).status, 'fail');
});

test('D-F2: a target project in never_touch fails', async () => {
  const { dir, env } = workspace();
  const scope = { ...resolveScope({ cwd: dir, flags: {}, hooks: NO_HOOKS }), neverTouch: [PROJECT] };
  const result = await check('D-F2', { workspace: dir, scope, io: io(env) });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /never_touch/);
});

test('D-F3: an empty project is greenfield; tables outside the plan fail; plan tables pass', async () => {
  const empty = await check('D-F3', { evidence: evidence({ tables: [] }) });
  assert.equal(empty.status, 'pass');
  assert.match(empty.detail, /greenfield/);

  const { dir, env } = workspace();
  provisionPlan(dir, { tables: ['Table_A', { name: 'Table_B' }] });
  const foreign = await check('D-F3', { workspace: dir, io: io(env), evidence: evidence({ tables: ['Table_A', 'Foreign'] }) });
  assert.equal(foreign.status, 'fail');
  assert.match(foreign.detail, /1 tables that are not part of this app \(Foreign\)/);
  const match = await check('D-F3', { workspace: dir, io: io(env), evidence: evidence({ tables: ['Table_A', 'Table_B'] }) });
  assert.equal(match.status, 'pass');
});

test('D-F4: a non-integer org table count fails; one planned table warns', async () => {
  const fractional = await check('D-F4', { evidence: { ...evidence(), orgTableCount: 2.5 } });
  assert.equal(fractional.status, 'fail');
  const { dir, env } = workspace();
  provisionPlan(dir, { tables: ['Table_A'] });
  const one = await check('D-F4', { workspace: dir, io: io(env), evidence: evidence() });
  assert.equal(one.status, 'warn');
  assert.match(one.detail, /the plan adds 1/);
});

test('D-F6: 25 planned users pass, 26 warn', async () => {
  for (const [users, status] of [
    [25, 'pass'],
    [26, 'warn'],
  ] as const) {
    const { dir, env } = workspace();
    provisionPlan(dir, { tables: [], users });
    assert.equal((await check('D-F6', { workspace: dir, io: io(env) })).status, status, String(users));
  }
});

function column(name: string, extra: Partial<SchemaColumn> = {}): SchemaColumn {
  return { name, creatorType: 'text', matrixId: 'text', status: 'full', dataType: 'VarChar', mandatory: false, unique: false, ...extra } as SchemaColumn;
}
function tableWith(columns: SchemaColumn[]): SchemaTable {
  return { name: 'T', form: 'T', role: 'form', nosql: false, columns } as unknown as SchemaTable;
}

test('D-F5: two unique varchar columns pass, three fail; unique non-varchar columns do not count', () => {
  const unique = (n: number, dataType = 'VarChar') => Array.from({ length: n }, (_, i) => column(`U${i}`, { unique: true, dataType } as Partial<SchemaColumn>));
  assert.equal(f5TableBudgets([tableWith(unique(2))]).status, 'pass');
  const three = f5TableBudgets([tableWith(unique(3))]);
  assert.equal(three.status, 'fail');
  assert.match(three.detail, /3 unique varchar columns/);
  assert.equal(f5TableBudgets([tableWith(unique(3, 'BigInt'))]).status, 'pass');
});

test('D-F5: 15 foreign keys pass, 16 fail', () => {
  const fks = (n: number) =>
    Array.from({ length: n }, (_, i) => column(`R${i}`, { dataType: 'Foreign Key', relation: { table: 'P', column: 'ROWID', onDelete: 'ON-DELETE-CASCADE' } } as Partial<SchemaColumn>));
  assert.equal(f5TableBudgets([tableWith(fks(15))]).status, 'pass');
  const over = f5TableBudgets([tableWith(fks(16))]);
  assert.equal(over.status, 'fail');
  assert.match(over.detail, /16 foreign keys \(max 15\)/);
});

// ---------- D-D ----------

const DS = 'application "Widget"\n{\n\tsection S\n\t{\n\t\tform F\n\t\t{\n\t\t\tName\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t}\n\t}\n}\n';

test('D-D1: a snippet (no application block) is not a .ds export', async () => {
  const { dir, env } = workspace();
  const app = join(dir, 'Snippet.ds');
  writeFileSync(app, 'form F\n{\n\tName\n\t(\n\t\ttype = text\n\t)\n}\n');
  const result = await check('D-D1', { workspace: dir, io: io(env), appPath: app });
  assert.equal(result.status, 'fail', result.detail);
});

test('D-D3: migrateData or a data step in the plan makes a missing data source a failure', async () => {
  for (const plan of [{ migrateData: true }, { steps: [{ kind: 'load-data' }] }]) {
    const { dir, env } = workspace();
    const app = join(dir, 'Widget.ds');
    writeFileSync(app, DS);
    provisionPlan(dir, plan);
    const result = await check('D-D3', { workspace: dir, io: io(env), appPath: app });
    assert.equal(result.status, 'fail', JSON.stringify(plan));
    assert.equal(result.detail, 'no Creator data source');
  }
});

test('D-D3: counts must be non-negative integers, and a missing counts.json is named', async () => {
  const { dir, env } = workspace();
  const data = join(dir, 'data');
  mkdirSync(data);
  writeFileSync(join(data, 'Items.csv'), 'ID,Name\n1,a\n');
  const missing = await check('D-D3', { workspace: dir, io: io(env), sourceCsv: data });
  assert.equal(missing.detail, 'counts.json is missing');
  for (const bad of [-1, 1.5]) {
    writeFileSync(join(data, 'counts.json'), JSON.stringify({ Items: bad }));
    const result = await check('D-D3', { workspace: dir, io: io(env), sourceCsv: data });
    assert.equal(result.status, 'fail', String(bad));
    assert.equal(result.detail, 'counts.json is not a JSON object of counts');
  }
  writeFileSync(join(data, 'counts.json'), JSON.stringify({ Items: 1 }));
  assert.equal((await check('D-D3', { workspace: dir, io: io(env), sourceCsv: data })).status, 'pass');
});

// ---------- D-B ----------

test('D-B3: a server with only sign-in tools is not authorised', async () => {
  for (const tools of [['complete_authentication'], ['authenticate', 'complete_authentication']]) {
    const result = await check('D-B3', { evidence: evidence({ tools }) });
    assert.equal(result.status, 'fail', tools.join());
    assert.match(result.detail, /only sign-in tools/);
  }
});

test('D-B5: MCP tools named by provision steps and read-backs are required', async () => {
  for (const step of [
    { via: 'mcp', tool: 'CatalystbyZoho_Example_Step_Tool' },
    { via: 'cli', readBack: { via: 'mcp', tool: 'CatalystbyZoho_Example_Step_Tool' } },
  ]) {
    const { dir, env } = workspace();
    provisionPlan(dir, { steps: [step] });
    const result = await check('D-B5', { workspace: dir, io: io(env), evidence: evidence() });
    assert.equal(result.status, 'fail', JSON.stringify(step));
    assert.match(result.detail, /needed by this app's plan \(1\): Example_Step_Tool/);
  }
});

// ---------- D-V ----------

test('D-V1: a CLI DC that disagrees with config and MCP fails', async () => {
  const result = await check('D-V1', { evidence: evidence(), cliDc: () => 'eu' });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /config in, MCP in, CLI eu/);
});

test('D-V2: evidence from another workspace or dated in the future is stale; the real path of a linked workspace matches', async () => {
  const other = await check('D-V2', { evidence: { ...evidence(), workspace: join(tmp(), 'elsewhere') } });
  assert.equal(other.status, 'fail');
  const future = await check('D-V2', { evidence: { ...evidence(), at: new Date(Date.now() + 60 * 60 * 1000).toISOString() } });
  assert.equal(future.status, 'fail');

  const { dir, env } = workspace();
  const link = join(tmp(), 'linked');
  symlinkSync(dir, link);
  const linked = await check('D-V2', { workspace: link, io: io(env), evidence: { ...evidence(), workspace: realpathSync(dir) } });
  assert.equal(linked.status, 'pass');
});

test('D-V3: two connected MCP servers warn', async () => {
  const servers = [
    { name: 'catalyst-by-zoho', host: 'catalystbyzoho.zohomcp.in' },
    { name: 'catalyst-eu', host: 'catalystbyzoho.zohomcp.eu' },
  ];
  const result = await check('D-V3', { evidence: evidence({ servers }) });
  assert.equal(result.status, 'warn');
  assert.match(result.detail, /two Catalyst MCP servers/);
});
