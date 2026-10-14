import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../../ui/src/index.js';
import { functionDir } from '../../deploy/src/function-dir.js';
import {
  APPLY_JSON,
  APPLY_REPORT,
  APPLY_SCRIPT,
  CUV_DIR,
  applyScriptSource,
  authApplyFiles,
  authApplyJson,
  authApplyPlan,
  authApplyReport,
  catalystApiHost,
  cuvFunctionSource,
  principalRoleMap,
} from '../src/apply.js';
import { authPlan } from '../src/plan.js';
import { slateHost } from '../src/slate-host.js';

const execFileAsync = promisify(execFile);

function appOf(body: string) {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

const DEMO = `\tform Item
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
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Items = {"View","Edit"}
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
\t\t"Stranger"
\t\t{
\t\t\tname = "Stranger"
\t\t\ttype = Users_Permissions
\t\t}
\t\troles
\t\t{
\t\t\tCEO
\t\t\t{
\t\t\t\tdescription = "Top"
\t\t\t}
\t\t}
\t}`;

test('the apply plan turns roles, table permissions, and invites into ordered ops', () => {
  const apply = authApplyPlan(authPlan(appOf(DEMO)));
  assert.equal(apply.dryRun, true);
  assert.deepEqual(
    apply.roles.map((role) => role.role_name),
    ['Staff', 'Customers', 'Stranger', 'CEO'],
  );
  const staff = apply.roles.find((role) => role.role_name === 'Staff');
  assert.equal(staff?.call.method, 'POST');
  assert.equal(staff?.call.path, '/role');
  assert.equal(staff?.call.body.clone_role, '{role_id:App User}');
  assert.equal(staff?.call.body.is_default, false);
  const customers = apply.roles.find((role) => role.role_name === 'Customers');
  assert.equal(customers?.portal, true);
  const ceo = apply.roles.find((role) => role.role_name === 'CEO');
  assert.equal(ceo?.source, 'hierarchy');

  const perm = apply.tablePermissions.find((row) => row.role === 'Staff' && row.table === 'Item');
  assert.deepEqual(perm?.permissions, ['SELECT', 'UPDATE']);
  assert.equal(perm?.scope, 'ORG');
  assert.deepEqual(
    perm?.calls.map((call) => call.path),
    ['/table/{table_id:Item}/permission', '/table/{table_id:Item}/scopes'],
  );
  assert.deepEqual(perm?.calls[0].body, { Staff: ['SELECT', 'UPDATE'] });
  assert.deepEqual(perm?.calls[1].body, { Staff: 'ORG' });

  assert.deepEqual(apply.invites, [{ profile: 'Customers', role: 'Customers', emails: [], via: 'console-or-mcp-add-user' }]);
  assert.equal(apply.customUserValidation.type, 'basicio');
  assert.equal(apply.customUserValidation.policy, 'deny-by-default');
  assert.deepEqual(apply.customUserValidation.assignableRoles, ['Customers']);
  assert.ok(apply.customUserValidation.requires.some((step) => /public signup/.test(step)));
  assert.ok(apply.steps.length >= 4);
});

test('a lower role gets no op for a permission it lacks, for every permission kind', () => {
  const apply = authApplyPlan(authPlan(appOf(DEMO)));
  // Stranger has a role but no grants: no table op may reference it.
  assert.equal(apply.tablePermissions.some((row) => row.role === 'Stranger'), false);
  assert.equal(apply.tablePermissions.some((row) => row.role === 'CEO'), false);
  // Every op hangs off a planned role.
  const names = new Set(apply.roles.map((role) => role.role_name));
  for (const row of apply.tablePermissions) assert.ok(names.has(row.role), row.role);
  // Edit does not imply Delete: Staff's Item grant is SELECT+UPDATE only.
  const staff = apply.tablePermissions.find((row) => row.role === 'Staff' && row.table === 'Item');
  assert.equal(staff?.permissions.includes('DELETE'), false);
  for (const call of staff?.calls ?? []) assert.equal(JSON.stringify(call.body).includes('DELETE'), false);
  // Viewall became GLOBAL scope; nothing else did.
  const portal = apply.tablePermissions.find((row) => row.role === 'Customers');
  assert.equal(portal?.scope, 'GLOBAL');
  // Invites never invent an email.
  for (const invite of apply.invites) assert.deepEqual(invite.emails, []);
});

test('principalRoleMap maps profile roles only and never shadows the built-ins', () => {
  const apply = authApplyPlan(authPlan(appOf(DEMO)));
  assert.deepEqual(principalRoleMap(authPlan(appOf(DEMO))), { Customers: 'Customers', Staff: 'Staff', Stranger: 'Stranger' });
  assert.equal(apply.customUserValidation.roles.includes('CEO'), true);
  // A Creator profile named like a Catalyst built-in keeps the built-in mapping.
  const colliding = authPlan(
    appOf(`\tform Item
\t{
\t\tQty
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tshare_settings
\t{
\t\t"App User"
\t\t{
\t\t\tname = "App User"
\t\t\ttype = Users_Permissions
\t\t}
\t}`),
  );
  assert.equal(principalRoleMap(colliding)['App User'], undefined);
});

test('a profile whose name spells a built-in role plans a distinct custom role with its own grants', () => {
  const colliding = appOf(`\tform Item
\t{
\t\tQty
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tshare_settings
\t{
\t\t"App Administrator"
\t\t{
\t\t\tname = "App Administrator"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tItem
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Items = {"View"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  const plan = authPlan(colliding);
  // No emitted role may carry the built-in name; the profile keeps a distinct
  // custom role that clones the least-privilege base, not the built-in it
  // spells.
  assert.equal(plan.roles.some((role) => role.source === 'profile' && role.role_name === 'App Administrator'), false);
  const role = plan.roles.find((entry) => entry.role_name === 'Creator App Administrator');
  assert.equal(role?.profile, 'App Administrator');
  assert.equal(role?.clone_role, 'App User');
  // The profile's grants hang off the custom role, never the built-in.
  const grant = plan.tablePermissions.find((row) => row.role === 'Creator App Administrator' && row.table === 'Item');
  assert.deepEqual(grant?.permissions, ['SELECT']);
  assert.equal(plan.tablePermissions.some((row) => row.role === 'App Administrator'), false);
  // The generated app maps the custom role back to the profile the export declared.
  const map = principalRoleMap(plan);
  assert.equal(map['Creator App Administrator'], 'App Administrator');
  assert.equal(map['App Administrator'], undefined);
  // A folded spelling collides the same way.
  const folded = authPlan(
    appOf(`\tshare_settings
\t{
\t\t"app  administrator"
\t\t{
\t\t\tname = "app  administrator"
\t\t\ttype = Users_Permissions
\t\t}
\t}`),
  );
  assert.equal(folded.roles.some((entry) => entry.role_name === 'Creator app  administrator'), true);
  assert.equal(folded.roles.some((entry) => entry.role_name === 'app  administrator'), false);
});

test('the emitted artifacts are byte-deterministic and parse', () => {
  const plan = authPlan(appOf(DEMO));
  const first = authApplyFiles(plan);
  const second = authApplyFiles(authPlan(appOf(DEMO)));
  assert.deepEqual(
    first.map((file) => file.path),
    [APPLY_JSON, APPLY_REPORT, APPLY_SCRIPT, `${CUV_DIR}/index.js`, `${CUV_DIR}/catalyst-config.json`, `${CUV_DIR}/package.json`],
  );
  assert.deepEqual(first, second);
  const files = new Map(first.map((file) => [file.path, file.data]));
  const parsed = JSON.parse(files.get(APPLY_JSON) as string);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.dryRun, true);
  const config = JSON.parse(files.get(`${CUV_DIR}/catalyst-config.json`) as string);
  assert.equal(config.deployment.name, 'c2c_user_validation');
  assert.equal(config.deployment.type, 'basicio');
  // The ui bundle carries the artifacts unchanged.
  const bundle = buildUi(appOf(DEMO));
  for (const file of first) assert.equal(bundle.files.find((item) => item.path === file.path)?.data, file.data, file.path);
});

test('the apply script resolves ids at run time and never sends a portal invite', () => {
  const script = applyScriptSource();
  assert.match(script, /send\('GET', '\/role'\)/);
  assert.match(script, /send\('GET', '\/table'\)/);
  assert.match(script, /role_id:/);
  assert.match(script, /table_id:/);
  // No role or table id is baked in: ids come from flags or the list calls.
  assert.equal(/role_id:\s*['"]?[0-9]/.test(script), false);
  // Dry print is the default; sending needs --apply.
  assert.match(script, /flag\('apply'\)/);
  assert.match(script, /--apply needs --token/);
  // The first admin goes through POST /project-user from the recorded plan
  // data, gated on --admin-email; portal invites are printed, never sent.
  assert.match(script, /call\.path === '\/project-user'/);
  assert.equal(script.includes('/project-user/signup'), false);
  // An invite without redirect_url mails a link that does not resolve — the
  // script refuses it rather than sending.
  assert.match(script, /the invite is not sent without it/);
  assert.match(script, /owner action, not sent/);
  assert.match(authApplyReport(authApplyPlan(authPlan(appOf(DEMO)))), /Custom User Validation/);
});

test('the generated apply script derives the API host from the DC, never a baked api.zoho.com', () => {
  const script = applyScriptSource();
  assert.equal(script.includes('api.zoho.com'), false);
  assert.match(script, /--dc/);
  assert.match(script, /CATALYST_DC/);
  assert.match(script, /c2c-deploy\.json/);
  assert.match(script, /api\.catalyst\.zoho\.in/);
  assert.match(script, /--apply needs the Catalyst API host/);
  assert.equal(catalystApiHost('in'), 'https://api.catalyst.zoho.in');
  assert.equal(catalystApiHost('COM'), 'https://api.catalyst.zoho.com');
  assert.equal(catalystApiHost('unknown'), undefined);
  // A deploy tree generated for a DC bakes it as the last-resort default.
  assert.match(applyScriptSource('in'), /deployConfigDc\(\) \?\? "in"/);
  assert.match(applyScriptSource(), /deployConfigDc\(\) \?\? undefined/);
  // authApplyFiles threads the dc; buildUi records it into c2c-deploy.json.
  const files = authApplyFiles(authPlan(appOf(DEMO)), { dc: 'eu' });
  assert.match(files.find((file) => file.path === APPLY_SCRIPT)?.data ?? '', /\?\? "eu"/);
  const bundle = buildUi(appOf(DEMO), { dc: 'in' });
  const config = JSON.parse(String(bundle.files.find((file) => file.path === 'functions/c2c-deploy.json')?.data)) as { dc?: string };
  assert.equal(config.dc, 'in');
});

test('the generated script resolves the host from --dc or c2c-deploy.json, and refuses --apply without one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-apply-'));
  mkdirSync(join(dir, 'auth'), { recursive: true });
  mkdirSync(join(dir, 'functions'), { recursive: true });
  writeFileSync(join(dir, 'auth', 'c2c-auth-apply.mjs'), applyScriptSource());
  writeFileSync(join(dir, 'auth', 'c2c-auth-apply.json'), authApplyJson(authApplyPlan(authPlan(appOf(DEMO)))));
  const run = async (args: string[]) =>
    execFileAsync(process.execPath, [join(dir, 'auth', 'c2c-auth-apply.mjs'), '--project', '1001', '--token', 't', ...args], {
      env: { PATH: process.env.PATH },
    }).then(
      (out) => ({ code: 0, stdout: out.stdout, stderr: out.stderr }),
      (err: { code?: number; stdout?: string; stderr?: string }) => ({ code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }),
    );
  // No host anywhere → --apply fails instead of guessing api.zoho.com.
  const refused = await run(['--apply']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /needs the Catalyst API host/);
  assert.match(refused.stdout, /host: \(unresolved/);
  // The deploy tree's recorded DC resolves the host — no flag needed.
  writeFileSync(join(dir, 'functions', 'c2c-deploy.json'), JSON.stringify({ mode: 'dry-run', dc: 'in' }) + '\n');
  const fromConfig = await run([]);
  assert.equal(fromConfig.code, 0);
  assert.match(fromConfig.stdout, /host: https:\/\/api\.catalyst\.zoho\.in/);
  // A --dc flag outranks the recorded config; an unknown DC stays unresolved.
  const flagged = await run(['--dc', 'com']);
  assert.match(flagged.stdout, /host: https:\/\/api\.catalyst\.zoho\.com/);
  const bogus = await run(['--dc', 'bogus']);
  assert.match(bogus.stdout, /host: \(unresolved/);
  // --host always wins over any DC.
  const explicit = await run(['--dc', 'in', '--host', 'https://api.catalyst.zoho.jp/']);
  assert.match(explicit.stdout, /host: https:\/\/api\.catalyst\.zoho\.jp/);
  // A DC baked at generation time needs no config at all.
  writeFileSync(join(dir, 'auth', 'c2c-auth-apply.mjs'), applyScriptSource('in'));
  rmSync(join(dir, 'functions', 'c2c-deploy.json'));
  const baked = await run([]);
  assert.match(baked.stdout, /host: https:\/\/api\.catalyst\.zoho\.in/);
  rmSync(dir, { recursive: true, force: true });
});

test('the generated apply script validates --domain with the shared Slate-host rule', async () => {
  // The generated script embeds the same function provision and deploy use.
  const source = applyScriptSource();
  assert.ok(source.includes(slateHost.toString()), 'the generated script embeds the shared validator');
  const dir = mkdtempSync(join(tmpdir(), 'c2c-apply-dom-'));
  mkdirSync(join(dir, 'auth'), { recursive: true });
  writeFileSync(join(dir, 'auth', 'c2c-auth-apply.mjs'), source);
  writeFileSync(join(dir, 'auth', 'c2c-auth-apply.json'), authApplyJson(authApplyPlan(authPlan(appOf(DEMO)))));
  const run = async (args: string[]) =>
    execFileAsync(process.execPath, [join(dir, 'auth', 'c2c-auth-apply.mjs'), '--project', '1001', '--token', 't', ...args], {
      env: { PATH: process.env.PATH },
    }).then(
      (out) => ({ code: 0, stdout: out.stdout, stderr: out.stderr }),
      (err: { code?: number; stdout?: string; stderr?: string }) => ({ code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }),
    );
  // Wildcard, userinfo, path/query, port and other-scheme shapes refuse before
  // a body is built — the value lands verbatim in cors-domain and redirect_url.
  for (const bad of ['*.onslate.in', ['app.example.test', 'evil.example'].join('@'), 'evil.example/x?a=', 'app.example.test:8443', 'http://app.example.test']) {
    const res = await run(['--domain', bad]);
    assert.equal(res.code, 1, bad);
    assert.match(res.stderr, /--domain/);
  }
  // A quote can no longer splice JSON keys into the cors body: the value is
  // validated as a host and written back through the serializer.
  const inject = await run(['--domain', 'app.example.test","iframe":false,"x":"']);
  assert.equal(inject.code, 1);
  // A pasted https URL resolves to the bare host on both consumers.
  const ok = await run(['--domain', 'https://app.example.test']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /dry-run POST \/cors-domain \{"domain":"app\.example\.test"/);
  assert.match(ok.stdout, /"redirect_url":"https:\/\/app\.example\.test"/);
  assert.ok(!ok.stdout.includes('https://https://'));
  rmSync(dir, { recursive: true, force: true });
});

test('the apply plan carries the recorded provisioning ops and the console-only list', () => {
  const apply = authApplyPlan(authPlan(appOf(DEMO)));
  // Widened access: the field predates this test — the assertion, not the type, is the check.
  const provisioning = (apply as { provisioning?: {
    calls: { method: string; path: string; body?: Record<string, unknown> }[];
    verify: { method: string; path: string };
    consoleOnly: { op: string; status: number; code: string }[];
  } }).provisioning;
  assert.ok(provisioning, 'the apply plan carries no provisioning block');
  // Exact recorded shapes (enable, CORS, admin Add User): paths, methods, bodies.
  assert.deepEqual(
    provisioning.calls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`),
    [
      'POST /authentication/enable?auth_type=hosted',
      'POST /authentication/enable?auth_type=embedded',
      'POST /cors-domain',
      'POST /project-user',
    ],
  );
  assert.deepEqual(provisioning.calls[0]?.body, { public_signup: false });
  assert.deepEqual(provisioning.calls[1]?.body, {});
  assert.deepEqual(provisioning.calls[2]?.body, { domain: '{slate_domain}', cors: true, iframe: true });
  const signup = provisioning.calls[3]?.body as Record<string, unknown> | undefined;
  assert.equal(signup?.platform_type, 'web');
  assert.equal(signup?.redirect_url, 'https://{slate_domain}');
  assert.deepEqual(signup?.user_details, {
    email_id: '{admin_email}',
    first_name: '{admin_name}',
    last_name: '',
    role_id: '{role_id:App Administrator}',
  });
  // Unconfirmed users are hidden from the list, so the recorded id is the verify key.
  assert.deepEqual(provisioning.verify, { method: 'GET', path: '/project-user/{admin_user_id}' });
  // Every refused op names the recorded status + error code.
  const refused = new Map(provisioning.consoleOnly.map((item: { op: string; status: number; code: string }) => [item.op, `${item.status} ${item.code}`]));
  assert.equal(refused.get('GET /authentication/configuration'), '401 OAUTH_SCOPE_MISMATCH');
  assert.equal(refused.get('GET /cors-domain'), '401 OAUTH_SCOPE_MISMATCH');
  assert.equal(refused.get('GET /role'), '401 OAUTH_SCOPE_MISMATCH');
  assert.equal(refused.get('POST /role'), '401 AUTHENTICATION_FAILURE');
  // No project-specific role id or email is baked into the plan.
  assert.equal(/role_id['"]?\s*:\s*['"]?[0-9]/.test(authApplyJson(apply)), false);
  assert.equal(authApplyJson(apply).includes('@'), false);
  const report = authApplyReport(apply);
  assert.match(report, /## Authentication provisioning \(API writes\)/);
  assert.match(report, /## Console-only under the CLI token/);
  assert.match(report, /POST \/authentication\/enable\?auth_type=hosted/);
});

test('the Custom User Validation function fails closed', async () => {
  const apply = authApplyPlan(authPlan(appOf(DEMO)));
  const source = cuvFunctionSource(apply);

  const run = async (src: string, request: unknown): Promise<Record<string, unknown>> => {
    const module = { exports: {} as Record<string, unknown> };
    const fakeRequire = (name: string) => {
      assert.equal(name, 'zcatalyst-sdk-node');
      return { initialize: () => ({ userManagement: () => ({ getSignupValidationRequest: () => request }) }) };
    };
    // eslint-disable-next-line no-new-func
    new Function('require', 'module', 'exports', src)(fakeRequire, module, module.exports);
    let out = '';
    let closed = false;
    await (module.exports as unknown as (ctx: unknown, bio: unknown) => Promise<void>)(
      { close: () => { closed = true; } },
      { write: (body: string) => { out = body; } },
    );
    assert.equal(closed, true);
    return JSON.parse(out) as Record<string, unknown>;
  };

  const signup = { user_details: { email_id: 'ada@example.test', first_name: 'Ada' } };
  // Empty allow list: deny.
  assert.equal((await run(source, signup)).status, 'failure');
  // An unlisted address: deny even when the list has entries.
  const allowed = source.replace('const SIGNUP_ALLOW = {};', 'const SIGNUP_ALLOW = {"ada@example.test": "Customers", "ok.example.test": "Customers"};');
  assert.equal((await run(allowed, { user_details: { email_id: 'eve@ex.example.test' } })).status, 'failure');
  // A listed email gets the planned portal role.
  const ok = await run(allowed, signup);
  assert.equal(ok.status, 'success');
  assert.equal((ok.user_details as Record<string, unknown>).role_identifier, 'Customers');
  // A listed domain works the same way.
  assert.equal((await run(allowed, { user_details: { email_id: 'bo@ok.example.test' } })).status, 'success');
  // A non-portal role and an unknown role both fail closed.
  for (const role of ['Staff', 'CEO', 'Bogus']) {
    const src = source.replace('const SIGNUP_ALLOW = {};', `const SIGNUP_ALLOW = {"ada@example.test": ${JSON.stringify(role)}};`);
    assert.equal((await run(src, signup)).status, 'failure', role);
  }
  // No request details: deny.
  assert.equal((await run(source, null)).status, 'failure');
  // No portal roles planned: every signup is denied.
  const bare = cuvFunctionSource(authApplyPlan(authPlan(appOf(`\tform Item\n\t{\n\t\tQty\n\t\t(\n\t\t\ttype = number\n\t\t)\n\t}`))));
  const bareAllowed = bare.replace('const SIGNUP_ALLOW = {};', 'const SIGNUP_ALLOW = {"ada@example.test": "Customers"};');
  assert.equal((await run(bareAllowed, signup)).status, 'failure');
});

/** Fake Catalyst admin API on 127.0.0.1: serves list shapes, records POST bodies. */
async function startFakeAdminApi(shapes: {
  roles: { role_name: string; role_id: string }[];
  /** Fixed answer for POST /project-user (default: an empty 200). */
  invite?: { status: number; body: unknown };
}): Promise<{
  port: number;
  posted: { path: string; body: unknown }[];
  close: () => Promise<void>;
}> {
  const posted: { path: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0] as string;
      if (req.method === 'POST') {
        let body: unknown = raw;
        try {
          body = JSON.parse(raw);
        } catch {
          // Keep the raw text — a spliced body may not parse.
        }
        posted.push({ path, body });
      }
      const json = (payload: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && path.endsWith('/project-user')) return void json({ data: [] });
      if (req.method === 'POST' && path.endsWith('/project-user') && shapes.invite) {
        res.writeHead(shapes.invite.status, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(shapes.invite.body));
      }
      if (req.method === 'GET' && path.endsWith('/role')) return void json({ roles: shapes.roles });
      if (req.method === 'GET' && path.endsWith('/table')) return void json({ tables: [] });
      return void json({});
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    posted,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

function runApplyScript(dir: string, args: string[]) {
  return execFileAsync(process.execPath, [join(dir, 'auth', 'c2c-auth-apply.mjs'), '--project', '1001', '--token', 't', ...args], {
    env: { PATH: process.env.PATH },
  }).then(
    (out) => ({ code: 0, stdout: out.stdout, stderr: out.stderr }),
    (err: { code?: number; stdout?: string; stderr?: string }) => ({ code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }),
  );
}

function writeApplyTree(dir: string) {
  mkdirSync(join(dir, 'auth'), { recursive: true });
  writeFileSync(join(dir, 'auth', 'c2c-auth-apply.mjs'), applyScriptSource());
  writeFileSync(join(dir, 'auth', 'c2c-auth-apply.json'), authApplyJson(authApplyPlan(authPlan(appOf(DEMO)))));
}

test('a quote in a listed role id stays a string value and never splices keys', async () => {
  // The list call returns an id that would break out of its JSON string when
  // filled into request text: it must arrive as one escaped string value.
  const quoted = '5002", "is_default":true, "x":"1';
  const api = await startFakeAdminApi({
    roles: [
      { role_name: 'App Administrator', role_id: '5001' },
      { role_name: 'App User', role_id: quoted },
    ],
  });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-apply-splice-'));
  try {
    writeApplyTree(dir);
    const res = await runApplyScript(dir, ['--apply', '--host', `http://127.0.0.1:${api.port}`]);
    assert.equal(res.code, 0, res.stderr);
    const roles = api.posted.filter((call) => call.path.endsWith('/role'));
    assert.ok(roles.length > 0, 'no POST /role reached the fake project');
    for (const call of roles) {
      const body = call.body as Record<string, unknown>;
      assert.equal(body['clone_role'], quoted);
      assert.equal(body['is_default'], false);
      assert.equal('x' in body, false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});

test('the apply script never logs the admin address and sends only the recorded Add User fields', async () => {
  const email = 'first.admin@example.test';
  const dir = mkdtempSync(join(tmpdir(), 'c2c-apply-admin-'));
  const fresh = await startFakeAdminApi({ roles: [] });
  const readable = await startFakeAdminApi({ roles: [{ role_name: 'App Administrator', role_id: '5001' }] });
  try {
    writeApplyTree(dir);
    const admin = ['--admin-email', email, '--admin-name', 'Ada Admin', '--domain', 'demo-app.onslate.in'];
    const dry = await runApplyScript(dir, admin);
    // Fresh project: GET /role lists nothing, so no invite is sent and the exact values block prints.
    const none = await runApplyScript(dir, ['--apply', '--host', `http://127.0.0.1:${fresh.port}`, ...admin]);
    assert.equal(none.code, 0, none.stderr);
    assert.equal(fresh.posted.some((call) => call.path.endsWith('/project-user')), false);
    assert.ok(
      none.stdout.includes(
        [
          'Authentication > User Management > Users > Add User — enter exactly:',
          '  Email: <admin-email> (the --admin-email address)',
          '  Role: App Administrator',
          '  Platform: Web',
          '  Component: Slate',
          '  Slate App: <the Slate app this deploy created>',
          '  Deployment: default',
          '  Redirect URL: https://demo-app.onslate.in',
        ].join('\n'),
      ),
      none.stdout,
    );
    const sent = await runApplyScript(dir, ['--apply', '--host', `http://127.0.0.1:${readable.port}`, ...admin]);
    assert.equal(sent.code, 0, sent.stderr);
    const invite = readable.posted.find((call) => call.path.endsWith('/project-user'));
    assert.deepEqual(invite?.body, {
      platform_type: 'web',
      redirect_url: 'https://demo-app.onslate.in',
      user_details: { email_id: email, first_name: 'Ada Admin', last_name: '', role_id: '5001' },
    });
    for (const out of [dry, none, sent]) {
      const text = out.stdout + out.stderr;
      assert.equal(text.includes(email), false, text);
      assert.equal(text.includes('Ada Admin'), false, text);
    }
    assert.match(sent.stdout, /<admin-email>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await fresh.close();
    await readable.close();
  }
});

test('a malformed --role-ids is a usage error (exit 2), not a crash', async () => {
  // The list call is empty so the flag value is the only fill source.
  const api = await startFakeAdminApi({ roles: [] });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-apply-roleids-'));
  try {
    writeApplyTree(dir);
    const host = `http://127.0.0.1:${api.port}`;
    for (const bad of ['App User=ab"cd', 'App User=abc', 'App User=', '=5002', 'App User']) {
      const res = await runApplyScript(dir, ['--apply', '--host', host, '--role-ids', bad]);
      assert.equal(res.code, 2, bad);
      assert.match(res.stderr, /--role-ids/);
    }
    // A well-formed entry still resolves: the flag id fills the clone body.
    const ok = await runApplyScript(dir, ['--apply', '--host', host, '--role-ids', 'App User=5002']);
    assert.equal(ok.code, 0, ok.stderr);
    const roles = api.posted.filter((call) => call.path.endsWith('/role'));
    assert.ok(roles.length > 0, 'no POST /role reached the fake project');
    for (const call of roles) assert.equal((call.body as Record<string, unknown>)['clone_role'], '5002');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});

test('principal-map.json in the function dir covers the custom roles', () => {
  const plan = authPlan(appOf(DEMO));
  const files = functionDir([], { mode: 'dry-run', roleMap: principalRoleMap(plan) });
  const entry = files.find((file) => file.path === 'functions/c2c_api/principal-map.json');
  assert.ok(entry);
  const roles = (JSON.parse(String(entry.data)) as { roles: Record<string, string> }).roles;
  assert.equal(roles['Staff'], 'Staff');
  assert.equal(roles['Customers'], 'Customers');
  // Built-ins stay mapped to the Creator presets; hierarchy roles are not profiles.
  assert.equal(roles['App Administrator'], 'Administrator');
  assert.equal(roles['App User'], 'User');
  assert.equal(roles['CEO'], undefined);
  assert.deepEqual(Object.keys(roles), [...Object.keys(roles)].sort());
});

test('the apply script derives a non-empty first_name from the admin email (live: empty is 400 MISSING_PARAM)', async () => {
  const email = 'jane.doe@example.test';
  const api = await startFakeAdminApi({ roles: [{ role_name: 'App Administrator', role_id: '5001' }] });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-apply-name-'));
  try {
    writeApplyTree(dir);
    // No --admin-name: the email local part supplies the name.
    const res = await runApplyScript(dir, ['--apply', '--host', `http://127.0.0.1:${api.port}`, '--admin-email', email, '--domain', 'demo-app.onslate.in']);
    assert.equal(res.code, 0, res.stderr);
    const invite = api.posted.find((call) => call.path.endsWith('/project-user'));
    assert.equal((invite?.body as { user_details: { first_name: string } }).user_details.first_name, 'Jane');
    // An explicit --admin-name still wins.
    const named = await runApplyScript(dir, ['--apply', '--host', `http://127.0.0.1:${api.port}`, '--admin-email', email, '--admin-name', 'Janet', '--domain', 'demo-app.onslate.in']);
    assert.equal(named.code, 0, named.stderr);
    assert.equal((api.posted.at(-1)?.body as { user_details: { first_name: string } }).user_details.first_name, 'Janet');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});

test('the apply script names a 400 MISSING_PARAM invite answer and prints the Add User block', async () => {
  const api = await startFakeAdminApi({
    roles: [{ role_name: 'App Administrator', role_id: '5001' }],
    invite: { status: 400, body: { status: 'failure', data: { error_code: 'MISSING_PARAM', message: 'Mandatory parameter first_name is missing.' } } },
  });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-apply-missing-'));
  try {
    writeApplyTree(dir);
    const res = await runApplyScript(dir, ['--apply', '--host', `http://127.0.0.1:${api.port}`, '--admin-email', 'jane@example.test', '--domain', 'demo-app.onslate.in']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /MISSING_PARAM/);
    assert.match(res.stdout, /first_name/);
    assert.ok(res.stdout.includes('Authentication > User Management > Users > Add User — enter exactly:'), res.stdout);
    assert.match(res.stdout, /  Role: App Administrator/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});

test('the apply script pins the first admin role: --admin-role only accepts App Administrator', async () => {
  const api = await startFakeAdminApi({ roles: [{ role_name: 'App Administrator', role_id: '5001' }] });
  const dir = mkdtempSync(join(tmpdir(), 'c2c-apply-role-'));
  try {
    writeApplyTree(dir);
    const host = `http://127.0.0.1:${api.port}`;
    const bad = await runApplyScript(dir, ['--apply', '--host', host, '--admin-email', 'jane@example.test', '--admin-role', 'CEO', '--domain', 'demo-app.onslate.in']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--admin-role/);
    assert.equal(api.posted.some((call) => call.path.endsWith('/project-user')), false);
    const ok = await runApplyScript(dir, ['--apply', '--host', host, '--admin-email', 'jane@example.test', '--admin-role', 'App Administrator', '--domain', 'demo-app.onslate.in']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(api.posted.some((call) => call.path.endsWith('/project-user')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await api.close();
  }
});
