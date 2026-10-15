/**
 * Delta sync, rollback export and the state file, against a fake Data Store
 * that answers with Catalyst's row and ZCQL shapes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateSchema } from '../../schema/src/generator.js';
import type { FetchLike } from '../../data/src/migrate.js';
import { catalystFailure, textResponse } from '../../data/test/catalyst-row-fake.js';
import { LOADER_REPORT, STATE_FILE, writeState, type Io } from '../src/cli.js';
import { readSourceCsv, readSourceJson } from '../src/csv.js';
import { computeDelta, deletionRefusals, MODIFIED_TIME, type DeltaCheckpoint } from '../src/row-delta.js';
import { rollbackExportCli, syncDeltaCli } from '../src/delta-cli.js';
import { readStoreRows, rollbackExport } from '../src/rollback.js';

const ORG = '10000000000';
const SCOPE = { org: ORG, projectId: '1001', token: 'test-cli-token' };

const APP = `application "Shop"
{
form Vendor
{
must have unique Vendor_Name
(
type = text
displayname = "Vendor Name"
)
Contact
(
type = name
displayname = "Contact"
)
}
form Purchase_Order
{
must have PO_Title
(
type = text
displayname = "PO Title"
)
must have Vendor
(
type = picklist
values = Vendor.ID
displayformat = [Vendor_Name]
)
Order_Date
(
type = date
displayname = "Order Date"
)
Amount
(
type = decimal
displayname = "Amount"
)
}
list All_Vendors
{
show all rows from Vendor
(
Vendor_Name as "Vendor Name"
Contact as "Contact"
)
}
list All_Purchase_Orders
{
show all rows from Purchase_Order
(
PO_Title as "PO Title"
Vendor as "Vendor"
Order_Date as "Order Date"
Amount as "Amount"
)
}
}
`;

/** An app with an inline subform (a child table) and a multi lookup (a junction table). */
const APP_LINES = `application "Shop"
{
form Vendor
{
must have unique Vendor_Name
(
type = text
)
}
form Purchase_Order
{
must have PO_Title
(
type = text
)
Lines
(
type = grid
Item
(
type = text
)
Qty
(
type = number
)
)
Tags
(
type = list
values = Vendor.ID
)
}
}
`;

interface Vendor {
  id: string;
  name: string;
  first?: string;
  last?: string;
  modified: string;
}

interface Order {
  id: string;
  title: string;
  vendor: string;
  date: string;
  amount: string;
  modified: string;
}

const VENDORS: Vendor[] = [
  { id: '1000000000003570021', name: 'Acme', first: 'Ann', last: 'Lee', modified: '01-Oct-2026 09:00:00' },
  { id: '1000000000003570022', name: 'Northwind', first: 'Bo', last: 'Ng', modified: '01-Oct-2026 09:00:00' },
];
const ORDERS: Order[] = [
  { id: '1000000000003570031', title: 'Restock', vendor: VENDORS[0]!.id, date: '05-Oct-2026', amount: '1250.00', modified: '05-Oct-2026 10:00:00' },
  { id: '1000000000003570032', title: 'Bolts', vendor: VENDORS[1]!.id, date: '06-Oct-2026', amount: '487.50', modified: '06-Oct-2026 10:00:00' },
];

