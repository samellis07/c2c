/**
 * `mergeUsersPlans` — a multi-app Creator workspace migrating to one
 * Catalyst project: each app's usersPlan(), run against the same salt,
 * merges into the one set of invites the shared project needs.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { mergeUsersPlans, readBackupUsers, usersPlan, type UsersPlan } from '../src/index.js';

function ds(appName: string, profileName: string): string {
  return `application "${appName}"
{
	time zone = "Asia/Kolkata"
	share_settings
	{
		"${profileName}"
		{
			name = "${profileName}"
			type = Users_Permissions
			ModulePermissions
			{
				Item
				{
					enabled = true
					ReportPermissions
					{
						All_Items = {"View","Edit"}
					}
				}
			}
		}
	}
	section S
	{
		form Item
		{
			Item_Name
			(
				type = text
			)
		}
		list All_Items
		{
			show all rows from Item
		}
	}
}
`;
}

function appWith(name: string, profileName: string) {
  return deriveIr(parse(ds(name, profileName)));
}

function backupDir(rows: readonly string[], admins: readonly string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-users-merge-'));
  const chunk = join(dir, 'data', 'data_1');
  mkdirSync(chunk, { recursive: true });
  writeFileSync(
    join(chunk, 'appUsers.csv'),
    ['"USER_EMAIL","NAME","FIRST_NAME","LAST_NAME","USER_TYPE","USER_STATUS","PROFILE_NAME","ROLE_NAME","ZUID"', ...rows].join('\n') + '\n',
  );
  if (admins.length) {
    writeFileSync(
      join(chunk, 'appAdmins.csv'),
      ['"USER_EMAIL","NAME","FIRST_NAME","LAST_NAME","ZUID","CREATED_TIME","CREATED_BY_ZUID"', ...admins].join('\n') + '\n',
    );
  }
  writeFileSync(join(dir, 'app_manifest.xml'), '<application><name>Widget</name></application>\n');
  return dir;
}

function row(identity: string, profile: string): string {
  return `"${identity}","N","F","L","Z","Active","${profile}","","1"`;
}

const SALT = 'shared-pepper';

function planFor(appName: string, profileName: string, rows: readonly string[], admins: readonly string[] = []): UsersPlan {
  return usersPlan(appWith(appName, profileName), readBackupUsers(backupDir(rows, admins)), { salt: SALT });
}

test('a user absent from one app and present in another is counted once, unchanged', () => {
  const a = planFor('AppA', 'Staff', [row('user-1', 'Staff'), row('user-2', 'Staff')]);
  const b = planFor('AppB', 'Staff', [row('user-3', 'Staff')]);
  const merged = mergeUsersPlans([a, b]);
  assert.equal(merged.counts.total, 3);
  assert.equal(merged.conflicts.length, 0);
  assert.deepEqual(merged.apps, ['AppA', 'AppB']);
});

test('the same identity under the same role name in two apps is invited once, not twice', () => {
  const a = planFor('AppA', 'Staff', [row('user-1', 'Staff')]);
  const b = planFor('AppB', 'Staff', [row('user-1', 'Staff')]);
  const merged = mergeUsersPlans([a, b]);
  assert.equal(merged.counts.total, 1);
  assert.equal(merged.counts.perRole['Staff'], 1);
  assert.equal(merged.conflicts.length, 0);
});

test('App Administrator in one app always wins over a named role in another, and the conflict is listed', () => {
  const a = planFor('AppA', 'Staff', [row('user-1', 'Staff')]);
  const b = planFor('AppB', 'Staff', [], ['"user-1","N","F","L","1","t","0"']);
  const merged = mergeUsersPlans([a, b]);
  assert.equal(merged.counts.total, 1);
  const user = merged.users[0]!;
  assert.equal(user.role, 'App Administrator');
  assert.equal(merged.conflicts.length, 1);
  assert.deepEqual(merged.conflicts[0], {
    id: user.id,
    apps: ['AppA', 'AppB'],
    roles: ['App Administrator', 'Staff'],
    resolved: 'App Administrator',
  });
});

test('two distinct named roles for the same identity resolve deterministically by app order, and are flagged', () => {
  const a = planFor('AppA', 'Managers', [row('user-1', 'Managers')]);
  const b = planFor('AppB', 'Staff', [row('user-1', 'Staff')]);
  // Passed in reverse order: resolution must not depend on call order.
  const merged = mergeUsersPlans([b, a]);
  assert.equal(merged.users.length, 1);
  assert.equal(merged.users[0]!.role, 'Managers');
  assert.equal(merged.conflicts.length, 1);
  assert.deepEqual(merged.conflicts[0]!.roles, ['Managers', 'Staff']);
  assert.equal(merged.conflicts[0]!.resolved, 'Managers');
});
