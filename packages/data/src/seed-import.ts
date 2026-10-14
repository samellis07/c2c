/**
 * `c2c seed --creator-import`: CSVs shaped for Zoho Creator's own report
 * "Import Data" UI, not for `migrate-data`. Creator resolves lookups on the
 * parent's display value, composite fields import as one dotted column per
 * sub-field, multi-value cells are comma-separated, and dates use the app's
 * dd-MMM-yyyy format. Subform rows are not an import file: the report importer
 * does not load them (Zoho KB, import-data-to-reports, Limitation 2). Those
 * forms get a manual worksheet outside IMPORT_ORDER.
 *
 * https://help.zoho.com/portal/en/kb/creator/developer-guide/reports/general-properties/articles/import-data-to-reports
 */

import { unquote, type App, type Field, type Form, type Report } from '../../core/src/ir.js';
import { compareEnUs } from '../../core/src/order.js';
import { fieldTypeRow, normalizeType } from '../../schema/src/mapping.js';

/** Report Import Data article. Limitation 2: subform import is not supported. */
const IMPORT_HELP =
  'https://help.zoho.com/portal/en/kb/creator/developer-guide/reports/general-properties/articles/import-data-to-reports';

export interface CreatorImportWarning {
  form: string;
  field?: string;
  message: string;
}

export interface CreatorImportFile {
  form: string;
  displayName?: string;
  fileName: string;
  csv: string;
  rowCount: number;
  /** Reports whose `show all rows from` is this form (import targets). */
  reports: { name: string; criteria?: string }[];
  /** Per-column notes for the README (lookup source, format, ...). */
  columnNotes: { column: string; note: string }[];
}

export interface CreatorImportSkipped {
  form: string;
  reason: string;
}

/** Hand-entry sheet for a form the report importer cannot load. Not an import file. */
export interface CreatorImportManual {
  form: string;
  fileName: string;
  /** Markdown body. */
  body: string;
  /** One line for the README. */
  summary: string;
}

export interface CreatorImportResult {
  seed: string;
  rows: number;
  order: string[];
  files: CreatorImportFile[];
  /** Worksheets written next to the CSVs but not listed as import steps. */
  manual: CreatorImportManual[];
  skipped: CreatorImportSkipped[];
  warnings: CreatorImportWarning[];
  /** `IMPORT_ORDER.txt` body. */
  orderText: string;
  /** `README.md` body. */
  readme: string;
}

const SUBFORM_TOKENS = new Set(['grid', 'subform', 'inline subform', 'form']);
const SKIP_ROWS = new Set([
  'section',
  'add-notes',
  'formula',
  'auto-number',
  'prediction',
  'geolocation',
  'integration',
  'keyword',
  'sentiment',
  'ocr',
  'object-detection',
  'barcode',
]);
/** File-like fields a CSV import cannot carry. */
const FILE_ROWS = new Set(['image', 'file-upload', 'audio', 'video', 'signature']);

type Kind =
  | 'text'
  | 'email'
  | 'phone'
  | 'number'
  | 'decimal'
  | 'date'
  | 'datetime'
  | 'time'
  | 'bool'
  | 'choice'
  | 'multi'
  | 'url'
  | 'lookup'
  | 'lookup-multi';

interface Column {
  /** CSV header: the field link name, or `Field.sub` for composite sub-fields. */
  name: string;
  kind: Kind;
  required: boolean;
  unique: boolean;
  choices?: string[];
  lookupForm?: string;
  /** Display-format path inside the parent form, e.g. `Serial_Number`. */
  lookupDisplay?: string;
  /** Display-format expression (`" " + Name.first_name + ...`), evaluated per parent row. */
  lookupExpr?: string;
  /** Lookup whose display format is the raw record ID. */
  lookupById?: boolean;
  note?: string;
  /** Drives the value pool for text-ish columns. */
  hint: string;
  maxLength?: number;
  min?: number;
  max?: number;
}

// ---------------------------------------------------------------------------
// deterministic random

function fnv(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// value pools — fictional, no real PII

const FIRST = ['Avery', 'Jordan', 'Priya', 'Mateo', 'Lin', 'Sofia', 'Owen', 'Nadia', 'Felix', 'Mei',
  'Ravi', 'Elena', 'Tomas', 'Ines', 'Devon', 'Kira', 'Oscar', 'Lena', 'Hugo', 'Tara'];
const LAST = ['Calloway', 'Reyes', 'Nakamura', 'Petrova', 'Haugen', 'Mbeki', 'Fontaine', 'Rossi',
  'Kowalski', 'Andrade', 'Lindqvist', 'Marsh', 'Delacroix', 'Tanaka', 'Verma', 'Osei',
  'Bergstrom', 'Costa', 'Novak', 'Ferrer'];
const COMPANY = ['Northwind Fabrication', 'Blue Harbour Goods', 'Copperline Works', 'Meridian Assembly',
  'Foxglove Manufacturing', 'Stonebridge Products', 'Alder & Pine Co', 'Juniper Industries'];
const MATERIAL = ['Steel hex bolt', 'Copper wire 2.5mm', 'Aluminium sheet 1mm', 'Oak plank 2m',
  'Rubber gasket 40mm', 'Brass hinge 3in', 'PVC pipe 25mm', 'Cotton canvas roll', 'Glass pane 30x40',
  'Nylon rope 10m', 'Stainless screw M4', 'Pine dowel 12mm', 'Acrylic panel clear', 'Leather strap 20mm',
  'Ceramic insulator', 'Galvanised nail 50mm', 'Birch plywood 9mm', 'Silicone sealant tube',
  'Carbon steel rod 6mm', 'Linen fabric roll'];
const PRODUCT = ['Harbour lantern', 'Deck chair folding', 'Mooring cleat set', 'Signal flag kit',
  'Brass compass desk', 'Canvas tool roll', 'Oak serving tray', 'Copper kettle 2L',
  'Rope door stop', 'Anchor bookend pair', 'Telescope tabletop', 'Ship wheel clock',
  'Lobster gauge ruler', 'Buoy lamp', 'Netted storage basket', 'Chart cabinet small',
  'Sailcloth tote', 'Rigging knife sheath', 'Tide clock', 'Wharfside stool'];
const GENERIC_ADJ = ['Standard', 'Premium', 'Compact', 'Heavy-duty', 'Lightweight', 'Classic'];
const GENERIC_NOUN = ['unit', 'assembly', 'component', 'kit', 'set', 'module', 'part', 'batch'];
const NOTES = ['Restocked after quarterly audit.', 'Preferred supplier, lead time 5 days.',
  'Check tolerance before use.', 'Bulk rate applies above 50 units.', 'Keeps 12 months in dry storage.',
  'Supersedes the previous revision.', 'Fixture row for import testing.'];
const STATUS_FALLBACK = ['Active'];

// ---------------------------------------------------------------------------

function prop(field: Field, key: string): string | undefined {
  const p = field.properties.find((x) => x.key.toLowerCase() === key);
  return p ? p.value.replace(/^"|"$/g, '') : undefined;
}

/** Strings of a `{"a","b"}` literal. Keeps trailing spaces inside quotes. */
function braceList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return undefined;
  const out: string[] = [];
  for (const m of t.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^,\s][^,]*)/g)) {
    if (m[1] !== undefined) out.push(unquote(`"${m[1]}"`));
    else if (m[2] !== undefined) out.push(unquote(`'${m[2]}'`));
    else out.push(m[3].trim());
  }
  return out.length ? out : undefined;
}

