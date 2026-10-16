/**
 * Live migrate from a seed file. The Creator API is not called.
 * Writes go through the existing mover (c2c_source_id reconcile) and only when dryRun is false.
 *
 * One documented seed schema (`docs/seed-schema.md`): `{ Form: [{ c2c_source_id, ...scalars }] }`
 * with stable source ids; lookup cells hold the parent source id and are remapped to the
 * created ROWIDs with the same code the CSV data loader uses (remap.ts). Accepted inputs:
 * - the canonical `{ Form: [rows] }` map (what `c2c seed` writes as `seed.json`),
 * - the legacy `{ version: 1, tables: [{ table, rows }] }` shape (unchanged behaviour),
 * - a synthetic `seed.json` (`{ app_name, forms }` with `$ref` / `$today` / `$now` /
 *   `$user:login`, grids and multi-lookups), converted in code, never by editing fixtures.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeedCompositeMap } from '../../data/src/seed.js';
import type { ObjectSink } from '../../data/src/files.js';
import { uploadObjectKey } from '../../shims/src/files.js';
import { normalizeType } from '../../schema/src/mapping.js';
import { STRATUS_KEY_TYPES, type SchemaPlan } from '../../schema/src/generator.js';
import { creatorBaseFor } from './dc.js';
import { confirmGuardLines, planScopeLines } from './guards.js';
import {
  convertSyntheticSeed,
  type CanonicalSeedFile,
  type SyntheticConvertOptions,
} from '../../data/src/seed-synthetic.js';
import { SEED_BLOCKED_KEY } from '../../data/src/seed.js';
import {
  emptyCheckpoint,
  migrateData,
  type CatalystScope,
  type Checkpoint,
  type FetchLike,
  type MigrateResponse,
  type MigrateResult,
} from '../../data/src/migrate.js';
import {
  assertSeedReferences,
  assertSeedColumns,
  assertSeedTables,
  deferredColumns,
  loadRowIds,
  omitColumns,
  orderTables,
  resolveForeignKeys,
  updateDeferredForeignKeys,
  type SeedForeignKey,
} from './remap.js';
import { cyclicForeignKeys, foreignKeyId } from './tables.js';
import {
  duplicateUniqueRefusals,
  emptyIntegrity,
  groupRefusals,
  mandatoryMissingRefusals,
  cellRuleRefusals,
  overLengthRefusals,
  mergeIntegrity,
  type IntegrityColumn,
} from '../../data/src/integrity.js';

export type { SeedForeignKey };
export type ParseSeedOptions = SyntheticConvertOptions;

export interface SeedRow {
  id: string;
  columns: Record<string, string>;
}

export interface SeedTable {
  table: string;
  rows: SeedRow[];
}

/**
 * Seed rows name a column by its Creator field name. A field whose name is a
 * reserved column name is stored under another column (`renames`: table →
 * { field: column }); its cells move to that column. A row that carries both
 * names is refused rather than guessed.
 */
const ADDRESS_PART_TOKENS = new Set(['address line 1', 'address line 2', 'district city', 'state province', 'postal code', 'country', 'latitude', 'longitude']);

function isAddressParts(parts: readonly string[]): boolean {
  return parts.some((part) => ADDRESS_PART_TOKENS.has(normalizeType(part)));
}

/** Split one composite cell into part values. Empty parts are omitted. */
function splitCompositeCell(parts: readonly string[], text: string): Record<string, string> {
  const trimmed = text.trim();
  if (!trimmed || parts.length === 0) return {};
  if (isAddressParts(parts)) {
    const bits = trimmed.split(',').map((item) => item.trim());
    const out: Record<string, string> = {};
    parts.forEach((name, index) => {
      const value = index < parts.length - 1 ? (bits[index] ?? '') : bits.slice(index).join(', ');
      if (value.trim()) out[name] = value.trim();
    });
    return out;
  }
  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
  const out: Record<string, string> = {};
  if (tokens.length === 1 && parts.includes('first_name')) out.first_name = tokens[0]!;
  else if (tokens.length >= 2) {
    if (parts.includes('first_name')) out.first_name = tokens[0]!;
    if (parts.includes('last_name')) out.last_name = tokens.slice(1).join(' ');
  }
  if (Object.keys(out).length === 0) out[parts[0]!] = trimmed;
  return out;
}

