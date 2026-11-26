/**
 * Behaviour differential, rel5: ten more gallery-shaped constructs. The Creator
 * rule is the expectation, the generated function (offline harness) the actual.
 * Scripts run as an on-add success workflow of form Item; the assertion is the
 * stored row (or the Outcome text the script built). A skipped case is a real
 * defect: the reason is the Creator rule, and the card NOTES list it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { assertGolden, runBehavior, startOfflineBackend } from '../src/verify-behavior.js';

const field = (name: string, type: string, extra = '') => `\t\t\t${name}\n\t\t\t(\n\t\t\t\ttype = ${type}\n${extra}\t\t\t)\n`;
const FIELDS =
  `\t\t\tmust have Title\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n` +
  field('Stamp', 'datetime') +
  field('Day', 'date') +
  field('Tags', 'list', '\t\t\t\tvalues = {"red","green","blue"}\n') +
  field('Qty', 'number') +
  field('Price', 'decimal') +
  field('Rate', 'decimal') +
  field('Status', 'text') +
  field('Outcome', 'text') +
  field('Quantity', 'number') +
  field('Total', 'decimal');

function ds(script: string): string {
  const body = script.split('\n').map((line) => `\t\t\t\t\t\t\t${line}`).join('\n');
  return `application "rel5-sample"
{
\ttime zone = "Asia/Kolkata"
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t}
\tsection S
\t{
\t\tform Item
\t\t{
${FIELDS}\t\t}
\t\tform Line
\t\t{
\t\t\tmust have Name
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
${field('Amount', 'decimal')}${field('Kind', 'text')}\t\t}
\t\tlist All_Items
\t\t{
\t\t\tshow all rows from Item
\t\t}
\t\tlist All_Lines
\t\t{
\t\t\tshow all rows from Line
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tCompute as "Compute"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Item
\t\t\t\trecord event = on add
\t\t\t\ton success
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
${body}
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
}

async function run(script: string, record: Record<string, unknown>, lines: Record<string, unknown>[] = []): Promise<Record<string, unknown>> {
  const app = deriveIr(parse(ds(script)));
  const backend = await startOfflineBackend(app);
  try {
    await backend.reset?.();
    if (lines.length) await backend.insertRows?.('Line', lines);
    const reply = await backend.call('POST', '/forms/Item/success', { record: { Title: 'T', ...record } });
    assert.equal(reply.status, 200, JSON.stringify(reply));
    return (await backend.tableRows('Item'))[0] ?? {};
  } finally {
    await backend.close();
  }
}

interface Case {
  name: string;
  script: string;
  record?: Record<string, unknown>;
  lines?: Record<string, unknown>[];
  expect: Record<string, unknown>;
  /** A failing case is a real bug: skipped with the exact Creator rule. */
  skip?: string;
}

function table(group: string, cases: Case[]): void {
  for (const c of cases) {
    test(`${group}: ${c.name}`, { skip: c.skip }, async () => {
      const row = await run(c.script, c.record ?? {}, c.lines);
      for (const [column, want] of Object.entries(c.expect)) assert.equal(row[column], want, `${column} in ${JSON.stringify(row)}`);
    });
  }
}

table('time zone on date-time fields', [
  { name: 'a stored wall-clock date-time reads back as the same wall clock', script: 'input.Outcome = input.Stamp.toString("dd-MMM-yyyy HH:mm:ss");', record: { Stamp: '18-Oct-2026 18:39:00' }, expect: { Outcome: '18-Oct-2026 18:39:00' } },
  { name: 'addHour crosses midnight into the next day', script: 'input.Outcome = input.Stamp.addHour(3).toString("dd-MMM-yyyy HH:mm");', record: { Stamp: '31-Dec-2026 23:00:00' }, expect: { Outcome: '01-Jan-2027 02:00' } },
  { name: 'toDate drops the time and keeps the calendar day', script: 'input.Outcome = input.Stamp.toDate().toString("yyyy-MM-dd");', record: { Stamp: '18-Oct-2026 23:59:59' }, expect: { Outcome: '2026-10-18' } },
  { name: 'getHour reads the app-zone hour', script: 'input.Quantity = input.Stamp.getHour();', record: { Stamp: '18-Oct-2026 18:39:00' }, expect: { Quantity: '18' } },
  { name: 'zoho.currentdate is the app-zone calendar day (not UTC)', script: 'input.Outcome = zoho.currentdate.toString("yyyy-MM-dd");', expect: { Outcome: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()) } },
  { name: 'hours between two date-times in the same zone', script: 'input.Quantity = input.Stamp.hoursBetween(input.Stamp.addHour(5));', record: { Stamp: '18-Oct-2026 08:00:00' }, expect: { Quantity: '5' } },
]);

