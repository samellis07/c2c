/**
 * Store constraints decided from source data, on the load path. A Creator
 * must-have or unique flag is a submit-time rule, so an application backup
 * whose rows disprove it still loads: the column is provisioned without the
 * store constraint and the generated app keeps checking it. A later load that
 * violates a column the recorded plan kept store-level is refused before any
 * write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { deriveIr, parse } from '../../core/src/index.js';
import { emptyCheckpoint } from '../../data/src/migrate.js';
import { quirkRowServer } from '../../data/test/catalyst-row-fake.js';
import { migrateLoaded, migrateSeed, provisionedConstraints, readSourceBackup, readSourceCsv, type CsvLoad } from '../src/index.js';
import { applyConstraintDecisions, generateSchema } from '../../schema/src/index.js';
import type { RestFn } from '../src/tables.js';

const SCOPE = { org: '10000000000', projectId: '1001', token: 'test-cli-token' };

const APP = `application "Inventory Management"
{
form Add_Warehouse
{
must have Warehouse_Name
(
type = text
)
must have Warehouse_Incharge
(
type = text
)
must have unique SKU
(
type = text
)
Stock
(
type = number
)
}
list All_Warehouses
{
show all rows from Add_Warehouse
(
Warehouse_Name as "Warehouse Name"
Warehouse_Incharge as "Warehouse Incharge"
SKU as "SKU"
)
}
}
`;

function appOf(src: string) {
  return deriveIr(parse(src));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A minimal zip writer: deflate members, no extras. Enough to feed readZip. */
function makeZip(parts: Record<string, string | Buffer>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(packed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    local.push(localHeader, nameBytes, packed);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(packed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([centralHeader, nameBytes]));
    offset += localHeader.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, eocd]);
}

const SYS = ['Added_Time', 'Added_User', 'Modified_Time', 'Modified_User', 'Record_Status', 'ZC_Record_Type'];

function csv(headers: string[], rows: string[][]): string {
  const wrap = (cell: string) => `"${cell.replace(/"/g, '""')}"`;
  return [headers.map(wrap).join(','), ...rows.map((row) => row.map(wrap).join(','))].join('\n') + '\n';
}

const W1 = '100000000000357101';
const W2 = '100000000000357102';
const W3 = '100000000000357103';

