/**
 * Creator v2.1 cursor reader → mapper → Data Store writer.
 * Checkpoints store cursors and ids only. The source-id checksum is stored apart from the written-id checksum.
 * Logs (the result object) store counts and id checksums, never field values.
 * Hosts are limited to the Zoho / Catalyst domains of one DC. Callers pass fetch; tests pass a fake.
 *
 * Writes are idempotent. Each inserted row stores the Creator record id in c2c_source_id
 * (nullable, non-unique varchar 255; see the schema generator). Rows the deployed app
 * creates leave it NULL, so the column cannot be mandatory or unique (a mandatory column returns
 * 403 MANDATORY_MISSING on every app insert). The mover owns uniqueness instead: before a
 * live POST it asks which of the pending ids are already stored and does not insert those
 * again, and it refuses a source that repeats an id in one run (duplicateIds in the result).
 *
 * Endpoint: POST /baas/v1/project/<id>/table/<t>/row
 * with a JSON array of row objects (column → value, at most 200). The reply is
 * {"status":"success","data":[<stored row with ROWID and c2c_source_id>, ...]}. The old
 * /table/<t>/rows path answers 404 INVALID_URL_PATTERN. A refusal is
 * {"status":"failure","data":{"error_code":…,"message":…}}; errors carry both.
 *
 * Choice: reconcile-then-skip, not upsert. Data Store insert does not upsert on a unique
 * column, and an upsert would overwrite a row that already landed. ZCQL IN is capped at
 * 300 values per query (Catalyst's limit). A write batch is at most 200, so one query
 * covers it; larger id lists are chunked.
 *
 * Unique-violation race. A 409 DUPLICATE_VALUE ("Duplicate value for …") comes from an
 * app unique column. The mover re-queries the batch, drops ids now present, and retries
 * the rest. If the re-query finds none of the posted ids, the table fails. A 403 or
 * 404 fails the table too. A 400 or 5xx is UNKNOWN: the mover reads the batch back by
 * c2c_source_id and does not insert those ids again. Rows that are present and unchanged
 * count as unknown-then-found. A stored value that differs from the payload is a
 * silent-change refusal. Two movers that do not share a checkpoint can both see an
 * id as absent and both insert it. Unique is not linearizable, so the store can
 * hold two rows for one c2c_source_id. Every read keeps all of those rows. More
 * than one is a duplicate-source-id refusal: the table does not complete, and the
 * ids are reported. The per-table lease below only covers movers that share a checkpoint.
 *
 * Integrity columns (the generated schema). Before the POST the writer refuses a varchar
 * or text value past the column length, a decimal with more fractional digits than the
 * scale (it never rounds), and a date that is not yyyy-MM-dd or Creator dd-MMM-yyyy.
 * A datetime must be yyyy-MM-dd HH:mm:ss. After a 200, the echoed row is checked. A
 * difference is not counted as written.
 *
 * Per-table lease. A live run stamps the table checkpoint with { owner, expiresAt }
 * before its first await, renews the expiry on each save, and clears it when the table
 * finishes or its load throws. A second mover that shares the checkpoint object does not
 * write that table while expiresAt is still ahead of now; an expired lease can be taken
 * over. The lease is not saved on its own (the next confirmed batch persists it). Two
 * processes that loaded the checkpoint before either saved still race; the re-reconcile
 * on resume is the backstop.
 *
 * Per-table failure. A table whose load is refused or whose read, write, or checkpoint
 * step throws is recorded in the per-table report (mismatch, error) and the run moves on
 * to the next table: one bad table must not leave the rest of the app empty. The run's
 * ok flag is false and the caller exits non-zero. Only refusals decided before a table's
 * load begins — a disallowed host and another mover's live lease — still abort the run.
 *
 * Source id length. Creator v2.1 Get Records returns ID as a numeric string. The
 * published sample is 17 digits and a lookup criteria example is 19 digits. Both
 * fit varchar(255). Data Store varchar silently truncates past 255,
 * so an over-long id fails the table before any query or POST. Ids are not hashed.
 *
 * Re-runs. The stored row is compared to the source value canonically by column
 * type: datetimes by instant (the :SSS fraction and the T/Z spellings read
 * equal, a non-zero millisecond does not), decimals by value, booleans as
 * booleans, and empty text as NULL. A stored NULL that the source now supplies
 * is a fill, not a silent change — but only for the system timestamps
 * Added_Time and Modified_Time and for columns the load marks as adding a
 * value (MigrateTable.fillNullColumns). The fill updates the row by ROWID,
 * counts in the table result and the integrity report, and is read back. Any
 * other stored difference stays a silent-change refusal.
 */
import { randomUUID } from 'node:crypto';
import { exactId, parseJsonExact } from '../../deploy/src/json-exact.js';
import { decimalShadow } from '../../shims/src/criteria.js';
import { migratedObjectKey } from '../../shims/src/files.js';
import { parseJsonLossless } from '../../shims/src/ids.js';
import { DC_ENDPOINTS, KNOWN_DCS, normalizeDc } from '../../core/src/dc.js';
import { canonRow, changedColumns, groupRefusals, isEmptyCell, prepareColumns, type IntegrityColumn, type IntegrityRefusal, type IntegrityReport } from './integrity.js';
import { SOURCE_ID_COLUMN, SOURCE_ID_MAX_LENGTH, SYSTEM_FIELD_COLUMNS, SYSTEM_FIELD_COVERAGE_GAP, systemFieldColumn } from '../../schema/src/mapping.js';
import { canonicalUserIdentity } from '../../schema/src/identity.js';

export const MAX_BATCH = 200;
/** Catalyst rejects a ZCQL IN list longer than this. */
export const ZCQL_IN_LIMIT = 300;
/** How long a per-table lease blocks other movers. Renewed on each checkpoint save. */
export const TABLE_LOCK_TTL_MS = 60_000;

export { SOURCE_ID_MAX_LENGTH };
/**
 * Columns a stored NULL may always be filled on. Every other fillable column
 * must be named by the load itself (MigrateTable.fillNullColumns).
 */
export const FILLABLE_NULL_COLUMNS: readonly string[] = ['Added_Time', 'Modified_Time'];
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/** Suffixes allowed for each Creator/Catalyst DC, from the shared DC table. Host must equal the suffix or be a subdomain of it. */
export const DC_SUFFIXES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  KNOWN_DCS.map((dc) => [dc, DC_ENDPOINTS[dc].suffixes]),
);

export class HostNotAllowedError extends Error {
  readonly host: string;
  readonly dc: string;
  constructor(host: string, dc: string) {
    super(`host ${host} is not on the allow-list for DC ${dc}`);
    this.name = 'HostNotAllowedError';
    this.host = host;
    this.dc = dc;
  }
}

/** Data Store rejected a row because a unique column already holds the value. HTTP 409 / DUPLICATE_VALUE. */
export class UniqueViolationError extends Error {
  readonly status: number;
  constructor(status: number, detail = '') {
    super(`catalyst unique violation: ${status}${detail}`);
    this.name = 'UniqueViolationError';
    this.status = status;
  }
}

/**
 * Catalyst's error code and message from a failure body
 * ({"status":"failure","data":{"error_code","message"}}), as ` CODE: message`, or ''.
 * The message is capped; the body is never echoed whole.
 */
export function catalystErrorDetail(text: string): string {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return '';
  }
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
  const err = data && typeof data === 'object' && !Array.isArray(data) ? (data as { error_code?: unknown; message?: unknown }) : undefined;
  if (!err) return '';
  const code = typeof err.error_code === 'string' ? err.error_code : '';
  const message = typeof err.message === 'string' ? err.message.slice(0, 300) : '';
  return code || message ? ` ${[code, message].filter(Boolean).join(': ')}` : '';
}

