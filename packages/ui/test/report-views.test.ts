import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { loadCorpusApps } from '../../schema/src/corpus.js';
import { buildModel, buildUi, type UiModel } from '../src/index.js';
import { BASE_CSS } from '../src/styles.js';
import { reportViews } from '../src/decorations/report-views.js';

// E9 / A4, G6: kanban, calendar and timeline read Creator's `options ( ... )`
// block and render lanes, not a table.

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function field(name: string, type: string, extra = ''): string {
  return `\t\t${name}\n\t\t(\n\t\t\ttype = ${type}${extra ? `\n${extra}` : ''}\n\t\t)`;
}

const FORM = `\tform Booking
\t{
${field('Guest', 'text')}
${field('Room', 'text')}
${field('Status', 'picklist', '\t\t\tvalues = {"Open","Done"}')}
${field('Product', 'picklist', '\t\t\tvalues = {"A","B"}')}
${field('Check_In', 'datetime')}
${field('Check_Out', 'datetime')}
${field('Note', 'text')}
\t}`;

function report(kind: string, name: string, options: string, extra = ''): string {
  return `\t${kind} ${name}
\t{
\t\tshow all rows from Booking
\t\t(
\t\t\tGuest
\t\t\tRoom
\t\t)
${extra}\t\toptions
\t\t(
${options
  .split('\n')
  .map((line) => `\t\t\t${line}`)
  .join('\n')}
\t\t)
\t}`;
}

function reportsOf(...bodies: string[]): Record<string, UiModel['reports'][number]> {
  const model = buildUi(appOf([FORM, ...bodies].join('\n'))).model;
  return Object.fromEntries(model.reports.map((item) => [item.name, item]));
}

test('calendar and timeline take start, end and title from the options block', () => {
  const r = reportsOf(
    report('calendar', 'Cal', 'display type = week\ndisplay field = Room\nstart date = Check_In\nend date = Check_Out'),
    report('timeline', 'Line', 'display field = Guest\nstart date = Check_In'),
  );
  assert.equal(r.Cal.status, 'generated', r.Cal.todo);
  assert.equal(r.Cal.view, 'calendar');
  assert.equal(r.Cal.startField, 'Check_In');
  assert.equal(r.Cal.endField, 'Check_Out');
  assert.equal(r.Cal.titleField, 'Room');
  assert.equal(r.Line.status, 'generated', r.Line.todo);
  assert.equal(r.Line.view, 'timeline');
  assert.equal(r.Line.startField, 'Check_In');
  assert.equal(r.Line.endField, undefined);
  assert.equal(r.Line.titleField, 'Guest');
});

test('gantt remains one counted manual TODO without an invented timeline', async () => {
  const model = buildUi(appOf([FORM, report('gantt', 'Plan', 'display field = Room')].join('\n'))).model;
  const plan = model.reports.find((item) => item.name === 'Plan');
  assert.ok(plan);
  assert.equal(plan.status, 'todo');
  assert.equal(plan.view, 'todo');
  assert.match(plan.todo ?? '', /Report type gantt is not generated/);
  assert.deepEqual(model.todos.filter((item) => item.area === 'report' && item.name === 'Plan'), [
    { area: 'report', name: 'Plan', reason: plan.todo },
  ]);
  const runtime = await loadRuntime();
  assert.doesNotThrow(() => runtime.renderReport(plan));
  const html = runtime.renderReport(plan);
  assert.match(html, /data-view="todo"/);
  assert.doesNotMatch(html, /data-view="timeline"|<table/);
});

test('calendar start and end must be date columns of the form, else TODO', () => {
  const r = reportsOf(
    report('calendar', 'TextStart', 'start date = Note'),
    report('calendar', 'Missing', 'start date = Nowhere'),
    report('timeline', 'BadEnd', 'start date = Check_In\nend date = Room'),
    report('calendar', 'NoStart', 'display field = Room'),
  );
  for (const name of ['TextStart', 'Missing', 'BadEnd', 'NoStart']) {
    assert.equal(r[name].status, 'todo', name);
    assert.equal(r[name].startField, undefined, name);
  }
  assert.match(r.TextStart.todo ?? '', /start date "Note" is not a date column of Booking/);
  assert.match(r.Missing.todo ?? '', /start date "Nowhere" is not a date column/);
  assert.match(r.BadEnd.todo ?? '', /end date "Room" is not a date column/);
  assert.match(r.NoStart.todo ?? '', /needs a start date field/);
});

test('kanban lanes follow the options display field over group by', () => {
  const r = reportsOf(
    report('kanban', 'Board', 'display field = Status\nrecord count = enable', '\t\tgroup by\n\t\t(\n\t\t\tProduct\n\t\t)\n'),
    report('kanban', 'Ghost', 'display field = Nowhere', '\t\tgroup by\n\t\t(\n\t\t\tProduct\n\t\t)\n'),
  );
  assert.equal(r.Board.status, 'generated');
  assert.equal(r.Board.groupField, 'Status');
  assert.equal(r.Board.titleField, 'Guest');
  // A display field that is not on the form is ignored, not invented.
  assert.equal(r.Ghost.groupField, 'Product');
});

