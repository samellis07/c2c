/**
 * Function generators (dry run).
 *
 * - form validate / success / load / submit → Advanced I/O handlers
 * - on user input, show/hide, alert, openUrl, cancel submit → client handler module
 * - schedules → Catalyst Job function modules plus job-scheduling.json (schedules.ts): a custom
 *   schedule is one pre-defined cron, form schedules share one sweeper Job (pool names cannot contain "_").
 *   A schedule runs as the application, not as a signed-in user, and is not an HTTP route.
 * - approvals / blueprints → status column + approve / reject / transition endpoints.
 *   Gate order is hidden form, then auth, then approver and status. The record is re-read.
 *   (Circuits is not available in IN; no US data centre)
 * - payments → not-supported stub, no gateway calls
 *
 * Nothing here deploys or contacts Catalyst.
 */

import { flowStatusColumn, formLink, isApprovalWorkflow, isBlueprintWorkflow, isPaymentWorkflow, isScheduleBranchWorkflow, isScheduleWorkflow, isUsersField, staticDefault, unquote, type App, type Field, type Form, type FunctionDef, type ModulePermission, type Profile, type Property, type PropertyBlock, type RawDeluge, type Report, type Translation, type Workflow } from '../../core/src/ir.js';
import { compareEnUs } from '../../core/src/order.js';
import { toolchainBannerLines } from '../../core/src/toolchain.js';
import { fieldTypeRow } from '../../schema/src/mapping.js';
import type { AccessPolicy, FieldRuleDenial, FormGrant, WriteField, WriteOp, WriteScalar } from '../../shims/src/access.js';
import { criteriaHasRelative, criteriaHasTodo, type Criteria, type DecimalColumn, type DecimalColumns } from '../../shims/src/criteria.js';
import { integrityColumns, type IntegrityColumn } from '../../data/src/integrity.js';
import { flowHistoryTable, generateSchema, type SchemaPlan } from '../../schema/src/generator.js';
import { EXTENSION_KEY, plainRecordStages } from '../../schema/src/limits.js';
import { LIMITS, jobPoolName } from '../../shims/src/index.js';
import { blueprintFieldSpec, isConsumedPhaseProperty, isOwnerBlockName, isOwnerKey, isStageFieldProperty, phaseFieldKind, transitionOwnerProperties, type BlueprintFieldSpec } from './blueprint-rules.js';
import { analyzeConnections, connectionsChecklist, declaredConnections } from './connections.js';
import { fieldStoreImports, fieldStoreShape, fieldStoreWriteArg, writeLiveSource } from './field-store.js';
import { applyFillLock, reportLock, type FillLock, type StaleFill } from './fill-todos.js';
import { afterCommitModule, ASYNC_ON_SUCCESS_WARNING, assertAsyncSuccessDeferrable, deadLetterModule, EVENT_FUNCTION_MODULE, eventSweeperModule, successSpecs, type AsyncCandidate } from './events.js';
import { EVENT_SWEEPER_MODULE, JOB_LIVE_IMPORTS, jobLiveHelpers, planSchedules, schedulingConfig, sweeperModule, SWEEPER_MODULE, type SchedulePlan } from './schedules.js';
import { emittedReadOnly, emittedThisappCalls, jsIdent, reportCriteria, translate, type AlertEventClass, type CriteriaFunction, type TodoItem, type TranslateOptions, type TranslateStats } from './translate.js';
import { normType } from './types.js';
import { mutatesParameters } from './param-mutation.js';
import { withoutDecimalAudit } from './audit.js';
import { resolveAppCalls } from './resolve-app-calls.js';

export interface GeneratedFile {
  path: string;
  source: string;
}

export interface GenerateResult {
  files: GeneratedFile[];
  stats: TranslateStats;
  todos: TodoItem[];
  /** construct → count, untranslated only */
  constructs: Map<string, number>;
}

/**
 * A generated construct that fell back to a safe default because the .ds did
 * not declare enough to reproduce the Creator permission — or an explicit
 * manual step for a declared construct the generator does not migrate (a
 * translation block). Reported in migration-report.json (`warnings`); the
 * generated behaviour, or what the user must do instead, is stated in `note`.
 */
export interface GenerateWarning {
  construct: string;
  /** The construct the warning is about (a function name). */
  name: string;
  note: string;
}

/** A source `alert` whose placement Creator may not execute. */
export interface AlertDiagnostic {
  form: string | null;
  event: string | null;
  name: string | null;
  /**
   * `disallowed` — proven rejected (form-workflow on success).
   * `unverified` — placement Creator has not been observed to run (schedules,
   *   approvals, blueprint phases, record events, functions).
   */
  verdict: 'disallowed' | 'unverified';
  /**
   * `follows-comment-line` — the alert sits directly under a `//` comment-only
   * line, which is also where a wrapped comment tail lands. Adjacency alone
   * never changes the verdict; review whether the line is really a tail.
   */
  note?: string;
  start: number;
  end: number;
}

/** Lock replay is opt-in. Omitting `lock` leaves every byte unchanged. */
export interface GenerateOptions {
  /** Accepted fills. A stale or tampered entry is reported and not applied. */
  lock?: FillLock;
  /** Receives stale and integrity failures from this run. */
  stale?: StaleFill[];
  /**
   * The schema plan the deploy provisions, when the caller measured source
   * data. app-layer unique and write rules then match the provisioned
   * Data Store constraints; without it the plan is derived from Creator alone.
   */
  schema?: SchemaPlan;
  /**
   * The generated UI stubs, supplied by the caller that builds the UI (the UI
   * package depends on this one, so its stub list arrives through the
   * options). Each stub is one residual hole in migration-report.json.
   */
  uiTodos?: readonly UiStubTodo[];
  /**
   * Opt-in async on-success lane: emit the after-commit event-function module,
   * the dead-letter store and its sweep Job, and defer the live post-write
   * script run to the record trigger (docs/event-deadletter.md). Default off —
   * without it no `functions/events/` file exists and the output is
   * byte-identical.
   */
  asyncOnSuccess?: boolean;
}

/** One generated UI stub, as the UI builder reports it. */
export interface UiStubTodo {
  area: string;
  name: string;
  reason: string;
}

/**
 * The one residual-TODO accounting shared by analyze, the migration reports
 * and the deterministic flag: every Deluge hole plus every generated UI stub.
 * An app is deterministic only when the total is zero and no lock fill
 * applies to it.
 */
export interface ResidualDeterminism {
  deterministic: boolean;
  todoCount: number;
  uiTodoCount: number;
  fillLockEntries: number;
}

export function residualDeterminism(delugeTodoCount: number, uiTodoCount: number, fillLockEntries: number): ResidualDeterminism {
  const todoCount = delugeTodoCount + uiTodoCount;
  return { deterministic: todoCount === 0 && fillLockEntries === 0, todoCount, uiTodoCount, fillLockEntries };
}

/** One row per construct at one source span. A second copy of the same span is the same hole. */
export function dedupeTodos(todos: readonly TodoItem[]): TodoItem[] {
  const seen = new Set<string>();
  const out: TodoItem[] = [];
  for (const todo of todos) {
    const key = `${todo.construct}\0${todo.start}\0${todo.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(todo);
  }
  return out;
}

const EMPTY_STATS = (): TranslateStats => ({ statements: 0, translated: 0, shimmed: 0, todo: 0 });

function addStats(a: TranslateStats, b: TranslateStats): void {
  a.statements += b.statements;
  a.translated += b.translated;
  a.shimmed += b.shimmed;
  a.todo += b.todo;
}

export function generate(app: App, options?: GenerateOptions): GenerateResult {
  const files: GeneratedFile[] = [];
  const used = new Set<string>();
  const stats = EMPTY_STATS();
  const todos: TodoItem[] = [];
  const alertDiagnostics: AlertDiagnostic[] = [];
  const put = (path: string, source: string) => {
    let p = path;
    let n = 2;
    while (used.has(p)) {
      const dot = path.lastIndexOf('.');
      p = `${path.slice(0, dot)}-${n}${path.slice(dot)}`;
      n++;
    }
    used.add(p);
    files.push({ path: p, source });
    return p;
  };

  put('runtime/limits.mjs', limitsModule());

  const specOf = workflowFlowSpecs(app);
  // Every level and action of one approval is a separate IR workflow with the
  // same name. They emit one machine module per machine, not one per event.
  const approvalGroups = new Map<string, Workflow[]>();
  for (const w of app.workflows) {
    if (!isApproval(w)) continue;
    const key = w.name || `approval:${w.form ?? ''}`;
    const group = approvalGroups.get(key) ?? [];
    group.push(w);
    approvalGroups.set(key, group);
  }
  const schedulePlans = schedulePlansFor(app);
  // Every workflow whose script serves /forms/<form>/<kind> is grouped: one
  // module carries all of a form event's scripts (deploy keeps one module per
  // route, so sibling modules would silently never run).
  const handlerGroups = new Map<string, Workflow[]>();
  for (const w of app.workflows) {
    if (!isHandlerWorkflow(w)) continue;
    const key = `${w.form || 'form'}${eventKind(w.event)}`;
    const group = handlerGroups.get(key) ?? [];
    group.push(w);
    handlerGroups.set(key, group);
  }
  const emitHandlers = (w: Workflow): void => {
    const group = handlerGroups.get(`${w.form || 'form'}${eventKind(w.event)}`);
    if (group && group[0] === w) emitFormHandler(app, group, put, stats, todos, alertDiagnostics, warnings, clientCalls.names, calledFunctions, options?.schema, !!options?.asyncOnSuccess, recordHandler);
  };
  const thisappEntries: ThisappEntry[] = [];
  const warnings: GenerateWarning[] = [];
  const clientCalls = clientCallFunctions(app);
  const calledFunctions = new Set<string>();
  const emittedHandlers: { path: string; kind: string; candidate: AsyncCandidate }[] = [];
  const recordHandler = (entry: { path: string; kind: string; candidate: AsyncCandidate }): void => {
    emittedHandlers.push(entry);
  };
  for (const w of app.workflows) {
    if (workflowKind(w) === 'payment') {
      put(`not-supported/payments-${slug(w.name || w.form || 'workflow')}.mjs`, paymentStub(w));
      continue;
    }
    if (workflowKind(w) === 'blueprint') {
      emitBlueprint(app, w, specOf.get(w), put, stats, todos, alertDiagnostics, options?.schema);
      emitHandlers(w);
    } else if (workflowKind(w) === 'approval') {
      const key = w.name || `approval:${w.form ?? ''}`;
      const group = approvalGroups.get(key)!;
      if (group[0] === w) emitApproval(app, group, specOf.get(w)!, put, stats, todos, alertDiagnostics, options?.schema);
    } else if (workflowKind(w) === 'schedule') emitSchedule(app, w, schedulePlans.get(w)!, put, stats, todos, alertDiagnostics, options?.schema);
    else emitHandlers(w);
  }
  // Every Advanced I/O form handler imports the shared request helpers from
  // one app-local module. Emit it only when this app has at least one AIO file.
  if (files.some((file) => file.path.startsWith('functions/aio/'))) {
    put('functions/aio/_lib.mjs', aioLibraryModule());
  }
  // Response-sensitive on-success work never defers: it stays synchronous by
  // refusing the flag with a named error, before the lane is emitted.
  if (options?.asyncOnSuccess) {
    assertAsyncSuccessDeferrable(
      emittedHandlers.filter((entry) => entry.kind === 'success').map((entry) => entry.candidate),
    );
  }
  // The async on-success lane exists only when an add/edit on-success module
  // does; the event function re-runs exactly those sibling modules. Deletes
  // stay synchronous in the delete endpoint, so delete-only specs never open
  // the lane.
  const asyncSuccess = !!options?.asyncOnSuccess && successSpecs(files).some((spec) => spec.add.length + spec.edit.length > 0);
  emitScheduling(app, schedulePlans, put, options?.schema, asyncSuccess);
  const publishers = apiPublishers(app);
  const admins = administratorProfiles(app);
  for (const fn of app.functions) emitFunction(app, fn, put, stats, todos, alertDiagnostics, thisappEntries, publishers.get(fn.name), admins, warnings, options?.schema);
  const callAccess = app.profiles.length ? accessPolicyFor(app) : undefined;
  for (const fn of app.functions) {
    const key = fn.name.toLowerCase();
    const body = clientCalls.bodies.get(key);
    if (!calledFunctions.has(key) || body === undefined) continue;
    const name = slug(fn.name || 'function');
    const readForms = [...clientCalls.reads.get(key)!];
    // A caller-scoped read sees only the rows the caller's profile grant
    // allows. When a grant is owner- or criteria-scoped the callee's counts
    // and lookups cover fewer rows than Creator's, so a condition can decide
    // on a partial result (an availability check that misses another user's
    // booking). The report names it; the endpoint stays caller-scoped.
    const grants = callAccess?.profiles ?? {};
    const partial = [...new Set(readForms)]
      .sort(compareEnUs)
      .filter((form) =>
        Object.keys(grants)
          .sort(compareEnUs)
          .some((profile) => {
            const grant = grants[profile][form];
            return !!grant && grant.read !== false && (grant.ownerScope === 'view' || !!grant.recordFilter);
          }),
      );
    if (partial.length) {
      warnings.push({
        construct: 'client-call-caller-scoped-read',
        name: fn.name,
        note: `The ${name}-call endpoint reads ${partial.join(', ')} as the caller. A profile whose grant on those forms is owner- or criteria-scoped gets counts and lookups over only the rows it can see, so the function's result can differ from Creator (an availability check can report free on a booking the caller cannot see). Re-check the same rule server-side at submit.`,
      });
    }
    put(
      `functions/custom/${name}-call.mjs`,
      functionCallModule({ app, name: fn.name, signature: fn.signature, params: fnParams(fn.signature), reads: readForms, schema: options?.schema }),
    );
  }
  if (asyncSuccess) {
    put('functions/c2c-deadletter.mjs', deadLetterModule());
    put(
      `functions/${EVENT_FUNCTION_MODULE}`,
      afterCommitModule({ app, banner, specs: successSpecs(files), schema: options?.schema ?? schemaOf(app), runtimeOptions: schemaRuntimeOptions(app, options?.schema) }),
    );
    put(`functions/job/${EVENT_SWEEPER_MODULE}.mjs`, eventSweeperModule({ app, banner }));
    warnings.push({ ...ASYNC_ON_SUCCESS_WARNING });
  }
  // Translation blocks are not migrated: each one is an explicit manual step.
  for (const t of app.translations) warnings.push(translationWarning(t));

  // functions/thisapp.mjs is emitted whenever a module can call `thisapp.<fn>`
  // (its own body uses the shim) or the app declared functions at all, so an
  // importing module never resolves a missing file.
  const thisappUsed = files.some((f) => f.path.endsWith('.mjs') && usesThisapp(f.source));
  if (thisappEntries.length || thisappUsed) {
    put('functions/thisapp.mjs', thisappModule(thisappEntries));
  }
  // A report criteria or named filter that does not translate is a residual
  // hole: the generated report fails closed, so the app is not deterministic.
  for (const item of unmigratedReportCriteria(app)) {
    todos.push({ construct: 'report-criteria', start: item.start, end: item.end });
  }
  for (const report of app.reports) {
    for (const format of report.conditionalFormats) {
      if (format.condition?.trim() && criteriaHasTodo(reportCriteria(format.condition, app.functions))) {
        todos.push({ construct: 'report-conditional-format', start: format.span.start, end: format.span.end });
      }
    }
  }

  const constructs = new Map<string, number>();
  for (const t of todos) constructs.set(t.construct, (constructs.get(t.construct) ?? 0) + 1);
  const connections = analyzeConnections(app);
  // Only apps that call another Zoho service get the section, so other reports stay byte-identical.
  if (connections.entries.length || connections.unsupported.length) {
    put('CONNECTIONS.md', connectionsChecklist(app.name || 'app', connections));
  }
  // Deterministic only with zero residual TODOs and no fill-todos lock entry
  // applied: a lock fill is host-authored, so it disqualifies the app. The
  // residual is every distinct Deluge hole plus each generated UI stub the
  // caller supplies, the same accounting analyze and the migration report use.
  const fillLockEntries = options?.lock ? reportLock(app, options.lock).matched.length : 0;
  const determinism = residualDeterminism(dedupeTodos(todos).length, options?.uiTodos?.length ?? 0, fillLockEntries);
  put(
    'migration-report.json',
    JSON.stringify(
      {
        dryRun: true,
        deterministic: determinism.deterministic,
        todoCount: determinism.todoCount,
        uiTodoCount: determinism.uiTodoCount,
        fillLockEntries,
        statements: stats,
        untranslated: [...constructs.entries()]
          .sort((a, b) => b[1] - a[1] || compareEnUs(a[0], b[0]))
          .map(([construct, count]) => ({ construct, count })),
        alertDiagnostics,
        ...(app.profiles.length ? { security: securityFidelity(app) } : {}),
        ...(warnings.length ? { warnings } : {}),
        ...(connections.entries.length || connections.unsupported.length ? { connections } : {}),
      },
      null,
      2,
    ) + '\n',
  );
  // translate.ts stays untouched. Fills are spliced
  // only when the caller passes a lock, after the tree is otherwise finished.
  if (options?.lock) {
    const stale = applyFillLock(app, files, options.lock);
    if (options.stale) {
      for (const item of stale) options.stale.push(item);
    }
  }
  return { files, stats, todos, constructs };
}

/**
 * Classify the innermost event header an `alert` sits under. Live-tested on
 * Creator: `alert` runs in on load, on validate, on change / on user input,
 * and on click (custom action / button) actions; a form-workflow on success
 * rejects it at import. The Creator alert reference also lists Subform on add
 * row and on delete row as supported; other events are 'unverified', not
 * proven disallowed. The event string is a ` / `-joined header path (`on add
 * / on success`), so the leaf segment is the innermost header.
 * https://www.zoho.com/deluge/help/client-functions/alert.html
 * https://www.zoho.com/deluge/help/misc-tasks/alert-task.html
 */
export function alertEventClass(event: string): AlertEventClass {
  const leaf = event.split(' / ').pop()?.trim().toLowerCase() ?? '';
  if (/^on (load|validate|user input|change|click)\b/.test(leaf) || /^on (add|delete) row of\s+[a-z_]\w*$/i.test(leaf)) return 'allowed';
  // Only the form-workflow `on success` is live-tested as rejected; even
  // `on delete success` is unverified, not proven disallowed.
  if (/^on success\b/.test(leaf)) return 'disallowed';
  return 'unverified';
}

const ALERT_VERDICTS: Record<string, AlertDiagnostic['verdict']> = {
  'alert-outside-allowed-event': 'disallowed',
  'alert-in-unverified-event': 'unverified',
};

function recordAlertDiags(
  items: TodoItem[],
  raw: RawDeluge | null,
  context: { form?: string; event?: string; name?: string },
  sink: AlertDiagnostic[],
): void {
  for (const t of shift(items, raw)) {
    const verdict = ALERT_VERDICTS[t.construct];
    if (verdict) {
      sink.push({
        form: context.form ?? null,
        event: context.event ?? null,
        name: context.name ?? null,
        verdict,
        note: t.note,
        start: t.start,
        end: t.end,
      });
    }
  }
}

/**
 * The record-event scope a form-handler script runs under: `on add`, `on
 * edit`, `on delete`, or both writes. A merged module guards each script by
 * its scope only when the group mixes scopes.
 */
function recordScope(w: Workflow): 'add' | 'edit' | 'del' | 'both' {
  const rec = (w.recordEvent ?? '').trim().toLowerCase();
  if (rec === 'on add' || rec === 'create') return 'add';
  if (rec === 'on edit' || rec === 'update') return 'edit';
  if (rec === 'on delete') return 'del';
  return 'both';
}

/** A workflow whose script lands in a form-handler module (one per form event kind). */
function isHandlerWorkflow(w: Workflow): boolean {
  const kind = workflowKind(w);
  return kind === 'form' || (kind === 'blueprint' && !!(w.deluge || w.fieldRules?.length));
}

/**
 * The module leaf for a form event group: the shared event slug, or the kind
 * when the merged events differ. The group's `put` path is
 * `functions/aio/<form>/<leaf>.mjs`.
 */
function handlerLeaf(group: readonly Workflow[]): string {
  const labels = new Set(group.map((w) => w.event || w.name || 'handler'));
  return labels.size === 1 ? slug([...labels][0]!) : `${eventKind(group[0]!.event)}-handlers`;
}

/** Workflows of one app that share the /forms/<form>/<kind> route, in export order. */
function handlerGroup(app: App, form: string, kind: string): Workflow[] {
  return app.workflows.filter((w) => isHandlerWorkflow(w) && (w.form || 'form') === form && eventKind(w.event) === kind);
}

function emitFormHandler(
  app: App,
  group: readonly Workflow[],
  put: (path: string, source: string) => void,
  stats: TranslateStats,
  todos: TodoItem[],
  alertDiagnostics: AlertDiagnostic[],
  warnings: GenerateWarning[],
  clientCallFunctions: ReadonlySet<string>,
  calledFunctions: Set<string>,
  schema?: SchemaPlan,
  asyncOnSuccess = false,
  recordHandler?: (entry: { path: string; kind: string; candidate: AsyncCandidate }) => void,
): void {
  const first = group[0]!;
  const form = first.form || 'form';
  const kind = eventKind(first.event);
  const base = `${slug(form)}/${handlerLeaf(group)}`;
  // The route is one per form event kind, so every script of the group lands
  // in this module in export order. Each script keeps its own prefetch slot
  // namespace (slotStart chains) — the bodies cannot be concatenated raw.
  const scopes = new Set(group.map(recordScope));
  const mixedScopes = scopes.size > 1;
  const hasDelScope = scopes.has('del');
  const subformFields = new Set(group.map((w) => subformEventField(w.event)).filter((f): f is string => !!f));
  const multiSubform = subformFields.size > 1;
  let slot = 0;
  const serverParts: string[] = [];
  const prefetchParts: string[] = [];
  const clientParts: { w: Workflow; body: string; prefetchPath: string }[] = [];
  let prefetchElement = false;
  let hasPrefetch = false;
  const writeKinds = new Set<'insert' | 'update' | 'add-or-edit'>();
  for (const w of group) {
    const subform = subformEventField(w.event);
    const todosBefore = todos.length;
    const translated = w.deluge ? translateInApp(app, w.deluge.text, { ...workflowScriptOptions(app, w), clientCallFunctions: [...clientCallFunctions], slotStart: slot }) : emptyTranslate();
    slot = translated.nextSlot || slot;
    addStats(stats, translated.stats);
    todos.push(...shift(translated.todos, w.deluge));
    recordAlertDiags(translated.todos, w.deluge, w, alertDiagnostics);
    const guarded = gateAction(app, w, translated, todos);
    const rules = fieldRuleSource(app, w, todos);
    const systemWrite = systemWriteKind(w);
    // The stamp and row binding join only a real script: a workflow with no
    // server body contributes nothing and is named `workflow-empty` below.
    const server = guarded.server.trim()
      ? [systemStampSource(systemWrite), subformRowSource(subform, guarded.server), guarded.server].filter((part) => part.trim()).join('\n')
      : '';
    if (server) writeKinds.add(systemWrite!);
    const prefetch = [subformRowSource(subform, translated.prefetch), translated.prefetch].filter((part) => part.trim()).join('\n');
    const clientBody = [subformRowSource(subform, guarded.client), rules, guarded.client].filter((part) => part.trim()).join('\n');
    if (!server.trim() && !prefetch.trim() && !clientBody.trim() && todos.length === todosBefore) {
      warnings.push({
        construct: 'workflow-empty',
        name: w.name || w.form || 'workflow',
        note: 'This workflow has no script and no field rules, so no handler is generated.',
      });
    }
    // Record-event scope and subform guards apply only when the merged module
    // mixes them; a uniform group runs the bodies exactly as one script.
    const conds: string[] = [];
    if (mixedScopes) {
      const scope = recordScope(w);
      if (scope === 'add') conds.push('!ctx.rowId');
      else if (scope === 'edit') conds.push(hasDelScope ? 'ctx.rowId && !ctx.deleting' : 'ctx.rowId');
      else if (scope === 'del') conds.push('ctx.deleting');
      else if (hasDelScope) conds.push('!ctx.deleting');
    }
    if (multiSubform && subform) conds.push(`ctx.subformRow && ctx.subformRow.field === ${JSON.stringify(subform)}`);
    const wrap = (part: string): string => (part.trim() && conds.length ? `if (${conds.join(' && ')}) {\n${indent(part)}\n}` : part);
    if (server.trim()) serverParts.push(wrap(server));
    if (prefetch.trim()) {
      hasPrefetch = true;
      prefetchParts.push(wrap(prefetch));
      if (translated.usesElement) prefetchElement = true;
    }
    const prefetchPath = prefetch.trim() ? `/forms/${encodeURIComponent(form)}/${kind}/prefetch` : '';
    if (clientBody.trim()) clientParts.push({ w, body: clientBody, prefetchPath });
    if (server.trim()) {
      recordHandler?.({
        path: `functions/aio/${base}.mjs`,
        kind,
        candidate: {
          name: w.name || `${form} ${w.event || 'handler'}`,
          server: guarded.server,
          client: guarded.client,
          deluge: w.deluge?.text ?? '',
        },
      });
    }
  }
  const serverBody = serverParts.join('\n');
  if (serverBody.trim()) {
    const systemWrite =
      writeKinds.size === 0 ? null : writeKinds.size === 1 ? [...writeKinds][0]! : 'add-or-edit';
    const recordEvents = new Set(group.map((w) => (w.recordEvent ?? '').trim().toLowerCase()));
    const recordEvent =
      recordEvents.size === 1
        ? first.recordEvent
        : scopes.has('both') || (scopes.has('add') && scopes.has('edit'))
          ? 'on add or edit'
          : scopes.has('edit')
            ? 'on edit'
            : 'on add';
    const extraRecordEvents = recordEvents.size > 1 ? { recordEvents: [...new Set(group.map((w) => w.recordEvent ?? ''))] } : {};
    put(
      `functions/aio/${base}.mjs`,
      aioModule({
        app,
        form,
        title: `Form handler ${first.event || first.name}`,
        // The on-delete script is a post-delete script, not the delete
        // endpoint itself: `/forms/<form>/delete` is owned by the generated
        // delete stub, which imports this module after the row is removed.
        path: `/forms/${encodeURIComponent(form)}/${kind === 'delete' ? 'delete-script' : kind}`,
        recordEvent,
        ...extraRecordEvents,
        systemWrite,
        validateSpecs: systemWrite ? validateSiblingSpecs(app, form) : undefined,
        body: serverBody,
        schema,
        deferSuccess: asyncOnSuccess && kind === 'success',
      }),
    );
  }
  if (hasPrefetch) {
    put(
      `functions/aio/${base}-prefetch.mjs`,
      prefetchModule({
        app,
        title: `Prefetch for ${first.event || first.name}`,
        path: `/forms/${encodeURIComponent(form)}/${kind}/prefetch`,
        dir: '../../',
        body: prefetchParts.join('\n'),
        form,
        formGrant: 'write',
        schema,
        element: prefetchElement,
      }),
    );
  }
  for (const part of clientParts) {
    collectClientCalls(part.body, calledFunctions);
    put(
      `client/handlers/${slug(form)}/${slug(part.w.event || part.w.name || 'handler')}.mjs`,
      clientModule(part.body, part.prefetchPath, { form, event: part.w.event, when: kind, recordEvent: part.w.recordEvent }),
    );
  }
}

function emitSchedule(
  app: App,
  w: Workflow,
  plan: SchedulePlan,
  put: (path: string, source: string) => void,
  stats: TranslateStats,
  todos: TodoItem[],
  alertDiagnostics: AlertDiagnostic[],
  schema?: SchemaPlan,
): void {
  const translated = w.deluge ? translateInApp(app, w.deluge.text, scheduleScriptOptions(app, w.form)) : emptyTranslate();
  addStats(stats, translated.stats);
  todos.push(...shift(translated.todos, w.deluge));
  recordAlertDiags(translated.todos, w.deluge, w, alertDiagnostics);
  const guarded = gateAction(app, w, translated, todos);
  // scheduleBody reports an untranslated selector criteria itself.
  if (plan.gap && plan.gap !== 'workflow-action-condition') todos.push({ construct: plan.gap, start: w.span.start, end: w.span.end });
  // A swept form schedule gets its rows from the sweeper, filtered by the criteria there.
  const swept = plan.kind === 'form' && !!plan.sweep;
  put(
    `functions/job/${plan.module}.mjs`,
    jobModule({
      app,
      name: w.name,
      pool: jobPoolName(app.name || w.name || 'schedule'),
      properties: w.properties,
      body: swept ? guarded.server : scheduleBody(app, w, guarded.server, todos),
      plan,
      schema,
    }),
  );
}