/** Path of a Catalyst URL, for an error line. The query string is dropped. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Another live mover holds this table's checkpoint lease. */
export class TableLockedError extends Error {
  readonly table: string;
  readonly owner: string;
  readonly expiresAt: number;
  constructor(table: string, owner: string, expiresAt: number) {
    super(`table ${table} is locked by ${owner} until ${expiresAt}`);
    this.name = 'TableLockedError';
    this.table = table;
    this.owner = owner;
    this.expiresAt = expiresAt;
  }
}

export function assertAllowedHost(rawUrl: string, dc: string): void {
  const key = normalizeDc(dc) ?? dc.trim().toLowerCase();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HostNotAllowedError(rawUrl, key);
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new HostNotAllowedError(url.hostname || rawUrl, key);
  const host = url.hostname.toLowerCase();
  const suffixes = DC_SUFFIXES[key];
  if (!suffixes) throw new HostNotAllowedError(host, key);
  const ok = suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!ok) throw new HostNotAllowedError(host, key);
}

export interface TableCheckpoint {
  /** Cursor that fetched the in-progress page. Null is the first page. */
  requestCursor: string | null;
  /** Last id of the last row the destination confirmed on this page. */
  lastId?: string;
  /** Acknowledged destination rows. Not a source count. */
  count: number;
  /** FNV-1a 64 of acknowledged ids, in acknowledgement order, hex. Not a field value. */
  checksum: string;
  /** Source rows folded into the ledger. Never copied from `count`. */
  sourceCount?: number;
  /** FNV-1a 64 of source ids, in source order, hex. Never copied from `checksum`. */
  sourceChecksum?: string;
  /**
   * Per-table lease. Set before the first await of a live run, renewed on each save,
   * cleared when the table finishes or its load throws. Absent on a dry run.
   */
  lock?: { owner: string; expiresAt: number };
  done: boolean;
}

export interface Checkpoint {
  version: 1;
  tables: Record<string, TableCheckpoint>;
}

export interface MigrateResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<MigrateResponse>;

export interface MigrateTable {
  report: string;
  table: string;
  /**
   * Exact-decimal column → its Double shadow column (schema `shadowFor`). Each written
   * row gets the shadow of the exact value, so ZCQL criteria and sort on it work.
   * A row that already carries the shadow (the CSV loader sets it) keeps that value.
   */
  shadows?: Readonly<Record<string, string>>;
  /**
   * File, image, audio, video, and signature columns (schema `fileColumnsOf`). Each
   * cell is written as its deterministic Stratus key `migrated/<form>/<field>/<id>/<name>`
   * (shims `migratedObjectKey`), not the Creator download path. `migrateFileBytes`
   * copies the bytes to that key; the two steps can run in either order.
   */
  files?: { form: string; columns: readonly string[] };
  /**
   * Generated schema for this table. When set, the writer refuses over-long text,
   * extra decimal digits, and ambiguous dates before the POST, and checks the
   * stored row afterwards.
   */
  integrityColumns?: readonly IntegrityColumn[];
  /**
   * Columns beyond the system timestamps whose stored NULL the source may fill
   * on a re-run (the load marks them as adding a value). A stored NULL anywhere
   * else, and any changed stored value, stays a silent-change refusal.
   */
  fillNullColumns?: readonly string[];
  /**
   * Lookup column → source record id → destination ROWID: the remap this load
   * applied. A re-run that finds a stored cell still holding the raw source id
   * (the pre-remap defect) corrects it by ROWID update to the mapped value.
   * Any other stored difference stays a silent-change refusal.
   */
  lookupSourceIds?: Readonly<Record<string, ReadonlyMap<string, string>>>;
  /**
   * Columns of a Creator Users field (schema `matrixId === 'users'`): the cell
   * holds a Creator ZUID and is rewritten to the invited Catalyst user id this
   * run was given in `MigrateOptions.userIds`. A ZUID no invite recorded is
   * left as the source wrote it.
   */
  userColumns?: readonly string[];
}

export interface MigrateOptions {
  dc: string;
  creatorBase: string;
  catalystBase: string;
  owner: string;
  appLink: string;
  tables: MigrateTable[];
  /** When true, rows are batched and checkpointed but not POSTed. */
  dryRun: boolean;
  fetch: FetchLike;
  checkpoint: Checkpoint;
  saveCheckpoint?: (checkpoint: Checkpoint) => void;
  /** Clamped to 200. */
  batchSize?: number;
  /** Lease owner. One id per call so a retry is a new mover unless the caller passes the same id. */
  runId?: string;
  /** Clock for the lease. Defaults to Date.now. */
  now?: () => number;
  /** Lease length in milliseconds. Defaults to TABLE_LOCK_TTL_MS. */
  lockTtlMs?: number;
  /** When set, Catalyst reads and writes use /baas/v1/project/<id>/ and the CLI auth headers. */
  scope?: CatalystScope;
  /**
   * Creator ZUID → invited Catalyst user_id, built from the backup's user lists
   * and the users state file by the CLI. Cells of a table's `userColumns` are
   * rewritten through it; without it (or for an unmapped ZUID) the cell is
   * stored as the source wrote it.
   */
  userIds?: ReadonlyMap<string, string>;
}

export interface TableMigrationResult {
  table: string;
  sourceCount: number;
  writtenCount: number;
  /** FNV-1a 64 of the source ids this run confirmed, in source order. */
  sourceChecksum: string;
  /** FNV-1a 64 of the acknowledged ids. Equals sourceChecksum when every row landed. */
  writtenChecksum: string;
  /**
   * FNV-1a 64 of `id + canonical cells` over the rows this run processed, present
   * only when the table carried schema columns. The written side folds the rows
   * read back at the end of the table run, so a stored value that was truncated,
   * rounded, or coerced after the echo flips it.
   */
  sourceValueChecksum?: string;
  writtenValueChecksum?: string;
  batches: number[];
  mismatch: boolean;
  /** Source ids the destination did not confirm. Empty when the run verified. */
  missingIds?: string[];
  /** Source ids whose stored row differs from what was sent. */
  differingIds?: string[];
  /** Set when the table stopped for a reason other than a short acknowledgement. The id itself is not included. */
  error?: string;
  /**
   * Source ids that occur more than once in this run. c2c_source_id is not a unique
   * column, so the mover refuses the table instead of storing the id twice.
   */
  duplicateIds?: string[];
  /** Stored NULL cells this run filled from the source on already-stored rows. */
  filledNulls?: number;
  /** Lookup cells holding a raw source record id that this run corrected to the mapped ROWID. */
  correctedLookups?: number;
}

export interface SystemFieldGap {
  table: string;
  missing: string[];
  detail: string;
}

export interface MigrateResult {
  ok: boolean;
  dryRun: boolean;
  tables: TableMigrationResult[];
  /** Set when a source row omitted Creator system columns. Import does not invent them. */
  systemFieldGaps?: SystemFieldGap[];
  /** Counts only. Ids and rule names, never cell values. */
  integrity?: IntegrityReport;
  /** Set when the run refused before the first write (pre-write rules, not a store reply). */
  error?: string;
}

export function emptyCheckpoint(): Checkpoint {
  return { version: 1, tables: {} };
}

export function fnv1a64(state: bigint, text: string): bigint {
  let hash = state;
  for (const byte of Buffer.from(`${text}\n`)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & 0xffffffffffffffffn;
  }
  return hash;
}

export function checksumHex(state: bigint): string {
  return state.toString(16).padStart(16, '0');
}

function parseChecksum(hex: string | undefined): bigint {
  if (!hex) return FNV_OFFSET;
  return BigInt(`0x${hex}`);
}

function clampBatch(size: number | undefined): number {
  if (size === undefined) return MAX_BATCH;
  if (!Number.isInteger(size) || size < 1) throw new Error('batchSize must be a positive integer');
  return Math.min(MAX_BATCH, size);
}

