/**
 * Fakes for Catalyst's row insert:
 * - POST /baas/v1/project/<id>/table/<t>/row with a JSON array of row objects.
 * - 200 {"status":"success","data":[<stored row, with ROWID and c2c_source_id>, ...]}.
 * - A refusal is {"status":"failure","data":{"error_code":…,"message":…}}; the old
 *   /table/<t>/rows path answers 404 INVALID_URL_PATTERN.
 *
 * rowEndpoint() lets an older fake keep modelling writes as { rows: [{ id, columns }] }
 * answered with { ids }: it checks the real request shape, hands the inner fake that
 * view, and turns its { ids } into the real success body.
 */
import assert from 'node:assert/strict';
import type { FetchLike, MigrateResponse } from '../src/migrate.js';

export const ROW_PATH = /\/table\/[^/]+\/row$/;

export function textResponse(text: string, status = 200): MigrateResponse {
  return { status, headers: { get: () => null }, text: async () => text };
}

/** Catalyst's failure body, verbatim shape. */
export function catalystFailure(status: number, code: string, message: string): MigrateResponse {
  return textResponse(JSON.stringify({ status: 'failure', data: { error_code: code, message } }), status);
}

/** Catalyst's success body for stored rows. ROWIDs are synthetic 17-digit strings. */
export function catalystRows(rows: readonly Record<string, unknown>[], firstRowId: number | bigint = 10000000000000001n): MigrateResponse {
  const base = BigInt(firstRowId);
  return textResponse(
    JSON.stringify({ status: 'success', data: rows.map((row, i) => ({ ...row, ROWID: String(row.ROWID ?? base + BigInt(i)) })) }),
  );
}

/**
 * Data Store quirks the loader must not accept ([TESTED]):
 * - varchar is sliced to max length and the insert still returns 200 (16 chars → 10).
 * - a numeric date `05-10-2026` is stored as `0011-04-18` (REST).
 * - extra fractional digits are cut toward zero (0.105 → 0.10, -0.015 → -0.01).
 * - `errorAfterWrite` stores the row, then returns 400 `For input string: "nu"` (ZCQL).
 * The success body is the stored row, not the request, so a silent change is visible.
 */
export interface RowQuirk {
  truncate?: Readonly<Record<string, number>>;
  /** Column → scale. Extra digits are cut toward zero, then stored as a JSON number. */
  round?: Readonly<Record<string, number>>;
  mangleDates?: readonly string[];
  errorAfterWrite?: boolean;
  /** Store a second copy of each inserted row. The store can keep two rows for one source id. */
  duplicateInsert?: boolean;
  /**
   * Cell values written to the store after the echo: the success body shows the
   * sent row, but the stored row carries these overrides. Only the end-of-table
   * read-back can see the difference.
   */
  storeDrift?: Readonly<Record<string, unknown>>;
  /** The post is recorded and echoed as success but no row is stored. */
  dropInsert?: boolean;
}

export interface QuirkHandle {
  fetch: FetchLike;
  /** Bodies of POST /row, as sent, before the quirk. */
  posts: Record<string, unknown>[][];
  /** Bodies of PUT /row (row updates by ROWID), as sent, before the quirk. */
  puts: Record<string, unknown>[][];
  /** First stored row for each table and source id. */
  stored: Map<string, Record<string, unknown>>;
  /** Every stored copy, including a duplicate insert. */
  rowsFor(table: string, id: string): Record<string, unknown>[];
  /** Put a row in the store without a POST. Resume tests use this for a pre-existing duplicate. */
  addStored(table: string, row: Record<string, unknown>): void;
}

function cutScale(text: string, scale: number): string {
  const neg = text.startsWith('-');
  const body = neg ? text.slice(1) : text;
  const [whole, frac = ''] = body.split('.');
  if (frac.length <= scale) return text;
  const cut = frac.slice(0, scale);
  const next = scale === 0 ? whole! : `${whole}.${cut}`;
  const zero = scale === 0 ? next === '0' : /^0\.0*$/.test(next);
  if (zero) return scale === 0 ? '0' : `0.${'0'.repeat(scale)}`;
  return neg ? `-${next}` : next;
}

function applyQuirks(row: Record<string, unknown>, quirks: RowQuirk): Record<string, unknown> {
  const next: Record<string, unknown> = { ...row };
  for (const [name, max] of Object.entries(quirks.truncate ?? {})) {
    const value = next[name];
    if (typeof value === 'string' && value.length > max) next[name] = value.slice(0, max);
  }
  for (const name of quirks.mangleDates ?? []) {
    const value = next[name];
    if (typeof value === 'string' && /^\d{2}-\d{2}-\d{4}$/.test(value)) next[name] = '0011-04-18';
  }
  for (const [name, scale] of Object.entries(quirks.round ?? {})) {
    const value = next[name];
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (!/^-?\d+(\.\d+)?$/.test(text)) continue;
    const cut = cutScale(text, scale);
    if (cut !== text) next[name] = Number(cut);
  }
  return next;
}

