/**
 * The generated admin smoke endpoint (functions/admin/smoke.mjs), called as a
 * handler: the server half of the #/admin/smoke page. Only an
 * Administrator-preset profile may run it — any other profile gets 403 before
 * the store is touched — and its delete removes only a row tagged
 * `c2c smoke <tag>` with the calling run's tag.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';

/**
 * These tests drive the enabled (cutover) endpoint: a generated app answers
 * POST /admin/smoke only when C2C_SMOKE_ENABLED=1.
 */
process.env.C2C_SMOKE_ENABLED ??= '1';

const SOURCE = `application "Widget"
{
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t}
\t}
\tsection S
\t{
\t\tform Item
\t\t{
\t\t\tmust have Item_Name
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tStatus
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t}
}
`;

interface Row extends Record<string, unknown> {
  ROWID: string;
}

/** In-memory store that records every call, so a refused request can be shown to touch nothing. */
function spyDatastore(seed: Row[]) {
  const rows = seed.map((row) => ({ ...row }));
  const calls: string[] = [];
  const match = (where: string, row: Row) => {
    const w = where.trim().replace(/^\((.*)\)$/, '$1');
    if (!w) return true;
    const eq = /^(\w+) = '?([^']*)'?$/.exec(w);
    if (eq) return String(row[eq[1]]) === eq[2];
    throw new Error(`unexpected where ${where}`);
  };
  return {
    rows,
    calls,
    async query(_table: string, where: string, limit: number, offset = 0) {
      calls.push('query');
      return rows.filter((row) => match(where, row)).slice(offset, offset + limit).map((row) => ({ ...row }));
    },
    async insert(_table: string, batch: Record<string, unknown>[]) {
      calls.push('insert');
      return batch;
    },
    async update(_table: string, batch: Record<string, unknown>[]) {
      calls.push('update');
      for (const change of batch) Object.assign(rows.find((row) => row.ROWID === String(change.ROWID)) ?? {}, change);
      return batch;
    },
    async delete(_table: string, ids: readonly unknown[]) {
      calls.push('delete');
      for (const id of ids) {
        const at = rows.findIndex((row) => row.ROWID === String(id));
        if (at >= 0) rows.splice(at, 1);
      }
      return ids;
    },
  };
}

function invoke(handler: (req: unknown, res: unknown) => unknown, req: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(body: string) {
      raw = body;
    },
  };
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} }));
}

async function loadHandler(): Promise<{ dir: string; handler: (req: unknown, res: unknown) => unknown }> {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-smoke-endpoint-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of built.files) {
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.data);
  }
  const mod = (await import(pathToFileURL(join(dir, 'functions/admin/smoke.mjs')).href)) as { default: (req: unknown, res: unknown) => unknown };
  return { dir, handler: mod.default };
}

async function withLive<T>(datastore: unknown, fn: () => Promise<T>): Promise<T> {
  process.env.C2C_DEPLOY_MODE = 'live';
  (globalThis as Record<string, unknown>).__c2cDatastore = datastore;
  try {
    return await fn();
  } finally {
    delete process.env.C2C_DEPLOY_MODE;
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
  }
}

const TAG = 'c2c smoke s1abc';
const seed = (): Row[] => [
  { ROWID: '101', Item_Name: TAG, Status: 'Open' },
  { ROWID: '102', Item_Name: 'Customer row', Status: 'Open' },
  { ROWID: '103', Item_Name: 'c2c smoke sOTHER', Status: 'Open' },
];
const marker = (tag = TAG) => ({ field: 'Item_Name', tag });

test('smoke endpoint: a non-admin profile gets 403 and nothing is read, written or deleted', async () => {
  const { dir, handler } = await loadHandler();
  try {
    for (const user of [{ profile: 'Staff' }, { profile: 'administrators' }, { profile: 'Staff', role: 'Administrator' }]) {
      for (const body of [
        { op: 'status' },
        { op: 'delete', form: 'Item', rowId: '101', marker: marker() },
        { op: 'update', form: 'Item', rowId: '101', marker: marker(), fields: { Status: 'Closed' } },
      ]) {
        const store = spyDatastore(seed());
        const out = await withLive(store, () => invoke(handler, { user, body }));
        assert.equal(out.status, 403, `${JSON.stringify(user)} ${body.op}: ${JSON.stringify(out.body)}`);
        assert.match(String(out.body.error), /requires an Administrator profile/);
        assert.deepEqual(store.calls, [], `${body.op}: the store is never touched`);
        assert.deepEqual(store.rows, seed(), `${body.op}: nothing written or deleted`);
      }
    }
    // A profile in the body, query or a header is never the principal.
    const store = spyDatastore(seed());
    const anon = await withLive(store, () =>
      invoke(handler, { body: { op: 'delete', form: 'Item', rowId: '101', marker: marker(), profile: 'Administrator' }, headers: { 'x-profile': 'Administrator' }, query: { profile: 'Administrator' } }),
    );
    assert.equal(anon.status, 401);
    assert.deepEqual(store.calls, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke endpoint: an Administrator is allowed, and delete touches only the row tagged with this run', async () => {
  const { dir, handler } = await loadHandler();
  try {
    const admin = { profile: 'Administrator' };
    const store = spyDatastore(seed());
    const status = await withLive(store, () => invoke(handler, { user: admin, body: { op: 'status' } }));
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.ok, true);
    assert.equal(status.body.mode, 'live');

    // A customer row and another run's row are refused, and stay.
    const customer = await withLive(store, () => invoke(handler, { user: admin, body: { op: 'delete', form: 'Item', rowId: '102', marker: marker() } }));
    assert.equal(customer.status, 409, JSON.stringify(customer.body));
    const other = await withLive(store, () => invoke(handler, { user: admin, body: { op: 'delete', form: 'Item', rowId: '103', marker: marker() } }));
    assert.equal(other.status, 409, JSON.stringify(other.body));
    // A tag that is not a smoke tag, or a marker field that is not the generated one, is refused before any read.
    const before = store.calls.length;
    const loose = await withLive(store, () => invoke(handler, { user: admin, body: { op: 'delete', form: 'Item', rowId: '102', marker: { field: 'Item_Name', tag: 'Customer row' } } }));
    assert.equal(loose.status, 400);
    const otherField = await withLive(store, () => invoke(handler, { user: admin, body: { op: 'delete', form: 'Item', rowId: '102', marker: { field: 'Status', tag: TAG } } }));
    assert.equal(otherField.status, 400);
    assert.equal(store.calls.length, before, 'refused before the store is read');
    assert.equal(store.calls.includes('delete'), false, 'no delete for a row this run did not tag');

    const own = await withLive(store, () => invoke(handler, { user: admin, body: { op: 'delete', form: 'Item', rowId: '101', marker: marker() } }));
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.deleted, true);
    assert.deepEqual(
      store.rows.map((row) => row.ROWID),
      ['102', '103'],
      'only the row tagged c2c smoke <this tag> is gone',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