/** One sweeper Job when any form schedule is swept, and job-scheduling.json when the app has schedules. */
function emitScheduling(app: App, plans: Map<Workflow, SchedulePlan>, put: (path: string, source: string) => void, schema?: SchemaPlan, eventSweep = false): void {
  if (!plans.size && !eventSweep) return;
  const entries: { module: string; spec: NonNullable<Extract<SchedulePlan, { kind: 'form' }>['sweep']> }[] = [];
  const ordered = app.workflows.filter(isScheduleBranch).map((w) => plans.get(w)!);
  for (const plan of ordered) if (plan.kind === 'form' && plan.sweep) entries.push({ module: plan.module, spec: plan.sweep });
  if (entries.length) {
    put(
      `functions/job/${SWEEPER_MODULE}.mjs`,
      sweeperModule({ app, banner, runtimeOptions: `${timeZoneFields(app) || ', settingsTimeZone: spec.timeZone'}${schemaRuntimeOptions(app, schema)}`, entries }),
    );
  }
  put('job-scheduling.json', schedulingConfig(app, ordered, eventSweep));
}

/** The same branch order as generate(): blueprints and approvals win over the schedule container. */
function isScheduleBranch(w: Workflow): boolean {
  return isScheduleBranchWorkflow(w);
}

/** The schedule plans generate() emits from. Shared with fill-todos. */
export function schedulePlansFor(app: App): Map<Workflow, SchedulePlan> {
  return planSchedules(app, app.workflows.filter(isScheduleBranch), formLink, (src) => {
    const criteria = reportCriteria(src, app.functions);
    return criteriaHasTodo(criteria) ? null : criteria;
  });
}

/** The emitted placeholder for a `workflow-action-condition` gap. Shared with fill-todos. */
export const ACTION_CONDITION_GAP = 'await shim.todo(ctx, "workflow-action-condition");';

/**
 * A schedule `form = Name[criteria]` whose criteria does not translate is a
 * `workflow-action-condition` gap: scheduleBody emits the gap call even on an
 * empty body. Shared with fill-todos.
 */
export function scheduleCriteriaGap(w: Workflow, fns?: readonly CriteriaFunction[]): boolean {
  const link = formLink(w.form);
  return !!link.criteria && criteriaHasTodo(reportCriteria(link.criteria, fns));
}

/**
 * The generate() branch a workflow takes, in the same order generate() tests
 * them. Exported so the no-silent-drop audit classifies a workflow exactly
 * the way the generator emits it.
 */
export function workflowKind(w: Workflow): 'payment' | 'blueprint' | 'approval' | 'schedule' | 'form' {
  if (isPayment(w)) return 'payment';
  if (w.blueprint && (w.blueprint.stages.length || w.blueprint.transitions.length || w.blueprint.start)) return 'blueprint';
  if (isApproval(w)) return 'approval';
  if (isSchedule(w)) return 'schedule';
  return 'form';
}

/**
 * A schedule `form = Name[criteria]` selects rows through the datastore shim.
 * A criteria that does not translate omits the handler instead of running unfiltered.
 */
function scheduleBody(app: App, w: Workflow, body: string, todos: TodoItem[]): string {
  const link = formLink(w.form);
  if (!link.criteria) return body;
  if (scheduleCriteriaGap(w, app.functions)) {
    if (!body.includes('workflow-action-condition')) {
      todos.push({ construct: 'workflow-action-condition', start: w.span.start, end: w.span.end });
    }
    return ACTION_CONDITION_GAP;
  }
  const criteria = reportCriteria(link.criteria, app.functions);
  const staged = stagedFullRead(schemaOf(app), link.name);
  const zcql = staged ? `, { zcql: ${JSON.stringify(staged)} }` : '';
  const query = `await shim.datastore.rows(ctx, shim.datastore.query(ctx, ${JSON.stringify(link.name)}, ${JSON.stringify(criteria)}${zcql}));`;
  return body.trim() ? `${query}\n${body}` : query;
}

/** One generated approval or blueprint state machine. */
export interface FlowSpec {
  kind: 'approval' | 'blueprint';
  /** Workflow name from the .ds; the machine identity and the history `Machine` value. */
  name: string;
  /** Unique module and route slug. */
  slug: string;
  /** The governed form name (`Form[criteria]` link minus the criteria). */
  form: string;
  /**
   * The `Form[criteria]` record selector as a Criteria tree, or null. A machine
   * with a criteria governs only records that match: submit starts the first
   * matching machine, and a transition re-checks the stored row against it.
   */
  criteria: Criteria | null;
  /** The form link had a criteria that does not translate; counted as a TODO. */
  criteriaUnmigrated: boolean;
  /** Collision-safe status column name (`Status`, else `Flow_Status`, …). */
  statusColumn: string;
  /** The stage a new record enters (`Pending` for approvals, the blueprint start stage). */
  start: string;
  /** The generated transition-history table, when the app has machines. */
  historyTable?: string;
}

/**
 * The machines an app declares, in `.ds` order — one entry per logical
 * approval (all `on level N / on <action>` workflows of one name collapse to a
 * single machine) and one per blueprint. The UI submit path imports this list
 * so a live insert can stamp the start stage and write the history row.
 */
export function flowSpecs(app: App): FlowSpec[] {
  const historyTable = flowHistoryTable(app);
  const specs: FlowSpec[] = [];
  const used = new Set<string>();
  const uniqueSlug = (name: string): string => {
    const base = slug(name);
    let s = base;
    let n = 2;
    while (used.has(s)) s = `${base}-${n++}`;
    used.add(s);
    return s;
  };
  const linkOf = (w: Workflow) => {
    const link = formLink(w.form);
    let criteria: Criteria | null = null;
    let criteriaUnmigrated = false;
    if (link.criteria) {
      const parsed = reportCriteria(link.criteria, app.functions);
      if (criteriaHasTodo(parsed)) criteriaUnmigrated = true;
      else criteria = parsed;
    }
    const form = app.forms.find((item) => item.name === link.name);
    return { link, criteria, criteriaUnmigrated, form };
  };
  const approvalDone = new Set<string>();
  for (const w of app.workflows) {
    if (isBlueprintWorkflow(w) && w.blueprint) {
      const { link, criteria, criteriaUnmigrated, form } = linkOf(w);
      specs.push({
        kind: 'blueprint',
        name: w.name,
        slug: uniqueSlug(w.name || 'blueprint'),
        form: link.name,
        criteria,
        criteriaUnmigrated,
        statusColumn: flowStatusColumn(form?.fields ?? []),
        start: blueprintStart(w),
        historyTable,
      });
    } else if (isApproval(w)) {
      const key = w.name || `approval:${w.form ?? ''}`;
      if (approvalDone.has(key)) continue;
      approvalDone.add(key);
      const { link, criteria, criteriaUnmigrated, form } = linkOf(w);
      specs.push({
        kind: 'approval',
        name: w.name,
        slug: uniqueSlug(w.name || link.name || 'approval'),
        form: link.name,
        criteria,
        criteriaUnmigrated,
        statusColumn: flowStatusColumn(form?.fields ?? []),
        start: 'Pending',
        historyTable,
      });
    }
  }
  return specs;
}

/**
 * The machine spec each blueprint or approval workflow's scripts emit under:
 * blueprints by `.ds` order, approvals by group name (every workflow of one
 * approval maps to its group's spec). Shared with fill-todos.
 */
export function workflowFlowSpecs(app: App): Map<Workflow, FlowSpec> {
  const specs = flowSpecs(app);
  const blueprint = specs.filter((s) => s.kind === 'blueprint');
  const approval = new Map<string, FlowSpec>();
  for (const spec of specs) if (spec.kind === 'approval') approval.set(spec.name, spec);
  const out = new Map<Workflow, FlowSpec>();
  let blueprintIndex = 0;
  for (const w of app.workflows) {
    if (isBlueprintWorkflow(w) && w.blueprint) out.set(w, blueprint[blueprintIndex++]!);
    else if (isApproval(w)) {
      const spec = approval.get(w.name || `approval:${w.form ?? ''}`);
      if (spec) out.set(w, spec);
    }
  }
  return out;
}

/**
 * The blueprints governing `formName` that declare stage or `during` field
 * settings, with their machine slug. The record read and edit submit import
 * those machines; the UI model carries the same spec to hide and disable fields.
 */
export function blueprintFieldSpecs(app: App, formName: string): { slug: string; spec: BlueprintFieldSpec }[] {
  const out: { slug: string; spec: BlueprintFieldSpec }[] = [];
  const form = app.forms.find((item) => item.name === formName);
  for (const [w, spec] of workflowFlowSpecs(app)) {
    if (spec.kind !== 'blueprint' || spec.form !== formName) continue;
    const fields = blueprintFieldSpec(w, form, spec.statusColumn, machineTransitionName);
    if (fields) out.push({ slug: spec.slug, spec: fields });
  }
  return out;
}

/** Resolved approver rows for a level or transition. */
interface MachineApprover {
  key: string;
  value: string;
  kind: 'role' | 'profile' | 'user' | 'field' | 'unsupported';
  reason?: string;
}

/**
 * The todo one approver property raises, or null when it resolves. `level = N`
 * is always unsupported; `field = X` is a todo only when X is not a users
 * field of the machine's form: X that is not a users field cannot name a
 * person, so it stays an explicit TODO and denies at run time. Shared with
 * fill-todos so the walk counts the same approver gaps resolveApprovers
 * reports.
 */
export function approverGap(key: string, value: string, form: Form | undefined, owner = false): 'approver-field' | 'approver-reporting-level' | 'blueprint-transition-owner' | null {
  const kind = approverKindName(key);
  // A transition-owner setting that names no supported kind is not guessed.
  if (owner && !kind) return 'blueprint-transition-owner';
  if (kind === 'level') return 'approver-reporting-level';
  if (kind !== 'field') return null;
  const field = form?.fields.find((item) => item.name === value);
  return field && isUsersField(field) ? null : 'approver-field';
}

function resolveApprovers(properties: readonly Property[] | undefined, form: Form | undefined, todos: TodoItem[], owner = false): MachineApprover[] {
  const out: MachineApprover[] = [];
  for (const p of properties ?? []) {
    const kind = approverKindName(p.key);
    const gap = approverGap(p.key, p.value, form, owner);
    if (gap === 'blueprint-transition-owner') {
      todos.push({ construct: gap, start: p.span.start, end: p.span.end });
      out.push({ key: p.key, value: p.value, kind: 'unsupported', reason: 'unsupported: transition owner kind' });
      continue;
    }
    if (gap === 'approver-reporting-level') {
      todos.push({ construct: gap, start: p.span.start, end: p.span.end });
      out.push({ key: p.key, value: p.value, kind: 'unsupported', reason: 'unsupported: reporting-level approver' });
      continue;
    }
    if (gap === 'approver-field') {
      todos.push({ construct: gap, start: p.span.start, end: p.span.end });
      out.push({
        key: p.key,
        value: p.value,
        kind: 'unsupported',
        reason: 'unsupported: form-field approver',
      });
      continue;
    }
    if (!kind || kind === 'level') continue;
    out.push({ key: p.key, value: p.value, kind });
  }
  return out;
}

/** The level and action of `on level N / on approve`, or level 1 for a bare `on approve`. */
export function approvalEvent(event: string): { level: number; action: 'approve' | 'reject' } | null {
  const cleaned = event.trim().replace(/\s*\/\s*on load\s*$/i, '');
  const leveled = /^on level (\d+)\s*\/\s*on (approve|reject)\s*$/i.exec(cleaned);
  if (leveled) return { level: Number(leveled[1]), action: leveled[2]!.toLowerCase() as 'approve' | 'reject' };
  const bare = /^on (approve|reject)\s*$/i.exec(cleaned);
  if (bare) return { level: 1, action: bare[1]!.toLowerCase() as 'approve' | 'reject' };
  return null;
}

/**
 * The todo an approval event line raises when it is neither `on start` nor a
 * parseable level/action: `approval-on-load` when the line ends in `on load`,
 * else `approval-event`. Its deluge is not emitted. Shared with fill-todos.
 */
export function approvalEventGap(w: Workflow): { construct: 'approval-on-load' | 'approval-event'; start: number; end: number } | null {
  if (/^on start\s*$/i.test(w.event)) return null;
  if (approvalEvent(w.event)) return null;
  if (/\/\s*on load\s*$/i.test(w.event)) {
    const span = w.deluge?.span ?? w.span;
    return { construct: 'approval-on-load', start: span.start, end: span.end };
  }
  return { construct: 'approval-event', start: w.span.start, end: w.span.end };
}

function emitApproval(
  app: App,
  group: Workflow[],
  spec: FlowSpec,
  put: (path: string, source: string) => void,
  stats: TranslateStats,
  todos: TodoItem[],
  alertDiagnostics: AlertDiagnostic[],
  schema?: SchemaPlan,
): void {
  const first = group[0]!;
  const form = app.forms.find((item) => item.name === spec.form);
  if (spec.criteriaUnmigrated) todos.push({ construct: 'workflow-action-condition', start: first.span.start, end: first.span.end });
  const start: RawDeluge[] = [];
  const levels = new Map<number, { actions: Map<string, RawDeluge[]>; approvers: Property[] }>();
  for (const w of group) {
    if (/^on start\s*$/i.test(w.event)) {
      if (w.deluge) start.push(w.deluge);
      continue;
    }
    const parsed = approvalEvent(w.event);
    if (!parsed) {
      const gap = approvalEventGap(w);
      if (gap) todos.push({ construct: gap.construct, start: gap.start, end: gap.end });
      continue;
    }
    const level = levels.get(parsed.level) ?? { actions: new Map<string, RawDeluge[]>(), approvers: [] };
    levels.set(parsed.level, level);
    // Declared actions come from the workflow existing; an empty script still
    // declares the transition even though nothing runs for it.
    const list = level.actions.get(parsed.action) ?? [];
    if (w.deluge) list.push(w.deluge);
    level.actions.set(parsed.action, list);
    for (const p of w.approvers ?? []) {
      if (!level.approvers.some((item) => item.key === p.key && item.value === p.value)) level.approvers.push(p);
    }
  }
  const translate = (deluge: RawDeluge, w: Workflow, _name: string): string => {
    const translated = translateInApp(app, deluge.text, approvalScriptOptions());
    addStats(stats, translated.stats);
    todos.push(...shift(translated.todos, deluge));
    recordAlertDiags(translated.todos, deluge, { form: spec.form, event: w.event, name: spec.name }, alertDiagnostics);
    return gateAction(app, w, translated, todos).server;
  };
  const scripts: { name: string; body: string }[] = [];
  const ordered = [...levels.keys()].sort((a, b) => a - b);
  const stageAt = (index: number, level: number): string => (index === 0 ? 'Pending' : `Pending level ${level}`);
  const transitions: Record<string, unknown>[] = [];
  const levelRows: { level: number; approvers: MachineApprover[] }[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const level = ordered[index]!;
    const entry = levels.get(level)!;
    const approvers = resolveApprovers(entry.approvers, form, todos);
    levelRows.push({ level, approvers });
    const next = ordered[index + 1];
    for (const action of ['approve', 'reject'] as const) {
      // A level declares the actions it offers; an undeclared action is not a
      // transition, so a caller cannot reach it.
      if (!entry.actions.has(action)) continue;
      const delugeList = entry.actions.get(action)!;
      const script = `${action}_${level}`;
      const body = delugeList.map((deluge) => translate(deluge, first, `${spec.name} level ${level} ${action}`)).filter((s) => s.trim()).join('\n');
      if (body.trim()) scripts.push({ name: script, body });
      transitions.push({
        action,
        name: `level ${level}`,
        from: stageAt(index, level),
        to: action === 'approve' ? (next === undefined ? 'Approved' : stageAt(index + 1, next)) : 'Rejected',
        level,
        script,
        approvers,
      });
    }
  }
  const startBody = start.map((deluge) => translate(deluge, first, `${spec.name} on start`)).filter((s) => s.trim()).join('\n');
  if (startBody.trim()) scripts.unshift({ name: 'on_start', body: startBody });
  put(
    `functions/flow/${spec.slug}.mjs`,
    machineModule({
      app,
      name: spec.name,
      form: spec.form,
      event: 'approval',
      scripts,
      schema,
      machine: {
        kind: 'approval',
        name: spec.name,
        slug: spec.slug,
        statusColumn: spec.statusColumn,
        currentStatus: spec.start,
        start: spec.start,
        formCriteria: spec.criteria,
        historyTable: spec.historyTable ?? null,
        submitHistory: true,
        levels: levelRows,
        transitions,
      },
    }),
  );
}

