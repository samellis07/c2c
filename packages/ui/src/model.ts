/**
 * IR → PWA model. Widgets follow the schema mapping. A construct this step
 * does not draw is status "todo" and is listed on the model; it is not dropped.
 */

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App, Field, Form, FunctionDef, Property, Report } from '../../core/src/ir.js';
import { hasOthersOption, unquote } from '../../core/src/ir.js';
import { compareEnUs } from '../../core/src/order.js';
import type { BlueprintFieldSpec } from '../../deluge/src/blueprint-rules.js';
import { blueprintFieldSpecs, fnSignatureParams, functionRowBinding, slug as delugeSlug, type GeneratedFile } from '../../deluge/src/generate.js';
import type { Expr, Stmt } from '../../deluge/src/ast.js';
import { parse as parseDeluge, parseExpression } from '../../deluge/src/parser.js';
import { reportCriteria } from '../../deluge/src/translate.js';
import { requiredCompositePart } from '../../schema/src/composite-parts.js';
import { CURRENCY_CODES, fieldTypeRow, normalizeType, type FieldTypeRow } from '../../schema/src/mapping.js';
import { criteriaHasTodo, sealRelativeCriteria, type Criteria } from '../../shims/src/criteria.js';
import { LIMITS } from '../../shims/src/index.js';
import { multiValueDefault } from '../../shims/src/multi-value.js';
import { derivedFieldColumns, isMultiChoiceField } from '../../schema/src/generator.js';
import {
  droppedStyleReason,
  carriedStyleRules,
  droppedStyleRulesTodo,
  droppedStyles,
  droppedTagReason,
  elementsFromZml,
  leaves,
  type UiElement,
  type ZmlEnv,
} from './pages.js';
import type { HtmlpageFile } from './htmlpage.js';
import type { SnippetReason } from './snippet-guidance.js';

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
  /** Creator `others option = true`: the choice list also offers an "Others" free-text entry. */
  othersOption?: boolean;
  lookup?: { form: string; field?: string; endpoint: string; addNew?: { label?: string }; sort?: 'asc' | 'desc' };
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  accept?: string;
  uploadEndpoint?: string;
  /** Acquisition sources the `source` property allows (`file`, `public_url`, `camera`), in the export's order. */
  uploadSources?: string[];
  scan: boolean;
  initialValue?: string;
  note?: string;
  todo?: string;
  /** `enable linkname` flag on a URL field: the field also stores a link title. */
  linkName?: boolean;
  subfields?: UiField[];
  /** Row from the export, when the field has one. */
  row?: number;
  /** Column from the export, when the field has one. */
  column?: number;
  width?: string;
  height?: string;
  /** Field visibility from the export, when set; false fields render nothing and are never writable. */
  visibility?: boolean;
  /** Web label placement for the form (`top`, `left`, `labelinplace`). */
  labelPlacement?: string;
  /** Option columns for a radio or checkbox group (Creator field `layout`): 1, 2 or 3. */
  optionColumns?: 1 | 2 | 3;
  /** `onecolumncard` field layout: the options draw as a column of cards. */
  optionCard?: boolean;
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
  /**
   * The action's workflow generated no function to dispatch, so its endpoint
   * runs nothing: the button renders turned off with a note, and the action
   * is a counted todo (see actionDispatchTarget).
   */
  preview?: true;
  /**
   * The workflow's whole body is one `openUrl` to this app's own form, report
   * or page: the button navigates there in the client (see actionNavigation).
   */
  navigate?: UiActionNav;
}

/**
 * A client navigation lifted from an `openUrl("#Form:X?F=" + input.ID, ...)`
 * workflow. `href` is the generated route (`#/form/X`); each param prefills
 * the target form field `name` from the clicked row's `field` (`ROWID` for
 * `input.ID`) or from a literal `value`.
 */
export interface UiActionNav {
  kind: 'form' | 'report' | 'page';
  target: string;
  href: string;
  params: Array<{ name: string; field?: string; value?: string }>;
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
  /** Compiled `show all rows from Form [criteria]`. Same predicate the report stub exports as `baseCriteria`. `{ op: 'todo' }` when it did not translate. */
  criteria?: Criteria;
  columns: {
    field: string;
    label: string;
    /** `form`/`field` name the related display on the parent form; `source` is the row column holding the parent ROWID when it differs from `field` (a `Lookup.Part` subcolumn). */
    lookup?: { form: string; field: string; source?: string };
    numeric?: boolean;
    multiValue?: boolean;
    date?: 'date' | 'datetime';
    action?: string;
  }[];
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
  /** `options { display records per row = N }`: the list draws each record as a card, N cards per row. */
  recordsPerRow?: number;
  /** `options { label width = 20% }`: the record-card label column width (only meaningful with `recordsPerRow`). */
  labelWidth?: string;
  /** `options { record count = enable }`: the list header shows how many rows are shown. */
  showRecordCount?: boolean;
  queryEndpoint: string;
  /** Scoped single-row endpoint used by this report's detail route. */
  recordEndpoint?: string;
  editEndpoint?: string;
  /** Row record affordances — offered only when the report's form is generated. */
  rowActions?: { edit?: boolean; delete?: boolean };
  /** `conditional formatting` blocks: criteria is the compiled row predicate JSON; `{ op: 'todo' }` when it did not translate. */
  conditionalFormats?: { name: string; fields: string[]; criteria: unknown; format: string }[];
  customActions: UiAction[];
  detail: boolean;
  /** Ordered Creator detail view blocks, including related subform rows. */
  detailBlocks?: UiReportDetailBlock[];
  /** Device the `detailBlocks` layout came from; `web` covers an export view with no device. */
  detailDevice?: string;
  /** Detail layouts for devices other than `detailDevice`; the generated record view swaps them in at the device breakpoint. */
  deviceDetailBlocks?: { device: string; blocks: UiReportDetailBlock[] }[];
  /** The report's `print template` selection resolved to its form's layout block. */
  printTemplate?: UiPrintTemplate;
  section?: string;
}

