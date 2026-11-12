/**
 * Chunked bulk load through the Data Store Bulk Write API.
 *
 * insertRows takes at most 200 rows per call. A table of 10k+ rows instead goes
 * through Bulk Write: each chunk becomes one CSV object in a Stratus bucket and
 * one write job, polled until it ends.
 *
 *   POST {api}/baas/v1/project/{project}/bulk/write
 *        { table_identifier, operation: "insert",
 *          object_details: { bucket_name, object_key },
 *          find_by?, fk_mapping?: [{ local_column, reference_column }] }
 *   GET  {api}/baas/v1/project/{project}/bulk/write/{job_id}
 *        data.status "In-Progress" | "Completed" | "Failed";
 *        Completed: results.details[].records_processed; Failed: results.description
 *
 * Lookups. Parents load before children. A lookup cell carries the parent's
 * source id. `fk_mapping` lets the store swap it for the parent ROWID, but only
 * when the parent's reference column is store-unique: otherwise the job fails
 * ("The reference_column '<column>' in fk_mapping of table <id> is not a
 * unique column"). c2c_source_id is not unique by default (mapping.ts), so a
 * parent without a unique reference column is resolved by the loader instead:
 * per chunk, the parent source ids the chunk uses are read back as ROWIDs in
 * ZCQL IN queries of at most 300 ids. No table-wide id map is kept, so memory
 * stays bounded by the chunk. A lookup whose parent table is not part of the
 * load (a subset load) resolves against the store the same way; a parent id
 * the store does not hold is refused (unknown-reference), never written as
 * the raw source id. Self and cyclic lookups are written afterwards
 * with row updates (at most 200 rows per call), once every side has a ROWID.
 *
 * Writes are validated first (write-rules.ts): the store truncates a long
 * varchar, alters a numeric date and rounds extra decimals without an error,
 * so such a row is refused and named, never sent. With `roundScale` a decimal
 * is rounded half up (away from zero) to the column scale before the check.
 *
 * Resume. The checkpoint records each chunk as submitted (job id) or done —
 * a done chunk also records the source ids it refused — and is saved after
 * every step. Before a chunk is sent, the source ids already in the table are
 * read back and dropped, so a run that stopped after the store accepted a job
 * (but before the checkpoint saved it) never inserts a row twice. A done
 * chunk's refused ids are checked and sent again on the next run, so fixing
 * the source and resuming lands them; while any remain, the result is not ok.
 * A `deadline` stops between chunks, and stops waiting on a job, and reports
 * `complete: false`, so a Job function can run the load in time-boxed slices.
 * The source must yield the same rows in the same order on every run of a
 * checkpoint: chunks are keyed by position.
 *
 * This module never calls the network. The store is injected.
 */
import { checkRow, quantizeRow, type WriteRefusal, type WriteRuleColumn } from '../../shims/src/write-rules.js';
import { SOURCE_ID_COLUMN } from '../../schema/src/mapping.js';
import { MAX_BATCH, ZCQL_IN_LIMIT } from './migrate.js';

/** Rows per CSV object and write job. */
export const BULK_CHUNK_ROWS = 5000;
/** Status reads per job before the run gives up on it (the job id stays in the checkpoint). */
export const BULK_MAX_POLLS = 120;

export interface BulkRow {
  id: string;
  columns: Record<string, string>;
}

export interface BulkSourceTable {
  table: string;
  /** Called once per pass. Rows are pulled lazily, so a generator keeps memory flat. */
  rows: () => Iterable<BulkRow> | AsyncIterable<BulkRow>;
}

export interface BulkForeignKey {
  table: string;
  column: string;
  parent: string;
}

export interface BulkWriteJobRequest {
  table_identifier: string;
  operation: 'insert';
  object_details: { bucket_name: string; object_key: string };
  fk_mapping?: { local_column: string; reference_column: string }[];
}

