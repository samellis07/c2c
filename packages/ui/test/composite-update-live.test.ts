import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';

const tab = (n: number) => '\t'.repeat(n);

// A form with a composite (name) field: the store keeps one flat column per
// part (Name_first_name, Name_last_name) while a submit posts the nested
// object. The generated handler authorizes the request against the write
// schema and the runtime update re-authorizes against the same schema via
// writeSchemas — a schema-less re-check denies the nested value outright.
const SOURCE = `application "Reserve"
{
${tab(1)}form Reserve_Table
${tab(1)}{
${tab(2)}Name
${tab(2)}(
${tab(3)}type = name
${tab(3)}first_name
${tab(3)}(
${tab(4)}type = first_name
${tab(3)})
${tab(3)}last_name
${tab(3)}(
${tab(4)}type = last_name
${tab(3)})
${tab(2)})
${tab(2)}Time_Of_Attending
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(2)}KOT_Status
${tab(2)}(
${tab(3)}type = text
${tab(3)}visibility = false
${tab(2)})
${tab(1)}}
${tab(1)}list Reserve_Table_All
${tab(1)}{
${tab(2)}show all rows from Reserve_Table
${tab(2)}(
${tab(3)}Name
${tab(3)}Time_Of_Attending
${tab(2)})
${tab(1)}}
${tab(1)}share_settings
${tab(1)}{
${tab(2)}"Waiter"
${tab(2)}{
${tab(3)}name = "Waiter"
${tab(3)}type = Users_Permissions
${tab(3)}ModulePermissions
${tab(3)}{
${tab(4)}Reserve_Table
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Reserve_Table_All = {"View","Edit"}
${tab(5)}}
${tab(5)}FieldPermissions
${tab(5)}{
${tab(6)}Name
${tab(6)}{
${tab(7)}visibility:true,readonly:false
${tab(6)}}
${tab(6)}Time_Of_Attending
${tab(6)}{
${tab(7)}visibility:true,readonly:false
${tab(6)}}
${tab(5)}}
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(1)}}
}
`;

interface Row extends Record<string, unknown> {
  ROWID: string;
}

/** In-memory adapter in the datastore slot shape. ZCQL: `col = 'x'` or empty. */
function memoryDatastore() {
  const tables = new Map<string, Row[]>();
  let next = 100;
  const rows = (t: string) => (tables.has(t) ? tables.get(t)! : (tables.set(t, []), tables.get(t)!));
  const match = (where: string, row: Row): boolean => {
    const w = where.trim().replace(/^\((.*)\)$/, '$1');
    if (!w || w === 'true') return true;
    const eq = /^(\w+) = '([^']*)'$/.exec(w);
    if (eq) return String(row[eq[1]]) === eq[2];
    const and = w.split(/ AND /i);
    if (and.length > 1) return and.every((part) => match(part, row));
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
  const dir = mkdtempSync(join(tmpdir(), 'c2c-composite-update-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const [path, data] of files) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
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

const waiter = { user: { profile: 'Waiter' } };

test('a live update through the generated submit handler accepts a granted nested composite', async () => {
  const { dir, files } = emit();
  try {
    const submitPath = 'functions/aio/reserve-table/submit.mjs';
    const source = String(files.get(submitPath));
    assert.match(source, /writeSchemas: \{ \[formName\]: \{ readonlyFields, hiddenFields, fieldNames, fields \} \}/, submitPath);
    const mod = await import(pathToFileURL(join(dir, submitPath)).href);
    const store = memoryDatastore();

    const created = await withLive(store, () =>
      invoke(mod.default, { ...waiter, body: { record: { Name: { first_name: 'Ada', last_name: 'Lovelace' } } } }),
    );
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const row = store.tables.get('Reserve_Table')![0]!;
    assert.ok(row.ROWID);

    const edited = await withLive(store, () =>
      invoke(mod.default, {
        ...waiter,
        body: { record: { Name: { first_name: 'Grace', last_name: 'Hopper' } }, ROWID: row.ROWID },
      }),
    );
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    // Unauthorized composite sub-parts and hidden fields stay 403 on update.
    for (const record of [
      { Name: { first_name: 'Grace', Evil: 1 } },
      { Name: { first_name: 'Grace' }, KOT_Status: 'x' },
      { Name_Evil: 'x' },
      { Name: JSON.parse('{"__proto__":{"x":1},"first_name":"G"}') },
    ]) {
      const denied = await withLive(store, () =>
        invoke(mod.default, { ...waiter, body: { record, ROWID: row.ROWID } }),
      );
      assert.equal(denied.status, 403, JSON.stringify({ record, body: denied.body }));
    }
    assert.equal(store.tables.get('Reserve_Table')!.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