/** A Creator JSON report export with record ids and Modified_Time. */
function exportDir(vendors: readonly Vendor[], orders: readonly Order[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-delta-export-'));
  writeFileSync(
    join(dir, 'All_Vendors.json'),
    JSON.stringify({
      All_Vendors: vendors.map((v) => ({ ID: v.id, Vendor_Name: v.name, Contact: { first_name: v.first ?? '', last_name: v.last ?? '' }, Modified_Time: v.modified })),
    }),
  );
  writeFileSync(
    join(dir, 'All_Purchase_Orders.json'),
    JSON.stringify({
      All_Purchase_Orders: orders.map((o) => ({
        ID: o.id,
        PO_Title: o.title,
        Vendor: { ID: o.vendor, display_value: vendors.find((v) => v.id === o.vendor)?.name ?? '' },
        Order_Date: o.date,
        Amount: o.amount,
        Modified_Time: o.modified,
      })),
    }),
  );
  return dir;
}

/** An extracted Creator backup holding the same two forms (data/data_1/ loose files). */
function backupDir(vendors: readonly Vendor[], orders: readonly Order[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-delta-backup-'));
  const root = join(dir, 'shop_v1_test');
  const data = join(root, 'data', 'data_1');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(root, 'app_manifest.xml'), '<app-manifest><app-meta-info><link-name>shop</link-name></app-meta-info></app-manifest>');
  writeFileSync(
    join(data, 'appInfo.xml'),
    '<info><basic-info><dc>in</dc></basic-info><app-meta-info><application-link-name>shop</application-link-name><application-time-zone>Asia/Kolkata</application-time-zone></app-meta-info></info>',
  );
  writeFileSync(join(data, 'appDataInfo.xml'), `<app-data-info><records-count>${vendors.length + orders.length}</records-count></app-data-info>`);
  const quote = (cell: string) => `"${cell.replace(/"/g, '""')}"`;
  const csv = (headers: string[], rows: string[][]) => [headers, ...rows].map((row) => row.map(quote).join(',')).join('\n') + '\n';
  const SYS = ['Added_Time', 'Added_User', 'Modified_Time', 'Modified_User', 'Record_Status', 'ZC_Record_Type'];
  writeFileSync(
    join(data, 'basic#Vendor.csv'),
    csv(
      [...SYS, 'ID', 'Vendor_Name'],
      vendors.map((v) => ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', v.id, v.name]),
    ),
  );
  writeFileSync(
    join(data, 'basic#Purchase_Order.csv'),
    csv(
      [...SYS, 'ID', 'PO_Title', 'Order_Date', 'Amount'],
      orders.map((o) => ['1791412505000', 'Z:a@example.test', '1791412605000', 'Z:a@example.test', '0', '1', o.id, o.title, o.date, o.amount]),
    ),
  );
  writeFileSync(
    join(data, 'rel#Vendor#Purchase_Order.csv'),
    csv(['Purchase_Order#RECORD_LINK_ID#BASE', 'Vendor#RECORD_LINK_ID#REF'], orders.map((o) => [o.id, o.vendor])),
  );
  return root;
}

/**
 * A CSV export of APP_LINES: Vendor and Purchase_Order carry record ids, the
 * Purchase_Order__Lines child table has its own file, and the Tags cell expands
 * to Purchase_Order__Tags junction rows. `counts` true writes the two form
 * counts; an object writes it as counts.json verbatim.
 */
function exportCsvDir(opts: { lines?: string[]; tags?: string; counts?: boolean | Record<string, number> } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-delta-csv-'));
  writeFileSync(join(dir, 'Vendor.csv'), 'ID,Vendor_Name\n10,Acme\n11,Beta\n');
  writeFileSync(join(dir, 'Purchase_Order.csv'), `ID,PO_Title,Tags\n40,Batch,"${opts.tags ?? '10,11'}"\n`);
  writeFileSync(join(dir, 'Purchase_Order__Lines.csv'), `ID,Parent_ID,Item,Qty\n${(opts.lines ?? ['50,40,Widget,2', '51,40,Gadget,1']).join('\n')}\n`);
  if (opts.counts) writeFileSync(join(dir, 'counts.json'), JSON.stringify(opts.counts === true ? { Vendor: 2, Purchase_Order: 1 } : opts.counts));
  return dir;
}

/** Thirty Purchase_Order__Lines rows (ids 50-79), so one dropped row stays under the mass-delete cap. */
const LINES30 = Array.from({ length: 30 }, (_, index) => `${50 + index},40,Item_${index},1`);

/**
 * An extracted Creator backup of APP_LINES: two vendors, one order, two Lines
 * child rows linked by the rel file, and two Tags junction links. `lines: []`
 * omits the child data file; `lineRefs` lists the rel pairs to write;
 * `tags` lists the junction pairs to write; `vendors` lists the vendor rows.
 */
function backupLinesDir(opts: { lines?: string[][]; lineRefs?: string[][]; tags?: string[][]; vendors?: string[][] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-delta-lines-backup-'));
  const root = join(dir, 'shop_v1_test');
  const data = join(root, 'data', 'data_1');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(root, 'app_manifest.xml'), '<app-manifest><app-meta-info><link-name>shop</link-name></app-meta-info></app-manifest>');
  writeFileSync(
    join(data, 'appInfo.xml'),
    '<info><basic-info><dc>in</dc></basic-info><app-meta-info><application-link-name>shop</application-link-name><application-time-zone>Asia/Kolkata</application-time-zone></app-meta-info></info>',
  );
  const vendors = opts.vendors ?? [
    ['10', 'Acme'],
    ['11', 'Beta'],
  ];
  writeFileSync(join(data, 'appDataInfo.xml'), `<app-data-info><records-count>${vendors.length + 1}</records-count></app-data-info>`);
  const quote = (cell: string) => `"${cell.replace(/"/g, '""')}"`;
  const csv = (headers: string[], rows: string[][]) => [headers, ...rows].map((row) => row.map(quote).join(',')).join('\n') + '\n';
  const SYS = ['Added_Time', 'Added_User', 'Modified_Time', 'Modified_User', 'Record_Status', 'ZC_Record_Type'];
  const stamp = ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1'];
  writeFileSync(
    join(data, 'basic#Vendor.csv'),
    csv(
      [...SYS, 'ID', 'Vendor_Name'],
      vendors.map((v) => [...stamp, ...v]),
    ),
  );
  writeFileSync(join(data, 'basic#Purchase_Order.csv'), csv([...SYS, 'ID', 'PO_Title'], [[...stamp, '40', 'Batch']]));
  const lines =
    opts.lines ?? [
      [...stamp, '50', 'Widget', '2'],
      [...stamp, '51', 'Gadget', '1'],
    ];
  if (lines.length) {
    writeFileSync(join(data, 'basic#Lines@Purchase_Order.csv'), csv([...SYS, 'ID', 'Item', 'Qty'], lines));
  }
  const lineRefs = opts.lineRefs ?? [
    ['40', '50'],
    ['40', '51'],
  ];
  if (lineRefs.length) {
    writeFileSync(join(data, 'rel#Lines#Purchase_Order.csv'), csv(['Purchase_Order#RECORD_LINK_ID#BASE', 'Lines#RECORD_LINK_ID#REF'], lineRefs));
  }
  const tags = opts.tags ?? [
    ['40', '10'],
    ['40', '11'],
  ];
  if (tags.length) {
    writeFileSync(join(data, 'rel#Tags#Purchase_Order.csv'), csv(['Purchase_Order#RECORD_LINK_ID#BASE', 'Vendor#RECORD_LINK_ID#REF'], tags));
  }
  return root;
}

function backupLinesArgs(ws: ReturnType<typeof workspace>, dir: string, ...extra: string[]): string[] {
  return ['--source-backup', dir, '--ds', ws.ds, '--since', ws.state, '--project', '1001', '--org', ORG, '--projects', ws.projects, ...extra];
}

interface FakeStore {
  fetch: FetchLike;
  tables: Map<string, Record<string, unknown>[]>;
  writes: { method: string; table: string; body?: unknown }[];
}

/**
 * Data Store fake: POST/PUT /table/<t>/row with a JSON array, DELETE /table/<t>/row/<ROWID>,
 * and ZCQL `SELECT * ... WHERE c2c_source_id IN (...)` or `... ORDER BY ROWID LIMIT o, n`
 * answered as {"status":"success","data":[{"<Table>":{...}}]}.
 */
function fakeStore(): FakeStore {
  const tables = new Map<string, Record<string, unknown>[]>();
  const writes: FakeStore['writes'] = [];
  let next = 10000000000000001n;
  const rowsOf = (table: string) => {
    const list = tables.get(table) ?? [];
    tables.set(table, list);
    return list;
  };
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    if (method === 'POST' && path.endsWith('/query')) {
      const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
      const table = /FROM\s+(\w+)/.exec(sql)![1]!;
      let rows = rowsOf(table);
      const inList = /IN \((.*)\)/.exec(sql);
      if (inList) {
        const ids = new Set([...inList[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]));
        rows = rows.filter((row) => ids.has(String(row.c2c_source_id)));
      }
      if (/ORDER BY\s+ROWID/i.test(sql)) {
        rows = [...rows].sort((a, b) => {
          const [x, y] = [String(a.ROWID ?? ''), String(b.ROWID ?? '')];
          return x.length !== y.length && /^\d+$/.test(x) && /^\d+$/.test(y) ? x.length - y.length : x < y ? -1 : x > y ? 1 : 0;
        });
      }
      // ZCQL LIMIT offsets are 1-based and 0 is clamped to 1.
      const limit = /LIMIT (\d+), (\d+)/.exec(sql);
      if (limit) {
        const from = Math.max(1, Number(limit[1])) - 1;
        rows = rows.slice(from, from + Number(limit[2]));
      }
      return textResponse(JSON.stringify({ status: 'success', data: rows.map((row) => ({ [table]: row })) }));
    }
    const match = /\/table\/(\w+)\/row(?:\/(\d+))?$/.exec(path);
    if (!match) return catalystFailure(404, 'INVALID_URL_PATTERN', 'Please check if the URL trying to access is a correct one');
    const table = match[1]!;
    const list = rowsOf(table);
    if (method === 'DELETE') {
      const index = list.findIndex((row) => row.ROWID === match[2]);
      if (index < 0) return catalystFailure(404, 'NO_SUCH_ROW', 'No such row');
      list.splice(index, 1);
      writes.push({ method, table });
      return textResponse(JSON.stringify({ status: 'success', data: {} }));
    }
    const body = JSON.parse(init?.body ?? 'null') as Record<string, unknown>[];
    writes.push({ method, table, body });
    if (method === 'POST') {
      const stored = body.map((row) => ({ ...row, ROWID: String(next++) }));
      list.push(...stored);
      return textResponse(JSON.stringify({ status: 'success', data: stored }));
    }
    if (method === 'PUT') {
      const out: Record<string, unknown>[] = [];
      for (const row of body) {
        const found = list.find((item) => item.ROWID === row.ROWID);
        if (!found) return catalystFailure(404, 'NO_SUCH_ROW', 'No such row');
        Object.assign(found, row);
        out.push(found);
      }
      return textResponse(JSON.stringify({ status: 'success', data: out }));
    }
    return catalystFailure(400, 'INVALID_INPUT', 'unexpected method');
  };
  return { fetch, tables, writes };
}

function workspace(app: string = APP): { ds: string; projects: string; state: string } {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-delta-'));
  const ds = join(dir, 'shop.ds');
  writeFileSync(ds, app);
  const projects = join(dir, 'projects.json');
  writeFileSync(projects, JSON.stringify({ org: ORG, dc: 'in', env: 'Development', projects: { 'c2c-shop': '1001' } }));
  const state = join(dir, 'deploy');
  mkdirSync(state);
  return { ds, projects, state };
}

function cli(store: FakeStore) {
  let out = '';
  let err = '';
  let fetched = 0;
  const io: Io = {
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    env: { X_ZC_CREDENTIAL_PATH: '/nonexistent/credential' },
    cliDc: () => undefined,
    spawn: async () => assert.fail('no catalyst CLI spawn in a delta test'),
    fetch: async (url, init) => {
      fetched += 1;
      return store.fetch(url, init);
    },
    rest: async (call) => {
      if (call.method === 'GET' && call.path === '/baas/v1/project/1001') return { status: 200, body: { data: { id: '1001', org_id: ORG } } };
      return assert.fail(`unexpected admin REST ${call.method} ${call.path}`);
    },
    accessToken: async () => SCOPE.token,
    sleep: async () => {},
  };
  return { io, out: () => out, err: () => err, fetched: () => fetched };
}

function syncArgs(ws: ReturnType<typeof workspace>, dir: string, ...extra: string[]): string[] {
  return ['--source-json', dir, '--ds', ws.ds, '--since', ws.state, '--project', '1001', '--org', ORG, '--projects', ws.projects, ...extra];
}

function syncCsvArgs(ws: ReturnType<typeof workspace>, dir: string, ...extra: string[]): string[] {
  return ['--source-csv', dir, '--ds', ws.ds, '--since', ws.state, '--project', '1001', '--org', ORG, '--projects', ws.projects, ...extra];
}

async function baseline(ws: ReturnType<typeof workspace>, store: FakeStore): Promise<void> {
  const run = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, exportDir(VENDORS, ORDERS), '--confirm'), run.io), 0, run.err());
}

function checkpointOf(ws: ReturnType<typeof workspace>): DeltaCheckpoint {
  return (JSON.parse(readFileSync(join(ws.state, STATE_FILE), 'utf8')) as { delta: DeltaCheckpoint }).delta;
}

test('sync-delta plan prints counts per table and writes nothing', async () => {
  const ws = workspace();
  const store = fakeStore();
  const run = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, exportDir(VENDORS, ORDERS)), run.io), 0, run.err());
  assert.match(run.out(), /^checkpoint: none/m);
  assert.match(run.out(), /^- Vendor new 2 changed 0 unchanged 0 deleted 0$/m);
  assert.match(run.out(), /^- Purchase_Order new 2 changed 0 unchanged 0 deleted 0$/m);
  assert.match(run.out(), /^writes: no$/m);
  assert.equal(run.fetched(), 0);
  assert.equal(existsSync(join(ws.state, STATE_FILE)), false);
});

test('sync-delta confirm reports planned writes and the applied upsert count', async () => {
  const ws = workspace();
  const store = fakeStore();
  const run = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, exportDir(VENDORS, ORDERS), '--confirm'), run.io), 0, run.err());
  assert.match(run.out(), /^writes: yes \(4 planned upserts\)$/m);
  assert.doesNotMatch(run.out(), /writes: no/);
  assert.match(run.out(), /^applied: 4 upsert\(s\)$/m);
  assert.equal(store.tables.get('Vendor')?.length, 2);
  assert.equal(store.tables.get('Purchase_Order')?.length, 2);
  assert.ok(run.fetched() > 0);
});