export type BulkJobStatus =
  | { status: 'In-Progress' }
  | { status: 'Completed'; processed: number }
  | { status: 'Failed'; description: string };

export interface BulkStore {
  putObject(bucket: string, key: string, csv: string): Promise<void>;
  createWriteJob(request: BulkWriteJobRequest): Promise<{ jobId: string }>;
  writeJobStatus(jobId: string): Promise<BulkJobStatus>;
  /** source id → ROWID for the ids stored in `table`. Called with at most 300 ids. */
  rowIdsBySourceId(table: string, ids: readonly string[]): Promise<Map<string, string>>;
  /** Row update by ROWID, at most 200 rows. Returns the ROWIDs the store updated. */
  updateRows(table: string, rows: readonly Record<string, string>[]): Promise<string[]>;
}

export type BulkChunkState =
  | { state: 'submitted'; jobId: string; key: string }
  | { state: 'done'; loaded: number; refused?: string[] };

export interface BulkCheckpoint {
  version: 1;
  /** `deferred[chunk]` is true once its update ran, or the source ids still refused there. */
  tables: Record<string, { chunks: Record<string, BulkChunkState>; deferred?: Record<string, true | string[]>; deferredDone?: boolean }>;
}

export function emptyBulkCheckpoint(): BulkCheckpoint {
  return { version: 1, tables: {} };
}

export interface BulkRefusal {
  table: string;
  id: string;
  column: string;
  /** 'not-stored': the write job ended but the store did not store the row and named no cause. */
  rule: WriteRefusal['rule'] | 'unknown-reference' | 'duplicate-source-id' | 'not-stored';
}

export interface BulkTableReport {
  table: string;
  /** Source rows seen this run. */
  source: number;
  /** Source rows stored once their chunk finished, this run and earlier runs. */
  loaded: number;
  refused: number;
  chunks: number;
  fk: { column: string; parent: string; via: 'fk_mapping' | 'remap' | 'deferred' }[];
}

export interface BulkLoadResult {
  ok: boolean;
  dryRun: boolean;
  /** false when the deadline stopped the run; resume with the same checkpoint. */
  complete: boolean;
  tables: BulkTableReport[];
  refusals: BulkRefusal[];
  /** At most this many refusals are listed; `refused` counts them all. */
  error?: string;
}

export interface BulkLoadOptions {
  tables: readonly BulkSourceTable[];
  foreignKeys?: readonly BulkForeignKey[];
  /** Per parent table: a store-unique column holding the source id. Only these lookups use fk_mapping. */
  uniqueReference?: Readonly<Record<string, string>>;
  /** Write-rule columns per table (the generated schema's length, scale, date and mandatory rules). */
  columnsByTable?: Readonly<Record<string, readonly WriteRuleColumn[]>>;
  /** Round a decimal to its column scale (half up) before the check, instead of refusing it. */
  roundScale?: boolean;
  bucket: string;
  /** Object key prefix inside the bucket. */
  prefix: string;
  /** Default false: plan only. */
  dryRun?: boolean;
  store?: BulkStore;
  chunkRows?: number;
  maxPolls?: number;
  checkpoint?: BulkCheckpoint;
  saveCheckpoint?: (checkpoint: BulkCheckpoint) => void | Promise<void>;
  /** Waits between status reads. Injected so tests do not sleep. */
  wait?: (ms: number) => Promise<void>;
  /** Stops between chunks once now() passes it. */
  deadline?: number;
  now?: () => number;
}

const REFUSAL_LIST_MAX = 50;

export class BulkLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkLoadError';
  }
}

