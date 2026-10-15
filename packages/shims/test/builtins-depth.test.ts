import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DelugeConversionError, toJSONList, toListString } from '../src/convert.js';
import { DelugeDate } from '../src/date.js';
import { Decimal } from '../src/decimal.js';
import { DelugeRuntimeError } from '../src/errors.js';
import { aggregate, column, subList } from '../src/list.js';
import { createRuntime, type RuntimeOptions } from '../src/runtime.js';
import {
  encodeUrl,
  getAlpha,
  getAlphaNumeric,
  leftPad,
  matches,
  removeFirstOccurence,
  removeLastOccurence,
  replaceAll,
  subText,
} from '../src/text.js';
import { mockDatastore } from './zcql-mock.js';

// Each test pins the behaviour on the builtin's Deluge help page (the
// documented example first), then null, empty and wrong-type inputs.

test('removeFirstOccurence / removeLastOccurence drop one case-sensitive occurrence', () => {
  // functions/string/removelastoccurence, removefirstoccurence
  // The help page shows one space in the result; its HTML collapses the two
  // spaces left around the removed word.
  assert.equal(removeLastOccurence('Create an app using Zoho Creator app builder', 'app'), 'Create an app using Zoho Creator  builder');
  assert.equal(removeFirstOccurence('Zoho Creator 5', '5'), 'Zoho Creator ');
  assert.equal(removeFirstOccurence('a,b,c,', ','), 'ab,c,');
  assert.equal(removeLastOccurence('a,b,c,', ','), 'a,b,c');
  // Not present, or a different case: the text as it is.
  assert.equal(removeLastOccurence('Zoho', 'x'), 'Zoho');
  assert.equal(removeFirstOccurence('Zoho', 'zoho'), 'Zoho');
  assert.equal(removeFirstOccurence('Zoho', ''), 'Zoho');
  assert.equal(removeFirstOccurence('Zoho', null), 'Zoho');
  // Null text is null; an emptied text is null, as for every Creator text function.
  assert.equal(removeFirstOccurence(null, 'a'), null);
  assert.equal(removeLastOccurence('abc', 'abc'), null);
  assert.equal(removeLastOccurence(12312, 1), '1232');
});

test('getAlpha keeps letters and getAlphaNumeric letters and digits', () => {
  // functions/string/getAlpha, getAlphaNumeric
  assert.equal(getAlpha('Your joining date is January 25th, 2019'), 'YourjoiningdateisJanuaryth');
  assert.equal(getAlphaNumeric('Your joining date is 25-01-2019'), 'Yourjoiningdateis25012019');
  assert.equal(getAlpha(null), null);
  assert.equal(getAlphaNumeric(null), null);
  assert.equal(getAlpha('2019 - 25'), null);
  assert.equal(getAlphaNumeric('  -/ '), null);
  assert.equal(getAlphaNumeric(10.5), '105');
  // Letters are the ASCII set removeAllAlpha removes.
  assert.equal(getAlpha('Café'), 'Caf');
});

test('subText ignores a negative end, excludes the end index, and rejects end < start', () => {
  // functions/string/subtext examples 1-3
  assert.equal(subText('Zoho Deluge', 5, -12), 'Deluge');
  assert.equal(subText('Zoho Deluge', 0, 4), 'Zoho');
  assert.throws(() => subText('Zoho Deluge', 6, 4), DelugeRuntimeError);
  assert.equal(subText('Zoho Deluge', 5), 'Deluge');
  assert.equal(subText('Zoho', 4), null);
  assert.throws(() => subText('Zoho', 9), DelugeRuntimeError);
});

test('matches is a whole-text, case-sensitive regular expression test', () => {
  // functions/string/matches examples
  assert.equal(matches('ID004500F', '[A-Z]{2}[0-9]{6}[A-Z]'), true);
  assert.equal(matches('$345.78', '\\$[0-9]+\\.[0-9]{2}'), true);
  assert.equal(matches('a1 b2@c.d', '[a-z 0-9]+\\@[a-z]+\\.[a-z]+'), true);
  // The whole text must match, not a part of it.
  assert.equal(matches('xID004500F', '[A-Z]{2}[0-9]{6}[A-Z]'), false);
  assert.equal(matches('id004500f', '[A-Z]{2}[0-9]{6}[A-Z]'), false);
  assert.equal(matches('12', '^[0-9]*$'), true);
  assert.equal(matches('', '^[0-9]*$'), true);
  assert.equal(matches(null, '.*'), false);
  assert.equal(matches('a', null), false);
  assert.throws(() => matches('a', '('), DelugeRuntimeError);
});

