/**
 * `c2c users` — Creator backup user lists -> Catalyst roles and invites.
 *
 * The fake driver accepts synthetic identities (user-001, ...), which is the
 * point of the personal-data rule: fixtures never carry email-shaped values
 * and every written/printed artefact is scanned for '@'.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import {
  DEPLOY_REPORT,
  formatInviteResult,
  idString,
  inviteUsers,
  parseJsonExact,
  plusAddressIds,
  roleIdFromUsers,
  parseSocialList,
  readBackupUsers,
  readUsersState,
  userRefId,
  usersCli,
  usersInvitesCsv,
  usersPlan,
  usersPlanJson,
  usersPlanMarkdown,
  writeUsersState,
  USERS_INVITES_CSV,
  USERS_PLAN_JSON,
  USERS_PLAN_MD,
  USERS_STATE_FILE,
  type BackupUser,
  type Io,
  type InviteTarget,
} from '../src/index.js';
import type { RestCall, RestFn } from '../src/tables.js';
import type { RetryOptions } from '../src/retry.js';

const PROJECT = '10000000000000001';
const ORG = '10000000000000002';
const SLATE = 'c2c-widget-demo.onslate.in';
const BASE = `/baas/v1/project/${PROJECT}`;

const DS = `application "Widget"
{
	time zone = "Asia/Kolkata"
	share_settings
	{
		"Staff"
		{
			name = "Staff"
			type = Users_Permissions
			permissions = {Chat:true}
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
				Settings_Page
				{
					enabled = true
				}
			}
		}
		"Customers"
		{
			name = "Customers"
			type = Customer_Portal
			ModulePermissions
			{
				Item
				{
					enabled = true
					ReportPermissions
					{
						All_Items = {"Viewall"}
					}
				}
			}
		}
		roles
		{
			CEO
			{
				description = "Top"
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

function app() {
  return deriveIr(parse(DS));
}

/** A backup as an extracted dir: data/data_1/appUsers.csv + appAdmins.csv, synthetic identities only. */
function backupDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-users-backup-'));
  const chunk = join(dir, 'data', 'data_1');
  mkdirSync(chunk, { recursive: true });
  writeFileSync(
    join(chunk, 'appUsers.csv'),
    [
      '"USER_EMAIL","NAME","FIRST_NAME","LAST_NAME","USER_TYPE","USER_STATUS","PROFILE_NAME","ROLE_NAME","ZUID"',
      '"user-001","One","First","Last","Z","Active","Staff","CEO","9001"',
      '"user-002","Two","Second","Last","Z","Active","Customers","","9002"',
      '"user-003","Three","Third","Last","Z","Active","Legacy_Role","","9003"',
      '"user-004","Four","Fourth","Last","Z","Inactive","Staff","","9004"',
      '"user-001","One","First","Last","Z","Active","Staff","CEO","9001"',
      '"","","","","Z","Active","Staff","","9005"',
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(chunk, 'appAdmins.csv'),
    '"USER_EMAIL","NAME","FIRST_NAME","LAST_NAME","ZUID","CREATED_TIME","CREATED_BY_ZUID"\n"admin-001","Admin","Ad","Min","9101","t","1"\n',
  );
  writeFileSync(join(dir, 'app_manifest.xml'), '<application><name>Widget</name></application>\n');
  return dir;
}

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

/** Fake Catalyst admin REST: project detail, project-user list and the Add User POST. */
function fakeRest(existing: Record<string, unknown>[] = []): { rest: RestFn; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const rest: RestFn = async (call: RestCall) => {
    calls.push({ method: call.method, path: call.path, body: call.body });
    if (call.method === 'GET' && call.path === `${BASE}`) {
      return { status: 200, body: { data: { id: PROJECT, org_id: ORG } } };
    }
    if (call.method === 'GET' && call.path === `${BASE}/project-user`) {
      return { status: 200, body: existing };
    }
    if (call.method === 'POST' && call.path === `${BASE}/project-user`) {
      return { status: 200, body: { user_id: '10000000000000004', status: 'INVITED' } };
    }
    return { status: 404, body: {} };
  };
  return { rest, calls };
}

function makeIo(extra: Partial<Io> = {}): { io: Io; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env: { X_ZC_CREDENTIAL_PATH: '/cred-DO-NOT-PRINT' },
    spawn: async () => {
      throw new Error('spawn must not run');
    },
    fetch: async () => {
      throw new Error('fetch must not run');
    },
    accessToken: async () => 'test-token',
    ...extra,
  };
  return { io, out: () => out, err: () => err };
}

function dsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-users-ds-'));
  const path = join(dir, 'widget.ds');
  writeFileSync(path, DS);
  return path;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
}

test('backup user lists parse with synthetic identities; admins and users distinguished', () => {
  const users = readBackupUsers(backupDir());
  assert.equal(users.length, 7);
  const admin = users.find((user) => user.source === 'appAdmins');
  assert.equal(admin?.identity, 'admin-001');
  const one = users.find((user) => user.identity === 'user-001');
  assert.equal(one?.profile, 'Staff');
  assert.equal(one?.hierarchy, 'CEO');
});

