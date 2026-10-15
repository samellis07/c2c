/**
 * Dry-run shim runtime for translated Deluge.
 *
 * Default is dry-run: nothing is written, mailed, or fetched. Passing
 * `dryRun: false` still does not call the network; it requires an injected
 * adapter and throws if one is missing.
 *
 * The Catalyst limits this runtime enforces or warns about:
 * - varchar max length 255, silent truncation on insert — this runtime warns
 *   and does **not** truncate
 * - insertRows / updateRows / deleteRows: 200 rows per call
 * - ZCQL: 300 rows per query. Live reads page with OFFSET until a short
 *   page. Each page is `ORDER BY` the script `sort by` (if any) and always
 *   tie-breaks with ROWID, so a tied sort key cannot skip or repeat a row.
 *   Past zcqlMaxRows the read throws instead of returning a prefix.
 * - encrypted text: equality only
 * - decimal columns are not creatable via the column API
 * - job pool names reject "_"
 * - Data Store record events are Signals rules (one event per rule)
 * - Circuits is not available in the IN data centre
 */

import { Decimal, decimal } from './decimal.js';
import * as dates from './date.js';
import { DelugeConversionError, toDecimal, toJSONCollection, toJSONList, toList, toListString, toLong, toMap, toNumber, type ConvertCtx } from './convert.js';
import { bigintsToDigits, jsonReplacer } from './ids.js';
import { DelugeRuntimeError, DeleteRefused, SubmitRefused, UncapturedDelugeError, UniqueRefused } from './errors.js';
import * as lists from './list.js';
import { actualname, getFileName } from './file-values.js';
import { abs, acos, acosh, asin, asinh, atan, atan2, atanh, cos, cosh, exp, frac, isEven, isNumber, isOdd, largest, log, log10, round, sin, sinh, smallest, sqrt, tan, tanh, NUMERIC } from './number.js';
import {
  containsIgnoreCase,
  encodeUrl,
  endsWith,
  equalsIgnoreCase,
  getAlpha,
  getAlphaNumeric,
  getPrefix,
  getSuffix,
  ifnull,
  len,
  length,
  lower,
  leftPad,
  rightPad,
  matches,
  removeAllAlpha,
  removeFirstOccurence,
  removeLastOccurence,
  removeText,
  replaceAll,
  subString,
  subText,
  toLowerCase,
  toUpperCase,
  trim,
  left,
  right,
  mid,
  ltrim,
  rtrim,
  repeat,
  reverse,
  startsWith,
  startsWithIgnoreCase,
  textToHex,
  isAscii,
  removeAllAlphaNumeric,
  hexToText,
  htmlDecode,
  htmlEncode,
} from './text.js';
import { executeXpath, toXml, toXmlList } from './xml.js';
import {
  bindRelativeCriteria,
  compareCells,
  compareDecimalCells,
  compileCriteria,
  criteriaHasRelative,
  decimalShadow,
  EncryptedCriteriaError,
  exactFilter,
  matchRow,
  type Criteria,
  type DecimalColumns,
} from './criteria.js';
import { authorizeDelete, authorizeRead, authorizeWrite, expandCompositeWrites, isSystemWriteDenied, projectFields, RecordAccessError, type AccessPolicy, type Principal, type ReadIntent, type WriteSchema } from './access.js';
import { isStoredFileKey } from './files.js';
import { assertWritable, quantizeRow, WriteRuleError, type WriteRuleColumn } from './write-rules.js';
import * as zohoAdapters from './zoho-adapters.js';
import { counterDelta, counterSeq, incrementCounter, nextAutonumber, setCounter, type CounterOptions, type CounterStore } from './counters.js';

/**
 * 1:1 extension key. Same string as schema `EXTENSION_KEY`.
 * A function vendors this file and does not ship the schema package, so the
 * runtime does not import it.
 */
const EXTENSION_KEY = 'parent_rowid';

/**
 * Unverified Data Store column cap. Same number as datastore.columns_per_table.
 * Same number as `CATALYST_LIMITS` id `datastore.columns_per_table`.
 * Kept here so a vendored function can refuse an over-cap write without the schema package.
 */
const DATASTORE_COLUMNS_PER_TABLE = 250;

export const LIMITS = {
  varcharMaxLength: 255,
  insertRowsPerCall: 200,
  updateRowsPerCall: 200,
  zcqlRowsPerQuery: 300,
  /**
   * Refusal bound for one paged read. Not a Catalyst-published total.
   * A result that does not end inside this many rows throws
   * ({@link ZcqlRowCapError}) instead of returning a prefix.
   */
  zcqlMaxRows: 30_000,
  /**
   * `thisapp.<fn>` call depth bound. Creator documents a recursion limit of
   * 75 calls: "a function that calls itself cannot be called more than 75
   * times" — Creator's known-issues and limitations page (the Deluge
   * call-function help page documents the call but no cap). The bound stops
   * runaway recursion (a recursive `generate_list(n-1, list)`) with a Deluge error
   * instead of a stack overflow.
   */
  thisappMaxDepth: 75,
  /**
   * Bound on `shim.client.element` round trips in one client handler run.
   * A condition that mixes a non-record loop element with other server data
   * is one POST to the handler's prefetch endpoint per element; above this
   * cap the condition stays a `client-condition-uses-server` todo. Not a
   * Catalyst-published limit.
   */
  clientElementRoundTrips: 100,
} as const;

export interface TranscriptEntry {
  op: string;
  [key: string]: unknown;
}

export interface Query {
  __query: true;
  form: string;
  criteria: Criteria;
  sort?: { field: string; dir?: string; fields?: { field: string; dir?: string }[] };
  range?: { from: unknown; to: unknown };
  /**
   * Generated state machines (approvals, blueprints) set this on the record
   * re-read: the caller still needs form read access and the record filter,
   * but the machine row is not field-projected — its Status column and
   * approver fields are system state a caller's FieldPermissions need not name.
   */
  system?: boolean;
  /**
   * Staged ZCQL statements. Set when one SELECT cannot cover the row
   * (a split form, or a table past the unverified select cap). A live read
   * runs every statement and stitches on ROWID. It does not fall through to SELECT *.
   */
  zcql?: readonly string[];
}

/** Where a split form's columns live. Generation emits this; the runtime does not guess. */
export interface TableSplitLayout {
  /** Physical base table. */
  base: string;
  /** Columns stored on the base table. */
  baseColumns: readonly string[];
  extensions: readonly { table: string; columns: readonly string[] }[];
}

export interface RowMeta {
  __row: true;
  form: string;
  values: Record<string, unknown>;
}

/**
 * One generated custom function, registered under its Deluge name
 * (`"ListGeneration.generate_list"`). `call` is the module's exported
 * function; `params` are the declared argument names so `input.<param>`
 * resolves inside the callee. `recordParams` maps a form-typed parameter
 * name to its form; a `__row` argument there contributes its live `values`.
 * `rowForm` is set on a `for each record` function: the callee gets `ctx.row`
 * bound to that form's record (the first record-like argument, else empty).
 */
export interface ThisappFunction {
  call(ctx: ShimContext, ...args: unknown[]): Promise<unknown> | unknown;
  params?: readonly string[];
  recordParams?: Readonly<Record<string, string>>;
  rowForm?: string;
}

export interface RuntimeOptions {
  /** Default true. Live calls need an injected adapter; there is no network fallback. */
  dryRun?: boolean;
  /**
   * Creator app time zone override (`C2C_APP_TIMEZONE`). Wins over
   * `settingsTimeZone`. When both are unset, a dry run uses
   * `DEFAULT_APP_TIMEZONE` (UTC) and labels that fallback in the transcript.
   * `dryRun: false` throws `TimeZoneRequired` instead. See date.ts.
   */
  appTimeZone?: string;
  /** IR application setting `time zone`, used when `appTimeZone` is unset. */
  settingsTimeZone?: string;
  /** Injected clock for tests. */
  now?: Date;
  /** form → encrypted column names */
  encryptedColumns?: Record<string, readonly string[]>;
  /**
   * form → exact-decimal field → its Double shadow column and scale. Writes set the
   * shadow next to the varchar. Criteria and sort on the field use the shadow in
   * ZCQL, then {@link queryExact} filters and orders on the exact varchar.
   */
  decimalColumns?: Record<string, DecimalColumns>;
  /** Generated multi-lookup junctions, keyed by Creator form then field link name. */
  multiLookups?: Record<string, Record<string, { table: string; parentColumn: string; valueColumn: string; orderColumn: string }>>;
  /**
   * form → Creator unique fields the store does not enforce (schema `appUnique`, over the
   * Data Store unique varchar limit). A live insert or update reads for an existing row
   * with the same value first and throws UniqueRefused. The read is not atomic with the
   * write.
   */
  appUniqueColumns?: Record<string, readonly string[]>;
  /**
   * form (or child table) -> the generated write rules (schema columns). Every
   * write path (insert, update, setField, writeRow, insertRow) refuses a row
   * that violates one before the datastore call, the same check the data loader
   * runs. A form not listed keeps the warn-only behaviour.
   */
  writeRules?: Record<string, readonly WriteRuleColumn[]>;
  /**
   * form -> the generated write schema (the field tree with composite and
   * subform children). The submit handler authorizes the request against it;
   * the update path re-authorizes the write payload, and a composite field
   * such as `Name` can only pass when its nested parts are screened against
   * the same schema — a flat field list would read the nested object as an
   * invalid scalar and deny a granted write. A form not listed authorizes
   * with the grant names alone, as before.
   */
  writeSchemas?: Record<string, WriteSchema>;
  /**
   * Concurrency-safe counters (counters.ts, claim table `c2c_seq_claim`).
   * `autonumber`: form -> field -> start index; a live insert with the field
   * blank claims the next number. `columns`: form -> counter columns; a
   * fetched row's `rec.F = rec.F + n` is applied at flush as an increment of
   * n, and an update that sets the column stores it as a new version, so
   * concurrent writes are not lost. A form not listed keeps plain writes.
   *
   * Any write of a counter column after the script read it is applied as a
   * delta (written value - value read), never as a plain set: `x = rec.F;
   * rec.F = 7` raced with another request's `+1` can end at 8, a value
   * neither request wrote. Only a write with no read before it is a set.
   * Live counters need `datastore.delete`; the runtime refuses to start
   * without it.
   */
  counters?: {
    autonumber?: Record<string, Record<string, { start?: number }>>;
    columns?: Record<string, readonly string[]>;
    maxAttempts?: number;
    wait?: CounterOptions['wait'];
  };
  datastore?: {
    insert?(form: string, rows: Record<string, unknown>[]): Promise<unknown>;
    /**
     * One ZCQL page. `offset` is the number of matching rows to skip
     * (`LIMIT limit OFFSET offset`). `orderBy` is the full clause: the
     * script `sort by` when the read has one, then ROWID
     * (`ORDER BY ROWID` when it does not). A short page ends the read.
     */
    query?(form: string, zcqlWhere: string, limit: number, offset?: number, orderBy?: string): Promise<Record<string, unknown>[]>;
    update?(form: string, rows: Record<string, unknown>[]): Promise<unknown>;
    /**
     * Catalyst `deleteRows`: at most {@link LIMITS.updateRowsPerCall} ROWIDs.
     * The runtime reads the scoped matches and passes those ids. It does not
     * pass the script criteria.
     * https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/bulk-operations/
     */
    delete?(form: string, rowIds: readonly unknown[]): Promise<unknown>;
  };
  /**
   * Column layout for forms split past the Data Store column cap.
   * When a form is absent, a live write that cannot fit the cap is refused
   * before the adapter is called. No column is dropped.
   */
  splits?: Readonly<Record<string, TableSplitLayout>>;
  mail?: (message: Record<string, unknown>) => Promise<unknown>;
  http?: (request: Record<string, unknown>) => Promise<unknown>;
  /**
   * Live adapter for the legacy `getUrl` task (shim.http.getUrl). The
   * generated handler wires `outboundGetUrl(outboundConfig(req))` here — the
   * same `outboundHosts` allowlist as `http`. Unset means a live getUrl is
   * refused like any unadapted side effect.
   */
  httpGetUrl?: (request: { url: string; headers?: Record<string, unknown>; simple: boolean }) => Promise<unknown>;
  connection?: (name: string | undefined, call: { path: string[]; args: unknown[] }) => Promise<unknown>;
  /**
   * Catalyst Connections for `zoho.<svc>.<task>` adapters and `invokeurl`
   * with `connection:`. Dry run records the request that would be sent (DC
   * resolved when `dc` is set). Live needs `dc`, a Catalyst connection name
   * for the Creator link, and `credentials`; otherwise the call throws
   * `ZohoConnectionRefused` naming the missing piece. See zoho-adapters.ts.
   */
  zohoConnections?: zohoAdapters.ZohoConnectionsConfig;
  /**
   * Profile / report policy. When set, every record read uses the same
   * authorization as the prefetch endpoint. When unset, reads are unchanged.
   */
  access?: AccessPolicy;
  /**
   * The app's generated flow-history table. `datastore.historyRows` reads
   * only this table, without the caller's access policy — the same bypass the
   * history `insertRow` write uses, so a machine can read back the history it
   * wrote for callers that have no grant on the history table.
   */
  flowHistoryTable?: string;
  /**
   * Test double for the client prefetch endpoint. Called with the form-state
   * nonce. Dry-run with no adapter does not invent slots.
   * A `slot`/`range` request asks for one deferred slot's rows.
   */
  clientPrefetch?: (path: string, nonce: string, request?: { args?: unknown[]; element?: { name: string; value: unknown }; slot?: string; range?: { from: unknown; to: unknown } }) => Promise<unknown> | unknown;
  /**
   * Application owner username (`zoho.adminuser`).
   * When unset, a labelled sentinel is returned. It is not a Zoho username.
   */
  adminUser?: string;
  /** Application owner email (`zoho.adminuserid`). Same sentinel rule as `adminUser`. */
  adminUserId?: string;
  /**
   * Catalyst Mail sender used when a mail's `from` is the application owner
   * (`zoho.adminuserid`). Creator sends that mail from its notification sender
   * (`CREATOR_DEFAULT_MAIL_FROM` is a placeholder for it). Catalyst Mail
   * needs a verified sender, so deploy sets `C2C_MAIL_FROM`. Unset in a dry
   * run means the placeholder Creator sender.
   */
  mailFrom?: string;
  /**
   * Dry-run rows keyed by form link name. Insertion order is the fetch order
   * when the script has no `sort by`. A missing ROWID is assigned from that
   * order so a tied sort key breaks like `ORDER BY field, ROWID`. Live
   * adapters ignore this. A form that is not listed still returns the empty
   * dry-run result.
   */
  seed?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  /**
   * The app's generated custom functions (`functions/thisapp.mjs`), keyed by
   * Deluge name for `thisapp.<fn>(args)` dispatch. When unset, a call records
   * the dry-run placeholder exactly like a runtime with no registry. When set
   * (even `{}`), a name not in the registry throws `DelugeRuntimeError`
   * because the generated app knows its functions; a resolvable call is
   * recorded in dry run and executed in live mode.
   */
  functions?: Readonly<Record<string, ThisappFunction>>;
  /** `thisapp` recursion depth bound; default {@link LIMITS.thisappMaxDepth}. */
  thisappMaxDepth?: number;
  /**
   * The deployed function's field reader (`createFieldReader` in the function asset
   * c2c-field-values.mjs, over c2c-columns.json, c2c-renames.json, c2c-rules.json and the
   * form's subformTables), so a local run reads values exactly as the deployed entry and the
   * datastore adapter do. `context({ form, record })` reads the record with `input` (digit
   * text in a number field is a number; a value that is not its type throws the reader's
   * 400 error), and each `seed` row is read with `stored`. Unset, records and seed rows are
   * used as given.
   */
  fieldValues?: FieldValueReader;
}

/** Field value rules by form or child table; see {@link RuntimeOptions.fieldValues}. */
export interface FieldValueReader {
  input(form: string, record: Record<string, unknown>): Record<string, unknown>;
  stored?(form: string, row: Record<string, unknown>): Record<string, unknown>;
}

/** Fields `Runtime.context` takes; `form` names the record's form for {@link RuntimeOptions.fieldValues}. */
export type ContextInput = Partial<
  Pick<ShimContext, 'record' | 'old' | 'row' | 'appTimeZone' | 'principal' | 'formNonce' | 'writeOp' | 'rowId' | 'subformRow' | 'args' | 'transition' | 'approver' | 'element' | 'prefetchPath' | 'rangeSlot' | 'rangeFrom' | 'rangeTo' | 'rangeEmpty'>
> & { form?: string };

export interface ShimContext {
  shim: Shim;
  appTimeZone?: string;
  /** Field values for the record being submitted. */
  record: Record<string, unknown>;
  /** Previous field values, when the workflow has them. */
  old: Record<string, unknown>;
  /** Bound row for a "for each record" function (`rec`). */
  row?: RowMeta;
  /**
   * The subform row a subform event fired on (`on user input of Sub.Field`,
   * `on add row of Sub`, `on delete row of Sub`): `record[field][index]`.
   */
  subformRow?: { field: string; index: number };
  /**
   * Arguments of the custom function a client handler runs for, in the
   * declared order. The client sends them with its prefetch so the server
   * reads see the same parameter values.
   */
  args?: unknown[];
  /** Caller taken from the platform user, never from the request body. */
  principal?: Principal;
  /**
   * Form-state version. Bumped on form load and on each field change.
   * A prefetch response for any other nonce is stale.
   */
  formNonce?: string;
  /** Prefetch endpoint path the client handler loaded, set by the first prefetch call. */
  prefetchPath?: string;
  /**
   * The loop element a per-element prefetch evaluates for: `{ name, value }`
   * from the request body. The name is the translated loop variable, the
   * value plain JSON data.
   */
  element?: { name: string; value: unknown };
  /** Per-element prefetch calls made in this handler run (cap: {@link LIMITS.clientElementRoundTrips}). */
  elementCalls?: number;
  /**
   * Deferred slot read: set by the prefetch endpoint from the request's
   * `slot`/`range`, so a `slots[...]` guard evaluates only the read the client
   * asked for. `rangeEmpty` is a normalized request whose `to` precedes `from`:
   * the slot resolves to an empty list without touching the store.
   */
  rangeSlot?: string;
  rangeFrom?: number;
  rangeTo?: number;
  rangeEmpty?: boolean;
  /**
   * `on add or edit` workflows only. `prepare` sets this from `rowId`.
   * A client `body.op` is not copied here.
   */
  writeOp?: 'insert' | 'update';
  /**
   * Request ROWID (`body.ROWID` or `body.rowid` only). Not read from `record`.
   * Empty means on add or edit is an insert.
   */
  rowId?: string;
  /** Set by the generated live-write path once the row is stored, so the script does not stamp it twice. */
  persisted?: boolean;
  /**
   * The state-machine transition being run (approvals and blueprints only).
   * `submit` is the machine's on-start phase; approve/reject/transition name
   * the action, `from`/`to` the persisted stages, `level` the approval level,
   * and `script` the machine script key that the transition runs.
   */
  transition?: { action: string; from?: string; to?: string; level?: number; script?: string };
  /**
   * Slug of the generated state machine that claimed the submitted record
   * (set by its `begin`): only that machine's `commit` logs the submit row,
   * so two machines on one form do not each write a history entry.
   */
  approver?: { submitter: string | null };

  __c2cFlow?: string;
  now: Date;
}

export interface PrefetchResult {
  ok: boolean;
  /** Empty unless `ok` is true. A stale or failed prefetch never leaves slots here. */
  slots: Record<string, unknown>;
  nonce: string;
  /** Visible client message when the prefetch must not be acted on. */
  message?: string;
  /** True when the accepted result is a second server round-trip. */
  retried?: boolean;
}

/** Result of {@link Shim.client.rows}: the rows of one deferred slot, or a refusal. */
export interface SlotRowsResult {
  ok: boolean;
  /** Empty unless `ok` is true. */
  rows: unknown[];
  /** Visible client message when the read must not be acted on. */
  message?: string;
  /** True when the accepted result is a second server round-trip. */
  retried?: boolean;
}

/**
 * Parse a deferred slot read from a prefetch request body. `slot` names the
 * deferred read; `range.from`/`range.to` are client-evaluated bounds. Both must
 * be integers; anything else is a refusal (`error`). The bounds are clamped to
 * `1 <= from <= to <= from + LIMITS.zcqlRowsPerQuery` — the existing ZCQL page
 * cap — and to `to <= LIMITS.zcqlMaxRows`. A `from` past `LIMITS.zcqlMaxRows`
 * is a refusal: the read offset never exceeds the paged-read refusal bound.
 * A `to` that precedes the clamped `from` is an empty range, not an error.
 * No `slot` key is an ordinary prefetch (`slot` absent).
 */
export function rangeSlotRequest(body: unknown): { slot?: string; from: number; to: number; empty: boolean; error?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { from: 0, to: 0, empty: false };
  const raw = (body as Record<string, unknown>).slot;
  if (raw === undefined) return { from: 0, to: 0, empty: false };
  if (typeof raw !== 'string' || !raw) return { from: 0, to: 0, empty: false, error: 'prefetch range: slot must be a slot name' };
  const range = (body as Record<string, unknown>).range;
  const bound = (side: 'from' | 'to'): unknown =>
    range && typeof range === 'object' && !Array.isArray(range) ? (range as Record<string, unknown>)[side] : undefined;
  const from = bound('from');
  const to = bound('to');
  if (typeof from !== 'number' || !Number.isSafeInteger(from) || typeof to !== 'number' || !Number.isSafeInteger(to)) {
    return { from: 0, to: 0, empty: false, error: 'prefetch range: from and to must be integers' };
  }
  if (from > LIMITS.zcqlMaxRows) {
    return { from: 0, to: 0, empty: false, error: `prefetch range: from must not exceed ${LIMITS.zcqlMaxRows}` };
  }
  const start = Math.max(1, from);
  const end = Math.min(to, start + LIMITS.zcqlRowsPerQuery, LIMITS.zcqlMaxRows);
  return { slot: raw, from: start, to: end, empty: end < start };
}