test('matches reads the pattern as a Java regular expression, never as JavaScript would', () => {
  // Unicode properties and POSIX classes.
  assert.equal(matches('abc', '\\p{L}+'), true);
  assert.equal(matches('ab1', '\\p{L}+'), false);
  assert.equal(matches('abc', '\\P{L}+'), false);
  assert.equal(matches('x', '\\pL'), true);
  assert.equal(matches('Ab', '\\p{Lu}\\p{Ll}'), true);
  assert.equal(matches('abc', '\\p{IsLatin}+'), true);
  assert.equal(matches('abc', '[\\p{Alpha}]+'), true);
  assert.equal(matches('é', '\\p{Alpha}'), false);
  // \Q..\E quotes literal text.
  assert.equal(matches('d+', '\\Qd+\\E'), true);
  assert.equal(matches('dd', '\\Qd+\\E'), false);
  assert.equal(matches('a.b', 'a\\Q.\\Eb'), true);
  assert.equal(matches('axb', 'a\\Q.\\Eb'), false);
  // Anchors: \A and \G are the start, \z the end, $ and \Z allow a final line terminator.
  assert.equal(matches('abc', '\\Gabc'), true);
  assert.equal(matches('abc', '\\Aabc\\z'), true);
  assert.equal(matches('abc\n', 'abc$\n'), true);
  assert.equal(matches('abc\r\n', 'abc\\Z\r\n'), true);
  assert.equal(matches('abc\r\n', 'abc\r$\n'), false);
  // Java character sets: \h, \v, \s, '.' and \x{..}.
  assert.equal(matches(' abc', '\\habc'), true);
  assert.equal(matches('\nabc', '\\habc'), false);
  assert.equal(matches('\n', '\\v'), true);
  assert.equal(matches('\u00a0', '\\s'), false);
  assert.equal(matches('\u0085', '.'), false);
  assert.equal(matches('\u263a', '\\x{263A}'), true);
  assert.equal(matches('A', '\\x41'), true);
  // \b agrees with Java on ASCII text; non-ASCII text is refused, not guessed.
  assert.equal(matches('ab cd', 'ab\\b cd'), true);
  assert.throws(() => matches('\u00e9 a', '\u00e9\\b a'), /word boundary/);
});

test('matches refuses Java constructs it cannot evaluate exactly, naming the construct', () => {
  assert.throws(() => matches('aa', 'a++'), /possessive quantifier \+\+/);
  assert.throws(() => matches('abc', '(?>a)bc'), /atomic group/);
  assert.throws(() => matches('abc', '(?i)ABC'), /inline flags \(\?i\)/);
  assert.throws(() => matches('aa', '(a)\\1'), /back reference \\1/);
  assert.throws(() => matches('b', '[a-z&&[^aeiou]]'), /intersection/);
  assert.throws(() => matches('b', '[a[b]]'), /union/);
  assert.throws(() => matches('a', '\\p{InGreek}'), /\\p\{InGreek\}/);
  assert.throws(() => matches('\n', '\\R'), /escape \\R/);
  assert.throws(() => matches('a', '[\\S]'), /\\S inside a character class/);
});

test('matches refuses a catastrophic-backtracking pattern before it runs, and bounds the text', () => {
  const started = Date.now();
  assert.throws(() => matches(`${'a'.repeat(30)}b`, '(a+)+$'), /backtrack without bound/);
  assert.ok(Date.now() - started < 100, 'refused without running the pattern');
  assert.throws(() => matches('aaaa', '(a|a)*'), /backtrack without bound/);
  assert.throws(() => matches('aaaa', '(.*)*'), /backtrack without bound/);
  assert.throws(() => matches('ab', '(?:\\w+\\s?)+'), /backtrack without bound/);
  // Repetition with a bounded body, or branches told apart by their first letter, runs.
  assert.equal(matches('abab', '(a|b)*'), true);
  assert.equal(matches('catdog', '(cat|dog)+'), true);
  assert.equal(matches('192.168.0.1', '(\\d{1,3}\\.){3}\\d{1,3}'), true);
  // The text bound: a migrated text column holds at most 10,000 characters.
  assert.equal(matches('a'.repeat(10_000), 'a*'), true);
  assert.throws(() => matches('a'.repeat(10_001), 'a*'), /longer than the 10000/);
});