/** One CSV field: quoted when it holds a comma, quote, or line break. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A CSV with c2c_source_id first, then every other column the chunk uses, sorted. An absent cell is empty. */
export function chunkCsv(rows: readonly BulkRow[]): string {
  const names = new Set<string>();
  for (const row of rows) for (const name of Object.keys(row.columns)) names.add(name);
  names.delete(SOURCE_ID_COLUMN);
  const header = [SOURCE_ID_COLUMN, ...[...names].sort()];
  const lines = [header.map(csvField).join(',')];
  for (const row of rows) {
    lines.push([row.id, ...header.slice(1).map((name) => row.columns[name] ?? '')].map(csvField).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function isList(value: string): boolean {
  return value.startsWith('[');
}

function sourceIds(value: string): string[] {
  if (!isList(value)) return [value];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [value];
  } catch {
    return [value];
  }
}

/** Parents first, by the non-deferred edges; ties sort by name. A table left in a cycle goes last. */
export function bulkOrder(tables: readonly string[], keys: readonly BulkForeignKey[], deferred: ReadonlySet<string>): string[] {
  const deps = new Map(tables.map((name) => [name, new Set<string>()]));
  for (const key of keys) {
    if (key.parent === key.table || !deps.has(key.parent) || !deps.has(key.table) || deferred.has(edgeId(key))) continue;
    deps.get(key.table)!.add(key.parent);
  }
  const out: string[] = [];
  while (out.length < tables.length) {
    const ready = [...deps.entries()].filter(([name, parents]) => !out.includes(name) && [...parents].every((p) => out.includes(p))).map(([name]) => name).sort();
    if (!ready.length) {
      out.push(...tables.filter((name) => !out.includes(name)).sort());
      break;
    }
    out.push(ready[0]!);
  }
  return out;
}

function edgeId(key: BulkForeignKey): string {
  return `${key.table}\0${key.column}`;
}

/** Self lookups and every edge on a cycle: these land by row update after all inserts. */
export function deferredEdges(tables: readonly string[], keys: readonly BulkForeignKey[]): Set<string> {
  const known = new Set(tables);
  const graph = new Map<string, Set<string>>();
  for (const key of keys) {
    if (!known.has(key.table) || !known.has(key.parent)) continue;
    (graph.get(key.table) ?? graph.set(key.table, new Set()).get(key.table)!).add(key.parent);
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const name = stack.pop()!;
      if (name === to) return true;
      if (seen.has(name)) continue;
      seen.add(name);
      for (const next of graph.get(name) ?? []) stack.push(next);
    }
    return false;
  };
  const out = new Set<string>();
  for (const key of keys) {
    if (!known.has(key.table) || !known.has(key.parent)) continue;
    if (key.parent === key.table || reaches(key.parent, key.table)) out.add(edgeId(key));
  }
  return out;
}

async function* chunksOf(source: Iterable<BulkRow> | AsyncIterable<BulkRow>, size: number): AsyncGenerator<BulkRow[]> {
  let buffer: BulkRow[] = [];
  for await (const row of source) {
    buffer.push(row);
    if (buffer.length >= size) {
      yield buffer;
      buffer = [];
    }
  }
  if (buffer.length) yield buffer;
}

async function rowIds(store: BulkStore, table: string, ids: readonly string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += ZCQL_IN_LIMIT) {
    const got = await store.rowIdsBySourceId(table, unique.slice(i, i + ZCQL_IN_LIMIT));
    for (const [source, rowid] of got) found.set(source, rowid);
  }
  return found;
}

const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Plan (dry run, the default) or run a chunked bulk load. A dry run reads the
 * source once to count rows and check them, and never touches the store.
 */
