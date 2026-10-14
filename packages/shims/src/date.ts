/**
 * App-timezone calendar dates.
 *
 * Deluge `zoho.currentdate` / `zoho.currenttime` follow the Creator application
 * time zone (https://www.zoho.com/deluge/help/zoho-variables.html — the value
 * is in the format from Application settings;
 * https://www.zoho.com/deluge/help/functions/common/totime.html — "Time zone
 * specified in application settings is considered as the default time zone.").
 *
 * Resolution order for that zone: `C2C_APP_TIMEZONE`, then the IR `time zone`
 * application setting. UTC ({@link DEFAULT_APP_TIMEZONE}) is only the labelled
 * dry-run fallback when both are missing. A live runtime (`dryRun: false`)
 * throws {@link TimeZoneRequired} instead of assuming UTC.
 * https://www.zoho.com/deluge/help/functions/common/totime.html — the application
 * setting is the default zone, not UTC.
 */
import { DelugeRuntimeError } from './errors.js';

export interface DateParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

export class DelugeDate {
  constructor(
    readonly y: number,
    readonly m: number,
    readonly d: number,
    readonly hh = 0,
    readonly mm = 0,
    readonly ss = 0,
  ) {}

  /** Days since 1970-01-01 (proleptic Gregorian), for ordering only. */
  epochDay(): number {
    return Date.UTC(this.y, this.m - 1, this.d) / 86_400_000;
  }

  toJSON(): string {
    return this.toString();
  }

