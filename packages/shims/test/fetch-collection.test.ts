import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { translate } from '../../deluge/src/translate.js';
import { createRuntime } from '../src/runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const seedDoc = JSON.parse(readFileSync(path.join(root, 'tests/golden/data-rows.json'), 'utf8')) as {
  form: string;
  rows: Array<{ Name: string; Qty: number; Status: string }>;
};

/** Typed rows of a committed criteria CSV ('true'/'false', integers, text). */
function csvRows(file: string): Record<string, unknown>[] {
  const lines = readFileSync(path.join(root, file), 'utf8').trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const row: Record<string, unknown> = {};
    line.split(',').forEach((cell, i) => {
      row[headers[i]] = cell === 'true' ? true : cell === 'false' ? false : /^-?\d+$/.test(cell) ? Number(cell) : cell;
    });
    return row;
  });
}

async function run(script: string, seed: boolean | Record<string, Record<string, unknown>[]> = true): Promise<unknown> {
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'Asia/Calcutta',
    now: new Date('2026-10-06T08:30:00.000Z'),
    seed: seed === true ? { [seedDoc.form]: seedDoc.rows } : seed === false ? undefined : seed,
  });
  const translated = translate(script);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(
    'shim',
    'ctx',
    `${translated.server}\nreturn typeof golden === 'undefined' ? undefined : golden;`,
  );
  return fn(runtime.shim, runtime.context({ appTimeZone: 'Asia/Calcutta' }));
}

test('getAll on a fetched record collection keeps Creator insertion order', async () => {
  assert.equal(seedDoc.form, 'GoldenRow');
  assert.deepEqual(seedDoc.rows.map((row) => row.Name), ['Ada', 'Bea', 'Ada', 'Cy']);
  assert.deepEqual(await run('golden = GoldenRow[Qty > 0].Name.getAll();'), ['Ada', 'Ada']);
  assert.deepEqual(await run('golden = GoldenRow[Qty < 0].Name.getAll();'), ['Cy']);
  assert.deepEqual(await run('golden = GoldenRow[Qty == 99].Name.getAll();'), []);
  assert.deepEqual(await run('golden = GoldenRow[Name == "Ada"].Qty.getAll();'), [2, 5]);
  assert.deepEqual(await run('golden = GoldenRow[Status == "Open"].Name.getAll();'), ['Ada', 'Bea', 'Cy']);
  assert.deepEqual(await run('golden = GoldenRow[Status == "Open"].Name.getall();'), ['Ada', 'Bea', 'Cy']);
  assert.deepEqual(await run('golden = GoldenRow[Qty != 99].Status.getAll();'), ['Open', 'Open', 'Hold', 'Open']);
  assert.deepEqual(await run('golden = OtherForm[Qty > 0].Name.getAll();'), []);
});

test('distinct on a fetched record collection keeps first-seen field values', async () => {
  assert.deepEqual(await run('golden = GoldenRow[Status == "Open"].distinct(Status);'), ['Open']);
  assert.deepEqual(await run('golden = GoldenRow[Qty != 99].distinct(Name);'), ['Ada', 'Bea', 'Cy']);
  assert.deepEqual(await run('golden = GoldenRow[Qty != 99].distinct(Status);'), ['Open', 'Hold']);
  assert.equal(await run('golden = OtherForm[Qty != 99].distinct(Name);'), null);
});

test('removeElement on a getAll list removes the first match only', async () => {
  assert.deepEqual(
    await run('names = GoldenRow[Status == "Open"].Name.getAll();\nnames.removeElement("Ada");\ngolden = names;'),
    ['Bea', 'Cy'],
  );
  assert.deepEqual(
    await run('names = GoldenRow[Status == "Open"].Name.getAll();\nnames.removeElement("Zed");\ngolden = names;'),
    ['Ada', 'Bea', 'Cy'],
  );
  assert.deepEqual(
    await run('names = GoldenRow[Qty != 99].Name.getAll();\nnames.removeelement("Bea");\ngolden = names;'),
    ['Ada', 'Ada', 'Cy'],
  );
});

async function runSeed(script: string, rows: Record<string, unknown>[]): Promise<unknown> {
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'Asia/Calcutta',
    now: new Date('2026-10-06T08:30:00.000Z'),
    seed: { GoldenRow: rows },
  });
  const translated = translate(script);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(
    'shim',
    'ctx',
    `${translated.server}\nreturn typeof golden === 'undefined' ? undefined : golden;`,
  );
  return fn(runtime.shim, runtime.context({ appTimeZone: 'Asia/Calcutta' }));
}

test('sort by ROWID orders eleven digit ids numerically, not as strings', async () => {
  const rows = Array.from({ length: 11 }, (_, index) => ({
    Name: `n${index}`,
    Qty: 1,
    Status: 'Open',
    ROWID: String(index + 1),
  }));
  const asc = Array.from({ length: 11 }, (_, index) => `n${index}`);
  const desc = Array.from({ length: 11 }, (_, index) => `n${10 - index}`);
  assert.deepEqual(await runSeed('golden = GoldenRow[Qty == 1] sort by ROWID desc.Name.getAll();', rows), desc);
  assert.deepEqual(await runSeed('golden = GoldenRow[Qty == 1] sort by ROWID asc.Name.getAll();', rows), asc);
  // A bare `sort by ROWID` has no direction token, so `.Name` would be read as
  // part of the sort field. The two-statement form is the one the parser accepts.
  assert.deepEqual(
    await runSeed('rows = GoldenRow[Qty == 1] sort by ROWID;\ngolden = rows.Name.getAll();', rows),
    asc,
  );
  assert.deepEqual(await runSeed('golden = GoldenRow[Qty == 1] sort by rowid desc.Name.getAll();', rows), desc);
});

