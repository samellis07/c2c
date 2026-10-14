/**
 * IR → PWA model. Widgets follow the schema mapping. A construct this step
 * does not draw is status "todo" and is listed on the model; it is not dropped.
 */

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App, Field, Form, Property, Report } from '../../core/src/ir.js';
import { unquote } from '../../core/src/ir.js';
import type { BlueprintFieldSpec } from '../../deluge/src/blueprint-rules.js';
import { blueprintFieldSpecs, type GeneratedFile } from '../../deluge/src/generate.js';
import { reportCriteria } from '../../deluge/src/translate.js';
import { requiredCompositePart } from '../../schema/src/composite-parts.js';
import { CURRENCY_CODES, fieldTypeRow, normalizeType, type FieldTypeRow } from '../../schema/src/mapping.js';
import { criteriaHasTodo, sealRelativeCriteria } from '../../shims/src/criteria.js';
import { LIMITS } from '../../shims/src/index.js';
import { droppedStyleReason, droppedStyles, elementsFromZml, leaves, type UiElement } from './pages.js';

export type Widget =
  | 'text'
  | 'textarea'
  | 'email'
  | 'phone'
  | 'number'
  | 'decimal'
  | 'percent'
  | 'currency'
  | 'date'
  | 'datetime'
  | 'time'
  | 'decision'
  | 'select'
  | 'radio'
  | 'multiselect'
  | 'lookup'
  | 'lookup-multi'
  | 'subform'
  | 'users'
  | 'file'
  | 'image'
  | 'audio'
  | 'video'
  | 'signature'
  | 'url'
  | 'richtext'
  | 'formula'
  | 'autonumber'
  | 'name'
  | 'address'
  | 'section'
  | 'notes'
  | 'barcode'
  | 'integration'
  | 'zia'
  | 'unsupported';

export interface UiField {
  name: string;
  label: string;
  widget: Widget;
  matrixId?: string;
  required: boolean;
  unique: boolean;
  readonly: boolean;
  status: 'generated' | 'todo';
  choices?: string[];
  lookup?: { form: string; field?: string; endpoint: string };
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  accept?: string;
  uploadEndpoint?: string;
  scan: boolean;
  initialValue?: string;
  note?: string;
  todo?: string;
  subfields?: UiField[];
  /** Row from the export, when the field has one. */
  row?: number;
  /** Column from the export, when the field has one. */
  column?: number;
  width?: string;
  height?: string;
  /** Section visibility, when the export sets it. */
  visibility?: boolean;
  /** Web label placement for the form (`top`, `left`, `labelinplace`). */
  labelPlacement?: string;
  /** False for an unnamed `Section` pseudo-field: it draws no heading. */
  titled?: boolean;
  /** ISO 4217 code the field stores: the field type (`USD`) when given, else the app `currency` setting. */
  currencyCode?: string;
  /** Fraction digits the field stores at (Creator `decimalplace`); default is two. */
  decimalPlaces?: number;
}

export interface UiHandler {
  form: string;
  event: string;
  when: string;
  field?: string;
  /** Creator record event (`on add`, `on edit`, `on add or edit`, …) the workflow ran under. */
  recordEvent?: string;
  /** Browser specifier token, replaced at the hash step. */
  module?: string;
  endpoint?: string;
  prefetch?: string;
}

export interface UiAction {
  name: string;
  workflow?: string;
  endpoint: string;
  /** `show action in view header = true` on the export: a toolbar button. */
  header?: boolean;
}

export interface UiReport {
  name: string;
  label: string;
  type: string;
  view: 'list' | 'kanban' | 'calendar' | 'timeline' | 'map' | 'pivot' | 'chart' | 'spreadsheet' | 'summary' | 'detail' | 'todo';
  form?: string;
  status: 'generated' | 'todo';
  todo?: string;
  /** A generated report that renders differently from the export's view type (map/pivot fallback to list) carries the reason here; it is not a todo. */
  note?: string;
  columns: { field: string; label: string; lookup?: { form: string; field: string }; numeric?: boolean; action?: string }[];
  /** Phone record card fields in card order (decorations/report-views.ts); the list columns are the web layout. */
  phoneColumns?: { field: string; label: string }[];
  filters: { field?: string; label?: string }[];
  sort: { field: string; order?: string }[];
  groupBy: { field: string }[];
  groupField?: string;
  basedOn?: string;
  /** Calendar/timeline: date columns on the form that place a row (`options { start date, end date }`). */
  startField?: string;
  endField?: string;
  /** Kanban card or calendar entry title (`options { display field }` on calendar/timeline). */
  titleField?: string;
  pageSize: number;
  queryEndpoint: string;
  editEndpoint?: string;
  /** Row record affordances — offered only when the report's form is generated. */
  rowActions?: { edit?: boolean; delete?: boolean };
  /** `conditional formatting` blocks: criteria is the compiled row predicate JSON; `{ op: 'todo' }` when it did not translate. */
  conditionalFormats?: { name: string; fields: string[]; criteria: unknown; format: string }[];
  customActions: UiAction[];
  detail: boolean;
  /** The report's `print template` selection resolved to its form's layout block. */
  printTemplate?: UiPrintTemplate;
  section?: string;
}

/**
 * One record print layout element (`print template` block `content` JSON).
 * `columns` nests its cells in `columns`; `text` keeps the layout HTML with
 * `${Field}` placeholders; `field` is a label/value pair; `lookup` is a
 * related-record table; `image` and `spacer` are self-evident.
 */
