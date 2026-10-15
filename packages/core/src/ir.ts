/**
 * IR v1: a typed application model derived from the lossless CST.
 *
 * The IR is a *view* over the CST: every node carries the source span it came
 * from, and anything the deriver does not understand at a modelled level is
 * listed in `unknown[]` with its exact span and text. Embedded Deluge is kept
 * as a raw span. The schema is documented in docs/ir-v1.md.
 *
 * The deriver also records, per CST statement, the IR role it was turned into
 * (`roles`). Statements without a role are preserved in the CST only; the
 * corpus harness reports them as the coverage gap (see coverage.ts).
 */

import {
  type Document,
  type Group,
  type Node,
  type Statement,
  type Token,
  headerWords,
  isGroup,
  isStatement,
  isToken,
  sig,
} from './cst.js';
import { parseZml, zmlReferences, type ZmlElement, type ZmlReference } from './zml.js';
import { detectDialect, normaliseDialect, type Dialect } from './dialect.js';

export const IR_VERSION = 1 as const;

export interface Span {
  start: number;
  end: number;
  /** Source file, relative to the project root (multi-file projects only). */
  file?: string;
}

export interface Property {
  key: string;
  /** Value exactly as written (strings keep their quotes). */
  value: string;
  span: Span;
}

/**
 * A settings block made only of properties and nested settings blocks:
 * `customize { font = "x"  logo { placement = left } }`, `options ( ... )`,
 * form `title { ... }`, `print template { ... }`.
 */
export interface PropertyBlock {
  /** Header words, e.g. `customize`, `color options`, `print template`, or a name. */
  name: string;
  properties: Property[];
  blocks: PropertyBlock[];
  /** Bare word statements in the block (flags, field lists), verbatim. */
  items: string[];
  /**
   * Only `api` blocks: statements that are not properties, blocks, or flags,
   * verbatim. An `api`'s actions script calls `thisapp.<fn>(args)` or
   * `<applink>.<fn>(args)` — the generator reads this to learn which custom
   * functions the custom API publishes over HTTP.
   */
  deluge?: RawDeluge[];
  span: Span;
}

export interface Header {
  author?: string;
  generatedOn?: string;
  version?: string;
}

export interface ComponentRef {
  kind: string;
  name: string;
  /** Menu-entry properties (`icon`, `hide`, `layout`, ...), when the entry has a body. */
  properties?: Property[];
}

export interface Section {
  name: string;
  displayName?: string;
  icon?: string;
  hidden: boolean;
  /** Forms, reports and pages declared in (or referenced from) this section, in order. */
  components: ComponentRef[];
  properties: Property[];
  /** Enclosing menu space, for `menu { space X { section Y { ... } } }`. */
  space?: string;
  span: Span;
}

export interface Field {
  name: string;
  type?: string;
  displayName?: string;
  /** Header words before the link name, e.g. `unique`, `must have`. */
  modifiers: string[];
  /** `must have` modifier. */
  required: boolean;
  /** `unique` modifier. */
  unique: boolean;
  /** Choice list from `values = {"a","b"}` (picklist, radio, checkbox, ...), decoded. */
  choices?: string[];
  /** Lookup target from `values = Form.Field` or `values = Form[criteria].Field`, with `displayformat = [...]`. */
  lookup?: { form: string; field?: string; criteria?: string; displayFormat?: string };
  /** `initial value = ...`, verbatim. */
  initialValue?: string;
  properties: Property[];
  /**
   * Nested fields: parts of composite fields (`prefix`, `first_name`, `address_line_1`,
   * `latitude`, ...) and the fields of an inline subform.
   */
  subfields: Field[];
  /** Bracketed attribute groups inside the field: `[ type = tooltip message = "..." ]`. */
  annotations: PropertyBlock[];
  /** Bare word settings inside the field body: `allow new entries`, `enable linkname`, ... */
  flags: string[];
  span: Span;
}

export interface FormButton {
  name: string;
  type?: string;
  displayName?: string;
  properties: Property[];
}

export interface FormAction {
  /** `on add`, `on edit`, ... */
  event: string;
  buttons: FormButton[];
  span: Span;
}

export interface Form {
  name: string;
  displayName?: string;
  section?: string;
  properties: Property[];
  fields: Field[];
  actions: FormAction[];
  /**
   * Form-level settings blocks: `customize`, `title`, `properties`, `print template`,
   * `record summary`, `blueprint components`, `enable payment`, `disable payment`.
   */
  blocks: PropertyBlock[];
  span: Span;
}

export interface ReportColumn {
  /** Field link name; dotted for related fields (`Author.Name`). */
  field: string;
  /** `as "Label"`. */
  label?: string;
  /** Column options: `( displayformat = ..., view = ..., width = ... )`. */
  properties: Property[];
  /** Parts of a composite column: `Name ( first_name as "First" ... )`. */
  subcolumns: ReportColumn[];
  span: Span;
}

export interface ReportCustomAction {
  /** Action label as written (decoded). */
  name: string;
  workflow?: string;
  /** True for a `custom action "x" ( ... )` column in the column list. */
  column: boolean;
  properties: Property[];
  /** Bare word settings: `execute action for collection of records`. */
  flags: string[];
  /** Nested settings: `confirmation before execution ( ... )`. */
  blocks: PropertyBlock[];
  span: Span;
}

export interface ConditionalFormat {
  name: string;
  condition?: string;
  /** `fields = [A,B]`, as written. */
  fields?: string;
  /** CSS-like format string, decoded. */
  format?: string;
  properties: Property[];
  span: Span;
}

export interface ReportDataBlock {
  /** `datablock1`, ... */
  name: string;
  title?: string;
  layoutType?: string;
  /** Detail view related-record blocks: `related field = Sub.Field`. */
  relatedField?: string;
  fields: ReportColumn[];
  properties: Property[];
  span: Span;
}

export interface ReportView {
  kind: 'quickview' | 'detailview';
  /** Device the layout belongs to (`web`, `phone`, `tablet`), when device-specific. */
  device?: string;
  /** `layout ( type = ... )`. */
  layoutType?: string;
  layoutProperties: Property[];
  blocks: ReportDataBlock[];
  /** Menus by placement: `header`, `record`, ... → item names (`Edit`, `View Record`, custom action names). */
  menus: Record<string, string[]>;
  /** Record actions by gesture: `on click`, `on right click`, `on tap`, `on long press`, `on left swipe`, ... */
  actions: Record<string, string[]>;
  properties: Property[];
  span: Span;
}

export interface ReportOrder {
  field: string;
  /** `ascending` / `descending`, when given. */
  order?: string;
}

export interface ReportFilter {
  /** A field filter: `filters ( Status )`. */
  field?: string;
  /** A named filter: `filters ( "Open" : Status == "Open" )`. */
  label?: string;
  criteria?: string;
  span: Span;
}

export interface Report {
  name: string;
  /** The report keyword: `list`, `kanban`, `pivottable`, `summary`, `calendar`, ... */
  type: string;
  /** Header words before the type keyword, e.g. `default`. */
  modifiers: string[];
  displayName?: string;
  /** Form named in `show all rows from <Form>`. */
  form?: string;
  /** Criteria from `show all rows from <Form> [ ... ]`, without the brackets. */
  criteria?: string;
  /** Calendar/timeline date field: `based on <Field>`. */
  basedOn?: string;
  /** Other bare word settings of the report, verbatim. */
  flags: string[];
  section?: string;
  properties: Property[];
  columns: ReportColumn[];
  customActions: ReportCustomAction[];
  conditionalFormats: ConditionalFormat[];
  filters: ReportFilter[];
  groupBy: ReportOrder[];
  sortBy: ReportOrder[];
  /** Other report settings blocks: `options`, `report properties`, `permission`, `group by` properties. */
  blocks: PropertyBlock[];
  /** Quick view and detail view layouts (web and per device). */
  views: ReportView[];
  span: Span;
}

export interface Page {
  name: string;
  displayName?: string;
  section?: string;
  /** The `Content="<zml>..."` value, decoded from its string literal. */
  content?: string;
  /** ZML element tree of `content`. */
  zml: ZmlElement[];
  /** Components (reports, charts, forms, panels, ...) the page refers to. */
  references: ZmlReference[];
  properties: Property[];
  span: Span;
}

export interface RawDeluge {
  /** Source text between the delimiters, verbatim. */
  text: string;
  span: Span;
}

export interface FieldRuleAction {
  /** `show`, `hide`, `enable`, `disable`, ... */
  action: string;
  fields: string[];
}

export interface FieldRule {
  /** `actions ( condition ) { ... }`, when conditional. */
  condition?: string;
  actions: FieldRuleAction[];
  span: Span;
}

export interface BlueprintTransition {
  name: string;
  fromStage?: string;
  toStage?: string;
  properties: Property[];
  /** `before`, `during`, `after` sections: their settings and Deluge. */
  phases: { phase: string; properties: Property[]; blocks: PropertyBlock[]; deluge: RawDeluge[]; span: Span }[];
  span: Span;
}

export interface Workflow {
  name: string;
  label?: string;
  /** Workflow container: `form`, `schedule`, `approval`, ... (from `workflow { <container> { ... } }` or the `type` property). */
  container?: string;
  /** `type = ...` of the workflow definition. */
  type?: string;
  form?: string;
  /** `record event = on add or edit`, ... */
  recordEvent?: string;
  /**
   * Criteria of the enclosing `actions ( … ) { }` block.
   * Bare names are form fields (`Status == "Overdue"`), not locals.
   * Absent when that block has no criteria.
   */
  actionCondition?: string;
  /** The handler: `on validate`, `on load`, `on success`, `on user input of Field`, `on level 1 / on approve`, ... */
  event: string;
  deluge: RawDeluge | null;
  properties: Property[];
  /** Approval workflows: `approvers ( ... )` settings of the enclosing level. */
  approvers?: Property[];
  /** Field rules: `field rules { actions { hide A,B; } }`. */
  fieldRules?: FieldRule[];
  /** Blueprints: stages and transitions. */
  blueprint?: { start?: PropertyBlock; stages: PropertyBlock[]; transitions: BlueprintTransition[] };
  span: Span;
}

export interface FunctionDef {
  name: string;
  label?: string;
  /** `creator`: `Name as "Label" { type = functions ... }`; `deluge`: `ret name(args) { ... }`; `script`: a bare Deluge file. */
  kind: 'creator' | 'deluge' | 'script';
  /** Return type and parameter list for `deluge` functions, verbatim. */
  signature?: string;
  form?: string;
  deluge: RawDeluge[];
  properties: Property[];
  span: Span;
}

export interface Permission {
  /** Name of the enclosing profile/role block, if any. */
  owner?: string;
  value: string;
  span: Span;
}

export interface FieldPermission {
  field: string;
  /** `visibility`, `readonly`, ... as written. */
  flags: Record<string, string>;
  span: Span;
}

export interface ModulePermission {
  /** Form or page link name. */
  component: string;
  /** `enabled`, `allFieldsVisible`, ... */
  properties: Property[];
  /** `ReportPermissions { Report = {"View", ...} }`. */
  reports: Property[];
  fields: FieldPermission[];
  span: Span;
}

export interface Profile {
  name: string;
  /** `Users_Permissions`, `Customer_Portal`, ... */
  type?: string;
  description?: string;
  /** The `permissions = {...}` literal, verbatim. */
  permissions?: string;
  properties: Property[];
  modules: ModulePermission[];
  span: Span;
}

export interface Role {
  name: string;
  description?: string;
  properties: Property[];
  /** Roles reporting to this one. */
  children: Role[];
  span: Span;
}

export interface Translation {
  /** The JSON text, verbatim. */
  json: string;
  /** Parsed JSON, when it parses. */
  data?: unknown;
  span: Span;
}

