import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { generateUi, type UiModel } from '../src/index.js';

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function field(name: string, type: string, extra = '', modifiers = ''): string {
  const head = modifiers ? `${modifiers} ${name}` : name;
  const lines = extra ? `\t\t\ttype = ${type}\n${extra}` : `\t\t\ttype = ${type}`;
  return `\t\t${head}\n\t\t(\n${lines}\n\t\t)`;
}

const BODY = `\tsection Main
\t{
\t\tform Customer
\t\t{
\t\t\tdisplayname = "Customer"
${field('Name', 'text', '', 'must have')}
${field('Email', 'email')}
${field('Qty', 'number')}
${field('About', 'textarea')}
\t\t}
\t\tlist All_Customers
\t\t{
\t\t\tshow all rows from Customer
\t\t\t(
\t\t\t\tName
\t\t\t\tEmail
\t\t\t\tQty
\t\t\t)
\t\t}
\t}`;

interface StyleRuntime {
  renderForm(form: UiModel['forms'][number]): string;
  renderReport(report: UiModel['reports'][number]): string;
  renderNav(model: UiModel): string;
  reportStateHtml(state: string, opts?: { formHref?: string }): string;
  submitNotice(result: { ok: boolean; dryRun: boolean; message?: string }): string;
  mailNoticeText(item: { status?: string; reason?: string; logged?: boolean }): string;
  showToast(doc: Document, kind: string, text: string): void;
}

async function loadRuntime(): Promise<StyleRuntime> {
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as StyleRuntime;
}

function cssOf(): string {
  const bundle = generateUi(appOf(BODY));
  const file = bundle.files.find((item) => item.path === 'slate/assets/app.css');
  assert.ok(file, 'generated slate css missing');
  return String(file.data);
}

function indexOf(): string {
  const bundle = generateUi(appOf(BODY));
  const file = bundle.files.find((item) => item.path === 'slate/index.html');
  assert.ok(file, 'generated slate index.html missing');
  return String(file.data);
}

test('base style: design tokens are CSS custom properties with one accent hook', () => {
  const css = cssOf();
  assert.match(css, /--c2c-accent\s*:/, 'missing --c2c-accent hook');
  assert.match(css, /--c2c-space-\d+\s*:/, 'missing spacing scale');
  assert.match(css, /--c2c-font-size-\w+\s*:/, 'missing type scale');
  assert.match(css, /--c2c-radius-\w+\s*:/, 'missing radius tokens');
  assert.match(css, /--c2c-shadow-\w+\s*:/, 'missing shadow tokens');
});

test('base style: the menu becomes a drawer below 768px', () => {
  const css = cssOf();
  assert.match(css, /@media\s*\(\s*max-width\s*:\s*768px\s*\)/, 'missing 768px drawer breakpoint');
});

test('base style: every form control pairs a label with its control', async () => {
  const runtime = await loadRuntime();
  const model = generateUi(appOf(BODY)).model;
  const form = model.forms[0];
  assert.ok(form);
  const dom = new JSDOM(`<!doctype html><body>${runtime.renderForm(form)}</body>`);
  const doc = dom.window.document as unknown as Document;
  const controls = Array.from(doc.querySelectorAll('input:not([type="hidden"]), select, textarea'));
  assert.ok(controls.length > 3, 'fixture form should render several controls');
  for (const control of controls) {
    const id = control.getAttribute('id');
    assert.ok(id, `control ${(control as HTMLInputElement).getAttribute('name')} has no id`);
    const label = doc.querySelector(`label[for="${id}"]`);
    assert.ok(label, `no label[for] pairs control #${id}`);
  }
  const required = Array.from(doc.querySelectorAll('[aria-required="true"]'));
  assert.ok(required.length >= 1, 'required controls need aria-required');
  const star = doc.querySelector('label')?.textContent ?? '';
  assert.match(star, /\*/, 'required marker * missing from a label');
});

test('base style: loading, empty, and error states render the expected copy', async () => {
  const runtime = await loadRuntime();
  const loading = runtime.reportStateHtml('loading');
  assert.match(loading, /Loading/, 'loading state copy');
  assert.match(loading, /skeleton/, 'loading skeleton');
  const empty = runtime.reportStateHtml('empty', { formHref: '#/form/Customer' });
  assert.match(empty, /no records/i, 'empty state copy');
  assert.match(empty, /href="#\/form\/Customer"/, 'empty state primary action links to the form');
  const error = runtime.reportStateHtml('error');
  assert.match(error, /Retry/, 'error state retry');
  assert.match(error, /data-retry/, 'retry control hook');
});

test('base style: success and failure toasts use user-facing wording', async () => {
  const runtime = await loadRuntime();
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const dom = new JSDOM('<!doctype html><body><div id="toasts"></div></body>');
  const doc = dom.window.document as unknown as Document;
  runtime.showToast(doc, 'success', runtime.submitNotice({ ok: true, dryRun: false }));
  runtime.showToast(doc, 'failure', runtime.submitNotice({ ok: false, dryRun: false }));
  const toasts = Array.from(doc.querySelectorAll('#toasts [data-kind]'));
  assert.equal(toasts.length, 2);
  assert.equal(toasts[0].getAttribute('data-kind'), 'success');
  assert.equal(toasts[1].getAttribute('data-kind'), 'failure');
});