test('an export folder that already holds the loader report still reads as a source', async () => {
  const ws = workspace();
  const dir = exportDir(VENDORS, ORDERS);
  // A confirmed migrate-data run leaves its integrity report next to the export.
  writeFileSync(join(dir, LOADER_REPORT), JSON.stringify({ kind: 'loader-integrity', integrity: {} }));
  const run = cli(fakeStore());
  assert.equal(await syncDeltaCli(syncArgs(ws, dir), run.io), 0, run.err());
  assert.match(run.out(), /^- Vendor new 2 changed 0 unchanged 0 deleted 0$/m);
});

test('sync-delta re-run with the same export makes zero writes', async () => {
  const ws = workspace();
  const store = fakeStore();
  await baseline(ws, store);
  assert.equal(store.tables.get('Vendor')?.length, 2);
  assert.equal(store.tables.get('Purchase_Order')?.length, 2);
  const writes = store.writes.length;
  const checkpoint = checkpointOf(ws);
  assert.equal(checkpoint.since, '2026-10-06 10:00:00');
  assert.equal(Object.keys(checkpoint.tables.Vendor!.rows).length, 2);
  // No field value and no personal column is kept in the state file.
  assert.equal(readFileSync(join(ws.state, STATE_FILE), 'utf8').includes('Acme'), false);

  const again = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, exportDir(VENDORS, ORDERS), '--confirm'), again.io), 0, again.err());
  assert.match(again.out(), /^- Purchase_Order new 0 changed 0 unchanged 2 deleted 0$/m);
  assert.match(again.out(), /^applied: none/m);
  assert.equal(store.writes.length, writes);
  assert.equal(again.fetched(), 0);
});

test('sync-delta reads an extracted Creator backup as a source', async () => {
  const ws = workspace();
  const store = fakeStore();
  const args = (dir: string, ...extra: string[]) => [
    '--source-backup', dir, '--ds', ws.ds, '--since', ws.state, '--project', '1001', '--org', ORG, '--projects', ws.projects, ...extra,
  ];
  const plan = cli(store);
  assert.equal(await syncDeltaCli(args(backupDir(VENDORS, ORDERS)), plan.io), 0, plan.err());
  assert.match(plan.out(), /^- Vendor new 2 changed 0 unchanged 0 deleted 0$/m);
  assert.match(plan.out(), /^- Purchase_Order new 2 changed 0 unchanged 0 deleted 0$/m);
  assert.equal(plan.fetched(), 0);

  const run = cli(store);
  assert.equal(await syncDeltaCli(args(backupDir(VENDORS, ORDERS), '--confirm'), run.io), 0, run.err());
  assert.equal(store.tables.get('Vendor')?.length, 2);
  assert.equal(store.tables.get('Purchase_Order')?.length, 2);
  // The lookup links through the rel# file to the parent's new ROWID.
  const acme = store.tables.get('Vendor')!.find((row) => row.c2c_source_id === VENDORS[0]!.id)!;
  assert.equal(store.tables.get('Purchase_Order')!.find((row) => row.c2c_source_id === ORDERS[0]!.id)!.Vendor, acme.ROWID);
  // A second plan against the recorded checkpoint holds no changes.
  const again = cli(store);
  assert.equal(await syncDeltaCli(args(backupDir(VENDORS, ORDERS)), again.io), 0, again.err());
  assert.match(again.out(), /^- Vendor new 0 changed 0 unchanged 2 deleted 0$/m);
});

test('sync-delta first run matches rows already in the store by source id and never duplicates them', async () => {
  const ws = workspace();
  const store = fakeStore();
  await baseline(ws, store);
  const other = workspace();
  const run = cli(store);
  const writes = store.writes.length;
  assert.equal(await syncDeltaCli(syncArgs(other, exportDir(VENDORS, ORDERS), '--confirm'), run.io), 0, run.err());
  assert.match(run.out(), /^Purchase_Order: inserted 0 updated 0 unchanged-in-store 2 deleted 0$/m);
  assert.equal(store.tables.get('Purchase_Order')?.length, 2);
  assert.equal(store.writes.length, writes);
});

test('sync-delta updates a changed record in place by ROWID', async () => {
  const ws = workspace();
  const store = fakeStore();
  await baseline(ws, store);
  const before = store.tables.get('Purchase_Order')!.find((row) => row.c2c_source_id === ORDERS[1]!.id)!;
  const rowid = before.ROWID;
  const changed = ORDERS.map((o, i) => (i === 1 ? { ...o, amount: '500.00', modified: '07-Oct-2026 08:00:00' } : o));
  const plan = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, exportDir(VENDORS, changed)), plan.io), 0, plan.err());
  assert.match(plan.out(), /^- Purchase_Order new 0 changed 1 unchanged 1 deleted 0$/m);
  const writes = store.writes.length;
  const run = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, exportDir(VENDORS, changed), '--confirm'), run.io), 0, run.err());
  assert.match(run.out(), /^Purchase_Order: inserted 0 updated 1 unchanged-in-store 0 deleted 0$/m);
  const added = store.writes.slice(writes);
  assert.deepEqual(added.map((w) => `${w.method} ${w.table}`), ['PUT Purchase_Order']);
  assert.equal((added[0]!.body as Record<string, unknown>[])[0]!.ROWID, rowid);
  assert.equal(store.tables.get('Purchase_Order')!.length, 2);
  assert.equal(store.tables.get('Purchase_Order')!.find((row) => row.ROWID === rowid)!.Amount, '500.00');
  assert.equal(checkpointOf(ws).since, '2026-10-07 08:00:00');
});

test('sync-delta links a new child to a parent that is already stored', async () => {
  const ws = workspace();
  const store = fakeStore();
  await baseline(ws, store);
  const acme = store.tables.get('Vendor')!.find((row) => row.c2c_source_id === VENDORS[0]!.id)!;
  const order: Order = { id: '1000000000003570033', title: 'Washers', vendor: VENDORS[0]!.id, date: '07-Oct-2026', amount: '12.50', modified: '07-Oct-2026 09:00:00' };
  const writes = store.writes.length;
  const run = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, exportDir(VENDORS, [...ORDERS, order]), '--confirm'), run.io), 0, run.err());
  assert.match(run.out(), /^- Vendor new 0 changed 0 unchanged 2 deleted 0$/m);
  const added = store.writes.slice(writes);
  assert.deepEqual(added.map((w) => `${w.method} ${w.table}`), ['POST Purchase_Order']);
  const stored = store.tables.get('Purchase_Order')!.find((row) => row.c2c_source_id === order.id)!;
  assert.equal(stored.Vendor, acme.ROWID);
  assert.equal(store.tables.get('Purchase_Order')!.length, 3);
});

test('sync-delta reports a deleted record and lists the id it would delete', async () => {
  const ws = workspace();
  const store = fakeStore();
  await baseline(ws, store);
  const dir = exportDir(VENDORS, ORDERS.slice(0, 1));
  const writes = store.writes.length;
  const run = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, dir, '--confirm'), run.io), 0, run.err());
  assert.match(run.out(), /^- Purchase_Order new 0 changed 0 unchanged 1 deleted 1$/m);
  assert.match(run.out(), /^  delete ids: 1000000000003570032$/m);
  assert.match(run.out(), /^deletions: 1 \(reported only; pass --apply-deletes to delete them\)$/m);
  assert.equal(store.writes.length, writes);
  assert.equal(store.tables.get('Purchase_Order')!.length, 2);
  assert.deepEqual(checkpointOf(ws).tables.Purchase_Order!.deleted, [ORDERS[1]!.id]);

  const again = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, dir), again.io), 0, again.err());
  assert.match(again.out(), /^- Purchase_Order new 0 changed 0 unchanged 1 deleted 1$/m);
});

test('sync-delta --apply-deletes refuses an export that cannot prove it holds every record', async () => {
  const ws = workspace();
  const store = fakeStore();
  await baseline(ws, store);
  const dir = exportDir(VENDORS, ORDERS.slice(0, 1));
  const run = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, dir, '--confirm'), run.io), 0, run.err());
  assert.deepEqual(checkpointOf(ws).tables.Purchase_Order!.deleted, [ORDERS[1]!.id]);

  // A report export with no counts.json cannot tell a filter from a deletion.
  const refused = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, dir, '--confirm', '--apply-deletes'), refused.io), 1);
  assert.match(refused.out(), /Purchase_Order: the source does not prove it holds every record of this table/);
  assert.match(refused.err(), /--apply-deletes refused: Purchase_Order: the source does not prove/);
  assert.equal(store.writes.filter((write) => write.method === 'DELETE').length, 0);
  assert.equal(store.tables.get('Purchase_Order')!.length, 2);
  // The refusal does not record a checkpoint: the pending deletion stays.
  assert.deepEqual(checkpointOf(ws).tables.Purchase_Order!.deleted, [ORDERS[1]!.id]);
});

