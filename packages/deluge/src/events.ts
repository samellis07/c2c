/**
 * Async on-success lane (opt-in `asyncOnSuccess`).
 *
 * Catalyst event functions have no documented automatic retry: a failed
 * execution is filed as failed and the event is gone. The emitted after-commit
 * module therefore writes a failure marker to the `C2CEventDeadLetter` support
 * table before it closes with failure, and a second Job function sweeps
 * pending markers and re-drives the same scripts. The deploy creates the table
 * only for an app that emits event functions (docs/table-budget.md), mirroring
 * how `c2c_mail_log` exists only for a mail deploy.
 *
 * Under the same opt-in the live submit endpoints store the row and reply
 * without running the on-success scripts; the record trigger fires this
 * module instead, with per-module replay limits. See docs/event-deadletter.md.
 */
import type { App } from '../../core/src/ir.js';
import type { SchemaPlan } from '../../schema/src/generator.js';
import { EVENT_SWEEP_BUDGET_MINUTES, EVENT_SWEEP_PERIOD_MINUTES, EVENT_SWEEPER_MODULE, eventSweeperCron, JOB_LIVE_IMPORTS, jobLiveHelpers } from './schedules.js';

/** Support table for event-function failure markers; deploy creates it only with event functions. */
export const DEAD_LETTER_TABLE = 'C2CEventDeadLetter';
/** Re-drive attempts before a marker is discarded. */
export const DEAD_LETTER_MAX_ATTEMPTS = 5;
/** Minimal envelope version stored in dead-letter markers (record id only, never record data). */
export const DEAD_LETTER_ENVELOPE_VERSION = 2;
export const EVENT_FUNCTION_MODULE = 'events/after-commit.mjs';
const EVENT_SWEEP_PAGE = 50;

/** Per-module completion ledger: one row per envelope key per success module that ran to completion. */
export const PROCESSED_TABLE = 'C2CEventProcessed';

/** Column create rows for the completion ledger (deploy-side, like the dead-letter table). */
export const PROCESSED_COLUMNS: readonly { name: string; type: 'varchar'; unique?: boolean; mandatory?: boolean }[] = [
  { name: 'Event_Key', type: 'varchar', mandatory: true },
  { name: 'Spec', type: 'varchar', mandatory: true },
  { name: 'State', type: 'varchar' },
  { name: 'Finished_At', type: 'varchar' },
];

/**
 * The migration-report warning the opt-in lane raises. The deploy prints the
 * same text in its plan (plan.ts) so an unwired lane is visible there too.
 */
export const ASYNC_ON_SUCCESS_WARNING = {
  construct: 'event-async-onsuccess',
  name: 'on success',
  note: 'Async on-success is opt-in: the submit endpoints store the row and reply without running the on-success modules; the after-commit event function runs them when the record trigger fires, and failures dead-letter to C2CEventDeadLetter for the sweep Job. Deletes stay synchronous. Until a record trigger (event listener or Signals rule) is wired per table and action, on-success actions do not run live (docs/event-deadletter.md).',
} as const;

/**
 * Named refusal when `--async-on-success` meets a workflow the lane cannot
 * defer. Anything whose result affects the response stays synchronous: either
 * the deploy runs without the flag, or the workflow is rewritten to
 * fire-and-forget work (mail, notifications) first.
 */
export class AsyncOnSuccessRefusedError extends Error {
  readonly code = 'ASYNC_ON_SUCCESS_RESPONSE_SENSITIVE';
  readonly workflows: readonly string[];
  constructor(workflows: readonly { name: string; reason: string }[]) {
    super(
      `async on-success refused for ${workflows.length} workflow${workflows.length === 1 ? '' : 's'}: ` +
        workflows.map((w) => `${w.name} (${w.reason})`).join('; ') +
        '. Remove --async-on-success or rewrite these workflows to fire-and-forget work (docs/event-deadletter.md).',
    );
    this.name = 'AsyncOnSuccessRefusedError';
    this.workflows = workflows.map((w) => w.name);
  }
}

export interface AsyncCandidate {
  /** Workflow display name for the refusal message. */
  name: string;
  /** Translated server body of the emitted on-success module. */
  server: string;
  /** Translated client body of the client handler sibling. */
  client: string;
  /** Raw Deluge source (for `return` detection inside nested blocks). */
  deluge: string;
}

