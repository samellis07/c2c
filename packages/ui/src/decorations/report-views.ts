/**
 * Quick view columns and detail blocks.
 * The list keeps the report columns when the report has no quick view.
 */

import type { App, Report, ReportView } from '../../../core/src/ir.js';
import { phoneColumns, reportColumnLabel } from '../../../core/src/phone-columns.js';
import type { UiModel, UiReport, UiReportDetailBlock } from '../model.js';
import { reportFieldLabel } from './labels.js';
import { compareEnUs } from '../../../core/src/order.js';

function isModel(value: unknown): value is UiModel {
  return !!value && typeof value === 'object' && (value as UiModel).dryRun === true && Array.isArray((value as UiModel).reports);
}

function isApp(value: unknown): value is App {
  return !!value && typeof value === 'object' && !('dryRun' in (value as object)) && Array.isArray((value as App).reports);
}

/** Web layout when the export has one, otherwise a layout with no device. */
function pickView(report: Report, kind: ReportView['kind']): ReportView | undefined {
  const found = report.views.filter((view) => view.kind === kind);
  return found.find((view) => view.device === 'web') ?? found.find((view) => !view.device) ?? found[0];
}

function fieldsOf(view: ReportView): { field: string; label?: string }[] {
  const out: { field: string; label?: string }[] = [];
  for (const block of view.blocks) {
    for (const field of block.fields) {
      if (!field.field) continue;
      out.push(field.label ? { field: field.field, label: field.label } : { field: field.field });
    }
  }
  return out;
}

function blocksOf(view: ReportView, app: App, source: Report): UiReportDetailBlock[] {
  const form = source.form ? app.forms.find((item) => item.name === source.form) : undefined;
  return view.blocks.map((block) => ({
    title: block.title || block.name,
    ...(block.relatedField ? { relatedField: block.relatedField } : {}),
    fields: block.fields
      .filter((field) => field.field)
      .map((field) => ({
        field: field.field,
        label:
          field.label ||
          reportFieldLabel(app, form, block.relatedField ? `${block.relatedField}.${field.field}` : field.field) ||
          field.field,
      })),
  }));
}

/**
 * The phone card's fields, in card order: the selection the scorer expects
 * (core phone-columns.ts). A dotted path stays only when its prefix is a
 * lookup field on the report's form — the query joins it (`Customer.Email`),
 * so the row carries a value. A subform or unresolvable path (`Hours.Days`)
 * has no value in a report row and stays off the card.
 */
function phoneFields(app: App, source: Report): { field: string; label: string }[] {
  const form = source.form ? app.forms.find((item) => item.name === source.form) : undefined;
  const lookupPrefix = new Set((form?.fields ?? []).filter((field) => field.lookup || field.type === 'lookup').map((field) => field.name));
  const columns = source.columns
    .filter((column) => column.field)
    .map((column) => ({ field: column.field, label: reportColumnLabel(form, column.field, column.label) }));
  return phoneColumns(source, columns).filter((column) => !column.field.includes('.') || lookupPrefix.has(column.field.split('.')[0]!));
}

/**
 * `model.reports` is built as `app.reports.map(buildReport)`: same length,
 * same order. Two reports can share a name (a report redeclared in a
 * device-scoped section, say), so matching by name alone can pair a model
 * report with the wrong same-named source and silently lose its declared
 * views; matching by position never does.
 */
function applyReportViews(model: UiModel, app: App): void {
  if (model.reports.length !== app.reports.length) return;
  for (let i = 0; i < model.reports.length; i++) {
    const report = model.reports[i]!;
    const source = app.reports[i]!;
    // Only columns the generated view carries make the phone card: a column
    // the model dropped (a name the form does not store) stays dropped.
    const carried = new Set(report.columns.map((column) => column.field));
    report.phoneColumns = phoneFields(app, source).filter((column) => carried.has(column.field));
    const quick = pickView(source, 'quickview');
    const quickFields = quick ? fieldsOf(quick) : [];
    if (quickFields.length) {
      const form = source.form ? app.forms.find((item) => item.name === source.form) : undefined;
      const prior = new Map(report.columns.map((column) => [column.field, column]));
      const actions = new Map(report.customActions.map((action) => [action.name, action]));
      const merged = quickFields.map((field) => {
        const existing = prior.get(field.field);
        // The quickview alias wins unless it only repeats the link name; then
        // the decorated column label; then the field's display name; never the
        // raw link name.
        const label =
          field.label && field.label !== field.field
            ? field.label
            : (existing?.label || reportFieldLabel(app, form, field.field) || field.field);
        if (existing) return { ...existing, field: field.field, label };
        const action = actions.get(field.field);
        return { field: field.field, label, ...(action ? { action: action.endpoint } : {}) };
      });
      // Declared columns the quickview does not list still render, in
      // show-columns order; a `column header` action among them keeps its cell.
      for (const column of prior.values()) { // determinism-allow: map insertion order is the export's report column order
        if (!merged.some((item) => item.field === column.field)) merged.push(column);
      }
      report.columns = merged;
    }
    const detail = pickView(source, 'detailview');
    if (detail) {
      if (detail.blocks.length) report.detailBlocks = blocksOf(detail, app, source);
      report.detailDevice = detail.device ?? 'web';
      // Other device layouts ride along: the generated record view swaps them
      // in at the matching breakpoint. The first layout per device wins; a
      // second layout for the same device cannot render, so it is not carried.
      const extras = new Map<string, UiReportDetailBlock[]>();
      for (const view of source.views) {
        if (view === detail || view.kind !== 'detailview' || !view.blocks.length) continue;
        const device = view.device ?? 'web';
        if (!extras.has(device)) extras.set(device, blocksOf(view, app, source));
      }
      if (extras.size) {
        report.deviceDetailBlocks = [...extras.entries()]
          .sort(([a], [b]) => compareEnUs(a, b))
          .map(([device, blocks]) => ({ device, blocks }));
      }
    }
  }
}

/**
 * `reportViews(model, app)` and `reportViews(app, model)` both apply.
 */
export function reportViews(first: App | UiModel, second?: App | UiModel): UiModel {
  const model = isModel(first) ? first : isModel(second) ? second : undefined;
  const app = isApp(first) ? first : isApp(second) ? second : undefined;
  if (!model) throw new Error('A report view needs the interface model.');
  if (app) applyReportViews(model, app);
  return model;
}
