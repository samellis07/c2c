/**
 * Request input checks in the generated c2c_api, through the deployed index.js
 * router and the fake Catalyst SDK:
 * - a body that is not a JSON object (array, number, null) is a 400;
 * - a body a runtime already read is held to the same byte cap as a streamed one;
 * - a posted record or subform row with a "__proto__" key is refused, so no
 *   smuggled object becomes the record's prototype;
 * - a report query filters, searches and sorts only by fields the caller's
 *   profile reads, so no condition or order reveals a hidden field's values.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { authorizeWrite, type AccessPolicy } from '../../shims/src/access.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';

const FIXTURE_ORG = '10000000000';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'in' };

const root = repoRoot();
const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
const MAX_BODY_BYTES = 1024 * 1024;

const t = (n: number) => '\t'.repeat(n);

function field(name: string, type = 'text'): string {
  return `${t(3)}${name}\n${t(3)}(\n${t(4)}type = ${type}\n${t(3)})`;
}

function profile(name: string, flags?: Record<string, string>): string {
  const lines = [
    `${t(2)}"${name}"`,
    `${t(2)}{`,
    `${t(3)}name = "${name}"`,
    `${t(3)}type = Users_Permissions`,
    `${t(3)}permissions = {Chat:false, Predefined:false, ApiAccess:true, PIIAccess:true, ePHIAccess:true}`,
    `${t(3)}ModulePermissions`,
    `${t(3)}{`,
    `${t(5)}Booking`,
    `${t(5)}{`,
    `${t(6)}enabled= Create,Viewall,Tab `,
    `${t(6)}allFieldsVisible= ${flags ? 'false' : 'true'} `,
    `${t(6)}ReportPermissions`,
    `${t(6)}{`,
    `${t(7)}All_Bookings={"View"}`,
    `${t(6)}}`,
  ];
  if (flags) {
    lines.push(`${t(6)}FieldPermissions`, `${t(6)}{`);
    for (const [key, value] of Object.entries(flags)) lines.push(`${t(7)}${key}`, `${t(7)}{`, `${t(8)}${value}`, `${t(7)}}`);
    lines.push(`${t(6)}}`);
  }
  lines.push(`${t(5)}}`, `${t(3)}}`, `${t(2)}}`);
  return lines.join('\n');
}

const SHOWN = 'visibility:true,readonly:false';

const DS = `application "InputProbe"
{
${t(1)}time zone = "Asia/Kolkata"
${t(1)}forms
${t(1)}{
${t(2)}form Booking
${t(2)}{
${field('Title')}
${field('Qty', 'number')}
${field('Internal_Notes')}
${t(2)}}
${t(1)}}
${t(1)}reports
${t(1)}{
${t(2)}list All_Bookings
${t(2)}{
${t(3)}show all rows from Booking
${t(3)}(
${t(4)}Title
${t(4)}Qty
${t(4)}Internal_Notes
${t(3)})
${t(2)}}
${t(1)}}
${t(1)}share_settings
${t(1)}{
${profile('Lead')}
${profile('Clerk', { Title: SHOWN, Qty: SHOWN, Internal_Notes: 'visibility:false,readonly:false' })}
${t(1)}}
}
`;

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Record<string, unknown>[]> };
  initialize(req: unknown): { datastore(): { table(name: string): { insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> } } };
}

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

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

interface Client {
  /** POST a raw text body. `preRead` hands the entry req.body as a string or Buffer, as a runtime that read it would. */
  post(who: string | null, path: string, text: string, preRead?: 'string' | 'buffer'): Promise<Reply>;
  bookings(): Record<string, unknown>[];
  seed(rows: Record<string, unknown>[]): Promise<void>;
}