/**
 * Closed choice list for a field or a composite part.
 * Picklists use `values = {...}`. Name parts (prefix) use `value = {...}`.
 */
function closedChoices(field: Field): string[] | undefined {
  if (field.choices?.length) return field.choices;
  return braceList(prop(field, 'value'));
}

function isSubformField(field: Field): boolean {
  return SUBFORM_TOKENS.has(normalizeType(field.type ?? ''));
}

/** `values = Form[cond].Field` — a filtered lookup the IR leaves unmodelled. */
function filteredLookup(field: Field): { form: string; field: string } | undefined {
  const raw = field.properties.find((p) => p.key.toLowerCase() === 'values')?.value ?? '';
  const m = /^([\p{L}_][\p{L}\p{N}_]*)\[[^\]]*\]\.([\p{L}_][\p{L}\p{N}_]*)$/u.exec(raw.trim());
  return m ? { form: m[1], field: m[2] } : undefined;
}

function isFormulaField(field: Field): boolean {
  if (normalizeType(field.type ?? '') === 'formula') return true;
  return field.subfields.some((s) => s.name.toLowerCase() === 'formula_properties');
}

function numberRange(field: Field): { min?: number; max?: number } {
  const read = (keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = prop(field, k);
      if (v !== undefined && v !== '' && Number.isFinite(Number(v))) return Number(v);
    }
    return undefined;
  };
  return {
    min: read(['minimum value', 'minvalue', 'min value', 'min']),
    max: read(['maximum value', 'maxvalue', 'max value', 'max']),
  };
}

/** Columns of one form for the Creator-import CSV. */
function columnsOf(field: Field, warnings: CreatorImportWarning[], form: Form): Column[] {
  const out: Column[] = [];
  const token = normalizeType(field.type ?? '');
  const name = field.name;
  const hint = `${form.name}.${name}`.toLowerCase();
  const base = {
    required: field.required,
    unique: field.unique,
    hint,
    maxLength: (() => {
      const v = prop(field, 'maxchar');
      return v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined;
    })(),
    ...numberRange(field),
  };
  if (isSubformField(field)) return out; // form-level skip decided by caller
  if (isFormulaField(field)) {
    warnings.push({ form: form.name, field: name, message: `${name} is a formula field; Creator computes it. Column omitted.` });
    return out;
  }
  const lookupTarget = field.lookup ?? filteredLookup(field);
  if (lookupTarget) {
    const row = fieldTypeRow(field.type ?? '');
    const multi = token === 'list' || row?.id === 'multi-select' || row?.id === 'checkbox-multi' || row?.id === 'lookup-multi';
    const fmt = (field.lookup?.displayFormat ?? prop(field, 'displayformat'))?.trim();
    const bracket = fmt?.match(/^\[(.*)\]$/s)?.[1].trim();
    const col: Column = {
      ...base,
      name,
      kind: multi ? 'lookup-multi' : 'lookup',
      lookupForm: lookupTarget.form,
      note: `lookup → ${lookupTarget.form}${lookupTarget.field ? '.' + lookupTarget.field : ''}`,
    };
    if (bracket !== undefined) {
      if (bracket === 'ID') {
        col.lookupById = true;
        const bi = prop(field, 'bidirectional');
        col.note = `lookup → ${lookupTarget.form} displayed as record ID; left blank on purpose (record ids do not exist before import${bi ? `; bidirectional with ${bi}` : ''})`;
      } else if (!/[+\s]/.test(bracket)) col.lookupDisplay = bracket;
      else {
        col.lookupExpr = bracket;
        col.note = `lookup → ${lookupTarget.form} with display format expression ${fmt}`;
      }
    }
    out.push(col);
    return out;
  }
  if (normalizeType(prop(field, 'module') ?? '') === 'users' || token === 'users' || token === 'user') {
    out.push({ ...base, name, kind: 'email', note: 'Users field — value must match an app user email' });
    warnings.push({ form: form.name, field: name, message: `${name} is a Users field; seeded with @example.com addresses, which are not app users.` });
    return out;
  }
  if (token === 'name' || token === 'address') {
    if (!field.subfields.length) {
      out.push({ ...base, name, kind: 'text' });
      return out;
    }
    for (const sub of field.subfields) {
      const subToken = normalizeType(sub.type ?? '');
      const row = fieldTypeRow(sub.type ?? '');
      if (row && (SKIP_ROWS.has(row.id) || row.kind === 'none')) continue;
      if (SUBFORM_TOKENS.has(subToken)) continue;
      const choices = closedChoices(sub);
      const hidden = (prop(sub, 'visibility') ?? '').trim().toLowerCase() === 'false';
      if (choices?.length) {
        // A closed list must not be uniquified (`Mr (2)` is not a prefix).
        out.push({
          ...base,
          name: `${name}.${sub.name}`,
          kind: 'choice',
          choices,
          unique: false,
          hint: `${hint}.${sub.name}`,
          note: `part of composite ${field.name}; closed list from the .ds: ${choices.map((c) => JSON.stringify(c)).join(', ')}${hidden ? ' (visibility = false; still emitted so a display expression can include it)' : ''}`,
        });
        continue;
      }
      out.push({
        ...base,
        name: `${name}.${sub.name}`,
        kind: 'text',
        unique: false,
        hint: `${hint}.${sub.name}`,
        note: `part of composite ${field.name}`,
      });
    }
    return out;
  }
  const row = fieldTypeRow(field.type ?? '');
  if (!row || SKIP_ROWS.has(row.id) || row.kind === 'none') return out;
  if (FILE_ROWS.has(row.id)) {
    warnings.push({ form: form.name, field: name, message: `${name} is a ${field.type} field; files cannot be imported by CSV. Column omitted.` });
    return out;
  }
  if (row.id === 'checkbox-multi' || row.id === 'multi-select') {
    out.push({ ...base, name, kind: 'multi', choices: field.choices, note: 'multi-select; choices comma-separated in one cell' });
    return out;
  }
  const kind: Kind =
    row.id === 'email' ? 'email'
    : row.id === 'phone' ? 'phone'
    : row.id === 'number' || row.id === 'users' || row.id === 'legacy-crm-link' ? 'number'
    : row.id === 'decimal' || row.id === 'percent' || row.id === 'currency' ? 'decimal'
    : row.id === 'date' ? 'date'
    : row.id === 'date-time' ? 'datetime'
    : row.id === 'time' ? 'time'
    : row.id === 'decision-box' || (row.id === 'checkbox-multi' && false) ? 'bool'
    : row.id === 'dropdown' || row.id === 'radio' ? 'choice'
    : row.id === 'url' ? 'url'
    : 'text';
  if (token === 'checkbox' && (field.choices?.length ?? 0) > 0) {
    out.push({ ...base, name, kind: 'multi', choices: field.choices, note: 'checkbox list; choices comma-separated in one cell' });
    return out;
  }
  const choices = kind === 'choice' ? (field.choices?.length ? field.choices : closedChoices(field)) : field.choices;
  out.push({ ...base, name, kind, ...(choices ? { choices } : {}) });
  return out;
}

