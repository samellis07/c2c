/**
 * Lookup display values. A lookup's `displayformat = [Field]` names the parent
 * field that the select and the report cell show; the lookup endpoint and the
 * report's parent read use that field instead of the `values = Form.Field`
 * link field. An expression format over one composite field (`[" " + Name.first_name + ...]`)
 * keeps its part refs on `displayFields` so the client can join them.
 *
 * Column properties also carry display meaning: `displaytrue` / `displayfalse`
 * replace a boolean cell, `field =` is a cell formula shown when every name it
 * reads is on the row, and `view = Some_Report` makes the cell a link to that
 * report.
 */
import { unquote, type App, type Field, type Property, type ReportColumn } from '../../../core/src/ir.js';
import type { UiField, UiModel, UiReport } from '../model.js';

type DisplayLookup = { form: string; field?: string; endpoint?: string; displayFields?: string[] };
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

/**
 * The parent field the lookup should read: the single bracket name in
 * `displayformat`, the shared top field of an expression format, or the
 * `values =` field when the format names nothing or spans several fields.
 */
export function displayChoice(lookup: { form: string; field?: string; displayFormat?: string }): {
  field: string;
  displayFields?: string[];
} {
  const base = lookup.field || lookup.form;
  const refs = lookup.displayFormat ? displayRefs(lookup.displayFormat) : [];
  if (refs.length === 0) return { field: base };
  const top = refs[0]!.split('.')[0]!;
  const shared = refs.every((ref) => ref.split('.')[0] === top);
  return {
    field: shared ? top : base,
    ...(refs.length > 1 ? { displayFields: refs } : {}),
  };
}

function decorateLookup(target: DisplayLookup | undefined, choice: { field: string; displayFields?: string[] }): void {
  if (!target) return;
  target.field = choice.field;
  if (choice.displayFields) target.displayFields = choice.displayFields;
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