export interface Shim {
  todo(ctx: ShimContext, construct: string, detail?: unknown): Promise<unknown>;
  /**
   * Every generated `obj[key]` index read goes through this accessor: own
   * keys only, and the prototype-path segment names (`__proto__`,
   * `constructor`, `prototype`) read as undefined, so no compiled read can
   * hand a script the shared prototype.
   */
  get(obj: unknown, key: unknown): unknown;
  /**
   * Every generated `obj[key] = v` / `obj.name = v` write on a value that is
   * not the input/old record goes through this setter: it refuses the unsafe
   * segment names and never writes onto a shared prototype object.
   */
  set(obj: unknown, key: unknown, value: unknown): unknown;
  input: {
    root(ctx: ShimContext): Record<string, unknown>;
    get(ctx: ShimContext, ...path: string[]): unknown;
    set(ctx: ShimContext, path: string[], value: unknown): unknown;
    /**
     * `input.<subform>.insert(rows)` appends rows to the field list: one row
     * per element of a collection argument, else the single row.
     */
    insert(ctx: ShimContext, path: string[], value: unknown): unknown;
  };
  old: {
    get(ctx: ShimContext, ...path: string[]): unknown;
    set(ctx: ShimContext, path: string[], value: unknown): unknown;
  };
  compare: {
    /**
     * `Field == literal` equality: a lookup field stores a reference object
     * (`{id, label}`, or a bound record), and the comparison reads its id or
     * label — not object identity. A list (multi lookup) matches when any
     * member does. Plain values compare with `==`.
     */
    eq(value: unknown, other: unknown): boolean;
    ne(value: unknown, other: unknown): boolean;
  };
  record: {
    bind(ctx: ShimContext, values: Record<string, unknown>, form?: string): RowMeta;
    get(row: unknown, ...path: string[]): unknown;
    set(row: unknown, path: string[], value: unknown): unknown;
    /** Creator system columns (`Added_User`, `Added_Time`, and the same). */
    system(row: unknown, name: string): unknown;
    /**
     * Platform columns for this write. Call after `authorizeWrite`.
     * Insert sets `Added_User` / `Added_Time`. Update sets `Modified_User` / `Modified_Time`
     * and leaves added columns already on the row.
     */
    stamp(ctx: ShimContext, op: 'insert' | 'update'): void;
    /**
     * Load stored Added_* under the modify scope, then stamp.
     * Omit `kind` for on add or edit: a ROWID selects update, otherwise insert.
     * Dedicated on-edit passes `"update"`. Add versus edit does not read a client op flag.
     */
    prepare(ctx: ShimContext, formName: string, kind?: 'insert' | 'update'): Promise<void>;
  };
  list: {
    (elementType?: string): unknown[];
    get(value: unknown, index: unknown): unknown;
    remove(value: unknown, a?: unknown, b?: unknown): unknown;
    removeAll(value: unknown, drop: unknown): unknown;
    removeElement(value: unknown, item: unknown): unknown;
    deleteItem(value: unknown, item: unknown): unknown;
    deleteAll(value: unknown, item: unknown): unknown;
    duplicate(value: unknown): unknown;
    sortKey(value: unknown): unknown;
    notContains(value: unknown, val: unknown): boolean;
    distinct(value: unknown): unknown[];
    sort(value: unknown, asc?: unknown): unknown[];
    intersect(left: unknown, right: unknown): unknown[];
    indexOf(value: unknown, needle: unknown, from?: unknown): number;
    length(value: unknown): number | null;
    size(value: unknown): number | null;
    add(value: unknown, ...items: unknown[]): unknown;
    addAll(value: unknown, extra: unknown): unknown;
    contains(value: unknown, needle: unknown): boolean;
    containsKey(value: unknown, key: unknown): boolean;
    containsValue(value: unknown, val: unknown): boolean;
    deleteKey(value: unknown, key: unknown): unknown;
    deleteKeys(value: unknown, keys: unknown): unknown;
    getKey(value: unknown, val: unknown): unknown;
    getLastKey(value: unknown, val: unknown): unknown;
    clear(value: unknown): unknown;
    insert(value: unknown, a?: unknown, b?: unknown): unknown;
    insertAll(value: unknown, a?: unknown, b?: unknown): unknown;
    putAll(value: unknown, extra: unknown): unknown;
    lastIndexOf(value: unknown, needle: unknown): number;
    keys(value: unknown): unknown[];
    values(value: unknown): unknown[];
    update(value: unknown, a: unknown, b: unknown): unknown;
    getJson(value: unknown, key: unknown): unknown;
    put(value: unknown, key: unknown, val?: unknown): unknown;
    subList(value: unknown, start: unknown, end?: unknown): unknown[];
    column(rows: unknown, field: unknown): unknown[];
    aggregate(rows: unknown, fn: unknown, field?: unknown, exact?: unknown): unknown;
  };
  map(elementType?: string): Record<string, unknown>;
  /**
   * Deluge `for each`. An empty collection iterates zero times
   * (https://www.zoho.com/deluge/help/datatypes/collection.html).
   * Null iterates zero times (`foreach.null`).
   */
  each(ctx: ShimContext, value: unknown): unknown[];
  subform: {
    /**
     * Deluge `row` in a subform event: the row of `field` the event fired on,
     * as the live object inside `ctx.record`, so `row.F = v` through
     * `record.set` changes that row of the submitted form
     * (https://www.zoho.com/deluge/help/miscellaneous/access-subform-fields.html).
     * Null when the request names no row of `field`.
     */
    currentRow(ctx: ShimContext, field: string): Record<string, unknown> | null;
  };
  datastore: {
    query(ctx: ShimContext, form: string, criteria: Criteria, opts?: { sort?: Query['sort']; range?: Query['range']; system?: boolean; zcql?: readonly string[] }): Query;
    rows(ctx: ShimContext, query: Query): Promise<RowMeta[]>;
    aggregate(ctx: ShimContext, query: Query, fn: string, field?: string): Promise<unknown>;
    column(ctx: ShimContext, query: Query, field: string): Promise<unknown[]>;
    field(ctx: ShimContext, query: Query, field: string): Promise<unknown>;
    /**
     * Whether `row` matches `criteria`, in memory, with the same cell semantics
     * as the seeded and staged reads. Used to post-filter candidates a batched
     * map read fetched by one keyed conjunct against its remaining row-keyed
     * conjuncts — never a new query.
     */
    matches(ctx: ShimContext, row: unknown, criteria: unknown): boolean;
    lookupMap(ctx: ShimContext, form: string, keyField: string, targetField: string, keys: readonly unknown[], extra?: Criteria): Promise<Map<string, unknown>>;
    rowsMap(ctx: ShimContext, form: string, keyField: string, keys: readonly unknown[], extra?: Criteria): Promise<Map<string, RowMeta[]>>;
    aggregateMap(ctx: ShimContext, form: string, keyField: string, keys: readonly unknown[], fn: string, field?: string, extra?: Criteria): Promise<Map<string, unknown>>;
    insert(ctx: ShimContext, form: string, values: Record<string, unknown>): Promise<unknown>;
    /**
     * `values` may be `ctx.record` after `record.prepare`, which carries the
     * stored system columns for scripts to read. They are not update input:
     * the payload drops them and re-stamps Modified_User / Modified_Time, so
     * an update never writes Added_* back. Request screening still refuses a
     * client-supplied system column outright.
     */
    update(ctx: ShimContext, form: string, criteria: Criteria, values: Record<string, unknown>): Promise<unknown>;
    delete(ctx: ShimContext, form: string, criteria: Criteria): Promise<unknown>;
    setField(ctx: ShimContext, query: Query, field: string, value: unknown): Promise<unknown>;
    /**
     * Write field updates queued by {@link Shim.record.set} on rows from
     * {@link Shim.datastore.rows}. Batches are at most
     * {@link LIMITS.updateRowsPerCall}. A dry run does not call the adapter.
     */
    flush(ctx: ShimContext): Promise<void>;
    /**
     * System write for the generated approval / blueprint machines.
     * A user script never calls this; it lets a machine write its status
     * column or a history row when record write access is deny-by-policy.
     * `criteria` is an exact `ROWID` predicate; the write targets that row.
     * In dry run it records a `store` transcript entry.
     */
    writeRow(ctx: ShimContext, form: string, rowId: string, values: Record<string, unknown>): Promise<unknown>;
    /** Insert a system row (the state-machine history table). */
    insertRow(ctx: ShimContext, form: string, values: Record<string, unknown>): Promise<unknown>;
    /**
     * Read rows of the app's own flow-history table
     * ({@link RuntimeOptions.flowHistoryTable}), for the generated machines.
     * `form` must be exactly that table: anything else throws, so this read
     * cannot be pointed at another table. The caller's access policy does not
     * apply — the same bypass `insertRow` uses to write the history a machine
     * reads back. A history table that does not exist reads as no rows.
     */
    historyRows(ctx: ShimContext, form: string, criteria: Criteria, opts?: { sort?: Query['sort']; range?: Query['range'] }): Promise<RowMeta[]>;
  };
  validate: { cancelDelete(ctx: ShimContext, alert: string | null): never; cancelSubmit(ctx: ShimContext, alert: string | null): never };
  mail: { send(ctx: ShimContext, message: Record<string, unknown>): Promise<unknown> };
  http: {
    invokeurl(ctx: ShimContext, request: Record<string, unknown>): Promise<unknown>;
    /**
     * The deprecated `getUrl` task: an HTTP GET through the same outbound
     * transport and host allowlist as `invokeurl`. `getUrl(url)` and a truthy
     * or absent boolean return the body text; `false` returns a
     * { responseText, responseHeader, responseCode } map. The second argument
     * is the header map in the three-argument form, or the boolean itself in
     * `getUrl(url, simple)`.
     */
    getUrl(ctx: ShimContext, url: unknown, headersOrSimple?: unknown, simple?: unknown): Promise<unknown>;
  };
  zoho: {
    currentDate(ctx: ShimContext): dates.DelugeDate;
    currentTime(ctx: ShimContext): dates.DelugeDate;
    loginUserId(ctx: ShimContext): unknown;
    loginUser(ctx: ShimContext): unknown;
    adminUserId(ctx: ShimContext): unknown;
    adminUser(ctx: ShimContext): unknown;
    appUri(ctx: ShimContext): unknown;
    ipAddress(ctx: ShimContext): unknown;
    appName(ctx: ShimContext): unknown;
    task(ctx: ShimContext, path: string[], args: unknown[]): Promise<unknown>;
  };
  thisapp: { call(ctx: ShimContext, path: string[], args: unknown[]): Promise<unknown> };
  date: {
    parse(literal: string, ctx: ShimContext): dates.DelugeDate;
    getYear(value: unknown, ctx: ShimContext): number | null;
    getMonth(value: unknown, ctx: ShimContext): number | null;
    getDay(value: unknown, ctx: ShimContext): number | null;
    getHour(value: unknown, ctx: ShimContext): number | null;
    getMinutes(value: unknown, ctx: ShimContext): number | null;
    getSeconds(value: unknown, ctx: ShimContext): number | null;
    addDay(value: unknown, n: number | bigint, ctx: ShimContext): dates.DelugeDate | null;
    addMonth(value: unknown, n: number | bigint, ctx: ShimContext): dates.DelugeDate | null;
    addYear(value: unknown, n: number | bigint, ctx: ShimContext): dates.DelugeDate | null;
    addWeek(value: unknown, n: number | bigint, ctx: ShimContext): dates.DelugeDate | null;
    addHour(value: unknown, n: number | bigint, ctx: ShimContext): dates.DelugeDate | null;
    addMinutes(value: unknown, n: number | bigint, ctx: ShimContext): dates.DelugeDate | null;
    addSeconds(value: unknown, n: number | bigint, ctx: ShimContext): dates.DelugeDate | null;
    toDate(value: unknown, ctx: ShimContext): dates.DelugeDate | null;
    toTime(value: unknown, ctx: ShimContext): dates.DelugeDate | null;
    format(value: unknown, pattern: string, ctx: ShimContext): string | null;
    /** `toString()` with no pattern. A blank is empty text, not the literal "null". */
    text(value: unknown, ctx: ShimContext): string;
    addBusinessDay(value: unknown, n: number | bigint, ...args: unknown[]): dates.DelugeDate | null;
    getDayOfWeek(value: unknown, ctx: ShimContext): number | null;
    toStartOfWeek(value: unknown, ctx: ShimContext): dates.DelugeDate | null;
    days360(a: unknown, b: unknown, ctx: ShimContext): number;
    toStartOfMonth(value: unknown, ctx: ShimContext): dates.DelugeDate | null;
    eomonth(value: unknown, n: number, ctx: ShimContext): dates.DelugeDate | null;
    getDayOfYear(value: unknown, ctx: ShimContext): number | null;
    getWeekOfYear(value: unknown, ctx: ShimContext): number | null;
    daysBetween(a: unknown, b: unknown, ctx: ShimContext): number;
    monthsBetween(a: unknown, b: unknown, ctx: ShimContext): number;
    yearsBetween(a: unknown, b: unknown, ctx: ShimContext): number;
    hour(value: unknown, ctx: ShimContext): number | null;
    minute(value: unknown, ctx: ShimContext): number | null;
    second(value: unknown, ctx: ShimContext): number | null;
    month(value: unknown, ctx: ShimContext): number | null;
    hoursBetween(a: unknown, b: unknown, ctx: ShimContext): number;
    nextWeekDay(value: unknown, dayName: unknown, ctx: ShimContext): dates.DelugeDate | null;
    previousWeekDay(value: unknown, dayName: unknown, ctx: ShimContext): dates.DelugeDate | null;
    /**
     * Whole calendar months. Null in, null out. Time of day is ignored.
     * https://www.zoho.com/deluge/help/functions/datetime/totalmonth.html
     */
    totalMonths(a: unknown, b: unknown, ctx: ShimContext): number | null;
    /**
     * Whole calendar years, leap days included. Null in, null out.
     * https://www.zoho.com/deluge/help/functions/datetime/totalyear.html
     */
    totalYears(a: unknown, b: unknown, ctx: ShimContext): number | null;
    /**
     * Epoch milliseconds formatted with the date pattern in `timeZone`.
     * A blank zone uses the application time zone. Null in, null out.
     * https://www.zoho.com/deluge/help/functions/datetime/todatetimestring.html
     */
    toDateTimeString(...args: any[]): string | null;
    /**
     * Milliseconds since 1970-01-01 00:00:00 UTC for text, in the application
     * time zone. Unrecognized text is returned unchanged. A non-text value errors.
     * https://www.zoho.com/deluge/help/functions/datetime/unix-epoch.html
     */
    unixEpoch(...args: any[]): number | string | null;
    subDay(value: unknown, n: number | bigint, ctx: ShimContext): dates.DelugeDate | null;
    subMonth(value: unknown, n: number | bigint, ctx: ShimContext): dates.DelugeDate | null;
    subYear(value: unknown, n: number | bigint, ctx: ShimContext): dates.DelugeDate | null;
    subWeek(value: unknown, n: number | bigint, ctx: ShimContext): dates.DelugeDate | null;
    subHour(value: unknown, n: number | bigint, ctx: ShimContext): dates.DelugeDate | null;
    subMinutes(value: unknown, n: number | bigint, ctx: ShimContext): dates.DelugeDate | null;
    subSeconds(value: unknown, n: number | bigint, ctx: ShimContext): dates.DelugeDate | null;
    diffDays(a: unknown, b: unknown, ctx: ShimContext): number | null;
    isDate(value: unknown): boolean | null;
    cmp(a: unknown, b: unknown, ctx: ShimContext): number | null;
    /**
     * Boolean date comparison. Relational ops on a blank date throw
     * `UnParsable date` (Creator's captured message) instead of using JS `null <= 0`.
     */
    rel(a: unknown, b: unknown, op: string, ctx: ShimContext): boolean;
    /**
     * `field is today|tomorrow|yesterday` in the app time zone.
     * A blank is false. A non-blank value that is not a date throws `UnParsable date`.
     */
    isDay(value: unknown, which: dates.CalendarDay, ctx: ShimContext): boolean;
  };
  decimal: typeof decimal;
  math: {
    round(n: unknown, places?: unknown): number | bigint;
    sqrt(n: unknown): number | bigint | null;
    abs(n: unknown): number | bigint | Decimal | null;
    exp(n: unknown): number | null;
    frac(n: unknown): number | Decimal | null;
    log(n: unknown): number;
    acos(n: unknown): number | null;
    acosh(n: unknown): number | null;
    asinh(n: unknown): number | null;
    atan(n: unknown): number | null;
    atan2(y: unknown, x: unknown): number | null;
    atanh(n: unknown): number | null;
    cosh(n: unknown): number | null;
    log10(n: unknown): number | null;
    sinh(n: unknown): number | null;
    tanh(n: unknown): number | null;
    isEven(n: unknown): boolean | null;
    isOdd(n: unknown): boolean | null;
  };
  string: {
    replaceFirst(s: string, find: string, repl: string): string;
    replaceAll(value: unknown, find: unknown, repl: unknown, escape?: unknown): string | null;
    remove(value: unknown, a?: unknown, b?: unknown): string | null;
    subString(value: unknown, start: unknown, end?: unknown): string | null;
    isAscii(value: unknown): boolean | null;
    removeAllAlphaNumeric(value: unknown): string | null;
    hexToText(value: unknown): string | null;
    htmlDecode(value: unknown): string | null;
    htmlEncode(value: unknown): string | null;
    getPrefix(value: unknown, sep: unknown): string | null;
    getSuffix(value: unknown, sep: unknown): string | null;
    leftPad(value: unknown, width: unknown, pad?: unknown): string | null;
    rightPad(value: unknown, width: unknown, pad?: unknown): string | null;
    equalsIgnoreCase(value: unknown, other: unknown): boolean;
    containsIgnoreCase(value: unknown, needle: unknown): boolean;
    removeAllAlpha(value: unknown): string | null;
    toLowerCase(value: unknown): string | null;
    toUpperCase(value: unknown): string | null;
    trim(value: unknown): string | null;
    startsWith(value: unknown, prefix: unknown): boolean;
    endsWith(value: unknown, suffix: unknown): boolean;
    startsWithIgnoreCase(value: unknown, prefix: unknown): boolean;
    textToHex(value: unknown): string | null;
    removeFirstOccurence(value: unknown, needle: unknown): string | null;
    removeLastOccurence(value: unknown, needle: unknown): string | null;
    getAlpha(value: unknown): string | null;
    getAlphaNumeric(value: unknown): string | null;
    subText(value: unknown, start: unknown, end?: unknown): string | null;
    matches(value: unknown, pattern: unknown): boolean;
    len(value: unknown): number | null;
    length(value: unknown): number | null;
    lower(value: unknown): string | null;
    encodeUrl(value: unknown): string | null;
    left(value: unknown, n: unknown): string | null;
    right(value: unknown, n: unknown): string | null;
    mid(value: unknown, start: unknown, count?: unknown): string | null;
    ltrim(value: unknown): string | null;
    rtrim(value: unknown): string | null;
    repeat(value: unknown, n: unknown): string | null;
    reverse(value: unknown): string | null;
  };
  xml: {
    toXml(value: unknown, ...extra: unknown[]): string;
    toXmlList(value: unknown, ...extra: unknown[]): string[];
    executeXpath(value: unknown, xpath?: unknown, ...extra: unknown[]): string;
  };
  file: {
    /** Name of a Stratus key or `{ key, name }`. Null when the value is not a file. */
    getFileName(value: unknown): string | null;
    /** Uploaded name. Ignores a `name` carried on the value. */
    actualname(value: unknown): string | null;
  };
  isBlank(value: unknown): boolean;
  /** Null or `""`. A string of spaces is not null (`isBlank` covers that). */
  isNull(value: unknown): boolean;
  isEmpty(value: unknown): boolean;
  isNumber(value: unknown): boolean | null;
  number: {
    largest(value: unknown): number | null;
    smallest(value: unknown): number | null;
    sin(value: unknown): Decimal | null;
    cos(value: unknown): Decimal | null;
    tan(value: unknown): Decimal | null;
    asin(value: unknown): Decimal | null;
  };
  isText(value: unknown): boolean | null;
  /**
   * True for a stored file: the object key, or a `{ key }` reference whose
   * key matches that shape. Null and "" are false.
   */
  isFile(value: unknown): boolean;
  ifnull(value: unknown, replacement: unknown): unknown;
  log: { info(ctx: ShimContext, value: unknown): void };
  convert: {
    toLong(value: unknown, ctx: ShimContext, ...extra: unknown[]): number | bigint;
    toNumber(value: unknown, ctx: ShimContext, ...extra: unknown[]): number | bigint;
    toDecimal(value: unknown, ctx: ShimContext, ...extra: unknown[]): Decimal | null;
    toList(value: unknown, ctx: ShimContext, separator?: unknown, ...extra: unknown[]): unknown[];
    toMap(value: unknown, ctx: ShimContext, ...extra: unknown[]): Record<string, unknown>;
    toListString(value: unknown, ctx: ShimContext): unknown[];
    toJSONList(value: unknown, ctx: ShimContext, ...extra: unknown[]): unknown[];
    toJSONCollection(value: unknown, ctx: ShimContext, ...extra: unknown[]): Record<string, unknown>;
  };
  /**
   * Load prefetch slots for client conditions and loops.
   * A stale or failed response is not slots: `ok` is false and `slots` is empty.
   */
  client: {
    /** New form-state nonce. Call on form load and on each field change. */
    touch(ctx: ShimContext): string;
    prefetch(ctx: ShimContext, path: string): Promise<PrefetchResult>;
    /**
     * One event-time call to a generated read-only function endpoint. A stale,
     * refused, or failed response throws `c2cElementBlocked`, so the handler
     * discards queued actions instead of deciding on an unproven condition.
     */
    call(ctx: ShimContext, path: string, args: unknown[]): Promise<unknown>;
    /**
     * One server round trip for one loop element: POSTs `{ name, value }` to
     * the handler's prefetch endpoint and returns the named slot. A refused,
     * failed, placeholder, or over-cap ({@link LIMITS.clientElementRoundTrips})
     * call throws a `c2cElementBlocked` error after a
     * `client-condition-uses-server` todo note — the handler run discards the
     * actions queued so far, so an element failure never leaves partial
     * client actions applied.
     */
    element(ctx: ShimContext, name: string, value: unknown, slot: string): Promise<unknown>;
    /**
     * One deferred slot's rows: the client evaluates `from`/`to` and sends them
     * as request parameters; the endpoint clamps and runs the named read.
     */
    rows(ctx: ShimContext, slot: string, from: unknown, to: unknown): Promise<SlotRowsResult>;
  };
}

