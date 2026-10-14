import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { BASE_CSS } from '../src/styles.js';
import { buildUi, type UiModel } from '../src/index.js';

// A form's `print template { <Name> { content = {...} } }` block holds a layout
// the report selects with `print template = <Name>`. The generated record view
// carries a print sheet built from that layout, rendered with the record's
// values in the template's element order. Printing is the reader's own print
// dialog (Save as PDF); no server-side PDF.

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function field(name: string, type: string, extra = ''): string {
  return `\t\t${name}\n\t\t(\n\t\t\ttype = ${type}${extra ? `\n${extra}` : ''}\n\t\t)`;
}

const TEMPLATE_CONTENT = JSON.stringify({
  version: '2',
  templateStyle: 'text-align: left; width: 100%; margin: 0 auto',
  themeFont: 'lato',
  mainLayout: [
    {
      id: 1,
      elements: [
        { type: 'text', element: { id: 'e1', content: '<div><p>${Name}</p></div>' } },
        { type: 'fields', element: { Label_Name: 'Email', labelText: 'Email', labelStyle: 'width: 50%', valueStyle: 'width: 50%' } },
        {
          type: 'columns',
          element: {
            split: '50,50',
            id: 'c1',
            collayouts: [
              { colElements: [{ type: 'fields', element: { Label_Name: 'Phone', labelText: 'Phone' } }] },
              { colElements: [{ type: 'text', element: { id: 'e2', content: '<div>${Notes}</div>' } }] },
            ],
          },
        },
        { type: 'lookupfields', element: { Label_Name: 'Line_Items', labelText: 'Items', refFields: [
          { Label_Name: 'Item', labelText: 'Item' },
          { Label_Name: 'Qty', labelText: 'Qty' },
        ] } },
      ],
    },
  ],
});

const FORM = `\tform Contact
\t{
${field('Name', 'text')}
${field('Email', 'email')}
${field('Phone', 'phone')}
${field('Notes', 'text')}
${field('Line_Items', 'subform', '\t\t\tvalues = Line_Item')}
\t\tprint template
\t\t{
\t\t\tCard
\t\t\t{
\t\t\t\tdisplayname = "Contact Card"
\t\t\t\tcontent = ${TEMPLATE_CONTENT}
\t\t\t}
\t\t}
\t}`;

const REPORT = `\tlist All_Contacts
\t{
\t\tdisplayName = "All Contacts"
\t\tprint template = Card
\t\tshow all rows from Contact
\t\t(
\t\t\tName
\t\t\tEmail
\t\t)
\t}`;

const NO_TEMPLATE_REPORT = `\tlist Plain_List
\t{
\t\tshow all rows from Contact
\t\t(
\t\t\tName
\t\t)
\t}`;

function modelOf(...bodies: string[]): UiModel {
  return buildUi(appOf(bodies.join('\n'))).model;
}

test('a report `print template` property resolves the named layout on its form', () => {
  const model = modelOf(FORM, REPORT, NO_TEMPLATE_REPORT);
  const report = model.reports.find((item) => item.name === 'All_Contacts');
  assert.ok(report?.printTemplate, 'printTemplate is on the report model');
  assert.equal(report.printTemplate?.name, 'Card');
  assert.equal(report.printTemplate?.label, 'Contact Card');
  const plain = model.reports.find((item) => item.name === 'Plain_List');
  assert.equal(plain?.printTemplate, undefined);
});

test('the resolved template keeps the layout element order', () => {
  const model = modelOf(FORM, REPORT);
  const template = model.reports.find((item) => item.name === 'All_Contacts')?.printTemplate;
  assert.ok(template);
  const types = template.elements.map((el) => el.type);
  assert.deepEqual(types, ['text', 'field', 'columns', 'lookup']);
  const columns = template.elements[2];
  assert.equal(columns.type, 'columns');
  assert.equal(columns.split, '50,50');
  assert.equal(columns.columns?.length, 2);
  assert.equal(columns.columns?.[0]?.[0]?.type, 'field');
  assert.equal(columns.columns?.[0]?.[0]?.field, 'Phone');
  assert.equal(columns.columns?.[1]?.[0]?.type, 'text');
  const lookup = template.elements[3];
  assert.equal(lookup.field, 'Line_Items');
  assert.deepEqual(
    lookup.fields?.map((f) => f.field),
    ['Item', 'Qty'],
  );
});