table('week and month boundaries', [
  { name: 'addMonth clamps Jan 31 to the last day of Feb', script: 'input.Outcome = input.Day.addMonth(1).toString("yyyy-MM-dd");', record: { Day: '31-Jan-2027' }, expect: { Outcome: '2027-02-28' } },
  { name: 'addMonth on Jan 31 of a leap year gives Feb 29', script: 'input.Outcome = input.Day.addMonth(1).toString("yyyy-MM-dd");', record: { Day: '31-Jan-2028' }, expect: { Outcome: '2028-02-29' } },
  { name: 'toStartOfMonth', script: 'input.Outcome = input.Day.toStartOfMonth().toString("yyyy-MM-dd");', record: { Day: '17-Oct-2026' }, expect: { Outcome: '2026-10-01' } },
  { name: 'eomonth(0) of February in a leap year', script: 'input.Outcome = input.Day.eomonth(0).toString("yyyy-MM-dd");', record: { Day: '10-Feb-2028' }, expect: { Outcome: '2028-02-29' } },
  { name: 'toStartOfWeek is the Sunday on or before the date', script: 'input.Outcome = input.Day.toStartOfWeek().toString("yyyy-MM-dd");', record: { Day: '17-Oct-2026' }, expect: { Outcome: '2026-10-11' } },
  { name: 'toStartOfWeek of a Sunday is that Sunday', script: 'input.Outcome = input.Day.toStartOfWeek().toString("yyyy-MM-dd");', record: { Day: '11-Oct-2026' }, expect: { Outcome: '2026-10-11' } },
  { name: 'getDayOfWeek is Sunday=1', script: 'input.Quantity = input.Day.getDayOfWeek();', record: { Day: '11-Oct-2026' }, expect: { Quantity: '1' } },
  { name: 'month-end rolls to the next year on addMonth(2) from Nov 30', script: 'input.Outcome = input.Day.addMonth(2).toString("yyyy-MM-dd");', record: { Day: '30-Nov-2026' }, expect: { Outcome: '2027-01-30' } },
  { name: 'getMonth is 1-based', script: 'input.Quantity = input.Day.getMonth();', record: { Day: '01-Jan-2027' }, expect: { Quantity: '1' } },
  { name: 'daysBetween across a month end', script: 'input.Quantity = input.Day.daysBetween(input.Day.addDay(31));', record: { Day: '31-Jan-2027' }, expect: { Quantity: '31' } },
]);

table('percent and currency formatting', [
  { name: 'percent of an amount, two places', script: 'input.Total = (input.Price * input.Rate / 100).round(2);', record: { Price: 250, Rate: 7.5 }, expect: { Total__n: '18.75' } },
  { name: 'percent as ratio: part / whole * 100 rounded', script: 'input.Total = (input.Qty / 8 * 100).round(1);', record: { Qty: 3 }, expect: { Total__n: '37.5' } },
  { name: 'discount: price - price * rate / 100', script: 'input.Total = input.Price - input.Price * input.Rate / 100;', record: { Price: 80, Rate: 12.5 }, expect: { Total__n: '70' } },
]);

table('multi-select criteria', [
  { name: 'contains on a multi-select field in a fetch criteria', script: 'Line[Kind == "x"].count();\nr = Item[Tags.contains("red")].count();\ninput.Quantity = r;', record: { Tags: ['red', 'blue'] }, expect: { Quantity: '1' } },
  { name: 'multi-select size', script: 'input.Quantity = input.Tags.size();', record: { Tags: ['red', 'green', 'blue'] }, expect: { Quantity: '3' } },
  { name: 'a multi-select in a loop keeps selection order', script: 'o = "";\nfor each t in input.Tags\n{\n\to = o + t + ",";\n}\ninput.Outcome = o;', record: { Tags: ['blue', 'red'] }, expect: { Outcome: 'blue,red,' } },
  { name: 'multi-select contains is case sensitive', script: 'if(input.Tags.contains("Red"))\n{\n\tinput.Outcome = "hit";\n}\nelse\n{\n\tinput.Outcome = "miss";\n}', record: { Tags: ['red'] }, expect: { Outcome: 'miss' } },
]);