export interface UiPrintElement {
  type: 'columns' | 'text' | 'field' | 'lookup' | 'image' | 'spacer' | 'todo';
  /** `columns`: the export's `split` string (e.g. "50,50"). */
  split?: string;
  /** `columns`: per-column element lists. */
  columns?: UiPrintElement[][];
  /** `text`: raw layout HTML; `${Field}` placeholders are filled at render. */
  html?: string;
  /** `field`/`lookup`/`image`: the `Label_Name` of the record field. */
  field?: string;
  /** Display text (`labelText`), or the field name. */
  label?: string;
  labelStyle?: string;
  valueStyle?: string;
  valueTextStyle?: string;
  wrapperStyle?: string;
  labelTextStyle?: string;
  /** `lookup`: related-record columns from `refFields`. */
  fields?: { field: string; label: string; labelStyle?: string; valueStyle?: string }[];
  /** `image`: static source when the element is not field-bound. */
  src?: string;
  alt?: string;
  /** `image`/`spacer`: element style or spacer height (px). */
  style?: string;
  height?: string;
  /** `todo`: why this element is not drawn. */
  note?: string;
}

/** A form `print template` block resolved for one report. */
export interface UiPrintTemplate {
  name: string;
  /** `displayname`, or the block name. */
  label: string;
  /** `templateStyle` on the layout container. */
  style?: string;
  /** `themeFont`. */
  font?: string;
  elements: UiPrintElement[];
}

export interface UiPage {
  name: string;
  label: string;
  section?: string;
  /** `todo` = every element is a TODO; `partial` = at least one element needs manual work. */
  status: 'generated' | 'partial' | 'todo';
  elements: UiElement[];
  todo?: string;
}

export interface UiNav {
  name: string;
  hidden: boolean;
  items: { kind: string; name: string; label: string; href: string }[];
}

export interface UiTodo {
  area: 'field' | 'report' | 'page' | 'zml';
  name: string;
  reason: string;
}

/** Text-family widgets store a plain VarChar/Text value the run marker can occupy. */
export const SMOKE_MARKER_WIDGETS: ReadonlySet<string> = new Set(['text', 'textarea', 'email', 'url', 'phone', 'richtext']);

/**
 * The field a smoke run writes 'c2c smoke <tag>' into: the first required,
 * writable, text-family field. The plan (smoke.ts) and the generated
 * /admin/smoke endpoint use this same rule, so the marker the runner writes is
 * the field the endpoint checks before a delete.
 */
export function smokeMarkerField(fields: readonly UiField[] | undefined): string | undefined {
  return (fields ?? []).find((field) => field.required && !field.readonly && SMOKE_MARKER_WIDGETS.has(field.widget))?.name;
}

/**
 * The number field a smoke run writes 41 into and reads back to prove the live
 * read is a number: the first writable, non-unique, non-marker number field.
 */
export function smokeNumberField(fields: readonly UiField[] | undefined, markerField?: string): string | undefined {
  return (fields ?? []).find((field) => field.widget === 'number' && !field.readonly && !field.unique && field.name !== markerField)?.name;
}

export interface UiModel {
  dryRun: true;
  framework: 'vanilla';
  name?: string;
  pageSize: number;
  forms: UiForm[];
  reports: UiReport[];
  pages: UiPage[];
  nav: UiNav[];
  handlers: UiHandler[];
  todos: UiTodo[];
  /** Web theme, font, icon colour, and menu style from the export, when a decoration records them. */
  theme?: { theme?: string; font?: string; iconColor?: string; menu?: 'rail' | 'list' };
  /** The app `date format` setting, used for date placeholders and entry. */
  dateFormat?: string;
}

export interface UiForm {
  name: string;
  label: string;
  section?: string;
  fields: UiField[];
  submitEndpoint: string;
  /** Where an edit-mode submit posts. Falls back to `submitEndpoint`. */
  editSubmitEndpoint?: string;
  /** Scoped single-row read used to prefill the edit screen. */
  recordEndpoint: string;
  /** Record delete endpoint used by report row affordances. */
  deleteEndpoint: string;
  successMessage?: string;
  handlers: UiHandler[];
  /** Form grid width. One column everywhere; wider on desktop when a layout pass asks for it. */
  layout?: 'one' | 'two' | 'three';
  /**
   * Blueprint field settings governing this form: per stage and per
   * transition, which fields show and which may change. The record read
   * names the stored stage under `stages`; the edit screen hides and disables
   * fields to match. The server enforces the same rules.
   */
  stageFields?: BlueprintFieldSpec[];
}

export interface UiSummary {
  forms: number;
  formsGenerated: number;
  formsTodo: number;
  fields: number;
  fieldsGenerated: number;
  fieldsTodo: number;
  reports: number;
  reportsGenerated: number;
  reportsTodo: number;
  pages: number;
  pagesGenerated: number;
  pagesTodo: number;
  pageElements: number;
  pageElementsTodo: number;
  handlers: number;
  customActions: number;
  uploads: number;
  todos: UiTodo[];
}

