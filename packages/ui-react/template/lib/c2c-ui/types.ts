/**
 * The app spec the generator writes to src/generated/model.ts. It is the
 * contract between the generator and @c2c/ui: every change that adds a screen
 * kind extends these types and the generator together.
 */

/** Field widgets, one per Creator field type family (see docs/schema-mapping.md). */
export type Widget =
  | 'text' | 'textarea' | 'email' | 'phone' | 'number' | 'decimal' | 'percent' | 'currency'
  | 'date' | 'datetime' | 'time' | 'decision' | 'select' | 'radio' | 'multiselect'
  | 'lookup' | 'lookup-multi' | 'subform' | 'users' | 'file' | 'image' | 'audio' | 'video' | 'signature'
  | 'url' | 'richtext' | 'formula' | 'autonumber' | 'name' | 'address' | 'section' | 'notes'
  | 'barcode' | 'integration' | 'zia' | 'unsupported';

/** A lookup's parent: the form, the display field its options show, and the endpoint that pages them (GET, 300 rows a page). */
export interface LookupSpec {
  form: string;
  display: string;
  endpoint: string;
}

export interface FieldSpec {
  name: string;
  label: string;
  widget: Widget;
  required: boolean;
  readonly: boolean;
  /** False when the generator has no control for this field yet; the field renders a visible placeholder. */
  generated: boolean;
  choices?: string[];
  maxLength?: number;
  pattern?: string;
  /** Fraction digits the field stores at (Creator `decimalplace`), for exact decimal strings. */
  decimalPlaces?: number;
  /** ISO 4217 code the currency widget posts in: the field's own code, else the app's currency. */
  currencyCode?: string;
  accept?: string;
  uploadEndpoint?: string;
  /** Lookup and multi lookup fields (and subform columns). */
  lookup?: LookupSpec;
  /** Composite parts (name, address) and subform columns. */
  subfields?: FieldSpec[];
  /** Section heading shown, or not (an unnamed Creator section). */
  titled?: boolean;
  /** Static text of a notes field. */
  note?: string;
  /** Why a field is not generated yet. */
  todo?: string;
  /** Password/encrypted-typed field: its value never lands in a sign-in draft. */
  secret?: boolean;
}

export interface ButtonSpec {
  name: string;
  label: string;
  type: 'submit' | 'reset' | 'cancel' | 'button';
}

/** One Creator client handler (or field rule) bound to a generated module in src/generated/handlers/. */
export interface HandlerSpec {
  /** The Creator event, e.g. "on load" or "on user input of Total". */
  event: string;
  /** Lifecycle slot: load | input | validate | success | addrow | deleterow. */
  when: string;
  /** For input handlers, the field link name (or Subform.Column) that fires it. */
  field?: string;
  /** Creator record event the workflow ran under (`on add`, `on edit`, `on add or edit`). */
  recordEvent?: string;
  /** Key into the generated handler module registry. */
  module: string;
  /** Paired server endpoint for this event, when one was generated. */
  endpoint?: string;
  /** Server prefetch path the handler's client code may call through the shim. */
  prefetch?: string;
}

export interface FormSpec {
  name: string;
  label: string;
  layout: 'one' | 'two' | 'three';
  fields: FieldSpec[];
  submitEndpoint: string;
  editSubmitEndpoint?: string;
  recordEndpoint: string;
  /** Record delete posted by report row affordances. */
  deleteEndpoint?: string;
  successMessage?: string;
  /** Creator form buttons: the add screen and the edit screen. */
  buttons: { add: ButtonSpec[]; edit: ButtonSpec[] };
  /** Client handlers and field rules for this form (on load / user input / validate / success). */
  handlers?: HandlerSpec[];
  /**
   * Blueprint field settings: per stage and per transition, which fields show
   * and which may change. The record read names the stored stage under
   * `stages` (keyed by `statusColumn`); the server enforces the same rules.
   */
  stageFields?: StageFieldsSpec[];
}

/** Field settings of one stage or one transition's during phase. */
export interface PhaseFieldsSpec {
  visible?: string[];
  hidden?: string[];
  updatable?: string[];
  readonly?: string[];
  mandatory?: string[];
}

/** One blueprint's field settings, keyed by stage and transition name. */
export interface StageFieldsSpec {
  statusColumn: string;
  stages: Record<string, PhaseFieldsSpec>;
  transitions: Record<string, PhaseFieldsSpec>;
}

