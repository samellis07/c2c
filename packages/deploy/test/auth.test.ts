import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adminFirstName,
  applyAuthProvision,
  authConfig,
  authProvisionPlan,
  corsDomains,
  errorCode,
  formatAuthProvision,
  hostOf,
  projectUsers,
  sanitizeMessage,
  slateUrlFrom,
  addUserValues,
  type AuthProvisionInput,
} from '../src/auth.js';
import type { RestCall, RestFn } from '../src/tables.js';

const PROJECT = '10000000000000001';
const BASE = `/baas/v1/project/${PROJECT}`;
const SLATE = 'c2c-demo-app-abc123.onslate.in';
const ADMIN_EMAIL = 'owner@example.test';
const ADMIN_ROLE_ID = '10000000000000002';

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * Fake Catalyst admin REST answering with the documented response shapes.
 * `handlers` overrides per
 * "<method> <path-prefix>" so a test can refuse a specific op.
 */
function fakeRest(handlers: Record<string, { status: number; body: unknown }> = {}): { rest: RestFn; calls: Recorded[]; acceptInvite: (email?: string) => void } {
  const calls: Recorded[] = [];
  let nextUserId = 10000000000000004;
  let users: Record<string, unknown>[] = [];
  const userPath = /^\/project-user\/([^/?]+)$/;
  const acceptInvite = (email = ADMIN_EMAIL) => {
    users = users.map((user) => (user.email_id === email ? { ...user, is_confirmed: true } : user));
  };
  const rest: RestFn = async (call: RestCall) => {
    calls.push({ method: call.method, path: call.path, body: call.body });
    const rel = call.path.replace(BASE, '');
    const override = handlers[`${call.method} ${rel.split('?')[0]}`] ?? handlers[`${call.method} ${rel}`];
    if (override) return override;
    if (call.method === 'GET' && call.path.endsWith('/role')) {
      return { status: 401, body: { status: 'failure', data: { error_code: 'OAUTH_SCOPE_MISMATCH', message: 'You are not authorized to perform this operation' } } };
    }
    if (call.method === 'GET' && call.path.endsWith('/project-user')) {
      // Live project-user list hides invited users until they confirm.
      return { status: 200, body: users.filter((user) => user.is_confirmed === true) };
    }
    const detail = call.method === 'GET' ? userPath.exec(rel) : null;
    if (detail) {
      const user = users.find((entry) => entry.user_id === detail[1]);
      return user ? { status: 200, body: { data: user } } : { status: 404, body: { data: { error_code: 'INVALID_USER' } } };
    }
    // The CLI token cannot read auth config or the domain list;
    // tests that exercise a wider-scoped token override these handlers.
    if (call.method === 'GET' && call.path.endsWith('/authentication/configuration')) {
      return { status: 401, body: { status: 'failure', data: { error_code: 'OAUTH_SCOPE_MISMATCH', message: 'You are not authorized to perform this operation' } } };
    }
    if (call.method === 'GET' && call.path.endsWith('/cors-domain')) {
      return { status: 401, body: { status: 'failure', data: { error_code: 'OAUTH_SCOPE_MISMATCH', message: 'You are not authorized to perform this operation' } } };
    }
    if (call.method === 'POST' && call.path.endsWith('/authentication/enable?auth_type=hosted')) {
      return { status: 200, body: { hosted_auth: true, embedded_auth: false, public_signup: false, app_account_meta: {} } };
    }
    if (call.method === 'POST' && call.path.endsWith('/authentication/enable?auth_type=embedded')) {
      return { status: 200, body: { hosted_auth: true, embedded_auth: true, public_signup: false } };
    }
    if (call.method === 'POST' && call.path.endsWith('/cors-domain')) {
      return { status: 200, body: { id: '10000000000000003', cors: true, iframe: true } };
    }
    if (call.method === 'POST' && call.path.endsWith('/project-user')) {
      const details = (call.body as { user_details: { email_id: string; role_id?: string | number } }).user_details;
      const existing = users.find((user) => user.email_id === details.email_id);
      if (existing) return { status: 400, body: { data: { error_code: 'DUPLICATE_VALUE', message: 'User already exists' } } };
      const userId = String(nextUserId++);
      users.push({
        user_id: userId,
        email_id: details.email_id,
        role_details: { role_name: 'App Administrator', role_id: String(details.role_id ?? ADMIN_ROLE_ID) },
        is_confirmed: false,
        source: 'Email',
      });
      return { status: 200, body: { data: { user_details: { user_id: userId, email_id: details.email_id, is_confirmed: false } } } };
    }
    return { status: 404, body: {} };
  };
  return { rest, calls, acceptInvite };
}

const input: AuthProvisionInput = {
  projectId: PROJECT,
  slateDomain: SLATE,
  admin: { email: ADMIN_EMAIL, name: 'Owner' },
};

/** A token with role-read scope; the CLI token is refused (the fake's default). */
const ROLE_READ = {
  'GET /role': { status: 200, body: { data: [{ role_name: 'App Administrator', role_id: ADMIN_ROLE_ID }] } },
};