table('subform totals with blanks', [
  { name: 'sum over lines treats a blank amount as zero', script: 't = 0;\nfor each l in Line[Kind == "a"]\n{\n\tt = t + ifnull(l.Amount, 0);\n}\ninput.Total = t;', lines: [{ Name: 'a', Kind: 'a', Amount: 10.5 }, { Name: 'b', Kind: 'a' }, { Name: 'c', Kind: 'a', Amount: 4.5 }], expect: { Total__n: '15' } },
  { name: 'count of lines includes blank-amount lines', script: 'input.Quantity = Line[Kind == "a"].count();', lines: [{ Name: 'a', Kind: 'a', Amount: 10 }, { Name: 'b', Kind: 'a' }], expect: { Quantity: '2' } },
  { name: 'sum() aggregate ignores blank amounts', script: 'input.Total = Line[Kind == "a"].sum(Amount);', lines: [{ Name: 'a', Kind: 'a', Amount: 10.25 }, { Name: 'b', Kind: 'a' }], expect: { Total__n: '10.25' } },
  { name: 'a blank amount compared to zero is not > 0', script: 'n = 0;\nfor each l in Line[Kind == "a"]\n{\n\tif(l.Amount > 0)\n\t{\n\t\tn = n + 1;\n\t}\n}\ninput.Quantity = n;', lines: [{ Name: 'a', Kind: 'a', Amount: 3 }, { Name: 'b', Kind: 'a' }], expect: { Quantity: '1' } },
]);

table('sort stability on equal keys', [
  { name: 'sort by an equal key keeps insertion order', script: 'o = "";\nfor each l in Line[Kind == "a"] sort by Amount\n{\n\to = o + l.Name;\n}\ninput.Outcome = o;', lines: [{ Name: 'p', Kind: 'a', Amount: 1 }, { Name: 'q', Kind: 'a', Amount: 1 }, { Name: 'r', Kind: 'a', Amount: 0 }, { Name: 's', Kind: 'a', Amount: 1 }], expect: { Outcome: 'rpqs' } },
  { name: 'descending sort keeps insertion order within equal keys', script: 'o = "";\nfor each l in Line[Kind == "a"] sort by Amount desc\n{\n\to = o + l.Name;\n}\ninput.Outcome = o;', lines: [{ Name: 'p', Kind: 'a', Amount: 1 }, { Name: 'q', Kind: 'a', Amount: 1 }, { Name: 'r', Kind: 'a', Amount: 2 }], expect: { Outcome: 'rpq' } },
  { name: 'sort on a text key is case-insensitive and stable', script: 'o = "";\nfor each l in Line[Kind == "a"] sort by Name\n{\n\to = o + l.Name;\n}\ninput.Outcome = o;', lines: [{ Name: 'b', Kind: 'a' }, { Name: 'A', Kind: 'a' }, { Name: 'a', Kind: 'a' }], expect: { Outcome: 'Aab' } },
]);

table('text search case and diacritics', [
  { name: 'contains in a criteria is case-insensitive', script: 'input.Quantity = Line[Name.contains("LPH")].count();', lines: [{ Name: 'Alpha', Kind: 'a' }], expect: { Quantity: '1' } },
  { name: 'a string .contains() on a value is case-sensitive', script: 'if(input.Title.contains("ALPHA"))\n{\n\tinput.Outcome = "hit";\n}\nelse\n{\n\tinput.Outcome = "miss";\n}', record: { Title: 'alpha' }, expect: { Outcome: 'miss' } },
  { name: 'criteria equality does not fold diacritics (cafe != café)', script: 'input.Quantity = Line[Name == "cafe"].count();', lines: [{ Name: 'café', Kind: 'a' }], expect: { Quantity: '0' } },
  { name: 'diacritic text round-trips through the store', script: 'input.Outcome = input.Title;', record: { Title: 'Zoë Ångström' }, expect: { Outcome: 'Zoë Ångström' } },
  { name: 'toUpperCase upper-cases a diacritic', script: 'input.Outcome = input.Title.toUpperCase();', record: { Title: 'café' }, expect: { Outcome: 'CAFÉ' } },
  { name: 'startsWith is case-sensitive', script: 'if(input.Title.startsWith("Al"))\n{\n\tinput.Outcome = "hit";\n}\nelse\n{\n\tinput.Outcome = "miss";\n}', record: { Title: 'alpha' }, expect: { Outcome: 'miss' } },
]);

