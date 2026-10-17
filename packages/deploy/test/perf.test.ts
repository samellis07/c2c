/**
 * Volume seeds, the offline timing run and the quota estimate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { childIndex, perfSeed, recordPlan, seedRecord } from '../src/perf-seed.js';
import { estimateQuota, PRICED_ITEMS } from '../src/perf-estimate.js';
import { moverApiCalls } from '../src/offline-plan.js';
import { OFFLINE_NOTE, runPerf } from '../src/perf-harness.js';

const root = repoRoot();
const library = deriveIr(parse(readFileSync(join(root, 'fixtures/redistributable/library-application-system/library_application.ds'), 'utf8')));
const kitchen = deriveIr(parse(readFileSync(join(root, 'fixtures/synthetic/kitchen-sink/kitchen_sink.ds'), 'utf8')));

test('the same app, size and seed give a byte-identical seed; another seed does not', () => {
  const a = perfSeed(library, '10k', 'alpha');
  const b = perfSeed(library, '10k', 'alpha');
  assert.equal(a.json, b.json);
  assert.equal(a.sha256, b.sha256);
  const c = perfSeed(library, '10k', 'beta');
  assert.notEqual(c.sha256, a.sha256);
  for (const table of a.result.tables) assert.equal(table.rows.length, 10_000, table.form);
});

test('a 10k seed keeps unique columns distinct, lookups resolvable and addresses on example.com', () => {
  const { result } = perfSeed(library, '10k');
  const ids = new Set(result.tables.flatMap((t) => t.rows.map((r) => r.id)));
  const byForm = new Map(result.tables.map((t) => [t.form, t.rows]));
  for (const [form, column] of [['Book', 'Isbn_Number'], ['Member_Info', 'Email'], ['Member_Info', 'Phone_Number'], ['Staff_Members', 'Phone_Number']] as const) {
    const values = byForm.get(form)!.map((r) => r.columns[column]);
    assert.equal(new Set(values).size, values.length, `${form}.${column} repeats`);
  }
  for (const row of byForm.get('Book_Transaction')!) {
    assert.ok(ids.has(row.columns.Member!), row.columns.Member);
    assert.ok(ids.has(row.columns.Book!), row.columns.Book);
  }
  const emails = result.tables.flatMap((t) => t.rows.flatMap((r) => Object.values(r.columns).filter((v) => v.includes('@'))));
  assert.ok(emails.length > 0);
  for (const email of emails) assert.match(email, /@example\.com$/);
});

test('seedRecord groups composite parts, maps lookups to ROWIDs and folds child tables', () => {
  const seed = perfSeed(kitchen, '10k').result;
  const plan = recordPlan(kitchen, seed);
  assert.deepEqual(plan.forms.slice(0, 3), ['Gear', 'Guest', 'Room']);
  const children = childIndex(seed, plan);
  const rowIds = new Map<string, string>();
  for (const table of seed.tables) table.rows.forEach((row, i) => rowIds.set(row.id, String(20_000_000 + i)));
  const guest = seedRecord('Guest', seed.tables.find((t) => t.form === 'Guest')!.rows[0]!, plan, rowIds, children);
  assert.equal(typeof guest.Organiser, 'object');
  assert.ok(Object.hasOwn(guest.Organiser as object, 'first_name'));
  assert.equal(Object.hasOwn(guest, 'Organiser_first_name'), false);
  assert.ok(Array.isArray(guest.Tags));
  const bookingRow = seed.tables.find((t) => t.form === 'Booking')!.rows[0]!;
  const booking = seedRecord('Booking', bookingRow, plan, rowIds, children);
  assert.equal(booking.Room_Ref, rowIds.get(bookingRow.columns.Room_Ref!));
  assert.ok(Array.isArray(booking.Lines) && (booking.Lines as unknown[]).length >= 1);
  assert.ok(Array.isArray(booking.Gear_Refs) && (booking.Gear_Refs as unknown[]).every((id) => typeof id === 'string' && /^\d+$/.test(id)));
  const kit = seedRecord('Media_Kit', seed.tables.find((t) => t.form === 'Media_Kit')!.rows[0]!, plan, rowIds, children);
  for (const dropped of ['Contract', 'Cover', 'Host', 'Sign_Off']) assert.equal(Object.hasOwn(kit, dropped), false, dropped);
  // A lookup to a parent that was never created is an error, not a dangling id.
  assert.throws(() => seedRecord('Booking', bookingRow, plan, new Map(), children), /has no created row/);
});

test('the estimate uses the mover call model and the repo limits, and prices nothing', () => {
  const tables = [{ name: 'A', rows: 10_000 }, { name: 'B', rows: 1_000 }, { name: 'Empty', rows: 0 }];
  const profile = { users: 10, days: 30, pageLoads: 4, searches: 2, submits: 1 };
  const est = estimateQuota(tables, profile, { pageLoad: 3, search: 2, submit: 1 });
  const item = (lines: typeof est.import, name: string) => lines.find((l) => l.item.startsWith(name))!;
  // 10k rows: 50 insert batches and 34 id slices; 3 calls each plus the 2-call table allowance.
  assert.equal(moverApiCalls(10_000), 3 * 50 + 3 * 34 + 2);
  assert.equal(moverApiCalls(0), 0);
  const mover = item(est.import, 'Mover API calls');
  assert.equal(mover.quantity, moverApiCalls(10_000) + moverApiCalls(1_000));
  assert.equal(mover.limit?.id, 'api.calls_dev');
  assert.equal(mover.limit?.value, 200_000);
  assert.equal(mover.share, Math.round((mover.quantity! / 200_000) * 1000) / 1000);
  assert.equal(item(est.import, 'Insert calls').quantity, 50 + 5);
  assert.equal(item(est.import, 'Minutes at the stated write rate, largest').quantity, 1);
  assert.equal(item(est.import, 'Bulk-write jobs').quantity, 2);
  assert.equal(item(est.import, 'Rows per Development table').limit?.value, null);
  assert.equal(item(est.month, 'Function invocations').quantity, 10 * 30 * 7);
  assert.equal(item(est.month, 'Data Store calls').quantity, 10 * 30 * (4 * 3 + 2 * 2 + 1));
  for (const line of [...est.import, ...est.month]) {
    if (!line.limit) continue;
    assert.equal(line.limit.label, '[UNVERIFIED]', line.item);
    assert.match(line.limit.source, /^packages\/schema\/src\/limits\.ts /);
  }
  assert.deepEqual(est.prices.map((p) => p.item), PRICED_ITEMS);
  for (const price of est.prices) {
    assert.equal(price.price, null);
    assert.equal(price.label, '[UNVERIFIED]');
  }
  assert.equal(est.costTotal, null);
});

test('the offline run imports through the generated routes and times paged reports', async () => {
  const run = await runPerf(library, { size: '10k', apiRowsPerTable: 5, pageSamples: 2, searchRepeats: 1 });
  assert.equal(run.note, OFFLINE_NOTE);
  assert.match(run.note, /NOT Catalyst numbers/);
  const book = run.imports.find((i) => i.form === 'Book')!;
  assert.equal(book.route, '/forms/Book/submit');
  assert.equal(book.viaApi, 5);
  assert.equal(book.viaApi + book.viaStore, 10_000);
  for (const i of run.imports) assert.equal(i.viaApi + i.viaStore, i.rows, i.form);
  const report = run.reports.find((r) => r.report === 'Book_Report')!;
  assert.equal(report.rows, 10_000);
  assert.equal(report.pagedLoad.n, 2);
  assert.deepEqual(report.pagedLoad.statuses, { 200: 2 });
  assert.ok(report.pagedLoad.maxStoreCalls >= 1);
  assert.ok(run.timeoutRisk.some((t) => t.report === 'Book_Report' && /\[UNVERIFIED latency\]/.test(t.status)));
});
