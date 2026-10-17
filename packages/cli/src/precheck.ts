/**
 * c2c precheck: every migration finding in one pass. Offline. No network.
 *
 * A finding is a `blocker` only when Creator itself rejects the .ds at import or
 * save, or the export cannot be a Creator app (duplicate link names). The same
 * rule applied to connection arguments: a connection argument that matches more
 * than one display name is a `blocker` (`connection-display-name`) because the
 * generated call would keep a string that is no connection's link name. An
 * argument that matches exactly one display name is only a `warning`: the
 * generated call uses that connection's link name. Everything else is
 * a `warning`: the converter migrates it with a documented gap
 * (docs/schema-mapping.md, packages/deploy/src/tables.ts) or the rule is not
 * confirmed against Creator.
 *
 * Link-name length: no local doc states a number (docs/schema-mapping.md and
 * the Deluge help pages under the fixtures deluge-docs tree do not). The
 * report says "unverified limit" and does not invent a cap.
 *
 * Doc paths are local: deluge help pages under $C2C_FIXTURES_DIR/deluge-docs/pages.
 *
 * Known limits:
 * - formula-integration has no real export with `type = integration` to test
 *   against, so the token is the schema matrix token, not an observed one.
 * - Workflows written as `actions { hide …; on success ( … ) }` lose their
 *   handler scripts in the IR. Precheck re-reads those handler blocks from the
 *   source so its script rules still see them.
 */

import { compareEnUs } from '../../core/src/order.js';
import { unquote, type App, type Field, type Form, type RawDeluge, type Workflow } from '../../core/src/ir.js';
import type { Expr, Script, Stmt } from '../../deluge/src/ast.js';
import { parse, parseExpression } from '../../deluge/src/parser.js';
import { connectionArgIndex, declaredConnections, resolveConnectionArgument, type DeclaredConnection } from '../../deluge/src/connections.js';
import { generate } from '../../deluge/src/generate.js';
import { AGGREGATE_METHODS, recognisedBuiltinNames } from '../../deluge/src/dispatch.js';
import { normType } from '../../deluge/src/types.js';
import { UNIQUE_VARCHAR_MAX_PER_TABLE, fieldTypeRow, normalizeType } from '../../schema/src/mapping.js';
import { generateSchema, isStoreVarchar } from '../../schema/src/generator.js';
import { TABLE_NAME_LENGTH_UNVERIFIED, limitValue } from '../../schema/src/limits.js';
import { cyclicForeignKeyComponents, foreignKeyId, tableCreatePlan } from '../../deploy/src/tables.js';

/** Null: no local doc states a Creator link-name maximum. Do not invent one. */
export const LINK_NAME_MAX_LENGTH: number | null = null;

const SENDMAIL_DOC = '$C2C_FIXTURES_DIR/deluge-docs/pages/misc-statements__send-mail.html';
const RUNTIME_MAIL = 'packages/shims/src/runtime.ts';
const SCHEMA_DOC = 'docs/schema-mapping.md';
const TABLES_DOC = 'packages/deploy/src/tables.ts';
const ADAPTERS_DOC = 'packages/shims/src/zoho-adapters.ts';

/** Creator's own error texts. */
export const CREATOR_TEXT = {
  from: 'The "from" address can only be zoho.adminuserid, zoho.loginuserid, or a verified email address. Please specify a valid email address and try again.',
  successMessage: "'success message' can be used only in on success actions",
  criteria: '&lt;multiselect_lookup&sol;subform&gt;.&lt;multiselect_value&gt; is not supported in left expression of criteria',
  arity: (fn: string, mandatory: number) =>
    `The number of arguments for '${fn}' function does not match the number of mandatory params '${mandatory}'.`,
  voidExpr: (fn: string) => `Void function '${fn}' cannot be used in expression`,
  argType: (fn: string, index: number, type: string) =>
    `Data type of argument at index '${index}' of the function '${fn}' did not match the required data type of '${type}'.`,
  usersField: (field: string) => `Invalid user name found for ${field} field`,
  genericImport: 'An error has occurred. Please contact support@zohocreator.com for assistance.',
  /** Import banner for a .ds the importer cannot digest. */
  importProblem: 'A problem encountered while creating the application. Please contact support@zohocreator.com, along with the application .ds file.',
  improperStatement: 'Improper Statement',
  /** Report column "link to view" bound to a report of another form (report-view; sic 'belongs'). */
  belongsView: (column: string, view: string) => `Column '${column}' does not belongs to '${view}' view`,
  /** Creator's message when duplicating such an app fails. */
  duplicateFail: 'Something went wrong. Please retry.',
  /** Workflow-editor response for a deleted/renamed function. */
  missingFn: (fn: string) => `Not able to find "${fn}" function`,
  /** Import error for a script name that is never assigned. */
  undefinedVar: (name: string) => `Variable '${name}' is not defined.`,
} as const;

/** zoho.creator.<task> argument index of app_link_name, from the local help pages. */
const CREATOR_APP_ARG: Readonly<Record<string, { index: number; doc: string }>> = {
  getrecords: { index: 1, doc: '$C2C_FIXTURES_DIR/deluge-docs/pages/creator__get-records.html' },
  getrecordbyid: { index: 1, doc: '$C2C_FIXTURES_DIR/deluge-docs/pages/creator__get-record-by-id.html' },
  createrecord: { index: 1, doc: '$C2C_FIXTURES_DIR/deluge-docs/pages/creator__create-record.html' },
  updaterecord: { index: 1, doc: '$C2C_FIXTURES_DIR/deluge-docs/pages/creator__update-record.html' },
  updaterecords: { index: 1, doc: '$C2C_FIXTURES_DIR/deluge-docs/pages/creator__update-records.html' },
};

/** `.ds` type tokens of multi-value fields. `multiselect` is not one. */
const MULTI_TOKENS = new Set(['list', 'multi select', 'checkboxes', 'lookup multi', 'multi lookup']);
const SUBFORM_TOKENS = new Set(['grid', 'subform', 'inline subform']);
const SKIP_NAMES = new Set([
  'input',
  'old',
  'zoho',
  'thisapp',
  'row',
  'true',
  'false',
  'null',
  'and',
  'or',
  'not',
  // Deluge-provided names: the application object, the current approver inside
  // approval workflow scripts, the workflow `actions` block keyword, and the
  // date constants Creator accepts anywhere an expression stands.
  'app',
  'approver',
  'actions',
  'today',
  'tomorrow',
  'yesterday',
]);
const LOGICAL_OPS = new Set(['&&', '||', 'and', 'or']);

/**
 * Workflow link names that collide with reserved words. Only `Type` is confirmed
 * to fail import: the builder silently renames it to `Type_workflow` and the
 * import shows the generic banner, so only it blocks. The rest are Deluge
 * keywords. A public Creator export carries a workflow named `update`, so they
 * warn. Only workflow link names are checked — a field, report, or even a
 * workflow named `Select`/`View` (both in the Zoho gallery) imports fine.
 */
const CONFIRMED_RESERVED_LINK_NAMES = new Set(['type']);
const RESERVED_LINK_NAMES = new Set([
  ...CONFIRMED_RESERVED_LINK_NAMES,
  'input',
  'old',
  'thisapp',
  'zoho',
  'if',
  'else',
  'for',
  'each',
  'in',
  'while',
  'return',
  'break',
  'continue',
  'sendmail',
  'fetch',
  'insert',
  'update',
  'delete',
  'map',
  'list',
  'collection',
  'void',
  'true',
  'false',
  'null',
  'and',
  'or',
  'not',
  'is',
  'info',
  'alert',
  'openurl',
  'invokeurl',
]);

/** `thisapp.<ns>.<fn>` namespaces Creator itself provides (not user functions). */
const BUILTIN_THISAPP_NS = new Set(['portal', 'permissions', 'blueprint', 'environment']);

/** Bare `name(...)` callees the translator emits as built-ins, so never an unbound variable. */
const FREE_CALLEES = new Set(recognisedBuiltinNames().map((name) => name.toLowerCase()));

/** Param keys whose value is a task keyword written bare (`type :GET`), not a variable read. */
const TASK_ENUM_KEYS = new Set(['type', 'response-format', 'responseformat', 'method']);

/**
 * Workaround text for a construct the converter does not migrate. Precheck
 * prints it as the finding's fix; the migration report's guided residual
 * steps read the same text.
 */
export const CONVERTER_GAP_FIX = {
  field: 'Replace the field, or accept that this converter does not migrate it. analyze and migration-report count the same gap.',
  deluge: 'Rewrite the construct into something the converter already translates, or leave it as a fill-todo. Precheck only lists it.',
} as const;

export type Severity = 'blocker' | 'warning';

export interface PrecheckLocation {
  line: number | null;
  form: string | null;
  field: string | null;
}

export interface PrecheckFinding {
  check: string;
  severity: Severity;
  location: PrecheckLocation;
  message: string;
  fix: string;
}

export interface PrecheckReport {
  schema: 'c2c-precheck/1';
  app: string | null;
  /** Creator link-name maximum. "unverified limit" when no local doc states a number. */
  limits: { linkNameMax: number | 'unverified limit' };
  findings: PrecheckFinding[];
  counts: { blocker: number; warning: number };
}

interface SigParam {
  type: string | null;
  name: string;
  /** False when the signature text gives the param a default (`=`). */
  mandatory: boolean;
}

interface Sig {
  name: string;
  ret: string;
  params: SigParam[];
  line: number | null;
}

/** Where a script runs. It decides what `success message` does there. */
type Context = 'success' | 'validate' | 'function' | 'action' | 'schedule' | 'click' | 'load' | 'input' | 'other';

interface ScriptSrc {
  text: string;
  base: number;
  form: string | null;
  /** Function name for a function body; null for workflow scripts. */
  owner: string | null;
  context: Context;
  /** The event as written: `on validate`, `function`, `schedule on start`, ... */
  where: string;
}

interface Edge {
  from: string;
  to: string;
  line: number | null;
  form: string | null;
  field: string | null;
}

/** Variables of one script scope: inferred type (null when unknown) and fetched form. */
interface Scope {
  types: Map<string, string | null>;
  forms: Map<string, string>;
}

interface Assignment {
  form: string;
  field: string;
  context: Context;
  line: number | null;
}

export function precheck(app: App, source: string): PrecheckReport {
  const findings: PrecheckFinding[] = [];
  const forms = app.forms;
  const formByName = new Map(forms.map((form) => [form.name, form]));

  names(app, source, findings);
  fieldTypes(app, source, findings);
  duplicates(app, source, findings);
  lookups(app, source, findings);
  formulas(forms, source, findings);
  reportFilters(app, source, formByName, findings);

  const sigs = new Map<string, Sig>();
  for (const fn of app.functions) {
    const parsed = fn.signature ? parseSignature(fn.signature) : null;
    if (!parsed) continue;
    sigs.set(parsed.name, { ...parsed, line: lineAt(source, fn.span.start) });
  }
  const scripts = collectScripts(app, source);
  const parsedScripts = scripts.map((script) => ({ script, ast: parse(script.text) }));
  for (const { script, ast } of parsedScripts) collectFns(ast.body, script, sigs, source);

  const walker = new Walker(app, source, sigs, formByName, findings);
  for (const { script, ast } of parsedScripts) walker.walk(script, ast);
  walker.finish();
  cycles(walker.fnEdges, 'function-cycle', 'Cyclic function calls', 'Creator runs these. Check the converted functions do not recurse without an exit.', findings);

  approvers(app, source, formByName, walker.assignments, findings);
  converterGaps(app, source, findings);
  uniqueVarcharBudget(app, source, findings);
  foreignKeyBudget(app, source, findings);

  // States Creator's editor accepts but that break a later import, export, Duplicate or backup.
  reservedNames(app, source, findings);
  customActions(app, source, sigs, findings);
  reportViewColumns(app, source, formByName, findings);
  scriptShapes(scripts, source, findings);
  successStoreCalls(app, scripts, source, findings);
  nonBmpText(app, source, findings);
  pivotReports(app, source, findings);

  findings.sort(cmpFinding);
  let blocker = 0;
  let warning = 0;
  for (const finding of findings) {
    if (finding.severity === 'blocker') blocker++;
    else warning++;
  }
  return {
    schema: 'c2c-precheck/1',
    app: app.name ?? null,
    limits: { linkNameMax: LINK_NAME_MAX_LENGTH ?? 'unverified limit' },
    findings,
    counts: { blocker, warning },
  };
}

