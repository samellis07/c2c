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
 * - report / page: a 'generated' UI model entry (packages/ui/src/model.ts
 *   buildReport/buildPage). Listed: a UI todo naming the report, or the page,
 *   or one of its ZML elements. buildReport/buildPage always push a todo when
 *   the status is 'todo'.
 * - workflow / schedule / approval / payment: the generate() branch for the
 *   workflow (packages/deluge/src/generate.ts workflowKind) emitted its file:
 *   a handler module, a job module with a planned cron or sweep
 *   (packages/deluge/src/schedules.ts planSchedules), a flow machine module
 *   (flowSpecs), or a not-supported payment stub. A workflow with no script
 *   and no field rules declares no behaviour, so there is nothing to migrate.
 *   Listed: a Deluge todo whose span sits inside the workflow span (translate
 *   todos are shifted into the script span; gap todos use the workflow span).
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
 *   listed as an explicit manual step (migration-report.json warnings,
 *   construct 'translation-not-migrated').
 *
 * A construct labelled 'manual' that the generator actually produces is a
 * false listing, not coverage: the produced check runs first and wins.
 */

import type { App, Workflow } from '../../core/src/ir.js';
import { formLink } from '../../core/src/ir.js';
import { authPlan, type AuthPlan } from '../../auth/src/plan.js';
import { analyzeConnections, memberChain, permissionScopes, walk, type ConnectionsReport } from '../../deluge/src/connections.js';
import type { Expr } from '../../deluge/src/ast.js';
import { dispatchGet, ZOHO_ENV, ZOHO_PAYMENT } from '../../deluge/src/dispatch.js';
import { flowSpecs, generate, slug, workflowKind, type FlowSpec, type GeneratedFile, type GenerateWarning } from '../../deluge/src/generate.js';
import { parse } from '../../deluge/src/parser.js';
import { planSchedules, type SchedulePlan } from '../../deluge/src/schedules.js';
import { reportCriteria, type TodoItem } from '../../deluge/src/translate.js';
import { criteriaHasTodo } from '../../shims/src/criteria.js';
import { adapterFor } from '../../shims/src/zoho-adapters.js';
import { generateSchema, type SchemaPlan } from '../../schema/src/generator.js';
import { buildModel, type UiModel } from '../../ui/src/model.js';

export type DropKind =
  | 'form'
  | 'field'
  | 'report'
  | 'page'
  | 'workflow'
  | 'schedule'
  | 'approval'
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
}

/** Run every generator over the app and bundle the outputs the audit reads. */
export function collectOutputs(app: App): AuditOutputs {
  const schema = generateSchema(app);
  const gen = generate(app);
  const model = buildModel(app, gen.files);
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
  return { schema, model, files: gen.files, todos: gen.todos, warnings, auth, connections, schedules, specs: flowSpecs(app) };
}

function within(inner: { start: number; end: number }, outer: { start: number; end: number }): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

/** Deluge todos that sit inside the workflow: its listed manual items. */
function listedTodos(todos: readonly TodoItem[], w: Workflow): TodoItem[] {
  return todos.filter((t) => within(t, w.span));
}

function auditForm(app: App, out: AuditOutputs, drops: SilentDrop[]): void {
  for (const form of app.forms) {
    const produced = out.schema.tables.some((t) => t.form === form.name && t.role !== 'system');
    if (produced) continue;
    const listed = out.schema.issues.some((i) => i.severity === 'unsupported' && i.form === form.name && i.field === undefined);
    if (!listed) {
      drops.push({
        kind: 'form',
        name: form.name,
        note: `Form ${form.name} has no generated table and no fidelity note. Add one: either migrate the form or record why it cannot be migrated.`,
      });
    }
  }
}

