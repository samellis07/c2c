/**
 * IR → PWA model. Widgets follow the schema mapping. A construct this step
 * does not draw is status "todo" and is listed on the model; it is not dropped.
 */

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App, Field, Form, FunctionDef, Page, Property, PropertyBlock, Report, ReportCustomAction } from '../../core/src/ir.js';
import { hasOthersOption, recordStatusColumn, translationSettings, translationStrings, unquote } from '../../core/src/ir.js';
import { compareEnUs } from '../../core/src/order.js';
import type { BlueprintFieldSpec } from '../../deluge/src/blueprint-rules.js';
import { blueprintFieldSpecs, fnSignatureParams, functionRowBinding, slug as delugeSlug, type GeneratedFile } from '../../deluge/src/generate.js';
import type { Expr, Stmt } from '../../deluge/src/ast.js';
import { parse as parseDeluge, parseExpression } from '../../deluge/src/parser.js';
import { conditionalFormatCriteria, reportCriteria } from '../../deluge/src/translate.js';
import { requiredCompositePart } from '../../schema/src/composite-parts.js';
import { CURRENCY_CODES, fieldTypeRow, normalizeType, type FieldTypeRow } from '../../schema/src/mapping.js';
import { criteriaHasTodo, sealRelativeCriteria, type Criteria } from '../../shims/src/criteria.js';
import { LIMITS } from '../../shims/src/index.js';
import { multiValueDefault } from '../../shims/src/multi-value.js';
import { derivedFieldColumns, isMultiChoiceField } from '../../schema/src/generator.js';
import {
  droppedStyleReason,
  droppedStyleStep,
  carriedStyleRules,
  droppedStyleRulesTodo,
  droppedStyles,
  droppedTagReason,
  droppedTagStep,
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
  /** Rich-text editor toolbar from Creator's `toolbar = enable` property. */
  toolbar?: boolean;
  matrixId?: string;
  required: boolean;
  unique: boolean;
  readonly: boolean;
  status: 'generated' | 'todo';
  choices?: string[];
  /** Creator `others option = true`: the choice list also offers an "Others" free-text entry. */
  othersOption?: boolean;
  /**
   * Grouped `values` headers (`{"Label" : {"a","b"}}`) for a select: the
   * generated control draws each group as a native `<optgroup>`.
   */
  optionGroups?: { label: string; choices: string[] }[];
  lookup?: { form: string; field?: string; endpoint: string; addNew?: { label?: string }; sort?: 'asc' | 'desc' };
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  accept?: string;
  uploadEndpoint?: string;
  /** Acquisition sources the `source` property allows (`file`, `public_url`, `camera`), in the export's order. */
  uploadSources?: string[];
  /**
   * `preview duration` (seconds) on an image field: the generated picker shows
   * the chosen photo next to the control and auto-confirms it after this many
   * seconds unless the user retakes first (client-runtime.js showCapturePreview).
   */
  previewDuration?: number;
  scan: boolean;
  /** Scan control exposes the device camera switch when Creator enables it. */
  switchCamera?: boolean;
  /** Address fields with Creator capture_coordinates expose a device-location control. */
  captureCoordinates?: boolean;
  /** Address fields with Creator adjust_using_map expose a map to adjust the stored latitude/longitude pin. */
  adjustUsingMap?: boolean;
  /** Image fields with Creator `enable = link` collect a link URL alongside the upload and wrap the displayed image in a link. */
  imageLink?: boolean;
  /** Allocated storage column for the image link companion. */
  imageLinkColumn?: string;
  /** Image fields with Creator `enable = title` (or `enable = link, title`) collect a title alongside the upload. */
  imageTitle?: boolean;
  /** Allocated storage column for the image title companion. */
  imageTitleColumn?: string;
  /** Image fields with `enable = link` and a Creator `target`: the browser window the image link opens in. */
  linkTarget?: '_self' | '_blank' | '_parent' | '_top';
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
  /** Creator `alloweddays` values (Sunday = 0); restricted date widgets validate this set. */
  allowedDays?: number[];
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
  /** Creator `format = commadotwestern` on a number, decimal, percent, or currency field. Report cells and the record view group the integer digits. */
  format?: string;
  /** Creator `maxrow` on a subform/grid field: the row count the export restricts it to. The generated grid caps adds at it and the submit check rejects an oversized list; the check is browser-only (see `note`). */
  maxRows?: number;
  /** Subform `defaultrow = N`: empty rows the generated grid pre-fills for a new record. */
  defaultRowCount?: number;
  /** Subform `auto width = false`: the generated grid lays columns at their declared widths. Unset keeps auto-sizing. */
  autoWidth?: boolean;
  /** Seconds step for datetime input controls (e.g. 1 for seconds-precision time). */
  timeStep?: number;
  /** Whether datetime input displays seconds (Creator `timedisplayoptions = 'hh:mm:ss'`). */
  showSeconds?: boolean;
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
  /** `confirmation before execution ( ... )` on the export: shown before the action posts. */
  confirm?: { message: string; confirmLabel?: string; cancelLabel?: string };
  /** Creator runs this action once for the selected record collection. */
  collection?: boolean;
  /**
   * The action's workflow generated no function to dispatch, so its endpoint
   * runs nothing: the button renders turned off with a note, and the action
   * is a counted todo (see actionDispatchTarget).
   */
  preview?: true;
  /**
   * The workflow's whole body is one `openUrl` (or an if/else of `openUrl`)
   * to this app's own form, report or page: the button navigates there in
   * the client (see actionNavigation).
   */
  navigate?: UiActionNav;
}

/**
 * When this branch of a conditional `openUrl` runs. `equals` is a literal
 * string match on the row field; `nullish` is Deluge `== null`.
 */
export interface UiNavWhen {
  field: string;
  equals?: string;
  nullish?: true;
}

/**
 * A client navigation lifted from an `openUrl("#Form:X?F=" + input.ID, ...)`
 * workflow. `href` is the generated route (`#/form/X`); each param prefills
 * the target form field `name` from the clicked row's `field` (`ROWID` for
 * `input.ID`) or from a literal `value`. `branches` is an if/else of such
 * links: the first matching `when` wins, a branch with no `when` is the else.
 */
export interface UiActionNav {
  kind: 'form' | 'report' | 'page' | 'external' | 'anchor' | 'relative';
  target: string;
  href: string;
  /**
   * The link opens one record's screen: the route is `href` plus the
   * clicked row's `field` (`ROWID` for `input.ID`) or the literal `value`
   * as the trailing segment — `#/form/X/edit/<id>` for an edit link,
   * `#/report/Y/row/<id>` or `#/record/<form>/<id>` for a summary link.
   */
  record?: { field?: string; value?: string };
  params: Array<{ name: string; field?: string; value?: string }>;
  when?: UiNavWhen;
  branches?: UiActionNav[];
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
    /** Creator `format = commadotwestern`: the cell groups integer digits with commas. */
    format?: string;
    multiValue?: boolean;
    date?: 'date' | 'datetime';
    action?: string;
  }[];
  /** Phone record card fields in card order (decorations/report-views.ts); the list columns are the web layout. */
  phoneColumns?: { field: string; label: string; format?: string }[];
  filters: { field?: string; label?: string }[];
  sort: { field: string; order?: string }[];
  groupBy: { field: string }[];
  groupField?: string;
  basedOn?: string;
  /** Calendar/timeline: date columns on the form that place a row (`options { start date, end date }`). */
  startField?: string;
  endField?: string;
  /** Calendar display grouping from `options { display type }`. */
  displayType?: string;
  /** Kanban lane order from `options { sort order }`: alphabetical by lane key, not first-seen order. */
  sortOrder?: 'ascending' | 'descending';
  /** Kanban card or calendar entry title (`options { display field }` on calendar/timeline). */
  titleField?: string;
  /** Map report: the address/location field markers plot from (`options { display field }`). */
  mapField?: string;
  /** List report's primary display field (`options { display field }`). */
  displayField?: string;
  /** Map report: Creator `options { radius }` in metres, used as viewport padding around plotted pins. */
  mapRadius?: number;
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
  rowActions?: { add?: boolean; edit?: boolean; delete?: boolean };
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
  /**
   * Migrated `translation` blocks: language code → Creator label key → text.
   * The client swaps labels for the selected language; absent blocks leave no
   * table and stay manual steps.
   */
  i18n?: Record<string, Record<string, string>>;
  /**
   * The blocks' `Language_Settings.LANGAGUE_WITH_LOGIN` value — how the app
   * picks a language when the visitor has not chosen one. The client honors
   * `browser` (the visitor's browser language list) and a migrated language
   * code; a later block's value wins.
   */
  languageWithLogin?: string;
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
// setting. Catalyst has no generated field-level privacy or access control, so all
// privacy-flagged fields in an app are recorded together in one manual step rather
// than invented as UI.
const PRIVACY_PROPERTY_KEYS = ['private', 'personal data', 'encrypt', 'encryptdata'];
const PRIVACY_TODO_NAME = 'privacy flags';

export function parsePrivacyTodoEntries(todo: UiTodo): { field: string; flags: string[] }[] {
  const entries: { field: string; flags: string[] }[] = [];
  const match = /^Fields "([^"]+)"/.exec(todo.reason);
  if (!match?.[1]) return entries;
  for (const item of match[1].split(/\),\s*/)) {
    const trimmed = item.endsWith(')') ? item.slice(0, -1) : item;
    const open = trimmed.indexOf(' (');
    if (open < 0) continue;
    const fieldRef = trimmed.slice(0, open).trim();
    const flags = trimmed
      .slice(open + 2)
      .split(',')
      .map((part) => {
        const s = part.trim();
        const lower = s.toLowerCase();
        if (lower.endsWith('true')) {
          const before = s.slice(0, s.length - 4).trimEnd();
          if (before.endsWith('=')) return before.slice(0, -1).trim();
        }
        return s;
      })
      .filter(Boolean);
    if (fieldRef && flags.length) entries.push({ field: fieldRef, flags });
  }
  return entries;
}

function recordPrivacyFlags(formName: string, field: Field, todos: UiTodo[]): void {
  const active = PRIVACY_PROPERTY_KEYS.filter((key) => prop(field, key)?.trim().toLowerCase() === 'true');
  if (!active.length) return;
  const fieldRef = `${formName}.${field.name}`;
  const existing = todos.find((t) => t.area === 'field' && t.name === PRIVACY_TODO_NAME);
  const entries = existing ? parsePrivacyTodoEntries(existing) : [];
  const current = entries.find((item) => item.field === fieldRef);
  if (current) {
    current.flags = PRIVACY_PROPERTY_KEYS.filter((key) => current.flags.includes(key) || active.includes(key));
  } else {
    entries.push({ field: fieldRef, flags: active });
  }
  const formatted = entries
    .map((item) => `${item.field} (${item.flags.map((flag) => `${flag} = true`).join(', ')})`)
    .join(', ');
  const reason = `Fields "${formatted}" are flagged for data privacy; Catalyst generates no privacy or access control for these fields.`;
  const manualStep = `In the Catalyst console, apply the data-privacy protection needed for ${formatted} by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.`;
  if (existing) {
    existing.reason = reason;
    existing.manualStep = manualStep;
  } else {
    todos.push({
      area: 'field',
      name: PRIVACY_TODO_NAME,
      reason,
      manualStep,
    });
  }
}

