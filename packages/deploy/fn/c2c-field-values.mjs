/**
 * Field values by type, shared by the datastore adapter (readRow: values the
 * store returns) and the Advanced I/O entry (inputRecord: values a caller
 * posts as body.record). Both read a value into the shape generated Deluge
 * expects, so `input.Qty + rec.Stock` adds whether Qty came from a form, an
 * API client, or the store.
 *
 * Types are the c2c-columns.json adapter types:
 *   Number    a Creator number or auto-number (BigInt or Int column): a JS number, or a JS
 *             bigint past 2^53 so no digit is lost. Digit text and a JSON number read alike.
 *   Double    numeric text or a JSON number: a JS number. Data Store returns a Double as a
 *             JSON number on a read and as padded text ("12.5000") in an insert response.
 *   Decimal   a Creator decimal, currency or percent (an exact-decimal varchar): canonical
 *             decimal text ("10.30" keeps its digits), which the shims' exact decimal reads.
 *             Posted text keeps the digits that were typed. A JSON number carries no
 *             trailing zeros, so it is written out to the field's Creator decimal places
 *             when the generated write rules know them (10.3 with 2 places is "10.30");
 *             without them it is its shortest text ("10.3"). Extra digits are not cut
 *             here: the write path rounds them to the column scale.
 *   Boolean   true/false, or the text "true"/"false" in any case.
 *   Date      "yyyy-MM-dd" (a posted Creator "dd-MMM-yyyy" is read as that).
 *   DateTime  ISO local "yyyy-MM-ddTHH:mm:ss". Data Store wall time ("yyyy-MM-dd HH:mm:ss",
 *             with or without ".ms" or ":ms") reads as that; a posted value may also omit the
 *             seconds or be an instant (a trailing Z or offset), which the adapter converts
 *             to app-local time on the write.
 *   BigInt, Foreign Key
 *             ids: digit strings, never touched here.
 * Blank ("" or null) is null for every typed field. Any other type (text) is never touched,
 * so "007" stays "007".
 *
 * A subform field in a posted record is a list of child rows; each row is read by its child
 * table's types, and a refused child value names the subform, the row and the field
 * ("Lines[0].Qty").
 *
 * A posted record (or subform row) with a "__proto__" key is refused (400): copying
 * it would replace the copy's prototype.
 *
 * A store read is lenient: a value that does not parse is returned as it came. A posted
 * value is strict: one that does not parse ("abc" in a number field) is refused with a
 * FieldValueError (status 400) naming the field, never read as NaN, 0 or text.
 */

export class FieldValueError extends Error {
  constructor(field, type, message) {
    super(message);
    this.name = 'FieldValueError';
    this.status = 400;
    this.code = 'INVALID_FIELD_VALUE';
    this.field = field;
    this.type = type;
  }
}

const INTEGER_TEXT = /^-?\d+$/;
const NUMERIC_TEXT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const DECIMAL_TEXT = /^(-?)(\d*)(?:\.(\d*))?$/;
const WALL_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.:]\d{1,9})?$/;
const WALL_MINUTES = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const CREATOR_DATE = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/;
const CREATOR_DATE_TIME = /^(\d{1,2}-[A-Za-z]{3}-\d{4}) (\d{2}:\d{2}:\d{2})$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export const VALUE_TYPES = ['Number', 'Double', 'Decimal', 'Boolean', 'Date', 'DateTime'];

const LOST = 'lost';
const INVALID = 'invalid';

function blank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function validYmd(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validHms(text) {
  const [hour, minute, second] = text.split(':').map(Number);
  return hour <= 23 && minute <= 59 && second <= 59;
}

function creatorDate(text) {
  const match = CREATOR_DATE.exec(text);
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[2].toLowerCase());
  if (month < 0) return undefined;
  const iso = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  return validYmd(iso) ? iso : undefined;
}

/** Canonical decimal text: no leading zeros, a leading 0 before the point, every fractional digit kept. */
function decimalText(text) {
  const match = DECIMAL_TEXT.exec(text);
  if (!match || (!match[2] && !match[3])) return undefined;
  const whole = match[2].replace(/^0+(?=\d)/, '') || '0';
  return `${match[1]}${whole}${match[3] ? `.${match[3]}` : ''}`;
}

