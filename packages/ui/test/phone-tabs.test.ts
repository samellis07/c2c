import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { generateUi, type UiModel } from '../src/index.js';

function appOf(body: string): App {
  return deriveIr(parse(`application "Phone Demo"\n{\n${body}\n}\n`));
}

function field(name: string, type: string): string {
  return `\t\t${name}\n\t\t(\n\t\t\ttype = ${type}\n\t\t)`;
}

function form(name: string, label: string): string {
  return `\t\tform ${name}\n\t\t{\n\t\t\tdisplayname = "${label}"\n${field('Title', 'text')}\n${field('Notes', 'textarea')}\n\t\t}`;
}

function list(name: string, from: string): string {
  return `\t\tlist ${name}\n\t\t{\n\t\t\tshow all rows from ${from}\n\t\t\t(\n\t\t\t\tTitle\n\t\t\t\tNotes\n\t\t\t)\n\t\t}`;
}

// Six entries across two sections: the first four become tabs,
// the remaining two belong behind More.
const BODY = `\tsection Sales
\t{
${form('Order', 'Order')}
${form('Quote', 'Quote')}
${list('All_Orders', 'Order')}
${list('All_Quotes', 'Quote')}
\t}
\tsection Stock
\t{
${form('Part', 'Part')}
${list('All_Parts', 'Part')}
\t}`;

const SMALL = `\tsection Sales
\t{
${form('Order', 'Order')}
${form('Quote', 'Quote')}
${list('All_Orders', 'Order')}
\t}`;

interface NavItem {
  kind: string;
  name: string;
  label: string;
  href: string;
}

interface PhoneRuntime {
  splitPhoneTabs(model: UiModel): {
    tabs: NavItem[];
    moreSections: { name: string; items: NavItem[] }[];
    moreCount: number;
  };
  renderTabbar(model: UiModel): string;
  renderMoreSheet(model: UiModel): string;
  markPhoneCurrent(doc: Document, hash: string): void;
  setCurrent(root: Element | Document, hash: string): boolean;
  renderReportRows(report: UiModel['reports'][number], rows: Record<string, unknown>[]): string;
  renderForm(form: UiModel['forms'][number]): string;
  boot(model: UiModel, doc: Document): void;
}

async function loadRuntime(): Promise<PhoneRuntime> {
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as PhoneRuntime;
}

function cssOf(): string {
  const bundle = generateUi(appOf(BODY));
  const file = bundle.files.find((item) => item.path === 'slate/assets/app.css');
  assert.ok(file, 'generated slate css missing');
  return String(file.data);
}

function phoneBlock(): string {
  const css = cssOf();
  const start = css.indexOf('@media (max-width:768px)');
  assert.ok(start >= 0, 'missing 768px phone breakpoint');
  return css.slice(start);
}

function tabDoc(html: string): Document {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  return dom.window.document as unknown as Document;
}

function phoneDoc(tabbarHtml: string, sheetHtml: string): Document {
  const dom = new JSDOM(
    `<!doctype html><body><nav id="tabbar" aria-label="Primary">${tabbarHtml}</nav><div id="more-sheet" hidden>${sheetHtml}</div></body>`,
  );
  return dom.window.document as unknown as Document;
}

test('phone tabs: the bottom bar holds the first four entries plus one More', async () => {
  const runtime = await loadRuntime();
  const model = generateUi(appOf(BODY)).model;
  const split = runtime.splitPhoneTabs(model);
  assert.equal(split.tabs.length, 4);
  assert.equal(split.moreCount, 2);
  const doc = phoneDoc(runtime.renderTabbar(model), runtime.renderMoreSheet(model));
  const tabs = Array.from(doc.querySelectorAll('#tabbar [data-tab]'));
  const more = doc.querySelector('#tabbar [data-more]');
  assert.equal(tabs.length, 4);
  assert.ok(more, 'More tab missing');
  assert.ok(tabs.length + 1 <= 5, 'bottom bar exceeds five entries');
});

test('phone tabs: More lists the remaining sections and items', async () => {
  const runtime = await loadRuntime();
  const model = generateUi(appOf(BODY)).model;
  const split = runtime.splitPhoneTabs(model);
  const tabbed = new Set(split.tabs.map((item) => item.name));
  const sheet = phoneDoc(runtime.renderTabbar(model), runtime.renderMoreSheet(model));
  const section = sheet.querySelector('[data-more-section]');
  assert.ok(section, 'More sheet has no section grouping');
  assert.equal(section?.getAttribute('data-more-section'), 'Stock');
  const links = Array.from(sheet.querySelectorAll('#more-sheet a[href]')).map((link) =>
    link.getAttribute('href'),
  );
  assert.equal(links.length, 2);
  for (const item of split.moreSections.flatMap((entry) => entry.items)) {
    assert.ok(!tabbed.has(item.name), `${item.name} is both tabbed and behind More`);
    assert.ok(links.includes(item.href), `${item.name} is missing behind More`);
  }
});

test('phone tabs: four or fewer entries need no More', async () => {
  const runtime = await loadRuntime();
  const model = generateUi(appOf(SMALL)).model;
  const split = runtime.splitPhoneTabs(model);
  assert.equal(split.moreCount, 0);
  const doc = phoneDoc(runtime.renderTabbar(model), runtime.renderMoreSheet(model));
  assert.equal(doc.querySelector('#tabbar [data-more]'), null);
  assert.equal(runtime.renderMoreSheet(model), '');
});