export interface DeviceComponent {
  /** `form`, `list`, `report`, `page`, `pivotchart`, `custom`, ... */
  kind: string;
  name: string;
  properties: Property[];
  /** Report views not attached to a report of this IR (the report is defined elsewhere). */
  views: ReportView[];
  span: Span;
}

export interface Device {
  device: string;
  customize?: PropertyBlock;
  /** `menu { preference { ... } }`. */
  menuPreference?: PropertyBlock;
  /** Menu sections with their component entries. */
  sections: { name: string; space?: string; properties: Property[]; components: DeviceComponent[]; span: Span }[];
  /** `menu { unused { ... } }`: components left out of the menu. */
  unused: DeviceComponent[];
  /** `forms { form X { label placement = ... } }`: per-device form layout settings. */
  forms: { name: string; properties: Property[]; span: Span }[];
  /** `reports { report X { quickview ( ... ) } }` entries whose report is not in this IR. */
  components: DeviceComponent[];
  span: Span;
}

export interface UnknownNode {
  /** Where it was found: `document`, `application`, `section`, `form`, `workflow`, `functions`. */
  context: string;
  /** First header word, when the construct has one. */
  keyword?: string;
  /** CST statement kind. */
  cstKind: string;
  span: Span;
  text: string;
}

export interface UnmodelledNode {
  context: string;
  /** Header words, lower-cased (`api`, `print template`, ...). */
  keyword: string;
  span: Span;
}

/**
 * A JS widget package under `sidecars/widgets/<name>/`. The package is html
 * and json, not a `.ds`, so it is not a CST statement.
 */
export interface WidgetSidecar {
  /** Directory name, or a name declared by the package manifest. */
  name: string;
  /** Package directory relative to the project, with `/` separators. */
  path: string;
  html: boolean;
  json: boolean;
}

export type Shape = 'A' | 'B' | 'C' | 'deluge' | 'empty' | 'unknown';

export interface App {
  irVersion: typeof IR_VERSION;
  name?: string;
  shape: Shape;
  dialect?: Dialect;
  header?: Header;
  settings: Property[];
  sections: Section[];
  forms: Form[];
  reports: Report[];
  pages: Page[];
  workflows: Workflow[];
  functions: FunctionDef[];
  permissions: Permission[];
  profiles: Profile[];
  roles: Role[];
  /** Other `share_settings` properties (`role Hierarchy = {...}`). */
  shareSettings: Property[];
  translations: Translation[];
  /** Application settings blocks: `customize`, `reports configuration`, `connections`, `datasources`, ... */
  configuration: PropertyBlock[];
  /** Custom APIs: `api <name> { method = ... scope = ... actions ( ... ) }`; `name` is the API name. */
  apis: PropertyBlock[];
  devices: Device[];
  unknown: UnknownNode[];
  /** Recognised blocks whose content is preserved in the CST but not modelled (e.g. `api`). */
  unmodelled: UnmodelledNode[];
  /** Number of CST statements visited at modelled levels (denominator for the unknown rate). */
  statementCount: number;
  /** Source files, for multi-file (shape C) projects. */
  files?: string[];
  /**
   * Widget packages under `sidecars/widgets/`. Omitted when the project has none,
   * so an export that only has `.ds` files keeps the same IR.
   */
  widgets?: WidgetSidecar[];
}

// ---------------------------------------------------------------------------
// helpers

export function unquote(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1).replace(/\\(.)/gs, (_m, c: string) =>
      c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c,
    );
  }
  return s;
}

/**
 * Static Creator initial value as literal text, or undefined. The
 * gallery apps carry only static literals (quoted strings, numbers,
 * percents, times, true/false); anything shaped like a dynamic expression
 * (zoho.loginuser, zoho.currentdate, arithmetic) is left unset, so neither
 * the submit handler nor a table-create default_value ever stores
 * expression source as a cell. A doubled quote inside a quoted literal
 * ('it''s') is one literal quote.
 */
export function staticDefault(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (/^"([^"\\]|\\.|"")*"$/.test(text)) return unquote(text).replace(/""/g, '"');
  if (/^'([^'\\]|\\.|'')*'$/.test(text)) return unquote(text).replace(/''/g, "'");
  if (/^(true|false)$/i.test(text)) return text.toLowerCase();
  if (/^[+-]?[0-9][0-9:.%]*(?:-[0-9:.%]+)*$/.test(text)) return text;
  return undefined;
}

const REPORT_TYPES = new Set([
  'list',
  'kanban',
  'pivottable',
  'pivotchart',
  'summary',
  'calendar',
  'grid',
  'spreadsheet',
  'timeline',
  'map',
  'chart',
  'report',
  'sheet',
  'gantt',
  'custom',
]);

/** Form-level settings blocks, modelled as `Form.blocks`. */
const FORM_BLOCKS = new Set([
  'customize',
  'print template',
  'properties',
  'title',
  'blueprint components',
  'record summary',
  'enable payment',
  'disable payment',
]);

/** Report-level settings blocks, modelled as `Report.blocks`. */
const REPORT_BLOCKS = new Set(['options', 'report properties', 'permission', 'customlayouts']);

/** Application-level settings blocks, modelled as `App.configuration`. */
const CONFIG_BLOCKS = new Set([
  'customize',
  'settings',
  'preference',
  'theme',
  'connections',
  'configuration',
  'reports configuration',
  'datasources',
  'variables',
]);

const DEVICES = new Set(['web', 'phone', 'tablet']);

const EVENT_RE = /^on\b/;

interface Ctx {
  app: App;
  src: string;
  file?: string;
  /** Device a multi-file export file belongs to (`devices/<device>/...`). */
  device?: string;
  /** Statements the deriver turned into IR, with the role they play (coverage metric). */
  roles: Map<Statement, string>;
}

/** Record that statement `s` is represented in the IR as `role`. */
function claim(ctx: Ctx, s: Statement, role: string): void {
  if (!ctx.roles.has(s)) ctx.roles.set(s, role);
}

/** Claim every statement in a subtree (a construct kept whole, e.g. a bare Deluge file). */
function claimAll(ctx: Ctx, s: Statement, role: string): void {
  claim(ctx, s, role);
  for (const c of children(s)) claimAll(ctx, c, role);
}

/** Claim the statements that hold raw Deluge, and the structured statements between them and `s`. */
function claimDeluge(ctx: Ctx, s: Statement): boolean {
  let has = false;
  for (const g of s.children) {
    if (!isGroup(g)) continue;
    if (g.raw) has = true;
    else if (g.structured) for (const c of g.children) if (isStatement(c) && claimDeluge(ctx, c)) has = true;
  }
  if (has) claim(ctx, s, 'deluge');
  return has;
}

function span(ctx: Ctx, n: { start: number; end: number }): Span {
  return ctx.file ? { start: n.start, end: n.end, file: ctx.file } : { start: n.start, end: n.end };
}

function text(ctx: Ctx, n: { start: number; end: number }): string {
  return ctx.src.slice(n.start, n.end);
}

function words(s: Statement): string[] {
  return headerWords(s).map((t) => t.text);
}

function lower(ws: string[]): string[] {
  return ws.map((w) => w.toLowerCase());
}

/** The structured body of a block/call statement (its last structured group). */
function body(s: Statement): Statement[] {
  for (const g of [...s.children].reverse()) {
    if (isGroup(g) && g.structured) return g.children.filter(isStatement);
  }
  return [];
}

/** Statements in every structured group of `s`. */
function children(s: Statement): Statement[] {
  const out: Statement[] = [];
  for (const g of s.children) if (isGroup(g) && g.structured) for (const c of g.children) if (isStatement(c)) out.push(c);
  return out;
}

/** The last structured group of a statement. */
function bodyGroup(s: Statement): Group | undefined {
  for (const g of [...s.children].reverse()) if (isGroup(g) && g.structured) return g;
  return undefined;
}

/** Text between a group's brackets. */
function inside(ctx: Ctx, g: Group): string {
  return ctx.src.slice(g.open.start + g.open.text.length, g.close ? g.close.start : g.end);
}

function property(ctx: Ctx, s: Statement): Property | null {
  const items = sig(s);
  const isSep = (x: Node, t: string) => isToken(x) && x.kind === 'punct' && x.text === t;
  // `key : value` (payment settings, sendmail-like attribute lists) when it holds exactly one pair
  if (s.kind === 'pairs' && items.filter((x) => isSep(x, ':')).length !== 1) return null;
  if (s.kind !== 'property' && s.kind !== 'pairs') return null;
  const eq = items.findIndex((x) => isSep(x, s.kind === 'pairs' ? ':' : '='));
  const keyWords = items.slice(0, eq).map((x) => (x as Token).text);
  let valueItems = items.slice(eq + 1);
  const last = valueItems[valueItems.length - 1];
  if (last && isToken(last) && last.text === ';') valueItems = valueItems.slice(0, -1);
  const value = valueItems.length
    ? ctx.src.slice(nodeStartOf(valueItems[0]), nodeEndOf(valueItems[valueItems.length - 1]))
    : '';
  return { key: keyWords.join(' '), value, span: span(ctx, s) };
}

function nodeStartOf(n: Node): number {
  return isToken(n) ? n.start : n.start;
}
function nodeEndOf(n: Node): number {
  return isToken(n) ? n.start + n.text.length : n.end;
}

/** Properties of a body. With `role`, the property statements are claimed as modelled. */
function props(ctx: Ctx, stmts: Statement[], role?: string): Property[] {
  const out: Property[] = [];
  for (const s of stmts) {
    const p = property(ctx, s);
    if (!p) continue;
    out.push(p);
    if (role) claim(ctx, s, role);
  }
  return out;
}

function prop(ps: Property[], key: string): string | undefined {
  const p = ps.find((x) => x.key.toLowerCase() === key);
  return p ? unquote(p.value) : undefined;
}

/** Name and label from `Name`, `Name as "Label"`, `"Name"`. */
function nameAndLabel(ws: string[]): { name: string; label?: string; rest: string[] } {
  const as = ws.findIndex((w, i) => i > 0 && w.toLowerCase() === 'as');
  if (as > 0 && as === ws.length - 2) {
    return { name: unquote(ws[as - 1]), label: unquote(ws[as + 1]), rest: ws.slice(0, as - 1) };
  }
  return { name: unquote(ws[ws.length - 1] ?? ''), rest: ws.slice(0, -1) };
}

function firstRaw(g: Node[]): Group | null {
  for (const n of g) {
    if (isGroup(n)) {
      if (n.raw) return n;
      const inner = firstRaw(n.children);
      if (inner) return inner;
    } else if (isStatement(n)) {
      const inner = firstRaw(n.children);
      if (inner) return inner;
    }
  }
  return null;
}

function allRaw(g: Node[], out: Group[] = []): Group[] {
  for (const n of g) {
    if (isGroup(n)) {
      if (n.raw) out.push(n);
      else allRaw(n.children, out);
    } else if (isStatement(n)) allRaw(n.children, out);
  }
  return out;
}

function rawDeluge(ctx: Ctx, g: Group): RawDeluge {
  const start = g.open.start + g.open.text.length;
  const end = g.close ? g.close.start : g.end;
  return { text: ctx.src.slice(start, end), span: span(ctx, { start, end }) };
}

/**
 * The Deluge of an event or function section: its raw groups, or, when the
 * body holds none (2016 exports write actions as structured statements), the
 * whole body verbatim.
 */
function sectionDeluge(ctx: Ctx, s: Statement): RawDeluge[] {
  const raws = allRaw(s.children);
  if (raws.length && onlyRawPaths(s)) {
    for (const c of children(s)) claimDeluge(ctx, c);
    return raws.map((g) => rawDeluge(ctx, g));
  }
  const g = bodyGroup(s);
  if (!g || !g.children.some((c) => isStatement(c))) return [];
  for (const c of children(s)) claimAll(ctx, c, 'deluge');
  return [rawDeluge(ctx, g)];
}