test('dry-run ROWID order keeps 17-digit ids that Number() would collapse', async () => {
  const low = '10000000000315012';
  const high = '10000000000315013';
  assert.equal(Number(low), Number(high));
  const rows = [
    { Name: 'high', Qty: 1, ROWID: high },
    { Name: 'low', Qty: 1, ROWID: low },
    { Name: 'short', Qty: 1, ROWID: '9' },
  ];
  assert.deepEqual(
    await runSeed('rows = GoldenRow[Qty == 1] sort by ROWID;\ngolden = rows.Name.getAll();', rows),
    ['short', 'low', 'high'],
  );
  assert.deepEqual(await runSeed('golden = GoldenRow[Qty == 1] sort by ROWID desc.Name.getAll();', rows), [
    'high',
    'low',
    'short',
  ]);
  const tied = [
    { Name: 'same', Qty: 1, ROWID: high },
    { Name: 'same', Qty: 1, ROWID: low },
  ];
  assert.deepEqual(
    await runSeed('rows = GoldenRow[Qty == 1] sort by Name;\ngolden = rows.ROWID.getAll();', tied),
    [low, high],
  );
});

test('removeAll on a getAll list drops every value present in the other list', async () => {
  assert.deepEqual(
    await run(
      'names = GoldenRow[Qty != 99].Name.getAll();\ndrop = GoldenRow[Name == "Ada"].Name.getAll();\nnames.removeAll(drop);\ngolden = names;',
    ),
    ['Bea', 'Cy'],
  );
  assert.deepEqual(
    await run(
      'names = GoldenRow[Qty != 99].Name.getAll();\ndrop = GoldenRow[Status == "Hold"].Name.getAll();\nnames.removeall(drop);\ngolden = names;',
    ),
    ['Bea', 'Cy'],
  );
});

test('Form[ID == x] finds a migrated row by c2c_source_id and a new row by ROWID', async () => {
  // A migrated row keeps its Creator id in c2c_source_id; an app-created row
  // has only ROWID. `ID == x` finds either (docs/schema-mapping.md).
  const rows = [
    { Name: 'migrated', Qty: 1, ROWID: '900', c2c_source_id: '1000000000000113058' },
    { Name: 'created', Qty: 1, ROWID: '1001' },
    { Name: 'other', Qty: 1, ROWID: '1002', c2c_source_id: '1000000000000113099' },
  ];
  assert.deepEqual(await runSeed('golden = GoldenRow[ID == "1000000000000113058"].Name.getAll();', rows), ['migrated']);
  assert.deepEqual(await runSeed('golden = GoldenRow[ID == 1000000000000113058].Name.getAll();', rows), ['migrated']);
  assert.deepEqual(await runSeed('golden = GoldenRow[ID == "1001"].Name.getAll();', rows), ['created']);
  assert.deepEqual(await runSeed('rows = GoldenRow[ID != "1000000000000113058"];\ngolden = rows.Name.getAll();', rows), [
    'created',
    'other',
  ]);
  // rec.ID round-trips the Catalyst ROWID, and the column read does too.
  assert.deepEqual(await runSeed('golden = GoldenRow[ID == "1000000000000113058"].ID.getAll();', rows), ['900']);
  assert.deepEqual(await runSeed('rows = GoldenRow[Qty == 1] sort by ID;\ngolden = rows.ID.getAll();', rows), [
    '900',
    '1001',
    '1002',
  ]);
});

test('a seeded FlagRow answers the criteria residual cases in CSV order', async () => {
  const part = csvRows('tests/golden/criteria-flagrow.csv');
  const seed = { GoldenRow: seedDoc.rows, FlagRow: part };
  assert.deepEqual(await run('rows = FlagRow[Qty != 99 && Billable == false] sort by Name;\ngolden = rows.Name.getAll();', seed), ['Dee']);
  assert.deepEqual(await run('rows = FlagRow[Billable == true] sort by Name;\ngolden = rows.Name.getAll();', seed), [
    'Ada',
    'Bea',
    'Cy',
  ]);
  assert.deepEqual(
    await run('rows = FlagRow[Status == "Open" && Billable && Approved] sort by Name;\ngolden = rows.Name.getAll();', seed),
    ['Ada'],
  );
  // Without a FlagRow seed the same queries return empty, never an error.
  assert.deepEqual(
    await run('rows = FlagRow[Status == "Open" && Billable && Approved] sort by Name;\ngolden = rows.Name.getAll();'),
    [],
  );
});

test('sort by with several keys orders seed rows by each key in order', async () => {
  const rows = [
    { Name: 'a1', Group: 'x', Added: 2, Qty: 1, ROWID: '1' },
    { Name: 'a2', Group: 'x', Added: 1, Qty: 1, ROWID: '2' },
    { Name: 'b1', Group: 'w', Added: 5, Qty: 1, ROWID: '3' },
    { Name: 'b2', Group: 'w', Added: 4, Qty: 1, ROWID: '4' },
  ];
  assert.deepEqual(
    await runSeed('rows = GoldenRow[Qty != 99] sort by Group,Added desc;\ngolden = rows.Name.getAll();', rows),
    ['b1', 'b2', 'a1', 'a2'],
  );
});

test('field not in list filters a fetched column', async () => {
  const rows = [
    { Name: 'keep', ID: '1', ROWID: '1' },
    { Name: 'drop', ID: '2', ROWID: '2' },
  ];
  assert.deepEqual(
    await runSeed('busy = {"2"};\ngolden = GoldenRow[ID not in busy].Name.getAll();', rows.map((r) => ({ ...r, Qty: 1 }))),
    ['keep'],
  );
});