function clampLockTtl(size: number | undefined): number {
  if (size === undefined) return TABLE_LOCK_TTL_MS;
  if (!Number.isInteger(size) || size < 1) throw new Error('lockTtlMs must be a positive integer');
  return size;
}

/** 409 with an empty body counts: that is the Data Store status for DUPLICATE_VALUE. Any other code fails closed. */
function isUniqueViolation(status: number, body: string): boolean {
  const text = body.trim();
  if (/DUPLICATE_VALUE/i.test(text) || /duplicate value/i.test(text)) return true;
  return status === 409 && text.length === 0;
}

export function creatorUrl(base: string, owner: string, app: string, report: string): string {
  return `${base.replace(/\/$/, '')}/creator/v2.1/data/${encodeURIComponent(owner)}/${encodeURIComponent(app)}/report/${encodeURIComponent(report)}`;
}

/** Guarded org, project, and CLI bearer token. Seed and CSV writes must pass this. Absent only on the legacy dry-run mover. */
export interface CatalystScope {
  org: string;
  projectId: string;
  token: string;
}

export function catalystQueryUrl(base: string, scope?: CatalystScope): string {
  const root = base.replace(/\/$/, '');
  if (scope?.projectId) return `${root}/baas/v1/project/${encodeURIComponent(scope.projectId)}/query`;
  return `${root}/baas/v1/query`;
}

export function catalystWriteUrl(base: string, table: string, scope?: CatalystScope): string {
  const root = base.replace(/\/$/, '');
  const name = encodeURIComponent(table);
  if (scope?.projectId) return `${root}/baas/v1/project/${encodeURIComponent(scope.projectId)}/table/${name}/row`;
  return `${root}/baas/v1/table/${name}/row`;
}

/** Same headers the CLI's API client sets: CATALYST-ORG, Bearer token, Development environment. */
export function catalystAuthHeaders(scope: CatalystScope | undefined): Record<string, string> {
  if (!scope) return {};
  return {
    'CATALYST-ORG': scope.org,
    Authorization: `Bearer ${scope.token}`,
    'X-CATALYST-Environment': 'Development',
  };
}

function assertSqlIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`table name is not a ZCQL identifier: ${name}`);
  return name;
}

function sqlLiteral(id: string): string {
  return `'${id.replace(/'/g, "''")}'`;
}

/** One SELECT per chunk. Exported so the 300-id cap is tested without a live store. */
export function zcqlSourceIdQueries(table: string, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  const ident = assertSqlIdent(table);
  const queries: string[] = [];
  for (let i = 0; i < ids.length; i += ZCQL_IN_LIMIT) {
    const list = ids.slice(i, i + ZCQL_IN_LIMIT).map(sqlLiteral).join(', ');
    queries.push(`SELECT ${SOURCE_ID_COLUMN} FROM ${ident} WHERE ${SOURCE_ID_COLUMN} IN (${list})`);
  }
  return queries;
}

function readSourceId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, SOURCE_ID_COLUMN)) return undefined;
  const id = record[SOURCE_ID_COLUMN];
  if (id === undefined || id === null) return undefined;
  if (typeof id === 'string' || typeof id === 'number') {
    const text = exactId(id, SOURCE_ID_COLUMN);
    return text === '' ? undefined : text;
  }
  const text = String(id);
  return text === '' ? undefined : text;
}

function collectSourceIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as { rows?: unknown; data?: unknown };
  const ids: string[] = [];
  for (const bucket of [record.rows, record.data]) {
    if (!Array.isArray(bucket)) continue;
    for (const item of bucket) {
      const direct = readSourceId(item);
      if (direct) {
        ids.push(direct);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      for (const value of Object.values(item as Record<string, unknown>)) {
        const nested = readSourceId(value);
        if (nested) ids.push(nested);
      }
    }
  }
  return ids;
}

export interface SourceRow {
  id: string;
  columns: Record<string, unknown>;
  /** Canonical system columns this source row did not carry. */
  missingSystemFields: string[];
}

/** One Creator v2.1 Get Records page. Exported for the file-byte step, which reads the same pages. */
export async function readPage(fetch: FetchLike, url: string, cursor: string | null, dc: string): Promise<{ rows: SourceRow[]; nextCursor?: string }> {
  assertAllowedHost(url, dc);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cursor) headers.record_cursor = cursor;
  const response = await fetch(url, { method: 'GET', headers });
  if (response.status >= 400) throw new Error(`creator read failed: ${response.status}`);
  // Creator ids are 19 digits; a bare one in the reply must not round. Safe numbers stay numbers.
  const body = parseJsonLossless(await response.text()) as { data?: unknown; record_cursor?: unknown };
  const data = Array.isArray(body.data) ? body.data : [];
  const rows: SourceRow[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') throw new Error('creator row is not an object');
    const record = item as Record<string, unknown>;
    const id = record.ID ?? record.id;
    if (id === undefined || id === null || String(id) === '') throw new Error('creator row is missing an id');
    const columns: Record<string, unknown> = {};
    const seenSystem = new Set<string>();
    for (const [key, value] of Object.entries(record)) {
      if (key === 'ID' || key === 'id') continue;
      const system = systemFieldColumn(key);
      if (system) {
        columns[system] = value;
        seenSystem.add(system);
        continue;
      }
      columns[key] = value;
    }
    const missingSystemFields = SYSTEM_FIELD_COLUMNS.map((column) => column.name).filter((name) => !seenSystem.has(name));
    rows.push({ id: String(id), columns, missingSystemFields });
  }
  const headerCursor = response.headers.get('record_cursor');
  const bodyCursor = typeof body.record_cursor === 'string' ? body.record_cursor : undefined;
  const next = headerCursor || bodyCursor || undefined;
  return { rows, nextCursor: next };
}

function withFileKeys(id: string, columns: Record<string, unknown>, files: MigrateTable['files']): Record<string, unknown> {
  if (!files) return columns;
  let out = columns;
  for (const column of files.columns) {
    if (!Object.hasOwn(columns, column)) continue;
    if (out === columns) out = { ...columns };
    out[column] = migratedObjectKey(files.form, column, id, columns[column]);
  }
  return out;
}

function withShadowColumns(columns: Record<string, unknown>, shadows: Readonly<Record<string, string>> | undefined): Record<string, unknown> {
  if (!shadows) return columns;
  let out = columns;
  for (const [exact, shadow] of Object.entries(shadows)) {
    if (!Object.hasOwn(columns, exact) || Object.hasOwn(columns, shadow)) continue;
    if (out === columns) out = { ...columns };
    out[shadow] = decimalShadow(columns[exact]);
  }
  return out;
}

interface BatchWrite {
  ids: string[];
  /** Ids whose insert returned 400/5xx but whose stored row matches the payload. */
  unknownIds: string[];
  refusals: IntegrityRefusal[];
}

interface WriteTarget {
  table: string;
  base: string;
  columns?: readonly IntegrityColumn[];
  /** Columns whose stored NULL may be filled: the system timestamps plus the load's marks. */
  fillNulls?: ReadonlySet<string>;
  /** Lookup column → source record id → destination ROWID, for correcting stored raw ids. */
  lookupIds?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Users-field column names (Creator ZUID cells are remapped to the invited Catalyst user id). */
  userColumns?: ReadonlySet<string>;
  /** Creator ZUID → invited Catalyst user_id for this run. */
  userIds?: ReadonlyMap<string, string>;
}

/**
 * One source row checked and ready to write. `canon` is the canonical fingerprint
 * of the cells that will be sent (system columns and the source id aside); the
 * end-of-table read-back hashes the stored row with the same keys and columns and
 * the two checksums must match.
 */