test('matches refuses a repeated group that can match in more than one length', () => {
  // Inner {m,n} with n > 1, an optional, and an alternation of different
  // widths still partition the text in exponentially many ways.
  const evil = [
    '(a{1,2})*$',
    '(a?)*$',
    '(a{1,2}a)*$',
    '(ab|c)*$',
    '(a+)+$',
    '(.*)*',
    '(a|a)*',
    '(\\w+\\s)+',
    '(a|aa)+$',
    '(x+x+)+y',
    '(a|a?)*$',
    '([a-zA-Z]+)*$',
  ];
  for (const pattern of evil) {
    const started = Date.now();
    assert.throws(() => matches('ab', pattern), /backtrack without bound/, pattern);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5, `${pattern} refused in ${elapsed}ms`);
  }
});

test('every accepted pattern finishes on a 10000 character input', () => {
  const accepted = [
    '[A-Z]{2}[0-9]{6}[A-Z]',
    '\\$[0-9]+\\.[0-9]{2}',
    '[a-z 0-9]+\\@[a-z]+\\.[a-z]+',
    '^[0-9]*$',
    '.*',
    '\\p{L}+',
    '\\P{L}+',
    '\\pL',
    '\\p{Lu}\\p{Ll}',
    '\\p{IsLatin}+',
    '[\\p{Alpha}]+',
    '\\p{Alpha}',
    '\\Qd+\\E',
    'a\\Q.\\Eb',
    '\\Gabc',
    '\\Aabc\\z',
    'abc$\\n',
    'abc\\Z\\r\\n',
    'abc\\r$\\n',
    '\\habc',
    '\\v',
    '\\s',
    '.',
    '\\x{263A}',
    '\\x41',
    'ab\\b cd',
    '(a|b)*',
    '(cat|dog)+',
    '(\\d{1,3}\\.){3}\\d{1,3}',
    'a*',
  ];
  const input = `${'a'.repeat(9_999)}b`;
  assert.equal(input.length, 10_000);
  for (const pattern of accepted) {
    const started = Date.now();
    const result = matches(input, pattern);
    const elapsed = Date.now() - started;
    assert.equal(typeof result, 'boolean', pattern);
    assert.ok(elapsed < 200, `${pattern} took ${elapsed}ms`);
  }
});

test('matches refuses text outside the Basic Multilingual Plane', () => {
  // Java counts UTF-16 units. A supplementary character is two units, so a
  // code-point `.` would give the wrong answer. Refusal names the text.
  assert.throws(() => matches('\u{1D400}', '.'), /non-BMP/);
  assert.throws(() => matches('\u{1D400}', '..'), /non-BMP/);
  assert.throws(() => matches('a\u{1D400}', 'a.'), /non-BMP/);
  assert.equal(matches('\u263a', '.'), true);
  assert.equal(matches('éé', '..'), true);
});

