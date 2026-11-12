import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { limitValue } from '../../schema/src/limits.js';
import { generateUi } from '../src/index.js';

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function fields(count: number): string {
  return Array.from({ length: count }, (_, index) => `\t\tF${String(index).padStart(3, '0')}\n\t\t(\n\t\t\ttype = text\n\t\t)`).join('\n');
}

function reportSource(count: number): string {
  return `\tform Item\n\t{\n${fields(count)}\n\t}\n\tlist All_Items\n\t{\n\t\tshow all rows from Item\n\t}`;
}

test('a report under the select cap does not gain staged ZCQL', () => {
  const ui = generateUi(appOf(reportSource(2)));
  const file = ui.files.find((item) => item.path.endsWith('all-items.mjs') || item.path.includes('/reports/'));
  assert.ok(file, ui.files.map((item) => item.path).join('\n'));
  const text = String(file!.data);
  assert.equal(text.includes('zcqlStages'), false);
  assert.match(text, /SELECT \$\{projection\.join\(", "\)\} FROM/);
  assert.equal(text.includes('SELECT *'), false);
});

test('a report whose select list exceeds 30 columns is staged and does not SELECT *', () => {
  const count = limitValue('zcql.select_columns') + 1;
  const ui = generateUi(appOf(reportSource(count)));
  const file = ui.files.find((item) => item.path.includes('/reports/'));
  assert.ok(file);
  const text = String(file!.data);
  assert.match(text, /export const zcqlStages = /);
  assert.equal(text.includes('notice: "staged zcql"'), false);
  assert.equal(text.includes('await datastore.query('), false);
  assert.equal(text.includes('await queryExact('), false);
  assert.equal(text.includes('SELECT *'), false);
  assert.match(text, /zcql: zcqlStages/);
  assert.match(text, /createRuntime\(/);
  assert.match(text, /SELECT ROWID, F000/);
});
