/**
 * Smoke run against a deployed c2c_api, the way the generated Slate client
 * drives it:
 *
 *   - Auth is an app-user session: the customer's Catalyst Web SDK token
 *     (sent as the `authorization` header, exactly like client-runtime.js) or
 *     an embedded/hosted session cookie, either supplied or harvested from the
 *     app origin. The value is a header only — never stored, never printed.
 *   - Routes and their methods come from the generated routes.json; nothing
 *     is called that the deploy did not write.
 *   - One submit per form posts a minimal record: mandatory fields filled
 *     from the schema (first choice, canned scalars, a lookup resolved to the
 *     smoke-created parent or an existing row, else skipped with a reason).
 *   - A created row is read back through the admin query surface, then
 *     deleted — deletes run only for rows this run created and verified.
 *   - Reports are queried with the client body shape.
 *
 * Nothing calls out without --confirm; the default prints the plan.
 */
import { createHash } from 'node:crypto';
import type { App } from '../../core/src/ir.js';
import {
  assertAllowedHost,
  catalystAuthHeaders,
  catalystQueryUrl,
  type CatalystScope,
  type FetchLike,
} from '../../data/src/migrate.js';
import { subformTablesOf, type SchemaPlan } from '../../schema/src/generator.js';
import { smokeMarkerField, smokeNumberField, type UiField, type UiForm, type UiModel } from '../../ui/src/model.js';
import { GuardError, confirmGuardLines, planScopeLines, type GuardOk } from './guards.js';

export type SmokeKind = 'session' | 'submit' | 'read-back' | 'update' | 'arithmetic' | 'upload' | 'report' | 'cleanup' | 'skip';

/** How one mandatory field is filled. `source` is what the plan prints. */
export interface SmokeFieldPlan {
  name: string;
  source: string;
  /** Dropped from the record; `source` says why ('skipped: …'). */
  skipped?: boolean;
  /** Static value (choice, canned scalar, file reference). Absent = text with the run tag. */
  value?: unknown;
  lookupForm?: string;
  lookupTable?: string;
  /** The generated lookup endpoint — the in-app runner's fallback for a parent row. */
  lookupEndpoint?: string;
  multi?: boolean;
  children?: SmokeFieldPlan[];
  /** Resolved at run time from the upload step's stored reference. */
  fileRef?: boolean;
}

export interface SmokeStep {
  kind: SmokeKind;
  /** One line in the plan and the run report, e.g. 'submit Purchase_Order'. */
  label: string;
  method?: string;
  path?: string;
  form?: string;
  table?: string;
  record?: SmokeFieldPlan[];
  reason?: string;
  /** An update step rewrites one field of the created row through POST /admin/smoke (marker-scoped). */
  update?: SmokeUpdatePlan;
  /** A read-back step checks these after the row is present. */
  lookups?: SmokeLookupCheck[];
  children?: SmokeChildCheck[];
  files?: SmokeFileCheck[];
  /**
   * A read-back step verifies the row carries this field's value: a static
   * `value`, or the value this run submitted (`submitted: 'record'`, the run
   * marker check) or sent in the update (`submitted: 'update'`).
   */
  /** `column` is the stored column when the field's name is reserved; a raw ZCQL read-back reads it. */
  expect?: { field: string; column?: string; value?: unknown; submitted?: 'record' | 'update' };
  /** An upload step stores a tiny generated file for this field before the submit. */
  upload?: { field: string };
  /** The field that carries the 'c2c smoke <tag>' marker — the in-app cleanup checks it. */
  marker?: { field: string };
  /** An arithmetic step stores 41 in this number field of the created row and checks the live read is a number. */
  arithmetic?: { field: string };
}

/** One non-key field the update step rewrites. `value` is the new value when it does not depend on the run; `appendUpdated` means the run appends ' (updated)' to the submitted value. */
export interface SmokeUpdatePlan {
  field: string;
  /** How the plan line names the change, e.g. 'second choice'. Never a record value. */
  note: string;
  value?: unknown;
  appendUpdated?: boolean;
}

/** A lookup whose resolved display value the read-back shows. */
export interface SmokeLookupCheck {
  field: string;
  endpoint: string;
  parent: string;
  table: string;
  display: string;
}

/** A child table that must hold a row for the created parent. */
export interface SmokeChildCheck {
  field: string;
  table: string;
  parentColumn: string;
  orderColumn: string;
}

/** A file field whose stored key the read-back confirms through the download endpoint. */
export interface SmokeFileCheck {
  field: string;
  uploadPath: string;
  filesPath: string;
}

/** Parsed functions/c2c_api/routes.json plus the UI model and schema the deploy was built from. */
export interface SmokeInputs {
  /** "METHOD /path" -> module, exactly as routes.json holds it. */
  routes: Record<string, string>;
  model: UiModel;
  schema: SchemaPlan;
}

export interface SmokeAuth {
  /** Catalyst Web SDK auth token — sent as the `authorization` header. */
  token?: string;
  /** Embedded/hosted session cookie, "name=value". */
  cookie?: string;
}

export type SmokeFetch = FetchLike;

const ZCQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The method smoke calls for a path: POST when registered (smoke only calls POST), else the first key. */
function routeMethod(routes: Record<string, string>, path: string): string | undefined {
  let first: string | undefined;
  for (const key of Object.keys(routes)) {
    const at = key.indexOf(' ');
    if (key.slice(at + 1) !== path) continue;
    const method = key.slice(0, at);
    if (method === 'POST') return method;
    first ??= method;
  }
  return first;
}

/** Required lookup parents, so a parent form is submitted before the forms that need its row. */
function collectParents(fields: readonly UiField[] | undefined, out: Set<string>): void {
  for (const field of fields ?? []) {
    if (field.required && !field.readonly && (field.widget === 'lookup' || field.widget === 'lookup-multi') && field.lookup?.form) {
      out.add(field.lookup.form);
    }
    if (field.subfields?.length) collectParents(field.subfields, out);
  }
}

/** Stable topological order on required lookups; cycles keep declaration order. */
function orderForms(forms: readonly UiForm[]): UiForm[] {
  const names = new Set(forms.map((form) => form.name));
  const deps = new Map<string, Set<string>>();
  for (const form of forms) {
    const parents = new Set<string>();
    collectParents(form.fields, parents);
    deps.set(form.name, parents);
  }
  const done = new Set<string>();
  const out: UiForm[] = [];
  for (;;) {
    const ready = forms.filter(
      (form) => !done.has(form.name) && [...(deps.get(form.name) ?? [])].every((dep) => done.has(dep) || !names.has(dep)),
    );
    if (!ready.length) break;
    for (const form of ready) {
      done.add(form.name);
      out.push(form);
    }
  }
  for (const form of forms) if (!done.has(form.name)) out.push(form);
  return out;
}

