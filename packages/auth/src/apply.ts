/**
 * Apply artifacts for the dry-run auth plan: one Catalyst role per Creator
 * profile, per-role Data Store permissions and scopes, the invite plan, and
 * the Custom User Validation hook.
 *
 * Everything emitted is a config/script file the user runs against the
 * project. The generator never calls Catalyst. REST shapes used:
 *   POST /baas/v1/project/<id>/role                    needs clone_role (role id)
 *   PUT  /baas/v1/project/<id>/table/<tid>/permission  {<role>: ["SELECT", ...]}
 *   PUT  /baas/v1/project/<id>/table/<tid>/scopes      {<role>: "ORG"}
 *   POST /baas/v1/project/<id>/authentication/enable?auth_type=hosted|embedded
 *   POST /baas/v1/project/<id>/cors-domain             {domain, cors:true, iframe:true}
 *   GET  /baas/v1/project/<id>/project-user            lists confirmed users only
 *   GET  /baas/v1/project/<id>/project-user/<uid>      verifies an invite by id
 *   POST /baas/v1/project/<id>/project-user            admin Add User invite (the console's recorded
 *                                                      fields only; a CLI-token send is UNVERIFIED)
 *
 * The CLI OAuth token refuses (OAUTH_SCOPE_MISMATCH / AUTHENTICATION_FAILURE):
 * GET /authentication/configuration, GET /cors-domain, GET /role,
 * PUT /authentication/configuration, POST /role, and the permission PUTs.
 * Those stay console steps; the 200 body of a write is its proof. Invites are
 * an owner action: an email is never invented. Public signup stays off; the
 * Custom User Validation function denies every signup until the user
 * fills its allow list.
 */
import type { AuthPlan, PlannedRole, TablePermission } from './plan.js';
import { BUILTIN_ROLES } from './plan.js';
import { slateHost } from './slate-host.js';

export const APPLY_JSON = 'auth/c2c-auth-apply.json';
export const APPLY_REPORT = 'auth/c2c-auth-apply.md';
export const APPLY_SCRIPT = 'auth/c2c-auth-apply.mjs';
export const CUV_DIR = 'auth/c2c_user_validation';
export const CUV_FUNCTION = 'c2c_user_validation';

export interface ApplyRole {
  role_name: string;
  clone_role: PlannedRole['clone_role'];
  portal: boolean;
  source: PlannedRole['source'];
  parent?: string;
  /** POST body; {role_id:<name>} is resolved at apply time, never invented here. */
  call: { method: 'POST'; path: '/role'; body: Record<string, unknown> };
}

export interface ApplyTablePermission {
  role: string;
  table: string;
  permissions: TablePermission['permissions'];
  scope: TablePermission['scope'];
  /** {table_id:<name>} resolves at apply time through GET /table. */
  calls: { method: 'PUT'; path: string; body: Record<string, unknown> }[];
}

export interface ApplyInvite {
  profile: string;
  role: string;
  /** Owner action fills this; the export carries no email addresses. */
  emails: string[];
  via: 'console-or-mcp-add-user';
}

export interface ApplyCall {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}

/**
 * The ops the CLI token can do, in order, plus what stays console.
 * {slate_domain}, {admin_email}, {admin_name} and {role_id:<name>} fill from
 * script flags (--domain/--admin-email/…/ --admin-role-id) or the user list.
 */
export interface AuthProvisioning {
  calls: ApplyCall[];
  /** The one auth read the token allows — verifies the first admin landed. */
  verify: ApplyCall;
  /** Refused under the CLI token (recorded status + code); console confirms. */
  consoleOnly: { op: string; status: number; code: string; console: string }[];
}

export interface ApplyCustomUserValidation {
  function: typeof CUV_FUNCTION;
  type: 'basicio';
  directory: typeof CUV_DIR;
  policy: 'deny-by-default';
  /** Roles a validated signup may receive. Only portal roles are assignable. */
  assignableRoles: string[];
  roles: string[];
  requires: string[];
}

export interface AuthApplyPlan {
  version: 1;
  dryRun: true;
  authentication: AuthPlan['authentication'];
  /** Deploy-time auth provisioning the CLI token can write. */
  provisioning: AuthProvisioning;
  roles: ApplyRole[];
  tablePermissions: ApplyTablePermission[];
  invites: ApplyInvite[];
  /** Page grants have no Data Store op; the Slate client filters nav by profile. */
  pageAccess: AuthPlan['pageAccess'];
  customUserValidation: ApplyCustomUserValidation;
  /** Ordered human steps; c2c-auth-apply.mjs performs the REST ones. */
  steps: string[];
}