test('sync-delta --apply-deletes --allow-mass-delete still refuses an export without a completeness proof', async () => {
  const ws = workspace();
  const store = fakeStore();
  await baseline(ws, store);
  const dir = exportDir(VENDORS, ORDERS.slice(0, 1));
  const run = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, dir, '--confirm'), run.io), 0, run.err());
  assert.deepEqual(checkpointOf(ws).tables.Purchase_Order!.deleted, [ORDERS[1]!.id]);

  // --allow-mass-delete lifts only the share cap; it never waives the proof
  // that the export holds every record.
  const refused = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, dir, '--confirm', '--apply-deletes', '--allow-mass-delete', '--max-delete-percent', '100'), refused.io), 1);
  assert.match(refused.err(), /--apply-deletes refused: Purchase_Order: the source does not prove/);
  assert.equal(store.writes.filter((write) => write.method === 'DELETE').length, 0);
  assert.equal(store.tables.get('Purchase_Order')!.length, 2);
  assert.deepEqual(checkpointOf(ws).tables.Purchase_Order!.deleted, [ORDERS[1]!.id]);
});

test('sync-delta --apply-deletes honours the mass-delete cap and --allow-mass-delete', async () => {
  const ws = workspace();
  const store = fakeStore();
  await baseline(ws, store);
  const dir = exportDir(VENDORS, ORDERS.slice(0, 1));
  // counts.json pins each form's row count, so the export proves completeness.
  writeFileSync(join(dir, 'counts.json'), JSON.stringify({ Vendor: 2, Purchase_Order: 1 }));
  const run = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, dir, '--confirm'), run.io), 0, run.err());

  // 1 of 2 remembered records is over the default 5% cap.
  const capped = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, dir, '--confirm', '--apply-deletes'), capped.io), 1);
  assert.match(capped.err(), /Purchase_Order: 1 of 2 remembered record\(s\) \(50%\) is over the 5% limit/);
  assert.equal(store.writes.filter((write) => write.method === 'DELETE').length, 0);

  // --allow-mass-delete lifts the cap; a raised cap works the same way.
  const deleted = store.tables.get('Purchase_Order')!.length;
  const raised = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, dir, '--confirm', '--apply-deletes', '--max-delete-percent', '60'), raised.io), 0, raised.err());
  assert.equal(store.tables.get('Purchase_Order')!.length, deleted - 1);

  const ws2 = workspace();
  await baseline(ws2, store);
  const allowed = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws2, dir, '--confirm', '--apply-deletes', '--allow-mass-delete'), allowed.io), 0, allowed.err());
  assert.deepEqual(store.tables.get('Purchase_Order')!.map((row) => row.c2c_source_id), [ORDERS[0]!.id]);
  assert.equal(checkpointOf(ws2).tables.Purchase_Order!.deleted, undefined);

  // A bad cap value is a usage error, not a sync failure.
  const bad = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws2, dir, '--confirm', '--apply-deletes', '--max-delete-percent', 'abc'), bad.io), 2);
  assert.match(bad.err(), /--max-delete-percent must be a number from 0 to 100/);
});

test('sync-delta --apply-deletes applies on a full backup source', async () => {
  const ws = workspace();
  const store = fakeStore();
  const args = (dir: string, ...extra: string[]) => [
    '--source-backup', dir, '--ds', ws.ds, '--since', ws.state, '--project', '1001', '--org', ORG, '--projects', ws.projects, ...extra,
  ];
  const first = cli(store);
  assert.equal(await syncDeltaCli(args(backupDir(VENDORS, ORDERS), '--confirm'), first.io), 0, first.err());
  const apply = cli(store);
  assert.equal(await syncDeltaCli(args(backupDir(VENDORS, ORDERS.slice(0, 1)), '--confirm', '--apply-deletes', '--allow-mass-delete'), apply.io), 0, apply.err());
  assert.deepEqual(store.tables.get('Purchase_Order')!.map((row) => row.c2c_source_id), [ORDERS[0]!.id]);
});

test('sync-delta deletes nothing when the backup is missing the child data file', async () => {
  const ws = workspace(APP_LINES);
  const store = fakeStore();
  const run = cli(store);
  assert.equal(await syncDeltaCli(backupLinesArgs(ws, backupLinesDir(), '--confirm'), run.io), 0, run.err());
  assert.equal(store.tables.get('Purchase_Order__Lines')?.length, 2);

  // The child data file is gone, so the child table is missing from the
  // source: never complete for it, never deleted from it.
  const missing = cli(store);
  assert.equal(await syncDeltaCli(backupLinesArgs(ws, backupLinesDir({ lines: [] }), '--confirm'), missing.io), 0, missing.err());
  assert.match(missing.out(), /^- Purchase_Order__Lines missing from the source; deletions not computed$/m);

  const apply = cli(store);
  assert.equal(await syncDeltaCli(backupLinesArgs(ws, backupLinesDir({ lines: [] }), '--confirm', '--apply-deletes', '--allow-mass-delete'), apply.io), 0, apply.err());
  assert.match(apply.out(), /^- Purchase_Order__Lines missing from the source; deletions not computed$/m);
  assert.equal(store.writes.filter((write) => write.method === 'DELETE').length, 0);
  assert.deepEqual(
    store.tables.get('Purchase_Order__Lines')!.map((row) => row.c2c_source_id).sort(),
    ['50', '51'],
  );
  // The remembered ids stay in the checkpoint, pending the file's return.
  assert.deepEqual(Object.keys(checkpointOf(ws).tables.Purchase_Order__Lines!.rows).sort(), ['50', '51']);
});

test('sync-delta --apply-deletes refuses a backup that drops a child row its data file holds', async () => {
  const ws = workspace(APP_LINES);
  const store = fakeStore();
  const run = cli(store);
  assert.equal(await syncDeltaCli(backupLinesArgs(ws, backupLinesDir(), '--confirm'), run.io), 0, run.err());
  assert.equal(store.tables.get('Purchase_Order__Lines')?.length, 2);

  // Both child rows are in the data file but the rel file links only one: row
  // 51 cannot be placed, so the backup does not prove the child table complete.
  const dir = backupLinesDir({ lineRefs: [['40', '50']] });
  const pending = cli(store);
  assert.equal(await syncDeltaCli(backupLinesArgs(ws, dir, '--confirm'), pending.io), 0, pending.err());
  assert.match(pending.out(), /^- Purchase_Order__Lines new 0 changed 0 unchanged 1 deleted 1$/m);
  assert.deepEqual(checkpointOf(ws).tables.Purchase_Order__Lines!.deleted, ['51']);

  // --allow-mass-delete lifts only the share cap — neither applies a delete
  // the source cannot prove.
  for (const extra of [[], ['--allow-mass-delete']]) {
    const refused = cli(store);
    assert.equal(await syncDeltaCli(backupLinesArgs(ws, dir, '--confirm', '--apply-deletes', ...extra), refused.io), 1);
    assert.match(refused.out(), /Purchase_Order__Lines: the source does not prove it holds every record of this table/);
    assert.match(refused.err(), /--apply-deletes refused: Purchase_Order__Lines: the source does not prove/);
    assert.match(refused.err(), /add "Purchase_Order__Lines": <total> to counts\.json/);
    assert.equal(store.writes.filter((write) => write.method === 'DELETE').length, 0);
    assert.equal(store.tables.get('Purchase_Order__Lines')?.length, 2);
    // The refused run records no checkpoint, so the id stays pending.
    assert.deepEqual(checkpointOf(ws).tables.Purchase_Order__Lines!.deleted, ['51']);
  }
});

test('sync-delta --apply-deletes refuses a backup that drops a junction row its rel file holds', async () => {
  const ws = workspace(APP_LINES);
  const store = fakeStore();
  const run = cli(store);
  assert.equal(await syncDeltaCli(backupLinesArgs(ws, backupLinesDir(), '--confirm'), run.io), 0, run.err());
  assert.equal(store.tables.get('Purchase_Order__Tags')?.length, 2);

  // The rel file still names vendor 11 but the vendor file lost the row: the
  // junction link cannot be placed, so the backup does not prove the junction
  // table complete.
  const dir = backupLinesDir({ vendors: [['10', 'Acme']] });
  const pending = cli(store);
  assert.equal(await syncDeltaCli(backupLinesArgs(ws, dir, '--confirm'), pending.io), 0, pending.err());
  assert.match(pending.out(), /^- Purchase_Order__Tags new 0 changed 0 unchanged 1 deleted 1$/m);

  const refused = cli(store);
  assert.equal(await syncDeltaCli(backupLinesArgs(ws, dir, '--confirm', '--apply-deletes', '--allow-mass-delete'), refused.io), 1);
  assert.match(refused.err(), /--apply-deletes refused: Purchase_Order__Tags: the source does not prove/);
  assert.match(refused.err(), /add "Purchase_Order__Tags": <total> to counts\.json/);
  assert.equal(store.writes.filter((write) => write.method === 'DELETE').length, 0);
  assert.equal(store.tables.get('Purchase_Order__Tags')?.length, 2);
});

