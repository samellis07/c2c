import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { limitValue } from '../../schema/src/limits.js';
import { precheck } from '../src/precheck.js';

test('an unsplittable column group is a precheck blocker and not an unsupported field', () => {
  const cap = limitValue('datastore.columns_per_table');
  const parts = Array.from({ length: cap }, (_, index) => `\t\t\tP${index}\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)`).join('\n');
  const source = `application "Demo"\n{\n\tform Item\n\t{\n\t\tWho\n\t\t(\n\t\t\ttype = name\n${parts}\n\t\t)\n\t}\n}\n`;
  const report = precheck(deriveIr(parse(source)), source);
  const finding = report.findings.find((item) => item.check === 'catalyst-column-cap');
  assert.ok(finding);
  assert.equal(finding!.severity, 'blocker');
  assert.match(finding!.message, /verified: false/);
  assert.equal(report.findings.some((item) => item.check === 'converter-gap' && item.message.includes('Who') && item.severity === 'blocker'), false);
  assert.equal(report.counts.blocker >= 1, true);
});
