import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEPLOY_CONFIG,
  EvidenceRejected,
  EvidenceStale,
  MANIFEST_NAME,
  c2cVersion,
  dcOfCreatorHost,
  dcOfMcpHost,
  doctorCli,
  doctorGateForArgs,
  doctorJsonPath,
  doctorStamp,
  f5TableBudgets,
  evaluateGate,
  gateRefusalMessage,
  missingRequiredTools,
  normalizeDc,
  parseEvidence,
  positionalOf,
  projectListIds,
  resolveScope,
  maskEmail,
  runDoctorChecks,
  verifyVendorCli,
  verifyProbe,
  verifyVendorDir,
  writeDoctorFile,
  dcTld,
  type DoctorContext,
  type DoctorFile,
  type DoctorIo,
  type McpEvidence,
  type ScopeHooks,
  type SpawnResult,
} from '../src/index.js';
import { limitValue } from '../../schema/src/limits.js';
import type { SchemaColumn, SchemaTable } from '../../schema/src/generator.js';
import requiredTools from '../data/required-mcp-tools.json' with { type: 'json' };
import { repoRoot } from '../../core/src/toolchain.js';
import { ALL_REQUIRED_MCP_TOOLS, MCP_TOOLS_GUIDANCE, NEVER_CALL_MCP_TOOLS, REQUIRED_MCP_TOOLS } from '../src/required-tools.js';
import { VERIFIED_MCP_TOOL_REGISTRY, isVerifiedMcpTool } from '../../deploy/src/mcp-registry.js';

const ORG = '10000000000';
const PROJECT = '10000000000013200';

test('doctor check catalogue matches the documented specification', async () => {
  const spec = readFileSync(join(repoRoot(), 'plugin/references/doctor-spec.md'), 'utf8');
  const documented = new Set([...spec.matchAll(/^\| (D-[A-Z]\d+) \|/gm)].map((match) => match[1]!));

  // The implemented set is what runDoctorChecks actually emits across an
  // offline fixture matrix that exercises every branch — a documented id the
  // code never emits, or an emitted id the spec does not document, both fail
  // this test. (The bare 'D-B' aggregate skip for missing evidence is not a
  // catalogue id and is filtered out.)
  const { dir, env } = greenWorkspace();
  const vanilla = resolveScope({ cwd: dir, flags: {}, hooks: NO_HOOKS });
  const react = resolveScope({ cwd: dir, flags: { ui: 'react' }, hooks: NO_HOOKS });
  const meta = parseEvidence(JSON.stringify(evidence()));
  const emitted = new Set<string>();
  const collect = async (ctx: DoctorContext) => {
    for (const check of (await runDoctorChecks(ctx)).checks) {
      if (/^D-[A-Z]\d+$/.test(check.id)) emitted.add(check.id);
    }
  };
  // Remote React run with evidence, a below-floor plugin and a non-pinned
  // Node: emits D-A*, D-B*, D-C*, D-D*, D-E*, D-F*, D-R* and D-V*.
  writeFileSync(
    join(env.C2C_CATALYST_SKILLS_DIR!, 'catalyst-by-zoho', 'SKILL.md'),
    '---\nname: catalyst-by-zoho\nmetadata:\n  version: "0.0.1"\n---\n',
  );
  await collect({
    io: hostIo(env, join(dir, 'npm-cache')).io,
    workspace: dir,
    scope: react,
    local: false,
    evidence: meta,
    cliDc: () => 'in',
    nodeVersion: '20.21.0',
  });
  // A --local vanilla run without evidence emits the --local skip ids.
  await collect({ io: hostIo(env, join(dir, 'npm-cache')).io, workspace: dir, scope: vanilla, local: true });

  assert.deepEqual([...emitted].sort(), [...documented].sort());
});

/** Spawns a green host: catalyst CLI answers, and node/npm satisfy the React build floors. */
function hostIo(env: NodeJS.ProcessEnv, npmCache: string, npmVersion = '10.9.2') {
  return fakeIo(env, (command, args) => {
    const key = args.join(' ');
    if (command === 'node' && key === '--version') return { code: 0, stdout: 'v20.20.1\n', stderr: '' };
    if (command === 'npm' && key === '--version') return { code: 0, stdout: `${npmVersion}\n`, stderr: '' };
    if (command === 'npm' && key === 'ping --fetch-timeout 10000') return { code: 0, stdout: '', stderr: '' };
    if (command === 'npm' && key === 'config get cache') return { code: 0, stdout: `${npmCache}\n`, stderr: '' };
    return greenCatalyst(command, args);
  });
}

test('doctor react prerequisites: the npm floor gates the registry and cache probes', async () => {
  const { dir, env } = greenWorkspace();
  const react = resolveScope({ cwd: dir, flags: { ui: 'react' }, hooks: NO_HOOKS });
  const npmCache = join(dir, 'npm-cache');
  const run = (npmVersion?: string) =>
    runDoctorChecks({ io: hostIo(env, npmCache, npmVersion).io, workspace: dir, scope: react, local: false });

  const ok = await run();
  assert.equal(ok.checks.find((check) => check.id === 'D-R1')?.status, 'pass');
  assert.equal(ok.checks.find((check) => check.id === 'D-R2')?.status, 'pass');
  assert.equal(ok.checks.find((check) => check.id === 'D-R3')?.status, 'pass');
  assert.equal(ok.checks.find((check) => check.id === 'D-R4')?.status, 'pass');
  // The D-R4 probe creates the cache directory when it is missing.
  assert.ok(existsSync(npmCache));

  // An npm below compat.json reactBuild.npmMin fails D-R2 and skips D-R3/D-R4.
  const old = await run('9.9.9');
  assert.equal(old.checks.find((check) => check.id === 'D-R2')?.status, 'fail');
  assert.equal(old.checks.find((check) => check.id === 'D-R3')?.status, 'skip');
  assert.equal(old.checks.find((check) => check.id === 'D-R4')?.status, 'skip');
});

test('doctor offline coverage: conditional and warning checks return their documented outcomes', async () => {
  const { dir, env } = greenWorkspace();
  const scope = resolveScope({ cwd: dir, flags: {}, hooks: NO_HOOKS });
  const run = (overrides: Partial<DoctorContext> = {}) =>
    runDoctorChecks({ io: fakeIo(env).io, workspace: dir, scope, local: true, ...overrides });

  // D-A4 is a WARN-only compatibility floor.
  writeFileSync(join(env.C2C_CATALYST_SKILLS_DIR!, 'catalyst-by-zoho', 'SKILL.md'), '---\nname: catalyst-by-zoho\nmetadata:\n  version: "0.0.1"\n---\n');
  const oldPlugin = (await run()).checks.find((check) => check.id === 'D-A4');
  assert.equal(oldPlugin?.status, 'warn');
  assert.match(oldPlugin!.fix!, /plugin update catalyst-by-zoho/);

  // D-C2 fails below the compatibility floor and prints the install fix.
  const oldCliIo = fakeIo(env, (command, args) =>
    command === 'catalyst' && args[0] === '--version'
      ? { code: 0, stdout: '1.27.1\n', stderr: '' }
      : greenCatalyst(command, args),
  );
  const oldCliCode = await doctorCli([], oldCliIo.io, { hooks: NO_HOOKS });
  assert.equal(oldCliCode, 1);
  assert.match(oldCliIo.out(), /FAIL D-C2/);
  assert.match(oldCliIo.out(), /npm install -g zcatalyst-cli@latest/);

  // D-B4 passes with feature groups, warns when absent, and skips for direct shape.
  const meta = parseEvidence(JSON.stringify(evidence()));
  const featurePass = (await run({ evidence: meta })).checks.find((check) => check.id === 'D-B4');
  assert.equal(featurePass?.status, 'pass');
  const noFeatures = parseEvidence(JSON.stringify(evidence({ features: [] })));
  const featureWarn = (await run({ evidence: noFeatures })).checks.find((check) => check.id === 'D-B4');
  assert.equal(featureWarn?.status, 'warn');
  const direct = parseEvidence(JSON.stringify(evidence({ shape: 'direct', tools: ['CatalystbyZoho_List_All_Tables'] })));
  const featureSkip = (await run({ evidence: direct })).checks.find((check) => check.id === 'D-B4');
  assert.equal(featureSkip?.status, 'skip');

  // D-D1 passes a parseable export, fails empty input with the exact user fix, and skips without --app.
  const app = join(dir, 'Widget.ds');
  writeFileSync(app, 'application "Widget"\n{\n\tsection S\n\t{\n\t\tform F\n\t\t{\n\t\t\tName\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t}\n\t}\n}\n');
  assert.equal((await run({ appPath: app })).checks.find((check) => check.id === 'D-D1')?.status, 'pass');
  writeFileSync(app, '');
  const badExport = (await run({ appPath: app })).checks.find((check) => check.id === 'D-D1');
  assert.equal(badExport?.status, 'fail');
  assert.match(badExport!.fix!, /Creator.*Settings.*Export/);
  assert.equal((await run()).checks.find((check) => check.id === 'D-D1')?.status, 'skip');

  // D-D2 and D-E2 are warning paths; D-F2 is a failure with its fix.
  const creatorDc = (await run({ local: false, scope: { ...scope, creatorDc: 'creator.zoho.eu' } })).checks.find((check) => check.id === 'D-D2');
  assert.equal(creatorDc?.status, 'warn');
  const pinnedNode = (await run({ nodeVersion: '20.20.0' })).checks.find((check) => check.id === 'D-E2');
  assert.equal(pinnedNode?.status, 'warn');
  const production = (await run({ local: false, scope: { ...scope, env: 'Production' } })).checks.find((check) => check.id === 'D-F2');
  assert.equal(production?.status, 'fail');
  assert.match(production!.fix!, /set "env": "Development"/);
});

const dirs: string[] = [];
function tmp(prefix = 'c2c-doctor-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fakeIo(env: NodeJS.ProcessEnv, spawn?: (cmd: string, args: string[]) => SpawnResult) {
  let out = '';
  let err = '';
  const io: DoctorIo = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env,
    spawn: async (command, args) => (spawn ? spawn(command, args) : { code: 127, stdout: '', stderr: `${command}: not found` }),
  };
  return { io, out: () => out, err: () => err };
}

const NO_HOOKS: ScopeHooks = { cliDc: () => undefined, cliOrg: () => undefined };

