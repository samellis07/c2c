/**
 * No-silent-drop audit: every declared construct is either generated or listed.
 *
 * For every construct the `.ds` declares — forms, fields, reports, pages,
 * workflows, schedules, approvals, integrations, permissions, translations —
 * this checks the real generator outputs for either a produced artifact or an
 * explicit manual item / fidelity note, and reports every construct that is
 * neither. A caller can fail on any such silent drop.
 *
 * Produced-vs-listed per kind (each cites where the generator emits it):
 * - form: a `role: 'form'` table in generateSchema (packages/schema/src/generator.ts,
 *   one table per form). Listed: a severity 'unsupported' schema issue for the form.
 * - field: a schema field outcome with status other than 'unsupported'
 *   (supported and partial outcomes always store a column, a child table, or a
 *   junction table), or a generated UI widget (packages/ui/src/model.ts).
 *   Listed: an 'unsupported' schema issue or outcome, or a UI field todo.
 *   A field property, modifier, annotation, flag, choice list, lookup, initial
 *   value, required, or unique is emitted only when that setting is on the
 *   generated field or its schema column. A counted field counts every
 *   property. A dropped field adds no property rows.
 * - report / page: a 'generated' UI model entry (packages/ui/src/model.ts
 *   buildReport/buildPage). Listed: a UI todo naming the report, or the page,
 *   or one of its ZML elements. buildReport/buildPage always push a todo when
 *   the status is 'todo'.
 *   A report feature (column, filter, custom action, conditional format, sort,
 *   group, criteria, view, block) is emitted only when that construct is on
 *   the generated report model. A counted report counts every feature.
 *   A page element is emitted only when the generated page tree contains that
 *   ZML node and the behaviour the export asked for. A `todo` element counts it.
 * - workflow / schedule / approval / payment: the generate() branch for the
 *   workflow (packages/deluge/src/generate.ts workflowKind) emitted its file:
 *   a handler module, a job module with a planned cron or sweep
 *   (packages/deluge/src/schedules.ts planSchedules), a flow machine module
 *   (flowSpecs), or a payment stub for an unimplemented gateway. A merged form-event route
 *   is one module (`input-handlers.mjs`, `handler-handlers.mjs`) for every
 *   event in the group, so the per-event slug is not the file name.
 *   generate() records each workflow that wrote a non-empty part, and the
 *   paths that part landed in, on WorkflowCoverage. The audit treats that
 *   list as the produced artifact only when the server body is actually
 *   invoked: the generated client posts the route, or the submit/delete
 *   runtime calls it. A prefetch URL is not that call. When `serverInvoked`
 *   is false the workflow is not credited, even if its client file exists;
 *   it is listed by the `form-event-server-uninvoked` todo instead.
 *   The per-event slug still counts when the file is named for that one event
 *   and the server half is not an uninvoked one. A workflow with no script
 *   and no field rules declares no behaviour, so there is nothing to migrate.
 *   An empty sibling that shares the route is not credited with the group's
 *   file. Listed: a Deluge todo whose span sits inside the workflow span
 *   (translate todos are shifted into the script span; gap todos use the
 *   workflow span).
 * - integration: a `zoho.<service>.<task>()` call or an `invokeurl` is
 *   produced when the translator evaluates it locally (date/time/app env
 *   roots in packages/deluge/src/dispatch.ts ZOHO_ENV, or a `local` adapter
 *   in packages/shims/src/zoho-adapters.ts), and otherwise listed when the
 *   connections analysis surfaces it (packages/deluge/src/connections.ts
 *   entries, unsupported, or diagnostics, all rendered to CONNECTIONS.md).
 *   Payment-task calls are listed through the 'payments' Deluge todo.
 * - permission: a raw `permissions = {...}` literal is migrated when its
 *   owner is a profile or role (packages/auth/src/plan.ts turns profiles and
 *   hierarchy roles into Catalyst roles with table grants). On a
 *   `connections` block the literal is the connection's granted scope list,
 *   listed by the connections analysis diagnostic that names the declared
 *   scopes. Anything else has no consumer and must be listed.
 * - translation: nothing consumes translation blocks, so each one must be
 *   listed as an explicit manual step (a todo inside its span). The
 *   migration-report warning (construct 'translation-not-migrated') is not a
 *   counted manual item: a warning-only block is a drop.
 *
 * A construct labelled 'manual' that the generator actually produces is a
 * false listing, not coverage: the produced check runs first and wins.
 */

import type { App, Field, Property, PropertyBlock, Report, ReportView, Workflow } from '../../core/src/ir.js';
import { formLink, unquote } from '../../core/src/ir.js';
import { authPlan, type AuthPlan } from '../../auth/src/plan.js';
import { analyzeConnections, memberChain, permissionScopes, walk, type ConnectionsReport } from '../../deluge/src/connections.js';
import type { Expr } from '../../deluge/src/ast.js';
import { dispatchGet, ZOHO_ENV, ZOHO_PAYMENT } from '../../deluge/src/dispatch.js';
import { flowSpecs, generate, slug, workflowKind, type CoverageEntry, type FlowSpec, type GeneratedFile, type GenerateResult, type GenerateWarning, type WorkflowCoverage } from '../../deluge/src/generate.js';
import { parse } from '../../deluge/src/parser.js';
import type { Stmt } from '../../deluge/src/ast.js';
import { planSchedules, type SchedulePlan } from '../../deluge/src/schedules.js';
import { reportCriteria, type TodoItem } from '../../deluge/src/translate.js';
import { criteriaHasTodo } from '../../shims/src/criteria.js';
import { adapterFor } from '../../shims/src/zoho-adapters.js';
import { multiValueDefault } from '../../shims/src/multi-value.js';
import { generateSchema, schemaIdent, type SchemaColumn, type SchemaPlan } from '../../schema/src/generator.js';
import { buildModel, type UiField, type UiModel, type UiReport } from '../../ui/src/model.js';
import type { UiElement } from '../../ui/src/pages.js';
import { defaultEquivalent } from './default-equivalence.js';

export type DropKind =
  | 'form'
  | 'field'
  | 'field-property'
  | 'report'
  | 'report-feature'
  | 'page'
  | 'page-element'
  | 'workflow'
  | 'schedule'
  | 'approval'
  | 'function'
  | 'statement'
  | 'integration'
  | 'permission'
  | 'translation';

export interface SilentDrop {
  kind: DropKind;
  /** Construct identity without the app name (form, Form.Field, workflow, ...). */
  name: string;
  /** What is missing and what the user must do instead. */
  note: string;
}

/**
 * The generation-time coverage ledger (C3): one row per construct the `.ds`
 * declares, resolved to exactly one status.
 * - `emitted`: the construct produced a traceable generated artifact.
 * - `counted`: the construct is recorded as an explicit TODO / manual step.
 * - `dropped`: neither — a silent drop. Generation fails on these.
 */
export interface CoverageRow {
  kind: DropKind;
  name: string;
  status: 'emitted' | 'counted' | 'dropped';
  /** What covers the construct: a generated artifact path, or the listing surface (`todo`, `schema issue`, `migration-report warning`, ...). */
  via: string;
  /** Dropped rows only: what is missing and what to do instead. */
  note?: string;
}

/** The generator outputs one audit run reads. Tests may fabricate these to prove a direction. */
export interface AuditOutputs {
  schema: SchemaPlan;
  model: UiModel;
  files: GeneratedFile[];
  todos: TodoItem[];
  warnings: GenerateWarning[];
  auth: AuthPlan;
  connections: ConnectionsReport;
  schedules: Map<Workflow, SchedulePlan>;
  specs: FlowSpec[];
  /**
   * Form workflows emitFormHandler wrote into a module. Absent when a test
   * fabricates outputs that predate this field. A merged route names one
   * file for several events; each entry lists only the files that workflow
   * contributed.
   */
  coverage?: WorkflowCoverage[];
  /** Statement coverage ledger rows the generators emitted (generate().statementCoverage, absolute spans). */
  statementCoverage: CoverageEntry[];
}

/** Run every generator over the app and bundle the outputs the audit reads. `parts` reuses already-computed results (analyze runs the same generators). */
export function collectOutputs(app: App, parts?: { schema?: SchemaPlan; gen?: GenerateResult; model?: UiModel }): AuditOutputs {
  const schema = parts?.schema ?? generateSchema(app);
  const gen = parts?.gen ?? generate(app);
  const model = parts?.model ?? buildModel(app, gen.files);
  const auth = authPlan(app);
  const connections = analyzeConnections(app);
  const schedules = planSchedules(
    app,
    app.workflows.filter((w) => workflowKind(w) === 'schedule'),
    formLink,
    (src) => {
      const criteria = reportCriteria(src, app.functions);
      return criteriaHasTodo(criteria) ? null : criteria;
    },
  );
  let warnings: GenerateWarning[] = [];
  try {
    warnings = (JSON.parse(gen.files.find((f) => f.path === 'migration-report.json')?.source ?? '{}') as { warnings?: GenerateWarning[] }).warnings ?? [];
  } catch {
    warnings = [];
  }
  return { schema, model, files: gen.files, todos: gen.todos, warnings, auth, connections, schedules, specs: flowSpecs(app), coverage: gen.coverage, statementCoverage: gen.statementCoverage };
}

