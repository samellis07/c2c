/**
 * Rollback export: Data Store rows back to CSV files Creator's report
 * "Import Data" accepts, one per form, so the Creator app can take the data
 * back if a cut-over is reversed.
 *
 * Headers are field link names; a name or address part is `Field.part`.
 * Dates are dd-MMM-yyyy and date-times dd-MMM-yyyy HH:mm:ss. Booleans are
 * true/false. A multi-select is one comma-separated cell. A lookup is the
 * parent's display value, per the field's display format, because the importer
 * matches lookups on it; when the format is the record id, or two parents show
 * the same value, the cell is the parent's record id and the export lists it.
 * The last column, ID, is the Creator record id (c2c_source_id): leave it
 * unmapped on import. ids/<Form>.ids.csv maps every row to its record id, ROWID
 * and lookup record ids. A form over the column cap stores fields on 1:1
 * extension tables keyed by parent_rowid; the export joins them back onto the
 * form's row, and an extension row with no parent lands under manual/ instead
 * of being dropped. Subform rows and multi lookups are not report import
 * data; they are written under manual/ with their ids. System columns (users,
 * times, IP addresses) and shadows are never exported. File fields store a
 * Stratus object key, which report import cannot load: each cell is listed in
 * files/<Form>.files.csv (record id, field, key, file name) so the files can
 * be fetched from the bucket and re-attached by hand. A file on an extension
 * row is listed on the form manifest under the form row's Creator record id.
 * parent_rowid may name that form row, or another extension row whose own
 * parent_rowid continues the chain; the export follows those rows. A file
 * whose form row has no Creator record id is counted, named, and omitted.
 *
 * The import/ folder reads back with `--source-csv`, so a re-plan against the
 * last checkpoint shows no changes when the store and checkpoint agree.
 *
 * A full export is the default. With a sync-delta checkpoint (`changedSince`)
 * the export writes only rows whose store fingerprint differs from the one the
 * checkpoint read back, rows the checkpoint does not hold (new in the app, or
 * never fingerprinted), and lists in deleted.csv the checkpoint records the
 * store no longer holds. Lookups still resolve against every stored row, so a
 * changed row shows its parent's display value even when the parent did not
 * change. Extension rows carry no fingerprint, so a form row that has one is
 * always in the delta. The manifest records the mode, the checkpoint id and the
 * counts; a delta export verifies only against that checkpoint.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { App, Field } from '../../core/src/ir.js';
import { generateSchema, type SchemaColumn, type SchemaTable } from '../../schema/src/generator.js';
import { SOURCE_ID_COLUMN } from '../../schema/src/mapping.js';
import { EXTENSION_KEY } from '../../schema/src/limits.js';
import { canonDecimal } from '../../data/src/integrity.js';
import { cellKind } from './csv.js';
import { compareIds, deltaCheckpointId, STORE_SYSTEM_COLUMNS, storeFingerprint, zcql, type DeltaCheckpoint } from './row-delta.js';
import { exactId, parseJsonExact } from './json-exact.js';
import type { CatalystScope, FetchLike } from '../../data/src/migrate.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Bookkeeping columns rollback never exports; parity ignores a stored key from this set unless the table schema declares that name. */
export { STORE_SYSTEM_COLUMNS };
/** ZCQL returns at most this many rows per SELECT. */
export const ZCQL_PAGE = 300;

export type StoreRows = ReadonlyMap<string, readonly Record<string, unknown>[]>;

export interface RollbackFile {
  path: string;
  body: string;
}

export interface RollbackExport {
  files: RollbackFile[];
  /** The manifest `c2c cutover-checklist` verifies: schema c2c-rollback-export/1. */
  manifest: RollbackFile;
  /** Per form: rows exported. */
  counts: { form: string; table: string; rows: number }[];
  order: string[];
  warnings: string[];
  /** Delta mode only: the checkpoint id, per-table counts and the records deleted in the app. */
  delta?: RollbackDelta;
}

export interface RollbackDeltaCounts {
  changed: number;
  added: number;
  unchanged: number;
  deleted: number;
}

export interface RollbackDelta {
  checkpoint: string;
  tables: Record<string, RollbackDeltaCounts>;
  totals: RollbackDeltaCounts;
  deleted: { table: string; form: string; sourceId: string }[];
}

export type RollbackMode = 'full' | 'delta';

export const ROLLBACK_MANIFEST_FILE = 'c2c-rollback-manifest.json';
export const ROLLBACK_MANIFEST_VERSION = 'c2c-rollback-export/1';
export const ROLLBACK_DELETED_FILE = 'deleted.csv';

