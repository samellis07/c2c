/**
 * Report verification runner: every generated report, chart and dashboard
 * page of a migrated app, rendered with seeded data and read back.
 *
 * Offline only. The deploy tree is generated and functions/c2c_api is served
 * in-process (startOfflineBackend, the same harness `c2c verify-behavior`
 * uses). `c2c seed` rows are written straight into the Data Store tables the
 * way the data loader lands them (store columns, lookups remapped to the
 * parent ROWIDs). Each screen is the one the React generator emits for the
 * report (ReportView, ChartReport, PageView), mounted in jsdom with its api
 * posting to the served function — no browser.
 *
 * Per screen the runner checks that the rows render, that the row count and
 * every numeric column total match the seed, record detail, chart buckets and
 * dashboard metric values; then the export formats (CSV exact against the
 * visible rows; XLSX and PDF present plus row count) and the print view.
 * Anything the generated app does not offer is a counted gap with its reason,
 * never a pass.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { deriveIr, parse } from '../../core/src/index.js';
import type { App } from '../../core/src/ir.js';
import { canonicalSeedJson, generateSeed, seedCompositeMap } from '../../data/src/seed.js';
import { columnRenamesOf, generateSchema } from '../../schema/src/generator.js';
import { bindRelativeCriteria, criteriaHasRelative, matchRow, type Criteria } from '../../shims/src/criteria.js';
import { generateUi, type UiModel } from '../../ui/src/index.js';
import { appTimeZone, dateFieldKinds } from '../../ui/src/generate.js';
import { comparisonZone } from './temporal.js';
import { compileTemplateLib, mountTemplateScreen, reactAppSpec, templateRuntimeReady, TEMPLATE_MISSING, type MountedScreen, type TemplateApi, type TemplateScreen } from '../../ui-react/src/index.js';
import type { AppSpec, ChartSpec, FilterClause, MetricSpec, PageElement, ReportSpec } from '../../ui-react/template/lib/c2c-ui/types.js';
import { deferredColumns, foreignKeysForApp, omitColumns, orderTables, resolveForeignKeys, sourceIds } from './remap.js';
import { parseSeed, seedStoreColumns } from './seed.js';
import { cyclicForeignKeys, foreignKeyId } from './tables.js';
import { startOfflineBackend, type BehaviorBackend } from './verify-behavior.js';
import { DEFAULT_MAX_ENTRY, readZip } from './zipfile.js';

export const REPORT_CHECK_VERSION = 'c2c-report-check/1';

export type CheckStatus = 'pass' | 'fail' | 'gap';
export type CheckName = 'rows' | 'totals' | 'cells' | 'detail' | 'chart' | 'metric' | 'view' | 'csv' | 'xlsx' | 'pdf' | 'print';
export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ScreenCheck {
  check: CheckName;
  status: CheckStatus;
  /** What was compared, or why this is a gap. */
  detail: string;
  expected?: unknown;
  actual?: unknown;
}

export interface ScreenResult {
  /** Report or page name. */
  screen: string;
  kind: 'list' | 'chart' | 'pivot' | 'dashboard' | ReportSpec['view'];
  checks: ScreenCheck[];
}

export interface AppReportResult {
  app: string;
  source: string;
  seedRows: Record<string, number>;
  screens: ScreenResult[];
  /** Fatal setup error (seed load, generation); the app then has no screens. */
  error?: string;
}

export interface ReportCheckReport {
  version: string;
  mode: 'offline';
  apps: AppReportResult[];
  totals: Record<CheckStatus, number>;
  /** Per check name: pass/fail/gap counts across every app and screen. */
  byCheck: Record<string, Record<CheckStatus, number>>;
}

type Row = Record<string, unknown>;

// ---------- export file verification (pure) ----------