test('sync-delta --apply-deletes refuses a partial subform file the form counts do not cover', async () => {
  const ws = workspace(APP_LINES);
  const store = fakeStore();
  const run = cli(store);
  assert.equal(await syncDeltaCli(syncCsvArgs(ws, exportCsvDir({ counts: true, lines: LINES30 }), '--confirm'), run.io), 0, run.err());
  assert.equal(store.tables.get('Purchase_Order__Lines')?.length, 30);

  // counts.json counts parent records; a separate Purchase_Order__Lines.csv can
  // still be filtered, so the child table never inherits the parent form's proof.
  const dir = exportCsvDir({ counts: true, lines: LINES30.slice(0, 29) });
  const pending = cli(store);
  assert.equal(await syncDeltaCli(syncCsvArgs(ws, dir, '--confirm'), pending.io), 0, pending.err());
  assert.match(pending.out(), /^- Purchase_Order__Lines new 0 changed 0 unchanged 29 deleted 1$/m);
  assert.deepEqual(checkpointOf(ws).tables.Purchase_Order__Lines!.deleted, ['79']);

  // 1 of 30 remembered rows is under the mass-delete cap, and --allow-mass-delete
  // lifts only the cap — neither applies a delete the source cannot prove.
  for (const extra of [[], ['--allow-mass-delete']]) {
    const refused = cli(store);
    assert.equal(await syncDeltaCli(syncCsvArgs(ws, dir, '--confirm', '--apply-deletes', ...extra), refused.io), 1);
    assert.match(refused.out(), /Purchase_Order__Lines: the source does not prove it holds every record of this table/);
    assert.match(refused.err(), /--apply-deletes refused: Purchase_Order__Lines: the source does not prove/);
    assert.match(refused.err(), /add "Purchase_Order__Lines": <total> to counts\.json/);
    assert.equal(store.writes.filter((write) => write.method === 'DELETE').length, 0);
    assert.equal(store.tables.get('Purchase_Order__Lines')?.length, 30);
    // The refused run records no checkpoint, so the id stays pending.
    assert.deepEqual(checkpointOf(ws).tables.Purchase_Order__Lines!.deleted, ['79']);
  }
});

test('sync-delta --apply-deletes applies a dropped subform row when counts.json pins the child table', async () => {
  const ws = workspace(APP_LINES);
  const store = fakeStore();
  const run = cli(store);
  assert.equal(await syncDeltaCli(syncCsvArgs(ws, exportCsvDir({ counts: true, lines: LINES30 }), '--confirm'), run.io), 0, run.err());

  const dir = exportCsvDir({ counts: { Vendor: 2, Purchase_Order: 1, Purchase_Order__Lines: 29 }, lines: LINES30.slice(0, 29) });
  const deleted = cli(store);
  assert.equal(await syncDeltaCli(syncCsvArgs(ws, dir, '--confirm', '--apply-deletes'), deleted.io), 0, deleted.err());
  assert.equal(store.tables.get('Purchase_Order__Lines')?.length, 29);
  assert.equal(store.tables.get('Purchase_Order__Lines')!.some((row) => row.c2c_source_id === '79'), false);
  assert.equal(checkpointOf(ws).tables.Purchase_Order__Lines!.deleted, undefined);
});

test('counts.json accepts a generated table count and refuses a wrong or unknown one', () => {
  const app = deriveIr(parse(APP_LINES));
  // The child file holds 29 rows but its own count says 30: refused at load.
  const mismatch = exportCsvDir({ counts: { Vendor: 2, Purchase_Order: 1, Purchase_Order__Lines: 30 }, lines: LINES30.slice(0, 29) });
  assert.throws(() => readSourceCsv(mismatch, app), /CSV row count for Purchase_Order__Lines is 29 but counts\.json says 30/);
  // A name that is neither a form nor a generated table is refused too.
  const unknown = exportCsvDir({ counts: { Vendor: 2, Purchase_Order: 1, Purchase_Order__Nope: 1 } });
  assert.throws(() => readSourceCsv(unknown, app), /counts\.json names unknown form or table Purchase_Order__Nope/);
});

test('sync-delta --apply-deletes needs the junction table to have its own counts.json entry', async () => {
  const ws = workspace(APP_LINES);
  const store = fakeStore();
  const run = cli(store);
  assert.equal(await syncDeltaCli(syncCsvArgs(ws, exportCsvDir({ counts: true }), '--confirm'), run.io), 0, run.err());
  assert.equal(store.tables.get('Purchase_Order__Tags')?.length, 2);

  // The Tags cell dropped one link. Matching form counts prove nothing about the
  // junction — only its own counts.json entry or a full backup does.
  const refused = cli(store);
  assert.equal(
    await syncDeltaCli(syncCsvArgs(ws, exportCsvDir({ counts: true, tags: '10' }), '--confirm', '--apply-deletes', '--allow-mass-delete'), refused.io),
    1,
  );
  assert.match(refused.err(), /--apply-deletes refused: Purchase_Order__Tags: the source does not prove/);
  assert.equal(store.writes.filter((write) => write.method === 'DELETE').length, 0);
  assert.equal(store.tables.get('Purchase_Order__Tags')?.length, 2);

  const deleted = cli(store);
  assert.equal(
    await syncDeltaCli(
      syncCsvArgs(ws, exportCsvDir({ counts: { Vendor: 2, Purchase_Order: 1, Purchase_Order__Tags: 1 }, tags: '10' }), '--confirm', '--apply-deletes', '--allow-mass-delete'),
      deleted.io,
    ),
    0,
    deleted.err(),
  );
  assert.equal(store.tables.get('Purchase_Order__Tags')?.length, 1);
  assert.equal(store.tables.get('Purchase_Order__Tags')![0]!.c2c_source_id, '40__Tags__10');
});

test('a generated table proves complete only under its own counts.json entry', () => {
  const app = deriveIr(parse(APP_LINES));
  const first = computeDelta(app, readSourceCsv(exportCsvDir({ counts: true }), app), undefined);
  const loaded = readSourceCsv(exportCsvDir({ counts: true, tags: '10', lines: ['50,40,Widget,2'] }), app);
  const plan = computeDelta(app, loaded, first.next);
  assert.deepEqual(plan.tables.find((table) => table.table === 'Purchase_Order__Lines')!.deleted, ['51']);
  assert.deepEqual(plan.tables.find((table) => table.table === 'Purchase_Order__Tags')!.deleted, ['40__Tags__11']);
  // Both linked forms match their counts, yet the child and the junction stay
  // refused: the completeness proof is per generated table, never derived.
  assert.deepEqual(
    deletionRefusals(loaded, plan, { allowMassDelete: true })
      .map((item) => item.table)
      .sort(),
    ['Purchase_Order__Lines', 'Purchase_Order__Tags'],
  );
});

test('clock skew at the checkpoint boundary never hides a change', () => {
  const app = deriveIr(parse(APP));
  const first = computeDelta(app, readSourceJson(exportDir(VENDORS, ORDERS), app), undefined);
  assert.equal(first.next.since, '2026-10-06 10:00:00');

  const orders: Order[] = [
    // Changed values stamped older than the boundary and exactly at it.
    { ...ORDERS[0], amount: '1300.00', modified: '01-Oct-2026 08:00:00' },
    { ...ORDERS[1], amount: '500.00', modified: '06-Oct-2026 10:00:00' },
    // A new record stamped 2020.
    { id: '1000000000003570033', title: 'Washers', vendor: VENDORS[0]!.id, date: '07-Oct-2026', amount: '12.50', modified: '02-Jan-2020 00:00:00' },
  ];
  // A record only re-saved carries a newer Modified_Time but the same values.
  const vendors: Vendor[] = [{ ...VENDORS[0], modified: '09-Oct-2026 09:00:00' }, VENDORS[1]];
  const plan = computeDelta(app, readSourceJson(exportDir(vendors, orders), app), first.next);
  const items = plan.tables.find((table) => table.table === 'Purchase_Order')!;
  assert.equal(items.changed.length, 2);
  assert.equal(items.changedWithoutNewerTime, 2);
  assert.equal(items.added.length, 1);
  assert.equal(items.added[0]!.id, orders[2]!.id);
  assert.equal(items.deleted.length, 0);
  assert.equal(plan.tables.find((table) => table.table === 'Vendor')!.unchanged, 2);
  // The boundary reported in the plan is the checkpoint's; the next one advances
  // on the re-save even though its row did not change.
  assert.equal(plan.since, '2026-10-06 10:00:00');
  assert.equal(plan.next.since, '2026-10-09 09:00:00');

  // since never moves backwards: a later export whose every Modified_Time is
  // strictly older than the checkpoint keeps it.
  const stale = readSourceJson(exportDir(VENDORS, ORDERS), app);
  for (const table of stale.tables) {
    for (const row of table.rows) assert.ok((row.columns[MODIFIED_TIME] ?? '') < plan.next.since!, `${table.table} row ${row.id} is not stamped older than the checkpoint`);
  }
  const older = computeDelta(app, stale, plan.next);
  assert.equal(older.next.since, '2026-10-09 09:00:00');
});

