/**
 * Permission-parity matrix for one real export: the redistributable
 * library_application.ds share_settings -> authPlan -> usersPlan -> invite.
 *
 * Every grant the export declares must land on a Catalyst role carrying the
 * same name as its Creator profile, and no grant may be invented, widened or
 * silently dropped. The matrix below is the export's permission table read by
 * hand; each leg of the pipeline is checked against it in both directions
 * (expected rows present AND no extra rows), so parity breaks loudly whichever
 * side drifts. Offline only: synthetic identities, a fake REST driver.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { authPlan, type Crud } from '../../auth/src/index.js';
import { inviteUsers, readBackupUsers, userRefId, usersPlan, usersPlanJson, usersPlanMarkdown } from '../src/index.js';
import type { RestCall, RestFn } from '../src/tables.js';

const DS_PATH = 'fixtures/redistributable/library-application-system/library_application.ds';
const SALT = 'parity-salt';
const PROJECT = '10000000000000001';
const BASE = `/baas/v1/project/${PROJECT}`;

const FORMS = ['Book', 'Member_Info', 'Book_Transaction', 'Staff_Members'] as const;
const PAGES = ['DashBoard'] as const;

interface ExpectedProfile {
  /** The Catalyst role the profile becomes. */
  role: string;
  clone: 'App User' | 'App Administrator';
  portal: boolean;
  /** tablePermissions rows the export's ModulePermissions/preset produce. */
  grants: { table: string; permissions: Crud[]; scope: 'ORG' | 'GLOBAL' }[];
  /** Pages the role reaches (module `enabled = tab`, or preset all-pages). */
  pages: string[];
}

const SELECT: Crud[] = ['SELECT'];
const READ_WRITE: Crud[] = ['SELECT', 'INSERT', 'UPDATE'];
const FULL: Crud[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/** Per profile, the grants the .ds declares — the parity matrix itself. */
const MATRIX: Record<string, ExpectedProfile> = {
  // ReportPermissions only ("View"), no enabled flags -> SELECT at ORG scope;
  // DashBoard is a tab-enabled page module, not a table grant.
  Read: { role: 'Read', clone: 'App User', portal: false, grants: FORMS.map((table) => ({ table, permissions: SELECT, scope: 'ORG' as const })), pages: ['DashBoard'] },
  // Predefined "write" set: every form, ORG scope, no delete.
  Write: { role: 'Write', clone: 'App User', portal: false, grants: FORMS.map((table) => ({ table, permissions: READ_WRITE, scope: 'ORG' as const })), pages: [...PAGES] },
  // Predefined administrator: every form, GLOBAL, including delete.
  Administrator: { role: 'Administrator', clone: 'App Administrator', portal: false, grants: FORMS.map((table) => ({ table, permissions: FULL, scope: 'GLOBAL' as const })), pages: [...PAGES] },
  // Mixed module grants: View-only forms stay SELECT/ORG; Create+Viewall+Import
  // forms gain INSERT at GLOBAL scope. No DashBoard module -> no page access.
  Assistant: {
    role: 'Assistant',
    clone: 'App User',
    portal: false,
    grants: [
      { table: 'Staff_Members', permissions: SELECT, scope: 'ORG' },
      { table: 'Book_Transaction', permissions: SELECT, scope: 'ORG' },
      { table: 'Book', permissions: ['SELECT', 'INSERT'], scope: 'GLOBAL' },
      { table: 'Member_Info', permissions: ['SELECT', 'INSERT'], scope: 'GLOBAL' },
    ],
    pages: [],
  },
  // A Developer profile with no modules is not an implicit allow.
  Developer: { role: 'Developer', clone: 'App User', portal: false, grants: [], pages: [] },
  // Full enabled flags (Create,Viewall,Modifyall,...) + View/Edit/Delete
  // reports -> all four verbs at GLOBAL scope; DashBoard tab again.
  Librarians: { role: 'Librarians', clone: 'App User', portal: false, grants: FORMS.map((table) => ({ table, permissions: FULL, scope: 'GLOBAL' as const })), pages: ['DashBoard'] },
  // Portal preset ("only add and view"): SELECT+INSERT at ORG on every form.
  Customer: { role: 'Customer', clone: 'App User', portal: true, grants: FORMS.map((table) => ({ table, permissions: ['SELECT', 'INSERT'], scope: 'ORG' as const })), pages: [...PAGES] },
};

const PROFILE_NAMES = Object.keys(MATRIX);
const HIERARCHY_ROLES = [
  { name: 'CEO', parent: undefined },
  { name: 'Librarian', parent: 'CEO' },
];

function libraryApp() {
  return deriveIr(parse(readFileSync(join(repoRoot(), DS_PATH), 'utf8')));
}

/** A backup whose PROFILE_NAMEs cover every export profile plus one unmapped. */
function backupDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-parity-backup-'));
  const chunk = join(dir, 'data', 'data_1');
  mkdirSync(chunk, { recursive: true });
  const rows = [
    '"USER_EMAIL","NAME","FIRST_NAME","LAST_NAME","USER_TYPE","USER_STATUS","PROFILE_NAME","ROLE_NAME","ZUID"',
    ...PROFILE_NAMES.map((profile, index) => `"user-${String(index + 1).padStart(3, '0')}","N${index}","F${index}","L${index}","Z","Active","${profile}","${index % 2 === 0 ? 'Librarian' : 'CEO'}","90${index}"`),
    '"user-099","N9","F9","L9","Z","Active","Legacy_Role","","9099"',
    '"user-098","N8","F8","L8","Z","Inactive","Read","","9098"',
  ];
  writeFileSync(join(chunk, 'appUsers.csv'), `${rows.join('\n')}\n`);
  writeFileSync(join(chunk, 'appAdmins.csv'), '"USER_EMAIL","NAME","FIRST_NAME","LAST_NAME","ZUID","CREATED_TIME","CREATED_BY_ZUID"\n"admin-001","Admin","Ad","Min","9101","t","1"\n');
  writeFileSync(join(dir, 'app_manifest.xml'), '<application><name>Library</name></application>\n');
  return dir;
}