/**
 * Classify one on-success workflow for the async lane. Anything whose result
 * affects the response is refused: cancellations change the reply status,
 * client actions (info/alert/openUrl/show/hide) are user-visible, a returned
 * value becomes the reply `result`, and a triggering-record write becomes the
 * reply `values`. Cross-form store writes keep their response bytes and may
 * defer; the per-module completion ledger (C2CEventProcessed) fences their
 * replay instead. Reads and external effects (mail, notifications) defer.
 */
export function classifySuccessForAsync(candidate: AsyncCandidate): { deferrable: true } | { deferrable: false; reason: string } {
  if (/shim\.validate\.cancel(Submit|Delete)/.test(candidate.server)) {
    return { deferrable: false, reason: 'it can cancel the submit, which changes the reply status' };
  }
  if (/actions\.push/.test(candidate.client)) {
    return { deferrable: false, reason: 'it has user-visible client actions (info/alert/openUrl/show/hide), which the deferred reply cannot carry' };
  }
  if (/(^|\n)return\s+[^;\s]/.test(candidate.server) || hasValuedReturn(candidate.deluge)) {
    return { deferrable: false, reason: 'it returns a value, which becomes the reply result' };
  }
  if (/shim\.(input|record)\.set\(/.test(candidate.server)) {
    return { deferrable: false, reason: 'it writes the triggering record, which becomes the reply values' };
  }
  return { deferrable: true };
}

function hasValuedReturn(deluge: string): boolean {
  const stripped = deluge
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return /^\s*return\s+\S/m.test(stripped);
}

/** Throw AsyncOnSuccessRefusedError when any candidate cannot defer. */
export function assertAsyncSuccessDeferrable(candidates: readonly AsyncCandidate[]): void {
  const refused = candidates.flatMap((candidate) => {
    const verdict = classifySuccessForAsync(candidate);
    return verdict.deferrable ? [] : [{ name: candidate.name, reason: verdict.reason }];
  });
  if (refused.length) throw new AsyncOnSuccessRefusedError(refused);
}

/** Column create rows for the dead-letter support table (deploy-side, like the mail log). */
export const DEAD_LETTER_COLUMNS: readonly { name: string; type: 'varchar' | 'text' | 'int'; unique?: boolean; mandatory?: boolean }[] = [
  { name: 'Event_Key', type: 'varchar', unique: true, mandatory: true },
  { name: 'Form', type: 'varchar' },
  { name: 'Action', type: 'varchar' },
  { name: 'Record_ID', type: 'varchar' },
  { name: 'Target', type: 'varchar' },
  { name: 'State', type: 'varchar' },
  { name: 'Attempts', type: 'int' },
  { name: 'Error', type: 'text' },
  { name: 'Envelope', type: 'text' },
  { name: 'First_Failed', type: 'varchar' },
  { name: 'Last_Failed', type: 'varchar' },
];

export interface SuccessSpecs {
  form: string;
  add: string[];
  edit: string[];
  del: string[];
}

/**
 * The on-success sibling modules of each form, exactly the modules the submit
 * and delete stubs run after the row write. Spec paths are relative to
 * `functions/events/`, the emitted event module's directory.
 */
export function successSpecs(files: readonly { path: string; source: string }[]): SuccessSpecs[] {
  const byForm = new Map<string, { add: string[]; edit: string[]; del: string[] }>();
  for (const file of files) {
    const parts = file.path.split('/');
    if (parts.length !== 4 || parts[0] !== 'functions' || parts[1] !== 'aio' || !file.path.endsWith('.mjs')) continue;
    const form = parts[2]!;
    const match = /path:\s*"([^"]+)"/.exec(file.source);
    const isSuccess = !!match?.[1].endsWith('/success');
    const isDeleteScript = !!match?.[1].endsWith('/delete-script');
    if (!isSuccess && !isDeleteScript) continue;
    const rec = /export const recordEvent = (null|"[^"]*");/.exec(file.source);
    const merged = /export const recordEvents = (\[[^\]]*\]);/.exec(file.source);
    const scopes = merged
      ? (JSON.parse(merged[1]) as string[]).map((scope) => scope.toLowerCase())
      : [rec?.[1] && rec[1] !== 'null' ? JSON.parse(rec[1]).toLowerCase() : ''];
    const spec = `../aio/${form}/${parts[3]}`;
    const bucket = byForm.get(form) ?? { add: [], edit: [], del: [] };
    if (isDeleteScript) {
      // The on-delete script runs after every delete; a module whose scripts
      // are all add/edit-scoped is not reachable through the delete path
      // (mirrors siblingSpecs).
      if (scopes.some((scope) => scope !== 'on add' && scope !== 'on edit')) bucket.del.push(spec);
    } else {
      for (const scope of scopes) {
        if (scope === 'on add') bucket.add.push(spec);
        else if (scope === 'on edit') bucket.edit.push(spec);
        else if (scope === 'on delete') bucket.del.push(spec);
        else {
          bucket.add.push(spec);
          bucket.edit.push(spec);
        }
      }
    }
    byForm.set(form, bucket);
  }
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...byForm.entries()]
    .sort((a, b) => byName(a[0], b[0]))
    .map(([form, lists]) => ({
      form,
      add: [...new Set(lists.add)].sort(byName),
      edit: [...new Set(lists.edit)].sort(byName),
      del: [...new Set(lists.del)].sort(byName),
    }));
}