test('kanban with nothing to group is a counted manual TODO without an invented column', async () => {
  const model = buildUi(
    appOf(`\tform Ungrouped\n\t{\n${field('Title', 'text')}\n${field('Note', 'text')}\n\t}\n\tkanban Bare\n\t{\n\t\tshow all rows from Ungrouped\n\t\t(\n\t\t\tTitle\n\t\t\tNote\n\t\t)\n\t\toptions\n\t\t(\n\t\t)\n\t}`),
  ).model;
  const bare = model.reports.find((item) => item.name === 'Bare');
  assert.ok(bare);
  assert.equal(bare.status, 'todo');
  assert.match(bare.todo ?? '', /needs a group-by field or a dropdown column/);
  assert.equal(bare.groupField, undefined);
  assert.deepEqual(model.todos.filter((item) => item.area === 'report' && item.name === 'Bare'), [
    { area: 'report', name: 'Bare', reason: bare.todo },
  ]);
  const { runtime } = await bootReport(model, 'Bare', [{ Title: 'A', Note: 'B' }]);
  assert.doesNotThrow(() => runtime.renderReport(bare));
});

interface Runtime {
  boot(model: UiModel, doc: Document): Promise<void>;
  renderReport(report: UiModel['reports'][number]): string;
}

async function loadRuntime(): Promise<Runtime> {
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as Runtime;
}

async function bootReport(model: UiModel, name: string, rows: unknown[]) {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const runtime = await loadRuntime();
  const win = new JSDOM('<!doctype html><body><nav id="nav"></nav><main id="main"></main></body>', {
    url: `http://localhost/slate/index.html#/report/${name}`,
  }).window as unknown as { document: Document; fetch: typeof fetch };
  const bodies: Record<string, unknown>[] = [];
  win.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(body);
    return { ok: true, status: 200, json: async () => ({ rows: body.op === 'query' ? rows : [] }) };
  }) as unknown as typeof fetch;
  await runtime.boot(model, win.document);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  return { doc: win.document, bodies, runtime };
}

function lanes(doc: Document): { key: string | null; head: string; items: string[] }[] {
  return Array.from(doc.querySelectorAll('[data-board] [data-lane]')).map((lane) => ({
    key: lane.getAttribute('data-lane'),
    head: lane.querySelector('h3')?.textContent ?? '',
    items: Array.from(lane.querySelectorAll('li')).map((li) => cardTitle(li)),
  }));
}

/** A board card's text without its phone-only field list. */
function cardTitle(li: Element): string {
  const copy = li.cloneNode(true) as Element;
  copy.querySelector('[data-phone-fields]')?.remove();
  return copy.textContent ?? '';
}

test('kanban renders one lane per lane-field value instead of a table', async () => {
  const model = buildUi(appOf([FORM, report('kanban', 'Board', 'display field = Status')].join('\n'))).model;
  const rows = [
    { Guest: 'Ada', Status: 'Open' },
    { Guest: 'Bo', Status: 'Done' },
    { Guest: 'Cy', Status: 'Open' },
    { Guest: '<b>x</b>', Status: '' },
  ];
  const { doc, runtime } = await bootReport(model, 'Board', rows);
  assert.doesNotMatch(runtime.renderReport(model.reports[0]), /<table/);
  assert.equal(doc.querySelector('section[data-report="Board"] table'), null);
  assert.deepEqual(lanes(doc), [
    { key: 'Open', head: 'Open (2)', items: ['Ada', 'Cy'] },
    { key: 'Done', head: 'Done (1)', items: ['Bo'] },
    { key: '', head: '(none) (1)', items: ['<b>x</b>'] },
  ]);
  assert.equal(doc.querySelector('[data-lane] b'), null, 'cell text is not parsed as HTML');
});

test('calendar groups rows by start day and asks the server to sort by the start column', async () => {
  const cal = report('calendar', 'Cal', 'display field = Room\nstart date = Check_In\nend date = Check_Out');
  const model = buildUi(appOf([FORM, cal].join('\n'))).model;
  const rows = [
    { Room: '101', Check_In: '07-Oct-2026 10:00:00', Check_Out: '08-Oct-2026 09:00:00' },
    { Room: '102', Check_In: '07-Oct-2026 14:00:00', Check_Out: '' },
    { Room: '103', Check_In: '09-Oct-2026 08:00:00', Check_Out: '10-Oct-2026 08:00:00' },
  ];
  const { doc, bodies } = await bootReport(model, 'Cal', rows);
  const query = bodies.find((body) => body.op === 'query');
  assert.deepEqual(query?.sort, [{ field: 'Check_In', order: 'ascending' }]);
  assert.deepEqual(lanes(doc), [
    {
      key: '07-Oct-2026',
      head: '07-Oct-2026 (2)',
      items: ['101 — 07-Oct-2026 10:00:00 to 08-Oct-2026 09:00:00', '102 — 07-Oct-2026 14:00:00'],
    },
    { key: '09-Oct-2026', head: '09-Oct-2026 (1)', items: ['103 — 09-Oct-2026 08:00:00 to 10-Oct-2026 08:00:00'] },
  ]);
});

test('gallery: every calendar, timeline and kanban report is generated (C2C_FIXTURES_DIR)', (t) => {
  const fixtures = process.env.C2C_FIXTURES_DIR;
  if (!fixtures) {
    t.skip('C2C_FIXTURES_DIR not set');
    return;
  }
  const counts: Record<string, { total: number; generated: number }> = {};
  for (const app of loadCorpusApps(join(fixtures, 'gallery'))) {
    for (const item of buildUi(app.ir).model.reports) {
      const kind = item.type.toLowerCase();
      if (kind !== 'calendar' && kind !== 'timeline' && kind !== 'kanban') continue;
      const row = (counts[kind] ??= { total: 0, generated: 0 });
      row.total++;
      if (item.status === 'generated') row.generated++;
    }
  }
  // Real exports carry no "based on" for calendar and timeline views.
  assert.deepEqual(counts, {
    calendar: { total: 24, generated: 24 },
    kanban: { total: 13, generated: 13 },
    timeline: { total: 3, generated: 3 },
  });
});