// A scan-capable field's `manual input = true` setting toggles a free-text fallback
// next to the camera control. The generated scan field is itself a text input, so
// the user can type a value before scanning; the setting is already carried.

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

// A barcode/QR field's `value` property is the Creator expression (static text plus
// other field references) that becomes the code's payload. The generated barcode
// widget is a static computed display with no such template, so the setting is
// recorded as a manual step rather than invented as UI.
const BARCODE_VALUE_PROPERTY_KEY = 'value';

// `annotation = true` lets the user draw or mark up a captured photo before it is
// stored. The generated image field uploads the chosen file unchanged with no
// drawing tool, so the setting is recorded as a manual step rather than invented
// as UI. `false` (or absent) needs no step: default-equivalence.ts proves it.
const ANNOTATION_PROPERTY_KEY = 'annotation';

// `aspect ratio = original` keeps the uploaded file's own proportions — already
// the generated widget's behaviour, proved by default-equivalence.ts. A fixed
// crop ratio (square, 4:3, ...) asks Creator to crop the photo before it is
// stored; the generated image field sends the file unchanged with no crop step,
// so the setting is recorded as a manual step rather than invented as UI.
const ASPECT_RATIO_PROPERTY_KEY = 'aspect ratio';

// An audio field's `duration` setting (seconds) caps the recording length. The
// generated recorder enforces no maximum, so the limit is recorded as a manual
// step rather than invented as UI.
const AUDIO_DURATION_PROPERTY_KEY = 'duration';

// Creator's "Set Preview Duration" camera setting (3/5/10/15/20s auto-dismiss) on an
// image or scan-capable field. 0 (or unset) matches the generated default — no
// preview is shown, same as the browser's own file/camera confirmation. A
// non-zero value on an image field is generated as ui.previewDuration: the
// picker shows the chosen photo and auto-confirms it after that many seconds
// (client-runtime.js showCapturePreview). A scan field has no photo to show —
// it is a text input marked for scanning — so a non-zero value there stays a
// manual step.
const PREVIEW_DURATION_PROPERTY_KEY = 'preview duration';

// A picklist/dropdown/radio field's `displayformat` names the record field (e.g.
// `[last_name]`) to show for each option. Without an in-app `values` lookup, the
// generated field has nothing to format: the option list is static text, not a
// record field reference, so the setting is recorded as a manual step rather than
// invented as UI.
const DISPLAYFORMAT_PROPERTY_KEY = 'displayformat';

/**
 * A `bidirectional = Back` lookup pair is carried two ways. The schema generator
 * places a reverse column when one side is a linked grid (packages/schema/src/generator.ts
 * pendingRefs): a grid field pointing at the target, or a partner grid field on the
 * target naming this field back. With no grid side, a declared partner lookup on the
 * target that looks back and names this field stores the pair on its own side — a
 * junction for a multi partner, its own column otherwise — and the backup loader
 * fills it from the forward rel file. Mirrors the proof
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
  if (unquote(partnerBack?.value ?? '').trim() !== field.name) return false;
  return bidirectionalLinkedGrid(partner, formName) || partner?.lookup?.form === formName;
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
function soleOpenUrl(stmt: Stmt): Stmt | undefined {
  if (stmt.kind === 'openUrl') return stmt;
  if (stmt.kind === 'block' && stmt.body.length === 1) return soleOpenUrl(stmt.body[0]!);
  return undefined;
}

/** True when every statement is an `openUrl` (one call, or if/else of them). */
function isOpenUrlOnlyBody(body: readonly Stmt[]): boolean {
  if (body.length === 1 && body[0]?.kind === 'openUrl') return true;
  if (body.length !== 1 || body[0]?.kind !== 'if') return false;
  const iff = body[0];
  if (!soleOpenUrl(iff.then)) return false;
  if (iff.elifs.some((branch) => !soleOpenUrl(branch.body))) return false;
  if (iff.else && !soleOpenUrl(iff.else)) return false;
  return true;
}

/**
 * True when some statement in the body (at any depth) is an `openUrl` call.
 * Wider than {@link isOpenUrlOnlyBody}: it also matches a guard read before a
 * conditional navigation (`count = Form[...].count(); if (count == 1) { url =
 * "..."; openUrl(url); }`), a shape actionNavigation correctly refuses — the
 * guard condition is not a record-field test a static link can reproduce —
 * but whose navigation is otherwise silently dropped with no record. Used
 * only to decide whether a dropped action needs a manual-item note; it never
 * changes what gets generated.
 */
function containsOpenUrl(body: readonly Stmt[]): boolean {
  const visit = (s: Stmt): boolean => {
    switch (s.kind) {
      case 'openUrl':
        return true;
      case 'block':
        return s.body.some(visit);
      case 'if':
        return visit(s.then) || s.elifs.some((branch) => visit(branch.body)) || (s.else ? visit(s.else) : false);
      case 'forEach':
        return visit(s.body);
      case 'while':
        return visit(s.body);
      case 'try':
        return visit(s.body) || (s.catchBody ? visit(s.catchBody) : false);
      default:
        return false;
    }
  };
  return body.some(visit);
}

/**
 * Best-effort: does this dispatchable custom action's workflow (or the one
 * function it delegates to, the same single hop actionNavigation follows)
 * contain an openUrl call that actionNavigation could not turn into a static
 * link? A dropped navigation is otherwise invisible — the action still runs
 * and reports success, it just never takes the user anywhere.
 */
function actionDropsOpenUrl(app: App, workflow: string | undefined): boolean {
  const wanted = (workflow ?? '').trim();
  const fn = wanted ? app.functions.find((item) => item.kind === 'creator' && item.name === wanted) : undefined;
  if (!fn) return false;
  let body: Stmt[];
  try {
    body = parseDeluge(fn.deluge.map((part) => part.text).join('\n')).body;
  } catch {
    return false;
  }
  if (containsOpenUrl(body)) return true;
  if (body.length !== 1 || body[0]?.kind !== 'expr' || body[0].expr.kind !== 'call') return false;
  const calleeName = calleeFunctionName(body[0].expr.callee);
  const calleeFn = calleeName ? app.functions.find((item) => item.name.toLowerCase() === calleeName.toLowerCase()) : undefined;
  if (!calleeFn) return false;
  try {
    return containsOpenUrl(parseDeluge(calleeFn.deluge.map((part) => part.text).join('\n')).body);
  } catch {
    return false;
  }
}

function isPureClientFunction(app: App, fn: FunctionDef): boolean {
  let body: Stmt[];
  try {
    body = parseDeluge(fn.deluge.map((part) => part.text).join('\n')).body;
  } catch {
    return false;
  }
  if (isOpenUrlOnlyBody(body)) return true;
  if (body.length === 1 && body[0]?.kind === 'expr' && body[0].expr.kind === 'call') {
    const calleeName = calleeFunctionName(body[0].expr.callee);
    if (!calleeName) return false;
    const calleeFn = app.functions.find((f) => f.name.toLowerCase() === calleeName.toLowerCase());
    if (!calleeFn) return false;
    try {
      const calleeBody = parseDeluge(calleeFn.deluge.map((p) => p.text).join('\n')).body;
      return isOpenUrlOnlyBody(calleeBody);
    } catch {
      return false;
    }
  }
  return false;
}

