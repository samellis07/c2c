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
 * - saves the cursor after each page and the watermark after the window ends;
 * - after firing a row, marks its due occurrences in `fired` (per schedule +
 *   ROWID + record fingerprint), so a crash inside a page resumes without
 *   refiring the rows already fired and a reused ROWID never matches a stale
 *   mark. Only a crash between a fire and its mark can refire that one row.
 *   Once a window is fully swept its marks are pruned, so they stay bounded.
 *
 * A run that reaches its deadline saves the cursor and stops. The next tick
 * resumes the same window, so no row fires twice across runs.
 *
 * A first run with no checkpoint looks back one period. It does not backfill.
 * A repeating schedule that has several occurrences in one window fires once.
 *
 * This module never calls the network. `query`, `checkpoints` and `fire` are
 * injected by the generated Job function, and only in live deploy mode.
 */
import { DelugeDate, NonexistentLocalTime, addDays, addMonths, asDate, epochMillis, partsInZone } from './date.js';
import { compileCriteria, exactFilter, type Criteria, type DecimalColumns } from './criteria.js';

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
  decimalColumns?: DecimalColumns;
}

export interface SweepCheckpoint {
  watermark: number;
  pending?: { until: number; cursor: string };
}

export interface CheckpointStore {
  get(key: string): Promise<SweepCheckpoint | undefined>;
  put(key: string, value: SweepCheckpoint): Promise<void>;
}

/**
 * The occurrence instants a schedule already fired for one record, plus the
 * record fingerprint they belong to. Keyed by `fired|<schedule>|<ROWID>`
 * inside the same table as the checkpoints, so a crash mid-page resumes
 * without refiring the rows it fired. Data Store can reuse the ROWID of a
 * deleted record; the fingerprint keeps a stale mark from matching the new
 * record, and {@link FiredMarks.prune} drops marks the moment their window
 * is fully swept or their record is gone, so the marks stay bounded.
 */
export interface FiredMark {
  /** Identity of the record the instants belong to (see {@link recordFingerprint}). */
  record: string;
  instants: number[];
}

export interface FiredMarks {
  get(key: string): Promise<FiredMark | undefined>;
  put(key: string, mark: FiredMark): Promise<void>;
  /**
   * Drop a schedule's marks that can never matter again: every stored
   * instant at or before `horizon` (a completed window's end), and every
   * mark whose record ROWID is no longer in the form (`exists` answers the
   * ids that survive). Optional; a store without it keeps marks until the
   * same record overwrites them.
   */
  prune?(schedule: string, horizon: number, exists: (rowIds: string[]) => Promise<Set<string>>): Promise<void>;
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
  /**
   * Per-record fired marks (see {@link FiredMarks}). With it, a resumed page
   * skips the rows already fired; without it a crash mid-page can refire that
   * page's rows. A row without a ROWID cannot be marked and fires untracked.
   */
  fired?: FiredMarks;
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

function addWallMinutes(value: DelugeDate, minutes: number): DelugeDate {
  const t = new Date(Date.UTC(value.y, value.m - 1, value.d, value.hh, value.mm + minutes, value.ss));
  return new DelugeDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds());
}

/**
 * The instant of a wall time in the schedule's zone. A wall time inside a
 * spring-forward gap never exists (02:30 on the day the clock jumps to
 * 03:00); the occurrence fires at the first real instant after the gap, so
 * the schedule still fires once that day instead of crashing or skipping.
 * A wall time in a fall-back overlap resolves to the earlier instant
 * (epochMillis keeps the first match), so it fires once, not twice.
 */
function zoneInstant(value: DelugeDate, timeZone: string): number {
  for (let minutes = 0; ; minutes++) {
    try {
      return epochMillis(minutes === 0 ? value : addWallMinutes(value, minutes), timeZone);
    } catch (err) {
      if (!(err instanceof NonexistentLocalTime) || minutes >= 180) throw err;
    }
  }
}

/** The wall time a row fires at, or null when the field is blank or not a date. */
function fireWall(spec: FormScheduleSpec, row: Row): DelugeDate | null {
  let base: DelugeDate | null;
  try {
    base = asDate(row[spec.field]);
  } catch {
    return null;
  }
  if (!base) return null;
  if (spec.fieldType === 'Date') base = new DelugeDate(base.y, base.m, base.d);
  return withTime(calendarShift(base, spec.offset.amount, spec.offset.unit), spec.at);
}

