/**
 * Dry-run Catalyst Authentication plan.
 *
 * Nothing here calls Catalyst. Role creation needs a clone of an existing role
 * (POST /role is rejected without clone_role). Table
 * permissions are planned per profile-role. Creator record filters stay on the
 * access policy the shim already enforces; they are not Catalyst User scope.
 */

import type { App, ModulePermission, Role } from '../../core/src/ir.js';
import { accessPolicyFor, profilePreset, type ProfilePreset } from '../../deluge/src/generate.js';
import type { AccessPolicy } from '../../shims/src/access.js';

export type Crud = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

/** Catalyst's built-in project roles — the only two the platform creates. */
export const BUILTIN_ROLES: ReadonlySet<string> = new Set(['App User', 'App Administrator']);

/** Role-name fold: case, whitespace and punctuation are not significant. */
export function foldRoleName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * True when a name spells a Catalyst built-in role under the fold
 * ('app  administrator', 'APP-USER', ...). A Creator profile whose name does
 * this must never become a role of that name: inviting onto it would hand the
 * user the built-in's grants instead of the profile's.
 */
export function foldsToBuiltinRole(name: string): boolean {
  const folded = foldRoleName(name);
  for (const builtin of BUILTIN_ROLES) if (foldRoleName(builtin) === folded) return true;
  return false;
}

export interface PlannedRole {
  role_name: string;
  description?: string;
  /** Role name to clone. Apply-time resolves this to the project role id. */
  clone_role: 'App User' | 'App Administrator';
  source: 'profile' | 'hierarchy';
  /**
   * The Creator profile the role carries — set only when role_name is not the
   * profile name, i.e. the profile spelled a built-in role and was renamed to
   * a distinct custom role ('Creator <name>').
   */
  profile?: string;
  parent?: string;
  portal: boolean;
}

export interface TablePermission {
  table: string;
  role: string;
  permissions: Crud[];
  scope: 'ORG' | 'GLOBAL';
}

export interface PortalUserPlan {
  profile: string;
  catalystRole: string;
  /** Dry run does not invite anyone. */
  action: 'app-user';
}

export interface AuthPlan {
  dryRun: true;
  applied: false;
  authentication: {
    hosted_auth: true;
    embedded_auth: true;
    public_signup: false;
    third_party_auth: false;
  };
  roles: PlannedRole[];
  portalUsers: PortalUserPlan[];
  tablePermissions: TablePermission[];
  /** Modules that are not forms. Not Data Store permissions. */
  pageAccess: { page: string; role: string }[];
  accessPolicy: AccessPolicy;
  notes: string[];
}

const CRUD: { verbs: string[]; crud: Crud }[] = [
  { verbs: ['view', 'viewall'], crud: 'SELECT' },
  { verbs: ['add', 'create', 'import'], crud: 'INSERT' },
  { verbs: ['edit', 'update'], crud: 'UPDATE' },
  { verbs: ['delete'], crud: 'DELETE' },
];

