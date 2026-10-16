/**
 * Creator app users -> Catalyst project users: read the backup's user lists,
 * map each user to a Catalyst role, and drive invites.
 *
 * A backup carries appUsers.csv (USER_EMAIL, NAME, FIRST_NAME, LAST_NAME,
 * USER_TYPE, USER_STATUS, PROFILE_NAME, ROLE_NAME, ZUID) and appAdmins.csv
 * (USER_EMAIL, NAME, FIRST_NAME, LAST_NAME, ZUID, CREATED_TIME, CREATED_BY_ZUID).
 * Every one of those columns is personal data or an account identifier: they
 * are read at run time only. Plans, reports and log lines name a user solely
 * by `id` — usr_<16 hex of sha256(salt + identity)> — and identities are never
 * printed, persisted or returned in a result. The salt is a random 256-bit
 * value kept only in the local state file: no plan, report or log carries the
 * salt or a fingerprint of it, so the ids cannot be rebuilt from output.
 *
 * Role mapping is deterministic and least-privilege: PROFILE_NAME names a
 * Catalyst role the auth plan emits for the same-named Creator profile (the
 * generated app's access policy is keyed by that profile name, so the role a
 * user keeps is exactly the permission set they had). A backup row whose
 * profile is not in the export maps to App User and is listed under `unmapped`
 * — a fidelity note, never a silent widening. appAdmins.csv rows are Creator
 * app administrators and map to App Administrator. A user also carries a
 * Creator hierarchy ROLE_NAME ("who they report to"); Catalyst has no
 * per-user hierarchy, so it is reported on the plan, not assigned.
 *
 * Invites go through the same admin endpoint the console Add User form posts
 * (POST /project-user) with redirect_url = the Slate app URL — an invite
 * without it mails a link that lands on a page that does not exist, so a
 * missing redirect is a pending console step, never a sent invite. A run
 * persists every landed invite to the state file and skips invited ids on
 * re-run, so a kill mid-run or a second run is idempotent.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { App } from '../../core/src/index.js';
import { canonicalUserIdentity, userIdentityAliasRules } from '../../schema/src/identity.js';
import { authPlan, type PlannedRole } from '../../auth/src/index.js';
import { readBackupUserLists } from './backup.js';
import { parseCsv } from './csv.js';
import { adminFirstName, alreadyDone, errorCode, failureInfo, idString, projectUsers, roleIdFromUsers, sanitizeMessage } from './auth.js';
import { restWithRetry, type RetryOptions } from './retry.js';
import type { RestCall, RestFn } from './tables.js';

export const USERS_PLAN_JSON = 'users/plan.json';
export const USERS_PLAN_MD = 'users/plan.md';
export const USERS_INVITES_CSV = 'users/invites.csv';
export const USERS_STATE_FILE = 'c2c-users-state.json';

/** appUsers.csv / appAdmins.csv headers, folded: lower-case, non-alnum stripped. */
function headKey(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * One row of a backup user list. `identity`, `name`, `first` and `last` are
 * personal data — runtime only; nothing below writes them to disk or output.
 */
export interface BackupUser {
  identity: string;
  name: string;
  first: string;
  last: string;
  /** USER_TYPE as written ('Z', a portal type, ...). */
  type: string;
  /** USER_STATUS as written ('Active', ...). '' for appAdmins.csv rows. */
  status: string;
  /** PROFILE_NAME — the Creator profile whose permissions the user had. */
  profile: string;
  /** ROLE_NAME — the data-hierarchy role; informational, never assigned. */
  hierarchy: string;
  /** ZUID — the Creator account id a Users-field cell stores. */
  zuid: string;
  source: 'appUsers' | 'appAdmins';
}

function userSheet(file: string, bytes: Buffer): BackupUser[] {
  const parsed = parseCsv(bytes.toString('utf8')).filter((record) => record.some((cell) => cell.trim() !== ''));
  const headers = (parsed[0] ?? []).map((cell) => headKey(cell));
  const at = (key: string): number => headers.indexOf(key);
  const col = { email: at('useremail'), name: at('name'), first: at('firstname'), last: at('lastname'), type: at('usertype'), status: at('userstatus'), profile: at('profilename'), role: at('rolename'), zuid: at('zuid') };
  if (col.email < 0) throw new Error(`${file} has no USER_EMAIL column`);
  const cell = (record: string[], index: number): string => (index < 0 ? '' : (record[index] ?? '').trim());
  return parsed.slice(1).map((record) => ({
    identity: cell(record, col.email),
    name: cell(record, col.name),
    first: cell(record, col.first),
    last: cell(record, col.last),
    type: cell(record, col.type),
    status: cell(record, col.status),
    profile: cell(record, col.profile),
    hierarchy: cell(record, col.role),
    zuid: cell(record, col.zuid),
    source: file === 'appAdmins.csv' ? ('appAdmins' as const) : ('appUsers' as const),
  }));
}

/** Both user lists from a backup (zip or extracted dir), identities runtime-only. */
export function readBackupUsers(source: string): BackupUser[] {
  const lists = readBackupUserLists(source);
  const out: BackupUser[] = [];
  if (lists.admins) out.push(...userSheet('appAdmins.csv', lists.admins));
  if (lists.users) out.push(...userSheet('appUsers.csv', lists.users));
  return out;
}

/**
 * The stable per-user id every output uses in place of an identity:
 * usr_<first 16 hex of sha256(`${salt}\n${identity}`)>. The salt is a random
 * 256-bit secret kept in the local state file only — it makes the id
 * unguessable, and a plan that leaked it (or even a fingerprint of it) would
 * let anyone rebuild the ids offline.
 */
export function userRefId(identity: string, salt: string): string {
  return `usr_${createHash('sha256').update(`${salt}\n${identity.trim().toLowerCase()}`, 'utf8').digest('hex').slice(0, 16)}`;
}

/** A fresh 256-bit salt — 64 lowercase hex chars. Local state only, never output. */
export function newUsersSalt(): string {
  return randomBytes(32).toString('hex');
}

export interface RoleMapRow {
  /** PROFILE_NAME exactly as the backup writes it. */
  profile: string;
  /** The Catalyst role the user is invited with. */
  catalystRole: string;
  /** Built-in role the Catalyst role clones, or 'builtin' when the target is one. */
  clone: PlannedRole['clone_role'] | 'builtin';
  portal: boolean;
  /** Why a profile did not keep its name (missing from the export -> App User). */
  note?: string;
}

export interface PlanUser {
  id: string;
  role: string;
  via: 'appUsers' | 'appAdmins';
  /** Hierarchy role the backup recorded for the user (empty for admins). */
  hierarchy: string;
  /**
   * 'manual' marks a non-Google '+' address: Catalyst cannot invite it and
   * folding it onto the plain mailbox could merge two different people, so
   * inviting it is the admin's console step, never this run's.
   */
  state: 'pending' | 'invited' | 'manual';
  /**
   * Set when the backup identity normalises to a different invited address
   * (the schema identity rules: dropped Gmail '+tag', folded Gmail dots). The
   * rules that fired; the alias address itself is never written.
   */
  aliasRules?: string[];
}

export interface SocialPlan {
  providers: string[];
  /** Social sign-in is a console-only configuration for this project. */
  via: 'console';
  steps: string[];
}

export interface UsersPlan {
  version: 1;
  app: string;
  roleMap: RoleMapRow[];
  users: PlanUser[];
  counts: {
    total: number;
    pending: number;
    invited: number;
    inactive: number;
    duplicates: number;
    /** Rows with no identity value at all — uninvitable, counted not listed. */
    noIdentity: number;
    /** Users whose invited address is a normalised form of the backup identity. */
    aliases: number;
    /** Users with a non-Google '+' address — uninvitable, listed for the admin. */
    manual: number;
    perRole: Record<string, number>;
  };
  /** Profiles seen in the backup that the export does not model -> mapped to App User. */
  unmapped: string[];
  social: SocialPlan;
  notes: string[];
}

/** Social sign-in providers Catalyst documents for a project. Everything is enabled in the console. */
export const SOCIAL_PROVIDERS = ['zoho', 'google', 'facebook', 'linkedin', 'twitter', 'github', 'microsoft', 'apple', 'yahoo'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export function parseSocialList(value: string | undefined): SocialProvider[] {
  if (value === undefined) return [];
  const out: SocialProvider[] = [];
  for (const raw of value.split(',')) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if (!(SOCIAL_PROVIDERS as readonly string[]).includes(name)) {
      throw new Error(`--social: ${name} is not a known provider (${SOCIAL_PROVIDERS.join(', ')})`);
    }
    if (!out.includes(name as SocialProvider)) out.push(name as SocialProvider);
  }
  return out;
}

function socialPlan(providers: readonly SocialProvider[]): SocialPlan {
  const steps: string[] = [];
  for (const provider of providers) {
    if (provider === 'zoho') {
      steps.push('Zoho sign-in is the hosted login itself — once hosted login is enabled, users with a Zoho account sign in with it; nothing else to configure.');
      continue;
    }
    steps.push(
      `console: Authentication > Sign-in Method > Social Login — enable ${provider}; the provider's OAuth client id/secret are entered there (the auth-configuration API is not writable by the deploy token, and provider credentials are operator input).`,
    );
  }
  return { providers: [...providers], via: 'console', steps };
}

export function usersPlan(app: App, users: readonly BackupUser[], opts: { salt: string; invited?: ReadonlySet<string>; social?: readonly SocialProvider[] }): UsersPlan {
  const plan = authPlan(app);
  const invited = opts.invited ?? new Set<string>();
  const social = opts.social ?? [];

  /**
   * A backup PROFILE_NAME finds its Catalyst role by the Creator profile name
   * — which is role.profile for a renamed role (one that spelled a built-in),
   * role.role_name otherwise. Two profiles folding to the same key are
   * ambiguous: the name maps to App User (least privilege), never a guess.
   */
  const fold = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const profileName = (role: PlannedRole): string => role.profile ?? role.role_name;
  const plannedByName = new Map(plan.roles.map((role) => [profileName(role), role]));
  const plannedByFold = new Map<string, PlannedRole | 'ambiguous'>();
  for (const role of plan.roles) {
    const key = fold(profileName(role));
    if (plannedByFold.has(key)) plannedByFold.set(key, 'ambiguous');
    else plannedByFold.set(key, role);
  }

  const seen = new Set<string>();
  const noIdentity = { n: 0 };
  const duplicates = { n: 0 };
  const inactive = { n: 0 };
  const unmapped = new Set<string>();
  const out: PlanUser[] = [];
  for (const user of users) {
    // The one identity Catalyst can hold: Gmail aliases ('+tag', dot
    // variants) fold to the mailbox the invite carries, so a source listing
    // two spellings of one mailbox produces one user and one invite — the
    // same value migrate-data writes into Added_User/Modified_User. A '+' on
    // any other domain survives as a distinct identity (it may be a different
    // person) and is marked manual below — never folded, never invited.
    const identity = canonicalUserIdentity(user.identity);
    if (!identity) {
      noIdentity.n += 1;
      continue;
    }
    if (seen.has(identity)) {
      duplicates.n += 1;
      continue;
    }
    seen.add(identity);
    const aliasRules = userIdentityAliasRules(user.identity);
    if (user.source === 'appUsers' && user.status && user.status.toLowerCase() !== 'active') {
      inactive.n += 1;
      continue;
    }
    let role = 'App Administrator';
    if (user.source === 'appUsers') {
      const hit = user.profile ? (plannedByName.get(user.profile) ?? plannedByFold.get(fold(user.profile))) : undefined;
      const target = hit === 'ambiguous' ? undefined : hit;
      if (target) role = target.role_name;
      else {
        // Least privilege: an unmodelled profile falls to App User, listed in
        // roleMap/unmapped — the grant is never widened silently.
        role = 'App User';
        unmapped.add(user.profile || '(no profile)');
      }
    }
    out.push({
      id: userRefId(identity, opts.salt),
      role,
      via: user.source,
      hierarchy: user.hierarchy,
      // A '+' survives canonicalisation only on a non-Google domain (Google
      // folds it away): uninvitable and unmergeable — listed for the admin.
      state: identity.includes('+') ? 'manual' : invited.has(userRefId(identity, opts.salt)) ? 'invited' : 'pending',
      ...(aliasRules.length ? { aliasRules } : {}),
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Fidelity: a permission that maps to nothing in the export is reported on
  // the role row and in notes — it is never widened into a broader grant.
  const knownComponents = new Set<string>([
    ...app.forms.map((form) => form.name),
    ...app.pages.map((page) => page.name),
    ...app.reports.map((report) => report.name),
  ]);
  const fidelity = new Map<string, string[]>();
  const note = (profile: string, text: string): void => {
    const list = fidelity.get(profile) ?? [];
    list.push(text);
    fidelity.set(profile, list);
  };
  for (const profile of app.profiles) {
    for (const mod of profile.modules) {
      const enabled = mod.properties.find((property) => property.key.toLowerCase() === 'enabled')?.value ?? '';
      if (/^"?false"?$/i.test(enabled.trim())) continue;
      if (!knownComponents.has(mod.component)) {
        note(profile.name, `${mod.component} is not a form, page or report in the export — its grant is not carried`);
      }
    }
    if (profile.permissions?.trim()) {
      note(profile.name, `Creator permission flags ${profile.permissions.trim()} have no Catalyst role equivalent — reported, not granted`);
    }
  }

  const roleMap: RoleMapRow[] = plan.roles
    .filter((role) => role.source === 'profile')
    .map((role) => {
      const profile = profileName(role);
      const notes = [...(fidelity.get(profile) ?? [])];
      if (role.profile) {
        notes.unshift(`profile name spells a built-in Catalyst role — the user is invited onto the distinct custom role '${role.role_name}' instead, which carries exactly this profile's grants`);
      }
      return {
        profile,
        catalystRole: role.role_name,
        clone: role.clone_role,
        portal: role.portal,
        ...(notes.length ? { note: notes.join('; ') } : {}),
      };
    });
  for (const role of plan.roles) {
    if (role.source !== 'hierarchy') continue;
    roleMap.push({
      profile: role.role_name,
      catalystRole: role.role_name,
      clone: role.clone_role,
      portal: false,
      note: 'data-hierarchy role — kept so the access policy matches the export; invites are never assigned it',
    });
  }
  for (const name of [...unmapped].sort()) {
    roleMap.push({ profile: name, catalystRole: 'App User', clone: 'builtin', portal: false, note: 'profile not in the export — invited with least privilege' });
  }
  roleMap.push({ profile: '(appAdmins.csv)', catalystRole: 'App Administrator', clone: 'builtin', portal: false });
  roleMap.sort((a, b) => (a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0));

  const perRole: Record<string, number> = {};
  for (const user of out) perRole[user.role] = (perRole[user.role] ?? 0) + 1;
  const sortedPerRole: Record<string, number> = {};
  for (const role of Object.keys(perRole).sort()) sortedPerRole[role] = perRole[role]!;

  const notes: string[] = [
    'Identities are read from the backup at run time only. Every output names a user by id (usr_<hash>); addresses, names and account ids are never written to plans, reports, state or logs.',
    'A Catalyst role is the same name as the Creator profile it clones — except a profile name that spells a built-in Catalyst role under case/space/punctuation folding, which becomes "Creator <profile>" so nobody is invited onto a built-in role by a profile name. The generated app checks access by the profile name, so an invited user keeps exactly the permission set they had.',
    'Creator appAdmins.csv rows map to the built-in App Administrator role.',
    'The ROLE_NAME hierarchy value is reported for review only — Catalyst roles are flat, and data visibility is enforced by the generated access policy, not by a per-user parent.',
    'POST /project-user (the console Add User call) carries redirect_url = the Slate app URL; an invite is never sent without it because the mailed link would land on a page that does not exist.',
    ...(social.length ? [] : ['Social sign-in is not enabled by this plan; pass --social <providers> to list the console steps (it cannot be enabled by API with this token).']),
  ];
  const aliased = out.filter((user) => user.aliasRules?.length);
  if (aliased.length) {
    notes.push(
      `${aliased.length} user(s) sign in under a normalised address: gmail.com/googlemail.com '+tag' and dot variants fold to the one Google mailbox (Google's documented rule). migrate-data writes the same normalised identity into Added_User/Modified_User and remaps Users-field cells to the invited Catalyst user id.`,
    );
  }
  const manual = out.filter((user) => user.state === 'manual');
  if (manual.length) {
    notes.push(
      `${manual.length} user(s) carry a '+' address on a non-Google domain: Catalyst Add User rejects '+' outright (INVALID_INPUT) and whether the provider delivers it to the plain mailbox is [UNVERIFIED] — folding it could merge two different people, so they are NOT invited and their data keeps the '+' identity. Manual step: add the real mailbox in Authentication > Users (the console Add User form), then record this plan's usr_ id against the Catalyst user_id in the users state file so migrate-data remaps their rows — a row never remaps by guessing.`,
    );
  }
  if (inactive.n) notes.push(`${inactive.n} user(s) with a non-Active status are skipped — only Active users are invited.`);
  if (duplicates.n) notes.push(`${duplicates.n} repeated identit${duplicates.n === 1 ? 'y' : 'ies'} collapsed — a user appearing in both lists is invited once.`);
  if (noIdentity.n) notes.push(`${noIdentity.n} row(s) had no identity value and cannot be invited.`);
  if (unmapped.size) notes.push(`${unmapped.size} profile(s) in the backup have no role in the export and map to App User (least privilege) — see unmapped[].`);
  for (const profile of [...fidelity.keys()].sort()) {
    for (const text of fidelity.get(profile)!) notes.push(`fidelity: ${profile}: ${text}`);
  }

  return {
    version: 1,
    app: app.name ?? '',
    roleMap,
    users: out,
    counts: {
      total: users.length,
      pending: out.filter((user) => user.state === 'pending').length,
      invited: out.filter((user) => user.state === 'invited').length,
      inactive: inactive.n,
      duplicates: duplicates.n,
      noIdentity: noIdentity.n,
      aliases: out.filter((user) => user.aliasRules?.length).length,
      manual: out.filter((user) => user.state === 'manual').length,
      perRole: sortedPerRole,
    },
    unmapped: [...unmapped].sort(),
    social: socialPlan(social),
    notes,
  };
}

export function usersPlanJson(plan: UsersPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function usersPlanMarkdown(plan: UsersPlan): string {
  const lines = [
    '# Users plan (dry run)',
    '',
    'Nothing in this plan is applied and no identity is written — users are ids only.',
    '',
    `- app: ${plan.app || '(unnamed)'}`,
    `- users: ${plan.counts.total} seen, ${plan.counts.pending} to invite, ${plan.counts.invited} already invited`,
    `- skipped: ${plan.counts.inactive} non-active, ${plan.counts.duplicates} repeated, ${plan.counts.noIdentity} no identity`,
    `- aliases normalised: ${plan.counts.aliases}`,
    `- manual '+' addresses (non-Google, not invited): ${plan.counts.manual}`,
    '',
    '## Role mapping',
    '',
    '| Creator profile | Catalyst role | clone of | portal |',
    '| --- | --- | --- | --- |',
    ...plan.roleMap.map((row) => `| ${row.profile} | ${row.catalystRole} | ${row.clone} | ${row.portal ? 'yes' : ''}${row.note ? ` — ${row.note}` : ''} |`),
    '',
    '## Invites per role',
    '',
    ...(Object.keys(plan.counts.perRole).length
      ? Object.entries(plan.counts.perRole).map(([role, n]) => `- ${role}: ${n}`)
      : ['- none']),
    '',
    '## Social sign-in',
    '',
    ...(plan.social.providers.length
      ? plan.social.steps.map((step) => `- ${step}`)
      : ['- not requested (--social <zoho,google,...> lists the console steps)']),
    '',
    '## Users',
    '',
    ...plan.users.map(
      (user) =>
        `- ${user.id} -> ${user.role} (${user.via}${user.hierarchy ? `, reports under ${user.hierarchy}` : ''}) — ${user.state}${user.aliasRules?.length ? ` — alias folded: ${user.aliasRules.join(', ')}` : ''}`,
    ),
    '',
    '## Notes',
    '',
    ...plan.notes.map((note) => `- ${note}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/** users/invites.csv — id,role,via,state per user; reviewable, identity-free. */
export function usersInvitesCsv(plan: UsersPlan): string {
  const rows = plan.users.map((user) => `${user.id},${user.role},${user.via},${user.state}`);
  return `id,role,via,state\n${rows.join('\n')}\n`;
}

/**
 * Invite state: which user ids already landed on this project, plus the
 * random salt the ids were hashed with and the project they were sent to —
 * both bound at write time so a run can never quietly reuse ids or skip
 * invites recorded against another project. Never an identity; the salt stays
 * in this file and nowhere else.
 */
export interface UsersState {
  version: 1;
  /** The Catalyst project the invites went to — '' until the first invite run binds it. */
  project: string;
  /** The 256-bit salt for userRefId — the only place it exists. Absent in pre-v1 state files. */
  salt?: string;
  invited: { id: string; role: string; userId?: string }[];
}

export function readUsersState(path: string): UsersState | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const record = parsed as Partial<UsersState>;
  if (!record || record.version !== 1 || !Array.isArray(record.invited)) {
    throw new Error(`${path} is not a users state file`);
  }
  return record as UsersState;
}

/** Atomic write (tmp + rename) — a kill mid-invite leaves the last consistent state. */
export function writeUsersState(path: string, state: UsersState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const invited = [...state.invited].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Explicit fields only — a legacy saltHash carried by an old file is dropped
  // rather than re-published.
  writeFileSync(tmp, `${JSON.stringify({ version: 1, project: state.project, ...(state.salt ? { salt: state.salt } : {}), invited }, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Why a '+' address is refused before any request (live Add User reply). */
export const PLUS_EMAIL_REASON =
  "Catalyst Add User rejects a '+' in the email (Email Id cannot contain '+' character, INVALID_INPUT) — the user was not invited; the admin chooses the real mailbox in the console (never a guessed plain address)";

/**
 * The guided fallback when no role id is known: GET /role is refused for the
 * CLI token (401 OAUTH_SCOPE_MISMATCH), so the id comes from the MCP
 * List_All_Roles tool (role_id is a string there — copy it as is) or the console.
 */
export function roleIdFallback(role: string): string {
  return `Authentication > Roles: role ${role} has no id in this project (GET /role is refused for this token: 401 OAUTH_SCOPE_MISMATCH) — read role_id with the MCP CatalystbyZoho_List_All_Roles tool (a string; copy it digit for digit) or in the console, then pass --role-ids '${role}=<id>', or add the user via the Add User form`;
}

/** Ids of the users whose sign-in identity carries a '+' — sorted, never the identity itself. */
export function plusAddressIds(users: readonly { id: string; identity: string }[]): string[] {
  return [...new Set(users.filter((user) => user.identity.includes('+')).map((user) => user.id))].sort();
}

export interface InviteRow {
  id: string;
  role: string;
  status: 'invited' | 'verified' | 'skipped' | 'pending' | 'failed';
  detail?: string;
  console?: string;
}

export interface UsersInviteResult {
  rows: InviteRow[];
  invited: UsersState['invited'];
  consoleSteps: string[];
  ok: boolean;
}

/** A project-user row's sign-in identity under any recorded field spelling. */
function rowIdentity(user: Record<string, unknown>): string | undefined {
  for (const key of ['email_id', 'email', 'emailId', 'user_email', 'login_id']) {
    const value = user[key];
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  }
  return undefined;
}

export interface InviteTarget {
  id: string;
  role: string;
  /** Runtime-only identity and names — sent in the request, never stored or printed. */
  identity: string;
  first: string;
  last: string;
}

/**
 * Drive pending invites through REST. The driver is io.rest in production and
 * a fake in tests — each call is POST /project-user, the console Add User
 * endpoint (it works with public signup off). Results name users by id only;
 * server messages are sanitised before they reach a detail or console line.
 */
export async function inviteUsers(
  rest: RestFn,
  input: {
    projectId: string;
    targets: readonly InviteTarget[];
    /** Ids an earlier run recorded as invited — skipped without a call and kept in the result's invited list. */
    prior: readonly { id: string; role: string; userId?: string }[];
    /** Role name -> Catalyst role id (--role-ids); GET /role is refused, so ids also come from project users' role_details. */
    roleIds: Readonly<Record<string, string>>;
    /** https://<slate-domain>; an invite is never sent without it. */
    redirectUrl?: string;
    persist?: (invited: UsersState['invited']) => void;
    /** Retry tuning for the invite POSTs — tests pass an instant clock. */
    retry?: RetryOptions;
  },
): Promise<UsersInviteResult> {
  const base = `/baas/v1/project/${input.projectId}`;
  const rows: InviteRow[] = [];
  const consoleSteps: string[] = [];
  const invited = new Map<string, { id: string; role: string; userId?: string }>();
  for (const entry of input.prior) invited.set(entry.id, { ...entry });
  const priorIds = new Set(input.prior.map((entry) => entry.id));
  let ok = true;

  const push = (row: InviteRow): void => {
    rows.push(row);
    if (row.console) consoleSteps.push(row.console);
    // 'pending' means the user was not invited (missing role id or redirect,
    // or a refused call) — the run is incomplete, not a success.
    if (row.status === 'failed' || row.status === 'pending') ok = false;
  };

  // Only reads flow through here (the user list); a transient 429/5xx retries.
  const call = async (spec: RestCall, secrets: readonly string[] = []): Promise<{ status: number; body: unknown } | { transport: string }> => {
    try {
      return (await restWithRetry(rest, spec, input.retry ?? {})).result;
    } catch (err) {
      return { transport: sanitizeMessage(err instanceof Error ? err.message : 'request failed', secrets) };
    }
  };

  const listRes = await call({ method: 'GET', path: `${base}/project-user` });
  const current = !('transport' in listRes) && listRes.status >= 200 && listRes.status < 300 ? (projectUsers(listRes.body) ?? []) : [];
  const present = new Map<string, Record<string, unknown>>();
  for (const user of current) {
    const identity = rowIdentity(user);
    if (identity) present.set(identity, user);
  }

  for (const target of input.targets) {
    const identity = target.identity.trim().toLowerCase();
    const record = (row: InviteRow, userId?: string): void => {
      push(row);
      if (row.status === 'invited' || row.status === 'verified') {
        invited.set(target.id, { id: target.id, role: target.role, ...(userId ? { userId } : {}) });
        input.persist?.([...invited.values()]);
      }
    };
    if (priorIds.has(target.id)) {
      record({ id: target.id, role: target.role, status: 'skipped', detail: 'recorded invited by an earlier run' });
      continue;
    }
    const listed = present.get(identity);
    if (listed) {
      const uid = listed.user_id ?? listed.userId;
      record(
        { id: target.id, role: target.role, status: 'verified', detail: 'already a project user (GET /project-user)' },
        idString(uid),
      );
      continue;
    }
    if (target.identity.includes('+')) {
      record({ id: target.id, role: target.role, status: 'failed', detail: `not sent — ${PLUS_EMAIL_REASON}` });
      continue;
    }
    const roleId = input.roleIds[target.role] ?? roleIdFromUsers(current, target.role);
    const spec: RestCall = {
      method: 'POST',
      path: `${base}/project-user`,
      body: {
        user_details: { first_name: adminFirstName(target.identity, target.first), last_name: target.last, email_id: target.identity, role_id: roleId ?? '' },
        platform_type: 'web',
        ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
      },
    };
    if (!roleId) {
      record({
        id: target.id,
        role: target.role,
        status: 'pending',
        console: roleIdFallback(target.role),
      });
      continue;
    }
    if (!input.redirectUrl) {
      record({
        id: target.id,
        role: target.role,
        status: 'pending',
        console: `the invite for ${target.id} needs redirect_url = the Slate app URL — pass --slate-domain <host> (the App Url slate:link prints), then re-run`,
      });
      continue;
    }
    // The values the request carried — a server error may echo any of them
    // back, so they are redacted from whatever detail reaches output.
    const secrets = [target.identity, target.first, target.last].filter((value) => value.trim() !== '');
    const post = async (): Promise<{ res: { status: number; body: unknown }; applied?: string } | { transport: string }> => {
      try {
        const outcome = await restWithRetry(rest, spec, {
          ...input.retry,
          // An invite POST is not idempotent: before re-sending, re-read the
          // user list — a request that failed with 5xx may still have landed.
          reRead: async () => {
            const again = await call({ method: 'GET', path: `${base}/project-user` }, secrets);
            if ('transport' in again || again.status < 200 || again.status >= 300) return undefined;
            const found = (projectUsers(again.body) ?? []).find((row) => rowIdentity(row) === identity);
            if (!found) return { resend: spec };
            const uid = found.user_id ?? found.userId;
            return { applied: idString(uid) ?? '' };
          },
        });
        if (outcome.applied !== undefined) return { res: outcome.result, applied: outcome.applied };
        return { res: outcome.result };
      } catch (err) {
        return { transport: sanitizeMessage(err instanceof Error ? err.message : 'request failed', secrets) };
      }
    };
    const res = await post();
    if ('transport' in res) {
      record({
        id: target.id,
        role: target.role,
        status: 'failed',
        detail: `transport error — ${res.transport}`,
        console: `Authentication > Users: invite ${target.id} (role ${target.role}) via the Add User form — the API call did not answer; re-run to finish`,
      });
      continue;
    }
    if (res.applied !== undefined) {
      record(
        {
          id: target.id,
          role: target.role,
          status: 'invited',
          detail: `the invite landed despite an HTTP ${res.res.status} reply — confirmed by re-reading project users, not re-sent`,
        },
        res.applied || undefined,
      );
      continue;
    }
    if (res.res.status >= 200 && res.res.status < 300) {
      const body = (res.res.body ?? {}) as Record<string, unknown>;
      const data = (body.data ?? {}) as Record<string, unknown>;
      const uid = body.user_id ?? data.user_id;
      record(
        { id: target.id, role: target.role, status: 'invited', detail: `200 — invite sent${idString(uid) ? ` (user_id recorded)` : ''}` },
        idString(uid),
      );
      continue;
    }
    if (alreadyDone(res.res.status, res.res.body)) {
      record({ id: target.id, role: target.role, status: 'verified', detail: `already invited (HTTP ${res.res.status} says the user exists)` });
      continue;
    }
    const code = errorCode(res.res.body);
    const failure = failureInfo(res.res.body, secrets);
    // A 400 MISSING_PARAM means the request lacked a field the endpoint
    // requires (first_name is mandatory live). Name it per user: the row
    // fails, the run continues for the other users, and the report counts it.
    if (res.res.status === 400 && failure.code === 'MISSING_PARAM') {
      record({
        id: target.id,
        role: target.role,
        status: 'failed',
        detail: `HTTP 400 MISSING_PARAM — a required field was missing${failure.message ? ` — ${failure.message}` : ''}`,
        console: `Authentication > Users: invite ${target.id} (role ${target.role}) via the Add User form — the API invite was rejected: first_name is mandatory`,
      });
      continue;
    }
    record({
      id: target.id,
      role: target.role,
      status: code ? 'pending' : 'failed',
      ...(failure.code ? { detail: `HTTP ${res.res.status} ${failure.code}${failure.message ? ` — ${failure.message}` : ''}` } : { detail: `HTTP ${res.res.status}` }),
      console:
        code === 'PUBLIC_SIGNUP_ERROR'
          ? `Authentication > Users: invite ${target.id} (role ${target.role}) via the Add User form — the admin invite endpoint was refused (PUBLIC_SIGNUP_ERROR)`
          : `Authentication > Users: invite ${target.id} (role ${target.role}) via the Add User form (Platform = Web, Component = Slate + Slate app + Deployment = default) — the API invite was refused or rejected`,
    });
  }

  return { rows, invited: [...invited.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), consoleSteps, ok };
}

/** One-line-per-user invite outcome — ids and roles only. */
export function formatInviteResult(result: UsersInviteResult): string {
  const lines = ['users invite:'];
  for (const row of result.rows) {
    lines.push(`- ${row.id} (${row.role}): ${row.status}${row.detail ? ` — ${row.detail}` : ''}`);
  }
  if (result.consoleSteps.length) {
    lines.push('console steps:');
    for (const step of result.consoleSteps) lines.push(`- ${step}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Post-go-live user management over the same admin hook as invite
 * (GET/POST/PUT/DELETE /project-user): `c2c users list|add|disable|enable|set-role`.
 * `list` and every report name a user by its Catalyst user_id only — the
 * sign-in address stays inside the request, never printed or stored.
 *
 * The update calls are [UNVERIFIED] for the CLI token (the recorded runs
 * covered GET/POST/DELETE): a write is accepted on a 2xx and then confirmed
 * by re-reading the user; a refusal or an unchanged read-back becomes a
 * console step, never a silent claim.
 */
export interface ListedUser {
  userId: string;
  role: string;
  status: string;
  confirmed?: boolean;
}

function rowText(user: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = user[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** One project-user row as printable facts — id, role, status; never the address. */
export function summarizeProjectUser(user: Record<string, unknown>): ListedUser | undefined {
  const details = (user.role_details ?? user.roleDetails ?? {}) as Record<string, unknown>;
  const role = rowText(details, ['role_name', 'roleName', 'name']) ?? rowText(user, ['role_name', 'roleName']) ?? '';
  const status = rowText(user, ['status', 'user_status', 'userStatus']) ?? '';
  const confirmedRaw = user.is_confirmed ?? user.isConfirmed ?? user.confirmed;
  const confirmed = confirmedRaw === true || confirmedRaw === 'true' ? true : confirmedRaw === false || confirmedRaw === 'false' ? false : undefined;
  const userId = idString(user.user_id ?? user.userId ?? user.id);
  if (!userId) return undefined;
  return { userId, role, status, ...(confirmed !== undefined ? { confirmed } : {}) };
}

export interface UsersListResult {
  users: ListedUser[];
  ok: boolean;
  detail?: string;
}

/** GET /project-user → id/role/status per user. */
export async function listProjectUsers(rest: RestFn, projectId: string, retry?: RetryOptions): Promise<UsersListResult> {
  try {
    const res = await restWithRetry(rest, { method: 'GET', path: `/baas/v1/project/${projectId}/project-user` }, retry ?? {});
    if (res.result.status < 200 || res.result.status >= 300) {
      const code = errorCode(res.result.body);
      return { users: [], ok: false, detail: `HTTP ${res.result.status}${code ? ` ${code}` : ''}` };
    }
    const users = (projectUsers(res.result.body) ?? []).map(summarizeProjectUser).filter((user): user is ListedUser => user !== undefined);
    users.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    return { users, ok: true };
  } catch (err) {
    return { users: [], ok: false, detail: `transport error — ${sanitizeMessage(err instanceof Error ? err.message : 'request failed', [])}` };
  }
}

export function formatUserList(result: UsersListResult): string {
  const lines = ['users list:'];
  for (const user of result.users) {
    lines.push(`- ${user.userId} role=${user.role || '(none)'} status=${user.status || '(unknown)'}${user.confirmed === undefined ? '' : ` confirmed=${user.confirmed}`}`);
  }
  if (!result.users.length && result.ok) lines.push('- (no project users)');
  if (result.detail) lines.push(`- ${result.detail}`);
  return `${lines.join('\n')}\n`;
}

export type ManageUserAction = 'disable' | 'enable' | 'set-role';

export interface ManageUserResult {
  userId: string;
  action: ManageUserAction;
  status: 'applied' | 'verified' | 'pending' | 'failed';
  detail?: string;
  console?: string;
}

function projectUserFromBody(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ['data', 'user', 'project_user']) {
    const inner = record[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
  }
  return record;
}

/**
 * PUT /project-user/<id> for disable/enable (`{status}`) and set-role
 * (`{role_details:{role_id}}`) — [UNVERIFIED] shapes for the CLI token, so the
 * result is proven by re-reading the user afterwards, not by the reply alone.
 */
export async function manageProjectUser(
  rest: RestFn,
  input: {
    projectId: string;
    userId: string;
    action: ManageUserAction;
    /** Catalyst role id for set-role (resolved by the caller from --role-ids or role_details). */
    roleId?: string;
    /** Role name for messages. */
    role?: string;
    retry?: RetryOptions;
  },
): Promise<ManageUserResult> {
  const base = `/baas/v1/project/${input.projectId}`;
  const label = input.action === 'set-role' ? `set role ${input.role ?? input.roleId}` : input.action;
  const consoleStep = `Authentication > Users: ${label} for user ${input.userId} in the console — the API update was refused or did not hold`;
  const body =
    input.action === 'set-role'
      ? { role_details: { role_id: input.roleId } }
      : { status: input.action === 'disable' ? 'disable' : 'enable' };

  const call = async (spec: RestCall): Promise<{ status: number; body: unknown } | { transport: string }> => {
    try {
      return (await restWithRetry(rest, spec, input.retry ?? {})).result;
    } catch (err) {
      return { transport: err instanceof Error ? err.message : 'request failed' };
    }
  };

  const put = await call({ method: 'PUT', path: `${base}/project-user/${input.userId}`, body });
  if ('transport' in put) return { userId: input.userId, action: input.action, status: 'failed', detail: `transport error — ${put.transport}`, console: consoleStep };
  if (put.status === 404) return { userId: input.userId, action: input.action, status: 'failed', detail: 'HTTP 404 — no project user with that id' };
  if (put.status < 200 || put.status >= 300) {
    const code = errorCode(put.body);
    return {
      userId: input.userId,
      action: input.action,
      status: 'pending',
      detail: `HTTP ${put.status}${code ? ` ${code}` : ''}`,
      console: consoleStep,
    };
  }

  // Read-back: the write is verified only when the stored row shows it.
  const get = await call({ method: 'GET', path: `${base}/project-user/${input.userId}` });
  if (!('transport' in get) && get.status >= 200 && get.status < 300) {
    const row = projectUserFromBody(get.body);
    if (row) {
      if (input.action === 'set-role') {
        const details = (row.role_details ?? row.roleDetails ?? {}) as Record<string, unknown>;
        const storedId = idString(details.role_id ?? details.roleId ?? details.id);
        if (storedId && storedId === input.roleId) {
          return { userId: input.userId, action: input.action, status: 'verified', detail: 'role id confirmed by GET /project-user/<id>' };
        }
        const storedName = rowText(details, ['role_name', 'roleName', 'name']);
        if (storedName && input.role && storedName === input.role) {
          return { userId: input.userId, action: input.action, status: 'verified', detail: `role ${storedName} confirmed by GET /project-user/<id>` };
        }
        return { userId: input.userId, action: input.action, status: 'pending', detail: 'the update returned 2xx but the stored role did not change', console: consoleStep };
      }
      const status = (rowText(row, ['status', 'user_status', 'userStatus']) ?? '').toLowerCase();
      const want = input.action === 'disable' ? 'disabl' : 'enabl';
      const activeWords = input.action === 'disable' ? [] : ['active', 'enabled'];
      if (status.includes(want) || activeWords.includes(status)) {
        return { userId: input.userId, action: input.action, status: 'verified', detail: `status ${status || 'updated'} confirmed by GET /project-user/<id>` };
      }
      if (!status) return { userId: input.userId, action: input.action, status: 'applied', detail: 'the update returned 2xx; the read-back row carries no status field to confirm against' };
      return { userId: input.userId, action: input.action, status: 'pending', detail: `the update returned 2xx but the stored status reads ${status}`, console: consoleStep };
    }
  }
  return { userId: input.userId, action: input.action, status: 'applied', detail: 'the update returned 2xx; the read-back was unavailable to confirm it' };
}

export function formatManageResult(result: ManageUserResult): string {
  const lines = [`users ${result.action}: ${result.userId} — ${result.status}${result.detail ? ` — ${result.detail}` : ''}`];
  if (result.console) lines.push(`console step: ${result.console}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Creator ZUID → invited Catalyst user_id, from the backup's user lists and
 * the users state file: a ZUID maps when the user's canonical identity was
 * invited and the state recorded the Catalyst id. Never written to disk —
 * migrate-data holds it in memory for the run.
 */
export function backupUserIdMap(source: string, state: UsersState | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!state?.salt || !state.invited.length) return out;
  const userIdByRef = new Map(state.invited.filter((entry) => entry.userId).map((entry) => [entry.id, entry.userId!]));
  if (!userIdByRef.size) return out;
  for (const user of readBackupUsers(source)) {
    if (!user.zuid) continue;
    const ref = userRefId(canonicalUserIdentity(user.identity), state.salt);
    const userId = userIdByRef.get(ref);
    if (userId) out.set(user.zuid, userId);
  }
  return out;
}