export async function bulkLoad(opts: BulkLoadOptions): Promise<BulkLoadResult> {
  const dryRun = opts.dryRun !== false;
  if (!dryRun && !opts.store) throw new BulkLoadError('a live bulk load needs a store');
  const size = Math.max(1, Math.floor(opts.chunkRows ?? BULK_CHUNK_ROWS));
  const maxPolls = opts.maxPolls ?? BULK_MAX_POLLS;
  const wait = opts.wait ?? defaultWait;
  const now = opts.now ?? Date.now;
  const keys = opts.foreignKeys ?? [];
  const names = opts.tables.map((table) => table.table);
  const byName = new Map(opts.tables.map((table) => [table.table, table]));
  const deferred = deferredEdges(names, keys);
  const order = bulkOrder(names, keys, deferred);
  const checkpoint = opts.checkpoint ?? emptyBulkCheckpoint();
  const save = async (): Promise<void> => {
    if (opts.saveCheckpoint) await opts.saveCheckpoint(checkpoint);
  };
  const refusals: BulkRefusal[] = [];
  const refuse = (item: BulkRefusal): void => {
    if (refusals.length < REFUSAL_LIST_MAX) refusals.push(item);
  };
  const reports: BulkTableReport[] = [];
  const expired = (): boolean => opts.deadline !== undefined && now() >= opts.deadline;
  let complete = true;

  for (const name of order) {
    const table = byName.get(name)!;
    // Edges to parent tables outside this load are kept: they resolve against the store.
    const mine = keys.filter((key) => key.table === name);
    const fk = mine.map((key) => ({
      column: key.column,
      parent: key.parent,
      via: deferred.has(edgeId(key)) ? ('deferred' as const) : opts.uniqueReference?.[key.parent] ? ('fk_mapping' as const) : ('remap' as const),
    }));
    const deferredColumns = new Set(fk.filter((edge) => edge.via === 'deferred').map((edge) => edge.column));
    // A deferred lookup is empty on insert, so its mandatory rule waits for the update.
    const columns = opts.columnsByTable?.[name]?.map((column) => (deferredColumns.has(column.name) ? { ...column, required: false } : column));
    const state = (checkpoint.tables[name] ??= { chunks: {} });
    const report: BulkTableReport = { table: name, source: 0, loaded: 0, refused: 0, chunks: 0, fk };
    reports.push(report);
    for (const chunkState of Object.values(state.chunks)) {
      if (chunkState.state === 'done') report.loaded += chunkState.loaded;
    }
    const seen = new Set<string>();
    let index = 0;
    for await (const rows of chunksOf(table.rows(), size)) {
      const chunkKey = String(index++);
      report.source += rows.length;
      report.chunks += 1;
      const prior = state.chunks[chunkKey];
      // A done chunk is re-run for the source ids it refused, so a fixed source
      // lands them; a clean done chunk only feeds the duplicate check.
      const retry = prior?.state === 'done' && prior.refused?.length ? new Set(prior.refused) : undefined;
      if (prior?.state === 'done' && !retry) {
        for (const row of rows) seen.add(row.id);
        continue;
      }
      if (expired()) {
        complete = false;
        break;
      }
      const chunkRefused = new Set<string>();
      // Validate, then drop deferred columns (written by update later).
      const prepared: BulkRow[] = [];
      for (const row of rows) {
        if (retry && !retry.has(row.id)) {
          seen.add(row.id);
          continue;
        }
        if (seen.has(row.id)) {
          refuse({ table: name, id: row.id, column: SOURCE_ID_COLUMN, rule: 'duplicate-source-id' });
          report.refused += 1;
          chunkRefused.add(row.id);
          continue;
        }
        seen.add(row.id);
        const cells: Record<string, unknown> = {};
        for (const [column, value] of Object.entries(row.columns)) if (!deferredColumns.has(column)) cells[column] = value;
        const rounded = opts.roundScale && columns ? quantizeRow(columns, cells) : cells;
        const checked = checkRow(columns, rounded, { required: true });
        if (checked.refusals.length) {
          for (const item of checked.refusals) refuse({ table: name, id: row.id, column: item.column, rule: item.rule });
          report.refused += 1;
          chunkRefused.add(row.id);
          continue;
        }
        prepared.push({ id: row.id, columns: Object.fromEntries(Object.entries(checked.cells).map(([k, v]) => [k, String(v)])) });
      }
      if (dryRun) continue;
      const store = opts.store!;
      if (prior?.state === 'submitted') {
        // A job an earlier run sent: wait for it, then re-send only what it did not store.
        const status = await pollJob(store, prior.jobId, maxPolls, wait, opts.deadline, now);
        if (status.status === 'In-Progress') {
          if (expired()) {
            complete = false;
            break;
          }
          throw new BulkLoadError(`bulk write job ${prior.jobId} for ${name} chunk ${chunkKey} is still running after ${maxPolls} status reads; resume to keep waiting`);
        }
      }
      // Rows an earlier run already landed are not sent again.
      const stored = await rowIds(store, name, prepared.map((row) => row.id));
      const fresh = prepared.filter((row) => !stored.has(row.id));
      const { rows: resolved, mapping } = await resolveLookups(store, name, fresh, fk, opts.uniqueReference ?? {}, (item) => {
        refuse(item);
        report.refused += 1;
        chunkRefused.add(item.id);
      });
      let sent = 0;
      if (resolved.length) {
        const key = `${opts.prefix.replace(/\/$/, '')}/${name}/chunk-${chunkKey.padStart(5, '0')}.csv`;
        await store.putObject(opts.bucket, key, chunkCsv(resolved));
        const { jobId } = await store.createWriteJob({
          table_identifier: name,
          operation: 'insert',
          object_details: { bucket_name: opts.bucket, object_key: key },
          ...(mapping.length ? { fk_mapping: mapping } : {}),
        });
        state.chunks[chunkKey] = { state: 'submitted', jobId, key };
        await save();
        const status = await pollJob(store, jobId, maxPolls, wait, opts.deadline, now);
        if (status.status === 'In-Progress') {
          if (expired()) {
            complete = false;
            break;
          }
          throw new BulkLoadError(`bulk write job ${jobId} for ${name} chunk ${chunkKey} is still running after ${maxPolls} status reads; resume to keep waiting`);
        }
        // Count what landed: a job skips a row it cannot write and names it only in its result file.
        const landed = await rowIds(store, name, resolved.map((row) => row.id));
        const missing = resolved.filter((row) => !landed.has(row.id));
        if (status.status === 'Failed') {
          // The next run re-sends the whole chunk; the read-back drops what landed.
          delete state.chunks[chunkKey];
          await save();
          throw new BulkLoadError(`bulk write for ${name} chunk ${chunkKey} failed: ${status.description}`);
        }
        if (missing.length) {
          // The store dropped these without an error. Name them, so a resume
          // re-sends exactly them instead of re-running the whole chunk into
          // the same silent drop.
          for (const item of await explainMissing(store, name, fk, mapping, missing)) {
            refuse(item);
            report.refused += 1;
            chunkRefused.add(item.id);
          }
        }
        sent = resolved.length - missing.length;
      }
      const loaded = stored.size + sent;
      report.loaded += loaded;
      const next: BulkChunkState = { state: 'done', loaded: (prior?.state === 'done' ? prior.loaded : 0) + loaded };
      if (chunkRefused.size) next.refused = [...chunkRefused];
      state.chunks[chunkKey] = next;
      if (sent > 0 && deferredColumns.size && state.deferredDone) {
        // The deferred pass already ran for this table; the rows that just
        // landed still need their deferred lookups, so it runs again.
        delete state.deferredDone;
        delete state.deferred;
      }
      await save();
    }
    if (!complete) break;
    await save();
  }

  // Self and cyclic lookups: row updates once every side has a ROWID.
  if (!dryRun && complete) {
    for (const name of order) {
      const state = checkpoint.tables[name]!;
      const done = (state.deferred ??= {});
      if (state.deferredDone && !Object.values(done).some(Array.isArray)) continue;
      const edges = keys.filter((key) => key.table === name && byName.has(key.parent) && deferred.has(edgeId(key)));
      if (!edges.length) continue;
      if (expired()) {
        complete = false;
        break;
      }
      let index = 0;
      for await (const rows of chunksOf(byName.get(name)!.rows(), MAX_BATCH)) {
        const chunkKey = String(index++);
        const entry = done[chunkKey];
        // A done deferred chunk re-runs only for the rows it refused last time.
        const retry = Array.isArray(entry) && entry.length ? new Set(entry) : undefined;
        if (entry !== undefined && !retry) continue;
        if (expired()) {
          complete = false;
          break;
        }
        const targets = retry ? rows.filter((row) => retry.has(row.id)) : rows;
        const stillRefused = new Set<string>();
        if (targets.length) {
          await updateDeferred(opts.store!, name, targets, edges, (item) => {
            refuse(item);
            reports.find((report) => report.table === name)!.refused += 1;
            stillRefused.add(item.id);
          });
        }
        done[chunkKey] = stillRefused.size ? [...stillRefused] : true;
        await save();
      }
      if (!complete) break;
      state.deferredDone = true;
      await save();
    }
  }

  const refusedRows = reports.reduce((n, report) => n + report.refused, 0);
  const ok = complete && refusedRows === 0;
  return {
    ok,
    dryRun,
    complete,
    tables: reports,
    refusals,
    ...(refusedRows ? { error: `refused ${refusedRows} row(s) before the write; fix the source and resume` } : {}),
  };
}