/** The exact console Add User block for the test project. */
const VALUES_BLOCK = [
  'Authentication > User Management > Users > Add User — enter exactly:',
  '  Email: <admin-email> (the --admin-email address)',
  '  Role: App Administrator',
  '  Platform: Web',
  '  Component: Slate',
  '  Slate App: <the Slate app this deploy created>',
  '  Deployment: default',
  `  Redirect URL: https://${SLATE}`,
].join('\n');

test('the dry-run plan lists the recorded calls and sends nothing', () => {
  const ops = authProvisionPlan(input);
  assert.deepEqual(
    ops.map((op) => `${op.call.method} ${op.call.path}`),
    [
      `GET ${BASE}/project-user`,
      `GET ${BASE}/authentication/configuration`,
      `POST ${BASE}/authentication/enable?auth_type=hosted`,
      `POST ${BASE}/authentication/enable?auth_type=embedded`,
      `GET ${BASE}/cors-domain`,
      `POST ${BASE}/cors-domain`,
      `GET ${BASE}/role`,
      `POST ${BASE}/project-user`,
    ],
  );
  assert.deepEqual(ops[2]?.call.body, { public_signup: false });
  assert.deepEqual(ops[3]?.call.body, {});
  assert.deepEqual(ops[5]?.call.body, { domain: SLATE, cors: true, iframe: true });
  // Only the recorded Add User fields — no guessed org_id.
  assert.deepEqual(ops[7]?.call.body, {
    platform_type: 'web',
    redirect_url: `https://${SLATE}`,
    user_details: { email_id: ADMIN_EMAIL, first_name: 'Owner', last_name: '', role_id: '<App Administrator role id>' },
  });
  // No admin input → no invite call is armed and the only human step is the CLI flag.
  const bare = authProvisionPlan({ projectId: PROJECT });
  assert.equal((bare.at(-1)?.call.body === undefined), true);
  assert.match(bare.at(-1)?.note ?? '', /--admin-email/);
  assert.doesNotMatch(bare.at(-1)?.note ?? '', /console Add User/);
  // The invite always carries redirect_url — without the Slate URL the mailed
  // link lands on a page that does not exist.
  const noHost = authProvisionPlan({ projectId: PROJECT, admin: { email: ADMIN_EMAIL, roleId: ADMIN_ROLE_ID } });
  assert.deepEqual((noHost.at(-1)?.call.body as { redirect_url?: string })?.redirect_url, 'https://<slate-domain>');
});

test('hosted + embedded enable, CORS domain, role id and admin invite apply in order', async () => {
  const { rest, calls } = fakeRest(ROLE_READ);
  const result = await applyAuthProvision(rest, input);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      `GET ${BASE}/project-user`,
      `GET ${BASE}/authentication/configuration`,
      `POST ${BASE}/authentication/enable?auth_type=hosted`,
      `POST ${BASE}/authentication/enable?auth_type=embedded`,
      `GET ${BASE}/cors-domain`,
      `POST ${BASE}/cors-domain`,
      `GET ${BASE}/role`,
      `POST ${BASE}/project-user`,
      `GET ${BASE}/project-user/10000000000000004`,
    ],
  );
  // Exact recorded request bodies. The config read is refused for the CLI
  // token, so public_signup is omitted rather than written over an unknown
  // user setting.
  assert.deepEqual(calls[2]?.body, {});
  assert.deepEqual(calls[3]?.body, {});
  assert.deepEqual(calls[5]?.body, { domain: SLATE, cors: true, iframe: true });
  // The invite carries only the recorded Add User fields — no guessed org_id.
  assert.deepEqual(calls[7]?.body, {
    platform_type: 'web',
    redirect_url: `https://${SLATE}`,
    user_details: { email_id: ADMIN_EMAIL, first_name: 'Owner', last_name: '', role_id: ADMIN_ROLE_ID },
  });
  assert.deepEqual(
    result.results.map((op) => `${op.id}:${op.status}`),
    ['enable-hosted:applied', 'enable-embedded:applied', 'cors-domain:applied', 'admin-signup:applied', 'verify-users:pending'],
  );
  assert.deepEqual(result.done, ['admin-signup', 'cors-domain', 'enable-embedded', 'enable-hosted']);
  assert.equal(result.adminUserId, '10000000000000004');
  assert.equal(calls.some((call) => call.path.endsWith('/project-user/signup')), false);
  assert.match(result.results.find((op) => op.id === 'verify-users')?.console ?? '', /accept the emailed invite/);
});

test('a fresh project (GET /role refused, no users) sends no invite and prints the exact Add User values block', async () => {
  const { rest, calls } = fakeRest();
  const result = await applyAuthProvision(rest, input);
  // No export job, no guessed body: the only role read is GET /role.
  assert.equal(calls.some((call) => call.path.includes('/export')), false);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path.endsWith('/project-user')), false);
  const signup = result.results.find((op) => op.id === 'admin-signup');
  assert.equal(signup?.status, 'pending');
  assert.equal(addUserValues('App Administrator', SLATE), VALUES_BLOCK);
  // One block, copy-pasteable, inside the console step.
  assert.ok(signup?.console?.includes(`\n${VALUES_BLOCK}\n`), signup?.console);
  assert.match(signup?.console ?? '', /On a fresh project this console Add User step is the path today/);
  assert.equal(result.consoleSteps.filter((step) => step.includes('Add User — enter exactly:')).length, 1);
  assert.ok(formatAuthProvision(result).includes(VALUES_BLOCK));
  assert.equal(formatAuthProvision(result).includes(ADMIN_EMAIL), false);
});

