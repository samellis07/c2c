/**
 * ZCQL UPDATE and DELETE past the 300-row statement cap.
 *
 * One ZCQL `UPDATE … WHERE` or `DELETE FROM … WHERE` changes at most 300 rows
 * and says nothing about the rest: on 400 matching rows it touches 300 and
 * returns no error. A statement is therefore repeated, with a COUNT re-query
 * after each round, until no row matches. The loop is bounded twice:
 *
 * - by rounds: ceil(matches / 300) + 2 unless the caller sets `maxRounds`;
 * - by progress: a round that leaves as many matching rows as before throws.
 *   An UPDATE whose SET does not take the row out of its WHERE (`SET Status =
 *   'Open' WHERE Status = 'Open'`) would otherwise loop forever.
 *
 * A caller that knows how many rows it meant to change passes `expected`; a
 * different first count throws before any statement runs.
 *
 * Bulk work in generated code pages by ROWID and uses updateRows/deleteRows
 * instead (runtime.ts). This is for statements that must stay ZCQL.
 */
import { LIMITS } from './runtime.js';

export const ZCQL_DML_ROW_CAP = LIMITS.zcqlRowsPerQuery;

export type Zcql = (sql: string) => Promise<unknown>;

export class BulkDmlError extends Error {
  constructor(
    message: string,
    readonly remaining: number,
  ) {
    super(message);
    this.name = 'BulkDmlError';
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The number from a `SELECT COUNT(ROWID)` reply, wrapped by table name or not. */
export function zcqlCount(body: unknown): number {
  const rows = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : [];
  for (const row of rows) {
    const cells: Record<string, unknown>[] = [];
    if (row && typeof row === 'object') {
      cells.push(row as Record<string, unknown>);
      for (const inner of Object.values(row as Record<string, unknown>)) if (inner && typeof inner === 'object') cells.push(inner as Record<string, unknown>);
    }
    for (const cell of cells) {
      for (const [key, value] of Object.entries(cell)) {
        if (!/^count/i.test(key)) continue;
        const n = typeof value === 'number' ? value : Number(value);
        if (Number.isInteger(n) && n >= 0) return n;
      }
    }
  }
  throw new Error('COUNT reply has no count');
}

export interface BulkDmlResult {
  /** Rows that matched before the first statement. */
  matched: number;
  rounds: number;
}

async function run(opts: { zcql: Zcql; table: string; where: string; statement: string; expected?: number; maxRounds?: number }): Promise<BulkDmlResult> {
  if (!IDENT.test(opts.table)) throw new Error(`table name is not a ZCQL identifier: ${opts.table}`);
  if (!opts.where.trim()) throw new Error('a bulk ZCQL statement needs a WHERE clause');
  const count = async (): Promise<number> => zcqlCount(await opts.zcql(`SELECT COUNT(ROWID) FROM ${opts.table} WHERE ${opts.where}`));
  const matched = await count();
  if (opts.expected !== undefined && matched !== opts.expected) {
    throw new BulkDmlError(`${opts.table}: ${matched} row(s) match, expected ${opts.expected}; nothing changed`, matched);
  }
  const bound = opts.maxRounds ?? Math.ceil(matched / ZCQL_DML_ROW_CAP) + 2;
  let remaining = matched;
  let rounds = 0;
  while (remaining > 0) {
    if (rounds >= bound) throw new BulkDmlError(`${opts.table}: ${remaining} row(s) still match after ${rounds} round(s)`, remaining);
    await opts.zcql(opts.statement);
    rounds += 1;
    const next = await count();
    if (next >= remaining) {
      throw new BulkDmlError(`${opts.table}: a round left ${next} matching row(s) (was ${remaining}); the statement does not take rows out of its WHERE`, next);
    }
    remaining = next;
  }
  return { matched, rounds };
}

/** `UPDATE <table> SET <set> WHERE <where>` until no row matches `where`. */
export function updateAllWhere(opts: { zcql: Zcql; table: string; set: string; where: string; expected?: number; maxRounds?: number }): Promise<BulkDmlResult> {
  if (!opts.set.trim()) throw new Error('UPDATE needs a SET clause');
  return run({ ...opts, statement: `UPDATE ${opts.table} SET ${opts.set} WHERE ${opts.where}` });
}

/** `DELETE FROM <table> WHERE <where>` until no row matches. */
export function deleteAllWhere(opts: { zcql: Zcql; table: string; where: string; expected?: number; maxRounds?: number }): Promise<BulkDmlResult> {
  return run({ ...opts, statement: `DELETE FROM ${opts.table} WHERE ${opts.where}` });
}
