import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { mockDatastore } from '../../shims/test/zcql-mock.js';
import { buildUi } from '../src/index.js';

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

const SRC = `application "Demo"
{
\tform Add_Discount
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t\tTotal_price
\t\t(
\t\t\ttype = INR
\t\t)
\t}
\tlist Discounts
\t{
\t\tshow all rows from Add_Discount
\t\t(
\t\t\tName
\t\t\tTotal_price
\t\t)
\t\tsort by
\t\t{
\t\t\tTotal_price descending
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
\t\t\t\tAdd_Discount
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tDiscounts = {"View"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

test('a live report sorted or filtered on a currency field pages in numeric order', async () => {
  const files = buildUi(deriveIr(parse(SRC))).files;
  const dir = mkdtempSync(join(tmpdir(), 'c2c-decimal-report-'));
  const store = mockDatastore({ Add_Discount: ['Total_price__n'] });
  const prior = (globalThis as Record<string, unknown>).__c2cDatastore;
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
    for (const file of files) {
      mkdirSync(dirname(join(dir, file.path)), { recursive: true });
      writeFileSync(join(dir, file.path), file.data);
    }
    writeFileSync(join(dir, 'functions/c2c-deploy.json'), JSON.stringify({ mode: 'live', appTimeZone: 'UTC' }));
    // Rows as the runtime writes them: the exact varchar and its Double shadow.
    await store.datastore.insert(
      'Add_Discount',
      ['20.00', '100.00', '15.00', '1000.00', '90.00'].map((price, i) => ({ Name: `d${i}`, Total_price: price, Total_price__n: Number(price) })),
    );
    (globalThis as Record<string, unknown>).__c2cDatastore = store.datastore;
    const path = files.map((f) => f.path).find((p) => p.startsWith('functions/reports/') && p.endsWith('.mjs'));
    assert.ok(path);
    const report = (await import(pathToFileURL(join(dir, path)).href)) as { default: (req: unknown, res: unknown) => unknown };
    const user = { profile: 'Staff', loginUser: 'ada@example.test' };
    const first = await invoke(report.default, { user, body: { op: 'query', page: 0, pageSize: 2 } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual((first.body.rows as Record<string, unknown>[]).map((r) => r.Total_price), ['1000.00', '100.00']);
    const second = await invoke(report.default, { user, body: { op: 'query', page: 1, pageSize: 2 } });
    assert.deepEqual((second.body.rows as Record<string, unknown>[]).map((r) => r.Total_price), ['90.00', '20.00']);
    assert.equal(
      (second.body.rows as Record<string, unknown>[]).some((r) => Object.hasOwn(r, 'Total_price__n')),
      false,
    );
    const filtered = await invoke(report.default, { user, body: { op: 'query', filter: { field: 'Total_price', value: '100' } } });
    assert.deepEqual((filtered.body.rows as Record<string, unknown>[]).map((r) => r.Name), ['d1']);
    assert.equal(store.calls.every((c) => !/ORDER BY Total_price\b(?!__n)/.test(c.orderBy)), true);
  } finally {
    (globalThis as Record<string, unknown>).__c2cDatastore = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

const SRC_GAPPY = `application "Demo"
{
\tform Add_Discount
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t\tTotal_price
\t\t(
\t\t\ttype = INR
\t\t)
\t\tLookup
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tlist Discounts
\t{
\t\tshow all rows from Add_Discount [Lookup.Field]
\t\t(
\t\t\tName
\t\t\tTotal_price
\t\t)
\t\tsort by
\t\t{
\t\t\tTotal_price descending
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
\t\t\t\tAdd_Discount
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tDiscounts = {"View"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

test('a decimal report with an unmigrated criteria fails closed before queryExact', async () => {
  const files = buildUi(deriveIr(parse(SRC_GAPPY))).files;
  const dir = mkdtempSync(join(tmpdir(), 'c2c-decimal-report-closed-'));
  const store = mockDatastore({ Add_Discount: ['Total_price__n'] });
  const prior = (globalThis as Record<string, unknown>).__c2cDatastore;
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
    for (const file of files) {
      mkdirSync(dirname(join(dir, file.path)), { recursive: true });
      writeFileSync(join(dir, file.path), file.data);
    }
    writeFileSync(join(dir, 'functions/c2c-deploy.json'), JSON.stringify({ mode: 'live', appTimeZone: 'UTC' }));
    (globalThis as Record<string, unknown>).__c2cDatastore = store.datastore;
    const path = files.map((f) => f.path).find((p) => p.startsWith('functions/reports/') && p.endsWith('.mjs'));
    assert.ok(path);
    // Non-vacuous: this report carries decimal columns, so the live branch is
    // the exact-read one (queryExact + shadow ORDER BY), not a plain query.
    const source = String(files.find((f) => f.path === path)?.data);
    assert.match(source, /queryExact/);
    assert.match(source, /decimalColumns/);
    const report = (await import(pathToFileURL(join(dir, path)).href)) as { default: (req: unknown, res: unknown) => unknown };
    const user = { profile: 'Staff', loginUser: 'ada@example.test' };
    const live = await invoke(report.default, { user, body: { op: 'query', page: 0, pageSize: 2 } });
    assert.equal(live.status, 200, JSON.stringify(live.body));
    assert.deepEqual(live.body.rows, []);
    assert.equal(live.body.notice, 'filter not migrated');
    assert.equal(store.calls.length, 0, 'datastore queried despite an unmigrated criteria on the exact-read path');
  } finally {
    (globalThis as Record<string, unknown>).__c2cDatastore = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
