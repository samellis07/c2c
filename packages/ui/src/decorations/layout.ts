/**
 * Copy row, column, width, height, and section visibility from the export
 * onto each field, plus the web device's label placement.
 * Name and address parts with visibility turned off are left out.
 * The remaining parts are text, or decimal for latitude and longitude.
 */
import { unquote, type App, type Field } from '../../../core/src/ir.js';
import type { UiField, UiModel, UiTodo } from '../model.js';

export function layout(model: UiModel, app: App): void {
  const placement = webPlacement(app);
  for (const form of model.forms) {
    const ir = app.forms.find((item) => item.name === form.name);
    if (!ir) continue;
    copyLayout(form.fields, ir.fields, placement.get(form.name), form.name, model.todos, app);
    const width = gridWidth(form.fields);
    if (width !== 'one') form.layout = width;
  }
}

/** Desktop grid: one column unless a field sits in column 2 or 3. */
function gridWidth(fields: UiField[]): 'one' | 'two' | 'three' {
  let max = 1;
  for (const field of fields) {
    if (field.visibility === false || field.widget === 'section') continue;
    if (field.column != null && field.column > max) max = field.column;
  }
  if (max >= 3) return 'three';
  if (max >= 2) return 'two';
  return 'one';
}

function webPlacement(app: App): Map<string, string> {
  const out = new Map<string, string>();
  const web = app.devices.find((device) => device.device === 'web');
  if (!web) return out;
  for (const form of web.forms) {
    const text = textProp(form.properties, 'label placement');
    if (text) out.set(form.name, text);
  }
  return out;
}

function copyLayout(fields: UiField[], irFields: Field[], placement: string | undefined, formName: string, todos: UiTodo[], app: App): void {
  for (const ui of fields) {
    const ir = irFields.find((item) => item.name === ui.name);
    assignLayout(ui, ir, placement);
    if (!ir) continue;
    if ((ui.widget === 'name' || ui.widget === 'address') && ui.subfields) {
      ui.subfields = compositeParts(ui.subfields, ir, placement, formName, todos);
    } else if (ui.subfields?.length) {
      // A linked grid stores its columns on the other form, not on this field.
      const linked = linkedFormFields(app, ir);
      const nested = linked ?? ir.subfields;
      if (nested.length) copyLayout(ui.subfields, nested, placement, formName, todos, app);
    }
  }
}

/** Fields of the form a grid's `values` names, when that form is in the app. */
function linkedFormFields(app: App, ir: Field): Field[] | undefined {
  const name = ir.lookup?.form;
  if (!name) return undefined;
  return app.forms.find((item) => item.name === name)?.fields;
}

function compositeParts(parts: UiField[], ir: Field, placement: string | undefined, formName: string, todos: UiTodo[]): UiField[] {
  const kept: UiField[] = [];
  for (const sub of parts) {
    const part = ir.subfields.find((item) => item.name === sub.name);
    if (part && visibilityOf(part.properties) === false) {
      dropTodo(todos, formName, sub.name);
      continue;
    }
    const widget = sub.name === 'latitude' || sub.name === 'longitude' ? 'decimal' : 'text';
    sub.widget = widget;
    sub.matrixId = widget === 'decimal' ? 'decimal' : 'single-line';
    sub.status = 'generated';
    sub.readonly = false;
    delete sub.todo;
    if (widget === 'text' && sub.maxLength == null) sub.maxLength = 255;
    assignLayout(sub, part, placement);
    dropTodo(todos, formName, sub.name);
    kept.push(sub);
  }
  return kept;
}

function assignLayout(ui: UiField, ir: Field | undefined, placement: string | undefined): void {
  if (placement) ui.labelPlacement = placement;
  if (!ir) return;
  const row = numberProp(ir.properties, 'row');
  const column = numberProp(ir.properties, 'column');
  const width = layoutWidth(textProp(ir.properties, 'width'));
  const height = layoutLength(textProp(ir.properties, 'height'));
  if (row != null) ui.row = row;
  if (column != null) ui.column = column;
  if (width) ui.width = width;
  if (height) ui.height = height;
  const visibility = visibilityOf(ir.properties);
  // A hidden field is recorded on every widget; a section also keeps `true`.
  if (visibility === false || (visibility != null && ui.widget === 'section')) ui.visibility = visibility;
}

/** A field height is a plain CSS length; a value with extra syntax is dropped. */
function layoutLength(value: string | undefined): string | undefined {
  return value && /^\d+(\.\d+)?(px|%|em|rem)$/.test(value) ? value : undefined;
}

const WIDTH_WORDS = new Set(['small', 'medium', 'large']);

/** A field width is a plain CSS length or one of the export's size words. */
function layoutWidth(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (layoutLength(value) || WIDTH_WORDS.has(value.toLowerCase())) return value;
  return undefined;
}

function dropTodo(todos: UiTodo[], formName: string, fieldName: string): void {
  const name = `${formName}.${fieldName}`;
  for (let i = todos.length - 1; i >= 0; i--) {
    if (todos[i]?.area === 'field' && todos[i]?.name === name) todos.splice(i, 1);
  }
}

function textProp(properties: { key: string; value: string }[], key: string): string | undefined {
  const raw = properties.find((p) => p.key.toLowerCase() === key)?.value;
  if (raw == null) return undefined;
  const text = unquote(raw).trim();
  return text || undefined;
}

function numberProp(properties: { key: string; value: string }[], key: string): number | undefined {
  const text = textProp(properties, key);
  if (text == null) return undefined;
  const n = Number(text);
  if (!Number.isInteger(n)) return undefined;
  return n;
}

function visibilityOf(properties: { key: string; value: string }[]): boolean | undefined {
  const text = textProp(properties, 'visibility');
  if (text == null) return undefined;
  return text.toLowerCase() !== 'false';
}
