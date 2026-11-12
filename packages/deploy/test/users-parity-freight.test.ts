/**
 * Permission-parity matrix for a second real export: the redistributable
 * freight-forwarding share_settings -> authPlan -> usersPlan -> invite.
 *
 * Unlike the library export, every profile here is a bare Creator preset (no
 * ModulePermissions at all), the app has no pages, and the data-hierarchy
 * roles block sits inside share_settings. The matrix is the export read by
 * hand; each leg is compared as an exact set so a widened, invented or dropped
 * grant fails. Offline only: synthetic identities, a fake REST driver.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { authPlan } from '../../auth/src/index.js';
import { inviteUsers, readBackupUsers, userRefId, usersPlan, usersPlanJson, usersPlanMarkdown } from '../src/index.js';
import type { RestCall, RestFn } from '../src/tables.js';

const DS_PATH = 'fixtures/redistributable/freight-forwarding/Creator_app_source_code.ds';
const SALT = 'parity-salt';
const PROJECT = '10000000000000002';
const BASE = `/baas/v1/project/${PROJECT}`;

const FORMS = [
  'New_Airport', 'New_Port', 'New_HS_Codes_Master', 'Map_Dependency_Mode', 'Map_Submode',
  'New_Account', 'New_User', 'New_Contact', 'New_Vendor', 'New_Deal', 'New_Lead',
  'New_Quotation', 'New_Product', 'New_Delivery_Order', 'New_Invoice', 'New_Vessel',
  'New_SOF', 'New_Tax_Rate', 'New_Container', 'New_Table_of_Container',
] as const;

type Grant = { write?: true; delete?: true; ownerScope?: string };

/** Per profile, what the export's share_settings declares. */
const MATRIX: Record<string, { clone: 'App User' | 'App Administrator'; portal: boolean; grant: Grant }> = {
  // "read permission for all components": view every form, nothing else.
  Read: { clone: 'App User', portal: false, grant: {} },
  // "write permission for all components": view, add, edit; never delete.
  Write: { clone: 'App User', portal: false, grant: { write: true } },
  // "all the permissions": the only preset with delete.
  Administrator: { clone: 'App Administrator', portal: false, grant: { write: true, delete: true } },
  // Customer_Portal "only add and view": own records only.
  Customer: { clone: 'App User', portal: true, grant: { write: true, ownerScope: 'view' } },
};
const PROFILE_NAMES = Object.keys(MATRIX);

function freightApp() {
  return deriveIr(parse(readFileSync(join(repoRoot(), DS_PATH), 'utf8')));
}

/** A backup whose PROFILE_NAMEs cover every export profile plus one unmapped. */
function backupDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-parity-freight-'));
  const chunk = join(dir, 'data', 'data_1');
  mkdirSync(chunk, { recursive: true });
  const rows = [
    '"USER_EMAIL","NAME","FIRST_NAME","LAST_NAME","USER_TYPE","USER_STATUS","PROFILE_NAME","ROLE_NAME","ZUID"',
    ...PROFILE_NAMES.map((profile, index) => `"user-${String(index + 1).padStart(3, '0')}","N${index}","F${index}","L${index}","Z","Active","${profile}","CEO","80${index}"`),
    '"user-099","N9","F9","L9","Z","Active","Dispatcher","","8099"',
  ];
  writeFileSync(join(chunk, 'appUsers.csv'), `${rows.join('\n')}\n`);
  writeFileSync(join(chunk, 'appAdmins.csv'), '"USER_EMAIL","NAME","FIRST_NAME","LAST_NAME","ZUID","CREATED_TIME","CREATED_BY_ZUID"\n"admin-001","Admin","Ad","Min","8101","t","1"\n');
  writeFileSync(join(dir, 'app_manifest.xml'), '<application><name>Freight</name></application>\n');
  return dir;
}

