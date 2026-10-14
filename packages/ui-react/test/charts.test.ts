import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { compileCriteria } from '../src/charts.js';
import { TEMPLATE_DIR, generateReactApp, reactAppSpec, writeReactApp } from '../src/index.js';
import { chartSeries, matches, metricValue, type Day } from '../template/lib/c2c-ui/charts/data.js';
import type { ChartSpec, MetricSpec, PageElement } from '../template/lib/c2c-ui/types.js';

/** ZML inside a page `Content="..."` literal: attribute quotes are single quotes, criteria quotes are entities. */
const ZML = [
  "<zml><layout><row>",
  "<column width='50%'><panel elementName='Panel'><pr><pc>",
  "<image type='icon' value='business-money-coins' width='52px'/>",
  "<text type='Form Data' value='thisapp.Add_Order.Amount.sum' criteria='Status != &quot;Cancelled&quot; &amp;&amp; Order_Date is today'></text>",
  "<text type='Text' value='Today&apos;s Sales'></text>",
  "</pc></pr></panel></column>",
  "<column width='50%'><chart elementName='Chart' title='Orders By Status' type='Pie' formLinkName='Add_Order' xfield='Status' yfields='count:Order_No' DelugeCriteria='Owner == zoho.loginuserid'/></column>",
  "</row><row><column width='100%'><panel elementName='Panel 2'><pr><pc>",
  "<text type='Text' value='Open orders'></text><text type='Form Data' value='thisapp.Add_Order.Order_No.count' criteria='Status == &quot;Open&quot;'></text>",
  "<text type='Text' value='-'></text>",
  "<text type='Text' value='All orders'></text><text type='Form Data' value='thisapp.Add_Order.Order_No.count'></text>",
  "</pc></pr></panel>",
  "<report elementName='Report' linkName='Orders_Chart'/>",
  "<report elementName='Report 1' title='Latest orders' linkName='All_Orders'/>",
  "<button action='OpenForm' componentLinkName='Add_Order' text='Add Order'/>",
  "<dspZml elementName='ZML Snippet'><![CDATA[htmlpage x()\ncontent\n<%{ }%>]]></dspZml>",
  "</column></row></layout></zml>",
].join('');

function source(): string {
  return `application "Shop"
{
\tform Add_Order
\t{
\t\tdisplayname = "Add Order"
\t\tOrder_No
\t\t(
\t\t\ttype = autonumber
\t\t)
\t\tStatus
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = {"Open","Cancelled"}
\t\t)
\t\tAmount
\t\t(
\t\t\ttype = number
\t\t)
\t\tOrder_Date
\t\t(
\t\t\ttype = date
\t\t)
\t}
\tlist All_Orders
\t{
\t\tdisplayname = "All Orders"
\t\tshow all rows from Add_Order
\t\t(
\t\t\tOrder_No
\t\t\tStatus
\t\t\tAmount
\t\t\tOrder_Date
\t\t)
\t}
\tpivotchart Orders_Chart
\t{
\t\tdisplayname = "Amount By Status"
\t\tbased on Autoview_1_Add_Order
\t\tshow all rows from Add_Order
\t\t(
\t\t\tOrder_No
\t\t\tStatus
\t\t\tAmount
\t\t)
\t}
\tpages
\t{
\t\tpage Dashboard
\t\t{
\t\t\tdisplayname = "Dashboard"
\t\t\tContent="${ZML.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
\t\t}
\t}
}
`;
}

function appOf(): App {
  return deriveIr(parse(source()));
}

function leaves(elements: PageElement[]): PageElement[] {
  return elements.flatMap((el) => (el.kind === 'box' ? leaves(el.children) : [el]));
}

const TODAY: Day = { y: 2026, m: 10, d: 10 };

