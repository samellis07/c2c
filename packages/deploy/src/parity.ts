/**
 * Data parity (quality-gate Q6): the loaded Creator export against the rows the
 * Data Store holds, per table — row counts first, then a per-record canonical
 * hash keyed by c2c_source_id.
 *
 * Source record counts are independently read from raw JSON report files,
 * before CsvLoad materializes them. Canonical cells follow the writer's
 * preparation rules. Cells are
 * normalised the way the loader normalises them: decimals and doubles compare
 * through canonDecimal (exact, trailing zeros fold), dates and date-times
 * through the write-rules canonical instant, boolean text folds, file/image/
 * audio/video/signature cells compare by their deterministic Stratus key
 * `migrated/<form>/<field>/<id>/<name>` (shims `migratedObjectKey`), and a
 * lookup cell compares by the parent record's source id — the store holds the
 * parent ROWID, so the stored cell is translated back through the parent's
 * stored rows before the compare. NULL and empty are the same cell.
 *
 * The stored side is injected: a `StoreRows` map (rollback's type) the caller
 * fills from `readStoreRows` (live ZCQL pages) or `parseStoreRows` (a
 * `<table>.json` dump). The check itself never touches the network.
 *
 * The report names source ids only — never a cell value. A table mismatches on
 * a count gap, a missing or extra source id, a changed record, a stored
 * duplicate of one source id, or an unattributed stored row (no c2c_source_id).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../../core/src/ir.js';
import { canonRow, changedColumns, isEmptyCell, prepareColumns, type IntegrityRefusal } from '../../data/src/integrity.js';
import { checksumHex, fnv1a64 } from '../../data/src/migrate.js';
import { applyConstraintDecisions, fileColumnsOf, generateSchema } from '../../schema/src/generator.js';
import { SOURCE_ID_COLUMN } from '../../schema/src/mapping.js';
import { migratedObjectKey } from '../../shims/src/files.js';
import { flag, loadApp, type Io } from './cli.js';
import { loaderColumns, readSourceCsv, readSourceJson, type CsvLoad } from './csv.js';
import { readSourceBackup } from './backup.js';
import { GuardError } from './guards.js';
import { parseStoreRows, type StoreRows } from './rollback.js';
import { DELTA_SOURCES } from './delta-cli.js';

function rawJsonRecordCounts(dir: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of readdirSync(dir).filter((entry) => entry.toLowerCase().endsWith('.json')).sort()) {
    const value = JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown;
    const report = value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value as Record<string, unknown>)[0] : value;
    if (Array.isArray(report)) counts.set(name.replace(/\.json$/i, ''), report.length);
  }
  return counts;
}

function rawCountFor(table: string, loaded: CsvLoad, raw: ReadonlyMap<string, number> | undefined): number | undefined {
  const rawCount = loaded.columns.filter((column) => column.table === table && column.rawCount !== undefined).reduce((sum, column) => sum + (column.rawCount ?? 0), 0);
  if (loaded.columns.some((column) => column.table === table && column.rawCount !== undefined)) return rawCount;
  if (!raw) return undefined;
  const note = loaded.columns.find((column) => column.table === table && raw.has(column.file.replace(/\.json$/i, '')));
  return note ? raw.get(note.file.replace(/\.json$/i, '')) : raw.get(table);
}

export interface ParityTableReport {
  table: string;
  /** Rows the export holds for this table. */
  sourceCount: number;
  /** Rows the store holds, whether or not they carry c2c_source_id. */
  storedCount: number;
  /** Source ids the store does not hold. */
  missingIds: string[];
  /** Stored source ids the export does not hold. */
  extraIds: string[];
  /** Source ids present on both sides whose stored row differs. */
  changedIds: string[];
  /** Source ids the store holds more than once. */
  duplicateIds: string[];
  /** Stored rows carrying no c2c_source_id — counted, never listed. */
  unattributed: number;
  /** Source cells the write rules refused before compare (id + column + rule only). */
  refusals: IntegrityRefusal[];
  /** Stable reasons that make this table fail Q6. */
  reasons: string[];
  /** FNV-1a 64 over canonical source/stored ids and cells; includes extra stored records. */
  sourceChecksum: string;
  storedChecksum: string;
  mismatch: boolean;
}