async function withApp(run: (client: Client) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-input-validation-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  let server: Server | undefined;
  try {
    const app = deriveIr(parse(DS));
    writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const require = createRequire(import.meta.url);
    const sdk = require(fake) as FakeSdk;
    // The fake SDK is one module-level store: each test starts with no Booking rows.
    sdk.state().tables.Booking?.splice(0);
    sdk.setSession('lead', { user_id: '11', email_id: 'lead@example.test', role_details: { role_name: 'Lead' } });
    sdk.setSession('clerk', { user_id: '12', email_id: 'clerk@example.test', role_details: { role_name: 'Clerk' } });
    const entry = require(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    server = createServer((rq, rs) => {
      const mode = rq.headers['x-test-pre-read'];
      if (!mode) {
        void entry(rq, rs);
        return;
      }
      const chunks: Buffer[] = [];
      rq.on('data', (chunk: Buffer) => chunks.push(chunk));
      rq.on('end', () => {
        const raw = Buffer.concat(chunks);
        (rq as IncomingMessage & { body?: unknown }).body = mode === 'buffer' ? raw : raw.toString('utf8');
        void entry(rq, rs);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const post: Client['post'] = async (who, path, text, preRead) => {
      const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(who ? { cookie: `c2c-harness-session=${who}` } : {}),
          ...(preRead ? { 'x-test-pre-read': preRead } : {}),
        },
        body: text,
        signal: AbortSignal.timeout(10_000),
      });
      return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
    };
    const seed: Client['seed'] = async (rows) => {
      await sdk.initialize({}).datastore().table('Booking').insertRows(rows);
    };
    await run({ post, bookings: () => sdk.state().tables.Booking ?? [], seed });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    moduleAny._resolveFilename = original;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a body that is not a JSON object is a 400 and writes nothing', async () => {
  await withApp(async ({ post, bookings }) => {
    for (const text of ['[{"record":{"Title":"array"}}]', '5', '"text"', 'null', 'true']) {
      const res = await post('lead', '/forms/Booking/submit', text);
      assert.equal(res.status, 400, `${text}: ${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body, { code: 'BAD_REQUEST', message: 'Invalid request' });
    }
    // The same refusal holds before sign-in: the shape check runs ahead of the principal.
    assert.equal((await post(null, '/forms/Booking/submit', '[]')).status, 400);
    assert.equal(bookings().length, 0, 'a refused body must not write');
    // An object body and an empty body still reach the handler.
    assert.equal((await post('lead', '/forms/Booking/submit', '{"record":{"Title":"ok"}}')).status, 200);
    assert.equal(bookings().length, 1);
  });
});

test('a pre-read string or Buffer body over the byte cap is a 413, as a streamed one is', async () => {
  await withApp(async ({ post, bookings }) => {
    const padding = 'x'.repeat(MAX_BODY_BYTES);
    const big = `{"record":{"Title":"${padding}"}}`;
    for (const preRead of [undefined, 'string', 'buffer'] as const) {
      const res = await post('lead', '/forms/Booking/submit', big, preRead);
      assert.equal(res.status, 413, `${String(preRead)}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'PAYLOAD_TOO_LARGE');
    }
    // Multi-byte text is measured in bytes, not UTF-16 code units.
    const wide = `{"record":{"Title":"${'é'.repeat(MAX_BODY_BYTES / 2)}"}}`;
    assert.ok(wide.length < MAX_BODY_BYTES && Buffer.byteLength(wide) > MAX_BODY_BYTES);
    assert.equal((await post('lead', '/forms/Booking/submit', wide, 'string')).status, 413);
    assert.equal(bookings().length, 0, 'an oversized body must not write');
    for (const preRead of ['string', 'buffer'] as const) {
      const res = await post('lead', '/forms/Booking/submit', '{"record":{"Title":"small","Qty":"3"}}', preRead);
      assert.equal(res.status, 200, `${preRead}: ${JSON.stringify(res.body)}`);
    }
    assert.equal(bookings().length, 2);
  });
});

test('a posted record with a __proto__ key is a 400 naming it, and nothing is written', async () => {
  await withApp(async ({ post, bookings }) => {
    // JSON.stringify drops __proto__ from an object literal, so the text is written out.
    const text = '{"record":{"Title":"proto","__proto__":{"Internal_Notes":"smuggled","Qty":"not a number"}}}';
    const res = await post('clerk', '/forms/Booking/submit', text);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.field, '__proto__');
    assert.equal(bookings().length, 0);
    assert.equal(({} as Record<string, unknown>).Internal_Notes, undefined, 'Object.prototype is untouched');
    // A key that only looks special is an ordinary unknown field: the write path names it.
    const ctor = await post('lead', '/forms/Booking/submit', '{"record":{"Title":"ctor","constructor":"x"}}');
    assert.equal(ctor.status, 403, JSON.stringify(ctor.body));
    assert.equal(bookings().length, 0);
  });
});

test('the posted-record reader refuses __proto__ at the top level and in a subform row', async () => {
  const mod = (await import(pathToFileURL(join(root, 'packages/deploy/fn/c2c-field-values.mjs')).href)) as {
    createFieldReader(opts: unknown): { input(form: string, record: unknown): Record<string, unknown> };
    FieldValueError: new (...args: unknown[]) => Error;
  };
  const reader = mod.createFieldReader({
    columns: { Order: { Qty: 'Number' }, Line: { Price: 'Double' } },
    subforms: { Order: [{ field: 'Lines', table: 'Line' }] },
  });
  const top = JSON.parse('{"Qty":"2","__proto__":{"Status":"Approved"}}') as Record<string, unknown>;
  assert.throws(() => reader.input('Order', top), (err: unknown) => err instanceof mod.FieldValueError && (err as { field?: string }).field === '__proto__');
  const nested = JSON.parse('{"Qty":"2","Lines":[{"Price":"1.5"},{"Price":"2","__proto__":{"Price":"9"}}]}') as Record<string, unknown>;
  assert.throws(() => reader.input('Order', nested), (err: unknown) => (err as { field?: string }).field === 'Lines[1].__proto__');
  // An untyped form (no columns) is still checked.
  const untyped = JSON.parse('{"Note":"a","__proto__":{"Note":"b"}}') as Record<string, unknown>;
  assert.throws(() => mod.createFieldReader({}).input('Other', untyped), mod.FieldValueError);
  // constructor and prototype are plain own keys, copied as values.
  const plain = reader.input('Order', JSON.parse('{"Qty":"2","constructor":"c","prototype":"p"}'));
  assert.deepEqual(Object.keys(plain), ['Qty', 'constructor', 'prototype']);
  assert.equal(Object.getPrototypeOf(plain), Object.prototype);
  assert.equal(plain.Qty, 2);
});

test('authorizeWrite refuses a __proto__ key instead of re-pointing the accepted values', () => {
  const policy: AccessPolicy = { roles: [], profiles: { Clerk: { Note: { write: true } } } } as unknown as AccessPolicy;
  const principal = { profile: 'Clerk' };
  const values = JSON.parse('{"Title":"a","__proto__":["x"]}') as Record<string, unknown>;
  assert.throws(() => authorizeWrite(policy, principal, 'Note', values), /Note\.__proto__ is not client-writable/);
  assert.deepEqual(authorizeWrite(policy, principal, 'Note', { Title: 'a' }).values, { Title: 'a' });
});

test('a report query cannot filter, search or sort by a field hidden from the caller', async () => {
  await withApp(async ({ post, seed }) => {
    await seed([
      { Title: 'first', Qty: 1, Internal_Notes: 'zz-secret' },
      { Title: 'second', Qty: 2, Internal_Notes: 'aa-secret' },
    ]);
    const titles = async (who: string, query: Record<string, unknown>): Promise<string[]> => {
      const res = await post(who, '/reports/All_Bookings', JSON.stringify({ op: 'query', ...query }));
      assert.equal(res.status, 200, `${who} ${JSON.stringify(query)}: ${JSON.stringify(res.body)}`);
      const rows = res.body.rows as Record<string, unknown>[];
      if (who === 'clerk') for (const row of rows) assert.equal(Object.hasOwn(row, 'Internal_Notes'), false, 'the hidden field is projected away');
      return rows.map((row) => String(row.Title));
    };
    const filter = { filter: { field: 'Internal_Notes', value: 'zz-secret' } };
    const search = { q: 'aa-secret' };
    const sort = { sort: [{ field: 'Internal_Notes', order: 'asc' }] };
    // A profile that reads the field filters, searches and sorts by it.
    assert.deepEqual(await titles('lead', filter), ['first']);
    assert.deepEqual(await titles('lead', search), ['second']);
    assert.deepEqual(await titles('lead', sort), ['second', 'first']);
    // A profile it is hidden from gets the unfiltered, unsearched, report-ordered read.
    assert.deepEqual(await titles('clerk', filter), ['first', 'second']);
    assert.deepEqual(await titles('clerk', search), []);
    assert.deepEqual(await titles('clerk', sort), ['first', 'second']);
    // Readable fields still work for that profile.
    assert.deepEqual(await titles('clerk', { filter: { field: 'Title', value: 'second' } }), ['second']);
    assert.deepEqual(await titles('clerk', { sort: [{ field: 'Qty', order: 'desc' }] }), ['second', 'first']);
  });
});