export function precheckAsJson(report: PrecheckReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function precheckAsText(report: PrecheckReport): string {
  const lines = [
    `precheck ${report.app ?? '(none)'}  findings ${report.findings.length}  blockers ${report.counts.blocker}  warnings ${report.counts.warning}`,
    `link-name max: ${report.limits.linkNameMax}`,
  ];
  for (const finding of report.findings) {
    const loc = finding.location;
    lines.push(
      `[${finding.severity}] ${finding.check}  line ${loc.line ?? '-'}  form ${loc.form ?? '-'}  field ${loc.field ?? '-'}`,
    );
    lines.push(`  ${finding.message}`);
    lines.push(`  fix: ${finding.fix}`);
  }
  return lines.join('\n');
}

function cmpFinding(a: PrecheckFinding, b: PrecheckFinding): number {
  return (
    compareEnUs(a.check, b.check) ||
    compareEnUs(a.severity, b.severity) ||
    (a.location.line ?? Number.MAX_SAFE_INTEGER) - (b.location.line ?? Number.MAX_SAFE_INTEGER) ||
    compareEnUs(a.location.form ?? '', b.location.form ?? '') ||
    compareEnUs(a.location.field ?? '', b.location.field ?? '') ||
    compareEnUs(a.message, b.message) ||
    compareEnUs(a.fix, b.fix)
  );
}

function lineAt(source: string, offset: number | undefined): number | null {
  if (offset === undefined || offset < 0) return null;
  let n = 1;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i++) if (source.charCodeAt(i) === 10) n++;
  return n;
}

function loc(source: string, offset: number | undefined, form: string | null, field: string | null): PrecheckLocation {
  return { line: lineAt(source, offset), form, field };
}

function push(findings: PrecheckFinding[], finding: PrecheckFinding): void {
  findings.push(finding);
}

/** Form link name of `Form` or `Form[criteria]` (approval `form = ...`). */
function baseForm(name: string | undefined): string | null {
  if (!name) return null;
  const bracket = name.indexOf('[');
  return (bracket < 0 ? name : name.slice(0, bracket)).trim() || null;
}

function contextOf(workflow: Workflow): { context: Context; where: string } {
  const event = workflow.event.trim().toLowerCase();
  const container = (workflow.container ?? workflow.type ?? '').toLowerCase();
  if (container === 'schedule') return { context: 'schedule', where: `schedule ${event}`.trim() };
  return { context: contextOfEvent(event), where: event || container || 'workflow' };
}

function contextOfEvent(event: string): Context {
  if (/\bon success\b/.test(event)) return 'success';
  // `on add { actions { success message "..."; } }` is the form's own On Success message.
  if (/^on (add|edit|add or edit)$/.test(event)) return 'success';
  if (/\bon validate\b/.test(event)) return 'validate';
  if (/\bon click\b/.test(event)) return 'click';
  if (/\bon load\b/.test(event)) return 'load';
  if (/\bon (user input|update|add row|delete row)\b/.test(event)) return 'input';
  return 'other';
}

function collectScripts(app: App, source: string): ScriptSrc[] {
  const out: ScriptSrc[] = [];
  const add = (raw: RawDeluge | null | undefined, form: string | null, owner: string | null, context: Context, where: string) => {
    if (!raw?.text.trim()) return;
    out.push({ text: raw.text, base: raw.span.start, form, owner, context, where });
  };
  for (const workflow of app.workflows) {
    const form = baseForm(workflow.form);
    const { context, where } = contextOf(workflow);
    add(workflow.deluge, form, null, context, where);
    for (const transition of workflow.blueprint?.transitions ?? []) {
      for (const phase of transition.phases) for (const raw of phase.deluge) add(raw, form, null, 'other', 'blueprint');
    }
  }
  // A Creator custom action (`type = functions`) runs on click; Zoho gallery apps use success message there and import.
  for (const fn of app.functions) {
    const context: Context = fn.kind === 'creator' ? 'action' : 'function';
    // A custom action only wraps its function (often of the same name); it is not a node of the call graph.
    const owner = fn.kind === 'creator' ? null : fn.name;
    for (const raw of fn.deluge) add(raw, fn.form ?? null, owner, context, fn.kind === 'creator' ? 'custom action' : 'function');
  }
  recoverHandlers(app, source, out);
  return out;
}

/**
 * The IR drops the handler blocks of `actions { hide X; on success ( … ) on load ( … ) }`.
 * Re-read every `on <event> ( … )` inside a form workflow that no collected script covers.
 */
