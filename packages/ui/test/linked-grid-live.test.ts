/**
 * A grid linked to another form (`values = Line.ID`) writes real records on
 * the linked table, so the caller needs the linked form's grant, not only the
 * parent's. A profile with write on Quote but no write on Line is refused 403
 * before any row is stored; insert, the delete a replace performs, and the
 * admin path each follow the linked form's own grant.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';

const tab = (n: number) => '\t'.repeat(n);

const SOURCE = `application "Demo"
{
${tab(1)}form Line
${tab(1)}{
${tab(2)}Item
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(2)}Qty
${tab(2)}(
${tab(3)}type = number
${tab(2)})
${tab(1)}}
${tab(1)}list Line_All
${tab(1)}{
${tab(2)}show all rows from Line
${tab(2)}(
${tab(3)}Item
${tab(2)})
${tab(1)}}
${tab(1)}form Quote
${tab(1)}{
${tab(2)}Title
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(2)}Lines
${tab(2)}(
${tab(3)}type = grid
${tab(3)}values = Line.ID
${tab(2)})
${tab(1)}}
${tab(1)}list Quote_All
${tab(1)}{
${tab(2)}show all rows from Quote
${tab(2)}(
${tab(3)}Title
${tab(2)})
${tab(1)}}
}
`;

/** Profiles: Editor writes Quote only; LinkWriter writes both; Admin deletes too. */
const POLICY = {
  roles: [],
  profiles: {
    Editor: { Quote: { write: true } },
    LinkWriter: { Quote: { write: true }, Line: { write: true } },
    NoDelete: { Quote: { write: true, delete: true }, Line: { write: true } },
    Admin: { Quote: { write: true, delete: true }, Line: { write: true, delete: true } },
  },
};

interface Row extends Record<string, unknown> {
  ROWID: string;
}

