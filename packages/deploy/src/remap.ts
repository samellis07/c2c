/**
 * Lookup remap shared by the data loaders.
 *
 * Seed cells (like Creator CSV cells) carry the SOURCE id of the parent row.
 * Data Store rows must hold the parent ROWID instead, which only exists
 * after the parent table is written. Every loader therefore: writes tables
 * parents-first, resolves each lookup cell through the source-id → ROWID map
 * read back after each table lands, and defers self/cyclic lookups to a row
 * update once every side has a ROWID. Unknown references are refused before
 * any write.
 */
import type { App } from '../../core/src/ir.js';
import {
  assertAllowedHost,
  catalystAuthHeaders,
  catalystQueryUrl,
  MAX_BATCH,
  ZCQL_IN_LIMIT,
  type CatalystScope,
  type FetchLike,
} from '../../data/src/migrate.js';
import { generateSchema } from '../../schema/src/generator.js';
import { SOURCE_ID_COLUMN } from '../../schema/src/mapping.js';
import { exactId, parseJsonExact } from './json-exact.js';
import { cyclicForeignKeys, foreignKeyId } from './tables.js';

export interface SeedForeignKey {
  table: string;
  column: string;
  parent: string;
}

/** Structural seed table. `SeedTable` (seed.ts) and the CSV loader satisfy this. */
export interface RemapTable {
  table: string;
  rows: { id: string; columns: Record<string, string> }[];
}

/** Lookup columns of every Data Store table the app generates, for remap and ordering. */
export function foreignKeysForApp(app: App): SeedForeignKey[] {
  const out: SeedForeignKey[] = [];
  for (const table of generateSchema(app).tables) {
    for (const column of table.columns) {
      if (!column.relation || column.name === SOURCE_ID_COLUMN) continue;
      out.push({ table: table.name, column: column.name, parent: column.relation.table });
    }
  }
  return out;
}

/**
 * The source ids a lookup cell holds: a single id, or a JSON array of them
 * (a multi lookup stored as a plain column, the encoding convertCell writes).
 */
function sourceIds(value: string): string[] {
  if (!value.startsWith('[')) return [value];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [value];
    return parsed.map((item) => String(item));
  } catch {
    return [value];
  }
}

/**
 * Refuse unknown lookup references before any write. A cell that names a
 * parent table absent from the seed is left to the live ROWID read (the
 * parent may have landed in an earlier run); anything else must resolve
 * inside the seed.
 */
export function assertSeedReferences(tables: readonly RemapTable[], keys: readonly SeedForeignKey[]): void {
  const ids = new Map<string, Set<string>>();
  for (const table of tables) ids.set(table.table, new Set(table.rows.map((row) => row.id)));
  for (const key of keys) {
    const table = tables.find((item) => item.table === key.table);
    if (!table) continue;
    const parents = ids.get(key.parent);
    for (const row of table.rows) {
      const value = row.columns[key.column];
      if (!value) continue;
      for (const source of sourceIds(value)) {
        if (parents?.has(source)) continue;
        if (!parents) throw new Error(`lookup ${key.table}.${key.column} row ${row.id} references ${key.parent}, which is not in the seed`);
        throw new Error(`lookup ${key.table}.${key.column} row ${row.id} source id ${source} is not in ${key.parent}`);
      }
    }
  }
}

/** Refuse seed tables the schema does not generate, before any write. */
export function assertSeedTables(tables: readonly RemapTable[], known: readonly string[]): void {
  const names = new Set(known);
  for (const table of tables) {
    if (!names.has(table.table)) throw new Error(`seed table ${table.table} is not in the app schema`);
  }
}

/** Refuse seed columns the schema does not generate, before any write. */
export function assertSeedColumns(tables: readonly RemapTable[], columnsByTable: Readonly<Record<string, readonly { name: string }[]>>): void {
  for (const table of tables) {
    const known = columnsByTable[table.table];
    if (!known) continue;
    const allowed = new Set(known.map((col) => col.name));
    for (const row of table.rows) {
      for (const column of Object.keys(row.columns)) {
        if (!allowed.has(column)) throw new Error(`seed table ${table.table} column ${column} is not in the app schema`);
      }
    }
  }
}

