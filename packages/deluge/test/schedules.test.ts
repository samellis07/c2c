import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { mockDatastore } from '../../shims/test/zcql-mock.js';
import { flowSpecs, generate } from '../src/generate.js';

function stripComments(s: string) { return (s || '').replace(/^\s*\/\/ Deluge: .*\n?/gm, ''); }

function snippet(body: string): App {
  return deriveIr(parse(`application "T"\n{\n${body}\n}\n`));
}

function schedule(name: string, props: string[], script: string): string {
  return `\t\t\t${name} as "${name}"
\t\t\t{
\t\t\t\ttype = schedule
${props.map((p) => `\t\t\t\t${p}`).join('\n')}
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\ton load
\t\t\t\t\t(
\t\t\t\t\t\t${script}
\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}`;
}

function appWith(schedules: string[]): App {
  return snippet(`\tform Invoice
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t\tDue_Date
\t\t(
\t\t\ttype = date
\t\t)
\t\tStop_Date
\t\t(
\t\t\ttype = date
\t\t)
\t\tStatus
\t\t(
\t\t\ttype = picklist
\t\t)
\t}
\tform Log
\t{
\t\tNote
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tworkflow
\t{
\t\tschedule
\t\t{
${schedules.join('\n')}
\t\t}
\t}`);
}

const ZONE = 'time zone = "Asia/Kolkata"';
const file = (g: ReturnType<typeof generate>, path: string) => g.files.find((f) => f.path === path);
const config = (g: ReturnType<typeof generate>) => JSON.parse(file(g, 'job-scheduling.json')!.source) as {
  jobPool: { name: string };
  crons: { cron_name: string; cron_status: boolean; cron_type: string; cron_detail: Record<string, unknown>; job_meta: Record<string, unknown> }[];
  sweeper: { schedules: string[]; checkpointTable: { name: string } } | null;
  knownGaps: { id: string; source: string }[];
};

