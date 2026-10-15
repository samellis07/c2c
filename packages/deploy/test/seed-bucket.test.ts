import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { canonicalSeedJson, generateSeed } from '../../data/src/seed.js';
import type { FetchLike, MigrateResponse } from '../../data/src/migrate.js';
import { generateSchema } from '../../schema/src/generator.js';
import { seedMigrateCli, type Io } from '../src/cli.js';
import { bucketItem, importTemplate, importTemplateJson, projectTemplateJson } from '../src/iac.js';
import { seedBucketName } from '../src/seed.js';
import { bucketCreateBody, ensureSeedBucket } from '../src/stratus-bucket.js';
import type { RestCall, RestFn } from '../src/tables.js';

const ORG = '10000000000';
const PROJECT = '1001';
const TOKEN = 'test-cli-token';

const FILE_DS = `application "Widget"
{
	form Contacts
	{
		must have Picture
		(
			type = image
		)
	}
}`;

const TEXT_DS = `application "Widget"
{
	form Item
	{
		Name
		(
			type = text
			maxchar = 255
		)
	}
}`;

function appOf(ds: string): App {
  return deriveIr(parse(ds));
}

function response(body: unknown, status = 200): MigrateResponse {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

function projectDetails() {
  return {
    status: 'success',
    data: {
      id: PROJECT,
      project_name: 'c2c-widget',
      project_type: 'Live',
      env_details: [
        {
          env_name: 'Development',
          env_type: 1,
          env_zgid: ORG,
          id: ORG,
          is_default: true,
          project_details: { id: PROJECT, project_name: 'c2c-widget' },
        },
      ],
    },
  };
}

interface BucketSpec {
  /** Answer for GET /bucket; 404 is a fixture shorthand for an empty successful list. */
  read: { status: number; body?: unknown };
  /** Answer for POST /bucket, when the list proves the bucket is absent. */
  create?: { status: number; body?: unknown };
}

/** The project REST surface a confirmed seed load touches, with a scripted bucket. */
function fakeRest(spec: BucketSpec): { rest: RestFn; calls: { method: string; path: string; body?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const rest: RestFn = async (call: RestCall) => {
    calls.push({ method: call.method, path: call.path, body: call.body });
    if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+$/.test(call.path)) return { status: 200, body: projectDetails() };
    if (call.method === 'GET' && call.path.endsWith('/table')) return { status: 200, body: { data: [] } };
    if (call.method === 'GET' && call.path === `/baas/v1/project/${PROJECT}/bucket`) {
      const status = spec.read.status === 404 ? 200 : spec.read.status;
      const body = spec.read.status === 404 ? { status: 'success', data: [] } : spec.read.body ?? {};
      return { status, body };
    }
    if (call.method === 'POST' && call.path.endsWith('/bucket')) {
      const create = spec.create ?? { status: 404 };
      return { status: create.status, body: create.body ?? {} };
    }
    return { status: 404, body: {} };
  };
  return { rest, calls };
}

interface Cap {
  io: Io;
  stdout: () => string;
  stderr: () => string;
  fetched: { method: string; url: string }[];
  restCalls: { method: string; path: string; body?: unknown }[];
}

/** Row writes and Stratus uploads share io.fetch: the URL's host decides the shape. */
function capture(spec: BucketSpec): Cap {
  let out = '';
  let err = '';
  const fetched: { method: string; url: string }[] = [];
  const stored = new Map<string, Map<string, { rowid: string; columns: Record<string, string> }>>();
  let seq = 1;
  const store = fakeRest(spec);
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    fetched.push({ method, url });
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('zohostratus.in')) return { status: 200, headers: { get: () => null }, text: async () => '' };
    if (method === 'GET') throw new Error('seed migrate called Creator');
    if (parsed.pathname.endsWith('/query')) {
      const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
      const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1] ?? '';
      const rows = stored.get(table) ?? new Map();
      return response({ data: [...rows].map(([source, row]) => ({ ...row.columns, c2c_source_id: source, ROWID: row.rowid })) });
    }
    const table = decodeURIComponent(parsed.pathname.split('/').at(-2) ?? '');
    const parsed2: unknown = JSON.parse(init?.body ?? '[]');
    const records = Array.isArray(parsed2) ? parsed2 : [];
    const bucket = stored.get(table) ?? new Map<string, { rowid: string; columns: Record<string, string> }>();
    const acked: { c2c_source_id: string }[] = [];
    for (const row of records) {
      const record = row as Record<string, unknown>;
      const nested = record.columns;
      const sourceObj = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : record;
      const columns: Record<string, string> = {};
      for (const [key, value] of Object.entries(sourceObj)) {
        if (typeof value === 'string') columns[key] = value;
      }
      const source = columns.c2c_source_id ?? '';
      bucket.set(source, { rowid: `rowid-${table}-${seq++}`, columns });
      acked.push({ c2c_source_id: source });
    }
    stored.set(table, bucket);
    return response({ data: acked });
  };
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env: { X_ZC_CREDENTIAL_PATH: 'credential-dir' },
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch,
    rest: store.rest,
    accessToken: async () => TOKEN,
  };
  return { io, stdout: () => out, stderr: () => err, fetched, restCalls: store.calls };
}