const WIDGET: Record<string, Widget> = {
  'single-line': 'text',
  'multi-line': 'textarea',
  email: 'email',
  phone: 'phone',
  number: 'number',
  decimal: 'decimal',
  percent: 'percent',
  currency: 'currency',
  date: 'date',
  'date-time': 'datetime',
  time: 'time',
  'decision-box': 'decision',
  dropdown: 'select',
  radio: 'radio',
  'multi-select': 'multiselect',
  'checkbox-multi': 'multiselect',
  'lookup-single': 'lookup',
  'lookup-multi': 'lookup-multi',
  subform: 'subform',
  users: 'users',
  'file-upload': 'file',
  image: 'image',
  audio: 'audio',
  video: 'video',
  signature: 'signature',
  url: 'url',
  'rich-text': 'richtext',
  formula: 'formula',
  'auto-number': 'autonumber',
  name: 'name',
  address: 'address',
  section: 'section',
  'add-notes': 'notes',
  integration: 'integration',
  prediction: 'unsupported',
  keyword: 'zia',
  sentiment: 'zia',
  ocr: 'zia',
  'object-detection': 'zia',
  barcode: 'barcode',
  geolocation: 'unsupported',
  'legacy-crm': 'text',
  'legacy-crm-link': 'number',
  encrypted: 'text',
};

const READONLY = new Set<Widget>(['formula', 'autonumber', 'zia', 'barcode', 'section', 'notes', 'unsupported']);
const FILE_WIDGETS = new Set<Widget>(['file', 'image', 'audio', 'video', 'signature']);

const REPORT_VIEW: Record<string, UiReport['view']> = {
  list: 'list',
  report: 'list',
  grid: 'list',
  custom: 'list',
  kanban: 'kanban',
  calendar: 'calendar',
  timeline: 'timeline',
  map: 'map',
  pivottable: 'pivot',
  pivotchart: 'chart',
  chart: 'chart',
  spreadsheet: 'spreadsheet',
  sheet: 'spreadsheet',
  summary: 'summary',
};

export function buildModel(app: App, delugeFiles: GeneratedFile[] = []): UiModel {
  const todos: UiTodo[] = [];
  const forms = app.forms.map((form) => buildForm(form, todos, app));
  const reports = app.reports.map((report) => buildReport(app, report, todos));
  const pages = app.pages.map((page) => buildPage(page, todos));
  const handlers = handlersFrom(delugeFiles);
  for (const form of forms) {
    form.handlers = handlers.filter((handler) => handler.form === form.name);
    // A generated success module owns the submit write for its record-event
    // scope: `on add` handles add posts, `on edit` edit posts, and unscoped or
    // `on add or edit` handles both. `on delete` success never submits.
    const successAt = (scope: 'add' | 'edit') =>
      form.handlers.find((handler) => {
        if (handler.when !== 'success' || !handler.endpoint) return false;
        const rec = (handler.recordEvent ?? '').toLowerCase();
        if (rec === 'on delete') return false;
        return scope === 'add' ? rec !== 'on edit' : rec !== 'on add';
      });
    const addSuccess = successAt('add')?.endpoint;
    if (addSuccess) form.submitEndpoint = addSuccess;
    const editSuccess = successAt('edit')?.endpoint;
    if (editSuccess && editSuccess !== form.submitEndpoint) form.editSubmitEndpoint = editSuccess;
  }
  const dateFormat = app.settings.find((item) => item.key.toLowerCase() === 'date format');
  const model: UiModel = {
    dryRun: true,
    framework: 'vanilla',
    ...(app.name ? { name: app.name } : {}),
    pageSize: LIMITS.zcqlRowsPerQuery,
    forms,
    reports,
    pages,
    nav: navigation(app),
    handlers,
    todos,
    ...(dateFormat ? { dateFormat: unquote(dateFormat.value) } : {}),
  };
  applyDecorations(model, app);
  return model;
}

const requireDecoration = createRequire(import.meta.url);

/**
 * Run each compiled decoration in filename order.
 * A new file under decorations/ is picked up by its name; there is no import list.
 */
export function applyDecorations(model: UiModel, app: App, dir?: string): void {
  const root = dir ?? decorationDirectory();
  if (!root || !existsSync(root)) return;
  const names = readdirSync(root)
    .filter((name) => name.endsWith('.js'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const loaded = requireDecoration(join(root, name)) as Record<string, unknown>;
    const keys = Object.keys(loaded)
      .filter((key) => key !== '__esModule' && typeof loaded[key] === 'function')
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const seen = new Set<unknown>();
    for (const key of keys) {
      const fn = loaded[key];
      if (seen.has(fn)) continue;
      seen.add(fn);
      invokeDecoration(key, fn as (model: UiModel, app: App) => void, model, app);
    }
  }
}

/**
 * Most passes take the model, then the app. Wording takes the app, then the
 * model. Helpers that parse a format string or a lookup spec are not passes.
 * A pass that returns a new model copies those fields onto the model being built.
 */
const SWAPPED_DECORATION = new Set(['applyLabels']);
const DECORATION_HELPER = new Set(['displayRefs', 'displayChoice', 'reportFieldLabel']);

function invokeDecoration(key: string, fn: (model: UiModel, app: App) => void, model: UiModel, app: App): void {
  if (DECORATION_HELPER.has(key)) return;
  const result = SWAPPED_DECORATION.has(key)
    ? (fn as unknown as (app: App, model: UiModel) => unknown)(app, model)
    : (fn as unknown as (model: UiModel, app: App) => unknown)(model, app);
  if (!result || result === model || typeof result !== 'object') return;
  if ((result as { dryRun?: unknown }).dryRun !== true) return;
  const returned = result as unknown as Record<string, unknown>;
  const target = model as unknown as Record<string, unknown>;
  const names = Object.keys(returned).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    if (returned[name] !== target[name]) target[name] = returned[name];
  }
}

