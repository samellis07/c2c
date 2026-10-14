/**
 * Creator schedules → Catalyst Job Scheduling.
 *
 * - A custom schedule (`start = "2017-01-03 09:30:00"`, `frequency = daily`)
 *   becomes one pre-defined cron. A repeating one is a CronExpression; one with
 *   no frequency is OneTime at the start instant.
 * - A form schedule (`form = X`, `start = before 1 days from Due_Date at "09:00:00"`)
 *   becomes a sweep spec. One sweeper Job per app runs every
 *   {@link SWEEP_PERIOD_MINUTES} minutes and fires the rows that came due
 *   (shims/jobs.ts: ZCQL paging, checkpoints).
 *
 * Names are deterministic: `c2c_<schedule>` with every run of characters other
 * than [A-Za-z0-9] as `_` (Catalyst cron and job names reject hyphens), deduped
 * in workflow order. The job modules run live only in live deploy mode
 * (c2c-deploy.json `mode: "live"` or C2C_DEPLOY_MODE=live) with a configured
 * datastore. Otherwise they stay a dry run.
 *
 * Shapes accepted:
 * frequency daily / weekly / monthly / yearly / none, and
 * `start = [before|after N minutes|hours|days|weeks from] Field [at "HH:mm:ss"]`.
 * Anything else is a TODO, never a guessed cron.
 */
import {
  FORM_SCHEDULE_FREQUENCIES,
  FORM_SCHEDULE_START_RE,
  formScheduleSweepGap,
  scheduleAnchorFieldType,
  scheduleTimeZone,
  unquote,
  workflowProp,
  type App,
  type Workflow,
} from '../../core/src/ir.js';
import { epochMillis, parseLiteral, type DelugeDate } from '../../shims/src/date.js';
import type { FormScheduleSpec, OffsetUnit, Repeat } from '../../shims/src/jobs.js';
import { jobPoolName } from '../../shims/src/runtime.js';

export const SWEEP_PERIOD_MINUTES = 5;
/** Below the period, so two sweeps never overlap. Job functions allow 15 min. */
export const SWEEP_BUDGET_MINUTES = 4;
export const CHECKPOINT_TABLE = 'C2CJobCheckpoint';
/** One Catalyst Job function hosts every job of the app; `params.module` picks the file. */
export const JOB_TARGET = 'c2c_jobs';
export const SWEEPER_MODULE = 'c2c-form-sweeper';
const SWEEPER_CRON = 'c2c_form_sweeper';

export interface CronDefinition {
  cron_name: string;
  cron_status: boolean;
  cron_type: 'OneTime' | 'Periodic' | 'CronExpression';
  cron_detail: Record<string, string | number>;
  job_meta: {
    job_name: string;
    target_type: 'Function';
    target_name: string;
    jobpool_name: string;
    params: { module: string };
    job_config: { number_of_retries: number; retry_interval: number };
  };
  /** Not sent to Catalyst: the Creator source the cron came from. */
  c2c: { timeZone: string | null; start: string | null; frequency: string | null };
}

export type SchedulePlan =
  | { kind: 'custom'; module: string; cron: CronDefinition | null; gap: string | null }
  | { kind: 'form'; module: string; sweep: FormScheduleSpec | null; gap: string | null };

function cronName(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'schedule';
}

function moduleSlug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'handler';
}

/** The five-field expression of a repeating custom schedule, from its start wall time. */
export function cronExpression(start: DelugeDate, frequency: string): string | null {
  const dow = new Date(Date.UTC(start.y, start.m - 1, start.d)).getUTCDay();
  if (frequency === 'daily') return `${start.mm} ${start.hh} * * *`;
  if (frequency === 'weekly') return `${start.mm} ${start.hh} * * ${dow}`;
  if (frequency === 'monthly') return `${start.mm} ${start.hh} ${start.d} * *`;
  if (frequency === 'yearly') return `${start.mm} ${start.hh} ${start.d} ${start.m} *`;
  return null;
}

function jobMeta(name: string, pool: string, module: string, retries: number) {
  return {
    job_name: name,
    target_type: 'Function' as const,
    target_name: JOB_TARGET,
    jobpool_name: pool,
    params: { module: `job/${module}.mjs` },
    job_config: { number_of_retries: retries, retry_interval: 60_000 },
  };
}