  toString(): string {
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${this.y}-${p(this.m)}-${p(this.d)}T${p(this.hh)}:${p(this.mm)}:${p(this.ss)}`;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class TimeZoneRequired extends Error {
  readonly code = 'TIMEZONE_REQUIRED';
  constructor() {
    super(
      'A Creator app time zone is required. Pass C2C_APP_TIMEZONE or the IR time zone setting. A live runtime does not assume UTC. UTC is only the labelled dry-run fallback.',
    );
  }
}

/**
 * Dry-run only, and only when neither `C2C_APP_TIMEZONE` nor the application
 * `time zone` setting is present. Not a Deluge default. A live runtime throws.
 */
export const DEFAULT_APP_TIMEZONE = 'UTC';

function firstZone(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export interface AppTimeZoneResolution {
  zone: string;
  /** True only for the dry-run UTC fallback. Never true when a zone was configured. */
  fallback: boolean;
}

/**
 * `envZone` wins (the `C2C_APP_TIMEZONE` override). Otherwise the Creator
 * `time zone` application setting. Otherwise, when `dryRun` is true,
 * {@link DEFAULT_APP_TIMEZONE} (labelled by the caller). When `dryRun` is
 * false, a missing zone throws {@link TimeZoneRequired}. An invalid IANA name
 * still throws.
 */
export function resolveAppTimeZoneDetail(envZone?: string, settingsZone?: string, dryRun = true): AppTimeZoneResolution {
  const chosen = firstZone(envZone) ?? firstZone(settingsZone);
  if (chosen) return { zone: requireZone(chosen), fallback: false };
  if (!dryRun) throw new TimeZoneRequired();
  return { zone: requireZone(DEFAULT_APP_TIMEZONE), fallback: true };
}

export function resolveAppTimeZone(envZone?: string, settingsZone?: string, dryRun = true): string {
  return resolveAppTimeZoneDetail(envZone, settingsZone, dryRun).zone;
}

/** Wall time falls in a DST spring-forward gap. No instant is invented. */
export class NonexistentLocalTime extends Error {
  readonly code = 'NONEXISTENT_LOCAL_TIME';
  constructor(value: string, timeZone: string) {
    super(`date: ${value} does not exist in ${timeZone} (DST gap)`);
    this.name = 'NonexistentLocalTime';
  }
}

/**
 * Milliseconds east of UTC for a GMT custom offset (`GMT-8`, `GMT+5:30`, `GMT+hh:mm`).
 * Hours are one or two digits (0-23). Minutes, when present, are two digits (0-59).
 * `UTC+8` is not this form. Returns undefined when `timeZone` is not a GMT offset.
 */
function fixedGmtOffsetMs(timeZone: string): number | undefined {
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(timeZone);
  if (!match) return undefined;
  const hours = Number(match[2]);
  const minutes = match[3] === undefined ? 0 : Number(match[3]);
  if (hours > 23 || minutes > 59) return undefined;
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (hours * 60 + minutes) * 60_000;
}

export function requireZone(timeZone: string | undefined): string {
  if (!timeZone) throw new TimeZoneRequired();
  // A GMT custom offset is a fixed zone. Named zones are checked with Intl.
  // An unknown zone throws RangeError.
  if (fixedGmtOffsetMs(timeZone) !== undefined) return timeZone;
  new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  return timeZone;
}

export function partsInZone(instant: Date, timeZone: string): DateParts {
  const zone = requireZone(timeZone);
  const fixed = fixedGmtOffsetMs(zone);
  if (fixed !== undefined) {
    const shifted = new Date(instant.getTime() + fixed);
    return {
      y: shifted.getUTCFullYear(),
      m: shifted.getUTCMonth() + 1,
      d: shifted.getUTCDate(),
      hh: shifted.getUTCHours(),
      mm: shifted.getUTCMinutes(),
      ss: shifted.getUTCSeconds(),
    };
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const bag: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) if (p.type !== 'literal') bag[p.type] = p.value;
  return {
    y: Number(bag.year),
    m: Number(bag.month),
    d: Number(bag.day),
    hh: Number(bag.hour === '24' ? '0' : bag.hour),
    mm: Number(bag.minute),
    ss: Number(bag.second),
  };
}

export function today(instant: Date, timeZone: string): DelugeDate {
  const p = partsInZone(instant, timeZone);
  return new DelugeDate(p.y, p.m, p.d, 0, 0, 0);
}

export type CalendarDay = 'today' | 'tomorrow' | 'yesterday';

/**
 * Creator criteria `is today` / `is tomorrow` / `is yesterday`.
 * The calendar day is the app time zone, not UTC. A blank is not that day.
 * A non-blank value that is not a date throws from {@link asDate}.
 */
export function isCalendarDay(value: unknown, which: CalendarDay, instant: Date, timeZone: string): boolean {
  const base = today(instant, timeZone);
  const shift = which === 'tomorrow' ? 1 : which === 'yesterday' ? -1 : 0;
  const target = shift === 0 ? base : addDays(base, shift);
  const parsed = asDate(value);
  if (!parsed) return false;
  return parsed.y === target.y && parsed.m === target.m && parsed.d === target.d;
}

export function now(instant: Date, timeZone: string): DelugeDate {
  const p = partsInZone(instant, timeZone);
  return new DelugeDate(p.y, p.m, p.d, p.hh, p.mm, p.ss);
}

/**
 * Text (or a value) that is not a Deluge date. Creator's message (golden
 * vectors `date.rel.bad-eq`, `date.cmp.*-null-null`): "UnParsable date".
 */
function unparsable(): DelugeRuntimeError {
  return new DelugeRuntimeError('UnParsable date');
}

/** Parse a Deluge date literal (`01-Jan-2020`, `01-Jan-2020 13:45:00`, or `yyyy-MM-dd`). */
export function parseLiteral(value: string, strictRangeCheck = false): DelugeDate {
  const text = value.trim();
  let y = 0, m_num = 0, d = 0, hr = 0, min = 0, sec = 0;
  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (m) {
    const mon = MONTHS.findIndex((x) => x.toLowerCase() === m![2]!.toLowerCase());
    if (mon < 0) throw unparsable();
    y = Number(m[3]);
    m_num = mon + 1;
    d = Number(m[1]);
    hr = Number(m[4] ?? 0);
    min = Number(m[5] ?? 0);
    sec = Number(m[6] ?? 0);
  } else {
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
    if (m) {
      y = Number(m[1]);
      m_num = Number(m[2]);
      d = Number(m[3]);
      hr = Number(m[4] ?? 0);
      min = Number(m[5] ?? 0);
      sec = Number(m[6] ?? 0);
    } else {
      throw unparsable();
    }
  }

  if (strictRangeCheck) {
    if (m_num < 1 || m_num > 12 || d < 1) throw unparsable();
    const daysInMonth = new Date(Date.UTC(y, m_num, 0)).getUTCDate();
    if (d > daysInMonth) throw unparsable();
    if (m[4] !== undefined) {
      if (hr > 23 || min > 59 || sec > 59) throw unparsable();
    }
  }

  return new DelugeDate(y, m_num, d, hr, min, sec);
}

/**
 * Blank date-times are null, not a runtime error.
 *
 * In Creator, null and "" are blank
 * (https://www.zoho.com/deluge/help/functions/common/isnull-isblank-isempty-difference.html).
 * An empty form date is not a DATE-TIME. `addDay`
 * (https://www.zoho.com/deluge/help/functions/datetime/addday.html) of a blank
 * returns null. `toString`
 * (https://www.zoho.com/deluge/help/functions/common/tostring.html) of a blank
 * is empty text, not the literal "null" and not a throw. A non-blank value
 * that is not a supported literal still throws — a bad literal is not a blank field.
 */
export function asDate(value: unknown): DelugeDate | null {
  if (value == null) return null;
  if (value instanceof DelugeDate) return value;
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    return parseLiteral(value);
  }
  throw unparsable();
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

export function addDays(value: DelugeDate, days: number): DelugeDate {
  const ms = Date.UTC(value.y, value.m - 1, value.d + days);
  const u = new Date(ms);
  return new DelugeDate(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate(), value.hh, value.mm, value.ss);
}

export function addMonths(value: DelugeDate, months: number): DelugeDate {
  const total = value.y * 12 + (value.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new DelugeDate(y, m, Math.min(value.d, dim), value.hh, value.mm, value.ss);
}

export function diffDays(a: DelugeDate, b: DelugeDate): number {
  return a.epochDay() - b.epochDay();
}

/** Sunday is 1 … Saturday is 7. Time of day is ignored. */
export function weekdaySun1(value: DelugeDate): number {
  return new Date(Date.UTC(value.y, value.m - 1, value.d)).getUTCDay() + 1;
}

/**
 * Inclusive day offset from 1970-01-01 that a timestamp can name
 * (±8.64e15 milliseconds).
 */
const EPOCH_DAY_LIMIT = 100_000_000;

/**
 * Positive counts skip Saturday and Sunday. Zero and negative counts return
 * the same date: `05-Oct-2026.addBusinessDay(-1)` is that Monday.
 * The current week is finished one day at a time. Each further five business
 * days are seven calendar days, and at most four business days remain.
 * A result outside the supported calendar throws.
 */
export function addBusinessDays(value: DelugeDate, n: number): DelugeDate {
  if (!(n > 0)) return value;
  if (!Number.isFinite(n)) throw dateOutOfRange();
  const count = Math.trunc(n);
  if (count <= 0) return value;
  const start = value.epochDay();
  if (!Number.isFinite(start)) throw dateOutOfRange();
  // One business day moves at least one calendar day.
  if (count > EPOCH_DAY_LIMIT - start) throw dateOutOfRange();
  const calendar = businessCalendarDays(weekdaySun1(value), count);
  const target = start + calendar;
  if (target > EPOCH_DAY_LIMIT || target < -EPOCH_DAY_LIMIT) throw dateOutOfRange();
  return addDays(value, calendar);
}

function dateOutOfRange(): DelugeRuntimeError {
  return new DelugeRuntimeError('date is out of range');
}

/** Calendar days to advance `n` business days. Sunday is 1 and Saturday is 7. */
function businessCalendarDays(startDow: number, n: number): number {
  const remaining = startDow === 7 || startDow === 1 ? 5 : startDow === 6 ? 0 : 6 - startDow;
  if (n <= remaining) return walkCalendarDays(startDow, n);
  const toFriday = remaining === 0 ? 0 : walkCalendarDays(startDow, remaining);
  const left = n - remaining;
  const weeks = Math.floor(left / 5);
  const rem = left % 5;
  const fromFriday = rem === 0 ? 0 : walkCalendarDays(6, rem);
  return toFriday + weeks * 7 + fromFriday;
}

function walkCalendarDays(startDow: number, n: number): number {
  let left = n;
  let days = 0;
  let dow = startDow;
  while (left > 0) {
    days += 1;
    dow = dow === 7 ? 1 : dow + 1;
    if (dow !== 1 && dow !== 7) left -= 1;
  }
  return days;
}

/** Week starts on Sunday. The result is midnight. */
export function startOfWeek(value: DelugeDate): DelugeDate {
  const back = addDays(value, -(weekdaySun1(value) - 1));
  return new DelugeDate(back.y, back.m, back.d, 0, 0, 0);
}

/**
 * Calendar days from `a` to `b`, time ignored. The leap-day capture
 * (`01-Feb-2020` → `01-Mar-2020` = 29) is not the 30/360 financial basis.
 */
export function days360Count(a: DelugeDate, b: DelugeDate): number {
  return b.epochDay() - a.epochDay();
}

export function cmp(a: DelugeDate, b: DelugeDate): number {
  const ak = a.epochDay() * 86400 + a.hh * 3600 + a.mm * 60 + a.ss;
  const bk = b.epochDay() * 86400 + b.hh * 3600 + b.mm * 60 + b.ss;
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}

/**
 * Milliseconds since Unix epoch for this wall-clock time in `timeZone`.
 * Deluge's published example `'31-Dec-1969 16:00:00'.toLong() == 0` is that
 * instant in America/Los_Angeles (PST). The app zone decides which instant a
 * Creator date-time is; UTC is not assumed.
 */
export function epochMillis(value: DelugeDate, timeZone: string): number {
  const zone = requireZone(timeZone);
  const wall = Date.UTC(value.y, value.m - 1, value.d, value.hh, value.mm, value.ss);
  const matches = instantsForWall(wall, zone, value);
  if (matches.length === 0) throw new NonexistentLocalTime(value.toString(), zone);
  // A fall-back overlap has two instants. Keep the earlier one.
  return matches[0]!;
}

function instantsForWall(wall: number, zone: string, value: DelugeDate): number[] {
  let instant = wall;
  let prev = Number.NaN;
  for (let i = 0; i < 6; i++) {
    const next = wall - offsetAt(instant, zone);
    if (next === instant || next === prev) break;
    prev = instant;
    instant = next;
  }
  const candidates = new Set<number>([instant]);
  for (const delta of [-2 * 3_600_000, -3_600_000, 3_600_000, 2 * 3_600_000]) {
    candidates.add(wall - offsetAt(instant + delta, zone));
  }
  return [...candidates].filter((t) => sameWall(t, zone, value)).sort((a, b) => a - b);
}

function offsetAt(instant: number, zone: string): number {
  const wall = partsInZone(new Date(instant), zone);
  return Date.UTC(wall.y, wall.m - 1, wall.d, wall.hh, wall.mm, wall.ss) - instant;
}

function sameWall(instant: number, zone: string, value: DelugeDate): boolean {
  const wall = partsInZone(new Date(instant), zone);
  return (
    wall.y === value.y &&
    wall.m === value.m &&
    wall.d === value.d &&
    wall.hh === value.hh &&
    wall.mm === value.mm &&
    wall.ss === value.ss
  );
}

/** Deluge patterns used in the corpus: dd, d, MMM, MM, yyyy, yy, HH, mm, ss. Unknown tokens throw. */
export function format(value: DelugeDate, pattern: string): string {
  // Java-style quoted literals ('T' in yyyy-MM-dd'T'HH:mm:ss) pass through
  // untouched; stripping them first keeps a literal letter out of the token sweep.
  const literals: string[] = [];
  const stripped = pattern.replace(/'([^']*)'/g, (_quoted, lit: string) => {
    literals.push(lit);
    return '\u0000';
  });
  const leftover = stripped.replace(/yyyy|yy|MMMM|MMM|MM|dd|d|HH|mm|ss/g, '');
  if (/[A-Za-z]/.test(leftover)) throw new Error(`date: unsupported format pattern ${pattern}`);
  const map: Record<string, string> = {
    yyyy: String(value.y),
    yy: pad(value.y % 100),
    MMMM: MONTHS[value.m - 1]!,
    MMM: MONTHS[value.m - 1]!,
    MM: pad(value.m),
    dd: pad(value.d),
    d: String(value.d),
    HH: pad(value.hh),
    mm: pad(value.mm),
    ss: pad(value.ss),
  };
  let next = 0;
  return stripped
    .replace(/yyyy|yy|MMMM|MMM|MM|dd|d|HH|mm|ss/g, (token) => {
      const rep = map[token];
      if (rep === undefined) throw new Error(`date: unsupported format token ${token}`);
      return rep;
    })
    .replace(/\u0000/g, () => literals[next++] ?? '');
}

/** First day of the month, midnight (functions/datetime/tostartofmonth). */
export function startOfMonth(value: DelugeDate): DelugeDate {
  return new DelugeDate(value.y, value.m, 1, 0, 0, 0);
}

/**
 * `eomonth(d, n)`: the last day of the month `n` months from `d`, without a
 * time of day. The day of `d` is not used (functions/datetime/eomonth:
 * `'01-Jan-2019'.eomonth(1)` is `28-Feb-2019`).
 */
export function endOfMonth(value: DelugeDate, months: number): DelugeDate {
  const total = value.y * 12 + (value.m - 1) + Math.trunc(months);
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new DelugeDate(y, m, dim, 0, 0, 0);
}

/** 1 for 1 January, up to 365 or 366 (functions/datetime/getdayofyear). */
export function dayOfYear(value: DelugeDate): number {
  return value.epochDay() - new DelugeDate(value.y, 1, 1).epochDay() + 1;
}

/**
 * Week number with weeks starting on Sunday; the week holding 1 January is
 * week 1, so the last days of December in that week are week 1 of the next
 * year (functions/datetime/getweekofyear: `'7-Feb-2021'` is 7).
 */
export function weekOfYear(value: DelugeDate): number {
  const weekStart = startOfWeek(value);
  const weekEnd = addDays(weekStart, 6);
  if (weekEnd.y > value.y) return 1;
  const jan1 = new DelugeDate(value.y, 1, 1);
  const offset = weekdaySun1(jan1) - 1;
  return Math.floor((dayOfYear(value) - 1 + offset) / 7) + 1;
}

/**
 * Whole calendar days from `a` to `b`, time ignored
 * (functions/datetime/daysbetween: 1-Jan-2019 to 31-Dec-2019 is 364).
 * `monthsBetween` counts 30-day months and `yearsBetween` 365-day years,
 * truncated toward zero (functions/datetime/monthsbetween, yearsbetween).
 */
export function daysBetweenCount(a: DelugeDate, b: DelugeDate): number {
  return b.epochDay() - a.epochDay();
}

export function monthsBetweenCount(a: DelugeDate, b: DelugeDate): number {
  return Math.trunc(daysBetweenCount(a, b) / 30);
}

export function yearsBetweenCount(a: DelugeDate, b: DelugeDate): number {
  return Math.trunc(daysBetweenCount(a, b) / 365);
}

export function hoursBetweenCount(a: DelugeDate, b: DelugeDate): number {
  const diffDays = b.epochDay() - a.epochDay();
  const aTime = a.hh * 3600 + a.mm * 60 + a.ss;
  const bTime = b.hh * 3600 + b.mm * 60 + b.ss;
  return Math.trunc((diffDays * 86400 + bTime - aTime) / 3600);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function nextWeekDay(value: DelugeDate, dayName: string): DelugeDate | null {
  const targetDow = WEEKDAYS.indexOf(dayName.trim().toLowerCase()) + 1;
  if (targetDow === 0) return null;
  const currentDow = weekdaySun1(value);
  let diff = targetDow - currentDow;
  if (diff <= 0) diff += 7;
  return addDays(value, diff);
}

export function previousWeekDay(value: DelugeDate, dayName: string): DelugeDate | null {
  const targetDow = WEEKDAYS.indexOf(dayName.trim().toLowerCase()) + 1;
  if (targetDow === 0) return null;
  const currentDow = weekdaySun1(value);
  let diff = currentDow - targetDow;
  if (diff <= 0) diff += 7;
  return addDays(value, -diff);
}

/**
 * Checks if a string is a valid Deluge date literal.
 * Accepted formats: `dd-MMM-yyyy[ HH:mm[:ss]]` and `yyyy-MM-dd[ T/space HH:mm[:ss]]`.
 * The check is zone-less: it validates the format and ranges on the calendar,
 * and never consults the app time zone, because DelugeDate has no zone.
 */
export function isDate(value: unknown): boolean | null {
  if (value == null || typeof value === 'boolean') return null;
  if (value instanceof DelugeDate) return true;
  if (typeof value === 'string') {
    if (value.trim() === '') return false;
    try {
      parseLiteral(value, true);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Year, month, day only. The time of day is not part of a whole-period count. */
function ymdCmp(a: DelugeDate, b: DelugeDate): number {
  if (a.y !== b.y) return a.y < b.y ? -1 : 1;
  if (a.m !== b.m) return a.m < b.m ? -1 : 1;
  if (a.d !== b.d) return a.d < b.d ? -1 : 1;
  return 0;
}

/**
 * Whole calendar months from `a` to `b`. The time of day is ignored.
 * A month counts once the end day reaches the start day
 * (functions/datetime/totalmonth: 31-Dec-1989 to 01-Jan-1990 is 0,
 * 31-Dec-1989 to 01-Feb-1990 is 1, 01-Feb-2020 to 01-Mar-2020 is 1).
 * The reversed pair is the same count with the opposite sign.
 */
export function totalMonthsCount(a: DelugeDate, b: DelugeDate): number {
  if (ymdCmp(a, b) > 0) return -totalMonthsCount(b, a);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) months -= 1;
  return months;
}

/**
 * Whole calendar years from `a` to `b`, leap days included. The time of day
 * is ignored (functions/datetime/totalyear: 1-Jan-2019 to 31-Dec-2019 is 0,
 * 1-Jan-2019 to 1-Jan-2020 is 1, 02-Jan-2020 to 01-Jan-2021 is 0).
 * The reversed pair is the same count with the opposite sign.
 */
export function totalYearsCount(a: DelugeDate, b: DelugeDate): number {
  if (ymdCmp(a, b) > 0) return -totalYearsCount(b, a);
  let years = b.y - a.y;
  if (b.m < a.m || (b.m === a.m && b.d < a.d)) years -= 1;
  return years;
}
