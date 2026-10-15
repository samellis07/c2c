import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { TEMPLATE_DIR, generateReactApp, reactAppSpec } from '../src/index.js';

function source(): string {
  return `application "Shop"
{
\tform Order
\t{
\t\tdisplayname = "Order"
\t\tTitle
\t\t(
\t\t\ttype = text
\t\t\tdisplayname = "Title"
\t\t)
\t\tStatus
\t\t(
\t\t\ttype = picklist
\t\t\tdisplayname = "Status"
\t\t\tvalues = {"Open","Closed"}
\t\t)
\t\tTotal
\t\t(
\t\t\ttype = number
\t\t\tdisplayname = "Total"
\t\t)
\t}
\tlist Orders
\t{
\t\tdisplayname = "Orders"
\t\tshow all rows from Order
\t\t(
\t\t\tTitle
\t\t\tStatus
\t\t\tTotal
\t\t\tcustom action "Export"
\t\t\t(
\t\t\t\tshow action in view header = true
\t\t\t)
\t\t\tcustom action "Approve"
\t\t\t(
\t\t\t\tcolumn header = "Approve"
\t\t\t)
\t\t\tcustom action "Print Invoice"
\t\t\t(
\t\t\t)
\t\t)
\t\tfilters
\t\t(
\t\t\t"Open only" : Status == "Open"
\t\t\tStatus
\t\t)
\t\tgroup by
\t\t(
\t\t\tStatus ascending
\t\t)
\t\tsort by
\t\t(
\t\t\tTotal descending
\t\t)
\t\tconditional formatting
\t\t(
\t\t\t"Big"
\t\t\t{
\t\t\t\tcondition = (Status == "Open")
\t\t\t\tfields = [Status]
\t\t\t\tformat = "color:#19bc9f;"
\t\t\t}
\t\t)
\t\tdetailview
\t\t(
\t\t\tlayout
\t\t\t(
\t\t\t\tdatablock1
\t\t\t\t(
\t\t\t\t\ttitle = "Overview"
\t\t\t\t\tfields
\t\t\t\t\t(
\t\t\t\t\t\tTitle
\t\t\t\t\t\tStatus
\t\t\t\t\t)
\t\t\t\t)
\t\t\t)
\t\t)
\t}
\tkanban Board
\t{
\t\tdisplayname = "Board"
\t\tshow all rows from Order
\t\t(
\t\t\tTitle
\t\t\tStatus
\t\t)
\t\tgroup by
\t\t(
\t\t\tStatus ascending
\t\t)
\t}
}
`;
}

function appOf(text = source()): App {
  return deriveIr(parse(text));
}

function textOf(path: string): string {
  return readFileSync(join(TEMPLATE_DIR, path), 'utf8');
}

test('the report spec carries the view options: sort, filters, grouping, detail, formats and action columns', () => {
  const spec = reactAppSpec(appOf());
  const report = spec.reports.Orders!;
  assert.equal(report.view, 'list');
  assert.deepEqual(report.sort, [{ field: 'Total', order: 'descending' }]);
  assert.deepEqual(report.filters, [{ label: 'Open only' }, { field: 'Status' }]);
  assert.deepEqual(report.groupBy, [{ field: 'Status' }]);
  assert.equal(report.groupField, 'Status');
  assert.equal(report.detail, true);
  assert.equal(report.form, 'Order');
  assert.deepEqual(report.detailBlocks, [{
    title: 'Overview',
    fields: [
      { field: 'Title', label: 'Title' },
      { field: 'Status', label: 'Status' },
    ],
  }]);
  const formats = report.conditionalFormats!;
  assert.equal(formats.length, 1);
  assert.equal(formats[0]!.name, 'Big');
  assert.deepEqual(formats[0]!.fields, ['Status']);
  assert.equal(formats[0]!.format, 'color:#19bc9f;');
  assert.ok(formats[0]!.criteria !== undefined, 'the compiled criteria travel with the format');
  // A `column header` action is a per-record column; a header action is a toolbar button.
  const approve = report.columns.find((c) => c.field === 'Approve')!;
  assert.equal(approve.label, 'Approve');
  assert.equal(approve.action, '/reports/Orders/actions/approve');
  const toolbar = report.customActions.filter((a) => a.header);
  assert.deepEqual(toolbar.map((a) => [a.name, a.endpoint]), [['Export', '/reports/Orders/actions/export']]);
  const recordActions = report.customActions.filter((a) => !a.header && !report.columns.some((c) => c.action === a.endpoint));
  assert.deepEqual(recordActions.map((a) => [a.name, a.endpoint]), [['Print Invoice', '/reports/Orders/actions/print-invoice']]);
  const plain = spec.reports.Board!;
  assert.equal(plain.view, 'kanban');
  assert.equal(plain.groupField, 'Status');
});

test('generated report modules forward the record route and mark pending views as todo', () => {
  const files = generateReactApp(appOf());
  const list = files.find((f) => f.path === 'src/generated/reports/Orders.tsx')!;
  const module = String(list.data);
  assert.match(module, /\{\s*row\s*\}:\s*ScreenProps/);
  assert.match(module, /<ReportView report=\{report\} row=\{row\} \/>/);
  assert.doesNotMatch(module, /className="todo"/);
  const board = String(files.find((f) => f.path === 'src/generated/reports/Board.tsx')!.data);
  assert.match(board, /className="todo"/);
  assert.match(board, /data-view-pending="kanban"/);
});

test('Arc pagination and filter toolbar are vendored at the recorded commit', () => {
  for (const name of ['pagination', 'filter-toolbar']) {
    assert.ok(textOf(`lib/c2c-ui/arc/components/${name}/${name}.tsx`).length > 0, name);
    assert.ok(textOf(`lib/c2c-ui/arc/components/${name}/${name}.module.css`).length > 0, `${name} css`);
  }
  const upstream = textOf('lib/c2c-ui/ARC-UPSTREAM.md');
  assert.match(upstream, /`pagination`/);
  assert.match(upstream, /`filter-toolbar`/);
  const index = textOf('lib/c2c-ui/index.ts');
  assert.match(index, /Pagination/);
  assert.match(index, /FilterToolbar/);
});

test('the report view queries with the server sort, search and filter, and wires the actions', () => {
  const view = textOf('lib/c2c-ui/report/ReportView.tsx');
  assert.match(view, /sort:/);
  assert.match(view, /\bq\b/);
  assert.match(view, /filter/);
  assert.match(view, /FilterToolbar/);
  assert.match(view, /Pagination/);
  assert.match(view, /data-action/);
  assert.match(view, /onSortChange/);
  assert.match(view, /data-detail-block/);
  assert.match(view, /Array\.isArray\(related\)/);
});

test('the report criteria matcher paints conditional formats and names unmigrated ones', () => {
  const matcher = textOf('lib/c2c-ui/report/criteria.ts');
  assert.match(matcher, /matchCriteria/);
  assert.match(matcher, /criteriaTodo/);
});