function planCustom(app: App, w: Workflow, name: string, pool: string, module: string): SchedulePlan {
  const zone = scheduleTimeZone(app, w);
  const rawStart = workflowProp(w, 'start');
  const frequency = workflowProp(w, 'frequency')?.toLowerCase() ?? null;
  const c2c = { timeZone: zone, start: rawStart ? unquote(rawStart) : null, frequency };
  const status = workflowProp(w, 'status')?.toLowerCase() !== 'inactive';
  let start: DelugeDate | null = null;
  try {
    start = rawStart && /^"/.test(rawStart) ? parseLiteral(unquote(rawStart)) : null;
  } catch {
    start = null;
  }
  if (!start) return { kind: 'custom', module, cron: null, gap: 'schedule-start' };
  // Creator schedules do not retry; a retry could repeat side effects.
  const def = (cron_type: CronDefinition['cron_type'], cron_detail: CronDefinition['cron_detail']): CronDefinition => ({
    cron_name: name,
    cron_status: status,
    cron_type,
    cron_detail,
    job_meta: jobMeta(name, pool, module, 0),
    c2c,
  });
  if (frequency === null || frequency === 'once') {
    if (!zone) return { kind: 'custom', module, cron: null, gap: 'schedule-time-zone' };
    return { kind: 'custom', module, cron: def('OneTime', { time_of_execution: String(epochMillis(start, zone)) }), gap: null };
  }
  const expression = FORM_SCHEDULE_FREQUENCIES.has(frequency) ? cronExpression(start, frequency) : null;
  if (!expression) return { kind: 'custom', module, cron: null, gap: 'schedule-frequency' };
  return { kind: 'custom', module, cron: def('CronExpression', { cron_expression: expression }), gap: null };
}

function planForm(app: App, w: Workflow, name: string, form: string, criteria: FormScheduleSpec['criteria'] | null, module: string): SchedulePlan {
  const gap = (g: string): SchedulePlan => ({ kind: 'form', module, sweep: null, gap: g });
  // The schema planner reads the same gap check, so the checkpoint table exists
  // exactly when this returns a sweep.
  const fail = formScheduleSweepGap(app, w, criteria !== null);
  if (fail) return gap(fail);
  const m = FORM_SCHEDULE_START_RE.exec(workflowProp(w, 'start') ?? '')!;
  const field = m[4]!;
  const type = scheduleAnchorFieldType(app, form, field)!;
  const zone = scheduleTimeZone(app, w)!;
  const frequency = workflowProp(w, 'frequency')?.toLowerCase();
  const end = workflowProp(w, 'end');
  const unit = (m[3] ? m[3].replace(/s?$/, 's') : 'days') as OffsetUnit;
  const amount = m[2] ? Number(m[2]) * (m[1] === 'before' ? -1 : 1) : 0;
  const at = m[5] ? `${m[5].padStart(2, '0')}:${m[6]}:${m[7] ?? '00'}` : undefined;
  const sweep: FormScheduleSpec = {
    name,
    form,
    field,
    fieldType: type,
    offset: { amount, unit },
    ...(at ? { at } : {}),
    ...(frequency ? { repeat: frequency as Repeat } : {}),
    ...(end ? { end } : {}),
    ...(criteria ? { criteria } : {}),
    timeZone: zone,
  };
  return { kind: 'form', module, sweep, gap: null };
}

/**
 * One plan per schedule workflow, in workflow order. `formLink` splits
 * `Form[criteria]`; `criteriaOf` returns null when the criteria has a TODO.
 */
export function planSchedules(
  app: App,
  schedules: readonly Workflow[],
  formLink: (form: string | undefined) => { name: string; criteria: string | null },
  criteriaOf: (src: string) => FormScheduleSpec['criteria'] | null,
): Map<Workflow, SchedulePlan> {
  const pool = jobPool(app);
  const names = new Set<string>([SWEEPER_CRON]);
  const modules = new Set<string>([SWEEPER_MODULE]);
  const plans = new Map<Workflow, SchedulePlan>();
  for (const w of schedules) {
    const stem = cronName(`c2c_${w.name || 'schedule'}`);
    let name = stem;
    for (let n = 2; names.has(name); n++) name = `${stem}_${n}`;
    names.add(name);
    const base = moduleSlug(w.name || 'schedule');
    let module = base;
    for (let n = 2; modules.has(module); n++) module = `${base}-${n}`;
    modules.add(module);
    const link = formLink(w.form);
    if (!link.name) {
      plans.set(w, planCustom(app, w, name, pool, module));
      continue;
    }
    const criteria = link.criteria ? criteriaOf(link.criteria) : undefined;
    plans.set(w, planForm(app, w, name, link.name, criteria, module));
  }
  return plans;
}

