import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { reportCriteria } from '../../deluge/src/translate.js';
import { criteriaHasTodo } from '../../shims/src/criteria.js';
import { buildUi } from '../src/index.js';

/**
 * Point-of-sale relative reports. The clock is fixed. The application zone is
 * Asia/Kolkata, so 18:45 UTC is 00:15 the next calendar day. A week starts on
 * Sunday. Bounds are half-open and compared as dates, not as display text.
 */

const STAFF = { user: { profile: 'Staff' } };

const ROWS = [
  { ROWID: 'sep', Added_Time: '2026-09-30 23:50:00', Note: 'sep' },
  { ROWID: 'oct1', Added_Time: '2026-10-01 00:05:00', Note: 'oct1' },
  { ROWID: 'sat', Added_Time: '2026-10-10 23:30:00', Note: 'sat' },
  { ROWID: 'sun', Added_Time: '2026-10-11 00:05:00', Note: 'sun' },
  { ROWID: 'sunlate', Added_Time: '2026-10-11 23:30:00', Note: 'sunlate' },
  { ROWID: 'display', Added_Time: '11-Oct-2026 00:05:00', Note: 'display' },
  { ROWID: 'mon', Added_Time: '2026-10-12 00:05:00', Note: 'mon' },
  { ROWID: 'nextsun', Added_Time: '2026-10-18 00:00:00', Note: 'nextsun' },
  { ROWID: 'blank', Added_Time: '', Note: 'blank' },
];

function appBody(zone: string | null): string {
  const zoneLine = zone ? `\ttime zone = "${zone}"\n` : '';
  return `${zoneLine}\tsection Main
\t{
\t\tform Add_Invoice
\t\t{
\t\t\tNote
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t\tlist This_Month_sale
\t\t{
\t\t\tshow all rows from Add_Invoice [Added_Time in this month]
\t\t\t(
\t\t\t\tAdded_Time
\t\t\t\tNote
\t\t\t)
\t\t}
\t\tlist This_Month_Sales
\t\t{
\t\t\tshow all rows from Add_Invoice [Added_Time in this month]
\t\t\t(
\t\t\t\tAdded_Time
\t\t\t\tNote
\t\t\t)
\t\t}
\t\tlist This_Week_Sales
\t\t{
\t\t\tshow all rows from Add_Invoice [Added_Time in this week]
\t\t\t(
\t\t\t\tAdded_Time
\t\t\t\tNote
\t\t\t)
\t\t}
\t\tlist Today_Sales
\t\t{
\t\t\tshow all rows from Add_Invoice [Added_Time == today]
\t\t\t(
\t\t\t\tAdded_Time
\t\t\t\tNote
\t\t\t)
\t\t}
\t\tlist All_Invoices
\t\t{
\t\t\tshow all rows from Add_Invoice
\t\t\t(
\t\t\t\tAdded_Time
\t\t\t\tNote
\t\t\t)
\t\t}
\t\tlist Nested
\t\t{
\t\t\tshow all rows from Add_Invoice [Added_Time == today && Add_Employee[Official_Email == zoho.loginuserid].Location.ID == 1]
\t\t\t(
\t\t\t\tAdded_Time
\t\t\t)
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tAdd_Invoice
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tThis_Month_sale = {"View"}
\t\t\t\t\t\tThis_Month_Sales = {"View"}
\t\t\t\t\t\tThis_Week_Sales = {"View"}
\t\t\t\t\t\tToday_Sales = {"View"}
\t\t\t\t\t\tAll_Invoices = {"View"}
\t\t\t\t\t\tNested = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tNote
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tAdded_Time
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`;
}

function invoke(handler: (req: unknown, res: unknown) => unknown, req: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(body: string) {
      raw = body;
    },
  };
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} }));
}

