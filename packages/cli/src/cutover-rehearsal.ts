/**
 * Offline cut-over rehearsal: runs the D10 sequence (initial load, parallel
 * run, freeze, final delta, verify, switch, rollback) for one app against an
 * in-memory Data Store and reports each cut-over criterion as PASS, FAIL or
 * GAP. GAP means c2c does not do that part yet; it is never counted as a pass.
 *
 * The Creator side is a synthetic report export built from the same rows
 * `c2c seed --creator-import` writes, with record ids added and lookups
 * written as the parent's record id, the way a Creator CSV export carries
 * them. Every step goes through the code the commands run: computeDelta and
 * applyDelta (sync-delta), proofReport and cutoverChecklist
 * (cutover-checklist / proof), readStoreRows and rollbackExport
 * (rollback-export), verifyRollbackEvidence (cutover-checklist
 * --rollback-export). Nothing leaves the process; the same app gives the same
 * report.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { App } from '../../core/src/index.js';
import { generateSeedRecords, type SeedRecordGrid } from '../../data/src/seed-import.js';
import type { FetchLike, MigrateResponse } from '../../data/src/migrate.js';
import {
  applyDelta,
  computeDelta,
  parseCsv,
  readSourceCsv,
  readStoreRows,
  rollbackExport,
  withDeletionsApplied,
  type CsvLoad,
  type DeltaCheckpoint,
} from '../../deploy/src/index.js';
import { formatConflict, withStoreFingerprints, type ConflictResolver, type DeltaPlan } from '../../deploy/src/row-delta.js';
import { SOURCE_ID_COLUMN } from '../../schema/src/mapping.js';
import { generateSchema } from '../../schema/src/index.js';
import type { SchemaColumn, SchemaTable } from '../../schema/src/generator.js';
import { cutoverChecklist, proofReport, verifyRollbackEvidence, type CutoverInput } from './cutover.js';

export type D10Status = 'PASS' | 'FAIL' | 'GAP';

export interface D10Criterion {
  id: string;
  criterion: string;
  status: D10Status;
  /** What was measured, one line each. */
  evidence: string[];
  /** FAIL: what went wrong. GAP: what c2c does not do. */
  reason?: string;
  /** FAIL and GAP: the generator-level change that would close it. */
  fix?: string;
}

export interface D10Report {
  schema: 'c2c-d10-rehearsal/1';
  app: string;
  /** Forms with rows in the synthetic export; the rest were not exercised. */
  exercised: string[];
  notExercised: { form: string; reason: string }[];
  /** Mandatory fields the synthetic export could not fill; a refusal they cause is the harness's, not c2c's. */
  harnessLimits: HarnessLimit[];
  criteria: D10Criterion[];
  totals: Record<D10Status, number>;
  /** PASS only when every criterion passes. */
  status: 'PASS' | 'FAIL';
}

/** One form of a synthetic Creator report export. */
export interface ExportForm {
  /** Form link name, or `<Form>__<Subform>` for an inline subform's rows. */
  form: string;
  /** Set on an inline subform's rows. */
  subform?: { form: string; field: string };
  header: string[];
  rows: string[][];
}

export type CreatorExport = ExportForm[];

export type StoreTables = Map<string, Record<string, unknown>[]>;

/** Points where a test breaks one step to prove its criterion fails. */
export interface RehearsalHooks {
  /** Creator export taken after the freeze; mutate to model a write that slipped past it. */
  afterFreeze?(exported: CreatorExport): void;
  /** Store after the final delta, before verification. */
  afterFinalDelta?(store: StoreTables): void;
  /** Checklist text before the documented-sequence check. */
  checklist?(text: string): string;
  /** Rollback files before the no-data-loss check. */
  rollbackFiles?(files: Map<string, string>): void;
  /** Wraps the in-memory store's REST endpoint (for example to drop a write). */
  fetch?(inner: FetchLike): FetchLike;
  /** Resolver for the first both-sides sync, which must refuse (none by default). */
  conflictResolver?: ConflictResolver;
}

export interface RehearsalOptions {
  /** Rows per form in the synthetic export (default 30, so one delete stays under the 5% mass-delete cap). */
  rows?: number;
  /** Folder for the export rounds and the rollback export; must be outside the app's folder. */
  workDir: string;
  /** The app's .ds path or folder (the workspace the rollback export must sit outside of). */
  target: string;
  hooks?: RehearsalHooks;
}

const SCOPE = { org: '1', projectId: '1', token: 'offline' };
const STORE = { dc: 'in', catalystBase: 'https://api.catalyst.zoho.in', scope: SCOPE };
const FIRST_RECORD_ID = 4000000000000001n;
const NEW_TEXT = 'c2c rehearsal';

function response(body: unknown, status = 200): MigrateResponse {
  const text = JSON.stringify(body);
  return { status, headers: { get: () => null }, text: async () => text };
}

function failure(status: number, code: string, message: string): MigrateResponse {
  return response({ status: 'failure', data: { error_code: code, message } }, status);
}

/**
 * In-memory Data Store over the admin REST shapes sync-delta and
 * rollback-export use: row POST/PUT/DELETE and the ZCQL subset they send.
 */