interface PreparedRow {
  row: SourceRow;
  payload: Record<string, unknown>;
  refusals: IntegrityRefusal[];
  canon: string;
  keys: string[];
  /** User-identity cells this row rewrote (column → the source's raw value), for correcting a stored pre-remap value. */
  userRewrites: { column: string; from: string }[];
}

/**
 * The one identity rewrite the load applies, the same rule `c2c users` invites
 * by: Added_User/Modified_User cells carrying an email are normalised to the
 * canonical mailbox (see schema/src/identity.ts), and Users-field cells trade
 * the Creator ZUID for the invited Catalyst user id when a map was given.
 * Every rewrite is recorded on the row so a stored pre-remap value is corrected
 * by ROWID instead of tripping the silent-change refusal.
 */
function rewriteUserCells(
  columns: Record<string, unknown>,
  target: WriteTarget,
): { columns: Record<string, unknown>; rewrites: { column: string; from: string }[] } {
  const rewrites: { column: string; from: string }[] = [];
  let out = columns;
  const set = (column: string, value: string): void => {
    if (out === columns) out = { ...columns };
    out[column] = value;
  };
  for (const column of ['Added_User', 'Modified_User']) {
    const value = out[column];
    if (typeof value !== 'string' || !value.includes('@')) continue;
    const canonical = canonicalUserIdentity(value);
    if (canonical !== value) {
      set(column, canonical);
      rewrites.push({ column, from: value });
    }
  }
  if (target.userColumns?.size && target.userIds?.size) {
    for (const column of target.userColumns) {
      const value = out[column];
      if (value === undefined || value === null || value === '') continue;
      const mapped = target.userIds.get(String(value));
      if (mapped && mapped !== value) {
        set(column, mapped);
        rewrites.push({ column, from: String(value) });
      }
    }
  }
  return { columns: out, rewrites };
}

function prepareRow(
  row: SourceRow,
  target: WriteTarget,
  shadows: Readonly<Record<string, string>> | undefined,
  files: MigrateTable['files'],
): PreparedRow {
  const rewritten = rewriteUserCells(withShadowColumns(withFileKeys(row.id, row.columns, files), shadows), target);
  const prepared = prepareColumns(target.columns, rewritten.columns);
  const payload = { ...prepared.cells, [SOURCE_ID_COLUMN]: row.id };
  const keys = dataKeys(payload);
  return {
    row,
    payload,
    refusals: prepared.refusals.map((item) => ({ table: target.table, column: item.column, sourceId: row.id, rule: item.rule })),
    canon: canonRow(payload, keys, target.columns),
    keys,
    userRewrites: rewritten.rewrites,
  };
}

/** column → the raw source values this run's rows rewrote, for stored-cell correction. */
function userRewriteMap(rows: readonly PreparedRow[]): Map<string, Set<string>> | undefined {
  const out = new Map<string, Set<string>>();
  for (const item of rows) {
    for (const rewrite of item.userRewrites) {
      const set = out.get(rewrite.column) ?? new Set<string>();
      set.add(rewrite.from);
      out.set(rewrite.column, set);
    }
  }
  return out.size ? out : undefined;
}

/** Keys that carry a cell value. ROWID and c2c_source_id are not compared. */
function dataKeys(row: Record<string, unknown>): string[] {
  return Object.keys(row).filter((key) => key !== 'ROWID' && key !== SOURCE_ID_COLUMN);
}

function identifierColumns(payloads: readonly Record<string, unknown>[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const payload of payloads) {
    for (const key of Object.keys(payload)) {
      if (key === SOURCE_ID_COLUMN || seen.has(key)) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }
  return names;
}

function zcqlStoredRowQueries(table: string, columns: readonly string[], ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  const ident = assertSqlIdent(table);
  // ROWID is selected so a NULL fill can name the stored row it updates.
  const selected = ['ROWID', SOURCE_ID_COLUMN, ...columns.map((name) => assertSqlIdent(name))].join(', ');
  const queries: string[] = [];
  for (let i = 0; i < ids.length; i += ZCQL_IN_LIMIT) {
    const list = ids.slice(i, i + ZCQL_IN_LIMIT).map(sqlLiteral).join(', ');
    queries.push(`SELECT ${selected} FROM ${ident} WHERE ${SOURCE_ID_COLUMN} IN (${list})`);
  }
  return queries;
}

/** Rows that carry c2c_source_id. A nested ZCQL object is one row, not two. */
function extractQueryRows(body: unknown): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (readSourceId(record)) {
      rows.push(record);
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  if (!body || typeof body !== 'object') return rows;
  const record = body as { rows?: unknown; data?: unknown };
  visit(record.rows);
  visit(record.data);
  return rows;
}

function rememberRow(found: Map<string, Record<string, unknown>[]>, row: Record<string, unknown>): void {
  const id = readSourceId(row);
  if (!id) return;
  const list = found.get(id);
  if (list) list.push(row);
  else found.set(id, [row]);
}

function duplicateSourceIds(found: ReadonlyMap<string, readonly unknown[]>): string[] {
  const ids: string[] = [];
  for (const [id, rows] of found) if (rows.length > 1) ids.push(id);
  return ids;
}

function duplicateRefusals(table: string, ids: readonly string[]): IntegrityRefusal[] {
  return ids.map((sourceId) => ({ table, column: SOURCE_ID_COLUMN, sourceId, rule: 'duplicate-source-id' }));
}

async function queryStoredRows(
  fetch: FetchLike,
  base: string,
  table: string,
  ids: readonly string[],
  columns: readonly string[],
  dc: string,
  scope?: CatalystScope,
): Promise<Map<string, Record<string, unknown>[]>> {
  const found = new Map<string, Record<string, unknown>[]>();
  const url = catalystQueryUrl(base, scope);
  for (const query of zcqlStoredRowQueries(table, columns, ids)) {
    assertAllowedHost(url, dc);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...catalystAuthHeaders(scope) },
      body: JSON.stringify({ query }),
    });
    const text = await response.text();
    if (response.status >= 400) {
      throw new Error(`catalyst query failed: ${response.status}${catalystErrorDetail(text)} (POST ${pathOf(url)}, table ${table})`);
    }
    for (const row of extractQueryRows(parseJsonExact(text))) rememberRow(found, row);
  }
  return found;
}

/** One stored NULL cell the source supplies, addressed by the row's ROWID. */
interface NullFill {
  sourceId: string;
  rowid: string;
  column: string;
  value: unknown;
}

function silentRefusals(
  table: string,
  payloads: readonly Record<string, unknown>[],
  storedById: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  columns: readonly IntegrityColumn[] | undefined,
  fillable?: ReadonlySet<string>,
  lookupIds?: ReadonlyMap<string, ReadonlyMap<string, string>>,
  userRewrites?: ReadonlyMap<string, ReadonlySet<string>>,
): { refusals: IntegrityRefusal[]; missing: string[]; fills: NullFill[]; corrections: NullFill[] } {
  const refusals: IntegrityRefusal[] = [];
  const missing: string[] = [];
  const fills: NullFill[] = [];
  const corrections: NullFill[] = [];
  for (const payload of payloads) {
    const id = String(payload[SOURCE_ID_COLUMN] ?? '');
    const stored = storedById.get(id);
    if (!stored?.length) {
      missing.push(id);
      continue;
    }
    // Two rows for one source id is a duplicate even when one of them matches.
    if (stored.length > 1) {
      refusals.push({ table, column: SOURCE_ID_COLUMN, sourceId: id, rule: 'duplicate-source-id' });
      continue;
    }
    const row = stored[0]!;
    // An id-only echo cannot show a silent change. Callers that only return the id stay on the old ack.
    if (dataKeys(row).length === 0) continue;
    const rowid = row.ROWID === undefined || row.ROWID === null ? '' : String(row.ROWID);
    for (const column of changedColumns(payload, row, columns)) {
      // A stored NULL the source supplies on a fillable column is a fill, but
      // only when the row can be addressed by ROWID.
      if (fillable?.has(column) && rowid && isEmptyCell(row[column]) && !isEmptyCell(payload[column])) {
        fills.push({ sourceId: id, rowid, column, value: payload[column] });
        continue;
      }
      // A stored cell still holding a raw source record id is the pre-remap
      // defect: this load writes the parent's ROWID. Correct it by ROWID update.
      if (lookupIds?.get(column)?.has(String(row[column] ?? '')) && rowid) {
        corrections.push({ sourceId: id, rowid, column, value: payload[column] });
        continue;
      }
      // A stored user cell still holding the pre-normalisation identity (a
      // Gmail '+'/dot variant, or a raw Creator ZUID) is corrected to the
      // value this run sent — same ROWID update path as a lookup correction.
      if (userRewrites?.get(column)?.has(String(row[column] ?? '')) && rowid) {
        corrections.push({ sourceId: id, rowid, column, value: payload[column] });
        continue;
      }
      refusals.push({ table, column, sourceId: id, rule: 'silent-change' });
    }
  }
  return { refusals, missing, fills, corrections };
}

