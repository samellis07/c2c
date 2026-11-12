import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';

const tab = (n: number) => '\t'.repeat(n);

function field(name: string, type: string, extra = ''): string {
  return `${tab(2)}${name}\n${tab(2)}(\n${tab(3)}type = ${type}${extra ? `\n${extra}` : ''}\n${tab(2)})`;
}

function grid(name: string, sub: string): string {
  return field(name, 'grid', `${tab(3)}${sub}\n${tab(3)}(\n${tab(4)}type = text\n${tab(3)})`);
}

function perms(form: string): string {
  const grant = (name: string) => `${tab(5)}${name}\n${tab(5)}{\n${tab(6)}visibility:true,readonly:false\n${tab(5)}}`;
  return `${tab(4)}${form}\n${tab(4)}{\n${tab(5)}enabled = true\n${tab(5)}ReportPermissions\n${tab(5)}{\n${tab(6)}${form}_All = {"View","Edit"}\n${tab(5)}}\n${tab(5)}FieldPermissions\n${tab(5)}{\n${['Customer', 'Lines', 'Item', 'Notes', 'Body'].map(grant).join('\n')}\n${tab(5)}}\n${tab(4)}}`;
}

function formBlock(name: string): string {
  return `${tab(1)}form ${name}\n${tab(1)}{\n${field('Customer', 'text')}\n${grid('Lines', 'Item')}\n${grid('Notes', 'Body')}\n${tab(1)}}\n${tab(1)}list ${name}_All\n${tab(1)}{\n${tab(2)}show all rows from ${name}\n${tab(2)}(\n${tab(3)}Customer\n${tab(3)}Lines\n${tab(2)})\n${tab(1)}}`;
}

const SOURCE = `application "Demo"
{
${formBlock('Order')}
${formBlock('Invoice')}
${tab(1)}workflow
${tab(1)}{
${tab(1)}form
${tab(1)}{
${tab(2)}Save_Invoice as "Save Invoice"
${tab(2)}{
${tab(3)}type = form
${tab(3)}form = Invoice
${tab(3)}on add
${tab(3)}{
${tab(4)}actions
${tab(4)}{
${tab(4)}on success
${tab(4)}(
${tab(5)}y = 1;
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
${perms('Order')}
${perms('Invoice')}
${tab(3)}}
${tab(2)}}
${tab(1)}}
}
`;

interface Row extends Record<string, unknown> {
  ROWID: string;
}

