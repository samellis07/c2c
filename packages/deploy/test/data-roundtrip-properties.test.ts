import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { deriveIr, parse } from '../../core/src/index.js';
import { quirkRowServer, type QuirkHandle } from '../../data/test/catalyst-row-fake.js';
import { decimalShadow } from '../../shims/src/criteria.js';
import { quantizeDecimal } from '../../shims/src/decimal.js';
import { migrateCsv, readSourceCsv, readSourceJson } from '../src/csv.js';

/**
 * Property-based and edge coverage for Creator CSV and JSON data exports
 * round-tripping through Catalyst Data Store migration.
 *
 * Supported field kinds tested:
 * - Text: single-line text in VarChar(255); preserves strings and JSON scalars
 *   (null vs empty vs "null", numeric-looking strings like "007", "1e3", "-0", "+1").
 * - Decimal: high-precision exact decimals (scale up to 18) stored as exact
 *   strings in VarChar(64) alongside a Double shadow column (__n) for ZCQL queries.
 * - Date: calendar dates (YYYY-MM-DD), including leap day edges.
 * - DateTime: timestamps (YYYY-MM-DD HH:mm:ss), preserving literal wall-clock time
 *   around DST spring-forward/fall-back transitions and leap days.
 * - Boolean: checkbox fields storing 'true'/'false'.
 * - Multi-select: checkboxes storing JSON lists of selected values.
 * - Lookup (single): picklist referencing parent forms remapped to parent ROWIDs.
 * - Lookup (multi): list referencing parent forms remapped to junction table rows.
 */
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
const SEED = 20261014;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

interface ItemRecord {
  id: string;
  title?: string | null;
  amount?: string | null;
  rawAmountNumber?: boolean;
  when?: string | null;
  at?: string | null;
  active?: boolean | null;
  tags?: readonly string[] | null;
  ownerId?: string | null;
  relatedIds?: readonly string[] | null;
}

function expectedDate(raw?: string | null): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  const text = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text);
  if (!match) return text;
  const month = MONTHS.indexOf(match[2]!.toLowerCase());
  if (month < 0) return text;
  return `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1]!.padStart(2, '0')}`;
}

function expectedDateTime(raw?: string | null): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  const text = raw.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2) return undefined;
  const datePart = expectedDate(parts[0]);
  return `${datePart} ${parts[1]}`;
}

function csvCell(val: string | null | undefined): string {
  if (val === null || val === undefined || val === '') return '';
  if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r') || val.includes(';')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function serializeItemJson(records: readonly ItemRecord[]): string {
  const rawPlaceholders = new Map<string, string>();
  const rows = records.map((r, i) => {
    const row: Record<string, unknown> = { ID: r.id };
    if (r.title !== undefined) row.Title = r.title;
    if (r.amount !== undefined) {
      if (r.amount === null || r.amount === '') {
        row.Amount = null;
      } else if (r.rawAmountNumber) {
        const placeholder = `__RAW_AMOUNT_${i}__`;
        rawPlaceholders.set(`"${placeholder}"`, r.amount);
        row.Amount = placeholder;
      } else {
        row.Amount = r.amount;
      }
    }
    if (r.when !== undefined) row.When = r.when;
    if (r.at !== undefined) row.At = r.at;
    if (r.active !== undefined) row.Active = r.active;
    if (r.tags !== undefined) row.Tags = r.tags;
    if (r.ownerId !== undefined) row.Owner = r.ownerId ? { ID: r.ownerId } : null;
    if (r.relatedIds !== undefined) {
      row.Related = r.relatedIds ? r.relatedIds.map((id) => ({ ID: id })) : [];
    }
    return row;
  });
  let text = JSON.stringify({ Item: rows });
  for (const [placeholder, rawVal] of rawPlaceholders) {
    text = text.replace(placeholder, rawVal);
  }
  return text;
}

