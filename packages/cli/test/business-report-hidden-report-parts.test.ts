/**
 * `hidden.ts` documents that a report-level hidden part (an unoffered field
 * filter, a dropped conditional-formatting rule, ...) is "carried into ...
 * the migration report", but the business report only read field- and
 * screen-level hidden parts. A report whose filter has no default value
 * silently lost its filter with no mention anywhere in the customer-facing
 * report. This fixture reproduces the minimal shape: a bare field filter
 * with no label, which `hiddenParts` always flags regardless of the Deluge
 * compiler used for conditional formatting.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildBusinessMigrationReport } from '../src/business-report.js';

const SRC = `application "T"\n{\n\tform Item\n\t{\n\t\tStatus\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n\tlist All_Items\n\t{\n\t\tshow all rows from Item\n\t\t(\n\t\t\tStatus\n\t\t)\n\t\tfilters\n\t\t(\n\t\t\tStatus\n\t\t)\n\t}\n}\n`;

test('a report filter with no default value is reported to the business reader, not only to c2c analyze', () => {
  const app = deriveIr(parse(SRC));
  const report = buildBusinessMigrationReport(app, { dc: 'in' });
  const item = report.unsupported.find((entry) => entry.area === 'report' && entry.name === 'All_Items');
  assert.ok(item, 'the unoffered filter on All_Items must appear in the business report, not only in c2c analyze');
  assert.match(item!.detail, /filter on Status/);
  assert.match(item!.workaround, /default value/);
});
