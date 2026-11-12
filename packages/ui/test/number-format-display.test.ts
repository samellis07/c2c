/**
 * Creator `format = commadotwestern` groups integer digits in report cells
 * and the record summary. The input and the posted value stay the stored
 * decimal. Any other format, and any value that is not a plain decimal,
 * shows as stored.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';

async function runtime() {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    formattedNumber(value: unknown, format: unknown): string;
    renderReportRows(report: { name: string; columns: { field: string; label: string; format?: string; numeric?: boolean }[] }, rows: unknown[]): string;
  };
}

test('formattedNumber groups a commadotwestern decimal and leaves every other value stored', async () => {
  const mod = await runtime();
  assert.equal(mod.formattedNumber('1234567.5', 'commadotwestern'), '1,234,567.5');
  assert.equal(mod.formattedNumber('-1234567', 'CommaDotWestern'), '-1,234,567');
  assert.equal(mod.formattedNumber('12', 'commadotwestern'), '12');
  assert.equal(mod.formattedNumber('1234.50', 'commadotwestern'), '1,234.50');
  assert.equal(mod.formattedNumber('1,234', 'commadotwestern'), '1,234');
  assert.equal(mod.formattedNumber('12.3.4', 'commadotwestern'), '12.3.4');
  assert.equal(mod.formattedNumber('1234', 'dotcommawestern'), '1234');
  assert.equal(mod.formattedNumber('1234', undefined), '1234');
});

test('a currency field and its report column carry commadotwestern, and the cell groups the stored decimal', async () => {
  const model = buildUi(
    deriveIr(
      parse(`application "Shop"
{
form Order
{
Amount
(
type = currency
format = commadotwestern
)
Note
(
type = text
)
}
list Order_Report
{
show all rows from Order
(
Amount
Note
)
}
}
`),
    ),
  ).model;
  const field = model.forms[0]!.fields.find((item) => item.name === 'Amount')!;
  assert.equal(field.format, 'commadotwestern');
  const report = model.reports.find((item) => item.name === 'Order_Report')!;
  assert.equal(report.columns.find((column) => column.field === 'Amount')!.format, 'commadotwestern');
  assert.equal(report.columns.find((column) => column.field === 'Note')!.format, undefined);

  const mod = await runtime();
  const html = mod.renderReportRows(report, [{ ROWID: '1', Amount: '1234567.5', Note: '1234567.5' }]);
  assert.match(html, />1,234,567\.5</);
  assert.match(html, />1234567\.5</);
});
