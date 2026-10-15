/**
 * The last accepted MCP evidence is kept in c2c-out/.c2c/mcp-state.json and
 * reused by later plain doctor runs for the same scope until it expires.
 * Offline: the observation is fake, the Catalyst CLI and REST are stubbed.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  dirs.push(dir);
  const home = join(dir, 'home');
  const skills = join(home, 'skills', 'catalyst-by-zoho');
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, 'SKILL.md'), '---\nname: catalyst-by-zoho\ndescription: official\nmetadata:\n  version: "0.0.2"\n---\nbody\n');
  writeFileSync(join(dir, DEPLOY_CONFIG), JSON.stringify({ dc: 'in', org: ORG, project: PROJECT, env: 'Development', ui: 'vanilla' }));
  return { dir, env: { HOME: home, C2C_WORKSPACE: dir, C2C_CATALYST_SKILLS_DIR: join(home, 'skills') } };
}

async function doctor(env: NodeJS.ProcessEnv, args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
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
  const code = await doctorCli(args, io, { hooks: NO_HOOKS });
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

/** Move the stored observation time back by `ms`. */
function ageState(dir: string, ms: number): string {
  const path = mcpStatePath(dir);
  const state = JSON.parse(readFileSync(path, 'utf8')) as { evidence: { at: string } };
  state.evidence.at = new Date(Date.parse(state.evidence.at) - ms).toISOString();
  writeFileSync(path, JSON.stringify(state));
  return state.evidence.at;
}

test('evidence state: an observed run stores the validated record, ids and names only', async () => {
  const { dir, env } = workspace();
  const run = await observe(env);
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(line(run.out, 'D-B6'), /^PASS D-B6 +schemas recorded \(2\)/);
  const text = readFileSync(mcpStatePath(dir), 'utf8');
  const state = JSON.parse(text) as { scope: unknown; source: string; schemaDigest: Record<string, string>; evidence: { host_of_url: string; tools: string[]; orgs: string[] } };
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
  const observedAt = ageState(dir, 2 * HOUR + 5 * 60 * 1000);
  const before = readFileSync(mcpStatePath(dir), 'utf8');
  const run = await doctor(env, []);
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
  ageState(dir, MCP_EVIDENCE_MAX_AGE_HOURS * HOUR + 60 * 1000);
  assert.equal(loadMcpEvidence(dir, SCOPE).status, 'expired');
  const run = await doctor(env, []);
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

test('evidence state: a hand-edited record that no longer validates is ignored', async () => {
  for (const edit of [
    (s: { evidence: Record<string, unknown> }) => (s.evidence.host_of_url = 'catalystbyzoho.zohomcp.in/mcp/message?key=1'),
    (s: { evidence: Record<string, unknown> }) => (s.evidence.tools = ['Not_A_Catalyst_Tool']),
    (s: { evidence: Record<string, unknown>; source?: string }) => (s.source = 'trusted'),
    (s: { evidence: Record<string, unknown>; observed?: unknown }) => (s.observed = { request: 'x', orgs: [], calls: [] }),
  ]) {
    const { dir, env } = workspace();
    assert.equal((await observe(env)).code, 0);
    const state = JSON.parse(readFileSync(mcpStatePath(dir), 'utf8')) as { evidence: Record<string, unknown> };
    edit(state);
    writeFileSync(mcpStatePath(dir), JSON.stringify(state));
    assert.equal(loadMcpEvidence(dir, SCOPE).status, 'none');
    const run = await doctor(env, []);
    assert.equal(line(run.out, 'D-B1'), '', run.out);
  }
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