/** True when every statement under `s` lies on the way to a raw Deluge group. */
function onlyRawPaths(s: Statement): boolean {
  return children(s).every((c) => allRaw(c.children).length > 0 && (c.children.some((x) => isGroup(x) && x.raw) || onlyRawPaths(c)));
}

function unknown(ctx: Ctx, context: string, s: Statement): void {
  const ws = words(s);
  ctx.app.unknown.push({
    context,
    keyword: ws[0],
    cstKind: s.kind,
    span: span(ctx, s),
    text: text(ctx, s),
  });
}

function isBody(s: Statement): boolean {
  return (s.kind === 'block' || s.kind === 'call') && bodyGroup(s) !== undefined;
}

/** A settings block: properties and nested settings blocks. Other statements stay preserved-only. */
function propertyBlock(ctx: Ctx, s: Statement, role: string): PropertyBlock {
  claim(ctx, s, role);
  const inner = body(s);
  const block: PropertyBlock = {
    name: words(s).map(unquote).join(' '),
    properties: props(ctx, inner, `${role}.property`),
    blocks: inner.filter((c) => isBody(c)).map((c) => propertyBlock(ctx, c, role)),
    items: flags(ctx, inner, `${role}.item`),
    span: span(ctx, s),
  };
  if (role === 'api') {
    // `api <name> { actions ( thisapp.<fn>(args) ) }`: the actions script is
    // Deluge, not properties. Keep each unclaimed statement verbatim so the
    // generator can see which functions the custom API publishes over HTTP.
    for (const c of inner) {
      if (ctx.roles.has(c)) continue;
      claimAll(ctx, c, 'api.deluge');
      (block.deluge ??= []).push({ text: text(ctx, c).trim(), span: span(ctx, c) });
    }
  }
  return block;
}

/** Bare word statements of a body, verbatim (`allow new entries`, `execute action for ...`). */
function flags(ctx: Ctx, stmts: Statement[], role: string): string[] {
  const out: string[] = [];
  for (const c of stmts) {
    if (c.kind !== 'word') continue;
    claim(ctx, c, role);
    out.push(text(ctx, c).trim());
  }
  return out;
}

/** Item names of a list body: `Edit`, `View Record`, `"Custom action"`. */
function itemList(ctx: Ctx, s: Statement, role: string): string[] {
  const out: string[] = [];
  const g = bodyGroup(s) ?? (s.children.find((x) => isGroup(x) && x.raw) as Group | undefined);
  if (g?.raw) {
    // `on click ( View Record )`: the CST keeps `on click (...)` bodies raw (Deluge elsewhere).
    for (const line of inside(ctx, g).split(/\r\n|\n|\r/)) {
      const t = line.trim();
      if (t) out.push(unquote(t));
    }
    return out;
  }
  for (const c of body(s)) {
    if (c.kind !== 'word') continue;
    claim(ctx, c, role);
    out.push(words(c).map(unquote).join(' '));
  }
  return out;
}

// ---------------------------------------------------------------------------
// derivation

type Level = 'document' | 'application' | 'section' | 'form' | 'workflow' | 'functions' | 'menu' | 'container';

function visit(ctx: Ctx, stmts: Statement[], level: Level, sectionName?: string, owner?: string, space?: string): void {
  const app = ctx.app;
  let section: Section | undefined;
  if ((level === 'section' || level === 'menu') && sectionName) section = app.sections.find((x) => x.name === sectionName);
  for (const s of stmts) {
    app.statementCount++;
    collectPermissions(ctx, s, owner);
    if (s.kind === 'property') {
      const p = property(ctx, s)!;
      if (level === 'application' || (level === 'document' && !app.name)) {
        app.settings.push(p);
        claim(ctx, s, `${level}.setting`);
      } else if ((level === 'section' || level === 'menu') && section) claim(ctx, s, 'section.property');
      continue;
    }
    if (s.kind === 'word') continue; // bare words carry no structure at these levels
    if (s.kind === 'unknown') {
      unknown(ctx, level, s);
      continue;
    }
    const ws = words(s);
    const lw = lower(ws);
    const kw = lw[0];
    const inner = body(s);

    if (kw === 'application' && s.kind === 'block') {
      app.name = unquote(ws[1] ?? '');
      claim(ctx, s, 'application');
      visit(ctx, inner, 'application');
      continue;
    }
    if ((kw === 'section' || kw === 'space') && s.kind === 'block' && level !== 'form') {
      const ps = props(ctx, inner);
      const name = unquote(ws[1] ?? '');
      if (kw === 'section') {
        const sec: Section = {
          name,
          displayName: prop(ps, 'displayname'),
          icon: prop(ps, 'icon'),
          hidden: prop(ps, 'hide') === 'true',
          components: [],
          properties: ps,
          ...(space ? { space } : {}),
          span: span(ctx, s),
        };
        app.sections.push(sec);
        claim(ctx, s, 'section');
        visit(ctx, inner, level === 'menu' ? 'menu' : 'section', name);
      } else {
        claim(ctx, s, 'menu.space');
        props(ctx, inner, 'menu.space.property');
        visit(ctx, inner, 'menu', undefined, undefined, name);
      }
      continue;
    }
    if (level === 'menu') {
      // `form X { icon = ... }`, `report Y { ... }` are menu entries, not definitions.
      if (s.kind === 'block' && ws.length === 2 && section) {
        section.components.push({ kind: lw[0], name: ws[1], properties: props(ctx, inner, 'menu.entry.property') });
        claim(ctx, s, 'menu.entry');
      } else if (s.kind === 'block' && kw === 'systemcomponent' && section) {
        const ps = props(ctx, inner, 'menu.entry.property');
        section.components.push({ kind: 'systemcomponent', name: prop(ps, 'type') ?? '', properties: ps });
        claim(ctx, s, 'menu.entry');
      } else if (s.kind === 'block' && kw === 'preference' && ws.length === 1) {
        app.configuration.push(propertyBlock(ctx, s, 'configuration'));
      }
      continue;
    }
    if (DEVICES.has(kw) && ws.length === 1 && s.kind === 'block' && level === 'application') {
      deriveDevice(ctx, s, kw);
      continue;
    }
    if (ctx.device && level === 'document' && s.kind === 'block' && ws.length === 1 && (kw === 'customize' || kw === 'forms')) {
      // Shape C: `devices/<device>/theme.ds`, `devices/<device>/forms.ds`.
      deriveDeviceBody(ctx, device(ctx, ctx.device, s), [s]);
      continue;
    }
    if (kw === 'form' && s.kind === 'block' && ws.length >= 2 && level !== 'workflow') {
      const form = deriveForm(ctx, s, sectionName);
      claim(ctx, s, 'form');
      const existing = app.forms.find((f) => f.name === form.name);
      if (existing && level === 'container' && form.fields.length === 0) existing.properties.push(...form.properties);
      else app.forms.push(form);
      section?.components.push({ kind: 'form', name: form.name });
      continue;
    }
    if ((kw === 'forms' || kw === 'reports' || kw === 'pages') && s.kind === 'block' && ws.length === 1) {
      claim(ctx, s, 'container');
      visit(ctx, inner, 'container', sectionName, owner);
      continue;
    }
    if (kw === 'menu' && s.kind === 'block') {
      claim(ctx, s, 'menu');
      visit(ctx, inner, 'menu');
      continue;
    }
    let reportKw = lw.findIndex((w) => REPORT_TYPES.has(w));
    if (reportKw < 0 && s.kind === 'block' && ws.length >= 2 && showFrom(inner)) reportKw = ws.length - 2;
    if (s.kind === 'block' && reportKw >= 0 && ws.length >= reportKw + 2 && level !== 'workflow' && level !== 'functions' && level !== 'form') {
      const name = ws.slice(reportKw + 1).join('_');
      const report = deriveReport(ctx, s, name, lw[reportKw], lw.slice(0, reportKw), sectionName);
      if (ctx.device) for (const v of report.views) v.device = ctx.device;
      app.reports.push(report);
      section?.components.push({ kind: report.type, name: report.name });
      continue;
    }
    if (kw === 'page' && s.kind === 'block' && ws.length === 2) {
      const ps = props(ctx, inner, 'page.property');
      const content = prop(ps, 'content');
      claim(ctx, s, 'page');
      app.pages.push(page(ctx, ws[1], content, ps, s, sectionName));
      section?.components.push({ kind: 'page', name: ws[1] });
      continue;
    }
    if (kw === 'workflow' && s.kind === 'block' && ws.length === 1) {
      claim(ctx, s, 'workflow');
      for (const c of inner) {
        app.statementCount++;
        const cw = lower(words(c));
        if (c.kind === 'block' && cw.length === 1 && cw[0] === 'functions') {
          claim(ctx, c, 'functions');
          deriveFunctions(ctx, body(c));
        } else if (c.kind === 'block' && cw.length === 1) deriveWorkflowContainer(ctx, c, cw[0]);
        else if (c.kind === 'block' && words(c).length >= 1) deriveWorkflowDef(ctx, c, undefined);
        else if (c.kind !== 'property' && c.kind !== 'word') unknown(ctx, 'workflow', c);
      }
      continue;
    }
    if (kw === 'functions' && s.kind === 'block' && ws.length === 1) {
      claim(ctx, s, 'functions');
      deriveFunctions(ctx, inner);
      continue;
    }
    if (level === 'document' && isSignatureBlock(s)) {
      // Shape C function file: `string name(args) { ... }`.
      app.statementCount--; // counted again by deriveFunctions
      deriveFunctions(ctx, [s]);
      continue;
    }
    if (level === 'document' && s.kind === 'block' && ws.length === 1 && /^["']/.test(ws[0])) {
      // Shape C profile file: `"Administrator" { ... permissions = {...} ... }`.
      app.profiles.push(deriveProfile(ctx, s));
      continue;
    }
    if (level === 'document' && s.kind === 'block' && ws.length === 1 && prop(props(ctx, inner), 'content') !== undefined) {
      // Shape C print-template / record-summary file: `Name { displayname = ... content = {...} }`.
      app.configuration.push(propertyBlock(ctx, s, 'template'));
      continue;
    }
    if (level === 'document' && s.kind === 'group' && top1(s) === '{') {
      // A JSON settings file (e.g. translation settings).
      app.translations.push(translation(ctx, s));
      continue;
    }
    if (level === 'document' && s.kind === 'block' && lw.includes('as')) {
      // Shape C: a workflow or function definition file starts at `Name as "Label" { ... }`.
      const ps = props(ctx, inner);
      const type = prop(ps, 'type')?.toLowerCase();
      if (type === 'functions') deriveCreatorFunction(ctx, s);
      else deriveWorkflowDef(ctx, s, undefined);
      continue;
    }
    if (kw === 'share_settings' && s.kind === 'block' && ws.length === 1) {
      deriveShareSettings(ctx, s);
      continue;
    }
    if (kw === 'roles' && s.kind === 'block' && ws.length === 1) {
      claim(ctx, s, 'roles');
      for (const c of inner) if (c.kind === 'block') app.roles.push(deriveRole(ctx, c));
      continue;
    }
    if (kw === 'translation' && s.kind === 'block' && ws.length === 1) {
      claim(ctx, s, 'translation');
      for (const c of inner) if (c.kind === 'group') app.translations.push(translation(ctx, c));
      continue;
    }
    if ((CONFIG_BLOCKS.has(kw) || CONFIG_BLOCKS.has(lw.join(' '))) && (s.kind === 'block' || s.kind === 'call')) {
      app.configuration.push(propertyBlock(ctx, s, 'configuration'));
      visitOpaque(ctx, inner, ws[ws.length - 1]);
      continue;
    }
    if (kw === 'api' && s.kind === 'block' && ws.length === 2) {
      const api = propertyBlock(ctx, s, 'api');
      api.name = ws[1];
      app.apis.push(api);
      continue;
    }
    if ((KNOWN_OPAQUE.has(kw) || KNOWN_OPAQUE.has(lw.join(' '))) && (s.kind === 'block' || s.kind === 'call')) {
      // Known blocks whose content is preserved in the CST but not modelled.
      app.unmodelled.push({ context: level, keyword: safeHeader(lw), span: span(ctx, s) });
      if (ws.length === 1 || PROFILE_LIKE.has(kw)) visitOpaque(ctx, inner, ws[ws.length - 1]);
      continue;
    }
    if (level === 'container') {
      app.unmodelled.push({ context: level, keyword: safeHeader(lw), span: span(ctx, s) });
      visitOpaque(ctx, inner, ws[ws.length - 1]);
      continue;
    }
    unknown(ctx, level, s);
  }
}

/** Keyword of an unmodelled block, without the identifiers that follow it. */
function safeHeader(lw: string[]): string {
  const out: string[] = [];
  for (const w of lw) {
    if (!/^[a-z]+$/.test(w)) break;
    out.push(w);
  }
  return out.join(' ') || '<name>';
}

/** Blocks that are recognised but whose content is preserved, not modelled. */
const KNOWN_OPAQUE = new Set(['share', 'profiles', 'profile', 'role', 'portal', 'users', 'permissions', 'devices', 'web', 'phone', 'tablet', 'api']);
const PROFILE_LIKE = new Set(['profile', 'role', 'portal']);

/** Walk an unmodelled block only to collect `permissions = {...}` properties. */
function visitOpaque(ctx: Ctx, stmts: Statement[], owner?: string): void {
  for (const s of stmts) {
    collectPermissions(ctx, s, owner);
    if (s.kind === 'block' || s.kind === 'call') {
      const ws = words(s);
      visitOpaque(ctx, body(s), ws.length ? unquote(ws[ws.length - 1]) : owner);
    }
  }
}

function collectPermissions(ctx: Ctx, s: Statement, owner?: string): void {
  if (s.kind !== 'property') return;
  const p = property(ctx, s)!;
  if (p.key.toLowerCase() === 'permissions') {
    ctx.app.permissions.push({ owner, value: p.value, span: p.span });
    claim(ctx, s, 'permission');
  }
}

function showFromOf(s: Statement): string | undefined {
  const lw = lower(words(s));
  const i = lw.indexOf('from');
  if (i >= 2 && lw[i - 1] === 'rows' && lw[i - 2] === 'all') return words(s)[i + 1];
  return undefined;
}

function showFrom(stmts: Statement[]): string | undefined {
  for (const s of stmts) {
    const f = showFromOf(s);
    if (f !== undefined) return f;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// pages, translations

function page(ctx: Ctx, name: string, content: string | undefined, ps: Property[], s: { start: number; end: number }, sectionName?: string): Page {
  const zml = content !== undefined ? parseZml(content) : [];
  return {
    name,
    displayName: prop(ps, 'displayname'),
    section: sectionName,
    content,
    zml,
    references: zmlReferences(zml),
    properties: ps,
    span: span(ctx, s),
  };
}

function translation(ctx: Ctx, s: Statement): Translation {
  claim(ctx, s, 'translation');
  const json = text(ctx, s);
  const t: Translation = { json, span: span(ctx, s) };
  try {
    t.data = JSON.parse(json);
  } catch {
    // kept verbatim
  }
  return t;
}

// ---------------------------------------------------------------------------
// forms

function field(ctx: Ctx, s: Statement, name: string, modifiers: string[], role: string): Field {
  claim(ctx, s, role);
  const inner = body(s);
  const ps = props(ctx, inner, 'field.property');
  const f: Field = {
    name,
    type: prop(ps, 'type'),
    displayName: prop(ps, 'displayname'),
    modifiers,
    required: modifiers.join(' ').includes('must have'),
    unique: modifiers.includes('unique'),
    properties: ps,
    subfields: [],
    annotations: [],
    flags: flags(ctx, inner, 'field.flag'),
    span: span(ctx, s),
  };
  const values = ps.find((p) => p.key.toLowerCase() === 'values')?.value;
  if (values !== undefined) {
    if (values.startsWith('{')) f.choices = stringList(values);
    else {
      const lookup = /^([\p{L}_][\p{L}\p{N}_]*)(?:\[([^\]]+)\])?\.([\p{L}_][\p{L}\p{N}_]*)$/u.exec(values);
      if (lookup) {
        const fmt = prop(ps, 'displayformat');
        f.lookup = {
          form: lookup[1]!,
          field: lookup[3]!,
          ...(lookup[2] !== undefined ? { criteria: lookup[2] } : {}),
          ...(fmt !== undefined ? { displayFormat: fmt } : {}),
        };
      }
    }
  }
  const init = ps.find((p) => p.key.toLowerCase() === 'initial value')?.value;
  if (init !== undefined) f.initialValue = init;
  for (const c of inner) {
    if (c.kind === 'call' && words(c).length >= 1) {
      const cw = words(c);
      f.subfields.push(field(ctx, c, cw[cw.length - 1], lower(cw.slice(0, -1)), 'field.subfield'));
    } else if (c.kind === 'group' && top1(c) === '[') {
      f.annotations.push(propertyBlock(ctx, c, 'field.annotation'));
    }
  }
  return f;
}

/** Strings of a `{"a","b"}` literal, decoded. Unquoted items are kept as written. */
function stringList(v: string): string[] {
  const out: string[] = [];
  for (const m of v.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^,\s][^,]*)/g)) {
    if (m[1] !== undefined) out.push(unquote(`"${m[1]}"`));
    else if (m[2] !== undefined) out.push(unquote(`'${m[2]}'`));
    else out.push(m[3].trim());
  }
  return out;
}

