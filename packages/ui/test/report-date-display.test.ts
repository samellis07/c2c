import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse } from '../../core/src/index.js';
import { clientRuntimeSource } from '../src/generate.js';
import { buildUi, type UiModel } from '../src/index.js';

/**
 * Report date and date-time cells show the app's Creator `date format` and
 * `time format`, not the stored ISO text. A date is a calendar date: it shows
 * the same day in every browser time zone.
 */
function appWith(settings: string, extraReports = ''): UiModel {
  return buildUi(
    deriveIr(
      parse(`application "Library"
{
${settings}
form Member
{
Name
(
type = text
)
Start_Date
(
type = date
)
Checked_Out
(
type = datetime
)
}
list Member_Report
{
show all rows from Member
(
Name
Start_Date
Checked_Out
)
}
${extraReports}
}
`),
    ),
  ).model;
}

const SETTINGS_24 = `date format = "dd-MMM-yyyy"\ntime zone = "Asia/Kolkata"\ntime format = "24-hr"`;
const ROW = { ROWID: '1001', Name: 'Ada', Start_Date: '2026-10-17', Checked_Out: '2026-10-17 14:05:00' };

// The runtime the app ships: the base script and every client/ part.
const SOURCE = clientRuntimeSource();

interface Runtime {
  boot(model: UiModel, doc: Document): Promise<void>;
  renderReportRows(report: UiModel['reports'][number], rows: unknown[]): string;
  displayDateValue(value: unknown, kind: 'date' | 'datetime'): string;
  validateField(field: UiModel['forms'][number]['fields'][number], value: unknown): string | null;
  submitRecord(formEl: HTMLFormElement, form: UiModel['forms'][number]): Promise<Record<string, unknown>>;
}

async function loadRuntime(): Promise<Runtime> {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  // A fresh module per call: the runtime keeps the model boot() was given.
  return (await import(`data:text/javascript;base64,${Buffer.from(`${SOURCE}\n//${Math.random()}`).toString('base64')}`)) as Runtime;
}

async function bootAt(model: UiModel, hash: string, rows: unknown[], record?: Record<string, unknown>) {
  const runtime = await loadRuntime();
  const win = new JSDOM('<!doctype html><body><nav id="nav"></nav><main id="main"></main></body>', { url: `http://localhost/slate/index.html${hash}` }).window as unknown as {
    document: Document;
    fetch: typeof fetch;
    C2C_APP_TIMEZONE?: string;
  };
  win.C2C_APP_TIMEZONE = 'Asia/Kolkata';
  win.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const answer = body.op === 'query' ? { rows } : record ? { dryRun: false, record } : { rows: [] };
    return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) };
  }) as unknown as typeof fetch;
  await runtime.boot(model, win.document);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  return { doc: win.document, runtime };
}

function cellsOf(doc: Document): string[] {
  return [...doc.querySelectorAll('#main tbody tr[data-card] td[data-th]')].map((td) => (td.textContent ?? '').trim());
}

test('the model carries the app time format and marks date and date-time columns', () => {
  const model = appWith(SETTINGS_24);
  assert.equal(model.dateFormat, 'dd-MMM-yyyy');
  assert.equal(model.timeFormat, '24-hr');
  const report = model.reports.find((item) => item.name === 'Member_Report')!;
  assert.deepEqual(
    report.columns.map((column) => [column.field, column.date ?? null]),
    [['Name', null], ['Start_Date', 'date'], ['Checked_Out', 'datetime']],
  );
});

test('a report list shows a stored ISO date as 17-Oct-2026 and a date-time on the 24-hour clock', async () => {
  const { doc } = await bootAt(appWith(SETTINGS_24), '#/report/Member_Report', [ROW]);
  const cells = cellsOf(doc);
  assert.ok(cells.includes('17-Oct-2026'), cells.join(' | '));
  assert.ok(cells.includes('17-Oct-2026 14:05:00'), cells.join(' | '));
  assert.ok(!cells.some((text) => text.includes('2026-10-17')), 'no cell shows the stored ISO text');
});