// Quick view, detail view, sort, and group. The phone layout is listed first
// so a web layout has to win on purpose.

const QUICK_LABELS = [
  'Production Batch',
  'Image',
  'Serial Number',
  'Product',
  'List Of Raw Materials',
  'Subassemblies',
  'Subtotal',
  'Other Cost',
  'Grand total (Final Price)',
  'Archive',
];

const VIEWS_APP = appOf(`\tform Create_BOM
\t{
\t\tImage
\t\t(
\t\t\ttype = image
\t\t)
\t\tProduct
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Add_Stock
\t{
\t\tProduct_Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tWarehouse_Code
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Form_Sales
\t{
\t\tProduct_Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tQuantity
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tlist Active_BOM
\t{
\t\tdisplayName = "Active BOM"
\t\tshow all rows from Create_BOM
\t\t(
\t\t\tImage
\t\t\tProduct
\t\t)
\t\tgroup by
\t\t(
\t\t\tProduction_Batch ascending
\t\t)
\t}
\tlist Stock_Details
\t{
\t\tdisplayName = "Stock Details"
\t\tshow all rows from Add_Stock
\t\t(
\t\t\tSales_Qty as "Sales Qty"
\t\t\tWarehouse_Code as "Warehouse Code"
\t\t\tProduct_Name as "Product Name"
\t\t)
\t\tgroup by
\t\t(
\t\t\tWarehouse_Code ascending
\t\t)
\t\tsort by
\t\t(
\t\t\tProduct_Name ascending
\t\t)
\t}
\tpivotchart Report_Monthly
\t{
\t\tdisplayname = "Monthly Sales"
\t\tbased on Autoview_1535370624004_Form_Sales
\t\tshow all rows from Form_Sales
\t\t(
\t\t\tProduct_Name as "Product Name"
\t\t\tQuantity
\t\t)
\t}
\tpivotchart Report_Weekly
\t{
\t\tdisplayname = "Weekly Sales"
\t\tbased on Autoview_1535370624004_Form_Sales
\t\tshow all rows from Form_Sales
\t\t(
\t\t\tProduct_Name as "Product Name"
\t\t\tQuantity
\t\t)
\t}
\tpivotchart Report_Stock
\t{
\t\tdisplayname = "Stock Report"
\t\tbased on Autoview_1535370906299_Add_Stock
\t\tshow all rows from Add_Stock
\t\t(
\t\t\tProduct_Name as "Product Name"
\t\t\tWarehouse_Code as "Warehouse Code"
\t\t)
\t}
\tpages
\t{
\t\tpage Dashboard
\t\t{
\t\t\tdisplayname = "Dashboard"
\t\t\tContent="<zml><layout><row><column width='50%'><report elementName='Report 1' linkName='Report_Weekly'/></column><column width='50%'><report elementName='Report 2' linkName='Report_Monthly'/></column></row></layout></zml>"
\t\t}
\t}
\tphone
\t{
\t\treports
\t\t{
\t\t\treport Active_BOM
\t\t\t{
\t\t\t\tquickview
\t\t\t\t(
\t\t\t\t\tlayout
\t\t\t\t\t(
\t\t\t\t\t\tdatablock1
\t\t\t\t\t\t(
\t\t\t\t\t\t\ttitle = "Phone"
\t\t\t\t\t\t\tfields
\t\t\t\t\t\t\t(
\t\t\t\t\t\t\t\tImage
\t\t\t\t\t\t\t)
\t\t\t\t\t\t)
\t\t\t\t\t)
\t\t\t\t)
\t\t\t}
\t\t}
\t}
\tweb
\t{
\t\treports
\t\t{
\t\t\treport Active_BOM
\t\t\t{
\t\t\t\tquickview
\t\t\t\t(
\t\t\t\t\tlayout
\t\t\t\t\t(
\t\t\t\t\t\tdatablock1
\t\t\t\t\t\t(
\t\t\t\t\t\t\ttitle = "Overview"
\t\t\t\t\t\t\tfields
\t\t\t\t\t\t\t(
\t\t\t\t\t\t\t\tProduction_Batch as "Production Batch"
\t\t\t\t\t\t\t\tImage
\t\t\t\t\t\t\t\tSerial_Number as "Serial Number"
\t\t\t\t\t\t\t\tProduct
\t\t\t\t\t\t\t\tList_Of_Materials.Material as "List Of Raw Materials"
\t\t\t\t\t\t\t\tList_Of_Subassemblies.Product as "Subassemblies"
\t\t\t\t\t\t\t\tSubtotal_Price_Raw_Materials_Subassemblies as "Subtotal"
\t\t\t\t\t\t\t\tOther_Cost as "Other Cost"
\t\t\t\t\t\t\t\tFinal_Price as "Grand total (Final Price)"
\t\t\t\t\t\t\t\t"Archive"
\t\t\t\t\t\t\t)
\t\t\t\t\t\t)
\t\t\t\t\t)
\t\t\t\t)
\t\t\t\tdetailview
\t\t\t\t(
\t\t\t\t\tlayout
\t\t\t\t\t(
\t\t\t\t\t\ttype = 2
\t\t\t\t\t\tdatablock1
\t\t\t\t\t\t(
\t\t\t\t\t\t\ttitle = "Overview"
\t\t\t\t\t\t\tfields
\t\t\t\t\t\t\t(
\t\t\t\t\t\t\t\tImage
\t\t\t\t\t\t\t\tProduct
\t\t\t\t\t\t\t\tProduction_Batch as "Production Batch"
\t\t\t\t\t\t\t)
\t\t\t\t\t\t)
\t\t\t\t\t\tdatablock2
\t\t\t\t\t\t(
\t\t\t\t\t\t\ttitle = "List Of Raw Materials"
\t\t\t\t\t\t\trelated field = List_Of_Materials
\t\t\t\t\t\t\tfields
\t\t\t\t\t\t\t(
\t\t\t\t\t\t\t\tMaterial
\t\t\t\t\t\t\t\tMeasurement_Unit as "Measurement Unit"
\t\t\t\t\t\t\t\tQuantity
\t\t\t\t\t\t\t\tUnit_Price as "Unit Price"
\t\t\t\t\t\t\t\tTotal_Price as "Total Price"
\t\t\t\t\t\t\t)
\t\t\t\t\t\t)
\t\t\t\t\t\tdatablock3
\t\t\t\t\t\t(
\t\t\t\t\t\t\ttitle = "List Of Subassemblies"
\t\t\t\t\t\t\trelated field = List_Of_Subassemblies
\t\t\t\t\t\t\tfields
\t\t\t\t\t\t\t(
\t\t\t\t\t\t\t\tProduct
\t\t\t\t\t\t\t\tMeasurement_Unit as "Measurement Unit"
\t\t\t\t\t\t\t\tQuantity
\t\t\t\t\t\t\t\tUnit_Price as "Unit Price"
\t\t\t\t\t\t\t\tTotal_Price as "Total Price"
\t\t\t\t\t\t\t)
\t\t\t\t\t\t)
\t\t\t\t\t)
\t\t\t\t)
\t\t\t}
\t\t}
\t}`);