function recoverHandlers(app: App, source: string, out: ScriptSrc[]): void {
  const covered = out.map((script) => [script.base, script.base + script.text.length] as const);
  const inside = (start: number, end: number) => covered.some(([a, b]) => start < b && end > a);
  const seen = new Set<number>();
  for (const workflow of app.workflows) {
    const container = (workflow.container ?? workflow.type ?? '').toLowerCase();
    if (container !== 'form') continue;
    const { start, end } = workflow.span;
    if (start < 0 || end > source.length || end <= start) continue;
    const text = source.slice(start, end);
    const head = /\bon\s+(success|load|validate|click|user\s+input\s+of\s+\w+|update\s+of\s+\w+)\s*\(/g;
    for (let match = head.exec(text); match; match = head.exec(text)) {
      const open = start + match.index + match[0].length - 1;
      if (seen.has(open)) continue;
      const close = matchParen(source, open, end);
      if (close < 0) continue;
      const body = source.slice(open + 1, close);
      if (!body.trim() || inside(open + 1, close)) continue;
      seen.add(open);
      const event = `on ${match[1].replace(/\s+/g, ' ').toLowerCase()}`;
      out.push({ text: body, base: open + 1, form: baseForm(workflow.form), owner: null, context: contextOfEvent(event), where: event });
    }
  }
}

/** Offset of the `)` closing the `(` at `open`, skipping strings and comments; -1 when unbalanced. */
function matchParen(source: string, open: number, limit: number): number {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const ch = source[i];
    if (ch === '"') {
      for (i++; i < limit && source[i] !== '"'; i++) if (source[i] === '\\') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < limit && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const stop = source.indexOf('*/', i + 2);
      if (stop < 0) return -1;
      i = stop + 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function names(app: App, source: string, findings: PrecheckFinding[]): void {
  const seen = new Set<string>();
  // Display names are free text; only link names become Catalyst identifiers.
  const note = (kind: 'link', value: string | undefined, where: PrecheckLocation) => {
    const text = value?.trim();
    if (!text) return;
    if (!/^\d/.test(text)) {
      lengthNote(text, where, findings);
      return;
    }
    const key = `${kind}\0${where.line}\0${where.form}\0${where.field}\0${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    push(findings, {
      check: 'link-name',
      severity: 'warning',
      location: where,
      message: `Link name "${text}" starts with a digit. Not confirmed as a Creator import error. Length cap: unverified limit.`,
      fix: 'Rename it so the link name and the display name start with a letter. No local doc states a length cap, so the maximum stays an unverified limit.',
    });
  };
  const fieldNames = (field: Field, formName: string) => {
    note('link', field.name, loc(source, field.span.start, formName, field.name));
    for (const sub of field.subfields) fieldNames(sub, formName);
  };
  if (app.name) note('link', app.name, loc(source, 0, null, null));
  for (const form of app.forms) {
    note('link', form.name, loc(source, form.span.start, form.name, null));
    for (const field of form.fields) fieldNames(field, form.name);
    for (const action of form.actions) {
      for (const button of action.buttons) {
        note('link', button.name, loc(source, form.span.start, form.name, button.name));
      }
    }
  }
  for (const report of app.reports) {
    note('link', report.name, loc(source, report.span.start, report.form ?? null, null));
    for (const column of report.columns) note('link', column.field, loc(source, column.span.start, report.form ?? null, column.field));
    for (const action of report.customActions) note('link', action.name, loc(source, action.span.start, report.form ?? null, action.name));
  }
  for (const page of app.pages) {
    note('link', page.name, loc(source, page.span.start, null, null));
  }
  for (const fn of app.functions) note('link', fn.name, loc(source, fn.span.start, fn.form ?? null, null));
}

/** `type = multiselect` is not a .ds field type: Creator fails the import with a generic error. */
function fieldTypes(app: App, source: string, findings: PrecheckFinding[]): void {
  const visit = (field: Field, form: string) => {
    if (normalizeType(field.type) === 'multiselect') {
      push(findings, {
        check: 'field-type',
        severity: 'blocker',
        location: loc(source, field.span.start, form, field.name),
        message: `Field ${field.name} has type = multiselect, which is not a .ds field type. Creator: "${CREATOR_TEXT.genericImport}".`,
        fix: 'Use type = checkboxes (or the multi select keyword from a real export) for a multi-value choice field.',
      });
    }
    for (const sub of field.subfields) visit(sub, form);
  };
  for (const form of app.forms) for (const field of form.fields) visit(field, form.name);
}

function lengthNote(text: string, where: PrecheckLocation, findings: PrecheckFinding[]): void {
  if (LINK_NAME_MAX_LENGTH === null) return;
  if (text.length <= LINK_NAME_MAX_LENGTH) return;
  push(findings, {
    check: 'link-name',
    severity: 'blocker',
    location: where,
    message: `Link or display name length ${text.length} exceeds the documented maximum ${LINK_NAME_MAX_LENGTH}.`,
    fix: `Shorten it to ${LINK_NAME_MAX_LENGTH} characters or fewer.`,
  });
}

type Named = { key: string; line: number | null; field: string };

function duplicates(app: App, source: string, findings: PrecheckFinding[]): void {
  for (const form of app.forms) {
    const labels: Named[] = [];
    for (const field of form.fields) {
      const label = field.displayName?.trim();
      // Section headers are layout, not columns; Zoho apps reuse "Section" freely.
      if (!label || fieldTypeRow(field.type)?.id === 'section') continue;
      labels.push({ key: label, line: lineAt(source, field.span.start), field: field.name });
    }
    emitDupes(labels, form.name, 'warning', 'label', 'field label', findings);
    for (const action of form.actions) {
      const names: Named[] = [];
      const actionLabels: Named[] = [];
      for (const button of action.buttons) {
        names.push({ key: button.name, line: lineAt(source, form.span.start), field: button.name });
        const label = button.displayName?.trim();
        if (label) actionLabels.push({ key: label, line: lineAt(source, form.span.start), field: button.name });
      }
      const event = action.event || 'actions';
      emitDupes(names, form.name, 'blocker', 'action', `action link name on ${event}`, findings);
      emitDupes(actionLabels, form.name, 'warning', 'action-label', `action label on ${event}`, findings);
    }
  }
  for (const report of app.reports) {
    const labels: Named[] = [];
    for (const column of report.columns) {
      const label = column.label?.trim();
      if (!label) continue;
      labels.push({ key: label, line: lineAt(source, column.span.start), field: column.field });
    }
    emitDupes(labels, report.form ?? null, 'warning', 'label', `column label on report ${report.name}`, findings);
    const actions: Named[] = [];
    for (const action of report.customActions) {
      actions.push({ key: action.name, line: lineAt(source, action.span.start), field: action.name });
    }
    emitDupes(actions, report.form ?? null, 'blocker', 'action', `action link name on report ${report.name}`, findings);
  }
}

function emitDupes(items: Named[], form: string | null, severity: Severity, kind: string, what: string, findings: PrecheckFinding[]): void {
  const groups = new Map<string, Named[]>();
  for (const item of items) {
    const list = groups.get(item.key);
    if (list) list.push(item);
    else groups.set(item.key, [item]);
  }
  const keys = [...groups.keys()].sort(compareEnUs);
  for (const key of keys) {
    const group = groups.get(key)!;
    if (group.length < 2) continue;
    const fields = group.map((item) => item.field).sort(compareEnUs);
    const first = group.reduce((a, b) => ((a.line ?? Number.MAX_SAFE_INTEGER) <= (b.line ?? Number.MAX_SAFE_INTEGER) ? a : b));
    push(findings, {
      check: 'duplicate-name',
      severity,
      location: { line: first.line, form, field: first.field },
      message:
        severity === 'blocker'
          ? `Duplicate ${what} "${key}" on ${fields.join(', ')}. Link names must be unique.`
          : `Duplicate ${what} "${key}" on ${fields.join(', ')}. Display text only: Catalyst columns key off link names.`,
      fix: severity === 'blocker' ? `Give each ${kind} its own link name within this form or report.` : `Optional: give each ${kind} its own text so migrated screens are not ambiguous.`,
    });
  }
}

/**
 * Cyclic foreign keys, computed exactly as deploy does: tableCreatePlan over the
 * schema plan (list, grid and checkbox lookups become junction or child tables,
 * a bidirectional subform mirror is one FK). Deploy creates a cyclic must-have
 * FK not mandatory, so this is one warning per strongly-connected component and
 * only when a mandatory FK is relaxed there.
 */
function lookups(app: App, source: string, findings: PrecheckFinding[]): void {
  let steps: ReturnType<typeof tableCreatePlan>;
  try {
    steps = tableCreatePlan(generateSchema(app));
  } catch {
    return;
  }
  const creatable = steps.filter((step) => !step.nosql);
  const tables: string[] = [];
  const formOf = new Map<string, string>();
  const keys: { table: string; column: string; parent: string }[] = [];
  const seenKey = new Set<string>();
  for (const step of creatable) {
    if (!formOf.has(step.table)) {
      formOf.set(step.table, step.form);
      tables.push(step.table);
    }
    for (const column of step.columns) {
      if (!column.parent_table) continue;
      const key = { table: step.table, column: column.column_name, parent: column.parent_table };
      const id = foreignKeyId(key);
      if (seenKey.has(id)) continue;
      seenKey.add(id);
      keys.push(key);
    }
  }
  const components = cyclicForeignKeyComponents(tables, keys);
  const groups = new Map<number, { table: string; column: string }[]>();
  for (const step of creatable) {
    for (const column of step.columns) {
      if (!column.mandatoryRelaxed) continue;
      const id = components.get(foreignKeyId({ table: step.table, column: column.column_name }));
      if (id === undefined) continue;
      const list = groups.get(id);
      const item = { table: step.table, column: column.column_name };
      if (list) list.push(item);
      else groups.set(id, [item]);
    }
  }
  const memberOf = new Map<number, Set<string>>();
  for (const key of keys) {
    const id = components.get(foreignKeyId(key));
    if (id === undefined) continue;
    const set = memberOf.get(id) ?? new Set<string>();
    set.add(key.table);
    set.add(key.parent);
    memberOf.set(id, set);
  }
  for (const [id, relaxed] of groups) {
    relaxed.sort((a, b) => compareEnUs(a.table, b.table) || compareEnUs(a.column, b.column));
    const first = relaxed[0]!;
    const form = formOf.get(first.table) ?? null;
    const field = form ? findFieldLoose(app, form, first.column) : undefined;
    const members = [...(memberOf.get(id) ?? [])].sort(compareEnUs);
    push(findings, {
      check: 'lookup-cycle',
      severity: 'warning',
      location: loc(source, field?.span.start ?? app.forms.find((item) => item.name === form)?.span.start, form, field?.name ?? first.column),
      message: `Cyclic lookups among ${members.join(', ')}. Deploy creates ${relaxed.map((item) => `${item.table}.${item.column}`).join(', ')} not mandatory (mandatory relaxed) and sets the value with a row update. ${TABLES_DOC}`,
      fix: 'No change needed to migrate. If the must-have rule matters, enforce it in the converted function or keep it as a validation.',
    });
  }
}

function findFieldLoose(app: App, formName: string, column: string): Field | undefined {
  const form = app.forms.find((item) => item.name === formName);
  if (!form) return undefined;
  const exact = findField(form.fields, column);
  if (exact) return exact;
  const want = column.toLowerCase();
  const walk = (fields: Field[]): Field | undefined => {
    for (const field of fields) {
      if (field.name.toLowerCase() === want) return field;
      const nested = walk(field.subfields);
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(form.fields);
}

function cycles(edges: Edge[], check: string, title: string, fix: string, findings: PrecheckFinding[]): void {
  const nodes = new Set<string>();
  for (const edge of edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
  }
  const names = [...nodes].sort(compareEnUs);
  const rank = new Map(names.map((name, index) => [name, index]));
  const adj = new Map<string, Edge[]>();
  for (const edge of edges) {
    const list = adj.get(edge.from);
    if (list) list.push(edge);
    else adj.set(edge.from, [edge]);
  }
  for (const list of adj.values()) list.sort((a, b) => compareEnUs(a.to, b.to) || compareEnUs(a.field ?? '', b.field ?? ''));

  const found: { cycle: string[]; edge: Edge }[] = [];
  const dfs = (start: string, current: string, path: string[], via: Edge | null) => {
    for (const edge of adj.get(current) ?? []) {
      if (edge.to === start && via) {
        found.push({ cycle: [...path], edge: via });
        continue;
      }
      const nextRank = rank.get(edge.to);
      const startRank = rank.get(start);
      if (nextRank === undefined || startRank === undefined) continue;
      if (nextRank <= startRank) continue;
      if (path.includes(edge.to)) continue;
      path.push(edge.to);
      dfs(start, edge.to, path, via ?? edge);
      path.pop();
    }
  };
  for (const start of names) {
    const startRank = rank.get(start)!;
    for (const edge of adj.get(start) ?? []) {
      if (edge.to === start) {
        found.push({ cycle: [start], edge });
        continue;
      }
      const nextRank = rank.get(edge.to);
      if (nextRank === undefined || nextRank <= startRank) continue;
      dfs(start, edge.to, [start, edge.to], edge);
    }
  }
  const seen = new Set<string>();
  for (const item of found) {
    const key = item.cycle.join('>');
    if (seen.has(key)) continue;
    seen.add(key);
    const chain = [...item.cycle, item.cycle[0]].join(' -> ');
    push(findings, {
      check,
      severity: 'warning',
      location: { line: item.edge.line, form: item.edge.form, field: item.edge.field },
      message: `${title}: ${chain}.`,
      fix,
    });
  }
}

function formulas(forms: Form[], source: string, findings: PrecheckFinding[]): void {
  const integrations = new Map<string, Field>();
  const walkFields = (fields: Field[]) => {
    for (const field of fields) {
      if (isIntegration(field)) integrations.set(field.name, field);
      walkFields(field.subfields);
    }
  };
  for (const form of forms) walkFields(form.fields);
  if (!integrations.size) return;
  for (const form of forms) {
    const visit = (field: Field) => {
      for (const text of formulaTexts(field)) {
        const refs = exprNames(text);
        const hits = [...refs].filter((name) => integrations.has(name)).sort(compareEnUs);
        for (const hit of hits) {
          push(findings, {
            check: 'formula-integration',
            severity: 'warning',
            location: loc(source, field.span.start, form.name, field.name),
            message: `Formula ${field.name} references integration field ${hit}. Integration is "partial" in ${SCHEMA_DOC}; the integration token is not checked against a real export.`,
            fix: 'Drop the integration field from the formula, or copy its value into a plain field the formula reads.',
          });
        }
      }
      for (const sub of field.subfields) visit(sub);
    };
    for (const field of form.fields) visit(field);
  }
}

function formulaTexts(field: Field): string[] {
  const out: string[] = [];
  const own = normalizeType(field.type);
  if (own === 'formula' || fieldTypeRow(field.type)?.id === 'formula') {
    const value = propOf(field, 'value');
    if (value) out.push(value);
  }
  for (const sub of field.subfields) {
    const name = normalizeType(sub.name);
    if (name === 'formula properties' || sub.name.toLowerCase() === 'formula_properties') {
      const value = propOf(sub, 'value');
      if (value) out.push(value);
    }
  }
  return out;
}

function propOf(field: Field, key: string): string | undefined {
  const found = field.properties.find((property) => property.key.toLowerCase() === key);
  return found ? unquote(found.value).trim() : undefined;
}

function isIntegration(field: Field): boolean {
  return fieldTypeRow(field.type)?.id === 'integration' || normalizeType(field.type) === 'integration';
}

function isMulti(field: Field): boolean {
  const token = normalizeType(field.type);
  if (MULTI_TOKENS.has(token)) return true;
  if (token === 'checkbox' && ((field.choices?.length ?? 0) > 0 || field.lookup)) return true;
  const id = fieldTypeRow(field.type)?.id;
  return id === 'multi-select' || id === 'checkbox-multi' || id === 'lookup-multi';
}

function isSubform(field: Field): boolean {
  const token = normalizeType(field.type);
  if (SUBFORM_TOKENS.has(token)) return true;
  return fieldTypeRow(field.type)?.id === 'subform';
}

function isUsersField(field: Field): boolean {
  return propOf(field, 'module')?.toLowerCase() === 'users' || fieldTypeRow(field.type)?.id === 'users';
}

function fieldOf(form: Form | undefined, name: string): Field | undefined {
  return form ? findField(form.fields, name) : undefined;
}

/**
 * Report criteria and named filters. The Creator blocker (`<multi-lookup|subform>.<multi-value>`
 * on the left of a criteria) is `criteria-multiselect`, shared with Deluge criteria. This keeps
 * one warning: an own multi-value field in a report criteria, which Creator accepts
 * (`checkboxes`) but whose list semantics are "partial" in docs/schema-mapping.md.
 */
function reportFilters(app: App, source: string, formByName: Map<string, Form>, findings: PrecheckFinding[]): void {
  for (const report of app.reports) {
    const form = report.form ? formByName.get(report.form) : undefined;
    if (!form) continue;
    const check = (text: string | undefined, offset: number | undefined, where: string) => {
      if (!text) return;
      const expr = parseExpression(text);
      if (expr.kind === 'unknown') return;
      const rejected = new Set<string>();
      for (const hit of multiselectLeft(expr, form, formByName)) {
        push(findings, criteriaFinding(source, offset, form.name, hit, `Report ${report.name} ${where}`));
        rejected.add(`${hit.lookup}.${hit.value}`);
      }
      const own = new Set<string>();
      const paths = new Set<string>();
      for (const left of leftOperands(expr)) {
        const chain = chainOf(left);
        if (chain?.length === 2 && fieldOf(form, chain[0]!)?.lookup) paths.add(chain.join('.'));
        if (chain?.length !== 1) continue;
        const field = fieldOf(form, chain[0]!);
        if (field && isMulti(field) && !field.lookup) own.add(field.name);
      }
      for (const name of [...own].sort(compareEnUs)) {
        push(findings, {
          check: 'report-filter',
          severity: 'warning',
          location: loc(source, offset, form.name, name),
          message: `Report ${report.name} ${where} compares multi-value field ${name}. Creator accepts it; the converted criteria do not match list semantics ("partial" in ${SCHEMA_DOC}).`,
          fix: 'Check the migrated report filter returns the same rows, or filter on a single-value field.',
        });
      }
      // A criteria Creator rejects is already a blocker; its call cost is moot.
      for (const path of [...paths].filter((item) => !rejected.has(item)).sort(compareEnUs)) {
        const parent = fieldOf(form, path.split('.')[0]!)?.lookup?.form ?? 'the parent form';
        push(findings, {
          check: 'store-calls-lookup-path-filter',
          severity: 'warning',
          location: loc(source, offset, form.name, path.split('.')[0]!),
          message: `Report ${report.name} ${where} filters on lookup path ${path}. Each request first reads ${parent} ${LOOKUP_PATH_PAGE_ROWS} rows per Data Store call for this leaf, then the report rows, so one report request costs ceil(${parent} rows / ${LOOKUP_PATH_PAGE_ROWS}) calls for this leaf plus the report read (over the ${STORE_CALLS_PER_REQUEST_TARGET}-call target once ${parent} passes ${LOOKUP_PATH_PAGE_ROWS * (STORE_CALLS_PER_REQUEST_TARGET - 1)} rows). Above ${LOOKUP_PATH_PARENT_CAP} matching ${parent} records the leaf fails closed and the report shows no rows for it.`,
          fix: `Keep ${parent} small, or store the filtered value on ${form.name} itself and filter on that field.`,
        });
      }
    };
    check(report.criteria, report.span.start, 'criteria');
    for (const filter of report.filters) {
      check(filter.criteria, filter.span.start, filter.label ? `filter "${filter.label}"` : 'filter');
    }
  }
}

/** Rows per parent read of a lookup-path leaf, and the parent ids it accepts (packages/ui/src/generate.ts LOOKUP_PARENT_PAGE_CAP). */
const LOOKUP_PATH_PAGE_ROWS = 300;
const LOOKUP_PATH_PARENT_CAP = 1000;
/** Data Store calls one request should stay within; a design target of this check, not a Catalyst limit. */
export const STORE_CALLS_PER_REQUEST_TARGET = 4;

function criteriaFinding(source: string, offset: number | undefined, form: string, hit: { lookup: string; value: string }, where: string): PrecheckFinding {
  return {
    check: 'criteria-multiselect',
    severity: 'blocker',
    location: loc(source, offset, form, hit.lookup),
    message: `${where}: ${hit.lookup}.${hit.value} is a multi-value field reached through a multi lookup or subform. Creator: "${CREATOR_TEXT.criteria}".`,
    fix: `Rewrite the criteria so its left side is not ${hit.lookup}.${hit.value}: fetch the parent ids first (ids = <Parent>[${hit.value} == ...].ID.getAll(); then ${hit.lookup} in ids), or filter on a single lookup or a scalar field.`,
  };
}

/** Left operands of comparisons in a criteria, and receivers of method calls (`X.contains(...)`). */
function leftOperands(expr: Expr): Expr[] {
  const out: Expr[] = [];
  const visit = (node: Expr) => {
    const flat = unwrap(node);
    if (flat.kind === 'binary') {
      if (LOGICAL_OPS.has(flat.op.toLowerCase())) {
        visit(flat.left);
        visit(flat.right);
      } else out.push(unwrap(flat.left));
      return;
    }
    if (flat.kind === 'unary') {
      visit(flat.expr);
      return;
    }
    if (flat.kind === 'call') {
      const callee = unwrap(flat.callee);
      if (callee.kind === 'member') out.push(unwrap(callee.object));
    }
  };
  visit(expr);
  return out;
}

/** `<multi-lookup|subform>.<multi-value field>` on the left of a criteria over `form`. */
function multiselectLeft(expr: Expr, form: Form, formByName: Map<string, Form>): { lookup: string; value: string }[] {
  const out: { lookup: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const left of leftOperands(expr)) {
    const chain = chainOf(left);
    if (!chain || chain.length !== 2) continue;
    if (SKIP_NAMES.has(chain[0]!.toLowerCase())) continue;
    const via = fieldOf(form, chain[0]!);
    if (!via) continue;
    let value: Field | undefined;
    if (isSubform(via)) {
      value = via.lookup ? fieldOf(formByName.get(via.lookup.form), chain[1]!) : findField(via.subfields, chain[1]!);
    } else if (isMulti(via) && via.lookup) {
      value = fieldOf(formByName.get(via.lookup.form), chain[1]!);
    }
    if (!value || !isMulti(value)) continue;
    const key = `${via.name}.${value.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lookup: via.name, value: value.name });
  }
  return out;
}

function exprNames(text: string): Set<string> {
  const names = new Set<string>();
  const expr = parseExpression(text);
  if (expr.kind === 'unknown') {
    for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const name = match[0];
      if (!SKIP_NAMES.has(name)) names.add(name);
    }
    return names;
  }
  collectNames(expr, names);
  return names;
}

function collectNames(expr: Expr, names: Set<string>): void {
  switch (expr.kind) {
    case 'name':
      if (!SKIP_NAMES.has(expr.name)) names.add(expr.name);
      return;
    case 'member':
      if (expr.object.kind === 'name' && expr.object.name === 'input') names.add(expr.property);
      collectNames(expr.object, names);
      return;
    case 'list':
      for (const element of expr.elements) collectNames(element, names);
      return;
    case 'map':
      for (const entry of expr.entries) {
        collectNames(entry.key, names);
        collectNames(entry.value, names);
      }
      return;
    case 'unary':
      collectNames(expr.expr, names);
      return;
    case 'binary':
      collectNames(expr.left, names);
      collectNames(expr.right, names);
      return;
    case 'call':
      collectNames(expr.callee, names);
      for (const arg of expr.args) collectNames(arg, names);
      return;
    case 'index':
      collectNames(expr.object, names);
      collectNames(expr.index, names);
      return;
    case 'criteria':
      collectNames(expr.object, names);
      collectNames(expr.criteria, names);
      return;
    case 'paren':
      collectNames(expr.expr, names);
      return;
    case 'ifExpr':
      collectNames(expr.test, names);
      collectNames(expr.then, names);
      if (expr.else) collectNames(expr.else, names);
      return;
    case 'sendmail':
    case 'invokeurl':
    case 'insert':
      for (const entry of expr.entries) collectNames(entry.value, names);
      if (expr.kind === 'insert') collectNames(expr.form, names);
      return;
    default:
      return;
  }
}

/** `ret name(params)` where name may be namespaced (`Send_Mail.Send_Notification`). */
export function parseSignature(signature: string): Omit<Sig, 'line'> | null {
  const match = /^\s*([A-Za-z_][\w-]*)\s+([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(([\s\S]*)\)\s*$/.exec(signature.trim());
  if (!match) return null;
  return { ret: match[1]!, name: match[2]!.replace(/\s+/g, ''), params: splitParams(match[3]!) };
}

function splitParams(inner: string): SigParam[] {
  const text = inner.trim();
  if (!text) return [];
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => {
    const mandatory = !part.includes('=');
    const head = part.split('=')[0]?.trim() ?? '';
    const bits = head.split(/\s+/).filter(Boolean);
    if (bits.length >= 2) return { type: bits[0]!, name: bits[bits.length - 1]!, mandatory };
    return { type: null, name: bits[0] ?? head, mandatory };
  });
}

function collectFns(stmts: Stmt[], script: ScriptSrc, sigs: Map<string, Sig>, source: string): void {
  for (const stmt of stmts) {
    if (stmt.kind === 'fn') {
      sigs.set(stmt.name, {
        name: stmt.name,
        ret: stmt.retType ?? 'void',
        params: stmt.params.map((param) => ({ type: param.type ?? null, name: param.name, mandatory: true })),
        line: lineAt(source, script.base + stmt.span.start),
      });
      collectBody(stmt.body, script, sigs, source);
      continue;
    }
    if (stmt.kind === 'block') collectFns(stmt.body, script, sigs, source);
    else if (stmt.kind === 'if') {
      collectBody(stmt.then, script, sigs, source);
      for (const elif of stmt.elifs) collectBody(elif.body, script, sigs, source);
      if (stmt.else) collectBody(stmt.else, script, sigs, source);
    } else if (stmt.kind === 'forEach' || stmt.kind === 'while') collectBody(stmt.body, script, sigs, source);
    else if (stmt.kind === 'try') {
      collectBody(stmt.body, script, sigs, source);
      if (stmt.catchBody) collectBody(stmt.catchBody, script, sigs, source);
    }
  }
}

function collectBody(stmt: Stmt, script: ScriptSrc, sigs: Map<string, Sig>, source: string): void {
  if (stmt.kind === 'block') collectFns(stmt.body, script, sigs, source);
  else collectFns([stmt], script, sigs, source);
}

/** Deluge value types precheck can compare. Anything else is not inferred. */
const KNOWN_TYPES = new Set(['string', 'int', 'float', 'bool', 'date', 'datetime', 'list', 'map']);

/** Creator's upper-case data type name. `int` is BIGINT. */
function creatorTypeName(declared: string): string {
  return normType(declared) === 'int' ? 'BIGINT' : declared.toUpperCase();
}

function compatible(param: string, arg: string): boolean {
  if (param === arg) return true;
  if (param === 'float' && arg === 'int') return true;
  // Zoho-shipped gallery apps pass date-time fields to date params and import fine.
  if ((param === 'datetime' && arg === 'date') || (param === 'date' && arg === 'datetime')) return true;
  return false;
}

/** Deluge type of `input.<field>` from the form field, only for unambiguous scalar types. */
function fieldValueType(field: Field): string | null {
  if (field.lookup || isUsersField(field)) return null;
  const id = fieldTypeRow(field.type)?.id;
  switch (id) {
    case 'single-line':
    case 'multi-line':
    case 'email':
    case 'url':
    case 'rich-text':
      return 'string';
    case 'dropdown':
    case 'radio':
      // `values = Form[...].ID` is a lookup the IR does not model; only a literal choice list is text.
      return field.choices?.length && propOf(field, 'values')?.startsWith('{') ? 'string' : null;
    case 'number':
      return 'int';
    case 'decimal':
    case 'percent':
    case 'currency':
      return 'float';
    case 'date':
      return 'date';
    case 'date-time':
      return 'datetime';
    case 'decision-box':
      return 'bool';
    default:
      return null;
  }
}

const CONVERT_TYPES: Readonly<Record<string, string>> = {
  tostring: 'string',
  tolong: 'int',
  tonumber: 'int',
  tobigint: 'int',
  todecimal: 'float',
  todate: 'date',
  todatetime: 'datetime',
  tolist: 'list',
  tomap: 'map',
};

class Walker {
  readonly fnEdges: Edge[] = [];
  readonly assignments: Assignment[] = [];
  private readonly loginFrom: PrecheckLocation[] = [];
  private current!: ScriptSrc;
  private owner: string | null = null;
  private scope: Scope = { types: new Map(), forms: new Map() };
  /** Lowercased names bound in every script: keywords, app link names, declared functions. */
  private readonly boundGlobal = new Set<string>();
  /** Lowercased field link names of every form; criteria and ui targets name fields. */
  private readonly allFields = new Set<string>();
  /** allFields; bound while walking a field-naming position. */
  private readonly fieldWords = new Set<string>();
  /** Field names of the script's own form; null when the script is not bound to one. */
  private boundFields: Set<string> | null = null;
  /** Extra bound names while walking a position that names schema entities, not variables. */
  private extraNames: Set<string> | null = null;
  private readonly reportedNames = new Set<string>();
  private readonly connections: DeclaredConnection[];

  constructor(
    private readonly app: App,
    private readonly source: string,
    private readonly sigs: Map<string, Sig>,
    private readonly formByName: Map<string, Form>,
    private readonly findings: PrecheckFinding[],
  ) {
    this.connections = declaredConnections(app);
    for (const name of SKIP_NAMES) this.boundGlobal.add(name);
    for (const name of sigs.keys()) this.boundGlobal.add(name.toLowerCase());
    for (const form of app.forms) {
      this.boundGlobal.add(form.name.toLowerCase());
      fieldNamesInto(form.fields, this.allFields);
    }
    for (const report of app.reports) this.boundGlobal.add(report.name.toLowerCase());
    for (const page of app.pages) this.boundGlobal.add(page.name.toLowerCase());
    for (const name of this.allFields) this.fieldWords.add(name);
  }

  walk(script: ScriptSrc, ast: Script): void {
    this.current = script;
    this.owner = script.owner;
    this.scope = this.scopeOf(ast.body, script.owner ? this.sigs.get(script.owner)?.params ?? [] : []);
    this.boundFields = null;
    const form = this.formOf(script.form);
    if (form) {
      this.boundFields = new Set();
      fieldNamesInto(form.fields, this.boundFields);
    }
    this.reportedNames.clear();
    this.stmts(ast.body);
  }

  /** One per-app warning for zoho.loginuserid senders (the runtime does not remap it). */
  finish(): void {
    if (!this.loginFrom.length) return;
    const first = this.loginFrom.reduce((a, b) => ((a.line ?? Number.MAX_SAFE_INTEGER) <= (b.line ?? Number.MAX_SAFE_INTEGER) ? a : b));
    push(this.findings, {
      check: 'sendmail-sender',
      severity: 'warning',
      location: first,
      message: `${this.loginFrom.length} sendmail call${this.loginFrom.length === 1 ? '' : 's'} send from zoho.loginuserid. Creator accepts it; the Catalyst runtime maps only zoho.adminuserid to C2C_MAIL_FROM (${RUNTIME_MAIL}), so mail goes out as the signed-in user's address, which must be a verified sender.`,
      fix: 'Use from : zoho.adminuserid and reply to : zoho.loginuserid, or verify the senders in the Catalyst org.',
    });
  }

  private where(offset: number): PrecheckLocation {
    return loc(this.source, this.current.base + offset, this.current.form, null);
  }

  private formOf(name: string | null): Form | undefined {
    return name ? this.formByName.get(name) : undefined;
  }

  /** Variable types and fetched forms over one scope. A name assigned two different ways is unknown. */
  private scopeOf(stmts: Stmt[], params: { type: string | null; name: string }[]): Scope {
    const scope: Scope = { types: new Map(), forms: new Map() };
    const note = (name: string, type: string | null) => {
      const key = name.toLowerCase();
      if (!scope.types.has(key)) scope.types.set(key, type);
      else if (scope.types.get(key) !== type) scope.types.set(key, null);
    };
    for (const param of params) note(param.name, normType(param.type));
    const visit = (stmt: Stmt) => {
      switch (stmt.kind) {
        case 'block':
          stmt.body.forEach(visit);
          return;
        case 'if':
          visit(stmt.then);
          for (const elif of stmt.elifs) visit(elif.body);
          if (stmt.else) visit(stmt.else);
          return;
        case 'forEach':
          note(stmt.name, null);
          if (stmt.index) note(stmt.index, null);
          visit(stmt.body);
          return;
        case 'while':
          visit(stmt.body);
          return;
        case 'try':
          visit(stmt.body);
          if (stmt.catchName) note(stmt.catchName, null);
          if (stmt.catchBody) visit(stmt.catchBody);
          return;
        case 'unknown': {
          // The statement survives as raw text (a task this parser does not
          // cover, e.g. invokeapi). Creator still binds its assignment target.
          const assigned = /^\s*([A-Za-z_]\w*)\s*(?:[+\-*/|&^%])?=(?!=)/.exec(stmt.text);
          if (assigned) note(assigned[1]!, null);
          return;
        }
        case 'assign': {
          const target = unwrap(stmt.target);
          if (target.kind !== 'name') return;
          if (stmt.op !== '=') {
            if (!scope.types.has(target.name.toLowerCase())) note(target.name, null);
            return;
          }
          note(target.name, stmt.declType ? normType(stmt.declType) : this.literalType(stmt.value));
          const value = unwrap(stmt.value);
          if (value.kind === 'criteria') {
            const chain = chainOf(value.object);
            if (chain?.length === 1 && this.formByName.has(chain[0]!)) scope.forms.set(target.name.toLowerCase(), chain[0]!);
          }
          return;
        }
        default:
          return;
      }
    };
    stmts.forEach(visit);
    return scope;
  }

  /** Type of an expression without variables: literals, typed input fields, conversions, and user function results. */
  private literalType(expr: Expr): string | null {
    const flat = unwrap(expr);
    switch (flat.kind) {
      case 'string':
        return 'string';
      case 'number':
        return /[.]/.test(flat.text) ? 'float' : 'int';
      case 'date':
        return 'date';
      case 'list':
        return 'list';
      case 'map':
        return 'map';
      case 'name':
        if (flat.name === 'true' || flat.name === 'false') return 'bool';
        return null;
      case 'unary':
        if (flat.op === '-' && unwrap(flat.expr).kind === 'number') return this.literalType(flat.expr);
        return null;
      case 'member': {
        const chain = chainOf(flat);
        if (chain?.length !== 2 || chain[0] !== 'input') return null;
        const field = fieldOf(this.formOf(this.current.form), chain[1]!);
        return field ? fieldValueType(field) : null;
      }
      case 'call': {
        const target = this.callTarget(flat);
        if (target) {
          const ret = normType(this.sigs.get(target)?.ret);
          return ret && ret !== 'void' ? ret : null;
        }
        const callee = unwrap(flat.callee);
        if (callee.kind === 'member' && flat.args.length === 0) return CONVERT_TYPES[callee.property.toLowerCase()] ?? null;
        return null;
      }
      default:
        return null;
    }
  }

  private typeOf(expr: Expr): string | null {
    const flat = unwrap(expr);
    if (flat.kind === 'name' && flat.name !== 'true' && flat.name !== 'false') {
      return this.scope.types.get(flat.name.toLowerCase()) ?? null;
    }
    return this.literalType(flat);
  }

  private stmts(stmts: Stmt[]): void {
    for (const stmt of stmts) this.stmt(stmt);
  }

  private stmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'block':
        this.stmts(stmt.body);
        return;
      case 'if':
        this.expr(stmt.test);
        this.stmt(stmt.then);
        for (const elif of stmt.elifs) {
          this.expr(elif.test);
          this.stmt(elif.body);
        }
        if (stmt.else) this.stmt(stmt.else);
        return;
      case 'forEach':
        this.expr(stmt.collection);
        this.stmt(stmt.body);
        return;
      case 'while':
        this.expr(stmt.test);
        this.stmt(stmt.body);
        return;
      case 'try':
        this.stmt(stmt.body);
        if (stmt.catchBody) this.stmt(stmt.catchBody);
        return;
      case 'fn': {
        const saved = { owner: this.owner, scope: this.scope };
        this.owner = stmt.name;
        const body = stmt.body.kind === 'block' ? stmt.body.body : [stmt.body];
        this.scope = this.scopeOf(body, stmt.params.map((param) => ({ type: param.type ?? null, name: param.name })));
        this.stmt(stmt.body);
        this.owner = saved.owner;
        this.scope = saved.scope;
        return;
      }
      case 'assign':
        this.noteAssign(stmt);
        this.expr(stmt.target);
        this.expr(stmt.value);
        return;
      case 'successMessage':
        this.noteSuccessMessage(stmt.span.start);
        this.expr(stmt.value);
        return;
      case 'return':
        if (stmt.value) this.expr(stmt.value);
        return;
      case 'info':
      case 'alert':
        this.expr(stmt.value);
        return;
      case 'expr': {
        const flat = unwrap(stmt.expr);
        if (flat.kind === 'call') this.call(flat, true);
        else this.expr(stmt.expr);
        return;
      }
      case 'openUrl':
        for (const arg of stmt.args) this.expr(arg);
        return;
      case 'ui': {
        // `show Field` names a field, not a variable.
        const saved = this.extraNames;
        this.extraNames = this.fieldWords;
        for (const target of stmt.targets) this.expr(target);
        this.extraNames = saved;
        return;
      }
      case 'deleteFrom':
        this.expr(stmt.target);
        return;
      case 'update':
        this.noteUsersEntries(stmt.target, stmt.entries);
        this.expr(stmt.target);
        for (const entry of stmt.entries) this.expr(entry.value);
        return;
      default:
        return;
    }
  }

  private expr(expr: Expr): void {
    switch (expr.kind) {
      case 'name':
        this.noteName(expr);
        return;
      case 'sendmail':
        this.noteSendmail(expr);
        for (const entry of expr.entries) this.expr(entry.value);
        return;
      case 'invokeurl':
        for (const entry of expr.entries) {
          if (entry.key.toLowerCase() === 'connection') {
            const flat = unwrap(entry.value);
            if (flat.kind === 'string') this.noteConnectionText(flat.value, flat.span.start);
          }
          // `type :GET` writes the task keyword bare, not a variable.
          if (TASK_ENUM_KEYS.has(entry.key.toLowerCase()) && unwrap(entry.value).kind === 'name') continue;
          this.expr(entry.value);
        }
        return;
      case 'call':
        this.call(expr, false);
        return;
      case 'member':
        this.expr(expr.object);
        return;
      case 'list':
        for (const element of expr.elements) this.expr(element);
        return;
      case 'map':
        for (const entry of expr.entries) {
          // A bare `{key: value}` key is a literal, not a variable read.
          if (unwrap(entry.key).kind !== 'name') this.expr(entry.key);
          this.expr(entry.value);
        }
        return;
      case 'unary':
        this.expr(expr.expr);
        return;
      case 'binary':
        this.expr(expr.left);
        this.expr(expr.right);
        return;
      case 'index': {
        this.expr(expr.object);
        // `Form[Name]` is a criteria position: the bare name is a field, not a
        // variable. Only when the indexed name is a schema entity though —
        // `list[i]` subscripts read `i` as an ordinary variable.
        const chain = chainOf(expr.object);
        const criteriaLike = chain?.length === 1 && this.boundGlobal.has(chain[0]!.toLowerCase()) && !this.scope.types.has(chain[0]!.toLowerCase());
        const saved = this.extraNames;
        if (criteriaLike) this.extraNames = this.fieldWords;
        this.expr(expr.index);
        this.extraNames = saved;
        return;
      }
      case 'criteria': {
        const chain = chainOf(expr.object);
        const form = chain?.length === 1 ? this.formByName.get(chain[0]!) : undefined;
        if (form) {
          for (const hit of multiselectLeft(expr.criteria, form, this.formByName)) {
            push(this.findings, criteriaFinding(this.source, this.current.base + expr.span.start, form.name, hit, `Criteria on ${form.name}`));
          }
        }
        this.expr(expr.object);
        {
          // `Form[Field == input.X]` names fields on the left of each comparison.
          const saved = this.extraNames;
          this.extraNames = this.fieldWords;
          this.expr(expr.criteria);
          this.extraNames = saved;
        }
        if (expr.range) {
          this.expr(expr.range.from);
          this.expr(expr.range.to);
        }
        return;
      }
      case 'paren':
        this.expr(expr.expr);
        return;
      case 'ifExpr':
        this.expr(expr.test);
        this.expr(expr.then);
        if (expr.else) this.expr(expr.else);
        return;
      case 'insert':
        this.noteUsersEntries(expr.form, expr.entries);
        this.expr(expr.form);
        for (const entry of expr.entries) this.expr(entry.value);
        return;
      case 'mailAttachments':
        for (const item of expr.items) {
          if (item.value) this.expr(item.value);
          if (item.criteria) {
            // A view/report criteria names its fields.
            const saved = this.extraNames;
            this.extraNames = this.fieldWords;
            this.expr(item.criteria);
            this.extraNames = saved;
          }
          if (item.record) this.expr(item.record);
        }
        return;
      case 'colonCall':
        this.expr(expr.object);
        for (const arg of expr.args) this.expr(arg);
        return;
      default:
        return;
    }
  }

  /** `statement` is true only for a call that is the whole statement; any other void call is an expression. */
  private call(expr: Extract<Expr, { kind: 'call' }>, statement: boolean): void {
    this.noteCrossApp(expr);
    this.noteConnectionArgument(expr);
    const target = this.callTarget(expr);
    const sig = target ? this.sigs.get(target) : undefined;
    if (target && sig) {
      if (this.owner) {
        this.fnEdges.push({ from: this.owner, to: target, line: this.where(expr.span.start).line, form: this.current.form, field: null });
      }
      if (!statement && normType(sig.ret) === 'void') {
        push(this.findings, {
          check: 'void-assign',
          severity: 'blocker',
          location: this.where(expr.span.start),
          message: `${CREATOR_TEXT.voidExpr(target)}.`,
          fix: `Call ${target} as a statement on its own line, or give it a return type.`,
        });
      }
      this.noteArgs(expr, target, sig);
    } else {
      this.noteCallTarget(expr);
    }
    const callee = unwrap(expr.callee);
    if (callee.kind !== 'name' || !FREE_CALLEES.has(callee.name.toLowerCase())) this.expr(expr.callee);
    // `Form[criteria].sum(Field)` names a field of the form, not a variable.
    const fieldArgs = callee.kind === 'member' && AGGREGATE_METHODS.has(callee.property.toLowerCase());
    const saved = this.extraNames;
    if (fieldArgs) this.extraNames = this.fieldWords;
    for (const arg of expr.args) this.expr(arg);
    this.extraNames = saved;
  }

  private callTarget(expr: Extract<Expr, { kind: 'call' }>): string | null {
    const chain = chainOf(expr.callee);
    if (!chain) return null;
    if (chain.length === 1) return this.sigs.has(chain[0]!) ? chain[0]! : null;
    if (chain[0]!.toLowerCase() !== 'thisapp') return null;
    const name = chain.slice(1).join('.');
    return this.sigs.has(name) ? name : null;
  }

  /**
   * A bare name read that nothing in the script declares. Assignments hoist for
   * this check (`scopeOf` scans the whole body first), so only a name that is
   * never assigned, looped, caught or passed in is flagged. Keywords, app link
   * names, field names of the current form and declared functions are bound.
   * Creator rejects the import; the emitted code would carry the name unbound.
   * One finding per script per name, at its first read.
   */
  private noteName(expr: Extract<Expr, { kind: 'name' }>): void {
    const key = expr.name.toLowerCase();
    if (this.reportedNames.has(key)) return;
    if (this.scope.types.has(key) || this.boundGlobal.has(key)) return;
    if (this.boundFields?.has(key) || this.extraNames?.has(key)) return;
    this.reportedNames.add(key);
    push(this.findings, {
      check: 'undefined-variable',
      severity: 'blocker',
      location: this.where(expr.span.start),
      message: `${expr.name} is read but never assigned in this script. Creator: "${CREATOR_TEXT.undefinedVar(expr.name)}".`,
      fix: `Assign ${expr.name} earlier in the script, pass it in as a parameter, or remove the reference.`,
    });
  }

  /**
   * A `thisapp.<fn>(...)` call that names no declared function. The
   * workflow->function binding still points at a deleted or renamed function.
   * Creator regenerates the call on export and fails with
   * `Not able to find "fn" function`. Built-in `thisapp.portal.*`,
   * `thisapp.permissions.*`, `thisapp.blueprint.*` and `thisapp.environment.*`
   * namespaces are not user functions, and a `type =
   * functions` workflow link name is a binding target, not a callable function.
   */
  private noteCallTarget(expr: Extract<Expr, { kind: 'call' }>): void {
    const chain = chainOf(expr.callee);
    if (!chain || chain.length < 2 || chain[0]!.toLowerCase() !== 'thisapp') return;
    const name = chain.slice(1).join('.');
    if (BUILTIN_THISAPP_NS.has(name.split('.')[0]!.toLowerCase())) return;
    if (this.app.functions.some((fn) => fn.kind === 'creator' && fn.name === name)) return;
    push(this.findings, {
      check: 'call-target',
      severity: 'blocker',
      location: this.where(expr.span.start),
      message: `thisapp.${name}(...) calls a function that does not exist. Creator: "${CREATOR_TEXT.missingFn(name)}".`,
      fix: `Restore a function ${name}, or repoint the call at an existing one.`,
    });
  }

  private noteArgs(expr: Extract<Expr, { kind: 'call' }>, target: string, sig: Sig): void {
    const mandatory = sig.params.filter((param) => param.mandatory).length;
    const got = expr.args.length;
    const where = this.where(expr.span.start);
    if (got < mandatory || got > sig.params.length) {
      push(this.findings, {
        check: 'signature',
        severity: 'blocker',
        location: where,
        message: `${CREATOR_TEXT.arity(target, mandatory)} The call passes ${got}; the declaration has ${sig.params.length}.`,
        fix: `Pass the ${mandatory} mandatory parameter${mandatory === 1 ? '' : 's'} declared by ${target} at this call, or change the declaration back.`,
      });
      return;
    }
    for (let index = 0; index < got; index++) {
      const param = sig.params[index]!;
      const want = normType(param.type);
      if (!param.type || !want || !KNOWN_TYPES.has(want)) continue;
      const have = this.typeOf(expr.args[index]!);
      if (!have || !KNOWN_TYPES.has(have) || compatible(want, have)) continue;
      push(this.findings, {
        check: 'signature',
        severity: 'blocker',
        location: where,
        message: `${CREATOR_TEXT.argType(target, index + 1, creatorTypeName(param.type))} The argument is ${have}.`,
        fix: `Pass a ${param.type} value as argument ${index + 1} of ${target}${want === 'string' ? ' (for example value.toString())' : ''}, or change the parameter type.`,
      });
    }
  }

  /** A connection argument that names a declared connection by display name. */
  private noteConnectionArgument(expr: Extract<Expr, { kind: 'call' }>): void {
    const chain = chainOf(expr.callee);
    if (!chain || chain.length < 3 || chain[0]!.toLowerCase() !== 'zoho') return;
    const index = connectionArgIndex(chain.slice(1), expr.args.length);
    if (index == null) return;
    const arg = expr.args[index];
    if (!arg) return;
    const flat = unwrap(arg);
    if (flat.kind !== 'string') return;
    this.noteConnectionText(flat.value, flat.span.start);
  }

  private noteConnectionText(argument: string, offset: number): void {
    const resolved = resolveConnectionArgument(argument, this.connections);
    if (resolved.kind === 'display') {
      push(this.findings, {
        check: 'connection-display-name',
        severity: 'warning',
        location: this.where(offset),
        message: `Connection argument "${argument}" is the display name of ${resolved.link}, not its link name. The generated call uses the link name ${resolved.link}.`,
        fix: `Pass the connection link name ${resolved.link}.`,
      });
      return;
    }
    if (resolved.kind === 'ambiguous') {
      push(this.findings, {
        check: 'connection-display-name',
        severity: 'blocker',
        location: this.where(offset),
        message: `Connection argument "${argument}" matches the display name of ${resolved.links.join(', ')}. The generated call keeps "${argument}" because more than one connection uses that display name.`,
        fix: 'Pass the link name of the connection this call should use.',
      });
    }
  }

  private noteCrossApp(expr: Extract<Expr, { kind: 'call' }>): void {
    const chain = chainOf(expr.callee);
    if (!chain || chain.length < 3 || chain.length > 4) return;
    if (chain[0]!.toLowerCase() !== 'zoho' || chain[1]!.toLowerCase() !== 'creator') return;
    if (chain.length === 4 && !/^v\d+(_\d+)?$/i.test(chain[2]!)) return;
    const task = chain[chain.length - 1]!;
    const spec = CREATOR_APP_ARG[task.toLowerCase()];
    if (!spec) return;
    const arg = expr.args[spec.index];
    if (!arg) return;
    const flat = unwrap(arg);
    if (flat.kind !== 'string') return;
    const link = flat.value.trim();
    if (!link) return;
    if (this.app.name && slug(link) === slug(this.app.name)) return;
    push(this.findings, {
      check: 'cross-app',
      severity: 'warning',
      location: this.where(expr.span.start),
      message: `Cross-app reference to "${link}" in ${chain.slice(0, -1).join('.')}.${task}. The migrated function calls Creator through a connection (${ADAPTERS_DOC}). ${spec.doc}`,
      fix: 'Authorize a Creator connection for the other app at deploy, or migrate that app too and point the call at its tables.',
    });
  }

  private noteSendmail(expr: Extract<Expr, { kind: 'sendmail' }>): void {
    const from = expr.entries.find((entry) => entry.key.toLowerCase() === 'from');
    if (!from) return;
    const where = this.where(from.value.span.start);
    const flat = unwrap(from.value);
    const zoho = (text: string) => /^zoho\.(adminuserid|adminuser|loginuserid)$/i.exec(text.trim())?.[1]?.toLowerCase();
    let leaf: string | undefined;
    if (flat.kind === 'string') leaf = zoho(flat.value);
    else {
      const chain = chainOf(flat);
      if (chain?.length === 2) leaf = zoho(chain.join('.'));
    }
    if (leaf === 'adminuserid' || leaf === 'adminuser') return;
    if (leaf === 'loginuserid') {
      this.loginFrom.push(where);
      return;
    }
    if (flat.kind === 'string') {
      const literal = flat.value.trim();
      push(this.findings, {
        check: 'sendmail-sender',
        severity: 'blocker',
        location: where,
        message: `sendmail from is the literal "${literal}". Creator: "${CREATOR_TEXT.from}" (${SENDMAIL_DOC}). Verified addresses are per account, so the target account rejects it at import.`,
        fix: `Use from : zoho.adminuserid and add reply to : "${literal}".`,
      });
      return;
    }
    push(this.findings, {
      check: 'sendmail-sender',
      severity: 'warning',
      location: where,
      message: `sendmail from is an expression. Creator does not check it at import; at run time it must be zoho.adminuserid, zoho.loginuserid, or a verified address. ${SENDMAIL_DOC}`,
      fix: 'Use from : zoho.adminuserid and put the computed address in reply to.',
    });
  }

  private noteSuccessMessage(offset: number): void {
    const { context, where } = this.current;
    if (context === 'success' || context === 'action') return;
    const blocker = context === 'validate' || context === 'function' || context === 'schedule';
    const quiet = context === 'load' || context === 'input';
    push(this.findings, {
      check: 'success-message',
      severity: blocker ? 'blocker' : 'warning',
      location: this.where(offset),
      message: blocker
        ? `success message in ${where}. Creator: "${CREATOR_TEXT.successMessage}".`
        : quiet
          ? `success message in ${where}. Creator imports it but shows nothing: a silent no-op.`
          : `success message in ${where}. Creator allows it only in on success actions; this context is not confirmed against Creator.`,
      fix: blocker
        ? 'Move the success message into an on success workflow, or use alert here. In a function, return the text and let the caller show it.'
        : 'Move the success message into an on success workflow, or use alert / info here.',
    });
  }

  private noteAssign(stmt: Extract<Stmt, { kind: 'assign' }>): void {
    const target = unwrap(stmt.target);
    if (target.kind !== 'member') return;
    const object = unwrap(target.object);
    if (object.kind !== 'name') return;
    const formName = object.name === 'input' ? this.current.form : this.scope.forms.get(object.name.toLowerCase()) ?? null;
    if (!formName) return;
    const field = fieldOf(this.formOf(formName), target.property);
    if (!field) return;
    const line = this.where(stmt.span.start).line;
    this.assignments.push({ form: formName, field: field.name, context: this.current.context, line });
    if (isUsersField(field) && isEmailValue(stmt.value)) this.usersFinding(formName, field.name, stmt.span.start);
  }

  private noteUsersEntries(target: Expr, entries: { key: string; value: Expr }[]): void {
    const chain = chainOf(unwrap(target));
    const form = chain?.length === 1 ? this.formByName.get(chain[0]!) : undefined;
    if (!form) return;
    for (const entry of entries) {
      const field = fieldOf(form, entry.key);
      if (field && isUsersField(field) && isEmailValue(entry.value)) this.usersFinding(form.name, field.name, entry.value.span.start);
    }
  }

  private usersFinding(form: string, field: string, offset: number): void {
    push(this.findings, {
      check: 'users-field',
      severity: 'warning',
      location: { ...this.where(offset), form, field },
      message: `Users field ${field} is set to an email address. The record saves, then the script fails: "${CREATOR_TEXT.usersField(field)}".`,
      fix: 'Assign the user name: zoho.loginuser instead of zoho.loginuserid.',
    });
  }
}

