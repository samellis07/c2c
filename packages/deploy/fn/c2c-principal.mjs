/**
 * Principal for a c2c_api request (v1 model: Catalyst Authentication).
 *
 * The caller is the signed-in app user, read with user scope:
 *   catalyst.initialize(req).userManagement().getCurrentUser()
 * https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/overview/ (User Management)
 * A project collaborator who is not an app user, or a request with no session,
 * has no current user and is refused (401).
 *
 * The user's Catalyst role picks the Creator profile that access-policy.json
 * grants, only through principal-map.json ("App Administrator" -> Administrator,
 * "App User" -> User, plus one entry per role the apply plan creates for a
 * profile). A role is never promoted by name: the map is written at deploy
 * time, and an unmapped role is refused. The Creator role is not set:
 * Catalyst roles are not Creator roles.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const map = JSON.parse(readFileSync(join(here, 'principal-map.json'), 'utf8'));
const policy = JSON.parse(readFileSync(join(here, 'access-policy.json'), 'utf8'));

export function profileForRole(roleName) {
  if (typeof roleName !== 'string' || !roleName.trim()) return null;
  const role = roleName.trim();
  const profiles = policy && policy.profiles && typeof policy.profiles === 'object' ? policy.profiles : {};
  const roles = map && map.roles && typeof map.roles === 'object' ? map.roles : {};
  if (!Object.prototype.hasOwnProperty.call(roles, role)) return null;
  const mapped = roles[role];
  return typeof mapped === 'string' && Object.prototype.hasOwnProperty.call(profiles, mapped) ? mapped : null;
}

export function principalFromUser(user) {
  if (!user || typeof user !== 'object') return null;
  const id = user.user_id ?? user.userId;
  if (id == null || id === '') return null;
  const details = user.role_details && typeof user.role_details === 'object' ? user.role_details : {};
  const profile = profileForRole(details.role_name ?? user.role_name);
  if (!profile) return null;
  // zoho.loginuserid is the user's email (the Principal contract on
  // principal.userId), not the numeric Catalyst user_id.
  const email = typeof user.email_id === 'string' ? user.email_id.trim() : '';
  const principal = { profile, userId: email || String(id) };
  if (email) principal.loginUser = email;
  return principal;
}

export async function resolvePrincipal(sdk, req) {
  let user;
  try {
    user = await sdk.initialize(req).userManagement().getCurrentUser();
  } catch {
    return null;
  }
  return principalFromUser(user);
}