/** The workflow's deluge text, extended with the callee's when the body only delegates a single call (thisapp.customActions.*). */
function actionReasonSource(app: App, fn: FunctionDef): string {
  const source = fn.deluge.map((part) => part.text).join('\n');
  try {
    const body = parseDeluge(source).body;
    if (body.length !== 1 || body[0]?.kind !== 'expr' || body[0].expr.kind !== 'call') return source;
    const calleeName = calleeFunctionName(body[0].expr.callee);
    const callee = calleeName ? app.functions.find((item) => item.name.toLowerCase() === calleeName.toLowerCase()) : undefined;
    return callee ? `${source}\n${callee.deluge.map((part) => part.text).join('\n')}` : source;
  } catch {
    return source;
  }
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
const OWN_APP_HOST = /^https:\/\/(?:app\.)?zohocreator\.[a-z]{2,3}(?:\.[a-z]{2})?\/?$/;

/** The operands of a `+` chain, left to right. */
function concatParts(expr: Expr): Expr[] {
  if (expr.kind === 'paren') return concatParts(expr.expr);
  if (expr.kind === 'binary' && expr.op === '+') return [...concatParts(expr.left), ...concatParts(expr.right)];
  return [expr];
}

const isAppUri = (expr: Expr | undefined) => expr?.kind === 'member' && expr.object.kind === 'name' && expr.object.name === 'zoho' && expr.property === 'appuri';
const isAdminUser = (expr: Expr | undefined) =>
  expr?.kind === 'member' && expr.object.kind === 'name' && expr.object.name === 'zoho' && (expr.property === 'adminuser' || expr.property === 'adminuserid');

function isOwnAppSlug(app: App, candidate: string): boolean {
  const lower = candidate.toLowerCase();
  const raw = (app.name ?? '').trim().toLowerCase();
  if (!raw) return false;
  const words = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const hyphenSlug = words.join('-');
  const underSlug = words.join('_');
  return lower === raw || lower === hyphenSlug || lower === underSlug;
}

function expandInterpolatedParts(rawParts: Expr[], substituteArg: (expr: Expr) => Expr): Expr[] {
  const out: Expr[] = [];
  for (const raw of rawParts) {
    const part = substituteArg(raw);
    if (part.kind !== 'string' || !part.value.includes('${')) {
      out.push(part);
      continue;
    }
    const str = part.value;
    let cursor = 0;
    let failed = false;
    while (cursor < str.length) {
      const open = str.indexOf('${', cursor);
      if (open < 0) {
        if (cursor < str.length) out.push({ kind: 'string', value: str.slice(cursor), span: part.span });
        break;
      }
      if (open > cursor) {
        out.push({ kind: 'string', value: str.slice(cursor, open), span: part.span });
      }
      const close = str.indexOf('}', open + 2);
      const inner = close > open + 2 ? str.slice(open + 2, close).trim() : '';
      if (close < 0 || !inner) {
        out.push({ kind: 'unknown', text: str, reason: 'expr', span: part.span });
        failed = true;
        break;
      }
      out.push(substituteArg(parseExpression(inner)));
      cursor = close + 1;
    }
    if (failed) break;
  }
  return out;
}

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

function unwrapParens(expr: Expr): Expr {
  let curr = expr;
  while (curr.kind === 'paren') curr = curr.expr;
  return curr;
}

/** The form a function's row reads come from: `form =` or the first form-typed parameter. */
function recordSourceForm(app: App, fn: FunctionDef): Form | undefined {
  if (fn.form) {
    const named = app.forms.find((item) => item.name.toLowerCase() === fn.form!.toLowerCase());
    if (named) return named;
  }
  for (const param of fnSignatureParams(fn.signature)) {
    const form = app.forms.find((item) => item.name.toLowerCase() === param.type.toLowerCase());
    if (form) return form;
  }
  return undefined;
}

/** A name that stands for the clicked / selected record in this function. */
function isRecordName(name: string, app: App, fn: FunctionDef, argByParam: Map<string, Expr>): boolean {
  const lower = name.toLowerCase();
  if (lower === 'input') return false;
  for (const param of fnSignatureParams(fn.signature)) {
    if (param.name.toLowerCase() !== lower) continue;
    if (app.forms.some((form) => form.name.toLowerCase() === param.type.toLowerCase())) return true;
  }
  const mapped = argByParam.get(lower);
  if (mapped?.kind === 'name') {
    const mappedName = mapped.name.toLowerCase();
    if (app.forms.some((form) => form.name.toLowerCase() === mappedName)) return true;
    if (fn.form && mappedName === fn.form.toLowerCase()) return true;
  }
  return false;
}

function isNullLiteral(expr: Expr): boolean {
  const u = unwrapParens(expr);
  return u.kind === 'name' && u.name === 'null';
}

function stringLiteral(expr: Expr): string | undefined {
  const u = unwrapParens(expr);
  return u.kind === 'string' ? u.value : undefined;
}

/** Row field a branch test reads (`Status`, `ROWID` for `ID`). */
function whenField(expr: Expr, app: App, fn: FunctionDef, source: Form | undefined, argByParam: Map<string, Expr>): string | undefined {
  const u = unwrapParens(expr);
  if (u.kind === 'name') {
    if (u.name === 'ID') return 'ROWID';
    if (source && formField(source, u.name)) return u.name;
    return undefined;
  }
  if (u.kind === 'member' && u.object.kind === 'name' && /^[A-Za-z_]\w*$/.test(u.property)) {
    if (u.object.name !== 'input' && !isRecordName(u.object.name, app, fn, argByParam)) return undefined;
    if (u.property === 'ID') return 'ROWID';
    if (source && formField(source, u.property)) return u.property;
  }
  return undefined;
}

/** `field == "Requested"` or `field == null` / `field is null`. */
function whenFromTest(test: Expr, app: App, fn: FunctionDef, source: Form | undefined, argByParam: Map<string, Expr>): UiNavWhen | undefined {
  const u = unwrapParens(test);
  if (u.kind !== 'binary') return undefined;
  if (u.op !== '==' && u.op !== '=' && u.op !== 'is') return undefined;
  const leftField = whenField(u.left, app, fn, source, argByParam);
  const rightField = whenField(u.right, app, fn, source, argByParam);
  const leftStr = stringLiteral(u.left);
  const rightStr = stringLiteral(u.right);
  if (leftField && rightStr !== undefined) return { field: leftField, equals: rightStr };
  if (rightField && leftStr !== undefined) return { field: rightField, equals: leftStr };
  if (leftField && isNullLiteral(u.right)) return { field: leftField, nullish: true };
  if (rightField && isNullLiteral(u.left)) return { field: rightField, nullish: true };
  return undefined;
}

/**
 * One own-app `openUrl` as a client navigation. Form-typed parameter
 * members (`travelDetails.ID`) are the same row reads as `input.ID`.
 */
function navFromOpenUrl(
  app: App,
  source: Form | undefined,
  fn: FunctionDef,
  openUrlStmt: Stmt,
  argByParam: Map<string, Expr>,
): UiActionNav | undefined {
  if (openUrlStmt.kind !== 'openUrl') return undefined;
  if (!openUrlStmt.args.length || openUrlStmt.args.length > 3) return undefined;
  const substituteArg = (expr: Expr): Expr => {
    if (expr.kind === 'call' && expr.args.length === 0 && expr.callee.kind === 'member' && expr.callee.property.toLowerCase() === 'getall') {
      return substituteArg(expr.callee.object);
    }
    if (expr.kind === 'name' && argByParam.has(expr.name.toLowerCase())) {
      return argByParam.get(expr.name.toLowerCase())!;
    }
    if (expr.kind === 'member') {
      const obj = substituteArg(expr.object);
      return obj === expr.object ? expr : { ...expr, object: obj };
    }
    return expr;
  };
  const rawParts = concatParts(openUrlStmt.args[0]!);
  const parts: Expr[] = expandInterpolatedParts(rawParts, substituteArg);
  if (parts[0]?.kind === 'string' && OWN_APP_HOST.test(parts[0].value) && isAppUri(parts[1])) parts.splice(0, 2);
  else if (parts[0]?.kind === 'string' && OWN_APP_HOST.test(parts[0].value) && isAdminUser(parts[1]) && parts[2]?.kind === 'string') {
    const slugMatch = /^\/?([A-Za-z0-9_-]+)\/(.*)$/s.exec(parts[2].value);
    if (!slugMatch || !isOwnAppSlug(app, slugMatch[1]!)) return undefined;
    const rest = slugMatch[2]!;
    if (rest) parts.splice(0, 3, { kind: 'string', value: rest, span: parts[2].span });
    else parts.splice(0, 3);
  } else if (isAppUri(parts[0])) parts.splice(0, 1);
  if (parts[0]?.kind === 'string' && /^\s*javascript:/i.test(parts[0].value)) return undefined;
  const rowBind = functionRowBinding(fn);
  const sigParamForms = new Map<string, Form>();
  for (const param of fnSignatureParams(fn.signature)) {
    const pf = app.forms.find((form) => form.name.toLowerCase() === param.type.toLowerCase());
    if (pf) sigParamForms.set(param.name.toLowerCase(), pf);
  }
  const isSourceRoot = (expr: Expr): boolean => {
    if (expr.kind !== 'name') return false;
    if (expr.name === 'input') return true;
    const key = expr.name.toLowerCase();
    if (rowBind && key === rowBind) return true;
    if (source && key === source.name.toLowerCase()) return true;
    const pf = sigParamForms.get(key);
    return !!pf && !!source && pf.name === source.name;
  };
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
    } else if (part.kind === 'member' && isSourceRoot(part.object) && /^[A-Za-z_]\w*$/.test(part.property)) {
      text += `\u0000${reads.length}\u0000`;
      reads.push(part.property);
    } else if (
      part.kind === 'member' &&
      part.object.kind === 'name' &&
      /^[A-Za-z_]\w*$/.test(part.property) &&
      isRecordName(part.object.name, app, fn, argByParam)
    ) {
      text += `\u0000${reads.length}\u0000`;
      reads.push(part.property);
    } else if (part.kind === 'member' && part.property === 'ID' && part.object.kind === 'member' && isSourceRoot(part.object.object) && formField(source, part.object.property)?.lookup) {
      // `input.<Lookup>.ID` is the parent ROWID the lookup column stores.
      text += `\u0000${reads.length}\u0000`;
      reads.push(part.object.property);
    } else if (
      part.kind === 'member' &&
      /^[A-Za-z_]\w*$/.test(part.property) &&
      part.object.kind === 'member' &&
      isSourceRoot(part.object.object) &&
      /^[A-Za-z_]\w*$/.test(part.object.property)
    ) {
      // `input.<Lookup>.<Field>` reads one field of the related record. The
      // head must be a lookup on the report's form and the leaf a stored
      // scalar column of the lookup target (no subfields: composites and
      // subforms are not single values). Anything deeper stays a todo.
      const lookupField = source ? formField(source, part.object.property) : undefined;
      const related = lookupField?.lookup ? app.forms.find((form) => form.name === lookupField.lookup!.form) : undefined;
      const leaf = related ? formField(related, part.property) : undefined;
      if (!lookupField?.lookup || !related || !leaf || leaf.subfields.length > 0) return undefined;
      text += `\u0000${reads.length}\u0000`;
      reads.push(`${part.object.property}.${part.property}`);
    } else return undefined;
  }
  if (/^(?:mailto:|tel:)/i.test(text)) return { kind: 'external', target: text, href: text, params: [] };
  const origText = text;
  const pageRoute = /^\/?(?:print|page-embed|page-perma)\/([A-Za-z_]\w*)\/?(\?.*)?$/.exec(text);
  if (pageRoute) text = `#Page:${pageRoute[1]}${pageRoute[2] ?? ''}`;
  const viewRoute = /^\/?(?:view-embed|view-perma)\/([A-Za-z_]\w*)\/?(\?.*)?$/.exec(text);
  if (viewRoute) text = `#View:${viewRoute[1]}${viewRoute[2] ?? ''}`;
  const reportRoute = /^\/?(?:report-embed|report-perma)\/([A-Za-z_]\w*)\/?(\?.*)?$/.exec(text);
  if (reportRoute) text = `#Report:${reportRoute[1]}${reportRoute[2] ?? ''}`;
  const formRoute = /^\/?(?:form-embed|form-perma)\/([A-Za-z_]\w*)\/?(\?.*)?$/.exec(text);
  if (formRoute) text = `#Form:${formRoute[1]}${formRoute[2] ?? ''}`;
  const clean = text.startsWith('/#') ? text.slice(1) : text;
  const m = /^#(Form|Report|Page|View):([A-Za-z_][\w ]*)(?:\?(.*))?$/.exec(clean);
  // `<form>/record-edit/<report>/<id>` and `record-summary/<target>/<id>`
  // are Creator's path-style record links; `#Form:` links carry the same
  // target through `recLinkID`. All three open one record's screen.
  const editLink = !m ? /^\/?([A-Za-z_]\w*)\/record-edit\/([A-Za-z_]\w*)\/([^?\s\\]+)(?:\?(.*))?$/.exec(clean) : null;
  const shortEditLink = !m && !editLink ? /^\/?record-edit\/([A-Za-z_]\w*)\/([^?\s\\]+)(?:\?(.*))?$/.exec(clean) : null;
  const summaryLink = !m && !editLink && !shortEditLink ? /^\/?record-summary\/([A-Za-z_]\w*)\/([^?\s\\]+)(?:\?(.*))?$/.exec(clean) : null;
  if (!m && !editLink && !shortEditLink && !summaryLink) {
    const anchor = /^#([A-Za-z_][\w-]*)$/.exec(origText);
    if (anchor) {
      const target = anchor[1]!;
      return { kind: 'anchor', target, href: `#${encodeURIComponent(target)}`, params: [] };
    }
    if (
      !/^\/(?:[A-Za-z_]\w*\/record-edit(?:\/|$)|record-edit(?:\/|$)|record-summary(?:\/|$)|print(?:\/|$)|#)/i.test(origText) &&
      /^\/(?!\/)[^\s"'<>`\\\u0000]*$/.test(origText)
    ) {
      return { kind: 'relative', target: origText, href: origText, params: [] };
    }
    return undefined;
  }
  /** The field or literal one \u0000 read stands for, as a nav value. */
  const readValue = (raw: string): { field: string } | { value: string } | undefined => {
    const read = /^\u0000(\d+)\u0000$/.exec(raw);
    if (!read) return raw.includes('\u0000') ? undefined : { value: raw };
    const field = reads[Number(read[1])]!;
    if (field === 'ID') return { field: 'ROWID' };
    if (field.includes('.')) {
      // A one-level lookup read travels under its dotted row key; the
      // server attaches it (or leaves it off when the caller may not
      // read it) and the client sends only a value the row holds.
      const dot = field.indexOf('.');
      const lookupName = field.slice(0, dot);
      const leafName = field.slice(dot + 1);
      const lookupField = source ? formField(source, lookupName) : undefined;
      const target = lookupField?.lookup ? app.forms.find((form) => form.name === lookupField.lookup!.form) : undefined;
      if (!lookupField?.lookup || !target || !formField(target, leafName)) return undefined;
      return { field };
    }
    if (source && formField(source, field)) return { field };
    return undefined;
  };
  let kind: UiActionNav['kind'];
  let target: string;
  let query = '';
  let record: UiActionNav['record'];
  let href: string | undefined;
  let targetForm: Form | undefined;
  let targetPage: Page | undefined;
  if (m) {
    const rawKind = m[1]!.toLowerCase();
    const rawTarget = m[2]!.trim();
    const named = (item: { name: string; displayName?: string }) => item.name.toLowerCase() === rawTarget.toLowerCase() || (rawTarget.includes(' ') && item.displayName?.toLowerCase() === rawTarget.toLowerCase());
    // Pre-rename Creator syntax: reports were called "Views" and pages kept
    // the same alias, so #View: still routes to either, exactly like the
    // generator's own classifyClientOpenUrl resolves it.
    kind = (
      rawKind === 'view' ? (app.reports.some(named) ? 'report' : 'page') : rawKind
    ) as UiActionNav['kind'];
    targetForm = kind === 'form' ? app.forms.find(named) : undefined;
    const targetReport = kind === 'report' ? app.reports.find(named) : undefined;
    targetPage = kind === 'page' ? app.pages.find(named) : undefined;
    if (kind === 'form' ? !targetForm : kind === 'report' ? !targetReport : !targetPage) return undefined;
    target = targetForm?.name ?? targetReport?.name ?? targetPage?.name ?? rawTarget;
    query = m[3] ?? '';
  } else if (editLink) {
    const form = app.forms.find((item) => item.name === editLink[1]);
    const linkReport = app.reports.find((item) => item.name === editLink[2]);
    // The report segment names the view the edit opened from. The generated
    // edit route has no view context, so the link is only honored when the
    // named report is a real view of the named form.
    if (!form || !linkReport || linkReport.form !== form.name) return undefined;
    kind = 'form';
    target = form.name;
    targetForm = form;
    query = editLink[4] ?? '';
    const id = readValue(editLink[3]!);
    if (!id) return undefined;
    record = id;
    href = `#/form/${encodeURIComponent(form.name)}/edit`;
  } else if (shortEditLink) {
    const linkReport = app.reports.find((item) => item.name.toLowerCase() === shortEditLink[1]!.toLowerCase());
    const form = linkReport?.form
      ? app.forms.find((item) => item.name.toLowerCase() === linkReport.form!.toLowerCase())
      : app.forms.find((item) => item.name.toLowerCase() === shortEditLink[1]!.toLowerCase());
    if (!form) return undefined;
    const id = readValue(shortEditLink[2]!);
    if (!id) return undefined;
    kind = 'form';
    target = form.name;
    targetForm = form;
    query = shortEditLink[3] ?? '';
    record = id;
    href = `#/form/${encodeURIComponent(form.name)}/edit`;
  } else {
    const linkReport = app.reports.find((item) => item.name === summaryLink![1]);
    const form = linkReport ? undefined : app.forms.find((item) => item.name === summaryLink![1]);
    if (!linkReport && !form) return undefined;
    const id = readValue(summaryLink![2]!);
    if (!id) return undefined;
    record = id;
    query = summaryLink![3] ?? '';
    if (linkReport) {
      kind = 'report';
      target = linkReport.name;
      href = `#/report/${encodeURIComponent(linkReport.name)}/row`;
    } else {
      kind = 'form';
      target = form!.name;
      href = `#/record/${encodeURIComponent(form!.name)}`;
    }
  }
  const params: UiActionNav['params'] = [];
  for (const pair of query.split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const name = eq < 0 ? pair : pair.slice(0, eq);
    const raw = eq < 0 ? '' : pair.slice(eq + 1);
    if (/^zc_/i.test(name)) {
      if (raw.includes('\u0000')) return undefined;
      continue;
    }
    let paramName = name;
    if (targetForm) {
      // `recLinkID` picks the record the form's edit screen opens and
      // `viewLinkName` names the report the link left; both are Creator
      // link syntax, never fields of the target form.
      if (/^reclinkid$/i.test(name)) {
        const id = readValue(raw);
        if (!id || record || ('value' in id && id.value === '')) return undefined;
        record = id;
        href = `#/form/${encodeURIComponent(target)}/edit`;
        continue;
      }
      if (/^viewlinkname$/i.test(name)) {
        if (raw.includes('\u0000')) return undefined;
        continue;
      }
      if (!formField(targetForm, name)) return undefined;
    } else if (targetPage) {
      if (!(targetPage.params ?? []).includes(name)) return undefined;
    } else if (kind === 'report' && !record) {
      if (eq <= 0 || !raw || /_op$/i.test(name) || /^filter$/i.test(name) || params.length > 0) return undefined;
      const reportFormName = app.reports.find((item) => item.name === target)?.form;
      const reportForm = reportFormName ? app.forms.find((item) => item.name.toLowerCase() === reportFormName.toLowerCase()) : undefined;
      const rField = reportForm ? formField(reportForm, name) : undefined;
      if (
        !rField ||
        rField.subfields.length > 0 ||
        rField.type?.toLowerCase() === 'subform' ||
        rField.type?.toLowerCase() === 'section' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rField.name)
      ) {
        return undefined;
      }
      paramName = rField.name;
    } else return undefined;
    const value = readValue(raw);
    if (!value || (kind === 'report' && 'value' in value && value.value === '')) return undefined;
    params.push({ name: paramName, ...value });
  }
  return { kind, target, href: href ?? `#/${kind}/${encodeURIComponent(target)}`, ...(record ? { record } : {}), params };
}