interface Header {
  header: string;
  column: SchemaColumn;
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvDocument(headers: readonly string[], rows: readonly string[][]): string {
  return `${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function creatorDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return `${match[3]}-${MONTHS[Number(match[2]) - 1] ?? match[2]}-${match[1]}`;
}

function creatorDateTime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value);
  return match ? `${creatorDate(match[1]!)} ${match[2]}` : value;
}

function multiCell(value: string, warn: (line: string) => void, where: string): string {
  let items: unknown;
  try {
    items = JSON.parse(value);
  } catch {
    return value;
  }
  if (!Array.isArray(items)) return value;
  const list = items.map((item) => text(item));
  if (list.some((item) => item.includes(','))) warn(`${where}: a choice contains a comma; check the cell before import`);
  return list.join(', ');
}

function compositeOf(column: SchemaColumn, fields: readonly Field[]): { field: Field; part: string } | undefined {
  // A renamed column is a leaf column; only a composite part keeps `Part_sub` naming.
  if (column.field !== undefined) return undefined;
  for (const field of fields) {
    const type = (field.type ?? '').toLowerCase();
    if ((type === 'name' || type === 'address') && column.name.startsWith(`${field.name}_`)) return { field, part: column.name.slice(field.name.length + 1) };
  }
  return undefined;
}

function headersOf(table: SchemaTable, fields: readonly Field[]): Header[] {
  const out: Header[] = [];
  for (const column of table.columns) {
    if (STORE_SYSTEM_COLUMNS.has(column.name) || column.shadowFor) continue;
    if (cellKind(column) === 'file') continue;
    const composite = compositeOf(column, fields);
    out.push({ header: composite ? `${composite.field.name}.${composite.part}` : (column.field ?? column.name), column });
  }
  return out;
}

/** Display format of a lookup: a field, an expression, or the record id. */
function displayOf(field: Field | undefined): { kind: 'id' } | { kind: 'field'; field: string } | { kind: 'expr'; expr: string } {
  let inner = field?.lookup?.displayFormat?.trim() ?? '';
  if (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1).trim();
  if (!inner || inner.toLowerCase() === 'id') return { kind: 'id' };
  if (/[+\s".]/.test(inner)) return { kind: 'expr', expr: inner };
  return { kind: 'field', field: inner };
}

function evalDisplay(expr: string, cells: ReadonlyMap<string, string>): string {
  const parts = expr.match(/"((?:[^"\\]|\\.)*)"|([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)?)/gu) ?? [];
  let out = '';
  for (const part of parts) out += part.startsWith('"') ? part.slice(1, -1).replace(/\\(.)/gs, '$1') : cells.get(part) ?? '';
  return out.trim().replace(/\s+/g, ' ');
}

interface Formatted {
  rowid: string;
  sourceId: string;
  /** Header → cell, before lookups. */
  cells: Map<string, string>;
  /** Delta mode: the row against the checkpoint. */
  status?: 'changed' | 'added' | 'unchanged';
}

/** A stored row against the checkpoint: no Creator id or an id the checkpoint lacks is added; no store fingerprint counts as changed. */
function deltaStatus(checkpoint: DeltaCheckpoint, table: string, sourceId: string, row: Readonly<Record<string, unknown>>): 'changed' | 'added' | 'unchanged' {
  const entry = checkpoint.tables[table];
  if (!sourceId || !entry) return 'added';
  const known = Object.hasOwn(entry.rows, sourceId) || Object.hasOwn(entry.store ?? {}, sourceId) || (entry.deleted ?? []).includes(sourceId);
  if (!known) return 'added';
  // A checkpoint-deleted id was removed in Creator but the deletion was never applied: the row must stay in the delta so the re-import keeps it.
  if ((entry.deleted ?? []).includes(sourceId)) return 'changed';
  const before = entry.store && Object.hasOwn(entry.store, sourceId) ? entry.store[sourceId] : undefined;
  return before !== undefined && storeFingerprint(row) === before ? 'unchanged' : 'changed';
}

/** Parents before children by relation; ties by name. */
function importOrder(tables: readonly SchemaTable[]): string[] {
  const names = new Set(tables.map((table) => table.name));
  const placed: string[] = [];
  const done = new Set<string>();
  const visit = (name: string, stack: Set<string>) => {
    if (done.has(name) || stack.has(name)) return;
    stack.add(name);
    const table = tables.find((item) => item.name === name)!;
    const parents = [...new Set(table.columns.map((column) => column.relation?.table).filter((parent): parent is string => !!parent && names.has(parent)))].sort();
    for (const parent of parents) visit(parent, stack);
    stack.delete(name);
    done.add(name);
    placed.push(name);
  };
  for (const name of [...names].sort()) visit(name, new Set());
  return placed;
}

export function rollbackExport(app: App, rows: StoreRows, opts: { changedSince?: DeltaCheckpoint } = {}): RollbackExport {
  const checkpoint = opts.changedSince;
  const kept = (record: Formatted) => !checkpoint || record.status !== 'unchanged';
  const schema = generateSchema(app);
  const forms = new Map(app.forms.map((form) => [form.name, form]));
  const warnings: string[] = [];
  const warn = (line: string) => warnings.push(line);
  const formTables = schema.tables.filter((table) => table.role === 'form' && !table.nosql);
  const formatted = new Map<string, Formatted[]>();
  const headers = new Map<string, Header[]>();
  const fileCells = new Map<string, { sourceId: string; rowid: string; field: string; key: string }[]>();
  for (const table of schema.tables) {
    if (table.nosql || table.role === 'system') continue;
    const fields = table.subform
      ? forms.get(table.form)?.fields.find((field) => field.name === table.subform?.field)?.subfields ?? []
      : forms.get(table.form)?.fields ?? [];
    const list = headersOf(table, fields);
    headers.set(table.name, list);
    const fileColumns = table.columns.filter((column) => cellKind(column) === 'file' && !column.shadowFor);
    const out: Formatted[] = [];
    for (const row of rows.get(table.name) ?? []) {
      const rowid = row.ROWID === undefined || row.ROWID === null ? '' : exactId(row.ROWID, 'ROWID');
      const source = row[SOURCE_ID_COLUMN];
      const sourceId = source === undefined || source === null ? '' : exactId(source, SOURCE_ID_COLUMN);
      if (fileColumns.length) {
        const entries = fileCells.get(table.name) ?? [];
        for (const column of fileColumns) {
          const key = text(row[column.name]);
          if (key) entries.push({ sourceId, rowid, field: column.field ?? column.name, key });
        }
        if (entries.length) fileCells.set(table.name, entries);
      }
      const cells = new Map<string, string>();
      for (const item of list) {
        const raw = text(row[item.column.name]);
        if (!raw) continue;
        const kind = cellKind(item.column);
        const where = `${table.name}.${item.column.name} row ${sourceId || rowid}`;
        if (kind === 'date') cells.set(item.header, creatorDate(raw));
        else if (kind === 'datetime') cells.set(item.header, creatorDateTime(raw));
        else if (kind === 'bool') cells.set(item.header, raw === 'true' || raw === '1' ? 'true' : raw === 'false' || raw === '0' ? 'false' : raw);
        else if (kind === 'multi') cells.set(item.header, multiCell(raw, warn, where));
        else if (kind === 'decimal' && !item.column.exactDecimal) cells.set(item.header, canonDecimal(raw) ?? raw);
        else cells.set(item.header, raw);
      }
      out.push({ rowid, sourceId, cells, ...(checkpoint ? { status: table.role === 'extension' ? 'changed' : deltaStatus(checkpoint, table.name, sourceId, row) } : {}) });
    }
    out.sort((a, b) => (a.sourceId && b.sourceId ? compareIds(a.sourceId, b.sourceId) : a.sourceId ? -1 : b.sourceId ? 1 : compareIds(a.rowid, b.rowid)));
    formatted.set(table.name, out);
  }
  const byRowId = new Map<string, Map<string, Formatted>>();
  for (const [table, list] of formatted) byRowId.set(table, new Map(list.filter((row) => row.rowid).map((row) => [row.rowid, row])));

  const files: RollbackFile[] = [];
  const counts: RollbackExport['counts'] = [];
  const orphans = new Map<string, Formatted[]>();
  for (const table of formTables) {
    const form = forms.get(table.form);
    const list = [...(headers.get(table.name) ?? [])];
    const exts = schema.tables.filter((item) => item.role === 'extension' && item.extensionOf === table.name);
    const extByParent = new Map<string, Formatted[]>();
    for (const ext of exts) {
      list.push(...(headers.get(ext.name) ?? []).filter((item) => item.column.name !== EXTENSION_KEY));
      for (const record of formatted.get(ext.name) ?? []) {
        const parent = record.cells.get(EXTENSION_KEY) ?? '';
        const bucket = extByParent.get(parent) ?? [];
        bucket.push(record);
        extByParent.set(parent, bucket);
      }
    }
    const records = formatted.get(table.name) ?? [];
    const consumed = new Set<Formatted>();
    let joinedUnchanged = 0;
    for (const record of records) {
      for (const ext of extByParent.get(record.rowid) ?? []) {
        consumed.add(ext);
        if (record.status === 'unchanged') {
          record.status = 'changed';
          joinedUnchanged += 1;
        }
        for (const [header, value] of ext.cells) {
          if (header !== EXTENSION_KEY) record.cells.set(header, value);
        }
      }
    }
    for (const ext of exts) {
      const orphan = (formatted.get(ext.name) ?? []).filter((record) => !consumed.has(record));
      if (orphan.length) {
        warn(`${ext.name}: ${orphan.length} extension row(s) have no parent row in ${table.name}; they are written to manual/${ext.name}.csv`);
        orphans.set(ext.name, orphan);
      }
    }
    if (joinedUnchanged) warn(`${table.form}: ${joinedUnchanged} row(s) with an extension row are in the delta because extension rows carry no checkpoint fingerprint`);
    const lookups = list.filter((item) => item.column.relation);
    const written = records.filter(kept);
    const missingIds = written.filter((row) => !row.sourceId).length;
    if (missingIds) warn(`${table.form}: ${missingIds} row(s) were created after migration and have no Creator record id; they import as new records`);
    const displayIds = new Map<string, Map<string, string>>();
    for (const item of lookups) {
      const parent = item.column.relation!.table;
      const spec = displayOf(form?.fields.find((field) => field.name === (item.column.field ?? item.column.name)));
      const shown = new Map<string, string>();
      const seen = new Map<string, number>();
      for (const candidate of formatted.get(parent) ?? []) {
        const value = spec.kind === 'id' ? '' : spec.kind === 'field' ? candidate.cells.get(spec.field) ?? '' : evalDisplay(spec.expr, candidate.cells);
        shown.set(candidate.rowid, value);
        if (value) seen.set(value, (seen.get(value) ?? 0) + 1);
      }
      const resolved = new Map<string, string>();
      let byId = 0;
      for (const candidate of formatted.get(parent) ?? []) {
        const value = shown.get(candidate.rowid) ?? '';
        const unique = value && seen.get(value) === 1;
        if (!unique) byId += 1;
        resolved.set(candidate.rowid, unique ? value : candidate.sourceId);
      }
      if (spec.kind !== 'id' && byId) warn(`${table.form}.${item.column.field ?? item.column.name}: ${byId} ${parent} row(s) have no unique display value; those cells hold the record id`);
      displayIds.set(item.column.name, resolved);
    }
    const header = [...list.map((item) => item.header), 'ID'];
    const data: string[][] = [];
    const ids: string[][] = [];
    for (const record of written) {
      const cells: string[] = [];
      const idRow = [record.sourceId, record.rowid];
      for (const item of list) {
        if (!item.column.relation) {
          cells.push(record.cells.get(item.header) ?? '');
          continue;
        }
        const parentRowId = record.cells.get(item.header) ?? '';
        const parent = parentRowId ? byRowId.get(item.column.relation.table)?.get(parentRowId) : undefined;
        if (parentRowId && !parent) warn(`${table.form}.${item.column.field ?? item.column.name} row ${record.sourceId || record.rowid}: parent ROWID ${parentRowId} is not in ${item.column.relation.table}`);
        cells.push(parent ? displayIds.get(item.column.name)?.get(parent.rowid) ?? parent.sourceId : '');
        idRow.push(parent?.sourceId ?? '');
      }
      cells.push(record.sourceId);
      data.push(cells);
      ids.push(idRow);
    }
    files.push({ path: `import/${table.form}.csv`, body: csvDocument(header, data) });
    files.push({ path: `ids/${table.form}.ids.csv`, body: csvDocument(['ID', 'ROWID', ...lookups.map((item) => item.header)], ids) });
    counts.push({ form: table.form, table: table.name, rows: written.length });
  }
  for (const table of schema.tables.filter((item) => (item.role === 'child' || item.role === 'junction') && !item.nosql)) {
    const list = headers.get(table.name) ?? [];
    const records = (formatted.get(table.name) ?? []).filter(kept);
    const data = records.map((record) => [
      record.sourceId,
      record.rowid,
      ...list.map((item) => {
        const value = record.cells.get(item.header) ?? '';
        const parent = item.column.relation && value ? byRowId.get(item.column.relation.table)?.get(value) : undefined;
        return parent ? parent.sourceId : value;
      }),
    ]);
    files.push({ path: `manual/${table.name}.csv`, body: csvDocument(['ID', 'ROWID', ...list.map((item) => item.header)], data) });
    if (records.length) {
      warn(`${table.name}: ${records.length} ${table.role === 'child' ? 'subform' : 'multi lookup'} row(s) are not report import data; re-enter them from manual/${table.name}.csv`);
    }
  }
  for (const [name, records] of orphans) {
    const list = headers.get(name) ?? [];
    const data = records.map((record) => [
      record.sourceId,
      record.rowid,
      ...list.map((item) => {
        const value = record.cells.get(item.header) ?? '';
        const parent = item.column.relation && value ? byRowId.get(item.column.relation.table)?.get(value) : undefined;
        return parent ? parent.sourceId : value;
      }),
    ]);
    files.push({ path: `manual/${name}.csv`, body: csvDocument(['ID', 'ROWID', ...list.map((item) => item.header)], data) });
  }
  const keptRow = (table: string, rowid: string) => {
    const record = rowid ? byRowId.get(table)?.get(rowid) : undefined;
    return !record || kept(record);
  };
  // Form row Creator id for an extension file. parent_rowid names the form row, or
  // another extension row in this export whose parent_rowid continues the chain.
  const creatorIdFromExport = (formTable: string, rowid: string, seen: Set<string>): string => {
    if (!rowid || seen.has(rowid)) return '';
    seen.add(rowid);
    const direct = byRowId.get(formTable)?.get(rowid);
    if (direct) return direct.sourceId;
    for (const ext of schema.tables) {
      if (ext.role !== 'extension' || ext.extensionOf !== formTable) continue;
      const intermediate = byRowId.get(ext.name)?.get(rowid);
      if (!intermediate) continue;
      const nested = creatorIdFromExport(formTable, intermediate.cells.get(EXTENSION_KEY) ?? '', seen);
      if (nested) return nested;
    }
    return '';
  };
  for (const table of formTables) {
    const label = table.form;
    const entries: { sourceId: string; rowid: string; field: string; key: string }[] = [];
    const ownEntries = (fileCells.get(table.name) ?? []).filter((entry) => keptRow(table.name, entry.rowid));
    const missingIds = ownEntries.filter((entry) => !entry.sourceId).length;
    entries.push(...ownEntries.filter((entry) => entry.sourceId));
    if (missingIds) warn(`${table.form}: ${missingIds} file value(s) were refused because the Creator record ID could not be resolved; no blank ID was emitted`);
    for (const ext of schema.tables.filter((item) => item.role === 'extension' && item.extensionOf === table.name)) {
      const refusedIds: string[] = [];
      for (const entry of fileCells.get(ext.name) ?? []) {
        const extension = byRowId.get(ext.name)?.get(entry.rowid);
        const parentRowId = extension?.cells.get(EXTENSION_KEY) ?? '';
        const sourceId = creatorIdFromExport(table.name, parentRowId, new Set());
        if (!sourceId) {
          refusedIds.push(entry.rowid || parentRowId || 'unknown');
          continue;
        }
        entries.push({ ...entry, sourceId });
      }
      if (refusedIds.length) {
        warn(
          `${table.form}: ${refusedIds.length} file value(s) in ${ext.name} were refused because the parent Creator record ID could not be resolved; no blank ID was emitted (records: ${refusedIds.join(', ')})`,
        );
      }
    }
    if (!entries.length) continue;
    const data = entries.map((entry) => [entry.sourceId, entry.rowid, entry.field, entry.key, entry.key.split('/').pop() ?? '']);
    files.push({ path: `files/${label}.files.csv`, body: csvDocument(['ID', 'ROWID', 'Field', 'Object_Key', 'File_Name'], data) });
    warn(`${table.form}: ${entries.length} file value(s) in ${table.form} are Stratus object keys the report importer cannot load; fetch each object and re-attach it from files/${label}.files.csv`);
  }
  for (const [name, tableEntries] of fileCells) {
    const table = schema.tables.find((item) => item.name === name)!;
    if (table.role === 'form' || table.role === 'extension') continue;
    const keptEntries = tableEntries.filter((entry) => keptRow(name, entry.rowid));
    const entries = keptEntries.filter((entry) => entry.sourceId);
    const refused = keptEntries.length - entries.length;
    if (refused) warn(`${table.form}: ${refused} file value(s) in ${name} were refused because the Creator record ID could not be resolved; no blank ID was emitted`);
    if (!entries.length) continue;
    const data = entries.map((entry) => [entry.sourceId, entry.rowid, entry.field, entry.key, entry.key.split('/').pop() ?? '']);
    files.push({ path: `files/${name}.files.csv`, body: csvDocument(['ID', 'ROWID', 'Field', 'Object_Key', 'File_Name'], data) });
    warn(`${table.form}: ${entries.length} file value(s) in ${name} are Stratus object keys the report importer cannot load; fetch each object and re-attach it from files/${name}.files.csv`);
  }
  const delta = checkpoint ? deltaOf(schema.tables, formatted, rows, checkpoint, warn) : undefined;
  if (delta) {
    files.push({ path: ROLLBACK_DELETED_FILE, body: csvDocument(['Table', 'Form', 'ID'], delta.deleted.map((item) => [item.table, item.form, item.sourceId])) });
  }
  const order = importOrder(formTables).map((name) => formTables.find((table) => table.name === name)!.form);
  files.push({ path: 'IMPORT_ORDER.txt', body: `${order.map((form, index) => `${index + 1}. import/${form}.csv`).join('\n')}\n` });
  files.push({ path: 'README.md', body: rollbackReadme(app, order, counts, warnings, delta) });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const tableFiles: Record<string, string> = {};
  for (const table of formTables) tableFiles[table.name] = `import/${table.form}.csv`;
  for (const table of schema.tables.filter((item) => (item.role === 'child' || item.role === 'junction') && !item.nosql)) {
    tableFiles[table.name] = `manual/${table.name}.csv`;
  }
  const fileChecksums: Record<string, string> = {};
  for (const file of files) fileChecksums[file.path] = createHash('sha256').update(file.body).digest('hex');
  const manifest: RollbackFile = {
    path: ROLLBACK_MANIFEST_FILE,
    body: `${JSON.stringify(
      {
        version: ROLLBACK_MANIFEST_VERSION,
        app: app.name ?? '',
        mode: (delta ? 'delta' : 'full') satisfies RollbackMode,
        ...(delta ? { checkpoint: delta.checkpoint, counts: { ...delta.totals, tables: delta.tables } } : {}),
        tables: tableFiles,
        files: fileChecksums,
      },
      null,
      2,
    )}\n`,
  };
  return { files, manifest, counts, order, warnings, ...(delta ? { delta } : {}) };
}

/**
 * Per-table delta counts, and the checkpoint records the store no longer holds.
 * A table the rows do not include is not read, so none of its records is
 * listed as deleted.
 */
function deltaOf(
  tables: readonly SchemaTable[],
  formatted: ReadonlyMap<string, readonly Formatted[]>,
  rows: StoreRows,
  checkpoint: DeltaCheckpoint,
  warn: (line: string) => void,
): RollbackDelta {
  const counts: Record<string, RollbackDeltaCounts> = {};
  const totals: RollbackDeltaCounts = { changed: 0, added: 0, unchanged: 0, deleted: 0 };
  const deleted: RollbackDelta['deleted'] = [];
  for (const table of [...tables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (table.nosql || table.role === 'system' || table.role === 'extension') continue;
    const item: RollbackDeltaCounts = { changed: 0, added: 0, unchanged: 0, deleted: 0 };
    const present = new Set<string>();
    for (const record of formatted.get(table.name) ?? []) {
      item[record.status ?? 'added'] += 1;
      if (record.sourceId) present.add(record.sourceId);
    }
    const entry = checkpoint.tables[table.name];
    if (entry && !rows.has(table.name)) {
      warn(`${table.name}: no stored rows were read, so deletions are not listed for it`);
    } else if (entry) {
      const known = new Set([...Object.keys(entry.rows), ...Object.keys(entry.store ?? {})]);
      for (const id of [...known].sort(compareIds)) {
        if (present.has(id)) continue;
        deleted.push({ table: table.name, form: table.form, sourceId: id });
        item.deleted += 1;
      }
    }
    counts[table.name] = item;
    for (const key of Object.keys(totals) as (keyof RollbackDeltaCounts)[]) totals[key] += item[key];
  }
  if (deleted.length) warn(`${deleted.length} record(s) were deleted in the new app since the checkpoint; delete them in Creator by hand from ${ROLLBACK_DELETED_FILE}`);
  return { checkpoint: deltaCheckpointId(checkpoint), tables: counts, totals, deleted };
}

function rollbackReadme(app: App, order: readonly string[], counts: RollbackExport['counts'], warnings: readonly string[], delta?: RollbackDelta): string {
  const lines = [
    `# Rollback export: ${app.name ?? 'application'}`,
    '',
    'Data Store rows as CSV files for the Creator report "Import Data" screen.',
    '',
    ...(delta
      ? [
          `Delta export against checkpoint \`${delta.checkpoint}\`: only rows changed (${delta.totals.changed}) or added (${delta.totals.added}) since it; ${delta.totals.unchanged} unchanged row(s) are left out. \`${ROLLBACK_DELETED_FILE}\` lists the ${delta.totals.deleted} record(s) deleted in the new app; delete them in Creator by hand. Import over the Creator data the checkpoint matches.`,
          '',
        ]
      : []),
    '## Import',
    '',
    ...order.map((form, index) => `${index + 1}. \`import/${form}.csv\` into a report of ${form} (${counts.find((item) => item.form === form)?.rows ?? 0} rows).`),
    '',
    '- Headers are field link names; a name or address part is `Field.part`.',
    '- Dates are dd-MMM-yyyy. Set the import date format to match.',
    '- Lookups hold the parent display value. Import parents first.',
    '- Leave the `ID` column unmapped. Creator assigns new record ids on import.',
    '- `ids/<Form>.ids.csv` maps each row to its old record id, ROWID and lookup record ids.',
    '- `manual/` holds subform, multi lookup and orphaned extension rows, which the report importer does not load.',
    '- `files/<Form>.files.csv` lists file-field cells as Stratus object keys; fetch each object from the bucket and re-attach it by hand — the importer cannot load files.',
    '',
    '## Notes',
    '',
    ...(warnings.length ? warnings.map((line) => `- ${line}`) : ['- none']),
    '',
  ];
  return `${lines.join('\n')}`;
}

