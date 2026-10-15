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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { compareCells, compareDecimalCells } from '../../shims/src/criteria.js';
import { TEMPLATE_DIR, reactAppSpec } from '../src/index.js';
import type { FormSpec, ReportSpec } from '../template/lib/c2c-ui/types.js';

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
  const out = join(tmpdir(), `c2c-report-order-${process.pid}`);
  t.after(() => rmSync(out, { recursive: true, force: true }));
  mkdirSync(out, { recursive: true });
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
const LIB = join(TEMPLATE_DIR, 'lib');

/** Transpile lib/c2c-ui to ESM .js under <out>/lib; css imports get a stub module, bare specifiers get a node_modules link. */
function compileLib(out: string): void {
  assert.ok(runtimeReady, MISSING);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  walk(LIB);
  mkdirSync(out, { recursive: true });
  const stub = join(out, 'css-stub.mjs');
  writeFileSync(stub, 'export default new Proxy({}, { get: (_, key) => String(key) });\n');
  for (const file of files) {
    const target = join(out, 'lib', relative(LIB, file).replace(/\.tsx?$/, '.js'));
    mkdirSync(dirname(target), { recursive: true });
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    });
    const specifier = (pre: string, spec: string): string => {
      if (spec.endsWith('.css')) {
        const to = relative(dirname(target), stub).replace(/\\/g, '/');
        return `${pre}'${to.startsWith('.') ? to : `./${to}`}'`;
      }
      return /\.[a-z]+$/.test(spec) ? `${pre}'${spec}'` : `${pre}'${spec}.js'`;
    };
    const rewritten = outputText
      .replace(/^(\s*(?:import|export)\s[^'"]*?\bfrom\s*)['"](\.{1,2}\/[^'"]+)['"]/gm, (_all, pre: string, spec: string) => specifier(pre, spec))
      .replace(/^(\s*import\s*)['"](\.{1,2}\/[^'"]+)['"]/gm, (_all, pre: string, spec: string) => specifier(pre, spec));
    writeFileSync(target, rewritten);
  }
  symlinkSync(MODULES, join(out, 'node_modules'), 'dir');
}

type Row = Record<string, unknown>;

interface Mounted {
  container: HTMLElement;
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
async function mount(out: string, report: ReportSpec, rows: Row[], numericKeys: ReadonlySet<string>, forms: Record<string, FormSpec> = {}, rowId?: string, recordReply?: () => Promise<{ ok: boolean; status: number; body?: unknown }>): Promise<Mounted> {
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
  const spec = { name: 'Shop', spec: 1 as const, theme: { accent: '#000000', accentInk: '#ffffff', menu: 'list' as const }, nav: [], forms, reports: { [report.name]: report } };
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
  const out = join(tmpdir(), `c2c-report-render-${tag}-${process.pid}`);
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

test('a todo-marked report and its field-only filters are visible, not silent', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'todo');
  const spec = reactAppSpec(appOf());
  const feed = await mount(out, spec.reports.Feed!, ROWS, new Set(['Total']));
  const notes = [...feed.container.querySelectorAll('p.todo')].map((p) => p.textContent ?? '');
  assert.ok(notes.some((note) => /Shown as a list/.test(note)), `the report note is drawn: ${notes.join(' | ')}`);
  assert.ok(!notes.some((note) => /is not generated/.test(note)), `the note does not deny the drawn table: ${notes.join(' | ')}`);

  const orders = await mount(out, spec.reports.Orders!, ROWS, new Set(['Total']));
  const dropped = [...orders.container.querySelectorAll('p.todo')].map((p) => p.textContent ?? '').join(' ');
  assert.match(dropped, /Status/, `the field-only filter is named: ${dropped}`);
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
