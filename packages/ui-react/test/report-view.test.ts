/**
 * Behaviour tests for the generated report view. The template's ReportView is
 * transpiled into a temporary directory and rendered in jsdom against a fake
 * endpoint that answers `op: "query"` the way the report endpoint does: it
 * applies the posted sort itself, with the same cell order the endpoint's
 * ORDER BY produces (compareDecimalCells for number-family columns,
 * compareCells for the rest).
 *
 * The render tests need the template's runtime dependencies
 * (`npm ci --prefix packages/ui-react/template`); without them they skip
 * locally and fail under CI, where the install step is part of the run.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { compareCells, compareDecimalCells } from '../../shims/src/criteria.js';
import { TEMPLATE_DIR, compileTemplateLib, hiddenParts, reactAppSpec } from '../src/index.js';
import type { AppSpec, FormSpec, ReportSpec } from '../template/lib/c2c-ui/types.js';
import { cleanStyle } from '../../ui/src/pages.js';

function source(): string {
  return `application "Shop"
{
	form Order
	{
		displayname = "Order"
		Title
		(
			type = text
			displayname = "Title"
		)
		Total
		(
			type = decimal
			displayname = "Total"
		)
	}
	list Orders
	{
		displayname = "Orders"
		show all rows from Order
		(
			Title
			Total
			custom action "Approve"
			(
				column header = "Approve"
			)
		)
		filters
		(
			"Open only" : Status == "Open"
			Status
		)
		sort by
		(
			Total descending
		)
	}
	map Feed
	{
		displayname = "Feed"
		show all rows from Order
		(
			Title
			Total
		)
	}
}
`;
}

function appOf(text = source()): App {
  return deriveIr(parse(text));
}

test('the report spec carries the column number flag, the action column and a todo reason', () => {
  const spec = reactAppSpec(appOf());
  const report = spec.reports.Orders!;
  const total = report.columns.find((c) => c.field === 'Total')!;
  assert.equal(total.numeric, true, 'a decimal column is marked numeric');
  assert.equal(report.columns.find((c) => c.field === 'Title')!.numeric, undefined);
  const approve = report.columns.find((c) => c.field === 'Approve')!;
  assert.equal(approve.action, '/reports/Orders/actions/approve');
  assert.equal(approve.numeric, undefined, 'an action column is never numeric');
  const feed = spec.reports.Feed!;
  assert.equal(feed.view, 'list');
  assert.match(feed.note ?? '', /Shown as a list/);
  assert.doesNotMatch(feed.note ?? '', /is not generated/, 'the note beside a drawn list does not claim the report is not generated');
});

test('the client cell order matches the endpoint ORDER BY on the same fixture', async (t) => {
  // compareReportCells ships inside the template; compile it alone (it has no
  // imports) and check it against the comparators the endpoint applies, on
  // the same cells, in both directions, a page at a time.
  const out = mkdtempSync(join(tmpdir(), 'c2c-report-order-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const file = join(TEMPLATE_DIR, 'lib', 'c2c-ui', 'order.ts');
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  writeFileSync(join(out, 'order.js'), outputText);
  const { compareReportCells } = (await import(pathToFileURL(join(out, 'order.js')).href)) as {
    compareReportCells: (left: unknown, right: unknown, numeric: boolean) => number;
  };

  const cells: unknown[] = ['5', null, '', '2', 'abc', '10', '-1', 'N/A', '2.50', '0', undefined, ' '];
  for (const numeric of [true, false]) {
    const endpoint = numeric ? compareDecimalCells : compareCells;
    for (const [name, sign] of [['ascending', 1], ['descending', -1]] as const) {
      const want = [...cells].sort((a, b) => endpoint(a, b) * sign);
      const got = [...cells].sort((a, b) => compareReportCells(a, b, numeric) * sign);
      assert.deepEqual(got, want, `${name} ${numeric ? 'numeric' : 'text'} order matches the endpoint`);
    }
  }
  // A page the endpoint ordered must draw in the same sequence: re-sorting
  // each page slice with the client rule changes nothing, so a blank cannot
  // surface mid-sequence when the next page continues it.
  for (const [name, sign] of [['ascending', 1], ['descending', -1]] as const) {
    const ordered = [...cells].sort((a, b) => compareDecimalCells(a, b) * sign);
    for (let offset = 0; offset < ordered.length; offset += 4) {
      const page = ordered.slice(offset, offset + 4);
      assert.deepEqual([...page].sort((a, b) => compareReportCells(a, b, true) * sign), page, `${name} page ${offset / 4 + 1} keeps the endpoint order`);
    }
  }
});

// The render tests compile the template library and mount ReportView in jsdom.
const MODULES = join(TEMPLATE_DIR, 'node_modules');
const runtimeReady = existsSync(join(MODULES, 'react')) && existsSync(join(MODULES, 'react-dom'));
const MISSING = 'template runtime dependencies are not installed: run `npm ci --prefix packages/ui-react/template`';
// Missing template dependencies skip the render tests locally; under CI the
// install step is part of the run, so a missing runtime fails instead.
const SKIP = runtimeReady ? false : process.env.CI === 'true' ? false : MISSING;

function compileLib(out: string): void {
  assert.ok(runtimeReady, MISSING);
  compileTemplateLib(out);
}

type Row = Record<string, unknown>;

interface Mounted {
  container: HTMLElement;
  /** The jsdom window the screen renders in (its confirm is the delete dialog). */
  win: Record<string, unknown>;
  calls: Record<string, unknown>[];
  posted: { endpoint: string; body: Record<string, unknown> }[];
  /** Display text of one column's cells, top to bottom. */
  textOf(key: string): string[];
  /** aria-sort of one column header. */
  ariaSort(key: string): string | null;
  /** The sort button inside one column header, if it offers one. */
  headerButton(key: string): Element | null;
  /** Dispatch a click and flush the effects and the fake endpoint round-trip. */
  click(el: Element | null): Promise<void>;
  byRole(role: 'link' | 'button', name: string): Element | null;
}

