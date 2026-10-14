/**
 * Over-cap report endpoints must return the same rows as the unsplit read.
 * On 3875abf the live branch answers HTTP 200 with rows: [] and notice "staged zcql".
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse, parseFile, parseProject, type App } from '../../core/src/index.js';
import { generateUi } from '../src/index.js';

const PAGE = 300;
const USER = { profile: 'Staff', loginUser: 'ada@example.test' };

interface Stage {
  sql: string;
  columns: string[];
  table: string;
  where: string;
}

interface LookupSpec {
  table: string;
  fk: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function textField(name: string): string {
  return `\t\t${name}\n\t\t(\n\t\t\ttype = text\n\t\t)`;
}

function lookupField(name: string, form: string, display: string): string {
  return `\t\t${name}\n\t\t(\n\t\t\ttype = list\n\t\t\tvalues = ${form}.${display}\n\t\t)`;
}

function share(form: string, reports: readonly string[]): string {
  const lines = reports.map((name) => `\t\t\t\t\t\t${name} = {"View"}`).join('\n');
  return `\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\t${form}
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
${lines}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`;
}

function parseStage(sql: string): Stage {
  const match = /^SELECT (.+) FROM ([A-Za-z_][A-Za-z0-9_]*)(?: WHERE (.+?))?( ORDER BY .+)?$/.exec(sql);
  assert.ok(match, sql);
  return {
    sql,
    columns: match[1]!.split(', ').filter((column) => column.length > 0),
    table: match[2]!,
    where: match[3] ?? '',
  };
}

function stagesOf(source: string): Stage[] {
  const marker = 'export const zcqlStages = ';
  const at = source.indexOf(marker);
  assert.ok(at >= 0, 'report did not stage');
  const start = at + marker.length;
  assert.equal(source[start], '[');
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > start, 'zcqlStages array did not close');
  const queries = JSON.parse(source.slice(start, end + 1)) as string[];
  return queries.map(parseStage);
}

function outerWrap(text: string): boolean {
  if (!text.startsWith('(') || !text.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0) return i === text.length - 1;
  }
  return false;
}

function evalWhere(rows: Record<string, unknown>[], where: string): Record<string, unknown>[] {
  let w = (where || '').trim();
  if (!w || w === 'true') return rows;
  while (outerWrap(w)) w = w.slice(1, -1).trim();
  if (!w || w === 'true') return rows;
  const terms: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < w.length; i++) {
    const ch = w[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && w.slice(i, i + 5) === ' AND ') {
      terms.push(cur);
      cur = '';
      i += 4;
      continue;
    }
    cur += ch;
  }
  terms.push(cur);
  let matched = rows;
  for (const term0 of terms) {
    let term = term0.trim();
    while (outerWrap(term)) term = term.slice(1, -1).trim();
    if (!term || term === 'true') continue;
    if (term.includes(' AND ')) {
      matched = evalWhere(matched, term);
      continue;
    }
    const inn = /^(\w+) IN \((.*)\)$/.exec(term);
    if (inn) {
      const vals = inn[2]!.split(', ').map((value) => value.replace(/^'(.*)'$/s, '$1').replace(/''/g, "'"));
      const set = new Set(vals.map(String));
      matched = matched.filter((row) => set.has(String(row[inn[1]!])));
      continue;
    }
    const eq = /^(\w+) = '(.*)'$/.exec(term);
    if (eq) {
      matched = matched.filter((row) => String(row[eq[1]!]) === eq[2]);
      continue;
    }
    throw new Error(`unhandled where term: ${term} (in ${where})`);
  }
  return matched;
}

function stageFor(stages: Stage[], form: string, where: string): Stage {
  const bound = /\bIN \(/.test(where);
  const hits = stages.filter((stage) => stage.table === form && (bound ? /\bIN \(/.test(stage.where) : !/\bIN \(/.test(stage.where)));
  if (hits.length === 1) return hits[0]!;
  const column = where.match(/\b(\w+) IN \(/)?.[1];
  const byColumn = hits.filter((stage) => column && stage.where.includes(`${column} IN (`));
  if (byColumn.length === 1) return byColumn[0]!;
  throw new Error(`no single stage for ${form} (${hits.length} hits): ${where.slice(0, 120)}`);
}

function makeAdapter(tables: Record<string, Record<string, unknown>[]>, stages: Stage[]) {
  const calls: string[] = [];
  const error: { message?: string } = {};
  const adapter = {
    calls,
    error,
    reset() {
      calls.length = 0;
    },
    async query(form: string, where: string, limit: number, offset = 0) {
      try {
        calls.push(`${form} @${offset} ${where}`);
        const stage = stageFor(stages, form, where);
        const all = (tables[form] ?? []).slice().sort((a, b) => Number(a.ROWID) - Number(b.ROWID));
        const page = evalWhere(all, where).slice(offset, offset + limit);
        return page.map((row) => {
          const out: Record<string, unknown> = {};
          for (const column of stage.columns) {
            if (!Object.prototype.hasOwnProperty.call(row, column)) {
              throw new Error(`${form} has no ${column}`);
            }
            out[column] = row[column];
          }
          return out;
        });
      } catch (err) {
        error.message = err instanceof Error ? err.message : String(err);
        throw err;
      }
    },
  };
  return adapter;
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

async function loadReport(app: App, reportName: string, staged = true) {
  const ui = generateUi(app);
  const file = ui.files.find((item) => item.path.startsWith('functions/reports/') && String(item.data).includes(`export const reportName = ${JSON.stringify(reportName)};`));
  assert.ok(file, ui.files.map((item) => item.path).join('\n'));
  const source = String(file.data);
  if (!staged) assert.equal(source.includes('export const zcqlStages'), false, `${reportName} staged`);
  const stages = staged ? stagesOf(source) : [];
  const dir = mkdtempSync(join(tmpdir(), 'c2c-report-live-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const item of ui.files) {
    const path = join(dir, item.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, item.data);
  }
  writeFileSync(join(dir, 'functions/c2c-deploy.json'), JSON.stringify({ mode: 'live', appTimeZone: 'UTC' }));
  const store = await import(pathToFileURL(join(dir, 'functions/c2c-store.mjs')).href) as {
    setDatastore(next: unknown): void;
  };
  const report = (await import(pathToFileURL(join(dir, file.path)).href)) as {
    default: (req: unknown, res: unknown) => unknown;
    access: { profiles: Record<string, Record<string, { fields?: string[]; recordFilter?: unknown }>> };
    columnFields: string[];
    formName: string;
    baseCriteria: { op: string };
    lookupParents: Record<string, string>;
  };
  return {
    dir,
    source,
    stages,
    store,
    handler: report.default,
    access: report.access,
    columnFields: report.columnFields,
    formName: report.formName,
    baseCriteria: report.baseCriteria,
    lookupParents: report.lookupParents,
    async close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A lookup display needs its parent form readable, as on the unstaged read. Grant each parent in full. */
