/**
 * Golden for the Invoice example (fixtures/synthetic/invoice/invoice.ds,
 * docs/print-templates.md): pins the print template the React app spec
 * resolves for its report, and proves the generated app actually draws it —
 * header, customer, line items and total — from a loaded record.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { compileTemplateLib, mountTemplateScreen, reactAppSpec, templateRuntimeReady, TEMPLATE_MISSING, type TemplateApi } from '../src/index.js';
import type { AppSpec } from '../template/lib/c2c-ui/types.js';

const FIXTURE = join(repoRoot(), 'fixtures/synthetic/invoice/invoice.ds');
const GOLDEN = join(repoRoot(), 'tests/golden/print-templates/invoice-print-template.json');

function invoiceSpec(): AppSpec {
  const app = deriveIr(parse(readFileSync(FIXTURE, 'utf8')));
  return reactAppSpec(app);
}

test('the Invoice example resolves its print template deterministically and matches the pinned golden', () => {
  const first = invoiceSpec().reports.Invoices?.printTemplate;
  const second = invoiceSpec().reports.Invoices?.printTemplate;
  assert.ok(first, 'the Invoice report resolves a print template');
  assert.deepEqual(second, first, 'two independent generations must agree');
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(
    first,
    golden,
    `the resolved print template differs from the pinned golden at ${GOLDEN}; regenerate it only from reactAppSpec's own output, never by hand`,
  );
});

const SKIP = templateRuntimeReady() ? false : process.env.CI === 'true' ? false : TEMPLATE_MISSING;

test("the Invoice example's print layout renders end to end: header, customer, items and total", { skip: SKIP }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-print-golden-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  compileTemplateLib(out);

  const spec = invoiceSpec();
  spec.reports.Invoices = { ...spec.reports.Invoices!, recordEndpoint: '/forms/Invoice/record' };

  const record = {
    ROWID: '1',
    Invoice_Number: 'INV-1001',
    Invoice_Date: '15-Jan-2026',
    Customer_Name: 'Ada Lovelace',
    Customer_Email: 'ada@example.test',
    Total: '450.00',
    Lines: [{ Description: 'Consulting', Quantity: '3', Amount: '150.00' }],
  };
  const api: TemplateApi = {
    post: async (endpoint) => (endpoint.endsWith('/record') ? { ok: true, status: 200, body: { record } } : { ok: true, status: 200, body: { rows: [] } }),
  };

  const mounted = await mountTemplateScreen(out, spec, { kind: 'report', report: 'Invoices', row: '1' }, api);
  const button = mounted.container.querySelector('[data-print-record]');
  assert.ok(button, 'the record view offers a Print button');
  button!.dispatchEvent(new (mounted.window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('click', { bubbles: true }));
  await mounted.flush();

  const sheet = mounted.container.querySelector('[data-print-sheet]');
  assert.ok(sheet, 'the print sheet opens');
  const text = sheet!.textContent ?? '';
  assert.match(text, /INVOICE/);
  assert.match(text, /INV-1001/);
  assert.match(text, /Ada Lovelace/);
  assert.match(text, /ada@example\.test/);
  assert.match(text, /Consulting/);
  assert.match(text, /450\.00/);

  let printed = 0;
  (mounted.window as unknown as { print: () => void }).print = () => {
    printed++;
  };
  mounted.container.querySelector('[data-print-now]')!.dispatchEvent(new (mounted.window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('click', { bubbles: true }));
  await mounted.flush();
  assert.equal(printed, 1, "the sheet's Print action calls the browser's own print dialog, not a server PDF");

  await mounted.unmount();
});