/** In-memory adapter in the datastore slot shape. ZCQL: `col = 'x'`, `col IN (...)`, `true`, or empty. */
function memoryDatastore(failOn?: string) {
  const tables = new Map<string, Row[]>();
  let next = 100;
  const rows = (t: string) => (tables.has(t) ? tables.get(t)! : (tables.set(t, []), tables.get(t)!));
  const match = (where: string, row: Row) => {
    const w = where.trim().replace(/^\((.*)\)$/, '$1');
    if (!w || w === 'true') return true;
    const eq = /^(\w+) = '([^']*)'$/.exec(w);
    if (eq) return String(row[eq[1]]) === eq[2];
    const list = /^(\w+) IN \((.*)\)$/.exec(w);
    if (list) return list[2].split(', ').map((v) => v.slice(1, -1)).includes(String(row[list[1]]));
    throw new Error(`unexpected where ${where}`);
  };
  return {
    tables,
    async insert(table: string, batch: Record<string, unknown>[]) {
      if (table === failOn) throw new Error('insert refused');
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

function emit(source = SOURCE): { dir: string; files: Map<string, string | Buffer> } {
  const built = buildUi(deriveIr(parse(source)));
  const files = new Map(built.files.map((file) => [file.path, file.data]));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-subform-'));
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

const staff = { user: { profile: 'Staff' } };
const record = { Customer: 'Ann', Lines: [{ Item: 'Bolt' }, { Item: 'Nut' }], Notes: [{ Body: 'rush' }] };

test('generated submit and on-success handlers write subform rows to child tables, not into the parent row', async () => {
  const { dir, files } = emit();
  try {
    const submitPath = 'functions/aio/order/submit.mjs';
    const successPath = 'functions/aio/invoice/on-success.mjs';
    for (const path of [submitPath, successPath]) {
      const source = String(files.get(path));
      assert.match(source, /export const subformTables = /, path);
      assert.match(source, /saveSubforms, splitSubforms|saveSubforms, splitSubforms/, path);
    }
    for (const [path, form] of [
      [submitPath, 'Order'],
      [successPath, 'Invoice'],
    ] as const) {
      const mod = await import(pathToFileURL(join(dir, path)).href);
      const store = memoryDatastore();
      const out = await withLive(store, () => invoke(mod.default, { ...staff, body: { record } }));
      assert.equal(out.status, 200, `${path} ${JSON.stringify(out.body)}`);
      const parent = store.tables.get(form)!;
      assert.equal(parent.length, 1, path);
      assert.equal(Object.hasOwn(parent[0], 'Lines'), false, `${path} stored the subform array on the parent`);
      assert.equal(parent[0].Customer, 'Ann');
      const lines = store.tables.get(`${form}__Lines`)!;
      assert.deepEqual(
        lines.map((row) => [row.Item, row.parent_id, row.row_order]),
        [
          ['Bolt', parent[0].ROWID, 0],
          ['Nut', parent[0].ROWID, 1],
        ],
        path,
      );
      assert.deepEqual(store.tables.get(`${form}__Notes`)!.map((row) => row.Body), ['rush'], path);
      // The response and the on-success script still see the subform lists.
      const values = out.body.values as Record<string, unknown>;
      assert.deepEqual(values.Lines, record.Lines, path);

      // Edit through the handler is covered by the next test: record.prepare
      // copies the stored Added_* / Modified_* into ctx.record for the script
      // and the reply, and the runtime update drops them from the payload —
      // the write carries only screened fields plus fresh Modified_* stamps.
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live edit through the submit handler writes the fields and leaves Added_* untouched', async () => {
  const { dir } = emit();
  try {
    const mod = await import(pathToFileURL(join(dir, 'functions/aio/order/submit.mjs')).href);
    const store = memoryDatastore();
    const created = await withLive(store, () => invoke(mod.default, { ...staff, body: { record } }));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const before = store.tables.get('Order')![0]!;
    const addedTime = before.Added_Time;
    const addedUser = before.Added_User;
    assert.ok(addedTime != null && addedTime !== '');

    const edited = await withLive(store, () =>
      invoke(mod.default, {
        ...staff,
        body: { record: { Customer: 'Bea', Lines: [{ Item: 'Screw' }] }, ROWID: before.ROWID },
      }),
    );
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(store.tables.get('Order')!.length, 1);
    const after = store.tables.get('Order')![0]!;
    assert.equal(after.Customer, 'Bea');
    assert.equal(after.Added_Time, addedTime);
    assert.equal(after.Added_User, addedUser);
    assert.ok(after.Modified_Time != null && after.Modified_Time !== '');
    // The reply still shows the system columns the script could read.
    const reply = edited.body.values as Record<string, unknown>;
    assert.equal(reply.Added_Time, addedTime);
    // Subform rows were replaced on the child table.
    assert.deepEqual(store.tables.get('Order__Lines')!.map((row) => row.Item), ['Screw']);

    // A profile without the edit grant is refused before the row is touched.
    const denied = await withLive(store, () =>
      invoke(mod.default, { user: { profile: 'Visitor' }, body: { record: { Customer: 'X' }, ROWID: before.ROWID } }),
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(store.tables.get('Order')![0]!.Customer, 'Bea');

    // A client-supplied system field is refused, never written.
    const forged = await withLive(store, () =>
      invoke(mod.default, {
        ...staff,
        body: { record: { Customer: 'X', Added_Time: '1999-01-01' }, ROWID: before.ROWID },
      }),
    );
    assert.equal(forged.status, 403, JSON.stringify(forged.body));
    assert.equal(store.tables.get('Order')![0]!.Customer, 'Bea');
    assert.equal(store.tables.get('Order')![0]!.Added_Time, addedTime);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed child insert rolls the new parent row back', async () => {
  const { dir } = emit();
  try {
    const mod = await import(pathToFileURL(join(dir, 'functions/aio/order/submit.mjs')).href);
    const store = memoryDatastore('Order__Notes');
    const out = await withLive(store, () => invoke(mod.default, { ...staff, body: { record } }));
    assert.equal(out.status, 500);
    assert.deepEqual(store.tables.get('Order'), []);
    assert.deepEqual(store.tables.get('Order__Lines'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the edit record read returns subform rows, and an edit that omits a subform leaves its stored rows byte for byte', async () => {
  const { dir, files } = emit();
  try {
    const policyPath = 'functions/access-policy.json';
    const policy = JSON.parse(String(files.get(policyPath)));
    policy.profiles.Staff['Order__Lines'] = { fields: ['Item'] };
    policy.profiles.Staff['Order__Notes'] = { fields: ['Body'] };
    writeFileSync(join(dir, policyPath), JSON.stringify(policy));
    const rec = await import(pathToFileURL(join(dir, 'functions/aio/order/record.mjs')).href);
    const submit = await import(pathToFileURL(join(dir, 'functions/aio/order/submit.mjs')).href);
    const store = memoryDatastore();
    const created = await withLive(store, () => invoke(submit.default, { ...staff, body: { record } }));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const parent = store.tables.get('Order')![0]!;
    const linesBefore = JSON.stringify(store.tables.get('Order__Lines'));
    const notesBefore = JSON.stringify(store.tables.get('Order__Notes'));

    const loaded = await withLive(store, () => invoke(rec.default, { ...staff, body: { ROWID: parent.ROWID } }));
    assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
    const loadedRecord = loaded.body.record as Record<string, { Item?: string; Body?: string }[]>;
    assert.deepEqual(loadedRecord.Lines.map((row) => row.Item), ['Bolt', 'Nut']);
    assert.deepEqual(loadedRecord.Notes.map((row) => row.Body), ['rush']);

    // The shape the edit screen posts when the subform key was never on the record.
    const untouched = await withLive(store, () =>
      invoke(submit.default, { ...staff, body: { ROWID: parent.ROWID, record: { Customer: 'Ann' } } }),
    );
    assert.equal(untouched.status, 200, JSON.stringify(untouched.body));
    assert.equal(JSON.stringify(store.tables.get('Order__Lines')), linesBefore);
    assert.equal(JSON.stringify(store.tables.get('Order__Notes')), notesBefore);

    const removed = await withLive(store, () =>
      invoke(submit.default, {
        ...staff,
        body: { ROWID: parent.ROWID, record: { Customer: 'Ann', Lines: [{ Item: 'Bolt' }] } },
      }),
    );
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(store.tables.get('Order__Lines')!.map((row) => row.Item), ['Bolt']);
    assert.equal(JSON.stringify(store.tables.get('Order__Notes')), notesBefore);

    const added = await withLive(store, () =>
      invoke(submit.default, {
        ...staff,
        body: { ROWID: parent.ROWID, record: { Customer: 'Ann', Lines: [{ Item: 'Bolt' }, { Item: 'Washer' }] } },
      }),
    );
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.deepEqual(store.tables.get('Order__Lines')!.map((row) => row.Item), ['Bolt', 'Washer']);
    assert.equal(JSON.stringify(store.tables.get('Order__Notes')), notesBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record subforms require a child-table read grant and project child fields', async () => {
  const { dir, files } = emit();
  try {
    const policyPath = 'functions/access-policy.json';
    const policy = JSON.parse(String(files.get(policyPath)));
    policy.profiles.Staff['Order__Lines'] = { fields: ['Item'] };
    writeFileSync(join(dir, policyPath), JSON.stringify(policy));
    const rec = await import(pathToFileURL(join(dir, 'functions/aio/order/record.mjs')).href);
    const store = memoryDatastore();
    store.tables.set('Order', [{ ROWID: '1', Customer: 'Ann' }]);
    store.tables.set('Order__Lines', [{ ROWID: '2', parent_id: '1', row_order: 0, Item: 'Bolt', Secret: 'hidden' }]);
    store.tables.set('Order__Notes', [{ ROWID: '3', parent_id: '1', row_order: 0, Body: 'no grant' }]);
    const parent = store.tables.get('Order')![0]!;
    const loaded = await withLive(store, () => invoke(rec.default, { ...staff, body: { ROWID: parent.ROWID } }));
    assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
    const values = loaded.body.record as Record<string, Record<string, unknown>[]>;
    assert.deepEqual(values.Lines, [{ Item: 'Bolt' }]);
    assert.deepEqual(values.Notes, [], 'a child form without a read grant contributes no rows');
    assert.equal(Object.hasOwn(values.Lines[0]!, 'Secret'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the live report read returns each row with its subform rows in order', async () => {
  const { dir, files } = emit();
  try {
    const path = [...files.keys()].find((item) => /^functions\/reports\/order-all\.mjs$/.test(item));
    assert.ok(path, [...files.keys()].filter((item) => item.startsWith('functions/reports/')).join(', '));
    const mod = await import(pathToFileURL(join(dir, path)).href);
    const store = memoryDatastore();
    store.tables.set('Order', [{ ROWID: '1', Customer: 'Ann' }]);
    store.tables.set('Order__Lines', [
      { ROWID: '12', parent_id: '1', row_order: 1, Item: 'Nut' },
      { ROWID: '11', parent_id: '1', row_order: 0, Item: 'Bolt' },
    ]);
    const out = await withLive(store, () => invoke(mod.default, { ...staff, body: { op: 'query' } }));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const rows = out.body.rows as Record<string, unknown>[];
    assert.deepEqual(rows[0].Lines, [
      { ROWID: '11', Item: 'Bolt' },
      { ROWID: '12', Item: 'Nut' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record reads bind the named report grant, criteria, and column projection', async () => {
  const source = SOURCE.replace('Order_All = {"View","Edit"}', 'Order_All = {"View","Edit"}\n\t\t\tOrder_Scoped = {"View"}').replace(/\n}\s*$/, `
\tlist Order_Scoped
\t{
\t\tshow all rows from Order [Customer == "Bea"]
\t\t(
\t\t\tCustomer
\t\t)
\t}
}
`);
  const { dir } = emit(source);
  try {
    const mod = await import(pathToFileURL(join(dir, 'functions/aio/order/record.mjs')).href);
    const store = memoryDatastore();
    store.tables.set('Order', [
      { ROWID: '1', Customer: 'Bea', Added_Time: 'system-secret' },
      { ROWID: '2', Customer: 'Alice', Added_Time: 'system-secret' },
    ]);
    const originalQuery = store.query.bind(store);
    let criteria = '';
    store.query = async (table, where, limit, offset = 0) => {
      if (table === 'Order') {
        criteria = where;
        const rows = store.tables.get('Order')!.filter((row) => where.includes(`ROWID = '${row.ROWID}'`) && where.includes(`Customer = 'Bea'`) && row.Customer === 'Bea');
        return rows.slice(offset, offset + limit).map((row) => ({ ...row }));
      }
      return originalQuery(table, where, limit, offset);
    };
    const visible = await withLive(store, () => invoke(mod.default, { ...staff, body: { ROWID: '1', REPORT: 'Order_Scoped' } }));
    assert.equal(visible.status, 200, JSON.stringify(visible.body));
    assert.deepEqual(visible.body.record, { Customer: 'Bea' });
    assert.match(criteria, /Customer = 'Bea'/, 'the named report criteria is ANDed with the exact row id');
    const outside = await withLive(store, () => invoke(mod.default, { ...staff, body: { ROWID: '2', REPORT: 'Order_Scoped' } }));
    assert.equal(outside.status, 404, 'a row outside the named report criteria is not returned');
    const unknown = await withLive(store, () => invoke(mod.default, { ...staff, body: { ROWID: '1', REPORT: 'No_Such_Report' } }));
    assert.equal(unknown.status, 400, 'caller-supplied report names are looked up in the static map');
    const denied = await withLive(store, () => invoke(mod.default, { user: { profile: 'Visitor' }, body: { ROWID: '1', REPORT: 'Order_Scoped' } }));
    assert.equal(denied.status, 403, 'the named report is checked against the profile grant');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
