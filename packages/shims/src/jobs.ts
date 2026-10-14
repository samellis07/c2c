/**
 * Form-schedule sweeper for a Catalyst Job function.
 *
 * A Creator form schedule fires once per record at a time computed from a date
 * field (`start = before 1 days from Due_Date at "09:00:00"`). Catalyst has no
 * per-record trigger, so one Periodic cron runs a sweeper Job per app
 * (jobs run at least 1 min apart). Each run:
 *
 * - reads its checkpoint: the watermark (last instant fully swept) and, after a
 *   run that stopped early, the pending window end and the ROWID cursor;
 * - pages ZCQL 300 rows at a time (`ROWID > cursor ORDER BY ROWID`), narrowed by
 *   a date window on the field, the end field and the schedule criteria;
 * - fires every row whose fire instant lies in (watermark, until];
 * - saves the cursor after each page and the watermark after the window ends.
 *
 * A run that reaches its deadline saves the cursor and stops. The next tick
 * resumes the same window, so no row fires twice across runs. A crash inside a
 * page can refire the rows of that page (at-least-once per page).
 *
 * A first run with no checkpoint looks back one period. It does not backfill.
 * A repeating schedule that has several occurrences in one window fires once.
 *
 * This module never calls the network. `query`, `checkpoints` and `fire` are
 * injected by the generated Job function, and only in live deploy mode.
 */
import { DelugeDate, addDays, addMonths, asDate, epochMillis, partsInZone } from './date.js';
import { compileCriteria, type Criteria } from './criteria.js';

export const SWEEP_PAGE_ROWS = 300;

export type OffsetUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years';
export type Repeat = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface FormScheduleSpec {
  /** Checkpoint key. Unique per app. */
  name: string;
  form: string;
  field: string;
  fieldType: 'Date' | 'DateTime';
  /** Signed: `before 2 days` is -2 days. */
  offset: { amount: number; unit: OffsetUnit };
  /** `at "HH:mm:ss"`: the wall time of the fire date. */
  at?: string;
  repeat?: Repeat;
  /** Field holding the last date a repeating schedule fires. */
  end?: string;
  criteria?: Criteria;
  timeZone: string;
}

export interface SweepCheckpoint {
  watermark: number;
  pending?: { until: number; cursor: string };
}

export interface CheckpointStore {
  get(key: string): Promise<SweepCheckpoint | undefined>;
  put(key: string, value: SweepCheckpoint): Promise<void>;
}

type Row = Record<string, unknown>;

export interface SweepOptions {
  schedules: readonly FormScheduleSpec[];
  query(form: string, where: string, limit: number, offset: number, orderBy: string): Promise<Row[]>;
  checkpoints: CheckpointStore;
  /** Epoch ms of this run. */
  now: number;
  /** Lookback of a run with no checkpoint: one cron period. */
  periodMs: number;
  /** Epoch ms after which no new page starts. */
  deadline: number;
  /**
   * The clock the deadline is checked against. Defaults to the run's own
   * clock: `now` plus the wall time elapsed since the call, so an injected
   * `now` never compares against a different clock's epoch.
   */
  clock?: () => number;
  fire(spec: FormScheduleSpec, row: Row): Promise<unknown>;
}

export interface SweepScheduleReport {
  name: string;
  from: number;
  until: number;
  pages: number;
  fired: number;
  done: boolean;
}

export interface SweepReport {
  done: boolean;
  schedules: SweepScheduleReport[];
}

const MS: Partial<Record<OffsetUnit, number>> = { minutes: 60_000, hours: 3_600_000 };
const DAY_MS = 86_400_000;

function calendarShift(value: DelugeDate, amount: number, unit: OffsetUnit): DelugeDate {
  if (unit === 'days') return addDays(value, amount);
  if (unit === 'weeks') return addDays(value, amount * 7);
  if (unit === 'months') return addMonths(value, amount);
  if (unit === 'years') return addMonths(value, amount * 12);
  return value;
}

function withTime(value: DelugeDate, at: string | undefined): DelugeDate {
  if (!at) return value;
  const [hh, mm, ss] = at.split(':').map(Number);
  return new DelugeDate(value.y, value.m, value.d, hh ?? 0, mm ?? 0, ss ?? 0);
}

function repeatShift(value: DelugeDate, repeat: Repeat, k: number): DelugeDate {
  if (repeat === 'daily') return addDays(value, k);
  if (repeat === 'weekly') return addDays(value, 7 * k);
  if (repeat === 'monthly') return addMonths(value, k);
  return addMonths(value, 12 * k);
}

const REPEAT_MS: Record<Repeat, number> = { daily: DAY_MS, weekly: 7 * DAY_MS, monthly: 28 * DAY_MS, yearly: 365 * DAY_MS };

/** The first fire instant of a row, or null when the field is blank or not a date. */
export function fireInstant(spec: FormScheduleSpec, row: Row): number | null {
  let base: DelugeDate | null;
  try {
    base = asDate(row[spec.field]);
  } catch {
    return null;
  }
  if (!base) return null;
  if (spec.fieldType === 'Date') base = new DelugeDate(base.y, base.m, base.d);
  const shifted = withTime(calendarShift(base, spec.offset.amount, spec.offset.unit), spec.at);
  return epochMillis(shifted, spec.timeZone) + spec.offset.amount * (MS[spec.offset.unit] ?? 0);
}

