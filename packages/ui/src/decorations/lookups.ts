/**
 * Lookup display values. A lookup's `displayformat = [Field]` names the parent
 * field that the select and the report cell show; the lookup endpoint and the
 * report's parent read use that field instead of the `values = Form.Field`
 * link field. An expression format over one composite field (`[" " + Name.first_name + ...]`)
 * keeps its part refs on `displayFields` so the client can join them. A format
 * over several fields (`[Member_ID + " - " + Name.first_name]`) keys the
 * lookup by its first field and carries the whole format as `displayFormat`
 * terms: the server composes the text from the parent row.
 *
 * Column properties also carry display meaning: `displaytrue` / `displayfalse`
 * replace a boolean cell, `field =` is a cell formula shown when every name it
 * reads is on the row, and `view = Some_Report` makes the cell a link to that
 * report.
 */
import { unquote, type App, type Field, type Property, type ReportColumn } from '../../../core/src/ir.js';
import type { UiField, UiModel, UiReport } from '../model.js';

export type DisplayTerm = { ref: string } | { text: string };
type DisplayLookup = { form: string; field?: string; endpoint?: string; displayFields?: string[]; displayFormat?: DisplayTerm[] };
type DisplayColumn = UiReport['columns'][number] & {
  displayTrue?: string;
  displayFalse?: string;
  formula?: string;
  view?: string;
  viewLabel?: string;
  lookup?: DisplayLookup;
};

function propOf(ps: Property[] | undefined, key: string): string | undefined {
  const hit = (ps ?? []).find((item) => item.key.toLowerCase() === key);
  return hit ? unquote(hit.value) : undefined;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]+)*/y;
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * Reads the quoted literal opening at `start`, a backslash escaping the next
 * character on the same line. Returns `{ end }`, the index after the closing
 * quote, or `{ failAt }`, where the literal broke off: a backslash at the end
 * or before a line break, or the end of the text.
 */
function closeQuote(inner: string, start: number): { end: number } | { failAt: number } {
  const quote = inner[start];
  for (let i = start + 1; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === quote) return { end: i + 1 };
    if (ch === '\\') {
      if (i + 1 >= inner.length || LINE_BREAK.test(inner[i + 1]!)) return { failAt: i };
      i++;
    }
  }
  return { failAt: inner.length };
}

/**
 * Field refs and string literals of a `displayformat` bracket, left to right,
 * in one linear pass. A quote that never closes is skipped like any other
 * stray character. A later quote of the same kind before the point where that
 * literal broke off sits inside it and breaks off at the same point, so it is
 * skipped without rescanning.
 */
function scanTerms(format: string): DisplayTerm[] {
  const inner = format.trim().replace(/^\[/, '').replace(/\]$/, '');
  const terms: DisplayTerm[] = [];
  const failAt = new Map<string, number>();
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i]!;
    if ((ch === '"' || ch === "'") && i >= (failAt.get(ch) ?? -1)) {
      const literal = closeQuote(inner, i);
      if ('end' in literal) {
        terms.push({ text: inner.slice(i + 1, literal.end - 1).replace(/\\(.)/g, '$1') });
        i = literal.end;
        continue;
      }
      failAt.set(ch, literal.failAt);
    } else if (/[A-Za-z_]/.test(ch)) {
      IDENT.lastIndex = i;
      const ref = IDENT.exec(inner)![0];
      terms.push({ ref });
      i += ref.length;
      continue;
    }
    i++;
  }
  return terms;
}

/** Field refs inside a `displayformat` bracket, string literals removed. */
export function displayRefs(format: string): string[] {
  return scanTerms(format).flatMap((term) => ('ref' in term ? [term.ref] : []));
}

/** A `displayformat` bracket as field refs and string literals, in order. */
export function displayTerms(format: string): DisplayTerm[] {
  return scanTerms(format);
}

/**
 * The parent field the lookup should read: the single bracket name in
 * `displayformat`, the shared top field of an expression format, the first
 * field of a format over several fields (with the format's terms), or the
 * `values =` field when the format names nothing.
 */
