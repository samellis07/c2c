import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { loadCorpusApps } from '../src/corpus.js';
import { formatPrecisionMapping, precisionFields } from '../src/precision.js';

function appOf(body: string) {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

test('precision report distinguishes varchar columns from embedded NoSQL values', () => {
  const app = appOf(`
\tform Item
\t{
\t\tAmount
\t\t(
\t\t\ttype = decimal
\t\t\tdecimalplace = 4
\t\t)
\t\tFee
\t\t(
\t\t\ttype = INR
\t\t)
\t\tRate
\t\t(
\t\t\ttype = percent
\t\t)
\t\tLines
\t\t(
\t\t\ttype = grid
\t\t\tQty
\t\t\t(
\t\t\t\ttype = decimal
\t\t\t\tdecimalplace = 3
\t\t\t)
\t\t\tInner
\t\t\t(
\t\t\t\ttype = grid
\t\t\t\tPart
\t\t\t\t(
\t\t\t\t\ttype = currency
\t\t\t\t)
\t\t\t)
\t\t)
\t}
\tform Bundle
\t{
\t\tA
\t\t(
\t\t\ttype = grid
\t\t\tCost
\t\t\t(
\t\t\t\ttype = decimal
\t\t\t)
\t\t)
\t\tB
\t\t(
\t\t\ttype = grid
\t\t\tNote
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t)
\t\tTotal
\t\t(
\t\t\ttype = decimal
\t\t\tdecimalplace = 2
\t\t)
\t}
`);
  const rows = precisionFields(app, 'demo');
  const byField = new Map(rows.map((row) => [`${row.form}.${row.field}`, row]));
  assert.equal(byField.get('Item.Amount')?.storage, 'varchar-exact-decimal');
  assert.equal(byField.get('Item.Amount')?.places, 4);
  assert.equal(byField.get('Item.Fee')?.currencyCode, 'INR');
  assert.equal(byField.get('Item.Fee')?.places, 2);
  assert.equal(byField.get('Item.Fee')?.matrixId, 'currency');
  assert.equal(byField.get('Item.Rate')?.matrixId, 'percent');
  assert.equal(byField.get('Item.Rate')?.currencyCode, undefined);
  assert.equal(byField.get('Item.Lines.Qty')?.storage, 'varchar-exact-decimal');
  assert.equal(byField.get('Item.Lines.Qty')?.places, 3);
  assert.equal(byField.get('Item.Lines.Inner.Part')?.storage, 'embedded-exact-decimal');
  assert.equal(byField.get('Bundle.Total')?.storage, 'embedded-exact-decimal');
  assert.equal(byField.get('Bundle.A.Cost')?.storage, 'embedded-exact-decimal');
  const text = formatPrecisionMapping(rows);
  assert.match(text, new RegExp(`Measured fields: ${rows.length}`));
  assert.match(text, /App_01 \/ Form_2\.Field_7 decimal places 2 → embedded-exact-decimal$/m);
  // Each varchar field lists its Double shadow; an embedded NoSQL value has none.
  assert.equal(byField.get('Item.Amount')?.shadow, 'Amount__n');
  assert.equal(byField.get('Item.Lines.Qty')?.shadow, 'Qty__n');
  assert.equal(byField.get('Bundle.Total')?.shadow, undefined);
  assert.match(text, /App_01 \/ Form_1\.Field_2 currency places 2 currency INR → varchar-exact-decimal \+ shadow Field_2__n Double$/m);
  assert.match(text, /Double shadow column/);
});

test('docs/precision-mapping.md lists every measured precision field', () => {
  const docPath = join(process.cwd(), 'docs/precision-mapping.md');
  const doc = readFileSync(docPath, 'utf8');
  assert.match(doc, /^# Precision mapping\n/);
  assert.match(doc, /VarChar column of length 64/);
  assert.match(doc, /half-away-from-zero/);
  assert.match(doc, /not divided by 100/);
  assert.match(doc, /compares and orders a varchar as text/);
  assert.match(doc, /Double shadow column/);
  const measured = /^Measured fields: (\d+)$/m.exec(doc);
  assert.ok(measured);
  const lines = doc.split('\n').filter((line) => / → (?:varchar|embedded)-exact-decimal(?: \+ shadow \S+ Double)?$/.test(line));
  assert.equal(lines.length, Number(measured[1]));
  for (const line of lines) {
    assert.match(line, /^\S+ \/ Form_\d+\.Field_\d+ (?:decimal|percent|currency) places \d+(?: currency [A-Z]{3})? → (?:varchar-exact-decimal \+ shadow Field_\d+__n(?:_\d+)? Double|embedded-exact-decimal)$/);
  }
  const fixtures = process.env.C2C_FIXTURES_DIR;
  if (!fixtures) return;
  const apps = loadCorpusApps(join(fixtures, 'gallery'));
  const rows = apps.flatMap((app) => precisionFields(app.ir, app.link));
  assert.equal(doc, formatPrecisionMapping(rows));
});