test('readStoreRows pages past one ZCQL page without losing or duplicating a row', async () => {
  const store = fakeStore();
  const all: Record<string, unknown>[] = [];
  for (let i = 1; i <= 701; i++) {
    all.push({ ROWID: `100000000000357${String(1000 + i)}`, c2c_source_id: `100000000000999${String(1000 + i)}`, Vendor_Name: `Vendor ${i}` });
  }
  store.tables.set('Vendor', all);
  const rows = await readStoreRows({ dc: 'in', catalystBase: 'https://api.catalyst.zoho.in', fetch: store.fetch, scope: SCOPE }, ['Vendor']);
  const list = rows.get('Vendor')!;
  assert.equal(list.length, 701);
  assert.equal(new Set(list.map((row) => String(row.ROWID))).size, 701);
  assert.deepEqual(
    list.map((row) => String(row.c2c_source_id)),
    all.map((row) => String(row.c2c_source_id)),
  );
});

test('readStoreRows skips a row a shifted page boundary serves twice', async () => {
  const all: Record<string, unknown>[] = [];
  for (let i = 1; i <= 701; i++) {
    all.push({ ROWID: `100000000000357${String(1000 + i)}`, c2c_source_id: `100000000000999${String(1000 + i)}`, Vendor_Name: `Vendor ${i}` });
  }
  const sql: string[] = [];
  // A store whose ordering shifts mid-read can serve the row before a page
  // boundary again at the head of the next page.
  const fetch: FetchLike = async (_url, init) => {
    const query = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
    sql.push(query);
    const limit = /LIMIT (\d+), (\d+)/.exec(query)!;
    const from = Math.max(1, Number(limit[1])) - 1;
    const page = all.slice(from, from + Number(limit[2]));
    const data = (from > 0 ? [all[from - 1]!, ...page] : page).map((row) => ({ Vendor: row }));
    return textResponse(JSON.stringify({ status: 'success', data }));
  };
  const rows = await readStoreRows({ dc: 'in', catalystBase: 'https://api.catalyst.zoho.in', fetch, scope: SCOPE }, ['Vendor']);
  const list = rows.get('Vendor')!;
  assert.equal(list.length, 701);
  assert.equal(new Set(list.map((row) => String(row.ROWID))).size, 701);
  assert.deepEqual(
    list.map((row) => String(row.c2c_source_id)),
    all.map((row) => String(row.c2c_source_id)),
  );
  // The walk pages by 1-based ZCQL offsets.
  assert.deepEqual(sql, [
    'SELECT * FROM Vendor ORDER BY ROWID LIMIT 1, 300',
    'SELECT * FROM Vendor ORDER BY ROWID LIMIT 301, 300',
    'SELECT * FROM Vendor ORDER BY ROWID LIMIT 601, 300',
  ]);
});

test('a table the export holds no rows for is reported missing, never deleted', () => {
  const app = deriveIr(parse(APP));
  const loaded = readSourceJson(exportDir(VENDORS, ORDERS), app);
  const first = computeDelta(app, loaded, undefined);
  const empty = { ...loaded, tables: loaded.tables.map((table) => (table.table === 'Purchase_Order' ? { ...table, rows: [] } : table)) };
  const plan = computeDelta(app, empty, first.next);
  const orders = plan.tables.find((table) => table.table === 'Purchase_Order')!;
  assert.equal(orders.missing, true);
  assert.deepEqual(orders.deleted, []);
  assert.equal(Object.keys(plan.next.tables.Purchase_Order!.rows).length, 2);
});

test('rollback export writes Creator import CSVs that re-plan with no changes', async () => {
  const ws = workspace();
  const store = fakeStore();
  await baseline(ws, store);
  const app = deriveIr(parse(APP));
  const rows = await readStoreRows({ dc: 'in', catalystBase: 'https://api.catalyst.zoho.in', fetch: store.fetch, scope: SCOPE }, ['Vendor', 'Purchase_Order']);
  const result = rollbackExport(app, rows);
  const files = new Map(result.files.map((file) => [file.path, file.body]));
  assert.deepEqual(result.order, ['Vendor', 'Purchase_Order']);
  const orders = files.get('import/Purchase_Order.csv')!;
  assert.equal(orders.split('\n')[0], 'PO_Title,Vendor,Order_Date,Amount,ID');
  assert.equal(orders.split('\n')[1], `Restock,Acme,05-Oct-2026,1250.00,${ORDERS[0]!.id}`);
  assert.match(files.get('import/Vendor.csv')!.split('\n')[0]!, /Contact\.first_name/);
  assert.equal(files.get('ids/Purchase_Order.ids.csv')!.split('\n')[1]!.split(',')[2], VENDORS[0]!.id);
  assert.equal(files.get('import/Vendor.csv')!.includes('Modified'), false);

  const out = mkdtempSync(join(tmpdir(), 'c2c-rollback-'));
  for (const file of result.files) {
    mkdirSync(join(out, file.path, '..'), { recursive: true });
    writeFileSync(join(out, file.path), file.body);
  }
  const replan = computeDelta(app, readSourceCsv(join(out, 'import'), app), checkpointOf(ws));
  for (const table of replan.tables) {
    assert.deepEqual([table.table, table.added.length, table.changed.length, table.deleted.length], [table.table, 0, 0, 0]);
  }
});

test('rollback-export reads offline row files and plans a live read only with --confirm', async () => {
  const ws = workspace();
  const store = fakeStore();
  await baseline(ws, store);
  const rowsDir = mkdtempSync(join(tmpdir(), 'c2c-rows-'));
  for (const [table, rows] of store.tables) writeFileSync(join(rowsDir, `${table}.json`), JSON.stringify({ status: 'success', data: rows.map((row) => ({ [table]: row })) }));
  const out = mkdtempSync(join(tmpdir(), 'c2c-rollback-out-'));
  const offline = cli(fakeStore());
  assert.equal(await rollbackExportCli(['--ds', ws.ds, '--out', out, '--rows', rowsDir], offline.io), 0, offline.err());
  assert.equal(offline.fetched(), 0);
  assert.match(readFileSync(join(out, 'import', 'Vendor.csv'), 'utf8'), /^Acme,/m);
  assert.equal(readFileSync(join(out, 'IMPORT_ORDER.txt'), 'utf8'), '1. import/Vendor.csv\n2. import/Purchase_Order.csv\n');

  const plan = cli(store);
  assert.equal(await rollbackExportCli(['--ds', ws.ds, '--out', out, '--project', '1001', '--org', ORG, '--projects', ws.projects], plan.io), 0, plan.err());
  assert.match(plan.out(), /^reads: no$/m);
  assert.equal(plan.fetched(), 0);
});

test('a composite part header maps to its column', () => {
  const app = deriveIr(parse(APP));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-composite-'));
  writeFileSync(join(dir, 'Vendor.csv'), 'Vendor_Name,Contact.first_name,Contact.last_name,ID\nAcme,Ann,Lee,11\n');
  writeFileSync(join(dir, 'Purchase_Order.csv'), 'PO_Title,Vendor,ID\nRestock,Acme,21\n');
  const vendor = readSourceCsv(dir, app).tables.find((table) => table.table === 'Vendor')!;
  assert.equal(vendor.rows[0]!.columns.Contact_first_name, 'Ann');
  assert.equal(vendor.rows[0]!.columns.Contact_last_name, 'Lee');
});

test('a deploy keeps the delta checkpoint in the state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-state-'));
  const delta = { version: 1, source: 'json', tables: { Vendor: { rows: { '1': 'f' } } } };
  writeFileSync(join(dir, STATE_FILE), JSON.stringify({ version: 1, projectId: '1001', digest: 'a', done: [], delta }));
  writeState(dir, { version: 1, projectId: '1001', digest: 'b', done: ['install'] });
  const state = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as { digest: string; delta: unknown };
  assert.equal(state.digest, 'b');
  assert.deepEqual(state.delta, delta);
});

/** Fields named Table and Priority are stored as Table_col and Priority_col. */
const APP_RESERVED = `application "Shop"
{
form Menu_Item
{
must have unique Dish
(
type = text
)
}
form Cafe_Order
{
Table
(
type = picklist
values = Menu_Item.ID
displayformat = [Dish]
)
must have Priority
(
type = text
)
}
list All_Menu_Items
{
show all rows from Menu_Item
(
Dish as "Dish"
)
}
list All_Cafe_Orders
{
show all rows from Cafe_Order
(
Table as "Table"
Priority as "Priority"
)
}
}
`;

function exportReservedDir(priority: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-delta-reserved-'));
  writeFileSync(
    join(dir, 'All_Menu_Items.json'),
    JSON.stringify({ All_Menu_Items: [{ ID: '1000000000003570101', Dish: 'Dosa', Modified_Time: '01-Oct-2026 09:00:00' }] }),
  );
  writeFileSync(
    join(dir, 'All_Cafe_Orders.json'),
    JSON.stringify({
      All_Cafe_Orders: [
        { ID: '1000000000003570111', Table: { ID: '1000000000003570101', display_value: 'Dosa' }, Priority: priority, Modified_Time: '02-Oct-2026 09:00:00' },
      ],
    }),
  );
  return dir;
}

