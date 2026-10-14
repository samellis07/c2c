import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimeZoneRequired } from '../src/date.js';
import { UntranslatedConstruct } from '../src/errors.js';
import {
  bindRelativeCriteria,
  compileCriteria,
  criteriaHasRelative,
  matchRow,
  sealRelativeCriteria,
  type Criteria,
} from '../src/criteria.js';
import { reportCriteria } from '../../deluge/src/translate.js';

const ZONE = 'Asia/Kolkata';
const NEAR_MIDNIGHT = new Date('2026-10-11T18:45:00.000Z');
const WEEK_START = new Date('2026-10-10T18:45:00.000Z');
const MONTH_START = new Date('2026-09-30T18:45:00.000Z');

function bound(src: string, instant: Date, kinds: Record<string, 'date' | 'datetime'> = {}): Criteria {
  return bindRelativeCriteria(reportCriteria(src), instant, ZONE, kinds);
}

function where(criteria: Criteria): string {
  return compileCriteria(criteria);
}

test('relative report criteria bind to half-open windows in the application zone', () => {
  const today = bound('Added_Time == today', NEAR_MIDNIGHT);
  assert.equal(where(today), "(Added_Time >= '2026-10-12 00:00:00' AND Added_Time < '2026-10-13 00:00:00')");
  assert.equal(matchRow({ Added_Time: '2026-10-12 00:05:00' }, today), true);
  assert.equal(matchRow({ Added_Time: '2026-10-11 23:30:00' }, today), false);
  assert.equal(matchRow({ Added_Time: '12-Oct-2026 00:05:00' }, today), true);
  assert.equal(matchRow({ Added_Time: '' }, today), false);
  assert.equal(matchRow({}, today), false);

  const week = bound('Added_Time in this week', WEEK_START);
  assert.equal(where(week), "(Added_Time >= '2026-10-11 00:00:00' AND Added_Time < '2026-10-18 00:00:00')");
  assert.equal(matchRow({ Added_Time: '2026-10-10 23:30:00' }, week), false);
  assert.equal(matchRow({ Added_Time: '11-Oct-2026 00:05:00' }, week), true);
  assert.equal(matchRow({ Added_Time: '2026-10-18 00:00:00' }, week), false);

  const month = bound('Added_Time in this month', MONTH_START);
  assert.equal(where(month), "(Added_Time >= '2026-10-01 00:00:00' AND Added_Time < '2026-11-01 00:00:00')");
  assert.equal(matchRow({ Added_Time: '2026-09-30 23:50:00' }, month), false);
  assert.equal(matchRow({ Added_Time: '2026-10-01 00:05:00' }, month), true);

  const year = bound('Date_field in this year', MONTH_START, { Date_field: 'date' });
  assert.equal(where(year), "(Date_field >= '2026-01-01' AND Date_field < '2027-01-01')");

  const afterMidnight = bound('Check_In > zoho.currentdate', NEAR_MIDNIGHT, { Check_In: 'date' });
  assert.equal(where(afterMidnight), "Check_In > '2026-10-12'");
  const beforeToday = bound('Check_In < zoho.currentdate', NEAR_MIDNIGHT, { Check_In: 'date' });
  assert.equal(where(beforeToday), "Check_In < '2026-10-12'");

  const due = bound('Due_Time < zoho.currenttime', NEAR_MIDNIGHT);
  assert.equal(where(due), "Due_Time < '2026-10-12 00:15:00'");
  const past = bound('Due_Time < now', NEAR_MIDNIGHT);
  assert.equal(where(past), "Due_Time < '2026-10-12 00:15:00'");

  const lastWeek = bound('Added_Time in last week', WEEK_START);
  assert.equal(where(lastWeek), "(Added_Time >= '2026-10-04 00:00:00' AND Added_Time < '2026-10-11 00:00:00')");
  const lastWeeks = bound('Added_Time in last 1 weeks', WEEK_START);
  assert.equal(where(lastWeeks), where(lastWeek));
  const nextWeek = bound('Added_Time in next week', WEEK_START);
  assert.equal(where(nextWeek), "(Added_Time >= '2026-10-18 00:00:00' AND Added_Time < '2026-10-25 00:00:00')");

  const lastDays = bound('Added_Time in last 7 days', NEAR_MIDNIGHT);
  assert.equal(where(lastDays), "(Added_Time >= '2026-10-05 00:00:00' AND Added_Time < '2026-10-12 00:00:00')");
  assert.equal(matchRow({ Added_Time: '2026-10-12 00:05:00' }, lastDays), false);
  assert.equal(matchRow({ Added_Time: '2026-10-11 23:30:00' }, lastDays), true);

  const nextDays = bound('Added_Time in next 2 days', NEAR_MIDNIGHT);
  assert.equal(where(nextDays), "(Added_Time >= '2026-10-13 00:00:00' AND Added_Time < '2026-10-15 00:00:00')");
  const ago = bound('Added_Time in 3 days ago', NEAR_MIDNIGHT);
  assert.equal(where(ago), "(Added_Time >= '2026-10-09 00:00:00' AND Added_Time < '2026-10-10 00:00:00')");

  const lastMonths = bound('Close_Date in last 2 months', MONTH_START, { Close_Date: 'date' });
  assert.equal(where(lastMonths), "(Close_Date >= '2026-08-01' AND Close_Date < '2026-10-01')");
});