/** A skills dir c2c accepts as the official catalyst-by-zoho plugin. */
function writeSkills(home: string, version = '0.0.2'): string {
  const dir = join(home, 'skills', 'catalyst-by-zoho');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: catalyst-by-zoho\ndescription: official\nmetadata:\n  version: "${version}"\n---\nbody\n`,
  );
  return join(home, 'skills');
}

function writeConfig(dir: string, extra: Record<string, unknown> = {}): string {
  const path = join(dir, DEPLOY_CONFIG);
  // These tests cover the vanilla path, so they pin the fallback explicitly
  // instead of following the default UI.
  writeFileSync(path, JSON.stringify({ dc: 'in', org: ORG, project: PROJECT, env: 'Development', ui: 'vanilla', ...extra }));
  return path;
}

const PROJECT_TABLE = `\
┌───────────────┬──────────────┐
│ Project ID    │ Name         │
├───────────────┼──────────────┤
│ ${PROJECT} │ my-app       │
└───────────────┴──────────────┘
`;

function greenCatalyst(cmd: string, args: string[]): SpawnResult {
  if (cmd !== 'catalyst') return { code: 127, stdout: '', stderr: 'not found' };
  const key = args.join(' ');
  if (key === '--version') return { code: 0, stdout: '1.28.0\n', stderr: '' };
  if (key === 'whoami') return { code: 0, stdout: 'Logged as: user@example.com\n', stderr: '' };
  if (key.endsWith('project:list')) return { code: 0, stdout: PROJECT_TABLE, stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
}

function greenWorkspace(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tmp();
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  writeSkills(home);
  writeConfig(dir);
  return { dir, env: { HOME: home, C2C_WORKSPACE: dir, C2C_CATALYST_SKILLS_DIR: join(home, 'skills') } };
}

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: 'claude-code',
    server: 'catalyst-by-zoho',
    host_of_url: 'catalystbyzoho.zohomcp.in',
    transport: 'http',
    shape: 'meta',
    features: ['catalyst_datastore'],
    tools: [...requiredTools.base.map((name) => `CatalystbyZoho_${name}`), 'ZohoMCP_getFeatures', 'ZohoMCP_executeTool'],
    schemas: { CatalystbyZoho_List_All_Organizations: { path_variables: [] } },
    orgs: [ORG],
    tables: [],
    orgTableCount: 4,
    catalyst_skills_visible: [
      'catalyst-by-zoho',
      'catalyst-zoho-mcp',
      'catalyst-basics',
      'catalyst-datastore',
      'catalyst-functions',
      'catalyst-slate',
      'catalyst-authentication',
      'catalyst-stratus',
    ],
    at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------- scope ----------

test('scope: flags beat config beat the CLI store; nothing silently defaults', () => {
  const dir = tmp();
  writeConfig(dir);
  const scope = resolveScope({
    cwd: dir,
    flags: {},
    hooks: { cliDc: () => 'eu', cliOrg: () => '999' },
  });
  assert.equal(scope.dc, 'in');
  assert.equal(scope.dcSource, join(dir, DEPLOY_CONFIG));
  assert.equal(scope.org, ORG);
  assert.equal(scope.project, PROJECT);

  const flagged = resolveScope({ cwd: dir, flags: { dc: 'us', org: '1', project: '2' }, hooks: NO_HOOKS });
  assert.equal(flagged.dc, 'us');
  assert.equal(flagged.org, '1');
  assert.equal(flagged.project, '2');
});

test('scope: an empty workspace resolves nothing (no silent IN)', () => {
  const dir = tmp();
  const scope = resolveScope({ cwd: dir, flags: {}, hooks: NO_HOOKS });
  assert.equal(scope.dc, undefined);
  assert.equal(scope.org, undefined);
  assert.equal(scope.project, undefined);
});

test('scope: CLI login store is the last resort', () => {
  const dir = tmp();
  const scope = resolveScope({ cwd: dir, flags: {}, hooks: { cliDc: () => 'au', cliOrg: () => '7' } });
  assert.equal(scope.dc, 'au');
  assert.equal(scope.org, '7');
});

test('scope: dc aliases normalise; unknown spellings are errors, never IN', () => {
  const dir = tmp();
  assert.equal(resolveScope({ cwd: dir, flags: { dc: 'com' }, hooks: NO_HOOKS }).dc, 'us');
  assert.equal(resolveScope({ cwd: dir, flags: { dc: 'com.au' }, hooks: NO_HOOKS }).dc, 'au');
  assert.throws(() => resolveScope({ cwd: dir, flags: { dc: 'moon' }, hooks: NO_HOOKS }), /unknown data centre/);
  assert.equal(normalizeDc('uae'), 'uae');
  assert.equal(dcOfMcpHost('catalystbyzoho.zohomcp.in'), 'in');
  assert.equal(dcOfMcpHost('catalystbyzoho.zohomcp.com.au'), 'au');
  assert.equal(dcOfCreatorHost('creator.zoho.eu'), 'eu');
  assert.equal(dcOfCreatorHost('jp'), 'jp');
});

test('scope: apps.<link>.project and a non-decimal org are handled', () => {
  const dir = tmp();
  writeConfig(dir, { project: undefined, apps: { my_app: { project: '4242' } } });
  assert.equal(resolveScope({ cwd: dir, flags: { app: 'my_app' }, hooks: NO_HOOKS }).project, '4242');
  writeFileSync(join(dir, DEPLOY_CONFIG), JSON.stringify({ org: 'abc' }));
  assert.throws(() => resolveScope({ cwd: dir, flags: {}, hooks: NO_HOOKS }), /not a decimal id/);
});

// ---------- evidence ----------

test('evidence: a clean file parses and tool names normalise', () => {
  const parsed = parseEvidence(JSON.stringify(evidence()));
  assert.equal(parsed.host_of_url, 'catalystbyzoho.zohomcp.in');
  assert.equal(parsed.transport, 'http');
  assert.deepEqual(missingRequiredTools(parsed).base, []);
});

test('evidence: the placeholder MCP URL is rejected', () => {
  assert.throws(
    () => parseEvidence(JSON.stringify(evidence({ host_of_url: undefined, note: '<YOUR_ZOHO_MCP_URL>' }))),
    (err) => err instanceof EvidenceRejected && /placeholder/.test(err.message),
  );
});

test('evidence: URL paths, emails and oversized values never reach doctor.json', () => {
  assert.throws(() => parseEvidence(JSON.stringify(evidence({ extra: 'https://catalystbyzoho.zohomcp.in/mcp/message' }))), /URL path/);
  assert.throws(() => parseEvidence(JSON.stringify(evidence({ extra: 'a@b.example.test' }))), /email/);
  assert.throws(() => parseEvidence(JSON.stringify(evidence({ extra: 'x'.repeat(201) }))), /longer than 200/);
  assert.throws(() => parseEvidence(JSON.stringify(evidence({ tools: ['NotZoho_DoThing'] }))), /non-Catalyst tool/);
  assert.throws(() => parseEvidence(JSON.stringify(evidence({ projects: ['not-a-number'] }))), /non-decimal id/);
  assert.throws(() => parseEvidence('{'), /not JSON/);
});

test('evidence: a servers entry must be {name, host} and the error says so', () => {
  const ok = parseEvidence(JSON.stringify(evidence({ servers: [{ name: 'catalyst-by-zoho', host: 'catalystbyzoho.zohomcp.in' }] })));
  assert.deepEqual(ok.servers, [{ name: 'catalyst-by-zoho', host: 'catalystbyzoho.zohomcp.in' }]);
  for (const bad of [['catalyst-by-zoho'], [{ name: 'catalyst-by-zoho' }], [{ name: 7, host: 'x' }]]) {
    assert.throws(() => parseEvidence(JSON.stringify(evidence({ servers: bad }))), /\{name, host\}/, JSON.stringify(bad));
  }
});

test('evidence: a table entry is a name or a named record; the MCP per-project listing is kept per project', () => {
  // A flat list: bare names plus table records reduced to their name.
  const flat = parseEvidence(JSON.stringify(evidence({ tables: ['Table_A', { name: 'Table_B' }] })));
  assert.deepEqual(flat.tables, ['Table_A', 'Table_B']);
  // The Catalyst table listing answer: one record per project, each with its
  // own table names (an importing project may carry an error and no names).
  const projects = [
    { project_id: PROJECT, project_name: 'c2c-app', environment: 'Development', tables: ['Table_A', 'Table_B'] },
    { project_id: '10000000000000002', project_name: 'other', environment: 'Development', tables: ['Foreign_Table'] },
    { project_id: '10000000000000003', project_name: 'busy', environment: 'Development', tables: [], error: 'INVALID_OPERATION' },
  ];
  const scoped = parseEvidence(JSON.stringify(evidence({ tables: projects })));
  assert.equal(scoped.tables, undefined);
  assert.deepEqual(scoped.projectTables?.[PROJECT], ['Table_A', 'Table_B']);
  assert.deepEqual(scoped.projectTables?.['10000000000000002'], ['Foreign_Table']);
  // Malformed entries stay rejected: a record with no usable name or id, a
  // non-decimal project id, a non-list tables field, a name+record mix.
  for (const bad of [
    [{ table: 'Table_B' }],
    [{ name: 7 }],
    [42],
    [{ project_id: 'not-decimal', tables: [] }],
    [{ project_id: '10000000000000002' }],
    [{ project_id: '10000000000000002', tables: 'Table_A' }],
    ['Table_A', { project_id: '10000000000000002', tables: [] }],
  ]) {
    assert.throws(() => parseEvidence(JSON.stringify(evidence({ tables: bad }))), EvidenceRejected, JSON.stringify(bad));
  }
});

test('D-F3 compares the recorded tables of the target project, never a foreign project’s', async () => {
  const { dir, env } = greenWorkspace();
  const scope = resolveScope({ cwd: dir, flags: {}, hooks: NO_HOOKS });
  const { io } = fakeIo(env, greenCatalyst);
  const ev = parseEvidence(
    JSON.stringify(
      evidence({
        tables: [
          { project_id: PROJECT, project_name: 'c2c-app', environment: 'Development', tables: ['Table_A', 'Table_B'] },
          { project_id: '10000000000000002', project_name: 'other', environment: 'Development', tables: ['Foreign'] },
        ],
      }),
    ),
  );
  const run = await runDoctorChecks({ io, workspace: dir, scope, local: false, evidence: ev, cliDc: () => undefined, cliOrg: () => undefined });
  const df3 = run.checks.find((c) => c.id === 'D-F3');
  assert.ok(df3, 'D-F3 missing');
  assert.notEqual(df3.status, 'fail', JSON.stringify(df3));
  assert.match(df3.detail, /2 tables/, JSON.stringify(df3));
});

// ---------- vendor ----------

function vendorDir(tamper: 'none' | 'content' | 'extra' | 'manifest-missing'): string {
  const dir = tmp();
  writeFileSync(join(dir, 'a.js'), 'alpha');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'b.js'), 'beta');
  const sha = (name: string) => createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
  if (tamper !== 'manifest-missing') {
    writeFileSync(join(dir, MANIFEST_NAME), `${sha('a.js')}  a.js\n${sha('sub/b.js')}  sub/b.js\n`);
  }
  if (tamper === 'content') writeFileSync(join(dir, 'a.js'), 'changed');
  if (tamper === 'extra') writeFileSync(join(dir, 'rogue.js'), 'x');
  return dir;
}

test('vendor: manifest verifies, and any drift or extra file fails', () => {
  assert.equal(verifyVendorDir(vendorDir('none')).ok, true);
  assert.deepEqual(verifyVendorDir(vendorDir('content')).mismatched, ['a.js']);
  assert.deepEqual(verifyVendorDir(vendorDir('extra')).mismatched, ['rogue.js']);
  assert.match(verifyVendorDir(vendorDir('manifest-missing')).error ?? '', /MANIFEST/);
});

test('--verify-vendor exits 0 on a clean dir and 6 on a mismatch', () => {
  const clean = vendorDir('none');
  const { io, err } = fakeIo({});
  assert.equal(verifyVendorCli([clean], io), 0);
  assert.equal(verifyVendorCli([vendorDir('content')], io), 6);
  assert.match(err(), /modified|incomplete/);
});

/** sha256 of a vendored file, for hand-written manifest lines. */
function vendorSha(dir: string, rel: string): string {
  return createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex');
}

test('vendor: a symlinked file or directory is refused, wherever it points', () => {
  const dir = vendorDir('none');
  // A listed path replaced by a symlink — lstat sees the link, not the target.
  rmSync(join(dir, 'a.js'));
  symlinkSync(join(dir, 'sub', 'b.js'), join(dir, 'a.js'));
  assert.match(verifyVendorDir(dir).error ?? '', /symlink/i);
  // A symlinked directory, listed or not.
  const dir2 = vendorDir('none');
  symlinkSync(join(dir2, 'sub'), join(dir2, 'elsewhere'));
  assert.match(verifyVendorDir(dir2).error ?? '', /symlink/i);
  // A symlink pointing outside the root is refused the same way.
  const outside = tmp();
  writeFileSync(join(outside, 'x.js'), 'x');
  const dir3 = vendorDir('none');
  symlinkSync(join(outside, 'x.js'), join(dir3, 'leak.js'));
  assert.match(verifyVendorDir(dir3).error ?? '', /symlink/i);
  // And a symlinked manifest is no manifest.
  const dir4 = vendorDir('none');
  rmSync(join(dir4, MANIFEST_NAME));
  writeFileSync(join(dir4, 'real-manifest'), `${vendorSha(dir4, 'a.js')}  a.js\n`);
  symlinkSync(join(dir4, 'real-manifest'), join(dir4, MANIFEST_NAME));
  assert.match(verifyVendorDir(dir4).error ?? '', /MANIFEST/);
});

test('vendor: manifest paths that escape the root or list the manifest are refused', () => {
  const dir = vendorDir('none');
  const a = vendorSha(dir, 'a.js');
  const b = vendorSha(dir, 'sub/b.js');
  for (const rel of ['../outside.js', 'sub/../../x.js', '/abs.js', 'sub\\b.js', MANIFEST_NAME]) {
    writeFileSync(join(dir, MANIFEST_NAME), `${a}  a.js\n${b}  sub/b.js\n${a}  ${rel}\n`);
    assert.match(verifyVendorDir(dir).error ?? '', /bad path/, rel);
  }
});

test('vendor: duplicate lines, missing listed files and non-canonical manifests fail', () => {
  const dir = vendorDir('none');
  const a = vendorSha(dir, 'a.js');
  const b = vendorSha(dir, 'sub/b.js');
  // A path listed twice.
  writeFileSync(join(dir, MANIFEST_NAME), `${a}  a.js\n${a}  a.js\n${b}  sub/b.js\n`);
  assert.match(verifyVendorDir(dir).error ?? '', /twice|duplicate/i);
  // A listed file that is absent from the tree.
  writeFileSync(join(dir, MANIFEST_NAME), `${a}  a.js\n${b}  sub/b.js\n${'0'.repeat(64)}  ghost.js\n`);
  assert.deepEqual(verifyVendorDir(dir).mismatched, ['ghost.js']);
  // Not newline-terminated.
  writeFileSync(join(dir, MANIFEST_NAME), `${a}  a.js\n${b}  sub/b.js`);
  assert.match(verifyVendorDir(dir).error ?? '', /canonical/);
  // A line that is not "<sha256>  <path>".
  writeFileSync(join(dir, MANIFEST_NAME), `${a}  a.js\nnot-a-hash\n`);
  assert.match(verifyVendorDir(dir).error ?? '', /malformed/);
});

// ---------- gate ----------

/** The check ids the gate requires. */
const REQUIRED_IDS = ['D-C1', 'D-C3', 'D-C5', 'D-E1', 'D-B1', 'D-B3', 'D-B5', 'D-B7', 'D-V1', 'D-V2'];
const GATE_CHECKS = REQUIRED_IDS.map((id) => ({ id, status: 'pass' as const, detail: 'ok', fix: null }));

const SCOPE = { dc: 'in', org: ORG, project: PROJECT };

test('D-E1 passes on Node 20 and 22 and fails on 18 and 24 with the fix line', async () => {
  const dir = tmp();
  for (const nodeVersion of ['20.20.1', '22.12.0', '20.20.0', '22.99.9']) {
    const { io } = fakeIo({});
    const scope = { dc: 'in', org: ORG, project: PROJECT, ui: 'vanilla' as const, neverTouch: [] };
    const run = await runDoctorChecks({ io, workspace: dir, scope, local: true, nodeVersion });
    const de1 = run.checks.find((c) => c.id === 'D-E1');
    assert.equal(de1?.status, 'pass', `${nodeVersion}: ${JSON.stringify(de1)}`);
  }
  for (const nodeVersion of ['18.20.4', '24.1.0', '20.19.9', '23.0.0']) {
    const { io } = fakeIo({});
    const scope = { dc: 'in', org: ORG, project: PROJECT, ui: 'vanilla' as const, neverTouch: [] };
    const run = await runDoctorChecks({ io, workspace: dir, scope, local: true, nodeVersion });
    const de1 = run.checks.find((c) => c.id === 'D-E1');
    assert.equal(de1?.status, 'fail', `${nodeVersion}: ${JSON.stringify(de1)}`);
    assert.match(de1!.detail, /not supported/);
    assert.match(de1!.detail, />=20\.20 <23/);
    assert.match(de1!.fix!, /nvm install 20\.20\.1/);
  }
});

function doctorFile(overrides: Partial<DoctorFile> = {}): DoctorFile {
  return {
    c2c: c2cVersion(),
    at: new Date().toISOString(),
    host: 'claude-code',
    scope: { dc: 'in', org: ORG, project: PROJECT },
    checks: GATE_CHECKS.map((c) => ({ ...c })),
    mcp: { server: 'catalyst-by-zoho', host: 'catalystbyzoho.zohomcp.in', at: new Date().toISOString(), scope: { ...SCOPE } },
    green: true,
    ...overrides,
  };
}

test('gate: no doctor.json is not-run; a green fresh file passes', () => {
  const dir = tmp();
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).status, 'not-run');
  writeDoctorFile(dir, doctorFile());
  const verdict = evaluateGate({ workspace: dir, scope: SCOPE });
  assert.equal(verdict.ok, true);
  assert.equal(doctorStamp({ workspace: dir }).status, 'green');
});

test('gate: a doctor older than 12 h is refused', () => {
  const dir = tmp();
  writeDoctorFile(dir, doctorFile({ at: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString() }));
  const verdict = evaluateGate({ workspace: dir, scope: SCOPE });
  assert.equal(verdict.status, 'stale');
  assert.equal(verdict.ok, false);
  assert.equal(doctorStamp({ workspace: dir }).status, 'red');
});

test('gate: wrong org, wrong version, red result, missing or stale MCP are refused', () => {
  const dir = tmp();
  writeDoctorFile(dir, doctorFile());
  assert.equal(evaluateGate({ workspace: dir, scope: { ...SCOPE, org: '999' } }).status, 'scope-mismatch');

  writeDoctorFile(dir, doctorFile({ c2c: '0.0.1-old' }));
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).status, 'version');

  writeDoctorFile(dir, doctorFile({ green: false }));
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).status, 'red');

  // A doctor.json written without an MCP record (CLI half only, no MCP record yet).
  const noMcp = tmp();
  writeDoctorFile(noMcp, doctorFile({ mcp: undefined }));
  assert.equal(evaluateGate({ workspace: noMcp, scope: SCOPE }).status, 'no-mcp');

  writeDoctorFile(dir, doctorFile({ mcp: { at: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(), scope: { ...SCOPE } } }));
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).status, 'stale-mcp');
});

test('gate: the refusal line names dc/org/project and the last doctor state', () => {
  const dir = tmp();
  const verdict = evaluateGate({ workspace: dir, scope: SCOPE });
  assert.match(gateRefusalMessage(verdict, SCOPE), /c2c: doctor is not green for in\/10000000000\/10000000000013200 \(run c2c doctor; last: /);
});

test('gate: stamp is not-run before any doctor and red after a failing one', () => {
  const dir = tmp();
  assert.equal(doctorStamp({ workspace: dir }).status, 'not-run');
  writeDoctorFile(dir, doctorFile({ green: false }));
  assert.equal(doctorStamp({ workspace: dir }).status, 'red');
});

// ---------- the gate must fail closed ----------

test('gate B1: a scope that cannot be resolved refuses, never passes', () => {
  const dir = tmp();
  writeDoctorFile(dir, doctorFile());
  // resolveScope threw (bad --dc, malformed config, missing --config): the gate refuses with the reason.
  const thrown = evaluateGate({ workspace: dir, scope: {}, scopeError: 'unknown data centre "zz" from --dc' });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.status, 'scope-error');
  assert.match(thrown.scopeError ?? '', /zz/);
  // A field the command cannot name is a refusal, not a skipped comparison.
  for (const scope of [
    { org: ORG, project: PROJECT },
    { dc: 'in', project: PROJECT },
    { dc: 'in', org: ORG },
  ]) {
    const verdict = evaluateGate({ workspace: dir, scope });
    assert.equal(verdict.ok, false, JSON.stringify(scope));
    assert.equal(verdict.status, 'scope-missing');
  }
});

test('gate B1: doctorGateForArgs refuses on a bad --dc, a bad config, or a missing --config', () => {
  const dir = tmp();
  writeDoctorFile(dir, doctorFile());
  const env = { PATH: '', HOME: dir };
  for (const args of [
    ['--dc', 'zz', '--org', ORG, '--project', PROJECT, '--confirm'],
    ['--config', join(dir, 'no-such.json'), '--org', ORG, '--project', PROJECT, '--confirm'],
  ]) {
    const { verdict } = doctorGateForArgs(args, { cwd: dir, env });
    assert.equal(verdict.ok, false, args.join(' '));
    assert.equal(verdict.status, 'scope-error');
  }
  writeFileSync(join(dir, DEPLOY_CONFIG), JSON.stringify({ org: 'not-decimal' }));
  const { verdict } = doctorGateForArgs(['--org', ORG, '--project', PROJECT, '--confirm'], { cwd: dir, env });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 'scope-error');
});

test('gate B2: an MCP record bound to another scope refuses', () => {
  const dir = tmp();
  writeDoctorFile(dir, doctorFile({ mcp: { at: new Date().toISOString(), scope: { dc: 'in', org: '10000000001', project: '888' } } }));
  const verdict = evaluateGate({ workspace: dir, scope: SCOPE });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 'mcp-scope');
});

test('gate B2: a doctor run for another scope drops the earlier MCP record', () => {
  const dir = tmp();
  writeDoctorFile(dir, doctorFile());
  // Re-run with no evidence for a different org/project: the org-639 record must not carry over.
  writeDoctorFile(dir, doctorFile({ scope: { dc: 'in', org: '10000000001', project: '888' }, mcp: undefined }));
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  assert.equal(file.mcp, undefined, 'stale MCP record carried into a new scope');
  assert.equal(evaluateGate({ workspace: dir, scope: { dc: 'in', org: '10000000001', project: '888' } }).status, 'no-mcp');
  // Same-scope re-runs still keep it.
  const same = tmp();
  writeDoctorFile(same, doctorFile());
  writeDoctorFile(same, doctorFile({ mcp: undefined }));
  assert.ok((JSON.parse(readFileSync(doctorJsonPath(same), 'utf8')) as DoctorFile).mcp);
});

test('gate: an MCP record with no scope refuses, and merge never keeps one', () => {
  const dir = tmp();
  // A round-1 (pre-binding) file: scope carried the project, `mcp` is unbound.
  writeDoctorFile(dir, doctorFile({ mcp: { at: new Date().toISOString() } }));
  const verdict = evaluateGate({ workspace: dir, scope: SCOPE });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 'mcp-scope');
  assert.match(verdict.reason ?? '', /not bound to a scope/);
  assert.match(gateRefusalMessage(verdict, SCOPE), /re-record the MCP evidence \(c2c doctor --mcp-begin\)/);
  // `scope: null` and a partial scope are refusals too, never the file's scope.
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  for (const scope of [null, { dc: 'in', org: ORG }]) {
    writeFileSync(doctorJsonPath(dir), JSON.stringify({ ...file, mcp: { ...file.mcp, scope } }));
    assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).status, 'mcp-scope', JSON.stringify(scope));
  }
  // A same-scope re-run must not carry the unbound record into the merged file.
  writeFileSync(doctorJsonPath(dir), JSON.stringify({ ...file, mcp: { at: new Date().toISOString() } }));
  writeDoctorFile(dir, doctorFile({ mcp: undefined }));
  const merged = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  assert.equal(merged.mcp, undefined, 'unbound MCP record carried into a merged file');
});

test('gate B3: green:true is recomputed — failing, empty or incomplete checks refuse', () => {
  const dir = tmp();
  writeDoctorFile(dir, doctorFile({ checks: [...GATE_CHECKS, { id: 'D-D1', status: 'fail', detail: 'x', fix: null }] }));
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).status, 'checks');
  writeDoctorFile(dir, doctorFile({ checks: GATE_CHECKS.map((c) => (c.id === 'D-C3' ? { ...c, status: 'fail' as const } : c)) }));
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).status, 'checks');
  writeDoctorFile(dir, doctorFile({ checks: [] }));
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).status, 'checks');
  writeDoctorFile(dir, doctorFile({ checks: [{ id: 'D-C1', status: 'pass', detail: 'ok', fix: null }] }));
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).status, 'checks');
  writeDoctorFile(dir, doctorFile({ checks: GATE_CHECKS.map((c) => (c.id === 'D-B7' ? { ...c, status: 'skip' as const } : c)) }));
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).status, 'checks');
});

test('gate B3: the stamp carries provenance (at, scope, c2c)', () => {
  const dir = tmp();
  const file = doctorFile();
  writeDoctorFile(dir, file);
  const stamp = doctorStamp({ workspace: dir });
  assert.equal(stamp.status, 'green');
  assert.equal(stamp.at, file.at);
  assert.equal(stamp.c2c, c2cVersion());
  assert.deepEqual(stamp.scope, SCOPE);
  const empty = doctorStamp({ workspace: tmp() });
  assert.equal(empty.status, 'not-run');
  assert.equal(empty.at, undefined);
});

test('evidence B4: scheme-less URLs and paths are rejected wherever they hide', () => {
  const mutants: Record<string, unknown>[] = [
    { server: 'mcp.zoho.in/mcp/SECRETPATH/message' },
    { server: '//mcp.zoho.in/mcp/SECRETPATH/message' },
    { server: 'https://mcp.zoho.in/mcp/SECRETPATH' },
    { server: 'mcp.zoho.in?x=tok' },
    { server: 'mcp.zoho.in#frag' },
    { host_of_url: 'mcp.zoho.in/mcp/tok' },
    { servers: [{ name: 'srv/mcp/tok', host: 'mcp.zoho.in' }] },
    { servers: [{ name: 'srv', host: 'mcp.zoho.in/path' }] },
    { tools: ['mcp__srv__CatalystbyZoho_Get_X', 'x/y'] },
    { workspace: 'ws?token=1' },
    { extra: 'data:SECRET' },
  ];
  for (const mutant of mutants) {
    assert.throws(
      () => parseEvidence(JSON.stringify(evidence(mutant))),
      (err: unknown) => err instanceof EvidenceRejected,
      JSON.stringify(mutant),
    );
  }
  // Legitimate values still pass: a workspace path keeps its slashes.
  const ok = parseEvidence(JSON.stringify(evidence({ workspace: join(tmp(), 'ws root') })));
  assert.ok(ok.workspace?.endsWith('ws root'));
});

test('evidence B4: a rejected value or key never echoes the secret', () => {
  const cases: Record<string, unknown>[] = [
    { server: 'mcp.zoho.in/mcp/tok123/message' },
    { schemas: { 'https://x.zoho.in/mcp/tok123/m': {} } },
    { schemas: { [`k${'y'.repeat(210)}`]: {} } },
    { deep: { nested: ['a/b/tok123'] } },
  ];
  for (const mutant of cases) {
    try {
      parseEvidence(JSON.stringify(evidence(mutant)));
      assert.fail(`accepted ${JSON.stringify(mutant)}`);
    } catch (err) {
      assert.ok(err instanceof EvidenceRejected);
      assert.ok(!err.message.includes('tok123'), `echoed the secret: ${err.message}`);
      assert.ok(!err.message.includes('x.zoho.in'), `echoed the key: ${err.message}`);
      assert.ok(!err.message.includes('y'.repeat(40)), `echoed the key: ${err.message}`);
    }
  }
});

// ---------- spec coverage ----------

test('D-B7 is red when the evidence has no MCP org list', async () => {
  const { dir, env } = greenWorkspace();
  const evidencePath = join(dir, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence({ orgs: undefined })));
  const { io, out } = fakeIo(env, greenCatalyst);
  const code = await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS });
  assert.equal(code, 1);
  assert.match(out(), /FAIL D-B7/);
});

test('D-A3 is red when the agent did not see every Catalyst skill', async () => {
  const { dir, env } = greenWorkspace();
  const evidencePath = join(dir, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence({ catalyst_skills_visible: ['catalyst-by-zoho'] })));
  const { io, out } = fakeIo(env, greenCatalyst);
  const code = await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS });
  assert.equal(code, 1);
  assert.match(out(), /FAIL D-A3/);
});

test('D-A1: a SKILL.md under another hidden home directory does not count', async () => {
  const dir = tmp();
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  // Another host's skills directory — outside every supported search root.
  writeSkills(join(home, '.otherhost'));
  writeConfig(dir);
  const { io, out } = fakeIo({ HOME: home, C2C_WORKSPACE: dir }, greenCatalyst);
  const code = await doctorCli([], io, { hooks: NO_HOOKS });
  assert.equal(code, 1);
  assert.match(out(), /FAIL D-A1/);
});

test("D-A1: CODEX_HOME is searched and the host is reported as 'codex'", async () => {
  const dir = tmp();
  const home = join(dir, 'home');
  const codexHome = join(home, '.codex/');
  mkdirSync(codexHome, { recursive: true });
  writeSkills(codexHome);
  writeConfig(dir);
  const { io, out } = fakeIo({ HOME: home, CODEX_HOME: codexHome, C2C_WORKSPACE: dir }, greenCatalyst);
  const code = await doctorCli([], io, { hooks: NO_HOOKS });
  assert.match(out(), /PASS D-A1/);
  assert.equal(code, 0, out());
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  assert.equal(file.host, 'codex');
});

test("D-A1: ~/.claude/skills is searched and reported as 'claude-skills'", async () => {
  const dir = tmp();
  const home = join(dir, 'home');
  writeSkills(join(home, '.claude'));
  writeConfig(dir);
  const { io, out } = fakeIo({ HOME: home, C2C_WORKSPACE: dir }, greenCatalyst);
  const code = await doctorCli([], io, { hooks: NO_HOOKS });
  assert.match(out(), /PASS D-A1/);
  assert.match(out(), /claude-skills/);
  assert.equal(code, 0, out());
});

test('D-A1: nested ~/.claude/skills/catalyst-*/skills/catalyst-by-zoho/SKILL.md resolves as claude-skills', async () => {
  const dir = tmp();
  const home = join(dir, 'home');
  writeSkills(join(home, '.claude', 'skills', 'catalyst-repo'), '0.0.3');
  writeConfig(dir);
  const { io, out } = fakeIo({ HOME: home, C2C_WORKSPACE: dir }, greenCatalyst);
  const code = await doctorCli([], io, { hooks: NO_HOOKS });
  assert.match(out(), /PASS D-A1/);
  assert.match(out(), /claude-skills v0\.0\.3/);
  assert.equal(code, 0, out());
});

test('D-A1: plugin-cache is preferred over ~/.claude/skills', async () => {
  const dir = tmp();
  const home = join(dir, 'home');
  writeSkills(join(home, '.claude', 'plugins', 'cache', 'official', 'catalyst-by-zoho', '0.0.2'), '0.0.2');
  writeSkills(join(home, '.claude'), '9.9.9');
  writeConfig(dir);
  const { io, out } = fakeIo({ HOME: home, C2C_WORKSPACE: dir }, greenCatalyst);
  const code = await doctorCli([], io, { hooks: NO_HOOKS });
  assert.match(out(), /PASS D-A1/);
  assert.match(out(), /plugin-cache v0\.0\.2/);
  assert.equal(code, 0, out());
});

test('D-A1: C2C_CATALYST_SKILLS_DIR wins over plugin-cache and ~/.claude/skills', async () => {
  const dir = tmp();
  const home = join(dir, 'home');
  const envSkills = writeSkills(home, '1.2.3');
  writeSkills(join(home, '.claude', 'plugins', 'cache', 'official', 'catalyst-by-zoho', '0.0.2'), '0.0.2');
  writeSkills(join(home, '.claude'), '9.9.9');
  writeConfig(dir);
  const { io, out } = fakeIo({ HOME: home, C2C_WORKSPACE: dir, C2C_CATALYST_SKILLS_DIR: envSkills }, greenCatalyst);
  const code = await doctorCli([], io, { hooks: NO_HOOKS });
  assert.match(out(), /PASS D-A1/);
  assert.match(out(), /skills-dir v1\.2\.3/);
  assert.equal(code, 0, out());
});

test('D-A1: refuses group- or world-writable skill directories and files (mode 0777, 0775, 0666)', async () => {
  for (const [which, mode] of [
    ['skills-root', 0o777],
    ['router-dir', 0o775],
    ['skill-file', 0o666],
  ] as const) {
    const dir = tmp();
    const home = join(dir, 'home');
    const skillsRoot = writeSkills(join(home, '.claude'), '9.9.9');
    const routerDir = join(skillsRoot, 'catalyst-by-zoho');
    const skillFile = join(routerDir, 'SKILL.md');
    const target = which === 'skills-root' ? skillsRoot : which === 'router-dir' ? routerDir : skillFile;
    chmodSync(target, mode);
    writeConfig(dir);
    try {
      const { io, out } = fakeIo({ HOME: home, C2C_WORKSPACE: dir }, greenCatalyst);
      const code = await doctorCli([], io, { hooks: NO_HOOKS });
      assert.equal(code, 1, `${which} mode ${mode.toString(8)} must fail D-A1:\n${out()}`);
      assert.match(out(), /FAIL D-A1/);
      assert.doesNotMatch(out(), /PASS D-A1/);
    } finally {
      chmodSync(target, which === 'skill-file' ? 0o644 : 0o755);
    }
  }
});

test('D-A1: refuses symlinks in skill directories or pointing outside expected roots', async () => {
  // 1. Symlinked SKILL.md pointing outside ~/.claude/skills.
  {
    const dir = tmp();
    const home = join(dir, 'home');
    const outside = writeSkills(join(dir, 'outside'), '9.9.9');
    const routerDir = join(home, '.claude', 'skills', 'catalyst-by-zoho');
    mkdirSync(routerDir, { recursive: true });
    symlinkSync(join(outside, 'catalyst-by-zoho', 'SKILL.md'), join(routerDir, 'SKILL.md'));
    writeConfig(dir);
    const { io, out } = fakeIo({ HOME: home, C2C_WORKSPACE: dir }, greenCatalyst);
    assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 1, out());
    assert.match(out(), /FAIL D-A1/);
  }
  // 2. Symlinked catalyst-by-zoho directory pointing outside the expected root.
  {
    const dir = tmp();
    const home = join(dir, 'home');
    const outside = writeSkills(join(dir, 'outside'), '9.9.9');
    const skillsRoot = join(home, '.claude', 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    symlinkSync(join(outside, 'catalyst-by-zoho'), join(skillsRoot, 'catalyst-by-zoho'));
    writeConfig(dir);
    const { io, out } = fakeIo({ HOME: home, C2C_WORKSPACE: dir }, greenCatalyst);
    assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 1, out());
    assert.match(out(), /FAIL D-A1/);
  }
  // 3. Symlinked ~/.claude/skills root pointing to an outside skills tree.
  {
    const dir = tmp();
    const home = join(dir, 'home');
    const outside = writeSkills(join(dir, 'outside'), '9.9.9');
    mkdirSync(join(home, '.claude'), { recursive: true });
    symlinkSync(outside, join(home, '.claude', 'skills'));
    writeConfig(dir);
    const { io, out } = fakeIo({ HOME: home, C2C_WORKSPACE: dir }, greenCatalyst);
    assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 1, out());
    assert.match(out(), /FAIL D-A1/);
  }
});

test('D-A1: when nothing is found the failure lists every searched path', async () => {
  const dir = tmp();
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  writeConfig(dir);
  const envDir = join(home, 'envskills');
  const { io, out } = fakeIo({ HOME: home, C2C_WORKSPACE: dir, C2C_CATALYST_SKILLS_DIR: envDir }, greenCatalyst);
  assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 1);
  assert.match(out(), /FAIL D-A1/);
  for (const p of [
    join(envDir, 'catalyst-by-zoho', 'SKILL.md'),
    join(home, '.claude', 'skills', 'catalyst-by-zoho', 'SKILL.md'),
    join(home, '.claude', 'plugins', 'cache'),
    join(home, '.claude', 'plugins', 'marketplaces'),
    join(home, '.codex/skills/catalyst-by-zoho/SKILL.md'),
  ]) {
    assert.ok(out().includes(p), `failure output is missing searched path ${p}`);
  }
});

test('D-A1: an unreadable plugin directory reports a finding instead of crashing', async () => {
  const dir = tmp();
  const home = join(dir, 'home');
  const cache = join(home, '.claude', 'plugins', 'cache');
  mkdirSync(cache, { recursive: true });
  chmodSync(cache, 0o000);
  writeConfig(dir);
  try {
    const { io, out } = fakeIo({ HOME: home, C2C_WORKSPACE: dir }, greenCatalyst);
    const code = await doctorCli([], io, { hooks: NO_HOOKS });
    assert.equal(code, 1);
    assert.match(out(), /FAIL D-A1/);
    assert.match(out(), /could not be read/);
    assert.match(out(), /C2C_CATALYST_SKILLS_DIR/);
  } finally {
    chmodSync(cache, 0o700);
  }
});

test('D-A1/D-A3/D-B3 fixes name the ~/.codex paths and commands', async () => {
  const dir = tmp();
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  writeConfig(dir);
  {
    const { io, out } = fakeIo({ HOME: home, C2C_WORKSPACE: dir }, greenCatalyst);
    assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 1);
    assert.match(out(), /FAIL D-A1/);
    assert.ok(out().includes('~/.codex/skills'));
    assert.ok(out().includes('[UNVERIFIED]'));
  }
  {
    // Skills on disk so D-A3 can run against recorded evidence.
    const codexHome = join(home, '.codex/');
    writeSkills(codexHome);
    const evidencePath = join(dir, 'evidence.json');
    writeFileSync(evidencePath, JSON.stringify(evidence({ catalyst_skills_visible: ['catalyst-by-zoho'] })));
    const { io, out } = fakeIo({ HOME: home, CODEX_HOME: codexHome, C2C_WORKSPACE: dir }, greenCatalyst);
    assert.equal(await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS }), 1);
    assert.match(out(), /FAIL D-A3/);
    assert.ok(out().includes('~/.codex/skills/<name>/SKILL.md'));
  }
  {
    const evidencePath = join(dir, 'evidence.json');
    writeFileSync(evidencePath, JSON.stringify(evidence({ tools: [] })));
    const { io, out } = fakeIo({ HOME: home, C2C_WORKSPACE: dir }, greenCatalyst);
    assert.equal(await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS }), 1);
    assert.match(out(), /FAIL D-B3/);
    assert.match(out(), /codex mcp login catalyst-by-zoho/);
  }
});

test('D-C4: projects come from the Catalyst CLI only; a recorded MCP project list is never compared', async () => {
  const { dir, env } = greenWorkspace();
  const evidencePath = join(dir, 'evidence.json');
  // An old operator record that still carries an MCP project list naming a
  // different set than the CLI's project:list: it is ignored, not compared.
  writeFileSync(evidencePath, JSON.stringify(evidence({ projects: ['10000000000000001'] })));
  const { io, out } = fakeIo(env, greenCatalyst);
  const code = await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS });
  assert.equal(code, 0, out());
  assert.match(out(), /PASS D-C4/);
  assert.match(out(), /PASS D-F1/);
  assert.doesNotMatch(out(), /List_All_Projects|Get_Project_By_Id/);
});

test('D-C4: org-scoped evidence (no projects key) passes on the CLI project list', async () => {
  const { dir, env } = greenWorkspace();
  const evidencePath = join(dir, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence({ projects: undefined })));
  const { io, out } = fakeIo(env, greenCatalyst);
  const code = await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS });
  assert.equal(code, 0, out());
  assert.match(out(), /PASS D-C4/);
  // The CLI project list feeds the project budget (D-F1) and D-B7's project note.
  assert.match(out(), /PASS D-F1/);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  const c4 = file.checks.find((c) => c.id === 'D-C4');
  assert.equal(c4?.status, 'pass');
  assert.match(c4?.detail ?? '', /CLI sees org/);
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).ok, true);
});

test('D-C4: org-scoped evidence still fails on a stale, wrong-org, tool-less or server-less record', async () => {
  const { dir, env } = greenWorkspace();
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ at: new Date(Date.now() - 14 * 60 * 60 * 1000).toISOString() }, /FAIL D-V2/],
    [{ orgs: ['10000000001'] }, /FAIL D-B7/],
    [{ tools: ['ZohoMCP_getFeatures'] }, /FAIL D-B5/],
    [{ host_of_url: undefined, server: undefined }, /FAIL D-B1/],
  ];
  for (const [index, [overrides, re]] of cases.entries()) {
    const evidencePath = join(dir, `evidence-${index}.json`);
    writeFileSync(evidencePath, JSON.stringify(evidence({ ...overrides, projects: undefined })));
    const { io, out } = fakeIo(env, greenCatalyst);
    const code = await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS });
    assert.equal(code, 1, String(re));
    assert.match(out(), re);
  }
});

// ---------- D-B5: missing tools, split doctor / plan, with the guided fix ----------

async function runD_B5(tools: string[], plan?: { mcpTools?: { plan: string[] }; steps?: unknown[] }) {
  const { dir, env } = greenWorkspace();
  if (plan) {
    mkdirSync(join(dir, 'c2c-out', 'provision'), { recursive: true });
    if (plan.mcpTools) writeFileSync(join(dir, 'c2c-out', 'plan.json'), JSON.stringify({ mcpTools: { base: [], plan: plan.mcpTools.plan } }));
    if (plan.steps) writeFileSync(join(dir, 'c2c-out', 'provision', 'plan.json'), JSON.stringify({ version: 1, steps: plan.steps }));
  }
  const evidencePath = join(dir, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence({ tools, projects: undefined })));
  const { io, out } = fakeIo(env, greenCatalyst);
  await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS });
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  const check = file.checks.find((c) => c.id === 'D-B5');
  assert.ok(check, `D-B5 missing: ${out()}`);
  return { check, text: out() };
}

const prefixed = (names: readonly string[]) => names.map((name) => `CatalystbyZoho_${name}`);
const META = ['ZohoMCP_getFeatures', 'ZohoMCP_listTools', 'ZohoMCP_getSchema', 'ZohoMCP_executeTool'];

test('D-B5: a subset server lists exactly the missing tools, split doctor / plan, with the console step', async () => {
  const dropped = ['Execute_Query', 'Get_Table_Permissions', 'Update_Table_Permissions'];
  const planNeeds = prefixed(['Create_Table', 'Create_Column', 'Create_Job_Pool', 'List_All_Jobpools', 'Create_Email_Configuration']);
  const tools = [...prefixed(REQUIRED_MCP_TOOLS.base.filter((name) => !dropped.includes(name))), ...prefixed(['Create_Table', 'Create_Column']), ...META];
  const { check, text } = await runD_B5(tools, {
    mcpTools: { plan: planNeeds },
    steps: [{ id: 'jobs', via: 'mcp', tool: 'CatalystbyZoho_Create_Job_Pool', readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Jobpools' } }],
  });
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /needed by doctor \(3\): Execute_Query, Get_Table_Permissions, Update_Table_Permissions/);
  assert.match(check.detail, /Create_Email_Configuration \(fallback: .+\)/);
  assert.match(check.detail, /Create_Job_Pool \(fallback: .+\)/);
  assert.match(check.detail, /List_All_Jobpools \(fallback: .+\)/);
  assert.equal(check.fix, MCP_TOOLS_GUIDANCE);
  assert.match(text, /mcp\.zoho\.com\), open your server, Tools, Config Tools/);
  assert.match(text, /restart your AI chat session/);
});

test('D-B5: a base-complete server with a feature-free plan passes; a full tool set passes', async () => {
  const base = [...prefixed(REQUIRED_MCP_TOOLS.base), ...META];
  // A generated plan with no mail/jobs/files/apis names no extra tools — the
  // CLI table fallback (Create_Table/Create_Column) is never demanded.
  const noMail = await runD_B5(base, { mcpTools: { plan: [] }, steps: [] });
  assert.equal(noMail.check.status, 'pass', noMail.check.detail);
  assert.doesNotMatch(noMail.check.detail, /Email|Create_Table|Create_Column/);
  assert.match(noMail.check.detail, /plan tools all present/);

  // A plan file that does name extra tools still demands exactly those.
  const stale = await runD_B5(base, { mcpTools: { plan: prefixed(['Create_Table', 'Create_Column']) } });
  assert.equal(stale.check.status, 'fail');
  assert.match(stale.check.detail, /needed by this app's plan \(2\): Create_Column, Create_Table$/);
  assert.doesNotMatch(stale.check.detail, /needed by doctor/);

  const all = await runD_B5([...prefixed(ALL_REQUIRED_MCP_TOOLS), ...META], { mcpTools: { plan: prefixed(['Create_Email_Configuration', 'Create_Job_Pool']) } });
  assert.equal(all.check.status, 'pass', all.check.detail);
  assert.match(all.check.detail, /plan tools all present/);

  const noPlan = await runD_B5(base);
  assert.equal(noPlan.check.status, 'pass', noPlan.check.detail);
  assert.match(noPlan.check.detail, /no plan yet/);
});

test('D-B5: missing Add_User gets a named fallback, not a bare FAIL; full registry tools pass', async () => {
  const base = [...prefixed(REQUIRED_MCP_TOOLS.base), ...META];
  const missingAddUser = await runD_B5(base, {
    mcpTools: { plan: ['CatalystbyZoho_Add_User'] },
    steps: [{ id: 'app-users', via: 'cli', command: 'c2c provision --confirm --run app-users' }],
  });
  assert.equal(missingAddUser.check.status, 'fail');
  assert.match(missingAddUser.check.detail, /Add_User \(fallback: .+\)/);
  assert.doesNotMatch(missingAddUser.check.detail, /needed by this app's plan \(1\): Add_User$/);

  const allTools = [...new Set([...REQUIRED_MCP_TOOLS.base, ...ALL_REQUIRED_MCP_TOOLS, 'Add_User'])];
  const allPass = await runD_B5([...prefixed(allTools), ...META], {
    mcpTools: { plan: ['CatalystbyZoho_Add_User'] },
  });
  assert.equal(allPass.check.status, 'pass');
  assert.match(allPass.check.detail, /plan tools all present/);
});

test('D-B5: the plugin copy of the required tool list is identical to the doctor data', () => {
  const root = repoRoot();
  assert.equal(
    readFileSync(join(root, 'plugin', 'references', 'required-mcp-tools.json'), 'utf8'),
    readFileSync(join(root, 'packages', 'doctor', 'data', 'required-mcp-tools.json'), 'utf8'),
  );
});

test('D-B5: the MCP project tools are never required — they return project secrets', async () => {
  for (const name of ['List_All_Projects', 'Get_Project_By_Id']) {
    assert.equal(REQUIRED_MCP_TOOLS.base.includes(name), false, `${name} in base`);
    assert.equal(ALL_REQUIRED_MCP_TOOLS.includes(name), false, `${name} in a feature group`);
    assert.ok(NEVER_CALL_MCP_TOOLS.includes(name), `${name} not in neverCall`);
  }
  // A server that lists neither tool passes D-B5.
  const without = await runD_B5([...prefixed(REQUIRED_MCP_TOOLS.base), ...META]);
  assert.equal(without.check.status, 'pass', without.check.detail);
  assert.doesNotMatch(without.text, /List_All_Projects|Get_Project_By_Id/);
});

test('D-B5: every registry entry cites a facts-ledger row or reference file line that mentions the tool', () => {
  const root = repoRoot();
  assert.ok(VERIFIED_MCP_TOOL_REGISTRY.length >= 25, 'registry should contain at least 25 verified tools');
  for (const entry of VERIFIED_MCP_TOOL_REGISTRY) {
    assert.ok(entry.source, `${entry.name} lacks a source citation`);
    const [relPath, lineStr] = entry.source.split(':');
    const fullPath = join(root, relPath);
    let content: string;
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch {
      assert.fail(`${entry.name} cites non-existent file: ${relPath}`);
    }
    assert.ok(content.includes(entry.name), `${entry.name} not found in cited file: ${relPath}`);
    if (lineStr) {
      const lineNum = parseInt(lineStr, 10);
      const lines = content.split('\n');
      assert.ok(lineNum > 0 && lineNum <= lines.length, `${entry.name} line ${lineNum} out of range in ${relPath}`);
    }
    assert.ok(entry.fallback, `${entry.name} lacks a documented fallback`);
  }
  // No unverified tool is added to registry
  assert.equal(isVerifiedMcpTool('Update_Authentication_Configuration'), false, 'Update_Authentication_Configuration must not be in verified registry');
});

test('D-B5: docs, skill text and the registry agree (parity test)', () => {
  const root = repoRoot();
  const skillText = readFileSync(join(root, 'plugin', 'skills', 'c2c-preflight', 'SKILL.md'), 'utf8');
  assert.match(skillText, /references\/required-mcp-tools\.json/);
  // Verify doctor data and plugin copy agree
  const docData = JSON.parse(readFileSync(join(root, 'packages', 'doctor', 'data', 'required-mcp-tools.json'), 'utf8'));
  const pluginData = JSON.parse(readFileSync(join(root, 'plugin', 'references', 'required-mcp-tools.json'), 'utf8'));
  assert.deepEqual(docData, pluginData);
  // Verify all required tools are in registry
  const allDocTools = [...docData.base, ...Object.values(docData.byFeature).flat()];
  for (const tool of allDocTools) {
    assert.ok(isVerifiedMcpTool(tool as string), `required tool ${tool} is not in the verified registry`);
  }
  // Update_Authentication_Configuration must not be in required-mcp-tools
  assert.equal(allDocTools.includes('Update_Authentication_Configuration'), false, 'Update_Authentication_Configuration must not be in required tools');
});

test('D-A2 reads claude plugin list: enabled passes, disabled fails, absent skips', async () => {
  const claude = (payload: unknown, code = 0) => (cmd: string, args: string[]) =>
    cmd === 'claude' ? { code, stdout: JSON.stringify(payload), stderr: '' } : greenCatalyst(cmd, args);
  {
    const { env } = greenWorkspace();
    const { io, out } = fakeIo(env, claude([{ name: 'catalyst-by-zoho@official', enabled: true, version: '0.0.2' }]));
    assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 0, out());
    assert.match(out(), /PASS D-A2/);
  }
  {
    const { env } = greenWorkspace();
    const { io, out } = fakeIo(env, claude([{ name: 'catalyst-by-zoho@official', enabled: false }]));
    assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 1);
    assert.match(out(), /FAIL D-A2/);
  }
  {
    const { env } = greenWorkspace();
    const { io, out } = fakeIo(env, claude('not-json', 127));
    assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 0, out());
    assert.match(out(), /SKIP D-A2/);
  }
});

test('doctor output lists the deferred spec items', async () => {
  const { env } = greenWorkspace();
  const { io, out } = fakeIo(env, greenCatalyst);
  await doctorCli([], io, { hooks: NO_HOOKS });
  assert.match(out(), /deferred/i);
  assert.match(out(), /D-B6/);
  assert.match(out(), /D-F5/);
  assert.match(out(), /D-F6/);
});

// ---------- D-F4 ----------

test('D-F4 warns whenever the plan adds tables, passes with the count otherwise, and never fails', async () => {
  async function runWithPlan(planTables: string[] | undefined) {
    const { dir, env } = greenWorkspace();
    if (planTables !== undefined) {
      mkdirSync(join(dir, 'c2c-out', 'provision'), { recursive: true });
      writeFileSync(join(dir, 'c2c-out', 'provision', 'plan.json'), JSON.stringify({ tables: planTables }));
    }
    const evidencePath = join(dir, 'evidence.json');
    writeFileSync(evidencePath, JSON.stringify(evidence()));
    const { io, out } = fakeIo(env, greenCatalyst);
    const code = await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS });
    const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
    const df4 = file.checks.find((c) => c.id === 'D-F4');
    assert.ok(df4, `D-F4 missing: ${out()}`);
    return { code, text: out(), df4, green: file.green };
  }

  // The plan creates tables: warn with the unpublished-limit guidance and the back-off.
  {
    const run = await runWithPlan(['orders', 'customers']);
    assert.equal(run.df4.status, 'warn', JSON.stringify(run.df4));
    assert.match(run.df4.detail, /unpublished/);
    assert.match(run.df4.detail, /30\/60\/120/);
    assert.doesNotMatch(run.df4.detail, /200-table/);
    // A warning keeps the overall result green.
    assert.equal(run.code, 0, run.text);
    assert.equal(run.green, true);
  }

  // The plan creates no tables: pass with the count.
  {
    const run = await runWithPlan([]);
    assert.equal(run.df4.status, 'pass', JSON.stringify(run.df4));
    assert.match(run.df4.detail, /tables 4 \+ 0 planned/);
    assert.equal(run.code, 0, run.text);
    assert.equal(run.green, true);
  }
});

// ---------- D-F7 ----------

test('D-F7: a target project still "Importing" past the stuck bound fails with the one guided step — the list is read once, nothing retried', async () => {
  const { dir, env } = greenWorkspace();
  const { io, out } = fakeIo(env, greenCatalyst);
  let lists = 0;
  io.listProjects = async (org) => {
    lists++;
    assert.equal(org, ORG);
    return [{ name: 'c2c-widget', id: PROJECT, projectType: 'Importing', createdTime: 'Oct 08, 2020 05:00 AM' }];
  };
  const code = await doctorCli([], io, { hooks: NO_HOOKS });
  assert.equal(code, 1, out());
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  const df7 = file.checks.find((c) => c.id === 'D-F7');
  assert.ok(df7, `D-F7 missing: ${out()}`);
  assert.equal(df7.status, 'fail');
  assert.match(df7.detail, /check the project in the Catalyst console; if it stays Importing, contact Catalyst support/);
  assert.equal(lists, 1, 'the org list is read once — the delete is never retried');
});

test('D-F7: an Importing project under the bound warns; a Live target passes', async () => {
  // Thirty minutes old — still importing but not yet stuck.
  const { dir, env } = greenWorkspace();
  const { io, out } = fakeIo(env, greenCatalyst);
  io.listProjects = async () => [{ name: 'c2c-widget', id: PROJECT, projectType: 'Importing', createdTime: new Date(Date.now() - 30 * 60 * 1000).toISOString() }];
  assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 0, out());
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  const df7 = file.checks.find((c) => c.id === 'D-F7');
  assert.equal(df7?.status, 'warn', JSON.stringify(df7));
  assert.match(df7?.detail ?? '', /still "Importing"/);

  const ws2 = greenWorkspace();
  const second = fakeIo(ws2.env, greenCatalyst);
  second.io.listProjects = async () => [{ name: 'c2c-widget', id: PROJECT, projectType: 'Live' }];
  assert.equal(await doctorCli([], second.io, { hooks: NO_HOOKS }), 0, second.out());
  const file2 = JSON.parse(readFileSync(doctorJsonPath(ws2.dir), 'utf8')) as DoctorFile;
  const df7b = file2.checks.find((c) => c.id === 'D-F7');
  assert.equal(df7b?.status, 'pass', JSON.stringify(df7b));
});

test('D-F7: an Importing project with unknown age warns with neutral guidance', async () => {
  const { dir, env } = greenWorkspace();
  const { io, out } = fakeIo(env, greenCatalyst);
  io.listProjects = async () => [{ name: 'c2c-widget', id: PROJECT, projectType: 'Importing' }];
  assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 0, out());
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  const df7 = file.checks.find((c) => c.id === 'D-F7');
  assert.equal(df7?.status, 'warn', JSON.stringify(df7));
  assert.match(df7?.detail ?? '', /still importing; check its status in the Catalyst console and re-run later/);
  assert.doesNotMatch(df7?.detail ?? '', /contact Catalyst support/);
});

test('D-F7: an unreadable org list degrades to a skip, never a fail', async () => {
  const { dir, env } = greenWorkspace();
  const { io, out } = fakeIo(env, greenCatalyst);
  io.listProjects = async () => {
    throw new Error('list failed');
  };
  assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 0, out());
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  const df7 = file.checks.find((c) => c.id === 'D-F7');
  assert.equal(df7?.status, 'skip', JSON.stringify(df7));
});

// ---------- doctor run ----------

test('doctor: a fully provisioned workspace runs green and writes doctor.json', async () => {
  const { dir, env } = greenWorkspace();
  const { io, out } = fakeIo(env, greenCatalyst);
  const code = await doctorCli([], io, { hooks: NO_HOOKS });
  assert.equal(code, 0, out());
  assert.match(out(), /PASS D-C4/);
  assert.match(out(), /doctor: green/);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  assert.equal(file.green, true);
  assert.equal(file.scope.dc, 'in');
  assert.equal(file.scope.org, ORG);
  assert.equal(file.scope.project, PROJECT);
  assert.equal(file.c2c, c2cVersion());
  for (const check of file.checks) {
    assert.doesNotMatch(check.detail, /@|\/mcp\/|token/i, `check ${check.id} leaked a secret`);
  }
});

test('doctor: the CLI account email is masked on screen and absent from --json and doctor.json', async () => {
  const email = 'jane.doe@corp.example.com';
  const spawn = (cmd: string, args: string[]): SpawnResult =>
    cmd === 'catalyst' && args.join(' ') === 'whoami' ? { code: 0, stdout: `Logged as: ${email}\n`, stderr: '' } : greenCatalyst(cmd, args);
  const { dir, env } = greenWorkspace();
  const human = fakeIo(env, spawn);
  assert.equal(await doctorCli([], human.io, { hooks: NO_HOOKS }), 0, human.out());
  assert.match(human.out(), /PASS D-C3  CLI signed in \(j\*\*\*@corp\.example\.com\)/);
  assert.ok(!human.out().includes(email) && !human.out().includes('jane.doe'), 'human output printed the full email');
  assert.ok(!readFileSync(doctorJsonPath(dir), 'utf8').includes('@'), 'doctor.json holds an email');
  const json = fakeIo(env, spawn);
  await doctorCli(['--json'], json.io, { hooks: NO_HOOKS });
  assert.ok(!json.out().includes('@'), 'doctor --json printed an email');
  assert.equal(maskEmail('not-an-email'), 'signed in');
});

test('doctor: a missing Catalyst CLI fails D-C1 with the exact fix', async () => {
  const { dir, env } = greenWorkspace();
  const { io, out } = fakeIo(env, () => ({ code: 127, stdout: '', stderr: 'catalyst: not found' }));
  const code = await doctorCli([], io, { hooks: NO_HOOKS });
  assert.equal(code, 1);
  assert.match(out(), /FAIL D-C1/);
  assert.match(out(), /npm install -g zcatalyst-cli/);
  assert.match(out(), /with Node 20 or 22/);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  assert.equal(file.green, false);
});

test('doctor --local --quiet: no output, no network checks, nothing persisted', async () => {
  const { dir, env } = greenWorkspace();
  const spawned: string[] = [];
  const { io, out } = fakeIo(env, (cmd, args) => {
    spawned.push(`${cmd} ${args.join(' ')}`);
    return { code: 127, stdout: '', stderr: 'not found' };
  });
  const code = await doctorCli(['--local', '--quiet'], io, { hooks: NO_HOOKS });
  assert.equal(code, 1, out());
  assert.equal(out(), '');
  assert.ok(!existsSync(doctorJsonPath(dir)), '--local must not write doctor.json');
  assert.ok(!spawned.some((line) => line.includes('project:list')), '--local must not hit the account');
});

test('doctor --json emits the persisted shape', async () => {
  const { env } = greenWorkspace();
  const { io, out } = fakeIo(env, greenCatalyst);
  const code = await doctorCli(['--json'], io, { hooks: NO_HOOKS });
  assert.equal(code, 0);
  const doc = JSON.parse(out()) as DoctorFile & { doctorJson: string };
  assert.equal(doc.green, true);
  assert.equal(doc.scope.dc, 'in');
  assert.ok(doc.checks.some((c) => c.id === 'D-E4'));
});

test('doctor --record-mcp merges evidence and runs the D-B/D-V entries', async () => {
  const { dir, env } = greenWorkspace();
  const evidencePath = join(dir, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence()));
  const { io, out } = fakeIo(env, greenCatalyst);
  const code = await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS });
  assert.equal(code, 0, out());
  assert.match(out(), /PASS D-B2/);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  assert.ok(file.mcp);
  assert.equal(file.mcp?.host, 'catalystbyzoho.zohomcp.in');
  assert.doesNotMatch(JSON.stringify(file), /\/mcp\/message|@/);
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).ok, true);
});

test('doctor --record-mcp: raw project/org entries reduce to ids; nothing else they held is kept', async () => {
  const { dir, env } = greenWorkspace();
  const evidencePath = join(dir, 'evidence.json');
  writeFileSync(
    evidencePath,
    JSON.stringify(
      evidence({
        orgs: [{ org_id: ORG, name: 'org-name', secret: 'org-secret-canary' }],
        projects: [
          { id: PROJECT, name: 'my-app', clientSecret: 'css-canary', jwtSecret: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl' },
          { project_id: '10000000000000002', name: 'other-app', clientId: 'cid-canary' },
        ],
      }),
    ),
  );
  const TWO_PROJECTS = PROJECT_TABLE.replace('└', `│ 10000000000000002 │ other-app    │\n└`);
  const spawn = (cmd: string, args: string[]): SpawnResult =>
    cmd === 'catalyst' && args.join(' ').endsWith('project:list') ? { code: 0, stdout: TWO_PROJECTS, stderr: '' } : greenCatalyst(cmd, args);
  const { io, out } = fakeIo(env, spawn);
  const code = await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS });
  assert.equal(code, 0, out());
  // The comparison used ids only, and no field an entry carried survives.
  const file = readFileSync(doctorJsonPath(dir), 'utf8');
  const blob = `${file}\n${out()}`;
  for (const canary of ['org-secret-canary', 'css-canary', 'cid-canary', 'c2lnbmF0dXJl', 'other-app']) {
    assert.ok(!blob.includes(canary), `canary ${canary} reached output or doctor.json`);
  }
});

test('doctor --record-mcp: an entry that cannot name an id is a stale/incomplete finding, not a crash', async () => {
  const { dir, env } = greenWorkspace();
  const evidencePath = join(dir, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence({ projects: [{ name: 'my-app', clientId: 'cid' }] })));
  const { io, err } = fakeIo(env, greenCatalyst);
  const code = await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS });
  assert.equal(code, 1);
  assert.match(err(), /MCP evidence is stale\/incomplete: .*re-record/);
  assert.ok(!existsSync(doctorJsonPath(dir)), 'a rejected file must not write doctor.json');
});

test('doctor --record-mcp: stale evidence is a stale/incomplete finding', async () => {
  const { dir, env } = greenWorkspace();
  const evidencePath = join(dir, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence({ at: new Date(Date.now() - 14 * 60 * 60 * 1000).toISOString() })));
  const { io, out } = fakeIo(env, greenCatalyst);
  const code = await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS });
  assert.equal(code, 1);
  assert.match(out(), /FAIL D-V2/);
  assert.match(out(), /MCP evidence is stale\/incomplete: .*re-record/);
});

test('doctor --record-mcp on the wrong DC fails D-B2 and stays red', async () => {
  const { dir, env } = greenWorkspace();
  const evidencePath = join(dir, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence({ host_of_url: 'catalystbyzoho.zohomcp.eu' })));
  const { io, out } = fakeIo(env, greenCatalyst);
  const code = await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS });
  assert.equal(code, 1);
  assert.match(out(), /FAIL D-B2/);
  assert.match(out(), /points at eu/);
});

test('doctor --record-mcp rejects hostile evidence before any write', async () => {
  const { dir, env } = greenWorkspace();
  const evidencePath = join(dir, 'evil.json');
  writeFileSync(evidencePath, JSON.stringify(evidence({ sneaky: 'user@corp.example.test' })));
  const { io, err } = fakeIo(env, greenCatalyst);
  const code = await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS });
  assert.equal(code, 1);
  assert.match(err(), /evidence rejected/);
});

test('doctor: a second run keeps the earlier MCP record', async () => {
  const { dir, env } = greenWorkspace();
  const evidencePath = join(dir, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence()));
  {
    const { io } = fakeIo(env, greenCatalyst);
    assert.equal(await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks: NO_HOOKS }), 0);
  }
  const { io, out } = fakeIo(env, greenCatalyst);
  assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 0);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  assert.ok(file.mcp, out());
});

// ---------- project:list parsing ----------

test('projectListIds reads the Project ID column of a cli-table3 table', () => {
  assert.deepEqual(projectListIds(PROJECT_TABLE), [PROJECT]);
  assert.deepEqual(projectListIds('no table here'), []);
});

// ---------- missing / malformed inputs never crash ----------

test('scope: a hook that returns null or throws is an absent value, not a crash', () => {
  const dir = tmp();
  const scope = resolveScope({
    cwd: dir,
    flags: {},
    hooks: {
      cliDc: () => null as unknown as undefined,
      cliOrg: () => {
        throw new Error('store unreadable');
      },
    },
  });
  assert.equal(scope.dc, undefined);
  assert.equal(scope.org, undefined);
});

test('scope: DC helpers take a missing value without throwing', () => {
  const missing = undefined as unknown as string;
  const absent = null as unknown as string;
  assert.equal(normalizeDc(missing), undefined);
  assert.equal(normalizeDc(absent), undefined);
  assert.equal(dcOfMcpHost(missing), undefined);
  assert.equal(dcOfCreatorHost(absent), undefined);
  assert.equal(dcTld(missing), undefined);
});

test('projectListIds: missing or partial CLI output is an empty list, not a crash', () => {
  assert.deepEqual(projectListIds(undefined as unknown as string), []);
  assert.deepEqual(projectListIds(null as unknown as string), []);
  assert.deepEqual(projectListIds(''), []);
});

test('doctor: a CLI-store read that answers once then goes missing is an unknown DC, not a crash', async () => {
  const { dir, env } = greenWorkspace();
  const evidencePath = join(dir, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence()));
  // The store reader runs once for the scope and once for D-V1; a second read
  // that comes back empty must not reach a string call.
  let calls = 0;
  const hooks: ScopeHooks = {
    cliDc: () => (++calls === 3 ? undefined : 'in'),
    cliOrg: () => undefined,
  };
  const { io, out } = fakeIo(env, greenCatalyst);
  const code = await doctorCli(['--record-mcp', evidencePath, '--operator'], io, { hooks });
  assert.equal(code, 0, out());
  assert.match(out(), /D-V1/);
});

test('doctor: a CLI-store read that throws is an absent value, not a scope error', async () => {
  const { env } = greenWorkspace();
  const hooks: ScopeHooks = {
    cliDc: () => {
      throw new Error('store unreadable');
    },
    cliOrg: () => {
      throw new Error('store unreadable');
    },
  };
  const { io, out } = fakeIo(env, greenCatalyst);
  const code = await doctorCli([], io, { hooks });
  assert.equal(code, 0, out());
});

test('doctor: a spawn that resolves with no result is a failed command, not a crash', async () => {
  const { env } = greenWorkspace();
  const { io, out } = fakeIo(env, () => undefined as unknown as SpawnResult);
  const code = await doctorCli([], io, { hooks: NO_HOOKS });
  assert.equal(code, 1, out());
  assert.match(out(), /FAIL D-C1/);
  assert.match(out(), /FAIL D-C3/);
});

test('doctor: a spawn result with no output fields fails the named checks', async () => {
  const { env } = greenWorkspace();
  const { io, out } = fakeIo(env, () => ({ code: 0 }) as unknown as SpawnResult);
  const code = await doctorCli([], io, { hooks: NO_HOOKS });
  assert.equal(code, 1, out());
  assert.match(out(), /FAIL D-C1/);
});

test('doctor: a malformed evidence field is a named FAIL, never a crash', async () => {
  const { dir, env } = greenWorkspace();
  const scope = resolveScope({ cwd: dir, flags: {}, hooks: NO_HOOKS });
  const cases: [Record<string, unknown>, RegExp][] = [
    [evidence({ servers: [{ name: 'only-name' }] }), /FAIL D-V3/],
    [evidence({ servers: 'ab' }), /FAIL D-V3/],
    [evidence({ tools: ['CatalystbyZoho_List_All_Tables', 42] }), /FAIL D-B3/],
    [evidence({ orgs: 'not-a-list' }), /FAIL D-B7/],
    [evidence({ catalyst_skills_visible: 7 }), /FAIL D-A3/],
    [evidence({ tables: 'Table_A' }), /FAIL D-F3/],
    [evidence({ orgTableCount: 'many' }), /FAIL D-F4/],
    [evidence({ host_of_url: 443 }), /FAIL D-B1/],
  ];
  for (const [ev, re] of cases) {
    const { io } = fakeIo(env, greenCatalyst);
    const ctx: DoctorContext = {
      io,
      workspace: dir,
      scope,
      local: false,
      evidence: ev as unknown as McpEvidence,
      cliDc: () => undefined,
      cliOrg: () => undefined,
    };
    const run = await runDoctorChecks(ctx);
    const listing = run.checks.map((c) => `${c.status.toUpperCase()} ${c.id}`).join('\n');
    assert.match(listing, re, JSON.stringify(ev).slice(0, 140));
  }
});

// ---------- positional ----------

test('positionalOf skips flag values', () => {
  assert.equal(positionalOf(['--dc', 'in', 'app.ds']), 'app.ds');
  assert.equal(positionalOf(['--confirm']), undefined);
  assert.equal(positionalOf(['x.ds', '--org', '1']), 'x.ds');
});

test('gate: the project-creating import passes on an org-scoped doctor only; dc/org stay required and a project-scoped file mismatches', () => {
  const orgScope = { dc: 'in', org: ORG };
  const orgOnly = (): DoctorFile => doctorFile({ scope: { ...orgScope }, mcp: { server: 'catalyst-by-zoho', host: 'catalystbyzoho.zohomcp.in', at: new Date().toISOString(), scope: { ...orgScope } } });
  const dir = tmp();
  writeDoctorFile(dir, orgOnly());
  // Without the create flag an org-only scope is still scope-missing (exit 5).
  assert.equal(evaluateGate({ workspace: dir, scope: orgScope }).status, 'scope-missing');
  assert.equal(evaluateGate({ workspace: dir, scope: orgScope, createsProject: true }).ok, true);
  // dc and org are never optional.
  assert.equal(evaluateGate({ workspace: dir, scope: { org: ORG }, createsProject: true }).status, 'scope-missing');
  assert.equal(evaluateGate({ workspace: dir, scope: { dc: 'in' }, createsProject: true }).status, 'scope-missing');
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).status, 'scope-mismatch');
  // A project-scoped doctor never stands in for the org-scoped one.
  const scoped = tmp();
  writeDoctorFile(scoped, doctorFile());
  assert.equal(evaluateGate({ workspace: scoped, scope: orgScope, createsProject: true }).status, 'scope-mismatch');
  // An MCP record bound to a project does not pass the org-scoped create.
  const boundMcp = tmp();
  writeDoctorFile(boundMcp, doctorFile({ scope: { ...orgScope } }));
  assert.equal(evaluateGate({ workspace: boundMcp, scope: orgScope, createsProject: true }).status, 'mcp-scope');
  // Through the argv path.
  const env = { PATH: '', HOME: dir };
  assert.equal(doctorGateForArgs(['--dc', 'in', '--org', ORG, '--confirm'], { cwd: dir, env, createsProject: true }).verdict.ok, true);
  assert.equal(doctorGateForArgs(['--dc', 'in', '--org', ORG, '--confirm'], { cwd: dir, env }).verdict.status, 'scope-missing');
});

// ---------- the hourly token-expiry edge on the CLI reads ----------

/** A CLI read that answers the recorded 401 INVALID_TOKEN `fails` times, then the green answer. */
function expiringCatalyst(fails: number, key: string, stderr = 'HTTP Error: 401, {"error_code":"INVALID_TOKEN","message":"invalid oauth token"}\n') {
  const calls: string[] = [];
  const spawn = (cmd: string, args: string[]): SpawnResult => {
    const joined = args.join(' ');
    calls.push(joined);
    if (cmd === 'catalyst' && joined.endsWith(key) && calls.filter((c) => c.endsWith(key)).length <= fails) return { code: 1, stdout: '', stderr };
    return greenCatalyst(cmd, args);
  };
  return { spawn, calls: (k: string) => calls.filter((c) => c.endsWith(k)).length };
}

/** A store that holds tag `t1` until `rotateAfter` peeks, then `t2` — an outside refresh between the read and the re-read. */
function storeTags(rotateAfter: number) {
  let peeks = 0;
  return {
    tokenTag: async () => (++peeks > rotateAfter ? 't2' : 't1'),
    peeks: () => peeks,
  };
}

test('doctor: whoami and project:list that meet 401 INVALID_TOKEN re-run once when the store holds a newer token, with no refresh', async () => {
  for (const key of ['whoami', 'project:list']) {
    const { env } = greenWorkspace();
    const cli = expiringCatalyst(1, key);
    const { io, out, err } = fakeIo(env, cli.spawn);
    // whoami peeks once before its read; project:list after whoami's peek.
    const store = storeTags(key === 'whoami' ? 1 : 2);
    io.tokenTag = store.tokenTag;
    let refreshes = 0;
    io.refreshToken = async () => {
      refreshes++;
    };
    const code = await doctorCli([], io, { hooks: NO_HOOKS });
    assert.equal(code, 0, out());
    assert.equal(refreshes, 0, key);
    assert.equal(cli.calls(key), 2, key);
    // On stderr, so `doctor --json` stays one JSON document.
    assert.match(err(), /retried once with a newer token/);
    assert.match(out(), /PASS D-C3/);
    assert.match(out(), /PASS D-C4/);
  }
});

test('doctor: an unchanged stored token is not re-run; C2C_ALLOW_LOCAL_REFRESH=1 forces one refresh instead', async () => {
  const same = greenWorkspace();
  const cli = expiringCatalyst(1, 'whoami');
  const a = fakeIo(same.env, cli.spawn);
  a.io.tokenTag = async () => 't1';
  let refreshes = 0;
  a.io.refreshToken = async () => {
    refreshes++;
  };
  await doctorCli([], a.io, { hooks: NO_HOOKS });
  assert.equal(refreshes, 0);
  assert.equal(cli.calls('whoami'), 1);
  assert.match(a.err(), /catalyst whoami: 401 INVALID_TOKEN, not retried: no newer token/);
  assert.match(a.out(), /FAIL D-C3/);

  const local = greenWorkspace();
  const cli2 = expiringCatalyst(1, 'whoami');
  const b = fakeIo({ ...local.env, C2C_ALLOW_LOCAL_REFRESH: '1' }, cli2.spawn);
  b.io.tokenTag = async () => 't1';
  let localRefreshes = 0;
  b.io.refreshToken = async () => {
    localRefreshes++;
  };
  await doctorCli([], b.io, { hooks: NO_HOOKS });
  assert.equal(localRefreshes, 1);
  assert.equal(cli2.calls('whoami'), 2);
  assert.match(b.out(), /PASS D-C3/);
});

test('doctor: a second 401 INVALID_TOKEN fails the read; any other 401 is never retried', async () => {
  const twice = greenWorkspace();
  const cli = expiringCatalyst(2, 'whoami');
  const a = fakeIo(twice.env, cli.spawn);
  a.io.tokenTag = storeTags(1).tokenTag;
  await doctorCli([], a.io, { hooks: NO_HOOKS });
  assert.equal(cli.calls('whoami'), 2);
  assert.match(a.err(), /catalyst whoami: still 401 INVALID_TOKEN after one retry/);
  assert.match(a.out(), /FAIL D-C3/);

  const other = greenWorkspace();
  const scope = expiringCatalyst(1, 'project:list', 'HTTP Error: 401, {"error_code":"OAUTH_SCOPE_MISMATCH","message":"invalid oauth scope to access this URL"}\n');
  const b = fakeIo(other.env, scope.spawn);
  const store = storeTags(0);
  b.io.tokenTag = store.tokenTag;
  await doctorCli([], b.io, { hooks: NO_HOOKS });
  assert.equal(scope.calls('project:list'), 1);
  assert.match(b.out(), /FAIL D-C4/);
  assert.doesNotMatch(b.err(), /INVALID_TOKEN/);
});

// ---------- D-D3 ----------

test('D-D3: a CSV with an ID column passes; one without warns instead of failing', async () => {
  const { dir, env } = greenWorkspace();
  const scope = resolveScope({ cwd: dir, flags: {}, hooks: NO_HOOKS });
  const data = join(dir, 'exports', 'app-data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'counts.json'), JSON.stringify({ Vendor: 1 }));
  writeFileSync(join(data, 'All_Vendors.csv'), 'ID,Vendor Name\n77,Acme\n');
  const run = async () => {
    const { io } = fakeIo(env);
    return runDoctorChecks({ io, workspace: dir, scope, local: false, sourceCsv: data, cliDc: () => undefined, cliOrg: () => undefined });
  };
  const pass = (await run()).checks.find((c) => c.id === 'D-D3');
  assert.equal(pass?.status, 'pass', JSON.stringify(pass));
  assert.match(pass?.detail ?? '', /data: 1 CSVs, counts\.json ok/);

  // The loader accepts an ID-less CSV (derived ids), so doctor warns, not fails.
  writeFileSync(join(data, 'All_Vendors.csv'), 'Vendor Name\nAcme\n');
  const warn = (await run()).checks.find((c) => c.id === 'D-D3');
  assert.equal(warn?.status, 'warn', JSON.stringify(warn));
  assert.match(warn?.detail ?? '', /has no record ID column/);
  assert.match(warn?.detail ?? '', /derived ids/);
  assert.match(warn?.fix ?? '', /JSON report export/);
});

test('D-D3: a dir holding only JSON report exports passes; an empty dir fails', async () => {
  const { dir, env } = greenWorkspace();
  const scope = resolveScope({ cwd: dir, flags: {}, hooks: NO_HOOKS });
  const data = join(dir, 'exports', 'app-data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'counts.json'), JSON.stringify({ Vendor: 1 }));
  const run = async () => {
    const { io } = fakeIo(env);
    return runDoctorChecks({ io, workspace: dir, scope, local: false, sourceCsv: data, cliDc: () => undefined, cliOrg: () => undefined });
  };

  // The loader reads a --source-csv dir holding JSON report exports as JSON
  // (JSON always carries record ids), so doctor passes it.
  writeFileSync(join(data, 'All_Vendors.json'), JSON.stringify([{ ID: '77', 'Vendor Name': 'Acme' }]));
  const pass = (await run()).checks.find((c) => c.id === 'D-D3');
  assert.equal(pass?.status, 'pass', JSON.stringify(pass));
  assert.match(pass?.detail ?? '', /JSON report exports/);

  rmSync(join(data, 'All_Vendors.json'));
  const fail = (await run()).checks.find((c) => c.id === 'D-D3');
  assert.equal(fail?.status, 'fail', JSON.stringify(fail));
  assert.match(fail?.detail ?? '', /no CSV or JSON exports found/);
  assert.match(fail?.fix ?? '', /JSON \(preferred/);
});

// ---------- D-F5 ----------

function tableOf(name: string, columns: number): SchemaTable {
  const cols = Array.from({ length: columns }, (_, i) => ({ name: `F${i}`, creatorType: 'text', matrixId: 'text', status: 'full', dataType: 'Text' }) as unknown as SchemaColumn);
  return { name, form: name, role: 'form', nosql: false, columns: cols };
}

test('D-F5 passes the column budget for a 111-column table', () => {
  const result = f5TableBudgets([tableOf('New_Deal', 111)]);
  assert.notEqual(result.status, 'fail', result.detail);
  assert.equal(result.status, 'warn');
  assert.match(result.detail, new RegExp(`New_Deal: 111/${limitValue('datastore.columns_per_table')} columns`));
});

test('D-F5 passes at the column cap and fails one over it, naming the table and count', () => {
  const cap = limitValue('datastore.columns_per_table');
  assert.notEqual(f5TableBudgets([tableOf('Wide', cap)]).status, 'fail');
  const over = f5TableBudgets([tableOf('Small', 3), tableOf('Wide', cap + 1)]);
  assert.equal(over.status, 'fail');
  assert.equal(over.detail, `table Wide needs ${cap + 1} columns (max ${cap})`);
  assert.match(over.fix ?? '', /side tables/);
});

test('D-F5 passes a table at or under the stated default', () => {
  const result = f5TableBudgets([tableOf('Plain', limitValue('datastore.columns_per_table_default'))]);
  assert.equal(result.status, 'pass', result.detail);
});

// ---------- error paths and guards ----------

test('doctor.json: a changed dc drops the earlier org/project and the MCP record bound to them', () => {
  const dir = tmp();
  writeDoctorFile(dir, doctorFile());
  writeDoctorFile(dir, doctorFile({ scope: { dc: 'us' }, mcp: undefined }));
  const merged = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  assert.deepEqual(merged.scope, { dc: 'us' });
  assert.equal(merged.mcp, undefined);
  // Re-stating the org and project with the new dc keeps them.
  writeDoctorFile(dir, doctorFile({ scope: { dc: 'eu', org: ORG, project: PROJECT }, mcp: undefined }));
  assert.deepEqual((JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile).scope, { dc: 'eu', org: ORG, project: PROJECT });
});

test('gate: a doctor.json that is not a JSON object is invalid, never green', () => {
  for (const text of ['null', '{not json', '7']) {
    const dir = tmp();
    mkdirSync(join(dir, 'c2c-out', '.c2c'), { recursive: true });
    writeFileSync(doctorJsonPath(dir), text);
    const verdict = evaluateGate({ workspace: dir, scope: SCOPE });
    assert.equal(verdict.status, 'invalid', text);
    assert.equal(verdict.ok, false, text);
  }
});

test('evidence: each scalar field is validated and the error names it', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ host: 7 }, /evidence\.host must be a string/],
    [{ server: 'catalyst by zoho!' }, /plain server name/],
    [{ host_of_url: 'catalystbyzoho_zohomcp.in' }, /host name only/],
    [{ transport: 'ftp' }, /evidence\.transport must be/],
    [{ shape: 'flat' }, /evidence\.shape must be meta or direct/],
    [{ at: 'yesterday' }, /evidence\.at is not a timestamp/],
    [{ features: ['catalyst_datastore', 7] }, /evidence\.features must be a list of strings/],
    [{ tools: 'CatalystbyZoho_List_All_Tables' }, /evidence\.tools must be a list of strings/],
  ];
  for (const [overrides, message] of cases) {
    assert.throws(() => parseEvidence(JSON.stringify(evidence(overrides))), (err) => err instanceof EvidenceRejected && message.test(err.message), JSON.stringify(overrides));
  }
  assert.throws(() => parseEvidence('[]'), /not a JSON object/);
  // Every accepted transport and shape still parses.
  for (const transport of ['http', 'streamable-http', 'sse', 'stdio', 'local']) {
    assert.equal(parseEvidence(JSON.stringify(evidence({ transport }))).transport, transport);
  }
});

test('evidence: a project entry without a decimal id is stale, a non-entry is rejected', () => {
  assert.throws(() => parseEvidence(JSON.stringify(evidence({ projects: [{ project_name: 'my-app' }] }))), (err) => err instanceof EvidenceStale && /no decimal id/.test(err.message));
  assert.throws(() => parseEvidence(JSON.stringify(evidence({ projects: [7] }))), (err) => err instanceof EvidenceRejected && /not an id or an entry/.test(err.message));
});

test('mcp probe: no numeric org/project never calls REST, and a REST failure is unverifiable', async () => {
  let calls = 0;
  const counting = async () => {
    calls++;
    return { status: 200, body: { data: [{ bucket_name: 'c2cprobex' }] } };
  };
  for (const target of [{}, { org: ORG }, { org: 'acme', project: PROJECT }, { org: ORG, project: 'my-app' }]) {
    const result = await verifyProbe(counting, target, 'c2cprobex');
    assert.equal(result.status, 'unresolved', JSON.stringify(target));
  }
  assert.equal(calls, 0);
  const failing = await verifyProbe(
    async () => {
      throw new Error('socket hang up');
    },
    { org: ORG, project: PROJECT },
    'c2cprobex',
  );
  assert.equal(failing.status, 'unverifiable');
  assert.match(failing.detail, /REST read-back failed: socket hang up/);
});

test('vendor: a non-file entry, an unreadable directory or an unreadable listed file is refused', (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads mode-000 files');
  const fifo = vendorDir('none');
  execFileSync('mkfifo', [join(fifo, 'pipe')]);
  assert.match(verifyVendorDir(fifo).error ?? '', /non-file entry: pipe/);

  const locked = vendorDir('none');
  chmodSync(join(locked, 'sub'), 0o000);
  try {
    assert.match(verifyVendorDir(locked).error ?? '', /not readable: sub/);
  } finally {
    chmodSync(join(locked, 'sub'), 0o755);
  }

  const unreadable = vendorDir('none');
  chmodSync(join(unreadable, 'a.js'), 0o000);
  try {
    const verdict = verifyVendorDir(unreadable);
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.mismatched, ['a.js']);
  } finally {
    chmodSync(join(unreadable, 'a.js'), 0o644);
  }
});

test('--verify-vendor: a usage error exits 2 and a manifest error exits 6 naming it', () => {
  const { io, err } = fakeIo({});
  assert.equal(verifyVendorCli([], io), 2);
  assert.equal(verifyVendorCli(['a', 'b', 'c'], io), 2);
  assert.equal(verifyVendorCli([vendorDir('manifest-missing')], io), 6);
  assert.match(err(), /c2c: no readable MANIFEST\.sha256/);
});

test('scope: a malformed deploy config is refused with the reason', () => {
  const cases: [string, RegExp][] = [
    ['{not json', /is not valid JSON/],
    ['["in"]', /is not a JSON object/],
    [JSON.stringify({ dc: 7 }), /"dc" is not a string/],
    [JSON.stringify({ dc: 'in', zohoDc: 'us' }), /sets "dc" in and "zohoDc" us; they must agree/],
    [JSON.stringify({ dc: 'in', never_touch: ['123', 'prod'] }), /"never_touch" ids must be decimal strings/],
    [JSON.stringify({ dc: 'in', never_touch: { prod: 'not-an-id' } }), /"never_touch" ids must be decimal strings/],
  ];
  for (const [text, message] of cases) {
    const dir = tmp();
    writeFileSync(join(dir, DEPLOY_CONFIG), text);
    assert.throws(() => resolveScope({ cwd: dir, flags: {}, hooks: NO_HOOKS }), message, text);
  }
  // Agreeing dc/zohoDc (any case) and both never_touch forms are accepted.
  const dir = tmp();
  writeFileSync(join(dir, DEPLOY_CONFIG), JSON.stringify({ dc: 'in', zohoDc: 'IN', never_touch: { prod: ' 42 production ' } }));
  assert.deepEqual(resolveScope({ cwd: dir, flags: {}, hooks: NO_HOOKS }).neverTouch, ['42 production']);
});
