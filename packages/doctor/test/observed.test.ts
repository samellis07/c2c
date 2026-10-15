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
  MCP_RESULT_MAX_BYTES,
  mcpRequestPath,
  ObservationRejected,
  OBSERVATION_MAX_BYTES,
  readStdinBounded,
  type DoctorFile,
  type DoctorIo,
  type ScopeHooks,
  type SpawnResult,
} from '../src/index.js';
import { closeMcpRequest } from '../src/observed.js';
import requiredTools from '../data/required-mcp-tools.json' with { type: 'json' };

const ORG = '10000000000';
const FOREIGN_ORG = '10000000001';
const PROJECT = '10000000000013200';
const SCOPE = { dc: 'in', org: ORG, project: PROJECT };
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
  const home = join(dir, 'home');
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
    rest: rest ?? (async () => ({ status: 404, body: { code: 'INVALID_ID' } })),
    ...(stdin !== undefined ? { stdin: () => stdin } : {}),
  } as DoctorIo;
  return { io, out: () => out, err: () => err };
}

/** A fake REST that answers 200 only for the probe bucket it was told exists. */
function fakeRest(buckets: Record<string, unknown> = {}, seen?: { path: string }[]): NonNullable<DoctorIo['rest']> {
  return async (call) => {
    seen?.push({ path: call.path });
    const name = decodeURIComponent(call.path.split('/bucket/')[1] ?? '');
    if (name in buckets) return { status: 200, body: buckets[name] };
    return { status: 404, body: { code: 'INVALID_ID' } };
  };
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
      { tool: 'CatalystbyZoho_Create_Bucket', result: probeResult(`c2cprobe${request}`) },
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
  const probe = `c2cprobe${request}`;
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
  assert.equal(seen[0]?.path, `/baas/v1/project/${PROJECT}/bucket/${probe}`);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
  assert.equal(file.mcp?.binding?.status, 'verified');
  // The cleanup instruction always follows a verified probe.
  assert.match(run.out, /cleanup: remove the probe bucket c2cprobe[0-9a-f]+ .*Delete_Bucket/);
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
        { tool: 'CatalystbyZoho_Create_Bucket', result: probeResult(`c2cprobe${request}`) },
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

test('mcp-observed: a probe that landed under a different org/project is red', async () => {
  const { env } = workspace();
  const { request } = await begin(env);
  const probe = `c2cprobe${request}`;
  const body = observation(request, { host_of_url: undefined, transport: 'stdio' });
  // The write happened — but not where the CLI credential reads: the selected
  // project's read-back names only another request's bucket.
  const seen: { path: string }[] = [];
  const run = await observe(env, body, [], NO_HOOKS, fakeRest({ 'c2cprobeaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {} }, seen));
  assert.equal(run.code, 1, run.out + run.err);
  assert.equal(seen[0]?.path, `/baas/v1/project/${PROJECT}/bucket/${probe}`);
  assert.match(run.out, /FAIL D-B1 .*not proved bound/);
});

test('mcp-observed: a 200 read-back must contain the exact probe bucket name', async () => {
  for (const [label, body] of [
    ['different bucket', { data: [{ bucket_name: 'some-other-bucket' }] }],
    ['empty data', { data: [] }],
    ['several buckets', (request: string) => ({ data: [{ bucket_name: `c2cprobe${request}` }, { bucket_name: 'some-other-bucket' }] })],
    ['row without a name', { data: [{ bucket_url: 'https://x-development.zohostratus.in' }] }],
    ['data not a list', { data: { bucket_name: 'x' } }],
    ['top-level name only', { bucket_name: 'x' }],
    ['missing body', undefined],
    ['malformed JSON', '{not-json'],
  ] as const) {
    const { dir, env } = workspace();
    const { request } = await begin(env);
    const probe = `c2cprobe${request}`;
    const resolved = typeof body === 'function' ? body(request) : body;
    const run = await observe(env, observation(request, { host_of_url: undefined, transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [probe]: resolved }));
    assert.equal(run.code, 1, `${label}: ${run.out}${run.err}`);
    assert.match(run.out, /FAIL D-B2 .*probe write was not read back/);
    const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
    assert.notEqual(file.mcp?.binding?.status, 'verified');
    assert.ok(existsSync(join(dir, 'c2c-out', '.c2c', 'mcp-cleanup.json')), `${label}: cleanup remains tracked`);
  }
});

test('mcp-observed: the real Catalyst get-bucket envelope verifies — data array, one row, exact name', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const probe = `c2cprobe${request}`;
  // The exact body the specific-bucket REST read-back returns
  // (packages/deploy/test/seed-bucket.test.ts): the row rides in `data`.
  const run = await observe(
    env,
    observation(request, { host_of_url: undefined, transport: 'stdio' }),
    [],
    NO_HOOKS,
    fakeRest({ [probe]: { data: [{ bucket_name: probe, bucket_url: `https://${probe}-development.zohostratus.in` }] } }),
  );
  assert.equal(run.code, 0, run.out + run.err);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as ObservedFile;
  assert.equal(file.mcp?.binding?.status, 'verified');
});

test('mcp-observed: a fabricated org host or a matching CLI selection never stands in for the probe', async () => {
  const { env } = workspace();
  const { request } = await begin(env);
  const body = observation(request, {
    host_of_url: undefined,
    transport: 'stdio',
    calls: [
      { tool: 'CatalystbyZoho_Create_Bucket', result: probeResult(`c2cprobe${request}`) },
      // Caller claims an org host in the target DC; CLI hooks claim the same org/DC.
      { tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([ORG], 'console.zoho.in') },
    ],
  });
  const run = await observe(env, body, [], { cliDc: () => 'in', cliOrg: () => ORG }, fakeRest({}));
  assert.equal(run.code, 1, run.out + run.err);
  assert.match(run.out, /FAIL D-B2 .*probe write was not read back/);
});

test('mcp-observed: cleanup is re-printed while the probe may still exist, and cleared once it is gone', async () => {
  const { dir, env } = workspace();
  const { request } = await begin(env);
  const probe = `c2cprobe${request}`;
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

test('mcp-observed: a second probe never orphans the first — both are tracked, reminded, and cleared', async () => {
  const { dir, env } = workspace();
  const cleanupFile = join(dir, 'c2c-out', '.c2c', 'mcp-cleanup.json');
  // First probe verified server-side, but the session never ran its delete.
  const first = await begin(env);
  const probe1 = `c2cprobe${first.request}`;
  const run1 = await observe(env, observation(first.request, { transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [probe1]: { data: [{ bucket_name: probe1 }] } }));
  assert.equal(run1.code, 0, run1.out + run1.err);
  // The second begin still reminds about the first probe, and the second
  // verified probe is APPENDED — both buckets stay tracked.
  const second = await begin(env);
  const probe2 = `c2cprobe${second.request}`;
  assert.match(second.out, new RegExp(probe1));
  const run2 = await observe(env, observation(second.request, { transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [probe1]: { data: [{ bucket_name: probe1 }] }, [probe2]: { data: [{ bucket_name: probe2 }] } }));
  assert.equal(run2.code, 0, run2.out + run2.err);
  const tracked = JSON.parse(readFileSync(cleanupFile, 'utf8')) as { name: string }[];
  assert.deepEqual(tracked.map((p) => p.name).sort(), [probe1, probe2].sort());
  assert.match(run2.out, new RegExp(`cleanup: remove the probe bucket ${probe1}`));
  assert.match(run2.out, new RegExp(`cleanup: remove the probe bucket ${probe2}`));
  // Once both buckets read back absent, every record clears.
  const third = await begin(env);
  const run3 = await observe(env, observation(third.request, { transport: 'stdio' }), [], NO_HOOKS, fakeRest({}));
  assert.equal(run3.code, 1);
  assert.ok(!existsSync(cleanupFile));
  assert.doesNotMatch(run3.out, /cleanup: remove the probe bucket|cleanup still pending/);
});

test('mcp-observed: a partial cleanup keeps the remaining pending record', async () => {
  const { dir, env } = workspace();
  const cleanupFile = join(dir, 'c2c-out', '.c2c', 'mcp-cleanup.json');
  const first = await begin(env);
  const probe1 = `c2cprobe${first.request}`;
  assert.equal((await observe(env, observation(first.request, { transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [probe1]: { data: [{ bucket_name: probe1 }] } }))).code, 0);
  const second = await begin(env);
  const probe2 = `c2cprobe${second.request}`;
  assert.equal((await observe(env, observation(second.request, { transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [probe1]: { data: [{ bucket_name: probe1 }] }, [probe2]: { data: [{ bucket_name: probe2 }] } }))).code, 0);
  // The session deleted only the first bucket: its entry drops, the second stays.
  const third = await begin(env);
  const probe3 = `c2cprobe${third.request}`;
  const run3 = await observe(env, observation(third.request, { transport: 'stdio' }), [], NO_HOOKS, fakeRest({ [probe2]: { data: [{ bucket_name: probe2 }] }, [probe3]: { data: [{ bucket_name: probe3 }] } }));
  assert.equal(run3.code, 0, run3.out + run3.err);
  const tracked = JSON.parse(readFileSync(cleanupFile, 'utf8')) as { name: string }[];
  assert.deepEqual(tracked.map((p) => p.name).sort(), [probe2, probe3].sort());
  assert.match(run3.out, new RegExp(`cleanup: remove the probe bucket ${probe2}`));
  assert.doesNotMatch(run3.out, new RegExp(`cleanup: remove the probe bucket ${probe1}`));
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
  assert.equal(ask.probe, `c2cprobe${ask.request}`);
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
    { tool: 'CatalystbyZoho_Create_Bucket', result: probeResult(`c2cprobe${request}`) },
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
        { tool: 'CatalystbyZoho_Create_Bucket', result: probeResult(`c2cprobe${request}`) },
        { tool: 'CatalystbyZoho_List_All_Organizations', result: orgsResult([ORG]) },
        { tool: 'CatalystbyZoho_List_All_Tables', result: { content: [] } },
      ],
      /calls\[2\] is not a call the MCP request asked for/,
    ],
    [(request) => [{ tool: 'CatalystbyZoho_Create_Bucket', result: probeResult(`c2cprobe${request}`) }], /has no CatalystbyZoho_List_All_Organizations result/],
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
