import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SWEEP_PAGE_ROWS,
  datastoreCheckpoints,
  datastoreFiredMarks,
  dueInstants,
  fireInstant,
  firesIn,
  sweepFormSchedules,
  sweepWhere,
  type CheckpointStore,
  type FiredMark,
  type FiredMarks,
  type FormScheduleSpec,
  type SweepCheckpoint,
} from '../src/jobs.js';
import { mockDatastore } from './zcql-mock.js';

const UTC = 'UTC';
const due: FormScheduleSpec = {
  name: 'c2c_Due_Reminder',
  form: 'Invoice',
  field: 'Due_Date',
  fieldType: 'Date',
  offset: { amount: -1, unit: 'days' },
  at: '09:00:00',
  timeZone: UTC,
};
const at = (iso: string) => Date.parse(iso);

function memoryCheckpoints(): CheckpointStore & { saved: Map<string, SweepCheckpoint>; puts: number } {
  const saved = new Map<string, SweepCheckpoint>();
  const store = {
    saved,
    puts: 0,
    async get(key: string) {
      return saved.get(key);
    },
    async put(key: string, value: SweepCheckpoint) {
      store.puts++;
      saved.set(key, structuredClone(value));
    },
  };
  return store;
}

test('fire instant: before N days from a date field at a wall time, in the schedule zone', () => {
  assert.equal(fireInstant(due, { Due_Date: '2026-10-10' }), at('2026-10-09T09:00:00Z'));
  assert.equal(fireInstant({ ...due, timeZone: 'Asia/Kolkata' }, { Due_Date: '2026-10-10' }), at('2026-10-09T03:30:00Z'));
  assert.equal(fireInstant({ ...due, offset: { amount: -1, unit: 'weeks' } }, { Due_Date: '2026-10-10' }), at('2026-10-03T09:00:00Z'));
  // hours/minutes shift the instant; a date-only field starts at midnight
  const hours: FormScheduleSpec = { ...due, fieldType: 'DateTime', offset: { amount: -2, unit: 'hours' }, at: undefined };
  assert.equal(fireInstant(hours, { Due_Date: '2026-10-10 15:30:00' }), at('2026-10-10T13:30:00Z'));
  assert.equal(fireInstant({ ...hours, fieldType: 'Date' }, { Due_Date: '2026-10-10 15:30:00' }), at('2026-10-09T22:00:00Z'));
  assert.equal(fireInstant(due, { Due_Date: '' }), null);
  assert.equal(fireInstant(due, { Due_Date: 'not a date' }), null);
});

test('firesIn: a one-shot fires only inside (from, until]; a repeat stops after its end field', () => {
  const row = { Due_Date: '2026-10-10' };
  const fire = at('2026-10-09T09:00:00Z');
  assert.equal(firesIn(due, row, fire - 1, fire), true);
  assert.equal(firesIn(due, row, fire, fire + 60_000), false, 'from is exclusive: the previous run already fired it');
  assert.equal(firesIn(due, row, fire - 120_000, fire - 1), false);
  const daily: FormScheduleSpec = { ...due, offset: { amount: 0, unit: 'days' }, repeat: 'daily', end: 'Stop_Date' };
  const r = { Due_Date: '2026-10-01', Stop_Date: '2026-10-05' };
  assert.equal(firesIn(daily, r, at('2026-10-04T08:59:00Z'), at('2026-10-04T09:00:00Z')), true);
  assert.equal(firesIn(daily, r, at('2026-10-04T09:00:00Z'), at('2026-10-05T08:00:00Z')), false);
  assert.equal(firesIn(daily, r, at('2026-10-06T08:59:00Z'), at('2026-10-06T09:00:00Z')), false, 'after end');
  assert.equal(firesIn({ ...daily, end: undefined }, r, at('2027-03-06T08:59:00Z'), at('2027-03-06T09:00:00Z')), true);
});

test('sweepWhere narrows by a slack window on the field, the criteria and the ROWID cursor', () => {
  const where = sweepWhere(
    { ...due, criteria: { op: '!=', field: 'Status', value: 'Paid' } },
    at('2026-10-09T08:55:00Z'),
    at('2026-10-09T09:00:00Z'),
    '1042',
  );
  assert.equal(where, "Due_Date >= '2026-10-08' AND Due_Date <= '2026-10-12' AND (Status != 'Paid') AND ROWID > 1042");
});