export interface ColumnSpec {
  field: string;
  label: string;
  /** Shown on the phone record card. */
  phone: boolean;
  /** Number-family column (number, decimal, percent, currency): right-aligned and sorted as a number. */
  numeric?: boolean;
  /** A `column header` custom action: the cell is a per-record button posting here, not a value. */
  action?: string;
}

export interface SortSpec {
  field: string;
  /** `ascending` / `descending`, when the export names one. */
  order?: string;
}

export interface FilterSpec {
  /** A named filter: the label the query posts as `filter`; the criteria stay baked in the report module. */
  label?: string;
  /** A field filter without criteria: selecting it does not narrow the rows. */
  field?: string;
}

export interface ConditionalFormatSpec {
  name: string;
  fields: string[];
  /** The compiled row predicate; `{ op: 'todo' }` where the export did not translate. */
  criteria: unknown;
  format: string;
}

export interface CustomActionSpec {
  name: string;
  endpoint: string;
  /** `show action in view header`: a toolbar button, else a per-record action. */
  header?: boolean;
}

export interface ReportSpec {
  name: string;
  label: string;
  /** list for a table; kanban, calendar, timeline, map, pivot, chart, spreadsheet and summary render a counted stub until they are generated. */
  view: string;
  /** Shown above the records when a map/pivot fell back to the list view. */
  note?: string;
  form?: string;
  queryEndpoint: string;
  pageSize: number;
  columns: ColumnSpec[];
  rowActions: { edit: boolean; delete: boolean };
  customActions: CustomActionSpec[];
  /** Chart reports (view `chart`): what the chart draws. */
  chart?: ChartSpec;
  /** Creator `sort by`, sent as the query's `sort`. */
  sort: SortSpec[];
  /** Creator `filters`: labels posted as the query's `filter`. */
  filters: FilterSpec[];
  /** Creator `group by`, in export order; the list groups by the first. */
  groupBy: { field: string }[];
  /** The lane field (kanban) or the first group-by field. */
  groupField?: string;
  /** A detail layout exists: the first column opens `#/report/<name>/row/<ROWID>`. */
  detail: boolean;
  /** Configured Creator detail view sections, in export order. */
  detailBlocks?: { title: string; relatedField?: string; fields: { field: string; label: string }[] }[];
  /** Kanban card or calendar entry title. */
  titleField?: string;
  /** Calendar and timeline placement columns. */
  startField?: string;
  endField?: string;
  conditionalFormats: ConditionalFormatSpec[];
  /** Single-row read of the report's form, for the detail view. */
  recordEndpoint?: string;
  /** Record delete of the report's form, for the row affordance. */
  deleteEndpoint?: string;
  /** Why the export marked this report todo even though it draws as a table. */
  todo?: string;
}

export interface NavItem {
  kind: 'form' | 'report' | 'page' | 'flow';
  name: string;
  label: string;
  href: string;
}

/** One transition a state machine offers. The server enforces `from`; the client only ever offers transitions whose `from` matches the record's stored stage. */
export interface FlowTransitionSpec {
  /** Button label: the level name for approvals (`level 2`), the transition's display name for blueprints. */
  name: string;
  /** Which generated endpoint serves it: `/flows/<name>/approve|reject|transition`. */
  action: 'approve' | 'reject' | 'transition';
  /** The stage the record must be in for this transition to be offered. */
  from: string;
  /** The stage it lands in; sent as `status` so the server picks this exact target when several share a `from`. */
  to: string;
}