test('Field is this week, this month, and today use the same half-open window', () => {
  const week = bound('Added_Time is this week', WEEK_START);
  assert.equal(where(week), where(bound('Added_Time in this week', WEEK_START)));
  assert.equal(matchRow({ Added_Time: '2026-10-11 00:00:00' }, week), true);
  assert.equal(matchRow({ Added_Time: '2026-10-10 23:59:59' }, week), false);
  assert.equal(matchRow({ Added_Time: '2026-10-17 23:59:59' }, week), true);
  assert.equal(matchRow({ Added_Time: '2026-10-18 00:00:00' }, week), false);
  const outside = bound('Added_Time is this week', new Date('2026-10-10T18:29:00.000Z'));
  assert.equal(matchRow({ Added_Time: '2026-10-10 23:30:00' }, outside), true);
  assert.equal(matchRow({ Added_Time: '2026-10-11 00:05:00' }, outside), false);

  const month = bound('Due is this month', MONTH_START, { Due: 'date' });
  assert.equal(where(month), "(Due >= '2026-10-01' AND Due < '2026-11-01')");
  assert.equal(matchRow({ Due: '2026-10-01' }, month), true);
  assert.equal(matchRow({ Due: '2026-09-30' }, month), false);
  assert.equal(matchRow({ Due: '2026-11-01' }, month), false);

  const today = bound('Added_Time is today', NEAR_MIDNIGHT);
  assert.equal(where(today), where(bound('Added_Time == today', NEAR_MIDNIGHT)));
  assert.equal(matchRow({ Added_Time: '2026-10-12 00:00:00' }, today), true);
  assert.equal(matchRow({ Added_Time: '2026-10-11 23:59:59' }, today), false);
  assert.equal(matchRow({ Added_Time: '2026-10-13 00:00:00' }, today), false);

  const excluded = bound('Added_Time is not this week', WEEK_START);
  assert.equal(matchRow({ Added_Time: '2026-10-11 00:05:00' }, excluded), false);
  assert.equal(matchRow({ Added_Time: '2026-10-10 23:30:00' }, excluded), true);
  assert.equal(matchRow({ Added_Time: '2026-10-18 00:00:00' }, excluded), true);
});

test('a date column compared with now uses the calendar day, not a datetime literal', () => {
  const kinds = { Due: 'date' as const };
  const criteria = reportCriteria('Due < now');
  const after = bindRelativeCriteria(criteria, NEAR_MIDNIGHT, ZONE, kinds);
  assert.equal(where(after), "Due <= '2026-10-12'");
  const midnight = bindRelativeCriteria(criteria, new Date('2026-10-11T18:30:00.000Z'), ZONE, kinds);
  assert.equal(where(midnight), "Due < '2026-10-12'");
  const same = bindRelativeCriteria(reportCriteria('Due == now'), NEAR_MIDNIGHT, ZONE, kinds);
  assert.equal(matchRow({ Due: '2026-10-12' }, same), false);
  assert.equal(matchRow({ Due: '2026-10-11' }, same), false);
});

test('relative markers keep login binds, date order, and fail closed without a zone', () => {
  const mixed = reportCriteria('Attendance_Date is today && Added_User == zoho.loginuser');
  assert.equal(criteriaHasRelative(mixed), true);
  const kept = bindRelativeCriteria(mixed, NEAR_MIDNIGHT, ZONE, { Attendance_Date: 'date' });
  assert.equal(criteriaHasRelative(kept), false);
  assert.equal(JSON.stringify(kept).includes('__bind'), true);
  assert.match(where(kept), /Attendance_Date >= '2026-10-12'/);
  assert.match(where(kept), /Added_User = '\{"__bind":"loginUser"\}'/);

  assert.equal(matchRow({ Due: '11-Oct-2026' }, { op: '>', field: 'Due', value: '09-Oct-2026' }), true);
  assert.equal(matchRow({ Status: 'Open' }, { op: '<', field: 'Status', value: 'Closed' }), false);
  assert.equal(matchRow({ Qty: 10 }, { op: '>', field: 'Qty', value: 9 }), true);

  const open = reportCriteria('Status == "Open" && Due < zoho.currentdate');
  const sealed = sealRelativeCriteria(open);
  assert.equal(sealed.op, 'and');
  if (sealed.op === 'and') {
    assert.deepEqual(sealed.args[0], { op: '==', field: 'Status', value: 'Open' });
    assert.deepEqual(sealed.args[1], { op: 'todo', construct: 'criteria-dynamic' });
  }
  assert.deepEqual(sealRelativeCriteria(reportCriteria('Due is today')), { op: 'todo', construct: 'criteria-dynamic' });

  assert.throws(() => bindRelativeCriteria(reportCriteria('Added_Time == today'), NEAR_MIDNIGHT, ''), TimeZoneRequired);
  assert.throws(() => bindRelativeCriteria(reportCriteria('Added_Time == today'), NEAR_MIDNIGHT, 'Not/AZone'), RangeError);
  assert.throws(() => compileCriteria(reportCriteria('Added_Time == today')), UntranslatedConstruct);
  assert.equal(reportCriteria('Added_Time > this week').op, 'todo');
  assert.equal(reportCriteria('Added_Time in last 0 days').op, 'todo');
  assert.equal(reportCriteria('Lookup.Field').op, 'todo');
  assert.equal(reportCriteria('1 is this week').op, 'todo');
  assert.equal(reportCriteria('Due_Time in zoho.currenttime').op, 'todo');

  const dotted = reportCriteria('Book_For.From < zoho.currentdate || Book_For.From == zoho.currentdate');
  assert.equal(dotted.op, 'or');
  assert.equal(criteriaHasRelative(dotted), true);
});