function grantParents(loaded: Awaited<ReturnType<typeof loadReport>>, profile = 'Staff'): void {
  const forms = loaded.access.profiles[profile]!;
  for (const parent of Object.values(loaded.lookupParents)) forms[parent] = {};
}

function lookupsOf(stages: Stage[], base: string, tables: Record<string, Record<string, unknown>[]>): LookupSpec[] {
  const out: LookupSpec[] = [];
  for (const stage of stages) {
    if (stage.table === base) continue;
    const bind = /:([A-Za-z_][A-Za-z0-9_]*)/.exec(stage.where);
    assert.ok(bind, stage.sql);
    const fk = bind[1]!.slice(base.length + 1);
    const existing = out.find((item) => item.table === stage.table && item.fk === fk);
    if (existing) {
      for (const column of stage.columns) if (!existing.columns.includes(column)) existing.columns.push(column);
      continue;
    }
    out.push({ table: stage.table, fk, columns: stage.columns.slice(), rows: tables[stage.table] ?? [] });
  }
  return out;
}

function unsplitPage(
  baseRows: Record<string, unknown>[],
  where: (row: Record<string, unknown>) => boolean,
  lookups: LookupSpec[],
  offset: number,
  size: number,
): Record<string, unknown>[] {
  const matched = baseRows.filter(where).sort((a, b) => Number(a.ROWID) - Number(b.ROWID));
  return matched.slice(offset, offset + size).map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const look of lookups) {
      const rel = look.rows.find((item) => String(item.ROWID) === String(row[look.fk]));
      if (!rel) continue;
      for (const column of look.columns) {
        if (column === 'ROWID') continue;
        // A lookup display lives only on the dotted key. The bare name is the base
        // column (often the FK). Copying the display onto it hides the id.
        if (look.fk === 'ROWID') out[column] = rel[column];
        else out[`${look.fk}.${column}`] = rel[column];
      }
    }
    return out;
  });
}

async function expectPages(
  loaded: Awaited<ReturnType<typeof loadReport>>,
  tables: Record<string, Record<string, unknown>[]>,
  base: string,
  where: (row: Record<string, unknown>) => boolean,
) {
  const adapter = makeAdapter(tables, loaded.stages);
  loaded.store.setDatastore(adapter);
  const lookups = lookupsOf(loaded.stages, base, tables);
  for (const page of [0, 1]) {
    adapter.reset();
    adapter.calls.length = 0;
    const live = await invoke(loaded.handler, { op: 'query', page, pageSize: PAGE });
    assert.equal(live.status, 200, `${adapter.error.message ?? ''} ${JSON.stringify(live.body).slice(0, 400)}`);
    assert.equal(live.body.notice, undefined, JSON.stringify(live.body).slice(0, 200));
    const expected = unsplitPage(tables[base] ?? [], where, lookups, page * PAGE, PAGE);
    const rows = live.body.rows as Record<string, unknown>[];
    assert.equal(rows.length, expected.length, `page ${page}`);
    assert.ok(expected.length > 0, `page ${page} expected rows`);
    for (let i = 0; i < expected.length; i++) {
      assert.deepEqual(rows[i], expected[i], `page ${page} row ${i} id ${expected[i]!.ROWID}`);
    }
    assert.ok(adapter.calls.some((call) => call.startsWith(`${base} @`)), `page ${page} missed the base read`);
    assert.ok(adapter.calls.some((call) => call.includes(' IN (')), `page ${page} did not run a bound stage`);
  }
}