test('Creator criteria translate to browser filters; what does not translate is a listed TODO', () => {
  assert.deepEqual(compileCriteria('Status != &quot;Cancelled&quot; &amp;&amp; Order_Date is today'), {
    filter: [
      { field: 'Status', op: 'ne', value: 'Cancelled' },
      { field: 'Order_Date', op: 'period', when: 'this', unit: 'day' },
    ],
    todos: [],
  });
  assert.deepEqual(compileCriteria('Status == "A" || Status == "B"').filter, [
    { op: 'any', of: [{ field: 'Status', op: 'eq', value: 'A' }, { field: 'Status', op: 'eq', value: 'B' }] },
  ]);
  assert.deepEqual(compileCriteria('Added_Time in last 7 days && In_Stock <= Reorder_Level').filter, [
    { field: 'Added_Time', op: 'period', when: 'last', unit: 'day', count: 7 },
    { field: 'In_Stock', op: 'le', ref: 'Reorder_Level' },
  ]);
  assert.deepEqual(compileCriteria('Due_Date < zoho.currentdate').filter, [{ field: 'Due_Date', op: 'lt', today: true }]);
  // The signed-in user and form inputs are not known to the browser: the clause is a TODO, the rest applies.
  assert.deepEqual(compileCriteria('Status == "Open" && Owner == zoho.loginuserid'), {
    filter: [{ field: 'Status', op: 'eq', value: 'Open' }],
    todos: ['filter not applied: Owner == zoho.loginuserid'],
  });
  // A disjunction with an untranslatable branch is not applied at all.
  assert.deepEqual(compileCriteria('A == "x" || B == input.y'), { filter: [], todos: ['filter not applied: A == "x" || B == input.y'] });
});

test('metrics and chart series fold the filtered rows', () => {
  const rows = [
    { Status: 'Open', Amount: '120.50', Order_Date: '2026-10-10' },
    { Status: 'Cancelled', Amount: 99, Order_Date: '10-Oct-2026' },
    { Status: 'Open', Amount: '1,000', Order_Date: '2026-10-09 08:00:00' },
    { Status: '', Amount: 'n/a', Order_Date: '' },
  ];
  const sum: MetricSpec = { report: 'All_Orders', fn: 'sum', field: 'Amount', filter: compileCriteria('Status != "Cancelled" && Order_Date is today').filter, todos: [] };
  assert.equal(metricValue(rows, sum, TODAY), 120.5);
  assert.equal(metricValue(rows, { ...sum, fn: 'count', field: 'ID', filter: [] }, TODAY), 4);
  assert.equal(matches(rows[2]!, { field: 'Order_Date', op: 'period', when: 'this', unit: 'week' }, TODAY), true);
  assert.equal(matches(rows[2]!, { field: 'Order_Date', op: 'period', when: 'last', unit: 'month' }, TODAY), false);
  assert.equal(matches(rows[2]!, { field: 'Order_Date', op: 'lt', today: true }, TODAY), true);
  assert.equal(matches(rows[0]!, { field: 'Order_Date', op: 'lt', today: true }, TODAY), false);

  const chart: ChartSpec = { kind: 'donut', title: 'T', x: 'Status', xLabel: 'Status', measures: [{ fn: 'sum', field: 'Amount', label: 'Sum' }, { fn: 'count', field: 'Status', label: 'Count' }], filter: [], notes: [], todos: [] };
  const series = chartSeries(rows, chart, TODAY);
  assert.deepEqual(series.categories.map((c) => c.key), ['Open', 'Cancelled', '(blank)']);
  assert.deepEqual(series.values, [[1120.5, 99, 0], [2, 1, 0]]);
  // Dates group by calendar day and draw in date order.
  const byDay = chartSeries(rows.slice(0, 3), { ...chart, kind: 'auto', x: 'Order_Date', measures: [{ fn: 'count', field: '', label: 'Records' }] }, TODAY);
  assert.equal(byDay.dated, true);
  assert.deepEqual(byDay.categories.map((c) => c.key), ['2026-10-09', '2026-10-10']);
  assert.deepEqual(byDay.values, [[1, 2]]);
});

