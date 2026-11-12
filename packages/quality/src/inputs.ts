/**
 * Seeded inputs for quality gate Q4, generated from IR field types.
 *
 * Variants per field: valid, empty, null, boundary, wrong-type. A subform
 * (grid) field gets 0, 1 or n rows. Same seed, same inputs: the PRNG is
 * mulberry32 over a FNV-1a seed, implemented here so no dependency is added.
 */
import type { App, Field, Form } from '../../core/src/index.js';

export type Variant = 'valid' | 'empty' | 'null' | 'boundary' | 'wrong-type';
export const VARIANTS: readonly Variant[] = ['valid', 'empty', 'null', 'boundary', 'wrong-type'];
/** Rows in a generated subform or seeded table: zero, one, n. */
export const ROW_COUNTS: readonly number[] = [0, 1, 3];

export type Rng = () => number;

/** FNV-1a 32-bit. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: uniform in [0, 1). */
export function rng(seed: number | string): Rng {
  let a = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(r: Rng, items: readonly T[]): T {
  return items[Math.floor(r() * items.length)]!;
}

const NON_DATA = new Set(['section', 'plaintext', 'notes', 'button']);

type Family = 'text' | 'number' | 'date' | 'datetime' | 'bool' | 'choice' | 'multi' | 'lookup' | 'lookup-multi' | 'composite' | 'subform' | 'file';

const NUMBER_TYPES = new Set(['number', 'decimal', 'percentage', 'autonumber', 'currency', 'USD', 'INR', 'EUR', 'GBP']);

export function family(field: Field): Family | null {
  const type = (field.type ?? '').trim();
  if (NON_DATA.has(type)) return null;
  if (type === 'grid' || type === 'subform' || type === 'inline subform') return 'subform';
  if (field.lookup) return type === 'list' || type === 'checkboxes' || type === 'checkbox list' ? 'lookup-multi' : 'lookup';
  if (type === 'name' || type === 'address') return 'composite';
  if (NUMBER_TYPES.has(type) || /^[A-Z]{3}$/.test(type)) return 'number';
  if (type === 'date') return 'date';
  if (type === 'datetime') return 'datetime';
  if (type === 'checkbox' || type === 'decision box' || type === 'decisionbox') return 'bool';
  if (type === 'picklist' || type === 'radiobuttons' || type === 'radio') return 'choice';
  if (type === 'list' || type === 'checkboxes' || type === 'multiselect') return 'multi';
  if (type === 'upload file' || type === 'image' || type === 'signature' || type === 'video' || type === 'audio') return 'file';
  return 'text';
}

const ROWID_BASE = 3_000_000_000_001;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateText(r: Rng, time: boolean): string {
  const d = 1 + Math.floor(r() * 28);
  const text = `${String(d).padStart(2, '0')}-${pick(r, MONTHS)}-${2020 + Math.floor(r() * 8)}`;
  return time ? `${text} ${String(Math.floor(r() * 24)).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}:00` : text;
}

function choices(field: Field): string[] {
  return field.choices && field.choices.length ? field.choices : ['Option 1', 'Option 2'];
}

export interface GenOptions {
  /** Rows for a subform field. */
  subformRows: number;
}

export function fieldValue(field: Field, variant: Variant, r: Rng, opts: GenOptions): unknown {
  const fam = family(field);
  if (fam === null) return undefined;
  if (variant === 'null') return null;
  if (fam === 'subform') {
    if (variant === 'empty') return [];
    if (variant === 'wrong-type') return pick(r, ['row', 7, { not: 'a list' }]);
    const n = variant === 'boundary' ? Math.max(opts.subformRows, 3) : opts.subformRows;
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < n; i++) {
      const row: Record<string, unknown> = { ID: String(ROWID_BASE + 500 + i) };
      for (const sub of field.subfields) {
        const v = fieldValue(sub, variant === 'boundary' ? pick(r, VARIANTS) : 'valid', r, { subformRows: 0 });
        if (v !== undefined) row[sub.name] = v;
      }
      rows.push(row);
    }
    return rows;
  }
  if (variant === 'empty') {
    if (fam === 'multi' || fam === 'lookup-multi') return [];
    if (fam === 'composite') return {};
    return '';
  }
  switch (fam) {
    case 'text':
      if (variant === 'boundary') return pick(r, ['x'.repeat(255), 'x'.repeat(256), ' ', 'é中😀', 'a@b.c']);
      if (variant === 'wrong-type') return pick(r, [42, true, ['a'], { a: 1 }]);
      return pick(r, ['alpha', 'user@example.com', 'Line one', '42', 'https://example.com']);
    case 'number':
      if (variant === 'boundary') return pick(r, [0, -1, 2 ** 53 - 1, -(2 ** 53 - 1), 0.1, 1e21]);
      if (variant === 'wrong-type') return pick(r, ['abc', true, [1], { n: 1 }]);
      return pick(r, [1, 7, 100, 12.5]);
    case 'date':
    case 'datetime':
      if (variant === 'boundary') return pick(r, fam === 'date' ? ['29-Feb-2024', '01-Jan-1970', '31-Dec-9999'] : ['29-Feb-2024 23:59:59', '01-Jan-1970 00:00:00']);
      if (variant === 'wrong-type') return pick(r, ['not a date', 12, true, '32-Foo-2020']);
      return dateText(r, fam === 'datetime');
    case 'bool':
      if (variant === 'boundary') return pick(r, [false, 'false']);
      if (variant === 'wrong-type') return pick(r, ['yes', 2, []]);
      return pick(r, [true, false]);
    case 'choice': {
      const cs = choices(field);
      if (variant === 'boundary') return cs[cs.length - 1];
      if (variant === 'wrong-type') return pick(r, [3, ['x'], { v: 1 }]);
      return pick(r, cs);
    }
    case 'multi': {
      const cs = choices(field);
      if (variant === 'boundary') return [...cs];
      if (variant === 'wrong-type') return pick(r, ['x', 9, { v: 1 }]);
      return [pick(r, cs)];
    }
    case 'lookup':
      if (variant === 'boundary') return pick(r, [String(ROWID_BASE), '0', String(2 ** 53)]);
      if (variant === 'wrong-type') return pick(r, [{ ID: 1 }, ['1'], true]);
      return String(ROWID_BASE + Math.floor(r() * 3));
    case 'lookup-multi':
      if (variant === 'boundary') return [String(ROWID_BASE), String(ROWID_BASE + 1), String(ROWID_BASE + 2)];
      if (variant === 'wrong-type') return pick(r, [String(ROWID_BASE), 5, { ID: 1 }]);
      return [String(ROWID_BASE + Math.floor(r() * 3))];
    case 'composite': {
      if (variant === 'wrong-type') return pick(r, ['Ada Lovelace', 3, []]);
      const out: Record<string, unknown> = {};
      for (const sub of field.subfields) out[sub.name] = variant === 'boundary' ? 'x'.repeat(255) : 'Part';
      return out;
    }
    case 'file':
      if (variant === 'boundary') return pick(r, ['', 'a'.repeat(255) + '.png']);
      if (variant === 'wrong-type') return pick(r, [7, { name: 1 }]);
      return 'file.png';
  }
}

