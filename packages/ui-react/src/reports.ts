/**
 * Report views: Creator report model -> ReportSpec view options.
 * Called by reactAppSpec; the list view (with grouping) is drawn by
 * lib/c2c-ui/report/ReportView, other views stay a counted stub.
 */
import type { App, Report as IrReport } from '../../core/src/ir.js';
import type { UiForm, UiReport } from '../../ui/src/model.js';
import type { ColumnSpec, ReportSpec } from '../template/lib/c2c-ui/types.js';
import { reportChart } from './charts.js';

/** Report views the skeleton draws as a table. */
export const LIST_VIEWS = new Set(['list', 'spreadsheet', 'summary', 'detail']);
const LIST_TYPES = new Set(['list', 'report', 'grid', 'custom', 'sheet', 'spreadsheet', 'summary']);

function humanize(name: string): string {
  return name.replace(/_+/g, ' ').trim();
}

function reportColumns(app: App, ir: IrReport | undefined, ui: UiReport): ColumnSpec[] {
  const fieldLabels = new Map((app.forms.find((f) => f.name === ui.form)?.fields ?? []).map((f) => [f.name, f.displayName ?? humanize(f.name)]));
  // The report's configured columns (the web quick view's fields, else the report's
  // column list) as decorated onto the interface model, like the vanilla runtime;
  // the IR column list is every field the report can return, not the set the layout shows.
  const source = ui.columns.map((c) => ({ field: c.field, label: c.label ?? fieldLabels.get(c.field) ?? humanize(c.field.split('.').pop() ?? c.field) }));
  const seen = new Set<string>();
  const columns = source.filter((c) => (seen.has(c.field) ? false : (seen.add(c.field), true)));
  // A `column header` custom action is a record column in the UI model; the IR
  // column list does not carry it, so append the action columns the source missed.
  for (const column of ui.columns) {
    if (column.action && !seen.has(column.field)) {
      seen.add(column.field);
      columns.push({ field: column.field, label: column.label });
    }
  }
  const actionOf = new Map(ui.columns.map((c) => [c.field, c.action]));
  const numericOf = new Set(ui.columns.filter((c) => c.numeric).map((c) => c.field));
  const quick = ir?.views.find((v) => v.kind === 'quickview' && v.device === 'phone');
  const phoneFields = new Set(quick ? quick.blocks.flatMap((b) => b.fields).map((c) => c.field) : []);
  const anyPhone = columns.some((c) => phoneFields.has(c.field));
  return columns.map((c, index) => {
    const action = actionOf.get(c.field);
    return {
      field: c.field,
      label: c.label,
      // Action cells stay on the phone card: the record actions are checked there.
      phone: action ? true : anyPhone ? phoneFields.has(c.field) : index < 4,
      // A `column header` custom action renders a per-record button, not a
      // value; a number-family column keeps its flag so string values sort as numbers.
      ...(action ? { action } : numericOf.has(c.field) ? { numeric: true as const } : {}),
    };
  });
}

/**
 * The todo note beside a drawn list says which layout is not drawn; the
 * internal reason ("Report type custom is not generated.") still goes to the
 * todo ledger. Any later sentence, such as a filter that was not migrated,
 * is kept.
 */
function listNote(ui: UiReport, todo: string): string {
  return todo.replace(/^Report type \S+ is not generated\./, `This report is shown as a plain list; its ${ui.type} layout is not drawn.`);
}

export function reportSpec(app: App, ui: UiReport, forms: UiForm[] = []): ReportSpec {
  const ir = app.reports.find((r) => r.name === ui.name);
  const listLike = LIST_VIEWS.has(ui.view) || (ui.view === 'todo' && LIST_TYPES.has(ui.type));
  const form = forms.find((f) => f.name === ui.form);
  return {
    name: ui.name,
    label: ui.label,
    view: listLike ? 'list' : ui.view === 'todo' ? ui.type : ui.view,
    ...(ui.note ? { note: ui.note } : {}),
    ...(ui.form ? { form: ui.form } : {}),
    queryEndpoint: ui.queryEndpoint,
    pageSize: ui.pageSize,
    columns: reportColumns(app, ir, ui),
    rowActions: { edit: ui.rowActions?.edit === true, delete: ui.rowActions?.delete === true },
    customActions: ui.customActions.map((a) => ({ name: a.name, endpoint: a.endpoint, ...(a.header === true ? { header: true as const } : {}) })),
    sort: ui.sort.map((s) => ({ field: s.field, ...(s.order ? { order: s.order } : {}) })),
    filters: ui.filters.map((f) => ({ ...(f.label ? { label: f.label } : {}), ...(f.field ? { field: f.field } : {}) })),
    groupBy: ui.groupBy.map((g) => ({ field: g.field })),
    ...(ui.groupField ? { groupField: ui.groupField } : {}),
    detail: ui.detail,
    ...(ui.detailBlocks?.length ? { detailBlocks: ui.detailBlocks.map((block) => ({
      title: block.title,
      ...(block.relatedField ? { relatedField: block.relatedField } : {}),
      fields: block.fields.map((field) => ({ field: field.field, label: field.label })),
    })) } : {}),
    ...(ui.titleField ? { titleField: ui.titleField } : {}),
    ...(ui.startField ? { startField: ui.startField } : {}),
    ...(ui.endField ? { endField: ui.endField } : {}),
    conditionalFormats: (ui.conditionalFormats ?? []).map((f) => ({ name: f.name, fields: f.fields, criteria: f.criteria, format: f.format })),
    ...(ui.view === 'chart' ? { chart: reportChart(app, ui) } : {}),
    ...(form?.recordEndpoint ? { recordEndpoint: form.recordEndpoint } : {}),
    ...(form?.deleteEndpoint ? { deleteEndpoint: form.deleteEndpoint } : {}),
    ...(ui.todo ? { todo: listLike ? listNote(ui, ui.todo) : ui.todo } : {}),
  };
}
