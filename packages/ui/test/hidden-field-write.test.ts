/**
 * A field the export hides on the form (`visibility = false`) is never a
 * client-writable key: the generated submit/edit endpoint refuses it even
 * when the profile's field permissions do not list it. Bulk edit posts a
 * single-field record to this endpoint, so the same refusal covers a forged
 * picker value.
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
${tab(1)}form Item
${tab(1)}{
${tab(2)}Name
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(2)}Secret
${tab(2)}(
${tab(3)}type = text
${tab(3)}visibility = false
${tab(2)})
${tab(2)}Amount
${tab(2)}(
${tab(3)}type = formula
${tab(2)})
${tab(2)}Nick
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(1)}}
${tab(1)}list Item_All
${tab(1)}{
${tab(2)}show all rows from Item
${tab(2)}(
${tab(3)}Name
${tab(2)})
${tab(1)}}
${tab(1)}share_settings
${tab(1)}{
${tab(2)}"Staff"
${tab(2)}{
${tab(3)}name = "Staff"
${tab(3)}type = Users_Permissions
${tab(3)}ModulePermissions
${tab(3)}{
${tab(4)}Item
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Item_All = {"View","Edit"}
${tab(5)}}
${tab(5)}FieldPermissions
${tab(5)}{
${tab(6)}Name
${tab(6)}{
${tab(7)}visibility:true,readonly:false
${tab(6)}}
${tab(6)}Nick
${tab(6)}{
${tab(7)}visibility:true,readonly:true
${tab(6)}}
${tab(5)}}
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(1)}}
}
`;

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

const staff = { user: { profile: 'Staff' } };

test('the submit endpoint refuses a hidden field the permission list never named', async () => {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-hidden-write-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
    for (const file of built.files) {
      const full = join(dir, file.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, file.data);
    }
    const submitPath = 'functions/aio/item/submit.mjs';
    const source = String(built.files.find((file) => file.path === submitPath)?.data);
    assert.match(source, /hiddenFields = \["Secret"\]/, submitPath);
    const mod = (await import(pathToFileURL(join(dir, submitPath)).href)) as { default: (req: unknown, res: unknown) => unknown };

    // Insert and update both refuse the hidden field, naming it.
    const insert = await invoke(mod.default, { ...staff, body: { record: { Secret: 'x' } } });
    assert.equal(insert.status, 403, JSON.stringify(insert.body));
    const update = await invoke(mod.default, { ...staff, body: { record: { Secret: 'x' }, ROWID: '9' } });
    assert.equal(update.status, 403, JSON.stringify(update.body));
    // A read-only (formula) field is refused as before.
    const readonly = await invoke(mod.default, { ...staff, body: { record: { Amount: 1 }, ROWID: '9' } });
    assert.equal(readonly.status, 403, JSON.stringify(readonly.body));
    // A field the profile may see but not write is refused as before.
    const ungranted = await invoke(mod.default, { ...staff, body: { record: { Nick: 'x' }, ROWID: '9' } });
    assert.equal(ungranted.status, 403, JSON.stringify(ungranted.body));
    // A writable field still passes the gate.
    const allowed = await invoke(mod.default, { ...staff, body: { record: { Name: 'Ada' } } });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The hidden rule screens the client-posted body only. An on-validate script
// setting a hidden field is the normal Creator use of one: `datastore.update`
// re-authorizes the script-touched record, and that re-check must not refuse
// the hidden key. `Secret` is granted to the profile so only the hidden mark
// is under test.
const WORKFLOW_SOURCE = `application "Demo"
{
${tab(1)}form Item
${tab(1)}{
${tab(2)}Name
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${tab(2)}Secret
${tab(2)}(
${tab(3)}type = text
${tab(3)}visibility = false
${tab(2)})
${tab(1)}}
${tab(1)}list Item_All
${tab(1)}{
${tab(2)}show all rows from Item
${tab(2)}(
${tab(3)}Name
${tab(2)})
${tab(1)}}
${tab(1)}workflow
${tab(1)}{
${tab(1)}form
${tab(1)}{
${tab(2)}Fill_Secret as "Fill Secret"
${tab(2)}{
${tab(3)}type = form
${tab(3)}form = Item
${tab(3)}on edit
${tab(3)}{
${tab(4)}actions
${tab(4)}{
${tab(4)}on validate
${tab(4)}(
${tab(5)}input.Secret = "auto";
${tab(4)})
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(1)}}
${tab(1)}}
${tab(1)}share_settings
${tab(1)}{
${tab(2)}"Staff"
${tab(2)}{
${tab(3)}name = "Staff"
${tab(3)}type = Users_Permissions
${tab(3)}ModulePermissions
${tab(3)}{
${tab(4)}Item
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Item_All = {"View","Edit"}
${tab(5)}}
${tab(5)}FieldPermissions
${tab(5)}{
${tab(6)}Name
${tab(6)}{
${tab(7)}visibility:true,readonly:false
${tab(6)}}
${tab(6)}Secret
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

interface StoreRow extends Record<string, unknown> {
  ROWID: string;
}

/** In-memory adapter in the datastore slot shape. ZCQL: `col = 'x'`, `true`, or empty. */
function memoryDatastore() {
  const tables = new Map<string, StoreRow[]>();
  let next = 100;
  const rows = (t: string) => (tables.has(t) ? tables.get(t)! : (tables.set(t, []), tables.get(t)!));
  const match = (where: string, row: StoreRow): boolean => {
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
  };
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

test('an on-validate script can set a hidden field on a live edit', async () => {
  const built = buildUi(deriveIr(parse(WORKFLOW_SOURCE)));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-hidden-workflow-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
    for (const file of built.files) {
      const full = join(dir, file.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, file.data);
    }
    const submitPath = 'functions/aio/item/submit.mjs';
    const mod = (await import(pathToFileURL(join(dir, submitPath)).href)) as { default: (req: unknown, res: unknown) => unknown };
    const store = memoryDatastore();

    const created = await withLive(store, () =>
      invoke(mod.default, { ...staff, body: { record: { Name: 'Ada' } } }),
    );
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const row = store.tables.get('Item')![0]!;
    assert.ok(row.ROWID);

    // The posted body carries only a writable field; the script fills Secret.
    const edited = await withLive(store, () =>
      invoke(mod.default, { ...staff, body: { record: { Name: 'b' }, ROWID: row.ROWID } }),
    );
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(store.tables.get('Item')![0]!.Secret, 'auto');
    assert.equal(store.tables.get('Item')![0]!.Name, 'b');

    // A client-posted hidden field is still refused outright.
    const forged = await withLive(store, () =>
      invoke(mod.default, { ...staff, body: { record: { Secret: 'x' }, ROWID: row.ROWID } }),
    );
    assert.equal(forged.status, 403, JSON.stringify(forged.body));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
