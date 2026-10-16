/**
 * The plugin's MCP evidence path: `c2c doctor --mcp-begin` opens a one-time
 * request, the agent makes normal Catalyst MCP calls in the user's session,
 * and `c2c doctor --mcp-observed -` records evidence derived from those call
 * results. A supplied evidence file is operator-only (`--record-mcp <file>
 * --operator`) and never the default.
 */
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  beginMcpRequest,
  DEPLOY_CONFIG,
  doctorCli,
  doctorJsonPath,
  evaluateGate,
  gateRefusalMessage,
  isProbeName,
  MCP_RESULT_MAX_BYTES,
  mcpRequestPath,
  mcpStatePath,
  ObservationRejected,
  OBSERVATION_MAX_BYTES,
  probeNameFor,
  probeNameOf,
  readStdinBounded,
  verifyProbe,
  type DoctorFile,
  type DoctorIo,
  type ScopeHooks,
  type SpawnResult,
} from '../src/index.js';
import { carriedMcpRecord } from '../src/gate.js';
import { closeMcpRequest } from '../src/observed.js';
import requiredTools from '../data/required-mcp-tools.json' with { type: 'json' };

const ORG = '10000000000';
const FOREIGN_ORG = '10000000001';
const PROJECT = '10000000000013200';
const SCOPE = { dc: 'in', org: ORG, project: PROJECT };
/** The one probe bucket per project: every run in this scope names the same bucket. */
const PROBE = `c2cprobe-p${PROJECT}`;
/** The observed-flow fields of the doctor.json mcp block. */
type ObservedFile = DoctorFile & {
  mcp?: { source?: string; binding?: { status?: string }; observed?: { request: string; orgs: string[]; calls: { tool: string; digest: string }[] } };
};
const NO_HOOKS: ScopeHooks = { cliDc: () => undefined, cliOrg: () => undefined };

const dirs: string[] = [];
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

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

function workspace(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-observed-'));
  dirs.push(dir);
  // HOME lies outside the workspace: the doctor keeps its MCP state key there
  // and refuses a key directory inside the workspace.
  const home = mkdtempSync(join(tmpdir(), 'c2c-observed-home-'));
  dirs.push(home);
  const skills = join(home, 'skills', 'catalyst-by-zoho');
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, 'SKILL.md'), '---\nname: catalyst-by-zoho\ndescription: official\nmetadata:\n  version: "0.0.2"\n---\nbody\n');
  // These tests cover the vanilla path, so they pin the fallback explicitly
  // instead of following the default UI.
  writeFileSync(join(dir, DEPLOY_CONFIG), JSON.stringify({ dc: 'in', org: ORG, project: PROJECT, env: 'Development', ui: 'vanilla' }));
  return { dir, env: { HOME: home, C2C_WORKSPACE: dir, C2C_CATALYST_SKILLS_DIR: join(home, 'skills') } };
}

function fakeIo(env: NodeJS.ProcessEnv, stdin?: string, rest?: DoctorIo['rest']) {
  let out = '';
  let err = '';
  const io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env,
    spawn: async (command, args) => greenCatalyst(command, args),
    // Default fake REST: the probe bucket was never written server-side.
    rest: rest ?? fakeRest({}),
    ...(stdin !== undefined ? { stdin: () => stdin } : {}),
  } as DoctorIo;
  return { io, out: () => out, err: () => err };
}

/** The specific-bucket route answer recorded in one DC for every bucket, existing or not. */
const INVALID_URL_PATTERN = { status: 404, body: { status: 'failure', data: { message: 'Please check if the URL trying to access is a correct one', error_code: 'INVALID_URL_PATTERN' } } };

/**
 * A fake REST shaped like the recorded live behaviour: the bucket LIST route
 * answers every bucket the project holds (the keys of `buckets`), and the
 * specific-bucket route answers 404 INVALID_URL_PATTERN for any name.
 */
function fakeRest(buckets: Record<string, unknown> = {}, seen?: { path: string }[]): NonNullable<DoctorIo['rest']> {
  return async (call) => {
    seen?.push({ path: call.path });
    if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+\/bucket$/.test(call.path)) {
      return { status: 200, body: { status: 'success', data: Object.keys(buckets).map((bucket_name) => ({ bucket_name, bucket_url: `https://${bucket_name}-development.zohostratus.in` })) } };
    }
    if (call.path.includes('/bucket/')) return INVALID_URL_PATTERN;
    return { status: 404, body: { code: 'INVALID_ID' } };
  };
}

/** A fake REST whose bucket LIST route answers `body` (status 200 unless given). */
function listRest(body: unknown, status = 200): NonNullable<DoctorIo['rest']> {
  return async (call) => (/\/bucket$/.test(call.path) ? { status, body } : INVALID_URL_PATTERN);
}

/** The verbatim Create_Bucket result the MCP session reports (caller-controlled; never trusted). */
function probeResult(name: string): unknown {
  return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', data: { bucket_name: name } }) }] };
}

/** The verbatim List_All_Organizations result as an MCP text content block (admin email included, never kept). */
function orgsResult(ids: string[], consoleHost?: string): unknown {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ status: 'success', data: ids.map((id) => ({ id, org_name: `org-${id}`, admin_email: 'admin@example.com', ...(consoleHost ? { console_url: `https://${consoleHost}/` } : {}) })) }),
      },
    ],
  };
}

function projectsResult(ids: string[]): unknown {
  return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', data: ids.map((id) => ({ id, project_name: 'my-app', client_secret: 'secret-canary' })) }) }] };
}

/** Open a request and return its id from the --json begin output. */
async function begin(env: NodeJS.ProcessEnv): Promise<{ request: string; out: string }> {
  const { io, out } = fakeIo(env);
  assert.equal(await doctorCli(['--mcp-begin', '--json'], io, { hooks: NO_HOOKS }), 0);
  const parsed = JSON.parse(out()) as { request: string };
  return { request: parsed.request, out: out() };
}

function observation(request: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'c2c-mcp-observation',
    schema: 1,
    request,
    host: 'claude-code',
    server: 'catalyst-by-zoho',
    host_of_url: 'catalystbyzoho.zohomcp.in',
    transport: 'http',
    shape: 'meta',
    features: ['catalyst_datastore'],
    tools: [...requiredTools.base.map((name) => `mcp__catalyst-by-zoho__CatalystbyZoho_${name}`), 'ZohoMCP_getFeatures', 'ZohoMCP_executeTool'],
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
    calls: [
      { tool: 'CatalystbyZoho_Create_Bucket', result: probeResult(PROBE) },
      { tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([ORG]) },
    ],
    ...overrides,
  };
}

async function observe(env: NodeJS.ProcessEnv, body: unknown, extra: string[] = [], hooks: ScopeHooks = NO_HOOKS, rest?: DoctorIo['rest']) {
  const { io, out, err } = fakeIo(env, typeof body === 'string' ? body : JSON.stringify(body), rest);
  const code = await doctorCli(['--mcp-observed', '-', ...extra], io, { hooks });
  return { code, out: out(), err: err() };
}