/** Mount <ReportView> against a fake endpoint that applies the posted sort like the report endpoint. */
async function mount(out: string, report: ReportSpec, rows: Row[], numericKeys: ReadonlySet<string>, forms: Record<string, FormSpec> = {}, rowId?: string, recordReply?: () => Promise<{ ok: boolean; status: number; body?: unknown }>, appSettings: Partial<AppSpec> = {}): Promise<Mounted> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const view = dom.window as unknown as Record<string, unknown> & Window;
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'DocumentFragment', 'SVGElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTableElement', 'getComputedStyle', 'CSS', 'self'];
  for (const key of globals) {
    try {
      (globalThis as Record<string, unknown>)[key] = view[key as keyof typeof view];
    } catch {
      Object.defineProperty(globalThis, key, { value: view[key as keyof typeof view], configurable: true });
    }
  }
  const w = view as unknown as Record<string, unknown>;
  if (typeof w.matchMedia !== 'function') {
    w.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  }
  if (typeof w.CSS !== 'object' || w.CSS === null) {
    w.CSS = { escape: (text: string) => text.replace(/["\\]/g, '\\$&') };
    (globalThis as Record<string, unknown>).CSS = w.CSS;
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  const require = createRequire(join(out, 'lib', 'loader.cjs'));
  const React = require('react') as { createElement: (type: unknown, props: unknown, child?: unknown) => unknown; act?: (fn: () => Promise<unknown>) => Promise<void> };
  const { createRoot } = require('react-dom/client') as { createRoot: (el: Element) => { render(node: unknown): void; unmount(): void } };
  const act: (fn: () => Promise<unknown>) => Promise<void> = React.act ?? (async (fn) => void (await fn()));

  const { ReportView } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/report/ReportView.js')).href)) as { ReportView: (props: { report: ReportSpec }) => unknown };
  const { EnvContext } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/runtime/env.js')).href)) as { EnvContext: { Provider: unknown } };
  // Like the app shell: the screen renders inside a ScreenBoundary so a 403
  // throw from useAccessDenied lands on DeniedScreen instead of unmounting.
  const { ScreenBoundary } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/shell/ScreenBoundary.js')).href)) as { ScreenBoundary: (props: unknown) => unknown };

  // The fake endpoint applies the posted sort like the report endpoint: the
  // decimal-shadow order for number-family columns, varchar order otherwise,
  // ROWID breaking ties, then LIMIT/OFFSET for the posted page.
  const idOrder = (a: Row, b: Row): number => {
    const left = String(a.ROWID ?? '');
    const right = String(b.ROWID ?? '');
    if (/^\d+$/.test(left) && /^\d+$/.test(right) && left.length !== right.length) return left.length - right.length;
    return left < right ? -1 : left > right ? 1 : 0;
  };
  const order = (list: Row[], sort: { field: string; order?: string }[]): Row[] => {
    const spec = sort[0];
    if (!spec) return list;
    const sign = /desc/i.test(spec.order ?? '') ? -1 : 1;
    const cell = numericKeys.has(spec.field) ? compareDecimalCells : compareCells;
    return [...list].sort((a, b) => cell(a[spec.field], b[spec.field]) * sign || idOrder(a, b));
  };
  const calls: Record<string, unknown>[] = [];
  const posted: { endpoint: string; body: Record<string, unknown> }[] = [];
  const api = {
    post: async (endpoint: string, body: Record<string, unknown>) => {
      calls.push(body);
      posted.push({ endpoint, body });
      if (endpoint.endsWith('/record')) return recordReply ? recordReply() : { ok: true, status: 200, body: { record: { ROWID: String(body.ROWID), Memo: 'Read me', Lines: [{ ROWID: '2', Material: 'Bolt', Quantity: 3 }] } } };
      if (endpoint.includes('/actions/')) return { ok: true, status: 200, body: { dryRun: true } };
      const ordered = order(rows, (body.sort ?? []) as { field: string; order?: string }[]);
      const page = typeof body.page === 'number' ? body.page : 0;
      const pageSize = typeof body.pageSize === 'number' && body.pageSize > 0 ? body.pageSize : ordered.length || 1;
      return { ok: true, status: 200, body: { rows: ordered.slice(page * pageSize, page * pageSize + pageSize) } };
    },
  };

  const container = view.document.getElementById('root') as HTMLElement;
  const root = createRoot(container);
  const spec = { name: 'Shop', spec: 1 as const, theme: { accent: '#000000', accentInk: '#ffffff', menu: 'list' as const }, nav: [], forms, reports: { [report.name]: report }, ...appSettings };
  const env = { view, doc: view.document, spec, api };
  const flush = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  await act(async () => {
    root.render(
      React.createElement(
        EnvContext.Provider,
        { value: env },
        React.createElement(ScreenBoundary, { screen: report.name, route: 'report' }, React.createElement(ReportView, { report, ...(rowId ? { row: rowId } : {}) })),
      ),
    );
  });
  await flush();

  return {
    container,
    win: view as unknown as Record<string, unknown>,
    calls,
    posted,
    textOf: (key) => [...container.querySelectorAll(`tbody td[data-th="${key}"]`)].map((cell) => (cell.textContent ?? '').trim()),
    ariaSort: (key) => container.querySelector(`th[data-key="${key}"]`)?.getAttribute('aria-sort') ?? null,
    headerButton: (key) => container.querySelector(`th[data-key="${key}"] button`),
    click: async (el) => {
      await act(async () => {
        const Mouse = (view as Record<string, unknown>).MouseEvent as new (type: string, init: { bubbles: boolean }) => Event;
        el?.dispatchEvent(new Mouse('click', { bubbles: true }));
      });
      await flush();
    },
    byRole: (role, name) => {
      const selector = role === 'link' ? 'a[href], [role="link"]' : role === 'button' ? 'button, [role="button"]' : role;
      return (
        [...container.querySelectorAll(selector)].find((el) => {
          const ariaLabel = el.getAttribute('aria-label');
          const accessibleName = ariaLabel !== null && ariaLabel !== '' ? ariaLabel : (el.textContent ?? '').trim();
          if (name === undefined) return true;
          if (typeof name === 'string') {
            return accessibleName === name || ariaLabel === name || (el.textContent ?? '').trim() === name;
          }
          return (name as RegExp).test(accessibleName);
        }) ?? null
      );
    },
  };
}

const ROWS: Row[] = [
  { ROWID: '1', Title: 'Bravo', Total: '10.5' },
  { ROWID: '2', Title: 'Alpha', Total: '10.25' },
  { ROWID: '3', Title: 'Delta', Total: '-3' },
  { ROWID: '4', Title: 'Charlie', Total: '2' },
];

async function compileOnly(t: { after(fn: () => void): void }, tag: string): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), `c2c-report-render-${tag}-`));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  compileLib(out);
  return out;
}