/** `functions/c2c-deadletter.mjs`: the marker store the event function and the sweeper share. */
export function deadLetterModule(): string {
  return `// Dead-letter store for event-function failures. One row per failed
// after-commit event, keyed by Event_Key so a redelivered event updates rather
// than duplicates. The deploy creates ${DEAD_LETTER_TABLE} only for an app that
// emits event functions (async on-success opt-in); without the table every
// call throws, which is what the event function wants before closeWithFailure.
// Marker fields are clipped so a hostile record cannot grow a row unbounded.
// The stored envelope carries only the record id, never record data.
// The same file owns the per-module completion ledger (${PROCESSED_TABLE}):
// one row per envelope key per success module that ran to completion. This is
// at-least-once per module: side effects within a failed module can repeat.

export const DEAD_LETTER_TABLE = ${JSON.stringify(DEAD_LETTER_TABLE)};
export const DEAD_LETTER_MAX_ATTEMPTS = ${DEAD_LETTER_MAX_ATTEMPTS};

function clip(value, max) {
  const text = value === undefined || value === null ? "" : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

function quote(value) {
  return String(value).replace(/'/g, "''");
}

export function markerKey(parts) {
  const short = (value) => clip(value === undefined || value === null || value === "" ? "-" : String(value), 60);
  const base = [short(parts.form), short(parts.action), short(parts.recordId), short(parts.eventTime)].join("/");
  if (parts.eventTime) return clip(base, 255);
  // Without event_time two firings are indistinguishable: never collapse them
  // into one marker. The suffix makes redelivery dedup best-effort, while
  // distinct firings always stay distinct.
  return clip(base + "/" + Date.now().toString(36) + Math.floor(Math.random() * 2176782336).toString(36), 255);
}

export const PROCESSED_TABLE = ${JSON.stringify(PROCESSED_TABLE)};

export async function isProcessed(datastore, key, spec) {
  const rows = await datastore.query(PROCESSED_TABLE, \`Event_Key = '\${quote(clip(key, 255))}' AND Spec = '\${quote(clip(spec, 255))}'\`, 1, 0, "ORDER BY ROWID");
  return Array.isArray(rows) && rows.length > 0;
}

export async function markProcessed(datastore, key, spec) {
  if (await isProcessed(datastore, key, spec)) return { key, spec, duplicate: true };
  await datastore.insert(PROCESSED_TABLE, [{
    Event_Key: clip(key, 255),
    Spec: clip(spec, 255),
    State: "done",
    Finished_At: new Date().toISOString(),
  }]);
  return { key, spec, inserted: true };
}

export async function updateFailureEnvelope(datastore, key, envelope) {
  const rows = await datastore.query(DEAD_LETTER_TABLE, \`Event_Key = '\${quote(clip(key, 255))}'\`, 1, 0, "ORDER BY ROWID");
  const row = Array.isArray(rows) ? rows[0] : null;
  if (row && typeof row === "object") await datastore.update(DEAD_LETTER_TABLE, [{ ROWID: row.ROWID, Envelope: clip(JSON.stringify(envelope), 16000) }]);
}

export async function recordFailure(datastore, marker) {
  const key = clip(marker.key, 255);
  const now = new Date().toISOString();
  const rows = await datastore.query(DEAD_LETTER_TABLE, \`Event_Key = '\${quote(key)}'\`, 1, 0, "ORDER BY ROWID");
  const row = Array.isArray(rows) ? rows[0] : null;
  // A second failure of the same event re-arms the marker instead of stacking rows.
  if (row && typeof row === "object") {
    await datastore.update(DEAD_LETTER_TABLE, [{ ROWID: row.ROWID, State: "pending", Error: clip(marker.error, 8000), Envelope: clip(marker.envelope, 16000), Last_Failed: now }]);
    return { key, updated: true, rowId: row.ROWID };
  }
  await datastore.insert(DEAD_LETTER_TABLE, [{
    Event_Key: key,
    Form: clip(marker.form, 255),
    Action: clip(marker.action, 255),
    Record_ID: clip(marker.recordId, 255),
    Target: clip(marker.target || ${JSON.stringify(EVENT_FUNCTION_MODULE)}, 255),
    State: "pending",
    Attempts: 0,
    Error: clip(marker.error, 8000),
    Envelope: clip(marker.envelope, 16000),
    First_Failed: now,
    Last_Failed: now,
  }]);
  return { key, inserted: true };
}

export async function listPending(datastore, limit, afterRowId) {
  const where = \`State = 'pending'\` + (afterRowId ? \` AND ROWID > '\${quote(afterRowId)}'\` : "");
  const rows = await datastore.query(DEAD_LETTER_TABLE, where, limit, 0, "ORDER BY ROWID");
  return Array.isArray(rows) ? rows : [];
}

export async function markResolved(datastore, row) {
  await datastore.update(DEAD_LETTER_TABLE, [{ ROWID: row.ROWID, State: "resolved", Last_Failed: new Date().toISOString() }]);
  return { state: "resolved" };
}

export async function failAttempt(datastore, row, error) {
  const attempts = Number(row.Attempts || 0) + 1;
  const state = attempts >= DEAD_LETTER_MAX_ATTEMPTS ? "discarded" : "pending";
  await datastore.update(DEAD_LETTER_TABLE, [{ ROWID: row.ROWID, Attempts: attempts, State: state, Error: clip(error && error.message ? error.message : error, 8000), Last_Failed: new Date().toISOString() }]);
  return { attempts, state };
}
`;
}

