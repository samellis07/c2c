import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime } from '../../shims/src/runtime.js';
import { DelugeDate } from '../../shims/src/date.js';
import { translate, type TranslateOptions } from '../src/translate.js';

type Run = (shim: ReturnType<typeof createRuntime>['shim'], ctx: ReturnType<ReturnType<typeof createRuntime>['context']>) => Promise<unknown>;

function noTodo(src: string, options?: TranslateOptions) {
  const t = translate(src, options);
  assert.deepEqual(t.todos.map((x) => x.construct), [], `${src} left a TODO`);
  assert.doesNotMatch(t.server + t.client, /shim\.todo\(/);
  return t;
}

/** Translate `src` (which assigns `out`), run the server body, return `out`. */
async function run(src: string, zone = 'UTC'): Promise<unknown> {
  const t = noTodo(src);
  const runtime = createRuntime({ dryRun: true, appTimeZone: zone, now: new Date('2020-06-15T12:00:00Z') });
  const ctx = runtime.context({});
  const body = new Function('shim', 'ctx', `return (async () => {\n${t.server}\nreturn out;\n})();`) as Run;
  return body(runtime.shim, ctx);
}

test('toDateTimeString translates both forms and formats epoch milliseconds', async () => {
  // functions/datetime/todatetimestring — epoch milliseconds, pattern, time zone.
  const free = noTodo('out = toDateTimeString(1693905560373, "MMM dd, yy", "IST");');
  assert.match(free.server, /shim\.date\.toDateTimeString\(1693905560373, "MMM dd, yy", "IST", ctx\)/);
  const method = noTodo('out = (1693905560373).toDateTimeString("MMM dd, yy", "IST");');
  assert.match(method.server, /shim\.date\.toDateTimeString\(1693905560373, "MMM dd, yy", "IST", ctx\)/);
  assert.match(noTodo('out = todatetimestring(1693905560373, "MMM dd, yy", "IST");').server, /shim\.date\.toDateTimeString\(1693905560373,/);

  // The published example is 05-Sep-2023 14:49:20 in IST (hh in the help page is the 12-hour clock).
  assert.equal(await run('out = toDateTimeString(1693905560373, "MMM dd, yy", "IST");'), 'Sep 05, 23');
  assert.equal(await run('out = toDateTimeString(1693905560373, "HH:mm:ss", "IST");'), '14:49:20');
  assert.equal(await run('out = toDateTimeString(1693905560373, "HH:mm:ss", "UTC");'), '09:19:20');
  // Epoch 0 is 01-Jan-1970 00:00:00 UTC.
  assert.equal(await run('out = toDateTimeString(0, "dd-MMM-yyyy HH:mm:ss", "UTC");'), '01-Jan-1970 00:00:00');
  assert.equal(await run('out = toDateTimeString(null, "yyyy", "UTC");'), null);
  
  // Omitted trailing args
  assert.equal(await run('out = toDateTimeString(0);'), '01-Jan-1970 00:00:00');
  assert.equal(await run('out = (0).toDateTimeString();'), '01-Jan-1970 00:00:00');
  assert.equal(await run('out = toDateTimeString(0, "yyyy");'), '1970');
  assert.equal(await run('out = (0).toDateTimeString("yyyy");'), '1970');


  const runtime = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata' });
  const ctx = runtime.context({});
  const date = runtime.shim.date as typeof runtime.shim.date & {
    toDateTimeString(value: unknown, pattern: unknown, timeZone: unknown, ctx: unknown): string | null;
  };
  // A missing time zone uses the application time zone (00:00 UTC is 05:30 in Asia/Kolkata).
  assert.equal(date.toDateTimeString(0, 'HH:mm:ss', null, ctx), '05:30:00');
  assert.equal(date.toDateTimeString(1693905560373n, 'MMM dd, yy', 'IST', ctx), 'Sep 05, 23');
  await assert.rejects(
    () => run('out = toDateTimeString(9007199254740993, "yyyy", "UTC");'),
    /magnitude exceeds 2\^53; refusing to lose precision/,
  );
  assert.throws(
    () => date.toDateTimeString(9007199254740993n, 'yyyy', 'UTC', ctx),
    /magnitude exceeds 2\^53; refusing to lose precision/,
  );
});

test('totalMonths counts whole calendar months, time ignored, signed when reversed', async () => {
  // functions/datetime/totalmonth
  assert.match(
    noTodo('out = "2020-01-01".totalMonths("x");').server,
    /shim\.date\.totalMonths\("2020-01-01", "x", ctx\)/,
  );
  assert.match(noTodo('out = totalMonths(a, b);').server, /shim\.date\.totalMonths\(a, b, ctx\)/);
  assert.match(noTodo("out = '31-Dec-1989'.totalmonths('01-Feb-1990');").server, /shim\.date\.totalMonths\(/);

  // 31-Dec-1989 to 01-Feb-1990 is 1; the month-end 31-Dec-1989 to 01-Jan-1990 is 0.
  assert.equal(await run("out = totalMonths('31-Dec-1989', '01-Feb-1990');"), 1);
  assert.equal(await run("out = '31-Dec-1989'.totalMonths('01-Jan-1990');"), 0);
  // February 2020 is 29 days, so 01-Feb to 01-Mar is one whole month (monthsBetween is 0).
  assert.equal(await run("out = totalMonths('01-Feb-2020', '01-Mar-2020');"), 1);
  assert.equal(await run("out = totalMonths('01-Mar-2020', '01-Feb-2020');"), -1);
  // The time of day is not part of the count.
  assert.equal(await run("out = totalMonths('31-Dec-1989 23:59:59', '01-Feb-1990 00:00:01');"), 1);
  assert.equal(await run('a = null; out = totalMonths(a, \'01-Jan-2020\');'), null);
  assert.equal(await run('out = totalMonths(\'01-Jan-2020\', null);'), null);
});

test('totalYears counts whole calendar years, including leap years, signed when reversed', async () => {
  // functions/datetime/totalyear — 02-Jan-2020 to 01-Jan-2021 is 0 because 2020 has 366 days.
  assert.match(
    noTodo('out = "2020-01-01".totalYears("x");').server,
    /shim\.date\.totalYears\("2020-01-01", "x", ctx\)/,
  );
  assert.match(noTodo('out = totalYears(a, b);').server, /shim\.date\.totalYears\(a, b, ctx\)/);

  assert.equal(await run("out = totalYears('1-Jan-2019', '31-Dec-2019');"), 0);
  assert.equal(await run("out = totalYears('1-Jan-2019', '1-Jan-2020');"), 1);
  assert.equal(await run("out = '02-Jan-2020'.totalYears('01-Jan-2021');"), 0);
  // Leap day has not reached its anniversary on 28-Feb of the next year.
  assert.equal(await run("out = totalYears('29-Feb-2020', '28-Feb-2021');"), 0);
  assert.equal(await run("out = totalYears('29-Feb-2020', '01-Mar-2021');"), 1);
  assert.equal(await run("out = totalYears('1-Jan-2020', '1-Jan-2019');"), -1);
  assert.equal(await run("out = totalYears('1-Jan-2019 23:00:00', '1-Jan-2020 01:00:00');"), 1);
  assert.equal(await run('a = null; out = a.totalYears(\'01-Jan-2020\');'), null);
});

test('unixEpoch returns milliseconds in the application time zone', async () => {
  // functions/datetime/unix-epoch — text in, milliseconds out. No zone argument uses the app zone.
  assert.match(noTodo('out = "2020-01-01".unixEpoch();').server, /shim\.date\.unixEpoch\("2020-01-01", ctx\)/);
  assert.match(noTodo('out = "2020-01-01".unixepoch();').server, /shim\.date\.unixEpoch\("2020-01-01", ctx\)/);
  assert.match(
    noTodo('out = "03-Feb-2020 03:48:12".unixEpoch("GMT");').server,
    /shim\.date\.unixEpoch\("03-Feb-2020 03:48:12", "GMT", ctx\)/,
  );

  // "03-Feb-2020 03:48:12" is 1580681892000 in Asia/Calcutta and 1580701692000 in GMT.
  assert.equal(await run('out = "03-Feb-2020 03:48:12".unixEpoch();', 'Asia/Kolkata'), 1580681892000);
  assert.equal(await run('out = "03-Feb-2020 03:48:12".unixEpoch();', 'UTC'), 1580701692000);
  // 01-Jan-1970 midnight in the app zone is the epoch when that zone is UTC.
  assert.equal(await run('out = "01-Jan-1970".unixEpoch();', 'UTC'), 0);
  assert.equal(await run('out = "31-Dec-1969 16:00:00".unixEpoch();', 'America/Los_Angeles'), 0);
  assert.equal(await run('a = null; out = a.unixEpoch();'), null);
  
  // timezone arguments
  assert.equal(await run('out = "03-Feb-2020 03:48:12".unixEpoch("Asia/Kolkata");', 'America/Los_Angeles'), 1580681892000);
  assert.equal(await run('out = unixEpoch("03-Feb-2020 03:48:12", "Asia/Kolkata");', 'America/Los_Angeles'), 1580681892000);
  
  // invalid timezone falls back to GMT (UTC)
  assert.equal(await run('out = "03-Feb-2020 03:48:12".unixEpoch("Invalid/Zone");'), 1580701692000);

  // functions/datetime/unix-epoch.html — one row per published example.
  // "03-Feb-2020 03:48:12". The default row uses the application zone GMT-8.
  // UTC+8 is not a zone, so it is GMT. Hello is not a zone, so it is GMT.
  assert.equal(await run('out = "03-Feb-2020 03:48:12".unixEpoch("Asia/Kolkata");', 'America/Los_Angeles'), 1580681892000);
  assert.equal(await run('out = "03-Feb-2020 03:48:12".unixEpoch("Asia/Calcutta");', 'America/Los_Angeles'), 1580681892000);
  assert.equal(await run('out = "03-Feb-2020 03:48:12".unixEpoch("GMT-8");', 'America/Los_Angeles'), 1580730492000);
  assert.equal(await run('out = "03-Feb-2020 03:48:12".unixEpoch();', 'America/Los_Angeles'), 1580730492000);
  assert.equal(await run('out = "03-Feb-2020 03:48:12".unixEpoch("UTC+8");', 'America/Los_Angeles'), 1580701692000);
  assert.equal(await run('out = "03-Feb-2020 03:48:12".unixEpoch("GMT");', 'America/Los_Angeles'), 1580701692000);
  assert.equal(await run('out = "03-Feb-2020 03:48:12".unixEpoch("GMT+5:30");', 'America/Los_Angeles'), 1580681892000);
  assert.equal(await run('out = "03-Feb-2020 03:48:12".unixEpoch("EST");', 'America/Los_Angeles'), 1580719692000);
  assert.equal(await run('out = "03-Feb-2020 03:48:12".unixEpoch("SST");', 'America/Los_Angeles'), 1580662092000);
  assert.equal(await run('out = "03-Feb-2020 03:48:12".unixEpoch("Hello");', 'America/Los_Angeles'), 1580701692000);
  
  // Unrecognized text is returned as text. A date value (not text) is a runtime error.
  assert.equal(await run('out = "not-a-date".unixEpoch();'), 'not-a-date');
  await assert.rejects(() => run("out = '03-Feb-2020 03:48:12'.unixEpoch();"), /UnParsable date/);

  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const ctx = runtime.context({});
  const date = runtime.shim.date as typeof runtime.shim.date & {
    unixEpoch(value: unknown, ctx: unknown): number | string | null;
  };
  assert.throws(() => date.unixEpoch(new DelugeDate(2020, 2, 3, 3, 48, 12), ctx), /UnParsable date/);
});
