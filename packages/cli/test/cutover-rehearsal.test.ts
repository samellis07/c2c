/**
 * The offline cut-over rehearsal (D10) on the library and kitchen-sink
 * fixtures: the expected PASS/GAP per criterion, the same report on a second
 * run, and for every checked criterion a broken step that must turn it FAIL.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../../core/src/toolchain.js';
import type { FetchLike } from '../../data/src/migrate.js';
import { loadApp } from '../../deploy/src/index.js';
import { checkSequence, rehearsalMarkdown, rehearseCutover, syntheticExport, type D10Report, type ExportForm, type RehearsalHooks, type RehearsalOptions, type D10Rates } from '../src/cutover-rehearsal.js';

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

const GAPS = { 'D10.custom-domain': 'GAP' };
const CHECKED = {
  'D10.reverse-sync': 'PASS',
  'D10.parallel-run': 'PASS',
  'D10.final-delta': 'PASS',
  'D10.freeze': 'PASS',
  'D10.verify': 'PASS',
  'D10.sequence': 'PASS',
  'D10.rollback': 'PASS',
  'D10.link-map': 'PASS',
  'D10.downtime': 'PASS',
};

test('library: every checked criterion passes, the gaps are named and the app is not ready', async () => {
  const report = await run(LIBRARY);
  assert.deepEqual(statuses(report), { ...CHECKED, 'D10.rollback-complete': 'PASS', ...GAPS });
  assert.equal(report.status, 'FAIL');
  assert.deepEqual(report.totals, { PASS: 10, FAIL: 0, GAP: 1 });
  for (const item of report.criteria.filter((entry) => entry.status === 'GAP')) {
    assert.ok(item.reason && item.fix, `${item.id} names why and how`);
  }
  // The both-sides edit is observed, not assumed: refused with a hashed report, then applied by an explicit choice.
  const evidence = report.criteria.find((item) => item.id === 'D10.reverse-sync')!.evidence.join('\n');
  assert.match(evidence, /both-sides edit refused: Book ROWID \d+ source id \d+: edited in Creator and in the new app: Title \(Creator sha256:[0-9a-f]{12}, new app sha256:[0-9a-f]{12}\) -> unresolved/);
  assert.match(evidence, /--prefer creator: Book\/\d+ holds the Creator value, resolution recorded/);
  assert.match(evidence, /new-app-only edit Book\/ROWID \d+ unchanged by both syncs/);
  assert.doesNotMatch(evidence, /c2c rehearsal/);
});

test('kitchen-sink: subform rows and files are a rollback gap; the skipped form is listed', async () => {
  const report = await run(KITCHEN_SINK);
  assert.deepEqual(statuses(report), { ...CHECKED, 'D10.rollback-complete': 'GAP', ...GAPS });
  const complete = report.criteria.find((item) => item.id === 'D10.rollback-complete')!;
  assert.match(complete.reason!, /Booking__Lines/);
  assert.match(complete.reason!, /Media_Kit\.Contract/);
  // Booking carries an inline subform and a multi lookup: its rows are exported and loaded, not skipped.
  assert.deepEqual(report.notExercised, []);
  assert.deepEqual(report.harnessLimits, []);
  assert.ok(report.exercised.includes('Booking'));
  assert.match(report.criteria.find((item) => item.id === 'D10.verify')!.evidence.join('\n'), /Booking__Lines: export 45, store 45/);
});

test('link map: every Creator URL the app exposes is mapped or listed as a manual step', async () => {
  const report = await run(LIBRARY);
  const evidence = report.criteria.find((item) => item.id === 'D10.link-map')!.evidence.join('\n');
  assert.match(evidence, /\d+ of \d+ Creator URLs map to a generated route/);
  const book = report.linkMap.find((entry) => entry.creator === '#Form:Book')!;
  assert.deepEqual(book, { kind: 'form', creator: '#Form:Book', route: '#/form/Book', status: 'mapped' });
  // Every exposed URL appears exactly once; a manual entry names its step and carries no route.
  const urls = report.linkMap.map((entry) => entry.creator);
  assert.equal(new Set(urls).size, urls.length);
  for (const entry of report.linkMap) {
    if (entry.status === 'mapped') assert.ok(entry.route?.startsWith('#/'), entry.creator);
    else assert.ok(entry.note && !entry.route, entry.creator);
  }
  for (const rowLink of report.linkMap.filter((entry) => entry.kind === 'record' && entry.status === 'mapped')) {
    assert.match(rowLink.route!, /^#\/report\/.+\/row\/<ROWID>$/);
  }
  const md = rehearsalMarkdown(report);
  assert.match(md, /## Link map/);
  assert.match(md, /\| #Form:Book \| form \| #\/form\/Book \| mapped \|/);
  // A map that loses a route or a whole URL fails the criterion.
  const broken = await run(LIBRARY, {
    linkMap: (entries) => {
      delete entries[0]!.route;
      entries.pop();
    },
  });
  assert.equal(status(broken, 'D10.link-map'), 'FAIL');
  assert.match(broken.criteria.find((item) => item.id === 'D10.link-map')!.reason!, /mapped entry carries no route|missing from the link map/);
});

test('downtime: the window is an estimate with measured phase inputs, not a promise', async () => {
  const report = await run(LIBRARY);
  const item = report.criteria.find((entry) => entry.id === 'D10.downtime')!;
  const evidence = item.evidence.join('\n');
  assert.match(evidence, /final delta sync: \d+ store call\(s\), \d+ row\(s\)/);
  assert.match(evidence, /verify read-back: \d+ store call\(s\), \d+ row\(s\)/);
  assert.match(evidence, /estimated window .+ – .+ — an offline planning estimate/);
  assert.match(evidence, /not a promise/);
  assert.equal(report.downtime.phases.length, 4);
  assert.equal(report.downtime.ratesSource, 'assumed');
  const [low, high] = report.downtime.estimateSeconds;
  assert.ok(low > 0 && high > low, `${low}-${high}`);
  // The exact wording: counts are measured, the rates are assumed planning rates the customer can replace.
  const md = rehearsalMarkdown(report);
  assert.ok(md.includes('## Downtime estimate'));
  assert.ok(
    md.includes(
      `Estimated freeze-to-switch window: ${report.downtime.estimate} — an offline planning estimate. ` +
        'The rates (0.5–2 s per store call, 0.05–0.2 s per row, and 60–180 s per human step) are assumed planning rates, not timings measured from this rehearsal. ' +
        'Replace them with your own measurements: time representative store round-trips and row writes during a rehearsal, record the human-step duration, then rerun the estimate with those project-specific rates ' +
        '(accepted bounds: 0 < low <= high <= 600 s per store call or per row, 0 < low <= high <= 86400 s per human step).',
    ),
  );
  // 'measured' is never attached to the rates or claimed for the estimate's inputs.
  assert.doesNotMatch(md, /estimate from measured|measured (store call|row count|rate|timing|window)/i);
  assert.doesNotMatch(evidence, /estimate from measured|measured (store call|row count|rate|timing|window)/i);
  // Nothing measured, nothing to estimate.
  const broken = await run(LIBRARY, { downtimePhases: (phases) => phases.splice(0) });
  assert.equal(status(broken, 'D10.downtime'), 'FAIL');
  assert.match(broken.criteria.find((entry) => entry.id === 'D10.downtime')!.reason!, /no measured phase/);
});

test('downtime: supplied rates change the window and the report says so', async () => {
  const assumed = await run(LIBRARY);
  const rates = { perStoreCall: [10, 30] as [number, number], perRow: [1, 2] as [number, number], humanSteps: [300, 600] as [number, number] };
  const report = await rehearseCutover(loadApp(LIBRARY), {
    workDir: mkdtempSync(join(tmpdir(), 'c2c-d10-')),
    target: LIBRARY,
    rows: 30,
    downtimeRates: rates,
  });
  assert.equal(report.downtime.ratesSource, 'supplied');
  assert.deepEqual(report.downtime.rates, rates);
  assert.notDeepEqual(report.downtime.estimateSeconds, assumed.downtime.estimateSeconds);
  const md = rehearsalMarkdown(report);
  assert.match(md, /are project-specific rates supplied for this estimate, not timings measured from this rehearsal/);
  assert.doesNotMatch(md, /assumed planning rates/);
  assert.match(md, /10–30 s per store call, 1–2 s per row, and 300–600 s per human step/);
  const evidence = report.criteria.find((entry) => entry.id === 'D10.downtime')!.evidence.join('\n');
  assert.match(evidence, /project-specific rates supplied/);
  // A rates JSON file is accepted too.
  const file = join(mkdtempSync(join(tmpdir(), 'c2c-d10-')), 'rates.json');
  writeFileSync(file, JSON.stringify({ perStoreCall: [1, 1], perRow: [1, 1], humanSteps: [1, 1] }));
  const fromFile = await rehearseCutover(loadApp(LIBRARY), {
    workDir: mkdtempSync(join(tmpdir(), 'c2c-d10-')),
    target: LIBRARY,
    rows: 30,
    downtimeRates: file,
  });
  assert.equal(fromFile.downtime.ratesSource, 'supplied');
  assert.deepEqual(fromFile.downtime.estimateSeconds, [
    fromFile.downtime.phases.reduce((sum, phase) => sum + phase.storeCalls + phase.rows, 0) + 1,
    fromFile.downtime.phases.reduce((sum, phase) => sum + phase.storeCalls + phase.rows, 0) + 1,
  ]);
  // A malformed rates file is refused, not silently assumed.
  writeFileSync(file, JSON.stringify({ perStoreCall: [5, 1], perRow: [1, 2], humanSteps: [1, 2] }));
  await assert.rejects(
    rehearseCutover(loadApp(LIBRARY), { workDir: mkdtempSync(join(tmpdir(), 'c2c-d10-')), target: LIBRARY, rows: 30, downtimeRates: file }),
    /downtime rates: perStoreCall must be a \[low, high\] pair/,
  );
});

test('downtime: supplied rates are bounded and out-of-bounds rates are rejected', async () => {
  const opts = (downtimeRates: RehearsalOptions['downtimeRates']) => ({
    workDir: mkdtempSync(join(tmpdir(), 'c2c-d10-')),
    target: LIBRARY,
    rows: 30,
    downtimeRates,
  });
  const good: D10Rates = { perStoreCall: [1, 2], perRow: [1, 2], humanSteps: [1, 2] };
  const rejected: [keyof D10Rates, [number, number]][] = [
    // Huge finite, zero, negative, inverted, and over-bound ranges are all refused, with the bound named.
    ['perStoreCall', [1e300, 1e301]],
    ['perStoreCall', [0, 1]],
    ['perStoreCall', [-1, 1]],
    ['perStoreCall', [5, 1]],
    ['perStoreCall', [1, 601]],
    ['perRow', [1e300, 1e301]],
    ['perRow', [1, 601]],
    ['humanSteps', [1, 86401]],
    ['humanSteps', [0, 1]],
    ['perStoreCall', [1, Infinity]],
    ['perStoreCall', [Infinity, Infinity]],
  ];
  for (const [key, bad] of rejected) {
    await assert.rejects(
      rehearseCutover(loadApp(LIBRARY), opts({ ...good, [key]: bad })),
      new RegExp(`downtime rates: ${key} must be a \\[low, high\\] pair of seconds with 0 < low <= high <=`),
    );
  }
  // Boundary values are accepted: 600 s per call/row, 86400 s per human step.
  const report = await rehearseCutover(
    loadApp(LIBRARY),
    opts({ perStoreCall: [600, 600] as [number, number], perRow: [600, 600] as [number, number], humanSteps: [86400, 86400] as [number, number] }),
  );
  assert.equal(report.downtime.ratesSource, 'supplied');
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

test('a both-sides edit applied without a choice fails reverse-sync', async () => {
  const report = await run(LIBRARY, { conflictResolver: () => 'creator' });
  assert.equal(status(report, 'D10.reverse-sync'), 'FAIL');
  assert.match(report.criteria.find((item) => item.id === 'D10.reverse-sync')!.reason!, /edited on both sides: sync-delta applied without refusing/);
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

// Team and Member look each other up (a cycle), every lookup is must-have, Member
// has a must-have image and an inline subform, and Note is a leaf child of Member.
const CYCLE_DS = `application "Cycle_Studio_Fixture"
{
	forms
	{
		form Team
		{
			must have unique Team_Code
			(
				type = text
				maxchar = 20
			)
			must have Lead
			(
				type = picklist
				values = Member.ID
				displayformat = [Member_Name]
			)
		}
		form Member
		{
			must have Member_Name
			(
				type = text
			)
			must have Team_Ref
			(
				type = picklist
				values = Team.ID
				displayformat = [Team_Code]
			)
			must have Photo
			(
				type = image
			)
			Skills
			(
				type = grid
				must have Skill_Label
				(
					type = text
				)
				Skill_Team
				(
					type = picklist
					values = Team.ID
					displayformat = [Team_Code]
				)
			)
		}
		form Note
		{
			Note_Text
			(
				type = text
			)
			must have Member_Ref
			(
				type = picklist
				values = Member.ID
				displayformat = [Member_Name]
			)
		}
	}
}
`;

function cycleDs(text = CYCLE_DS): string {
  const path = join(mkdtempSync(join(tmpdir(), 'c2c-d10-ds-')), 'cycle_fixture.ds');
  writeFileSync(path, text);
  return path;
}

function column(form: ExportForm, name: string): string[] {
  const index = form.header.indexOf(name);
  assert.ok(index >= 0, `${form.form} exports ${name}`);
  return form.rows.map((row) => row[index]!);
}

test('synthetic export: must-have lookups, a cycle, subform rows and a must-have image are filled, the same bytes every time', () => {
  const app = loadApp(cycleDs());
  const first = syntheticExport(app, 6);
  assert.equal(JSON.stringify(syntheticExport(app, 6)), JSON.stringify(first));
  const byName = new Map(first.exported.map((form) => [form.form, form]));
  assert.deepEqual([...byName.keys()].sort(), ['Member', 'Member__Skills', 'Note', 'Team']);
  assert.deepEqual(first.skipped, []);
  assert.deepEqual(first.limits, []);
  const ids = (name: string) => new Set(column(byName.get(name)!, 'ID'));
  // Both sides of the cycle name a record id of the other form's exported rows.
  for (const cell of column(byName.get('Team')!, 'Lead')) assert.ok(ids('Member').has(cell), `Team.Lead ${cell}`);
  for (const cell of column(byName.get('Member')!, 'Team_Ref')) assert.ok(ids('Team').has(cell), `Member.Team_Ref ${cell}`);
  for (const cell of column(byName.get('Note')!, 'Member_Ref')) assert.ok(ids('Member').has(cell), `Note.Member_Ref ${cell}`);
  const skills = byName.get('Member__Skills')!;
  assert.deepEqual(skills.subform, { form: 'Member', field: 'Skills' });
  assert.equal(skills.rows.length, 9);
  for (const cell of column(skills, 'Parent_ID')) assert.ok(ids('Member').has(cell));
  for (const cell of column(skills, 'Skill_Team')) assert.ok(ids('Team').has(cell));
  for (const cell of column(skills, 'Skill_Label')) assert.notEqual(cell, '');
  const photos = new Set(column(byName.get('Member')!, 'Photo'));
  assert.equal(photos.size, 1);
  const [photo] = [...photos];
  assert.match(photo!, /^files\/Member\/Photo\.png$/);
  assert.deepEqual(first.files.map((file) => file.path), [photo]);
  assert.equal(Buffer.from(first.files[0]!.bytes).subarray(1, 4).toString('latin1'), 'PNG');
  // Every record id is distinct across forms and subform rows.
  const all = first.exported.flatMap((form) => column(form, 'ID'));
  assert.equal(new Set(all).size, all.length);
});

test('a cyclic must-have app with subform rows and an image rehearses every checked criterion', async () => {
  const ds = cycleDs();
  const work = mkdtempSync(join(tmpdir(), 'c2c-d10-'));
  const report = await run(ds, undefined, work);
  assert.deepEqual(report.notExercised, []);
  assert.deepEqual(report.harnessLimits, []);
  assert.deepEqual([...report.exercised].sort(), ['Member', 'Note', 'Team']);
  for (const id of ['D10.parallel-run', 'D10.final-delta', 'D10.freeze', 'D10.verify', 'D10.rollback']) assert.equal(status(report, id), 'PASS', id);
  assert.ok(existsSync(join(work, 'files/Member/Photo.png')));
  assert.deepEqual(readFileSync(join(work, 'files/Member/Photo.png')), Buffer.from(syntheticExport(loadApp(ds), 30).files[0]!.bytes));
});

test('a must-have field the export cannot fill is a named, counted harness limit', async () => {
  const ds = cycleDs(CYCLE_DS.replace('\t\t\tmust have Photo', '\t\t\tmust have Owner\n\t\t\t(\n\t\t\t\ttype = users\n\t\t\t)\n\t\t\tmust have Photo'));
  const limits = syntheticExport(loadApp(ds), 6).limits;
  assert.deepEqual(limits, [{ form: 'Member', field: 'Owner', cells: 6, reason: "a Users field needs an app user's record id, which a synthetic export does not have" }]);
  const report = await run(ds);
  assert.equal(report.harnessLimits.length, 1);
  assert.match(rehearsalMarkdown(report), /Harness limits: 1\.\nHarness limit: Member\.Owner, 30 empty cell\(s\) \(a Users field needs/);
  // The fillable must-have fields are not listed.
  assert.doesNotMatch(rehearsalMarkdown(report), /Harness limit: (Team\.Lead|Member\.Team_Ref|Member\.Photo|Note\.Member_Ref)/);
});

test('deleting a record with subform rows deletes them too, pinned by the child table count', async () => {
  const ds = cycleDs('application "Order_Fixture"\n{\n\tforms\n\t{\n\t\tform Order\n\t\t{\n\t\t\tOrder_Label\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t\tLines\n\t\t\t(\n\t\t\t\ttype = grid\n\t\t\t\tLine_Label\n\t\t\t\t(\n\t\t\t\t\ttype = text\n\t\t\t\t)\n\t\t\t)\n\t\t}\n\t}\n}\n');
  const work = mkdtempSync(join(tmpdir(), 'c2c-d10-'));
  const report = await run(ds, undefined, work);
  const parallel = report.criteria.find((item) => item.id === 'D10.parallel-run')!;
  assert.equal(parallel.status, 'PASS', parallel.reason ?? 'expected PASS');
  // Order row 1 (of 30) has two subform rows: one record and its two lines are deleted.
  assert.match(parallel.evidence.join('\n'), /parallel-run delta: 1 new, 1 changed, 3 deleted/);
  assert.deepEqual(JSON.parse(readFileSync(join(work, 'export-1/counts.json'), 'utf8')), { Order: 30, Order__Lines: 43 });
});