/** In-memory adapter in the datastore slot shape. ZCQL: `col = 'x'`, `col IN (...)`, `true`, or empty. */
function memoryDatastore() {
  const tables = new Map<string, Row[]>();
  let next = 100;
  const rows = (t: string) => (tables.has(t) ? tables.get(t)! : (tables.set(t, []), tables.get(t)!));
  const match = (where: string, row: Row): boolean => {
    const w = where.trim().replace(/^\((.*)\)$/, '$1');
    if (!w || w === 'true') return true;
    const eq = /^(\w+) = '([^']*)'$/.exec(w);
    if (eq) return String(row[eq[1]]) === eq[2];
    const list = /^(\w+) IN \((.*)\)$/.exec(w);
    if (list) return list[2].split(', ').map((v) => v.slice(1, -1)).includes(String(row[list[1]]));
    const and = /^\((.*)\) AND \((.*)\)$/.exec(w);
    if (and) return match(and[1]!, row) && match(and[2]!, row);
    throw new Error(`unexpected where ${where}`);
  };
  return {
    tables,
    async insert(table: string, batch: Record<string, unknown>[]) {
      const stored = batch.map((row) => ({ ...row, ROWID: String(next++) }));
      rows(table).push(...stored);
      return stored;
    },
    async update(table: string, batch: Record<string, unknown>[]) {
      for (const change of batch) {
        const row = rows(table).find((item) => item.ROWID === String(change.ROWID));
        if (row) Object.assign(row, change);
      }
      return batch;
    },
    async query(table: string, where: string, limit: number, offset = 0) {
      return rows(table).filter((row) => match(where, row)).slice(offset, offset + limit).map((row) => ({ ...row }));
    },
    async delete(table: string, ids: readonly unknown[]) {
      tables.set(table, rows(table).filter((row) => !ids.map(String).includes(row.ROWID)));
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

function emit(): { dir: string; files: Map<string, string | Buffer> } {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const files = new Map(built.files.map((file) => [file.path, file.data]));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-linked-grid-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const [path, data] of files) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
  writeFileSync(join(dir, 'functions/access-policy.json'), JSON.stringify(POLICY));
  return { dir, files };
}

async function withLive<T>(datastore: unknown, fn: () => Promise<T>): Promise<T> {
  process.env.C2C_DEPLOY_MODE = 'live';
  process.env.C2C_APP_TIMEZONE = 'Asia/Kolkata';
  (globalThis as Record<string, unknown>).__c2cDatastore = datastore;
  try {
    return await fn();
  } finally {
    delete process.env.C2C_DEPLOY_MODE;
    delete process.env.C2C_APP_TIMEZONE;
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
  }
}

const record = { Title: 'q', Lines: [{ Item: 'Bolt', Qty: 2 }] };
const user = (profile: string) => ({ user: { profile } });

test('write on the parent without write on the linked form is refused 403 and writes nothing', async () => {
  const { dir } = emit();
  try {
    const mod = await import(pathToFileURL(join(dir, 'functions/aio/quote/submit.mjs')).href);
    const store = memoryDatastore();
    const out = await withLive(store, () => invoke(mod.default, { ...user('Editor'), body: { record } }));
    assert.equal(out.status, 403, JSON.stringify(out.body));
    assert.match(String(out.body.error), /Line/);
    assert.deepEqual(store.tables.get('Quote') ?? [], []);
    assert.deepEqual(store.tables.get('Line') ?? [], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write on both the parent and the linked form writes rows on both tables', async () => {
  const { dir } = emit();
  try {
    const mod = await import(pathToFileURL(join(dir, 'functions/aio/quote/submit.mjs')).href);
    const store = memoryDatastore();
    const out = await withLive(store, () => invoke(mod.default, { ...user('LinkWriter'), body: { record } }));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const parent = store.tables.get('Quote')!;
    assert.equal(parent.length, 1);
    const lines = store.tables.get('Line')!;
    assert.deepEqual(lines.map((row) => [row.Item, row.Qty, row.Quote_id]), [['Bolt', 2, parent[0]!.ROWID]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a replace that deletes linked rows needs the linked form delete grant', async () => {
  const { dir } = emit();
  try {
    const mod = await import(pathToFileURL(join(dir, 'functions/aio/quote/submit.mjs')).href);
    const store = memoryDatastore();
    const created = await withLive(store, () => invoke(mod.default, { ...user('Admin'), body: { record } }));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const parent = store.tables.get('Quote')![0]!;
    const linesBefore = JSON.stringify(store.tables.get('Line'));

    // Write on both but no delete on Line: replacing the grid rows is refused
    // and the stored rows stay byte for byte.
    const denied = await withLive(store, () =>
      invoke(mod.default, { ...user('NoDelete'), body: { ROWID: parent.ROWID, record: { Title: 'q', Lines: [{ Item: 'Nut', Qty: 5 }] } } }),
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.match(String(denied.body.error), /Line/);
    assert.equal(JSON.stringify(store.tables.get('Line')), linesBefore);

    // The same replace with the delete grant on Line goes through.
    const ok = await withLive(store, () =>
      invoke(mod.default, { ...user('Admin'), body: { ROWID: parent.ROWID, record: { Title: 'q', Lines: [{ Item: 'Nut', Qty: 5 }] } } }),
    );
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(store.tables.get('Line')!.map((row) => [row.Item, row.Qty]), [['Nut', 5]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a linked insert on update still needs the linked form write grant', async () => {
  const { dir } = emit();
  try {
    const mod = await import(pathToFileURL(join(dir, 'functions/aio/quote/submit.mjs')).href);
    const store = memoryDatastore();
    const created = await withLive(store, () => invoke(mod.default, { ...user('Admin'), body: { record: { Title: 'q' } } }));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const parent = store.tables.get('Quote')![0]!;

    const denied = await withLive(store, () =>
      invoke(mod.default, { ...user('Editor'), body: { ROWID: parent.ROWID, record: { Title: 'q', Lines: [{ Item: 'Nut', Qty: 1 }] } } }),
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.deepEqual(store.tables.get('Line') ?? [], []);
    assert.equal(store.tables.get('Quote')!.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
