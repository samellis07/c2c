/**
 * The last accepted MCP evidence is kept in c2c-out/.c2c/mcp-state.json,
 * signed with a per-user key outside the workspace, and reused by later
 * plain doctor runs for the same scope until it expires. A record the doctor
 * did not sign (written, edited or copied) never raises trust.
 * Offline: the observation is fake, the Catalyst CLI and REST are stubbed.
 */
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEPLOY_CONFIG,
  doctorCli,
  doctorJsonPath,
  evaluateGate,
  formatAge,
  loadMcpEvidence,
  MCP_EVIDENCE_MAX_AGE_HOURS,
  mcpCarryRefusal,
  mcpStateKeyPath,
  mcpStatePath,
  type DoctorFile,
  type DoctorIo,
  type ScopeHooks,
  type SpawnResult,
} from '../src/index.js';
import requiredTools from '../data/required-mcp-tools.json' with { type: 'json' };

const ORG = '10000000000';
const PROJECT = '10000000000013200';
const OTHER_PROJECT = '10000000000000001';
const SCOPE = { dc: 'in', org: ORG, project: PROJECT };
const NO_HOOKS: ScopeHooks = { cliDc: () => undefined, cliOrg: () => undefined };
const HOUR = 60 * 60 * 1000;

const dirs: string[] = [];
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const PROJECT_TABLE = `│ ${PROJECT} │ my-app │\n│ ${OTHER_PROJECT} │ other │\n`;

function greenCatalyst(cmd: string, args: string[]): SpawnResult {
  if (cmd !== 'catalyst') return { code: 127, stdout: '', stderr: 'not found' };
  const key = args.join(' ');
  if (key === '--version') return { code: 0, stdout: '1.28.0\n', stderr: '' };
  if (key === 'whoami') return { code: 0, stdout: 'Logged as: user@example.com\n', stderr: '' };
  if (key.endsWith('project:list')) return { code: 0, stdout: PROJECT_TABLE, stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
}

function workspace(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-evidence-state-'));
  // The signing key lives under HOME, which must be outside the workspace.
  const home = mkdtempSync(join(tmpdir(), 'c2c-evidence-home-'));
  dirs.push(dir, home);
  const skills = join(home, 'skills', 'catalyst-by-zoho');
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, 'SKILL.md'), '---\nname: catalyst-by-zoho\ndescription: official\nmetadata:\n  version: "0.0.2"\n---\nbody\n');
  writeFileSync(join(dir, DEPLOY_CONFIG), JSON.stringify({ dc: 'in', org: ORG, project: PROJECT, env: 'Development', ui: 'vanilla' }));
  return { dir, env: { HOME: home, C2C_WORKSPACE: dir, C2C_CATALYST_SKILLS_DIR: join(home, 'skills') } };
}

async function doctor(env: NodeJS.ProcessEnv, args: string[], stdin?: string, laterMs = 0): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io = {
    stdout: (text: string) => {
      out += text;
    },
    stderr: (text: string) => {
      err += text;
    },
    env,
    spawn: async (command: string, a: string[]) => greenCatalyst(command, a),
    rest: async () => ({ status: 404, body: { code: 'INVALID_ID' } }),
    ...(stdin !== undefined ? { stdin: () => stdin } : {}),
  } as DoctorIo;
  const code = await doctorCli(args, io, { hooks: NO_HOOKS, ...(laterMs ? { now: () => new Date(Date.now() + laterMs) } : {}) });
  return { code, out, err };
}

const SCHEMAS = {
  CatalystbyZoho_Create_Table: { path_variables: ['project_id'], body: ['table_name'] },
  CatalystbyZoho_Execute_Query: { path_variables: ['project_id'], body: ['query'] },
};

