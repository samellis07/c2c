/**
 * Creator application backup → the loaded shape the report-export paths feed
 * the loader. A backup is the admin "Schema + Data + Include Files" archive:
 * the outer zip holds app_manifest.xml, meta.zds, sync.zip and data/data_N.zip
 * chunks; an extracted directory with the same layout reads identically. Each
 * data chunk holds basic#<Form>.csv (every scalar field plus the system
 * columns), basic#<Subform>@<Parent>.csv (subform rows with their own ids; the
 * parent link is not a column), and rel#<Field>#<Owner>.csv (base record id →
 * target record id, one row per value — a multi lookup is several rows and a
 * subform's row order is the order of its refs under one base id).
 *
 * Record ids stay exact digit strings — a 19-digit Creator id is never parsed
 * as a number. Lookup links come only from rel# files, so resolution is by
 * record id, never a display value. Rows with a non-zero Record_Status are not
 * imported, and a child row whose parent is skipped or missing is skipped with
 * a counted reason rather than written parentless. Added_Time/Modified_Time
 * are epoch milliseconds and land on the schema's DateTime columns, converted
 * in the application's time zone. Added_User/Modified_User identities and the
 * IP columns are personal data: the plan counts them and the loader never
 * writes them; appUsers.csv and appAdmins.csv are counted the same way.
 * File/image fields stay a noted gap when the backup holds no payloads.
 * Counts come from the backup rows, so a plan is a pure read — nothing here
 * touches the network.
 *
 * Every archive level shares one byte budget, so the outer archive plus all
 * nested chunks together may not exceed the byte cap. Creator writes a form's
 * rows in a single chunk — every backup observed carries one data_1.zip — so
 * a member name repeated across chunks is refused rather than merged.
 * In every CSV member a cell holding only U+000E reads as an empty cell —
 * that is how a backup writes an empty value; the same character inside
 * other text is data and stays.
 * appDataInfo.xml's records-count counts the top-level form rows including
 * Record_Status-skipped ones and is checked against the files. A member that
 * looks like form or relation data but fits no known shape is refused; other
 * members the loader does not consume are listed under ignored.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { App, Field } from '../../core/src/ir.js';
import { constraintDecisionNote, generateSchema, type SchemaColumn, type SchemaTable, type SourceTableData } from '../../schema/src/generator.js';
import { normalizeType, SOURCE_ID_COLUMN, SYSTEM_FIELD_COLUMNS } from '../../schema/src/mapping.js';
import { decimalShadow } from '../../shims/src/criteria.js';
import { quantizeDecimal } from '../../shims/src/decimal.js';
import { encodeMultiValue, splitMultiValueText } from '../../shims/src/multi-value.js';
import { mandatoryMissingRefusals, normalizeDate, overLengthRefusals, normalizeDateTime } from '../../data/src/integrity.js';
import { appTimeZone } from '../../ui/src/generate.js';
import { assertExportCounts, loaderColumns, parseCsv, type CsvColumnNote, type CsvGap, type CsvLoad } from './csv.js';
import { orderTables } from './remap.js';
import { assertLookupRemaps, mandatoryRelaxedColumns, nonDeferrableKeys, tableCreatePlan } from './tables.js';
import { openZip, readZip, type ZipBudget, type ZipLimits } from './zipfile.js';
import type { SeedRow, SeedTable } from './seed.js';

/** Member-name and byte caps covering the outer archive and all nested chunks together. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const LIMITS: ZipLimits = { maxEntries: 4096, maxEntryBytes: MAX_ENTRY_BYTES, maxTotalBytes: MAX_TOTAL_BYTES };

const PERSONAL_HEADERS = new Set(['addeduser', 'modifieduser', 'addeduseripaddress', 'modifieduseripaddress']);
const TIME_HEADERS = new Set(['addedtime', 'modifiedtime']);
const STATUS_HEADER = 'recordstatus';
const MARKER_HEADER = 'zcrecordtype';

const MULTI_TOKENS = new Set(['list', 'checkboxes', 'multi select', 'multiselect', 'lookup multi', 'multi lookup']);

const BACKUP_SYSTEM_GAP =
  'A Creator backup holds account identities and IP addresses in Added_User, Modified_User, and the IP columns; they are personal data, counted in the plan and not imported. Added_Time and Modified_Time are epoch milliseconds converted in the application time zone.';

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/[\s.]+/g, '_');
}

function normKey(value: string): string {
  return norm(value).replace(/[^a-z0-9]+/g, '');
}

/** Display names and link names compare equal once folded to a link shape. */
function linkKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isSubformField(field: Field): boolean {
  const token = normalizeType(field.type);
  return token === 'grid' || token === 'subform' || token === 'inline subform' || token === 'form';
}

function isMultiField(field: Field): boolean {
  const token = normalizeType(field.type);
  if (MULTI_TOKENS.has(token)) return true;
  return token === 'checkbox' && ((field.choices?.length ?? 0) > 0 || !!field.lookup);
}

function fieldProp(field: Field, key: string): string | undefined {
  const found = field.properties.find((item) => item.key.toLowerCase() === key);
  return found ? found.value.trim().replace(/^["']|["']$/g, '') : undefined;
}

interface BackupRoot {
  /** Member names relative to the backup root, sorted. */
  names: string[];
  read(name: string): Buffer;
}

const MAX_DIR_ENTRIES = 8192;

function dirRoot(dir: string, budget: ZipBudget): BackupRoot {
  const names: string[] = [];
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (names.length >= MAX_DIR_ENTRIES) throw new Error(`source backup holds more than ${MAX_DIR_ENTRIES} entries`);
      const rel = `${prefix}${entry.name}`;
      const st = lstatSync(join(at, entry.name));
      if (st.isSymbolicLink()) throw new Error(`source backup entry ${rel} is a symbolic link; an extracted backup holds regular files only`);
      if (st.isDirectory()) {
        walk(join(at, entry.name), `${rel}/`);
        continue;
      }
      if (!st.isFile()) throw new Error(`source backup entry ${rel} is not a regular file`);
      if (st.size > MAX_ENTRY_BYTES) throw new Error(`source backup entry ${rel} is ${st.size} bytes (limit ${MAX_ENTRY_BYTES})`);
      budget.used += st.size;
      if (budget.used > MAX_TOTAL_BYTES) throw new Error(`source backup files total more than ${MAX_TOTAL_BYTES} bytes`);
      names.push(rel);
    }
  };
  walk(dir, '');
  return { names, read: (name) => readFileSync(join(dir, name)) };
}

function zipRoot(bytes: Buffer, budget: ZipBudget): BackupRoot {
  const archive = openZip(bytes, LIMITS, budget);
  return {
    names: archive.names,
    read: (name) => {
      if (!archive.has(name)) throw new Error(`source backup has no member ${name}`);
      return archive.read(name);
    },
  };
}