/** Decimal text with at least `scale` fractional digits (trailing zeros added, none removed). */
function padScale(text, scale) {
  if (!Number.isInteger(scale) || scale <= 0) return text;
  const point = text.indexOf('.');
  const have = point < 0 ? 0 : text.length - point - 1;
  if (have >= scale) return text;
  return `${text}${point < 0 ? '.' : ''}${'0'.repeat(scale - have)}`;
}

/**
 * One value of a typed field: { value } when it parses, else { reason } (LOST when a JS number
 * has already lost digits, INVALID otherwise). Blank is { value: null }. Untyped is unchanged.
 * `scale` is a Decimal field's Creator decimal places, used only to write out a JSON number.
 */
export function parseValue(type, value, scale) {
  if (!VALUE_TYPES.includes(type)) return { value };
  if (blank(value)) return { value: null };
  const text = typeof value === 'string' ? value.trim() : undefined;
  switch (type) {
    case 'Number':
      if (typeof value === 'bigint') return { value };
      if (typeof value === 'number') {
        if (!Number.isInteger(value)) return { reason: INVALID };
        return Number.isSafeInteger(value) ? { value } : { reason: LOST };
      }
      if (text === undefined || !INTEGER_TEXT.test(text)) return { reason: INVALID };
      return Number.isSafeInteger(Number(text)) ? { value: Number(text) } : { value: BigInt(text) };
    case 'Double':
      if (typeof value === 'number') return Number.isFinite(value) ? { value } : { reason: INVALID };
      return text !== undefined && NUMERIC_TEXT.test(text) ? { value: Number(text) } : { reason: INVALID };
    case 'Decimal': {
      // A JSON number is the shortest text of what was typed (10.3), never binary64 noise,
      // written out to the field's decimal places (10.30) when they are known.
      const number = typeof value === 'number' && Number.isFinite(value);
      const source = number ? String(value) : text;
      const canonical = source === undefined ? undefined : decimalText(source);
      if (canonical === undefined) return { reason: INVALID };
      return { value: number ? padScale(canonical, scale) : canonical };
    }
    case 'Boolean':
      if (typeof value === 'boolean') return { value };
      return text !== undefined && /^(true|false)$/i.test(text) ? { value: text.toLowerCase() === 'true' } : { reason: INVALID };
    case 'Date': {
      if (text === undefined) return { reason: INVALID };
      const iso = validYmd(text) ? text : creatorDate(text);
      return iso ? { value: iso } : { reason: INVALID };
    }
    case 'DateTime': {
      if (text === undefined) return { reason: INVALID };
      if (INSTANT.test(text)) return Number.isFinite(Date.parse(text)) ? { value: text } : { reason: INVALID };
      let wall = WALL_TIME.exec(text);
      let day = wall && wall[1];
      let time = wall && wall[2];
      if (!wall && (wall = WALL_MINUTES.exec(text))) {
        day = wall[1];
        time = `${wall[2]}:00`;
      } else if (!wall && (wall = CREATOR_DATE_TIME.exec(text))) {
        day = creatorDate(wall[1]);
        time = wall[2];
      }
      if (!day || !time || !validYmd(day) || !validHms(time)) return { reason: INVALID };
      return { value: `${day}T${time}` };
    }
    default:
      return { value };
  }
}

/** A value the store returned. A value that does not parse is returned as it came; lost digits throw. */
export function readValue(type, value, where) {
  const parsed = parseValue(type, value);
  if (parsed.reason === LOST) throw new Error(`datastore: ${where} came back as the JS number ${value}, which has lost digits`);
  return parsed.reason ? value : parsed.value;
}

/** A value a caller posted. A value that does not parse is refused with a FieldValueError (400). */
export function inputValue(type, value, field, scale) {
  const parsed = parseValue(type, value, scale);
  if (!parsed.reason) return parsed.value;
  const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
  const detail = parsed.reason === LOST ? `the JS number ${shown}, which has lost digits; send digit text` : shown;
  throw new FieldValueError(field, type, `${field} is ${detail}, not a valid ${type.toLowerCase()} value`);
}