test('an export-shaped answer is never read for a role id', async () => {
  // Even a project whose export would answer is never asked: no export call is
  // made, so no unrecorded template shape can supply an id.
  const { rest, calls } = fakeRest({
    'POST /export': { status: 200, body: { data: { status: 'Completed' } } },
    'GET /export/status': { status: 200, body: { data: { status: 'Completed', progress: 100 } } },
    'GET /export/download': {
      status: 200,
      body: { components: { Authentication: [{ type: 'roles', name: 'App Administrator', properties: { id: ADMIN_ROLE_ID } }] } },
    },
  });
  const result = await applyAuthProvision(rest, input);
  assert.equal(calls.some((call) => call.path.includes('/export')), false);
  assert.equal(result.results.find((op) => op.id === 'admin-signup')?.status, 'pending');
  assert.equal(authProvisionPlan(input).some((op) => op.call.path.includes('/export')), false);
});

test('a role-readable token uses GET /role for the invite', async () => {
  const { rest, calls } = fakeRest(ROLE_READ);
  const result = await applyAuthProvision(rest, input);
  assert.equal(result.results.find((op) => op.id === 'admin-signup')?.status, 'applied');
  const invite = calls.find((call) => call.method === 'POST' && call.path.endsWith('/project-user'));
  assert.equal((invite?.body as { user_details: { role_id: string } }).user_details.role_id, ADMIN_ROLE_ID);
  assert.equal('org_id' in (invite?.body as { user_details: Record<string, unknown> }).user_details, false);
});

test('when GET /role is scope-refused, an existing user detail supplies the role id', async () => {
  const { rest, calls } = fakeRest({
    'GET /project-user': {
      status: 200,
      body: { data: [{ user_id: '10000000000000007', email_id: 'prior@example.test' }] },
    },
    'GET /project-user/10000000000000007': {
      status: 200,
      body: { data: { user_id: '10000000000000007', email_id: 'prior@example.test', role_details: { role_name: 'App Administrator', role_id: ADMIN_ROLE_ID } } },
    },
  });
  const result = await applyAuthProvision(rest, input);
  assert.equal(result.results.find((op) => op.id === 'admin-signup')?.status, 'applied');
  const detailReads = calls.filter((call) => call.method === 'GET' && call.path.endsWith('/project-user/10000000000000007'));
  assert.ok(detailReads.length >= 1);
  const invite = calls.find((call) => call.method === 'POST' && call.path.endsWith('/project-user'));
  assert.equal((invite?.body as { user_details: { role_id: string } }).user_details.role_id, ADMIN_ROLE_ID);
});

test('invite verification reports unconfirmed, then confirmed after the human accepts — no resend', async () => {
  const { rest, calls, acceptInvite } = fakeRest(ROLE_READ);
  const first = await applyAuthProvision(rest, input);
  assert.equal(first.results.find((op) => op.id === 'verify-users')?.status, 'pending');
  assert.equal(first.adminUserId, '10000000000000004');
  acceptInvite();
  const before = calls.length;
  const second = await applyAuthProvision(rest, { ...input, done: first.done, adminUserId: first.adminUserId });
  const secondCalls = calls.slice(before);
  assert.equal(second.results.find((op) => op.id === 'verify-users')?.status, 'verified');
  assert.equal(secondCalls.some((call) => call.method === 'POST' && call.path.endsWith('/project-user')), false);
  assert.ok(secondCalls.some((call) => call.method === 'GET' && call.path.endsWith('/project-user/10000000000000004')));
});

test('a missing invited user is reported through the per-user API, not resent blindly', async () => {
  const { rest, calls } = fakeRest();
  const result = await applyAuthProvision(rest, { ...input, done: ['admin-signup'], adminUserId: 'missing-user-id' });
  const signup = result.results.find((op) => op.id === 'admin-signup');
  assert.equal(signup?.status, 'pending');
  const verify = result.results.find((op) => op.id === 'verify-users');
  assert.equal(verify?.status, 'pending');
  assert.match(verify?.detail ?? '', /missing|not found/i);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path.endsWith('/project-user')), false);
});

test('a refused admin invite prints one exact guided block instead of public-signup advice', async () => {
  const { rest, calls } = fakeRest({
    ...ROLE_READ,
    'POST /project-user': { status: 401, body: { data: { error_code: 'OAUTH_SCOPE_MISMATCH', message: 'not authorized' } } },
  });
  const result = await applyAuthProvision(rest, input);
  const signup = result.results.find((op) => op.id === 'admin-signup');
  assert.equal(signup?.status, 'pending');
  assert.ok(signup?.console?.includes(`\n${VALUES_BLOCK}\n`), signup?.console);
  assert.equal(calls.some((call) => call.path.endsWith('/project-user/signup')), false);
});

