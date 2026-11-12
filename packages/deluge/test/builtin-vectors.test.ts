import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const parity = await import(pathToFileURL(path.join(root, 'tests/golden/parity.mjs')).href);

// The golden parity harness freezes the wall clock; derive the date `today`
// must return from that clock instead of hardcoding it.
const clockToday = new Intl.DateTimeFormat('en-CA', {
  timeZone: parity.ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date(parity.CLOCK));

// Documentation-derived vectors for Deluge builtins. Each entry is preceded by
// a comment citing the Zoho Deluge help page its expected value comes from (or
// the arithmetic the page implies when it has no worked example); none is a
// Creator capture. Some of these builtins already have golden parity cases —
// the vectors here pin the documented value through the same translate + shim
// path rather than asserting a captured one.
const VECTORS: Array<[string, string, unknown]> = [
  // https://www.zoho.com/deluge/help/functions/list.html
  ['nthLargest', 'golden = {300, 455, 124, 926, 780}.nthLargest(5);', 124],
  // https://www.zoho.com/deluge/help/functions/list.html
  ['nthSmallest', 'golden = {300, 455, 124, 926, 780}.nthSmallest(2);', 300],
  // https://www.zoho.com/deluge/help/functions/list.html
  ['average', 'golden = {1, 5, 2, 3}.average();', 2.75],
  // https://www.zoho.com/deluge/help/functions/list.html
  ['median', 'golden = {1, 5, 2, 3}.median();', 2.5],
  // https://www.zoho.com/deluge/help/functions/number.html
  ['pow', 'golden = pow(2, 3);', 8],
  // https://www.zoho.com/deluge/help/functions/conversion.html
  ['toHex', 'golden = (100).toHex();', '64'],
  // https://www.zoho.com/deluge/help/functions/conversion.html
  ['toWords', 'golden = (1989).toWords("en-us");', 'one thousand nine hundred eighty-nine'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['ltrim', 'golden = "  ab ".ltrim();', 'ab '],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['rtrim', 'golden = "  ab ".rtrim();', '  ab'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['len', 'golden = "Zoho".len();', 4],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['upper', 'golden = "Zoho".upper();', 'ZOHO'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['lower', 'golden = "Zoho".lower();', 'zoho'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['reverse', 'golden = "Zoho".reverse();', 'ohoZ'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['repeat', 'golden = "ab".repeat(3);', 'ababab'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['rightpad', 'golden = "7".rightpad(3);', '7  '],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['equalsIgnoreCase', 'golden = "Zoho".equalsIgnoreCase("ZOHO");', true],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['containsIgnoreCase', 'golden = "Zoho Creator".containsIgnoreCase("creator");', true],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['startsWithIgnoreCase', 'golden = "Zoho".startsWithIgnoreCase("zo");', true],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['endsWithIgnoreCase', 'golden = "Zoho".endsWithIgnoreCase("HO");', true],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['getOccurenceCount', 'golden = "banana".getOccurenceCount("an");', 2],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['getAlpha', 'golden = "a1b2".getAlpha();', 'ab'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['getAlphaNumeric', 'golden = "a1-b2!".getAlphaNumeric();', 'a1b2'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['removeAllAlphaNumeric', 'golden = "a1-b2!".removeAllAlphaNumeric();', '-!'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['left', 'golden = "Zoho".left(2);', 'Zo'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['right', 'golden = "Zoho".right(2);', 'ho'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['isAscii', 'golden = "abc".isAscii();', true],
  // https://www.zoho.com/deluge/help/functions/conversion.html
  ['textToHex', 'golden = "A".textToHex();', '41'],
  // https://www.zoho.com/deluge/help/functions/conversion.html
  ['hexToText', 'golden = "41".hexToText();', 'A'],
  // https://www.zoho.com/deluge/help/functions/date-time.html
  ['eomonth', 'golden = eomonth(toDate("2020-01-15"), 1).toString("yyyy-MM-dd");', '2020-02-29'],
  // https://www.zoho.com/deluge/help/functions/date-time.html
  ['daysBetween', 'golden = daysBetween(toDate("2020-01-01"), toDate("2020-01-11"));', 10],
  // https://www.zoho.com/deluge/help/functions/date-time.html
  ['subDay', 'golden = toDate("2020-03-01").subDay(1).toString("yyyy-MM-dd");', '2020-02-29'],
  // https://www.zoho.com/deluge/help/functions/date-time.html
  ['subMonth', 'golden = toDate("2020-03-31").subMonth(1).toString("yyyy-MM-dd");', '2020-02-29'],
  // https://www.zoho.com/deluge/help/functions/date-time.html
  ['subYear', 'golden = toDate("2020-02-29").subYear(1).toString("yyyy-MM-dd");', '2019-02-28'],
  // https://www.zoho.com/deluge/help/functions/date-time.html
  ['toStartOfMonth', 'golden = toDate("2020-03-17").toStartOfMonth().toString("yyyy-MM-dd");', '2020-03-01'],
  // https://www.zoho.com/deluge/help/functions/date-time.html
  ['getDayOfYear', 'golden = toDate("2020-03-01").getDayOfYear();', 61],
  // https://www.zoho.com/deluge/help/functions/key-value.html
  ['clear', 'm = {"k": "v"}; m.clear(); golden = m.size();', 0],
  // https://www.zoho.com/deluge/help/functions/key-value.html
  ['keys', 'golden = {"k": "v", "j": "w"}.keys();', ['k', 'j']],
  // https://www.zoho.com/deluge/help/functions/key-value.html
  ['putAll', 'm = {"k": "v"}; m.putAll({"j": "w"}); golden = m.size();', 2],
  // https://www.zoho.com/deluge/help/functions/key-value.html
  ['containValue', 'golden = {"k": "v"}.containValue("v");', true],
  // https://www.zoho.com/deluge/help/functions/list.html
  ['subList', 'golden = {"a", "b", "c", "d"}.subList(1, 3);', ['b', 'c']],
  // https://www.zoho.com/deluge/help/functions/list.html
  ['removeElement', 'l = {"a", "b", "a"}; l.removeElement("a"); golden = l;', ['b', 'a']],
  // https://www.zoho.com/deluge/help/functions/list.html
  ['addall', 'l = {"a"}; l.addAll({"b", "c"}); golden = l;', ['a', 'b', 'c']],
  // https://www.zoho.com/deluge/help/functions/list.html
  ['count', 'golden = {"a", "b", "c"}.count();', 3],
  // https://www.zoho.com/deluge/help/functions/list.html
  ['maximum', 'golden = {3, 9, 4}.maximum();', 9],
  // https://www.zoho.com/deluge/help/functions/list.html
  ['sum', 'golden = {3, 9, 4}.sum();', 16],
  // https://www.zoho.com/deluge/help/functions/date-time.html ("Sunday is the first day of a week")
  ['toStartOfWeek', 'golden = toDate("2020-03-18").toStartOfWeek().toString("yyyy-MM-dd");', '2020-03-15'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['removeLastOccurence', 'golden = "a,b,c,".removeLastOccurence(",");', 'a,b,c'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['removeLastOccurence.chained', 'golden = "a,b,c,".removeLastOccurence(",").toList(",");', ['a', 'b', 'c']],
  // https://www.zoho.com/deluge/help/functions/collection/insert.html —
  // "<collectionVariable>.insert( <element> )" appends the element; the docs
  // define no positional insert(index, element) form.
  ['insert', 'l = {"a", "c"}; l.insert("b"); golden = l;', ['a', 'c', 'b']],
  // https://www.zoho.com/deluge/help/functions/date-time.html
  ['yearsBetween', 'golden = yearsBetween(toDate("2000-01-01"), toDate("2020-01-01"));', 20],
  // https://www.zoho.com/deluge/help/functions/date-time.html
  ['yearsBetween.oneYear', 'golden = yearsBetween(toDate("2020-01-01"), toDate("2021-01-01"));', 1],
  // https://www.zoho.com/deluge/help/functions/date-time.html — toTime keeps the
  // clock, so this is 01:30 minus 90 minutes = 00:00 the same day.
  ['subMinutes', 'golden = "2020-01-01 01:30:00".toTime().subMinutes(90).toString("yyyy-MM-dd HH:mm:ss");', '2020-01-01 00:00:00'],
  // https://www.zoho.com/deluge/help/functions/text.html (space -> "+", "&" -> "%26")
  ['encodeUrl', 'golden = encodeUrl("a b&c");', 'a+b%26c'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['encodeUrl.method', 'golden = "a b".encodeUrl();', 'a+b'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['decodeUrl', 'golden = "a%20b".decodeUrl();', 'a b'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['removeFirstOccurence', 'golden = "Zoho Creator 5".removeFirstOccurence("5");', 'Zoho Creator '],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['removeFirstOccurence.repeated', 'golden = "a,b,a".removeFirstOccurence(",");', 'ab,a'],
  // https://www.zoho.com/deluge/help/functions/conversion.html
  ['toJSONList', 'golden = "[343,443,577]".toJSONList();', [343, 443, 577]],
  // https://www.zoho.com/deluge/help/functions/date-time.html (Dec 31 of a leap year is day 366)
  ['getDayOfYear.leap', 'golden = toDate("2020-12-31").getDayOfYear();', 366],
  // https://www.zoho.com/deluge/help/functions/date-time.html — the docs show
  // positive examples only, so the negative sign here is an implementation
  // assumption (end - start), not a documented result.
  ['daysBetween.reverse (implementation-assumed sign)', 'golden = daysBetween(toDate("2020-01-11"), toDate("2020-01-01"));', -10],
  // https://www.zoho.com/deluge/help/functions/date-time.html (Feb 2020 is a leap month)
  ['eomonth.previous', 'golden = eomonth(toDate("2020-03-15"), -1).toString("yyyy-MM-dd");', '2020-02-29'],
  // https://www.zoho.com/deluge/help/functions/conversion.html
  ['toTime', 'golden = "2020-01-15 09:30:00".toTime().toString("HH:mm:ss");', '09:30:00'],
  // https://www.zoho.com/deluge/help/functions/number.html
  ['abs', 'golden = abs(-42);', 42],
  // https://www.zoho.com/deluge/help/functions/number.html
  ['ceil', 'golden = ceil(2.1);', 3],
  // https://www.zoho.com/deluge/help/functions/number.html
  ['floor', 'golden = floor(2.9);', 2],
  // https://www.zoho.com/deluge/help/functions/number.html
  ['min', 'golden = min(9, 4, 7);', 4],
  // https://www.zoho.com/deluge/help/functions/number.html
  ['max', 'golden = max(9, 4, 7);', 9],
  // https://www.zoho.com/deluge/help/functions/number.html
  ['exp', 'golden = exp(1);', Math.E],
  // https://www.zoho.com/deluge/help/functions/number.html
  ['log', 'golden = log(1);', 0],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['trim', 'golden = "  Zoho  ".trim();', 'Zoho'],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['contains', 'golden = "Zoho Creator".contains("Creator");', true],
  // https://www.zoho.com/deluge/help/functions/text.html (0-based; the page's own example returns 5)
  ['indexOf', 'golden = "Zoho Creator".indexOf("Creator");', 5],
  // https://www.zoho.com/deluge/help/functions/text.html
  ['leftpad', 'golden = "7".leftpad(3);', '  7'],
  // https://www.zoho.com/deluge/help/functions/list.html
  ['intersect', 'golden = {"a", "b"}.intersect({"b", "c"});', ['b']],
  // https://www.zoho.com/deluge/help/functions/text.html (0-based [start, end))
  ['subText', 'golden = "Zoho Creator".subText(0, 4);', 'Zoho'],
  // https://www.zoho.com/deluge/help/functions/date-time.html (toTime keeps the clock; underflows across midnight)
  ['subHour', 'golden = "2020-01-01 00:30:00".toTime().subHour(1).toString("yyyy-MM-dd HH:mm:ss");', '2019-12-31 23:30:00'],
  // https://www.zoho.com/deluge/help/functions/date-time.html (weeks start Sunday; Jan 6 2020 is in week 2)
  ['getWeekOfYear', 'golden = "2020-01-06".toDate().getWeekOfYear();', 2],
  // https://www.zoho.com/deluge/help/functions/date-time.html — expected is the
  // golden harness clock date (parity.CLOCK in parity.ZONE), not a literal.
  ['today', 'golden = today.toString("yyyy-MM-dd");', clockToday],
];

for (const [name, script, expected] of VECTORS) {
  test(`doc vector: ${name}`, async () => {
    const actual = await parity.evaluateCase({ script, capture: 'value' });
    assert.deepEqual(actual, expected, script);
  });
}
