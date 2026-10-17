/**
 * Delta sync while Creator stays live: a newer export is compared with the
 * checkpoint of the last applied run and only new and changed records are written.
 *
 * The checkpoint lives under `delta` in the project's state file. It holds the
 * latest Modified_Time seen, and per table each source id with a fingerprint of
 * its mapped values. Fingerprints are sha256 over sorted `column=value` pairs,
 * so no field value and no personal column is stored: Added_User,
 * Modified_User, Added_Time, Modified_Time and c2c_source_id are left out of
 * the fingerprint, and a record that was only re-saved is not a change.
 *
 * A record is new when its source id is not in the checkpoint. It is changed
 * when its fingerprint differs; the plan also says how many changed records do
 * not carry a newer Modified_Time. It is deleted when the checkpoint has its id
 * and the export does not. A table the export holds no rows for is never
 * counted as deleted: the plan says the table is missing instead.
 *
 * Apply is an upsert by c2c_source_id. Existing rows are read back first; a row
 * whose stored values already match is not written; a changed row is updated in
 * place by ROWID; an absent row is inserted. A source id stored twice is refused.
 * Lookups resolve to the parent's ROWID, read from the store when the parent is
 * not part of this delta, so a new child under an existing parent links to it.
 * Deletions are only applied with applyDeletes, children before parents.
 *
 * Conflicts: after a write the checkpoint also keeps, per row, a fingerprint of
 * the row as the store reads it back (`store`). Before the next apply writes
 * anything, every changed or deleted record that has one is read from the store
 * again; a different fingerprint means the row was also edited in the new app
 * since the last sync. Such a row is a conflict and is never overwritten
 * silently: the apply is refused until each conflict is resolved, keeping the
 * Creator or the new app value. A conflict names the table, ROWID, source id and
 * the differing fields with a short sha256 of each side's value; no value is
 * printed. A row edited on one side only is not a conflict.
 */
import { createHash } from 'node:crypto';
import type { App } from '../../core/src/ir.js';
import { canonDecimal, changedColumns, integrityColumns, isEmptyCell, prepareColumns, type IntegrityColumn } from '../../data/src/integrity.js';
import {
  MAX_BATCH,
  ZCQL_IN_LIMIT,
  assertAllowedHost,
  catalystAuthHeaders,
  catalystErrorDetail,
  catalystQueryUrl,
  type CatalystScope,
  type FetchLike,
} from '../../data/src/migrate.js';
import { generateSchema, type SchemaTable } from '../../schema/src/generator.js';
import { SOURCE_ID_COLUMN, SYSTEM_FIELD_COLUMNS } from '../../schema/src/mapping.js';
import type { CsvLoad } from './csv.js';
import { exactId, parseJsonExact } from './json-exact.js';
import { deferredColumns } from './remap.js';
import type { SeedRow } from './seed.js';
import { cyclicForeignKeys, foreignKeyId } from './tables.js';

export const MODIFIED_TIME = 'Modified_Time';
/**
 * Default cap on --apply-deletes: the share of a table's remembered records one
 * run may remove. Over it needs --allow-mass-delete. The completeness proof
 * below still applies — a mass-delete pass never lifts it.
 */
export const MAX_DELETE_PERCENT = 5;
const UNFINGERPRINTED = new Set<string>([SOURCE_ID_COLUMN, ...SYSTEM_FIELD_COLUMNS.map((column) => column.name)]);
/**
 * Bookkeeping columns shared by rollback, parity and the store fingerprint: the
 * loader's source id, the row id, the columns Catalyst stamps on every
 * `SELECT *` row, and the Creator system fields.
 */
export const STORE_SYSTEM_COLUMNS = new Set<string>([SOURCE_ID_COLUMN, 'ROWID', 'CREATORID', 'CREATEDTIME', 'MODIFIEDTIME', ...SYSTEM_FIELD_COLUMNS.map((column) => column.name)]);

export interface DeltaCheckpoint {
  version: 1;
  /** Source kind of the run that wrote it (json, csv, backup). */
  source: string;
  /** Latest Modified_Time in the source, yyyy-MM-dd HH:mm:ss. Absent when the source carries none. */
  since?: string;
  tables: Record<string, DeltaCheckpointTable>;
}

export interface DeltaCheckpointTable {
  /** Source id → row fingerprint. */
  rows: Record<string, string>;
  /** Ids that left the source and are still in the store (deletions not applied). */
  deleted?: string[];
  /** Source id → fingerprint of the stored row as read back after the last apply. */
  store?: Record<string, string>;
}

export interface DeltaTable {
  table: string;
  added: SeedRow[];
  changed: SeedRow[];
  unchanged: number;
  /** Changed rows whose Modified_Time is not newer than the checkpoint (or absent). */
  changedWithoutNewerTime: number;
  deleted: string[];
  /** The checkpoint has rows for this table and the source has none: deletions are not computed. */
  missing: boolean;
  /** Store fingerprints from the checkpoint: the conflict check compares the store with them. */
  store: Record<string, string>;
}

export interface DeltaPlan {
  /** No checkpoint: every source record is new. */
  baseline: boolean;
  since?: string;
  tables: DeltaTable[];
  /** Checkpoint to record after a successful apply (deletions still pending). */
  next: DeltaCheckpoint;
}

