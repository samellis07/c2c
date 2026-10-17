/**
 * One normal form for date and date-time text, shared by the update-by-criteria
 * row match and the value comparison in verify-behavior.
 *
 * Creator writes and exports a date as `dd-MMM-yyyy` and a date-time as
 * `dd-MMM-yyyy HH:mm:ss`; a Catalyst column reads back `yyyy-MM-dd` and
 * `yyyy-MM-dd HH:mm:ss`. Both are wall-clock text in the application time zone.
 *
 * - A calendar date is a day. It is never shifted by a zone.
 * - A date-time without an offset is wall-clock time in the app zone, as given.
 * - A date-time with `Z` or `+hh:mm` is an instant. It is shown in the app zone
 *   and then compared. Without a valid app zone it has no normal form.
 * - A date never equals a date-time, and text that is not a valid date is not normalised.
 */
import { parseLiteral, partsInZone, requireZone } from '../../shims/src/date.js';

export interface TemporalText {
  kind: 'date' | 'datetime';
  /** `yyyy-MM-dd` or `yyyy-MM-dd HH:mm:ss.SSS`. */
  text: string;
}

const CREATOR_DATE = /^\d{1,2}-[A-Za-z]{3}-\d{4}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CREATOR_DATETIME = /^(\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?)$/;
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)(?:[.:](\d{3}))?$/;
const ZONED_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function day(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

function strict(text: string) {
  try {
    return parseLiteral(text, true);
  } catch {
    return undefined;
  }
}

/** The app zone for comparisons, or undefined when it is missing or not a valid zone. */
export function comparisonZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    return requireZone(zone);
  } catch {
    return undefined;
  }
}

export function normalizeTemporal(value: unknown, timeZone?: string): TemporalText | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (CREATOR_DATE.test(text) || ISO_DATE.test(text)) {
    const at = strict(text);
    return at && { kind: 'date', text: day(at.y, at.m, at.d) };
  }
  const local = CREATOR_DATETIME.exec(text) ?? ISO_DATETIME.exec(text);
  if (local) {
    const at = strict(local[1]!);
    if (!at) return undefined;
    return { kind: 'datetime', text: `${day(at.y, at.m, at.d)} ${pad(at.hh)}:${pad(at.mm)}:${pad(at.ss)}.${local[2] ?? '000'}` };
  }
  if (ZONED_DATETIME.test(text)) {
    const zone = comparisonZone(timeZone);
    const instant = new Date(text);
    if (!zone || Number.isNaN(instant.getTime())) return undefined;
    const p = partsInZone(instant, zone);
    return { kind: 'datetime', text: `${day(p.y, p.m, p.d)} ${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}.${pad(instant.getUTCMilliseconds(), 3)}` };
  }
  return undefined;
}

/** True when both values are the same calendar date, or the same date-time in the app zone. */
export function temporalEqual(a: unknown, b: unknown, timeZone?: string): boolean {
  const left = normalizeTemporal(a, timeZone);
  if (!left) return false;
  const right = normalizeTemporal(b, timeZone);
  return right !== undefined && left.kind === right.kind && left.text === right.text;
}