// ---------------------------------------------------------------------------
// scalar values

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function pick<T>(rng: () => number, list: T[]): T {
  return list[Math.floor(rng() * list.length) % list.length];
}

function personName(rng: () => number): string {
  return `${pick(rng, FIRST)} ${pick(rng, LAST)}`;
}

function textValue(col: Column, i: number, rng: () => number, seen: Set<string>): string {
  const h = col.hint;
  let v: string;
  if (h.endsWith('first_name')) v = FIRST[i % FIRST.length];
  else if (h.endsWith('last_name')) v = LAST[i % LAST.length];
  // A prefix with no .ds value list is left blank. Inventing Mr/Dr is not a choice.
  else if (h.endsWith('prefix') || h.endsWith('suffix')) v = '';
  else if (/descrip|notes|remark|comment|detail/.test(h)) v = pick(rng, NOTES);
  else if (/batch_no|serial|sku|code|_no\b|number/.test(h)) v = `${h.includes('batch') ? 'BATCH' : h.includes('serial') ? 'SN' : 'REF'}-2026-${String(i + 1).padStart(4, '0')}`;
  else if (h.includes('material')) v = `${pick(rng, MATERIAL)} ${pick(rng, ['A', 'B', 'C'])}${i + 1}`;
  else if (/product/.test(h) && !/production/.test(h)) v = `${pick(rng, PRODUCT)} ${pick(rng, ['standard', 'deluxe'])} ${i + 1}`;
  else if (h.includes('company')) v = pick(rng, COMPANY);
  else if (h.includes('name')) v = personName(rng);
  else v = `${pick(rng, GENERIC_ADJ)} ${pick(rng, GENERIC_NOUN)} ${i + 1}`;
  // Closed lists (picklist, name prefix) must stay exact. `Mr. (2)` is not in the .ds.
  // Open text still grows a suffix on collision so a lookup display stays unambiguous.
  if (v !== '' && !col.choices?.length && seen.has(v)) {
    let k = 2;
    while (seen.has(`${v} (${k})`)) k++;
    v = `${v} (${k})`;
  }
  if (col.maxLength && v.length > col.maxLength) v = v.slice(0, col.maxLength);
  return v;
}

function numberValue(col: Column, i: number, rng: () => number): string {
  const lo = col.min ?? 1;
  const hi = col.max !== undefined && col.max > lo ? col.max : 500;
  if (col.kind === 'decimal') {
    const cents = Math.floor(rng() * Math.min(hi, 5000) * 100) + 50;
    return (cents / 100).toFixed(2);
  }
  return String(lo + ((i * 37 + Math.floor(rng() * 13)) % Math.max(1, Math.floor(hi - lo + 1))));
}

function scalarValue(col: Column, i: number, rng: () => number, seen: Set<string>): string {
  switch (col.kind) {
    case 'email': {
      const n = personName(rng).toLowerCase().replace(/[^a-z]+/g, '.');
      return `${n}${i + 1}@example.com`.replace('..', '.');
    }
    case 'phone':
      // NANP reserves 555-0100…555-0199 for fictional use.
      return `+1-555-01${String(10 + (i % 90)).padStart(2, '0')}`;
    case 'number':
    case 'decimal':
      return numberValue(col, i, rng);
    case 'date': {
      const d = new Date(Date.UTC(2025, Math.floor(rng() * 20), 1 + Math.floor(rng() * 28)));
      return fmtDate(d);
    }
    case 'datetime': {
      const d = new Date(Date.UTC(2025, Math.floor(rng() * 20), 1 + Math.floor(rng() * 28)));
      return `${fmtDate(d)} ${String(Math.floor(rng() * 24)).padStart(2, '0')}:${String(Math.floor(rng() * 60)).padStart(2, '0')}`;
    }
    case 'time':
      return `${String(Math.floor(rng() * 24)).padStart(2, '0')}:${String(Math.floor(rng() * 60)).padStart(2, '0')}`;
    case 'bool':
      return rng() < 0.5 ? 'true' : 'false';
    case 'choice': {
      const list = col.choices?.length ? col.choices : STATUS_FALLBACK;
      // Round-robin, not uniquified. Row 0 is the first .ds value, then the next.
      return list[i % list.length];
    }
    case 'multi': {
      const list = col.choices?.length ? col.choices : STATUS_FALLBACK;
      if (list.length === 1) return list[0];
      const a = list[i % list.length];
      const b = list[(i + 1) % list.length];
      return a === b ? a : `${a},${b}`;
    }
    case 'url':
      return `https://example.com/item-${i + 1}`;
    default:
      return textValue(col, i, rng, seen);
  }
}

