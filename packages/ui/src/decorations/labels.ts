/**
 * Labels, help hints, placeholders, instruction notes, and button wording.
 *
 * Pure decorator over a built model: it copies wording the app definition
 * already carries onto the model so the rendered screens can use it.
 * Report column headers prefer the column label, then the matching form
 * field's display name, then the link name. Help text, placeholders, and
 * instruction HTML move onto their fields. Add/edit button labels move onto
 * the form. Nothing is generated; missing wording leaves the model as built.
 */

import type { App, Field, Form } from '../../../core/src/ir.js';
import { unquote } from '../../../core/src/ir.js';
import type { UiField, UiForm, UiModel, UiReport, UiTodo } from '../model.js';
import { droppedStyleReason, droppedStyles } from '../pages.js';

declare module '../model.js' {
  interface UiField {
    /** Hint from a `type = help_text` annotation, shown under the control. */
    help?: string;
    /** Input hint from the field's `placeholder` property. */
    placeholder?: string;
    /** Stored instruction markup behind a notes block. */
    notesHtml?: string;
  }
  interface UiForm {
    /** Submit label for the add screen, from the `on add` submit button. */
    submitLabel?: string;
    /** Reset label for the add screen, from the `on add` reset button. */
    resetLabel?: string;
    /** Submit label for the edit screen, from the `on edit` submit button. */
    updateLabel?: string;
    /** Cancel label for the edit screen, from the `on edit` cancel button. */
    cancelLabel?: string;
  }
}

/**
 * Copy wording from the app definition onto the model, in place.
 * Deterministic: plain lookups over the definition, no I/O, no clock.
 */
export function applyLabels(app: App, model: UiModel): void {
  for (const form of model.forms) {
    const source = app.forms.find((item) => item.name === form.name);
    if (source) decorateForm(source, form);
    notesStyleTodos(form.name, form.fields, model.todos);
  }
  for (const report of model.reports) {
    decorateReport(app, report);
  }
}

/** A notes block whose markup loses a style declaration is listed as a TODO. */
function notesStyleTodos(formName: string, fields: UiField[], todos: UiTodo[]): void {
  for (const field of fields) {
    const dropped = field.widget === 'notes' && field.notesHtml ? droppedStyles(field.notesHtml) : [];
    if (dropped.length) todos.push({ area: 'field', name: `${formName}.${field.name}`, reason: droppedStyleReason(dropped) });
    if (field.subfields) notesStyleTodos(formName, field.subfields, todos);
  }
}

function decorateReport(app: App, report: UiReport): void {
  const source = app.reports.find((item) => item.name === report.name);
  if (!source) return;
  const form = source.form ? app.forms.find((item) => item.name === source.form) : undefined;
  for (const column of report.columns) {
    if (column.action) continue;
    const columnSource = source.columns.find((item) => item.field === column.field);
    // The show-columns alias wins unless it only repeats the link name; then
    // the field's display name, walking `Sub.Field` and lookup columns to the
    // subfield's label; the raw link name is the last resort.
    if (columnSource?.label && columnSource.label !== column.field) {
      column.label = columnSource.label;
      continue;
    }
    const display = reportFieldLabel(app, form, column.field);
    if (display) column.label = display;
  }
}

/**
 * Display name of a report column path, walking subform and lookup fields
 * (`Author.Name` reads the Name field on the form Author points at;
 * `Lines.Material` reads the Material subfield). Helper, not a pass.
 */
export function reportFieldLabel(app: App, form: Form | undefined, path: string): string | undefined {
  let fields: Field[] = form?.fields ?? [];
  let found: Field | undefined;
  for (const part of path.split('.')) {
    found = fields.find((item) => item.name === part);
    if (!found) return undefined;
    if (found.subfields.length) fields = found.subfields;
    else if (found.lookup) fields = app.forms.find((item) => item.name === found!.lookup?.form)?.fields ?? [];
    else fields = [];
  }
  return found?.displayName || undefined;
}

function decorateForm(source: Form, form: UiForm): void {
  for (const field of form.fields) {
    const fieldSource = source.fields.find((item) => item.name === field.name);
    if (fieldSource) decorateField(fieldSource, field);
  }
  decorateButtons(source, form);
}

function decorateField(source: Field, field: UiField): void {
  const help = helpMessage(source);
  if (help !== undefined) field.help = help;
  const placeholder = propValue(source, 'placeholder');
  if (placeholder !== undefined) field.placeholder = placeholder;
  if (field.widget === 'notes') {
    const value = propValue(source, 'value');
    if (value !== undefined) field.notesHtml = value;
  }
  for (const sub of field.subfields ?? []) {
    const subSource = source.subfields.find((item) => item.name === sub.name);
    if (subSource) decorateField(subSource, sub);
  }
}

/** Message of the first `type = help_text` annotation, decoded. */
function helpMessage(source: Field): string | undefined {
  for (const block of source.annotations) {
    const kind = block.properties.find((p) => p.key.toLowerCase() === 'type');
    if (!kind || unquote(kind.value).toLowerCase() !== 'help_text') continue;
    const message = block.properties.find((p) => p.key.toLowerCase() === 'message');
    if (message !== undefined) return unquote(message.value);
  }
  return undefined;
}

function propValue(source: Field, key: string): string | undefined {
  const found = source.properties.find((p) => p.key.toLowerCase() === key);
  return found ? unquote(found.value) : undefined;
}

function decorateButtons(source: Form, form: UiForm): void {
  for (const action of source.actions) {
    const event = action.event.trim().toLowerCase();
    if (event === 'on add') {
      const submit = buttonLabel(action.buttons, 'submit');
      if (submit !== undefined) form.submitLabel = submit;
      const reset = buttonLabel(action.buttons, 'reset');
      if (reset !== undefined) form.resetLabel = reset;
    } else if (event === 'on edit') {
      const update = buttonLabel(action.buttons, 'submit');
      if (update !== undefined) form.updateLabel = update;
      const cancel = buttonLabel(action.buttons, 'cancel');
      if (cancel !== undefined) form.cancelLabel = cancel;
    }
  }
}

function buttonLabel(buttons: Form['actions'][number]['buttons'], type: string): string | undefined {
  const found = buttons.find((item) => (item.type ?? '').toLowerCase() === type);
  return found?.displayName || undefined;
}
