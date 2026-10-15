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

function invoke(handler: (req: unknown, res: unknown) => unknown, body: Record<string, unknown>) {
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
  return Promise.resolve(handler({ user: USER, body }, res)).then(() => ({
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