/** The first admin's Catalyst role; its id is per-project and console-read (GET /role is refused). */
export const ADMIN_ROLE = 'App Administrator';

export function authProvisioning(): AuthProvisioning {
  return {
    calls: [
      { method: 'POST', path: '/authentication/enable?auth_type=hosted', body: { public_signup: false } },
      { method: 'POST', path: '/authentication/enable?auth_type=embedded', body: {} },
      { method: 'POST', path: '/cors-domain', body: { domain: '{slate_domain}', cors: true, iframe: true } },
      {
        method: 'POST',
        path: '/project-user',
        body: {
          platform_type: 'web',
          redirect_url: 'https://{slate_domain}',
          user_details: { email_id: '{admin_email}', first_name: '{admin_name}', last_name: '', role_id: `{role_id:${ADMIN_ROLE}}` },
        },
      },
    ],
    verify: { method: 'GET', path: '/project-user/{admin_user_id}' },
    consoleOnly: [
      { op: 'GET /authentication/configuration', status: 401, code: 'OAUTH_SCOPE_MISMATCH', console: 'confirm hosted + embedded under Authentication > Authentication Type' },
      { op: 'GET /cors-domain', status: 401, code: 'OAUTH_SCOPE_MISMATCH', console: 'confirm the Slate host under Authentication > Whitelisting > Authorized Domains (CORS on, iFrame on — the embedded sign-in frame needs it; on an existing domain, Edit > iFrame on)' },
      { op: 'GET /role', status: 401, code: 'OAUTH_SCOPE_MISMATCH', console: 'role ids are per-project; deploy reads the first-admin id from an existing project-user role_details, otherwise the first admin is a console Add User step' },
      { op: 'PUT /authentication/configuration', status: 401, code: 'OAUTH_SCOPE_MISMATCH', console: 'url_preference and other config changes are console-only — set the hosted-login redirect to the Slate app URL under Authentication Type when invite links land elsewhere' },
      { op: 'POST /role', status: 401, code: 'AUTHENTICATION_FAILURE', console: 'create each role in the console (Authentication > Roles > Add Role, clone the same base)' },
      { op: 'PUT /table/<id>/permission and /scopes', status: 401, code: 'OAUTH_SCOPE_MISMATCH', console: 'per-table permissions and scopes are set in the console per table' },
    ],
  };
}

export function authApplyPlan(plan: AuthPlan): AuthApplyPlan {
  const portalRoles = plan.roles.filter((role) => role.portal).map((role) => role.role_name);
  const roles: ApplyRole[] = plan.roles.map((role) => ({
    role_name: role.role_name,
    clone_role: role.clone_role,
    portal: role.portal,
    source: role.source,
    ...(role.parent ? { parent: role.parent } : {}),
    call: {
      method: 'POST',
      path: '/role',
      body: {
        role_name: role.role_name,
        ...(role.description ? { description: role.description } : {}),
        is_default: false,
        clone_role: `{role_id:${role.clone_role}}`,
      },
    },
  }));
  const tablePermissions: ApplyTablePermission[] = plan.tablePermissions.map((perm) => ({
    role: perm.role,
    table: perm.table,
    permissions: [...perm.permissions],
    scope: perm.scope,
    calls: [
      { method: 'PUT', path: `/table/{table_id:${perm.table}}/permission`, body: { [perm.role]: perm.permissions } },
      { method: 'PUT', path: `/table/{table_id:${perm.table}}/scopes`, body: { [perm.role]: perm.scope } },
    ],
  }));
  const invites: ApplyInvite[] = plan.portalUsers.map((user) => ({
    profile: user.profile,
    role: user.catalystRole,
    emails: [],
    via: 'console-or-mcp-add-user',
  }));
  const customUserValidation: ApplyCustomUserValidation = {
    function: CUV_FUNCTION,
    type: 'basicio',
    directory: CUV_DIR,
    policy: 'deny-by-default',
    assignableRoles: portalRoles,
    roles: plan.roles.map((role) => role.role_name),
    requires: [
      `copy ${CUV_DIR} into functions/ and add "${CUV_FUNCTION}" to functions.targets in catalyst.json`,
      `catalyst deploy --only functions:${CUV_FUNCTION}`,
      'turn on public signup (console: Authentication > Whitelisting > Custom User Validation)',
      `select ${CUV_FUNCTION} as the signup validator`,
    ],
  };
  const steps = [
    'Enable login by API: POST /authentication/enable?auth_type=hosted {"public_signup":false}, then ?auth_type=embedded {} — the 200 body is the proof; the config read is refused.',
    'Authorise the Slate host by API: POST /cors-domain {"domain":…, "cors":true, "iframe":true} — --domain or the App Url that slate:link prints; iFrame on is what lets the embedded sign-in frame load.',
    `First admin by API: POST /project-user needs --admin-email, the ${ADMIN_ROLE} role id, and redirect_url = the Slate app URL; public signup is not used. Deploy resolves the role id through GET /role or an existing project user's role_details. On a fresh project (no app users yet, GET /role refused for the CLI token) the console Add User step is the path today — deploy prints the exact values: Role = ${ADMIN_ROLE}, Platform = Web, Component = Slate + the app, Deployment = default, Redirect URL = the Slate app URL.`,
    'Roles: create each roles[] entry in the console (Add Role, clone the named base) — POST /role is refused for the CLI token.',
    'Table permissions and scopes: the calls[] under each tablePermissions[] entry are scope-refused for the CLI token — set them in the console per table.',
    ...(invites.length
      ? ['Assign the portal role to invited app users (invites[]). Owner action: console Add User or MCP Add_User — every invite carries redirect_url = the Slate app URL, or the mailed link lands on a page that does not exist; emails are operator input.']
      : []),
    `Deploy and select the Custom User Validation function (${customUserValidation.requires.join('; ')}).`,
  ];
  return {
    version: 1,
    dryRun: true,
    authentication: plan.authentication,
    provisioning: authProvisioning(),
    roles,
    tablePermissions,
    invites,
    pageAccess: plan.pageAccess,
    customUserValidation,
    steps,
  };
}