test('a report wider than 30 columns returns the filtered page, including rows past 300', async () => {
  const names = ['Keep', ...Array.from({ length: 35 }, (_, i) => `F${String(i).padStart(3, '0')}`)];
  const columns = names.map((name) => `\t\t\t${name}`).join('\n');
  const app = appOf(`\tform Item
\t{
${names.map(textField).join('\n')}
\t}
\tlist Kept
\t{
\t\tshow all rows from Item [Keep == "yes"]
\t\t(
${columns}
\t\t)
\t}
${share('Item', ['Kept'])}`);
  const loaded = await loadReport(app, 'Kept');
  try {
    assert.match(loaded.source, /export const zcqlStages = /);
    const baseRows: Record<string, unknown>[] = [];
    for (let id = 1; id <= 400; id++) {
      const row: Record<string, unknown> = { ROWID: String(id), Keep: id % 5 === 0 ? 'no' : 'yes' };
      for (const name of names) if (name !== 'Keep') row[name] = `${name}_${id}`;
      baseRows.push(row);
    }
    const yes = baseRows.filter((row) => row.Keep === 'yes');
    assert.ok(yes.length > PAGE, `need more than one page, got ${yes.length}`);
    await expectPages(loaded, { Item: baseRows }, 'Item', (row) => row.Keep === 'yes');
    const late = names[names.length - 1]!;
    assert.ok(loaded.stages[0]!.columns.includes('ROWID'));
    assert.equal(loaded.stages[0]!.columns.includes(late), false, 'the last column must sit on a later chunk');
  } finally {
    await loaded.close();
  }
});

function lookupApp(heads: readonly { form: string; display: string }[]): App {
  const forms = heads.map((head) => `\tform ${head.form}\n\t{\n${textField(head.display)}\n\t}`).join('\n');
  const fields = heads.map((head) => lookupField(head.form, head.form, head.display)).join('\n');
  const columns = heads.map((head) => `\t\t\t${head.form}.${head.display}`).join('\n');
  return appOf(`${forms}
\tform Order
\t{
${fields}
\t}
\tlist All_Orders
\t{
\t\tshow all rows from Order
\t\t(
${columns}
\t\t)
\t}
${share('Order', ['All_Orders'])}`);
}

function seedLookups(heads: readonly { form: string; display: string }[], orders: number) {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const head of heads) {
    tables[head.form] = [1, 2, 3, 4].map((id) => ({
      ROWID: String(id),
      [head.display]: `${head.form}-${id}`,
    }));
  }
  const base: Record<string, unknown>[] = [];
  for (let id = 1; id <= orders; id++) {
    const row: Record<string, unknown> = { ROWID: String(id) };
    heads.forEach((head, index) => {
      row[head.form] = String(((id + index) % 4) + 1);
    });
    base.push(row);
  }
  tables.Order = base;
  return tables;
}

test('a report with more than four joins stitches each lookup across a 300-row page', async () => {
  const heads = [
    { form: 'L0', display: 'Name' },
    { form: 'L1', display: 'Name' },
    { form: 'L2', display: 'Name' },
    { form: 'L3', display: 'Name' },
    { form: 'L4', display: 'Title' },
  ];
  const loaded = await loadReport(lookupApp(heads), 'All_Orders');
  try {
    grantParents(loaded);
    const tables = seedLookups(heads, 350);
    assert.ok(loaded.stages.filter((stage) => stage.table !== 'Order').length >= 5);
    await expectPages(loaded, tables, 'Order', () => true);
  } finally {
    await loaded.close();
  }
});

test('lookup display columns keep each related value when the display names collide', async () => {
  const heads = [
    { form: 'Customer', display: 'Name' },
    { form: 'Vendor', display: 'Name' },
    { form: 'Partner', display: 'Name' },
    { form: 'P4', display: 'Name' },
    { form: 'P5', display: 'Name' },
  ];
  const loaded = await loadReport(lookupApp(heads), 'All_Orders');
  try {
    grantParents(loaded);
    const tables = seedLookups(heads, 350);
    tables.Customer = [
      { ROWID: '1', Name: 'Alice' },
      { ROWID: '2', Name: 'Carol' },
      { ROWID: '3', Name: 'Eve' },
      { ROWID: '4', Name: 'Gina' },
    ];
    tables.Vendor = [
      { ROWID: '1', Name: 'Victor' },
      { ROWID: '2', Name: 'Vera' },
      { ROWID: '3', Name: 'Vince' },
      { ROWID: '4', Name: 'Veda' },
    ];
    await expectPages(loaded, tables, 'Order', () => true);
    const first = tables.Order![0]!;
    const customer = tables.Customer.find((row) => row.ROWID === first.Customer);
    const vendor = tables.Vendor.find((row) => row.ROWID === first.Vendor);
    assert.notEqual(customer!.Name, vendor!.Name);
    assert.equal(customer!.Name, 'Carol');
    assert.equal(vendor!.Name, 'Vince');
  } finally {
    await loaded.close();
  }
});

function appFromTarget(target: string): App {
  const st = statSync(target);
  if (!st.isDirectory()) return parseFile(target).ir;
  const ds = readdirSync(target).find((child) => child.toLowerCase().endsWith('.ds'));
  assert.ok(ds, target);
  return parseFile(join(target, ds!)).ir;
}