/** Open a request and answer it with a fake observation (schemas included unless overridden). */
async function observe(env: NodeJS.ProcessEnv, overrides: Record<string, unknown> = {}) {
  const begin = await doctor(env, ['--mcp-begin', '--json']);
  assert.equal(begin.code, 0, begin.err);
  const ask = JSON.parse(begin.out) as { request: string; observation: Record<string, unknown> };
  assert.ok('schemas' in ask.observation, 'the observation template asks for the tool schemas');
  const request = ask.request;
  const body = {
    kind: 'c2c-mcp-observation',
    schema: 1,
    request,
    server: 'catalyst-by-zoho',
    host_of_url: 'catalystbyzoho.zohomcp.in',
    transport: 'http',
    shape: 'direct',
    tools: requiredTools.base.map((name) => `CatalystbyZoho_${name}`),
    schemas: SCHEMAS,
    calls: [
      { tool: 'CatalystbyZoho_Create_Bucket', result: { content: [{ type: 'text', text: JSON.stringify({ data: { bucket_name: `c2cprobe${request}` } }) }] } },
      {
        tool: 'CatalystbyZoho_List_All_Organizations',
        result: { content: [{ type: 'text', text: JSON.stringify({ data: [{ id: ORG, org_name: 'secret-org-name', admin_email: 'admin@example.com' }] }) }] },
      },
    ],
    ...overrides,
  };
  return doctor(env, ['--mcp-observed', '-'], JSON.stringify(body));
}

function line(out: string, id: string): string {
  return out.split('\n').find((l) => /^(PASS|WARN|FAIL|SKIP) /.test(l) && l.slice(5).startsWith(`${id} `)) ?? '';
}

function storedAt(dir: string): string {
  return (JSON.parse(readFileSync(mcpStatePath(dir), 'utf8')) as { evidence: { at: string } }).evidence.at;
}

function editState(dir: string, edit: (state: Record<string, any>) => void): void {
  const state = JSON.parse(readFileSync(mcpStatePath(dir), 'utf8')) as Record<string, any>;
  edit(state);
  writeFileSync(mcpStatePath(dir), JSON.stringify(state));
}

/** The forged record never turns doctor or the gate green. */
async function assertNotCertified(dir: string, env: NodeJS.ProcessEnv, scope: typeof SCOPE, args: string[] = []): Promise<void> {
  assert.notEqual(loadMcpEvidence(dir, scope, { env }).status, 'reused');
  const run = await doctor(env, args);
  assert.doesNotMatch(run.out, /^PASS D-B[12] /m, run.out);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  assert.equal(file.mcpReused, undefined);
  assert.ok(!file.checks.some((c) => c.id.startsWith('D-B') && c.status === 'pass'), 'no D-B row passes');
  assert.equal(evaluateGate({ workspace: dir, scope }).ok, false);
}

test('evidence state: an observed run stores the validated record, ids and names only', async () => {
  const { dir, env } = workspace();
  const run = await observe(env);
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(line(run.out, 'D-B6'), /^PASS D-B6 +schemas recorded \(2\)/);
  const text = readFileSync(mcpStatePath(dir), 'utf8');
  const state = JSON.parse(text) as { scope: unknown; source: string; mac: string; schemaDigest: Record<string, string>; evidence: { host_of_url: string; tools: string[]; orgs: string[] } };
  assert.match(state.mac, /^hmac-sha256:[0-9a-f]{64}$/);
  assert.deepEqual(state.scope, SCOPE);
  assert.equal(state.source, 'observed');
  assert.equal(state.evidence.host_of_url, 'catalystbyzoho.zohomcp.in');
  assert.deepEqual(state.evidence.orgs, [ORG]);
  assert.equal(state.evidence.tools.length, requiredTools.base.length);
  assert.match(state.schemaDigest.CatalystbyZoho_Create_Table ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(text, /admin@|secret-org-name|https?:/);
});

test('evidence state: a later plain run reuses the observation and says how old it is', async () => {
  const { dir, env } = workspace();
  assert.equal((await observe(env)).code, 0);
  const observedAt = storedAt(dir);
  const before = readFileSync(mcpStatePath(dir), 'utf8');
  const run = await doctor(env, [], undefined, 2 * HOUR + 5 * 60 * 1000 + 1000);
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(line(run.out, 'D-B1'), /^PASS D-B1 .*catalystbyzoho\.zohomcp\.in.*observed 2 h 5 min ago .*re-check required after 12 h/);
  assert.match(line(run.out, 'D-B6'), /^PASS D-B6 +schemas recorded \(2\)/);
  assert.match(line(run.out, 'D-B7'), /^PASS D-B7 +MCP org/);
  assert.match(line(run.out, 'D-V2'), /^PASS D-V2/);
  assert.doesNotMatch(run.out, /agent half not recorded/);
  assert.match(run.out, /NOTE MCP evidence observed 2 h 5 min ago/);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  assert.equal(file.mcp?.at, observedAt, 'the mcp block keeps the observed time, never the reuse time');
  assert.equal(file.mcp?.source, 'observed');
  assert.ok(file.mcp?.schemaDigest?.CatalystbyZoho_Execute_Query);
  assert.deepEqual(file.mcpReused, { observedAt, expires: new Date(Date.parse(observedAt) + 12 * HOUR).toISOString() });
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).ok, true);
  // A reuse never refreshes the stored record.
  assert.equal(readFileSync(mcpStatePath(dir), 'utf8'), before);
});