test('replaceAll uses the Java pattern and Java replacement, and refuses what matches refuses', () => {
  assert.equal(replaceAll('ab', '(a)(b)', '$2$1'), 'ba');
  assert.equal(replaceAll('a', '(a)', '$1$1'), 'aa');
  assert.equal(replaceAll('a', '(a)', '\\$1'), '$1');
  assert.equal(replaceAll('a', 'a', '\\\\'), '\\');
  assert.equal(replaceAll('ab', 'ab', '$0'), 'ab');
  assert.equal(replaceAll('a', '(a)', '${1}'), 'a');
  assert.equal(replaceAll('ab', '(?<x>a)(?<y>b)', '${y}${x}'), 'ba');
  // A group that did not participate adds nothing. An empty result is null.
  assert.equal(replaceAll('b', '(a)|(b)', '$1'), null);
  assert.throws(() => replaceAll('a', 'a', '$1'), /No group 1/);
  assert.throws(() => replaceAll('a', 'a', '$$'), /Illegal group reference/);
  assert.throws(() => replaceAll('a', 'a', '\\'), /escaped is missing/);
  // An invalid pattern is an error, not a literal search.
  assert.throws(() => replaceAll('a[b', '[', 'x'), DelugeRuntimeError);
  assert.equal(replaceAll('a+b', '\\Q+\\E', 'x'), 'axb');
  assert.equal(replaceAll('a.b', '.', '-'), '---');
  assert.equal(replaceAll('a.b', '.', '-', true), 'a-b');
  assert.equal(replaceAll('a$b', '$', 'X', true), 'aXb');
  const started = Date.now();
  assert.throws(() => replaceAll('ab', '(a{1,2})*', 'x'), /backtrack without bound/);
  assert.throws(() => replaceAll('aaaa', '(a+)+', 'x'), /backtrack without bound/);
  assert.ok(Date.now() - started < 5, 'replaceAll refused before running');
  assert.throws(() => replaceAll('a'.repeat(10_001), 'a', 'b'), /longer than the 10000/);
  assert.equal(replaceAll('a'.repeat(10_000), 'a', 'b')?.length, 10_000);
  assert.throws(() => replaceAll('\u{1D400}', '.', 'x'), /non-BMP/);
  assert.equal(replaceAll('abc\n', '$', 'X'), 'abcX\nX');
  assert.equal(replaceAll('abc\n', '\\Z', 'X'), 'abcX\nX');
  assert.equal(replaceAll('abc\n', '\\z', 'X'), 'abc\nX');
});

test('len, length and the .length() method agree on every input', () => {
  // functions/string/length: text.length(), length(text), text.len() and len(text) are one function.
  const { shim } = createRuntime({ dryRun: true });
  for (const v of [null, '', 'ab', ['a'], 123, { a: 1 }]) {
    const method = shim.list.length(v);
    assert.equal(shim.string.length(v), method, `length(${JSON.stringify(v)})`);
    assert.equal(shim.string.len(v), method, `len(${JSON.stringify(v)})`);
  }
});

test('leftPad pads to the width and refuses a width past the pad maximum', () => {
  // functions/string/leftpad example: "Left".leftpad(6) -> "  Left" (the
  // rendered page collapses the two spaces). A negative width returns the
  // text unchanged, and the documented width maximum is 10,000.
  assert.equal(leftPad('Left', 6), '  Left');
  assert.equal(leftPad('x', -3), 'x');
  assert.equal(leftPad('longer', 3), 'longer');
  assert.equal(leftPad('', 10_000)?.length, 10_000);
  assert.throws(() => leftPad('', 10_001), DelugeRuntimeError);
  assert.throws(() => leftPad('', 2 ** 53 - 1), DelugeRuntimeError);
  assert.throws(() => leftPad('x', 2 ** 53 - 1, 'ab'), DelugeRuntimeError);
});

test('encodeUrl is form encoding: space is +, unreserved . - * _ stay', () => {
  // functions/common/encodeurl
  assert.equal(
    encodeUrl('http://www.zoho.com/zohotest?name=John&country=Australia&age=101'),
    'http%3A%2F%2Fwww.zoho.com%2Fzohotest%3Fname%3DJohn%26country%3DAustralia%26age%3D101',
  );
  assert.equal(encodeUrl('a b'), 'a+b');
  assert.equal(encodeUrl("a.b-c*d_e!'()~"), "a.b-c*d_e%21%27%28%29%7E");
  assert.equal(encodeUrl('é'), '%C3%A9');
  assert.equal(encodeUrl(null), null);
  assert.equal(encodeUrl(''), null);
});

test('subList returns a new list from start up to the end index and checks bounds', () => {
  // functions/list/sublist
  const l = [1, 2, 3, 4];
  assert.deepEqual(subList(l, 0, 3), [1, 2, 3]);
  assert.deepEqual(subList(l, 2), [3, 4]);
  assert.deepEqual(subList(l, 4), []);
  assert.deepEqual(l, [1, 2, 3, 4]);
  assert.throws(() => subList(l, -1, 2), DelugeRuntimeError);
  assert.throws(() => subList(l, 0, 5), DelugeRuntimeError);
  assert.throws(() => subList(l, 3, 2), DelugeRuntimeError);
  assert.throws(() => subList(null, 0, 1), DelugeRuntimeError);
});