export interface DataParityReport {
  ok: boolean;
  /** Stable overall reasons that make Q6 fail. */
  reasons: string[];
  tables: ParityTableReport[];
  skipped: CsvLoad['skipped'];
}

/** The schema the loader measures this source on: source-informed when the load carried rows. */
function paritySchema(app: App, loaded: CsvLoad) {
  return loaded.sourceData
    ? generateSchema(app, { source: loaded.sourceData })
    : applyConstraintDecisions(generateSchema(app), loaded.constraints ?? []);
}

function dataKeys(row: Record<string, unknown>): string[] {
  return Object.keys(row).filter((key) => key !== 'ROWID' && key !== SOURCE_ID_COLUMN);
}

/**
 * A stored file cell equals the source cell when it holds the migrated object
 * key for this record, or the source text itself (the report loaders store the
 * cell as exported). Both sides empty is equal.
 */
function sameFileCells(
  fileCells: Record<string, unknown>,
  stored: Record<string, unknown>,
  files: { form: string; columns: string[] },
  sourceId: string,
): boolean {
  for (const [column, value] of Object.entries(fileCells)) {
    const text = value === undefined || value === null ? '' : String(value);
    const cell = stored[column];
    const storedText = cell === undefined || cell === null ? '' : String(cell);
    if (!text && !storedText) continue;
    if (storedText === text) continue;
    if (text && storedText === migratedObjectKey(files.form, column, sourceId, text)) continue;
    return false;
  }
  // A stored file cell the source never sent must read back as empty too.
  for (const column of files.columns) {
    if (Object.hasOwn(fileCells, column)) continue;
    if (!isEmptyCell(stored[column])) return false;
  }
  return true;
}

/** Empty and missing cells canon as the same token on both sides of a compare. */
function canonCells(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const cells: Record<string, unknown> = {};
  for (const key of keys) cells[key] = isEmptyCell(row[key]) ? undefined : row[key];
  return cells;
}

/**
 * Compare a loaded source against stored rows, table by table. `stored` maps a
 * Data Store table name to every row it holds (each row as ZCQL returns it:
 * ROWID plus column names). A table absent from the map reads as empty.
 */