/**
 * Move reserved-name cells onto their store columns, and split a name or address
 * cell that still uses the Creator field name into one cell per part column.
 */
export function seedStoreColumns(
  tables: readonly SeedTable[],
  renames: Readonly<Record<string, Readonly<Record<string, string>>>>,
  composites?: SeedCompositeMap,
): SeedTable[] {
  return tables.map((table) => {
    const map = Object.hasOwn(renames, table.table) ? renames[table.table]! : undefined;
    const partsOf = composites && Object.hasOwn(composites, table.table) ? composites[table.table]! : undefined;
    if (!map && !partsOf) return table;
    const rows = table.rows.map((row) => {
      const columns: Record<string, string> = {};
      const put = (column: string, value: string, from: string) => {
        if (Object.hasOwn(columns, column)) throw new Error(`seed ${table.table} row ${row.id} sets ${column} twice (as ${from} and ${column})`);
        columns[column] = value;
      };
      for (const [key, value] of Object.entries(row.columns)) {
        const parts = partsOf && Object.hasOwn(partsOf, key) ? partsOf[key]! : undefined;
        if (parts) {
          const split = splitCompositeCell(parts.map((part) => part.part), value);
          for (const part of parts) {
            const cell = split[part.part];
            if (!cell) continue;
            const column = map && Object.hasOwn(map, part.column) ? map[part.column]! : part.column;
            put(column, cell, key);
          }
          continue;
        }
        const column = map && Object.hasOwn(map, key) ? map[key]! : key;
        put(column, value, key);
      }
      return { ...row, columns };
    });
    return { ...table, rows };
  });
}

const SEED_OWNER = 'c2c';
const SEED_APP = 'seed';

export function parseSeed(text: string, opts?: ParseSeedOptions): SeedTable[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('seed file is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('seed file is not an object');
  const record = parsed as Record<string, unknown>;
  if (record.version !== undefined || record.tables !== undefined) return parseLegacySeed(record);
  if (record.forms !== undefined) return tablesFromCanonical(convertSyntheticSeed(record, opts));
  seedBlockedRecords(record);
  return tablesFromCanonical(parseCanonicalForms(record));
}

/** One blocked-table record a seed file carries (`docs/seed-schema.md`). */
export interface SeedBlocked {
  form: string;
  field?: string;
  reason: string;
}

/**
 * The `c2c_blocked` records in a canonical seed file, validated. Other seed
 * shapes never carry it. An entry that does not name its form and reason
 * fails closed — a malformed record must not quietly turn into a table.
 */
export function parseSeedBlocked(text: string): SeedBlocked[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('seed file is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('seed file is not an object');
  const record = parsed as Record<string, unknown>;
  if (record.version !== undefined || record.tables !== undefined || record.forms !== undefined) return [];
  return seedBlockedRecords(record);
}

function seedBlockedRecords(record: Record<string, unknown>): SeedBlocked[] {
  const raw = record[SEED_BLOCKED_KEY];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`seed ${SEED_BLOCKED_KEY} must be an array of {form, field?, reason}`);
  const out: SeedBlocked[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`seed ${SEED_BLOCKED_KEY} entries must be {form, field?, reason}`);
    }
    const entry = item as Record<string, unknown>;
    // An entry that carries a row's source id is a real table row, not a blocker record.
    if (entry.c2c_source_id !== undefined) continue;
    if (typeof entry.form !== 'string' || entry.form === '' || typeof entry.reason !== 'string' || entry.reason === '') {
      throw new Error(`seed ${SEED_BLOCKED_KEY} entries must name form and reason`);
    }
    if (entry.field !== undefined && typeof entry.field !== 'string') {
      throw new Error(`seed ${SEED_BLOCKED_KEY} entry field must be a string`);
    }
    out.push({ form: entry.form, ...(entry.field !== undefined ? { field: entry.field } : {}), reason: entry.reason });
  }
  return out;
}

function parseLegacySeed(record: Record<string, unknown>): SeedTable[] {
  if (record.version !== 1) throw new Error('seed version must be 1');
  const tables = record.tables;
  if (!Array.isArray(tables) || tables.length === 0) throw new Error('seed file has no tables');
  const seen = new Set<string>();
  return tables.map((table) => parseTable(table, seen));
}

