import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildModel, buildUi, type UiField, type UiModel, type UiReport } from '../src/index.js';

/**
 * Lookup display values. `displayformat = [Field]` picks the display field for
 * the lookup endpoint and the report's parent read; a `displayformat`
 * expression over one composite field keeps its part refs; a column
 * `displaytrue`/`displayfalse` swaps a boolean cell, a `field =` formula is the
 * cell text, and `view =` is a report link.
 */

type Decorate = (model: UiModel, app: App) => void;

async function loadDecorator(): Promise<Decorate> {
  const spec = '../src/decorations/lookups.js';
  const mod = (await import(spec)) as { lookupDisplay?: Decorate };
  const fn = mod.lookupDisplay;
  assert.equal(typeof fn, 'function', 'decorations/lookups.ts does not export lookupDisplay');
  return fn as Decorate;
}

interface ClientModule {
  joinDisplayParts(value: unknown): string;
  lookupRefValue(row: unknown, ref: string): unknown;
  displayFormulaTerms(formula: unknown): ({ ref: string } | { text: string })[] | undefined;
  formulaCellText(formula: unknown, row: unknown): string | undefined;
  booleanCellText(column: unknown, value: unknown): string | undefined;
  reportCellLink(column: unknown): { href: string; text: string } | undefined;
  lookupCellText(column: unknown, row: unknown, parents: unknown): string | undefined;
  displayCell(column: unknown, row: unknown, ctx?: unknown): { text?: string; link?: { href: string; text: string } } | undefined;
  applyLookupDisplays(report: unknown, tbody: unknown, rows?: unknown, ctx?: unknown): number;
}

async function loadClient(): Promise<ClientModule> {
  const mod = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client/40-lookup-display.js')).href)) as ClientModule;
  assert.equal(typeof mod.displayCell, 'function', 'client/40-lookup-display.js does not export displayCell');
  return mod;
}

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function field(name: string, type: string, extra = '', modifiers = ''): string {
  const head = modifiers ? `${modifiers} ${name}` : name;
  const lines = extra ? `\t\t\ttype = ${type}\n${extra}` : `\t\t\ttype = ${type}`;
  return `\t\t${head}\n\t\t(\n${lines}\n\t\t)`;
}

/** A short excerpt in the shape of the bill-of-materials app. */
function bomBody(): string {
  return `\tsection Main
\t{
\t\tform Add_Product
\t\t{
${field('Product_Name', 'text', '\t\t\tdisplayname = "Product Name"')}
\t\t}
\t\tform Add_Production_Batch
\t\t{
${field('Batch_No', 'text', '\t\t\tdisplayname = "Batch No"')}
\t\t}
\t\tform Add_User
\t\t{
\t\t\tName
\t\t\t(
\t\t\t\ttype = name
\t\t\t\tprefix
\t\t\t\t(
\t\t\t\t\ttype = text
\t\t\t\t)
\t\t\t\tfirst_name
\t\t\t\t(
\t\t\t\t\ttype = text
\t\t\t\t)
\t\t\t\tlast_name
\t\t\t\t(
\t\t\t\t\ttype = text
\t\t\t\t)
\t\t\t\tsuffix
\t\t\t\t(
\t\t\t\t\ttype = text
\t\t\t\t)
\t\t\t)
\t\t}
\t\tform Create_BOM
\t\t{
\t\t\tmust have Product
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tvalues  = Add_Product.ID
    \t\t\tdisplayformat = [Product_Name]
\t\t\t)
\t\t\tmust have Production_Batch
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tdisplayname = "Production Batch"
\t\t\t\tvalues  = Add_Production_Batch.ID
    \t\t\tdisplayformat = [Batch_No]
\t\t\t)
\t\t\tCreated_By
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tdisplayname = "Created By"
\t\t\t\tvalues  = Add_User.ID
    \t\t\tdisplayformat = [" " + Name.prefix + " " + Name.first_name + " " + Name.last_name + " " + Name.suffix]
\t\t\t)
\t\t}
\t\tlist Active_BOM
\t\t{
\t\t\tdisplayName = "Active BOM"
\t\t\tshow all rows from Create_BOM
\t\t\t(
\t\t\t\tProduct
\t\t\t\tProduction_Batch as "Production Batch"
\t\t\t\t(
\t\t\t\t\tview = All_Production_Batches
\t\t\t\t)
\t\t\t\tThis_is_also_the_subassembly as "Type"
\t\t\t\t(
\t\t\t\t\tdisplaytrue = "Subassembly"
\t\t\t\t\tdisplayfalse = "Final Product"
\t\t\t\t)
\t\t\t\tList_Of_Subassemblies as "Subassemblies"
\t\t\t\t(
\t\t\t\t\tfield = List_Of_Subassemblies.Product + " - " + List_Of_Subassemblies.Quantity
\t\t\t\t)
\t\t\t\tCreated_By
\t\t\t)
\t\t}
\t\tlist All_Production_Batches
\t\t{
\t\t\tdisplayName = "Active Batches"
\t\t\tshow all rows from Add_Production_Batch
\t\t\t(
\t\t\t\tBatch_No
\t\t\t)
\t\t}
\t}`;
}

