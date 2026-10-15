/**
 * Reading and checking a form's record from its controls. Controls are
 * uncontrolled and named by path: `Field`, `Field.part` for a composite part,
 * `Field[2].Column` for a subform cell. Reading happens once, at submit.
 *
 * Empty fields: on add (`data-mode="add"`) an empty field is left out of the
 * record. On edit (`data-mode="edit"`) a rendered field that is now empty is
 * sent as a clear, so the stored value is emptied: typed fields (number,
 * decimal, percent, currency, date, datetime, time, lookup) send null, a
 * multi-select sends [], and text-family fields send "". A field with no
 * control on the form is never sent, so a value the user cannot see is never
 * cleared. A subform row whose every field is empty is left out. The generated
 * subform grid always sends its list: the server replaces the stored child
 * rows with it, so removing every row deletes them all.
 */
import type { FieldSpec, FormRecord, FormSpec, RecordValue } from '../types.js';
import { isEmptyRow, subformRows } from '../subform/rows.js';

/** Typed fields whose empty value is null, not "": the store rejects "" for these columns. */
const BLANK_IS_NULL = new Set(['number', 'decimal', 'percent', 'currency', 'date', 'datetime', 'time', 'lookup', 'lookup-multi']);
const NOT_SENT = new Set(['section', 'notes', 'formula', 'autonumber', 'zia', 'barcode', 'unsupported', 'integration']);
export const FILE_WIDGETS = new Set(['file', 'image', 'audio', 'video', 'signature']);

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function controls(formEl: HTMLFormElement): Control[] {
  return Array.from(formEl.elements).filter((el): el is Control => 'name' in el && typeof (el as Control).name === 'string' && (el as Control).name !== '');
}

/** A custom widget mirrors its answer into a named hidden input; that input carries the posted value. */
const isValueCarrier = (el: Control) => el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden';

function scalar(list: Control[], widget: string): RecordValue | undefined {
  if (!list.length) return undefined;
  const first = list[0]!;
  if (widget === 'decision') return isValueCarrier(first) ? first.value === 'true' : (first as HTMLInputElement).checked;
  if (widget === 'multiselect' || widget === 'lookup-multi') {
    // An empty multi-select renders one blank carrier so the field still counts as on the form.
    return list.flatMap((el) => (el.tagName === 'SELECT' ? Array.from((el as HTMLSelectElement).selectedOptions, (o) => o.value) : isValueCarrier(el) ? (el.value === '' ? [] : [el.value]) : (el as HTMLInputElement).checked ? [el.value] : []));
  }
  if (widget === 'radio') {
    const picked = (list as HTMLInputElement[]).find((el) => !isValueCarrier(el) && el.checked);
    if (picked) return picked.value;
    const carrier = list.find(isValueCarrier);
    return carrier ? carrier.value : '';
  }
  return first.value;
}

/** True when the form draws the generated grid of this subform. */
function hasGrid(formEl: HTMLFormElement, name: string): boolean {
  return Array.from(formEl.querySelectorAll('[data-subform]')).some((el) => el.getAttribute('data-subform') === name);
}

/** The record to post: writable fields only, composite and subform values nested, files left for the upload step. */
export function readRecord(formEl: HTMLFormElement, form: FormSpec): FormRecord {
  const edit = formEl.getAttribute('data-mode') === 'edit';
  const all = controls(formEl);
  const named = (name: string) => all.filter((el) => el.name === name);
  const record: FormRecord = {};
  for (const field of form.fields) {
    if (field.readonly || field.visibility === false || NOT_SENT.has(field.widget)) continue;
    if (FILE_WIDGETS.has(field.widget)) {
      if (edit && named(`${field.name}_cleared`).length > 0) {
        const el = formEl.elements.namedItem(field.name);
        const picked = el && 'files' in el ? (el as HTMLInputElement).files?.[0] : undefined;
        const newSig = field.widget === 'signature' && el && 'tagName' in el && el.tagName === 'INPUT' && (el as HTMLInputElement).value !== '';
        if (!picked && !newSig) record[field.name] = null;
      }
      continue;
    }
    if (field.widget === 'subform') {
      // Rows in grid order; a row with no value in any cell is not sent. The
      // generated grid always sends its list, even empty: the server replaces
      // the stored rows with it, so removing every row deletes them all. A
      // custom subform widget that draws no grid sends nothing, which leaves
      // the stored rows alone.
      const kept = subformRows(formEl, field).filter((row) => !isEmptyRow(row)).map((row) => row.values);
      // On edit a kept row's blank cells post the same clears a top-level
      // field does: typed cells null, text cells "".
      if (edit) {
        for (const row of kept) {
          for (const column of field.subfields ?? []) {
            const value = row[column.name];
            if (value === '' || (Array.isArray(value) && !value.length)) {
              row[column.name] = Array.isArray(value) ? [] : BLANK_IS_NULL.has(column.widget) ? null : '';
            }
          }
        }
      }
      if (kept.length || (field.generated && hasGrid(formEl, field.name))) record[field.name] = kept;
      continue;
    }
    if (field.subfields?.length) {
      const parts: Record<string, RecordValue> = {};
      for (const part of field.subfields) {
        const value = scalar(named(`${field.name}.${part.name}`), part.widget);
        if (value === undefined) continue;
        const blank = value === '' || (Array.isArray(value) && !value.length);
        if (!blank) {
          parts[part.name] = value;
        } else if (edit) {
          parts[part.name] = Array.isArray(value) ? [] : BLANK_IS_NULL.has(part.widget) ? null : '';
        }
      }
      if (Object.keys(parts).length) record[field.name] = parts;
      continue;
    }
    const value = scalar(named(field.name), field.widget);
    if (value === undefined) continue;
    const blank = value === '' || (Array.isArray(value) && !value.length);
    if (!blank) record[field.name] = value;
    else if (edit) record[field.name] = Array.isArray(value) ? [] : BLANK_IS_NULL.has(field.widget) ? null : '';
  }
  return record;
}