function assertStagedReportsRun(label: string, app: App): number {
  const files = generateUi(app).files.filter((item) => item.path.startsWith('functions/reports/') && item.path.endsWith('.mjs'));
  assert.ok(files.length > 0, label);
  let staged = 0;
  for (const file of files) {
    const text = String(file.data);
    assert.equal(text.includes('notice: "staged zcql"'), false, `${label} ${file.path}`);
    if (!text.includes('export const zcqlStages')) continue;
    staged++;
    assert.match(text, /zcql: zcqlStages/, `${label} ${file.path}`);
    assert.match(text, /createRuntime\(/, `${label} ${file.path}`);
    assert.equal(text.includes('await datastore.query('), false, `${label} ${file.path}`);
    assert.equal(text.includes('SELECT *'), false, `${label} ${file.path}`);
    const exported = /export const zcqlStages = (\[[\s\S]*?\]);/.exec(text);
    assert.ok(exported, `${label} ${file.path}`);
    const queries = JSON.parse(exported[1]!) as string[];
    assert.ok(queries.length >= 1, `${label} ${file.path}`);
    for (const sql of queries) {
      const listed = /SELECT\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s+FROM\s+[A-Za-z_][A-Za-z0-9_]*/.exec(sql);
      assert.ok(listed, sql);
      const width = listed[1]!.split(',').length;
      assert.ok(width >= 1 && width <= 30, sql);
    }
  }
  return staged;
}

test('freight-forwarding staged reports execute instead of returning an empty 200', () => {
  const app = parseProject(join(process.cwd(), 'fixtures/redistributable/freight-forwarding')).ir;
  const staged = assertStagedReportsRun('freight-forwarding', app);
  // A long column list, a join, or a stored projection past the unverified
  // select cap stages the report. Each statement lists at most 30 columns.
  assert.equal(staged, 9);
});

test('gallery report endpoints no longer return a fixed empty 200', { skip: !process.env.C2C_FIXTURES_DIR }, () => {
  const dir = join(process.env.C2C_FIXTURES_DIR!, 'gallery');
  const names = readdirSync(dir).filter((name) => !name.startsWith('.')).sort();
  let staged = 0;
  let reports = 0;
  for (const name of names) {
    const path = join(dir, name);
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      if (!readdirSync(path).some((child) => child.toLowerCase().endsWith('.ds'))) continue;
    } else if (!name.toLowerCase().endsWith('.ds')) continue;
    const files = generateUi(appFromTarget(path)).files.filter((item) => item.path.startsWith('functions/reports/') && item.path.endsWith('.mjs'));
    reports += files.length;
    for (const file of files) {
      const text = String(file.data);
      assert.equal(text.includes('notice: "staged zcql"'), false, `${name} ${file.path}`);
      if (!text.includes('export const zcqlStages')) continue;
      staged++;
      assert.match(text, /zcql: zcqlStages/, `${name} ${file.path}`);
      assert.match(text, /createRuntime\(/, `${name} ${file.path}`);
      assert.equal(text.includes('await datastore.query('), false, `${name} ${file.path}`);
    }
  }
  assert.ok(reports > 0);
  assert.ok(staged >= 12, `gallery staged reports: ${staged}`);
});

function shareFields(form: string, reports: readonly string[], visible: readonly string[], hidden: readonly string[]): string {
  const lines = reports.map((name) => `\t\t\t\t\t\t${name} = {"View"}`).join('\n');
  const perms = [
    ...visible.map((name) => `\t\t\t\t\t\t${name}\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tvisibility:true,readonly:false\n\t\t\t\t\t\t}`),
    ...hidden.map((name) => `\t\t\t\t\t\t${name}\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tvisibility:false,readonly:true\n\t\t\t\t\t\t}`),
  ].join('\n');
  return `\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\t${form}
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
${lines}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
${perms}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`;
}

function collisionHeads(): { form: string; display: string }[] {
  return [
    { form: 'Language', display: 'Language' },
    { form: 'Resource_Type', display: 'Resource_Type' },
    { form: 'Author', display: 'Author_Name' },
    { form: 'Publisher', display: 'Publisher_Name' },
    { form: 'Category', display: 'Category' },
  ];
}

function collisionBody(hidden: readonly string[] | null): string {
  const heads = collisionHeads();
  const forms = heads.map((head) => `\tform ${head.form}\n\t{\n${textField(head.display)}\n\t}`).join('\n');
  const fields = heads.map((head) => lookupField(head.form, head.form, head.display)).join('\n');
  const columns = heads.flatMap((head) => [`\t\t\t${head.form}`, `\t\t\t${head.form}.${head.display}`]).join('\n');
  const visible = heads.map((head) => head.form).filter((name) => !hidden?.includes(name));
  const shareBlock = hidden
    ? shareFields('Resource', ['All_Resources'], visible, hidden)
    : share('Resource', ['All_Resources']);
  return `${forms}
\tform Resource
\t{
${fields}
\t}
\tlist All_Resources
\t{
\t\tshow all rows from Resource
\t\t(
${columns}
\t\t)
\t}
${shareBlock}`;
}

function seedBase(heads: readonly { form: string; display: string }[], form: string) {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const head of heads) {
    tables[head.form] = [1, 2, 3, 4].map((id) => ({
      ROWID: String(id),
      [head.display]: `${head.form}.${head.display}#${id}`,
    }));
  }
  tables[form] = [1, 2].map((id) => {
    const row: Record<string, unknown> = { ROWID: String(id) };
    for (const head of heads) row[head.form] = '1';
    return row;
  });
  return tables;
}