test('plan maps profiles to Catalyst roles, counts per role, and collapses duplicates', () => {
  const salt = 'pepper';
  const plan = usersPlan(app(), readBackupUsers(backupDir()), { salt });
  assert.equal(plan.counts.total, 7);
  // user-004 inactive, user-001 duplicated, one empty row: 6 read -> 4 listed.
  assert.equal(plan.counts.inactive, 1);
  assert.equal(plan.counts.duplicates, 1);
  assert.equal(plan.counts.noIdentity, 1);
  assert.equal(plan.users.length, 4);
  assert.equal(plan.counts.perRole['Staff'], 1);
  assert.equal(plan.counts.perRole['Customers'], 1);
  assert.equal(plan.counts.perRole['App User'], 1);
  assert.equal(plan.counts.perRole['App Administrator'], 1);
  for (const user of plan.users) assert.match(user.id, /^usr_[0-9a-f]{16}$/);
  // Legacy_Role is not in the export: least privilege, and visible.
  assert.deepEqual(plan.unmapped, ['Legacy_Role']);
  const legacy = plan.roleMap.find((row) => row.profile === 'Legacy_Role');
  assert.equal(legacy?.catalystRole, 'App User');
  assert.match(legacy?.note ?? '', /least privilege/);
  // Staff/Customers keep their names; CEO stays a hierarchy role.
  const staff = plan.roleMap.find((row) => row.profile === 'Staff');
  assert.equal(staff?.catalystRole, 'Staff');
  assert.equal(staff?.clone, 'App User');
  const customers = plan.roleMap.find((row) => row.profile === 'Customers');
  assert.equal(customers?.portal, true);
  const ceo = plan.roleMap.find((row) => row.profile === 'CEO');
  assert.match(ceo?.note ?? '', /data-hierarchy/);
});

test('unmapped permissions become fidelity notes on the role row and the plan', () => {
  const plan = usersPlan(app(), [], { salt: 's' });
  const staff = plan.roleMap.find((row) => row.profile === 'Staff');
  assert.match(staff?.note ?? '', /Settings_Page is not a form, page or report/);
  assert.match(staff?.note ?? '', /Chat:true/);
  assert.ok(plan.notes.some((line) => line.startsWith('fidelity: Staff:')));
});

test('plan output is deterministic and writes no identity value', () => {
  const users = readBackupUsers(backupDir());
  const a = usersPlanJson(usersPlan(app(), users, { salt: 'pepper' }));
  const b = usersPlanJson(usersPlan(app(), users, { salt: 'pepper' }));
  assert.equal(a, b);
  for (const text of [a, usersPlanMarkdown(usersPlan(app(), users, { salt: 'pepper' })), usersInvitesCsv(usersPlan(app(), users, { salt: 'pepper' }))]) {
    assert.ok(!text.includes('@'), 'output contains an @-shaped address');
    assert.ok(!text.includes('user-001'), 'output contains a raw identity');
    assert.ok(!text.includes('admin-001'));
  }
  // A different salt must move every id (state mismatch guards against reuse).
  const other = usersPlan(app(), users, { salt: 'salt-2' });
  assert.notDeepEqual(
    other.users.map((user) => user.id),
    usersPlan(app(), users, { salt: 'pepper' }).users.map((user) => user.id),
  );
});

test('userRefId is salted, stable, and lower-cases the identity', () => {
  const id = userRefId('User-001', 's');
  assert.equal(id, userRefId('user-001', 's'));
  assert.match(id, /^usr_[0-9a-f]{16}$/);
  assert.notEqual(id, userRefId('user-002', 's'));
});

test('social list normalises, dedupes and refuses unknown providers', () => {
  assert.deepEqual(parseSocialList(' Zoho, google,google '), ['zoho', 'google']);
  assert.deepEqual(parseSocialList(undefined), []);
  assert.throws(() => parseSocialList('myspace'), /not a known provider/);
});