test('evidence state: after the expiry window the record is not reused and a re-check is asked for', async () => {
  const { dir, env } = workspace();
  assert.equal((await observe(env)).code, 0);
  const later = MCP_EVIDENCE_MAX_AGE_HOURS * HOUR + 60 * 1000 + 1000;
  assert.equal(loadMcpEvidence(dir, SCOPE, { env, now: new Date(Date.now() + later) }).status, 'expired');
  const run = await doctor(env, [], undefined, later);
  assert.equal(line(run.out, 'D-B1'), '');
  assert.equal(line(run.out, 'D-B6'), '');
  assert.match(line(run.out, 'D-B'), /^SKIP D-B +MCP evidence observed 12 h 1 min ago has expired; re-check required after 12 h: run c2c doctor --mcp-begin/);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  assert.equal(file.mcpReused, undefined);
});

test('evidence state: a record for another project is never reused', async () => {
  const { env } = workspace();
  assert.equal((await observe(env)).code, 0);
  const run = await doctor(env, ['--project', OTHER_PROJECT]);
  assert.equal(line(run.out, 'D-B1'), '');
  assert.match(line(run.out, 'D-B'), /^SKIP D-B +agent half not recorded yet/);
});

test('evidence state: an edited record is rejected whole, valid-looking or not', async () => {
  for (const edit of [
    (s: { evidence: Record<string, unknown> }) => (s.evidence.host_of_url = 'catalystbyzoho.zohomcp.in/mcp/message?key=1'),
    (s: { evidence: Record<string, unknown> }) => (s.evidence.tools = ['Not_A_Catalyst_Tool']),
    (s: { evidence: Record<string, unknown>; source?: string }) => (s.source = 'trusted'),
    (s: { evidence: Record<string, unknown>; observed?: unknown }) => (s.observed = { request: 'x', orgs: [], calls: [] }),
    // Well-formed edits: still refused, the signature no longer matches.
    (s: { evidence: Record<string, unknown> }) => (s.evidence.tools = [...(s.evidence.tools as string[]), 'CatalystbyZoho_Delete_Table']),
    (s: { schemaDigest?: unknown }) => delete s.schemaDigest,
    (s: { mac?: unknown }) => delete s.mac,
  ]) {
    const { dir, env } = workspace();
    assert.equal((await observe(env)).code, 0);
    editState(dir, edit as (s: Record<string, any>) => void);
    const reuse = loadMcpEvidence(dir, SCOPE, { env });
    assert.equal(reuse.status, 'rejected');
    const run = await doctor(env, []);
    assert.equal(line(run.out, 'D-B1'), '', run.out);
    assert.match(line(run.out, 'D-B'), /^SKIP D-B +stored MCP evidence \(c2c-out\/\.c2c\/mcp-state\.json\) not used: /);
  }
});

test('evidence state: forgery A — an expired record with `at` set back to now is not reused', async () => {
  const { dir, env } = workspace();
  assert.equal((await observe(env)).code, 0);
  // Push the record past the window, then forge its observed time back to now.
  editState(dir, (s) => (s.evidence.at = new Date(Date.now() - MCP_EVIDENCE_MAX_AGE_HOURS * HOUR - 60_000).toISOString()));
  editState(dir, (s) => (s.evidence.at = new Date().toISOString()));
  await assertNotCertified(dir, env, SCOPE);
});

