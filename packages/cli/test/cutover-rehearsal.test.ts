/**
 * The offline cut-over rehearsal (D10) on the library and kitchen-sink
 * fixtures: the expected PASS/GAP per criterion, the same report on a second
 * run, and for every checked criterion a broken step that must turn it FAIL.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../../core/src/toolchain.js';
import type { FetchLike } from '../../data/src/migrate.js';
import { loadApp } from '../../deploy/src/index.js';
import { checkSequence, rehearsalMarkdown, rehearseCutover, type D10Report, type RehearsalHooks } from '../src/cutover-rehearsal.js';

const LIBRARY = join(repoRoot(), 'fixtures/redistributable/library-application-system/library_application.ds');
const KITCHEN_SINK = join(repoRoot(), 'fixtures/synthetic/kitchen-sink/kitchen_sink.ds');

async function run(ds: string, hooks?: RehearsalHooks, workDir = mkdtempSync(join(tmpdir(), 'c2c-d10-'))): Promise<D10Report> {
  return rehearseCutover(loadApp(ds), { workDir, target: ds, rows: 30, ...(hooks ? { hooks } : {}) });
}

function statuses(report: D10Report): Record<string, string> {
  return Object.fromEntries(report.criteria.map((item) => [item.id, item.status]));
}

function status(report: D10Report, id: string): string | undefined {
  return report.criteria.find((item) => item.id === id)?.status;
}

const GAPS = { 'D10.reverse-sync': 'GAP', 'D10.custom-domain': 'GAP', 'D10.link-map': 'GAP', 'D10.downtime': 'GAP' };
const CHECKED = { 'D10.parallel-run': 'PASS', 'D10.final-delta': 'PASS', 'D10.freeze': 'PASS', 'D10.verify': 'PASS', 'D10.sequence': 'PASS', 'D10.rollback': 'PASS' };

test('library: every checked criterion passes, the gaps are named and the app is not ready', async () => {
  const report = await run(LIBRARY);
  assert.deepEqual(statuses(report), { ...CHECKED, 'D10.rollback-complete': 'PASS', ...GAPS });
  assert.equal(report.status, 'FAIL');
  assert.deepEqual(report.totals, { PASS: 7, FAIL: 0, GAP: 4 });
  for (const item of report.criteria.filter((entry) => entry.status === 'GAP')) {
    assert.ok(item.reason && item.fix, `${item.id} names why and how`);
  }
  // The both-sides edit is observed, not assumed: the Creator value wins silently.
  assert.match(report.criteria.find((item) => item.id === 'D10.reverse-sync')!.evidence.join('\n'), /no conflict reported; store now holds "c2c rehearsal Creator side"/);
});

test('kitchen-sink: subform rows and files are a rollback gap; the skipped form is listed', async () => {
  const report = await run(KITCHEN_SINK);
  assert.deepEqual(statuses(report), { ...CHECKED, 'D10.rollback-complete': 'GAP', ...GAPS });
  const complete = report.criteria.find((item) => item.id === 'D10.rollback-complete')!;
  assert.match(complete.reason!, /Booking__Lines/);
  assert.match(complete.reason!, /Media_Kit\.Contract/);
  assert.deepEqual(
    report.notExercised.map((item) => item.form),
    ['Booking'],
  );
});

test('the report is the same on a second run', async () => {
  const [a, b] = [await run(KITCHEN_SINK), await run(KITCHEN_SINK)];
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(rehearsalMarkdown(a), rehearsalMarkdown(b));
});

test('a Creator write after the freeze fails the freeze check', async () => {
  const report = await run(LIBRARY, {
    afterFreeze: (exported) => {
      const book = exported.find((form) => form.form === 'Book')!;
      book.rows[5]![book.header.indexOf('Author')] = 'late edit';
    },
  });
  assert.equal(status(report, 'D10.freeze'), 'FAIL');
  assert.match(report.criteria.find((item) => item.id === 'D10.freeze')!.reason!, /1 Creator change\(s\) after the freeze: 0 new, 1 changed/);
});

test('a record lost from the store after the final delta fails verify', async () => {
  const report = await run(LIBRARY, { afterFinalDelta: (store) => void store.get('Book_Transaction')!.pop() });
  assert.equal(status(report, 'D10.verify'), 'FAIL');
  assert.match(report.criteria.find((item) => item.id === 'D10.verify')!.reason!, /Book_Transaction: store differs from the export \(1 missing, 0 extra\)/);
});

test('a store that drops updates fails the parallel run and the final delta', async () => {
  // Each PUT reaches the store with only its ROWID: the call succeeds and nothing changes.
  const dropPuts = (inner: FetchLike): FetchLike => async (url, init) => {
    if (init?.method !== 'PUT') return inner(url, init);
    const rows = JSON.parse(init.body ?? '[]') as Record<string, unknown>[];
    return inner(url, { ...init, body: JSON.stringify(rows.map((row) => ({ ROWID: row.ROWID }))) });
  };
  const report = await run(KITCHEN_SINK, { fetch: dropPuts });
  assert.equal(status(report, 'D10.parallel-run'), 'FAIL');
  assert.equal(status(report, 'D10.final-delta'), 'FAIL');
  assert.match(report.criteria.find((item) => item.id === 'D10.final-delta')!.reason!, /expected "c2c rehearsal final"/);
});

test('a checklist without the freeze section, or with switch before final delta, fails the sequence', async () => {
  const dropped = await run(LIBRARY, { checklist: (text) => text.replace('## 2. Freeze Creator edits', '## 2. Notes') });
  assert.equal(status(dropped, 'D10.sequence'), 'FAIL');
  assert.match(dropped.criteria.find((item) => item.id === 'D10.sequence')!.reason!, /no freeze section/);

  const text = '## 1. Rollback baseline\nc2c rollback-export\n## 6. Redirect\nCreator app home page\n## 2. Freeze Creator edits\nfreeze time\n## 3. Final delta\nnew 0 changed 0\n## 4. Smoke\nc2c smoke\n## 8. Rollback ready\nbaseline folder\n';
  assert.deepEqual(checkSequence(text), ['switch section is out of order']);
  assert.deepEqual(checkSequence(text.replace('new 0 changed 0', 'plan again')), ['final delta section does not name its action (new 0 changed 0)', 'switch section is out of order']);
});

test('a rollback export missing a record, or edited after its manifest, fails rollback', async () => {
  const short = await run(LIBRARY, {
    rollbackFiles: (files) => {
      const body = files.get('import/Staff_Members.csv')!.trimEnd().split('\n');
      files.set('import/Staff_Members.csv', `${body.slice(0, -1).join('\n')}\n`);
    },
  });
  assert.equal(status(short, 'D10.rollback'), 'FAIL');
  const reason = short.criteria.find((item) => item.id === 'D10.rollback')!.reason!;
  assert.match(reason, /rollback manifest does not verify: checksum mismatch on import\/Staff_Members\.csv/);
  assert.match(reason, /Staff_Members: rollback import holds 30 of 31 stored record\(s\)/);
});

test('a rollback export kept inside the app folder fails rollback', async () => {
  const inside = mkdtempSync(join(tmpdir(), 'c2c-d10-ws-'));
  const report = await rehearseCutover(loadApp(LIBRARY), { workDir: join(inside, 'work'), target: inside, rows: 30 });
  assert.equal(status(report, 'D10.rollback'), 'FAIL');
  assert.match(report.criteria.find((item) => item.id === 'D10.rollback')!.reason!, /export is inside the workspace/);
});