/**
 * The archive root may sit one directory deep (<app>_v1_<date>/...). The
 * marker is app_manifest.xml: exactly one level of prefix is accepted.
 */
function backupPrefix(names: readonly string[]): string {
  if (names.includes('app_manifest.xml')) return '';
  const nested = names.filter((name) => /^[^/]+\/app_manifest\.xml$/.test(name));
  if (!nested.length) throw new Error('not a Creator application backup: no app_manifest.xml');
  if (nested.length > 1) throw new Error('source backup holds more than one app_manifest.xml');
  return nested[0]!.slice(0, -'app_manifest.xml'.length);
}

function openBackup(source: string, budget: ZipBudget): BackupRoot {
  const st = statSync(source, { throwIfNoEntry: false });
  if (!st) throw new Error(`no such file or directory: ${source}`);
  const raw = st.isDirectory() ? dirRoot(source, budget) : zipRoot(readFileSync(source), budget);
  const prefix = backupPrefix(raw.names);
  const names = raw.names.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));
  return { names, read: (name) => raw.read(`${prefix}${name}`) };
}

function xmlTag(text: string, tag: string): string | undefined {
  const found = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(text);
  const value = found?.[1]?.trim();
  return value || undefined;
}

interface Sheet {
  file: string;
  headers: string[];
  rows: string[][];
  /** Rows carrying a non-empty cell past the last header. */
  extraCells: number;
}

/**
 * A cell holding only U+000E (shift out) is how a backup writes an empty
 * value: it reads exactly like an empty CSV cell in every column of every
 * member, so a row left holding no other value drops out the way a blank
 * line does. The character inside other text is data and stays.
 */
function parseBackupCsv(text: string): string[][] {
  return parseCsv(text)
    .map((record) => record.map((cell) => (cell === '\u000e' ? '' : cell)))
    .filter((record) => record.some((cell) => cell.trim() !== ''));
}

function parseSheet(file: string, bytes: Buffer): Sheet {
  const parsed = parseBackupCsv(bytes.toString('utf8'));
  const headers = (parsed[0] ?? []).map((cell) => cell.trim());
  const seen = new Set<string>();
  for (const header of headers) {
    const key = normKey(header);
    if (seen.has(key)) throw new Error(`${file} repeats header ${JSON.stringify(header)}`);
    seen.add(key);
  }
  const records = parsed.slice(1);
  const rows = records.map((record) => headers.map((_, index) => record[index] ?? ''));
  const extraCells = records.filter((record) => record.slice(headers.length).some((cell) => cell.trim().length > 0)).length;
  return { file, headers, rows, extraCells };
}

/** The data chunk contents of a backup: data/data_N.zip members and loose data/data_N/ files merged into one name -> bytes map. */
function innerMembers(root: BackupRoot, budget: ZipBudget): Map<string, Buffer> {
  const inner = new Map<string, Buffer>();
  const chunkZips = root.names.filter((name) => /^data\/data_\d+\.zip$/.test(name)).sort();
  for (const name of chunkZips) {
    const chunk = name.slice('data/'.length, -'.zip'.length);
    // The chunk's outer member buffer is dropped once readZip returns.
    for (const entry of readZip(root.read(name), LIMITS, budget)) {
      const member = entry.name.startsWith(`${chunk}/`) ? entry.name.slice(chunk.length + 1) : entry.name;
      if (!member) continue;
      if (inner.has(member)) throw new Error(`backup data member ${member} appears twice`);
      inner.set(member, entry.data);
    }
  }
  for (const name of root.names) {
    const loose = /^data\/data_\d+\/(.+)$/.exec(name);
    if (loose?.[1]) {
      if (inner.has(loose[1])) throw new Error(`backup data member ${loose[1]} appears twice`);
      inner.set(loose[1], root.read(name));
    }
  }
  return inner;
}

/**
 * The two user lists a backup carries — appUsers.csv (every app user with
 * USER_TYPE, USER_STATUS, PROFILE_NAME, ROLE_NAME, ZUID) and appAdmins.csv.
 * Identity columns are personal data: the caller uses them at run time only,
 * never writes them to a file or a log line.
 */
export function readBackupUserLists(source: string): { users?: Buffer; admins?: Buffer } {
  const budget: ZipBudget = { used: 0 };
  const root = openBackup(source, budget);
  const inner = innerMembers(root, budget);
  const out: { users?: Buffer; admins?: Buffer } = {};
  const users = inner.get('appUsers.csv');
  const admins = inner.get('appAdmins.csv');
  if (users) out.users = users;
  if (admins) out.admins = admins;
  return out;
}

function recordId(cell: string, file: string, header: string): string {
  const text = cell.trim();
  if (!/^-?\d+$/.test(text)) throw new Error(`${file}: ${header} value ${JSON.stringify(text)} is not a record id`);
  return text;
}

interface BackupSpec {
  table: string;
  form: string;
  role: SchemaTable['role'];
  nosql: boolean;
  columns: SchemaColumn[];
  subform?: { form: string; field: string; parentTable: string; parentColumn: string; orderColumn: string };
}

function backupSpecs(schema: SchemaTable[]): BackupSpec[] {
  return schema
    .filter((table) => table.role !== 'system')
    .map((table) => ({
      table: table.name,
      form: table.form,
      role: table.role,
      nosql: table.nosql,
      columns: table.columns.filter((column) => column.name !== SOURCE_ID_COLUMN),
      ...(table.subform ? { subform: { ...table.subform } } : {}),
    }));
}

/** The Creator name a backup header carries for a column: the field name of a renamed column. */
function sourceName(column: SchemaColumn): string {
  return column.field ?? column.name;
}

function findColumn(spec: BackupSpec, header: string): SchemaColumn | undefined {
  const key = normKey(header);
  const exact = spec.columns.find((column) => sourceName(column) === header);
  if (exact && !exact.shadowFor) return exact;
  const folded = spec.columns.filter((column) => !column.shadowFor && normKey(sourceName(column)) === key);
  if (folded.length === 1) return folded[0];
  if (folded.length > 1) throw new Error(`header ${JSON.stringify(header)} matches more than one column of ${spec.table}`);
  const dot = header.indexOf('.');
  if (dot > 0) {
    const part = spec.columns.find((column) => normKey(column.name) === normKey(`${header.slice(0, dot)}_${header.slice(dot + 1)}`));
    if (part && !part.shadowFor) return part;
  }
  return undefined;
}

type CellKind = 'text' | 'date' | 'datetime' | 'decimal' | 'bool' | 'multi' | 'file' | 'number';