/** Parents before children. Deferred (self/cyclic) edges do not order: those columns land via row update. `pin` keeps a store-mandatory edge in the order. */
export function orderTables(tables: readonly RemapTable[], keys: readonly SeedForeignKey[], pin?: ReadonlySet<string>): RemapTable[] {
  const byName = new Map(tables.map((table) => [table.table, table]));
  const deferred = cyclicForeignKeys(
    tables.map((table) => table.table),
    keys,
    pin,
  );
  const deps = new Map<string, Set<string>>(tables.map((table) => [table.table, new Set()]));
  for (const key of keys) {
    if (key.parent === key.table || !byName.has(key.parent) || !byName.has(key.table)) continue;
    if (deferred.has(foreignKeyId(key))) continue;
    deps.get(key.table)!.add(key.parent);
  }
  const ready = [...deps.entries()].filter(([, parents]) => parents.size === 0).map(([name]) => name).sort();
  const ordered: RemapTable[] = [];
  const placed = new Set<string>();
  while (ready.length) {
    const name = ready.shift()!;
    if (placed.has(name)) continue;
    placed.add(name);
    ordered.push(byName.get(name)!);
    for (const [other, parents] of deps) {
      if (!parents.delete(name) || parents.size !== 0) continue;
      ready.push(other);
      ready.sort();
    }
  }
  if (ordered.length !== tables.length) {
    const rest = tables.map((table) => table.table).filter((name) => !placed.has(name)).sort();
    for (const name of rest) ordered.push(byName.get(name)!);
  }
  return ordered;
}

/** Rewrite lookup source ids to the ROWIDs read back after the parent landed. */
export function resolveForeignKeys(table: RemapTable, keys: readonly SeedForeignKey[], rowIds: Map<string, Map<string, string>>): RemapTable {
  const mine = keys.filter((key) => key.table === table.table);
  if (!mine.length) return table;
  return {
    table: table.table,
    rows: table.rows.map((row) => {
      const columns = { ...row.columns };
      for (const key of mine) {
        const source = columns[key.column];
        if (!source) continue;
        const mapped = sourceIds(source).map((id) => {
          const rowid = rowIds.get(key.parent)?.get(id);
          if (!rowid) throw new Error(`lookup ${key.column} row ${row.id} source id ${id} is not in ${key.parent}`);
          return rowid;
        });
        columns[key.column] = source.startsWith('[') ? JSON.stringify(mapped) : mapped[0]!;
      }
      return { id: row.id, columns };
    }),
  };
}

export function omitColumns(table: RemapTable, columns: ReadonlySet<string>): RemapTable {
  if (columns.size === 0) return table;
  return {
    table: table.table,
    rows: table.rows.map((row) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(row.columns)) {
        if (columns.has(key)) {
          changed = true;
          continue;
        }
        next[key] = value;
      }
      return changed ? { id: row.id, columns: next } : row;
    }),
  };
}

export function deferredColumns(table: string, deferred: ReadonlySet<string>): Set<string> {
  const prefix = `${table}\0`;
  const columns = new Set<string>();
  for (const id of deferred) if (id.startsWith(prefix)) columns.add(id.slice(prefix.length));
  return columns;
}

function catalystUpdateUrl(base: string, table: string, scope: CatalystScope): string {
  const root = base.replace(/\/$/, '');
  return `${root}/baas/v1/project/${encodeURIComponent(scope.projectId)}/table/${encodeURIComponent(table)}/row`;
}

export async function query(fetch: FetchLike, base: string, dc: string, sql: string, scope: CatalystScope): Promise<unknown> {
  const url = catalystQueryUrl(base, scope);
  assertAllowedHost(url, dc);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...catalystAuthHeaders(scope) },
    body: JSON.stringify({ query: sql }),
  });
  if (response.status >= 400) throw new Error(`catalyst query failed: ${response.status}`);
  return parseJsonExact(await response.text());
}

function pairsFrom(body: unknown): { source: string; rowid: string }[] {
  const found: { source: string; rowid: string }[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    const source = record[SOURCE_ID_COLUMN];
    const rowid = record.ROWID ?? record.rowid;
    if ((typeof source === 'string' || typeof source === 'number') && (typeof rowid === 'string' || typeof rowid === 'number')) {
      found.push({ source: exactId(source, SOURCE_ID_COLUMN), rowid: exactId(rowid, 'ROWID') });
    }
    for (const child of Object.values(record)) if (child && typeof child === 'object') visit(child);
  };
  visit(body);
  const unique = new Map<string, string>();
  for (const pair of found) unique.set(pair.source, pair.rowid);
  return [...unique.entries()].map(([source, rowid]) => ({ source, rowid }));
}