test('social plan prints console steps; zoho rides on hosted login', () => {
  const plan = usersPlan(app(), [], { salt: 's', social: ['zoho', 'google'] });
  assert.equal(plan.social.via, 'console');
  assert.ok(plan.social.steps.some((step) => /Zoho sign-in is the hosted login/.test(step)));
  assert.ok(plan.social.steps.some((step) => /Social Login — enable google/.test(step)));
  const md = usersPlanMarkdown(plan);
  assert.match(md, /## Social sign-in/);
  assert.match(md, /enable google/);
});

function targets(users: readonly BackupUser[], salt: string): InviteTarget[] {
  return users
    .filter((user) => user.source === 'appUsers' && user.identity.trim() && user.status.toLowerCase() === 'active')
    .filter((user, index, all) => all.findIndex((other) => other.identity === user.identity) === index)
    .map((user) => ({ id: userRefId(user.identity, salt), role: user.profile || 'App User', identity: user.identity, first: user.first, last: user.last }));
}

test('invite POSTs project-user with role id and Slate redirect_url; state persists per user', async () => {
  const salt = 's';
  const all = targets(readBackupUsers(backupDir()), salt).filter((t) => t.role === 'Staff');
  assert.equal(all.length, 1);
  const { rest, calls } = fakeRest();
  const persisted: unknown[][] = [];
  const result = await inviteUsers(rest, {
    projectId: PROJECT,
    targets: all,
    prior: [],
    roleIds: { Staff: '10000000000000005' },
    redirectUrl: `https://${SLATE}`,
    persist: (invited) => persisted.push([...invited]),
  });
  assert.equal(result.ok, true);
  const post = calls.find((call) => call.method === 'POST');
  assert.equal(post?.path, `${BASE}/project-user`);
  // Only the recorded Add User fields — no guessed or empty fields.
  assert.deepEqual(post?.body, {
    user_details: { email_id: 'user-001', first_name: 'First', last_name: 'Last', role_id: '10000000000000005' },
    platform_type: 'web',
    redirect_url: `https://${SLATE}`,
  });
  assert.equal(result.invited.length, 1);
  assert.equal(result.invited[0]?.userId, '10000000000000004');
  assert.equal(persisted.length, 1);
  assert.ok(!formatInviteResult(result).includes('user-001'));
});

test('invite re-run skips prior state entries and retains them', async () => {
  const salt = 's';
  const all = targets(readBackupUsers(backupDir()), salt).filter((t) => t.role === 'Staff');
  const id = all[0]!.id;
  const { rest, calls } = fakeRest();
  const result = await inviteUsers(rest, {
    projectId: PROJECT,
    targets: all,
    prior: [{ id, role: 'Staff', userId: '111' }],
    roleIds: { Staff: '1' },
    redirectUrl: `https://${SLATE}`,
  });
  assert.equal(result.rows[0]?.status, 'skipped');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  assert.deepEqual(result.invited.map((entry) => entry.userId), ['111']);
});

test('a user already on the project is verified, not re-invited', async () => {
  const salt = 's';
  const all = targets(readBackupUsers(backupDir()), salt).filter((t) => t.role === 'Staff');
  const { rest, calls } = fakeRest([{ email_id: 'user-001', user_id: '42', role_details: { role_name: 'Staff', role_id: '1' } }]);
  const result = await inviteUsers(rest, {
    projectId: PROJECT,
    targets: all,
    prior: [],
    roleIds: {},
    redirectUrl: `https://${SLATE}`,
  });
  assert.equal(result.rows[0]?.status, 'verified');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('a nameless user still POSTs a non-empty first_name derived from the identity', async () => {
  const salt = 's';
  const named = targets(readBackupUsers(backupDir()), salt).filter((t) => t.role === 'Staff');
  const nameless: InviteTarget = { id: userRefId('user-009', salt), role: 'Staff', identity: 'user-009', first: '', last: '' };
  const { rest, calls } = fakeRest();
  const result = await inviteUsers(rest, {
    projectId: PROJECT,
    targets: [...named, nameless],
    prior: [],
    roleIds: { Staff: '1' },
    redirectUrl: `https://${SLATE}`,
    retry: FAST_RETRY,
  });
  const posts = calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 2);
  for (const post of posts) {
    const first = (post.body as { user_details: { first_name: string } }).user_details.first_name;
    assert.equal(typeof first, 'string');
    assert.notEqual(first.trim(), '');
  }
  const bodies = posts.map((post) => (post.body as { user_details: { email_id: string; first_name: string } }).user_details);
  assert.equal(bodies.find((d) => d.email_id === 'user-001')?.first_name, 'First');
  assert.equal(bodies.find((d) => d.email_id === 'user-009')?.first_name, 'User');
  assert.equal(result.ok, true);
});

test('a 400 MISSING_PARAM reply is a named per-user failure; the other users still run', async () => {
  const salt = 's';
  const all = targets(readBackupUsers(backupDir()), salt).filter((t) => t.role === 'Staff' || t.role === 'Customers');
  assert.equal(all.length, 2);
  const calls: Recorded[] = [];
  const rest: RestFn = async (call: RestCall) => {
    calls.push({ method: call.method, path: call.path, body: call.body });
    if (call.method === 'GET' && call.path === `${BASE}/project-user`) return { status: 200, body: [] };
    if (call.method === 'POST' && call.path === `${BASE}/project-user`) {
      const email = (call.body as { user_details: { email_id: string } }).user_details.email_id;
      if (email === 'user-001') return { status: 400, body: { error_code: 'MISSING_PARAM', message: 'First Name is missing' } };
      return { status: 200, body: { user_id: '10000000000000004', status: 'INVITED' } };
    }
    return { status: 404, body: {} };
  };
  const result = await inviteUsers(rest, {
    projectId: PROJECT,
    targets: all,
    prior: [],
    roleIds: { Staff: '1', Customers: '2' },
    redirectUrl: `https://${SLATE}`,
    retry: FAST_RETRY,
  });
  assert.equal(result.ok, false);
  const failed = result.rows.find((row) => row.status === 'failed');
  assert.match(failed?.detail ?? '', /MISSING_PARAM/);
  assert.equal(result.rows.filter((row) => row.status === 'invited').length, 1);
  assert.equal(result.invited.length, 1);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
});

test('missing role id or redirect url is a pending console step, never a widened invite', async () => {
  const salt = 's';
  const all = targets(readBackupUsers(backupDir()), salt).filter((t) => t.role === 'Staff');
  let res = await inviteUsers(fakeRest().rest, {
    projectId: PROJECT,
    targets: all,
    prior: [],
    roleIds: {},
    redirectUrl: `https://${SLATE}`,
  });
  assert.equal(res.ok, false);
  assert.equal(res.rows[0]?.status, 'pending');
  assert.match(res.consoleSteps.join('\n'), /--role-ids 'Staff=<id>'/);
  assert.match(res.consoleSteps.join('\n'), /OAUTH_SCOPE_MISMATCH/);
  assert.match(res.consoleSteps.join('\n'), /CatalystbyZoho_List_All_Roles/);

  res = await inviteUsers(fakeRest().rest, {
    projectId: PROJECT,
    targets: all,
    prior: [],
    roleIds: { Staff: '1' },
  });
  assert.equal(res.ok, false);
  assert.equal(res.rows[0]?.status, 'pending');
  assert.match(res.consoleSteps.join('\n'), /--slate-domain/);
});

test('users plan writes plan.json, plan.md and invites.csv — none contains an @-shaped value', async () => {
  const backup = backupDir();
  const ds = dsFile();
  const out = mkdtempSync(join(tmpdir(), 'c2c-users-out-'));
  const { io, out: stdout } = makeIo();
  const code = await usersCli(['plan', '--source-backup', backup, '--ds', ds, '--out', out, '--salt', 'fixed', '--social', 'zoho,google'], io);
  assert.equal(code, 0);
  for (const rel of [USERS_PLAN_JSON, USERS_PLAN_MD, USERS_INVITES_CSV]) {
    const text = readFileSync(join(out, rel), 'utf8');
    assert.ok(!text.includes('@'), `${rel} contains an @-shaped address`);
    assert.ok(!text.includes('user-00'), `${rel} contains a raw identity`);
  }
  const plan = JSON.parse(readFileSync(join(out, USERS_PLAN_JSON), 'utf8')) as { counts: { pending: number } };
  assert.equal(plan.counts.pending, 4);
  assert.ok(!stdout().includes('user-00'));
});

test('users rejects --dry-run and unknown subcommands', async () => {
  const backup = backupDir();
  const ds = dsFile();
  let { io, err } = makeIo();
  assert.equal(await usersCli(['plan', '--source-backup', backup, '--ds', ds, '--dry-run'], io), 2);
  assert.match(err(), /--dry-run/);
  ({ io, err } = makeIo());
  assert.equal(await usersCli(['bogus', '--source-backup', backup, '--ds', ds], io), 2);
  assert.match(err(), /usage:/);
});

test('users invite without --confirm is a dry print and sends nothing', async () => {
  const backup = backupDir();
  const ds = dsFile();
  const { rest, calls } = fakeRest();
  const { io, err } = makeIo({ rest });
  const code = await usersCli(['invite', '--source-backup', backup, '--ds', ds, '--salt', 's'], io);
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  assert.match(err(), /dry print/);
});

test('users invite --confirm drives the fake driver, writes state, and a re-run skips', async () => {
  const backup = backupDir();
  const ds = dsFile();
  const dir = mkdtempSync(join(tmpdir(), 'c2c-users-run-'));
  const state = join(dir, 'state.json');
  const args = [
    'invite',
    '--source-backup',
    backup,
    '--ds',
    ds,
    '--salt',
    's',
    '--org',
    ORG,
    '--project',
    PROJECT,
    '--dc',
    'in',
    '--slate-domain',
    SLATE,
    '--role-ids',
    'Staff=3001,Customers=3002,App User=3003,App Administrator=3004',
    '--state',
    state,
    '--confirm',
  ];
  const { rest, calls } = fakeRest();
  let { io, out } = makeIo({ rest });
  assert.equal(await usersCli(args, io), 0);
  const posts = calls.filter((call) => call.method === 'POST' && call.path.endsWith('/project-user'));
  // user-001 Staff, user-002 Customers, user-003 Legacy_Role -> App User, admin-001 -> App Administrator.
  assert.equal(posts.length, 4);
  assert.match(out(), /usr_[0-9a-f]{16}/);
  assert.ok(!out().includes('user-00'));
  const saved = readUsersState(state);
  assert.equal(saved?.invited.length, 4);
  assert.equal(saved?.project, PROJECT);

  // Re-run: every user is skipped, nothing is POSTed.
  ({ io, out } = makeIo({ rest }));
  calls.length = 0;
  assert.equal(await usersCli(args, io), 0);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  assert.match(out(), /skipped/);

  // A changed salt against the existing state file is refused.
  let errText = '';
  ({ io } = makeIo({ rest }));
  io.stderr = (text) => {
    errText += text;
  };
  const code = await usersCli(args.map((arg, index) => (args[index - 1] === '--salt' ? 'other-salt' : arg)), io);
  assert.equal(code, 2);
  assert.match(errText, /different salt/);
});

test('writeUsersState round-trips and sorts ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-users-state-'));
  const path = join(dir, 'nested', 'state.json');
  writeUsersState(path, {
    version: 1,
    project: PROJECT,
    salt: 'ab',
    invited: [
      { id: 'usr_b', role: 'Staff' },
      { id: 'usr_a', role: 'Staff', userId: '9' },
    ],
  });
  const back = readUsersState(path);
  assert.deepEqual(back?.invited.map((entry) => entry.id), ['usr_a', 'usr_b']);
  assert.ok(statSync(path).isFile());
});

