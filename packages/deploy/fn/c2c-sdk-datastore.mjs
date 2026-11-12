/**
 * Shim datastore adapter over zcatalyst-sdk-node (admin scope app).
 * Node SDK: https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/overview/
 * Bulk limits: https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/bulk-operations/
 *
 *   insert(form, rows)  table(form).insertRows, at most 200 rows per call
 *   update(form, rows)  table(form).updateRows, at most 200 rows per call; every row carries ROWID
 *   delete(form, ids)   table(form).deleteRows, at most 200 ROWIDs per call
 *   query(form, where, limit, offset, orderBy, columns)
 *                       up to `limit` rows after `offset` matches. `columns` is an explicit list
 *                       (string or array); ROWID is added when missing. When the caller omits it,
 *                       opts.projections[form] is used, else a columns function or a name list on
 *                       opts.columns[form]. A type map ({ column: Data Store type }) is not a
 *                       projection: that read stays SELECT *. A read with no column list throws.
 *                       `offset` is a 0-based count of rows to skip. ZCQL LIMIT offsets are
 *                       1-based (0 clamps to 1), so a page reads LIMIT skip + 1, n.
 *                       A ROWID-ordered read wider than one page (300 rows) pages by keyset:
 *                       WHERE (<predicate>) AND ROWID >/< <last>, so the predicate is never dropped.
 *                       A column list longer than the unverified select cap (LIMITS.selectColumns) is several
 *                       statements of at most that many columns. Each statement repeats ROWID.
 *                       Later statements bind ROWID IN the page the first statement returned.
 *                       No column is omitted. Other orders and single pages use the offset LIMIT.
 *                       ZCQL has no boolean
 *                       literal predicate, so an always-true read ("" or "true") sends no WHERE
 *                       clause and "false" reads nothing.
 *                       Rows come back wrapped by table name ({ Form: { ... } }) and are unwrapped.
 *
 * Values: an ISO local datetime ("2026-10-06T15:50:58") is written as "2026-10-06 15:50:58".
 * A bigint is written as its digit string. ROWIDs are passed as strings (17+ digits).
 *
 * Column types (opts.columns, from c2c-columns.json: { <table>: { <column>: <Data Store type> } })
 * make the conversion exact for a known table:
 *   Boolean   write true/false as "true"/"false"; read "true"/"false" (any case) as a boolean.
 *             Data Store returns boolean columns as text, and "false" is truthy in JS.
 *   DateTime  write "yyyy-MM-dd HH:mm:ss" (seconds; a fraction is dropped). An instant (a trailing
 *             Z or +hh:mm offset, or a Date) is converted to wall time in opts.appTimeZone; without
 *             a zone it throws rather than guess. Read back as ISO local "yyyy-MM-ddTHH:mm:ss".
 *   BigInt, Foreign Key
 *             ids stay digit strings both ways. A JS number that is not a safe integer has lost
 *             digits already, so it throws instead of writing or returning a wrong id.
 *   Number    a BigInt or Int column holding a Creator number or auto-number. ZCQL returns it as
 *             text, and generated Deluge arithmetic on text joins it ("100" + 1 is "1001"). Read
 *             digit text as a JS number, or as a JS bigint past 2^53 so no digit is lost (mixing
 *             that bigint with a number in arithmetic throws a TypeError rather than store a wrong
 *             value). Write a number or bigint as its digit string, so a value read and written
 *             back unchanged is stored identically. NULL stays null.
 *   Double    read numeric text as a JS number (ZCQL returns Double as a JSON number already).
 *   Decimal, Date
 *             an exact-decimal varchar and a date column are written as they are and read as
 *             canonical decimal text and "yyyy-MM-dd".
 * Reads go through c2c-field-values.mjs, the same rules the entry applies to posted values; a
 * blank typed value reads as null.
 * ROWID and CREATORID are digit strings on every table, known or not. A table with no entry keeps
 * the untyped behaviour above.
 *
 * Rate limits: a 429 (or a "too many requests" error) with Retry-After (seconds or an HTTP date) is
 * retried no sooner than the server asked; if that wait is longer than maxWaitMs the call fails at
 * once with a clear error instead. Without the header the delay is exponential, capped at
 * maxDelayMs. After maxRetries the error is thrown. Other errors are thrown at once.
 *
 * Write check: opts.checkWrite(form, row, 'insert'|'update') runs on each row
 * AFTER the type conversion and before the SDK call, including subform child
 * rows a handler writes through this adapter directly. The check sees the
 * wall-time datetimes the conversion produces, so a fractional, date-only,
 * instant, or Date value the adapter accepts is not refused. It returns the
 * row to send (a refusing check throws; the store is never called with it).
 *
 * Renamed columns (opts.renames, from c2c-renames.json: { <table>: { <field>: <column> } }):
 * a Creator field whose name is a reserved Data Store column name is stored under
 * another column. Callers keep the field name. Rows are written and read back with
 * the field name; column lists, WHERE and ORDER BY name the stored column. Column
 * types and projections name the stored column; the write check sees field names.
 */