export function dataParity(opts: { app: App; loaded: CsvLoad; stored: StoreRows; rawSourceCounts?: ReadonlyMap<string, number> }): DataParityReport {
  const { app, loaded, stored, rawSourceCounts } = opts;
  const schema = paritySchema(app, loaded);
  const columnsByTable = loaderColumns(schema, loaded.tables, loaded.foreignKeys);
  const filesByTable = fileColumnsOf(schema);
  // Lookup cells store the parent's ROWID; parity keys on source ids, so a
  // stored cell is translated back through the parent's stored rows.
  const sourceByRowid = new Map<string, Map<string, string>>();
  for (const [table, rows] of stored) {
    const byRowid = new Map<string, string>();
    for (const row of rows) {
      const rowid = row.ROWID;
      const source = row[SOURCE_ID_COLUMN];
      if (rowid !== undefined && rowid !== null && source !== undefined && source !== null) {
        byRowid.set(String(rowid), String(source));
      }
    }
    sourceByRowid.set(table, byRowid);
  }
  const keysByTable = new Map<string, { column: string; parent: string }[]>();
  for (const key of loaded.foreignKeys) {
    const list = keysByTable.get(key.table) ?? [];
    list.push({ column: key.column, parent: key.parent });
    keysByTable.set(key.table, list);
  }
  const tables: ParityTableReport[] = [];
  for (const table of loaded.tables) {
    const columns = columnsByTable[table.table];
    const files = filesByTable[table.table];
    const foreignKeys = keysByTable.get(table.table) ?? [];
    // Stored rows keyed by source id; rows without one cannot be keyed.
    const storedById = new Map<string, Record<string, unknown>[]>();
    let unattributed = 0;
    for (const raw of stored.get(table.table) ?? []) {
      const row = { ...raw };
      for (const key of foreignKeys) {
        const value = row[key.column];
        if (value === undefined || value === null || value === '') continue;
        const source = sourceByRowid.get(key.parent)?.get(String(value));
        if (source !== undefined) row[key.column] = source;
      }
      const id = row[SOURCE_ID_COLUMN];
      if (id === undefined || id === null || id === '') {
        unattributed += 1;
        continue;
      }
      const list = storedById.get(String(id)) ?? [];
      list.push(row);
      storedById.set(String(id), list);
    }
    const duplicateIds = [...storedById.entries()].filter(([, rows]) => rows.length > 1).map(([id]) => id).sort();
    const missingIds: string[] = [];
    const changedIds: string[] = [];
    const refusals: IntegrityRefusal[] = [];
    const fileColumns = new Set(files?.columns ?? []);
    const canonById = new Map<string, { payload: Record<string, unknown>; keys: string[]; canon: string; fileCells: Record<string, unknown> }>();
    for (const row of table.rows) {
      const cells: Record<string, unknown> = { ...row.columns };
      // File columns compare outside the payload: the store holds either the
      // deterministic `migrated/…` key (the Creator-API loader writes it) or
      // the export's raw cell text (the report loaders write it) — both are the
      // same file, so both spellings pass.
      const fileCells: Record<string, unknown> = {};
      for (const column of fileColumns) {
        if (!Object.hasOwn(cells, column)) continue;
        fileCells[column] = cells[column];
        delete cells[column];
      }
      const prepared = prepareColumns(columns, cells);
      for (const refusal of prepared.refusals) {
        refusals.push({ table: table.table, column: refusal.column, sourceId: row.id, rule: refusal.rule });
      }
      const payload = { ...prepared.cells, [SOURCE_ID_COLUMN]: row.id };
      const keys = dataKeys(payload);
      canonById.set(row.id, { payload, keys, canon: canonRow(canonCells(payload, keys), keys, columns), fileCells });
    }
    const dupeSet = new Set(duplicateIds);
    const extraIds = [...storedById.keys()].filter((id) => !canonById.has(id)).sort();
    const storedCanons = new Map<string, string>();
    for (const [id, entry] of canonById) {
      const rows = storedById.get(id) ?? [];
      if (rows.length === 0 || dupeSet.has(id)) {
        if (rows.length === 0) missingIds.push(id);
        continue;
      }
      const stored = rows[0]!;
      // The same read-back compare the loader's end-of-table verify runs: a
      // stored spelling of the same value (a :SSS fraction, a trailing Z,
      // Boolean text, NULL for empty) is not a change. The compare covers the
      // union of sent and stored columns: a stored data cell the payload
      // never sent must read back as empty.
      const storedKeys = dataKeys(stored).filter((key) => !fileColumns.has(key));
      const unionKeys = [...new Set([...entry.keys, ...storedKeys])].sort();
      const unwritten = storedKeys.filter((key) => !Object.hasOwn(entry.payload, key) && !isEmptyCell(stored[key]));
      const changed =
        changedColumns(entry.payload, stored, columns).length > 0 ||
        unwritten.length > 0 ||
        (files !== undefined && !sameFileCells(entry.fileCells, stored, files, id));
      if (changed) changedIds.push(id);
      // Each side's checksum folds its own cells over the union key set, so a
      // stored-only column can never hide behind the source canon.
      entry.canon = canonRow(canonCells(entry.payload, unionKeys), unionKeys, columns);
      storedCanons.set(id, canonRow(canonCells(stored, unionKeys), unionKeys, columns));
    }
    missingIds.sort();
    changedIds.sort();
    // FNV_OFFSET basis, matching migrate.ts; fold sorted ids so both sides walk
    // the same order.
    const FNV_OFFSET = 0xcbf29ce484222325n;
    let state = FNV_OFFSET;
    for (const id of [...canonById.keys()].sort()) state = fnv1a64(state, `${id}\x00${canonById.get(id)!.canon}`);
    const sourceChecksum = checksumHex(state);
    state = FNV_OFFSET;
    for (const id of [...canonById.keys()].sort()) state = fnv1a64(state, `${id}\x00${storedCanons.get(id) ?? '-'}`);
    for (const id of duplicateIds) {
      const duplicateCanons = storedById.get(id)!.map((row) => canonRow(row, dataKeys(row), columns)).sort();
      state = fnv1a64(state, `${id}\x00duplicate:${duplicateCanons.join('\x01')}`);
    }
    for (const id of extraIds) state = fnv1a64(state, `${id}\x00${storedById.get(id)!.map((row) => canonRow(row, dataKeys(row), columns)).join('\x01')}`);
    for (const row of (stored.get(table.table) ?? []).filter((item) => item[SOURCE_ID_COLUMN] === undefined || item[SOURCE_ID_COLUMN] === null || item[SOURCE_ID_COLUMN] === '')) {
      state = fnv1a64(state, `unattributed\x00${canonRow(row, dataKeys(row), columns)}`);
    }
    const storedChecksum = checksumHex(state);
    const storedCount = (stored.get(table.table) ?? []).length;
    const reasons: string[] = [];
    if ((rawCountFor(table.table, loaded, rawSourceCounts) ?? table.rows.length) !== storedCount) reasons.push('Q6_COUNT_MISMATCH');
    if (missingIds.length > 0 || extraIds.length > 0) reasons.push('Q6_COUNT_MISMATCH');
    if (changedIds.length > 0) reasons.push('Q6_CHECKSUM_MISMATCH');
    if (duplicateIds.length > 0 || unattributed > 0) reasons.push('Q6_CHECKSUM_MISMATCH');
    if (refusals.length > 0) reasons.push('Q6_REFUSED_WRITE');
    const mismatch = reasons.length > 0;
    tables.push({
      table: table.table,
      sourceCount: table.rows.length,
      storedCount,
      missingIds,
      extraIds,
      changedIds,
      duplicateIds,
      unattributed,
      refusals,
      reasons: [...new Set(reasons)],
      sourceChecksum,
      storedChecksum,
      mismatch,
    });
  }
  const skipped = loaded.skipped ?? [];
  const reasons: string[] = [];
  if (tables.length === 0) reasons.push('Q6_NO_TABLES');
  if (skipped.length > 0) reasons.push('Q6_SKIPPED_TABLE');
  if (tables.length > 0 && tables.every((table) => table.sourceCount === 0) &&
      tables.reduce((sum, table) => sum + (rawCountFor(table.table, loaded, rawSourceCounts) ?? table.sourceCount), 0) === 0) {
    reasons.push('Q6_EMPTY_ONLY');
  }
  if (tables.some((table) => table.reasons.includes('Q6_COUNT_MISMATCH'))) reasons.push('Q6_COUNT_MISMATCH');
  if (tables.some((table) => table.reasons.includes('Q6_CHECKSUM_MISMATCH'))) reasons.push('Q6_CHECKSUM_MISMATCH');
  if (tables.some((table) => table.reasons.includes('Q6_REFUSED_WRITE'))) reasons.push('Q6_REFUSED_WRITE');
  return { ok: reasons.length === 0 && tables.length > 0 && tables.every((table) => !table.mismatch), reasons, tables, skipped };
}