type DisplayLookup = { form: string; field?: string; endpoint?: string; displayFields?: string[] };
type DisplayField = UiField & { lookup?: DisplayLookup };
type DisplayColumn = UiReport['columns'][number] & {
  displayTrue?: string;
  displayFalse?: string;
  formula?: string;
  view?: string;
  viewLabel?: string;
  lookup?: DisplayLookup;
};

function reportOf(model: UiModel, name: string): UiReport {
  const report = model.reports.find((item) => item.name === name);
  assert.ok(report, `report ${name} missing`);
  return report;
}

function columnOf(report: UiReport, name: string): DisplayColumn {
  const column = report.columns.find((item) => item.field === name) as DisplayColumn | undefined;
  assert.ok(column, `column ${name} missing`);
  return column;
}

function fieldOf(model: UiModel, form: string, name: string): DisplayField {
  const ui = model.forms.find((item) => item.name === form)?.fields.find((item) => item.name === name) as
    | DisplayField
    | undefined;
  assert.ok(ui, `field ${form}.${name} missing`);
  return ui;
}

test('displayformat picks the lookup display field on selects and report columns', async () => {
  const decorate = await loadDecorator();
  const app = appOf(bomBody());
  const model = buildModel(app);
  decorate(model, app);
  // `values = Add_Product.ID` with `displayformat = [Product_Name]` asks the
  // parent for the name, not the link field.
  const product = fieldOf(model, 'Create_BOM', 'Product');
  assert.equal(product.lookup?.endpoint, '/lookups/Add_Product/Product_Name');
  assert.equal(product.lookup?.field, 'Product_Name');
  const batch = fieldOf(model, 'Create_BOM', 'Production_Batch');
  assert.equal(batch.lookup?.endpoint, '/lookups/Add_Production_Batch/Batch_No');
  // A `displayformat` expression over one composite field keeps its part refs.
  const created = fieldOf(model, 'Create_BOM', 'Created_By');
  assert.equal(created.lookup?.field, 'Name');
  assert.equal(created.lookup?.endpoint, '/lookups/Add_User/Name');
  assert.deepEqual(created.lookup?.displayFields, ['Name.prefix', 'Name.first_name', 'Name.last_name', 'Name.suffix']);
  const active = reportOf(model, 'Active_BOM');
  assert.equal(columnOf(active, 'Product').lookup?.field, 'Product_Name');
  assert.equal(columnOf(active, 'Production_Batch').lookup?.field, 'Batch_No');
  const createdColumn = columnOf(active, 'Created_By');
  assert.equal(createdColumn.lookup?.field, 'Name');
  assert.deepEqual(createdColumn.lookup?.displayFields, ['Name.prefix', 'Name.first_name', 'Name.last_name', 'Name.suffix']);
});

test('displaytrue, displayfalse, field formula, and view land on the column', async () => {
  const decorate = await loadDecorator();
  const app = appOf(bomBody());
  const model = buildModel(app);
  decorate(model, app);
  const active = reportOf(model, 'Active_BOM');
  const type = columnOf(active, 'This_is_also_the_subassembly');
  assert.equal(type.displayTrue, 'Subassembly');
  assert.equal(type.displayFalse, 'Final Product');
  assert.equal(columnOf(active, 'List_Of_Subassemblies').formula, 'List_Of_Subassemblies.Product + " - " + List_Of_Subassemblies.Quantity');
  const batch = columnOf(active, 'Production_Batch');
  assert.equal(batch.view, 'All_Production_Batches');
  assert.equal(batch.viewLabel, 'Active Batches');
});

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

