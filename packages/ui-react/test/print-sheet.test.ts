/**
 * Behaviour tests for the generated app's print layout (docs/print-templates.md):
 * the record view's Print button, the sheet it opens, and the sanitizer that
 * runs on the layout's own markup and on every record value it fills in. The
 * render tests need the template's runtime dependencies (`npm ci --prefix
 * packages/ui-react/template`); without them they skip locally and fail
 * under CI, where the install step is part of the run.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { compileTemplateLib, mountTemplateScreen, reactAppSpec, templateRuntimeReady, TEMPLATE_MISSING, type TemplateApi } from '../src/index.js';
import type { AppSpec, PrintTemplateSpec, ReportSpec } from '../template/lib/c2c-ui/types.js';

const SKIP = templateRuntimeReady() ? false : process.env.CI === 'true' ? false : TEMPLATE_MISSING;

function appOf(): App {
  return deriveIr(
    parse(`application "Shop"
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
		)
	}
}
`),
  );
}

/** A report with a detail route and the given print template (or none), wrapped in a minimal app spec. */
function specWithTemplate(template: PrintTemplateSpec | undefined): { spec: AppSpec; report: ReportSpec } {
  const base = reactAppSpec(appOf());
  const report: ReportSpec = {
    ...base.reports.Orders!,
    detail: true,
    recordEndpoint: '/forms/Order/record',
    ...(template ? { printTemplate: template } : {}),
  };
  return { spec: { ...base, reports: { Orders: report } }, report };
}

async function compileOnly(t: { after(fn: () => void): void }, tag: string): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), `c2c-print-sheet-${tag}-`));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  compileTemplateLib(out);
  return out;
}

/** A record-endpoint-only fake API: every POST answers the record the test gives it. */
function recordApi(record: Record<string, unknown>): TemplateApi {
  return {
    post: async (endpoint) => (endpoint.endsWith('/record') ? { ok: true, status: 200, body: { record } } : { ok: true, status: 200, body: { rows: [] } }),
  };
}

const click = async (mounted: { window: Window; flush(): Promise<void> }, el: Element | null) => {
  assert.ok(el, 'element to click must exist');
  el!.dispatchEvent(new (mounted.window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('click', { bubbles: true }));
  await mounted.flush();
};

test('a report with no print template offers no Print button', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'none');
  const { spec, report } = specWithTemplate(undefined);
  const mounted = await mountTemplateScreen(out, spec, { kind: 'report', report: report.name, row: '1' }, recordApi({ ROWID: '1', Title: 'Ada', Total: '10' }));
  assert.equal(mounted.container.querySelector('[data-print-record]'), null);
  await mounted.unmount();
});

test('a report with a print template offers a Print button that fills the sheet from the loaded record', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'fill');
  const template: PrintTemplateSpec = {
    name: 'Invoice1',
    label: 'Invoice',
    elements: [
      { type: 'text', html: '<p>Dear ${Title}</p>' },
      { type: 'field', field: 'Total', label: 'Total due' },
    ],
  };
  const { spec, report } = specWithTemplate(template);
  const mounted = await mountTemplateScreen(out, spec, { kind: 'report', report: report.name, row: '1' }, recordApi({ ROWID: '1', Title: 'Ada Lovelace', Total: '10.50' }));
  const button = mounted.container.querySelector('[data-print-record]');
  assert.ok(button, 'the record view offers a Print button');
  await click(mounted, button);
  const sheet = mounted.container.querySelector('[data-print-sheet]');
  assert.ok(sheet, 'the print sheet opens');
  assert.match(sheet!.textContent ?? '', /Dear Ada Lovelace/);
  assert.match(sheet!.textContent ?? '', /Total due/);
  assert.match(sheet!.textContent ?? '', /10\.50/);

  // The sheet's own Print action calls the page print dialog, not a server PDF.
  let printed = 0;
  (mounted.window as unknown as { print: () => void }).print = () => {
    printed++;
  };
  await click(mounted, mounted.container.querySelector('[data-print-now]'));
  assert.equal(printed, 1, 'the sheet\'s Print action calls window.print()');

  await click(mounted, mounted.container.querySelector('[data-print-close]'));
  assert.equal(mounted.container.querySelector('[data-print-sheet]'), null, 'Close removes the sheet');
  await mounted.unmount();
});