test('a lookup display does not replace a base column of the same name', async () => {
  const heads = collisionHeads();
  const loaded = await loadReport(appOf(collisionBody(null)), 'All_Resources');
  try {
    grantParents(loaded);
    const tables = seedBase(heads, 'Resource');
    const adapter = makeAdapter(tables, loaded.stages);
    loaded.store.setDatastore(adapter);
    const live = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: PAGE });
    assert.equal(live.status, 200, JSON.stringify(live.body).slice(0, 400));
    const expected = unsplitPage(tables.Resource ?? [], () => true, lookupsOf(loaded.stages, 'Resource', tables), 0, PAGE);
    assert.deepEqual(live.body.rows, expected);
    const row = (live.body.rows as Record<string, unknown>[])[0]!;
    assert.equal(row.Language, '1');
    assert.equal(row.Resource_Type, '1');
    assert.equal(row['Language.Language'], 'Language.Language#1');
    assert.equal(row['Resource_Type.Resource_Type'], 'Resource_Type.Resource_Type#1');
    assert.notEqual(row.Language, row['Language.Language']);
  } finally {
    await loaded.close();
  }
});

test('a profile that hides a lookup does not receive that lookup display', async () => {
  const loaded = await loadReport(appOf(collisionBody(['Language'])), 'All_Resources');
  try {
    grantParents(loaded);
    const tables = seedBase(collisionHeads(), 'Resource');
    const adapter = makeAdapter(tables, loaded.stages);
    loaded.store.setDatastore(adapter);
    const live = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: PAGE });
    assert.equal(live.status, 200, JSON.stringify(live.body).slice(0, 400));
    const row = (live.body.rows as Record<string, unknown>[])[0]!;
    assert.equal(row.Author, '1');
    assert.equal(row['Author.Author_Name'], 'Author.Author_Name#1');
    assert.equal(Object.hasOwn(row, 'Language'), false);
    assert.equal(Object.hasOwn(row, 'Language.Language'), false);
    assert.equal(row['Resource_Type.Resource_Type'], 'Resource_Type.Resource_Type#1');
    loaded.access.profiles.Staff = { Resource: { fields: ['Language.Language', 'Author', 'Resource_Type', 'Publisher', 'Category'] } };
    grantParents(loaded);
    const named = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: PAGE });
    const namedRow = (named.body.rows as Record<string, unknown>[])[0]!;
    assert.equal(Object.hasOwn(namedRow, 'Language.Language'), false);
    assert.equal(namedRow['Author.Author_Name'], 'Author.Author_Name#1');
  } finally {
    await loaded.close();
  }
});

function seedLibrary(stages: Stage[], base: string) {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const lookups = lookupsOf(stages, base, tables);
  for (const look of lookups) {
    const rows = [1, 2, 3, 4].map((id) => {
      const row: Record<string, unknown> = { ROWID: String(id) };
      for (const column of look.columns) {
        if (column !== 'ROWID') row[column] = `${look.table}.${column}#${id}`;
      }
      return row;
    });
    tables[look.table] = rows;
    look.rows = rows;
  }
  const baseCols = new Set<string>();
  for (const stage of stages) {
    if (stage.table !== base) continue;
    for (const column of stage.columns) baseCols.add(column);
  }
  const baseRows = [1, 2].map((id) => {
    const row: Record<string, unknown> = { ROWID: String(id) };
    for (const column of baseCols) {
      if (column !== 'ROWID') row[column] = `${column}_${id}`;
    }
    for (const look of lookups) row[look.fk] = '1';
    return row;
  });
  tables[base] = baseRows;
  return { tables, lookups };
}

test('library-management all-resources reports keep lookup ids and hide a denied lookup', { skip: !process.env.C2C_FIXTURES_DIR }, async () => {
  const app = appFromTarget(join(process.env.C2C_FIXTURES_DIR!, 'gallery', 'library-management'));
  for (const reportName of ['All_Resources', 'All_Resource_Images']) {
    const loaded = await loadReport(app, reportName);
    try {
      assert.equal(loaded.baseCriteria.op, 'true', `${reportName} criteria`);
      const { tables, lookups } = seedLibrary(loaded.stages, loaded.formName);
      const language = lookups.find((look) => look.fk === 'Language' && look.columns.includes('Language'));
      const kind = lookups.find((look) => look.fk === 'Resource_Type' && look.columns.includes('Resource_Type'));
      assert.ok(language && kind, `${reportName} stages`);
      loaded.access.profiles.Staff = { [loaded.formName]: {} };
      grantParents(loaded);
      const adapter = makeAdapter(tables, loaded.stages);
      loaded.store.setDatastore(adapter);
      const open = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: PAGE });
      assert.equal(open.status, 200, `${reportName} ${JSON.stringify(open.body).slice(0, 300)}`);
      const row = (open.body.rows as Record<string, unknown>[])[0]!;
      assert.equal(row.Language, '1', reportName);
      assert.equal(row.Resource_Type, '1', reportName);
      assert.equal(row['Language.Language'], language!.rows[0]!.Language, reportName);
      assert.equal(row['Resource_Type.Resource_Type'], kind!.rows[0]!.Resource_Type, reportName);
      const bare = (loaded.stages.find((stage) => stage.table === loaded.formName)?.columns ?? []).filter(
        (field) => field !== 'ROWID' && field !== 'Language' && field !== 'Resource_Type',
      );
      loaded.access.profiles.Staff = { [loaded.formName]: { fields: bare } };
      grantParents(loaded);
      const hidden = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: PAGE });
      assert.equal(hidden.status, 200, `${reportName} hidden ${JSON.stringify(hidden.body).slice(0, 300)}`);
      const blocked = (hidden.body.rows as Record<string, unknown>[])[0]!;
      assert.equal(Object.hasOwn(blocked, 'Language'), false, reportName);
      assert.equal(Object.hasOwn(blocked, 'Language.Language'), false, reportName);
      assert.equal(Object.hasOwn(blocked, 'Resource_Type'), false, reportName);
      assert.equal(Object.hasOwn(blocked, 'Resource_Type.Resource_Type'), false, reportName);
      assert.equal(blocked['Author.Author_Name'], lookups.find((look) => look.fk === 'Author')!.rows[0]!.Author_Name, reportName);
    } finally {
      await loaded.close();
    }
  }
});

