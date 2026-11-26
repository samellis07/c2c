/**
 * Behaviour differential for gallery-shaped Deluge built-ins: the Creator rule
 * is the expectation, the generated function (offline harness) is the actual.
 * Every construct below is lifted from fixtures/redistributable: `ETA.addDay(n)`,
 * `volume.round(2)`, `qty * price * rate.toNumber() / 100`, list/map `add`/`put`/
 * `get`/`size`/`toList`, and string built-ins on stored text. The scripts run
 * as a form-workflow on success (`/forms/<form>/success`), so the assertion is
 * the stored row. Cases marked skip are real bugs, see the card NOTES.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { assertGolden, runBehavior, startOfflineBackend } from '../src/verify-behavior.js';

const FIELDS = `\t\t\tmust have Title
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tETA
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tFree_Days
\t\t\t(
\t\t\t\ttype = number
\t\t\t)
\t\t\tValid_Till
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tDays_Late
\t\t\t(
\t\t\t\ttype = number
\t\t\t)
\t\t\tVolume
\t\t\t(
\t\t\t\ttype = decimal
\t\t\t)
\t\t\tRounded
\t\t\t(
\t\t\t\ttype = decimal
\t\t\t)
\t\t\tQuantity
\t\t\t(
\t\t\t\ttype = number
\t\t\t)
\t\t\tList_Price
\t\t\t(
\t\t\t\ttype = decimal
\t\t\t)
\t\t\tTax_Rate
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tTax
\t\t\t(
\t\t\t\ttype = decimal
\t\t\t)
\t\t\tTotal
\t\t\t(
\t\t\t\ttype = decimal
\t\t\t)
\t\t\tResult
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
`;

function ds(script: string): string {
  const body = script.split('\n').map((line) => `\t\t\t\t\t\t\t${line}`).join('\n');
  return `application "builtins-sample"
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
\t\tform Shipment
\t\t{
${FIELDS}\t\t}
\t\tlist All_Shipments
\t\t{
\t\t\tshow all rows from Shipment
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tCompute as "Compute"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Shipment
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

/** Submit one record through the generated API, run the on-success script, return the stored row. */
async function run(script: string, record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const app = deriveIr(parse(ds(script)));
  const backend = await startOfflineBackend(app);
  try {
    await backend.reset?.();
    const reply = await backend.call('POST', '/forms/Shipment/success', { record: { Title: 'T', ...record } });
    assert.equal(reply.status, 200, JSON.stringify(reply));
    return (await backend.tableRows('Shipment'))[0] ?? {};
  } finally {
    await backend.close();
  }
}

interface Case {
  name: string;
  script: string;
  record?: Record<string, unknown>;
  /** Stored columns after the script; Catalyst stores numbers as text. */
  expect: Record<string, unknown>;
  /** A failing case is a real bug: skipped with the exact Creator rule. */
  skip?: string;
}

function table(group: string, cases: Case[]): void {
  for (const c of cases) {
    test(`${group}: ${c.name}`, { skip: c.skip }, async () => {
      const row = await run(c.script, c.record ?? {});
      for (const [column, want] of Object.entries(c.expect)) assert.equal(row[column], want, `${column} in ${JSON.stringify(row)}`);
    });
  }
}

const VALID = 'input.Valid_Till = input.ETA.addDay(input.Free_Days);';