test('sweep fires due rows once: the watermark makes the next run skip them', async () => {
  const { datastore } = mockDatastore({ Invoice: ['ROWID'] });
  await datastore.insert('Invoice', [
    { Due_Date: '2026-10-10', Name: 'due' },
    { Due_Date: '2026-10-11', Name: 'later' },
    { Due_Date: '', Name: 'blank' },
  ]);
  const checkpoints = memoryCheckpoints();
  const fired: unknown[] = [];
  const run = (now: number) =>
    sweepFormSchedules({
      schedules: [due],
      query: datastore.query,
      checkpoints,
      now,
      periodMs: 300_000,
      deadline: now + 240_000,
      clock: () => now,
      fire: async (_spec, row) => fired.push(row.Name),
    });
  const first = await run(at('2026-10-09T09:02:00Z'));
  assert.deepEqual(fired, ['due']);
  assert.equal(first.done, true);
  assert.deepEqual(checkpoints.saved.get(due.name), { watermark: at('2026-10-09T09:02:00Z') });
  await run(at('2026-10-09T09:07:00Z'));
  assert.deepEqual(fired, ['due'], 'second run does not refire');
  await run(at('2026-10-10T09:01:00Z'));
  assert.deepEqual(fired, ['due', 'later']);
});

test('sweep pages 300 rows by ROWID and resumes the same window after the deadline', async () => {
  const { datastore, calls } = mockDatastore({ Invoice: ['ROWID'] });
  await datastore.insert('Invoice', Array.from({ length: 2 * SWEEP_PAGE_ROWS + 5 }, (_, i) => ({ Due_Date: '2026-10-10', Name: `r${i}` })));
  const checkpoints = memoryCheckpoints();
  const fired: string[] = [];
  let ticks = 0;
  const now = at('2026-10-09T09:02:00Z');
  const base = {
    schedules: [due],
    query: datastore.query,
    checkpoints,
    periodMs: 300_000,
    fire: async (_spec: FormScheduleSpec, row: Record<string, unknown>) => void fired.push(String(row.Name)),
  };
  // The clock passes the deadline after the first page.
  const stopped = await sweepFormSchedules({ ...base, now, deadline: now + 1, clock: () => now + ticks++ });
  assert.equal(stopped.done, false);
  assert.equal(fired.length, SWEEP_PAGE_ROWS);
  const pending = checkpoints.saved.get(due.name)!;
  assert.equal(pending.watermark, now - 300_000, 'watermark does not move until the window ends');
  assert.equal(pending.pending?.until, now);
  // A later tick resumes the pending window from the cursor, not from now.
  const later = now + 600_000;
  const resumed = await sweepFormSchedules({ ...base, now: later, deadline: later + 240_000, clock: () => later });
  assert.equal(resumed.done, true);
  assert.equal(fired.length, 2 * SWEEP_PAGE_ROWS + 5);
  assert.equal(new Set(fired).size, fired.length, 'no row fired twice');
  assert.deepEqual(checkpoints.saved.get(due.name), { watermark: now });
  assert.ok(calls.every((c) => c.limit === SWEEP_PAGE_ROWS && c.offset === 0 && c.orderBy === 'ORDER BY ROWID'));
  assert.match(calls[calls.length - 1]!.where, /ROWID > \d+$/);
});

test('a run with an injected now is not stopped by a wall clock ahead of the deadline', async () => {
  const { datastore } = mockDatastore({ Invoice: ['ROWID'] });
  await datastore.insert('Invoice', [{ Due_Date: '2020-06-11', Name: 'due' }]);
  const checkpoints = memoryCheckpoints();
  const fired: unknown[] = [];
  // The run's clock is pinned one minute after the row came due, years in the
  // wall clock's past. No `clock` is injected: the deadline must be measured
  // on the run's clock, so a real clock already past the deadline cannot stop
  // the first page.
  const now = at('2020-06-10T09:01:00Z');
  const report = await sweepFormSchedules({
    schedules: [due],
    query: datastore.query,
    checkpoints,
    now,
    periodMs: 300_000,
    deadline: now + 240_000,
    fire: async (_spec, row) => fired.push(row.Name),
  });
  assert.equal(report.done, true);
  assert.deepEqual(fired, ['due']);
  assert.deepEqual(checkpoints.saved.get(due.name), { watermark: now });
});

function memoryFired(): FiredMarks & { saved: Map<string, FiredMark> } {
  const saved = new Map<string, FiredMark>();
  return {
    saved,
    async get(key) {
      return saved.get(key);
    },
    async put(key, mark) {
      saved.set(key, { record: mark.record, instants: [...mark.instants] });
    },
  };
}