/**
 * `functions/events/after-commit.mjs`: the Catalyst Event function template.
 * Runs the same on-success sibling modules the submit/delete stubs run, then
 * dead-letters any failure instead of losing it. `replay` is the sweep's
 * re-drive entry; `handle` is shared by both.
 */
export function afterCommitModule(opts: { app: App; banner: (lines: string[]) => string; specs: SuccessSpecs[]; schema?: SchemaPlan; runtimeOptions?: string }): string {
  const specMap = Object.fromEntries(opts.specs.map((entry) => [entry.form, { add: entry.add, edit: entry.edit, del: entry.del }]));
  const tables = Object.fromEntries((opts.schema?.tables ?? []).filter((table) => table.role === 'form').map((table) => [table.name, table.form ?? table.name]));
  return `${opts.banner([
    'After-commit event function (Catalyst Event function, async on-success opt-in).',
    'Runs the same on-success modules the synchronous submit endpoints deferred,',
    'for insert and update events, selected by the record event in the trigger',
    'payload. Wire one record trigger (event listener rule or Signals rule)',
    'per table per action to this function; until a trigger exists the deferred',
    'actions never run. The live submit endpoint no longer runs them, so a wired',
    'trigger cannot double them. Deletes stay synchronous in the delete endpoint;',
    'this lane never serves them. See docs/event-deadletter.md.',
    'Event functions have no documented automatic retry: on failure this writes a',
    `marker to ${DEAD_LETTER_TABLE} and the ${EVENT_SWEEPER_MODULE} Job re-drives it.`,
    'The marker envelope carries only the record id (form, table, action, row',
    'id, event time) — never record data — and each replay reloads the row from',
    'the store. A redelivered event that already ran a module skips it via the',
    `per-module completion ledger (${PROCESSED_TABLE}). Delivery is at-least-once`,
    'per script within a merged module: completed scripts are skipped on replay;',
    'effects within a failing script can repeat.',
    'The event payload shape is the documented envelope {data{row,table_details},',
    'action,event_time}; fields not present are tolerated as empty.',
    'This file is not an HTTP route. No client can call it.',
  ])}${JOB_LIVE_IMPORTS}import { createRuntime } from "creator-to-catalyst/shims";
import { isProcessed, markProcessed, updateFailureEnvelope, markerKey, recordFailure, DEAD_LETTER_TABLE } from "../c2c-deadletter.mjs";

export const endpoint = { type: "event" };
export const deadLetterTable = DEAD_LETTER_TABLE;
${jobLiveHelpers()}
const SPECS = ${JSON.stringify(specMap, null, 2)};
const TABLES = ${JSON.stringify(tables, null, 2)};

function dataOf(event) {
  let raw = null;
  try {
    raw = event && typeof event.getData === "function" ? event.getData() : null;
  } catch (err) {
    raw = null;
  }
  let data = raw;
  if (Array.isArray(raw)) {
    const item = raw[0] && typeof raw[0] === "object" ? raw[0] : {};
    data = item && typeof item.data === "object" && item.data !== null ? item.data : item;
  }
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

function tableOf(event, data) {
  const details = data && typeof data.table_details === "object" && data.table_details !== null ? data.table_details : {};
  const named = details.table_name || details.name || data.table_name || data.table || "";
  if (named) return String(named);
  try {
    const id = event && typeof event.getSourceEntityId === "function" ? event.getSourceEntityId() : "";
    if (id) return String(id);
  } catch (err) {
    /* no source entity on this payload */
  }
  return "";
}

function recordOf(data) {
  if (data && typeof data.row === "object" && data.row !== null) return data.row;
  if (data && typeof data.record === "object" && data.record !== null) return data.record;
  const out = {};
  for (const key of Object.keys(data)) {
    if (key === "table_details" || key === "event_config" || key === "action") continue;
    out[key] = data[key];
  }
  return out;
}

function actionOf(event, data) {
  let raw = "";
  try {
    raw = event && typeof event.getAction === "function" ? String(event.getAction() || "") : "";
  } catch (err) {
    raw = "";
  }
  const s = (raw || String((data && (data.action ?? data.event)) ?? "")).toLowerCase();
  if (/insert|create|add/.test(s)) return "add";
  if (/update|edit/.test(s)) return "edit";
  if (/delete|del/.test(s)) return "del";
  return "";
}

function eventTimeOf(event) {
  try {
    const t = event && typeof event.getTime === "function" ? event.getTime() : "";
    return t === undefined || t === null ? "" : String(t);
  } catch (err) {
    return "";
  }
}

function rowIdOf(record) {
  const row = record && typeof record === "object" ? record : {};
  if (row.ROWID != null && row.ROWID !== "") return String(row.ROWID);
  if (row.ID != null && row.ID !== "") return String(row.ID);
  return "";
}

function quote(value) {
  return String(value).replace(/'/g, "''");
}

// The persisted envelope: identity only, never record data. The row is
// reloaded from the store on every replay, so no names, contact details,
// free text, or other PII ever rest in the dead-letter table.
function envelopeOf(event) {
  const data = dataOf(event);
  const table = tableOf(event, data);
  const form = TABLES[table] || table;
  const rowId = rowIdOf(recordOf(data));
  const action = actionOf(event, data);
  const eventTime = eventTimeOf(event);
  const key = markerKey({ form, action, recordId: rowId, eventTime });
  return { v: ${DEAD_LETTER_ENVELOPE_VERSION}, key, form, table, action, rowId, eventTime };
}

function formSlug(name) {
  return String(name || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "handler";
}

function specsFor(form, action) {
  // SPECS is keyed by the form's directory slug; the trigger names the table
  // or the Creator form, so both spellings resolve here. Deletes stay
  // synchronous in the delete endpoint, so this lane never serves them: a
  // delete event (or an unknown action) runs nothing here.
  if (action !== "add" && action !== "edit") return [];
  const entry = SPECS[form] || SPECS[formSlug(form)];
  if (!entry) return [];
  if (action === "add") return entry.add;
  return entry.edit;
}

async function loadRow(datastore, form, table, rowId) {
  const store = form || table;
  if (!store || !rowId) throw new Error("dead-letter envelope has no row to replay");
  const rows = await datastore.query(store, \`ROWID = '\${quote(rowId)}'\`, 1, 0, "ORDER BY ROWID");
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || typeof row !== "object") throw new Error(\`dead-letter row is gone: \${store}/\${rowId}; the committed row no longer exists\`);
  return row;
}

// Shared by the live listener and the sweep's re-drive. A completed module is
// skipped for its envelope key; effects inside a module can repeat if it
// fails or stops before the completion row is written.
export async function handle(ctx, env, opts) {
  const key = env && env.key ? String(env.key) : "";
  const store = opts && opts.datastore ? opts.datastore : null;
  for (const spec of specsFor(env && env.form, env && env.action)) {
    if (store && key && (await isProcessed(store, key, spec))) continue;
    const mod = await import(spec);
    if (mod && typeof mod.handle === "function") {
      ctx.shim.__c2cScript = async (index, run) => {
        const progress = Number(env && env.progress && env.progress[spec]) || 0;
        if (index < progress) return;
        await run();
        if (!env.progress) env.progress = {};
        env.progress[spec] = index + 1;
        if (store && key) await updateFailureEnvelope(store, key, env);
      };
      try {
        await mod.handle(ctx);
      } catch (err) {
        if (err && err.code === "SUBMIT_REFUSED") {
          // A cancellation is terminal for this form event: subsequent scripts
          // must not run after the submit has been refused.
          return { cancelled: true, spec };
        }
        throw err;
      }
    }
    if (store && key) await markProcessed(store, key, spec);
  }
}

// The sweeper's re-drive: reload the committed row by id and run the same
// spec list. The stored envelope never carries record data
// (v${DEAD_LETTER_ENVELOPE_VERSION}); a legacy envelope that still embeds one
// has its record ignored.
export async function replay(envelope, opts) {
  const datastore = opts && opts.datastore ? opts.datastore : null;
  if (!datastore) throw new Error("live datastore is not configured");
  const deploy = deployConfig();
  const appTimeZone = process.env.C2C_APP_TIMEZONE || (opts && opts.appTimeZone) || deploy.appTimeZone || undefined;
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone${opts.runtimeOptions ?? ''},
    datastore, ...(datastore.now ? { now: datastore.now } : {}),
  });
  const env = envelope && typeof envelope === "object" ? { ...envelope } : {};
  env.key = env.key ? String(env.key) : markerKey({ form: env.form, action: env.action, recordId: env.rowId, eventTime: env.eventTime });
  if (!env.progress || typeof env.progress !== "object") env.progress = {};
  const record = await loadRow(datastore, env.form, env.table, env.rowId ? String(env.rowId) : "");
  const ctx = runtime.context({ record, old: record, rowId: env.rowId ? String(env.rowId) : "", appTimeZone });
  // The event fires after the commit: the row is already stored, so the
  // system-stamp guard must not re-stamp and a script throw is a post-write
  // failure, the same as in the synchronous endpoint.
  ctx.persisted = true;
  // The full envelope goes into handle: progress merges into it, so a
  // mid-replay failure persists an envelope the next sweep can still reload.
  return handle(ctx, env, { datastore });
}

export default async function listener(event, context) {
  const deploy = deployConfig();
  const live = deploy.mode === "live";
  const datastore = live ? await liveDatastore() : null;
  if (live && !datastore) {
    if (context && typeof context.closeWithFailure === "function") context.closeWithFailure();
    throw new Error("live datastore is not configured");
  }
  const appTimeZone = process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined;
  const runtime = createRuntime({
    dryRun: !live,
    appTimeZone${opts.runtimeOptions ?? ''},
    ...(datastore ? { datastore, ...(datastore.now ? { now: datastore.now } : {}) } : {}),
  });
  const env = envelopeOf(event);
  const specs = specsFor(env.form, env.action);
  if (!specs.length) {
    if (context && typeof context.closeWithSuccess === "function") context.closeWithSuccess();
    return { dryRun: !live, event: env, skipped: true };
  }
  // Live runs the committed row, reloaded by id: the trigger payload is only
  // an identity hint, never trusted record content. Dry run has no store, so
  // it runs the payload row inline and writes no marker.
  const data = dataOf(event);
  try {
    // Inside the try so a gone row dead-letters like any other post-write
    // failure instead of escaping without a marker.
    const record = live ? await loadRow(datastore, env.form, env.table, env.rowId) : recordOf(data);
    const ctx = runtime.context({ record, old: record, rowId: env.rowId, appTimeZone });
    // The row was committed before this event fired: keep persisted set so the
    // system-stamp guard does not re-stamp it.
    ctx.persisted = true;
    await handle(ctx, env, { datastore });
    if (context && typeof context.closeWithSuccess === "function") context.closeWithSuccess();
    return { dryRun: !live, event: env, transcript: live ? undefined : runtime.transcript };
  } catch (err) {
    let marker = null;
    if (datastore) {
      try {
        marker = await recordFailure(datastore, {
          key: env.key,
          form: env.form,
          action: env.action,
          recordId: env.rowId,
          error: err && err.message ? err.message : String(err),
          envelope: JSON.stringify(env),
        });
      } catch (markerErr) {
        marker = { error: markerErr && markerErr.message ? markerErr.message : String(markerErr) };
      }
    }
    if (context && typeof context.closeWithFailure === "function") context.closeWithFailure();
    if (!live) return { dryRun: true, event: env, marker, error: err && err.message ? err.message : String(err), transcript: runtime.transcript };
    throw err;
  }
}
`;
}