test('mcp-observed: an observed List_All_Organizations result records evidence bound to the call', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const run = await observe(env, observation(request));
  assert.equal(run.code, 0, run.out + run.err);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
  assert.equal(file.mcp?.source, 'observed');
  assert.equal(file.mcp?.host, 'catalystbyzoho.zohomcp.in');
  assert.equal(file.mcp?.server, 'catalyst-by-zoho');
  assert.ok(file.mcp?.tools?.includes('CatalystbyZoho_List_All_Organizations'));
  assert.equal(file.mcp?.observed?.request, request);
  assert.deepEqual(file.mcp?.observed?.orgs, [ORG]);
  assert.deepEqual(file.mcp?.observed?.calls.map((c) => c.tool), ['Create_Bucket', 'List_All_Organizations']);
  assert.match(file.mcp?.observed?.calls[1]?.digest ?? '', /^sha256:[0-9a-f]{64}$/);
  // A hosted record carries the read-back outcome too, but does not need it.
  assert.equal(file.mcp?.binding?.status, 'absent');
  // `at` is stamped by the doctor when it receives the observation.
  assert.ok(Math.abs(Date.now() - Date.parse(file.mcp?.at ?? '')) < 60_000);
  // Projects come from the Catalyst CLI list, never an MCP project tool.
  assert.match(run.out, /PASS D-C4 .*CLI sees org/);
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).ok, true);
  // Nothing from the raw result beyond ids survives.
  assert.doesNotMatch(readFileSync(doctorJsonPath(dir), 'utf8'), /admin@|org-name|org-1000/);
  // The request is single-use.
  assert.ok(!existsSync(join(dir, 'c2c-out', '.c2c', 'mcp-request.json')));
});

test('mcp-observed: stdio is green when the probe write is read back in the selected project', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const probe = PROBE;
  const body = observation(request, {
    host_of_url: undefined,
    transport: 'stdio',
    calls: [
      { tool: 'CatalystbyZoho_Create_Bucket', result: probeResult(probe) },
      { tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([ORG], 'console.zoho.in') },
    ],
  });
  const seen: { path: string }[] = [];
  const run = await observe(env, body, [], NO_HOOKS, fakeRest({ [probe]: { data: [{ bucket_name: probe }] } }, seen));
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(run.out, /PASS D-B1 .*stdio.*bound by the probe write/);
  assert.match(run.out, /PASS D-B2 .*in .*project write probe/);
  // The read-back went to the selected project with the CLI credential.
  assert.equal(seen[0]?.path, `/baas/v1/project/${PROJECT}/bucket`);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
  assert.equal(file.mcp?.binding?.status, 'verified');
  // The cleanup instruction always follows a verified probe.
  assert.match(run.out, new RegExp(`cleanup: remove the probe bucket ${PROBE} .*Delete_Bucket`));
  assert.ok(existsSync(join(dir, 'c2c-out', '.c2c', 'mcp-cleanup.json')));
});

test('mcp-observed: a fabricated stdio observation without the server-side write stays red', async () => {
  for (const transport of ['stdio', 'local']) {
    const { dir, env } = workspace();
    const { request } = await begin(env);
    // Everything a forger controls is plausible: current nonce, matching org
    // id, a console host in the target DC, a success envelope for the write.
    const body = observation(request, {
      host_of_url: undefined,
      transport,
      calls: [
        { tool: 'CatalystbyZoho_Create_Bucket', result: probeResult(PROBE) },
        { tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([ORG], 'console.zoho.in') },
      ],
    });
    // The MCP server never saw the write: the project's REST read-back is empty.
    const run = await observe(env, body, [], NO_HOOKS, fakeRest({}));
    assert.equal(run.code, 1, run.out + run.err);
    assert.match(run.out, /FAIL D-B1 .*not proved bound to this org\/DC\/project/);
    assert.match(run.out, /FAIL D-B2 .*probe write was not read back/);
    const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
    assert.equal(file.mcp?.binding?.status, 'absent');
    assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).ok, false);
  }
});

test('mcp-observed: a fabricated org host or a matching CLI selection never stands in for the probe', async () => {
  const { env } = workspace();
  const { request } = await begin(env);
  const body = observation(request, {
    host_of_url: undefined,
    transport: 'stdio',
    calls: [
      { tool: 'CatalystbyZoho_Create_Bucket', result: probeResult(PROBE) },
      // Caller claims an org host in the target DC; CLI hooks claim the same org/DC.
      { tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([ORG], 'console.zoho.in') },
    ],
  });
  const run = await observe(env, body, [], { cliDc: () => 'in', cliOrg: () => ORG }, fakeRest({}));
  assert.equal(run.code, 1, run.out + run.err);
  assert.match(run.out, /FAIL D-B2 .*probe write was not read back/);
});

test('mcp-observed: a probe that landed under a different org/project is red', async () => {
  const { env } = workspace();
  const { request } = await begin(env);
  const body = observation(request, { host_of_url: undefined, transport: 'stdio' });
  // The write happened — but not where the CLI credential reads: the selected
  // project's read-back names only another request's bucket.
  const seen: { path: string }[] = [];
  const run = await observe(env, body, [], NO_HOOKS, fakeRest({ 'c2cprobeaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {} }, seen));
  assert.equal(run.code, 1, run.out + run.err);
  assert.equal(seen[0]?.path, `/baas/v1/project/${PROJECT}/bucket`);
  assert.match(run.out, /FAIL D-B1 .*not proved bound/);
});

test('mcp-observed: the bucket list must name the exact probe bucket — never a prefix, substring or malformed row', async () => {
  for (const [label, body] of [
    ['different bucket', { data: [{ bucket_name: 'some-other-bucket' }] }],
    ['empty data', { data: [] }],
    ['name prefix', (probe: string) => ({ data: [{ bucket_name: probe.slice(0, -1) }] })],
    ['name superstring', (probe: string) => ({ data: [{ bucket_name: `${probe}x` }, { bucket_name: `x-${probe}` }] })],
    ['row without a name', { data: [{ bucket_url: 'https://x-development.zohostratus.in' }] }],
    ['data not a list', { data: { bucket_name: 'x' } }],
    ['top-level name only', { bucket_name: 'x' }],
    ['missing body', undefined],
    ['malformed JSON', '{not-json'],
  ] as const) {
    const { dir, env } = workspace();
    const { request } = await begin(env);
    const resolved = typeof body === 'function' ? body(PROBE) : body;
    const run = await observe(env, observation(request, { host_of_url: undefined, transport: 'stdio' }), [], NO_HOOKS, listRest(resolved));
    assert.equal(run.code, 1, `${label}: ${run.out}${run.err}`);
    assert.match(run.out, /FAIL D-B2 .*probe write was not read back/);
    const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
    assert.notEqual(file.mcp?.binding?.status, 'verified');
    // A list that was read and lacks the probe proves it absent (nothing to
    // clean up); an unreadable list cannot rule the bucket out.
    const absent = file.mcp?.binding?.status === 'absent';
    assert.equal(existsSync(join(dir, 'c2c-out', '.c2c', 'mcp-cleanup.json')), !absent, `${label}: cleanup tracked unless proved absent`);
  }
});

test('mcp-observed: the probe verifies from the bucket list among other buckets; the specific-bucket 404 INVALID_URL_PATTERN is never consulted', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const probe = PROBE;
  const seen: { path: string }[] = [];
  // The project also holds a console-created bucket and an earlier probe; the
  // specific-bucket route answers 404 INVALID_URL_PATTERN for all of them.
  const run = await observe(
    env,
    observation(request, { host_of_url: undefined, transport: 'stdio' }),
    [],
    NO_HOOKS,
    fakeRest({ 'console-bucket': {}, [probe]: {}, c2cprobeaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {} }, seen),
  );
  assert.equal(run.code, 0, run.out + run.err);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
  assert.equal(file.mcp?.binding?.status, 'verified');
  assert.ok(seen.length > 0 && seen.every((call) => !call.path.includes('/bucket/')), JSON.stringify(seen));
});

test('verifyProbe: a paginated bucket list is followed to the page that holds the probe', async () => {
  const name = 'c2cprobe0123456789abcdef0123456789abcdef';
  const target = { org: ORG, project: PROJECT };
  const pages: Record<string, unknown> = {
    [`/baas/v1/project/${PROJECT}/bucket`]: { data: [{ bucket_name: 'a' }], more_records: true, next_token: 'tok2' },
    [`/baas/v1/project/${PROJECT}/bucket?next_token=tok2`]: { data: [{ bucket_name: 'b' }], more_records: true, next_token: 'tok3' },
    [`/baas/v1/project/${PROJECT}/bucket?next_token=tok3`]: { data: [{ bucket_name: name }], more_records: false },
  };
  const seen: string[] = [];
  const rest = async (call: { path: string }) => {
    seen.push(call.path);
    return call.path in pages ? { status: 200, body: pages[call.path] } : INVALID_URL_PATTERN;
  };
  assert.equal((await verifyProbe(rest, target, name)).status, 'verified');
  assert.equal(seen.length, 3);
  // The probe is on no page: absent only after the last page.
  pages[`/baas/v1/project/${PROJECT}/bucket?next_token=tok3`] = { data: [{ bucket_name: 'c' }] };
  assert.equal((await verifyProbe(rest, target, name)).status, 'absent');
  // More rows announced without a token cannot rule the probe out.
  pages[`/baas/v1/project/${PROJECT}/bucket?next_token=tok3`] = { data: [{ bucket_name: 'c' }], more_records: true };
  assert.equal((await verifyProbe(rest, target, name)).status, 'unverifiable');
  // A repeated token never loops.
  pages[`/baas/v1/project/${PROJECT}/bucket?next_token=tok3`] = { data: [], next_token: 'tok2' };
  assert.equal((await verifyProbe(rest, target, name)).status, 'unverifiable');
  // A list route error is unverifiable, never absent.
  assert.equal((await verifyProbe(async () => INVALID_URL_PATTERN, target, name)).status, 'unverifiable');
});

test('mcp-observed: a failed observation stays red on the next bare doctor run, and the gate says the same', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const run = await observe(env, observation(request, { host_of_url: undefined, transport: 'stdio' }), [], NO_HOOKS, fakeRest({}));
  assert.equal(run.code, 1, run.out + run.err);
  // First pass: the signed record is reused. Second pass: with no signed
  // record left, the failed rows are still carried from doctor.json.
  for (let i = 0; i < 2; i++) {
    if (i === 1) rmSync(mcpStatePath(dir));
    const { io, out } = fakeIo(env);
    const code = await doctorCli([], io, { hooks: NO_HOOKS });
    assert.equal(code, 1, out());
    assert.match(out(), /FAIL D-B1 .*not proved bound/);
    assert.doesNotMatch(out(), /SKIP D-B /);
    if (i === 1) assert.match(out(), /D-B\/D-V: failed rows from the MCP observation recorded at/);
    const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
    assert.equal(file.green, false);
    assert.equal(file.mcp?.binding?.status, 'absent');
    const verdict = evaluateGate({ workspace: dir, scope: SCOPE });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 'red');
    assert.doesNotMatch(gateRefusalMessage(verdict, SCOPE), /last: \S+ green/);
  }
});

