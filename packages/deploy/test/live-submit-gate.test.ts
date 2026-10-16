/**
 * Golden: a .ds without the `time zone` application setting is reported at
 * generate time, not at request time — a live tree built from it fails every
 * live handler with 500 (TimeZoneRequired inside createRuntime). And a 500
 * response never echoes an internal error to the client: only Creator's own
 * Deluge runtime texts and named live-refused denials may cross the wire.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';

const FIXTURE_ORG = '10000000000';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'in' };

const root = repoRoot();
const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');

/** Smallest failing app shape: one form, no machines, no `time zone` setting. */
const DS_NO_ZONE = `application "NoZone"
{
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t}
\tforms
\t{
\t\tform Book
\t\t{
\t\t\tTitle
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t}
}
`;

function throwOnSuccess(script: string): string {
  return `application "ThrowOnSuccess"
{
\ttime zone = "Asia/Kolkata"
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t}
\tforms
\t{
\t\tform Book
\t\t{
\t\t\tTitle
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tBook_Success as "Book Success"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Book
\t\t\t\trecord event = on add
\t\t\t\ton success
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
${script}
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
}

/** Internal error: `for each` over a number throws UncapturedDelugeError — no Creator text exists for it. */
const DS_INTERNAL = throwOnSuccess('\t\t\t\t\t\t\tfor each k in 42\n\t\t\t\t\t\t\t{\n\t\t\t\t\t\t\t\tinput.Title = k;\n\t\t\t\t\t\t\t}');
/** Creator-text error: toLong on non-numeric text throws DelugeConversionError, a DelugeRuntimeError. */
const DS_DELUGE = throwOnSuccess('\t\t\t\t\t\t\tinput.Title = input.Title.toLong();');

function guardFor(app: ReturnType<typeof deriveIr>): GuardOk {
  return {
    org: FIXTURE_ORG,
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry: FIXTURE_REGISTRY,
  };
}

test('a live deploy of an app without a `time zone` setting fails at generate time and names the fix', () => {
  const app = deriveIr(parse(DS_NO_ZONE));
  assert.throws(
    () => deployFiles(app, guardFor(app), false, { mode: 'live' }),
    /time zone/,
    'live deployFiles must refuse a tree whose every live handler would 500',
  );
});

test('the same app still generates a dry-run tree (labelled UTC fallback, no live write)', () => {
  const app = deriveIr(parse(DS_NO_ZONE));
  const { files } = deployFiles(app, guardFor(app), false, { mode: 'dry-run' });
  assert.ok(files.some((file) => file.path === 'functions/c2c_api/c2c-deploy.json'));
});

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Record<string, unknown>[]> };
}

interface LiveReply {
  status: number;
  raw: string;
  body: Record<string, unknown>;
}

/**
 * Deploy `ds` live over the fake SDK, serve functions/c2c_api through a real
 * http server, and POST each body in order (concurrent ones together).
 */
async function liveSubmits(
  ds: string,
  posts: (Record<string, unknown> | Record<string, unknown>[])[],
  opts: { form?: string; path?: string } = {},
): Promise<{ replies: LiveReply[]; rows: Record<string, unknown>[]; logged: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-nozone-gate-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  let server: Server | undefined;
  try {
    const app = deriveIr(parse(ds));
    writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const req = createRequire(import.meta.url);
    const sdk = req(fake) as FakeSdk;
    sdk.setSession('admin', { user_id: '1', email_id: 'admin@example.test', role_details: { role_name: 'App Administrator' } });
    // The fake SDK's tables live for the whole test process: count only this run's rows.
    const before = (sdk.state().tables[opts.form ?? 'Book'] ?? []).length;
    const entry = req(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const post = async (body: Record<string, unknown>): Promise<LiveReply> => {
      const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api${opts.path ?? '/forms/Book/success'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=admin' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const raw = await res.text();
      return { status: res.status, raw, body: JSON.parse(raw) as Record<string, unknown> };
    };
    const replies: LiveReply[] = [];
    for (const step of posts) {
      if (Array.isArray(step)) replies.push(...(await Promise.all(step.map(post))));
      else replies.push(await post(step));
    }
    return { replies, rows: (sdk.state().tables[opts.form ?? 'Book'] ?? []).slice(before), logged };
  } finally {
    console.error = realError;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    moduleAny._resolveFilename = original;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function liveSubmit(ds: string): Promise<{ status: number; body: Record<string, unknown>; rows: Record<string, unknown>[]; logged: string[] }> {
  const { replies, rows, logged } = await liveSubmits(ds, [{ record: { Title: 'abc' } }]);
  return { status: replies[0]!.status, body: replies[0]!.body, rows, logged };
}

/** The committed row answers 200 wrote true with a fixed warning; the failure goes to the log only. */
function assertCommittedWithWarning(res: { status: number; body: Record<string, unknown>; rows: Record<string, unknown>[]; logged: string[] }, code: string): void {
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.wrote, true, 'the row write precedes the on-success script');
  assert.equal(res.body.dryRun, false);
  const warning = res.body.warning as Record<string, unknown>;
  assert.equal(warning.code, 'POST_COMMIT_FAILED');
  assert.equal(typeof warning.message, 'string');
  assert.match(String(warning.requestId), /^[0-9a-z]+$/);
  assert.equal(Object.hasOwn(res.body, 'error'), false);
  assert.doesNotMatch(JSON.stringify(res.body), /Unable to cast|Uncaptured|for each|stack/i, 'the failure text never reaches the client');
  assert.equal(res.rows.length, 1, 'exactly one row: the write is not rolled back');
  const line = res.logged.map((text) => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } }).find((entry) => entry?.event === 'post-commit-failed');
  assert.ok(line, `a post-commit log line: ${res.logged.join('\n')}`);
  assert.equal(line.table, 'Book');
  assert.equal(line.code, code);
  assert.equal(line.requestId, warning.requestId, 'the warning and the log line share the request id');
  assert.doesNotMatch(JSON.stringify(line), /abc/, 'no record values in the log');
}

test('an on-success script that throws after the commit answers 200 with a warning and leaves exactly one row', async () => {
  assertCommittedWithWarning(await liveSubmit(DS_INTERNAL), 'DELUGE_UNCAPTURED');
});

test('a Creator-text Deluge error after the write is a 200 warning and stays out of the client response', async () => {
  assertCommittedWithWarning(await liveSubmit(DS_DELUGE), 'DELUGE_CONVERSION');
});

/** A clean on-success script: the submit commits and answers 200 without a warning. */
const DS_CLEAN = throwOnSuccess('\t\t\t\t\t\t\tinput.Title = input.Title;');

test('the same idempotency key twice writes one row and answers the same response', async () => {
  const body = { record: { Title: 'once' }, idempotencyKey: 'c2c-key-0001' };
  const res = await liveSubmits(DS_CLEAN, [body, body]);
  assert.equal(res.replies[0]!.status, 200, res.replies[0]!.raw);
  assert.equal(res.replies[0]!.body.wrote, true);
  assert.equal(res.rows.length, 1, 'a repeated key never writes a second row');
  assert.equal(res.replies[1]!.status, res.replies[0]!.status);
  assert.equal(res.replies[1]!.raw, res.replies[0]!.raw, 'the repeat gets the original answer byte for byte');
});

test('a repeated key after a post-commit failure replays the committed 200 warning, not a second row', async () => {
  const body = { record: { Title: 'abc' }, idempotencyKey: 'c2c-key-0002' };
  const res = await liveSubmits(DS_INTERNAL, [body, body]);
  assert.equal(res.replies[0]!.status, 200, res.replies[0]!.raw);
  assert.equal((res.replies[0]!.body.warning as Record<string, unknown>).code, 'POST_COMMIT_FAILED');
  assert.equal(res.replies[1]!.raw, res.replies[0]!.raw);
  assert.equal(res.rows.length, 1);
});

test('two concurrent submits with one key write one row; the second waits for the first answer', async () => {
  const body = { record: { Title: 'race' }, idempotencyKey: 'c2c-key-0003' };
  const res = await liveSubmits(DS_CLEAN, [[body, body]]);
  assert.equal(res.rows.length, 1);
  assert.equal(res.replies[0]!.raw, res.replies[1]!.raw);
});

test('a malformed idempotency key is ignored and never stored', async () => {
  const res = await liveSubmits(DS_CLEAN, [
    { record: { Title: 'bad' }, idempotencyKey: 'x' },
    { record: { Title: 'bad' }, idempotencyKey: 'x' },
  ]);
  assert.equal(res.rows.length, 2, 'a malformed key does not deduplicate');
  assert.equal(Object.hasOwn(res.rows[0]!, 'idempotencyKey'), false, 'the key is never written as a column');
});

test('different keys, or no key, still write one row per submit', async () => {
  const res = await liveSubmits(DS_CLEAN, [
    { record: { Title: 'a' }, idempotencyKey: 'c2c-key-0004' },
    { record: { Title: 'b' }, idempotencyKey: 'c2c-key-0005' },
    { record: { Title: 'c' } },
    { record: { Title: 'c' } },
  ]);
  assert.equal(res.rows.length, 4);
});

/** One form with a `must have` field; on success makes the submit the deluge handler. */
const DS_MANDATORY = throwOnSuccess('\t\t\t\t\t\t\tinput.Title = input.Title;').replace('\t\t\tTitle\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)', '\t\t\tmust have Title\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t\tNotes\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)');

test('an empty submit on a form with a mandatory field is refused and writes nothing', async () => {
  assert.notEqual(DS_MANDATORY, DS_CLEAN, 'the must have field was spliced in');
  const res = await liveSubmits(DS_MANDATORY, [{ record: {} }, { record: { Notes: 'n', Title: '' } }]);
  for (const reply of res.replies) {
    assert.equal(reply.status, 422, reply.raw);
    assert.equal(reply.body.code, 'MANDATORY_MISSING', reply.raw);
    assert.equal(reply.body.field, 'Title', reply.raw);
    assert.notEqual(reply.body.wrote, true);
  }
  assert.equal(res.rows.length, 0, 'nothing is written');
});

test('a refused submit does not consume its key: the corrected retry with the same key writes', async () => {
  const res = await liveSubmits(DS_MANDATORY, [
    { record: {}, idempotencyKey: 'c2c-key-0006' },
    { record: { Title: 'fixed' }, idempotencyKey: 'c2c-key-0006' },
    { record: { Title: 'fixed' }, idempotencyKey: 'c2c-key-0006' },
  ]);
  assert.deepEqual(res.replies.map((reply) => reply.status), [422, 200, 200]);
  assert.equal(res.rows.length, 1);
  assert.equal(res.replies[2]!.raw, res.replies[1]!.raw);
});
