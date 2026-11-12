/**
 * Double shadow columns of exact-decimal varchars (`<Field>__n`, schema `shadowFor`).
 *
 * The runtime writes the shadow on every insert and update. A row written before
 * the shadow column existed has a NULL shadow. Criteria still find it (the widened
 * predicate is `(<bound> OR <shadow> IS NULL)` and the exact pass decides), but
 * every such row is read by every decimal criteria on that table, and a windowed
 * decimal sort reads all of them in a second query. Backfill removes that cost.
 *
 * `backfillShadows` sets `<shadow>` = `decimalShadow(<column>)` for rows whose shadow
 * is NULL. It pages by ROWID (keyset, 200 rows: the row update cap), so a row it
 * fills leaves the result and the 30000-row OFFSET cap does not apply. A blank or
 * non-numeric varchar has no shadow; it is skipped and stays NULL. A 429 waits
 * Retry-After (seconds or an HTTP date), else 0.5s doubling to 8s; a Retry-After
 * over 60s, or a fifth 429 in a row, stops the run with the counts so far. Re-running
 * is safe: it only reads rows that are still NULL.
 */
import type { App } from '../../core/src/ir.js';
import { MAX_BATCH, assertAllowedHost, catalystAuthHeaders, catalystQueryUrl, type CatalystScope, type FetchLike, type MigrateResponse } from '../../data/src/migrate.js';
import { generateSchema, type SchemaPlan } from '../../schema/src/generator.js';
import { decimalShadow } from '../../shims/src/criteria.js';
import { jsonReplacer, parseJsonLossless } from '../../shims/src/ids.js';
import { exactId } from './json-exact.js';

export interface ShadowColumn {
  table: string;
  /** The exact-decimal varchar. */
  column: string;
  /** Its Double shadow. */
  shadow: string;
}

/** Every exact-decimal column with a shadow, in schema order. NoSQL tables have none. */
export function shadowColumns(plan: SchemaPlan): ShadowColumn[] {
  const out: ShadowColumn[] = [];
  for (const table of plan.tables) {
    if (table.nosql) continue;
    for (const column of table.columns) if (column.shadowFor) out.push({ table: table.name, column: column.shadowFor, shadow: column.name });
  }
  return out;
}

export function appShadowColumns(app: App): ShadowColumn[] {
  return shadowColumns(generateSchema(app));
}

/** The command that fills NULL shadows. Named by the deploy step and the migrate warning. */
export function backfillCommand(projectId: string, org?: string): string {
  return `c2c deploy <app> --project ${projectId}${org ? ` --org ${org}` : ' --org <org>'} --backfill-shadows --confirm`;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`not a ZCQL identifier: ${name}`);
  return name;
}

/** Rows whose shadow is NULL although the varchar holds a value. */
export function staleShadowCountQuery(c: ShadowColumn): string {
  return `SELECT COUNT(ROWID) FROM ${ident(c.table)} WHERE ${ident(c.shadow)} IS NULL AND ${ident(c.column)} IS NOT NULL`;
}

/** One keyset page of NULL-shadow rows after `after` (a ROWID), ROWID order. */
export function backfillPageQuery(c: ShadowColumn, after: string | undefined, limit: number): string {
  if (after !== undefined && !/^\d+$/.test(after)) throw new Error(`ROWID is not an integer: ${after}`);
  const keyset = after === undefined ? '' : ` AND ROWID > ${after}`;
  return `SELECT ROWID, ${ident(c.column)} FROM ${ident(c.table)} WHERE ${ident(c.shadow)} IS NULL${keyset} ORDER BY ROWID LIMIT ${limit}`;
}

export const BACKFILL_RETRY = { maxRetries: 4, baseDelayMs: 500, maxDelayMs: 8000, maxWaitMs: 60000 };

export class RateLimitError extends Error {
  readonly status = 429;
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/** Retry-After in ms (delta-seconds or an HTTP date), or -1 when absent or unreadable. */
export function retryAfterMs(response: Pick<MigrateResponse, 'headers'>, nowMs: number): number {
  const raw = (response.headers.get('retry-after') ?? '').trim();
  if (!raw) return -1;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : -1;
}

export interface BackfillOptions {
  fetch: FetchLike;
  catalystBase: string;
  dc: string;
  scope: CatalystScope;
  columns: readonly ShadowColumn[];
  /** Rows per page and per update. Clamped to 200. */
  pageSize?: number;
  /** Pause between pages, so a long backfill leaves room for the app's own calls. Default 250ms. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  retry?: Partial<typeof BACKFILL_RETRY>;
  onRetry?: (info: { attempt: number; delay: number }) => void;
}

export interface BackfillResult extends ShadowColumn {
  /** NULL-shadow rows read. */
  scanned: number;
  /** Shadows written. */
  filled: number;
  /** Blank or non-numeric varchars: no shadow, left NULL. */
  skipped: number;
  /** Set when the column stopped early (rate limit, write error). */
  error?: string;
}

export async function backfillShadows(opts: BackfillOptions): Promise<BackfillResult[]> {
  const pageSize = Math.max(1, Math.min(MAX_BATCH, opts.pageSize ?? MAX_BATCH));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const retry = { ...BACKFILL_RETRY, ...opts.retry };
  const pause = opts.pauseMs ?? 250;
  const root = opts.catalystBase.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...catalystAuthHeaders(opts.scope) };