test('mcp-observed: a verified observation carries to a bare run, so doctor and the gate both stay green', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const probe = PROBE;
  assert.equal((await observe(env, observation(request, { host_of_url: undefined, transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [probe]: {} }))).code, 0);
  const { io, out } = fakeIo(env);
  assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 0, out());
  assert.match(out(), /PASS D-B1 /);
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).ok, true);
});

/** A verified observation, then doctor.json is left with its PASS D-B1/D-B2 rows. */
async function verifiedRecord(): Promise<{ dir: string; env: NodeJS.ProcessEnv; file: ObservedFile }> {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const probe = PROBE;
  assert.equal((await observe(env, observation(request, { host_of_url: undefined, transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [probe]: {} }))).code, 0);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
  for (const id of ['D-B1', 'D-B2']) assert.equal(file.checks.find((c) => c.id === id)?.status, 'pass', id);
  return { dir, env, file };
}

async function assertNoPassingCarry(dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const { io, out } = fakeIo(env);
  await doctorCli([], io, { hooks: NO_HOOKS });
  assert.doesNotMatch(out(), /PASS D-B[12] /);
  assert.match(out(), /SKIP D-B /);
  const after = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
  // D-B8 is emitted fresh from the live pending-cleanup file, never carried.
  assert.ok(!after.checks.some((c) => c.id.startsWith('D-B') && c.id !== 'D-B8' && c.status !== 'skip'), JSON.stringify(after.checks));
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).ok, false);
}

test('mcp-observed: a doctor.json with PASS D-B rows and no signed record never carries a pass', async () => {
  const { dir, env, file } = await verifiedRecord();
  rmSync(mcpStatePath(dir));
  // Hand-written: the same PASS rows, a fresh observed time, the right scope.
  writeFileSync(doctorJsonPath(dir), JSON.stringify({ ...file, at: new Date().toISOString(), mcp: { ...file.mcp, at: new Date().toISOString() } }));
  assert.equal(carriedMcpRecord({ workspace: dir, scope: SCOPE, env }), undefined);
  await assertNoPassingCarry(dir, env);
});

test('mcp-observed: a doctor.json with PASS D-B rows beside a badly signed record never carries a pass', async () => {
  const { dir, env } = await verifiedRecord();
  const state = JSON.parse(readFileSync(mcpStatePath(dir), 'utf8')) as Record<string, unknown>;
  assert.equal(typeof state.mac, 'string');
  writeFileSync(mcpStatePath(dir), JSON.stringify({ ...state, mac: '0'.repeat(String(state.mac).length) }));
  await assertNoPassingCarry(dir, env);
});

test('mcp-observed: PASS D-B rows dated other than the signed record are not carried', async () => {
  const { dir, env, file } = await verifiedRecord();
  // The signed record verifies, but doctor.json names another observation.
  const other = new Date(Date.parse(file.mcp!.at!) - 1000).toISOString();
  writeFileSync(doctorJsonPath(dir), JSON.stringify({ ...file, mcp: { ...file.mcp, at: other } }));
  assert.equal(carriedMcpRecord({ workspace: dir, scope: SCOPE, env }), undefined);
  // The signed record itself is still honoured on the doctor run.
  const { io, out } = fakeIo(env);
  assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 0, out());
  assert.match(out(), /PASS D-B1 .*reused/);
});

test('mcp-observed: a signed record with the same observed time carries its PASS D-B rows', async () => {
  const { dir, env, file } = await verifiedRecord();
  const carried = carriedMcpRecord({ workspace: dir, scope: SCOPE, env });
  assert.ok(carried);
  assert.equal(carried.signed, true);
  assert.equal(carried.mcp.at, file.mcp!.at);
  for (const id of ['D-B1', 'D-B2']) assert.equal(carried.checks.find((c) => c.id === id)?.status, 'pass', id);
});

test('mcp-observed: a failed record with no signed state still carries its failed rows only', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  assert.equal((await observe(env, observation(request, { host_of_url: undefined, transport: 'stdio' }), [], NO_HOOKS, fakeRest({}))).code, 1);
  rmSync(mcpStatePath(dir));
  const carried = carriedMcpRecord({ workspace: dir, scope: SCOPE, env });
  assert.ok(carried);
  assert.equal(carried.signed, false);
  assert.ok(carried.checks.length > 0);
  assert.ok(carried.checks.every((c) => c.status === 'fail'), JSON.stringify(carried.checks));
  assert.ok(carried.checks.some((c) => c.id === 'D-B1'));
});