table('date arithmetic', [
  { name: 'addDay rolls the month (freight DO_Valid_Till_Date)', script: VALID, record: { ETA: '15-Oct-2026', Free_Days: 30 }, expect: { Valid_Till: '2026-11-14' } },
  { name: 'addDay rolls the year', script: VALID, record: { ETA: '31-Dec-2026', Free_Days: 1 }, expect: { Valid_Till: '2027-01-01' } },
  { name: 'addDay honours a leap day', script: VALID, record: { ETA: '28-Feb-2028', Free_Days: 1 }, expect: { Valid_Till: '2028-02-29' } },
  { name: 'addDay skips Feb 29 in a common year', script: VALID, record: { ETA: '28-Feb-2027', Free_Days: 1 }, expect: { Valid_Till: '2027-03-01' } },
  { name: 'addDay(0) is the same day', script: VALID, record: { ETA: '15-Oct-2026', Free_Days: 0 }, expect: { Valid_Till: '2026-10-15' } },
  { name: 'addDay with a negative count goes back', script: VALID, record: { ETA: '03-Mar-2026', Free_Days: -5 }, expect: { Valid_Till: '2026-02-26' } },
  { name: 'addDay is not shifted by DST in the app zone', script: VALID, record: { ETA: '28-Mar-2026', Free_Days: 2 }, expect: { Valid_Till: '2026-03-30' } },
  { name: 'getYear of a stored date', script: 'input.Days_Late = input.ETA.getYear();', record: { ETA: '15-Oct-2026' }, expect: { Days_Late: '2026' } },
  { name: 'date minus date is epoch milliseconds, not days (library overdueDays reads it as days)', script: 'input.Days_Late = input.Valid_Till.toDate() - input.ETA.toDate();', record: { ETA: '15-Oct-2026', Valid_Till: '14-Nov-2026' }, expect: { Days_Late: '2592000000' } },
  { name: 'date minus date across a leap-year month end is 2 days of milliseconds', script: 'input.Days_Late = input.Valid_Till.toDate() - input.ETA.toDate();', record: { ETA: '28-Feb-2028', Valid_Till: '01-Mar-2028' }, expect: { Days_Late: '172800000' } },
]);

table('decimal rounding and currency', [
  { name: 'round(2) is half up (2.675 -> 2.68, not the binary 2.67)', script: 'input.Rounded = input.Volume.round(2);', record: { Volume: 2.675 }, expect: { Rounded: '2.68' } },
  { name: 'round(2) of 0.125 -> 0.13', script: 'input.Rounded = input.Volume.round(2);', record: { Volume: 0.125 }, expect: { Rounded: '0.13' } },
  { name: 'round(2) of the decimal literal 1.005 -> 1.01', script: 'x = 1.005;\ninput.Rounded = x.round(2);', expect: { Rounded: '1.01' } },
  { name: 'round(2) of the decimal literal 1.255 -> 1.26', script: 'x = 1.255;\ninput.Rounded = x.round(2);', expect: { Rounded: '1.26' } },
  { name: 'round(2) of the decimal literal 8.345 -> 8.35', script: 'x = 8.345;\ninput.Rounded = x.round(2);', expect: { Rounded: '8.35' } },
  { name: 'round(0) of a negative half goes away from zero', script: 'input.Rounded = input.Volume.round(0);', record: { Volume: -2.5 }, expect: { Rounded: '-3' } },
  { name: 'round(2) keeps a value already at scale', script: 'input.Rounded = input.Volume.round(2);', record: { Volume: 12.34 }, expect: { Rounded: '12.34' } },
  { name: 'freight volume: (l*w*h)/3000*packages then round(2)', script: 'v = (input.Quantity * 50 * 40) / 3000 * 3;\ninput.Rounded = v.round(2);', record: { Quantity: 7 }, expect: { Rounded: '14' } },
  { name: 'line total: qty * price + tax% (Tax_Rate text .toNumber())', script: 'tax = (input.Quantity * input.List_Price * input.Tax_Rate.toNumber()) / 100;\ninput.Tax = tax;\ninput.Total = input.Quantity * input.List_Price + tax;', record: { Quantity: 3, List_Price: 19.99, Tax_Rate: '18' }, expect: { Tax: '10.79', Total: '70.76' } },
  { name: 'toNumber truncates a decimal text toward zero (12.5 -> 12)', script: 'input.Total = input.Tax_Rate.toNumber() * 2;', record: { Tax_Rate: '12.5' }, expect: { Total: '24' } },
  { name: 'decimal sum has no binary drift (0.1 + 0.2)', script: 'input.Total = 0.1 + 0.2;', expect: { Total: '0.3' } },
]);