/**
 * Every stored row of each table, ROWID order, ZCQL_PAGE rows per query.
 * ZCQL LIMIT offsets are 1-based and 0 is clamped to 1, so the first page asks
 * for offset 1 and the next for 1 + ZCQL_PAGE — a 0-based walk would read the
 * page-edge row twice. A repeated ROWID is still skipped, so a paging
 * inconsistency cannot duplicate a row.
 */
export async function readStoreRows(
  opts: { dc: string; catalystBase: string; fetch: FetchLike; scope: CatalystScope },
  tables: readonly string[],
): Promise<Map<string, Record<string, unknown>[]>> {
  const out = new Map<string, Record<string, unknown>[]>();
  for (const table of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`table name is not a ZCQL identifier: ${table}`);
    const rows: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (let offset = 1; ; offset += ZCQL_PAGE) {
      const page = await zcql(opts, `SELECT * FROM ${table} ORDER BY ROWID LIMIT ${offset}, ${ZCQL_PAGE}`);
      for (const row of page) {
        const rowid = row.ROWID;
        if (rowid !== undefined && rowid !== null) {
          const key = String(rowid);
          if (seen.has(key)) continue;
          seen.add(key);
        }
        rows.push(row);
      }
      if (page.length < ZCQL_PAGE) break;
    }
    out.set(table, rows);
  }
  return out;
}