function parseCanonicalForms(record: Record<string, unknown>): CanonicalSeedFile {
  const file: CanonicalSeedFile = {};
  for (const [form, rows] of Object.entries(record)) {
    if (form === SEED_BLOCKED_KEY) continue;
    if (!Array.isArray(rows)) throw new Error(`seed form ${form} rows are missing`);
    file[form] = rows;
  }
  return file;
}

function tablesFromCanonical(file: CanonicalSeedFile): SeedTable[] {
  const seen = new Set<string>();
  const tables = Object.entries(file).map(([form, rows]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(form)) throw new Error('seed table name is not a ZCQL identifier');
    return { table: form, rows: rows.map((row) => parseRow(row, seen)) };
  });
  if (tables.length === 0) throw new Error('seed file has no tables');
  return tables;
}

function parseTable(value: unknown, seen: Set<string>): SeedTable {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('seed table is not an object');
  const record = value as { table?: unknown; rows?: unknown };
  const table = typeof record.table === 'string' ? record.table.trim() : '';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error('seed table name is not a ZCQL identifier');
  if (!Array.isArray(record.rows)) throw new Error('seed table rows are missing');
  const rows = record.rows.map((row) => parseRow(row, seen));
  return { table, rows };
}

function parseRow(value: unknown, seen: Set<string>): SeedRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('seed row is not an object');
  const record = value as Record<string, unknown>;
  const rawId = record.c2c_source_id;
  if (typeof rawId !== 'string' || rawId.trim() === '') throw new Error('seed row is missing c2c_source_id');
  const id = rawId.trim();
  if (seen.has(id)) throw new Error(`seed has a duplicate c2c_source_id ${id}; c2c_source_id is not a unique column, so the loader refuses it`);
  seen.add(id);
  const columns: Record<string, string> = {};
  for (const [key, cell] of Object.entries(record)) {
    if (key === 'c2c_source_id') continue;
    if (cell === null || cell === undefined) continue;
    if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
      columns[key] = String(cell);
      continue;
    }
    throw new Error('seed cell is not a scalar');
  }
  return { id, columns };
}

function jsonResponse(body: unknown, status = 200): MigrateResponse {
  return {
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

/**
 * Source ids that occur more than once in a table, in first-repeat order. c2c_source_id
 * is nullable and not unique in the store (app inserts leave it NULL), so the loader
 * enforces one row per Creator id itself.
 */
export function duplicateSourceIds(table: SeedTable): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const row of table.rows) {
    if (!seen.has(row.id)) seen.add(row.id);
    else if (!dupes.includes(row.id)) dupes.push(row.id);
  }
  return dupes;
}

/** A Stratus-key column on a seed table. `column` is the store name; `field` is the link in the object key. */
export interface SeedFileColumn {
  column: string;
  field: string;
}

/** Stratus bucket for a seed upload. Same derivation as the migration plan's bucket name. */
export function seedBucketName(link: string): string {
  const slug = link.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  return `c2c-${slug}-${createHash('sha256').update(link).digest('hex').slice(0, 8)}`;
}

/** Form tables only. Child-table file fields are not in the synthetic seed. */
export function seedFileColumns(plan: SchemaPlan): Record<string, SeedFileColumn[]> {
  const out: Record<string, SeedFileColumn[]> = {};
  for (const table of plan.tables) {
    if (table.role !== 'form') continue;
    const columns: SeedFileColumn[] = [];
    for (const column of table.columns) {
      if (!STRATUS_KEY_TYPES.includes(column.matrixId)) continue;
      columns.push({ column: column.name, field: column.field ?? column.name });
    }
    if (columns.length) out[table.form] = columns;
  }
  return out;
}

const FIXTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function needsFixtureUpload(value: string | undefined): boolean {
  if (!value) return false;
  return !value.startsWith('uploads/') && !value.startsWith('migrated/');
}

function fixtureContentType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'txt') return 'text/plain';
  return 'application/octet-stream';
}

function readSeedFixture(dir: string, name: string): Uint8Array {
  if (!FIXTURE_NAME.test(name)) throw new Error(`seed fixture name is not a file name`);
  try {
    return new Uint8Array(readFileSync(join(dir, name)));
  } catch {
    throw new Error(`seed fixture ${name} is missing`);
  }
}

