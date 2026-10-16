import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WriteRuleError,
  assertWritable,
  canonCell,
  canonDecimal,
  canonRow,
  checkCell,
  checkRow,
  normalizeDate,
  normalizeDateTime,
  type WriteRuleColumn,
} from '../src/write-rules.js';

const COLUMNS: readonly WriteRuleColumn[] = [
  { name: 'ID', dataType: 'BigInt', required: true },
  { name: 'Name', dataType: 'VarChar', length: 10, required: true },
  { name: 'Price', dataType: 'Decimal', scale: 2 },
  { name: 'Total', dataType: 'Double' },
  { name: 'Exact', dataType: 'Decimal', exactDecimal: true },
  { name: 'When', dataType: 'Date' },
];

function refused(column: WriteRuleColumn, value: unknown): string | null {
  const result = checkCell(column, value);
  return 'rule' in result ? result.rule : null;
}

test('checkCell: over-scale decimal and overlong text refuse', () => {
  assert.equal(refused({ name: 'Price', dataType: 'Decimal', scale: 2 }, '1.234'), 'decimal-scale');
  assert.equal(refused({ name: 'Price', dataType: 'Decimal', scale: 2 }, '1.23'), null);
  assert.equal(refused({ name: 'Name', dataType: 'VarChar', length: 10 }, 'x'.repeat(11)), 'text-length');
  assert.equal(refused({ name: 'Name', dataType: 'VarChar', length: 10 }, 'x'.repeat(10)), null);
  assert.equal(refused({ name: 'Body', dataType: 'Text' }, 'x'.repeat(10_001)), 'text-length');
});

test('checkCell: a Double over 15 significant digits refuses; non-numeric input refuses too', () => {
  const col: WriteRuleColumn = { name: 'Total', dataType: 'Double' };
  assert.equal(refused(col, '0.123456789012345678'), 'significant-digits');
  assert.equal(refused(col, '0.123456789012345'), null);
  assert.equal(refused(col, 'not-a-number'), 'significant-digits');
  assert.equal(refused({ name: 'Total', dataType: 'Double', shadow: true }, '0.123456789012345678'), null);
});

test('checkCell: an exact-decimal column keeps any precision verbatim', () => {
  const col: WriteRuleColumn = { name: 'Exact', dataType: 'Decimal', exactDecimal: true };
  const result = checkCell(col, '1.23456789012345678901234');
  assert.equal('rule' in result, false);
});

test('dates normalize unambiguous Creator formats and refuse the rest', () => {
  assert.deepEqual(normalizeDate('05-Jan-2024'), { ok: true, value: '2024-01-05' });
  assert.deepEqual(normalizeDate('2024-01-05'), { ok: true, value: '2024-01-05' });
  assert.deepEqual(normalizeDateTime('05-Jan-2024 13:45:00'), { ok: true, value: '2024-01-05 13:45:00' });
  assert.deepEqual(normalizeDateTime('2024-01-05T13:45:00'), { ok: true, value: '2024-01-05 13:45:00' });
  const col: WriteRuleColumn = { name: 'When', dataType: 'Date' };
  assert.equal(refused(col, '25-12-2024'), 'date-format');
  assert.equal(refused(col, '2024-13-01'), 'date-format');
  assert.equal(refused(col, '2024-02-30'), 'date-format');
  assert.equal(refused({ name: 'When', dataType: 'DateTime' }, '2024-01-05T13:45:00Z'), 'date-format');
  assert.equal(refused({ name: 'When', dataType: 'DateTime' }, '2024-01-05 13:45:00+05:30'), 'date-format');
  assert.equal(refused(col, ''), null);
  // The serial form of a Deluge date (script-assigned) folds to its day; a time of day does not.
  assert.deepEqual(checkCell(col, '2026-01-04T00:00:00'), { value: '2026-01-04' });
  assert.equal(refused(col, '2026-01-04T10:30:00'), 'date-format');
  assert.equal(refused(col, '2026-02-30T00:00:00'), 'date-format');
});

test('checkRow: insert refuses an absent required column; update tolerates absence but not emptiness', () => {
  const ok = checkRow(COLUMNS, { ID: '7', Name: 'n' }, { required: true });
  assert.deepEqual(ok.refusals, []);
  const missing = checkRow(COLUMNS, { Name: 'n' }, { required: true });
  assert.deepEqual(missing.refusals, [{ column: 'ID', rule: 'mandatory-missing' }]);
  assert.deepEqual(checkRow(COLUMNS, { Name: 'n' }, { required: false }).refusals, []);
  assert.deepEqual(checkRow(COLUMNS, { Name: '' }, { required: false }).refusals, [
    { column: 'Name', rule: 'mandatory-missing' },
  ]);
});