import { readValue } from './c2c-field-values.mjs';

/* selectColumns is the unverified ZCQL select cap; the generator overwrites it with zcql.select_columns when it copies this file into the function directory. */
export const LIMITS = { insertRowsPerCall: 200, updateRowsPerCall: 200, deleteRowsPerCall: 200, zcqlRowsPerQuery: 300, selectColumns: 30 };
export const RETRY = { maxRetries: 4, baseDelayMs: 500, maxDelayMs: 8000, maxWaitMs: 60000 };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ORDER_BY = /^ORDER BY [A-Za-z_][A-Za-z0-9_]*( (ASC|DESC))?(, [A-Za-z_][A-Za-z0-9_]*( (ASC|DESC))?)*$/;

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function statusOf(err) {
  if (!err || typeof err !== 'object') return 0;
  for (const value of [err.statusCode, err.status, err.code, err.response && err.response.status]) {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const message = typeof err.message === 'string' ? err.message : '';
  if (/too many requests|\b429\b/i.test(message)) return 429;
  return 0;
}

function headerOf(err, name) {
  const sources = [err && err.headers, err && err.response && err.response.headers];
  for (const headers of sources) {
    if (!headers) continue;
    if (typeof headers.get === 'function') {
      const value = headers.get(name);
      if (value != null) return String(value);
    }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) return String(headers[key]);
    }
  }
  return '';
}

/** Retry-After in ms (delta-seconds or an HTTP date), or -1 when absent or unreadable. */
export function retryAfterMs(err, nowMs = Date.now()) {
  const raw = headerOf(err, 'retry-after').trim();
  if (!raw) return -1;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : -1;
}

export function isRateLimited(err) {
  return statusOf(err) === 429;
}

export async function withBackoff(fn, opts = {}) {
  const retry = { ...RETRY, ...opts };
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimited(err) || attempt >= retry.maxRetries) throw err;
      const hinted = retryAfterMs(err);
      if (hinted > retry.maxWaitMs) {
        const wait = Math.ceil(hinted / 1000);
        const limit = Math.floor(retry.maxWaitMs / 1000);
        throw Object.assign(new Error(`datastore: rate limited (429); Retry-After asks for ${wait}s, more than the ${limit}s max wait`), {
          statusCode: 429,
          retryAfterMs: hinted,
          cause: err,
        });
      }
      // The server's Retry-After is a floor, never capped; only the no-header backoff is.
      const delay = hinted >= 0 ? hinted : Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
      if (typeof opts.onRetry === 'function') opts.onRetry({ attempt: attempt + 1, delay, status: 429 });
      await sleep(delay);
    }
  }
}

const ISO_LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})$/;
const WALL_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.:]\d{1,9})?$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ID_COLUMNS = ['ROWID', 'CREATORID'];
const ID_TYPES = ['BigInt', 'Foreign Key'];

