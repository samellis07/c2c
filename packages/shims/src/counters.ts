/**
 * Concurrency-safe counters over the Catalyst Data Store: autonumber
 * fields and `+n` updates of a counter column (stock counts and the same).
 *
 * The Data Store has no atomic increment and no conditional update: a
 * read-add-write loses an update when two requests interleave, and a
 * "max + 1" autonumber hands two inserts the same number. Both use one
 * claim table instead, `c2c_seq_claim`:
 *
 *   claim_key varchar unique   `<seq>:<n>`
 *   seq_name  varchar          the sequence (`Form.Field`, or `Form.Field#<ROWID>`)
 *   n         bigint           the claimed number or counter version
 *   value     varchar          counter value at version n (autonumber: n)
 *   owner     varchar          request id of the claimant
 *
 * A claim is an insert. The unique `claim_key` lets one claimant per number
 * win; the loser gets `DUPLICATE_VALUE` and moves on. When the store admits
 * two rows for one key, the claim with the lowest ROWID wins and the other
 * claimant deletes its row and retries. A claimant that keeps losing gives
 * up with {@link CounterContention}; the write is not made.
 *
 * Autonumber: the next number is one past the highest claim (or the start
 * index). A gap is possible (a claimed number whose record write then
 * fails); a duplicate is not.
 *
 * Counter column: version n of `Form.Field#<ROWID>` holds the value after
 * the n-th write. An increment claims version n+1 with value(n) + delta; the
 * first claim starts from the stored row. The record column is a projection
 * of the latest claim: each writer stores its value, re-reads the latest
 * claim and stores that until the two agree, so the last write always
 * leaves the latest value. Every write of a counter column must go through
 * {@link incrementCounter} or {@link setCounter}; a plain update is
 * overwritten by the next claim. A record that does not settle on the latest
 * claim within the attempt limit fails the write with
 * {@link CounterContention}.
 *
 * Fail closed: a claim whose verify read fails is deleted before the error
 * is thrown, so a failed increment leaves no version behind. The store must
 * offer `delete`; the protocol refuses to run without it rather than leave
 * losing claims in the table.
 *
 * Residual race: a claimant whose verify read ran before a lower-ROWID claim
 * of the same key became visible also believes it won. That needs the store
 * to show a row to one reader and hide it from another for the length of a
 * write. Likewise a claim deleted after a failed verify may already have
 * been read by the next claimant, which then builds on it. An audit pass
 * that compares claims and records and reports such duplicates is planned; until then, counters stay opt-in per form.
 */
import { classifyStoreError, newRequestId } from './store-errors.js';

export const CLAIM_TABLE = 'c2c_seq_claim';
export const DEFAULT_MAX_ATTEMPTS = 64;

/** The Data Store calls the protocol needs (the runtime datastore adapter shape). */
export interface CounterStore {
  insert(table: string, rows: Record<string, unknown>[]): Promise<unknown>;
  query(table: string, zcqlWhere: string, limit: number, offset?: number, orderBy?: string): Promise<Record<string, unknown>[]>;
  update(table: string, rows: Record<string, unknown>[]): Promise<unknown>;
  delete(table: string, rowIds: readonly unknown[]): Promise<unknown>;
}

export interface CounterOptions {
  /** Claim attempts before {@link CounterContention}. Default {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Request id stored as the claim owner. Default: a fresh random id. */
  owner?: string;
  /** Pause before retry `attempt` (1-based). Default: jittered backoff up to 100 ms. */
  wait?: (attempt: number) => Promise<void>;
}

/** A claimant lost every attempt, or its record never settled. Fail closed: the write failed. */
export class CounterContention extends Error {
  readonly code = 'COUNTER_CONTENTION';
  constructor(readonly seq: string, readonly attempts: number, detail?: string) {
    super(detail ?? `counter ${seq}: no number claimed after ${attempts} attempts; the write was not made`);
    this.name = 'CounterContention';
  }
}

/** A counter column holds something that is not a whole number. */
export class CounterValueError extends Error {
  readonly code = 'COUNTER_VALUE';
  constructor(readonly seq: string) {
    super(`counter ${seq}: the stored value is not a whole number`);
    this.name = 'CounterValueError';
  }
}