export function quirkRowServer(quirks: RowQuirk = {}): QuirkHandle {
  const posts: Record<string, unknown>[][] = [];
  const puts: Record<string, unknown>[][] = [];
  const stored = new Map<string, Record<string, unknown>>();
  const copies = new Map<string, Record<string, unknown>[]>();
  // ROWIDs are 17 digits, past MAX_SAFE_INTEGER: the counter must be a BigInt or
  // every row gets the same ROWID and no parent-link check can discriminate.
  let nextRowId = 10000000000000001n;
  const remember = (table: string, row: Record<string, unknown>): void => {
    const kept = row.ROWID === undefined ? { ...row, ROWID: String(nextRowId++) } : row;
    const key = `${table}\0${String(kept.c2c_source_id ?? '')}`;
    const list = copies.get(key) ?? [];
    list.push(kept);
    copies.set(key, list);
    if (!stored.has(key)) stored.set(key, kept);
  };
  const rowsFor = (table: string, id: string): Record<string, unknown>[] => copies.get(`${table}\0${id}`) ?? [];
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    if (method === 'POST' && path.endsWith('/query')) {
      const query = String((JSON.parse(init?.body ?? '{}') as { query?: string }).query ?? '');
      const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query)?.[1] ?? '';
      const ids = [...query.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
      const seen = new Set<string>();
      if (/COUNT\s*\(\s*ROWID\s*\)/i.test(query)) {
        let count = 0;
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          count += rowsFor(table, id).length;
        }
        return textResponse(JSON.stringify({ status: 'success', data: [{ [table]: { 'COUNT(ROWID)': String(count) } }] }));
      }
      const rows: Record<string, unknown>[] = [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push(...rowsFor(table, id));
      }
      return textResponse(JSON.stringify({ status: 'success', data: rows }));
    }
    // PUT /row updates stored rows by ROWID, the same quirks applied to the sent cells.
    if (method === 'PUT' && ROW_PATH.test(path)) {
      const sent = JSON.parse(init?.body ?? 'null') as unknown;
      if (!Array.isArray(sent)) return catalystFailure(400, 'INVALID_INPUT', 'row body must be an array');
      const updates = sent as Record<string, unknown>[];
      puts.push(updates);
      const table = decodeURIComponent(path.split('/').at(-2) ?? '');
      const updated: Record<string, unknown>[] = [];
      for (const update of updates) {
        const rowid = String(update.ROWID ?? '');
        // Only the URL's table: a ROWID from another table must not resolve here.
        const inTable = `${table}\0`;
        let found: Record<string, unknown> | undefined;
        for (const [key, list] of copies) {
          if (!key.startsWith(inTable)) continue;
          found = list.find((row) => String(row.ROWID ?? '') === rowid);
          if (found) break;
        }
        if (!found) return catalystFailure(400, 'INVALID_INPUT', `no row for ROWID ${rowid}`);
        const patch = applyQuirks({ ...update }, quirks);
        for (const [name, value] of Object.entries(patch)) if (name !== 'ROWID') found[name] = value;
        updated.push({ ...found });
      }
      if (quirks.errorAfterWrite) return catalystFailure(400, 'INVALID_INPUT', 'For input string: "nu"');
      return catalystRows(updated);
    }
    if (method !== 'POST' || !ROW_PATH.test(path)) {
      if (/\/table\/[^/]+\/rows$/.test(path)) return catalystFailure(404, 'INVALID_URL_PATTERN', 'Please check if the URL trying to access is a correct one');
      return textResponse('{}', 404);
    }
    const sent = JSON.parse(init?.body ?? 'null') as unknown;
    if (!Array.isArray(sent)) return catalystFailure(400, 'INVALID_INPUT', 'row body must be an array');
    const rows = sent as Record<string, unknown>[];
    posts.push(rows);
    const table = decodeURIComponent(path.split('/').at(-2) ?? '');
    const kept = rows.map((row) => applyQuirks(row, quirks));
    for (let i = 0; i < kept.length; i += 1) {
      const row = kept[i]!;
      const id = String(row.c2c_source_id ?? rows[i]?.c2c_source_id ?? '');
      if (!quirks.dropInsert) {
        const stored = quirks.storeDrift ? { ...row, ...quirks.storeDrift } : row;
        remember(table, { ...stored, c2c_source_id: id });
        if (quirks.duplicateInsert) remember(table, { ...stored, c2c_source_id: id });
      }
    }
    if (quirks.errorAfterWrite) return catalystFailure(400, 'INVALID_INPUT', 'For input string: "nu"');
    return catalystRows(kept);
  };
  return { fetch, posts, puts, stored, rowsFor, addStored: remember };
}

export function rowEndpoint(inner: FetchLike): FetchLike {
  return async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    if (method !== 'POST' || !ROW_PATH.test(path)) {
      assert.ok(!/\/table\/[^/]+\/rows$/.test(path), `no write may use the 404 path ${path}`);
      return inner(url, init);
    }
    const sent = JSON.parse(init?.body ?? 'null') as unknown;
    assert.ok(Array.isArray(sent), 'the /row body is a JSON array of rows');
    const rows = sent as Record<string, unknown>[];
    const legacy = { rows: rows.map((row) => ({ id: String(row.c2c_source_id), columns: row })) };
    const answer = await inner(url, { ...init, body: JSON.stringify(legacy) });
    if (answer.status >= 400) return answer;
    const text = await answer.text();
    let body: { ids?: unknown };
    try {
      body = JSON.parse(text) as { ids?: unknown };
    } catch {
      return textResponse(text, answer.status);
    }
    if (!Array.isArray(body.ids)) return textResponse(text, answer.status);
    const byId = new Map(rows.map((row) => [String(row.c2c_source_id), row]));
    return catalystRows(body.ids.map((id) => ({ ...(byId.get(String(id)) ?? {}), c2c_source_id: String(id) })));
  };
}