  const send = async (url: string, init: { method: string; body: string }): Promise<string> => {
    assertAllowedHost(url, opts.dc);
    for (let attempt = 0; ; attempt += 1) {
      const response = await opts.fetch(url, { ...init, headers });
      if (response.status !== 429) {
        const text = await response.text();
        if (response.status >= 400) throw new Error(`catalyst ${init.method} failed: ${response.status}`);
        return text;
      }
      await response.text();
      const hinted = retryAfterMs(response, now());
      if (hinted > retry.maxWaitMs) {
        throw new RateLimitError(`rate limited (429); Retry-After asks for ${Math.ceil(hinted / 1000)}s, more than the ${Math.floor(retry.maxWaitMs / 1000)}s max wait`);
      }
      if (attempt >= retry.maxRetries) throw new RateLimitError(`rate limited (429) ${attempt + 1} times in a row`);
      // The server's Retry-After is a floor; only the no-header backoff is capped.
      const delay = hinted >= 0 ? hinted : Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
      opts.onRetry?.({ attempt: attempt + 1, delay });
      await sleep(delay);
    }
  };

  const queryUrl = catalystQueryUrl(root, opts.scope);
  const results: BackfillResult[] = [];
  for (const c of opts.columns) {
    const result: BackfillResult = { ...c, scanned: 0, filled: 0, skipped: 0 };
    results.push(result);
    const updateUrl = `${root}/baas/v1/project/${encodeURIComponent(opts.scope.projectId)}/table/${encodeURIComponent(ident(c.table))}/row`;
    let after: string | undefined;
    try {
      for (let first = true; ; first = false) {
        if (!first && pause > 0) await sleep(pause);
        const text = await send(queryUrl, { method: 'POST', body: JSON.stringify({ query: backfillPageQuery(c, after, pageSize) }) });
        const rows = pageRows(parseJsonLossless(text), c);
        if (rows.length > pageSize) throw new Error(`query for ${c.table} returned ${rows.length} rows; the page size is ${pageSize}`);
        const updates: Record<string, unknown>[] = [];
        for (const row of rows) {
          result.scanned += 1;
          if (after !== undefined && BigInt(row.rowid) <= BigInt(after)) throw new Error(`query for ${c.table} did not page by ROWID`);
          after = row.rowid;
          const shadow = decimalShadow(row.value);
          if (shadow === null) result.skipped += 1;
          else updates.push({ ROWID: row.rowid, [c.shadow]: shadow });
        }
        if (updates.length) {
          await send(updateUrl, { method: 'PUT', body: JSON.stringify(updates, jsonReplacer) });
          result.filled += updates.length;
        }
        if (rows.length < pageSize) break;
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
  }
  return results;
}

/** ROWID and varchar of each row in a ZCQL response. Rows may be wrapped by table name. */
function pageRows(body: unknown, c: ShadowColumn): { rowid: string; value: unknown }[] {
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new Error(`query for ${c.table} returned no data list`);
  return data.map((item) => {
    const wrapped = item && typeof item === 'object' ? (item as Record<string, unknown>)[c.table] : undefined;
    const row = (wrapped && typeof wrapped === 'object' ? wrapped : item) as Record<string, unknown>;
    const rowid = row?.ROWID;
    if (typeof rowid !== 'string' && typeof rowid !== 'number') throw new Error(`query for ${c.table} returned a row without ROWID`);
    return { rowid: exactId(rowid, 'ROWID'), value: row[c.column] };
  });
}

export function formatBackfill(results: readonly BackfillResult[]): string[] {
  if (!results.length) return ['backfill-shadows: no exact-decimal columns'];
  return results.map(
    (r) => `backfill ${r.table}.${r.shadow} from ${r.column}: scanned ${r.scanned} filled ${r.filled} skipped ${r.skipped}${r.error ? ` error ${r.error}` : ''}`,
  );
}