/**
 * One record for `form`. `mode` fixes every field's variant; `mixed` draws a
 * variant per field.
 */
export function recordFor(form: Form | undefined, mode: Variant | 'mixed', r: Rng, opts: GenOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!form) return out;
  for (const field of form.fields) {
    const v = fieldValue(field, mode === 'mixed' ? pick(r, VARIANTS) : mode, r, opts);
    if (v !== undefined) out[field.name] = v;
  }
  return out;
}

/** Dry-run Data Store rows: `rows` valid records per form, with ROWID and ID. */
export function seedRows(app: App, rows: number, r: Rng): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const form of app.forms) {
    const list: Record<string, unknown>[] = [];
    for (let i = 0; i < rows; i++) {
      const id = String(ROWID_BASE + i);
      list.push({ ...recordFor(form, 'valid', r, { subformRows: 1 }), ROWID: id, ID: id });
    }
    out[form.name] = list;
  }
  return out;
}

/** Deluge parameter type from a signature such as `void f(int id, list xs)`. */
export function signatureParams(signature: string | undefined): { type: string; name: string }[] {
  const m = signature ? /\(([^)]*)\)/.exec(signature) : null;
  if (!m || !m[1]!.trim()) return [];
  return m[1]!.split(',').map((part) => {
    const words = part.trim().split(/\s+/);
    return { type: (words.length > 1 ? words[0]! : '').toLowerCase(), name: words[words.length - 1]! };
  });
}

/** Value for a Deluge parameter type. */
export function paramValue(type: string, variant: Variant, r: Rng): unknown {
  if (variant === 'null') return null;
  const asField = (t: string): Field => ({ name: 'p', type: t, modifiers: [], required: false, unique: false, properties: [], subfields: [], annotations: [], flags: [], span: { start: 0, end: 0 } });
  switch (type) {
    case 'int':
    case 'bigint':
    case 'decimal':
    case 'float':
      return fieldValue(asField('number'), variant, r, { subformRows: 1 });
    case 'date':
      return fieldValue(asField('date'), variant, r, { subformRows: 1 });
    case 'datetime':
    case 'time':
      return fieldValue(asField('datetime'), variant, r, { subformRows: 1 });
    case 'bool':
    case 'boolean':
      return fieldValue(asField('checkbox'), variant, r, { subformRows: 1 });
    case 'list':
      if (variant === 'empty') return [];
      if (variant === 'wrong-type') return 'x';
      return variant === 'boundary' ? [String(ROWID_BASE), String(ROWID_BASE + 1), String(ROWID_BASE + 2)] : [String(ROWID_BASE)];
    case 'map':
      if (variant === 'empty') return {};
      if (variant === 'wrong-type') return ['x'];
      return { key: 'value', ID: String(ROWID_BASE) };
    default:
      return fieldValue(asField('text'), variant, r, { subformRows: 1 });
  }
}

/** Value for a client prefetch slot (a server read whose type the client does not declare). */
export function slotValue(r: Rng): unknown {
  return pick(r, [null, '', 'alpha', 0, 1, 7, true, false, [], ['alpha'], [String(ROWID_BASE)], { ID: String(ROWID_BASE) }]);
}