function emitBlueprint(
  app: App,
  w: Workflow,
  spec: FlowSpec | undefined,
  put: (path: string, source: string) => void,
  stats: TranslateStats,
  todos: TodoItem[],
  alertDiagnostics: AlertDiagnostic[],
  schema?: SchemaPlan,
): void {
  const resolved = spec ?? flowSpecs(app).find((item) => item.kind === 'blueprint' && item.name === w.name);
  if (!resolved) return;
  const form = app.forms.find((item) => item.name === resolved.form);
  if (resolved.criteriaUnmigrated) todos.push({ construct: 'workflow-action-condition', start: w.span.start, end: w.span.end });
  const scripts: { name: string; body: string }[] = [];
  const transitions: Record<string, unknown>[] = [];
  const transitionList = w.blueprint?.transitions ?? [];
  const inputFields = bodyInputFields(app, w.form);
  const lookupFields = lookupFieldNames(app, w.form);
  // `input.X`/`old.X` member roots a criterion may read: the form's fields,
  // the machine's status column, and the stored row's id and system columns,
  // which are always present. Bare `Status`/`ROWID` read the same record, so a
  // criterion may name them without the `input.` prefix too.
  const recordRoots = new Set([...inputFields, resolved.statusColumn, 'ROWID', 'Added_User', 'Added_Time', 'Modified_User', 'Modified_Time']);
  const criteriaFields = [...inputFields];
  for (const name of [resolved.statusColumn, 'ROWID']) if (!criteriaFields.includes(name)) criteriaFields.push(name);
  // Stage and `during` field settings: which fields show and which a caller
  // may change in each stage and transition. Null keeps bytes unchanged.
  const fieldSpec = blueprintFieldSpec(w, form, resolved.statusColumn, machineTransitionName, todos);
  for (let index = 0; index < transitionList.length; index++) {
    const t = transitionList[index]!;
    const parts: string[] = [];
    const afterParts: string[] = [];
    // Every `transition criteria` property gates the transition, wherever it
    // sits — on the transition itself or inside any phase, in any letter case.
    // Each occurrence gets its own script; the runtime ANDs them, so duplicated
    // keys can never collide on one generated function name.
    const conditionScripts: string[] = [];
    const condition = (prop: Property, place: string): void => {
      const tr = translateInApp(app, `return ${prop.value};`, { alertEvent: 'unverified', inputFields: criteriaFields, lookupFields });
      addStats(stats, tr.stats);
      todos.push(...shift(tr.todos, { text: prop.value, span: prop.span }));
      recordAlertDiags(tr.todos, { text: prop.value, span: prop.span }, { form: w.form, event: w.event, name: `${t.name} / ${place} condition` }, alertDiagnostics);
      const scriptName = conditionScripts.length ? `transition_${index}_condition_${conditionScripts.length + 1}` : `transition_${index}_condition`;
      let body = tr.server;
      const code = codeSansCommentsAndStrings(body);
      if (!/\breturn\b/.test(code)) {
        // A criterion that produced no verdict stays a closed gate — never a
        // free pass — and the report lists it for manual remediation.
        if (!tr.todos.length) todos.push({ construct: 'blueprint-transition-criteria', start: prop.span.start, end: prop.span.end });
        body = `${body.trim() ? `${body}\n` : ''}return false;`;
      } else {
        // A criterion that names something not on the form can never be
        // evaluated: a bare identifier throws when the gate runs, and an
        // `input.`/`old.` record read of a removed field — member, subscript,
        // `.get`, or `.toMap().get` — yields undefined. An untranslated call
        // yields undefined too, and nested in `== null` or `!` that would be a
        // passing verdict, so any `shim.todo(` in the criterion denies as
        // well. Each case stays a closed gate with its own deny reason, and
        // the report lists it.
        const criterion = unwrapReturnBody(body);
        if (
          /\bshim\.todo\(/.test(code) ||
          unboundGuardIdentifiers(criterion).length > 0 ||
          recordFieldRoots(criterion).some((name) => name === null || !recordRoots.has(name))
        ) {
          todos.push({ construct: 'blueprint-transition-criteria', start: prop.span.start, end: prop.span.end });
          body = 'deny("transition criteria reference an unknown field or function");';
        }
      }
      scripts.push({ name: scriptName, body: `// ${machineTransitionName(t.name)} condition\n${body}` });
      conditionScripts.push(scriptName);
    };
    for (const prop of t.properties) {
      if (isTransitionCriteria(prop.key)) condition(prop, 'transition');
      else if (!TRANSITION_HEADER_PROPS.has(prop.key.trim().toLowerCase()) && !approverKindName(prop.key) && !isOwnerKey(prop.key)) {
        todos.push({ construct: `blueprint-transition-property-${prop.key}`, start: prop.span.start, end: prop.span.end });
      }
    }
    // `action = update_fields` makes a during phase an update-fields action:
    // the visible/updatable lists are migrated by `blueprintFieldSpec`, and
    // `workflow status` says whether the update fires the form's on-edit
    // workflows (Creator runs them by default; the "skip" choice serializes
    // as `workflow status = false`).
    let updateFields = false;
    let workflowStatus = true;
    for (const p of t.phases) {
      const during = p.phase.trim().toLowerCase() === 'during';
      for (const prop of p.properties) {
        if (isTransitionCriteria(prop.key)) {
          condition(prop, p.phase);
          continue;
        }
        const key = prop.key.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
        if (during && key === 'action') {
          const action = unquote(prop.value).trim().toLowerCase().replace(/[\s-]+/g, '_');
          if (action === 'update_fields') updateFields = true;
          else todos.push({ construct: `blueprint-phase-property-${prop.key}`, start: prop.span.start, end: prop.span.end });
        } else if (during && key === 'workflow status') {
          const value = unquote(prop.value).trim().toLowerCase();
          if (value === 'true' || value === 'false') workflowStatus = value === 'true';
          else todos.push({ construct: `blueprint-phase-property-${prop.key}`, start: prop.span.start, end: prop.span.end });
        } else if (!isConsumedPhaseProperty(p.phase, prop.key)) {
          todos.push({ construct: `blueprint-phase-property-${prop.key}`, start: prop.span.start, end: prop.span.end });
        }
      }
      for (const block of p.blocks) {
        if (p.phase.trim().toLowerCase() === 'during' && phaseFieldKind(block.name)) continue;
        if (isOwnerBlockName(block.name)) continue;
        todos.push({ construct: `blueprint-phase-block-${block.name}`, start: block.span?.start ?? p.span.start, end: block.span?.end ?? p.span.end });
      }
      const texts = p.deluge.map((d) => {
        const tr = translateInApp(app, d.text, serverScriptOptions(app, w.form));
        addStats(stats, tr.stats);
        todos.push(...shift(tr.todos, d));
        recordAlertDiags(tr.todos, d, { form: w.form, event: w.event, name: `${t.name} / ${p.phase}` }, alertDiagnostics);
        return tr.server;
      });
      const server = texts.filter((s) => s.trim()).join('\n');
      if (server.trim()) (p.phase.trim().toLowerCase() === 'after' ? afterParts : parts).push(`// ${machineTransitionName(t.name)} / ${p.phase}\n${server}`);
    }
    const script = `transition_${index}`;
    if (parts.length) scripts.push({ name: script, body: parts.join('\n') });
    // After actions run only once the record has moved stage (Creator), so the
    // after phase is its own script, run after the stage write.
    const afterScript = `transition_${index}_after`;
    if (afterParts.length) scripts.push({ name: afterScript, body: afterParts.join('\n') });
    transitions.push({
      action: 'transition',
      name: machineTransitionName(t.name),
      from: t.fromStage ?? resolved.start,
      to: t.toStage ?? null,
      script,
      conditionScripts,
      ...(afterParts.length ? { afterScript } : {}),
      phases: t.phases.map((p) => p.phase),
      approvers: resolveApprovers(transitionOwnerProperties(t, app), form, todos, true),
      ...(fieldSpec?.transitions[machineTransitionName(t.name)] ? { fields: fieldSpec.transitions[machineTransitionName(t.name)] } : {}),
      ...(updateFields ? { workflowStatus } : {}),
    });
  }
  // Stage and `start` settings blocks (chart data and the like) are source-UI
  // layout metadata: not translated, but never silently dropped.
  for (const stage of w.blueprint?.stages ?? []) {
    for (const prop of stage.properties) if (!isStageFieldProperty(prop.key)) todos.push({ construct: `blueprint-stage-property-${prop.key}`, start: prop.span.start, end: prop.span.end });
    for (const block of stage.blocks) if (!isStageFieldProperty(block.name)) todos.push({ construct: `blueprint-stage-block-${block.name}`, start: block.span.start, end: block.span.end });
  }
  const start = w.blueprint?.start;
  if (start) {
    for (const prop of start.properties) {
      if (prop.key.trim().toLowerCase() === 'start stage') continue;
      todos.push({ construct: `blueprint-start-property-${prop.key}`, start: prop.span.start, end: prop.span.end });
    }
    for (const block of start.blocks) todos.push({ construct: `blueprint-start-block-${block.name}`, start: block.span.start, end: block.span.end });
  }
  put(
    `functions/flow/${resolved.slug}.mjs`,
    machineModule({
      app,
      name: resolved.name,
      form: resolved.form,
      event: w.event || 'blueprint',
      scripts,
      schema,
      editWorkflows: onEditWorkflowSpecs(app, resolved.form),
      machine: {
        kind: 'blueprint',
        name: resolved.name,
        slug: resolved.slug,
        statusColumn: resolved.statusColumn,
        currentStatus: resolved.start,
        start: resolved.start,
        formCriteria: resolved.criteria,
        historyTable: resolved.historyTable ?? null,
        stages: (w.blueprint?.stages ?? []).map((s) => s.name),
        ...(fieldSpec ? { stageFields: fieldSpec.stages, formFields: (form?.fields ?? []).map((f) => f.name) } : {}),
        transitions,
      },
    }),
  );
}

/**
 * The aio module specs of the governed form's on-edit workflows: a
 * `workflow status = true` transition fires them on its update-fields save —
 * On Validate before the field write, On Success after it. Scoping matches
 * `validateSiblingSpecs`: `on edit`, `on add or edit`, and unscoped events
 * run on an edit; `on add` and `on delete` never do. A workflow with no
 * server actions emits no module, and the runtime import treats a missing
 * file as nothing to run.
 */
function onEditWorkflowSpecs(app: App, form: string): { validate: string[]; success: string[] } {
  const out: { validate: string[]; success: string[] } = { validate: [], success: [] };
  for (const kind of ['validate', 'success'] as const) {
    const group = handlerGroup(app, form, kind).filter((other) => workflowKind(other) === 'form');
    const record = (o: Workflow) => (o.recordEvent ?? '').toLowerCase();
    if (!group.some((o) => !record(o) || record(o).includes('edit'))) continue;
    out[kind].push(`../aio/${slug(form)}/${handlerLeaf(group)}.mjs`);
  }
  return out;
}

/** `Send as "Send"` is an internal name plus a display label; the label wins. */
function machineTransitionName(name: string): string {
  const match = /\s+as\s+("[^"]*")\s*$/i.exec(name ?? '');
  return match ? unquote(match[1]!) : name;
}

/** `transition criteria` in any letter case — the source format does not fix key casing. */
function isTransitionCriteria(key: string): boolean {
  return key.trim().toLowerCase() === 'transition criteria';
}

/** Transition header properties the generator already reads (`from stage`, `to stage`) or deliberately ignores (`type`). */
const TRANSITION_HEADER_PROPS = new Set(['type', 'from stage', 'to stage']);

/**
 * An `api <name> { ... }` custom-API block that publishes a function over HTTP.
 * `scope`/`method` are the block's properties, unquoted, when declared.
 */
export interface ApiPublish {
  api: string;
  method?: string;
  scope?: string;
}

/** Top-level `api` block property, unquoted (`scope`, `method`). */
function apiProp(api: PropertyBlock, key: string): string | undefined {
  const p = api.properties.find((x) => x.key.toLowerCase() === key);
  if (!p) return undefined;
  return unquote(p.value).trim() || undefined;
}

/** Every string an `api` block preserves: property values, flags, and the actions Deluge, at any depth. */
function apiDelugeText(block: PropertyBlock, out: string[] = []): string[] {
  for (const p of block.properties) out.push(p.value);
  out.push(...block.items);
  for (const d of block.deluge ?? []) out.push(d.text);
  for (const child of block.blocks) apiDelugeText(child, out);
  return out;
}

/** `name` used as a call target: preceded by `.`, `thisapp.`, an app link name, or a boundary — never mid-identifier. */
function callsFunction(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\w$])${escaped}\\s*\\(`, 'i').test(text);
}

/**
 * Which custom functions an `api <name> { ... }` block publishes over HTTP.
 * A custom API's actions script calls `thisapp.<fn>(args)` or
 * `<applink>.<fn>(args)` — the only Deluge syntax that invokes an in-app
 * function (deluge-docs/pages/deluge/help/misc-statements/call-function-in-creator.html).
 * A function with no publisher is in-process only: workflow actions and
 * `thisapp` dispatch call it, but it is not an HTTP route.
 */
export function apiPublishers(app: App): Map<string, ApiPublish[]> {
  const out = new Map<string, ApiPublish[]>();
  for (const api of app.apis) {
    const texts = apiDelugeText(api);
    const publish: ApiPublish = {
      api: api.name,
      ...(apiProp(api, 'method') ? { method: apiProp(api, 'method') } : {}),
      ...(apiProp(api, 'scope') ? { scope: apiProp(api, 'scope') } : {}),
    };
    for (const fn of app.functions) {
      if (!texts.some((text) => callsFunction(text, fn.name))) continue;
      const list = out.get(fn.name) ?? [];
      if (!list.some((p) => p.api === api.name)) list.push(publish);
      out.set(fn.name, list);
    }
  }
  return out;
}

/** Verbs an Advanced I/O route may declare. Same set as the function security rule. */
const ADVANCED_IO_METHODS = new Set(['GET', 'POST', 'DELETE', 'PUT', 'PATCH']);

/**
 * Endpoint verb for a function an `api` block publishes.
 * A declared `method` is kept, in any case. When every publisher omits
 * `method`, the endpoint stays POST — the verb routes.json uses when an
 * endpoint line names no method. Two declared verbs, or a verb outside
 * that set, is not a route. When some publishers declare a verb and others
 * omit it, the omitted ones adopt the declared verb rather than disagreeing
 * with their own default.
 */
function resolveApiMethod(publishers: readonly ApiPublish[]): { method: string } | { note: string } {
  const declared: string[] = [];
  for (const publisher of publishers) {
    const raw = publisher.method?.trim();
    if (!raw) continue;
    const method = raw.toUpperCase();
    if (!ADVANCED_IO_METHODS.has(method)) {
      return {
        note: `api ${publisher.api} method ${JSON.stringify(raw)} is not an Advanced I/O method; no route is written`,
      };
    }
    if (!declared.includes(method)) declared.push(method);
  }
  if (declared.length > 1) {
    return { note: `published methods ${[...declared].sort().join(', ')} disagree; no route is written` };
  }
  return { method: declared[0] ?? 'POST' };
}

/**
 * The translated body can change state: a Data Store write, mail, an outbound
 * call (invokeurl may POST, an integration task writes), an in-app function
 * call (it may write), or an untranslated hole (unknown, so not safe).
 */
const STATE_CHANGING_SHIMS =
  /\bshim\.(?:datastore\.(?:insert|insertRow|update|delete|flush|setField|writeRow)|mail\.send|http\.invokeurl|zoho\.task|thisapp\.call|todo)\(/;

function changesState(body: string): boolean {
  return STATE_CHANGING_SHIMS.test(body);
}

/** Profiles Creator would call Administrator: the administrator preset with no module list. */
export function administratorProfiles(app: App): string[] {
  const seen = new Set<string>();
  return app.profiles
    .filter((p) => profilePreset(p) === 'administrator')
    .map((p) => p.name)
    .filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function emitFunction(
  app: App,
  fn: FunctionDef,
  put: (path: string, source: string) => string,
  stats: TranslateStats,
  todos: TodoItem[],
  alertDiagnostics: AlertDiagnostic[],
  thisappEntries: ThisappEntry[],
  api: ApiPublish[] | undefined,
  admins: string[],
  warnings: GenerateWarning[],
  schema?: SchemaPlan,
): void {
  const binding = functionRowBinding(fn);
  let slot = 0;
  const parts = fn.deluge.map((d) => {
    const tr = translateInApp(app, d.text, functionScriptOptions(app, fn, slot));
    slot = tr.nextSlot;
    addStats(stats, tr.stats);
    todos.push(...shift(tr.todos, d));
    recordAlertDiags(tr.todos, d, { form: fn.form, event: fn.name, name: fn.name }, alertDiagnostics);
    return tr;
  });
  // functionScriptOptions is serverOnly: a function has no client half, so
  // there is no client module, prefetch module, or client-call endpoint.
  const server = parts.map((p) => p.server).filter((s) => s.trim()).join('\n');
  const name = slug(fn.name || 'function');
  // A declared function with an empty body is still a function. Skipping it
  // leaves the declaration out of the tree and out of the readiness report.
  const declaredEmpty = !fn.deluge.some((d) => d.text.trim());
  if (!server.trim() && !declaredEmpty) {
    if (!parts.some((p) => p.todos.length)) {
      warnings.push({
        construct: 'function-untranslated',
        name: fn.name || name,
        note: 'The function body produced no server, client, or prefetch code.',
      });
    }
    return;
  }
  const params = fnParams(fn.signature);
  if (server.trim() || declaredEmpty) {
    let httpApi: { publishers: ApiPublish[]; admins: string[]; method?: string; methodNote?: string } | undefined;
    if (api?.length) {
      const resolved = resolveApiMethod(api);
      if ('note' in resolved) {
        // The publishers do not name one Advanced I/O verb. A POST route here
        // would hide the declared method, so no endpoint is written and the
        // report names the gap.
        warnings.push({
          construct: 'custom-function-api-method',
          name: fn.name,
          note: resolved.note,
        });
        httpApi = { publishers: api, admins, methodNote: resolved.note };
      } else {
        // Creator custom APIs declare the callers an `api` block admits. Only an
        // admin-scoped api maps onto the Administrator profile preset; anything
        // else (no scope, or a scope we cannot map to a profile) still routes —
        // the .ds asked for HTTP exposure — but restricted to Administrator with
        // a migration-report warning instead of invented permissions.
        for (const pub of api) {
          if (pub.scope && /admin/i.test(pub.scope)) continue;
          warnings.push({
            construct: 'custom-function-api-scope',
            name: fn.name,
            note: `api ${pub.api} ${pub.scope ? `scope ${JSON.stringify(pub.scope)} is not a determinable profile permission` : 'declares no scope'}; the generated route requires an Administrator-preset profile`,
          });
        }
        if (!admins.length) {
          warnings.push({
            construct: 'custom-function-api-scope',
            name: fn.name,
            note: `no Administrator-preset profile is declared in share_settings; the generated route denies every caller`,
          });
        }
        let method = resolved.method;
        if (method === 'GET' && changesState(server)) {
          // A GET is a safe method: browsers send it cross-site with cookies
          // and skip the CORS preflight, so a state change behind it is a CSRF
          // hole. The route is written as POST and the report names the change.
          method = 'POST';
          warnings.push({
            construct: 'custom-function-api-method',
            name: fn.name,
            note: `api ${api.map((p) => p.api).join(', ')} method GET is routed as POST: the function writes data, sends mail, or calls out, and a state change is never a GET`,
          });
        }
        httpApi = { publishers: api, admins, method };
      }
    }
    const path = put(
      `functions/custom/${name}.mjs`,
      customModule({ app, name: fn.name, signature: fn.signature, params, form: fn.form, body: server, row: binding, api: httpApi, schema }),
    );
    // thisapp.<fn> resolves this name in the generated registry
    // (functions/thisapp.mjs). A parameter typed by a form link name is a
    // record parameter: a `__row` argument contributes its live values.
    const recordParams: Record<string, string> = {};
    for (const p of fnSignatureParams(fn.signature)) {
      const form = app.forms.find((f) => f.name.toLowerCase() === p.type.toLowerCase());
      if (form) recordParams[p.name] = form.name;
    }
    thisappEntries.push({
      name: fn.name,
      spec: `./${path.slice('functions/'.length)}`,
      exported: safeFn(fn.name),
      params,
      recordParams,
      rowForm: binding && fn.form ? fn.form : '',
    });
  }
}

function emptyTranslate(): { server: string; client: string; prefetch: string; usesElement?: boolean; nextSlot: number; stats: TranslateStats; todos: TodoItem[] } {
  return { server: '', client: '', prefetch: '', nextSlot: 0, stats: EMPTY_STATS(), todos: [] };
}

function shift(items: TodoItem[], raw: RawDeluge | null): TodoItem[] {
  if (!raw) return items;
  return items.map((t) => ({ ...t, start: t.start + raw.span.start, end: t.end + raw.span.start }));
}

/** A condition that does not translate is a counted `field-rule-condition` TODO, like gateAction. */
function fieldRuleSource(app: App, w: Workflow, todos: TodoItem[]): string {
  const rules = w.fieldRules;
  if (!rules?.length) return '';
  return rules
    .map((rule) => {
      const lines = rule.actions
        .map((a) => `actions.push({ op: ${JSON.stringify(a.action)}, targets: ${JSON.stringify(a.fields)} });`)
        .join('\n');
      if (!rule.condition) return lines;
      const guard = emittedFieldRuleConditionFor(app, w.form, rule.condition);
      if (guard.startsWith('await shim.todo(')) {
        todos.push({ construct: 'field-rule-condition', start: rule.span.start, end: rule.span.end });
        return guard;
      }
      return `if (${guard}) {\n${indent(lines)}\n}`;
    })
    .join('\n');
}

/**
 * `actions (criteria)` runs only when the criteria is true.
 * A criteria that does not translate to a value is a coverage gap, not `if (todo())`.
 * Shared with fill-todos.
 */
export function actionGuardFor(app: App, w: Workflow): { code: string; todo: boolean } {
  const condition = w.actionCondition?.trim();
  if (!condition) return { code: '', todo: false };
  return actionGuard(condition, fieldNamesOf(app, w.form), decimalFieldNames(app));
}

function gateAction(
  app: App,
  w: Workflow,
  translated: { server: string; client: string },
  todos: TodoItem[],
): { server: string; client: string } {
  const condition = w.actionCondition?.trim();
  if (!condition) return { server: translated.server, client: translated.client };
  const guard = actionGuardFor(app, w);
  if (guard.todo) {
    todos.push({ construct: 'workflow-action-condition', start: w.span.start, end: w.span.end });
    const gap = ACTION_CONDITION_GAP;
    return {
      server: translated.server.trim() ? gap : '',
      client: translated.client.trim() ? gap : '',
    };
  }
  return { server: gate(translated.server, guard.code), client: gate(translated.client, guard.code) };
}

/**
 * Translate options for a function body. Shared with fill-todos so both walks
 * emit the same calls.
 *
 * A `type = functions` action with `execution type = for each record` runs on
 * each selected record: `rec` is that row, and a bare field link name of the
 * function's form (or `ID`) reads it, and the form's link name names it
 * (gallery shape: `thisapp.Application.Cancel(Fill_New_Application);`).
 *
 * With `execution type = collection of records` it runs once for all the
 * selected records: `recs` is that collection, and the form's link name names
 * it (gallery shape: `thisapp.CustomAction.approveVisa(Add_Visa_Details);`).
 * A bare field name or `ID` reads the first record of the collection, as
 * `<collection_variable>.<field_link_name>` does
 * (deluge-docs/pages/data-access__update-records.html,
 * https://www.zoho.com/deluge/help/data-access/update-records.html).
 *
 * A parameter whose type is a form of the app is a record collection: its
 * field reads and writes go through shim.record, which reads the first record
 * and reads null from a null or empty collection (same page).
 */
export function functionRowOptions(app: App, fn: FunctionDef): Pick<TranslateOptions, 'rowNames' | 'rowFields' | 'rowAlias'> {
  const params = formParams(app, fn.signature);
  const row = functionRowBinding(fn);
  if (!row) return { rowNames: params, rowFields: [] };
  const rowFields = fieldNamesOf(app, fn.form);
  if (!rowFields.includes('ID')) rowFields.push('ID');
  const form = formLink(fn.form).name;
  return { rowNames: [row, ...params.filter((n) => n !== row)], rowFields, ...(form ? { rowAlias: { name: form, row } } : {}) };
}

/** How the function's rows are bound: none, `rec` (for each record) or `recs` (collection of records). */
function functionRowBinding(fn: FunctionDef): '' | 'rec' | 'recs' {
  const blob = fn.properties.map((p) => `${p.key} ${p.value}`).join('\n');
  if (/for each record/i.test(blob)) return 'rec';
  if (/collection of records/i.test(blob)) return 'recs';
  return '';
}

/** Parameter names whose declared type is a form of the app (`Add_Visa_Details visaDetails`). */
function formParams(app: App, signature: string | undefined): string[] {
  const m = signature?.match(/\(([^)]*)\)/);
  if (!m || !m[1]?.trim()) return [];
  const forms = new Set(app.forms.map((f) => f.name.toLowerCase()));
  const out: string[] = [];
  for (const part of m[1].split(',')) {
    const words = part.trim().split(/\s+/);
    if (words.length < 2) continue;
    const name = words[words.length - 1]!;
    if (forms.has(words[words.length - 2]!.toLowerCase()) && /^[$A-Za-z_][\w$]*$/.test(name)) out.push(name);
  }
  return out;
}

/**
 * The subform field whose row event this is: `on user input of Sub.Field`,
 * `on add row of Sub`, `on delete row of Sub`. Only those events have an
 * implicit `row`, the subform row the event fired on
 * (deluge-docs/pages/miscellaneous__access-subform-fields.html,
 * https://www.zoho.com/deluge/help/miscellaneous/access-subform-fields.html).
 */
export function subformEventField(event: string | undefined): string | null {
  const leaf = (event ?? '').split(' / ').pop()!.trim();
  const rowEvent = /^on (?:add|delete) row of\s+([A-Za-z_][\w]*)\s*$/i.exec(leaf);
  if (rowEvent) return rowEvent[1]!;
  const input = /^on user input of\s+([A-Za-z_][\w]*)\.[A-Za-z_][\w]*\s*$/i.exec(leaf);
  return input ? input[1]! : null;
}

/**
 * Field link names a bare name in a body reads through `input` — the record
 * the handler runs on — plus `ID`, the record's own id. Locals still win.
 */
export function bodyInputFields(app: App, formName: string | undefined): string[] {
  const names = fieldNamesOf(app, formName);
  if (!names.includes('ID')) names.push('ID');
  return names;
}

/**
 * Translate options for a form workflow. A subform row event binds `row`; an
 * approval script marks `approver.<x>`; bare field link names read `input`.
 * Shared with fill-todos.
 */
export function workflowRowOptions(app: App, w: Workflow): Pick<TranslateOptions, 'rowNames' | 'approval' | 'inputFields'> {
  return {
    inputFields: bodyInputFields(app, w.form),
    ...(subformEventField(w.event) ? { rowNames: ['row'] } : {}),
    ...(isApproval(w) ? { approval: true } : {}),
  };
}

/**
 * The subform row the event fired on: body.subformRow { field, index }. Only
 * this event's subform, and only an index that is a row of that subform in
 * \`record\` (the record the handler runs on, after the write screen).
 */
const SUBFORM_ROW_HELPER = `/** body.subformRow, when it names a row of this event's subform in record. Anything else is no row. */
function requestSubformRow(req, subform, record) {
  const fields = Array.isArray(subform) ? subform : [subform];
  const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
  const at = body && body.subformRow;
  if (!at || typeof at !== "object" || !fields.includes(at.field) || !Number.isInteger(at.index) || at.index < 0) return undefined;
  const rows = record && typeof record === "object" ? record[subform] : undefined;
  if (!Array.isArray(rows) || at.index >= rows.length) return undefined;
  const row = rows[at.index];
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  return { field: subform, index: at.index };
}
`;

/**
 * The function arguments the client sent: body.args, at most one per declared
 * parameter. Each argument is plain JSON data. A value with a runtime-branded
 * key (`__row`, `__query`, `__bind`, `__proto__`: anything starting `__`), a
 * non-plain object, a non-finite number, or nesting deeper than 16 is null.
 * The client cannot hand the prefetch a fetched row, a query, or a login-user
 * binding; server reads still go through the access policy.
 */
const REQUEST_ARGS_HELPER = `/** Plain JSON data: no runtime-branded keys, no non-plain objects, no non-finite numbers, depth at most 16. */
function plainJsonArg(value, depth) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || depth > 15) return false;
  if (Array.isArray(value)) return value.every((item) => plainJsonArg(item, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.keys(value).every((key) => !key.startsWith("__") && plainJsonArg(value[key], depth + 1));
}

/** body.args as plain JSON data, one per declared parameter. Runtime-branded or non-JSON values are null. */
function requestArgs(req, count) {
  const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
  const args = body && Array.isArray(body.args) ? body.args : [];
  const out = [];
  for (let i = 0; i < count; i++) out.push(i < args.length && plainJsonArg(args[i], 0) ? args[i] : null);
  return out;
}

/** Query-string arguments on a bodiless verb (GET/DELETE), one query parameter per declared
 *  parameter, named as the .ds signature names it. Every declared parameter is required: a
 *  missing one is a 400 naming it. A query key that names no parameter is ignored with a
 *  warning. The types map carries each parameter's compiler-normalised type (the same
 *  normalisation the type checker uses, so bool, integer, collection and
 *  every other accepted spelling coerce exactly as their canonical type would).
 *  Values coerce to the JSON value the body would carry on a POST: a numeric type
 *  takes a finite number, a bool takes true/false, a date/datetime takes a parseable
 *  date string, a list/map takes JSON of that shape, a string stays the raw string.
 *  A value that cannot carry its declared type is a 400 naming the parameter, and a
 *  parameter whose declared type has no coercion is a 400 naming the parameter and
 *  the type — never the raw string passed through silently. Coerced values get the
 *  same plain-JSON screening body args get. */
function requestQueryArgs(req, declared, types) {
  const searchParams = new URL((req && req.url) || "", "http://localhost").searchParams;
  const known = new Set(declared);
  for (const key of searchParams.keys()) {
    if (!known.has(key)) console.warn("Ignoring unknown query parameter: " + key);
  }
  const args = [];
  for (const name of declared) {
    if (!searchParams.has(name)) return { error: "missing required parameter: " + name };
    const raw = searchParams.get(name);
    const type = String((types && types[name]) || "").toLowerCase();
    let value = raw;
    if (type === "int" || type === "float") {
      value = Number(raw);
      if (!raw.trim() || !Number.isFinite(value)) return { error: "invalid number for parameter " + name };
    } else if (type === "bool") {
      if (raw.toLowerCase() === "true") value = true;
      else if (raw.toLowerCase() === "false") value = false;
      else return { error: "invalid boolean for parameter " + name };
    } else if (type === "date" || type === "datetime") {
      if (!raw || !Number.isFinite(Date.parse(raw))) return { error: "invalid date for parameter " + name };
    } else if (type === "list" || type === "map") {
      try {
        value = JSON.parse(raw);
      } catch (e) {
        return { error: "invalid " + type + " JSON for parameter " + name };
      }
      if (type === "list" && !Array.isArray(value)) return { error: "invalid list JSON for parameter " + name };
      if (type === "map" && (!value || typeof value !== "object" || Array.isArray(value))) return { error: "invalid map JSON for parameter " + name };
    } else if (type !== "string") {
      return { error: "unsupported type " + (type || "unknown") + " for parameter " + name };
    }
    args.push(plainJsonArg(value, 0) ? value : null);
  }
  return { args };
}
`;

/**
 * One loop element the client POSTs for a per-element slot: body.element is
 * `{ name, value }`, the name the translated loop variable and the value a
 * scalar under the same screening as function arguments — a list or map is
 * never an element. Anything else is no element, so the one-shot prefetch
 * skips the guarded slot.
 */
const REQUEST_ELEMENT_HELPER = `/** body.element: one loop element { name, value } a per-element slot is evaluated for. Scalars only — a posted list or map is never an element. */
function requestElement(req) {
  const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
  const el = body && body.element;
  if (!el || typeof el !== "object" || Array.isArray(el) || typeof el.name !== "string") return undefined;
  const v = el.value;
  const scalar = v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  return scalar && plainJsonArg(v, 0) ? { name: el.name, value: v } : undefined;
}
`;

/** The subform literal of \`shim.subform.currentRow(ctx, "Sub")\` in a generated body, as JS source. */
function currentRowField(body: string): string | null {
  return currentRowFields(body)[0] ?? null;
}

/** Every distinct subform literal a generated body names, in source order. A merged form module can bind more than one. */
function currentRowFields(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/shim\.subform\.currentRow\(ctx, ("(?:[^"\\]|\\.)*")\)/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** A `var`, `var [...]`, or `function` declaration of `id` in a body suppresses an emitted binding of the same name. */
function declaresIdent(body: string, id: string): boolean {
  return new RegExp(`\\bvar\\s+(?:${id}\\b|\\[[^\\]\\n]*\\b${id}\\b)|\\bfunction\\s+${id}\\b`).test(body);
}

/** `row` for a subform row event, read and written through shim.record. Only when the body uses it. */
function subformRowSource(subform: string | null, body: string): string {
  const id = jsIdent('row');
  if (!subform || !new RegExp(`(^|[^\\w$.])${id}\\b`).test(body) || declaresIdent(body, id)) return '';
  return `const ${id} = shim.subform.currentRow(ctx, ${JSON.stringify(subform)});`;
}

function fieldNamesOf(app: App, formName: string | undefined): string[] {
  const name = formLink(formName).name;
  if (!name) return [];
  const form = app.forms.find((item) => item.name === name);
  return form ? form.fields.map((field) => field.name) : [];
}

/**
 * Link names of lookup fields on a form: their record value is a reference
 * object, so `Field == literal` must compare the id/label, not object identity.
 */
function lookupFieldNames(app: App, formName: string | undefined): string[] {
  const name = formLink(formName).name;
  const form = name ? app.forms.find((item) => item.name === name) : undefined;
  const names: string[] = [];
  const walk = (fields: readonly Field[]): void => {
    for (const field of fields) {
      const id = fieldTypeRow(field.type)?.id;
      if (field.lookup || id === 'lookup-single' || id === 'lookup-multi') names.push(field.name);
      if (field.subfields.length) walk(field.subfields);
    }
  };
  if (form) walk(form.fields);
  return names;
}

const EXACT_DECIMAL_IDS = new Set(['decimal', 'percent', 'currency']);

function decimalFieldNames(app: App): string[] {
  const names: string[] = [];
  const walk = (fields: readonly Field[]): void => {
    for (const field of fields) {
      const row = fieldTypeRow(field.type);
      if (row && EXACT_DECIMAL_IDS.has(row.id)) names.push(field.name);
      if (field.subfields.length) walk(field.subfields);
    }
  };
  for (const form of app.forms) walk(form.fields);
  return names;
}

/** The app's form link names — a bare one is that form's collection, not a variable. */
export function appFormNames(app: App): string[] {
  return app.forms.map((f) => f.name);
}

const schemaCache = new WeakMap<App, SchemaPlan>();

function schemaOf(app: App): SchemaPlan {
  const cached = schemaCache.get(app);
  if (cached) return cached;
  const plan = generateSchema(app);
  schemaCache.set(app, plan);
  return plan;
}

/** Stages for a form's full-row read when one SELECT cannot cover it. */
function stagedFullRead(plan: SchemaPlan, form: string): string[] | null {
  return plainRecordStages(plan, form);
}

export function appFormFields(app: App): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const form of app.forms) {
    const fields: string[] = [];
    const walk = (list: typeof form.fields) => {
      for (const f of list) {
        if (f.type === 'subform' || f.type === 'radio' || f.type === 'checkbox' || f.type === 'lookup') {
          fields.push(f.name);
        } else if (f.type === 'matrix' || f.type === 'inline') {
          walk(f.subfields || []);
        } else if (f.type !== 'notes' && f.type !== 'section' && f.type !== 'integration') {
          fields.push(f.name);
        }
      }
    };
    walk(form.fields);
    map[form.name] = fields;
  }
  return map;
}


/**
 * Translate options every app script shares: the form catalog plus the
 * exact-decimal field names. fill-todos walks through the same builder so the
 * two can never drift on which names are forms or decimals.
 */
export function appTranslateOptions(app: App): Pick<TranslateOptions, 'formNames' | 'formFields' | 'decimalFields'> {
  return { formNames: appFormNames(app), formFields: appFormFields(app), decimalFields: decimalFieldNames(app) };
}

/** The one translate entry point for app deluge. fill-todos calls it too. */
export function translateInApp(app: App, src: string, options: TranslateOptions = {}) {
  const shared = appTranslateOptions(app);
  const translateOptions = { ...shared, ...options, decimalFields: shared.decimalFields, schema: schemaOf(app), connections: declaredConnections(app), functions: app.functions.map(fn => fn.name) };
  // Probe only for unresolved call todos. Sites are counted on the pass below.
  const baseline = withoutDecimalAudit(() => translate(src, translateOptions));
  return translate(resolveAppCalls(src, app.functions, baseline.todos), translateOptions);
}

/**
 * Report criteria and named-filter criteria that do not migrate, in `.ds`
 * order: one row per un-migrated criteria with its report context.
 * generate() counts each as a `report-criteria` todo on the report or filter
 * span; fill-todos lists the same set as note tasks. Shared so both see the
 * same holes.
 */
export function unmigratedReportCriteria(app: App): { report: Report; criteria: string; start: number; end: number }[] {
  const out: { report: Report; criteria: string; start: number; end: number }[] = [];
  for (const report of app.reports) {
    if (report.criteria?.trim() && criteriaHasTodo(reportCriteria(report.criteria, app.functions))) {
      out.push({ report, criteria: report.criteria, start: report.span.start, end: report.span.end });
    }
    for (const filter of report.filters) {
      if (filter.criteria?.trim() && criteriaHasTodo(reportCriteria(filter.criteria, app.functions))) {
        out.push({ report, criteria: filter.criteria, start: filter.span.start, end: filter.span.end });
      }
    }
  }
  return out;
}

/**
 * Translate options for a form-workflow script: which events may carry an
 * `alert`, the `row` binding a subform row event gets, and the row/approval/
 * input options. Shared with fill-todos.
 */
export function workflowScriptOptions(app: App, w: Workflow): TranslateOptions {
  return {
    alertEvent: alertEventClass(w.event),
    prefetchBound: subformEventField(w.event) ? ['row'] : [],
    ...workflowRowOptions(app, w),
  };
}

/**
 * Translate options for a script Creator runs without a client event — a
 * schedule or a blueprint transition phase. `alert` is unverified and bare
 * field link names read the record the script runs on. Shared with fill-todos.
 */
export function serverScriptOptions(app: App, form: string | undefined): TranslateOptions {
  return { alertEvent: 'unverified', inputFields: bodyInputFields(app, form) };
}

/**
 * Translate options for a schedule script. The job module is the schedule's
 * only output: no browser runs a schedule, so it has no client half
 * (`serverOnly`). Shared with fill-todos.
 */
export function scheduleScriptOptions(app: App, form: string | undefined): TranslateOptions {
  return { ...serverScriptOptions(app, form), serverOnly: true };
}

/**
 * Translate options inside an approval machine: `approver.<x>` is an explicit
 * TODO, `alert` is unverified. Shared with fill-todos.
 */
export function approvalScriptOptions(): TranslateOptions {
  return { alertEvent: 'unverified', approval: true };
}

/**
 * Translate options for a `type = functions` script. `slotStart` keeps the
 * prefetch slot counter unique across the function's deluge blocks. Shared
 * with fill-todos.
 */
export function functionScriptOptions(app: App, fn: FunctionDef, slotStart: number): TranslateOptions {
  return {
    ...functionRowOptions(app, fn),
    slotStart,
    alertEvent: 'unverified',
    // Neither UI target loads client/handlers/functions/*: a function runs
    // only as its server module, so it has no client half.
    serverOnly: true,
    decimalVars: fnDecimalParams(fn.signature),
    prefetchBound: rawFnParams(fn.signature),
  };
}

interface ClientCallCatalog {
  /** Dotted callee names proved read-only, lower-cased for lookup. */
  names: Set<string>;
  /** Emitted server body for each read-only function with a generated module. */
  bodies: Map<string, string>;
  /** Transitive form reads for each read-only function. */
  reads: Map<string, Set<string>>;
}

/**
 * Function bodies whose emitted server form is a read/pure call. The scan is
 * the same emitted-call allowlist the per-element guard uses, with
 * `shim.thisapp.call` accepted only after its target reaches the read-only
 * fixed point. A function that never reaches the set keeps today's manual
 * `client-condition-uses-server` result, and so does one that may mutate a
 * list or map reachable from its parameters (`mutatesParameters`).
 */
function clientCallFunctions(app: App): ClientCallCatalog {
  const bodies = new Map<string, string>();
  const forms = new Map<string, Set<string>>();
  for (const fn of app.functions) {
    let slot = 0;
    const server = fn.deluge
      .map((d) => {
        const tr = translateInApp(app, d.text, functionScriptOptions(app, fn, slot));
        slot = tr.nextSlot;
        return tr.server;
      })
      .filter((s) => s.trim())
      .join('\n');
    const declaredEmpty = !fn.deluge.some((d) => d.text.trim());
    if (!server.trim() && !declaredEmpty) continue;
    // A write into a parameter list or map is visible to the Deluge caller;
    // a client call runs on deserialized copies and would hide it.
    if (mutatesParameters(fn.deluge.map((d) => d.text), fnSignatureParams(fn.signature))) continue;
    const key = fn.name.toLowerCase();
    const reads = emittedReadForms(server);
    if (reads === null) continue;
    const own = new Set(reads);
    for (const form of functionReadForms(app, fn)) own.add(form);
    bodies.set(key, server);
    forms.set(key, own);
  }
  const names = new Set<string>();
  const reads = new Map<string, Set<string>>();
  for (;;) {
    let changed = false;
    for (const [key, body] of bodies) {
      if (names.has(key)) continue;
      if (!emittedReadOnly(body, (path) => names.has(path.join('.').toLowerCase()))) continue;
      const all = new Set(forms.get(key));
      for (const path of emittedThisappCalls(body) ?? []) {
        for (const form of reads.get(path.join('.').toLowerCase()) ?? []) all.add(form);
      }
      names.add(key);
      reads.set(key, all);
      changed = true;
    }
    if (!changed) break;
  }
  return { names, bodies, reads };
}

/** Literal form names an emitted function body reads through datastore.query. */
function emittedReadForms(body: string): Set<string> | null {
  const out = new Set<string>();
  for (const match of body.matchAll(/\bshim\.datastore\.query\s*\(\s*ctx\s*,\s*("(?:\\.|[^"\\])*")/g)) {
    try {
      const form = JSON.parse(match[1]!) as unknown;
      if (typeof form !== 'string') return null;
      out.add(form);
    } catch {
      return null;
    }
  }
  return out;
}

/** Forms bound by the function signature itself: the row binding and form-typed params. */
function functionReadForms(app: App, fn: FunctionDef): Set<string> {
  const out = new Set<string>();
  if (functionRowBinding(fn) && fn.form) out.add(fn.form);
  const formNames = new Set(app.forms.map((f) => f.name.toLowerCase()));
  for (const param of fnSignatureParams(fn.signature)) {
    if (formNames.has(param.type.toLowerCase())) out.add(param.type);
  }
  return out;
}

const CLIENT_FUNCTION_CALL = /\bshim\.client\.call\s*\(\s*ctx\s*,\s*("(?:\\.|[^"\\])*")/g;

/** The read-only callees an emitted client body actually calls. */
function collectClientCalls(body: string, out: Set<string>): void {
  for (const match of body.matchAll(CLIENT_FUNCTION_CALL)) {
    try {
      const name = JSON.parse(match[1]!) as unknown;
      if (typeof name === 'string') out.add(name.toLowerCase());
    } catch {
      // Generated call sites carry a JSON literal; a non-literal shape is not a reference.
    }
  }
}

const GUARD_BOUND = new Set([
  'shim', 'ctx', 'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'await', 'typeof', 'void', 'new', 'in', 'instanceof', 'of', 'delete',
]);

/** `code` with comments blanked and every string's contents collapsed to `""`. */
function codeSansCommentsAndStrings(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** Identifiers in a guard expression that are not bound. Property names after `.` are not identifiers. */
export function unboundGuardIdentifiers(code: string): string[] {
  const stripped = codeSansCommentsAndStrings(code);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of stripped.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = match[0];
    let i = match.index - 1;
    while (i >= 0 && /\s/.test(stripped[i] ?? '')) i--;
    if (i >= 0 && stripped[i] === '.') continue;
    if (GUARD_BOUND.has(name) || seen.has(name)) continue;
    seen.add(name);
    found.push(name);
  }
  found.sort(compareEnUs);
  return found;
}

/** How each workflow `actions` criteria would be emitted. Raw blocks never reach this. */
export function measureActionCriteria(app: App): { guarded: number; gap: number; unbound: string[] } {
  let guarded = 0;
  let gap = 0;
  const unbound: string[] = [];
  for (const w of app.workflows) {
    const fields = fieldNamesOf(app, w.form);
    if (w.actionCondition?.trim()) {
      const guard = actionGuard(w.actionCondition, fields, decimalFieldNames(app));
      const link = formLink(w.form);
      const formGap = !!link.criteria && criteriaHasTodo(reportCriteria(link.criteria, app.functions));
      if (formGap || guard.todo) gap++;
      else {
        guarded++;
        unbound.push(...unboundGuardIdentifiers(guard.code));
      }
    }
    for (const rule of w.fieldRules ?? []) {
      if (!rule.condition?.trim()) continue;
      const code = expressionCode(rule.condition, fields, decimalFieldNames(app));
      if (!code.startsWith('await shim.todo(')) unbound.push(...unboundGuardIdentifiers(code));
    }
  }
  return { guarded, gap, unbound };
}

function actionGuard(condition: string, inputFields: string[], decimalFields: string[] = []): { code: string; todo: boolean } {
  const tr = translate(`return (${condition});`, { inputFields, decimalFields });
  if (tr.todos.length > 0 || tr.server.includes('shim.todo(')) return { code: '', todo: true };
  const body = unwrapReturn(returnBodyOf(tr.server));
  if (!body || unboundGuardIdentifiers(body).length > 0) return { code: '', todo: true };
  return { code: body, todo: false };
}

/**
 * The `<expr>` a translated `return <expr>;` statement yields, or ''. The
 * statement's `//` provenance comment lines precede it, so a match must skip
 * leading comment lines rather than anchor on `return` at the head.
 */
function returnBodyOf(server: string): string {
  const match = /^(?:\/\/.*\n)*return\s+([\s\S]*);$/.exec(server.trim());
  return match?.[1]?.trim() ?? '';
}

/** The value a `return <expr>;` script yields, without the wrapper. */
function unwrapReturnBody(body: string): string {
  const inner = returnBodyOf(body);
  return inner ? unwrapReturn(inner) : body;
}

/** The argument texts of the call whose `(` sits at `open`, split at top-level commas. */
function callArgs(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')') {
      if (depth === 0) {
        const last = source.slice(start, i).trim();
        if (last || args.length) args.push(last);
        return args;
      }
      depth--;
    } else if ((ch === ']' || ch === '}') && depth > 0) depth--;
    else if (ch === ',' && depth === 0) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      while (++i < source.length && source[i] !== ch) if (source[i] === '\\') i++;
    }
  }
  const rest = source.slice(start).trim();
  if (rest || args.length) args.push(rest);
  return args;
}

