/**
 * A dependent record query in a report criteria (Form[criteria].field) resolves
 * under the caller's grant on that form: a hidden form, a hidden path field, or
 * an inner criteria on a hidden field fails closed. A client-sent filter value
 * is a scalar only — a {__rows} or {__bind} object in the body is dropped, never
 * run as a sub-query.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { generateUi } from '../src/index.js';

const USER = { profile: 'Staff', loginUser: 'ada@example.test' };

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function textField(name: string): string {
  return `\t\t${name}\n\t\t(\n\t\t\ttype = text\n\t\t)`;
}

const APP = appOf(`\tform Item
\t{
${textField('Name')}
${textField('Keep')}
\t}
\tform Payroll
\t{
${textField('Employee')}
${textField('Salary')}
\t}
\tlist Discounts
\t{
\t\tshow all rows from Item [Keep == Payroll[Employee == "bob"].Salary]
\t\t(
\t\t\tName
\t\t\tKeep
\t\t)
\t}
\tlist All_Items
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tName
\t\t\tKeep
\t\t)
\t}
\tlist Payroll_All
\t{
\t\tshow all rows from Payroll
\t\t(
\t\t\tEmployee
\t\t)
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tDiscounts = {"View"}
\t\t\t\t\t\tAll_Items = {"View"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tPayroll
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tPayroll_All = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tEmployee
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);

function outerWrap(text: string): boolean {
  if (!text.startsWith('(') || !text.endsWith(')')) return false;
  let depth = 0;
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "'" && text[i + 1] === "'") i++;
      else if (ch === "'") quote = false;
      continue;
    }
    if (ch === "'") quote = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i === text.length - 1;
    }
  }
  return false;
}

/** Split on a top-level keyword (AND/OR), skipping parens and '..' literals. */
function splitTop(where: string, keyword: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (let i = 0; i < where.length; i++) {
    const ch = where[i]!;
    if (quote) {
      cur += ch;
      if (ch === "'" && where[i + 1] === "'") {
        cur += "'";
        i++;
      } else if (ch === "'") quote = false;
      continue;
    }
    if (ch === "'") quote = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && where.slice(i, i + keyword.length) === keyword) {
      out.push(cur);
      cur = '';
      i += keyword.length - 1;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function litValue(raw: string): unknown {
  const text = raw.trim();
  if (text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const quoted = /^'([\s\S]*)'$/.exec(text);
  if (quoted) return quoted[1]!.replace(/''/g, "'");
  throw new Error(`unhandled literal: ${raw}`);
}

function cmp(left: unknown, op: string, right: unknown): boolean {
  if (right === null) return op === '=' ? left == null : left != null;
  const numeric = /^-?\d+(\.\d+)?$/.test(String(left)) && /^-?\d+(\.\d+)?$/.test(String(right));
  const a = numeric ? Number(left) : String(left);
  const b = numeric ? Number(right) : String(right);
  switch (op) {
    case '=': return a === b;
    case '!=': return a !== b;
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    default: throw new Error(`unhandled op ${op}`);
  }
}

function evalLeaf(term: string, row: Record<string, unknown>): boolean {
  const isNull = /^(\w+) IS NULL$/.exec(term);
  if (isNull) return row[isNull[1]!] == null;
  const notNull = /^(\w+) IS NOT NULL$/.exec(term);
  if (notNull) return row[notNull[1]!] != null;
  const inn = /^(\w+) IN \((.*)\)$/s.exec(term);
  if (inn) {
    const vals = splitTop(inn[2]!, ',').map(litValue).map(String);
    return vals.includes(String(row[inn[1]!]));
  }
  const like = /^(\w+) LIKE '(.*)'$/s.exec(term);
  if (like) {
    const pattern = like[2]!.replace(/''/g, "'");
    const re = new RegExp(`^${pattern.replace(/[.*+^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`);
    return re.test(String(row[like[1]!] ?? ''));
  }
  const leaf = /^(\w+) (=|!=|>=|<=|>|<) (null|true|false|-?\d+(?:\.\d+)?|'(?:[^']|'')*')$/s.exec(term);
  if (leaf) return cmp(row[leaf[1]!], leaf[2]!, litValue(leaf[3]!));
  throw new Error(`unhandled where term: ${term}`);
}

function evalWhere(where: string, row: Record<string, unknown>): boolean {
  let w = (where || '').trim();
  if (!w || w === 'true') return true;
  while (outerWrap(w)) w = w.slice(1, -1).trim();
  const ors = splitTop(w, ' OR ');
  if (ors.length > 1) return ors.some((part) => evalWhere(part, row));
  const ands = splitTop(w, ' AND ');
  if (ands.length > 1) return ands.every((part) => evalWhere(part, row));
  if (/^NOT\s+/.test(w)) return !evalWhere(w.slice(3).trim(), row);
  return evalLeaf(w, row);
}

function makeAdapter(tables: Record<string, Record<string, unknown>[]>) {
  const calls: string[] = [];
  return {
    calls,
    reset() {
      calls.length = 0;
    },
    async query(form: string, where: string, limit: number, offset = 0) {
      calls.push(`${form} @${offset} ${where}`);
      const all = (tables[form] ?? []).slice().sort((a, b) => Number(a.ROWID) - Number(b.ROWID));
      return all.filter((row) => evalWhere(where, row)).slice(offset, offset + limit);
    },
  };
}

function invoke(handler: (req: unknown, res: unknown) => unknown, body: Record<string, unknown>, user: Record<string, unknown> = USER) {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(text: string) {
      raw = text;
    },
  };
  return Promise.resolve(handler({ user, body }, res)).then(() => ({
    status,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
  }));
}

interface Loaded {
  handler: (req: unknown, res: unknown) => unknown;
  access: {
    profiles: Record<string, Record<string, { fields?: string[] }>>;
    hidden?: string[];
  };
  baseCriteria: { op: string; value?: { __rows?: { form: string; criteria: unknown; path: string[] } } };
  close(): Promise<void>;
}

async function loadReport(app: App, reportName: string): Promise<Loaded> {
  const ui = generateUi(app);
  const file = ui.files.find(
    (item) => item.path.startsWith('functions/reports/') && String(item.data).includes(`export const reportName = ${JSON.stringify(reportName)};`),
  );
  assert.ok(file, ui.files.map((item) => item.path).join('\n'));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-report-record-query-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const item of ui.files) {
    const path = join(dir, item.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, item.data);
  }
  writeFileSync(join(dir, 'functions/c2c-deploy.json'), JSON.stringify({ mode: 'live', appTimeZone: 'UTC' }));
  const report = (await import(pathToFileURL(join(dir, file.path)).href)) as {
    default: Loaded['handler'];
    access: Loaded['access'];
    baseCriteria: Loaded['baseCriteria'];
  };
  return {
    handler: report.default,
    access: report.access,
    baseCriteria: report.baseCriteria,
    async close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const TABLES = {
  Item: [
    { ROWID: '1', Name: 'alpha', Keep: 'no' },
    { ROWID: '2', Name: 'beta', Keep: '5000' },
  ],
  Payroll: [{ ROWID: '9', Employee: 'bob', Salary: 5000 }],
};

function payrollGrant(loaded: Loaded, fields?: string[]): { fields?: string[] } {
  const grant: { fields?: string[] } = {};
  if (fields) grant.fields = fields;
  loaded.access.profiles.Staff!.Payroll = grant;
  return grant;
}

test('a report record-query value resolves under the caller grant on that form', async () => {
  const loaded = await loadReport(APP, 'Discounts');
  try {
    const adapter = makeAdapter(TABLES);
    (globalThis as Record<string, unknown>).__c2cDatastore = adapter;
    payrollGrant(loaded, ['Employee', 'Salary']);
    const live = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: 10 });
    assert.equal(live.status, 200, JSON.stringify(live.body).slice(0, 300));
    assert.ok(adapter.calls.some((call) => call.startsWith("Payroll @0 Employee = 'bob'")), adapter.calls.join('\n'));
    assert.ok(adapter.calls.some((call) => call.startsWith('Item @0 Keep = 5000')), adapter.calls.join('\n'));
    const rows = live.body.rows as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.Name, 'beta');
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await loaded.close();
  }
});