function columnKind(column: SchemaColumn): CellKind {
  switch (column.matrixId) {
    case 'date':
      return 'date';
    case 'date-time':
      return 'datetime';
    case 'decimal':
    case 'percent':
    case 'currency':
      return 'decimal';
    case 'decision-box':
      return 'bool';
    case 'multi-select':
    case 'checkbox-multi':
      return 'multi';
    case 'file-upload':
    case 'image':
    case 'audio':
    case 'video':
    case 'signature':
      return 'file';
    case 'number':
    case 'auto-number':
    case 'users':
      return 'number';
    default:
      if (column.dataType === 'Double') return 'decimal';
      if (column.dataType === 'Boolean') return 'bool';
      if (column.dataType === 'Date') return 'date';
      if (column.dataType === 'DateTime') return 'datetime';
      return 'text';
  }
}

/** Epoch milliseconds → `yyyy-MM-dd HH:mm:ss` in the application's zone. */
function epochParts(ms: string, tz: string, file: string, header: string): { date: string; time: string } {
  if (!/^\d+$/.test(ms)) throw new Error(`${header} in ${file} is not epoch milliseconds`);
  const n = Number(ms);
  if (!Number.isSafeInteger(n)) throw new Error(`${header} in ${file} is an epoch beyond MAX_SAFE_INTEGER`);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(n)).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

function convertCell(header: string, raw: string, column: SchemaColumn, kind: CellKind, file: string, tz: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  switch (kind) {
    case 'date': {
      if (/^\d+$/.test(text)) return epochParts(text, tz, file, header).date;
      const parsed = normalizeDate(text);
      return parsed.ok ? parsed.value : text;
    }
    case 'datetime': {
      if (/^\d+$/.test(text)) {
        const parts = epochParts(text, tz, file, header);
        return `${parts.date} ${parts.time}`;
      }
      const parsed = normalizeDateTime(text);
      if (!parsed.ok) throw new Error(`${header} in ${file} is not a date-time`);
      return parsed.value;
    }
    case 'decimal': {
      const stripped = text.replace(/[$₹€£%\s]/g, '');
      const grouped = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(stripped) ? stripped.replace(/,/g, '') : stripped;
      if (!/^-?\d+(\.\d+)?$/.test(grouped)) throw new Error(`${header} in ${file} is not a decimal`);
      if (!column.exactDecimal) return grouped;
      const scale = column.precision ?? 2;
      const dot = grouped.indexOf('.');
      const digits = dot < 0 ? 0 : grouped.length - dot - 1;
      // Extra fractional digits reach the writer so it can refuse them, not be rounded away.
      if (digits > scale) return grouped;
      try {
        return quantizeDecimal(grouped, scale);
      } catch {
        throw new Error(`${header} in ${file} is not a decimal`);
      }
    }
    case 'bool': {
      const value = text.toLowerCase();
      if (value === 'true' || value === 'yes' || value === '1') return 'true';
      if (value === 'false' || value === 'no' || value === '0') return 'false';
      throw new Error(`${header} in ${file} is not true or false`);
    }
    case 'multi':
      return encodeMultiValue(splitMultiValueText(text));
    case 'number':
      if (!/^-?\d+$/.test(text)) throw new Error(`${header} in ${file} is not a whole number`);
      return text;
    default:
      return text;
  }
}

interface OwnerRows {
  spec: BackupSpec;
  rows: Map<string, SeedRow>;
}

interface Counters {
  personalCells: Map<string, number>;
  skippedStatus: number;
  unlinked: Map<string, number>;
  unresolvedRefs: Map<string, number>;
  fileCells: Map<string, number>;
  relRows: Map<string, number>;
  junctionDedup: number;
  extraCells: Map<string, number>;
}

function count(map: Map<string, number>, key: string, n = 1): void {
  map.set(key, (map.get(key) ?? 0) + n);
}