test('evidence state: forgery B — a hand-written stdio record claiming observed + verified certifies nothing', async () => {
  const template = workspace();
  assert.equal((await observe(template.env)).code, 0);
  const stored = JSON.parse(readFileSync(mcpStatePath(template.dir), 'utf8')) as Record<string, any>;
  const request = 'ab'.repeat(16);
  const evidence = { ...stored.evidence, transport: 'stdio', at: new Date().toISOString(), binding: { kind: 'bucket', name: `c2cprobe${request}`, status: 'verified', detail: 'found' } };
  delete evidence.host_of_url;
  const forged = (dir: string, signed: boolean) => ({
    schema: signed ? 2 : 1,
    ...(signed ? { c2c: stored.c2c, workspace: dir, mac: `hmac-sha256:${'0'.repeat(64)}` } : {}),
    scope: SCOPE,
    source: 'observed',
    evidence,
    observed: { request, orgs: [ORG], calls: [] },
  });
  // In a workspace that never observed (no key yet), unsigned and with a made-up signature.
  const fresh = workspace();
  for (const signed of [false, true]) {
    mkdirSync(join(fresh.dir, 'c2c-out', '.c2c'), { recursive: true });
    writeFileSync(mcpStatePath(fresh.dir), JSON.stringify(forged(fresh.dir, signed)));
    await assertNotCertified(fresh.dir, fresh.env, SCOPE);
  }
  // And in one whose user has a key from an earlier real observation.
  const keyed = workspace();
  assert.equal((await observe(keyed.env)).code, 0);
  writeFileSync(mcpStatePath(keyed.dir), JSON.stringify(forged(keyed.dir, true)));
  await assertNotCertified(keyed.dir, keyed.env, SCOPE);
});

test('evidence state: forgery C — an observed record with scope.project rewritten is not reused for that project', async () => {
  const { dir, env } = workspace();
  assert.equal((await observe(env)).code, 0);
  editState(dir, (s) => (s.scope.project = OTHER_PROJECT));
  const other = { ...SCOPE, project: OTHER_PROJECT };
  await assertNotCertified(dir, env, other, ['--project', OTHER_PROJECT]);
});

test('evidence state: a signed record copied into another workspace is rejected', async () => {
  const a = workspace();
  assert.equal((await observe(a.env)).code, 0);
  const b = workspace();
  // Same user and key, different workspace.
  const env = { ...b.env, HOME: a.env.HOME };
  mkdirSync(join(b.dir, 'c2c-out', '.c2c'), { recursive: true });
  cpSync(mcpStatePath(a.dir), mcpStatePath(b.dir));
  const reuse = loadMcpEvidence(b.dir, SCOPE, { env });
  assert.deepEqual(reuse, { status: 'rejected', reason: 'recorded for another workspace' });
});

test('evidence state: the signing key is 0600 outside the workspace; a weak or misplaced key stores and reuses nothing', async () => {
  const { dir, env } = workspace();
  assert.equal((await observe(env)).code, 0);
  const key = mcpStateKeyPath(env);
  assert.ok(!key.startsWith(dir));
  // fs-race-allow: the test inspects the key it just created; nothing else writes it.
  assert.equal(statSync(key).mode & 0o777, 0o600);
  assert.equal(statSync(join(key, '..')).mode & 0o777, 0o700);
  assert.doesNotMatch(readFileSync(mcpStatePath(dir), 'utf8'), new RegExp(readFileSync(key).toString('hex')));
  assert.equal(loadMcpEvidence(dir, SCOPE, { env }).status, 'reused');
  // A key another user can read is refused: nothing is reused.
  chmodSync(key, 0o644);
  assert.deepEqual(loadMcpEvidence(dir, SCOPE, { env }), { status: 'rejected', reason: 'the signing key is readable by other users' });
  chmodSync(key, 0o600);
  // A different key (another user or machine) does not verify the record.
  writeFileSync(key, Buffer.alloc(32, 7));
  assert.equal(loadMcpEvidence(dir, SCOPE, { env }).status, 'rejected');
  // A key directory inside the workspace is never used: the evidence is not stored.
  const inner = workspace();
  const innerEnv = { ...inner.env, HOME: join(inner.dir, 'home') };
  mkdirSync(join(inner.dir, 'home', 'skills'), { recursive: true });
  cpSync(join(inner.env.HOME!, 'skills'), join(inner.dir, 'home', 'skills'), { recursive: true });
  const run = await observe(innerEnv);
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(run.err, /MCP evidence not kept for later runs: the signing key directory is inside the workspace/);
  assert.equal(existsSync(mcpStatePath(inner.dir)), false);
});

