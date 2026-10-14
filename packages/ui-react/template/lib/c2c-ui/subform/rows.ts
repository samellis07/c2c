/**
 * Subform rows: reading them back from the grid and checking each row before
 * the parent submit. Cells are named `Field[i].Column` with i the row's
 * position in the grid, so an error keyed by that name lands on the cell the
 * user sees. A row whose cells are all empty is not sent and not checked;
 * a stored row carries its ROWID in a hidden cell, so it is sent even when
 * every visible cell was cleared. The server replaces the parent's child rows
 * with the list sent (delete, then insert in grid order): child ROWIDs are
 * not kept across an edit.
 */
import type { FieldSpec, FormSpec, RecordValue } from '../types.js';

export interface SubformRow {
  /** Position in the grid: the `i` of `Field[i].Column`. */
  index: number;
  values: Record<string, RecordValue>;
}

/** Column widgets a grid cell does not send (computed, layout, files). */
const NOT_SENT = new Set(['section', 'notes', 'formula', 'autonumber', 'zia', 'barcode', 'unsupported', 'integration', 'file', 'image', 'audio', 'video', 'signature']);
const MULTI = new Set(['multiselect', 'lookup-multi']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/i;
const NUMBER = /^-?\d+(\.\d+)?$/;

export function cellName(field: string, index: number, column: string): string {
  return `${field}[${index}].${column}`;
}

/** Columns the grid draws as editable cells, in Creator order. */
export function editableColumns(field: FieldSpec): FieldSpec[] {
  return (field.subfields ?? []).filter((column) => !column.readonly && !NOT_SENT.has(column.widget));
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function cellValue(el: Control, widget: string): RecordValue {
  if (el.tagName === 'SELECT' && (el as HTMLSelectElement).multiple) return Array.from((el as HTMLSelectElement).selectedOptions, (o) => o.value);
  if (widget === 'decision' || (el as HTMLInputElement).type === 'checkbox') return (el as HTMLInputElement).checked;
  return MULTI.has(widget) ? (el.value ? [el.value] : []) : el.value;
}

function empty(value: RecordValue | undefined): boolean {
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.values(value).every((part) => empty(part as RecordValue));
  return value === undefined || value === '' || value === false || (Array.isArray(value) && value.length === 0);
}

/** The grid's rows in grid order, each with its cell values by column (and ROWID for a stored row). */
export function subformRows(formEl: HTMLFormElement, field: FieldSpec): SubformRow[] {
  const pattern = new RegExp(`^${field.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\[(\\d+)\\]\\.(.+)$`);
  const byIndex = new Map<number, Record<string, RecordValue>>();
  for (const el of Array.from(formEl.elements) as Control[]) {
    const m = typeof el.name === 'string' ? pattern.exec(el.name) : null;
    if (!m) continue;
    const index = Number(m[1]);
    const values = byIndex.get(index) ?? {};
    byIndex.set(index, values);
    const column = (field.subfields ?? []).find((sub) => sub.name === m[2]);
    if (column) {
      values[column.name] = cellValue(el, column.widget);
      continue;
    }
    // A composite column (name, address) has one control per part: `Field[i].Column.part`, sent nested and only when filled.
    const dot = m[2]!.indexOf('.');
    const parent = dot > 0 ? (field.subfields ?? []).find((sub) => sub.name === m[2]!.slice(0, dot) && sub.subfields?.length) : undefined;
    if (parent) {
      if (el.value === '') continue;
      const parts = (values[parent.name] ?? {}) as Record<string, RecordValue>;
      parts[m[2]!.slice(dot + 1)] = el.value;
      values[parent.name] = parts;
    } else values[m[2]!] = cellValue(el, 'text');
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, values]) => ({ index, values }));
}

/** True when no cell of the row holds a value. */
export function isEmptyRow(row: SubformRow): boolean {
  return Object.values(row.values).every(empty);
}

function cellError(column: FieldSpec, value: RecordValue | undefined, row: number): string | undefined {
  const where = `${column.label} in row ${row}`;
  if (empty(value)) return column.required ? `Enter ${where}.` : undefined;
  if (typeof value !== 'string') return undefined;
  if ((column.widget === 'email' || column.widget === 'users') && !EMAIL.test(value)) return `Enter a valid email address for ${where}.`;
  if (column.widget === 'url' && !URL_RE.test(value)) return `Enter a web address starting with http:// or https:// for ${where}.`;
  if (['number', 'decimal', 'percent', 'currency'].includes(column.widget) && !NUMBER.test(value)) return `Enter a number for ${where}.`;
  if (column.maxLength && value.length > column.maxLength) return `${column.label} can be at most ${column.maxLength} characters (row ${row}).`;
  if (column.pattern) {
    try {
      if (!new RegExp(column.pattern).test(value)) return `${column.label} in row ${row} is not in the expected format.`;
    } catch {
      // A Creator pattern the browser cannot compile is left to the server check.
    }
  }
  return undefined;
}

/**
 * Errors for one grid: one per invalid cell, keyed by the cell name, plus one
 * for the grid itself (keyed by the field name, listed first) that names the
 * rows to fix. Empty rows are skipped: they are not sent.
 */
export function validateRows(field: FieldSpec, rows: readonly SubformRow[]): Record<string, string> {
  const cells: Record<string, string> = {};
  const bad: number[] = [];
  for (const row of rows) {
    if (isEmptyRow(row)) continue;
    let rowBad = false;
    for (const column of editableColumns(field)) {
      const message = cellError(column, row.values[column.name], row.index + 1);
      if (!message) continue;
      cells[cellName(field.name, row.index, column.name)] = message;
      rowBad = true;
    }
    if (rowBad) bad.push(row.index + 1);
  }
  if (!bad.length) return {};
  const which = bad.length === 1 ? `row ${bad[0]}` : `rows ${bad.join(', ')}`;
  return { [field.name]: `Check ${which} of ${field.label}.`, ...cells };
}

/** Row checks for every generated grid on the form. */
export function validateSubforms(formEl: HTMLFormElement, form: FormSpec): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of form.fields) {
    if (field.widget !== 'subform' || !field.generated) continue;
    Object.assign(errors, validateRows(field, subformRows(formEl, field)));
  }
  return errors;
}