function registryFile(dir: string): string {
  const path = join(dir, 'projects.json');
  writeFileSync(
    path,
    JSON.stringify({ org: ORG, dc: 'in', env: 'Development', projects: { 'c2c-widget': PROJECT } }),
  );
  return path;
}

/** A seed dir holding seed.json, the fixtures it names, and widget.ds. */
function seedDirOf(t: { after: (fn: () => void) => void }, ds: string): { dir: string; seed: string; dsPath: string; registry: string } {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-seed-bucket-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dsPath = join(dir, 'widget.ds');
  writeFileSync(dsPath, ds);
  const generated = generateSeed(appOf(ds), { n: 1, seed: 'bucket-test' });
  const seed = join(dir, 'seed.json');
  writeFileSync(seed, canonicalSeedJson(generated.tables));
  for (const file of generated.fixtureFiles) writeFileSync(join(dir, file.name), file.bytes);
  return { dir, seed, dsPath, registry: registryFile(dir) };
}

function confirmArgs(layout: { seed: string; dsPath: string; registry: string }): string[] {
  return ['--seed', layout.seed, '--ds', layout.dsPath, '--app', 'Widget', '--project', PROJECT, '--org', ORG, '--projects', layout.registry, '--confirm'];
}

const BUCKET = seedBucketName('Widget');

test('the import template emits the bucket only when the app has file columns', () => {
  const withFiles = importTemplate({ plan: generateSchema(appOf(FILE_DS)), bucket: BUCKET });
  assert.deepEqual(withFiles.components.Stratus, [bucketItem(BUCKET)]);
  const withoutFiles = importTemplate({ plan: generateSchema(appOf(TEXT_DS)) });
  assert.deepEqual(withoutFiles.components.Stratus, []);
  const drift = JSON.parse(projectTemplateJson(generateSchema(appOf(FILE_DS)), undefined, { bucket: BUCKET })) as { components: Record<string, unknown[]> };
  assert.equal((drift.components.Stratus?.[0] as { name?: string }).name, BUCKET);
  assert.equal((JSON.parse(importTemplateJson({ plan: generateSchema(appOf(TEXT_DS)) })) as { components: Record<string, unknown[]> }).components.Stratus?.length, 0);
});