function decoratedViews(): UiModel {
  return reportViews(buildModel(VIEWS_APP), VIEWS_APP);
}

function reportNamed(model: UiModel, name: string): UiModel['reports'][number] {
  const report = model.reports.find((item) => item.name === name);
  assert.ok(report, name);
  return report;
}

test('quick view columns replace the report columns, including Archive', () => {
  const model = decoratedViews();
  const active = reportNamed(model, 'Active_BOM');
  assert.deepEqual(
    active.columns.map((column) => column.label),
    QUICK_LABELS,
  );
  const stock = reportNamed(model, 'Stock_Details');
  assert.deepEqual(
    stock.columns.map((column) => column.label),
    ['Sales Qty', 'Warehouse Code', 'Product Name'],
  );
  assert.deepEqual(stock.groupBy, [{ field: 'Warehouse_Code' }]);
  assert.deepEqual(stock.sort, [{ field: 'Product_Name', order: 'ascending' }]);
});

test('detail view keeps the three block titles and their fields', () => {
  const active = reportNamed(decoratedViews(), 'Active_BOM') as UiModel['reports'][number] & {
    detailBlocks?: { title: string; relatedField?: string; fields: { field: string; label: string }[] }[];
  };
  assert.deepEqual(
    (active.detailBlocks ?? []).map((block) => block.title),
    ['Overview', 'List Of Raw Materials', 'List Of Subassemblies'],
  );
  assert.deepEqual(active.detailBlocks?.[0]?.fields.map((field) => field.label), ['Image', 'Product', 'Production Batch']);
  assert.equal(active.detailBlocks?.[1]?.relatedField, 'List_Of_Materials');
  assert.equal(active.detailBlocks?.[2]?.relatedField, 'List_Of_Subassemblies');
});

test('an in-app pivotchart is a generated chart report, not an Analytics note', () => {
  const model = decoratedViews();
  for (const name of ['Report_Monthly', 'Report_Weekly', 'Report_Stock']) {
    const report = reportNamed(model, name);
    assert.equal(report.status, 'generated', name);
    assert.equal(report.view, 'chart', name);
    assert.equal(report.todo, undefined, name);
  }
});