test('mcp-observed: a record from another c2c version is not carried to a bare run', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const probe = PROBE;
  assert.equal((await observe(env, observation(request, { host_of_url: undefined, transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [probe]: {} }))).code, 0);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
  writeFileSync(doctorJsonPath(dir), JSON.stringify({ ...file, c2c: '0.0.0' }));
  rmSync(mcpStatePath(dir));
  const { io, out } = fakeIo(env);
  await doctorCli([], io, { hooks: NO_HOOKS });
  assert.match(out(), /SKIP D-B /);
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).ok, false);
});

test('gate: a stored-green file that fails the gate never reports "last: green"', async () => {
  const { dir, env } = workspace();
  // A bare run with no MCP record: no fail rows (doctor green), but D-B is skipped.
  const { io, out } = fakeIo(env);
  assert.equal(await doctorCli([], io, { hooks: NO_HOOKS }), 0, out());
  assert.match(out(), /SKIP D-B /);
  const verdict = evaluateGate({ workspace: dir, scope: SCOPE });
  assert.equal(verdict.status, 'checks');
  const message = gateRefusalMessage(verdict, SCOPE);
  assert.doesNotMatch(message, /last: \S+ green/);
  assert.match(message, /checks failing or incomplete\): required checks not pass\/warn: .*D-B1/);
});

test('mcp-observed: a record for another project or past 12 h is not carried', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  assert.equal((await observe(env, observation(request, { host_of_url: undefined, transport: 'stdio' }), [], NO_HOOKS, fakeRest({}))).code, 1);
  rmSync(mcpStatePath(dir));
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
  writeFileSync(doctorJsonPath(dir), JSON.stringify({ ...file, mcp: { ...file.mcp, at: new Date(Date.now() - 13 * 3600 * 1000).toISOString() } }));
  const { io, out } = fakeIo(env);
  await doctorCli([], io, { hooks: NO_HOOKS });
  assert.match(out(), /SKIP D-B /);
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).ok, false);
  writeFileSync(doctorJsonPath(dir), JSON.stringify({ ...file, mcp: { ...file.mcp, scope: { ...SCOPE, project: '10000000000000002' } } }));
  const again = fakeIo(env);
  await doctorCli([], again.io, { hooks: NO_HOOKS });
  assert.match(again.out(), /SKIP D-B /);
});

test('mcp-observed: cleanup is re-printed while the probe may still exist, and cleared once it is gone', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const probe = PROBE;
  const run = await observe(env, observation(request, { transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [probe]: { data: [{ bucket_name: probe }] } }));
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(run.out, /cleanup: remove the probe bucket/);
  assert.match(run.out, /Delete_Bucket/);
  // The pending record survives: the next --mcp-begin re-prints the delete call.
  const reb = await begin(env);
  assert.match(reb.out, /pendingCleanup|cleanup still pending/);
  // Once the session ran Delete_Bucket, the next read-back shows it gone and the record clears.
  const second = await observe(env, observation(reb.request), [], NO_HOOKS, fakeRest({}));
  assert.equal(second.code, 0, second.out + second.err);
  assert.ok(!existsSync(join(dir, 'c2c-out', '.c2c', 'mcp-cleanup.json')));
  assert.doesNotMatch(second.out, /cleanup still pending/);
});

test('mcp-observed: an observation may report the Delete_Bucket cleanup call', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const probe = PROBE;
  const run = await observe(
    env,
    observation(request, {
      calls: [
        { tool: 'CatalystbyZoho_Create_Bucket', result: probeResult(probe) },
        { tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([ORG]) },
        { tool: 'CatalystbyZoho_Delete_Bucket', result: { content: [{ type: 'text', text: JSON.stringify({ status: 'success' }) }] } },
      ],
    }),
    [],
    NO_HOOKS,
    fakeRest({ [probe]: { data: [{ bucket_name: probe }] } }),
  );
  assert.equal(run.code, 0, run.out + run.err);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
  assert.deepEqual(file.mcp?.observed?.calls.map((c) => c.tool), ['Create_Bucket', 'List_All_Organizations', 'Delete_Bucket']);
});

test('mcp-observed: cleanup owed warns on D-B8 without downgrading D-B1/D-B2', async () => {
  const { dir, env } = workspace();
  const first = await begin(env);
  assert.equal((JSON.parse(first.out) as { probe: string }).probe, PROBE);
  const run = await observe(env, observation(first.request, { host_of_url: undefined, transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [PROBE]: {} }));
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(run.out, /PASS D-B1 .*bound by the probe write/);
  assert.match(run.out, /PASS D-B2/);
  assert.match(run.out, new RegExp(`WARN D-B8 .*${PROBE}`));
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  assert.equal(file.checks.find((c) => c.id === 'D-B8')?.status, 'warn');
  // A repeated run reuses the same bucket: the warning names the same name,
  // and the pending file holds exactly one record — never a second bucket.
  const next = await begin(env);
  assert.equal((JSON.parse(next.out) as { probe: string }).probe, PROBE);
  const run2 = await observe(env, observation(next.request, { host_of_url: undefined, transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [PROBE]: {} }));
  assert.equal(run2.code, 0, run2.out + run2.err);
  assert.match(run2.out, new RegExp(`WARN D-B8 .*${PROBE}`));
  const tracked = JSON.parse(readFileSync(join(dir, 'c2c-out', '.c2c', 'mcp-cleanup.json'), 'utf8')) as { name: string }[];
  assert.deepEqual(tracked.map((p) => p.name), [PROBE]);
  // No pending cleanup at all: D-B8 reports pass, never a leftover warning.
  const third = await begin(env);
  const seen: { path: string }[] = [];
  const run3 = await observe(env, observation(third.request), [], NO_HOOKS, fakeRest({}, seen));
  assert.equal(run3.code, 0, run3.out + run3.err);
  assert.match(run3.out, /PASS D-B8/);
  assert.doesNotMatch(run3.out, /WARN D-B8/);
});

test('mcp-observed: a bucket the probe did not create is never targeted for cleanup', async () => {
  const { dir, env } = workspace();
  const cleanupDir = join(dir, 'c2c-out', '.c2c');
  mkdirSync(cleanupDir, { recursive: true });
  writeFileSync(
    join(cleanupDir, 'mcp-cleanup.json'),
    JSON.stringify([
      { name: 'customer-data', org: ORG, project: PROJECT, at: new Date().toISOString() },
      { name: 'c2cprobe-not-hex', org: ORG, project: PROJECT, at: new Date().toISOString() },
    ]),
  );
  const { out } = await begin(env);
  assert.doesNotMatch(out, /customer-data/);
  // The probe-prefix record is still owed: only `c2cprobe*` names are tracked.
  assert.match(out, /c2cprobe-not-hex/);
});

