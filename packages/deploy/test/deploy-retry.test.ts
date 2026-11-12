/**
 * Deploy-path retry coverage: every deploy step must retry a transient
 * 429/5xx with backoff up to the bounded cap, never retry a 4xx, and never
 * duplicate work when a write landed despite its failure answer. The failure
 * bodies are the recorded Catalyst shapes:
 *   5xx {"status":"failure","data":{"message":"Internal server error has occurred. Please try again after some time","error_code":"INTERNAL_SERVER_ERROR"}}
 *   CLI "HTTP Error: <code>, <message>"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAuthProvision } from '../src/auth.js';
import { provisionCli } from '../src/provision.js';
import type { Io } from '../src/cli.js';
import { provisionedConstraints } from '../src/tables.js';
import type { RestCall, RestFn, RestResult } from '../src/tables.js';
import { inviteUsers } from '../src/users.js';
import type { SchemaPlan } from '../../schema/src/generator.js';
import type { RetryOptions } from '../src/retry.js';

const ORG = '10000000000';
const PROJECT = '10000000000013200';
const BASE = `/baas/v1/project/${PROJECT}`;

const SVC_503 = { status: 'failure', data: { message: 'Internal server error has occurred. Please try again after some time', error_code: 'INTERNAL_SERVER_ERROR' } };

function instant(): RetryOptions & { lines: string[] } {
  const lines: string[] = [];
  return { lines, sleep: async () => {}, random: () => 0.5, log: (line) => lines.push(line) };
}

function projectDetails(): RestResult {
  return {
    status: 200,
    body: {
      status: 'success',
      data: { id: PROJECT, project_name: 'c2c-widget', env_details: [{ env_name: 'Development', env_zgid: ORG, id: ORG, project_details: { id: PROJECT, project_name: 'c2c-widget' } }] },
    },
  };
}

/** An in-memory auth surface: user list, auth flags, cors domains, Add User invites. */
interface AuthStore {
  hosted: boolean;
  embedded: boolean;
  domains: Set<string>;
  users: { email_id: string; user_id?: string }[];
  /** `${method} ${path}` → transient 503s answered before the write applies. */
  fail: Map<string, number>;
  /** POSTs that mutate the store but still answer 5xx (the write landed). */
  landedFail: Set<string>;
}

function store(over: Partial<AuthStore> = {}): AuthStore {
  return { hosted: false, embedded: false, domains: new Set(), users: [], fail: new Map(), landedFail: new Set(), ...over };
}

function authRest(s: AuthStore): { rest: RestFn; calls: string[] } {
  const calls: string[] = [];
  const rest: RestFn = async (call: RestCall): Promise<RestResult> => {
    calls.push(`${call.method} ${call.path}`);
    const path = call.path.slice(BASE.length);
    const key = `${call.method} ${path}`;
    const enable = /^\/authentication\/enable\?auth_type=(hosted|embedded)$/.exec(path);
    const apply = (): void => {
      if (call.method === 'POST' && enable) {
        if (enable[1] === 'hosted') s.hosted = true;
        else s.embedded = true;
      } else if (call.method === 'POST' && path === '/cors-domain') {
        s.domains.add(String((call.body as { domain?: string }).domain ?? '').toLowerCase());
      } else if (call.method === 'POST' && path === '/project-user') {
        const email = String((call.body as { user_details?: { email_id?: string } }).user_details?.email_id ?? '').toLowerCase();
        s.users.push({ email_id: email, user_id: '7001' });
      }
    };
    const left = s.fail.get(key) ?? 0;
    if (left > 0) {
      s.fail.set(key, left - 1);
      return { status: 503, body: SVC_503 };
    }
    if (s.landedFail.has(key)) {
      apply();
      return { status: 503, body: SVC_503 };
    }
    if (call.method === 'GET' && path === '/project-user') return { status: 200, body: { data: [...s.users] } };
    // The CLI token is refused the config and domain-list reads.
    for (const refused of ['/authentication/configuration', '/cors-domain']) {
      if (call.method === 'GET' && path === refused) {
        return { status: 403, body: { status: 'failure', data: { error_code: 'OAUTH_SCOPE_MISMATCH', message: 'invalid oauth scope to access this URL' } } };
      }
    }
    if (call.method === 'POST' && enable) {
      const kind = enable[1]!;
      if (kind === 'hosted' ? s.hosted : s.embedded) {
        return { status: 400, body: { status: 'failure', data: { message: `${kind} auth already enabled`, error_code: 'DUPLICATE' } } };
      }
      apply();
      return { status: 200, body: { data: { [`${kind}_auth`]: true } } };
    }
    if (call.method === 'POST' && path === '/cors-domain') {
      const domain = String((call.body as { domain?: string }).domain ?? '').toLowerCase();
      if (s.domains.has(domain)) return { status: 409, body: { status: 'failure', data: { message: 'domain already exists' } } };
      apply();
      return { status: 200, body: { data: { domain } } };
    }
    if (call.method === 'POST' && path === '/project-user') {
      apply();
      return { status: 200, body: { data: { user_id: '7001' } } };
    }
    return { status: 404, body: { status: 'failure', data: { message: `no fake route ${key}` } } };
  };
  return { rest, calls };
}

