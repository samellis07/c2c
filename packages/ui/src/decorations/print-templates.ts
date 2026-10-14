/**
 * Record print layouts. A report's `print template = <Name>` property selects a
 * layout block kept on the report's form (`print template { <Name> { ... } }`,
 * also `record summary { ... }` in older exports). The resolved layout rides
 * the report model; the record view draws it for the reader's print dialog.
 */

import type { App, Form, PropertyBlock, Report } from '../../../core/src/ir.js';
import { unquote } from '../../../core/src/ir.js';
import type { UiModel, UiPrintElement, UiPrintTemplate, UiReport } from '../model.js';
import { cleanStyle, droppedStyleReason, droppedStyles } from '../pages.js';

type PrintReport = UiReport & { printTemplate?: UiReport['printTemplate'] };

function isModel(value: unknown): value is UiModel {
  return !!value && typeof value === 'object' && (value as UiModel).dryRun === true && Array.isArray((value as UiModel).reports);
}

function isApp(value: unknown): value is App {
  return !!value && typeof value === 'object' && !('dryRun' in (value as object)) && Array.isArray((value as App).reports);
}

function prop(block: PropertyBlock, key: string): string | undefined {
  const found = block.properties.find((p) => p.key.toLowerCase() === key);
  return found ? unquote(found.value) : undefined;
}

function reportProp(report: Report, key: string): string | undefined {
  const found = report.properties.find((p) => p.key.toLowerCase() === key);
  return found ? unquote(found.value) : undefined;
}

function templateBlock(form: Form | undefined, name: string): PropertyBlock | undefined {
  for (const block of form?.blocks ?? []) {
    const head = block.name.trim().toLowerCase();
    if (head !== 'print template' && head !== 'record summary') continue;
    const match = block.blocks.find((item) => item.name === name);
    if (match) return match;
  }
  return undefined;
}

interface RawContainer {
  elements?: unknown;
}

interface RawElement {
  type?: unknown;
  element?: Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function styleProp(element: Record<string, unknown>, key: string): { [key: string]: string } {
  const value = text(element[key]);
  return value ? { [key]: value } : {};
}

function fieldList(element: Record<string, unknown>): UiPrintElement['fields'] {
  const raw = element.refFields;
  if (!Array.isArray(raw)) return undefined;
  const fields = raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      field: String(item.Label_Name ?? ''),
      label: text(item.labelText) ?? String(item.Label_Name ?? ''),
      ...styleProp(item, 'labelStyle'),
      ...styleProp(item, 'valueStyle'),
    }))
    .filter((item) => item.field);
  return fields.length ? fields : undefined;
}

function elementOf(raw: RawElement): UiPrintElement {
  const type = typeof raw?.type === 'string' ? raw.type : '';
  const element = (raw?.element && typeof raw.element === 'object' ? raw.element : {}) as Record<string, unknown>;
  switch (type) {
    case 'columns': {
      const cols = Array.isArray(element.collayouts) ? element.collayouts : [];
      return {
        type: 'columns',
        ...(text(element.split) ? { split: String(element.split) } : {}),
        columns: cols.map((col) => {
          const inner = col && typeof col === 'object' ? (col as Record<string, unknown>).colElements : undefined;
          return (Array.isArray(inner) ? inner : []).map((item) => elementOf(item as RawElement));
        }),
      };
    }
    case 'text':
      return { type: 'text', html: text(element.content) ?? '' };
    case 'fields':
      return {
        type: 'field',
        field: String(element.Label_Name ?? ''),
        label: text(element.labelText) ?? String(element.Label_Name ?? ''),
        ...styleProp(element, 'labelStyle'),
        ...styleProp(element, 'valueStyle'),
        ...styleProp(element, 'valueTextStyle'),
        ...styleProp(element, 'wrapperStyle'),
        ...styleProp(element, 'labelTextStyle'),
      };
    case 'lookupfields': {
      const fields = fieldList(element);
      return {
        type: 'lookup',
        field: String(element.Label_Name ?? ''),
        label: text(element.labelText) ?? String(element.Label_Name ?? ''),
        ...(fields ? { fields } : {}),
      };
    }
    case 'image':
      return {
        type: 'image',
        ...(element.Label_Name ? { field: String(element.Label_Name) } : {}),
        ...(text(element.src) ? { src: String(element.src) } : {}),
        ...(text(element.caption) || text(element.alt) ? { alt: (text(element.caption) ?? text(element.alt))! } : {}),
        ...(text(element.elemStyle) ? { style: String(element.elemStyle) } : {}),
      };
    case 'spacer':
      return { type: 'spacer', ...(text(element.height) ? { height: String(element.height) } : {}) };
    default:
      return { type: 'todo', note: `Print element "${type || 'unknown'}" is not generated.` };
  }
}