/**
 * Catalyst role -> Creator profile for functions/c2c_api/principal-map.json.
 * Only profile roles map (a hierarchy role is not a profile). A profile that
 * spelled a built-in role was renamed to a distinct custom role ('Creator
 * <name>'), so no key can shadow the built-in entries the merge puts last.
 */
export function principalRoleMap(plan: AuthPlan): Record<string, string> {
  const profiles = plan.accessPolicy.profiles;
  const map: Record<string, string> = {};
  for (const role of plan.roles) {
    if (role.source !== 'profile' || BUILTIN_ROLES.has(role.role_name)) continue;
    const profile = role.profile ?? role.role_name;
    if (!Object.prototype.hasOwnProperty.call(profiles, profile)) continue;
    map[role.role_name] = profile;
  }
  const ordered: Record<string, string> = {};
  for (const name of Object.keys(map).sort()) ordered[name] = map[name] as string;
  return ordered;
}

export function authApplyJson(apply: AuthApplyPlan): string {
  return `${JSON.stringify(apply, null, 2)}\n`;
}

/** Operator-facing steps: API writes the CLI token can do, console steps for the rest. */
export function authApplyReport(apply: AuthApplyPlan): string {
  const lines = [
    '# Auth apply plan (dry run)',
    '',
    'This tree was generated offline. Nothing here has run against the project.',
    'The CLI token can write auth enable, the authorised domain and the first-admin signup,',
    'and can read back project users only; the writes below are console steps under it.',
    '',
    '## Authentication provisioning (API writes)',
    ...apply.provisioning.calls.map((call) => `- ${call.method} ${call.path}${call.body ? ` ${JSON.stringify(call.body)}` : ''}`),
    `- verify: ${apply.provisioning.verify.method} ${apply.provisioning.verify.path} (the only auth read the token allows)`,
    '',
    '## Console-only under the CLI token',
    ...apply.provisioning.consoleOnly.map((item) => `- ${item.op} → ${item.status} ${item.code}: ${item.console}`),
    '',
    '## Roles',
    ...(apply.roles.length
      ? apply.roles.map(
          (role) =>
            `- ${role.role_name} (clone of ${role.clone_role}${role.portal ? ', portal' : ''}${role.parent ? `, parent ${role.parent}` : ''})` +
            ` — POST /role; console: Authentication > Roles > Add Role`,
        )
      : ['- none']),
    '',
    '## Table permissions',
    ...(apply.tablePermissions.length
      ? apply.tablePermissions.map(
          (perm) =>
            `- ${perm.table} / ${perm.role}: ${perm.permissions.join(' ') || 'no access'} @ ${perm.scope}` +
            ` — PUT /table/<id>/permission and /table/<id>/scopes`,
        )
      : ['- none (no app tables)']),
    '',
    '## Invites',
    ...(apply.invites.length
      ? apply.invites.map((invite) => `- profile ${invite.profile} -> role ${invite.role} — owner action: console Add User or MCP Add_User; emails are operator input`)
      : ['- none (no portal profile in the export)']),
    '',
    '## Custom User Validation',
    `- ${apply.customUserValidation.directory} (Basic I/O, ${apply.customUserValidation.policy})`,
    ...apply.customUserValidation.requires.map((step) => `  - ${step}`),
    apply.customUserValidation.assignableRoles.length
      ? `- assignable roles: ${apply.customUserValidation.assignableRoles.join(', ')}`
      : '- no portal role is planned, so the generated validator denies every signup',
    '',
    '## Order of operations (auth/c2c-auth-apply.mjs)',
    ...apply.steps.map((step, i) => `${i + 1}. ${step}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Catalyst admin API host per data centre. Mirrors the DC list in
 * packages/data/src/migrate.ts (DC_SUFFIXES): the admin API is always
 * api.catalyst.zoho.<dc tld>. An unknown DC has no host — never a guess.
 */
export const CATALYST_API_HOSTS: Readonly<Record<string, string>> = {
  in: 'https://api.catalyst.zoho.in',
  com: 'https://api.catalyst.zoho.com',
  eu: 'https://api.catalyst.zoho.eu',
  'com.au': 'https://api.catalyst.zoho.com.au',
  jp: 'https://api.catalyst.zoho.jp',
  ca: 'https://api.catalyst.zoho.ca',
  sa: 'https://api.catalyst.zoho.sa',
  'com.cn': 'https://api.catalyst.zoho.com.cn',
  ae: 'https://api.catalyst.zoho.ae',
};

/** https://api.catalyst.zoho.<dc> for a known DC, undefined otherwise. */
export function catalystApiHost(dc: string | undefined): string | undefined {
  if (!dc) return undefined;
  return CATALYST_API_HOSTS[dc.trim().toLowerCase()];
}

/**
 * Self-contained Node script (no dependencies) the user may run:
 *   node auth/c2c-auth-apply.mjs --project <id> --token <oauth> [--apply]
 * Prints the ops by default; --apply sends them over the admin REST API.
 * Recorded scope refusals print a console step instead of
 * stopping the run: the reads the token cannot do stay console-confirmed.
 *
 * The host comes from the deploy config — never a hard-coded default:
 * --host/--dc flags, CATALYST_HOST/CATALYST_DC env, the dc deploy wrote into
 * functions/c2c-deploy.json (or functions/c2c_api/c2c-deploy.json), then the
 * DC this script was generated for. --apply fails rather than guessing a host.
 */
export function applyScriptSource(dc?: string): string {
  const bakedHost = catalystApiHost(dc);
  return `#!/usr/bin/env node
// Generated by creator-to-catalyst. Applies ./c2c-auth-apply.json to one
// Catalyst project. The default is a dry print; --apply sends the calls.
//
//   node c2c-auth-apply.mjs --project <id> --token <oauth> [--host <url>|--dc <dc>]
//     [--domain <slate-host>] [--admin-email <mail>] [--admin-name <name>]
//     [--admin-role-id <id>] [--role-ids <Name=id,...>]
//     [--apply]
//
// Env fallbacks: CATALYST_PROJECT_ID, CATALYST_TOKEN, CATALYST_HOST,
// CATALYST_DC. Without --host/CATALYST_HOST the host is derived from the DC:
// --dc, CATALYST_DC, the dc deploy recorded in functions/c2c-deploy.json
// (functions/c2c_api/c2c-deploy.json),${bakedHost ? ` then this tree's DC (${bakedHost}).` : ' then this tree\'s DC.'}
// The CLI token cannot read auth config,
// the domain list or roles (401 OAUTH_SCOPE_MISMATCH): a 200 write body is
// the proof, and every refused or missing-input op prints a console step.
// Invites beyond --admin-email are printed, never sent — an email is never
// invented.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(readFileSync(join(here, 'c2c-auth-apply.json'), 'utf8'));

const args = process.argv.slice(2);
const flag = (name) => args.includes('--' + name);
const value = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (message) => {
  console.error('c2c-auth-apply: ' + message);
  process.exit(1);
};

// DC -> admin API host, the same list deploy uses.
const CATALYST_API_HOSTS = ${JSON.stringify(CATALYST_API_HOSTS, null, 2).replace(/\n/g, '\n')};
const hostForDc = (dc) => (dc ? CATALYST_API_HOSTS[String(dc).trim().toLowerCase()] : undefined);
// The deploy tree records its DC in functions/c2c-deploy.json (c2c ui) or
// functions/c2c_api/c2c-deploy.json (c2c deploy); either may carry dc/zohoDc.
const deployConfigDc = () => {
  for (const rel of ['../functions/c2c-deploy.json', '../functions/c2c_api/c2c-deploy.json']) {
    const path = join(here, rel);
    if (!existsSync(path)) continue;
    try {
      const cfg = JSON.parse(readFileSync(path, 'utf8'));
      const dc = cfg && (cfg.dc ?? cfg.zohoDc);
      if (typeof dc === 'string' && dc.trim()) return dc;
    } catch {}
  }
  return undefined;
};

// The one Slate-host rule deploy and provision share — a bare hostname or the
// https App Url slate:link prints; no wildcard, userinfo, port, path or query.
${slateHost.toString()}

const project = value('project') ?? process.env.CATALYST_PROJECT_ID;
const token = value('token') ?? process.env.CATALYST_TOKEN;
const dc = value('dc') ?? process.env.CATALYST_DC ?? deployConfigDc() ?? ${bakedHost ? JSON.stringify(dc) : 'undefined'};
const host = (value('host') ?? process.env.CATALYST_HOST ?? hostForDc(dc) ?? '').replace(/\\/+$/, '');
const apply = flag('apply');
const domainArg = value('domain') ?? process.env.CATALYST_SLATE_DOMAIN;
const domain = slateHost(domainArg);
if (domainArg !== undefined && !domain) fail('--domain must be a Slate app host — a bare hostname or the https App Url slate:link prints');
const adminEmail = value('admin-email');
// POST /project-user rejects an empty first_name (400 MISSING_PARAM), so a
// name is always sent: --admin-name when given, else a deterministic one from
// the email local part ("jane.doe@…" -> "Jane"), else "Admin".
const firstNameFromEmail = (email) => {
  const local = String(email ?? '').split('@')[0];
  const first = local.split(/[^A-Za-z0-9]+/).find((part) => part !== '') ?? '';
  return first ? first[0].toUpperCase() + first.slice(1) : 'Admin';
};
const adminName = (value('admin-name') ?? '').trim() || (adminEmail ? firstNameFromEmail(adminEmail) : '');
// The first admin's role is pinned: --admin-role accepts App Administrator
// only — the invite can never name a wider custom role.
const adminRole = value('admin-role') ?? 'App Administrator';
if (adminRole !== 'App Administrator') fail('--admin-role is pinned: the first admin is always invited as App Administrator');
const adminRoleId = value('admin-role-id');
const usage = (message) => {
  console.error('c2c-auth-apply: ' + message);
  process.exit(2);
};
const roleIds = new Map();
for (const pair of String(value('role-ids') ?? '').split(',')) {
  if (!pair.trim()) continue;
  const eq = pair.indexOf('=');
  const name = eq > 0 ? pair.slice(0, eq).trim() : '';
  const id = eq > 0 ? pair.slice(eq + 1).trim() : '';
  if (!name || !/^[0-9]+$/.test(id)) usage('--role-ids must be <Name=id,...> with a decimal id per entry (for example --role-ids "Staff=5002")');
  roleIds.set(name, id);
}
console.log('host: ' + (host || '(unresolved — --apply needs --host, --dc, or a dc in functions/c2c-deploy.json)'));
if (!project || !/^[0-9]+$/.test(project)) fail('a numeric --project id is required');
if (apply && !token) fail('--apply needs --token or CATALYST_TOKEN');
if (apply && !host) fail('--apply needs the Catalyst API host — pass --host <https://api.catalyst.zoho.<dc>> or --dc <dc>, or deploy so functions/c2c-deploy.json records the dc');

const base = host + '/baas/v1/project/' + project;
const REFUSED = /OAUTH_SCOPE_MISMATCH|AUTHENTICATION_FAILURE|PUBLIC_SIGNUP_ERROR|INVALID_URL_PATTERN/;
const consoleNotes = [];
const note = (text) => {
  consoleNotes.push(text);
  console.log('console: ' + text);
};
const consoleFor = (op, fallback) => {
  const hit = (plan.provisioning?.consoleOnly ?? []).find((item) => item.op === op);
  note(hit ? op + ' — ' + hit.console : fallback ?? op);
};

// Logs never carry the admin address or name: they print as placeholders.
const masked = (text) => {
  let out = text;
  if (adminEmail) out = out.split(adminEmail).join('<admin-email>');
  if (adminName) out = out.split(JSON.stringify(adminName).slice(1, -1)).join('<admin-name>');
  return out;
};

async function send(method, path, body) {
  const label = masked(method + ' ' + path + (body === undefined ? '' : ' ' + JSON.stringify(body)));
  if (!apply) {
    console.log('dry-run ' + label);
    return { dry: true, ok: false, status: 0, body: null };
  }
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: 'Zoho-oauthtoken ' + token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let body0 = null;
  try {
    body0 = JSON.parse(text);
  } catch {}
  const code = REFUSED.exec(text)?.[0];
  if (res.ok) console.log('ok ' + label);
  else console.log((code ? 'refused ' : 'error ') + label + ' -> HTTP ' + res.status + (code ? ' ' + code : ''));
  return { ok: res.ok, status: res.status, body: body0, code };
}

function addUserValues() {
  return [
    'Authentication > User Management > Users > Add User — enter exactly:',
    '  Email: <admin-email> (the --admin-email address)',
    '  Role: ' + adminRole,
    '  Platform: Web',
    '  Component: Slate',
    '  Slate App: <the Slate app this deploy created>',
    '  Deployment: default',
    '  Redirect URL: ' + (domain ? 'https://' + domain : '<the Slate app URL>'),
  ].join('\\n');
}

function rows(payload, keys) {
  for (const key of keys) {
    const list = payload && payload[key];
    if (Array.isArray(list)) return list;
  }
  return Array.isArray(payload) ? payload : null;
}

function rowId(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).length) return String(value);
  }
  return undefined;
}