function deriveForm(ctx: Ctx, s: Statement, sectionName?: string): Form {
  const ws = words(s);
  const inner = body(s);
  const ps = props(ctx, inner, 'form.property');
  const form: Form = {
    name: ws[ws.length - 1],
    displayName: prop(ps, 'displayname'),
    section: sectionName,
    properties: ps,
    fields: [],
    actions: [],
    blocks: [],
    span: span(ctx, s),
  };
  for (const c of inner) {
    ctx.app.statementCount++;
    if (c.kind === 'property' || c.kind === 'word') continue;
    const cw = words(c);
    const lc = lower(cw);
    const isFormBlock =
      (FORM_BLOCKS.has(lc[0]) || FORM_BLOCKS.has(lc.join(' '))) &&
      (c.kind === 'block' || (c.kind === 'call' && cw.length === 1 && prop(props(ctx, body(c)), 'type') === undefined));
    if (isFormBlock) {
      form.blocks.push(propertyBlock(ctx, c, 'form.block'));
      continue;
    }
    if (c.kind === 'call' && cw.length >= 1) {
      form.fields.push(field(ctx, c, cw[cw.length - 1], lc.slice(0, -1), 'form.field'));
      continue;
    }
    if (c.kind === 'block' && lc[0] === 'field' && cw.length === 2) {
      // Hand-written variant: `field Name { type = text; ... }`.
      form.fields.push(field(ctx, c, cw[1], [], 'form.field'));
      continue;
    }
    if (c.kind === 'block' && lc[0] === 'actions' && cw.length === 1) {
      claim(ctx, c, 'form.actions');
      const loose: FormButton[] = [];
      for (const ev of body(c)) {
        ctx.app.statementCount++;
        if (ev.kind === 'call') {
          // Buttons declared directly under `actions`, without an `on add` / `on edit` wrapper.
          loose.push(button(ctx, ev));
          continue;
        }
        if (ev.kind !== 'block') {
          if (ev.kind !== 'word' && ev.kind !== 'property') unknown(ctx, 'form', ev);
          continue;
        }
        const buttons: FormButton[] = [];
        for (const b of body(ev)) if (words(b).length) buttons.push(button(ctx, b));
        form.actions.push({ event: words(ev).join(' '), buttons, span: span(ctx, ev) });
        claim(ctx, ev, 'form.action');
      }
      if (loose.length) form.actions.push({ event: '', buttons: loose, span: span(ctx, c) });
      continue;
    }
    unknown(ctx, 'form', c);
  }
  return form;
}

function button(ctx: Ctx, b: Statement): FormButton {
  const bw = words(b);
  const bps = b.kind === 'call' ? props(ctx, body(b), 'form.button.property') : [];
  claim(ctx, b, 'form.button');
  return { name: bw[bw.length - 1], type: prop(bps, 'type'), displayName: prop(bps, 'displayname'), properties: bps };
}

// ---------------------------------------------------------------------------
// reports

function deriveReport(ctx: Ctx, s: Statement, name: string, type: string, modifiers: string[], sectionName?: string): Report {
  claim(ctx, s, 'report');
  const inner = body(s);
  const ps = props(ctx, inner, 'report.property');
  const r: Report = {
    name,
    type,
    modifiers,
    displayName: prop(ps, 'displayname'),
    form: showFrom(inner),
    section: sectionName,
    properties: ps,
    columns: [],
    customActions: [],
    conditionalFormats: [],
    filters: [],
    groupBy: [],
    sortBy: [],
    blocks: [],
    views: [],
    flags: [],
    span: span(ctx, s),
  };
  for (const c of inner) {
    if (c.kind === 'word') {
      const lc = lower(words(c));
      if (lc[0] === 'based' && lc[1] === 'on' && lc.length === 3) {
        claim(ctx, c, 'report.based on');
        r.basedOn = words(c)[2];
      } else if (showFromOf(c) === undefined) r.flags.push(...flags(ctx, [c], 'report.flag'));
      else claim(ctx, c, 'report.source');
      continue;
    }
    if (c.kind !== 'block' && c.kind !== 'call') continue;
    const lc = lower(words(c));
    const head = lc.join(' ');
    if (showFromOf(c) !== undefined) {
      claim(ctx, c, 'report.source');
      const crit = sig(c).find((x) => isGroup(x) && x.open.text === '[') as Group | undefined;
      if (crit) r.criteria = inside(ctx, crit).trim();
      const cols = sig(c).some((x) => isGroup(x) && x.structured) ? body(c) : [];
      for (const col of cols) {
        const cw = words(col);
        if (col.kind === 'call' && lower(cw.slice(0, 2)).join(' ') === 'custom action') {
          r.customActions.push(customAction(ctx, col, unquote(cw.slice(2).join(' ')), true));
        } else if (col.kind === 'word' || (col.kind === 'call' && cw.length >= 1)) {
          r.columns.push(column(ctx, col));
        }
      }
      continue;
    }
    if (head === 'quickview' || head === 'detailview') {
      r.views.push(reportView(ctx, c, head));
      continue;
    }
    if (head === 'custom actions') {
      claim(ctx, c, 'report.custom actions');
      for (const a of body(c)) if (a.kind === 'call' && words(a).length) r.customActions.push(customAction(ctx, a, unquote(words(a).join(' ')), false));
      continue;
    }
    if (head === 'conditional formatting') {
      claim(ctx, c, 'report.conditional formatting');
      for (const f of body(c)) {
        if (f.kind !== 'block' && f.kind !== 'call') continue;
        claim(ctx, f, 'report.conditional format');
        const fps = props(ctx, body(f), 'report.conditional format.property');
        r.conditionalFormats.push({
          name: unquote(words(f).join(' ')),
          condition: fps.find((p) => p.key.toLowerCase() === 'condition')?.value,
          fields: fps.find((p) => p.key.toLowerCase() === 'fields')?.value,
          format: prop(fps, 'format'),
          properties: fps,
          span: span(ctx, f),
        });
      }
      continue;
    }
    if (head === 'filters') {
      claim(ctx, c, 'report.filters');
      for (const f of body(c)) {
        if (f.kind === 'word') {
          claim(ctx, f, 'report.filter');
          r.filters.push({ field: words(f).join(' '), span: span(ctx, f) });
        } else if (f.kind === 'pairs') {
          claim(ctx, f, 'report.filter');
          const items = sig(f);
          const colon = items.findIndex((x) => isToken(x) && x.text === ':');
          const rest = items.slice(colon + 1);
          r.filters.push({
            label: unquote(words(f).join(' ')),
            criteria: rest.length ? ctx.src.slice(nodeStartOf(rest[0]), nodeEndOf(rest[rest.length - 1])) : '',
            span: span(ctx, f),
          });
        }
      }
      continue;
    }
    if (head === 'group by' || head === 'sort by') {
      claim(ctx, c, `report.${head}`);
      const list = head === 'group by' ? r.groupBy : r.sortBy;
      for (const g of body(c)) {
        if (g.kind === 'word') {
          claim(ctx, g, `report.${head}.field`);
          const gw = words(g);
          const last = gw[gw.length - 1]?.toLowerCase();
          if (gw.length > 1 && (last === 'ascending' || last === 'descending')) list.push({ field: gw.slice(0, -1).join(' '), order: last });
          else list.push({ field: gw.join(' ') });
        } else if (isBody(g)) r.blocks.push(propertyBlock(ctx, g, 'report.block'));
      }
      continue;
    }
    if (REPORT_BLOCKS.has(head)) {
      r.blocks.push(propertyBlock(ctx, c, 'report.block'));
      continue;
    }
  }
  return r;
}