function serializeItemCsv(records: readonly ItemRecord[]): string {
  const lines = ['ID,Title,Amount,When,At,Active,Tags,Owner,Related'];
  for (const r of records) {
    const title = csvCell(r.title);
    const amount = r.amount ?? '';
    const when = r.when ?? '';
    const at = r.at ?? '';
    const active = r.active === null || r.active === undefined ? '' : String(r.active);
    const tags = r.tags && r.tags.length ? csvCell(r.tags.join(';')) : '';
    const owner = r.ownerId ?? '';
    const related = r.relatedIds && r.relatedIds.length ? csvCell(r.relatedIds.join(',')) : '';
    lines.push(`${r.id},${title},${amount},${when},${at},${active},${tags},${owner},${related}`);
  }
  return lines.join('\n') + '\n';
}

function exportDataset(format: 'csv' | 'json', records: readonly ItemRecord[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-roundtrip-'));
  if (format === 'json') {
    writeFileSync(
      join(dir, 'Parent.json'),
      JSON.stringify({
        Parent: [
          { ID: '1001', Code: '東京, one' },
          { ID: '1002', Code: '' },
        ],
      }),
    );
    writeFileSync(join(dir, 'Item.json'), serializeItemJson(records));
  } else {
    writeFileSync(join(dir, 'Parent.csv'), 'ID,Code\n1001,"東京, one"\n1002,\n');
    writeFileSync(join(dir, 'Item.csv'), serializeItemCsv(records));
  }
  return dir;
}

function assertMigratedRecord(r: ItemRecord, store: QuirkHandle): void {
  const item = store.stored.get('Item\0' + r.id);
  assert.ok(item, `the item ${r.id} was read back from the fake Data Store`);

  // (1) Type preservation: null vs empty string vs "null", numeric-looking strings
  // (2) Max-length text values
  if (r.title === null || r.title === undefined || r.title === '') {
    assert.equal(item.Title, undefined, `Item ${r.id} Title should be undefined for empty/null`);
  } else {
    assert.equal(item.Title, r.title.trim(), `Item ${r.id} Title matches expected string`);
  }

  // (1) Decimal exact preservation, (2) Max-length decimal, (4) Empty decimal
  if (r.amount === null || r.amount === undefined || r.amount === '') {
    assert.equal(item.Amount, undefined, `Item ${r.id} Amount should be undefined for empty`);
    assert.equal(item.Amount__n, undefined, `Item ${r.id} Amount__n should be undefined for empty`);
  } else {
    const expectedAmount = quantizeDecimal(r.amount, 18);
    assert.equal(item.Amount, expectedAmount, `Item ${r.id} Amount matches quantized decimal`);
    const expectedShadow = decimalShadow(expectedAmount);
    if (expectedShadow !== null) {
      assert.equal(item.Amount__n, String(expectedShadow), `Item ${r.id} Amount__n matches Double shadow`);
    }
  }

  // (3) Date preservation around leap days, (4) Empty date
  if (r.when === null || r.when === undefined || r.when === '') {
    assert.equal(item.When, undefined, `Item ${r.id} When should be undefined for empty`);
  } else {
    assert.equal(item.When, expectedDate(r.when), `Item ${r.id} When matches expected date`);
  }

  // (3) DateTime preservation around DST changes and leap days, (4) Empty datetime
  if (r.at === null || r.at === undefined || r.at === '') {
    assert.equal(item.At, undefined, `Item ${r.id} At should be undefined for empty`);
  } else {
    assert.equal(item.At, expectedDateTime(r.at), `Item ${r.id} At matches expected datetime`);
  }

  // (1) Boolean type preservation, (4) Empty checkbox
  if (r.active === null || r.active === undefined) {
    assert.equal(item.Active, undefined, `Item ${r.id} Active should be undefined for empty`);
  } else {
    assert.equal(item.Active, String(r.active), `Item ${r.id} Active matches boolean string`);
  }

  // (4) Multi-select choice list preservation and empty choice
  if (!r.tags || r.tags.length === 0) {
    assert.equal(item.Tags, undefined, `Item ${r.id} Tags should be undefined for empty`);
  } else {
    assert.equal(item.Tags, JSON.stringify(r.tags), `Item ${r.id} Tags matches JSON list`);
  }

  // (4) Single lookup remapped to parent ROWID, or empty
  if (!r.ownerId) {
    assert.equal(item.Owner, undefined, `Item ${r.id} Owner should be undefined for empty`);
  } else {
    const parentRow = store.stored.get('Parent\0' + r.ownerId);
    assert.ok(parentRow?.ROWID, `Parent ${r.ownerId} was stored with a ROWID`);
    assert.equal(item.Owner, parentRow.ROWID, `Item ${r.id} Owner is remapped to parent ${r.ownerId} ROWID`);
    assert.notEqual(item.Owner, r.ownerId, `Item ${r.id} Owner is remapped to parent ROWID`);
  }

  // (4) Multi lookup junction rows stored, or empty
  const expectedJunctionCount = r.relatedIds?.length ?? 0;
  const itemJunctions = [...store.stored.keys()].filter((key) => key.startsWith(`Item__Related\0${r.id}__`));
  assert.equal(itemJunctions.length, expectedJunctionCount, `Item ${r.id} junction row count matches`);
}

async function roundTripRecords(format: 'csv' | 'json', records: readonly ItemRecord[]): Promise<void> {
  const dir = exportDataset(format, records);
  try {
    const store = quirkRowServer();
    const result = await migrateCsv({
      app,
      dir,
      format,
      dc: 'in',
      catalystBase: 'https://api.catalyst.zoho.in',
      fetch: store.fetch,
      scope: SCOPE,
    });
    assert.equal(result.ok, true, `migrateCsv failed: ${JSON.stringify(result)}`);
    assert.equal(result.counts.every((count) => !count.mismatch), true, 'all record counts match');
    for (const record of records) {
      assertMigratedRecord(record, store);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function importedAmount(format: 'csv' | 'json', amount: string): string {
  const dir = exportDataset(format, [{ id: '1003', amount, rawAmountNumber: true }]);
  try {
    const loaded = (format === 'csv' ? readSourceCsv : readSourceJson)(dir, app);
    const item = loaded.tables.find((table) => table.table === 'Item')!.rows[0]!;
    return item.columns.Amount!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('seeded Creator decimal exports round-trip through CSV and JSON imports', () => {
  const fraction = fc.bigInt({ min: 0n, max: 999_999_999_999_999_999n });
  const whole = fc.bigInt({ min: -9_999_999_999_999_999_999n, max: 9_999_999_999_999_999_999n });
  const generated = fc.sample(fc.tuple(whole, fraction), { seed: SEED, numRuns: 20 });
  assert.equal(new Set(generated.map(([i, f]) => `${i}.${f}`)).size, generated.length, 'decimal samples are distinct');
  for (const [integer, fractional] of generated) {
    const sign = integer < 0n ? '-' : '';
    const magnitude = (integer < 0n ? -integer : integer).toString();
    const value = `${sign}${magnitude}.${fractional.toString().padStart(18, '0')}`;
    const expected = quantizeDecimal(value, 18);
    assert.equal(importedAmount('csv', value), expected, `CSV decimal ${value}`);
    assert.equal(importedAmount('json', value), expected, `JSON decimal ${value}`);
  }
});

function assertDistinctSamples(samples: readonly ItemRecord[], format: string): void {
  assert.equal(samples.length, 50, `expected 50 generated ${format} samples`);
  const distinctPayloads = new Set(samples.map(({ id: _id, ...payload }) => JSON.stringify(payload)));
  assert.ok(
    distinctPayloads.size >= 45,
    `expected at least 45 of 50 generated ${format} records to be pairwise distinct (got ${distinctPayloads.size})`,
  );
}

test('comprehensive edge cases and many seeded records round-trip through CSV and JSON migrations', async (t) => {
  t.diagnostic(`seed=${SEED}`);
  // Explicit deterministic edge records covering:
  // (1) type preservation (null, empty string, "null", numeric-looking strings)
  // (2) max-length values per field type
  // (3) date-times around DST changes and leap days
  // (4) empty values for every field type
  const edgeRecords: ItemRecord[] = [
    // (1) Type preservation: null vs empty string vs "null"
    { id: '1003', title: null },
    { id: '1004', title: '' },
    { id: '1005', title: 'null' },

    // (1) Numeric-looking strings stay strings in text fields
    { id: '1006', title: '007' },
    { id: '1007', title: '1e3' },
    { id: '1008', title: '-0' },
    { id: '1009', title: '+1' },
    { id: '1010', title: '42' },
    { id: '1011', title: '0' },
    { id: '1012', title: '0.00' },
    { id: '1013', title: '1.5e-4' },
    { id: '1014', title: 'true' },
    { id: '1015', title: 'false' },

    // (2) Max-length values per field type
    {
      id: '1016',
      title: 'A'.repeat(255), // VarChar 255 maximum
      amount: '-9.123456789012345678', // Creator 19-char maximum
      rawAmountNumber: true,
      when: '29-Feb-2024',
      at: '08-Mar-2026 02:30:00',
      active: true,
      tags: ['alpha', '東京'],
      ownerId: '1001',
      relatedIds: ['1001', '1002'],
    },
    {
      id: '1017',
      title: '東京'.repeat(127) + '東', // 255 UTF-16 code units
      amount: '-9999999999999999999.123456789012345678', // 39 chars wide, exact decimal
      rawAmountNumber: true,
      when: '29-Feb-2000',
      at: '29-Feb-2024 23:59:59',
      active: false,
      tags: ['東京'],
      ownerId: '1002',
      relatedIds: ['1002'],
    },

    // (3) Date-times around DST changes and leap days
    // Leap day dates and datetimes
    { id: '1018', when: '29-Feb-2024', at: '29-Feb-2024 00:00:00' },
    { id: '1019', when: '29-Feb-2000', at: '29-Feb-2000 23:59:59' }, // century leap year
    { id: '1020', when: '29-Feb-2028', at: '29-Feb-2028 12:34:56' },
    { id: '1021', when: '28-Feb-2024', at: '28-Feb-2024 23:59:59' }, // day before leap day
    { id: '1022', when: '01-Mar-2024', at: '01-Mar-2024 00:00:00' }, // day after leap day
    // DST spring-forward (08-Mar-2026): literal string preservation through transition
    { id: '1023', at: '08-Mar-2026 01:59:59' }, // 1s before transition
    { id: '1024', at: '08-Mar-2026 02:00:00' }, // transition boundary
    { id: '1025', at: '08-Mar-2026 02:30:00' }, // skipped/gap hour
    { id: '1026', at: '08-Mar-2026 03:00:00' }, // daylight time start
    { id: '1027', at: '08-Mar-2026 03:30:00' },
    // DST fall-back (01-Nov-2026): literal string preservation through repeated hour
    { id: '1028', at: '01-Nov-2026 01:00:00' },
    { id: '1029', at: '01-Nov-2026 01:30:00' }, // repeated/ambiguous hour
    { id: '1030', at: '01-Nov-2026 01:59:59' },
    { id: '1031', at: '01-Nov-2026 02:00:00' },

    // (4) Empty values for EVERY field type
    {
      id: '1032',
      title: '',
      amount: '',
      when: '',
      at: '',
      active: null,
      tags: [],
      ownerId: '',
      relatedIds: [],
    },
    {
      id: '1033',
      title: null,
      amount: null,
      when: null,
      at: null,
      active: null,
      tags: null,
      ownerId: null,
      relatedIds: null,
    },
  ];

  // (5) Run 50 varied generated records per format through migrate/read-back
  const recordArbitrary = fc.record({
    id: fc.constant('x'),
    title: fc.oneof(
      fc.constant(null),
      fc.constant(''),
      fc.constant('null'),
      fc.constant('007'),
      fc.constant('1e3'),
      fc.constant('-0'),
      fc.constant('+1'),
      fc.constant('42'),
      fc.constant('0'),
      fc.constant('0.00'),
      fc.constant('1.5e-4'),
      fc.constant('true'),
      fc.constant('false'),
      fc.constant('M'.repeat(255)),
      fc.stringMatching(/^[A-Za-z0-9 _-]{1,30}$/),
    ),
    amount: fc.oneof(
      fc.constant(null),
      fc.constant(''),
      fc
        .tuple(
          fc.bigInt({ min: -9_999_999_999_999_999_999n, max: 9_999_999_999_999_999_999n }),
          fc.bigInt({ min: 0n, max: 999_999_999_999_999_999n }),
        )
        .map(([i, f]) => {
          const sign = i < 0n ? '-' : '';
          const mag = (i < 0n ? -i : i).toString();
          return `${sign}${mag}.${f.toString().padStart(18, '0')}`;
        }),
    ),
    rawAmountNumber: fc.boolean(),
    when: fc.oneof(
      fc.constant(null),
      fc.constant(''),
      fc.constant('29-Feb-2024'),
      fc.constant('29-Feb-2000'),
      fc.constant('29-Feb-2028'),
      fc.constant('28-Feb-2024'),
      fc.constant('01-Mar-2024'),
      fc.constant('15-Jun-2025'),
      fc.constant('31-Dec-2026'),
    ),
    at: fc.oneof(
      fc.constant(null),
      fc.constant(''),
      fc.constant('08-Mar-2026 01:59:59'),
      fc.constant('08-Mar-2026 02:00:00'),
      fc.constant('08-Mar-2026 02:30:00'),
      fc.constant('08-Mar-2026 03:00:00'),
      fc.constant('01-Nov-2026 01:30:00'),
      fc.constant('01-Nov-2026 02:00:00'),
      fc.constant('29-Feb-2024 23:59:59'),
      fc.constant('29-Feb-2000 12:00:00'),
    ),
    active: fc.oneof(fc.constant(null), fc.boolean()),
    tags: fc.oneof(
      fc.constant(null),
      fc.constant([]),
      fc.constant(['alpha']),
      fc.constant(['東京']),
      fc.constant(['alpha', '東京']),
    ),
    ownerId: fc.oneof(fc.constant(null), fc.constant(''), fc.constant('1001'), fc.constant('1002')),
    relatedIds: fc.oneof(
      fc.constant(null),
      fc.constant([]),
      fc.constant(['1001']),
      fc.constant(['1002']),
      fc.constant(['1001', '1002']),
    ),
  });

  // Negative guard check: repeated numRuns:1 calls with the same seed collapse to 1 distinct payload and must fail
  const clonedSamples = Array.from({ length: 50 }, (_, i) => ({
    ...fc.sample(recordArbitrary, { seed: SEED, numRuns: 1 })[0]!,
    id: String(1050 + i),
  }));
  assert.throws(() => assertDistinctSamples(clonedSamples, 'cloned'), /pairwise distinct/);

  try {
    for (const format of ['csv', 'json'] as const) {
      const rawSamples = fc.sample(recordArbitrary, { seed: SEED, numRuns: 50 });
      const generatedRecords: ItemRecord[] = rawSamples.map((sample, i) => ({
        ...sample,
        id: String(1050 + i),
      }));
      assertDistinctSamples(generatedRecords, format);
      await roundTripRecords(format, [...edgeRecords, ...generatedRecords]);
    }
  } catch (error) {
    console.error(`FAILURE under seed ${SEED}`);
    throw error;
  }
});

test('regression: unquoted high-precision decimals in JSON export do not round to binary64', async () => {
  const highPrecision = '9999999999' + '999999993.000000000000000009';
  const rec: ItemRecord = {
    id: '1099',
    title: 'high-precision test',
    amount: highPrecision,
    rawAmountNumber: true,
  };
  await roundTripRecords('json', [rec]);
});