test('a scope-refused write becomes a console step, not a crash or a retry', async () => {
  const { rest, calls } = fakeRest({
    'POST /authentication/enable': {
      status: 401,
      body: { status: 'failure', data: { error_code: 'OAUTH_SCOPE_MISMATCH', message: 'You are not authorized to perform this operation' } },
    },
    'POST /cors-domain': {
      status: 401,
      body: { status: 'failure', data: { error_code: 'OAUTH_SCOPE_MISMATCH' } },
    },
  });
  const result = await applyAuthProvision(rest, input);
  const hosted = result.results.find((op) => op.id === 'enable-hosted');
  assert.equal(hosted?.status, 'pending');
  assert.match(hosted?.detail ?? '', /OAUTH_SCOPE_MISMATCH/);
  assert.match(hosted?.console ?? '', /Authentication Type/);
  const cors = result.results.find((op) => op.id === 'cors-domain');
  assert.equal(cors?.status, 'pending');
  assert.match(cors?.console ?? '', /Authorized Domains/);
  // Each refused op ran exactly once — no retry storm.
  assert.equal(calls.filter((call) => call.path.includes('/authentication/enable')).length, 2);
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path.endsWith('/cors-domain')).length, 1);
  assert.equal(result.done.includes('enable-hosted'), false);
});

test('a rejected admin invite reports the API failure and the exact fallback values', async () => {
  const { rest, calls } = fakeRest({
    ...ROLE_READ,
    'POST /project-user': {
      status: 500,
      body: { status: 'failure', data: { error_code: 'INTERNAL_ERROR', message: 'invite write failed' } },
    },
  });
  const result = await applyAuthProvision(rest, input);
  const signup = result.results.find((op) => op.id === 'admin-signup');
  assert.equal(signup?.status, 'failed');
  assert.match(signup?.detail ?? '', /INTERNAL_ERROR/);
  assert.ok(signup?.console?.includes(`\n${VALUES_BLOCK}\n`), signup?.console);
  assert.equal(calls.some((call) => call.path.endsWith('/project-user/signup')), false);
  assert.equal(result.done.includes('admin-signup'), false);
});

test('a 409 DUPLICATE_VALUE invite answer is pending on the invite mail — never a failure, never a second add', async () => {
  // Live: a duplicate POST /project-user with a first_name answers 409
  // DUPLICATE_VALUE, and GET /project-user hides an unconfirmed invitee.
  const { rest, calls } = fakeRest({
    ...ROLE_READ,
    'POST /project-user': {
      status: 409,
      body: { status: 'failure', data: { error_code: 'DUPLICATE_VALUE', message: 'Duplicate value for Email ID. Please give a different value' } },
    },
  });
  const result = await applyAuthProvision(rest, input);
  const signup = result.results.find((op) => op.id === 'admin-signup');
  assert.equal(signup?.status, 'pending');
  assert.equal(signup?.code, 'DUPLICATE_VALUE');
  assert.match(signup?.detail ?? '', /already exists or is already invited/);
  assert.match(signup?.console ?? '', /accept the invite mail.*__catalyst\/auth\/login/);
  assert.match(signup?.console ?? '', /Do not add the same address again/);
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path.endsWith('/project-user')).length, 1);
  assert.equal(result.done.includes('admin-signup'), false);
});

test('a 409 DUPLICATE_VALUE for a user the per-user read confirms is verified', async () => {
  const { rest } = fakeRest({
    ...ROLE_READ,
    'POST /project-user': {
      status: 409,
      body: { status: 'failure', data: { error_code: 'DUPLICATE_VALUE', user_id: '10000000000000099' } },
    },
    'GET /project-user/10000000000000099': {
      status: 200,
      body: { data: { user_id: '10000000000000099', email_id: ADMIN_EMAIL, is_confirmed: true, status: 'ACTIVE' } },
    },
  });
  const result = await applyAuthProvision(rest, input);
  const signup = result.results.find((op) => op.id === 'admin-signup');
  assert.equal(signup?.status, 'verified');
  assert.match(signup?.detail ?? '', /confirmed/);
});

test('an existing confirmed project user is verified instead of invited twice', async () => {
  const { rest, calls, acceptInvite } = fakeRest(ROLE_READ);
  const first = await applyAuthProvision(rest, input);
  assert.equal(first.results.find((op) => op.id === 'admin-signup')?.status, 'applied');
  acceptInvite();
  // Second run: GET /project-user exposes the confirmed admin and no invite is sent.
  const second = await applyAuthProvision(rest, { ...input, done: first.done, adminUserId: first.adminUserId });
  const signup = second.results.find((op) => op.id === 'admin-signup');
  assert.equal(signup?.status, 'verified');
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path.endsWith('/project-user')).length, 1);
});