/** File controls with a chosen file, by field name. The signature pad has no file input; its hidden input's stroke JSON uploads as the file. */
export function chosenFiles(formEl: HTMLFormElement, form: FormSpec): Map<FieldSpec, File> {
  const out = new Map<FieldSpec, File>();
  for (const field of form.fields) {
    if (!FILE_WIDGETS.has(field.widget)) continue;
    const el = formEl.elements.namedItem(field.name);
    const picked = el && 'files' in el ? (el as HTMLInputElement).files?.[0] : undefined;
    if (picked) {
      out.set(field, picked);
      continue;
    }
    if (field.widget === 'signature' && el && 'tagName' in el && el.tagName === 'INPUT') {
      const strokes = (el as HTMLInputElement).value;
      if (strokes) out.set(field, new File([strokes], `${field.name}.json`, { type: 'application/json' }));
    }
  }
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/i;
const NUMBER = /^-?\d+(\.\d+)?$/;

/** Browser-side checks: mandatory, type shape, maximum length and the Creator regex. Unique stays a server check. */
export function validate(form: FormSpec, record: FormRecord, files: Map<FieldSpec, File>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of form.fields) {
    if (field.readonly || field.visibility === false || NOT_SENT.has(field.widget)) continue;
    const value = record[field.name];
    const empty = FILE_WIDGETS.has(field.widget) ? !files.has(field) : value === undefined || value === null || value === '' || value === false || (Array.isArray(value) && !value.length);
    if (field.required && empty) {
      errors[field.name] = `Enter ${field.label}.`;
      continue;
    }
    if (typeof value !== 'string' || value === '') continue;
    if ((field.widget === 'email' || field.widget === 'users') && !EMAIL.test(value)) errors[field.name] = `Enter a valid email address for ${field.label}.`;
    else if (field.widget === 'url' && !URL_RE.test(value)) errors[field.name] = `Enter a web address starting with http:// or https:// for ${field.label}.`;
    else if (['number', 'decimal', 'percent', 'currency'].includes(field.widget) && !NUMBER.test(value)) errors[field.name] = `Enter a number for ${field.label}.`;
    else if (field.maxLength && value.length > field.maxLength) errors[field.name] = `${field.label} can be at most ${field.maxLength} characters.`;
    else if (field.pattern) {
      try {
        if (!new RegExp(field.pattern).test(value)) errors[field.name] = `${field.label} is not in the expected format.`;
      } catch {
        // A Creator pattern the browser cannot compile is left to the server check.
      }
    }
  }
  return errors;
}

const FOCUSABLE = 'input:not([type="hidden"]), select:not([hidden]), textarea, button:not([disabled])';

/**
 * The control the first error should focus. Keys are field names and subform
 * cell names (`Field[i].Column`); a grid's own error is skipped when one of its
 * cells has an error, so focus lands on the cell to fix.
 */
export function firstErrorControl(formEl: HTMLFormElement, errors: Record<string, string>): HTMLElement | null {
  const keys = Object.keys(errors);
  const boxes = Array.from(formEl.querySelectorAll<HTMLElement>('[data-field], [data-cell]'));
  for (const key of keys) {
    if (keys.some((other) => other.startsWith(`${key}[`))) continue;
    const box = boxes.find((el) => el.getAttribute('data-cell') === key) ?? boxes.find((el) => el.getAttribute('data-field') === key);
    const control = box?.querySelector<HTMLElement>(FOCUSABLE);
    if (control) return control;
  }
  return null;
}
