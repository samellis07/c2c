import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  recordSummaryHtml,
  renderMailTemplate,
  renderPrintTemplate,
  sanitizePrintHtml,
  type PrintTemplateCatalog,
} from '../src/print-template.js';

const catalog: PrintTemplateCatalog = {
  Invoice_Form: {
    Invoice: {
      name: 'Invoice',
      label: 'Invoice',
      elements: [
        { type: 'text', html: '<h2>Invoice ${Number}</h2>' },
        { type: 'field', field: 'Customer', label: 'Customer' },
      ],
    },
  },
};

test('sanitizePrintHtml keeps allowlisted markup and refuses scripts, handlers and unsafe URLs', () => {
  assert.equal(sanitizePrintHtml('<b>hi</b><script>alert(1)</script>'), '<b>hi</b>');
  assert.equal(sanitizePrintHtml('<a href="javascript:x" onclick="y">x</a>'), '<a>x</a>');
  assert.equal(sanitizePrintHtml('<a href="/p">x</a>'), '<a href="/p" rel="noopener noreferrer">x</a>');
  assert.equal(sanitizePrintHtml('<span style="color:red;behavior:x">s</span>'), '<span style="color:red" data-style-dropped="behavior">s</span>');
  // An unlisted tag unwraps; its text survives.
  assert.equal(sanitizePrintHtml('<marquee>m</marquee>'), 'm');
});

test('renderPrintTemplate fills placeholders and escapes record values', () => {
  const html = renderMailTemplate(catalog, {
    kind: 'template',
    name: 'Invoice',
    form: 'Invoice_Form',
    record: { Number: 'INV-1', Customer: '<script>alert(1)</script>' },
    format: 'inline',
    rendered: 'inline',
  });
  assert.ok(html);
  assert.match(html, /<h2>Invoice INV-1<\/h2>/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(html.includes('<script>'), false);
});

test('renderMailTemplate resolves a template by name when the descriptor has no form', () => {
  const html = renderMailTemplate(catalog, { kind: 'template', name: 'Invoice', form: null, record: { Number: 'N', Customer: 'C' } });
  assert.ok(html?.includes('data-print-page'));
});

test('renderMailTemplate returns null for an unknown layout so the refusal stays', () => {
  assert.equal(renderMailTemplate(catalog, { kind: 'template', name: 'Missing', form: null, record: {} }), null);
  assert.equal(renderMailTemplate(null, { kind: 'template', name: 'Invoice', form: null, record: {} }), null);
});

test('_default renders a record summary; hostile values are escaped', () => {
  const html = recordSummaryHtml({ Name: '<img src=x onerror=alert(1)>', Qty: 3, Skip: null });
  assert.match(html, /data-print-summary/);
  assert.match(html, /&lt;img/);
  assert.match(html, />3</);
  assert.equal(html.includes('Skip'), false);
  assert.equal(renderMailTemplate({}, { kind: 'template', name: '_default', record: { A: 1 } }), recordSummaryHtml({ A: 1 }));
});
