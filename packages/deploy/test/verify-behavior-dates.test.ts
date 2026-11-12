/**
 * Dates in verify-behavior: Creator writes `15-Oct-2026` and
 * `18-Oct-2026 18:39:00`; a Catalyst column reads back `2026-10-15` and
 * `2026-10-18 18:39:00`. The update-by-criteria row match and the value
 * comparison share one normal form: a calendar date is never shifted by a
 * zone, a date-time is wall-clock time in the app zone. A different day, a
 * different second, or a date against a date-time MUST still differ.
 * The results do not depend on the process zone (run under TZ=America/Los_Angeles and TZ=Asia/Kolkata).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { normalizeTemporal, temporalEqual } from '../src/temporal.js';
import { assertGolden, runBehavior, startOfflineBackend, textBoundaryEqual, whereMatches } from '../src/verify-behavior.js';

test('calendar dates: Creator and ISO text are the same day, with no zone conversion', () => {
  assert.deepEqual(normalizeTemporal('15-Oct-2026'), { kind: 'date', text: '2026-10-15' });
  assert.deepEqual(normalizeTemporal('5-oct-2026'), { kind: 'date', text: '2026-10-05' });
  for (const zone of [undefined, 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati']) {
    assert.equal(temporalEqual('15-Oct-2026', '2026-10-15', zone), true, String(zone));
  }
  // MUST-FAIL: another day, a date against a date-time, an impossible date, plain text.
  assert.equal(temporalEqual('15-Oct-2026', '2026-10-16'), false);
  assert.equal(temporalEqual('15-Oct-2026', '2026-10-15 00:00:00'), false);
  assert.equal(normalizeTemporal('31-Feb-2026'), undefined);
  assert.equal(normalizeTemporal('2026-13-01'), undefined);
  assert.equal(temporalEqual('Oct 15', 'Oct 15'), false);
  assert.equal(temporalEqual(20261015, '2026-10-15'), false);
});

test('date-times: wall-clock text compares as given; an instant is shown in the app zone', () => {
  assert.equal(temporalEqual('18-Oct-2026 18:39:00', '2026-10-18 18:39:00'), true);
  assert.equal(temporalEqual('18-Oct-2026 18:39', '2026-10-18T18:39:00'), true);
  assert.equal(temporalEqual('2026-10-18 18:39:00:000', '18-Oct-2026 18:39:00'), true);
  // 13:09 UTC is 18:39 in Kolkata and 06:09 in Los Angeles.
  assert.equal(temporalEqual('2026-10-18T13:09:00Z', '18-Oct-2026 18:39:00', 'Asia/Kolkata'), true);
  assert.equal(temporalEqual('2026-10-18T13:09:00Z', '18-Oct-2026 06:09:00', 'America/Los_Angeles'), true);
  assert.equal(temporalEqual('2026-10-18T18:39:00+05:30', '2026-10-18 18:39:00', 'Asia/Kolkata'), true);
  // MUST-FAIL: another second, another millisecond, another zone, no zone for an instant.
  assert.equal(temporalEqual('18-Oct-2026 18:39:00', '2026-10-18 18:39:01'), false);
  assert.equal(temporalEqual('2026-10-18 18:39:00.500', '2026-10-18 18:39:00'), false);
  assert.equal(temporalEqual('2026-10-18T13:09:00Z', '18-Oct-2026 18:39:00', 'America/Los_Angeles'), false);
  // 13:09 UTC is 13:09 in UTC: these would match under a zone fallback, so a
  // missing or invalid zone MUST fail rather than fall back to UTC.
  assert.equal(temporalEqual('2026-10-18T13:09:00Z', '2026-10-18 13:09:00'), false);
  assert.equal(temporalEqual('2026-10-18T13:09:00Z', '2026-10-18 13:09:00', 'Not/AZone'), false);
  assert.equal(normalizeTemporal('18-Oct-2026 24:00:00'), undefined);
});

test('the comparison and the criteria match use the same normal form', () => {
  assert.equal(textBoundaryEqual('2026-10-18 18:39:00', '18-Oct-2026 18:39:00'), true);
  assert.equal(textBoundaryEqual('2026-10-18T13:09:00Z', '2026-10-18 18:39:00', 'Asia/Kolkata'), true);
  assert.equal(whereMatches({ Day: '2026-10-15' }, { Day: '15-Oct-2026' }), true);
  assert.equal(whereMatches({ Day: '2026-10-15', Title: 'a' }, { Day: '15-Oct-2026', Title: 'a' }), true);
  // MUST-FAIL: strings that are not dates stay strict; a different day does not match.
  assert.equal(textBoundaryEqual('2026-10-18 18:39:00', '18-Oct-2026 18:39:30'), false);
  assert.equal(textBoundaryEqual('abc', 'ABC'), false);
  assert.equal(whereMatches({ Day: '2026-10-15' }, { Day: '16-Oct-2026' }), false);
  assert.equal(whereMatches({ Day: '2026-10-15 00:00:00' }, { Day: '15-Oct-2026' }), false);
});

const DATE_DS = `application "date-sample"
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
\t\tform Visit
\t\t{
\t\t\tmust have Title
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tDay
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tSeen
\t\t\t(
\t\t\t\ttype = datetime
\t\t\t)
\t\t\tQty
\t\t\t(
\t\t\t\ttype = number
\t\t\t)
\t\t}
\t\tlist All_Visits
\t\t{
\t\t\tshow all rows from Visit
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRules as "Rules"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Visit
\t\t\t\trecord event = on add
\t\t\t\tfield rules
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\thide Seen;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

async function replayDates(cases: unknown[]) {
  const app = deriveIr(parse(DATE_DS));
  const golden = assertGolden({ version: 'c2c-behavior-golden/2', app: 'date-sample', cases });
  const backend = await startOfflineBackend(app);
  try {
    return (await runBehavior(app, golden, backend, 'offline')).report;
  } finally {
    await backend.close();
  }
}

const ADD_VISIT = { op: 'submit', form: 'Visit', record: { Title: 'Kestrel', Day: '15-Oct-2026', Qty: 1 }, expect: { outcome: 'saved' } };

test('update-by-criteria matches a Creator date against the stored ISO date', async () => {
  const update = (day: string) => ({ op: 'update', report: 'All_Visits', where: { Day: day }, record: { Qty: 5 }, expect: { body: { matched: 1, updated: 1, refused: 0 } } });
  const ok = await replayDates([{ id: 'update-qty', steps: [ADD_VISIT, update('15-Oct-2026')], expect: { partial: true, tables: { Visit: [{ Day: '2026-10-15', Qty: 5 }] } } }]);
  assert.equal(ok.ok, true, JSON.stringify(ok.findings));
  // MUST-FAIL: another day matches no row, and the table keeps the old value.
  const miss = await replayDates([{ id: 'update-qty', steps: [ADD_VISIT, update('16-Oct-2026')], expect: { partial: true, tables: { Visit: [{ Day: '2026-10-15', Qty: 5 }] } } }]);
  assert.equal(miss.ok, false);
  assert.ok(miss.findings.some((f) => f.pointer === 'body.matched' && f.expected === 1 && f.actual === 0), JSON.stringify(miss.findings));
  assert.ok(miss.findings.some((f) => f.pointer === 'tables.Visit[0].Qty'), JSON.stringify(miss.findings));
});

test('an api-only date-time the client sent is not compared in any text form; another value still is', async () => {
  const captured = (seen: string) => ({
    op: 'submit',
    form: 'Visit',
    record: { Title: 'Kestrel', Day: '15-Oct-2026', Seen: seen },
    creator: { code: 3000 },
    expect: { outcome: 'saved' },
    tags: ['api-only-acceptance'],
    apiOnly: ['Seen'],
  });
  const ok = await replayDates([{ id: 'add-visit', steps: [captured('18-Oct-2026 18:39:00')], expect: { partial: true, tables: { Visit: [{ Title: 'Kestrel', Day: '2026-10-15', Seen: '2026-10-18 18:39:00' }] } } }]);
  assert.equal(ok.ok, true, JSON.stringify(ok.findings));
  assert.equal(ok.summary.equivalentByDesign, 1);
  // MUST-FAIL: Creator stored a different second than the client sent, so the column is compared.
  const other = await replayDates([{ id: 'add-visit', steps: [captured('18-Oct-2026 18:39:00')], expect: { partial: true, tables: { Visit: [{ Title: 'Kestrel', Seen: '2026-10-18 18:40:00' }] } } }]);
  assert.equal(other.ok, false);
  assert.ok(other.findings.some((f) => f.pointer === 'tables.Visit[0].Seen' || f.pointer === 'tables.Visit[0]'), JSON.stringify(other.findings));
});
