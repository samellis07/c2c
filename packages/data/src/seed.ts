import type { App, Field } from '../../core/src/ir.js';
import { compareEnUs } from '../../core/src/order.js';
import { fieldTypeRow, normalizeType } from '../../schema/src/mapping.js';
import { generateSchema, linkedTableName, schemaIdent, type SchemaPlan, type SchemaTable } from '../../schema/src/generator.js';
import { tableNameLengthBlocker, type LimitBlocker } from '../../schema/src/limits.js';
import { encodeMultiValue } from '../../shims/src/multi-value.js';
import { writableCompositeParts } from '../../ui/src/index.js';
import { formDateOrderRules } from '../../deluge/src/index.js';

export interface SeedWarning {
  form: string;
  field?: string;
  message: string;
}

export interface SeedFile {
  form: string;
  fileName: string;
  csv: string;
}

/** Sample file written next to seed.json. The cell value is this file name. */
export interface SeedFixtureFile {
  /** One path segment. The loader reads it from the seed directory. */
  name: string;
  bytes: Uint8Array;
  /** Content-Type sent with the upload. */
  contentType: string;
}

export interface SeedResult {
  seed: string;
  n: number;
  /** Parent forms before forms that look them up. */
  order: string[];
  files: SeedFile[];
  /**
   * One sample file per image, signature, file, audio, or video field.
   * A unique field gets one file per row so the stored keys differ.
   * Image and signature bytes are a PNG. The others are a PDF.
   * The loader uploads the file and stores the Stratus object key.
   */
  fixtureFiles: SeedFixtureFile[];
  warnings: SeedWarning[];
  blockers: SeedWarning[];
  /**
   * Canonical seed rows (`docs/seed-schema.md`): one stable source id per
   * row, lookup cells holding the parent row's source id. What
   * `c2c seed --out` writes as `seed.json` for `migrate-data --seed`.
   */
  tables: SeedGenTable[];
  /**
   * Table-name length blockers for the tables this seed emits.
   * The same helper the schema plan uses. Omitted when there are none.
   */
  limitBlockers?: LimitBlocker[];
}

export interface SeedGenRow {
  /** Stable source id: `<form>#<seed-tag>#<row>`. Same inputs, same ids. */
  id: string;
  columns: Record<string, string>;
}

export interface SeedGenTable {
  form: string;
  rows: SeedGenRow[];
}

/**
 * Reserved `seed.json` key carrying the blocked-form records `c2c seed`
 * produced: `{form, field?, reason}`. Not a table — the loader names each
 * entry and refuses to call a blocked table's absence silent.
 */
export const SEED_BLOCKED_KEY = 'c2c_blocked';

/** Serialize canonical generator rows to the `seed.json` file format. */
export function canonicalSeedJson(tables: readonly SeedGenTable[], blocked?: readonly SeedWarning[]): string {
  const file: Record<string, unknown> = {};
  if (blocked?.length) {
    file[SEED_BLOCKED_KEY] = blocked.map((b) => ({ form: b.form, ...(b.field ? { field: b.field } : {}), reason: b.message }));
  }
  for (const table of tables) {
    file[table.form] = table.rows.map((row) => ({ c2c_source_id: row.id, ...row.columns }));
  }
  return `${JSON.stringify(file, null, 2)}\n`;
}

const SKIP = new Set(['section', 'add-notes', 'formula', 'auto-number', 'prediction', 'geolocation', 'subform']);

type CellKind = 'text' | 'email' | 'phone' | 'number' | 'decimal' | 'date' | 'datetime' | 'time' | 'bool' | 'choice' | 'json' | 'url' | 'lookup' | 'file' | 'image';

/** 1×1 PNG. Every image and signature field uses these bytes. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
  0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** Small PDF. File upload, audio, and video fields use these bytes. */
const PDF_BYTES = new TextEncoder().encode(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 3 3]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/** One stored column of a composite field. `part` is the Creator sub-field name. */
export interface SeedCompositePart {
  part: string;
  column: string;
}

/** Seed table → Creator field name → part columns, in part order. */
export type SeedCompositeMap = Record<string, Record<string, SeedCompositePart[]>>;

interface SeedColumn {
  name: string;
  kind: CellKind;
  unique: boolean;
  required?: boolean;
  choices?: string[];
  lookupForm?: string;
  lookupField?: string;
  /** Back-reference on an inline-subform child table. The cell is that parent's source id. */
  isParentId?: boolean;
  /** 0-based position of an inline-subform row under its parent. */
  isRowOrder?: boolean;
  /** Set on a composite part column. */
  part?: string;
  isMulti?: boolean;
  dateOffset?: number;
}

