/**
 * Report check runner: the export verifiers pass a faithful file and FAIL a
 * broken one (CSV byte-exact, XLSX and PDF row count); an export control is
 * found and its download captured from the rendered DOM; the seed-side folds
 * for metrics and charts; and the offline run over the kitchen-sink app
 * renders every list and chart from the seed, counts the missing exports and
 * print view as gaps (never passes), and FAILS when an endpoint drops a row.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeflate, deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { templateRuntimeReady, TEMPLATE_MISSING, type MountedScreen } from '../../ui-react/src/index.js';
import { zipStore } from '../src/iac-import.js';
import {
  captureDownload,
  expectedBuckets,
  expectedCsv,
  expectedMetric,
  findAffordances,
  formatReportCheckMarkdown,
  pdfText,
  readChart,
  readTable,
  runReportChecks,
  summarize,
  verifyCsvExport,
  verifyPdfExport,
  verifyReportsMain,
  verifyXlsxExport,
  xlsxRowCount,
} from '../src/verify-reports.js';

const HEADER = ['Title', 'Amount'];
const ROWS = [
  ['Alpha, Ltd', '10.50'],
  ['Say "hi"', '2'],
];

test('CSV export: the exact file passes; a changed cell, a dropped row or a missing header FAILS', () => {
  const good = expectedCsv(HEADER, ROWS);
  assert.equal(good, 'Title,Amount\r\n"Alpha, Ltd",10.50\r\n"Say ""hi""",2\r\n');
  assert.equal(verifyCsvExport(good, HEADER, ROWS).status, 'pass');
  assert.equal(verifyCsvExport(`﻿${good.replace(/\r\n/g, '\n')}`, HEADER, ROWS).status, 'pass', 'BOM and LF are tolerated');
  const changed = verifyCsvExport(good.replace('10.50', '10.5'), HEADER, ROWS);
  assert.equal(changed.status, 'fail');
  assert.equal(changed.expected, '"Alpha, Ltd",10.50');
  assert.equal(changed.actual, '"Alpha, Ltd",10.5');
  assert.equal(verifyCsvExport(expectedCsv(HEADER, ROWS.slice(0, 1)), HEADER, ROWS).status, 'fail');
  assert.equal(verifyCsvExport(expectedCsv(HEADER, ROWS).split('\r\n').slice(1).join('\r\n'), HEADER, ROWS).status, 'fail');
});

function workbook(dataRows: number): Buffer {
  const rows = Array.from({ length: dataRows + 1 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>r${i}</t></is></c></row>`).join('');
  return zipStore([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/workbook.xml', data: '<workbook/>' },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData>${rows}</sheetData></worksheet>` },
  ]);
}

test('XLSX export: the visible row count passes; one row short, or not a workbook, FAILS', () => {
  assert.equal(xlsxRowCount(workbook(3)), 3);
  assert.equal(verifyXlsxExport(workbook(3), 3).status, 'pass');
  const short = verifyXlsxExport(workbook(2), 3);
  assert.equal(short.status, 'fail');
  assert.deepEqual([short.expected, short.actual], [3, 2]);
  assert.equal(verifyXlsxExport(Buffer.from('Title,Amount\r\n'), 3).status, 'fail');
  assert.equal(verifyXlsxExport(zipStore([{ name: 'xl/workbook.xml', data: '<workbook/>' }]), 0).status, 'fail', 'no worksheet part');
});

function pdf(lines: string[]): Buffer {
  const content = deflateSync(Buffer.from(`BT /F1 10 Tf ${lines.map((line, i) => `1 0 0 1 40 ${700 - i * 14} Tm (${line.replace(/[()\\]/g, '\\$&')}) Tj`).join(' ')} ET`, 'latin1'));
  return Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + content.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'), content, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')]);
}

test('PDF export: every visible row key shown passes; a missing row, or not a PDF, FAILS', () => {
  const keys = ['Alpha (main)', 'Beta'];
  assert.equal(verifyPdfExport(pdf(['Title', ...keys]), keys).status, 'pass');
  const missing = verifyPdfExport(pdf(['Title', 'Alpha (main)']), keys);
  assert.equal(missing.status, 'fail');
  assert.deepEqual([missing.expected, missing.actual], [2, 1]);
  assert.equal(verifyPdfExport(Buffer.from('<html>Alpha Beta</html>'), keys).status, 'fail');
});

test('PDF export: content streams that inflate past the cap FAIL with a clear message', () => {
  const keys = ['Alpha'];
  const big = pdf(['Alpha', 'x'.repeat(4096)]);
  assert.match(pdfText(big, 8192), /Alpha/);
  assert.throws(() => pdfText(big, 1024), /PDF content streams inflate past the 1024 byte cap/);
  const twice = Buffer.concat([big, big]);
  assert.throws(() => pdfText(twice, 6000), /past the 6000 byte cap/, 'the cap is shared across streams');
  const check = verifyPdfExport(big, keys);
  assert.equal(check.status, 'pass', 'a normal PDF is well under the default cap');
});

test('PDF export: a stream that inflates to 1 GiB FAILS within bounded memory', async () => {
  const chunk = Buffer.alloc(1024 * 1024);
  const deflate = createDeflate({ level: 9 });
  const packed: Buffer[] = [];
  deflate.on('data', (data: Buffer) => packed.push(data));
  const done = new Promise((resolve) => deflate.on('end', resolve));
  for (let i = 0; i < 1024; i++) if (!deflate.write(chunk)) await new Promise((resolve) => deflate.once('drain', resolve));
  deflate.end();
  await done;
  const content = Buffer.concat(packed);
  const bomb = Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')]);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-pdf-cap-'));
  try {
    const file = join(dir, 'bomb.pdf');
    writeFileSync(file, bomb);
    const child = join(dir, 'pdf-cap-child.mjs');
    writeFileSync(
      child,
      `import { readFileSync } from 'node:fs';
const { verifyPdfExport } = await import(process.argv[2]);
const check = verifyPdfExport(readFileSync(process.argv[3]), ['Alpha']);
console.log(JSON.stringify({ check, maxRss: process.resourceUsage().maxRSS * 1024 }));
`,
    );
    const moduleUrl = new URL('../src/verify-reports.js', import.meta.url).href;
    const run = spawnSync(process.execPath, ['--max-old-space-size=512', child, moduleUrl, file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const { check, maxRss } = JSON.parse(run.stdout.trim().split('\n').pop()!) as { check: { status: string; detail: string }; maxRss: number };
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /PDF is not readable: PDF content streams inflate past the 67108864 byte cap/);
    assert.ok(maxRss < 512 * 1024 * 1024, `peak RSS ${maxRss} bytes`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seed folds: metric count/sum under a filter, chart buckets by category', () => {
  const rows = [
    { Status: 'Open', Amount: '2.50' },
    { Status: 'Open', Amount: '1' },
    { Status: '', Amount: '4' },
  ];
  assert.equal(expectedMetric(rows, { fn: 'count', field: 'Status', filter: [{ field: 'Status', op: 'eq', value: 'Open' }] }), 2);
  assert.equal(expectedMetric(rows, { fn: 'sum', field: 'Amount', filter: [] }), 7.5);
  assert.equal(expectedMetric(rows, { fn: 'count', field: 'Status', filter: [{ field: 'Status', op: 'eq', ref: 'Other' }] }), undefined, 'a field reference is not evaluated: counted as a gap, not guessed');
  assert.deepEqual(expectedBuckets(rows, { x: 'Status', measures: [{ fn: 'sum', field: 'Amount', label: 'Sum' }], filter: [] }), { Open: 3.5, '(blank)': 4 });
});

function dom(html: string): Document {
  return new JSDOM(`<!doctype html><body><div id="root">${html}</div></body>`, { pretendToBeVisual: true }).window.document as unknown as Document;
}

test('readers: table cells by column label, chart values from the accessible data table', () => {
  const doc = dom(
    '<table><tbody><tr><td data-th="Select"></td><td data-th="Amount">2</td><td data-th="Title">A</td></tr></tbody></table>' +
      '<div class="c2c-chart"><svg></svg><table><tbody><tr><th scope="row">Open</th><td>1,234.5</td></tr></tbody></table></div>',
  );
  const root = doc.getElementById('root')!;
  assert.deepEqual(readTable(root, [{ key: 'Title', label: 'Title' }, { key: 'Amount', label: 'Amount' }]), { header: ['Title', 'Amount'], rows: [['A', '2']] });
  assert.deepEqual(readChart(root.querySelector('.c2c-chart')!), { Open: 1234.5 });
});

function screenOf(doc: Document): MountedScreen {
  return {
    container: doc.getElementById('root')!,
    window: doc.defaultView!,
    flush: async () => {
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    unmount: async () => {},
  };
}

/** A report screen whose CSV button downloads `csv` through a Blob object URL, as a browser export would. */
function exportingScreen(csv: string): MountedScreen {
  const doc = dom('<button type="button" data-export="csv">Export CSV</button><button type="button">Print</button>');
  const view = doc.defaultView! as unknown as { Blob: typeof Blob; URL: { createObjectURL(blob: Blob): string } };
  doc.querySelector('[data-export]')!.addEventListener('click', () => {
    const a = doc.createElement('a');
    a.href = view.URL.createObjectURL(new view.Blob([csv], { type: 'text/csv' }));
    a.download = 'report.csv';
    a.click();
  });
  return screenOf(doc);
}