/** One stored row per table from a dump directory of `<table>.json` files (parseStoreRows shape). */
export function storeRowsFromDir(dir: string, tables: readonly string[]): Map<string, Record<string, unknown>[]> {
  const names = new Set(readdirSync(dir));
  const out = new Map<string, Record<string, unknown>[]>();
  for (const table of tables) {
    const file = `${table}.json`;
    if (!names.has(file)) throw new GuardError('configuration', `${join(dir, file)} is missing — dump every loaded table's stored rows`);
    out.set(table, parseStoreRows(table, readFileSync(join(dir, file), 'utf8')));
  }
  return out;
}

/** Text report: one line per table, then id lists. Counts and ids only. */
export function formatParity(report: DataParityReport): string {
  const lines = ['c2c data-parity v1'];
  for (const item of report.skipped) lines.push(`${item.table}: SKIPPED (${item.detail})`);
  for (const table of report.tables) {
    lines.push(
      `${table.table}: source ${table.sourceCount} stored ${table.storedCount} ` +
        `${table.mismatch ? 'MISMATCH' : 'match'} src ${table.sourceChecksum} stored ${table.storedChecksum}`,
    );
    if (table.missingIds.length) lines.push(`  missing: ${table.missingIds.join(', ')}`);
    if (table.extraIds.length) lines.push(`  extra: ${table.extraIds.join(', ')}`);
    if (table.changedIds.length) lines.push(`  changed: ${table.changedIds.join(', ')}`);
    if (table.duplicateIds.length) lines.push(`  duplicate: ${table.duplicateIds.join(', ')}`);
    if (table.unattributed) lines.push(`  unattributed stored rows: ${table.unattributed}`);
    if (table.refusals.length) {
      lines.push(`  refused: ${table.refusals.map((item) => `${item.column} ${item.rule} (${item.sourceId})`).join(', ')}`);
    }
  }
  if (report.reasons.length) lines.push(`reasons: ${report.reasons.join(', ')}`);
  lines.push(report.ok ? 'parity: ok' : 'parity: MISMATCH');
  return `${lines.join('\n')}\n`;
}