test('a header sort survives the query reload', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'sort');
  const spec = reactAppSpec(appOf());
  const view = await mount(out, spec.reports.Orders!, ROWS, new Set(['Total']));
  // The Creator sort is Total descending: the endpoint returns 10.5, 10.25, 2, -3.
  assert.deepEqual(view.textOf('Total'), ['10.5', '10.25', '2', '-3']);
  assert.equal(view.ariaSort('Total'), 'descending');
  await view.click(view.headerButton('Title'));
  // The endpoint got the header sort and returned Title order.
  assert.deepEqual(view.calls.at(-1)?.sort, [{ field: 'Title', order: 'ascending' }]);
  // After the reload remount the chosen sort still drives the header and the rows.
  assert.equal(view.ariaSort('Title'), 'ascending', 'the clicked sort stays active after the reload');
  assert.equal(view.ariaSort('Total'), 'none');
  assert.deepEqual(view.textOf('Title'), ['Alpha', 'Bravo', 'Charlie', 'Delta']);
});

test('a numeric column keeps the exact decimal order of the server', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'num');
  const spec = reactAppSpec(appOf());
  const view = await mount(out, spec.reports.Orders!, ROWS, new Set(['Total']));
  assert.deepEqual(view.textOf('Total'), ['10.5', '10.25', '2', '-3'], 'the page keeps the server numeric order');
  await view.click(view.headerButton('Total'));
  assert.deepEqual(view.calls.at(-1)?.sort, [{ field: 'Total', order: 'ascending' }]);
  assert.deepEqual(view.textOf('Total'), ['-3', '2', '10.25', '10.5'], 'ascending is exact, not text');
});

const MULTI_SOURCE = `application "Library"
{
form Book
{
Title
(
type = text
)
Mark_as_Featured
(
type = checkboxes
values = {"Yes", "No"}
)
Genres
(
type = multiselect
values = {"Fiction", "History"}
)
}
list Book_Report
{
show all rows from Book
(
Title
Mark_as_Featured
Genres
)
}
}`;