/** The first fire instant of a row, or null when the field is blank or not a date. */
export function fireInstant(spec: FormScheduleSpec, row: Row): number | null {
  const shifted = fireWall(spec, row);
  if (!shifted) return null;
  return zoneInstant(shifted, spec.timeZone) + spec.offset.amount * (MS[spec.offset.unit] ?? 0);
}

/**
 * Every occurrence instant of the row in (from, until]: one for a one-shot,
 * all due occurrences of a repeat. Empty when the field is blank or nothing
 * is due. The sweep fires a due row once and marks every returned instant.
 */
export function dueInstants(spec: FormScheduleSpec, row: Row, from: number, until: number): number[] {
  const firstWall = fireWall(spec, row);
  if (!firstWall) return [];
  const first = zoneInstant(firstWall, spec.timeZone) + spec.offset.amount * (MS[spec.offset.unit] ?? 0);
  if (first > until) return [];
  if (!spec.repeat) return first > from ? [first] : [];
  let endDay: number | null = null;
  if (spec.end) {
    let end: DelugeDate | null = null;
    try {
      end = asDate(row[spec.end]);
    } catch {
      return [];
    }
    if (end) endDay = end.epochDay();
  }
  // The repeat anchors on the configured wall time. Anchoring on the first
  // resolved instant would drift a gap-shifted day (02:30 -> 03:00) onto
  // every later occurrence; minute/hour offsets keep the instant-shifted
  // wall of the first occurrence.
  const start = MS[spec.offset.unit] === undefined ? firstWall : new DelugeDate(...wall(first, spec.timeZone));
  const out: number[] = [];
  let k = Math.max(0, Math.floor((from - first) / REPEAT_MS[spec.repeat]) - 2);
  for (let guard = 0; guard < 400; guard++, k++) {
    const occurrence = repeatShift(start, spec.repeat, k);
    if (endDay !== null && occurrence.epochDay() > endDay) break;
    const at = zoneInstant(occurrence, spec.timeZone);
    if (at > until) break;
    if (at > from) out.push(at);
  }
  return out;
}