function decorationDirectory(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, 'decorations');
  return existsSync(dir) ? dir : undefined;
}

export function summarize(model: UiModel): UiSummary {
  const fields = model.forms.flatMap((form) => flatFields(form.fields));
  const pageLeaves = model.pages.flatMap((page) => leaves(page.elements));
  return {
    forms: model.forms.length,
    formsGenerated: model.forms.filter((form) => formStatus(form) === 'generated').length,
    formsTodo: model.forms.filter((form) => formStatus(form) === 'todo').length,
    fields: fields.length,
    fieldsGenerated: fields.filter((field) => field.status === 'generated').length,
    fieldsTodo: fields.filter((field) => field.status === 'todo').length,
    reports: model.reports.length,
    reportsGenerated: model.reports.filter((report) => report.status === 'generated').length,
    reportsTodo: model.reports.filter((report) => report.status === 'todo').length,
    pages: model.pages.length,
    pagesGenerated: model.pages.filter((page) => page.status === 'generated').length,
    pagesTodo: model.pages.filter((page) => page.status !== 'generated').length,
    pageElements: pageLeaves.length,
    pageElementsTodo: pageLeaves.filter((el) => el.kind === 'todo').length,
    handlers: model.handlers.length,
    customActions: model.reports.reduce((n, report) => n + report.customActions.length, 0),
    uploads: fields.filter((field) => field.uploadEndpoint).length,
    todos: model.todos,
  };
}

function flatFields(fields: UiField[]): UiField[] {
  const out: UiField[] = [];
  for (const field of fields) {
    out.push(field);
    if (field.subfields?.length) out.push(...flatFields(field.subfields));
  }
  return out;
}

function buildForm(form: Form, todos: UiTodo[], app: App): UiForm {
  const raw = form.properties.find((p) => p.key.toLowerCase() === 'success message')?.value;
  const success = raw?.replace(/^"([\s\S]*)"$/, '$1');
  return {
    name: form.name,
    label: form.displayName || form.name,
    ...(form.section ? { section: form.section } : {}),
    fields: form.fields.map((field) => buildField(field, todos, form.name, 0, app)),
    submitEndpoint: `/forms/${encodeURIComponent(form.name)}/submit`,
    recordEndpoint: `/forms/${encodeURIComponent(form.name)}/record`,
    deleteEndpoint: `/forms/${encodeURIComponent(form.name)}/delete`,
    ...(success ? { successMessage: success } : {}),
    handlers: [],
    ...stageFieldsOf(app, form.name),
  };
}

function stageFieldsOf(app: App, formName: string): { stageFields?: BlueprintFieldSpec[] } {
  const specs = blueprintFieldSpecs(app, formName).map((item) => item.spec);
  return specs.length ? { stageFields: specs } : {};
}