function userEmail(user) {
  for (const key of ['email_id', 'email', 'emailId', 'user_email']) {
    const value = user[key];
    if (typeof value === 'string' && value.includes('@')) return value.toLowerCase();
  }
  return undefined;
}

function findUserId(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return undefined;
  const direct = rowId(value, ['user_id', 'userId', 'id']);
  if (direct) return direct;
  for (const child of Object.values(value)) {
    const found = findUserId(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

// Role name -> id: --admin-role-id / --role-ids first, then GET /role when the
// token has the scope, then an existing project user's role_details.
function roleIdFor(name, users) {
  if (name === adminRole && adminRoleId) return adminRoleId;
  if (roleIds.has(name)) return roleIds.get(name);
  for (const user of users ?? []) {
    const details = user.role_details ?? user.roleDetails ?? {};
    const id = details.role_id ?? details.roleId ?? details.id;
    if ((details.role_name ?? details.roleName ?? user.role_name) === name && id != null) return String(id);
  }
  return undefined;
}

// Placeholders fill inside the parsed body — the JSON is rebuilt by the
// serializer, so a value can never splice keys into the request.
function fillInputs(value, users) {
  if (typeof value === 'string') {
    return value
      .replace(/\\{slate_domain\\}/g, domain ?? '{slate_domain}')
      .replace(/\\{admin_email\\}/g, adminEmail ?? '{admin_email}')
      .replace(/\\{admin_name\\}/g, adminName || '{admin_name}')
      .replace(/\\{role_id:([^}]+)\\}/g, (_m, name) => roleIdFor(name, users) ?? '{role_id:' + name + '}');
  }
  if (Array.isArray(value)) return value.map((item) => fillInputs(item, users));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = fillInputs(value[key], users);
    return out;
  }
  return value;
}

// List the visible users first, then try GET /role before falling back to an
// existing user's role_details. Unconfirmed invitees are hidden from the list,
// so verification uses the user id returned by POST /project-user.
const firstUsers = await send('GET', '/project-user');
const usersBefore = firstUsers.ok ? rows(firstUsers.body, ['data', 'users', 'project_users']) : null;
if (apply && !firstUsers.ok) note('GET /project-user did not return a list this run — verification uses the invite response user id.');

const roleList = await send('GET', '/role');
const roleMap = new Map();
for (const row of rows(roleList.body, ['roles', 'data']) ?? []) {
  const id = rowId(row, ['role_id', 'roleId', 'id']);
  const name = rowId(row, ['role_name', 'roleName', 'name']);
  if (id && name) roleMap.set(name, id);
}
const rolesReadable = roleList.ok || !apply;
// Listed ids join the flag map (flags win) so the parsed fill below resolves
// every clone id as a string value — an id can never splice keys into the
// request the way filling request text could.
for (const [name, id] of roleMap) if (!roleIds.has(name)) roleIds.set(name, id);

// 1) Provisioning writes the token can do. The admin invite is
// POST /project-user, not the self-service signup route.
let adminUserId;
for (const call of plan.provisioning?.calls ?? []) {
  const isInvite = call.path === '/project-user';
  const body = fillInputs(call.body ?? {}, usersBefore);
  if (!apply) {
    await send(call.method, call.path, body);
    continue;
  }
  if (isInvite && !adminEmail) {
    note('POST /project-user — pass --admin-email so deploy can invite the first admin; the only human steps are accepting the emailed invite and signing in once.');
    continue;
  }
  if (call.path === '/cors-domain' && !domain) {
    note('POST /cors-domain — pass --domain <slate-host> (the App Url slate:link prints) or add the host under Authentication > Whitelisting > Authorized Domains.');
    continue;
  }
  if (isInvite && JSON.stringify(body).includes('{role_id:')) {
    note('POST /project-user — the ' + adminRole + ' role id is unresolved (GET /role refused and no project user carries it). No invite was sent. On a fresh project the console Add User step is the path today:\\n' + addUserValues());
    continue;
  }
  if (isInvite && typeof body.redirect_url === 'string' && body.redirect_url.includes('{slate_domain}')) {
    note('POST /project-user — the invite needs redirect_url = the Slate app URL: pass --domain <slate-host> (the App Url slate:link prints); the invite is not sent without it.');
    continue;
  }
  const res = await send(call.method, call.path, body);
  if (isInvite && res.ok) adminUserId = findUserId(res.body);
  const inviteMissingParam = isInvite && res.status === 400 && /MISSING_PARAM/.test(JSON.stringify(res.body ?? '')) && /first_name/i.test(JSON.stringify(res.body ?? ''));
  if (inviteMissingParam) {
    // A named error with the exact block — never a silent console fallback.
    note('POST /project-user failed: HTTP 400 MISSING_PARAM — first_name is mandatory (pass --admin-name <name>); no invite was re-sent. Add the first admin in the console:\\n' + addUserValues());
  } else if (!res.ok && !res.dry) {
    consoleFor(call.method + ' ' + call.path.split('?')[0], call.method + ' ' + call.path + ' was refused for this token — do it in the console.');
  }
}

// 2) Roles. GET /role was already attempted above; a refusal keeps clone ids
// unresolved and POST /role console-only unless flags supplied the ids.
for (const role of plan.roles) {
  const body = apply ? fillInputs(role.call.body, usersBefore) : role.call.body;
  if (apply && JSON.stringify(body).includes('{role_id:')) {
    note('POST /role for "' + role.role_name + '" (clone ' + role.clone_role + ') — role ids are console-read; create it under Authentication > Roles > Add Role cloned from ' + role.clone_role + '.');
    continue;
  }
  const res = await send(role.call.method, role.call.path, body);
  if (!res.ok && !res.dry) consoleFor('POST /role', 'create role "' + role.role_name + '" in the console (clone ' + role.clone_role + ')');
}
if (apply && !rolesReadable) note('GET /role was refused — role creation above fell back to the console for every entry.');

// 3) Table permissions. GET /table resolves the ids; the PUTs are
// scope-refused for the CLI token and print console steps then.
const tableList = await send('GET', '/table');
const tableMap = new Map();
for (const row of rows(tableList.body, ['tables', 'data']) ?? []) {
  const id = rowId(row, ['table_id', 'tableId', 'id']);
  const name = rowId(row, ['table_name', 'tableName', 'tab_name', 'name']);
  if (id && name) tableMap.set(name, id);
}
for (const perm of plan.tablePermissions) {
  for (const step of perm.calls) {
    const path = step.path.replace(/\\{table_id:([^}]+)\\}/g, (_m, name) => tableMap.get(name) ?? '{table_id:' + name + '}');
    if (apply && path.includes('{table_id:')) {
      note('PUT ' + step.path + ' — the table id for ' + perm.table + ' is unresolved; set ' + perm.role + ' ' + (perm.permissions.join(' ') || 'no access') + ' @ ' + perm.scope + ' in the console.');
      continue;
    }
    const res = await send(step.method, path, step.body);
    if (!res.ok && !res.dry) consoleFor('PUT /table/<id>/permission and /scopes', 'set ' + perm.role + ' on ' + perm.table + ' in the console: ' + (perm.permissions.join(' ') || 'no access') + ' @ ' + perm.scope);
  }
}