table('decimal division precision', [
  { name: '1 / 3 keeps 4 places before the column scale', script: 'input.Outcome = (1.0 / 3).round(4).toString();', expect: { Outcome: '0.3333' } },
  { name: '10 / 4 is 2.5, not integer division', script: 'input.Total = input.Qty / 4;', record: { Qty: 10 }, expect: { Total__n: '2.5' } },
  { name: '2 / 3 rounds up at 2 places', script: 'input.Total = (input.Qty / 3).round(2);', record: { Qty: 2 }, expect: { Total__n: '0.67' } },
  { name: 'division then multiply does not drift (1/3*3)', script: 'input.Total = (input.Qty / 3 * 3).round(2);', record: { Qty: 1 }, expect: { Total__n: '1' } },
  { name: 'decimal / decimal', script: 'input.Total = input.Price / input.Rate;', record: { Price: 7.5, Rate: 2.5 }, expect: { Total__n: '3' } },
  { name: 'mod of whole numbers', script: 'input.Quantity = input.Qty % 7;', record: { Qty: 23 }, expect: { Quantity: '2' } },
]);

table('null vs empty string in criteria', [
  { name: 'a blank text field is null, not an empty string', script: 'if(input.Status == null)\n{\n\tinput.Outcome = "null";\n}\nelse\n{\n\tinput.Outcome = "set";\n}', expect: { Outcome: 'null' } },
  { name: 'an empty string compares equal to a blank field with isEmpty()', script: 'if(input.Status.isEmpty())\n{\n\tinput.Outcome = "empty";\n}', expect: { Outcome: 'empty' } },
  { name: 'criteria == null finds blank text', script: 'input.Quantity = Line[Kind == null].count();', lines: [{ Name: 'a' }, { Name: 'b', Kind: 'x' }], expect: { Quantity: '1' } },
  { name: 'criteria != null excludes blank text', script: 'input.Quantity = Line[Kind != null].count();', lines: [{ Name: 'a' }, { Name: 'b', Kind: 'x' }], expect: { Quantity: '1' } },
  { name: 'criteria == "" finds blank text', script: 'input.Quantity = Line[Kind == ""].count();', lines: [{ Name: 'a' }, { Name: 'b', Kind: 'x' }], expect: { Quantity: '1' } },
  { name: 'a zero amount is not null', script: 'input.Quantity = Line[Amount == null].count();', lines: [{ Name: 'a', Amount: 0 }, { Name: 'b' }], expect: { Quantity: '1' } },
]);

test('record ownership on edit: Added_User and Added_Time stay with the creator', async () => {
  const app = deriveIr(parse(ds('input.Outcome = "added";')));
  const backend = await startOfflineBackend(app);
  try {
    const golden = assertGolden({
      version: 'c2c-behavior-golden/2',
      app: 'rel5-sample',
      cases: [
        {
          id: 'edit',
          steps: [
            { op: 'submit', form: 'Item', record: { Title: 'Owned', Qty: 1 }, setup: true },
            { op: 'update', report: 'All_Items', where: { Title: 'Owned' }, record: { Qty: 5 }, expect: { body: { matched: 1, updated: 1, refused: 0 } } },
          ],
          expect: {},
        },
      ],
    });
    const { report } = await runBehavior(app, golden, backend, 'offline');
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    const [row] = await backend.tableRows('Item');
    assert.equal(row?.Qty, '5');
    assert.ok(row?.Added_User, JSON.stringify(row));
    assert.ok(String(row?.Added_Time) <= String(row?.Modified_Time), 'the edit is stamped no earlier than the add');
    assert.ok(row?.Modified_User, 'an edit stamps the editor');
    assert.equal(row?.Modified_User, row?.Added_User, 'one signed-in user added and edited');
  } finally {
    await backend.close();
  }
});

test('record ownership: the creator is the signed-in user on add, readable as input.Added_User', async () => {
  const row = await run('input.Outcome = zoho.loginuser;', {});
  assert.ok(row.Outcome, JSON.stringify(row));
  assert.equal(row.Outcome, row.Added_User);
});
