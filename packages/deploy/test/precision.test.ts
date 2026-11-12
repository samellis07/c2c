import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { readExactDecimal } from '../../shims/src/decimal.js';
import { readSourceCsv } from '../src/csv.js';
import { generateSchema } from '../../schema/src/generator.js';

const SRC = `application "Demo"
{
	form Item
	{
		Sum
		(
			type = decimal
			decimalplace = 2
		)
		Wide
		(
			type = decimal
			decimalplace = 2
		)
		Neg2
		(
			type = decimal
			decimalplace = 2
		)
		Neg3
		(
			type = decimal
			decimalplace = 3
		)
		Neg4
		(
			type = decimal
			decimalplace = 4
		)
		Fee
		(
			type = INR
			decimalplace = 2
		)
		Rate
		(
			type = percent
			decimalplace = 2
		)
	}
}
`;

test('csv import round-trips exact decimals, currency, and percent', () => {
  const app = deriveIr(parse(SRC));
  const fee = generateSchema(app).tables[0].columns.find((column) => column.name === 'Fee');
  assert.equal(fee?.dataType, 'VarChar');
  assert.equal(fee?.exactDecimal, true);
  assert.equal(fee?.currencyCode, 'INR');
  assert.equal(fee?.length, 64);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-exact-'));
  writeFileSync(
    join(dir, 'Item.csv'),
    'ID,Sum,Wide,Neg2,Neg3,Neg4,Fee,Rate\n1,0.3,"12345678901234.56",-0.005,-0.005,-0.005,₹10.5,12.5%\n',
  );
  writeFileSync(join(dir, 'counts.json'), JSON.stringify({ Item: 1 }));
  const loaded = readSourceCsv(dir, app);
  const row = loaded.tables.find((table) => table.table === 'Item')?.rows[0];
  assert.ok(row);
  const expectCell = (name: string, value: string) => {
    assert.equal(row.columns[name], value);
    assert.equal(readExactDecimal(row.columns[name]), value);
  };
  expectCell('Sum', '0.30');
  expectCell('Wide', '12345678901234.56');
  expectCell('Neg2', '-0.005');
  expectCell('Neg3', '-0.005');
  expectCell('Neg4', '-0.0050');
  expectCell('Fee', '10.50');
  expectCell('Rate', '12.50');
  assert.throws(() => readExactDecimal(Number(row.columns.Wide)), /JS number/);
});

test('csv import fills each Double shadow from the exact value and leaves a blank cell blank', () => {
  const app = deriveIr(parse(SRC));
  const columns = generateSchema(app).tables[0].columns;
  const shadow = columns.find((column) => column.name === 'Fee__n');
  assert.equal(shadow?.dataType, 'Double');
  assert.equal(shadow?.shadowFor, 'Fee');
  assert.equal(shadow?.mandatory, false);
  assert.equal(shadow?.unique, false);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-shadow-'));
  // A CSV column named like the shadow is not mapped onto it.
  writeFileSync(join(dir, 'Item.csv'), 'ID,Sum,Wide,Fee,Rate,Fee__n\n1,0.3,"12345678901234.56",₹10.5,,999\n2,,1000,20,1,\n');
  writeFileSync(join(dir, 'counts.json'), JSON.stringify({ Item: 2 }));
  const rows = readSourceCsv(dir, app).tables.find((table) => table.table === 'Item')!.rows;
  assert.equal(rows[0]!.columns.Sum__n, '0.3');
  assert.equal(rows[0]!.columns.Wide__n, '12345678901234.56');
  assert.equal(rows[0]!.columns.Fee__n, '10.5');
  assert.equal(Object.hasOwn(rows[0]!.columns, 'Rate__n'), false);
  assert.equal(Object.hasOwn(rows[1]!.columns, 'Sum__n'), false);
  assert.equal(rows[1]!.columns.Wide__n, '1000');
});