/** Catalyst job pool names reject "_" (console evidence); see shims jobPoolName. */
export function jobPool(app: App): string {
  return jobPoolName(app.name || 'schedule');
}

export function sweeperCron(app: App): CronDefinition {
  return {
    cron_name: SWEEPER_CRON,
    cron_status: true,
    cron_type: 'Periodic',
    cron_detail: { hour: 0, minute: SWEEP_PERIOD_MINUTES, second: 0, repetition_type: 'every' },
    // Safe to retry: the checkpoint skips the pages already fired.
    job_meta: jobMeta(SWEEPER_CRON, jobPool(app), SWEEPER_MODULE, 2),
    c2c: { timeZone: null, start: null, frequency: `every ${SWEEP_PERIOD_MINUTES} minutes` },
  };
}

/** Generated runtime-only helpers shared by job modules: the deploy switch and the store. */
export function jobLiveHelpers(): string {
  return `function modeOverride() {
  const value = typeof process !== "undefined" && process.env ? process.env.C2C_DEPLOY_MODE : undefined;
  return value === "live" || value === "dry-run" ? value : "";
}

function deployConfig() {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), "../c2c-deploy.json");
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
    const mod = await import("../c2c-store.mjs");
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
}

/** Catalyst Job functions must close the context, or the job stays "In Progress". */
async function closing(context, run) {
  try {
    const out = await run();
    if (context && typeof context.closeWithSuccess === "function") context.closeWithSuccess();
    return out;
  } catch (err) {
    if (context && typeof context.closeWithFailure === "function") context.closeWithFailure();
    throw err;
  }
}
`;
}

export const JOB_LIVE_IMPORTS = `import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
`;

/** The sweeper Job function of an app with form schedules. */
export function sweeperModule(opts: { app: App; banner: (lines: string[]) => string; runtimeOptions: string; entries: { module: string; spec: FormScheduleSpec }[] }): string {
  const imports = opts.entries.map((e, i) => `import * as s${i} from "./${e.module}.mjs";`).join('\n');
  const table = opts.entries.map((e, i) => `  [${JSON.stringify(e.spec.name)}, s${i}],`).join('\n');
  return `${opts.banner([
    'Form-schedule sweeper (Catalyst Job function).',
    `A Periodic cron runs it every ${SWEEP_PERIOD_MINUTES} minutes. It pages ZCQL and fires each row that came due.`,
    `Checkpoints live in the ${CHECKPOINT_TABLE} table, so a retry or the next tick never refires a finished page.`,
    `A run stops after ${SWEEP_BUDGET_MINUTES} minutes, below the period, so two sweeps never overlap.`,
    'Dry run unless deploy mode is live (c2c-deploy.json or C2C_DEPLOY_MODE) and a datastore is configured.',
    'This file is not an HTTP route. No client can call it.',
  ])}${JOB_LIVE_IMPORTS}import { createRuntime, datastoreCheckpoints, sweepFormSchedules } from "creator-to-catalyst/shims";
${imports}

export const jobPool = ${JSON.stringify(jobPool(opts.app))};
export const cron = ${JSON.stringify(sweeperCron(opts.app))};
export const checkpointTable = ${JSON.stringify(CHECKPOINT_TABLE)};
const modules = new Map([
${table}
]);

${jobLiveHelpers()}
export async function sweep(jobRequest, req) {
  const deploy = deployConfig();
  const specs = [...modules.values()].map((m) => m.sweep);
  if (deploy.mode !== "live") return { dryRun: true, swept: false, schedules: specs.map((s) => s.name) };
  const datastore = await liveDatastore();
  if (!datastore) throw new Error("live datastore is not configured");
  const now = datastore.now ? new Date(datastore.now).getTime() : Date.now();
  const appTimeZone = process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined;
  const report = await sweepFormSchedules({
    schedules: specs,
    query: (form, where, limit, offset, orderBy) => datastore.query(form, where, limit, offset, orderBy),
    checkpoints: datastoreCheckpoints(datastore, checkpointTable),
    now,
    periodMs: ${SWEEP_PERIOD_MINUTES * 60_000},
    deadline: now + ${SWEEP_BUDGET_MINUTES * 60_000},
    fire: async (spec, row) => {
      const runtime = createRuntime({ dryRun: false, appTimeZone${opts.runtimeOptions}, datastore, ...(datastore.now ? { now: datastore.now } : {}) });
      const ctx = runtime.context({ record: row, appTimeZone });
      return modules.get(spec.name).handle(ctx);
    },
  });
  return { dryRun: false, report };
}

export default async function job(jobRequest, context) {
  return closing(context, () => sweep(jobRequest, context));
}
`;
}