function navBranchesFromIf(
  app: App,
  source: Form | undefined,
  fn: FunctionDef,
  iff: Extract<Stmt, { kind: 'if' }>,
  argByParam: Map<string, Expr>,
): UiActionNav | undefined {
  const thenUrl = soleOpenUrl(iff.then);
  if (!thenUrl) return undefined;
  const thenNav = navFromOpenUrl(app, source, fn, thenUrl, argByParam);
  if (!thenNav) return undefined;
  const thenWhen = whenFromTest(iff.test, app, fn, source, argByParam);
  if (!thenWhen) return undefined;
  thenNav.when = thenWhen;
  const branches: UiActionNav[] = [thenNav];
  for (const elif of iff.elifs) {
    const url = soleOpenUrl(elif.body);
    if (!url) return undefined;
    const nav = navFromOpenUrl(app, source, fn, url, argByParam);
    if (!nav) return undefined;
    const when = whenFromTest(elif.test, app, fn, source, argByParam);
    if (!when) return undefined;
    nav.when = when;
    branches.push(nav);
  }
  if (iff.else) {
    const url = soleOpenUrl(iff.else);
    if (!url) return undefined;
    const nav = navFromOpenUrl(app, source, fn, url, argByParam);
    if (!nav) return undefined;
    branches.push(nav);
  }
  return { ...branches[0]!, branches };
}

/**
 * The client navigation a custom action's workflow stands for, or none. The
 * workflow (a Creator `type = functions` record workflow on the report's
 * form) must hold exactly one statement, `openUrl(url[, window[, features]])`
 * (or an if / else-if / else whose every branch is one `openUrl`, or a
 * call that delegates to such a body), whose url is this app's own `#Form:`
 * / `#Report:` / `#Page:` link, written as literals and `input.<Field>` (or
 * `input.<Lookup>.ID`, or a form-typed parameter's field) reads, optionally
 * after the app's own address (`zoho.appuri`). The target must be a form,
 * report or page of the app. A form link's query prefills the form: each
 * value is a literal or one field of the clicked row, and each name a field
 * of the target form; Creator's `zc_` display parameters are dropped. A
 * report or page link carries no query. An if-test is a row field equal to
 * a string or `null`. Anything else (an external address, a computed
 * target, two sequential openUrls, an unknown field) is no navigation, and
 * the action stays turned off and counted.
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
  const argByParam = new Map<string, Expr>();
  let targetFn = fn;
  let targetBody: Stmt[] | undefined;
  if (isOpenUrlOnlyBody(body)) {
    targetBody = body;
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
    if (!isOpenUrlOnlyBody(calleeBody)) return undefined;
    targetFn = calleeFn;
    targetBody = calleeBody;
    const params = fnSignatureParams(calleeFn.signature);
    const callArgs = stmt.expr.args;
    for (let i = 0; i < params.length; i++) {
      if (callArgs[i]) argByParam.set(params[i]!.name.toLowerCase(), callArgs[i]!);
    }
  } else {
    return undefined;
  }
  const source = recordSourceForm(app, targetFn) ?? app.forms.find((form) => form.name === fn.form);
  const head = targetBody[0];
  if (head?.kind === 'openUrl') return navFromOpenUrl(app, source, targetFn, head, argByParam);
  if (head?.kind === 'if') return navBranchesFromIf(app, source, targetFn, head, argByParam);
  return undefined;
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
  const i18n = mergedTranslations(app);
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
    ...(Object.keys(i18n).length ? { i18n } : {}),
    ...(languageWithLogin(app) !== undefined ? { languageWithLogin: languageWithLogin(app) } : {}),
  };
  Object.defineProperty(model, UI_SNIPPET_FILES, { value: snippetFiles, enumerable: false });
  applyDecorations(model, app);
  return model;
}

/**
 * Every `translation` block's migratable labels merged into one table:
 * language → key → text, keys and languages sorted so the emitted model is
 * deterministic. A later block overrides an earlier one's key, matching a
 * Creator re-import.
 */