test('a harvested role id from the user list can drive the invite', async () => {
  const { rest, calls, acceptInvite } = fakeRest();
  // Preload a confirmed user carrying the App Administrator role id.
  await applyAuthProvision(rest, { ...input, admin: { ...input.admin!, roleId: ADMIN_ROLE_ID } });
  acceptInvite();
  const again = await applyAuthProvision(rest, {
    projectId: PROJECT,
    slateDomain: SLATE,
    admin: { email: 'second@example.test' },
  });
  const signup = calls.find(
    (call) => call.method === 'POST' && call.path.endsWith('/project-user') && JSON.stringify(call.body).includes('second@example.test'),
  );
  assert.equal((signup?.body as { user_details: { role_id: string } }).user_details.role_id, ADMIN_ROLE_ID);
  assert.equal(again.results.find((op) => op.id === 'admin-signup')?.status, 'applied');
});

test('resume skips ops an earlier run completed and still re-verifies', async () => {
  const { rest, calls, acceptInvite } = fakeRest(ROLE_READ);
  const first = await applyAuthProvision(rest, input);
  acceptInvite();
  calls.length = 0;
  const resumed = await applyAuthProvision(rest, { ...input, done: first.done, adminUserId: first.adminUserId });
  // admin-signup is 'verified', not 'skipped': the per-user read-back proves the accepted invite.
  assert.deepEqual(
    resumed.results.map((op) => `${op.id}:${op.status}`),
    ['enable-hosted:skipped', 'enable-embedded:skipped', 'cors-domain:skipped', 'admin-signup:verified', 'verify-users:verified'],
  );
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  // Reads still run (users, config, invite detail, verify detail) — they are
  // what makes a re-run idempotent even without re-posting anything.
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET', 'GET', 'GET']);
});

test('no slate domain and no admin means both writes are guided console steps', async () => {
  const { rest, calls } = fakeRest();
  const result = await applyAuthProvision(rest, { projectId: PROJECT });
  assert.equal(calls.some((call) => call.path.endsWith('/cors-domain')), false);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path.endsWith('/project-user')), false);
  assert.equal(result.results.find((op) => op.id === 'cors-domain')?.status, 'pending');
  assert.equal(result.results.find((op) => op.id === 'admin-signup')?.status, 'pending');
  assert.ok(result.consoleSteps.length >= 2);
  const out = formatAuthProvision(result);
  assert.match(out, /cors-domain: console/);
  assert.match(out, /auth console steps:/);
});

test('slateUrlFrom and hostOf extract the Slate host from CLI output', () => {
  assert.equal(slateUrlFrom('Deploying...\nApp Url: https://c2c-demo-app-abc123.onslate.in\n'), 'https://c2c-demo-app-abc123.onslate.in');
  assert.equal(slateUrlFrom('the app lives at https://x-y.onslate.in/path'), 'https://x-y.onslate.in');
  assert.equal(slateUrlFrom('no url here'), undefined);
  assert.equal(hostOf('https://c2c-x.onslate.in/'), 'c2c-x.onslate.in');
  assert.equal(hostOf('c2c-x.onslate.in'), 'c2c-x.onslate.in');
  assert.equal(hostOf(''), undefined);
  assert.equal(hostOf(undefined), undefined);
});

test('an existing domain read with iFrame on is verified; iFrame off is a guided console step', async () => {
  // A wider-scoped token can list the authorised domains; the CLI token cannot.
  // The list is the read-back: iFrame off means the sign-in frame cannot load,
  // so the op stays pending with the console path — the token cannot PUT.
  const on = fakeRest({
    'GET /cors-domain': { status: 200, body: { data: [{ domain: SLATE, cors: true, iframe: true }] } },
  });
  const good = await applyAuthProvision(on.rest, input);
  assert.equal(good.results.find((op) => op.id === 'cors-domain')?.status, 'verified');
  assert.equal(on.calls.some((call) => call.method === 'POST' && call.path.endsWith('/cors-domain')), false);

  const off = fakeRest({
    'GET /cors-domain': { status: 200, body: { data: [{ domain: SLATE, cors: true, iframe: false }] } },
  });
  const bad = await applyAuthProvision(off.rest, input);
  const cors = bad.results.find((op) => op.id === 'cors-domain');
  assert.equal(cors?.status, 'pending');
  assert.match(cors?.console ?? '', /Whitelisting/);
  assert.match(cors?.console ?? '', /iFrame/);
  // Re-posting would not fix the flag — nothing is written.
  assert.equal(off.calls.some((call) => call.method === 'POST' && call.path.endsWith('/cors-domain')), false);

  // A row that does not carry the flag is still verified — with a confirm step.
  const bare = fakeRest({
    'GET /cors-domain': { status: 200, body: { data: [{ domain: SLATE }] } },
  });
  const unknown = await applyAuthProvision(bare.rest, input);
  assert.equal(unknown.results.find((op) => op.id === 'cors-domain')?.status, 'verified');
  assert.match(unknown.results.find((op) => op.id === 'cors-domain')?.console ?? '', /iFrame/);
});

test('an invite without the Slate host is a console step — the link it mails would not resolve', async () => {
  const { rest, calls } = fakeRest();
  const result = await applyAuthProvision(rest, {
    projectId: PROJECT,
    admin: { email: ADMIN_EMAIL, name: 'Owner', roleId: ADMIN_ROLE_ID },
  });
  const signup = result.results.find((op) => op.id === 'admin-signup');
  assert.equal(signup?.status, 'pending');
  assert.match(signup?.console ?? '', /redirect_url/);
  assert.match(signup?.console ?? '', /--slate-domain/);
  assert.equal(calls.some((call) => call.path.endsWith('/project-user/signup')), false);
});