/** Generated job-scheduling.json: the pool, every cron, the sweeper and the known gaps. */
export function schedulingConfig(app: App, plans: readonly SchedulePlan[]): string {
  const crons: CronDefinition[] = [];
  const sweeps: string[] = [];
  for (const plan of plans) {
    if (plan.kind === 'custom' && plan.cron) crons.push(plan.cron);
    if (plan.kind === 'form' && plan.sweep) sweeps.push(plan.sweep.name);
  }
  if (sweeps.length) crons.push(sweeperCron(app));
  crons.sort((a, b) => (a.cron_name < b.cron_name ? -1 : a.cron_name > b.cron_name ? 1 : 0));
  const config = {
    jobPool: { name: jobPool(app), type: 'Function' },
    target: { type: 'Function', name: JOB_TARGET, functionType: 'job' },
    crons,
    sweeper: sweeps.length
      ? {
          module: `job/${SWEEPER_MODULE}.mjs`,
          periodMinutes: SWEEP_PERIOD_MINUTES,
          budgetMinutes: SWEEP_BUDGET_MINUTES,
          checkpointTable: { name: CHECKPOINT_TABLE, columns: [{ name: 'Job_Key', type: 'varchar', length: 255 }, { name: 'State', type: 'text' }] },
          schedules: sweeps,
        }
      : null,
    knownGaps: KNOWN_GAPS,
  };
  return JSON.stringify(config, null, 2) + '\n';
}

export const KNOWN_GAPS: readonly { id: string; text: string; source: string }[] = [
  {
    id: 'creator-schedule-quota',
    text: 'Creator caps custom schedules per user per month: 90 Standard, 300 Professional, 600 Enterprise. Catalyst Job Scheduling states no cron-count limit, so the converted app is not throttled the same way.',
    source: 'https://www.zoho.com/creator/pricing.html',
  },
  {
    id: 'creator-form-schedule-runs',
    text: 'Creator counts a form schedule once per record per run, and all account schedules stop when the monthly quota is used up. The sweeper has no such quota; one sweeper run fires every row that came due.',
    source: 'Creator counts a form schedule once per record per run and stops every account schedule when the monthly quota is used up.',
  },
  {
    id: 'sweeper-granularity',
    text: `A form schedule fires on the first sweep after its time, up to ${SWEEP_PERIOD_MINUTES} minutes late. A repeating form schedule with several occurrences inside one window fires once.`,
    source: 'Catalyst cron jobs run at least 1 min apart [DOC]',
  },
  {
    id: 'cron-time-zone',
    text: 'A CronExpression copies the Creator wall time. Whether Catalyst evaluates it in the project time zone is not verified; the Creator zone is kept in c2c.timeZone and the expression is not shifted.',
    source: '[UNVERIFIED] Catalyst cron time zone',
  },
  {
    id: 'cron-start-date',
    text: 'A repeating custom schedule starts at deploy, not at the Creator start date. A OneTime start in the past never fires.',
    source: 'Catalyst SDK createCron (OneTime time_of_execution, CronExpression cron_expression)',
  },
  {
    id: 'job-function-deploy',
    text: `Crons target one Catalyst Job function (${JOB_TARGET}) with params.module naming the file. Creating that function, the job pool and the crons is a deploy step, not done by generation. The deploy table steps create the ${CHECKPOINT_TABLE} table.`,
    source: 'packages/deploy (functions/c2c_api is the only deployed function today)',
  },
];