function mergedTranslations(app: App): Record<string, Record<string, string>> {
  const merged: Record<string, Record<string, string>> = Object.create(null);
  for (const t of app.translations) {
    for (const [lang, strings] of Object.entries(translationStrings(t)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      Object.assign((merged[lang] ??= Object.create(null) as Record<string, string>), strings);
    }
  }
  const sorted: Record<string, Record<string, string>> = Object.create(null);
  for (const lang of Object.keys(merged).sort(compareEnUs)) {
    const table: Record<string, string> = Object.create(null);
    for (const key of Object.keys(merged[lang]!).sort(compareEnUs)) table[key] = merged[lang]![key]!;
    sorted[lang] = table;
  }
  return sorted;
}

/** The last `Language_Settings.LANGAGUE_WITH_LOGIN` string across blocks. */
function languageWithLogin(app: App): string | undefined {
  let value: string | undefined;
  for (const t of app.translations) {
    const setting = translationSettings(t)?.['LANGAGUE_WITH_LOGIN'];
    if (typeof setting === 'string') value = setting;
  }
  return value;
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
    fields: form.fields.map((field) => buildField(field, todos, form.name, 0, app, new Set(form.fields.map((item) => item.name)))),
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

/** Creator `target` names (and their browser spellings) for the window a linked image opens in. */
const IMAGE_LINK_TARGETS: Record<string, NonNullable<UiField['linkTarget']>> = {
  'same window': '_self',
  'new window': '_blank',
  'parent window': '_parent',
  'top window': '_top',
  _self: '_self',
  _blank: '_blank',
  _parent: '_parent',
  _top: '_top',
};

function buildField(field: Field, todos: UiTodo[], formName: string, depth = 0, app?: App, claimed?: Set<string>): UiField {
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
    // `switch camera` has a generated home only on a scan field (the
    // data-switch-camera attribute). On any other field it must stay out of
    // the model entirely: an image field's `switch camera = true` is proved
    // by DEFAULT_EQUIVALENCE, which requires byte-identical output.
    ...(wantsScan(field) && field.properties.some((p) => p.key.trim().toLowerCase().replace(/\s+/g, ' ') === 'switch camera' && unquote(p.value).trim().toLowerCase() === 'true')
      ? { switchCamera: true }
      : {}),
  };

  for (const property of field.properties) {
    const key = property.key.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!['charcount', 'character-count', 'character count', 'char count'].includes(key)) continue;
    const value = unquote(property.value).trim().toLowerCase();
    if (['false', '0', 'no', 'off'].includes(value)) continue;
    const name = `${formName}.${field.name} property ${property.key}`;
    if (todos.some((t) => t.area === 'field' && t.name === name)) continue;
    todos.push({ area: 'field', name, reason: `Field ${field.name} requests a live character counter; the generated field does not show one.`, manualStep: `Add a live character counter for ${field.name} by hand — this is not generated.` });
  }
  for (const flag of field.flags) {
    if (!/^(?:character[ -]?count|char[ -]?count)$/i.test(flag.trim())) continue;
    const name = `${formName}.${field.name} flag ${flag}`;
    if (todos.some((t) => t.area === 'field' && t.name === name)) continue;
    todos.push({ area: 'field', name, reason: `Field ${field.name} requests a live character counter; the generated field does not show one.`, manualStep: `Add a live character counter for ${field.name} by hand — this is not generated.` });
  }

  if (widget === 'lookup') ui.matrixId = 'lookup-single';
  if (widget === 'lookup-multi') ui.matrixId = 'lookup-multi';
  if (widget === 'users') ui.matrixId = 'users';
  if (widget === 'multiselect' && (token === 'checkbox' || token === 'checkboxes')) ui.matrixId = 'checkbox-multi';
  if (field.lookup && subformToken && !linked) {
    ui.note = 'This grid points at another form. It is a multi lookup, not a second copy of that form.';
  }
  if (field.choices?.length && widget !== 'decision') ui.choices = field.choices;
  if ((widget === 'select' || widget === 'radio') && hasOthersOption(field)) ui.othersOption = true;
  if (field.optionGroups?.length) {
    // A select draws the headers as native `<optgroup>`s (an exact HTML
    // equivalent), so only non-select widgets keep the manual-step todo:
    // radios and checkboxes have no grouping element.
    if (widget === 'select') {
      ui.optionGroups = field.optionGroups.map((group) => ({ label: group.label, choices: [...group.choices] }));
    } else {
      const name = `${formName}.${field.name} option groups`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        const labels = field.optionGroups.map((group) => group.label).join(', ');
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} groups its options under ${labels} in \`values\`; the generated ${widget} control has no grouping element, so every option lists flat.`,
          manualStep: `Recreate ${field.name}'s option groups (${labels}) by hand — this is not generated.`,
        });
      }
    }
  }
  recordPrivacyFlags(formName, field, todos);
  if (widget === 'address') {
    const captureCoordinates = prop(field, 'capture_coordinates');
    if (captureCoordinates?.trim().toLowerCase() === 'true') {
      ui.captureCoordinates = true;
    }
  }
  if (widget === 'image') {
    const enableProp = prop(field, 'enable');
    if (enableProp !== undefined) {
      const tokens = enableProp.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean);
      if (tokens.includes('link')) ui.imageLink = true;
      if (tokens.includes('title')) ui.imageTitle = true;
      if (ui.imageLink) {
        const base = `${field.name}_link`;
        let name = base; let i = 2;
        while (claimed?.has(name)) name = `${base}_${i++}`;
        ui.imageLinkColumn = name;
        claimed?.add(name);
      }
      if (ui.imageTitle) {
        const base = `${field.name}_title`;
        let name = base; let i = 2;
        while (claimed?.has(name)) name = `${base}_${i++}`;
        ui.imageTitleColumn = name;
        claimed?.add(name);
      }
    }
    const target = prop(field, 'target');
    if (target !== undefined) {
      const mapped = ui.imageLink ? IMAGE_LINK_TARGETS[target.trim().toLowerCase().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ')] : undefined;
      if (mapped) {
        ui.linkTarget = mapped;
      } else {
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
    const previewDuration = prop(field, PREVIEW_DURATION_PROPERTY_KEY);
    if (previewDuration !== undefined && previewDuration.trim() !== '0') {
      const name = `${formName}.${field.name} property ${PREVIEW_DURATION_PROPERTY_KEY}`;
      const recordStep = (reason: string, manualStep: string) => {
        if (!todos.some((t) => t.area === 'field' && t.name === name)) {
          todos.push({ area: 'field', name, reason, manualStep });
        }
      };
      if (widget === 'image') {
        // Generated: the picker shows the captured/picked photo and
        // auto-confirms after this many seconds (ui.previewDuration below,
        // rendered by client-runtime.js showCapturePreview).
        // Creator accepts seconds, including fractional values, which carry
        // through as-is. Zero means "leave the preview visible" and is the
        // generated default (default-equivalence.ts). Values past the
        // runtime's 60-second safety cap are clamped and the difference is a
        // counted manual note. Any other text is invalid: it never reaches
        // generated HTML and is recorded as a manual step instead.
        const seconds = Number(previewDuration);
        if (Number.isFinite(seconds) && seconds > 0) {
          ui.previewDuration = Math.min(seconds, 60);
          if (seconds > 60) {
            recordStep(
              `Field ${field.name} sets \`preview duration = ${previewDuration}\`; the generated capture preview auto-dismisses at the 60-second safety cap, not the requested value.`,
              `Raise the auto-dismiss timer for ${field.name} to ${previewDuration}s by hand if the longer preview is required, or accept the generated 60s cap — the cap is generated, the excess is not.`,
            );
          }
        } else {
          recordStep(
            `Field ${field.name} sets \`preview duration = ${previewDuration}\`, which is not a positive number of seconds; the generated image field emits no auto-dismiss preview timer for it.`,
            `Decide the auto-dismiss delay for ${field.name} by hand — the declared value \`${previewDuration}\` is invalid and is not generated.`,
          );
        }
      } else {
        // A scan-capable field is a text input marked for scanning — it has
        // no photo to preview, so the setting stays a manual step.
        recordStep(
          `Field ${field.name} sets \`preview duration = ${previewDuration}\`; the generated scan field has no capture preview to auto-dismiss.`,
          `Add an auto-dismiss timer of ${previewDuration}s after a scan, or leave confirmation to the user, per your policy — this is not generated.`,
        );
      }
    }
  }
  // Image file inputs prove `camera = primary`, `switch camera = true`, and
  // `show gallery = true` by what the device picker already does
  // (default-equivalence.ts). A scan field is a text or number input marked
  // data-scan: it does not open a camera, so the same values are a manual step.
  if (ui.scan && widget !== 'image') {
    const named = (key: string) => field.properties.find((p) => p.key.trim().toLowerCase().replace(/\s+/g, ' ') === key);
    const camera = named('camera');
    if (camera !== undefined && unquote(camera.value).trim() !== '') {
      const value = unquote(camera.value).trim();
      const name = `${formName}.${field.name} property ${camera.key}`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} sets \`camera = ${value}\`; the generated scan field is a text input marked for scanning and does not choose a camera lens.`,
          manualStep: `Choose the ${value} camera when ${field.name} scans, by hand — the generated field does not open a camera or select a lens.`,
        });
      }
    }
    const showGallery = named('show gallery');
    if (showGallery !== undefined && unquote(showGallery.value).trim().toLowerCase() === 'true') {
      const name = `${formName}.${field.name} property ${showGallery.key}`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} sets \`show gallery = true\`; the generated scan field cannot read a code from a photo in the gallery.`,
          manualStep: `Let ${field.name} scan a code from a saved photo, by hand — the generated field has no gallery picker.`,
        });
      }
    }
  }
  if (widget === 'image') {
    const annotation = prop(field, ANNOTATION_PROPERTY_KEY);
    if (annotation?.trim().toLowerCase() === 'true') {
      const name = `${formName}.${field.name} property ${ANNOTATION_PROPERTY_KEY}`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} sets \`annotation = true\`; the generated image field accepts the chosen file unchanged, with no tool to draw or mark it up first.`,
          manualStep: `Add a way to draw or mark up the photo for ${field.name} before it is stored, by hand — this is not generated.`,
        });
      }
    }
    const ratio = prop(field, ASPECT_RATIO_PROPERTY_KEY);
    if (ratio !== undefined && ratio.trim().toLowerCase() !== 'original') {
      const name = `${formName}.${field.name} property ${ASPECT_RATIO_PROPERTY_KEY}`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} sets \`aspect ratio = ${ratio}\`; the generated image field uploads the chosen file unchanged and has no crop step.`,
          manualStep: `Crop ${field.name} uploads to the ${ratio} aspect ratio by hand (a client-side crop step before upload, or a server-side resize), or accept the original proportions — this is not generated.`,
        });
      }
    }
  }
  if (!field.lookup && (widget === 'select' || widget === 'radio')) {
    const displayformat = prop(field, DISPLAYFORMAT_PROPERTY_KEY);
    if (displayformat !== undefined) {
      const name = `${formName}.${field.name} property ${DISPLAYFORMAT_PROPERTY_KEY}`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} sets \`displayformat = ${displayformat}\` with no in-app \`values\` lookup; the generated field has no record to read that format from.`,
          manualStep: `Format ${field.name}'s options as \`${displayformat}\` by hand once its option source is wired up — this is not generated.`,
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
          reason: `Field ${field.name} is flagged \`bidirectional = ${back || biProp.value}\`; Catalyst only creates the reverse column from a linked grid side or a partner field that looks back and names this field, and neither ${field.name} nor ${target ? `${target}.${back || biProp.value}` : 'its target'} is one.`,
          manualStep: `In the Catalyst console, if the two records should look each other up, add a grid field on one side pointing back at the other, or wire the lookup by hand — this reverse reference is not generated.`,
        });
      }
    }
  }
  if (widget === 'date' || widget === 'datetime') {
    const allowedDays = prop(field, 'alloweddays');
    if (allowedDays !== undefined && !isEveryWeekday(allowedDays)) {
      const parsedDays = allowedDays.split(',').map((day) => Number(day.trim()));
      const validDays = parsedDays.length === new Set(parsedDays).size && parsedDays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6);
      if (validDays) ui.allowedDays = parsedDays;
      const name = `${formName}.${field.name} property alloweddays`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: validDays
            ? `Field ${field.name} restricts selectable weekdays to \`${allowedDays}\`; the generated client validates this, but the generated server write path does not re-check it.`
            : `Field ${field.name} has malformed or duplicate allowed weekdays \`${allowedDays}\`; the generated field cannot safely prove this restriction.`,
          manualStep: validDays
            ? `Add server-side validation so ${field.name} only accepts the Creator-allowed days (\`${allowedDays}\`); only client-side validation is generated.`
            : `Correct the malformed or duplicate Creator allowed weekdays (\`${allowedDays}\`) and add client/server validation before accepting writes.`,
        });
      }
    }
  }
  if (widget === 'datetime') {
    const timeDisplay = prop(field, 'timedisplayoptions');
    if (timeDisplay !== undefined && (timeDisplay.toLowerCase() === 'hh:mm:ss' || /ss/i.test(timeDisplay))) {
      ui.timeStep = 1;
      ui.showSeconds = true;
    }
  } else if (widget === 'time') {
    const timeDisplay = prop(field, 'timedisplayoptions');
    if (timeDisplay !== undefined && /ss/i.test(timeDisplay)) {
      const name = `${formName}.${field.name} property timedisplayoptions`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} sets \`timedisplayoptions = ${timeDisplay}\`; the generated ${widget} input has no seconds step and never shows seconds.`,
          manualStep: `Add a seconds-precision time control for ${field.name} by hand (the native ${widget} input shows only hours and minutes) — this is not generated.`,
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
  // A field bound to a live third-party connection (`datasource = <conn>_<module>`,
  // no in-app `field.lookup`) that also sets `displayformat` names the parent
  // field the picker should show, same as an in-app lookup. The generated field
  // has no connection binding at all, so this setting is never carried either —
  // record it as its own manual step rather than let it ride along silently
  // beside the datasource step.
  if (!field.lookup && prop(field, 'datasource') !== undefined && prop(field, 'displayformat') !== undefined) {
    const name = `${formName}.${field.name} property displayformat`;
    if (!todos.some((t) => t.area === 'field' && t.name === name)) {
      todos.push({
        area: 'field',
        name,
        reason: `Field ${field.name} sets \`displayformat\` on a connection-bound field; the generated field has no live connection binding to show that parent field from.`,
        manualStep: `Show the chosen display field for the connected record on ${field.name} by hand once the connection binding itself is rebuilt — this is not generated.`,
      });
    }
  }
  const max = intProp(field, ['maxchar', 'max char', 'max length']);
  const min = intProp(field, ['minchar', 'min char', 'min length']);
  if (min) ui.minLength = min;
  if (widget === 'text' || widget === 'email' || widget === 'phone') ui.maxLength = max ?? 255;
  else if (widget === 'textarea' || widget === 'richtext') ui.maxLength = max ?? 10_000;
  else if (widget === 'url') ui.maxLength = max;
  else if (max) ui.maxLength = max;
  // min/max char is a Creator field-validation setting, not a Data Store column
  // limit: nothing in the generated function re-checks it, so a direct API
  // call (or a tampered client) can write a value the browser would refuse.
  if (min || max) {
    ui.note = [ui.note, 'Length limit is checked in the browser only. The server does not re-check it.'].filter(Boolean).join(' ');
  }
  if (widget === 'url' && wantsLinkName(field)) ui.linkName = true;
  const pattern = patternOf(field);
  if (pattern.bad) {
    ui.todo = 'Field regex did not compile; the pattern was not copied.';
    todos.push({ area: 'field', name: `${formName}.${field.name}`, reason: ui.todo });
  } else if (pattern.value) {
    ui.pattern = pattern.value;
    // Same gap as min/max char: the regex is Creator's validation rule, not a
    // generated check. Only the browser enforces it.
    ui.note = [ui.note, 'Pattern is checked in the browser only. The server does not re-check it.'].filter(Boolean).join(' ');
  }
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
    if (widget === 'file' && depth === 0) {
      const count = intProp(field, ['file count']);
      if (count !== undefined && count !== 1) {
        const name = `${formName}.${field.name} property file count`;
        if (!todos.some((t) => t.area === 'field' && t.name === name)) {
          todos.push({
            area: 'field',
            name,
            reason: `Field ${field.name} sets \`file count = ${count}\`; the generated input has no \`multiple\` attribute and accepts one file per upload.`,
            manualStep: `Add repeat-upload controls so ${field.name} can hold up to ${count} files, or keep it to one file per upload — this is not generated.`,
          });
        }
      }
    }
    ui.accept = widget === 'image' || widget === 'signature' ? 'image/*' : widget === 'audio' ? 'audio/*' : widget === 'video' ? 'video/*' : undefined;
    ui.note =
      widget === 'signature'
        ? 'A signature pad uploads the drawn strokes as JSON. The dry-run function does not write to Stratus.'
        : 'The column stores a Stratus object key. The dry-run upload does not write bytes.';
    if (widget === 'audio') {
      const duration = prop(field, AUDIO_DURATION_PROPERTY_KEY);
      if (duration !== undefined) {
        const name = `${formName}.${field.name} property ${AUDIO_DURATION_PROPERTY_KEY}`;
        if (!todos.some((t) => t.area === 'field' && t.name === name)) {
          todos.push({
            area: 'field',
            name,
            reason: `Field ${field.name} sets \`duration = ${duration}\`; the generated audio recorder enforces no maximum recording length.`,
            manualStep: `Enforce the ${duration}-second recording limit in the client (stop or trim the recorder) or accept longer recordings, per your policy — this is not generated.`,
          });
        }
      }
    }
  }
  if (widget === 'zia') ui.note = 'Filled after submit. The form shows the stored text; it does not call Zia.';
  if (widget === 'formula' || widget === 'autonumber' || widget === 'barcode') ui.note = 'Computed. The form shows it and does not accept a typed value.';
  if (widget === 'barcode') {
    const codeValue = prop(field, BARCODE_VALUE_PROPERTY_KEY);
    if (codeValue !== undefined) {
      const name = `${formName}.${field.name} property ${BARCODE_VALUE_PROPERTY_KEY}`;
      if (!todos.some((t) => t.area === 'field' && t.name === name)) {
        todos.push({
          area: 'field',
          name,
          reason: `Field ${field.name} sets \`value = ${codeValue}\`; the generated barcode/QR field has no computed-value template — it displays no payload of its own.`,
          manualStep: `Compute ${field.name}'s code payload by hand (the Creator \`value\` expression: static text plus other field references), e.g. in a function trigger that writes the column before the field is shown — this is not generated.`,
        });
      }
    }
  }
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
    if (prop(field, 'adjust_using_map')?.trim().toLowerCase() === 'true') ui.adjustUsingMap = true;
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
      const maxRows = intProp(field, ['maxrow', 'maxrows', 'max row', 'max rows']);
      if (maxRows !== undefined) {
        ui.maxRows = maxRows;
        // The generated grid caps its add control at maxRows and the submit
        // check rejects a longer list; the server function does not re-check
        // the cap, same as min/max char.
        ui.note = `${ui.note} The row cap is checked in the browser only. The server does not re-check it.`;
      } else {
        const rawMaxRow = field.properties.find((p) => /^(maxrow|maxrows|max row|max rows)$/i.test(p.key.trim().toLowerCase()));
        if (rawMaxRow !== undefined) {
          const reason = 'Maximum row count is not carried; the generated subform places no cap on the rows a user can add.';
          ui.note = [ui.note, reason].filter(Boolean).join(' ');
          todos.push({ area: 'field', name: `${formName}.${field.name}`, reason });
        }
      }
    }
    // `auto width = false` asks for each column's declared width; absent or
    // `true` keeps the grid's default of columns sizing themselves to content.
    if (prop(field, 'auto width')?.trim().toLowerCase() === 'false') ui.autoWidth = false;
  }
  if (widget === 'currency' || widget === 'decimal' || widget === 'percent') {
    const rawPlaces = prop(field, 'decimalplace') ?? prop(field, 'decimal places') ?? prop(field, 'decimal digits');
    if (rawPlaces !== undefined) {
      const places = intProp(field, ['decimalplace', 'decimal places', 'decimal digits'], 0);
      if (places !== undefined) {
        ui.decimalPlaces = places;
      } else {
        const rawKey = field.properties.find((p) => /^(decimalplace|decimal places|decimal digits)$/i.test(p.key.trim().toLowerCase()))?.key ?? 'decimalplace';
        const key = rawKey.trim().toLowerCase().replace(/\s+/g, ' ');
        const reason = 'Decimal places setting is not carried; the generated field defaults to two fraction digits.';
        ui.note = [ui.note, reason].filter(Boolean).join(' ');
        todos.push({
          area: 'field',
          name: `${formName}.${field.name} property ${key}`,
          reason,
          manualStep: `Configure the decimal places for ${field.name} in the generated UI, or keep the default of two fraction digits — this is not generated.`,
        });
      }
    }
  }
  if (widget === 'currency') {
    const code = CURRENCY_CODES.has(token) ? token.toUpperCase() : appCurrency(app);
    if (code) ui.currencyCode = code;
  }
  if (widget === 'number' || widget === 'decimal' || widget === 'percent' || widget === 'currency') {
    const format = commaDotWestern(field);
    if (format) {
      ui.format = format;
    } else if (prop(field, 'format') !== undefined) {
      // Creator's numeric `format` can include presentation rules that Catalyst's
      // field model does not expose beyond the recognized `commadotwestern` grouping.
      // Keep the setting visible as a guided TODO so it is never silently discarded.
      const reason = 'The numeric display format is not carried by the generated field model.';
      ui.note = [ui.note, reason].filter(Boolean).join(' ');
      todos.push({
        area: 'field',
        name: `${formName}.${field.name} property format`,
        reason,
        manualStep: `Configure the number or currency display format for ${formName}.${field.name} in the generated UI, then preview a record to confirm it displays correctly.`,
      });
    }
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
    const toolbar = prop(field, 'toolbar')!.trim().toLowerCase();
    if (widget === 'richtext' && toolbar === 'enable') ui.toolbar = true;
    // Without the toolbar the generated rich-text editor is a plain textarea,
    // so Creator's explicit disabled value matches it exactly.
    else if (!['disable', 'disabled', 'false', 'off', 'none'].includes(toolbar)) {
      const reason = 'Toolbar setting is not carried; the generated editor has no toolbar control.';
      ui.note = [ui.note, reason].filter(Boolean).join(' ');
      todos.push({ area: 'field', name: `${formName}.${field.name}`, reason });
    }
  }
  if (prop(field, 'defaultrow') !== undefined) {
    const count = intProp(field, ['defaultrow']);
    if (count !== undefined) {
      ui.defaultRowCount = count;
    } else {
      const reason = 'Default row count is not carried; the generated subform starts with no pre-filled rows.';
      ui.note = [ui.note, reason].filter(Boolean).join(' ');
      todos.push({ area: 'field', name: `${formName}.${field.name}`, reason });
    }
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

function intProp(field: Field, keys: string[], min = 1): number | undefined {
  for (const key of keys) {
    const raw = prop(field, key);
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= min) return n;
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
  // A declared column naming an unrecognized field head stays a silent drop
  // (reportViewColumns fails closed) — correctly so for a typo or a field the
  // export never declared. A handful of heads are real Creator built-ins the
  // generated schema simply has no column for; those are recorded as a manual
  // step instead of staying silent. Record_Status is the exception: on a form
  // a state machine governs it reads the machine status column, so it is a
  // manual step only where the schema keeps no status column.
  for (const column of report.columns) {
    if (knownColumnHead(form, column.field) || !UNSUPPORTED_RECORD_COLUMNS.has(column.field)) continue;
    if (recordStatusColumn(app, form)) continue;
    const name = `${report.name} column ${column.field}`;
    if (!todos.some((t) => t.area === 'report' && t.name === name)) {
      todos.push({
        area: 'report',
        name,
        reason: `Report "${report.name}" lists column ${column.field}, a Creator built-in record column; the generated schema has no column for it.`,
        manualStep: `Add a column — or a manual note — standing in for ${column.field} on report ${report.name}, by hand; Catalyst generates no equivalent.`,
      });
    }
  }
  const groupBy = report.groupBy.map((item) => ({ field: item.field }));
  let status: 'generated' | 'todo' = view === 'todo' ? 'todo' : 'generated';
  let todo: string | undefined;
  const options = reportOptions(report);
  // Report-level permissions are enforced by the generated report surface.
  // Creator exports this as `permission = { add = ..., edit = ... }`.
  const permissionBlock = report.blocks.find((block) => block.name.trim().toLowerCase() === 'permission');
  const reportPermission = new Map((permissionBlock?.properties ?? []).map((property) => [
    property.key.trim().toLowerCase(), property.value.trim().toLowerCase() === 'true',
  ]));
  // Only `options` has a model home (reportOptions above, optionProved in the
  // quality audit). Any other named settings block the Creator export
  // carries — e.g. a native `filters`, `sorting` or `grouping` block, or one
  // of Creator's other per-report settings groups — has none, so it is
  // recorded as a manual step rather than silently discarded. A block with no
  // properties, items, or nested blocks configures nothing (the export emits
  // some, like an empty `customlayouts`, regardless) and is skipped.
  for (const block of report.blocks) {
    const blockName = block.name.trim().toLowerCase();
    if (blockName === 'options') continue;
    if (!block.properties.length && !block.blocks.length && !block.items.length) continue;
    // A `properties` block nested in `group by` carries `display record count`
    // — the same toggle as `options { record count = enable }` (the kanban
    // board's own overall row count, or the rows-table header elsewhere),
    // proved against showRecordCount. Carried on any view showRecordCount
    // reads; every other property in the block still is a manual step.
    const uncarried =
      blockName === 'properties' && (DENSITY_VIEWS.has(view) || view === 'kanban')
        ? block.properties.filter((property) => property.key.trim().toLowerCase().replace(/\s+/g, ' ') !== 'display record count')
        : blockName === 'toolbar'
          ? block.properties.filter((property) => {
              const key = property.key.trim().toLowerCase().replace(/\s+/g, ' ');
              // The generated report chrome draws no export button and no add
              // button; an explicit Creator false for either is therefore
              // faithfully represented by its absence.
              if (property.value.trim().toLowerCase() !== 'false') return true;
              return key !== 'show export' && key !== 'show add button';
            })
          : blockName === 'permission'
            ? block.properties.filter((property) => !['edit', 'add'].includes(property.key.trim().toLowerCase()))
            : block.properties;
    if (!uncarried.length && !block.blocks.length && !block.items.length) continue;
    const settings = reportBlockSettings({ ...block, properties: uncarried });
    todos.push({
      area: 'report',
      name: `${report.name} block ${block.name}`,
      reason: `Report "${report.name}" has a \`${block.name}\` settings block (${settings}) that Catalyst generates no equivalent for.`,
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
  let displayType: string | undefined;
  let sortOrder: 'ascending' | 'descending' | undefined;
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
      // `display type = day` is the generated default (lanes already group by the
      // day part of the start date); `= week` buckets by the week's Monday instead.
      // Both are carried as the explicit setting, not just the week case.
      const dt = options.get('display type')?.toLowerCase();
      if (view === 'calendar' && (dt === 'week' || dt === 'day')) displayType = dt;
      titleField = displayField && formField(form, displayField) ? displayField : columns[0]?.field;
    }
  }
  if (view === 'kanban' && status === 'generated') {
    titleField = columns.find((column) => column.field !== groupField)?.field ?? groupField;
    // Creator's kanban `sort order` ("Sort Columns By") orders the board's lane
    // columns themselves (alphabetical ascending/descending), not the cards
    // inside a lane; the generated board otherwise keeps lanes in first-seen order.
    const so = options.get('sort order')?.toLowerCase();
    if (so === 'ascending' || so === 'descending') sortOrder = so;
  }
  let note: string | undefined;
  if (view === 'map' && !hasLatLong(form)) {
    // No address column to plot; the rows, criteria, filters, grouping and
    // columns are unchanged. Only the pin map drops, so the list is faithful.
    view = 'list';
    note = 'Shown as a list: the source map has no address field to plot.';
    todos.push({
      area: 'report',
      name: report.name,
      reason: `Map report ${report.name} is shown as a list because ${report.form || 'the report form'} has no address field to plot.`,
      manualStep: `Add an address field to ${report.form || 'the report form'}, populate its latitude and longitude for the records to plot, then set the display field of ${report.name} to that address field and regenerate the app. Verify the generated map pins against the source records before cutover, or explicitly accept the list view.`,
    });
  }
  let mapField: string | undefined;
  let mapRadius: number | undefined;
  if (view === 'map' && status === 'generated') {
    // Creator writes the pin field as `options { display field = Address }`.
    // A name that is not on the form is ignored, not invented — same as kanban.
    if (displayField && formField(form, displayField)) mapField = displayField;
    mapRadius = reportRadiusOption(options.get('radius'));
  }
  if (view === 'pivot' && !groupBy.length) {
    // The export never carries the pivot's row, column and measure shelves,
    // so the underlying rows render as a list and the pivot stays manual.
    view = 'list';
    note = `Shown as a list: ${report.name} has no exported pivot shelves; rebuild it on this report using one row field, one column field, and a count or sum measure from ${report.form || 'the report form'} (${columns.map((column) => column.field).join(', ') || 'no exported columns'}).`;
  }
  if (view === 'chart' && status === 'generated' && reportProperty(report, 'allow drilldown and view underlying data') === 'true') {
    // The export only says drilldown was allowed in Creator; it carries no
    // target view or filter to open. The generated chart draws bars with no
    // click handler, so clicking a segment must be wired up by hand.
    todos.push({
      area: 'report',
      name: report.name,
      reason: `Clicking a chart segment to view its underlying records is not generated: wire up a click handler that filters ${report.form || 'the report form'} to the clicked category manually.`,
    });
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
    todo = [todo, `Filter not migrated on report "${report.name}": manually translate the source criterion for ${report.form || 'the report form'} in the new app; until then this report returns no rows.`].filter(Boolean).join(' ');
    // zoho.adminuserid is the application owner's email; the generated app
    // is not configured with one, so the comparison is left to the developer.
    if (report.criteria && /\bzoho\.adminuserid\b/i.test(report.criteria)) {
      todo += ' It compares with zoho.adminuserid (the application owner email), which the migrated app does not know: replace it with the owner address, or with zoho.loginuserid if the report is meant for the signed-in user.';
    }
    if (report.criteria) todo += criteriaReadGuidance(report.criteria);
  }
  for (const filter of report.filters) {
    if (filter.criteria?.trim() && criteriaHasTodo(reportCriteria(filter.criteria, app.functions))) {
      todos.push({ area: 'report', name: report.name, reason: `Named filter "${filter.label ?? ''}" on report "${report.name}" is not migrated: manually translate its source criterion for ${report.form || 'the report form'} in the new app; selecting it returns no rows.` });
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
    const confirm = actionConfirm(action);
    // A dispatchable action that still contains an openUrl actionNavigation
    // could not turn into a static link (typically a guard read ahead of a
    // conditional navigation) runs its server logic but silently drops the
    // navigation — the button reports success and never takes the user
    // anywhere. Keep the working dispatch; just name the gap.
    if (dispatch && actionDropsOpenUrl(app, action.workflow)) {
      todos.push({
        area: 'report',
        name: report.name,
        reason: `Custom action "${action.name.trim()}" on report "${report.name}" runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.`,
        manualStep: `Wire the missing navigation for action "${action.name.trim()}" on report "${report.name}" by hand in the generated UI.`,
      });
    }
    return {
      name: action.name,
      ...(action.workflow ? { workflow: action.workflow } : {}),
      endpoint: `/reports/${encodeURIComponent(report.name)}/actions/${slug(action.name)}`,
      ...(reportProp(action.properties, 'show action in view header') === 'true' ? { header: true as const } : {}),
      ...(confirm ? { confirm } : {}),
      ...(action.flags.some((flag) => /execute action for collection of records/i.test(flag)) ? { collection: true as const } : {}),
      ...(nav ? { navigate: nav } : dispatch ? {} : { preview: true as const }),
    };
  });
  for (const action of actions) {
    if (!action.preview) continue;
    // Keep unsupported actions visible in the migration report with the same
    // typed reason used by server-snippet guidance.  This is deliberately
    // conservative: until the workflow is proven to be a generated function
    // or a safe own-app navigation, its semantics are untranslated.
    const workflow = action.workflow ? app.functions.find((fn) => fn.name.toLowerCase() === action.workflow!.toLowerCase()) : undefined;
    const source = workflow ? actionReasonSource(app, workflow) : '';
    const detail = /\bopenUrl\s*\(\s*["'](?:https?:|javascript:|data:)/i.test(source)
      ? ' It opens an external URL, which Catalyst does not migrate as an action navigation; add a reviewed allowlisted link manually.'
      : /\b(integration\s+task|invokeUrl|invokeurl)\b/i.test(source)
        ? ' It calls an integration task, which Catalyst cannot execute from this report action; configure the integration and wire a Catalyst function manually.'
        : '';
    todos.push({
      area: 'report',
      name: report.name,
      reason: `Custom action "${action.name.trim()}" is not migrated; its button is turned off.${detail}`,
      manualReasons: ['untranslated'],
      manualStep: `Reimplement custom action "${action.name.trim()}" on report "${report.name}" by hand: rebuild it as a generated record or collection workflow, or add a Catalyst function and wire that report button to the function; verify its result on a test record before enabling the button, or confirm the action is no longer needed.`,
    });
  }
  const builtColumns: UiReport['columns'] = columns.map((column) => ({
    ...column,
    ...lookupOf(form, column.field),
    ...(numericColumn(form, column.field) ? { numeric: true as const } : {}),
    ...numberColumnFormat(form, column.field),
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
  // `group by`'s nested `properties { display record count = true }` and a
  // top-level `report properties { display record count = true }` block are
  // the same toggle written other ways.
  const groupProperties = report.blocks
    .filter((block) => block.name.trim().toLowerCase() === 'properties')
    .flatMap((block) => block.properties);
  const displayRecordCount = groupProperties.some(
    (property) =>
      property.key.trim().toLowerCase().replace(/\s+/g, ' ') === 'display record count' &&
      unquote(property.value).trim().toLowerCase() === 'true',
  );
  // A kanban lane header already shows its own row count regardless of this
  // flag; `record count = enable` additionally carries as the board's overall
  // row count, the same toggle a list/summary/etc. report's rows table uses.
  const showRecordCount =
    status === 'generated' &&
    (DENSITY_VIEWS.has(view) || view === 'kanban') &&
    (options.get('record count')?.toLowerCase() === 'enable' ||
      displayRecordCount ||
      reportProperty(report, 'display record count') === 'true');
  // `display field` names the record's display column: carried for a form
  // field, a stored record column, or Creator's geo-stamp system columns
  // (`Added_Location`/`Modified_Location`). The generated schema stores no
  // payload column for the geo stamps, but the option is a pointer and the
  // name is a real reference — carried as a name, the same way a detail
  // block emits it. An unknown name stays a counted manual step.
  const displayFieldForList =
    status === 'generated' && DENSITY_VIEWS.has(view) && displayField && knownDisplayFieldName(form, displayField)
      ? displayField
      : undefined;
  // An `options` property this view never reads (a timeline's `week start
  // day`, a map's unknown `display field`, ...) has no generated home —
  // mirrors optionProved in the quality audit. Recorded as a manual step so
  // it is counted, not silently dropped.
  if (status === 'generated' && options.size) {
    const proved = (key: string, value: string): boolean => {
      if (key === 'display field') return value === groupField || value === titleField || value === mapField || value === displayFieldForList;
      if (key === 'start date') return value === startField;
      if (key === 'end date') return value === endField;
      if (key === 'display rows') return pageSize === reportPageSizeOption(value);
      if (key === 'display records per row') return recordsPerRow === recordsPerRowOption(value);
      if (key === 'label width') return labelWidth !== undefined && labelWidth === labelWidthOption(value);
      if (key === 'record count') return (value.toLowerCase() === 'enable') === (showRecordCount === true);
      if (key === 'radius') return mapRadius === reportRadiusOption(value);
      if (key === 'display type') return view === 'calendar' && (value.toLowerCase() === 'week' || value.toLowerCase() === 'day') && displayType === value.toLowerCase();
      if (key === 'sort order') return view === 'kanban' && (value.toLowerCase() === 'ascending' || value.toLowerCase() === 'descending') && sortOrder === value.toLowerCase();
      return false;
    };
    const unproven = [...options].filter(([key, value]) => !proved(key, value));
    if (unproven.length) {
      const settings = unproven.map(([key, value]) => `${key} = ${value}`).join(', ');
      todos.push({
        area: 'report',
        name: `${report.name} block options`,
        reason: `Report "${report.name}" has an \`options\` setting (${settings}) that Catalyst does not carry into the generated ${view} report.`,
        manualStep: `In the Catalyst console, apply the \`options\` setting by hand on report ${report.name}: ${settings}.`,
      });
    }
  }
  // The generated endpoint can order only by a plain column of this form.
  // Related/lookup paths (for example `Author.Name`) are accepted by the
  // Creator parser but otherwise disappear from the generated query.
  const isPlainColumn = (field: string): boolean => Boolean(formField(form, field) || RECORD_COLUMNS.has(field));
  const sortField = report.sortBy.find((item) => item.field !== 'ROWID' && item.field !== 'ID' && !isPlainColumn(item.field))?.field;
  if (sortField && sortField !== 'ROWID' && sortField !== 'ID' && !isPlainColumn(sortField)) {
    todos.push({
      area: 'report',
      name: report.name,
      reason: `Sort by "${sortField}" is not migrated; the field is not a plain column of ${report.form || 'the report form'}, so rows render in default (ROWID) order.`,
      manualStep: `On report ${report.name}, replace the related-field sort "${sortField}" with a plain ${report.form || 'form'} column, or add an equivalent server query and client ordering before cutover; then verify the first and last rows against Creator.`,
    });
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
    ...(displayType ? { displayType } : {}),
    ...(sortOrder ? { sortOrder } : {}),
    ...(titleField ? { titleField } : {}),
    ...(mapField ? { mapField } : {}),
    ...(displayFieldForList ? { displayField: displayFieldForList } : {}),
    ...(mapRadius !== undefined ? { mapRadius } : {}),
    pageSize,
    ...(recordsPerRow !== undefined ? { recordsPerRow } : {}),
    ...(labelWidth ? { labelWidth } : {}),
    ...(showRecordCount ? { showRecordCount: true } : {}),
    queryEndpoint: `/reports/${encodeURIComponent(report.name)}`,
    ...(form ? { recordEndpoint: `/forms/${encodeURIComponent(form.name)}/record` } : {}),
    ...(view === 'spreadsheet' ? { editEndpoint: `/reports/${encodeURIComponent(report.name)}/rows` } : {}),
    ...(form ? { rowActions: { add: reportPermission.get('add') === true, edit: reportPermission.get('edit') ?? true, delete: true } } : {}),
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
    criteria: sealRelativeCriteria(conditionalFormatCriteria(format.condition || 'true', app.functions)),
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

/**
 * `confirmation before execution ( message for individual record = "...", confirm
 * button text = "...", cancel button text = "..." )` on the action: the dialog
 * Creator shows before running it. Undefined when the action carries no such block.
 */
function actionConfirm(action: ReportCustomAction): UiAction['confirm'] | undefined {
  const block = action.blocks.find((b) => b.name.trim().toLowerCase() === 'confirmation before execution');
  if (!block) return undefined;
  const message = reportProp(block.properties, 'message for individual record') ?? reportProp(block.properties, 'message');
  if (!message) return undefined;
  const confirmLabel = reportProp(block.properties, 'confirm button text');
  const cancelLabel = reportProp(block.properties, 'cancel button text');
  return { message, ...(confirmLabel ? { confirmLabel } : {}), ...(cancelLabel ? { cancelLabel } : {}) };
}

/** `display rows = N` in a report `options` block: the Creator page size, carried as `UiReport.pageSize` (never above the ZCQL page cap). */
export function reportPageSizeOption(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n >= 1 && n <= LIMITS.zcqlRowsPerQuery ? n : undefined;
}

/** `radius = N` in a map report `options` block: metres of viewport padding around plotted pins. */
export function reportRadiusOption(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n >= 1 && n <= 1_000_000 ? n : undefined;
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

/** A property from the report's `report properties` block (`records displayed`, `allow export`, ...). */
function reportProperty(report: Report, key: string): string | undefined {
  for (const block of report.blocks) {
    if (block.name.trim().toLowerCase() !== 'report properties') continue;
    const found = block.properties.find((p) => p.key.trim().toLowerCase() === key);
    if (found) return unquote(found.value).trim().toLowerCase();
  }
  return undefined;
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

/**
 * A one-line summary of a report settings block for the manual-step text:
 * `key = value` properties, flag items verbatim, then nested blocks by name.
 * A nested block's `displayname` is quoted in place (its own title); a
 * `content` payload is a layout definition, never summarised inline. The
 * caller only invokes this on a non-empty block.
 */
function reportBlockSettings(block: PropertyBlock): string {
  const parts = block.properties.map((property) => `${property.key.trim()} = ${unquote(property.value).trim()}`);
  for (const item of block.items) parts.push(item);
  for (const nested of block.blocks) {
    const display = nested.properties.find((property) => property.key.trim().toLowerCase() === 'displayname');
    parts.push(display ? `${nested.name} ${display.value.trim()}` : `${nested.name} block`);
  }
  return parts.join(', ') || '(no properties)';
}

function formField(form: Form | undefined, fieldName: string): Field | undefined {
  return form?.fields.find((item) => item.name === fieldName);
}

/**
 * Creator's record geo-stamp columns. The generated schema stores no payload
 * column for them (unlike `RECORD_COLUMNS`), but `display field = <name>` is
 * a field pointer, not a data promise — the name is a real reference and is
 * carried the same way a detail block emits it.
 */
const GEO_RECORD_COLUMNS = new Set(['Added_Location', 'Modified_Location']);

/** A `display field` value that names a real Creator field reference: a form field, a stored record column, or a geo-stamp system column. */
function knownDisplayFieldName(form: Form | undefined, fieldName: string): boolean {
  return !!formField(form, fieldName) || RECORD_COLUMNS.has(fieldName) || GEO_RECORD_COLUMNS.has(fieldName);
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
 * Creator system columns a report may list that the generated schema stores
 * no column for at all — distinct from `RECORD_COLUMNS`, which the schema
 * does store. `Record_Status` is the per-record approval state (Not
 * Applicable / Yet to get Approved / Approved / Rejected); when an approval
 * or blueprint machine governs the report's form the column reads the
 * machine's status column instead (`recordStatusColumn`), so only a form no
 * machine governs stays counted here.
 */
const UNSUPPORTED_RECORD_COLUMNS = new Set(['Record_Status']);

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
  if (!knownColumnHead(form, path)) {
    // Record_Status on a form a state machine governs is the machine status
    // column: the report endpoint fills the cell from it post-projection.
    if (path === 'Record_Status' && recordStatusColumn(app, form)) {
      return [{ field: path, label: column.label || path }];
    }
    return [];
  }
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

/** `format = commadotwestern` is the one number display the generated views group. Any other value is left unset. */
function commaDotWestern(field: Field | undefined): string | undefined {
  const value = field ? prop(field, 'format')?.trim().toLowerCase() : undefined;
  return value === 'commadotwestern' ? 'commadotwestern' : undefined;
}

/** A number column carries `commadotwestern` so the report cell groups its integer digits. */
function numberColumnFormat(form: Form | undefined, fieldName: string): { format?: string } {
  const format = numericColumn(form, fieldName) ? commaDotWestern(formField(form, fieldName)) : undefined;
  return format ? { format } : {};
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
  const styleWhere: string[] = [];
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
      styleWhere.push(...(carried.where ?? carried.dropped.map(() => '')));
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
      const elementName = el.name ?? el.tag;
      todos.push({
        area: 'zml',
        name: `${page.name}.${elementName}`,
        reason: `ZML <${el.tag}> "${elementName}" click parameters "${el.droppedParameters}" are not generated; wire them to the click handler by hand`,
        manualStep: `On page "${page.name}", wire click parameters "${el.droppedParameters}" to the generated <${el.tag}> "${elementName}" click handler.`,
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
        const step = droppedTagStep(page.name, tag);
        todos.push({ area: 'zml', name: `${page.name}.${el.tag}`, reason: droppedTagReason(tag), ...(step ? { manualReasons: ['sanitizer-loss' as const], manualStep: step } : {}) });
      }
    }
    const dropped = el.kind === 'html' && el.html ? droppedStyles(el.html, true) : [];
    if (dropped.length) todos.push({ area: 'zml', name: `${page.name}.${el.tag}`, reason: droppedStyleReason(dropped), manualStep: droppedStyleStep(`On page ${page.name}, the <${el.tag}> element`, dropped) });
  }
  if (styleRules) {
    const lost = droppedStyleRulesTodo(page.name, styleRules, styleDrops, styleWhere);
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
