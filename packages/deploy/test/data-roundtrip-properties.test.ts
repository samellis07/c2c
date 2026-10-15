import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { deriveIr, parse } from '../../core/src/index.js';
import { quirkRowServer } from '../../data/test/catalyst-row-fake.js';
import { quantizeDecimal } from '../../shims/src/decimal.js';
import { migrateCsv, readSourceCsv, readSourceJson } from '../src/csv.js';

const APP = `application "RoundTrip"
{
form Parent
{
Code
(
type = text
)
}
form Item
{
Title
(
type = text
)
Amount
(
type = decimal
decimalplace = 18
)
When
(
type = date
)
At
(
type = datetime
)
Active
(
type = checkbox
)
Tags
(
type = checkboxes
values = ["alpha", "東京", ""]
)
Owner
(
type = picklist
values = Parent.ID
displayformat = [Code]
)
Related
(
type = list
values = Parent.ID
)
}
}`;

const app = deriveIr(parse(APP));
const SCOPE = { org: '10000000000', projectId: '1001', token: 'round-trip-test' };

function exportDir(format: 'csv' | 'json', amount: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-roundtrip-'));
  if (format === 'json') {
    // Amount is intentionally emitted as a JSON number token, as Creator can
    // do for numeric fields. JSON.stringify would turn it into a JS Number.
    writeFileSync(join(dir, 'Parent.json'), JSON.stringify({ Parent: [
      { ID: '1001', Code: '東京, one' }, { ID: '1002', Code: '' },
    ] }));
    writeFileSync(join(dir, 'Item.json'), `{"Item":[{"ID":"1003","Title":"café 🧪","Amount":${amount},"When":"29-Feb-2024","At":"08-Mar-2026 02:30:00","Active":false,"Tags":["alpha","東京"],"Owner":{"ID":"1001"},"Related":[{"ID":"1002"},{"ID":"1001"}]}]}`);
  } else {
    writeFileSync(join(dir, 'Parent.csv'), 'ID,Code\n1001,"東京, one"\n1002,\n');
    writeFileSync(join(dir, 'Item.csv'), `ID,Title,Amount,When,At,Active,Tags,Owner,Related\n1003,"café 🧪",${amount},29-Feb-2024,08-Mar-2026 02:30:00,false,"alpha;東京",1001,"1002,1001"\n`);
  }
  return dir;
}

async function roundTrip(format: 'csv' | 'json', amount: string): Promise<void> {
  const dir = exportDir(format, amount);
  try {
    const store = quirkRowServer();
    const result = await migrateCsv({
      app, dir, format, dc: 'in', catalystBase: 'https://api.catalyst.zoho.in',
      fetch: store.fetch, scope: SCOPE,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.counts.every((count) => !count.mismatch), true);
    const item = store.stored.get('Item\0' + '1003');
    assert.ok(item, 'the item was read back from the fake Data Store');
    assert.equal(item.Amount, quantizeDecimal(amount, 18));
    assert.equal(item.Title, 'café 🧪');
    assert.equal(item.When, '2024-02-29');
    assert.equal(item.At, '2026-03-08 02:30:00');
    assert.equal(item.Active, 'false');
    assert.equal(item.Tags, JSON.stringify(['alpha', '東京']));
    assert.notEqual(item.Owner, '1001', 'single lookup is remapped to the stored parent ROWID');
    const junctions = [...store.stored.keys()].filter((key) => key.split('\0')[0]?.includes('Related'));
    assert.equal(junctions.length, 2, 'both multi-lookup links were stored');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function importedAmount(format: 'csv' | 'json', amount: string): string {
  const dir = exportDir(format, amount);
  try {
    const loaded = (format === 'csv' ? readSourceCsv : readSourceJson)(dir, app);
    const item = loaded.tables.find((table) => table.table === 'Item')!.rows[0]!;
    return item.columns.Amount!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('seeded Creator decimal exports and full CSV/JSON migrations round-trip exactly', async () => {
  const fraction = fc.bigInt({ min: 0n, max: 999_999_999_999_999_999n });
  const whole = fc.bigInt({ min: -9_999_999_999_999_999_999n, max: 9_999_999_999_999_999_999n });
  const generated = fc.sample(fc.tuple(whole, fraction), { seed: 20261014, numRuns: 12 });
  for (const [integer, fractional] of generated) {
    const sign = integer < 0n ? '-' : '';
    const magnitude = (integer < 0n ? -integer : integer).toString();
    const value = `${sign}${magnitude}.${fractional.toString().padStart(18, '0')}`;
    const expected = quantizeDecimal(value, 18);
    assert.equal(importedAmount('csv', value), expected, `CSV decimal ${value}`);
    assert.equal(importedAmount('json', value), expected, `JSON decimal ${value}`);
  }

  // Carry an edge-rich generated example through insert and read-back as well.
  const value = '-' + '9876543210' + '123456789.123456789012345678';
  await roundTrip('csv', value);
  await roundTrip('json', value);
});