test('base style: mail outcome note formats as a user-facing non-blocking notice', async () => {
  const runtime = await loadRuntime();
  assert.equal(runtime.mailNoticeText({ status: 'refused', reason: 'recipient not allowlisted' }), 'Mail refused: recipient not allowlisted');
  assert.equal(runtime.mailNoticeText({ status: 'refused', reason: 'recipient not allowlisted', logged: false }), 'Mail refused: recipient not allowlisted (delivery log failed)');
  assert.equal(runtime.mailNoticeText({ status: 'sent', reason: 'accepted by Catalyst Mail' }), 'Mail sent: accepted by Catalyst Mail');
  assert.equal(runtime.mailNoticeText({ status: 'skipped', reason: 'mail disabled' }), 'Mail skipped: mail disabled');
  assert.equal(runtime.mailNoticeText({ status: 'skipped', reason: 'mail disabled', logged: false }), 'Mail skipped: mail disabled');
});

test('base style: no preview copy reaches the page on a live deploy', async () => {
  const runtime = await loadRuntime();
  for (const notice of [
    runtime.submitNotice({ ok: true, dryRun: false }),
    runtime.submitNotice({ ok: false, dryRun: false }),
    runtime.reportStateHtml('empty', { formHref: '#/form/Customer' }),
    runtime.reportStateHtml('error'),
    runtime.renderReport(generateUi(appOf(BODY)).model.reports[0]),
  ]) {
    assert.doesNotMatch(notice, /dry-?run|preview/i, `live copy leaks preview wording: ${notice.slice(0, 80)}`);
  }
  assert.match(
    runtime.submitNotice({ ok: true, dryRun: true }),
    /preview/i,
    'dry-run submit should say nothing was saved yet',
  );
});

test('base style: report tables carry sticky headers, zebra, numeric alignment, and pages', async () => {
  const runtime = await loadRuntime();
  const model = generateUi(appOf(BODY)).model;
  const html = runtime.renderReport(model.reports[0]);
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const doc = dom.window.document as unknown as Document;
  assert.ok(doc.querySelector('table thead th[scope="col"]'), 'header cells need scope="col"');
  assert.ok(doc.querySelector('th[data-numeric], td[data-numeric]') ?? html.includes('data-numeric'), 'number column is not marked numeric');
  const css = cssOf();
  assert.match(css, /position\s*:\s*sticky/, 'sticky header rule missing');
  assert.match(css, /nth-child\(even\)/, 'zebra rule missing');
  assert.ok(doc.querySelector('[data-pages] [data-prev]'), 'pagination previous control missing');
  assert.ok(doc.querySelector('[data-pages] [data-next]'), 'pagination next control missing');
});

test('base style: the shell has a top bar, collapsible menu, card, and toast region', async () => {
  const runtime = await loadRuntime();
  const model = generateUi(appOf(BODY)).model;
  const index = indexOf();
  assert.match(index, /id="menu-toggle"/, 'menu drawer toggle missing');
  assert.match(index, /id="toasts"/, 'toast live region missing');
  assert.match(index, /skip/i, 'skip link missing');
  const nav = runtime.renderNav(model);
  assert.match(nav, /<details/, 'menu sections are not collapsible');
  assert.match(nav, /<summary/, 'menu section toggle missing');
  const formHtml = runtime.renderForm(model.forms[0]);
  assert.match(formHtml, /data-layout="(one|two|three)"/, 'form grid layout hook missing');
});

test('base style: menu section titles stack above their entries and page columns sit in a row', () => {
  const css = cssOf();
  assert.match(css, /#nav \.navsec>summary,#nav summary/, 'section titles need their own line');
  assert.match(css, /#nav \.navitem,#nav a,#nav span\{display:flex/, 'menu entries need their own line');
  assert.match(css, /\[data-zml="row"\]\{display:flex/, 'page columns need a row');
});

test('base style: report search stacks a full-width input above a full-width button', () => {
  const css = cssOf();
  assert.match(css, /\[data-report-search\]\{display:block/, 'the search form is a block, not an inline row');
  assert.match(css, /\[data-report-search\] input\{[^}]*width:100%/, 'the search input spans the card');
  assert.match(css, /\[data-report-search\] button\{[^}]*width:100%/, 'the search button spans the card');
  assert.match(css, /\.report-tools \[data-report-search\]\{[^}]*width:100%/, 'the search stacks above the other tools');
});

test('base style: Creator density - regular labels, compact controls, white card on grey page', () => {
  const css = cssOf();
  assert.match(css, /--c2c-input-height:2rem/, 'controls are Creator-compact 32px');
  assert.match(css, /\.field>label,\.field-title,\.field legend\{font-weight:400/, 'field labels are regular weight');
  assert.match(css, /--c2c-bg:#f4f7f8/, 'the page sits on light grey');
  assert.match(css, /--c2c-surface:#ffffff/, 'forms sit on a white surface');
  assert.match(css, /\.subform \[data-add-row\]\{[^}]*border:0[^}]*color:var\(--c2c-accent\)/, 'Add New is a link, not a bordered button');
});
