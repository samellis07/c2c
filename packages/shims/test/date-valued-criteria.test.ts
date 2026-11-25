import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DelugeDate } from '../src/date.js';
import { compileCriteria, matchRow, type Criteria } from '../src/criteria.js';

const WHEN = new DelugeDate(2026, 11, 24, 15, 53, 5);

// A date a script computed (`zoho.currenttime.subDay(1)`) reaches the criteria as a value, not as a relative marker.
test('a computed date or time compares by the stored text, not by its JSON form', () => {
  const cases: [Criteria, string][] = [
    [{ op: '>=', field: 'Added_Time', value: WHEN }, "Added_Time >= '2026-11-24 15:53:05'"],
    [{ op: '<=', field: 'Added_Time', value: WHEN }, "Added_Time <= '2026-11-24 15:53:05'"],
    [{ op: '==', field: 'Added_Time', value: WHEN }, "Added_Time = '2026-11-24 15:53:05'"],
    [{ op: 'in', field: 'Added_Time', value: [WHEN, new DelugeDate(2026, 11, 25)] }, "Added_Time IN ('2026-11-24 15:53:05', '2026-11-25 00:00:00')"],
  ];
  for (const [criteria, where] of cases) assert.equal(compileCriteria(criteria), where);
});

test('a computed date bound keeps the rows after it and drops the rows before it', () => {
  const after: Criteria = { op: '>=', field: 'Added_Time', value: WHEN };
  assert.equal(matchRow({ Added_Time: '2026-11-25 09:00:00' }, after), true);
  assert.equal(matchRow({ Added_Time: '2026-11-23 09:00:00' }, after), false);
});