test('a chart report draws bars from its rows and sorts them', async () => {
  const rows = [
    { ROWID: '1', Product_Name: 'Bolt', Quantity: '2' },
    { ROWID: '2', Product_Name: 'Nut', Quantity: '5' },
    { ROWID: '3', Product_Name: 'Bolt', Quantity: '3' },
  ];
  const { doc } = await bootDecorated('Report_Weekly', rows);
  await until(() => doc.querySelectorAll('[data-chart] rect').length === 2);
  const labels = Array.from(doc.querySelectorAll('[data-chart] .chart-tick')).map((tick) => tick.textContent);
  assert.deepEqual(labels.slice(2), ['Bolt', 'Nut'], 'categories sort ascending by label');
  const titles = Array.from(doc.querySelectorAll('[data-chart] rect title')).map((title) => title.textContent);
  assert.deepEqual(titles, ['Bolt: 5', 'Nut: 5'], 'the measure column sums per category');
  const sort = doc.querySelector('button[data-chart-sort]');
  assert.ok(sort);
  sort.dispatchEvent(new (doc.defaultView as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('click', { bubbles: true }));
  const flipped = Array.from(doc.querySelectorAll('[data-chart] .chart-tick')).map((tick) => tick.textContent);
  assert.deepEqual(flipped.slice(2), ['Nut', 'Bolt'], 'Sort toggles the category order');
});

test('a server-capped chart says it drew the first N records', async () => {
  const { doc } = await bootDecorated('Report_Weekly', [], 'report', (body) =>
    body.op === 'aggregate'
      ? { op: 'aggregate', buckets: [{ key: 'Open', values: [12] }], dated: false, truncated: true, scanned: 3000 }
      : { rows: [] },
  );
  await until(() => doc.querySelectorAll('[data-chart] rect').length === 1);
  assert.match(doc.querySelector('.chart-note')?.textContent ?? '', /Drawn from the first 3000 records\./);
});

test('a chart folded from one full page of rows flags the cap', async () => {
  const page = Array.from({ length: 300 }, (_, i) => ({ ROWID: String(i + 1), Product_Name: 'Bolt', Quantity: '1' }));
  const { doc } = await bootDecorated('Report_Weekly', [], 'report', (body) =>
    body.op === 'aggregate' ? {} : { rows: page },
  );
  await until(() => doc.querySelectorAll('[data-chart] rect').length === 1);
  assert.match(doc.querySelector('.chart-note')?.textContent ?? '', /Drawn from the first 300 records\./);
});

test('an empty chart report says No Data Available', async () => {
  const { doc } = await bootDecorated('Report_Stock', []);
  await until(() => !!doc.querySelector('.chart-empty'));
  assert.match(doc.querySelector('.chart-empty')?.textContent ?? '', /No Data Available/);
  assert.ok(doc.querySelector('button[data-chart-refresh]'), 'Refresh stays enabled');
  assert.ok(doc.querySelector('button[data-chart-sort]'), 'Sort stays enabled');
});

test('a page-embedded chart renders inside the page and draws', async () => {
  const rows = [{ ROWID: '1', Product_Name: 'Bolt', Quantity: '4' }];
  const { doc } = await bootDecorated('Dashboard', rows, 'page');
  await until(() => doc.querySelectorAll('.embed [data-chart] rect').length === 2);
  const embeds = doc.querySelectorAll('.embed section[data-view="chart"]');
  assert.equal(embeds.length, 2, 'both dashboard chart panels embed');
  assert.doesNotMatch(doc.body.textContent ?? '', /Zoho Analytics/);
  assert.doesNotMatch(doc.querySelector('.embed')?.innerHTML ?? '', /<a href="#\/report\//, 'the embed is the chart, not a link card');
});

interface ViewsRuntime extends Runtime {
  installReportViews(model: UiModel, doc: Document): void;
}

async function loadViewsRuntime(): Promise<ViewsRuntime> {
  const runtime = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  const extra = readFileSync(join(process.cwd(), 'packages/ui/src/client/50-report-views.js'), 'utf8');
  const source = `${runtime}\n${extra}\n`;
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as ViewsRuntime;
}

async function bootDecorated(
  name: string,
  rows: Record<string, unknown>[],
  kind: 'report' | 'page' = 'report',
  recordIdOrRespond?: string | ((body: { op?: string; page?: number }) => unknown),
  recordReply?: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
) {
  const recordId = typeof recordIdOrRespond === 'string' ? recordIdOrRespond : undefined;
  const respond = typeof recordIdOrRespond === 'function' ? recordIdOrRespond : undefined;
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
  const runtime = await loadViewsRuntime();
  const model = decoratedViews();
  const win = new JSDOM(`<!doctype html><body><nav id="nav"></nav><main id="main"></main></body>`, {
    url: `http://localhost/slate/index.html#/${kind}/${name}${recordId ? `/row/${recordId}` : ''}`,
  }).window as unknown as { document: Document; fetch: typeof fetch; location: { hash: string } };
  const recordReads: { url: string; body: Record<string, unknown> }[] = [];
  win.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown> & { op?: string; page?: number };
    if (respond) return { ok: true, status: 200, json: async () => respond(body) };
    if (body.ROWID != null) recordReads.push({ url, body });
    const matched = rows.find((row) => String(row.ROWID ?? '') === String(body.ROWID ?? ''));
    const payload = body.ROWID != null
      ? { record: matched ?? { ROWID: String(body.ROWID), Product: 'Off page record' } }
      : { rows: body.op === 'query' ? rows : [] };
    if (body.ROWID != null && recordReply) return recordReply();
    return { ok: true, status: 200, json: async () => payload };
  }) as unknown as typeof fetch;
  runtime.installReportViews(model, win.document);
  await runtime.boot(model, win.document);
  await until(() => !recordId || docRecordLoaded(win.document));
  return { doc: win.document, runtime, model, recordReads };
}

function docRecordLoaded(doc: Document): boolean {
  return (doc.body.textContent ?? '').includes('Off page record');
}