test('mcp-observed: a repeated run creates no second bucket — one record, one reminder, one clear', async () => {
  const { dir, env } = workspace();
  const cleanupFile = join(dir, 'c2c-out', '.c2c', 'mcp-cleanup.json');
  // First probe verified server-side, but the session never ran its delete.
  const first = await begin(env);
  const run1 = await observe(env, observation(first.request, { transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [PROBE]: { data: [{ bucket_name: PROBE }] } }));
  assert.equal(run1.code, 0, run1.out + run1.err);
  // The second begin still reminds about the same bucket, and the second
  // verified probe REFRESHES the single record instead of appending a
  // second bucket.
  const second = await begin(env);
  assert.equal((JSON.parse(second.out) as { probe: string }).probe, PROBE);
  assert.match(second.out, new RegExp(PROBE));
  const run2 = await observe(env, observation(second.request, { transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [PROBE]: { data: [{ bucket_name: PROBE }] } }));
  assert.equal(run2.code, 0, run2.out + run2.err);
  const tracked = JSON.parse(readFileSync(cleanupFile, 'utf8')) as { name: string }[];
  assert.deepEqual(tracked.map((p) => p.name), [PROBE]);
  assert.match(run2.out, new RegExp(`cleanup: remove the probe bucket ${PROBE}`));
  // Once the bucket reads back absent, the record clears.
  const third = await begin(env);
  const run3 = await observe(env, observation(third.request, { transport: 'stdio' }), [], NO_HOOKS, fakeRest({}));
  assert.equal(run3.code, 1);
  assert.ok(!existsSync(cleanupFile));
  assert.doesNotMatch(run3.out, /cleanup: remove the probe bucket|cleanup still pending/);
});

test('mcp-observed: a legacy random probe stays tracked beside the shared bucket until it reads back absent', async () => {
  const { dir, env } = workspace();
  const cleanupFile = join(dir, 'c2c-out', '.c2c', 'mcp-cleanup.json');
  const legacy = `c2cprobe${'b'.repeat(32)}`;
  const first = await begin(env);
  assert.equal((await observe(env, observation(first.request, { transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [PROBE]: { data: [{ bucket_name: PROBE }] } }))).code, 0);
  // An older build left one random bucket behind; it is appended beside the
  // single shared-bucket record.
  const tracked1 = JSON.parse(readFileSync(cleanupFile, 'utf8')) as { name: string }[];
  writeFileSync(cleanupFile, JSON.stringify([...tracked1, { name: legacy, org: ORG, project: PROJECT, at: new Date().toISOString() }]));
  // While both buckets exist, both reminders print.
  const second = await begin(env);
  const run2 = await observe(env, observation(second.request, { transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [PROBE]: { data: [{ bucket_name: PROBE }] }, [legacy]: { data: [{ bucket_name: legacy }] } }));
  assert.equal(run2.code, 0, run2.out + run2.err);
  const tracked2 = JSON.parse(readFileSync(cleanupFile, 'utf8')) as { name: string }[];
  assert.deepEqual(tracked2.map((p) => p.name).sort(), [PROBE, legacy].sort());
  assert.match(run2.out, new RegExp(`cleanup: remove the probe bucket ${PROBE}`));
  assert.match(run2.out, new RegExp(`cleanup: remove the probe bucket ${legacy}`));
  // The session deleted only the legacy bucket: its entry drops, the shared one stays.
  const third = await begin(env);
  const run3 = await observe(env, observation(third.request, { transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [PROBE]: { data: [{ bucket_name: PROBE }] } }));
  assert.equal(run3.code, 0, run3.out + run3.err);
  const tracked3 = JSON.parse(readFileSync(cleanupFile, 'utf8')) as { name: string }[];
  assert.deepEqual(tracked3.map((p) => p.name), [PROBE]);
  assert.match(run3.out, new RegExp(`cleanup: remove the probe bucket ${PROBE}`));
  assert.doesNotMatch(run3.out, new RegExp(`cleanup: remove the probe bucket ${legacy}`));
});

test('mcp-observed: owed cleanup warns D-B8 on a bare run, with the exact bucket and delete call in both outputs', async () => {
  const { env } = workspace();
  const { request } = await begin(env);
  const run = await observe(env, observation(request, { host_of_url: undefined, transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [PROBE]: {} }));
  assert.equal(run.code, 0, run.out + run.err);
  // A later bare run — no new evidence — still warns and re-prints the exact
  // delete call, so the owed cleanup always reaches the user.
  const bare = fakeIo(env);
  assert.equal(await doctorCli([], bare.io, { hooks: NO_HOOKS }), 0, bare.out());
  assert.match(bare.out(), new RegExp(`WARN D-B8 .*${PROBE}`));
  assert.match(bare.out(), new RegExp(`cleanup: remove the probe bucket ${PROBE} .*Delete_Bucket.*"bucket_name":"${PROBE}"`));
  // The JSON body carries the same instruction for machine consumers (the
  // human cleanup line follows the JSON document on the same stream).
  const json = fakeIo(env);
  assert.equal(await doctorCli(['--json'], json.io, { hooks: NO_HOOKS }), 0, json.err());
  assert.match(json.out(), new RegExp(`cleanup: remove the probe bucket ${PROBE} .*Delete_Bucket`));
  const bodyText = json.out().includes('\ncleanup:') ? json.out().slice(0, json.out().indexOf('\ncleanup:')) : json.out();
  const body = JSON.parse(bodyText) as { checks: { id: string; status: string; detail: string }[]; pendingCleanup: { tool: string; query_params: { bucket_name: string } }[] };
  assert.equal(body.checks.find((c) => c.id === 'D-B8')?.status, 'warn');
  assert.match(body.checks.find((c) => c.id === 'D-B8')?.detail ?? '', new RegExp(PROBE));
  assert.equal(body.pendingCleanup[0]?.tool, 'CatalystbyZoho_Delete_Bucket');
  assert.equal(body.pendingCleanup[0]?.query_params.bucket_name, PROBE);
});

test('mcp-observed: an already-exists probe create is accepted; any other probe error is still refused', async () => {
  const alreadyExists = (name: string): unknown => ({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ status: 'failure', data: { message: `Bucket ${name} already exists`, error_code: 'BUCKET_ALREADY_EXISTS' } }) }],
  });
  const { env } = workspace();
  const { request } = await begin(env);
  // A repeated run re-creates the one bucket per project: the duplicate
  // answer is accepted and the REST read-back still attests the write.
  const run = await observe(
    env,
    observation(request, {
      host_of_url: undefined,
      transport: 'stdio',
      calls: [
        { tool: 'CatalystbyZoho_Create_Bucket', result: alreadyExists(PROBE) },
        { tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([ORG], 'console.zoho.in') },
      ],
    }),
    [],
    NO_HOOKS,
    fakeRest({ [PROBE]: {} }),
  );
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(run.out, /PASS D-B1 .*bound by the probe write/);
  // Any other probe error is still refused before anything is written.
  for (const result of [
    { isError: true, content: [{ type: 'text', text: 'denied' }] },
    { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'failure', error_code: 'OAUTH_SCOPE_MISMATCH' }) }] },
  ]) {
    const retry = workspace();
    const opened = await begin(retry.env);
    const refused = await observe(
      retry.env,
      observation(opened.request, {
        calls: [
          { tool: 'CatalystbyZoho_Create_Bucket', result },
          { tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([ORG]) },
        ],
      }),
    );
    assert.equal(refused.code, 1, refused.out + refused.err);
    assert.match(refused.err, /returned an error/);
  }
});