test('an offered export control is found and its download captured; a broken export FAILS the CSV check', async () => {
  const good = exportingScreen(expectedCsv(HEADER, ROWS));
  const found = findAffordances(good.container);
  assert.ok(found.exports.csv, 'CSV control found');
  assert.equal(found.exports.xlsx, undefined);
  assert.ok(found.print, 'print control found');
  const file = await captureDownload(good, found.exports.csv!);
  assert.equal(verifyCsvExport(file!.toString('utf8'), HEADER, ROWS).status, 'pass');
  const broken = exportingScreen(expectedCsv(HEADER, [ROWS[0]!, ['Say "hi"', '3']]));
  const bytes = await captureDownload(broken, findAffordances(broken.container).exports.csv!);
  assert.equal(verifyCsvExport(bytes!.toString('utf8'), HEADER, ROWS).status, 'fail');
  assert.deepEqual(findAffordances(dom('<button>Edit</button><a href="#/x">Open</a>').getElementById('root')!), { exports: {} });
});

const SKIP = templateRuntimeReady() ? false : process.env.CI === 'true' ? false : TEMPLATE_MISSING;
const KITCHEN = join(repoRoot(), 'fixtures/synthetic/kitchen-sink/kitchen_sink.ds');

test('offline kitchen-sink: rows, totals and chart match the seed; exports and print are counted gaps', { skip: SKIP }, async () => {
  const app = deriveIr(parse(readFileSync(KITCHEN, 'utf8')));
  const result = await runReportChecks(app, KITCHEN, { n: 4 });
  assert.equal(result.error, undefined);
  assert.equal(result.seedRows.Gear, 4);
  const screen = (name: string) => result.screens.find((s) => s.screen === name)!;
  const gear = screen('All_Gear');
  assert.equal(gear.kind, 'list');
  assert.deepEqual(gear.checks.filter((c) => c.check === 'rows' || c.check === 'totals' || c.check === 'cells').map((c) => [c.check, c.status]), [['rows', 'pass'], ['totals', 'pass'], ['cells', 'pass']]);
  for (const format of ['csv', 'xlsx', 'pdf', 'print'] as const) {
    const check = gear.checks.find((c) => c.check === format)!;
    assert.equal(check.status, 'gap', `${format} is a gap, never a pass`);
    assert.match(check.detail, /offers no/);
  }
  assert.equal(screen('Bookings_By_Status').checks.find((c) => c.check === 'chart')!.status, 'pass');
  assert.equal(screen('Front_Desk').kind, 'dashboard');
  const report = summarize([result]);
  assert.equal(report.totals.fail, 0, formatReportCheckMarkdown(report));
  assert.ok(report.byCheck.csv!.gap > 0 && report.byCheck.csv!.pass === 0);
});

