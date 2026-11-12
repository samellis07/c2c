/**
 * Behaviour of plugin/references/surface-decision-table.md.
 * A rule is a level-3 heading: one operation c2c performs or guides.
 * Headings are unique. Every rule names a surface, a recipe, and a read-back.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanText } from '../../scripts/check-hygiene.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rel = 'plugin/references/surface-decision-table.md';
const surfaceLine = /^Surface: (?:REST with the CLI token|Catalyst CLI|MCP CatalystbyZoho_\S+|guided console step)(?:; .*)?$/m;

function load() {
  return readFileSync(path.join(repo, rel), 'utf8');
}

function headings(md) {
  const out = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6}) (.+?)\s*$/.exec(lines[i]);
    if (match) out.push({ level: match[1].length, title: match[2], line: i });
  }
  return out;
}

function ruleBodies(md) {
  const lines = md.split('\n');
  const all = headings(md);
  return all.filter((head) => head.level === 3).map((head) => {
    const next = all.find((other) => other.line > head.line && other.level <= 3);
    const end = next ? next.line : lines.length;
    return { title: head.title, body: lines.slice(head.line + 1, end).join('\n') };
  });
}

test('surface table exists with a unique rule per operation', () => {
  const md = load();
  assert.match(md, /^# /);
  const titles = headings(md).map((head) => head.title);
  assert.deepEqual(titles, [...new Set(titles)]);
  const rules = ruleBodies(md);
  assert.ok(rules.length >= 35, `expected at least 35 operations, got ${rules.length}`);
  for (const rule of rules) {
    assert.match(rule.body, /^Rule: /m, `${rule.title} lacks Rule:`);
    assert.match(rule.body, /^Recipe: /m, `${rule.title} lacks Recipe:`);
    assert.match(rule.body, surfaceLine, `${rule.title} lacks a known surface line:\n${rule.body}`);
    assert.match(rule.body, /^Read-back: /m, `${rule.title} lacks Read-back:`);
  }
  assert.doesNotMatch(md, /onslate\.in\b/);
  assert.doesNotMatch(md, /api\.catalyst\.in\b/);
});

test('surface table covers the operations c2c performs or guides', () => {
  const md = load();
  const must = [
    'POST /baas/v1/project/import',
    'template_format=JSON',
    'schedule=false',
    '409 DUPLICATE_ENTRY',
    'PUT /baas/v1/project/<project-id>/import',
    'DELETE /baas/v1/project/<project-id>',
    'CatalystbyZoho_Create_Job_Pool',
    'CatalystbyZoho_Create_Bucket',
    'CatalystbyZoho_Create_Table',
    'CatalystbyZoho_Update_Table_Permissions',
    'CatalystbyZoho_Update_Table_Scopes',
    'CatalystbyZoho_Get_Authentication_Configurations',
    'CatalystbyZoho_List_All_Roles',
    'CatalystbyZoho_Add_User',
    'CatalystbyZoho_Configure_API_Gateway_Route',
    'CatalystbyZoho_Create_Email_Configuration',
    'CatalystbyZoho_Execute_Query',
    'POST /baas/v1/project/<project-id>/table/<table-id>/row',
    'POST /baas/v1/project/<project-id>/bulk/write',
    'POST /job_scheduling/cron',
    'POST /job_scheduling/job',
    'catalyst deploy',
    'catalyst slate:link',
    'POST /baas/v1/project/<project-id>/authentication/enable',
    'POST /baas/v1/project/<project-id>/cors-domain',
    '"iframe":true',
    'Please access the Slate service',
    '401 NO_ACCESS',
    'GET /baas/v1/project/<project-id>/connections',
    'guided console step',
    '<org-id>',
    '<project-id>',
    '<dc>',
  ];
  for (const needle of must) {
    assert.ok(md.includes(needle), `missing surface text: ${needle}`);
  }
});

test('shipped rules pass the generic hygiene scan', () => {
  assert.deepEqual(scanText('rules.md', load()), []);
});
