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

/** Field refs inside a `displayformat` bracket, string literals removed. */
export function displayRefs(format: string): string[] {
  const inner = format.trim().replace(/^\[/, '').replace(/\]$/, '');
  const code = inner.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' ');
  return code.match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]+)*/g) ?? [];
}

/** A `displayformat` bracket as field refs and string literals, in order. */
export function displayTerms(format: string): DisplayTerm[] {
  const inner = format.trim().replace(/^\[/, '').replace(/\]$/, '');
  const terms: DisplayTerm[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]+)*)/g;
  for (const match of inner.matchAll(re)) {
    if (match[3] !== undefined) terms.push({ ref: match[3] });
    else terms.push({ text: (match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1') });
  }
  return terms;
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

/**
 * Parent form -> lookup key field -> format terms, for every lookup in the
 * app whose `displayformat` spans several parent fields. The lookup endpoint
 * and the report's parent read compose the display text from these terms.
 * The first lookup (form order, then field order) wins a shared key.
 */
export function lookupFormats(app: App): Record<string, Record<string, DisplayTerm[]>> {
  const out: Record<string, Record<string, DisplayTerm[]>> = {};
  const visit = (fields: readonly Field[]): void => {
    for (const field of fields) {
      if (field.lookup) {
        const choice = displayChoice(field.lookup);
        if (choice.displayFormat) {
          const byField = (out[field.lookup.form] ??= {});
          if (!Object.hasOwn(byField, choice.field)) byField[choice.field] = choice.displayFormat;
        }
      }
      if (field.subfields) visit(field.subfields);
    }
  };
  for (const form of app.forms) visit(form.fields);
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