test('phone tabs: labels truncate while the full name stays exposed', async () => {
  const runtime = await loadRuntime();
  const model = generateUi(appOf(BODY)).model;
  const doc = phoneDoc(runtime.renderTabbar(model), runtime.renderMoreSheet(model));
  const tabs = Array.from(doc.querySelectorAll('#tabbar [data-tab]'));
  assert.ok(tabs.length > 0);
  for (const tab of tabs) {
    const label = tab.querySelector('.tab-label')?.textContent ?? '';
    assert.ok(label.length > 0, 'tab has no short label');
    assert.equal(tab.getAttribute('aria-label'), label);
    assert.equal(tab.getAttribute('title'), label);
    assert.ok(tab.querySelector('svg[aria-hidden="true"]'), 'tab has no icon');
  }
  const css = cssOf();
  assert.match(css, /\.tab-label[^{]*\{[^}]*text-overflow\s*:\s*ellipsis/, 'tab label truncation missing');
});

test('phone tabs: the active tab carries aria-current', async () => {
  const runtime = await loadRuntime();
  const model = generateUi(appOf(BODY)).model;
  const split = runtime.splitPhoneTabs(model);
  const current = split.tabs[1];
  assert.ok(current);
  const doc = phoneDoc(runtime.renderTabbar(model), runtime.renderMoreSheet(model));
  runtime.markPhoneCurrent(doc, current.href);
  const active = doc.querySelector(`#tabbar [href="${current.href}"]`);
  assert.equal(active?.getAttribute('aria-current'), 'page');
  for (const tab of doc.querySelectorAll('#tabbar [data-tab]')) {
    if (tab.getAttribute('href') !== current.href) assert.equal(tab.getAttribute('aria-current'), null);
  }
  const leftover = split.moreSections.flatMap((entry) => entry.items)[0];
  assert.ok(leftover);
  runtime.markPhoneCurrent(doc, leftover.href);
  assert.equal(doc.querySelector('#tabbar [data-more]')?.getAttribute('aria-current'), 'page');
});

test('phone tabs: no bottom bar reaches desktop widths and the drawer is gone', () => {
  const css = cssOf();
  assert.match(css, /#tabbar\s*\{\s*display\s*:\s*none/, 'bottom bar is not hidden on desktop');
  const phone = phoneBlock();
  assert.match(phone, /#tabbar/, 'bottom bar never appears on phones');
  assert.match(phone, /position\s*:\s*fixed/, 'bottom bar is not fixed');
  assert.doesNotMatch(css, /data-open/, 'slide-out drawer hook is still styled');
});

test('phone forms: fields stack full-width in model order with the same labels', async () => {
  const runtime = await loadRuntime();
  const model = generateUi(appOf(BODY)).model;
  const form = model.forms[0];
  assert.ok(form);
  const doc = tabDoc(runtime.renderForm(form));
  const labels = Array.from(doc.querySelectorAll('.field > label, .field legend')).map((node) =>
    (node.textContent ?? '').replace(/\*.*$/, '').trim(),
  );
  assert.deepEqual(labels, form.fields.map((item) => item.label));
  const phone = phoneBlock();
  assert.doesNotMatch(phone, /1fr 1fr/, 'two-column form grid reaches phones');
});

test('phone reports: rows carry header labels with the first column as the card title', async () => {
  const runtime = await loadRuntime();
  const model = generateUi(appOf(BODY)).model;
  const report = model.reports[0];
  assert.ok(report);
  const rows = runtime.renderReportRows(report, [{ ROWID: '7', Title: 'First', Notes: 'Extra' }]);
  const doc = tabDoc(`<table><tbody>${rows}</tbody></table>`);
  // The row-ops cell is not a data cell: it carries no field label.
  const cells = Array.from(doc.querySelectorAll('td[data-th]'));
  assert.equal(cells.length, 2);
  assert.equal(cells[0].getAttribute('data-primary'), 'true');
  assert.equal(cells[0].getAttribute('data-th'), report.columns[0].label || report.columns[0].field);
  assert.equal(cells[1].getAttribute('data-th'), report.columns[1].label || report.columns[1].field);
  const phone = phoneBlock();
  assert.match(phone, /thead/, 'report header is not hidden on phones');
  assert.match(phone, /attr\(data-th\)/, 'card fields show no header label');
  assert.match(phone, /nth-child\(n\+5\)/, 'card field cap is missing');
});

test('phone shell: boot paints the tab bar and keeps the More sheet closed', async () => {
  const runtime = await loadRuntime();
  const model = generateUi(appOf(BODY)).model;
  const dom = new JSDOM(
    '<!doctype html><body><nav id="nav"></nav><main id="main"></main><nav id="tabbar"></nav><div id="more-sheet" hidden></div></body>',
    { url: 'http://localhost/slate/index.html' },
  );
  const doc = dom.window.document as unknown as Document;
  runtime.boot(model, doc);
  assert.equal(doc.querySelectorAll('#tabbar [data-tab]').length, 4);
  assert.ok(doc.querySelector('#tabbar [data-more]'), 'More tab missing after boot');
  assert.equal((doc.getElementById('more-sheet') as unknown as { hidden: boolean }).hidden, true);
});

test('phone shell: the generated page mounts the tab bar and the More sheet', () => {
  const bundle = generateUi(appOf(BODY));
  const file = bundle.files.find((item) => item.path === 'slate/index.html');
  assert.ok(file, 'generated slate index.html missing');
  const index = String(file.data);
  assert.match(index, /id="tabbar"/, 'tab bar mount missing');
  assert.match(index, /id="more-sheet"/, 'More sheet mount missing');
});