export function displayChoice(lookup: { form: string; field?: string; displayFormat?: string }): {
  field: string;
  displayFields?: string[];
  displayFormat?: DisplayTerm[];
} {
  const base = lookup.field || lookup.form;
  const refs = lookup.displayFormat ? displayRefs(lookup.displayFormat) : [];
  if (refs.length === 0) return { field: base };
  const top = refs[0]!.split('.')[0]!;
  const shared = refs.every((ref) => ref.split('.')[0] === top);
  return {
    field: top,
    ...(refs.length > 1 ? { displayFields: refs } : {}),
    ...(shared ? {} : { displayFormat: displayTerms(lookup.displayFormat!) }),
  };
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parent form -> lookup key field -> format terms, for every lookup in the
 * app whose `displayformat` spans several parent fields. The lookup endpoint
 * and the report's parent read compose the display text from these terms.
 * The first lookup (form order, then field order) wins a shared key. Names
 * that would reach an object prototype (`__proto__`, `constructor`,
 * `prototype`) are left out, and the maps have no prototype.
 */
export function lookupFormats(app: App): Record<string, Record<string, DisplayTerm[]>> {
  const byForm = new Map<string, Map<string, DisplayTerm[]>>();
  const visit = (fields: readonly Field[]): void => {
    for (const field of fields) {
      if (field.lookup) {
        const choice = displayChoice(field.lookup);
        const form = field.lookup.form;
        if (choice.displayFormat && !UNSAFE_KEYS.has(form) && !UNSAFE_KEYS.has(choice.field)) {
          let byField = byForm.get(form);
          if (!byField) byForm.set(form, (byField = new Map()));
          if (!byField.has(choice.field)) byField.set(choice.field, choice.displayFormat);
        }
      }
      if (field.subfields) visit(field.subfields);
    }
  };
  for (const form of app.forms) visit(form.fields);
  const out: Record<string, Record<string, DisplayTerm[]>> = Object.create(null);
  for (const [form, byField] of byForm) out[form] = Object.assign(Object.create(null), Object.fromEntries(byField));
  return out;
}

function decorateLookup(target: DisplayLookup | undefined, choice: ReturnType<typeof displayChoice>): void {
  if (!target) return;
  target.field = choice.field;
  if (choice.displayFields) target.displayFields = choice.displayFields;
  if (choice.displayFormat) target.displayFormat = choice.displayFormat;
  if (target.endpoint) {
    target.endpoint = `/lookups/${encodeURIComponent(target.form)}/${encodeURIComponent(choice.field)}`;
  }
}

function decorateField(ui: UiField, field: Field | undefined): void {
  if (field?.lookup && ui.lookup) decorateLookup(ui.lookup as DisplayLookup, displayChoice(field.lookup));
  if (ui.subfields && field?.subfields) {
    for (const sub of ui.subfields) {
      decorateField(sub, field.subfields.find((item) => item.name === sub.name));
    }
  }
}

function decorateColumn(column: DisplayColumn, source: ReportColumn | undefined, irField: Field | undefined, labels: Map<string, string>): void {
  if (irField?.lookup && column.lookup) decorateLookup(column.lookup, displayChoice(irField.lookup));
  if (!source) return;
  const displayTrue = propOf(source.properties, 'displaytrue');
  if (displayTrue !== undefined) column.displayTrue = displayTrue;
  const displayFalse = propOf(source.properties, 'displayfalse');
  if (displayFalse !== undefined) column.displayFalse = displayFalse;
  const formula = propOf(source.properties, 'field');
  if (formula !== undefined) column.formula = formula;
  const view = propOf(source.properties, 'view');
  if (view !== undefined) {
    column.view = view;
    column.viewLabel = labels.get(view) ?? view;
  }
}

/** Copies the export's lookup display choices onto the UI model. */
export function lookupDisplay(model: UiModel, app: App): void {
  const forms = new Map(app.forms.map((form) => [form.name, form]));
  for (const uiForm of model.forms) {
    const form = forms.get(uiForm.name);
    if (!form) continue;
    for (const ui of uiForm.fields) {
      decorateField(ui, form.fields.find((item) => item.name === ui.name));
    }
  }
  const reports = new Map(app.reports.map((report) => [report.name, report]));
  const labels = new Map(model.reports.map((report) => [report.name, report.label]));
  for (const uiReport of model.reports) {
    const form = uiReport.form ? forms.get(uiReport.form) : undefined;
    const source = reports.get(uiReport.name);
    for (const column of uiReport.columns as DisplayColumn[]) {
      decorateColumn(
        column,
        source?.columns.find((item) => item.field === column.field),
        form?.fields.find((item) => item.name === column.field),
        labels,
      );
    }
  }
}