test('custom schedules become pre-defined crons: CronExpression from start + frequency, OneTime without one', () => {
  const g = generate(
    appWith([
      schedule('Yearly_Leave', ['start = "2017-01-03 09:30:00"', 'frequency = yearly', ZONE], 'x = 1;'),
      schedule('Monthly_Leave', ['start = "2017-01-03 09:30:00"', 'frequency = monthly', ZONE], 'x = 1;'),
      schedule('Weekly', ['start = "2026-10-07 18:05:00"', 'frequency = weekly', ZONE], 'x = 1;'),
      schedule('Daily', ['start = "2026-10-07 07:00:00"', 'frequency = daily', ZONE, 'status = inactive'], 'x = 1;'),
      schedule('Once', ['start = "2026-12-31 23:00:00"', ZONE], 'x = 1;'),
    ]),
  );
  const crons = Object.fromEntries(config(g).crons.map((c) => [c.cron_name, c]));
  assert.deepEqual(Object.keys(crons), ['c2c_Daily', 'c2c_Monthly_Leave', 'c2c_Once', 'c2c_Weekly', 'c2c_Yearly_Leave']);
  for (const name of Object.keys(crons)) assert.match(stripComments(name), /^[A-Za-z0-9_]+$/, 'Catalyst cron and job names reject hyphens');
  assert.deepEqual(crons.c2c_Yearly_Leave!.cron_detail, { cron_expression: '30 9 3 1 *' });
  assert.deepEqual(crons.c2c_Monthly_Leave!.cron_detail, { cron_expression: '30 9 3 * *' });
  assert.deepEqual(crons.c2c_Weekly!.cron_detail, { cron_expression: '5 18 * * 3' });
  assert.deepEqual(crons.c2c_Daily!.cron_detail, { cron_expression: '0 7 * * *' });
  assert.equal(crons.c2c_Daily!.cron_status, false, 'status = inactive');
  assert.equal(crons.c2c_Once!.cron_type, 'OneTime');
  assert.deepEqual(crons.c2c_Once!.cron_detail, { time_of_execution: String(Date.parse('2026-12-31T17:30:00Z')) });
  assert.deepEqual(crons.c2c_Yearly_Leave!.job_meta, {
    job_name: 'c2c_Yearly_Leave',
    target_type: 'Function',
    target_name: 'c2c_jobs',
    jobpool_name: 'T',
    params: { module: 'job/yearly-leave.mjs' },
    job_config: { number_of_retries: 0, retry_interval: 60_000 },
  });
  const job = file(g, 'functions/job/yearly-leave.mjs')!.source;
  assert.match(stripComments(job), /export const cron = \{"cron_name":"c2c_Yearly_Leave","cron_status":true,"cron_type":"CronExpression"/);
  assert.equal(JSON.parse(file(g, 'migration-report.json')!.source).todoCount, 0);
  assert.equal(config(g).sweeper, null);
});

test('a schedule shape that does not convert is a TODO with no cron, never a guessed one', () => {
  const g = generate(
    appWith([
      schedule('Odd', ['start = "2026-10-07 07:00:00"', 'frequency = fortnightly', ZONE], 'x = 1;'),
      schedule('Field', ['form = Invoice', 'start = before 1 days from Name at "09:00:00"', ZONE], 'x = 1;'),
    ]),
  );
  const report = JSON.parse(file(g, 'migration-report.json')!.source) as { untranslated: { construct: string }[]; deterministic: boolean };
  assert.deepEqual(report.untranslated.map((u) => u.construct).sort(), ['schedule-frequency', 'schedule-start']);
  assert.equal(report.deterministic, false);
  assert.deepEqual(config(g).crons, []);
  assert.match(stripComments(file(g, 'functions/job/odd.mjs')!.source), /export const cron = null;/);
});

test('form schedules share one sweeper Job with a Periodic cron, a checkpoint table and sweep specs', () => {
  const ir = appWith([
    schedule('Due_Reminder', ['form = Invoice[Status != "Paid"]', 'start = before 1 days from Due_Date at "09:00:00"', ZONE], 'insert into Log[Note = input.Name];'),
    schedule('Daily_Nag', ['form = Invoice', 'start = after 2 hours from Due_Date', 'frequency = daily', 'end   = Stop_Date', ZONE], 'x = 1;'),
  ]);
  const g = generate(ir);
  const cfg = config(g);
  assert.deepEqual(cfg.sweeper!.schedules, ['c2c_Due_Reminder', 'c2c_Daily_Nag']);
  assert.equal(cfg.sweeper!.checkpointTable.name, 'C2CJobCheckpoint');
  assert.deepEqual(cfg.crons.map((c) => [c.cron_name, c.cron_type]), [['c2c_form_sweeper', 'Periodic']]);
  assert.deepEqual(cfg.crons[0]!.cron_detail, { hour: 0, minute: 5, second: 0, repetition_type: 'every' });
  const due = file(g, 'functions/job/due-reminder.mjs')!.source;
  assert.match(stripComments(due), /export const sweep = \{"name":"c2c_Due_Reminder","form":"Invoice","field":"Due_Date","fieldType":"Date","offset":\{"amount":-1,"unit":"days"\},"at":"09:00:00","criteria":\{"op":"!=","field":"Status","value":"Paid"\},"timeZone":"Asia\/Kolkata"\}/);
  assert.doesNotMatch(stripComments(due), /shim\.datastore\.query/, 'the sweeper applies the criteria; the handler does not re-query');
  const nag = file(g, 'functions/job/daily-nag.mjs')!.source;
  assert.match(stripComments(nag), /"offset":\{"amount":2,"unit":"hours"\},"repeat":"daily","end":"Stop_Date"/);
  const sweeper = file(g, 'functions/job/c2c-form-sweeper.mjs')!.source;
  assert.match(stripComments(sweeper), /import \* as s0 from "\.\/due-reminder\.mjs";/);
  assert.match(stripComments(sweeper), /sweepFormSchedules/);
  assert.equal(JSON.parse(file(g, 'migration-report.json')!.source).todoCount, 0);
  const ids = cfg.knownGaps.map((k) => k.id);
  assert.ok(ids.includes('creator-schedule-quota'));
  assert.match(stripComments(cfg.knownGaps.find((k) => k.id === 'creator-schedule-quota')!.source), /zoho\.com\/creator\/pricing/);
  // byte-stable
  const again = generate(ir);
  assert.deepEqual(again.files.map((f) => [f.path, f.source]), g.files.map((f) => [f.path, f.source]));
});

test('a form schedule over a form with decimal columns passes them to the sweep spec', () => {
  const g = generate(
    snippet(`\tform Invoice
\t{
\t\tDue_Date
\t\t(
\t\t\ttype = date
\t\t)
\t\tAmount
\t\t(
\t\t\ttype = decimal
\t\t)
\t}
\tworkflow
\t{
\t\tschedule
\t\t{
${schedule('Due_Reminder', ['form = Invoice[Amount < 10]', 'start = before 1 days from Due_Date at "09:00:00"', ZONE], 'x = 1;')}
\t\t}
\t}`),
  );
  const due = file(g, 'functions/job/due-reminder.mjs')!.source;
  assert.match(stripComments(due), /"decimalColumns":\{"Amount":\{"shadow":"Amount__n","scale":2\}\}/);
});

test('a payment-named form schedule is a payment stub, never a sweep, and plans no checkpoint table', () => {
  const ir = appWith([
    `\t\t\t"Payment Reminder"
\t\t\t{
\t\t\t\ttype = schedule
\t\t\t\tform = Invoice
\t\t\t\tstart = before 1 days from Due_Date at "09:00:00"
\t\t\t\t${ZONE}
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\ton load
\t\t\t\t\t(
\t\t\t\t\t\tx = 1;
\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}`,
  ]);
  const g = generate(ir);
  assert.equal(file(g, 'functions/job/c2c-form-sweeper.mjs'), undefined);
  assert.equal(file(g, 'job-scheduling.json'), undefined);
  assert.ok(file(g, 'not-supported/payments-payment-reminder.mjs'));
});

test('the approval history table is C2C_Flow_History, never the checkpoint table', () => {
  const approval = `\tworkflow
\t{
\t\tapproval
\t\t{
\t\t\tSign_Off as "Sign off"
\t\t\t{
\t\t\t\ttype = approval
\t\t\t\tform = FORM_NAME
\t\t\t\ton approve
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\ton load
\t\t\t\t\t(
\t\t\t\t\t\tx = 1;
\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`;
  const scheduled = snippet(`\tform Invoice
\t{
\t\tDue_Date
\t\t(
\t\t\ttype = date
\t\t)
\t}
${approval.replace('FORM_NAME', 'Invoice')}
\tworkflow
\t{
\t\tschedule
\t\t{
${schedule('Due_Reminder', ['form = Invoice', 'start = before 1 days from Due_Date at "09:00:00"', ZONE], 'x = 1;')}
\t\t}
\t}`);
  assert.equal(flowSpecs(scheduled).find((s) => s.kind === 'approval')?.historyTable, 'C2C_Flow_History');
  // An approval on a form that does not resolve governs nothing: no history
  // table is generated and none is stamped on the flow spec.
  const orphan = snippet(`\tform Invoice
\t{
\t\tDue_Date
\t\t(
\t\t\ttype = date
\t\t)
\t}
${approval.replace('FORM_NAME', 'Missing')}
\tworkflow
\t{
\t\tschedule
\t\t{
${schedule('Due_Reminder', ['form = Invoice', 'start = before 1 days from Due_Date at "09:00:00"', ZONE], 'x = 1;')}
\t\t}
\t}`);
  const spec = flowSpecs(orphan).find((s) => s.kind === 'approval');
  assert.ok(spec);
  assert.equal(spec.historyTable, undefined);
});

test('the sweeper runtime carries the same app-unique enforcement as the form handlers', () => {
  const ir = snippet(`\tform Invoice
\t{
\t\tunique Code
\t\t(
\t\t\ttype = text
\t\t)
\t\tunique Serial
\t\t(
\t\t\ttype = text
\t\t)
\t\tunique Tag
\t\t(
\t\t\ttype = text
\t\t)
\t\tDue_Date
\t\t(
\t\t\ttype = date
\t\t)
\t}
\tworkflow
\t{
\t\tschedule
\t\t{
${schedule('Due_Reminder', ['form = Invoice', 'start = before 1 days from Due_Date at "09:00:00"', ZONE], 'x = 1;')}
\t\t}
\t}`);
  const g = generate(ir);
  const sweeper = file(g, 'functions/job/c2c-form-sweeper.mjs')!.source;
  assert.match(stripComments(sweeper), /appUniqueColumns: \{"Invoice":\["Tag"\]\}/, 'the third unique varchar is checked at the app layer inside the sweeper too');
});

/** Write the generated tree, as the deploy lays it out, and import one module. */
async function materialize(g: ReturnType<typeof generate>, deploy?: object): Promise<{ root: string; load: (path: string) => Promise<Record<string, (...a: unknown[]) => Promise<any>>> }> {
  const root = mkdtempSync(join(tmpdir(), 'c2c-jobs-'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(root, 'node_modules/creator-to-catalyst'));
  for (const f of g.files) {
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), f.source);
  }
  if (deploy) writeFileSync(join(root, 'functions/c2c-deploy.json'), JSON.stringify(deploy));
  return { root, load: async (path) => import(pathToFileURL(join(root, path)).href) };
}

