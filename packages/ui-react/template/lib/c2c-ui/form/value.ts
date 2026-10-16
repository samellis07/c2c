/**
 * Conversions between a field's stored value, the value a widget speaks
 * (Date objects, minor units), and the string record.ts puts in the record.
 * Pure and DOM-free so the tests can round-trip a value through the same
 * helpers the widgets use.
 */

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 'YYYY-MM-DD' for the day `date` shows in the viewer's time zone (never UTC). */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The local `YYYY-MM-DDTHH:mm` (with seconds and milliseconds only when set) —
 * the same shape a datetime-local control submits.
 */
export function localDateTime(date: Date): string {
  const ms = date.getMilliseconds();
  const secs = date.getSeconds() || ms ? `:${pad(date.getSeconds())}` : '';
  return `${localDay(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}${secs}${ms ? `.${pad(ms, 3)}` : ''}`;
}

/** A stored 'YYYY-MM-DD' as the local-day Date; a full timestamp truncates to its local day. */
export function parseLocalDay(text: string | undefined): Date | undefined {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (m) {
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return date.getFullYear() === Number(m[1]) && date.getMonth() === Number(m[2]) - 1 && date.getDate() === Number(m[3]) ? date : undefined;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** A stored ISO timestamp or datetime-local value as a Date; empty/invalid → undefined. */
export function parseLocalDateTime(text: string | undefined): Date | undefined {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(trimmed);
  if (m) {
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), Number((m[7] ?? '0').padEnd(3, '0')));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The ISO 4217 currency's minor-unit digits (USD → 2, JPY → 0); 2 when the code is missing or unknown. */
export function fractionDigits(code: string | undefined): number {
  if (!code) return 2;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * A stored major-unit decimal string as minor units of `digits` (what the
 * money widget takes). String math, so '12.50' stays exact; digits beyond the
 * currency's own round half away from zero. Returns null for unparseable text.
 */
export function toMinorUnits(text: string, digits: number): number | null {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null;
  const frac = m[3] ?? '';
  let minor = BigInt(m[2] || '0') * 10n ** BigInt(digits) + BigInt(frac.slice(0, digits).padEnd(digits, '0') || '0');
  if (Number(frac[digits] ?? '0') >= 5) minor += 1n;
  if (m[1]) minor = -minor;
  const n = Number(minor);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * A major-unit number as the canonical decimal string at `scale` places, the
 * shape the submit endpoint expects ('12.50', not 1250 minor units). Extra
 * precision rounds half away from zero.
 */
export function toCanonicalDecimal(value: number, scale: number): string {
  if (!Number.isFinite(value)) return '';
  const scaled = Math.sign(value) * Math.round(Math.abs(value) * 10 ** scale);
  if (scaled === 0) return scale ? `0.${'0'.repeat(scale)}` : '0';
  // BigInt spells every digit: String() switches to exponent form at 1e21.
  const digits = BigInt(Math.abs(scaled)).toString().padStart(scale + 1, '0');
  const whole = scale ? digits.slice(0, -scale) : digits;
  return `${scaled < 0 ? '-' : ''}${whole}${scale ? `.${digits.slice(-scale)}` : ''}`;
}

/**
 * A plain decimal string ('-1,234.5', '007') as the exact canonical string,
 * string math only so no digit is lost however large it is. `scale` null keeps
 * the given fraction digits (a whole-number field); a number fixes the
 * fraction to that many places, rounding half away from zero. Returns null
 * for text that is not a plain decimal.
 */
export function canonicalNumber(text: string, scale: number | null): string | null {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text.trim().replace(/,/g, ''));
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null;
  let frac = m[3] ?? '';
  let whole = BigInt(m[2] || '0');
  if (scale !== null) {
    const kept = frac.slice(0, scale).padEnd(scale, '0');
    let units = whole * 10n ** BigInt(scale) + BigInt(kept || '0');
    if (Number(frac[scale] ?? '0') >= 5) units += 1n;
    const all = units.toString().padStart(scale + 1, '0');
    whole = BigInt(scale ? all.slice(0, -scale) : all);
    frac = scale ? all.slice(-scale) : '';
  } else frac = frac.replace(/0+$/, '');
  const zero = whole === 0n && !/[1-9]/.test(frac);
  return `${m[1] && !zero ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * The choices of a stored multi-value cell: a list, JSON list text (["No"]),
 * a Deluge list literal ({"No"}), the legacy unquoted list ([No]) or one bare
 * choice. The edit form prefills from it, so saving without touching the field
 * keeps its choices, and a legacy shape is posted back as a list.
 */
export function multiValueItems(value: unknown): string[] {
  const clean = (items: readonly unknown[]) => items.filter((item) => item !== null && item !== undefined).map((item) => String(item).trim()).filter((item) => item.length > 0);
  const bare = (text: string) => clean(text.slice(1, -1).split(',').map((item) => item.trim().replace(/^(["'])([\s\S]*)\1$/, '$2')));
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return clean(value);
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (!text) return [];
  if (text.startsWith('[') && text.endsWith(']')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return bare(text);
    }
    if (Array.isArray(parsed) && parsed.every((item) => item === null || typeof item !== 'object')) return clean(parsed);
  }
  if (text.startsWith('{') && text.endsWith('}')) return bare(text);
  return [text];
}