const INPUT = {
  projectId: PROJECT,
  slateDomain: 'app.onslate.example',
  admin: { email: 'owner@example.test', roleId: '5001' },
};

test('auth ops retry a transient 503: every POST lands once the service answers', async () => {
  const s = store({ fail: new Map([['POST /authentication/enable?auth_type=hosted', 1], ['POST /cors-domain', 2], ['POST /project-user', 1]]) });
  const { rest, calls } = authRest(s);
  const opts = instant();
  const out = await applyAuthProvision(rest, { ...INPUT, retry: opts });
  const posts = (suffix: string) => calls.filter((line) => line === `POST ${BASE}${suffix}`).length;
  assert.equal(posts('/authentication/enable?auth_type=hosted'), 2);
  assert.equal(posts('/cors-domain'), 3);
  assert.equal(posts('/project-user'), 2);
  for (const id of ['enable-hosted', 'enable-embedded', 'cors-domain', 'admin-signup'] as const) {
    assert.equal(out.results.find((op) => op.id === id)?.status, 'applied', id);
  }
  // Each retry logged its backoff line.
  assert.equal(opts.lines.filter((line) => line.startsWith('retry ')).length, 4);
});

test('a write that landed despite its 503 is never re-sent: the re-read ends the retry', async () => {
  const s = store({ landedFail: new Set(['POST /project-user']) });
  const { rest, calls } = authRest(s);
  await applyAuthProvision(rest, { ...INPUT, retry: instant() });
  assert.equal(calls.filter((line) => line === `POST ${BASE}/project-user`).length, 1);
  assert.equal(s.users.length, 1);
});

test('a persistent 5xx is bounded: four tries, then the failure is reported', async () => {
  const s = store({
    fail: new Map([
      ['POST /authentication/enable?auth_type=hosted', 99],
      ['POST /authentication/enable?auth_type=embedded', 99],
    ]),
  });
  const { rest, calls } = authRest(s);
  const out = await applyAuthProvision(rest, { ...INPUT, retry: instant() });
  for (const kind of ['hosted', 'embedded']) {
    assert.equal(calls.filter((line) => line === `POST ${BASE}/authentication/enable?auth_type=${kind}`).length, 4, kind);
    assert.equal(out.results.find((op) => op.id === `enable-${kind}`)?.status, 'failed');
  }
  // The refused config read (403) rides inside each retry's re-read.
  const configReads = calls.filter((line) => line === `GET ${BASE}/authentication/configuration`).length;
  assert.ok(configReads <= 1 + 2 * 3, `config GETs: ${configReads}`);
});