async function pollJob(
  store: BulkStore,
  jobId: string,
  maxPolls: number,
  wait: (ms: number) => Promise<void>,
  deadline?: number,
  now: () => number = Date.now,
): Promise<BulkJobStatus> {
  let delay = 1000;
  for (let poll = 0; poll < maxPolls; poll++) {
    const status = await store.writeJobStatus(jobId);
    if (status.status !== 'In-Progress') return status;
    if (deadline !== undefined) {
      const remaining = deadline - now();
      if (remaining <= 0) return { status: 'In-Progress' };
      await wait(Math.min(delay, remaining));
    } else {
      await wait(delay);
    }
    delay = Math.min(delay * 2, 30_000);
  }
  return { status: 'In-Progress' };
}

/**
 * Why a Completed job did not store these rows: a source id in a mapped lookup
 * column that the parent table does not hold is an unknown-reference; anything
 * else the store dropped without naming a cause is not-stored.
 */
async function explainMissing(
  store: BulkStore,
  table: string,
  fk: BulkTableReport['fk'],
  mapping: readonly { local_column: string; reference_column: string }[],
  missing: readonly BulkRow[],
): Promise<BulkRefusal[]> {
  const mapped = mapping
    .map((m) => fk.find((edge) => edge.column === m.local_column && edge.via === 'fk_mapping'))
    .filter((edge): edge is BulkTableReport['fk'][number] => edge !== undefined);
  const resolved = new Map<string, Map<string, string>>();
  for (const edge of mapped) {
    const wanted = missing.flatMap((row) => (row.columns[edge.column] ? sourceIds(row.columns[edge.column]!) : []));
    resolved.set(edge.column, await rowIds(store, edge.parent, wanted));
  }
  return missing.map((row) => {
    const bad = mapped.find((edge) => {
      const cell = row.columns[edge.column];
      return cell !== undefined && sourceIds(cell).some((id) => !resolved.get(edge.column)!.has(id));
    });
    return bad
      ? { table, id: row.id, column: bad.column, rule: 'unknown-reference' as const }
      : { table, id: row.id, column: SOURCE_ID_COLUMN, rule: 'not-stored' as const };
  });
}