function auditField(app: App, out: AuditOutputs, drops: SilentDrop[]): void {
  for (const form of app.forms) {
    const uiFields = out.model.forms.find((f) => f.name === form.name)?.fields ?? [];
    for (const field of form.fields) {
      const outcome = out.schema.fields.find((o) => o.form === form.name && o.field === field.name);
      const uiGenerated = uiFields.some((u) => u.name === field.name && u.status === 'generated');
      if ((outcome && outcome.status !== 'unsupported') || uiGenerated) continue;
      const listed =
        (outcome && outcome.status === 'unsupported') ||
        out.schema.issues.some((i) => i.severity === 'unsupported' && i.form === form.name && i.field === field.name) ||
        out.model.todos.some((t) => t.area === 'field' && t.name === `${form.name}.${field.name}`);
      if (!listed) {
        drops.push({
          kind: 'field',
          name: `${form.name}.${field.name}`,
          note: `Field ${form.name}.${field.name} has no generated column and no fidelity note. Add one: either migrate the field or record what the user must re-enter.`,
        });
      }
    }
  }
}

function auditReport(app: App, out: AuditOutputs, drops: SilentDrop[]): void {
  for (const report of app.reports) {
    const built = out.model.reports.find((r) => r.name === report.name);
    if (built && built.status === 'generated') continue;
    const listed = out.model.todos.some((t) => t.area === 'report' && t.name === report.name);
    if (!listed) {
      drops.push({
        kind: 'report',
        name: report.name,
        note: `Report ${report.name} is not generated and has no fidelity note. Add one: either migrate the report or record what the user must rebuild.`,
      });
    }
  }
}

function auditPage(app: App, out: AuditOutputs, drops: SilentDrop[]): void {
  for (const page of app.pages) {
    const built = out.model.pages.find((p) => p.name === page.name);
    if (built && built.status === 'generated') continue;
    const listed = out.model.todos.some((t) => (t.area === 'page' && t.name === page.name) || (t.area === 'zml' && t.name.startsWith(`${page.name}.`)));
    if (!listed) {
      drops.push({
        kind: 'page',
        name: page.name,
        note: `Page ${page.name} is not generated and has no fidelity note. Add one: either migrate the page or record what the user must rebuild.`,
      });
    }
  }
}