test('a 4xx is never retried on the auth path', async () => {
  const s = store();
  const { rest, calls } = authRest(s);
  const forbidden: RestFn = async (call) => {
    calls.push(`${call.method} ${call.path}`);
    if (call.method === 'GET' && call.path === `${BASE}/project-user`) return { status: 200, body: { data: [] } };
    if (call.method === 'GET' && call.path === `${BASE}/authentication/configuration`) {
      return { status: 403, body: { data: { error_code: 'OAUTH_SCOPE_MISMATCH' } } };
    }
    if (call.method === 'POST' && call.path.includes('auth_type=hosted')) {
      return { status: 403, body: { status: 'failure', data: { error_code: 'PUBLIC_SIGNUP_ERROR', message: 'public signup is off' } } };
    }
    return rest(call);
  };
  const out = await applyAuthProvision(forbidden, { ...INPUT, retry: instant() });
  assert.equal(calls.filter((line) => line === `POST ${BASE}/authentication/enable?auth_type=hosted`).length, 1);
  assert.notEqual(out.results.find((op) => op.id === 'enable-hosted')?.status, 'applied');
});

test('the invite list and POST retry; an invite that landed is not re-mailed', async () => {
  let listFails = 1;
  const sent: string[] = [];
  const users: { email_id: string }[] = [];
  const rest: RestFn = async (call) => {
    if (call.method === 'GET' && call.path.endsWith('/project-user')) {
      if (listFails-- > 0) return { status: 502, body: SVC_503 };
      return { status: 200, body: { data: [...users] } };
    }
    if (call.method === 'POST' && call.path.endsWith('/project-user')) {
      sent.push(String((call.body as { user_details?: { email_id?: string } }).user_details?.email_id));
      return { status: 200, body: { data: { user_id: '7001' } } };
    }
    return { status: 404, body: {} };
  };
  const out = await inviteUsers(rest, {
    projectId: PROJECT,
    targets: [{ id: 'u1', role: 'App User', identity: 'member@example.test', first: 'M', last: 'One' }],
    prior: [],
    roleIds: { 'App User': '5002' },
    redirectUrl: 'https://app.onslate.example',
    retry: instant(),
  });
  assert.equal(out.ok, true);
  assert.deepEqual(sent, ['member@example.test']);

  // Same flow, but the POST lands and still answers 500: one send, verified by the re-read.
  const users2: { email_id: string }[] = [];
  let posts = 0;
  const rest2: RestFn = async (call) => {
    if (call.method === 'GET' && call.path.endsWith('/project-user')) return { status: 200, body: { data: [...users2] } };
    if (call.method === 'POST' && call.path.endsWith('/project-user')) {
      posts += 1;
      users2.push({ email_id: String((call.body as { user_details?: { email_id?: string } }).user_details?.email_id) });
      return { status: 500, body: SVC_503 };
    }
    return { status: 404, body: {} };
  };
  const out2 = await inviteUsers(rest2, {
    projectId: PROJECT,
    targets: [{ id: 'u1', role: 'App User', identity: 'member@example.test', first: 'M', last: 'One' }],
    prior: [],
    roleIds: { 'App User': '5002' },
    redirectUrl: 'https://app.onslate.example',
    retry: instant(),
  });
  assert.equal(posts, 1);
  assert.equal(out2.rows[0]?.status === 'invited' || out2.rows[0]?.status === 'verified', true);
  assert.equal(users2.length, 1);
});

test('provisionedConstraints reads retry a transient 503', async () => {
  const calls: string[] = [];
  let listFails = 1;
  let detailFails = 1;
  const rest: RestFn = async (call) => {
    calls.push(`${call.method} ${call.path}`);
    if (call.path === `${BASE}/table`) {
      if (listFails-- > 0) return { status: 503, body: SVC_503 };
      return { status: 200, body: { data: [{ table_name: 'Item', table_id: '9001' }] } };
    }
    if (call.path === `${BASE}/table/9001`) {
      if (detailFails-- > 0) return { status: 503, body: SVC_503 };
      return { status: 200, body: { data: { column_details: [{ column_name: 'Name', is_mandatory: false }] } } };
    }
    return { status: 404, body: {} };
  };
  const schema = {
    tables: [
      { name: 'Item', form: 'Item', role: 'form', nosql: false, columns: [{ name: 'Name', mandatory: true, unique: false, creatorType: 'text', matrixId: 'm1', status: 'supported', dataType: 'varchar' }] },
    ],
  } as unknown as Pick<SchemaPlan, 'tables'>;
  const decisions = await provisionedConstraints(rest, PROJECT, schema, instant());
  assert.deepEqual(calls, [`GET ${BASE}/table`, `GET ${BASE}/table`, `GET ${BASE}/table/9001`, `GET ${BASE}/table/9001`]);
  assert.deepEqual(decisions, [{ table: 'Item', column: 'Name', rule: 'mandatory', layer: 'app', violations: 0 }]);
});

