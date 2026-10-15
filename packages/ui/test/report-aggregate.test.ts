import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
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

const STAFF = { profile: 'Staff', loginUser: 'ada@example.test' };

function field(name: string, type: string, extra = ''): string {
  return `\t\t${name}\n\t\t(\n\t\t\ttype = ${type}${extra ? `\n${extra}` : ''}\n\t\t)`;
}

// A pivotchart report over Booking: Status is the category, Headcount the sum
// measure, Session_Date a date axis candidate. Secret stays hidden from Staff.
const SRC = `application "Demo"
{
\tform Booking
\t{
${field('Title', 'text')}
${field('Status', 'picklist', '\t\t\tvalues = {"Draft","Held","Closed"}')}
${field('Headcount', 'number')}
${field('Session_Date', 'date')}
${field('Secret', 'text')}
\t}
\tpivotchart Bookings_By_Status
\t{
\t\tdisplayname = "Bookings by Status"
\t\tshow all rows from Booking
\t\t(
\t\t\tStatus
\t\t\tHeadcount
\t\t\tSession_Date
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
\t\t\t\tBooking
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tBookings_By_Status = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tTitle
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tStatus
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tHeadcount
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tSession_Date
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tSecret
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:false,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

const ROWS = [
  { ROWID: '1', Title: 'a', Status: 'Held', Headcount: '2', Session_Date: '2026-10-02', Secret: 'x' },
  { ROWID: '2', Title: 'b', Status: 'Closed', Headcount: '5', Session_Date: '2026-10-01', Secret: 'y' },
  { ROWID: '3', Title: 'c', Status: 'Held', Headcount: '3', Session_Date: '2026-10-02', Secret: 'z' },
];

interface Built {
  dir: string;
  report: { default: (req: unknown, res: unknown) => unknown };
}

async function loadReport(source = SRC): Promise<Built> {
  const files = buildUi(deriveIr(parse(source))).files;
  const dir = mkdtempSync(join(tmpdir(), 'c2c-agg-report-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file.path)), { recursive: true });
    writeFileSync(join(dir, file.path), file.data);
  }
  const path = files.map((f) => f.path).find((p) => p.startsWith('functions/reports/') && p.endsWith('.mjs'));
  assert.ok(path);
  const report = (await import(pathToFileURL(join(dir, path)).href)) as Built['report'];
  return { dir, report };
}

function buckets(body: Record<string, unknown>): { key: string; values: number[] }[] {
  return body.buckets as { key: string; values: number[] }[];
}

test('the aggregate op folds supplied rows into grouped sums', async () => {
  const { dir, report } = await loadReport();
  try {
    const res = await invoke(report.default, {
      user: STAFF,
      body: { op: 'aggregate', group: 'Status', measures: [{ fn: 'sum', field: 'Headcount' }], rows: ROWS },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.op, 'aggregate');
    assert.equal(res.body.group, 'Status');
    assert.equal(res.body.scanned, 3);
    assert.deepEqual(
      buckets(res.body).map((b) => [b.key, b.values[0]]),
      [
        ['Closed', 5],
        ['Held', 5],
      ],
      'buckets sort by key and sum the measure',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the aggregate op folds a date axis by calendar day, in date order', async () => {
  const { dir, report } = await loadReport();
  try {
    const res = await invoke(report.default, {
      user: STAFF,
      body: { op: 'aggregate', group: 'Session_Date', measures: [{ fn: 'count', field: '' }], rows: ROWS },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.dated, true);
    assert.deepEqual(
      buckets(res.body).map((b) => [b.key, b.values[0]]),
      [
        ['2026-10-01', 1],
        ['2026-10-02', 2],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the aggregate op order "value" sorts buckets by the first measure', async () => {
  const { dir, report } = await loadReport();
  try {
    const res = await invoke(report.default, {
      user: STAFF,
      body: { op: 'aggregate', group: 'Status', measures: [{ fn: 'count', field: '' }], order: 'value', rows: ROWS },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      buckets(res.body).map((b) => b.key),
      ['Held', 'Closed'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the aggregate op refuses a hidden or unknown group field', async () => {
  const { dir, report } = await loadReport();
  try {
    for (const group of ['Secret', 'No_Such_Field', 'Status; DROP TABLE Booking', 'Status.X']) {
      const res = await invoke(report.default, { user: STAFF, body: { op: 'aggregate', group, rows: ROWS } });
      assert.equal(res.status, 400, `group ${group}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.buckets, undefined);
    }
    // A hidden measure field drops that measure; what remains is the count.
    const hiddenMeasure = await invoke(report.default, {
      user: STAFF,
      body: { op: 'aggregate', group: 'Status', measures: [{ fn: 'sum', field: 'Secret' }], rows: ROWS },
    });
    assert.equal(hiddenMeasure.status, 200);
    assert.deepEqual(hiddenMeasure.body.measures, [{ fn: 'count', field: '' }]);
    assert.deepEqual(
      buckets(hiddenMeasure.body).map((b) => [b.key, b.values[0]]),
      [
        ['Closed', 1],
        ['Held', 2],
      ],
    );
    // And no bucket key carries the hidden field's values.
    assert.doesNotMatch(JSON.stringify(hiddenMeasure.body), /"key":"[xyz]"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the aggregate op fails closed on an unmigrated criteria', async () => {
  const gappy = SRC.replace('show all rows from Booking\n', 'show all rows from Booking [zoho.loginuserid == input.x]\n');
  const { dir, report } = await loadReport(gappy);
  try {
    const res = await invoke(report.default, {
      user: STAFF,
      body: { op: 'aggregate', group: 'Status', rows: ROWS },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.notice, 'filter not migrated');
    assert.deepEqual(res.body.rows, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live aggregate reads bounded ORDER BY ROWID pages and folds them', async () => {
  const { dir, report } = await loadReport();
  const store = mockDatastore({ Booking: [] });
  const prior = (globalThis as Record<string, unknown>).__c2cDatastore;
  try {
    writeFileSync(join(dir, 'functions/c2c-deploy.json'), JSON.stringify({ mode: 'live', appTimeZone: 'UTC' }));
    // 301 rows forces a second page under the 300-row ZCQL page.
    const bulk = Array.from({ length: 301 }, (_, i) => ({
      Title: `t${i}`,
      Status: i % 2 ? 'Held' : 'Closed',
      Headcount: String(i % 5),
      Session_Date: '2026-10-02',
      Secret: 's',
    }));
    await store.datastore.insert('Booking', bulk);
    (globalThis as Record<string, unknown>).__c2cDatastore = store.datastore;
    const res = await invoke(report.default, {
      user: STAFF,
      body: { op: 'aggregate', group: 'Status', measures: [{ fn: 'sum', field: 'Headcount' }] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.dryRun, false);
    assert.equal(res.body.scanned, 301);
    assert.equal(res.body.truncated, false);
    assert.equal(store.calls.length, 2, 'the fold pages at the ZCQL page size');
    assert.ok(store.calls.every((c) => c.orderBy === 'ORDER BY ROWID'), 'stable order: ' + JSON.stringify(store.calls));
    const sum = (parity: number) => bulk.filter((_, n) => n % 2 === parity).reduce((t, r) => t + Number(r.Headcount), 0);
    assert.deepEqual(
      buckets(res.body).map((b) => [b.key, b.values[0]]),
      [
        ['Closed', sum(0)],
        ['Held', sum(1)],
      ],
    );
    // The hidden field never leaves the function.
    assert.doesNotMatch(JSON.stringify(res.body), /"s"/);
    // A hidden group field refuses live too.
    const refused = await invoke(report.default, { user: STAFF, body: { op: 'aggregate', group: 'Secret' } });
    assert.equal(refused.status, 400);
  } finally {
    (globalThis as Record<string, unknown>).__c2cDatastore = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the chart panel loads server-folded buckets before falling back to rows', async () => {
  const runtime = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    hydrateCharts(root: unknown, model: unknown, view: unknown): void;
  };
  const dom = new JSDOM(
    `<!doctype html><body><section class="card" data-report="Bookings_By_Status" data-view="chart"><div data-state></div><div data-chart></div></section></body>`,
    { url: 'http://localhost/slate/index.html' },
  );
  const calls: { op?: string }[] = [];
  const view = {
    fetch: async (_url: string, init: { body?: string }) => {
      const body = JSON.parse(init?.body || '{}') as { op?: string };
      calls.push(body);
      if (body.op === 'aggregate') {
        return { ok: true, status: 200, json: async () => ({ buckets: [{ key: 'Held', values: [7] }], dated: false }) };
      }
      return { ok: true, status: 200, json: async () => ({ rows: [] }) };
    },
  };
  const model = {
    reports: [
      {
        name: 'Bookings_By_Status',
        label: 'Bookings by Status',
        view: 'chart',
        queryEndpoint: '/reports/Bookings_By_Status',
        pageSize: 300,
        columns: [
          { field: 'Status', label: 'Status' },
          { field: 'Headcount', label: 'Headcount', numeric: true },
        ],
      },
    ],
  };
  runtime.hydrateCharts(dom.window.document, model, view);
  for (let i = 0; i < 40 && !dom.window.document.querySelector('[data-chart] rect'); i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 1, 'one aggregate call, no row query: ' + JSON.stringify(calls));
  assert.equal(calls[0]?.op, 'aggregate');
  const rect = dom.window.document.querySelector('[data-chart] rect title') as Element | null;
  assert.equal(rect?.textContent, 'Held: 7');
});