// ---------------------------------------------------------------------------

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function fileName(form: string): string {
  return `${form.replace(/[^A-Za-z0-9_-]+/g, '_') || 'form'}.csv`;
}

function allowedEntries(form: Form): number | undefined {
  for (const block of form.blocks) {
    if (block.name.toLowerCase() !== 'properties') continue;
    for (const inner of block.blocks) {
      if (inner.name.toLowerCase() !== 'total entries') continue;
      const v = inner.properties.find((p) => p.key.toLowerCase() === 'allowed count')?.value;
      if (v !== undefined && Number.isFinite(Number(v))) return Number(v);
    }
  }
  return undefined;
}

function storesData(form: Form): boolean {
  const v = form.properties.find((p) => p.key.toLowerCase() === 'store data in zc')?.value;
  return v?.trim().toLowerCase() !== 'false';
}

function topoOrder(forms: Form[], deps: Map<string, Set<string>>): { order: string[], cycles: string[] } {
  const names = forms.map((f) => f.name);
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
  const ready = names.filter((n) => indegree.get(n) === 0).sort(compareEnUs);
  const order: string[] = [];
  while (ready.length) {
    const next = ready.shift()!;
    order.push(next);
    for (const child of children.get(next) ?? []) {
      const left = indegree.get(child)! - 1;
      indegree.set(child, left);
      if (left === 0) {
        ready.push(child);
        ready.sort(compareEnUs);
      }
    }
  }
  const cycles: string[] = [];
  for (const name of [...names].sort(compareEnUs)) {
    if (!order.includes(name)) {
      order.push(name);
      cycles.push(name);
    }
  }
  return { order, cycles };
}

/** Resolve a `displayformat` expression like `" " + Name.first_name + " " + Name.last_name`. */
function evalDisplayExpr(expr: string, cells: Map<string, string>): string | undefined {
  const parts = expr.match(/"((?:[^"\\]|\\.)*)"|([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)?)/gu);
  if (!parts) return undefined;
  let out = '';
  let sawField = false;
  for (const part of parts) {
    if (part.startsWith('"')) out += part.slice(1, -1).replace(/\\(.)/gs, '$1');
    else {
      sawField = true;
      const v = cells.get(part);
      if (v === undefined) return undefined;
      out += v;
    }
  }
  return sawField ? out.trim() : undefined;
}

function plainDisplayField(field: Field): string | undefined {
  const fmt = (field.lookup?.displayFormat ?? prop(field, 'displayformat'))?.trim();
  if (!fmt) return undefined;
  const bracket = fmt.match(/^\[(.*)\]$/s)?.[1].trim();
  if (bracket === undefined || bracket === 'ID' || /[+\s]/.test(bracket)) return undefined;
  return bracket;
}

/** `Form[Field == true].ID` — the simple filter the IR does not model. */
function simpleEqualsFilter(field: Field): { field: string; equals: string } | undefined {
  const raw = (field.properties.find((p) => p.key.toLowerCase() === 'values')?.value ?? '').trim();
  const m = /^[\p{L}_][\p{L}\p{N}_]*\[\s*([\p{L}_][\p{L}\p{N}_]*)\s*==\s*(true|false|"([^"]*)"|'([^']*)')\s*\]/u.exec(raw);
  if (!m) return undefined;
  return { field: m[1], equals: m[3] ?? m[4] ?? m[2] };
}

function worksheetFileName(form: string): string {
  return `${form.replace(/[^A-Za-z0-9_-]+/g, '_') || 'form'}.worksheet.md`;
}

function quotedInitial(field: Field | undefined): string | undefined {
  if (field?.initialValue === undefined) return undefined;
  return unquote(field.initialValue);
}

interface LineField {
  name: string;
  kind: 'lookup' | 'number' | 'text';
  lookupForm?: string;
  lookupDisplay?: string;
  filterField?: string;
  filterEquals?: string;
}

/** Grid columns the user types. Prices and placeholder choice lists are left to the form script. */
function gridLineFields(field: Field): LineField[] {
  const out: LineField[] = [];
  for (const sub of field.subfields) {
    const lookup = sub.lookup ?? filteredLookup(sub);
    if (lookup) {
      const filter = simpleEqualsFilter(sub);
      out.push({
        name: sub.name,
        kind: 'lookup',
        lookupForm: lookup.form,
        lookupDisplay: plainDisplayField(sub),
        ...(filter ? { filterField: filter.field, filterEquals: filter.equals } : {}),
      });
      continue;
    }
    if (fieldTypeRow(sub.type ?? '')?.id === 'number') out.push({ name: sub.name, kind: 'number' });
    else out.push({ name: sub.name, kind: 'text' });
  }
  return out;
}

function statelessLookupReason(form: Form, cols: Column[], skipped: Map<string, string>): string | undefined {
  if (storesData(form) || skipped.has(form.name)) return undefined;
  const hits = cols.filter((c) => c.required && (c.kind === 'lookup' || c.kind === 'lookup-multi') && !!c.lookupForm && skipped.has(c.lookupForm));
  if (!hits.length) return undefined;
  const bits = hits.map((c) => `${c.name} → ${c.lookupForm}${c.lookupDisplay ? '.' + c.lookupDisplay : ''}`);
  return `store data in zc = false, and must-have lookup ${bits.join('; ')} targets a form that is not an import file — run this form in the UI after those records exist`;
}

function sheetKey(formName: string, app: App, cols: Column[]): string | undefined {
  for (const form of app.forms) {
    for (const field of form.fields) {
      const target = field.lookup?.form ?? filteredLookup(field)?.form;
      if (target !== formName) continue;
      const disp = plainDisplayField(field);
      if (disp && cols.some((c) => c.name === disp)) return disp;
    }
  }
  return cols.find((c) => c.kind === 'text')?.name;
}

