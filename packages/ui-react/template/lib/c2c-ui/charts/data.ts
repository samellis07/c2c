/**
 * Chart and metric data: the browser filters report rows with the criteria
 * the generator translated (see ChartSpec, MetricSpec) and folds them into
 * categories and values. Pure functions; the clock is a parameter.
 */
import type { ChartSpec, FilterClause, MeasureSpec, MetricSpec } from '../types.js';

export type Row = Record<string, unknown>;
export interface Day {
  y: number;
  m: number;
  d: number;
}

/** A row value by field path: `Field`, or `Lookup.Field` through a nested record (else the lookup's own value). */
export function valueAt(row: Row, path: string): unknown {
  if (!path) return undefined;
  if (path in row) return row[path];
  const parts = path.split('.');
  let current: unknown = row;
  for (const part of parts) {
    if (current && typeof current === 'object' && !Array.isArray(current) && part in (current as Row)) current = (current as Row)[part];
    else return parts.length > 1 ? row[parts[0]!] : undefined;
  }
  return current;
}

/** The text a value is grouped and compared by. */
export function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.map(textOf).join(', ');
  if (typeof value === 'object') {
    const obj = value as Row;
    for (const key of ['display_value', 'zc_display_value', 'label', 'value', 'key']) if (typeof obj[key] === 'string' || typeof obj[key] === 'number') return String(obj[key]);
    return Object.values(obj).map(textOf).filter(Boolean).join(' ');
  }
  return String(value).trim();
}

/** A number from a stored value: numbers, numeric strings with group separators or a currency sign. */
export function numberOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = textOf(value).replace(/[,\s]/g, '').replace(/^[^\d.-]+/, '');
  if (!text) return NaN;
  return Number(text);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A calendar day from `2026-10-09`, `2026-10-09T10:00:00`, `09-Oct-2026` or `09-Oct-2026 10:00:00`. */
export function dayOf(value: unknown): Day | null {
  const text = textOf(value);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T ])/.exec(text);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})(?:$|\s)/.exec(text);
  if (m) {
    const month = MONTHS.indexOf(m[2]!.toLowerCase()) + 1;
    return month ? valid(Number(m[3]), month, Number(m[1])) : null;
  }
  return null;
}

function valid(y: number, m: number, d: number): Day | null {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? { y, m, d } : null;
}

/** Days since 1970-01-01 (UTC calendar arithmetic, no time zone). */
function serial(day: Day): number {
  return Math.round(Date.UTC(day.y, day.m - 1, day.d) / 86400000);
}

function inPeriod(day: Day, clause: Extract<FilterClause, { op: 'period' }>, today: Day): boolean {
  const shift = clause.when === 'last' ? -1 : clause.when === 'next' ? 1 : 0;
  const t = serial(today);
  const s = serial(day);
  if (clause.unit === 'day') {
    if (clause.count) return clause.when === 'last' ? s > t - clause.count && s <= t : s >= t && s < t + clause.count;
    return s === t + shift;
  }
  if (clause.unit === 'week') {
    // Weeks start on Sunday. 1970-01-01 was a Thursday.
    const start = (n: number) => n - ((n + 4) % 7);
    return start(s) === start(t) + 7 * shift;
  }
  if (clause.unit === 'month') return day.y * 12 + day.m === today.y * 12 + today.m + shift;
  return day.y === today.y + shift;
}