function within(inner: { start: number; end: number }, outer: { start: number; end: number }): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

/** Deluge todos that sit inside the workflow: its listed manual items. */
function listedTodos(todos: readonly TodoItem[], w: Workflow): TodoItem[] {
  return todos.filter((t) => within(t, w.span));
}

function auditForm(app: App, out: AuditOutputs, rows: CoverageRow[]): void {
  for (const form of app.forms) {
    const produced = out.schema.tables.some((t) => t.form === form.name && t.role !== 'system');
    if (produced) {
      rows.push({ kind: 'form', name: form.name, status: 'emitted', via: 'schema table' });
      continue;
    }
    const listed = out.schema.issues.some((i) => i.severity === 'unsupported' && i.form === form.name && i.field === undefined);
    if (listed) {
      rows.push({ kind: 'form', name: form.name, status: 'counted', via: 'schema issue' });
      continue;
    }
    rows.push({
      kind: 'form',
      name: form.name,
      status: 'dropped',
      via: 'none',
      note: `Form ${form.name} has no generated table and no fidelity note. Add one: either migrate the form or record why it cannot be migrated.`,
    });
  }
}

/** Every field of a form, subfields included (subforms, composite parts). */
function eachField(app: App, visit: (form: string, field: App['forms'][number]['fields'][number]) => void): void {
  const walk = (form: string, fields: App['forms'][number]['fields']): void => {
    for (const field of fields) {
      visit(form, field);
      walk(form, field.subfields);
    }
  };
  for (const form of app.forms) walk(form.name, form.fields);
}

function auditField(app: App, out: AuditOutputs, rows: CoverageRow[]): void {
  for (const form of app.forms) {
    const uiFields = out.model.forms.find((f) => f.name === form.name)?.fields ?? [];
    for (const field of form.fields) {
      const outcome = out.schema.fields.find((o) => o.form === form.name && o.field === field.name);
      const uiGenerated = uiFields.some((u) => u.name === field.name && u.status === 'generated');
      if ((outcome && outcome.status !== 'unsupported') || uiGenerated) {
        rows.push({ kind: 'field', name: `${form.name}.${field.name}`, status: 'emitted', via: outcome ? 'schema field outcome' : 'UI widget' });
        continue;
      }
      const listed =
        (outcome && outcome.status === 'unsupported') ||
        out.schema.issues.some((i) => i.severity === 'unsupported' && i.form === form.name && i.field === field.name) ||
        out.model.todos.some((t) => t.area === 'field' && t.name === `${form.name}.${field.name}`);
      if (listed) {
        rows.push({ kind: 'field', name: `${form.name}.${field.name}`, status: 'counted', via: 'schema issue / UI todo' });
        continue;
      }
      rows.push({
        kind: 'field',
        name: `${form.name}.${field.name}`,
        status: 'dropped',
        via: 'none',
        note: `Field ${form.name}.${field.name} has no generated column and no fidelity note. Add one: either migrate the field or record what the user must re-enter.`,
      });
    }
  }
}

/**
 * Field-level settings are emitted only when the generated field or its schema
 * column carries that setting. A counted field (or a field whose whole span is
 * a manual item) counts every setting. A field that is itself dropped is
 * reported once by auditField; its properties add no rows of their own.
 */
function auditFieldProperties(app: App, out: AuditOutputs, rows: CoverageRow[]): void {
  const fieldRow = new Map(rows.filter((r) => r.kind === 'field').map((r) => [r.name, r.status]));
  eachField(app, (formName, field) => {
    const status = fieldRow.get(`${formName}.${field.name}`);
    if (status !== 'emitted' && status !== 'counted') return;
    const items = fieldSettingItems(field, app, formName, out.schema);
    if (status === 'counted' || fieldListed(out, formName, field)) {
      for (const item of items) {
        rows.push({ kind: 'field-property', name: `${formName}.${field.name} ${item.label}`, status: 'counted', via: 'field manual item' });
      }
      return;
    }
    const ui = findUiField(out.model, formName, field.name);
    const columns = findColumns(out.schema, formName, field.name);
    for (const item of items) {
      const name = `${formName}.${field.name} ${item.label}`;
      if (spanCovered(out, item.start, item.end)) {
        rows.push({ kind: 'field-property', name, status: 'counted', via: 'todo' });
        continue;
      }
      if (item.proved(ui, columns)) {
        rows.push({ kind: 'field-property', name, status: 'emitted', via: 'field setting' });
        continue;
      }
      rows.push({
        kind: 'field-property',
        name,
        status: 'dropped',
        via: 'none',
        note: `Field ${formName}.${field.name} ${item.label} is not in the generated field. Add one: either emit the setting or record the manual step.`,
      });
    }
  });
}

interface FieldSetting {
  label: string;
  start: number;
  end: number;
  proved: (ui: UiField | undefined, columns: SchemaColumn[]) => boolean;
}

function fieldSettingItems(field: Field, app: App, formName: string, schema: SchemaPlan): FieldSetting[] {
  const span = field.span;
  const items: FieldSetting[] = [];
  for (const p of field.properties) {
    const bidirectional = p.key.trim().toLowerCase() === 'bidirectional';
    items.push({
      label: `property ${p.key}`,
      start: p.span.start,
      end: p.span.end,
      proved: (ui, columns) => (bidirectional ? bidirectionalProved(p, field, formName, app, schema) : propertyProved(p, field, ui, columns, app)),
    });
  }
  for (const modifier of field.modifiers) {
    items.push({
      label: `modifier ${modifier}`,
      start: span.start,
      end: span.end,
      proved: (ui, columns) => modifierProved(modifier, ui, columns),
    });
  }
  for (const annotation of field.annotations) {
    items.push({
      label: `annotation ${annotation.name}`,
      start: annotation.span?.start ?? span.start,
      end: annotation.span?.end ?? span.end,
      proved: () => false,
    });
  }
  for (const flag of field.flags) {
    items.push({
      label: `flag ${flag}`,
      start: span.start,
      end: span.end,
      proved: (ui) => flagProved(flag, ui),
    });
  }
  if (field.choices) {
    items.push({ label: 'choices', start: span.start, end: span.end, proved: (ui) => choicesProved(field, ui) });
  }
  if (field.lookup) {
    const lookup = field.lookup;
    items.push({
      label: `lookup ${lookup.form}${lookup.field ? `.${lookup.field}` : ''}`,
      start: span.start,
      end: span.end,
      proved: (ui, columns) => lookupProved(lookup, ui, columns, app),
    });
  }
  if (field.initialValue !== undefined) {
    items.push({
      label: 'initial value',
      start: span.start,
      end: span.end,
      proved: (ui, columns) => initialProved(field.initialValue ?? '', ui, columns),
    });
  }
  if (field.required) {
    items.push({ label: 'required', start: span.start, end: span.end, proved: (ui, columns) => requiredProved(ui, columns) });
  }
  if (field.unique) {
    items.push({ label: 'unique', start: span.start, end: span.end, proved: (ui, columns) => uniqueProved(ui, columns) });
  }
  return items;
}

function fieldListed(out: AuditOutputs, formName: string, field: Field): boolean {
  return (
    out.model.todos.some((t) => t.area === 'field' && t.name === `${formName}.${field.name}`) ||
    out.schema.issues.some((i) => i.severity === 'unsupported' && i.form === formName && i.field === field.name)
  );
}