const NAME_PARTS = ['prefix', 'first_name', 'last_name', 'suffix'] as const;
const ADDRESS_PARTS = ['address_line_1', 'address_line_2', 'district_city', 'state_province', 'postal_code', 'country', 'latitude', 'longitude'] as const;
const FIRST = ['Avery', 'Blake', 'Casey', 'Drew', 'Ellis', 'Finley', 'Gray', 'Harper'];
const LAST = ['Adler', 'Brooks', 'Carter', 'Dale', 'Ellis', 'Ford', 'Gray', 'Hayes'];
const PREFIXES = ['Mx', 'Ms', 'Mr', 'Dr'];
const SUFFIXES = ['Jr', 'Sr', 'II', 'III'];
const CITIES = ['Austin', 'Bend', 'Cary', 'Dover', 'Ely', 'Flint', 'Greeley', 'Hale'];
const REGIONS = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE'];
const COUNTRIES = ['US', 'CA', 'GB', 'AU', 'IN', 'DE', 'FR', 'JP'];

function moduleOf(field: Field): string | undefined {
  return field.properties.find((p) => p.key.toLowerCase() === 'module')?.value;
}

function isSubform(field: Field): boolean {
  const token = normalizeType(field.type);
  return token === 'grid' || token === 'subform' || token === 'inline subform' || token === 'form';
}

/** Same identifier the schema generator uses for a column or table name. */
function storeIdent(raw: string, fallback: string): string {
  return schemaIdent(raw, fallback);
}

function schemaParentName(plan: SchemaPlan, seedName: string): string {
  if (plan.tables.some((table) => table.name === seedName)) return seedName;
  return plan.tables.find((table) => table.role === 'form' && table.form === seedName)?.name ?? seedName;
}

function allocRank(name: string, base: string): number {
  if (name === base) return 0;
  if (!name.startsWith(`${base}_`)) return 1000;
  const suffix = name.slice(base.length + 1);
  return /^[1-9]\d*$/.test(suffix) ? Number(suffix) : 1000;
}

function isAllocName(name: string, base: string): boolean {
  return allocRank(name, base) < 1000;
}

/** Junction the schema planned for this multi-lookup, including a collision suffix. */
function takeJunction(plan: SchemaPlan, parentTable: string, fieldName: string, lookupForm: string, used: Set<string>): SchemaTable | undefined {
  const base = linkedTableName(parentTable, fieldName, 'link');
  const columnBase = schemaIdent(fieldName, 'link');
  const target = plan.tables.find((table) => table.role === 'form' && table.form === lookupForm)?.name;
  const candidates = plan.tables.filter((table) => {
    if (table.role !== 'junction' || used.has(table.name) || !isAllocName(table.name, base)) return false;
    const parent = table.columns.find((column) => column.name === 'parent_id')?.relation?.table;
    if (parent !== parentTable) return false;
    const link = table.columns.find((column) => column.relation && column.name !== 'parent_id');
    if (!link) return false;
    if (target && link.relation?.table !== target) return false;
    if (link.field === fieldName || link.name === columnBase) return true;
    return link.name.startsWith(`${columnBase}_`) && /^[1-9]\d*$/.test(link.name.slice(columnBase.length + 1));
  });
  candidates.sort((a, b) => allocRank(a.name, base) - allocRank(b.name, base) || (a.name < b.name ? -1 : 1));
  const chosen = candidates[0];
  if (chosen) used.add(chosen.name);
  return chosen;
}