test('the app date format and 12-hour clock are followed, not a fixed pattern', async () => {
  const model = appWith(`date format = "MM/dd/yyyy"\ntime zone = "Asia/Kolkata"\ntime format = "12-hr"`);
  const { doc } = await bootAt(model, '#/report/Member_Report', [ROW]);
  const cells = cellsOf(doc);
  assert.ok(cells.includes('10/17/2026'), cells.join(' | '));
  assert.ok(cells.includes('10/17/2026 02:05:00 PM'), cells.join(' | '));
});

test('a date-time with an offset is shown in the app time zone; a bare one is already app wall time', async (t) => {
  // In a browser the page window is globalThis, where slate/c2c-config.js sets the zone.
  (globalThis as { C2C_APP_TIMEZONE?: string }).C2C_APP_TIMEZONE = 'Asia/Kolkata';
  t.after(() => delete (globalThis as { C2C_APP_TIMEZONE?: string }).C2C_APP_TIMEZONE);
  const { runtime } = await bootAt(appWith(SETTINGS_24), '#/report/Member_Report', []);
  assert.equal(runtime.displayDateValue('2026-10-17T08:35:00Z', 'datetime'), '17-Oct-2026 14:05:00');
  assert.equal(runtime.displayDateValue('2026-10-17T14:05:00', 'datetime'), '17-Oct-2026 14:05:00');
  assert.equal(runtime.displayDateValue('2026-10-17T00:00:00Z', 'date'), '17-Oct-2026', 'a date takes its calendar day, never a zone shift');
  assert.equal(runtime.displayDateValue('not a date', 'date'), 'not a date');
  assert.equal(runtime.displayDateValue('', 'date'), '');
});