/** Upload each distinct fixture once and replace the cell with its Stratus key. Does not mutate `table`. */
async function uploadSeedFiles(table: SeedTable, specs: readonly SeedFileColumn[], seedDir: string, sink: ObjectSink): Promise<SeedTable> {
  const cache = new Map<string, string>();
  const rows = [];
  for (const row of table.rows) {
    let columns = row.columns;
    let changed = false;
    for (const spec of specs) {
      const value = row.columns[spec.column];
      if (!needsFixtureUpload(value)) continue;
      const cacheKey = `${spec.field}\0${value}`;
      let key = cache.get(cacheKey);
      if (!key) {
        const bytes = readSeedFixture(seedDir, value!);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        key = uploadObjectKey(table.table, spec.field, sha256, value);
        await sink.put(key, bytes, fixtureContentType(value!));
        cache.set(cacheKey, key);
      }
      if (!changed) {
        columns = { ...row.columns };
        changed = true;
      }
      columns[spec.column] = key;
    }
    rows.push(changed ? { id: row.id, columns } : row);
  }
  return { table: table.table, rows };
}

/** Upload fixture files before any row write. A missing file or a missing store refuses the load. */
async function stageSeedFiles(
  tables: readonly SeedTable[],
  opts: { fileColumnsByTable?: Readonly<Record<string, readonly SeedFileColumn[]>>; seedDir?: string; sink?: ObjectSink },
): Promise<SeedTable[]> {
  if (!opts.fileColumnsByTable) return [...tables];
  const staged: SeedTable[] = [];
  for (const table of tables) {
    const specs = opts.fileColumnsByTable[table.table];
    if (!specs?.length) {
      staged.push(table);
      continue;
    }
    const pending = specs.filter((spec) => table.rows.some((row) => needsFixtureUpload(row.columns[spec.column])));
    if (!pending.length) {
      staged.push(table);
      continue;
    }
    if (!opts.seedDir || !opts.sink) {
      throw new Error(`seed ${table.table}.${pending[0]!.column} is a file field and needs the fixture directory and an object store`);
    }
    staged.push(await uploadSeedFiles(table, pending, opts.seedDir, opts.sink));
  }
  return staged;
}