/**
 * A staged lookup display obeys the parent form's grant exactly as the unstaged
 * lookup read does: a granted lookup whose display field the parent form
 * hides keeps the lookup id and drops the display.
 */
const LIBRARY_HEADS = ['L1', 'L2', 'L3', 'L4'];

function libraryApp(): App {
  const others = LIBRARY_HEADS.map((head) => `\tform ${head}\n\t{\n${textField('Name')}\n\t}`).join('\n');
  const lookups = [lookupField('Author', 'Author', 'Author_Name'), ...LIBRARY_HEADS.map((head) => lookupField(head, head, 'Name'))].join('\n');
  const wide = ['Title', 'Author', 'Author.Author_Name', ...LIBRARY_HEADS.map((head) => `${head}.Name`)].map((name) => `\t\t\t${name}`).join('\n');
  return appOf(`\tform Author
\t{
${textField('Author_Name')}
${textField('Country')}
\t}
${others}
\tform Resource
\t{
${textField('Title')}
${lookups}
\t}
\tlist All_Resources
\t{
\t\tshow all rows from Resource
\t\t(
${wide}
\t\t)
\t}
\tlist Resource_List
\t{
\t\tshow all rows from Resource
\t\t(
\t\t\tTitle
\t\t\tAuthor
\t\t)
\t}
${share('Resource', ['All_Resources', 'Resource_List'])}`);
}

function libraryTables(): Record<string, Record<string, unknown>[]> {
  const tables: Record<string, Record<string, unknown>[]> = {
    Author: [
      { ROWID: '1', Author_Name: 'Ada Lovelace', Country: 'UK' },
      { ROWID: '2', Author_Name: 'Grace Hopper', Country: 'US' },
    ],
    Resource: [
      { ROWID: '10', Title: 'Notes', Author: '1', L1: '1', L2: '1', L3: '1', L4: '1' },
      { ROWID: '11', Title: 'Compilers', Author: '2', L1: '1', L2: '1', L3: '1', L4: '1' },
    ],
  };
  for (const head of LIBRARY_HEADS) tables[head] = [{ ROWID: '1', Name: `${head}-1` }];
  return tables;
}

/** Unstaged reads: the report row query and the parent lookup query, each by WHERE. */
function plainAdapter(tables: Record<string, Record<string, unknown>[]>) {
  return {
    async query(form: string, where: string, limit: number, offset = 0) {
      const all = (tables[form] ?? []).slice().sort((a, b) => Number(a.ROWID) - Number(b.ROWID));
      return evalWhere(all, where)
        .slice(offset, offset + limit)
        .map((row) => ({ ...row }));
    },
  };
}

type Grant = { fields?: string[]; recordFilter?: unknown };

function libraryProfile(fk: boolean, display: boolean, author: Grant = {}): Record<string, Grant> {
  const profile: Record<string, Grant> = {
    Resource: { fields: ['Title', ...(fk ? ['Author'] : []), ...LIBRARY_HEADS] },
    Author: { ...author, fields: display ? ['Author_Name', 'Country'] : ['Country'] },
  };
  for (const head of LIBRARY_HEADS) profile[head] = {};
  return profile;
}

async function readLibrary(staged: boolean, profile: Record<string, Grant>): Promise<Record<string, unknown>[]> {
  const loaded = await loadReport(libraryApp(), staged ? 'All_Resources' : 'Resource_List', staged);
  try {
    const tables = libraryTables();
    loaded.store.setDatastore(staged ? makeAdapter(tables, loaded.stages) : plainAdapter(tables));
    loaded.access.profiles.Staff = profile;
    const live = await invoke(loaded.handler, { op: 'query', page: 0, pageSize: PAGE });
    assert.equal(live.status, 200, JSON.stringify(live.body).slice(0, 400));
    return live.body.rows as Record<string, unknown>[];
  } finally {
    await loaded.close();
  }
}

/** What a row reveals about the Author lookup: the fk cell, and whether any value is the parent display. */
function authorView(row: Record<string, unknown>): { fk: string; display: string } {
  const shown = Object.values(row).filter((value) => value === 'Ada Lovelace' || value === 'Grace Hopper');
  const fk = !Object.hasOwn(row, 'Author') ? 'absent' : row.Author === '1' || row.Author === '2' ? 'id' : 'display';
  return { fk, display: shown.length ? 'shown' : 'hidden' };
}