/** Creator system column → keys a row may already use. First present key wins. */
const SYSTEM_FIELD_KEYS: { name: string; keys: readonly string[] }[] = [
  { name: 'Added_User', keys: ['Added_User', 'added_user'] },
  { name: 'Modified_User', keys: ['Modified_User', 'modified_user'] },
  { name: 'Added_Time', keys: ['Added_Time', 'CREATEDTIME', 'createdtime'] },
  { name: 'Modified_Time', keys: ['Modified_Time', 'MODIFIEDTIME', 'modifiedtime'] },
];

/**
 * Dry-run stand-in when the runtime has no real Zoho identity.
 * Angle brackets and the `c2c-dry-run:` label are not a Creator username
 * and not an email, so a real `Added_User` never compares equal to one.
 * https://www.zoho.com/deluge/help/zoho-variables.html
 */
export const DRY_RUN_LOGIN_USER = '<c2c-dry-run:loginuser>';
export const DRY_RUN_LOGIN_USER_ID = '<c2c-dry-run:loginuserid>';
export const DRY_RUN_ADMIN_USER = '<c2c-dry-run:adminuser>';
export const DRY_RUN_ADMIN_USER_ID = '<c2c-dry-run:adminuserid>';
/** Creator notification sender used when `from` is zoho.adminuserid and no Catalyst sender is set. */
export const CREATOR_DEFAULT_MAIL_FROM = 'notifications@zohocreatormail.example';

const ADDED_COLUMN_KEYS = new Set(['added_user', 'added_time', 'createdtime']);
const MODIFIED_COLUMN_KEYS = new Set(['modified_user', 'modified_time', 'modifiedtime']);

/**
 * Columns the store itself owns, dropped from every write payload whatever the
 * caller sent. `ROWID` and `CREATORID` are set by the platform; an update
 * attaches the ROWID it resolved. `c2c_source_id` is different: an update that
 * carried it would rewrite the row's stored source id, so it is dropped too,
 * but an insert keeps it — it is the idempotency key a split-write retry
 * reconciles an orphaned base row on. Request screening still refuses a
 * client copy on every path.
 */
const PLATFORM_COLUMN_KEYS = new Set(['rowid', 'creatorid']);

function stripColumnKeys(values: Record<string, unknown>, which: 'added' | 'modified' | 'both'): void {
  for (const key of Object.keys(values)) {
    const lower = key.toLowerCase();
    if ((which === 'added' || which === 'both') && ADDED_COLUMN_KEYS.has(lower)) delete values[key];
    if ((which === 'modified' || which === 'both') && MODIFIED_COLUMN_KEYS.has(lower)) delete values[key];
  }
}

/**
 * Username stored in Added User / Modified User.
 * Creator stores the username, which is what `zoho.loginuser` returns — not the
 * email (`zoho.loginuserid`).
 * https://help.zoho.com/portal/en/kb/creator/developer-guide/forms/add-and-manage-fields/articles/understand-system-fields
 * https://www.zoho.com/deluge/help/zoho-variables.html
 * A report filter on Added User compares that username to `zoho.loginuser`.
 */
function creatorUsername(principal: Principal | undefined): string {
  const name = principal?.loginUser?.trim();
  if (name) return name;
  return DRY_RUN_LOGIN_USER;
}

function labelledIdentity(value: string | undefined, sentinel: string): { value: string; sentinel: boolean } {
  const trimmed = value?.trim();
  if (trimmed) return { value: trimmed, sentinel: false };
  return { value: sentinel, sentinel: true };
}

/**
 * Added Time and Modified Time are the app time zone, the same zone as
 * `zoho.currenttime` (Creator shows them in the application date-time format).
 * https://help.zoho.com/portal/en/kb/creator/developer-guide/forms/add-and-manage-fields/articles/understand-system-fields
 * Caller copies of these columns are dropped. `authorizeWrite` already rejects
 * them; this is the server write that follows that rejection.
 */
function applySystemColumns(values: Record<string, unknown>, op: 'insert' | 'update', ctx: ShimContext): Record<string, unknown> {
  const out = { ...values };
  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase();
    if (PLATFORM_COLUMN_KEYS.has(lower) || (op === 'update' && lower === 'c2c_source_id')) delete out[key];
  }
  const user = creatorUsername(ctx.principal);
  const time = dates.now(ctx.now, dates.requireZone(ctx.appTimeZone));
  stripColumnKeys(out, 'both');
  if (op === 'insert') {
    out.Added_User = user;
    out.Added_Time = time;
  } else {
    out.Modified_User = user;
    out.Modified_Time = time;
  }
  return out;
}

/** Drop client system keys, then copy the four stored columns. Does not copy ROWID or other fields. */
function mergeStoredSystemFields(record: Record<string, unknown>, stored: Record<string, unknown>): void {
  stripColumnKeys(record, 'both');
  for (const spec of SYSTEM_FIELD_KEYS) {
    const value = systemValue(stored, spec.name);
    if (value !== undefined) record[spec.name] = value;
  }
}

function systemValue(row: unknown, name: string): unknown {
  const values =
    row && typeof row === 'object' && '__row' in row ? (row as RowMeta).values : (row as Record<string, unknown> | null);
  if (!values || typeof values !== 'object') return undefined;
  const spec = SYSTEM_FIELD_KEYS.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!spec) return undefined;
  const rec = values as Record<string, unknown>;
  for (const key of spec.keys) {
    if (Object.prototype.hasOwnProperty.call(rec, key)) return rec[key];
  }
  return undefined;
}

/**
 * `for each` over a value that is not a collection. Creator rejects it, but no
 * Creator runtime text has been captured for this rejection — the message names
 * the construct so the transcript is readable, and the error is
 * UncapturedDelugeError, not DelugeRuntimeError, so the gate does not count a
 * made-up message as a mapped Creator error.
 */
export const FOR_EACH_NOT_COLLECTION = "Value is not a collection and 'for each' cannot be applied";

/** A record collection (array) stands for its first record; an empty one for null. */
function firstRecord(row: unknown): unknown {
  return Array.isArray(row) ? (row.length ? row[0] : null) : row;
}

/**
 * Path segments a get or set may never touch: reading them walks the shared
 * prototype, and writing them either mutates it or reparents the record.
 */
const UNSAFE_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The shared objects a generated write may never land on: mutating one would
 * leak into every object in the process. Functions are refused too — a
 * `prototype` segment is already refused, but a function itself is never a
 * Deluge map.
 */
function sharedProtoTarget(value: unknown): boolean {
  return value === Object.prototype || value === Function.prototype || typeof value === 'function';
}

/**
 * Generated `obj[key]` index read: own keys only. A `__proto__`,
 * `constructor`, or `prototype` segment — and any inherited member — reads as
 * undefined, so no compiled read can hand a script the shared prototype.
 */
function indexGet(obj: unknown, key: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj === 'function') return undefined;
  const k = String(key);
  if (UNSAFE_PATH_KEYS.has(k)) return undefined;
  const boxed = Object(obj) as Record<string, unknown>;
  const got = Object.hasOwn(boxed, k) ? boxed[k] : undefined;
  // A stored shared prototype is not a readable value either — handing it out
  // would let a later step write through it.
  return sharedProtoTarget(got) ? undefined : got;
}

/**
 * Generated `obj[key] = v` (and `obj.name = v`): refuses the unsafe segment
 * names and never writes onto a shared prototype object. Writing a key a read
 * could then hand back out is the whole leak — keeping both under one guard
 * means a stored object that is itself a prototype stays inert.
 */
function indexSet(obj: unknown, key: unknown, value: unknown): unknown {
  if (obj === null || obj === undefined || (typeof obj !== 'object' && typeof obj !== 'function')) return value;
  if (sharedProtoTarget(obj)) return value;
  const k = String(key);
  if (UNSAFE_PATH_KEYS.has(k)) return value;
  (obj as Record<string, unknown>)[k] = value;
  return value;
}

function getPath(root: unknown, path: string[]): unknown {
  let cur = root;
  for (const p of path) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (UNSAFE_PATH_KEYS.has(p)) return undefined;
    const record = cur as Record<string, unknown>;
    // `ID` is logical: a record's id reads as its Catalyst ROWID when the
    // object does not carry a literal ID key (docs/schema-mapping.md).
    if (Object.hasOwn(record, p)) {
      cur = record[p];
    } else if (p === 'ID') {
      cur = Object.hasOwn(record, 'ROWID') ? record.ROWID : Object.hasOwn(record, 'rowid') ? record.rowid : undefined;
    } else {
      return undefined;
    }
  }
  // A stored shared prototype reads undefined: it is never a readable value.
  return sharedProtoTarget(cur) ? undefined : cur;
}

function setPath(root: Record<string, unknown>, path: string[], value: unknown): unknown {
  if (!path.length) return value;
  if (path.some((k) => UNSAFE_PATH_KEYS.has(k))) return value;
  if (sharedProtoTarget(root)) return value;
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    const next = Object.hasOwn(cur, k) ? cur[k] : undefined;
    if (next === null || next === undefined || typeof next !== 'object') {
      const created: Record<string, unknown> = {};
      cur[k] = created;
      cur = created;
    } else {
      // An own value that IS a shared prototype (stored earlier) is not a
      // walkable map — writing through it would mutate every object.
      if (sharedProtoTarget(next)) return value;
      cur = next as Record<string, unknown>;
    }
  }
  if (sharedProtoTarget(cur)) return value;
  cur[path[path.length - 1]!] = value;
  return value;
}

function isCriteria(value: unknown): value is Criteria {
  return !!value && typeof value === 'object' && 'op' in (value as object);
}

/** Bind `{ __rel }` before ZCQL. A missing zone becomes a todo so the read is not every row. */
function boundQueryCriteria(ctx: ShimContext, criteria: Criteria): Criteria {
  if (!criteriaHasRelative(criteria)) return criteria;
  try {
    return bindRelativeCriteria(criteria, ctx.now, dates.requireZone(ctx.appTimeZone));
  } catch {
    return { op: 'todo', construct: 'criteria-dynamic' };
  }
}

/**
 * The store's answer for a read of a table that does not exist: a 404, a
 * table-named "not found" / "does not exist" message, or a `TABLE_NOT_FOUND`-
 * family code. The flow-history read treats it as an empty result; every
 * other error still propagates.
 */