test('a crash mid-page marks fired rows, so the resumed window skips them', async () => {
  const { datastore } = mockDatastore({ Invoice: ['ROWID'] });
  await datastore.insert('Invoice', [
    { Due_Date: '2026-10-10', Name: 'first' },
    { Due_Date: '2026-10-10', Name: 'second' },
    { Due_Date: '2026-10-10', Name: 'third' },
  ]);
  const checkpoints = memoryCheckpoints();
  const fired = memoryFired();
  const hits: string[] = [];
  const now = at('2026-10-09T09:02:00Z');
  const base = {
    schedules: [due],
    query: datastore.query,
    checkpoints,
    fired,
    now,
    periodMs: 300_000,
    deadline: now + 240_000,
    clock: () => now,
  };
  // Crash after the first row fired and was marked, before the page ends:
  // no cursor saved, so the resume re-reads the page from the start.
  let crashes = 1;
  await assert.rejects(
    sweepFormSchedules({
      ...base,
      fire: async (_s: FormScheduleSpec, row: Record<string, unknown>) => {
        if (row.Name === 'second' && crashes-- > 0) throw new Error('crash');
        hits.push(String(row.Name));
      },
    }),
    /crash/,
  );
  assert.deepEqual(hits, ['first']);
  const resumed = await sweepFormSchedules({
    ...base,
    fire: async (_s, row) => void hits.push(String(row.Name)),
  });
  assert.equal(resumed.done, true);
  assert.deepEqual(hits, ['first', 'second', 'third'], 'the fired row is not refired');
  assert.deepEqual(fired.saved.get(`${due.name}|1000`), { record: 'fields:["2026-10-10",null]', instants: [at('2026-10-09T09:00:00Z')] });
  assert.equal(fired.saved.size, 3);
});

test('a repeat fires the next occurrence but never a marked one', async () => {
  const daily: FormScheduleSpec = { ...due, offset: { amount: 0, unit: 'days' }, repeat: 'daily' };
  const row = { ROWID: 7, Due_Date: '2026-10-10' };
  const fired = memoryFired();
  assert.deepEqual(dueInstants(daily, row, at('2026-10-10T09:00:00Z'), at('2026-10-11T09:00:00Z')), [at('2026-10-11T09:00:00Z')]);
  await fired.put(`${daily.name}|7`, { record: 'fields:["2026-10-10",null]', instants: [at('2026-10-11T09:00:00Z')] });
  const { datastore } = mockDatastore({ Invoice: ['ROWID'] });
  await datastore.insert('Invoice', [{ Due_Date: '2026-10-10', Name: 'due' }]);
  const checkpoints = memoryCheckpoints();
  const hits: string[] = [];
  const run = (now: number) =>
    sweepFormSchedules({
      schedules: [daily],
      query: datastore.query,
      checkpoints,
      fired,
      now,
      periodMs: 300_000,
      deadline: now + 240_000,
      clock: () => now,
      fire: async (_s, r) => void hits.push(String(r.Name)),
    });
  await run(at('2026-10-10T09:02:00Z'));
  assert.deepEqual(hits, ['due']);
  await run(at('2026-10-10T09:07:00Z'));
  assert.deepEqual(hits, ['due'], 'the same occurrence is marked, not refired');
  await run(at('2026-10-11T09:02:00Z'));
  assert.deepEqual(hits, ['due', 'due'], 'the next daily occurrence fires once');
  await run(at('2026-10-11T09:07:00Z'));
  assert.deepEqual(hits, ['due', 'due'], 'and is marked in turn');
});

test('datastoreFiredMarks inserts once, then updates the same row under a fired| key', async () => {
  const { datastore, tables } = mockDatastore({});
  const marks = datastoreFiredMarks(datastore, 'C2CJobCheckpoint');
  assert.equal(await marks.get('c2c_X|9'), undefined);
  await marks.put('c2c_X|9', { record: 'r', instants: [1, 2] });
  await marks.put('c2c_X|9', { record: 'r', instants: [1, 2, 3] });
  assert.equal(tables.get('C2CJobCheckpoint')!.length, 1);
  assert.equal(tables.get('C2CJobCheckpoint')![0]!.Job_Key, 'fired|c2c_X|9');
  assert.deepEqual(await marks.get('c2c_X|9'), { record: 'r', instants: [1, 2, 3] });
  // A checkpoint and a mark on the same table do not collide.
  const checkpoints = datastoreCheckpoints(datastore, 'C2CJobCheckpoint');
  assert.equal(await checkpoints.get('c2c_X'), undefined);
  await checkpoints.put('c2c_X', { watermark: 5 });
  assert.equal(tables.get('C2CJobCheckpoint')!.length, 2);
  assert.deepEqual(await marks.get('c2c_X|9'), { record: 'r', instants: [1, 2, 3] });
});