/**
 * Lookup cells for one chunk. A fk_mapping edge keeps the parent's source id
 * and names the reference column; a list cell cannot be mapped by the store, so
 * that chunk resolves the edge here. Every other edge reads the parents' ROWIDs
 * for just this chunk. A row whose parent is not stored is refused.
 */
async function resolveLookups(
  store: BulkStore,
  table: string,
  rows: readonly BulkRow[],
  fk: BulkTableReport['fk'],
  unique: Readonly<Record<string, string>>,
  refuse: (item: BulkRefusal) => void,
): Promise<{ rows: BulkRow[]; mapping: { local_column: string; reference_column: string }[] }> {
  const mapping: { local_column: string; reference_column: string }[] = [];
  const remap: BulkTableReport['fk'] = [];
  for (const edge of fk) {
    if (edge.via === 'deferred') continue;
    const hasList = rows.some((row) => isList(row.columns[edge.column] ?? ''));
    if (edge.via === 'fk_mapping' && !hasList) mapping.push({ local_column: edge.column, reference_column: unique[edge.parent]! });
    else remap.push(edge);
  }
  if (!remap.length) return { rows: [...rows], mapping };
  const maps = new Map<string, Map<string, string>>();
  for (const edge of remap) {
    const wanted = rows.flatMap((row) => (row.columns[edge.column] ? sourceIds(row.columns[edge.column]!) : []));
    const map = maps.get(edge.parent) ?? new Map<string, string>();
    const need = wanted.filter((id) => !map.has(id));
    for (const [source, rowid] of await rowIds(store, edge.parent, need)) map.set(source, rowid);
    maps.set(edge.parent, map);
  }
  const out: BulkRow[] = [];
  for (const row of rows) {
    const columns = { ...row.columns };
    let bad: string | undefined;
    for (const edge of remap) {
      const cell = columns[edge.column];
      if (!cell) continue;
      const mapped = sourceIds(cell).map((id) => maps.get(edge.parent)!.get(id));
      if (mapped.some((id) => id === undefined)) {
        bad = edge.column;
        break;
      }
      columns[edge.column] = isList(cell) ? JSON.stringify(mapped) : mapped[0]!;
    }
    if (bad) {
      refuse({ table, id: row.id, column: bad, rule: 'unknown-reference' });
      continue;
    }
    out.push({ id: row.id, columns });
  }
  return { rows: out, mapping };
}