/* -------- built-in role collisions, salt custody, project binding -------- */

/** Instant retry clock for invite tests — behaviour is what matters, not the backoff. */
const FAST_RETRY: RetryOptions = { sleep: async () => {}, random: () => 0 };

/** Profiles whose names spell Catalyst built-in roles, exactly as a backup can carry them. */
const DS_BUILTIN = `application "Widget"
{
	share_settings
	{
		"App Administrator"
		{
			name = "App Administrator"
			type = Users_Permissions
			ModulePermissions
			{
				Item
				{
					enabled = true
					ReportPermissions
					{
						All_Items = {"View"}
					}
				}
			}
		}
		"App User"
		{
			name = "App User"
			type = Users_Permissions
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
`;

function builtinApp() {
  return deriveIr(parse(DS_BUILTIN));
}


/** Backup rows whose PROFILE_NAME folds onto the built-ins four ways, plus one unmapped row. */
function builtinBackupDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-users-builtin-'));
  const chunk = join(dir, 'data', 'data_1');
  mkdirSync(chunk, { recursive: true });
  writeFileSync(
    join(chunk, 'appUsers.csv'),
    [
      '"USER_EMAIL","NAME","FIRST_NAME","LAST_NAME","USER_TYPE","USER_STATUS","PROFILE_NAME","ROLE_NAME","ZUID"',
      '"user-101","N1","F1","L1","Z","Active","App Administrator","","1"',
      '"user-102","N2","F2","L2","Z","Active","app  administrator","","2"',
      '"user-103","N3","F3","L3","Z","Active","APP-ADMINISTRATOR","","3"',
      '"user-104","N4","F4","L4","Z","Active","App User","","4"',
      '"user-105","N5","F5","L5","Z","Active","Legacy_Role","","5"',
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(chunk, 'appAdmins.csv'),
    '"USER_EMAIL","NAME","FIRST_NAME","LAST_NAME","ZUID","CREATED_TIME","CREATED_BY_ZUID"\n"admin-101","Admin","Ad","Min","9101","t","1"\n',
  );
  writeFileSync(join(dir, 'app_manifest.xml'), '<application><name>Widget</name></application>\n');
  return dir;
}