test('ensureSeedBucket reads only the bucket list and creates only after proven absence', async () => {
  const seen: string[] = [];
  const rest: RestFn = async (call) => {
    seen.push(`${call.method} ${call.path}`);
    if (call.path.endsWith('/bucket')) return { status: 200, body: { data: [{ bucket_name: `${BUCKET}-other` }, { bucket_name: BUCKET }] } };
    return { status: 500, body: {} };
  };
  assert.equal((await ensureSeedBucket(rest, PROJECT, BUCKET)).outcome, 'exists');
  assert.deepEqual(seen, [`GET /baas/v1/project/${PROJECT}/bucket`]);

  const created: string[] = [];
  const missing: RestFn = async (call) => {
    created.push(`${call.method} ${call.path}`);
    if (call.method === 'GET') return { status: 200, body: { data: [] } };
    assert.deepEqual(call.body, bucketCreateBody(BUCKET));
    return { status: 200, body: { status: 'success' } };
  };
  assert.equal((await ensureSeedBucket(missing, PROJECT, BUCKET)).outcome, 'created');
  assert.deepEqual(created, [`GET /baas/v1/project/${PROJECT}/bucket`, `POST /baas/v1/project/${PROJECT}/bucket`]);
  assert.deepEqual(bucketCreateBody(BUCKET), {
    bucket_name: BUCKET,
    bucket_meta: { type: 'protected', versioning: false, caching: { status: false }, encryption: false, audit_consent: false },
  });
});

test('malformed bucket list rows fail closed without creating a bucket', async () => {
  for (const body of [
    { data: [{}] },
    { data: [{ bucket_name: null }] },
    { data: [{ bucket_name: '' }] },
    { data: { bucket_name: BUCKET } },
    {},
  ]) {
    const calls: string[] = [];
    const result = await ensureSeedBucket(async ({ method, path }) => {
      calls.push(`${method} ${path}`);
      return { status: 200, body };
    }, PROJECT, BUCKET);
    assert.equal(result.outcome, 'failed', JSON.stringify(body));
    assert.match(result.detail, /bucket list|bucket_name/);
    assert.deepEqual(calls, [`GET /baas/v1/project/${PROJECT}/bucket`]);
  }
});

test('seed bucket list pagination finds exact names and refuses uncertain absence', async () => {
  const paths: string[] = [];
  const paged: RestFn = async ({ path }) => {
    paths.push(path);
    if (paths.length === 1) return { status: 200, body: { data: [{ bucket_name: `${BUCKET}-prefix` }], more_records: true, next_token: 'page 2' } };
    return { status: 200, body: JSON.stringify({ data: [{ bucket_name: BUCKET }] }) };
  };
  assert.equal((await ensureSeedBucket(paged, PROJECT, BUCKET)).outcome, 'exists');
  assert.deepEqual(paths, [`/baas/v1/project/${PROJECT}/bucket`, `/baas/v1/project/${PROJECT}/bucket?next_token=page%202`]);

  for (const badList of [
    async () => ({ status: 403, body: { message: 'denied' } }),
    async () => ({ status: 200, body: '{not-json' }),
    async () => ({ status: 200, body: { data: 'not a list' } }),
    async () => ({ status: 200, body: { data: [], more_records: true } }),
  ]) {
    let creates = 0;
    const result = await ensureSeedBucket(async ({ method }) => {
      if (method === 'POST') creates++;
      return badList();
    }, PROJECT, BUCKET);
    assert.equal(result.outcome, 'failed');
    assert.equal(creates, 0);
  }
});

test('a missing bucket is created once, then the file cells upload', async (t) => {
  const layout = seedDirOf(t, FILE_DS);
  const cap = capture({ read: { status: 404 }, create: { status: 200, body: { status: 'success', data: [{ bucket_name: BUCKET }] } } });
  const code = await seedMigrateCli(confirmArgs(layout), cap.io);
  assert.equal(code, 0, cap.stderr());
  const bucketCalls = cap.restCalls.filter((call) => call.path.includes('/bucket'));
  assert.deepEqual(
    bucketCalls.map((call) => `${call.method} ${call.path}`),
    // The first GET is the Stratus first-use gate probe a file-bearing seed runs before any write.
    [`GET /baas/v1/project/${PROJECT}/bucket`, `GET /baas/v1/project/${PROJECT}/bucket`, `POST /baas/v1/project/${PROJECT}/bucket`],
  );
  assert.deepEqual(bucketCalls[2]?.body, bucketCreateBody(BUCKET));
  const uploads = cap.fetched.filter((call) => call.url.includes('zohostratus'));
  assert.ok(uploads.length >= 1);
  assert.ok(uploads.every((call) => call.url.startsWith(`https://${BUCKET}-development.zohostratus.in/`)));
  assert.match(cap.stdout(), /bucket: created/);
  assert.match(cap.stdout(), /Contacts: source 1 written 1 mismatch false/);
});