async function until(pred: () => boolean) {
  for (let i = 0; i < 40; i++) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('Active BOM list matches the Overview quick view and a row opens three blocks', async () => {
  const rows = [
    {
      ROWID: '9',
      Production_Batch: 'PB-1',
      Image: 'photo.png',
      Serial_Number: 'SN-1',
      Product: 'Widget',
      'List_Of_Materials.Material': 'Steel',
      'List_Of_Subassemblies.Product': 'Bolt',
      Subtotal_Price_Raw_Materials_Subassemblies: '10',
      Other_Cost: '2',
      Final_Price: '12',
      List_Of_Materials: [{ Material: 'Steel', Measurement_Unit: 'kg', Quantity: '2', Unit_Price: '4', Total_Price: '8' }],
      List_Of_Subassemblies: [{ Product: 'Bolt', Measurement_Unit: 'pc', Quantity: '4', Unit_Price: '1', Total_Price: '4' }],
    },
  ];
  const { doc, runtime } = await bootDecorated('Active_BOM', rows);
  const report = reportNamed(decoratedViews(), 'Active_BOM');
  assert.match(runtime.renderReport(report), /Archive/);
  await until(() => !!doc.querySelector('tr[data-row-id="9"]'));
  assert.deepEqual(
    Array.from(doc.querySelectorAll('thead tr')[0]?.querySelectorAll('th') ?? []).map((cell) => cell.textContent),
    QUICK_LABELS,
  );
  const row = doc.querySelector('tr[data-row-id="9"]');
  assert.ok(row, 'row is addressable');
  row.dispatchEvent(new (doc.defaultView as unknown as { Event: typeof Event }).Event('click', { bubbles: true }));
  await until(() => doc.querySelectorAll('[data-block]').length === 3);
  assert.deepEqual(
    Array.from(doc.querySelectorAll('[data-block] h3')).map((title) => title.textContent),
    ['Overview', 'List Of Raw Materials', 'List Of Subassemblies'],
  );
  assert.match(doc.body.textContent ?? '', /Widget/);
  assert.match(doc.body.textContent ?? '', /Steel/);
  assert.equal(doc.querySelector('[data-block="List Of Raw Materials"] td')?.textContent, 'Steel');
});

test('vanilla detail loads an off-page row from the authorized record endpoint', async () => {
  const { doc, recordReads, model } = await bootDecorated('Active_BOM', [], 'report', '907');
  const form = model.forms.find((item) => item.name === 'Create_BOM');
  assert.ok(form?.recordEndpoint);
  assert.equal(recordReads.length, 1);
  assert.equal(recordReads[0]?.url.endsWith(form.recordEndpoint), true);
  assert.deepEqual(recordReads[0]?.body, { ROWID: '907' });
  assert.match(doc.body.textContent ?? '', /Off page record/);
});

test('vanilla detail shows denied and missing record errors and clears loading', async () => {
  for (const [status, message] of [[403, "You can't open this record."], [404, "You can't open this record."]] as const) {
    const { doc } = await bootDecorated('Active_BOM', [], 'report', '907', async () => ({ ok: false, status, json: async () => ({}) }));
    const section = doc.querySelector('section[data-detail]');
    assert.equal(section?.hasAttribute('data-detail-loading'), false, `${status} clears loading`);
    assert.equal(section?.querySelector('[data-detail-error]')?.textContent, message);
  }
});

test('vanilla detail retries a network failure and renders the record after recovery', async () => {
  let attempt = 0;
  const { doc } = await bootDecorated('Active_BOM', [], 'report', '907', async () => {
    attempt++;
    if (attempt === 1) throw new Error('network unavailable');
    return { ok: true, status: 200, json: async () => ({ record: { ROWID: '907', Product: 'Recovered record' } }) };
  });
  const section = doc.querySelector('section[data-detail]');
  assert.equal(section?.hasAttribute('data-detail-loading'), false);
  assert.match(section?.querySelector('[data-detail-error]')?.textContent ?? '', /Unable to load this record/);
  (section?.querySelector('[data-detail-retry]') as Element).dispatchEvent(new (doc.defaultView as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('click', { bubbles: true }));
  await until(() => (doc.body.textContent ?? '').includes('Recovered record'));
  assert.equal(attempt, 2);
});

test('Stock Details groups by Warehouse Code in first-seen order and sorts by Product Name', async () => {
  const rows = [
    { ROWID: '1', Warehouse_Code: 'SOUTH', Product_Name: 'Bolt', Sales_Qty: '2' },
    { ROWID: '2', Warehouse_Code: 'NORTH', Product_Name: 'Nut', Sales_Qty: '1' },
    { ROWID: '3', Warehouse_Code: 'SOUTH', Product_Name: 'Washer', Sales_Qty: '4' },
  ];
  const { doc, runtime, model } = await bootDecorated('Stock_Details', rows);
  for (const name of ['Report_Monthly', 'Report_Weekly', 'Report_Stock']) {
    const html = runtime.renderReport(reportNamed(model, name));
    assert.match(html, /data-view="chart"/, name);
    assert.match(html, /data-chart-refresh/, name);
    assert.match(html, /data-chart-sort/, name);
    assert.doesNotMatch(html, /Zoho Analytics/, name);
  }
  await until(() => doc.querySelectorAll('h3[data-group]').length === 2 && !!doc.querySelector('select[data-sort]'));
  assert.equal(doc.querySelector('[data-group-by]')?.textContent, 'Grouped by Warehouse Code');
  assert.deepEqual(
    Array.from(doc.querySelectorAll('h3[data-group]')).map((head) => head.textContent),
    ['SOUTH', 'NORTH'],
  );
  const select = doc.querySelector('select[data-sort]');
  assert.ok(select);
  const first = select.querySelector('option');
  assert.equal(first?.textContent, 'Product Name ascending');
  assert.equal(first?.getAttribute('data-order'), 'ascending');
  assert.equal(select.getAttribute('data-selected') ?? String((select as { selectedIndex?: number }).selectedIndex), '0');
  const south = doc.querySelector('h3[data-group="SOUTH"]');
  const southTable = south?.nextElementSibling;
  assert.deepEqual(
    Array.from(southTable?.querySelectorAll('tbody td:not([data-card-actions])') ?? []).map((cell) => cell.textContent),
    ['2', 'SOUTH', 'Bolt', '4', 'SOUTH', 'Washer'],
  );
});

function itemListModel(): UiModel {
  return {
    dryRun: true,
    framework: 'vanilla',
    name: 'Items',
    pageSize: 200,
    forms: [],
    pages: [],
    handlers: [],
    todos: [],
    nav: [
      {
        name: 'Main',
        hidden: false,
        items: [{ kind: 'report', name: 'All_Items', label: 'All Items', href: '#/report/All_Items' }],
      },
    ],
    reports: [
      {
        name: 'All_Items',
        label: 'All Items',
        type: 'list',
        view: 'list',
        status: 'generated',
        columns: [
          { field: 'Name', label: 'Name' },
          { field: 'Status', label: 'Status' },
        ],
        filters: [{ field: 'Status', label: 'Open' }],
        sort: [],
        groupBy: [],
        pageSize: 200,
        queryEndpoint: '/server/reports/All_Items',
        customActions: [],
        detail: false,
      },
    ],
  };
}

test('a later report query replaces the rows on screen', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
  const runtime = await loadViewsRuntime();
  const model = itemListModel();
  const dom = new JSDOM('<!doctype html><body><nav id="nav"></nav><main id="main"></main></body>', {
    url: 'http://127.0.0.1/slate/index.html#/report/All_Items',
  });
  const win = dom.window as unknown as {
    document: Document;
    fetch: typeof fetch;
    location: { hash: string };
    Event: typeof Event;
    dispatchEvent(event: Event): boolean;
  };
  let extra = false;
  win.fetch = (async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init?.body || '{}') as { op?: string; filter?: string };
    const rows =
      body.op !== 'query'
        ? []
        : body.filter === 'Open'
          ? [{ ROWID: '1', Name: 'Ada', Status: 'Open' }]
          : extra
            ? [
                { ROWID: '1', Name: 'Ada', Status: 'Open' },
                { ROWID: '2', Name: 'Bea', Status: 'Closed' },
                { ROWID: '3', Name: 'F13', Status: 'Open' },
              ]
            : [
                { ROWID: '1', Name: 'Ada', Status: 'Open' },
                { ROWID: '2', Name: 'Bea', Status: 'Closed' },
              ];
    const payload = JSON.stringify({ rows });
    return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) as { rows: typeof rows } };
  }) as unknown as typeof fetch;
  runtime.installReportViews(model, win.document);
  await runtime.boot(model, win.document);
  const texts = () =>
    Array.from(win.document.querySelectorAll('section[data-report="All_Items"] [data-rows] tbody tr')).map((row) => row.textContent ?? '');
  await until(() => texts().length === 2);
  assert.deepEqual(texts().sort(), ['AdaOpen', 'BeaClosed']);
  const select = win.document.querySelector('select[data-filter]') as HTMLSelectElement | null;
  assert.ok(select);
  select.value = 'Open';
  select.dispatchEvent(new win.Event('change', { bubbles: true }));
  await until(() => texts().length === 1);
  assert.deepEqual(texts(), ['AdaOpen']);
  extra = true;
  win.location.hash = '#/';
  win.dispatchEvent(new win.Event('hashchange'));
  win.location.hash = '#/report/All_Items';
  win.dispatchEvent(new win.Event('hashchange'));
  await until(() => texts().some((text) => text.includes('F13')));
  assert.deepEqual(texts().sort(), ['AdaOpen', 'BeaClosed', 'F13Open']);
});