export function memoryStore(): { fetch: FetchLike; tables: StoreTables } {
  const tables: StoreTables = new Map();
  let next = 10000000000000001n;
  const rowsOf = (table: string) => {
    const list = tables.get(table) ?? [];
    tables.set(table, list);
    return list;
  };
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    if (method === 'POST' && path.endsWith('/query')) {
      const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
      const table = /FROM\s+(\w+)/i.exec(sql)?.[1];
      if (!table) return failure(400, 'INVALID_QUERY', 'no table');
      let rows = rowsOf(table);
      const inList = /IN \((.*)\)/.exec(sql);
      if (inList) {
        const ids = new Set([...inList[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]));
        rows = rows.filter((row) => ids.has(String(row[SOURCE_ID_COLUMN])));
      }
      // ROWIDs are equal-length digit strings, so string order is numeric order.
      if (/ORDER BY\s+ROWID/i.test(sql)) rows = [...rows].sort((a, b) => (String(a.ROWID) < String(b.ROWID) ? -1 : 1));
      const limit = /LIMIT (\d+), (\d+)/.exec(sql);
      if (limit) {
        const from = Math.max(1, Number(limit[1])) - 1;
        rows = rows.slice(from, from + Number(limit[2]));
      }
      return response({ status: 'success', data: rows.map((row) => ({ [table]: row })) });
    }
    const match = /\/table\/(\w+)\/row(?:\/(\d+))?$/.exec(path);
    if (!match) return failure(404, 'INVALID_URL_PATTERN', 'Please check if the URL trying to access is a correct one');
    const list = rowsOf(match[1]!);
    if (method === 'DELETE') {
      const index = list.findIndex((row) => row.ROWID === match[2]);
      if (index < 0) return failure(404, 'NO_SUCH_ROW', 'No such row');
      list.splice(index, 1);
      return response({ status: 'success', data: {} });
    }
    const body = JSON.parse(init?.body ?? 'null') as Record<string, unknown>[];
    if (method === 'POST') {
      const stored = body.map((row) => ({ ...row, ROWID: String(next++) }));
      list.push(...stored);
      return response({ status: 'success', data: stored });
    }
    if (method === 'PUT') {
      const out: Record<string, unknown>[] = [];
      for (const row of body) {
        const found = list.find((item) => item.ROWID === row.ROWID);
        if (!found) return failure(404, 'NO_SUCH_ROW', 'No such row');
        Object.assign(found, row);
        out.push(found);
      }
      return response({ status: 'success', data: out });
    }
    return failure(400, 'INVALID_INPUT', `unexpected method ${method}`);
  };
  return { fetch, tables };
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvText(form: ExportForm): string {
  return [form.header, ...form.rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

/** A mandatory field the synthetic export leaves empty: the rehearsal cannot exercise it. */
export interface HarnessLimit {
  form: string;
  /** Subform link name when the field sits in an inline subform. */
  subform?: string;
  field: string;
  /** Empty cells of this field in the export. */
  cells: number;
  reason: string;
}

/** A placeholder a mandatory file field points at, relative to the export folder's parent. */
export interface PlaceholderFile {
  path: string;
  bytes: Uint8Array;
}

export interface SyntheticExport {
  exported: CreatorExport;
  skipped: { form: string; reason: string }[];
  limits: HarnessLimit[];
  files: PlaceholderFile[];
}

const FILE_MATRIX = new Set(['file-upload', 'image', 'audio', 'video', 'signature']);
/** A 1x1 transparent PNG, for image and signature fields. */
const PLACEHOLDER_PNG = Uint8Array.from(
  Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ff1f0003030200eff3bf380000000049454e44ae426082', 'hex'),
);
const PLACEHOLDER_TEXT = new TextEncoder().encode('c2c rehearsal placeholder\n');

function headerFor(column: SchemaColumn, header: string[]): number {
  const source = column.field ?? column.name;
  return header.findIndex((name) => name === source || name.replace('.', '_') === column.name);
}

/**
 * A Creator record export for the app, built from the `c2c seed` values of
 * every form (subform and cyclic forms included) with an ID column of
 * synthetic record ids. Ids are given to every row first, then each lookup is
 * written as a parent record's id, the way a Creator CSV export carries it; a
 * cyclic or self lookup is the loader's deferred second pass, from the same
 * export. Inline subform rows are `<Form>__<Subform>.csv` files linked by
 * Parent_ID. A mandatory file field points at a small placeholder file. User
 * fields stay empty (an export carries a user's record id, which a synthetic
 * export does not have); every mandatory field left empty is a named harness
 * limit, never a silent blank. Forms the loader does not take (NoSQL, no
 * Data Store table) are skipped with the reason. The same app and row count
 * give the same bytes.
 */
export function syntheticExport(app: App, rows: number): SyntheticExport {
  const schema = generateSchema(app);
  const { grids } = generateSeedRecords(app, { rows });
  const tableFor = (grid: SeedRecordGrid) =>
    grid.subform === undefined
      ? schema.tables.find((table) => table.role === 'form' && table.form === grid.form)
      : schema.tables.find((table) => table.role === 'child' && table.subform?.form === grid.form && table.subform.field === grid.subform);
  const skipped: { form: string; reason: string }[] = [];
  const kept: { grid: SeedRecordGrid; table: SchemaTable; ids: string[] }[] = [];
  const ids = new Map<string, string[]>();
  let next = FIRST_RECORD_ID;
  // Pass 1: every exported row gets its record id, so any lookup (cyclic ones too) can name its parent.
  for (const grid of grids) {
    const table = tableFor(grid);
    if (grid.subform !== undefined && (!table || !ids.has(grid.form))) continue;
    if (!table || table.nosql) {
      skipped.push({ form: grid.form, reason: table ? `NoSQL collection (${table.nosqlReason ?? 'kept out of the Data Store'}); the CSV loader does not load it` : 'no Data Store table for this form' });
      continue;
    }
    const rowIds = grid.rows.map(() => String(next++));
    if (grid.subform === undefined) ids.set(grid.form, rowIds);
    kept.push({ grid, table, ids: rowIds });
  }
  // Pass 2: lookups, placeholder files, Parent_ID.
  const exported: CreatorExport = [];
  const limits: HarnessLimit[] = [];
  const files = new Map<string, PlaceholderFile>();
  for (const { grid, table, ids: rowIds } of kept) {
    const fileColumns = table.columns.filter((column) => FILE_MATRIX.has(column.matrixId) && (column.mandatory || column.appMandatory) && !grid.columns.some((col) => col.name === (column.field ?? column.name)));
    const header = [...grid.columns.map((col) => col.name), ...fileColumns.map((column) => column.field ?? column.name), ...(grid.subform !== undefined ? ['Parent_ID'] : []), 'ID'];
    const parentIds = grid.subform !== undefined ? ids.get(grid.form)! : undefined;
    const body = grid.rows.map((values, i) => {
      const cells = grid.columns.map((col, c) => {
        if (col.users) return '';
        if (!col.lookupForm) return values[c]!;
        const parent = ids.get(col.lookupForm);
        if (!parent?.length) return '';
        const one = parent[i % parent.length]!;
        const two = parent[(i + 1) % parent.length]!;
        return col.multi && two !== one ? `${one},${two}` : one;
      });
      for (const column of fileColumns) {
        const image = column.matrixId === 'image' || column.matrixId === 'signature';
        const path = `files/${table.name}/${column.name}.${image ? 'png' : 'txt'}`;
        files.set(path, { path, bytes: image ? PLACEHOLDER_PNG : PLACEHOLDER_TEXT });
        cells.push(path);
      }
      if (parentIds) cells.push(parentIds[grid.parents![i]!]!);
      cells.push(rowIds[i]!);
      return cells;
    });
    const item: ExportForm = { form: grid.subform !== undefined ? `${grid.form}__${grid.subform}` : grid.form, ...(grid.subform !== undefined ? { subform: { form: grid.form, field: grid.subform } } : {}), header, rows: body };
    exported.push(item);
    for (const column of table.columns) {
      if (!(column.mandatory || column.appMandatory) || column.shadowFor) continue;
      if (table.subform && (column.name === table.subform.parentColumn || column.name === table.subform.orderColumn)) continue;
      const index = headerFor(column, header);
      const empty = index < 0 ? body.length : body.filter((cells) => cells[index] === '').length;
      if (!empty) continue;
      const col = grid.columns.find((entry) => entry.name === header[index]);
      const reason =
        index < 0
          ? `c2c seed generates no value for a ${column.creatorType} field`
          : col?.users
            ? 'a Users field needs an app user\'s record id, which a synthetic export does not have'
            : col?.lookupForm
              ? `parent form ${col.lookupForm} has no exported rows`
              : 'c2c seed left the value empty';
      limits.push({ form: grid.form, ...(grid.subform !== undefined ? { subform: grid.subform } : {}), field: column.field ?? column.name, cells: empty, reason });
    }
  }
  return { exported, skipped, limits, files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

function writeExport(app: App, dir: string, exported: CreatorExport): string {
  mkdirSync(dir, { recursive: true });
  for (const form of exported) writeFileSync(join(dir, `${form.form}.csv`), csvText(form));
  // A full export: counts.json pins each form's total, which a delta delete requires.
  const schema = generateSchema(app);
  const forms = schema.tables.filter((table) => table.role === 'form' && !table.nosql);
  const counts: Record<string, number> = Object.fromEntries(forms.map((table) => [table.form, exported.find((form) => form.form === table.form && !form.subform)?.rows.length ?? 0]));
  // A subform child table pins its own total under its table name, so a deleted record's subform rows may be deleted too.
  for (const table of schema.tables) {
    if (table.role !== 'child' || table.nosql || !table.subform) continue;
    const rows = exported.find((form) => form.subform?.form === table.subform!.form && form.subform.field === table.subform!.field)?.rows.length;
    if (rows !== undefined) counts[table.name] = rows;
  }
  writeFileSync(join(dir, 'counts.json'), `${JSON.stringify(counts)}\n`);
  return dir;
}

function cloneExport(exported: CreatorExport): CreatorExport {
  return exported.map((form) => ({ ...form, header: [...form.header], rows: form.rows.map((row) => [...row]) }));
}

interface Targets {
  /** A form with a plain, non-unique text field: Creator edits it, then the new app edits it. */
  change?: { form: string; column: string };
  /** A form no lookup points at: rows are added and deleted there. */
  leaf?: string;
}

function pickTargets(app: App, exported: CreatorExport): Targets {
  const referenced = new Set(app.forms.flatMap((form) => form.fields.flatMap((field) => (field.lookup ? [field.lookup.form] : []))));
  const withRows = exported.filter((form) => !form.subform && form.rows.length >= 2);
  const parents = new Set(exported.flatMap((form) => (form.subform ? [form.subform.form] : [])));
  let change: Targets['change'];
  for (const form of withRows) {
    const field = app.forms.find((entry) => entry.name === form.form)?.fields.find((entry) => entry.type === 'text' && !entry.unique && form.header.includes(entry.name));
    if (field) {
      change = { form: form.form, column: field.name };
      break;
    }
  }
  // Prefer a leaf without subform rows, so the delete is one record.
  const leaves = [...withRows].reverse().filter((form) => !referenced.has(form.form));
  const leaf = (leaves.find((form) => !parents.has(form.form)) ?? leaves[0])?.form;
  return { ...(change ? { change } : {}), ...(leaf ? { leaf } : {}) };
}

function tableOf(app: App, form: string): string {
  return generateSchema(app).tables.find((table) => table.form === form && !table.subform)?.name ?? form;
}

function totals(plan: DeltaPlan): { added: number; changed: number; deleted: number } {
  return plan.tables.reduce(
    (sum, table) => ({ added: sum.added + table.added.length, changed: sum.changed + table.changed.length, deleted: sum.deleted + table.deleted.length }),
    { added: 0, changed: 0, deleted: 0 },
  );
}

function deltaLine(label: string, plan: DeltaPlan): string {
  const t = totals(plan);
  return `${label}: ${t.added} new, ${t.changed} changed, ${t.deleted} deleted`;
}

async function sync(app: App, store: { fetch: FetchLike }, loaded: CsvLoad, checkpoint: DeltaCheckpoint | undefined, resolve?: ConflictResolver) {
  const plan = computeDelta(app, loaded, checkpoint, 'csv');
  const result = await applyDelta({ ...STORE, fetch: store.fetch, app, loaded, plan, applyDeletes: true, ...(resolve ? { resolve } : {}) });
  const next = result.ok ? withStoreFingerprints(withDeletionsApplied(plan.next, result.appliedDeletes), result.store) : checkpoint;
  return { plan, result, next };
}

/** Differences between an export and the store: per table, missing/extra source ids and an expected cell value. */
async function storeDiff(app: App, store: { fetch: FetchLike }, loaded: CsvLoad, expect?: { table: string; column: string; sourceId: string; value: string }): Promise<string[]> {
  const out: string[] = [];
  const stored = await readStoreRows({ ...STORE, fetch: store.fetch }, [...new Set(loaded.tables.map((table) => table.table))]);
  for (const table of loaded.tables) {
    const want = new Set(table.rows.map((row) => row.id));
    const have = new Set((stored.get(table.table) ?? []).map((row) => String(row[SOURCE_ID_COLUMN] ?? '')));
    const missing = [...want].filter((id) => !have.has(id)).length;
    const extra = [...have].filter((id) => !want.has(id)).length;
    if (missing || extra) out.push(`${table.table}: store differs from the export (${missing} missing, ${extra} extra)`);
  }
  if (expect) {
    const row = stored.get(expect.table)?.find((entry) => String(entry[SOURCE_ID_COLUMN]) === expect.sourceId);
    if (row?.[expect.column] !== expect.value) out.push(`${expect.table}/${expect.sourceId}: store holds ${JSON.stringify(row?.[expect.column] ?? null)} for ${expect.column}, expected ${JSON.stringify(expect.value)}`);
  }
  return out;
}

function criterion(id: string, text: string, failures: string[], evidence: string[], fix: string): D10Criterion {
  return failures.length
    ? { id, criterion: text, status: 'FAIL', evidence, reason: failures.join('; '), fix }
    : { id, criterion: text, status: 'PASS', evidence };
}

function gap(id: string, text: string, reason: string, fix: string, evidence: string[] = []): D10Criterion {
  return { id, criterion: text, status: 'GAP', evidence, reason, fix };
}

/** The checklist sections in cut-over order; each must be present, in this order. */
const SEQUENCE: { step: string; heading: string; needs: RegExp }[] = [
  { step: 'rollback baseline', heading: '## 1. Rollback baseline', needs: /c2c rollback-export/ },
  { step: 'freeze', heading: '## 2. Freeze Creator edits', needs: /freeze time/ },
  { step: 'final delta', heading: '## 3. Final delta', needs: /new 0 changed 0/ },
  { step: 'verify', heading: '## 4. Smoke', needs: /c2c smoke/ },
  { step: 'switch', heading: '## 6. Redirect', needs: /Creator app home page/ },
  { step: 'rollback ready', heading: '## 8. Rollback ready', needs: /baseline folder/ },
];

/** Checks that the checklist documents freeze -> final delta -> verify -> switch, with rollback before and after. */
export function checkSequence(text: string): string[] {
  const failures: string[] = [];
  let last = -1;
  for (const item of SEQUENCE) {
    const at = text.indexOf(item.heading);
    if (at < 0) {
      failures.push(`checklist has no ${item.step} section (${item.heading})`);
      continue;
    }
    const end = text.indexOf('\n## ', at + item.heading.length);
    if (!item.needs.test(text.slice(at, end < 0 ? undefined : end))) failures.push(`${item.step} section does not name its action (${item.needs.source})`);
    if (at < last) failures.push(`${item.step} section is out of order`);
    last = Math.max(last, at);
  }
  return failures;
}

function rowCount(body: string | undefined): number {
  if (!body) return 0;
  return parseCsv(body).filter((row) => row.length > 1 || row[0] !== '').length - 1;
}

export async function rehearseCutover(app: App, options: RehearsalOptions): Promise<D10Report> {
  const hooks = options.hooks ?? {};
  const work = options.workDir;
  const { exported: initial, skipped, limits, files: placeholders } = syntheticExport(app, options.rows ?? 30);
  for (const file of placeholders) {
    mkdirSync(dirname(join(work, file.path)), { recursive: true });
    writeFileSync(join(work, file.path), file.bytes);
  }
  const exercised = initial.filter((form) => !form.subform && form.rows.length).map((form) => form.form);
  const notExercised = [
    ...skipped,
    ...app.forms.filter((form) => !exercised.includes(form.name) && !skipped.some((entry) => entry.form === form.name)).map((form) => ({ form: form.name, reason: 'no rows in the synthetic export' })),
  ];
  const targets = pickTargets(app, initial);
  const memory = memoryStore();
  const store = { tables: memory.tables, fetch: hooks.fetch ? hooks.fetch(memory.fetch) : memory.fetch };
  const criteria: D10Criterion[] = [];
  const load = (name: string, exported: CreatorExport) => readSourceCsv(writeExport(app, join(work, name), exported), app, true);

  // Initial load, then one parallel-run round while Creator stays in use.
  const first = await sync(app, store, load('export-0', initial), undefined);
  const parallel = cloneExport(initial);
  const expectParallel = { added: 0, changed: 0, deleted: 0 };
  const leaf = parallel.find((form) => form.form === targets.leaf);
  if (leaf) {
    const copy = [...leaf.rows[0]!];
    copy[copy.length - 1] = String(FIRST_RECORD_ID - 1n);
    leaf.rows.push(copy);
    const [gone] = leaf.rows.splice(1, 1);
    expectParallel.added = 1;
    expectParallel.deleted = 1;
    // Deleting a record deletes its subform rows with it.
    for (const child of parallel.filter((form) => form.subform?.form === leaf.form)) {
      const link = child.header.indexOf('Parent_ID');
      const before = child.rows.length;
      child.rows = child.rows.filter((row) => row[link] !== gone!.at(-1));
      expectParallel.deleted += before - child.rows.length;
    }
  }
  const changeForm = targets.change && parallel.find((form) => form.form === targets.change!.form);
  if (changeForm) {
    changeForm.rows[0]![changeForm.header.indexOf(targets.change!.column)] = `${NEW_TEXT} parallel`;
    expectParallel.changed = 1;
  }
  const parallelLoad = load('export-1', parallel);
  const round = await sync(app, store, parallelLoad, first.next);
  const parallelStore = await storeDiff(
    app,
    store,
    parallelLoad,
    changeForm ? { table: tableOf(app, targets.change!.form), column: targets.change!.column, sourceId: changeForm.rows[0]!.at(-1)!, value: `${NEW_TEXT} parallel` } : undefined,
  );
  const replanParallel = computeDelta(app, load('export-1', parallel), round.next, 'csv');
  {
    const failures: string[] = [];
    if (!first.result.ok) failures.push(`initial load failed: ${first.result.error}`);
    if (!round.result.ok) failures.push(`parallel-run delta failed: ${round.result.error}`);
    const t = totals(round.plan);
    if (t.added !== expectParallel.added || t.changed !== expectParallel.changed || t.deleted !== expectParallel.deleted) {
      failures.push(`parallel-run delta planned ${t.added}/${t.changed}/${t.deleted}, expected ${expectParallel.added}/${expectParallel.changed}/${expectParallel.deleted}`);
    }
    const again = totals(replanParallel);
    if (again.added || again.changed || again.deleted) failures.push('re-plan after the parallel-run delta is not empty');
    failures.push(...parallelStore);
    if (!leaf || !changeForm) failures.push('no form could take an add, change and delete');
    criteria.push(
      criterion(
        'D10.parallel-run',
        'Parallel run (Creator stays primary): repeated delta syncs carry new, changed and deleted records and are idempotent',
        failures,
        [deltaLine('initial load', first.plan), deltaLine('parallel-run delta', round.plan), deltaLine('re-plan', replanParallel), `targets: change ${targets.change ? `${targets.change.form}.${targets.change.column}` : 'none'}, add/delete ${targets.leaf ?? 'none'}`],
        'Make c2c sync-delta carry every record change between two exports and re-plan empty after apply (row-delta.ts computeDelta / applyDelta).',
      ),
    );
  }

  // Last Creator edit, freeze, final export, final delta.
  const final = cloneExport(parallel);
  const finalForm = targets.change && final.find((form) => form.form === targets.change!.form);
  if (finalForm) finalForm.rows[1]![finalForm.header.indexOf(targets.change!.column)] = `${NEW_TEXT} final`;
  const finalLoad = load('export-final', final);
  const finalSync = await sync(app, store, finalLoad, round.next);
  const finalStore = await storeDiff(
    app,
    store,
    finalLoad,
    finalForm ? { table: tableOf(app, targets.change!.form), column: targets.change!.column, sourceId: finalForm.rows[1]!.at(-1)!, value: `${NEW_TEXT} final` } : undefined,
  );
  const afterFreeze = cloneExport(final);
  hooks.afterFreeze?.(afterFreeze);
  const freezeReplan = computeDelta(app, load('export-after-freeze', afterFreeze), finalSync.next, 'csv');
  {
    const failures: string[] = [];
    if (!finalSync.result.ok) failures.push(`final delta failed: ${finalSync.result.error}`);
    const t = totals(finalSync.plan);
    if (finalForm && (t.added !== 0 || t.changed !== 1 || t.deleted !== 0)) failures.push(`final delta planned ${t.added}/${t.changed}/${t.deleted}, expected 0/1/0`);
    if (!finalForm) failures.push('no form could take the last Creator edit');
    failures.push(...finalStore);
    criteria.push(
      criterion(
        'D10.final-delta',
        'Final delta: the export taken after the freeze is applied and its counts match the edits made since the last sync',
        failures,
        [deltaLine('final delta', finalSync.plan)],
        'Make c2c sync-delta plan exactly the records changed since the checkpoint and record the checkpoint after apply.',
      ),
    );
  }
  {
    const t = totals(freezeReplan);
    const leaked = t.added + t.changed + t.deleted;
    criteria.push(
      criterion(
        'D10.freeze',
        'Freeze: a re-export after the final delta plans no changes, so any Creator write that slipped past the freeze is caught before the switch',
        leaked ? [`${leaked} Creator change(s) after the freeze: ${t.added} new, ${t.changed} changed, ${t.deleted} deleted`] : [],
        [deltaLine('re-plan of the post-freeze export', freezeReplan), 'the freeze itself is a Creator permission change a human makes (checklist section 2)'],
        'Keep the post-freeze re-plan in the checklist as a blocking step: a non-empty plan means Creator is still taking writes.',
      ),
    );
  }

  hooks.afterFinalDelta?.(store.tables);

  // Verify: proof checksums plus a store read-back against the final export.
  const scope = { org: SCOPE.org, projectId: SCOPE.projectId, dc: STORE.dc };
  const input: CutoverInput = { app, loaded: finalLoad, sourceKind: 'csv', ...(finalSync.next ? { checkpoint: finalSync.next } : {}), scope };
  const proof = proofReport(input);
  const stored = await readStoreRows({ ...STORE, fetch: store.fetch }, [...new Set(finalLoad.tables.map((table) => table.table))]);
  {
    const failures: string[] = [];
    for (const table of proof.tables.filter((entry) => entry.sourceRows !== undefined)) {
      if (table.match !== true) failures.push(`${table.table}: proof checksum of the export does not match the checkpoint`);
    }
    failures.push(...(await storeDiff(app, store, finalLoad)));
    const evidence = finalLoad.tables.map((table) => `${table.table}: export ${table.rows.length}, store ${stored.get(table.table)?.length ?? 0}`);
    criteria.push(
      criterion(
        'D10.verify',
        'Verify: every table of the final export matches the checkpoint (proof checksums) and the store holds exactly the exported records',
        failures,
        evidence,
        'Add a store read-back to c2c proof so verification compares the Data Store, not only the export against the checkpoint.',
      ),
    );
  }

  // The documented sequence.
  const checklist = (hooks.checklist ?? ((text: string) => text))(cutoverChecklist(input, proof));
  criteria.push(
    criterion(
      'D10.sequence',
      'Documented sequence: the cut-over checklist runs rollback baseline -> freeze -> final delta -> verify -> switch -> rollback ready, each with its action',
      checkSequence(checklist),
      SEQUENCE.map((item) => `${item.step}: ${item.heading}`),
      'Restore the missing or reordered section in cutoverChecklist (packages/cli/src/cutover.ts).',
    ),
  );

  // Writes in the new app after the switch, then roll back to Creator.
  const postWrites: { table: string; column?: string; value?: string; added: boolean } = { table: '', added: false };
  if (targets.change) {
    const table = tableOf(app, targets.change.form);
    const row = store.tables.get(table)?.[0];
    if (row) {
      row[targets.change.column] = `${NEW_TEXT} after switch`;
      Object.assign(postWrites, { table, column: targets.change.column, value: `${NEW_TEXT} after switch` });
    }
  }
  if (targets.leaf) {
    const table = tableOf(app, targets.leaf);
    const first = store.tables.get(table)?.[0];
    if (first) {
      // A record created in the new app: no Creator source id.
      const { ROWID: _rowid, [SOURCE_ID_COLUMN]: _source, ...copy } = first;
      const url = `${STORE.catalystBase}/baas/v1/project/${SCOPE.projectId}/table/${table}/row`;
      postWrites.added = (await store.fetch(url, { method: 'POST', body: JSON.stringify([copy]) })).status === 200;
    }
  }
  const allTables = generateSchema(app).tables.filter((table) => !table.nosql && table.role !== 'system').map((table) => table.name);
  const storeRows = await readStoreRows({ ...STORE, fetch: store.fetch }, allTables);
  const rollback = rollbackExport(app, storeRows);
  const files = new Map(rollback.files.map((file) => [file.path, file.body]));
  hooks.rollbackFiles?.(files);
  const rollbackDir = join(work, 'rollback');
  for (const file of [...rollback.files, rollback.manifest]) {
    const path = join(rollbackDir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.path === rollback.manifest.path ? file.body : (files.get(file.path) ?? ''));
  }
  const evidenceCheck = verifyRollbackEvidence(options.target, rollbackDir, app);
  {
    const failures: string[] = [];
    const evidence: string[] = [];
    if (evidenceCheck?.status !== 'valid') failures.push(`rollback manifest does not verify: ${evidenceCheck?.reason ?? 'not checked'}`);
    for (const count of rollback.counts) {
      const inStore = storeRows.get(count.table)?.length ?? 0;
      const written = rowCount(files.get(`import/${count.form}.csv`));
      evidence.push(`${count.form}: store ${inStore}, rollback import ${written}`);
      if (written !== inStore) failures.push(`${count.form}: rollback import holds ${written} of ${inStore} stored record(s)`);
    }
    const changeForm = targets.change?.form;
    const changeBody = changeForm ? files.get(`import/${changeForm}.csv`) : undefined;
    if (postWrites.value && !changeBody?.includes(postWrites.value)) failures.push(`edit made in the new app after the switch (${postWrites.table}.${postWrites.column}) is not in the rollback import`);
    if (!postWrites.value || !postWrites.added) failures.push('no post-switch write could be made to prove it rolls back');
    else evidence.push(`post-switch edit and new record in ${postWrites.table}${targets.leaf ? ` / ${tableOf(app, targets.leaf)}` : ''} are in the rollback import`);
    criteria.push(
      criterion(
        'D10.rollback',
        'Rollback to Creator: after writes in the new app, rollback-export holds every stored record (edits and new records included) in Creator import CSVs and its manifest verifies',
        failures,
        evidence,
        'Make rollbackExport write every stored row, including rows created after the switch (no source id), and keep the manifest checksums.',
      ),
    );
  }

  // What the rollback export leaves to a human.
  {
    const manual = rollback.files.filter((file) => file.path.startsWith('manual/') || file.path.startsWith('files/')).map((file) => file.path);
    const schema = generateSchema(app);
    const childTables = schema.tables.filter((table) => (table.role === 'child' || table.role === 'junction') && !table.nosql).map((table) => table.name);
    const fileFields = app.forms.flatMap((form) => form.fields.filter((field) => ['upload file', 'image', 'audio', 'video', 'signature'].includes(field.type ?? '')).map((field) => `${form.name}.${field.name}`));
    if (childTables.length || fileFields.length) {
      criteria.push(
        gap(
          'D10.rollback-complete',
          'Rollback restores subform rows, multi lookups and files without a human step',
          `rollbackExport writes subform rows and multi lookups under manual/ and file keys under files/ because Creator report import cannot load them; ${[
            childTables.length ? `subform/junction tables ${childTables.join(', ')}` : '',
            fileFields.length ? `file fields ${fileFields.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; ')} need re-entry or re-attach by hand`,
          'Emit a Creator-side restore for subform rows and files (for example a generated Deluge function or a Creator API import plan) so rollback needs no manual worksheet.',
          manual.length ? [`manual files in this run: ${manual.join(', ')}`] : ['no manual files in this run (those tables had no rows)'],
        ),
      );
    } else {
      criteria.push({ id: 'D10.rollback-complete', criterion: 'Rollback restores subform rows, multi lookups and files without a human step', status: 'PASS', evidence: ['the app has no subform, multi lookup or file field'] });
    }
  }

  // Probe: the same record edited in the new app and in Creator, then one more sync.
  // The record edited after the switch (new app only) must stay as the new app left it.
  {
    const failures: string[] = [];
    const evidence: string[] = [];
    const table = targets.change ? tableOf(app, targets.change.form) : '';
    const column = targets.change?.column ?? '';
    const rows = store.tables.get(table) ?? [];
    const sourceId = finalForm && finalForm.rows.length > 2 ? finalForm.rows[2]!.at(-1)! : '';
    const row = rows.find((entry) => String(entry[SOURCE_ID_COLUMN]) === sourceId);
    const appOnly = postWrites.value ? rows.find((entry) => entry[column] === postWrites.value) : undefined;
    if (!targets.change || !finalForm || !row) failures.push('no record could be edited on both sides');
    else {
      row[column] = `${NEW_TEXT} new app side`;
      const both = cloneExport(final);
      both.find((form) => form.form === targets.change!.form)!.rows[2]![finalForm.header.indexOf(column)] = `${NEW_TEXT} Creator side`;
      const bothLoad = load('export-conflict', both);
      const refused = await sync(app, store, bothLoad, finalSync.next, hooks.conflictResolver);
      const found = refused.result.conflicts.filter((item) => item.table === table && item.sourceId === sourceId);
      if (refused.result.ok) failures.push(`record ${table}/${sourceId} edited on both sides: sync-delta applied without refusing`);
      if (refused.result.conflicts.length !== 1 || found.length !== 1) failures.push(`expected 1 conflict for ${table}/${sourceId}, got ${refused.result.conflicts.length}`);
      else {
        const conflict = found[0]!;
        const line = formatConflict(conflict);
        if (conflict.rowid !== row.ROWID || !conflict.fields.some((field) => field.column === column)) failures.push(`conflict does not name ROWID ${String(row.ROWID)} and field ${column}: ${line}`);
        if (line.includes(NEW_TEXT)) failures.push('the conflict report carries a field value');
        evidence.push(`both-sides edit refused: ${line}`);
      }
      if (row[column] !== `${NEW_TEXT} new app side`) failures.push(`the refused sync overwrote ${table}/${sourceId}`);
      const applied = await sync(app, store, bothLoad, finalSync.next, () => 'creator');
      if (!applied.result.ok) failures.push(`--prefer creator did not apply: ${applied.result.error ?? ''}`);
      else if (applied.result.conflicts.map((item) => item.resolution).join() !== 'creator') failures.push('the creator choice is not recorded on the conflict');
      if (row[column] !== `${NEW_TEXT} Creator side`) failures.push(`--prefer creator left ${table}/${sourceId} at ${JSON.stringify(row[column] ?? null)}`);
      else evidence.push(`--prefer creator: ${table}/${sourceId} holds the Creator value, resolution recorded`);
      if (!appOnly || appOnly[column] !== postWrites.value) failures.push('the edit made only in the new app did not survive the sync');
      else evidence.push(`new-app-only edit ${table}/ROWID ${String(appOnly.ROWID)} unchanged by both syncs`);
      const replan = computeDelta(app, load('export-conflict', both), applied.next, 'csv');
      const t = totals(replan);
      if (t.added || t.changed || t.deleted) failures.push(`re-plan after the resolved sync: ${t.added}/${t.changed}/${t.deleted}`);
      const back = rollbackExport(app, await readStoreRows({ ...STORE, fetch: store.fetch }, allTables)).files.find((file) => file.path === `import/${targets.change!.form}.csv`)?.body ?? '';
      if (!postWrites.value || !back.includes(postWrites.value)) failures.push('the new-app-only edit is not in the rollback import back to Creator');
      else evidence.push('new-app edits flow back to Creator through the rollback import (full export)');
    }
    criteria.push(
      criterion(
        'D10.reverse-sync',
        'Parallel run with writes on both sides: changes made in the new app flow back to Creator and conflicts are reported',
        failures,
        evidence,
        'Make sync-delta refuse a record edited on both sides until --prefer or --conflicts resolves it (row-delta.ts applyDelta conflict check), keep new-app-only edits, and carry them in rollback-export.',
      ),
    );
  }
  criteria.push(
    gap(
      'D10.custom-domain',
      'Custom domain: the new app is served on the business domain with a valid certificate',
      'c2c does not configure or check a custom domain; the checklist only asks a human to record the hostname, DNS target and certificate (section 7)',
      'Add the Catalyst domain mapping steps to the deploy plan and a DNS + HTTPS check the checklist can verify.',
    ),
    gap(
      'D10.link-map',
      'Old links and bookmarks: every Creator form, report and page URL maps to its new app URL',
      'c2c produces no Creator-URL -> new-route map; the proof and checklist only say "replace Creator app links and bookmarks with the new app URL"',
      'Generate a link map (Creator #Form:/#Report:/#Page: URL -> generated route) with the UI and print it in the checklist; optionally a redirect page.',
    ),
    gap(
      'D10.downtime',
      'Downtime estimate: the cut-over window is estimated before the freeze',
      'c2c prints no downtime or freeze-window estimate; proof and checklist carry row counts and checksums but no timing from the final-delta size',
      'Estimate the window from the final-delta plan (rows x measured write rate + smoke + sign-in steps) and print it in the proof and checklist.',
    ),
  );

  const count = (status: D10Status) => criteria.filter((item) => item.status === status).length;
  return {
    schema: 'c2c-d10-rehearsal/1',
    app: app.name ?? '(none)',
    exercised,
    notExercised,
    harnessLimits: limits,
    criteria,
    totals: { PASS: count('PASS'), FAIL: count('FAIL'), GAP: count('GAP') },
    status: count('PASS') === criteria.length ? 'PASS' : 'FAIL',
  };
}

function mdCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function rehearsalMarkdown(report: D10Report): string {
  const lines = [
    `# D10 cut-over rehearsal: ${mdCell(report.app)}`,
    '',
    `Status ${report.status}: ${report.totals.PASS} pass, ${report.totals.FAIL} fail, ${report.totals.GAP} gap. GAP = c2c does not do it yet; never a pass.`,
    '',
    `Exercised forms: ${report.exercised.join(', ') || 'none'}.`,
    ...report.notExercised.map((item) => `Not exercised: ${mdCell(item.form)} (${mdCell(item.reason)}).`),
    `Harness limits: ${report.harnessLimits.length}.`,
    ...report.harnessLimits.map((item) => `Harness limit: ${mdCell(`${item.form}${item.subform ? `.${item.subform}` : ''}.${item.field}`)}, ${item.cells} empty cell(s) (${mdCell(item.reason)}).`),
    '',
    '| Criterion | Status | Evidence | Reason |',
    '| --- | --- | --- | --- |',
    ...report.criteria.map((item) => `| ${item.id}: ${mdCell(item.criterion)} | ${item.status} | ${mdCell(item.evidence.join('; '))} | ${mdCell(item.reason ?? '')} |`),
    '',
  ];
  const open = report.criteria.filter((item) => item.fix);
  if (open.length) lines.push('## Fixes', '', ...open.map((item) => `- ${item.id}: ${mdCell(item.fix!)}`), '');
  return lines.join('\n');
}