function buildField(field: Field, todos: UiTodo[], formName: string, depth = 0, app?: App): UiField {
  const row = resolveRow(field);
  let widget = row ? (WIDGET[row.id] ?? 'unsupported') : 'unsupported';
  const token = normalizeType(field.type);
  const subformToken = token === 'grid' || token === 'subform' || token === 'inline subform';
  // A grid whose `values` names another form is a linked subform: the linked
  // form's fields are its columns. Only a lookup that names no form falls
  // back to a multi lookup.
  const linked = field.lookup && subformToken ? app?.forms.find((item) => item.name === field.lookup?.form) : undefined;
  if (isUsers(field, token)) widget = 'users';
  else if (field.lookup && (token === 'list' || token === 'checkboxes' || subformToken) && !linked) widget = 'lookup-multi';
  else if (field.lookup && (token === 'picklist' || token === 'dropdown' || token === 'radiobuttons' || token === 'radio' || token === 'lookup' || !token)) widget = 'lookup';
  else if ((token === 'checkbox' || token === 'decision box' || token === 'decisionbox') && ((field.choices?.length ?? 0) > 0 || field.lookup)) {
    widget = field.lookup ? 'lookup-multi' : 'multiselect';
  }

  const ui: UiField = {
    name: field.name,
    label: field.displayName || field.name,
    widget,
    ...(row ? { matrixId: row.id } : {}),
    required: field.required,
    unique: field.unique,
    readonly: READONLY.has(widget),
    status: 'generated',
    scan: wantsScan(field),
  };

  if (widget === 'lookup') ui.matrixId = 'lookup-single';
  if (widget === 'lookup-multi') ui.matrixId = 'lookup-multi';
  if (widget === 'users') ui.matrixId = 'users';
  if (widget === 'multiselect' && (token === 'checkbox' || token === 'checkboxes')) ui.matrixId = 'checkbox-multi';
  if (field.lookup && subformToken && !linked) {
    ui.note = 'This grid points at another form. It is a multi lookup, not a second copy of that form.';
  }
  if (field.choices?.length && widget !== 'decision') ui.choices = field.choices;
  if (field.lookup && (widget === 'lookup' || widget === 'lookup-multi')) {
    ui.lookup = {
      form: field.lookup.form,
      ...(field.lookup.field ? { field: field.lookup.field } : {}),
      endpoint: `/lookups/${encodeURIComponent(field.lookup.form)}/${encodeURIComponent(field.lookup.field || field.lookup.form)}`,
    };
  }
  const max = intProp(field, ['maxchar', 'max char', 'max length']);
  const min = intProp(field, ['minchar', 'min char', 'min length']);
  if (min) ui.minLength = min;
  if (widget === 'text' || widget === 'email' || widget === 'phone') ui.maxLength = max ?? 255;
  else if (widget === 'textarea' || widget === 'richtext') ui.maxLength = max ?? 10_000;
  else if (widget === 'url') ui.maxLength = max;
  else if (max) ui.maxLength = max;
  const pattern = patternOf(field);
  if (pattern.bad) {
    ui.todo = 'Field regex did not compile; the pattern was not copied.';
    todos.push({ area: 'field', name: `${formName}.${field.name}`, reason: ui.todo });
  } else if (pattern.value) ui.pattern = pattern.value;
  if (field.initialValue) ui.initialValue = unquote(field.initialValue);
  if (FILE_WIDGETS.has(widget)) {
    ui.uploadEndpoint = `/uploads/${encodeURIComponent(formName)}/${encodeURIComponent(field.name)}`;
    ui.accept = widget === 'image' || widget === 'signature' ? 'image/*' : widget === 'audio' ? 'audio/*' : widget === 'video' ? 'video/*' : undefined;
    ui.note =
      widget === 'signature'
        ? 'A signature pad uploads the drawn strokes as JSON. The dry-run function does not write to Stratus.'
        : 'The column stores a Stratus object key. The dry-run upload does not write bytes.';
  }
  if (widget === 'zia') ui.note = 'Filled after submit. The form shows the stored text; it does not call Zia.';
  if (widget === 'formula' || widget === 'autonumber' || widget === 'barcode') ui.note = 'Computed. The form shows it and does not accept a typed value.';
  if (widget === 'name' || widget === 'address') {
    const parts = field.subfields.length ? field.subfields : defaultParts(widget);
    const partNames = parts.map((part) => part.name);
    ui.subfields = parts.map((part) => {
      const subUi = buildField(part, todos, formName, depth + 1, app);
      // A required composite requires its identifying parts, which changes validation.
      if (field.required && requiredCompositePart(widget, part.name, partNames)) subUi.required = true;
      return subUi;
    });
    if (!field.subfields.length) ui.note = 'The export lists no parts. The generated parts are the schema mapping defaults.';
  }
  if (widget === 'subform') {
    // Columns come from the linked form — skipping the bidirectional pointer
    // back to this field and layout blocks that are not columns — or from
    // inline subfields. The back-pointer is whichever side the export marks:
    // the child's own `bidirectional` or the name this field's carries.
    const backref = prop(field, 'bidirectional');
    const source = linked
      ? linked.fields.filter((sub) => prop(sub, 'bidirectional') !== field.name && sub.name !== backref)
      : field.subfields;
    const built = depth < 4 ? source.map((part) => buildField(part, todos, linked ? linked.name : formName, depth + 1, app)) : [];
    const columns = built.filter((sub) => sub.widget !== 'section' && sub.widget !== 'notes');
    if (!columns.length) {
      ui.status = 'todo';
      ui.todo = linked ? 'The linked form lists no subform columns.' : 'Inline subform has no fields.';
      todos.push({ area: 'field', name: `${formName}.${field.name}`, reason: ui.todo });
    } else {
      ui.subfields = columns;
      ui.note = 'Rows are edited in a grid and saved with the parent submit. There is no cross-table transaction.';
    }
  }
  if (widget === 'currency' || widget === 'decimal' || widget === 'percent') {
    const places = intProp(field, ['decimalplace', 'decimal places', 'decimal digits']);
    if (places !== undefined) ui.decimalPlaces = places;
  }
  if (widget === 'currency') {
    const code = CURRENCY_CODES.has(token) ? token.toUpperCase() : appCurrency(app);
    if (code) ui.currencyCode = code;
  }
  // A `Section` pseudo-field with no display name — or only the Creator default
  // `displayname = "Section"` — draws no heading.
  if (widget === 'section' && (!field.displayName || field.displayName.trim().toLowerCase() === 'section')) ui.titled = false;
  if (!row && !field.lookup) {
    ui.status = 'todo';
    ui.widget = 'unsupported';
    ui.todo = `No schema mapping for type ${field.type || '(none)'}.`;
    todos.push({ area: 'field', name: `${formName}.${field.name}`, reason: ui.todo });
  } else if (row && (row.id === 'prediction' || row.id === 'geolocation')) {
    ui.status = 'todo';
    ui.todo = row.reason;
    todos.push({ area: 'field', name: `${formName}.${field.name}`, reason: row.reason });
  }
  if (ui.unique) ui.note = [ui.note, 'Unique is enforced on the server. The browser cannot see other rows.'].filter(Boolean).join(' ');
  return ui;
}

function defaultParts(widget: 'name' | 'address'): Field[] {
  const names =
    widget === 'name'
      ? ['prefix', 'first_name', 'last_name', 'suffix']
      : ['address_line_1', 'address_line_2', 'district_city', 'state_province', 'postal_code', 'country', 'latitude', 'longitude'];
  return names.map((name) => ({
    name,
    type: name === 'latitude' || name === 'longitude' ? 'decimal' : 'text',
    modifiers: [],
    required: false,
    unique: false,
    properties: [],
    subfields: [],
    annotations: [],
    flags: [],
    span: { start: 0, end: 0 },
  }));
}

function resolveRow(field: Field): FieldTypeRow | undefined {
  const token = normalizeType(field.type);
  if (token && CURRENCY_CODES.has(token)) return fieldTypeRow('currency');
  return fieldTypeRow(field.type);
}