function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  if (e.status === 404 || e.statusCode === 404) return true;
  if (typeof e.code === 'string' && /^(TABLE_NOT_FOUND|INVALID_TABLE|INVALID_TABLE_NAME|NO_SUCH_TABLE)$/i.test(e.code)) return true;
  if (typeof e.message === 'string') {
    if (/\bno such table\b/i.test(e.message)) return true;
    if (/\btable\b[^.]*\b(not found|does not exist|doesn't exist)\b/i.test(e.message)) return true;
  }
  return false;
}

/**
 * The scalars a value compares by in `Field == literal`: a bound record or a
 * lookup `{id, label}` object contributes its id/label members; a list
 * (multi lookup) contributes every member's scalars; anything else is itself.
 */
function compareScalars(value: unknown): unknown[] {
  const flat = value && typeof value === 'object' && '__row' in (value as object) ? (value as RowMeta).values : value;
  if (Array.isArray(flat)) return flat.flatMap(compareScalars);
  if (flat && typeof flat === 'object') {
    const record = flat as Record<string, unknown>;
    const members = [record.id, record.ID, record.ROWID, record.rowid, record.label, record.name].filter(
      (m) => m != null && typeof m !== 'object',
    );
    if (members.length) return members;
  }
  return [flat];
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** A lookup `{id, label}` key contributes its id; every other key is itself. */
function mapRowKey(key: unknown): string | null {
  if (key == null) return null;
  return String(key && typeof key === 'object' && 'id' in key ? (key as { id: unknown }).id : key);
}

/** Distinct non-empty keys in order; a lookup object is sent as its id. */
function validMapKeys(keys: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    if (k == null || k === '') continue;
    const norm = mapRowKey(k);
    if (norm === null || seen.has(norm)) continue;
    seen.add(norm);
    out.push(k && typeof k === 'object' && 'id' in k ? (k as { id: unknown }).id : k);
  }
  return out;
}

export interface Runtime {
  dryRun: boolean;
  transcript: TranscriptEntry[];
  shim: Shim;
  context(partial?: ContextInput): ShimContext;
}

/** A paged ZCQL read kept filling 300-row pages past {@link LIMITS.zcqlMaxRows}. */
export class ZcqlRowCapError extends Error {
  readonly code = 'ZCQL_ROW_CAP';
  constructor(form: string, maxRows: number) {
    super(`ZCQL result for ${form} exceeded ${maxRows} rows; refusing to return a truncated page`);
    this.name = 'ZcqlRowCapError';
  }
}

/** updateRows addresses a row by ROWID. A live write does not skip a row that lacks one. */
export class MissingRowIdError extends Error {
  readonly code = 'MISSING_ROWID';
  constructor(form: string) {
    super(`live write on ${form} requires ROWID; refusing to skip the row`);
    this.name = 'MissingRowIdError';
  }
}

/**
 * `range from` / `range to` is not a usable index.
 * Negative indexes are a Deluge runtime error
 * (https://www.zoho.com/deluge/help/fetch-records/fetch-collection-records.html).
 */
export class RangeIndexError extends Error {
  readonly code = 'RANGE_INDEX';
  constructor(message: string) {
    super(message);
    this.name = 'RangeIndexError';
  }
}

function nonemptyZone(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** A `__row` argument to a record-typed `thisapp` parameter contributes its live values. */
function rowArgument(value: unknown): unknown {
  return value && typeof value === 'object' && '__row' in value ? (value as RowMeta).values : value;
}


interface ParsedStage {
  columns: string[];
  table: string;
  where: string;
  orderBy: string;
}

function parseStage(sql: string): ParsedStage {
  const match = /^SELECT (.+) FROM ([A-Za-z_][A-Za-z0-9_]*)(?: WHERE (.+?))?( ORDER BY .+)?$/.exec(sql);
  if (!match) {
    throw new Error(`staged zcql could not be parsed, so it was not run as SELECT *: ${sql}`);
  }
  return {
    columns: match[1]!.split(', ').filter((column) => column.length > 0),
    table: match[2]!,
    where: match[3] ?? '',
    orderBy: match[4]?.trim() ?? '',
  };
}

function sqlLit(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `'${text.replace(/'/g, "''")}'`;
}

/** One bound IN list per ZCQL page, so a later stage pages the same rows as the first. */
async function fetchBound(
  query: PageQuery,
  table: string,
  column: string,
  ids: readonly unknown[],
  extraWhere: string,
  orderBy: string,
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const out: Record<string, unknown>[] = [];
  const size = LIMITS.zcqlRowsPerQuery;
  for (let index = 0; index < ids.length; index += size) {
    const part = ids.slice(index, index + size);
    const listed = `${column} IN (${part.map(sqlLit).join(', ')})`;
    const extra = extraWhere.trim();
    const where = extra && extra !== 'true' ? `(${listed}) AND (${extra})` : listed;
    const rows = await fetchRows(table, where, undefined, orderBy || 'ORDER BY ROWID', query);
    out.push(...rows);
  }
  return out;
}

/**
 * Run every staged statement. The first statement gets the criteria WHERE.
 * Later statements of the base table get that same predicate AND the ROWID
 * bind. Extension and lookup stages are bound to the rows the predicate selected.
 */
async function runStagedRead(
  query: PageQuery,
  plan: Query,
  criteria: Criteria,
  where: string,
  range: Query['range'] | undefined,
  sort: Query['sort'] | undefined,
  decimals: DecimalColumns,
): Promise<Record<string, unknown>[]> {
  const stages = (plan.zcql ?? []).map(parseStage);
  const drive = stages[0];
  if (!drive) return [];
  let driveWhere = where;
  if (drive.where && !drive.where.includes(':')) driveWhere = andWhere(where, drive.where);
  const baseRows = await queryExact(query, drive.table, driveWhere, {
    criteria,
    decimals,
    ...(sort ? { sort } : {}),
    ...(range ? { range } : {}),
  });
  const merged = baseRows.map((row) => ({ ...row }));
  const baseName = drive.table;
  for (const stage of stages.slice(1)) {
    const bind = /:([A-Za-z_][A-Za-z0-9_]*)/.exec(stage.where);
    if (!bind) {
      throw new Error(
        `staged zcql for ${stage.table} has no row bind (verified: false). Refusing an unfiltered read. No columns were dropped.`,
      );
    }
    const bindName = bind[1]!;
    const prefix = `${baseName}_`;
    if (!bindName.startsWith(prefix)) {
      throw new Error(`staged zcql bind :${bindName} is not a column of ${baseName}. The stage was not run.`);
    }
    const sourceColumn = bindName.slice(prefix.length);
    const values = sourceColumn === 'ROWID' ? merged.map((row) => rowIdentity(row)) : merged.map((row) => row[sourceColumn]);
    const column = /^(\w+) IN \(/.exec(stage.where)?.[1] ?? 'ROWID';
    const onBase = stage.table === baseName;
    const got = await fetchBound(query, stage.table, column, values, onBase ? where : '', stage.orderBy || 'ORDER BY ROWID');
    if (column === EXTENSION_KEY) {
      const byParent = new Map<string, Record<string, unknown>>();
      for (const row of got) byParent.set(String(row[EXTENSION_KEY]), row);
      for (const target of merged) {
        const hit = byParent.get(String(rowIdentity(target)));
        if (!hit) continue;
        for (const [key, value] of Object.entries(hit)) {
          if (key === EXTENSION_KEY || key === 'ROWID') continue;
          target[key] = value;
        }
      }
      continue;
    }
    if (onBase) {
      const byId = new Map(got.map((row) => [String(rowIdentity(row)), row]));
      for (const target of merged) {
        const hit = byId.get(String(rowIdentity(target)));
        if (!hit) continue;
        for (const [key, value] of Object.entries(hit)) target[key] = value;
      }
      continue;
    }
    const byId = new Map(got.map((row) => [String(rowIdentity(row)), row]));
    for (const target of merged) {
      const hit = byId.get(String(target[sourceColumn]));
      if (!hit) continue;
      for (const name of stage.columns) {
        if (name === 'ROWID' || name === EXTENSION_KEY) continue;
        if (!Object.prototype.hasOwnProperty.call(hit, name)) continue;
        // Report columns are dotted (`Language.Language`). The bare name is the
        // base column, often the FK. Writing the display there replaces the id.
        if (sourceColumn !== 'ROWID') target[`${sourceColumn}.${name}`] = hit[name];
        else target[name] = hit[name];
      }
    }
  }
  return merged;
}


/**
 * A bigint count is used only when it is an exact safe integer.
 * A larger magnitude is the same precision refusal as `toLong`, not a rounded number.
 */
function exactDayCount(n: number | bigint): number {
  if (typeof n === 'bigint') {
    const limit = BigInt(Number.MAX_SAFE_INTEGER);
    if (n > limit || n < -limit) {
      throw new DelugeConversionError('toLong: magnitude exceeds 2^53; refusing to lose precision');
    }
  }
  return Number(n);
}

function hasCounters(counters: RuntimeOptions['counters']): boolean {
  const named = (map: Record<string, object> | undefined) => Object.values(map ?? {}).some((entry) => Object.keys(entry).length > 0);
  return named(counters?.columns) || named(counters?.autonumber);
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const dryRun = options.dryRun !== false;
  const adminUserIdValue = () => labelledIdentity(options.adminUserId, DRY_RUN_ADMIN_USER_ID).value;
  const configuredZone = nonemptyZone(options.appTimeZone) ?? nonemptyZone(process.env.C2C_APP_TIMEZONE);
  // Fail at construction: a live runtime must not be created without a zone.
  if (!dryRun) dates.resolveAppTimeZone(configuredZone, options.settingsTimeZone, false);
  // Fail at construction: a losing counter claim must be deleted, so live counters need datastore.delete.
  if (!dryRun && options.datastore && !options.datastore.delete && hasCounters(options.counters)) {
    throw new Error('counters: the datastore adapter has no delete; a losing claim could not be removed');
  }
  const seed = typedSeed(options.seed, options.fieldValues);
  const transcript: TranscriptEntry[] = [];
  const note = (entry: TranscriptEntry) => {
    transcript.push(entry);
  };

  /**
   * A request for the transcript (returned to the caller): Authorization and any
   * header or parameter named like a secret (zohoAdapters.SECRET_NAME) masked,
   * URL userinfo and secret query values masked.
   */
  const redact = zohoAdapters.redactForTranscript;

  /**
   * Live outbound messages (sendmail, Cliq posts, invokeurl/http writes to
   * Cliq or Zoho Mail, and any write to a Zoho endpoint c2c does not classify;
   * see zohoAdapters.classifyZohoWrite) go only to org-internal
   * destinations unless the owner approved (zohoConnections.orgInternal /
   * ownerApprovalToken). Throws ZohoConnectionRefused('owner-approval') before
   * any credential or fetch. The token itself is never recorded.
   */
  function guardMessage(call: string, destinations: zohoAdapters.MessageDestination[]): void {
    try {
      const { approvedBy } = zohoAdapters.guardMessaging(options.zohoConnections, call, destinations);
      note({ op: 'messaging-guard', call, destinations: destinations.map((d) => d.value), approvedBy });
    } catch (err) {
      note({ op: 'live-refused', call, reason: 'owner-approval', destinations: destinations.map((d) => d.value) });
      throw err;
    }
  }

  function refuseLive(op: string): void {
    if (!dryRun) note({ op: 'live-refused', call: op, reason: 'no adapter and no network fallback' });
  }

  function warnLongStrings(form: string, values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'string' && value.length > LIMITS.varcharMaxLength) {
        note({
          op: 'warn',
          code: 'VARCHAR_255',
          form,
          field: key,
          length: value.length,
          detail: `value length ${value.length} exceeds varchar ${LIMITS.varcharMaxLength}; not truncated (Catalyst truncates silently)`,
        });
      }
    }
  }

  function encryptedOf(form: string): Set<string> {
    return new Set(options.encryptedColumns?.[form] ?? []);
  }

  function decimalsOf(form: string): DecimalColumns {
    const map = options.decimalColumns;
    return map && Object.hasOwn(map, form) ? map[form]! : {};
  }

  function rulesOf(form: string): readonly WriteRuleColumn[] | undefined {
    const map = options.writeRules;
    return map && Object.hasOwn(map, form) ? map[form] : undefined;
  }

  /**
   * The shared write check on the row exactly as it will be sent (post
   * stringify, shadows included). A computed Decimal can carry more
   * fractional digits than the column, so scale columns are rounded to their
   * places first — the same value the field keeps. Throws WriteRuleError,
   * which classifies as a store refusal, before the datastore adapter runs,
   * so a dry run records the same refusal a live write would get.
   */
  function checkedWrite(form: string, values: Record<string, unknown>, required: boolean): Record<string, unknown> {
    const rules = rulesOf(form);
    if (!rules?.length) return values;
    try {
      return assertWritable(form, rules, quantizeRow(rules, values), { required });
    } catch (err) {
      if (err instanceof WriteRuleError) {
        note({ op: 'error', code: err.code, message: err.message, form, field: err.field });
      }
      throw err;
    }
  }

  function appUniqueOf(form: string): readonly string[] {
    const map = options.appUniqueColumns;
    return map && Object.hasOwn(map, form) ? map[form]! : [];
  }

  /**
   * ROWIDs of rows holding `value` in an app-unique field. Not scoped to the caller's
   * record filter: a duplicate the caller cannot see is still a duplicate. Only ids are kept.
   */
  async function rowsHolding(form: string, field: string, value: unknown): Promise<string[]> {
    const where = whereOf(form, { op: '==', field, value });
    const got = await queryPage(form, where, 2, 0, 'ORDER BY ROWID');
    return got.map((row) => String(rowIdentity(row) ?? ''));
  }

  function blank(value: unknown): boolean {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  }

  /** Claim the next number for each blank autonumber field of a live insert row. */
  async function assignAutonumbers(form: string, row: Record<string, unknown>): Promise<void> {
    const fields = options.counters?.autonumber?.[form];
    if (!fields) return;
    for (const [field, spec] of Object.entries(fields)) {
      if (!blank(row[field])) continue;
      const store = counterStore();
      if (!store) throw new Error(`autonumber ${form}.${field}: the datastore adapter needs insert, query and update`);
      const n = await nextAutonumber(store, form, field, spec.start ?? 1, counterOptions());
      row[field] = n.toString();
      note({ op: 'autonumber', form, field, value: row[field] });
    }
  }

  /** Refuse a write that would store a second row with an app-unique value. `own` are the rows being updated. */
  async function checkAppUnique(form: string, values: Record<string, unknown>, own: readonly string[], rows: number): Promise<void> {
    for (const field of appUniqueOf(form)) {
      if (!Object.hasOwn(values, field) || blank(values[field])) continue;
      const holders = await rowsHolding(form, field, values[field]);
      const others = holders.filter((id) => !own.includes(id));
      if (others.length > 0 || rows > 1) {
        const err = new UniqueRefused(field);
        note({ op: 'error', code: err.code, message: err.message, form });
        throw err;
      }
    }
  }

  /**
   * Row for the store: scale columns are rounded first, so the Double shadows
   * are computed from the rounded value the varchar keeps.
   */
  function shadowsForWrite(form: string, stored: Record<string, unknown>): Record<string, unknown> {
    return withShadows(form, quantizeRow(rulesOf(form), stored));
  }

  /** Shadow values for every exact-decimal field present in a stored row. */
  function withShadows(form: string, stored: Record<string, unknown>): Record<string, unknown> {
    const decimals = decimalsOf(form);
    let out = stored;
    for (const [field, spec] of Object.entries(decimals)) {
      if (!Object.hasOwn(stored, field)) continue;
      if (out === stored) out = { ...stored };
      out[spec.shadow] = decimalShadow(stored[field]);
    }
    return out;
  }

  /** Paged live read, exact on decimal criteria and sort. Shadow columns are not returned. */
  function liveRows(form: string, criteria: Criteria, where: string, range: Query['range'] | undefined, sort?: Query['sort']) {
    return queryExact(queryPage, form, where, { criteria, decimals: decimalsOf(form), ...(sort ? { sort } : {}), ...(range ? { range } : {}) });
  }

  /** Staged reads run every statement. Unstaged reads stay on the single-query path. */
  function readLive(query: Query, criteria: Criteria, where: string, range: Query['range'] | undefined, sort?: Query['sort']) {
    if (query.zcql?.length) return runStagedRead(queryPage, query, criteria, where, range, sort, decimalsOf(query.form));
    return liveRows(query.form, criteria, where, range, sort);
  }

  const BASE_ALWAYS = new Set(['Added_User', 'Added_Time', 'Modified_User', 'Modified_Time', 'c2c_source_id', 'ROWID', 'ID', 'id']);

  function layoutOf(form: string): TableSplitLayout | undefined {
    return options.splits?.[form];
  }

  function refuseUnsplitWidth(form: string, values: Record<string, unknown>): void {
    const cap = DATASTORE_COLUMNS_PER_TABLE;
    let count = 0;
    for (const key of Object.keys(values)) {
      if (!BASE_ALWAYS.has(key)) count += 1;
    }
    if (count > cap) {
      throw new Error(
        `write refused for ${form}: ${count} columns exceed the Data Store column cap ${cap} (verified: false) and this form has no split layout. No column was dropped and no write was sent.`,
      );
    }
  }

  function partition(form: string, layout: TableSplitLayout, values: Record<string, unknown>): {
    base: Record<string, unknown>;
    extensions: { table: string; values: Record<string, unknown> }[];
  } {
    const home = new Map<string, string>();
    for (const column of layout.baseColumns) home.set(column, '');
    for (const ext of layout.extensions) {
      for (const column of ext.columns) home.set(column, ext.table);
    }
    const unknown: string[] = [];
    const base: Record<string, unknown> = {};
    const extValues = new Map<string, Record<string, unknown>>();
    for (const ext of layout.extensions) extValues.set(ext.table, {});
    for (const [key, value] of Object.entries(values)) {
      if (key === EXTENSION_KEY) continue;
      if (BASE_ALWAYS.has(key)) {
        base[key] = value;
        continue;
      }
      const table = home.get(key);
      if (table === undefined) {
        unknown.push(key);
        continue;
      }
      if (table === '') base[key] = value;
      else extValues.get(table)![key] = value;
    }
    if (unknown.length > 0) {
      throw new Error(
        `split write refused for ${form}: ${unknown.join(', ')} not on the base table or an extension. No column was dropped and no write was sent. Column cap ${DATASTORE_COLUMNS_PER_TABLE} (verified: false).`,
      );
    }
    return {
      base,
      extensions: layout.extensions.map((ext) => ({ table: ext.table, values: extValues.get(ext.table)! })),
    };
  }

  /** Throws before any write when the layout cannot place every column. */
  function guardWrite(form: string, values: Record<string, unknown>): TableSplitLayout | undefined {
    const layout = layoutOf(form);
    if (!layout) {
      refuseUnsplitWidth(form, values);
      return undefined;
    }
    partition(form, layout, values);
    return layout;
  }

  function insertedId(result: unknown): unknown {
    if (!result || typeof result !== 'object') return undefined;
    const body = rowRecord(result);
    const list = Array.isArray(body.rows) ? body.rows : Array.isArray(body.data) ? body.data : null;
    if (list && list[0] && typeof list[0] === 'object') {
      const row = rowRecord(list[0]);
      const id = rowIdentity(row);
      if (id != null && id !== '') return id;
      if (row.ID != null && row.ID !== '') return row.ID;
      if (row.id != null && row.id !== '') return row.id;
    }
    if (body.ROWID != null && body.ROWID !== '') return body.ROWID;
    if (body.ID != null && body.ID !== '') return body.ID;
    if (body.id != null && body.id !== '') return body.id;
    return undefined;
  }

  /** A previous attempt stored this Creator id. Reuse that base row instead of inserting another. */
  async function baseIdForSource(table: string, sourceId: unknown): Promise<unknown> {
    const queryRows = options.datastore?.query;
    if (!queryRows || sourceId == null || sourceId === '') return undefined;
    const rows = await queryRows(table, `c2c_source_id = ${sqlLit(sourceId)}`, 1, 0, 'ORDER BY ROWID');
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return undefined;
    const id = rowIdentity(row);
    return id == null || id === '' ? undefined : id;
  }

  /**
   * Extension insert failed. Remove the base row this call created and any
   * extension rows stored under it. The caller's error stays the extension error.
   */
  async function compensateSplit(layout: TableSplitLayout, parent: unknown): Promise<void> {
    const deleteRows = options.datastore?.delete;
    if (!deleteRows || parent == null || parent === '') return;
    const queryRows = options.datastore?.query;
    if (queryRows) {
      for (const ext of layout.extensions) {
        try {
          const rows = await queryRows(ext.table, `${EXTENSION_KEY} = ${sqlLit(parent)}`, LIMITS.zcqlRowsPerQuery, 0, 'ORDER BY ROWID');
          const ids: unknown[] = [];
          for (const row of rows ?? []) {
            const id = rowIdentity(row);
            if (id != null && id !== '') ids.push(id);
          }
          for (const part of chunk(ids, LIMITS.updateRowsPerCall)) {
            if (part.length > 0) await deleteRows(ext.table, part);
          }
        } catch {
          // Still delete the base. A retry finds it by c2c_source_id when this delete did not land.
        }
      }
    }
    try {
      await deleteRows(layout.base, [parent]);
    } catch {
      // The extension error is what the caller handles.
    }
  }

  async function insertSplit(form: string, layout: TableSplitLayout, stored: Record<string, unknown>): Promise<unknown> {
    const placed = partition(form, layout, stored);
    const insertRows = options.datastore?.insert;
    if (!insertRows) throw new Error(`no datastore insert adapter for ${form}`);
    const existing = await baseIdForSource(layout.base, placed.base.c2c_source_id);
    let parent = existing;
    let baseResult: unknown;
    let createdBase = false;
    if (parent == null || parent === '') {
      baseResult = await insertRows(layout.base, [placed.base]);
      parent = insertedId(baseResult);
      createdBase = true;
      if (parent == null || parent === '') {
        throw new Error(
          `split write refused for ${form}: the base insert returned no ROWID, so no extension row was written. No extension column was dropped.`,
        );
      }
    } else {
      baseResult = { ROWID: parent };
    }
    try {
      for (const ext of placed.extensions) {
        await insertRows(ext.table, [{ [EXTENSION_KEY]: parent, ...ext.values }]);
      }
    } catch (err) {
      if (createdBase) await compensateSplit(layout, parent);
      throw err;
    }
    return baseResult;
  }

  async function updateSplit(form: string, layout: TableSplitLayout, stored: Record<string, unknown>, parentIds: readonly unknown[]): Promise<void> {
    const updateRows = options.datastore?.update;
    const insertRows = options.datastore?.insert;
    if (!updateRows || !insertRows) throw new Error(`no datastore write adapter for ${form}`);
    const placed = partition(form, layout, stored);
    const basePayload = rowRecord({ ...placed.base });
    delete basePayload.ROWID;
    delete basePayload.ID;
    delete basePayload.id;
    if (Object.keys(basePayload).length > 0) {
      const rows = parentIds.map((id) => ({ ROWID: id, ...basePayload }));
      for (const part of chunk(rows, LIMITS.updateRowsPerCall)) await updateRows(layout.base, part);
    }
    for (const ext of placed.extensions) {
      if (Object.keys(ext.values).length === 0) continue;
      const found = await fetchBound(queryPage, ext.table, EXTENSION_KEY, parentIds, '', 'ORDER BY ROWID');
      const byParent = new Map<string, Record<string, unknown>>();
      for (const row of found) byParent.set(String(row[EXTENSION_KEY]), row);
      const updates: Record<string, unknown>[] = [];
      const inserts: Record<string, unknown>[] = [];
      for (const id of parentIds) {
        const hit = byParent.get(String(id));
        if (hit) updates.push({ ROWID: requireRowId(ext.table, rowIdentity(hit)), ...ext.values });
        else inserts.push({ [EXTENSION_KEY]: id, ...ext.values });
      }
      for (const part of chunk(updates, LIMITS.updateRowsPerCall)) {
        if (part.length > 0) await updateRows(ext.table, part);
      }
      for (const part of chunk(inserts, LIMITS.insertRowsPerCall)) {
        if (part.length > 0) await insertRows(ext.table, part);
      }
    }
  }

  function whereOf(form: string, criteria: Criteria): string {
    try {
      return compileCriteria(criteria, encryptedOf(form), decimalsOf(form));
    } catch (err) {
      if (err instanceof EncryptedCriteriaError) {
        note({ op: 'error', code: err.code, message: err.message, form });
      }
      throw err;
    }
  }

  function scopeRead(
    ctx: ShimContext,
    form: string,
    criteria: Criteria,
    field?: string,
    intent?: ReadIntent,
  ): { criteria: Criteria; fields?: readonly string[] } {
    if (!options.access) return { criteria };
    try {
      return authorizeRead(options.access, ctx.principal, form, criteria, field, intent);
    } catch (err) {
      if (err instanceof RecordAccessError) note({ op: 'error', code: err.code, message: err.message, form });
      throw err;
    }
  }

  /**
   * The fetch behind `datastore.rows` and the flow-history read: seed, dry-run
   * refusal, then the live adapter. `scoped` is the already-authorized (or
   * policy-bypassing) criteria and field list.
   */
  async function readQueryRows(
    ctx: ShimContext,
    query: Query,
    scoped: { criteria: Criteria; fields?: readonly string[] },
  ): Promise<RowMeta[]> {
    const where = whereOf(query.form, scoped.criteria);
    const fields = query.system ? undefined : scoped.fields;
    note({
      op: 'fetch',
      form: query.form,
      where,
      limit: LIMITS.zcqlRowsPerQuery,
      sort: query.sort ?? null,
      range: query.range ?? null,
      dryRun,
      authorized: !!options.access,
    });
    const seeded = await readSeed(seed, dryRun, query.form, scoped.criteria, query.sort, query.range, decimalsOf(query.form));
    if (seeded) {
      const hydrated = await Promise.all(seeded.map((raw) => readMultiLookups(query.form, raw, fields)));
      return hydrated.map((raw) => shim.record.bind(ctx, scopedRow(raw, fields), query.form));
    }
    if (dryRun || !options.datastore?.query) {
      refuseLive('fetch');
      return [];
    }
    const got = await readLive(query, scoped.criteria, where, query.range, query.sort);
    const hydrated = await Promise.all(got.map((raw) => readMultiLookups(query.form, raw, fields)));
    return hydrated.map((raw) => {
      const row = shim.record.bind(ctx, scopedRow(raw, fields), query.form);
      fetchedRows.set(row, { form: query.form, rowid: rowIdentity(raw), principal: ctx.principal });
      return row;
    });
  }

  async function readMultiLookups(form: string, row: Record<string, unknown>, fields?: readonly string[]): Promise<Record<string, unknown>> {
    const specs = options.multiLookups?.[form];
    const parentId = rowIdentity(row);
    if (!specs || parentId == null) return row;
    const out = { ...row };
    for (const [field, spec] of Object.entries(specs)) {
      if (fields && !fields.includes(field)) continue;
      let values: unknown[];
      if (dryRun && seed && Object.hasOwn(seed, spec.table)) {
        const junctionRows = (seed[spec.table] ?? [])
          .filter((junctionRow) => String(junctionRow[spec.parentColumn]) === String(parentId))
          .map((junctionRow, index) => ({ row: junctionRow, id: String(junctionRow.ROWID ?? junctionRow.rowid ?? index + 1) }))
          .sort((a, b) => {
            const order = Number(a.row[spec.orderColumn]) - Number(b.row[spec.orderColumn]);
            return (Number.isNaN(order) || order === 0 ? 0 : order) || compareIds(a.id, b.id);
          })
          .map(({ row }) => row);
        values = await readMultiLookupValues(async (_table, _where, limit, offset = 0) => junctionRows.slice(offset, offset + limit), spec, parentId);
      } else if (!dryRun && options.datastore?.query) {
        values = await readMultiLookupValues(options.datastore.query, spec, parentId);
      } else {
        continue;
      }
      out[field] = values;
    }
    return out;
  }

  function readDate(value: unknown): dates.DelugeDate | null {
    return dates.asDate(value);
  }

  function readDateOrBlank(value: unknown): { date: dates.DelugeDate | null; blank: boolean } {
    if (value == null || (typeof value === 'string' && value.trim() === '')) return { date: null, blank: true };
    const date = dates.asDate(value);
    return { date, blank: date == null };
  }

  /** Both ends of a between-dates count. A blank end is `UnParsable date`, as `days360`. */
  function datePair(a: unknown, b: unknown): [dates.DelugeDate, dates.DelugeDate] {
    const da = readDate(a);
    const db = readDate(b);
    if (!da || !db) throw new DelugeRuntimeError('UnParsable date');
    return [da, db];
  }

  const MAX_SAFE_INT = BigInt(Number.MAX_SAFE_INTEGER);

  /**
   * Epoch milliseconds that fit in a safe integer. A bigint past 2^53 is not
   * rounded: the same refusal toLong uses for a magnitude that cannot be a number.
   */
  function exactEpochMillis(value: unknown): number {
    if (typeof value === 'bigint') {
      if (value > MAX_SAFE_INT || value < -MAX_SAFE_INT) {
        throw new DelugeConversionError('toLong: magnitude exceeds 2^53; refusing to lose precision');
      }
      return Number(value);
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new DelugeRuntimeError('UnParsable date');
      const truncated = Math.trunc(value);
      if (!Number.isSafeInteger(truncated)) {
        throw new DelugeConversionError('toLong: magnitude exceeds 2^53; refusing to lose precision');
      }
      return truncated;
    }
    throw new DelugeRuntimeError('UnParsable date');
  }

  /** A blank zone is the application time zone. An explicit zone is used as given. */
  function zoneArg(timeZone: unknown, ctx: ShimContext): string {
    if (timeZone == null || (typeof timeZone === 'string' && timeZone.trim() === '')) {
      return dates.requireZone(ctx.appTimeZone);
    }
    if (typeof timeZone !== 'string') throw new DelugeRuntimeError('UnParsable date');
    return dates.requireZone(timeZone.trim());
  }

  /** Whole months or years. A blank end is null. A non-date that is not blank throws. */
  function wholePeriod(a: unknown, b: unknown, count: (x: dates.DelugeDate, y: dates.DelugeDate) => number): number | null {
    if (a == null || b == null) return null;
    const da = dates.asDate(a);
    const db = dates.asDate(b);
    if (!da || !db) return null;
    return count(da, db);
  }

  const dateApi: Shim['date'] = {
    parse(literal) {
      return dates.parseLiteral(literal);
    },
    getYear(value) {
      return readDate(value)?.y ?? null;
    },
    getMonth(value) {
      return readDate(value)?.m ?? null;
    },
    getDay(value) {
      return readDate(value)?.d ?? null;
    },
    getHour(value) {
      return readDate(value)?.hh ?? null;
    },
    getMinutes(value) {
      return readDate(value)?.mm ?? null;
    },
    getSeconds(value) {
      return readDate(value)?.ss ?? null;
    },
    addDay(value, n) {
      const d = readDate(value);
      return d ? dates.addDays(d, Number(n)) : null;
    },
    addWeek(value, n) {
      const d = readDate(value);
      return d ? dates.addDays(d, Number(n) * 7) : null;
    },
    addMonth(value, n) {
      const d = readDate(value);
      return d ? dates.addMonths(d, Number(n)) : null;
    },
    addYear(value, n) {
      const d = readDate(value);
      return d ? dates.addMonths(d, Number(n) * 12) : null;
    },
    addHour(value, n) {
      const d = readDate(value);
      if (!d) return null;
      const total = d.hh + Number(n);
      const days = Math.floor(total / 24);
      const hh = ((total % 24) + 24) % 24;
      return new dates.DelugeDate(dates.addDays(d, days).y, dates.addDays(d, days).m, dates.addDays(d, days).d, hh, d.mm, d.ss);
    },
    addMinutes(value, n) {
      const d = readDate(value);
      if (!d) return null;
      const total = d.hh * 60 + d.mm + Number(n);
      const days = Math.floor(total / (24 * 60));
      const mins = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
      const base = dates.addDays(d, days);
      return new dates.DelugeDate(base.y, base.m, base.d, Math.floor(mins / 60), mins % 60, d.ss);
    },
    addSeconds(value, n) {
      const d = readDate(value);
      if (!d) return null;
      const total = d.hh * 3600 + d.mm * 60 + d.ss + Number(n);
      const days = Math.floor(total / 86400);
      const secs = ((total % 86400) + 86400) % 86400;
      const base = dates.addDays(d, days);
      return new dates.DelugeDate(base.y, base.m, base.d, Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60);
    },
    toDate(value) {
      if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
      try {
        const d = readDate(value);
        return d ? new dates.DelugeDate(d.y, d.m, d.d, 0, 0, 0) : null;
      } catch (err) {
        if (err instanceof DelugeRuntimeError) throw err;
        throw new DelugeRuntimeError('UnParsable date');
      }
    },
    toTime(value) {
      return readDate(value);
    },
    format(value, pattern) {
      // Creator toString: an unrecognized date-time is the given text, not null.
      // https://www.zoho.com/deluge/help/functions/common/tostring.html
      // Returning null becomes the literal "null" when concatenated.
      if (value == null) return '';
      if (typeof value === 'string') {
        if (value.trim() === '') return value;
        try {
          return dates.format(dates.parseLiteral(value), pattern);
        } catch {
          return value;
        }
      }
      if (value instanceof dates.DelugeDate) return dates.format(value, pattern);
      note({ op: 'error', code: 'DELUGE_RUNTIME', message: 'UnParsable date' });
      throw new DelugeRuntimeError('UnParsable date');
    },
    text(value) {
      if (value == null) return '';
      if (value instanceof dates.DelugeDate) return value.toString();
      if (typeof value === 'string') return value;
      return String(value);
    },
    isDate: dates.isDate,
    diffDays(a, b) {
      const da = readDate(a);
      const db = readDate(b);
      if (!da || !db) return null;
      // Creator date subtraction is milliseconds, not a day count.
      const days = da.epochDay() - db.epochDay();
      const ta = ((da.hh * 60 + da.mm) * 60 + da.ss) * 1000;
      const tb = ((db.hh * 60 + db.mm) * 60 + db.ss) * 1000;
      return days * 86400000 + (ta - tb);
    },
    addBusinessDay(value, n, ...args) {
      if (args.length > 1) {
        throw new DelugeRuntimeError("workday with weekends or holidays is unsupported");
      }
      const d = readDate(value);
      return d ? dates.addBusinessDays(d, exactDayCount(n)) : null;
    },
    getDayOfWeek(value) {
      const d = readDate(value);
      return d ? dates.weekdaySun1(d) : null;
    },
    toStartOfWeek(value) {
      const d = readDate(value);
      return d ? dates.startOfWeek(d) : null;
    },
    days360(a, b) {
      const da = readDate(a);
      const db = readDate(b);
      if (!da || !db) throw new DelugeRuntimeError('UnParsable date');
      return dates.days360Count(da, db);
    },
    toStartOfMonth(value) {
      const d = readDate(value);
      return d ? dates.startOfMonth(d) : null;
    },
    eomonth(value, n) {
      const d = readDate(value);
      return d ? dates.endOfMonth(d, Number(n ?? 0)) : null;
    },
    getDayOfYear(value) {
      const d = readDate(value);
      return d ? dates.dayOfYear(d) : null;
    },
    getWeekOfYear(value) {
      const d = readDate(value);
      return d ? dates.weekOfYear(d) : null;
    },
    daysBetween(a, b) {
      const [da, db] = datePair(a, b);
      return dates.daysBetweenCount(da, db);
    },
    monthsBetween(a, b) {
      const [da, db] = datePair(a, b);
      return dates.monthsBetweenCount(da, db);
    },
    yearsBetween(a, b) {
      const [da, db] = datePair(a, b);
      return dates.yearsBetweenCount(da, db);
    },
    hour(value) {
      return readDate(value)?.hh ?? null;
    },
    minute(value) {
      return readDate(value)?.mm ?? null;
    },
    second(value) {
      return readDate(value)?.ss ?? null;
    },
    month(value) {
      return readDate(value)?.m ?? null;
    },
    hoursBetween(a, b) {
      const [da, db] = datePair(a, b);
      return dates.hoursBetweenCount(da, db);
    },
    nextWeekDay(value, dayName) {
      const d = readDate(value);
      if (!d || typeof dayName !== 'string') return null;
      return dates.nextWeekDay(d, dayName);
    },
    previousWeekDay(value, dayName) {
      const d = readDate(value);
      if (!d || typeof dayName !== 'string') return null;
      return dates.previousWeekDay(d, dayName);
    },
    totalMonths(a, b) {
      return wholePeriod(a, b, dates.totalMonthsCount);
    },
    totalYears(a, b) {
      return wholePeriod(a, b, dates.totalYearsCount);
    },
    toDateTimeString(...args: any[]) {
      // functions/datetime/todatetimestring: epoch milliseconds only.
      const ctx = args.pop() as ShimContext;
      const value = args[0];
      const pattern = args[1];
      const timeZone = args[2];
      
      if (value == null) return null;
      if (args.length >= 2 && pattern == null) return null;
      if (typeof value === 'string' && value.trim() === '') return null;
      
      const effectivePattern = args.length < 2 || pattern == null ? "dd-MMM-yyyy HH:mm:ss" : pattern;
      if (typeof effectivePattern !== 'string') throw new DelugeRuntimeError('UnParsable date');
      
      const ms = exactEpochMillis(value);
      const parts = dates.partsInZone(new Date(ms), zoneArg(timeZone, ctx));
      return dates.format(new dates.DelugeDate(parts.y, parts.m, parts.d, parts.hh, parts.mm, parts.ss), effectivePattern);
    },
    unixEpoch(...args: any[]) {
      // functions/datetime/unix-epoch: text is required. A date value errors.
      // Unrecognized text is returned as text. No zone argument uses the app zone.
      const ctx = args.pop() as ShimContext;
      const value = args[0];
      const timeZone = args[1];
      
      if (value == null) return null;
      if (typeof value !== 'string') throw new DelugeRuntimeError('UnParsable date');
      if (value.trim() === '') return null;
      let parsed: dates.DelugeDate;
      try {
        parsed = dates.parseLiteral(value);
      } catch (err) {
        if (err instanceof DelugeRuntimeError) return value;
        throw err;
      }
      
      let tz: string;
      if (timeZone == null || (typeof timeZone === 'string' && timeZone.trim() === '')) {
        tz = dates.requireZone(ctx.appTimeZone);
      } else if (typeof timeZone !== 'string') {
        throw new DelugeRuntimeError('UnParsable date');
      } else {
        try {
          tz = dates.requireZone(timeZone.trim());
        } catch (err) {
          if (err instanceof RangeError) {
            tz = "GMT";
          } else {
            throw err;
          }
        }
      }
      return dates.epochMillis(parsed, tz);
    },
    subDay(value, n) {
      const d = readDate(value);
      return d ? dates.addDays(d, -Number(n)) : null;
    },
    subWeek(value, n) {
      const d = readDate(value);
      return d ? dates.addDays(d, -Number(n) * 7) : null;
    },
    subMonth(value, n) {
      const d = readDate(value);
      return d ? dates.addMonths(d, -Number(n)) : null;
    },
    subYear(value, n) {
      const d = readDate(value);
      return d ? dates.addMonths(d, -Number(n) * 12) : null;
    },
    subHour(value, n) {
      const d = readDate(value);
      if (!d) return null;
      const total = d.hh - Number(n);
      const days = Math.floor(total / 24);
      const hh = ((total % 24) + 24) % 24;
      const base = dates.addDays(d, days);
      return new dates.DelugeDate(base.y, base.m, base.d, hh, d.mm, d.ss);
    },
    subMinutes(value, n) {
      const d = readDate(value);
      if (!d) return null;
      const total = d.hh * 60 + d.mm - Number(n);
      const days = Math.floor(total / (24 * 60));
      const mins = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
      const base = dates.addDays(d, days);
      return new dates.DelugeDate(base.y, base.m, base.d, Math.floor(mins / 60), mins % 60, d.ss);
    },
    subSeconds(value, n) {
      const d = readDate(value);
      if (!d) return null;
      const total = d.hh * 3600 + d.mm * 60 + d.ss - Number(n);
      const days = Math.floor(total / 86400);
      const secs = ((total % 86400) + 86400) % 86400;
      const base = dates.addDays(d, days);
      return new dates.DelugeDate(base.y, base.m, base.d, Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60);
    },
    cmp(a, b) {
      const da = readDate(a);
      const db = readDate(b);
      if (!da || !db) return null;
      return dates.cmp(da, db);
    },
    rel(a, b, op) {
      const left = readDateOrBlank(a);
      const right = readDateOrBlank(b);
      const js = op === '=' ? '==' : op;
      if (js === '==' || js === '!=') {
        // `== null` is a documented Deluge test (conditional statements). A blank
        // date is null in Creator. This is equality, not ordering.
        if (left.blank || right.blank) {
          const eq = left.blank && right.blank;
          return js === '==' ? eq : !eq;
        }
        const same = dates.cmp(left.date!, right.date!) === 0;
        return js === '==' ? same : !same;
      }
      if (left.blank || right.blank || !left.date || !right.date) {
        // null <op> real date is false (date.cmp.lt-null, gt-null, lte-null,
        // gte-null). A real date against null still throws, so a blank return
        // date does not take the else and set the overdue fine to 0. Both
        // blank ("".toDate()) and text that is not a date also throw.
        // Do not use JS `null <= 0` (that coercion is true).
        const rightReal = !right.blank && right.date != null;
        if (a == null && rightReal) return false;
        note({ op: 'error', code: 'DELUGE_RUNTIME', message: 'UnParsable date' });
        throw new DelugeRuntimeError('UnParsable date');
      }
      const c = dates.cmp(left.date, right.date);
      if (js === '<') return c < 0;
      if (js === '>') return c > 0;
      if (js === '<=') return c <= 0;
      if (js === '>=') return c >= 0;
      throw new Error(`date: unsupported comparison ${op}`);
    },
    isDay(value, which, ctx) {
      if (which !== 'today' && which !== 'tomorrow' && which !== 'yesterday') {
        throw new Error(`date: unsupported day ${which}`);
      }
      try {
        return dates.isCalendarDay(value, which, ctx.now, dates.requireZone(ctx.appTimeZone));
      } catch (err) {
        if (err instanceof DelugeRuntimeError) throw err;
        note({ op: 'error', code: 'DELUGE_RUNTIME', message: 'UnParsable date' });
        throw new DelugeRuntimeError('UnParsable date');
      }
    },
  };

  /**
   * `for each` iterates a list, comma-separated text, a CSV file, or a
   * collection of records (deluge-docs/pages/list-manipulations__for-each-element.html,
   * deluge-docs/pages/data-access__for-each-record.html). A single record
   * (`{ __row }`, a fetch of one record) is a collection of one. Any other
   * value is rejected, but the Creator message for it is not captured, so it is
   * an uncaptured error (unmapped at the gate), not a mapped Deluge error and
   * not a JS TypeError.
   */
  function eachOf(value: unknown): unknown[] {
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return [...value];
    if (typeof value === 'object' && Symbol.iterator in (value as object)) return [...(value as Iterable<unknown>)];
    if (typeof value === 'object' && '__row' in (value as object)) return [value];
    note({ op: 'error', code: 'DELUGE_UNCAPTURED', message: FOR_EACH_NOT_COLLECTION });
    throw new UncapturedDelugeError(FOR_EACH_NOT_COLLECTION);
  }

  // `length` is a non-writable function property, so Object.assign cannot
  // install shim.list.length. The proxy serves that method and the rest.
  const listMethods = {
    get: lists.get,
    remove: lists.remove,
    removeAll: lists.removeAll,
    removeElement: lists.removeElement,
    distinct: lists.distinct,
    sort: lists.sort,
    intersect: lists.intersect,
    indexOf: lists.indexOf,
    lastIndexOf: lists.lastIndexOf,
    length: lists.length,
    size: lists.size,
    add: lists.add,
    addAll: lists.addAll,
    contains: lists.contains,
    containsKey: lists.containsKey,
    containsValue: lists.containsValue,
    deleteKey: lists.deleteKey,
    deleteKeys: lists.deleteKeys,
    deleteItem: lists.deleteItem,
    deleteAll: lists.deleteAll,
    duplicate: lists.duplicate,
    sortKey: lists.sortKey,
    notContains: lists.notContains,
    getKey: lists.getKey,
    getLastKey: lists.getLastKey,
    clear: lists.clear,
    insert: lists.insert,
    insertAll: lists.insertAll,
    putAll: lists.putAll,
    keys: lists.keys,
    values: lists.values,
    update: lists.update,
    getJson: lists.getJson,
    put: lists.put,
    subList: lists.subList,
    column: lists.column,
    aggregate: lists.aggregate,
  };
  function listCollection(elementType?: string): unknown[] {
    const arr: unknown[] = [];
    if (elementType) note({ op: 'list', elementType });
    return arr;
  }
  const listApi = new Proxy(listCollection, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(listMethods, prop)) {
        return listMethods[prop as keyof typeof listMethods];
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Shim['list'];

  const pending: PendingUpdate[] = [];
  const pendingKey = new Map<string, PendingUpdate>();
  /** Identity of rows returned by datastore.rows. Not copied onto the row, so a prefetch payload does not carry it. */
  const fetchedRows = new WeakMap<object, FetchedRow>();
  /** `thisapp` call depth per context object; a callee gets a fresh ctx so the key never collides. */
  const thisappDepth = new WeakMap<ShimContext, number>();
  /** Exact registry key, else a case-insensitive match (Deluge names are not case-sensitive). */
  const thisappByName = new Map<string, ThisappFunction>();
  for (const [name, fn] of Object.entries(options.functions ?? {})) {
    thisappByName.set(name, fn);
    const folded = name.toLowerCase();
    if (!thisappByName.has(folded)) thisappByName.set(folded, fn);
  }
  const thisappEntry = (name: string): ThisappFunction | undefined =>
    options.functions ? (thisappByName.get(name) ?? thisappByName.get(name.toLowerCase())) : undefined;

  function queryPage(
    form: string,
    where: string,
    limit: number,
    offset: number,
    orderBy: string,
  ): Promise<Record<string, unknown>[]> {
    const fn = options.datastore?.query;
    if (!fn) return Promise.reject(new Error(`no datastore query adapter for ${form}`));
    return fn(form, where, limit, offset, orderBy);
  }

  /**
   * Counter columns a script read before writing them: a fetched row (first
   * read) or a `Form[criteria]` query (latest read, with the ROWID of the
   * record it came from). A write after a read is applied as an increment of
   * the difference; a write with no read is a set.
   */
  const counterReads = new WeakMap<object, Map<string, { value: unknown; rowId?: string }>>();

  function rememberCounterRead(target: object, form: string, field: string, value: unknown, keepFirst: boolean, rowId?: string): void {
    if (!counterColumnsOf(form).includes(field)) return;
    let reads = counterReads.get(target);
    if (!reads) counterReads.set(target, (reads = new Map()));
    if (!keepFirst || !reads.has(field)) reads.set(field, { value, rowId });
  }

  function queueField(form: string, rowid: unknown, field: string, value: unknown, read?: { value: unknown }): void {
    // A bigint ROWID (toLong) is the same row as its digit text.
    const key = `${form}\0${typeof rowid === 'bigint' ? 'string' : typeof rowid}\0${String(rowid)}`;
    let item = pendingKey.get(key);
    if (!item) {
      item = { form, rowid, fields: {}, base: {} };
      pending.push(item);
      pendingKey.set(key, item);
    }
    item.fields[field] = value;
    if (read && counterColumnsOf(form).includes(field) && !Object.hasOwn(item.base, field)) item.base[field] = read.value;
  }

  function counterColumnsOf(form: string): readonly string[] {
    return options.counters?.columns?.[form] ?? [];
  }

  function counterOptions(): CounterOptions {
    return { maxAttempts: options.counters?.maxAttempts, wait: options.counters?.wait };
  }

  /** The live adapter as the counter protocol needs it, or null when one call is missing. */
  function counterStore(): CounterStore | null {
    const ds = options.datastore;
    if (!ds?.insert || !ds.query || !ds.update || !ds.delete) return null;
    return { insert: ds.insert, query: ds.query, update: ds.update, delete: ds.delete };
  }

  /** Increment by `delta`, or set to `value` when there is no delta. */
  async function writeCounter(form: string, field: string, rowId: string, delta: bigint | undefined, value: unknown): Promise<void> {
    const store = counterStore();
    if (!store) throw new Error(`counter ${form}.${field}: the datastore adapter needs insert, query, update and delete`);
    const after =
      delta === undefined
        ? await setCounter(store, form, field, rowId, value, counterOptions())
        : await incrementCounter(store, form, field, rowId, delta, counterOptions());
    note({ op: 'counter', form, field, delta: delta === undefined ? null : delta.toString(), value: after.toString() });
  }

  /** Split counter columns out of an update row. Plain columns stay in `fields`. */
  function splitCounters(form: string, fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of counterColumnsOf(form)) {
      if (!Object.hasOwn(fields, field)) continue;
      out[field] = fields[field];
      delete fields[field];
    }
    return out;
  }

  function noteMissingRow(form: string, field?: string): void {
    const err = new MissingRowIdError(form);
    note({ op: 'error', code: err.code, message: err.message, form, field: field ?? null });
  }

  async function flushPending(): Promise<void> {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    pendingKey.clear();
    const updateRows = options.datastore?.update;
    if (dryRun || !updateRows) {
      note({
        op: 'flush',
        rows: batch.length,
        dryRun,
        performed: false,
        batchSize: LIMITS.updateRowsPerCall,
      });
      refuseLive('flush');
      return;
    }
    const grouped = new Map<string, Record<string, unknown>[]>();
    const counterWrites: { form: string; rowid: unknown; field: string; delta?: bigint; value?: unknown }[] = [];
    for (const item of batch) {
      const fields = { ...item.fields };
      for (const [field, value] of Object.entries(splitCounters(item.form, fields))) {
        if (!Object.hasOwn(item.base, field)) {
          counterWrites.push({ form: item.form, rowid: item.rowid, field, value });
          continue;
        }
        const delta = counterDelta(item.base[field], value, counterSeq(item.form, field, String(item.rowid)));
        if (delta !== 0n) counterWrites.push({ form: item.form, rowid: item.rowid, field, delta });
      }
      if (Object.keys(fields).length === 0) continue;
      const row = { ROWID: item.rowid, ...shadowsForWrite(item.form, fields) };
      const list = grouped.get(item.form);
      if (list) list.push(row);
      else grouped.set(item.form, [row]);
    }
    let wrote = 0;
    // Counters first: a claim that fails closed leaves no plain column written.
    for (const write of counterWrites) {
      await writeCounter(write.form, write.field, String(write.rowid), write.delta, write.value);
      wrote++;
    }
    for (const [form, rows] of grouped) {
      const layout = layoutOf(form);
      if (!layout) {
        for (const part of chunk(rows, LIMITS.updateRowsPerCall)) {
          await updateRows(form, part);
          wrote += part.length;
        }
        continue;
      }
      for (const row of rows) {
        const payload = { ...row };
        delete payload.ROWID;
        await updateSplit(form, layout, payload, [row.ROWID]);
        wrote += 1;
      }
    }
    note({ op: 'flush', rows: wrote, dryRun: false, performed: wrote > 0, batchSize: LIMITS.updateRowsPerCall });
  }

  function applyStamp(ctx: ShimContext, op: 'insert' | 'update'): void {
    if (op !== 'insert' && op !== 'update') throw new Error(`system fields: unsupported write ${op}`);
    const next = applySystemColumns(ctx.record, op, ctx);
    if (op === 'insert') {
      stripColumnKeys(ctx.record, 'both');
      ctx.record.Added_User = next.Added_User;
      ctx.record.Added_Time = next.Added_Time;
    } else {
      stripColumnKeys(ctx.record, 'modified');
      ctx.record.Modified_User = next.Modified_User;
      ctx.record.Modified_Time = next.Modified_Time;
    }
    note({
      op: 'system-fields',
      write: op,
      sentinel: creatorUsername(ctx.principal) === DRY_RUN_LOGIN_USER,
    });
  }

  // The row an edit names: it must be one the caller may modify, so a grant
  // without Modify All finds only the caller's own row.
  async function loadStoredRow(ctx: ShimContext, form: string, rowId: string): Promise<Record<string, unknown> | undefined> {
    const scoped = scopeRead(ctx, form, { op: '==', field: 'ROWID', value: rowId }, undefined, 'modify');
    const where = whereOf(form, scoped.criteria);
    // A dry run with no datastore cannot load the row. When the edit handler
    // attaches the same datastore a live edit uses, read it so the script sees
    // stored Added_User and Added_Time in both modes.
    if (!options.datastore?.query) return undefined;
    const page = await queryPage(form, where, 1, 0, '');
    return page[0];
  }

  const shim: Shim = {
    async todo(_ctx, construct, detail) {
      note({ op: 'todo', construct, detail: detail ?? null });
      return undefined;
    },
    get: indexGet,
    set: indexSet,
    input: {
      root(ctx) {
        return ctx.record;
      },
      get(ctx, ...path) {
        const value = getPath(ctx.record, path);
        // input.ID of an edit is the request ROWID (body.ROWID) when the posted
        // record carries no id of its own.
        if (value === undefined && path.length === 1 && path[0] === 'ID') return ctx.rowId;
        return value;
      },
      set(ctx, path, value) {
        note({ op: 'input.set', path, value });
        return setPath(ctx.record, path, value);
      },
      insert(ctx, path, value) {
        const cur = getPath(ctx.record, path);
        const list = Array.isArray(cur) ? cur : [];
        const added = Array.isArray(value) ? value.length : value == null ? 0 : 1;
        if (Array.isArray(value)) list.push(...value);
        else if (value != null) list.push(value);
        if (cur !== list) setPath(ctx.record, path, list);
        note({ op: 'input.insert', path, added });
        return list;
      },
    },
    old: {
      get(ctx, ...path) {
        return getPath(ctx.old, path);
      },
      set(ctx, path, value) {
        note({ op: 'old.set', path, value });
        return setPath(ctx.old, path, value);
      },
    },
    compare: {
      eq(value, other) {
        return compareScalars(value).some((a) => compareScalars(other).some((b) => a == b));
      },
      ne(value, other) {
        return !compareScalars(value).some((a) => compareScalars(other).some((b) => a == b));
      },
    },
    record: {
      bind(_ctx, values, form = '') {
        return { __row: true, form, values: { ...values } };
      },
      get(row, ...path) {
        // A record collection reads its first record; null or empty reads null
        // (deluge-docs/pages/data-access__update-records.html: <collection_variable>.<field_link_name>).
        row = firstRecord(row);
        if (row == null) return null;
        if (typeof row === 'object' && '__row' in row) {
          const meta = row as RowMeta;
          const got = getPath(meta.values, path);
          if (path.length === 1) rememberCounterRead(meta, meta.form, path[0]!, got, true);
          return got;
        }
        return getPath(row, path);
      },
      system(row, name) {
        return systemValue(row, name);
      },
      stamp(ctx, op) {
        applyStamp(ctx, op);
      },
      async prepare(ctx, formName, kind) {
        const rowId = typeof ctx.rowId === 'string' ? ctx.rowId.trim() : '';
        const hasId = rowId.length > 0;
        const update = kind === 'update' || (kind !== 'insert' && hasId);
        if (!update) {
          ctx.writeOp = 'insert';
          applyStamp(ctx, 'insert');
          return;
        }
        if (hasId) {
          const stored = await loadStoredRow(ctx, formName, rowId);
          if (stored) mergeStoredSystemFields(ctx.record, stored);
          else if (options.datastore?.query) {
            throw new RecordAccessError(`record access: ${formName} row is not visible`);
          } else stripColumnKeys(ctx.record, 'both');
        } else stripColumnKeys(ctx.record, 'added');
        ctx.writeOp = 'update';
        applyStamp(ctx, 'update');
      },
      set(row, path, value) {
        note({ op: 'record.set', path, value });
        // The first record of a collection; a null or empty collection has no record to update.
        row = firstRecord(row);
        if (!row || typeof row !== 'object') return value;
        if (!('__row' in row)) return setPath(row as Record<string, unknown>, path, value);
        const meta = row as RowMeta;
        const fetched = fetchedRows.get(meta);
        // Dry-run is a local write. Subform rows and workflow `rec` are not a fetched collection.
        // Fetched rows persist at flush: for each employee in Employee[name == "Jon Doe"]
        // { employee.name = "John Doe"; }
        // https://www.zoho.com/deluge/help/fetch-records/fetch-collection-records.html
        // https://www.zoho.com/deluge/help/data-access/update-records.html
        if (dryRun || !fetched) return setPath(meta.values, path, value);
        if (!path.length) return value;
        let id: unknown;
        try {
          id = requireRowId(fetched.form, fetched.rowid);
        } catch (err) {
          if (err instanceof MissingRowIdError) noteMissingRow(fetched.form, path[0]);
          throw err;
        }
        const field = path[0]!;
        const nextTop = previewTop(meta.values, path, value);
        let storedTop = nextTop;
        if (options.access) {
          try {
            const decision = authorizeWrite(options.access, fetched.principal, fetched.form, { [field]: nextTop });
            if (!Object.prototype.hasOwnProperty.call(decision.values, field)) {
              throw new RecordAccessError(
                `record access: profile ${fetched.principal?.profile ?? '(none)'} cannot write ${fetched.form}.${field}`,
              );
            }
            storedTop = decision.values[field];
          } catch (err) {
            if (err instanceof RecordAccessError) {
              note({ op: 'error', code: err.code, message: err.message, form: fetched.form, field });
            }
            throw err;
          }
        }
        const reads = counterReads.get(meta);
        setPath(meta.values, path, value);
        const stored = stringifyValues({ [field]: storedTop });
        queueField(fetched.form, id, field, stored[field], reads?.get(field));
        return value;
      },
    },
    list: listApi,
    map(elementType?: string) {
      if (elementType) note({ op: 'map', elementType });
      return {};
    },
    each(_ctx, value) {
      return eachOf(value);
    },
    subform: {
      currentRow(ctx, field) {
        const at = ctx.subformRow;
        if (!at || at.field !== field) return null;
        const rows = ctx.record[field];
        const row = Array.isArray(rows) ? rows[at.index] : undefined;
        return row && typeof row === 'object' && !Array.isArray(row) ? (row as Record<string, unknown>) : null;
      },
    },
    datastore: {
      query(ctx, form, criteria, opts) {
        const q: Query = { __query: true, form, criteria: isCriteria(criteria) ? boundQueryCriteria(ctx, criteria) : { op: 'todo', construct: 'criteria' } };
        if (opts?.sort) q.sort = opts.sort;
        if (opts?.range) q.range = opts.range;
        if (opts?.system) q.system = true;
        if (opts?.zcql?.length) q.zcql = opts.zcql;
        return q;
      },
      async rows(ctx, query) {
        const scoped = scopeRead(ctx, query.form, query.criteria);
        return readQueryRows(ctx, query, scoped);
      },
      async historyRows(ctx, form, criteria, opts) {
        const allowed = options.flowHistoryTable;
        if (!allowed || form !== allowed) {
          throw new Error(`datastore.historyRows reads only the flow history table this runtime was built for, not ${String(form)}`);
        }
        const query: Query = {
          __query: true,
          form,
          criteria: isCriteria(criteria) ? criteria : { op: 'todo', construct: 'criteria' },
          system: true,
        };
        if (opts?.sort) query.sort = opts.sort;
        if (opts?.range) query.range = opts.range;
        try {
          return await readQueryRows(ctx, query, { criteria: query.criteria });
        } catch (err) {
          // A history table that was never created (or was dropped) reads as
          // "no history", the same as an empty result.
          if (isMissingTableError(err)) return [];
          throw err;
        }
      },
      async aggregate(ctx, query, fn, field) {
        // `distinct ID` reads the record id: no field grant is needed on it.
        const scoped = scopeRead(ctx, query.form, query.criteria, fn === 'count' || field === 'ID' ? undefined : field);
        const where = whereOf(query.form, scoped.criteria);
        note({ op: 'aggregate', form: query.form, fn, field: field ?? null, where, dryRun, authorized: !!options.access });
        const seeded = await readSeed(seed, dryRun, query.form, scoped.criteria, query.sort, query.range, decimalsOf(query.form));
        if (seeded) return aggregateSeed(seeded, fn, field, scoped.fields, decimalsOf(query.form));
        if (dryRun || !options.datastore?.query) {
          refuseLive('aggregate');
          return fn === 'count' ? 0 : null;
        }
        if (fn === 'distinct') {
          const got = await readLive(query, scoped.criteria, where, query.range, query.sort);
          return lists.distinct(got.map((row) => (field === 'ID' ? logicalId(row) : projectFields(row, scoped.fields)[fieldName(field)])));
        }
        const got = await readLive(query, scoped.criteria, where, query.range, query.sort);
        if (fn === 'count') return got.length;
        return aggregateSeed(got, fn, field, scoped.fields, decimalsOf(query.form));
      },
      matches(ctx, row, criteria) {
        const bound = boundQueryCriteria(ctx, isCriteria(criteria) ? criteria : { op: 'todo', construct: 'criteria' });
        const meta = row && typeof row === 'object' && '__row' in row ? (row as RowMeta) : null;
        const values = meta ? meta.values : row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        return matchRow(values, bound, meta ? decimalsOf(meta.form) : {});
      },
      async column(ctx, query, field) {
        const scoped = scopeRead(ctx, query.form, query.criteria, field === 'ID' ? undefined : field);
        const where = whereOf(query.form, scoped.criteria);
        note({ op: 'column', form: query.form, field, where, limit: LIMITS.zcqlRowsPerQuery, dryRun, authorized: !!options.access });
        const seeded = await readSeed(seed, dryRun, query.form, scoped.criteria, query.sort, query.range, decimalsOf(query.form));
        if (seeded) return seeded.map((row) => (field === 'ID' ? logicalId(row) : projectFields(row, scoped.fields)[field]));
        if (dryRun || !options.datastore?.query) {
          refuseLive('column');
          return [];
        }
        const got = await readLive(query, scoped.criteria, where, query.range, query.sort);
        return got.map((row) => (field === 'ID' ? logicalId(row) : projectFields(row, scoped.fields)[field]));
      },
      async field(ctx, query, field) {
        const scoped = scopeRead(ctx, query.form, query.criteria, field === 'ID' ? undefined : field);
        const where = whereOf(query.form, scoped.criteria);
        note({ op: 'field', form: query.form, field, where, dryRun, authorized: !!options.access });
        const seeded = await readSeed(seed, dryRun, query.form, scoped.criteria, query.sort, query.range, decimalsOf(query.form));
        if (seeded) {
          const row = seeded[0];
          return row ? (field === 'ID' ? logicalId(row) : projectFields(row, scoped.fields)[field]) : null;
        }
        if (dryRun || !options.datastore?.query) {
          refuseLive('field');
          return undefined;
        }
        // No range: the first matching record only. One row is enough, unless a
        // decimal criteria or sort needs the exact pass, which pages until it has one.
        // A staged read still applies the criteria to every stage, then keeps the first row.
        const decimals = decimalsOf(query.form);
        const got = query.zcql?.length
          ? await readLive(query, scoped.criteria, where, query.range ?? { from: 0, to: 0 }, query.sort)
          : query.range || needsExactRead(scoped.criteria, query.sort, decimals)
            ? await liveRows(query.form, scoped.criteria, where, query.range ?? { from: 0, to: 0 }, query.sort)
            : await queryPage(query.form, where, 1, 0, orderByClause(query.sort));
        // Deluge `Form[criteria].Field` is null when no record matches.
        const value = got[0] ? (field === 'ID' ? logicalId(got[0]) : projectFields(got[0], scoped.fields)[field]) : null;
        rememberCounterRead(query, query.form, field, value, false, got[0] ? String(rowIdentity(got[0]) ?? '') : undefined);
        return value;
      },
      async lookupMap(ctx, form, keyField, targetField, keys, extra) {
        const scoped = scopeRead(ctx, form, isCriteria(extra) ? extra : { op: 'true' }, targetField === 'ID' ? undefined : targetField);
        const out = new Map<string, unknown>();

        for (const batch of chunk(validMapKeys(keys), LIMITS.zcqlRowsPerQuery)) {
          const keyCriteria: Criteria = { op: 'in', field: keyField, value: batch };
          const combinedCriteria: Criteria = scoped.criteria.op === 'true'
            ? keyCriteria
            : { op: 'and', args: [keyCriteria, scoped.criteria] };
          const q: Query = { __query: true, form, criteria: combinedCriteria };
          const where = whereOf(form, combinedCriteria);
          note({ op: 'fetch', form, where, limit: LIMITS.zcqlRowsPerQuery, sort: null, range: null, dryRun, authorized: !!options.access });
          let got: Record<string, unknown>[] = [];
          const seeded = await readSeed(seed, dryRun, form, combinedCriteria, undefined, undefined, decimalsOf(form));
          if (seeded) {
            got = seeded;
          } else if (!dryRun && options.datastore?.query) {
            got = await readLive(q, combinedCriteria, where, undefined, undefined);
          } else if (dryRun) {
            got = [];
          } else {
            refuseLive('fetch');
            return out;
          }
          for (const raw of got) {
            const norm = mapRowKey(keyField === 'ID' ? logicalId(raw) : raw[keyField]);
            if (norm === null || out.has(norm)) continue;
            const val = targetField === 'ID' ? logicalId(raw) : projectFields(raw, scoped.fields)[targetField];
            out.set(norm, val ?? null);
          }
        }
        return out;
      },
      async rowsMap(ctx, form, keyField, keys, extra) {
        const scoped = scopeRead(ctx, form, isCriteria(extra) ? extra : { op: 'true' });
        const out = new Map<string, RowMeta[]>();

        for (const batch of chunk(validMapKeys(keys), LIMITS.zcqlRowsPerQuery)) {
          const keyCriteria: Criteria = { op: 'in', field: keyField, value: batch };
          const combinedCriteria: Criteria = scoped.criteria.op === 'true'
            ? keyCriteria
            : { op: 'and', args: [keyCriteria, scoped.criteria] };
          const q: Query = { __query: true, form, criteria: combinedCriteria };
          const where = whereOf(form, combinedCriteria);
          note({ op: 'fetch', form, where, limit: LIMITS.zcqlRowsPerQuery, sort: null, range: null, dryRun, authorized: !!options.access });
          const seeded = await readSeed(seed, dryRun, form, combinedCriteria, undefined, undefined, decimalsOf(form));
          const live = !seeded && !dryRun && !!options.datastore?.query;
          let got: Record<string, unknown>[];
          if (seeded) {
            got = seeded;
          } else if (live) {
            got = await readLive(q, combinedCriteria, where, undefined, undefined);
          } else if (dryRun) {
            got = [];
          } else {
            refuseLive('fetch');
            return out;
          }
          for (const raw of got) {
            const norm = mapRowKey(keyField === 'ID' ? logicalId(raw) : raw[keyField]);
            if (norm === null) continue;
            const row = shim.record.bind(ctx, scopedRow(raw, scoped.fields), form);
            if (live) fetchedRows.set(row, { form, rowid: rowIdentity(raw), principal: ctx.principal });
            const list = out.get(norm);
            if (list) list.push(row);
            else out.set(norm, [row]);
          }
        }
        return out;
      },
      async aggregateMap(ctx, form, keyField, keys, fn, field, extra) {
        // `distinct ID` reads the record id: no field grant is needed on it.
        const scoped = scopeRead(ctx, form, isCriteria(extra) ? extra : { op: 'true' }, fn === 'count' || field === 'ID' ? undefined : field);
        const out = new Map<string, unknown>();

        for (const batch of chunk(validMapKeys(keys), LIMITS.zcqlRowsPerQuery)) {
          const keyCriteria: Criteria = { op: 'in', field: keyField, value: batch };
          const combinedCriteria: Criteria = scoped.criteria.op === 'true'
            ? keyCriteria
            : { op: 'and', args: [keyCriteria, scoped.criteria] };
          const q: Query = { __query: true, form, criteria: combinedCriteria };
          const where = whereOf(form, combinedCriteria);
          note({ op: 'aggregate', form, fn, field: field ?? null, where, dryRun, authorized: !!options.access });
          let got: Record<string, unknown>[] = [];
          const seeded = await readSeed(seed, dryRun, form, combinedCriteria, undefined, undefined, decimalsOf(form));
          if (seeded) {
            got = seeded;
          } else if (!dryRun && options.datastore?.query) {
            got = await readLive(q, combinedCriteria, where, undefined, undefined);
          } else if (dryRun) {
            got = [];
          } else {
            refuseLive('aggregate');
            return out;
          }
          const groups = new Map<string, Record<string, unknown>[]>();
          for (const raw of got) {
            const norm = mapRowKey(keyField === 'ID' ? logicalId(raw) : raw[keyField]);
            if (norm === null) continue;
            const list = groups.get(norm);
            if (list) list.push(raw);
            else groups.set(norm, [raw]);
          }
          for (const [norm, group] of groups) {
            out.set(norm, aggregateSeed(group, fn, field, scoped.fields, decimalsOf(form)));
          }
        }
        return out;
      },
      async insert(ctx, form, values) {
        const stamped = applySystemColumns(values, 'insert', ctx);
        warnLongStrings(form, stamped);
        // authorizeWrite keeps composite nesting (Name: { first_name }); the
        // store has one flat column per part, so expand before the check.
        const expanded = expandCompositeWrites(form, stringifyValues(stamped), rulesOf(form));
        const stored = checkedWrite(form, shadowsForWrite(form, expanded), true);
        const batches = chunk([stored], LIMITS.insertRowsPerCall);
        note({ op: 'insert', form, rows: stored, batches: batches.length, batchSize: LIMITS.insertRowsPerCall, dryRun, performed: false });
        if (dryRun || !options.datastore?.insert) {
          refuseLive('insert');
          return { dryRun: true, form };
        }
        if (appUniqueOf(form).length) await checkAppUnique(form, stored, [], 1);
        await assignAutonumbers(form, batches[0]![0]!);
        const layout = guardWrite(form, stored);
        if (layout) return insertSplit(form, layout, stored);
        return options.datastore.insert(form, batches[0]!);
      },
      async update(ctx, form, criteria, values) {
        // The platform columns are maintained here, never taken as update
        // input. record.prepare merges the stored Added_* / Modified_* into
        // ctx.record so scripts and the reply can read them; this payload
        // drops every alias of those columns (on a copy — ctx.record keeps
        // them) and applySystemColumns re-stamps Modified_* below. Request
        // screening refuses a client copy outright; one that still reaches
        // this payload, such as a script-built update map, is dropped.
        const fields = { ...values };
        stripColumnKeys(fields, 'both');
        warnLongStrings(form, fields);
        let storedValues = fields;
        if (options.access) {
          try {
            storedValues = authorizeWrite(options.access, ctx.principal, form, fields, options.writeSchemas?.[form]).values;
          } catch (err) {
            if (err instanceof RecordAccessError) {
              note({ op: 'error', code: err.code, message: err.message, form });
            }
            throw err;
          }
        }
        const expandedUpdate = expandCompositeWrites(form, stringifyValues(applySystemColumns(storedValues, 'update', ctx)), rulesOf(form));
        const stored = checkedWrite(form, shadowsForWrite(form, expandedUpdate), false);
        // The read that finds ROWIDs is the same scoped read as rows/column/count/field.
        // Without the profile record filter, a criteria update writes rows the principal cannot see.
        const scoped = scopeRead(ctx, form, criteria);
        const where = whereOf(form, scoped.criteria);
        const queryRows = options.datastore?.query;
        const updateRows = options.datastore?.update;
        const live = !dryRun && !!queryRows && !!updateRows;
        if (!live || !queryRows || !updateRows) {
          note({ op: 'update', form, where, values: stored, batchSize: LIMITS.updateRowsPerCall, dryRun, performed: false });
          refuseLive('update');
          return { dryRun: true };
        }
        const layout = guardWrite(form, stored);
        // Deluge `update Form[criteria]` writes every match. updateRows needs each ROWID.
        const got = await liveRows(form, scoped.criteria, where, undefined);
        const rows: Record<string, unknown>[] = [];
        for (const row of got) {
          let id: unknown;
          try {
            id = requireRowId(form, rowIdentity(row));
          } catch (err) {
            if (err instanceof MissingRowIdError) noteMissingRow(form);
            throw err;
          }
          rows.push({ ROWID: id, ...stored });
        }
        if (appUniqueOf(form).length) await checkAppUnique(form, stored, rows.map((row) => String(row.ROWID)), rows.length);
        note({
          op: 'update',
          form,
          where,
          values: stored,
          batchSize: LIMITS.updateRowsPerCall,
          dryRun,
          performed: rows.length > 0,
          rows: rows.length,
        });
        const plainStored = { ...stored };
        const counters = splitCounters(form, plainStored);
        const plain = rows.map((row) => {
          const out = { ...row };
          for (const field of Object.keys(counters)) delete out[field];
          return out;
        });
        // Counters first: a claim that fails closed leaves no plain column written.
        for (const [field, value] of Object.entries(counters)) {
          for (const row of rows) await writeCounter(form, field, String(row.ROWID), undefined, value);
        }
        if (layout) await updateSplit(form, layout, plainStored, rows.map((row) => row.ROWID));
        else {
          for (const batch of chunk(plain, LIMITS.updateRowsPerCall)) {
            await updateRows(form, batch);
          }
        }
        return { updated: rows.length };
      },
      async delete(ctx, form, criteria) {
        const queryRows = options.datastore?.query;
        const deleteRows = options.datastore?.delete;
        const live = !dryRun && !!queryRows && !!deleteRows;
        // Dry-run stays a local note of the script criteria. It does not read or authorize.
        if (dryRun) {
          const where = whereOf(form, criteria);
          note({ op: 'delete', form, where, dryRun, performed: false });
          return { dryRun: true };
        }
        // A live delete with no adapter must fail, never report a write it did not do.
        if (!live || !queryRows || !deleteRows) {
          refuseLive('delete');
          throw new Error(`datastore.delete has no live adapter for ${form}`);
        }
        // Delete is its own grant. Edit does not imply delete, and delete does not imply edit.
        if (options.access) {
          try {
            authorizeDelete(options.access, ctx.principal, form);
          } catch (err) {
            if (err instanceof RecordAccessError) {
              note({ op: 'error', code: err.code, message: err.message, form });
            }
            throw err;
          }
        }
        // The read that finds ROWIDs is the same scoped read as update.
        // Without the profile record filter, a criteria delete removes rows the principal cannot see.
        const scoped = scopeRead(ctx, form, criteria);
        const where = whereOf(form, scoped.criteria);
        const got = await liveRows(form, scoped.criteria, where, undefined);
        const ids: unknown[] = [];
        for (const row of got) {
          let id: unknown;
          try {
            id = requireRowId(form, rowIdentity(row));
          } catch (err) {
            if (err instanceof MissingRowIdError) noteMissingRow(form);
            throw err;
          }
          ids.push(id);
        }
        note({
          op: 'delete',
          form,
          where,
          dryRun,
          performed: ids.length > 0,
          rows: ids.length,
          batchSize: LIMITS.updateRowsPerCall,
        });
        // deleteRows rejects an empty id list. A criteria with no match is a no-op.
        // Extension rows follow parent_rowid ON-DELETE-CASCADE. This does not delete them again.
        const table = layoutOf(form)?.base ?? form;
        for (const batch of chunk(ids, LIMITS.updateRowsPerCall)) {
          await deleteRows(table, batch);
        }
        return { deleted: ids.length };
      },
      async setField(ctx, query, field, value) {
        // Platform columns are never writable, even when no access policy is configured.
        if (isSystemWriteDenied(field)) {
          throw new RecordAccessError(`record access: ${query.form}.${field} is not client-writable`);
        }
        // authorizeWrite rejects ROWID. updateRows still needs it, so the id is
        // attached after the field check and is never part of the screened values.
        let storedValue = value;
        if (options.access) {
          try {
            const decision = authorizeWrite(options.access, ctx.principal, query.form, { [field]: value });
            if (!Object.prototype.hasOwnProperty.call(decision.values, field)) {
              throw new RecordAccessError(`record access: profile ${ctx.principal?.profile ?? '(none)'} cannot write ${query.form}.${field}`);
            }
            storedValue = decision.values[field];
          } catch (err) {
            if (err instanceof RecordAccessError) {
              note({ op: 'error', code: err.code, message: err.message, form: query.form, field });
            }
            throw err;
          }
        }
        const stored = checkedWrite(query.form, stringifyValues({ [field]: storedValue }), false);
        storedValue = stored[field];
        const queryRows = options.datastore?.query;
        const updateRows = options.datastore?.update;
        const live = !dryRun && !!queryRows && !!updateRows;
        const scoped = scopeRead(ctx, query.form, query.criteria);
        const where = whereOf(query.form, scoped.criteria);
        if (!live || !queryRows || !updateRows) {
          note({ op: 'setField', form: query.form, where, field, value: storedValue, dryRun, performed: false });
          refuseLive('setField');
          return value;
        }
        const layout = layoutOf(query.form);
        if (layout) {
          const known =
            layout.baseColumns.includes(field) ||
            layout.extensions.some((ext) => ext.columns.includes(field)) ||
            BASE_ALWAYS.has(field);
          if (!known) {
            throw new Error(
              `split write refused for ${query.form}: ${field} not on the base table or an extension. No column was dropped and no write was sent. Column cap ${DATASTORE_COLUMNS_PER_TABLE} (verified: false).`,
            );
          }
        }
        const got = await readLive(query, scoped.criteria, where, query.range, query.sort);
        const updates: Record<string, unknown>[] = [];
        const current = new Map<string, unknown>();
        for (const row of got) {
          let id: unknown;
          try {
            id = requireRowId(query.form, rowIdentity(row));
          } catch (err) {
            if (err instanceof MissingRowIdError) noteMissingRow(query.form, field);
            throw err;
          }
          updates.push({ ROWID: id, ...withShadows(query.form, { [field]: storedValue }) });
          current.set(String(id), row[field]);
        }
        note({
          op: 'setField',
          form: query.form,
          where,
          field,
          value: storedValue,
          range: query.range ?? null,
          dryRun,
          performed: updates.length > 0,
          rows: updates.length,
          batchSize: LIMITS.updateRowsPerCall,
        });
        if (counterColumnsOf(query.form).includes(field)) {
          // The value is computed once and every match gets it (Deluge
          // `<collection>.<field> = value`). After a read, each row is moved by
          // its own difference: the row the script read by value - that read,
          // so a concurrent increment of it is kept; every other match by
          // value - its current F. A value with no read is a set.
          const reads = counterReads.get(query);
          const read = reads?.get(field);
          reads?.delete(field);
          const readRow = read ? (read.rowId || String(updates[0]?.ROWID ?? '')) : '';
          for (const row of updates) {
            const id = String(row.ROWID);
            const seq = counterSeq(query.form, field, id);
            const delta = !read ? undefined : counterDelta(id === readRow ? read.value : current.get(id), storedValue, seq);
            if (delta !== 0n) await writeCounter(query.form, field, id, delta, storedValue);
          }
          return value;
        }
        if (layout) {
          await updateSplit(query.form, layout, withShadows(query.form, { [field]: storedValue }), updates.map((row) => row.ROWID));
        } else {
          for (const batch of chunk(updates, LIMITS.updateRowsPerCall)) {
            await updateRows(query.form, batch);
          }
        }
        return value;
      },
      async flush() {
        await flushPending();
      },
      async writeRow(ctx, form, rowId, values) {
        const criteria: Criteria = { op: '==', field: 'ROWID', value: rowId };
        const stored = checkedWrite(form, shadowsForWrite(form, stringifyValues(applySystemColumns(values, 'update', ctx))), false);
        const where = whereOf(form, criteria);
        if (dryRun) {
          note({ op: 'store', form, where, values: stored, dryRun, performed: true });
          return { values: stored, criteria };
        }
        if (!options.datastore?.update) {
          refuseLive('datastore.writeRow');
          throw new Error(`datastore.writeRow has no live adapter for ${form}`);
        }
        if (appUniqueOf(form).length) await checkAppUnique(form, stored, [String(rowId)], 1);
        await options.datastore.update(form, [{ ROWID: rowId, ...stored }]);
        note({ op: 'store', form, where, values: stored, dryRun, performed: true });
        return { values: stored, criteria };
      },
      async insertRow(ctx, form, values) {
        const stored = checkedWrite(form, shadowsForWrite(form, stringifyValues(applySystemColumns(values, 'insert', ctx))), true);
        if (dryRun) {
          note({ op: 'store', form, criteria: null, values: stored, dryRun, performed: true });
          return { values: stored };
        }
        if (!options.datastore?.insert) {
          refuseLive('datastore.insertRow');
          throw new Error(`datastore.insertRow has no live adapter for ${form}`);
        }
        if (appUniqueOf(form).length) await checkAppUnique(form, stored, [], 1);
        await options.datastore.insert(form, [stored]);
        note({ op: 'store', form, criteria: null, values: stored, dryRun, performed: true });
        return { values: stored };
      },
    },
    validate: {
      cancelDelete(_ctx, alert) {
        note({ op: 'validate.cancelDelete', alert: alert ?? null, performed: false, dryRun });
        throw new DeleteRefused(alert ?? null);
      },
      cancelSubmit(_ctx, alert) {
        note({ op: 'validate.cancelSubmit', alert: alert ?? null, performed: false, dryRun });
        throw new SubmitRefused(alert ?? null);
      },
    },
    mail: {
      async send(_ctx, message) {
        const from = message.from === adminUserIdValue() ? (options.mailFrom ?? (dryRun ? CREATOR_DEFAULT_MAIL_FROM : message.from)) : message.from;
        const sent = { ...message, from };
        note({ op: 'sendmail', message: sent, performed: false, dryRun });
        if (!dryRun && options.mail) {
          guardMessage('sendmail', zohoAdapters.mailDestinations(sent));
          return options.mail(sent);
        }
        refuseLive('sendmail');
        return { dryRun: true, performed: false };
      },
    },
    http: {
      async invokeurl(_ctx, request) {
        const link = typeof request.connection === 'string' && request.connection ? request.connection : null;
        if (link && options.zohoConnections) {
          const rest = zohoAdapters.invokeurlRequest(request);
          const dc = options.zohoConnections.dc ?? null;
          const urlDc = zohoAdapters.dcOfUrl(rest.url);
          if (dc && urlDc && urlDc !== dc) note({ op: 'warn', code: 'ZOHO_DC_MISMATCH', url: zohoAdapters.redactUrlText(rest.url), dc, urlDc });
          note({ op: 'invokeurl', connection: link, request: redact(request), performed: false, dryRun });
          if (dryRun) return { dryRun: true, performed: false };
          const dests = zohoAdapters.urlWriteDestinations(rest.url, rest.method, rest.body, rest.headers);
          if (dests) guardMessage('invokeurl', dests);
          const live = zohoAdapters.requireLive(options.zohoConnections, link, 'invokeurl');
          const reply = await zohoAdapters.send(options.zohoConnections, rest, await live.credentials(live.catalystName));
          note({ op: 'invokeurl', connection: link, status: reply.status, performed: true, dryRun });
          return zohoAdapters.delugeValue(zohoAdapters.invokeurlResponse(reply));
        }
        note({ op: 'invokeurl', request: redact(request), performed: false, dryRun });
        if (!dryRun && options.http) {
          const rest = zohoAdapters.invokeurlRequest(request);
          const dests = zohoAdapters.urlWriteDestinations(rest.url, rest.method, rest.body, rest.headers);
          if (dests) guardMessage('invokeurl', dests);
          return options.http(request);
        }
        refuseLive('invokeurl');
        return { dryRun: true, performed: false };
      },
      async getUrl(_ctx, url, headersOrSimple, simple) {
        // getUrl(url, headerMap, simple) and the two-argument getUrl(url, simple).
        const headers =
          headersOrSimple !== null && typeof headersOrSimple === 'object' && !Array.isArray(headersOrSimple)
            ? (headersOrSimple as Record<string, unknown>)
            : undefined;
        const flag = typeof headersOrSimple === 'boolean' ? headersOrSimple : simple;
        const request: { url: string; headers?: Record<string, unknown>; simple: boolean } = {
          url: url === null || url === undefined ? '' : typeof url === 'object' ? JSON.stringify(url, jsonReplacer) : String(url),
          ...(headers ? { headers } : {}),
          simple: flag !== false,
        };
        note({ op: 'getUrl', request: redact(request), performed: false, dryRun });
        if (!dryRun && options.httpGetUrl) return options.httpGetUrl(request);
        refuseLive('getUrl');
        return { dryRun: true, performed: false };
      },
    },
    zoho: {
      currentDate(ctx) {
        return dates.today(ctx.now, dates.requireZone(ctx.appTimeZone));
      },
      currentTime(ctx) {
        return dates.now(ctx.now, dates.requireZone(ctx.appTimeZone));
      },
      loginUserId(ctx) {
        const identity = labelledIdentity(ctx.principal?.userId, DRY_RUN_LOGIN_USER_ID);
        note({ op: 'zoho.env', name: 'loginuserid', sentinel: identity.sentinel });
        return identity.value;
      },
      loginUser(ctx) {
        const value = creatorUsername(ctx.principal);
        note({ op: 'zoho.env', name: 'loginuser', sentinel: value === DRY_RUN_LOGIN_USER });
        return value;
      },
      adminUserId() {
        const identity = labelledIdentity(options.adminUserId, DRY_RUN_ADMIN_USER_ID);
        note({ op: 'zoho.env', name: 'adminuserid', sentinel: identity.sentinel });
        return identity.value;
      },
      adminUser() {
        const identity = labelledIdentity(options.adminUser, DRY_RUN_ADMIN_USER);
        note({ op: 'zoho.env', name: 'adminuser', sentinel: identity.sentinel });
        return identity.value;
      },
      appUri() {
        note({ op: 'zoho.env', name: 'appuri' });
        return { zoho: 'appuri' };
      },
      ipAddress() {
        note({ op: 'zoho.env', name: 'ipaddress' });
        return { zoho: 'ipaddress' };
      },
      appName() {
        note({ op: 'zoho.env', name: 'appname' });
        return { zoho: 'appname' };
      },
      async task(_ctx, path, args) {
        const joined = path.join('.').toLowerCase();
        if (/payment|checkout/.test(joined)) {
          note({ op: 'todo', construct: 'payments', path, detail: 'payments are not supported' });
          return undefined;
        }
        const hit = zohoAdapters.adapterFor(path);
        if (hit?.adapter.local) {
          const value = hit.adapter.local(args);
          note({ op: 'zoho.task', path, service: hit.adapter.service, local: true, performed: true, dryRun });
          return value !== null && typeof value === 'object' ? zohoAdapters.delugeValue(value) : value;
        }
        if (hit && (options.zohoConnections || !options.connection)) {
          const link = zohoAdapters.connectionArg(hit.adapter, args);
          const dc = options.zohoConnections?.dc ?? null;
          let request: zohoAdapters.RestRequest | null = null;
          if (dc && zohoAdapters.ZOHO_DCS[dc]) request = hit.adapter.request(args, dc);
          else note({ op: 'warn', code: 'ZOHO_DC_UNSET', path, detail: 'set zohoDc (C2C_ZOHO_DC) to resolve the request URL' });
          note({ op: 'zoho.task', path, connection: link, service: hit.adapter.service, request: request ? redact(request) : null, performed: false, dryRun });
          if (dryRun) return { dryRun: true, path };
          // A live task write is vetted like the equivalent invokeurl: the
          // built request runs through the same deny-by-default classifier,
          // so an opaque RPC such as crm.invokeConnector is a zoho-write
          // (owner token only). With no DC the request is not built yet; the
          // task-level check still names a guarded write.
          let dests = zohoAdapters.cliqTaskDestinations(path, args);
          if (!dests) dests = request ? zohoAdapters.urlWriteDestinations(request.url, request.method, request.body, request.headers) : zohoAdapters.connectorTaskDestinations(path, args);
          if (dests) guardMessage(`zoho.${hit.key}`, dests);
          const live = zohoAdapters.requireLive(options.zohoConnections, link, `zoho.${hit.key}`, hit.adapter.service);
          const stub = args.findIndex((a) => !!a && typeof a === 'object' && (a as { dryRun?: unknown }).dryRun === true);
          if (stub >= 0) {
            throw new zohoAdapters.ZohoConnectionRefused(`argument ${stub}`, `zoho.${hit.key}: argument ${hit.adapter.params[stub] ?? stub} is a dry-run placeholder (a thisapp call); refusing to send it`);
          }
          const reply = await zohoAdapters.send(options.zohoConnections!, request ?? hit.adapter.request(args, live.dc), await live.credentials(live.catalystName));
          note({ op: 'zoho.task', path, connection: link, status: reply.status, performed: true, dryRun });
          return zohoAdapters.delugeValue(hit.adapter.response(reply, args));
        }
        if (!hit) note({ op: 'warn', code: 'ZOHO_TASK_NO_ADAPTER', path, detail: 'no product adapter (migration-report connections.unsupported)' });
        const connection = hit ? (zohoAdapters.connectionArg(hit.adapter, args) ?? undefined) : typeof args[args.length - 1] === 'string' ? String(args[args.length - 1]) : undefined;
        note({ op: 'zoho.task', path, args, connection: connection ?? null, performed: false, dryRun });
        if (!dryRun && options.connection) {
          const dests = zohoAdapters.cliqTaskDestinations(path, args) ?? zohoAdapters.connectorTaskDestinations(path, args);
          if (dests) guardMessage(`zoho.${path.join('.')}`, dests);
          return options.connection(connection, { path, args });
        }
        refuseLive('zoho.task');
        return { dryRun: true, path };
      },
    },
    thisapp: {
      async call(ctx, path, args) {
        const name = path.join('.');
        // A runtime built without the generated registry keeps the dry-run
        // placeholder for both modes (a bare runtime cannot know the app's
        // functions). A runtime that has the registry is authoritative: a
        // missing name is a Deluge error, not a silent placeholder.
        if (!options.functions) {
          note({ op: 'thisapp', path, args, performed: false, dryRun });
          return { dryRun: true, path };
        }
        const entry = thisappEntry(name);
        if (!entry) {
          note({ op: 'thisapp', path, args, performed: false, dryRun, error: `thisapp.${name}: no such function` });
          throw new DelugeRuntimeError(`thisapp.${name}: no such function`);
        }
        if (dryRun) {
          note({ op: 'thisapp', path, args, performed: false, dryRun });
          return { dryRun: true, path };
        }
        const depth = thisappDepth.get(ctx) ?? 0;
        const max = options.thisappMaxDepth ?? LIMITS.thisappMaxDepth;
        if (depth >= max) {
          note({ op: 'thisapp', path, args, performed: false, dryRun, depth, error: `thisapp.${name}: maximum call depth ${max} exceeded` });
          throw new DelugeRuntimeError(`thisapp.${name}: maximum call depth ${max} exceeded`);
        }
        note({ op: 'thisapp', path, args, performed: true, dryRun, depth });
        const params = entry.params ?? [];
        // Function arguments are the callee's `input`: `input.<param>` reads
        // ctx.record[param]. A record-typed parameter gets the row's live
        // values, so `recObj.Field` reads and writes the record the caller passed.
        const record: Record<string, unknown> = {};
        const callArgs = args.map((value, i) => {
          const param = params[i];
          if (param === undefined || UNSAFE_PATH_KEYS.has(param)) return value;
          const bound = entry.recordParams?.[param] ? rowArgument(value) : value;
          return (record[param] = bound ?? null);
        });
        // A parameter spelled `__proto__` reads undefined through input.get
        // anyway; assigning it raw would reparent the record instead.
        for (const param of params) if (!(param in record) && !UNSAFE_PATH_KEYS.has(param)) record[param] = null;
        const child: ShimContext = { ...ctx, record, old: {} };
        delete child.row;
        delete child.subformRow;
        delete child.rowId;
        delete child.writeOp;
        delete child.persisted;
        delete child.formNonce;
        if (entry.rowForm) {
          const source = args.find((arg) => arg && typeof arg === 'object' && !Array.isArray(arg));
          child.row =
            source && typeof source === 'object' && '__row' in source
              ? (source as RowMeta)
              : shim.record.bind(ctx, (source as Record<string, unknown> | undefined) ?? {}, entry.rowForm);
        }
        thisappDepth.set(child, depth + 1);
        return entry.call(child, ...callArgs);
      },
    },
    date: dateApi,
    decimal,
    math: {
      round,
      sqrt,
      abs,
      exp,
      frac,
      log,
      acos,
      acosh,
      asinh,
      atan,
      atan2,
      atanh,
      cosh,
      log10,
      sinh,
      tanh,
      isEven,
      isOdd,
    },
    string: {
      replaceFirst(s, find, repl) {
        return String(s).replace(find, repl);
      },
      replaceAll,
      remove: removeText,
      isAscii,
      removeAllAlphaNumeric,
      hexToText,
      htmlDecode,
      htmlEncode,
      subString,
      getPrefix,
      getSuffix,
      leftPad,
      rightPad,
      equalsIgnoreCase,
      containsIgnoreCase,
      removeAllAlpha,
      toLowerCase,
      toUpperCase,
      trim,
      startsWith,
      endsWith,
      startsWithIgnoreCase,
      textToHex,
      removeFirstOccurence,
      removeLastOccurence,
      getAlpha,
      getAlphaNumeric,
      subText,
      matches,
      len,
      length,
      lower,
      encodeUrl,
      left,
      right,
      mid,
      ltrim,
      rtrim,
      repeat,
      reverse,
    },
    xml: { toXml, toXmlList, executeXpath },
    file: { getFileName, actualname },
    isBlank(value) {
      if (value == null) return true;
      if (typeof value === 'string') return value.trim() === '';
      return false;
    },
    isNull(value) {
      return value == null || value === '';
    },
    /**
     * https://www.zoho.com/deluge/help/functions/common/is-file.html says
     * isFile "returns true if it is a valid file. Otherwise, it returns false."
     * The page does not mention null. Null and "" are not a stored file
     * reference, so both return false. A stored file is the object key string
     * (`uploads/<form>/<field>/<sha256>/<name>` or
     * `migrated/<form>/<field>/<id>/<name>`, the `FILE_OBJECT_KEY` shape
     * `keyBelongsTo` pins) or a reference object whose `key` is that string.
     */
    isFile(value) {
      if (value == null || value === '') return false;
      if (typeof value === 'string') return isStoredFileKey(value);
      if (typeof value === 'object' && !Array.isArray(value)) return isStoredFileKey((value as { key?: unknown }).key);
      return false;
    },
    isText(value) {
      if (value == null) return false;
      if (typeof value === 'boolean') return null;
      if (typeof value === 'number' || typeof value === 'bigint' || value instanceof Decimal) return false;
      if (value instanceof dates.DelugeDate || value instanceof Date) return false;
      if (typeof value === 'object') return null;
      if (typeof value === 'string') return !NUMERIC.test(value.trim());
      return false;
    },
    isEmpty: lists.isEmpty,
    isNumber,
    number: { largest, smallest, sin, cos, tan, asin },
    ifnull,
    log: {
      info(_ctx, value) {
        note({ op: 'info', value });
      },
    },
    convert: {
      toLong, toNumber, toDecimal, toList, toMap, toListString, toJSONCollection,
      // A dry-run getUrl/invokeurl placeholder stands in for response text the
      // runtime cannot know; [] keeps `for each` over it a no-op rather than a
      // conversion error (the same no-op the old shim.todo hole produced).
      toJSONList: (value: unknown, ctx?: ConvertCtx, ...rest: unknown[]) =>
        value !== null && typeof value === 'object' && (value as { dryRun?: unknown }).dryRun === true
          ? []
          : toJSONList(value, ctx, ...rest),
    },
    client: {
      touch(ctx) {
        ctx.formNonce = nextFormNonce();
        return ctx.formNonce;
      },
      async prefetch(ctx, path) {
        const first = await prefetchOnce(ctx, path, false);
        if (first.ok) return first;
        const second = await prefetchOnce(ctx, path, true);
        if (second.ok) return { ...second, retried: true };
        return {
          ok: false,
          slots: {},
          nonce: ctx.formNonce ?? second.nonce,
          retried: true,
          message: second.message ?? BLOCKED,
        };
      },
      async call(ctx, path, args) {
        const result = await callOnce(ctx, path, args);
        if (!result.ok) throw elementBlocked(result.message ?? BLOCKED);
        return result.value;
      },
      async element(ctx, name, value, slot) {
        const used = (ctx.elementCalls ?? 0) + 1;
        ctx.elementCalls = used;
        if (used > LIMITS.clientElementRoundTrips) {
          note({ op: 'todo', construct: 'client-condition-uses-server', detail: `element round-trip cap ${LIMITS.clientElementRoundTrips}` });
          throw elementBlocked(BLOCKED);
        }
        const path = ctx.prefetchPath;
        if (typeof path !== 'string') {
          note({ op: 'todo', construct: 'client-condition-uses-server', detail: 'element round-trip without a prefetch path' });
          throw elementBlocked(BLOCKED);
        }
        const res = await prefetchOnce(ctx, path, false, { element: { name, value } });
        if (!res.ok) {
          note({ op: 'todo', construct: 'client-condition-uses-server', detail: res.message ?? 'element round-trip refused' });
          throw elementBlocked(res.message ?? BLOCKED);
        }
        // A slot the guarded block refused (non-member, over-cap, or skipped)
        // is absent entirely; an evaluated slot is present even when falsy.
        if (!Object.prototype.hasOwnProperty.call(res.slots, slot)) {
          note({ op: 'todo', construct: 'client-condition-uses-server', detail: 'element round-trip produced no slot' });
          throw elementBlocked(BLOCKED);
        }
        const slotValue = res.slots[slot];
        // A dry-run placeholder is never a truthy condition result.
        if (isElementPlaceholder(slotValue)) {
          note({ op: 'todo', construct: 'client-condition-uses-server', detail: 'element slot evaluated to a placeholder' });
          throw elementBlocked(BLOCKED);
        }
        return slotValue;
      },
      async rows(ctx, slot, from, to): Promise<SlotRowsResult> {
        const path = typeof ctx.prefetchPath === 'string' ? ctx.prefetchPath : '';
        const extra = { slot, range: { from, to } };
        const first = await prefetchOnce(ctx, path, false, extra);
        if (first.ok) return slotRows(first, slot);
        const second = await prefetchOnce(ctx, path, true, extra);
        if (second.ok) return { ...slotRows(second, slot), retried: true };
        return { ok: false, rows: [], retried: true, message: second.message ?? BLOCKED };
      },
    },
  };

  const BLOCKED = 'Prefetch is stale or failed; client action blocked.';

  /**
   * The throw that discards a handler run's queued actions: a refused or
   * failed element round trip must not leave partial client actions applied.
   */
  function elementBlocked(message: string): Error {
    return Object.assign(new Error(message), { c2cElementBlocked: true });
  }

  /** A dry-run placeholder or `{ ok: false }` refusal — never a truthy slot. */
  function isElementPlaceholder(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return v.ok === false || v.dryRun === true || v.performed === false;
  }

  function slotRows(result: PrefetchResult, slot: string): SlotRowsResult {
    const rows = result.slots[slot];
    if (!Array.isArray(rows)) return { ok: false, rows: [], message: BLOCKED };
    return { ok: true, rows };
  }

  function nextFormNonce(): string {
    formSeq += 1;
    return `f${formSeq.toString(36)}`;
  }

  async function prefetchOnce(
    ctx: ShimContext,
    path: string,
    retry: boolean,
    extra?: { slot?: string; range?: { from: unknown; to: unknown }; element?: { name: string; value: unknown } },
  ): Promise<PrefetchResult> {
    ctx.prefetchPath = path;
    const nonce = ctx.formNonce ?? (ctx.formNonce = nextFormNonce());
    if (!options.clientPrefetch) {
      note({ op: 'client-prefetch', path, nonce, performed: false, dryRun: true, ok: false, reason: 'no-adapter', retry, ...(extra ? { slot: extra.slot } : {}) });
      return { ok: false, slots: {}, nonce, message: BLOCKED };
    }
    try {
      const request = {
        ...(Array.isArray(ctx.args) ? { args: ctx.args } : {}),
        ...(extra?.element ? { element: extra.element } : {}),
        ...(extra?.slot ? { slot: extra.slot, range: extra.range } : {}),
      };
      const raw = await options.clientPrefetch(path, nonce, Object.keys(request).length ? request : undefined);
      const parsed = readPrefetch(raw, nonce);
      if (!parsed.ok || ctx.formNonce !== nonce) {
        note({
          op: 'client-prefetch',
          path,
          nonce,
          performed: true,
          ok: false,
          reason: ctx.formNonce !== nonce ? 'stale' : 'rejected',
          retry,
        });
        return { ok: false, slots: {}, nonce: ctx.formNonce ?? nonce, message: parsed.message ?? BLOCKED };
      }
      note({ op: 'client-prefetch', path, nonce, performed: true, ok: true, retry });
      return { ok: true, slots: parsed.slots, nonce };
    } catch {
      note({ op: 'client-prefetch', path, nonce, performed: false, ok: false, reason: 'failed', retry });
      return { ok: false, slots: {}, nonce, message: BLOCKED };
    }
  }

  async function callOnce(ctx: ShimContext, path: string, args: unknown[]): Promise<{ ok: boolean; value?: unknown; message?: string }> {
    const nonce = ctx.formNonce ?? (ctx.formNonce = nextFormNonce());
    if (!options.clientPrefetch) {
      note({ op: 'client-call', path, nonce, performed: false, dryRun: true, ok: false, reason: 'no-adapter' });
      return { ok: false, message: BLOCKED };
    }
    try {
      const raw = await options.clientPrefetch(clientCallPath(path), nonce, { args });
      const parsed = readClientCall(raw, nonce);
      if (!parsed.ok || ctx.formNonce !== nonce) {
        note({
          op: 'client-call',
          path,
          nonce,
          performed: true,
          ok: false,
          reason: ctx.formNonce !== nonce ? 'stale' : 'rejected',
        });
        return { ok: false, message: parsed.message ?? BLOCKED };
      }
      note({ op: 'client-call', path, nonce, performed: true, ok: true });
      return { ok: true, value: parsed.value };
    } catch {
      note({ op: 'client-call', path, nonce, performed: false, ok: false, reason: 'failed' });
      return { ok: false, message: BLOCKED };
    }
  }

  return {
    dryRun,
    transcript,
    shim,
    context(partial = {}) {
      const override = nonemptyZone(partial.appTimeZone) ?? configuredZone;
      const resolved = dates.resolveAppTimeZoneDetail(override, options.settingsTimeZone, dryRun);
      if (resolved.fallback) {
        note({
          op: 'timezone',
          zone: resolved.zone,
          fallback: true,
          dryRun: true,
          label: 'dry-run UTC fallback (not a Creator application time zone)',
        });
      }
      const ctx: ShimContext = {
        shim,
        appTimeZone: resolved.zone,
        record: partial.form && options.fieldValues && partial.record ? options.fieldValues.input(partial.form, partial.record) : (partial.record ?? {}),
        old: partial.old ?? {},
        now: options.now ?? new Date(),
      };
      if (partial.row) ctx.row = partial.row;
      if (partial.principal) ctx.principal = partial.principal;
      if (partial.formNonce) ctx.formNonce = partial.formNonce;
      if (partial.writeOp) ctx.writeOp = partial.writeOp;
      if (partial.rowId !== undefined) ctx.rowId = partial.rowId;
      if (partial.subformRow) ctx.subformRow = partial.subformRow;
      if (Array.isArray(partial.args)) ctx.args = partial.args;
      if (partial.element) ctx.element = partial.element;
      if (partial.transition) ctx.transition = partial.transition;
      if (partial.approver) ctx.approver = partial.approver;
      if (typeof partial.prefetchPath === 'string') ctx.prefetchPath = partial.prefetchPath;
      if (typeof partial.rangeSlot === 'string') ctx.rangeSlot = partial.rangeSlot;
      if (typeof partial.rangeFrom === 'number') ctx.rangeFrom = partial.rangeFrom;
      if (typeof partial.rangeTo === 'number') ctx.rangeTo = partial.rangeTo;
      if (partial.rangeEmpty === true) ctx.rangeEmpty = true;

      return ctx;
    },
  };
}

let formSeq = 0;

const PREFETCH_BLOCKED = 'Prefetch is stale or failed; client action blocked.';

function readPrefetch(raw: unknown, sentNonce: string): { ok: boolean; slots: Record<string, unknown>; message?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, slots: {}, message: PREFETCH_BLOCKED };
  }
  const body = raw as Record<string, unknown>;
  if (body.ok === false || typeof body.error === 'string') {
    const message = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : PREFETCH_BLOCKED;
    return { ok: false, slots: {}, message };
  }
  const nonce = typeof body.nonce === 'string' ? body.nonce : '';
  const slots = body.slots;
  if (nonce !== sentNonce || !slots || typeof slots !== 'object' || Array.isArray(slots)) {
    return { ok: false, slots: {}, message: PREFETCH_BLOCKED };
  }
  return { ok: true, slots: slots as Record<string, unknown> };
}