test('a hidden path field fails closed: no sub-query, no rows', async () => {
  const loaded = await loadReport(APP, 'Discounts');
  try {
    const adapter = makeAdapter(TABLES);
    (globalThis as Record<string, unknown>).__c2cDatastore = adapter;
    // Salary is outside the Staff field grant on Payroll.
    payrollGrant(loaded, ['Employee']);
    const live = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: 10 });
    assert.equal(live.status, 200, JSON.stringify(live.body).slice(0, 300));
    assert.equal(adapter.calls.some((call) => call.startsWith('Payroll ')), false, adapter.calls.join('\n'));
    assert.deepEqual(live.body.rows, []);
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await loaded.close();
  }
});

test('an inner criteria on a hidden field fails closed: no sub-query, no rows', async () => {
  const loaded = await loadReport(APP, 'Discounts');
  try {
    const adapter = makeAdapter(TABLES);
    (globalThis as Record<string, unknown>).__c2cDatastore = adapter;
    payrollGrant(loaded, ['Employee']);
    // The hidden Salary can be probed neither through the path nor the criteria.
    const query = loaded.baseCriteria.value!.__rows!;
    query.criteria = { op: 'and', args: [{ op: '==', field: 'Employee', value: 'bob' }, { op: '>', field: 'Salary', value: 4000 }] };
    query.path = ['Employee'];
    const live = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: 10 });
    assert.equal(live.status, 200, JSON.stringify(live.body).slice(0, 300));
    assert.equal(adapter.calls.some((call) => call.startsWith('Payroll ')), false, adapter.calls.join('\n'));
    assert.deepEqual(live.body.rows, []);
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await loaded.close();
  }
});