export async function migrateSeed(opts: {
  tables: readonly SeedTable[];
  /** Lookup graph (from `--ds` via foreignKeysForApp). Without it cells stay scalars. */
  foreignKeys?: readonly SeedForeignKey[];
  /** Schema table names (from `--ds`). Seed tables outside it are refused before any write. */
  knownTables?: readonly string[];
  dc: string;
  catalystBase: string;
  dryRun: boolean;
  fetch: FetchLike;
  checkpoint?: Checkpoint;
  saveCheckpoint?: (checkpoint: Checkpoint) => void;
  /** Guarded org, project, and CLI token. Required for a live write. */
  scope?: CatalystScope;
  /** Generated columns per table. The shared writer refuses silent Data Store changes. */
  columnsByTable?: Readonly<Record<string, readonly IntegrityColumn[]>>;
  /** Per table: lookup column → source record id → destination ROWID, the remap this load applied. */
  lookupSourceIds?: Readonly<Record<string, Readonly<Record<string, ReadonlyMap<string, string>>>>>;
  /** Per table: Creator Users-field column names — their ZUID cells remap through `userIds`. */
  userColumnsByTable?: Readonly<Record<string, readonly string[]>>;
  /** Creator ZUID → invited Catalyst user_id (from the backup user lists + the users state file). */
  userIds?: ReadonlyMap<string, string>;
  /** Store-unique column names per table, from the schema the source produced. */
  uniqueColumnsByTable?: Readonly<Record<string, readonly string[]>>;
  /** Stratus-key columns, keyed by seed table (the form link name). */
  fileColumnsByTable?: Readonly<Record<string, readonly SeedFileColumn[]>>;
  /** Directory that holds seed.json and the fixture files named by file cells. */
  seedDir?: string;
  /** Where fixture bytes are uploaded. Required for a live load of a file cell. */
  sink?: ObjectSink;
}): Promise<MigrateResult> {
  if (!opts.dryRun) requireScope(opts.scope);
  // Refuse before any write: a repeated id would be stored twice.
  const repeated = opts.tables.map((table) => ({ table, dupes: duplicateSourceIds(table) })).filter((item) => item.dupes.length);
  if (repeated.length) {
    return {
      ok: false,
      dryRun: opts.dryRun,
      tables: repeated.map(({ table, dupes }) => ({
        table: table.table,
        sourceCount: table.rows.length,
        writtenCount: 0,
        sourceChecksum: '',
        writtenChecksum: '',
        batches: [],
        mismatch: true,
        missingIds: [],
        duplicateIds: dupes,
        error: `source repeats ${dupes.length} record id(s); c2c_source_id must be unique per table`,
      })),
    };
  }
  const keys = opts.foreignKeys ?? [];
  if (opts.knownTables) assertSeedTables(opts.tables, opts.knownTables);
  if (opts.columnsByTable) assertSeedColumns(opts.tables, opts.columnsByTable);
  // Unknown lookup references are refused before any write, on dry runs too.
  assertSeedReferences(opts.tables, keys);
  const ordered = keys.length > 0 ? orderTables(opts.tables, keys) : [...opts.tables];
  const deferred = cyclicForeignKeys(
    ordered.map((table) => table.table),
    keys,
  );
  // Deferred (self/cyclic) lookups are written in a second pass, so the first
  // insert does not require them; the same rule the CSV loader applies.
  const columnsByTable = firstPassColumns(opts.columnsByTable ?? {}, deferred);
  // A column the schema marks mandatory that no row carries would fail the first
  // insert on every row — refuse the whole run before the first write, so a
  // report-shaped export cannot produce a partial load.
  const missing = mandatoryMissingRefusals(opts.tables, columnsByTable);
  const uniqueDupes = duplicateUniqueRefusals(opts.tables, opts.uniqueColumnsByTable ?? {});
  // A value longer than its column would be stored cut short without an error.
  // The report then carries every cell the writer would refuse.
  const overLength = overLengthRefusals(opts.tables, columnsByTable);
  const cells = overLength.length ? cellRuleRefusals(opts.tables, columnsByTable) : [];
  const refused = [...missing, ...uniqueDupes, ...cells];
  if (refused.length) {
    const names = [...new Set(refused.map((item) => `${item.table}.${item.column}`))].join(', ');
    const label =
      uniqueDupes.length || (cells.length && cells.length < refused.length)
        ? `${refused.length} constraint violation(s)`
        : cells.length
          ? `${refused.length} value(s) the store would alter (${overLength.length} over length)`
          : `${refused.length} missing mandatory value(s)`;
    return {
      ok: false,
      dryRun: opts.dryRun,
      tables: [],
      integrity: { ...emptyIntegrity(), refusedByRule: groupRefusals(refused) },
      error: `refused ${label} before any write: ${names} — the column is store-constrained; fix the source or re-provision it without the constraint`,
    };
  }
  const staged = opts.dryRun ? ordered : await stageSeedFiles(ordered, opts);
  const byReport = new Map(staged.map((table) => [table.table, table]));
  const served = new Map<string, boolean>();
  const fetchSeed: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const parsed = new URL(url);
    if (method === 'GET' && parsed.pathname.includes('/creator/v2.1/data/')) {
      const report = decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
      const table = byReport.get(report);
      if (!table) throw new Error('seed has no table for this read');
      if (served.get(report)) return jsonResponse({ data: [] });
      served.set(report, true);
      return jsonResponse({
        data: table.rows.map((row) => ({ ID: row.id, ...row.columns })),
      });
    }
    return opts.fetch(url, init);
  };
  const checkpoint = opts.checkpoint ?? emptyCheckpoint();
  const rowIds = new Map<string, Map<string, string>>();
  const singles: MigrateResult[] = [];
  // Deferred (self/cyclic) columns resolve after every side has a ROWID, via row update.
  const acyclic = keys.filter((key) => !deferred.has(foreignKeyId(key)));
  for (const table of staged) {
    // A dry run writes nothing, so there are no ROWIDs to remap to yet.
    const resolved = opts.dryRun ? table : omitColumns(resolveForeignKeys(table, acyclic, rowIds), deferredColumns(table.table, deferred));
    byReport.set(table.table, resolved);
    const single = await migrateData({
      dc: opts.dc,
      creatorBase: creatorBaseFor(opts.dc),
      catalystBase: opts.catalystBase,
      owner: SEED_OWNER,
      appLink: SEED_APP,
      tables: [{
        report: table.table,
        table: table.table,
        ...(columnsByTable[table.table] ? { integrityColumns: columnsByTable[table.table] } : {}),
        ...(opts.lookupSourceIds?.[table.table] ? { lookupSourceIds: opts.lookupSourceIds[table.table] } : {}),
        ...(opts.userColumnsByTable?.[table.table]?.length ? { userColumns: opts.userColumnsByTable[table.table] } : {}),
      }],
      dryRun: opts.dryRun,
      fetch: fetchSeed,
      checkpoint,
      saveCheckpoint: opts.saveCheckpoint,
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.userIds?.size ? { userIds: opts.userIds } : {}),
    });
    singles.push(single);
    if (!single.ok) break;
    if (!opts.dryRun && opts.scope) {
      rowIds.set(
        table.table,
        await loadRowIds(opts.fetch, opts.catalystBase, opts.dc, table.table, table.rows.map((row) => row.id), opts.scope),
      );
    }
  }
  const merged: MigrateResult = {
    ok: singles.every((single) => single.ok),
    dryRun: opts.dryRun,
    integrity: mergeIntegrity(singles.map((single) => single.integrity)),
    tables: singles.flatMap((single) => single.tables),
    ...(singles.some((single) => single.systemFieldGaps?.length)
      ? { systemFieldGaps: singles.flatMap((single) => single.systemFieldGaps ?? []) }
      : {}),
  };
  if (!merged.ok) return fixCounts(merged, byReport);
  if (!opts.dryRun && opts.scope && deferred.size > 0) {
    await updateDeferredForeignKeys(
      { dc: opts.dc, catalystBase: opts.catalystBase, fetch: opts.fetch, scope: opts.scope },
      opts.tables,
      keys,
      deferred,
      rowIds,
    );
  }
  return fixCounts(merged, byReport);
}