// --- `c2c provision --confirm --run` steps ---------------------------------

function provisionIo(out: string, rest: RestFn, spawn: Io['spawn']): { io: Io; stdout: () => string; stderr: () => string } {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      env: {},
      rest,
      spawn,
      fetch: async () => {
        throw new Error('fetch is never allowed in provision');
      },
      sleep: async () => {},
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function writePlan(steps: unknown[], files: Record<string, unknown> = {}): string {
  const out = mkdtempSync(join(tmpdir(), 'c2c-prov-retry-'));
  mkdirSync(join(out, 'provision'), { recursive: true });
  writeFileSync(join(out, 'provision', 'plan.json'), `${JSON.stringify({ version: 1, app: 'widget', steps }, null, 2)}\n`);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(out, 'provision', name), `${JSON.stringify(body, null, 2)}\n`);
  }
  return out;
}

const SCOPE = ['--org', ORG, '--project', PROJECT, '--dc', 'in'];

test('provision cli call step: a POST retries a 503 and closes once the service answers', async () => {
  const out = writePlan([
    {
      id: 'auth-hosted',
      via: 'cli',
      command: 'c2c provision --confirm --run auth-hosted',
      args: { call: { method: 'POST', path: '/baas/v1/project/<project>/authentication/enable?auth_type=hosted', body: { public_signup: false } } },
      readBack: { via: 'mcp', tool: 'CatalystbyZoho_Get_Authentication_Configurations', match: { hosted_auth: true } },
    },
  ]);
  try {
    let posts = 0;
    const rest: RestFn = async (call) => {
      if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+$/.test(call.path)) return projectDetails();
      if (call.method === 'POST' && call.path.includes('auth_type=hosted')) {
        posts += 1;
        return posts === 1 ? { status: 503, body: SVC_503 } : { status: 200, body: { data: { hosted_auth: true } } };
      }
      return { status: 404, body: {} };
    };
    const cap = provisionIo(out, rest, async () => ({ code: 0, stdout: '', stderr: '' }));
    const code = await provisionCli(['--out', out, '--confirm', '--run', 'auth-hosted', ...SCOPE], cap.io);
    assert.equal(code, 0, cap.stderr());
    assert.equal(posts, 2);
    assert.match(cap.stdout(), /retry 1\/3/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('provision cli call step: a 409 already-there is not retried', async () => {
  const out = writePlan([
    {
      id: 'authorized-domain',
      via: 'cli',
      command: 'c2c provision --confirm --run authorized-domain',
      args: { call: { method: 'POST', path: '/baas/v1/project/<project>/cors-domain', body: { domain: '<slate-app-url-host>', cors: true, iframe: true } } },
      readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_CORS_Domains', match: { '<slate-app-url-host>': { cors: true, iframe: true } } },
    },
  ]);
  try {
    let posts = 0;
    const rest: RestFn = async (call) => {
      if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+$/.test(call.path)) return projectDetails();
      if (call.method === 'POST') {
        posts += 1;
        return { status: 409, body: { data: { message: 'domain already exists' } } };
      }
      return { status: 404, body: {} };
    };
    const cap = provisionIo(out, rest, async () => ({ code: 0, stdout: '', stderr: '' }));
    const code = await provisionCli(['--out', out, '--confirm', '--run', 'authorized-domain', '--domain', 'app.onslate.example', ...SCOPE], cap.io);
    // already-there: run succeeds, the step stays open for its read-back.
    assert.equal(code, 0, cap.stderr());
    assert.equal(posts, 1);
    assert.ok(!cap.stdout().includes('retry '), cap.stdout());
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('provision crons step: a 503 POST re-reads the list and never duplicates a landed cron', async () => {
  const out = writePlan(
    [
      {
        id: 'crons',
        via: 'cli',
        command: 'c2c provision --confirm --run crons (crons are created disabled; the user enables each in the console)',
        args: { plan: 'provision/crons.json', schedules: 1, enabled: false },
        readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Crons', match: { cron_name: ['nightly'] } },
      },
    ],
    { 'crons.json': [{ cron_name: 'nightly', body: { cron_name: 'nightly', jobpool_id: '1' } }] },
  );
  try {
    const crons: { cron_name: string }[] = [];
    let posts = 0;
    const rest: RestFn = async (call) => {
      if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+$/.test(call.path)) return projectDetails();
      if (call.method === 'GET' && call.path.endsWith('/job_scheduling/cron')) return { status: 200, body: { data: [...crons] } };
      if (call.method === 'POST' && call.path.endsWith('/job_scheduling/cron')) {
        posts += 1;
        // The write lands; the answer still says 500. The re-read must close it.
        crons.push({ cron_name: String((call.body as { cron_name?: string }).cron_name) });
        return { status: 500, body: SVC_503 };
      }
      return { status: 404, body: {} };
    };
    const cap = provisionIo(out, rest, async () => ({ code: 0, stdout: '', stderr: '' }));
    const code = await provisionCli(['--out', out, '--confirm', '--run', 'crons', ...SCOPE], cap.io);
    assert.equal(code, 0, cap.stderr());
    assert.equal(posts, 1, 'the landed POST is never re-sent');
    assert.equal(crons.length, 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('provision apig:enable retries a transient CLI failure once, then runs clean', async () => {
  const out = writePlan([
    {
      id: 'apig-enable',
      via: 'cli',
      command: 'catalyst apig:enable',
      args: { argv: ['apig:enable'] },
      readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_API_route', match: { routes: ['items'] } },
    },
  ]);
  try {
    const spawned: string[] = [];
    const rest: RestFn = async (call) => {
      if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+$/.test(call.path)) return projectDetails();
      return { status: 404, body: {} };
    };
    const cap = provisionIo(out, rest, async (command, args) => {
      spawned.push(`${command} ${args.join(' ')}`);
      return spawned.length === 1 ? { code: 2, stdout: '', stderr: 'HTTP Error: 503, Service Unavailable' } : { code: 0, stdout: 'enabled', stderr: '' };
    });
    const code = await provisionCli(['--out', out, '--confirm', '--run', 'apig-enable', ...SCOPE], cap.io);
    assert.equal(code, 0, cap.stderr());
    assert.equal(spawned.length, 2);
    assert.match(cap.stdout(), /retry 1\/3.*apig:enable/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('provision cli read-back retries a transient 503', async () => {
  const out = writePlan([
    {
      id: 'connections',
      via: 'console',
      command: 'Catalyst console > Connections: connect zoho_workdrive',
      args: { integrations: ['zoho_workdrive'] },
      readBack: {
        via: 'cli',
        command: 'c2c provision --record connections',
        args: { call: { method: 'GET', path: '/baas/v1/project/<project>/connections' } },
        match: { link_name: ['zoho_workdrive'] },
      },
    },
  ]);
  try {
    let gets = 0;
    const cap = provisionIo(
      out,
      async (call) => {
        if (call.method === 'GET' && call.path.endsWith('/connections')) {
          gets += 1;
          return gets === 1 ? { status: 503, body: SVC_503 } : { status: 200, body: { data: [{ link_name: 'zoho_workdrive', connected: true }] } };
        }
        return { status: 404, body: {} };
      },
      async () => ({ code: 0, stdout: '', stderr: '' }),
    );
    const code = await provisionCli(['--out', out, '--record', 'connections', ...SCOPE], cap.io);
    assert.equal(code, 0, cap.stderr());
    assert.equal(gets, 2);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