async function writeBuilt(body: string): Promise<{ dir: string; load(path: string): Promise<{ default: (req: unknown, res: unknown) => unknown }> }> {
  const built = buildUi(appOf(body));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-lookup-display-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of built.files) {
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.data);
  }
  return {
    dir,
    load: (path: string) => import(pathToFileURL(join(dir, path)).href) as Promise<{ default: (req: unknown, res: unknown) => unknown }>,
  };
}

/** Vendor rows whose display field is a composite name. */
function nameShopBody(): string {
  return `\tsection Main
\t{
\t\tform Vendor
\t\t{
\t\t\tName
\t\t\t(
\t\t\t\ttype = name
\t\t\t\tfirst_name
\t\t\t\t(
\t\t\t\t\ttype = text
\t\t\t\t)
\t\t\t\tlast_name
\t\t\t\t(
\t\t\t\t\ttype = text
\t\t\t\t)
\t\t\t)
\t\t}
\t\tform Order
\t\t{
${field('Title', 'text')}
${field('Vendor', 'picklist', '\t\t\tvalues = Vendor.Name')}
\t\t}
\t\tlist All_Vendors
\t\t{
\t\t\tshow all rows from Vendor
\t\t\t(
\t\t\t\tName
\t\t\t)
\t\t}
\t\tlist All_Orders
\t\t{
\t\t\tshow all rows from Order
\t\t\t(
\t\t\t\tTitle
\t\t\t\tVendor
\t\t\t)
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tVendor
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Vendors = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tName
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tOrder
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Orders = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tTitle
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tVendor
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`;
}