/** Every network or datastore touch throws, so a test fails loudly on any live call. */
function tripwires(): { restore: () => void; touched: string[] } {
  const touched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: unknown[]) => {
    touched.push(`fetch ${String(args[0])}`);
    throw new Error('network is not allowed in tests');
  }) as typeof fetch;
  const trap = new Proxy({}, { get: (_t, key) => (touched.push(`datastore.${String(key)}`), () => { throw new Error('datastore is not allowed'); }) });
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = trap;
  const realMode = process.env.C2C_DEPLOY_MODE;
  delete process.env.C2C_DEPLOY_MODE;
  return {
    touched,
    restore() {
      globalThis.fetch = realFetch;
      delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
      if (realMode === undefined) delete process.env.C2C_DEPLOY_MODE;
      else process.env.C2C_DEPLOY_MODE = realMode;
    },
  };
}

const liveApp = () =>
  appWith([
    schedule('Nightly', ['start = "2017-01-03 02:00:00"', 'frequency = daily', ZONE], 'insert into Log[Note = "nightly"];'),
    schedule('Due_Reminder', ['form = Invoice[Status != "Paid"]', 'start = before 1 days from Due_Date at "09:00:00"', ZONE], 'insert into Log[Note = input.Name];'),
  ]);

test('no live call without the explicit deploy switch: job modules and the sweeper stay dry runs', async () => {
  const g = generate(liveApp());
  const wires = tripwires();
  const { root, load } = await materialize(g);
  try {
    const closed: string[] = [];
    const context = { closeWithSuccess: () => closed.push('success'), closeWithFailure: () => closed.push('failure') };
    const nightly = await load('functions/job/nightly.mjs');
    const out = await nightly.default!({}, context);
    assert.equal(out.dryRun, true);
    assert.ok(out.transcript.some((e: { op: string; dryRun?: boolean }) => e.op === 'insert' && e.dryRun === true));
    assert.deepEqual(closed, ['success'], 'a Catalyst job context is closed');
    const sweeper = await load('functions/job/c2c-form-sweeper.mjs');
    assert.deepEqual(await sweeper.default!({}, context), { dryRun: true, swept: false, schedules: ['c2c_Due_Reminder'] });
    // c2c-deploy.json without mode "live" is still a dry run.
    writeFileSync(join(root, 'functions/c2c-deploy.json'), JSON.stringify({ mode: 'dry-run', appTimeZone: 'Asia/Kolkata' }));
    assert.equal((await nightly.run!({})).dryRun, true);
    assert.deepEqual(wires.touched, [], 'no fetch and no datastore access');
  } finally {
    wires.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('live mode without a configured datastore refuses before any write', async () => {
  const g = generate(liveApp());
  const wires = tripwires();
  delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
  const { root, load } = await materialize(g, { mode: 'live', appTimeZone: 'Asia/Kolkata' });
  try {
    const closed: string[] = [];
    const nightly = await load('functions/job/nightly.mjs');
    await assert.rejects(nightly.default!({}, { closeWithFailure: () => closed.push('failure') }), /live datastore is not configured/);
    assert.deepEqual(closed, ['failure']);
    const sweeper = await load('functions/job/c2c-form-sweeper.mjs');
    await assert.rejects(sweeper.default!({}), /live datastore is not configured/);
    assert.deepEqual(wires.touched, []);
  } finally {
    wires.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Runs `fn` with the wall clock (Date.now and new Date()) moved to `iso`,
 * still ticking. A job that reads the wall clock instead of the run's
 * injected `now` then fails whatever today's date is.
 */
async function atWallClock<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const Real = globalThis.Date;
  const offset = Real.parse(iso) - Real.now();
  class Shifted extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(Real.now() + offset);
      else super(...(args as [string]));
    }
    static override now(): number {
      return Real.now() + offset;
    }
  }
  globalThis.Date = Shifted as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = Real;
  }
}

async function liveSweep(): Promise<void> {
  const g = generate(liveApp());
  const { datastore, tables } = mockDatastore({ Invoice: ['ROWID'] });
  await datastore.insert('Invoice', [
    { Name: 'due', Due_Date: '2026-10-10', Status: 'Open' },
    { Name: 'paid', Due_Date: '2026-10-10', Status: 'Paid' },
    { Name: 'later', Due_Date: '2026-10-20', Status: 'Open' },
  ]);
  // 2026-10-09 09:01 Asia/Kolkata: one minute after "before 1 days from Due_Date at 09:00".
  const store = { ...datastore, now: new Date('2026-10-09T03:31:00Z') };
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = store;
  // No app or deploy time zone: each job falls back to its schedule's `time zone`.
  const { root, load } = await materialize(g, { mode: 'live' });
  try {
    const nightly = await load('functions/job/nightly.mjs');
    const out = await nightly.run!({});
    assert.equal(out.dryRun, false);
    const sweeper = await load('functions/job/c2c-form-sweeper.mjs');
    const first = await sweeper.sweep!({});
    assert.equal(first.dryRun, false);
    assert.equal(first.report.schedules[0].fired, 1);
    await sweeper.sweep!({});
    assert.deepEqual(tables.get('Log')!.map((r) => r.Note), ['nightly', 'due'], 'paid is filtered, later is not due, nothing refires');
    // One checkpoint row; the fired mark was pruned when the window closed.
    const jobKeys = tables.get('C2CJobCheckpoint')!.map((r) => r.Job_Key).sort();
    assert.deepEqual(jobKeys, ['c2c_Due_Reminder']);
  } finally {
    delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
    rmSync(root, { recursive: true, force: true });
  }
}

test('live mode with a datastore: the cron job writes, and the sweeper fires each due row once', liveSweep);

test('the live sweep uses the run clock, not the wall clock: same result before, after and long after the due date', async () => {
  for (const wall of ['2026-10-08T12:00:00Z', '2026-10-20T00:00:00Z', '2027-01-01T00:00:00Z']) await atWallClock(wall, liveSweep);
});