function partChoices(field: Field | undefined): string[] | undefined {
  if (!field) return undefined;
  if (field.choices?.length) return field.choices;
  const raw = field.properties.find((p) => p.key.toLowerCase() === 'value')?.value?.trim();
  if (!raw || !raw.startsWith('{') || !raw.endsWith('}')) return undefined;
  const out: string[] = [];
  for (const match of raw.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.push(match[1]!.replace(/\\"/g, '"'));
  return out.length ? out : undefined;
}

function compositePartNames(field: Field): string[] | undefined {
  const row = fieldTypeRow(field.type);
  if (row?.kind !== 'composite') return undefined;
  if (field.subfields.length) return field.subfields.map((sub) => sub.name);
  return [...(row.id === 'address' ? ADDRESS_PARTS : NAME_PARTS)];
}

/** Schema column for a composite part, skipping names already taken on this table. */
function claimComposite(table: SchemaTable | undefined, raw: string, claimed: Set<string>): string {
  const base = storeIdent(raw, 'col');
  const candidates = [base];
  for (let i = 2; i < 30; i++) candidates.push(`${base}_${i}`);
  for (const name of candidates) {
    if (claimed.has(name)) continue;
    if (!table || table.columns.some((column) => column.name === name)) {
      claimed.add(name);
      return name;
    }
  }
  claimed.add(base);
  return base;
}

function columnsFor(field: Field, table: SchemaTable | undefined, claimed: Set<string>, allowedParts?: Set<string>): SeedColumn[] | undefined {
  if (isSubform(field)) return undefined;
  const token = normalizeType(field.type);
  if (field.lookup) {
    const isMulti = token === 'multiselect' || token === 'list' || token === 'multi select' || token === 'checkbox' || token === 'checkboxes';
    claimed.add(field.name);
    return [{
      name: field.name,
      kind: 'lookup',
      unique: field.unique,
      required: field.required,
      lookupForm: field.lookup.form,
      lookupField: field.lookup.field,
      isMulti,
    }];
  }
  if (normalizeType(moduleOf(field)) === 'users' || token === 'users' || token === 'user') {
    claimed.add(field.name);
    return [{ name: field.name, kind: 'number', unique: field.unique }];
  }
  const row = fieldTypeRow(field.type);
  if (!row || SKIP.has(row.id) || row.kind === 'none') return undefined;
  let parts = compositePartNames(field);
  if (parts) {
    if (allowedParts) {
      parts = parts.filter((part) => allowedParts.has(part));
    }
    return parts.map((part) => {
      const sub = field.subfields.find((item) => item.name === part);
      const choices = partChoices(sub);
      const kind: CellKind = normalizeType(part) === 'latitude' || normalizeType(part) === 'longitude' ? 'decimal' : 'text';
      return {
        name: claimComposite(table, `${field.name}_${part}`, claimed),
        kind,
        unique: false,
        part,
        ...(choices ? { choices } : {}),
      };
    });
  }
  if (row.kind === 'stratus-key' && table?.role !== 'child') {
    const kind: CellKind = row.id === 'image' || row.id === 'signature' ? 'image' : 'file';
    claimed.add(field.name);
    return [{ name: field.name, kind, unique: field.unique }];
  }
  if (row.id === 'checkbox-multi' || row.id === 'multi-select' || (token === 'checkbox' && (field.choices?.length ?? 0) > 0)) {
    claimed.add(field.name);
    return [{ name: field.name, kind: 'json', unique: field.unique, required: field.required, choices: field.choices }];
  }
  const kind: CellKind =
    row.id === 'email' ? 'email'
    : row.id === 'phone' ? 'phone'
    : row.id === 'number' || row.id === 'users' || row.id === 'legacy-crm-link' ? 'number'
    : row.id === 'decimal' || row.id === 'percent' || row.id === 'currency' ? 'decimal'
    : row.id === 'date' ? 'date'
    : row.id === 'date-time' ? 'datetime'
    : row.id === 'time' ? 'time'
    : row.id === 'decision-box' ? 'bool'
    : row.id === 'dropdown' || row.id === 'radio' ? 'choice'
    : row.id === 'url' ? 'url'
    : 'text';
  claimed.add(field.name);
  return [{ name: field.name, kind, unique: field.unique, required: field.required, choices: field.choices }];
}

function compositePartValue(col: SeedColumn, row: number, tag: { text: string; n: number }): string {
  if (col.choices?.length) return col.choices[(row + (tag.n % 997)) % col.choices.length]!;
  const token = normalizeType(col.part);
  const i = (row + tag.n) % FIRST.length;
  switch (token) {
    case 'prefix':
      return PREFIXES[i % PREFIXES.length]!;
    case 'first name':
      return FIRST[i]!;
    case 'last name':
      return LAST[(i + 3) % LAST.length]!;
    case 'suffix':
      return SUFFIXES[i % SUFFIXES.length]!;
    case 'address line 1':
      return `${100 + (row % 900)} ${LAST[i]} Street`;
    case 'address line 2':
      return `Unit ${(row % 40) + 1}`;
    case 'district city':
      return CITIES[i]!;
    case 'state province':
      return REGIONS[i]!;
    case 'postal code':
      return String(10000 + ((row * 17 + tag.n) % 89999)).padStart(5, '0');
    case 'country':
      return COUNTRIES[i % COUNTRIES.length]!;
    case 'latitude':
      return (8 + (row % 60) + (tag.n % 100) / 1000).toFixed(4);
    case 'longitude':
      return (-120 + (row % 60) + (tag.n % 100) / 1000).toFixed(4);
    default:
      return `${tag.text}-${col.part}-${row}`;
  }
}

function cellValue(col: SeedColumn, row: number, tag: { text: string; n: number }, orderIndex?: number): string {
  if (col.kind === 'lookup') return '';
  if (col.isRowOrder) return String(orderIndex ?? 0);
  if (col.part) return compositePartValue(col, row, tag);
  return scalar(col, row, tag);
}

function seedTag(seed: string): { text: string; n: number } {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const n = h >>> 0;
  return { text: n.toString(16), n };
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((part) => parseInt(part, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

function scalar(col: SeedColumn, row: number, tag: { text: string; n: number }): string {
  const shift = tag.n % 997;
  switch (col.kind) {
    case 'email':
      return `user${row}.${tag.text}@example.com`;
    case 'phone':
      return String(9000000000 + row);
    case 'number':
      return String(1000 + row + shift * 100000);
    case 'decimal':
      return (100 + row + (shift % 50)).toFixed(2);
    case 'date':
      return addDays('2020-01-01', row + (shift % 28) + (col.dateOffset ?? 0));
    case 'datetime':
      return `${addDays('2020-01-01', row + (shift % 28) + (col.dateOffset ?? 0))}T00:00:00`;
    case 'time':
      return `${String(row % 24).padStart(2, '0')}:00:00`;
    case 'bool':
      return (row + shift) % 2 === 0 ? 'true' : 'false';
    case 'choice': {
      const list = col.choices;
      if (!list?.length) return '';
      return list[(row + shift) % list.length];
    }
    case 'json': {
      const list = col.choices;
      if (!list?.length) return '';
      return encodeMultiValue([list[(row + shift) % list.length]]) ?? '';
    }
    case 'image':
    case 'file':
      return fixtureFileName(col, row, tag.text);
    case 'url':
      return `https://example.com/${tag.text}/${row}`;
    default:
      return col.unique ? `${tag.text}-value-${row}` : `${tag.text}-value`;
  }
}

/** Fixture file name for one cell. A single path segment, stable for the same inputs. */
function fixtureFileName(col: SeedColumn, row: number, tag: string): string {
  const safe = col.name.replace(/[^A-Za-z0-9_]/g, '') || 'file';
  const ext = col.kind === 'image' ? 'png' : 'pdf';
  const suffix = col.unique ? `-value-${row}` : '-value';
  return `${tag}-${safe}${suffix}.${ext}`;
}

function formOrder(names: string[], deps: Map<string, Set<string>>): string[] {
  const known = new Set(names);
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const name of names) {
    indegree.set(name, 0);
    children.set(name, []);
  }
  for (const name of names) {
    for (const dep of deps.get(name) ?? []) {
      if (dep === name || !known.has(dep)) continue;
      indegree.set(name, indegree.get(name)! + 1);
      children.get(dep)!.push(name);
    }
  }
  const ready = names.filter((name) => indegree.get(name) === 0).sort((a, b) => compareEnUs(a, b));
  const order: string[] = [];
  while (ready.length) {
    const next = ready.shift()!;
    order.push(next);
    for (const child of children.get(next) ?? []) {
      const left = indegree.get(child)! - 1;
      indegree.set(child, left);
      if (left === 0) {
        ready.push(child);
        ready.sort((a, b) => compareEnUs(a, b));
      }
    }
  }
  for (const name of [...names].sort((a, b) => compareEnUs(a, b))) if (!order.includes(name)) order.push(name);
  return order;
}

function fileName(form: string): string {
  return `${form.replace(/[^A-Za-z0-9_-]+/g, '_') || 'form'}.csv`;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

/**
 * Distinct target-row indexes for one parent. At most `len` picks.
 * The step starts at 7 and moves to the next step that shares no divisor
 * with `len`, so the same start always repeats and a short list never repeats a row.
 */
function distinctTargetIndexes(start: number, requested: number, len: number): number[] {
  if (len <= 0 || requested <= 0) return [];
  const count = Math.min(requested, len);
  let stride = 7 % len;
  if (stride === 0) stride = 1;
  while (gcd(stride, len) !== 1) stride = (stride % len) + 1;
  const origin = start % len;
  const indexes: number[] = [];
  for (let j = 0; j < count; j++) indexes.push((origin + j * stride) % len);
  return indexes;
}

function displayColumn(_name: string, cols: SeedColumn[], incoming: SeedColumn[]): number {
  const wanted = new Set(incoming.filter((col) => col.lookupField && col.lookupField.toLowerCase() !== 'id').map((col) => col.lookupField!));
  const named = cols.findIndex((col) => wanted.has(col.name));
  if (named >= 0) return named;
  const text = cols.findIndex((col) => col.kind === 'text' || col.kind === 'email' || col.kind === 'choice' || col.kind === 'phone');
  if (text >= 0) return text;
  return cols.length ? 0 : -1;
}

interface PlannedTable {
  name: string;
  cols: SeedColumn[];
  needs: Set<string>;
  parentForm?: string;
  /** On a child table, the subform field on the parent form it stores. */
  parentField?: string;
}

function formNameForTable(plan: SchemaPlan, tableName: string): string | undefined {
  return plan.tables.find((table) => table.name === tableName && table.role === 'form')?.form;
}

function planTables(app: App, plan: SchemaPlan): { tables: PlannedTable[]; composites: SeedCompositeMap } {
  const composites: SeedCompositeMap = {};
  const planned: PlannedTable[] = [];
  const writableParts = writableCompositeParts(app);
  const remember = (tableName: string, field: Field, cols: SeedColumn[]) => {
    const parts = cols.filter((col) => col.part);
    if (!parts.length) return;
    (composites[tableName] ??= {})[field.name] = parts.map((col) => ({ part: col.part!, column: col.name }));
  };
  for (const form of app.forms) {
    const schemaTable = plan.tables.find((table) => table.role === 'form' && table.form === form.name);
    const cols: SeedColumn[] = [];
    const needs = new Set<string>();
    const claimed = new Set<string>();
    const formWritable = writableParts.get(form.name);
    for (const field of form.fields) {
      const allowedParts = formWritable?.get(field.name);
      const fieldCols = columnsFor(field, schemaTable, claimed, allowedParts);
      if (!fieldCols) continue;
      remember(form.name, field, fieldCols);
      for (const col of fieldCols) {
        cols.push(col);
        if (col.kind === 'lookup' && col.lookupForm) needs.add(col.lookupForm);
      }
    }
    if (schemaTable) {
      for (const column of schemaTable.columns) {
        if (column.matrixId !== 'subform' || !column.relation) continue;
        if (cols.some((col) => col.name === column.name)) continue;
        const parent = formNameForTable(plan, column.relation.table);
        if (!parent) continue;
        cols.push({ name: column.name, kind: 'lookup', unique: false, lookupForm: parent });
        needs.add(parent);
        claimed.add(column.name);
      }
    }
    planned.push({ name: form.name, cols, needs });
  }
  for (const table of plan.tables) {
    if (table.role !== 'child' || !table.subform) continue;
    const form = app.forms.find((item) => item.name === table.subform!.form);
    const field = form?.fields.find((item) => item.name === table.subform!.field);
    if (!field) continue;
    const cols: SeedColumn[] = [];
    const needs = new Set<string>();
    const claimed = new Set<string>();
    const parentColumn = table.subform.parentColumn;
    const orderColumn = table.subform.orderColumn;
    cols.push({ name: parentColumn, kind: 'lookup', unique: false, lookupForm: table.subform.form, isParentId: true });
    needs.add(table.subform.form);
    claimed.add(parentColumn);
    cols.push({ name: orderColumn, kind: 'number', unique: false, isRowOrder: true });
    claimed.add(orderColumn);
    const childWritable = writableParts.get(table.name);
    for (const sub of field.subfields) {
      const allowedParts = childWritable?.get(sub.name);
      const fieldCols = columnsFor(sub, table, claimed, allowedParts);
      if (!fieldCols) continue;
      remember(table.name, sub, fieldCols);
      for (const col of fieldCols) {
        cols.push(col);
        if (col.kind === 'lookup' && col.lookupForm) needs.add(col.lookupForm);
      }
    }
    planned.push({ name: table.name, cols, needs, parentForm: table.subform.form, parentField: table.subform.field });
  }
  return { tables: planned, composites };
}

/** Part columns for every name and address field, keyed by the seed table name. */
export function seedCompositeMap(app: App, plan?: SchemaPlan): SeedCompositeMap {
  return planTables(app, plan ?? generateSchema(app)).composites;
}

export function generateSeed(app: App, opts?: { n?: number; seed?: string }): SeedResult {
  const n = opts?.n ?? 50;
  if (!Number.isInteger(n) || n < 0) throw new Error('c2c seed: --n must be a non-negative integer');
  const seed = opts?.seed || app.name || 'app';
  const tag = seedTag(seed);
  const warnings: SeedWarning[] = [];
  const blockers: SeedWarning[] = [];
  const schemaPlan = generateSchema(app);
  const planned = planTables(app, schemaPlan);

  for (const table of planned.tables) {
    const { constraints, unsupportedRules } = formDateOrderRules(app, table.name);
    for (const rule of unsupportedRules) {
      warnings.push({
        form: table.name,
        message: `date order rule on ${table.name} cannot be satisfied generically: ${rule}`,
      });
    }
    if (constraints.length > 0) {
      const inDegree = new Map<string, number>();
      const adj = new Map<string, Set<string>>();
      for (const c of constraints) {
        if (!adj.has(c.earlierField)) adj.set(c.earlierField, new Set());
        if (!adj.get(c.earlierField)!.has(c.laterField)) {
          adj.get(c.earlierField)!.add(c.laterField);
          inDegree.set(c.laterField, (inDegree.get(c.laterField) ?? 0) + 1);
        }
        if (!inDegree.has(c.earlierField)) inDegree.set(c.earlierField, 0);
      }

      const queue: string[] = [];
      const rank = new Map<string, number>();
      for (const [node, deg] of inDegree.entries()) {
        if (deg === 0) {
          queue.push(node);
          rank.set(node, 0);
        }
      }

      let visitedCount = 0;
      while (queue.length > 0) {
        const u = queue.shift()!;
        visitedCount++;
        const uRank = rank.get(u) ?? 0;
        const neighbors = adj.get(u) ?? new Set();
        for (const v of neighbors) {
          rank.set(v, Math.max(rank.get(v) ?? 0, uRank + 1));
          const newDeg = (inDegree.get(v) ?? 1) - 1;
          inDegree.set(v, newDeg);
          if (newDeg === 0) {
            queue.push(v);
          }
        }
      }

      if (visitedCount < inDegree.size) {
        warnings.push({
          form: table.name,
          message: `date-order rules on ${table.name} contain a cycle; date ordering cannot be satisfied generically`,
        });
      } else {
        for (const col of table.cols) {
          if (col.kind === 'date' || col.kind === 'datetime') {
            const r = rank.get(col.name);
            if (r !== undefined) {
              col.dateOffset = r * 7;
            }
          }
        }
      }
    }
  }

  const columns = new Map<string, SeedColumn[]>();
  const deps = new Map<string, Set<string>>();
  const parentOf = new Map<string, string>();
  const blockedTables = new Set<string>();
  for (const table of planned.tables) {
    let tableBlocked = false;
    if (table.name === SEED_BLOCKED_KEY) {
      blockers.push({
        form: table.name,
        message: `form name ${SEED_BLOCKED_KEY} is reserved for the seed blocker record; rename the form`,
      });
      tableBlocked = true;
    }
    for (const col of table.cols) {
      if ((col.kind === 'choice' || col.kind === 'json') && !(col.choices?.length)) {
        if (col.required) {
          blockers.push({
            form: table.name,
            field: col.name,
            message: `required choice field has no choices; add choices in the source app or make it optional`,
          });
          tableBlocked = true;
        } else {
          warnings.push({
            form: table.name,
            field: col.name,
            message: `${col.name} is a choice field with no choices. Cells are left empty.`,
          });
        }
      }
    }
    if (tableBlocked) blockedTables.add(table.name);
  }
  const plannedNames = new Set(planned.tables.map((table) => table.name));
  // A blocked table propagates: a required lookup to it can never resolve, so
  // the dependent is blocked too (transitively); an inline-subform child table
  // and a form embedded as a linked subform have no parent rows to hang from,
  // so they are blocked with it.
  let changed = true;
  while (changed) {
    changed = false;
    for (const table of planned.tables) {
      if (blockedTables.has(table.name)) continue;
      const hit = table.cols.find(
        (col) => col.required && col.kind === 'lookup' && !col.isParentId && col.lookupForm !== undefined && blockedTables.has(col.lookupForm),
      );
      if (!hit) continue;
      blockers.push({
        form: table.name,
        field: hit.name,
        message: `depends on blocked form ${hit.lookupForm} (required lookup ${hit.name})`,
      });
      blockedTables.add(table.name);
      changed = true;
    }
    for (const table of planned.tables) {
      if (!table.parentForm || !blockedTables.has(table.parentForm) || blockedTables.has(table.name)) continue;
      blockers.push({
        form: table.name,
        field: table.parentField,
        message: `depends on blocked form ${table.parentForm} (subform field ${table.parentField})`,
      });
      blockedTables.add(table.name);
      changed = true;
    }
    for (const form of app.forms) {
      if (!blockedTables.has(form.name)) continue;
      for (const field of form.fields) {
        const child = isSubform(field) ? field.lookup?.form : undefined;
        if (!child || !plannedNames.has(child) || blockedTables.has(child)) continue;
        blockers.push({
          form: child,
          field: field.name,
          message: `depends on blocked form ${form.name} (subform field ${field.name})`,
        });
        blockedTables.add(child);
        changed = true;
      }
    }
  }
  for (const table of planned.tables) {
    if (blockedTables.has(table.name)) continue;
    columns.set(table.name, table.cols);
    deps.set(table.name, table.needs);
    if (table.parentForm) parentOf.set(table.name, table.parentForm);
  }
  const unblockedTables = planned.tables.filter((table) => !blockedTables.has(table.name));
  const order = formOrder(unblockedTables.map((table) => table.name), deps);
  const fixtureFiles: SeedFixtureFile[] = [];
  const fixtureSeen = new Set<string>();
  const grid = new Map<string, string[][]>();
  const childParentIndex = new Map<string, number[]>();
  for (const name of order) {
    const cols = columns.get(name) ?? [];
    const rows: string[][] = [];
    const cellWithFixture = (col: SeedColumn, i: number, orderIndex?: number): string => {
      const value = cellValue(col, i, tag, orderIndex);
      if ((col.kind === 'image' || col.kind === 'file') && !fixtureSeen.has(value)) {
        fixtureSeen.add(value);
        fixtureFiles.push({
          name: value,
          bytes: col.kind === 'image' ? PNG_BYTES : PDF_BYTES,
          contentType: col.kind === 'image' ? 'image/png' : 'application/pdf',
        });
      }
      return value;
    };
    const parentName = parentOf.get(name);
    if (parentName) {
      const parents: number[] = [];
      let childIndex = 0;
      for (let p = 0; p < n; p++) {
        const count = (tag.n + p) % 3 + 1;
        for (let j = 0; j < count; j++) {
          rows.push(cols.map((col) => cellWithFixture(col, childIndex, j)));
          parents.push(p);
          childIndex++;
        }
      }
      childParentIndex.set(name, parents);
    } else {
      for (let i = 0; i < n; i++) rows.push(cols.map((col) => cellWithFixture(col, i)));
    }
    for (const col of cols) {
      if (!col.unique || !col.choices?.length || col.choices.length >= rows.length || rows.length === 0) continue;
      warnings.push({
        form: name,
        field: col.name,
        message: `Unique picklist ${col.name} has ${col.choices.length} choices and n=${rows.length}. Values stay inside the list, so some repeat.`,
      });
    }
    grid.set(name, rows);
  }
  const incoming = new Map<string, SeedColumn[]>();
  // determinism-allow: lookup field names go into a Set, so Map order never reaches seed bytes
  for (const cols of columns.values()) {
    for (const col of cols) {
      if (col.kind !== 'lookup' || !col.lookupForm) continue;
      const list = incoming.get(col.lookupForm) ?? [];
      list.push(col);
      incoming.set(col.lookupForm, list);
    }
  }
  const displayIndex = new Map<string, number>();
  for (const name of order) displayIndex.set(name, displayColumn(name, columns.get(name) ?? [], incoming.get(name) ?? []));
  // Stable source ids, scoped by the seed tag so two seed values never reconcile as the same rows.
  const stableIds = new Map<string, string[]>();
  for (const name of order) {
    const count = grid.get(name)?.length ?? 0;
    stableIds.set(name, Array.from({ length: count }, (_, i) => `${name}#${tag.text}#${i + 1}`));
  }
  // Canonical cells: scalars copied, lookups holding the parent source id (omitted when unresolvable).
  const canon = new Map<string, (string | undefined)[][]>();
  for (const name of order) {
    const cols = columns.get(name) ?? [];
    canon.set(name, (grid.get(name) ?? []).map((cells) => cells.map((cell, index) => (cols[index].kind === 'lookup' ? undefined : cell))));
  }
  for (const name of order) {
    const cols = columns.get(name) ?? [];
    const rows = grid.get(name) ?? [];
    const canonRows = canon.get(name) ?? [];
    cols.forEach((col, index) => {
      if (col.kind !== 'lookup' || !col.lookupForm) return;
      const parentRows = grid.get(col.lookupForm);
      const parentCol = displayIndex.get(col.lookupForm) ?? -1;
      const parentIds = stableIds.get(col.lookupForm);
      const parents = col.isParentId ? childParentIndex.get(name) : undefined;
      if (!parentRows?.length || !parentIds?.length || (parentCol < 0 && !col.isParentId) || (col.isParentId && parents?.length !== rows.length)) {
        warnings.push({
          form: name,
          field: col.name,
          message: blockedTables.has(col.lookupForm)
            ? `parent form ${col.lookupForm} is blocked; lookup left empty`
            : `Lookup ${col.name} has no parent display value in ${col.lookupForm}.`,
        });
        return;
      }
      for (let i = 0; i < rows.length; i++) {
        if (col.isMulti) {
          const requested = 1 + ((i + tag.n) % 3);
          const pickedVals = distinctTargetIndexes(i, requested, parentRows.length).map((picked) => parentRows[picked][parentCol]);
          rows[i][index] = pickedVals.join(',');
        } else {
          const target = parents ? parents[i]! : i % parentRows.length;
          if (parentCol >= 0) rows[i][index] = parentRows[target]![parentCol]!;
          canonRows[i][index] = parentIds[target];
        }
      }
    });
  }
  const files: SeedFile[] = order.map((name) => {
    const cols = columns.get(name) ?? [];
    const rows = grid.get(name) ?? [];
    const header = cols.map((col) => csvCell(col.name)).join(',');
    const body = rows.map((row) => row.map(csvCell).join(',')).join('\n');
    const csv = cols.length === 0 ? '\n' : `${header}\n${body}${body ? '\n' : ''}`;
    return { form: name, fileName: fileName(name), csv };
  });
  const tables: SeedGenTable[] = order.map((name) => {
    const cols = columns.get(name) ?? [];
    const rows = canon.get(name) ?? [];
    const ids = stableIds.get(name) ?? [];
    return {
      form: name,
      rows: rows.map((cells, i) => {
        const rowColumns: Record<string, string> = {};
        cols.forEach((col, index) => {
          const cell = cells[index];
          if (cell !== undefined) rowColumns[col.name] = cell;
        });
        return { id: ids[i], columns: rowColumns };
      }),
    };
  });
  const junctionUsed = new Set<string>();
  for (const name of order) {
    const cols = columns.get(name) ?? [];
    const ids = stableIds.get(name) ?? [];
    const parentTable = schemaParentName(schemaPlan, name);
    cols.forEach((col) => {
      if (!col.isMulti || col.kind !== 'lookup' || !col.lookupForm) return;
      const parentIds = stableIds.get(col.lookupForm);
      if (!parentIds?.length) return;
      const plannedJunction = takeJunction(schemaPlan, parentTable, col.name, col.lookupForm, junctionUsed);
      const link = plannedJunction?.columns.find((column) => column.relation && column.name !== 'parent_id');
      const orderColumn = plannedJunction?.columns.find((column) => column.name === 'row_order')?.name ?? 'row_order';
      const junctionName = plannedJunction?.name ?? linkedTableName(parentTable, col.name, 'link');
      const columnName = link?.name ?? schemaIdent(col.name, 'link');
      const junctionRows: { id: string; columns: Record<string, string> }[] = [];
      let junctionId = 1;
      for (let i = 0; i < ids.length; i++) {
        const requested = 1 + ((i + tag.n) % 3);
        let position = 0;
        for (const pickedIndex of distinctTargetIndexes(i, requested, parentIds.length)) {
          junctionRows.push({
            id: `${junctionName}#${tag.text}#${junctionId++}`,
            columns: {
              parent_id: ids[i],
              [orderColumn]: String(position++),
              [columnName]: parentIds[pickedIndex],
            },
          });
        }
      }
      tables.push({ form: junctionName, rows: junctionRows });
    });
  }
  const limitBlockers = tables.flatMap((item) => {
    const schemaTable = schemaPlan.tables.find((table) => table.name === item.form);
    const blocker = tableNameLengthBlocker(schemaTable?.form ?? item.form, item.form);
    return blocker ? [blocker] : [];
  });
  return { seed, n, order, files, fixtureFiles, warnings, blockers, tables, ...(limitBlockers.length ? { limitBlockers } : {}) };
}