test('parity: every export profile becomes exactly one same-named Catalyst role', () => {
  const plan = authPlan(libraryApp());
  const byProfile = new Map(plan.roles.filter((role) => role.source === 'profile').map((role) => [role.profile ?? role.role_name, role]));
  assert.equal(byProfile.size, PROFILE_NAMES.length);
  for (const [profile, expected] of Object.entries(MATRIX)) {
    const role = byProfile.get(profile);
    assert.ok(role, `no Catalyst role planned for profile ${profile}`);
    assert.equal(role.role_name, expected.role);
    assert.equal(role.clone_role, expected.clone);
    assert.equal(role.portal, expected.portal);
    assert.equal(role.source, 'profile');
  }
  // Hierarchy roles exist for the access policy but are never invite targets.
  const hierarchy = plan.roles.filter((role) => role.source === 'hierarchy').map((role) => ({ name: role.role_name, parent: role.parent }));
  assert.deepEqual(
    hierarchy.sort((a, b) => a.name.localeCompare(b.name)),
    [...HIERARCHY_ROLES].sort((a, b) => a.name.localeCompare(b.name)),
  );
  assert.deepEqual(
    plan.portalUsers.map((user) => user.profile),
    ['Customer'],
  );
});

test('parity: table permissions are the least-privilege baseline, not the export grant matrix', () => {
  // The matrix grants are enforced by c2c_api through the access policy (next
  // tests); Catalyst grants would only open a direct Web SDK path around it.
  const plan = authPlan(libraryApp());
  const roles = ['App User', ...plan.roles.map((role) => role.role_name)];
  const expected = FORMS.flatMap((table) => roles.map((role) => `${role}|${table}||USER`)).sort();
  const actual = plan.tablePermissions.map((row) => `${row.role}|${row.table}|${row.permissions.join('+')}|${row.scope}`).sort();
  assert.deepEqual(actual, expected);
  // Every profile in the matrix has a role on the baseline.
  for (const row of Object.values(MATRIX)) assert.ok(roles.includes(row.role), row.role);
});

test('parity: page access matches tab-enabled modules and preset all-pages', () => {
  const plan = authPlan(libraryApp());
  const expected = Object.values(MATRIX).flatMap((row) => row.pages.map((page) => `${row.role}|${page}`)).sort();
  // pageAccess rows are keyed by the Creator profile name, not the role.
  const byProfile = new Map(Object.values(MATRIX).map((row) => [row.role, row.role]));
  const actual = plan.pageAccess.map((row) => `${byProfile.get(row.role) ?? row.role}|${row.page}`).sort();
  assert.deepEqual(actual, expected);
});

test('parity: the shim access policy enforces the same grants the roles plan', () => {
  const policy = authPlan(libraryApp()).accessPolicy;
  assert.deepEqual(policy.roles, ['CEO', 'Librarian', 'Assistant']);
  // Module grants carry the hierarchy-shared "own records" scope; presets don't.
  const expectedProfiles: Record<string, Record<string, { write?: true; delete?: true; ownerScope?: string; edit?: boolean }>> = {
    Read: Object.fromEntries(FORMS.map((form) => [form, { ownerScope: 'view' }])),
    Write: Object.fromEntries(FORMS.map((form) => [form, { write: true }])),
    Administrator: Object.fromEntries(FORMS.map((form) => [form, { write: true, delete: true }])),
    Assistant: {
      Staff_Members: { ownerScope: 'view' },
      Book_Transaction: { ownerScope: 'view' },
      Book: { write: true, edit: false },
      Member_Info: { write: true, edit: false },
    },
    Developer: {},
    Librarians: Object.fromEntries(FORMS.map((form) => [form, { write: true, delete: true }])),
    Customer: Object.fromEntries(FORMS.map((form) => [form, { write: true, ownerScope: 'view' }])),
  };
  assert.deepEqual(policy.profiles, expectedProfiles);
});