test('a profile whose name spells a built-in role maps to a distinct custom role, never the built-in', () => {
  const plan = usersPlan(builtinApp(), readBackupUsers(builtinBackupDir()), { salt: 's' });
  // 'App Administrator', 'app  administrator' and 'APP-ADMINISTRATOR' all fold
  // onto the built-in — each lands on the custom role, which keeps the
  // profile's own grants; 'App User' the profile does the same.
  assert.equal(plan.counts.perRole['Creator App Administrator'], 3);
  assert.equal(plan.counts.perRole['Creator App User'], 1);
  // Only appAdmins.csv maps to the built-in administrator; a profile absent
  // from the export still falls back to least privilege.
  assert.equal(plan.counts.perRole['App Administrator'], 1);
  assert.equal(plan.counts.perRole['App User'], 1);
  const admin = plan.roleMap.find((row) => row.profile === 'App Administrator');
  assert.equal(admin?.catalystRole, 'Creator App Administrator');
  assert.match(admin?.note ?? '', /built-in/);
  const user = plan.roleMap.find((row) => row.profile === 'App User' && row.clone !== 'builtin');
  assert.equal(user?.catalystRole, 'Creator App User');
  // The custom role carries exactly the profile's grant — 'App Administrator'
  // the profile only had View on Item, and a generated access policy keyed by
  // the profile name is what enforces it.
  for (const entry of plan.users) {
    if (entry.via === 'appUsers') assert.notEqual(entry.role, 'App Administrator', 'an appUsers row mapped onto the built-in');
  }
});

test('invite posts the custom role id for a colliding profile, never the built-in id', async () => {
  const salt = 's';
  const users = readBackupUsers(builtinBackupDir());
  const plan = usersPlan(builtinApp(), users, { salt });
  const planned = new Map(plan.users.map((user) => [user.id, user.role]));
  const targets: InviteTarget[] = users
    .filter((user) => user.source === 'appUsers' && user.identity.trim() && user.status.toLowerCase() === 'active')
    .map((user) => ({ id: userRefId(user.identity, salt), role: planned.get(userRefId(user.identity, salt)) ?? '', identity: user.identity, first: user.first, last: user.last }))
    .filter((target) => target.role);
  const { rest, calls } = fakeRest();
  await inviteUsers(rest, {
    projectId: PROJECT,
    targets,
    prior: [],
    roleIds: { 'App Administrator': '900001', 'App User': '900002', 'Creator App Administrator': '700001', 'Creator App User': '700002' },
    redirectUrl: `https://${SLATE}`,
    retry: FAST_RETRY,
  });
  const posted = calls
    .filter((call) => call.method === 'POST')
    .map((call) => (call.body as { user_details: { role_id: string } }).user_details.role_id);
  // 'App User' (900002) appears only for the unmapped Legacy_Role fallback; the
  // built-in administrator id is never sent for an appUsers row.
  assert.deepEqual([...new Set(posted)].sort(), ['700001', '700002', '900002']);
});

