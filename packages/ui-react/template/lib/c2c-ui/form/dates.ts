/**
 * Date and date-time display in the app's Creator settings: the `date format`
 * (dd-MMM-yyyy by default) and the `time format` clock ("12-hr" shows
 * hh:mm:ss AM/PM; "24-hr" or unset keeps HH:mm:ss). Report cells, group headers,
 * detail views and record summaries all format through here.
 *
 * A date is a calendar date and never passes through a time zone, so it
 * shows the same day in every browser zone. A date-time with an explicit
 * offset or Z is an instant, shown in the app time zone; one without is
 * already app wall time. Text that is not a date stays as given.
 */
export type DateKind = 'date' | 'datetime';

export interface DateDisplay {
  dateFormat?: string;
  timeFormat?: string;
  /** The app time zone (C2C_APP_TIMEZONE), for date-times that carry an offset. */
  timeZone?: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Parts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

const pad = (n: number): string => String(n).padStart(2, '0');

function parseWall(text: string): Parts | undefined {
  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (m) {
    const mon = MONTHS.findIndex((x) => x.toLowerCase() === m![2]!.toLowerCase());
    if (mon < 0) return undefined;
    return { y: Number(m[3]), m: mon + 1, d: Number(m[1]), hh: Number(m[4] ?? 0), mm: Number(m[5] ?? 0), ss: Number(m[6] ?? 0) };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/.exec(text);
  if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), hh: Number(m[4] ?? 0), mm: Number(m[5] ?? 0), ss: Number(m[6] ?? 0) };
  return undefined;
}

/** Wall-clock parts of an instant in a zone; a `GMT+5:30` custom offset is applied directly. */
function partsInZone(instant: Date, zone: string): Parts | undefined {
  const fixed = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone);
  if (fixed) {
    const ms = (fixed[1] === '+' ? 1 : -1) * (Number(fixed[2]) * 60 + Number(fixed[3] ?? 0)) * 60000;
    const u = new Date(instant.getTime() + ms);
    return { y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate(), hh: u.getUTCHours(), mm: u.getUTCMinutes(), ss: u.getUTCSeconds() };
  }
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const bag: Record<string, string> = {};
    for (const part of fmt.formatToParts(instant)) if (part.type !== 'literal') bag[part.type] = part.value;
    return { y: Number(bag.year), m: Number(bag.month), d: Number(bag.day), hh: Number(bag.hour === '24' ? '0' : bag.hour), mm: Number(bag.minute), ss: Number(bag.second) };
  } catch {
    return undefined;
  }
}

/** A calendar date in a Creator date pattern (dd-MMM-yyyy, MM/dd/yyyy, …). */
export function creatorDate(pattern: string, y: number, m: number, d: number): string {
  const tokens: Record<string, string> = { yyyy: String(y), yy: pad(y % 100), MMMM: MONTHS_LONG[m - 1]!, MMM: MONTHS[m - 1]!, MM: pad(m), dd: pad(d), d: String(d) };
  return pattern.replace(/yyyy|yy|MMMM|MMM|MM|dd|d/g, (t) => tokens[t] ?? t);
}

/** The clock part of a date-time in the app time format. */
export function creatorClock(timeFormat: string | undefined, hh: number, mm: number, ss: number): string {
  if (/^12/.test(timeFormat ?? '')) return `${pad(hh % 12 || 12)}:${pad(mm)}:${pad(ss)} ${hh < 12 ? 'AM' : 'PM'}`;
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

/** A stored date or date-time value as Creator shows it; null for a value that is not one. */
export function displayDateValue(value: unknown, kind: DateKind, opts: DateDisplay = {}): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const pattern = opts.dateFormat || 'dd-MMM-yyyy';
  if (kind === 'date') {
    const parts = parseWall(text.replace(/[T\s].*$/, ''));
    return parts ? creatorDate(pattern, parts.y, parts.m, parts.d) : null;
  }
  let parts = parseWall(text);
  if (!parts && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) && opts.timeZone) {
    const instant = new Date(text);
    if (!Number.isNaN(instant.getTime())) parts = partsInZone(instant, opts.timeZone);
  }
  if (!parts) return null;
  return `${creatorDate(pattern, parts.y, parts.m, parts.d)} ${creatorClock(opts.timeFormat, parts.hh, parts.mm, parts.ss)}`;
}