test('a DATE field shows the same calendar day in America/Los_Angeles and Asia/Kolkata', (t) => {
  // The runtime is far larger than one Linux argument (128 KB), so the child
  // reads it from a private temp directory instead of an inline -e script.
  const dir = mkdtempSync(join(tmpdir(), 'c2c-date-zone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = join(dir, 'runtime.mjs');
  writeFileSync(runtime, SOURCE);
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, `
    globalThis.CSS = { escape: (s) => s };
    const rt = await import(${JSON.stringify(pathToFileURL(runtime).href)});
    globalThis.C2C_DATE_FORMAT = 'dd-MMM-yyyy';
    process.stdout.write(JSON.stringify([rt.displayDateValue('2026-10-17', 'date'), rt.displayDateValue('2026-01-01T00:00:00', 'date'), new Date(2026, 0, 1).getTimezoneOffset()]));
  `);
  const seen = ['America/Los_Angeles', 'Asia/Kolkata'].map((zone) => {
    const run = spawnSync(process.execPath, [probe], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout) as [string, string, number];
  });
  assert.notEqual(seen[0]![2], seen[1]![2], 'the two runs really use different browser zones');
  for (const [date, newYear] of seen) {
    assert.equal(date, '17-Oct-2026');
    assert.equal(newYear, '01-Jan-2026');
  }
});

test('a calendar lane head and its entries use the app date format', async () => {
  const extra = `calendar Member_Calendar
{
show all rows from Member
(
Name
Start_Date
)
options
(
display field = Name
start date = Start_Date
)
}`;
  const model = appWith(SETTINGS_24, extra);
  const { doc } = await bootAt(model, '#/report/Member_Calendar', [ROW]);
  const head = doc.querySelector('[data-board] [data-lane] h3')?.textContent ?? '';
  assert.equal(head, '17-Oct-2026 (1)');
  assert.equal(doc.querySelector('[data-board] [data-lane]')?.getAttribute('data-lane'), '2026-10-17', 'the lane key stays the stored date');
  assert.match(doc.querySelector('[data-board] li')?.textContent ?? '', /Ada — 17-Oct-2026/);
});

test('the record summary and the edit form show a stored date in the app format', async () => {
  const model = appWith(SETTINGS_24);
  const summary = await bootAt(model, '#/record/Member/1001', [], ROW);
  const text = summary.doc.querySelector('[data-record-summary]')?.textContent ?? '';
  assert.match(text, /17-Oct-2026/);
  assert.match(text, /17-Oct-2026 14:05:00/);
  assert.doesNotMatch(text, /2026-10-17/);
  const edit = await bootAt(model, '#/form/Member/edit/1001', [], ROW);
  const input = edit.doc.querySelector<HTMLInputElement>('input[name="Start_Date"]');
  assert.equal(input?.value, '17-Oct-2026', 'the date control is filled in the format it accepts');
});

test('a grouped list names each group by its day in the app date format', async () => {
  const extra = `list Members_By_Start
{
show all rows from Member
(
Name
Start_Date
)
group by
(
Start_Date
)
}`;
  const { doc } = await bootAt(appWith(SETTINGS_24, extra), '#/report/Members_By_Start', [ROW, { ...ROW, ROWID: '1002', Name: 'Bo', Start_Date: '2026-10-18' }]);
  const heads = [...doc.querySelectorAll('#main h3[data-group]')].map((el) => [el.getAttribute('data-group'), el.textContent]);
  assert.deepEqual(heads, [['2026-10-17', '17-Oct-2026'], ['2026-10-18', '18-Oct-2026']]);
  assert.deepEqual(cellsOf(doc).filter((text) => /Oct/.test(text)), ['17-Oct-2026', '18-Oct-2026']);
});

test('an edit loaded and saved unchanged stores the same date in every app date format', async () => {
  const cases: Array<[string, string]> = [
    ['MM/dd/yyyy', '10/17/2026'],
    ['dd-MMM-yyyy', '17-Oct-2026'],
    ['dd.MM.yyyy', '17.10.2026'],
    ['yyyy/MM/dd', '2026/10/17'],
    ['MMM d, yyyy', 'Oct 17, 2026'],
    ['dd/MM/yy', '2026-10-17'],
  ];
  for (const [format, shown] of cases) {
    const model = appWith(`date format = "${format}"\ntime zone = "Asia/Kolkata"\ntime format = "24-hr"`);
    const form = model.forms.find((item) => item.name === 'Member')!;
    const field = form.fields.find((item) => item.name === 'Start_Date')!;
    const { doc, runtime } = await bootAt(model, '#/form/Member/edit/1001', [], ROW);
    const input = doc.querySelector<HTMLInputElement>('input[name="Start_Date"]')!;
    assert.equal(input.value, shown, `${format}: prefill (a two-digit year keeps the stored ISO)`);
    assert.equal(runtime.validateField(field, input.value), null, `${format}: the prefilled value is accepted`);
    const saved = await runtime.submitRecord(input.form!, form);
    assert.equal(saved.Start_Date, '2026-10-17', `${format}: saved unchanged`);
  }
});

test('the date control still refuses an invalid or differently shaped date', async () => {
  const model = appWith(`date format = "MM/dd/yyyy"\ntime zone = "Asia/Kolkata"\ntime format = "24-hr"`);
  const form = model.forms.find((item) => item.name === 'Member')!;
  const field = form.fields.find((item) => item.name === 'Start_Date')!;
  const { runtime } = await bootAt(model, '#/form/Member/edit/1001', [], ROW);
  for (const bad of ['02/30/2026', '13/01/2026', '17/10/2026', '10/17/26', 'Oct 17 2026', '10-17-2026', 'tomorrow']) {
    assert.equal(runtime.validateField(field, bad), 'Enter a date as MM/dd/yyyy.', bad);
  }
  assert.equal(runtime.validateField(field, '2026-10-17'), null, 'ISO is still accepted');
  assert.equal(runtime.validateField(field, '17-Oct-2026'), null, 'dd-MMM-yyyy is still accepted');
});