// 4) Portal invites are owner actions — printed, never sent.
for (const invite of plan.invites) {
  console.log('invite (owner action, not sent): role "' + invite.role + '" for profile "' + invite.profile + '" — add the user in the console or via MCP Add_User with redirect_url = the Slate app URL (the mailed link does not resolve without it)');
}

// 5) Read-back verification where the token can read. A known invite id uses
// the documented per-user route because the list hides unconfirmed users.
if (apply) {
  const verifyPath = (plan.provisioning?.verify?.path ?? '/project-user').replace('{admin_user_id}', adminUserId ?? '');
  const verify = await send(plan.provisioning?.verify?.method ?? 'GET', adminUserId ? verifyPath : '/project-user');
  if (adminUserId && verify.ok) {
    const user = verify.body?.data ?? verify.body?.user_details ?? verify.body;
    const confirmed = user && (user.is_confirmed === true || user.is_confirmed === 'true');
    console.log(confirmed ? 'verified: the first admin is confirmed by GET /project-user/<id>' : 'pending: the first admin is unconfirmed — accept the emailed invite and sign in once, then re-run');
  } else if (adminUserId) {
    console.log('pending: the invite user id could not be read back this run — re-run after the admin accepts and signs in; no invite was re-sent');
  } else {
    const users = verify.ok ? rows(verify.body, ['data', 'users', 'project_users']) : null;
    if (users && adminEmail) {
      const found = users.some((user) => userEmail(user) === adminEmail.toLowerCase());
      console.log(found ? 'verified: the --admin-email user is a project user' : 'pending: the --admin-email user is not listed yet — unconfirmed users are hidden from the list; re-run after the emailed invite is accepted');
    } else if (users) {
      console.log('verified: ' + users.length + ' project user' + (users.length === 1 ? '' : 's'));
    }
  }
}
console.log('custom user validation (manual):');
for (const step of plan.customUserValidation.requires) console.log('  - ' + step);
if (!apply) console.log('re-run with --apply --token <oauth> [--domain <slate-host>] [--admin-email <mail> --admin-role-id <id>] to send the provisioning calls');
`;
}

/**
 * Custom User Validation (Basic I/O) body. Deny by default: an empty
 * SIGNUP_ALLOW refuses every signup, and an entry whose role is not a planned
 * portal role fails closed too. Contract:
 * https://www.catalyst.zoho.com/help/custom-user-validation.html
 */
export function cuvFunctionSource(apply: AuthApplyPlan): string {
  const portal = Object.fromEntries(apply.customUserValidation.assignableRoles.map((name) => [name, true]));
  return `'use strict';