function compare(a: unknown, b: unknown): number {
  const x = numberOf(a);
  const y = numberOf(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  const dx = dayOf(a);
  const dy = dayOf(b);
  if (dx && dy) return serial(dx) - serial(dy);
  const sx = textOf(a);
  const sy = textOf(b);
  return sx < sy ? -1 : sx > sy ? 1 : 0;
}

function holds(op: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge', c: number): boolean {
  return op === 'eq' ? c === 0 : op === 'ne' ? c !== 0 : op === 'lt' ? c < 0 : op === 'le' ? c <= 0 : op === 'gt' ? c > 0 : c >= 0;
}

/** Whether a row passes one translated clause. */
export function matches(row: Row, clause: FilterClause, today: Day): boolean {
  if ('of' in clause) return clause.op === 'all' ? clause.of.every((c) => matches(row, c, today)) : clause.of.some((c) => matches(row, c, today));
  const value = valueAt(row, clause.field);
  if (clause.op === 'empty') return textOf(value) === '';
  if (clause.op === 'filled') return textOf(value) !== '';
  if (clause.op === 'period') {
    const day = dayOf(value);
    return !!day && inPeriod(day, clause, today);
  }
  if ('today' in clause) {
    const day = dayOf(value);
    return !!day && holds(clause.op, serial(day) - serial(today));
  }
  if ('ref' in clause) return holds(clause.op, compare(value, valueAt(row, clause.ref)));
  if (clause.op === 'eq' || clause.op === 'ne') {
    let equal: boolean;
    if (typeof clause.value === 'boolean') equal = (textOf(value) === 'true') === clause.value;
    else if (typeof clause.value === 'number') equal = numberOf(value) === clause.value;
    else equal = Array.isArray(value) ? value.map(textOf).includes(clause.value) : textOf(value) === clause.value;
    return clause.op === 'eq' ? equal : !equal;
  }
  if (!('value' in clause)) return false;
  const n = numberOf(value);
  return Number.isFinite(n) && holds(clause.op, n - Number(clause.value));
}

export function applyFilter(rows: Row[], filter: FilterClause[], today: Day): Row[] {
  return filter.length ? rows.filter((row) => filter.every((clause) => matches(row, clause, today))) : rows;
}

function fold(rows: Row[], fn: 'count' | 'sum' | 'value', field: string): number {
  if (fn === 'count') return field && field !== 'ID' && rows.some((row) => field in row) ? rows.filter((row) => textOf(valueAt(row, field)) !== '').length : rows.length;
  let total = 0;
  for (const row of rows) {
    const n = numberOf(valueAt(row, field));
    if (Number.isFinite(n)) total += n;
  }
  return Math.round(total * 100) / 100;
}

/** A metric's value over the rows its criteria keep. */
export function metricValue(rows: Row[], metric: MetricSpec, today: Day): number {
  return fold(applyFilter(rows, metric.filter, today), metric.fn, metric.field);
}

export interface Series {
  categories: { key: string; label: string }[];
  /** One list of values per measure, aligned with `categories`. */
  values: number[][];
  /** Most category values are dates; they are in date order. */
  dated: boolean;
}

/** Group the filtered rows by the category field and fold every measure per group. */
export function chartSeries(rows: Row[], chart: ChartSpec, today: Day): Series {
  const kept = applyFilter(rows, chart.filter, today);
  const groups = new Map<string, Row[]>();
  for (const row of kept) {
    const value = valueAt(row, chart.x);
    const day = dayOf(value);
    // Date and date-time values group by calendar day.
    const key = day ? `${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}` : textOf(value);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  let keys = [...groups.keys()];
  const days = new Map(keys.map((key) => [key, dayOf(key)]));
  const dated = keys.length > 0 && keys.filter((key) => days.get(key)).length > keys.length / 2;
  const totals = new Map(keys.map((key) => [key, fold(groups.get(key)!, chart.measures[0]!.fn, chart.measures[0]!.field)]));
  if (dated) keys = keys.sort((a, b) => (days.get(a) ? serial(days.get(a)!) : Infinity) - (days.get(b) ? serial(days.get(b)!) : Infinity));
  else if (chart.kind === 'donut') keys = keys.sort((a, b) => totals.get(b)! - totals.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
  else keys = keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    categories: keys.map((key) => ({ key: key || '(blank)', label: key || '(blank)' })),
    values: chart.measures.map((m) => keys.map((key) => (m === chart.measures[0] ? totals.get(key)! : fold(groups.get(key)!, m.fn, m.field)))),
    dated,
  };
}

/** The `op: "aggregate"` reply body of a report endpoint. */
export interface AggregateBody {
  buckets?: { key: string; values: number[] }[];
  /** The measures the server kept: one it cannot read is dropped. */
  measures?: { fn: string; field: string }[];
  dated?: boolean;
  truncated?: boolean;
  scanned?: number;
}

/**
 * Server buckets → the Series the chart components draw. Values are matched
 * to `body.measures` (the measures the server kept) by (fn, field), never by
 * request position: a dropped measure leaves a zero series under its own
 * label instead of shifting a later measure's values under it.
 */
export function bucketsToSeries(body: AggregateBody, chart: ChartSpec): Series {
  const buckets = Array.isArray(body.buckets) ? body.buckets : [];
  const kept = Array.isArray(body.measures) ? body.measures : null;
  const slot = (measure: MeasureSpec, position: number): number =>
    kept ? kept.findIndex((m) => m && m.fn === measure.fn && m.field === measure.field) : position;
  return {
    categories: buckets.map((b) => ({ key: b.key, label: b.key || '(blank)' })),
    values: chart.measures.map((measure, position) => {
      const index = slot(measure, position);
      return buckets.map((b) => (index >= 0 && Array.isArray(b.values) ? Number(b.values[index]) || 0 : 0));
    }),
    dated: !!body.dated,
  };
}

/** Today in the app's time zone (`C2C_APP_TIMEZONE` from c2c-config.js), else the browser's. */
export function todayIn(zone: string | undefined, now: Date): Day {
  if (zone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
      const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
      if (get('year') && get('month') && get('day')) return { y: get('year'), m: get('month'), d: get('day') };
    } catch {
      // An unknown zone name falls back to the browser's day.
    }
  }
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}
