/**
 * A Creator application backup is the complete source: every scalar field in
 * basic# files, lookup target record ids in rel# files, and subform rows with
 * parent links and order. The reader is also where an archive must be refused:
 * a member that escapes the root, an oversized entry, too many entries, a
 * corrupt directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { deriveIr, parse } from '../../core/src/index.js';
import { emptyCheckpoint, type FetchLike } from '../../data/src/migrate.js';
import { quirkRowServer } from '../../data/test/catalyst-row-fake.js';
import { deployCli, formatCsvPlan, migrateLoaded, readSourceBackup, readZip, sourceBackupCli, type Io, type RestFn, type SpawnResult } from '../src/index.js';

const SCOPE = { org: '10000000000', projectId: '1001', token: 'test-cli-token' };
const GUARD = { projectName: 'c2c-test-app', projectId: '1001', org: '10000000000', environment: 'Development', dc: 'in' as const };

const APP = `application "Test App"
{
form Vendor
{
must have unique Vendor_Name
(
type = text
displayname = "Vendor Name"
)
}
form Order_Form
{
must have Title
(
type = text
)
must have Vendor
(
type = picklist
values = Vendor.ID
displayformat = [Vendor_Name]
)
Lines
(
type = grid
must have Item
(
type = text
)
Qty
(
type = number
)
)
Tags
(
type = list
values = Vendor.ID
)
Order_Date
(
type = date
)
Image
(
type = image
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

interface ZipPart {
  data: Buffer;
  method?: 0 | 8;
  /** Override the stored CRC-32, to build a member that fails its check. */
  crc?: number;
  /** Unix mode written into the external attributes, e.g. 0o120777 for a link. */
  attr?: number;
}

