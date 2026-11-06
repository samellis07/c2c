import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DESK_AGGREGATE_THEMES,
  DESK_THEME_CATALOGUE,
  DESK_THEME_NONE,
  FORUM_CATEGORIES,
  PRODUCT_AXIS_IDS,
  assertDeskCatalogue,
  clusterForumCase,
} from '../src/desk-themes.js';

test('the catalogue is the closed Desk aggregate set, with the seven product axes', () => {
  assert.equal(DESK_THEME_CATALOGUE.schema, 'c2c-desk-aggregate-themes/1');
  assert.equal(DESK_AGGREGATE_THEMES.length, 13);
  assert.deepEqual(
    DESK_AGGREGATE_THEMES.map((theme) => theme.priority),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  );
  assert.deepEqual(
    DESK_AGGREGATE_THEMES.filter((theme) => theme.productAxis).map((theme) => theme.id).sort(),
    [...PRODUCT_AXIS_IDS].sort(),
  );
  const mapped = DESK_AGGREGATE_THEMES.flatMap((theme) => [...theme.forumCategories]);
  const covered = new Set([...mapped, ...DESK_THEME_CATALOGUE.unmappedForumCategories]);
  assert.equal(covered.size, FORUM_CATEGORIES.length);
  for (const category of FORUM_CATEGORIES) assert.equal(covered.has(category), true);
});

test('a read theme outranks the case category, and both themes are kept', () => {
  const cluster = clusterForumCase({
    category: 'workflows',
    readTheme: 'scheduled-function-dev-quota',
    symptom: 'A scheduled workflow stops after the quota.',
  });
  assert.equal(cluster.deskTheme, 'schedule-cron');
  assert.equal(cluster.matchedBy, 'read-theme');
  assert.deepEqual(cluster.deskThemes, ['schedule-cron', 'form-workflow-scripting']);
});

test('category joins the product axes and the 12-month themes', () => {
  const expectCategory = new Map<string, string>([
    ['workflows', 'form-workflow-scripting'],
    ['pages/widgets', 'pages'],
    ['apis', 'custom-api'],
    ['environments/deploy', 'environments'],
    ['data import/export', 'backup-export'],
    ['scheduling/timezones', 'schedule-cron'],
    ['approvals/blueprints', 'approval'],
    ['payments', 'payment'],
    ['portals', 'portals-permissions'],
    ['users/roles/permissions', 'portals-permissions'],
    ['mobile/offline', 'mobile-pwa-offline'],
    ['pdf/print', 'pdf-record-templates'],
    ['notifications/mail', 'notifications-email-sms'],
  ]);
  for (const [category, theme] of expectCategory) {
    const cluster = clusterForumCase({ category, readTheme: 'other', symptom: 'A general request.' });
    assert.equal(cluster.deskTheme, theme, category);
    assert.equal(cluster.matchedBy, 'category');
    assert.deepEqual(cluster.deskThemes, [theme]);
  }
});

test('invokeurl, statement limits, portals, and templates follow the read theme even when the category differs', () => {
  assert.equal(
    clusterForumCase({ category: 'integrations/connections', readTheme: 'deluge-invokeurl-rest-api' }).deskTheme,
    'custom-api',
  );
  assert.equal(
    clusterForumCase({ category: 'limits/performance', readTheme: 'deluge-statement-limit' }).deskTheme,
    'form-workflow-scripting',
  );
  assert.equal(
    clusterForumCase({ category: 'fields', readTheme: 'portal-login-domain-access' }).deskTheme,
    'portals-permissions',
  );
  assert.equal(
    clusterForumCase({ category: 'reports', readTheme: 'pdf-template-merge-styling' }).deskTheme,
    'pdf-record-templates',
  );
  assert.equal(
    clusterForumCase({ category: 'mobile/offline', readTheme: 'barcode-qr-validation-haptic' }).deskTheme,
    'mobile-pwa-offline',
  );
});

test('fields, forms, reports, Deluge language, integrations, limits, billing, and announcements stay unmatched', () => {
  for (const category of ['fields', 'forms', 'reports', 'deluge', 'integrations/connections', 'limits/performance', 'billing/licensing', 'none']) {
    const cluster = clusterForumCase({
      category,
      readTheme: category === 'none' ? 'community-announcements-updates' : 'other',
      symptom: 'The form field does not save.',
    });
    assert.equal(cluster.deskTheme, DESK_THEME_NONE, category);
    assert.deepEqual(cluster.deskThemes, []);
    assert.equal(cluster.matchedBy, 'none');
  }
  assert.equal(clusterForumCase({ category: 'deluge', readTheme: 'deluge-string-manipulation' }).deskTheme, DESK_THEME_NONE);
  assert.equal(clusterForumCase({}).deskTheme, DESK_THEME_NONE);
});

test('Actions joins only on an explicit multi-word phrase, not the bare word action', () => {
  const named = clusterForumCase({
    category: 'reports',
    readTheme: 'other',
    symptom: 'The custom action on the report does nothing.',
  });
  assert.equal(named.deskTheme, 'actions');
  assert.equal(named.matchedBy, 'symptom');
  const bare = clusterForumCase({
    category: 'reports',
    readTheme: 'other',
    symptom: 'The report action menu is empty.',
  });
  assert.equal(bare.deskTheme, DESK_THEME_NONE);
  const workflow = clusterForumCase({
    category: 'workflows',
    readTheme: 'other',
    symptom: 'Need a workflow action that writes the row.',
  });
  assert.equal(workflow.deskTheme, 'form-workflow-scripting');
  assert.deepEqual(workflow.deskThemes, ['form-workflow-scripting', 'actions']);
  assert.equal(clusterForumCase({ category: 'payments', symptom: 'The transaction failed.' }).deskThemes.includes('actions'), false);
});

test('a catalogue that maps one forum category twice is refused', () => {
  const broken = {
    ...DESK_THEME_CATALOGUE,
    themes: DESK_THEME_CATALOGUE.themes.map((theme) => (
      theme.id === 'pages'
        ? { ...theme, forumCategories: ['workflows'] }
        : theme
    )),
  };
  assert.throws(() => assertDeskCatalogue(broken), /mapped twice/);
});