test('evidence state: a signing key that is a symlink or a directory is refused, never followed', async () => {
  const { dir, env } = workspace();
  assert.equal((await observe(env)).code, 0);
  const key = mcpStateKeyPath(env);
  assert.equal(loadMcpEvidence(dir, SCOPE, { env }).status, 'reused');
  // The same key bytes behind a symlink: the open does not follow it.
  const real = `${key}.real`;
  renameSync(key, real);
  symlinkSync(real, key);
  assert.deepEqual(loadMcpEvidence(dir, SCOPE, { env }), { status: 'rejected', reason: 'the signing key is not a regular file' });
  rmSync(key);
  mkdirSync(key, { mode: 0o700 });
  assert.deepEqual(loadMcpEvidence(dir, SCOPE, { env }), { status: 'rejected', reason: 'the signing key is not a regular file' });
  rmSync(key, { recursive: true });
  renameSync(real, key);
  assert.equal(loadMcpEvidence(dir, SCOPE, { env }).status, 'reused');
});

test('mcpCarryRefusal: one rule — same version, exact scope, inside the 12 h window', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  const record = { c2c: '1.0.0', scope: SCOPE, at: '2026-01-01T02:00:00.000Z' };
  const wanted = { version: '1.0.0', scope: SCOPE, now };
  assert.equal(mcpCarryRefusal(record, wanted), undefined);
  assert.equal(mcpCarryRefusal({ ...record, c2c: '0.9.0' }, wanted)?.status, 'other-scope');
  assert.equal(mcpCarryRefusal({ ...record, scope: { ...SCOPE, project: OTHER_PROJECT } }, wanted)?.status, 'other-scope');
  assert.equal(mcpCarryRefusal({ ...record, scope: { dc: 'in', org: ORG } }, wanted)?.status, 'other-scope');
  assert.equal(mcpCarryRefusal(record, { ...wanted, scope: { project: PROJECT } })?.status, 'other-scope');
  assert.equal(mcpCarryRefusal({ ...record, at: '2025-12-31T23:59:00.000Z' }, wanted)?.status, 'expired');
  assert.equal(mcpCarryRefusal({ ...record, at: '2026-01-01T12:00:01.000Z' }, wanted)?.status, 'expired');
  assert.equal(mcpCarryRefusal({ ...record, at: 'yesterday' }, wanted)?.status, 'expired');
});

test('evidence state: a --local run and an observation without schemas behave as before', async () => {
  const { dir, env } = workspace();
  // No schemas observed: D-B6 still warns, and the record is stored without digests.
  const run = await observe(env, { schemas: undefined });
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(line(run.out, 'D-B6'), /^WARN D-B6 +no tool schemas recorded/);
  const state = JSON.parse(readFileSync(mcpStatePath(dir), 'utf8')) as Record<string, unknown>;
  assert.equal(state.schemaDigest, undefined);
  // A --local run never writes the state.
  const fresh = workspace();
  await doctor(fresh.env, ['--local', '--quiet']);
  assert.equal(existsSync(mcpStatePath(fresh.dir)), false);
});

test('evidence state: an observed schema keyed by a bad tool name is refused', async () => {
  const { dir, env } = workspace();
  const run = await observe(env, { schemas: { 'bad tool!': { body: ['x'] } } });
  assert.equal(run.code, 1);
  assert.match(run.err, /schemas holds a bad tool name/);
  assert.equal(existsSync(mcpStatePath(dir)), false);
});

test('formatAge renders minutes and hours', () => {
  assert.equal(formatAge(30_000), 'less than a minute');
  assert.equal(formatAge(25 * 60_000), '25 min');
  assert.equal(formatAge(3 * HOUR), '3 h');
  assert.equal(formatAge(3 * HOUR + 5 * 60_000), '3 h 5 min');
  assert.equal(formatAge(-1), 'an unknown time');
});