/** `functions/job/c2c-event-sweeper.mjs`: re-drives pending dead-letter markers on a cron. */
export function eventSweeperModule(opts: { app: App; banner: (lines: string[]) => string; runtimeOptions?: string }): string {
  return `${opts.banner([
    'Dead-letter sweep (Catalyst Job function).',
    `The ${EVENT_SWEEP_PERIOD_MINUTES}-minute cron re-drives every pending ${DEAD_LETTER_TABLE}`,
    'marker through the target module its Target column names, then marks it',
    `resolved; a failure re-arms it and ${DEAD_LETTER_MAX_ATTEMPTS} failures discard it.`,
    `A run stops after ${EVENT_SWEEP_BUDGET_MINUTES} minutes so two sweeps never overlap.`,
    'This file is not an HTTP route. No client can call it.',
    'Dry run unless deploy mode is live (c2c-deploy.json or C2C_DEPLOY_MODE) and a datastore is configured.',
  ])}${JOB_LIVE_IMPORTS}import { DEAD_LETTER_TABLE, DEAD_LETTER_MAX_ATTEMPTS, failAttempt, listPending, markResolved } from "../c2c-deadletter.mjs";

export const cron = ${JSON.stringify(eventSweeperCron(opts.app))};

${jobLiveHelpers()}
export async function sweep(jobRequest, req) {
  const deploy = deployConfig();
  const live = deploy.mode === "live";
  if (!live) {
    return { dryRun: true, table: DEAD_LETTER_TABLE, maxAttempts: DEAD_LETTER_MAX_ATTEMPTS, swept: 0, resolved: 0, retried: 0, discarded: 0 };
  }
  const datastore = await liveDatastore();
  if (!datastore) throw new Error("live datastore is not configured");
  const deadline = Date.now() + ${EVENT_SWEEP_BUDGET_MINUTES} * 60 * 1000;
  const appTimeZone = process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined;
  const report = { dryRun: false, swept: 0, resolved: 0, retried: 0, discarded: 0, stopped: false, pending: false };
  let cursor = "";
  outer: while (Date.now() < deadline) {
    const rows = await listPending(datastore, ${EVENT_SWEEP_PAGE}, cursor);
    if (!rows.length) break;
    for (const row of rows) {
      if (row && row.ROWID != null) cursor = String(row.ROWID);
      report.swept++;
      try {
        const target = row && typeof row.Target === "string" && row.Target ? row.Target : ${JSON.stringify(EVENT_FUNCTION_MODULE)};
        const mod = await import("../" + target);
        if (!mod || typeof mod.replay !== "function") throw new Error(\`dead-letter target \${target} has no replay\`);
        const envelope = typeof row.Envelope === "string" && row.Envelope ? JSON.parse(row.Envelope) : {};
        await mod.replay(envelope, { datastore, appTimeZone });
        await markResolved(datastore, row);
        report.resolved++;
      } catch (err) {
        const out = await failAttempt(datastore, row, err);
        if (out.state === "discarded") report.discarded++;
        else report.retried++;
      }
      if (Date.now() >= deadline) {
        report.stopped = true;
        break outer;
      }
    }
  }
  report.pending = (await listPending(datastore, 1, "")).length > 0;
  return report;
}

export default async function job(jobRequest, context) {
  return closing(context, () => sweep(jobRequest, context));
}
`;
}