/** Drop parentheses when they wrap the whole expression. */
function unwrapReturn(body: string): string {
  const s = body.trim();
  if (!s.startsWith('(') || !s.endsWith(')')) return s;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0) return i === s.length - 1 ? unwrapReturn(s.slice(1, -1).trim()) : s;
  }
  return s;
}

/**
 * `body` is already trimmed. When parentheses wrap the whole expression, `text`
 * is that expression unwrapped and `offset` is where `text` starts in `body`.
 */
function unwrapReturnAt(body: string): { text: string; offset: number } {
  if (!body.startsWith('(') || !body.endsWith(')')) return { text: body, offset: 0 };
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0) {
      if (i !== body.length - 1) return { text: body, offset: 0 };
      const innerRaw = body.slice(1, -1);
      const lead = innerRaw.length - innerRaw.trimStart().length;
      const nested = unwrapReturnAt(innerRaw.trim());
      return { text: nested.text, offset: 1 + lead + nested.offset };
    }
  }
  return { text: body, offset: 0 };
}

/** Argument texts of the call whose `(` sits at `open`, each with the index of its trimmed text in `source`. */
function callArgSpans(source: string, open: number): { text: string; start: number }[] {
  const args: { text: string; start: number }[] = [];
  let depth = 0;
  let start = open + 1;
  const push = (end: number): void => {
    const raw = source.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text || args.length) args.push({ text, start: start + lead });
  };
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')') {
      if (depth === 0) {
        push(i);
        return args;
      }
      depth--;
    } else if ((ch === ']' || ch === '}') && depth > 0) depth--;
    else if (ch === ',' && depth === 0) {
      push(i);
      start = i + 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      while (++i < source.length && source[i] !== ch) if (source[i] === '\\') i++;
    }
  }
  push(source.length);
  return args;
}

type RecordReceiverKind = 'root' | 'mixed' | 'none';

function combineRecordResults(results: RecordReceiverKind[]): RecordReceiverKind {
  if (results.length === 0) return 'none';
  if (results.includes('mixed')) return 'mixed';
  const hasRoot = results.includes('root');
  const hasNone = results.includes('none');
  if (hasRoot && hasNone) return 'mixed';
  if (hasRoot) return 'root';
  return 'none';
}

/**
 * Classify whether `code` evaluates to `shim.input.root(ctx)` or `ctx.old`.
 * Reduces recursively under `shim.convert.toMap`, `shim.ifnull`, parentheses,
 * top-level `||`, `&&`, and `if()` / `?:` conditional expressions.
 * Returns 'root' if all value arms evaluate to the record, 'mixed' if some
 * evaluate to the record and some do not, and 'none' otherwise.
 * `base` is the index of `code` in the surrounding text. Each exact record root
 * that is a value arm is appended to `valueRoots`. A root in an `if()` / `?:`
 * condition is not a value arm.
 */
function classifyRecordReceiver(code: string, base = 0, valueRoots?: number[]): RecordReceiverKind {
  const lead = code.length - code.trimStart().length;
  const s = code.trim();
  const sBase = base + lead;
  if (s === 'shim.input.root(ctx)' || s === 'ctx.old') {
    valueRoots?.push(sBase);
    return 'root';
  }
  if (!s) return 'none';
  const unwrapped = unwrapReturnAt(s);
  if (unwrapped.text !== s) return classifyRecordReceiver(unwrapped.text, sBase + unwrapped.offset, valueRoots);
  if (s.startsWith('shim.convert.toMap(') && s.endsWith(')')) {
    const args = callArgSpans(s, 'shim.convert.toMap'.length);
    return args.length > 0 ? classifyRecordReceiver(args[0]!.text, sBase + args[0]!.start, valueRoots) : 'none';
  }
  if (s.startsWith('shim.ifnull(') && s.endsWith(')')) {
    const args = callArgSpans(s, 'shim.ifnull'.length);
    return combineRecordResults(args.map((arg) => classifyRecordReceiver(arg.text, sBase + arg.start, valueRoots)));
  }
  const masked = maskCommentsAndStrings(s);
  let depth = 0;
  let qIndex = -1;
  let colonIndex = -1;
  let ternaryDepth = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0) {
      if (ch === '?' && masked[i + 1] !== '.' && masked[i + 1] !== '?' && (i === 0 || masked[i - 1] !== '?')) {
        if (ternaryDepth === 0) qIndex = i;
        ternaryDepth++;
      } else if (ch === ':' && ternaryDepth > 0) {
        ternaryDepth--;
        if (ternaryDepth === 0) {
          colonIndex = i;
          break;
        }
      }
    }
  }
  if (qIndex >= 0 && colonIndex > qIndex) {
    return combineRecordResults([
      classifyRecordReceiver(s.slice(qIndex + 1, colonIndex), sBase + qIndex + 1, valueRoots),
      classifyRecordReceiver(s.slice(colonIndex + 1), sBase + colonIndex + 1, valueRoots),
    ]);
  }
  depth = 0;
  const orParts: { text: string; offset: number }[] = [];
  let lastOr = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && ch === '|' && masked[i + 1] === '|') {
      orParts.push({ text: s.slice(lastOr, i), offset: lastOr });
      lastOr = i + 2;
      i++;
    }
  }
  if (orParts.length > 0) {
    orParts.push({ text: s.slice(lastOr), offset: lastOr });
    return combineRecordResults(orParts.map((part) => classifyRecordReceiver(part.text, sBase + part.offset, valueRoots)));
  }
  depth = 0;
  const andParts: { text: string; offset: number }[] = [];
  let lastAnd = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && ch === '&' && masked[i + 1] === '&') {
      andParts.push({ text: s.slice(lastAnd, i), offset: lastAnd });
      lastAnd = i + 2;
      i++;
    }
  }
  if (andParts.length > 0) {
    andParts.push({ text: s.slice(lastAnd), offset: lastAnd });
    return combineRecordResults(andParts.map((part) => classifyRecordReceiver(part.text, sBase + part.offset, valueRoots)));
  }
  return 'none';
}


/** `code` with comments blanked and every string's contents blanked in place, so offsets still line up. */
function maskCommentsAndStrings(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, (m) =>
    m[0] === '/' ? ' '.repeat(m.length) : `${m[0]}${' '.repeat(m.length - 2)}${m[0]}`,
  );
}

/** Index of the bracket that opens the one closing at `close` in `masked`, or -1. */
function matchingOpen(masked: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const ch = masked[i]!;
    if (ch === ')' || ch === ']' || ch === '}') depth++;
    else if (ch === '(' || ch === '[' || ch === '{') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the bracket that closes the one opening at `open` in `masked`, or -1. */
function matchingClose(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Start of the member/call chain that ends just before `end` in `masked` (`a.b(c)[d]` → index of `a`). */
function receiverStart(masked: string, end: number): number {
  let j = end;
  for (;;) {
    while (j > 0 && /\s/.test(masked[j - 1]!)) j--;
    const ch = masked[j - 1];
    if (ch === ')' || ch === ']') {
      const open = matchingOpen(masked, j - 1);
      if (open < 0) return j;
      j = open;
      continue;
    }
    if (ch === undefined || !/[\w$]/.test(ch)) return j;
    while (j > 0 && /[\w$]/.test(masked[j - 1]!)) j--;
    let k = j;
    while (k > 0 && /\s/.test(masked[k - 1]!)) k--;
    if (masked[k - 1] !== '.') return j;
    j = k - 1;
    if (masked[j - 1] === '?') j--;
  }
}

/**
 * The field names a criterion reads off the record: `input.X`/`old.X` member
 * reads (emitted `shim.input.get(ctx, "X")`) and the `input.get("X")`,
 * `old.get("X")`, `input.toMap().get("X")`, `containsKey`/`getJson` and
 * `keys().contains("X")` spellings (emitted `shim.list.*` on the record root),
 * member reads like `.Amount`, and `["X"]` subscripts.
 * Checked reads support `||`, `&&`, `ifnull(...)`, and `if()`/`?:` receivers, so long as
 * every value arm evaluates to the record (`ifnull(input, old).get("X")` included).
 * A root in the condition of an `if()` / `?:` receiver is not a value arm.
 * A receiver mixing the record with any other value fails closed. The mixed rows are
 * `ifnull(input, {"a":1}).get("Amount")`, `(input || {"a":1})["Amount"]`,
 * `if(Amount > 0, input, {"Amount":0}).Amount`, and `(Amount > 0 && input)["Amount"]`.
 * A record read whose key is not a string literal yields `null` so the caller fails closed
 * on a key it cannot check. Any other bare occurrence of the record also fails closed.
 */
function recordFieldRoots(body: string): (string | null)[] {
  const roots = new Set<string | null>();
  const addKey = (text: string | undefined): void => {
    const lit = /^"(?:[^"\\]|\\.)*"$/.exec((text ?? '').trim());
    if (!lit) {
      roots.add(null);
      return;
    }
    try {
      const name: unknown = JSON.parse(lit[0]);
      roots.add(typeof name === 'string' ? name : null);
    } catch {
      roots.add(null);
    }
  };

  const masked = maskCommentsAndStrings(body);
  const rootInstances = [...masked.matchAll(/(?:shim\.input\.root\(ctx\)|ctx\.old)(?!\w)/g)].map((m) => m.index);
  const accounted = new Set<number>();
  // Mark only the roots the classifier matched as value arms. A root in an
  // if() / ?: condition stays unmarked and denies like any other bare read.
  const accountReceiver = (code: string, base: number): RecordReceiverKind => {
    const found: number[] = [];
    const cls = classifyRecordReceiver(code, base, found);
    if (cls === 'root' || cls === 'mixed') {
      for (const idx of found) accounted.add(idx);
    }
    return cls;
  };

  for (const match of body.matchAll(/\bshim\.(?:input|old)\.get\(ctx,\s*("(?:[^"\\]|\\.)*")/g)) addKey(match[1]);
  // Generated `obj[key]` reads emit `shim.get(<receiver>, <key>)`: the same
  // classification as a bracket index — a recognised record receiver counts
  // the key, a mixed or unkeyed one fails closed.
  for (const match of body.matchAll(/\bshim\.get\(/g)) {
    const args = callArgs(body, match.index + match[0].length - 1);
    if (args.length !== 2) continue;
    const argStart = body.indexOf(args[0]!, match.index);
    const cls = argStart < 0 ? classifyRecordReceiver(args[0]!) : accountReceiver(args[0]!, argStart);
    if (cls === 'mixed' || cls === 'root') {
      if (cls === 'mixed') roots.add(null);
      else addKey(args[1]);
    }
  }
  for (const match of body.matchAll(/\bshim\.list\.(?:get|containsKey|getJson)\(/g)) {
    const args = callArgs(body, match.index + match[0].length - 1);
    if (args.length > 1) {
      const argStart = body.indexOf(args[0]!, match.index);
      const cls = argStart < 0 ? classifyRecordReceiver(args[0]!) : accountReceiver(args[0]!, argStart);
      if (cls === 'mixed' || cls === 'root') {
        if (cls === 'mixed') roots.add(null);
        else addKey(args[1]);
      }
    }
  }
  for (const match of body.matchAll(/\bshim\.list\.contains\(/g)) {
    const args = callArgs(body, match.index + match[0].length - 1);
    const first = (args[0] ?? '').trim();
    if (!first.startsWith('shim.list.keys(')) continue;
    const inner = callArgs(first, 'shim.list.keys'.length);
    if (inner.length > 0) {
      const argStart = body.indexOf(inner[0]!, match.index);
      const cls = argStart < 0 ? classifyRecordReceiver(inner[0]!) : accountReceiver(inner[0]!, argStart);
      if (cls === 'mixed' || cls === 'root') {
        if (cls === 'mixed') roots.add(null);
        else addKey(args[1]);
      }
    }
  }
  for (let open = masked.indexOf('['); open >= 0; open = masked.indexOf('[', open + 1)) {
    const start = receiverStart(masked, open);
    if (start === open) continue;
    const cls = accountReceiver(body.slice(start, open), start);
    if (cls === 'mixed' || cls === 'root') {
      if (cls === 'mixed') roots.add(null);
      else {
        const close = matchingClose(masked, open);
        addKey(close < 0 ? undefined : body.slice(open + 1, close));
      }
    }
  }
  for (const match of masked.matchAll(/(?:\.|\?\.)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g)) {
    const dotIndex = match.index;
    const propName = match[1];
    let k = dotIndex + match[0].length;
    while (k < masked.length && /\s/.test(masked[k]!)) k++;
    if (masked[k] === '(') continue;
    const start = receiverStart(masked, dotIndex);
    if (start === dotIndex) continue;
    const cls = accountReceiver(body.slice(start, dotIndex), start);
    if (cls === 'mixed' || cls === 'root') {
      if (cls === 'mixed') roots.add(null);
      else addKey(JSON.stringify(propName));
    }
  }

  for (const idx of rootInstances) {
    if (!accounted.has(idx)) {
      roots.add(null);
      break;
    }
  }

  return [...roots].sort();
}

function gate(body: string, test: string): string {
  if (!body.trim()) return body;
  return `if (${test}) {\n${indent(body)}\n}`;
}

/**
 * Field-rule condition text as it is written into the handler.
 * An untranslated condition is one statement, semicolon included, so a fill
 * walk sees the same `shim.todo` call `generate` emits.
 */
export function emittedFieldRuleCondition(condition: string, inputFields: string[] = [], decimalFields: string[] = []): string {
  const guard = expressionCode(condition, inputFields, decimalFields);
  if (guard.startsWith('await shim.todo(')) return `${guard};`;
  return guard;
}

/** Field-rule condition text for one workflow form, using the same field list as generate. */
export function emittedFieldRuleConditionFor(app: App, form: string | undefined, condition: string): string {
  return emittedFieldRuleCondition(condition, fieldNamesOf(app, form), decimalFieldNames(app));
}

/** Translate a criteria fragment by wrapping it in `return`. */
function expressionCode(condition: string, inputFields: string[] = [], decimalFields: string[] = []): string {
  const tr = translate(`return (${condition});`, { inputFields, decimalFields });
  const failed = tr.todos.length > 0 || tr.server.includes('shim.todo(');
  let body = returnBodyOf(tr.server);
  if (failed || !body) return 'await shim.todo(ctx, "field-rule-condition")';
  if (body.startsWith('(') && body.endsWith(')')) body = body.slice(1, -1).trim();
  if (!body || unboundGuardIdentifiers(body).length > 0) return 'await shim.todo(ctx, "field-rule-condition")';
  return body;
}

/** Parameter names exactly as the Deluge body writes them (pre-jsIdent). */
export function rawFnParams(signature: string | undefined): string[] {
  if (!signature) return [];
  const m = signature.match(/\(([^)]*)\)/);
  if (!m || !m[1]?.trim()) return [];
  return m[1]
    .split(',')
    .map((p) => p.trim().split(/\s+/).pop() ?? '')
    .filter((n) => /^[$A-Za-z_][\w$]*$/.test(n));
}

function fnParams(signature: string | undefined): string[] {
  // The body names a parameter through jsIdent (`var` is `d_var`), so the parameter must match.
  return rawFnParams(signature).map(jsIdent);
}

/** Parameters declared `decimal` (or legacy `float`): exact decimals inside the function body. */
function fnDecimalParams(signature: string | undefined): string[] {
  if (!signature) return [];
  const m = signature.match(/\(([^)]*)\)/);
  if (!m || !m[1]?.trim()) return [];
  return m[1]
    .split(',')
    .filter((p) => /^\s*(float|decimal)\s+/i.test(p))
    .map((p) => p.trim().split(/\s+/).pop() ?? '')
    .filter((n) => /^[$A-Za-z_][\w$]*$/.test(n));
}

/** Declared `(type name)` pairs of a `thisapp` signature; the last token is the name. */
function fnSignatureParams(signature: string | undefined): { type: string; name: string }[] {
  if (!signature) return [];
  const m = signature.match(/\(([^)]*)\)/);
  if (!m || !m[1]?.trim()) return [];
  const out: { type: string; name: string }[] = [];
  for (const part of m[1].split(',')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const name = tokens[tokens.length - 1] ?? '';
    if (!/^[$A-Za-z_][\w$]*$/.test(name)) continue;
    out.push({ type: tokens.slice(0, -1).join(' '), name });
  }
  return out;
}

/** The generated body calls `thisapp.<fn>` through the shim. */
function usesThisapp(body: string): boolean {
  return body.includes('shim.thisapp.call(');
}

/** A live run needs the injected datastore when the body reads or writes rows. */
function needsDatastore(body: string): boolean {
  return body.includes('shim.datastore.') || body.includes('shim.record.prepare');
}

function isPayment(w: Workflow): boolean {
  return isPaymentWorkflow(w);
}

function isSchedule(w: Workflow): boolean {
  return isScheduleWorkflow(w);
}

function isApproval(w: Workflow): boolean {
  return isApprovalWorkflow(w);
}

/** Creator `time zone` application setting, embedded so a dry run does not need C2C_APP_TIMEZONE. */
const decimalColumnCache = new WeakMap<App, Record<string, DecimalColumns>>();

/**
 * form (or child table) → exact-decimal field → Double shadow column and scale,
 * from the schema plan. The runtime writes the shadow and uses it for ZCQL criteria
 * and sort, then re-checks the exact varchar. NoSQL forms have no shadow.
 */
export function decimalColumnsOf(app: App): Record<string, DecimalColumns> {
  const cached = decimalColumnCache.get(app);
  if (cached) return cached;
  const out: Record<string, Record<string, DecimalColumn>> = {};
  for (const table of schemaOf(app).tables) {
    if (table.nosql || table.role === 'junction') continue;
    const key = table.role === 'form' ? table.form : table.name;
    for (const column of table.columns) {
      if (!column.shadowFor) continue;
      const exact = table.columns.find((c) => c.name === column.shadowFor);
      (out[key] ??= {})[exact?.field ?? column.shadowFor] = { shadow: column.name, scale: exact?.precision ?? 2 };
    }
  }
  decimalColumnCache.set(app, out);
  return out;
}

/** `, decimalColumns: {…}` for a generated createRuntime call, or nothing. */
export function decimalColumnsOption(app: App): string {
  const map = decimalColumnsOf(app);
  return Object.keys(map).length ? `, decimalColumns: ${JSON.stringify(map)}` : '';
}

const appUniqueCache = new WeakMap<App, Record<string, string[]>>();

/**
 * form (or child table) → Creator unique fields the store does not enforce, from the
 * schema plan (`appUnique`: over Data Store's unique varchar limit per table). The
 * runtime checks them before a live insert or update.
 */
export function appUniqueColumnsOf(app: App, schema?: SchemaPlan): Record<string, string[]> {
  const from = (plan: SchemaPlan): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const table of plan.tables) {
      if (table.nosql || table.role === 'junction') continue;
      const key = table.role === 'form' ? table.form : table.name;
      const names = table.columns.filter((column) => column.appUnique).map((column) => column.field ?? column.name);
      if (names.length) out[key] = names;
    }
    return out;
  };
  if (schema) return from(schema);
  const cached = appUniqueCache.get(app);
  if (cached) return cached;
  const out = from(schemaOf(app));
  appUniqueCache.set(app, out);
  return out;
}

/** `, appUniqueColumns: {…}` for a generated createRuntime call, or nothing. */
export function appUniqueOption(app: App, schema?: SchemaPlan): string {
  const map = appUniqueColumnsOf(app, schema);
  return Object.keys(map).length ? `, appUniqueColumns: ${JSON.stringify(map)}` : '';
}

/**
 * `, splits: {…}` for a generated createRuntime call, or nothing.
 * Only a form that was actually split is listed, so an unsplit app stays byte-identical.
 * The key is the form link name a handler passes to datastore.insert.
 * A child or junction table is keyed by its physical name so it cannot replace the parent layout.
 */
export function splitsOption(app: App, schema?: SchemaPlan): string {
  const plan = schema ?? schemaOf(app);
  if (!plan.splits?.length) return '';
  const map: Record<string, { base: string; baseColumns: string[]; extensions: { table: string; columns: string[] }[] }> = {};
  for (const split of plan.splits) {
    const base = plan.tables.find((table) => table.name === split.base);
    if (!base) continue;
    const key = base.role === 'form' ? split.form : split.base;
    if (Object.hasOwn(map, key)) continue;
    map[key] = {
      base: split.base,
      baseColumns: base.columns.filter((column) => column.name !== EXTENSION_KEY).map((column) => column.name),
      extensions: split.extensions.map((ext) => ({
        table: ext.name,
        columns: ext.columns.filter((name) => name !== EXTENSION_KEY),
      })),
    };
  }
  return Object.keys(map).length ? `, splits: ${JSON.stringify(map)}` : '';
}

const writeRulesCache = new WeakMap<App, Record<string, IntegrityColumn[]>>();

/**
 * form (or child table) -> the write-rule columns of the generated schema:
 * length, decimal scale, date format, significant digits, and `required` on the
 * Creator-mandatory fields. Keyed like decimalColumnsOf so `datastore.insert(
 * "Form", …)` resolves its table's rules; the runtime and the datastore adapter
 * refuse the same writes the loader does.
 */
