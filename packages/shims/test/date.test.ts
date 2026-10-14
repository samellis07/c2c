import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDate } from '../src/date.js';

test('isDate validates month and day ranges, including leap years', () => {
  assert.equal(isDate('2026-13-40'), false);
  assert.equal(isDate('32-Jan-2020'), false);
  assert.equal(isDate('2024-02-29'), true);
  assert.equal(isDate('2026-02-29'), false);
  assert.equal(isDate('2023-04-31'), false);
});

test('isDate validates time ranges', () => {
  assert.equal(isDate('2026-01-01 25:99'), false);
  assert.equal(isDate('2026-01-01 23:60'), false);
  assert.equal(isDate('2026-01-01 23:59:60'), false);
  assert.equal(isDate('2026-01-01 23:59:59'), true);
});

test('formatJava reproduces the toText help-page examples', async () => {
  const { DelugeDate, formatJava } = await import('../src/date.js');
  const dec29 = new DelugeDate(2019, 12, 29);
  assert.equal(formatJava(dec29, 'yyyy'), '2019');
  assert.equal(formatJava(dec29, 'YYYY'), '2020');
  const feb4 = new DelugeDate(2020, 2, 4);
  assert.equal(formatJava(feb4, 'DDD'), '035');
  assert.equal(formatJava(feb4, 'MM'), '02');
  assert.equal(formatJava(feb4, 'EEEE'), 'Tuesday');
  assert.equal(formatJava(feb4, 'MM/dd/YY'), '02/04/20');
  assert.equal(formatJava(feb4, "MMM dd, yy 'at' hh:mm:ss, E"), 'Feb 04, 20 at 12:00:00, Tue');
});

test('formatJava follows SimpleDateFormat run lengths, quotes and hour letters', async () => {
  const { DelugeDate, formatJava } = await import('../src/date.js');
  const d = new DelugeDate(2019, 12, 29, 0, 5, 9);
  assert.equal(formatJava(d, 'y|yy|yyy|yyyyy'), '2019|19|2019|02019');
  assert.equal(formatJava(d, 'M|MM|MMM|MMMM|MMMMM'), '12|12|Dec|December|December');
  assert.equal(formatJava(d, 'd|ddd|E|EEE|EEEE'), '29|029|Sun|Sun|Sunday');
  assert.equal(formatJava(d, 'H|HH|k|K|h|a|m|mm|s|ss'), '0|00|24|0|12|AM|5|05|9|09');
  assert.equal(formatJava(new DelugeDate(2019, 12, 29, 13, 0, 0), 'H k K h a'), '13 13 1 1 PM');
  assert.equal(formatJava(d, "G u F W w ''"), "AD 7 5 5 1 '");
  assert.equal(formatJava(d, "'It''s' yyyy"), "It's 2019");
  assert.equal(formatJava(d, 'dd-MM-yyyy, HH.mm'), '29-12-2019, 00.05');
});

test('formatJava returns null for an unquoted letter that is not a date-time literal', async () => {
  const { DelugeDate, formatJava } = await import('../src/date.js');
  const d = new DelugeDate(2020, 1, 2, 3, 4, 5);
  assert.equal(formatJava(d, "yyyy-MM-dd'T'HH:mm:ss"), '2020-01-02T03:04:05');
  assert.equal(formatJava(d, 'yyyy-MM-ddTHH:mm:ss'), null);
  assert.equal(formatJava(d, 'q'), null);
});

test('formatJava refuses letters whose text is not exact here', async () => {
  const { DelugeDate, formatJava } = await import('../src/date.js');
  const { DelugeRuntimeError } = await import('../src/errors.js');
  const d = new DelugeDate(2020, 1, 2, 3, 4, 5);
  for (const pattern of ['S', 'HH:mm:ss.SSS', 'z', 'Z', 'XXX', 'L', "'open"]) {
    assert.throws(() => formatJava(d, pattern), (e: unknown) => e instanceof DelugeRuntimeError, pattern);
  }
});

test('shim.date.toText converts from the app time zone into the given zone', async () => {
  const { createRuntime } = await import('../src/runtime.js');
  const { DelugeDate } = await import('../src/date.js');
  const { DelugeRuntimeError } = await import('../src/errors.js');
  const rt = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata' });
  const ctx = rt.context({});
  const value = new DelugeDate(2019, 1, 1, 10, 15, 30);
  // functions/common/to-text: 10:15:30 in the app zone is 07:45:30 in Moscow.
  // (1 January 2019 was a Tuesday; the page's "Fri" is a typo.)
  assert.equal(rt.shim.date.toText(value, "MMM dd, yy 'at' hh:mm:ss, E", 'Europe/Moscow', ctx), 'Jan 01, 19 at 07:45:30, Tue');
  assert.equal(rt.shim.date.toText(value, 'HH:mm', ctx), '10:15');
  assert.equal(rt.shim.date.toText(value, 'HH:mm', '', ctx), '10:15');
  assert.equal(rt.shim.date.toText(value, 'HH:mm', null, ctx), '10:15');
  assert.equal(rt.shim.date.toText('01-Jan-2019 10:15:30', 'yyyy/MM/dd HH:mm', ctx), '2019/01/01 10:15');
  assert.equal(rt.shim.date.toText(null, 'yyyy', ctx), '');
  const other = createRuntime({ dryRun: true, appTimeZone: 'America/New_York' });
  assert.equal(other.shim.date.toText(value, 'HH:mm', 'Europe/Moscow', other.context({})), '18:15');
  for (const bad of [5, 1596719471334, 'not a date', '123123456', '']) {
    assert.throws(() => rt.shim.date.toText(bad, 'yyyy', ctx), (e: unknown) => e instanceof DelugeRuntimeError);
  }
  assert.throws(() => rt.shim.date.toText(value, null, ctx), (e: unknown) => e instanceof DelugeRuntimeError);
});