function column(ctx: Ctx, s: Statement): ReportColumn {
  claim(ctx, s, 'report.column');
  const { name, label } = nameAndLabel(words(s));
  const inner = s.kind === 'call' ? body(s) : [];
  const ps = props(ctx, inner, 'report.column.property');
  const subcolumns = inner.filter((c) => c.kind === 'word' || (c.kind === 'call' && words(c).length)).map((c) => column(ctx, c));
  return { field: name, ...(label !== undefined ? { label } : {}), properties: ps, subcolumns, span: span(ctx, s) };
}

function customAction(ctx: Ctx, s: Statement, name: string, isColumn: boolean): ReportCustomAction {
  claim(ctx, s, 'report.custom action');
  const inner = body(s);
  const ps = props(ctx, inner, 'report.custom action.property');
  return {
    name,
    workflow: prop(ps, 'workflow'),
    column: isColumn,
    properties: ps,
    flags: flags(ctx, inner, 'report.custom action.flag'),
    blocks: inner.filter((c) => isBody(c)).map((c) => propertyBlock(ctx, c, 'report.custom action.block')),
    span: span(ctx, s),
  };
}

function reportView(ctx: Ctx, s: Statement, kind: string): ReportView {
  claim(ctx, s, `report.${kind}`);
  const inner = body(s);
  const v: ReportView = {
    kind: kind as ReportView['kind'],
    ...(ctx.device ? { device: ctx.device } : {}),
    layoutProperties: [],
    blocks: [],
    menus: {},
    actions: {},
    properties: props(ctx, inner, 'report.view.property'),
    span: span(ctx, s),
  };
  for (const c of inner) {
    if (!isBody(c)) continue;
    const head = lower(words(c)).join(' ');
    if (head === 'layout') {
      claim(ctx, c, 'report.view.layout');
      v.layoutProperties = props(ctx, body(c), 'report.view.layout.property');
      v.layoutType = prop(v.layoutProperties, 'type');
      for (const b of body(c)) {
        if (!isBody(b)) continue;
        claim(ctx, b, 'report.view.block');
        const bps = props(ctx, body(b), 'report.view.block.property');
        const blk: ReportDataBlock = {
          name: words(b).map(unquote).join(' '),
          title: prop(bps, 'title'),
          layoutType: prop(bps, 'layout type'),
          relatedField: prop(bps, 'related field'),
          fields: [],
          properties: bps,
          span: span(ctx, b),
        };
        for (const f of body(b)) {
          if (lower(words(f)).join(' ') !== 'fields' || !isBody(f)) continue;
          claim(ctx, f, 'report.view.fields');
          for (const col of body(f)) if (col.kind === 'word' || col.kind === 'call') blk.fields.push(column(ctx, col));
        }
        v.blocks.push(blk);
      }
    } else if (head === 'menu') {
      claim(ctx, c, 'report.view.menu');
      for (const m of body(c)) if (isBody(m)) {
        claim(ctx, m, 'report.view.menu');
        v.menus[lower(words(m)).join(' ')] = itemList(ctx, m, 'report.view.item');
      }
    } else if (head === 'action') {
      claim(ctx, c, 'report.view.action');
      for (const a of body(c)) if (isBody(a) || a.children.some((x) => isGroup(x) && x.raw)) {
        claim(ctx, a, 'report.view.action');
        v.actions[lower(words(a)).join(' ')] = itemList(ctx, a, 'report.view.item');
      }
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// devices

function device(ctx: Ctx, name: string, s: { start: number; end: number }): Device {
  let d = ctx.app.devices.find((x) => x.device === name);
  if (!d) {
    d = { device: name, sections: [], unused: [], forms: [], components: [], span: span(ctx, s) };
    ctx.app.devices.push(d);
  }
  return d;
}

function deriveDevice(ctx: Ctx, s: Statement, name: string): void {
  claim(ctx, s, 'device');
  const saved = ctx.device;
  ctx.device = name;
  deriveDeviceBody(ctx, device(ctx, name, s), body(s));
  ctx.device = saved;
}

function deriveDeviceBody(ctx: Ctx, d: Device, stmts: Statement[], space?: string): void {
  for (const c of stmts) {
    const cw = words(c);
    const lc = lower(cw);
    const head = lc.join(' ');
    if (!isBody(c)) continue;
    if (head === 'customize') d.customize = propertyBlock(ctx, c, 'device.customize');
    else if (head === 'forms') {
      claim(ctx, c, 'device.forms');
      for (const f of body(c)) if (f.kind === 'block' && lower(words(f))[0] === 'form' && words(f).length === 2) {
        claim(ctx, f, 'device.form');
        d.forms.push({ name: words(f)[1], properties: props(ctx, body(f), 'device.form.property'), span: span(ctx, f) });
      }
    } else if (head === 'reports') {
      claim(ctx, c, 'device.reports');
      for (const r of body(c)) if (isBody(r) && words(r).length >= 2) d.components.push(deviceComponent(ctx, r));
    } else if (head === 'menu') {
      claim(ctx, c, 'device.menu');
      deriveDeviceBody(ctx, d, body(c));
    } else if (head === 'preference' && cw.length === 1) d.menuPreference = propertyBlock(ctx, c, 'device.menu preference');
    else if (head === 'unused' && cw.length === 1) {
      claim(ctx, c, 'device.unused');
      d.unused.push(...menuEntries(ctx, body(c)));
    } else if (lc[0] === 'space' && cw.length === 2) {
      claim(ctx, c, 'device.space');
      props(ctx, body(c), 'device.space.property');
      deriveDeviceBody(ctx, d, body(c), cw[1]);
      // components placed directly in a space, outside any section
      const direct = menuEntries(ctx, body(c).filter((e) => lower(words(e))[0] !== 'section'));
      if (direct.length) d.sections.push({ name: '', space: cw[1], properties: [], components: direct, span: span(ctx, c) });
    } else if (lc[0] === 'section' && cw.length === 2) {
      claim(ctx, c, 'device.section');
      const sec = { name: cw[1], ...(space ? { space } : {}), properties: props(ctx, body(c), 'device.section.property'), components: [] as DeviceComponent[], span: span(ctx, c) };
      sec.components.push(...menuEntries(ctx, body(c)));
      d.sections.push(sec);
    }
  }
}

/** Component entries of a device menu body; `systemcomponent { type = ... }` entries are named by their type. */
function menuEntries(ctx: Ctx, stmts: Statement[]): DeviceComponent[] {
  const out: DeviceComponent[] = [];
  for (const e of stmts) {
    if (isBody(e) && words(e).length >= 2) out.push(deviceComponent(ctx, e));
    else if (e.kind === 'block' && lower(words(e)).join(' ') === 'systemcomponent') {
      const comp = deviceComponent(ctx, e);
      comp.kind = 'systemcomponent';
      comp.name = prop(comp.properties, 'type') ?? '';
      out.push(comp);
    }
  }
  return out;
}

function deviceComponent(ctx: Ctx, s: Statement): DeviceComponent {
  claim(ctx, s, 'device.component');
  const ws = words(s);
  const inner = body(s);
  const views: ReportView[] = [];
  for (const c of inner) {
    const head = lower(words(c)).join(' ');
    if ((head === 'quickview' || head === 'detailview') && isBody(c)) views.push(reportView(ctx, c, head));
  }
  return {
    kind: lower(ws.slice(0, -1)).join(' '),
    name: ws[ws.length - 1],
    properties: props(ctx, inner, 'device.component.property'),
    views,
    span: span(ctx, s),
  };
}

/**
 * Attach device report views to the reports they belong to. Views whose report
 * is not in this IR stay on the device component.
 */
export function linkDeviceViews(app: App): void {
  for (const d of app.devices) {
    for (const comp of [...d.components, ...d.unused, ...d.sections.flatMap((s) => s.components)]) {
      if (!comp.views.length) continue;
      const r = app.reports.find((x) => x.name === comp.name);
      if (!r) continue;
      for (const v of comp.views) r.views.push({ ...v, device: d.device });
      comp.views = [];
    }
    d.components = d.components.filter((c) => c.views.length || c.properties.length);
  }
}

// ---------------------------------------------------------------------------
// share settings: profiles and roles

function deriveShareSettings(ctx: Ctx, s: Statement): void {
  claim(ctx, s, 'share settings');
  for (const c of body(s)) {
    const cw = words(c);
    if (c.kind === 'property') {
      if (property(ctx, c)!.key.toLowerCase() === 'permissions') continue;
      ctx.app.shareSettings.push(property(ctx, c)!);
      claim(ctx, c, 'share settings.property');
    } else if (c.kind === 'block' && cw.length === 1 && cw[0].toLowerCase() === 'roles') {
      claim(ctx, c, 'roles');
      for (const r of body(c)) if (r.kind === 'block') ctx.app.roles.push(deriveRole(ctx, r));
    } else if (c.kind === 'block' && cw.length >= 1) {
      ctx.app.profiles.push(deriveProfile(ctx, c));
    }
  }
}

function deriveProfile(ctx: Ctx, s: Statement): Profile {
  claim(ctx, s, 'profile');
  const name = unquote(words(s).join(' '));
  const inner = body(s);
  const ps = props(ctx, inner, 'profile.property');
  for (const c of inner) collectPermissions(ctx, c, name);
  const p: Profile = {
    name,
    type: prop(ps, 'type'),
    description: prop(ps, 'description'),
    permissions: ps.find((x) => x.key.toLowerCase() === 'permissions')?.value,
    properties: ps,
    modules: [],
    span: span(ctx, s),
  };
  for (const c of inner) {
    if (c.kind !== 'block' || lower(words(c)).join(' ') !== 'modulepermissions') continue;
    claim(ctx, c, 'profile.modules');
    for (const m of body(c)) {
      if (m.kind !== 'block' || !words(m).length) continue;
      claim(ctx, m, 'profile.module');
      const mi = body(m);
      const mod: ModulePermission = {
        component: unquote(words(m).join(' ')),
        properties: props(ctx, mi, 'profile.module.property'),
        reports: [],
        fields: [],
        span: span(ctx, m),
      };
      for (const b of mi) {
        const head = lower(words(b)).join(' ');
        if (b.kind === 'block' && head === 'reportpermissions') {
          claim(ctx, b, 'profile.module.reports');
          mod.reports.push(...props(ctx, body(b), 'profile.module.report'));
        } else if (b.kind === 'block' && head === 'fieldpermissions') {
          claim(ctx, b, 'profile.module.fields');
          for (const f of body(b)) {
            if (f.kind !== 'block' || !words(f).length) continue;
            claim(ctx, f, 'profile.module.field');
            const flags: Record<string, string> = {};
            for (const pr of body(f)) {
              if (pr.kind !== 'pairs') continue;
              claim(ctx, pr, 'profile.module.field');
              for (const [k, v] of pairs(pr)) flags[k] = v;
            }
            mod.fields.push({ field: words(f).join(' '), flags, span: span(ctx, f) });
          }
        }
      }
      p.modules.push(mod);
    }
  }
  return p;
}

/** `a:true,b:false` → [[a,true],[b,false]]. */
function pairs(s: Statement): [string, string][] {
  const out: [string, string][] = [];
  let key: string[] = [];
  let val: string[] = [];
  let inVal = false;
  for (const t of sig(s)) {
    if (!isToken(t)) {
      (inVal ? val : key).push('…');
      continue;
    }
    if (t.text === ':' && !inVal) inVal = true;
    else if (t.text === ',' || t.text === ';') {
      if (key.length) out.push([key.join(' '), val.join('')]);
      key = [];
      val = [];
      inVal = false;
    } else (inVal ? val : key).push(t.text);
  }
  if (key.length) out.push([key.join(' '), val.join('')]);
  return out;
}

function deriveRole(ctx: Ctx, s: Statement): Role {
  claim(ctx, s, 'role');
  const inner = body(s);
  const ps = props(ctx, inner, 'role.property');
  return {
    name: unquote(words(s).join(' ')),
    description: prop(ps, 'description'),
    properties: ps,
    children: inner.filter((c) => c.kind === 'block' && words(c).length).map((c) => deriveRole(ctx, c)),
    span: span(ctx, s),
  };
}

// ---------------------------------------------------------------------------
// workflows and functions

function deriveWorkflowContainer(ctx: Ctx, s: Statement, container: string): void {
  claim(ctx, s, 'workflow.container');
  for (const c of body(s)) {
    ctx.app.statementCount++;
    if (c.kind === 'block' && words(c).length >= 1) deriveWorkflowDef(ctx, c, container);
    else if (c.kind !== 'property' && c.kind !== 'word') unknown(ctx, 'workflow', c);
  }
}

function deriveWorkflowDef(ctx: Ctx, s: Statement, container: string | undefined): void {
  const { name, label } = nameAndLabel(words(s));
  const inner = body(s);
  const ps = props(ctx, inner, 'workflow.property');
  const type = prop(ps, 'type');
  claim(ctx, s, 'workflow.definition');
  const base: Omit<Workflow, 'event' | 'deluge' | 'span'> = {
    name,
    label,
    container: container ?? type,
    type,
    form: prop(ps, 'form'),
    recordEvent: prop(ps, 'record event'),
    properties: ps,
  };
  for (const c of inner) {
    const head = lower(words(c)).join(' ');
    if (c.kind === 'block' && head === 'field rules') {
      claim(ctx, c, 'workflow.field rules');
      base.fieldRules = (base.fieldRules ?? []).concat(fieldRules(ctx, c));
    } else if (c.kind === 'block' && head === 'start') {
      // blueprint `start { start stage = S }`
      base.blueprint ??= { stages: [], transitions: [] };
      base.blueprint.start = propertyBlock(ctx, c, 'workflow.blueprint.start');
    } else if (c.kind === 'block' && (head === 'stages' || head === 'transitions')) {
      base.blueprint ??= { stages: [], transitions: [] };
      claim(ctx, c, `workflow.blueprint`);
      for (const t of body(c)) {
        if (!isBody(t)) continue;
        if (head === 'stages') base.blueprint.stages.push(propertyBlock(ctx, t, 'workflow.blueprint.stage'));
        else base.blueprint.transitions.push(transition(ctx, t));
      }
    }
  }
  const events = inner.filter((c) => c.kind === 'block' && EVENT_RE.test(words(c)[0]?.toLowerCase() ?? ''));
  if (events.length === 0) {
    for (const c of inner) claimDeluge(ctx, c);
    const raw = firstRaw(inner);
    ctx.app.workflows.push({ ...base, event: '', deluge: raw ? rawDeluge(ctx, raw) : null, span: span(ctx, s) });
    return;
  }
  for (const ev of events) workflowEvents(ctx, ev, base, '');
}

/** One workflow entry per handler; approval levels nest `on approve` / `on reject` inside `on level N`. */
function workflowEvents(ctx: Ctx, ev: Statement, base: Omit<Workflow, 'event' | 'deluge' | 'span'>, prefix: string): void {
  claim(ctx, ev, 'workflow.event');
  const event = prefix + words(ev).join(' ');
  const inner = body(ev);
  const nested = inner.filter((c) => c.kind === 'block' && EVENT_RE.test(words(c)[0]?.toLowerCase() ?? ''));
  if (nested.length) {
    const approvers = inner.filter((c) => c.kind === 'call' && lower(words(c)).join(' ') === 'approvers');
    const level = { ...base };
    for (const a of approvers) {
      claim(ctx, a, 'workflow.approvers');
      level.approvers = [...(level.approvers ?? []), ...props(ctx, body(a), 'workflow.approvers.property')];
    }
    for (const n of nested) workflowEvents(ctx, n, level, `${event} / `);
    return;
  }
  // `on add { actions { on validate ( ... ) on success ( ... ) } }`: one entry per handler.
  const hs = handlers(inner);
  for (const c of inner) if (c.kind === 'block' && lower(words(c)).join(' ') === 'actions' && body(c).length === 0) claim(ctx, c, 'workflow.actions');
  if (hs.length) {
    const recordLevel = RECORD_EVENTS.has(event.toLowerCase());
    const rec = recordLevel ? { recordEvent: base.recordEvent ?? event } : {};
    for (const h of hs) {
      for (const a of h.path) claim(ctx, a, 'workflow.actions');
      if (!h.stmt) {
        // A run inside `actions { ... }` mixes field rules (`hide A, B.C;`),
        // button declarations (`Save ( type = submit ... )`) and free Deluge.
        // Field rules apply at the event's form context: under a record event
        // that context is its load screen.
        const criteria = actionCriteria(ctx, h.path);
        const fieldStmts: Statement[] = [];
        const delugeStmts: Statement[] = [];
        for (const c of h.run) {
          if (fieldRuleVerb(c)) fieldStmts.push(c);
          else if (recordLevel && c.kind === 'call' && workflowButton(ctx, c, base.form, event)) continue;
          else delugeStmts.push(c);
        }
        if (fieldStmts.length) {
          const actions: FieldRuleAction[] = [];
          for (const c of fieldStmts) {
            claim(ctx, c, 'workflow.field rule.action');
            const toks = sig(c).filter((x): x is Token => isToken(x) && x.kind !== 'punct');
            if (toks.length) actions.push({ action: toks[0].text, fields: fieldNames(c) });
          }
          if (actions.length) {
            const first = fieldStmts[0];
            const last = fieldStmts[fieldStmts.length - 1];
            const ruleSpan = span(ctx, { start: first.start, end: last.end });
            ctx.app.workflows.push({
              ...base,
              ...rec,
              ...criteria,
              event: recordLevel ? 'on load' : event,
              deluge: null,
              fieldRules: [
                {
                  ...(criteria.actionCondition ? { condition: criteria.actionCondition } : {}),
                  actions,
                  span: ruleSpan,
                },
              ],
              span: ruleSpan,
            });
          }
        }
        if (delugeStmts.length) {
          // Statements written directly in `actions { ... }` run on the event itself.
          for (const c of delugeStmts) claimAll(ctx, c, 'deluge');
          const first = delugeStmts[0];
          const last = delugeStmts[delugeStmts.length - 1];
          const d = {
            text: delugeStmts.map((c) => ctx.src.slice(c.start, c.end)).join('\n'),
            span: span(ctx, { start: first.start, end: last.end }),
          };
          ctx.app.workflows.push({ ...base, ...rec, ...criteria, event, deluge: d, span: d.span });
        }
        continue;
      }
      claim(ctx, h.stmt, 'workflow.handler');
      if (!h.raw.raw) for (const c of children(h.stmt)) claimAll(ctx, c, 'deluge');
      const name = words(h.stmt).join(' ');
      // `custom deluge script ( ... )` is a plain wrapper: the Deluge runs on the event itself.
      const wrapper = name.toLowerCase() === 'custom deluge script';
      const e = wrapper || name.toLowerCase() === event.toLowerCase() ? event : recordLevel ? name : `${event} / ${name}`;
      ctx.app.workflows.push({ ...base, ...(wrapper ? {} : rec), ...actionCriteria(ctx, h.path), event: e, deluge: rawDeluge(ctx, h.raw), span: span(ctx, h.stmt) });
    }
    return;
  }
  // An actions brace kept raw still holds Deluge (`on start { actions { openUrl(...); } }`).
  // An actions brace with neither statements nor a raw group is empty.
  // An event whose own brace is raw has no structured statements; sectionDeluge reads that body.
  const onlyEmptyActions =
    inner.length > 0 &&
    inner.every((c) => c.kind === 'block' && lower(words(c)).join(' ') === 'actions' && body(c).length === 0 && allRaw(c.children).length === 0);
  const deluge = onlyEmptyActions ? [] : sectionDeluge(ctx, ev);
  if (deluge.length <= 1) ctx.app.workflows.push({ ...base, event, deluge: deluge[0] ?? null, span: span(ctx, ev) });
  else for (const d of deluge) ctx.app.workflows.push({ ...base, event, deluge: d, span: span(ctx, ev) });
}

const RECORD_EVENTS = new Set(['on add', 'on edit', 'on add or edit', 'on delete']);

type HandlerItem =
  | { stmt: Statement; raw: Group; path: Statement[]; run?: undefined }
  | { stmt?: undefined; raw?: undefined; run: Statement[]; path: Statement[] };

/**
 * `on X ( <deluge> )` handlers, directly or inside `actions { ... }` blocks, and
 * runs of other statements written directly inside `actions`, in source order.
 */
/** Innermost `actions (criteria)` on the path. A block with no criteria does not hide an outer one. */
function actionCriteria(ctx: Ctx, path: Statement[]): { actionCondition?: string } {
  for (let i = path.length - 1; i >= 0; i--) {
    const block = path[i];
    if (!block || block.kind !== 'block' || lower(words(block)).join(' ') !== 'actions') continue;
    const cond = sig(block).find((item) => isGroup(item) && item.open.text === '(');
    if (!cond || !isGroup(cond)) continue;
    const text = inside(ctx, cond).trim();
    if (text) return { actionCondition: text };
  }
  return {};
}

function handlers(stmts: Statement[], path: Statement[] = []): HandlerItem[] {
  const out: HandlerItem[] = [];
  let run: Statement[] = [];
  const flush = () => {
    if (run.length) out.push({ run, path });
    run = [];
  };
  for (const c of stmts) {
    const ws = lower(words(c));
    const raw = c.kind === 'call' ? (c.children.find((x): x is Group => isGroup(x) && x.raw) ?? bodyGroup(c)) : undefined;
    if (raw && (ws[0] === 'on' || ws.join(' ') === 'custom deluge script')) {
      flush();
      out.push({ stmt: c, raw, path });
    } else if (c.kind === 'block' && ws.join(' ') === 'actions') {
      flush();
      out.push(...handlers(body(c), [...path, c]));
    } else if (path.length) run.push(c);
  }
  flush();
  return out;
}

/** `hide A, B.C;` — the word-statement shape of a field rule inside `actions { }`. */
const FIELD_RULE_VERBS = new Set(['hide', 'show', 'enable', 'disable']);

function fieldRuleVerb(s: Statement): boolean {
  if (s.kind !== 'word') return false;
  const ws = lower(words(s));
  return ws.length >= 2 && FIELD_RULE_VERBS.has(ws[0]);
}

/**
 * `Name ( type = submit|button|reset|cancel ... )` inside a record-event
 * `actions` block declares a button on the workflow's form for that record
 * event. Merged into `form.actions`, deduplicated by name.
 */
const WORKFLOW_BUTTON_TYPES = new Set(['submit', 'button', 'reset', 'cancel']);

function workflowButton(ctx: Ctx, s: Statement, formName: string | undefined, event: string): boolean {
  // Peek before claiming: a handler's Deluge body can hold `key = value` lines.
  const head = lower(words(s))[0];
  if (head === 'on' || head === 'custom') return false;
  const type = prop(props(ctx, body(s)), 'type');
  if (!type || !WORKFLOW_BUTTON_TYPES.has(type.toLowerCase())) return false;
  claim(ctx, s, 'form.button');
  const bps = props(ctx, body(s), 'form.button.property');
  const b: FormButton = { name: words(s).join(' '), type, displayName: prop(bps, 'displayname'), properties: bps };
  const form = ctx.app.forms.find((f) => f.name === formName);
  if (!form) return true;
  let entry = form.actions.find((a) => a.event.toLowerCase() === event.toLowerCase());
  if (!entry) {
    entry = { event, buttons: [], span: span(ctx, s) };
    form.actions.push(entry);
  }
  if (!entry.buttons.some((x) => x.name === b.name)) entry.buttons.push(b);
  return true;
}

function fieldRules(ctx: Ctx, s: Statement): FieldRule[] {
  const out: FieldRule[] = [];
  for (const a of body(s)) {
    if (a.kind !== 'block' || lower(words(a))[0] !== 'actions') continue;
    claim(ctx, a, 'workflow.field rule');
    const cond = sig(a).find((x) => isGroup(x) && x.open.text === '(') as Group | undefined;
    const rule: FieldRule = { ...(cond ? { condition: inside(ctx, cond).trim() } : {}), actions: [], span: span(ctx, a) };
    for (const w of body(a)) {
      if (w.kind !== 'word') continue;
      claim(ctx, w, 'workflow.field rule.action');
      const toks = sig(w).filter((x): x is Token => isToken(x) && x.kind !== 'punct');
      if (toks.length) rule.actions.push({ action: toks[0].text, fields: fieldNames(w) });
    }
    out.push(rule);
  }
  return out;
}

/** `hide A, B.C;` → [A, B.C] */
function fieldNames(s: Statement): string[] {
  const out: string[] = [];
  let cur = '';
  const items = sig(s).filter((x): x is Token => isToken(x));
  for (let i = 1; i < items.length; i++) {
    const t = items[i];
    if (t.text === ',' || t.text === ';') {
      if (cur) out.push(cur);
      cur = '';
    } else if (t.text === '.' || cur.endsWith('.')) cur += t.text;
    else {
      if (cur) out.push(cur);
      cur = t.text;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function transition(ctx: Ctx, s: Statement): BlueprintTransition {
  claim(ctx, s, 'workflow.blueprint.transition');
  const inner = body(s);
  const ps = props(ctx, inner, 'workflow.blueprint.transition.property');
  const t: BlueprintTransition = {
    name: unquote(words(s).join(' ')),
    fromStage: prop(ps, 'from stage'),
    toStage: prop(ps, 'to stage'),
    properties: ps,
    phases: [],
    span: span(ctx, s),
  };
  for (const c of inner) {
    if (c.kind !== 'block' || !words(c).length) continue;
    claim(ctx, c, 'workflow.blueprint.phase');
    const pi = body(c);
    // `actions ( <deluge> )` is Deluge even when its text happens to parse as structured statements.
    const isActions = (x: Statement) => x.kind === 'call' && lower(words(x)).join(' ') === 'actions';
    const deluge: RawDeluge[] = [];
    for (const x of pi) {
      const g = isActions(x) ? (allRaw(x.children)[0] ?? bodyGroup(x)) : undefined;
      if (g) {
        claim(ctx, x, 'deluge');
        if (!g.raw) for (const y of children(x)) claimAll(ctx, y, 'deluge');
        deluge.push(rawDeluge(ctx, g));
      } else deluge.push(...allRaw(x.children).map((r) => rawDeluge(ctx, r)));
    }
    t.phases.push({
      phase: lower(words(c)).join(' '),
      properties: props(ctx, pi, 'workflow.blueprint.phase.property'),
      blocks: pi.filter((x) => x.kind === 'call' && !isActions(x) && !allRaw(x.children).length && isBody(x)).map((x) => propertyBlock(ctx, x, 'workflow.blueprint.phase.block')),
      deluge,
      span: span(ctx, c),
    });
    for (const x of pi) claimDeluge(ctx, x);
  }
  return t;
}

function deriveFunctions(ctx: Ctx, stmts: Statement[]): void {
  for (const c of stmts) {
    ctx.app.statementCount++;
    const ws = words(c);
    if (c.kind !== 'block' || ws.length === 0) {
      if (c.kind !== 'property' && c.kind !== 'word') unknown(ctx, 'functions', c);
      continue;
    }
    const items = sig(c);
    const paren = items.find((x) => isGroup(x) && x.open.text === '(') as Group | undefined;
    const brace = items[items.length - 1] as Group;
    if (paren && isGroup(brace) && brace.open.text === '{' && items.indexOf(paren) === items.length - 2) {
      // `void openSummary(Add_Record myRec) { ... }`
      const head = items.slice(0, items.indexOf(paren));
      claimAll(ctx, c, 'function');
      ctx.app.functions.push({
        name: head.slice(1).map((x) => (isToken(x) ? x.text : '')).join(''),
        kind: 'deluge',
        signature: ctx.src.slice(c.start, brace.start).trimEnd(),
        deluge: [rawDeluge(ctx, brace)],
        properties: [],
        span: span(ctx, c),
      });
    } else if (lower(ws).includes('as') || prop(props(ctx, body(c)), 'type')) {
      deriveCreatorFunction(ctx, c);
    } else {
      // A namespace block grouping deluge functions.
      claim(ctx, c, 'functions.namespace');
      deriveFunctions(ctx, body(c));
    }
  }
}

function deriveCreatorFunction(ctx: Ctx, s: Statement): void {
  const { name, label } = nameAndLabel(words(s));
  const inner = body(s);
  const ps = props(ctx, inner, 'function.property');
  claim(ctx, s, 'function');
  const deluge: RawDeluge[] = [];
  for (const c of inner) {
    if (c.kind === 'property') continue;
    if (c.kind === 'block' && EVENT_RE.test(words(c)[0]?.toLowerCase() ?? '')) {
      claim(ctx, c, 'function.event');
      deluge.push(...sectionDeluge(ctx, c));
    } else if (claimDeluge(ctx, c)) deluge.push(...allRaw(c.children).map((g) => rawDeluge(ctx, g)));
  }
  ctx.app.functions.push({ name, label, kind: 'creator', form: prop(ps, 'form'), deluge, properties: ps, span: span(ctx, s) });
}

// ---------------------------------------------------------------------------

/**
 * A leading comment bigger than this is not a file header. The bound is what
 * stops a multi-megabyte export from being scanned for a header that, in a
 * real export, is a few lines at the top.
 */
const HEADER_CAP = 2 * 1024 * 1024;

/** JavaScript `\s`, so a header line breaks where the old pattern broke. */
function isHeaderSpace(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** ASCII case-insensitive match of a fixed header key. The key is not allocated. */
function headerKeyAt(line: string, i: number, key: string): boolean {
  if (i + key.length > line.length) return false;
  for (let k = 0; k < key.length; k++) {
    let c = line.charCodeAt(i + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== key.charCodeAt(k)) return false;
  }
  return true;
}

/** Optional work counter for parseHeader: one step per character the scanner examines. */
export interface HeaderWork {
  steps: number;
}

/** Scans one header line; returns the number of characters it examined. */
function takeHeaderLine(h: Header, line: string): number {
  const n = line.length;
  let steps = 0;
  let i = 0;
  while (i < n && isHeaderSpace(line.charCodeAt(i))) {
    i++;
    steps++;
  }
  // One optional star, the same as `\*?` after the leading space.
  if (i < n && line.charCodeAt(i) === 42) {
    i++;
    while (i < n && isHeaderSpace(line.charCodeAt(i))) {
      i++;
      steps++;
    }
  }
  let field: 'author' | 'generatedOn' | 'version' | undefined;
  let keyLen = 0;
  if (headerKeyAt(line, i, 'author')) {
    field = 'author';
    keyLen = 6;
  } else if (headerKeyAt(line, i, 'generated on')) {
    field = 'generatedOn';
    keyLen = 12;
  } else if (headerKeyAt(line, i, 'version')) {
    field = 'version';
    keyLen = 7;
  } else return steps + 1;
  let j = i + keyLen;
  while (j < n && isHeaderSpace(line.charCodeAt(j))) {
    j++;
    steps++;
  }
  if (j >= n || line.charCodeAt(j) !== 58) return steps + 1;
  j++;
  while (j < n && isHeaderSpace(line.charCodeAt(j))) {
    j++;
    steps++;
  }
  let end = n;
  while (end > j && isHeaderSpace(line.charCodeAt(end - 1))) {
    end--;
    steps++;
  }
  h[field] = line.slice(j, end);
  return steps + 1;
}

/**
 * Author, version and "Generated on" from a leading block comment.
 * The closer is found with indexOf inside a capped window, and each line is
 * scanned once. The old patterns overlapped whitespace runs with a following
 * lazy match, which is polynomial on a long line of spaces or stars.
 * `work`, when given, accumulates the characters examined, so tests can assert
 * linear growth without timing.
 */
export function parseHeader(src: string, work?: HeaderWork): Header | undefined {
  const end = Math.min(src.length, HEADER_CAP);
  const capped = end === src.length ? src : src.slice(0, end);
  let i = 0;
  while (i < capped.length && isHeaderSpace(capped.charCodeAt(i))) i++;
  let steps = i + 1;
  try {
    if (capped.charCodeAt(i) !== 47 || capped.charCodeAt(i + 1) !== 42) return undefined;
    const closeAt = capped.indexOf('*/', i + 2);
    // indexOf and split each read the comment body once.
    steps += 2 * ((closeAt < 0 ? capped.length : closeAt) - i);
    if (closeAt < 0) return undefined;
    const h: Header = {};
    for (const line of capped.slice(i + 2, closeAt).split(/\r\n|\n|\r/)) steps += takeHeaderLine(h, line);
    return Object.keys(h).length ? h : undefined;
  } finally {
    if (work) work.steps += steps;
  }
}

const CREATOR_TOP = new Set([
  'application',
  'form',
  'forms',
  'menu',
  'workflow',
  'functions',
  'page',
  'section',
  'reports',
  'pages',
  'share_settings',
  'roles',
  'translation',
  ...REPORT_TYPES,
  ...KNOWN_OPAQUE,
  ...CONFIG_BLOCKS,
]);

function top1(s: Statement): string | undefined {
  const g = sig(s)[0];
  return g && isGroup(g) ? g.open.text : undefined;
}

/** `ret name(args) { ... }` */
function isSignatureBlock(s: Statement): boolean {
  if (s.kind !== 'block') return false;
  const items = sig(s);
  return items.length >= 3 && isGroup(items[items.length - 2]) && (items[items.length - 2] as Group).open.text === '(';
}

/** Recognise the non-`application` files of a multi-file (shape C) export. */
function fragmentKind(top: Statement[]): 'functions' | 'profiles' | 'settings' | 'zml' | null {
  if (top.every((s) => isSignatureBlock(s))) return 'functions';
  if (top.some((s) => s.kind === 'block' && words(s).length === 1 && /^["']/.test(words(s)[0]))) return 'profiles';
  if (top.every((s) => s.kind === 'property')) return 'settings';
  if (top.every((s) => s.kind === 'group' && top1(s) === '{')) return 'settings';
  if (top.every((s) => s.kind === 'block' && words(s).length === 1 && body(s).some((c) => c.kind === 'property' && words(c)[0]?.toLowerCase() === 'content')))
    return 'settings';
  const first = sig(top[0])[0];
  if ((isToken(first) && first.text === '<') || (top[0].kind === 'word' && words(top[0])[0] === 'panel')) return 'zml';
  return null;
}

export function detectShape(doc: Document, header: Header | undefined): Shape {
  const top = doc.children.filter(isStatement);
  if (top.length === 0) return 'empty';
  if (top.some((s) => s.kind === 'block' && words(s)[0]?.toLowerCase() === 'application')) {
    const major = Number.parseInt(header?.version ?? '', 10);
    return Number.isFinite(major) && major >= 2 ? 'A' : 'B';
  }
  const creatorish = top.some((s) => {
    if (s.kind !== 'block') return false;
    const lw = lower(words(s));
    if (CREATOR_TOP.has(lw[0]) || CREATOR_TOP.has(lw.join(' ')) || (lw[0] === 'default' && REPORT_TYPES.has(lw[1]))) return true;
    if (!lw.includes('as')) return false;
    const type = prop(
      body(s).filter((c) => c.kind === 'property').map((c) => ({ key: words(c).join(' '), value: '', span: { start: 0, end: 0 } })),
      'type',
    );
    return type !== undefined;
  });
  if (creatorish) return 'C';
  if (fragmentKind(top)) return 'C';
  // Iterative: the recursive form overflowed the call stack on deeply nested
  // input (fuzz: 60k unclosed brackets).
  const stack: Node[] = [...doc.children];
  let semi = false;
  while (stack.length > 0 && !semi) {
    const n = stack.pop()!;
    if (isToken(n)) semi = n.kind === 'punct' && n.text === ';';
    else for (const c of n.children) stack.push(c);
  }
  if (semi) return 'deluge';
  return 'unknown';
}

export function emptyApp(shape: Shape): App {
  return {
    irVersion: IR_VERSION,
    shape,
    settings: [],
    sections: [],
    forms: [],
    reports: [],
    pages: [],
    workflows: [],
    functions: [],
    permissions: [],
    profiles: [],
    roles: [],
    shareSettings: [],
    translations: [],
    configuration: [],
    apis: [],
    devices: [],
    unknown: [],
    unmodelled: [],
    statementCount: 0,
  };
}

/** Device of a multi-file export path: `.../devices/phone/forms.ds`, `.../reports/R/devices/web.ds`. */
export function deviceOfPath(file: string | undefined): string | undefined {
  const m = file ? /(?:^|\/)devices\/(web|phone|tablet)(?:\/|\.ds$)/i.exec(file) : null;
  return m ? m[1].toLowerCase() : undefined;
}

/** Derive IR v1 from one parsed `.ds` file. `roles` receives the IR role of every modelled statement. */
export function deriveIr(doc: Document, file?: string, roles: Map<Statement, string> = new Map()): App {
  const header = parseHeader(doc.source);
  const shape = detectShape(doc, header);
  const app = emptyApp(shape);
  if (header) app.header = header;
  const ctx: Ctx = { app, src: doc.source, file, device: deviceOfPath(file), roles };
  const top = doc.children.filter(isStatement);
  if (shape === 'deluge') {
    // A bare Deluge script (custom function file). Keep it whole.
    const start = top[0].start;
    const end = top[top.length - 1].end;
    app.functions.push({
      name: file ?? '',
      kind: 'script',
      deluge: [{ text: doc.source.slice(start, end), span: span(ctx, { start, end }) }],
      properties: [],
      span: span(ctx, { start, end }),
    });
    app.statementCount = top.length;
    for (const s of top) claimAll(ctx, s, 'deluge');
    return app;
  }
  if (shape === 'C' && fragmentKind(top) === 'zml') {
    // A page stored as its own ZML file. Kept whole, like `Content="<zml>..."` in monolithic exports.
    const start = top[0].start;
    const end = top[top.length - 1].end;
    app.pages.push(page(ctx, file ?? '', doc.source.slice(start, end), [], { start, end }));
    app.statementCount = top.length;
    for (const s of top) claimAll(ctx, s, 'page.zml');
    return app;
  }
  visit(ctx, top, 'document');
  linkDeviceViews(app);
  app.dialect = detectDialect(doc).dialect;
  normaliseDialect(app);
  return app;
}

/** `Form[criteria]` on a schedule, approval, or blueprint is the record selector. A plain form name has no criteria. */
export function formLink(form: string | undefined): { name: string; criteria: string | null } {
  if (!form) return { name: '', criteria: null };
  const open = form.indexOf('[');
  if (open <= 0 || form[form.length - 1] !== ']') return { name: form, criteria: null };
  const name = form.slice(0, open).trim();
  const criteria = form.slice(open + 1, -1).trim();
  if (!/^[A-Za-z_][\w]*$/.test(name) || !criteria) return { name: form, criteria: null };
  return { name, criteria };
}

/** Creator approval process: the container, type, event, or approver list marks it. */
export function isApprovalWorkflow(w: Workflow): boolean {
  const blob = `${w.container ?? ''} ${w.type ?? ''} ${w.event}`;
  return /\bapproval\b/i.test(blob) || /\bon approve\b|\bon reject\b|\bon level\b/i.test(blob) || !!w.approvers?.length;
}

/** A workflow that declares blueprint stages or transitions. */
export function isBlueprintWorkflow(w: Workflow): boolean {
  const blueprint = w.blueprint;
  return !!blueprint && !!(blueprint.stages.length || blueprint.transitions.length || blueprint.start);
}

/** Creator payment workflows: the container, type, event, or name marks them. They are stubs, not schedules. */
export function isPaymentWorkflow(w: Workflow): boolean {
  return /\bpayments?\b/i.test(`${w.container ?? ''} ${w.type ?? ''} ${w.event} ${w.name}`);
}

/** A workflow inside a `schedule` container or with `type = schedule`. */
export function isScheduleWorkflow(w: Workflow): boolean {
  return /\bschedule\b/i.test(`${w.container ?? ''} ${w.type ?? ''}`);
}

/**
 * The schedule branch of codegen: payment, approval, and blueprint workflows
 * win over the schedule container, so a "Payment Reminder" def is not a
 * schedule at all.
 */
export function isScheduleBranchWorkflow(w: Workflow): boolean {
  if (isPaymentWorkflow(w)) return false;
  if (isBlueprintWorkflow(w)) return false;
  return !isApprovalWorkflow(w) && isScheduleWorkflow(w);
}

/**
 * A form schedule — `form = X[criteria]` on the schedule branch. The generated
 * sweeper Job fires the form's due rows; a custom schedule (no form) is a cron.
 */
export function isFormScheduleWorkflow(w: Workflow): boolean {
  return isScheduleBranchWorkflow(w) && !!formLink(w.form).name;
}

/** The `start` shape of a form schedule: `[before|after N units from] Field [at "HH:mm:ss"]`. */
export const FORM_SCHEDULE_START_RE =
  /^(?:(before|after)\s+(\d+)\s+(minutes?|hours?|days?|weeks?|months?|years?)\s+from\s+)?([A-Za-z_]\w*)(?:\s+at\s+"(\d{1,2}):(\d{2})(?::(\d{2}))?")?$/;

/** The repeating `frequency` values a form schedule sweep keeps; none means once. */
export const FORM_SCHEDULE_FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly']);

/** A `key = value` property of one workflow def (`start`, `frequency`, `time zone`, `end`). */
export function workflowProp(w: Workflow, key: string): string | undefined {
  return w.properties.find((p) => p.key.toLowerCase() === key)?.value?.trim();
}

/**
 * The date/datetime field a form schedule's `start` or `end` names, or null.
 * `Added_Time` and `Modified_Time` are record columns, always present.
 */
export function scheduleAnchorFieldType(app: App, form: string, field: string): 'Date' | 'DateTime' | null {
  if (field === 'Added_Time' || field === 'Modified_Time') return 'DateTime';
  const f = app.forms.find((x) => x.name === form)?.fields.find((x) => x.name === field);
  const type = (f?.type ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (type === 'date') return 'Date';
  if (type === 'datetime') return 'DateTime';
  return null;
}

/** The schedule's `time zone`, else the app setting; an invalid zone fails closed. */
export function scheduleTimeZone(app: App, w: Workflow): string | null {
  const raw = workflowProp(w, 'time zone') ?? app.settings.find((p) => p.key.toLowerCase() === 'time zone')?.value;
  const zone = raw ? unquote(raw).trim() : '';
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/**
 * Why the sweeper cannot fire a form schedule, or null when it can. The schema
 * planner and the code emitter share this one check so the checkpoint table is
 * planned exactly when a sweeper is emitted. `criteriaOk` reports whether the
 * `Form[criteria]` selector translated; a caller that cannot compile criteria
 * passes true, so an untranslatable selector can only ever keep the table.
 */
export function formScheduleSweepGap(app: App, w: Workflow, criteriaOk: boolean): string | null {
  const link = formLink(w.form);
  if (link.criteria && !criteriaOk) return 'workflow-action-condition';
  const m = FORM_SCHEDULE_START_RE.exec(workflowProp(w, 'start') ?? '');
  if (!m) return 'schedule-start';
  if (!scheduleAnchorFieldType(app, link.name, m[4]!)) return 'schedule-start';
  if (!scheduleTimeZone(app, w)) return 'schedule-time-zone';
  const frequency = workflowProp(w, 'frequency')?.toLowerCase();
  if (frequency && !FORM_SCHEDULE_FREQUENCIES.has(frequency)) return 'schedule-frequency';
  const end = workflowProp(w, 'end');
  if (end && (!/^[A-Za-z_]\w*$/.test(end) || !scheduleAnchorFieldType(app, link.name, end))) return 'schedule-start';
  return null;
}

/**
 * A field whose value identifies an app user: `type = users`, or a picklist
 * with `module = users` (Creator stores the user's login name there).
 */
export function isUsersField(field: Field): boolean {
  if (field.type?.trim().toLowerCase() === 'users') return true;
  return field.properties.some((p) => p.key.toLowerCase() === 'module' && unquote(p.value).trim().toLowerCase() === 'users');
}

/**
 * The Data Store column a state machine keeps its current stage in. `Status`
 * is used unless the form already carries a field of that name.
 */
export function flowStatusColumn(fields: readonly Field[]): string {
  const taken = new Set(fields.map((field) => field.name.toLowerCase()));
  for (const name of ['Status', 'Flow_Status']) {
    if (!taken.has(name.toLowerCase())) return name;
  }
  let n = 2;
  while (taken.has(`flow_status_${n}`)) n++;
  return `Flow_Status_${n}`;
}