test('a staged report hides a lookup display the parent form denies and keeps the lookup id', async () => {
  const rows = await readLibrary(true, libraryProfile(true, false));
  assert.equal(rows.length, 2);
  const row = rows[0]!;
  assert.equal(row.Author, '1');
  assert.equal(Object.hasOwn(row, 'Author.Author_Name'), false, JSON.stringify(row));
  assert.equal(JSON.stringify(rows).includes('Ada Lovelace'), false);
  assert.equal(row['L1.Name'], 'L1-1');
});

test('staged and unstaged reports reveal the same lookup values for every fk and parent display grant', async () => {
  const table: string[] = [];
  for (const fk of [true, false]) {
    for (const display of [true, false]) {
      const staged = (await readLibrary(true, libraryProfile(fk, display))).map(authorView);
      const plain = (await readLibrary(false, libraryProfile(fk, display))).map(authorView);
      const label = `fk ${fk ? 'granted' : 'denied'}, parent display ${display ? 'granted' : 'denied'}`;
      // The unstaged cell holds the display text in place of the id; the staged
      // row keeps the id and carries the display on the dotted key.
      assert.deepEqual(
        staged.map((view) => view.display),
        plain.map((view) => view.display),
        label,
      );
      assert.deepEqual(
        staged.map((view) => view.fk !== 'absent'),
        plain.map((view) => view.fk !== 'absent'),
        label,
      );
      if (fk && !display) {
        assert.deepEqual(staged, plain, label);
        assert.deepEqual(staged[0], { fk: 'id', display: 'hidden' }, label);
      }
      table.push(`${label}: ${staged.map((view) => `${view.fk}/${view.display}`).join(' ')}`);
    }
  }
  assert.deepEqual(table, [
    'fk granted, parent display granted: id/shown id/shown',
    'fk granted, parent display denied: id/hidden id/hidden',
    'fk denied, parent display granted: absent/hidden absent/hidden',
    'fk denied, parent display denied: absent/hidden absent/hidden',
  ]);
});

test('a staged lookup display obeys the parent record filter as the unstaged read does', async () => {
  const author: Grant = { recordFilter: { op: '==', field: 'Country', value: 'UK' } };
  const staged = await readLibrary(true, libraryProfile(true, true, author));
  const plain = await readLibrary(false, libraryProfile(true, true, author));
  assert.equal(staged[0]!['Author.Author_Name'], 'Ada Lovelace');
  assert.equal(plain[0]!.Author, 'Ada Lovelace');
  assert.equal(staged[1]!.Author, '2');
  assert.equal(Object.hasOwn(staged[1]!, 'Author.Author_Name'), false, JSON.stringify(staged[1]));
  assert.equal(plain[1]!.Author, '2');
  assert.deepEqual(
    staged.map((row) => authorView(row).display),
    plain.map((row) => authorView(row).display),
  );
});

function decimalField(name: string): string {
  return `\t\t${name}\n\t\t(\n\t\t\ttype = decimal\n\t\t)`;
}

/**
 * The report lists Author.Author_Name and not the Author column. The parent
 * form still has a decimal Rating. Text order treats '10' as less than '5'.
 */
function dottedDecimalApp(): App {
  const others = LIBRARY_HEADS.map((head) => `\tform ${head}\n\t{\n${textField('Name')}\n\t}`).join('\n');
  const lookups = [lookupField('Author', 'Author', 'Author_Name'), ...LIBRARY_HEADS.map((head) => lookupField(head, head, 'Name'))].join('\n');
  const wide = ['Title', 'Author.Author_Name', ...LIBRARY_HEADS.map((head) => `${head}.Name`)].map((name) => `\t\t\t${name}`).join('\n');
  return appOf(`\tform Author
\t{
${textField('Author_Name')}
${decimalField('Rating')}
\t}
${others}
\tform Resource
\t{
${textField('Title')}
${lookups}
\t}
\tlist All_Resources
\t{
\t\tshow all rows from Resource
\t\t(
${wide}
\t\t)
\t}
\tlist Resource_List
\t{
\t\tshow all rows from Resource
\t\t(
\t\t\tTitle
\t\t\tAuthor
\t\t)
\t}
${share('Resource', ['All_Resources', 'Resource_List'])}`);
}

function dottedDecimalTables(): Record<string, Record<string, unknown>[]> {
  const tables: Record<string, Record<string, unknown>[]> = {
    Author: [
      { ROWID: '1', Author_Name: 'Ada Lovelace', Rating: '10' },
      { ROWID: '2', Author_Name: 'Grace Hopper', Rating: '4.5' },
    ],
    Resource: [
      { ROWID: '10', Title: 'Notes', Author: '1', L1: '1', L2: '1', L3: '1', L4: '1' },
      { ROWID: '11', Title: 'Compilers', Author: '2', L1: '1', L2: '1', L3: '1', L4: '1' },
    ],
  };
  for (const head of LIBRARY_HEADS) tables[head] = [{ ROWID: '1', Name: `${head}-1` }];
  return tables;
}