/** Source id → ROWID for the rows just written, read back from the store. */
export async function loadRowIds(
  fetch: FetchLike,
  base: string,
  dc: string,
  table: string,
  ids: readonly string[],
  scope: CatalystScope,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let i = 0; i < ids.length; i += ZCQL_IN_LIMIT) {
    const slice = ids.slice(i, i + ZCQL_IN_LIMIT);
    if (!slice.length) continue;
    const list = slice.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
    const body = await query(fetch, base, dc, `SELECT ROWID, ${SOURCE_ID_COLUMN} FROM ${table} WHERE ${SOURCE_ID_COLUMN} IN (${list})`, scope);
    for (const pair of pairsFrom(body)) found.set(pair.source, pair.rowid);
  }
  return found;
}

export function countFrom(body: unknown): number | undefined {
  let found: number | undefined;
  const visit = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) visit(child, childKey);
      return;
    }
    if (key && /^count/i.test(key) && (typeof value === 'number' || (typeof value === 'string' && value !== ''))) {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (Number.isInteger(parsed) && parsed >= 0) found = parsed;
    }
  };
  visit(body);
  return found;
}

/** Outcome of the deferred lookup updates for one table. Counts and ROWID ranges only, never cell values. */
export interface DeferredUpdateReport {
  table: string;
  /** The deferred lookup columns of the table. */
  columns: string[];
  /** Rows whose deferred lookup columns needed an update. */
  rows: number;
  updated: number;
  notUpdated: number;
  /** ROWID ranges (first..last, in ROWID order) of the rows updated and not updated. */
  updatedRanges: string[];
  notUpdatedRanges: string[];
  /** Why rows were not updated; absent when every row landed. */
  error?: string;
}