interface Claim {
  rowId: string;
  n: bigint;
  value: string;
}

function quote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function wholeNumber(value: unknown, seq: string): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new CounterValueError(seq);
}

function rowIdOf(row: Record<string, unknown>): string {
  const id = row.ROWID ?? row.rowid;
  return id === undefined || id === null ? '' : String(id);
}

function lowerRowId(a: string, b: string): boolean {
  return a.length !== b.length ? a.length < b.length : a < b;
}

function defaultWait(attempt: number): Promise<void> {
  const ceiling = Math.min(100, 5 * 2 ** Math.min(attempt, 5));
  return new Promise((done) => setTimeout(done, Math.random() * ceiling));
}

/** Sequence name of an autonumber field. */
export function autonumberSeq(form: string, field: string): string {
  return `${form}.${field}`;
}

/** Sequence name of one record's counter column. */
export function counterSeq(form: string, field: string, rowId: string): string {
  return `${form}.${field}#${rowId}`;
}

/** The highest claim of `seq` (lowest ROWID among equal numbers), or null. */
async function latestClaim(store: CounterStore, seq: string): Promise<Claim | null> {
  const rows = await store.query(CLAIM_TABLE, `seq_name = ${quote(seq)}`, 1, 0, 'ORDER BY n DESC, ROWID');
  const row = rows[0];
  if (!row) return null;
  return { rowId: rowIdOf(row), n: BigInt(String(row.n)), value: String(row.value ?? '') };
}

/**
 * Insert the claim for number `n` of `seq`. True when this claimant holds it:
 * the insert was accepted and no claim with a lower ROWID shares the key.
 */
async function claim(store: CounterStore, seq: string, n: bigint, value: string, owner: string): Promise<boolean> {
  const key = `${seq}:${n}`;
  let inserted: unknown;
  try {
    inserted = await store.insert(CLAIM_TABLE, [{ claim_key: key, seq_name: seq, n: n.toString(), value, owner }]);
  } catch (err) {
    if (classifyStoreError(err)?.code === 'DUPLICATE_VALUE') return false;
    throw err;
  }
  const returned = Array.isArray(inserted) && inserted[0] && typeof inserted[0] === 'object' ? rowIdOf(inserted[0] as Record<string, unknown>) : '';
  let holders: Record<string, unknown>[];
  try {
    holders = await store.query(CLAIM_TABLE, `claim_key = ${quote(key)}`, 300, 0, 'ORDER BY ROWID');
  } catch (err) {
    // Unverified: remove the claim so the failed write has no effect.
    await release(store, key, owner, returned, err);
    throw err;
  }
  const own = holders.filter((row) => String(row.owner ?? '') === owner).map(rowIdOf);
  const mine = returned || own[0];
  let winner = '';
  for (const row of holders) {
    const id = rowIdOf(row);
    if (id && (!winner || lowerRowId(id, winner))) winner = id;
  }
  if (mine && winner === mine) return true;
  if (mine) await store.delete(CLAIM_TABLE, [mine]);
  return false;
}

/** Delete this claimant's row of `key`. A row that cannot be deleted is named in the thrown error. */
async function release(store: CounterStore, key: string, owner: string, rowId: string, cause: unknown): Promise<void> {
  try {
    let ids = rowId ? [rowId] : [];
    if (!ids.length) {
      const rows = await store.query(CLAIM_TABLE, `claim_key = ${quote(key)}`, 300, 0, 'ORDER BY ROWID');
      ids = rows.filter((row) => String(row.owner ?? '') === owner).map(rowIdOf).filter(Boolean);
    }
    if (ids.length) await store.delete(CLAIM_TABLE, ids);
  } catch {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`counter claim ${key}: the verify read failed (${reason}) and the claim could not be removed; it may still stand`, { cause });
  }
}

function requireDelete(store: CounterStore, seq: string): void {
  if (typeof store.delete !== 'function') {
    throw new Error(`counter ${seq}: the datastore adapter has no delete; a losing claim could not be removed`);
  }
}