/** Rows the parent read returns. A quoted comparison is text order. A shadow predicate is left for the exact pass. */
function matchParentWhere(rows: Record<string, unknown>[], where: string): Record<string, unknown>[] {
  let matched = rows;
  const inn = /ROWID IN \(([^)]*)\)/.exec(where);
  if (inn) {
    const ids = new Set(inn[1]!.split(',').map((value) => value.trim().replace(/^'(.*)'$/, '$1')));
    matched = matched.filter((row) => ids.has(String(row.ROWID)));
  }
  const rel = /\b([A-Za-z_][A-Za-z0-9_]*) (<|<=|>|>=) '([^']*)'/.exec(where);
  if (rel) {
    const field = rel[1]!;
    const op = rel[2]!;
    const value = rel[3]!;
    matched = matched.filter((row) => {
      const cell = row[field] == null ? '' : String(row[field]);
      if (op === '<') return cell < value;
      if (op === '<=') return cell <= value;
      if (op === '>') return cell > value;
      return cell >= value;
    });
  }
  return matched;
}

function fullAdapter(tables: Record<string, Record<string, unknown>[]>) {
  const calls: string[] = [];
  return {
    calls,
    async query(form: string, where: string, limit: number, offset = 0) {
      calls.push(`${form} @${offset} ${where}`);
      const all = (tables[form] ?? []).slice().sort((a, b) => Number(a.ROWID) - Number(b.ROWID));
      return matchParentWhere(all, where)
        .slice(offset, offset + limit)
        .map((row) => ({ ...row }));
    },
  };
}

function stagedDecimalAdapter(tables: Record<string, Record<string, unknown>[]>, stages: Stage[]) {
  const inner = makeAdapter(tables, stages);
  return {
    calls: inner.calls,
    error: inner.error,
    async query(form: string, where: string, limit: number, offset = 0) {
      if (/\bRating__n\b/.test(where) || /\bRating (<|<=|>|>=) /.test(where)) {
        inner.calls.push(`${form} @${offset} ${where}`);
        const all = (tables[form] ?? []).slice().sort((a, b) => Number(a.ROWID) - Number(b.ROWID));
        return matchParentWhere(all, where)
          .slice(offset, offset + limit)
          .map((row) => ({ ...row }));
      }
      return inner.query(form, where, limit, offset);
    },
  };
}

function shownAuthor(row: Record<string, unknown>, staged: boolean): string {
  const value = staged ? row['Author.Author_Name'] : row.Author;
  return value === 'Ada Lovelace' || value === 'Grace Hopper' ? value : '';
}

test('a staged lookup display applies a parent decimal record filter when the report omits the lookup column', async () => {
  const app = dottedDecimalApp();
  const staged = await loadReport(app, 'All_Resources', true);
  const plain = await loadReport(app, 'Resource_List', false);
  try {
    assert.match(staged.source, /export const lookupColumns = \[\];/);
    assert.match(staged.source, /export const lookupParents = \{"Author":"Author"/);
    const tables = dottedDecimalTables();
    const cases: { op: '<' | '>='; shown: [string, string] }[] = [
      { op: '<', shown: ['', 'Grace Hopper'] },
      { op: '>=', shown: ['Ada Lovelace', ''] },
    ];
    const parity: string[] = [];
    for (const item of cases) {
      const author: Grant = { fields: ['Author_Name'], recordFilter: { op: item.op, field: 'Rating', value: '5' } };
      const profile: Record<string, Grant> = {
        Resource: { fields: ['Title', 'Author', ...LIBRARY_HEADS] },
        Author: author,
      };
      for (const head of LIBRARY_HEADS) profile[head] = {};
      staged.access.profiles.Staff = profile;
      plain.access.profiles.Staff = profile;
      const stagedStore = stagedDecimalAdapter(tables, staged.stages);
      const plainStore = fullAdapter(tables);
      staged.store.setDatastore(stagedStore);
      plain.store.setDatastore(plainStore);
      const liveStaged = await invoke(staged.handler, { op: 'query', page: 0, pageSize: PAGE });
      const livePlain = await invoke(plain.handler, { op: 'query', page: 0, pageSize: PAGE });
      assert.equal(liveStaged.status, 200, JSON.stringify(liveStaged.body).slice(0, 500));
      assert.equal(livePlain.status, 200, JSON.stringify(livePlain.body).slice(0, 500));
      const stagedRows = liveStaged.body.rows as Record<string, unknown>[];
      const plainRows = livePlain.body.rows as Record<string, unknown>[];
      const stagedShown = stagedRows.map((row) => shownAuthor(row, true)) as [string, string];
      const plainShown = plainRows.map((row) => shownAuthor(row, false)) as [string, string];
      assert.deepEqual(plainShown, item.shown, `unstaged Rating ${item.op} 5 ${JSON.stringify(plainRows)}`);
      assert.deepEqual(stagedShown, item.shown, `staged Rating ${item.op} 5 ${JSON.stringify(stagedRows)} calls ${JSON.stringify(stagedStore.calls)}`);
      assert.deepEqual(stagedShown, plainShown, `Rating ${item.op} 5`);
      const parentCalls = stagedStore.calls.filter((call) => call.startsWith('Author @'));
      assert.ok(parentCalls.some((call) => /Rating__n/.test(call)), JSON.stringify(parentCalls));
      assert.ok(parentCalls.every((call) => !/\bRating (<|<=|>|>=) /.test(call)), JSON.stringify(parentCalls));
      parity.push(`Rating ${item.op} 5: ${stagedShown.map((name) => name || 'hidden').join(' ')}`);
    }
    assert.deepEqual(parity, ['Rating < 5: hidden Grace Hopper', 'Rating >= 5: Ada Lovelace hidden']);
    assert.match(staged.source, /const parentDecimals = \{"Author":/);
  } finally {
    await staged.close();
    await plain.close();
  }
});