async function loadBuilt(body: string): Promise<{ dir: string; files: Map<string, string | Buffer> }> {
  const built = buildUi(deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`)));
  const files = new Map(built.files.map((file) => [file.path, file.data]));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-rel-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const [path, data] of files) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
  return { dir, files };
}

function sourceOf(files: Map<string, string | Buffer>, path: string): string {
  const data = files.get(path);
  assert.ok(data, path);
  return String(data);
}

function notes(body: Record<string, unknown>): string[] {
  const rows = body.rows;
  assert.ok(Array.isArray(rows));
  return rows.map((row) => String((row as { Note?: unknown }).Note ?? ''));
}

test('relative report criteria keep a marker and leave a nested fetch untranslated', () => {
  const today = reportCriteria('Added_Time == today');
  assert.equal(today.op, '==');
  if (today.op !== '==') return;
  assert.deepEqual(today.value, { __rel: 'today', day: true });
  const month = reportCriteria('Added_Time in this month');
  assert.equal(month.op, 'in');
  if (month.op !== 'in') return;
  assert.deepEqual(month.value, { __rel: 'this month' });
  const nested = reportCriteria('Added_Time == today && Add_Employee[Official_Email == zoho.loginuserid].Location.ID == 1');
  assert.equal(criteriaHasTodo(nested), true);
});

test('point-of-sale relative reports match the app-zone window on a fixed clock', async () => {
  const built = await loadBuilt(appBody('Asia/Kolkata'));
  const wheres: string[] = [];
  const previousNow = process.env.C2C_NOW;
  const previousMode = process.env.C2C_DEPLOY_MODE;
  const previousZone = process.env.C2C_APP_TIMEZONE;
  delete process.env.C2C_APP_TIMEZONE;
  process.env.C2C_DEPLOY_MODE = 'live';
  (globalThis as Record<string, unknown>).__c2cDatastore = {
    query: async (_form: string, where: string) => {
      wheres.push(where);
      return ROWS.map((row) => ({ ...row }));
    },
  };
  try {
    const todaySrc = sourceOf(built.files, 'functions/reports/today-sales.mjs');
    const allSrc = sourceOf(built.files, 'functions/reports/all-invoices.mjs');
    assert.match(todaySrc, /bindRelativeCriteria/);
    assert.doesNotMatch(allSrc, /bindRelativeCriteria/);
    assert.match(String(built.files.get('functions/c2c-deploy.json')), /Asia\/Kolkata/);

    const load = (name: string) => import(pathToFileURL(join(built.dir, `functions/reports/${name}.mjs`)).href);

    const today = await load('today-sales');
    const week = await load('this-week-sales');
    const monthSale = await load('this-month-sale');
    const monthSales = await load('this-month-sales');
    const all = await load('all-invoices');
    const nested = await load('nested');

    // 2026-10-11T18:45:00Z is 2026-10-12 00:15 in Asia/Kolkata. Today is 12 Oct.
    process.env.C2C_NOW = '2026-10-11T18:45:00.000Z';
    wheres.length = 0;
    const todayLive = await invoke(today.default, { ...STAFF, body: { op: 'query' } });
    assert.equal(todayLive.status, 200);
    assert.equal(todayLive.body.notice, undefined);
    assert.match(String(wheres[0]), /Added_Time >= '2026-10-12 00:00:00'/);
    assert.match(String(wheres[0]), /Added_Time < '2026-10-13 00:00:00'/);
    assert.deepEqual(notes(todayLive.body), ['mon']);

    const todayDry = await invoke(today.default, { ...STAFF, body: { rows: ROWS } });
    assert.equal(todayDry.status, 200);
    assert.equal(todayDry.body.dryRun, true);
    assert.deepEqual(notes(todayDry.body), ['mon']);

    // Sunday 2026-10-11 00:15 IST. This week is [11 Oct, 18 Oct). Saturday is the previous week.
    process.env.C2C_NOW = '2026-10-10T18:45:00.000Z';
    wheres.length = 0;
    const weekLive = await invoke(week.default, { ...STAFF, body: { op: 'query' } });
    assert.equal(weekLive.status, 200);
    assert.match(String(wheres[0]), /Added_Time >= '2026-10-11 00:00:00'/);
    assert.match(String(wheres[0]), /Added_Time < '2026-10-18 00:00:00'/);
    assert.deepEqual(notes(weekLive.body), ['sun', 'sunlate', 'display', 'mon']);

    // 2026-10-01 00:15 IST. This month is October. 30 Sep is the previous month.
    process.env.C2C_NOW = '2026-09-30T18:45:00.000Z';
    wheres.length = 0;
    const monthLive = await invoke(monthSale.default, { ...STAFF, body: { op: 'query' } });
    assert.equal(monthLive.status, 200);
    assert.match(String(wheres[0]), /Added_Time >= '2026-10-01 00:00:00'/);
    assert.match(String(wheres[0]), /Added_Time < '2026-11-01 00:00:00'/);
    assert.deepEqual(notes(monthLive.body), ['oct1', 'sat', 'sun', 'sunlate', 'display', 'mon', 'nextsun']);

    wheres.length = 0;
    const monthSalesLive = await invoke(monthSales.default, { ...STAFF, body: { op: 'query' } });
    assert.equal(monthSalesLive.status, 200);
    assert.match(String(wheres[0]), /Added_Time >= '2026-10-01 00:00:00'/);
    assert.match(String(wheres[0]), /Added_Time < '2026-11-01 00:00:00'/);
    assert.deepEqual(notes(monthSalesLive.body), ['oct1', 'sat', 'sun', 'sunlate', 'display', 'mon', 'nextsun']);

    // A report with no relative criteria still echoes the supplied rows.
    const echoed = await invoke(all.default, { ...STAFF, body: { rows: ROWS } });
    assert.equal(echoed.status, 200);
    assert.equal(echoed.body.notice, undefined);
    assert.deepEqual(notes(echoed.body), ROWS.map((row) => row.Note));

    wheres.length = 0;
    const closed = await invoke(nested.default, { ...STAFF, body: { op: 'query' } });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.notice, 'filter not migrated');
    assert.deepEqual(closed.body.rows, []);
    assert.equal(wheres.length, 0);
  } finally {
    if (previousNow === undefined) delete process.env.C2C_NOW;
    else process.env.C2C_NOW = previousNow;
    if (previousMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = previousMode;
    if (previousZone === undefined) delete process.env.C2C_APP_TIMEZONE;
    else process.env.C2C_APP_TIMEZONE = previousZone;
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('a relative report with no application time zone returns no rows and does not query', async () => {
  const built = await loadBuilt(appBody(null));
  const wheres: string[] = [];
  const previousNow = process.env.C2C_NOW;
  const previousMode = process.env.C2C_DEPLOY_MODE;
  const previousZone = process.env.C2C_APP_TIMEZONE;
  delete process.env.C2C_APP_TIMEZONE;
  process.env.C2C_NOW = '2026-10-11T18:45:00.000Z';
  process.env.C2C_DEPLOY_MODE = 'live';
  (globalThis as Record<string, unknown>).__c2cDatastore = {
    query: async (_form: string, where: string) => {
      wheres.push(where);
      return ROWS.map((row) => ({ ...row }));
    },
  };
  try {
    const today = await import(pathToFileURL(join(built.dir, 'functions/reports/today-sales.mjs')).href);
    const live = await invoke(today.default, { ...STAFF, body: { op: 'query' } });
    assert.equal(live.status, 200);
    assert.equal(live.body.notice, 'filter not migrated');
    assert.deepEqual(live.body.rows, []);
    assert.equal(wheres.length, 0);
  } finally {
    if (previousNow === undefined) delete process.env.C2C_NOW;
    else process.env.C2C_NOW = previousNow;
    if (previousMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = previousMode;
    if (previousZone === undefined) delete process.env.C2C_APP_TIMEZONE;
    else process.env.C2C_APP_TIMEZONE = previousZone;
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('a report criteria Field is this week compiles and a failed criteria still returns no rows', async () => {
  // Staff can view every row of the form. A report whose criteria did not migrate
  // then fails closed on its own; it does not become the profile record filter.
  const body = `time zone = "Asia/Kolkata"
\tsection Main
\t{
\t\tform Add_Invoice
\t\t{
\t\t\tNote
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t\tlist Week_Is
\t\t{
\t\t\tshow all rows from Add_Invoice [Added_Time is this week]
\t\t\t(
\t\t\t\tAdded_Time
\t\t\t\tNote
\t\t\t)
\t\t}
\t\tlist All_Invoices
\t\t{
\t\t\tshow all rows from Add_Invoice
\t\t\t(
\t\t\t\tNote
\t\t\t)
\t\t}
\t\tlist Broken
\t\t{
\t\t\tshow all rows from Add_Invoice [Lookup.Field]
\t\t\t(
\t\t\t\tNote
\t\t\t)
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tAdd_Invoice
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tWeek_Is = {"View"}
\t\t\t\t\t\tAll_Invoices = {"View"}
\t\t\t\t\t\tBroken = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tNote
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tAdded_Time
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`;
  const builtUi = buildUi(deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`)));
  const weekModel = builtUi.model.reports.find((report) => report.name === 'Week_Is');
  const brokenModel = builtUi.model.reports.find((report) => report.name === 'Broken');
  assert.equal(weekModel?.status, 'generated');
  assert.equal(weekModel?.todo, undefined);
  assert.equal(
    brokenModel?.todo,
    'Filter not migrated: dynamic or unsupported criteria need manual translation; the report returns no rows.',
  );
  const migration = JSON.parse(sourceOf(new Map(builtUi.files.map((file) => [file.path, file.data])), 'migration-report.json')) as {
    untranslated?: { construct: string }[];
  };
  assert.equal((migration.untranslated ?? []).filter((row) => row.construct === 'report-criteria').length, 1);
  const built = await loadBuilt(body);
  const previousNow = process.env.C2C_NOW;
  const previousMode = process.env.C2C_DEPLOY_MODE;
  const previousZone = process.env.C2C_APP_TIMEZONE;
  delete process.env.C2C_APP_TIMEZONE;
  process.env.C2C_DEPLOY_MODE = 'live';
  const wheres: string[] = [];
  (globalThis as Record<string, unknown>).__c2cDatastore = {
    query: async (_form: string, where: string) => {
      wheres.push(where);
      return ROWS.map((row) => ({ ...row }));
    },
  };
  try {
    const weekSrc = sourceOf(built.files, 'functions/reports/week-is.mjs');
    assert.match(weekSrc, /"__rel":"this week"/);
    assert.match(weekSrc, /bindRelativeCriteria/);
    assert.doesNotMatch(weekSrc, /"construct":"report-criteria"/);
    const week = await import(pathToFileURL(join(built.dir, 'functions/reports/week-is.mjs')).href);
    process.env.C2C_NOW = '2026-10-10T18:45:00.000Z';
    wheres.length = 0;
    const open = await invoke(week.default, { ...STAFF, body: { op: 'query' } });
    assert.equal(open.status, 200);
    assert.equal(open.body.notice, undefined);
    assert.match(String(wheres[0]), /Added_Time >= '2026-10-11 00:00:00'/);
    assert.match(String(wheres[0]), /Added_Time < '2026-10-18 00:00:00'/);
    assert.deepEqual(notes(open.body), ['sun', 'sunlate', 'display', 'mon']);
    process.env.C2C_NOW = '2026-10-10T18:29:00.000Z';
    const before = await invoke(week.default, { ...STAFF, body: { op: 'query' } });
    assert.equal(before.body.notice, undefined);
    assert.deepEqual(notes(before.body), ['sat']);
    const broken = await import(pathToFileURL(join(built.dir, 'functions/reports/broken.mjs')).href);
    wheres.length = 0;
    const closed = await invoke(broken.default, { ...STAFF, body: { op: 'query' } });
    assert.equal(closed.body.notice, 'filter not migrated');
    assert.deepEqual(closed.body.rows, []);
    assert.equal(wheres.length, 0);
  } finally {
    if (previousNow === undefined) delete process.env.C2C_NOW;
    else process.env.C2C_NOW = previousNow;
    if (previousMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = previousMode;
    if (previousZone === undefined) delete process.env.C2C_APP_TIMEZONE;
    else process.env.C2C_APP_TIMEZONE = previousZone;
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('a report criteria on the application owner binds instead of staying counted', () => {
  const body = `\tsection Main
\t{
\t\tform Add_Item
\t\t{
\t\t\tNote
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t\tlist Owner_Rows
\t\t{
\t\t\tshow all rows from Add_Item [Note == "a" && Members.Email == zoho.adminuserid]
\t\t\t(
\t\t\t\tNote
\t\t\t)
\t\t}
\t\tlist Member_Rows
\t\t{
\t\t\tshow all rows from Add_Item [Lookup.Field]
\t\t\t(
\t\t\t\tNote
\t\t\t)
\t\t}
\t}`;
  const builtUi = buildUi(deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`)));
  const owner = builtUi.model.reports.find((report) => report.name === 'Owner_Rows');
  const other = builtUi.model.reports.find((report) => report.name === 'Member_Rows');
  assert.notEqual(owner?.status, 'todo');
  const ownerSrc = sourceOf(new Map(builtUi.files.map((file) => [file.path, file.data])), 'functions/reports/owner-rows.mjs');
  assert.match(ownerSrc, /"__bind":"adminUserId"/);
  assert.equal(other?.status, 'todo');
  assert.doesNotMatch(other?.todo ?? '', /adminuserid/);
});