function warehouseBackup(rows: string[][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-constraints-'));
  const file = join(dir, 'backup.zip');
  writeFileSync(
    file,
    makeZip({
      'inventory-management_v1_x/app_manifest.xml':
        '<app-manifest><app-meta-info><link-name>inventory-management</link-name></app-meta-info></app-manifest>',
      'inventory-management_v1_x/data/data_1.zip': makeZip({
        'data_1/appDataInfo.xml': `<app-data-info><records-count>${rows.length}</records-count></app-data-info>`,
        'data_1/basic#Add_Warehouse.csv': csv([...SYS, 'ID', 'Warehouse_Name', 'Warehouse_Incharge', 'SKU', 'Stock'], rows),
      }),
    }),
  );
  return file;
}

async function migrate(app: ReturnType<typeof appOf>, loaded: CsvLoad) {
  const store = quirkRowServer();
  const result = await migrateLoaded({
    app,
    loaded,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  return { result, store };
}

test('a backup with a must-have column empty on every row loads it as app-mandatory, not a refusal', async () => {
  const app = appOf(APP);
  const file = warehouseBackup([
    ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', W1, 'North', '', 'SKU-1', '4'],
    ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', W2, 'South', '', 'SKU-2', '7'],
    ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', W3, 'East', '', 'SKU-3', '9'],
  ]);
  const loaded = readSourceBackup(file, app);
  const decision = loaded.constraints?.find(
    (item) => item.table === 'Add_Warehouse' && item.column === 'Warehouse_Incharge',
  );
  assert.deepEqual(decision, { table: 'Add_Warehouse', column: 'Warehouse_Incharge', rule: 'mandatory', layer: 'app', violations: 3 });
  assert.equal(loaded.missingMandatory.length, 0, 'the demoted column is not refused at load');
  assert.match(loaded.fidelity.join('\n'), /Add_Warehouse\.Warehouse_Incharge is mandatory but the source holds 3 empty value\(s\)/);
  const { result, store } = await migrate(app, loaded);
  assert.equal(result.ok, true, JSON.stringify(result.integrity));
  assert.equal(store.stored.size, 3);
  assert.equal(store.stored.get(`Add_Warehouse\0${W1}`)?.Warehouse_Incharge, undefined);
});

test('a backup whose unique column repeats a value demotes it to the app layer with the count named', async () => {
  const app = appOf(APP);
  const file = warehouseBackup([
    ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', W1, 'North', 'Rao', 'SKU-1', '4'],
    ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', W2, 'South', 'Rao', 'SKU-1', '7'],
  ]);
  const loaded = readSourceBackup(file, app);
  const decision = loaded.constraints?.find((item) => item.column === 'SKU');
  assert.deepEqual(decision, { table: 'Add_Warehouse', column: 'SKU', rule: 'unique', layer: 'app', violations: 1 });
  assert.match(loaded.fidelity.join('\n'), /Add_Warehouse\.SKU is unique but 1 source row\(s\) repeat a value/);
  const { result } = await migrate(app, loaded);
  assert.equal(result.ok, true, JSON.stringify(result.integrity));
});

function deltaLoad(tables: CsvLoad['tables'], constraints?: CsvLoad['constraints']): CsvLoad {
  return {
    source: 'backup',
    tables,
    expected: tables.map((table) => ({ form: table.table, table: table.table, count: table.rows.length })),
    countsFrom: 'backup',
    foreignKeys: [],
    skipped: [],
    relaxed: [],
    columns: [],
    missingRequired: [],
    missingMandatory: [],
    absentFields: [],
    derivedIds: [],
    lookups: [],
    fidelity: [],
    ignored: [],
    ...(constraints?.length ? { constraints } : {}),
  };
}

test('a later load that leaves a kept store-mandatory column empty is refused before any write', async () => {
  const app = appOf(APP);
  // Warehouse_Incharge stayed is_mandatory at provision: the recorded decisions
  // do not demote it. A delta row without it must not reach the store.
  const loaded = deltaLoad([
    {
      table: 'Add_Warehouse',
      rows: [{ id: W1, columns: { Warehouse_Name: 'North', SKU: 'SKU-9' } }],
    },
  ]);
  const { result, store } = await migrate(app, loaded);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /refused 1 missing mandatory value\(s\) before any write: Add_Warehouse\.Warehouse_Incharge/);
  assert.match(result.error ?? '', /re-provision/);
  assert.equal(store.stored.size, 0, 'nothing is written');
  const group = result.integrity?.refusedByRule.find((item) => item.rule === 'mandatory-missing');
  assert.ok(group?.rows.some((row) => row.column === 'Warehouse_Incharge' && row.sourceId === W1), JSON.stringify(result.integrity));
});

test('a later load that repeats a kept store-unique value is refused before any write', async () => {
  const app = appOf(APP);
  const loaded = deltaLoad([
    {
      table: 'Add_Warehouse',
      rows: [
        { id: W1, columns: { Warehouse_Name: 'North', Warehouse_Incharge: 'Rao', SKU: 'SKU-1' } },
        { id: W2, columns: { Warehouse_Name: 'South', Warehouse_Incharge: 'Rao', SKU: 'SKU-1' } },
      ],
    },
  ]);
  const { result, store } = await migrate(app, loaded);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /constraint violation\(s\) before any write: Add_Warehouse\.SKU/);
  assert.equal(store.stored.size, 0, 'nothing is written');
  assert.ok(result.integrity?.refusedByRule.some((item) => item.rule === 'duplicate-unique'), JSON.stringify(result.integrity));
});

test('a delta load replays recorded demotions: an app-mandatory column accepts the empty cell', async () => {
  const app = appOf(APP);
  const loaded = deltaLoad(
    [
      {
        table: 'Add_Warehouse',
        rows: [{ id: W1, columns: { Warehouse_Name: 'North', SKU: 'SKU-1' } }],
      },
    ],
    [{ table: 'Add_Warehouse', column: 'Warehouse_Incharge', rule: 'mandatory', layer: 'app', violations: 3 }],
  );
  const { result, store } = await migrate(app, loaded);
  assert.equal(result.ok, true, JSON.stringify(result.integrity));
  assert.equal(store.stored.size, 1);
});

test('a report csv that does not carry a must-have column keeps it store-level and refuses before any write', async () => {
  const app = appOf(APP);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-constraints-'));
  writeFileSync(join(dir, 'All_Warehouses.csv'), 'Warehouse Name,SKU\nNorth,SKU-1\nSouth,SKU-2\n');
  const loaded = readSourceCsv(dir, app);
  assert.equal(
    loaded.constraints?.some((item) => item.column === 'Warehouse_Incharge') ?? false,
    false,
    'an uncarried report column is not proven empty',
  );
  assert.equal(loaded.missingMandatory.length, 2, 'every row lacks the kept store-mandatory column');
  const { result, store } = await migrate(app, loaded);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Add_Warehouse\.Warehouse_Incharge/);
  assert.equal(store.stored.size, 0);
});