test('a Creator page becomes a page spec: metric panels, charts, embeds, buttons, and every TODO listed', () => {
  const spec = reactAppSpec(appOf());
  const page = spec.pages?.Dashboard;
  assert.ok(page, 'the page is in the spec');
  const all = leaves(page.elements);
  const metric = all.find((el) => el.kind === 'metric');
  assert.ok(metric && metric.kind === 'metric');
  assert.equal(metric.label, "Today's Sales");
  assert.equal(metric.icon, 'business-money-coins');
  assert.equal(metric.value.report, 'All_Orders');
  assert.deepEqual(metric.value.filter.map((c) => ('field' in c ? c.field : c.op)), ['Status', 'Order_Date']);

  // A panel of several caption/value pairs: one card per value, each labelled by its own caption.
  const pairs = all.filter((el): el is Extract<PageElement, { kind: 'metric' }> => el.kind === 'metric' && el.value.fn === 'count');
  assert.deepEqual(pairs.map((m) => [m.label, m.value.filter.length]), [['Open orders', 1], ['All orders', 0]]);
  assert.deepEqual(
    all.filter((el) => el.kind === 'text').map((el) => (el.kind === 'text' ? el.text : '')),
    ['-'],
    'every caption labels a value; the separator stays as text',
  );

  const charts = all.filter((el): el is Extract<PageElement, { kind: 'chart' }> => el.kind === 'chart');
  assert.deepEqual(charts.map((c) => [c.chart.title, c.chart.kind, c.chart.report]), [
    ['Orders By Status', 'donut', 'All_Orders'],
    ['Amount By Status', 'auto', 'Orders_Chart'],
  ]);
  assert.deepEqual(charts[0]!.chart.measures, [{ fn: 'count', field: 'Order_No', label: 'Count of Order No' }]);
  // The pivotchart keeps no settings in the export: Status (named in the title) by the summed Amount, and it says so.
  assert.equal(charts[1]!.chart.x, 'Status');
  assert.deepEqual(charts[1]!.chart.measures, [{ fn: 'sum', field: 'Amount', label: 'Sum of Amount' }]);
  assert.match(charts[1]!.chart.notes[0]!, /keeps no chart settings: drawn as the sum of Amount by Status/);
  assert.equal(spec.reports.Orders_Chart?.chart?.x, 'Status');

  assert.ok(all.some((el) => el.kind === 'report' && el.report === 'All_Orders' && el.label === 'Latest orders'));
  assert.ok(all.some((el) => el.kind === 'button' && el.href === '#/form/Add_Order' && el.label === 'Add Order'));
  assert.deepEqual(page.todos, [
    'chart "Orders By Status": filter not applied: Owner == zoho.loginuserid',
    '<dspZml>: the HTML snippet is built by a server-side script; it is not generated yet',
  ]);
});

