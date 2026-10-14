/**
 * Layout, wording, lookup text, and report views run on one generated page.
 * The browser file is the base runtime plus each client script in filename order.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { BROWSER_GLOBALS, ES_GLOBALS, freeIdentifiers } from '../../quality/src/scope.js';
import { clientRuntimeSource } from '../src/generate.js';
import { buildModel, type UiField, type UiModel, type UiReport } from '../src/model.js';

const BODY = `
form Vendor
{
	Vendor_Name
	(
		type = text
		displayname = "Vendor Name"
	)
}
form Purchase_Order
{
	displayname = "Purchase Order"
	must have PO_Title
	(
		type = text
		displayname = "PO Title"
		row = 1
		column = 1
		width = medium
	)
	must have Vendor
	(
		type = picklist
		values = Vendor.ID
		displayformat = [Vendor_Name]
		row = 1
		column = 2
		width = medium
		description
		[
			type = help_text
			message = "Who supplies this order"
		]
	)
	Active
	(
		type = decision
		displayname = "Active"
		row = 2
		column = 1
	)
	actions
	{
		on add
		{
			submit
			(
				type = submit
				displayname = "Create order"
			)
		}
	}
}
list All_Purchase_Orders
{
	displayName = "All Purchase Orders"
	show all rows from Purchase_Order
	(
		PO_Title
		Vendor
		Active
		(
			displaytrue = "Yes"
			displayfalse = "No"
		)
	)
	sort by
	{
		PO_Title ascending
	}
	group by
	{
		Vendor
	}
}
web
{
	forms
	{
		form Purchase_Order
		{
			label placement = left
		}
	}
	reports
	{
		report All_Purchase_Orders
		{
			quickview
			(
				layout
				(
					datablock1
					(
						title = "Overview"
						fields
						(
							PO_Title as "Title on the list"
							Vendor
							Active as "In use"
						)
					)
				)
			)
			detailview
			(
				layout
				(
					datablock1
					(
						title = "Overview"
						fields
						(
							PO_Title
							Vendor
							Active
						)
					)
				)
			)
		}
	}
}
`;

function appOf(): App {
  return deriveIr(parse(`application "Demo"\n{\n${BODY}\n}\n`));
}

type DecoratedField = UiField & { help?: string; lookup?: { field?: string; endpoint?: string } };
type DecoratedReport = UiReport & { detailBlocks?: { title: string }[] };

interface PageEl {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): PageEl | null;
  querySelectorAll(selector: string): ArrayLike<PageEl> & Iterable<PageEl>;
}

interface PageWin {
  document: PageEl;
  fetch: typeof fetch;
  location: { hash: string };
}

function shell(_hash: string): string {
  return `<!doctype html><body>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar"><button id="menu-toggle" type="button">Menu</button><strong id="app-title"></strong></header>
<div class="shell"><nav id="nav"></nav><main id="main"></main></div>
<div id="toasts"></div>
</body>`;
}

test('each decoration runs and the page shows a form and a report', async () => {
  const app = appOf();
  const model = buildModel(app);
  const form = model.forms.find((item) => item.name === 'Purchase_Order');
  assert.ok(form);
  assert.equal(form.layout, 'two');
  const title = form.fields.find((item) => item.name === 'PO_Title') as DecoratedField;
  const vendor = form.fields.find((item) => item.name === 'Vendor') as DecoratedField;
  assert.equal(title.row, 1);
  assert.equal(title.column, 1);
  assert.equal(vendor.column, 2);
  assert.equal(vendor.labelPlacement, 'left');
  assert.equal(vendor.help, 'Who supplies this order');
  assert.equal(vendor.lookup?.field, 'Vendor_Name');
  assert.match(vendor.lookup?.endpoint ?? '', /Vendor_Name/);
  const report = model.reports.find((item) => item.name === 'All_Purchase_Orders') as DecoratedReport;
  assert.ok(report);
  assert.deepEqual(
    report.columns.map((column) => column.label),
    ['Title on the list', 'Vendor', 'In use'],
  );
  const active = report.columns.find((column) => column.field === 'Active') as { displayTrue?: string } | undefined;
  assert.equal(active?.displayTrue, 'Yes');
  assert.deepEqual(
    (report.detailBlocks ?? []).map((block) => block.title),
    ['Overview'],
  );
  assert.equal(form.fields.length > 0 && report.columns.length === 3, true);

  const source = clientRuntimeSource();
  const dir = mkdtempSync(join(tmpdir(), 'c2c-decorate-all-'));
  const file = join(dir, 'runtime.mjs');
  try {
    writeFileSync(file, source);
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const allowed = new Set<string>([...ES_GLOBALS, ...BROWSER_GLOBALS, 'model']);
  const free = freeIdentifiers(source, allowed, 'client-runtime.mjs');
  assert.deepEqual(
    free.map((item) => item.name),
    [],
    free.map((item) => `${item.name}:${item.line}`).join(', '),
  );
  const order = ['20-form-layout.js', '30-labels.js', '40-lookup-display.js', '50-report-views.js'];
  let at = 0;
  for (const name of order) {
    const next = source.indexOf(name.slice(0, 2) === '20' ? 'installFormLayout' : name.slice(0, 2) === '30' ? 'applyFormLabels' : name.slice(0, 2) === '40' ? 'applyLookupDisplays' : 'installReportViews', at);
    assert.ok(next > at, name);
    at = next;
  }

  (globalThis as { CSS?: { escape(value: string): string } }).CSS ??= { escape: (value: string) => value };
  const runtime = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as {
    boot(model: UiModel, doc: PageEl): Promise<void>;
    renderForm(form: UiModel['forms'][number]): string;
  };
  const rows = [
    { ROWID: '1', PO_Title: 'First', Vendor: '9', Active: true },
    { ROWID: '2', PO_Title: 'Second', Vendor: '9', Active: false },
  ];

  const formWin = new JSDOM(shell('#/form/Purchase_Order'), {
    url: 'http://127.0.0.1/slate/index.html#/form/Purchase_Order',
    runScripts: 'outside-only',
  }).window as unknown as PageWin;
  await runtime.boot(model, formWin.document);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const formEl = formWin.document.querySelector('form[data-form="Purchase_Order"]');
  assert.ok(formEl);
  assert.equal(formEl.querySelector('[data-field="PO_Title"]')?.getAttribute('data-column'), '1');
  assert.equal(formEl.querySelector('[data-field="Vendor"]')?.getAttribute('data-column'), '2');
  assert.equal(formEl.querySelector('[data-field="Vendor"] [data-help]')?.textContent, 'Who supplies this order');
  assert.equal(formEl.querySelector('button[type="submit"]')?.textContent, 'Create order');
  assert.equal(formWin.document.querySelector('#nav')?.textContent?.includes('Purchase Order'), true);

  const reportWin = new JSDOM(shell('#/report/All_Purchase_Orders'), {
    url: 'http://127.0.0.1/slate/index.html#/report/All_Purchase_Orders',
    runScripts: 'outside-only',
  }).window as unknown as PageWin;
  reportWin.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ rows }),
  })) as unknown as typeof fetch;
  await runtime.boot(model, reportWin.document);
  // The decoration pass runs on a timer scheduled after the rows' fetch
  // resolves: a few timer turns, not a wall-clock wait.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const section = reportWin.document.querySelector('section[data-report="All_Purchase_Orders"]');
  assert.ok(section);
  assert.deepEqual(
    Array.from(section.querySelectorAll('th')).map((cell) => cell.textContent),
    ['Title on the list', 'Vendor', 'In use'],
  );
  assert.equal(section.querySelector('[data-group-by]')?.textContent, 'Grouped by Vendor');
  assert.ok(section.querySelector('select[data-sort]'));
  const cells = Array.from(section.querySelectorAll('tbody tr')).map((row) =>
    Array.from(row.querySelectorAll('td:not([data-card-actions])')).map((cell) => cell.textContent),
  );
  assert.deepEqual(cells, [
    ['First', '9', 'Yes'],
    ['Second', '9', 'No'],
  ]);

  reportWin.location.hash = '#/report/All_Purchase_Orders/row/1';
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reportWin.document.querySelector('[data-block]')?.getAttribute('data-block'), 'Overview');
  assert.match(runtime.renderForm(form), /data-layout="two"/);
});
