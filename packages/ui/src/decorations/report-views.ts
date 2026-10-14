/**
 * Quick view columns and detail blocks.
 * The list keeps the report columns when the report has no quick view.
 */

import type { App, Report, ReportView } from '../../../core/src/ir.js';
import { phoneColumns, reportColumnLabel } from '../../../core/src/phone-columns.js';
import type { UiModel, UiReport } from '../model.js';
import { reportFieldLabel } from './labels.js';

interface ReportDetailBlock {
  title: string;
  relatedField?: string;
  fields: { field: string; label: string }[];
}

type ViewReport = UiReport & { detailBlocks?: ReportDetailBlock[] };

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

function blocksOf(view: ReportView, app: App, source: Report): ReportDetailBlock[] {
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
 * (core phone-columns.ts). A related path (`Subform.Field`, `Lookup.Field`)
 * is left out; a report row carries only its own form's columns, so there is
 * no value to show for it.
 */
function phoneFields(app: App, source: Report): { field: string; label: string }[] {
  const form = source.form ? app.forms.find((item) => item.name === source.form) : undefined;
  const columns = source.columns
    .filter((column) => column.field)
    .map((column) => ({ field: column.field, label: reportColumnLabel(form, column.field, column.label) }));
  return phoneColumns(source, columns).filter((column) => !column.field.includes('.'));
}

function applyReportViews(model: UiModel, app: App): void {
  const byName = new Map(app.reports.map((report) => [report.name, report]));
  for (const report of model.reports) {
    const source = byName.get(report.name);
    if (!source) continue;
    report.phoneColumns = phoneFields(app, source);
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
      // A `column header` action the quickview does not list still renders.
      for (const column of prior.values()) { // determinism-allow: map insertion order is the export's report column order
        if (column.action && !merged.some((item) => item.field === column.field)) merged.push(column);
      }
      report.columns = merged;
    }
    const detail = pickView(source, 'detailview');
    if (detail && detail.blocks.length) (report as ViewReport).detailBlocks = blocksOf(detail, app, source);
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