async function updateDeferred(
  store: BulkStore,
  table: string,
  rows: readonly BulkRow[],
  edges: readonly BulkForeignKey[],
  refuse: (item: BulkRefusal) => void,
): Promise<void> {
  const own = await rowIds(store, table, rows.map((row) => row.id));
  const parents = new Map<string, Map<string, string>>();
  for (const edge of edges) {
    const wanted = rows.flatMap((row) => (row.columns[edge.column] ? sourceIds(row.columns[edge.column]!) : []));
    parents.set(edge.parent, new Map([...(parents.get(edge.parent) ?? []), ...(await rowIds(store, edge.parent, wanted))]));
  }
  const updates: Record<string, string>[] = [];
  for (const row of rows) {
    const rowid = own.get(row.id);
    if (!rowid) continue; // refused or not loaded: counted by the insert pass
    const body: Record<string, string> = { ROWID: rowid };
    let bad: string | undefined;
    for (const edge of edges) {
      const cell = row.columns[edge.column];
      if (!cell) continue;
      const mapped = sourceIds(cell).map((id) => parents.get(edge.parent)!.get(id));
      if (mapped.some((id) => id === undefined)) {
        bad = edge.column;
        break;
      }
      body[edge.column] = isList(cell) ? JSON.stringify(mapped) : mapped[0]!;
    }
    if (bad) refuse({ table, id: row.id, column: bad, rule: 'unknown-reference' });
    else if (Object.keys(body).length > 1) updates.push(body);
  }
  for (let i = 0; i < updates.length; i += MAX_BATCH) {
    const slice = updates.slice(i, i + MAX_BATCH);
    const updated = new Set(await store.updateRows(table, slice));
    // updateRows skips an unknown ROWID without an error, so the count is checked.
    const skipped = slice.filter((row) => !updated.has(row.ROWID!));
    if (skipped.length) throw new BulkLoadError(`row update on ${table} skipped ${skipped.length} row(s) (first ROWID ${skipped[0]!.ROWID})`);
  }
}