test('mcp-observed: the observation reads back the bucket --mcp-begin named, even if the scope flags drifted', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  // The scope flags drift after begin: the config now names another project.
  const other = '10000000000000001';
  writeFileSync(join(dir, DEPLOY_CONFIG), JSON.stringify({ dc: 'in', org: ORG, project: other, env: 'Development', ui: 'vanilla' }));
  // Only the begin-time project holds the bucket; the drifted project is empty.
  const seen: { path: string }[] = [];
  const rest: NonNullable<DoctorIo['rest']> = async (call) => {
    seen.push({ path: call.path });
    if (call.path === `/baas/v1/project/${PROJECT}/bucket`) {
      return { status: 200, body: { status: 'success', data: [{ bucket_name: PROBE, bucket_url: 'https://x-development.zohostratus.in' }] } };
    }
    return { status: 200, body: { status: 'success', data: [] } };
  };
  const run = await observe(env, observation(request, { host_of_url: undefined, transport: 'stdio' }), [], NO_HOOKS, rest);
  // Fail closed: the read-back goes to the currently selected project, where
  // the bucket is absent — and no phantom record for the drifted scope's
  // bucket (which was never created) is tracked.
  assert.equal(run.code, 1, run.out + run.err);
  assert.equal(seen[0]?.path, `/baas/v1/project/${other}/bucket`);
  assert.match(run.out, /FAIL D-B1 .*not proved bound/);
  assert.doesNotMatch(run.out, new RegExp(`c2cprobe-p${other}`));
  const cleanupFile = join(dir, 'c2c-out', '.c2c', 'mcp-cleanup.json');
  if (existsSync(cleanupFile)) {
    assert.doesNotMatch(readFileSync(cleanupFile, 'utf8'), new RegExp(`c2cprobe-p${other}`));
  }
});

test('probe names: one deterministic bucket per project or org, legacy fallback otherwise', () => {
  assert.equal(probeNameFor({ project: PROJECT }), PROBE);
  assert.equal(probeNameFor({ org: ORG, project: PROJECT }), PROBE);
  assert.equal(probeNameFor({ org: ORG }), `c2cprobe-o${ORG}`);
  assert.equal(probeNameFor({}), undefined);
  assert.equal(probeNameFor({ org: 'acme', project: 'my-app' }), undefined);
  assert.equal(probeNameOf('a1'.repeat(16), { project: PROJECT }), PROBE);
  assert.equal(probeNameOf('a1'.repeat(16)), `c2cprobe${'a1'.repeat(16)}`);
  assert.ok(isProbeName(PROBE));
  assert.ok(isProbeName(`c2cprobe-o${ORG}`));
  assert.ok(isProbeName(`c2cprobe${'a1'.repeat(16)}`));
  assert.ok(!isProbeName('customer-data'));
  assert.ok(!isProbeName('c2cprobe-not-hex'));
  assert.ok(!isProbeName(`${PROBE}x`));
});

test('mcp-observed: a verified probe without a project tracks no pending cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-observed-'));
  dirs.push(dir);
  const home = mkdtempSync(join(tmpdir(), 'c2c-observed-home-'));
  dirs.push(home);
  const skills = join(home, 'skills', 'catalyst-by-zoho');
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, 'SKILL.md'), '---\nname: catalyst-by-zoho\ndescription: official\nmetadata:\n  version: "0.0.2"\n---\nbody\n');
  // Org-scoped: the project does not exist yet, so there is no project to
  // create the probe bucket in — and no actionable delete target either.
  writeFileSync(join(dir, DEPLOY_CONFIG), JSON.stringify({ dc: 'in', org: ORG, env: 'Development', ui: 'vanilla' }));
  const env = { HOME: home, C2C_WORKSPACE: dir, C2C_CATALYST_SKILLS_DIR: join(home, 'skills') };
  const opened = await begin(env);
  assert.equal((JSON.parse(opened.out) as { probe: string }).probe, `c2cprobe-o${ORG}`);
  // The org project-list read proves the binding is reachable.
  const rest: NonNullable<DoctorIo['rest']> = async (call) => {
    if (call.method === 'GET' && call.path === '/baas/v1/project') {
      return { status: 200, body: { status: 'success', data: [{ id: PROJECT }] } };
    }
    return { status: 404, body: { code: 'INVALID_ID' } };
  };
  const run = await observe(env, observation(opened.request), [], NO_HOOKS, rest);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
  assert.equal(file.mcp?.binding?.detail, 'in-project-probe-required');
  // Nothing provable was created inside a project: no pending record, and
  // D-B8 passes instead of warning forever about an unactionable bucket.
  assert.ok(!existsSync(join(dir, 'c2c-out', '.c2c', 'mcp-cleanup.json')));
  assert.match(run.out, /PASS D-B8/);
});

test('mcp-observed: an unreadable read-back keeps stdio red and still asks for cleanup', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const rest = async () => ({ status: 500, body: { message: 'upstream' } });
  const run = await observe(env, observation(request, { transport: 'stdio' }), [], NO_HOOKS, rest);
  assert.equal(run.code, 1, run.out + run.err);
  assert.match(run.out, /FAIL D-B1 .*not proved bound/);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
  assert.equal(file.mcp?.binding?.status, 'unverifiable');
  // The write may have landed anyway, so the delete instruction stays up.
  assert.match(run.out, /cleanup: remove the probe bucket/);
  assert.ok(existsSync(join(dir, 'c2c-out', '.c2c', 'mcp-cleanup.json')));
});

test('mcp-observed: operator-supplied stdio evidence is not accepted as an observation', async () => {
  const { env } = workspace();
  const path = join(env.C2C_WORKSPACE!, 'operator-mcp.json');
  writeFileSync(path, JSON.stringify({ server: 'catalyst-by-zoho', transport: 'stdio', orgs: [ORG], orgDcs: { [ORG]: 'in' }, tools: ['CatalystbyZoho_List_All_Organizations'] }));
  const { io, out } = fakeIo(env);
  const code = await doctorCli(['--record-mcp', path, '--operator'], io, { hooks: NO_HOOKS });
  assert.equal(code, 1);
  assert.match(out(), /FAIL D-B1 .*must come from an observed live tool call/);
});

test('mcp-observed: an MCP project tool call is refused before any write — its secrets never reach disk', async () => {
  for (const tool of ['CatalystbyZoho_List_All_Projects', 'CatalystbyZoho_Get_Project_By_Id']) {
    const { dir, env } = workspace();
    const { request } = await begin(env);
    const calls = [
      { tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([ORG]) },
      { tool, result: projectsResult([PROJECT]) },
    ];
    const run = await observe(env, observation(request, { calls }));
    assert.equal(run.code, 1, run.out + run.err);
    assert.match(run.err, /never calls the MCP project tools/);
    assert.doesNotMatch(run.out + run.err, /secret-canary/);
    assert.ok(!existsSync(doctorJsonPath(dir)), 'a refused observation must not write doctor.json');
  }
});

test('mcp-observed: --mcp-begin asks for the probe write and the org list, and names the project tools as never-call', async () => {
  const { env } = workspace();
  const { io, out } = fakeIo(env, '');
  assert.equal(await doctorCli(['--mcp-begin', '--json'], io, { hooks: NO_HOOKS }), 0);
  const ask = JSON.parse(out()) as { probe: string; request: string; calls: Record<string, unknown>[]; cleanup: Record<string, unknown>; neverCall: string[] };
  // One deterministic bucket per project: the request id stays a single-use
  // nonce, but the bucket no longer follows it.
  assert.equal(ask.probe, PROBE);
  assert.doesNotMatch(ask.probe, new RegExp(ask.request));
  assert.equal(ask.calls.length, 2);
  const create = ask.calls[0] as { tool: string; path_variables: { projectId: string }; headers: Record<string, unknown>; body: { bucket_name: string } };
  assert.equal(create.tool, 'CatalystbyZoho_Create_Bucket');
  assert.equal(create.body.bucket_name, ask.probe);
  assert.equal(create.path_variables.projectId, PROJECT);
  assert.equal(create.headers['Catalyst-org'], Number(ORG));
  assert.deepEqual(ask.calls[1], { tool: 'CatalystbyZoho_List_All_Organizations' });
  assert.equal((ask.cleanup as { tool: string }).tool, 'CatalystbyZoho_Delete_Bucket');
  assert.deepEqual(ask.neverCall, ['CatalystbyZoho_List_All_Projects', 'CatalystbyZoho_Get_Project_By_Id']);
  const human = fakeIo(env, '');
  assert.equal(await doctorCli(['--mcp-begin'], human.io, { hooks: NO_HOOKS }), 0);
  assert.match(human.out(), /Never call CatalystbyZoho_List_All_Projects or CatalystbyZoho_Get_Project_By_Id/);
  assert.match(human.out(), /Delete_Bucket/);
});