test('generated page and chart report modules render the page and the chart, not a placeholder', () => {
  const files = generateReactApp(appOf());
  const text = (path: string) => String(files.find((f) => f.path === path)?.data ?? '');
  const page = text('src/generated/pages/Dashboard.tsx');
  assert.match(page, /<PageView page=\{page\} \/>/);
  assert.doesNotMatch(page, /not generated yet/);
  const chart = text('src/generated/reports/Orders_Chart.tsx');
  assert.match(chart, /<ChartReport report=\{report\} \/>/);
  assert.doesNotMatch(chart, /className="todo"/);
  for (const name of ['metric-card', 'animated-counter', 'bar-chart', 'line-chart', 'donut-chart']) {
    assert.ok(existsSync(join(TEMPLATE_DIR, `lib/c2c-ui/arc/components/${name}/${name}.tsx`)), name);
    assert.match(readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/ARC-UPSTREAM.md'), 'utf8'), new RegExp(`\`${name}\``), `${name} listed in ARC-UPSTREAM.md`);
  }
});

const modules = join(TEMPLATE_DIR, 'node_modules');
const haveBuild = existsSync(join(modules, '.bin', 'vite'));

test('the built app draws the dashboard from the report rows', { skip: haveBuild ? false : 'template dependencies are not installed (npm ci --prefix packages/ui-react/template)' }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-r5-'));
  try {
    writeReactApp(out, generateReactApp(appOf(), { auth: false }));
    symlinkSync(modules, join(out, 'node_modules'), 'dir');
    const build = spawnSync(join(modules, '.bin', 'vite'), ['build', '--logLevel', 'error'], { cwd: out, encoding: 'utf8' });
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
    const require = createRequire(import.meta.url);
    const { JSDOM } = require('jsdom') as { JSDOM: new (html: string, opts: object) => { window: Window & typeof globalThis } };
    const html = readFileSync(join(out, 'dist/index.html'), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
    const dom = new JSDOM(html, { url: 'https://app.example/#/page/Dashboard', pretendToBeVisual: true });
    const day = (offset: number) => {
      const d = new Date(Date.now() + offset * 86400000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const rows = [
      { ROWID: '1', Order_No: '1', Status: 'Open', Amount: '120.50', Order_Date: day(0) },
      { ROWID: '2', Order_No: '2', Status: 'Cancelled', Amount: '99', Order_Date: day(0) },
      { ROWID: '3', Order_No: '3', Status: 'Open', Amount: '10', Order_Date: day(-40) },
    ];
    const calls: string[] = [];
    (dom.window as unknown as { fetch: unknown }).fetch = async (url: string, init: { body: string }) => {
      calls.push(`${url} ${JSON.parse(init.body).page}`);
      return new Response(JSON.stringify({ rows }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const runtime = readdirSync(join(out, 'dist/assets')).find((name) => name.startsWith('runtime.'))!;
    const mod = (await import(pathToFileURL(join(out, 'dist/assets', runtime)).href)) as { boot: (spec: undefined, doc: Document) => void };
    mod.boot(undefined, dom.window.document);
    const doc = dom.window.document;
    for (let i = 0; i < 100 && doc.querySelectorAll('[data-state="loading"]').length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const page = doc.querySelector('[data-page="Dashboard"]');
    assert.ok(page, 'the page renders');
    assert.equal(page.querySelector('h1')?.textContent, 'Dashboard');
    assert.equal(doc.querySelectorAll('[data-state="loading"]').length, 0);
    assert.equal(doc.querySelectorAll('[data-state="error"]').length, 0);
    // Today's open orders only: 120.50, not the cancelled one or last month's.
    assert.equal(page.querySelector('[data-metric="sum"]')?.getAttribute('data-value'), '120.5');
    assert.match(page.querySelector('[data-metric="sum"]')?.textContent ?? '', /Today's Sales/);
    assert.equal(page.querySelectorAll('.c2c-chart figure').length, 2, 'the donut and the chart report draw');
    assert.equal(page.querySelector('[data-page] details.todo')?.getAttribute('data-todo-count'), '2');
    assert.ok(page.querySelector('[data-embed="report"] [data-report="All_Orders"]'), 'the report embed shows the records');
    assert.equal(page.querySelector('a.c2c-page-button')?.getAttribute('href'), '#/form/Add_Order');
    // The metric and the donut share one read of All_Orders; the embedded list reads its own page.
    assert.equal(calls.filter((call) => call === '/reports/All_Orders 0').length, 2);
    assert.equal(calls.filter((call) => call === '/reports/Orders_Chart 0').length, 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// --- Review nits: one-caption extras, reportless metrics, panel order, popups ---

const NIT_ZML = [
  "<zml><layout><row><column width='100%'><panel elementName='PanelA'><pr><pc>",
  "<text type='Text' value='Sales'></text>",
  "<text type='Form Data' value='thisapp.Sales.Amount.sum'></text>",
  "<text type='Form Data' value='thisapp.Sales.Amount.count'></text>",
  "</pc></pr></panel>",
  "<panel elementName='PanelB'><pr><pc>",
  "<text type='Text' value='Lonely metric'></text>",
  "<text type='Form Data' value='thisapp.Lonely.Amount.sum'></text>",
  "</pc></pr></panel>",
  "<panel elementName='PanelC'><pr><pc>",
  "<text type='Text' value='Open sales'></text>",
  "<text type='Form Data' value='thisapp.Sales.Amount.sum' criteria='Amount &gt; 10'></text>",
  "<text type='Text' value='-'></text>",
  "<text type='Text' value='All sales'></text>",
  "<text type='Form Data' value='thisapp.Sales.Amount.count'></text>",
  "<text type='Text' value='Trailing note'></text>",
  "</pc></pr></panel>",
  "<dsp elementName='Snippet'><![CDATA[firm = Add_Firm[ID != 0]; if(firm.count() == 0) { openUrl(&quot;#Form:Add_Firm&quot;,&quot;popup window&quot;); } openUrl(&quot;#Report:Sales_List&quot;,&quot;popup window&quot;);]]></dsp>",
  "</column></row></layout></zml>",
].join('');

function nitApp(): App {
  return deriveIr(parse(`application "Shop"
{
\tform Sales
\t{
\t\tdisplayname = "Sales"
\t\tAmount
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tform Lonely
\t{
\t\tdisplayname = "Lonely"
\t\tAmount
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tlist Sales_List
\t{
\t\tdisplayname = "Sales List"
\t\tshow all rows from Sales
\t\t(
\t\t\tAmount
\t\t)
\t}
\tpages
\t{
\t\tpage Dashboard
\t\t{
\t\t\tdisplayname = "Dashboard"
\t\t\tContent="${NIT_ZML.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
\t\t}
\t}
}
`));
}

function panelsOf(page: { elements: PageElement[] }): Extract<PageElement, { kind: 'box' }>[] {
  const out: Extract<PageElement, { kind: 'box' }>[] = [];
  const walk = (el: PageElement) => {
    if (el.kind !== 'box') return;
    if (el.tag === 'panel') out.push(el);
    el.children.forEach(walk);
  };
  page.elements.forEach(walk);
  return out;
}

test('a metric with no report to read is a visible TODO, never a 0', () => {
  const page = reactAppSpec(nitApp()).pages?.Dashboard;
  assert.ok(page, 'the page is in the spec');
  const all = leaves(page.elements);
  assert.ok(!all.some((el) => el.kind === 'metric' && !el.value.report), 'no metric card reads from nothing');
  assert.ok(
    all.some((el) => el.kind === 'todo' && /no report to read/.test(el.reason)),
    'the reportless metric is a visible TODO where it stood',
  );
  assert.ok(page.todos.some((todo) => /no report to read/.test(todo)), 'the missing source is listed with the page TODOs');
});

test('metricPanel keeps Creator order: unclaimed captions stay in place, separators kept', () => {
  const page = reactAppSpec(nitApp()).pages?.Dashboard;
  assert.ok(page, 'the page is in the spec');
  const panel = panelsOf(page).find((box) => JSON.stringify(box).includes('Trailing note'));
  assert.ok(panel, 'the pairs panel is in the spec');
  const shape = panel.children.map((el) => (el.kind === 'box' ? 'box' : el.kind === 'text' ? `text:${el.text}` : el.kind));
  assert.deepEqual(shape, ['box', 'text:-', 'text:Trailing note'], 'the grid sits where the first value stood; the rest stays in place');
  const grid = panel.children[0]!;
  assert.ok(grid.kind === 'box' && grid.tag === 'metrics');
  assert.deepEqual(
    grid.children.map((el) => (el.kind === 'metric' ? el.label : el.kind)),
    ['Open sales', 'All sales'],
    'each card keeps the caption beside its own value',
  );
});

test('a snippet popup keeps its trigger words: a link plus a TODO, never a silent link', () => {
  const page = reactAppSpec(nitApp()).pages?.Dashboard;
  assert.ok(page, 'the page is in the spec');
  const all = leaves(page.elements);
  const snippet = all.find((el): el is Extract<PageElement, { kind: 'html' }> => el.kind === 'html');
  assert.ok(snippet, 'the snippet is in the spec');
  assert.deepEqual(snippet.links.map((link) => link.label), ['Open Add Firm', 'Open Sales List']);
  const reasons = all.filter((el) => el.kind === 'todo').map((el) => (el.kind === 'todo' ? el.reason : ''));
  assert.ok(reasons.some((reason) => /Add Firm.*opened on its own.*no records/.test(reason)), 'the guarded popup names its empty-form trigger');
  assert.ok(reasons.some((reason) => /Sales List.*opened on its own/.test(reason)), 'the unguarded popup names its lost auto-open');
  assert.ok(page.todos.some((todo) => /opened on its own/.test(todo)), 'the lost triggers are listed with the page TODOs');
});

test('further values of a one-caption panel carry their own labels', () => {
  const page = reactAppSpec(nitApp()).pages?.Dashboard;
  assert.ok(page, 'the page is in the spec');
  const panel = panelsOf(page).find((box) => box.children.some((el) => el.kind === 'metric' && el.label === 'Sales'));
  assert.ok(panel, 'the one-caption panel is in the spec');
  const metric = panel.children.find((el) => el.kind === 'metric');
  assert.ok(metric && metric.kind === 'metric');
  assert.equal(metric.extra.length, 1);
  const second = metric.extra[0] as MetricSpec & { label?: string };
  assert.equal(second.label, 'Count of records', 'the second value explains itself');
});