/** zoho.loginuserid / zoho.adminuserid, or a string literal holding an address. */
function isEmailValue(expr: Expr): boolean {
  const flat = unwrap(expr);
  if (flat.kind === 'string') return /@/.test(flat.value);
  const chain = chainOf(flat);
  return chain?.length === 2 && chain[0]!.toLowerCase() === 'zoho' && /^(loginuserid|adminuserid)$/i.test(chain[1]!);
}

/**
 * Creator associates an approval from the submitted values, before On Success runs.
 * An approver or criteria field that only an On Success script sets is empty when
 * that happens.
 */
function approvers(app: App, source: string, formByName: Map<string, Form>, assignments: Assignment[], findings: PrecheckFinding[]): void {
  // The IR has one Workflow per approval handler (on start, on level N / on approve, ...); merge them.
  const byApproval = new Map<string, { workflow: Workflow; approvers: Workflow['approvers'] & object }>();
  for (const workflow of app.workflows) {
    if ((workflow.container ?? workflow.type ?? '').toLowerCase() !== 'approval') continue;
    const key = `${workflow.name}\0${workflow.form ?? ''}`;
    const entry = byApproval.get(key) ?? { workflow, approvers: [] };
    entry.approvers.push(...(workflow.approvers ?? []));
    byApproval.set(key, entry);
  }
  const seen = new Set<string>();
  for (const { workflow, approvers: settings } of byApproval.values()) {
    const formName = baseForm(workflow.form);
    const form = formName ? formByName.get(formName) : undefined;
    if (!form) continue;
    const wanted = new Map<string, string>();
    for (const property of settings) {
      if (property.key.toLowerCase() !== 'field') continue;
      const field = fieldOf(form, unquote(property.value).trim());
      if (field) wanted.set(field.name, 'approver');
    }
    const raw = workflow.form ?? '';
    const bracket = raw.indexOf('[');
    if (bracket >= 0 && raw.endsWith(']')) {
      for (const name of exprNames(raw.slice(bracket + 1, -1))) {
        const field = fieldOf(form, name);
        if (field && !wanted.has(field.name)) wanted.set(field.name, 'criteria');
      }
    }
    for (const [fieldName, role] of [...wanted].sort((a, b) => compareEnUs(a[0], b[0]))) {
      const key = `${workflow.name}\0${form.name}\0${fieldName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sets = assignments.filter((item) => item.form === form.name && item.field === fieldName);
      if (!sets.length || sets.some((item) => item.context !== 'success')) continue;
      const first = sets.reduce((a, b) => ((a.line ?? Number.MAX_SAFE_INTEGER) <= (b.line ?? Number.MAX_SAFE_INTEGER) ? a : b));
      push(findings, {
        check: 'approver-on-success',
        severity: 'warning',
        location: { line: first.line ?? lineAt(source, workflow.span.start), form: form.name, field: fieldName },
        message: `Approval ${workflow.name} uses ${fieldName} as its ${role === 'approver' ? 'approver field' : 'criteria field'}, but only an On Success script sets it. Creator associates the approval from the submitted values before On Success runs, so the record ${role === 'approver' ? 'gets no approver from it' : 'never enters the approval'}.`,
        fix: `Set it in On Validate instead (input.${fieldName} = ...; assigning input fields there is saved), or on the form.`,
      });
    }
  }
}

function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function unwrap(expr: Expr): Expr {
  return expr.kind === 'paren' ? unwrap(expr.expr) : expr;
}

function chainOf(expr: Expr): string[] | null {
  const parts: string[] = [];
  let current = unwrap(expr);
  while (current.kind === 'member') {
    parts.unshift(current.property);
    current = unwrap(current.object);
  }
  if (current.kind !== 'name') return null;
  parts.unshift(current.name);
  return parts;
}

function converterGaps(app: App, source: string, findings: PrecheckFinding[]): void {
  const plan = generateSchema(app);
  for (const blocker of plan.limitBlockers ?? []) {
    const form = app.forms.find((item) => item.name === blocker.form);
    const found = blocker.field && form ? findField(form.fields, blocker.field) : undefined;
    const unverified = blocker.limitId === TABLE_NAME_LENGTH_UNVERIFIED;
    push(findings, {
      check: unverified ? TABLE_NAME_LENGTH_UNVERIFIED : 'catalyst-column-cap',
      severity: unverified ? 'warning' : 'blocker',
      location: loc(source, found?.span.start ?? form?.span.start, blocker.form, blocker.field),
      message: blocker.message,
      fix: blocker.fix,
    });
  }
  for (const field of plan.fields) {
    if (field.status !== 'unsupported') continue;
    const form = app.forms.find((item) => item.name === field.form);
    const found = form ? findField(form.fields, field.field) : undefined;
    push(findings, {
      check: 'converter-gap',
      severity: 'warning',
      location: loc(source, found?.span.start, field.form, field.field),
      message: `Schema marks ${field.field} (${field.matrixId}) unsupported. ${SCHEMA_DOC}`,
      fix: CONVERTER_GAP_FIX.field,
    });
  }
  let generated: { construct: string; start: number }[];
  try {
    generated = generate(app).todos.map((todo) => ({ construct: todo.construct, start: todo.start }));
  } catch {
    generated = [];
  }
  generated.sort((a, b) => a.start - b.start || compareEnUs(a.construct, b.construct));
  const seen = new Set<string>();
  for (const todo of generated) {
    const key = `${todo.construct}\0${todo.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const form = formAt(app, todo.start);
    push(findings, {
      check: 'converter-gap',
      severity: 'warning',
      location: loc(source, todo.start, form, null),
      message: `Deluge construct ${todo.construct} is still a migration TODO. analyze and migration-report count it.`,
      fix: CONVERTER_GAP_FIX.deluge,
    });
  }
}

/**
 * Data Store unique varchar budget per table (UNIQUE_VARCHAR_MAX_PER_TABLE; evidence in
 * packages/schema/src/mapping.ts). The schema keeps the excess as app-level unique, so
 * deploy does not fail; precheck says which fields lose store-level enforcement.
 */
function uniqueVarcharBudget(app: App, source: string, findings: PrecheckFinding[]): void {
  for (const table of generateSchema(app).tables) {
    if (table.nosql) continue;
    const appLevel = table.columns.filter((column) => column.appUnique);
    if (!appLevel.length) continue;
    const kept = table.columns.filter((column) => column.unique && isStoreVarchar(column)).map((column) => column.name);
    const form = app.forms.find((item) => item.name === table.form);
    const first = form ? findField(form.fields, appLevel[0]!.name) : undefined;
    push(findings, {
      check: 'unique-varchar-budget',
      severity: 'warning',
      location: loc(source, first?.span.start ?? form?.span.start, table.form, appLevel[0]!.name),
      message: `${table.name} has ${kept.length + appLevel.length} unique text fields; Data Store allows ${UNIQUE_VARCHAR_MAX_PER_TABLE} unique varchar columns per table (403 "Reached max number of columns of Unique varchar type"). Store-level unique: ${kept.join(', ') || 'none'}. Checked by the c2c handler instead: ${appLevel.map((column) => column.name).join(', ')}.`,
      fix: `Keep at most ${UNIQUE_VARCHAR_MAX_PER_TABLE} no-duplicate text fields on this form, or accept handler-level checks: they run before each insert and update but are not atomic, and a CSV or seed import does not re-check them.`,
    });
  }
}

/**
 * Data Store foreign-key budget per table (datastore.fk_columns, unverified). The schema
 * stores the lookups past it as plain bigint ROWID ids, so deploy does not fail;
 * precheck names each one, since the store neither checks it nor applies ON DELETE.
 */
function foreignKeyBudget(app: App, source: string, findings: PrecheckFinding[]): void {
  const max = limitValue('datastore.fk_columns');
  for (const table of generateSchema(app).tables) {
    const plain = table.columns.filter((column) => column.plainLookup);
    if (!plain.length) continue;
    const form = app.forms.find((item) => item.name === table.form);
    const first = form ? findField(form.fields, plain[0]!.name) : undefined;
    push(findings, {
      check: 'datastore.fk_columns',
      severity: 'warning',
      location: loc(source, first?.span.start ?? form?.span.start, table.form, plain[0]!.name),
      message: `${table.name} has ${max + plain.length} lookups; Data Store allows ${max} foreign keys per table (unverified). Stored as plain bigint ROWID ids with no store check or ON DELETE: ${plain
        .map((column) => `${column.name} -> ${column.relation!.table}`)
        .join(', ')}.`,
      fix: `Keep at most ${max} lookups on this form (move the rest to a child table), or accept plain ids: deleting a parent row leaves them behind, so clear or re-point them when you delete one.`,
    });
  }
}

function findField(fields: Field[], name: string): Field | undefined {
  for (const field of fields) {
    if (field.name === name) return field;
    const nested = findField(field.subfields, name);
    if (nested) return nested;
  }
  return undefined;
}

/** Every field and subfield link name of a form, lowercased, into `out`. `ID` and the audit fields are implicit on every record. */
function fieldNamesInto(fields: Field[], out: Set<string>): void {
  for (const system of ['id', 'added_time', 'modified_time', 'added_user', 'modified_user']) out.add(system);
  for (const field of fields) {
    out.add(field.name.toLowerCase());
    fieldNamesInto(field.subfields, out);
  }
}

function formAt(app: App, offset: number): string | null {
  for (const workflow of app.workflows) {
    if (offset >= workflow.span.start && offset <= workflow.span.end) return baseForm(workflow.form);
  }
  for (const fn of app.functions) {
    if (offset >= fn.span.start && offset <= fn.span.end) return fn.form ?? null;
  }
  return null;
}

/**
 * reserved-name: a workflow link name that is a reserved word fails import with the
 * generic banner — the builder cannot create it (it renames `Type` to
 * `Type_workflow`), so the .ds carries legacy or hand-edited metadata. Fields
 * and reports may use these names; only workflow link names are checked.
 */
function reservedNames(app: App, source: string, findings: PrecheckFinding[]): void {
  const check = (name: string, offset: number | undefined, form: string | null) => {
    const key = name.toLowerCase();
    if (!RESERVED_LINK_NAMES.has(key)) return;
    const confirmed = CONFIRMED_RESERVED_LINK_NAMES.has(key);
    push(findings, {
      check: 'reserved-name',
      severity: confirmed ? 'blocker' : 'warning',
      location: loc(source, offset, form, null),
      message: confirmed
        ? `Workflow link name "${name}" is reserved. The Creator builder renames it to "${name}_workflow" and import fails with "${CREATOR_TEXT.genericImport}".`
        : `Workflow link name "${name}" is a Deluge keyword. Only "Type" is confirmed to fail import with "${CREATOR_TEXT.genericImport}"; this one is advisory.`,
      fix: `Rename the workflow link name, e.g. to "${name}_workflow", as the builder does.`,
    });
  };
  for (const workflow of app.workflows) check(workflow.name, workflow.span.start, baseForm(workflow.form));
  for (const fn of app.functions) if (fn.kind === 'creator') check(fn.name, fn.span.start, fn.form ?? null);
}

/**
 * A report `custom action` binds a `type = functions` workflow via
 * `workflow = <name>`. Every builder-made report with a custom action also
 * carries its quickview/detailview metadata. A `custom action` block in a
 * report with no views at all makes exportScript return HTTP 200 with 0 bytes
 * and Duplicate fail even with a matched signature. That shape is
 * the hand-written block, and blocks. Real Creator exports do leave some actions
 * out of their views' menus, so an action missing from the views of a report
 * that has views is not flagged. A `workflow =` target that is not a
 * `type = functions` workflow is the same dangling-reference family.
 *
 * A `collection of records` action bound to a function whose first parameter is
 * not the form object is accepted by Creator, so it stays a warning: the
 * collection binding can act on one value at best.
 */
function customActions(app: App, source: string, sigs: Map<string, Sig>, findings: PrecheckFinding[]): void {
  const creatorFns = new Map(app.functions.filter((fn) => fn.kind === 'creator').map((fn) => [fn.name, fn]));
  const workflowNames = new Set(app.workflows.map((workflow) => workflow.name));
  for (const report of app.reports) {
    for (const action of report.customActions) {
      const at = loc(source, action.span.start, report.form ?? null, action.name);
      const bound = action.workflow?.trim();
      if (!bound || !creatorFns.has(bound)) {
        const why = !bound
          ? 'binds no workflow'
          : workflowNames.has(bound) || sigs.has(bound)
            ? `binds "${bound}", which is not a "type = functions" workflow`
            : `binds workflow "${bound}", which does not exist`;
        push(findings, {
          check: 'custom-action',
          severity: 'blocker',
          location: at,
          message: `Report "${report.name}" custom action "${action.name}" ${why}. A dangling or hand-written binding makes exportScript return HTTP 200 with 0 bytes and Duplicate fail with "${CREATOR_TEXT.duplicateFail}".`,
          fix: 'Remove the custom action block, or point "workflow =" at a "type = functions" workflow that exists.',
        });
        continue;
      }
      if (!report.views.length) {
        push(findings, {
          check: 'custom-action',
          severity: 'blocker',
          location: at,
          message: `Report "${report.name}" custom action "${action.name}" sits in a report with no quickview/detailview metadata. The builder always writes that metadata; a bare block is hand-written — exportScript returns HTTP 200 with 0 bytes and Duplicate fails with "${CREATOR_TEXT.duplicateFail}".`,
          fix: 'Delete the block and add the action in the Creator builder so the view metadata is written, or drop it from the .ds.',
        });
      }
    }
  }
  for (const fn of app.functions) {
    if (fn.kind !== 'creator') continue;
    const exec = fn.properties.find((property) => property.key.toLowerCase() === 'execution type')?.value;
    if (unquote(exec ?? '').trim().toLowerCase() !== 'collection of records') continue;
    const formName = baseForm(fn.form);
    if (!formName) continue;
    const seen = new Set<string>();
    for (const raw of fn.deluge) {
      for (const match of raw.text.matchAll(/\bthisapp\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)) {
        const name = match[1]!;
        if (seen.has(name)) continue;
        seen.add(name);
        const sig = sigs.get(name);
        if (!sig) continue;
        const first = sig.params[0];
        // `void f(Form recs)` is the correct collection binding (custom-action).
        if (first && (!first.type || first.type === formName)) continue;
        const detail = first ? `whose first parameter is "${first.type} ${first.name}"` : 'which takes no parameters';
        push(findings, {
          check: 'custom-action',
          severity: 'warning',
          location: loc(source, fn.span.start, formName, null),
          message: `Custom action workflow "${fn.name}" runs on a collection of records but calls thisapp.${name}(...) ${detail} — a non-form parameter receives at best one value. Creator accepts the binding everywhere it was tested; this is advisory.`,
          fix: `Bind the collection to a function that takes the ${formName} record object, e.g. "void ${name.split('.').pop()}(${formName} recs)" called as thisapp.${name}(${formName}).`,
        });
      }
    }
  }
}

/**
 * report-view: a lookup column's `view = <report>` ("link to view") must name a
 * report of the lookup's target form; otherwise import fails with
 * `Column '<label>' does not belongs to '<view>' view`. The builder only offers
 * matching views, so the mismatch cannot be authored in the UI.
 */
function reportViewColumns(app: App, source: string, formByName: Map<string, Form>, findings: PrecheckFinding[]): void {
  const reportByName = new Map(app.reports.map((report) => [report.name, report]));
  for (const report of app.reports) {
    const form = report.form ? formByName.get(report.form) : undefined;
    if (!form) continue;
    for (const column of report.columns) {
      const raw = column.properties.find((property) => property.key.toLowerCase() === 'view')?.value;
      if (raw === undefined) continue;
      const view = unquote(raw).trim();
      if (!view) continue;
      const label = column.label ?? column.field.split('.').pop()!;
      const at = loc(source, column.span.start, report.form ?? null, column.field);
      const target = reportByName.get(view);
      if (!target) {
        push(findings, {
          check: 'report-view',
          severity: 'blocker',
          location: at,
          message: `Column '${label}' links to view '${view}', but no report named ${view} exists. Dangling references are regenerated at export and fail.`,
          fix: 'Point "view =" at an existing report of the lookup target form, or drop the link.',
        });
        continue;
      }
      const field = fieldOf(form, column.field.split('.')[0]!);
      const targetForm = field?.lookup?.form ?? valuesTarget(field);
      if (!targetForm || !target.form || target.form === targetForm) continue;
      push(findings, {
        check: 'report-view',
        severity: 'blocker',
        location: at,
        message: `${CREATOR_TEXT.belongsView(label, view)} Column ${column.field} looks up ${targetForm}; ${view} is a report of ${target.form}.`,
        fix: `Point "view =" at a report of ${targetForm} (the lookup's form), or drop the link.`,
      });
    }
  }
}

/** `values = Form[...]` / `values = Form.Field` lookup target when `field.lookup` is not set. */
function valuesTarget(field: Field | undefined): string | null {
  const values = field ? propOf(field, 'values') : undefined;
  const match = values && /^([A-Za-z_]\w*)\s*(?:\.|\[)/.exec(values);
  return match ? match[1]! : null;
}

/** One comment or string literal range inside a Deluge script. */
interface Hidden {
  start: number;
  end: number;
  kind: 'comment' | 'string';
}

/** `"..."` strings and `//` / `/*` comments in one pass; whichever starts first wins. */
function hiddenSpans(text: string): Hidden[] {
  const out: Hidden[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out.push({ start, end: Math.min(i + 1, text.length), kind: 'string' });
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const start = i;
      while (i < text.length && text[i] !== '\n') i++;
      out.push({ start, end: i, kind: 'comment' });
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const start = i;
      const stop = text.indexOf('*/', i + 2);
      const end = stop < 0 ? text.length : stop + 2;
      i = end - 1;
      out.push({ start, end, kind: 'comment' });
    }
  }
  return out;
}

/**
 * insert-comment and legacy-getall: Deluge source shapes the .ds grammar accepts
 * but Creator's script regeneration rejects — `//` / `/*` comments inside the
 * `[ ... ]` of `insert into` (`Improper Statement`), and the doubled legacy
 * subform traversal `(input.X.Y).input.X.Y.getall()`. `List((input.X.Y).getall())`
 * is Creator's own serialization and is not flagged.
 */
/**
 * Lower bound of the Data Store calls an on success script makes: one per
 * `insert into` and one per `Form[criteria]` read, in the script and in every
 * function it calls (by name or thisapp.name, each function counted once).
 * A record-set update adds its own write, so the real count is higher.
 */
function successStoreCalls(app: App, scripts: ScriptSrc[], source: string, findings: PrecheckFinding[]): void {
  const formNames = new Set(app.forms.map((form) => form.name));
  const bodies = new Map<string, ScriptSrc[]>();
  for (const script of scripts) if (script.owner) bodies.set(script.owner, [...(bodies.get(script.owner) ?? []), script]);
  const own = (script: ScriptSrc) => {
    const hidden = hiddenSpans(script.text);
    const code = (at: number) => !hidden.some((span) => at >= span.start && at < span.end);
    let calls = 0;
    const callees = new Set<string>();
    for (const match of script.text.matchAll(/\binsert\s+into\b/gi)) if (code(match.index!)) calls++;
    for (const match of script.text.matchAll(/(?<![\w.])(?<!\binsert\s+into\s+)([A-Za-z_]\w*)\s*\[/gi)) if (code(match.index!) && formNames.has(match[1]!)) calls++;
    for (const match of script.text.matchAll(/(?<![\w.])(?:thisapp\.)?([A-Za-z_][\w.]*)\s*\(/g)) {
      if (!code(match.index!)) continue;
      // `thisapp.Account.Balance_Calculation(...)`: the function may be keyed with or without its namespace.
      const name = [match[1]!, match[1]!.slice(match[1]!.lastIndexOf('.') + 1)].find((key) => bodies.has(key));
      if (name) callees.add(name);
    }
    return { calls, callees };
  };
  for (const script of scripts) {
    if (script.context !== 'success' || !script.form) continue;
    let total = 0;
    const seen = new Set<string>();
    const queue = [script];
    while (queue.length) {
      const next = own(queue.shift()!);
      total += next.calls;
      for (const name of next.callees) {
        if (seen.has(name)) continue;
        seen.add(name);
        queue.push(...bodies.get(name)!);
      }
    }
    if (total <= STORE_CALLS_PER_REQUEST_TARGET) continue;
    push(findings, {
      check: 'store-calls-on-success',
      severity: 'warning',
      location: loc(source, script.base, script.form, null),
      message: `${script.form} ${script.where} makes at least ${total} Data Store calls per submit${seen.size ? ` (with ${[...seen].sort(compareEnUs).join(', ')})` : ''}, over the ${STORE_CALLS_PER_REQUEST_TARGET}-call target; every call adds latency to the submit request.`,
      fix: 'Keep running totals updated on write instead of re-reading other forms, or move the recalculation to a scheduled function.',
    });
  }
}

function scriptShapes(scripts: ScriptSrc[], source: string, findings: PrecheckFinding[]): void {
  const seen = new Set<string>();
  const note = (script: ScriptSrc, at: number, check: string, message: string, fix: string) => {
    const key = `${check}:${script.base + at}`;
    if (seen.has(key)) return;
    seen.add(key);
    push(findings, { check, severity: 'blocker', location: loc(source, script.base + at, script.form, null), message, fix });
  };
  for (const script of scripts) {
    const text = script.text;
    const hidden = hiddenSpans(text);
    const code = (at: number) => !hidden.some((span) => at >= span.start && at < span.end);
    for (const match of text.matchAll(/\binsert\s+into\b/gi)) {
      const at = match.index!;
      if (!code(at)) continue;
      let i = at + match[0].length;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      const name = /^[A-Za-z_][\w.]*/.exec(text.slice(i));
      if (!name) continue;
      i += name[0].length;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text[i] !== '[') continue;
      // The entries list may itself nest `[criteria]`; match the bracket.
      let depth = 0;
      let end = text.length;
      for (let j = i; j < text.length; j++) {
        const span = hidden.find((item) => j >= item.start && j < item.end);
        if (span) {
          j = span.end - 1;
          continue;
        }
        if (text[j] === '[') depth++;
        else if (text[j] === ']') {
          depth--;
          if (!depth) {
            end = j;
            break;
          }
        }
      }
      const comment = hidden.find((span) => span.kind === 'comment' && span.start > i && span.start < end);
      if (!comment) continue;
      note(
        script,
        at,
        'insert-comment',
        `A comment inside "insert into" brackets makes Creator's regeneration fail: save reports "${CREATOR_TEXT.improperStatement}" and import reports "${CREATOR_TEXT.importProblem}".`,
        'Move the comment above the insert into statement (or delete it).',
      );
    }
    const doubled = /\(\s*([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\)\s*\.\s*([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\.\s*getall\b/gi;
    for (const match of text.matchAll(doubled)) {
      const at = match.index!;
      if (!code(at)) continue;
      const clean = (text_: string) => text_.replace(/\s+/g, '').toLowerCase();
      if (clean(match[1]!) !== clean(match[2]!)) continue;
      note(
        script,
        at,
        'legacy-getall',
        `Doubled legacy traversal "(${match[1]}).${match[2]}.getall()": the script editor rejects it with "${CREATOR_TEXT.improperStatement}" and import reports "${CREATOR_TEXT.importProblem}".`,
        `Rewrite as ${match[1]!.replace(/\s+/g, '')}.getall() — or a "for each row" loop over the subform.`,
      );
    }
  }
}

/** Codepoints outside the BMP (emoji, 4-byte UTF-8) fail Creator's XML serialisation. */
const NON_BMP = /[\u{10000}-\u{10FFFF}]/u;

/**
 * Non-BMP characters in titles, labels and page content break Creator's XML
 * serialisation — export, backup and Duplicate fail with a SAXParseException
 * (HTTP 500). Scans every title/label-shaped Property value and the decoded
 * displayName/label/title/content fields of the IR.
 */
function nonBmpText(app: App, source: string, findings: PrecheckFinding[]): void {
  const seen = new Set<string>();
  const note = (value: string | undefined, offset: number | undefined, what: string) => {
    if (value === undefined || offset === undefined) return;
    const text = unquote(value);
    // IR exposes the same title twice — decoded `displayName` field plus the
    // `displayname` Property — so dedupe on key+value, not on offset.
    const key = `${what.toLowerCase()}|${text}`;
    if (seen.has(key) || !NON_BMP.test(text)) return;
    seen.add(key);
    push(findings, {
      check: 'non-bmp',
      severity: 'blocker',
      location: loc(source, offset, null, null),
      message: `${what} contains non-BMP characters (emoji / 4-byte UTF-8). Creator serialises these strings through XML: export, backup and Duplicate fail with a SAXParseException / HTTP 500.`,
      fix: 'Remove or transliterate the non-BMP characters before migrating.',
    });
  };
  const STRING_FIELDS = /^(displayName|label|title|content)$/;
  const TEXTY_KEYS = /^(displayname|display name|title|label|column header|success message|confirmation message|description|content|heading|caption)$/i;
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const span = obj.span as { start?: unknown } | undefined;
    const offset = typeof span?.start === 'number' ? span.start : undefined;
    if (typeof obj.key === 'string' && typeof obj.value === 'string') {
      if (TEXTY_KEYS.test(obj.key)) note(obj.value, offset, `${obj.key}`);
      return;
    }
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && STRING_FIELDS.test(key)) note(value, offset, key);
      else visit(value);
    }
  };
  visit(app);
}

/**
 * Pivottable/pivotchart reports are served by Zoho Analytics; the
 * coupling can block export, backup, Duplicate, field rename/delete, report
 * rendering and owner transfer. Advisory only — the .ds does not expose the
 * Analytics-side state.
 */
function pivotReports(app: App, source: string, findings: PrecheckFinding[]): void {
  for (const report of app.reports) {
    if (!/^pivot(table|chart)$/i.test(report.type)) continue;
    push(findings, {
      check: 'pivot-analytics',
      severity: 'warning',
      location: loc(source, report.span.start, report.form ?? null, null),
      message: `Pivot report "${report.name}" is rendered through Zoho Analytics. The Analytics coupling can block export, backup, Duplicate, field rename/delete and owner transfer (LC-03); the .ds does not expose the Analytics-side state.`,
      fix: 'Before migrating, check the report renders and exportScript succeeds in Creator; if Analytics sync is broken, recreate the report.',
    });
  }
}
