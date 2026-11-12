import assert from 'node:assert/strict';
import { test } from 'node:test';
import rankFile from '../data/desk-aggregate-rank.json' with { type: 'json' };
import { deskBands, rankFeatureApps, rankMatrix } from '../src/desk-queue.js';
import { FEATURE_MATRIX } from '../src/feature-matrix.js';

const BAND_ORDER = [
  'form-workflow-scripting',
  'pages',
  'notifications-email-sms',
  'mobile-pwa-offline',
  'portals-permissions',
  'custom-api',
  'actions',
  'environments',
  'backup-export',
  'pdf-record-templates',
  'schedules-cron',
  'other',
] as const;

test('desk bands follow the aggregate order', () => {
  assert.deepEqual(
    deskBands().map((band) => band.id),
    [...BAND_ORDER],
  );
  assert.equal(rankFile.schema, 'c2c-desk-aggregate-rank/1');
});

test('every matrix row is in exactly one band', () => {
  const assigned = rankFile.rowBand as Record<string, string>;
  const ids = FEATURE_MATRIX.map((row) => String(row.id));
  assert.deepEqual(Object.keys(assigned).sort((a, b) => Number(a) - Number(b)), ids);
  for (const bandId of Object.values(assigned)) assert.ok(BAND_ORDER.includes(bandId as (typeof BAND_ORDER)[number]));
  const ranked = rankMatrix();
  assert.equal(ranked.length, FEATURE_MATRIX.length);
  assert.deepEqual(
    ranked.map((row) => row.id).sort((a, b) => a - b),
    FEATURE_MATRIX.map((row) => row.id),
  );
});

test('named themes outrank later bands, and a field type stays last', () => {
  const at = new Map(rankMatrix().map((row, index) => [row.id, index]));
  const order = [89, 137, 119, 154, 146, 136, 77, 157, 161, 164, 94, 1];
  for (let i = 1; i < order.length; i++) {
    const earlier = order[i - 1];
    const later = order[i];
    assert.ok(at.get(earlier)! < at.get(later)!, `${earlier} should rank before ${later}`);
  }
});

test('feature-app queue is the unfinished rows in the same order', () => {
  const matrix = rankMatrix();
  const apps = rankFeatureApps();
  const expected = matrix.filter((row) => row.status === 'not-started' || row.status === 'adapter-written');
  assert.deepEqual(
    apps.map((row) => row.id),
    expected.map((row) => row.id),
  );
  assert.equal(apps.some((row) => row.status === 'built-in-Creator' || row.status === 'not a Creator feature'), false);
  assert.equal(apps[0].id, 87);
  assert.notEqual(apps[0].id, 173);
  const schedule = apps.filter((row) => row.band === 'schedules-cron');
  const dateField = schedule.find((row) => row.id === 94);
  const fixed = schedule.find((row) => row.id === 95);
  assert.ok(dateField && fixed);
  assert.ok(apps.indexOf(dateField) < apps.indexOf(fixed));
  assert.ok(apps.findIndex((row) => row.id === 94) < apps.findIndex((row) => row.id === 173));
});

test('schedule, portal, mail, and backup rows keep their themes', () => {
  const band = new Map(rankMatrix().map((row) => [row.id, row.band]));
  for (const id of [94, 95, 96, 97, 98, 99, 101, 169]) assert.equal(band.get(id), 'schedules-cron');
  for (const id of [53, 129, 143, 144, 145, 146, 147, 148, 149, 150, 151, 182, 185]) {
    assert.equal(band.get(id), 'portals-permissions');
  }
  for (const id of [119, 120, 121, 168]) assert.equal(band.get(id), 'notifications-email-sms');
  for (const id of [79, 81, 161, 162, 163, 187]) assert.equal(band.get(id), 'backup-export');
  for (const id of [80, 130, 164]) assert.equal(band.get(id), 'pdf-record-templates');
  for (const id of [122, 136, 165, 166, 167]) assert.equal(band.get(id), 'custom-api');
  for (const id of [152, 153, 154, 155, 191]) assert.equal(band.get(id), 'mobile-pwa-offline');
});