test('an existing bucket skips the create and the load still uploads', async (t) => {
  const layout = seedDirOf(t, FILE_DS);
  const cap = capture({ read: { status: 200, body: { data: [{ bucket_name: BUCKET, bucket_url: `https://${BUCKET}-development.zohostratus.in` }] } } });
  const code = await seedMigrateCli(confirmArgs(layout), cap.io);
  assert.equal(code, 0, cap.stderr());
  assert.equal(cap.restCalls.filter((call) => call.method === 'POST' && call.path.endsWith('/bucket')).length, 0);
  assert.equal(cap.restCalls.some((call) => call.path.includes('/bucket/')), false);
  assert.ok(cap.fetched.some((call) => call.url.includes('zohostratus')));
});

test('a console-gated create stops with the guided step, never a partial load', async (t) => {
  const layout = seedDirOf(t, FILE_DS);
  const cap = capture({
    read: { status: 404 },
    create: { status: 400, body: { status: 'failure', data: { error_code: 'OPERATION_NOT_ALLOWED', message: 'User needs to be in session when accessing Stratus for the first time' } } },
  });
  const code = await seedMigrateCli(confirmArgs(layout), cap.io);
  assert.equal(code, 1);
  assert.match(cap.stderr(), /Stratus/);
  assert.match(cap.stderr(), new RegExp(`create bucket ${BUCKET}|Create Bucket`));
  assert.equal(cap.fetched.length, 0);
});

test('a console-gated bucket read stops with the guided step before any write', async (t) => {
  const layout = seedDirOf(t, FILE_DS);
  const cap = capture({
    read: { status: 405, body: { status: 'failure', data: { error_code: 'OPERATION_NOT_ALLOWED', message: 'You are not allowed to perform this operation. User needs to be in session when accessing Stratus for the first time' } } },
  });
  const code = await seedMigrateCli(confirmArgs(layout), cap.io);
  assert.equal(code, 1);
  assert.match(cap.stderr(), /Stratus/);
  assert.equal(cap.restCalls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(cap.fetched.length, 0);
});

test('a refused create stops before the first row write and names the bucket and its step', async (t) => {
  const layout = seedDirOf(t, FILE_DS);
  const cap = capture({
    read: { status: 404 },
    create: { status: 401, body: { status: 'failure', data: { error_code: 'OAUTH_SCOPE_MISMATCH', message: 'invalid oauth scope to access this URL' } } },
  });
  const code = await seedMigrateCli(confirmArgs(layout), cap.io);
  assert.equal(code, 1);
  assert.match(cap.stderr(), new RegExp(`seed bucket ${BUCKET} is missing`));
  assert.match(cap.stderr(), /provision step bucket/);
  assert.equal(cap.fetched.length, 0);
});

test('a seed without file columns makes no Stratus or bucket call', async (t) => {
  const layout = seedDirOf(t, TEXT_DS);
  const cap = capture({ read: { status: 404 } });
  const code = await seedMigrateCli(confirmArgs(layout), cap.io);
  assert.equal(code, 0, cap.stderr());
  assert.equal(cap.restCalls.filter((call) => call.path.includes('/bucket')).length, 0);
  assert.equal(cap.fetched.filter((call) => call.url.includes('zohostratus')).length, 0);
});

test('the dry run lists the bucket the confirmed load would verify', async (t) => {
  const layout = seedDirOf(t, FILE_DS);
  const cap = capture({ read: { status: 404 } });
  const code = await seedMigrateCli(
    ['--seed', layout.seed, '--ds', layout.dsPath, '--app', 'Widget', '--project', PROJECT, '--org', ORG, '--projects', layout.registry],
    cap.io,
  );
  assert.equal(code, 0);
  assert.match(cap.stdout(), new RegExp(`bucket:\\n- ${BUCKET} `));
  assert.equal(cap.fetched.length, 0);
  assert.equal(cap.restCalls.length, 0);
});
