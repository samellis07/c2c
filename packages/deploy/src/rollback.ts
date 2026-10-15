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
 * be fetched from the bucket and re-attached by hand.
 *
 * The import/ folder reads back with `--source-csv`, so a re-plan against the
 * last checkpoint shows no changes when the store and checkpoint agree.
 */
import { createHash } from 'node:crypto';
import type { App, Field } from '../../core/src/ir.js';
import { generateSchema, type SchemaColumn, type SchemaTable } from '../../schema/src/generator.js';
import { SOURCE_ID_COLUMN, SYSTEM_FIELD_COLUMNS } from '../../schema/src/mapping.js';
import { EXTENSION_KEY } from '../../schema/src/limits.js';
import { canonDecimal } from '../../data/src/integrity.js';
import { cellKind } from './csv.js';
import { compareIds, zcql } from './row-delta.js';
import { exactId, parseJsonExact } from './json-exact.js';
import type { CatalystScope, FetchLike } from '../../data/src/migrate.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * Bookkeeping columns shared by rollback and parity: the loader's source id,
 * the row id, the columns Catalyst stamps on every `SELECT *` row, and the
 * Creator system fields. Rollback never exports them. Parity ignores a stored
 * key from this set unless the table schema declares that name.
 */
export const STORE_SYSTEM_COLUMNS = new Set<string>([SOURCE_ID_COLUMN, 'ROWID', 'CREATORID', 'CREATEDTIME', 'MODIFIEDTIME', ...SYSTEM_FIELD_COLUMNS.map((column) => column.name)]);
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
}

export const ROLLBACK_MANIFEST_FILE = 'c2c-rollback-manifest.json';
export const ROLLBACK_MANIFEST_VERSION = 'c2c-rollback-export/1';

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

export function rollbackExport(app: App, rows: StoreRows): RollbackExport {
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
      out.push({ rowid, sourceId, cells });
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
    for (const record of records) {
      for (const ext of extByParent.get(record.rowid) ?? []) {
        consumed.add(ext);
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
    const lookups = list.filter((item) => item.column.relation);
    const missingIds = records.filter((row) => !row.sourceId).length;
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
    for (const record of records) {
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
    counts.push({ form: table.form, table: table.name, rows: records.length });
  }
  for (const table of schema.tables.filter((item) => (item.role === 'child' || item.role === 'junction') && !item.nosql)) {
    const list = headers.get(table.name) ?? [];
    const records = formatted.get(table.name) ?? [];
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
  for (const table of formTables) {
    const label = table.form;
    const entries: { sourceId: string; rowid: string; field: string; key: string }[] = [];
    const ownEntries = fileCells.get(table.name) ?? [];
    const missingIds = ownEntries.filter((entry) => !entry.sourceId).length;
    entries.push(...ownEntries.filter((entry) => entry.sourceId));
    if (missingIds) warn(`${table.form}: ${missingIds} file value(s) were refused because the Creator record ID could not be resolved; no blank ID was emitted`);
    for (const ext of schema.tables.filter((item) => item.role === 'extension' && item.extensionOf === table.name)) {
      let refused = 0;
      for (const entry of fileCells.get(ext.name) ?? []) {
        const extension = byRowId.get(ext.name)?.get(entry.rowid);
        const parentRowId = extension?.cells.get(EXTENSION_KEY) ?? '';
        const parent = parentRowId ? byRowId.get(table.name)?.get(parentRowId) : undefined;
        if (!parent?.sourceId) {
          refused += 1;
          continue;
        }
        entries.push({ ...entry, sourceId: parent.sourceId });
      }
      if (refused) warn(`${table.form}: ${refused} file value(s) in ${ext.name} were refused because the parent Creator record ID could not be resolved; no blank ID was emitted`);
    }
    if (!entries.length) continue;
    const data = entries.map((entry) => [entry.sourceId, entry.rowid, entry.field, entry.key, entry.key.split('/').pop() ?? '']);
    files.push({ path: `files/${label}.files.csv`, body: csvDocument(['ID', 'ROWID', 'Field', 'Object_Key', 'File_Name'], data) });
    warn(`${table.form}: ${entries.length} file value(s) in ${table.name} or its extension tables are Stratus object keys the report importer cannot load; fetch each object and re-attach it from files/${label}.files.csv`);
  }
  for (const [name, tableEntries] of fileCells) {
    const table = schema.tables.find((item) => item.name === name)!;
    if (table.role === 'form' || table.role === 'extension') continue;
    const entries = tableEntries.filter((entry) => entry.sourceId);
    const refused = tableEntries.length - entries.length;
    if (refused) warn(`${table.form}: ${refused} file value(s) in ${name} were refused because the Creator record ID could not be resolved; no blank ID was emitted`);
    if (!entries.length) continue;
    const data = entries.map((entry) => [entry.sourceId, entry.rowid, entry.field, entry.key, entry.key.split('/').pop() ?? '']);
    files.push({ path: `files/${name}.files.csv`, body: csvDocument(['ID', 'ROWID', 'Field', 'Object_Key', 'File_Name'], data) });
    warn(`${table.form}: ${entries.length} file value(s) in ${name} are Stratus object keys the report importer cannot load; fetch each object and re-attach it from files/${name}.files.csv`);
  }
  const order = importOrder(formTables).map((name) => formTables.find((table) => table.name === name)!.form);
  files.push({ path: 'IMPORT_ORDER.txt', body: `${order.map((form, index) => `${index + 1}. import/${form}.csv`).join('\n')}\n` });
  files.push({ path: 'README.md', body: rollbackReadme(app, order, counts, warnings) });
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
    body: `${JSON.stringify({ version: ROLLBACK_MANIFEST_VERSION, app: app.name ?? '', tables: tableFiles, files: fileChecksums }, null, 2)}\n`,
  };
  return { files, manifest, counts, order, warnings };
}

function rollbackReadme(app: App, order: readonly string[], counts: RollbackExport['counts'], warnings: readonly string[]): string {
  const lines = [
    `# Rollback export: ${app.name ?? 'application'}`,
    '',
    'Data Store rows as CSV files for the Creator report "Import Data" screen.',
    '',
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