/** The generated Advanced I/O route for one read-only `thisapp` callee. */
function clientCallPath(path: string): string {
  const segment = path
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `/functions/${segment || 'handler'}/call`;
}

function readClientCall(raw: unknown, sentNonce: string): { ok: boolean; value?: unknown; message?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: PREFETCH_BLOCKED };
  const body = raw as Record<string, unknown>;
  if (body.ok === false || typeof body.error === 'string') {
    const message = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : PREFETCH_BLOCKED;
    return { ok: false, message };
  }
  const nonce = typeof body.nonce === 'string' ? body.nonce : '';
  if (body.ok !== true || nonce !== sentNonce) return { ok: false, message: PREFETCH_BLOCKED };
  return { ok: true, value: body.value };
}

/**
 * The `as` cast is erased on emit. checkJs then types `typeof x === "object"`
 * as `{}` and reports TS2339 on ROWID, ID, and id. A helper with no emitted
 * annotation returns implicit any.
 */
function rowRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Catalyst updateRows addresses a row by ROWID. A missing id is an error on a live write. */
function rowIdentity(row: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(row, 'ROWID')) return row.ROWID;
  if (Object.prototype.hasOwnProperty.call(row, 'rowid')) return row.rowid;
  return undefined;
}

function requireRowId(form: string, id: unknown): unknown {
  if (id === undefined || id === null || id === '') throw new MissingRowIdError(form);
  return id;
}