test('mcp-observed: a foreign-org result fails D-B7 and the gate', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const run = await observe(env, observation(request, { calls: [
    { tool: 'CatalystbyZoho_Create_Bucket', result: probeResult(PROBE) },
    { tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([FOREIGN_ORG]) },
  ] }));
  assert.equal(run.code, 1);
  assert.match(run.out, /FAIL D-B7/);
  assert.equal(evaluateGate({ workspace: dir, scope: SCOPE }).ok, false);
});

test('mcp-observed: a tampered observation is rejected before any write', async () => {
  for (const tamper of [
    // A caller-written org list beside a result that names another org.
    (request: string) => observation(request, { orgs: [ORG], calls: [{ tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([FOREIGN_ORG]) }] }),
    // A caller-written timestamp or workspace: the doctor stamps both itself.
    (request: string) => observation(request, { at: new Date().toISOString() }),
    (request: string) => observation(request, { workspace: '/elsewhere' }),
    // A request id this workspace never issued.
    () => observation('0'.repeat(32)),
    // No List_All_Organizations call at all.
    (request: string) => observation(request, { calls: [] }),
    // The call returned an error.
    (request: string) => observation(request, { calls: [{ tool: 'CatalystbyZoho_List_All_Organizations', result: { isError: true, content: [{ type: 'text', text: 'denied' }] } }] }),
  ]) {
    const { dir, env } = workspace();
    const { request } = await begin(env);
    const run = await observe(env, tamper(request));
    assert.equal(run.code, 1, run.out + run.err);
    assert.match(run.err, /observation rejected|stale\/incomplete/);
    assert.ok(!existsSync(doctorJsonPath(dir)), 'a rejected observation must not write doctor.json');
  }
});

test('mcp-observed: a replayed observation is rejected once its request was used', async () => {
  const { env } = workspace();
  const { request } = await begin(env);
  const body = observation(request);
  assert.equal((await observe(env, body)).code, 0);
  const replay = await observe(env, body);
  assert.equal(replay.code, 1);
  assert.match(replay.err, /no open MCP request/);
});

test('mcp-observed: a stale request fails as stale/incomplete', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const path = join(dir, 'c2c-out', '.c2c', 'mcp-request.json');
  const open = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...open, at: new Date(Date.now() - 20 * 60 * 1000).toISOString() }));
  const run = await observe(env, observation(request));
  assert.equal(run.code, 1);
  assert.match(run.err, /MCP evidence is stale\/incomplete: .*re-record/);
  assert.ok(!existsSync(doctorJsonPath(dir)));
});

test('mcp-observed: an old-schema observation or a legacy evidence file is rejected', async () => {
  for (const make of [
    (request: string) => observation(request, { schema: 0 }),
    (request: string) => ({ ...observation(request), kind: undefined }),
    // The legacy free-standing evidence shape.
    () => ({ server: 'catalyst-by-zoho', host_of_url: 'catalystbyzoho.zohomcp.in', orgs: [ORG], at: new Date().toISOString() }),
  ]) {
    const { dir, env } = workspace();
    const { request } = await begin(env);
    const run = await observe(env, make(request));
    assert.equal(run.code, 1, run.out + run.err);
    assert.match(run.err, /observation rejected: .*schema/);
    assert.ok(!existsSync(doctorJsonPath(dir)));
  }
});

test('plugin default path never asks for a file: --mcp-begin names the calls and stdin; --record-mcp is operator-only', async () => {
  const { dir, env } = workspace();
  const { out } = await begin(env);
  const parsed = JSON.parse(out) as { calls: { tool?: string }[]; command: string };
  assert.ok(parsed.calls.some((call) => call.tool === 'CatalystbyZoho_List_All_Organizations'));
  assert.match(parsed.command, /c2c doctor --mcp-observed -/);
  assert.doesNotMatch(out, /record-mcp|evidence\.json|--operator/);
  // Human output says the same.
  const human = fakeIo(env);
  assert.equal(await doctorCli(['--mcp-begin'], human.io, { hooks: NO_HOOKS }), 0);
  assert.match(human.out(), /--mcp-observed -/);
  assert.doesNotMatch(human.out(), /record-mcp|evidence\.json/);
  // A doctor run with no evidence points at the observed flow, not a file.
  const plain = fakeIo(env);
  await doctorCli([], plain.io, { hooks: NO_HOOKS });
  assert.match(plain.out(), /--mcp-begin/);
  assert.doesNotMatch(plain.out(), /record-mcp/);
  // A supplied file without --operator is refused (usage), naming the default flow.
  const path = join(dir, 'evidence.json');
  writeFileSync(path, JSON.stringify({ server: 'catalyst-by-zoho' }));
  const supplied = fakeIo(env);
  assert.equal(await doctorCli(['--record-mcp', path], supplied.io, { hooks: NO_HOOKS }), 2);
  assert.match(supplied.err(), /operator-only/);
  assert.match(supplied.err(), /--mcp-begin/);
});

test('mcp-observed: an isError envelope carried as JSON text is still a refused error', async () => {
  const envelopes = [
    // The error envelope double-encoded inside a text content block.
    { content: [{ type: 'text', text: JSON.stringify({ isError: true, data: [{ id: ORG }] }) }] },
    // The whole result as a JSON string naming isError.
    JSON.stringify({ isError: true, data: [{ id: ORG }] }),
    // One layer deeper: structuredContent carrying the text envelope.
    { structuredContent: { content: [{ type: 'text', text: JSON.stringify({ isError: true, data: [{ id: ORG }] }) }] } },
  ];
  for (const result of envelopes) {
    const { dir, env } = workspace();
    const { request } = await begin(env);
    const run = await observe(env, observation(request, { calls: [{ tool: 'CatalystbyZoho_List_All_Organizations', result }] }));
    assert.equal(run.code, 1, run.out + run.err);
    assert.match(run.err, /returned an error/);
    assert.ok(!existsSync(doctorJsonPath(dir)), 'a refused observation must not write doctor.json');
  }
});

test('mcp-observed: an isError flag in a later text block, a bare array or a data list is still a refused error', async () => {
  const flagged = [
    // The error envelope rides in the second of two text blocks.
    { content: [{ type: 'text', text: JSON.stringify({ id: ORG }) }, { type: 'text', text: JSON.stringify({ isError: true, id: ORG }) }] },
    // The whole result is a bare array holding an error entry.
    [{ id: ORG }, { isError: true, id: ORG }],
    // An error entry inside a data-style list.
    { data: [{ id: ORG }, { isError: true, id: ORG }] },
  ];
  for (const result of flagged) {
    const { dir, env } = workspace();
    const { request } = await begin(env);
    const run = await observe(env, observation(request, { calls: [{ tool: 'CatalystbyZoho_List_All_Organizations', result }] }));
    assert.equal(run.code, 1, run.out + run.err);
    assert.match(run.err, /returned an error/);
    assert.ok(!existsSync(doctorJsonPath(dir)), 'a refused observation must not write doctor.json');
  }
});