/**
 * Canonical fingerprint of one source row: sorted mapped columns, system and id
 * columns aside. A Double column compares as a decimal, so 1250.00 and 1250 agree.
 */
export function rowFingerprint(columns: Readonly<Record<string, string>>, doubles: ReadonlySet<string> = new Set()): string {
  const parts = Object.keys(columns)
    .filter((key) => !UNFINGERPRINTED.has(key) && columns[key] !== '')
    .sort()
    .map((key) => `${key}=${doubles.has(key) ? canonDecimal(columns[key]) ?? columns[key] : columns[key]}`);
  return createHash('sha256').update(parts.join('\x01')).digest('hex').slice(0, 32);
}

/** Order-independent checksum of a table: sha256 over sorted `id:fingerprint` lines. */
export function tableChecksum(rows: Readonly<Record<string, string>>): string {
  const lines = Object.keys(rows)
    .sort(compareIds)
    .map((id) => `${id}:${rows[id]}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Numeric ids by length then text, so a 19-digit id sorts after a 17-digit one. */
export function compareIds(a: string, b: string): number {
  if (a.length !== b.length && /^\d+$/.test(a) && /^\d+$/.test(b)) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function parseDeltaCheckpoint(value: unknown): DeltaCheckpoint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('delta checkpoint is not an object');
  const record = value as Partial<DeltaCheckpoint>;
  if (record.version !== 1) throw new Error('delta checkpoint version must be 1');
  if (!record.tables || typeof record.tables !== 'object') throw new Error('delta checkpoint has no tables');
  for (const [table, entry] of Object.entries(record.tables)) {
    if (!entry || typeof entry !== 'object' || !entry.rows || typeof entry.rows !== 'object') {
      throw new Error(`delta checkpoint table ${table} has no rows`);
    }
  }
  return record as DeltaCheckpoint;
}

/** Double columns per table: their text form is not stable across a store round trip. */
export function doubleColumns(app: App): Map<string, Set<string>> {
  return new Map(
    generateSchema(app).tables.map((table) => [
      table.name,
      new Set(table.columns.filter((column) => column.dataType === 'Double' && !column.exactDecimal).map((column) => column.name)),
    ]),
  );
}

export function computeDelta(app: App, loaded: CsvLoad, checkpoint: DeltaCheckpoint | undefined, source: string = loaded.source): DeltaPlan {
  const since = checkpoint?.since;
  const doubles = doubleColumns(app);
  const tables: DeltaTable[] = [];
  const next: DeltaCheckpoint = { version: 1, source, tables: {} };
  let latest = since;
  const names = new Set([...loaded.tables.map((table) => table.table), ...Object.keys(checkpoint?.tables ?? {})]);
  const ordered = [
    ...loaded.tables.map((table) => table.table),
    ...[...names].filter((name) => !loaded.tables.some((table) => table.table === name)).sort(),
  ];
  for (const name of ordered) {
    const rows = loaded.tables.find((table) => table.table === name)?.rows ?? [];
    const before = checkpoint?.tables[name];
    const known = before?.rows ?? {};
    const missing = rows.length === 0 && Object.keys(known).length > 0;
    const store = before?.store ?? {};
    const item: DeltaTable = { table: name, added: [], changed: [], unchanged: 0, changedWithoutNewerTime: 0, deleted: [], missing, store };
    const fingerprints: Record<string, string> = {};
    for (const row of rows) {
      const fingerprint = rowFingerprint(row.columns, doubles.get(name));
      fingerprints[row.id] = fingerprint;
      const modified = row.columns[MODIFIED_TIME];
      if (modified && (!latest || modified > latest)) latest = modified;
      const stored = known[row.id];
      if (stored === undefined) item.added.push(row);
      else if (stored !== fingerprint) {
        item.changed.push(row);
        if (!modified || !since || modified <= since) item.changedWithoutNewerTime += 1;
      } else item.unchanged += 1;
    }
    if (missing) {
      next.tables[name] = { rows: { ...known }, ...(before?.deleted?.length ? { deleted: [...before.deleted] } : {}), ...storeEntry(store, new Set(Object.keys(store))) };
    } else {
      const present = new Set(rows.map((row) => row.id));
      const gone = new Set([...Object.keys(known), ...(before?.deleted ?? [])].filter((id) => !present.has(id)));
      item.deleted = [...gone].sort(compareIds);
      if (rows.length || item.deleted.length) {
        next.tables[name] = { rows: fingerprints, ...(item.deleted.length ? { deleted: item.deleted } : {}), ...storeEntry(store, new Set([...present, ...item.deleted])) };
      }
    }
    tables.push(item);
  }
  if (latest) next.since = latest;
  return { baseline: !checkpoint, ...(since ? { since } : {}), tables, next };
}

function storeEntry(store: Readonly<Record<string, string>>, keep: ReadonlySet<string>): { store?: Record<string, string> } {
  const out = Object.fromEntries(Object.entries(store).filter(([id]) => keep.has(id)));
  return Object.keys(out).length ? { store: out } : {};
}

/**
 * Fingerprint of a row as the store reads it back: every non-empty cell but the
 * bookkeeping columns, by name. Only ever compared with another store read.
 */
export function storeFingerprint(row: Readonly<Record<string, unknown>>): string {
  const parts = Object.keys(row)
    .filter((key) => !STORE_SYSTEM_COLUMNS.has(key) && !isEmptyCell(row[key]))
    .sort()
    .map((key) => `${key}=${typeof row[key] === 'object' ? JSON.stringify(row[key]) : String(row[key])}`);
  return createHash('sha256').update(parts.join('\x01')).digest('hex').slice(0, 32);
}

/** Short sha256 of one cell, salted with its table and column; an empty cell is `empty`. */
export function valueHash(table: string, column: string, value: unknown): string {
  if (isEmptyCell(value)) return 'empty';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `sha256:${createHash('sha256').update(`${table}\x01${column}\x01${text}`).digest('hex').slice(0, 12)}`;
}

export type ConflictSide = 'creator' | 'catalyst';

export interface DeltaConflict {
  table: string;
  sourceId: string;
  /** The stored row's ROWID; empty when the new app deleted the row. */
  rowid: string;
  /**
   * changed: edited on both sides. deleted-in-creator / deleted-in-catalyst: one side deleted, the other edited.
   * added-but-exists: new since the checkpoint, yet the store already holds a different row with its source id.
   */
  kind: 'changed' | 'deleted-in-creator' | 'deleted-in-catalyst' | 'added-but-exists';
  /** Differing fields, each with a short hash of both values. */
  fields: { column: string; creator: string; catalyst: string }[];
  resolution?: ConflictSide;
}

/** Which side wins a conflict; undefined leaves it unresolved. */
export type ConflictResolver = (table: string, sourceId: string) => ConflictSide | undefined;

const CONFLICT_TEXT: Record<DeltaConflict['kind'], string> = {
  changed: 'edited in Creator and in the new app',
  'deleted-in-creator': 'deleted in Creator, edited in the new app',
  'deleted-in-catalyst': 'edited in Creator, deleted in the new app',
  'added-but-exists': 'new in Creator since the checkpoint, already stored in the new app',
};

export function formatConflict(conflict: DeltaConflict): string {
  const fields = conflict.fields.map((field) => `${field.column} (Creator ${field.creator}, new app ${field.catalyst})`).join('; ');
  const what = CONFLICT_TEXT[conflict.kind];
  return `${conflict.table} ROWID ${conflict.rowid || '(none)'} source id ${conflict.sourceId}: ${what}${fields ? `: ${fields}` : ''}${conflict.resolution ? ` -> keep ${conflict.resolution === 'creator' ? 'Creator' : 'new app'} value` : ' -> unresolved'}`;
}

/** The checkpoint with the store fingerprints read back after an apply. */
export function withStoreFingerprints(next: DeltaCheckpoint, store: Readonly<Record<string, Readonly<Record<string, string>>>>): DeltaCheckpoint {
  const tables: Record<string, DeltaCheckpointTable> = {};
  for (const [name, entry] of Object.entries(next.tables)) {
    const merged = { ...(entry.store ?? {}), ...(store[name] ?? {}) };
    const keep = new Set([...Object.keys(entry.rows), ...(entry.deleted ?? [])]);
    tables[name] = { rows: entry.rows, ...(entry.deleted?.length ? { deleted: entry.deleted } : {}), ...storeEntry(merged, keep) };
  }
  return { ...next, tables };
}

/**
 * Whether the source proves it holds every record of a table — only then is an
 * absent id a real deletion. A backup always does; a report export does only
 * when its counts.json pinned that table's own total record count at load
 * time: a form under its form name, a generated table (a subform child or a
 * lookup junction) under its own table name. A parent form's count never
 * covers a generated table — a separate <Form>__<Subform>.csv file can be
 * filtered while every form count still matches. Anything else cannot tell a
 * filtered export from deleted records.
 */
function exportCompleteFor(loaded: CsvLoad, table: string): boolean {
  if (loaded.sourceData?.some((item) => item.table === table && item.complete)) return true;
  if (loaded.countsFrom !== 'counts.json') return false;
  const expected = loaded.expected.find((item) => item.table === table);
  return expected !== undefined && (loaded.tables.find((item) => item.table === table)?.rows.length ?? 0) === expected.count;
}

function percent(value: number): string {
  return `${Number.isInteger(value) ? value : Math.round(value * 10) / 10}%`;
}

export interface DeletionRefusal {
  table: string;
  reason: string;
}

/**
 * Why --apply-deletes would refuse, one entry per table: the source does not
 * prove completeness for it, or the absent ids pass the mass-delete cap without
 * --allow-mass-delete. The cap is a share of the records the checkpoint
 * remembers (present + gone); a table the source has no rows for is `missing`
 * and is never refused here — it lists no deletions to begin with.
 */
export function deletionRefusals(
  loaded: CsvLoad,
  plan: DeltaPlan,
  opts: { allowMassDelete?: boolean; maxDeletePercent?: number } = {},
): DeletionRefusal[] {
  const cap = opts.maxDeletePercent ?? MAX_DELETE_PERCENT;
  const out: DeletionRefusal[] = [];
  for (const item of plan.tables) {
    if (item.missing || !item.deleted.length) continue;
    if (!exportCompleteFor(loaded, item.table)) {
      out.push({
        table: item.table,
        reason: loaded.generatedTables?.includes(item.table)
          ? `the source does not prove it holds every record of this table — deletions apply only from a full backup, or a report export whose counts.json holds this table's total record count (add "${item.table}": <total> to counts.json), never a filtered report's count`
          : 'the source does not prove it holds every record of this table — deletions apply only from a full backup or a report export whose counts.json holds the form\'s total record count, never a filtered report\'s count',
      });
      continue;
    }
    const remembered = item.deleted.length + item.changed.length + item.unchanged;
    const share = (item.deleted.length / remembered) * 100;
    if (!opts.allowMassDelete && share > cap) {
      out.push({
        table: item.table,
        reason: `${item.deleted.length} of ${remembered} remembered record(s) (${percent(share)}) is over the ${percent(cap)} limit — check the export is unfiltered or pass --allow-mass-delete`,
      });
    }
  }
  return out;
}

/** The checkpoint once the listed deletions are applied. */
export function withDeletionsApplied(next: DeltaCheckpoint, applied: Readonly<Record<string, readonly string[]>>): DeltaCheckpoint {
  const tables: Record<string, DeltaCheckpointTable> = {};
  for (const [name, entry] of Object.entries(next.tables)) {
    const done = new Set(applied[name] ?? []);
    const deleted = (entry.deleted ?? []).filter((id) => !done.has(id));
    if (!Object.keys(entry.rows).length && !deleted.length) continue;
    const keep = new Set([...Object.keys(entry.rows), ...deleted]);
    tables[name] = { rows: entry.rows, ...(deleted.length ? { deleted } : {}), ...storeEntry(entry.store ?? {}, keep) };
  }
  return { ...next, tables };
}

export function formatDeltaPlan(
  plan: DeltaPlan,
  opts: {
    source: string;
    applyDeletes: boolean;
    scope: string[];
    loaded: CsvLoad;
    confirm?: boolean;
    allowMassDelete?: boolean;
    maxDeletePercent?: number;
    /** How conflicts are resolved, as the flags give it. */
    resolution?: string;
  },
): string {
  const lines = [
    'c2c sync-delta plan v1',
    `source: ${opts.source}`,
    ...opts.scope,
    plan.baseline ? 'checkpoint: none (first run: every record is new; existing rows are matched by source id)' : `checkpoint: since ${plan.since ?? '(no Modified_Time)'}`,
    '',
    'tables:',
  ];
  for (const table of plan.tables) {
    if (table.missing) {
      lines.push(`- ${table.table} missing from the source; deletions not computed`);
      continue;
    }
    const extra = table.changedWithoutNewerTime ? ` (${table.changedWithoutNewerTime} without a newer Modified_Time)` : '';
    lines.push(`- ${table.table} new ${table.added.length} changed ${table.changed.length}${extra} unchanged ${table.unchanged} deleted ${table.deleted.length}`);
    if (table.deleted.length) lines.push(`  delete ids: ${table.deleted.join(', ')}`);
  }
  const totals = deltaTotals(plan);
  lines.push('', `upserts: ${totals.upserts}`, `deletions: ${totals.deleted} ${opts.applyDeletes ? '(applied with --apply-deletes)' : '(reported only; pass --apply-deletes to delete them)'}`);
  for (const refusal of deletionRefusals(opts.loaded, plan, opts)) {
    lines.push(`  ${refusal.table}: ${refusal.reason}`);
  }
  const check = conflictCheckCounts(plan, opts.applyDeletes);
  lines.push(
    `conflict check: ${check.checked} changed${opts.applyDeletes ? ' or deleted' : ''} record(s) compared with the store before writes${check.added ? `; ${check.added} new record(s) checked for a row already stored` : ''}${check.unchecked ? `; ${check.unchecked} have no store fingerprint (synced before conflict checks) and are not checked` : ''}`,
    `conflict resolution: ${opts.resolution ?? 'none (any conflict refuses --confirm)'}`,
  );
  if (plan.next.since) lines.push(`next checkpoint: since ${plan.next.since}`);
  lines.push(opts.confirm ? `writes: yes (${totals.upserts} planned upserts)` : 'writes: no', '');
  return `${lines.join('\n')}\n`;
}

/**
 * Changed (and, with deletes, deleted) records the conflict check compares with the store, and those it cannot;
 * after the first run, new records it looks up in the store as well.
 */
export function conflictCheckCounts(plan: DeltaPlan, applyDeletes: boolean): { checked: number; unchecked: number; added: number } {
  let checked = 0;
  let unchecked = 0;
  let added = 0;
  for (const table of plan.tables) {
    if (!plan.baseline) added += table.added.length;
    const ids = [...table.changed.map((row) => row.id), ...(applyDeletes && !table.missing ? table.deleted : [])];
    for (const id of ids) {
      if (table.store[id] === undefined) unchecked += 1;
      else checked += 1;
    }
  }
  return { checked, unchecked, added };
}

export function deltaTotals(plan: DeltaPlan): { added: number; changed: number; upserts: number; deleted: number } {
  const added = plan.tables.reduce((sum, table) => sum + table.added.length, 0);
  const changed = plan.tables.reduce((sum, table) => sum + table.changed.length, 0);
  const deleted = plan.tables.reduce((sum, table) => sum + table.deleted.length, 0);
  return { added, changed, upserts: added + changed, deleted };
}

export interface DeltaApplyTable {
  table: string;
  inserted: number;
  updated: number;
  /** Upserts whose stored values already matched. */
  same: number;
  deleted: number;
  /** Conflicts resolved for the new app value: the stored row was left as it is. */
  kept: number;
  refused: { sourceId: string; column: string; rule: string }[];
}

export interface DeltaApplyResult {
  ok: boolean;
  tables: DeltaApplyTable[];
  /** Ids actually deleted, per table. */
  appliedDeletes: Record<string, string[]>;
  /** Records changed on both sides, with the resolution each one got. */
  conflicts: DeltaConflict[];
  /** Changed or deleted records the checkpoint holds no store fingerprint for: not checked for conflicts. */
  unchecked: number;
  /** Store fingerprints read back after the writes, per table; record them with withStoreFingerprints. */
  store: Record<string, Record<string, string>>;
  error?: string;
}

interface StoreOpts {
  dc: string;
  catalystBase: string;
  fetch: FetchLike;
  scope: CatalystScope;
}

interface ForeignKeyRef {
  table: string;
  column: string;
  parent: string;
}

/** The cells one source row writes: lookups as the parent's ROWID, cyclic lookups left for a second pass. */
function rowCells(
  table: string,
  row: SeedRow,
  keys: readonly ForeignKeyRef[],
  deferred: ReadonlySet<string>,
  rowIds: ReadonlyMap<string, ReadonlyMap<string, string>>,
): { cells: Record<string, unknown>; cyclic: { column: string; parent: string; parentSource: string }[] } {
  const cells: Record<string, unknown> = {};
  const cyclic: { column: string; parent: string; parentSource: string }[] = [];
  for (const [column, value] of Object.entries(row.columns)) {
    if (value === '') continue;
    const key = keys.find((entry) => entry.column === column);
    if (!key) {
      cells[column] = value;
      continue;
    }
    if (deferred.has(foreignKeyId(key))) {
      cyclic.push({ column, parent: key.parent, parentSource: value });
      continue;
    }
    const parentRowId = rowIds.get(key.parent)?.get(value);
    if (!parentRowId) throw new Error(`lookup ${table}.${column} row ${row.id} source id ${value} is not in ${key.parent}`);
    cells[column] = parentRowId;
  }
  return { cells, cyclic };
}

/** The update body for a stored row: the prepared cells, plus NULL for every exported column the record left empty. */
function updateBody(schemaTable: SchemaTable, prepared: Record<string, unknown>, existing: Record<string, unknown>, covered: ReadonlySet<string> | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = { ...prepared };
  for (const column of covered ?? []) {
    if (column in body || UNFINGERPRINTED.has(column) || isShadow(schemaTable, column)) continue;
    const now = existing[column];
    if (now !== undefined && now !== null && now !== '') body[column] = null;
  }
  return body;
}

/**
 * Conflicts in the plan, read from the store before anything is written: a
 * changed or deleted record whose stored row no longer matches the store
 * fingerprint of the last apply. After the first run, a new record whose
 * source id the store already holds is one too: the checkpoint never saw that
 * row, so it cannot vouch that the new app left it alone. A record whose stored
 * values already equal the Creator values is not a conflict.
 */
async function findConflicts(
  opts: StoreOpts & { app: App; loaded: CsvLoad; plan: DeltaPlan; applyDeletes: boolean },
  ctx: { byName: ReadonlyMap<string, SchemaTable>; deferred: ReadonlySet<string>; rowIds: Map<string, Map<string, string>>; covered: ReadonlyMap<string, Set<string>> },
): Promise<{ conflicts: DeltaConflict[]; unchecked: number }> {
  const conflicts: DeltaConflict[] = [];
  let unchecked = 0;
  for (const item of opts.plan.tables) {
    const deletes = opts.applyDeletes && !item.missing ? item.deleted : [];
    const ids = [...item.changed.map((row) => row.id), ...deletes];
    const checked = ids.filter((id) => item.store[id] !== undefined);
    unchecked += ids.length - checked.length;
    // The first run adopts stored rows by source id; later runs never update a "new" record in place unchecked.
    const added = opts.plan.baseline ? [] : item.added;
    if (!checked.length && !added.length) continue;
    const stored = await storedRows(opts, item.table, [...checked, ...added.map((row) => row.id)]);
    const schemaTable = ctx.byName.get(item.table);
    const columns: IntegrityColumn[] = schemaTable ? integrityColumns(schemaTable, deferredColumns(item.table, ctx.deferred), 'store') : [];
    const keys = opts.loaded.foreignKeys.filter((key) => key.table === item.table);
    /** User fields where the Creator record and the stored row differ, each with a short hash of both values. */
    const differingFields = async (row: SeedRow, existing: Record<string, unknown>, schemaTable: SchemaTable): Promise<DeltaConflict['fields']> => {
      for (const key of keys) {
        const value = row.columns[key.column];
        if (value && !ctx.deferred.has(foreignKeyId(key))) await rememberRowIds(opts, key.parent, [value], ctx.rowIds);
      }
      let cells: Record<string, unknown>;
      try {
        cells = rowCells(item.table, row, keys.filter((key) => !ctx.deferred.has(foreignKeyId(key))), new Set(), ctx.rowIds).cells;
      } catch {
        // A lookup the store cannot resolve yet: compare the plain cells only.
        cells = Object.fromEntries(Object.entries(row.columns).filter(([column, value]) => value !== '' && !keys.some((key) => key.column === column)));
      }
      const body = updateBody(schemaTable, prepareColumns(columns, cells).cells, existing, ctx.covered.get(item.table));
      // System fields and shadows follow the fields they belong to; only user fields can conflict.
      return changedColumns(body, existing, columns)
        .filter((column) => !UNFINGERPRINTED.has(column) && !isShadow(schemaTable, column))
        .sort()
        .map((column) => ({ column, creator: valueHash(item.table, column, body[column]), catalyst: valueHash(item.table, column, existing[column]) }));
    };
    for (const row of added) {
      const existing = stored.get(row.id);
      if (!existing) continue;
      const fields = schemaTable ? await differingFields(row, existing.row, schemaTable) : [];
      if (schemaTable && !fields.length) continue;
      conflicts.push({ table: item.table, sourceId: row.id, rowid: existing.rowid, kind: 'added-but-exists', fields });
    }
    for (const row of item.changed) {
      const before = item.store[row.id];
      if (before === undefined) continue;
      const existing = stored.get(row.id);
      if (!existing) {
        conflicts.push({ table: item.table, sourceId: row.id, rowid: '', kind: 'deleted-in-catalyst', fields: [] });
        continue;
      }
      if (storeFingerprint(existing.row) === before || !schemaTable) continue;
      const fields = await differingFields(row, existing.row, schemaTable);
      if (!fields.length) continue;
      conflicts.push({ table: item.table, sourceId: row.id, rowid: existing.rowid, kind: 'changed', fields });
    }
    for (const id of deletes) {
      const before = item.store[id];
      const existing = stored.get(id);
      if (before === undefined || !existing || storeFingerprint(existing.row) === before) continue;
      conflicts.push({ table: item.table, sourceId: id, rowid: existing.rowid, kind: 'deleted-in-creator', fields: [] });
    }
  }
  return { conflicts, unchecked };
}

export async function applyDelta(
  opts: StoreOpts & {
    app: App;
    loaded: CsvLoad;
    plan: DeltaPlan;
    applyDeletes: boolean;
    /** Lift the per-table mass-delete cap; the completeness proof still applies. */
    allowMassDelete?: boolean;
    /** Cap on deletions as a share of a table's remembered records; default MAX_DELETE_PERCENT. */
    maxDeletePercent?: number;
    /** Which side wins each conflict. Without one, any conflict refuses the apply. */
    resolve?: ConflictResolver;
  },
): Promise<DeltaApplyResult> {
  if (!opts.scope?.org || !opts.scope.projectId || !opts.scope.token) throw new Error('sync-delta requires the guarded org, project, and token');
  const schema = generateSchema(opts.app);
  const byName = new Map(schema.tables.map((table) => [table.name, table]));
  const deferred = cyclicForeignKeys(
    opts.loaded.tables.map((table) => table.table),
    opts.loaded.foreignKeys,
  );
  const rowIds = new Map<string, Map<string, string>>();
  const results: DeltaApplyTable[] = [];
  const pendingCyclic: { table: string; sourceId: string; column: string; parent: string; parentSource: string }[] = [];
  const covered = coveredColumns(opts.loaded);
  let conflicts: DeltaConflict[] = [];
  let unchecked = 0;
  const store: Record<string, Record<string, string>> = {};
  try {
    // Refuse before any write: a filtered export must not turn absent ids into
    // deletes, and a mass deletion needs its own flag.
    if (opts.applyDeletes) {
      const refusals = deletionRefusals(opts.loaded, opts.plan, opts);
      if (refusals.length) {
        throw new Error(`--apply-deletes refused: ${refusals.map((item) => `${item.table}: ${item.reason}`).join('; ')}`);
      }
    }
    // Refuse before any write: a record edited on both sides is never overwritten silently.
    ({ conflicts, unchecked } = await findConflicts(opts, { byName, deferred, rowIds, covered }));
    for (const conflict of conflicts) {
      const side = opts.resolve?.(conflict.table, conflict.sourceId);
      if (side) conflict.resolution = side;
    }
    const open = conflicts.filter((conflict) => !conflict.resolution);
    if (open.length) {
      throw new Error(`${open.length} conflict(s): record(s) changed in Creator and in the new app since the last sync, or new in Creator but already stored; resolve each with --prefer creator|catalyst (or <Table>=creator|catalyst) or --conflicts <file>`);
    }
    const kept = new Map<string, Set<string>>();
    for (const conflict of conflicts) {
      if (conflict.resolution !== 'catalyst') continue;
      const set = kept.get(conflict.table) ?? new Set<string>();
      set.add(conflict.sourceId);
      kept.set(conflict.table, set);
    }
    const written = new Map<string, Set<string>>();
    for (const item of opts.plan.tables) {
      const keep = kept.get(item.table) ?? new Set<string>();
      const result: DeltaApplyTable = { table: item.table, inserted: 0, updated: 0, same: 0, deleted: 0, kept: 0, refused: [] };
      results.push(result);
      result.kept = [...item.added, ...item.changed].filter((row) => keep.has(row.id)).length;
      const upserts = [...item.added, ...item.changed].filter((row) => !keep.has(row.id));
      written.set(item.table, new Set([...upserts.map((row) => row.id), ...keep]));
      if (!upserts.length) continue;
      const schemaTable = byName.get(item.table);
      if (!schemaTable) throw new Error(`table ${item.table} is not in the schema`);
      const columns = integrityColumns(schemaTable, deferredColumns(item.table, deferred), 'store');
      const keys = opts.loaded.foreignKeys.filter((key) => key.table === item.table);
      for (const key of keys) {
        const wanted = upserts.map((row) => row.columns[key.column]).filter((value): value is string => Boolean(value));
        await rememberRowIds(opts, key.parent, wanted, rowIds);
      }
      const stored = await storedRows(opts, item.table, upserts.map((row) => row.id));
      const inserts: Record<string, unknown>[] = [];
      const updates: Record<string, unknown>[] = [];
      for (const row of upserts) {
        const { cells, cyclic } = rowCells(item.table, row, keys, deferred, rowIds);
        for (const entry of cyclic) pendingCyclic.push({ table: item.table, sourceId: row.id, ...entry });
        const prepared = prepareColumns(columns, cells);
        if (prepared.refusals.length) {
          for (const refusal of prepared.refusals) result.refused.push({ sourceId: row.id, column: refusal.column, rule: refusal.rule });
          continue;
        }
        const existing = stored.get(row.id);
        if (!existing) {
          inserts.push({ ...prepared.cells, [SOURCE_ID_COLUMN]: row.id });
          continue;
        }
        const body = updateBody(schemaTable, prepared.cells, existing.row, covered.get(item.table));
        if (!changedColumns(body, existing.row, columns).length) {
          result.same += 1;
          continue;
        }
        updates.push({ ROWID: existing.rowid, ...body });
      }
      if (result.refused.length) throw new Error(`${item.table}: ${result.refused.length} cell(s) refused by the write rules`);
      const known = rowIds.get(item.table) ?? new Map<string, string>();
      for (const [source, entry] of stored) known.set(source, entry.rowid);
      for (let i = 0; i < inserts.length; i += MAX_BATCH) {
        const slice = inserts.slice(i, i + MAX_BATCH);
        const body = await send(opts, 'POST', rowUrl(opts, item.table), slice, item.table);
        for (const pair of storedPairs(body)) known.set(pair.source, pair.rowid);
        result.inserted += slice.length;
      }
      for (let i = 0; i < updates.length; i += MAX_BATCH) {
        const slice = updates.slice(i, i + MAX_BATCH);
        await send(opts, 'PUT', rowUrl(opts, item.table), slice, item.table);
        result.updated += slice.length;
      }
      rowIds.set(item.table, known);
    }
    const cyclicUpdates = new Map<string, Record<string, unknown>[]>();
    for (const pending of pendingCyclic) {
      const { sourceId, parentSource } = pending;
      await rememberRowIds(opts, pending.parent, [parentSource], rowIds);
      await rememberRowIds(opts, pending.table, [sourceId], rowIds);
      const parentRowId = rowIds.get(pending.parent)?.get(parentSource);
      const rowid = rowIds.get(pending.table)?.get(sourceId);
      if (!parentRowId) throw new Error(`lookup ${pending.table}.${pending.column} row ${sourceId} source id ${parentSource} is not in ${pending.parent}`);
      if (!rowid) throw new Error(`lookup ${pending.table}.${pending.column} row ${sourceId} has no ROWID`);
      const list = cyclicUpdates.get(pending.table) ?? [];
      list.push({ ROWID: rowid, [pending.column]: parentRowId });
      cyclicUpdates.set(pending.table, list);
    }
    for (const [table, list] of cyclicUpdates) {
      for (let i = 0; i < list.length; i += MAX_BATCH) await send(opts, 'PUT', rowUrl(opts, table), list.slice(i, i + MAX_BATCH), table);
    }
    const appliedDeletes: Record<string, string[]> = {};
    if (opts.applyDeletes) {
      for (const item of [...opts.plan.tables].reverse()) {
        if (item.missing || !item.deleted.length) continue;
        const keep = kept.get(item.table) ?? new Set<string>();
        const ids = item.deleted.filter((id) => !keep.has(id));
        const stored = await storedRows(opts, item.table, ids);
        const result = results.find((entry) => entry.table === item.table);
        for (const id of ids) {
          const entry = stored.get(id);
          if (!entry) continue;
          await send(opts, 'DELETE', `${rowUrl(opts, item.table)}/${encodeURIComponent(entry.rowid)}`, undefined, item.table);
          if (result) result.deleted += 1;
        }
        if (result) result.kept += item.deleted.length - ids.length;
        // An id already gone from the store needs no delete; either way it leaves the checkpoint.
        // A deletion kept for the new app stays pending.
        appliedDeletes[item.table] = ids;
        const set = written.get(item.table) ?? new Set<string>();
        for (const id of keep) set.add(id);
        written.set(item.table, set);
      }
    }
    // Read every written or kept row back: its fingerprint is what the next run's conflict check compares with.
    for (const [table, ids] of written) {
      if (!ids.size) continue;
      const prints: Record<string, string> = {};
      for (const [id, entry] of await storedRows(opts, table, [...ids])) prints[id] = storeFingerprint(entry.row);
      if (Object.keys(prints).length) store[table] = prints;
    }
    return { ok: true, tables: results, appliedDeletes, conflicts, unchecked, store };
  } catch (error) {
    return { ok: false, tables: results, appliedDeletes: {}, conflicts, unchecked, store: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

function isShadow(table: SchemaTable, column: string): boolean {
  return table.columns.some((item) => item.name === column && item.shadowFor !== undefined);
}

/** Columns each table's export carries; only those are cleared when a changed record left them empty. */
function coveredColumns(loaded: CsvLoad): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const note of loaded.columns) {
    const set = out.get(note.table) ?? new Set<string>();
    for (const item of note.mapped) set.add(item.column);
    out.set(note.table, set);
  }
  return out;
}

function rowUrl(opts: StoreOpts, table: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`table name is not a ZCQL identifier: ${table}`);
  const root = opts.catalystBase.replace(/\/$/, '');
  return `${root}/baas/v1/project/${encodeURIComponent(opts.scope.projectId)}/table/${encodeURIComponent(table)}/row`;
}

async function send(opts: StoreOpts, method: string, url: string, body: unknown, table: string): Promise<unknown> {
  assertAllowedHost(url, opts.dc);
  const response = await opts.fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...catalystAuthHeaders(opts.scope) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`catalyst ${method} failed: ${response.status}${catalystErrorDetail(text)} (table ${table})`);
  return text.trim() ? parseJsonExact(text) : undefined;
}

/** Run one ZCQL statement against the guarded project. */
export async function zcql(opts: StoreOpts, sql: string): Promise<Record<string, unknown>[]> {
  const url = catalystQueryUrl(opts.catalystBase, opts.scope);
  const body = await send(opts, 'POST', url, { query: sql }, /FROM\s+(\w+)/i.exec(sql)?.[1] ?? '');
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  return data.map((entry) => unwrapRow(entry, sql));
}

/** ZCQL answers `[{ Table: { col: value } }]`; a flat row is accepted too. */
function unwrapRow(entry: unknown, sql: string): Record<string, unknown> {
  if (!entry || typeof entry !== 'object') return {};
  const record = entry as Record<string, unknown>;
  const table = /FROM\s+(\w+)/i.exec(sql)?.[1];
  const inner = table ? record[table] : undefined;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
  const values = Object.values(record);
  if (values.length === 1 && values[0] && typeof values[0] === 'object' && !Array.isArray(values[0])) return values[0] as Record<string, unknown>;
  return record;
}

function inLists(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  const lists: string[] = [];
  for (let i = 0; i < unique.length; i += ZCQL_IN_LIMIT) {
    lists.push(unique.slice(i, i + ZCQL_IN_LIMIT).map((id) => `'${id.replace(/'/g, "''")}'`).join(', '));
  }
  return lists;
}

