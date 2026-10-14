/**
 * A phone report card ends with the record's actions: column-header custom
 * actions, then View, Edit and Delete when the report allows them. A wide
 * screen hides that footer. The phone action check finds the button there.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../../ui/src/index.js';
import { bundleFromFiles, cssAtWidth, parseCss, scoreUi } from '../src/score.js';

function field(name: string, type: string): string {
  return `\t\t\t${name}\n\t\t\t(\n\t\t\t\ttype = ${type}\n\t\t\t\tdisplayname = "${name.replace(/_/g, ' ')}"\n\t\t\t)`;
}

const SOURCE = `application "Order Desk"
{
	section Sales
	{
		form Order
		{
			displayname = "New Order"
${field('Title', 'text')}
${field('Status', 'text')}
${field('Due_Date', 'date')}
${field('Notes', 'textarea')}
		}
		list All_Orders
		{
			displayname = "All Orders"
			show all rows from Order
			(
				Title
				Status
				Due_Date
				Notes
				custom action "Approve"
				(
					column header = "Approve"
				)
				custom action "Export"
				(
					show action in view header = true
				)
			)
		}
	}
}
`;

async function rowsRuntime(): Promise<{
  renderReportRows(report: Record<string, unknown>, rows: Record<string, unknown>[]): string;
}> {
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as {
    renderReportRows(report: Record<string, unknown>, rows: Record<string, unknown>[]): string;
  };
}

interface DomEl {
  textContent: string | null;
  querySelector(selector: string): DomEl | null;
  querySelectorAll(selector: string): ArrayLike<DomEl>;
  closest(selector: string): DomEl | null;
}

interface DomWin {
  document: { querySelector(selector: string): DomEl | null };
  getComputedStyle(el: DomEl): { display: string };
}

function windowOf(html: string): DomWin {
  return new JSDOM(html).window as unknown as DomWin;
}

function footerLabels(html: string): string[] {
  const footer = windowOf(`<table><tbody>${html}</tbody></table>`).document.querySelector('[data-card-actions]');
  if (!footer) return [];
  return Array.from(footer.querySelectorAll('button, a')).map((el) => el.textContent ?? '');
}

function paint(css: string, html: string): { display: (selector: string) => string; cell: (selector: string) => string } {
  const win = windowOf(
    `<!doctype html><style>${css}</style><section data-report="All_Orders"><table><tbody>${html}</tbody></table></section>`,
  );
  const displayOf = (el: DomEl | null, selector: string) => {
    assert.ok(el, selector);
    return win.getComputedStyle(el).display;
  };
  return {
    display: (selector: string) => displayOf(win.document.querySelector(selector), selector),
    cell: (selector: string) => displayOf(win.document.querySelector(selector)?.closest('td') ?? null, selector),
  };
}

test('the phone card footer shows the actions the wide list allows', async () => {
  const app = deriveIr(parse(SOURCE));
  const built = buildUi(app);
  const bundle = bundleFromFiles(built.files);
  const scored = await scoreUi(app, bundle);
  const action = (viewport: 'phone' | 'desktop') =>
    scored.checks.find((check) => check.id === 'action:All_Orders.Approve' && check.viewport === viewport);
  assert.equal(action('desktop')?.pass, true, action('desktop')?.evidence);
  // The column cell stays off the phone card. The footer button is the one the check finds.
  assert.equal(action('phone')?.pass, true, action('phone')?.evidence);

  const report = built.model.reports.find((item) => item.name === 'All_Orders');
  assert.ok(report);
  const runtime = await rowsRuntime();
  const html = runtime.renderReportRows(report as unknown as Record<string, unknown>, [{ ROWID: '1001', Title: 'T' }]);
  assert.deepEqual(footerLabels(html), ['Approve', 'Edit', 'Delete']);
  const rules = parseCss(bundle.css);
  const phone = paint(cssAtWidth(rules, 390), html);
  const desktop = paint(cssAtWidth(rules, 1440), html);
  // The column button's cell is off the phone card. The footer button is shown.
  assert.equal(phone.cell('td:not([data-card-actions]) button[data-action]'), 'none');
  assert.equal(phone.display('[data-card-actions]'), 'block');
  assert.equal(phone.display('[data-card-actions] button'), 'inline-flex');
  assert.equal(desktop.display('[data-card-actions]'), 'none');

  // A header-only action stays in the toolbar. Edit is omitted when the report does not allow it.
  // View needs a detail screen and a record id.
  const limited = runtime.renderReportRows(
    {
      name: 'Stock',
      columns: [
        { field: 'Title', label: 'Title' },
        { field: 'Export', label: 'Export', action: '/reports/Stock/actions/export' },
      ],
      detail: true,
      rowActions: { delete: true },
      customActions: [{ name: 'Print', header: true, endpoint: '/reports/Stock/actions/print' }],
    },
    [{ ROWID: '9', Title: 'A' }],
  );
  assert.deepEqual(footerLabels(limited), ['Export', 'View', 'Delete']);
  const noId = runtime.renderReportRows(
    {
      name: 'Stock',
      columns: [{ field: 'Export', label: 'Export', action: '/reports/Stock/actions/export' }],
      detail: true,
      rowActions: { edit: true, delete: true },
    },
    [{ Title: 'A' }],
  );
  assert.deepEqual(footerLabels(noId), ['Export']);

  // Without the footer marker the phone check fails again; the wide list still shows the column button.
  const stripped = bundle.runtime.replaceAll('data-card-actions', 'data-not-actions');
  assert.notEqual(stripped, bundle.runtime);
  const again = await scoreUi(app, { ...bundle, runtime: stripped });
  const hidden = (viewport: 'phone' | 'desktop') =>
    again.checks.find((check) => check.id === 'action:All_Orders.Approve' && check.viewport === viewport);
  assert.equal(hidden('phone')?.pass, false, hidden('phone')?.evidence);
  assert.equal(hidden('desktop')?.pass, true, hidden('desktop')?.evidence);
});
