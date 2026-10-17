import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateCreatorImport } from '../../data/src/index.js';
import { parseCsv, readSourceCsv } from '../src/csv.js';

const DS = `application "Leads"
{
\tform Add_Lead
\t{
\t\tmust have Lead_Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tAddress
\t\t(
\t\t\ttype = address
\t\t\taddress_line_1
\t\t\t(
\t\t\t\ttype = address_line_1
\t\t\t)
\t\t\tdistrict_city
\t\t\t(
\t\t\t\ttype = district_city
\t\t\t)
\t\t\tcountry
\t\t\t(
\t\t\t\ttype = country
\t\t\t)
\t\t\tlatitude
\t\t\t(
\t\t\t\ttype = latitude
\t\t\t\tvisibility = false
\t\t\t)
\t\t\tlongitude
\t\t\t(
\t\t\t\ttype = longitude
\t\t\t\tvisibility = false
\t\t\t)
\t\t)
\t}
}
`;

const DECIMAL = /^-?\d+(\.\d+)?$/;

function seededDir(edit?: (rows: string[][]) => void): { dir: string; csv: string[][] } {
  const app = deriveIr(parse(DS));
  const seed = generateCreatorImport(app, { rows: 6 });
  const file = seed.files.find((entry) => entry.form === 'Add_Lead');
  assert.ok(file, 'Add_Lead import file');
  const rows = parseCsv(file.csv).filter((row) => row.length > 1 || row[0] !== '');
  edit?.(rows);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-seed-address-'));
  writeFileSync(join(dir, file.fileName), rows.map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(',')).join('\n') + '\n');
  return { dir, csv: rows };
}

test('creator-import seed fills Address latitude/longitude with in-range decimals or leaves them empty', () => {
  const { dir, csv } = seededDir();
  try {
    const [header, ...body] = csv;
    const lat = header!.indexOf('Address.latitude');
    const long = header!.indexOf('Address.longitude');
    assert.ok(lat >= 0 && long >= 0, `lat/long columns in ${header!.join(',')}`);
    assert.ok(body.length > 0);
    for (const row of body) {
      for (const [index, limit] of [[lat, 90], [long, 180]] as const) {
        const cell = row[index] ?? '';
        if (cell === '') continue;
        assert.match(cell, DECIMAL, `${header![index]} = ${cell}`);
        assert.ok(Math.abs(Number(cell)) <= limit, `${header![index]} = ${cell} out of range`);
      }
    }
    assert.ok(body.some((row) => row[lat] !== ''), 'at least one latitude is filled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSourceCsv accepts the creator-import seed of an app with an Address field', () => {
  const app = deriveIr(parse(DS));
  const { dir } = seededDir();
  try {
    const loaded = readSourceCsv(dir, app);
    const table = loaded.tables.find((entry) => entry.rows.length > 0);
    assert.ok(table, 'rows loaded');
    const lats = table.rows.map((row) => row.columns.Address_latitude ?? row.columns.address_latitude).filter((value) => value !== undefined);
    assert.ok(lats.length > 0, `latitude loaded: ${Object.keys(table.rows[0]!.columns).join(',')}`);
    for (const value of lats) assert.match(value!, DECIMAL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSourceCsv refuses a text latitude and names the column and the row', () => {
  const app = deriveIr(parse(DS));
  const { dir } = seededDir((rows) => {
    const lat = rows[0]!.indexOf('Address.latitude');
    rows[2]![lat] = 'North wing';
  });
  try {
    assert.throws(
      () => readSourceCsv(dir, app),
      (err: Error) => /Address\.latitude in Add_Lead\.csv row 2 is not a decimal/.test(err.message) && !err.message.includes('North wing'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TAIL = `\t\tNotes
\t\t(
\t\t\ttype = text
\t\t)
\t\tAmount
\t\t(
\t\t\ttype = decimal
\t\t)
\t}
}
`;

function seedCsv(ds: string): string[][] {
  const seed = generateCreatorImport(deriveIr(parse(ds)), { rows: 12 });
  const file = seed.files.find((entry) => entry.form === 'Add_Lead');
  assert.ok(file, 'Add_Lead import file');
  return parseCsv(file.csv).filter((row) => row.length > 1 || row[0] !== '');
}

function columnsExcept(rows: string[][], skip: string[]): Map<string, string[]> {
  const [header, ...body] = rows;
  const out = new Map<string, string[]>();
  header!.forEach((name, index) => {
    if (!skip.includes(name)) out.set(name, body.map((row) => row[index] ?? ''));
  });
  return out;
}

test('decimal latitude/longitude leave every other seed column as the text sub-fields did', () => {
  const withGeo = DS.replace(/\t\}\n\}\n$/, TAIL);
  // Same app, with the two sub-fields as plain text (what the seed did before).
  const asText = withGeo
    .replace(/latitude\n(\t+)\(\n\t+type = latitude/, 'lat_text\n$1(\n$1\ttype = text')
    .replace(/longitude\n(\t+)\(\n\t+type = longitude/, 'long_text\n$1(\n$1\ttype = text');
  assert.notEqual(asText, withGeo);
  const geoRows = seedCsv(withGeo);
  const textRows = seedCsv(asText);
  assert.ok(geoRows[0]!.includes('Notes') && geoRows[0]!.includes('Amount'), geoRows[0]!.join(','));
  assert.ok(textRows[0]!.includes('Address.lat_text'), textRows[0]!.join(','));
  assert.deepEqual(
    columnsExcept(geoRows, ['Address.latitude', 'Address.longitude']),
    columnsExcept(textRows, ['Address.lat_text', 'Address.long_text']),
  );
});

test('a decimal field with a negative minimum keeps the ordinary decimal seed', () => {
  const signed = DS.replace(/\t\}\n\}\n$/, TAIL.replace('type = decimal', 'type = decimal\n\t\t\tmin = -50\n\t\t\tmax = 50'));
  const plain = DS.replace(/\t\}\n\}\n$/, TAIL);
  const signedAmount = columnsExcept(seedCsv(signed), []).get('Amount');
  assert.ok(signedAmount && signedAmount.length > 0);
  for (const cell of signedAmount) assert.match(cell, /^\d+\.\d{2}$/, `Amount = ${cell}`);
  assert.deepEqual(columnsExcept(seedCsv(signed), ['Amount']), columnsExcept(seedCsv(plain), ['Amount']));
});