export function writeRulesOf(app: App, schema?: SchemaPlan): Record<string, IntegrityColumn[]> {
  const from = (plan: SchemaPlan): Record<string, IntegrityColumn[]> => {
    const out: Record<string, IntegrityColumn[]> = {};
    for (const table of plan.tables) {
      if (table.nosql || table.role === 'junction') continue;
      out[table.role === 'form' ? table.form : table.name] = integrityColumns(table);
    }
    return out;
  };
  if (schema) return from(schema);
  const cached = writeRulesCache.get(app);
  if (cached) return cached;
  const out = from(schemaOf(app));
  writeRulesCache.set(app, out);
  return out;
}

/** `, writeRules: {…}` for a generated createRuntime call, or nothing. */
export function writeRulesOption(app: App, schema?: SchemaPlan): string {
  const map = writeRulesOf(app, schema);
  return Object.keys(map).length ? `, writeRules: ${JSON.stringify(map)}` : '';
}

/** Schema-derived createRuntime fields: decimals, app-unique columns, write rules, and split layouts. */
function schemaRuntimeOptions(app: App, schema?: SchemaPlan): string {
  return `${decimalColumnsOption(app)}${multiLookupsOption(app, schema)}${appUniqueOption(app, schema)}${writeRulesOption(app, schema)}${splitsOption(app, schema)}`;
}

function multiLookupsOption(app: App, schema?: SchemaPlan): string {
  const map: Record<string, Record<string, { table: string; parentColumn: string; valueColumn: string; orderColumn: string }>> = {};
  for (const table of (schema ?? schemaOf(app)).tables) {
    if (table.role !== 'junction') continue;
    const parent = table.columns.find((column) => column.name === 'parent_id');
    const order = table.columns.find((column) => column.name === 'row_order');
    const value = table.columns.find((column) => column.relation && column.name !== parent?.name);
    if (!parent || !order || !value) continue;
    const field = value.field ?? value.name;
    (map[table.form] ??= {})[field] = { table: table.name, parentColumn: parent.name, valueColumn: value.name, orderColumn: order.name };
  }
  return Object.keys(map).length ? `, multiLookups: ${JSON.stringify(map)}` : '';
}

function timeZoneFields(app: App): string {
  const raw = app.settings.find((p) => p.key.toLowerCase() === 'time zone')?.value;
  if (!raw) return '';
  const zone = unquote(raw).trim();
  return zone ? `, settingsTimeZone: ${JSON.stringify(zone)}` : '';
}

export function eventKind(event: string): string {
  const e = event.toLowerCase();
  // A subform row event is a form event on the open page, not a submit or a record delete.
  const row = SUBFORM_ROW_EVENT.exec(e);
  if (row) return `${row[1]}row`;
  if (e.includes('validate')) return 'validate';
  if (e.includes('success')) return 'success';
  // `on update of <Field>` is the edit-screen sibling of `on user input of
  // <Field>`: it fires on a field change, not on a submit.
  if (e.includes('user input') || /^on update of\b/.test(e)) return 'input';
  if (e.includes('load')) return 'load';
  if (e.includes('click')) return 'click';
  if (e.includes('delete')) return 'delete';
  if (e.includes('add') || e.includes('edit') || e.includes('submit') || e.includes('update') || e.includes('create')) return 'submit';
  return 'handler';
}

/** `on add row of Sub` / `on delete row of Sub`, anywhere in a combined event name. */
const SUBFORM_ROW_EVENT = /\bon (add|delete) row of\b/;

/**
 * Persist system columns only once the record is being saved.
 * On validate / load / user input the row is not stored yet, so Added_User
 * is not invented there. A subform row event (on add row, on delete row) is a
 * form event while the record is being entered, listed beside On Load and On
 * User Input and apart from On Validate / On Success
 * (deluge-docs/pages/miscellaneous__access-subform-fields.html): it never
 * persists, so it is not an insert. On add the server sets Added_*. On edit it loads the
 * stored row and copies Added_*, then sets Modified_*.
 */
function systemWriteKind(w: Workflow): 'insert' | 'update' | 'add-or-edit' | null {
  const event = w.event.toLowerCase();
  if (SUBFORM_ROW_EVENT.test(event)) return null;
  if (/\b(validate|load|click|user input|delete)\b/.test(event)) return null;
  const record = (w.recordEvent ?? '').toLowerCase();
  const blob = `${record} ${event}`;
  if (!/\b(success|add|edit|submit|update|create)\b/.test(blob)) return null;
  if (record === 'on add or edit') return 'add-or-edit';
  if (record === 'on edit' || (/\bon edit\b/.test(blob) && !/\badd\b/.test(record))) return 'update';
  if (record === 'on add' || record === 'on create' || /\b(success|add|create|submit)\b/.test(blob)) return 'insert';
  if (/\b(edit|update)\b/.test(blob)) return 'update';
  return null;
}

function systemStampSource(kind: 'insert' | 'update' | 'add-or-edit' | null): string {
  if (!kind) return '';
  // writeLive sets ctx.persisted after the row is stored. A second stamp would
  // replace Added_Time with a later clock than the inserted row. `||` keeps a
  // gapped handler free of `if`, which is how an omitted action guard is told apart.
  if (kind === 'insert') return 'ctx.persisted || shim.record.stamp(ctx, "insert");';
  if (kind === 'update') return 'ctx.persisted || await shim.record.prepare(ctx, formName, "update");';
  return 'ctx.persisted || await shim.record.prepare(ctx, formName);';
}

/**
 * Validate handlers in the same form directory whose server body actually
 * writes fields, split by the record event they run under. `on delete`
 * validates belong to the delete path, never to a submit.
 */
export function validateSiblingSpecs(app: App, form: string): { add: string[]; edit: string[] } {
  const group = handlerGroup(app, form, 'validate').filter((other) => !systemWriteKind(other));
  const add: string[] = [];
  const edit: string[] = [];
  if (!group.length) return { add, edit };
  const spec = `./${handlerLeaf(handlerGroup(app, form, 'validate'))}.mjs`;
  let hasServer = false;
  let coversAdd = false;
  let coversEdit = false;
  for (const other of group) {
    const translated = other.deluge ? translateInApp(app, other.deluge.text) : emptyTranslate();
    const guarded = gateAction(app, other, translated, []);
    if (guarded.server.trim()) hasServer = true;
    const scope = recordScope(other);
    if (scope === 'add' || scope === 'both') coversAdd = true;
    if (scope === 'edit' || scope === 'both') coversEdit = true;
  }
  // Unscoped and `on add or edit` validates run in both contexts.
  if (hasServer) {
    if (coversAdd) add.push(spec);
    if (coversEdit) edit.push(spec);
  }
  return { add, edit };
}

/**
 * The deploy-mode helpers shared by every live-capable generated module:
 * `C2C_DEPLOY_MODE` overrides `c2c-deploy.json`; a live run uses the injected
 * datastore (request-scoped `c2c-store.mjs`, else the `__c2cDatastore` global
 * a job or test installs). `dir` is the relative path from the module's own
 * directory up to the function root (`"../../"` under `functions/aio/<form>`,
 * `"../"` under `functions/<group>`).
 */
function liveHelpers(dir: string): string {
  return `function modeOverride() {
  const value = typeof process !== "undefined" && process.env ? process.env.C2C_DEPLOY_MODE : undefined;
  return value === "live" || value === "dry-run" ? value : "";
}

function deployConfig() {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(`${dir}c2c-deploy.json`)});
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const mode = modeOverride() || (parsed && parsed.mode === "live" ? "live" : "dry-run");
    const appTimeZone = parsed && typeof parsed.appTimeZone === "string" ? parsed.appTimeZone : "";
    return { mode, appTimeZone };
  } catch (err) {
    return { mode: modeOverride() || "dry-run", appTimeZone: "" };
  }
}

async function liveDatastore() {
  try {
    const mod = await import(${JSON.stringify(`${dir}c2c-store.mjs`)});
    if (mod && typeof mod.getDatastore === "function") {
      const stored = mod.getDatastore();
      if (stored) return stored;
    }
  } catch (err) {
    /* store module is absent when this file is loaded alone */
  }
  try {
    if (globalThis.__c2cDatastore) return globalThis.__c2cDatastore;
  } catch (err) {
    /* no injected global */
  }
  return null;
}`;
}

/**
 * Live helpers plus the record-event-scoped validate sibling lists. Creator
 * runs only the validates whose record event matches the write: `on add` and
 * unscoped when inserting, `on edit` and unscoped when updating, and for an
 * `add or edit` write the request's ROWID picks the context.
 */
function aioLiveHelpers(validateSpecs: { add: string[]; edit: string[] }, pick: 'add' | 'edit' | 'either', writeLive: string): string {
  const pickBody =
    pick === 'add' ? 'return validateAdd;' : pick === 'edit' ? 'return validateEdit;' : 'return rowId ? validateEdit : validateAdd;';
  return `const validateAdd = ${JSON.stringify(validateSpecs.add)};
const validateEdit = ${JSON.stringify(validateSpecs.edit)};
function validateSpecsFor(rowId) {
  ${pickBody}
}

${liveHelpers('../../')}

function insertedRow(result) {
  if (Array.isArray(result)) {
    const row = result[0];
    return row && typeof row === "object" ? row : null;
  }
  if (!result || typeof result !== "object") return null;
  if (Array.isArray(result.rows) && result.rows[0] && typeof result.rows[0] === "object") return result.rows[0];
  if (Array.isArray(result.data) && result.data[0] && typeof result.data[0] === "object") return result.data[0];
  if (result.ROWID != null || result.ID != null || result.id != null) return result;
  return null;
}

function mergeInserted(record, result) {
  const row = insertedRow(result);
  if (!row) return;
  const raw = row.ROWID != null && row.ROWID !== "" ? row.ROWID : row.ID != null && row.ID !== "" ? row.ID : row.id;
  if (raw != null && raw !== "") {
    const id = String(raw);
    record.ID = id;
    record.ROWID = id;
  }
  const system = ["Added_User", "Added_Time", "Modified_User", "Modified_Time"];
  for (const key of system) {
    if (row[key] != null && row[key] !== "") record[key] = row[key];
  }
  const keys = Object.keys(row).sort();
  for (const key of keys) {
    if (key === "ROWID" || key === "ID" || key === "id") continue;
    if (!Object.prototype.hasOwnProperty.call(record, key)) record[key] = row[key];
  }
}

${writeLive}`;
}

const INVOKEURL_CALL = 'shim.http.invokeurl(ctx, {';

/**
 * For each emitted `shim.http.invokeurl(ctx, { ... })`, whether its request map
 * has a top-level `"connection":` key. The map is scanned to its closing brace
 * (nested maps, arrays, calls and string literals skipped), so a key after a
 * nested `parameters`/`headers` map is still seen.
 */