function isUsers(field: Field, token: string): boolean {
  if (token === 'users' || token === 'user') return true;
  return normalizeType(prop(field, 'module')) === 'users';
}

function wantsScan(field: Field): boolean {
  if (field.flags.some((flag) => /scan|qr|barcode/i.test(flag))) return true;
  return field.properties.some((p) => /scan|qr|barcode/i.test(p.key));
}

function prop(field: Field, key: string): string | undefined {
  const found = field.properties.find((p) => p.key.toLowerCase() === key);
  return found ? unquote(found.value) : undefined;
}

function intProp(field: Field, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = prop(field, key);
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

/** The app's `currency` setting as an ISO 4217 code, when it names one. */
function appCurrency(app?: App): string | undefined {
  const raw = app?.settings.find((item) => item.key.toLowerCase() === 'currency')?.value;
  const code = raw ? unquote(raw).trim().toLowerCase() : '';
  return CURRENCY_CODES.has(code) ? code.toUpperCase() : undefined;
}

function patternOf(field: Field): { value?: string; bad?: boolean } {
  for (const p of field.properties) {
    const key = p.key.toLowerCase();
    if (key !== 'regex' && key !== 'pattern' && !key.includes('regex')) continue;
    const raw = unquote(p.value);
    if (!raw) continue;
    try {
      // Compile only. The browser uses the source string.
      new RegExp(raw);
      return { value: raw };
    } catch {
      return { bad: true };
    }
  }
  return {};
}

function buildReport(app: App, report: Report, todos: UiTodo[]): UiReport {
  const type = report.type.toLowerCase();
  let view = REPORT_VIEW[type] ?? 'todo';
  const form = report.form ? app.forms.find((item) => item.name === report.form) : undefined;
  const columns = report.columns.map((column) => ({
    field: column.field,
    label: formField(form, column.field)?.displayName || column.label || column.field,
  }));
  const groupBy = report.groupBy.map((item) => ({ field: item.field }));
  let status: 'generated' | 'todo' = view === 'todo' ? 'todo' : 'generated';
  let todo: string | undefined;
  const options = reportOptions(report);
  const displayField = options.get('display field');
  let groupField = groupBy[0]?.field;
  // Creator writes the kanban lane field as `options { display field = Status }`.
  if (view === 'kanban' && displayField && formField(form, displayField)) groupField = displayField;
  if (view === 'kanban' && !groupField) {
    const dropdown = columns.find((column) => choiceField(form, column.field))?.field;
    if (dropdown) groupField = dropdown;
    else {
      status = 'todo';
      todo = 'Kanban needs a group-by field or a dropdown column.';
    }
  }
  let startField: string | undefined;
  let endField: string | undefined;
  let titleField: string | undefined;
  if (view === 'calendar' || view === 'timeline') {
    // Start and end must be date columns of the report's form, never a guess.
    const start = options.get('start date') ?? report.basedOn;
    const end = options.get('end date');
    if (!start) {
      status = 'todo';
      todo = `${view} needs a start date field.`;
    } else if (!dateField(form, start)) {
      status = 'todo';
      todo = `${view} start date "${start}" is not a date column of ${report.form || 'the report form'}.`;
    } else if (end && !dateField(form, end)) {
      status = 'todo';
      todo = `${view} end date "${end}" is not a date column of ${report.form || 'the report form'}.`;
    } else {
      startField = start;
      if (end) endField = end;
      titleField = displayField && formField(form, displayField) ? displayField : columns[0]?.field;
    }
  }
  if (view === 'kanban' && status === 'generated') titleField = columns.find((column) => column.field !== groupField)?.field ?? groupField;
  let note: string | undefined;
  if (view === 'map' && !hasLatLong(form)) {
    // No address column to plot; the rows, criteria, filters, grouping and
    // columns are unchanged. Only the pin map drops, so the list is faithful.
    view = 'list';
    note = 'Shown as a list: the source map has no address field to plot.';
  }
  if (view === 'pivot' && !groupBy.length) {
    // The export never carries the pivot's row, column and measure shelves,
    // so the underlying rows render as a list and the pivot stays manual.
    view = 'list';
    note = 'Shown as a list: the export does not carry the pivot row, column and measure shelves.';
    todos.push({
      area: 'report',
      name: report.name,
      reason: `Rebuild the pivot table manually: the export carries no pivot shelves, so pick the row, column and measure (aggregation) fields again over ${report.form || 'the report form'}.`,
    });
  }
  if (view === 'todo') todo = `Report type ${report.type || '(none)'} is not generated.`;
  // A criteria that did not translate must not widen the report to all rows.
  // The generated endpoint fails closed (zero rows, "filter not migrated"),
  // and the report renders this notice instead of a table.
  if (report.criteria?.trim() && criteriaHasTodo(reportCriteria(report.criteria))) {
    status = 'todo';
    todo = [todo, 'Filter not migrated: the report criteria could not be translated; the report returns no rows.'].filter(Boolean).join(' ');
  }
  for (const filter of report.filters) {
    if (filter.criteria?.trim() && criteriaHasTodo(reportCriteria(filter.criteria))) {
      todos.push({ area: 'report', name: report.name, reason: `Named filter "${filter.label ?? ''}" is not migrated; selecting it returns no rows.` });
    }
  }
  if (todo) todos.push({ area: 'report', name: report.name, reason: todo });
  const actions = report.customActions.map((action) => ({
    name: action.name,
    ...(action.workflow ? { workflow: action.workflow } : {}),
    endpoint: `/reports/${encodeURIComponent(report.name)}/actions/${slug(action.name)}`,
    ...(reportProp(action.properties, 'show action in view header') === 'true' ? { header: true as const } : {}),
  }));
  const builtColumns: UiReport['columns'] = columns.map((column) => ({
    ...column,
    ...lookupOf(form, column.field),
    ...(numericColumn(form, column.field) ? { numeric: true as const } : {}),
  }));
  // A custom action with `column header` renders as a record column, not a
  // toolbar button. The cell's button posts to the action endpoint.
  report.customActions.forEach((action, index) => {
    const head = reportProp(action.properties, 'column header');
    if (head === undefined || builtColumns.some((column) => column.field === action.name)) return;
    builtColumns.push({ field: action.name, label: head || action.name, action: actions[index].endpoint });
  });
  const formats = conditionalFormats(report);
  return {
    name: report.name,
    label: report.displayName || report.name,
    type: report.type,
    view: status === 'todo' ? 'todo' : view,
    ...(report.form ? { form: report.form } : {}),
    status,
    ...(todo ? { todo } : {}),
    ...(status === 'generated' && note ? { note } : {}),
    columns: builtColumns,
    filters: report.filters.map((filter) => ({
      ...(filter.field ? { field: filter.field } : {}),
      ...(filter.label ? { label: filter.label } : {}),
    })),
    sort: report.sortBy.map((item) => ({ field: item.field, ...(item.order ? { order: item.order } : {}) })),
    groupBy,
    ...(groupField ? { groupField } : {}),
    ...(report.basedOn ? { basedOn: report.basedOn } : {}),
    ...(startField ? { startField } : {}),
    ...(endField ? { endField } : {}),
    ...(titleField ? { titleField } : {}),
    pageSize: LIMITS.zcqlRowsPerQuery,
    queryEndpoint: `/reports/${encodeURIComponent(report.name)}`,
    ...(view === 'spreadsheet' ? { editEndpoint: `/reports/${encodeURIComponent(report.name)}/rows` } : {}),
    ...(form ? { rowActions: { edit: true, delete: true } } : {}),
    ...(formats.length ? { conditionalFormats: formats } : {}),
    customActions: actions,
    detail: report.views.some((item) => item.kind === 'detailview') || view === 'summary',
    ...(report.section ? { section: report.section } : {}),
  };
}

/**
 * `conditional formatting` blocks on the report. `fields = [A,B]` scopes the
 * paint to columns; absent `fields` paints the whole row. A condition that
 * does not translate keeps a `todo` predicate so the client can show a
 * fidelity note instead of painting nothing silently.
 */
function conditionalFormats(report: Report): NonNullable<UiReport['conditionalFormats']> {
  return report.conditionalFormats.map((format) => ({
    name: format.name,
    fields: formatFieldList(format.fields),
    criteria: sealRelativeCriteria(reportCriteria(format.condition || 'true')),
    format: format.format || '',
  }));
}

/** `[Vendor, Category]` → ['Vendor','Category']; bare `A,B` splits too. */
function formatFieldList(raw: string | undefined): string[] {
  const text = (raw ?? '').trim();
  if (!text) return [];
  const inner = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  return inner
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function reportProp(properties: Property[] | undefined, key: string): string | undefined {
  const found = (properties ?? []).find((p) => p.key.toLowerCase() === key);
  return found ? unquote(found.value) : undefined;
}

function reportOptions(report: Report): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of report.blocks) {
    if (block.name.trim().toLowerCase() !== 'options') continue;
    for (const p of block.properties) {
      const value = unquote(p.value).trim();
      if (value) out.set(p.key.trim().toLowerCase().replace(/\s+/g, ' '), value);
    }
  }
  return out;
}