export interface UiReportDetailBlock {
  title: string;
  relatedField?: string;
  fields: { field: string; label: string }[];
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
  /** Sanitized static CSS scoped to this page container. */
  scopedCss?: string;
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
  /** Stable source occurrence identifier when multiple TODOs describe identical click sites. */
  siteId?: string;
  /** Server-snippet TODOs: why the snippet stays counted. */
  manualReasons?: SnippetReason[];
  /** Server-snippet TODOs: the guided manual step, with its location. */
  manualStep?: string;
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

/** A device `customize { layout = ... }` value carried into the generated UI. */
export type DeviceLayout = 'one-column' | 'two-column' | 'one-column-card' | 'sliding-pane' | 'tab-bar';

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
  /** The app `time format` setting ("24-hr" / "12-hr"), used for date-time cells. */
  timeFormat?: string;
  /** The phone `customize { layout }` arrangement: form columns, card, drawer or tab bar. */
  phoneLayout?: DeviceLayout;
  /** The tablet `customize { layout }` arrangement. */
  tabletLayout?: DeviceLayout;
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
  /** The phone `customize { layout }` arrangement, copied from the model for the form's data attribute. */
  phoneLayout?: DeviceLayout;
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
/** Known remote document browsing sources for file fields that have no Catalyst equivalent. */
const BROWSE_REMOTE_SOURCES = new Set(['google_docs', 'zoho_docs']);

// A field marked `private` or `personal data` is a data-privacy flag, not a widget
// setting. Catalyst has no generated field-level privacy or access control, so each
// is recorded as a manual step rather than invented as UI.
const PRIVACY_PROPERTY_KEYS = ['private', 'personal data'];

// A scan-capable field's `manual input` setting toggles a free-text fallback next to
// the camera control. The generated scan field has no such fallback, so the setting
// is recorded as a manual step rather than invented as UI.
const SCAN_MANUAL_INPUT_PROPERTY_KEY = 'manual input';

// A video field's `duration` setting caps the recording length in Creator's own
// capture dialog. The generated field hands recording off to the device's native
// camera app with no such limit, so the setting is recorded as a manual step
// rather than invented as UI.
const VIDEO_DURATION_PROPERTY_KEY = 'duration';

// `show onload = true` (scan field: "get input before the form is displayed"; image
// field: launch the camera automatically) asks Creator to open the camera/scanner
// before the user sees the form. The generated form opens its capture control only
// on a user tap (the Scan button, the file/image input) and never on load, so the
// setting is recorded as a manual step rather than invented as UI.
const SHOW_ONLOAD_PROPERTY_KEY = 'show onload';

// An image field's `annotation` setting lets Creator's own capture dialog draw
// and mark up the photo before it is saved. The generated field has no drawing
// or markup tool at all, so the setting is recorded as a manual step rather
// than invented as UI.
const IMAGE_ANNOTATION_PROPERTY_KEY = 'annotation';

/**
 * A `bidirectional = Back` lookup pair gets a reverse column from the schema
 * generator only when one side is a linked grid (packages/schema/src/generator.ts
 * pendingRefs): a grid field pointing at the target, or a partner grid field on the
 * target naming this field back. Mirrors the eligibility check
 * packages/quality/src/no-silent-drop.ts bidirectionalProved makes against the real
 * schema, at the declaration level the UI model can see before schema generation runs.
 */
function bidirectionalLinkedGrid(item: Field | undefined, to: string): boolean {
  return item !== undefined && ['grid', 'subform', 'form'].includes((item.type ?? '').trim().toLowerCase()) && item.lookup?.form === to;
}

function bidirectionalReverseEligible(field: Field, formName: string, app: App, target: string, back: string): boolean {
  if (bidirectionalLinkedGrid(field, target)) return true;
  const partner = app.forms.find((form) => form.name === target)?.fields.find((item) => item.name === back);
  const partnerBack = partner?.properties.find((item) => item.key.trim().toLowerCase() === 'bidirectional');
  return bidirectionalLinkedGrid(partner, formName) && unquote(partnerBack?.value ?? '').trim() === field.name;
}

/** `alloweddays = 0,1,2,3,4,5,6` (every weekday) is the Creator default and needs no manual step. */
function isEveryWeekday(text: string): boolean {
  const days = new Set(text.split(',').map((day) => day.trim()));
  return days.size === 7 && ['0', '1', '2', '3', '4', '5', '6'].every((day) => days.has(day));
}

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

const UI_SNIPPET_FILES = Symbol('c2c.snippetFiles');

/** Endpoint modules compiled from a model's server-side `htmlpage` snippets. */
export function uiSnippetFiles(model: UiModel): HtmlpageFile[] {
  return (((model as unknown) as Record<symbol, unknown>)[UI_SNIPPET_FILES] as HtmlpageFile[] | undefined) ?? [];
}

/**
 * The function a report custom action dispatches, or undefined when there is
 * none. The action's workflow must name, exactly and case-sensitively, a
 * Creator `type = functions` workflow (kind `creator`, the same binding the
 * custom-action precheck accepts) whose execution type is `for each record`
 * or `collection of records`; a standalone Deluge function, a bare script, a
 * near-name or a workflow with no record execution type is not a binding.
 * Its generated module (functions/custom/<slug>.mjs) and the thisapp registry
 * (functions/thisapp.mjs) must also exist. The action endpoint (actionStub in
 * generate.ts) and the button state in the model both read this one
 * predicate, so a button is enabled exactly when its endpoint can run.
 */
function isPureClientFunction(app: App, fn: FunctionDef): boolean {
  let body: Stmt[];
  try {
    body = parseDeluge(fn.deluge.map((part) => part.text).join('\n')).body;
  } catch {
    return false;
  }
  if (body.length === 1 && body[0]?.kind === 'openUrl') return true;
  if (body.length === 1 && body[0]?.kind === 'expr' && body[0].expr.kind === 'call') {
    const calleeName = calleeFunctionName(body[0].expr.callee);
    if (!calleeName) return false;
    const calleeFn = app.functions.find((f) => f.name.toLowerCase() === calleeName.toLowerCase());
    if (!calleeFn) return false;
    try {
      const calleeBody = parseDeluge(calleeFn.deluge.map((p) => p.text).join('\n')).body;
      return calleeBody.length === 1 && calleeBody[0]?.kind === 'openUrl';
    } catch {
      return false;
    }
  }
  return false;
}

export function actionDispatchTarget(app: App, workflow: string | undefined, delugeFiles: readonly GeneratedFile[]): FunctionDef | undefined {
  const wanted = (workflow ?? '').trim();
  const fn = wanted ? app.functions.find((item) => item.kind === 'creator' && item.name === wanted) : undefined;
  if (!fn || !functionRowBinding(fn)) return undefined;
  if (isPureClientFunction(app, fn)) return undefined;
  const module = `functions/custom/${delugeSlug(fn.name || 'function')}.mjs`;
  const registered = delugeFiles.some((file) => file.path === 'functions/thisapp.mjs') && delugeFiles.some((file) => file.path === module);
  return registered ? fn : undefined;
}

/** `"https://app.zohocreator.<tld>" + zoho.appuri` or `zoho.appuri` alone: this app's own address. */
const OWN_APP_HOST = /^https:\/\/(?:app\.)?zohocreator\.[a-z]{2,3}(?:\.[a-z]{2})?$/;

/** The operands of a `+` chain, left to right. */
function concatParts(expr: Expr): Expr[] {
  if (expr.kind === 'paren') return concatParts(expr.expr);
  if (expr.kind === 'binary' && expr.op === '+') return [...concatParts(expr.left), ...concatParts(expr.right)];
  return [expr];
}

const isAppUri = (expr: Expr | undefined) => expr?.kind === 'member' && expr.object.kind === 'name' && expr.object.name === 'zoho' && expr.property === 'appuri';

function calleeFunctionName(expr: Expr): string | undefined {
  const parts: string[] = [];
  let curr: Expr | undefined = expr;
  while (curr) {
    if (curr.kind === 'name') {
      parts.unshift(curr.name);
      break;
    }
    if (curr.kind === 'member') {
      parts.unshift(curr.property);
      curr = curr.object;
    } else {
      return undefined;
    }
  }
  if (parts.length > 1 && parts[0]?.toLowerCase() === 'thisapp') {
    parts.shift();
  }
  return parts.length ? parts.join('.') : undefined;
}

/**
 * The client navigation a custom action's workflow stands for, or none. The
 * workflow (a Creator `type = functions` record workflow on the report's
 * form) must hold exactly one statement, `openUrl(url[, window[, features]])`
 * (or delegate to a function whose body is such an `openUrl`),
 * whose url is this app's own `#Form:` / `#Report:` / `#Page:` link, written
 * as literals and `input.<Field>` (or `input.<Lookup>.ID`) reads, optionally after the app's own
 * address (`zoho.appuri`). The target must be a form, report or page of the
 * app. A form link's query prefills the form: each value is a literal or one
 * field of the clicked row, and each name a field of the target form;
 * Creator's `zc_` display parameters are dropped. A report or page link
 * carries no query. Anything else (an external address, a computed target, a
 * second statement, an unknown field) is no navigation, and the action stays
 * turned off and counted.
 */
export function actionNavigation(app: App, report: Report, workflow: string | undefined): UiActionNav | undefined {
  const wanted = (workflow ?? '').trim();
  const fn = wanted ? app.functions.find((item) => item.kind === 'creator' && item.name === wanted) : undefined;
  if (!fn || !functionRowBinding(fn) || !fn.form || fn.form !== report.form) return undefined;
  let body;
  try {
    body = parseDeluge(fn.deluge.map((part) => part.text).join('\n')).body;
  } catch {
    return undefined;
  }
  const stmt = body.length === 1 ? body[0] : undefined;
  if (!stmt) return undefined;
  let openUrlStmt: Stmt | undefined;
  const argByParam = new Map<string, Expr>();
  if (stmt.kind === 'openUrl') {
    openUrlStmt = stmt;
  } else if (stmt.kind === 'expr' && stmt.expr.kind === 'call') {
    const calleeName = calleeFunctionName(stmt.expr.callee);
    if (!calleeName) return undefined;
    const calleeFn = app.functions.find((f) => f.name.toLowerCase() === calleeName.toLowerCase());
    if (!calleeFn) return undefined;
    let calleeBody: Stmt[];
    try {
      calleeBody = parseDeluge(calleeFn.deluge.map((p) => p.text).join('\n')).body;
    } catch {
      return undefined;
    }
    if (calleeBody.length !== 1 || calleeBody[0]?.kind !== 'openUrl') return undefined;
    openUrlStmt = calleeBody[0];
    const params = fnSignatureParams(calleeFn.signature);
    const callArgs = stmt.expr.args;
    for (let i = 0; i < params.length; i++) {
      if (callArgs[i]) argByParam.set(params[i]!.name.toLowerCase(), callArgs[i]!);
    }
  } else {
    return undefined;
  }

  if (!openUrlStmt.args.length || openUrlStmt.args.length > 3) return undefined;
  if (openUrlStmt.args.slice(1).some((arg) => arg.kind !== 'string')) return undefined;
  const rawParts = concatParts(openUrlStmt.args[0]!);
  const parts: Expr[] = [];
  for (const part of rawParts) {
    if (part.kind === 'name' && argByParam.has(part.name.toLowerCase())) {
      parts.push(argByParam.get(part.name.toLowerCase())!);
    } else {
      parts.push(part);
    }
  }
  if (parts[0]?.kind === 'string' && OWN_APP_HOST.test(parts[0].value) && isAppUri(parts[1])) parts.splice(0, 2);
  else if (isAppUri(parts[0])) parts.splice(0, 1);
  if (parts[0]?.kind === 'string' && /^\s*javascript:/i.test(parts[0].value)) return undefined;
  const source = app.forms.find((form) => form.name === fn.form);
  // The url as text with each row read as a numbered placeholder.
  const reads: string[] = [];
  let text = '';
  for (const part of parts) {
    if (part.kind === 'string') {
      if (part.value.includes('\u0000')) return undefined;
      text += part.value;
    } else if (part.kind === 'name' && (part.name === 'ID' || (source && formField(source, part.name)))) {
      text += `\u0000${reads.length}\u0000`;
      reads.push(part.name);
    } else if (part.kind === 'member' && part.object.kind === 'name' && part.object.name === 'input' && /^[A-Za-z_]\w*$/.test(part.property)) {
      text += `\u0000${reads.length}\u0000`;
      reads.push(part.property);
    } else if (part.kind === 'member' && part.property === 'ID' && part.object.kind === 'member' && part.object.object.kind === 'name' && part.object.object.name === 'input' && formField(source, part.object.property)?.lookup) {
      // `input.<Lookup>.ID` is the parent ROWID the lookup column stores.
      text += `\u0000${reads.length}\u0000`;
      reads.push(part.object.property);
    } else if (
      part.kind === 'member' &&
      /^[A-Za-z_]\w*$/.test(part.property) &&
      part.object.kind === 'member' &&
      part.object.object.kind === 'name' &&
      part.object.object.name === 'input' &&
      /^[A-Za-z_]\w*$/.test(part.object.property)
    ) {
      // `input.<Lookup>.<Field>` reads one field of the related record. The
      // head must be a lookup on the report's form and the leaf a stored
      // scalar column of the lookup target (no subfields: composites and
      // subforms are not single values). Anything deeper stays a todo.
      const lookupField = source ? formField(source, part.object.property) : undefined;
      const target = lookupField?.lookup ? app.forms.find((form) => form.name === lookupField.lookup!.form) : undefined;
      const leaf = target ? formField(target, part.property) : undefined;
      if (!lookupField?.lookup || !target || !leaf || leaf.subfields.length > 0) return undefined;
      text += `\u0000${reads.length}\u0000`;
      reads.push(`${part.object.property}.${part.property}`);
    } else return undefined;
  }
  const m = /^#(Form|Report|Page):([A-Za-z_]\w*)(?:\?(.*))?$/.exec(text);
  if (!m) return undefined;
  const kind = m[1]!.toLowerCase() as UiActionNav['kind'];
  const target = m[2]!;
  const targetForm = kind === 'form' ? app.forms.find((form) => form.name === target) : undefined;
  const targetPage = kind === 'page' ? app.pages.find((item) => item.name === target) : undefined;
  if (kind === 'form' ? !targetForm : kind === 'report' ? !app.reports.some((item) => item.name === target) : !app.pages.some((item) => item.name === target)) return undefined;
  const params: UiActionNav['params'] = [];
  for (const pair of (m[3] ?? '').split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const name = eq < 0 ? pair : pair.slice(0, eq);
    const raw = eq < 0 ? '' : pair.slice(eq + 1);
    if (/^zc_/i.test(name)) {
      if (raw.includes('\u0000')) return undefined;
      continue;
    }
    if (targetForm) {
      if (!formField(targetForm, name)) return undefined;
    } else if (targetPage) {
      if (!(targetPage.params ?? []).includes(name)) return undefined;
    } else return undefined;
    const read = /^\u0000(\d+)\u0000$/.exec(raw);
    if (read) {
      const field = reads[Number(read[1])]!;
      if (field === 'ID') params.push({ name, field: 'ROWID' });
      else if (field.includes('.')) {
        // A one-level lookup read travels under its dotted row key; the
        // server attaches it (or leaves it off when the caller may not
        // read it) and the client sends only a value the row holds.
        const dot = field.indexOf('.');
        const lookupName = field.slice(0, dot);
        const leafName = field.slice(dot + 1);
        const lookupField = source ? formField(source, lookupName) : undefined;
        const target = lookupField?.lookup ? app.forms.find((form) => form.name === lookupField.lookup!.form) : undefined;
        if (!lookupField?.lookup || !target || !formField(target, leafName)) return undefined;
        params.push({ name, field });
      } else if (source && formField(source, field)) params.push({ name, field });
      else return undefined;
    } else if (raw.includes('\u0000')) return undefined;
    else params.push({ name, value: raw });
  }
  return { kind, target, href: `#/${kind}/${encodeURIComponent(target)}`, params };
}

export function buildModel(app: App, delugeFiles: readonly GeneratedFile[] = []): UiModel {
  const todos: UiTodo[] = [];
  const forms = app.forms.map((form) => buildForm(form, todos, app));
  const reports = app.reports.map((report) => buildReport(app, report, todos, delugeFiles));
  const snippetFiles: HtmlpageFile[] = [];
  const componentViews = {
    forms: new Set(forms.filter((form) => formStatus(form) === 'generated').map((form) => form.name)),
    reports: new Set(reports.filter((report) => report.status === 'generated').map((report) => report.name)),
  };
  const pages = app.pages.map((page) => {
    const env: ZmlEnv = { app, page: page.name, emit: (file) => snippetFiles.push(file), seq: { n: 0 }, components: componentViews };
    return buildPage(page, todos, env);
  });
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
    // An `on add` success module owns add posts only: an edit post goes to the
    // plain submit handler, which runs the `on edit` validates, not that script.
    else if (addSuccess && !editSuccess) form.editSubmitEndpoint = plainSubmitEndpoint(form.name);
  }
  const dateFormat = app.settings.find((item) => item.key.toLowerCase() === 'date format');
  const timeFormat = app.settings.find((item) => item.key.toLowerCase() === 'time format');
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
    ...(timeFormat ? { timeFormat: unquote(timeFormat.value) } : {}),
  };
  Object.defineProperty(model, UI_SNIPPET_FILES, { value: snippetFiles, enumerable: false });
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
const DECORATION_HELPER = new Set(['displayRefs', 'displayTerms', 'displayChoice', 'lookupFormats', 'lookupSorts', 'sortDirOf', 'reportFieldLabel']);

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