function handlerBase(w: Workflow): string {
  return `${slug(w.form || 'form')}/${slug(w.event || w.name || 'handler')}`;
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

function auditWorkflow(app: App, out: AuditOutputs, drops: SilentDrop[]): void {
  const paths = new Set(out.files.map((f) => f.path));
  for (const w of app.workflows) {
    const kind = workflowKind(w);
    const label = w.name || w.form || 'workflow';
    const listed = listedTodos(out.todos, w).length > 0;
    if (kind === 'form') {
      if (vacuous(w)) continue;
      const base = handlerBase(w);
      const produced = [...paths].some((p) => p === `functions/aio/${base}.mjs` || p.startsWith(`functions/aio/${base}-`) || p.startsWith(`functions/aio/${base}.`) || p === `client/handlers/${base}.mjs` || p.startsWith(`client/handlers/${base}-`));
      if (!produced && !listed) {
        drops.push({
          kind: 'workflow',
          name: `${w.form ?? ''} ${w.event || label}`.trim(),
          note: `Workflow ${label} (${w.event}) emitted no handler and carries no todo. Add one: either migrate the script or record the manual step.`,
        });
      }
      continue;
    }
    if (kind === 'payment') {
      const produced = paths.has(`not-supported/payments-${slug(w.name || w.form || 'workflow')}.mjs`);
      if (!produced && !listed) {
        drops.push({
          kind: 'workflow',
          name: label,
          note: `Payments workflow ${label} has no stub and no fidelity note. Add one: the stub names the workflow and states that no gateway is called.`,
        });
      }
      continue;
    }
    if (kind === 'schedule') {
      const plan = out.schedules.get(w);
      const produced = !!plan && ((plan.kind === 'custom' && !!plan.cron) || (plan.kind === 'form' && !!plan.sweep));
      if (!produced && !listed) {
        drops.push({
          kind: 'schedule',
          name: label,
          note: `Schedule ${label} produced no cron or sweep and carries no gap todo. Add one: either plan the schedule or record the gap and the manual cron.`,
        });
      }
      continue;
    }
    // Approval or blueprint: one machine module per approval group / blueprint.
    // The lookup mirrors generate(): the group key addresses the spec map, and
    // an unnamed workflow falls back to its blank spec name.
    const key = kind === 'approval' ? w.name || `approval:${w.form ?? ''}` : w.name;
    const spec =
      out.specs.find((s) => s.kind === kind && s.name === key) ?? (key !== w.name ? out.specs.find((s) => s.kind === kind && s.name === w.name) : undefined);
    const produced = !!spec && paths.has(`functions/flow/${spec.slug}.mjs`);
    if (!produced && !listed) {
      drops.push({
        kind: 'approval',
        name: label,
        note: `${kind === 'approval' ? 'Approval' : 'Blueprint'} ${label} emitted no machine module and carries no todo. Add one: either migrate the machine or record the manual step.`,
      });
    }
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

function auditIntegration(app: App, out: AuditOutputs, drops: SilentDrop[]): void {
  for (const { text, where } of scriptsOf(app)) {
    for (const call of callsIn(text, where)) {
      if (call.invokeurl) {
        const covered =
          out.connections.entries.some((e) => e.uses.some((u) => u.where === where && isInvokeurlTask(u.task))) ||
          out.connections.unsupported.some((u) => isInvokeurlTask(u)) ||
          out.connections.diagnostics.some((d) => d.includes(where) && /invokeurl/i.test(d));
        if (!covered) {
          drops.push({
            kind: 'integration',
            name: `invokeurl in ${where}`,
            note: `An invokeurl call in ${where} is analysed nowhere: no checklist row, no unsupported entry, no diagnostic. Record the service, the scope, and the manual connection step.`,
          });
        }
        continue;
      }
      const root = call.task.split('.')[0]!;
      if (locallyHandled(root, call.task)) continue;
      const covered =
        out.connections.entries.some((e) => e.uses.some((u) => u.where === where && u.task.toLowerCase() === call.task)) ||
        out.connections.unsupported.some((u) => u.toLowerCase() === `zoho-task:${call.task}`) ||
        out.connections.diagnostics.some((d) => d.includes(where) && d.toLowerCase().includes(call.task));
      if (!covered) {
        drops.push({
          kind: 'integration',
          name: `zoho.${call.task} in ${where}`,
          note: `zoho.${call.task} in ${where} is translated to a runtime task call but the connections analysis never surfaces it: no checklist row, no unsupported entry, no diagnostic. List it in the connections report with the manual connection step.`,
        });
      }
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

function auditPermission(app: App, out: AuditOutputs, drops: SilentDrop[]): void {
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
    if (profiles.has(p.owner ?? '') || roles.has(p.owner ?? '')) continue;
    // A `permissions` literal on a `connections` block is the connection's
    // granted scope list; covered only when the report's diagnostic for that
    // connection lists every scope the literal grants. A literal holding a
    // value that is not scope-name shaped is never fully listed.
    const { scopes, unverified } = permissionScopes(p.value);
    if (!unverified && connectionScopesListed(out.connections.diagnostics, p.owner ?? '', scopes)) continue;
    drops.push({
      kind: 'permission',
      name: `permissions of ${p.owner ?? '(no owner)'}`,
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

/** Every construct the `.ds` declares that is neither produced nor listed. */
export function auditApp(app: App, outputs?: AuditOutputs): SilentDrop[] {
  const out = outputs ?? collectOutputs(app);
  const drops: SilentDrop[] = [];
  auditForm(app, out, drops);
  auditField(app, out, drops);
  auditReport(app, out, drops);
  auditPage(app, out, drops);
  auditWorkflow(app, out, drops);
  auditIntegration(app, out, drops);
  auditPermission(app, out, drops);
  auditTranslationDeclarations(app, out, drops);
  return drops;
}

/** Translation blocks are never produced; each one needs an explicit manual step. */
function auditTranslationDeclarations(app: App, out: AuditOutputs, drops: SilentDrop[]): void {
  for (const t of app.translations) {
    const lang = translationLanguage(t);
    const listed = out.warnings.some(
      (w) => w.construct === 'translation-not-migrated' && (lang === undefined || w.name.includes(lang)),
    );
    if (!listed) {
      drops.push({
        kind: 'translation',
        name: lang ? `translation ${lang}` : 'translation block',
        note: `${lang ? `The ${lang} translation block` : 'A translation block'} is not migrated and has no manual step. List the language, the string count, and what the user must copy into the generated client.`,
      });
    }
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