// On a phone the report table becomes one card per record and each cell names
// its column through `td::before{content:attr(data-th)}`; the painted table
// must carry that label on every cell, escaped as text.
test('a painted report labels every cell for the phone card layout', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
  assert.match(BASE_CSS, /\[data-report\] td::before\{content:attr\(data-th\)/);
  const runtime = await loadViewsRuntime();
  const model = itemListModel();
  model.reports[0].columns = [
    { field: 'Name', label: 'Item Name' },
    { field: 'Status', label: 'Qty & <Status>' },
  ];
  const dom = new JSDOM('<!doctype html><body><nav id="nav"></nav><main id="main"></main></body>', {
    url: 'http://127.0.0.1/slate/index.html#/report/All_Items',
  });
  const win = dom.window as unknown as { document: Document; fetch: typeof fetch };
  win.fetch = (async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init?.body || '{}') as { op?: string };
    const rows =
      body.op === 'query'
        ? [
            { ROWID: '1', Name: 'Ada', Status: 'Open' },
            { ROWID: '2', Name: 'Bea', Status: 'Closed' },
          ]
        : [];
    const payload = JSON.stringify({ rows });
    return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) as { rows: typeof rows } };
  }) as unknown as typeof fetch;
  runtime.installReportViews(model, win.document);
  await runtime.boot(model, win.document);
  const cells = () => Array.from(win.document.querySelectorAll('section[data-report="All_Items"] tbody td'));
  await until(() => cells().length === 4);
  // Let every scheduled repaint finish before reading the final cells.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    cells().map((td) => [td.getAttribute('data-th'), td.textContent]),
    [
      ['Item Name', 'Ada'],
      ['Qty & <Status>', 'Open'],
      ['Item Name', 'Bea'],
      ['Qty & <Status>', 'Closed'],
    ],
  );
});

// Bare column names in a quickview resolve to the same label the column
// list carries — the show-columns alias, else the field's displayname — never
// the raw link name. Joined `Sub.Field` columns read the subfield's label.
const LABELS_EXCERPT = `
	form Orders
	{
		must have PO_Title
		(
			type = text
			displayname = "PO Title"
		)
		must have Order_Date
		(
			type = date
			displayname = "Order Date"
		)
		Vendor
		(
			type = picklist
			displayname = "Supplier"
			values = Vendor.ID
			displayformat = [Vendor_Name]
		)
		Lines
		(
			type = grid
			displayname = "Lines"
			Material
			(
				type = text
				displayname = "Material Name"
			)
		)
	}
	form Vendor
	{
		Vendor_Name
		(
			type = text
		)
	}
	list All_Orders
	{
		displayName = "All Orders"
		show all rows from Orders
		(
			PO_Title
			Order_Date
			Vendor as "Seller"
			Lines.Material
		)
	}
	web
	{
		reports
		{
			report All_Orders
			{
				quickview
				(
					layout
					(
						datablock1
						(
							fields
							(
								PO_Title
								Order_Date
								Vendor
								Lines.Material
							)
						)
					)
				)
			}
		}
	}
`;

test('quickview column labels fall back to aliases and display names, not link names', () => {
  const model = buildUi(appOf(LABELS_EXCERPT)).model;
  const report = model.reports.find((item) => item.name === 'All_Orders');
  assert.ok(report);
  assert.deepEqual(
    report.columns.map((column) => column.label),
    ['PO Title', 'Order Date', 'Seller', 'Material Name'],
  );
});