/** An approval or blueprint state machine generated from a Creator workflow. */
export interface FlowSpec {
  kind: 'approval' | 'blueprint';
  /** Workflow name; the generated endpoints are built from it. */
  name: string;
  /** Display label from `as "..."`, or the humanized name. */
  label: string;
  /** Link name of the governed form. */
  form: string;
  /** Data Store column holding the record's current stage. */
  statusColumn: string;
  /** The stage a new record enters. */
  start: string;
  /** Every stage the machine knows, in order: the blueprint's declared stages; for an approval, the pending levels then Approved, Rejected. */
  stages: string[];
  transitions: FlowTransitionSpec[];
  /** The generated flow endpoints (`/flows/<name>/approve`, ...). */
  endpoints: { approve: string; reject: string; transition: string };
  /** Name of the report that lists the governed records, when the app declares one; the approval inbox reads it. */
  report?: string;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export interface AppSpec {
  name: string;
  /** Spec version; the generator bumps it when the shape changes. */
  spec: 1;
  theme: { accent: string; accentInk: string; menu: 'rail' | 'list'; font?: string };
  dateFormat?: string;
  nav: NavSection[];
  /**
   * Screen names a `hide = true` section hides from this profile, minus any
   * also listed in a visible section. The router paints the denied state for
   * a direct-URL visit instead of mounting the screen. Omitted when empty.
   */
  denied?: string[];
  forms: Record<string, FormSpec>;
  reports: Record<string, ReportSpec>;
  /** Creator pages (ZML panels and dashboards), by page name. */
  pages?: Record<string, PageSpec>;
  /** Approval and blueprint state machines, when the Creator app declares them. */
  workflows?: FlowSpec[];
}

/**
 * A row filter the browser applies to report rows before a chart or metric
 * folds them. Only the Creator criteria forms listed here translate; any other
 * clause stays a visible TODO on the element.
 */
export type FilterClause =
  | { field: string; op: 'eq' | 'ne'; value: string | number | boolean }
  | { field: string; op: 'lt' | 'le' | 'gt' | 'ge'; value: number }
  /** Compare with another field of the same row. */
  | { field: string; op: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'; ref: string }
  /** Compare a date with today (`zoho.currentdate`). */
  | { field: string; op: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'; today: true }
  | { field: string; op: 'empty' | 'filled' }
  /** A date in a calendar period: this/last/next day, week, month or year, or the last `count` days. */
  | { field: string; op: 'period'; when: 'this' | 'last' | 'next'; unit: 'day' | 'week' | 'month' | 'year'; count?: number }
  /** Every clause holds (`&&`) or at least one does (`||`). */
  | { op: 'all' | 'any'; of: FilterClause[] };

/** One measure of a chart or metric: `count:<field>`, `sum:<field>`, `value:<field>` in the export. */
export interface MeasureSpec {
  fn: 'count' | 'sum' | 'value';
  field: string;
  label: string;
}

export interface ChartSpec {
  /** `auto` draws a line when most category values are dates, else bars. */
  kind: 'bar' | 'line' | 'donut' | 'auto';
  /** The Creator chart type, such as `Stacked Column`. */
  creatorType?: string;
  title: string;
  /** The report whose query endpoint supplies the rows. */
  report?: string;
  /** Category field (a dotted path for a lookup's field). */
  x: string;
  xLabel: string;
  measures: MeasureSpec[];
  filter: FilterClause[];
  /** How the chart was drawn when the export does not say. */
  notes: string[];
  /** What is not applied or not drawn yet. Rendered as visible TODOs. */
  todos: string[];
}

export interface MetricSpec {
  report?: string;
  fn: 'count' | 'sum';
  field: string;
  filter: FilterClause[];
  /** Text shown after the value, such as `REPORTS`. */
  suffix?: string;
  /** The label this value carried before its panel merged it; shown beside further values of one card. */
  label?: string;
  todos: string[];
}

/** A Creator page element. Layout wrappers stay boxes; a construct with no component is a `todo`. */
export type PageElement =
  | { kind: 'box'; tag: string; width?: string; style?: Record<string, string>; href?: string; children: PageElement[] }
  | { kind: 'text'; text: string; style?: Record<string, string> }
  | { kind: 'icon'; icon: string; style?: Record<string, string> }
  | { kind: 'html'; html: string; links: { label: string; href: string }[] }
  | { kind: 'metric'; label: string; icon?: string; value: MetricSpec; extra: MetricSpec[]; style?: Record<string, string> }
  | { kind: 'chart'; chart: ChartSpec }
  | { kind: 'report'; report: string; label: string }
  | { kind: 'form'; form: string; label: string }
  | { kind: 'link'; label: string; href: string }
  | { kind: 'button'; label: string; href?: string; style?: Record<string, string> }
  | { kind: 'todo'; tag: string; reason: string };

export interface PageSpec {
  name: string;
  label: string;
  elements: PageElement[];
  /** Every TODO on the page, in page order, listed at the top of the page. */
  todos: string[];
}

/** A form record as posted to the submit endpoint. Composite and subform values are nested. */
export type RecordValue = string | boolean | null | string[] | { [key: string]: RecordValue } | { [key: string]: RecordValue }[] | { key: string };
export type FormRecord = Record<string, RecordValue>;