function formField(form: Form | undefined, fieldName: string): Field | undefined {
  return form?.fields.find((item) => item.name === fieldName);
}

function dateField(form: Form | undefined, fieldName: string): boolean {
  const field = formField(form, fieldName);
  const id = field ? resolveRow(field)?.id : undefined;
  return id === 'date' || id === 'date-time';
}

/**
 * The lookup behind a report column, when the cell holds a parent ROWID.
 * Same display-field convention as the form select endpoint: the lookup's
 * field, or the parent form name when the export names none.
 */
function lookupOf(form: Form | undefined, fieldName: string): { lookup: { form: string; field: string } } | Record<string, never> {
  const target = form?.fields.find((item) => item.name === fieldName)?.lookup;
  if (!target) return {};
  return { lookup: { form: target.form, field: target.field || target.form } };
}

/** A report column over a number-family field: the client right-aligns it. Presentation only; the column list is unchanged. */
function numericColumn(form: Form | undefined, fieldName: string): boolean {
  const field = formField(form, fieldName);
  const id = field ? resolveRow(field)?.id : undefined;
  return id === 'number' || id === 'decimal' || id === 'percent' || id === 'currency';
}

function choiceField(form: Form | undefined, fieldName: string): boolean {
  const field = form?.fields.find((item) => item.name === fieldName);
  if (!field) return false;
  const token = normalizeType(field.type);
  return token === 'picklist' || token === 'dropdown' || token === 'radiobuttons' || token === 'radio' || !!field.choices?.length;
}