/**
 * Distinct smoke values for date and datetime fields, in plan order. An
 * on-validate rule such as `input.Start >= input.End` refuses equal or
 * inverted pairs, so every required date/datetime in one record takes the next
 * slot (a day per date field, an hour per datetime field) rather than one
 * canned value for all of them.
 */
interface StampClock {
  n: number;
}

const SMOKE_DAY = Date.UTC(2026, 0, 15);

function stamp(clock: StampClock, widget: 'date' | 'datetime'): string {
  const step = clock.n++;
  const ms = widget === 'date' ? SMOKE_DAY + step * 86_400_000 : SMOKE_DAY + (10 + step) * 3_600_000;
  const iso = new Date(ms).toISOString();
  return widget === 'date' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/** The required children of a composite/subform; a required composite with no required child fills its first writable child. */
function childrenPlan(field: UiField, tableByForm: ReadonlyMap<string, string>, clock: StampClock): SmokeFieldPlan[] {
  const writable = (field.subfields ?? []).filter((sub) => !sub.readonly);
  const plans = writable
    .filter((sub) => sub.required)
    .map((sub) => fieldPlan(sub, tableByForm, clock))
    .filter((plan): plan is SmokeFieldPlan => !!plan);
  if (!plans.length && writable.length) {
    const first = fieldPlan({ ...writable[0], required: true } as UiField, tableByForm, clock);
    if (first) plans.push(first);
  }
  return plans;
}

/** Minimal valid value plan for one mandatory field; undefined for anything optional or read-only. */
function fieldPlan(field: UiField, tableByForm: ReadonlyMap<string, string>, clock: StampClock): SmokeFieldPlan | undefined {
  if (!field.required || field.readonly) return undefined;
  const name = field.name;
  const widget = field.widget;
  if (widget === 'lookup' || widget === 'lookup-multi') {
    const parent = field.lookup?.form ?? '';
    const table = parent ? tableByForm.get(parent) : undefined;
    if (!table) {
      return { name, skipped: true, source: `skipped: lookup target ${parent || '(unknown)'} has no Data Store table` };
    }
    return {
      name,
      source: `lookup ${parent}`,
      lookupForm: parent,
      lookupTable: table,
      ...(field.lookup?.endpoint ? { lookupEndpoint: field.lookup.endpoint } : {}),
      ...(widget === 'lookup-multi' ? { multi: true } : {}),
    };
  }
  if (widget === 'file' || widget === 'image' || widget === 'audio' || widget === 'video' || widget === 'signature') {
    return { name, source: 'a {key} upload reference', value: { key: `c2c-smoke/${name}` } };
  }
  if (widget === 'subform') return { name, source: 'one subform row', children: childrenPlan(field, tableByForm, clock) };
  if (widget === 'name' || widget === 'address') return { name, source: 'composite', children: childrenPlan(field, tableByForm, clock) };
  if (field.choices?.length) {
    // The field's own initial value is what a fresh form submits for it; an
    // on-validate rule can key on it ("No" skips a follow-up check), where the
    // first choice need not satisfy it.
    const initial = field.initialValue !== undefined && field.choices.includes(field.initialValue) ? field.initialValue : undefined;
    const picked = initial ?? field.choices[0]!;
    return { name, source: initial !== undefined ? 'initial value' : 'first choice', value: widget === 'multiselect' ? [picked] : picked };
  }
  switch (widget) {
    case 'decision':
      return { name, source: 'boolean', value: true };
    case 'date':
      return { name, source: 'date', value: stamp(clock, 'date') };
    case 'datetime':
      return { name, source: 'date-time', value: stamp(clock, 'datetime') };
    case 'number':
      return { name, source: 'number', value: 1 };
    case 'decimal':
    case 'percent':
    case 'currency':
      return { name, source: 'decimal', value: '1.00' };
    case 'email':
      return { name, source: 'email', value: 'smoke@example.test' };
    case 'url':
      return { name, source: 'url', value: 'https://example.test/c2c-smoke' };
    case 'phone':
      return { name, source: 'phone', value: '+10000000000' };
    case 'richtext':
      return { name, source: 'richtext', value: '<p>c2c smoke</p>' };
    case 'users':
      return { name, skipped: true, source: 'skipped: needs a real app user id' };
    default:
      return { name, source: 'text' };
  }
}

const FILE_WIDGETS: ReadonlySet<string> = new Set(['file', 'image', 'audio', 'video', 'signature']);

/** A parameterised route key matches its template with `:param` segments verbatim. */
function hasRoute(routes: Record<string, string>, method: string, template: string): boolean {
  if (`${method} ${template}` in routes) return true;
  const want = template.split('/');
  for (const key of Object.keys(routes)) {
    const at = key.indexOf(' ');
    if (key.slice(0, at) !== method) continue;
    const parts = key.slice(at + 1).split('/');
    if (parts.length !== want.length) continue;
    if (parts.every((part, i) => part.startsWith(':') || part === want[i])) return true;
  }
  return false;
}

/**
 * One writable non-key scalar the update step rewrites: a second choice, a
 * negation, an increment, or text with ' (updated)' appended at run time.
 * Unique fields stay untouched so the run never collides with itself.
 */
export function updatePlan(fields: readonly UiField[] | undefined, markerField?: string): SmokeUpdatePlan | undefined {
  for (const field of fields ?? []) {
    if (field.readonly || field.unique || field.name === markerField) continue;
    const widget = field.widget;
    if (widget === 'lookup' || widget === 'lookup-multi' || widget === 'subform' || widget === 'name' || widget === 'address') continue;
    if (FILE_WIDGETS.has(widget) || widget === 'users' || widget === 'unsupported') continue;
    if (field.choices?.length && field.choices.length > 1) {
      return { field: field.name, note: 'second choice', value: widget === 'multiselect' ? [field.choices[1]] : field.choices[1] };
    }
    switch (widget) {
      case 'decision':
        return { field: field.name, note: 'negation', value: false };
      case 'number':
        return { field: field.name, note: 'increment', value: 2 };
      case 'decimal':
      case 'percent':
      case 'currency':
        return { field: field.name, note: 'increment', value: '2.00' };
      case 'date':
        return { field: field.name, note: 'next day', value: '2026-01-16' };
      case 'datetime':
        return { field: field.name, note: 'next day', value: '2026-01-16 11:00:00' };
      case 'text':
      case 'textarea':
      case 'email':
      case 'url':
      case 'phone':
      case 'richtext':
        return { field: field.name, note: 'text (updated)', appendUpdated: true };
      default:
        continue;
    }
  }
  return undefined;
}

/** The file field the run uploads for: the required one, else the first writable one. */
function uploadField(fields: readonly UiField[] | undefined): UiField | undefined {
  const fileFields = (fields ?? []).filter((field) => !field.readonly && FILE_WIDGETS.has(field.widget));
  return fileFields.find((field) => field.required) ?? fileFields[0];
}

/** What a route that smoke does not exercise is for — printed as its skip reason. */
function routeSkipReason(path: string): string {
  const event = /^\/forms\/[^/]+\/([^/]+)$/.exec(path)?.[1];
  if (event === 'prefetch') return 'a prefetch snapshot for a UI handler';
  if (event === 'validate' || event === 'success') return 'runs inside the submit call';
  if (event) return 'a UI or record event handler — driven by form events, not a plain call';
  if (path.endsWith('/prefetch')) return 'a prefetch snapshot for a UI handler';
  if (/^\/reports\/[^/]+\/actions\//.test(path)) return 'a custom action — it acts on selected records';
  if (path.startsWith('/flows/')) return 'a state-machine transition — it needs a record in a stage';
  if (path.startsWith('/functions/')) return 'a custom function — its arguments and effects are app-specific';
  if (path === '/admin/smoke') return 'the in-app smoke run calls it for marker-checked deletes';
  return 'no smoke contract for this route';
}

/**
 * The calls a confirmed run makes, in order: session bootstrap, per form
 * (parents first) an upload for its file field, a submit, a read-back with
 * child-row, lookup-display and file-key checks, an update of one non-key
 * field plus its read-back, a query per report, skip lines for every other
 * generated route, then deletes in reverse creation order.
 */
export function planSmoke(_app: App, inputs: SmokeInputs): SmokeStep[] {
  const { routes, model, schema } = inputs;
  const tableByForm = new Map<string, string>();
  const renamedByForm = new Map<string, Record<string, string>>();
  for (const table of schema.tables) {
    if (table.role === 'form' && !table.nosql && ZCQL_IDENT.test(table.name)) tableByForm.set(table.form, table.name);
    if (table.role !== 'form') continue;
    const renamed: Record<string, string> = {};
    for (const column of table.columns) if (column.field !== undefined) renamed[column.field] = column.name;
    if (Object.keys(renamed).length) renamedByForm.set(table.form, renamed);
  }
  const expectOn = (form: string, field: string): { field: string; column?: string } => {
    const renamed = renamedByForm.get(form);
    return renamed && Object.hasOwn(renamed, field) ? { field, column: renamed[field]! } : { field };
  };
  const childByForm = subformTablesOf(schema);
  const canUpload = hasRoute(routes, 'POST', '/uploads/:form/:field');
  const canDownload = hasRoute(routes, 'POST', '/files/:form/:field');
  const steps: SmokeStep[] = [{ kind: 'session', label: 'session bootstrap', method: 'GET', path: '/' }];
  const claimed = new Set<string>();
  const cleanup: SmokeStep[] = [];
  for (const form of orderForms(model.forms)) {
    const method = routeMethod(routes, form.submitEndpoint);
    if (!method) {
      steps.push({ kind: 'skip', label: `submit ${form.name}`, method: 'POST', path: form.submitEndpoint, reason: 'no generated route for this submit endpoint' });
      continue;
    }
    claimed.add(`${method} ${form.submitEndpoint}`);
    const table = tableByForm.get(form.name);
    const marker = table ? smokeMarkerField(form.fields) : undefined;
    const clock: StampClock = { n: 0 };
    const record = (form.fields ?? []).map((field) => fieldPlan(field, tableByForm, clock)).filter((plan): plan is SmokeFieldPlan => !!plan);
    // The marker field must carry the run tag — a canned value (a phone, an
    // email, a first choice) would store no tag and every marker-scoped
    // update/delete after it 409s.
    const markerPlan = marker ? record.find((entry) => entry.name === marker) : undefined;
    if (markerPlan) {
      markerPlan.value = undefined;
      markerPlan.source = 'run marker';
    }
    // A form with a file field uploads a tiny generated file first; the submit carries the stored reference.
    const upload = uploadField(form.fields);
    const uploadStep = upload && canUpload ? { field: upload.name } : undefined;
    if (upload && uploadStep) {
      const plan = record.find((entry) => entry.name === upload.name);
      if (plan) {
        plan.source = 'smoke upload';
        plan.value = undefined;
        plan.fileRef = true;
      } else {
        record.push({ name: upload.name, source: 'smoke upload', fileRef: true });
      }
      steps.push({
        kind: 'upload',
        label: `upload ${form.name}.${upload.name}`,
        form: form.name,
        method: 'POST',
        path: `/uploads/${encodeURIComponent(form.name)}/${encodeURIComponent(upload.name)}`,
        upload: { field: upload.name },
      });
      claimed.add('POST /uploads/:form/:field');
    }
    steps.push({
      kind: 'submit',
      label: `submit ${form.name}`,
      form: form.name,
      ...(table ? { table } : {}),
      method,
      path: form.submitEndpoint,
      record,
      ...(marker ? { marker: { field: marker } } : {}),
    });
    if (table) {
      const readBack: SmokeStep = {
        kind: 'read-back',
        label: `read-back ${form.name}`,
        form: form.name,
        table,
        ...(marker ? { expect: { ...expectOn(form.name, marker), submitted: 'record' } } : {}),
      };
      const lookups: SmokeLookupCheck[] = [];
      for (const plan of record) {
        if (!plan.lookupTable) continue;
        const field = (form.fields ?? []).find((entry) => entry.name === plan.name);
        const endpoint = field?.lookup?.endpoint;
        if (!endpoint) continue;
        lookups.push({
          field: plan.name,
          endpoint,
          parent: plan.lookupForm ?? '',
          table: plan.lookupTable,
          display: field?.lookup?.field ?? plan.lookupForm ?? plan.name,
        });
      }
      if (lookups.length) {
        readBack.lookups = lookups;
        claimed.add('GET /lookups/:form/:field');
      }
      const subforms = new Set(record.filter((plan) => plan.children?.length && plan.source === 'one subform row').map((plan) => plan.name));
      const children: SmokeChildCheck[] = [];
      for (const link of childByForm[form.name] ?? []) {
        if (subforms.has(link.field)) children.push({ field: link.field, table: link.table, parentColumn: link.parentColumn, orderColumn: link.orderColumn });
      }
      if (children.length) readBack.children = children;
      if (upload && uploadStep && canDownload) {
        readBack.files = [
          {
            field: upload.name,
            uploadPath: `/uploads/${encodeURIComponent(form.name)}/${encodeURIComponent(upload.name)}`,
            filesPath: `/files/${encodeURIComponent(form.name)}/${encodeURIComponent(upload.name)}`,
          },
        ];
        claimed.add('POST /files/:form/:field');
      }
      steps.push(readBack);
      const update = updatePlan(form.fields, marker);
      if (update && marker) {
        steps.push({ kind: 'update', label: `update ${form.name}`, form: form.name, table, method: 'POST', path: '/admin/smoke', update, marker: { field: marker } });
        steps.push({
          kind: 'read-back',
          label: `read-back ${form.name} (after update)`,
          form: form.name,
          table,
          expect: update.value !== undefined ? { ...expectOn(form.name, update.field), value: update.value } : { ...expectOn(form.name, update.field), submitted: 'update' },
        });
      }
      const number = marker ? smokeNumberField(form.fields, marker) : undefined;
      if (number && marker) {
        steps.push({ kind: 'arithmetic', label: `arithmetic ${form.name}.${number}`, form: form.name, table, method: 'POST', path: '/admin/smoke', arithmetic: { field: number }, marker: { field: marker } });
      }
      cleanup.unshift({ kind: 'cleanup', label: `delete ${form.name}`, form: form.name, table, ...(marker ? { marker: { field: marker } } : {}) });
    } else {
      steps.push({ kind: 'skip', label: `read-back ${form.name}`, reason: `${form.name} has no Data Store table` });
    }
  }
  for (const report of model.reports) {
    if (!report.queryEndpoint) {
      steps.push({ kind: 'skip', label: `report ${report.name}`, reason: 'no query endpoint for this report' });
      continue;
    }
    const method = routeMethod(routes, report.queryEndpoint);
    if (!method) {
      steps.push({ kind: 'skip', label: `report ${report.name}`, method: 'POST', path: report.queryEndpoint, reason: 'no generated route for this report' });
      continue;
    }
    claimed.add(`${method} ${report.queryEndpoint}`);
    steps.push({ kind: 'report', label: `report ${report.name}`, method, path: report.queryEndpoint });
  }
  if (cleanup.some((step) => step.marker) && hasRoute(routes, 'POST', '/admin/smoke')) claimed.add('POST /admin/smoke');
  for (const key of Object.keys(routes).sort()) {
    if (claimed.has(key)) continue;
    const at = key.indexOf(' ');
    const path = key.slice(at + 1);
    steps.push({ kind: 'skip', label: `skip ${key}`, method: key.slice(0, at), path, reason: routeSkipReason(path) });
  }
  steps.push(...cleanup);
  return steps;
}

function recordSketch(record: readonly SmokeFieldPlan[] | undefined, markerField?: string): string {
  if (!record?.length) return 'record {} (no mandatory fields)';
  return `record { ${record.map((field) => `${field.name}: ${field.name === markerField ? 'run marker' : field.source}`).join(', ')} }`;
}

function readBackExtras(step: SmokeStep): string {
  const extras: string[] = [];
  for (const child of step.children ?? []) extras.push(`child ${child.table}`);
  for (const lookup of step.lookups ?? []) extras.push(`lookup ${lookup.field} display`);
  for (const file of step.files ?? []) extras.push(`file ${file.field} key`);
  return extras.length ? ` (+ ${extras.join('; ')})` : '';
}

function stepLine(step: SmokeStep): string {
  switch (step.kind) {
    case 'session':
      return `- session bootstrap: GET <origin>/`;
    case 'submit':
      return `- ${step.label}: ${step.method} ${step.path} — ${recordSketch(step.record, step.marker?.field)}`;
    case 'read-back':
      return `- ${step.label}: SELECT * FROM ${step.table} WHERE ROWID = <created>${readBackExtras(step)}`;
    case 'update':
      return `- ${step.label}: POST /admin/smoke { op: "update" } — ${step.update?.field}: ${step.update?.note}`;
    case 'arithmetic':
      return `- ${step.label}: POST /admin/smoke { op: "arith" } — stores 41, reads it back, checks 41 + 1 = 42 and 41 > 9`;
    case 'upload':
      return `- ${step.label}: ${step.method} ${step.path} — tiny text file`;
    case 'report':
      return `- ${step.label}: ${step.method} ${step.path} — { op: "query" }`;
    case 'cleanup':
      return `- ${step.label}: DELETE FROM ${step.table} WHERE ROWID = <created>`;
    case 'skip':
      return `- ${step.label}: ${step.reason}`;
  }
}

/** A session cookie is always `name=value`; anything else is refused before it could be printed. */
export function assertSmokeCookie(cookie: string, source: string): void {
  const name = cookie.split('=')[0] ?? '';
  if (!cookie.includes('=') || !/^[^\s;,=]+$/.test(name)) {
    throw new GuardError('smoke-auth', `${source} must be name=value`);
  }
}

/** The cookie name for display — the value is never printed, even when malformed. */
export function smokeCookieName(cookie: string): string {
  const name = cookie.split('=')[0]?.trim() ?? '';
  return cookie.includes('=') && /^[^\s;,=]+$/.test(name) ? name : '?';
}

/** What is printed for auth — the kind and where it came from, never the value. */
export function describeSmokeAuth(auth: SmokeAuth, sources: { token?: string; cookie?: string }): string {
  const parts: string[] = [];
  if (auth.token) parts.push(`app token (${sources.token})`);
  if (auth.cookie) parts.push(`session cookie ${smokeCookieName(auth.cookie)} (${sources.cookie})`);
  if (parts.length) return parts.join(' + ');
  return 'none — pass --auth-token <token> or --session-cookie <name=value>, or let the run try a cookie from the app origin';
}

export function formatSmokePlan(
  steps: readonly SmokeStep[],
  guard: GuardOk,
  baseUrl: string | undefined,
  authLabel: string,
  confirm: boolean,
  credentialNote?: string,
): string {
  const lines = [
    'c2c smoke plan v2',
    ...planScopeLines(guard),
    confirm ? `credential: ${credentialNote ?? 'set'}` : 'credential: not checked',
    ...(confirm ? [] : confirmGuardLines()),
    `url: ${baseUrl ?? '(unset)'}`,
    `auth: ${authLabel}`,
    `confirm: ${confirm ? 'yes' : 'no'}`,
    '',
    'calls:',
    ...steps.map(stepLine),
    '',
    `executed: ${confirm ? 'yes' : 'no'}`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function assertSmokeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('smoke url is not a URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  const https = url.protocol === 'https:';
  // http is allowed only on loopback: the offline harness (tools/catalyst-harness).
  if ((!https && !(url.protocol === 'http:' && loopback)) || url.username || url.password) {
    throw new Error('smoke url must be https (http only for a loopback harness) and must not carry credentials');
  }
  return url;
}

export interface SmokeRunOptions {
  fetch: FetchLike;
  /** The c2c_api base, e.g. https://<project-domain>/server/c2c_api. */
  base: string;
  auth: SmokeAuth;
  dc: string;
  /** Admin REST base for read-back/delete; defaults to the DC's api.catalyst host. */
  catalystBase: string;
  /** Lazily resolved CLI scope for the admin calls. */
  scope?: () => Promise<CatalystScope>;
  /** Marker folded into generated text values; defaults to a run token. */
  runTag?: string;
  /** Function calls run inside a signed-in browser page: there is no session to bootstrap. */
  browserSession?: boolean;
}

export interface SmokeResult {
  ok: boolean;
  lines: string[];
  /** The session did not prove itself — a sign-in page or a non-status reply, never an authorization. */
  notSignedIn?: boolean;
}

interface Created {
  table?: string;
  rowid: string;
}

/** First `name=value` pair of each Set-Cookie, joined for a Cookie header. */
function harvestCookies(headers: { get(name: string): string | null; getSetCookie?: () => string[] }): string | undefined {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : headers.get('set-cookie');
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const pairs = list.map((value) => value.split(';')[0]?.trim() ?? '').filter((value) => value.includes('='));
  return pairs.length ? pairs.join('; ') : undefined;
}

/** Every literal secret value smoke sent — the token and each cookie value — longest first. */
function smokeSecrets(auth: SmokeAuth): string[] {
  const out = new Set<string>();
  if (auth.token?.trim()) out.add(auth.token);
  if (auth.cookie?.trim()) {
    out.add(auth.cookie);
    for (const pair of auth.cookie.split(';')) {
      if (!pair.includes('=')) continue;
      const value = pair.slice(pair.indexOf('=') + 1).trim();
      if (value) out.add(value);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Cut auth material a server, proxy, or WAF may have echoed in an error
 * reply before the text is printed: every supplied secret value verbatim,
 * plus Authorization/Cookie header echoes, Bearer/Basic credentials, and
 * JWT-shaped values. The status line keeps the status; only the text is cut.
 */
function redactSmokeSecrets(text: string, auth: SmokeAuth): string {
  let out = text;
  for (const secret of smokeSecrets(auth)) out = out.split(secret).join('[redacted]');
  return out
    .replace(/authorization\s*[:=]\s*"[^"]*"|authorization\s*[:=]\s*'[^']*'|authorization\s*[:=]\s*[^\s,;}]+/gi, 'authorization: [redacted]')
    .replace(/cookie\s*[:=]\s*"[^"]*"|cookie\s*[:=]\s*'[^']*'|cookie\s*[:=]\s*[^\n,}]+/gi, 'cookie: [redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/=]+/g, 'Bearer [redacted]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/g, 'Basic [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
}

/** Response text trimmed to one line — app error texts only, with any echoed auth cut out. */
function errText(body: unknown, fallback: string, auth: SmokeAuth): string {
  const error = body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
  const text = typeof error === 'string' && error.trim() ? error.trim() : fallback;
  const clean = redactSmokeSecrets(text, auth);
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

export async function executeSmoke(steps: readonly SmokeStep[], opts: SmokeRunOptions): Promise<SmokeResult> {
  const base = assertSmokeUrl(opts.base);
  const fnBase = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
  const tag = opts.runTag ?? `s${Date.now().toString(36)}`;
  const auth: SmokeAuth = { ...opts.auth };
  const lines: string[] = [];
  const submits = steps.filter((step) => step.kind === 'submit').length;
  /** Steps that made a real call — an all-skipped run is never a pass. */
  let exercised = 0;
  const created = new Map<string, Created>();
  const verified = new Set<string>();
  /** form.field -> the Stratus key an upload step stored. */
  const uploaded = new Map<string, string>();
  /** form -> the record this run submitted. */
  const submitted = new Map<string, Record<string, unknown>>();
  /** form -> { field, value } this run sent as the update. */
  const updateSent = new Map<string, { field: string; value: unknown }>();
  let deleted = 0;
  let failed = false;
  let scopePromise: Promise<CatalystScope> | undefined;
  const scope = () => {
    if (!opts.scope) throw new Error('no Catalyst scope resolver');
    return (scopePromise ??= opts.scope());
  };

  const fnHeaders = () => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (auth.token) headers.authorization = auth.token;
    if (auth.cookie) headers.cookie = auth.cookie;
    return headers;
  };

  const zcql = async (sql: string): Promise<{ status: number; body: unknown }> => {
    const resolved = await scope();
    const url = catalystQueryUrl(opts.catalystBase, resolved);
    assertAllowedHost(url, opts.dc);
    const res = await opts.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...catalystAuthHeaders(resolved) },
      body: JSON.stringify({ query: sql }),
    });
    const text = await res.text();
    let body: unknown = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 200) };
    }
    return { status: res.status, body };
  };

  const queryRows = async (table: string, where?: string, limit = 1): Promise<Record<string, unknown>[]> => {
    const { status, body } = await zcql(`SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''} ORDER BY ROWID LIMIT 0, ${limit}`);
    if (status < 200 || status >= 300) throw new Error(`query ${table} answered ${status}`);
    const data = body && typeof body === 'object' ? (body as Record<string, unknown>).data : undefined;
    const rows = Array.isArray(data) ? data : [];
    return rows.map((row) => {
      const inner = row && typeof row === 'object' ? ((row as Record<string, unknown>)[table] ?? row) : row;
      return inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {};
    });
  };

  const recordFor = async (
    plans: readonly SmokeFieldPlan[],
    prefix: string,
    form: string,
  ): Promise<{ record: Record<string, unknown>; notes: string[] }> => {
    const record: Record<string, unknown> = {};
    const notes: string[] = [];
    for (const plan of plans) {
      const dotted = prefix ? `${prefix}.${plan.name}` : plan.name;
      if (plan.skipped) {
        notes.push(`${dotted}: ${plan.source}`);
        continue;
      }
      if (plan.fileRef) {
        const key = uploaded.get(`${form}.${plan.name}`);
        if (!key) {
          notes.push(`${dotted}: skipped — no uploaded object`);
          continue;
        }
        record[plan.name] = { key };
        continue;
      }
      if (plan.lookupTable) {
        let id = created.get(plan.lookupForm ?? '')?.rowid;
        if (!id) {
          try {
            id = String((await queryRows(plan.lookupTable))[0]?.ROWID ?? '') || undefined;
          } catch {
            id = undefined;
          }
        }
        if (!id) {
          notes.push(`${dotted}: skipped — no parent row in ${plan.lookupForm ?? plan.lookupTable}`);
          continue;
        }
        record[plan.name] = plan.multi ? [id] : id;
        continue;
      }
      if (plan.children) {
        const inner = await recordFor(plan.children, dotted, form);
        record[plan.name] = plan.source === 'one subform row' ? [inner.record] : inner.record;
        notes.push(...inner.notes);
        continue;
      }
      record[plan.name] = plan.value !== undefined ? plan.value : `c2c smoke ${tag}`;
    }
    return { record, notes };
  };

  for (const step of steps) {
    try {
      switch (step.kind) {
        case 'session': {
          if (opts.browserSession) {
            // A browser session proves itself the way the generated smoke page
            // does: the documented /admin/smoke status shape — { ok: true,
            // mode, forms } — never a bare 200 (a sign-in page is 200 too).
            const probe = await opts.fetch(`${fnBase}/admin/smoke`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ op: 'status' }),
            });
            const probeText = await probe.text();
            let status: unknown = null;
            try {
              status = JSON.parse(probeText);
            } catch {
              /* a sign-in page or any non-JSON reply */
            }
            const granted =
              probe.status === 200 &&
              status !== null &&
              typeof status === 'object' &&
              (status as Record<string, unknown>).ok === true &&
              typeof (status as Record<string, unknown>).mode === 'string' &&
              Number.isInteger((status as Record<string, unknown>).forms);
            if (!granted) {
              lines.push(
                probe.status === 403
                  ? 'session bootstrap: the smoke service denied this sign-in — it needs an Administrator profile'
                  : probe.status === 401
                    ? `session bootstrap: not signed in on the app domain — /admin/smoke answered 401; the browser holds no app-user session for ${base.origin} — sign in at the app's own sign-in page on that domain as a user registered on the project (a console sign-in is not an app session)`
                  : probe.status === 404
                    ? 'session bootstrap: the smoke endpoint is not enabled on this deployment — set C2C_SMOKE_ENABLED=1 on the function for cutover smoke, then remove it'
                    : `session bootstrap: not signed in — /admin/smoke answered ${probe.status} without the documented status shape`,
              );
              return { ok: false, notSignedIn: true, lines };
            }
            lines.push('session bootstrap: the browser session carries the calls — signed in');
            break;
          }
          if (auth.token || auth.cookie) {
            lines.push('session bootstrap: auth supplied — no bootstrap call');
            break;
          }
          const res = await opts.fetch(`${base.origin}/`, { method: 'GET', headers: { Accept: 'text/html,application/json' } });
          const cookie = harvestCookies(res.headers);
          if (cookie) {
            auth.cookie = cookie;
            lines.push(`session bootstrap: cookie ${smokeCookieName(cookie)} acquired from ${base.origin}/`);
          } else {
            lines.push(`session bootstrap: no session cookie (status ${res.status})`);
          }
          break;
        }
        case 'upload': {
          const bytes = `c2c smoke ${tag}\n`;
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          exercised += 1;
          const res = await opts.fetch(`${fnBase}${step.path}`, {
            method: step.method ?? 'POST',
            headers: { ...fnHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: `c2c-smoke-${tag}.txt`, contentType: 'text/plain', sha256 }),
          });
          const text = await res.text();
          let body: unknown = {};
          try {
            body = JSON.parse(text);
          } catch {
            /* non-JSON reply */
          }
          if (res.status < 200 || res.status >= 300) {
            failed = true;
            lines.push(`${step.label}: ${res.status} ${errText(body, text.slice(0, 200), auth)}`);
            break;
          }
          const reference = body && typeof body === 'object' ? (body as Record<string, unknown>).reference : undefined;
          const key = reference && typeof reference === 'object' ? (reference as Record<string, unknown>).key : undefined;
          if (typeof key !== 'string' || !key) {
            failed = true;
            lines.push(`${step.label}: ${res.status} but no reference key`);
            break;
          }
          uploaded.set(`${step.form}.${step.upload?.field}`, key);
          const upload = body && typeof body === 'object' ? (body as Record<string, unknown>).upload : undefined;
          const uploadUrl = upload && typeof upload === 'object' ? (upload as Record<string, unknown>).url : undefined;
          if (typeof uploadUrl === 'string' && uploadUrl) {
            // The signed URL goes to Stratus — never the app headers.
            let target: URL | undefined;
            try {
              target = new URL(uploadUrl, fnBase);
            } catch {
              target = undefined;
            }
            const loopback = target && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname);
            if (!target || (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback))) {
              failed = true;
              lines.push(`${step.label}: refused the signed upload URL (not https)`);
              break;
            }
            const uploadHeaders = upload && typeof upload === 'object' ? (upload as Record<string, unknown>).headers : undefined;
            const put = await opts.fetch(uploadUrl, {
              method: 'PUT',
              headers: { 'Content-Type': 'text/plain', ...(uploadHeaders && typeof uploadHeaders === 'object' ? (uploadHeaders as Record<string, string>) : {}) },
              body: bytes,
            });
            if (put.status < 200 || put.status >= 300) {
              failed = true;
              lines.push(`${step.label}: ${res.status} reference stored but the PUT answered ${put.status}`);
              break;
            }
            lines.push(`${step.label}: ${res.status} stored (PUT ${put.status})`);
          } else {
            lines.push(`${step.label}: ${res.status} reference stored`);
          }
          break;
        }
        case 'submit': {
          const { record, notes } = await recordFor(step.record ?? [], '', step.form ?? '');
          const suffix = notes.length ? ` (${notes.join('; ')})` : '';
          exercised += 1;
          const res = await opts.fetch(`${fnBase}${step.path}`, {
            method: step.method ?? 'POST',
            headers: { ...fnHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ record }),
          });
          const text = await res.text();
          let body: unknown = {};
          try {
            body = JSON.parse(text);
          } catch {
            /* non-JSON reply */
          }
          const values = body && typeof body === 'object' ? (body as Record<string, unknown>).values : undefined;
          const rowid =
            values && typeof values === 'object'
              ? String((values as Record<string, unknown>).ROWID ?? (values as Record<string, unknown>).ID ?? '')
              : '';
          if (res.status < 200 || res.status >= 300) {
            failed = true;
            // A post-write failure (an on-success handler refusing, say) still
            // committed the row — track it so cleanup deletes it instead of
            // leaving an orphan the run never reports.
            if ((body as Record<string, unknown>)?.wrote === true && /^\d+$/.test(rowid)) {
              created.set(step.form ?? '', { ...(step.table ? { table: step.table } : {}), rowid });
              submitted.set(step.form ?? '', record);
              lines.push(`${step.label}: ${res.status} ${errText(body, text.slice(0, 200), auth)} (row ${redactSmokeSecrets(rowid, auth)} written — tracked for cleanup)${suffix}`);
            } else {
              lines.push(`${step.label}: ${res.status} ${errText(body, text.slice(0, 200), auth)}${suffix}`);
            }
            break;
          }
          // A 2xx body is still server-controlled: only a digits-only ROWID is
          // stored or printed, and even that goes through the redactor.
          if ((body as Record<string, unknown>)?.wrote === true && /^\d+$/.test(rowid)) {
            created.set(step.form ?? '', { ...(step.table ? { table: step.table } : {}), rowid });
            submitted.set(step.form ?? '', record);
            // A post-commit failure (on-success script, mail) answers 200 with a
            // warning: the row is stored and tracked; the warning code is named.
            const warning = (body as Record<string, unknown>).warning;
            const warned = warning && typeof warning === 'object' && (warning as Record<string, unknown>).code === 'POST_COMMIT_FAILED' ? ' (warning POST_COMMIT_FAILED: an action after the save did not complete)' : '';
            lines.push(`${step.label}: ${res.status} wrote ${redactSmokeSecrets(rowid, auth)}${warned}${suffix}`);
          } else if ((body as Record<string, unknown>)?.wrote === true) {
            failed = true;
            lines.push(`${step.label}: ${res.status} wrote but returned no usable ROWID${suffix}`);
          } else {
            lines.push(`${step.label}: ${res.status} dry-run — nothing written${suffix}`);
          }
          break;
        }
        case 'read-back': {
          const made = step.form ? created.get(step.form) : undefined;
          if (!made) {
            lines.push(`${step.label}: skipped — no row created`);
            break;
          }
          if (!/^\d+$/.test(made.rowid)) {
            failed = true;
            lines.push(`${step.label}: created ROWID ${redactSmokeSecrets(made.rowid, auth)} is not digits — not read back`);
            break;
          }
          exercised += 1;
          const rows = await queryRows(step.table as string, `ROWID = ${made.rowid}`);
          if (!rows.length) {
            failed = true;
            lines.push(`${step.label}: missing — the store holds no row ${redactSmokeSecrets(made.rowid, auth)}`);
            break;
          }
          verified.add(step.form ?? '');
          lines.push(`${step.label}: row ${redactSmokeSecrets(made.rowid, auth)} present`);
          const row = rows[0]!;
          if (step.expect) {
            const expected =
              step.expect.value !== undefined
                ? step.expect.value
                : step.expect.submitted === 'update'
                  ? updateSent.get(step.form ?? '')?.value
                  : submitted.get(step.form ?? '')?.[step.expect.field];
            if (expected === undefined) {
              lines.push(`${step.label}: ${step.expect.field} — nothing sent to compare`);
            } else if (String(row[step.expect.column ?? step.expect.field] ?? '') === String(expected)) {
              lines.push(`${step.label}: ${step.expect.field} matches what the run sent`);
            } else {
              failed = true;
              lines.push(`${step.label}: ${step.expect.field} does not match what the run sent`);
            }
          }
          for (const child of step.children ?? []) {
            const childRows = await queryRows(child.table, `${child.parentColumn} = ${made.rowid}`, 2);
            if (childRows.length) {
              lines.push(`${step.label}: child ${child.field}: ${childRows.length === 2 ? '2+' : childRows.length} row in ${child.table}`);
            } else {
              failed = true;
              lines.push(`${step.label}: child ${child.field}: no row in ${child.table}`);
            }
          }
          for (const check of step.lookups ?? []) {
            const sent = submitted.get(step.form ?? '')?.[check.field];
            const ids = Array.isArray(sent) ? sent : sent != null ? [sent] : [];
            if (!ids.length) {
              lines.push(`${step.label}: lookup ${check.field}: skipped — no value submitted`);
              continue;
            }
            const res = await opts.fetch(`${fnBase}${check.endpoint}`, { method: 'GET', headers: fnHeaders() });
            const text = await res.text();
            let body: unknown = {};
            try {
              body = JSON.parse(text);
            } catch {
              /* non-JSON reply */
            }
            if (res.status < 200 || res.status >= 300) {
              failed = true;
              lines.push(`${step.label}: lookup ${check.field}: ${res.status} ${errText(body, text.slice(0, 200), auth)}`);
              continue;
            }
            const options = Array.isArray((body as Record<string, unknown>).rows) ? ((body as Record<string, unknown>).rows as Record<string, unknown>[]) : [];
            const missing = ids.filter((id) => {
              const option = options.find((entry) => String(entry?.ROWID ?? '') === String(id));
              return !option || String(option[check.display] ?? '') === '';
            });
            if (missing.length) {
              failed = true;
              lines.push(`${step.label}: lookup ${check.field}: no display for ${missing.length} id(s)`);
            } else {
              lines.push(`${step.label}: lookup ${check.field}: display resolved`);
            }
          }
          for (const check of step.files ?? []) {
            const res = await opts.fetch(`${fnBase}${check.filesPath}`, {
              method: 'POST',
              headers: { ...fnHeaders(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ rowId: made.rowid }),
            });
            const text = await res.text();
            let body: unknown = {};
            try {
              body = JSON.parse(text);
            } catch {
              /* non-JSON reply */
            }
            const url = body && typeof body === 'object' ? (body as Record<string, unknown>).url : undefined;
            if (res.status >= 200 && res.status < 300 && typeof url === 'string' && url) {
              lines.push(`${step.label}: file ${check.field}: key resolves`);
            } else {
              failed = true;
              lines.push(`${step.label}: file ${check.field}: ${res.status} ${errText(body, text.slice(0, 200), auth)}`);
            }
          }
          break;
        }
        case 'update': {
          const made = step.form ? created.get(step.form) : undefined;
          if (!made) {
            lines.push(`${step.label}: skipped — no row created`);
            break;
          }
          const update = step.update;
          if (!update) break;
          const markerField = step.marker?.field;
          if (!markerField) {
            lines.push(`${step.label}: skipped — no marker field to scope the update`);
            break;
          }
          const sent = update.value !== undefined ? update.value : `${String(submitted.get(step.form ?? '')?.[update.field] ?? `c2c smoke ${tag}`)} (updated)`;
          exercised += 1;
          const res = await opts.fetch(`${fnBase}${step.path}`, {
            method: step.method ?? 'POST',
            headers: { ...fnHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'update', form: step.form, rowId: made.rowid, marker: { field: markerField, tag: `c2c smoke ${tag}` }, fields: { [update.field]: sent } }),
          });
          const text = await res.text();
          let body: unknown = {};
          try {
            body = JSON.parse(text);
          } catch {
            /* non-JSON reply */
          }
          if (res.status < 200 || res.status >= 300) {
            failed = true;
            lines.push(`${step.label}: ${res.status} ${errText(body, text.slice(0, 200), auth)}`);
          } else if ((body as Record<string, unknown>)?.updated === true) {
            updateSent.set(step.form ?? '', { field: update.field, value: sent });
            lines.push(`${step.label}: ${res.status} updated`);
          } else {
            lines.push(`${step.label}: ${res.status} dry-run — nothing written`);
          }
          break;
        }
        case 'arithmetic': {
          const made = step.form ? created.get(step.form) : undefined;
          const markerField = step.marker?.field;
          if (!made || !step.arithmetic || !markerField) {
            lines.push(`${step.label}: skipped — no row created`);
            break;
          }
          exercised += 1;
          const res = await opts.fetch(`${fnBase}${step.path}`, {
            method: step.method ?? 'POST',
            headers: { ...fnHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'arith', form: step.form, rowId: made.rowid, marker: { field: markerField, tag: `c2c smoke ${tag}` }, field: step.arithmetic.field }),
          });
          const text = await res.text();
          let body: unknown = {};
          try {
            body = JSON.parse(text);
          } catch {
            /* non-JSON reply */
          }
          const reply = (body ?? {}) as Record<string, unknown>;
          if (res.status < 200 || res.status >= 300) {
            failed = true;
            lines.push(`${step.label}: ${res.status} ${errText(body, text.slice(0, 200), auth)}`);
          } else if (reply.arithmetic === true) {
            lines.push(`${step.label}: ${res.status} the live read is a number`);
          } else if (reply.dryRun === true) {
            lines.push(`${step.label}: ${res.status} dry-run — nothing checked`);
          } else {
            failed = true;
            lines.push(`${step.label}: ${res.status} ${errText(body, text.slice(0, 200), auth)}`);
          }
          break;
        }
        case 'report': {
          exercised += 1;
          const res = await opts.fetch(`${fnBase}${step.path}`, {
            method: step.method ?? 'POST',
            headers: { ...fnHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'query', page: 0, pageSize: 300 }),
          });
          const text = await res.text();
          let body: unknown = {};
          try {
            body = JSON.parse(text);
          } catch {
            /* non-JSON reply */
          }
          if (res.status < 200 || res.status >= 300) {
            failed = true;
            lines.push(`${step.label}: ${res.status} ${errText(body, text.slice(0, 200), auth)}`);
          } else {
            const rows = body && typeof body === 'object' ? (body as Record<string, unknown>).rows : undefined;
            if (!Array.isArray(rows)) {
              // A 2xx that is not the report's JSON shape — a sign-in page
              // answers 200 HTML — proves nothing.
              failed = true;
              lines.push(`${step.label}: ${res.status} but the answer is not the report shape`);
            } else {
              lines.push(`${step.label}: ${res.status} (${rows.length} rows)`);
            }
          }
          break;
        }
        case 'cleanup': {
          const made = step.form ? created.get(step.form) : undefined;
          if (!made) {
            lines.push(`${step.label}: skipped — nothing created`);
            break;
          }
          if (!verified.has(step.form ?? '')) {
            failed = true;
            lines.push(`${step.label}: skipped — read-back did not confirm row ${redactSmokeSecrets(made.rowid, auth)}; left in place`);
            break;
          }
          exercised += 1;
          const del = await zcql(`DELETE FROM ${step.table} WHERE ROWID = ${made.rowid}`);
          if (del.status < 200 || del.status >= 300) {
            failed = true;
            lines.push(`${step.label}: delete of row ${redactSmokeSecrets(made.rowid, auth)} answered ${del.status} — left in place`);
            break;
          }
          const rows = await queryRows(step.table as string, `ROWID = ${made.rowid}`);
          if (rows.length) {
            failed = true;
            lines.push(`${step.label}: row ${redactSmokeSecrets(made.rowid, auth)} still present after delete`);
          } else {
            deleted += 1;
            lines.push(`${step.label}: row ${redactSmokeSecrets(made.rowid, auth)} deleted (verified gone)`);
          }
          break;
        }
        case 'skip':
          lines.push(`${step.label}: ${step.reason}`);
          break;
      }
    } catch (err) {
      failed = true;
      lines.push(`${step.label}: failed — ${redactSmokeSecrets(err instanceof Error ? err.message : String(err), auth)}`);
    }
    if (step.kind === 'session' && !opts.browserSession && !auth.token && !auth.cookie) {
      lines.push('auth: none — every call would answer 401 (sign in required); pass --auth-token <token> or --session-cookie <name=value>');
      lines.push(`created ${created.size}, deleted ${deleted}, left ${created.size - deleted}`);
      return { ok: false, lines };
    }
  }
  lines.push(`created ${created.size}, deleted ${deleted}, left ${created.size - deleted}`);
  // A run that touched nothing — every step skipped, or every submit answered
  // dry-run — verified nothing; it is a failure, not a pass.
  if (exercised === 0) {
    lines.push('run: nothing was exercised — every step was skipped');
    return { ok: false, lines };
  }
  if (submits > 0 && created.size === 0) {
    lines.push('run: nothing was exercised — every submit was skipped or wrote nothing');
    return { ok: false, lines };
  }
  return { ok: !failed && created.size === deleted, lines };
}
