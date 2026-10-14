/**
 * Edit language over the app model.
 *
 * The model is the parsed `.ds` plus an ordered edits log (`<app>.edits.json`
 * beside a `.ds` file, `c2c.edits.json` inside a project folder). Every change
 * a user asks for is one typed op, validated against the model and replayed in
 * order on each load, so generated code is never edited by hand.
 *
 * Ops: addField, renameField, removeField, setPicklist, addReportColumn, addRole.
 * A refused op throws EditError naming the form, field, report, or script that
 * blocks it. Ops never touch the source `.ds`.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { App, Field, Form, Property, RawDeluge, Report, ReportColumn, ReportView, Role, Span } from '../../core/src/ir.js';
import { formLink } from '../../core/src/ir.js';
import { derivedFieldColumns } from '../../schema/src/generator.js';
import { fieldTypeRow, SOURCE_ID_COLUMN, SYSTEM_FIELD_COLUMNS, systemFieldColumn } from '../../schema/src/mapping.js';

export type EditOp =
  | {
      op: 'addField';
      form: string;
      field: string;
      type: string;
      label?: string;
      required?: boolean;
      unique?: boolean;
      choices?: string[];
      /** Lookup target: `Form` or `Form.DisplayField`. */
      lookup?: string;
    }
  | { op: 'renameField'; form: string; from: string; to: string }
  | { op: 'removeField'; form: string; field: string }
  | { op: 'setPicklist'; form: string; field: string; choices: string[] }
  | { op: 'addReportColumn'; report: string; field: string; label?: string }
  | { op: 'addRole'; role: string; parent?: string; description?: string };

export type EditOpName = EditOp['op'];

export const EDIT_OPS: readonly EditOpName[] = ['addField', 'renameField', 'removeField', 'setPicklist', 'addReportColumn', 'addRole'];

export interface EditsFile {
  version: 1;
  edits: EditOp[];
}

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

/** A column rename the delta must carry as a rename, never as drop plus add. */
export interface FieldRename {
  form: string;
  from: string;
  to: string;
}

export interface EditResult {
  app: App;
  renames: FieldRename[];
}

/** One place a form field is referred to. `rewrite` is set when a rename can update it in the model. */
export interface FieldUsage {
  where: string;
  rewrite?: (to: string) => void;
}

const LINK_NAME = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
const STORE_RESERVED = new Set(['rowid', 'creatorid', 'createdtime', 'modifiedtime', 'id', SOURCE_ID_COLUMN.toLowerCase()]);
const CHOICE_TYPES = new Set(['picklist', 'dropdown', 'radiobuttons', 'radio', 'inline picklist', 'inlinepicklist', 'inline radio', 'inlineradio', 'list', 'multiselect', 'multi select', 'checkboxes']);