function displayCell(cells: Map<string, string>, cols: Column[], display?: string): string {
  if (display) {
    const direct = cells.get(display);
    if (direct) return direct;
    const hit = [...cells.entries()].find(([k]) => k === display || k.endsWith(`.${display}`));
    if (hit?.[1]) return hit[1];
  }
  const fallback = cols.find((c) => ['text', 'email', 'choice', 'phone'].includes(c.kind) && !c.name.includes('.'));
  return fallback ? cells.get(fallback.name) ?? '' : '';
}

function lookupCandidates(
  grid: Map<string, Map<string, string>[]>,
  columns: Map<string, Column[]>,
  spec: LineField,
  exclude: string,
): string[] {
  const rows = grid.get(spec.lookupForm ?? '') ?? [];
  const cols = columns.get(spec.lookupForm ?? '') ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cells of rows) {
    if (spec.filterField) {
      const raw = cells.get(spec.filterField) ?? '';
      if (raw.toLowerCase() !== (spec.filterEquals ?? '').toLowerCase()) continue;
    }
    const v = displayCell(cells, cols, spec.lookupDisplay);
    if (!v || (exclude !== '' && v === exclude) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function csvDocument(headers: string[], data: string[][]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of data) lines.push(row.map(csvCell).join(','));
  return `${lines.join('\n')}\n`;
}

/** `type = grid` with `values = Form.Field` and no nested fields. The other form keeps the columns. */
function referenceGridTarget(field: Field): string | undefined {
  if (!isSubformField(field) || field.subfields.length > 0) return undefined;
  return field.lookup?.form ?? filteredLookup(field)?.form;
}

/** Column on the referenced form that points back at this parent. */
function backReferenceColumn(parentName: string, cols: Column[], gridField: Field): Column | undefined {
  const bi = prop(gridField, 'bidirectional');
  if (bi) {
    const named = cols.find((c) => c.name === bi);
    if (named) return named;
  }
  return cols.find((c) => c.lookupForm === parentName);
}

function requiredLookupTargets(cols: Column[]): Set<string> {
  const out = new Set<string>();
  for (const col of cols) if (col.required && col.lookupForm) out.add(col.lookupForm);
  return out;
}

/**
 * Worksheets a later import file must wait for. Walks required lookups,
 * including through worksheet-only parents, not only from one CSV to another.
 */
function worksheetsNeededByImport(
  worksheets: Set<string>,
  importable: Set<string>,
  requiredParents: Map<string, Set<string>>,
): Set<string> {
  const need = new Set<string>();
  const walk = (name: string, seen: Set<string>): void => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const parent of requiredParents.get(name) ?? []) {
      if (worksheets.has(parent)) need.add(parent);
      walk(parent, seen);
    }
  };
  for (const name of importable) walk(name, new Set());
  return need;
}

function parentSheetColumns(form: Form, cols: Column[]): Column[] {
  return cols.filter((col) => {
    if (col.kind !== 'choice' || col.required) return true;
    const field = form.fields.find((f) => f.name === col.name);
    return quotedInitial(field) === undefined;
  });
}