test('sync-delta writes a renamed reserved field under its stored column', async () => {
  const ws = workspace(APP_RESERVED);
  const store = fakeStore();
  const run = cli(store);
  // The must-have field named Priority satisfies the write rules under Priority_col.
  assert.equal(await syncDeltaCli(syncArgs(ws, exportReservedDir('High'), '--confirm'), run.io), 0, run.err());
  const posted = store.writes
    .filter((write) => write.method === 'POST' && write.table === 'Cafe_Order')
    .flatMap((write) => write.body as Record<string, unknown>[]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.Priority_col, 'High');
  assert.equal(posted[0]!.Table_col, store.tables.get('Menu_Item')![0]!.ROWID);
  assert.ok(!('Priority' in posted[0]!) && !('Table' in posted[0]!));

  // A changed value updates the row in place by ROWID, under the stored column.
  const update = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, exportReservedDir('Low'), '--confirm'), update.io), 0, update.err());
  const puts = store.writes
    .filter((write) => write.method === 'PUT' && write.table === 'Cafe_Order')
    .flatMap((write) => write.body as Record<string, unknown>[]);
  assert.equal(puts.length, 1);
  assert.equal(puts[0]!.ROWID, store.tables.get('Cafe_Order')![0]!.ROWID);
  assert.equal(puts[0]!.Priority_col, 'Low');
  assert.ok(!('Priority' in puts[0]!));
});

test('rollback export writes a renamed field under its link name and re-plans clean', async () => {
  const ws = workspace(APP_RESERVED);
  const store = fakeStore();
  const run = cli(store);
  assert.equal(await syncDeltaCli(syncArgs(ws, exportReservedDir('High'), '--confirm'), run.io), 0, run.err());
  const app = deriveIr(parse(APP_RESERVED));
  const rows = await readStoreRows({ dc: 'in', catalystBase: 'https://api.catalyst.zoho.in', fetch: store.fetch, scope: SCOPE }, ['Menu_Item', 'Cafe_Order']);
  const result = rollbackExport(app, rows);
  const files = new Map(result.files.map((file) => [file.path, file.body]));
  const csv = files.get('import/Cafe_Order.csv')!;
  assert.equal(csv.split('\n')[0], 'Table,Priority,ID');
  assert.equal(csv.split('\n')[1], 'Dosa,High,1000000000003570111');

  const out = mkdtempSync(join(tmpdir(), 'c2c-rollback-reserved-'));
  for (const file of result.files) {
    mkdirSync(join(out, file.path, '..'), { recursive: true });
    writeFileSync(join(out, file.path), file.body);
  }
  const replan = computeDelta(app, readSourceCsv(join(out, 'import'), app), checkpointOf(ws));
  for (const table of replan.tables) {
    assert.deepEqual([table.table, table.added.length, table.changed.length, table.deleted.length], [table.table, 0, 0, 0]);
  }
});

/** A form with 260 text fields, over the 250-column cap: it splits into a base table plus a 1:1 extension. */
function wideApp() {
  const fields = Array.from({ length: 260 }, (_, index) => `Field_${index}\n(\ntype = text\n)`).join('\n');
  const app = deriveIr(parse(`application "Wide"\n{\nform Wide_Form\n{\n${fields}\n}\n}\n`));
  const schema = generateSchema(app);
  const base = schema.tables.find((table) => table.role === 'form')!;
  const exts = schema.tables.filter((table) => table.role === 'extension');
  assert.equal(exts.length, 1);
  return { app, base, ext: exts[0]! };
}

test('rollback export joins an extension table back onto the form row', () => {
  const { app, base, ext } = wideApp();
  const baseColumn = base.columns.find((column) => column.name === 'Field_0')!;
  const extColumn = ext.columns.find((column) => /^Field_\d+$/.test(column.name))!;
  const rows = new Map<string, Record<string, unknown>[]>([
    [base.name, [{ ROWID: '9001', c2c_source_id: '1000000000003570201', [baseColumn.name]: 'base value' }]],
    [ext.name, [{ ROWID: '9002', parent_rowid: '9001', [extColumn.name]: 'ext value' }]],
  ]);
  const result = rollbackExport(app, rows);
  const files = new Map(result.files.map((file) => [file.path, file.body]));
  const lines = files.get('import/Wide_Form.csv')!.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  const header = lines[0]!.split(',');
  const row = lines[1]!.split(',');
  assert.equal(row[header.indexOf(baseColumn.name)], 'base value');
  assert.equal(row[header.indexOf(extColumn.name)], 'ext value');
  assert.equal(row[header.indexOf('ID')], '1000000000003570201');
  assert.equal(header.includes('parent_rowid'), false);
  assert.deepEqual(result.counts, [{ form: 'Wide_Form', table: base.name, rows: 1 }]);
  // A joined extension is not a manual file and is not a gap to report.
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.files.map((file) => file.path).filter((path) => path.startsWith('manual/') || path.startsWith('files/')), []);
});

test('rollback export places extension file fields in the form manifest with the parent Creator ID', () => {
  const fields = Array.from({ length: 259 }, (_, index) => `Field_${index}\n(\ntype = text\n)`).join('\n');
  const app = deriveIr(parse(`application "Wide Files"\n{\nform Wide_Form\n{\n${fields}\nAttachment\n(\ntype = file upload\n)\n}\n}\n`));
  const schema = generateSchema(app);
  const base = schema.tables.find((table) => table.role === 'form')!;
  const ext = schema.tables.find((table) => table.role === 'extension')!;
  const fileColumn = ext.columns.find((column) => column.field === 'Attachment' || column.name === 'Attachment')!;
  const rows = new Map<string, Record<string, unknown>[]>([
    [base.name, [{ ROWID: '9101', c2c_source_id: '1000000000003570211' }]],
    [ext.name, [{ ROWID: '9102', parent_rowid: '9101', [fileColumn.name]: 'migrated/Wide_Form/Attachment/1000000000003570211/file.pdf' }]],
  ]);
  const result = rollbackExport(app, rows);
  const files = new Map(result.files.map((file) => [file.path, file.body]));
  const manifest = files.get('files/Wide_Form.files.csv')!.trimEnd().split('\n');
  assert.equal(files.has(`files/${ext.name}.files.csv`), false);
  assert.equal(manifest.length, 2);
  assert.equal(manifest[1], `1000000000003570211,9102,Attachment,migrated/Wide_Form/Attachment/1000000000003570211/file.pdf,file.pdf`);
});

test('rollback export refuses extension file entries when the parent Creator ID cannot be resolved', () => {
  const fields = Array.from({ length: 259 }, (_, index) => `Field_${index}\n(\ntype = text\n)`).join('\n');
  const app = deriveIr(parse(`application "Wide Files"\n{\nform Wide_Form\n{\n${fields}\nAttachment\n(\ntype = file upload\n)\n}\n}\n`));
  const schema = generateSchema(app);
  const base = schema.tables.find((table) => table.role === 'form')!;
  const ext = schema.tables.find((table) => table.role === 'extension')!;
  const fileColumn = ext.columns.find((column) => column.field === 'Attachment' || column.name === 'Attachment')!;
  const rows = new Map<string, Record<string, unknown>[]>([
    [base.name, [{ ROWID: '9201' }]],
    [ext.name, [{ ROWID: '9202', parent_rowid: 'missing', [fileColumn.name]: 'object/key.pdf' }]],
  ]);
  const result = rollbackExport(app, rows);
  assert.equal(result.files.some((file) => file.path.startsWith('files/')), false);
  assert.match(result.warnings.join('\n'), /1 file value\(s\) in .* were refused because the parent Creator record ID could not be resolved; no blank ID was emitted/);
});

/** A wide form whose file column sits on the 1:1 extension table. */
function wideFileApp() {
  const fields = Array.from({ length: 259 }, (_, index) => `Field_${index}\n(\ntype = text\n)`).join('\n');
  const source = `application "Wide Files"\n{\nform Wide_Form\n{\n${fields}\nAttachment\n(\ntype = file upload\n)\n}\n}\n`;
  const app = deriveIr(parse(source));
  const schema = generateSchema(app);
  const base = schema.tables.find((table) => table.role === 'form')!;
  const ext = schema.tables.find((table) => table.role === 'extension')!;
  const fileColumn = ext.columns.find((column) => column.field === 'Attachment' || column.name === 'Attachment')!;
  return { source, app, base, ext, fileColumn };
}

/**
 * File row 9303 points at extension row 9302, which points at form row 9301.
 * Only 9301 carries the Creator record id, so the manifest needs both hops.
 */
function twoHopFileRows(baseName: string, extName: string, fileColumn: string): Map<string, Record<string, unknown>[]> {
  const creatorId = '1000000000003570221';
  const key = `migrated/Wide_Form/Attachment/${creatorId}/file.pdf`;
  return new Map([
    [baseName, [{ ROWID: '9301', c2c_source_id: creatorId }]],
    [
      extName,
      [
        { ROWID: '9302', parent_rowid: '9301' },
        { ROWID: '9303', parent_rowid: '9302', [fileColumn]: key },
      ],
    ],
  ]);
}

function fileManifest(result: { files: { path: string; body: string }[] }): string {
  return result.files.find((file) => file.path === 'files/Wide_Form.files.csv')?.body ?? '';
}