/** True when the row has a fire instant in (from, until]. */
export function firesIn(spec: FormScheduleSpec, row: Row, from: number, until: number): boolean {
  const first = fireInstant(spec, row);
  if (first === null) return false;
  if (!spec.repeat) return first > from && first <= until;
  if (first > until) return false;
  let endDay: number | null = null;
  if (spec.end) {
    let end: DelugeDate | null = null;
    try {
      end = asDate(row[spec.end]);
    } catch {
      return false;
    }
    if (end) endDay = end.epochDay();
  }
  const start = new DelugeDate(...wall(first, spec.timeZone));
  let k = Math.max(0, Math.floor((from - first) / REPEAT_MS[spec.repeat]) - 2);
  for (let guard = 0; guard < 400; guard++, k++) {
    const occurrence = repeatShift(start, spec.repeat, k);
    if (endDay !== null && occurrence.epochDay() > endDay) return false;
    const at = epochMillis(occurrence, spec.timeZone);
    if (at > until) return false;
    if (at > from) return true;
  }
  return false;
}

function wall(instant: number, zone: string): [number, number, number, number, number, number] {
  const p = partsInZone(new Date(instant), zone);
  return [p.y, p.m, p.d, p.hh, p.mm, p.ss];
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function literal(value: DelugeDate, type: 'Date' | 'DateTime', endOfDay: boolean): string {
  const day = `${value.y}-${pad(value.m)}-${pad(value.d)}`;
  if (type === 'Date') return `'${day}'`;
  return endOfDay ? `'${day} 23:59:59'` : `'${day} 00:00:00'`;
}

/** The field date a fire instant came from, two days of slack each side (time of day, zone). */
function fieldDay(instant: number, spec: FormScheduleSpec, slack: number): DelugeDate {
  const back = instant - spec.offset.amount * (MS[spec.offset.unit] ?? 0);
  const day = new DelugeDate(...wall(back, spec.timeZone).slice(0, 3) as [number, number, number]);
  return addDays(calendarShift(day, -spec.offset.amount, spec.offset.unit), slack);
}

/** The ZCQL WHERE of one page. Exact firing is decided by {@link firesIn}. */
export function sweepWhere(spec: FormScheduleSpec, from: number, until: number, cursor: string): string {
  const parts: string[] = [];
  const hi = literal(fieldDay(until, spec, 2), spec.fieldType, true);
  if (spec.repeat) {
    parts.push(`${spec.field} <= ${hi}`);
    if (spec.end) parts.push(`(${spec.end} IS NULL OR ${spec.end} >= ${literal(fieldDay(from, spec, -2), 'Date', false)})`);
  } else {
    parts.push(`${spec.field} >= ${literal(fieldDay(from, spec, -2), spec.fieldType, false)}`, `${spec.field} <= ${hi}`);
  }
  if (spec.criteria && spec.criteria.op !== 'true') parts.push(`(${compileCriteria(spec.criteria)})`);
  if (cursor) parts.push(`ROWID > ${cursor}`);
  return parts.join(' AND ');
}

/** Sweep every form schedule once. Stops at the deadline with the cursor saved. */
export async function sweepFormSchedules(opts: SweepOptions): Promise<SweepReport> {
  const started = Date.now();
  const clock = opts.clock ?? (() => opts.now + (Date.now() - started));
  const report: SweepReport = { done: true, schedules: [] };
  for (const spec of opts.schedules) {
    const saved = await opts.checkpoints.get(spec.name);
    const from = saved ? saved.watermark : opts.now - opts.periodMs;
    const until = saved?.pending ? saved.pending.until : opts.now;
    let cursor = saved?.pending ? saved.pending.cursor : '';
    const item: SweepScheduleReport = { name: spec.name, from, until, pages: 0, fired: 0, done: false };
    report.schedules.push(item);
    for (;;) {
      if (clock() >= opts.deadline) {
        await opts.checkpoints.put(spec.name, { watermark: from, pending: { until, cursor } });
        report.done = false;
        break;
      }
      const page = await opts.query(spec.form, sweepWhere(spec, from, until, cursor), SWEEP_PAGE_ROWS, 0, 'ORDER BY ROWID');
      item.pages++;
      for (const row of page) {
        if (!firesIn(spec, row, from, until)) continue;
        await opts.fire(spec, row);
        item.fired++;
      }
      if (page.length < SWEEP_PAGE_ROWS) {
        await opts.checkpoints.put(spec.name, { watermark: until });
        item.done = true;
        break;
      }
      cursor = String(page[page.length - 1]!.ROWID);
      await opts.checkpoints.put(spec.name, { watermark: from, pending: { until, cursor } });
    }
    if (!item.done) break;
  }
  return report;
}

/**
 * Checkpoints in a Data Store table (`Job_Key` varchar, `State` text JSON).
 * The deploy creates the table from job-scheduling.json. A missing table makes
 * the read throw, so the sweep fails before it fires anything.
 */
export function datastoreCheckpoints(
  datastore: {
    query(form: string, where: string, limit: number, offset: number, orderBy: string): Promise<Row[]>;
    insert(form: string, rows: Row[]): Promise<unknown>;
    update(form: string, rows: Row[]): Promise<unknown>;
  },
  table: string,
): CheckpointStore {
  const rowOf = async (key: string) => (await datastore.query(table, `Job_Key = '${key.replace(/'/g, "''")}'`, 1, 0, 'ORDER BY ROWID'))[0];
  return {
    async get(key) {
      const row = await rowOf(key);
      return row && typeof row.State === 'string' ? (JSON.parse(row.State) as SweepCheckpoint) : undefined;
    },
    async put(key, value) {
      const row = await rowOf(key);
      const State = JSON.stringify(value);
      if (row) await datastore.update(table, [{ ROWID: row.ROWID, State }]);
      else await datastore.insert(table, [{ Job_Key: key, State }]);
    },
  };
}