function firstPassColumns(
  columnsByTable: Readonly<Record<string, readonly IntegrityColumn[]>>,
  deferred: ReadonlySet<string>,
): Record<string, IntegrityColumn[]> {
  return Object.fromEntries(
    Object.entries(columnsByTable).map(([table, columns]) => {
      const later = deferredColumns(table, deferred);
      return [table, columns.map(({ required, ...column }) => (required && !later.has(column.name) ? { ...column, required } : column))];
    }),
  );
}

function fixCounts(result: MigrateResult, byReport: ReadonlyMap<string, SeedTable>): MigrateResult {
  for (const table of result.tables) {
    const expected = byReport.get(table.table)?.rows.length;
    if (expected === undefined) continue;
    if (table.sourceCount !== expected || table.writtenCount !== expected) {
      table.sourceCount = expected;
      table.mismatch = true;
    }
  }
  result.ok = result.tables.every((table) => !table.mismatch && table.sourceCount === table.writtenCount);
  return result;
}

export function formatSkipped(skipped: readonly { table: string; detail: string }[]): string[] {
  const lines = skipped.map((item) => `- skip nosql ${item.table} (${item.detail})`);
  return ['skipped:', ...(lines.length ? lines : ['- none'])];
}

function requireScope(scope: CatalystScope | undefined): asserts scope is CatalystScope {
  if (!scope?.org || !scope?.projectId || !scope?.token) throw new Error('migrate requires the guarded org, project, and token');
}

export function formatMigratePlan(
  tables: readonly SeedTable[],
  guard: Parameters<typeof planScopeLines>[0],
  skipped: readonly { table: string; detail: string }[] = [],
  blocked: readonly SeedBlocked[] = [],
  opts: { bucket?: string } = {},
): string {
  const lines = [
    'c2c migrate-data plan v1',
    'source: seed',
    ...planScopeLines(guard),
    'credential: not checked',
    ...confirmGuardLines(),
    'confirm: no',
    '',
    'tables:',
    ...tables.map((table) => `- ${table.table} source ${table.rows.length}`),
    '',
    ...formatSkipped(skipped),
    '',
    'bucket:',
    ...(opts.bucket ? [`- ${opts.bucket} (the project template or provision step bucket creates it; --confirm verifies it before the first write)`] : ['- none']),
    '',
    'blocked:',
    ...(blocked.length ? blocked.map((item) => `- ${item.form}${item.field ? `/${item.field}` : ''}: ${item.reason}`) : ['- none']),
    '',
    'writes: no',
    '',
  ];
  return `${lines.join('\n')}\n`;
}
