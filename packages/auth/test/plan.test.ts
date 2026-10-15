import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { RecordAccessError, authorizeDelete, authorizeRead, authorizeWrite } from '../../shims/src/access.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { authAsJson, authAsReport, authPlan } from '../src/index.js';

function appOf(body: string) {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

test('profiles become cloned roles, portal users, and an access policy', () => {
  const plan = authPlan(
    appOf(`\tform Item
\t{
\t\tQty
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tlist All_Items
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tQty
\t\t)
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "Staff users"
\t\t\tpermissions = {Chat:false, ApiAccess:true}
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Items = {"View","Edit"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tQty
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\t"Customers"
\t\t{
\t\t\tname = "Customers"
\t\t\ttype = Customer_Portal
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Items = {"Viewall"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\troles
\t\t{
\t\t\tCEO
\t\t\t{
\t\t\t\tdescription = "Top"
\t\t\t}
\t\t}
\t}`),
  );
  assert.equal(plan.dryRun, true);
  assert.equal(plan.applied, false);
  assert.equal(plan.authentication.hosted_auth, true);
  assert.equal(plan.authentication.embedded_auth, true);
  assert.equal(plan.authentication.public_signup, false);
  for (const role of plan.roles) assert.ok(role.clone_role === 'App User' || role.clone_role === 'App Administrator');
  const staff = plan.roles.find((role) => role.role_name === 'Staff');
  const customers = plan.roles.find((role) => role.role_name === 'Customers');
  const ceo = plan.roles.find((role) => role.role_name === 'CEO');
  assert.equal(staff?.clone_role, 'App User');
  assert.equal(staff?.portal, false);
  assert.equal(customers?.portal, true);
  assert.equal(customers?.clone_role, 'App User');
  assert.equal(ceo?.source, 'hierarchy');
  assert.deepEqual(plan.portalUsers, [{ profile: 'Customers', catalystRole: 'Customers', action: 'app-user' }]);
  const staffPerm = plan.tablePermissions.find((row) => row.role === 'Staff');
  assert.deepEqual(staffPerm, { table: 'Item', role: 'Staff', permissions: ['SELECT', 'UPDATE'], scope: 'ORG' });
  const portalPerm = plan.tablePermissions.find((row) => row.role === 'Customers');
  assert.equal(portalPerm?.scope, 'GLOBAL');
  assert.deepEqual(portalPerm?.permissions, ['SELECT']);
  const read = authorizeRead(plan.accessPolicy, { profile: 'Staff' }, 'Item', { op: 'true' });
  assert.deepEqual(read.fields, ['Qty']);
  assert.match(authAsReport(plan), /clone App User/);
  assert.match(authAsReport(plan), /does not call Catalyst/);
});

test('profiles with no module blocks get the Creator predefined grants', async () => {
  const plan = authPlan(
    appOf(`\tform Item
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Note
\t{
\t\tBody
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t\t"Write"
\t\t{
\t\t\tname = "Write"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have write permission for all components."
\t\t}
\t\t"Read"
\t\t{
\t\t\tname = "Read"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have read permission for all components."
\t\t}
\t\t"Customer"
\t\t{
\t\t\tname = "Customer"
\t\t\ttype = Customer_Portal
\t\t\tdescription = "This is the default profile having only add and view permission."
\t\t}
\t\t"Developer"
\t\t{
\t\t\tname = "Developer"
\t\t\ttype = Developer
\t\t\tdescription = "Developer Profile."
\t\t}
\t\t"Stranger"
\t\t{
\t\t\tname = "Stranger"
\t\t\ttype = Users_Permissions
\t\t}
\t}`),
  );
  for (const table of ['Item', 'Note']) {
    assert.equal(plan.accessPolicy.profiles.Administrator[table].write, true, table);
    assert.equal(plan.accessPolicy.profiles.Administrator[table].delete, true, table);
    assert.equal(plan.accessPolicy.profiles.Write[table].write, true, table);
    assert.equal(plan.accessPolicy.profiles.Write[table].delete, undefined, table);
    assert.equal(plan.accessPolicy.profiles.Customer[table].write, true, table);
    assert.equal(plan.accessPolicy.profiles.Customer[table].delete, undefined, table);
    assert.equal(plan.accessPolicy.profiles.Read[table].write, undefined, table);
    assert.equal(plan.accessPolicy.profiles.Read[table].delete, undefined, table);
    assert.ok(plan.accessPolicy.profiles.Read[table], table);
  }
  assert.deepEqual(plan.accessPolicy.profiles.Developer, {});
  assert.deepEqual(plan.accessPolicy.profiles.Stranger, {});
  const admin = plan.tablePermissions.find((row) => row.role === 'Administrator' && row.table === 'Item');
  assert.deepEqual(admin, { table: 'Item', role: 'Administrator', permissions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], scope: 'GLOBAL' });
  const write = plan.tablePermissions.find((row) => row.role === 'Write' && row.table === 'Item');
  assert.deepEqual(write, { table: 'Item', role: 'Write', permissions: ['SELECT', 'INSERT', 'UPDATE'], scope: 'ORG' });
  const portal = plan.tablePermissions.find((row) => row.role === 'Customer' && row.table === 'Item');
  assert.deepEqual(portal, { table: 'Item', role: 'Customer', permissions: ['SELECT', 'INSERT'], scope: 'ORG' });
  const read = plan.tablePermissions.find((row) => row.role === 'Read' && row.table === 'Note');
  assert.deepEqual(read, { table: 'Note', role: 'Read', permissions: ['SELECT'], scope: 'ORG' });
  assert.equal(plan.tablePermissions.some((row) => row.role === 'Stranger' || row.role === 'Developer'), false);
  assert.deepEqual(authorizeWrite(plan.accessPolicy, { profile: 'Administrator' }, 'Item', { Name: 'A' }).values, { Name: 'A' });
  assert.throws(() => authorizeWrite(plan.accessPolicy, { profile: 'Read' }, 'Item', { Name: 'A' }));
  assert.throws(() => authorizeWrite(plan.accessPolicy, { profile: 'Stranger' }, 'Item', { Name: 'A' }));
  authorizeDelete(plan.accessPolicy, { profile: 'Administrator' }, 'Item');
  assert.throws(() => authorizeDelete(plan.accessPolicy, { profile: 'Write' }, 'Item'), RecordAccessError);
  assert.throws(() => authorizeDelete(plan.accessPolicy, { profile: 'Customer' }, 'Item'), RecordAccessError);
  assert.throws(() => authorizeDelete(plan.accessPolicy, { profile: 'Read' }, 'Item'), RecordAccessError);

  let calls = 0;
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access: plan.accessPolicy,
    datastore: {
      async query() {
        calls += 1;
        return [{ ROWID: '1', Name: 'A' }];
      },
      async delete() {
        calls += 1;
        return {};
      },
    },
  });
  await assert.rejects(
    () => runtime.shim.datastore.delete(runtime.context({ principal: { profile: 'Write' } }), 'Item', { op: 'true' }),
    RecordAccessError,
  );
  await assert.rejects(
    () => runtime.shim.datastore.delete(runtime.context({ principal: { profile: 'Customer' } }), 'Item', { op: 'true' }),
    RecordAccessError,
  );
  assert.equal(calls, 0);
  const deleted = await runtime.shim.datastore.delete(
    runtime.context({ principal: { profile: 'Administrator' } }),
    'Item',
    { op: 'true' },
  );
  assert.deepEqual(deleted, { deleted: 1 });
  assert.equal(calls, 2);
});