function buildManual(
  app: App,
  form: Form,
  columns: Map<string, Column[]>,
  grid: Map<string, Map<string, string>[]>,
  skipped: Map<string, string>,
  importable: Set<string>,
  typeBeforeImport: boolean,
): CreatorImportManual {
  const cols = columns.get(form.name) ?? [];
  const table = grid.get(form.name) ?? [];
  const key = sheetKey(form.name, app, cols);
  const parentCols = parentSheetColumns(form, cols);
  const keyCol = key ? parentCols.find((c) => c.name === key) : undefined;
  const ordered = keyCol ? [keyCol, ...parentCols.filter((c) => c.name !== key)] : parentCols;
  const grids = form.fields.filter((f) => isSubformField(f));
  const lines: string[] = [];
  lines.push(`# ${form.name} — manual worksheet`);
  lines.push('');
  lines.push('**Not for Import Data.** Do not put this file through a report\'s Import Data menu.');
  lines.push(`Creator's report importer cannot load subform rows (Limitation 2: "Importing Subform data is currently not supported", ${IMPORT_HELP}).`);
  if (typeBeforeImport) {
    lines.push(`Type these rows at the \`type ${worksheetFileName(form.name)}\` line in \`IMPORT_ORDER.txt\`, before every later import file that looks this form up.`);
  } else {
    lines.push('Type these rows into the form after the files in `IMPORT_ORDER.txt` have been imported once.');
  }
  lines.push('');
  const inlineCount = grids.filter((f) => referenceGridTarget(f) === undefined).length;
  if (inlineCount >= 2) {
    lines.push(`Catalyst keeps **${form.name}** as a coverage gap: ${inlineCount} inline subforms become one NoSQL collection, not a Data Store table. This worksheet is not migrated data.`);
    lines.push('');
  }
  for (const col of cols) {
    if (col.kind !== 'choice' || col.required) continue;
    const field = form.fields.find((f) => f.name === col.name);
    const initial = quotedInitial(field);
    if (initial === undefined) continue;
    lines.push(`Leave \`${col.name}\` at its initial value \`${initial}\`. Do not type it.`);
  }
  if (lines[lines.length - 1]?.startsWith('Leave ')) lines.push('');
  const dependents = app.forms.filter((f) => f.name !== form.name && skipped.has(f.name) && (columns.get(f.name) ?? []).some((c) => c.required && c.lookupForm === form.name));
  for (const dep of dependents) {
    lines.push(`\`${dep.name}\` is not an import file (${skipped.get(dep.name)}). Its must-have lookup displays these rows. Run it in the form UI after you have typed them.`);
    lines.push('');
  }
  lines.push('## Parent rows');
  lines.push('');
  if (key) lines.push(`Keyed by \`${key}\`.`);
  lines.push('');
  lines.push('```csv');
  lines.push(csvDocument(ordered.map((c) => c.name), table.map((cells) => ordered.map((c) => cells.get(c.name) ?? ''))).trimEnd());
  lines.push('```');
  lines.push('');
  for (const gridField of grids) {
    const target = referenceGridTarget(gridField);
    if (target && importable.has(target)) {
      // The referenced form is its own table. Do not copy its columns into this worksheet.
      const childCols = columns.get(target) ?? [];
      const back = backReferenceColumn(form.name, childCols, gridField);
      const link = back?.name ?? 'lookup';
      lines.push(`\`${gridField.name}\` is not typed here. Import \`${fileName(target)}\` after this worksheet; its \`${link}\` column links these rows.`);
      lines.push('');
      continue;
    }
    if (target) {
      const childCols = columns.get(target) ?? [];
      const back = backReferenceColumn(form.name, childCols, gridField);
      const specs = childCols.filter((c) => c !== back && c.lookupForm !== form.name);
      const headers = [key ?? 'row', ...specs.map((c) => c.name)];
      const data = (grid.get(target) ?? []).map((cells) => [
        back ? cells.get(back.name) ?? '' : '',
        ...specs.map((c) => cells.get(c.name) ?? ''),
      ]);
      lines.push(`## ${gridField.name} (${gridField.required ? 'must have' : 'optional'})`);
      lines.push('');
      lines.push(`Keyed by \`${key ?? 'row'}\`. These are the ${target} rows that link to this ${form.name}.`);
      if (!data.length) lines.push('No rows for this grid.');
      lines.push('');
      lines.push('```csv');
      lines.push(csvDocument(headers, data).trimEnd());
      lines.push('```');
      lines.push('');
      continue;
    }
    const specs = gridLineFields(gridField);
    const kept = new Set(specs.map((s) => s.name));
    const omitted = gridField.subfields.filter((s) => !kept.has(s.name)).map((s) => s.name);
    lines.push(`## ${gridField.name} (${gridField.required ? 'must have' : 'optional'})`);
    lines.push('');
    lines.push(`Keyed by \`${key ?? 'row'}\`.`);
    if (omitted.length) {
      lines.push(`Do not type ${omitted.map((n) => `\`${n}\``).join(', ')}. A grid choice list of \`Choice 1\` is a placeholder, and the form script copies unit and price when you pick the lookup. Import runs with workflows off, so a CSV would not.`);
    }
    const headers = [key ?? 'row', ...specs.map((s) => s.name)];
    const data: string[][] = [];
    table.forEach((cells, i) => {
      const keyValue = key ? cells.get(key) ?? '' : String(i + 1);
      const candLists = specs.map((spec) => {
        if (spec.kind !== 'lookup') return [] as string[];
        const excludeCol = parentCols.find((c) => c.lookupForm === spec.lookupForm && (c.kind === 'lookup' || c.kind === 'lookup-multi'));
        const exclude = excludeCol ? cells.get(excludeCol.name) ?? '' : '';
        return lookupCandidates(grid, columns, spec, exclude);
      });
      const lookupCounts = specs.flatMap((spec, si) => (spec.kind === 'lookup' ? [candLists[si].length] : []));
      const n = lookupCounts.length === 0
        ? (gridField.required ? 2 : 1)
        : lookupCounts.some((count) => count === 0) ? 0 : (gridField.required ? 2 : 1);
      for (let line = 0; line < n; line++) {
        const row = [keyValue];
        specs.forEach((spec, si) => {
          if (spec.kind === 'number') row.push(String(1 + ((i + 1) * (line + 3)) % 9));
          else if (spec.kind === 'lookup') row.push(candLists[si][(i + line) % candLists[si].length] ?? '');
          else row.push(`${spec.name}-${i + 1}-${line + 1}`);
        });
        data.push(row);
      }
    });
    if (!data.length) {
      lines.push('No rows for this grid: no lookup value matched the .ds filter without also being the parent record.');
    }
    lines.push('');
    lines.push('```csv');
    lines.push(csvDocument(headers, data).trimEnd());
    lines.push('```');
    lines.push('');
  }
  const summary = `Hand entry for ${form.name} (${grids.map((g) => g.name).join(', ') || 'subform'}). Not an import file.${inlineCount >= 2 ? ` Catalyst keeps this form as a coverage gap: ${inlineCount} inline subforms are one NoSQL collection.` : ''}`;
  return { form: form.name, fileName: worksheetFileName(form.name), body: `${lines.join('\n')}\n`, summary };
}