interface PendingUpdate {
  form: string;
  rowid: unknown;
  fields: Record<string, unknown>;
  /** Counter columns: the value the script read before its first write. */
  base: Record<string, unknown>;
}

interface FetchedRow {
  form: string;
  rowid: unknown;
  principal?: Principal;
}

/**
 * Deluge `range from <start> to <end>` (both ends included).
 * Start 0 numbers the end from 0. Start 1 or more numbers the end from 1.
 * `0 to 3` and `1 to 4` are the same four records. `2 to 4` is the next three.
 * https://www.zoho.com/deluge/help/fetch-records/fetch-collection-records.html
 */
function parseRange(range: { from: unknown; to: unknown }): { offset: number; count: number } {
  const from = asIndex(range.from, 'from');
  const to = asIndex(range.to, 'to');
  if (from === 0) return { offset: 0, count: to + 1 };
  if (to < from) throw new RangeIndexError('query.range end is before start');
  return { offset: from - 1, count: to - from + 1 };
}

function asIndex(value: unknown, side: 'from' | 'to'): number {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeIndexError(`query.range ${side} is out of range`);
    }
    n = Number(value);
  } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) n = Number(value.trim());
  else throw new RangeIndexError(`query.range ${side} is not an integer index`);
  if (!Number.isSafeInteger(n)) throw new RangeIndexError(`query.range ${side} is not an integer index`);
  if (n < 0) throw new RangeIndexError(`query.range ${side} is negative`);
  return n;
}