test('a hidden form or a missing grant never yields a record-query value', async () => {
  const loaded = await loadReport(APP, 'Discounts');
  try {
    const adapter = makeAdapter(TABLES);
    (globalThis as Record<string, unknown>).__c2cDatastore = adapter;
    payrollGrant(loaded, ['Employee', 'Salary']);
    loaded.access.hidden = [...(loaded.access.hidden ?? []), 'Payroll'];
    let live = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: 10 });
    assert.equal(live.status, 200, JSON.stringify(live.body).slice(0, 300));
    assert.deepEqual(live.body.rows, []);
    assert.equal(adapter.calls.some((call) => call.startsWith('Payroll ')), false, adapter.calls.join('\n'));
    loaded.access.hidden = (loaded.access.hidden ?? []).filter((name) => name !== 'Payroll');
    delete loaded.access.profiles.Staff!.Payroll;
    live = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: 10 });
    assert.equal(live.status, 200, JSON.stringify(live.body).slice(0, 300));
    assert.deepEqual(live.body.rows, []);
    assert.equal(adapter.calls.some((call) => call.startsWith('Payroll ')), false, adapter.calls.join('\n'));
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await loaded.close();
  }
});

test('a multi-hop record-query path fails closed at runtime', async () => {
  const loaded = await loadReport(APP, 'Discounts');
  try {
    const adapter = makeAdapter(TABLES);
    (globalThis as Record<string, unknown>).__c2cDatastore = adapter;
    payrollGrant(loaded, ['Employee', 'Salary']);
    loaded.baseCriteria.value!.__rows!.path = ['Salary', 'ID'];
    const live = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: 10 });
    assert.equal(live.status, 200, JSON.stringify(live.body).slice(0, 300));
    assert.equal(adapter.calls.some((call) => call.startsWith('Payroll ')), false, adapter.calls.join('\n'));
    assert.deepEqual(live.body.rows, []);
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await loaded.close();
  }
});

test('a client filter value is a scalar only: {__rows} and {__bind} objects are dropped', async () => {
  const loaded = await loadReport(APP, 'All_Items');
  try {
    const adapter = makeAdapter(TABLES);
    (globalThis as Record<string, unknown>).__c2cDatastore = adapter;
    process.env.C2C_ADMIN_USER_ID = 'owner@example.test';
    const injected = await invoke(loaded.handler, {
      op: 'query',
      page: 0,
      pageSize: 10,
      filter: { field: 'Name', value: { __rows: { form: 'Payroll', criteria: { op: 'true' }, path: ['Salary'] } } },
    });
    assert.equal(injected.status, 200, JSON.stringify(injected.body).slice(0, 300));
    // The object value is dropped, never run as the caller-chosen sub-query.
    assert.equal(adapter.calls.some((call) => call.startsWith('Payroll ')), false, adapter.calls.join('\n'));
    assert.equal(adapter.calls.some((call) => /Name = /.test(call)), false, adapter.calls.join('\n'));
    assert.equal((injected.body.rows as unknown[]).length, 2);
    const bound = await invoke(loaded.handler, {
      op: 'query',
      page: 0,
      pageSize: 10,
      filter: { field: 'Name', value: { __bind: 'adminUserId' } },
    });
    assert.equal(bound.status, 200, JSON.stringify(bound.body).slice(0, 300));
    assert.equal(adapter.calls.some((call) => /owner@corp\.test/.test(call)), false, adapter.calls.join('\n'));
    assert.equal((bound.body.rows as unknown[]).length, 2);
    const scalar = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: 10, filter: { field: 'Name', value: 'alpha' } });
    assert.equal(scalar.status, 200, JSON.stringify(scalar.body).slice(0, 300));
    assert.ok(adapter.calls.some((call) => /Name = 'alpha'/.test(call)), adapter.calls.join('\n'));
    assert.equal((scalar.body.rows as unknown[]).length, 1);
  } finally {
    delete process.env.C2C_ADMIN_USER_ID;
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await loaded.close();
  }
});