export function generateCreatorImport(app: App, opts?: { rows?: number; seed?: string }): CreatorImportResult {
  const rows = opts?.rows ?? 20;
  if (!Number.isInteger(rows) || rows < 0) throw new Error('c2c seed: --rows must be a non-negative integer');
  const seed = opts?.seed || app.name || 'app';
  const warnings: CreatorImportWarning[] = [];

  // Columns for every form — skipped forms still generate values in memory so
  // children can reference the display values the user must create by hand.
  const columns = new Map<string, Column[]>();
  const deps = new Map<string, Set<string>>();
  const skipped = new Map<string, string>();
  for (const form of app.forms) {
    const subforms = form.fields.filter((f) => isSubformField(f)).map((f) => f.name);
    if (subforms.length) {
      skipped.set(form.name, `inline subform field(s) ${subforms.join(', ')} — Creator's report Import Data cannot load subform rows (Limitation 2). Enter them from the manual worksheet; do not import this form`);
    }
    const cols: Column[] = [];
    const needs = new Set<string>();
    for (const field of form.fields) {
      for (const col of columnsOf(field, warnings, form)) {
        cols.push(col);
        if (col.lookupForm) needs.add(col.lookupForm);
      }
    }
    columns.set(form.name, cols);
    deps.set(form.name, needs);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const form of app.forms) {
      const reason = statelessLookupReason(form, columns.get(form.name) ?? [], skipped);
      if (!reason) continue;
      skipped.set(form.name, reason);
      grew = true;
    }
  }
  for (const form of app.forms) {
    if (!storesData(form) && !skipped.has(form.name)) {
      warnings.push({ form: form.name, message: `${form.name} has "store data in zc = false" — it is a stateless form, so imported rows may not persist.` });
    }
  }
  const { order, cycles } = topoOrder(app.forms, deps);
  for (const name of cycles) {
    if (!skipped.has(name)) skipped.set(name, 'cyclic lookup dependency — cannot be ordered for Import Data; enter by hand');
  }

  // Generate every form's grid (including skipped parents).
  const grid = new Map<string, Map<string, string>[]>();
  const caps = new Map<string, number>();
  for (const name of order) {
    const form = app.forms.find((f) => f.name === name)!;
    const cols = columns.get(name) ?? [];
    const cap = allowedEntries(form);
    const count = cap !== undefined ? Math.min(rows, cap) : rows;
    caps.set(name, count);
    if (cap !== undefined && cap < rows) {
      warnings.push({ form: name, message: `${name} allows ${cap} total entr${cap === 1 ? 'y' : 'ies'}; generated ${count} row(s) instead of ${rows}.` });
    }
    const rng = mulberry32(fnv(`${seed}:${name}`));
    const seenByCol = cols.map(() => new Set<string>());
    const table: Map<string, string>[] = [];
    for (let i = 0; i < count; i++) {
      const cells = new Map<string, string>();
      cols.forEach((col, ci) => {
        if (col.kind === 'lookup' || col.kind === 'lookup-multi') {
          cells.set(col.name, '');
          return;
        }
        const v = scalarValue(col, i, rng, seenByCol[ci]);
        seenByCol[ci].add(v);
        cells.set(col.name, v);
      });
      table.push(cells);
    }
    grid.set(name, table);
  }

  // Fill lookup cells from the parent's display column / expression.
  for (const name of order) {
    const cols = columns.get(name) ?? [];
    const table = grid.get(name) ?? [];
    for (const col of cols) {
      if (col.kind !== 'lookup' && col.kind !== 'lookup-multi') continue;
      const parentRows = grid.get(col.lookupForm ?? '') ?? [];
      const parentCols = columns.get(col.lookupForm ?? '') ?? [];
      if (col.lookupById) {
        for (const cells of table) cells.set(col.name, '');
        if (!skipped.has(name)) {
          warnings.push({
            form: name,
            field: col.name,
            message: `${col.name} displays the parent record ID; left blank on purpose — record ids do not exist before import.`,
          });
        }
        continue;
      }
      const resolve = (cells: Map<string, string>): string => {
        if (col.lookupDisplay) {
          const sub = cells.get(col.lookupDisplay);
          if (sub !== undefined) return sub;
          // display path may point at a composite sub-field
          const hit = [...cells.entries()].find(([k]) => k === col.lookupDisplay || k.endsWith(`.${col.lookupDisplay}`));
          if (hit) return hit[1];
        }
        if (col.lookupExpr !== undefined) {
          const v = evalDisplayExpr(col.lookupExpr, cells);
          if (v !== undefined) return v;
        }
        const fallback = parentCols.find((c) => ['text', 'email', 'choice', 'phone'].includes(c.kind) && !c.name.includes('.'));
        return fallback ? cells.get(fallback.name) ?? '' : '';
      };
      if (!parentRows.length) {
        warnings.push({ form: name, field: col.name, message: `Lookup ${col.name} has no parent rows in ${col.lookupForm}.` });
        continue;
      }
      table.forEach((cells, i) => {
        const one = () => resolve(parentRows[i % parentRows.length]);
        if (col.kind === 'lookup') cells.set(col.name, one());
        else {
          const vals = [one(), resolve(parentRows[(i + 1) % parentRows.length])];
          cells.set(col.name, [...new Set(vals.filter((v) => v !== ''))].join(','));
        }
      });
      if (skipped.has(col.lookupForm ?? '') && !skipped.has(name)) {
        warnings.push({
          form: name,
          field: col.name,
          message: `${col.name} references ${col.lookupForm}, which is not importable; cells hold the display values of records you must create first.`,
        });
      }
    }
  }

  // Emit CSVs for importable forms only.
  const reportsByForm = new Map<string, { name: string; criteria?: string }[]>();
  for (const report of app.reports as Report[]) {
    if (!report.form) continue;
    const list = reportsByForm.get(report.form) ?? [];
    list.push({ name: report.name, ...(report.criteria ? { criteria: report.criteria } : {}) });
    reportsByForm.set(report.form, list);
  }
  const files: CreatorImportFile[] = [];
  for (const name of order) {
    if (skipped.has(name)) continue;
    const cols = columns.get(name) ?? [];
    const table = grid.get(name) ?? [];
    const header = cols.map((c) => csvCell(c.name)).join(',');
    const body = table.map((cells) => cols.map((c) => csvCell(cells.get(c.name) ?? '')).join(',')).join('\n');
    const csv = `${header}\n${body}${body ? '\n' : ''}`;
    files.push({
      form: name,
      displayName: app.forms.find((f) => f.name === name)?.displayName,
      fileName: fileName(name),
      csv,
      rowCount: table.length,
      reports: reportsByForm.get(name) ?? [],
      columnNotes: cols.filter((c) => c.note).map((c) => ({ column: c.name, note: c.note! })),
    });
  }

  const importable = new Set(files.map((f) => f.form));
  const worksheetNames = new Set<string>();
  for (const form of app.forms) {
    if (!skipped.has(form.name)) continue;
    if (!form.fields.some((f) => isSubformField(f)) && !skipped.get(form.name)?.includes('cyclic')) continue;
    worksheetNames.add(form.name);
  }
  const requiredParents = new Map<string, Set<string>>();
  for (const form of app.forms) requiredParents.set(form.name, requiredLookupTargets(columns.get(form.name) ?? []));
  const typeBefore = worksheetsNeededByImport(worksheetNames, importable, requiredParents);
  const manual: CreatorImportManual[] = [];
  for (const form of app.forms) {
    if (!worksheetNames.has(form.name)) continue;
    manual.push(buildManual(app, form, columns, grid, skipped, importable, typeBefore.has(form.name)));
  }

  const manualByForm = new Map(manual.map((m) => [m.form, m]));
  const fileByForm = new Map(files.map((f) => [f.form, f]));
  const steps: string[] = [];
  let stepNo = 0;
  for (const name of order) {
    if (typeBefore.has(name)) {
      const sheet = manualByForm.get(name);
      if (sheet) steps.push(`type ${sheet.fileName}  (${name})`);
    }
    const file = fileByForm.get(name);
    if (file) {
      stepNo += 1;
      steps.push(`${stepNo}. ${file.fileName}  (${file.form}, ${file.rowCount} rows)`);
    }
  }
  const orderText = [
    `# Creator import order — ${app.name ?? 'app'} (parents first)`,
    `# seed=${seed} rows=${rows}`,
    '# Import each file once. Filtered sibling reports are views of one form.',
    '# A line that starts with "type" is a manual worksheet. Type it before the numbered files below it.',
    ...steps,
    ...(skipped.size
      ? ['', '# not an import file:', ...[...skipped.entries()].map(([n, r]) => `# - ${n}: ${r}`)]
      : []),
    '',
  ].join('\n');

  const readme = readmeFor(app, files, skipped, warnings, seed, rows, importable, columns, manual);
  return {
    seed,
    rows,
    order: files.map((f) => f.form),
    files,
    manual,
    skipped: [...skipped.entries()].map(([form, reason]) => ({ form, reason })),
    warnings,
    orderText,
    readme,
  };
}

