/**
 * A Creator report CSV uses display names, may omit the record ID and counts.json,
 * and stores lookup cells as display values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { emptyCheckpoint, type FetchLike } from '../../data/src/migrate.js';
import { quirkRowServer } from '../../data/test/catalyst-row-fake.js';
import { formatCsvPlan, hasReportJson, migrateCsv, migrateSeed, readSourceCsv, readSourceJson, sourceCsvCli, type Io } from '../src/index.js';
import { fidelityBody, formatFidelityMd } from '../src/cli.js';
import type { RestCall, RestResult } from '../src/tables.js';
import { parseJsonExact } from '../src/json-exact.js';

const SCOPE = { org: '10000000000', projectId: '1001', token: 'test-cli-token' };
const GUARD = { projectName: 'c2c-widget', projectId: '1001', org: '10000000000', environment: 'Development', dc: 'in' as const };

const APP = `application "Widget"
{
form Vendor
{
must have unique Vendor_Name
(
type = text
displayname = "Vendor Name"
)
Phone
(
type = phonenumber
displayname = "Phone"
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
}
list All_Vendors
{
show all rows from Vendor
(
Vendor_Name as "Vendor Name"
Phone as "Phone"
)
}
list All_Purchase_Orders
{
show all rows from Purchase_Order
(
PO_Title as "PO Title"
Vendor as "Vendor"
)
}
}
`;

const MULTI_LOOKUP = `application "Widget"
{
form Member
{
must have Name
(
type = text
)
}
form Team
{
must have Name
(
type = text
)
Members
(
type = list
values = Member.ID
)
}
list All_Members
{
show all rows from Member
(
Name
)
}
list All_Teams
{
show all rows from Team
(
Name
Members
)
}
}
`;

const MERGE = `application "Widget"
{
form Item
{
Code
(
type = text
displayname = "Code"
)
Name
(
type = text
displayname = "Name"
)
Note
(
type = text
displayname = "Note"
)
}
list Short
{
show all rows from Item
(
Code as "Code"
Name as "Name"
)
}
list Long
{
show all rows from Item
(
Code as "Code"
Note as "Note"
)
}
}
`;

const BOOLS = `application "Widget"
{
form Add_Product
{
must have Product_Name
(
type = text
displayname = "Product  Name"
)
This_is_also_the_subassembly
(
type = checkbox
displayname = "This is also the subassembly"
)
}
list Final_Products
{
show all rows from Add_Product
(
Product_Name as "Product  Name"
This_is_also_the_subassembly as "Type"
(
displaytrue = "Subassembly"
displayfalse = "Final Product"
)
)
}
}
`;

const PERSON = `application "Widget"
{
form Person
{
must have Name
(
type = name
displayname = "Name"
)
must have unique Mail_ID
(
type = email
displayname = "Mail ID"
)
}
}
`;

function appOf(src: string) {
  return deriveIr(parse(src));
}

const exportDirs: string[] = [];
function dirOf(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-export-'));
  exportDirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
process.on('exit', () => {
  for (const dir of exportDirs) rmSync(dir, { recursive: true, force: true });
});

test('a report export without counts.json or an ID column loads display names and lookup display values', () => {
  const app = appOf(APP);
  const dir = dirOf({
    'All_Vendors.csv': 'Vendor Name,Phone\nAcme,555-0101\nNorthwind,555-0102\n',
    'All_Purchase_Orders.csv': 'PO Title,Vendor\nRestock,Acme\nService,Northwind\n',
    'records-entered.md': 'local note\n',
  });
  const loaded = readSourceCsv(dir, app);
  const vendor = loaded.tables.find((table) => table.table === 'Vendor')!;
  const order = loaded.tables.find((table) => table.table === 'Purchase_Order')!;
  assert.equal(loaded.countsFrom, 'export');
  assert.equal(loaded.expected.find((item) => item.form === 'Vendor')?.count, 2);
  assert.equal(loaded.expected.find((item) => item.form === 'Purchase_Order')?.count, 2);
  assert.equal(vendor.rows.length, 2);
  assert.match(vendor.rows[0]!.id, /^d_[0-9a-f]{64}$/);
  assert.equal(vendor.rows.find((row) => row.columns.Vendor_Name === 'Acme')?.columns.Phone, '555-0101');
  const acme = vendor.rows.find((row) => row.columns.Vendor_Name === 'Acme')!.id;
  assert.equal(order.rows.find((row) => row.columns.PO_Title === 'Restock')?.columns.Vendor, acme);
  assert.deepEqual(readSourceCsv(dir, app).tables.find((table) => table.table === 'Vendor')!.rows.map((row) => row.id), vendor.rows.map((row) => row.id));
  const plan = formatCsvPlan(loaded, GUARD);
  assert.match(plan, /counts: from the export/);
  assert.match(plan, /derived ids:\n- Vendor from unique columns Vendor_Name/);
  assert.match(plan, /CSV has no record ids; prefer the JSON export/);
  assert.match(plan, /All_Vendors.csv → Vendor/);
  assert.match(plan, /Vendor Name → Vendor_Name/);
  assert.match(plan, /lookups:\n- Purchase_Order.Vendor matches Vendor on Vendor_Name/);
  assert.match(plan, /ignored:\n- records-entered.md/);
  assert.match(plan, /writes: no/);
  assert.equal(plan.includes('counts.json is missing'), false);
});

test('the same unique field keeps one source id when another column changes, and a repeated value is refused', () => {
  const app = appOf(APP);
  const first = readSourceCsv(dirOf({ 'All_Vendors.csv': 'Vendor Name,Phone\nAcme,555-0101\n' }), app);
  const second = readSourceCsv(dirOf({ 'All_Vendors.csv': 'Vendor Name,Phone\nAcme,555-0199\n' }), app);
  assert.equal(first.tables.find((table) => table.table === 'Vendor')!.rows[0]!.id, second.tables.find((table) => table.table === 'Vendor')!.rows[0]!.id);
  assert.throws(
    () => readSourceCsv(dirOf({ 'All_Vendors.csv': 'Vendor Name\nAcme\nAcme\n' }), app),
    /All_Vendors\.csv rows 1 and 2 derive the same record id/,
  );
});

test('a value holding a newline cannot collide with another row under one derived id', () => {
  const app = appOf(MERGE);
  const loaded = readSourceCsv(dirOf({
    'Item.csv': 'Code,Name,Note\na,"1\nNote=2",3\na,1,"2\nNote=3"\n',
  }), app);
  const rows = loaded.tables.find((table) => table.table === 'Item')!.rows;
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]!.id, rows[1]!.id);
});

test('an ID column is the source id and counts.json stays strict', () => {
  const app = appOf(APP);
  const dir = dirOf({
    'Vendor.csv': 'ID,Vendor_Name\n77,Acme\n',
    'Purchase_Order.csv': 'ID,PO_Title,Vendor\n9,Restock,77\n',
    'counts.json': JSON.stringify({ Vendor: 1, Purchase_Order: 1 }),
  });
  const loaded = readSourceCsv(dir, app);
  assert.equal(loaded.countsFrom, 'counts.json');
  assert.equal(loaded.tables.find((table) => table.table === 'Vendor')!.rows[0]!.id, '77');
  assert.equal(loaded.tables.find((table) => table.table === 'Purchase_Order')!.rows[0]!.columns.Vendor, '77');
  assert.equal(formatCsvPlan(loaded, GUARD).includes('derived ids:'), false);
  const mismatch = dirOf({
    'Vendor.csv': 'ID,Vendor_Name\n77,Acme\n',
    'Purchase_Order.csv': 'ID,PO_Title,Vendor\n9,Restock,77\n',
    'counts.json': JSON.stringify({ Vendor: 4, Purchase_Order: 1 }),
  });
  assert.throws(() => readSourceCsv(mismatch, app), /counts.json says 4/);
});

test("c2c's own files in a source directory are skipped and any other unknown file is still refused", () => {
  const app = appOf(APP);
  const csv = { 'All_Vendors.csv': 'Vendor Name,Phone\nAcme,555-0101\n' };
  const json = { 'All_Vendors.json': JSON.stringify({ All_Vendors: [{ ID: '77', Vendor_Name: 'Acme', Phone: '555-0101' }] }) };
  const earlierRun = { 'c2c-load-report.json': '{"kind":"loader-integrity"}\n', 'c2c-fidelity.json': '{"kind":"fidelity"}\n', 'c2c-fidelity.md': '# fidelity\n' };
  const vendors = (dir: string, read: typeof readSourceCsv) => read(dir, app).tables.find((table) => table.table === 'Vendor')!.rows.length;

  // What `c2c seed --out` writes: per-form CSVs plus the seed.json manifest.
  const seedDir = dirOf({ ...csv, 'seed.json': JSON.stringify({ Vendor: [{ c2c_source_id: 'Vendor#1', Vendor_Name: 'Acme' }] }) });
  assert.equal(hasReportJson(seedDir, app), false);
  assert.equal(vendors(seedDir, readSourceCsv), 1);
  assert.match(formatCsvPlan(readSourceCsv(seedDir, app), GUARD), /ignored:\n- seed.json/);

  // A re-run over a directory that holds an earlier run's reports.
  const csvRerun = dirOf({ ...csv, ...earlierRun });
  assert.equal(hasReportJson(csvRerun, app), false);
  assert.equal(vendors(csvRerun, readSourceCsv), 1);
  assert.equal(vendors(dirOf({ ...json, ...earlierRun }), readSourceJson), 1);

  // A seed.json that is not the manifest, and a stray file, are still refused.
  for (const body of [JSON.stringify({ Unknown_Form: [] }), '[]', 'not json']) {
    const dir = dirOf({ ...csv, 'seed.json': body });
    assert.equal(hasReportJson(dir, app), true, body);
    assert.throws(() => readSourceJson(dir, app), /seed\.json does not match a report, form, or subform/, body);
  }

  // What `c2c seed --out` writes for an app with an inline subform: the
  // manifest keys the parent form AND its generated child table, plus the
  // reserved blocked-form record. It is still the manifest, not a report.
  const sub = appOf(SUBFORMED);
  const subCsv = { 'Material.csv': 'Material Name\nSteel\n', 'All_Orders.csv': 'Title\nT1\n' };
  const seeded = {
    Order: [{ c2c_source_id: 'Order#1', Title: 'T1' }],
    Order__Items: [{ c2c_source_id: 'Order#1__Items__0', parent_id: 'Order#1' }],
    c2c_blocked: [{ form: 'Blocked_Form', reason: 'no writable field' }],
  };
  const subDir = dirOf({ ...subCsv, 'seed.json': JSON.stringify(seeded) });
  assert.equal(hasReportJson(subDir, sub), false);
  assert.equal(readSourceCsv(subDir, sub).tables.find((table) => table.table === 'Order')!.rows.length, 1);

  // A key that is no form, generated table, or reserved key is still refused.
  const notManifest = { ...seeded, Not_A_Table: [] };
  const badDir = dirOf({ ...subCsv, 'seed.json': JSON.stringify(notManifest) });
  assert.equal(hasReportJson(badDir, sub), true);
  assert.throws(() => readSourceJson(badDir, sub), /seed\.json does not match a report, form, or subform/);
  assert.throws(() => readSourceCsv(dirOf({ ...csv, 'seed.json': JSON.stringify({ Vendor: [] }), 'Foo.csv': 'A\n1\n' }), app), /Foo\.csv does not match a report, form, or subform/);
  assert.throws(() => readSourceJson(dirOf({ ...json, 'other.json': '{}' }), app), /other\.json does not match a report, form, or subform/);
});

test('an edits log in a CSV source directory does not turn it into a JSON export', () => {
  const app = appOf(APP);
  const csv = { 'All_Vendors.csv': 'Vendor Name,Phone\nAcme,555-0101\n' };
  const edits = { 'c2c.edits.json': '[]\n', 'app.edits.json': '[]\n' };
  const dir = dirOf({ ...csv, ...edits, 'c2c-load-report.json': '{"kind":"loader-integrity"}\n' });
  // The loader reads past the edits log and an earlier run's report...
  assert.equal(readSourceCsv(dir, app).tables.find((table) => table.table === 'Vendor')!.rows.length, 1);
  // ...so format detection does too, and the CSV export is read as CSV.
  assert.equal(hasReportJson(dir, app), false);
  // A real JSON report export beside an edits log is still detected.
  const json = dirOf({ ...edits, 'All_Vendors.json': JSON.stringify({ All_Vendors: [{ ID: '77', Vendor_Name: 'Acme', Phone: '555-0101' }] }) });
  assert.equal(hasReportJson(json, app), true);
  assert.equal(readSourceJson(json, app).tables.find((table) => table.table === 'Vendor')!.rows.length, 1);
});

test('a lookup display that matches nothing or more than one row is refused', () => {
  const app = appOf(APP);
  assert.throws(
    () => readSourceCsv(dirOf({
      'All_Vendors.csv': 'Vendor Name\nAcme\n',
      'All_Purchase_Orders.csv': 'PO Title,Vendor\nRestock,Nope\n',
    }), app),
    /no match for "Nope"/,
  );
  assert.throws(
    () => readSourceCsv(dirOf({
      'Vendor.csv': 'ID,Vendor_Name\n1,Acme\n2,Acme\n',
      'Purchase_Order.csv': 'PO Title,Vendor\nRestock,Acme\n',
      'counts.json': JSON.stringify({ Vendor: 2, Purchase_Order: 1 }),
    }), app),
    /ambiguous for "Acme"/,
  );
});

test('two reports of one form merge on the shared columns and keep columns that only one report has', () => {
  const app = appOf(MERGE);
  const loaded = readSourceCsv(dirOf({
    'Short.csv': 'Code,Name\nA,Alpha\n',
    'Long.csv': 'Code,Note\nA,Later\n',
  }), app);
  const rows = loaded.tables.find((table) => table.table === 'Item')!.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.columns.Name, 'Alpha');
  assert.equal(rows[0]!.columns.Note, 'Later');
  assert.match(formatCsvPlan(loaded, GUARD), /Item from mapped columns Code/);
  assert.equal(loaded.expected.find((item) => item.form === 'Item')?.count, 1);
});

test('a decision box exported with its report labels maps back to true or false', () => {
  const app = appOf(BOOLS);
  const loaded = readSourceCsv(dirOf({
    'Final_Products.csv': 'Product  Name,Type\nWidget,Final Product\n',
  }), app);
  const row = loaded.tables.find((table) => table.table === 'Add_Product')!.rows[0]!;
  assert.equal(row.columns.Product_Name, 'Widget');
  assert.equal(row.columns.This_is_also_the_subassembly, 'false');
});

test('a name exported as one column fills the name parts', () => {
  const app = appOf(PERSON);
  const loaded = readSourceCsv(dirOf({ 'Person.csv': 'Name,Mail ID\nRavi Anand,ravi@example.com\n' }), app);
  const row = loaded.tables.find((table) => table.table === 'Person')!.rows[0]!;
  assert.equal(row.columns.Name_first_name, 'Ravi');
  assert.equal(row.columns.Name_last_name, 'Anand');
  assert.match(formatCsvPlan(loaded, GUARD), /from unique columns Mail_ID/);
});

test('confirming the same export twice does not write the second time', async () => {
  const app = appOf(APP);
  const dir = dirOf({ 'All_Vendors.csv': 'Vendor Name,Phone\nAcme,555-0101\n' });
  const store = quirkRowServer();
  const run = () => migrateCsv({
    app,
    dir,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  const first = await run();
  assert.equal(first.ok, true, JSON.stringify(first.tables));
  const posts = store.posts.length;
  assert.equal(posts > 0, true);
  const second = await run();
  assert.equal(second.ok, true, JSON.stringify(second.tables));
  assert.equal(store.posts.length, posts);
  assert.equal(store.rowsFor('Vendor', first.tables.find((table) => table.table === 'Vendor') ? readSourceCsv(dir, app).tables.find((table) => table.table === 'Vendor')!.rows[0]!.id : '').length, 1);
});

test('plan mode does not call the network', async () => {
  const app = appOf(APP);
  const dir = dirOf({
    'All_Vendors.csv': 'Vendor Name\nAcme\n',
    'All_Purchase_Orders.csv': 'PO Title,Vendor\nRestock,Acme\n',
  });
  const ds = join(mkdtempSync(join(tmpdir(), 'c2c-export-ds-')), 'widget.ds');
  writeFileSync(ds, APP);
  const projects = join(mkdtempSync(join(tmpdir(), 'c2c-export-projects-')), 'projects.json');
  writeFileSync(projects, JSON.stringify({
    org: '10000000000',
    dc: 'in',
    env: 'Development',
    projects: { 'c2c-widget': '1001' },
  }));
  let out = '';
  let err = '';
  const fetched: string[] = [];
  const fetch: FetchLike = async (url) => {
    fetched.push(url);
    throw new Error('network refused in this test');
  };
  const io: Io = {
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
    env: { X_ZC_CREDENTIAL_PATH: '/tmp/cred-DO-NOT-PRINT' },
    cliDc: () => undefined,
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch,
    accessToken: async () => SCOPE.token,
  };
  const code = await sourceCsvCli(
    ['--source-csv', dir, '--ds', ds, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projects],
    io,
  );
  assert.equal(code, 0, err);
  assert.equal(fetched.length, 0);
  assert.match(out, /source: csv/);
  assert.match(out, /writes: no/);
  assert.match(out, /from the export/);
  assert.equal(app.forms.length > 0, true);
});

test('a JSON report export uses the record ID and a lookup object ID', () => {
  const app = appOf(APP);
  const dir = dirOf({
    'All_Vendors.json': JSON.stringify({ All_Vendors: [{ ID: '77', Vendor_Name: 'Acme', Phone: '555-0101' }] }),
    'All_Purchase_Orders.json': JSON.stringify({
      All_Purchase_Orders: [{ ID: '9', PO_Title: 'Restock', Vendor: { display_value: 'Someone Else', ID: '77' } }],
    }),
    'notes.md': 'local note\n',
  });
  const loaded = readSourceJson(dir, app);
  const order = loaded.tables.find((table) => table.table === 'Purchase_Order')!;
  assert.equal(loaded.source, 'json');
  assert.equal(loaded.countsFrom, 'export');
  assert.equal(loaded.expected.find((item) => item.form === 'Vendor')?.count, 1);
  assert.equal(loaded.tables.find((table) => table.table === 'Vendor')!.rows[0]!.id, '77');
  assert.equal(order.rows[0]!.columns.Vendor, '77');
  const plan = formatCsvPlan(loaded, GUARD);
  assert.match(plan, /source: json/);
  assert.match(plan, /counts: from the export/);
  assert.equal(plan.includes('derived ids:'), false);
  assert.equal(plan.includes('prefer the JSON export'), false);
  assert.match(plan, /ignored:\n- notes.md/);
  assert.throws(
    () => readSourceJson(dirOf({
      'All_Vendors.json': JSON.stringify({ All_Vendors: [{ ID: '1', Vendor_Name: 'Acme' }] }),
      'All_Purchase_Orders.json': JSON.stringify({
        All_Purchase_Orders: [{ ID: '2', PO_Title: 'Restock', Vendor: { display_value: 'Acme' } }],
      }),
    }), app),
    /record ID/,
  );
});

test('a JSON lookup string still resolves, and an ambiguous display is refused', () => {
  const app = appOf(APP);
  const loaded = readSourceJson(dirOf({
    'All_Vendors.json': JSON.stringify({ All_Vendors: [{ ID: '1', Vendor_Name: 'Acme' }] }),
    'All_Purchase_Orders.json': JSON.stringify({ All_Purchase_Orders: [{ ID: '2', PO_Title: 'Restock', Vendor: 'Acme' }] }),
  }), app);
  assert.equal(loaded.tables.find((table) => table.table === 'Purchase_Order')!.rows[0]!.columns.Vendor, '1');
  assert.throws(
    () => readSourceJson(dirOf({
      'All_Vendors.json': JSON.stringify({
        All_Vendors: [{ ID: '1', Vendor_Name: 'Acme' }, { ID: '2', Vendor_Name: 'Acme' }],
      }),
      'All_Purchase_Orders.json': JSON.stringify({ All_Purchase_Orders: [{ ID: '3', PO_Title: 'Restock', Vendor: 'Acme' }] }),
    }), app),
    /ambiguous for "Acme"/,
  );
});

test('JSON plan mode does not call the network', async () => {
  const dir = dirOf({
    'All_Vendors.json': JSON.stringify({ All_Vendors: [{ ID: '77', Vendor_Name: 'Acme' }] }),
    'All_Purchase_Orders.json': JSON.stringify({ All_Purchase_Orders: [{ ID: '9', PO_Title: 'Restock', Vendor: { display_value: 'Other', ID: '77' } }] }),
    'All_Vendors.csv': 'Vendor Name\nOther\n',
  });
  const ds = join(mkdtempSync(join(tmpdir(), 'c2c-export-ds-')), 'widget.ds');
  writeFileSync(ds, APP);
  const projects = join(mkdtempSync(join(tmpdir(), 'c2c-export-projects-')), 'projects.json');
  writeFileSync(projects, JSON.stringify({
    org: '10000000000',
    dc: 'in',
    env: 'Development',
    projects: { 'c2c-widget': '1001' },
  }));
  let out = '';
  let err = '';
  const fetched: string[] = [];
  const io: Io = {
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
    env: { X_ZC_CREDENTIAL_PATH: '/tmp/cred-DO-NOT-PRINT' },
    cliDc: () => undefined,
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: async (url) => {
      fetched.push(url);
      throw new Error('network refused in this test');
    },
    accessToken: async () => SCOPE.token,
  };
  const code = await sourceCsvCli(
    ['--source-json', dir, '--ds', ds, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projects],
    io,
  );
  assert.equal(code, 0, err);
  assert.equal(fetched.length, 0);
  assert.match(out, /source: json/);
  assert.match(out, /writes: no/);
  assert.match(out, /All_Vendors.csv/);
  out = '';
  const detected = await sourceCsvCli(
    ['--source-csv', dir, '--ds', ds, '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projects],
    io,
  );
  assert.equal(detected, 0, err);
  assert.match(out, /source: json/);
  assert.equal(out.includes('source: csv'), false);
});

test('JSON numeric record ids keep every digit and a numeric lookup id resolves exactly', () => {
  const app = appOf(APP);
  const acme = '1000000000003570341';
  const north = '1000000000003570342';
  const loaded = readSourceJson(dirOf({
    'All_Vendors.json': `{"All_Vendors":[{"ID":${acme},"Vendor_Name":"Acme"},{"ID":${north},"Vendor_Name":"Northwind"}]}`,
    'All_Purchase_Orders.json': `{"All_Purchase_Orders":[{"ID":9,"PO_Title":"Restock","Vendor":{"ID":${acme}}}]}`,
  }), app);
  const vendor = loaded.tables.find((table) => table.table === 'Vendor')!;
  assert.deepEqual(vendor.rows.map((row) => row.id).sort(), [acme, north]);
  assert.equal(loaded.tables.find((table) => table.table === 'Purchase_Order')!.rows[0]!.columns.Vendor, acme);
});

test('the exact parser keeps __proto__ as an own data key, not the object prototype', () => {
  const parsed = parseJsonExact('{"__proto__":{"ID":"0"},"constructor":"x","a":1}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.deepEqual(Object.keys(parsed), ['__proto__', 'constructor', 'a']);
  assert.equal(parsed.a, '1');
});

test('a __proto__, constructor, or prototype key in the export stays an ordinary data key', () => {
  const app = appOf(APP);
  const loaded = readSourceJson(dirOf({
    'All_Vendors.json': '{"All_Vendors":[{"ID":"1","Vendor_Name":"Acme","__proto__":{"ID":"0"},"constructor":"x","prototype":"y"}]}',
  }), app);
  const vendor = loaded.tables.find((table) => table.table === 'Vendor')!;
  assert.equal(vendor.rows.length, 1);
  assert.equal(vendor.rows[0]!.id, '1');
  const note = loaded.columns.find((item) => item.file === 'All_Vendors.json')!;
  for (const header of ['__proto__', 'constructor', 'prototype']) {
    assert.ok(note.unmapped.some((item) => item.header === header), `unmapped should list ${header}`);
  }
});

const SUBFORMED = `application "Widget"
{
form Material
{
must have unique Material_Name
(
type = text
displayname = "Material Name"
)
}
form Order
{
must have Title
(
type = text
displayname = "Title"
)
Items
(
type = grid
displayname = "Line Items"
Item
(
type = picklist
values = Material.ID
displayformat = [Material_Name]
)
Qty
(
type = number
displayname = "Qty"
)
Note
(
type = text
displayname = "Note"
)
)
}
list All_Orders
{
show all rows from Order
(
Title as "Title"
Items.Item as "Items"
Items.Qty as "Items Qty"
)
}
list Active_Orders
{
show all rows from Order
(
Title as "Title"
Items as "Line Items"
(
field = Items.Item + " - " + Items.Qty
)
)
}
}
`;

test('dotted JSON subform keys write child rows with parent id, order, and resolved lookups', () => {
  const app = appOf(SUBFORMED);
  const dir = dirOf({
    'Material.json': '{"Material":[{"ID":"10","Material_Name":"Steel"},{"ID":"11","Material_Name":"Copper"}]}',
    'All_Orders.json': '{"All_Orders":[{"ID":"100","Title":"T1","Items.Item":"Steel,Copper","Items.Qty":"2,3"},{"ID":"101","Title":"T2","Items.Item":"Copper","Items.Qty":"5"}]}',
  });
  const loaded = readSourceJson(dir, app);
  const child = loaded.tables.find((table) => table.table === 'Order__Items')!;
  assert.equal(child.rows.length, 3);
  assert.deepEqual(
    child.rows.map((row) => ({ id: row.id, ...row.columns })),
    [
      { id: '100__Items__0', parent_id: '100', row_order: '0', Item: '10', Qty: '2' },
      { id: '100__Items__1', parent_id: '100', row_order: '1', Item: '11', Qty: '3' },
      { id: '101__Items__0', parent_id: '101', row_order: '0', Item: '11', Qty: '5' },
    ],
  );
  assert.equal(loaded.expected.find((item) => item.table === 'Order__Items')?.count, 3);
  const plan = formatCsvPlan(loaded, GUARD);
  assert.match(plan, /Order__Items source 3/);
  assert.match(plan, /Order__Items\.Item matches Material on Material_Name/);
  assert.match(plan, /data fidelity:\n- Order__Items omits Note: not in the flattened Items columns/);
  assert.equal(plan.includes('will not be written'), false);
});

test('a composite report expression and a labeled subform column fill the same child rows', () => {
  const app = appOf(SUBFORMED);
  const dir = dirOf({
    'Material.csv': 'Material Name\nSteel\nCopper\n',
    'All_Orders.csv': 'Title,Items,Items Qty\nT1,"Steel,Copper","2,3"\nT2,Copper,5\n',
    'Active_Orders.csv': 'Title,Line Items\nT1,"Steel - 2,Copper - 3"\nT2,"Copper - 5"\n',
  });
  const loaded = readSourceCsv(dir, app);
  const order = loaded.tables.find((table) => table.table === 'Order')!;
  const material = loaded.tables.find((table) => table.table === 'Material')!;
  const child = loaded.tables.find((table) => table.table === 'Order__Items')!;
  const steel = material.rows.find((row) => row.columns.Material_Name === 'Steel')!.id;
  const copper = material.rows.find((row) => row.columns.Material_Name === 'Copper')!.id;
  const t1 = order.rows.find((row) => row.columns.Title === 'T1')!.id;
  const t2 = order.rows.find((row) => row.columns.Title === 'T2')!.id;
  assert.equal(child.rows.length, 3);
  assert.deepEqual(
    child.rows.map((row) => ({ id: row.id, ...row.columns })),
    [
      { id: `${t1}__Items__0`, parent_id: t1, row_order: '0', Item: steel, Qty: '2' },
      { id: `${t1}__Items__1`, parent_id: t1, row_order: '1', Item: copper, Qty: '3' },
      { id: `${t2}__Items__0`, parent_id: t2, row_order: '0', Item: copper, Qty: '5' },
    ],
  );
  assert.equal(loaded.expected.find((item) => item.table === 'Order__Items')?.count, 3);
  assert.match(formatCsvPlan(loaded, GUARD), /Items,Items Qty → |Items Qty → /);
});

test('a JSON array of objects fills child rows and keeps nested lookup ids', () => {
  const app = appOf(SUBFORMED);
  const dir = dirOf({
    'Material.json': '{"Material":[{"ID":"10","Material_Name":"Steel"},{"ID":"11","Material_Name":"Copper"}]}',
    'All_Orders.json': '{"All_Orders":[{"ID":"100","Title":"T1","Items":[{"Item":{"ID":"10"},"Qty":2},{"Item":"Copper","Qty":"3"}]}]}',
  });
  const loaded = readSourceJson(dir, app);
  const child = loaded.tables.find((table) => table.table === 'Order__Items')!;
  assert.deepEqual(
    child.rows.map((row) => ({ id: row.id, ...row.columns })),
    [
      { id: '100__Items__0', parent_id: '100', row_order: '0', Item: '10', Qty: '2' },
      { id: '100__Items__1', parent_id: '100', row_order: '1', Item: '11', Qty: '3' },
    ],
  );
});

test('mismatched flattened subform column lengths are refused with the row and columns named', () => {
  const app = appOf(SUBFORMED);
  assert.throws(
    () => readSourceJson(dirOf({
      'Material.json': '{"Material":[{"ID":"10","Material_Name":"Steel"}]}',
      'All_Orders.json': '{"All_Orders":[{"ID":"100","Title":"T1","Items.Item":"Steel","Items.Qty":"2,3"}]}',
    }), app),
    /"Items\.Item" in All_Orders\.json row 1 holds 1 Items row\(s\) but a sibling column holds 2/,
  );
});

test('a composite value that does not split on the literal separator is refused', () => {
  const app = appOf(SUBFORMED);
  assert.throws(
    () => readSourceCsv(dirOf({
      'Material.csv': 'Material Name\nSteel\n',
      'Active_Orders.csv': 'Title,Line Items\nT1,Steel\n',
    }), app),
    /"Line Items" in Active_Orders\.csv row 1: "Steel" does not split into Items fields on " - "/,
  );
});

test('conflicting flattened columns that disagree on a child field are refused', () => {
  const app = appOf(SUBFORMED);
  assert.throws(
    () => readSourceJson(dirOf({
      'Material.json': '{"Material":[{"ID":"10","Material_Name":"Steel"}]}',
      'All_Orders.json': '{"All_Orders":[{"ID":"100","Title":"T1","Items.Item":"Steel","Items.Qty":"2"}]}',
      'Active_Orders.json': '{"Active_Orders":[{"ID":"100","Title":"T1","Items":"Steel - 9"}]}',
    }), app),
    /conflicting Qty for 100__Items__0: "2" in All_Orders\.json but the export already gave "9"/,
  );
});

test('a comma followed by whitespace inside a flattened subform value is refused', () => {
  const app = appOf(SUBFORMED);
  assert.throws(
    () => readSourceJson(dirOf({
      'All_Orders.json': '{"All_Orders":[{"ID":"100","Title":"T1","Items.Note":"red, large"}]}',
    }), app),
    /"Items\.Note" in All_Orders\.json row 1: a comma inside a Items value cannot be told from a row break/,
  );
  assert.throws(
    () => readSourceCsv(dirOf({
      'All_Orders.csv': 'Title,Items.Note\nT1,"red, large"\n',
    }), app),
    /a comma inside a Items value cannot be told from a row break/,
  );
  assert.throws(
    () => readSourceJson(dirOf({
      'All_Orders.json': '{"All_Orders":[{"ID":"100","Title":"T1","Items.Note":"a, b,c","Items.Qty":"1,2,3"}]}',
    }), app),
    /a comma inside a Items value cannot be told from a row break/,
  );
});

test('a grouped number in a numeric flattened subform column is refused, and a bad piece is refused', () => {
  const app = appOf(SUBFORMED);
  assert.throws(
    () => readSourceJson(dirOf({
      'All_Orders.json': '{"All_Orders":[{"ID":"100","Title":"T1","Items.Qty":"1,000"}]}',
    }), app),
    /"Items\.Qty" in All_Orders\.json row 1: "1,000" reads as a grouped Items\.Qty number, not 2 rows/,
  );
  assert.throws(
    () => readSourceJson(dirOf({
      'All_Orders.json': '{"All_Orders":[{"ID":"100","Title":"T1","Items.Item":"Steel,Copper","Items.Qty":"2,three"}]}',
    }), app),
    /"Items\.Qty" in All_Orders\.json row 1: "three" is not a Items\.Qty number/,
  );
});

test('a comma split no lookup, number, or date column confirms is refused', () => {
  const app = appOf(SUBFORMED);
  assert.throws(
    () => readSourceJson(dirOf({
      'All_Orders.json': '{"All_Orders":[{"ID":"100","Title":"T1","Items.Note":"a,b"}]}',
    }), app),
    /"Items\.Note" in All_Orders\.json row 1: the Items split into 2 rows is not provable/,
  );
});

test('a comma-safe sibling column confirms a free-text split', () => {
  const app = appOf(SUBFORMED);
  const loaded = readSourceJson(dirOf({
    'Material.json': '{"Material":[{"ID":"10","Material_Name":"Steel"},{"ID":"11","Material_Name":"Copper"}]}',
    'All_Orders.json': '{"All_Orders":[{"ID":"100","Title":"T1","Items.Item":"Steel,Copper","Items.Note":"a,b"}]}',
  }), app);
  const child = loaded.tables.find((table) => table.table === 'Order__Items')!;
  assert.deepEqual(
    child.rows.map((row) => ({ id: row.id, ...row.columns })),
    [
      { id: '100__Items__0', parent_id: '100', row_order: '0', Item: '10', Note: 'a' },
      { id: '100__Items__1', parent_id: '100', row_order: '1', Item: '11', Note: 'b' },
    ],
  );
});

test('two reports that disagree on a parent\'s child-row count are refused with both files named', () => {
  const app = appOf(SUBFORMED);
  assert.throws(
    () => readSourceJson(dirOf({
      'Material.json': '{"Material":[{"ID":"10","Material_Name":"Steel"}]}',
      'All_Orders.json': '{"All_Orders":[{"ID":"100","Title":"T1","Items.Item":"Steel,Copper","Items.Qty":"2,3"}]}',
      'Active_Orders.json': '{"Active_Orders":[{"ID":"100","Title":"T1","Items":"Steel - 2"}]}',
    }), app),
    /All_Orders\.json row 1 holds 2 Items row\(s\) for 100 but Active_Orders\.json row 1 holds 1/,
  );
});

const FILTERED_SUBFORM = `application "Widget"
{
form Add_Product
{
must have Product_Name
(
type = text
displayname = "Product Name"
)
This_is_also_the_subassembly
(
type = checkbox
)
}
form Create_BOM
{
Serial_Number
(
type = text
)
List_Of_Subassemblies
(
type = grid
Product
(
type = picklist
values = Add_Product[This_is_also_the_subassembly == true].ID
displayformat = [Product_Name]
)
Quantity
(
type = number
)
)
}
list All_BOM
{
show all rows from Create_BOM
(
Serial_Number as "Serial Number"
List_Of_Subassemblies.Product as "Subassemblies"
)
}
list Active_BOM
{
show all rows from Create_BOM
(
Serial_Number as "Serial Number"
List_Of_Subassemblies as "Subassemblies"
(
field = List_Of_Subassemblies.Product + " - " + List_Of_Subassemblies.Quantity
)
)
}
}
`;

test('a filtered lookup subform field resolves to record ids like any other lookup', () => {
  const app = appOf(FILTERED_SUBFORM);
  const loaded = readSourceJson(dirOf({
    'Add_Product.json': '{"Add_Product":[{"ID":"7","Product_Name":"Gearbox Assembly"},{"ID":"8","Product_Name":"Control Panel"}]}',
    'All_BOM.json': '{"All_BOM":[{"ID":"1","Serial_Number":"SN1","List_Of_Subassemblies.Product":"Gearbox Assembly,Control Panel"}]}',
    'Active_BOM.json': '{"Active_BOM":[{"ID":"1","Serial_Number":"SN1","List_Of_Subassemblies":"Gearbox Assembly - 1,Control Panel - 1"}]}',
  }), app);
  const child = loaded.tables.find((table) => table.table === 'Create_BOM__List_Of_Subassemblies')!;
  assert.deepEqual(
    child.rows.map((row) => ({ id: row.id, ...row.columns })),
    [
      { id: '1__List_Of_Subassemblies__0', parent_id: '1', row_order: '0', Product: '7', Quantity: '1' },
      { id: '1__List_Of_Subassemblies__1', parent_id: '1', row_order: '1', Product: '8', Quantity: '1' },
    ],
  );
  const plan = formatCsvPlan(loaded, GUARD);
  assert.match(plan, /Create_BOM__List_Of_Subassemblies\.Product matches Add_Product on Product_Name/);
  assert.doesNotMatch(plan, /filtered lookup/);
});

test('a lookup column with no remap is a plan error, not a degrade', () => {
  const app = appOf(`application "Widget"
{
form Book
{
Title
(
type = text
)
Author
(
type = picklist
values = Missing.ID
)
}
`);
  assert.throws(() => readSourceJson(dirOf({ 'Book.json': '{"Book":[{"ID":"1","Title":"T"}]}' }), app), /lookup Book\.Author has no remap/);
});

test('a confirmed migrate reports the omitted subform fields under data fidelity', async () => {
  const app = appOf(SUBFORMED);
  const dir = dirOf({
    'Material.csv': 'Material Name\nSteel\n',
    'All_Orders.csv': 'Title,Items,Items Qty\nT1,Steel,2\n',
  });
  const store = quirkRowServer();
  const result = await migrateCsv({
    app,
    dir,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, true, JSON.stringify(result.tables));
  assert.deepEqual(result.fidelity, ['Order__Items omits Note: not in the flattened Items columns']);
  assert.equal(result.tables.find((table) => table.table === 'Order__Items')?.writtenCount, 1);
});

test('a confirmed migrate links each child row to its own parent ROWID', async () => {
  const app = appOf(SUBFORMED);
  const dir = dirOf({
    'Material.csv': 'Material Name\nSteel\nCopper\n',
    'All_Orders.csv': 'Title,Items,Items Qty\nT1,Steel,2\nT2,"Steel,Copper","1,2"\n',
  });
  const store = quirkRowServer();
  const result = await migrateCsv({
    app,
    dir,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, true, JSON.stringify(result.tables));
  const loaded = readSourceCsv(dir, app);
  const orderId = (title: string) => loaded.tables.find((table) => table.table === 'Order')!.rows.find((row) => row.columns.Title === title)!.id;
  const t1 = orderId('T1');
  const t2 = orderId('T2');
  const stored = (table: string, id: string) => store.stored.get(`${table}\0${id}`);
  const rowids = [...store.stored.values()].map((row) => String(row.ROWID));
  assert.equal(new Set(rowids).size, rowids.length, 'the fake stored duplicate ROWIDs');
  assert.equal(String(stored('Order__Items', `${t1}__Items__0`)!.parent_id), String(stored('Order', t1)!.ROWID));
  assert.equal(String(stored('Order__Items', `${t2}__Items__0`)!.parent_id), String(stored('Order', t2)!.ROWID));
  assert.notEqual(String(stored('Order__Items', `${t1}__Items__0`)!.parent_id), String(stored('Order', t2)!.ROWID));
});

test('multi lookup import stores mapped ROWIDs in junction rows and preserves value order', async () => {
  const app = appOf(MULTI_LOOKUP);
  const dir = dirOf({
    'All_Members.csv': 'ID,Name\n31,Ada\n32,Lin\n33,Sam\n',
    'All_Teams.csv': 'ID,Name,Members\n9,Core,"33,31,32"\n',
  });
  const store = quirkRowServer();
  const result = await migrateCsv({ app, dir, dc: 'in', catalystBase: 'https://api.catalyst.zoho.in', fetch: store.fetch, checkpoint: emptyCheckpoint(), scope: SCOPE });
  assert.equal(result.ok, true, JSON.stringify(result.tables));
  const loaded = readSourceCsv(dir, app);
  const junction = loaded.tables.find((table) => table.table.includes('__Members'))!;
  const parent = store.stored.get(`Team\0${loaded.tables.find((table) => table.table === 'Team')!.rows[0]!.id}`)!;
  const linked = junction.rows.map((row) => store.stored.get(`${junction.table}\0${row.id}`)!);
  const members = ['33', '31', '32'].map((id) => String(store.stored.get(`Member\0${id}`)!.ROWID));
  assert.deepEqual(linked.map((row) => String(row.parent_id)), [String(parent.ROWID), String(parent.ROWID), String(parent.ROWID)]);
  assert.deepEqual(linked.map((row) => String(row.row_order)), ['0', '1', '2']);
  assert.deepEqual(linked.map((row) => String(row.Members)), members);
  assert.ok(linked.every((row) => !['31', '32', '33'].includes(String(row.parent_id))));
  assert.ok(linked.every((row) => !['31', '32', '33'].includes(String(row.Members))));
});

const RETURNS = `application "Widget"
{
form Form_Return
{
must have Returned_On
(
type = date
displayname = "Returned On"
)
}
form Form_Sales
{
must have Title
(
type = text
displayname = "Title"
)
Form_Returns_Details
(
type = list
values = Form_Return.ID
displayformat = [Returned_On]
)
}
}
`;

test('an ambiguous lookup display is refused with the export fix named, and a list of ids resolves', () => {
  const app = appOf(RETURNS);
  assert.throws(
    () => readSourceJson(dirOf({
      'Form_Return.json': '{"Form_Return":[{"ID":"1","Returned_On":"08-Oct-2026"},{"ID":"2","Returned_On":"08-Oct-2026"}]}',
      'Form_Sales.json': '{"Form_Sales":[{"ID":"9","Title":"S","Form_Returns_Details":"08-Oct-2026"}]}',
    }), app),
    /ambiguous for "08-Oct-2026" in Form_Return \(2 rows\); export a column that carries the Form_Return record ID or a unique display field/,
  );
  const loaded = readSourceJson(dirOf({
    'Form_Return.json': '{"Form_Return":[{"ID":"1","Returned_On":"08-Oct-2026"},{"ID":"2","Returned_On":"08-Oct-2026"}]}',
    'Form_Sales.json': '{"Form_Sales":[{"ID":"9","Title":"S","Form_Returns_Details":[{"ID":"1"},{"ID":"2"}]}]}',
  }), app);
  const junction = loaded.tables.find((table) => table.table === 'Form_Sales__Form_Returns_Details')!;
  assert.equal(junction.rows.length, 2);
  assert.deepEqual(
    junction.rows.map((row) => row.columns.Form_Returns_Details).sort(),
    ['1', '2'],
  );
});

test('a re-run corrects subform lookup cells still holding raw record ids', async () => {
  const app = appOf(FILTERED_SUBFORM);
  const dir = dirOf({
    'Add_Product.json': '{"Add_Product":[{"ID":"7","Product_Name":"Gearbox Assembly"},{"ID":"8","Product_Name":"Control Panel"}]}',
    'All_BOM.json': '{"All_BOM":[{"ID":"1","Serial_Number":"SN1","List_Of_Subassemblies.Product":"Gearbox Assembly,Control Panel"}]}',
    'Active_BOM.json': '{"Active_BOM":[{"ID":"1","Serial_Number":"SN1","List_Of_Subassemblies":"Gearbox Assembly - 1,Control Panel - 1"}]}',
  });
  const store = quirkRowServer();
  const opts = { app, dir, format: 'json' as const, dc: 'in' as const, catalystBase: 'https://api.catalyst.zoho.in', fetch: store.fetch, scope: SCOPE };
  const first = await migrateCsv({ ...opts, checkpoint: emptyCheckpoint() });
  assert.equal(first.ok, true, JSON.stringify(first.integrity?.refusedByRule));
  const childTable = 'Create_BOM__List_Of_Subassemblies';
  const products = ['7', '8'];
  for (const row of ['0', '1']) {
    const stored = store.stored.get(`${childTable}\0${`1__List_Of_Subassemblies__${row}`}`)!;
    const rowid = stored.Product;
    assert.match(String(rowid), /^\d+$/);
    stored.Product = products[Number(row)]!; // the raw Creator id the pre-remap loader wrote
  }
  const second = await migrateCsv({ ...opts, checkpoint: emptyCheckpoint() });
  assert.equal(second.ok, true, JSON.stringify(second.integrity?.refusedByRule));
  assert.equal(second.integrity?.correctedLookups, 2);
  assert.equal(second.tables.find((table) => table.table === childTable)?.correctedLookups, 2);
  for (const batch of store.puts) {
    for (const update of batch) assert.deepEqual(Object.keys(update).sort(), ['Product', 'ROWID']);
  }
  const third = await migrateCsv({ ...opts, checkpoint: emptyCheckpoint() });
  assert.equal(third.ok, true);
  assert.equal(third.integrity?.correctedLookups ?? 0, 0);
});

const PARTIAL = `application "Widget"
{
form Vendor
{
must have Vendor_Name
(
type = text
displayname = "Vendor Name"
)
must have Created_Date
(
type = date
displayname = "Created Date"
)
Phone
(
type = phonenumber
displayname = "Phone"
)
}
list Vendor_Summary
{
show all rows from Vendor
(
Vendor_Name as "Vendor Name"
)
}
}
`;

function cliIo(dir?: { fetched: string[]; tokens: number; rest?: (call: RestCall) => Promise<RestResult>; fetch?: FetchLike }) {
  let out = '';
  let err = '';
  const fetched = dir?.fetched ?? [];
  const io: Io = {
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
    env: { X_ZC_CREDENTIAL_PATH: '/tmp/cred-DO-NOT-PRINT' },
    cliDc: () => undefined,
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    rest: dir?.rest ?? (async (call) => {
      if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+$/.test(call.path)) {
        const projectId = call.path.split('/').at(-1) ?? '';
        return {
          status: 200,
          body: {
            status: 'success',
            data: {
              id: projectId,
              project_name: 'c2c-widget',
              project_type: 'Live',
              timezone: 'Asia/Kolkata',
              project_domain_details: { project_domain_id: '10', project_domain_name: 'c2c-widget' },
              env_details: [{ env_name: 'Development', env_type: 1, env_zgid: '10000000000', id: '10000000000', is_default: true, project_details: { id: projectId, project_name: 'c2c-widget' } }],
            },
          },
        };
      }
      // No provisioned tables: every Creator flag stands as the store constraint.
      if (call.method === 'GET' && call.path.endsWith('/table')) return { status: 200, body: { data: [] } };
      return { status: 404, body: {} };
    }),
    fetch: dir?.fetch ?? (async (url) => {
      fetched.push(url);
      throw new Error('network refused in this test');
    }),
    accessToken: async () => {
      if (dir) dir.tokens += 1;
      return SCOPE.token;
    },
  };
  return { io, out: () => out, err: () => err };
}

function dsFile(text: string): string {
  const ds = join(mkdtempSync(join(tmpdir(), 'c2c-export-ds-')), 'widget.ds');
  writeFileSync(ds, text);
  return ds;
}

function projectsFile(): string {
  const projects = join(mkdtempSync(join(tmpdir(), 'c2c-export-projects-')), 'projects.json');
  writeFileSync(projects, JSON.stringify({ org: '10000000000', dc: 'in', env: 'Development', projects: { 'c2c-widget': '1001' } }));
  return projects;
}

test('a report that omits a mandatory field is flagged per row, before any write', async () => {
  const app = appOf(PARTIAL);
  const dir = dirOf({ 'Vendor_Summary.csv': 'Vendor Name\nAcme\nNorthwind\n' });
  const loaded = readSourceCsv(dir, app);
  assert.equal(loaded.missingMandatory.length, 2);
  assert.deepEqual(loaded.missingMandatory.map((item) => item.column), ['Created_Date', 'Created_Date']);
  assert.equal(loaded.missingMandatory[0]?.table, 'Vendor');
  assert.deepEqual(loaded.absentFields, [{ form: 'Vendor', table: 'Vendor', field: 'Phone' }]);
  const plan = formatCsvPlan(loaded, GUARD);
  assert.match(plan, /mandatory missing \(confirm will refuse before any write\):\n- Vendor\.Created_Date row d_[0-9a-f]{64}/);
  assert.match(plan, /Vendor\.Phone \(Vendor\) is not in the export/);

  const fetched: string[] = [];
  const state = { fetched, tokens: 0 };
  const { io, out, err } = cliIo(state);
  const code = await sourceCsvCli(
    ['--source-csv', dir, '--ds', dsFile(PARTIAL), '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile()],
    io,
  );
  assert.equal(code, 1);
  assert.equal(fetched.length, 0, 'plan mode never calls the network');
  assert.equal(state.tokens, 0, 'plan mode never mints a token');
  assert.match(out(), /Vendor\.Created_Date row d_/);
  assert.match(err(), /mandatory value\(s\) missing/);
});

test('confirm refuses the same missing mandatory export before credentials or writes, and files the reports', async () => {
  const dir = dirOf({ 'Vendor_Summary.json': '{"Vendor_Summary":[{"ID":"77","Vendor_Name":"Acme"}]}' });
  const fetched: string[] = [];
  const state = { fetched, tokens: 0 };
  const { io, err } = cliIo(state);
  const code = await sourceCsvCli(
    ['--source-json', dir, '--ds', dsFile(PARTIAL), '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile(), '--confirm'],
    io,
  );
  assert.equal(code, 1);
  assert.equal(fetched.length, 0, 'no row write ran');
  assert.equal(state.tokens, 0, 'no token was minted');
  assert.match(err(), /refused: 1 mandatory value\(s\) missing; nothing was written/);
  assert.match(err(), /Vendor\.Created_Date is store-mandatory; fix the source or re-provision the column without the constraint/);
  assert.match(err(), /Vendor\.Created_Date 77 refused mandatory-missing/);
  const loader = JSON.parse(readFileSync(join(dir, 'c2c-load-report.json'), 'utf8')) as { kind: string; integrity: { refusedByRule: { rule: string }[] } };
  assert.equal(loader.kind, 'loader-integrity');
  assert.equal(loader.integrity.refusedByRule[0]?.rule, 'mandatory-missing');
  const fidelity = JSON.parse(readFileSync(join(dir, 'c2c-fidelity.json'), 'utf8')) as { kind: string; ok: boolean; error?: string; tables: unknown[] };
  assert.equal(fidelity.kind, 'data-fidelity');
  assert.equal(fidelity.ok, false);
  assert.match(String(fidelity.error), /refused 1 missing mandatory value\(s\) before any write/);
  assert.deepEqual(fidelity.tables, []);
  const md = readFileSync(join(dir, 'c2c-fidelity.md'), 'utf8');
  assert.match(md, /# c2c data fidelity/);
  assert.match(md, /refused: refused 1 missing mandatory value\(s\)/);
  assert.equal(md.includes('Acme'), false, 'no cell values in the report');
});

test('confirm reports a missing mandatory value and an over-length value together, before any write', async () => {
  const over = 'a'.repeat(256);
  const dir = dirOf({ 'Vendor_Summary.json': `{"Vendor_Summary":[{"ID":"77","Vendor_Name":"${over}"}]}` });
  const fetched: string[] = [];
  const state = { fetched, tokens: 0 };
  const { io, err } = cliIo(state);
  const code = await sourceCsvCli(
    ['--source-json', dir, '--ds', dsFile(PARTIAL), '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile(), '--confirm'],
    io,
  );
  assert.equal(code, 1);
  assert.equal(fetched.length, 0, 'no row write ran');
  assert.equal(state.tokens, 0, 'no token was minted');
  assert.match(err(), /refused: 1 missing mandatory value\(s\) and 1 over-length value\(s\); nothing was written/);
  assert.match(err(), /Vendor\.Created_Date 77 refused mandatory-missing/);
  assert.match(err(), /Vendor\.Vendor_Name 77 refused text-length/);
  const loader = JSON.parse(readFileSync(join(dir, 'c2c-load-report.json'), 'utf8')) as { integrity: { refusedByRule: { rule: string; count: number }[] } };
  assert.deepEqual(
    loader.integrity.refusedByRule.map((item) => item.rule),
    ['text-length', 'mandatory-missing'],
  );
  const fidelity = JSON.parse(readFileSync(join(dir, 'c2c-fidelity.json'), 'utf8')) as { ok: boolean; error?: string };
  assert.equal(fidelity.ok, false);
  assert.match(String(fidelity.error), /refused 1 missing mandatory value\(s\) and 1 over-length value\(s\) before any write/);
  assert.ok(!err().includes(over), 'the value never reaches stderr');
});

test('a confirmed load replays the provisioned demotion: a column the store relaxed accepts the missing export', async () => {
  const dir = dirOf({ 'Vendor_Summary.json': '{"Vendor_Summary":[{"ID":"77","Vendor_Name":"Acme"}]}' });
  const store = quirkRowServer();
  const fetched: string[] = [];
  const state = { fetched, tokens: 0 };
  const { io, err } = cliIo({
    ...state,
    fetch: store.fetch,
    rest: async (call) => {
      if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+$/.test(call.path)) {
        const projectId = call.path.split('/').at(-1) ?? '';
        return {
          status: 200,
          body: {
            status: 'success',
            data: {
              id: projectId,
              project_name: 'c2c-widget',
              project_type: 'Live',
              timezone: 'Asia/Kolkata',
              project_domain_details: { project_domain_id: '10', project_domain_name: 'c2c-widget' },
              env_details: [{ env_name: 'Development', env_type: 1, env_zgid: '10000000000', id: '10000000000', is_default: true, project_details: { id: projectId, project_name: 'c2c-widget' } }],
            },
          },
        };
      }
      // Vendor was provisioned with Created_Date demoted: the store reports
      // is_mandatory false, so a later export that never carries it still loads.
      if (call.method === 'GET' && call.path.endsWith('/table')) {
        return {
          status: 200,
          body: {
            data: [
              {
                table_name: 'Vendor',
                table_id: 't1',
                column_details: [
                  { column_name: 'Vendor_Name', is_mandatory: true, is_unique: false },
                  { column_name: 'Created_Date', is_mandatory: false, is_unique: false },
                  { column_name: 'Phone', is_mandatory: false, is_unique: false },
                  { column_name: 'c2c_source_id', is_mandatory: false, is_unique: true },
                ],
              },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    },
  });
  const code = await sourceCsvCli(
    ['--source-json', dir, '--ds', dsFile(PARTIAL), '--app', 'Widget', '--project', '1001', '--org', '10000000000', '--projects', projectsFile(), '--confirm'],
    io,
  );
  assert.equal(code, 0, err());
  assert.equal(store.stored.size, 1, 'the demoted column is not refused');
});

test('migrateCsv refuses missing mandatory before the first table write', async () => {
  const app = appOf(PARTIAL);
  const dir = dirOf({ 'Vendor_Summary.csv': 'Vendor Name\nAcme\n' });
  const store = quirkRowServer();
  const result = await migrateCsv({
    app,
    dir,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(store.posts.length, 0);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /refused 1 missing mandatory value\(s\) before any write/);
  assert.equal(result.integrity?.refusedByRule[0]?.rule, 'mandatory-missing');
  assert.equal(JSON.stringify(result).includes('Acme'), false, 'the refusal carries no cell values');
});

test('the fidelity body folds counts, checksums, and ids but never cell values', async () => {
  const app = appOf(APP);
  const dir = dirOf({
    'All_Vendors.csv': 'Vendor Name,Phone\nAcme,555-0101\n',
    'All_Purchase_Orders.csv': 'PO Title,Vendor\nRestock,Acme\n',
  });
  const store = quirkRowServer();
  const result = await migrateCsv({
    app,
    dir,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, true);
  const body = fidelityBody(result) as { kind: string; ok: boolean; tables: Record<string, unknown>[] };
  assert.equal(body.kind, 'data-fidelity');
  assert.equal(body.ok, true);
  for (const table of body.tables) {
    assert.equal(table.idsMatch, true);
    assert.equal(table.valuesMatch, true);
    assert.equal(table.sourceChecksum, table.writtenChecksum);
    assert.equal(table.sourceValueChecksum, table.writtenValueChecksum);
    assert.equal(typeof table.sourceChecksum, 'string');
  }
  const md = formatFidelityMd(result);
  assert.match(md, /## Vendor\n- rows: source 1 written 1\n- id checksums: source [0-9a-f]+ written [0-9a-f]+ \(match\)\n- value checksums: source [0-9a-f]+ written [0-9a-f]+ \(match\)/);
  assert.equal(md.includes('555-0101'), false, 'no cell values in the markdown');

  const drift = quirkRowServer({ storeDrift: { Phone: '999' } });
  const drifted = await migrateCsv({
    app,
    dir,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: drift.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  const driftedBody = fidelityBody(drifted) as { ok: boolean; tables: Record<string, unknown>[] };
  const vendor = driftedBody.tables.find((table) => table.table === 'Vendor')!;
  assert.equal(driftedBody.ok, false);
  assert.equal(vendor.valuesMatch, false);
  assert.notEqual(vendor.sourceValueChecksum, vendor.writtenValueChecksum);
  assert.equal((vendor.differingIds as string[]).length, 1);
  assert.equal(JSON.stringify(driftedBody).includes('999'), false, 'drift evidence is ids and checksums, not values');
});

test('migrateSeed refuses before the first write when a required column is absent', async () => {
  const store = quirkRowServer();
  const result = await migrateSeed({
    tables: [{ table: 'Vendor', rows: [{ id: 's1', columns: { Phone: '555-0101' } }] }],
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
    columnsByTable: { Vendor: [{ name: 'Vendor_Name', dataType: 'VarChar', length: 40, required: true }, { name: 'Phone', dataType: 'VarChar', required: false }] },
  });
  assert.equal(store.posts.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.integrity?.refusedByRule[0]?.rule, 'mandatory-missing');
  assert.deepEqual(result.integrity?.refusedByRule[0]?.rows[0], { table: 'Vendor', column: 'Vendor_Name', sourceId: 's1' });
});

test('isLoaderSidecar propagates app schema mismatch instead of treating the file as a manifest', () => {
  // If the app has a report named "seed" pointing to a non-existent form,
  // seed.json is treated as an export, but resolveFile throws because it has no table spec.
  const app = appOf(`application "Widget" { form foo { } list seed { show all rows from Nope ( foo as "foo" ) } }`);
  const dir = dirOf({ 'seed.json': JSON.stringify({ foo: [] }) });
  // Instead of silently deciding it's not a sidecar and then failing as "does not match a report"
  // or accepting it, it should throw the exact 'does not match a Data Store form' error.
  assert.throws(() => readSourceJson(dir, app), /seed\.json does not match a Data Store form/);
});
