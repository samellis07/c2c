import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse, type Workflow } from '../../core/src/index.js';
import { auditApp, auditGallery, emptyCounts, formatDecimalAudit } from '../src/decimal-audit.js';

const Z = { start: 0, end: 0 };

test('decimal audit counts criteria and sort sites on exact-decimal columns and finds them routed', () => {
  const app = deriveIr(
    parse(`application "T"
{
\tform Add_Discount
\t{
\t\tTotal_price
\t\t(
\t\t\ttype = INR
\t\t)
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Add_Invoice
\t{
\t\tTotal
\t\t(
\t\t\ttype = INR
\t\t)
\t}
\tlist Discounts
\t{
\t\tshow all rows from Add_Discount
\t\t(
\t\t\tTotal_price
\t\t)
\t\tsort by
\t\t{
\t\t\tTotal_price descending
\t\t}
\t}
}
`),
  );
  const flow = (name: string, text: string): Workflow => ({ name, form: 'Add_Invoice', event: 'on user input of Total', deluge: { text, span: Z }, properties: [], span: Z });
  app.workflows.push(
    flow('Discount', 'd = Add_Discount[Total_price <= input.Total && Name != ""] sort by Total_price desc range from 0 to 0;'),
    flow('Names', 'n = Add_Discount[Name == "x"] sort by Name;'),
    flow('Math', 'input.Total = input.Total * 2 + 0.5;'),
  );
  const counts = emptyCounts();
  auditApp(app, counts);
  assert.deepEqual(counts, {
    apps: 1,
    appsWithDecimalColumns: 1,
    querySites: 2,
    queryCriteriaSites: 1,
    querySortSites: 1,
    reportCriteriaSites: 0,
    reportSortSites: 1,
    unrouted: 0,
    arithmeticBypass: 0,
  });
  assert.match(formatDecimalAudit(counts), /\| sites not routed through the shadow path \| 0 \|/);
});

test('docs/decimal-audit.md matches the gallery when C2C_FIXTURES_DIR is set', () => {
  const doc = readFileSync(join(process.cwd(), 'docs/decimal-audit.md'), 'utf8');
  assert.match(doc, /^# Exact-decimal audit\n/);
  const rows = [...doc.matchAll(/^\| ([^|]+) \| (\d+) \|$/gm)].map(([, label, value]) => [label, Number(value)] as const);
  assert.deepEqual(rows.map(([label]) => label), [
    'corpus apps',
    'apps with exact-decimal columns',
    '`Form[criteria]` sites emitted',
    '…criteria on an exact-decimal field',
    '…sort by an exact-decimal field',
    'report criteria/filters on an exact-decimal field',
    'report sort by an exact-decimal field',
    'sites not routed through the shadow path',
    'raw JS arithmetic ops on a decimal operand',
  ], 'fixture-less decimal audit must have exactly one complete table');
  assert.ok(rows.every(([, value]) => Number.isSafeInteger(value) && value >= 0));
  assert.equal((doc.match(/^# Exact-decimal audit$/gm) ?? []).length, 1);
  assert.match(doc, /\| sites not routed through the shadow path \| 0 \|/);
  assert.match(doc, /\| raw JS arithmetic ops on a decimal operand \| 0 \|/);
  const fixtures = process.env.C2C_FIXTURES_DIR;
  if (!fixtures) return;
  const counts = auditGallery(join(fixtures, 'gallery'));
  assert.equal(counts.unrouted, 0);
  assert.equal(counts.arithmeticBypass, 0);
  assert.equal(doc, formatDecimalAudit(counts));
});