test('a multi-value column shows its choices, whichever stored shape the row holds', { skip: SKIP }, async (t) => {
  const report = reactAppSpec(appOf(MULTI_SOURCE)).reports.Book_Report!;
  assert.deepEqual(report.columns.map((c) => [c.field, c.multiValue === true]), [['Title', false], ['Mark_as_Featured', true], ['Genres', true]]);
  const out = await compileOnly(t, 'multi');
  const view = await mount(out, report, [
    { ROWID: '1', Title: 'Dune', Mark_as_Featured: '["No"]', Genres: '["Fiction","History"]' },
    { ROWID: '2', Title: 'Emma', Mark_as_Featured: '[No]', Genres: '{"History"}' },
  ], new Set());
  assert.deepEqual(view.textOf('Mark_as_Featured'), ['No', 'No']);
  assert.deepEqual(view.textOf('Genres'), ['Fiction, History', 'History']);
});

test('a blank cell keeps the endpoint place in the order across pages', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'blank');
  const spec = reactAppSpec(appOf());
  const rows: Row[] = [
    { ROWID: '1', Title: 'One', Total: '5' },
    { ROWID: '2', Title: 'Two', Total: '' },
    { ROWID: '3', Title: 'Three', Total: '2' },
    { ROWID: '4', Title: 'Four', Total: null },
    { ROWID: '5', Title: 'Five', Total: '9' },
  ];
  const view = await mount(out, { ...spec.reports.Orders!, pageSize: 4 }, rows, new Set(['Total']));
  // The Creator sort is Total descending: the endpoint pages 9,5,2,blank then blank.
  assert.deepEqual(view.textOf('Total'), ['9', '5', '2', '–']);
  await view.click(view.headerButton('Total'));
  // Ascending the endpoint puts the blank shadow first: page 1 is blank,blank,2,5.
  assert.deepEqual(view.calls.at(-1)?.sort, [{ field: 'Total', order: 'ascending' }]);
  assert.deepEqual(view.textOf('Total'), ['–', '–', '2', '5'], 'blanks stay first on an ascending page, not pushed to the bottom');
  await view.click(view.container.querySelector('button[aria-label="Next page"]'));
  assert.deepEqual(view.textOf('Total'), ['9'], 'page 2 continues the endpoint order without a blank surfacing mid-sequence');
  await view.click(view.headerButton('Total'));
  // Descending the endpoint puts the blanks last: 9,5,2,blank then blank.
  assert.deepEqual(view.calls.at(-1)?.sort, [{ field: 'Total', order: 'descending' }]);
  assert.deepEqual(view.textOf('Total'), ['9', '5', '2', '–']);
  await view.click(view.container.querySelector('button[aria-label="Next page"]'));
  assert.deepEqual(view.textOf('Total'), ['–'], 'the last page holds the descending blanks');
});

test('an action column header offers no sort and posts no ORDER BY', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'act');
  const spec = reactAppSpec(appOf());
  const view = await mount(out, spec.reports.Orders!, ROWS, new Set(['Total']));
  assert.equal(view.headerButton('Approve'), null, 'the action column header is not a sort button');
  assert.equal(view.ariaSort('Approve'), null);
  await view.click(view.container.querySelector('th[data-key="Approve"]'));
  assert.equal(view.calls.length, 1, 'clicking the action header sends no new query');
  assert.equal((view.calls[0]!.sort as { field: string }[]).at(-1)!.field, 'Total');
  const actionBtn = view.byRole('button', 'Approve');
  assert.ok(actionBtn, 'the column action button is accessible by role and visible text');

  const customActionSpec = {
    ...spec.reports.Orders!,
    customActions: [{ name: 'Sign Off', endpoint: '/reports/Orders/actions/approve' }],
  };
  const customView = await mount(out, customActionSpec, ROWS, new Set(['Total']));
  const customBtn = customView.container.querySelector('td button[data-action="/reports/Orders/actions/approve"]');
  assert.equal(customBtn?.getAttribute('aria-label'), 'Approve: Sign Off', 'differing action name preserves visible text in accessible name');
});

test('a todo-marked report and its field-only filters are listed for the developer, not drawn on the screen', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'todo');
  const spec = reactAppSpec(appOf());
  const feed = await mount(out, spec.reports.Feed!, ROWS, new Set(['Total']));
  const notes = [...feed.container.querySelectorAll('p.todo')].map((p) => p.textContent ?? '');
  assert.ok(notes.some((note) => /Shown as a list/.test(note)), `the report note is drawn: ${notes.join(' | ')}`);
  assert.ok(!notes.some((note) => /is not generated/.test(note)), `the note does not deny the drawn table: ${notes.join(' | ')}`);

  const orders = await mount(out, spec.reports.Orders!, ROWS, new Set(['Total']));
  const dropped = [...orders.container.querySelectorAll('p.todo')].map((p) => p.textContent ?? '').join(' ');
  assert.doesNotMatch(dropped, /not offered/, `the field-only filter is not a note on the screen: ${dropped}`);
  assert.ok(hiddenParts(spec).some((part) => part.location === 'report Orders' && /Status/.test(part.reason)), 'the field-only filter is listed for the developer');
});