test('checkRow normalizes cells it accepts', () => {
  const checked = checkRow(COLUMNS, { ID: '7', Name: 'n', When: '05-Jan-2024' }, { required: true });
  assert.equal(checked.cells.When, '2024-01-05');
});

const COMPOSITE_COLUMNS: readonly WriteRuleColumn[] = [
  { name: 'Name_first_name', dataType: 'VarChar', required: true },
  { name: 'Name_last_name', dataType: 'VarChar', required: true },
  { name: 'Name_prefix', dataType: 'VarChar' },
  { name: 'Owner', dataType: 'BigInt' },
  { name: 'Photo', dataType: 'VarChar' },
];

test('checkRow expands a nested composite object onto its part columns', () => {
  const checked = checkRow(COMPOSITE_COLUMNS, { Name: { first_name: 'Ada', last_name: 'Lovelace' } }, { required: true });
  assert.deepEqual(checked.refusals, []);
  assert.equal(checked.cells.Name_first_name, 'Ada');
  assert.equal(checked.cells.Name_last_name, 'Lovelace');
  assert.equal(checked.cells.Name, undefined);
});

test('checkRow expands a dotted composite key onto the part column', () => {
  const checked = checkRow(COMPOSITE_COLUMNS, { 'Name.first_name': 'Ada', 'Name.last_name': 'Lovelace' }, { required: true });
  assert.deepEqual(checked.refusals, []);
  assert.equal(checked.cells.Name_first_name, 'Ada');
  assert.equal(checked.cells['Name.first_name'], undefined);
});

test('a nested value with a wrong part name stays nested and is refused, not dropped', () => {
  const checked = checkRow(COMPOSITE_COLUMNS, { Name: { first_name: 'Ada', bogus: 'x' } }, { required: true });
  assert.deepEqual(
    checked.refusals.map((refusal) => refusal.column),
    ['Name_first_name', 'Name_last_name'],
  );
  assert.deepEqual(checked.cells.Name, { first_name: 'Ada', bogus: 'x' });
});

test('lookup and file objects are not mistaken for composites', () => {
  const checked = checkRow(COMPOSITE_COLUMNS, { Name_first_name: 'a', Name_last_name: 'b', Owner: { id: '7', label: 'x' }, Photo: { key: 'k1' } }, { required: true });
  assert.deepEqual(checked.refusals, []);
  assert.deepEqual(checked.cells.Owner, { id: '7', label: 'x' });
  assert.deepEqual(checked.cells.Photo, { key: 'k1' });
});

function thrown(fn: () => unknown): WriteRuleError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof WriteRuleError, `expected a WriteRuleError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected a WriteRuleError');
}

test('assertWritable throws WriteRuleError naming the first refused field', () => {
  const err = thrown(() => assertWritable('Order', COLUMNS, { Name: 'n' }, { required: true }));
  assert.equal(err.code, 'MANDATORY_MISSING');
  assert.equal(err.table, 'Order');
  assert.equal(err.field, 'ID');
  assert.equal(err.rule, 'mandatory-missing');
  const bad = thrown(() =>
    assertWritable('Order', COLUMNS, { ID: '7', Name: 'n', When: '25-12-2024' }, { required: true }),
  );
  assert.equal(bad.code, 'INVALID_INPUT');
  assert.equal(bad.field, 'When');
  assert.equal(bad.refusals.length, 1);
  assert.doesNotMatch(String(bad.message), /25-12-2024/, 'the refusal never echoes a cell value');
});

test('canonCell/canonRow are deterministic across equivalent inputs', () => {
  assert.equal(canonCell({ name: 'Price', dataType: 'Decimal', scale: 2 }, '2.50'), canonCell({ name: 'Price', dataType: 'Decimal', scale: 2 }, '2.5'));
  assert.equal(canonDecimal('-0.015'), '-0.015');
  assert.equal(canonDecimal('2.50'), '2.5');
  assert.equal(canonCell({ name: 'When', dataType: 'Date' }, '05-Jan-2024'), canonCell({ name: 'When', dataType: 'Date' }, '2024-01-05'));
  const keys = ['ID', 'Name', 'Exact'];
  const sent = canonRow({ ID: '7', Name: 'n', Exact: '1.00000000000000000000' }, keys, COLUMNS);
  const stored = canonRow({ ID: '7', Name: 'n', Exact: '1.00000000000000000000', Exact__c2c_shadow: 'extra' }, keys, COLUMNS);
  assert.equal(sent, stored, 'cells outside the sent keys do not move the fingerprint');
  const changed = canonRow({ ID: '7', Name: 'x', Exact: '1.00000000000000000000' }, keys, COLUMNS);
  assert.notEqual(sent, changed);
});