function elementsOf(content: Record<string, unknown>): UiPrintElement[] {
  const layout = Array.isArray(content.mainLayout) ? content.mainLayout : [];
  const out: UiPrintElement[] = [];
  for (const section of layout as RawContainer[]) {
    const elements = section && typeof section === 'object' ? section.elements : undefined;
    for (const item of Array.isArray(elements) ? elements : []) out.push(elementOf(item as RawElement));
  }
  return out;
}

function applyPrintTemplates(model: UiModel, app: App): void {
  const byName = new Map(app.reports.map((report) => [report.name, report]));
  for (const report of model.reports) {
    const source = byName.get(report.name);
    if (!source) continue;
    const name = reportProp(source, 'print template');
    if (!name) continue;
    const form = source.form ? app.forms.find((item) => item.name === source.form) : undefined;
    const block = templateBlock(form, name);
    if (!block) {
      model.todos.push({ area: 'report', name: report.name, reason: `Print template "${name}" is not defined on ${source.form || 'the report form'}.` });
      continue;
    }
    const parsed = templateFromBlock(name, block);
    if (!parsed) {
      model.todos.push({ area: 'report', name: report.name, reason: `Print template "${name}" has no layout content.` });
      continue;
    }
    const target = report as PrintReport;
    target.printTemplate = parsed;
    const dropped = layoutStyleDrops(target.printTemplate.style, target.printTemplate.elements);
    if (dropped.length) model.todos.push({ area: 'report', name: report.name, reason: `Print template "${name}": ${droppedStyleReason(dropped)}` });
    // A record view must exist to print from, even when the export has no detail view.
    report.detail = true;
  }
}

/** Style declarations the record view will refuse in a layout's own markup and styles. */
function layoutStyleDrops(style: string | undefined, elements: UiPrintElement[]): string[] {
  const dropped = style ? cleanStyle(style).dropped : [];
  for (const el of elements) {
    if (el.html) dropped.push(...droppedStyles(el.html));
    for (const value of [el.style, el.labelStyle, el.valueStyle, el.valueTextStyle, el.wrapperStyle, el.labelTextStyle]) {
      if (value) dropped.push(...cleanStyle(value).dropped);
    }
    for (const field of el.fields ?? []) {
      for (const value of [field.labelStyle, field.valueStyle]) if (value) dropped.push(...cleanStyle(value).dropped);
    }
    for (const column of el.columns ?? []) dropped.push(...layoutStyleDrops(undefined, column));
  }
  return dropped;
}

/** Parse a `print template`/`record summary` child block into a layout, or undefined when it has no layout content. */
function templateFromBlock(name: string, block: PropertyBlock): UiPrintTemplate | undefined {
  const content = prop(block, 'content');
  let data: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = content ? JSON.parse(content) : undefined;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = undefined;
  }
  if (!data) return undefined;
  return {
    name,
    label: prop(block, 'displayname') || name,
    ...(text(data.templateStyle) ? { style: String(data.templateStyle) } : {}),
    ...(text(data.themeFont) ? { font: String(data.themeFont) } : {}),
    elements: elementsOf(data),
  };
}

/**
 * Every `print template` layout in the app, keyed form link name -> template
 * name -> layout (keys sorted, so the JSON is stable). sendmail `template:`
 * attachments render against this catalog; `_default*` names are the built-in
 * record summary and are not listed here.
 */
export function mailTemplateCatalog(app: App): Record<string, Record<string, UiPrintTemplate>> {
  const catalog: Record<string, Record<string, UiPrintTemplate>> = {};
  for (const form of [...app.forms].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const layouts: Record<string, UiPrintTemplate> = {};
    for (const block of form.blocks ?? []) {
      const head = block.name.trim().toLowerCase();
      if (head !== 'print template' && head !== 'record summary') continue;
      for (const child of [...block.blocks].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const parsed = templateFromBlock(child.name, child);
        if (parsed) layouts[child.name] = parsed;
      }
    }
    if (Object.keys(layouts).length) catalog[form.name] = layouts;
  }
  return catalog;
}

/**
 * `printTemplates(model, app)` and `printTemplates(app, model)` both apply.
 */
export function printTemplates(first: App | UiModel, second?: App | UiModel): UiModel {
  const model = isModel(first) ? first : isModel(second) ? second : undefined;
  const app = isApp(first) ? first : isApp(second) ? second : undefined;
  if (!model) throw new Error('A print layout needs the interface model.');
  if (app) applyPrintTemplates(model, app);
  return model;
}