test('record controls have a real destination and custom row actions post the ROWID', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'record-actions');
  const spec = reactAppSpec(appOf());
  const report = spec.reports.Orders!;
  const readOnly = { ...report, rowActions: { ...report.rowActions, edit: false } };
  const view = await mount(out, {
    ...readOnly,
    detail: true,
    customActions: [{ name: 'Print Invoice', endpoint: '/reports/Orders/actions/print-invoice' }],
  }, ROWS, new Set(['Total']));

  const opener = view.byRole('link', 'Open record 1') as HTMLAnchorElement | null;
  assert.equal(opener?.getAttribute('href'), '#/report/Orders/row/1');
  const action = view.byRole('button', 'Print Invoice');
  assert.ok(action, 'the authored row action is rendered as a button');
  await view.click(action);
  assert.deepEqual(view.posted.at(-1), {
    endpoint: '/reports/Orders/actions/print-invoice',
    body: { ROWID: '1' },
  }, 'the action POST reaches its endpoint with this row ID');

  const editable = await mount(out, { ...report, rowActions: { ...report.rowActions, edit: true } }, ROWS, new Set(['Total']));
  const edit = editable.byRole('link', 'Edit record 1') as HTMLAnchorElement | null;
  assert.equal(edit?.getAttribute('href'), '#/form/Order/edit/1');

  const noDetail = await mount(out, { ...readOnly, detail: false }, ROWS, new Set(['Total']));
  assert.equal(noDetail.byRole('link', 'Open record 1'), null, 'a read-only report without a detail layout has no fake opener');
  assert.equal(noDetail.container.querySelector('a.c2c-row-open'), null);

  const blankId = await mount(out, { ...readOnly, detail: true }, [{ Title: 'No ID', Total: '1' }], new Set(['Total']));
  assert.equal(blankId.byRole('link', 'Open record'), null, 'a row without ROWID has no control pointing to a create form');
  assert.equal(blankId.byRole('link', 'Open record 1'), null);
  assert.equal(blankId.byRole('link', 'Edit record'), null);
  assert.equal(blankId.container.querySelector('a.c2c-row-open'), null);
});

test('an openUrl-only custom action is a link to its target route with values from the row', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'nav-actions');
  const report = reactAppSpec(appOf()).reports.Orders!;
  const view = await mount(out, {
    ...report,
    customActions: [
      { name: 'Request', endpoint: '/reports/Orders/actions/request', header: true, navigate: { kind: 'form', target: 'Order', href: '#/form/Order', params: [{ name: 'Title', field: 'Title' }, { name: 'Total', field: 'Hidden_Total' }, { name: 'Kind', value: 'Loan' }] } },
      { name: 'All Orders', endpoint: '/reports/Orders/actions/all-orders', header: true, navigate: { kind: 'report', target: 'Orders', href: '#/report/Orders', params: [] } },
      { name: 'Stub', endpoint: '/reports/Orders/actions/stub', preview: true },
    ],
  }, ROWS, new Set(['Total']));
  const links = [...view.container.querySelectorAll('a[data-action-nav]')].map((a) => `${a.textContent} ${a.getAttribute('href')}`);
  // The row-bound header action opens per record (Hidden_Total is not on the
  // row, so it prefills nothing); the row-free one sits in the toolbar.
  assert.deepEqual(links.sort(), ['All Orders #/report/Orders', ...ROWS.map((row) => `Request #/form/Order?Title=${encodeURIComponent(String(row.Title))}&Kind=Loan`)].sort());
  assert.equal(view.container.querySelector('[data-action="/reports/Orders/actions/request"]'), null, 'a navigation posts to no endpoint');
  assert.equal((view.container.querySelector('button[data-action="/reports/Orders/actions/stub"]') as HTMLButtonElement | null)?.disabled, true, 'a counted stub stays turned off');
});

test('the React spec carries the navigation of an openUrl-only action', () => {
  const text = source()
    .replace('custom action "Approve"\n\t\t\t(\n\t\t\t\tcolumn header = "Approve"\n\t\t\t)', 'custom action "Approve"\n\t\t\t(\n\t\t\t\tworkflow = Open_Order\n\t\t\t)')
    .replace(/\n}\n$/, '\n\tworkflow\n\t{\n\tfunctions\n\t{\n\t\tOpen_Order as "Open Order"\n\t\t{\n\t\t\ttype = functions\n\t\t\tform = Order\n\t\t\texecution type = for each record\n\t\t\ton start\n\t\t\t{\n\t\t\t\tactions\n\t\t\t\t{\n\t\t\t\ton click\n\t\t\t\t(\n\t\t\t\t\topenUrl("#Form:Order?Title=" + input.Title,"popup window");\n\t\t\t\t)\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n\t}\n}\n');
  assert.notEqual(text, source());
  const action = reactAppSpec(appOf(text)).reports.Orders!.customActions.find((item) => item.name === 'Approve');
  assert.deepEqual(action?.navigate, { kind: 'form', target: 'Order', href: '#/form/Order', params: [{ name: 'Title', field: 'Title' }] });
  assert.equal(action?.preview, undefined);
});