const VERIFY_USAGE =
  'usage: c2c verify --data-parity --ds <file|dir> (--source-json <dir> | --source-csv <dir> | --source-backup <zip|dir>) --rows <dir> [--allow-empty] [--json] [--out <file>]\n' +
  '       compares the export the loader reads with the stored rows dumped as <rows>/<Table>.json\n' +
  '       (a row array or a ZCQL {data:[...]} body, one file per loaded table). Ids only, never values.\n' +
  '       Exit 0 parity, 1 mismatch, 2 usage.\n';

/**
 * `c2c verify --data-parity` — the offline checker. The live read (ZCQL pages
 * via readStoreRows, behind the project guard) is a separate step; today --rows
 * names a directory of stored-row dumps.
 */
export function verifyCli(args: readonly string[], io: Io): number {
  try {
    if (!args.includes('--data-parity')) {
      io.stderr(VERIFY_USAGE);
      return 2;
    }
    // Literal flag reads: the argv census reconciles these against ARGV_SPEC.
    const source = (['json', 'csv', 'backup'] as const).filter((kind) =>
      kind === 'json' ? args.includes('--source-json') : kind === 'csv' ? args.includes('--source-csv') : args.includes('--source-backup'),
    );
    const ds = flag(args, '--ds');
    const rowsDir = flag(args, '--rows');
    if (source.length !== 1 || !ds || !rowsDir) {
      io.stderr(VERIFY_USAGE);
      return 2;
    }
    const kind = source[0]!;
    const sourcePath = flag(args, kind === 'json' ? '--source-json' : kind === 'csv' ? '--source-csv' : '--source-backup');
    if (!sourcePath) {
      io.stderr(VERIFY_USAGE);
      return 2;
    }
    const app = loadApp(ds);
    const allowEmpty = args.includes('--allow-empty');
    const loaded = DELTA_SOURCES[kind]!(sourcePath, app, allowEmpty);
    const stored = storeRowsFromDir(rowsDir, loaded.tables.map((table) => table.table));
    const rawSourceCounts = kind === 'json' ? rawJsonRecordCounts(sourcePath) : undefined;
    const report = dataParity({ app, loaded, stored, rawSourceCounts });
    const out = flag(args, '--out');
    const text = args.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : formatParity(report);
    if (out) {
      writeFileSync(out, text);
    } else {
      io.stdout(text);
    }
    return report.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof GuardError) {
      io.stderr(`c2c verify: ${err.message}\n`);
      return 2;
    }
    io.stderr(`c2c verify: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