function displayKeysOf(app: App, formName: string): Set<string> {
  const keys = new Set<string>();
  for (const form of app.forms) {
    for (const field of form.fields) {
      const target = field.lookup?.form ?? filteredLookup(field)?.form;
      if (target !== formName) continue;
      const disp = plainDisplayField(field);
      if (disp) keys.add(disp);
      for (const sub of field.subfields) {
        const subTarget = sub.lookup?.form ?? filteredLookup(sub)?.form;
        if (subTarget !== formName) continue;
        const subDisp = plainDisplayField(sub);
        if (subDisp) keys.add(subDisp);
      }
    }
  }
  return keys;
}

function importOnceSentence(app: App, file: CreatorImportFile, cols: Column[]): string {
  const reports = file.reports.map((r) => `\`${r.name}\``).join(' and ');
  const unique = cols.filter((c) => c.unique).map((c) => `\`${c.name}\``);
  const keys = displayKeysOf(app, file.form);
  const keyed = cols.filter((c) => !c.unique && keys.has(c.name)).map((c) => `\`${c.name}\``);
  const openText = cols.filter((c) => !c.unique && (c.kind === 'text' || c.kind === 'email') && !c.name.includes('.')).map((c) => `\`${c.name}\``);
  const open = keyed.length ? keyed : openText;
  const tail = unique.length
    ? `A second import trips unique ${unique.join(', ')}.`
    : open.length
      ? `A second import duplicates ${open.join(', ')} (not unique), so a lookup on that display value becomes ambiguous.`
      : 'A second import duplicates the rows.';
  return `Import this file **once**, into any one of ${reports}. Those reports are filtered views of \`${file.form}\`, not separate copies. ${tail}`;
}

function readmeFor(
  app: App,
  files: CreatorImportFile[],
  skipped: Map<string, string>,
  warnings: CreatorImportWarning[],
  seed: string,
  rows: number,
  importable: Set<string>,
  columns: Map<string, Column[]>,
  manual: CreatorImportManual[],
): string {
  const lines: string[] = [];
  lines.push(`# Creator import CSVs — ${app.name ?? 'app'}`);
  lines.push('');
  lines.push(`Generated by \`c2c seed --creator-import\` (seed \`${seed}\`, up to ${rows} rows per form).`);
  lines.push('Import each CSV through the report\'s **Import Data** menu in Zoho Creator, in the');
  lines.push('order listed in `IMPORT_ORDER.txt` (parents before the forms that look them up).');
  lines.push('');
  lines.push('## Import each file once');
  lines.push('');
  lines.push('Filtered sibling reports are views of one form. The filter does not split the file.');
  lines.push('Import each CSV **once**, into any one list report of that form. A second import');
  lines.push('inserts the rows again.');
  lines.push('');
  lines.push('## Conventions');
  lines.push('');
  lines.push('- Dates: `dd-MMM-yyyy` (e.g. `05-Oct-2026`); date-times `dd-MMM-yyyy HH:mm`.');
  lines.push('- Lookups: the cell holds the **display value** of the parent record — the value');
  lines.push('  shown in the lookup field (its `displayformat`), which Creator resolves on import.');
  lines.push(`  See Zoho's report import article: ${IMPORT_HELP}`);
  lines.push('- A lookup displayed as the record ID (`displayformat = [ID]`) is left **blank**.');
  lines.push('  Record ids do not exist before import. Do not invent them. When the field is');
  lines.push('  bidirectional, the other form writes the link.');
  lines.push('- Multi-select / multi-lookup cells: chosen values **comma-separated** in one CSV cell');
  lines.push('  (Creator\'s documented import format for multi-value fields).');
  lines.push('- Composite fields (Name, Address): one column per sub-field, header `Field.sub_field`');
  lines.push('  (e.g. `Name.first_name`). A part with a `.ds` value list (Name `prefix` is');
  lines.push('  `value = {"Mr.","Mrs.","Ms."}`) uses that list exactly and is not uniquified.');
  lines.push('- Checkboxes (decision box): `true` / `false`. Picklists and radios use the exact');
  lines.push('  `.ds` choice text, including trailing spaces.');
  lines.push('- Emails are `@example.com`; phones use the NANP fictional range `+1-555-01xx`.');
  lines.push('  No real people, companies, or files. Image/file fields are omitted — CSV import');
  lines.push('  cannot carry them.');
  lines.push('');
  lines.push('## Files');
  lines.push('');
  for (const f of files) {
    const reports = f.reports.length
      ? f.reports.map((r) => `\`${r.name}\`${r.criteria ? ` (filtered: ${r.criteria})` : ''}`).join(', ')
      : '_(no report in the .ds — import via the form or create a list report)_';
    lines.push(`### \`${f.fileName}\` — ${f.form}${f.displayName ? ` (${f.displayName})` : ''}`);
    lines.push('');
    lines.push(`- Rows: ${f.rowCount}`);
    lines.push(`- Import into report: ${reports}`);
    if (f.reports.length > 1) lines.push(`- ${importOnceSentence(app, f, columns.get(f.form) ?? [])}`);
    for (const cn of f.columnNotes) lines.push(`- \`${cn.column}\`: ${cn.note}`);
    lines.push('');
  }
  if (manual.length) {
    lines.push('## Manual worksheets — not Import Data');
    lines.push('');
    lines.push('These files are **outside** `IMPORT_ORDER.txt`. Do not import them.');
    lines.push('');
    for (const m of manual) {
      lines.push(`### \`${m.fileName}\``);
      lines.push('');
      lines.push(m.summary);
      lines.push('');
    }
  }
  if (skipped.size) {
    lines.push('## Not an import file');
    lines.push('');
    for (const [name, reason] of skipped) lines.push(`- **${name}** — ${reason}`);
    lines.push('');
  }
  const notes = warnings.filter((w) => w.form && importable.has(w.form));
  if (notes.length) {
    lines.push('## Warnings');
    lines.push('');
    for (const w of warnings) lines.push(`- ${w.form}${w.field ? ` / ${w.field}` : ''}: ${w.message}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