test('datastoreCheckpoints inserts once, then updates the same row', async () => {
  const { datastore, tables } = mockDatastore({});
  const store = datastoreCheckpoints(datastore, 'C2CJobCheckpoint');
  assert.equal(await store.get("it's"), undefined);
  await store.put("it's", { watermark: 1 });
  await store.put("it's", { watermark: 2, pending: { until: 3, cursor: '9' } });
  assert.equal(tables.get('C2CJobCheckpoint')!.length, 1);
  assert.deepEqual(await store.get("it's"), { watermark: 2, pending: { until: 3, cursor: '9' } });
});

test('a schedule criteria Amount < 10 over rows 9.5 and 10.5 selects only 9.5', async () => {
  const spec: FormScheduleSpec = {
    ...due,
    criteria: { op: '<', field: 'Amount', value: 10 },
    decimalColumns: { Amount: { shadow: 'Amount__n', scale: 2 } },
  };
  const where = sweepWhere(spec, at('2026-10-09T08:55:00Z'), at('2026-10-09T09:00:00Z'), '');
  assert.match(where, /Amount__n <= 10\.01/);

  const { datastore } = mockDatastore({ Invoice: ['ROWID', 'Amount__n'] });
  await datastore.insert('Invoice', [
    { Due_Date: '2026-10-10', Name: 'under', Amount: '9.5', Amount__n: 9.5 },
    { Due_Date: '2026-10-10', Name: 'over', Amount: '10.5', Amount__n: 10.5 },
  ]);
  const checkpoints = memoryCheckpoints();
  const fired: unknown[] = [];
  const report = await sweepFormSchedules({
    schedules: [spec],
    query: datastore.query,
    checkpoints,
    now: at('2026-10-09T09:02:00Z'),
    periodMs: 300_000,
    deadline: at('2026-10-09T09:06:00Z'),
    clock: () => at('2026-10-09T09:02:00Z'),
    fire: async (_s, row) => fired.push(row.Name),
  });
  assert.equal(report.done, true);
  assert.deepEqual(fired, ['under']);
});

test('a reused ROWID never matches a stale mark: the record fingerprint guards it', async () => {
  const { datastore, tables } = mockDatastore({ Invoice: ['ROWID'] });
  await datastore.insert('Invoice', [
    { Due_Date: '2026-10-10', Name: 'old', CREATEDTIME: '2026-09-01 10:00:00' },
    { Due_Date: '2026-10-10', Name: 'crasher', CREATEDTIME: '2026-09-01 10:00:00' },
  ]);
  const checkpoints = memoryCheckpoints();
  const marks = datastoreFiredMarks(datastore, 'C2CJobCheckpoint');
  const now = at('2026-10-09T09:02:00Z');
  const base = {
    schedules: [due],
    query: datastore.query,
    checkpoints,
    fired: marks,
    now,
    periodMs: 300_000,
    deadline: now + 240_000,
    clock: () => now,
  };
  // 'old' fired and was marked, then the run died on the next row before the
  // page ended.
  let crashed = false;
  await assert.rejects(
    sweepFormSchedules({
      ...base,
      fire: async (_s, row) => {
        if (row.Name === 'crasher') throw new Error('crash');
        crashed = true;
      },
    }),
    /crash/,
  );
  assert.equal(crashed, true);
  const stale = tables.get('C2CJobCheckpoint')!.find((r) => r.Job_Key === `fired|${due.name}|1000`);
  assert.ok(stale, 'the fired mark survives the crash');
  // The record is deleted and Data Store reuses its ROWID for a new record.
  await datastore.delete('Invoice', ['1000']);
  tables.get('Invoice')!.push({ ROWID: '1000', Due_Date: '2026-10-10', Name: 'new', CREATEDTIME: '2026-10-09 08:00:00' });
  const hits: string[] = [];
  const resumed = await sweepFormSchedules({
    ...base,
    fire: async (_s, row) => void hits.push(String(row.Name)),
  });
  assert.equal(resumed.done, true);
  assert.deepEqual(hits, ['new', 'crasher'], 'the new record is not suppressed by the old mark, the crashed one refires');
});