test('parity: every backup PROFILE_NAME resolves to its profile role; hierarchy is reported, never assigned', () => {
  const app = libraryApp();
  const users = readBackupUsers(backupDir());
  const plan = usersPlan(app, users, { salt: SALT });

  // One plan user per export profile, each on the profile's own role.
  const byProfile = new Map(users.filter((user) => user.source === 'appUsers' && user.status.toLowerCase() === 'active' && user.identity).map((user) => [userRefId(user.identity, SALT), user]));
  let resolved = 0;
  for (const user of plan.users) {
    if (user.via === 'appAdmins') {
      assert.equal(user.role, 'App Administrator');
      continue;
    }
    const source = byProfile.get(user.id);
    assert.ok(source, `plan user ${user.id} matches no backup row`);
    const expected = MATRIX[source.profile]?.role ?? 'App User';
    assert.equal(user.role, expected, `${source.profile} mapped to ${user.role}`);
    // ROLE_NAME (Librarian/CEO) is hierarchy data: reported, never the grant.
    assert.equal(user.hierarchy, source.hierarchy);
    if (MATRIX[source.profile]) resolved += 1;
  }
  assert.equal(resolved, PROFILE_NAMES.length);
  assert.equal(plan.counts.inactive, 1);
  assert.deepEqual(plan.unmapped, ['Legacy_Role']);

  // roleMap covers every profile with the same Catalyst role the matrix names,
  // marks hierarchy rows, and adds the admins row — nothing else.
  const profileRows = plan.roleMap.filter((row) => MATRIX[row.profile]);
  assert.equal(profileRows.length, PROFILE_NAMES.length);
  for (const row of profileRows) {
    assert.equal(row.catalystRole, MATRIX[row.profile]!.role);
    assert.equal(row.portal, MATRIX[row.profile]!.portal);
  }
  for (const name of HIERARCHY_ROLES.map((role) => role.name)) {
    assert.match(plan.roleMap.find((row) => row.profile === name)?.note ?? '', /data-hierarchy/);
  }
  assert.ok(plan.roleMap.some((row) => row.profile === '(appAdmins.csv)' && row.catalystRole === 'App Administrator'));
});

test('parity: invites POST each user onto the role that carries their profile grants', async () => {
  const app = libraryApp();
  const users = readBackupUsers(backupDir());
  const plan = usersPlan(app, users, { salt: SALT });

  // Targets from the plan itself: the role the matrix resolved, plus identity.
  const byIdentity = new Map(users.map((user) => [userRefId(user.identity, SALT), user]));
  const targets = plan.users
    .filter((user) => user.via === 'appUsers')
    .map((user) => {
      const source = byIdentity.get(user.id)!;
      return { id: user.id, role: user.role, identity: source.identity, first: source.first, last: source.last };
    });

  const roleIds = Object.fromEntries([...Object.values(MATRIX).map((row) => row.role), 'App User', 'App Administrator'].map((role) => [role, `id-${role}`]));
  const calls: RestCall[] = [];
  const rest: RestFn = async (call) => {
    calls.push(call);
    if (call.method === 'GET' && call.path === `${BASE}/project-user`) return { status: 200, body: [] };
    if (call.method === 'POST' && call.path === `${BASE}/project-user`) return { status: 200, body: { user_id: '42' } };
    return { status: 404, body: {} };
  };
  const result = await inviteUsers(rest, { projectId: PROJECT, targets, prior: [], roleIds, redirectUrl: 'https://lib.example.onslate.in', retry: { sleep: async () => {}, random: () => 0 } });
  assert.equal(result.ok, true);
  assert.equal(result.rows.filter((row) => row.status === 'invited').length, targets.length);

  // Every POST carried the role id of the profile's Catalyst role — parity at
  // the wire, not just in the plan.
  const posts = calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, targets.length);
  const idByEmail = new Map(targets.map((target) => [target.identity, target]));
  for (const post of posts) {
    const details = (post.body as { user_details: Record<string, string> }).user_details;
    const target = idByEmail.get(details.email_id!);
    assert.ok(target, `POST for unknown identity ${details.email_id}`);
    assert.equal(details.role_id, `id-${target.role}`);
    assert.equal((post.body as { redirect_url?: string }).redirect_url, 'https://lib.example.onslate.in');
  }
});

test('parity outputs stay identity-free across the whole matrix', () => {
  const app = libraryApp();
  const plan = usersPlan(app, readBackupUsers(backupDir()), { salt: SALT });
  for (const text of [usersPlanJson(plan), usersPlanMarkdown(plan)]) {
    assert.ok(!text.includes('@'));
    for (const identity of ['user-0', 'admin-0']) assert.ok(!text.includes(identity), `leaked ${identity}`);
  }
});