/** True when the row has a fire instant in (from, until]. */
export function firesIn(spec: FormScheduleSpec, row: Row, from: number, until: number): boolean {
  return dueInstants(spec, row, from, until).length > 0;
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
  if (spec.criteria && spec.criteria.op !== 'true') parts.push(`(${compileCriteria(spec.criteria, undefined, spec.decimalColumns)})`);
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
    const exact = spec.criteria && spec.decimalColumns ? exactFilter(spec.criteria, spec.decimalColumns) : null;
    for (;;) {
      if (clock() >= opts.deadline) {
        await opts.checkpoints.put(spec.name, { watermark: from, pending: { until, cursor } });
        report.done = false;
        break;
      }
      const page = await opts.query(spec.form, sweepWhere(spec, from, until, cursor), SWEEP_PAGE_ROWS, 0, 'ORDER BY ROWID');
      item.pages++;
      for (const row of page) {
        const due = dueInstants(spec, row, from, until);
        if (!due.length) continue;
        if (exact && !exact(row)) continue;
        if (opts.fired && row.ROWID != null) {
          const key = `${spec.name}|${row.ROWID}`;
          const record = recordFingerprint(spec, row);
          const done = await opts.fired.get(key);
          const seen = done && done.record === record ? done.instants : [];
          if (seen.length && due.every((instant) => seen.includes(instant))) continue;
          await opts.fire(spec, row);
          const instants = [...new Set([...seen, ...due])].filter((instant) => instant > from).sort((a, b) => a - b);
          await opts.fired.put(key, { record, instants });
        } else {
          await opts.fire(spec, row);
        }
        item.fired++;
      }
      if (page.length < SWEEP_PAGE_ROWS) {
        await opts.checkpoints.put(spec.name, { watermark: until });
        item.done = true;
        // The window is fully swept: no mark can match a future window, so
        // drop them all, plus marks whose record was deleted. Bounded by the
        // marks of this schedule only.
        await opts.fired?.prune?.(spec.name, until, async (rowIds) => {
          if (!rowIds.length) return new Set<string>();
          const rows = await opts.query(spec.form, `ROWID IN (${rowIds.join(', ')})`, rowIds.length, 0, 'ORDER BY ROWID');
          return new Set(rows.map((row) => String(row.ROWID)));
        });
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

/**
 * The record identity a fired mark is valid for: the record's created time
 * when the row carries one, else the schedule-field values that produced the
 * instants. A deleted record's mark never matches a new record that reuses
 * its ROWID with a different created time. A row without either identity can
 * only be told apart by those field values.
 */
export function recordFingerprint(spec: FormScheduleSpec, row: Row): string {
  const created = row.CREATEDTIME ?? row.Created_Time ?? row.Added_Time;
  if (created != null && created !== '') return `created:${String(created)}`;
  return `fields:${JSON.stringify([row[spec.field] ?? null, spec.end ? row[spec.end] ?? null : null])}`;
}

/**
 * Fired marks in the same Data Store table as the checkpoints, under
 * `fired|<schedule>|<ROWID>` keys (`State` holds a {@link FiredMark}).
 * Cron names never contain `|`, so a mark cannot collide with a checkpoint.
 */
export function datastoreFiredMarks(
  datastore: {
    query(form: string, where: string, limit: number, offset: number, orderBy: string): Promise<Row[]>;
    insert(form: string, rows: Row[]): Promise<unknown>;
    update(form: string, rows: Row[]): Promise<unknown>;
    delete?(form: string, rowIds: readonly unknown[]): Promise<unknown>;
  },
  table: string,
): FiredMarks {
  const rowOf = async (key: string) => (await datastore.query(table, `Job_Key = '${`fired|${key}`.replace(/'/g, "''")}'`, 1, 0, 'ORDER BY ROWID'))[0];
  return {
    async get(key) {
      const row = await rowOf(key);
      if (!row || typeof row.State !== 'string') return undefined;
      const state = JSON.parse(row.State) as { record?: unknown; instants?: unknown };
      return {
        record: typeof state.record === 'string' ? state.record : '',
        instants: Array.isArray(state.instants) ? (state.instants as number[]) : [],
      };
    },
    async put(key, mark) {
      const row = await rowOf(key);
      const State = JSON.stringify(mark);
      if (row) await datastore.update(table, [{ ROWID: row.ROWID, State }]);
      else await datastore.insert(table, [{ Job_Key: `fired|${key}`, State }]);
    },
    async prune(schedule, horizon, exists) {
      const prefix = `fired|${schedule}|`;
      const like = prefix.replace(/'/g, "''");
      let cursor = '';
      for (;;) {
        const page = await datastore.query(table, `Job_Key LIKE '${like}%'${cursor ? ` AND ROWID > ${cursor}` : ''}`, SWEEP_PAGE_ROWS, 0, 'ORDER BY ROWID');
        if (!page.length) break;
        cursor = String(page[page.length - 1]!.ROWID);
        const ids = page.map((row) => String(row.Job_Key).slice(prefix.length)).filter(Boolean);
        const alive = await exists(ids);
        const drop: string[] = [];
        const shrink: Row[] = [];
        for (const row of page) {
          const id = String(row.Job_Key).slice(prefix.length);
          let state: { record?: unknown; instants?: unknown } = {};
          try {
            state = JSON.parse(String(row.State ?? '{}')) as typeof state;
          } catch {
            /* a corrupt mark is treated as spent */
          }
          const stored = Array.isArray(state.instants) ? (state.instants as number[]) : [];
          const instants = stored.filter((instant) => instant > horizon);
          if (!alive.has(id) || instants.length === 0) drop.push(String(row.ROWID));
          else if (instants.length !== stored.length) shrink.push({ ROWID: row.ROWID, State: JSON.stringify({ record: state.record, instants }) });
        }
        if (datastore.delete) {
          if (drop.length) await datastore.delete(table, drop);
        } else {
          // Without a delete adapter the row stays but can never match.
          for (const rowId of drop) shrink.push({ ROWID: rowId, State: JSON.stringify({ record: '', instants: [] }) });
        }
        if (shrink.length) await datastore.update(table, shrink);
      }
    },
  };
}