function hasLatLong(form: Form | undefined): boolean {
  if (!form) return false;
  const names: string[] = [];
  const walk = (field: Field) => {
    names.push(field.name.toLowerCase());
    field.subfields.forEach(walk);
  };
  form.fields.forEach(walk);
  const lat = names.some((name) => name === 'lat' || name.includes('latitude'));
  const lng = names.some((name) => name === 'lng' || name === 'lon' || name.includes('longitude'));
  return lat && lng;
}

function buildPage(page: App['pages'][number], todos: UiTodo[]): UiPage {
  const elements = page.zml.length ? elementsFromZml(page.zml) : page.content?.trim() ? [{ tag: 'text', kind: 'text' as const, text: page.content, children: [] }] : [];
  const pageLeaves = leaves(elements);
  const todoLeaves = pageLeaves.filter((el) => el.kind === 'todo');
  for (const el of todoLeaves) {
    todos.push({ area: 'zml', name: `${page.name}.${el.tag}`, reason: el.todo || `ZML <${el.tag}> has no generated component` });
  }
  for (const el of pageLeaves) {
    const dropped = el.kind === 'html' && el.html ? droppedStyles(el.html, true) : [];
    if (dropped.length) todos.push({ area: 'zml', name: `${page.name}.${el.tag}`, reason: droppedStyleReason(dropped) });
  }
  const status = pageLeaves.length > 0 && todoLeaves.length === pageLeaves.length ? 'todo' : todoLeaves.length > 0 ? 'partial' : 'generated';
  return {
    name: page.name,
    label: page.displayName || page.name,
    ...(page.section ? { section: page.section } : {}),
    status,
    elements,
    ...(status === 'todo' ? { todo: 'Every element on this page is a TODO.' } : {}),
  };
}

function navigation(app: App): UiNav[] {
  const sections: { name: string; hidden: boolean; components: { kind: string; name: string }[] }[] = app.sections.map((section) => ({
    name: section.displayName || section.name,
    hidden: section.hidden,
    components: section.components.map((component) => ({ kind: component.kind, name: component.name })),
  }));
  if (!sections.length) {
    const web = app.devices.find((device) => device.device === 'web');
    if (web) {
      for (const section of web.sections) {
        sections.push({
          name: section.name,
          hidden: false,
          components: section.components.map((component) => ({ kind: component.kind, name: component.name })),
        });
      }
    }
  }
  if (!sections.length) {
    sections.push({
      name: 'App',
      hidden: false,
      components: [
        ...app.forms.map((form) => ({ kind: 'form', name: form.name })),
        ...app.reports.map((report) => ({ kind: 'report', name: report.name })),
        ...app.pages.map((page) => ({ kind: 'page', name: page.name })),
      ],
    });
  }
  return sections.map((section) => ({
    name: section.name,
    hidden: section.hidden,
    items: section.components.map((component) => ({
      kind: component.kind,
      name: component.name,
      label: labelFor(app, component.name),
      href: hrefFor(app, component.kind, component.name),
    })),
  }));
}

function labelFor(app: App, name: string): string {
  return (
    app.forms.find((form) => form.name === name)?.displayName ||
    app.reports.find((report) => report.name === name)?.displayName ||
    app.pages.find((page) => page.name === name)?.displayName ||
    name
  );
}

function hrefFor(app: App, kind: string, name: string): string {
  if (app.forms.some((form) => form.name === name) || kind === 'form') return `#/form/${encodeURIComponent(name)}`;
  if (app.pages.some((page) => page.name === name) || kind === 'page') return `#/page/${encodeURIComponent(name)}`;
  return `#/report/${encodeURIComponent(name)}`;
}

interface HandlerMeta {
  form: string | null;
  event: string | null;
  when: string | null;
  prefetch: string | null;
  recordEvent: string | null;
}

function handlersFrom(files: GeneratedFile[]): UiHandler[] {
  const endpoints = new Set<string>();
  for (const file of files) {
    const match = /path:\s*"([^"]+)"/.exec(file.source);
    if (match) endpoints.add(match[1]);
  }
  const handlers: UiHandler[] = [];
  for (const file of files) {
    if (!file.path.startsWith('client/handlers/') || file.path.includes('/functions/')) continue;
    const meta = readMeta(file.source);
    if (!meta?.form || !meta.when || meta.when === 'function') continue;
    const browser = `slate/assets/handlers/${file.path.slice('client/handlers/'.length).replace(/\.mjs$/, '.js')}`;
    const endpoint = `/forms/${encodeURIComponent(meta.form)}/${meta.when}`;
    const input = /(?:user input|update) of\s+(.+)$/i.exec(meta.event ?? '');
    handlers.push({
      form: meta.form,
      event: meta.event ?? meta.when,
      when: meta.when,
      ...(input?.[1] ? { field: input[1].trim() } : {}),
      ...(meta.recordEvent ? { recordEvent: meta.recordEvent } : {}),
      module: `@@asset:${browser}@@`,
      ...(endpoints.has(endpoint) ? { endpoint } : {}),
      ...(meta.prefetch ? { prefetch: meta.prefetch } : {}),
    });
  }
  return handlers;
}

function readMeta(source: string): HandlerMeta | undefined {
  const match = /export const c2cHandler = (\{[\s\S]*?\});/.exec(source);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as HandlerMeta;
  } catch {
    return undefined;
  }
}

export function slug(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return cleaned || 'item';
}

export function formStatus(form: UiForm): 'generated' | 'todo' {
  const fields = flatFields(form.fields);
  if (!fields.length) return 'generated';
  return fields.every((field) => field.status === 'todo') ? 'todo' : 'generated';
}