/** The generated submit handler a form posts to when no success module owns the write. */
function plainSubmitEndpoint(form: string): string {
  return `/forms/${encodeURIComponent(form)}/submit`;
}

function buildForm(form: Form, todos: UiTodo[], app: App): UiForm {
  const raw = form.properties.find((p) => p.key.toLowerCase() === 'success message')?.value;
  const success = raw?.replace(/^"([\s\S]*)"$/, '$1');
  return {
    name: form.name,
    label: form.displayName || form.name,
    ...(form.section ? { section: form.section } : {}),
    fields: form.fields.map((field) => buildField(field, todos, form.name, 0, app)),
    submitEndpoint: plainSubmitEndpoint(form.name),
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
  if ((widget === 'select' || widget === 'radio') && hasOthersOption(field)) ui.othersOption = true;
  for (const key of PRIVACY_PROPERTY_KEYS) {
    const value = prop(field, key);
    if (value?.trim().toLowerCase() !== 'true') continue;
    const name = `${formName}.${field.name} property ${key}`;
    if (todos.some((t) => t.area === 'field' && t.name === name)) continue;
    todos.push({
      area: 'field',
      name,
      reason: `Field ${field.name} is flagged \`${key} = true\`; Catalyst generates no privacy or access control for this field.`,
      manualStep: `In the Catalyst console, apply the data-privacy protection ${field.name} needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.`,
    });
  }
  if (widget === 'address') {
    const captureCoordinates = prop(field, 'capture_coordinates');
    if (captureCoordinates?.trim().toLowerCase() === 'true') {
      const name = `${formName}.${field.name} property capture_coordinates`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} is flagged \`capture_coordinates = true\`; the generated address field has no device-location pin or stored latitude/longitude.`,
          manualStep: `In the Catalyst console, capture and store the device's GPS coordinates for ${field.name} by hand (geolocation lookup plus latitude/longitude columns) — this is not generated.`,
        });
      }
    }
  }
  if (widget === 'image') {
    const target = prop(field, 'target');
    if (target !== undefined) {
      const name = `${formName}.${field.name} property target`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} sets \`target = ${target}\`; the generated image field has no clickable link, so there is no window to open it in.`,
          manualStep: `Make the image open ${target} when clicked, per your policy — this is not generated.`,
        });
      }
    }
    const annotation = prop(field, IMAGE_ANNOTATION_PROPERTY_KEY);
    if (annotation?.trim().toLowerCase() === 'true') {
      const name = `${formName}.${field.name} property ${IMAGE_ANNOTATION_PROPERTY_KEY}`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} is flagged \`annotation = true\`; the generated image field has no drawing or markup tool.`,
          manualStep: `Add a drawing/markup tool for ${field.name}'s capture dialog by hand, or accept the plain photo, per your policy — this is not generated.`,
        });
      }
    }
  }
  if (ui.scan) {
    const manualInput = prop(field, SCAN_MANUAL_INPUT_PROPERTY_KEY);
    if (manualInput !== undefined) {
      const name = `${formName}.${field.name} property ${SCAN_MANUAL_INPUT_PROPERTY_KEY}`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} sets \`manual input = ${manualInput}\`; the generated scan field has no free-text fallback next to the camera.`,
          manualStep: `Add a manual text entry alongside the generated scan control, or leave the field scan-only, per your policy — this is not generated.`,
        });
      }
    }
  }
  if (widget === 'video') {
    const duration = prop(field, VIDEO_DURATION_PROPERTY_KEY);
    if (duration !== undefined) {
      const name = `${formName}.${field.name} property ${VIDEO_DURATION_PROPERTY_KEY}`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} sets \`duration = ${duration}\`; the generated video field hands recording off to the device camera app with no recording-length limit.`,
          manualStep: `Enforce the ${duration}-second recording limit by hand (client-side timer, or server-side rejection of longer uploads), or accept recordings of any length, per your policy — this is not generated.`,
        });
      }
    }
  }
  if (ui.scan || widget === 'image') {
    const showOnload = prop(field, SHOW_ONLOAD_PROPERTY_KEY);
    if (showOnload?.trim().toLowerCase() === 'true') {
      const name = `${formName}.${field.name} property ${SHOW_ONLOAD_PROPERTY_KEY}`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} sets \`show onload = true\`; the generated ${ui.scan ? 'scan' : 'image'} field opens its ${ui.scan ? 'scanner' : 'camera'} only when the user taps the control, never automatically when the form loads.`,
          manualStep: `In the Catalyst console, trigger the ${ui.scan ? 'scanner' : 'camera'} for ${field.name} automatically as the form loads, by hand — this is not generated.`,
        });
      }
    }
  }
  const biProp = field.properties.find((item) => item.key.trim().toLowerCase() === 'bidirectional');
  if (biProp && app) {
    const target = field.lookup?.form;
    const back = unquote(biProp.value).trim();
    const eligible = !!target && !!back && bidirectionalReverseEligible(field, formName, app, target, back);
    if (!eligible) {
      const name = `${formName}.${field.name} property ${biProp.key}`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} is flagged \`bidirectional = ${back || biProp.value}\`; Catalyst only creates the reverse column from a linked grid side, and neither ${field.name} nor ${target ? `${target}.${back || biProp.value}` : 'its target'} is one.`,
          manualStep: `In the Catalyst console, if the two records should look each other up, add a grid field on one side pointing back at the other, or wire the lookup by hand — this reverse reference is not generated.`,
        });
      }
    }
  }
  if (widget === 'date' || widget === 'datetime') {
    const allowedDays = prop(field, 'alloweddays');
    if (allowedDays !== undefined && !isEveryWeekday(allowedDays)) {
      const name = `${formName}.${field.name} property alloweddays`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} restricts selectable weekdays to \`${allowedDays}\`; the generated ${widget} input is a plain native control with no weekday restriction.`,
          manualStep: `Add validation (client-side and server-side) so ${field.name} only accepts the Creator-allowed days (\`${allowedDays}\`) — the generated input currently accepts every day of the week.`,
        });
      }
    }
  }
  if (field.lookup && (widget === 'lookup' || widget === 'lookup-multi')) {
    ui.lookup = {
      form: field.lookup.form,
      ...(field.lookup.field ? { field: field.lookup.field } : {}),
      endpoint: `/lookups/${encodeURIComponent(field.lookup.form)}/${encodeURIComponent(field.lookup.field || field.lookup.form)}`,
    };
    // `allow new entries` lets the picker offer the parent form's add screen
    // inline; the `displayname` annotation is that dialog's title.
    if (field.flags.some((flag) => flag.trim().toLowerCase() === 'allow new entries')) {
      const label = addNewLabel(field);
      ui.lookup.addNew = label !== undefined ? { label } : {};
    }
    // `searchable = false` asks the picker's option list to not be searchable.
    // The generated `/lookups/:form/:field` endpoint always accepts `?q=`, so
    // the picker stays searchable regardless; this is not generated.
    const searchable = prop(field, 'searchable');
    if (searchable?.trim().toLowerCase() === 'false') {
      const name = `${formName}.${field.name} property searchable`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} sets \`searchable = false\`; the generated lookup's search endpoint accepts \`?q=\` regardless.`,
          manualStep: `Hide or disable the search box in the lookup picker for ${field.name} by hand, or leave it searchable, per your policy — this is not generated.`,
        });
      }
    }
  }
  // Creator's Users module is a project-user picker.  Catalyst exposes the
  // same records through the system Users lookup endpoint; keep the submitted
  // value as the user ROWID while showing the declared display attribute.
  if (widget === 'users') {
    const display = prop(field, 'displayformat')?.match(/[A-Za-z_][A-Za-z0-9_]*/)?.[0] ?? 'username';
    ui.lookup = {
      form: 'users',
      field: display,
      endpoint: `/lookups/users/${encodeURIComponent(display)}`,
    };
  }
  const max = intProp(field, ['maxchar', 'max char', 'max length']);
  const min = intProp(field, ['minchar', 'min char', 'min length']);
  if (min) ui.minLength = min;
  if (widget === 'text' || widget === 'email' || widget === 'phone') ui.maxLength = max ?? 255;
  else if (widget === 'textarea' || widget === 'richtext') ui.maxLength = max ?? 10_000;
  else if (widget === 'url') ui.maxLength = max;
  else if (max) ui.maxLength = max;
  if (widget === 'url' && wantsLinkName(field)) ui.linkName = true;
  const pattern = patternOf(field);
  if (pattern.bad) {
    ui.todo = 'Field regex did not compile; the pattern was not copied.';
    todos.push({ area: 'field', name: `${formName}.${field.name}`, reason: ui.todo });
  } else if (pattern.value) ui.pattern = pattern.value;
  if (field.initialValue) {
    // A multi select prefills the stored shape (["No"]), never Deluge list source ({"No"}).
    const initial = widget === 'multiselect' ? multiValueDefault(field.initialValue) : unquote(field.initialValue);
    if (initial !== undefined) ui.initialValue = initial;
  }
  if (FILE_WIDGETS.has(widget)) {
    ui.uploadEndpoint = `/uploads/${encodeURIComponent(formName)}/${encodeURIComponent(field.name)}`;
    const sources = widget !== 'signature' ? field.properties.find((p) => p.key.trim().toLowerCase() === 'source') : undefined;
    if (sources) {
      const tokens = unquote(sources.value).split(',').map((token) => token.trim().toLowerCase()).filter(Boolean);
      if (tokens.length) ui.uploadSources = tokens;
    }
    const browseProp = widget === 'file' ? field.properties.find((p) => p.key.trim().toLowerCase() === 'browse') : undefined;
    if (browseProp && depth === 0) {
      const tokens = unquote(browseProp.value).split(',').map((token) => token.trim().toLowerCase()).filter(Boolean);
      const uncarried = tokens.filter((t) => t !== 'local_drive');
      if (uncarried.length && uncarried.every((t) => BROWSE_REMOTE_SOURCES.has(t))) {
        const name = `${formName}.${field.name} property browse`;
        if (!todos.some((t) => t.area === 'field' && t.name === name)) {
          todos.push({
            area: 'field',
            name,
            reason: `Browse option(s) ${uncarried.join(', ')} have no Catalyst equivalent; file uploads are supported from local drive only.`,
            manualStep: `In Catalyst, remote file browsing (${uncarried.join(', ')}) is not supported out of the box. Configure third-party integrations (e.g. Google Drive, Zoho WorkDrive) or Catalyst Cloud Scale functions to attach remote documents, or rely on local device uploads.`,
          });
        }
      }
    }
    ui.accept = widget === 'image' || widget === 'signature' ? 'image/*' : widget === 'audio' ? 'audio/*' : widget === 'video' ? 'video/*' : undefined;
    ui.note =
      widget === 'signature'
        ? 'A signature pad uploads the drawn strokes as JSON. The dry-run function does not write to Stratus.'
        : 'The column stores a Stratus object key. The dry-run upload does not write bytes.';
  }
  if (widget === 'image') {
    const enableProp = prop(field, 'enable');
    if (enableProp !== undefined) {
      const tokens = enableProp.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean);
      if (tokens.includes('link') || tokens.includes('title')) {
        const name = `${formName}.${field.name} property enable`;
        if (!todos.some((t) => t.area === 'field' && t.name === name)) {
          todos.push({
            area: 'field',
            name,
            reason: `Field ${field.name} is flagged \`enable = ${enableProp}\`; the generated image field collects no link name or title alongside the upload, and the shown image is not a clickable link.`,
            manualStep: `Add a link-name/title input alongside ${field.name}'s image upload and make the displayed image open that link — this is not generated.`,
          });
        }
      }
    }
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
  if (widget === 'address') {
    const adjustUsingMap = prop(field, 'adjust_using_map');
    if (adjustUsingMap !== undefined && adjustUsingMap.trim().toLowerCase() === 'true') {
      const name = `${formName}.${field.name} property adjust_using_map`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} is flagged \`adjust_using_map = true\`; the generated address field is plain text inputs and shows no map to adjust the pin on.`,
          manualStep: `Add a map component so ${field.name} lets the user drag the pin to refine the address — the generated field has no map.`,
        });
      }
    }
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
    const autoWidth = prop(field, 'auto width');
    if (autoWidth !== undefined && autoWidth.trim().toLowerCase() === 'false') {
      const name = `${formName}.${field.name} property auto width`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} sets \`auto width = false\`; the generated subform grid has no fixed-column-width control, so its columns always size themselves.`,
          manualStep: `Give ${field.name}'s generated grid explicit column widths (CSS or a table layout) so columns stay fixed instead of auto-sizing — the generated grid currently has no width control for this.`,
        });
      }
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
  if (prop(field, 'toolbar') !== undefined) {
    const reason = 'Toolbar setting is not carried; the generated editor has no toolbar control.';
    ui.note = [ui.note, reason].filter(Boolean).join(' ');
    todos.push({ area: 'field', name: `${formName}.${field.name}`, reason });
  }
  if (prop(field, 'defaultrow') !== undefined) {
    const reason = 'Default row count is not carried; the generated subform starts with no pre-filled rows.';
    ui.note = [ui.note, reason].filter(Boolean).join(' ');
    todos.push({ area: 'field', name: `${formName}.${field.name}`, reason });
  }
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