export function authPlan(app: App): AuthPlan {
  const formNames = new Set(app.forms.map((form) => form.name));
  const roles: PlannedRole[] = [];
  const notes: string[] = [];
  const portalUsers: PortalUserPlan[] = [];
  const tablePermissions: TablePermission[] = [];
  const pageAccess: { page: string; role: string }[] = [];
  const profileNames = new Set<string>();

  // Every name the export declares, folded — a renamed role must not fold onto
  // a sibling profile or hierarchy role either.
  const claimed = new Set<string>();
  for (const profile of app.profiles) claimed.add(foldRoleName(profile.name));
  walkRoles(app.roles, undefined, (role) => claimed.add(foldRoleName(role.name)));

  // Catalyst role-name case sensitivity is not established in the facts ledger.
  // Preserve source spelling and warn when profile/hierarchy names differ only
  // by case, so the plan never asserts undocumented platform behavior.
  const profileByLowerName = new Map<string, string>();
  for (const profile of app.profiles) profileByLowerName.set(profile.name.toLowerCase(), profile.name);
  const warnedCollisions = new Set<string>();
  walkRoles(app.roles, undefined, (role) => {
    const profile = profileByLowerName.get(role.name.toLowerCase());
    if (profile && profile !== role.name) {
      const pair = `${profile}\u0000${role.name}`;
      if (!warnedCollisions.has(pair)) {
        warnedCollisions.add(pair);
        notes.push(`Potential Catalyst role-name collision: profile \"${profile}\" and hierarchy role \"${role.name}\" differ only by case. Catalyst case sensitivity is undocumented; verify before creating both roles.`);
      }
    }
  });

  /**
   * The Catalyst role a name becomes. A name that spells a built-in role gets
   * a distinct 'Creator <name>' instead — the built-in is never emitted as a
   * custom role, so an invite can never resolve its id for a profile.
   */
  const roleNameFor = (name: string): { roleName: string; renamed: boolean } => {
    if (!foldsToBuiltinRole(name)) return { roleName: name, renamed: false };
    let candidate = `Creator ${name}`;
    while (claimed.has(foldRoleName(candidate)) || foldsToBuiltinRole(candidate)) candidate = `Creator ${candidate}`;
    return { roleName: candidate, renamed: true };
  };
  const claim = (roleName: string): void => {
    claimed.add(foldRoleName(roleName));
  };

  for (const profile of app.profiles) {
    profileNames.add(profile.name);
    const portal = isPortal(profile.type, profile.name);
    const admin = !portal && /admin/i.test(`${profile.name} ${profile.type ?? ''}`);
    const { roleName, renamed } = roleNameFor(profile.name);
    claim(roleName);
    roles.push({
      role_name: roleName,
      ...(profile.description ? { description: profile.description } : {}),
      // A renamed role clones App User: cloning the built-in it spells would
      // hand it that built-in's own grants. The profile's real grants arrive
      // through the permission rows and the access policy.
      clone_role: renamed ? 'App User' : admin ? 'App Administrator' : 'App User',
      source: 'profile',
      ...(renamed ? { profile: profile.name } : {}),
      portal,
    });
    if (portal) {
      portalUsers.push({ profile: profile.name, catalystRole: roleName, action: 'app-user' });
    }
    for (const mod of profile.modules) {
      if (flagFalse(mod, 'enabled')) continue;
      if (!formNames.has(mod.component)) {
        pageAccess.push({ page: mod.component, role: profile.name });
        continue;
      }
      const grant = crudFor(mod);
      if (!grant) continue;
      tablePermissions.push({
        table: mod.component,
        role: roleName,
        permissions: grant.permissions,
        scope: grant.viewAll ? 'GLOBAL' : 'ORG',
      });
    }
    const preset = profilePreset(profile);
    if (preset) {
      const grant = presetCrud(preset);
      for (const form of app.forms) {
        tablePermissions.push({ table: form.name, role: roleName, permissions: grant.permissions, scope: grant.scope });
      }
      for (const page of app.pages) pageAccess.push({ page: page.name, role: profile.name });
    }
  }

  walkRoles(app.roles, undefined, (role, parent) => {
    if (profileNames.has(role.name)) return;
    const { roleName } = roleNameFor(role.name);
    claim(roleName);
    roles.push({
      role_name: roleName,
      ...(role.description ? { description: role.description } : {}),
      clone_role: 'App User',
      source: 'hierarchy',
      ...(parent ? { parent } : {}),
      portal: false,
    });
  });

  notes.push(
    'Dry run. This plan does not call Catalyst and does not create roles, users, or table permissions.',
    'Every Catalyst role is cloned. Apply-time resolves clone_role "App User" or "App Administrator" to that project\'s role id. The id is not invented here.',
    'A Creator profile becomes a Catalyst role of the same name — unless the name spells a built-in Catalyst role under case/space/punctuation folding, in which case the role is "Creator <profile>"; an app user is never invited onto a built-in role by a profile name. Table permissions hang off that role. The shim access policy is keyed by the profile name, so the signed-in principal.profile must be that name.',
    'Data-hierarchy roles are emitted so the access policy allow-list matches the export. They do not get Data Store permissions unless a profile has the same name.',
    'Portal profiles become app users assigned the portal role. Nobody is invited by this plan.',
    'Creator report record filters stay on accessPolicy.recordFilter (login user bound from the principal). They are not stored as Catalyst User scope. Viewall is GLOBAL; other grants are ORG.',
    'Record sharing by owner on portal profiles and on forms listed in role Hierarchy (no View All: own rows only; no Modify All: edit and delete own rows only), hidden and read-only fields, and add-only grants are enforced by c2c_api. Catalyst table permissions carry no field or row rule, so they do not express these; the generated client reads and writes only through c2c_api. migration-report.json security lists what is not enforced.',
    'Hosted and embedded login are both planned on. Public signup stays off until the owner turns it on. No authorized domain is invented.',
    'A profile with no ModulePermissions is not an empty allow. Creator predefined sets are written out as grants: Administrator (app owner and admins) can view, add, edit, and delete every form (GLOBAL). Write can view, add, and edit every form (ORG). Read can view every form (ORG). The Customer portal default ("only add and view") can view and add every form (ORG). The shim has one write bit, so add also allows update there. Delete is a separate bit and is not implied by write: only Administrator, among these presets, has it. Any other profile with no modules, including Developer, gets no grant. App User and App Administrator are the Catalyst clone targets for these profiles, not extra profile names.',
  );

  return {
    dryRun: true,
    applied: false,
    authentication: {
      hosted_auth: true,
      embedded_auth: true,
      public_signup: false,
      third_party_auth: false,
    },
    roles,
    portalUsers,
    tablePermissions,
    pageAccess,
    accessPolicy: accessPolicyFor(app),
    notes,
  };
}