test('a wider-scoped token reads existing auth state and skips every write', async () => {
  const { rest, calls } = fakeRest({
    'GET /authentication/configuration': { status: 200, body: { data: { hosted_auth: true, embedded_auth: true, public_signup: true } } },
    'GET /cors-domain': { status: 200, body: { data: [{ domain: SLATE }] } },
    'GET /project-user': {
      status: 200,
      body: { data: [{ user_id: '10000000000000004', email_id: ADMIN_EMAIL, is_confirmed: true, role_details: { role_name: 'App Administrator', role_id: ADMIN_ROLE_ID } }] },
    },
    'GET /project-user/10000000000000004': {
      status: 200,
      body: { data: { user_id: '10000000000000004', email_id: ADMIN_EMAIL, is_confirmed: true, role_details: { role_name: 'App Administrator', role_id: ADMIN_ROLE_ID } } },
    },
  });
  const result = await applyAuthProvision(rest, input);
  assert.deepEqual(
    result.results.map((op) => `${op.id}:${op.status}`),
    ['enable-hosted:verified', 'enable-embedded:verified', 'cors-domain:verified', 'admin-signup:verified', 'verify-users:verified'],
  );
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('an existing domain read with iFrame on is verified; iFrame off is a guided console step', async () => {
  // A wider-scoped token can list the authorised domains; the CLI token cannot.
  // The list is the read-back: iFrame off means the sign-in frame cannot load,
  // so the op stays pending with the console path — the token cannot PUT.
  const on = fakeRest({
    'GET /cors-domain': { status: 200, body: { data: [{ domain: SLATE, cors: true, iframe: true }] } },
  });
  const good = await applyAuthProvision(on.rest, input);
  assert.equal(good.results.find((op) => op.id === 'cors-domain')?.status, 'verified');
  assert.equal(on.calls.some((call) => call.method === 'POST' && call.path.endsWith('/cors-domain')), false);

  const off = fakeRest({
    'GET /cors-domain': { status: 200, body: { data: [{ domain: SLATE, cors: true, iframe: false }] } },
  });
  const bad = await applyAuthProvision(off.rest, input);
  const cors = bad.results.find((op) => op.id === 'cors-domain');
  assert.equal(cors?.status, 'pending');
  assert.match(cors?.console ?? '', /Whitelisting/);
  assert.match(cors?.console ?? '', /iFrame/);
  // Re-posting would not fix the flag — nothing is written.
  assert.equal(off.calls.some((call) => call.method === 'POST' && call.path.endsWith('/cors-domain')), false);

  // A row that does not carry the flag is still verified — with a confirm step.
  const bare = fakeRest({
    'GET /cors-domain': { status: 200, body: { data: [{ domain: SLATE }] } },
  });
  const unknown = await applyAuthProvision(bare.rest, input);
  assert.equal(unknown.results.find((op) => op.id === 'cors-domain')?.status, 'verified');
  assert.match(unknown.results.find((op) => op.id === 'cors-domain')?.console ?? '', /iFrame/);
});

test('an invite without the Slate host is a console step — the link it mails would not resolve', async () => {
  const { rest, calls } = fakeRest();
  const result = await applyAuthProvision(rest, {
    projectId: PROJECT,
    admin: { email: ADMIN_EMAIL, name: 'Owner', roleId: ADMIN_ROLE_ID },
  });
  const signup = result.results.find((op) => op.id === 'admin-signup');
  assert.equal(signup?.status, 'pending');
  assert.match(signup?.console ?? '', /redirect_url/);
  assert.match(signup?.console ?? '', /--slate-domain/);
  assert.equal(calls.some((call) => call.path.endsWith('/project-user/signup')), false);
});

test('a config read that shows public_signup on is never flipped off', async () => {
  // Hosted auth is not yet on, but the user already turned public signup
  // on — the enable POST must not carry public_signup:false over it.
  const { rest, calls } = fakeRest({
    'GET /authentication/configuration': { status: 200, body: { data: { hosted_auth: false, embedded_auth: false, public_signup: true } } },
  });
  const result = await applyAuthProvision(rest, input);
  assert.equal(result.results.find((op) => op.id === 'enable-hosted')?.status, 'applied');
  const hosted = calls.find((call) => call.path.endsWith('auth_type=hosted'));
  assert.ok(hosted);
  assert.equal(Object.prototype.hasOwnProperty.call(hosted.body ?? {}, 'public_signup'), false);
  assert.match(result.results.find((op) => op.id === 'enable-hosted')?.console ?? '', /public signup is on/);
});

test('a proven first enable defaults public_signup false', async () => {
  const { rest, calls } = fakeRest({
    'GET /authentication/configuration': { status: 200, body: { data: { hosted_auth: false, embedded_auth: false, public_signup: false } } },
  });
  await applyAuthProvision(rest, input);
  const hosted = calls.find((call) => call.path.endsWith('auth_type=hosted'));
  assert.deepEqual(hosted?.body, { public_signup: false });
});

test('already-enabled and already-existing answers count as verified, not failures', async () => {
  const { rest, calls } = fakeRest({
    ...ROLE_READ,
    'POST /authentication/enable': { status: 400, body: { data: { message: 'Authentication already enabled', error_code: 'INVALID_INPUT' } } },
    'POST /cors-domain': { status: 400, body: { data: { message: 'Domain already exists', error_code: 'DUPLICATE_VALUE' } } },
  });
  const result = await applyAuthProvision(rest, input);
  assert.equal(result.results.find((op) => op.id === 'enable-hosted')?.status, 'verified');
  assert.equal(result.results.find((op) => op.id === 'enable-embedded')?.status, 'verified');
  assert.equal(result.results.find((op) => op.id === 'cors-domain')?.status, 'verified');
  // The domain exists, but the 400 does not say whether iFrame is on — the
  // operator gets a guided confirm step for it.
  assert.match(result.results.find((op) => op.id === 'cors-domain')?.console ?? '', /iFrame/);
  // Verified/applied ops land in done; the invite itself stays out until the
  // admin accepts and the per-user read reports is_confirmed:true.
  assert.deepEqual(result.done, ['admin-signup', 'cors-domain', 'enable-embedded', 'enable-hosted']);
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path.endsWith('/cors-domain')).length, 1);
});