test('a template naming no layout on the form is a model todo, not a crash', () => {
  const missing = `\tlist Ghost
\t{
\t\tprint template = Not_There
\t\tshow all rows from Contact
\t\t(
\t\t\tName
\t\t)
\t}`;
  const model = modelOf(FORM, missing);
  const report = model.reports.find((item) => item.name === 'Ghost');
  assert.equal(report?.printTemplate, undefined);
  assert.ok(model.todos.some((todo) => todo.area === 'report' && todo.name === 'Ghost'));
});

interface PrintRuntime {
  printSheetHtml(template: unknown, row: Record<string, unknown>, doc: Document): string;
  installReportViews(model: UiModel, doc: Document): void;
  installPrint(model: UiModel, doc: Document): void;
  boot(model: UiModel, doc: Document): void;
}

async function loadPrintRuntime(): Promise<PrintRuntime> {
  const base = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  const views = readFileSync(join(process.cwd(), 'packages/ui/src/client/50-report-views.js'), 'utf8');
  const print = readFileSync(join(process.cwd(), 'packages/ui/src/client/70-print.js'), 'utf8');
  const source = `${base}\n${views}\n${print}\n`;
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as PrintRuntime;
}

test('the print sheet renders the record fields in template order', async () => {
  const model = modelOf(FORM, REPORT);
  const template = model.reports.find((item) => item.name === 'All_Contacts')?.printTemplate;
  assert.ok(template);
  const runtime = await loadPrintRuntime();
  const doc = new JSDOM('<!doctype html><body></body>').window.document as unknown as Document;
  const row = {
    ROWID: '7',
    Name: 'Ada Lovelace',
    Email: 'ada@example.test',
    Phone: '555-0100',
    Notes: 'first programmer',
    Line_Items: [
      { Item: 'Gears', Qty: '2' },
      { Item: 'Springs', Qty: '5' },
    ],
  };
  const html = runtime.printSheetHtml(template, row, doc);
  const order = ['Ada Lovelace', 'ada@example.test', '555-0100', 'first programmer', 'Gears'];
  let at = -1;
  for (const text of order) {
    const found = html.indexOf(text);
    assert.ok(found > at, `${text} must appear after the previous field (index ${found} <= ${at})`);
    at = found;
  }
  // Values are escaped for HTML.
  const escaped = runtime.printSheetHtml(template, { ...row, Name: '<img src=x>' }, doc);
  assert.doesNotMatch(escaped, /<img src=x>/);
  assert.match(escaped, /&lt;img src=x&gt;/);
});