test('mcp-observed: an isError "true" string is still a refused error', async () => {
  const flagged = [
    { isError: 'true', data: [{ id: ORG }] },
    { content: [{ type: 'text', text: JSON.stringify({ isError: 'true', data: [{ id: ORG }] }) }] },
  ];
  for (const result of flagged) {
    const { dir, env } = workspace();
    const { request } = await begin(env);
    const run = await observe(env, observation(request, { calls: [{ tool: 'CatalystbyZoho_List_All_Organizations', result }] }));
    assert.equal(run.code, 1, run.out + run.err);
    assert.match(run.err, /returned an error/);
    assert.ok(!existsSync(doctorJsonPath(dir)), 'a refused observation must not write doctor.json');
  }
});

test('mcp-observed: nesting beyond the schema cap is refused', async () => {
  const nest = (depth: number, value: unknown) => {
    let result = value;
    for (let i = 0; i < depth; i++) {
      result = { nested: result };
    }
    return result;
  };
  const flagged = [
    { data: [{ id: ORG }], meta: nest(14, { isError: true }) },
    { data: [{ id: ORG }], meta: nest(40, 1) },
  ];
  for (const result of flagged) {
    const { dir, env } = workspace();
    const { request } = await begin(env);
    const run = await observe(env, observation(request, { calls: [{ tool: 'CatalystbyZoho_List_All_Organizations', result }] }));
    assert.equal(run.code, 1, run.out + run.err);
    assert.match(run.err, /nests deeper/);
    assert.ok(!existsSync(doctorJsonPath(dir)), 'a refused observation must not write doctor.json');
  }
});

test('doctor --record-mcp with no file value is a usage error, not a silent plain run', async () => {
  const { env } = workspace();
  for (const args of [['--record-mcp'], ['--record-mcp', '--operator'], ['--record-mcp', '--json']]) {
    const { io, err } = fakeIo(env);
    const code = await doctorCli(args, io, { hooks: NO_HOOKS });
    assert.equal(code, 2, `args ${args.join(' ')}`);
    assert.match(err(), /--record-mcp needs an evidence file/);
  }
});

test('mcp-observed --local persists nothing and leaves the request open for the run that records it', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const local = await observe(env, observation(request), ['--local']);
  assert.notEqual(local.code, 2, local.out + local.err);
  assert.ok(!existsSync(doctorJsonPath(dir)), '--local must not write doctor.json');
  assert.ok(existsSync(join(dir, 'c2c-out', '.c2c', 'mcp-request.json')), '--local must not consume the one-time request');
  // The same request can still be answered by the run that persists.
  const run = await observe(env, observation(request));
  assert.equal(run.code, 0, run.out + run.err);
  assert.ok(existsSync(doctorJsonPath(dir)));
});

test('mcp-observed: a request id stays single-use when a stale open file survives the close', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const body = observation(request);
  assert.equal((await observe(env, body)).code, 0);
  // The loser of a validate/close race already read the open file; recreate
  // exactly what it read. The closed marker must still refuse the claim.
  const path = join(dir, 'c2c-out', '.c2c', 'mcp-request.json');
  writeFileSync(path, JSON.stringify({ schema: 1, request, at: new Date().toISOString() }));
  const rerun = await observe(env, body);
  assert.equal(rerun.code, 1, rerun.out + rerun.err);
  assert.match(rerun.err, /already answered/);
});

test('mcp-observed: a calls[] entry holds tool and result only', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const calls = [{ tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([ORG]), extra: 'not part of the schema' }];
  const run = await observe(env, observation(request, { calls }));
  assert.equal(run.code, 1, run.out + run.err);
  assert.match(run.err, /calls\[0\].*not part of the call schema/);
  assert.ok(!existsSync(doctorJsonPath(dir)));
});

test('mcp-observed: stdin past the byte limit is refused without buffering the whole pipe', async () => {
  const { dir } = workspace();
  const big = join(dir, 'big-observation.json');
  writeFileSync(big, `{"kind":"c2c-mcp-observation"${' '.repeat(OBSERVATION_MAX_BYTES)}}`);
  const over = openSync(big, 'r');
  try {
    assert.throws(() => readStdinBounded(OBSERVATION_MAX_BYTES, over), /larger than the \d+-byte limit/);
  } finally {
    closeSync(over);
  }
  // Within the limit the full text comes back unchanged.
  const small = join(dir, 'small-observation.json');
  writeFileSync(small, '{"kind":"c2c-mcp-observation"}');
  const under = openSync(small, 'r');
  try {
    assert.equal(readStdinBounded(OBSERVATION_MAX_BYTES, under), '{"kind":"c2c-mcp-observation"}');
  } finally {
    closeSync(under);
  }
});

test('mcp-observed: the observation and each call result are size-bounded', async () => {
  const { dir, env } = workspace();
  // One result over the per-result limit but under the observation limit.
  const big = { content: [{ type: 'text', text: JSON.stringify({ data: [{ id: ORG, note: 'x'.repeat(MCP_RESULT_MAX_BYTES) }] }) }] };
  const { request } = await begin(env);
  const run = await observe(env, observation(request, { calls: [{ tool: 'CatalystbyZoho_List_All_Organizations', result: big }] }));
  assert.equal(run.code, 1, run.out + run.err);
  assert.match(run.err, /larger than the \d+-byte limit/);
  // A whole observation over the limit is refused before parsing.
  const { request: second } = await begin(env);
  const oversized = await observe(env, `${JSON.stringify(observation(second))}${' '.repeat(OBSERVATION_MAX_BYTES)}`);
  assert.equal(oversized.code, 1, oversized.out + oversized.err);
  assert.match(oversized.err, /larger than the \d+-byte limit/);
  assert.ok(!existsSync(doctorJsonPath(dir)));
});

test('mcp-observed: an unrequested call, or a missing orgs or probe call, is refused and nothing is recorded', async () => {
  const cases: [(request: string) => unknown[], RegExp][] = [
    [
      (request) => [
        { tool: 'CatalystbyZoho_Create_Bucket', result: probeResult(PROBE) },
        { tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([ORG]) },
        { tool: 'CatalystbyZoho_List_All_Tables', result: { content: [] } },
      ],
      /calls\[2\] is not a call the MCP request asked for/,
    ],
    [(request) => [{ tool: 'CatalystbyZoho_Create_Bucket', result: probeResult(PROBE) }], /has no CatalystbyZoho_List_All_Organizations result/],
    [() => [{ tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([ORG]) }], /has no CatalystbyZoho_Create_Bucket result/],
  ];
  for (const [calls, message] of cases) {
    const { dir, env } = workspace();
    const { request } = await begin(env);
    const run = await observe(env, observation(request, { calls: calls(request) }));
    assert.notEqual(run.code, 0, run.out);
    assert.match(run.err, message);
    assert.ok(!existsSync(doctorJsonPath(dir)) || (JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile).mcp === undefined);
    // A refused observation leaves the request open.
    assert.ok(existsSync(join(dir, 'c2c-out', '.c2c', 'mcp-request.json')));
  }
});

test('mcp request: closing the same request twice is refused (a racing second observation loses)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-observed-'));
  dirs.push(dir);
  const { request } = beginMcpRequest(dir);
  closeMcpRequest(dir, request);
  assert.ok(!existsSync(mcpRequestPath(dir)));
  assert.throws(() => closeMcpRequest(dir, request), (err) => err instanceof ObservationRejected && /already answered/.test(err.message));
  // A fresh begin clears the closed marker of the old request.
  const next = beginMcpRequest(dir);
  assert.ok(existsSync(join(dir, 'c2c-out', '.c2c', `mcp-request.${request}.closed`)) === false);
  closeMcpRequest(dir, next.request);
});