/** A minimal zip writer: deflate members, no extras. Enough to feed readZip. */
function makeZip(parts: Record<string, string | Buffer | ZipPart>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    const part: ZipPart =
      typeof content === 'object' && !Buffer.isBuffer(content)
        ? content
        : { data: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8') };
    const data = part.data;
    const method = part.method ?? 8;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const crc = part.crc ?? crc32(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(packed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    local.push(localHeader, nameBytes, packed);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(packed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(((part.attr ?? 0) << 16) >>> 0, 38);
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

/** Offset of the first central-directory signature at or after `from`. */
function centralAt(zip: Buffer, from = 0): number {
  const at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), from);
  if (at < 0) throw new Error('test fixture has no central directory entry');
  return at;
}

const VENDOR_A = '100000000000357101';
const VENDOR_B = '100000000000357102';
const ORDER_A = '100000000000357201';
const ORDER_B = '100000000000357202';
const LINE_A = '100000000000357301';
const LINE_B = '100000000000357302';
const LINE_C = '100000000000357303';

function csv(headers: string[], rows: string[][]): string {
  const wrap = (cell: string) => `"${cell.replace(/"/g, '""')}"`;
  return [headers.map(wrap).join(','), ...rows.map((row) => row.map(wrap).join(','))].join('\n') + '\n';
}

const SYS = ['Added_Time', 'Added_User', 'Modified_Time', 'Modified_User', 'Record_Status', 'ZC_Record_Type'];

function innerMembers(): Record<string, string> {
  return {
    'data_1/appInfo.xml':
      '<info><basic-info><dc>in</dc><backup-time>2026-10-08T12:00:00.000+05:30[Asia/Kolkata]</backup-time></basic-info><app-meta-info><application-link-name>test-app</application-link-name><application-time-zone>Asia/Kolkata</application-time-zone></app-meta-info></info>',
    // records-count covers the top-level form rows (Vendor 2 + Order_Form 2), not subform rows.
    'data_1/appDataInfo.xml': '<app-data-info><records-count>4</records-count></app-data-info>',
    'data_1/appUsers.csv': '"USER_EMAIL","NAME"\n"a@example.test","A"\n"b@example.test","B"\n',
    'data_1/appAdmins.csv': '"USER_EMAIL"\n',
    'data_1/basic#Vendor.csv': csv(
      [...SYS, 'ID', 'Vendor_Name'],
      [
        ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', VENDOR_A, 'Acme'],
        ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', VENDOR_B, 'Northwind'],
      ],
    ),
    'data_1/basic#Order_Form.csv': csv(
      [...SYS, 'ID', 'Image', 'Order_Date', 'Title'],
      [
        ['1791412505000', 'Z:a@example.test', '1791412605000', 'Z:b@example.test', '0', '1', ORDER_A, 'logo.png', '2026-10-08', 'Restock'],
        ['1791412505000', 'Z:a@example.test', '1791412605000', 'Z:b@example.test', '0', '1', ORDER_B, '', '2026-10-09', 'Refill'],
      ],
    ),
    'data_1/basic#Lines@Order_Form.csv': csv(
      [...SYS, 'ID', 'Item', 'Qty'],
      [
        ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', LINE_A, 'Steel', '2'],
        ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', LINE_B, 'Copper', '3'],
        ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', LINE_C, 'Wire', '9'],
      ],
    ),
    'data_1/rel#Vendor#Order_Form.csv': csv(
      ['Order_Form#RECORD_LINK_ID#BASE', 'Vendor#RECORD_LINK_ID#REF'],
      [
        [ORDER_A, VENDOR_A],
        [ORDER_B, VENDOR_B],
      ],
    ),
    'data_1/rel#Tags#Order_Form.csv': csv(
      ['Order_Form#RECORD_LINK_ID#BASE', 'Vendor#RECORD_LINK_ID#REF'],
      [
        [ORDER_A, VENDOR_A],
        [ORDER_A, VENDOR_B],
        [ORDER_B, VENDOR_A],
      ],
    ),
    'data_1/rel#Lines#Order_Form.csv': csv(
      ['Order_Form#RECORD_LINK_ID#BASE', 'ZC_SUBFORM_1#RECORD_LINK_ID#REF'],
      [
        [ORDER_A, LINE_A],
        [ORDER_A, LINE_B],
        [ORDER_B, LINE_C],
      ],
    ),
  };
}

function innerZip(): Buffer {
  return makeZip(innerMembers());
}

function backupZip(): Buffer {
  return makeZip({
    'test-app_v1_test/app_manifest.xml':
      '<app-manifest><backup-info><time>2026-10-08T12:00:00.000+05:30[Asia/Kolkata]</time></backup-info><account-info><dc>in</dc></account-info><app-meta-info><link-name>test-app</link-name></app-meta-info></app-manifest>',
    'test-app_v1_test/meta.zds': 'x',
    'test-app_v1_test/sync.zip': 'x',
    'test-app_v1_test/data/data_1.zip': innerZip(),
  });
}

function backupFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-backup-'));
  const file = join(dir, 'backup.zip');
  writeFileSync(file, backupZip());
  return file;
}

function extractedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-backup-dir-'));
  const root = join(dir, 'test-app_v1_test');
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(
    join(root, 'app_manifest.xml'),
    '<app-manifest><backup-info><time>2026-10-08T12:00:00.000+05:30[Asia/Kolkata]</time></backup-info><account-info><dc>in</dc></account-info><app-meta-info><link-name>test-app</link-name></app-meta-info></app-manifest>',
  );
  writeFileSync(join(root, 'meta.zds'), 'x');
  writeFileSync(join(root, 'sync.zip'), 'x');
  writeFileSync(join(root, 'data', 'data_1.zip'), innerZip());
  return root;
}

test('a backup zip reads form, lookup, multi, and subform rows by record id', () => {
  const loaded = readSourceBackup(backupFile(), appOf(APP));
  assert.equal(loaded.source, 'backup');
  assert.equal(loaded.countsFrom, 'backup');
  const vendor = loaded.tables.find((table) => table.table === 'Vendor')!;
  const order = loaded.tables.find((table) => table.table === 'Order_Form')!;
  const lines = loaded.tables.find((table) => table.table === 'Order_Form__Lines')!;
  const tags = loaded.tables.find((table) => table.table === 'Order_Form__Tags')!;
  assert.equal(vendor.rows.length, 2);
  assert.equal(order.rows.length, 2);
  assert.equal(vendor.rows[0]!.id, VENDOR_A);
  // A 19-digit id survives exactly; a lookup cell is the target record id.
  assert.equal(order.rows.find((row) => row.id === ORDER_A)!.columns.Vendor, VENDOR_A);
  assert.equal(order.rows.find((row) => row.id === ORDER_A)!.columns.Order_Date, '2026-10-08');
  assert.match(String(order.rows[0]!.columns.Added_Time), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // Subform parentage and order come from the rel file, not the row order.
  const [first, second] = lines.rows;
  assert.equal(first!.columns.parent_id, ORDER_A);
  assert.equal(first!.columns.row_order, '0');
  assert.equal(second!.columns.parent_id, ORDER_A);
  assert.equal(second!.columns.row_order, '1');
  assert.equal(lines.rows.find((row) => row.id === LINE_C)!.columns.parent_id, ORDER_B);
  // A multi lookup is one junction row per (base, target) pair.
  assert.equal(tags.rows.length, 3);
  assert.deepEqual(
    tags.rows.map((row) => `${row.columns.parent_id}:${row.columns.Tags}`).sort(),
    [`${ORDER_A}:${VENDOR_A}`, `${ORDER_A}:${VENDOR_B}`, `${ORDER_B}:${VENDOR_A}`],
  );
  // Identities are counted in the plan, never imported into row columns.
  assert.equal(order.rows.every((row) => row.columns.Added_User === undefined), true);
  const plan = formatCsvPlan(loaded, GUARD);
  assert.match(plan, /source: backup/);
  assert.match(plan, /counts: from the backup/);
  assert.match(plan, /Order_Form__Lines source 3/);
  assert.match(plan, /Order_Form__Tags source 3/);
  assert.match(plan, /identity columns: 14 Added_User\/Modified_User\/IP value\(s\) over 3 table\(s\)/);
  assert.match(plan, /Order_Form\.Vendor matches Vendor on record id \(2 backup rows\)/);
  assert.match(plan, /Order_Form__Tags\.Tags matches Vendor on record id \(3 backup rows\)/);
  assert.match(plan, /Order_Form: 1 file\/image cell\(s\)/);
  assert.match(plan, /files: no file payloads/);
});

test('a backup reads the same from an extracted directory', () => {
  const app = appOf(APP);
  const fromZip = formatCsvPlan(readSourceBackup(backupFile(), app), GUARD);
  const fromDir = formatCsvPlan(readSourceBackup(extractedDir(), app), GUARD);
  assert.equal(fromDir, fromZip);
});

test('plan output is deterministic across runs', () => {
  const app = appOf(APP);
  const file = backupFile();
  assert.equal(
    formatCsvPlan(readSourceBackup(file, app), GUARD),
    formatCsvPlan(readSourceBackup(file, appOf(APP)), GUARD),
  );
});

test('--source-backup on a missing path is refused before any plan', async () => {
  const ds = join(mkdtempSync(join(tmpdir(), 'c2c-backup-ds-')), 'app.ds');
  writeFileSync(ds, APP);
  let out = '';
  let err = '';
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env: {},
    cliDc: () => undefined,
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: async () => {
      throw new Error('network refused in this test');
    },
    accessToken: async () => SCOPE.token,
  };
  const code = await sourceBackupCli(['--source-backup', join(mkdtempSync(join(tmpdir(), 'c2c-backup-missing-')), 'no-such.zip'), '--ds', ds, '--project', '1001', '--org', '10000000000'], io);
  assert.notEqual(code, 0);
  assert.equal(out, '');
  assert.match(err, /no such file/);
});

test('--source-backup refuses other source flags and a missing --ds', async () => {
  let err = '';
  const io: Io = {
    stdout: () => undefined,
    stderr: (text) => {
      err += text;
    },
    env: {},
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: async () => {
      throw new Error('network refused');
    },
  };
  assert.equal(await sourceBackupCli(['--source-backup', 'x.zip', '--source-csv', 'd', '--ds', 'a.ds'], io), 2);
  assert.match(err, /not both/);
  err = '';
  assert.equal(await sourceBackupCli(['--source-backup', 'x.zip'], io), 2);
  assert.match(err, /usage: c2c migrate-data --source-backup/);
});

test('a zip member that escapes the archive root is refused', () => {
  assert.throws(() => readZip(makeZip({ '../escape.txt': 'x' })), /escapes the archive root/);
  assert.throws(() => readZip(makeZip({ 'a/../../b.txt': 'x' })), /escapes the archive root/);
  assert.throws(() => readZip(makeZip({ '/abs.txt': 'x' })), /absolute path/);
});

test('oversized and over-count archives are refused', () => {
  const zip = backupZip();
  assert.throws(() => readZip(zip, { maxEntries: 2 }), /entry limit/);
  assert.throws(() => readZip(zip, { maxEntryBytes: 4 }), /\(limit 4\)/);
  assert.throws(() => readZip(Buffer.from('not a zip')), /end-of-central-directory/);
});

test('a truncated or corrupt member is refused, not silently read', () => {
  const zip = Buffer.from(backupZip());
  // Point one central-directory member size past the archive end.
  assert.throws(() => readZip(zip.slice(0, zip.length - 4)), /end-of-central-directory|truncated|past the archive/);
});

test('a backup for a different application is refused', () => {
  const zip = makeZip({
    'other_v1_x/app_manifest.xml': '<app-manifest><app-meta-info><link-name>other-app</link-name></app-meta-info></app-manifest>',
    'other_v1_x/data/data_1.zip': innerZip(),
  });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-backup-'));
  const file = join(dir, 'b.zip');
  writeFileSync(file, zip);
  assert.throws(() => readSourceBackup(file, appOf(APP)), /the backup is application "other-app"/);
});

test('rows with a non-zero Record_Status are not imported', () => {
  const zip = makeZip({
    'test-app_v1_x/app_manifest.xml': '<app-manifest><app-meta-info><link-name>test-app</link-name></app-meta-info></app-manifest>',
    'test-app_v1_x/data/data_1.zip': makeZip({
      'data_1/basic#Vendor.csv': csv(
        [...SYS, 'ID', 'Vendor_Name'],
        [
          ['1', '', '1', '', '0', '1', VENDOR_A, 'Acme'],
          ['1', '', '1', '', '1', '1', VENDOR_B, 'Gone'],
        ],
      ),
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-backup-'));
  const file = join(dir, 'b.zip');
  writeFileSync(file, zip);
  const loaded = readSourceBackup(file, appOf(APP));
  const vendor = loaded.tables.find((table) => table.table === 'Vendor')!;
  assert.deepEqual(vendor.rows.map((row) => row.id), [VENDOR_A]);
  assert.match(formatCsvPlan(loaded, GUARD), /1 row\(s\) with a non-zero Record_Status/);
});

test('plan mode does not call the network', async () => {
  const file = backupFile();
  const ds = join(mkdtempSync(join(tmpdir(), 'c2c-backup-ds-')), 'app.ds');
  writeFileSync(ds, APP);
  let out = '';
  let err = '';
  const fetched: string[] = [];
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env: { X_ZC_CREDENTIAL_PATH: '/tmp/cred-DO-NOT-PRINT' },
    cliDc: () => undefined,
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: (async (url: string) => {
      fetched.push(url);
      throw new Error('network refused in this test');
    }) as FetchLike,
    accessToken: async () => SCOPE.token,
  };
  const code = await sourceBackupCli(['--source-backup', file, '--ds', ds, '--project', '1001', '--org', '10000000000', '--dc', 'in'], io);
  assert.equal(code, 0, err);
  assert.equal(fetched.length, 0);
  assert.match(out, /source: backup/);
  assert.match(out, /writes: no/);
});

test('a confirmed migrate through the loaded shape reuses the guarded loader', async () => {
  const app = appOf(APP);
  const loaded = readSourceBackup(backupFile(), app);
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
  assert.equal(result.ok, true, JSON.stringify(result.tables));
  const stored = (table: string, id: string) => store.stored.get(`${table}\0${id}`);
  // The lookup column holds the target ROWID, not the Creator id.
  assert.equal(String(stored('Order_Form', ORDER_A)!.Vendor), String(stored('Vendor', VENDOR_A)!.ROWID));
  assert.equal(String(stored('Order_Form__Lines', LINE_A)!.parent_id), String(stored('Order_Form', ORDER_A)!.ROWID));
  assert.equal(String(stored('Order_Form__Lines', LINE_A)!.row_order), '0');
  assert.equal(String(stored('Order_Form__Lines', LINE_B)!.row_order), '1');
  assert.equal(String(stored('Order_Form__Tags', `${ORDER_A}__Tags__${VENDOR_B}`)!.Tags), String(stored('Vendor', VENDOR_B)!.ROWID));
});

test('a member whose data fails its CRC-32 check is refused', () => {
  assert.throws(() => readZip(makeZip({ 'a.txt': { data: Buffer.from('hello'), method: 0, crc: 0x12345678 } })), /CRC-32/);
  assert.throws(() => readZip(makeZip({ 'a.txt': { data: Buffer.from('hello'), crc: 0x12345678 } })), /CRC-32/);
  // A stored member carries no second integrity check: one flipped content
  // byte must be caught by the checksum alone.
  const stored = Buffer.from(makeZip({ 'a.txt': { data: Buffer.alloc(64, 65), method: 0 } }));
  stored[40] ^= 0xff;
  assert.throws(() => readZip(stored), /CRC-32/);
});

test('the EOCD entry count must span the whole central directory', () => {
  const zip = Buffer.from(makeZip({ 'a.txt': 'x', 'hidden.txt': 'y' }));
  const eocd = zip.length - 22;
  zip.writeUInt16LE(1, eocd + 8);
  zip.writeUInt16LE(1, eocd + 10);
  assert.throws(() => readZip(zip), /does not span the whole central directory/);
});

test('two central entries may not point at the same local record', () => {
  const zip = Buffer.from(makeZip({ 'a.txt': 'x', 'b.txt': 'y' }));
  const second = centralAt(zip, centralAt(zip) + 1);
  zip.writeUInt32LE(0, second + 42);
  assert.throws(() => readZip(zip), /local record another entry already claims/);
});

test('a local header that disagrees with the central directory is refused', () => {
  const renamed = Buffer.from(makeZip({ 'basic#V.csv': 'x' }));
  renamed[30] = 'z'.charCodeAt(0);
  assert.throws(() => readZip(renamed), /local header/);
  const remoted = Buffer.from(makeZip({ 'a.txt': { data: Buffer.from('x'), method: 0 } }));
  remoted.writeUInt16LE(8, 8);
  assert.throws(() => readZip(remoted), /local method 8 but the directory says 0/);
});

test('symlink-mode entries and outsized deflate ratios are refused', () => {
  assert.throws(
    () => readZip(makeZip({ link: { data: Buffer.from('../../etc/passwd'), method: 0, attr: 0o120777 } })),
    /symbolic link/,
  );
  assert.throws(() => readZip(makeZip({ 'zeros.bin': Buffer.alloc(2 << 20) })), /ratio cap/);
});

test('nested archives share the byte budget with the outer archive', () => {
  const chunk = makeZip({ 'data_1/basic#Vendor.csv': Buffer.alloc(1000, 44) });
  const outer = makeZip({ 'app_manifest.xml': 'x', 'data/data_1.zip': chunk });
  const limits = { maxTotalBytes: 1100 };
  // Each level alone is under the cap; together they exceed it.
  const budget = { used: 0 };
  const entries = readZip(outer, limits, budget);
  assert.throws(() => readZip(entries.find((entry) => entry.name === 'data/data_1.zip')!.data, limits, budget), /byte budget/);
  // Without a shared budget the same two reads pass.
  readZip(outer, limits);
  readZip(chunk, limits);
});

test('two basic# files that alias one table are refused', () => {
  const zip = makeZip({
    'test-app_v1_x/app_manifest.xml': '<app-manifest><app-meta-info><link-name>test-app</link-name></app-meta-info></app-manifest>',
    'test-app_v1_x/data/data_1.zip': makeZip({
      'data_1/appDataInfo.xml': '<app-data-info><records-count>2</records-count></app-data-info>',
      'data_1/basic#Vendor.csv': csv(
        [...SYS, 'ID', 'Vendor_Name'],
        [
          ['1', '', '1', '', '0', '1', VENDOR_A, 'Acme'],
          ['1', '', '1', '', '0', '1', VENDOR_B, 'Northwind'],
        ],
      ),
      'data_1/basic#VENDOR.csv': csv([...SYS, 'ID', 'Vendor_Name'], [['1', '', '1', '', '0', '1', '100000000000357103', 'Third']]),
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-backup-'));
  const file = join(dir, 'b.zip');
  writeFileSync(file, zip);
  assert.throws(() => readSourceBackup(file, appOf(APP)), /both load into Vendor/);
});

test('a member that looks like form data but fits no shape is refused, and payload members are ignored with a reason', () => {
  const withStray = makeZip({
    'test-app_v1_x/app_manifest.xml': '<app-manifest><app-meta-info><link-name>test-app</link-name></app-meta-info></app-manifest>',
    'test-app_v1_x/data/data_1.zip': makeZip({
      'data_1/appDataInfo.xml': '<app-data-info><records-count>2</records-count></app-data-info>',
      'data_1/basic#Vendor.csv': csv(
        [...SYS, 'ID', 'Vendor_Name'],
        [
          ['1', '', '1', '', '0', '1', VENDOR_A, 'Acme'],
          ['1', '', '1', '', '0', '1', VENDOR_B, 'Northwind'],
        ],
      ),
      'data_1/basic#Vendor#extra.csv': csv([...SYS, 'ID', 'Vendor_Name'], [['1', '', '1', '', '0', '1', '100000000000357104', 'Lost']]),
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-backup-'));
  const stray = join(dir, 'stray.zip');
  writeFileSync(stray, withStray);
  assert.throws(() => readSourceBackup(stray, appOf(APP)), /looks like form or relation data/);
  const withPayload = makeZip({
    'test-app_v1_x/app_manifest.xml': '<app-manifest><app-meta-info><link-name>test-app</link-name></app-meta-info></app-manifest>',
    'test-app_v1_x/data/data_1.zip': makeZip({
      'data_1/appDataInfo.xml': '<app-data-info><records-count>2</records-count></app-data-info>',
      'data_1/basic#Vendor.csv': csv(
        [...SYS, 'ID', 'Vendor_Name'],
        [
          ['1', '', '1', '', '0', '1', VENDOR_A, 'Acme'],
          ['1', '', '1', '', '0', '1', VENDOR_B, 'Northwind'],
        ],
      ),
      'data_1/logo.png': Buffer.from('png'),
      'data_1/readme.txt': 'hi',
    }),
  });
  const payload = join(dir, 'payload.zip');
  writeFileSync(payload, withPayload);
  const loaded = readSourceBackup(payload, appOf(APP));
  assert.deepEqual(loaded.ignored.filter((name) => name.startsWith('logo.png') || name.startsWith('readme.txt')), [
    'logo.png (file payload, not uploaded by this loader)',
    'readme.txt (file payload, not uploaded by this loader)',
  ]);
});

test('records-count in appDataInfo.xml must match the top-level form rows', () => {
  const build = (count: string) =>
    makeZip({
      'test-app_v1_x/app_manifest.xml': '<app-manifest><app-meta-info><link-name>test-app</link-name></app-meta-info></app-manifest>',
      'test-app_v1_x/data/data_1.zip': makeZip({
        'data_1/appDataInfo.xml': `<app-data-info><records-count>${count}</records-count></app-data-info>`,
        'data_1/basic#Vendor.csv': csv(
          [...SYS, 'ID', 'Vendor_Name'],
          [
            ['1', '', '1', '', '0', '1', VENDOR_A, 'Acme'],
            ['1', '', '1', '', '1', '1', VENDOR_B, 'Gone'],
          ],
        ),
      }),
    });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-backup-'));
  const wrong = join(dir, 'rc.zip');
  writeFileSync(wrong, build('400'));
  assert.throws(() => readSourceBackup(wrong, appOf(APP)), /records-count is 400 but the backup holds 2 top-level form row/);
  // Record_Status-skipped rows still count, so a count of 2 with one skip is right.
  const file = join(dir, 'ok.zip');
  writeFileSync(file, build('2'));
  const loaded = readSourceBackup(file, appOf(APP));
  assert.deepEqual(loaded.tables.find((table) => table.table === 'Vendor')!.rows.map((row) => row.id), [VENDOR_A]);
  assert.match(formatCsvPlan(loaded, GUARD), /records-count 2 matches the 2 top-level form row/);
});

test('a lookup to a skipped record is left empty and its children are skipped, not written parentless', async () => {
  const zip = makeZip({
    'test-app_v1_x/app_manifest.xml': '<app-manifest><app-meta-info><link-name>test-app</link-name></app-meta-info></app-manifest>',
    'test-app_v1_x/data/data_1.zip': makeZip({
      'data_1/appDataInfo.xml': '<app-data-info><records-count>4</records-count></app-data-info>',
      'data_1/basic#Vendor.csv': csv(
        [...SYS, 'ID', 'Vendor_Name'],
        [
          ['1', '', '1', '', '0', '1', VENDOR_A, 'Acme'],
          ['1', '', '1', '', '1', '1', VENDOR_B, 'Gone'],
        ],
      ),
      'data_1/basic#Order_Form.csv': csv(
        [...SYS, 'ID', 'Title'],
        [
          ['1', '', '1', '', '0', '1', ORDER_A, 'T1'],
          ['1', '', '1', '', '0', '1', ORDER_B, 'T2'],
        ],
      ),
      'data_1/basic#Lines@Order_Form.csv': csv(
        [...SYS, 'ID', 'Item', 'Qty'],
        [
          ['1', '', '1', '', '0', '1', LINE_A, 'a', '1'],
          ['1', '', '1', '', '0', '1', LINE_B, 'b', '2'],
        ],
      ),
      'data_1/rel#Vendor#Order_Form.csv': csv(
        ['Order_Form#RECORD_LINK_ID#BASE', 'Vendor#RECORD_LINK_ID#REF'],
        [
          [ORDER_A, VENDOR_A],
          [ORDER_B, VENDOR_B],
        ],
      ),
      'data_1/rel#Lines#Order_Form.csv': csv(['Order_Form#RECORD_LINK_ID#BASE', 'ZC_SUBFORM_1#RECORD_LINK_ID#REF'], [[ORDER_A, LINE_A]]),
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-backup-'));
  const file = join(dir, 'b.zip');
  writeFileSync(file, zip);
  const app = appOf(APP);
  const loaded = readSourceBackup(file, app);
  const order = loaded.tables.find((table) => table.table === 'Order_Form')!;
  assert.equal(order.rows.find((row) => row.id === ORDER_B)!.columns.Vendor, undefined);
  const lines = loaded.tables.find((table) => table.table === 'Order_Form__Lines')!;
  assert.deepEqual(lines.rows.map((row) => row.id), [LINE_A]);
  assert.match(loaded.fidelity.join('\n'), /rel#Vendor#Order_Form\.csv: 1 relation row\(s\) name a target id not in the backup; the link is not written/);
  assert.match(loaded.fidelity.join('\n'), /Order_Form__Lines: 1 row\(s\) skipped — the backup rel files link them to no live parent/);
  // Vendor is a Creator-mandatory column the source disproved: ORDER_B's link
  // was left empty, so the column is provisioned not mandatory and the existing
  // row loads — the generated app still requires the field on new writes.
  assert.ok(
    loaded.constraints?.some(
      (decision) => decision.table === 'Order_Form' && decision.column === 'Vendor' && decision.rule === 'mandatory' && decision.layer === 'app',
    ),
    JSON.stringify(loaded.constraints),
  );
  assert.equal(loaded.missingMandatory.length, 0, 'an app-mandatory column is not refused at load');
  assert.match(loaded.fidelity.join('\n'), /Order_Form\.Vendor is mandatory but the source holds 1 empty value\(s\)/);
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
  assert.equal(result.ok, true, JSON.stringify(result.integrity));
  assert.equal(
    [...store.stored.keys()].every((key) => !key.startsWith('Order_Form__Lines') || store.stored.get(key)!.parent_id !== undefined),
    true,
  );
});

test('an extracted backup directory refuses symlinks and non-regular files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-backup-dir-'));
  const root = join(dir, 'test-app_v1_test');
  mkdirSync(join(root, 'data', 'data_1'), { recursive: true });
  writeFileSync(join(root, 'app_manifest.xml'), '<app-manifest><app-meta-info><link-name>test-app</link-name></app-meta-info></app-manifest>');
  writeFileSync(join(dir, 'outside.csv'), csv([...SYS, 'ID', 'Vendor_Name'], [['1', '', '1', '', '0', '1', VENDOR_A, 'x']]));
  symlinkSync(join(dir, 'outside.csv'), join(root, 'data', 'data_1', 'basic#Vendor.csv'));
  assert.throws(() => readSourceBackup(root, appOf(APP)), /symbolic link/);
});

test('a basic# column that maps a relation column is ignored with a reason', () => {
  const zip = makeZip({
    'test-app_v1_x/app_manifest.xml': '<app-manifest><app-meta-info><link-name>test-app</link-name></app-meta-info></app-manifest>',
    'test-app_v1_x/data/data_1.zip': makeZip({
      'data_1/appDataInfo.xml': '<app-data-info><records-count>4</records-count></app-data-info>',
      'data_1/basic#Vendor.csv': csv(
        [...SYS, 'ID', 'Vendor_Name'],
        [
          ['1', '', '1', '', '0', '1', VENDOR_A, 'Acme'],
          ['1', '', '1', '', '0', '1', VENDOR_B, 'Northwind'],
        ],
      ),
      'data_1/basic#Order_Form.csv': csv(
        [...SYS, 'ID', 'Title', 'Vendor'],
        [
          ['1', '', '1', '', '0', '1', ORDER_A, 'T1', 'Acme'],
          ['1', '', '1', '', '0', '1', ORDER_B, 'T2', 'Northwind'],
        ],
      ),
      'data_1/basic#Lines@Order_Form.csv': csv(
        [...SYS, 'ID', 'Item', 'Qty'],
        [
          ['1', '', '1', '', '0', '1', LINE_A, 'a', '1'],
          ['1', '', '1', '', '0', '1', LINE_B, 'b', '2'],
          ['1', '', '1', '', '0', '1', LINE_C, 'c', '3'],
        ],
      ),
      'data_1/rel#Lines#Order_Form.csv': csv(
        ['Order_Form#RECORD_LINK_ID#BASE', 'ZC_SUBFORM_1#RECORD_LINK_ID#REF'],
        [
          [ORDER_A, LINE_A],
          [ORDER_A, LINE_B],
          [ORDER_B, LINE_C],
        ],
      ),
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-backup-'));
  const file = join(dir, 'b.zip');
  writeFileSync(file, zip);
  const loaded = readSourceBackup(file, appOf(APP));
  const order = loaded.tables.find((table) => table.table === 'Order_Form')!;
  assert.equal(order.rows.every((row) => row.columns.Vendor === undefined), true);
  const note = loaded.columns.find((item) => item.file === 'basic#Order_Form.csv')!;
  assert.ok(note.unmapped.some((item) => item.header === 'Vendor' && /rel# files/.test(item.reason)));
});

test('a cell holding only U+000E reads as empty in every member; the same character inside text stays', async () => {
  const SO = '\u000e';
  const NAMES_APP = `application "Names"
{
form Add_User
{
must have Mail_ID
(
type = email
)
Name
(
type = name
)
Note
(
type = text
)
}
}
`;
  const ID_A = '100000000000357401';
  const ID_B = '100000000000357402';
  const zip = makeZip({
    'names_v1_x/app_manifest.xml': '<app-manifest><app-meta-info><link-name>names</link-name></app-meta-info></app-manifest>',
    'names_v1_x/data/data_1.zip': makeZip({
      'data_1/appDataInfo.xml': '<app-data-info><records-count>2</records-count></app-data-info>',
      'data_1/appUsers.csv': `"USER_EMAIL","NAME","FIRST_NAME","LAST_NAME"\n"a@example.test","${SO}","Ada","${SO}"\n"${SO}","${SO}","${SO}","${SO}"\n`,
      'data_1/basic#Add_User.csv': csv(
        [...SYS, 'ID', 'Mail_ID', 'Name.prefix', 'Name.first_name', 'Name.last_name', 'Name.suffix', 'Note'],
        [
          ['1', '', '1', '', '0', '1', ID_A, 'a@example.test', SO, 'Ada', 'Lovelace', SO, SO],
          ['1', '', '1', '', '0', '1', ID_B, 'b@example.test', 'Dr.', 'Grace', `Hop${SO}per`, 'Jr.', `x${SO}y`],
        ],
      ),
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-backup-'));
  const file = join(dir, 'names.zip');
  writeFileSync(file, zip);
  const app = appOf(NAMES_APP);
  const loaded = readSourceBackup(file, app);
  const table = loaded.tables.find((item) => item.table === 'Add_User')!;
  const a = table.rows.find((row) => row.id === ID_A)!;
  // A lone U+000E is the backup's empty: the column stays unset, whether it is
  // a composite part or a plain field. The composite with all-empty parts
  // writes nothing, matching the export path.
  assert.equal(a.columns.Name_prefix, undefined);
  assert.equal(a.columns.Name_suffix, undefined);
  assert.equal(a.columns.Note, undefined);
  assert.equal(a.columns.Name_first_name, 'Ada');
  assert.equal(a.columns.Name_last_name, 'Lovelace');
  const b = table.rows.find((row) => row.id === ID_B)!;
  assert.equal(b.columns.Name_prefix, 'Dr.');
  assert.equal(b.columns.Name_last_name, `Hop${SO}per`);
  assert.equal(b.columns.Note, `x${SO}y`);
  // appUsers.csv uses the same rule: a row left holding no value drops out.
  assert.match(loaded.notes?.join('\n') ?? '', /appUsers\.csv 1 row\(s\)/);

  // A re-run against cells already stored empty is unchanged, not a silent
  // change: the empty cell reads equal to a stored NULL.
  const store = quirkRowServer();
  store.addStored('Add_User', { c2c_source_id: ID_A, ROWID: '1', ...a.columns, Name_prefix: null, Name_suffix: null, Note: null });
  const result = await migrateLoaded({
    app,
    loaded,
    dc: 'in',
    catalystBase: 'https://api.catalyst.zoho.in',
    fetch: store.fetch,
    checkpoint: emptyCheckpoint(),
    scope: SCOPE,
  });
  assert.equal(result.ok, true, JSON.stringify(result.integrity?.refusedByRule ?? []));
  assert.deepEqual(
    store.posts.map((batch) => batch.map((row) => String(row.c2c_source_id))),
    [[ID_B]],
  );
  assert.equal(store.puts.length, 0);
});

test('duplicate headers are refused and extra cells are reported', () => {
  const build = (vendorCsv: string) =>
    makeZip({
      'test-app_v1_x/app_manifest.xml': '<app-manifest><app-meta-info><link-name>test-app</link-name></app-meta-info></app-manifest>',
      'test-app_v1_x/data/data_1.zip': makeZip({
        'data_1/appDataInfo.xml': '<app-data-info><records-count>2</records-count></app-data-info>',
        'data_1/basic#Vendor.csv': vendorCsv,
      }),
    });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-backup-'));
  const dup = join(dir, 'dup.zip');
  writeFileSync(
    dup,
    build(csv([...SYS, 'ID', 'Vendor_Name', 'Vendor_Name'], [['1', '', '1', '', '0', '1', VENDOR_A, 'a', 'b']])),
  );
  assert.throws(() => readSourceBackup(dup, appOf(APP)), /repeats header "Vendor_Name"/);
  const extra = join(dir, 'extra.zip');
  writeFileSync(
    extra,
    build(
      `"Added_Time","Added_User","Modified_Time","Modified_User","Record_Status","ZC_Record_Type","ID","Vendor_Name"\n"1","","1","","0","1","${VENDOR_A}","Acme","EXTRA"\n"1","","1","","0","1","${VENDOR_B}","North"\n`,
    ),
  );
  const loaded = readSourceBackup(extra, appOf(APP));
  assert.match(loaded.fidelity.join('\n'), /basic#Vendor\.csv: 1 row\(s\) carry cells past the last header; the extra values are ignored/);
});

/**
 * Constraint decisions are settled at provision time, not re-measured on each
 * load. The fake store records the is_mandatory/is_unique flags deploy posts
 * and reports them back on the table list; a confirmed load that violates a
 * kept constraint must refuse before a token is minted or a row is written.
 */
interface LiveTable {
  id: string;
  columns: Map<string, { mandatory?: boolean; unique?: boolean }>;
}

function provisionStore() {
  const tables = new Map<string, LiveTable>();
  const restCalls: { method: string; path: string }[] = [];
  // APP_LIVE has a file column, so the provisioned function env carries the
  // app bucket name — the post-deploy read-back requires C2C_STRATUS_BUCKET.
  let functionVariables: Record<string, string> = { C2C_DEPLOY_MODE: 'live', C2C_STRATUS_BUCKET: 'c2c-test-app-00000000', C2C_MAIL_FROM: 'owner@example.test', API_KEY: '' };
  let seq = 1;
  const prefix = `/baas/v1/project/${SCOPE.projectId}`;
  const columnDetails = (table: LiveTable) =>
    [...table.columns].map(([column_name, flags]) => ({
      column_name,
      is_mandatory: flags.mandatory === true,
      is_unique: flags.unique === true,
    }));
  const rest: RestFn = async (call) => {
    restCalls.push({ method: call.method, path: call.path });
    if (call.method === 'GET' && call.path === prefix) {
      return {
        status: 200,
        body: {
          data: {
            id: SCOPE.projectId,
            project_name: GUARD.projectName,
            env_details: [{ env_name: 'Development', env_zgid: SCOPE.org, id: SCOPE.org }],
          },
        },
      };
    }
    if (call.method === 'GET' && call.path === `${prefix}/table`) {
      return {
        status: 200,
        body: { data: [...tables].map(([table_name, table]) => ({ table_name, table_id: table.id, column_details: columnDetails(table) })) },
      };
    }
    if (call.method === 'GET' && call.path === `${prefix}/function`) return { status: 200, body: { data: [{ function_name: 'c2c_api', function_id: 'f1' }] } };
    if (call.method === 'GET' && call.path === `${prefix}/function/f1`) return { status: 200, body: { data: { configuration: { environment: { variables: functionVariables } } } } };
    if (call.method === 'POST' && call.path === `${prefix}/function/f1/configuration`) {
      functionVariables = { ...(call.body as { variables: Record<string, string> }).variables };
      return { status: 200, body: { status: 'success' } };
    }
    if (call.method === 'POST' && call.path === `${prefix}/table`) {
      const id = `t${seq++}`;
      tables.set((call.body as { table_name: string }).table_name, { id, columns: new Map() });
      return { status: 200, body: { data: { table_id: id } } };
    }
    const columns = call.path.match(new RegExp(`^${prefix}/table/([^/]+)/column$`));
    if (call.method === 'POST' && columns) {
      const table = [...tables.values()].find((item) => item.id === columns[1]);
      for (const column of call.body as { column_name: string; is_mandatory?: boolean; is_unique?: boolean }[]) {
        table?.columns.set(column.column_name, { mandatory: column.is_mandatory, unique: column.is_unique });
      }
      return { status: 200, body: { status: 'success' } };
    }
    const detail = call.path.match(new RegExp(`^${prefix}/table/([^/]+)$`));
    if (call.method === 'GET' && detail) {
      const table = [...tables.values()].find((item) => item.id === detail[1]);
      if (!table) return { status: 404, body: {} };
      return { status: 200, body: { data: { column_details: columnDetails(table) } } };
    }
    // Opened services answer their first-use gate probes (Slate app list, Stratus bucket list).
    if (call.method === 'GET' && /^\/(slate|baas)\/v1\/project\/[0-9]+\/(app|bucket)$/.test(call.path)) return { status: 200, body: { status: 'success', data: [] } };
    return { status: 404, body: {} };
  };
  return { tables, rest, restCalls, functionVariables: () => functionVariables };
}

function confirmIo(store: ReturnType<typeof provisionStore>): {
  io: Io;
  out: () => string;
  err: () => string;
  fetches: string[];
  tokens: () => number;
} {
  let out = '';
  let err = '';
  const fetches: string[] = [];
  let tokens = 0;
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env: { X_ZC_CREDENTIAL_PATH: '/tmp/cred-DO-NOT-PRINT' },
    cliDc: () => 'in',
    spawn: async (_command: string, args: string[]) => {
      if (args.includes('project:list')) {
        return {
          code: 0,
          stdout:
            '┌───────────────────────┬────────────┐\n' +
            '│     Project Name      │ Project ID │\n' +
            '├───────────────────────┼────────────┤\n' +
            `│ ${GUARD.projectName} (active) │ ${SCOPE.projectId}       │\n` +
            '└───────────────────────┴────────────┘\n',
          stderr: '',
        } satisfies SpawnResult;
      }
      if (args.includes('slate:link')) return { code: 0, stdout: 'App Url: https://test-app-abc123.onslate.in\n', stderr: '' } satisfies SpawnResult;
      return { code: 0, stdout: '', stderr: '' } satisfies SpawnResult;
    },
    fetch: (async (url: string) => {
      fetches.push(url);
      throw new Error('a refused load must not reach the row API');
    }) as FetchLike,
    rest: store.rest,
    accessToken: async () => {
      tokens += 1;
      return SCOPE.token;
    },
  };
  return { io, out: () => out, err: () => err, fetches, tokens: () => tokens };
}

test('deploy CLI applies secret env by fake Catalyst API without exposing it in output or generated files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-secret-cli-'));
  const ds = join(dir, 'app.ds');
  const outDir = join(dir, 'out');
  const envFile = join(dir, 'function-env.json');
  const plant = 'never-print-this-secret-value';
  writeFileSync(ds, APP_LIVE);
  writeFileSync(envFile, JSON.stringify({ API_KEY: plant, C2C_MAIL_FROM: 'owner@example.test' }));
  const store = provisionStore();
  const cap = confirmIo(store);
  const code = await deployCli([ds, '--out', outDir, '--project', SCOPE.projectId, '--org', SCOPE.org, '--dc', 'in', '--confirm', '--function-env', envFile, '--ui', 'vanilla'], cap.io);
  assert.equal(code, 0, cap.err());
  assert.equal(store.functionVariables().API_KEY, plant);
  assert.equal(store.functionVariables().C2C_DEPLOY_MODE, 'live');
  assert.ok(store.restCalls.some((call) => call.method === 'POST' && call.path.endsWith('/function/f1/configuration')));
  assert.doesNotMatch(`${cap.out()}${cap.err()}`, new RegExp(plant));
  const scan = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? scan(child) : [readFileSync(child, 'utf8')];
  });
  assert.ok(scan(outDir).every((contents) => !contents.includes(plant)));
});

// A live deploy refuses a .ds without the application time zone; the same app
// with the setting keeps every table, column, and constraint identical.
const APP_LIVE = APP.replace('application "Test App"\n{', 'application "Test App"\n{\ntime zone = "Asia/Kolkata"');

test('deploy without a source, then a confirmed backup violating the kept mandatory refuses before any write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-b1-'));
  const ds = join(dir, 'app.ds');
  writeFileSync(ds, APP_LIVE);
  const store = provisionStore();
  // Deploy with no data source: Title stays store-mandatory and Vendor_Name
  // stays store-unique, exactly as the schema generator decided.
  const deploy = confirmIo(store);
  const deployCode = await deployCli([ds, '--out', join(dir, 'out'), '--project', SCOPE.projectId, '--org', SCOPE.org, '--dc', 'in', '--confirm', '--function-env', 'new', '--ui', 'vanilla'], deploy.io);
  assert.equal(deployCode, 0, deploy.err());
  assert.equal(store.tables.get('Order_Form')?.columns.get('Title')?.mandatory, true);
  assert.equal(store.tables.get('Vendor')?.columns.get('Vendor_Name')?.unique, true);

  const bad = join(dir, 'bad.zip');
  writeFileSync(
    bad,
    makeZip({
      'test-app_v1_test/app_manifest.xml':
        '<app-manifest><backup-info><time>2026-10-08T12:00:00.000+05:30[Asia/Kolkata]</time></backup-info><account-info><dc>in</dc></account-info><app-meta-info><link-name>test-app</link-name></app-meta-info></app-manifest>',
      'test-app_v1_test/data/data_1.zip': makeZip({
        ...innerMembers(),
        'data_1/basic#Order_Form.csv': csv(
          [...SYS, 'ID', 'Image', 'Order_Date', 'Title'],
          [
            ['1791412505000', 'Z:a@example.test', '1791412605000', 'Z:b@example.test', '0', '1', ORDER_A, 'logo.png', '2026-10-08', ''],
            ['1791412505000', 'Z:a@example.test', '1791412605000', 'Z:b@example.test', '0', '1', ORDER_B, '', '2026-10-09', 'Refill'],
          ],
        ),
      }),
    }),
  );
  const before = store.restCalls.length;
  const load = confirmIo(store);
  const code = await sourceBackupCli(['--source-backup', bad, '--ds', ds, '--project', SCOPE.projectId, '--org', SCOPE.org, '--dc', 'in', '--confirm'], load.io);
  assert.equal(code, 1);
  assert.match(load.err(), /Order_Form\.Title/);
  assert.match(load.err(), /nothing was written/);
  assert.equal(load.fetches.length, 0);
  assert.equal(load.tokens(), 0);
  // The project check and the constraint read are the only REST traffic; no write lands.
  assert.equal(store.restCalls.slice(before).filter((call) => call.method === 'POST').length, 0);
});

test('a confirmed backup repeating a kept store-unique value refuses before any row write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-b1-'));
  const ds = join(dir, 'app.ds');
  writeFileSync(ds, APP_LIVE);
  const store = provisionStore();
  const deploy = confirmIo(store);
  assert.equal(
    await deployCli([ds, '--out', join(dir, 'out'), '--project', SCOPE.projectId, '--org', SCOPE.org, '--dc', 'in', '--confirm', '--function-env', 'new', '--ui', 'vanilla'], deploy.io),
    0,
    deploy.err(),
  );
  assert.equal(store.tables.get('Vendor')?.columns.get('Vendor_Name')?.unique, true);

  const dup = join(dir, 'dup.zip');
  writeFileSync(
    dup,
    makeZip({
      'test-app_v1_test/app_manifest.xml':
        '<app-manifest><backup-info><time>2026-10-08T12:00:00.000+05:30[Asia/Kolkata]</time></backup-info><account-info><dc>in</dc></account-info><app-meta-info><link-name>test-app</link-name></app-meta-info></app-manifest>',
      'test-app_v1_test/data/data_1.zip': makeZip({
        ...innerMembers(),
        'data_1/basic#Vendor.csv': csv(
          [...SYS, 'ID', 'Vendor_Name'],
          [
            ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', VENDOR_A, 'Acme'],
            ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', VENDOR_B, 'Acme'],
          ],
        ),
      }),
    }),
  );
  const before = store.restCalls.length;
  const load = confirmIo(store);
  const code = await sourceBackupCli(['--source-backup', dup, '--ds', ds, '--project', SCOPE.projectId, '--org', SCOPE.org, '--dc', 'in', '--confirm'], load.io);
  assert.equal(code, 1);
  assert.match(load.err(), /Vendor\.Vendor_Name/);
  assert.equal(load.fetches.length, 0);
  assert.equal(store.restCalls.slice(before).filter((call) => call.method === 'POST').length, 0);
});

// A bidirectional lookup stores the link once, on the forward side: the backup
// carries the reverse column's values in rel#<forward field>#<forward form>.csv.
const BIDIRECTIONAL_APP = `application "Carry App"
{
form Add_Warehouse
{
must have Warehouse_Name
(
type = text
)
must have Warehouse_Incharge
(
type = picklist
values = Add_Staffs[Warehouse_Code.ID is null].ID
bidirectional = Warehouse_Code
)
}
form Add_Staffs
{
must have Staff_Name
(
type = text
)
Warehouse_Code
(
type = picklist
values = Add_Warehouse.ID
bidirectional = Warehouse_Incharge
)
}
}
`;

const HOUSE_N = '100000000000357501';
const HOUSE_S = '100000000000357502';
const STAFF_A = '100000000000357601';
const STAFF_B = '100000000000357602';

test('a bidirectional reverse column is carried from the forward rel file', () => {
  const zip = makeZip({
    'carry-app_v1_x/app_manifest.xml':
      '<app-manifest><backup-info><time>2026-10-08T12:00:00.000+05:30[Asia/Kolkata]</time></backup-info><account-info><dc>in</dc></account-info><app-meta-info><link-name>carry-app</link-name></app-meta-info></app-manifest>',
    'carry-app_v1_x/data/data_1.zip': makeZip({
      'data_1/appInfo.xml':
        '<info><basic-info><dc>in</dc><backup-time>2026-10-08T12:00:00.000+05:30[Asia/Kolkata]</backup-time></basic-info><app-meta-info><application-link-name>carry-app</application-link-name></app-meta-info></info>',
      'data_1/appDataInfo.xml': '<app-data-info><records-count>4</records-count></app-data-info>',
      'data_1/appUsers.csv': '"USER_EMAIL","NAME"\n"a@example.test","A"\n',
      'data_1/appAdmins.csv': '"USER_EMAIL"\n',
      'data_1/basic#Add_Warehouse.csv': csv(
        [...SYS, 'ID', 'Warehouse_Name'],
        [
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', HOUSE_N, 'North'],
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', HOUSE_S, 'South'],
        ],
      ),
      'data_1/basic#Add_Staffs.csv': csv(
        [...SYS, 'ID', 'Staff_Name'],
        [
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', STAFF_A, 'Arun'],
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', STAFF_B, 'Latha'],
        ],
      ),
      'data_1/rel#Warehouse_Code#Add_Staffs.csv': csv(
        ['Add_Staffs#RECORD_LINK_ID#BASE', 'Add_Warehouse#RECORD_LINK_ID#REF'],
        [
          [STAFF_A, HOUSE_N],
          [STAFF_B, HOUSE_S],
        ],
      ),
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-bidir-'));
  const file = join(dir, 'backup.zip');
  writeFileSync(file, zip);
  const loaded = readSourceBackup(file, appOf(BIDIRECTIONAL_APP));
  const staff = loaded.tables.find((table) => table.table === 'Add_Staffs')!;
  const warehouse = loaded.tables.find((table) => table.table === 'Add_Warehouse')!;
  assert.equal(staff.rows.find((row) => row.id === STAFF_A)!.columns.Warehouse_Code, HOUSE_N);
  assert.equal(staff.rows.find((row) => row.id === STAFF_B)!.columns.Warehouse_Code, HOUSE_S);
  // The reverse column is filled from the same pairs, as the staff record id.
  assert.equal(warehouse.rows.find((row) => row.id === HOUSE_N)!.columns.Warehouse_Incharge, STAFF_A);
  assert.equal(warehouse.rows.find((row) => row.id === HOUSE_S)!.columns.Warehouse_Incharge, STAFF_B);
  // Every must-have row holds a value: nothing is demoted and nothing is refused.
  assert.equal(loaded.missingMandatory.length, 0);
  const plan = formatCsvPlan(loaded, GUARD);
  assert.match(plan, /Add_Staffs\.Warehouse_Code matches Add_Warehouse on record id \(2 backup rows\)/);
  assert.match(plan, /Add_Warehouse\.Warehouse_Incharge matches Add_Staffs on record id \(2 backup rows\)/);
});

const U1 = '100000000000357701';
const U2 = '100000000000357702';
const V1 = '100000000000357801';
const V2 = '100000000000357802';
const V3 = '100000000000357803';

// A bidirectional pair where the reverse side is a filtered multi lookup: the
// schema stores it as a junction table, so every linked id lands as one
// junction row per pair.
test('a bidirectional filtered multi reverse fills the reverse junction', () => {
  const app = appOf(`application "Fleet"
{
form Add_User
{
must have User_Name
(
type = text
)
Owned_Vehicles
(
type = list
values = Add_Vehicle[Owner.ID is null].ID
bidirectional = Owner
)
}
form Add_Vehicle
{
must have Vehicle_Name
(
type = text
)
Owner
(
type = picklist
values = Add_User.ID
bidirectional = Owned_Vehicles
)
}
}
`);
  const zip = makeZip({
    'fleet_v1_x/app_manifest.xml': '<app-manifest><app-meta-info><link-name>fleet</link-name></app-meta-info></app-manifest>',
    'fleet_v1_x/data/data_1.zip': makeZip({
      'data_1/appInfo.xml': '<info><app-meta-info><application-link-name>fleet</application-link-name></app-meta-info></info>',
      'data_1/basic#Add_User.csv': csv(
        [...SYS, 'ID', 'User_Name'],
        [
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', U1, 'Ana'],
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', U2, 'Ben'],
        ],
      ),
      'data_1/basic#Add_Vehicle.csv': csv(
        [...SYS, 'ID', 'Vehicle_Name'],
        [
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', V1, 'Van'],
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', V2, 'Truck'],
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', V3, 'Bike'],
        ],
      ),
      'data_1/rel#Owner#Add_Vehicle.csv': csv(
        ['Add_Vehicle#RECORD_LINK_ID#BASE', 'Add_User#RECORD_LINK_ID#REF'],
        [
          [V1, U1],
          [V2, U1],
          [V3, U2],
        ],
      ),
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-bidir-multi-'));
  const file = join(dir, 'backup.zip');
  writeFileSync(file, zip);
  const loaded = readSourceBackup(file, app);
  const reverse = loaded.tables.find((table) => table.table === 'Add_User__Owned_Vehicles')!;
  assert.deepEqual(
    reverse.rows.map((row) => `${row.columns.parent_id}:${row.columns.Owned_Vehicles}`).sort(),
    [`${U1}:${V1}`, `${U1}:${V2}`, `${U2}:${V3}`],
  );
  const plan = formatCsvPlan(loaded, GUARD);
  assert.match(plan, /Add_User__Owned_Vehicles\.Owned_Vehicles matches Add_Vehicle on record id \(3 backup rows\)/);
});

// A list-to-list bidirectional pair stores one link set but maps to a junction
// on each side: the rel file fills both, each with its own parent order.
test('a bidirectional list-to-list pair fills both junction tables', () => {
  const C1 = '100000000000357901';
  const C2 = '100000000000357902';
  const T1 = '100000000000358001';
  const T2 = '100000000000358002';
  const app = appOf(`application "Gym"
{
form Add_Class
{
must have Class_Name
(
type = text
)
Trainees
(
type = list
values = Add_Trainee.ID
bidirectional = Classes
)
}
form Add_Trainee
{
must have Trainee_Name
(
type = text
)
Classes
(
type = list
values = Add_Class.ID
bidirectional = Trainees
)
}
}
`);
  const zip = makeZip({
    'gym_v1_x/app_manifest.xml': '<app-manifest><app-meta-info><link-name>gym</link-name></app-meta-info></app-manifest>',
    'gym_v1_x/data/data_1.zip': makeZip({
      'data_1/appInfo.xml': '<info><app-meta-info><application-link-name>gym</application-link-name></app-meta-info></info>',
      'data_1/basic#Add_Class.csv': csv(
        [...SYS, 'ID', 'Class_Name'],
        [
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', C1, 'Yoga'],
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', C2, 'Lift'],
        ],
      ),
      'data_1/basic#Add_Trainee.csv': csv(
        [...SYS, 'ID', 'Trainee_Name'],
        [
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', T1, 'Ana'],
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', T2, 'Ben'],
        ],
      ),
      'data_1/rel#Trainees#Add_Class.csv': csv(
        ['Add_Class#RECORD_LINK_ID#BASE', 'Add_Trainee#RECORD_LINK_ID#REF'],
        [
          [C1, T1],
          [C1, T2],
          [C2, T2],
        ],
      ),
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-bidir-lists-'));
  const file = join(dir, 'backup.zip');
  writeFileSync(file, zip);
  const loaded = readSourceBackup(file, app);
  const forward = loaded.tables.find((table) => table.table === 'Add_Class__Trainees')!;
  assert.deepEqual(
    forward.rows.map((row) => `${row.columns.parent_id}:${row.columns.Trainees}`).sort(),
    [`${C1}:${T1}`, `${C1}:${T2}`, `${C2}:${T2}`],
  );
  const reverse = loaded.tables.find((table) => table.table === 'Add_Trainee__Classes')!;
  assert.deepEqual(
    reverse.rows.map((row) => `${row.columns.parent_id}:${row.columns.Classes}`).sort(),
    [`${T1}:${C1}`, `${T2}:${C1}`, `${T2}:${C2}`],
  );
});

const FIXTURES = process.env.C2C_FIXTURES_DIR;
const INVENTORY_DS = FIXTURES ? join(FIXTURES, 'gallery', 'inventory-management', 'Inventory_Management.ds') : '';
const INVENTORY_ZIP = FIXTURES ? join(FIXTURES, 'creator-backups', 'inventory-management--inventory-management_v1_08-Oct-2026_12_14_47.zip') : '';
const hasInventory =
  !!FIXTURES &&
  !!statSync(INVENTORY_DS, { throwIfNoEntry: false })?.isFile() &&
  !!statSync(INVENTORY_ZIP, { throwIfNoEntry: false })?.isFile();

/**
 * The expectations below were derived from one export of the app and one
 * backup archive; the record ids inside are not stable across exports, so a
 * different file pair is skipped by sha256 rather than asserting stale ids.
 */
const INVENTORY_SHA256 = {
  ds: 'da6d59bec2b38558f9d8da2c4aaaebfa9928e692e59bdc63e35ce506d05275b4',
  zip: 'ff8266ae48e80187855f54d78a9c743c034663aeb41b0cfc9c422aca6de39513',
};
const inventorySkip = !hasInventory
  ? 'C2C_FIXTURES_DIR inventory fixture not available'
  : createHash('sha256').update(readFileSync(INVENTORY_DS)).digest('hex') !== INVENTORY_SHA256.ds ||
      createHash('sha256').update(readFileSync(INVENTORY_ZIP)).digest('hex') !== INVENTORY_SHA256.zip
    ? 'C2C_FIXTURES_DIR inventory fixture differs from the export these expectations were measured on'
    : undefined;

test(
  'the inventory backup carries both Warehouse_Incharge values from the reverse rel file',
  { skip: inventorySkip },
  () => {
    const app = appOf(readFileSync(INVENTORY_DS, 'utf8'));
    const loaded = readSourceBackup(INVENTORY_ZIP, app);
    const warehouse = loaded.tables.find((table) => table.table === 'Add_Warehouse')!;
    const staffIds = new Set(loaded.tables.find((table) => table.table === 'Add_Staffs')!.rows.map((row) => row.id));
    // Both warehouse rows carry the reverse-rel value, each a staff record id.
    const staffed = warehouse.rows.filter((row) => row.columns.Warehouse_Incharge !== undefined);
    assert.equal(staffed.length, 2);
    assert.ok(staffed.every((row) => staffIds.has(String(row.columns.Warehouse_Incharge))));
    // The carried column is complete: the must-have stands and nothing is refused.
    assert.equal(loaded.missingMandatory.length, 0);
    assert.equal(loaded.constraints?.length ?? 0, 0);
    const plan = formatCsvPlan(loaded, GUARD);
    assert.match(plan, /Add_Warehouse\.Warehouse_Incharge matches Add_Staffs on record id \(2 backup rows\)/);
  },
);


/** A filtered lookup inside a subform: `values = Vendor[ID > 0].ID` on a grid field. */
const FILTERED_APP = `application "Test App"
{
form Vendor
{
must have unique Vendor_Name
(
type = text
)
}
form Order_Form
{
Title
(
type = text
)
Lines
(
type = grid
Ref
(
type = picklist
values = Vendor[ID > 0].ID
displayformat = [Vendor_Name]
)
Qty
(
type = number
)
)
}
}
`;

function zipFile(content: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-backup-'));
  const file = join(dir, 'backup.zip');
  writeFileSync(file, content);
  return file;
}

function filteredBackupZip(): Buffer {
  return makeZip({
    'test-app_v1_test/app_manifest.xml':
      '<app-manifest><app-meta-info><link-name>test-app</link-name></app-meta-info></app-manifest>',
    'test-app_v1_test/data/data_1.zip': makeZip({
      'data_1/appInfo.xml':
        '<info><basic-info><dc>in</dc></basic-info><app-meta-info><application-link-name>test-app</application-link-name><application-time-zone>Asia/Kolkata</application-time-zone></app-meta-info></info>',
      'data_1/appDataInfo.xml': '<app-data-info><records-count>3</records-count></app-data-info>',
      'data_1/basic#Vendor.csv': csv(
        [...SYS, 'ID', 'Vendor_Name'],
        [
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', VENDOR_A, 'Acme'],
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', VENDOR_B, 'Northwind'],
        ],
      ),
      'data_1/basic#Order_Form.csv': csv(
        [...SYS, 'ID', 'Title'],
        [['1791412505000', 'Z:a@example.test', '1791412605000', 'Z:b@example.test', '0', '1', ORDER_A, 'Restock']],
      ),
      'data_1/basic#Lines@Order_Form.csv': csv(
        [...SYS, 'ID', 'Qty'],
        [
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', LINE_A, '2'],
          ['1791412505000', 'Z:a@example.test', '1791412505000', 'Z:a@example.test', '0', '1', LINE_B, '3'],
        ],
      ),
      'data_1/rel#Lines#Order_Form.csv': csv(
        ['Order_Form#RECORD_LINK_ID#BASE', 'ZC_SUBFORM_1#RECORD_LINK_ID#REF'],
        [
          [ORDER_A, LINE_A],
          [ORDER_A, LINE_B],
        ],
      ),
      'data_1/rel#Ref#Lines@Order_Form.csv': csv(
        ['ZC_SUBFORM_1#RECORD_LINK_ID#BASE', 'Vendor#RECORD_LINK_ID#REF'],
        [
          [LINE_A, VENDOR_A],
          [LINE_B, VENDOR_B],
        ],
      ),
    }),
  });
}

test('a filtered lookup inside a subform is a foreign key remap in the backup plan', () => {
  const loaded = readSourceBackup(zipFile(filteredBackupZip()), appOf(FILTERED_APP));
  const lines = loaded.tables.find((table) => table.table === 'Order_Form__Lines')!;
  assert.equal(lines.rows.find((row) => row.id === LINE_A)!.columns.Ref, VENDOR_A);
  assert.equal(lines.rows.find((row) => row.id === LINE_B)!.columns.Ref, VENDOR_B);
  assert.ok(
    loaded.foreignKeys.some((key) => key.table === 'Order_Form__Lines' && key.column === 'Ref' && key.parent === 'Vendor'),
  );
  const plan = formatCsvPlan(loaded, GUARD);
  assert.match(plan, /Order_Form__Lines\.Ref matches Vendor on record id \(2 backup rows\)/);
  assert.doesNotMatch(plan, /filtered lookup|written as text/);
});

test('a backup with a lookup column and no remap is a plan error, before any row is read', () => {
  const app = appOf(`application "Test App"
{
form Book
{
Title
(
type = text
)
Author
(
type = picklist
values = Missing.ID
)
}
}
`);
  const zip = makeZip({
    'x_v1_t/app_manifest.xml': '<app-manifest/>',
    'x_v1_t/data/data_1.zip': makeZip({}),
  });
  assert.throws(() => readSourceBackup(zipFile(zip), app), /lookup Book\.Author has no remap/);
});