function own(map, key) {
  return map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * A posted record with every typed field read by its type. `types` names stored columns
 * (c2c-columns.json for the form) and `renames` maps a field to its stored column
 * (c2c-renames.json), so a renamed field is typed by its column. Other keys are copied.
 * opts.scales: { column: Creator decimal places } for Decimal columns.
 * opts.subforms: { subformField: { types, renames, scales } } for each inline subform; a list
 * value has each plain-object row read by those, and anything else is copied (the write
 * path refuses a subform value that is not a list of rows).
 */
export function inputRecord(record, types, renames = {}, opts = {}) {
  for (const key of Object.keys(record)) {
    // JSON.parse keeps "__proto__" as an own key; copying it with out[key] = value
    // would set the copy's prototype, so a smuggled object's fields read as record
    // fields while no own key names them. No Creator field has that name.
    if (key === '__proto__') throw new FieldValueError(key, 'field', `${key} is not a field name`);
  }
  if ((!types || typeof types !== 'object') && !opts.subforms) return record;
  const out = {};
  for (const key of Object.keys(record)) {
    const sub = own(opts.subforms, key);
    if (sub && Array.isArray(record[key])) {
      out[key] = record[key].map((row, index) =>
        row && typeof row === 'object' && !Array.isArray(row) && !('__row' in row) ? childRow(row, sub, `${key}[${index}]`) : row,
      );
      continue;
    }
    const column = own(renames, key) ?? key;
    const type = own(types, column);
    out[key] = type ? inputValue(type, record[key], key, own(opts.scales, column)) : record[key];
  }
  return out;
}

function childRow(row, sub, where) {
  try {
    return inputRecord(row, sub.types || {}, sub.renames || {}, { scales: sub.scales });
  } catch (err) {
    if (!(err instanceof FieldValueError)) throw err;
    const field = `${where}.${err.field}`;
    throw new FieldValueError(field, err.type, `${where}.${err.message}`);
  }
}

/** A row the store or a dry-run seed holds, read leniently by its table's types. */
export function storedRecord(row, types, renames = {}, where = 'row') {
  if (!types || typeof types !== 'object') return row;
  const out = {};
  for (const key of Object.keys(row)) {
    const column = own(renames, key) ?? key;
    const type = own(types, column);
    out[key] = type ? readValue(type, row[key], `${where}.${key}`) : row[key];
  }
  return out;
}

/** { column: scale } for the exact-decimal columns of one table's write rules (c2c-rules.json). */
function scalesOf(rules) {
  const out = {};
  if (!Array.isArray(rules)) return out;
  for (const column of rules) {
    if (column && column.exactDecimal && !column.shadow && Number.isInteger(column.scale)) out[column.name] = column.scale;
  }
  return out;
}

/**
 * The field reader for one generated app, so the deployed entry and a local runtime read
 * values alike. `columns`, `renames` and `rules` are c2c-columns.json, c2c-renames.json and
 * c2c-rules.json (table keyed); `subforms` is a handler's subformTables ({ form: [{ field,
 * table }] }). input(form, record) is the strict posted-record read; stored(form, row) the
 * lenient store read.
 */
export function createFieldReader({ columns = {}, renames = {}, rules = {}, subforms = {} } = {}) {
  const shape = (table) => ({ types: own(columns, table), renames: own(renames, table) || {}, scales: scalesOf(own(rules, table)) });
  return {
    input(form, record) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
      const base = shape(form);
      const children = {};
      const links = own(subforms, form);
      for (const link of Array.isArray(links) ? links : []) {
        if (link && typeof link.field === 'string' && typeof link.table === 'string') children[link.field] = shape(link.table);
      }
      return inputRecord(record, base.types, base.renames, { scales: base.scales, subforms: children });
    },
    stored(form, row) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      const base = shape(form);
      return storedRecord(row, base.types, base.renames, form);
    },
  };
}