table('list and map built-ins', [
  { name: 'list add and size', script: 'l = List();\nl.add("a");\nl.add("b");\ninput.Quantity = l.size();', expect: { Quantity: '2' } },
  { name: 'list get is zero-based', script: 'l = {"x","y","z"};\ninput.Outcome = l.get(0) + l.get(2);', expect: { Outcome: 'xz' } },
  { name: 'toList(",") splits on the separator (fetch_CT.toList())', script: 'l = "a,b,c".toList(",");\ninput.Quantity = l.size();\ninput.Outcome = l.get(1);', expect: { Quantity: '3', Outcome: 'b' } },
  { name: 'toList keeps order and does not trim', script: 'l = "one,two".toList(",");\ninput.Outcome = l.get(0) + "|" + l.get(1);', expect: { Outcome: 'one|two' } },
  { name: 'list contains', script: 'l = {"a","b"};\nif(l.contains("b"))\n{\n\tinput.Outcome = "yes";\n}', expect: { Outcome: 'yes' } },
  { name: 'map put and get', script: 'm = Map();\nm.put("k", "v");\ninput.Outcome = m.get("k");', expect: { Outcome: 'v' } },
  { name: 'map put overwrites and size counts keys', script: 'm = Map();\nm.put("k", 1);\nm.put("k", 2);\nm.put("j", 3);\ninput.Quantity = m.size();\ninput.Total = m.get("k");', expect: { Quantity: '2', Total: '2' } },
  { name: 'map get of a missing key is null', script: 'm = Map();\nif(m.get("nope") == null)\n{\n\tinput.Outcome = "null";\n}', expect: { Outcome: 'null' } },
  { name: 'toMap of JSON text (dic.toMap())', script: 'm = "{\\"n\\":\\"A\\"}".toMap();\ninput.Outcome = m.get("n");', expect: { Outcome: 'A' } },
  { name: 'list of numbers sums in a loop', script: 'l = {1,2,3};\nt = 0;\nfor each n in l\n{\n\tt = t + n;\n}\ninput.Quantity = t;', expect: { Quantity: '6' } },
]);

table('string built-ins', [
  { name: 'toUpperCase / toLowerCase', script: 'input.Outcome = input.Title.toUpperCase() + input.Title.toLowerCase();', record: { Title: 'Ab' }, expect: { Outcome: 'ABab' } },
  { name: 'trim', script: 'input.Outcome = input.Title.trim();', record: { Title: '  pad  ' }, expect: { Outcome: 'pad' } },
  { name: 'length', script: 'input.Quantity = input.Title.length();', record: { Title: 'Kestrel' }, expect: { Quantity: '7' } },
  { name: 'subString(start,end) end-exclusive', script: 'input.Outcome = input.Title.subString(1, 4);', record: { Title: 'Kestrel' }, expect: { Outcome: 'est' } },
  { name: 'indexOf and missing -> -1', script: 'input.Quantity = input.Title.indexOf("tr");\ninput.Total = input.Title.indexOf("zz");', record: { Title: 'Kestrel' }, expect: { Quantity: '3', Total: '-1' } },
  { name: 'contains', script: 'if(input.Title.contains("str"))\n{\n\tinput.Outcome = "has";\n}', record: { Title: 'Kestrel' }, expect: { Outcome: 'has' } },
  { name: 'replaceAll', script: 'input.Outcome = input.Title.replaceAll("a", "4");', record: { Title: 'banana' }, expect: { Outcome: 'b4n4n4' } },
  { name: 'concatenation with a number', script: 'input.Outcome = input.Title + 5;', record: { Title: 'ID-' }, expect: { Outcome: 'ID-5' } },
  { name: 'startsWith / endsWith', script: 'if(input.Title.startsWith("Ke") && input.Title.endsWith("el"))\n{\n\tinput.Outcome = "both";\n}', record: { Title: 'Kestrel' }, expect: { Outcome: 'both' } },
  { name: 'toString of a whole number has no decimals', script: 'input.Outcome = input.Quantity.toString();', record: { Quantity: 12 }, expect: { Outcome: '12' } },
]);