test('record detail draws configured sections and related rows from the authorized record read', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'record-detail');
  const base = reactAppSpec(appOf()).reports.Orders!;
  const report = {
    ...base,
    detail: true,
    recordEndpoint: '/forms/Order/record',
    detailBlocks: [
      { title: 'Overview', fields: [{ field: 'Memo', label: 'Private Memo' }] },
      { title: 'Items', relatedField: 'Lines', fields: [{ field: 'Material', label: 'Material Name' }, { field: 'Quantity', label: 'Qty' }] },
    ],
  };
  const view = await mount(out, report, [], new Set(), {}, '1');
  const recordRead = view.posted.find((call) => call.endpoint.endsWith('/record'));
  assert.equal(recordRead?.endpoint, '/forms/Order/record');
  assert.deepEqual(recordRead?.body, { ROWID: '1', REPORT: 'Orders' });
  assert.equal(view.container.querySelector('[data-detail-block="Overview"] dt')?.textContent, 'Private Memo');
  assert.equal(view.container.querySelector('[data-detail-block="Overview"] dd')?.textContent, 'Read me');
  assert.deepEqual([...view.container.querySelectorAll('[data-detail-block="Items"] thead th')].map((el) => el.textContent), ['Material Name', 'Qty']);
  assert.deepEqual([...view.container.querySelectorAll('[data-detail-block="Items"] tbody td')].map((el) => el.textContent), ['Bolt', '3']);
});

test('record detail gives a clear error for denied and missing records', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'record-errors');
  const base = reactAppSpec(appOf()).reports.Orders!;
  const report = { ...base, detail: true, recordEndpoint: '/forms/Order/record' };
  for (const status of [403, 404]) {
    const view = await mount(out, report, [], new Set(), {}, '907', async () => ({ ok: false, status }));
    assert.equal(view.container.querySelector('[data-state="loading"]'), null, `${status} clears loading`);
    if (status === 403) {
      assert.ok(view.container.querySelector('[data-access-denied]'), `${status} renders the access-denied screen`);
      assert.match(view.container.textContent ?? '', /don't have access to/i);
    } else assert.match(view.container.textContent ?? '', /record could not be loaded/i);
  }
});

test('record detail shows a retryable network error', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'record-network-error');
  const base = reactAppSpec(appOf()).reports.Orders!;
  const report = { ...base, detail: true, recordEndpoint: '/forms/Order/record' };
  const view = await mount(out, report, [], new Set(), {}, '907', async () => ({ ok: false, status: 0 }));
  assert.equal(view.container.querySelector('[data-state="loading"]'), null);
  assert.match(view.container.textContent ?? '', /could not be reached/i);
  assert.ok(view.byRole('button', 'Retry'));
});

test('a field the export hides is marked not-writable in the spec', () => {
  const spec = reactAppSpec(
    appOf(`application "Hidden"
{
	form Item
	{
		Name
		(
			type = text
		)
		Secret
		(
			type = text
			visibility = false
		)
	}
}
`),
  );
  const fields = spec.forms.Item!.fields;
  assert.equal(fields.find((f) => f.name === 'Secret')!.visibility, false);
  assert.equal(fields.find((f) => f.name === 'Name')!.visibility, undefined);
});

test('the bulk picker omits hidden, read-only, unhandled and stage-limited fields', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'bulk-fields');
  const spec = reactAppSpec(appOf());
  const report = spec.reports.Orders!;
  const leaf = { required: false, readonly: false, generated: true };
  const form: FormSpec = {
    name: 'Order',
    label: 'Order',
    layout: 'one',
    submitEndpoint: '/forms/Order/submit',
    editSubmitEndpoint: '/forms/Order/edit',
    recordEndpoint: '/forms/Order/record',
    buttons: { add: [], edit: [] },
    fields: [
      { ...leaf, name: 'Title', label: 'Title', widget: 'text' },
      { ...leaf, name: 'Total', label: 'Total', widget: 'decimal' },
      { ...leaf, name: 'Secret', label: 'Secret', widget: 'text', visibility: false },
      { ...leaf, name: 'Locked', label: 'Locked', widget: 'text', readonly: true },
      { ...leaf, name: 'Photo', label: 'Photo', widget: 'image' },
      { ...leaf, name: 'Staged', label: 'Staged', widget: 'text' },
      { ...leaf, name: 'Frozen', label: 'Frozen', widget: 'text' },
    ],
    stageFields: [{ statusColumn: 'Status', stages: { Review: { hidden: ['Staged'], readonly: ['Frozen'] } }, transitions: {} }],
  };
  const view = await mount(out, { ...report, form: 'Order', rowActions: { edit: true, delete: false } }, ROWS, new Set(), { Order: form });
  const options = [...view.container.querySelectorAll('select[aria-label="Field to edit"] option')].map((option) => option.getAttribute('value'));
  assert.deepEqual(options, ['', 'Title', 'Total']);
});

test('non-list reports keep their visible pending-view stub', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'view-stub');
  const spec = reactAppSpec(appOf());
  const board = await mount(out, { ...spec.reports.Orders!, view: 'kanban', todo: 'Kanban view is pending.' }, ROWS, new Set(['Total']));
  assert.ok(board.container.querySelector('[data-view-stub="kanban"]'));
  assert.match(board.container.textContent ?? '', /view, which this app does not draw yet/);
  assert.equal(board.container.querySelector('table'), null, 'pending views are not silently rendered as lists');
});