test('the salt lives only in the state file — plan output cannot rebuild the ids', async () => {
  const backup = backupDir();
  const ds = dsFile();
  const out = mkdtempSync(join(tmpdir(), 'c2c-users-out-'));
  const { io } = makeIo();
  assert.equal(await usersCli(['plan', '--source-backup', backup, '--ds', ds, '--out', out], io), 0);
  const plan = JSON.parse(readFileSync(join(out, USERS_PLAN_JSON), 'utf8')) as { app?: string; saltHash?: string; users: { id: string }[] };
  assert.equal(plan.saltHash, undefined, 'plan.json still publishes a fingerprint of the salt');
  const state = readUsersState(join(out, USERS_STATE_FILE));
  assert.match(state?.salt ?? '', /^[0-9a-f]{64}$/, 'the state file does not carry a generated 256-bit salt');
  // No artefact but the state file may contain the salt.
  for (const file of walkFiles(out)) {
    if (file.endsWith(USERS_STATE_FILE)) continue;
    assert.ok(!readFileSync(file, 'utf8').includes(state?.salt ?? ' '), `${file} leaks the salt`);
  }
  // Rebuilding ids from the plan alone fails: every derivable guess misses.
  const guesses = ['', 'Widget', `c2c-users-v1:${plan.app ?? 'Widget'}`];
  const ids = new Set(plan.users.map((user) => user.id));
  for (const identity of ['user-001', 'user-002', 'user-003', 'admin-001']) {
    for (const guess of guesses) assert.ok(!ids.has(userRefId(identity, guess)), `rebuilt an id from plan output with ${JSON.stringify(guess)}`);
  }
});

test('a missing state file mints a new salt with a note that earlier ids will not match', async () => {
  const backup = backupDir();
  const ds = dsFile();
  const out = mkdtempSync(join(tmpdir(), 'c2c-users-out-'));
  const run = async () => {
    const { io, err } = makeIo();
    assert.equal(await usersCli(['plan', '--source-backup', backup, '--ds', ds, '--out', out], io), 0);
    return { plan: JSON.parse(readFileSync(join(out, USERS_PLAN_JSON), 'utf8')) as { users: { id: string }[] }, err: err() };
  };
  const first = await run();
  assert.match(first.err, /salt/);
  const second = await run();
  // The state file kept the salt: ids are stable across runs.
  assert.deepEqual(
    second.plan.users.map((user) => user.id),
    first.plan.users.map((user) => user.id),
  );
  rmSync(join(out, USERS_STATE_FILE));
  const third = await run();
  assert.notDeepEqual(
    third.plan.users.map((user) => user.id),
    first.plan.users.map((user) => user.id),
  );
  assert.match(third.err, /salt/);
});

