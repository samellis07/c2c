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

async function loadReport(source = SRC, reportName?: string): Promise<Built> {
  const files = buildUi(deriveIr(parse(source))).files;
  const dir = mkdtempSync(join(tmpdir(), 'c2c-agg-report-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file.path)), { recursive: true });
    writeFileSync(join(dir, file.path), file.data);
  }
  const path = files
    .filter((f) => f.path.startsWith('functions/reports/') && f.path.endsWith('.mjs'))
    .find((f) => (reportName ? String(f.data).includes(`export const reportName = ${JSON.stringify(reportName)};`) : true))?.path;
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

test('the chart panel shows the error state when the aggregate op fails', async () => {
  const runtime = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    hydrateCharts(root: unknown, model: unknown, view: unknown): void;
  };
  for (const status of [400, 500]) {
    const dom = new JSDOM(
      `<!doctype html><body><section class="card" data-report="Bookings_By_Status" data-view="chart"><div data-state></div><div data-chart></div></section></body>`,
      { url: 'http://localhost/slate/index.html' },
    );
    const calls: { op?: string }[] = [];
    const view = {
      fetch: async (_url: string, init: { body?: string }) => {
        calls.push(JSON.parse(init?.body || '{}') as { op?: string });
        return { ok: false, status, json: async () => ({ error: 'refused' }) };
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
    for (let i = 0; i < 40 && !dom.window.document.querySelector('[data-state="error"]'); i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 1, `status ${status}: one aggregate call, no row fallback: ` + JSON.stringify(calls));
    const state = dom.window.document.querySelector('[data-state="error"]') as Element | null;
    assert.ok(state, `status ${status}: the error state renders`);
    assert.match(state?.textContent ?? '', /Could not load/);
    assert.equal(dom.window.document.querySelector('.chart-empty'), null, 'never "No Data Available" for a failed read');
  }
});

// A pivotchart over Loan grouped and measured on a lookup path: Book.Genre
// and Book.Available_Copies are columns of the parent Book form, reached
// through the Loan.Book lookup. Book.Secret stays hidden from Staff.
const LOOKUP_SRC = `application "Demo"
{
\tform Book
\t{
${field('Title', 'text')}
${field('Genre', 'picklist', '\t\t\tvalues = {"Fiction","Non-Fiction","Sci-Fi","Biography"}')}
${field('Available_Copies', 'number')}
${field('Secret', 'text')}
\t}
\tform Loan
\t{
${field('Member', 'text')}
${field('Book', 'list', '\t\t\tvalues = Book.Title')}
${field('Fine', 'number')}
\t}
\tlist All_Books
\t{
\t\tshow all rows from Book
\t\t(
\t\t\tTitle
\t\t)
\t}
\tpivotchart Loans_By_Genre
\t{
\t\tdisplayname = "Loans by Genre"
\t\tshow all rows from Loan
\t\t(
\t\t\tMember
\t\t\tBook
\t\t\tFine
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
\t\t\t\tBook
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Books = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tTitle
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tGenre
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tAvailable_Copies
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tSecret
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:false,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tLoan
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tLoans_By_Genre = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tMember
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tBook
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tFine
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

test('the aggregate op folds supplied rows on a lookup-path group and measure', async () => {
  const { dir, report } = await loadReport(LOOKUP_SRC, 'Loans_By_Genre');
  try {
    const res = await invoke(report.default, {
      user: STAFF,
      body: {
        op: 'aggregate',
        group: 'Book.Genre',
        measures: [{ fn: 'sum', field: 'Book.Available_Copies' }],
        rows: [
          { ROWID: '1', Member: 'a', Book: { Genre: 'Fiction', Available_Copies: '5' }, Fine: '0' },
          { ROWID: '2', Member: 'b', Book: { Genre: 'Sci-Fi', Available_Copies: '2' }, Fine: '1' },
          { ROWID: '3', Member: 'c', Book: { Genre: 'Fiction', Available_Copies: '7' }, Fine: '0' },
        ],
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.group, 'Book.Genre');
    assert.deepEqual(
      buckets(res.body).map((b) => [b.key, b.values[0]]),
      [
        ['Fiction', 12],
        ['Sci-Fi', 2],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the aggregate op refuses an unreadable or unknown lookup path', async () => {
  const { dir, report } = await loadReport(LOOKUP_SRC, 'Loans_By_Genre');
  try {
    for (const group of [
      'Book.Secret',
      'Missing.Genre',
      'Title.Secret',
      'Fine.',
      'Book.__proto__',
      'Book.constructor',
      'Book.hasOwnProperty',
      'Book.toString',
      'Book.Nope',
      'Book.Member',
      'Book.ROWID',
    ]) {
      const res = await invoke(report.default, { user: STAFF, body: { op: 'aggregate', group, rows: [] } });
      assert.equal(res.status, 400, `group ${group}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.buckets, undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The same app with no FieldPermissions on Book: Staff reads every parent
// field, so a bogus path tail can only be refused by the stored-column
// allowlist — the case a property lookup on the row object would let through.
const LOOKUP_SRC_OPEN = LOOKUP_SRC.replace(
  '\t\t\t\t\tFieldPermissions\n' +
    '\t\t\t\t\t{\n' +
    '\t\t\t\t\t\tTitle\n' +
    '\t\t\t\t\t\t{\n' +
    '\t\t\t\t\t\t\tvisibility:true,readonly:false\n' +
    '\t\t\t\t\t\t}\n' +
    '\t\t\t\t\t\tGenre\n' +
    '\t\t\t\t\t\t{\n' +
    '\t\t\t\t\t\t\tvisibility:true,readonly:false\n' +
    '\t\t\t\t\t\t}\n' +
    '\t\t\t\t\t\tAvailable_Copies\n' +
    '\t\t\t\t\t\t{\n' +
    '\t\t\t\t\t\t\tvisibility:true,readonly:false\n' +
    '\t\t\t\t\t\t}\n' +
    '\t\t\t\t\t\tSecret\n' +
    '\t\t\t\t\t\t{\n' +
    '\t\t\t\t\t\t\tvisibility:false,readonly:false\n' +
    '\t\t\t\t\t\t}\n' +
    '\t\t\t\t\t}\n',
  '',
);

test('a lookup path is refused when the tail is not a stored column of the parent', async () => {
  assert.ok(!LOOKUP_SRC_OPEN.includes('visibility:false'), 'the Book field allowlist was removed for this source');
  const { dir, report } = await loadReport(LOOKUP_SRC_OPEN, 'Loans_By_Genre');
  try {
    const rows = [{ ROWID: '1', Member: 'a', Book: { Genre: 'Fiction', Available_Copies: '5' }, Fine: '0' }];
    // Prototype names and non-columns must fail before any row-object read.
    for (const tail of ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'Nope', 'Member', 'ROWID']) {
      const group = `Book.${tail}`;
      const res = await invoke(report.default, { user: STAFF, body: { op: 'aggregate', group, rows } });
      assert.equal(res.status, 400, `group ${group}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.buckets, undefined);
      // The same tail as a measure field is dropped; the count falls back.
      const measured = await invoke(report.default, {
        user: STAFF,
        body: { op: 'aggregate', group: 'Member', measures: [{ fn: 'sum', field: `Book.${tail}` }], rows },
      });
      assert.equal(measured.status, 200, `measure Book.${tail}: ${JSON.stringify(measured.body)}`);
      assert.deepEqual(measured.body.measures, [{ fn: 'count', field: '' }], `measure Book.${tail}`);
      assert.deepEqual(
        buckets(measured.body).map((b) => [b.key, b.values[0]]),
        [['a', 1]],
      );
    }
    // A stored parent column still resolves for this profile.
    const res = await invoke(report.default, { user: STAFF, body: { op: 'aggregate', group: 'Book.Genre', rows } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      buckets(res.body).map((b) => [b.key, b.values[0]]),
      [['Fiction', 1]],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live aggregate resolves a lookup-path group through the parent read scope', async () => {
  const { dir, report } = await loadReport(LOOKUP_SRC, 'Loans_By_Genre');
  const store = mockDatastore({ Book: [], Loan: [] });
  const prior = (globalThis as Record<string, unknown>).__c2cDatastore;
  try {
    writeFileSync(join(dir, 'functions/c2c-deploy.json'), JSON.stringify({ mode: 'live', appTimeZone: 'UTC' }));
    const books = await store.datastore.insert('Book', [
      { Title: 'a', Genre: 'Fiction', Available_Copies: '4', Secret: 's1' },
      { Title: 'b', Genre: 'Sci-Fi', Available_Copies: '2', Secret: 's2' },
      { Title: 'c', Genre: 'Fiction', Available_Copies: '6', Secret: 's3' },
    ]);
    await store.datastore.insert('Loan', [
      { Member: 'm1', Book: books[0]!.ROWID, Fine: '0' },
      { Member: 'm2', Book: books[1]!.ROWID, Fine: '1' },
      { Member: 'm3', Book: books[2]!.ROWID, Fine: '0' },
    ]);
    (globalThis as Record<string, unknown>).__c2cDatastore = store.datastore;
    const res = await invoke(report.default, {
      user: STAFF,
      body: { op: 'aggregate', group: 'Book.Genre', measures: [{ fn: 'sum', field: 'Book.Available_Copies' }] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.dryRun, false);
    assert.equal(res.body.scanned, 3);
    assert.deepEqual(
      buckets(res.body).map((b) => [b.key, b.values[0]]),
      [
        ['Fiction', 10],
        ['Sci-Fi', 2],
      ],
    );
    // The parent rows are read through the caller's scoped ROWID IN query.
    const parentReads = store.calls.filter((c) => c.form === 'Book');
    // One scoped parent read per path field, plus the Book display column.
    assert.equal(parentReads.length, 3, JSON.stringify(store.calls));
    assert.ok(parentReads.every((c) => /\bIN \(/.test(c.where)));
    // The hidden parent column never leaves the function.
    assert.doesNotMatch(JSON.stringify(res.body), /"s[123]"/);
    const refused = await invoke(report.default, { user: STAFF, body: { op: 'aggregate', group: 'Book.Secret' } });
    assert.equal(refused.status, 400);
  } finally {
    (globalThis as Record<string, unknown>).__c2cDatastore = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the record view of an all-rows report sends no boolean literal in the WHERE', async () => {
  // A report whose criteria is all-rows compiled `(ROWID = '…' AND true)`,
  // which live ZCQL refuses. The WHERE must be the row predicate alone.
  const files = buildUi(deriveIr(parse(LOOKUP_SRC))).files;
  const dir = mkdtempSync(join(tmpdir(), 'c2c-agg-record-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file.path)), { recursive: true });
    writeFileSync(join(dir, file.path), file.data);
  }
  const path = files
    .filter((f) => /functions\/aio\/.*\/record\.mjs$/.test(f.path))
    .find((f) => String(f.data).includes('export const formName = "Loan";'))?.path;
  assert.ok(path);
  const record = (await import(pathToFileURL(join(dir, path)).href)) as { default: (req: unknown, res: unknown) => unknown };
  const store = mockDatastore({ Loan: [] });
  const prior = (globalThis as Record<string, unknown>).__c2cDatastore;
  try {
    writeFileSync(join(dir, 'functions/c2c-deploy.json'), JSON.stringify({ mode: 'live', appTimeZone: 'UTC' }));
    const inserted = await store.datastore.insert('Loan', [{ Member: 'm1', Book: '7', Fine: '0' }]);
    (globalThis as Record<string, unknown>).__c2cDatastore = store.datastore;
    const res = await invoke(record.default, { user: STAFF, body: { ROWID: inserted[0]!.ROWID, REPORT: 'Loans_By_Genre' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.record && (res.body.record as Record<string, unknown>).Member, 'm1');
    assert.equal(store.calls.length, 1);
    assert.equal(store.calls[0]!.where, `(ROWID = '${inserted[0]!.ROWID}')`, store.calls[0]!.where);
    // Must-fail guard: a regression here puts the bare literal back.
    assert.doesNotMatch(store.calls[0]!.where, /\b(true|false)\b/);
  } finally {
    (globalThis as Record<string, unknown>).__c2cDatastore = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