test('freight parity: each preset profile is one same-named role; CEO comes from the nested roles block', () => {
  const app = freightApp();
  assert.deepEqual(app.forms.map((form) => form.name), [...FORMS]);
  const plan = authPlan(app);
  assert.deepEqual(
    plan.roles.map((role) => ({ name: role.role_name, clone: role.clone_role, source: role.source, portal: role.portal, parent: role.parent })),
    [
      ...Object.entries(MATRIX).map(([name, row]) => ({ name, clone: row.clone, source: 'profile', portal: row.portal, parent: undefined })),
      { name: 'CEO', clone: 'App User', source: 'hierarchy', portal: false, parent: undefined },
    ],
  );
  assert.deepEqual(plan.portalUsers, [{ profile: 'Customer', catalystRole: 'Customer', action: 'app-user' }]);
});

test('freight parity: no pages in the export means no page access is invented', () => {
  const app = freightApp();
  assert.deepEqual(app.pages, []);
  assert.deepEqual(authPlan(app).pageAccess, []);
});

test('freight parity: table permissions stay the least-privilege baseline on all twenty tables', () => {
  const plan = authPlan(freightApp());
  const roles = ['App User', ...PROFILE_NAMES, 'CEO'];
  const expected = FORMS.flatMap((table) => roles.map((role) => `${role}|${table}||USER`)).sort();
  const actual = plan.tablePermissions.map((row) => `${row.role}|${row.table}|${row.permissions.join('+')}|${row.scope}`).sort();
  assert.deepEqual(actual, expected);
});

test('freight parity: the shim access policy writes each preset out on every form', () => {
  const policy = authPlan(freightApp()).accessPolicy;
  assert.deepEqual(policy.roles, ['CEO']);
  assert.deepEqual(policy.admins, ['Administrator']);
  const expected = Object.fromEntries(Object.entries(MATRIX).map(([name, row]) => [name, Object.fromEntries(FORMS.map((form) => [form, row.grant]))]));
  assert.deepEqual(policy.profiles, expected);
});

test('freight parity: backup users land on their profile role and invites POST that role id', async () => {
  const app = freightApp();
  const users = readBackupUsers(backupDir());
  const plan = usersPlan(app, users, { salt: SALT });
  assert.deepEqual(plan.unmapped, ['Dispatcher']);

  const byId = new Map(users.map((user) => [userRefId(user.identity, SALT), user]));
  const targets = plan.users
    .filter((user) => user.via === 'appUsers')
    .map((user) => {
      const source = byId.get(user.id)!;
      // ROLE_NAME CEO is hierarchy data: reported, never the assigned role.
      assert.equal(user.role, MATRIX[source.profile] ? source.profile : 'App User', source.profile);
      if (MATRIX[source.profile]) assert.equal(user.hierarchy, 'CEO');
      return { id: user.id, role: user.role, identity: source.identity, first: source.first, last: source.last };
    });
  assert.equal(targets.filter((target) => MATRIX[target.role]).length, PROFILE_NAMES.length);
  assert.ok(plan.users.some((user) => user.via === 'appAdmins' && user.role === 'App Administrator'));

  const roleIds = Object.fromEntries([...PROFILE_NAMES, 'App User', 'App Administrator'].map((role) => [role, `id-${role}`]));
  const calls: RestCall[] = [];
  const rest: RestFn = async (call) => {
    calls.push(call);
    if (call.method === 'GET' && call.path === `${BASE}/project-user`) return { status: 200, body: [] };
    if (call.method === 'POST' && call.path === `${BASE}/project-user`) return { status: 200, body: { user_id: '42' } };
    return { status: 404, body: {} };
  };
  const result = await inviteUsers(rest, { projectId: PROJECT, targets, prior: [], roleIds, redirectUrl: 'https://freight.example.onslate.in', retry: { sleep: async () => {}, random: () => 0 } });
  assert.equal(result.ok, true);
  const posts = calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, targets.length);
  const byIdentity = new Map(targets.map((target) => [target.identity, target]));
  for (const post of posts) {
    const details = (post.body as { user_details: Record<string, string> }).user_details;
    const target = byIdentity.get(details.email_id!);
    assert.ok(target, `POST for unknown identity ${details.email_id}`);
    assert.equal(details.role_id, `id-${target.role}`);
  }

  for (const text of [usersPlanJson(plan), usersPlanMarkdown(plan)]) {
    for (const identity of ['@', 'user-0', 'admin-0']) assert.ok(!text.includes(identity), `leaked ${identity}`);
  }
});