test('a seed load that repeats a kept store-unique value is refused before any write', async () => {
  const store = quirkRowServer();
  const result = await migrateSeed({
    tables: [
      {
        table: 'Add_Warehouse',
        rows: [
          { id: W1, columns: { Warehouse_Name: 'North', Warehouse_Incharge: 'Rao', SKU: 'SKU-1' } },
          { id: W2, columns: { Warehouse_Name: 'South', Warehouse_Incharge: 'Rao', SKU: 'SKU-1' } },
        ],
      },
    ],
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    dryRun: false,
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
    columnsByTable: { Add_Warehouse: [{ name: 'Warehouse_Incharge', dataType: 'VarChar', required: true }, { name: 'Warehouse_Name', dataType: 'VarChar', required: false }, { name: 'SKU', dataType: 'VarChar', required: false }] },
    uniqueColumnsByTable: { Add_Warehouse: ['SKU'] },
  });
  assert.equal(result.ok, false);
  assert.equal(store.posts.length, 0, 'nothing is written');
  assert.match(result.error ?? '', /constraint violation\(s\) before any write: Add_Warehouse\.SKU/);
  assert.ok(result.integrity?.refusedByRule.some((item) => item.rule === 'duplicate-unique'), JSON.stringify(result.integrity));
});

test('a report csv that carries the must-have column with empty cells demotes it', async () => {
  const app = appOf(APP);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-constraints-'));
  writeFileSync(join(dir, 'All_Warehouses.csv'), 'Warehouse Name,Warehouse Incharge,SKU\nNorth,,SKU-1\nSouth,,SKU-2\n');
  const loaded = readSourceCsv(dir, app);
  const decision = loaded.constraints?.find((item) => item.column === 'Warehouse_Incharge');
  assert.deepEqual(decision, { table: 'Add_Warehouse', column: 'Warehouse_Incharge', rule: 'mandatory', layer: 'app', violations: 2 });
  assert.equal(loaded.missingMandatory.length, 0);
});

/**
 * The provisioned column flags the project reports: Warehouse_Incharge and
 * SKU were created without their Creator constraints, Warehouse_Name kept its
 * is_mandatory, and Stock's flags are unverifiable (unknown → the flag stands).
 */
function warehouseRest(): { rest: RestFn; calls: { method: string; path: string }[] } {
  const calls: { method: string; path: string }[] = [];
  const rest: RestFn = async (call) => {
    calls.push({ method: call.method, path: call.path });
    if (call.method === 'GET' && call.path.endsWith('/table')) {
      return {
        status: 200,
        body: {
          data: [
            {
              table_name: 'Add_Warehouse',
              table_id: 't1',
              column_details: [
                { column_name: 'Warehouse_Name', is_mandatory: true, is_unique: false },
                { column_name: 'Warehouse_Incharge', is_mandatory: false, is_unique: false },
                { column_name: 'SKU', is_mandatory: true, is_unique: false },
                { column_name: 'Stock' },
                { column_name: 'c2c_source_id', is_mandatory: false, is_unique: true },
              ],
            },
          ],
        },
      };
    }
    return { status: 404, body: {} };
  };
  return { rest, calls };
}

test('provisionedConstraints reads the store flags and replays them as decisions', async () => {
  const app = appOf(APP);
  const generated = generateSchema(app);
  const { rest, calls } = warehouseRest();
  const decisions = await provisionedConstraints(rest, '1001', generated);
  assert.deepEqual(decisions, [
    { table: 'Add_Warehouse', column: 'Warehouse_Incharge', rule: 'mandatory', layer: 'app', violations: 0 },
    { table: 'Add_Warehouse', column: 'SKU', rule: 'unique', layer: 'app', violations: 0 },
  ]);
  const replayed = applyConstraintDecisions(generateSchema(app), decisions);
  const table = replayed.tables.find((item) => item.name === 'Add_Warehouse')!;
  const column = (name: string) => table.columns.find((item) => item.name === name)!;
  assert.equal(column('Warehouse_Name').mandatory, true, 'a kept store flag stays');
  assert.equal(column('Warehouse_Incharge').mandatory, false);
  assert.equal(column('Warehouse_Incharge').appMandatory, true);
  assert.equal(column('SKU').unique, false);
  assert.equal(column('SKU').appUnique, true);
  // One list call served every column detail: no per-table read was needed.
  assert.deepEqual(calls.map((item) => `${item.method} ${item.path}`), ['GET /baas/v1/project/1001/table']);
});

test('a delta load replays the provisioned read: a demoted column accepts the empty row a measured schema would refuse', async () => {
  const app = appOf(APP);
  const { rest } = warehouseRest();
  const decisions = await provisionedConstraints(rest, '1001', generateSchema(app));
  // The export does not carry Warehouse_Incharge at all. Its own measure kept
  // the column store-mandatory at read time (the stale missingMandatory entry
  // below); the provisioned demotion lets it load.
  const loaded = {
    ...deltaLoad([
      {
        table: 'Add_Warehouse',
        rows: [{ id: W1, columns: { Warehouse_Name: 'North', SKU: 'SKU-9' } }],
      },
    ]),
    missingMandatory: [{ table: 'Add_Warehouse', column: 'Warehouse_Incharge', sourceId: W1, rule: 'mandatory-missing' as const }],
  };
  const store = quirkRowServer();
  const result = await migrateLoaded({
    app,
    loaded,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
    constraints: decisions,
  });
  assert.equal(result.ok, true, JSON.stringify(result.integrity));
  assert.equal(store.stored.size, 1);
});