/**
 * Fill stored NULL cells on rows that already exist: one PUT /row per batch,
 * addressed by ROWID, then a read-back. A cell that still differs after the
 * update is a silent-change refusal; a failed update throws.
 */
async function fillNullCells(
  fetch: FetchLike,
  target: WriteTarget,
  dc: string,
  scope: CatalystScope | undefined,
  fills: readonly NullFill[],
): Promise<{ filled: number; refusals: IntegrityRefusal[] }> {
  const byRow = new Map<string, Record<string, unknown>>();
  for (const fill of fills) {
    const row = byRow.get(fill.rowid) ?? { ROWID: fill.rowid };
    row[fill.column] = fill.value;
    byRow.set(fill.rowid, row);
  }
  const url = catalystWriteUrl(target.base, target.table, scope);
  assertAllowedHost(url, dc);
  const updates = [...byRow.values()];
  for (let i = 0; i < updates.length; i += MAX_BATCH) {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...catalystAuthHeaders(scope) },
      body: JSON.stringify(updates.slice(i, i + MAX_BATCH)),
    });
    const text = await response.text();
    if (response.status >= 400) {
      throw new Error(`catalyst row update failed: ${response.status}${catalystErrorDetail(text)} (PUT ${pathOf(url)})`);
    }
  }
  // Read the rows back: a fill the store dropped is a silent change after all.
  const ids = [...new Set(fills.map((fill) => fill.sourceId))];
  const names = [...new Set(fills.map((fill) => fill.column))];
  const stored = await queryStoredRows(fetch, target.base, target.table, ids, names, dc, scope);
  const refusals: IntegrityRefusal[] = [];
  let filled = 0;
  for (const fill of fills) {
    const row = (stored.get(fill.sourceId) ?? []).find((item) => String(item.ROWID ?? '') === fill.rowid);
    const probe = { [fill.column]: fill.value };
    if (row && changedColumns(probe, row, target.columns).length === 0) filled += 1;
    else refusals.push({ table: target.table, column: fill.column, sourceId: fill.sourceId, rule: 'silent-change' });
  }
  return { filled, refusals };
}

function echoResult(
  table: string,
  payloads: readonly Record<string, unknown>[],
  echoed: readonly Record<string, unknown>[],
  columns: readonly IntegrityColumn[] | undefined,
): BatchWrite {
  const byId = new Map<string, Record<string, unknown>[]>();
  for (const row of echoed) rememberRow(byId, row);
  const duplicates = duplicateSourceIds(byId);
  if (duplicates.length) return { ids: [], unknownIds: [], refusals: duplicateRefusals(table, duplicates) };
  const refusals: IntegrityRefusal[] = [];
  const ids: string[] = [];
  for (const payload of payloads) {
    const id = String(payload[SOURCE_ID_COLUMN] ?? '');
    const stored = byId.get(id)?.[0];
    if (!stored) continue;
    if (dataKeys(stored).length === 0) {
      ids.push(id);
      continue;
    }
    const changed = changedColumns(payload, stored, columns);
    if (changed.length === 0) ids.push(id);
    else for (const column of changed) refusals.push({ table, column, sourceId: id, rule: 'silent-change' });
  }
  if (refusals.length) return { ids: [], unknownIds: [], refusals };
  return { ids, unknownIds: [], refusals: [] };
}

async function writeBatch(
  fetch: FetchLike,
  url: string,
  rows: PreparedRow[],
  dc: string,
  dryRun: boolean,
  scope: CatalystScope | undefined,
  target: WriteTarget,
): Promise<BatchWrite> {
  assertAllowedHost(url, dc);
  const refusals = rows.flatMap((item) => item.refusals);
  if (refusals.length) return { ids: [], unknownIds: [], refusals };
  if (dryRun) return { ids: rows.map((item) => item.row.id), unknownIds: [], refusals: [] };
  const payloads = rows.map((item) => item.payload);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...catalystAuthHeaders(scope) },
    body: JSON.stringify(payloads),
  });
  const text = await response.text();
  if (response.status >= 400) {
    const detail = catalystErrorDetail(text);
    if (isUniqueViolation(response.status, text)) throw new UniqueViolationError(response.status, detail);
    const failure = new Error(`catalyst write failed: ${response.status}${detail} (POST ${pathOf(url)})`);
    // 403 and 404 fail closed. 400 and 5xx may have written the row anyway.
    if (response.status !== 400 && response.status < 500) throw failure;
    let stored: Map<string, Record<string, unknown>[]>;
    try {
      stored = await queryStoredRows(
        fetch,
        target.base,
        target.table,
        rows.map((item) => item.row.id),
        identifierColumns(payloads),
        dc,
        scope,
      );
    } catch {
      throw failure;
    }
    const diff = silentRefusals(target.table, payloads, stored, target.columns, undefined, undefined, userRewriteMap(rows));
    if (diff.refusals.length) return { ids: [], unknownIds: [], refusals: diff.refusals };
    if (diff.missing.length) throw failure;
    const ids = rows.map((item) => item.row.id);
    return { ids, unknownIds: ids, refusals: [] };
  }
  const body = parseJsonExact(text);
  // The 200 body can list one row while the table holds two. Count the stored rows.
  const recounted = await queryStoredRows(fetch, target.base, target.table, rows.map((item) => item.row.id), identifierColumns(payloads), dc, scope);
  const duplicates = duplicateSourceIds(recounted);
  if (duplicates.length) return { ids: [], unknownIds: [], refusals: duplicateRefusals(target.table, duplicates) };
  // Without a schema the ack stays the id list. It is not a verified write.
  if (!target.columns?.length) return { ids: collectSourceIds(body), unknownIds: [], refusals: [] };
  const echoed = extractQueryRows(body);
  if (echoed.length === 0) return { ids: collectSourceIds(body), unknownIds: [], refusals: [] };
  return echoResult(target.table, payloads, echoed, target.columns);
}

/**
 * Present rows are checked before another insert. A mismatch blocks the slice,
 * including new ids. Stored NULL cells on fillable columns and lookup cells
 * still holding a raw source id are updated by ROWID and counted; they do not
 * block the slice.
 */