export type PageQuery = (
  form: string,
  where: string,
  limit: number,
  offset: number,
  orderBy: string,
) => Promise<Record<string, unknown>[]>;

function fieldName(field: unknown): string {
  return typeof field === 'string' ? field : '';
}

/** A record's `ID` reads as its Catalyst ROWID: logical ID is never a stored column. */
function logicalId(row: Record<string, unknown>): unknown {
  return rowIdentity(row);
}

/**
 * Row exposed to a script. The grant projection drops fields the profile cannot
 * read, but the record identifier is always readable in Creator — `rec.ID`
 * resolves to ROWID, so ROWID stays on the bound row.
 */
function scopedRow(row: Record<string, unknown>, fields: readonly string[] | undefined): Record<string, unknown> {
  const projected = projectFields(row, fields);
  if (fields && !Object.hasOwn(projected, 'ROWID')) {
    const id = rowIdentity(row);
    if (id !== undefined) projected.ROWID = id;
  }
  return projected;
}

function aggregateSeed(
  rows: readonly Record<string, unknown>[],
  fn: string,
  field: unknown,
  fields: readonly string[] | undefined,
  decimals: DecimalColumns = {},
): unknown {
  if (fn === 'count') return rows.length;
  const name = fieldName(field);
  const values = rows.map((row) => (name === 'ID' ? logicalId(row) : projectFields(row, fields)[name]));
  if (fn === 'distinct') return lists.distinct(values);
  // sum / avg / min / max / median of the fetched values. A decimal, percent
  // or currency column is exact (data-access/aggregate-records/*).
  return lists.aggregate(values, fn, undefined, Object.hasOwn(decimals, name));
}