export function readSourceBackup(source: string, app: App, allowEmpty = false): CsvLoad {
  const budget: ZipBudget = { used: 0 };
  const root = openBackup(source, budget);

  const manifest = root.names.includes('app_manifest.xml') ? root.read('app_manifest.xml').toString('utf8') : '';
  const linkName = xmlTag(manifest, 'link-name');
  if (linkName && app.name && linkKey(app.name) !== linkKey(linkName)) {
    throw new Error(`the backup is application "${linkName}" but the --ds source parses as "${app.name}"`);
  }

  // Data chunks: data/data_N.zip members, or the same files already extracted
  // under data/data_N/ when a directory was passed.
  const inner = innerMembers(root, budget);

  const appInfo = inner.get('appInfo.xml')?.toString('utf8') ?? '';
  const recordsCount = xmlTag(inner.get('appDataInfo.xml')?.toString('utf8') ?? '', 'records-count');
  const tzGuess = xmlTag(appInfo, 'application-time-zone') ?? appTimeZone(app) ?? '';
  let tz = 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tzGuess || 'UTC' });
    tz = tzGuess || 'UTC';
  } catch {
    tz = 'UTC';
  }

  const schema = generateSchema(app);
  const specs = backupSpecs(schema.tables);
  const byTable = new Map(specs.map((spec) => [spec.table, spec]));
  const foreignKeys = specs.flatMap((spec) =>
    spec.columns.filter((column) => column.relation).map((column) => ({ table: spec.table, column: column.name, parent: column.relation!.table })),
  );
  assertLookupRemaps(
    specs.flatMap((spec) =>
      spec.columns
        .filter((column) => !column.shadowFor && (column.relation !== undefined || column.matrixId === 'lookup-single' || column.matrixId === 'lookup-multi'))
        .map((column) => ({ table: spec.table, column: column.name })),
    ),
    foreignKeys,
  );
  const nosqlSkipped: CsvGap[] = schema.tables
    .filter((table) => table.nosql)
    .map((table) => ({ form: table.form, table: table.name, detail: 'POST /nosqltable is refused' }));

  const counters: Counters = {
    personalCells: new Map(),
    skippedStatus: 0,
    unlinked: new Map(),
    unresolvedRefs: new Map(),
    fileCells: new Map(),
    relRows: new Map(),
    junctionDedup: 0,
    extraCells: new Map(),
  };
  const owners = new Map<string, OwnerRows>();
  const notes: CsvColumnNote[] = [];
  const missingRequired: CsvLoad['missingRequired'] = [];
  const absentFields: CsvLoad['absentFields'] = [];
  const fidelity: string[] = [];
  const covered = new Map<string, Set<string>>();
  const junctions = new Map<string, Map<string, SeedRow>>();
  const junctionOrder = new Map<string, number>();
  const nextJunctionOrder = (table: string, parent: string): string => {
    const key = `${table}\0${parent}`;
    const order = junctionOrder.get(key) ?? 0;
    junctionOrder.set(key, order + 1);
    return String(order);
  };
  // Tables the backup cannot vouch complete: a child row no rel file links to
  // a live parent is skipped, and a junction link naming a base or target
  // outside the backup builds no row. Either leaves the table short of the
  // rows its own files hold, so a delta delete needs more proof.
  const incompleteTables = new Set<string>();
  // Lookup edges the schema columns do not carry as `relation`: a filtered
  // lookup (`values = Form[filter].ID`) stays a plain column, and so does the
  // reverse side of a `bidirectional` pair. Both still hold the target's record
  // id, so they need an entry for ROWID remap and write ordering.
  const lookupEdges = new Map<string, { table: string; column: string; parent: string }>();
  const appUsers = inner.has('appUsers.csv') ? Math.max(0, parseBackupCsv(inner.get('appUsers.csv')!.toString('utf8')).length - 1) : 0;
  const appAdmins = inner.has('appAdmins.csv') ? Math.max(0, parseBackupCsv(inner.get('appAdmins.csv')!.toString('utf8')).length - 1) : 0;

  const basics = [...inner.keys()].filter((name) => /^basic#[^#]+\.csv$/i.test(name)).sort();
  const rels = [...inner.keys()].filter((name) => /^rel#/i.test(name)).sort();
  const knownMeta = new Set(['appInfo.xml', 'appDataInfo.xml', 'appUsers.csv', 'appAdmins.csv']);
  const consumed = new Set([...basics, ...rels, ...knownMeta]);
  const stray = [...inner.keys()].filter((name) => /^(basic|rel)#/i.test(name) && !consumed.has(name)).sort();
  if (stray.length) {
    throw new Error(
      `${stray[0]} looks like form or relation data but is not a basic#<Form>.csv, basic#<Subform>@<Parent>.csv, or rel#<Field>#<Owner>.csv member`,
    );
  }
  const otherPayloads = [...inner.keys()].filter((name) => !consumed.has(name)).sort();
  const otherOuter = root.names
    .filter((name) => !['app_manifest.xml', 'meta.zds', 'sync.zip'].includes(name) && !/^data\/data_\d+\.zip$/.test(name) && !/^data\/data_\d+\//.test(name))
    .sort();

  /** The field one covered column belongs to on this spec's form. */
  const coverField = (spec: BackupSpec, column: string): string => {
    const fields = spec.role === 'child' ? formOf(spec.form)?.fields.find((f) => f.name === spec.subform?.field)?.subfields : formOf(spec.form)?.fields;
    const field = fields?.find((item) => item.name === column || column.startsWith(`${item.name}_`));
    return field?.name ?? column;
  };
  const formOf = (name: string): App['forms'][number] | undefined => app.forms.find((form) => normKey(form.name) === normKey(name));
  const markCovered = (spec: BackupSpec, field: string): void => {
    const set = covered.get(spec.table) ?? new Set<string>();
    set.add(field);
    covered.set(spec.table, set);
  };
  /** The junction spec a multi field maps to: `<table>__<field>` on this form. */
  const junctionFor = (form: string, field: string): BackupSpec | undefined =>
    specs.find(
      (item) =>
        item.role === 'junction' &&
        normKey(item.form) === normKey(form) &&
        normKey(item.table.slice(item.table.lastIndexOf('__') + 2)) === normKey(field),
    );

  const basicTables = new Map<string, string>();
  let formFileRows = 0;
  for (const name of basics) {
    const inner1 = name.slice('basic#'.length, -'.csv'.length);
    const at = inner1.split('@');
    const spec =
      at.length === 2
        ? specs.find((item) => item.role === 'child' && normKey(item.subform?.field ?? '') === normKey(at[0]!) && normKey(item.subform?.form ?? '') === normKey(at[1]!))
        : specs.find((item) => item.role === 'form' && normKey(item.form) === normKey(inner1));
    if (!spec) throw new Error(`${name} does not match a form or subform of the --ds application`);
    if (spec.nosql) throw new Error(`${name} is a NoSQL form; this stage does not load it`);
    const prior = basicTables.get(spec.table);
    if (prior) throw new Error(`${name} and ${prior} both load into ${spec.table}`);
    basicTables.set(spec.table, name);
    const sheet = parseSheet(name, inner.get(name)!);
    if (sheet.extraCells) count(counters.extraCells, name, sheet.extraCells);
    if (spec.role === 'form') formFileRows += sheet.rows.length;
    const rows = new Map<string, SeedRow>();
    const mapped: { header: string; column: string }[] = [];
    const unmapped: { header: string; reason: string }[] = [];
    interface Hit {
      kind: 'id' | 'time' | 'personal' | 'status' | 'column' | 'skip';
      column?: SchemaColumn;
      reason?: string;
    }
    const hits: Hit[] = sheet.headers.map((header) => {
      const key = normKey(header);
      if (key === 'id') {
        mapped.push({ header, column: SOURCE_ID_COLUMN });
        return { kind: 'id' };
      }
      if (TIME_HEADERS.has(key)) {
        const column = spec.columns.find((item) => item.name === header);
        if (column) {
          mapped.push({ header, column: column.name });
          markCovered(spec, column.name);
          return { kind: 'time', column };
        }
        unmapped.push({ header, reason: 'no matching column' });
        return { kind: 'skip' };
      }
      if (PERSONAL_HEADERS.has(key)) {
        unmapped.push({ header, reason: 'account identity, counted not imported' });
        return { kind: 'personal' };
      }
      if (key === STATUS_HEADER) return { kind: 'status' };
      if (key === MARKER_HEADER) {
        unmapped.push({ header, reason: 'internal record-type marker' });
        return { kind: 'skip' };
      }
      const column = findColumn(spec, header);
      if (!column) {
        unmapped.push({ header, reason: 'no matching field' });
        return { kind: 'skip' };
      }
      if (column.relation) {
        unmapped.push({ header, reason: 'a relation column is linked only through the rel# files' });
        return { kind: 'skip' };
      }
      mapped.push({ header, column: column.name });
      markCovered(spec, coverField(spec, sourceName(column)));
      return { kind: 'column', column };
    });
    let rowIndex = 0;
    for (const record of sheet.rows) {
      rowIndex += 1;
      const columns: Record<string, string> = {};
      let id = '';
      let status = '';
      hits.forEach((hit, index) => {
        const header = sheet.headers[index] ?? '';
        const cell = record[index] ?? '';
        if (hit.kind === 'id') {
          id = recordId(cell, name, header);
          return;
        }
        if (hit.kind === 'status') {
          status = cell.trim();
          return;
        }
        if (hit.kind === 'personal') {
          if (cell.trim()) count(counters.personalCells, spec.table);
          return;
        }
        if (hit.kind === 'time' && hit.column) {
          const value = convertCell(header, cell, hit.column, 'datetime', name, tz);
          if (value !== undefined) columns[hit.column.name] = value;
          return;
        }
        if (hit.kind !== 'column' || !hit.column) return;
        const kind = columnKind(hit.column);
        if (kind === 'file' && cell.trim()) count(counters.fileCells, spec.table);
        const value = convertCell(header, cell, hit.column, kind, name, tz);
        if (value !== undefined) columns[hit.column.name] = value;
      });
      if (status !== '' && status !== '0') {
        counters.skippedStatus += 1;
        continue;
      }
      if (!id) throw new Error(`${name} row ${rowIndex} has an empty ID`);
      if (rows.has(id)) throw new Error(`${name} holds record id ${id} twice`);
      // Exact-decimal shadow columns are filled from the varchar, never read from the file.
      for (const column of spec.columns) {
        if (!column.shadowFor || columns[column.shadowFor] === undefined) continue;
        const shadow = decimalShadow(columns[column.shadowFor]!);
        if (shadow !== null) columns[column.name] = String(shadow);
      }
      rows.set(id, { id, columns });
    }
    notes.push({ file: name, table: spec.table, mapped, unmapped });
    owners.set(spec.table, { spec, rows });
  }

  // rel#<Field>#<Owner>.csv — owner is a form link name or <Subform>@<Parent>.
  for (const name of rels) {
    const body = name.slice(0, -'.csv'.length);
    const parts = body.split('#');
    if (parts.length !== 3) throw new Error(`${name} is not a rel#<field>#<owner> name`);
    const fieldName = parts[1]!;
    const ownerName = parts[2]!;
    const sheet = parseSheet(name, inner.get(name)!);
    const baseCol = sheet.headers.findIndex((header) => /(^|#)BASE$/.test(header));
    const refCol = sheet.headers.findIndex((header) => /(^|#)REF$/.test(header));
    if (baseCol < 0 || refCol < 0 || sheet.headers.length !== 2) {
      throw new Error(`${name} must hold exactly a BASE and a REF record-id column`);
    }
    const pairs = sheet.rows.map((record) => ({
      base: recordId(record[baseCol] ?? '', name, sheet.headers[baseCol]!),
      ref: recordId(record[refCol] ?? '', name, sheet.headers[refCol]!),
    }));

    const ownerSpec = ownerName.includes('@')
      ? (() => {
          const [sub, parent] = ownerName.split('@');
          return specs.find((item) => item.role === 'child' && normKey(item.subform?.field ?? '') === normKey(sub!) && normKey(item.subform?.form ?? '') === normKey(parent!));
        })()
      : specs.find((item) => item.role === 'form' && normKey(item.form) === normKey(ownerName));
    if (!ownerSpec) throw new Error(`${name}: ${ownerName} is not a form or subform of the --ds application`);
    if (ownerSpec.nosql) {
      fidelity.push(`${name}: ${ownerName} is a NoSQL form; its rows are not loaded`);
      continue;
    }
    const ownerRows = owners.get(ownerSpec.table);
    if (!ownerRows) {
      fidelity.push(`${name}: ${ownerName} holds no rows in the backup; ${pairs.length} relation row(s) not applied`);
      continue;
    }

    const ownerForm = formOf(ownerSpec.form);
    const ownerField: Field | undefined = ownerSpec.role === 'child'
      ? ownerForm?.fields.find((field) => normKey(field.name) === normKey(ownerSpec.subform?.field ?? ''))?.subfields.find((sub) => normKey(sub.name) === normKey(fieldName))
      : ownerForm?.fields.find((field) => normKey(field.name) === normKey(fieldName));

    // An inline subform's rel file carries the parent link and row order.
    if (ownerSpec.role === 'form') {
      const child = specs.find(
        (item) => item.role === 'child' && normKey(item.subform?.field ?? '') === normKey(fieldName) && normKey(item.subform?.form ?? '') === normKey(ownerName),
      );
      if (child) {
        const childRows = owners.get(child.table);
        if (!childRows) {
          fidelity.push(`${name}: ${child.table} holds no rows in the backup; ${pairs.length} relation row(s) not applied`);
          continue;
        }
        const order = new Map<string, number>();
        const seen = new Set<string>();
        for (const pair of pairs) {
          const base = ownerRows.rows.get(pair.base);
          const row = childRows.rows.get(pair.ref);
          if (!base || !row) {
            count(counters.unlinked, name);
            continue;
          }
          if (seen.has(pair.ref)) throw new Error(`${name}: subform row ${pair.ref} appears under more than one parent`);
          seen.add(pair.ref);
          const position = order.get(pair.base) ?? 0;
          order.set(pair.base, position + 1);
          row.columns[child.subform!.parentColumn] = pair.base;
          row.columns[child.subform!.orderColumn] = String(position);
          count(counters.relRows, `${child.table}.${child.subform!.parentColumn}`);
        }
        markCovered(ownerSpec, fieldName);
        continue;
      }
    }

    if (!ownerField) throw new Error(`${name}: ${ownerName} has no field ${fieldName} in the --ds application`);

    // A multi lookup is a junction table: one generated row per (base, ref).
    if (ownerField.lookup && isMultiField(ownerField) && !isSubformField(ownerField)) {
      const junction = junctionFor(ownerSpec.form, fieldName);
      if (!junction) {
        fidelity.push(`${name}: ${ownerSpec.form}.${fieldName} is a multi lookup the schema does not store; ${pairs.length} relation row(s) not carried`);
        continue;
      }
      const link = junction.columns.find((column) => column.name !== 'parent_id' && column.name !== 'row_order' && !column.shadowFor);
      if (!link) throw new Error(`${name}: ${junction.table} has no link column`);
      const targetSpec = link.relation ? byTable.get(link.relation.table) : undefined;
      // A `bidirectional` list also fills the single-lookup back column on the
      // target — or, when the reverse side is a multi too, the reverse junction.
      const backName = fieldProp(ownerField, 'bidirectional');
      const backColumn =
        targetSpec && backName
          ? targetSpec.columns.find((column) => normKey(column.name) === normKey(backName)) ??
            targetSpec.columns.find((column) => column.relation?.table === ownerSpec.table)
          : undefined;
      const backRows = backColumn ? owners.get(targetSpec!.table) : undefined;
      const backField = targetSpec && backName ? formOf(targetSpec.form)?.fields.find((candidate) => normKey(candidate.name) === normKey(backName)) : undefined;
      const backIsMulti = !!backField && isMultiField(backField) && !isSubformField(backField);
      const backJunction = !backColumn && targetSpec && backName && backIsMulti ? junctionFor(targetSpec.form, backName) : undefined;
      const backJunctionLink = backJunction?.columns.find((column) => column.name !== 'parent_id' && column.name !== 'row_order' && !column.shadowFor);
      const backJunctionRows = backJunction ? (junctions.get(backJunction.table) ?? new Map<string, SeedRow>()) : undefined;
      if (backJunction && backJunctionRows) junctions.set(backJunction.table, backJunctionRows);
      const rows = junctions.get(junction.table) ?? new Map<string, SeedRow>();
      junctions.set(junction.table, rows);
      for (const pair of pairs) {
        if (!ownerRows.rows.has(pair.base)) {
          count(counters.unlinked, name);
          incompleteTables.add(junction.table);
          continue;
        }
        if (targetSpec && !owners.get(targetSpec.table)?.rows.has(pair.ref)) {
          count(counters.unresolvedRefs, name);
          incompleteTables.add(junction.table);
          continue;
        }
        const id = `${pair.base}__${link.name}__${pair.ref}`;
        if (rows.has(id)) {
          counters.junctionDedup += 1;
        } else {
          rows.set(id, { id, columns: { parent_id: pair.base, row_order: nextJunctionOrder(junction.table, pair.base), [link.name]: pair.ref } });
          count(counters.relRows, `${junction.table}.${link.name}`);
        }
        if (backColumn && backRows) {
          const row = backRows.rows.get(pair.ref);
          if (row) {
            if (backIsMulti) {
              const prior = row.columns[backColumn.name];
              const list: string[] = prior === undefined ? [] : (JSON.parse(prior) as string[]);
              if (!list.includes(pair.base)) list.push(pair.base);
              row.columns[backColumn.name] = JSON.stringify(list);
            } else {
              const prior = row.columns[backColumn.name];
              if (prior !== undefined && prior !== pair.base) {
                throw new Error(`${name}: ${targetSpec!.table}.${backColumn.name} for ${pair.ref} is ${prior} and ${pair.base}`);
              }
              row.columns[backColumn.name] = pair.base;
            }
            count(counters.relRows, `${targetSpec!.table}.${backColumn.name}`);
            markCovered(targetSpec!, coverField(targetSpec!, backColumn.name));
            if (!backColumn.relation && !lookupEdges.has(`${targetSpec!.table}\0${backColumn.name}`)) {
              lookupEdges.set(`${targetSpec!.table}\0${backColumn.name}`, { table: targetSpec!.table, column: backColumn.name, parent: ownerSpec.table });
            }
          }
        }
        if (backJunction && backJunctionLink && backJunctionRows) {
          const id = `${pair.ref}__${backJunctionLink.name}__${pair.base}`;
          if (backJunctionRows.has(id)) {
            counters.junctionDedup += 1;
          } else {
            backJunctionRows.set(id, { id, columns: { parent_id: pair.ref, row_order: nextJunctionOrder(backJunction.table, pair.ref), [backJunctionLink.name]: pair.base } });
            count(counters.relRows, `${backJunction.table}.${backJunctionLink.name}`);
          }
        }
      }
      markCovered(ownerSpec, fieldName);
      continue;
    }

    // A grid+values subform field stores its link on the target table
    // (bidirectional) — the base id lands in the target row's back column.
    if (ownerField.lookup && isSubformField(ownerField)) {
      const targetForm = ownerField.lookup.form;
      const targetSpec = specs.find((item) => item.role === 'form' && normKey(item.form) === normKey(targetForm));
      const back = fieldProp(ownerField, 'bidirectional') ?? `${ownerSpec.form}_id`;
      const backColumn =
        targetSpec?.columns.find((column) => normKey(column.name) === normKey(back)) ??
        targetSpec?.columns.find((column) => column.relation?.table === ownerSpec.table);
      const targetRows = targetSpec ? owners.get(targetSpec.table) : undefined;
      if (!targetSpec || !targetRows || !backColumn) {
        fidelity.push(`${name}: ${ownerSpec.form}.${fieldName} is a lookup subform with no back column on ${targetForm}; ${pairs.length} relation row(s) not carried`);
        continue;
      }
      for (const pair of pairs) {
        const row = targetRows.rows.get(pair.ref);
        if (!row || !ownerRows.rows.has(pair.base)) {
          count(row ? counters.unlinked : counters.unresolvedRefs, name);
          continue;
        }
        const prior = row.columns[backColumn.name];
        if (prior !== undefined && prior !== pair.base) throw new Error(`${name}: ${targetSpec.table}.${backColumn.name} for ${pair.ref} is ${prior} and ${pair.base}`);
        row.columns[backColumn.name] = pair.base;
        count(counters.relRows, `${targetSpec.table}.${backColumn.name}`);
        markCovered(targetSpec, coverField(targetSpec, backColumn.name));
      }
      markCovered(ownerSpec, fieldName);
      continue;
    }

    // A single lookup — or a filtered one (`values = Form[filter].ID`), which the
    // schema stores as a plain column — takes one ref per base in the named column.
    const column = ownerSpec.columns.find((item) => normKey(sourceName(item)) === normKey(fieldName));
    if (!column) {
      if (!ownerField.lookup) throw new Error(`${name}: ${ownerName}.${fieldName} is not a relation field and has no column`);
      fidelity.push(`${name}: ${ownerName}.${fieldName} has no column in the schema; ${pairs.length} relation row(s) not carried`);
      continue;
    }
    // The ref's table: a real foreign key names it; a filtered lookup resolves
    // the target form instead, so the id can still be checked and remapped.
    const linkSpec = column.relation
      ? byTable.get(column.relation.table)
      : ownerField.lookup
        ? specs.find((item) => item.role === 'form' && normKey(item.form) === normKey(ownerField.lookup!.form))
        : undefined;
    const targetSpec = column.relation ? linkSpec : undefined;
    const seen = new Map<string, string>();
    for (const pair of pairs) {
      const prior = seen.get(pair.base);
      if (prior !== undefined && prior !== pair.ref) {
        throw new Error(`${name}: ${ownerName}.${fieldName} is a single-value relation but base ${pair.base} has more than one value`);
      }
      seen.set(pair.base, pair.ref);
      const row = ownerRows.rows.get(pair.base);
      if (!row) {
        count(counters.unlinked, name);
        continue;
      }
      if (linkSpec && !owners.get(linkSpec.table)?.rows.has(pair.ref)) {
        count(counters.unresolvedRefs, name);
        continue;
      }
      row.columns[column.name] = pair.ref;
      count(counters.relRows, `${ownerSpec.table}.${column.name}`);
    }
    if (!column.relation && pairs.length) {
      if (ownerField.lookup && linkSpec) {
        lookupEdges.set(`${ownerSpec.table}\0${column.name}`, { table: ownerSpec.table, column: column.name, parent: linkSpec.table });
        fidelity.push(`${name}: ${ownerName}.${fieldName} is a filtered lookup — ${pairs.length} target record id(s) carried; remapped to the target ROWID, not a store foreign key`);
      } else {
        fidelity.push(`${name}: ${ownerName}.${fieldName} is not a linked field — ${pairs.length} target record id(s) written as text`);
      }
    }
    // A `bidirectional` pair stores the link once, from this side: the named
    // reverse column on the target table gets the base id back.
    const backName = fieldProp(ownerField, 'bidirectional');
    const backSpec =
      backName === undefined
        ? undefined
        : (linkSpec ??
          specs.find((item) => {
            if (item.role !== 'form') return false;
            const form = formOf(item.form);
            return (
              form?.fields.some(
                (candidate) =>
                  normKey(candidate.name) === normKey(backName) &&
                  (candidate.lookup ? normKey(candidate.lookup.form) === normKey(ownerSpec.form) : normKey(fieldProp(candidate, 'bidirectional') ?? '') === normKey(fieldName)),
              ) ?? false
            );
          }));
    const backColumn = backSpec
      ? backSpec.columns.find((item) => normKey(item.name) === normKey(backName!)) ??
        backSpec.columns.find((item) => item.relation?.table === ownerSpec.table)
      : undefined;
    if (backName !== undefined) {
      const backRows = backSpec ? owners.get(backSpec.table) : undefined;
      // The reverse side can itself be a multi lookup: a junction when it is a
      // real list relation, else a plain multi column holding the id list.
      const backField = backSpec ? formOf(backSpec.form)?.fields.find((candidate) => normKey(candidate.name) === normKey(backName)) : undefined;
      const backIsMulti = !!backField && isMultiField(backField) && !isSubformField(backField);
      const backJunction = !backColumn && backSpec && backIsMulti ? junctionFor(backSpec.form, backName) : undefined;
      if (!backSpec || (!backColumn && !backJunction)) {
        fidelity.push(`${name}: ${ownerSpec.form}.${fieldName} is bidirectional but ${ownerField.lookup?.form ?? 'the target'} has no ${backName} column; the reverse value is not carried`);
      } else if (backJunction) {
        const link = backJunction.columns.find((item) => item.name !== 'parent_id' && item.name !== 'row_order' && !item.shadowFor);
        if (!link) throw new Error(`${name}: ${backJunction.table} has no link column`);
        const rows = junctions.get(backJunction.table) ?? new Map<string, SeedRow>();
        junctions.set(backJunction.table, rows);
        for (const pair of pairs) {
          if (!backRows?.rows.has(pair.ref)) {
            count(counters.unresolvedRefs, name);
            incompleteTables.add(backJunction.table);
            continue;
          }
          if (!ownerRows.rows.has(pair.base)) {
            incompleteTables.add(backJunction.table);
            continue;
          }
          const id = `${pair.ref}__${link.name}__${pair.base}`;
          if (rows.has(id)) {
            counters.junctionDedup += 1;
          } else {
            rows.set(id, { id, columns: { parent_id: pair.ref, row_order: nextJunctionOrder(backJunction.table, pair.ref), [link.name]: pair.base } });
            count(counters.relRows, `${backJunction.table}.${link.name}`);
          }
        }
      } else if (!backRows) {
        fidelity.push(`${name}: ${backSpec.table} holds no rows in the backup; ${pairs.length} reverse relation value(s) not applied`);
      } else if (backColumn) {
        for (const pair of pairs) {
          const row = backRows.rows.get(pair.ref);
          if (!row) {
            if (backSpec !== targetSpec) count(counters.unresolvedRefs, name);
            continue;
          }
          if (!ownerRows.rows.has(pair.base)) continue;
          if (backIsMulti) {
            const prior = row.columns[backColumn.name];
            const list: string[] = prior === undefined ? [] : (JSON.parse(prior) as string[]);
            if (!list.includes(pair.base)) list.push(pair.base);
            row.columns[backColumn.name] = JSON.stringify(list);
          } else {
            const prior = row.columns[backColumn.name];
            if (prior !== undefined && prior !== pair.base) {
              throw new Error(`${name}: ${backSpec.table}.${backColumn.name} for ${pair.ref} is ${prior} and ${pair.base}`);
            }
            row.columns[backColumn.name] = pair.base;
          }
          count(counters.relRows, `${backSpec.table}.${backColumn.name}`);
          markCovered(backSpec, coverField(backSpec, backColumn.name));
          if (!backColumn.relation && !lookupEdges.has(`${backSpec.table}\0${backColumn.name}`)) {
            lookupEdges.set(`${backSpec.table}\0${backColumn.name}`, { table: backSpec.table, column: backColumn.name, parent: ownerSpec.table });
          }
        }
      }
    }
    markCovered(ownerSpec, fieldName);
  }

  // A child row that no rel file linked to a live parent cannot be written:
  // skip it and count the drop rather than store it with no parent_id.
  const orphans = new Map<string, number>();
  for (const owner of owners.values()) {
    if (owner.spec.role !== 'child') continue;
    for (const [id, row] of owner.rows) {
      if (row.columns[owner.spec.subform!.parentColumn] === undefined) {
        owner.rows.delete(id);
        count(orphans, owner.spec.table);
      }
    }
  }
  for (const [table, n] of [...orphans.entries()].sort()) {
    fidelity.push(`${table}: ${n} row(s) skipped — the backup rel files link them to no live parent`);
    // The files hold rows the table does not: the backup is not complete for it.
    incompleteTables.add(table);
  }

  const tables: SeedTable[] = [];
  for (const owner of [...owners.values()].sort((a, b) => (a.spec.table < b.spec.table ? -1 : 1))) {
    tables.push({ table: owner.spec.table, rows: [...owner.rows.values()] });
  }
  for (const spec of specs.filter((item) => item.role === 'junction')) {
    const rows = junctions.get(spec.table);
    if (rows) tables.push({ table: spec.table, rows: [...rows.values()] });
  }

  for (const [file, n] of [...counters.unlinked.entries()].sort()) {
    fidelity.push(`${file}: ${n} relation row(s) name a base id not in the backup`);
  }
  for (const [file, n] of [...counters.unresolvedRefs.entries()].sort()) {
    fidelity.push(`${file}: ${n} relation row(s) name a target id not in the backup; the link is not written`);
  }
  for (const [file, n] of [...counters.extraCells.entries()].sort()) {
    fidelity.push(`${file}: ${n} row(s) carry cells past the last header; the extra values are ignored`);
  }
  for (const [table, n] of [...counters.fileCells.entries()].sort()) {
    fidelity.push(`${table}: ${n} file/image cell(s) hold a name the backup does not carry a payload for`);
  }

  foreignKeys.push(...lookupEdges.values());
  const expected = specs
    .filter((spec) => (spec.role === 'form' || spec.role === 'child') && !spec.nosql)
    .map((spec) => ({
      form: spec.role === 'child' ? `${spec.form}.${spec.subform?.field ?? spec.table}` : spec.form,
      table: spec.table,
      count: owners.get(spec.table)?.rows.size ?? 0,
    }));

  const lookups: CsvLoad['lookups'] = [];
  for (const spec of specs) {
    if (spec.nosql) continue;
    for (const column of spec.columns) {
      if (!column.relation || column.name === 'parent_id' || column.shadowFor) continue;
      const applied = counters.relRows.get(`${spec.table}.${column.name}`) ?? 0;
      lookups.push({ table: spec.table, column: column.name, parent: column.relation.table, by: `record id (${applied} backup rows)` });
    }
  }
  for (const edge of lookupEdges.values()) {
    const applied = counters.relRows.get(`${edge.table}.${edge.column}`) ?? 0;
    if (applied === 0) continue;
    lookups.push({ table: edge.table, column: edge.column, parent: edge.parent, by: `record id (${applied} backup rows)` });
  }

  for (const spec of specs) {
    if (spec.role !== 'form' || spec.nosql || !owners.has(spec.table)) continue;
    const form = formOf(spec.form);
    const done = covered.get(spec.table) ?? new Set<string>();
    for (const field of form?.fields ?? []) {
      const type = normalizeType(field.type);
      if (type === 'section' || type === 'plaintext' || done.has(field.name)) continue;
      if (field.required) missingRequired.push({ form: spec.form, table: spec.table, field: field.name });
      else absentFields.push({ form: spec.form, table: spec.table, field: field.name });
    }
  }

  // records-count covers the top-level form rows, Record_Status skips included;
  // subform rows are not counted. A disagreement means a missing or truncated chunk.
  if (recordsCount !== undefined) {
    if (!/^\d+$/.test(recordsCount)) throw new Error(`appDataInfo.xml records-count ${JSON.stringify(recordsCount)} is not a whole number`);
    if (Number(recordsCount) !== formFileRows) {
      throw new Error(`appDataInfo.xml records-count is ${recordsCount} but the backup holds ${formFileRows} top-level form row(s)`);
    }
  }

  const planNotes: string[] = [];
  const taken = xmlTag(manifest, 'time') ?? xmlTag(appInfo, 'backup-time');
  const dc = xmlTag(manifest, 'dc') ?? xmlTag(appInfo, 'dc');
  planNotes.push(`application ${linkName ?? app.name ?? '(unnamed)'}${dc ? `, dc ${dc}` : ''}${taken ? `, backed up ${taken}` : ''}`);
  const loadedRows = [...owners.values()].reduce((n, owner) => n + owner.rows.size, 0);
  planNotes.push(
    `data rows: ${loadedRows} loaded${recordsCount ? ` — appDataInfo.xml records-count ${recordsCount} matches the ${formFileRows} top-level form row(s)` : ''}`,
  );
  planNotes.push(`user lists: appUsers.csv ${appUsers} row(s), appAdmins.csv ${appAdmins} row(s) — identities counted, not imported`);
  const personal = [...counters.personalCells.values()].reduce((a, b) => a + b, 0);
  if (personal) {
    planNotes.push(`identity columns: ${personal} Added_User/Modified_User/IP value(s) over ${counters.personalCells.size} table(s) — personal data, counted not imported`);
  }
  if (counters.skippedStatus) planNotes.push(`${counters.skippedStatus} row(s) with a non-zero Record_Status were not imported`);
  planNotes.push(
    otherPayloads.length
      ? `files: ${otherPayloads.length} payload member(s) (${otherPayloads.join(', ')}) — file/image fields are not uploaded by this loader`
      : 'files: no file payloads in the backup; file/image cells stay empty',
  );
  if (counters.junctionDedup) planNotes.push(`${counters.junctionDedup} repeated relation row(s) collapsed to one junction row`);
  if (tz !== 'UTC' || tzGuess) planNotes.push(`Added_Time/Modified_Time epoch values are converted in ${tz}`);

  const systemFieldGaps = specs.flatMap((spec) => {
    const owner = owners.get(spec.table);
    if (!owner) return [];
    const filled = new Set<string>();
    for (const row of owner.rows.values()) for (const key of Object.keys(row.columns)) filled.add(key);
    const missing = SYSTEM_FIELD_COLUMNS.map((column) => column.name).filter(
      (name) => spec.columns.some((column) => column.name === name) && !filled.has(name),
    );
    return missing.length ? [{ table: spec.table, missing, detail: BACKUP_SYSTEM_GAP }] : [];
  });

  // A backup is the complete data source: a column it does not carry has no value
  // on any record. `carried` names the columns a header or a rel# link supplied.
  const carriedByTable = new Map<string, Set<string>>();
  const carry = (table: string, column: string): void => {
    const set = carriedByTable.get(table) ?? new Set<string>();
    set.add(column);
    carriedByTable.set(table, set);
  };
  for (const note of notes) for (const item of note.mapped) carry(note.table, item.column);
  for (const key of counters.relRows.keys()) {
    const dot = key.indexOf('.');
    if (dot > 0) carry(key.slice(0, dot), key.slice(dot + 1));
  }
  for (const table of tables) for (const row of table.rows) for (const column of Object.keys(row.columns)) carry(table.table, column);
  // A backup vouches complete only for a table it placed whole: a dropped
  // child row or junction link means the files hold more than the table, so
  // the table proves complete to a delta delete no better than a report does.
  const sourceData: SourceTableData[] = tables.map((table) => ({
    table: table.table,
    complete: !incompleteTables.has(table.table),
    carried: [...(carriedByTable.get(table.table) ?? [])].sort(),
    rows: table.rows,
  }));
  const generatedTables = schema.tables
    .filter((table) => (table.role === 'child' || table.role === 'junction') && !table.nosql)
    .map((table) => table.name);
  const checked = generateSchema(app, { source: sourceData });
  const constraints = checked.constraints ?? [];
  for (const decision of constraints) fidelity.push(constraintDecisionNote(decision));
  // A store-mandatory carried column inside a lookup cycle (a bidirectional
  // reverse carry, for one) keeps its edge in the write order — the deferred
  // row update cannot fill a mandatory cell.
  const ordered = orderTables(tables, foreignKeys, nonDeferrableKeys(checked, foreignKeys));

  const loaded: CsvLoad = {
    source: 'backup',
    tables: ordered,
    expected,
    countsFrom: 'backup',
    generatedTables,
    foreignKeys,
    skipped: nosqlSkipped,
    relaxed: mandatoryRelaxedColumns(tableCreatePlan(checked)),
    ...(systemFieldGaps.length ? { systemFieldGaps } : {}),
    columns: notes,
    missingRequired,
    missingMandatory: mandatoryMissingRefusals(ordered, loaderColumns(checked, ordered, foreignKeys)),
    overLength: overLengthRefusals(ordered, loaderColumns(checked, ordered, foreignKeys)),
    absentFields,
    derivedIds: [],
    lookups,
    fidelity: fidelity.concat(
      absentFields.map((field) => `${field.table}.${field.field} (${field.form}) is not in the backup; the column stays empty`),
    ),
    ignored: ['meta.zds', 'sync.zip']
      .filter((name) => root.names.includes(name))
      .map((name) => `${name} (application metadata, not data)`)
      .concat(otherPayloads.map((name) => `${name} (file payload, not uploaded by this loader)`))
      .concat(otherOuter.map((name) => `${name} (outside the data chunks)`)),
    notes: planNotes,
    sourceData,
    ...(constraints.length ? { constraints } : {}),
  };
  assertExportCounts(loaded, allowEmpty);
  return loaded;
}