test('column reads one field of every in-memory row', () => {
  const rows = [{ Product: 'A', Amount: 2 }, { Product: 'B' }, { ROWID: '9', Product: null }];
  assert.deepEqual(column(rows, 'Product'), ['A', 'B', null]);
  assert.deepEqual(column(rows, 'Amount'), [2, null, null]);
  assert.deepEqual(column(rows, 'ID'), [null, null, '9']);
  assert.deepEqual(column({ Product: 'A' }, 'Product'), ['A']);
  assert.deepEqual(column(null, 'Product'), []);
  assert.deepEqual(column([], 'Product'), []);
});

test('aggregate: sum, avg, median, min, max, count, distinct with Creator blanks', () => {
  // functions/number/average: {1, 5, 2, 3}.average() is 2.75
  assert.equal(aggregate([1, 5, 2, 3], 'average'), 2.75);
  assert.equal(aggregate([1, 5, 2, 3], 'sum'), 11);
  assert.equal(aggregate([1, 5, 2, 3], 'median'), 2.5);
  assert.equal(aggregate([7, 1, 3], 'median'), 3);
  assert.equal(aggregate([7, 1, 3], 'maximum'), 7);
  assert.equal(aggregate([7, 1, 3], 'min'), 1);
  // Blank values are skipped; count without a field is the number of rows.
  assert.equal(aggregate([1, null, '', 3], 'avg'), 2);
  assert.equal(aggregate([1, null, '', 3], 'count'), 4);
  // count(field) counts values the field holds: null is skipped, '' counts.
  // Bare count of the same rows stays the row count (the case above).
  const counted = [{ Amount: 1 }, { Amount: null }, { Amount: '' }];
  assert.equal(aggregate(counted, 'count', 'Amount'), 2);
  assert.equal(aggregate(counted, 'count'), 3);
  assert.deepEqual(aggregate(['a', 'b', 'a'], 'distinct'), ['a', 'b']);
  // Nothing to aggregate: null, and count 0.
  assert.equal(aggregate([], 'sum'), null);
  assert.equal(aggregate([null, ''], 'max'), null);
  assert.equal(aggregate(null, 'count'), 0);
  // Over rows with a field link name.
  const rows = [{ Amount: '10.10' }, { Amount: '0.20' }, { Amount: null }];
  assert.equal(aggregate(rows, 'sum', 'Amount'), 10.3);
  // A decimal field sums exactly; no binary rounding.
  const exact = aggregate([{ Amount: '0.1' }, { Amount: '0.2' }], 'sum', 'Amount', true);
  assert.ok(exact instanceof Decimal);
  assert.equal(String(exact), '0.3');
  assert.equal(String(aggregate([Decimal.from('1.00'), Decimal.from('2.00')], 'avg')), '1.5');
  // Dates order as dates and come back as dates.
  const max = aggregate(['01-Jan-2020', '15-Mar-2019', new DelugeDate(2020, 2, 1)], 'max');
  assert.ok(max instanceof DelugeDate);
  assert.equal(String(max), '2020-02-01T00:00:00');
  // A non-numeric value cannot be summed.
  assert.throws(() => aggregate(['a', 'b'], 'sum'), DelugeRuntimeError);
  assert.throws(() => aggregate([1], 'mode'), DelugeRuntimeError);
});