function findUiField(model: UiModel, formName: string, fieldName: string): UiField | undefined {
  const form = model.forms.find((item) => item.name === formName);
  if (!form) return undefined;
  const walk = (fields: UiField[]): UiField | undefined => {
    for (const item of fields) {
      if (item.name === fieldName) return item;
      if (item.subfields?.length) {
        const hit = walk(item.subfields);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(form.fields);
}

function findColumns(schema: SchemaPlan, formName: string, fieldName: string): SchemaColumn[] {
  const ident = schemaIdent(fieldName, 'col');
  const columns: SchemaColumn[] = [];
  for (const table of schema.tables) {
    if (table.form !== formName) continue;
    for (const column of table.columns) {
      if (column.field === fieldName || column.name === fieldName || column.name === ident) columns.push(column);
    }
  }
  return columns;
}

function propertyProved(p: Property, field: Field, ui: UiField | undefined, columns: SchemaColumn[], app: App): boolean {
  const key = p.key.trim().toLowerCase().replace(/\s+/g, ' ');
  const raw = p.value;
  const text = unquote(raw).trim();
  if (defaultEquivalent(key, text, ui)) return true;
  if (key === 'type') return ui !== undefined || columns.length > 0;
  if (key === 'displayname') {
    const plain = unquote(raw);
    return ui?.label === plain || ui?.label === plain.trim();
  }
  if (key === 'values') return choicesProved(field, ui) || lookupProved(field.lookup, ui, columns, app);
  if (key === 'initial value') return initialProved(raw, ui, columns);
  if (key === 'maxchar' || key === 'max char' || key === 'max length') return lengthProved(text, ui?.maxLength, columns, 'max');
  if (key === 'minchar' || key === 'min char' || key === 'min length') return lengthProved(text, ui?.minLength, columns, 'min');
  if (key === 'regex' || key === 'pattern' || key.includes('regex')) return ui?.pattern === text;
  if (key === 'decimalplace' || key === 'decimal places' || key === 'decimal digits') return placesProved(text, ui, columns);
  if (key === 'row') return intEqual(text, ui?.row);
  if (key === 'column') return intEqual(text, ui?.column);
  if (key === 'width') return ui?.width === text;
  if (key === 'height') return ui?.height === text;
  if (key === 'visibility') return visibilityProved(text, ui);
  if (key === 'alloweddays') return allowedDaysProved(text, ui);
  if (key === 'start index') {
    const rawTrim = raw.trim();
    return columns.some((column) => {
      const note = column.note ?? '';
      return note.includes(`start index ${text}`) || note.includes(`start index ${rawTrim}`);
    });
  }
  return false;
}

function lengthProved(text: string, uiLength: number | undefined, columns: SchemaColumn[], bound: 'max' | 'min'): boolean {
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (uiLength === n) return true;
  if (bound === 'min') return false;
  return columns.some((column) => column.length === n || column.length === Math.min(n, 255));
}

function placesProved(text: string, ui: UiField | undefined, columns: SchemaColumn[]): boolean {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0) return false;
  return ui?.decimalPlaces === n || columns.some((column) => column.precision === n);
}

function intEqual(text: string, value: number | undefined): boolean {
  if (value === undefined) return false;
  const n = Number(text);
  return Number.isInteger(n) && n === value;
}

/** `visibility = true` is the default and is omitted on ordinary widgets. */
function visibilityProved(text: string, ui: UiField | undefined): boolean {
  const shown = text.toLowerCase() !== 'false';
  if (!shown) return ui?.visibility === false;
  return ui?.visibility !== false;
}

/**
 * `alloweddays = 0,1,2,3,4,5,6` (every weekday) is the Creator default. The
 * generated date and datetime widgets are native inputs with no weekday
 * restriction, so every day stays selectable. A restricted set is not emitted.
 */
function allowedDaysProved(text: string, ui: UiField | undefined): boolean {
  if (ui?.widget !== 'date' && ui?.widget !== 'datetime') return false;
  const days = new Set(text.split(',').map((day) => day.trim()));
  return days.size === 7 && ['0', '1', '2', '3', '4', '5', '6'].every((day) => days.has(day));
}

/**
 * A `bidirectional = Back` lookup pair is stored as one foreign key, which the
 * schema generator places from the linked grid side (packages/schema
 * generator.ts pendingRefs): a grid on form A pointing at T names its reverse
 * column `Back` on T, related to A's table, or reuses that column when T
 * already declares it. The pair is proved only when that named column exists
 * with the right relation and the generator did not fall back to an unnamed
 * back column. A pair without a linked grid side gets no reverse column from
 * the schema generator and is not proved here.
 */
function bidirectionalProved(p: Property, field: Field, formName: string, app: App, schema: SchemaPlan): boolean {
  const target = field.lookup?.form;
  const back = unquote(p.value).trim();
  if (!target || !back) return false;
  const table = (form: string): string | undefined => schema.tables.find((t) => t.form === form && t.role === 'form')?.name;
  const own = table(formName);
  const other = table(target);
  if (!own || !other) return false;
  const linkedGrid = (item: Field | undefined, to: string): boolean =>
    item !== undefined && ['grid', 'subform', 'form'].includes((item.type ?? '').trim().toLowerCase()) && item.lookup?.form === to;
  // The FK column `name` on the holder form's own table relates to table
  // `to`, and no fallback back column (created without the bidirectional name)
  // relates the same two tables. A same-named column on one of the form's
  // child or junction tables is unrelated storage and never proves the pair.
  const stored = (holder: string, name: string, to: string): boolean => {
    const holderTable = schema.tables.find((t) => t.form === holder && t.role === 'form');
    if (!holderTable) return false;
    const ident = schemaIdent(name, 'col');
    const named = holderTable.columns.filter((column) => column.field === name || column.name === name || column.name === ident);
    if (!named.some((column) => column.relation?.table === to)) return false;
    return !holderTable.columns.some((column) => column.creatorType === 'subform' && column.relation?.table === to && !named.includes(column));
  };
  if (linkedGrid(field, target)) return stored(target, back, own);
  const partner = app.forms.find((form) => form.name === target)?.fields.find((item) => item.name === back);
  const partnerBack = partner?.properties.find((item) => item.key.trim().toLowerCase() === 'bidirectional');
  if (!linkedGrid(partner, formName) || unquote(partnerBack?.value ?? '').trim() !== field.name) return false;
  return stored(formName, field.name, other);
}

function choicesProved(field: Field, ui: UiField | undefined): boolean {
  const choices = field.choices ?? [];
  if (!choices.length) return true;
  const got = ui?.choices ?? [];
  return choices.every((choice) => got.includes(choice));
}

function lookupProved(lookup: Field['lookup'], ui: UiField | undefined, columns: SchemaColumn[], app: App): boolean {
  if (!lookup) return false;
  if (ui?.lookup && ui.lookup.form === lookup.form && (!lookup.field || ui.lookup.field === lookup.field)) return true;
  if (columns.some((column) => column.relation !== undefined)) return true;
  // A linked subform stores the other form's fields as its grid, not a lookup widget.
  if (ui?.widget === 'subform' && ui.subfields?.length) {
    const names = new Set(app.forms.find((form) => form.name === lookup.form)?.fields.map((item) => item.name));
    return ui.subfields.some((sub) => names.has(sub.name));
  }
  return false;
}

function initialProved(raw: string, ui: UiField | undefined, columns: SchemaColumn[]): boolean {
  const plain = unquote(raw);
  const multi = multiValueDefault(raw);
  const candidates = [raw, plain, ...(multi !== undefined ? [multi] : [])];
  if (ui?.initialValue !== undefined && candidates.some((candidate) => sameStored(candidate, ui.initialValue))) return true;
  return columns.some((column) => column.defaultValue !== undefined && candidates.some((candidate) => sameStored(candidate, column.defaultValue)));
}

function sameStored(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  if (expected === actual) return true;
  const left = Number(expected);
  const right = Number(actual);
  return expected.trim() !== '' && actual.trim() !== '' && Number.isFinite(left) && Number.isFinite(right) && left === right;
}

function requiredProved(ui: UiField | undefined, columns: SchemaColumn[]): boolean {
  return ui?.required === true || columns.some((column) => column.mandatory || column.appMandatory === true);
}

function uniqueProved(ui: UiField | undefined, columns: SchemaColumn[]): boolean {
  return ui?.unique === true || columns.some((column) => column.unique || column.appUnique === true);
}

function modifierProved(modifier: string, ui: UiField | undefined, columns: SchemaColumn[]): boolean {
  const name = modifier.trim().toLowerCase();
  // The parser stores `must have` as the two words `must` and `have`. Both are the required flag.
  if (name === 'must have' || name === 'required' || name === 'must' || name === 'have') return requiredProved(ui, columns);
  if (name === 'unique') return uniqueProved(ui, columns);
  return false;
}

function flagProved(flag: string, ui: UiField | undefined): boolean {
  if (/scan|qr|barcode/i.test(flag)) return ui?.scan === true;
  return false;
}

function spanCovered(out: AuditOutputs, start: number, end: number): boolean {
  return out.todos.some((todo) => todo.start <= start && todo.end >= end);
}

function auditReport(app: App, out: AuditOutputs, rows: CoverageRow[]): void {
  for (const report of app.reports) {
    const built = out.model.reports.find((r) => r.name === report.name);
    if (built && built.status === 'generated') {
      rows.push({ kind: 'report', name: report.name, status: 'emitted', via: 'UI report view' });
      continue;
    }
    const listed = out.model.todos.some((t) => t.area === 'report' && t.name === report.name);
    if (listed) {
      rows.push({ kind: 'report', name: report.name, status: 'counted', via: 'UI report todo' });
      continue;
    }
    rows.push({
      kind: 'report',
      name: report.name,
      status: 'dropped',
      via: 'none',
      note: `Report ${report.name} is not generated and has no fidelity note. Add one: either migrate the report or record what the user must rebuild.`,
    });
  }
}

/**
 * Report-level features: columns, filters, custom actions, conditional
 * formats, views, sort/group, criteria, settings blocks. Each one is emitted
 * only when the generated report model contains that construct. A Deluge todo
 * on its span counts it. On a counted report every feature is counted by the
 * report-level manual item. A dropped report names the whole construct once —
 * its features add no rows.
 *
 * `REPORT_VIEW` mirrors packages/ui/src/model.ts. A specialized view (kanban,
 * calendar, …) that the model did not keep is its own row.
 */
const REPORT_VIEW: Record<string, string> = {
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

interface ReportFeature {
  label: string;
  start: number;
  end: number;
  /** 'counted' when the artefact exists but only as an explicit fidelity hole. */
  prove: (built: UiReport, bag: ReportBag) => 'emitted' | 'counted' | 'dropped';
}

interface ReportBag {
  columns: string[];
  filters: { field?: string; label?: string }[];
  actions: string[];
  formats: NonNullable<UiReport['conditionalFormats']>;
  sort: string[];
  groups: string[];
  groupFieldUsed: boolean;
}

function auditReportFeatures(app: App, out: AuditOutputs, rows: CoverageRow[]): void {
  const reportRow = new Map(rows.filter((r) => r.kind === 'report').map((r) => [r.name, r.status]));
  for (const report of app.reports) {
    const status = reportRow.get(report.name);
    if (status !== 'emitted' && status !== 'counted') continue;
    const features = reportFeatures(report);
    if (status === 'counted') {
      for (const feature of features) {
        rows.push({ kind: 'report-feature', name: `${report.name} ${feature.label}`, status: 'counted', via: 'report manual item' });
      }
      continue;
    }
    const built = out.model.reports.find((item) => item.name === report.name);
    const bag = built ? reportBag(built) : emptyReportBag();
    for (const feature of features) {
      const name = `${report.name} ${feature.label}`;
      if (spanCovered(out, feature.start, feature.end)) {
        rows.push({ kind: 'report-feature', name, status: 'counted', via: 'todo' });
        continue;
      }
      const verdict = built ? feature.prove(built, bag) : 'dropped';
      if (verdict === 'dropped') {
        rows.push({
          kind: 'report-feature',
          name,
          status: 'dropped',
          via: 'none',
          note: `Report ${report.name} ${feature.label} is not in the generated report. Add one: either emit it or record the manual step.`,
        });
        continue;
      }
      rows.push({ kind: 'report-feature', name, status: verdict, via: verdict === 'counted' ? 'conditional format todo' : 'UI report view' });
    }
    if (built) pushSpecializedView(report, built, out, rows);
  }
}

function reportFeatures(report: Report): ReportFeature[] {
  const cols = (list: Report['columns'], prefix: string): ReportFeature[] =>
    list.flatMap((column) => [
      {
        label: `${prefix}column ${column.field}`,
        start: column.span.start,
        end: column.span.end,
        prove: (_built, bag) => (take(bag.columns, column.field) ? 'emitted' : 'dropped'),
      },
      ...cols(column.subcolumns, `${prefix}column ${column.field} `),
    ]);
  return [
    ...(report.criteria?.trim()
      ? [
          {
            label: 'criteria',
            start: report.span.start,
            end: report.span.end,
            prove: (built: UiReport) => (built.criteria && built.criteria.op !== 'todo' ? 'emitted' : 'dropped'),
          } satisfies ReportFeature,
        ]
      : []),
    ...(report.basedOn
      ? [
          {
            label: `based on ${report.basedOn}`,
            start: report.span.start,
            end: report.span.end,
            prove: (built: UiReport) => (built.basedOn === report.basedOn || built.startField === report.basedOn ? 'emitted' : 'dropped'),
          } satisfies ReportFeature,
        ]
      : []),
    ...cols(report.columns, ''),
    ...report.filters.map(
      (filter): ReportFeature => ({
        label: `filter ${filter.label || filter.field || 'criteria'}`,
        start: filter.span.start,
        end: filter.span.end,
        prove: (_built, bag) => (takeFilter(bag, filter) ? 'emitted' : 'dropped'),
      }),
    ),
    ...report.customActions.map(
      (action): ReportFeature => ({
        label: `custom action ${action.name}`,
        start: action.span.start,
        end: action.span.end,
        prove: (_built, bag) => (take(bag.actions, action.name) ? 'emitted' : 'dropped'),
      }),
    ),
    ...report.conditionalFormats.map(
      (format): ReportFeature => ({
        label: `conditional format ${format.name}`,
        start: format.span.start,
        end: format.span.end,
        prove: (_built, bag) => takeFormat(bag, format.name),
      }),
    ),
    ...report.sortBy.map(
      (item): ReportFeature => ({
        label: `sort by ${item.field}`,
        start: report.span.start,
        end: report.span.end,
        prove: (_built, bag) => (take(bag.sort, item.field) ? 'emitted' : 'dropped'),
      }),
    ),
    ...report.groupBy.map(
      (item): ReportFeature => ({
        label: `group by ${item.field}`,
        start: report.span.start,
        end: report.span.end,
        prove: (built, bag) => (takeGroup(built, bag, item.field) ? 'emitted' : 'dropped'),
      }),
    ),
    ...report.views.map(
      (view): ReportFeature => ({
        label: `${view.kind}${view.device ? ` ${view.device}` : ''}`,
        start: view.span.start,
        end: view.span.end,
        prove: (built) => (viewProved(built, view) ? 'emitted' : 'dropped'),
      }),
    ),
    ...report.blocks.map(
      (block): ReportFeature => ({
        label: `block ${block.name}`,
        start: block.span?.start ?? report.span.start,
        end: block.span?.end ?? report.span.end,
        prove: (built) => (blockProved(built, block) ? 'emitted' : 'dropped'),
      }),
    ),
  ];
}

function emptyReportBag(): ReportBag {
  return { columns: [], filters: [], actions: [], formats: [], sort: [], groups: [], groupFieldUsed: false };
}

/** Columns, phone columns, and detail-block fields all count as an emitted column. */
function reportBag(built: UiReport): ReportBag {
  const columns: string[] = [];
  for (const column of built.columns) columns.push(column.field);
  for (const column of built.phoneColumns ?? []) columns.push(column.field);
  for (const block of built.detailBlocks ?? []) for (const field of block.fields) columns.push(field.field);
  const actions = [
    ...built.customActions.map((action) => action.name),
    ...built.columns.filter((column) => column.action).map((column) => column.field),
  ];
  return {
    columns,
    filters: built.filters.map((filter) => ({ ...(filter.field ? { field: filter.field } : {}), ...(filter.label ? { label: filter.label } : {}) })),
    actions,
    formats: [...(built.conditionalFormats ?? [])],
    sort: built.sort.map((item) => item.field),
    groups: built.groupBy.map((item) => item.field),
    groupFieldUsed: false,
  };
}

function take(bag: string[], value: string): boolean {
  const index = bag.indexOf(value);
  if (index < 0) return false;
  bag.splice(index, 1);
  return true;
}

function takeFilter(bag: ReportBag, filter: { field?: string; label?: string }): boolean {
  const index = bag.filters.findIndex((item) => (item.field ?? '') === (filter.field ?? '') && (item.label ?? '') === (filter.label ?? ''));
  if (index < 0) return false;
  bag.filters.splice(index, 1);
  return true;
}

function takeFormat(bag: ReportBag, name: string): 'emitted' | 'counted' | 'dropped' {
  const index = bag.formats.findIndex((format) => format.name === name);
  if (index < 0) return 'dropped';
  const format = bag.formats[index]!;
  bag.formats.splice(index, 1);
  return criteriaIsTodo(format.criteria) ? 'counted' : 'emitted';
}

function takeGroup(built: UiReport, bag: ReportBag, field: string): boolean {
  if (take(bag.groups, field)) return true;
  if (!bag.groupFieldUsed && built.groupField === field) {
    bag.groupFieldUsed = true;
    return true;
  }
  return false;
}

function criteriaIsTodo(criteria: unknown): boolean {
  return !!criteria && typeof criteria === 'object' && (criteria as { op?: string }).op === 'todo';
}

function viewProved(built: UiReport, view: ReportView): boolean {
  if (view.kind === 'quickview') {
    const fields = view.blocks.flatMap((block) => block.fields.map((field) => field.field).filter(Boolean));
    if (!fields.length) return true;
    const shown = new Set([...built.columns.map((column) => column.field), ...(built.phoneColumns ?? []).map((column) => column.field)]);
    return fields.every((field) => shown.has(field));
  }
  if (!built.detail) return false;
  if (!view.blocks.length) return true;
  return view.blocks.every((block) => {
    const title = block.title || block.name;
    const found = (built.detailBlocks ?? []).find((item) => item.title === title || item.title === block.name);
    if (!found) return false;
    return block.fields.every((field) => !field.field || found.fields.some((item) => item.field === field.field));
  });
}

/** An `options` block is emitted only when every property landed on the report. Any other block has no model home. */
function blockProved(built: UiReport, block: PropertyBlock): boolean {
  if (block.name.trim().toLowerCase() !== 'options') return false;
  return block.properties.every((property) => optionProved(built, property));
}

function optionProved(built: UiReport, property: Property): boolean {
  const key = property.key.trim().toLowerCase().replace(/\s+/g, ' ');
  const value = unquote(property.value).trim();
  if (key === 'display field') return built.groupField === value || built.titleField === value;
  if (key === 'start date') return built.startField === value;
  if (key === 'end date') return built.endField === value;
  return false;
}

function pushSpecializedView(report: Report, built: UiReport, out: AuditOutputs, rows: CoverageRow[]): void {
  const expected = REPORT_VIEW[report.type.toLowerCase()] ?? 'todo';
  if (expected === 'list' || built.view === expected) return;
  const name = `${report.name} view ${report.type}`;
  const listed =
    !!built.note ||
    out.model.todos.some((todo) => todo.area === 'report' && todo.name === report.name) ||
    spanCovered(out, report.span.start, report.span.end);
  if (listed) {
    rows.push({ kind: 'report-feature', name, status: 'counted', via: built.note ? 'UI report note' : 'todo' });
    return;
  }
  rows.push({
    kind: 'report-feature',
    name,
    status: 'dropped',
    via: 'none',
    note: `Report ${report.name} view ${report.type} is not the generated view (${built.view}). Add one: either emit the ${report.type} view or record the manual step.`,
  });
}

function auditPage(app: App, out: AuditOutputs, rows: CoverageRow[]): void {
  for (const page of app.pages) {
    const built = out.model.pages.find((p) => p.name === page.name);
    if (built && built.status === 'generated') {
      rows.push({ kind: 'page', name: page.name, status: 'emitted', via: 'UI page' });
      continue;
    }
    const listed = out.model.todos.some((t) => (t.area === 'page' && t.name === page.name) || (t.area === 'zml' && t.name.startsWith(`${page.name}.`)));
    if (listed) {
      rows.push({ kind: 'page', name: page.name, status: 'counted', via: 'UI page todo' });
      continue;
    }
    rows.push({
      kind: 'page',
      name: page.name,
      status: 'dropped',
      via: 'none',
      note: `Page ${page.name} is not generated and has no fidelity note. Add one: either migrate the page or record what the user must rebuild.`,
    });
  }
}

/**
 * Every ZML node, not only the top level. A node is emitted when the generated
 * page tree contains it and the behaviour the export asked for (a supported
 * KPI, copied parameters, copied criteria). A node the generator marked `todo`
 * is counted. A same-tag todo does not cover a node that was generated without
 * its payload — that payload is the drop. A page todo, or a zml todo naming
 * this element, counts a node the tree does not contain.
 */
function auditPageElements(app: App, out: AuditOutputs, rows: CoverageRow[]): void {
  for (const page of app.pages) {
    const built = out.model.pages.find((item) => item.name === page.name);
    const pool = flattenUi(built?.elements ?? []);
    walkZml(page.zml, (el) => {
      const label = zmlName(el.attributes) || el.tag;
      const name = `${page.name}.${label}`;
      const found = takeElement(pool, el);
      if (found?.kind === 'todo') {
        rows.push({ kind: 'page-element', name, status: 'counted', via: 'UI zml todo' });
        return;
      }
      const gap = found ? pageBehaviorGap(el, found) : 'missing';
      if (found && !gap) {
        rows.push({ kind: 'page-element', name, status: 'emitted', via: 'UI page element' });
        return;
      }
      const namedTodo = out.model.todos.some((todo) => todo.area === 'zml' && (todo.name === name || todo.name === `${page.name}.${zmlName(el.attributes)}`));
      const tagTodo = !found && out.model.todos.some((todo) => todo.area === 'zml' && todo.name === `${page.name}.${el.tag}`);
      const pageTodo = out.model.todos.some((todo) => todo.area === 'page' && todo.name === page.name);
      if (namedTodo || tagTodo || pageTodo) {
        rows.push({ kind: 'page-element', name, status: 'counted', via: pageTodo && !namedTodo && !tagTodo ? 'UI page todo' : 'UI zml todo' });
        return;
      }
      const why = gap === 'missing' ? 'is not in the generated page' : `is generated without its ${gap}`;
      rows.push({
        kind: 'page-element',
        name,
        status: 'dropped',
        via: 'none',
        note: `ZML element <${el.tag}> ${label} on page ${page.name} ${why}. Add one: either emit the element or record the manual step.`,
      });
    });
  }
}

type ZmlNode = App['pages'][number]['zml'][number];

const SUPPORTED_KPI = new Set(['count', 'sum']);
const UNSUPPORTED_KPI = new Set(['distinctcount', 'distinct', 'avg', 'average', 'min', 'max']);

function walkZml(nodes: ZmlNode[], visit: (el: ZmlNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walkZml(node.children, visit);
  }
}

function flattenUi(nodes: UiElement[]): UiElement[] {
  const out: UiElement[] = [];
  const walk = (el: UiElement): void => {
    out.push(el);
    for (const child of el.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return out;
}

/** Generator name order: linkName, formLinkName, componentLinkName, elementName, name, id. */
function zmlName(attributes: Record<string, string>): string | undefined {
  return ciAttr(attributes, ['linkName', 'formLinkName', 'componentLinkName', 'elementName', 'name', 'id']);
}

function ciAttr(attributes: Record<string, string>, keys: string[]): string | undefined {
  const rank = new Map(keys.map((key, index) => [key.toLowerCase(), index]));
  let best: { rank: number; value: string } | undefined;
  for (const [key, value] of Object.entries(attributes)) {
    const index = rank.get(key.toLowerCase());
    if (index === undefined || !value.trim()) continue;
    if (!best || index < best.rank) best = { rank: index, value };
  }
  return best?.value;
}

function takeElement(pool: UiElement[], source: ZmlNode): UiElement | undefined {
  const tag = source.tag.toLowerCase();
  const name = zmlName(source.attributes)?.toLowerCase();
  const same = pool.filter((el) => el.tag.toLowerCase() === tag);
  // A named node is satisfied only by the generated element carrying that
  // name: an unrelated same-tag node never stands in for it.
  const picked = name ? same.find((el) => (el.name ?? '').toLowerCase() === name) : (same.find((el) => !el.name) ?? same[0]);
  if (!picked) return undefined;
  pool.splice(pool.indexOf(picked), 1);
  return picked;
}

/**
 * Payload the generator currently drops while still emitting the node:
 * button `parameters`, search `criteria` / `criteriaString`, and KPI
 * functions other than count and sum (distinctCount and the rest).
 */
function pageBehaviorGap(source: ZmlNode, ui: UiElement): string | undefined {
  const parameters = ciAttr(source.attributes, ['parameters']);
  if (parameters) {
    const haystack = [ui.name, ui.text, ui.href, ui.kpi ? JSON.stringify(ui.kpi) : ''].filter(Boolean).join('\n');
    if (!haystack.includes(parameters)) return 'parameters';
  }
  const criteria = ciAttr(source.attributes, ['criteriaString', 'criteria']);
  if (criteria && !ui.criteria) return 'criteria';
  const fn = kpiFunction(source, ui);
  if (fn && !SUPPORTED_KPI.has(fn)) return `kpi ${fn}`;
  const payload = staticPayload(source, ui);
  if (payload && ui.kind !== 'container' && ui.kind !== 'todo' && !ui.kpi && !(ui.text?.trim() || ui.html?.trim())) return 'content';
  return undefined;
}

/**
 * The static text payload the export wrote on a leaf element: its inner text
 * or a literal `label`/`text` attribute, plus `value` on the kinds where it
 * is the shown content (text, button). An attribute holding an expression
 * (`thisapp.X.count(...)`, `openUrl(...)`) or a non-text token (an icon name,
 * an embed URL) is not static payload; those elements are proved through the
 * KPI/behaviour checks instead.
 */
function staticPayload(source: ZmlNode, ui: UiElement): string {
  const inner = (source.text ?? '').trim();
  if (inner) return inner;
  const literal = (ciAttr(source.attributes, ['label', 'text']) ?? '').trim();
  if (literal && !literal.includes('(')) return literal;
  if (ui.kind === 'text' || ui.kind === 'button') {
    const value = (ciAttr(source.attributes, ['value']) ?? '').trim();
    // The value is emitted when it became the element's identity (an icon's
    // name) or its icon, not only when it is the shown text.
    if (value && ui.name !== value && ui.icon !== value && !value.includes('(') && !/^thisapp\./i.test(value)) return value;
  }
  return '';
}

function kpiFunction(source: ZmlNode, ui: UiElement): string | undefined {
  if (ui.kpi?.fn) return ui.kpi.fn.toLowerCase();
  const formData = (ciAttr(source.attributes, ['type']) ?? '').toLowerCase() === 'form data' || ui.kind === 'kpi';
  if (!formData) return undefined;
  const value = (ciAttr(source.attributes, ['value']) ?? '').trim();
  const match = /(?:^|\.)([A-Za-z_]\w*)\s*(?:\(|$)/.exec(value);
  const name = match?.[1]?.toLowerCase();
  if (name && UNSUPPORTED_KPI.has(name)) return name;
  return undefined;
}

function handlerBase(w: Workflow): string {
  return `${slug(w.form || 'form')}/${slug(w.event || w.name || 'handler')}`;
}

/** Coverage row for this workflow, when generate recorded one. */
function coverageEntry(w: Workflow, out: AuditOutputs): WorkflowCoverage | undefined {
  const coverage = out.coverage;
  if (!coverage) return undefined;
  const file = w.span.file ?? '';
  return coverage.find(
    (c) =>
      c.form === (w.form || 'form') &&
      c.event === (w.event || '') &&
      c.name === (w.name || '') &&
      c.start === w.span.start &&
      c.end === w.span.end &&
      (c.file ?? '') === file,
  );
}

/**
 * The per-event slug, or a coverage entry for the merged route file.
 * A coverage row with `serverInvoked: false` is not production: the server
 * body was emitted and nothing runs it. The client file does not override that.
 */
function handlerProduced(w: Workflow, out: AuditOutputs, paths: Set<string>): boolean {
  const entry = coverageEntry(w, out);
  if (entry?.serverInvoked === false) return false;
  const base = handlerBase(w);
  const legacy = [...paths].some(
    (p) =>
      p === `functions/aio/${base}.mjs` ||
      p.startsWith(`functions/aio/${base}-`) ||
      p.startsWith(`functions/aio/${base}.`) ||
      p === `client/handlers/${base}.mjs` ||
      p.startsWith(`client/handlers/${base}-`),
  );
  if (legacy) return true;
  const coverage = out.coverage;
  if (!coverage) return false;
  const file = w.span.file ?? '';
  return coverage.some(
    (c) =>
      c.form === (w.form || 'form') &&
      c.event === (w.event || '') &&
      c.name === (w.name || '') &&
      c.start === w.span.start &&
      c.end === w.span.end &&
      (c.file ?? '') === file &&
      c.paths.some((p) => paths.has(p)),
  );
}

/** The ledger name auditWorkflow emits for a workflow (form/schedule/payment vs approval/blueprint branch). */
function workflowRowName(w: Workflow): string {
  const label = w.name || w.form || 'workflow';
  const kind = workflowKind(w);
  return kind === 'form' ? `${w.form ?? ''} ${w.event || label}`.trim() : label;
}

/**
 * A workflow with no runnable statements declares no behaviour: blank, or
 * commented out (gallery scripts wrapped in `/* ... *\/` or `//` lines parse
 * to zero statements). Creator runs none of it either, so there is nothing
 * to migrate and no manual step to list. An unparseable script is never
 * vacuous here: the generator throws on it before the audit runs.
 */
function vacuous(w: Workflow): boolean {
  if ((w.fieldRules?.length ?? 0) > 0) return false;
  const text = w.deluge?.text ?? '';
  if (!text.trim()) return true;
  try {
    return parse(text).body.length === 0;
  } catch {
    return false;
  }
}

function auditWorkflow(app: App, out: AuditOutputs, rows: CoverageRow[]): void {
  const paths = new Set(out.files.map((f) => f.path));
  for (const w of app.workflows) {
    const kind = workflowKind(w);
    const label = w.name || w.form || 'workflow';
    const rowName = workflowRowName(w);
    const listed = listedTodos(out.todos, w).length > 0;
    if (kind === 'form') {
      if (vacuous(w)) continue;
      const base = handlerBase(w);
      const produced = handlerProduced(w, out, paths);
      if (produced) rows.push({ kind: 'workflow', name: rowName, status: 'emitted', via: `functions/aio/${base}.mjs` });
      else if (listed) rows.push({ kind: 'workflow', name: rowName, status: 'counted', via: 'todo' });
      else
        rows.push({
          kind: 'workflow',
          name: rowName,
          status: 'dropped',
          via: 'none',
          note: `Workflow ${label} (${w.event}) emitted no handler and carries no todo. Add one: either migrate the script or record the manual step.`,
        });
      continue;
    }
    if (kind === 'payment') {
      const produced = paths.has(`not-supported/payments-${slug(w.name || w.form || 'workflow')}.mjs`);
      if (produced) rows.push({ kind: 'workflow', name: rowName, status: 'emitted', via: 'payment stub' });
      else if (listed) rows.push({ kind: 'workflow', name: rowName, status: 'counted', via: 'todo' });
      else
        rows.push({
          kind: 'workflow',
          name: rowName,
          status: 'dropped',
          via: 'none',
          note: `Payments workflow ${label} has no stub and no fidelity note. Add one: the stub names the workflow and states that no gateway is called.`,
        });
      continue;
    }
    if (kind === 'schedule') {
      const plan = out.schedules.get(w);
      const produced = !!plan && ((plan.kind === 'custom' && !!plan.cron) || (plan.kind === 'form' && !!plan.sweep));
      if (produced) rows.push({ kind: 'schedule', name: rowName, status: 'emitted', via: 'job module' });
      else if (listed) rows.push({ kind: 'schedule', name: rowName, status: 'counted', via: 'todo' });
      else
        rows.push({
          kind: 'schedule',
          name: rowName,
          status: 'dropped',
          via: 'none',
          note: `Schedule ${label} produced no cron or sweep and carries no gap todo. Add one: either plan the schedule or record the gap and the manual cron.`,
        });
      continue;
    }
    // Approval or blueprint: one machine module per approval group / blueprint.
    // The lookup mirrors generate(): the group key addresses the spec map, and
    // an unnamed workflow falls back to its blank spec name.
    const key = kind === 'approval' ? w.name || `approval:${w.form ?? ''}` : w.name;
    const spec =
      out.specs.find((s) => s.kind === kind && s.name === key) ?? (key !== w.name ? out.specs.find((s) => s.kind === kind && s.name === w.name) : undefined);
    const produced = !!spec && paths.has(`functions/flow/${spec.slug}.mjs`);
    if (produced) rows.push({ kind: 'approval', name: rowName, status: 'emitted', via: `functions/flow/${spec!.slug}.mjs` });
    else if (listed) rows.push({ kind: 'approval', name: rowName, status: 'counted', via: 'todo' });
    else
      rows.push({
        kind: 'approval',
        name: rowName,
        status: 'dropped',
        via: 'none',
        note: `${kind === 'approval' ? 'Approval' : 'Blueprint'} ${label} emitted no machine module and carries no todo. Add one: either migrate the machine or record the manual step.`,
      });
  }
}

interface IntegrationCall {
  task: string;
  where: string;
  invokeurl: boolean;
}

/** An invokeurl use is named `invokeurl <METHOD>`; a `zoho.<svc>.<task>` path never is. */
function isInvokeurlTask(task: string): boolean {
  const t = task.toLowerCase();
  return t === 'invokeurl' || t.startsWith('invokeurl ');
}

/**
 * The integration calls a script makes, from the audit's own unfiltered walk
 * of the parsed script: every `zoho.<svc>.<task>(...)` call node and every
 * `invokeurl` node, whether or not the connections analysis surfaces them.
 * Comments and string literals parse to no call nodes, so they are never
 * drops. An unparseable script enumerates nothing; the generator throws on
 * it before the audit runs.
 */
function callsIn(text: string, where: string): IntegrationCall[] {
  let script;
  try {
    script = parse(text);
  } catch {
    return [];
  }
  const calls: IntegrationCall[] = [];
  walk(script, (n) => {
    if (n.kind === 'call') {
      const chain = memberChain(n.callee as Expr);
      if (chain && chain[0] === 'zoho' && chain.length === 3) {
        calls.push({ task: chain.slice(1).join('.').toLowerCase(), where, invokeurl: false });
      }
      return;
    }
    if (n.kind === 'invokeurl') calls.push({ task: 'invokeurl', where, invokeurl: true });
  });
  return calls;
}

function scriptsOf(app: App): { text: string; where: string }[] {
  const out: { text: string; where: string }[] = [];
  for (const w of app.workflows) if (w.deluge) out.push({ text: w.deluge.text, where: `${w.name} (${w.event})` });
  for (const fn of app.functions) for (const d of fn.deluge) out.push({ text: d.text, where: `function ${fn.name}` });
  return out;
}

/** True when the call needs no wiring: evaluated locally or refused explicitly. */
function locallyHandled(root: string, task: string): boolean {
  if (ZOHO_PAYMENT.test(task)) return true;
  if (dispatchGet(ZOHO_ENV, root)) return true;
  const hit = adapterFor(task.split('.'));
  return !!hit?.adapter.local;
}

function auditIntegration(app: App, out: AuditOutputs, rows: CoverageRow[]): void {
  for (const { text, where } of scriptsOf(app)) {
    for (const call of callsIn(text, where)) {
      if (call.invokeurl) {
        const covered =
          out.connections.entries.some((e) => e.uses.some((u) => u.where === where && isInvokeurlTask(u.task))) ||
          out.connections.unsupported.some((u) => isInvokeurlTask(u)) ||
          out.connections.diagnostics.some((d) => d.includes(where) && /invokeurl/i.test(d));
        if (covered) rows.push({ kind: 'integration', name: `invokeurl in ${where}`, status: 'counted', via: 'connections report' });
        else
          rows.push({
            kind: 'integration',
            name: `invokeurl in ${where}`,
            status: 'dropped',
            via: 'none',
            note: `An invokeurl call in ${where} is analysed nowhere: no checklist row, no unsupported entry, no diagnostic. Record the service, the scope, and the manual connection step.`,
          });
        continue;
      }
      const root = call.task.split('.')[0]!;
      if (locallyHandled(root, call.task)) {
        rows.push({ kind: 'integration', name: `zoho.${call.task} in ${where}`, status: 'emitted', via: 'local evaluation' });
        continue;
      }
      const covered =
        out.connections.entries.some((e) => e.uses.some((u) => u.where === where && u.task.toLowerCase() === call.task)) ||
        out.connections.unsupported.some((u) => u.toLowerCase() === `zoho-task:${call.task}`) ||
        out.connections.diagnostics.some((d) => d.includes(where) && d.toLowerCase().includes(call.task));
      if (covered) rows.push({ kind: 'integration', name: `zoho.${call.task} in ${where}`, status: 'counted', via: 'connections report' });
      else
        rows.push({
          kind: 'integration',
          name: `zoho.${call.task} in ${where}`,
          status: 'dropped',
          via: 'none',
          note: `zoho.${call.task} in ${where} is translated to a runtime task call but the connections analysis never surfaces it: no checklist row, no unsupported entry, no diagnostic. List it in the connections report with the manual connection step.`,
        });
    }
  }
}

/**
 * True when the connections report has a `connection <link>: declares granted
 * scopes <list>` diagnostic for exactly this link name whose listed scopes
 * cover every scope in `literal`. Another connection's diagnostic — including
 * one whose link merely shares a prefix — does not count.
 */
function connectionScopesListed(diagnostics: readonly string[], link: string, literal: readonly string[]): boolean {
  if (!link) return false;
  const re = new RegExp(`^connection ${link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: declares granted scopes (.*); carry them to the Catalyst connection$`);
  for (const d of diagnostics) {
    const m = re.exec(d);
    if (!m) continue;
    const listed = new Set(m[1]!.split(',').map((s) => s.trim()));
    if (literal.every((s) => listed.has(s))) return true;
  }
  return false;
}

function auditPermission(app: App, out: AuditOutputs, rows: CoverageRow[]): void {
  const profiles = new Set(app.profiles.map((p) => p.name));
  const roles = new Set<string>();
  const walkRoles = (list: App['roles']): void => {
    for (const r of list) {
      roles.add(r.name);
      walkRoles(r.children);
    }
  };
  walkRoles(app.roles);
  for (const p of app.permissions) {
    if (profiles.has(p.owner ?? '') || roles.has(p.owner ?? '')) {
      rows.push({ kind: 'permission', name: `permissions of ${p.owner ?? '(no owner)'}`, status: 'emitted', via: 'auth plan role grant' });
      continue;
    }
    // A `permissions` literal on a `connections` block is the connection's
    // granted scope list; covered only when the report's diagnostic for that
    // connection lists every scope the literal grants. A literal holding a
    // value that is not scope-name shaped is never fully listed.
    const { scopes, unverified } = permissionScopes(p.value);
    if (!unverified && connectionScopesListed(out.connections.diagnostics, p.owner ?? '', scopes)) {
      rows.push({ kind: 'permission', name: `permissions of ${p.owner ?? '(no owner)'}`, status: 'counted', via: 'connections diagnostic' });
      continue;
    }
    rows.push({
      kind: 'permission',
      name: `permissions of ${p.owner ?? '(no owner)'}`,
      status: 'dropped',
      via: 'none',
      note: `A permissions literal owned by ${p.owner ?? '(no owner)'} matches no profile or role, so the auth plan migrates none of it. List what it grants and the manual role or grant that reproduces it.`,
    });
  }
}

function translationLanguage(t: App['translations'][number]): string | undefined {
  if (t.data && typeof t.data === 'object' && !Array.isArray(t.data)) {
    const keys = Object.keys(t.data);
    if (keys.length === 1) return keys[0];
  }
  return undefined;
}

/**
 * Every declared function (`functions { ... }` / `deluge` / bare script)
 * either emits `functions/custom/<name>.mjs` or is listed by a todo inside
 * its span. A migration-report warning (`function-untranslated`,
 * `custom-function-api-*`) is never coverage: warnings are not counted
 * manual items, so a function that only carries a warning is a drop.
 */
function auditFunction(app: App, out: AuditOutputs, rows: CoverageRow[]): void {
  const paths = new Set(out.files.map((f) => f.path));
  for (const fn of app.functions) {
    const name = fn.name || 'function';
    const produced = paths.has(`functions/custom/${slug(name)}.mjs`);
    if (produced) {
      rows.push({ kind: 'function', name: fn.name, status: 'emitted', via: `functions/custom/${slug(name)}.mjs` });
      continue;
    }
    if (out.todos.some((t) => within(t, fn.span))) {
      rows.push({ kind: 'function', name: fn.name, status: 'counted', via: 'todo' });
      continue;
    }
    const warned = out.warnings.some(
      (w) => (w.construct === 'function-untranslated' || w.construct.startsWith('custom-function-api-')) && w.name === fn.name,
    );
    rows.push({
      kind: 'function',
      name: fn.name,
      status: 'dropped',
      via: 'none',
      note: `Function ${fn.name} emitted no module and carries no todo${warned ? ' — only a migration-report warning, which is not a counted manual item' : ''}. Add one: either migrate the body or record the manual step.`,
    });
  }
}

/** Every statement node of a parsed script, recursively, in source order. */
function eachStatement(list: readonly Stmt[], visit: (s: Stmt) => void): void {
  for (const s of list) {
    visit(s);
    if (s.kind === 'block') eachStatement(s.body, visit);
    else if (s.kind === 'if') {
      eachStatement([s.then, ...s.elifs.map((e) => e.body), ...(s.else ? [s.else] : [])], visit);
    } else if (s.kind === 'forEach' || s.kind === 'while' || s.kind === 'fn') eachStatement([s.body], visit);
    else if (s.kind === 'try') eachStatement(s.catchBody ? [s.body, s.catchBody] : [s.body], visit);
  }
}

/**
 * Every declared script (`workflow deluge`, blueprint transition phase
 * `deluge`, `function` body) as one audit unit, labelled for drop names.
 * `cov` is the coverage-ledger unit the emitters record its rows under
 * (generate.ts coverShift); a unit whose script is never translated has no
 * coverage label at all, so its statements can never borrow another unit's
 * rows. `via` marks a unit whose script is deliberately not translated —
 * a payments stub names the workflow and states no gateway is called, which
 * is the listing surface for its statements. Any other unit without a
 * coverage label drops every statement it declares.
 */
function scriptUnits(app: App, specs: readonly FlowSpec[]): { label: string; cov: string | null; via: string | null; owner: string; text: string; start: number; end: number }[] {
  const out: { label: string; cov: string | null; via: string | null; owner: string; text: string; start: number; end: number }[] = [];
  for (const w of app.workflows) {
    const label = w.name || w.form || 'workflow';
    if (w.deluge) {
      const kind = workflowKind(w);
      let cov: string | null = null;
      let via: string | null = null;
      if (kind === 'schedule') cov = `schedule ${label}`;
      else if (kind === 'approval') {
        const key = w.name || `approval:${w.form ?? ''}`;
        const spec = specs.find((s) => s.kind === 'approval' && s.name === key) ?? (key !== w.name ? specs.find((s) => s.kind === 'approval' && s.name === w.name) : undefined);
        cov = spec ? `approval ${spec.name}` : null;
      } else if (kind === 'form') cov = `workflow ${label} (${w.event})`;
      else if (kind === 'payment') via = 'payment stub';
      out.push({ label: `workflow ${label} (${w.event})`, cov, via, owner: workflowRowName(w), text: w.deluge.text, start: w.deluge.span.start, end: w.deluge.span.end });
    }
    for (const t of w.blueprint?.transitions ?? []) {
      for (const p of t.phases) {
        for (const d of p.deluge)
          out.push({ label: `blueprint ${t.name} / ${p.phase}`, cov: `blueprint ${t.name} / ${p.phase}`, via: null, owner: workflowRowName(w), text: d.text, start: d.span.start, end: d.span.end });
      }
    }
  }
  for (const fn of app.functions) {
    for (const d of fn.deluge)
      out.push({ label: `function ${fn.name}`, cov: `function ${fn.name}`, via: null, owner: `fn:${fn.name}`, text: d.text, start: d.span.start, end: d.span.end });
  }
  return out;
}

/**
 * Statement-level coverage (C3). The translator records one coverage row per
 * statement it visits (translate.ts `statement`/`stmts`), shifted to absolute
 * `.ds` spans by the emitters (generate.ts `coverShift`). A declared
 * statement is:
 * - emitted when its row counted 'translated' or 'shimmed';
 * - counted when its row counted 'todo' and a TODO item covers its span
 *   (account() pushes the construct rows at the statement's own span);
 * - dropped when no row exists (a generator that skipped the statement) or
 *   the row counted 'skipped'/'todo' with no covering TODO.
 */
function auditStatements(app: App, out: AuditOutputs, rows: CoverageRow[]): void {
  // Owner rows already emitted by the workflow/function audits. A unit whose
  // owner is counted or dropped is covered there; statement rows exist only
  // where the unit's statements were supposed to be emitted.
  const ownerStatus = new Map<string, CoverageRow['status']>();
  for (const r of rows) if (r.kind === 'workflow' || r.kind === 'schedule' || r.kind === 'approval') ownerStatus.set(r.name, r.status);
  for (const r of rows) if (r.kind === 'function') ownerStatus.set(`fn:${r.name}`, r.status);
  // One claim set for the whole app: a coverage row can satisfy exactly one
  // declared statement, in exactly one unit. Rows are also scoped to their
  // own unit label, so a missing row can never be papered over by borrowing
  // a neighbouring unit's same-kind row.
  const used = new Set<CoverageEntry>();
  for (const unit of scriptUnits(app, out.specs)) {
    if (!unit.text.trim()) continue;
    if (ownerStatus.get(unit.owner) !== 'emitted') continue;
    let script;
    try {
      script = parse(unit.text);
    } catch {
      continue; // Unparseable: the generator throws before the audit runs.
    }
    // The declared span covers at least the script text (a degenerate
    // `span: {0,0}` fixture widens to `start + text.length`), and an
    // app-call resolution (`thisapp.<fn>` inserts in translateInApp) can push
    // a statement's end past the raw span, so the end window is slack.
    const unitEnd = Math.max(unit.end, unit.start + unit.text.length);
    const cover = out.statementCoverage.filter((c) => c.unit === unit.cov && c.start >= unit.start && c.start <= unitEnd + 4096);
    eachStatement(script.body, (s) => {
      const name = `${unit.label} ${s.kind} statement`;
      // A unit whose script is deliberately not translated (a payments stub)
      // lists every statement through that listing surface.
      if (unit.via) {
        rows.push({ kind: 'statement', name, status: 'counted', via: unit.via });
        return;
      }
      const abs = { start: unit.start + s.span.start, end: unit.start + s.span.end };
      // Exact span + kind first; when resolveAppCalls rewrote the source the
      // emitted spans sit in resolved coordinates, so fall back to the first
      // unclaimed row of the same kind in this unit (statement order and
      // kinds survive).
      const row =
        cover.find((c) => !used.has(c) && c.start === abs.start && c.end === abs.end && c.kind === s.kind) ??
        cover.find((c) => !used.has(c) && c.kind === s.kind);
      if (!row) {
        rows.push({
          kind: 'statement',
          name,
          status: 'dropped',
          via: 'none',
          note: `A ${s.kind} statement in ${unit.label} was never visited by the translator — the coverage ledger has no row for it. This is a generator bug: emit it or count it.`,
        });
        return;
      }
      used.add(row);
      if (row.bucket === 'translated' || row.bucket === 'shimmed') {
        rows.push({ kind: 'statement', name, status: 'emitted', via: `translated (${row.bucket})` });
        return;
      }
      // A `block` only recurses: it accounts nothing itself, so 'skipped' is
      // its resting state. Its children are audited row by row.
      if (s.kind === 'block') {
        rows.push({ kind: 'statement', name, status: 'emitted', via: 'container' });
        return;
      }
      // The row's own span and the todo spans are both final-pass coordinates.
      if (row.bucket === 'todo' && out.todos.some((t) => t.start < row.end && t.end > row.start)) {
        rows.push({ kind: 'statement', name, status: 'counted', via: 'todo' });
        return;
      }
      rows.push({
        kind: 'statement',
        name,
        status: 'dropped',
        via: 'none',
        note: `A ${s.kind} statement in ${unit.label} counted '${row.bucket}' with no covering TODO item — a silent drop. Emit it or push a todo naming the untranslated construct.`,
      });
    });
  }
}

/** Every construct the `.ds` declares that is neither produced nor listed. */
export function auditApp(app: App, outputs?: AuditOutputs): SilentDrop[] {
  return coverageLedger(app, outputs)
    .filter((r) => r.status === 'dropped')
    .map((r) => ({ kind: r.kind, name: r.name, note: r.note ?? `${r.kind} ${r.name} is neither generated nor listed.` }));
}

/**
 * The full generation-time coverage ledger: every construct the `.ds`
 * declares — forms, fields and their properties, reports and their features,
 * pages and their elements, workflows, functions, every script statement,
 * integrations, permissions, translations — resolved to emitted, counted, or
 * dropped.
 */
export function coverageLedger(app: App, outputs?: AuditOutputs): CoverageRow[] {
  const out = outputs ?? collectOutputs(app);
  const rows: CoverageRow[] = [];
  auditForm(app, out, rows);
  auditField(app, out, rows);
  auditFieldProperties(app, out, rows);
  auditReport(app, out, rows);
  auditReportFeatures(app, out, rows);
  auditPage(app, out, rows);
  auditPageElements(app, out, rows);
  auditWorkflow(app, out, rows);
  auditFunction(app, out, rows);
  auditStatements(app, out, rows);
  auditIntegration(app, out, rows);
  auditPermission(app, out, rows);
  auditTranslationDeclarations(app, out, rows);
  return rows;
}

/** Thrown by assertCovered: generation produced constructs it neither emitted nor counted. */
export class SilentDropError extends Error {
  readonly drops: SilentDrop[];
  constructor(drops: SilentDrop[]) {
    super(`silent drops: every construct must be emitted or counted —\n${drops.map((d) => `  [${d.kind}] ${d.name}: ${d.note}`).join('\n')}`);
    this.name = 'SilentDropError';
    this.drops = drops;
  }
}

/**
 * The C3 invariant as a hard gate: throws SilentDropError naming every
 * construct that is neither emitted nor counted. Callers that emit a
 * migration run this so a silent drop fails generation instead of shipping.
 */
export function assertCovered(app: App, outputs?: AuditOutputs): CoverageRow[] {
  const rows = coverageLedger(app, outputs);
  const drops = rows.filter((r) => r.status === 'dropped').map((r) => ({ kind: r.kind, name: r.name, note: r.note ?? '' }));
  if (drops.length) throw new SilentDropError(drops);
  return rows;
}

/**
 * Translation blocks are never produced; each one needs an explicit manual
 * step. A block is counted only by a todo inside its span — a migration-report
 * warning (`translation-not-migrated`) is never coverage: warnings are not
 * counted manual items, so a block that only carries a warning is a drop.
 */
function auditTranslationDeclarations(app: App, out: AuditOutputs, rows: CoverageRow[]): void {
  for (const t of app.translations) {
    const lang = translationLanguage(t);
    if (out.todos.some((todo) => within(todo, t.span))) {
      rows.push({ kind: 'translation', name: lang ? `translation ${lang}` : 'translation block', status: 'counted', via: 'todo' });
      continue;
    }
    const warned = out.warnings.some(
      (w) => w.construct === 'translation-not-migrated' && (lang === undefined || w.name.includes(lang)),
    );
    rows.push({
      kind: 'translation',
      name: lang ? `translation ${lang}` : 'translation block',
      status: 'dropped',
      via: 'none',
      note: `${lang ? `The ${lang} translation block` : 'A translation block'} is not migrated and has no manual step${warned ? ' — only a migration-report warning, which is not a counted manual item' : ''}. List the language, the string count, and what the user must copy into the generated client.`,
    });
  }
}

export interface ClassCount {
  kind: DropKind;
  occurrences: number;
  apps: number;
  sample: string;
}

/** Aggregate per-app drops into anonymized classes: no app names, only counts and one sample note. */
export function groupDrops(byApp: SilentDrop[][]): ClassCount[] {
  const groups = new Map<string, { kind: DropKind; occurrences: number; apps: number; sample: string }>();
  for (const drops of byApp) {
    const seen = new Set<string>();
    for (const d of drops) {
      const key = `${d.kind}	${d.name}	${d.note}`;
      const g = groups.get(key) ?? { kind: d.kind, occurrences: 0, apps: 0, sample: d.note };
      g.occurrences++;
      if (!seen.has(key)) {
        seen.add(key);
        g.apps++;
      }
      groups.set(key, g);
    }
  }
  return [...groups.values()].sort((a, b) => b.occurrences - a.occurrences || (a.kind < b.kind ? -1 : 1));
}

/**
 * The docs/no-silent-drop.md body: numbered rows, no app names. Rows group
 * identical constructs with occurrence and app counts.
 */
export function renderNoSilentDrop(apps: number, groups: ClassCount[], tool: string): string {
  const lines = ['# No silent drops', '', `Audit tool: \`${tool}\`. Apps audited: ${apps}.`, ''];
  if (!groups.length) {
    lines.push('No silent drops. Every declared construct is either generated or listed as an explicit manual item.', '');
    return `${lines.join('\n')}\n`;
  }
  const total = groups.reduce((n, g) => n + g.occurrences, 0);
  lines.push(`Silent drops: ${total} occurrence(s) in ${apps} app(s). Each row is one construct class: kind, occurrences, apps affected, and what is missing.`, '');
  groups.forEach((g, i) => {
    lines.push(`${i + 1}. [${g.kind}] ×${g.occurrences} in ${g.apps} app(s): ${g.sample}`);
  });
  lines.push('');
  return `${lines.join('\n')}\n`;
}