// A `Form[..].Lookup.ID` record-query value reads the linked record's id: the
// lookup cell already stores it, so the two-hop path resolves like the one-hop
// fetch — through a lookup field only.
const APP_LOOKUP_ID = appOf(`\tform Add_Location
\t{
${textField('Name')}
\t}
\tform Add_Employee
\t{
\t\tOfficial_Email
\t\t(
\t\t\ttype = email
\t\t)
\t\tLocation
\t\t(
\t\t\ttype = lookup
\t\t\tvalues = Add_Location.ID
\t\t)
\t}
\tform Add_Holiday
\t{
${textField('Name')}
${textField('Applicable_For')}
\t\tLocations_list
\t\t(
\t\t\ttype = lookup
\t\t\tvalues = Add_Location.ID
\t\t)
\t}
\tlist Holidays_Employee
\t{
\t\tshow all rows from Add_Holiday [Applicable_For == "All Locations" || (Applicable_For == "Specific Locations" && Locations_list.ID == Add_Employee[Official_Email == zoho.loginuserid].Location.ID)]
\t\t(
\t\t\tName
\t\t\tApplicable_For
\t\t\tLocations_list
\t\t)
\t}
\tlist Lookup_ID_Probe
\t{
\t\tshow all rows from Add_Holiday [Name == Add_Employee[Official_Email == zoho.loginuserid].Location.ID]
\t\t(
\t\t\tName
\t\t)
\t}
\tlist All_Holidays
\t{
\t\tshow all rows from Add_Holiday
\t\t(
\t\t\tName
\t\t)
\t}
\tlist All_Locations
\t{
\t\tshow all rows from Add_Location
\t\t(
\t\t\tName
\t\t)
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tAdd_Holiday
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tHolidays_Employee = {"View"}
\t\t\t\t\t\tLookup_ID_Probe = {"View"}
\t\t\t\t\t\tAll_Holidays = {"View"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tAdd_Location
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Locations = {"View"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tAdd_Employee
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tOfficial_Email
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tLocation
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);

const LOOKUP_USER = { profile: 'Staff', loginUser: 'ada@example.test', userId: 'ada@example.test' };

function employeeGrant(loaded: Loaded, fields?: string[]): void {
  const grant: { fields?: string[] } = {};
  if (fields) grant.fields = fields;
  loaded.access.profiles.Staff!.Add_Employee = grant;
}

const LOOKUP_TABLES = {
  Add_Location: [
    { ROWID: '7', Name: 'HQ' },
    { ROWID: '8', Name: 'Branch' },
  ],
  Add_Employee: [
    { ROWID: '20', Official_Email: 'ada@example.test', Location: '7' },
    { ROWID: '21', Official_Email: 'bob@example.test', Location: '8' },
  ],
  Add_Holiday: [
    { ROWID: '1', Name: 'new_year', Applicable_For: 'All Locations', Locations_list: '8' },
    { ROWID: '2', Name: 'founders', Applicable_For: 'Specific Locations', Locations_list: '7' },
    { ROWID: '3', Name: 'branch_day', Applicable_For: 'Specific Locations', Locations_list: '8' },
    { ROWID: '9', Name: '7', Applicable_For: 'Specific Locations', Locations_list: '8' },
  ],
};

test('a two-hop record-query path through a lookup resolves the stored linked id', async () => {
  const loaded = await loadReport(APP_LOOKUP_ID, 'Holidays_Employee');
  try {
    const adapter = makeAdapter(LOOKUP_TABLES);
    (globalThis as Record<string, unknown>).__c2cDatastore = adapter;
    employeeGrant(loaded, ['Official_Email', 'Location']);
    const live = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: 10 }, LOOKUP_USER);
    assert.equal(live.status, 200, JSON.stringify(live.body).slice(0, 300));
    assert.ok(adapter.calls.some((call) => call.startsWith("Add_Employee @0 Official_Email = 'ada@example.test'")), adapter.calls.join('\n'));
    const rows = live.body.rows as Record<string, unknown>[];
    assert.deepEqual(rows.map((row) => row.Name).sort(), ['founders', 'new_year']);
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await loaded.close();
  }
});

test('a two-hop record-query path cannot match a plain field without a grant on the linked record', async () => {
  const loaded = await loadReport(APP_LOOKUP_ID, 'Lookup_ID_Probe');
  try {
    const adapter = makeAdapter(LOOKUP_TABLES);
    (globalThis as Record<string, unknown>).__c2cDatastore = adapter;
    employeeGrant(loaded, ['Official_Email', 'Location']);
    delete loaded.access.profiles.Staff!.Add_Location;
    const live = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: 10 }, LOOKUP_USER);
    assert.equal(live.status, 200, JSON.stringify(live.body).slice(0, 300));
    assert.ok(adapter.calls.some((call) => call.startsWith("Add_Employee @0 Official_Email = 'ada@example.test'")), adapter.calls.join('\n'));
    assert.equal(adapter.calls.some((call) => call.startsWith('Add_Location ')), false, adapter.calls.join('\n'));
    assert.deepEqual(live.body.rows, []);
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await loaded.close();
  }
});

test('a null lookup in a two-hop record-query path narrows instead of matching every row', async () => {
  const loaded = await loadReport(APP_LOOKUP_ID, 'Holidays_Employee');
  try {
    const adapter = makeAdapter({
      ...LOOKUP_TABLES,
      Add_Employee: [{ ROWID: '20', Official_Email: 'ada@example.test', Location: null }],
    });
    (globalThis as Record<string, unknown>).__c2cDatastore = adapter;
    employeeGrant(loaded, ['Official_Email', 'Location']);
    const live = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: 10 }, LOOKUP_USER);
    assert.equal(live.status, 200, JSON.stringify(live.body).slice(0, 300));
    assert.deepEqual((live.body.rows as Record<string, unknown>[]).map((row) => row.Name), ['new_year']);
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await loaded.close();
  }
});

test('a two-hop record-query path fails closed when the first hop is no lookup', async () => {
  const loaded = await loadReport(APP_LOOKUP_ID, 'Holidays_Employee');
  try {
    const adapter = makeAdapter(LOOKUP_TABLES);
    (globalThis as Record<string, unknown>).__c2cDatastore = adapter;
    const tree = loaded.baseCriteria as unknown as { args?: { args?: { value?: { __rows?: { path: string[] } } }[] }[] };
    const leaf = tree.args?.[1]?.args?.[1];
    assert.ok(leaf?.value?.__rows);
    leaf.value.__rows.path = ['Official_Email', 'ID'];
    employeeGrant(loaded, ['Official_Email', 'Location']);
    const live = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: 10 }, LOOKUP_USER);
    assert.equal(live.status, 200, JSON.stringify(live.body).slice(0, 300));
    // Only the "All Locations" branch still matches: the failed sub-query narrows, never widens.
    assert.equal(adapter.calls.some((call) => call.startsWith('Add_Employee ')), false, adapter.calls.join('\n'));
    assert.deepEqual((live.body.rows as Record<string, unknown>[]).map((row) => row.Name), ['new_year']);
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await loaded.close();
  }
});

test('a hidden lookup hop fails closed: no sub-query, no rows', async () => {
  const loaded = await loadReport(APP_LOOKUP_ID, 'Holidays_Employee');
  try {
    const adapter = makeAdapter(LOOKUP_TABLES);
    (globalThis as Record<string, unknown>).__c2cDatastore = adapter;
    employeeGrant(loaded, ['Official_Email']);
    const live = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: 10 }, LOOKUP_USER);
    assert.equal(live.status, 200, JSON.stringify(live.body).slice(0, 300));
    assert.equal(adapter.calls.some((call) => call.startsWith('Add_Employee ')), false, adapter.calls.join('\n'));
    assert.deepEqual((live.body.rows as Record<string, unknown>[]).map((row) => row.Name), ['new_year']);
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await loaded.close();
  }
});
