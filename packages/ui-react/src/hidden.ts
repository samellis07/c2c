/**
 * Parts of the generated React app that end users never see. A field,
 * report, chart, value or page element the generator cannot draw renders
 * nothing (or a neutral "not available yet" line) in the app; the reason is
 * a migration note for the developer, so it is listed here and carried into
 * `c2c analyze` and the migration report instead of the page.
 */
import { compareEnUs } from '../../core/src/order.js';
import type { AppSpec } from '../template/lib/c2c-ui/types.js';

export interface HiddenPart {
  /** `form X field Y`, `report X`, or `page X`. */
  location: string;
  reason: string;
}

/** An `{ op: 'todo' }` predicate at or under this criteria node. */
function criteriaTodo(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false;
  const node = c as { op?: unknown; args?: unknown; arg?: unknown };
  if (node.op === 'todo') return true;
  const kids = Array.isArray(node.args) ? node.args : node.arg ? [node.arg] : [];
  return kids.some(criteriaTodo);
}

/** A spec record's values in name order, so the list reads the same on every run. */
function byName<T>(record: Record<string, T> | undefined): T[] {
  return Object.keys(record ?? {})
    .sort(compareEnUs)
    .map((name) => record![name]!);
}

export function hiddenParts(spec: AppSpec): HiddenPart[] {
  const out: HiddenPart[] = [];
  for (const form of byName(spec.forms)) {
    for (const field of form.fields) {
      if (field.todo && !field.generated) out.push({ location: `form ${form.name} field ${field.name}`, reason: field.todo });
    }
  }
  for (const report of byName(spec.reports)) {
    const at = `report ${report.name}`;
    if (report.view !== 'list' && report.view !== 'chart') out.push({ location: at, reason: `the ${report.view} view is not drawn` });
    if (report.todo) out.push({ location: at, reason: report.todo });
    if (report.view === 'chart' && !report.chart) out.push({ location: at, reason: 'the chart settings were not migrated' });
    for (const todo of report.chart?.todos ?? []) out.push({ location: at, reason: todo });
    if (report.conditionalFormats.some((format) => criteriaTodo(format.criteria))) {
      out.push({ location: at, reason: 'a conditional formatting rule was not migrated; its highlighting is off' });
    }
    for (const filter of report.filters) {
      if (!filter.label && filter.field) out.push({ location: at, reason: `the field filter on ${filter.field} has no criteria and is not offered` });
    }
  }
  for (const page of byName(spec.pages)) {
    for (const todo of page.todos) out.push({ location: `page ${page.name}`, reason: todo });
  }
  return out;
}