// Custom User Validation for the migrated app (Basic I/O), generated by
// creator-to-catalyst. Catalyst calls this on public signup; the response is
// {status:"success", user_details:{..., role_identifier}} or
// {status:"failure", error_message}. Deny by default: an empty SIGNUP_ALLOW
// refuses every signup, and only the planned portal roles are assignable.
//
// Enable: public signup on (console: Authentication > Whitelisting > Custom
// User Validation) after this function is deployed.
const catalyst = require('zcatalyst-sdk-node');

// "user@example.com" or "example.com" -> one of the planned portal roles.
// Operator input; empty denies every signup.
const SIGNUP_ALLOW = {};

const PORTAL_ROLES = ${JSON.stringify(portal)};

module.exports = async (context, basicIO) => {
  const finish = (body) => {
    basicIO.write(JSON.stringify(body));
    context.close();
  };
  const deny = (reason) => finish({ status: 'failure', error_message: reason });
  let details;
  try {
    const request = catalyst.initialize(context).userManagement().getSignupValidationRequest(basicIO);
    details = request && typeof request.user_details === 'object' ? request.user_details : null;
  } catch {
    return deny('signup request unavailable');
  }
  const email = String(details && details.email_id ? details.email_id : '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  const role = email ? SIGNUP_ALLOW[email] ?? (at > 0 ? SIGNUP_ALLOW[email.slice(at + 1)] : undefined) : undefined;
  if (typeof role !== 'string' || !PORTAL_ROLES[role]) return deny('signup is not allowed for this address');
  return finish({ status: 'success', user_details: { ...details, email_id: email, role_identifier: role } });
};
`;
}

export function authApplyFiles(plan: AuthPlan, opts: { dc?: string } = {}): { path: string; data: string }[] {
  const apply = authApplyPlan(plan);
  return [
    { path: APPLY_JSON, data: authApplyJson(apply) },
    { path: APPLY_REPORT, data: authApplyReport(apply) },
    { path: APPLY_SCRIPT, data: applyScriptSource(opts.dc) },
    { path: `${CUV_DIR}/index.js`, data: cuvFunctionSource(apply) },
    {
      path: `${CUV_DIR}/catalyst-config.json`,
      data: `${JSON.stringify(
        { deployment: { name: CUV_FUNCTION, stack: 'node20', type: 'basicio' }, execution: { main: 'index.js' } },
        null,
        2,
      )}\n`,
    },
    {
      path: `${CUV_DIR}/package.json`,
      data: `${JSON.stringify(
        { name: CUV_FUNCTION, version: '1.0.0', private: true, main: 'index.js', dependencies: { 'zcatalyst-sdk-node': '3.4.0' } },
        null,
        2,
      )}\n`,
    },
  ];
}