test('toListString splits comma text into text elements; toJSONList parses a JSON array', () => {
  // functions/list/to-list-string
  assert.deepEqual(toListString('1,2,3,4,5'), ['1', '2', '3', '4', '5']);
  assert.deepEqual(toListString('a,,b'), ['a', null, 'b']);
  assert.deepEqual(toListString([1, 'b', null]), ['1', 'b', null]);
  assert.throws(() => toListString(null), DelugeConversionError);
  // functions/common/tojsonlist
  assert.deepEqual(toJSONList('[343,443,577]'), [343, 443, 577]);
  assert.deepEqual(toJSONList('[{"id":1},{"id":2}]'), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(toJSONList([1, 2]), [1, 2]);
  assert.throws(() => toJSONList('{"a":1}'), DelugeConversionError);
  assert.throws(() => toJSONList('not json'), DelugeConversionError);
  assert.throws(() => toJSONList(null), DelugeConversionError);
});

function dateRuntime(now = '2020-06-15T12:00:00Z', zone = 'UTC') {
  const runtime = createRuntime({ dryRun: true, appTimeZone: zone, now: new Date(now) });
  return { date: runtime.shim.date, zoho: runtime.shim.zoho, ctx: runtime.context({}) };
}

test('eomonth and toStartOfMonth: month ends and starts, without a time of day', () => {
  const { date, ctx } = dateRuntime();
  // functions/datetime/eomonth: '01-Jan-2019'.eomonth(1) is 28-Feb-2019
  assert.equal(String(date.eomonth('01-Jan-2019', 1, ctx)), '2019-02-28T00:00:00');
  assert.equal(String(date.eomonth('31-Jan-2020 10:30:00', 1, ctx)), '2020-02-29T00:00:00');
  assert.equal(String(date.eomonth('15-Mar-2019', 0, ctx)), '2019-03-31T00:00:00');
  assert.equal(String(date.eomonth('15-Jan-2019', -1, ctx)), '2018-12-31T00:00:00');
  assert.equal(String(date.eomonth('15-Jan-2019', 13, ctx)), '2020-02-29T00:00:00');
  assert.equal(date.eomonth(null, 1, ctx), null);
  assert.equal(date.eomonth('', 1, ctx), null);
  assert.throws(() => date.eomonth('not a date', 1, ctx), DelugeRuntimeError);
  // functions/datetime/tostartofmonth: '15-Mar-2019 15:00:00' is 01-Mar-2019 00:00:00
  assert.equal(String(date.toStartOfMonth('15-Mar-2019 15:00:00', ctx)), '2019-03-01T00:00:00');
  assert.equal(date.toStartOfMonth(null, ctx), null);
});

test('getDayOfYear and getWeekOfYear (weeks start on Sunday)', () => {
  const { date, ctx } = dateRuntime();
  // functions/datetime/getdayofyear: 31-Dec-2020 is 366
  assert.equal(date.getDayOfYear('31-Dec-2020', ctx), 366);
  assert.equal(date.getDayOfYear('31-Dec-2019', ctx), 365);
  assert.equal(date.getDayOfYear('01-Jan-2019 23:59:59', ctx), 1);
  assert.equal(date.getDayOfYear(null, ctx), null);
  // functions/datetime/getweekofyear: 7-Feb-2021 is week 7
  assert.equal(date.getWeekOfYear('7-Feb-2021', ctx), 7);
  assert.equal(date.getWeekOfYear('01-Jan-2021', ctx), 1);
  assert.equal(date.getWeekOfYear('02-Jan-2021', ctx), 1);
  assert.equal(date.getWeekOfYear('03-Jan-2021', ctx), 2);
  // A December date in the week that holds 1 January is week 1.
  assert.equal(date.getWeekOfYear('31-Dec-2020', ctx), 1);
  assert.equal(date.getWeekOfYear('26-Dec-2020', ctx), 52);
  assert.equal(date.getWeekOfYear('', ctx), null);
});

test('daysBetween, monthsBetween (30-day months) and yearsBetween (365-day years)', () => {
  const { date, ctx } = dateRuntime();
  // functions/datetime/daysbetween
  assert.equal(date.daysBetween('1-Jan-2019', '31-Dec-2019', ctx), 364);
  assert.equal(date.daysBetween('1-Jan-2020', '31-Dec-2020', ctx), 365);
  assert.equal(date.daysBetween('31-Dec-2020 23:00:00', '01-Jan-2021 01:00:00', ctx), 1);
  assert.equal(date.daysBetween('10-Jan-2020', '01-Jan-2020', ctx), -9);
  // functions/datetime/monthsbetween
  assert.equal(date.monthsBetween('31-Dec-1989', '01-Jan-1990', ctx), 0);
  assert.equal(date.monthsBetween('31-Dec-1989', '01-Feb-1990', ctx), 1);
  assert.equal(date.monthsBetween('01-Feb-2020', '01-Mar-2020', ctx), 0);
  // functions/datetime/yearsbetween
  assert.equal(date.yearsBetween('1-Jan-2019', '31-Dec-2019', ctx), 0);
  assert.equal(date.yearsBetween('1-Jan-2020', '31-Dec-2020', ctx), 1);
  assert.equal(date.yearsBetween('02-Jan-2020', '01-Jan-2021', ctx), 1);
  assert.equal(date.yearsBetween('01-Jan-2021', '02-Jan-2020', ctx), -1);
  // A blank end is UnParsable date, as days360.
  assert.throws(() => date.daysBetween(null, '01-Jan-2020', ctx), /UnParsable date/);
  assert.throws(() => date.yearsBetween('01-Jan-2020', '', ctx), /UnParsable date/);
});

test('date functions on zoho.currentdate follow the app time zone, not UTC', () => {
  // 31 Dec 2020 20:00 UTC is already 1 Jan 2021 in Asia/Kolkata.
  const { date, zoho, ctx } = dateRuntime('2020-12-31T20:00:00Z', 'Asia/Kolkata');
  const today = zoho.currentDate(ctx);
  assert.equal(date.getDayOfYear(today, ctx), 1);
  assert.equal(String(date.toStartOfMonth(today, ctx)), '2021-01-01T00:00:00');
  assert.equal(date.yearsBetween('01-Jan-2000', today, ctx), 21);
  const utc = dateRuntime('2020-12-31T20:00:00Z', 'UTC');
  assert.equal(utc.date.getDayOfYear(utc.zoho.currentDate(utc.ctx), utc.ctx), 366);
});

const DEC = { Orders: { Amount: { shadow: 'Amount__n', scale: 2 } } };

test('Data Store sum / avg / max / min / median compute over the fetched rows (seed)', async () => {
  const seed = {
    Orders: [
      { ROWID: '1', Qty: 2, Amount: '0.10', Due: '01-Jan-2020', Status: 'Open' },
      { ROWID: '2', Qty: 5, Amount: '0.20', Due: '15-Mar-2021', Status: 'Open' },
      { ROWID: '3', Qty: 1, Amount: null, Due: null, Status: 'Open' },
      { ROWID: '4', Qty: 9, Amount: '5.00', Due: '01-Jan-2019', Status: 'Done' },
    ],
  };
  const runtime = createRuntime({ dryRun: true, seed, decimalColumns: DEC } as RuntimeOptions);
  const ctx = runtime.context({});
  const open = runtime.shim.datastore.query(ctx, 'Orders', { op: '==', field: 'Status', value: 'Open' });
  assert.equal(await runtime.shim.datastore.aggregate(ctx, open, 'sum', 'Qty'), 8);
  assert.equal(await runtime.shim.datastore.aggregate(ctx, open, 'max', 'Qty'), 5);
  assert.equal(await runtime.shim.datastore.aggregate(ctx, open, 'min', 'Qty'), 1);
  assert.equal(await runtime.shim.datastore.aggregate(ctx, open, 'median', 'Qty'), 2);
  assert.equal(await runtime.shim.datastore.aggregate(ctx, open, 'count'), 3);
  // count(Amount) skips the null amount. count() above stays the row count.
  assert.equal(await runtime.shim.datastore.aggregate(ctx, open, 'count', 'Amount'), 2);
  assert.equal(await runtime.shim.datastore.aggregate(ctx, open, 'count', 'Qty'), 3);
  // A decimal column is exact: 0.10 + 0.20 is 0.30, and the blank is skipped.
  assert.equal(String(await runtime.shim.datastore.aggregate(ctx, open, 'sum', 'Amount')), '0.30');
  assert.equal(String(await runtime.shim.datastore.aggregate(ctx, open, 'avg', 'Amount')), '0.15');
  assert.equal(String(await runtime.shim.datastore.aggregate(ctx, open, 'max', 'Due')), '2021-03-15T00:00:00');
  const none = runtime.shim.datastore.query(ctx, 'Orders', { op: '==', field: 'Status', value: 'Lost' });
  assert.equal(await runtime.shim.datastore.aggregate(ctx, none, 'sum', 'Qty'), null);
  assert.equal(await runtime.shim.datastore.aggregate(ctx, none, 'count'), 0);
});

test('Data Store sum / avg are computed on a live store, not null', async () => {
  const store = mockDatastore({ Orders: ['Amount__n'] });
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'UTC', datastore: store.datastore, decimalColumns: DEC } as RuntimeOptions);
  const ctx = runtime.context({});
  for (const [qty, amount] of [[2, '0.10'], [5, '0.20'], [4, '1.00']] as const) {
    await runtime.shim.datastore.insert(ctx, 'Orders', { Qty: qty, Amount: amount });
  }
  await runtime.shim.datastore.insert(ctx, 'Orders', { Qty: 1, Amount: null });
  const all = runtime.shim.datastore.query(ctx, 'Orders', { op: 'true' });
  assert.equal(await runtime.shim.datastore.aggregate(ctx, all, 'sum', 'Qty'), 12);
  assert.equal(await runtime.shim.datastore.aggregate(ctx, all, 'median', 'Qty'), 3);
  assert.equal(await runtime.shim.datastore.aggregate(ctx, all, 'count'), 4);
  // The null amount is a fetched row, not a value the field holds.
  assert.equal(await runtime.shim.datastore.aggregate(ctx, all, 'count', 'Amount'), 3);
  assert.equal(String(await runtime.shim.datastore.aggregate(ctx, all, 'sum', 'Amount')), '1.30');
  assert.equal(String(await runtime.shim.datastore.aggregate(ctx, all, 'max', 'Amount')), '1.00');
});