function invokeurlConnections(body: string): boolean[] {
  const calls: boolean[] = [];
  for (let at = body.indexOf(INVOKEURL_CALL); at >= 0; at = body.indexOf(INVOKEURL_CALL, at + 1)) {
    let depth = 0;
    let connection = false;
    for (let i = at + INVOKEURL_CALL.length - 1; i < body.length; i += 1) {
      const ch = body[i]!;
      if (ch === '"' || ch === "'" || ch === '`') {
        const start = i;
        for (i += 1; i < body.length && body[i] !== ch; i += 1) if (body[i] === '\\') i += 1;
        if (depth === 1 && ch === '"' && body.startsWith('connection":', start + 1)) connection = true;
      } else if (ch === '{' || ch === '[' || ch === '(') depth += 1;
      else if (ch === '}' || ch === ']' || ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(connection);
  }
  return calls;
}

/** The handler calls another Zoho service (`zoho.<svc>.<task>` or invokeurl with `connection:`). */
function usesZohoConnections(body: string): boolean {
  return body.includes('shim.zoho.task(') || invokeurlConnections(body).some((c) => c);
}

/** The handler calls invokeurl without `connection:` (a third-party URL). */
function usesOutboundInvokeurl(body: string): boolean {
  return invokeurlConnections(body).some((c) => !c);
}

/** The handler calls the legacy `getUrl` task (a third-party GET, same allowlist as invokeurl). */
function usesOutboundGetUrl(body: string): boolean {
  return body.includes('shim.http.getUrl(');
}

/**
 * c2c-deploy.json `outboundHosts`: the only hosts a live invokeurl without
 * `connection:` or a live `getUrl` may call (shims/outbound.ts; missing means
 * none). A caller's Idempotency-Key header seeds the keys sent downstream.
 */
function outboundLiveHelpers(dir = '../../'): string {
  return `function outboundConfig(req) {
  const header = req && req.headers ? req.headers["idempotency-key"] : undefined;
  const idempotencySeed = typeof header === "string" && header ? header : null;
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(`${dir}c2c-deploy.json`)});
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const hosts = parsed && Array.isArray(parsed.outboundHosts) ? parsed.outboundHosts.filter((h) => typeof h === "string") : [];
    return { allowHosts: hosts, idempotencySeed };
  } catch (err) {
    return { allowHosts: [], idempotencySeed };
  }
}`;
}

/**
 * Catalyst Connections for the runtime. c2c-deploy.json `zohoDc` (or
 * C2C_ZOHO_DC), `connections` (Creator link → Catalyst connection name) and
 * `orgInternal` (the only live Cliq/mail destinations). The owner approval
 * token comes from C2C_OWNER_APPROVAL_TOKEN, never a file. Credentials come
 * from functions/c2c-connections.mjs only in live mode.
 */
function connectionsLiveHelpers(dir = '../../'): string {
  return `function deployConnections() {
  const fromEnv = process.env.C2C_ZOHO_DC || null;
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(`${dir}c2c-deploy.json`)});
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const zohoDc = fromEnv || (parsed && typeof parsed.zohoDc === "string" && parsed.zohoDc ? parsed.zohoDc : null);
    const connections = parsed && parsed.connections && typeof parsed.connections === "object" && !Array.isArray(parsed.connections) ? parsed.connections : {};
    const orgInternal = parsed && parsed.orgInternal && typeof parsed.orgInternal === "object" && !Array.isArray(parsed.orgInternal) ? parsed.orgInternal : null;
    return { zohoDc, connections, orgInternal };
  } catch (err) {
    return { zohoDc: fromEnv, connections: {}, orgInternal: null };
  }
}

async function zohoConnections(req, live) {
  const config = deployConnections();
  let credentials = null;
  if (live) {
    try {
      const mod = await import(${JSON.stringify(`${dir}c2c-connections.mjs`)});
      if (mod && typeof mod.connectionCredentials === "function") credentials = mod.connectionCredentials(req);
    } catch (err) {
      /* connections module is absent when this file is loaded alone */
    }
  }
  const ownerApprovalToken = process.env.C2C_OWNER_APPROVAL_TOKEN || null;
  return { dc: config.zohoDc, connections: config.connections, orgInternal: config.orgInternal, ownerApprovalToken, ...(credentials ? { credentials } : {}) };
}`;
}

function signalsFor(recordEvent: string | undefined): string[] {
  if (!recordEvent) return [];
  const e = recordEvent.toLowerCase();
  const out: string[] = [];
  if (/\b(add|create)\b/.test(e)) out.push('row_inserted');
  if (/\b(edit|update)\b/.test(e)) out.push('row_updated');
  if (/\bdelete\b/.test(e)) out.push('row_deleted');
  return out;
}

function blueprintStart(w: Workflow): string {
  const block = w.blueprint?.start;
  const named = block?.properties.find((p) => p.key.toLowerCase() === 'start stage')?.value;
  return unquote(named ?? '') || unquote(block?.name ?? '') || w.blueprint?.stages[0]?.name || 'Pending';
}

function approverKindName(key: string): 'role' | 'profile' | 'user' | 'field' | 'level' | '' {
  if (/level/i.test(key)) return 'level';
  if (/field/i.test(key)) return 'field';
  if (/role/i.test(key) && !/profile/i.test(key)) return 'role';
  if (/profile/i.test(key)) return 'profile';
  if (/user|approver/i.test(key)) return 'user';
  return '';
}

/**
 * Module path segment for a workflow or function name. Exported so the
 * no-silent-drop audit derives the same file paths the generator puts.
 */
export function slug(s: string): string {
  const x = s
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return x || 'handler';
}

function indent(body: string): string {
  return body
    .split('\n')
    .map((l) => (l.trim() ? `  ${l}` : l))
    .join('\n');
}

function banner(lines: string[]): string {
  const stamped = [...lines, ...toolchainBannerLines()];
  return `/**\n${stamped.map((l) => ` * ${l}`).join('\n')}\n */\n`;
}

function accessLiteral(app: App): string {
  return JSON.stringify(buildAccessPolicy(app));
}

function callerGate(error: string): string {
  return `  const principal = principalFromRequest(req);
  if (!principal) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: ${JSON.stringify(error)} }, jsonReplacer));
    return;
  }`;
}

function denyBody(fallback: string): string {
  return `    const denied = err && err.code === "RECORD_ACCESS_DENIED";
    res.writeHead(denied ? 403 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: denied ? err.message : ${JSON.stringify(fallback)}, slots: null }, jsonReplacer));`;
}

/**
 * Creator predefined permission set for a profile that has no ModulePermissions.
 * Profiles that list modules keep those grants. A custom profile with no modules
 * is not an implicit allow. `App User` and `App Administrator` are Catalyst clone
 * targets, not profile names invented here.
 */
export type ProfilePreset = 'administrator' | 'write' | 'read' | 'portal-add';

export function profilePreset(profile: Profile): ProfilePreset | undefined {
  if (profile.modules.length > 0) return undefined;
  const name = profile.name.trim();
  const type = profile.type ?? '';
  const description = profile.description ?? '';
  if (/^administrator$/i.test(name)) return 'administrator';
  if (/^write$/i.test(name)) return 'write';
  if (/^read$/i.test(name)) return 'read';
  if (/all the permissions/i.test(description)) return 'administrator';
  if (/write permission for all components/i.test(description)) return 'write';
  if (/read permission for all components/i.test(description)) return 'read';
  if (/customer_portal/i.test(type) && /only add and view/i.test(description)) return 'portal-add';
  return undefined;
}

/** Profile and role policy consumed by shims/access.ts. Same object the handlers embed. */
export function accessPolicyFor(app: App): AccessPolicy {
  return buildAccessPolicy(app);
}

function buildAccessPolicy(app: App): AccessPolicy {
  const reports = new Map<string, { form: string; criteria?: Criteria }>();
  for (const report of app.reports) {
    if (!report.form) continue;
    const entry: { form: string; criteria?: Criteria } = { form: report.form };
    if (report.criteria?.trim()) entry.criteria = reportCriteria(report.criteria, app.functions);
    reports.set(report.name, entry);
  }
  const profiles: AccessPolicy['profiles'] = {};
  const hierarchy = new Set(roleHierarchyForms(app));
  for (const profile of app.profiles) {
    const forms: Record<string, FormGrant> = {};
    const portal = /portal/i.test(profile.type ?? '');
    for (const mod of profile.modules) {
      // Owner sharing applies to every form of a portal profile, and to the
      // forms an internal profile shares through the role hierarchy.
      const shared = portal || hierarchy.has(mod.component);
      const grant = grantFor(app, mod, reports, shared);
      if (grant) forms[mod.component] = grant;
    }
    const preset = profilePreset(profile);
    if (preset) {
      // Same split as auth presetCrud: only Administrator may delete.
      const write = preset !== 'read';
      const canDelete = preset === 'administrator';
      for (const form of app.forms) {
        const grant: FormGrant = {};
        if (write) grant.write = true;
        if (canDelete) grant.delete = true;
        // The portal default has no View All: a portal user reads and edits
        // only the records they added.
        if (preset === 'portal-add') grant.ownerScope = 'view';
        forms[form.name] = grant;
      }
    }
    profiles[profile.name] = forms;
  }
  const policy: AccessPolicy = { profiles, roles: roleNames(app.roles) };
  const hidden = hiddenComponentNames(app);
  if (hidden.length) policy.hidden = hidden;
  return policy;
}

/** Forms listed in share_settings `role Hierarchy = {...}`: records shared up the role hierarchy. */
function roleHierarchyForms(app: App): string[] {
  const forms = new Set<string>();
  for (const item of app.shareSettings) {
    if (!/^role\s*hierarchy$/i.test(item.key.trim())) continue;
    for (const match of item.value.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) forms.add(match[0]);
  }
  return [...forms].sort(compareEnUs);
}

/** Module flags the function layer reads. Every other `enabled` word is reported. */
const MODELLED_FLAGS = new Set(['create', 'viewall', 'modifyall', 'true', 'false']);

export interface SecurityFidelity {
  /** Counts of profile form grants by rule the generated c2c_api enforces. */
  enforced: {
    profiles: number;
    formGrants: number;
    hiddenFields: number;
    readOnlyFields: number;
    recordFilters: number;
    ownRecordsOnly: number;
    modifyOwnOnly: number;
    addOnly: number;
  };
  /** Rules the export declares that the generated app does not enforce as written. Each starts "not enforced: ". */
  notEnforced: string[];
  /** How an enforced rule differs from Creator. */
  notes: string[];
}

/**
 * Per-app statement of what the generated function layer enforces from the
 * export's profiles, roles and share settings, and what it does not. Nothing
 * here is silent: a rule the port cannot express is listed.
 */
export function securityFidelity(app: App): SecurityFidelity {
  const policy = buildAccessPolicy(app);
  const enforced: SecurityFidelity['enforced'] = {
    profiles: Object.keys(policy.profiles).length,
    formGrants: 0,
    hiddenFields: 0,
    readOnlyFields: 0,
    recordFilters: 0,
    ownRecordsOnly: 0,
    modifyOwnOnly: 0,
    addOnly: 0,
  };
  const restricted: string[] = [];
  const untranslatedFilters: string[] = [];
  for (const profile of Object.keys(policy.profiles).sort(compareEnUs)) {
    const forms = policy.profiles[profile]!;
    for (const form of Object.keys(forms).sort(compareEnUs)) {
      const grant = forms[form]!;
      enforced.formGrants++;
      const formFields = app.forms.find((item) => item.name === form)?.fields.length ?? 0;
      if (grant.fields) enforced.hiddenFields += Math.max(0, formFields - grant.fields.length);
      if (grant.writable) {
        const readable = grant.fields ?? app.forms.find((item) => item.name === form)?.fields.map((field) => field.name) ?? [];
        enforced.readOnlyFields += readable.filter((name) => !grant.writable!.includes(name)).length;
      }
      if (grant.recordFilter) {
        if (criteriaHasTodo(grant.recordFilter)) untranslatedFilters.push(`${profile}/${form}`);
        else enforced.recordFilters++;
      }
      if (grant.ownerScope === 'view') enforced.ownRecordsOnly++;
      if (grant.ownerScope === 'modify') enforced.modifyOwnOnly++;
      if (grant.read === false) enforced.addOnly++;
      if (grant.fields || grant.writable || grant.recordFilter || grant.ownerScope || grant.read === false) restricted.push(`${profile}/${form}`);
    }
  }
  const notEnforced: string[] = [];
  const notes: string[] = [];
  const hierarchyForms = roleHierarchyForms(app);
  if (hierarchyForms.length) {
    notEnforced.push(
      `not enforced: role-hierarchy record sharing up the hierarchy on ${hierarchyForms.join(', ')}. A Creator role also sees the records of the roles below it; a signed-in user carries a Catalyst role mapped to a profile, never a Creator role, so without View All a user sees only their own records there.`,
    );
  } else if (roleNames(app.roles).length) {
    notEnforced.push(
      `not enforced: Creator role hierarchy (${roleNames(app.roles).length} roles). Roles become Catalyst roles, but no record is shared up the hierarchy.`,
    );
  }
  if (restricted.length) {
    notEnforced.push(
      `not enforced at the Data Store: hidden and read-only fields, record filters, owner scope and add-only grants hold only through c2c_api (${restricted.length} profile/form grants: ${restricted.sort(compareEnUs).join(', ')}). Catalyst table permissions are per table and role with no field or row rule; a role given direct table access from a client reads past them.`,
    );
  }
  if (untranslatedFilters.length) {
    notEnforced.push(
      `not enforced as written: the report record filter did not migrate for ${untranslatedFilters.sort(compareEnUs).join(', ')}. Reads of those forms are refused for that profile instead.`,
    );
  }
  const flagUses = new Map<string, Set<string>>();
  for (const profile of app.profiles) {
    for (const mod of profile.modules) {
      for (const flag of enabledFlags(mod)) {
        if (MODELLED_FLAGS.has(flag)) continue;
        if (!flagUses.has(flag)) flagUses.set(flag, new Set());
        flagUses.get(flag)!.add(profile.name);
      }
    }
    const raw = profile.permissions ?? '';
    for (const key of ['PIIAccess', 'ePHIAccess']) {
      if (new RegExp(`${key}\\s*:\\s*false`, 'i').test(raw)) {
        notEnforced.push(`not enforced: ${key} false for profile ${profile.name}. Personal-data fields are not hidden by it.`);
      }
    }
  }
  if (flagUses.size) {
    const list = [...flagUses.entries()]
      .sort((a, b) => compareEnUs(a[0], b[0]))
      .map(([flag, profiles]) => `${flag} (${[...profiles].sort(compareEnUs).join(', ')})`);
    notEnforced.push(
      `not enforced: module permission flags ${list.join('; ')}. Tab is menu placement only; export and import follow the View and Create grants; comment and report-builder flags have no generated endpoint.`,
    );
  }
  // Field rules. An unconditional hide or disable is static — the covered
  // record event never renders the field writable, so authorizeWrite refuses
  // it. A conditional rule depends on sibling field values (client state) and
  // stays client-side; it is counted here, never silently trusted.
  let staticRuleDenials = 0;
  let conditionalRules = 0;
  for (const form of app.forms) {
    staticRuleDenials += fieldRuleDenials(app, form.name).length;
    conditionalRules += conditionalFieldRules(app, form.name);
  }
  if (staticRuleDenials) {
    notes.push(
      `${staticRuleDenials} field${staticRuleDenials === 1 ? ' is' : 's are'} unconditionally hidden or disabled by field rules and refused by authorizeWrite: a client in the covered record event could not have posted ${staticRuleDenials === 1 ? 'it' : 'them'}.`,
    );
  }
  if (conditionalRules) {
    notEnforced.push(
      `not enforced server-side: ${conditionalRules} conditional field rule${conditionalRules === 1 ? '' : 's'} (hide/show/enable/disable gated on a sibling field value). The clients apply them; authorizeWrite cannot evaluate the condition without client state, so those fields stay writable through c2c_api.`,
    );
  }
  if (app.workflows.some((w) => w.blueprint)) {
    notEnforced.push(
      'not enforced: per-stage field masking. The export model carries no stage-keyed field visibility, so a field masked at a blueprint stage stays writable.',
    );
  }
  if (enforced.ownRecordsOnly || enforced.modifyOwnOnly) {
    notes.push(
      'On a portal profile, and on a form shared through the role hierarchy, a View grant without View All reads, edits and deletes only the rows the caller added; View All without Modify All reads every granted row and edits or deletes only the caller\'s own. The customer-portal default profile ("only add and view") has no View All.',
    );
    notes.push(
      `Record owner is Added_User, set on insert to the signed-in user's login (email). A row imported from Creator keeps its Creator Added_User value, so a user owns an imported row only when that value is their login.`,
    );
    notes.push(
      'Deluge scripts read under the caller\'s scope, including the owner scope; Creator runs scripts without the user\'s record permissions. A script update or delete finds rows under the read scope, not Modify All.',
    );
  }
  return { enforced, notEnforced, notes };
}

function hiddenComponentNames(app: App): string[] {
  const visible = new Set<string>();
  const hidden = new Set<string>();
  for (const section of app.sections) {
    for (const component of section.components) {
      if (!component.name) continue;
      if (section.hidden) hidden.add(component.name);
      else visible.add(component.name);
    }
  }
  return [...hidden].filter((name) => !visible.has(name)).sort();
}

function verbsOf(mod: ModulePermission): Set<string> {
  const words = new Set<string>();
  for (const report of mod.reports) {
    for (const match of report.value.matchAll(/[A-Za-z]+/g)) words.add(match[0].toLowerCase());
  }
  return words;
}

function flagTrue(value: string | undefined): boolean {
  return /^"?true"?$/i.test((value ?? '').trim());
}

function writableNames(app: App, mod: ModulePermission, fields: string[] | undefined): string[] | undefined {
  const readonly = new Set(mod.fields.filter((field) => flagTrue(field.flags.readonly)).map((field) => field.field));
  if (fields) return fields.filter((name) => !readonly.has(name));
  if (readonly.size === 0) return undefined;
  const formFields = app.forms.find((form) => form.name === mod.component)?.fields.map((field) => field.name);
  if (!formFields) return [];
  return formFields.filter((name) => !readonly.has(name));
}

function roleNames(roles: App['roles']): string[] {
  const names: string[] = [];
  for (const role of roles) {
    names.push(role.name);
    names.push(...roleNames(role.children));
  }
  return names;
}

/**
 * Words of a module's `enabled` list: Create, Viewall, Modifyall, Import,
 * Export, Tab, ... lowercased.
 */
function enabledFlags(mod: ModulePermission): Set<string> {
  const value = mod.properties.find((p) => p.key.toLowerCase() === 'enabled')?.value ?? '';
  return new Set([...value.matchAll(/[A-Za-z_]+/g)].map((match) => match[0].toLowerCase()));
}

/**
 * One form grant from a profile's module permission.
 *
 * - Create (module flag, or an add/create/import report verb) allows insert.
 * - Edit (report verb) allows update; Delete (report verb) allows delete.
 * - Owner sharing (`ownerShared`: a portal profile, or a form the role
 *   hierarchy shares): without View All a View report reads only the
 *   caller's own rows (ownerScope "view"); View All without Modify All edits
 *   and deletes only the caller's own rows (ownerScope "modify"). View All
 *   shows every record even when the role hierarchy is on. Other forms of
 *   an internal profile read every row the report filters allow.
 * - Create with no View and no View All is an add-only grant: read is false.
 */
function grantFor(
  app: App,
  mod: ModulePermission,
  reports: Map<string, { form: string; criteria?: Criteria }>,
  ownerShared: boolean,
): FormGrant | undefined {
  const flags = enabledFlags(mod);
  const viewAll = flags.has('viewall');
  const modifyAll = flags.has('modifyall');
  const granted = mod.reports.filter((report) => /(?:^|[^A-Za-z])view(?:[^A-Za-z]|$)/i.test(report.value));
  const known = granted
    .map((report) => reports.get(report.key))
    .filter((report): report is { form: string; criteria?: Criteria } => !!report && report.form === mod.component);
  const verbs = verbsOf(mod);
  // Write verbs match crudFor's INSERT and UPDATE rows. `delete` is not one of them.
  const canEdit = ['edit', 'update'].some((verb) => verbs.has(verb));
  // A boolean `enabled = true` names no Create flag: add follows the write verbs.
  const booleanForm = flags.size === 1 && flags.has('true');
  const canCreate = flags.has('create') || ['add', 'create', 'import'].some((verb) => verbs.has(verb)) || (booleanForm && canEdit);
  const fields = fieldGrant(app, mod);
  if (!viewAll && known.length === 0) {
    if (!canCreate) return undefined;
    const addOnly: FormGrant = { read: false, write: true, edit: false };
    if (fields !== undefined) addOnly.fields = fields;
    const writable = writableNames(app, mod, fields);
    if (writable) addOnly.writable = writable;
    return addOnly;
  }
  const grant: FormGrant = {};
  if (fields !== undefined) grant.fields = fields;
  const unfiltered = known.some((report) => !report.criteria);
  if (!viewAll && !unfiltered) {
    const filters = known.map((report) => report.criteria).filter((criteria): criteria is Criteria => !!criteria);
    const combined = combineFilters(filters);
    if (combined) grant.recordFilter = combined;
  }
  if (canCreate || canEdit) {
    grant.write = true;
    if (!canCreate) grant.create = false;
    if (!canEdit) grant.edit = false;
    const writable = writableNames(app, mod, fields);
    if (writable) grant.writable = writable;
  }
  if (verbs.has('delete')) grant.delete = true;
  if (ownerShared) {
    if (!viewAll) grant.ownerScope = 'view';
    else if (!modifyAll && (canEdit || grant.delete)) grant.ownerScope = 'modify';
  }
  return grant;
}

function fieldGrant(app: App, mod: ModulePermission): string[] | undefined {
  const flag = (key: string) => mod.properties.find((p) => p.key.toLowerCase() === key)?.value.trim() ?? '';
  const allVisible = /^"?true"?$/i.test(flag('allfieldsvisible'));
  const allHidden = /^"?false"?$/i.test(flag('allfieldsvisible'));
  const hidden = new Set(
    mod.fields.filter((field) => /^"?false"?$/i.test((field.flags.visibility ?? '').trim())).map((field) => field.field),
  );
  const shown = mod.fields.filter((field) => field.flags.visibility !== undefined && !hidden.has(field.field)).map((field) => field.field);
  if (allVisible && hidden.size === 0) return undefined;
  const formFields = app.forms.find((form) => form.name === mod.component)?.fields.map((field) => field.name);
  if (allVisible && formFields) return formFields.filter((name) => !hidden.has(name));
  if (shown.length > 0) return shown;
  if (allVisible || allHidden || mod.fields.length > 0) return [];
  return undefined;
}

function combineFilters(filters: Criteria[]): Criteria | undefined {
  if (filters.length === 0) return undefined;
  if (filters.some((filter) => criteriaHasTodo(filter))) return { op: 'todo', construct: 'report-criteria' };
  if (filters.length === 1) return filters[0];
  return { op: 'or', args: filters };
}

function limitsModule(): string {
  return `${banner([
    'Catalyst limits the generated code relies on.',
    `varchar max ${LIMITS.varcharMaxLength} (Catalyst truncates silently; the shim does not).`,
    `insertRows / updateRows: ${LIMITS.insertRowsPerCall} per call.`,
    `ZCQL: ${LIMITS.zcqlRowsPerQuery} rows per query.`,
    'Encrypted text: equality only. Decimal and the FK enum are not invented here.',
    'Job pool names reject "_". Record events use Signals (one event per rule).',
    'Circuits is not available in the IN data centre.',
  ])}export const LIMITS = ${JSON.stringify(LIMITS, null, 2)};
`;
}

/** Matrix ids whose UI widget is read-only. Same set as model.ts READONLY. */
const READONLY_MATRIX = new Set([
  'formula',
  'auto-number',
  'keyword',
  'sentiment',
  'ocr',
  'object-detection',
  'barcode',
  'section',
  'add-notes',
  'prediction',
  'geolocation',
]);

function isReadonlyMatrix(type: string | undefined): boolean {
  const row = fieldTypeRow(type);
  return !!row && READONLY_MATRIX.has(row.id);
}

const NAME_PARTS = ['prefix', 'first_name', 'last_name', 'suffix'] as const;
const ADDRESS_PARTS = [
  'address_line_1',
  'address_line_2',
  'district_city',
  'state_province',
  'postal_code',
  'country',
  'latitude',
  'longitude',
] as const;

function formWriteSchema(app: App, formName: string): { names: string[]; readonlyNames: string[]; fields: WriteField[]; ruleDenied: FieldRuleDenial[] } | undefined {
  const form = app.forms.find((item) => item.name === formName);
  if (!form) return undefined;
  const names: string[] = [];
  const readonlyNames: string[] = [];
  const walk = (fields: Field[]) => {
    for (const field of fields) {
      names.push(field.name);
      if (isReadonlyMatrix(field.type)) readonlyNames.push(field.name);
      if (field.subfields.length) walk(field.subfields);
    }
  };
  walk(form.fields);
  return { names, readonlyNames, fields: form.fields.map(writeField), ruleDenied: fieldRuleDenials(app, formName) };
}

/**
 * Write ops a workflow's record event covers. `on add` is insert only and
 * `on edit` update only; no event, `on add or edit`, or a field rule outside
 * a record context applies to both. A non-write event (`on delete`) covers
 * neither — its rules never run on a form screen, so they deny nothing.
 */
function recordEventOps(recordEvent: string | undefined): readonly WriteOp[] | null {
  const event = (recordEvent ?? '').trim().toLowerCase();
  if (!event || event === 'on add or edit') return ['insert', 'update'];
  if (event === 'on add' || event === 'create') return ['insert'];
  if (event === 'on edit' || event === 'update') return ['update'];
  return null;
}

/**
 * Fields an unconditional field rule hides or disables on this form.
 *
 * Only rules with no criteria are static: the client hides or disables the
 * field in every record the covered event renders, so a posted value for it
 * could not have come from the form. Conditional rules depend on sibling
 * field values — client state the server cannot see — and are not denied
 * here (counted by securityFidelity instead).
 *
 * Order matters: rules run in declaration order on load, and a later
 * unconditional `show`/`enable` cancels an earlier `hide`/`disable` (and the
 * reverse). The last static action touching a field wins, per write op.
 */
export function fieldRuleDenials(app: App, formName: string | undefined): FieldRuleDenial[] {
  const state = new Map<string, { insert?: 'hide' | 'disable' | 'show' | 'enable'; update?: 'hide' | 'disable' | 'show' | 'enable' }>();
  for (const w of app.workflows) {
    if ((w.form ?? '') !== (formName ?? '')) continue;
    const ops = recordEventOps(w.recordEvent);
    if (!ops) continue;
    for (const rule of w.fieldRules ?? []) {
      if (rule.condition?.trim()) continue;
      for (const action of rule.actions) {
        const verb = action.action.trim().toLowerCase();
        if (verb !== 'hide' && verb !== 'show' && verb !== 'enable' && verb !== 'disable') continue;
        for (const target of action.fields) {
          const field = target.trim();
          if (!field) continue;
          const entry = state.get(field) ?? {};
          for (const op of ops) entry[op] = verb;
          state.set(field, entry);
        }
      }
    }
  }
  const out: FieldRuleDenial[] = [];
  for (const [field, entry] of [...state.entries()].sort((a, b) => compareEnUs(a[0], b[0]))) {
    const verbs = new Map<'hide' | 'disable', { insert: boolean; update: boolean }>();
    for (const op of ['insert', 'update'] as const) {
      const verb = entry[op];
      if (verb !== 'hide' && verb !== 'disable') continue;
      const group = verbs.get(verb) ?? { insert: false, update: false };
      group[op] = true;
      verbs.set(verb, group);
    }
    for (const [action, group] of verbs) {
      out.push({
        field,
        action,
        ...(group.insert && group.update ? {} : { ops: group.insert ? (['insert'] as const) : (['update'] as const) }),
      });
    }
  }
  return out;
}

/** Conditional field rules of one form: dynamic, never server-enforced. */
export function conditionalFieldRules(app: App, formName: string | undefined): number {
  let count = 0;
  for (const w of app.workflows) {
    if ((w.form ?? '') !== (formName ?? '')) continue;
    for (const rule of w.fieldRules ?? []) if (rule.condition?.trim()) count++;
  }
  return count;
}

/**
 * Storage family of a plain leaf field for blank-to-null. Only the
 * canonical typed kinds are marked: name/address parts recurse through
 * writeField, so a decimal latitude/longitude is marked too.
 */
function writeScalar(rowId: string | undefined): WriteScalar | undefined {
  switch (rowId) {
    case 'number':
      return 'number';
    case 'decimal':
    case 'percent':
    case 'currency':
      return 'decimal';
    case 'date':
      return 'date';
    case 'date-time':
      return 'datetime';
    case 'time':
      return 'time';
    default:
      return undefined;
  }
}

function writeField(field: Field): WriteField {
  const readOnly = isReadonlyMatrix(field.type);
  const node: WriteField = { name: field.name, ...(readOnly ? { readOnly: true } : {}) };
  const row = fieldTypeRow(field.type);
  const token = (field.type ?? '').trim().toLowerCase();
  if (field.lookup) {
    node.kind = 'lookup';
    return node;
  }
  if (row && (row.id === 'file-upload' || row.id === 'image' || row.id === 'audio' || row.id === 'video' || row.id === 'signature')) {
    node.kind = 'file';
    return node;
  }
  if (row?.id === 'name' || row?.id === 'address' || token === 'name' || token === 'address') {
    const defaults = row?.id === 'address' || token === 'address' ? ADDRESS_PARTS : NAME_PARTS;
    const parts = field.subfields.length ? field.subfields : defaults.map(partField);
    node.kind = 'composite';
    node.fields = parts.map(writeField);
    return node;
  }
  if (row?.id === 'subform' || token === 'grid' || token === 'subform' || token === 'inline subform') {
    node.kind = 'subform';
    node.fields = field.subfields.map(writeField);
    return node;
  }
  const scalar = writeScalar(row?.id);
  if (scalar) node.scalar = scalar;
  const initial = staticDefault(field.initialValue);
  if (initial !== undefined) node.defaultValue = initial;
  return node;
}

function partField(name: string): Field {
  return {
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
  };
}

function aioModule(opts: {
  app: App;
  form: string;
  title: string;
  path: string;
  recordEvent?: string;
  /** Every record event the merged scripts declared, when they differ. Scanners classify by this list. */
  recordEvents?: string[];
  systemWrite?: 'insert' | 'update' | 'add-or-edit' | null;
  /** `./on-validate.mjs` siblings by record event scope. Imported only after deploy mode is live. */
  validateSpecs?: { add: string[]; edit: string[] };
  body: string;
  /** Sourced schema plan; the embedded write rules match the provisioned store. */
  schema?: SchemaPlan;
  /** Async on-success lane: the live endpoint stores the row and replies; the record trigger runs this script after commit (docs/event-deadletter.md). */
  deferSuccess?: boolean;
}): string {
  const signals = signalsFor(opts.recordEvent);
  const schema = formWriteSchema(opts.app, opts.form);
  const lines = [
    opts.title,
    'Dry run: generated, not deployed.',
    `Advanced I/O POST ${opts.path}`,
    opts.recordEvent ? `Record event: ${opts.recordEvent}.` : 'No record event on this handler.',
  ];
  if (signals.length) {
    lines.push(
      `Signals: ${signals.join(', ')} (one rule per event; Data Store event listeners are deprecated).`,
    );
  } else if (opts.recordEvent) {
    lines.push('No Signals event name mapped from this record event; none is invented.');
  }
  lines.push('The access gate runs before this script: hidden form, op view, and authorizeWrite.');
  lines.push('authorizeWrite rejects a key that is not a writable field at that depth. It does not drop keys.');
  if (schema?.ruleDenied.length) {
    lines.push('authorizeWrite also refuses fields an unconditional field rule hides or disables (fieldRuleDenied). Conditional rules depend on client state and are not enforced here.');
  }
  if (opts.systemWrite) {
    lines.push(
      'After authorizeWrite, the server sets Added_User and Added_Time on insert, and Modified_User and Modified_Time on update. A client value is not copied into those columns. On edit, and on add or edit when body.ROWID names a row, the server loads that row when the caller may modify it and copies stored Added_User and Added_Time onto the record before the script. A row the caller may read but not modify is refused before the script runs. Add versus edit follows that ROWID, never body.op.',
    );
    lines.push(
      'When functions/c2c-deploy.json mode is "live" and a datastore is injected, this handler validates, writes the row, then runs this script. Any other mode does not write. The script sees the inserted row, including ID (the stored ROWID) and system fields. If the script throws after the write, the row stays: a Deluge runtime or refused-connection error reports its text; any other failure replies 500 request failed.',
    );
    lines.push(
      'A live edit captures Catalyst MODIFIEDTIME while preparing the row, then re-reads ROWID/MODIFIEDTIME once immediately before updateRows. A change is refused as c2c code C2C_STALE_WRITE (409). This is c2c\'s stale check and one extra bounded read; Data Store itself has no optimistic lock.',
    );
    lines.push(
      'Creator runs On Success after the record is submitted (https://help.zoho.com/portal/en/kb/creator/developer-guide/workflows/create-and-manage-on-success-action/articles/understand-on-success-action): "The actions that you define in the On success event will be executed when a new record is successfully submitted to the database or when an existing record is updated or deleted from the database." Whether Creator rolls that row back when On Success throws is unverified; this port leaves the row.',
    );
    if (opts.deferSuccess) {
      lines.push(
        'Async on-success opt-in: in live mode this endpoint validates and stores the row, then replies without running the script. The after-commit event function (functions/events/after-commit.mjs) runs it when the record trigger fires; a failure dead-letters to C2CEventDeadLetter for the sweep Job (docs/event-deadletter.md). Dry run still executes the script inline.',
      );
    }
  }
  lines.push('The previous row is loaded on the server. Dry run uses dryRunOld and does not read a client previous row.');
  lines.push('Client tasks for this handler, if any, are in the matching client/handlers module.');
  const schemaExports = schema
    ? `export const fieldNames = ${JSON.stringify(schema.names)};
export const readonlyFields = ${JSON.stringify(schema.readonlyNames)};
export const fields = ${JSON.stringify(schema.fields)};${schema.ruleDenied.length ? `\nexport const fieldRuleDenied = ${JSON.stringify(schema.ruleDenied)};` : ''}
`
    : '';
  // A store write checks the Create or Edit grant: edit when body.ROWID names
  // a row or the handler is edit-only, add otherwise.
  const writeOp = opts.systemWrite
    ? opts.systemWrite === 'update'
      ? '"update"'
      : 'reqRowId ? "update" : "insert"'
    : '';
  const writeCall = schema
    ? `authorizeWrite(access, principal, formName, record, { readonlyFields, fieldNames, fields${schema.ruleDenied.length ? ', ruleDenied: fieldRuleDenied' : ''} }${writeOp ? `, ${writeOp}` : ''})`
    : `authorizeWrite(access, principal, formName, record${writeOp ? `, undefined, ${writeOp}` : ''})`;
  const mailFrom = opts.body.includes('shim.mail.send') ? ', mailFrom: process.env.C2C_MAIL_FROM' : '';
  const subformFields = currentRowFields(opts.body);
  const usesSubformRow = subformFields.length > 0;
  const subformField = subformFields.length === 1 ? subformFields[0]! : `[${subformFields.join(', ')}]`;
  const subformRowCtx = usesSubformRow ? `\n    subformRow: requestSubformRow(req, ${subformField}, accepted),` : '';
  const subformRowHelper = usesSubformRow ? `\n${SUBFORM_ROW_HELPER}` : '';
  const liveImport = opts.systemWrite
    ? `import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
`
    : '';
  const usesConnections = !!opts.systemWrite && usesZohoConnections(opts.body);
  const usesThis = usesThisapp(opts.body);
  const thisappImport = usesThis ? 'import { functions } from "../../thisapp.mjs";\n' : '';
  const usesOutbound = !!opts.systemWrite && usesOutboundInvokeurl(opts.body);
  const usesGetUrl = !!opts.systemWrite && usesOutboundGetUrl(opts.body);
  const storeShape = opts.systemWrite ? fieldStoreShape(opts.app, opts.form) : { links: [], files: [] };
  const validatePick = opts.systemWrite === 'update' ? 'edit' : opts.systemWrite === 'insert' ? 'add' : 'either';
  const liveHelpersBlock = opts.systemWrite ? `\n${aioLiveHelpers(opts.validateSpecs ?? { add: [], edit: [] }, validatePick, writeLiveSource(opts.form, storeShape))}${usesConnections ? `\n${connectionsLiveHelpers()}` : ''}${usesOutbound || usesGetUrl ? `\n${outboundLiveHelpers()}` : ''}\n` : '\n';
  const zoneFields = `${timeZoneFields(opts.app)}${schemaRuntimeOptions(opts.app, opts.schema)}`;
  const runtimeSetup = opts.systemWrite
    ? `  const datastore = loadedStore || (live ? await liveDatastore() : null);
  if (live && !datastore) {
    send(res, 500, { dryRun: false, wrote: false, error: "live datastore is not configured" });
    return;
  }
  const runtime = createRuntime({
    dryRun: !live,
    appTimeZone: process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined${zoneFields}${mailFrom},
    ...(datastore ? { datastore, ...(datastore.now ? { now: datastore.now } : {}) } : {}),
${usesConnections ? '    zohoConnections: await zohoConnections(req, live),\n' : ''}${usesOutbound ? '    ...(live ? { http: outboundHttp(outboundConfig(req)) } : {}),\n' : ''}${usesGetUrl ? '    ...(live ? { httpGetUrl: outboundGetUrl(outboundConfig(req)) } : {}),\n' : ''}    access,${usesThis ? '\n    functions,' : ''}
  });
  // The transcript holds record values, table names and ops. It is a
  // dry-run debug view only: no live reply carries it.
  const debugTranscript = live ? {} : { transcript: runtime.transcript };`
    : `  const runtime = createRuntime({ dryRun: true, appTimeZone: process.env.C2C_APP_TIMEZONE${zoneFields}${mailFrom}, access${usesThis ? ', functions' : ''} });`;
  const successBody = opts.systemWrite
    ? `    if (live) {
      for (const spec of validateSpecsFor(ctx.rowId)) {
        const mod = await import(spec);
        if (mod && typeof mod.handle === "function") await mod.handle(ctx);
      }
      await writeLive(runtime, ctx, formName${fieldStoreWriteArg(storeShape)});
    }
    let result = null;
    try {
      result = ${opts.deferSuccess ? 'live ? { deferred: "after-commit event" } : await handle(ctx)' : 'await handle(ctx)'};
    } catch (err) {
      if (!ctx.persisted) throw err;
      // A store refusal from a post-write script call maps before the
      // generic fail. Catalyst's text never reaches the caller.
      if (replyStoreError(res, err, { live, table: formName, wrote: true })) return;
      const denied = err && err.code === "RECORD_ACCESS_DENIED";
      const refused = err && err.code === "DELETE_REFUSED";
      // Caller-facing texts only: Creator's own Deluge messages and the named
      // live-refused policy denials. Adapter and JS internals stay server-side.
      const reportable = err && (err.code === "DELUGE_RUNTIME" || err.code === "DELUGE_CONVERSION" || err.code === "ZOHO_CONNECTION_REFUSED");
      const message = (denied || refused || reportable) && err && err.message ? err.message : "request failed";
      if (refused) {
        send(res, 422, { dryRun: !live, wrote: true, refused: true, error: message, values: projectReadable(access, principal, formName, ctx.record, Object.keys(accepted)), ...debugTranscript });
        return;
      }
      send(res, denied ? 403 : 500, { dryRun: !live, wrote: true, error: message, values: projectReadable(access, principal, formName, ctx.record, Object.keys(accepted)), ...debugTranscript });
      return;
    }
    send(res, 200, live ? { dryRun: false, wrote: true, values: projectReadable(access, principal, formName, ctx.record, Object.keys(accepted)), result: result ?? null } : { dryRun: true, result: result ?? null, transcript: runtime.transcript });`
    : `    const result = await handle(ctx);
    send(res, 200, { dryRun: true, result: result ?? null, transcript: runtime.transcript });`;
  const deleteRefusal = opts.body.includes('shim.validate.cancelDelete')
    ? `    if (err && err.code === "DELETE_REFUSED") {
      send(res, 422, { dryRun: ${opts.systemWrite ? '!live' : 'true'}, refused: true, error: err.message, ${opts.systemWrite ? '...debugTranscript' : 'transcript: runtime.transcript'} });
      return;
    }
`
    : '';
  // cancel submit in this body or in a validate sibling run before the live write: nothing was written.
  const submitRefusal =
    opts.body.includes('shim.validate.cancelSubmit') ||
    (opts.validateSpecs ? opts.validateSpecs.add.length + opts.validateSpecs.edit.length > 0 : false)
      ? `    if (err && err.code === "SUBMIT_REFUSED") {
      send(res, 422, { dryRun: ${opts.systemWrite ? '!live' : 'true'}, wrote: false, refused: true, error: err.message, ${opts.systemWrite ? '...debugTranscript' : 'transcript: runtime.transcript'} });
      return;
    }
`
      : '';
  const refusal = `${deleteRefusal}${submitRefusal}`;
  const shimNames = opts.systemWrite
    ? ['authorizeRead', 'authorizeWrite', 'applyInitialValues', 'compileCriteria', 'createRuntime', ...(usesGetUrl ? ['outboundGetUrl'] : []), ...(usesOutbound ? ['outboundHttp'] : []), 'principalFromRequest', 'projectFields', 'projectReadable', 'replyStoreError']
    : ['authorizeRead', 'authorizeWrite', 'createRuntime', ...(usesGetUrl ? ['outboundGetUrl'] : []), ...(usesOutbound ? ['outboundHttp'] : []), 'principalFromRequest'];
  for (const name of fieldStoreImports(storeShape)) {
    if (!shimNames.includes(name)) shimNames.push(name);
  }
  const shimImports = shimNames.join(', ');
  return `${banner(lines)}${liveImport}import { ${shimImports} } from "creator-to-catalyst/shims";
import { send, isHidden, requestRowId } from "../_lib.mjs";
${thisappImport}

export const endpoint = { type: "advancedio", method: "POST", path: ${JSON.stringify(opts.path)}, dryRun: true };

export const access = ${accessLiteral(opts.app)};
export const formName = ${JSON.stringify(opts.form)};
export const recordEvent = ${JSON.stringify(opts.recordEvent ?? null)};
${opts.recordEvents ? `export const recordEvents = ${JSON.stringify(opts.recordEvents)};
` : ''}${schemaExports}
${subformRowHelper}${liveHelpersBlock}export async function handle(ctx) {
  const shim = ctx.shim;
${indent(opts.body)}
}

export default async function handler(req, res) {
${opts.systemWrite ? '  const deploy = deployConfig();\n  const live = deploy.mode === "live";\n' : ''}  if (isHidden(access, formName)) {
    send(res, 403, { dryRun: ${opts.systemWrite ? '!live' : 'true'}, error: "hidden form" });
    return;
  }
  const principal = principalFromRequest(req);
  if (!principal?.profile) {
    send(res, 401, { dryRun: ${opts.systemWrite ? '!live' : 'true'}, error: "authenticated caller required" });
    return;
  }
  const reqRowId = requestRowId(req);
${opts.systemWrite === 'update' ? `  if (!reqRowId || !/^\\d+$/.test(reqRowId)) {
    send(res, 400, { dryRun: ${opts.systemWrite ? '!live' : 'true'}, error: "record needs body.ROWID" });
    return;
  }\n` : ''}  const record = req && req.body && req.body.record && typeof req.body.record === "object" && !Array.isArray(req.body.record) ? req.body.record : {};
  let accepted = record;
  let loadedOld = { __c2c: "dry-run-old", loaded: false };
${opts.systemWrite ? `  let loadedStore = null;
  if (reqRowId) {
    try {
      loadedStore = await liveDatastore();
      if (!loadedStore || typeof loadedStore.query !== "function") {
        send(res, 500, { dryRun: !live, error: "live datastore is not configured" });
        return;
      }
      const readScoped = authorizeRead(access, principal, formName, { op: "==", field: "ROWID", value: reqRowId });
      const readWhere = compileCriteria(readScoped.criteria);
      const readRows = await loadedStore.query(formName, readWhere === "true" ? "" : readWhere, 1, 0, "ORDER BY ROWID");
      const row = Array.isArray(readRows) && readRows[0] && typeof readRows[0] === "object" ? projectFields(readRows[0], readScoped.fields) : null;
      if (!row) {
        send(res, 404, { dryRun: !live, error: "no such row" });
        return;
      }
      const modifyScoped = authorizeRead(access, principal, formName, { op: "==", field: "ROWID", value: reqRowId }, undefined, "modify");
      const modifyWhere = compileCriteria(modifyScoped.criteria);
      if (modifyWhere !== readWhere) {
        const modifyRows = await loadedStore.query(formName, modifyWhere === "true" ? "" : modifyWhere, 1, 0, "ORDER BY ROWID");
        const modifiable = Array.isArray(modifyRows) && modifyRows[0] && typeof modifyRows[0] === "object" ? projectFields(modifyRows[0], modifyScoped.fields) : null;
        if (!modifiable) {
          send(res, 403, { dryRun: !live, error: "record access: " + formName + " row is not visible", slots: null });
          return;
        }
        loadedOld = modifiable;
      } else loadedOld = row;
    } catch (err) {
      const denied = err && (err.code === "RECORD_ACCESS_DENIED" || err.name === "RecordAccessError");
      send(res, denied ? 403 : 500, { dryRun: !live, error: denied ? err.message : "request failed" });
      return;
    }
  }\n` : ''}  try {
    if (req && req.body && req.body.op === "view") {
      authorizeRead(access, principal, formName, { op: "true" });
      send(res, 200, { dryRun: ${opts.systemWrite ? '!live' : 'true'}, view: true });
      return;
    }
    accepted = ${writeCall}.values;
  } catch (err) {
    const denied = err && (err.code === "RECORD_ACCESS_DENIED" || err.name === "RecordAccessError");
    send(res, denied ? 403 : 500, { dryRun: ${opts.systemWrite ? '!live' : 'true'}, error: denied ? err.message : "request failed" });
    return;
  }
${runtimeSetup}
  const ctx = runtime.context({
    record: accepted,
    old: loadedOld,
    principal,
    appTimeZone: process.env.C2C_APP_TIMEZONE,
    rowId: reqRowId,${subformRowCtx}
  });
${opts.systemWrite && schema ? '  // API and import inserts never saw the Slate prefill. Absent\n  // fields fall back to their Creator initial values here, so validate\n  // scripts and the row write see the same record as the form path.\n  if (!ctx.rowId && ctx.writeOp !== "update") applyInitialValues(ctx.record, fields);\n' : ''}  try {
${successBody}
  } catch (err) {
${refusal}${opts.systemWrite ? '    // The row write itself failed at the store. Map the refusal\n    // (409/422/400 naming the field) and log it; anything else stays a\n    // sanitized 500.\n    if (replyStoreError(res, err, { live, table: formName, wrote: false })) return;\n    if (err && err.code === "C2C_STALE_WRITE") {\n      send(res, 409, { dryRun: !live, wrote: false, code: "C2C_STALE_WRITE", error: err.message });\n      return;\n    }\n' : ''}    const denied = err && err.code === "RECORD_ACCESS_DENIED";
    send(res, denied ? 403 : 500, { dryRun: ${opts.systemWrite ? '!live' : 'true'}, error: denied ? err.message : "request failed", slots: null, ${opts.systemWrite ? '...debugTranscript' : 'transcript: runtime.transcript'} });
  }
}
`;
}

/** App-local helpers shared by every generated Advanced I/O handler. */
export function aioLibraryModule(): string {
  return `import { jsonReplacer } from "creator-to-catalyst/shims";

export function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, jsonReplacer));
}

export function isHidden(access, name) {
  return !!name && Array.isArray(access.hidden) && access.hidden.includes(name);
}

export function requestRowId(req) {
  const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
  if (!body) return "";
  const id = body.ROWID != null ? body.ROWID : body.rowid;
  if (id == null || typeof id === "object") return "";
  return String(id).trim();
}
`;
}

function clientModule(
  body: string,
  prefetchPath = '',
  meta: { form?: string; event?: string; when?: string; signature?: string; params?: string[]; recordEvent?: string } = {},
): string {
  const params = meta.params ?? [];
  const lines = [
    'PWA client handler. Not server code.',
    'alert, cancel submit, openUrl, info, reload, show/hide/enable/disable/clear, and field :ui tasks.',
  ];
  if (meta.signature) lines.push(`Signature (verbatim): ${meta.signature.replace(/\*\//g, '* /')}`);
  if (params.length) lines.push('The function arguments are the parameters below, in declared order; the prefetch gets them as ctx.args.');
  if (prefetchPath) {
    lines.push(`Server reads used by conditions or loops are loaded once from POST ${prefetchPath}.`);
    lines.push('The condition then runs in the browser against that snapshot. See CLIENT-SPLIT.md.');
  }
  lines.push('Dry run: not deployed.');
  const load = prefetchPath
    ? `${params.length ? `ctx.args = [${params.join(', ')}];\n` : ''}shim.client.touch(ctx);
ctx.prefetchPath = ${JSON.stringify(prefetchPath)};
const prefetched = await shim.client.prefetch(ctx, ${JSON.stringify(prefetchPath)});
if (!prefetched || prefetched.ok !== true || prefetched.nonce !== ctx.formNonce) {
  actions.push({ op: "info", message: (prefetched && prefetched.message) || "Prefetch is stale or failed; client action blocked." });
  return actions;
}
const slots = prefetched.slots;
`
    : '';
  const usesRoundTrip = body.includes('shim.client.element(') || body.includes('shim.client.call(');
  // A refused or failed server round trip throws `c2cElementBlocked`: the run
  // discards the actions already queued, so a failure never leaves partial
  // client actions applied.
  const wrapped = usesRoundTrip
    ? `try {\n${indent(load + body)}\n} catch (err) {\n  if (!err || err.c2cElementBlocked !== true) throw err;\n  actions.length = 0;\n  actions.push({ op: "info", message: (err && err.message) || "Prefetch is stale or failed; client action blocked." });\n  return actions;\n}`
    : load + body;
  return `${banner(lines)}export const c2cHandler = ${JSON.stringify({
    form: meta.form ?? null,
    event: meta.event ?? null,
    when: meta.when ?? null,
    prefetch: prefetchPath || null,
    recordEvent: meta.recordEvent ?? null,
  })};

export async function clientActions(ctx${params.length ? `, ${params.join(', ')}` : ''}) {
  const shim = ctx.shim;
  const actions = [];
${indent(wrapped)}
  return actions;
}
`;
}

function prefetchModule(opts: { app: App; title: string; path: string; body: string; dir?: string; params?: string[]; form?: string; formGrant?: 'read' | 'write'; schema?: SchemaPlan; element?: boolean }): string {
  const subformFields = currentRowFields(opts.body);
  const subformRow = subformFields.length > 0;
  const subformField = subformFields.length === 1 ? subformFields[0]! : `[${subformFields.join(', ')}]`;
  const usesThis = usesThisapp(opts.body);
  const thisappImport = usesThis ? `import { functions } from ${JSON.stringify(`${opts.dir ?? '../'}thisapp.mjs`)};\n` : '';
  const params = opts.params ?? [];
  // A custom function's prefetch reads its parameters from the arguments the client sent.
  const bindArgs = params.length ? `var [${params.join(', ')}] = Array.isArray(ctx.args) ? ctx.args : [];\n` : '';
  // A function's prefetch carries the same gate as the function route: a hidden
  // form answers 403 before auth, and authorizeRead of the function's form runs
  // inside the deny boundary before any server read happens.
  // A form event's prefetch carries the form handler's gate: a caller with no
  // write grant on the form cannot open it for entry, so it is refused with
  // 403 before the runtime is created or any read runs.
  const gated = !!opts.form;
  const formName = gated ? opts.form! : '';
  const writeGate = gated && opts.formGrant === 'write';
  const element = !!opts.element;
  // A client range request names one deferred slot and sends the `range`
  // bounds it evaluated; the endpoint clamps them and runs only that read.
  const usesRange = opts.body.includes('ctx.rangeSlot');
  return `${banner([
    opts.title,
    'Client/server split. Dry run: generated, not deployed.',
    `Advanced I/O POST ${opts.path}`,
    'Runs the server reads a client condition or loop needs, once, and returns { slots }.',
    ...(element ? ['A request that carries body.element { name, value } evaluates that loop element\'s slots only.'] : []),
    writeGate
      ? 'Gate order: hidden form, then authenticated profile, then authorizeWrite of the form — the same grant the form handler requires — before any read.'
      : gated
      ? 'Gate order: hidden form, then authenticated profile, then authorizeRead of the function form — the same gate the function route applies.'
      : 'The caller profile and report record filters are applied before any row or field is returned.',
    ...(usesRange ? ['A `slot`/`range` request serves one deferred read with bounds the client evaluated; the bounds are clamped here, never trusted.'] : []),
    'The response nonce is the form state the slots were computed for. See CLIENT-SPLIT.md.',
    'The previous row is not taken from the client. Dry run uses dryRunOld.',
  ])}import { ${writeGate ? 'authorizeWrite, ' : gated ? 'authorizeRead, ' : ''}createRuntime, jsonReplacer, ${element ? 'LIMITS, ' : ''}principalFromRequest${usesRange ? ', rangeSlotRequest' : ''} } from "creator-to-catalyst/shims";
${thisappImport}
export const endpoint = { type: "advancedio", method: "POST", path: ${JSON.stringify(opts.path)}, dryRun: true };

export const access = ${accessLiteral(opts.app)};
${gated ? `
export const formName = ${JSON.stringify(formName)};

function isHidden(name) {
  return !!name && Array.isArray(access.hidden) && access.hidden.includes(name);
}
` : ''}
${subformRow ? `${SUBFORM_ROW_HELPER}\n` : ''}${params.length || element ? `${REQUEST_ARGS_HELPER}\n` : ''}${element ? `${REQUEST_ELEMENT_HELPER}\n` : ''}export async function prefetch(ctx) {
  const shim = ctx.shim;
  const slots = {};
${indent(bindArgs + opts.body)}
  return slots;
}

export default async function handler(req, res) {
${gated ? `  if (isHidden(formName)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ dryRun: true, error: "hidden form" }, jsonReplacer));
    return;
  }