test('the record view shows a Print button and the sheet fills from the record', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const runtime = await loadPrintRuntime();
  const model = modelOf(FORM, REPORT);
  const rows = [{ ROWID: '7', Name: 'Ada Lovelace', Email: 'ada@example.test' }];
  const win = new JSDOM('<!doctype html><body><nav id="nav"></nav><main id="main"></main></body>', {
    url: 'http://localhost/slate/index.html#/report/All_Contacts/row/7',
  }).window as unknown as { document: Document; fetch: typeof fetch; print?: () => void };
  let printed = 0;
  win.print = () => {
    printed++;
  };
  win.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (body.op === 'query') return { ok: true, status: 200, json: async () => ({ rows }) };
    if (body.ROWID) return { ok: true, status: 200, json: async () => ({ record: rows[0] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
  runtime.installReportViews(model, win.document);
  await runtime.boot(model, win.document);
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const doc = win.document;
  const button = doc.querySelector('[data-print-record]');
  assert.ok(button, 'the record view offers a Print button');
  (button as HTMLElement).dispatchEvent(new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('click', { bubbles: true }));
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const sheet = doc.querySelector('[data-print-sheet]');
  assert.ok(sheet, 'the print sheet opens');
  assert.match(sheet?.textContent ?? '', /Ada Lovelace/);
  assert.match(sheet?.textContent ?? '', /ada@example.test/);
  const printNow = doc.querySelector('[data-print-now]');
  assert.ok(printNow, 'the sheet offers the print/PDF action');
  (printNow as HTMLElement).dispatchEvent(new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('click', { bubbles: true }));
  assert.equal(printed, 1, 'the print action calls the page print dialog');
});

test('the stylesheet prints only the sheet', () => {
  assert.match(BASE_CSS, /@media print/);
  assert.match(BASE_CSS, /\[data-print-bar\]\{[^}]*display:\s*none/);
});

// A record value filled into a text element's attribute goes through the same
// URL and style checks as the template's own markup.
const URL_ATTRS = ['href', 'src', 'srcset', 'xlink:href', 'formaction', 'action', 'poster', 'background'];

function attrProblems(html: string): string[] {
  const doc = new JSDOM(`<!doctype html><body>${html}</body>`).window.document as unknown as Document;
  const problems: string[] = [];
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const flat = attr.value.replace(/[\u0000- ]+/g, '').toLowerCase();
      if (name.startsWith('on')) problems.push(`${el.tagName} ${name}`);
      if (URL_ATTRS.includes(name) && /(^|,)(javascript|vbscript|data):/.test(flat)) problems.push(`${el.tagName} ${name}=${attr.value}`);
      if (name === 'style' && /url\(|expression\(|javascript:|vbscript:|@import|image-set|cross-fade|behavior|\\|\/\*/.test(flat)) {
        problems.push(`${el.tagName} style=${attr.value}`);
      }
    }
  }
  return problems;
}

async function sheetOf(html: string, row: Record<string, unknown>): Promise<string> {
  const runtime = await loadPrintRuntime();
  const doc = new JSDOM('<!doctype html><body></body>').window.document as unknown as Document;
  return runtime.printSheetHtml({ elements: [{ type: 'text', html }] }, row, doc);
}

const ATTRIBUTE_CASES: Array<[string, string, string]> = [
  ['href javascript:', '<a href="${Url}">open</a>', 'javascript:alert(1)'],
  ['href vbscript:', '<a href="${Url}">open</a>', 'vbscript:msgbox(1)'],
  ['href data:text/html', '<a href="${Url}">open</a>', 'data:text/html,<script>alert(1)</script>'],
  ['href upper-case JaVaScRiPt:', '<a href="${Url}">open</a>', 'JaVaScRiPt:alert(1)'],
  ['href with control characters', '<a href="${Url}">open</a>', ' java\tscr\nipt:alert(1)'],
  ['href entity-encoded', '<a href="${Url}">open</a>', '&#106;avascript:alert(1)'],
  ['src javascript:', '<img src="${Url}">', 'javascript:alert(1)'],
  ['src data:', '<img src="${Url}">', 'data:image/svg+xml,<svg onload=alert(1)>'],
  ['srcset javascript:', '<img srcset="${Url} 1x">', 'javascript:alert(1)'],
  ['style url()', '<div style="color:${Url}">x</div>', 'red;background:url(https://example.test/x)'],
  ['style expression()', '<div style="width:${Url}">x</div>', 'expression(alert(1))'],
  ['quote closes the attribute', '<img src="${Url}">', 'x" onerror="alert(1)'],
  ['unquoted attribute gains onerror', '<img src=${Url}>', 'x onerror=alert(1)'],
  ['unquoted attribute gains a style', '<a href=${Url}>open</a>', 'https://ok.test style=background:url(//example.test/x)'],
  ['style url() split by a CSS escape', '<div style="background:${Url}">x</div>', 'u\\72 l(//example.test/x)'],
  ['style url() in long CSS escapes', '<div style="background:${Url}">x</div>', '\\75\\72\\6c(//example.test/x)'],
  ['style url() with mixed-case CSS escape', '<div style="background:${Url}">x</div>', 'uR\\4c(//example.test/x)'],
  ['style url() split by a comment', '<div style="background:${Url}">x</div>', 'u/**/rl(//example.test/x)'],
  ['style image-set string URL', '<div style="background:${Url}">x</div>', 'image-set("https://example.test/x" 1x)'],
  ['style -webkit-image-set string URL', '<div style="background:${Url}">x</div>', '-webkit-image-set("https://example.test/x" 1x)'],
  ['style url() escape in a second declaration', '<div style="background:${Url}">x</div>', 'red;content:attr(data-x);background:u\\72 l(//example.test/?)'],
  ['style @import', '<div style="x:${Url}">x</div>', '1px;@import "//example.test/x"'],
  ['style behavior fetch', '<div style="${Url}:red">x</div>', 'behavior'],
];

for (const [label, html, value] of ATTRIBUTE_CASES) {
  test(`a record value in a template attribute is checked: ${label}`, async () => {
    const out = await sheetOf(html, { Url: value });
    assert.deepEqual(attrProblems(out), [], out);
  });
}

test('a safe record value in a template attribute is kept', async () => {
  const link = await sheetOf('<a href="${Url}">open</a>', { Url: 'https://example.test/a?b=1&c=2' });
  const doc = new JSDOM(`<!doctype html><body>${link}</body>`).window.document;
  assert.equal(doc.querySelector('a')?.getAttribute('href'), 'https://example.test/a?b=1&c=2');
  const styled = await sheetOf('<div style="color:${C}">x</div>', { C: 'red' });
  assert.match(styled, /style="color:\s*red;?"/);
  const weighted = await sheetOf('<div style="font-weight:${W}">x</div>', { W: '700' });
  assert.match(weighted, /style="font-weight:\s*700;?"/);
  const text = await sheetOf('<p>${Name}</p>', { Name: '<b>${Other}</b>', Other: 'leak' });
  assert.match(text, /&lt;b&gt;\$\{Other\}&lt;\/b&gt;/);
});

test('a record value in a style keeps the safe declarations and names the dropped one', async () => {
  const sheet = await sheetOf('<div style="width: 80%; color:${C}">x</div>', { C: 'rgb(1, 2, 3); background: url(//example.test/x)' });
  assert.match(sheet, /style="width: 80%; color:rgb\(1, 2, 3\)" data-style-dropped="background"/);
  assert.deepEqual(attrProblems(sheet), []);
});

test('a template style that loses a declaration is listed as a TODO and named on the sheet', async () => {
  const clean = modelOf(FORM, REPORT);
  assert.equal(clean.todos.some((item) => /Inline style/.test(item.reason)), false, 'a clean template lists nothing');
  const unsafe = FORM.replace('"valueStyle":"width: 50%"', '"valueStyle":"width: 50%; background: url(//example.test/x)"');
  assert.notEqual(unsafe, FORM);
  const model = modelOf(unsafe, REPORT);
  const todo = model.todos.find((item) => item.area === 'report' && item.name === 'All_Contacts');
  assert.ok(todo, JSON.stringify(model.todos));
  assert.match(todo.reason, /Print template "Card": Inline style declarations not carried over.*: background$/);
  const runtime = await loadPrintRuntime();
  const doc = new JSDOM('<!doctype html><body></body>').window.document as unknown as Document;
  const template = model.reports.find((item) => item.name === 'All_Contacts')?.printTemplate;
  assert.ok(template);
  const sheet = runtime.printSheetHtml(template, { Name: 'Ada' }, doc);
  assert.match(sheet, /style="width: 50%" data-style-dropped="background"/);
});

test('a print template style with inline comments preserves safe declarations and drops no TODO', async () => {
  const withComment = FORM.replace(
    '"valueStyle":"width: 50%"',
    '"valueStyle":"height:35px;/* border:1px solid #ededed; */"',
  );
  assert.notEqual(withComment, FORM);
  const model = modelOf(withComment, REPORT);
  assert.equal(
    model.todos.some((item) => /Print template/.test(item.reason)),
    false,
    'commented style declaration in print template does not create a TODO',
  );
  const runtime = await loadPrintRuntime();
  const doc = new JSDOM('<!doctype html><body></body>').window.document as unknown as Document;
  const template = model.reports.find((item) => item.name === 'All_Contacts')?.printTemplate;
  assert.ok(template);
  const sheet = runtime.printSheetHtml(template, { Name: 'Ada' }, doc);
  assert.match(sheet, /style="height:\s*35px;?"/);
  assert.doesNotMatch(sheet, /data-style-dropped/);
});