test('edit without delete is refused and delete without edit stays inside the record filter', async () => {
  const plan = authPlan(
    appOf(`\tform Item
\t{
\t\tOwner
\t\t(
\t\t\ttype = text
\t\t)
\t\tStatus
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tlist Mine
\t{
\t\tshow all rows from Item [Owner == zoho.loginuser]
\t\t(
\t\t\tOwner
\t\t\tStatus
\t\t)
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tMine = {"View","Edit"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\t"Purge"
\t\t{
\t\t\tname = "Purge"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tMine = {"View","Delete"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`),
  );
  const staffGrant = plan.accessPolicy.profiles.Staff.Item;
  const purgeGrant = plan.accessPolicy.profiles.Purge.Item;
  assert.equal(staffGrant.write, true);
  assert.equal(staffGrant.delete, undefined);
  assert.equal(purgeGrant.write, undefined);
  assert.equal(purgeGrant.delete, true);
  assert.equal(staffGrant.recordFilter?.op, '==');
  assert.equal(purgeGrant.recordFilter?.op, '==');
  const staffPerm = plan.tablePermissions.find((row) => row.role === 'Staff' && row.table === 'Item');
  const purgePerm = plan.tablePermissions.find((row) => row.role === 'Purge' && row.table === 'Item');
  assert.deepEqual(staffPerm?.permissions, ['SELECT', 'UPDATE']);
  assert.deepEqual(purgePerm?.permissions, ['SELECT', 'DELETE']);
  assert.throws(() => authorizeWrite(plan.accessPolicy, { profile: 'Purge' }, 'Item', { Status: 'Closed' }));
  authorizeDelete(plan.accessPolicy, { profile: 'Purge', loginUser: 'ada@example.test' }, 'Item');
  assert.throws(() => authorizeDelete(plan.accessPolicy, { profile: 'Staff', loginUser: 'ada@example.test' }, 'Item'), RecordAccessError);

  const table = [
    { ROWID: '1', Owner: 'ada@example.test', Status: 'Open' },
    { ROWID: '2', Owner: 'eve@example.test', Status: 'Open' },
  ];
  let calls = 0;
  const seen: string[] = [];
  const deleted: unknown[][] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    access: plan.accessPolicy,
    datastore: {
      async query(_form, where, limit, offset = 0) {
        calls += 1;
        seen.push(where);
        const visible = where.includes("Owner = 'ada@example.test'") ? table.filter((row) => row.Owner === 'ada@example.test') : table;
        return visible.slice(offset, offset + limit);
      },
      async delete(_form, rowIds) {
        calls += 1;
        deleted.push([...rowIds]);
        return {};
      },
    },
  });
  await assert.rejects(
    () =>
      runtime.shim.datastore.delete(runtime.context({ principal: { profile: 'Staff', loginUser: 'ada@example.test' } }), 'Item', {
        op: 'true',
      }),
    RecordAccessError,
  );
  assert.equal(calls, 0);
  const result = await runtime.shim.datastore.delete(
    runtime.context({ principal: { profile: 'Purge', loginUser: 'ada@example.test' } }),
    'Item',
    { op: 'true' },
  );
  assert.deepEqual(result, { deleted: 1 });
  assert.equal(calls, 2);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /Owner = 'ada@example.test'/);
  assert.deepEqual(deleted, [['1']]);
});