` : ''}${callerGate('prefetch: authenticated caller required')}${writeGate ? `
  try {
    authorizeWrite(access, principal, formName, {});
  } catch (err) {
${denyBody('prefetch failed')}
    return;
  }` : ''}
  const runtime = createRuntime({ dryRun: true, appTimeZone: process.env.C2C_APP_TIMEZONE${timeZoneFields(opts.app)}${schemaRuntimeOptions(opts.app, opts.schema)}, access${usesThis ? ', functions' : ''} });
  const record = req?.body?.record ?? {};${usesRange ? `
  const rangeReq = rangeSlotRequest(req?.body);
  if (rangeReq.error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: rangeReq.error, slots: null }, jsonReplacer));
    return;
  }` : ''}
  const ctx = runtime.context({
    record,
    old: { __c2c: "dry-run-old", loaded: false },
    principal,
    formNonce: typeof req?.body?.nonce === "string" ? req.body.nonce : undefined,
    appTimeZone: process.env.C2C_APP_TIMEZONE,${subformRow ? `\n    subformRow: requestSubformRow(req, ${subformField}, record),` : ''}${params.length ? `\n    args: requestArgs(req, ${params.length}),` : ''}${element ? `\n    element: requestElement(req),` : ''}${usesRange ? `\n    rangeSlot: rangeReq.slot,\n    rangeFrom: rangeReq.from,\n    rangeTo: rangeReq.to,\n    rangeEmpty: rangeReq.empty === true,` : ''}
  });
  try {
${gated && !writeGate ? '    authorizeRead(access, principal, formName, { op: "true" });\n' : ''}    const slots = await prefetch(ctx);${usesRange ? `
    if (rangeReq.slot && !Object.hasOwn(slots, rangeReq.slot)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "prefetch range: unknown slot", slots: null }, jsonReplacer));
      return;
    }` : ''}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ dryRun: true, slots: ${usesRange ? 'rangeReq.slot ? { [rangeReq.slot]: slots[rangeReq.slot] } : ' : ''}slots, nonce: ctx.formNonce ?? null, transcript: runtime.transcript }, jsonReplacer));
  } catch (err) {
${denyBody('prefetch failed')}
  }
}
`;
}

function jobModule(opts: { app: App; name: string; pool: string; properties: Property[]; body: string; plan: SchedulePlan; schema?: SchemaPlan }): string {
  const cron = opts.plan.kind === 'custom' ? opts.plan.cron : null;
  const sweep = opts.plan.kind === 'form' ? opts.plan.sweep : null;
  // With no app time zone, the schedule's own `time zone` keeps a live run from TimeZoneRequired.
  const scheduleZone = cron?.c2c.timeZone ?? sweep?.timeZone;
  const zoneFields = timeZoneFields(opts.app) || (scheduleZone ? `, settingsTimeZone: ${JSON.stringify(scheduleZone)}` : '');
  const usesConnections = usesZohoConnections(opts.body);
  const usesGetUrl = usesOutboundGetUrl(opts.body);
  const usesThis = usesThisapp(opts.body);
  const thisappImport = usesThis ? 'import { functions } from "../thisapp.mjs";\n' : '';
  const mailFrom = opts.body.includes('shim.mail.send') ? ', mailFrom: process.env.C2C_MAIL_FROM' : '';
  const how = cron
    ? `Catalyst ${cron.cron_type} cron ${cron.cron_name} targets this module (job-scheduling.json).`
    : sweep
      ? `Form schedule: the ${SWEEPER_MODULE} Job fires handle() once per row that came due.`
      : 'No cron: the schedule start or frequency did not convert (see migration-report.json). None is invented.';
  return `${banner([
    `Schedule ${opts.name}`,
    'Catalyst Job function module.',
    how,
    'Creator schedules run as the application, not as a signed-in user.',
    'This file is not an HTTP route. No client can call it.',
    'jobRequest is the scheduler payload, not a request body.',
    'Job pool names cannot contain "_" (console evidence).',
    'Dry run unless deploy mode is live (c2c-deploy.json or C2C_DEPLOY_MODE) and a datastore is configured.',
  ])}${JOB_LIVE_IMPORTS}import { createRuntime${usesGetUrl ? ', outboundGetUrl' : ''} } from "creator-to-catalyst/shims";
${thisappImport}
export const jobPool = ${JSON.stringify(opts.pool)};
export const cron = ${JSON.stringify(cron)};
${sweep ? `export const sweep = ${JSON.stringify(sweep)};
` : ''}export const schedule = ${JSON.stringify(Object.fromEntries(opts.properties.map((p) => [p.key, p.value])), null, 2)};

${usesConnections ? `\n${connectionsLiveHelpers('../')}\n` : ''}${usesGetUrl ? `\n${outboundLiveHelpers('../')}\n` : ''}
export async function handle(ctx) {
  const shim = ctx.shim;
${indent(opts.body)}
}

${jobLiveHelpers()}
export async function run(jobRequest, req) {
  const deploy = deployConfig();
  const live = deploy.mode === "live";
  const datastore = live ? await liveDatastore() : null;
  if (live && !datastore) throw new Error("live datastore is not configured");
  const appTimeZone = process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined;
  const runtime = createRuntime({
    dryRun: !live,
    appTimeZone${zoneFields}${schemaRuntimeOptions(opts.app, opts.schema)}${mailFrom},
    ...(datastore ? { datastore, ...(datastore.now ? { now: datastore.now } : {}) } : {}),${usesConnections ? '\n    zohoConnections: await zohoConnections(jobRequest ?? null, live),' : ''}${usesGetUrl ? '\n    ...(live ? { httpGetUrl: outboundGetUrl(outboundConfig(jobRequest ?? null)) } : {}),' : ''}${usesThis ? '\n    functions,' : ''}
  });
  const ctx = runtime.context({ record: jobRequest ?? {}, appTimeZone });
  return { dryRun: !live, result: await handle(ctx), transcript: runtime.transcript };
}

export default async function job(jobRequest, context) {
  return closing(context, () => run(jobRequest, context));
}
`;
}


function machineModule(opts: { app: App; name: string; form?: string; event: string; scripts: { name: string; body: string }[]; machine: Record<string, unknown>; schema?: SchemaPlan; editWorkflows?: { validate: string[]; success: string[] } }): string {
  const schema = opts.form ? formWriteSchema(opts.app, opts.form) : undefined;
  const relativeForm = !!opts.machine.formCriteria && typeof opts.machine.formCriteria === 'object' && criteriaHasRelative(opts.machine.formCriteria as Criteria);
  const usesConnections = opts.scripts.some((s) => usesZohoConnections(s.body));
  const usesGetUrl = opts.scripts.some((s) => usesOutboundGetUrl(s.body));
  const usesThis = opts.scripts.some((s) => usesThisapp(s.body));
  const thisappImport = usesThis ? 'import { functions } from "../thisapp.mjs";\n' : '';
  const mailFrom = opts.scripts.some((s) => s.body.includes('shim.mail.send')) ? ', mailFrom: process.env.C2C_MAIL_FROM' : '';
  const schemaExports = schema
    ? `export const fieldNames = ${JSON.stringify(schema.names)};
export const readonlyFields = ${JSON.stringify(schema.readonlyNames)};
export const fields = ${JSON.stringify(schema.fields)};
`
    : '';
  const scriptDefs = opts.scripts
    .map(
      (script) => `async function script_${jsIdent(script.name)}(ctx) {
  const shim = ctx.shim;
${indent(script.body)}
}`,
    )
    .join('\n\n');
  const scriptMap = `{${opts.scripts.map((script) => `${JSON.stringify(script.name)}: script_${jsIdent(script.name)}`).join(', ')}}`;
  const blueprint = opts.machine.kind === 'blueprint';
  const phaseFields = blueprint && (!!opts.machine.stageFields || (Array.isArray(opts.machine.transitions) && (opts.machine.transitions as { fields?: unknown }[]).some((row) => !!row.fields)));
  const notOwner = blueprint ? 'caller is not an owner of this transition' : 'caller is not an approver for this stage';
  const fieldBanner = phaseFields
    ? [
        'Field settings: machine.stageFields lists, per stage, the visible, hidden,',
        'updatable and read-only fields while a record sits in that stage; a',
        'transition\'s fields list what body.fields may set during it (mandatory',
        'ones must be filled). Any other field answers 400 naming it. The record',
        'read and the edit submit import visibleRecord and stageUpdateError.',
      ]
    : [];
  const fieldHelpers = phaseFields
    ? `const SYSTEM_FIELDS = ["ROWID", "ID", "Added_User", "Added_Time", "Modified_User", "Modified_Time"];

function stageRules(record) {
  const stage = record && typeof record[statusColumn()] === "string" ? record[statusColumn()] : "";
  const all = machine.stageFields && typeof machine.stageFields === "object" ? machine.stageFields : {};
  return { stage, rules: Object.prototype.hasOwnProperty.call(all, stage) ? all[stage] : null };
}

function isFormField(key) {
  return Array.isArray(machine.formFields) && machine.formFields.includes(key) && !SYSTEM_FIELDS.includes(key);
}

function shown(rules, key) {
  if (!rules || !isFormField(key)) return true;
  if (Array.isArray(rules.hidden) && rules.hidden.includes(key)) return false;
  return !Array.isArray(rules.visible) || rules.visible.includes(key);
}

function changeable(rules, key) {
  if (!rules) return true;
  if (!shown(rules, key)) return false;
  if (Array.isArray(rules.readonly) && rules.readonly.includes(key)) return false;
  return !Array.isArray(rules.updatable) || rules.updatable.includes(key);
}

// The record read: drops the fields the stored record's current stage does
// not show. The stage comes from the stored row, never from the projection.
export function visibleRecord(record, stored) {
  if (!record || typeof record !== "object") return record;
  const { rules } = stageRules(stored && typeof stored === "object" ? stored : record);
  if (!rules) return record;
  const out = {};
  for (const key of Object.keys(record)) if (shown(rules, key)) out[key] = record[key];
  return out;
}

// The edit submit: the first submitted field the stored record's stage does
// not let a caller change, as { field, error } for a 400 reply, else "".
export function stageUpdateError(stored, keys) {
  const { stage, rules } = stageRules(stored);
  if (!rules) return "";
  for (const key of Array.isArray(keys) ? keys : []) {
    if (!changeable(rules, key)) return { field: key, error: "field " + key + " is not updatable in stage " + stage };
  }
  return "";
}

// The fields a transition call sets: only the transition's updatable fields,
// and every mandatory one filled. With no field settings no field is set.
// A during list that says which fields show but names no updatable set means
// Creator treats those visible fields as settable during the transition — a
// reject-with-reason transition is the common case — so the visible list is
// the updatable set, minus anything read-only.
function transitionFieldError(row, supplied) {
  const rules = row && row.fields && typeof row.fields === "object" ? row.fields : {};
  const updatable = Array.isArray(rules.updatable) ? rules.updatable : Array.isArray(rules.visible) ? rules.visible : [];
  for (const key of Object.keys(supplied)) {
    if (!updatable.includes(key) || (Array.isArray(rules.readonly) && rules.readonly.includes(key))) {
      return { field: key, error: "field " + key + " is not updatable during transition " + (row.name || "") };
    }
  }
  for (const key of Array.isArray(rules.mandatory) ? rules.mandatory : []) {
    const value = supplied[key];
    if (value == null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length)) {
      return { field: key, error: "field " + key + " is required for transition " + (row.name || "") };
    }
  }
  return "";
}

`
    : '';
  const fieldApply = phaseFields
    ? `
    const supplied = body.fields && typeof body.fields === "object" && !Array.isArray(body.fields) ? body.fields : {};
    const fieldError = transitionFieldError(chosen, supplied);
    if (fieldError) {
      send(res, 400, { dryRun: !live, error: fieldError.error, field: fieldError.field });
      return;
    }
    for (const key of Object.keys(supplied)) record[key] = supplied[key];`
    : '';
  const editWorkflows = opts.editWorkflows ?? { validate: [], success: [] };
  const editWorkflowSource = `// A transition row with workflowStatus === true is an update-fields during
// action whose workflows are on: the save fires the governed form's on-edit
// workflows — On Validate before the field write, On Success after it — and
// the stage changes only once they succeed. The specs are the same modules
// the form's edit submit endpoint uses; a workflow with no server actions
// emits no module, so a missing file means nothing to run.
const EDIT_VALIDATE_SPECS = ${JSON.stringify(editWorkflows.validate)};
const EDIT_SUCCESS_SPECS = ${JSON.stringify(editWorkflows.success)};

async function callEditWorkflow(spec, ctx) {
  let mod;
  try {
    mod = await import(spec);
  } catch (err) {
    if (err && err.code === "ERR_MODULE_NOT_FOUND" && String(err.message || "").includes(spec.slice(3))) return;
    throw err;
  }
  if (mod && typeof mod.handle === "function") await mod.handle(ctx);
}
`;
  return `${banner([
    `State machine ${opts.name}`,
    'Circuits is not available in the IN data centre. No US data centre.',
    'Generated shape: status column + transition history table + Advanced I/O approve, reject, and transition endpoints.',
    'Gate order: hidden form, then authenticated profile, then approver and status.',
    'functions/c2c-deploy.json mode (or C2C_DEPLOY_MODE) decides: "live" loads the',
    'record by body.ROWID through the caller-scoped read, requires it to satisfy',
    'the machine form criteria, validates the transition against its stored',
    'stage, runs the transition script, then writes the status and a history row.',
    'Anything else uses a placeholder stage (body.stage) and records the writes',
    'on the transcript without effects.',
    'body.status is the target stage; approve and reject infer it when only one',
    'transition matches the stored stage. The stored stage, never the body, is the from.',
    'A user, role, profile, or form-field approver must match the principal. A',
    'field approver reads the record field the .ds named; a field that is not a',
    'users field, and a reporting-level approver, deny with that reason. Both are',
    'counted in migration-report.json. They are not silent misses. The literal',
    'deny reasons are "unsupported: form-field approver" and',
    '"unsupported: reporting-level approver".',
    'A transition writes through datastore.writeRow: the machine stage write does',
    'not need the caller edit access the profile form write would require.',
    'SLA timeouts would be Signals or a Job cron; none is created.',
    'The submit handler calls begin() before the row write and commit() after it,',
    'so the first stage and (approvals) the submit history row persist with the record.',
    ...fieldBanner,
  ])}import { authorizeRead, ${relativeForm ? 'bindRelativeCriteria, criteriaHasRelative, ' : ''}createRuntime, jsonReplacer, matchRow, ${usesGetUrl ? 'outboundGetUrl, ' : ''}principalFromRequest, replyStoreError } from "creator-to-catalyst/shims";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
${thisappImport}

export const access = ${accessLiteral(opts.app)};
export const formName = ${JSON.stringify(opts.form ?? '')};
export const endpoint = { type: "advancedio", method: "POST", path: ${JSON.stringify(`/flows/${opts.name}`)}, paths: ["/flows/${opts.name}/approve", "/flows/${opts.name}/reject", "/flows/${opts.name}/transition"] };
${schemaExports}
export const machine = ${JSON.stringify(
    {
      form: opts.form ?? null,
      event: opts.event,
      circuits: false,
      ...(opts.machine as object),
      endpoints: {
        approve: `/flows/${slug(opts.name)}/approve`,
        reject: `/flows/${slug(opts.name)}/reject`,
        transition: `/flows/${slug(opts.name)}/transition`,
      },
    },
    null,
    2,
  )};

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, jsonReplacer));
}

function isHidden(name) {
  return !!name && Array.isArray(access.hidden) && access.hidden.includes(name);
}

function deny(message) {
  const err = new Error(message);
  err.code = "RECORD_ACCESS_DENIED";
  err.name = "RecordAccessError";
  throw err;
}

function listed(value) {
  return String(value || "").split(/[;,]/).map((part) => part.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

function same(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

// A users-field value matches the caller when any of its ids or names do.
// A {id,label} lookup shape compares its scalar members; a list matches any item.
function userValueMatches(value, principal) {
  if (Array.isArray(value)) return value.some((item) => userValueMatches(item, principal));
  if (value && typeof value === "object") {
    return userValueMatches(value.id ?? value.ID ?? value.email ?? value.name ?? value.value, principal);
  }
  return same(value, principal.loginUser) || same(value, principal.userId);
}

function approverDecision(principal, approvers, record) {
  const rows = Array.isArray(approvers) ? approvers : [];
  // No approvers: the transition is open to any caller that passes the gates.
  if (!rows.length) return "";
  let unsupported = "";
  for (const row of rows) {
    if (!row) continue;
    if (row.kind === "unsupported") {
      if (!unsupported) unsupported = row.reason || "unsupported approver";
      continue;
    }
    if (row.kind === "field") {
      if (userValueMatches(record && record[row.value], principal)) return "";
      continue;
    }
    const values = listed(row && row.value);
    if (row.kind === "role" && values.some((value) => same(value, principal.role))) return "";
    if (row.kind === "profile" && values.some((value) => same(value, principal.profile))) return "";
    if (row.kind === "user" && values.some((value) => same(value, principal.loginUser) || same(value, principal.userId))) return "";
  }
  return unsupported || ${JSON.stringify(notOwner)};
}

function statusColumn() {
  return machine.statusColumn || "Status";
}

${fieldHelpers}function placeholder(req) {
  const record = { __c2c: "dry-run-record", loaded: false };
  const supplied = req && req.body && typeof req.body.stage === "string" ? req.body.stage.trim() : "";
  record[statusColumn()] = supplied || machine.currentStatus || machine.start || "";
  return record;
}

function targets(action, record) {
  const stage = record && typeof record[statusColumn()] === "string" ? record[statusColumn()] : "";
  const rows = Array.isArray(machine.transitions) ? machine.transitions : [];
  return rows.filter((row) => row && row.action === action && row.from === stage && row.to);
}

function requestRowId(req) {
  const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
  if (!body) return "";
  const id = body.ROWID != null ? body.ROWID : body.rowid;
  if (id == null || typeof id === "object") return "";
  return String(id).trim();
}

function actorOf(ctx) {
  const p = ctx && ctx.principal;
  return (p && (p.loginUser || p.userId || p.profile)) || "";
}

// The decision comment rides body.comment. The history Comment column is
// VarChar(255), so the text is capped at 255 code points and astral
// characters are never split.
function requestComment(req) {
  const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const raw = typeof body.comment === "string" ? body.comment.trim() : "";
  return Array.from(raw).slice(0, 255).join("");
}

function historyRow(ctx, action, name, from, to, rowId, comment) {
  return {
    Machine: machine.name || ${JSON.stringify(opts.name)},
    Form: machine.form || formName,
    Record_ID: String(rowId || ""),
    Action: action,
    Name: name || "",
    From_Status: from || "",
    To_Status: to || "",
    Actor: actorOf(ctx),
    Comment: comment || "",
  };
}

${liveHelpers('../')}
${usesConnections ? `\n${connectionsLiveHelpers('../')}\n` : ''}${usesGetUrl ? `\n${outboundLiveHelpers('../')}\n` : ''}
${scriptDefs || '// This machine declares no transition scripts.'}
const SCRIPTS = ${scriptMap};
${editWorkflowSource}

// The named export a thisapp registry or a submit handler calls: the script for
// the transition ctx.transition names. Submit sets action "submit" + on_start.
export async function handle(ctx) {
  const script = ctx && ctx.transition && ctx.transition.script;
  const fn = script && SCRIPTS[script];
  return fn ? await fn(ctx) : null;
}

// Submit path, before the row write: the first machine whose form criteria the
// new record satisfies claims it — the record gets the machine start stage and
// the machine's on-start script runs in the same context.
export async function begin(ctx) {
  const record = ctx && ctx.record;
  if (!record || ctx.__c2cFlow || ctx.rowId || ctx.writeOp === "update") return;
  ${relativeForm ? `let formCriteria = machine.formCriteria;
  if (formCriteria && criteriaHasRelative(formCriteria)) {
    try {
      formCriteria = bindRelativeCriteria(formCriteria, ctx.now, ctx.appTimeZone || "");
    } catch {
      return;
    }
  }
  if (formCriteria && !matchRow(record, formCriteria)) return;` : 'if (machine.formCriteria && !matchRow(record, machine.formCriteria)) return;'}
  record[statusColumn()] = machine.start;
  ctx.__c2cFlow = machine.slug;
  ctx.transition = { action: "submit", to: machine.start, script: "on_start" };
  await handle(ctx);
}

// Submit path, after the row write: the history row for the machine that
// claimed the record. ROWID is known only after the insert. Approvals log the
// submit event; a blueprint's start stage is not a transition and is not logged.
export async function commit(ctx) {
  const record = ctx && ctx.record;
  if (!ctx || ctx.__c2cFlow !== machine.slug || !machine.historyTable || machine.submitHistory !== true) return;
  const rowId = ctx.rowId || (record && (record.ROWID || record.ID)) || "";
  await ctx.shim.datastore.insertRow(ctx, machine.historyTable, historyRow(ctx, "submit", "", "", machine.start, rowId));
}

async function run(req, res, action) {
  if (isHidden(formName)) {
    send(res, 403, { dryRun: true, error: "hidden form" });
    return;
  }
  const principal = principalFromRequest(req);
  if (!principal?.profile) {
    send(res, 401, { dryRun: true, error: "authenticated caller required" });
    return;
  }
  const deploy = deployConfig();
  const live = deploy.mode === "live";
  try {
    if (formName) authorizeRead(access, principal, formName, { op: "true" });
    const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const status = typeof body.status === "string" ? body.status : "";
    const datastore = live ? await liveDatastore() : null;
    if (live && !datastore) {
      send(res, 500, { dryRun: false, error: "live datastore is not configured" });
      return;
    }
    const runtime = createRuntime({
      dryRun: !live,
      appTimeZone: process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined${timeZoneFields(opts.app)}${schemaRuntimeOptions(opts.app, opts.schema)}${mailFrom},
      ...(datastore ? { datastore, ...(datastore.now ? { now: datastore.now } : {}) } : {}),
${usesConnections ? '      zohoConnections: await zohoConnections(req, live),\n' : ''}${usesGetUrl ? '      ...(live ? { httpGetUrl: outboundGetUrl(outboundConfig(req)) } : {}),\n' : ''}      access,
      flowHistoryTable: machine.historyTable || undefined,${usesThis ? '\n      functions,' : ''}
    });
    let record;
    let old = { __c2c: "dry-run-old", loaded: false };
    let rowId = "";
    if (live) {
      rowId = requestRowId(req);
      if (!rowId) {
        send(res, 422, { dryRun: false, error: "a live transition needs body.ROWID" });
        return;
      }
      const args = [{ op: "==", field: "ROWID", value: rowId }];
      if (machine.formCriteria) args.push(machine.formCriteria);
      const criteria = args.length > 1 ? { op: "and", args } : args[0];
      const probe = runtime.context({ record: {}, old: {}, principal, appTimeZone: process.env.C2C_APP_TIMEZONE });
      const rows = await probe.shim.datastore.rows(
        probe,
        probe.shim.datastore.query(probe, formName, criteria, { system: true }),
      );
      const row = rows[0];
      if (!row || typeof row !== "object" || !row.values || typeof row.values !== "object") deny("record is not visible to this caller");
      record = row.values;
      old = { ...record };
    } else {
      record = placeholder(req);
    }
    const from = typeof record[statusColumn()] === "string" ? record[statusColumn()] : "";
    const candidates = targets(action, record);
    const validCandidates = [];
    const gated = [];
    const unevaluated = new Set();
    const gateReasons = new Map();
    for (const row of candidates) {
      const gates = Array.isArray(row.conditionScripts) ? row.conditionScripts : [];
      if (!gates.length) {
        validCandidates.push(row);
        continue;
      }
      if (!live) {
        // A dry run has no stored record, so field criteria cannot be
        // evaluated. The transition still runs and the reply says the
        // criteria were not evaluated.
        unevaluated.add(row);
        validCandidates.push(row);
        continue;
      }
      let pass = true;
      for (const gate of gates) {
        const fn = SCRIPTS[gate];
        // A declared condition with no emitted script blocks; it never opens.
        if (!fn) {
          pass = false;
          break;
        }
        let verdict = false;
        try {
          verdict = await fn(runtime.context({ record, old, principal, rowId, appTimeZone: process.env.C2C_APP_TIMEZONE }));
        } catch (gateErr) {
          // A condition that cannot run — it names a field that is not on the
          // form — closes its own gate with its own reason instead of failing
          // the request. Any other condition error still fails the request.
          if (gateErr && (gateErr.code === "RECORD_ACCESS_DENIED" || gateErr.name === "RecordAccessError") && gateErr.message) {
            gateReasons.set(row, String(gateErr.message));
            pass = false;
            break;
          }
          throw gateErr;
        }
        if (!verdict) {
          pass = false;
          break;
        }
      }
      if (pass) validCandidates.push(row);
      else gated.push(row);
    }
    const chosen = status ? validCandidates.find((row) => row.to === status) : validCandidates.length === 1 ? validCandidates[0] : null;
    if (!chosen) {
      // A real transition that failed its criteria is not "no such transition".
      const filtered = status ? gated.some((row) => row.to === status) : candidates.length > 0 && gated.length === candidates.length;
      let reason = filtered ? "transition criteria not met" : "status is not a transition of this stage";
      if (filtered) {
        const blocked = status ? gated.filter((row) => row.to === status) : gated;
        const distinct = Array.from(new Set(blocked.map((row) => gateReasons.get(row)).filter(Boolean)));
        if (distinct.length === 1) reason = distinct[0];
      }
      deny(reason);
    }
    const approverError = approverDecision(principal, chosen.approvers, record);
    if (approverError) deny(approverError);${fieldApply}
    record[statusColumn()] = chosen.to;
    // The newest submit row for this record names its submitter; no submit
    // row leaves it null. The machine's own history-table read does not need
    // the caller to hold a grant on that table.
    let submitter = null;
    if (live && machine.historyTable && machine.event === "approval") {
      const criteria = {
        op: "and",
        args: [
          { op: "==", field: "Form", value: machine.form || formName },
          { op: "==", field: "Record_ID", value: String(rowId || "") },
          { op: "==", field: "Action", value: "submit" }
        ]
      };
      const probe = runtime.context({ record: {}, old: {}, principal, appTimeZone: process.env.C2C_APP_TIMEZONE });
      const rows = await probe.shim.datastore.historyRows(probe, machine.historyTable, criteria, { sort: { field: "ROWID", dir: "desc" }, range: { from: 1, to: 1 } });
      if (rows.length > 0 && rows[0].values.Actor) {
        submitter = rows[0].values.Actor;
      }
    }

    const ctx = runtime.context({
      record,
      old,
      principal,
      rowId: live ? rowId : undefined,
      transition: { action, from, to: chosen.to, level: chosen.level, script: chosen.script },
      approver: { submitter },
      appTimeZone: process.env.C2C_APP_TIMEZONE,
    });
    // update_fields with workflows on: the form's edit-scope On Validate
    // handlers run before any transition script, so a refusal (422) leaves no
    // script side effects.
    if (chosen.workflowStatus === true) {
      for (const spec of EDIT_VALIDATE_SPECS) await callEditWorkflow(spec, ctx);
    }
    const result = await handle(ctx);
    const patch = {};
    for (const key of Object.keys(record)) {
      if (key === "__c2c") continue;
      if (JSON.stringify(record[key]) !== JSON.stringify(old[key])) patch[key] = record[key];
    }
    patch[statusColumn()] = chosen.to;
    if (chosen.workflowStatus === true) {
      // Then the field write, then the edit-scope On Success handlers, and
      // only then the stage write — Creator changes the stage only once the
      // on-edit workflows succeed. Nothing is rolled back when On Success
      // fails: the field write stays and the stage does not move, as in
      // Creator, which saves the record before On Success runs.
      const fieldsPatch = {};
      for (const key of Object.keys(patch)) if (key !== statusColumn()) fieldsPatch[key] = patch[key];
      if (Object.keys(fieldsPatch).length) await ctx.shim.datastore.writeRow(ctx, formName, rowId || "dry-run", fieldsPatch);
      for (const spec of EDIT_SUCCESS_SPECS) await callEditWorkflow(spec, ctx);
      await ctx.shim.datastore.writeRow(ctx, formName, rowId || "dry-run", { [statusColumn()]: chosen.to });
    } else {
      await ctx.shim.datastore.writeRow(ctx, formName, rowId || "dry-run", patch);
    }
    if (machine.historyTable) {
      await ctx.shim.datastore.insertRow(ctx, machine.historyTable, historyRow(ctx, action, chosen.name, from, chosen.to, rowId, requestComment(req)));
    }
    // The after phase runs last, once the stage write has succeeded; any field
    // it sets is written then, never the stage.
    const afterFn = chosen.afterScript && SCRIPTS[chosen.afterScript];
    if (afterFn) {
      const before = { ...record };
      await afterFn(ctx);
      const afterPatch = {};
      for (const key of Object.keys(record)) {
        if (key === "__c2c" || key === statusColumn()) continue;
        if (JSON.stringify(record[key]) !== JSON.stringify(before[key])) afterPatch[key] = record[key];
      }
      if (Object.keys(afterPatch).length) await ctx.shim.datastore.writeRow(ctx, formName, rowId || "dry-run", afterPatch);
    }
    ctx.persisted = true;
    // The transcript is a dry-run debug view only: no live reply carries it.
    // A dry run over a conditional transition says its criteria were not
    // evaluated — there is no stored record to test them against.
    send(res, 200, { dryRun: !live, wrote: live, action, from, status: chosen.to, result: result ?? null, ...(live ? {} : { transcript: runtime.transcript, ...(unevaluated.has(chosen) ? { criteria: "not evaluated in dry run" } : {}) }) });
  } catch (err) {
    // The status/history write failed at the store. Same mapping as
    // the submit handlers; Catalyst's text never reaches the caller.
    if (replyStoreError(res, err, { live, table: formName })) return;
    if (err && err.code === "SUBMIT_REFUSED") {
      send(res, 422, { dryRun: !live, wrote: false, refused: true, error: err.message });
      return;
    }
    const denied = err && (err.code === "RECORD_ACCESS_DENIED" || err.name === "RecordAccessError");
    send(res, denied ? 403 : 500, { dryRun: !live, error: denied ? err.message : "request failed" });
  }
}

export async function approve(req, res) {
  return run(req, res, "approve");
}
export async function reject(req, res) {
  return run(req, res, "reject");
}
export async function transition(req, res) {
  return run(req, res, "transition");
}

// The Advanced I/O entry routes every machine.endpoints path to this module.
// The URL suffix picks the action (/flows/<name>/approve|reject|transition);
// the bare /flows/<name> route takes body.action instead.
export default async function handler(req, res) {
  const leaf = String((req && req.url) || "").split("?")[0].split("/").filter(Boolean).pop() || "";
  const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const action = leaf === "approve" || leaf === "reject" || leaf === "transition" ? leaf : String(body.action || "");
  if (action === "approve" || action === "reject" || action === "transition") return run(req, res, action);
  send(res, 404, { error: "no such endpoint" });
}
`;
}