async function alreadyStoredRefusals(
  fetch: FetchLike,
  rows: readonly PreparedRow[],
  present: ReadonlySet<string>,
  dc: string,
  scope: CatalystScope | undefined,
  target: WriteTarget,
): Promise<{ refusals: IntegrityRefusal[]; filled: number; corrected: number }> {
  if (!target.columns?.length || present.size === 0) return { refusals: [], filled: 0, corrected: 0 };
  const pending = rows.filter((item) => present.has(item.row.id));
  const refusals = pending.flatMap((item) => item.refusals);
  if (refusals.length) return { refusals, filled: 0, corrected: 0 };
  const payloads = pending.map((item) => item.payload);
  const stored = await queryStoredRows(
    fetch,
    target.base,
    target.table,
    pending.map((item) => item.row.id),
    identifierColumns(payloads),
    dc,
    scope,
  );
  const diff = silentRefusals(target.table, payloads, stored, target.columns, target.fillNulls, target.lookupIds, userRewriteMap(rows));
  if (diff.refusals.length || (!diff.fills.length && !diff.corrections.length)) {
    return { refusals: diff.refusals, filled: 0, corrected: 0 };
  }
  const out: IntegrityRefusal[] = [];
  let filled = 0;
  let corrected = 0;
  if (diff.fills.length) {
    const applied = await fillNullCells(fetch, target, dc, scope, diff.fills);
    filled = applied.filled;
    out.push(...applied.refusals);
  }
  if (diff.corrections.length) {
    const applied = await fillNullCells(fetch, target, dc, scope, diff.corrections);
    corrected = applied.filled;
    out.push(...applied.refusals);
  }
  return { refusals: out, filled, corrected };
}

function save(checkpoint: Checkpoint, saveCheckpoint: MigrateOptions['saveCheckpoint']): void {
  saveCheckpoint?.(checkpoint);
}

interface SourceIdScan {
  present: Set<string>;
  /** Source ids that came back more than once. Order is the first time each id repeated. */
  duplicates: string[];
}

async function queryExistingSourceIds(
  fetch: FetchLike,
  base: string,
  table: string,
  ids: readonly string[],
  dc: string,
  scope?: CatalystScope,
): Promise<SourceIdScan> {
  const counts = new Map<string, number>();
  const url = catalystQueryUrl(base, scope);
  for (const query of zcqlSourceIdQueries(table, ids)) {
    assertAllowedHost(url, dc);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...catalystAuthHeaders(scope) },
      body: JSON.stringify({ query }),
    });
    if (response.status >= 400) {
      throw new Error(`catalyst query failed: ${response.status}${catalystErrorDetail(await response.text())} (POST ${pathOf(url)}, table ${table})`);
    }
    for (const id of collectSourceIds(parseJsonExact(await response.text()))) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const present = new Set<string>();
  const duplicates: string[] = [];
  for (const [id, count] of counts) {
    present.add(id);
    if (count > 1) duplicates.push(id);
  }
  return { present, duplicates };
}

/** Ack ids in slice order. Rows already stored contribute their source id; new rows consume the POST ack in order. */
function writtenIdsForSlice(slice: SourceRow[], present: ReadonlySet<string>, acked: readonly string[]): string[] {
  const pending = [...acked];
  const ids: string[] = [];
  for (const row of slice) {
    if (present.has(row.id)) ids.push(row.id);
    else ids.push(pending.shift() ?? row.id);
  }
  return ids;
}

/** How many leading source rows were confirmed, in order. A hole stops the prefix. */
function confirmedPrefix(slice: SourceRow[], acked: string[]): number {
  const pool = new Map<string, number>();
  for (const id of acked) pool.set(id, (pool.get(id) ?? 0) + 1);
  let count = 0;
  for (const row of slice) {
    const left = pool.get(row.id) ?? 0;
    if (left <= 0) break;
    pool.set(row.id, left - 1);
    count += 1;
  }
  return count;
}

