/**
 * A table named constructor or __proto__ keeps its row fingerprints in the delta checkpoint and is read back
 * as its own entry: before, a plain read returned the inherited Object function (the table looked new on every
 * run) and a plain write to __proto__ replaced the prototype instead of storing the entry.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import type { CsvLoad } from '../src/csv.js';
import { computeDelta } from '../src/row-delta.js';

const app = deriveIr(parse(['application "Delta"', '{', '\ttime zone = "Asia/Kolkata"', '}', ''].join('\n')));
const load = (table: string, ids: string[]): CsvLoad =>
  ({ source: 'src', tables: [{ table, rows: ids.map((id) => ({ id, columns: { Name: `n${id}` } })) }] }) as unknown as CsvLoad;

for (const name of ['constructor', '__proto__', 'toString']) {
  test(`delta checkpoint: a table named ${name} is an ordinary own entry and resumes without re-adding rows`, () => {
    const first = computeDelta(app, load(name, ['1', '2']), undefined);
    assert.equal(first.tables[0]!.added.length, 2);
    assert.equal(Object.hasOwn(first.next.tables, name), true, 'the checkpoint holds the table as an own key');
    assert.equal(Object.getPrototypeOf(first.next.tables), Object.prototype, 'the prototype of the checkpoint map is untouched');
    const wire = JSON.parse(JSON.stringify(first.next)) as typeof first.next;
    const second = computeDelta(app, load(name, ['1', '2']), wire);
    assert.equal(second.tables[0]!.added.length, 0, 'nothing is re-added');
    assert.equal(second.tables[0]!.unchanged, 2);
  });
}