/**
 * Event-time endpoint for a client condition's read-only `thisapp` call.
 * It is deliberately separate from the prefetch module: the request carries
 * function arguments, the server runs the registered callee, and the response
 * carries one value rather than prefetch slots.
 */
function functionCallModule(opts: {
  app: App;
  name: string;
  signature?: string;
  params: string[];
  reads: string[];
  schema?: SchemaPlan;
}): string {
  const path = `/functions/${slug(opts.name)}/call`;
  const pathArgs = JSON.stringify(opts.name.split('.'));
  const readForms = [...new Set(opts.reads)].sort(compareEnUs);
  const needsRows = readForms.length > 0;
  return `${banner([
    `Client call for ${opts.name}`,
    opts.signature ? `Signature (verbatim): ${opts.signature.replace(/\*\//g, '* /')}` : 'No signature on the IR node.',
    `Advanced I/O POST ${path}`,
    'Runs one app function the generator proved read-only from its emitted server body.',
    'body.args are plain JSON data, one per declared parameter, at most 64 KB encoded. Branded, non-plain, or over-deep values are refused.',
    'Dry run reports value null — a placeholder must never take the true branch of a client condition.',
    'The client form, record, old row, and field names are not read. Authorization is checked for every form the callee reads.',
    'The response nonce is the form state the condition ran for.',
    'functions/c2c-deploy.json mode (or C2C_DEPLOY_MODE) decides: "live" runs the function; anything else returns the runtime dry-run result.',
  ])}import { authorizeRead, createRuntime, jsonReplacer, principalFromRequest } from "creator-to-catalyst/shims";
import { functions } from "../thisapp.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const endpoint = { type: "advancedio", method: "POST", path: ${JSON.stringify(path)}, dryRun: true };

export const access = ${accessLiteral(opts.app)};
export const readForms = ${JSON.stringify(readForms)};

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, jsonReplacer));
}

function isHidden(name) {
  return !!name && Array.isArray(access.hidden) && access.hidden.includes(name);
}

${REQUEST_ARGS_HELPER}
${liveHelpers('../')}

export default async function handler(req, res) {
  const deniedForm = readForms.find(isHidden);
  if (deniedForm) {
    send(res, 403, { ok: false, error: "hidden form" });
    return;
  }
  const principal = principalFromRequest(req);
  if (!principal) {
    send(res, 401, { ok: false, error: "client call: authenticated caller required" });
    return;
  }
  const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const sentArgs = Array.isArray(body.args) ? body.args : [];
  if (body.args !== undefined && (!Array.isArray(body.args) || sentArgs.length > ${opts.params.length} || sentArgs.some((arg) => !plainJsonArg(arg, 0)) || Buffer.byteLength(JSON.stringify(sentArgs), "utf8") > 65536)) {
    send(res, 400, { ok: false, error: "invalid function argument" });
    return;
  }
  const deploy = deployConfig();
  const live = deploy.mode === "live";
  try {
    for (const form of readForms) authorizeRead(access, principal, form, { op: "true" });
    const datastore = live && ${needsRows ? 'true' : 'false'} ? await liveDatastore() : null;
    if (live && ${needsRows ? 'true' : 'false'} && !datastore) {
      send(res, 500, { ok: false, dryRun: false, error: "live datastore is not configured" });
      return;
    }
    const runtime = createRuntime({
      dryRun: !live,
      appTimeZone: process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined${timeZoneFields(opts.app)}${schemaRuntimeOptions(opts.app, opts.schema)},
      ...(datastore ? { datastore, ...(datastore.now ? { now: datastore.now } : {}) } : {}),
      access,
      functions,
    });
    const ctx = runtime.context({
      record: {},
      old: { __c2c: "dry-run-old", loaded: false },
      principal,
      formNonce: typeof body.nonce === "string" ? body.nonce : undefined,
      appTimeZone: process.env.C2C_APP_TIMEZONE,
    });
    const value = await ctx.shim.thisapp.call(ctx, ${pathArgs}, requestArgs(req, ${opts.params.length}));
    send(res, 200, { ok: true, dryRun: !live, nonce: ctx.formNonce ?? null, value: live ? (value ?? null) : null, ...(live ? {} : { transcript: runtime.transcript }) });
  } catch (err) {
    const denied = err && (err.code === "RECORD_ACCESS_DENIED" || err.name === "RecordAccessError");
    send(res, denied ? 403 : 500, { ok: false, dryRun: !live, error: denied ? err.message : "request failed" });
  }
}
`;
}

function customModule(opts: {
  app: App;
  name: string;
  signature?: string;
  params: string[];
  form?: string;
  body: string;
  row: '' | 'rec' | 'recs';
  /** Set only when `api` blocks publish the function over HTTP. `method` is the route verb; `methodNote` is set when no single verb can be written. */
  api?: { publishers: ApiPublish[]; admins: string[]; method?: string; methodNote?: string };
  schema?: SchemaPlan;
}): string {
  const args = opts.params.join(', ');

  // The query keys are the signature's parameter names as the client writes
  // them (pre-jsIdent: a `var` parameter is still `?var=` on the wire).
  const queryParams = rawFnParams(opts.signature);
  const queryTypes: Record<string, string> = {};
  for (const p of fnSignatureParams(opts.signature)) {
    // The handler coerces by the compiler-normalised type so every spelling the
    // signature accepts (`bool`, `integer`, `collection`, …) behaves identically
    // on GET and POST. A spelling with no normalised type is passed through so
    // the handler can 400 naming it rather than binding a raw string.
    if (queryParams.includes(p.name)) queryTypes[p.name] = normType(p.type) ?? p.type.trim().toLowerCase();
  }
  const argsListLogic = `    let argsList;
    if (req.method === "GET" || req.method === "DELETE") {
      const queryArgs = requestQueryArgs(req, ${JSON.stringify(queryParams)}, ${JSON.stringify(queryTypes)});
      if (queryArgs.error) {
        send(res, 400, { dryRun: !live, error: queryArgs.error });
        return;
      }
      argsList = queryArgs.args;
    } else {
      argsList = requestArgs(req, ${opts.params.length});
    }`;

  const rowLine = opts.row ? 'row: { __row: true, form: formName, values: record },' : 'row: undefined,';
  const usesConnections = usesZohoConnections(opts.body);
  const usesGetUrl = usesOutboundGetUrl(opts.body);
  const usesThis = usesThisapp(opts.body);
  const mailFrom = opts.body.includes('shim.mail.send') ? ', mailFrom: process.env.C2C_MAIL_FROM' : '';
  // Function arguments are the function's `input`: `input.<param>` reads
  // ctx.record[param], so the HTTP args land on the record by name.
  const bindParams = opts.params.length
    ? `\n    ${JSON.stringify(opts.params)}.forEach((param, i) => { if (i < argsList.length) record[param] = argsList[i]; });`
    : '';
  // The row binding is jsIdent'd (`rec`/`recs` are reserved → `d_rec`/`d_recs`),
  // and is suppressed when a parameter or a user declaration already owns the name.
  const rowIdent = opts.row ? jsIdent(opts.row) : '';
  const rowDecl = rowIdent && !opts.params.includes(rowIdent) && !declaresIdent(opts.body, rowIdent) ? rowIdent : '';
  const intro = [
    `Function ${opts.name}`,
    opts.signature ? `Signature (verbatim): ${opts.signature.replace(/\*\//g, '* /')}` : 'No signature on the IR node.',
    opts.form ? `Form: ${opts.form}` : 'No form on the IR node.',
    opts.row === 'rec'
      ? 'Execution is for each record: `rec` is the current row loaded on the server.'
      : opts.row === 'recs'
        ? 'Execution is for a collection of records: `recs` is the selected records; the form name names it.'
        : 'Not a for-each-record function.',
  ];
  const declaration = `export const access = ${accessLiteral(opts.app)};
export const formName = ${JSON.stringify(opts.form ?? '')};

export async function ${safeFn(opts.name)}(ctx${args ? `, ${args}` : ''}) {
  const shim = ctx.shim;
${rowDecl ? `  const ${rowDecl} = ctx.row;\n` : ''}${indent(opts.body)}
}
`;
  if (!opts.api) {
    // Not an HTTP route. Creator invokes a custom function in-process — from
    // workflow actions and `thisapp.<fn>()` — so the module keeps the named
    // export the generated registry lazy-imports and nothing else routes to
    // it. The default export answers 404 if a request reaches it anyway.
    return `${banner([
      ...intro,
      'Not an HTTP route: no `api <name> { ... }` block publishes this function.',
      'routes.json has no path for it; only in-process dispatch can call it.',
    ])}${declaration}
export default async function handler(req, res) {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end('{"error":"no such endpoint"}');
}
`;
  }
  const publishers = opts.api.publishers.map((p) => `${p.api}${p.scope ? ` (scope ${JSON.stringify(p.scope)})` : ' (no scope)'}`).join(', ');
  const adminNames = JSON.stringify(opts.api.admins);
  const route = `/functions/${slug(opts.name)}`;
  const method = opts.api.method;
  const routeLine = (method ? `${method} ${route}` : (opts.api.methodNote ?? 'No Advanced I/O route is written.')).replace(/\*\//g, '* /');
  const endpointExport = method
    ? `export const endpoint = { type: "advancedio", method: ${JSON.stringify(method)}, path: ${JSON.stringify(route)}, dryRun: true };\n\n`
    : '\n';
  return `${banner([
    ...intro,
    `HTTP-exposed by custom API: ${publishers}.`,
    opts.api.admins.length
      ? `Gate order: hidden form, authenticated profile, then Administrator-preset profile (${opts.api.admins.join(', ')}), then authorizeRead of the form.`
      : 'Gate order: hidden form, authenticated profile, then Administrator-preset profile — none is declared, so every caller is denied.',
    'functions/c2c-deploy.json mode (or C2C_DEPLOY_MODE) decides: "live" runs the',
    'function for real; anything else records the transcript without effects.',
    'The client record, previous row, and subform row are not read. Dry run uses placeholders.',
    'body.args are plain JSON data, one per parameter: a fetched row, query or binding from the client is null.',
    'GET and DELETE have no body: each declared parameter is a required query parameter, coerced to its declared type; an unknown key is ignored with a warning.',
    'POST /functions/' + slug(opts.name),
    routeLine,
  ])}import { authorizeRead, createRuntime, jsonReplacer, ${usesGetUrl ? 'outboundGetUrl, ' : ''}principalFromRequest } from "creator-to-catalyst/shims";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
${usesThis ? 'import { functions } from "../thisapp.mjs";\n' : ''}${endpointExport}${declaration}
function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, jsonReplacer));
}

function isHidden(name) {
  return !!name && Array.isArray(access.hidden) && access.hidden.includes(name);
}

const adminProfiles = ${adminNames};

${REQUEST_ARGS_HELPER}
${liveHelpers('../')}
${usesConnections ? `\n${connectionsLiveHelpers('../')}\n` : ''}${usesGetUrl ? `\n${outboundLiveHelpers('../')}\n` : ''}
export default async function handler(req, res) {
  if (isHidden(formName)) {
    send(res, 403, { dryRun: true, error: "hidden form" });
    return;
  }
  const principal = principalFromRequest(req);
  if (!principal?.profile) {
    send(res, 401, { dryRun: true, error: "authenticated caller required" });
    return;
  }
  if (!adminProfiles.some((name) => name.toLowerCase() === String(principal.profile).toLowerCase())) {
    send(res, 403, { dryRun: true, error: "custom API functions require an Administrator profile" });
    return;
  }
  const deploy = deployConfig();
  const live = deploy.mode === "live";
  try {
    if (formName) authorizeRead(access, principal, formName, { op: "true" });
${argsListLogic}
    const datastore = live ? await liveDatastore() : null;${needsDatastore(opts.body) ? `
    if (live && !datastore) {
      send(res, 500, { dryRun: false, error: "live datastore is not configured" });
      return;
    }` : ''}
    const record = { __c2c: "dry-run-record", loaded: false };${bindParams}
    const runtime = createRuntime({
      dryRun: !live,
      appTimeZone: process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined${timeZoneFields(opts.app)}${schemaRuntimeOptions(opts.app, opts.schema)}${mailFrom},
      ...(datastore ? { datastore, ...(datastore.now ? { now: datastore.now } : {}) } : {}),
${usesConnections ? '      zohoConnections: await zohoConnections(req, live),\n' : ''}${usesGetUrl ? '      ...(live ? { httpGetUrl: outboundGetUrl(outboundConfig(req)) } : {}),\n' : ''}      access,${usesThis ? '\n      functions,' : ''}
    });
    const ctx = runtime.context({
      record,
      old: { __c2c: "dry-run-old", loaded: false },
      principal,
      ${rowLine}
      appTimeZone: process.env.C2C_APP_TIMEZONE,
    });
    const result = await ${safeFn(opts.name)}(ctx, ...argsList);
    // The transcript holds record values, table names and ops. It is a
    // dry-run debug view only: no live reply carries it.
    send(res, 200, live ? { dryRun: false, result: result ?? null } : { dryRun: true, result: result ?? null, transcript: runtime.transcript });
  } catch (err) {
    const denied = err && (err.code === "RECORD_ACCESS_DENIED" || err.name === "RecordAccessError");
    send(res, denied ? 403 : 500, { dryRun: !live, error: denied ? err.message : "request failed" });
  }
}
`;
}

/** One row of functions/thisapp.mjs: the `thisapp.<fn>` dispatch registry. */
interface ThisappEntry {
  /** Deluge name as written in the .ds (`"ListGeneration.generate_list"`). */
  name: string;
  /** Import specifier relative to functions/ (`"./custom/x.mjs"`). */
  spec: string;
  exported: string;
  params: string[];
  /** parameter name → form link name, for form-typed parameters. */
  recordParams: Record<string, string>;
  /** Form link name for a `for each record` function; empty otherwise. */
  rowForm: string;
}

/**
 * The generated `thisapp.<fn>(args)` registry. Every generated module that
 * calls `shim.thisapp.call` passes this map to `createRuntime` as
 * `functions`; the runtime resolves the dotted path against it in-process —
 * no HTTP call, no separate function. `params` lets `input.<param>` resolve
 * in the callee, `recordParams` unwraps a `__row` argument to its values,
 * and `rowForm` binds `rec` on a `for each record` function.
 */
function thisappModule(entries: ThisappEntry[]): string {
  // The callee module is imported lazily, at dispatch time, so a custom
  // function whose generated module fails to parse (an untranslated
  // statement, a reserved-word parameter) does not take down every module
  // that can call `thisapp.<fn>` — only the call itself fails.
  const seen = new Set<string>();
  const unique = entries.filter((e) => {
    // Two functions may share a Deluge name; the first declaration wins,
    // matching an exact-then-insensitive lookup at runtime.
    if (seen.has(e.name)) return false;
    seen.add(e.name);
    return true;
  });
  const map = unique
    .map((e) => {
      const extra = [
        `params: ${JSON.stringify(e.params)}`,
        Object.keys(e.recordParams).length ? `recordParams: ${JSON.stringify(e.recordParams)}` : '',
        e.rowForm ? `rowForm: ${JSON.stringify(e.rowForm)}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      return `  ${JSON.stringify(e.name)}: { call: async (...a) => (await import(${JSON.stringify(e.spec)})).${e.exported}(...a), ${extra} },`;
    })
    .join('\n');
  return `${banner([
    'thisapp.<fn>(args) registry: every custom function this app generated,',
    'keyed by its Deluge name. Modules that call shim.thisapp.call pass this',
    'map to createRuntime; dispatch runs in-process in live mode and is',
    'recorded in a dry run. Names are looked up exactly, then case-insensitively.',
    'The callee module is imported on first dispatch: a broken function module',
    'only fails the call that reaches it.',
  ])}export const functions = {
${map}
};
`;
}

/**
 * One translation block as an explicit manual step: string catalogues are
 * not migrated. The generated app renders the default-language text only.
 */
function translationWarning(t: Translation): GenerateWarning {
  const data = t.data && typeof t.data === 'object' && !Array.isArray(t.data) ? (t.data as Record<string, unknown>) : undefined;
  const langs = data ? Object.keys(data).sort(compareEnUs) : [];
  const lang = langs.length === 1 ? langs[0]! : undefined;
  const table = lang !== undefined ? data?.[lang] : undefined;
  const keys = table && typeof table === 'object' && !Array.isArray(table) ? Object.keys(table).sort(compareEnUs) : [];
  const name = lang !== undefined ? `translation:${lang}` : 'translation block';
  const head = lang !== undefined ? `Translation "${lang}": ${keys.length} strings` : `A translation block (${keys.length} strings)`;
  const sample = keys.slice(0, 2).map((k) => `"${k}"`).join(', ');
  return {
    construct: 'translation-not-migrated',
    name,
    note: `${head}${sample ? ` (e.g. ${sample})` : ''} are not migrated. The generated app renders the default-language text only. To serve ${lang !== undefined ? `"${lang}"` : 'another language'}, copy these strings into the generated client's labels and add a language switch.`,
  };
}

function paymentStub(w: Workflow): string {
  return `${banner([
    `Payments workflow ${w.name}`,
    'Not supported: payments are not supported in this version (counted).',
    'No gateway, sandbox charge, or payment SDK call is generated.',
  ])}export const support = "not-supported";
export const reason = "Payments stay Not supported. No gateway is called.";
export const workflow = ${JSON.stringify({ name: w.name, form: w.form ?? null, event: w.event })};

export default function unsupported() {
  throw new Error("payments are not supported");
}
`;
}

function safeFn(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  return /^[$A-Za-z_]/.test(s) ? s : `fn_${s}`;
}