test('offline kitchen-sink: an endpoint that drops a row or alters a total FAILS the run', { skip: SKIP }, async () => {
  const app = deriveIr(parse(readFileSync(KITCHEN, 'utf8')));
  const result = await runReportChecks(app, KITCHEN, {
    n: 4,
    wrapApi: (api) => ({
      async post(endpoint, body) {
        const reply = await api.post(endpoint, body);
        const rows = (reply.body as { rows?: Record<string, unknown>[] } | undefined)?.rows;
        if (endpoint === '/reports/All_Gear' && rows) return { ...reply, body: { ...(reply.body as object), rows: rows.slice(1) } };
        if (endpoint === '/reports/All_Rooms' && rows) return { ...reply, body: { ...(reply.body as object), rows: rows.map((row, i) => (i === 0 ? { ...row, Capacity: 1 } : row)) } };
        return reply;
      },
    }),
  });
  const statusOf = (screen: string, check: string) => {
    const found = result.screens.find((s) => s.screen === screen)?.checks.find((c) => c.check === check);
    if (!found) assert.fail(`no '${check}' check on screen '${screen}'${result.error ? ` — run failed: ${result.error}` : ''}`);
    return found.status;
  };
  assert.equal(statusOf('All_Gear', 'rows'), 'fail');
  assert.equal(statusOf('All_Rooms', 'totals'), 'fail');
  assert.ok(summarize([result]).totals.fail >= 2);
});

test('offline kitchen-sink: a seed load failure FAILS the run with the error, not a crash', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-report-fake-'));
  try {
    const fakeSdk = join(dir, 'fake.cjs');
    writeFileSync(fakeSdk, `module.exports = {
  initialize() { return { datastore() { return { table() { return { insertRows: async () => { throw new Error('simulated store failure'); } }; } }; } }; },
  setSession() {},
  state() { return { tables: {} }; },
  executeZCQLQuery: async () => [],
};
`);
    const app = deriveIr(parse(readFileSync(KITCHEN, 'utf8')));
    const result = await runReportChecks(app, KITCHEN, { n: 4, fakeSdk });
    assert.equal(result.screens.length, 0);
    assert.match(result.error ?? '', /seed load failed: simulated store failure/);
    assert.equal(summarize([result]).totals.fail, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the runner command: usage errors exit 2', async () => {
  const io = { stdout: () => {}, stderr: () => {} };
  assert.equal(await verifyReportsMain([], io), 2);
  assert.equal(await verifyReportsMain(['--bogus'], io), 2);
  assert.equal(await verifyReportsMain([KITCHEN, '--n', '0'], io), 2);
});