test('columns and aggregates unwrap a fetched or constructed row record', async () => {
  // Fetch returns { __row, form, values } rows (runtime.ts datastore.rows);
  // `Rows.Field.getAll()` and `.sum()` read the field inside `values`.
  const runtime = createRuntime({
    dryRun: true,
    seed: { Orders: [{ ROWID: '1', Qty: 2 }, { ROWID: '2', Qty: 3 }] },
  });
  const ctx = runtime.context({});
  const q = runtime.shim.datastore.query(ctx, 'Orders', { op: 'true' });
  const rows = await runtime.shim.datastore.rows(ctx, q);
  assert.deepEqual(column(rows, 'Qty'), [2, 3]);
  assert.equal(aggregate(rows, 'sum', 'Qty'), 5);
  assert.equal(aggregate(rows, 'count'), 2);
  // A `Form.Subform()` constructor row (record.bind) reads the same.
  const built = runtime.shim.record.bind(ctx, {}, 'Orders.Items');
  runtime.shim.record.set(built, ['Qty'], 4);
  assert.deepEqual(column([built], 'Qty'), [4]);
  assert.equal(aggregate([built], 'sum', 'Qty'), 4);
  assert.equal(runtime.shim.record.get(built, 'Qty'), 4);
  // A missing field is still null; a non-row object is unchanged.
  assert.deepEqual(column(rows, 'Missing'), [null, null]);
  assert.deepEqual(column([{ Qty: 7 }], 'Qty'), [7]);
});

test('input.<subform>.insert appends each row of a collection, or the one row', () => {
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ record: { Items: [{ Qty: 0 }] } });
  const built = runtime.shim.record.bind(ctx, {}, 'Order.Items');
  runtime.shim.record.set(built, ['Qty'], 5);
  runtime.shim.input.insert(ctx, ['Items'], built);
  runtime.shim.input.insert(ctx, ['Items'], [{ Qty: 1 }, { Qty: 2 }]);
  const rows = ctx.record.Items as unknown[];
  assert.equal(rows.length, 4);
  assert.deepEqual(column(rows, 'Qty'), [0, 5, 1, 2]);
  // A missing field starts the list; null adds nothing.
  runtime.shim.input.insert(ctx, ['Other'], { A: 1 });
  assert.equal((ctx.record.Other as unknown[]).length, 1);
  runtime.shim.input.insert(ctx, ['Other'], null);
  assert.equal((ctx.record.Other as unknown[]).length, 1);
});
