import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { DelugeDate, addBusinessDays, addDays, weekdaySun1 } from '../src/date.js';
import { DelugeRuntimeError } from '../src/errors.js';
import { createRuntime } from '../src/runtime.js';

/**
 * The day-by-day count. Whole weeks must land on the same date as this walk
 * for every count the walk can finish.
 */
function businessDaysByDay(value: DelugeDate, n: number): DelugeDate {
  if (!(n > 0)) return value;
  let cur = value;
  let left = Math.trunc(n);
  while (left > 0) {
    cur = addDays(cur, 1);
    const dow = weekdaySun1(cur);
    if (dow !== 1 && dow !== 7) left -= 1;
  }
  return cur;
}

test('addBusinessDay matches a day-by-day count for -400..400 from each weekday, both directions', () => {
  const starts = [
    new DelugeDate(2026, 10, 4),
    new DelugeDate(2026, 10, 5),
    new DelugeDate(2026, 10, 6, 15, 30, 45),
    new DelugeDate(2026, 10, 7),
    new DelugeDate(2026, 10, 8),
    new DelugeDate(2026, 10, 9),
    new DelugeDate(2026, 10, 10),
    new DelugeDate(2020, 2, 28, 1, 2, 3),
    new DelugeDate(2019, 12, 31),
  ];
  let compared = 0;
  for (const start of starts) {
    for (let n = -400; n <= 400; n += 1) {
      const got = addBusinessDays(start, n);
      const expected = businessDaysByDay(start, n);
      assert.equal(got.toString(), expected.toString(), `${start.toString()} + ${n}`);
      compared += 1;
    }
  }
  assert.equal(compared, starts.length * 801);
  assert.equal(addBusinessDays(new DelugeDate(2026, 10, 6), 1).toString(), '2026-10-07T00:00:00');
  assert.equal(addBusinessDays(new DelugeDate(2026, 10, 9), 1).toString(), '2026-10-12T00:00:00');
  assert.equal(addBusinessDays(new DelugeDate(2026, 10, 10), 1).toString(), '2026-10-12T00:00:00');
  assert.equal(addBusinessDays(new DelugeDate(2026, 10, 6), 0).toString(), '2026-10-06T00:00:00');
  assert.equal(addBusinessDays(new DelugeDate(2026, 10, 5), -1).toString(), '2026-10-05T00:00:00');
  assert.equal(addBusinessDays(new DelugeDate(2026, 10, 6, 15, 30, 45), 1.9).toString(), '2026-10-07T15:30:45');
});

test('a business-day count that would leave the supported calendar is refused', () => {
  const friday = new DelugeDate(275760, 9, 12, 8, 0, 0);
  const thursday = new DelugeDate(275760, 9, 11, 8, 0, 0);
  const saturday = new DelugeDate(275760, 9, 13, 8, 0, 0);
  assert.equal(addBusinessDays(thursday, 1).toString(), '275760-09-12T08:00:00');
  assert.equal(addBusinessDays(friday, 0).toString(), friday.toString());
  assert.equal(addBusinessDays(friday, -5).toString(), friday.toString());
  assert.throws(
    () => addBusinessDays(friday, 1),
    (err: unknown) => err instanceof DelugeRuntimeError && (err as Error).message === 'date is out of range',
  );
  assert.throws(
    () => addBusinessDays(saturday, 1),
    (err: unknown) => err instanceof DelugeRuntimeError && (err as Error).message === 'date is out of range',
  );
  assert.throws(
    () => addBusinessDays(thursday, 2),
    (err: unknown) => err instanceof DelugeRuntimeError && (err as Error).message === 'date is out of range',
  );
});

test('a blank date stays null, and an exact bigint count is applied', () => {
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const ctx = runtime.context({});
  assert.equal(runtime.shim.date.addBusinessDay(null, 1_000_000_000, ctx), null);
  assert.equal(runtime.shim.date.addBusinessDay('', 5, ctx), null);
  assert.equal(runtime.shim.date.addBusinessDay(null, 9007199254740993n, ctx), null);
  assert.equal(String(runtime.shim.date.addBusinessDay('06-Oct-2026', 1n, ctx)), '2026-10-07T00:00:00');
  assert.equal(String(runtime.shim.date.addBusinessDay('05-Oct-2026', -1n, ctx)), '2026-10-05T00:00:00');
  assert.equal(String(runtime.shim.date.addBusinessDay('09-Oct-2026', 5n, ctx)), '2026-10-16T00:00:00');
});

test('a count of 1000000000 business days refuses within a bound', () => {
  const dateHref = new URL('../src/date.js', import.meta.url).href;
  const runtimeHref = new URL('../src/runtime.js', import.meta.url).href;
  const script = `
    import { addBusinessDays, DelugeDate } from ${JSON.stringify(dateHref)};
    import { createRuntime } from ${JSON.stringify(runtimeHref)};
    const started = Date.now();
    const day = new DelugeDate(2026, 10, 6, 15, 30, 45);
    try {
      addBusinessDays(day, 1000000000);
      process.exit(3);
    } catch (err) {
      if (!err || err.name !== 'DelugeRuntimeError' || err.message !== 'date is out of range') {
        console.error('range', err && err.name, err && err.message);
        process.exit(2);
      }
    }
    const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
    const ctx = runtime.context({});
    try {
      runtime.shim.date.addBusinessDay('06-Oct-2026', 1000000000, ctx);
      process.exit(4);
    } catch (err) {
      if (!err || err.name !== 'DelugeRuntimeError' || err.message !== 'date is out of range') {
        console.error('shim-range', err && err.name, err && err.message);
        process.exit(5);
      }
    }
    try {
      runtime.shim.date.addBusinessDay('06-Oct-2026', 9007199254740993n, ctx);
      process.exit(6);
    } catch (err) {
      if (!err || !String(err.message).includes('refusing to lose precision')) {
        console.error('precision', err && err.name, err && err.message);
        process.exit(7);
      }
    }
    try {
      runtime.shim.date.addBusinessDay('06-Oct-2026', 1000000000n, ctx);
      process.exit(9);
    } catch (err) {
      if (!err || err.message !== 'date is out of range') {
        console.error('exact-huge', err && err.name, err && err.message);
        process.exit(10);
      }
    }
    try {
      addBusinessDays(day, Infinity);
      process.exit(12);
    } catch (err) {
      if (!err || err.message !== 'date is out of range') {
        console.error('infinity', err && err.name, err && err.message);
        process.exit(13);
      }
    }
    const one = runtime.shim.date.addBusinessDay('06-Oct-2026', 1n, ctx);
    if (!one || String(one) !== '2026-10-07T00:00:00') {
      console.error('exact', one && String(one));
      process.exit(8);
    }
    if (Date.now() - started > 1500) process.exit(11);
    console.log('ok');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 30000, // the hang guard is the in-child 1500 ms check; this bound only reaps a truly stuck child (node startup alone can take seconds on a loaded runner)
    killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
  assert.equal(result.signal, null, `signal ${result.signal} stdout ${result.stdout} stderr ${result.stderr}`);
  assert.equal(result.status, 0, `status ${result.status} stdout ${result.stdout} stderr ${result.stderr}`);
  assert.match(String(result.stdout), /ok/);
});