test('a pre-existing state file without a salt gets one and keeps its invited ids', async () => {
  const backup = backupDir();
  const ds = dsFile();
  const out = mkdtempSync(join(tmpdir(), 'c2c-users-out-'));
  const state = join(out, USERS_STATE_FILE);
  writeFileSync(state, `${JSON.stringify({ version: 1, project: PROJECT, invited: [{ id: 'usr_old', role: 'Staff' }] }, null, 2)}\n`);
  const { io, err } = makeIo();
  assert.equal(await usersCli(['plan', '--source-backup', backup, '--ds', ds, '--out', out], io), 0);
  const saved = readUsersState(state);
  assert.match(saved?.salt ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(
    saved?.invited.map((entry) => entry.id),
    ['usr_old'],
  );
  assert.equal(saved?.project, PROJECT);
  assert.match(err(), /salt/);
});

test('invite refuses a state file written for a different project', async () => {
  const backup = backupDir();
  const ds = dsFile();
  const dir = mkdtempSync(join(tmpdir(), 'c2c-users-run-'));
  const state = join(dir, 'state.json');
  // Written by hand so both the salt and its legacy fingerprint match — the
  // refusal must be about the project, not the salt.
  writeFileSync(
    state,
    `${JSON.stringify(
      {
        version: 1,
        project: '10000000000000099',
        salt: 's',
        saltHash: createHash('sha256').update('s', 'utf8').digest('hex').slice(0, 16),
        invited: [{ id: 'usr_x', role: 'Staff' }],
      },
      null,
      2,
    )}\n`,
  );
  const { rest, calls } = fakeRest();
  const { io, err } = makeIo({ rest });
  const code = await usersCli(
    [
      'invite',
      '--source-backup',
      backup,
      '--ds',
      ds,
      '--salt',
      's',
      '--org',
      ORG,
      '--project',
      PROJECT,
      '--dc',
      'in',
      '--slate-domain',
      SLATE,
      '--state',
      state,
      '--confirm',
    ],
    io,
  );
  assert.equal(code, 2);
  assert.match(err(), /state/);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('the deploy report appUrl is refused when the report is for another project', async () => {
  const backup = backupDir();
  const ds = dsFile();
  const dir = mkdtempSync(join(tmpdir(), 'c2c-users-run-'));
  const state = join(dir, 'state.json');
  writeFileSync(join(dirname(ds), DEPLOY_REPORT), `${JSON.stringify({ projectId: '10000000000000099', slate: { appUrl: 'https://other.onslate.in' } })}\n`);
  const { rest, calls } = fakeRest();
  const { io, err } = makeIo({ rest });
  const code = await usersCli(
    [
      'invite',
      '--source-backup',
      backup,
      '--ds',
      ds,
      '--salt',
      's',
      '--org',
      ORG,
      '--project',
      PROJECT,
      '--dc',
      'in',
      '--role-ids',
      'Staff=1,Customers=2,App User=3,App Administrator=4',
      '--state',
      state,
      '--confirm',
    ],
    io,
  );
  assert.equal(code, 2);
  assert.match(err(), /deploy report/);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('the deploy report appUrl supplies redirect_url only when the project id matches', async () => {
  const backup = backupDir();
  const ds = dsFile();
  const dir = mkdtempSync(join(tmpdir(), 'c2c-users-run-'));
  const state = join(dir, 'state.json');
  writeFileSync(join(dirname(ds), DEPLOY_REPORT), `${JSON.stringify({ projectId: PROJECT, slate: { appUrl: `https://${SLATE}/` } })}\n`);
  const { rest, calls } = fakeRest();
  const { io } = makeIo({ rest });
  const code = await usersCli(
    [
      'invite',
      '--source-backup',
      backup,
      '--ds',
      ds,
      '--salt',
      's',
      '--org',
      ORG,
      '--project',
      PROJECT,
      '--dc',
      'in',
      '--role-ids',
      'Staff=1,Customers=2,App User=3,App Administrator=4',
      '--state',
      state,
      '--confirm',
    ],
    io,
  );
  assert.equal(code, 0);
  const posts = calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 4);
  for (const post of posts) assert.equal((post.body as { redirect_url?: string }).redirect_url, `https://${SLATE}`);
});

test('a server error echoing a submitted identity or name is redacted', async () => {
  const salt = 's';
  const all = targets(readBackupUsers(backupDir()), salt).filter((target) => target.role === 'Staff');
  const rest: RestFn = async (call) => {
    if (call.method === 'GET' && call.path === `${BASE}/project-user`) return { status: 200, body: [] };
    if (call.method === 'POST') return { status: 400, body: { error_code: 'VALIDATION_ERROR', message: 'duplicate entry for First Last user-001' } };
    return { status: 404, body: {} };
  };
  const result = await inviteUsers(rest, {
    projectId: PROJECT,
    targets: all,
    prior: [],
    roleIds: { Staff: '1' },
    redirectUrl: `https://${SLATE}`,
    retry: FAST_RETRY,
  });
  assert.equal(result.rows[0]?.status, 'failed');
  assert.ok(!result.rows[0]?.detail?.includes('user-001'), result.rows[0]?.detail);
  assert.ok(!result.rows[0]?.detail?.includes('First'), result.rows[0]?.detail);
  assert.ok(!result.rows[0]?.detail?.includes('Last'), result.rows[0]?.detail);
});

test('a transient 5xx re-reads project users and re-sends only when absent', async () => {
  const salt = 's';
  const all = targets(readBackupUsers(backupDir()), salt).filter((target) => target.role === 'Staff');
  const calls: Recorded[] = [];
  let landed = false;
  let posts = 0;
  const rest: RestFn = async (call) => {
    calls.push({ method: call.method, path: call.path, body: call.body });
    if (call.method === 'GET' && call.path === `${BASE}/project-user`) {
      return { status: 200, body: landed ? [{ email_id: 'user-001', user_id: '42' }] : [] };
    }
    if (call.method === 'POST') {
      posts += 1;
      if (posts === 1) return { status: 500, body: { message: 'upstream error' } };
      return { status: 200, body: { user_id: '77' } };
    }
    return { status: 404, body: {} };
  };
  const result = await inviteUsers(rest, {
    projectId: PROJECT,
    targets: all,
    prior: [],
    roleIds: { Staff: '1' },
    redirectUrl: `https://${SLATE}`,
    retry: FAST_RETRY,
  });
  assert.equal(result.rows[0]?.status, 'invited');
  assert.equal(posts, 2);
  // The re-read ran between the attempts, not a blind re-send.
  assert.deepEqual(
    calls.map((call) => call.method),
    ['GET', 'POST', 'GET', 'POST'],
  );
});

test('a write that landed under a 5xx is not re-sent — the re-read verifies it', async () => {
  const salt = 's';
  const all = targets(readBackupUsers(backupDir()), salt).filter((target) => target.role === 'Staff');
  const calls: Recorded[] = [];
  let posts = 0;
  const rest: RestFn = async (call) => {
    calls.push({ method: call.method, path: call.path, body: call.body });
    if (call.method === 'GET' && call.path === `${BASE}/project-user`) {
      // The failed POST actually landed — the re-read proves it.
      return { status: 200, body: posts > 0 ? [{ email_id: 'user-001', user_id: '42' }] : [] };
    }
    if (call.method === 'POST') {
      posts += 1;
      return { status: 500, body: { message: 'upstream error' } };
    }
    return { status: 404, body: {} };
  };
  const result = await inviteUsers(rest, {
    projectId: PROJECT,
    targets: all,
    prior: [],
    roleIds: { Staff: '1' },
    redirectUrl: `https://${SLATE}`,
    retry: FAST_RETRY,
  });
  assert.equal(posts, 1);
  assert.equal(result.rows[0]?.status, 'invited');
  assert.equal(result.invited[0]?.userId, '42');
});

/** backupDir() with one row's identity swapped — synthetic identities only. */
function backupWith(from: string, to: string): string {
  const dir = backupDir();
  const csv = join(dir, 'data', 'data_1', 'appUsers.csv');
  writeFileSync(csv, readFileSync(csv, 'utf8').replace(`"${from}"`, `"${to}"`));
  return dir;
}

test("users plan and invite refuse a planned '+' address before any file or request, naming the user by id", async () => {
  const backup = backupWith('user-002', 'user+tag-002');
  const ds = dsFile();
  const out = mkdtempSync(join(tmpdir(), 'c2c-users-plus-'));
  let { io, err, out: stdout } = makeIo();
  assert.equal(await usersCli(['plan', '--source-backup', backup, '--ds', ds, '--out', out, '--salt', 's'], io), 2);
  assert.match(err(), /^c2c: users usr_[0-9a-f]{16}: the email contains '\+'/);
  assert.match(err(), /Email Id cannot contain '\+' character/);
  assert.ok(!err().includes('user+tag'), 'the identity is never printed');
  assert.ok(!stdout().includes('user+tag'));
  assert.deepEqual(readdirSync(out), [], 'nothing is written');

  const { rest, calls } = fakeRest();
  ({ io, err } = makeIo({ rest }));
  const code = await usersCli(
    ['invite', '--source-backup', backup, '--ds', ds, '--salt', 's', '--org', ORG, '--project', PROJECT, '--dc', 'in', '--slate-domain', SLATE, '--role-ids', 'Staff=1,Customers=2,App User=3,App Administrator=4', '--state', join(out, 'state.json'), '--confirm'],
    io,
  );
  assert.equal(code, 2);
  assert.equal(calls.length, 0, 'no request is sent');
  assert.match(err(), /Catalyst Add User rejects a '\+'/);
});

test("a '+' on a user the plan skips (inactive) does not block the plan", async () => {
  const backup = backupWith('user-004', 'user+tag-004');
  const { io } = makeIo();
  assert.equal(await usersCli(['plan', '--source-backup', backup, '--ds', dsFile(), '--salt', 's'], io), 0);
  assert.deepEqual(plusAddressIds([{ id: 'usr_b', identity: 'a+b' }, { id: 'usr_a', identity: 'a+c' }, { id: 'usr_c', identity: 'plain' }]), ['usr_a', 'usr_b']);
});

test("inviteUsers never POSTs a '+' address; the other users still run", async () => {
  const users = readBackupUsers(backupWith('user-002', 'user+tag-002'));
  const all = targets(users, 's').filter((t) => t.role === 'Staff' || t.role === 'Customers');
  assert.equal(all.length, 2);
  const { rest, calls } = fakeRest();
  const res = await inviteUsers(rest, { projectId: PROJECT, targets: all, prior: [], roleIds: { Staff: '1', Customers: '2' }, redirectUrl: `https://${SLATE}` });
  assert.equal(res.ok, false);
  const posts = calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.ok(!JSON.stringify(posts).includes('+'));
  const plusRow = res.rows.find((row) => row.role === 'Customers');
  assert.equal(plusRow?.status, 'failed');
  assert.match(plusRow?.detail ?? '', /Email Id cannot contain/);
  assert.ok(!formatInviteResult(res).includes('user+tag'));
});

test('17-digit role ids round-trip exactly: --role-ids reaches the POST body unchanged', async () => {
  const backup = backupDir();
  const ds = dsFile();
  const dir = mkdtempSync(join(tmpdir(), 'c2c-users-ids-'));
  const { rest, calls } = fakeRest();
  const { io } = makeIo({ rest });
  const code = await usersCli(
    ['invite', '--source-backup', backup, '--ds', ds, '--salt', 's', '--org', ORG, '--project', PROJECT, '--dc', 'in', '--slate-domain', SLATE,
      '--role-ids', 'App Administrator=10000000000000005,Staff=10000000000000003,Customers=3002,App User=3003', '--state', join(dir, 'state.json'), '--confirm'],
    io,
  );
  assert.equal(code, 0);
  const roleIds = calls
    .filter((call) => call.method === 'POST')
    .map((call) => (call.body as { user_details: { role_id: unknown } }).user_details.role_id);
  assert.ok(roleIds.includes('10000000000000005'));
  assert.ok(roleIds.includes('10000000000000003'));
  for (const id of roleIds) assert.equal(typeof id, 'string');
});

test('role ids parsed from MCP/REST text stay exact strings; a rounded JSON number is refused', () => {
  // The two ids collapse to one double — the reason ids are never numbers.
  assert.equal(Number('10000000000000005'), Number('10000000000000003'));
  const text = '[{"role_details":{"role_name":"App Administrator","role_id":10000000000000005}},{"role_details":{"role_name":"App User","role_id":"10000000000000003"}}]';
  const exact = parseJsonExact(text) as Record<string, unknown>[];
  assert.equal(roleIdFromUsers(exact, 'App Administrator'), '10000000000000005');
  assert.equal(roleIdFromUsers(exact, 'App User'), '10000000000000003');
  // Mutation case: plain JSON.parse rounds the number; the id is refused, not sent wrong.
  const rounded = JSON.parse(text) as Record<string, unknown>[];
  assert.equal(roleIdFromUsers(rounded, 'App Administrator'), undefined);
  assert.equal(roleIdFromUsers(rounded, 'App User'), '10000000000000003');
  assert.equal(idString(10000000000000005), undefined);
  assert.equal(idString('10000000000000005'), '10000000000000005');
  assert.equal(idString(3001), '3001');
});