async function storedRows(opts: StoreOpts, table: string, ids: readonly string[]): Promise<Map<string, { rowid: string; row: Record<string, unknown> }>> {
  const found = new Map<string, { rowid: string; row: Record<string, unknown> }>();
  for (const list of inLists(ids)) {
    for (const row of await zcql(opts, `SELECT * FROM ${table} WHERE ${SOURCE_ID_COLUMN} IN (${list})`)) {
      const source = row[SOURCE_ID_COLUMN];
      const rowid = row.ROWID;
      if (source === undefined || source === null || rowid === undefined || rowid === null) continue;
      const id = exactId(source, SOURCE_ID_COLUMN);
      if (found.has(id)) throw new Error(`${table} stores source id ${id} more than once; resolve the duplicate before a delta sync`);
      found.set(id, { rowid: exactId(rowid, 'ROWID'), row });
    }
  }
  return found;
}

async function rememberRowIds(opts: StoreOpts, table: string, ids: readonly string[], rowIds: Map<string, Map<string, string>>): Promise<void> {
  const known = rowIds.get(table) ?? new Map<string, string>();
  const wanted = ids.filter((id) => !known.has(id));
  if (wanted.length) {
    for (const [source, entry] of await storedRows(opts, table, wanted)) known.set(source, entry.rowid);
  }
  rowIds.set(table, known);
}

function storedPairs(body: unknown): { source: string; rowid: string }[] {
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  const out: { source: string; rowid: string }[] = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    if (record[SOURCE_ID_COLUMN] === undefined || record.ROWID === undefined) continue;
    out.push({ source: exactId(record[SOURCE_ID_COLUMN], SOURCE_ID_COLUMN), rowid: exactId(record.ROWID, 'ROWID') });
  }
  return out;
}