test('a row Delete asks first and Cancel sends nothing', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'delete-confirm');
  const spec = reactAppSpec(appOf());
  const report = { ...spec.reports.Orders!, deleteEndpoint: '/forms/Order/delete' };
  const view = await mount(out, report, ROWS, new Set(['Total']));
  const asked: string[] = [];
  let answer = false;
  view.win.confirm = (text: string) => {
    asked.push(text);
    return answer;
  };
  const deletes = () => view.posted.filter((p) => p.endpoint === '/forms/Order/delete');
  const button = view.container.querySelector('button[data-row-delete]');
  assert.ok(button, 'the report draws a row Delete');
  await view.click(button);
  assert.deepEqual(asked, ['Are you sure you want to delete this record?'], 'Delete asks with the confirm text');
  assert.equal(deletes().length, 0, 'Cancel sends no delete');
  assert.equal(view.textOf('Title').length, ROWS.length, 'Cancel keeps the row');

  answer = true;
  await view.click(view.container.querySelector('button[data-row-delete]'));
  assert.equal(asked.length, 2);
  assert.equal(deletes().length, 1, 'OK posts the delete once');
  assert.ok(ROWS.some((r) => r.ROWID === deletes()[0]!.body.ROWID), 'the delete names a drawn row');
});

test('a custom action whose endpoint is a dry-run stub is turned off and named, never run', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'action-preview');
  const spec = reactAppSpec(appOf());
  // The generated spec marks every stub endpoint: the Approve column action included.
  assert.equal(spec.reports.Orders!.customActions.every((a) => a.preview === true), true, 'stub actions carry preview in the spec');
  const report = {
    ...spec.reports.Orders!,
    customActions: [
      ...spec.reports.Orders!.customActions,
      { name: 'Mark as Lost', endpoint: '/reports/Orders/actions/mark-as-lost', preview: true as const },
      { name: 'Export All', endpoint: '/reports/Orders/actions/export-all', header: true, preview: true as const },
    ],
  };
  const view = await mount(out, report, ROWS, new Set(['Total']));
  const buttons = [...view.container.querySelectorAll('button[data-action]')] as HTMLButtonElement[];
  assert.ok(buttons.some((b) => b.getAttribute('data-action') === '/reports/Orders/actions/mark-as-lost'), 'the record action is drawn');
  assert.ok(buttons.some((b) => b.getAttribute('data-action') === '/reports/Orders/actions/export-all'), 'the header action is drawn');
  assert.ok(buttons.some((b) => b.getAttribute('data-action') === '/reports/Orders/actions/approve'), 'the column action is drawn');
  for (const button of buttons) {
    assert.equal(button.disabled, true, `${button.getAttribute('data-action')} is turned off`);
    await view.click(button);
  }
  assert.equal(view.posted.filter((p) => p.endpoint.includes('/actions/')).length, 0, 'a turned-off action posts nothing');
  assert.doesNotMatch(view.container.textContent ?? '', /ran\./, 'no run is reported');
  const note = view.container.querySelector('[data-action-preview]')?.textContent ?? '';
  assert.match(note, /Not available yet, so turned off: .*Mark as Lost.*Export All/);
});

test('the conditional format allowlist mirrors the static sanitizer and rejects unsafe tokens', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'allowlist');
  const { isSafeStyleProperty, isSafeStyleValue } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/style-allowlist.js')).href)) as {
    isSafeStyleProperty: (n: string) => boolean;
    isSafeStyleValue: (v: string, p?: string) => boolean;
  };
  const { parseFormat } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/report/ReportView.js')).href)) as {
    parseFormat: (f: string) => Record<string, string>;
  };
  const cases: { prop: string; value: string; safe: boolean }[] = [
    { prop: 'color', value: '#19bc9f', safe: true },
    { prop: 'color', value: 'red', safe: true },
    { prop: 'color', value: 'rgb(1, 2, 3)', safe: true },
    { prop: 'font-weight', value: 'bold', safe: true },
    { prop: 'font-style', value: 'italic', safe: true },
    { prop: 'color', value: 'expression(alert(1))', safe: false },
    { prop: 'background', value: 'url(//example.test/x)', safe: false },
    { prop: 'color', value: 'javascript:alert(1)', safe: false },
    { prop: 'color', value: 'red"', safe: false },
    { prop: 'color', value: '</style>', safe: false },
    { prop: 'color', value: 'a'.repeat(10000), safe: false },
  ];
  for (const { prop, value, safe } of cases) {
    assert.equal(isSafeStyleProperty(prop), prop !== 'x' && prop !== 'behavior', `${prop} property allowlist`);
    assert.equal(isSafeStyleValue(value, prop), safe, `isSafeStyleValue("${value.slice(0, 40)}...", ${prop})`);
    const format = `${prop}:${value};`;
    const got = parseFormat(format);
    const want = safe ? { [prop.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())]: value } : {};
    assert.deepEqual(got, want, `parseFormat("${format.slice(0, 60)}...")`);
    const cleaned = cleanStyle(format);
    assert.equal(cleaned.style !== '', safe, `cleanStyle parity for "${format.slice(0, 60)}..."`);
  }
  assert.equal(isSafeStyleProperty('behavior'), false, 'behavior is refused');
  assert.equal(isSafeStyleProperty('-moz-binding'), false, '-moz-binding is refused');
});