test('a completed sweep prunes its fired marks: old instants, deleted records', async () => {
  const { datastore, tables } = mockDatastore({ Invoice: ['ROWID'] });
  await datastore.insert('Invoice', [{ Due_Date: '2026-10-10', Name: 'due' }]);
  const marks = datastoreFiredMarks(datastore, 'C2CJobCheckpoint');
  const now = at('2026-10-09T09:02:00Z');
  const later = at('2026-10-10T09:02:00Z');
  // A mark whose record is gone and a mark holding an instant past this
  // window's end, on the record that is about to fire.
  await datastore.insert('C2CJobCheckpoint', [
    { Job_Key: `fired|${due.name}|9999`, State: JSON.stringify({ record: 'x', instants: [now - 1] }) },
    { Job_Key: `fired|${due.name}|1000`, State: JSON.stringify({ record: 'fields:["2026-10-10",null]', instants: [now - 1, later] }) },
  ]);
  const hits: string[] = [];
  const report = await sweepFormSchedules({
    schedules: [due],
    query: datastore.query,
    checkpoints: memoryCheckpoints(),
    fired: marks,
    now,
    periodMs: 300_000,
    deadline: now + 240_000,
    clock: () => now,
    fire: async (_s, row) => void hits.push(String(row.Name)),
  });
  assert.equal(report.done, true);
  assert.deepEqual(hits, ['due']);
  const keys = tables.get('C2CJobCheckpoint')!.map((r) => r.Job_Key).sort();
  assert.deepEqual(keys, [`fired|${due.name}|1000`], 'the ghost mark and the just-swept instants are gone');
  assert.deepEqual(await marks.get(`${due.name}|1000`), { record: 'fields:["2026-10-10",null]', instants: [later] });
});

test('dueInstants across spring-forward: a gap wall time fires at the first real instant, then back on schedule', () => {
  const daily: FormScheduleSpec = {
    name: 's',
    form: 'F',
    field: 'D',
    fieldType: 'Date',
    offset: { amount: 0, unit: 'days' },
    at: '02:30:00',
    repeat: 'daily',
    timeZone: 'America/New_York',
  };
  // 2026-03-08 02:00 EST -> 03:00 EDT: the wall time 02:30 never exists.
  assert.deepEqual(dueInstants(daily, { D: '2026-03-07' }, at('2026-03-06T00:00:00Z'), at('2026-03-11T00:00:00Z')), [
    at('2026-03-07T07:30:00Z'),
    at('2026-03-08T07:00:00Z'),
    at('2026-03-09T06:30:00Z'),
    at('2026-03-10T06:30:00Z'),
  ]);
  // Anchored on the gap day itself, the next occurrence is back at 02:30.
  assert.deepEqual(dueInstants(daily, { D: '2026-03-08' }, at('2026-03-07T00:00:00Z'), at('2026-03-10T00:00:00Z')), [
    at('2026-03-08T07:00:00Z'),
    at('2026-03-09T06:30:00Z'),
  ]);
});

test('dueInstants across fall-back: an overlap wall time fires once, at the earlier instant', () => {
  const daily: FormScheduleSpec = {
    name: 's',
    form: 'F',
    field: 'D',
    fieldType: 'Date',
    offset: { amount: 0, unit: 'days' },
    at: '01:30:00',
    repeat: 'daily',
    timeZone: 'America/New_York',
  };
  // 2026-11-01 02:00 EDT -> 01:00 EST: the wall time 01:30 happens twice.
  assert.deepEqual(dueInstants(daily, { D: '2026-10-31' }, at('2026-10-30T00:00:00Z'), at('2026-11-03T00:00:00Z')), [
    at('2026-10-31T05:30:00Z'),
    at('2026-11-01T05:30:00Z'),
    at('2026-11-02T06:30:00Z'),
  ]);
});

test('a one-shot fire instant inside the spring-forward gap resolves to the first real instant', () => {
  const spec: FormScheduleSpec = { ...due, fieldType: 'DateTime', offset: { amount: 0, unit: 'minutes' }, at: undefined, timeZone: 'America/New_York' };
  assert.equal(fireInstant(spec, { Due_Date: '2026-03-08 02:30:00' }), at('2026-03-08T07:00:00Z'));
  assert.equal(fireInstant(spec, { Due_Date: '2026-03-08 01:59:59' }), at('2026-03-08T06:59:59Z'));
});