test('a print template element kind the parser does not know renders a visible placeholder, not a crash', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'unsupported');
  const template: PrintTemplateSpec = {
    name: 'Invoice1',
    label: 'Invoice',
    elements: [{ type: 'todo', note: 'Print element "chart" is not generated.' }],
  };
  const { spec, report } = specWithTemplate(template);
  const mounted = await mountTemplateScreen(out, spec, { kind: 'report', report: report.name, row: '1' }, recordApi({ ROWID: '1', Title: 'Ada', Total: '10' }));
  await click(mounted, mounted.container.querySelector('[data-print-record]'));
  const placeholder = mounted.container.querySelector('[data-print-todo]');
  assert.ok(placeholder, 'the unsupported element still draws something, not a blank gap');
  assert.match(placeholder!.textContent ?? '', /chart.*is not generated/);
  await mounted.unmount();
});

// A record value filled into a text element's placeholder is escaped, then
// checked by the same sanitizer the page already applies to every other
// snippet; it must never reach the DOM as live markup, a script-running
// attribute, or an unsafe URL.
const ATTACK_CASES: Array<{ label: string; html: string; row: Record<string, unknown>; assertSafe: (sheet: Element) => void }> = [
  {
    label: 'a javascript: URL in an href is refused',
    html: '<a href="${Url}">open</a>',
    row: { Url: 'javascript:alert(1)' },
    assertSafe: (sheet) => {
      const a = sheet.querySelector('a');
      assert.ok(a, 'the anchor itself still renders');
      assert.doesNotMatch(a!.getAttribute('href') ?? '', /javascript:/i);
    },
  },
  {
    label: 'a markup-bearing value is escaped text, not live markup',
    html: '<p>${Name}</p>',
    row: { Name: '<img src=x onerror=alert(1)>' },
    assertSafe: (sheet) => {
      assert.equal(sheet.querySelector('img'), null, 'no live <img> is injected by a record value');
      assert.match(sheet.textContent ?? '', /<img src=x onerror=alert\(1\)>/, 'the value prints as literal text');
    },
  },
  {
    label: 'a style value that calls url() loses the whole attribute, like any other page snippet',
    html: '<div style="width:80%;color:${Color}">x</div>',
    row: { Color: 'red; background: url(https://example.test/x)' },
    assertSafe: (sheet) => {
      // `text` elements go through the page's own snippet sanitizer
      // (pages/sanitize.ts), the same one ZML page snippets use: a style
      // attribute with any dangerous token is dropped whole, not declaration
      // by declaration (that finer-grained allowlist is for the native
      // field/lookup/image/spacer/columns styles — see printStyle below).
      const div = sheet.querySelector('[data-print-text] div');
      assert.equal(div?.getAttribute('style'), null);
    },
  },
  {
    label: 'an onerror attribute injected via an unquoted value is dropped',
    html: '<img src=${Url}>',
    row: { Url: 'x onerror=alert(1)' },
    assertSafe: (sheet) => {
      const img = sheet.querySelector('img');
      assert.ok(img, 'the sanitizer keeps the allowed img tag');
      assert.equal(img!.getAttribute('onerror'), null);
    },
  },
];

for (const { label, html, row, assertSafe } of ATTACK_CASES) {
  test(`print template text: ${label}`, { skip: SKIP }, async (t) => {
    const out = await compileOnly(t, 'attack');
    const template: PrintTemplateSpec = { name: 'Invoice1', label: 'Invoice', elements: [{ type: 'text', html }] };
    const { spec, report } = specWithTemplate(template);
    const mounted = await mountTemplateScreen(out, spec, { kind: 'report', report: report.name, row: '1' }, recordApi({ ROWID: '1', Title: 'Ada', Total: '10', ...row }));
    await click(mounted, mounted.container.querySelector('[data-print-record]'));
    const sheet = mounted.container.querySelector('[data-print-sheet]');
    assert.ok(sheet, 'the sheet opens');
    assertSafe(sheet!);
    await mounted.unmount();
  });
}

test('an image element with a javascript: source does not render', { skip: SKIP }, async (t) => {
  const out = await compileOnly(t, 'image-attack');
  const template: PrintTemplateSpec = {
    name: 'Invoice1',
    label: 'Invoice',
    elements: [{ type: 'image', field: 'Logo', alt: 'Logo' }],
  };
  const { spec, report } = specWithTemplate(template);
  const mounted = await mountTemplateScreen(out, spec, { kind: 'report', report: report.name, row: '1' }, recordApi({ ROWID: '1', Title: 'Ada', Total: '10', Logo: 'javascript:alert(1)' }));
  await click(mounted, mounted.container.querySelector('[data-print-record]'));
  const sheet = mounted.container.querySelector('[data-print-sheet]');
  assert.ok(sheet, 'the sheet opens');
  assert.equal(sheet!.querySelector('[data-print-image]'), null, 'an unsafe image source is refused outright');
  await mounted.unmount();
});