/** `enable linkname` on a URL field: Creator stores both the URL and a link title. */
function wantsLinkName(field: Field): boolean {
  return field.flags.some((flag) => /^enable\s+linkname$/i.test(flag.trim()));
}

function prop(field: Field, key: string): string | undefined {
  const found = field.properties.find((p) => p.key.toLowerCase() === key);
  return found ? unquote(found.value) : undefined;
}

/**
 * The `allow new entries` dialog title: the untyped `displayname` annotation
 * a lookup carries next to the flag (`allow new entries [ displayname = "Add
 * New X" ]`). Typed annotations (help_text, tooltip) are not the dialog title.
 */
function addNewLabel(field: Field): string | undefined {
  for (const block of field.annotations) {
    if (block.properties.some((p) => p.key.toLowerCase() === 'type')) continue;
    const found = block.properties.find((p) => p.key.toLowerCase() === 'displayname');
    if (found !== undefined) return unquote(found.value);
  }
  return undefined;
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

function buildReport(app: App, report: Report, todos: UiTodo[], delugeFiles: readonly GeneratedFile[]): UiReport {
  const type = report.type.toLowerCase();
  let view = REPORT_VIEW[type] ?? 'todo';
  const form = report.form ? app.forms.find((item) => item.name === report.form) : undefined;
  const columns = report.columns.flatMap((column) => reportViewColumns(app, form, column));
  const groupBy = report.groupBy.map((item) => ({ field: item.field }));
  let status: 'generated' | 'todo' = view === 'todo' ? 'todo' : 'generated';
  let todo: string | undefined;
  const options = reportOptions(report);
  // Only `options` has a model home (reportOptions above, optionProved in the
  // quality audit). Any other named settings block the Creator export
  // carries — e.g. a native `filters`, `sorting` or `grouping` block, or one
  // of Creator's other per-report settings groups — has none, so it is
  // recorded as a manual step rather than silently discarded.
  for (const block of report.blocks) {
    if (block.name.trim().toLowerCase() === 'options') continue;
    const settings = block.properties.map((property) => `${property.key.trim()} = ${unquote(property.value).trim()}`).join(', ') || '(no properties)';
    todos.push({
      area: 'report',
      name: `${report.name} block ${block.name}`,
      reason: `Report ${report.name} has a \`${block.name}\` settings block (${settings}) that Catalyst generates no equivalent for.`,
      manualStep: `In the Catalyst console, apply the \`${block.name}\` settings by hand on report ${report.name}: ${settings}.`,
    });
  }
  const displayField = options.get('display field');
  const pageSize = reportPageSizeOption(options.get('display rows')) ?? LIMITS.zcqlRowsPerQuery;
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
    note = `Shown as a list: ${report.name} has no exported pivot shelves; rebuild it on this report using one row field, one column field, and a count or sum measure from ${report.form || 'the report form'} (${columns.map((column) => column.field).join(', ') || 'no exported columns'}).`;
  }
  if (view === 'todo') todo = `Report type ${report.type || '(none)'} is not generated.`;
  // A criteria that did not translate must not widen the report to all rows.
  // The generated endpoint fails closed (zero rows, "filter not migrated"),
  // and the report renders this notice instead of a table. The compiled
  // predicate is stored on the model so a later audit can see that this
  // report's criteria was actually emitted.
  let compiledCriteria: Criteria | undefined;
  if (report.criteria?.trim()) {
    const parsed = reportCriteria(report.criteria, app.functions);
    compiledCriteria = criteriaHasTodo(parsed) ? { op: 'todo', construct: 'report-criteria' } : parsed;
  }
  if (compiledCriteria?.op === 'todo') {
    status = 'todo';
    todo = [todo, `Filter not migrated on report ${report.name}: manually translate the source criterion for ${report.form || 'the report form'} in the new app; until then this report returns no rows.`].filter(Boolean).join(' ');
    // zoho.adminuserid is the application owner's email; the generated app
    // is not configured with one, so the comparison is left to the developer.
    if (report.criteria && /\bzoho\.adminuserid\b/i.test(report.criteria)) {
      todo += ' It compares with zoho.adminuserid (the application owner email), which the migrated app does not know: replace it with the owner address, or with zoho.loginuserid if the report is meant for the signed-in user.';
    }
    if (report.criteria) todo += criteriaReadGuidance(report.criteria);
  }
  for (const filter of report.filters) {
    if (filter.criteria?.trim() && criteriaHasTodo(reportCriteria(filter.criteria, app.functions))) {
      todos.push({ area: 'report', name: report.name, reason: `Named filter "${filter.label ?? ''}" on report ${report.name} is not migrated: manually translate its source criterion for ${report.form || 'the report form'} in the new app; selecting it returns no rows.` });
    }
  }
  if (todo) todos.push({ area: 'report', name: report.name, reason: todo });
  // An action whose workflow generated no function has an endpoint that runs
  // nothing (see actionStub in generate.ts): a button that reported success
  // would claim a workflow ran when nothing was saved, so it is turned off and
  // counted. A dispatchable action runs through the thisapp registry. An
  // action whose workflow is only an openUrl to this app's own screen is a
  // client navigation instead (actionNavigation): no endpoint runs.
  const actions: UiAction[] = report.customActions.map((action) => {
    const nav = actionNavigation(app, report, action.workflow);
    const dispatch = !nav && actionDispatchTarget(app, action.workflow, delugeFiles);
    return {
      name: action.name,
      ...(action.workflow ? { workflow: action.workflow } : {}),
      endpoint: `/reports/${encodeURIComponent(report.name)}/actions/${slug(action.name)}`,
      ...(reportProp(action.properties, 'show action in view header') === 'true' ? { header: true as const } : {}),
      ...(nav ? { navigate: nav } : dispatch ? {} : { preview: true as const }),
    };
  });
  for (const action of actions) {
    if (!action.preview) continue;
    // Keep unsupported actions visible in the migration report with the same
    // typed reason used by server-snippet guidance.  This is deliberately
    // conservative: until the workflow is proven to be a generated function
    // or a safe own-app navigation, its semantics are untranslated.
    todos.push({ area: 'report', name: report.name, reason: `Custom action "${action.name.trim()}" is not migrated; its button is turned off.`, manualReasons: ['untranslated'] });
  }
  const builtColumns: UiReport['columns'] = columns.map((column) => ({
    ...column,
    ...lookupOf(form, column.field),
    ...(numericColumn(form, column.field) ? { numeric: true as const } : {}),
    // A multi select or checkboxes cell is stored list text: the report shows its choices.
    ...(multiValueColumn(form, column.field) ? { multiValue: true as const } : {}),
    // A date or date-time cell shows in the app date format and clock, not as stored ISO.
    ...dateColumn(form, column.field),
  }));
  // A custom action with `column header` renders as a record column, not a
  // toolbar button. The cell's button posts to the action endpoint.
  report.customActions.forEach((action, index) => {
    const head = reportProp(action.properties, 'column header');
    if (head === undefined || builtColumns.some((column) => column.field === action.name)) return;
    builtColumns.push({ field: action.name, label: head || action.name, action: actions[index].endpoint });
  });
  const formats = conditionalFormats(app, report);
  // `display records per row` is a list density: carried only by a generated
  // report that draws the rows table (boards and charts never read it).
  const recordsPerRow = status === 'generated' && DENSITY_VIEWS.has(view) ? recordsPerRowOption(options.get('display records per row')) : undefined;
  // The card label column exists only when records draw as cards.
  const labelWidth = recordsPerRow !== undefined ? labelWidthOption(options.get('label width')) : undefined;
  // `record count` is a header toggle on the same rows table as the density
  // options above: carried only when the report actually draws that table.
  const showRecordCount = status === 'generated' && DENSITY_VIEWS.has(view) && options.get('record count')?.toLowerCase() === 'enable';
  // An `options` property this view never reads (a map's marker `display
  // field`, a calendar's `display type`, a timeline's `week start day`, a
  // kanban's `sort order` or `record count`, ...) has no generated home —
  // mirrors optionProved in the quality audit. Recorded as a manual step so
  // it is counted, not silently dropped.
  if (status === 'generated' && options.size) {
    const proved = (key: string, value: string): boolean => {
      if (key === 'display field') return value === groupField || value === titleField;
      if (key === 'start date') return value === startField;
      if (key === 'end date') return value === endField;
      if (key === 'display rows') return pageSize === reportPageSizeOption(value);
      if (key === 'display records per row') return recordsPerRow === recordsPerRowOption(value);
      if (key === 'label width') return labelWidth !== undefined && labelWidth === labelWidthOption(value);
      if (key === 'record count') return (value.toLowerCase() === 'enable') === (showRecordCount === true);
      return false;
    };
    const unproven = [...options].filter(([key, value]) => !proved(key, value));
    if (unproven.length) {
      const settings = unproven.map(([key, value]) => `${key} = ${value}`).join(', ');
      todos.push({
        area: 'report',
        name: `${report.name} block options`,
        reason: `Report ${report.name} has an \`options\` setting (${settings}) that Catalyst does not carry into the generated ${view} report.`,
        manualStep: `In the Catalyst console, apply the \`options\` setting by hand on report ${report.name}: ${settings}.`,
      });
    }
  }
  return {
    name: report.name,
    label: report.displayName || report.name,
    type: report.type,
    view: status === 'todo' ? 'todo' : view,
    ...(report.form ? { form: report.form } : {}),
    status,
    ...(todo ? { todo } : {}),
    ...(status === 'generated' && note ? { note } : {}),
    ...(compiledCriteria ? { criteria: compiledCriteria } : {}),
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
    pageSize,
    ...(recordsPerRow !== undefined ? { recordsPerRow } : {}),
    ...(labelWidth ? { labelWidth } : {}),
    ...(showRecordCount ? { showRecordCount: true } : {}),
    queryEndpoint: `/reports/${encodeURIComponent(report.name)}`,
    ...(form ? { recordEndpoint: `/forms/${encodeURIComponent(form.name)}/record` } : {}),
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
function conditionalFormats(app: App, report: Report): NonNullable<UiReport['conditionalFormats']> {
  return report.conditionalFormats.map((format) => ({
    name: format.name,
    fields: formatFieldList(format.fields),
    criteria: sealRelativeCriteria(reportCriteria(format.condition || 'true', app.functions)),
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

/** `display rows = N` in a report `options` block: the Creator page size, carried as `UiReport.pageSize` (never above the ZCQL page cap). */
export function reportPageSizeOption(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n >= 1 && n <= LIMITS.zcqlRowsPerQuery ? n : undefined;
}

/** Views that draw the report rows table; `display records per row` is carried only for these. */
const DENSITY_VIEWS = new Set<UiReport['view']>(['list', 'summary', 'spreadsheet', 'map', 'pivot', 'detail']);

/** `display records per row = N`: record cards drawn N per list row. Creator offers 1-6; anything else is not carried. */
export function recordsPerRowOption(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n >= 1 && n <= 6 ? n : undefined;
}

/** `label width = 20%`: a CSS width for the record-card label column; only a plain CSS length carries. */
export function labelWidthOption(value: string | undefined): string | undefined {
  const v = (value ?? '').trim();
  return /^\d+(?:\.\d+)?(?:%|px|em|rem)$/.test(v) ? v : undefined;
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

/** Record columns every form table stores; a report may list them without declaring them. */
const RECORD_COLUMNS = new Set([
  'ID',
  'ROWID',
  'Added_User',
  'Added_Time',
  'Modified_User',
  'Modified_Time',
  'Added_User_IP_Address',
  'Modified_User_IP_Address',
]);

/**
 * A report column resolves when its head names a field of the report's form
 * or a stored record column. When the report names no form the column list
 * is kept as declared — there is no form to verify it against.
 */
function knownColumnHead(form: Form | undefined, fieldName: string): boolean {
  if (!form) return true;
  const head = fieldName.slice(0, fieldName.indexOf('.') > 0 ? fieldName.indexOf('.') : undefined);
  return !!formField(form, head) || RECORD_COLUMNS.has(head);
}

/** Stored part names of a composite field: declared subfields, else the type's default parts. */
function compositePartNames(field: Field): string[] {
  const prefix = `${field.name}_`;
  return derivedFieldColumns(field)
    .filter((name) => name.startsWith(prefix) && !name.endsWith('__n'))
    .map((name) => name.slice(prefix.length));
}

interface ReportViewColumn {
  field: string;
  label: string;
  lookup?: { form: string; field: string; source?: string };
}

/**
 * One declared report column as generated view columns: the column itself,
 * then each part it lists as `<Parent>.<part>`. A composite part renders the
 * stored part cell; a lookup part resolves the related field through the
 * caller's own read access on the parent form (an unreadable parent shows
 * empty, never a ROWID). A column — or part — naming nothing the form stores
 * stays a silent drop: the view fails closed instead of claiming a column it
 * cannot fill.
 */
function reportViewColumns(app: App, form: Form | undefined, column: Report['columns'][number], path = column.field): ReportViewColumn[] {
  if (!knownColumnHead(form, path)) return [];
  const out: ReportViewColumn[] = [
    {
      field: path,
      label: formField(form, column.field)?.displayName || column.label || path,
    },
  ];
  const parentField = path === column.field && !column.field.includes('.') ? formField(form, column.field) : undefined;
  const composite = parentField && resolveRow(parentField)?.kind === 'composite' ? new Set(compositePartNames(parentField)) : undefined;
  const parentForm = parentField?.lookup?.form ? app.forms.find((item) => item.name === parentField.lookup?.form) : undefined;
  for (const sub of column.subcolumns) {
    if (composite?.has(sub.field)) {
      out.push(...reportViewColumns(app, form, sub, `${path}.${sub.field}`));
      continue;
    }
    if (parentForm && (formField(parentForm, sub.field) || RECORD_COLUMNS.has(sub.field))) {
      out.push({
        field: `${path}.${sub.field}`,
        label: sub.label || formField(parentForm, sub.field)?.displayName || sub.field,
        lookup: { form: parentForm.name, field: sub.field, source: path },
      });
    }
    // Any other subcolumn names a part the parent does not have: dropped.
  }
  return out;
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

function dateColumn(form: Form | undefined, fieldName: string): { date: 'date' | 'datetime' } | Record<string, never> {
  const field = formField(form, fieldName);
  const id = field ? resolveRow(field)?.id : undefined;
  return id === 'date' ? { date: 'date' } : id === 'date-time' ? { date: 'datetime' } : {};
}

function multiValueColumn(form: Form | undefined, fieldName: string): boolean {
  const field = formField(form, fieldName);
  return !!field && isMultiChoiceField(field);
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

function buildPage(page: App['pages'][number], todos: UiTodo[], env?: ZmlEnv): UiPage {
  const elements = page.zml.length
    ? elementsFromZml(page.zml, env)
    : page.content?.trim()
      ? [{ tag: 'text', kind: 'text' as const, text: page.content, children: [] }]
      : [];
  const pageLeaves = leaves(elements);
  const todoLeaves = pageLeaves.filter((el) => el.kind === 'todo');
  // Dropped `<style>` CSS is one counted manual step per page; the count stays off the generated element.
  let styleRules = 0;
  const styleDrops: string[] = [];
  let hadStaticStyle = false;
  const styles: string[] = [];
  const cssEscape = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch.codePointAt(0)!.toString(16)} `);
  for (const el of pageLeaves) {
    if (el.staticCss) {
      hadStaticStyle = true;
      const carried = carriedStyleRules(el.staticCss, `[data-page="${cssEscape(page.name)}"]`);
      if (carried.css) styles.push(carried.css);
      styleRules += carried.droppedRules;
      styleDrops.push(...carried.dropped);
    } else styleRules += el.droppedStyleRules ?? 0;
    delete el.droppedStyleRules;
    delete el.staticCss;
  }
  for (const el of todoLeaves) {
    todos.push({
      area: 'zml',
      name: `${page.name}.${el.tag}`,
      reason: el.todo || `ZML <${el.tag}> has no generated component`,
      ...(el.siteId ? { siteId: el.siteId } : {}),
      ...(el.manualReasons ? { manualReasons: el.manualReasons } : {}),
      ...(el.manualStep ? { manualStep: el.manualStep } : {}),
    });
  }
  for (const el of pageLeaves) {
    if (el.droppedParameters) {
      todos.push({
        area: 'zml',
        name: `${page.name}.${el.name ?? el.tag}`,
        reason: `ZML <${el.tag}> "${el.name ?? el.tag}" click parameters "${el.droppedParameters}" are not generated; wire them to the click handler by hand`,
      });
      delete el.droppedParameters;
    }
    if (el.droppedCriteria) {
      const what = el.tag.toLowerCase() === 'search' ? 'search' : 'report';
      todos.push({
        area: 'zml',
        name: `${page.name}.${el.name ?? el.tag}`,
        reason: `ZML <${el.tag}> "${el.name ?? el.tag}" criteria "${el.droppedCriteria}" is not generated; wire the ${what} filter by hand`,
      });
      delete el.droppedCriteria;
    }
  }
  const seenDroppedTags = new Set<string>();
  for (const el of pageLeaves) {
    if (el.kind === 'html') {
      for (const tag of el.droppedTags ?? []) {
        if (tag === 'style' && hadStaticStyle) continue;
        const key = `${el.tag}|${tag}`;
        if (seenDroppedTags.has(key)) continue;
        seenDroppedTags.add(key);
        todos.push({ area: 'zml', name: `${page.name}.${el.tag}`, reason: droppedTagReason(tag) });
      }
    }
    const dropped = el.kind === 'html' && el.html ? droppedStyles(el.html, true) : [];
    if (dropped.length) todos.push({ area: 'zml', name: `${page.name}.${el.tag}`, reason: droppedStyleReason(dropped) });
  }
  if (styleRules) {
    const lost = droppedStyleRulesTodo(page.name, styleRules, styleDrops);
    todos.push({ area: 'zml', name: `${page.name}.style`, reason: lost.reason, manualReasons: ['sanitizer-loss'], manualStep: lost.step });
  }
  const status = pageLeaves.length > 0 && todoLeaves.length === pageLeaves.length ? 'todo' : todoLeaves.length > 0 ? 'partial' : 'generated';
  return {
    name: page.name,
    label: page.displayName || page.name,
    ...(page.section ? { section: page.section } : {}),
    status,
    elements,
    ...(styles.length ? { scopedCss: styles.join('\n') } : {}),
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

export interface HandlerMeta {
  form: string | null;
  event: string | null;
  when: string | null;
  prefetch: string | null;
  recordEvent: string | null;
}

function handlersFrom(files: readonly GeneratedFile[]): UiHandler[] {
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
    const input = eventField(meta.event ?? '');
    handlers.push({
      form: meta.form,
      event: meta.event ?? meta.when,
      when: meta.when,
      ...(input ? { field: input } : {}),
      ...(meta.recordEvent ? { recordEvent: meta.recordEvent } : {}),
      module: `@@asset:${browser}@@`,
      ...(endpoints.has(endpoint) ? { endpoint } : {}),
      ...(meta.prefetch ? { prefetch: meta.prefetch } : {}),
    });
  }
  return handlers;
}

const LINE_TERMINATORS = '\n\r\u2028\u2029';

/**
 * The field a `user input of <field>` / `update of <field>` event names: the
 * text after the earliest such phrase that is followed by whitespace and then
 * runs to the end on one line (whitespace between the phrase and that last
 * line may span lines), trimmed. Every candidate phrase is checked in constant
 * time against precomputed bounds, so the scan is linear in the event text.
 */
export function eventField(event: string): string | undefined {
  let tailStart = 0;
  for (let at = event.length - 1; at >= 0; at--) {
    if (LINE_TERMINATORS.includes(event[at])) {
      tailStart = at + 1;
      break;
    }
  }
  let blankFrom = tailStart;
  while (blankFrom > 0 && /\s/.test(event[blankFrom - 1])) blankFrom--;
  for (let at = 0; at < event.length; at++) {
    const phrase = ['user input of', 'update of'].find((item) => event.slice(at, at + item.length).toLowerCase() === item);
    if (!phrase) continue;
    const end = at + phrase.length;
    if (end >= event.length || !/\s/.test(event[end]) || (end < tailStart && end < blankFrom)) continue;
    return event.slice(end).trim() || undefined;
  }
  return undefined;
}

const HANDLER_META_PREFIX = 'export const c2cHandler = {';

/**
 * The `c2cHandler` metadata object of a generated handler module: from the
 * first `export const c2cHandler = {` to the first `};` after it, located
 * with indexOf so the scan stays linear in the module source.
 */
export function readMeta(source: string): HandlerMeta | undefined {
  const start = source.indexOf(HANDLER_META_PREFIX);
  if (start < 0) return undefined;
  const open = start + HANDLER_META_PREFIX.length - 1;
  const end = source.indexOf('};', open + 1);
  if (end < 0) return undefined;
  try {
    return JSON.parse(source.slice(open, end + 1)) as HandlerMeta;
  } catch {
    return undefined;
  }
}

export function slug(value: string): string {
  const dashed = value.replace(/[^A-Za-z0-9]+/g, '-');
  let start = 0;
  let end = dashed.length;
  while (start < end && dashed[start] === '-') start++;
  while (end > start && dashed[end - 1] === '-') end--;
  return dashed.slice(start, end).toLowerCase() || 'item';
}

export function formStatus(form: UiForm): 'generated' | 'todo' {
  const fields = flatFields(form.fields);
  if (!fields.length) return 'generated';
  return fields.every((field) => field.status === 'todo') ? 'todo' : 'generated';
}

/**
 * Manual step for criteria leaves the report read never evaluates: a
 * `thisapp.<fn>()` call and a field read from another form (`Form[...].Field`).
 * Each is named once, in source order, so the developer knows which leaf to
 * rewrite. Empty when the criteria holds neither.
 */
function criteriaReadGuidance(src: string): string {
  const calls: string[] = [];
  const fetches: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const expr = node as Expr;
    if (expr.kind === 'call' && expr.callee.kind === 'member') {
      const path: string[] = [expr.callee.property];
      let head: Expr = expr.callee.object;
      while (head.kind === 'member') {
        path.unshift(head.property);
        head = head.object;
      }
      const name = path.join('.');
      if (head.kind === 'name' && head.name === 'thisapp' && !calls.includes(name)) calls.push(name);
    }
    if (expr.kind === 'criteria' && expr.object.kind === 'name' && !fetches.includes(expr.object.name)) fetches.push(expr.object.name);
    for (const key of Object.keys(node).sort((a, b) => compareEnUs(a, b))) if (key !== 'span') visit((node as Record<string, unknown>)[key]);
  };
  visit(parseExpression(src, true));
  let out = '';
  if (calls.length) {
    out += ` It compares with the result of app function ${calls.map((name) => `thisapp.${name}()`).join(', ')}, which the generated report read does not call: replace that comparison with the value or field condition the function returns, then regenerate.`;
  }
  if (fetches.length) {
    out += ` It compares with a field fetched from ${fetches.map((name) => `${name}[...]`).join(', ')}, which the generated report read does not evaluate: replace that comparison with a fixed value or a condition on this form's own fields, then regenerate.`;
  }
  return out;
}