test('each applied op persists immediately — a mid-run failure keeps the earlier ops done', async () => {
  const persisted: string[][] = [];
  const { rest } = fakeRest({
    ...ROLE_READ,
    'POST /cors-domain': { status: 500, body: { data: { error_code: 'INTERNAL_ERROR', message: 'upstream blew up' } } },
  });
  const first = await applyAuthProvision(rest, { ...input, persistDone: (done) => persisted.push(done) });
  assert.equal(first.results.find((op) => op.id === 'cors-domain')?.status, 'failed');
  // Persist fired once per landed op — not once at the end.
  assert.deepEqual(persisted[0], ['enable-hosted']);
  assert.deepEqual(persisted[1], ['enable-embedded', 'enable-hosted']);
  assert.equal(first.done.includes('cors-domain'), false);
  assert.ok(first.done.includes('enable-hosted'));
  assert.ok(first.done.includes('admin-signup'));
});

test('a run resumed after a mid-run failure posts only the op that never landed', async () => {
  const persisted: string[][] = [];
  let corsAttempts = 0;
  const { rest, calls } = fakeRest();
  const flaky: RestFn = async (call) => {
    if (call.method === 'POST' && call.path.endsWith('/cors-domain') && corsAttempts === 0) {
      corsAttempts += 1;
      throw new Error('socket hang up');
    }
    return rest(call);
  };
  const first = await applyAuthProvision(flaky, { ...input, persistDone: (done) => persisted.push(done) });
  assert.equal(first.results.find((op) => op.id === 'cors-domain')?.status, 'failed');
  const before = calls.length;
  const second = await applyAuthProvision(rest, { ...input, done: first.done });
  const secondCalls = calls.slice(before);
  // Enables and signup are skipped/verified from the done list and the user read-back.
  assert.equal(second.results.find((op) => op.id === 'enable-hosted')?.status, 'skipped');
  assert.equal(second.results.find((op) => op.id === 'cors-domain')?.status, 'applied');
  const posts = secondCalls.filter((call) => call.method === 'POST');
  assert.deepEqual(posts.map((call) => call.path), [`${BASE}/cors-domain`]);
});

test('an HTTP 500 failure reports both the error code and a sanitised message', async () => {
  const { rest } = fakeRest({
    'POST /authentication/enable': {
      status: 500,
      body: {
        data: {
          error_code: 'INTERNAL_ERROR',
          message: `role ${ADMIN_ROLE_ID} failed; token tok-ABC123def456ghi789; contact admin@example.test`,
        },
      },
    },
  });
  const result = await applyAuthProvision(rest, input);
  const hosted = result.results.find((op) => op.id === 'enable-hosted');
  assert.equal(hosted?.status, 'failed');
  assert.equal(hosted?.code, 'INTERNAL_ERROR');
  assert.match(hosted?.detail ?? '', /HTTP 500 INTERNAL_ERROR — /);
  // The echoed identifiers and addresses never reach the detail string.
  assert.equal(hosted?.detail?.includes(ADMIN_ROLE_ID), false);
  assert.equal(hosted?.detail?.includes('tok-ABC123def456ghi789'), false);
  assert.equal(hosted?.detail?.includes('admin@example.test'), false);
  assert.match(hosted?.detail ?? '', /\[redacted\]/);
});

test('a transport throw fails the op and the run continues', async () => {
  const { rest } = fakeRest();
  const flaky: RestFn = async (call) => {
    if (call.method === 'POST' && call.path.includes('/authentication/enable')) throw new Error('socket hang up tok-SECRETabcdef123456');
    return rest(call);
  };
  const result = await applyAuthProvision(flaky, input);
  assert.equal(result.results.find((op) => op.id === 'enable-hosted')?.status, 'failed');
  assert.equal(result.results.find((op) => op.id === 'enable-embedded')?.status, 'failed');
  assert.match(result.results.find((op) => op.id === 'enable-hosted')?.detail ?? '', /transport error/);
  assert.equal(result.results.find((op) => op.id === 'enable-hosted')?.detail?.includes('tok-SECRETabcdef123456'), false);
  // The ops after the failed enables still ran.
  assert.equal(result.results.find((op) => op.id === 'cors-domain')?.status, 'applied');
});

