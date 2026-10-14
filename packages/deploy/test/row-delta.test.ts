import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDeltaPlan, type DeltaPlan } from '../src/row-delta.js';
import type { CsvLoad } from '../src/csv.js';

const loaded = {} as CsvLoad;
const plan: DeltaPlan = {
  baseline: true,
  tables: [{ table: 'Item', added: [{ id: '1', columns: { Name: 'Bolt' } }], changed: [], unchanged: 0, changedWithoutNewerTime: 0, deleted: [], missing: false }],
  next: { version: 1, source: 'json', tables: { Item: { rows: { '1': 'fingerprint' } } } },
};
const options = { source: 'json', applyDeletes: false, scope: [], loaded };

test('sync-delta plan-only output stays byte-identical and says writes: no', () => {
  assert.equal(
    formatDeltaPlan(plan, options),
    'c2c sync-delta plan v1\n' +
      'source: json\n' +
      'checkpoint: none (first run: every record is new; existing rows are matched by source id)\n' +
      '\n' +
      'tables:\n' +
      '- Item new 1 changed 0 unchanged 0 deleted 0\n' +
      '\n' +
      'upserts: 1\n' +
      'deletions: 0 (reported only; pass --apply-deletes to delete them)\n' +
      'writes: no\n' +
      '\n',
  );
});

test('sync-delta confirmed plan announces its planned writes', () => {
  const output = formatDeltaPlan(plan, { ...options, confirm: true });
  assert.match(output, /writes: yes \(1 planned upserts\)/);
  assert.doesNotMatch(output, /writes: no/);
});