test('rollback export re-attaches a file whose parent is resolved through a second hop', () => {
  const { app, base, ext, fileColumn } = wideFileApp();
  const rows = twoHopFileRows(base.name, ext.name, fileColumn.name);
  const extension = rows.get(ext.name)!;
  assert.equal(extension[0]!.parent_rowid, '9301');
  assert.equal(extension[1]!.parent_rowid, '9302');
  assert.equal(extension[0]!.c2c_source_id, undefined);
  const creatorId = '1000000000003570221';
  const key = `migrated/Wide_Form/Attachment/${creatorId}/file.pdf`;
  const field = fileColumn.field ?? fileColumn.name;
  const result = rollbackExport(app, rows);
  const manifest = fileManifest(result);
  assert.equal(manifest, `ID,ROWID,Field,Object_Key,File_Name\n${creatorId},9303,${field},${key},file.pdf\n`);
  assert.equal(result.files.some((file) => file.path === `files/${ext.name}.files.csv`), false);
  assert.equal(result.warnings.some((line) => line.includes('could not be resolved')), false);
});

test('rollback export round-trips an extension file manifest byte for byte', () => {
  const { app, base, ext, fileColumn } = wideFileApp();
  const key = 'migrated/Wide_Form/Attachment/1000000000003570221/file.pdf';
  const exported = rollbackExport(app, twoHopFileRows(base.name, ext.name, fileColumn.name));
  const files = new Map(exported.files.map((file) => [file.path, file.body]));
  const manifest = files.get('files/Wide_Form.files.csv');
  assert.ok(manifest, 'extension file manifest');
  const importCsv = files.get('import/Wide_Form.csv')!.trimEnd().split('\n');
  const importHeader = importCsv[0]!.split(',');
  const importRow = importCsv[1]!.split(',');
  assert.equal(importRow[importHeader.indexOf('ID')], '1000000000003570221');
  const ids = files.get('ids/Wide_Form.ids.csv')!.trimEnd().split('\n');
  const idHeader = ids[0]!.split(',');
  const idRow = ids[1]!.split(',');
  const formRowId = idRow[idHeader.indexOf('ROWID')]!;
  assert.equal(idRow[idHeader.indexOf('ID')], '1000000000003570221');
  const manifestLines = manifest.trimEnd().split('\n');
  const manifestHeader = manifestLines[0]!.split(',');
  const attached = manifestLines.slice(1).map((line) => {
    const cells = line.split(',');
    const creatorId = cells[manifestHeader.indexOf('ID')]!;
    assert.equal(creatorId, importRow[importHeader.indexOf('ID')]);
    return {
      ROWID: cells[manifestHeader.indexOf('ROWID')]!,
      parent_rowid: formRowId,
      [fileColumn.name]: cells[manifestHeader.indexOf('Object_Key')]!,
    };
  });
  assert.equal(attached[0]![fileColumn.name], key);
  const imported = new Map<string, Record<string, unknown>[]>([
    [base.name, [{ ROWID: formRowId, c2c_source_id: '1000000000003570221' }]],
    [ext.name, attached],
  ]);
  const again = rollbackExport(app, imported);
  assert.equal(fileManifest(again), manifest);
});

function parentRefusals(text: string): { count: number; ids: string[] }[] {
  return text
    .split('\n')
    .filter((line) => line.includes('parent Creator record ID could not be resolved'))
    .map((line) => ({
      count: Number(/(\d+) file value\(s\)/.exec(line)?.[1]),
      ids: /\(records: ([^)]*)\)/.exec(line)?.[1]?.split(',').map((id) => id.trim()).filter(Boolean) ?? [],
    }));
}

test('rollback export reports unresolved parents in the CLI output and the migration report', async () => {
  const { source, base, ext, fileColumn } = wideFileApp();
  const ws = workspace(source);
  const rowsDir = mkdtempSync(join(tmpdir(), 'c2c-rollback-rows-'));
  writeFileSync(join(rowsDir, `${base.name}.json`), JSON.stringify([{ ROWID: '9201', c2c_source_id: '1000000000003570221' }]));
  writeFileSync(
    join(rowsDir, `${ext.name}.json`),
    JSON.stringify([
      { ROWID: '9202', parent_rowid: 'absent-a', [fileColumn.name]: 'object/a.pdf' },
      { ROWID: '9204', parent_rowid: 'absent-b', [fileColumn.name]: 'object/b.pdf' },
    ]),
  );
  const out = mkdtempSync(join(tmpdir(), 'c2c-rollback-report-'));
  const run = cli(fakeStore());
  assert.equal(await rollbackExportCli(['--ds', ws.ds, '--out', out, '--rows', rowsDir], run.io), 0, run.err());
  const cliRefusals = parentRefusals(run.out());
  const reportRefusals = parentRefusals(readFileSync(join(out, 'README.md'), 'utf8'));
  assert.deepEqual(cliRefusals, reportRefusals);
  assert.deepEqual(cliRefusals, [{ count: 2, ids: ['9202', '9204'] }]);
  assert.equal(cliRefusals[0]!.count, cliRefusals[0]!.ids.length);
  assert.equal(existsSync(join(out, 'files', 'Wide_Form.files.csv')), false);
});

test('rollback export refuses a cyclic extension parent without hanging', () => {
  const { app, base, ext, fileColumn } = wideFileApp();
  const rows = new Map<string, Record<string, unknown>[]>([
    [base.name, [{ ROWID: '9401', c2c_source_id: '1000000000003570221' }]],
    [
      ext.name,
      [
        { ROWID: '9402', parent_rowid: '9403' },
        { ROWID: '9403', parent_rowid: '9402', [fileColumn.name]: 'object/cycle.pdf' },
      ],
    ],
  ]);
  const result = rollbackExport(app, rows);
  assert.equal(result.files.some((file) => file.path.startsWith('files/')), false);
  assert.deepEqual(parentRefusals(result.warnings.join('\n')), [{ count: 1, ids: ['9403'] }]);
});

test('rollback export writes an extension row whose parent is missing under manual/', () => {
  const { app, base, ext } = wideApp();
  const extColumn = ext.columns.find((column) => /^Field_\d+$/.test(column.name))!;
  const rows = new Map<string, Record<string, unknown>[]>([
    [ext.name, [{ ROWID: '9002', parent_rowid: '9999', [extColumn.name]: 'orphan value' }]],
  ]);
  const result = rollbackExport(app, rows);
  const files = new Map(result.files.map((file) => [file.path, file.body]));
  const orphan = files.get(`manual/${ext.name}.csv`)!;
  const lines = orphan.trimEnd().split('\n');
  const header = lines[0]!.split(',');
  assert.equal(lines.length, 2);
  const cells = lines[1]!.split(',');
  assert.equal(cells[header.indexOf('parent_rowid')], '9999');
  assert.equal(cells[header.indexOf(extColumn.name)], 'orphan value');
  assert.match(result.warnings.join('\n'), new RegExp(`${ext.name}: 1 extension row\\(s\\) have no parent row in ${base.name}`));
  // The parentless row is not silently merged into the import CSV.
  assert.equal(files.get('import/Wide_Form.csv')!.trimEnd().split('\n').length, 1);
});

const APP_FILE = `application "Docs"
{
form Doc
{
Title
(
type = text
)
Attachment
(
type = file upload
)
}
}
`;

test('rollback export lists file cells as Stratus keys instead of dropping them', () => {
  const app = deriveIr(parse(APP_FILE));
  const rows = new Map<string, Record<string, unknown>[]>([
    [
      'Doc',
      [
        { ROWID: '7001', c2c_source_id: '1000000000003570301', Title: 'Lease', Attachment: 'migrated/Doc/Attachment/1000000000003570301/lease.pdf' },
        { ROWID: '7002', c2c_source_id: '1000000000003570302', Title: 'Empty' },
      ],
    ],
  ]);
  const result = rollbackExport(app, rows);
  const files = new Map(result.files.map((file) => [file.path, file.body]));
  // File cells are not report import data: the import CSV has no Attachment column.
  assert.equal(files.get('import/Doc.csv')!.split('\n')[0], 'Title,ID');
  const manifest = files.get('files/Doc.files.csv')!.trimEnd().split('\n');
  assert.equal(manifest[0], 'ID,ROWID,Field,Object_Key,File_Name');
  assert.equal(manifest.length, 2);
  assert.equal(manifest[1], '1000000000003570301,7001,Attachment,migrated/Doc/Attachment/1000000000003570301/lease.pdf,lease.pdf');
  assert.match(result.warnings.join('\n'), /1 file value\(s\) in Doc are Stratus object keys/);
});

test('rollback export writes no files manifest when no file cell holds a key', () => {
  const app = deriveIr(parse(APP_FILE));
  const rows = new Map<string, Record<string, unknown>[]>([['Doc', [{ ROWID: '7002', c2c_source_id: '1000000000003570302', Title: 'Empty' }]]]);
  const result = rollbackExport(app, rows);
  assert.deepEqual(result.files.map((file) => file.path).filter((path) => path.startsWith('files/')), []);
  assert.deepEqual(result.warnings.filter((line) => line.includes('file value')), []);
});