test('the lookup endpoint joins a composite display field into option text', async () => {
  const built = await writeBuilt(nameShopBody());
  try {
    const lookup = await built.load('functions/lookups/lookup.mjs');
    const staff = { user: { profile: 'Staff' } };
    const rows = [{ ROWID: '1', Name: { prefix: 'Ms', first_name: 'Ada', last_name: 'Lovelace', suffix: '' } }];
    const res = await invoke(lookup.default, { ...staff, url: '/lookups/Vendor/Name', body: { rows } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rows, [{ ROWID: '1', Name: 'Ms Ada Lovelace' }]);
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('a report cell shows the joined parts of the parent composite display', async () => {
  const built = await writeBuilt(nameShopBody());
  try {
    const report = await built.load('functions/reports/all-orders.mjs');
    const staff = { user: { profile: 'Staff' } };
    process.env.C2C_DEPLOY_MODE = 'live';
    (globalThis as Record<string, unknown>).__c2cDatastore = {
      query: async (form: string) => {
        if (form === 'Vendor') return [{ ROWID: '7', Name: { first_name: 'Ada', last_name: 'Lovelace' } }];
        return [{ ROWID: '9', Title: 'PO-1', Vendor: '7' }];
      },
    };
    try {
      const res = await invoke(report.default, { ...staff, body: { op: 'query' } });
      assert.equal(res.status, 200);
      const rows = res.body.rows as Record<string, unknown>[];
      assert.equal(rows[0]?.Vendor, 'Ada Lovelace');
    } finally {
      delete process.env.C2C_DEPLOY_MODE;
      delete (globalThis as Record<string, unknown>).__c2cDatastore;
    }
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('cell display: boolean swap, formula text, view link, parent join', async () => {
  const client = await loadClient();
  const decorate = await loadDecorator();
  const app = appOf(bomBody());
  const model = buildModel(app);
  decorate(model, app);
  const active = reportOf(model, 'Active_BOM');
  const type = columnOf(active, 'This_is_also_the_subassembly');
  assert.equal(client.booleanCellText(type, 'true'), 'Subassembly');
  assert.equal(client.booleanCellText(type, 'false'), 'Final Product');
  assert.equal(client.booleanCellText(type, true), 'Subassembly');
  assert.equal(client.booleanCellText({ displayTrue: 'Subassembly' }, 'false'), undefined);
  const subs = columnOf(active, 'List_Of_Subassemblies');
  const row = { 'List_Of_Subassemblies.Product': 'Widget', 'List_Of_Subassemblies.Quantity': '2' };
  assert.equal(client.formulaCellText(subs.formula, row), 'Widget - 2');
  assert.equal(client.displayCell(subs, row)?.text, 'Widget - 2');
  // A formula is the cell text only when every name it reads is on the row.
  assert.equal(client.formulaCellText(subs.formula, { 'List_Of_Subassemblies.Product': 'Widget' }), undefined);
  const batch = columnOf(active, 'Production_Batch');
  assert.deepEqual(client.reportCellLink(batch), { href: '#/report/All_Production_Batches', text: 'Active Batches' });
  assert.deepEqual(client.displayCell(batch, { Production_Batch: '7' }), { link: { href: '#/report/All_Production_Batches', text: 'Active Batches' } });
  // A lookup cell resolves the parent display value for a stored parent id.
  const product = columnOf(active, 'Product');
  const parents = [{ ROWID: '42', Product_Name: 'Widget' }];
  assert.equal(client.lookupCellText(product, { Product: '42' }, parents), 'Widget');
  assert.equal(client.lookupCellText(product, { Product: '43' }, parents), undefined);
  // A composite cell value joins its parts in displayformat order.
  const created = columnOf(active, 'Created_By');
  assert.equal(
    client.displayCell(created, { Created_By: { first_name: 'Ada', last_name: 'Lovelace', prefix: 'Ms', suffix: '' } })?.text,
    'Ms Ada Lovelace',
  );
});

test('applyLookupDisplays rewrites the cells loadRows paints', async () => {
  const client = await loadClient();
  const decorate = await loadDecorator();
  const runtime = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    renderReport(report: unknown): string;
  };
  const app = appOf(bomBody());
  const model = buildModel(app);
  decorate(model, app);
  const active = reportOf(model, 'Active_BOM');
  interface Cell {
    textContent: string;
    querySelector(selector: string): Cell | null;
    querySelectorAll(selector: string): ArrayLike<Cell>;
    getAttribute(name: string): string | null;
    appendChild(child: Cell): void;
  }
  interface Doc {
    querySelector(selector: string): Cell | null;
    createElement(tag: string): Cell;
  }
  const dom = new JSDOM(`<!doctype html><body>${runtime.renderReport(active)}</body>`);
  const document = dom.window.document as unknown as Doc;
  const tbody = document.querySelector('[data-rows] tbody');
  assert.ok(tbody);
  const rows = [
    {
      Product: '42',
      Production_Batch: '7',
      This_is_also_the_subassembly: 'true',
      'List_Of_Subassemblies.Product': 'Widget',
      'List_Of_Subassemblies.Quantity': '2',
      Created_By: { first_name: 'Ada', last_name: 'Lovelace' },
    },
  ];
  const tr = document.createElement('tr');
  for (const column of active.columns) {
    const td = document.createElement('td');
    const value = rows[0][column.field as keyof (typeof rows)[0]];
    td.textContent = value && typeof value === 'object' ? '[object Object]' : String(value ?? '');
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
  const changed = client.applyLookupDisplays(active, tbody, rows);
  assert.equal(changed > 0, true);
  const cells = Array.from(tr.querySelectorAll('td') as unknown as ArrayLike<Cell>);
  const text = (name: string) => cells[active.columns.findIndex((column) => column.field === name)];
  assert.equal(text('Product')?.textContent, '42');
  assert.equal(text('This_is_also_the_subassembly')?.textContent, 'Subassembly');
  assert.equal(text('List_Of_Subassemblies')?.textContent, 'Widget - 2');
  const link = text('Production_Batch')?.querySelector('a');
  assert.ok(link);
  assert.equal(link?.getAttribute('href'), '#/report/All_Production_Batches');
  assert.equal(link?.textContent, 'Active Batches');
  assert.equal(text('Created_By')?.textContent, 'Ada Lovelace');
});

test('lookup options keep the display value from the endpoint response', async () => {
  const runtime = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    loadLookupOptions(view: unknown, endpoint: string): Promise<{ value: string; label: string }[]>;
  };
  const calls: string[] = [];
  const view = {
    fetch: async (url: string) => {
      calls.push(url);
      return { ok: true, text: async () => JSON.stringify({ rows: [{ ROWID: '1', Vendor_Name: 'Acme' }], field: 'Vendor_Name' }) };
    },
  };
  const options = await runtime.loadLookupOptions(view, '/lookups/Vendor/Vendor_Name');
  assert.equal(calls[0]?.startsWith('/lookups/Vendor/Vendor_Name'), true);
  assert.deepEqual(options, [{ value: '1', label: 'Acme' }]);
});
