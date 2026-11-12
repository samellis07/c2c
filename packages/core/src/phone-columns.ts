/**
 * Which report columns a phone record card shows. The generator and the UI
 * scorer both call these, so the cards and the scorer's expectation of them
 * cannot drift apart.
 */

import type { Form, Report } from './ir.js';

/** The phone quick view's fields when the source defines one, else the first four columns. */
export function phoneColumns<T extends { field: string }>(report: Report, columns: T[]): T[] {
  const view = report.views.find((v) => v.kind === 'quickview' && v.device === 'phone');
  const fields = new Set(view ? view.blocks.flatMap((b) => b.fields).map((c) => c.field) : []);
  const picked = columns.filter((c) => fields.has(c.field));
  return picked.length ? picked : columns.slice(0, 4);
}

/** A report column's label: the column alias, else the form field's display name, else the field name humanized. */
export function reportColumnLabel(form: Form | undefined, field: string, label?: string): string {
  if (label !== undefined) return label;
  // The last field of that name wins, as a name-keyed map of the form would.
  let source: Form['fields'][number] | undefined;
  for (const x of form?.fields ?? []) if (x.name === field) source = x;
  if (source) return source.displayName ?? humanize(source.name);
  return humanize(field.split('.').pop() ?? field);
}

function humanize(name: string): string {
  return name.replace(/_+/g, ' ').trim();
}