// Report chrome (search, toolbar actions, sort/group captions,
// pagination) only appears after a successful non-empty load, and only the
// pieces the export enables. `show action in view header` puts a button in
// the toolbar; `column header` makes it a per-record column.
const CHROME_EXCERPT = `
	form Add_Stock
	{
		Product_Name
		(
			type = text
		)
		Warehouse_Code
		(
			type = text
		)
	}
	list Stock_Details
	{
		displayName = "Stock Details"
		show all rows from Add_Stock
		(
			Product_Name
			custom action "Add Sales"
			(
				workflow = Form_Sales
				show action in view header = true
				column header = "Add Sales"
			)
			custom action "Archive"
			(
				workflow = Archive_BOM
				show action in edit record menu = true
				column header = "Archive"
			)
		)
		group by
		(
			Warehouse_Code ascending
		)
		sort by
		(
			Product_Name ascending
		)
	}
`;

function chromeModel(): UiModel {
  return buildUi(appOf(CHROME_EXCERPT)).model;
}

test('report markup ships chrome hidden and filters toolbar actions by the header flag', async () => {
  const model = chromeModel();
  const report = model.reports.find((item) => item.name === 'Stock_Details');
  assert.ok(report);
  const runtime = await loadViewsRuntime();
  const doc = new JSDOM(`<body>${runtime.renderReport(report)}</body>`).window.document as unknown as {
    querySelector(selector: string): Element | null;
    querySelectorAll(selector: string): Element[];
    body: { textContent: string | null };
  };
  const tools = doc.querySelector('[data-report-tools]') as HTMLElement | null;
  assert.ok(tools);
  assert.equal(tools.hidden, true);
  const headerButtons = Array.from(tools.querySelectorAll('button[data-action]')).map((el) => el.textContent);
  assert.deepEqual(headerButtons, ['Add Sales']);
  const pages = doc.querySelector('[data-pages]') as HTMLElement | null;
  assert.ok(pages);
  assert.equal(pages.hidden, true);
  assert.equal(doc.body.textContent?.includes('Page size'), false);
  assert.ok(
    Array.from(doc.querySelectorAll('th')).some((th) => th.textContent === 'Archive'),
    'column-header action renders as a column',
  );
});

async function bootChrome(rows: Record<string, unknown>[]) {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
  const runtime = await loadViewsRuntime();
  const model = chromeModel();
  const win = new JSDOM(`<!doctype html><body><nav id="nav"></nav><main id="main"></main></body>`, {
    url: 'http://localhost/slate/index.html#/report/Stock_Details',
  }).window as unknown as { document: Document; fetch: typeof fetch };
  win.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { op?: string };
    return { ok: true, status: 200, json: async () => ({ rows: body.op === 'query' ? rows : [] }) };
  }) as unknown as typeof fetch;
  runtime.installReportViews(model, win.document);
  await runtime.boot(model, win.document);
  return { doc: win.document };
}

test('an empty or failed report load shows no chrome', async () => {
  const { doc } = await bootChrome([]);
  await until(() => !!doc.querySelector('[data-state="empty"]'));
  // The report-view enhance pass runs on a timer after the rows land.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const section = doc.querySelector('[data-report]') as HTMLElement;
  assert.equal((section.querySelector('[data-report-tools]') as HTMLElement).hidden, true);
  assert.equal((section.querySelector('[data-pages]') as HTMLElement).hidden, true);
  assert.equal(section.querySelector('select[data-sort]'), null);
  assert.equal(section.querySelector('[data-group-by]'), null);
  assert.equal(section.querySelector('td [data-action]'), null);
});

test('a populated report shows the toolbar, sort and group captions, and an action column', async () => {
  const { doc } = await bootChrome([{ ID: '1', Product_Name: 'P1', Warehouse_Code: 'W1' }]);
  await until(() => !!doc.querySelector('tr[data-row-id]'));
  const section = doc.querySelector('[data-report]') as HTMLElement;
  assert.equal((section.querySelector('[data-report-tools]') as HTMLElement).hidden, false);
  assert.equal((section.querySelector('[data-pages]') as HTMLElement).hidden, false);
  assert.ok(section.querySelector('select[data-sort]'));
  const caption = section.querySelector('[data-group-by]');
  assert.ok(caption);
  assert.match(caption.textContent ?? '', /Grouped by Warehouse_Code/);
  const toolButtons = Array.from(section.querySelectorAll('[data-report-tools] button[data-action]')).map(
    (el) => el.textContent,
  );
  assert.deepEqual(toolButtons, ['Add Sales']);
  // Both `column header` actions render per record; neither is a toolbar button.
  assert.deepEqual(
    Array.from(section.querySelectorAll('td:not([data-card-actions]) button[data-action]')).map((el) => el.textContent),
    ['Add Sales', 'Archive'],
  );
  const footer = section.querySelector('td[data-card-actions]');
  assert.ok(footer, 'the phone card carries an actions footer');
  assert.deepEqual(
    Array.from(footer.querySelectorAll('button, a')).map((el) => el.textContent),
    ['Add Sales', 'Archive', 'Edit', 'Delete'],
  );
  const edit = footer.querySelector('[data-row-edit]');
  assert.equal(edit?.tagName, 'BUTTON');
  const view = section.ownerDocument.defaultView as unknown as {
    MouseEvent: new (type: string, init: { bubbles: boolean }) => Event;
    location: { hash: string };
  };
  edit?.dispatchEvent(new view.MouseEvent('click', { bubbles: true }));
  assert.equal(view.location.hash, '#/form/Add_Stock/edit/1');
});