async function retrying<T>(seq: string, opts: CounterOptions, step: (owner: string) => Promise<T | undefined>): Promise<T> {
  const max = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const wait = opts.wait ?? defaultWait;
  const owner = opts.owner ?? newRequestId();
  for (let attempt = 1; attempt <= max; attempt++) {
    const got = await step(owner);
    if (got !== undefined) return got;
    if (attempt < max) await wait(attempt);
  }
  throw new CounterContention(seq, max);
}

/**
 * Claim the next autonumber of `form.field`. `start` is the first number
 * (the field's start index). Returns the number; it is never handed to a
 * second caller.
 */
export async function nextAutonumber(
  store: CounterStore,
  form: string,
  field: string,
  start: bigint | number = 1,
  opts: CounterOptions = {},
): Promise<bigint> {
  const seq = autonumberSeq(form, field);
  requireDelete(store, seq);
  const first = BigInt(start);
  return retrying(seq, opts, async (owner) => {
    const latest = await latestClaim(store, seq);
    const n = latest && latest.n >= first ? latest.n + 1n : first;
    return (await claim(store, seq, n, n.toString(), owner)) ? n : undefined;
  });
}

async function readRowValue(store: CounterStore, form: string, field: string, rowId: string, seq: string): Promise<bigint> {
  if (!/^\d+$/.test(rowId)) throw new Error(`counter ${seq}: ROWID must be digits`);
  const rows = await store.query(form, `ROWID = ${rowId}`, 1, 0, 'ORDER BY ROWID');
  if (!rows[0]) throw new Error(`counter ${seq}: row ${rowId} not found`);
  return wholeNumber(rows[0][field], seq);
}

/** Store the latest claimed value on the record until a re-read agrees; fail when it never does. */
async function project(store: CounterStore, form: string, field: string, rowId: string, seq: string, value: string, opts: CounterOptions): Promise<void> {
  const max = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let written = value;
  for (let round = 0; round < max; round++) {
    await store.update(form, [{ ROWID: rowId, [field]: written }]);
    const latest = await latestClaim(store, seq);
    if (!latest || latest.value === written) return;
    written = latest.value;
  }
  throw new CounterContention(seq, max, `counter ${seq}: the record did not settle on the latest claim after ${max} rounds`);
}

async function versioned(
  store: CounterStore,
  form: string,
  field: string,
  rowId: string,
  next: (current: bigint) => bigint,
  opts: CounterOptions,
): Promise<bigint> {
  const id = String(rowId);
  const seq = counterSeq(form, field, id);
  requireDelete(store, seq);
  const value = await retrying(seq, opts, async (owner) => {
    const latest = await latestClaim(store, seq);
    const current = latest ? wholeNumber(latest.value, seq) : await readRowValue(store, form, field, id, seq);
    const version = latest ? latest.n + 1n : 1n;
    const result = next(current);
    return (await claim(store, seq, version, result.toString(), owner)) ? result : undefined;
  });
  await project(store, form, field, id, seq, value.toString(), opts);
  return value;
}

/**
 * Add `delta` to the counter column `form.field` of row `rowId`. No
 * concurrent increment is lost. Returns the value after this increment.
 */
export function incrementCounter(
  store: CounterStore,
  form: string,
  field: string,
  rowId: string,
  delta: bigint | number,
  opts: CounterOptions = {},
): Promise<bigint> {
  const by = BigInt(delta);
  return versioned(store, form, field, rowId, (current) => current + by, opts);
}

/** Set the counter column to `value` as one more version, so later increments start from it. */
export function setCounter(
  store: CounterStore,
  form: string,
  field: string,
  rowId: string,
  value: unknown,
  opts: CounterOptions = {},
): Promise<bigint> {
  const target = wholeNumber(value, counterSeq(form, field, String(rowId)));
  return versioned(store, form, field, rowId, () => target, opts);
}

/** Whole-number difference `after - before` of a counter column, for a script's read-modify-write. */
export function counterDelta(before: unknown, after: unknown, seq: string): bigint {
  return wholeNumber(after, seq) - wholeNumber(before, seq);
}
