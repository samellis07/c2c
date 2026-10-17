/**
 * Volume seeds, the offline timing run and the quota estimate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { childIndex, deferredPatch, perfSeed, recordPlan, seedRecord } from '../src/perf-seed.js';
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

/** Two forms that look each other up; `mandatory` makes both lookups `must have`. */
function cycleApp(mandatory: boolean) {
  const lookup = (name: string, target: string) => `\t\t${mandatory ? 'must have ' : ''}${name}\n\t\t(\n\t\t\ttype = picklist\n\t\t\tvalues = ${target}.ID\n\t\t\tdisplayformat = [Label]\n\t\t)`;
  const form = (name: string, ref: string, target: string) => `\tform ${name}\n\t{\n\t\tLabel\n\t\t(\n\t\t\ttype = text\n\t\t)\n${lookup(ref, target)}\n\t}`;
  return deriveIr(parse(`application "Cycle"\n{\n\ttime zone = "Asia/Kolkata"\n${form('Alpha', 'Beta_Ref', 'Beta')}\n${form('Beta', 'Alpha_Ref', 'Alpha')}\n}\n`));
}

test('a two-form lookup cycle with optional lookups posts them empty, then links both sides by row update', async () => {
  const app = cycleApp(false);
  const seed = perfSeed(app, '10k').result;
  const plan = recordPlan(app, seed);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual([...plan.deferred].map(([form, cols]) => [form, [...cols]]), [['Alpha', ['Beta_Ref']], ['Beta', ['Alpha_Ref']]]);
  const children = childIndex(seed, plan);
  const alphaRow = seed.tables.find((t) => t.form === 'Alpha')!.rows[0]!;
  // First pass: no created row is needed, the lookup is left out.
  const first = seedRecord('Alpha', alphaRow, plan, new Map(), children);
  assert.equal(Object.hasOwn(first, 'Beta_Ref'), false);
  assert.equal(first.Label, alphaRow.columns.Label);
  // Second pass: the cell maps to the created ROWID; a missing row is still an error.
  const rowIds = new Map([[alphaRow.columns.Beta_Ref!, '900']]);
  assert.deepEqual(deferredPatch('Alpha', alphaRow, plan, rowIds, children), { Beta_Ref: '900' });
  assert.throws(() => deferredPatch('Alpha', alphaRow, plan, new Map(), children), /has no created row/);

  const run = await runPerf(app, { size: '10k', apiRowsPerTable: 5, pageSamples: 1, searchRepeats: 1 });
  assert.deepEqual(run.warnings, []);
  for (const i of run.imports) assert.equal(i.viaApi + i.viaStore, 10_000, i.form);
  assert.deepEqual(run.deferred.map((d) => [d.form, d.columns, d.rows]), [['Alpha', ['Beta_Ref'], 10_000], ['Beta', ['Alpha_Ref'], 10_000]]);
  const fake = createRequire(import.meta.url)(join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs')) as { state(): { tables: Record<string, Record<string, unknown>[]> } };
  const tables = fake.state().tables;
  for (const [form, column, target] of [['Alpha', 'Beta_Ref', 'Beta'], ['Beta', 'Alpha_Ref', 'Alpha']] as const) {
    const targets = new Set(tables[target]!.map((r) => String(r.ROWID)));
    assert.equal(tables[form]!.length, 10_000, form);
    for (const row of tables[form]!) assert.ok(targets.has(String(row[column])), `${form}.${column}=${String(row[column])}`);
  }
  // The seed itself is unchanged by the plan: same app and seed, same bytes.
  assert.equal(perfSeed(app, '10k').sha256, run.seedSha256);
});

test('a cycle of mandatory lookups is a counted warning naming the cycle, not a silent skip', () => {
  const app = cycleApp(true);
  const seed = perfSeed(app, '10k').result;
  const plan = recordPlan(app, seed);
  assert.equal(plan.warnings.length, 2);
  assert.match(plan.warnings[0]!, /^mandatory lookup Alpha\.Beta_Ref is on a lookup cycle \(Alpha\.Beta_Ref -> Beta\.Alpha_Ref -> Alpha\)/);
  assert.match(plan.warnings[1]!, /^mandatory lookup Beta\.Alpha_Ref is on a lookup cycle \(Beta\.Alpha_Ref -> Alpha\.Beta_Ref -> Beta\)/);
  // Still loadable: both sides post empty and the second pass sets them.
  assert.deepEqual([...plan.deferred.keys()], ['Alpha', 'Beta']);
});

test('a mandatory lookup stays in the insert order when the other side of its cycle can move', () => {
  const app = cycleApp(false);
  app.forms.find((f) => f.name === 'Beta')!.fields.find((f) => f.name === 'Alpha_Ref')!.required = true;
  const seed = perfSeed(app, '10k').result;
  const plan = recordPlan(app, seed);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.forms, ['Alpha', 'Beta']);
  assert.deepEqual([...plan.deferred].map(([form, cols]) => [form, [...cols]]), [['Alpha', ['Beta_Ref']]]);
});