export async function migrateData(opts: MigrateOptions): Promise<MigrateResult> {
  if (opts.checkpoint.version !== 1) throw new Error('checkpoint version must be 1');
  opts.checkpoint.tables ??= {};
  const batch = clampBatch(opts.batchSize);
  const ttl = clampLockTtl(opts.lockTtlMs);
  const owner = opts.runId ?? randomUUID();
  const now = () => opts.now?.() ?? Date.now();
  const results: TableMigrationResult[] = [];
  const systemGaps = new Map<string, Set<string>>();
  const refusalLog: IntegrityRefusal[] = [];
  let writtenVerified = 0;
  let unverified = 0;
  let filledNullCells = 0;
  let correctedLookupCells = 0;
  const unknownIdsLogged: string[] = [];
  const finish = (ok: boolean): MigrateResult => {
    const systemFieldGaps = [...systemGaps.entries()].map(([table, missing]) => ({
      table,
      missing: SYSTEM_FIELD_COLUMNS.map((column) => column.name).filter((name) => missing.has(name)),
      detail: SYSTEM_FIELD_COVERAGE_GAP,
    }));
    const integrity: IntegrityReport = {
      written: writtenVerified,
      unverified,
      verified: unverified === 0,
      filledNulls: filledNullCells,
      correctedLookups: correctedLookupCells,
      unknownThenFound: unknownIdsLogged.length,
      unknownThenFoundIds: [...unknownIdsLogged],
      refusedByRule: groupRefusals(refusalLog),
    };
    return { ok, dryRun: opts.dryRun, tables: results, integrity, ...(systemFieldGaps.length ? { systemFieldGaps } : {}) };
  };
  const noteAck = (ids: readonly string[], presentIds: ReadonlySet<string>, unknown: ReadonlySet<string>, schemaChecked: boolean): void => {
    for (const id of ids) {
      if (presentIds.has(id)) continue;
      if (unknown.has(id)) unknownIdsLogged.push(id);
      else if (schemaChecked) writtenVerified += 1;
      else unverified += 1;
    }
  };
  const hold = (next: TableCheckpoint): TableCheckpoint => {
    if (opts.dryRun) return next;
    return { ...next, lock: { owner, expiresAt: now() + ttl } };
  };
  const release = (next: TableCheckpoint): TableCheckpoint => {
    if (opts.dryRun || !next.lock) return next;
    const copy = { ...next };
    delete copy.lock;
    return copy;
  };
  perTable: for (const table of opts.tables) {
    const readUrl = creatorUrl(opts.creatorBase, opts.owner, opts.appLink, table.report);
    const writeUrl = catalystWriteUrl(opts.catalystBase, table.table, opts.scope);
    const target: WriteTarget = {
      table: table.table,
      base: opts.catalystBase,
      columns: table.integrityColumns,
      fillNulls: new Set([...FILLABLE_NULL_COLUMNS, ...(table.fillNullColumns ?? [])]),
      ...(table.lookupSourceIds ? { lookupIds: new Map(Object.entries(table.lookupSourceIds)) } : {}),
      ...(table.userColumns?.length ? { userColumns: new Set(table.userColumns) } : {}),
      ...(opts.userIds?.size ? { userIds: opts.userIds } : {}),
    };
    let tableFilledNulls = 0;
    let tableCorrectedLookups = 0;
    // Refuse a bad host before any fetch, including the other side of the pair.
    assertAllowedHost(readUrl, opts.dc);
    assertAllowedHost(writeUrl, opts.dc);
    let state: TableCheckpoint = opts.checkpoint.tables[table.table] ?? {
      requestCursor: null,
      count: 0,
      checksum: checksumHex(FNV_OFFSET),
      sourceCount: 0,
      sourceChecksum: checksumHex(FNV_OFFSET),
      done: false,
    };
    const park = (err: unknown): never => {
      state = release(state);
      opts.checkpoint.tables[table.table] = state;
      save(opts.checkpoint, opts.saveCheckpoint);
      // NULL fills and lookup corrections earlier slices already confirmed are
      // correct but the result is lost with this throw; name the counts on the
      // error so they are seen.
      if (err instanceof Error && (filledNullCells > 0 || correctedLookupCells > 0)) {
        const updates = filledNullCells + correctedLookupCells;
        err.message += `; ${updates} stored cell update(s) reached the store before this failure and are not in the report`;
      }
      throw err;
    };
    // Stamp the lease before the first await so a second call on this object cannot write.
    if (!opts.dryRun && !state.done) {
      const lock = state.lock;
      const clock = now();
      if (lock && lock.owner !== owner && lock.expiresAt > clock) {
        throw new TableLockedError(table.table, lock.owner, lock.expiresAt);
      }
      state = hold(state);
      opts.checkpoint.tables[table.table] = state;
    }
    const batches: number[] = [];
    // Resume the source ledger from its own checksum. Seeding it from the written
    // checksum makes a later verification compare the checkpoint with itself.
    let sourceState = state.sourceChecksum !== undefined ? parseChecksum(state.sourceChecksum) : FNV_OFFSET;
    let writtenState = parseChecksum(state.checksum);
    let sourceCount = state.sourceCount ?? 0;
    try {
      const seen = new Set<string>();
      /** Canonical fingerprints of this run's rows, for the end-of-table read-back. */
      const canonById = new Map<string, { canon: string; keys: string[]; payload: Record<string, unknown> }>();
      while (!state.done) {
        const page = await readPage(opts.fetch, readUrl, state.requestCursor, opts.dc).catch((err: unknown) => park(err));
        let rows = page.rows;
        if (state.lastId) {
          const index = rows.findIndex((row) => row.id === state.lastId);
          if (index >= 0) rows = rows.slice(index + 1);
        }
        for (const row of rows) {
          if (!row.missingSystemFields.length) continue;
          const set = systemGaps.get(table.table) ?? new Set<string>();
          for (const name of row.missingSystemFields) set.add(name);
          systemGaps.set(table.table, set);
        }
        // c2c_source_id is not a unique column. A repeated source id is refused before
        // any row of this page is written, so the store never holds one id twice.
        const duplicateIds: string[] = [];
        for (const row of rows) {
          if (seen.has(row.id)) {
            if (!duplicateIds.includes(row.id)) duplicateIds.push(row.id);
          } else seen.add(row.id);
        }
        if (duplicateIds.length) {
          state = release(state);
          opts.checkpoint.tables[table.table] = state;
          save(opts.checkpoint, opts.saveCheckpoint);
          results.push({
            table: table.table,
            sourceCount,
            writtenCount: state.count,
            sourceChecksum: checksumHex(sourceState),
            writtenChecksum: checksumHex(writtenState),
            batches,
            mismatch: true,
            missingIds: [],
            duplicateIds,
            ...(tableFilledNulls ? { filledNulls: tableFilledNulls } : {}),
            ...(tableCorrectedLookups ? { correctedLookups: tableCorrectedLookups } : {}),
            error: `source repeats ${duplicateIds.length} record id(s); c2c_source_id must be unique per table`,
          });
          continue perTable;
        }
        const tooLong = rows.find((row) => row.id.length > SOURCE_ID_MAX_LENGTH);
        if (tooLong) {
          state = release(state);
          opts.checkpoint.tables[table.table] = state;
          save(opts.checkpoint, opts.saveCheckpoint);
          results.push({
            table: table.table,
            sourceCount,
            writtenCount: state.count,
            sourceChecksum: checksumHex(sourceState),
            writtenChecksum: checksumHex(writtenState),
            batches,
            mismatch: true,
            missingIds: [],
            ...(tableFilledNulls ? { filledNulls: tableFilledNulls } : {}),
            ...(tableCorrectedLookups ? { correctedLookups: tableCorrectedLookups } : {}),
            error: `source id length ${tooLong.id.length} exceeds ${SOURCE_ID_MAX_LENGTH}`,
          });
          continue perTable;
        }
        for (let i = 0; i < rows.length; ) {
          const slice = rows.slice(i, i + batch);
          // Check every cell — including a missing mandatory column — before the
          // reconcile query, so a bad row refuses the slice before any write.
          const prepared = slice.map((row) => prepareRow(row, target, table.shadows, table.files));
          for (const item of prepared) canonById.set(item.row.id, { canon: item.canon, keys: item.keys, payload: item.payload });
          let present = new Set<string>();
          let toWrite = prepared;
          let acked: string[] = [];
          let unknownIds: string[] = [];
          let blocked: IntegrityRefusal[] = prepared.flatMap((item) => item.refusals);
          try {
            if (!opts.dryRun && !blocked.length) {
              const scan = await queryExistingSourceIds(opts.fetch, opts.catalystBase, table.table, slice.map((row) => row.id), opts.dc, opts.scope);
              present = scan.present;
              const prior = scan.duplicates.length
                ? { refusals: duplicateRefusals(table.table, scan.duplicates), filled: 0, corrected: 0 }
                : await alreadyStoredRefusals(opts.fetch, prepared, present, opts.dc, opts.scope, target);
              blocked = prior.refusals;
              tableFilledNulls += prior.filled;
              filledNullCells += prior.filled;
              tableCorrectedLookups += prior.corrected;
              correctedLookupCells += prior.corrected;
              if (!blocked.length) {
                toWrite = prepared.filter((item) => !present.has(item.row.id));
                const maxAttempts = Math.max(toWrite.length, 1);
                let attempt = 0;
                while (toWrite.length > 0) {
                  try {
                    const batchWrite = await writeBatch(opts.fetch, writeUrl, toWrite, opts.dc, false, opts.scope, target);
                    if (batchWrite.refusals.length) {
                      blocked = batchWrite.refusals;
                      acked = [];
                      break;
                    }
                    acked = batchWrite.ids;
                    unknownIds = batchWrite.unknownIds;
                    break;
                  } catch (err) {
                    if (!(err instanceof UniqueViolationError)) throw err;
                    attempt += 1;
                    const found = await queryExistingSourceIds(opts.fetch, opts.catalystBase, table.table, toWrite.map((item) => item.row.id), opts.dc, opts.scope);
                    if (found.duplicates.length) {
                      blocked = duplicateRefusals(table.table, found.duplicates);
                      acked = [];
                      break;
                    }
                    if (found.present.size === 0 || attempt > maxAttempts) throw err;
                    for (const id of found.present) present.add(id);
                    const next = toWrite.filter((item) => !present.has(item.row.id));
                    if (next.length === toWrite.length) throw err;
                    toWrite = next;
                    acked = [];
                  }
                }
              }
            } else if (opts.dryRun && !blocked.length) {
              const batchWrite = await writeBatch(opts.fetch, writeUrl, prepared, opts.dc, true, opts.scope, target);
              if (batchWrite.refusals.length) blocked = batchWrite.refusals;
              else acked = batchWrite.ids;
            }
          } catch (err) {
            park(err);
          }
          if (blocked.length) {
            refusalLog.push(...blocked);
            state = release(state);
            opts.checkpoint.tables[table.table] = state;
            save(opts.checkpoint, opts.saveCheckpoint);
            const duplicateIds = [...new Set(blocked.filter((item) => item.rule === 'duplicate-source-id').map((item) => item.sourceId))];
            const beforeWrite = blocked.every((item) => item.rule !== 'silent-change' && item.rule !== 'duplicate-source-id');
            results.push({
              table: table.table,
              sourceCount,
              writtenCount: state.count,
              sourceChecksum: checksumHex(sourceState),
              writtenChecksum: checksumHex(writtenState),
              batches,
              mismatch: true,
              missingIds: [],
              ...(duplicateIds.length ? { duplicateIds } : {}),
              ...(tableFilledNulls ? { filledNulls: tableFilledNulls } : {}),
              ...(tableCorrectedLookups ? { correctedLookups: tableCorrectedLookups } : {}),
              error: duplicateIds.length
                ? `duplicate c2c_source_id (${duplicateIds.length}); extra rows are already stored`
                : beforeWrite
                  ? `refused ${blocked.length} value(s) before write`
                  : `stored value differs for ${blocked.length} column(s)`,
            });
            continue perTable;
          }
          batches.push(slice.length);
          const unknown = new Set(unknownIds);
          if (toWrite.length === 0 || acked.length === toWrite.length) {
            for (const row of slice) {
              sourceState = fnv1a64(sourceState, row.id);
              sourceCount += 1;
            }
            noteAck(acked, present, unknown, Boolean(table.integrityColumns?.length));
            for (const id of writtenIdsForSlice(slice, present, acked)) writtenState = fnv1a64(writtenState, id);
            state = hold({
              requestCursor: state.requestCursor,
              lastId: slice[slice.length - 1].id,
              count: state.count + slice.length,
              checksum: checksumHex(writtenState),
              sourceCount,
              sourceChecksum: checksumHex(sourceState),
              done: false,
            });
            opts.checkpoint.tables[table.table] = state;
            save(opts.checkpoint, opts.saveCheckpoint);
            i += slice.length;
            continue;
          }
          const confirmed = confirmedPrefix(slice, [...slice.filter((row) => present.has(row.id)).map((row) => row.id), ...acked]);
          if (confirmed === 0) {
            const missing = slice.map((row) => row.id);
            let reportSource = sourceState;
            for (const row of slice) reportSource = fnv1a64(reportSource, row.id);
            let reportWritten = writtenState;
            for (const id of acked) reportWritten = fnv1a64(reportWritten, id);
            state = release(state);
            opts.checkpoint.tables[table.table] = state;
            save(opts.checkpoint, opts.saveCheckpoint);
            results.push({
              table: table.table,
              sourceCount,
              writtenCount: state.count,
              sourceChecksum: checksumHex(reportSource),
              writtenChecksum: checksumHex(reportWritten),
              batches,
              mismatch: true,
              missingIds: missing,
              ...(tableFilledNulls ? { filledNulls: tableFilledNulls } : {}),
              ...(tableCorrectedLookups ? { correctedLookups: tableCorrectedLookups } : {}),
            });
            continue perTable;
          }
          const prefix = slice.slice(0, confirmed);
          noteAck(prefix.map((row) => row.id), present, unknown, Boolean(table.integrityColumns?.length));
          for (const row of prefix) {
            sourceState = fnv1a64(sourceState, row.id);
            writtenState = fnv1a64(writtenState, row.id);
            sourceCount += 1;
          }
          state = hold({
            requestCursor: state.requestCursor,
            lastId: prefix[prefix.length - 1].id,
            count: state.count + prefix.length,
            checksum: checksumHex(writtenState),
            sourceCount,
            sourceChecksum: checksumHex(sourceState),
            done: false,
          });
          opts.checkpoint.tables[table.table] = state;
          save(opts.checkpoint, opts.saveCheckpoint);
          i += confirmed;
        }
        if (!page.nextCursor) {
          state = release({ ...state, requestCursor: state.requestCursor, lastId: undefined, done: true });
        } else {
          state = hold({ ...state, requestCursor: page.nextCursor, lastId: undefined, done: false });
        }
        opts.checkpoint.tables[table.table] = state;
        save(opts.checkpoint, opts.saveCheckpoint);
      }
      const sourceChecksum = checksumHex(sourceState);
      const writtenChecksum = checksumHex(writtenState);
      // Value fidelity: the source side folds id + canonical cells per row of this
      // run; the written side reads those ids back once more and folds the stored
      // rows with the same keys. A value Catalyst truncated, rounded, or coerced
      // after the write flips writtenValueChecksum, even when the row-level echo
      // checks let it through. A table resumed from a checkpoint folds the rows
      // this run saw; rows an earlier run verified keep their own evidence.
      // A stored row is the same as its source row exactly when the canonical
      // compare (changedColumns) finds no changed cell, so the store's own
      // spellings (a :SSS fraction, a trailing Z, Boolean text, NULL for empty)
      // fold to the source fingerprint and only a real change flips the checksum.
      let sourceValueChecksum: string | undefined;
      let writtenValueChecksum: string | undefined;
      let missingIds: string[] = [];
      let differingIds: string[] = [];
      let storedDupes: string[] = [];
      let verifyError: string | undefined;
      if (target.columns?.length && canonById.size) {
        let valueState = FNV_OFFSET;
        for (const [id, entry] of canonById) valueState = fnv1a64(valueState, `${id}\x00${entry.canon}`);
        sourceValueChecksum = checksumHex(valueState);
      }
      if (!opts.dryRun && sourceValueChecksum !== undefined) {
        try {
          const ids = [...canonById.keys()];
          const select = [...new Set([...canonById.values()].flatMap((entry) => entry.keys))].filter((name) =>
            /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
          );
          const stored = await queryStoredRows(opts.fetch, opts.catalystBase, table.table, ids, select, opts.dc, opts.scope);
          storedDupes = duplicateSourceIds(stored);
          const dupeSet = new Set(storedDupes);
          let valueState = FNV_OFFSET;
          for (const [id, entry] of canonById) {
            const rows = stored.get(id) ?? [];
            if (rows.length === 0 || dupeSet.has(id)) {
              valueState = fnv1a64(valueState, `${id}\x00-`);
              if (rows.length === 0) missingIds.push(id);
              continue;
            }
            const differs = changedColumns(entry.payload, rows[0]!, target.columns).length > 0;
            const canon = differs ? canonRow(rows[0]!, entry.keys, target.columns) : entry.canon;
            valueState = fnv1a64(valueState, `${id}\x00${canon}`);
            if (differs) differingIds.push(id);
          }
          writtenValueChecksum = checksumHex(valueState);
        } catch (err) {
          verifyError = `fidelity read-back failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      const valueMismatch =
        verifyError !== undefined ||
        missingIds.length > 0 ||
        differingIds.length > 0 ||
        storedDupes.length > 0 ||
        (sourceValueChecksum !== undefined && writtenValueChecksum !== undefined && sourceValueChecksum !== writtenValueChecksum);
      results.push({
        table: table.table,
        sourceCount,
        writtenCount: state.count,
        sourceChecksum,
        writtenChecksum,
        ...(sourceValueChecksum !== undefined ? { sourceValueChecksum } : {}),
        ...(writtenValueChecksum !== undefined ? { writtenValueChecksum } : {}),
        batches,
        mismatch: sourceChecksum !== writtenChecksum || sourceCount !== state.count || valueMismatch,
        missingIds,
        ...(differingIds.length ? { differingIds } : {}),
        ...(storedDupes.length ? { duplicateIds: storedDupes } : {}),
        ...(verifyError ? { error: verifyError } : {}),
        ...(tableFilledNulls ? { filledNulls: tableFilledNulls } : {}),
        ...(tableCorrectedLookups ? { correctedLookups: tableCorrectedLookups } : {}),
      });
    } catch (err) {
      // A table whose load fails is recorded, the lease released, and the run
      // continues with the next table: one refused table must not leave the
      // rest of the app empty. The result set still reports every table and
      // ok is false, so the caller exits non-zero. Host and lease refusals
      // (assertAllowedHost, TableLockedError) are raised before this block and
      // still abort the run.
      const message = err instanceof Error ? err.message : String(err);
      const held = opts.checkpoint.tables[table.table];
      if (held?.lock?.owner === owner) {
        const copy = { ...held };
        delete copy.lock;
        opts.checkpoint.tables[table.table] = copy;
      }
      results.push({
        table: table.table,
        sourceCount,
        writtenCount: state.count,
        sourceChecksum: checksumHex(sourceState),
        writtenChecksum: checksumHex(writtenState),
        batches: [...batches],
        mismatch: true,
        missingIds: [],
        ...(tableFilledNulls ? { filledNulls: tableFilledNulls } : {}),
        ...(tableCorrectedLookups ? { correctedLookups: tableCorrectedLookups } : {}),
        error: message,
      });
    }
  }
  return finish(results.every((result) => !result.mismatch));
}