test('case-only profile and hierarchy role names remain visible with a collision warning', () => {
  const app = appOf(`\tshare_settings
\t{
\t\t"Librarian"
\t\t{
\t\t\tname = "Librarian"
\t\t\ttype = Users_Permissions
\t\t}
\t\troles
\t\t{
\t\t\tCEO
\t\t\t{
\t\t\t\t"librarian"
\t\t\t\t{
\t\t\t\t\tdescription = "Hierarchy role"
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  const plan = authPlan(app);
  assert.deepEqual(plan.roles.map(({ role_name, source }) => ({ role_name, source })), [
    { role_name: 'Librarian', source: 'profile' },
    { role_name: 'CEO', source: 'hierarchy' },
    { role_name: 'librarian', source: 'hierarchy' },
  ]);
  const collision = plan.notes.filter((note) => note.includes('Potential Catalyst role-name collision'));
  assert.deepEqual(collision, [
    'Potential Catalyst role-name collision: profile "Librarian" and hierarchy role "librarian" differ only by case. Catalyst case sensitivity is undocumented; verify before creating both roles.',
  ]);
  assert.equal(authAsReport(plan).includes(collision[0]), true);
  assert.equal(authAsReport(plan), authAsReport(authPlan(app)));
});

function profileBlock(name: string, type: string, modules = ''): string {
  const body = modules ? `\t\t\tModulePermissions\n\t\t\t{\n${modules}\t\t\t}\n` : '';
  return `\t\t"${name}"\n\t\t{\n\t\t\tname = "${name}"\n\t\t\ttype = ${type}\n${body}\t\t}\n`;
}

function moduleBlock(form: string, enabled: string, reports: string): string {
  return `\t\t\t\t${form}\n\t\t\t\t{\n\t\t\t\t\tenabled = ${enabled}\n\t\t\t\t\tReportPermissions\n\t\t\t\t\t{\n\t\t\t\t\t\tAll_${form}s = ${reports}\n\t\t\t\t\t}\n\t\t\t\t}\n`;
}

const ITEM_FORM = `\tform Item
\t{
\t\tQty
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tlist All_Items
\t{
\t\tshow all rows from Item
\t\t(
\t\t\tQty
\t\t)
\t}
`;

test('a renamed built-in profile never lands on a name another profile already holds', () => {
  for (const order of [
    ['App User', 'Creator App User'],
    ['Creator App User', 'App User'],
  ]) {
    const plan = authPlan(
      appOf(`\tshare_settings\n\t{\n${order.map((name) => profileBlock(name, 'Users_Permissions')).join('')}\t}`),
    );
    const names = plan.roles.map((role) => role.role_name);
    assert.equal(new Set(names).size, names.length, `duplicate role names for ${order.join(' + ')}: ${names.join(', ')}`);
    const renamed = plan.roles.find((role) => role.profile === 'App User');
    assert.equal(renamed?.role_name, 'Creator Creator App User');
    assert.equal(renamed?.clone_role, 'App User');
  }
});

test('a disabled module grants neither table permissions nor page access', () => {
  const plan = authPlan(
    appOf(
      `${ITEM_FORM}\tshare_settings\n\t{\n${profileBlock('Staff', 'Users_Permissions', moduleBlock('Item', 'false', '{"View","Edit","Delete"}') + `\t\t\t\tDashboard\n\t\t\t\t{\n\t\t\t\t\tenabled = "False"\n\t\t\t\t}\n`)}\t}`,
    ),
  );
  assert.deepEqual(plan.tablePermissions, []);
  assert.deepEqual(plan.pageAccess, []);
});

test('write verbs without a read verb grant no table permission at all', () => {
  const plan = authPlan(
    appOf(`${ITEM_FORM}\tshare_settings\n\t{\n${profileBlock('Clerk', 'Users_Permissions', moduleBlock('Item', 'true', '{"Add","Edit","Delete"}'))}\t}`),
  );
  assert.deepEqual(plan.tablePermissions, []);
});

test('Create and View All module flags grant insert and a GLOBAL read', () => {
  const plan = authPlan(
    appOf(`${ITEM_FORM}\tshare_settings\n\t{\n${profileBlock('Lead', 'Users_Permissions', moduleBlock('Item', '{Create, Viewall, Bogus}', '{}'))}\t}`),
  );
  assert.deepEqual(plan.tablePermissions, [{ table: 'Item', role: 'Lead', permissions: ['SELECT', 'INSERT'], scope: 'GLOBAL' }]);
});

test('nested hierarchy roles keep their parent and skip names a profile already owns', () => {
  const plan = authPlan(
    appOf(`\tshare_settings
\t{
${profileBlock('Manager', 'Users_Permissions')}\t\troles
\t\t{
\t\t\tCEO
\t\t\t{
\t\t\t\t"Manager"
\t\t\t\t{
\t\t\t\t\t"Clerk"
\t\t\t\t\t{
\t\t\t\t\t\tdescription = "Front desk"
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`),
  );
  assert.deepEqual(
    plan.roles.map(({ role_name, source, parent }) => ({ role_name, source, parent })),
    [
      { role_name: 'Manager', source: 'profile', parent: undefined },
      { role_name: 'CEO', source: 'hierarchy', parent: undefined },
      { role_name: 'Clerk', source: 'hierarchy', parent: 'Manager' },
    ],
  );
});

test('an export with no profiles reports no roles and its JSON round-trips', () => {
  const plan = authPlan(appOf(ITEM_FORM));
  assert.deepEqual(plan.roles, []);
  assert.equal(authAsReport(plan).includes('No profiles or hierarchy roles in the export.'), true);
  const json = authAsJson(plan);
  assert.equal(json.endsWith('}\n'), true);
  assert.deepEqual(JSON.parse(json), plan);
});

test('an untyped admin profile clones App Administrator and a module with no enabled flag still grants', () => {
  const plan = authPlan(
    appOf(`${ITEM_FORM}\tshare_settings
\t{
\t\t"Site Admins"
\t\t{
\t\t\tname = "Site Admins"
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Items = {"View"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tDashboard
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t}
\t\t\t}
\t\t}
\t}`),
  );
  assert.deepEqual(
    plan.roles.map(({ role_name, clone_role, portal }) => ({ role_name, clone_role, portal })),
    [{ role_name: 'Site Admins', clone_role: 'App Administrator', portal: false }],
  );
  assert.deepEqual(plan.tablePermissions, [{ table: 'Item', role: 'Site Admins', permissions: ['SELECT'], scope: 'ORG' }]);
  assert.deepEqual(plan.pageAccess, [{ page: 'Dashboard', role: 'Site Admins' }]);
});