/** Wall time of an instant in an IANA zone, as "yyyy-MM-dd HH:mm:ss". */
export function wallTime(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const bag = {};
  for (const part of fmt.formatToParts(ms)) if (part.type !== 'literal') bag[part.type] = part.value;
  const hour = bag.hour === '24' ? '00' : bag.hour;
  return `${bag.year}-${bag.month}-${bag.day} ${hour}:${bag.minute}:${bag.second}`;
}

function storedDateTime(value, where, timeZone) {
  let ms;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value !== 'string') return value;
  else {
    const text = value.trim();
    const wall = WALL_TIME.exec(text);
    if (wall) return `${wall[1]} ${wall[2]}`;
    if (DATE_ONLY.test(text)) return `${text} 00:00:00`;
    if (!INSTANT.test(text)) return value;
    ms = Date.parse(text);
  }
  if (!Number.isFinite(ms)) throw new Error(`datastore: ${where} is not a valid date-time`);
  if (!timeZone) {
    throw new Error(`datastore: ${where} is an instant; set C2C_APP_TIMEZONE or c2c-deploy.json appTimeZone to store it as app-local time`);
  }
  return wallTime(ms, timeZone);
}

function idDigits(value, where) {
  if (typeof value !== 'number') return value;
  if (!Number.isSafeInteger(value)) throw new Error(`datastore: ${where} is the JS number ${value}, which has lost digits; ids must be digit strings`);
  return String(value);
}

/** A Number column value for the store: an integer as its digit string. */
function storedNumber(value, where) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return value;
  if (!Number.isSafeInteger(value)) throw new Error(`datastore: ${where} is the JS number ${value}, which has lost digits; pass a bigint or digit text`);
  return String(value);
}

function typesOf(columns, form) {
  if (!columns || typeof columns === 'function') return undefined;
  const types = Object.prototype.hasOwnProperty.call(columns, form) ? columns[form] : undefined;
  // A name list is a projection, not a type map. An array is an object, so exclude it.
  if (!types || typeof types !== 'object' || Array.isArray(types)) return undefined;
  return types;
}

/**
 * Data Store datetime columns take "yyyy-MM-dd HH:mm:ss"; the shims stamp ISO local time.
 * A bigint (a toLong id) is sent as its digits, at any depth: the SDK's JSON body cannot hold a bigint.
 * With column types (see the header) booleans, datetimes and ids are converted by type instead.
 */
export function storedRow(row, types, opts = {}) {
  const out = {};
  for (const key of Object.keys(row)) {
    const value = digits(row[key]);
    const where = `${opts.form || 'row'}.${key}`;
    const type = types && Object.prototype.hasOwnProperty.call(types, key) ? types[key] : undefined;
    if (ID_COLUMNS.includes(key) || ID_TYPES.includes(type)) out[key] = idDigits(value, where);
    else if (type === 'Number') out[key] = storedNumber(value, where);
    else if (type === 'Boolean') out[key] = typeof value === 'boolean' ? String(value) : value;
    else if (type === 'DateTime') out[key] = storedDateTime(value, where, opts.appTimeZone);
    else if (types) out[key] = value;
    else {
      const match = typeof value === 'string' ? ISO_LOCAL.exec(value) : null;
      out[key] = match ? `${match[1]} ${match[2]}` : value;
    }
  }
  return out;
}

/** A row as the shims read it: ids as digit strings, and, for a known table, numbers, booleans and ISO local datetimes. */
export function readRow(row, types, form = 'row') {
  const out = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    const type = types && Object.prototype.hasOwnProperty.call(types, key) ? types[key] : undefined;
    if (ID_COLUMNS.includes(key) || ID_TYPES.includes(type)) out[key] = idDigits(value, `${form}.${key}`);
    else out[key] = readValue(type, value, `${form}.${key}`);
  }
  return out;
}

/** Copy of shims ids.ts bigintsToDigits: every bigint in plain objects and arrays as its digits. */
function digits(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(digits);
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = digits(item);
    return out;
  }
  return value;
}

function tableName(form) {
  if (typeof form !== 'string' || !IDENT.test(form)) throw new Error(`datastore: ${String(form)} is not a ZCQL table identifier`);
  return form;
}

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') return [result];
  return [];
}