function isPortal(type: string | undefined, name: string): boolean {
  return /portal/i.test(`${type ?? ''} ${name}`);
}

function flagFalse(mod: ModulePermission, key: string): boolean {
  const value = mod.properties.find((p) => p.key.toLowerCase() === key)?.value ?? '';
  return /^"?false"?$/i.test(value.trim());
}

function presetCrud(preset: ProfilePreset): { permissions: Crud[]; scope: 'ORG' | 'GLOBAL' } {
  if (preset === 'administrator') return { permissions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], scope: 'GLOBAL' };
  if (preset === 'write') return { permissions: ['SELECT', 'INSERT', 'UPDATE'], scope: 'ORG' };
  if (preset === 'portal-add') return { permissions: ['SELECT', 'INSERT'], scope: 'ORG' };
  return { permissions: ['SELECT'], scope: 'ORG' };
}

function crudFor(mod: ModulePermission): { permissions: Crud[]; viewAll: boolean } | undefined {
  const words = new Set<string>();
  for (const report of mod.reports) {
    for (const match of report.value.matchAll(/[A-Za-z]+/g)) words.add(match[0].toLowerCase());
  }
  // Module flags: Create allows insert and View All reads, as in the access policy.
  const enabled = mod.properties.find((p) => p.key.toLowerCase() === 'enabled')?.value ?? '';
  for (const match of enabled.matchAll(/[A-Za-z]+/g)) {
    const flag = match[0].toLowerCase();
    if (flag === 'create' || flag === 'viewall') words.add(flag);
  }
  const permissions: Crud[] = [];
  for (const row of CRUD) {
    if (row.verbs.some((verb) => words.has(verb)) && !permissions.includes(row.crud)) permissions.push(row.crud);
  }
  if (!permissions.includes('SELECT')) return undefined;
  return { permissions, viewAll: words.has('viewall') };
}

function walkRoles(roles: Role[], parent: string | undefined, visit: (role: Role, parent?: string) => void): void {
  for (const role of roles) {
    visit(role, parent);
    walkRoles(role.children, role.name, visit);
  }
}