test('the admin email and role id never appear outside the signup request body', async () => {
  const { rest } = fakeRest(ROLE_READ);
  const result = await applyAuthProvision(rest, input);
  const persisted = result.results.map(({ call, ...rest }) => rest);
  const text = JSON.stringify(persisted) + JSON.stringify(result.consoleSteps) + formatAuthProvision(result);
  assert.equal(text.includes(ADMIN_EMAIL), false);
  assert.equal(text.includes(ADMIN_ROLE_ID), false);
  // The email does ride inside the wire body of the signup call itself.
  const signup = result.results.find((op) => op.id === 'admin-signup');
  assert.equal(JSON.stringify(signup?.call?.body ?? {}).includes(ADMIN_EMAIL), true);
});

test('projectUsers tolerates the recorded envelopes; errorCode finds the known codes', () => {
  assert.deepEqual(projectUsers([]), []);
  assert.deepEqual(projectUsers({ data: [{ email_id: 'a@b.c' }] }), [{ email_id: 'a@b.c' }]);
  assert.equal(projectUsers({}), undefined);
  assert.equal(errorCode({ data: { error_code: 'OAUTH_SCOPE_MISMATCH' } }), 'OAUTH_SCOPE_MISMATCH');
  assert.equal(errorCode('PUBLIC_SIGNUP_ERROR "You cannot perform this action"'), 'PUBLIC_SIGNUP_ERROR');
  assert.equal(errorCode({ status: 'success' }), undefined);
});

test('authConfig, corsDomains and sanitizeMessage parse and scrub the read envelopes', () => {
  assert.deepEqual(authConfig({ data: { hosted_auth: true, embedded_auth: false, public_signup: 'true' } }), {
    hosted: true,
    embedded: false,
    publicSignup: true,
  });
  assert.equal(authConfig('no'), undefined);
  assert.deepEqual(corsDomains({ data: [{ domain: 'a.test' }, { domain_name: 'b.test' }, 'c.test'] }), new Set(['a.test', 'b.test', 'c.test']));
  assert.deepEqual(corsDomains([{ host: 'd.test' }]), new Set(['d.test']));
  assert.equal(corsDomains({}), undefined);
  assert.equal(sanitizeMessage('mail a@b.c id 1234567890123 ok'), 'mail [redacted] id [redacted] ok');
});

test('a nameless admin still sends a non-empty derived first_name (live: empty is 400 MISSING_PARAM)', async () => {
  // Plan op: the derived name is in the dry-run body, never ''.
  const planned = authProvisionPlan({ projectId: PROJECT, slateDomain: SLATE, admin: { email: 'jane.doe@example.test', roleId: ADMIN_ROLE_ID } });
  const plannedInvite = planned.at(-1)?.call.body as { user_details: { first_name: string } };
  assert.equal(plannedInvite.user_details.first_name, 'Jane');
  // Send path: same derivation on the wire; an explicit --admin-name wins.
  const { rest, calls } = fakeRest(ROLE_READ);
  const result = await applyAuthProvision(rest, { ...input, admin: { email: 'jane.doe@example.test' } });
  const invite = calls.find((call) => call.method === 'POST' && call.path.endsWith('/project-user'));
  assert.equal((invite?.body as { user_details: { first_name: string } }).user_details.first_name, 'Jane');
  assert.equal(result.results.find((op) => op.id === 'admin-signup')?.status, 'applied');
  const named = await applyAuthProvision(fakeRest(ROLE_READ).rest, { ...input, admin: { email: 'jane.doe@example.test', name: 'Janet' } });
  assert.equal(named.results.find((op) => op.id === 'admin-signup')?.status, 'applied');
  // Deterministic fallbacks: dotted/dashed/plus local parts, no usable token.
  assert.equal(adminFirstName('jane-doe+x@example.test'), 'Jane');
  assert.equal(adminFirstName('owner@example.test', '  '), 'Owner');
  assert.equal(adminFirstName('@example.test'), 'Admin');
});

test('a 400 MISSING_PARAM invite answer is a named failure with the exact Add User block', async () => {
  const { rest } = fakeRest({
    ...ROLE_READ,
    'POST /project-user': { status: 400, body: { status: 'failure', data: { error_code: 'MISSING_PARAM', message: 'Mandatory parameter first_name is missing.' } } },
  });
  const result = await applyAuthProvision(rest, input);
  const op = result.results.find((entry) => entry.id === 'admin-signup');
  assert.equal(op?.status, 'failed');
  assert.equal(op?.code, 'MISSING_PARAM');
  assert.match(op?.detail ?? '', /first_name/);
  assert.ok(op?.console?.includes(VALUES_BLOCK), op?.console);
  assert.ok(result.consoleSteps.some((step) => step.includes('Add User — enter exactly:')));
});