function unwrap(form, row) {
  if (!row || typeof row !== 'object') return {};
  const inner = row[form];
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : row;
}

const ROWID_ORDER = /^ORDER BY ROWID( (ASC|DESC))?$/;

/** Explicit ZCQL column list: identifiers, deduplicated, ROWID always present. `*` stays `*`. */
function columnList(columns) {
  if (columns === '*') return '*';
  const names = (Array.isArray(columns) ? columns : String(columns ?? '').split(',')).map((name) => String(name).trim()).filter(Boolean);
  if (!names.length || names.some((name) => !IDENT.test(name))) throw new Error('datastore: unsupported column list');
  const dedup = [...new Set(names)];
  if (!dedup.includes('ROWID')) dedup.unshift('ROWID');
  return dedup.join(', ');
}

/**
 * One statement when the list fits. Past the unverified cap, ROWID plus at
 * most cap-1 other columns per statement, in the original order. `*` is one
 * statement: a type map has no names to split, and a named projection is not `*`.
 */
function selectChunks(columns) {
  if (columns === '*') return ['*'];
  const names = columnList(columns).split(', ').filter(Boolean);
  const cap = LIMITS.selectColumns;
  if (!Number.isInteger(cap) || cap < 2) throw new Error('datastore: select cap is not usable');
  if (names.length <= cap) return [names];
  const rest = names.filter((name) => name !== 'ROWID');
  const width = cap - 1;
  const chunks = [];
  for (let i = 0; i < rest.length; i += width) chunks.push(['ROWID', ...rest.slice(i, i + width)]);
  return chunks;
}

function rowidOf(row, form) {
  const value = row && row.ROWID;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`datastore: ${form} page row is missing a numeric ROWID`);
  return value;
}

/**
 * Projection for one read. An explicit list wins. Otherwise opts.projections,
 * a columns function, or a name list on opts.columns[form]. A type map falls
 * back to `*` so untyped columns are not dropped.
 */
function projectionOf(form, explicit, opts) {
  if (explicit !== undefined && explicit !== null) return explicit;
  if (typeof opts.projections === 'function') return opts.projections(form);
  if (opts.projections && Object.prototype.hasOwnProperty.call(opts.projections, form) && opts.projections[form] != null) {
    return opts.projections[form];
  }
  if (typeof opts.columns === 'function') return opts.columns(form);
  const entry = opts.columns && typeof opts.columns === 'object' && Object.prototype.hasOwnProperty.call(opts.columns, form) ? opts.columns[form] : undefined;
  if (Array.isArray(entry)) return entry;
  if (opts.columns && typeof opts.columns === 'object' && typeof opts.columns !== 'function') return '*';
  return undefined;
}

/**
 * One ZCQL page. `after` is the last ROWID of the previous page (ROWID order
 * only): the predicate stays inside parentheses and the bound is ANDed on.
 * LIMIT offsets are 1-based (0 clamps to 1), so every page reads LIMIT skip + 1, size.
 */
export function zcqlSelect(form, where, limit, offset, orderBy, columns, after) {
  const table = tableName(form);
  const predicate = typeof where === 'string' ? where.trim() : '';
  const size = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, LIMITS.zcqlRowsPerQuery) : LIMITS.zcqlRowsPerQuery;
  const skip = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const requested = typeof orderBy === 'string' ? orderBy.trim() : '';
  if (requested && !ORDER_BY.test(requested)) throw new Error(`datastore: unsupported ${requested}`);
  const order = requested || 'ORDER BY ROWID';
  const clause = predicate && predicate.toLowerCase() !== 'true' ? ` WHERE ${predicate}` : '';
  let keyset = clause;
  if (after !== undefined) {
    if (typeof after !== 'string' || !/^\d+$/.test(after)) throw new Error(`datastore: keyset ROWID is not an integer: ${String(after)}`);
    if (!ROWID_ORDER.test(order)) throw new Error(`datastore: keyset paging needs ROWID order, not ${order}`);
    if (skip > 0) throw new Error('datastore: keyset and offset are exclusive');
    const bound = `ROWID ${/ DESC$/.test(order) ? '<' : '>'} ${after}`;
    keyset = clause ? ` WHERE (${predicate}) AND ${bound}` : ` WHERE ${bound}`;
  }
  // ZCQL LIMIT offsets are 1-based (0 clamps to 1): skipping `skip` rows reads LIMIT skip + 1.
  return `SELECT ${columnList(columns)} FROM ${table}${keyset} ${order} LIMIT ${skip + 1}, ${size}`;
}