/** One CSV field, RFC 4180 quoted when it holds a comma, quote or line break. */
function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The exact CSV the visible table must export: header labels, then one line per visible row. */
export function expectedCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header, ...rows].map((line) => line.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** CSV export check: byte-exact against the visible rows (a BOM and LF line ends are tolerated). */
export function verifyCsvExport(file: string, header: readonly string[], rows: readonly (readonly string[])[]): ScreenCheck {
  const want = expectedCsv(header, rows);
  const got = file.replace(/^﻿/, '').replace(/\r?\n/g, '\r\n');
  if (got === want) return { check: 'csv', status: 'pass', detail: `CSV matches the ${rows.length} visible rows exactly` };
  const wantLines = want.split('\r\n');
  const gotLines = got.split('\r\n');
  const at = wantLines.findIndex((line, i) => gotLines[i] !== line);
  return {
    check: 'csv',
    status: 'fail',
    detail: `CSV differs from the visible rows at line ${at + 1}`,
    expected: wantLines[at],
    actual: gotLines[at] ?? '<missing>',
  };
}

/** Data rows of the first worksheet of an XLSX workbook (the header row excluded). */
export function xlsxRowCount(bytes: Buffer): number {
  const entries = readZip(bytes, { maxEntries: 512, maxEntryBytes: DEFAULT_MAX_ENTRY });
  const sheet = entries.find((entry) => /^xl\/worksheets\/sheet1\.xml$/.test(entry.name)) ?? entries.find((entry) => /^xl\/worksheets\/[^/]+\.xml$/.test(entry.name));
  if (!sheet) throw new Error('XLSX has no worksheet part');
  const rows = sheet.data.toString('utf8').match(/<(?:\w+:)?row[\s>]/g) ?? [];
  return Math.max(0, rows.length - 1);
}

/** XLSX export check: a readable workbook whose first sheet holds one data row per visible row. */
export function verifyXlsxExport(bytes: Buffer, visibleRows: number): ScreenCheck {
  let count: number;
  try {
    count = xlsxRowCount(bytes);
  } catch (err) {
    return { check: 'xlsx', status: 'fail', detail: `XLSX is not readable: ${err instanceof Error ? err.message : String(err)}` };
  }
  return count === visibleRows
    ? { check: 'xlsx', status: 'pass', detail: `XLSX holds the ${visibleRows} visible rows` }
    : { check: 'xlsx', status: 'fail', detail: 'XLSX row count differs from the visible rows', expected: visibleRows, actual: count };
}

/**
 * Text shown by a PDF's content streams (Tj/TJ strings; Flate streams inflated).
 * Inflated streams share one budget, the zip reader's member cap; past it this
 * throws instead of inflating further.
 */
export function pdfText(bytes: Buffer, maxInflatedBytes = DEFAULT_MAX_ENTRY): string {
  const raw = bytes.toString('latin1');
  const parts: string[] = [];
  let inflated = 0;
  const overCap = `PDF content streams inflate past the ${maxInflatedBytes} byte cap`;
  const stream = /<<([^]*?)>>\s*stream\r?\n([^]*?)\r?\nendstream/g;
  for (let m = stream.exec(raw); m; m = stream.exec(raw)) {
    let body = m[2]!;
    if (/\/FlateDecode/.test(m[1]!)) {
      let data: Buffer;
      try {
        data = inflateSync(Buffer.from(body, 'latin1'), { maxOutputLength: maxInflatedBytes - inflated + 1 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new Error(overCap);
        continue;
      }
      inflated += data.length;
      if (inflated > maxInflatedBytes) throw new Error(overCap);
      body = data.toString('latin1');
    }
    const text = /\((?:\\.|[^\\)])*\)/g;
    for (let t = text.exec(body); t; t = text.exec(body)) parts.push(t[0].slice(1, -1).replace(/\\([()\\])/g, '$1'));
  }
  return parts.join('\n');
}

/** PDF export check: a PDF file that shows the key cell of every visible row. */
export function verifyPdfExport(bytes: Buffer, rowKeys: readonly string[]): ScreenCheck {
  const head = bytes.subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') return { check: 'pdf', status: 'fail', detail: 'export is not a PDF file', actual: head };
  let text: string;
  try {
    text = pdfText(bytes);
  } catch (err) {
    return { check: 'pdf', status: 'fail', detail: `PDF is not readable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const shown = rowKeys.filter((key) => key && text.includes(key)).length;
  return shown === rowKeys.length
    ? { check: 'pdf', status: 'pass', detail: `PDF shows the ${rowKeys.length} visible rows` }
    : { check: 'pdf', status: 'fail', detail: 'PDF row count differs from the visible rows', expected: rowKeys.length, actual: shown };
}

// ---------- seed ----------

interface SeededApp {
  /** Store rows per table, ROWID included, in insert order. */
  stored: Map<string, Row[]>;
}

/** Load `c2c seed` rows into the offline Data Store the way the data loader lands them. */
export async function loadSeed(app: App, backend: BehaviorBackend, n: number): Promise<SeededApp> {
  if (!backend.insertRows) throw new Error('the backend cannot write seed rows');
  const seed = generateSeed(app, { n });
  if (seed.blockers.length) throw new Error(`seed blocked: ${seed.blockers.map((b) => `${b.form}${b.field ? `.${b.field}` : ''} ${b.message}`).join('; ')}`);
  const plan = generateSchema(app);
  const tables = seedStoreColumns(parseSeed(canonicalSeedJson(seed.tables)), columnRenamesOf(plan), seedCompositeMap(app, plan));
  const keys = foreignKeysForApp(app);
  const rowIds = new Map<string, Map<string, string>>();
  const stored = new Map<string, Row[]>();
  const ordered = orderTables(tables, keys);
  // Self/cyclic lookups cannot resolve in the insert pass (no side has a ROWID
  // yet); the data loader defers them to a row update, and so does this load.
  const deferred = cyclicForeignKeys(ordered.map((table) => table.table), keys);
  const acyclic = keys.filter((key) => !deferred.has(foreignKeyId(key)));
  for (const table of ordered) {
    const resolved = omitColumns(resolveForeignKeys(table, acyclic, rowIds), deferredColumns(table.table, deferred));
    const rows = resolved.rows.map((row) => ({ ...row.columns, c2c_source_id: row.id }));
    const written = rows.length ? await backend.insertRows(table.table, rows) : [];
    const ids = new Map<string, string>();
    written.forEach((row, i) => ids.set(resolved.rows[i]!.id, String(row.ROWID)));
    rowIds.set(table.table, ids);
    stored.set(table.table, written);
  }
  for (const key of keys) {
    if (!deferred.has(foreignKeyId(key))) continue;
    const table = tables.find((item) => item.table === key.table);
    if (!table) continue;
    const patches: Record<string, unknown>[] = [];
    for (const row of table.rows) {
      const source = row.columns[key.column];
      if (!source) continue;
      const mapped = sourceIds(source).map((id) => {
        const rowid = rowIds.get(key.parent)?.get(id);
        if (!rowid) throw new Error(`lookup ${key.column} row ${row.id} source id ${id} is not in ${key.parent}`);
        return rowid;
      });
      const rowid = rowIds.get(key.table)?.get(row.id);
      if (!rowid) continue;
      patches.push({ ROWID: rowid, [key.column]: source.startsWith('[') ? JSON.stringify(mapped) : mapped[0]! });
    }
    if (!patches.length) continue;
    if (!backend.updateRows) throw new Error('the backend cannot write deferred lookup rows');
    const updated = await backend.updateRows(key.table, patches);
    const byRowid = new Map(updated.map((row) => [String(row.ROWID), row]));
    stored.set(key.table, (stored.get(key.table) ?? []).map((row) => byRowid.get(String(row.ROWID)) ?? row));
  }
  return { stored };
}

// ---------- expectations from the seed ----------

/**
 * Seed rows re-keyed from store columns back to Creator field names, so the
 * seed-side readers see the names the served rows carry. A reserved-name
 * column (`Priority` stores as `Priority_col`) otherwise reads as blank.
 */
function fieldKeyedStored(stored: Map<string, Row[]>, renames: Record<string, Record<string, string>>): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const [table, rows] of stored) {
    const inverse = renames[table] ? new Map(Object.entries(renames[table]!).map(([field, column]) => [column, field])) : undefined;
    out.set(table, inverse?.size ? rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [inverse.get(key) ?? key, value]))) : rows);
  }
  return out;
}

const SEED_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The calendar-day key the chart fold groups a date or date-time value under (`2020-01-26T00:00:00` or `26-Jan-2020` -> `2020-01-26`). */
function seedDayKey(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T ])/.exec(text);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return undefined;
  }
  m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})(?:$|\s)/.exec(text);
  if (m) {
    const month = SEED_MONTHS.indexOf(m[2]!.toLowerCase()) + 1;
    const [y, d] = [Number(m[3]), Number(m[1])];
    if (month && d >= 1 && d <= 31) return `${y}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return undefined;
}

function numberOf(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(String(value).replace(/[^0-9.eE+-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * The served read refuses a criteria it cannot bind (zoho.loginuser has no
 * offline session value): the screen is the error state, counted, never
 * unfiltered rows. `refused` keeps that expectation distinct from "no table".
 */
const REFUSED = 'refused' as const;
type ExpectedRows = Row[] | typeof REFUSED | undefined;

const NEVER_ROWS: Criteria = { op: 'isNull', field: 'ID' };
const ALWAYS_ROWS: Criteria = { op: 'notNull', field: 'ID' };
/** Lookup-path leaf ops the served report resolves against the parent read; anything else narrows to no rows. */
const LOOKUP_POSITIVE_OPS = new Set(['==', '<', '>', '<=', '>=', 'contains', 'startsWith', 'endsWith', 'in', 'isNull', 'notNull']);

interface CriteriaOracle {
  app: App;
  seeded: SeededApp;
  /** Application zone the served read binds relative dates in; '' fails closed like the server. */
  zone: string;
  /** The offline session principal: the harness session email, no Creator login user. */
  userId: string;
  loginUser?: string;
  /** Reserved-word renames per table: criteria fields are Creator names, cells are store columns. */
  renames: Record<string, Record<string, string>>;
}

/** The store column a criteria field of `table` lands on (`To` → `To_col`; unmapped names stay). */
function storeField(oracle: CriteriaOracle, table: string, field: string): string {
  return oracle.renames[table]?.[field] ?? field;
}

function oracleFor(oracle: CriteriaOracle, form: string): { kinds: Record<string, 'date' | 'datetime'>; parents: Record<string, string> } {
  const parents: Record<string, string> = {};
  for (const field of oracle.app.forms.find((f) => f.name === form)?.fields ?? []) {
    if (field.lookup?.form) parents[field.name] = field.lookup.form;
  }
  return { kinds: dateFieldKinds(oracle.app, form), parents };
}

/**
 * The value a `{ __bind }` marker resolves to for the offline session, or
 * REFUSED when the principal cannot supply it — the same refusal authorizeRead
 * raises on the served read.
 */
function oracleBind(bind: unknown, oracle: CriteriaOracle): unknown {
  if (bind === 'loginUserId') return oracle.userId;
  if (bind === 'loginUser') return oracle.loginUser ?? REFUSED;
  // zoho.adminuser/adminuserid resolve against deploy configuration the offline
  // tree does not set; the dry-run sentinels are the served default.
  if (bind === 'adminUserId') return 'admin@example.test';
  if (bind === 'adminUser') return 'admin';
  return REFUSED;
}

/** First matching parent's field value for a `{ __rows }` dependent query; undefined when no row matches. */
function oracleRecordQuery(query: { form?: string; criteria?: Criteria; path?: string[] }, oracle: CriteriaOracle): unknown {
  const form = typeof query.form === 'string' ? query.form : '';
  const rows = oracle.seeded.stored.get(form);
  const inner = query.criteria && typeof query.criteria === 'object' ? query.criteria : undefined;
  const field = Array.isArray(query.path) && query.path.length === 1 ? query.path[0] : undefined;
  if (!rows || !inner || !field) return undefined;
  const bound = oracleCriteria(inner, oracle, form);
  if (bound === REFUSED) return undefined;
  try {
    const hit = rows.find((row) => matchRow(row, bound));
    return hit ? hit[field] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One leaf value of a criteria the served read resolves: `{ __bind }` to the
 * session principal, `{ __rows }` to the first matching parent's field under
 * the seeded rows. `{ __rel }` is bound later, after lookup resolution, the
 * same order the generated report applies.
 */
function oracleLeafValue(value: unknown, oracle: CriteriaOracle): unknown {
  if (Array.isArray(value)) {
    const out = value.map((item) => oracleLeafValue(item, oracle));
    return out.includes(REFUSED) ? REFUSED : out;
  }
  if (!value || typeof value !== 'object') return value;
  const marker = value as { __bind?: unknown; __rows?: unknown; __rel?: unknown };
  if (typeof marker.__bind === 'string') return oracleBind(marker.__bind, oracle);
  if (marker.__rows && typeof marker.__rows === 'object') {
    const resolved = oracleRecordQuery(marker.__rows as { form?: string; criteria?: Criteria; path?: string[] }, oracle);
    return resolved === undefined ? undefined : resolved;
  }
  return value;
}

/**
 * The criteria the served report query evaluates, resolved against the seeded
 * rows: lookup-path leaves become `ROWID IN` on the lookup cell, `{ __bind }`
 * and `{ __rows }` values resolve, `{ __rel }` binds at now in the app zone.
 * REFUSED mirrors the served refusal (a bind the session cannot satisfy); a
 * `{ __rel }` inside a lookup leaf is refused the same way — the served parent
 * read compiles it before relatives bind, which is a query error.
 */
function oracleCriteria(criteria: Criteria, oracle: CriteriaOracle, form: string): Criteria | typeof REFUSED {
  if (criteria.op === 'and' || criteria.op === 'or') {
    const args = criteria.args.map((arg) => oracleCriteria(arg, oracle, form));
    return args.includes(REFUSED) ? REFUSED : { op: criteria.op, args: args as Criteria[] };
  }
  if (criteria.op === 'not') {
    const arg = oracleCriteria(criteria.arg, oracle, form);
    return arg === REFUSED ? REFUSED : { op: 'not', arg };
  }
  if (criteria.op === 'todo' || criteria.op === 'true' || !('field' in criteria)) return criteria;
  // Bind marker values first; a refused bind refuses the read.
  const raw = 'value' in criteria ? criteria.value : undefined;
  const value = oracleLeafValue(raw, oracle);
  if (value === REFUSED) return REFUSED;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as { __rows?: unknown }).__rows) {
    if (value === undefined) return criteria.op === '!=' ? ALWAYS_ROWS : NEVER_ROWS;
  }
  const field = typeof criteria.field === 'string' ? criteria.field : '';
  const head = field.slice(0, field.indexOf('.'));
  const dot = field.indexOf('.');
  const store = dot <= 0 ? storeField(oracle, form, field) : storeField(oracle, form, head);
  if (dot <= 0 || dot === field.length - 1) {
    const renamed = field === store ? criteria : ({ ...criteria, field: store } as Criteria);
    return value === raw ? renamed : ({ ...renamed, value } as Criteria);
  }
  const { parents: lookupParents } = oracleFor(oracle, form);
  const parent = Object.hasOwn(lookupParents, head) ? lookupParents[head]! : '';
  if (!parent) return NEVER_ROWS;
  const rest = storeField(oracle, parent, field.slice(dot + 1));
  if (rest.includes('.')) return NEVER_ROWS;
  if (value && typeof value === 'object' && !Array.isArray(value) && (value as { __rel?: unknown }).__rel) return REFUSED;
  const parentRows = oracle.seeded.stored.get(parent) ?? [];
  const leaf = (op: string): Criteria => ({ op, field: rest, value } as Criteria);
  if (criteria.op === '!=') {
    const excluded = parentIds(parentRows, leaf('=='));
    if (excluded === undefined) return NEVER_ROWS;
    return excluded.length ? { op: 'not', arg: { op: 'in', field: store, value: excluded } } : ALWAYS_ROWS;
  }
  if (!LOOKUP_POSITIVE_OPS.has(criteria.op)) return NEVER_ROWS;
  const ids = parentIds(parentRows, leaf(criteria.op));
  if (ids === undefined) return NEVER_ROWS;
  return ids.length ? { op: 'in', field: store, value: ids } : NEVER_ROWS;
}

/** ROWIDs of the seeded parent rows a leaf matches; undefined when the leaf is not evaluable. */
function parentIds(rows: readonly Row[], leaf: Criteria): string[] | undefined {
  try {
    return rows.filter((row) => matchRow(row, leaf)).map((row) => String(row.ROWID));
  } catch {
    return undefined;
  }
}

/** The rows a report's served query returns for the seed, evaluated the way the generated endpoint does. */
function expectedReportRows(model: UiModel, app: App, seeded: SeededApp, reportName: string, form: string | undefined): ExpectedRows {
  const rows = form ? seeded.stored.get(form) : undefined;
  if (!rows) return undefined;
  const criteria = model.reports.find((r) => r.name === reportName)?.criteria as Criteria | undefined;
  if (!criteria) return rows;
  const oracle: CriteriaOracle = {
    app,
    seeded,
    zone: comparisonZone(process.env.C2C_APP_TIMEZONE?.trim() || appTimeZone(app)) ?? '',
    userId: 'admin@example.test',
    renames: columnRenamesOf(generateSchema(app)),
  };
  const resolved = oracleCriteria(criteria, oracle, form!);
  if (resolved === REFUSED) return REFUSED;
  let bound = resolved;
  if (criteriaHasRelative(resolved)) {
    try {
      bound = bindRelativeCriteria(resolved, new Date(), oracle.zone, oracleFor(oracle, form!).kinds);
    } catch {
      // The served read fails closed (zero rows, "filter not migrated") when the zone is missing.
      return [];
    }
  }
  try {
    return rows.filter((row) => matchRow(row, bound));
  } catch {
    // A todo criteria fails closed on the served read: zero rows and a notice, never unfiltered.
    return [];
  }
}

/** Reads a cell by field name or by a dotted lookup path (`Lookup.Field`). */
export type CellReader = (row: Row, path: string) => unknown;
const directCell: CellReader = (row, path) => row[path];

/** A reader that follows `Lookup.Field` paths through the seeded parent rows. */
function lookupReader(spec: AppSpec, seeded: SeededApp, form: string | undefined): CellReader {
  return (row, path) => {
    const dot = path.indexOf('.');
    if (dot < 0) return row[path];
    const field = spec.forms[form ?? '']?.fields.find((f) => f.name === path.slice(0, dot));
    const parentForm = field?.lookup?.form;
    const id = row[path.slice(0, dot)];
    const parent = parentForm && id != null ? seeded.stored.get(parentForm)?.find((p) => String(p.ROWID) === String(id)) : undefined;
    return parent ? lookupReader(spec, seeded, parentForm)(parent, path.slice(dot + 1)) : undefined;
  };
}

function clauseMatches(row: Row, clause: FilterClause, get: CellReader = directCell): boolean | undefined {
  if ('of' in clause) {
    const results = clause.of.map((c) => clauseMatches(row, c, get));
    if (results.some((r) => r === undefined)) return undefined;
    return clause.op === 'all' ? results.every(Boolean) : results.some(Boolean);
  }
  const cell = get(row, clause.field);
  if (clause.op === 'empty') return cell == null || cell === '';
  if (clause.op === 'filled') return !(cell == null || cell === '');
  if (!('value' in clause)) return undefined;
  if (clause.op === 'eq') return String(cell ?? '') === String(clause.value);
  if (clause.op === 'ne') return String(cell ?? '') !== String(clause.value);
  const a = numberOf(cell);
  const b = Number(clause.value);
  if (a === undefined) return false;
  return clause.op === 'lt' ? a < b : clause.op === 'le' ? a <= b : clause.op === 'gt' ? a > b : a >= b;
}

/** The seed-side value of a dashboard metric; undefined when a clause is not evaluable here. */
export function expectedMetric(rows: readonly Row[], metric: Pick<MetricSpec, 'fn' | 'field' | 'filter'>, get: CellReader = directCell): number | undefined {
  let sum = 0;
  let count = 0;
  for (const row of rows) {
    const hits = metric.filter.map((clause) => clauseMatches(row, clause, get));
    if (hits.some((hit) => hit === undefined)) return undefined;
    if (!hits.every(Boolean)) continue;
    count += 1;
    sum += numberOf(get(row, metric.field)) ?? 0;
  }
  return metric.fn === 'count' ? count : round(sum);
}

/** Seed-side chart buckets: category label -> first measure value. */
export function expectedBuckets(rows: readonly Row[], chart: Pick<ChartSpec, 'x' | 'measures' | 'filter'>, get: CellReader = directCell): Record<string, number> | undefined {
  const measure = chart.measures[0];
  if (!measure || measure.fn === 'value') return undefined;
  const out: Record<string, number> = {};
  for (const row of rows) {
    const hits = chart.filter.map((clause) => clauseMatches(row, clause, get));
    if (hits.some((hit) => hit === undefined)) return undefined;
    if (!hits.every(Boolean)) continue;
    const x = get(row, chart.x);
    // The chart fold buckets date and date-time values by calendar day.
    const key = x == null || x === '' ? '(blank)' : (seedDayKey(x) ?? String(x).trim());
    out[key] = round((out[key] ?? 0) + (measure.fn === 'count' ? 1 : numberOf(get(row, measure.field)) ?? 0));
  }
  return out;
}

// ---------- reading a rendered screen ----------

/** The visible table of a rendered report: header labels and row cells (cells carry their column label in data-th). */
export function readTable(root: Element, columns: readonly { key: string; label: string }[]): { header: string[]; rows: string[][] } {
  const body = [...root.querySelectorAll('tbody tr')].filter((tr) => tr.querySelector('td[data-th]'));
  const pick = (tr: Element, label: string) => [...tr.querySelectorAll('td[data-th]')].find((td) => td.getAttribute('data-th') === label);
  return {
    header: columns.map((c) => c.label),
    rows: body.map((tr) => columns.map((c) => (pick(tr, c.label)?.textContent ?? '').trim())),
  };
}

/** Rendered charts, in page order. */
export function chartRoots(root: Element): Element[] {
  return [...root.querySelectorAll('.c2c-chart')];
}

/** Values one rendered chart draws: category label -> first measure, read from the chart's accessible data table. */
export function readChart(chart: Element): Record<string, number> {
  const out: Record<string, number> = {};
  const table = chart.querySelector('table');
  for (const tr of table ? table.querySelectorAll('tbody tr') : []) {
    const label = (tr.querySelector('th')?.textContent ?? '').trim();
    const value = (tr.querySelector('td')?.textContent ?? '').replace(/[^0-9.eE+-]/g, '');
    if (label && value !== '') out[label] = Number(value);
  }
  return out;
}

/** Export and print affordances a rendered report screen offers. */
export function findAffordances(root: Element): { exports: Partial<Record<ExportFormat, Element>>; print?: Element } {
  const exports: Partial<Record<ExportFormat, Element>> = {};
  for (const el of root.querySelectorAll('[data-export], a[download], button, a')) {
    const tag = (el.getAttribute('data-export') ?? '').toLowerCase();
    const text = `${tag} ${el.getAttribute('download') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`.toLowerCase();
    if (!(tag || el.hasAttribute('download') || /\bexport\b|\bdownload\b/.test(text))) continue;
    if (/\bcsv\b/.test(text)) exports.csv ??= el;
    if (/\bxlsx\b|\bexcel\b/.test(text)) exports.xlsx ??= el;
    if (/\bpdf\b/.test(text)) exports.pdf ??= el;
  }
  const print = [...root.querySelectorAll('[data-print], button, a')].find((el) => el.hasAttribute('data-print') || /^\s*print\b/i.test(el.textContent ?? '') || /\bprint\b/i.test(el.getAttribute('aria-label') ?? ''));
  return { exports, ...(print ? { print } : {}) };
}

/** Click an export control and capture the file it hands the browser (object URL or data: link). */
export async function captureDownload(screen: MountedScreen, control: Element): Promise<Buffer | undefined> {
  const view = screen.window as unknown as { URL: { createObjectURL?: (blob: Blob) => string }; MouseEvent: new (type: string, init: { bubbles: boolean }) => Event };
  let blob: Blob | undefined;
  const original = view.URL.createObjectURL;
  view.URL.createObjectURL = (b: Blob) => {
    blob = b;
    return 'blob:c2c-report-check';
  };
  const anchors: string[] = [];
  const proto = (screen.window as unknown as { HTMLAnchorElement: { prototype: { click(): void } } }).HTMLAnchorElement.prototype;
  const click = proto.click;
  proto.click = function (this: { href: string }) {
    anchors.push(this.href);
  };
  try {
    control.dispatchEvent(new view.MouseEvent('click', { bubbles: true }));
    await screen.flush(5);
  } finally {
    view.URL.createObjectURL = original;
    proto.click = click;
  }
  if (blob) {
    const held = blob;
    if (typeof held.arrayBuffer === 'function') return Buffer.from(await held.arrayBuffer());
    // jsdom's Blob has no arrayBuffer(); its FileReader reads the same bytes.
    const Reader = (screen.window as unknown as { FileReader: new () => { result: unknown; onload: (() => void) | null; onerror: (() => void) | null; readAsArrayBuffer(b: Blob): void } }).FileReader;
    return new Promise<Buffer>((resolve, reject) => {
      const reader = new Reader();
      reader.onload = () => resolve(Buffer.from(reader.result as ArrayBuffer));
      reader.onerror = () => reject(new Error('the export file could not be read'));
      reader.readAsArrayBuffer(held);
    });
  }
  const href = control.getAttribute('href') ?? anchors[0];
  const data = href && /^data:[^,]*?(;base64)?,(.*)$/s.exec(href);
  if (data) return data[1] ? Buffer.from(data[2]!, 'base64') : Buffer.from(decodeURIComponent(data[2]!), 'utf8');
  return undefined;
}

// ---------- the runner ----------

const CREATOR_EXPORT = 'Creator offers Export > CSV, Excel (XLSX) and PDF and a Print view on every report';

function gap(check: CheckName, detail: string): ScreenCheck {
  return { check, status: 'gap', detail };
}

async function exportChecks(screen: MountedScreen, table: { header: string[]; rows: string[][] }, keyColumn: number): Promise<ScreenCheck[]> {
  const { exports, print } = findAffordances(screen.container);
  const out: ScreenCheck[] = [];
  for (const format of EXPORT_FORMATS) {
    const control = exports[format];
    if (!control) {
      out.push(gap(format, `the generated report screen offers no ${format.toUpperCase()} export (${CREATOR_EXPORT})`));
      continue;
    }
    const file = await captureDownload(screen, control);
    if (!file) {
      out.push({ check: format, status: 'fail', detail: `the ${format.toUpperCase()} export control produced no file` });
      continue;
    }
    if (format === 'csv') out.push(verifyCsvExport(file.toString('utf8'), table.header, table.rows));
    else if (format === 'xlsx') out.push(verifyXlsxExport(file, table.rows.length));
    else out.push(verifyPdfExport(file, table.rows.map((row) => row[keyColumn] ?? '')));
  }
  if (!print) out.push(gap('print', `the generated report screen offers no print view (${CREATOR_EXPORT})`));
  else {
    print.dispatchEvent(new (screen.window as unknown as { MouseEvent: new (type: string, init: { bubbles: boolean }) => Event }).MouseEvent('click', { bubbles: true }));
    await screen.flush(5);
    const sheet = screen.window.document.querySelector('[data-print-sheet], .c2c-print, [data-print-view]');
    out.push(sheet ? { check: 'print', status: 'pass', detail: 'the print action opens a print view' } : { check: 'print', status: 'fail', detail: 'the print action opened no print view' });
  }
  return out;
}

function errorState(root: Element): string | undefined {
  const el = root.querySelector('[data-state="error"], [data-screen-error], [role="alert"]');
  return el ? (el.textContent ?? '').trim().slice(0, 200) || 'error state' : undefined;
}

/**
 * A screen's data arrives over a real endpoint round trip, which can land a few
 * event-loop turns after the mount flush — a slow loop (loaded CI, an older
 * Node's fetch) is not a zero-row read. Flush until every `data-state="loading"`
 * marker clears, bounded: a screen that never settles returns its marker text so
 * the caller fails with the reason instead of counting 0 rows.
 */
const LOADING_FLUSH_LIMIT = 50;

async function settleLoading(screen: MountedScreen): Promise<string | undefined> {
  const pending = () => screen.container.querySelector('[data-state="loading"]')?.textContent?.trim();
  for (let i = 0; i < LOADING_FLUSH_LIMIT && pending() !== undefined; i++) await screen.flush(1);
  return pending();
}

async function listChecks(model: UiModel, spec: AppSpec, report: ReportSpec, seeded: SeededApp, app: App, mount: (s: TemplateScreen) => Promise<MountedScreen>): Promise<ScreenCheck[]> {
  const checks: ScreenCheck[] = [];
  const expected = expectedReportRows(model, app, seeded, report.name, report.form);
  const screen = await mount({ kind: 'report', report: report.name });
  try {
    const pending = await settleLoading(screen);
    const error = errorState(screen.container);
    const columns = report.columns.filter((c) => !c.action).map((c) => ({ key: c.field, label: c.label, numeric: !!c.numeric }));
    const table = readTable(screen.container, columns);
    if (pending !== undefined) checks.push({ check: 'rows', status: 'fail', detail: `the report screen never left its loading state: ${pending.slice(0, 200) || 'loading'}` });
    else if (expected === REFUSED) {
      checks.push(
        error
          ? gap('rows', 'the served read refuses this criteria (a bind the offline session cannot satisfy); the refusal is counted, never unfiltered')
          : table.rows.length
            ? { check: 'rows', status: 'fail', detail: 'the report renders rows for a criteria the served read refuses' }
            : gap('rows', 'the served read refuses this criteria (a bind the offline session cannot satisfy); the screen shows no error or rows'),
      );
    } else if (error) checks.push({ check: 'rows', status: 'fail', detail: `the report screen shows an error: ${error}` });
    else if (!expected) checks.push({ check: 'rows', status: 'fail', detail: `no seeded table for form ${report.form ?? '(none)'}` });
    else {
      const shown = Math.min(expected.length, report.pageSize || expected.length);
      // An empty seed selection rendering an empty state compares nothing:
      // an honest gap, never a pass and never a fail.
      const compared = expected.length > 0 || table.rows.length > 0;
      checks.push(
        !compared
          ? gap('rows', 'no seeded rows to compare (the report criteria select 0 of the seeded rows)')
          : table.rows.length === shown && shown > 0
            ? { check: 'rows', status: 'pass', detail: `${table.rows.length} rows render (seed: ${expected.length})` }
            : { check: 'rows', status: 'fail', detail: 'rendered row count differs from the seed', expected: shown, actual: table.rows.length },
      );
      const numeric = columns.map((c, i) => ({ ...c, i })).filter((c) => c.numeric && !c.key.includes('.'));
      if (!numeric.length) checks.push(gap('totals', 'the report has no numeric column to total'));
      for (const col of numeric) {
        const want = round(expected.slice(0, shown).reduce((sum, row) => sum + (numberOf(row[col.key]) ?? 0), 0));
        const got = round(table.rows.reduce((sum, row) => sum + (numberOf(row[col.i]) ?? 0), 0));
        checks.push(!compared ? gap('totals', 'no seeded rows to compare') : want === got ? { check: 'totals', status: 'pass', detail: `${col.label} total ${got} matches the seed` } : { check: 'totals', status: 'fail', detail: `${col.label} total differs from the seed`, expected: want, actual: got });
      }
      const form = spec.forms[report.form ?? ''];
      const textCols = columns.map((c, i) => ({ ...c, i })).filter((c) => !c.numeric && form?.fields.some((f) => f.name === c.key && (f.widget === 'text' || f.widget === 'email')));
      for (const col of textCols.slice(0, 1)) {
        const want = expected.slice(0, shown).map((row) => String(row[col.key] ?? '')).sort();
        const got = table.rows.map((row) => row[col.i]!).sort();
        checks.push(!compared ? gap('cells', 'no seeded rows to compare') : JSON.stringify(want) === JSON.stringify(got) ? { check: 'cells', status: 'pass', detail: `${col.label} cells match the seed` } : { check: 'cells', status: 'fail', detail: `${col.label} cells differ from the seed`, expected: want, actual: got });
      }
    }
    const keyColumn = Math.max(0, columns.findIndex((c) => !c.numeric));
    checks.push(...(await exportChecks(screen, table, keyColumn)));
  } finally {
    await screen.unmount();
  }
  if (report.detail && Array.isArray(expected) && expected.length) {
    const row = expected[0]!;
    const detail = await mount({ kind: 'report', report: report.name, row: String(row.ROWID) });
    try {
      await settleLoading(detail);
      const error = errorState(detail.container);
      const text = detail.container.textContent ?? '';
      const form = spec.forms[report.form ?? ''];
      const values = (form?.fields ?? []).filter((f) => f.widget === 'text' && row[f.name]).map((f) => String(row[f.name]));
      const missing = values.filter((v) => !text.includes(v));
      checks.push(
        error
          ? { check: 'detail', status: 'fail', detail: `the record view shows an error: ${error}` }
          : missing.length
            ? { check: 'detail', status: 'fail', detail: 'the record view misses seeded values', expected: values, actual: missing }
            : { check: 'detail', status: 'pass', detail: `the record view shows row ${String(row.ROWID)} (${values.length} text values)` },
      );
    } finally {
      await detail.unmount();
    }
  }
  return checks;
}

function chartCheck(model: UiModel, spec: AppSpec, report: ReportSpec, chart: ChartSpec | undefined, seeded: SeededApp, app: App, root: Element | undefined): ScreenCheck {
  if (!chart) return { check: 'chart', status: 'fail', detail: 'the chart settings of this report are not generated' };
  if (!root) return { check: 'chart', status: 'fail', detail: `chart ${chart.title} did not render` };
  const error = errorState(root);
  const rows = expectedReportRows(model, app, seeded, report.name, report.form);
  if (rows === REFUSED) return error ? gap('chart', 'the served read refuses this criteria (a bind the offline session cannot satisfy)') : { check: 'chart', status: 'fail', detail: `${chart.title}: renders for a criteria the served read refuses` };
  if (error) return { check: 'chart', status: 'fail', detail: `the chart shows an error: ${error}` };
  const want = expectedBuckets(rows ?? [], chart, lookupReader(spec, seeded, report.form));
  if (!want) return gap('chart', 'the chart filter or measure is not evaluable from the seed');
  const got = readChart(root);
  if (!Object.keys(want).length && !Object.keys(got).length) return gap('chart', `${chart.title}: no seeded rows to compare`);
  const same = JSON.stringify(Object.entries(want).sort()) === JSON.stringify(Object.entries(got).sort());
  return same ? { check: 'chart', status: 'pass', detail: `${chart.title}: ${Object.keys(got).length} chart buckets match the seed` } : { check: 'chart', status: 'fail', detail: `${chart.title}: chart buckets differ from the seed${Object.keys(got).length ? '' : ` (the chart shows: ${(root.textContent ?? '').replace(/\s+/g, ' ').trim().slice(-80)})`}`, expected: want, actual: got };
}

function* walk(elements: readonly PageElement[]): Generator<PageElement> {
  for (const el of elements) {
    yield el;
    if (el.kind === 'box') yield* walk(el.children);
  }
}

async function pageChecks(model: UiModel, spec: AppSpec, name: string, seeded: SeededApp, app: App, mount: (s: TemplateScreen) => Promise<MountedScreen>): Promise<ScreenCheck[]> {
  const page = spec.pages![name]!;
  const screen = await mount({ kind: 'page', page: name });
  const checks: ScreenCheck[] = [];
  try {
    const pending = await settleLoading(screen);
    if (pending !== undefined) checks.push({ check: 'view', status: 'fail', detail: `the page never left its loading state: ${pending.slice(0, 200) || 'loading'}` });
    const els = [...walk(page.elements)];
    const metrics = els.filter((el): el is Extract<PageElement, { kind: 'metric' }> => el.kind === 'metric');
    const tiles = [...screen.container.querySelectorAll('[data-metric]')];
    metrics.forEach((metric, i) => {
      const report = metric.value.report ? spec.reports[metric.value.report] : undefined;
      const rows = report ? expectedReportRows(model, app, seeded, report.name, report.form) : undefined;
      const want = rows && rows !== REFUSED ? expectedMetric(rows, metric.value, lookupReader(spec, seeded, report?.form)) : undefined;
      const got = tiles[i]?.getAttribute('data-value');
      if (want === undefined) checks.push(gap('metric', `${metric.label}: the metric's report or filter is not evaluable from the seed`));
      else checks.push(got !== undefined && got !== '' && Number(got) === want ? { check: 'metric', status: 'pass', detail: `${metric.label} = ${want} matches the seed` } : { check: 'metric', status: 'fail', detail: `${metric.label} differs from the seed`, expected: want, actual: got ?? '<not rendered>' });
    });
    const charts = chartRoots(screen.container);
    let chartAt = 0;
    for (const el of els) {
      if (el.kind === 'report') {
        const report = spec.reports[el.report];
        const rows = report ? expectedReportRows(model, app, seeded, report.name, report.form) : undefined;
        const host = screen.container.querySelector(`[data-report="${el.report}"]`) ?? screen.container;
        const shown = host.querySelectorAll('tbody tr td[data-th]').length ? [...host.querySelectorAll('tbody tr')].filter((tr) => tr.querySelector('td[data-th]')).length : 0;
        const want = rows && rows !== REFUSED ? Math.min(rows.length, report?.pageSize || rows.length) : undefined;
        checks.push(
          want === 0 && shown === 0
            ? gap('rows', `embedded ${el.report}: no seeded rows to compare`)
            : want !== undefined && shown === want
              ? { check: 'rows', status: 'pass', detail: `embedded ${el.report}: ${shown} rows render` }
              : { check: 'rows', status: 'fail', detail: `embedded ${el.report}: rendered row count differs from the seed`, expected: want, actual: shown },
        );
      }
      if (el.kind === 'chart') {
        const report = el.chart.report ? spec.reports[el.chart.report] : undefined;
        const root = charts[chartAt++];
        if (report) checks.push(chartCheck(model, spec, report, el.chart, seeded, app, root));
        else checks.push({ check: 'chart', status: 'fail', detail: `chart ${el.chart.title} has no report to read` });
      }
      if (el.kind === 'todo') checks.push(gap('view', `page element <${el.tag}> is not generated: ${el.reason}`));
    }
    if (!checks.length) checks.push(gap('view', 'the page has no data element to check'));
  } finally {
    await screen.unmount();
  }
  return checks;
}

export interface RunReportOptions {
  /** Seed rows per form (default 6). */
  n?: number;
  /** Wrap the screens' api (tests: inject a broken endpoint reply). */
  wrapApi?: (api: TemplateApi) => TemplateApi;
  /** Override the fake SDK path (tests: inject a store whose insert fails). */
  fakeSdk?: string;
}

/** Run every report, chart and page check of one app offline. */
export async function runReportChecks(app: App, source: string, opts: RunReportOptions = {}): Promise<AppReportResult> {
  const name = app.name || 'app';
  if (!templateRuntimeReady()) throw new Error(TEMPLATE_MISSING);
  const model = generateUi(app).model;
  const spec = reactAppSpec(app, model);
  const out = mkdtempSync(join(tmpdir(), 'c2c-report-check-'));
  const backend = await startOfflineBackend(app, opts.fakeSdk ? { fakeSdk: opts.fakeSdk } : {});
  const result: AppReportResult = { app: name, source, seedRows: {}, screens: [] };
  try {
    compileTemplateLib(out);
    let seeded: SeededApp;
    try {
      await backend.reset?.();
      const raw = await loadSeed(app, backend, opts.n ?? 6);
      seeded = { stored: fieldKeyedStored(raw.stored, columnRenamesOf(generateSchema(app))) };
    } catch (err) {
      result.error = `seed load failed: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }
    for (const [table, rows] of [...seeded.stored].sort(([a], [b]) => (a < b ? -1 : 1))) result.seedRows[table] = rows.length;
    const api: TemplateApi = {
      async post(endpoint, body) {
        const res = await backend.call('POST', endpoint, body);
        return { ok: res.status >= 200 && res.status < 300, status: res.status, body: res.body };
      },
    };
    const served = opts.wrapApi ? opts.wrapApi(api) : api;
    const mount = (screen: TemplateScreen) => mountTemplateScreen(out, spec, screen, served);
    for (const report of Object.values(spec.reports)) {
      const ui = model.reports.find((r) => r.name === report.name);
      if (report.view === 'chart') {
        const screen = await mount({ kind: 'chart', report: report.name });
        const pending = await settleLoading(screen);
        try {
          const checks = pending !== undefined
            ? [{ check: 'chart' as const, status: 'fail' as const, detail: `the chart screen never left its loading state: ${pending.slice(0, 200) || 'loading'}` }]
            : [chartCheck(model, spec, report, report.chart, seeded, app, chartRoots(screen.container)[0])];
          checks.push(...EXPORT_FORMATS.map((f) => gap(f, `the generated chart screen offers no ${f.toUpperCase()} export (${CREATOR_EXPORT})`)), gap('print', `the generated chart screen offers no print view (${CREATOR_EXPORT})`));
          result.screens.push({ screen: report.name, kind: 'chart', checks });
        } finally {
          await screen.unmount();
        }
        continue;
      }
      if (report.view !== 'list') {
        const screen = await mount({ kind: 'report', report: report.name });
        const stub = screen.container.querySelector('[data-view-stub]');
        await screen.unmount();
        result.screens.push({
          screen: report.name,
          kind: report.view,
          checks: [stub ? gap('view', `the ${report.view} view renders as a pending stub, not the Creator ${report.view} layout`) : { check: 'view', status: 'fail', detail: `the ${report.view} view has no reader in this runner; add one before counting it` }],
        });
        continue;
      }
      const checks = await listChecks(model, spec, report, seeded, app, mount);
      const pivot = ui?.type === 'pivottable';
      if (pivot) checks.unshift(gap('view', ui?.note ?? 'the pivot table renders as a list'));
      result.screens.push({ screen: report.name, kind: pivot ? 'pivot' : 'list', checks });
    }
    for (const page of Object.keys(spec.pages ?? {}).sort()) result.screens.push({ screen: page, kind: 'dashboard', checks: await pageChecks(model, spec, page, seeded, app, mount) });
    return result;
  } finally {
    await backend.close();
    rmSync(out, { recursive: true, force: true });
  }
}

export function summarize(apps: AppReportResult[]): ReportCheckReport {
  const totals: Record<CheckStatus, number> = { pass: 0, fail: 0, gap: 0 };
  const byCheck: Record<string, Record<CheckStatus, number>> = {};
  for (const app of apps) {
    if (app.error) totals.fail += 1;
    for (const screen of app.screens)
      for (const check of screen.checks) {
        totals[check.status] += 1;
        (byCheck[check.check] ??= { pass: 0, fail: 0, gap: 0 })[check.status] += 1;
      }
  }
  const sorted = Object.fromEntries(Object.entries(byCheck).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { version: REPORT_CHECK_VERSION, mode: 'offline', apps, totals, byCheck: sorted };
}

export function formatReportCheckJson(report: ReportCheckReport): string {
  return JSON.stringify(report, null, 2) + '\n';
}

const cell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function formatReportCheckMarkdown(report: ReportCheckReport): string {
  const lines = ['# Report check (offline)', '', `Checks: ${report.totals.pass} pass, ${report.totals.fail} fail, ${report.totals.gap} gap.`, '', '| check | pass | fail | gap |', '| --- | --- | --- | --- |'];
  for (const [name, t] of Object.entries(report.byCheck)) lines.push(`| ${name} | ${t.pass} | ${t.fail} | ${t.gap} |`);
  for (const app of report.apps) {
    lines.push('', `## ${app.app}`, '', `Seed rows: ${Object.entries(app.seedRows).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}.`);
    if (app.error) lines.push('', `FAIL: ${app.error}`);
    lines.push('', '| screen | kind | check | status | detail |', '| --- | --- | --- | --- | --- |');
    for (const screen of app.screens)
      for (const check of screen.checks) {
        const extra = check.status === 'fail' && check.expected !== undefined ? ` (expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)})` : '';
        lines.push(`| ${screen.screen} | ${screen.kind} | ${check.check} | ${check.status} | ${cell(check.detail + extra)} |`);
      }
  }
  return lines.join('\n') + '\n';
}

/** `node dist/deploy/src/verify-reports.js <app.ds>... [--n N] [--report out.json] [--report-md out.md]`; exit 1 on any fail. */
export async function verifyReportsMain(argv: readonly string[], io: { stdout(text: string): void; stderr(text: string): void }): Promise<number> {
  const files: string[] = [];
  let json: string | undefined;
  let md: string | undefined;
  let n: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--report') json = argv[++i];
    else if (arg === '--report-md') md = argv[++i];
    else if (arg === '--n') n = Number(argv[++i]);
    else if (arg.startsWith('--')) {
      io.stderr(`unknown flag ${arg}\n`);
      return 2;
    } else files.push(arg);
  }
  if (!files.length || (n !== undefined && !(Number.isInteger(n) && n > 0))) {
    io.stderr('usage: verify-reports <app.ds>... [--n N] [--report out.json] [--report-md out.md]\n');
    return 2;
  }
  const apps: AppReportResult[] = [];
  for (const file of files) {
    const app = deriveIr(parse(readFileSync(file, 'utf8')));
    apps.push(await runReportChecks(app, file, n === undefined ? {} : { n }));
  }
  const report = summarize(apps);
  if (json) writeFileSync(json, formatReportCheckJson(report));
  if (md) writeFileSync(md, formatReportCheckMarkdown(report));
  io.stdout(`report checks: ${report.totals.pass} pass, ${report.totals.fail} fail, ${report.totals.gap} gap\n`);
  return report.totals.fail > 0 ? 1 : 0;
}

if (process.argv[1] && /verify-reports\.js$/.test(process.argv[1])) {
  verifyReportsMain(process.argv.slice(2), { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`verify-reports: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