/** Numeric ROWID order (digit strings of any length); any other id sorts after, as text. */
function compareRowIds(a: string, b: string): number {
  const da = /^\d+$/.test(a);
  const db = /^\d+$/.test(b);
  if (da !== db) return da ? -1 : 1;
  if (da && a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Collapse adjacent batches that share an outcome into first..last ROWID ranges. */
function rangesOf(batches: readonly { ids: readonly string[]; ok: boolean }[], ok: boolean): string[] {
  const ranges: string[] = [];
  let first: string | undefined;
  let last: string | undefined;
  for (const batch of [...batches, { ids: [], ok: !ok }]) {
    if (batch.ok === ok) {
      if (!batch.ids.length) continue;
      first ??= batch.ids[0];
      last = batch.ids.at(-1);
      continue;
    }
    if (first !== undefined) ranges.push(first === last ? first : `${first}..${last}`);
    first = undefined;
  }
  return ranges;
}

/** One report line: the counts, the ROWID ranges, and how to finish. */
export function formatDeferredUpdate(report: DeferredUpdateReport): string {
  const updated = report.updatedRanges.length ? ` (ROWID ${report.updatedRanges.join(', ')})` : '';
  const missing = report.notUpdatedRanges.length ? ` (ROWID ${report.notUpdatedRanges.join(', ')})` : '';
  return `deferred lookup update (${report.columns.join(', ')}): ${report.updated} of ${report.rows} row(s) updated${updated}; ${report.notUpdated} not updated${missing}: ${report.error ?? 'unknown error'}; re-run the load to finish them (row updates only, nothing is inserted again)`;
}

/**
 * Set the deferred (self/cyclic) lookup columns with row updates, now that
 * every side has a ROWID. Updates never insert, so source and destination
 * counts stay equal, and a re-run repeats the same updates: rows a failed
 * batch left unset are finished by the next run. Never throws for a table's
 * own failure: each table's report names the rows updated and not updated.
 * A table that did not load, or whose deferred lookup points at one, is
 * skipped and reported; every other table is still updated.
 */
export async function updateDeferredForeignKeys(
  opts: { dc: string; catalystBase: string; fetch: FetchLike; scope: CatalystScope },
  tables: readonly RemapTable[],
  foreignKeys: readonly SeedForeignKey[],
  deferred: ReadonlySet<string>,
  rowIds: ReadonlyMap<string, ReadonlyMap<string, string>>,
  notLoaded: ReadonlySet<string> = new Set(),
): Promise<DeferredUpdateReport[]> {
  const byTable = new Map<string, { columns: string[]; bodies: Map<string, Record<string, string>>; pending: Set<string>; unresolved?: string }>();
  for (const key of foreignKeys) {
    if (!deferred.has(foreignKeyId(key))) continue;
    const table = tables.find((item) => item.table === key.table);
    if (!table) continue;
    const entry = byTable.get(key.table) ?? { columns: [], bodies: new Map<string, Record<string, string>>(), pending: new Set<string>() };
    byTable.set(key.table, entry);
    if (!entry.columns.includes(key.column)) entry.columns.push(key.column);
    // The rows (or the parent rows) are not all in the store: no update can
    // resolve, so the table is skipped and reported instead of half-updated.
    const skipped = notLoaded.has(key.table)
      ? `skipped: ${key.table} not loaded`
      : notLoaded.has(key.parent)
        ? `skipped: parent ${key.parent} not loaded (lookup ${key.column})`
        : undefined;
    for (const row of table.rows) {
      const source = row.columns[key.column];
      if (!source) continue;
      entry.pending.add(row.id);
      if (skipped) {
        entry.unresolved ??= skipped;
        const rowid = rowIds.get(key.table)?.get(row.id);
        if (rowid) entry.bodies.set(rowid, entry.bodies.get(rowid) ?? { ROWID: rowid });
        continue;
      }
      const ids = sourceIds(source);
      const mapped = ids.map((id) => rowIds.get(key.parent)?.get(id));
      const missing = ids.find((_, index) => !mapped[index]);
      const rowid = rowIds.get(key.table)?.get(row.id);
      if (missing !== undefined || !rowid) {
        entry.unresolved ??= missing !== undefined
          ? `lookup ${key.column} row ${row.id} source id ${missing} is not in ${key.parent}`
          : `lookup ${key.column} row ${row.id} has no ROWID in ${key.table}`;
        if (rowid) entry.bodies.set(rowid, entry.bodies.get(rowid) ?? { ROWID: rowid });
        continue;
      }
      const body = entry.bodies.get(rowid) ?? { ROWID: rowid };
      body[key.column] = source.startsWith('[') ? JSON.stringify(mapped) : mapped[0]!;
      entry.bodies.set(rowid, body);
    }
  }
  const reports: DeferredUpdateReport[] = [];
  for (const [table, entry] of byTable) {
    if (!entry.pending.size) continue;
    const ids = [...entry.bodies.keys()].sort(compareRowIds);
    // A row that cannot resolve leaves the whole table un-updated: a partial
    // remap would point some rows at their parent and leave others unset.
    if (entry.unresolved) {
      reports.push({
        table,
        columns: entry.columns,
        rows: entry.pending.size,
        updated: 0,
        notUpdated: entry.pending.size,
        updatedRanges: [],
        notUpdatedRanges: rangesOf([{ ids, ok: false }], false),
        error: entry.unresolved,
      });
      continue;
    }
    const batches: { ids: string[]; ok: boolean }[] = [];
    let error: string | undefined;
    const url = catalystUpdateUrl(opts.catalystBase, table, opts.scope);
    assertAllowedHost(url, opts.dc);
    for (let i = 0; i < ids.length; i += MAX_BATCH) {
      const slice = ids.slice(i, i + MAX_BATCH);
      let status: number;
      try {
        const response = await opts.fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...catalystAuthHeaders(opts.scope) },
          body: JSON.stringify(slice.map((id) => entry.bodies.get(id)!)),
        });
        status = response.status;
        await response.text();
      } catch (caught) {
        error ??= `catalyst row update failed: ${caught instanceof Error ? caught.message : String(caught)}`;
        batches.push({ ids: slice, ok: false });
        continue;
      }
      if (status >= 400) error ??= `catalyst row update failed: ${status}`;
      batches.push({ ids: slice, ok: status < 400 });
    }
    const updated = batches.filter((batch) => batch.ok).reduce((sum, batch) => sum + batch.ids.length, 0);
    reports.push({
      table,
      columns: entry.columns,
      rows: ids.length,
      updated,
      notUpdated: ids.length - updated,
      updatedRanges: rangesOf(batches, true),
      notUpdatedRanges: rangesOf(batches, false),
      ...(error ? { error } : {}),
    });
  }
  return reports;
}