/** Upper-case words the criteria compiler emits; never a field to rename. */
const ZCQL_EMITTED = new Set(['AND', 'OR', 'NOT', 'IS', 'NULL', 'IN', 'LIKE', 'BETWEEN', 'ORDER', 'BY', 'ASC', 'DESC']);

function hasOwn(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/** Row keys through `map`; keys not in it stay. */
export function renameKeys(row, map) {
  if (!map || !row || typeof row !== 'object') return row;
  const out = {};
  for (const key of Object.keys(row)) out[hasOwn(map, key) ? map[key] : key] = row[key];
  return out;
}

/**
 * Bare identifiers of a ZCQL fragment through `map`. Quoted literals ('…' with
 * '' escapes, "…", `…`) and the upper-case words the criteria compiler emits stay.
 */
export function renameIdentifiers(text, map) {
  if (!map || typeof text !== 'string' || !text) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === ch) {
          if (ch === "'" && text[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch) && !(i > 0 && /[A-Za-z0-9_]/.test(text[i - 1]))) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      const word = text.slice(i, j);
      out += hasOwn(map, word) && !ZCQL_EMITTED.has(word) ? map[word] : word;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function invert(map) {
  const out = {};
  for (const key of Object.keys(map)) out[map[key]] = key;
  return out;
}

/** field → column and column → field for one table, or undefined when nothing on it was renamed. */
function renamesOf(renames, form) {
  if (!renames || typeof renames !== 'object' || !hasOwn(renames, form)) return undefined;
  const toColumn = renames[form];
  if (!toColumn || typeof toColumn !== 'object' || !Object.keys(toColumn).length) return undefined;
  return { toColumn, toField: invert(toColumn) };
}

function renameColumnList(columns, map) {
  if (!map || columns === '*' || columns === undefined || columns === null) return columns;
  const names = Array.isArray(columns) ? columns : String(columns).split(',');
  return names.map((name) => {
    const trimmed = String(name).trim();
    return hasOwn(map, trimmed) ? map[trimmed] : trimmed;
  });
}

export function createSdkDatastore(app, opts = {}) {
  const call = (fn) => withBackoff(fn, opts);
  const table = (form) => app.datastore().table(tableName(form));
  const columns = opts.columns;
  const renamed = (form) => renamesOf(opts.renames, form);
  const write = (form) => {
    const names = renamed(form);
    return (row) => storedRow(names ? renameKeys(row, names.toColumn) : row, typesOf(columns, form), { form, appTimeZone: opts.appTimeZone });
  };
  const read = (form) => {
    const names = renamed(form);
    return (row) => {
      const out = readRow(row, typesOf(columns, form), form);
      return names ? renameKeys(out, names.toField) : out;
    };
  };
  const check = (form, kind, rows) => {
    if (typeof opts.checkWrite !== 'function') return rows;
    const names = renamed(form);
    if (!names) return rows.map((row) => opts.checkWrite(form, row, kind));
    return rows.map((row) => renameKeys(opts.checkWrite(form, renameKeys(row, names.toField), kind), names.toColumn));
  };
  return {
    async insert(form, rows) {
      const out = [];
      for (const part of chunk(check(form, 'insert', rows.map(write(form))), LIMITS.insertRowsPerCall)) {
        out.push(...rowsOf(await call(() => table(form).insertRows(part))));
      }
      return out.map(read(form));
    },
    async update(form, rows) {
      for (const row of rows) {
        if (!row || row.ROWID == null || row.ROWID === '') throw new Error(`datastore: update on ${form} needs a ROWID on every row`);
      }
      const out = [];
      for (const part of chunk(check(form, 'update', rows.map(write(form))), LIMITS.updateRowsPerCall)) {
        out.push(...rowsOf(await call(() => table(form).updateRows(part))));
      }
      return out.map(read(form));
    },
    async delete(form, rowIds) {
      const ids = [...rowIds].map((id) => String(idDigits(digits(id), `${form}.ROWID`)));
      const out = [];
      for (const part of chunk(ids, LIMITS.deleteRowsPerCall)) {
        out.push(...rowsOf(await call(() => table(form).deleteRows(part))));
      }
      return out.map(read(form));
    },
    async query(form, where, limit, offset, orderBy, columns) {
      const names = renamed(form);
      const toColumn = names ? names.toColumn : undefined;
      const predicate = renameIdentifiers(typeof where === 'string' ? where.trim() : '', toColumn);
      if (predicate.toLowerCase() === 'false') return [];
      tableName(form);
      const cols = renameColumnList(projectionOf(form, columns, opts), toColumn);
      if (cols === undefined || cols === null) throw new Error(`datastore: no column list for ${form}`);
      if (!Number.isInteger(limit) || limit < 1) throw new Error(`datastore: limit ${String(limit)} is not a positive integer`);
      const size = limit;
      let skip = Number.isInteger(offset) && offset >= 0 ? offset : 0;
      const requested = renameIdentifiers(typeof orderBy === 'string' ? orderBy.trim() : '', toColumn);
      const order = requested || 'ORDER BY ROWID';
      const convert = read(form);
      const readPage = async (sql) => rowsOf(await call(() => app.zcql().executeZCQLQuery(sql))).map((row) => convert(unwrap(form, row)));
      const chunks = selectChunks(cols);
      // The first statement chooses the page. Later statements of a wide list
      // fill the same ROWIDs and add the columns that did not fit.
      const readSqlPage = async (pageSize, pageSkip, pageOrder, after) => {
        const page = await readPage(zcqlSelect(form, predicate, pageSize, pageSkip, pageOrder, chunks[0], after));
        if (!page.length || chunks.length === 1) return page;
        const ids = page.map((row) => rowidOf(row, form));
        const bound = `ROWID IN (${ids.join(', ')})`;
        for (const part of chunks.slice(1)) {
          const extra = await readPage(zcqlSelect(form, bound, ids.length, 0, 'ORDER BY ROWID', part));
          const byId = new Map(extra.map((row) => [String(row.ROWID), row]));
          for (const row of page) {
            const hit = byId.get(String(row.ROWID));
            if (!hit) continue;
            for (const key of Object.keys(hit)) if (key !== 'ROWID') row[key] = hit[key];
          }
        }
        return page;
      };
      // A ROWID read of at most 300 rows is one page: LIMIT skip+1, n (1-based).
      // A wider ROWID read pages by keyset (WHERE ROWID >/< last, LIMIT 1, n).
      if (!ROWID_ORDER.test(order) || size <= LIMITS.zcqlRowsPerQuery) {
        const out = [];
        while (out.length < size) {
          const pageSize = Math.min(LIMITS.zcqlRowsPerQuery, size - out.length);
          const page = await readSqlPage(pageSize, skip + out.length, order);
          if (!page.length) break;
          out.push(...page);
          if (page.length < pageSize) break;
        }
        return out.slice(0, size);
      }
      const out = [];
      let after;
      while (out.length < size) {
        const pageSize = Math.min(LIMITS.zcqlRowsPerQuery, skip + size - out.length);
        const page = await readSqlPage(pageSize, 0, order, after);
        if (!page.length) break;
        after = rowidOf(page[page.length - 1], form);
        const take = page.slice(Math.min(skip, page.length));
        skip = Math.max(0, skip - page.length);
        out.push(...take);
        if (page.length < pageSize) break;
      }
      return out.slice(0, size);
    },
  };
}