/**
 * Dry-run fetch of one seeded form. Null when this form has no seed, so the
 * caller keeps the empty dry-run result. Each call copies the rows; a later
 * `removeElement` cannot change the next fetch.
 */
/** Seed rows read by the field reader's store rules, so a dry run sees the values a live read returns. */
function typedSeed(seed: RuntimeOptions['seed'], reader: FieldValueReader | undefined): RuntimeOptions['seed'] {
  if (!seed || !reader?.stored) return seed;
  const out: Record<string, readonly Record<string, unknown>[]> = {};
  for (const form of Object.keys(seed)) {
    const rows = seed[form];
    out[form] = Array.isArray(rows) ? rows.map((row) => (row && typeof row === 'object' ? reader.stored!(form, row) : row)) : rows!;
  }
  return out;
}

function readSeed(
  seed: RuntimeOptions['seed'],
  dryRun: boolean,
  form: string,
  criteria: Criteria,
  sort: Query['sort'] | undefined,
  range: Query['range'] | undefined,
  decimals: DecimalColumns = {},
): Promise<Record<string, unknown>[] | null> {
  if (!dryRun || !seed || !Object.hasOwn(seed, form)) return Promise.resolve(null);
  const source = seed[form];
  if (!Array.isArray(source)) throw new TypeError(`seed for ${form} is not a row list`);
  const paired: { row: Record<string, unknown>; id: string }[] = [];
  for (let i = 0; i < source.length; i++) {
    const raw = source[i] ?? {};
    if (!matchRow(raw, criteria, decimals)) continue;
    const given = raw.ROWID ?? raw.rowid;
    const id = given == null || given === '' ? String(i + 1) : String(given);
    paired.push({ row: { ...raw }, id });
  }
  const keys = sortKeys(sort);
  paired.sort((a, b) => {
    for (const k of keys) {
      const sign = sortDirection(k.dir) === 'DESC' ? -1 : 1;
      if (k.field !== 'ROWID' && k.field !== 'rowid' && k.field !== 'ID') {
        const cmp = Object.hasOwn(decimals, k.field) ? compareDecimalCells : compareCells;
        const primary = cmp(a.row[k.field], b.row[k.field]) * sign;
        if (primary !== 0) return primary;
      } else {
        // ROWID is an id, not a cell. Lexicographic order puts "9" after "10".
        const byId = compareIds(a.id, b.id) * sign;
        if (byId !== 0) return byId;
      }
    }
    return compareIds(a.id, b.id);
  });
  const ordered = paired.map((item) => item.row);
  return fetchRows(form, 'true', range, orderByClause(sort), async (_form, _where, limit, offset) => {
    return ordered.slice(offset, offset + limit);
  });
}

/**
 * Exact digit-string order: shorter length is smaller, then code units.
 * `Number()` rounds a 17-digit Catalyst id, so two different ids compare equal.
 */
function compareIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right) && left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Script `sort by` is the primary key. ROWID is always the last key, so
 * OFFSET pages of tied rows do not overlap or skip. No sort is `ORDER BY ROWID`.
 * A sort on an exact-decimal field orders by its Double shadow; varchar order is
 * text order (`'90.00'` after `'1000.00'`). {@link queryExact} then re-sorts exactly.
 */
function orderByClause(sort?: Query['sort'], decimals: DecimalColumns = {}): string {
  const keys = sortKeys(sort);
  // `sort by ID` orders by the record identifier, which is ROWID.
  const first = keys[0];
  const field = first?.field === 'ID' ? 'ROWID' : first?.field;
  if (!field || (field === 'ROWID' && keys.length === 1)) {
    const dir = field === 'ROWID' ? sortDirection(first?.dir) : undefined;
    return dir ? `ORDER BY ROWID ${dir}` : 'ORDER BY ROWID';
  }
  const parts = keys.map((k) => {
    const f = k.field === 'ID' ? 'ROWID' : k.field;
    const column = Object.hasOwn(decimals, f) ? decimals[f]!.shadow : f;
    const dir = sortDirection(k.dir);
    return dir ? `${column} ${dir}` : column;
  });
  return `ORDER BY ${parts.join(', ')}, ROWID`;
}

/** Every `sort by` key, first to last. A single key has no `fields` list. */
function sortKeys(sort: Query['sort'] | undefined): { field: string; dir?: string }[] {
  if (!sort) return [];
  return sort.fields ?? (sort.field ? [{ field: sort.field, ...(sort.dir ? { dir: sort.dir } : {}) }] : []);
}

/** True when a read on this form needs {@link queryExact}'s exact pass. */
export function needsExactRead(criteria: Criteria, sort: Query['sort'] | undefined, decimals: DecimalColumns): boolean {
  if (sortKeys(sort).some((k) => Object.hasOwn(decimals, k.field))) return true;
  return exactFilter(criteria, decimals) !== null;
}

/** `where` AND `extra`. An empty or `true` WHERE is just `extra`. */
function andWhere(where: string, extra: string): string {
  const base = where.trim();
  return !base || base === 'true' ? extra : `(${base}) AND ${extra}`;
}

function shadowKey(row: Record<string, unknown>, shadow: string): string {
  const value = row[shadow];
  return value == null || value === '' ? '\u0000null' : String(value);
}

function stripShadows(row: Record<string, unknown>, decimals: DecimalColumns): Record<string, unknown> {
  let out = row;
  for (const spec of Object.values(decimals)) {
    if (!Object.hasOwn(row, spec.shadow)) continue;
    if (out === row) out = { ...row };
    delete out[spec.shadow];
  }
  return out;
}

/**
 * Live paged read that is exact on exact-decimal fields.
 *
 * `where` is {@link compileCriteria} with the same `decimals`: a superset on the
 * Double shadow columns. Rows it over-matches are dropped by `decimal.cmp` on the
 * varchar ({@link exactFilter}). A sort on such a field orders by the shadow in ZCQL;
 * binary64 rounding is monotonic, so only rows with equal shadows can be out of exact
 * order. They are re-sorted by the exact value, then ROWID.
 *
 * `range` applies to the exact result. The read pages from offset 0, 300 rows at a
 * time ({@link LIMITS.zcqlRowsPerQuery}), until it holds `from..to` exact matches and,
 * for a decimal sort, has passed every row tied on the shadow with the last one kept.
 * More than {@link LIMITS.zcqlMaxRows} scanned rows throws {@link ZcqlRowCapError}.
 * Without decimal criteria or sort this is the plain {@link fetchRows} read.
 *
 * A NULL shadow sorts first ascending, whatever the varchar holds, so a row written
 * before the shadow column existed would take a window slot it does not own. A decimal
 * sort with a window therefore reads the NULL-shadow rows in a separate query, keeps
 * them all, and windows the rows with a shadow as above; the exact sort places both.
 * That costs one more query (one page while the shadows are backfilled).
 */
export async function queryExact(
  query: PageQuery,
  form: string,
  where: string,
  opts: { criteria: Criteria; decimals?: DecimalColumns; sort?: Query['sort']; range?: Query['range'] },
): Promise<Record<string, unknown>[]> {
  const decimals = opts.decimals ?? {};
  const filter = exactFilter(opts.criteria, decimals);
  const exactKey = sortKeys(opts.sort).find((k) => Object.hasOwn(decimals, k.field));
  const sortField = exactKey?.field;
  const orderBy = orderByClause(opts.sort, decimals);
  if (!filter && !sortField) {
    const rows = await fetchRows(form, where, opts.range, orderBy, query);
    return rows.map((row) => stripShadows(row, decimals));
  }
  const window = opts.range ? parseRange(opts.range) : undefined;
  if (window && window.count === 0) return [];
  if (window && window.count > LIMITS.zcqlMaxRows) throw new ZcqlRowCapError(form, LIMITS.zcqlMaxRows);
  const shadow = sortField ? decimals[sortField]!.shadow : undefined;
  const pageSize = LIMITS.zcqlRowsPerQuery;
  const kept: Record<string, unknown>[] = [];
  let scan = where;
  let budget = LIMITS.zcqlMaxRows;
  if (shadow && window) {
    const unplaced = andWhere(where, `${shadow} IS NULL`);
    for (let offset = 0; ; offset += pageSize) {
      const page = await readPage(form, unplaced, pageSize, offset, 'ORDER BY ROWID', query);
      if (page.length > 0 && offset >= LIMITS.zcqlMaxRows) throw new ZcqlRowCapError(form, LIMITS.zcqlMaxRows);
      for (const row of page) if (!filter || filter(row)) kept.push(row);
      budget -= page.length;
      if (page.length < pageSize) break;
    }
    scan = andWhere(where, `${shadow} IS NOT NULL`);
  }
  const want = window ? window.offset + window.count + kept.length : Infinity;
  let boundary: string | undefined;
  let offset = 0;
  let done = false;
  while (!done) {
    if (offset >= budget) {
      const extra = await readPage(form, scan, pageSize, offset, orderBy, query);
      if (extra.length > 0) throw new ZcqlRowCapError(form, LIMITS.zcqlMaxRows);
      break;
    }
    const page = await readPage(form, scan, pageSize, offset, orderBy, query);
    for (const row of page) {
      if (boundary !== undefined && shadowKey(row, shadow!) !== boundary) {
        done = true;
        break;
      }
      if (filter && !filter(row)) continue;
      kept.push(row);
      if (kept.length === want) {
        if (!shadow) {
          done = true;
          break;
        }
        boundary = shadowKey(row, shadow);
      }
    }
    if (page.length < pageSize) break;
    offset += page.length;
  }
  if (sortField) {
    const keys = sortKeys(opts.sort);
    const ids = new Map(kept.map((row) => [row, String(rowIdentity(row) ?? '')]));
    kept.sort((a, b) => {
      for (const k of keys) {
        const sign = sortDirection(k.dir) === 'DESC' ? -1 : 1;
        const cmp = Object.hasOwn(decimals, k.field) ? compareDecimalCells : compareCells;
        const d = cmp(a[k.field], b[k.field]) * sign;
        if (d !== 0) return d;
      }
      return compareIds(ids.get(a)!, ids.get(b)!);
    });
  }
  const out = window ? kept.slice(window.offset, window.offset + window.count) : kept;
  return out.map((row) => stripShadows(row, decimals));
}

/** Read one generated lookup junction in Creator's stored value order. */
export async function readMultiLookupValues(
  query: NonNullable<RuntimeOptions['datastore']>['query'],
  junction: { table: string; parentColumn: string; valueColumn: string; orderColumn: string },
  parentRowId: unknown,
): Promise<string[]> {
  if (!query) throw new Error(`multi lookup ${junction.table} needs a datastore query adapter`);
  const id = String(parentRowId).replace(/\\/g, '\\\\').replace(/'/g, "''");
  const values: string[] = [];
  for (let offset = 0; offset < LIMITS.zcqlMaxRows; offset += LIMITS.zcqlRowsPerQuery) {
    const rows = await query(junction.table, `${junction.parentColumn} = '${id}'`, LIMITS.zcqlRowsPerQuery, offset, `ORDER BY ${junction.orderColumn}, ROWID`);
    values.push(...rows.map((row) => row[junction.valueColumn]).filter((value): value is string | number => typeof value === 'string' || typeof value === 'number').map(String));
    if (rows.length < LIMITS.zcqlRowsPerQuery) return values;
  }
  throw new ZcqlRowCapError(junction.table, LIMITS.zcqlMaxRows);
}

function sortDirection(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const lower = dir.toLowerCase();
  if (lower === 'asc' || lower === 'ascending') return 'ASC';
  if (lower === 'desc' || lower === 'descending') return 'DESC';
  return dir;
}

/** Page at {@link LIMITS.zcqlRowsPerQuery} until a short page, a range window, or the hard cap. */
async function fetchRows(
  form: string,
  where: string,
  range: Query['range'] | undefined,
  orderBy: string,
  query: PageQuery,
): Promise<Record<string, unknown>[]> {
  const window = range ? parseRange(range) : undefined;
  if (window && window.count === 0) return [];
  if (window && window.count > LIMITS.zcqlMaxRows) throw new ZcqlRowCapError(form, LIMITS.zcqlMaxRows);

  const pageSize = LIMITS.zcqlRowsPerQuery;
  const cap = LIMITS.zcqlMaxRows;
  const want = window ? window.count : cap;
  const out: Record<string, unknown>[] = [];
  let offset = window ? window.offset : 0;

  while (out.length < want) {
    const page = await readPage(form, where, pageSize, offset, orderBy, query);
    if (page.length === 0) break;
    out.push(...page);
    if (page.length < pageSize) break;
    offset += page.length;
    if (!window && out.length >= cap) {
      const extra = await readPage(form, where, pageSize, offset, orderBy, query);
      if (extra.length > 0) throw new ZcqlRowCapError(form, cap);
      break;
    }
  }
  return out.slice(0, want);
}

async function readPage(
  form: string,
  where: string,
  limit: number,
  offset: number,
  orderBy: string,
  query: PageQuery,
): Promise<Record<string, unknown>[]> {
  const page = await query(form, where, limit, offset, orderBy);
  if (!Array.isArray(page)) throw new TypeError(`ZCQL adapter for ${form} did not return a row list`);
  if (page.length > limit) throw new Error(`ZCQL adapter for ${form} returned ${page.length} rows; the page size is ${limit}`);
  return page;
}

function previewTop(values: Record<string, unknown>, path: string[], value: unknown): unknown {
  if (path.length === 1) return value;
  const holder: Record<string, unknown> = {};
  holder[path[0]!] = clonePlain(values[path[0]!]);
  setPath(holder, path, value);
  return holder[path[0]!];
}

function clonePlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => clonePlain(item));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = clonePlain(inner);
    return out;
  }
  return value;
}

/** Catalyst returns every Data Store value as a string. Decimal stays a decimal string. */
function stringifyValues(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v instanceof Decimal) out[k] = v.toString();
    else if (v instanceof dates.DelugeDate) out[k] = v.toString();
    else out[k] = bigintsToDigits(v);
  }
  return out;
}

/** Job pool names cannot contain "_" (console evidence). */
export function jobPoolName(appName: string): string {
  const cleaned = appName.replace(/[^A-Za-z0-9]/g, '');
  if (cleaned) return cleaned;
  return 'p' + hash6(appName);
}

function hash6(text: string): string {
  // FNV-1a 32-bit, hex, first 6 — derived from the name, not a chosen id.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}