function fail(message: string): never {
  throw new EditError(message);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function names(items: readonly { name: string }[]): string {
  return items.length ? items.map((item) => item.name).join(', ') : 'none';
}

function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function prop(key: string, value: string, span: Span): Property {
  return { key, value, span: { ...span } };
}

function setProp(field: Field, key: string, value: string): void {
  const found = field.properties.find((p) => p.key.toLowerCase() === key);
  if (found) found.value = value;
  else field.properties.push(prop(key, value, field.span));
}

function formOf(app: App, name: string, op: string): Form {
  const form = app.forms.find((f) => f.name === name);
  if (!form) fail(`${op}: unknown form "${name}" (forms: ${names(app.forms)})`);
  return form;
}

function fieldOf(form: Form, name: string, op: string): Field {
  const field = form.fields.find((f) => f.name === name);
  if (!field) fail(`${op}: form "${form.name}" has no field "${name}" (fields: ${names(form.fields)})`);
  return field;
}

/** Name checks shared by addField and renameField: link-name syntax, store-reserved names, and collisions. */
function checkNewName(form: Form, name: string, op: string, except?: Field): void {
  if (!LINK_NAME.test(name)) fail(`${op}: "${name}" is not a link name (a letter, then letters, digits, or _; at most 50 characters)`);
  const lower = name.toLowerCase();
  if (STORE_RESERVED.has(lower) || systemFieldColumn(name) || SYSTEM_FIELD_COLUMNS.some((c) => c.name.toLowerCase() === lower)) {
    fail(`${op}: "${name}" is a reserved system column name`);
  }
  const clash = form.fields.find((f) => f !== except && f.name.toLowerCase() === lower);
  if (clash) fail(`${op}: form "${form.name}" already has a field "${clash.name}"`);
  // A field name that matches a column another field generates would be
  // renamed to <name>_2 in the schema, splitting the recorded name from the
  // column deployed under it. Refuse instead.
  for (const other of form.fields) {
    if (other === except) continue;
    const derived = derivedFieldColumns(other).find((d) => d.toLowerCase() === lower);
    if (derived) fail(`${op}: "${name}" collides with ${other.name}'s generated column "${derived}"`);
  }
}

function stripStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

function mentions(text: string | undefined, name: string): boolean {
  if (!text) return false;
  return new RegExp(`(^|[^A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(stripStrings(text));
}

/** Replace `name` outside string literals, as a whole word. */
function replaceWord(text: string, name: string, to: string): string {
  const parts = text.split(/("(?:[^"\\]|\\.)*")/);
  const re = new RegExp(`(^|[^A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'g');
  return parts.map((part, i) => (i % 2 === 1 ? part : part.replace(re, (_m, pre: string) => `${pre}${to}`))).join('');
}

function delugeOf(app: App): { where: string; raw: RawDeluge }[] {
  const out: { where: string; raw: RawDeluge }[] = [];
  for (const w of app.workflows) {
    const label = `workflow "${w.name}"${w.event ? ` (${w.event})` : ''}`;
    if (w.deluge) out.push({ where: label, raw: w.deluge });
    for (const t of w.blueprint?.transitions ?? []) {
      for (const phase of t.phases) for (const raw of phase.deluge) out.push({ where: `${label} transition "${t.name}" ${phase.phase}`, raw });
    }
  }
  for (const fn of app.functions) for (const raw of fn.deluge) out.push({ where: `function "${fn.name}"`, raw });
  for (const api of app.apis) for (const raw of api.deluge ?? []) out.push({ where: `custom API "${api.name}"`, raw });
  return out;
}

function columnUsages(columns: ReportColumn[], field: string, where: string, out: FieldUsage[]): void {
  for (const column of columns) {
    if (column.field === field) {
      out.push({ where, rewrite: (to) => (column.field = to) });
    } else if (column.field.startsWith(`${field}.`)) {
      out.push({ where, rewrite: (to) => (column.field = `${to}${column.field.slice(field.length)}`) });
    }
  }
}

function viewUsages(views: ReportView[], field: string, where: string, out: FieldUsage[]): void {
  for (const view of views) {
    for (const block of view.blocks) {
      columnUsages(block.fields, field, `${where} ${view.kind} ${block.name}`, out);
      if (mentions(block.relatedField, field)) out.push({ where: `${where} ${view.kind} ${block.name} related field` });
    }
  }
}

function reportUsages(report: Report, field: string, out: FieldUsage[]): void {
  const where = `report "${report.name}"`;
  columnUsages(report.columns, field, `${where} column`, out);
  for (const order of [...report.sortBy, ...report.groupBy]) {
    if (order.field === field) out.push({ where: `${where} sort/group`, rewrite: (to) => (order.field = to) });
  }
  for (const filter of report.filters) {
    if (filter.field === field) out.push({ where: `${where} filter`, rewrite: (to) => (filter.field = to) });
    if (mentions(filter.criteria, field)) out.push({ where: `${where} filter criteria` });
  }
  if (report.basedOn === field) out.push({ where: `${where} based on`, rewrite: (to) => (report.basedOn = to) });
  if (mentions(report.criteria, field)) out.push({ where: `${where} criteria` });
  for (const format of report.conditionalFormats) {
    if (mentions(format.condition, field) || mentions(format.fields, field)) out.push({ where: `${where} conditional format "${format.name}"` });
  }
  viewUsages(report.views, field, where, out);
}

/**
 * Resolve a dotted `Head.Tail` (or deeper `A.B.C`) field reference from the
 * host form through lookup fields. Returns the form the last segment names a
 * field on, or undefined when any segment is not a lookup field.
 */
function lookupPathTarget(app: App, hostForm: string | undefined, path: string): { form: string; field: string } | undefined {
  if (!hostForm || !path.includes('.')) return undefined;
  const parts = path.split('.');
  let form = hostForm;
  for (const head of parts.slice(0, -1)) {
    const lookup = app.forms.find((f) => f.name === form)?.fields.find((f) => f.name === head)?.lookup;
    if (!lookup) return undefined;
    form = lookup.form;
  }
  return { form, field: parts[parts.length - 1]! };
}

function lastSegment(path: string, to: string): string {
  const parts = path.split('.');
  parts[parts.length - 1] = to;
  return parts.join('.');
}

function mentionsPath(text: string | undefined, path: string): boolean {
  if (!text) return false;
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(stripStrings(text));
}

/**
 * A `form.field` reference inside criteria or condition text on another form:
 * either a `Lookup.field` path whose head resolves to the form, or a bare
 * mention the host form cannot resolve to a field of its own (it is either
 * ours or already broken — flagged either way so the caller can refuse).
 */
function crossFieldText(app: App, hostForm: string | undefined, text: string | undefined, formName: string, field: string): boolean {
  if (!text) return false;
  const host = hostForm === undefined ? undefined : app.forms.find((f) => f.name === hostForm);
  for (const f of host?.fields ?? []) {
    if (f.lookup?.form === formName && mentionsPath(text, `${f.name}.${field}`)) return true;
  }
  return !host?.fields.some((f) => f.name === field) && mentions(text, field);
}

/** Dotted `Lookup.field` references inside a report, whatever form it shows. */
function reportPathUsages(app: App, report: Report, formName: string, field: string, out: FieldUsage[]): void {
  const where = `report "${report.name}"`;
  const check = (ref: string | undefined, label: string, set: (next: string) => void): void => {
    const hit = ref === undefined ? undefined : lookupPathTarget(app, report.form, ref);
    if (hit?.form === formName && hit.field === field) out.push({ where: label, rewrite: (to) => set(lastSegment(ref!, to)) });
  };
  for (const column of report.columns) check(column.field, `${where} column ${column.field}`, (n) => (column.field = n));
  for (const order of [...report.sortBy, ...report.groupBy]) check(order.field, `${where} sort/group ${order.field}`, (n) => (order.field = n));
  for (const filter of report.filters) check(filter.field, `${where} filter ${filter.field}`, (n) => (filter.field = n));
  check(report.basedOn, `${where} based on`, (n) => (report.basedOn = n));
  for (const view of report.views) {
    for (const block of view.blocks) {
      for (const column of block.fields) check(column.field, `${where} ${view.kind} ${block.name} column ${column.field}`, (n) => (column.field = n));
      check(block.relatedField, `${where} ${view.kind} ${block.name} related field`, (n) => (block.relatedField = n));
    }
  }
}

/** Criteria text on a report of another form. */
function reportCrossText(app: App, report: Report, formName: string, field: string, out: FieldUsage[]): void {
  const where = `report "${report.name}"`;
  if (crossFieldText(app, report.form, report.criteria, formName, field)) out.push({ where: `${where} criteria` });
  for (const filter of report.filters) {
    if (crossFieldText(app, report.form, filter.criteria, formName, field)) out.push({ where: `${where} filter criteria` });
  }
  for (const format of report.conditionalFormats) {
    if (crossFieldText(app, report.form, format.condition, formName, field) || crossFieldText(app, report.form, format.fields, formName, field)) {
      out.push({ where: `${where} conditional format "${format.name}"` });
    }
  }
}

/**
 * Every place the model refers to `form.field`: reports on its form and on
 * other forms through `Lookup.field` paths, lookups that display it, field
 * rules and workflow conditions on its form and others, profile permissions,
 * and Deluge. Script and criteria text has no rewrite: a rename or removal
 * that reaches it is refused.
 */
export function fieldUsages(app: App, formName: string, field: string): FieldUsage[] {
  const out: FieldUsage[] = [];
  for (const report of app.reports) {
    if (report.form === formName) reportUsages(report, field, out);
    else reportCrossText(app, report, formName, field, out);
    reportPathUsages(app, report, formName, field, out);
  }
  for (const other of app.forms) {
    for (const f of other.fields) {
      if (f.lookup?.form !== formName) continue;
      const where = `lookup ${other.name}.${f.name}`;
      if (f.lookup.field === field) {
        out.push({
          where,
          rewrite: (to) => {
            f.lookup!.field = to;
            setProp(f, 'values', `${formName}.${to}`);
          },
        });
      }
      if (mentions(f.lookup.displayFormat, field)) {
        out.push({
          where: `${where} display format`,
          rewrite: (to) => {
            const next = replaceWord(f.lookup!.displayFormat!, field, to);
            f.lookup!.displayFormat = next;
            setProp(f, 'displayformat', next);
          },
        });
      }
    }
  }
  for (const w of app.workflows) {
    const link = formLink(w.form);
    const host = link.name || undefined;
    const sameForm = host === formName;
    const text = (value: string | undefined): boolean => (sameForm ? mentions(value, field) : crossFieldText(app, host, value, formName, field));
    const label = `workflow "${w.name}"`;
    if (text(w.actionCondition)) out.push({ where: `${label} condition` });
    if (text(w.recordEvent) || text(w.event)) out.push({ where: `${label} event "${w.event}"` });
    if (text(link.criteria ?? undefined)) out.push({ where: `${label} form criteria` });
    for (const rule of w.fieldRules ?? []) {
      if (text(rule.condition)) out.push({ where: `${label} field rule condition` });
      for (const action of rule.actions) {
        action.fields.forEach((name, i) => {
          const hit = sameForm ? name === field : (() => { const target = lookupPathTarget(app, host, name); return target?.form === formName && target.field === field; })();
          if (hit) out.push({ where: `${label} field rule ${action.action}`, rewrite: (to) => (action.fields[i] = sameForm ? to : lastSegment(name, to)) });
        });
      }
    }
    for (const approver of w.approvers ?? []) {
      if (text(approver.value)) out.push({ where: `${label} approver ${approver.key}` });
    }
  }
  for (const profile of app.profiles) {
    for (const mod of profile.modules) {
      if (mod.component !== formName) continue;
      for (const perm of mod.fields) {
        if (perm.field === field) out.push({ where: `profile "${profile.name}" field permission`, rewrite: (to) => (perm.field = to) });
      }
    }
  }
  for (const { where, raw } of delugeOf(app)) {
    if (mentions(raw.text, field)) out.push({ where: `Deluge in ${where}` });
  }
  return out;
}

function listUsages(usages: readonly FieldUsage[]): string {
  const seen = [...new Set(usages.map((u) => u.where))];
  return seen.join('; ');
}

function allRoles(roles: readonly Role[], out: Role[] = []): Role[] {
  for (const role of roles) {
    out.push(role);
    allRoles(role.children, out);
  }
  return out;
}

function parseChoices(choices: readonly string[] | undefined, op: string): string[] {
  const list = (choices ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
  if (list.length === 0) fail(`${op}: give at least one choice`);
  const seen = new Set<string>();
  for (const choice of list) {
    if (seen.has(choice)) fail(`${op}: choice "${choice}" is listed twice`);
    seen.add(choice);
  }
  return list;
}

function choicesLiteral(choices: readonly string[]): string {
  return `{${choices.map(quote).join(',')}}`;
}

function addField(app: App, op: Extract<EditOp, { op: 'addField' }>): void {
  const form = formOf(app, op.form, 'addField');
  checkNewName(form, op.field, 'addField');
  const span = { ...form.span };
  const field: Field = { name: op.field, modifiers: [], required: !!op.required, unique: !!op.unique, properties: [], subfields: [], annotations: [], flags: [], span };
  if (op.required) field.modifiers.push('must have');
  if (op.unique) field.modifiers.push('unique');
  if (op.label !== undefined) {
    field.displayName = op.label;
    field.properties.push(prop('displayname', quote(op.label), span));
  }
  const type = op.type.trim().toLowerCase();
  if (type === 'lookup' || op.lookup !== undefined) {
    if (op.lookup === undefined) fail(`addField: a lookup needs a target (--lookup <Form> or <Form>.<Field>)`);
    const [targetName, display] = op.lookup.split('.', 2) as [string, string | undefined];
    const target = app.forms.find((f) => f.name === targetName);
    if (!target) fail(`addField: lookup target form "${targetName}" does not exist (forms: ${names(app.forms)})`);
    if (display !== undefined && !target.fields.some((f) => f.name === display)) {
      fail(`addField: lookup target form "${targetName}" has no field "${display}" (fields: ${names(target.fields)})`);
    }
    const shown = display ?? target.fields.find((f) => fieldTypeRow(f.type)?.kind === 'column')?.name ?? 'ID';
    field.type = 'picklist';
    field.lookup = { form: targetName, field: 'ID', displayFormat: `[${shown}]` };
    field.properties.push(prop('type', 'picklist', span), prop('values', `${targetName}.ID`, span), prop('displayformat', `[${shown}]`, span));
  } else {
    const row = fieldTypeRow(type);
    if (!row) fail(`addField: unknown field type "${op.type}"`);
    if (row.status === 'unsupported') fail(`addField: field type "${op.type}" is not supported on Catalyst (${row.label})`);
    if (row.kind !== 'column' && row.kind !== 'stratus-key') {
      fail(`addField: field type "${op.type}" (${row.label}) is not a single column; add it in Creator and export again`);
    }
    field.type = type;
    field.properties.push(prop('type', type, span));
    if (CHOICE_TYPES.has(type)) {
      field.choices = parseChoices(op.choices, 'addField');
      field.properties.push(prop('values', choicesLiteral(field.choices), span));
    } else if (op.choices !== undefined) {
      fail(`addField: field type "${op.type}" takes no choices`);
    }
  }
  form.fields.push(field);
}

function renameField(app: App, op: Extract<EditOp, { op: 'renameField' }>, renames: FieldRename[]): void {
  const form = formOf(app, op.form, 'renameField');
  const field = fieldOf(form, op.from, 'renameField');
  if (op.from === op.to) fail(`renameField: "${op.from}" already has that name`);
  checkNewName(form, op.to, 'renameField', field);
  // The renamed field's generated columns must not land on another field's
  // names either (schema generation would move them to <name>_2 instead).
  if (derivedFieldColumns(field).length > 0) {
    const taken = new Set<string>();
    for (const other of form.fields) {
      if (other === field) continue;
      taken.add(other.name.toLowerCase());
      for (const d of derivedFieldColumns(other)) taken.add(d.toLowerCase());
    }
    const clash = derivedFieldColumns({ ...field, name: op.to }).find((d) => taken.has(d.toLowerCase()));
    if (clash) fail(`renameField: renaming to "${op.to}" collides with the column "${clash}" another field generates`);
  }
  const row = fieldTypeRow(field.type);
  if (field.lookup && row?.kind === 'junction') fail(`renameField: ${form.name}.${field.name} is a multi lookup with its own table; renaming it is not supported`);
  if (row?.kind === 'child-table' || row?.kind === 'junction') {
    fail(`renameField: ${form.name}.${field.name} (${row.label}) has its own table; renaming it is not supported`);
  }
  const usages = fieldUsages(app, form.name, field.name);
  const blocking = usages.filter((u) => !u.rewrite);
  if (blocking.length > 0) {
    fail(`renameField: ${form.name}.${field.name} is used in ${listUsages(blocking)}; change those in Creator and export again, or keep the name`);
  }
  for (const usage of usages) usage.rewrite!(op.to);
  field.name = op.to;
  renames.push({ form: form.name, from: op.from, to: op.to });
}

function removeField(app: App, op: Extract<EditOp, { op: 'removeField' }>): void {
  const form = formOf(app, op.form, 'removeField');
  const field = fieldOf(form, op.field, 'removeField');
  const usages = fieldUsages(app, form.name, field.name);
  if (usages.length > 0) fail(`removeField: ${form.name}.${field.name} is still used in ${listUsages(usages)}`);
  form.fields = form.fields.filter((f) => f !== field);
}

function setPicklist(app: App, op: Extract<EditOp, { op: 'setPicklist' }>): void {
  const form = formOf(app, op.form, 'setPicklist');
  const field = fieldOf(form, op.field, 'setPicklist');
  if (field.lookup) fail(`setPicklist: ${form.name}.${field.name} is a lookup to ${field.lookup.form}; its choices are that form's records`);
  if (!CHOICE_TYPES.has((field.type ?? '').toLowerCase()) && !(field.choices && field.choices.length > 0)) {
    fail(`setPicklist: ${form.name}.${field.name} (${field.type ?? 'no type'}) is not a choice field`);
  }
  const choices = parseChoices(op.choices, 'setPicklist');
  const initial = field.initialValue?.trim().replace(/^"(.*)"$/, '$1');
  if (initial && !choices.includes(initial)) fail(`setPicklist: initial value "${initial}" of ${form.name}.${field.name} is not in the new choices`);
  field.choices = choices;
  setProp(field, 'values', choicesLiteral(choices));
}

function addReportColumn(app: App, op: Extract<EditOp, { op: 'addReportColumn' }>): void {
  const report = app.reports.find((r) => r.name === op.report);
  if (!report) fail(`addReportColumn: unknown report "${op.report}" (reports: ${names(app.reports)})`);
  if (!report.form) fail(`addReportColumn: report "${report.name}" has no form`);
  const form = formOf(app, report.form, 'addReportColumn');
  const [head, tail] = op.field.split('.', 2) as [string, string | undefined];
  const field = fieldOf(form, head, 'addReportColumn');
  if (tail !== undefined) {
    if (!field.lookup) fail(`addReportColumn: ${form.name}.${head} is not a lookup, so "${op.field}" does not resolve`);
    const target = formOf(app, field.lookup.form, 'addReportColumn');
    fieldOf(target, tail, 'addReportColumn');
  }
  if (report.columns.some((c) => c.field === op.field)) fail(`addReportColumn: report "${report.name}" already shows "${op.field}"`);
  const column = (): ReportColumn => ({ field: op.field, ...(op.label !== undefined ? { label: op.label } : {}), properties: [], subcolumns: [], span: { ...report.span } });
  report.columns.push(column());
  // A quick view is what the list shows, so the column goes on its first block too.
  for (const view of report.views) {
    const block = view.kind === 'quickview' ? view.blocks[0] : undefined;
    if (block && !block.fields.some((f) => f.field === op.field)) block.fields.push(column());
  }
}

function addRole(app: App, op: Extract<EditOp, { op: 'addRole' }>): void {
  const name = op.role.trim();
  if (!name || name.length > 50) fail('addRole: give a role name of 1-50 characters');
  const existing = allRoles(app.roles);
  const lower = name.toLowerCase();
  if (existing.some((r) => r.name.toLowerCase() === lower) || app.profiles.some((p) => p.name.toLowerCase() === lower)) {
    fail(`addRole: a role or profile named "${name}" already exists`);
  }
  const span = app.roles[0]?.span ?? { start: 0, end: 0 };
  const role: Role = {
    name,
    ...(op.description ? { description: op.description } : {}),
    properties: op.description ? [prop('description', quote(op.description), span)] : [],
    children: [],
    span: { ...span },
  };
  if (op.parent === undefined) {
    app.roles.push(role);
    return;
  }
  const parent = existing.find((r) => r.name === op.parent);
  if (!parent) fail(`addRole: parent role "${op.parent}" does not exist (roles: ${names(existing)})`);
  parent.children.push(role);
}

/** Apply one op to a copy of the model. The input is not changed. */
export function applyEdit(app: App, op: EditOp): EditResult {
  const next = clone(app);
  const renames: FieldRename[] = [];
  switch (op.op) {
    case 'addField':
      addField(next, op);
      break;
    case 'renameField':
      renameField(next, op, renames);
      break;
    case 'removeField':
      removeField(next, op);
      break;
    case 'setPicklist':
      setPicklist(next, op);
      break;
    case 'addReportColumn':
      addReportColumn(next, op);
      break;
    case 'addRole':
      addRole(next, op);
      break;
    default:
      fail(`unknown edit op "${(op as { op?: unknown }).op}" (ops: ${EDIT_OPS.join(', ')})`);
  }
  return { app: next, renames };
}

/** Replay an edits log in order. A refused op names its position in the log. */
export function applyEdits(app: App, edits: readonly EditOp[]): EditResult {
  let current = app;
  const renames: FieldRename[] = [];
  edits.forEach((op, i) => {
    try {
      const result = applyEdit(current, op);
      current = result.app;
      renames.push(...result.renames);
    } catch (err) {
      if (err instanceof EditError) throw new EditError(`edit ${i + 1} of ${edits.length}: ${err.message}`);
      throw err;
    }
  });
  return { app: current, renames };
}

const OP_KEYS: Record<EditOpName, readonly string[]> = {
  addField: ['form', 'field', 'type', 'label', 'required', 'unique', 'choices', 'lookup'],
  renameField: ['form', 'from', 'to'],
  removeField: ['form', 'field'],
  setPicklist: ['form', 'field', 'choices'],
  addReportColumn: ['report', 'field', 'label'],
  addRole: ['role', 'parent', 'description'],
};

const REQUIRED_KEYS: Record<EditOpName, readonly string[]> = {
  addField: ['form', 'field', 'type'],
  renameField: ['form', 'from', 'to'],
  removeField: ['form', 'field'],
  setPicklist: ['form', 'field', 'choices'],
  addReportColumn: ['report', 'field'],
  addRole: ['role'],
};

/** Check the shape of one op read from a file and return it with keys in a fixed order. */
export function normaliseOp(raw: unknown): EditOp {
  if (!raw || typeof raw !== 'object') fail('an edit must be an object with an "op"');
  const record = raw as Record<string, unknown>;
  const name = record.op as EditOpName;
  if (!EDIT_OPS.includes(name)) fail(`unknown edit op "${String(record.op)}" (ops: ${EDIT_OPS.join(', ')})`);
  const out: Record<string, unknown> = { op: name };
  for (const key of Object.keys(record)) {
    if (key !== 'op' && !OP_KEYS[name].includes(key)) fail(`${name}: unknown key "${key}"`);
  }
  for (const key of REQUIRED_KEYS[name]) if (record[key] === undefined) fail(`${name}: "${key}" is required`);
  for (const key of OP_KEYS[name]) {
    const value = record[key];
    if (value === undefined) continue;
    if (key === 'choices') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) fail(`${name}: "choices" must be a list of strings`);
    } else if (key === 'required' || key === 'unique') {
      if (typeof value !== 'boolean') fail(`${name}: "${key}" must be true or false`);
    } else if (typeof value !== 'string') {
      fail(`${name}: "${key}" must be a string`);
    }
    out[key] = value;
  }
  return out as EditOp;
}

/** `<name>.edits.json` beside a `.ds` file; `c2c.edits.json` inside a project folder. */
export function editsPathFor(target: string): string {
  if (statSync(target, { throwIfNoEntry: false })?.isDirectory()) return join(target, 'c2c.edits.json');
  return join(dirname(target), `${basename(target, extname(target))}.edits.json`);
}

export function readEdits(path: string): EditsFile {
  if (!existsSync(path)) return { version: 1, edits: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${basename(path)} is not valid JSON`);
  }
  const record = parsed as { version?: unknown; edits?: unknown };
  if (!record || record.version !== 1 || !Array.isArray(record.edits)) fail(`${basename(path)} is not an edits log (want {"version": 1, "edits": [...]})`);
  return { version: 1, edits: record.edits.map((op, i) => {
    try {
      return normaliseOp(op);
    } catch (err) {
      throw new EditError(`${basename(path)} edit ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }) };
}

export function editsJson(file: EditsFile): string {
  return `${JSON.stringify({ version: 1, edits: file.edits.map(normaliseOp) }, null, 2)}\n`;
}

export function writeEdits(path: string, file: EditsFile): void {
  writeFileSync(path, editsJson(file));
}

/** The model for a target: the parsed app with its edits log replayed, when one exists. */
export function withEdits(app: App, target: string): App {
  const path = editsPathFor(target);
  if (!existsSync(path)) return app;
  return applyEdits(app, readEdits(path).edits).app;
}