const DATE_SOURCE = `application "Library"
{
date format = "dd-MMM-yyyy"
time zone = "Asia/Kolkata"
time format = "24-hr"
form Member
{
Name
(
type = text
)
Start_Date
(
type = date
)
Checked_Out
(
type = datetime
)
}
list Member_Report
{
show all rows from Member
(
Name
Start_Date
Checked_Out
)
group by
(
Start_Date
)
}
}`;

const DATE_ROWS: Row[] = [{ ROWID: '1', Name: 'Ada', Start_Date: '2026-10-17', Checked_Out: '2026-10-17 14:05:00' }];

test('the report spec carries the app time format and the date column kinds', () => {
  const spec = reactAppSpec(appOf(DATE_SOURCE));
  assert.equal(spec.dateFormat, 'dd-MMM-yyyy');
  assert.equal(spec.timeFormat, '24-hr');
  assert.deepEqual(spec.reports.Member_Report!.columns.map((c) => [c.field, c.date ?? null]), [['Name', null], ['Start_Date', 'date'], ['Checked_Out', 'datetime']]);
});

test('date and date-time cells and their group header show the app date format and 24-hour clock', { skip: SKIP }, async (t) => {
  const spec = reactAppSpec(appOf(DATE_SOURCE));
  const out = await compileOnly(t, 'dates');
  const view = await mount(out, spec.reports.Member_Report!, DATE_ROWS, new Set(), {}, undefined, undefined, { dateFormat: spec.dateFormat, timeFormat: spec.timeFormat });
  assert.deepEqual(view.textOf('Start_Date'), ['17-Oct-2026']);
  assert.deepEqual(view.textOf('Checked_Out'), ['17-Oct-2026 14:05:00']);
  assert.equal(view.container.querySelector('[data-group]')?.getAttribute('data-group'), '17-Oct-2026', 'the group header names the day in the app format');
  assert.doesNotMatch(view.container.textContent ?? '', /2026-10-17/);
});

test('a 12-hour app shows a date-time with AM/PM and another date format', { skip: SKIP }, async (t) => {
  const spec = reactAppSpec(appOf(DATE_SOURCE.replace('dd-MMM-yyyy', 'MM/dd/yyyy').replace('24-hr', '12-hr')));
  const out = await compileOnly(t, 'dates12');
  const view = await mount(out, spec.reports.Member_Report!, DATE_ROWS, new Set(), {}, undefined, undefined, { dateFormat: spec.dateFormat, timeFormat: spec.timeFormat });
  assert.deepEqual(view.textOf('Start_Date'), ['10/17/2026']);
  assert.deepEqual(view.textOf('Checked_Out'), ['10/17/2026 02:05:00 PM']);
});

test('record detail shows a stored date in the app format', { skip: SKIP }, async (t) => {
  const spec = reactAppSpec(appOf(DATE_SOURCE));
  const out = await compileOnly(t, 'date-detail');
  const report = { ...spec.reports.Member_Report!, detail: true, recordEndpoint: '/forms/Member/record' };
  const reply = async () => ({ ok: true, status: 200, body: { record: DATE_ROWS[0] } });
  const view = await mount(out, report, [], new Set(), {}, '1', reply, { dateFormat: spec.dateFormat, timeFormat: spec.timeFormat });
  const values = [...view.container.querySelectorAll('.c2c-record dd')].map((el) => el.textContent);
  assert.deepEqual(values, ['Ada', '17-Oct-2026', '17-Oct-2026 14:05:00']);
});

test('a DATE value shows the same calendar day under TZ=America/Los_Angeles and TZ=Asia/Kolkata', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'date-tz');
  const mod = pathToFileURL(join(out, 'lib/c2c-ui/form/dates.js')).href;
  const script = `const { displayDateValue } = await import(${JSON.stringify(mod)});
process.stdout.write(JSON.stringify([displayDateValue('2026-10-17', 'date'), displayDateValue('2026-01-01T00:00:00Z', 'date'), displayDateValue('2026-10-17T08:35:00Z', 'datetime', { timeFormat: '24-hr', timeZone: 'Asia/Kolkata' }), new Date(2026, 0, 1).getTimezoneOffset()]));`;
  const seen = ['America/Los_Angeles', 'Asia/Kolkata'].map((zone) => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout) as [string, string, string, number];
  });
  assert.notEqual(seen[0]![3], seen[1]![3], 'the two runs really use different browser zones');
  for (const [date, newYear, instant] of seen) {
    assert.equal(date, '17-Oct-2026');
    assert.equal(newYear, '01-Jan-2026');
    assert.equal(instant, '17-Oct-2026 14:05:00', 'an instant shows in the app zone, whatever the browser zone');
  }
});