/** Offline rows: `<table>.json` holding a row array or a ZCQL `{ data: [...] }` body. */
export function parseStoreRows(table: string, body: string): Record<string, unknown>[] {
  const parsed = parseJsonExact(body);
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? (parsed as { data?: unknown }).data : undefined;
  if (!Array.isArray(list)) throw new Error(`${table}.json is not a row array`);
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${table}.json holds a row that is not an object`);
    const record = entry as Record<string, unknown>;
    const inner = record[table];
    return inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : record;
  });
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** `relPath` must stay inside `realDir`, after symlink resolution of the file itself. */
function containedPath(realDir: string, relPath: unknown): { path?: string; reason?: string } {
  if (typeof relPath !== 'string' || relPath === '' || isAbsolute(relPath)) {
    return { reason: `manifest path ${String(relPath)} is not relative` };
  }
  const full = resolve(realDir, relPath);
  const rel = relative(realDir, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { reason: `manifest path ${relPath} escapes the export dir` };
  }
  const real = realPath(full);
  const relReal = relative(realDir, real);
  if (relReal === '' || relReal.startsWith('..') || isAbsolute(relReal)) {
    return { reason: `manifest path ${relPath} resolves outside the export dir` };
  }
  return { path: real };
}

/**
 * A valid manifest is the file `c2c rollback-export` writes: schema
 * c2c-rollback-export/1, the app name, every exported table mapped to its
 * file, and a sha256 for every listed file that matches the bytes on disk.
 * A delta export (mode delta) also names the checkpoint it was taken against:
 * it verifies only against that checkpoint, its counts must be whole numbers,
 * and deleted.csv must list exactly the deleted count.
 */
export function verifyRollbackManifest(dir: string, manifest: Record<string, unknown>, app: App, checkpoint?: DeltaCheckpoint): { ok: boolean; reason?: string } {
  if (manifest.version !== ROLLBACK_MANIFEST_VERSION) {
    return { ok: false, reason: `manifest version is not ${ROLLBACK_MANIFEST_VERSION}` };
  }
  if (manifest.app !== (app.name ?? '')) {
    return { ok: false, reason: 'manifest app does not match this application' };
  }
  const mode = manifest.mode ?? 'full';
  if (mode !== 'full' && mode !== 'delta') {
    return { ok: false, reason: 'manifest mode is not full or delta' };
  }
  if (mode === 'full' && (manifest.checkpoint !== undefined || manifest.counts !== undefined)) {
    return { ok: false, reason: 'a full export manifest carries delta fields' };
  }
  let deletedCount: number | undefined;
  if (mode === 'delta') {
    if (typeof manifest.checkpoint !== 'string' || !manifest.checkpoint) {
      return { ok: false, reason: 'delta export manifest names no checkpoint' };
    }
    if (!checkpoint) {
      return { ok: false, reason: `delta export against checkpoint ${manifest.checkpoint} needs --since <state> to verify against that checkpoint` };
    }
    const current = deltaCheckpointId(checkpoint);
    if (manifest.checkpoint !== current) {
      return { ok: false, reason: `delta export was taken against checkpoint ${manifest.checkpoint}, not the --since checkpoint ${current}` };
    }
    const counts = manifest.counts as Record<string, unknown> | undefined;
    const whole = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
    if (!counts || typeof counts !== 'object' || Array.isArray(counts) || !['changed', 'added', 'unchanged', 'deleted'].every((key) => whole(counts[key]))) {
      return { ok: false, reason: 'delta export manifest carries no whole-number counts' };
    }
    deletedCount = counts.deleted as number;
  }
  const files = manifest.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return { ok: false, reason: 'manifest carries no file checksums' };
  }
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length === 0) {
    return { ok: false, reason: 'manifest lists no files' };
  }
  const tables = manifest.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
    return { ok: false, reason: 'manifest lists no tables' };
  }
  const expected = generateSchema(app)
    .tables.filter((table) => !table.nosql && table.role !== 'system')
    .map((table) => table.name)
    .sort();
  const listed = Object.keys(tables as Record<string, unknown>).sort();
  if (listed.length !== expected.length || listed.some((name, index) => name !== expected[index])) {
    return { ok: false, reason: 'manifest table inventory does not match the application' };
  }
  for (const [table, path] of Object.entries(tables as Record<string, unknown>)) {
    if (typeof path !== 'string' || !(path in (files as Record<string, unknown>))) {
      return { ok: false, reason: `manifest table ${table} names no exported file` };
    }
  }
  const realDir = realPath(dir);
  for (const [relPath, expectedSum] of entries) {
    const contained = containedPath(realDir, relPath);
    if (!contained.path) return { ok: false, reason: contained.reason };
    let content: Buffer;
    try {
      content = readFileSync(contained.path);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
        return { ok: false, reason: `missing file ${relPath}` };
      }
      throw err;
    }
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual.toLowerCase() !== String(expectedSum).toLowerCase()) {
      return { ok: false, reason: `checksum mismatch on ${relPath}` };
    }
    if (relPath === ROLLBACK_DELETED_FILE && deletedCount !== undefined) {
      const listed = content.toString('utf8').split('\n').filter((line) => line !== '').length - 1;
      if (listed !== deletedCount) return { ok: false, reason: `${ROLLBACK_DELETED_FILE} lists ${listed} record(s), the manifest counts ${deletedCount}` };
    }
  }
  if (deletedCount !== undefined && !(ROLLBACK_DELETED_FILE in (files as Record<string, unknown>))) {
    return { ok: false, reason: `delta export manifest lists no ${ROLLBACK_DELETED_FILE}` };
  }
  return { ok: true };
}

/**
 * Why `dir` is not a usable backup of `app`'s rows, or undefined when it is:
 * a `c2c rollback-export` directory whose manifest matches the app and whose
 * checksums match the files on disk.
 */
export function rollbackBackupProblem(dir: string, app: App): string | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(dir, ROLLBACK_MANIFEST_FILE), 'utf8'));
  } catch {
    return `--backup ${dir} holds no readable ${ROLLBACK_MANIFEST_FILE}`;
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return `--backup ${dir}: the manifest is not an object`;
  const result = verifyRollbackManifest(dir, manifest as Record<string, unknown>, app);
  return result.ok ? undefined : `--backup ${dir} is not a verified export of the deployed app: ${result.reason}`;
}
