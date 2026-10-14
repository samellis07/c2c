/**
 * Deploy-time Authentication provisioning.
 *
 * Recorded CLI-token behaviour ("CLI token vs console") for the zcatalyst-cli OAuth token:
 *   POST /authentication/enable?auth_type=hosted    works; body may carry public_signup
 *   POST /authentication/enable?auth_type=embedded  works
 *   POST /cors-domain                               works (200 returns the domain id)
 *   GET  /project-user                              works (hides users until they confirm)
 *   GET  /project-user/<id>                         works for a known invited user, including is_confirmed:false
 *   POST /project-user                              the console's Add User request; sent with only the recorded body
 *                                                     fields (platform_type, redirect_url, user_details email_id /
 *                                                     first_name / last_name / role_id). A CLI-token send with public
 *                                                     signup off is UNVERIFIED (an empty body returned 500, not a scope
 *                                                     refusal), so any failure prints the exact Add User values block
 *   GET  /authentication/configuration              OAUTH_SCOPE_MISMATCH
 *   GET  /cors-domain                               OAUTH_SCOPE_MISMATCH
 *   GET  /role                                      OAUTH_SCOPE_MISMATCH for the CLI token; a role-readable token answers it
 *   PUT  /authentication/configuration              OAUTH_SCOPE_MISMATCH
 *   PUT  /cors-domain/<id>                          OAUTH_SCOPE_MISMATCH — iFrame must be on at first create; an existing domain with iFrame off is a console Edit
 *
 * So every write's 200 body is its own proof, a read-back happens only where
 * the token can read (project-user), and everything else lands on the console
 * checklist for you to confirm. Emails and role ids are never
 * invented, and the email stays inside the invite request —
 * op details and console text say "the --admin-email user".
 *
 * Re-runs are idempotent three ways: the auth reads are still attempted (a
 * wider-scoped token can list domains and read the config), completed ops are
 * persisted per-op in the deploy state (a kill mid-run resumes the remaining
 * ops), and a server "already enabled / domain already exists" answer counts
 * as verified, never a duplicate write. public_signup is never sent true and
 * never flipped to false for you: it is sent false only when the
 * config read proves it is not already on; otherwise the field is omitted.
 */
import { slateHost } from '../../auth/src/slate-host.js';
import { restWithRetry, type ReRead, type RetryOptions } from './retry.js';
import type { RestCall, RestFn } from './tables.js';

export type AuthOpId = 'enable-hosted' | 'enable-embedded' | 'cors-domain' | 'admin-signup' | 'verify-users';
export type AuthOpStatus = 'applied' | 'verified' | 'skipped' | 'pending' | 'failed';

export interface AuthOpResult {
  id: AuthOpId;
  status: AuthOpStatus;
  call?: RestCall;
  /** Catalyst error_code when the server returned one (e.g. PUBLIC_SIGNUP_ERROR). */
  code?: string;
  /** What the 200 body proved, or why the op did not run. Never carries the admin email. */
  detail?: string;
  /** Console checklist line when the API could not do or confirm the step. */
  console?: string;
}

export interface AuthProvisionInput {
  projectId: string;
  /** Bare Slate host (no scheme). Unknown → the cors-domain write is a console step. */
  slateDomain?: string;
  /** First admin invite. The email is operator input; the role is pinned to App Administrator. */
  admin?: { email: string; name?: string; roleId?: string };
  /** Op ids applied or verified in an earlier --confirm run (resume). */
  done?: readonly string[];
  /** Catalyst user id returned by an earlier admin invite; lets verification read an unconfirmed user. */
  adminUserId?: string;
  /** Called immediately when an invite returns a user id, so a kill cannot lose the per-user verification key. */
  persistAdminUserId?: (userId: string) => void;
  /** Called after each op lands so the deploy state can persist per-op progress. */
  persistDone?: (done: string[]) => void;
  /** Retry tuning for the REST ops — tests pass an instant clock. */
  retry?: RetryOptions;
}

export interface AuthProvisionResult {
  results: AuthOpResult[];
  /** Applied/verified op ids — persist in the deploy state for resume. */
  done: string[];
  /** Console steps for anything the token cannot do or confirm. */
  consoleSteps: string[];
  /** Catalyst user id for the admin invite when one is known; persist in deploy state for resume. */
  adminUserId?: string;
}

/** Catalyst error codes for auth calls, found anywhere in the response body. */
export function errorCode(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return /OAUTH_SCOPE_MISMATCH|AUTHENTICATION_FAILURE|PUBLIC_SIGNUP_ERROR|INVALID_URL_PATTERN/.exec(text)?.[0];
}

const scopeRefused = (status: number, body: unknown): string | undefined =>
  status === 401 || status === 403 ? errorCode(body) : undefined;

/**
 * Any error_code plus a bounded, sanitised message from a failure body.
 * The message can quote anything the server echoed — including values the
 * request submitted — so `secrets` (identities, names) are redacted alongside
 * the token/address/id-shaped runs before the text reaches output or a file.
 */
export function failureInfo(body: unknown, secrets: readonly string[] = []): { code?: string; message?: string } {
  if (!body || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : record;
  const code = typeof data.error_code === 'string' && data.error_code ? data.error_code : typeof record.error_code === 'string' ? record.error_code : undefined;
  const raw = typeof data.message === 'string' ? data.message : typeof record.message === 'string' ? record.message : undefined;
  return { ...(code ? { code } : {}), ...(raw ? { message: sanitizeMessage(raw, secrets) } : {}) };
}

/**
 * Cap a server message and strip token/address/id-shaped runs before it is
 * shown or stored. `secrets` are values the caller submitted (a sign-in
 * identity, first/last names) — a server may echo them verbatim, so each word
 * they carry is redacted wherever it appears.
 */
export function sanitizeMessage(text: string, secrets: readonly string[] = []): string {
  const needles = new Set<string>();
  for (const secret of secrets) {
    for (const word of secret.toLowerCase().split(/\s+/)) {
      if (word.length >= 2) needles.add(word);
    }
  }
  const bare = (token: string): string => token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  return text
    .slice(0, 200)
    .replace(/\S+/g, (token) => {
      const word = bare(token);
      // Exact match for short names; substring match only once the needle is
      // long enough that a hit is near-certainly an echo, not a common prefix.
      const echoed = word.length >= 2 && [...needles].some((needle) => word === needle || (needle.length >= 3 && word.includes(needle)));
      return token.includes('@') || /[0-9]{10,}/.test(token) || (token.length >= 16 && /[0-9]/.test(token) && /[A-Za-z]/.test(token)) || echoed
        ? '[redacted]'
        : token;
    });
}

function detailFor(status: number, body: unknown): { code?: string; detail: string } {
  const info = failureInfo(body);
  const code = info.code ?? errorCode(body);
  return {
    ...(code ? { code } : {}),
    detail: `HTTP ${status}${code ? ` ${code}` : ''}${info.message ? ` — ${info.message}` : ''}`,
  };
}

/** A write the server says is already in place — verified, never a duplicate. */
export function alreadyDone(status: number, body: unknown): boolean {
  if (status !== 400 && status !== 409) return false;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return /DUPLICATE_VALUE/i.test(text) || /already (enabled|exists|in use|added|present|registered|authorised|authorized)/i.test(text);
}

/** The Slate app URL printed by slate:link / deploy slate ("App Url: https://….onslate.in"). */
export function slateUrlFrom(output: string): string | undefined {
  const tagged = /App Url:\s*(https:\/\/[^\s"'<>]+)/i.exec(output);
  if (tagged) return tagged[1];
  return /https:\/\/[a-z0-9][a-z0-9.-]*\.onslate\.[a-z.]+/i.exec(output)?.[0];
}

/**
 * Bare host from a URL or host string — the shared Slate-host rule; a value
 * that is not only a host (wildcard, userinfo, port, path, query) parses to
 * nothing rather than being silently trimmed.
 */
export function hostOf(urlOrHost: string | undefined): string | undefined {
  return slateHost(urlOrHost);
}

/** input.slateDomain through the shared rule — a bad value refuses instead of landing in a request body. */
function checkedSlateDomain(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const host = slateHost(value);
  if (!host) throw new Error('slateDomain must be a Slate app host — a bare hostname or the https App Url slate:link prints');
  return host;
}

/** GET /project-user body → row list. An empty project returns `[]`; tolerate common envelopes. */
export function projectUsers(body: unknown): Record<string, unknown>[] | undefined {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? ((body as Record<string, unknown>).data ?? (body as Record<string, unknown>).users ?? (body as Record<string, unknown>).project_users)
      : undefined;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : undefined;
}

/** A project-user row's sign-in address, lower-cased. Used at run time only — never stored or printed. */
export function userEmail(user: Record<string, unknown>): string | undefined {
  for (const key of ['email_id', 'email', 'emailId', 'user_email']) {
    const value = user[key];
    if (typeof value === 'string' && value.includes('@')) return value.toLowerCase();
  }
  return undefined;
}

/** Reuse a role id already present on a project user (GET /role is refused). */
export function roleIdFromUsers(users: readonly Record<string, unknown>[], roleName: string): string | undefined {
  for (const user of users) {
    const details = (user.role_details ?? user.roleDetails ?? {}) as Record<string, unknown>;
    const name = details.role_name ?? details.roleName ?? user.role_name;
    const id = details.role_id ?? details.roleId ?? details.id;
    if (name === roleName && (typeof id === 'string' || typeof id === 'number')) return String(id);
  }
  return undefined;
}

/** GET /role body → a matching role id. Refused for the recorded CLI token. */
function roleIdFromRoleList(body: unknown, roleName: string): string | undefined {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const rows = Array.isArray(body) ? body : record ? ([record.data, record.roles, record.role].find(Array.isArray) as unknown[] | undefined) : undefined;
  if (!rows) return undefined;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const role = row as Record<string, unknown>;
    const name = role.role_name ?? role.roleName ?? role.name;
    const id = role.role_id ?? role.roleId ?? role.id;
    if (name === roleName && (typeof id === 'string' || typeof id === 'number')) return String(id);
  }
  return undefined;
}

function userIdFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of ['user_id', 'userId', 'id']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return undefined;
}

/** Find a user id in the add-user response envelopes Catalyst and the recorded fake return. */
function userIdFromInvite(body: unknown, depth = 0): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body) || depth > 4) return undefined;
  const record = body as Record<string, unknown>;
  const direct = userIdFromRecord(record);
  if (direct) return direct;
  for (const value of Object.values(record)) {
    const found = userIdFromInvite(value, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function userConfirmed(user: Record<string, unknown>): boolean | undefined {
  const confirmed = truthy(user.is_confirmed ?? user.isConfirmed ?? user.confirmed);
  if (confirmed !== undefined) return confirmed;
  return undefined;
}

interface AuthConfigRead {
  hosted?: boolean;
  embedded?: boolean;
  publicSignup?: boolean;
}

const truthy = (value: unknown): boolean | undefined =>
  value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined;

/** GET /authentication/configuration body → flags. Refused for the CLI token; tolerate data/raw envelopes. */
export function authConfig(body: unknown): AuthConfigRead | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? (record.data as Record<string, unknown>) : record;
  return { hosted: truthy(data.hosted_auth), embedded: truthy(data.embedded_auth), publicSignup: truthy(data.public_signup) };
}

/** GET /cors-domain body → authorised hosts (lower-case). Refused for the CLI token. */
export function corsDomains(body: unknown): Set<string> | undefined {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const rows: unknown[] | undefined = Array.isArray(body)
    ? body
    : record
      ? ([record.data, record.domains, record.cors_domains].find(Array.isArray) as unknown[] | undefined)
      : undefined;
  if (!rows) return undefined;
  const domains = new Set<string>();
  for (const row of rows) {
    if (typeof row === 'string') {
      domains.add(row.toLowerCase());
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    for (const key of ['domain', 'domain_name', 'name', 'host']) {
      const value = (row as Record<string, unknown>)[key];
      if (typeof value === 'string' && value) domains.add(value.toLowerCase());
    }
  }
  return domains;
}

/** GET /cors-domain body → per-host cors/iframe flags. Refused for the CLI token. */
export function corsDomainFlags(body: unknown): Map<string, { cors?: boolean; iframe?: boolean }> | undefined {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const rows: unknown[] | undefined = Array.isArray(body)
    ? body
    : record
      ? ([record.data, record.domains, record.cors_domains].find(Array.isArray) as unknown[] | undefined)
      : undefined;
  if (!rows) return undefined;
  const flags = new Map<string, { cors?: boolean; iframe?: boolean }>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    let domain: string | undefined;
    for (const key of ['domain', 'domain_name', 'name', 'host']) {
      const value = rec[key];
      if (typeof value === 'string' && value) {
        domain = value.toLowerCase();
        break;
      }
    }
    if (!domain) continue;
    const cors = truthy(rec.cors);
    const iframe = truthy(rec.iframe);
    flags.set(domain, { ...(cors !== undefined ? { cors } : {}), ...(iframe !== undefined ? { iframe } : {}) });
  }
  return flags;
}

/**
 * The first_name POST /project-user must carry: an empty value is rejected
 * live with 400 MISSING_PARAM (and a nameless duplicate loses its 409
 * DUPLICATE_VALUE, so idempotence breaks too). --admin-name wins; otherwise
 * the email local part supplies a deterministic name ("jane.doe@…" → "Jane"),
 * falling back to "Admin". Whitespace-only names count as absent.
 */
export function adminFirstName(email: string, name?: string): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  const local = email.split('@', 1)[0] ?? '';
  const first = local.split(/[^A-Za-z0-9]+/).find((part) => part !== '');
  if (!first) return 'Admin';
  return `${first[0]!.toUpperCase()}${first.slice(1)}`;
}

/**
 * The console Add User values for the first admin — one copy-pasteable block.
 * The address stays a placeholder so the block can be printed and stored.
 */
export function addUserValues(role: string, slateDomain?: string): string {
  return [
    'Authentication > User Management > Users > Add User — enter exactly:',
    '  Email: <admin-email> (the --admin-email address)',
    `  Role: ${role}`,
    '  Platform: Web',
    '  Component: Slate',
    '  Slate App: <the Slate app this deploy created>',
    '  Deployment: default',
    `  Redirect URL: ${slateDomain ? `https://${slateDomain}` : '<the Slate app URL>'}`,
  ].join('\n');
}

/** Ops the run will send, in order — for the dry-run plan. No calls happen here. */
export function authProvisionPlan(input: AuthProvisionInput): { call: RestCall; note: string }[] {
  const domain = checkedSlateDomain(input.slateDomain);
  const base = `/baas/v1/project/${input.projectId}`;
  const ops: { call: RestCall; note: string }[] = [
    { call: { method: 'GET', path: `${base}/project-user` }, note: 'read-back; also harvests a known role id' },
    {
      call: { method: 'GET', path: `${base}/authentication/configuration` },
      note: 'current auth state (refused for the CLI token — a wider token makes re-runs skip what is already on)',
    },
    {
      call: { method: 'POST', path: `${base}/authentication/enable?auth_type=hosted`, body: { public_signup: false } },
      note: 'hosted login; public_signup:false only when the config read shows signup is not on — an on setting or a refused read omits the field, so a user choice is never flipped',
    },
    {
      call: { method: 'POST', path: `${base}/authentication/enable?auth_type=embedded`, body: {} },
      note: 'embedded login for the Slate app',
    },
    {
      call: { method: 'GET', path: `${base}/cors-domain` },
      note: 'authorised domains (refused for the CLI token — a wider token lets a re-run skip a domain already there)',
    },
    {
      call: { method: 'POST', path: `${base}/cors-domain`, body: { domain: domain ?? '<slate-domain>', cors: true, iframe: true } },
      note: domain
        ? `authorise ${domain} (CORS on, iFrame on — the embedded sign-in frame needs it); an "already exists" answer counts as verified`
        : 'needs the Slate host — captured from slate:link output or --slate-domain',
    },
  ];
  if (input.admin?.email && !input.admin.roleId) {
    ops.push(
      { call: { method: 'GET', path: `${base}/role` }, note: 'role id by name — refused for the CLI token; then an existing project user\'s role_details' },
    );
  }
  ops.push(
    input.admin?.email
      ? {
          call: {
            method: 'POST',
            path: `${base}/project-user`,
            body: {
              platform_type: 'web',
              // The invite mail's link resolves only with redirect_url — without
              // the Slate URL it lands on a page that does not exist.
              redirect_url: domain ? `https://${domain}` : 'https://<slate-domain>',
              user_details: {
                email_id: input.admin.email,
                first_name: adminFirstName(input.admin.email, input.admin.name),
                last_name: '',
                role_id: input.admin.roleId ?? '<App Administrator role id>',
              },
            },
          },
          note: 'invite the first admin through Add User (Web + Slate redirect URL), recorded body fields only; sent only with a role id — otherwise the exact Add User values block is printed; never public signup',
        }
      : {
          call: { method: 'POST', path: `${base}/project-user` },
          note: 'no --admin-email given — pass it so deploy sends the first-admin invite and verifies it by user id',
        },
  );
  return ops;
}

export async function applyAuthProvision(rest: RestFn, input: AuthProvisionInput): Promise<AuthProvisionResult> {
  const base = `/baas/v1/project/${input.projectId}`;
  const results: AuthOpResult[] = [];
  const consoleSteps: string[] = [];
  const done = new Set(input.done ?? []);
  const adminRole = 'App Administrator';
  const slateDomain = checkedSlateDomain(input.slateDomain);
  /** How the user sees the invitee in output — the email itself stays inside the signup request only. */
  const adminLabel = 'the --admin-email user';

  const push = (result: AuthOpResult): void => {
    results.push(result);
    if (result.console) consoleSteps.push(result.console);
    if ((result.status === 'applied' || result.status === 'verified') && !done.has(result.id)) {
      done.add(result.id);
      input.persistDone?.([...done].sort());
    }
  };

  // A transport throw cannot leave the run half-reported: the op records
  // 'failed', the ops that already landed stay in `done`, and the run
  // continues to the next op. Every call retries a transient 429/5xx with
  // backoff; a write's retry re-reads the resource first so a POST that
  // landed despite its failure answer is never sent twice.
  const call = async (
    spec: RestCall,
    opts: { reRead?: (failure: { status: number; body: unknown }) => Promise<ReRead<unknown>> } = {},
  ): Promise<{ status: number; body: unknown } | { transport: string }> => {
    try {
      const outcome = await restWithRetry<unknown>(rest, spec, {
        ...input.retry,
        ...(opts.reRead ? { reRead: opts.reRead } : {}),
      });
      if (outcome.applied !== undefined) return { status: 200, body: outcome.applied };
      return outcome.result;
    } catch (err) {
      return { transport: sanitizeMessage(err instanceof Error ? err.message : 'request failed') };
    }
  };

  // The one auth read the CLI token can do: list app users. A refused
  // read means "confirm in the console" (pending); a real failure is 'failed'.
  const listUsers = async (): Promise<
    { users: Record<string, unknown>[] } | { transport: string } | { refused: true } | { failure: string }
  > => {
    const res = await call({ method: 'GET', path: `${base}/project-user` });
    if ('transport' in res) return res;
    if (res.status >= 200 && res.status < 300) return { users: projectUsers(res.body) ?? [] };
    if (scopeRefused(res.status, res.body)) return { refused: true };
    return { failure: detailFor(res.status, res.body).detail };
  };
  const usersRes = await listUsers();
  const usersBefore = 'users' in usersRes ? usersRes.users : undefined;
  let adminUserId = input.adminUserId;

  const userFromBody = (body: unknown): Record<string, unknown> | undefined => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const record = body as Record<string, unknown>;
    for (const key of ['data', 'user_details', 'user']) {
      const value = record[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    }
    return record;
  };

  const getUser = async (
    userId: string,
  ): Promise<{ user: Record<string, unknown> } | { missing: true } | { refused: true } | { transport: string } | { failure: string }> => {
    const res = await call({ method: 'GET', path: `${base}/project-user/${userId}` });
    if ('transport' in res) return res;
    if (res.status >= 200 && res.status < 300) return { user: userFromBody(res.body) ?? {} };
    if (res.status === 404) return { missing: true };
    if (scopeRefused(res.status, res.body)) return { refused: true };
    return { failure: detailFor(res.status, res.body).detail };
  };

  const adminRoleId = async (): Promise<{ roleId: string; source: string } | undefined> => {
    if (input.admin?.roleId) return { roleId: input.admin.roleId, source: '--admin-role-id' };

    // 1. A token with role-read scope can answer directly. The recorded CLI
    // token cannot, but a future/broader token should use the documented path.
    const roles = await call({ method: 'GET', path: `${base}/role` });
    if (!('transport' in roles) && roles.status >= 200 && roles.status < 300) {
      const roleId = roleIdFromRoleList(roles.body, adminRole);
      if (roleId) return { roleId, source: 'GET /role' };
    }

    // 2. Every visible project user carries role_details; when the list row is
    // sparse, the documented per-user detail read exposes it.
    const listed = usersBefore ? roleIdFromUsers(usersBefore, adminRole) : undefined;
    if (listed) return { roleId: listed, source: 'GET /project-user role_details' };
    for (const user of usersBefore ?? []) {
      const id = userIdFromRecord(user);
      if (!id) continue;
      const detail = await getUser(id);
      if ('user' in detail) {
        const roleId = roleIdFromUsers([detail.user], adminRole);
        if (roleId) return { roleId, source: `GET /project-user/${id}` };
      }
    }
    return undefined;
  };

  // Auth state where readable — refused for the CLI token, answered by a wider one.
  const configRes = await call({ method: 'GET', path: `${base}/authentication/configuration` });
  const config = 'transport' in configRes || configRes.status < 200 || configRes.status >= 300 ? undefined : authConfig(configRes.body);

  const enable = async (kind: 'hosted' | 'embedded', label: string): Promise<void> => {
    const id: AuthOpId = `enable-${kind}`;
    if (done.has(id)) return push({ id, status: 'skipped', call: { method: 'POST', path: `${base}/authentication/enable?auth_type=${kind}` }, detail: 'applied in an earlier run' });
    if (config && (kind === 'hosted' ? config.hosted : config.embedded) === true) {
      return push({
        id,
        status: 'verified',
        detail: `${kind}_auth already enabled (GET /authentication/configuration) — nothing re-posted`,
      });
    }
    // public_signup is preserved: false is sent only when the config read shows
    // signup is not already on (a fresh enable stays deny-by-default). When the
    // read is refused the field is omitted, so a user's on is never flipped.
    const body: Record<string, unknown> | undefined =
      kind === 'embedded' ? {} : config === undefined || config.publicSignup === true ? {} : { public_signup: false };
    const spec: RestCall = { method: 'POST', path: `${base}/authentication/enable?auth_type=${kind}`, body };
    const res = await call(spec, {
      // Enable is idempotent — a second enable answers "already enabled" and
      // counts as verified. When the config read works it settles the retry:
      // flag on → applied, flag off → re-send.
      reRead: async () => {
        const again = await call({ method: 'GET', path: `${base}/authentication/configuration` });
        if ('transport' in again) return undefined;
        if (again.status < 200 || again.status >= 300) return { resend: spec };
        const flags = authConfig(again.body);
        if (flags && (kind === 'hosted' ? flags.hosted : flags.embedded) === true) return { applied: again.body };
        return { resend: spec };
      },
    });
    if ('transport' in res) {
      return push({
        id,
        status: 'failed',
        detail: `transport error — ${res.transport}`,
        console: `Authentication > Authentication Type: enable ${label} login — the API call did not answer; re-run deploy --confirm to finish.`,
      });
    }
    if (res.status >= 200 && res.status < 300) {
      const record = (res.body ?? {}) as Record<string, unknown>;
      const data = (record.data ?? {}) as Record<string, unknown>;
      const flag = record[`${kind}_auth`] ?? data[`${kind}_auth`];
      const signup = truthy(record.public_signup ?? data.public_signup);
      // public_signup stayed on when the response says so — or when the config
      // read already showed it on and we deliberately sent nothing for it.
      const preserved = kind === 'hosted' && (signup === true || config?.publicSignup === true);
      return push({
        id,
        status: 'applied',
        call: spec,
        detail:
          `200 — ${kind}_auth:${String(flag === undefined ? 'true' : flag)} in the response body (the config read is refused, so this body is the proof)` +
          (preserved ? '; public_signup stayed on — kept as you set it' : ''),
        ...(preserved
          ? {
              console:
                'Authentication > Whitelisting: public signup is on — deploy did not change it. Turn it off in the console (or attach the Custom User Validation function) only if this app must not self-signup.',
            }
          : {}),
      });
    }
    if (alreadyDone(res.status, res.body)) {
      return push({ id, status: 'verified', call: spec, detail: `${kind}_auth already enabled (HTTP ${res.status} says it is in place)` });
    }
    const refused = scopeRefused(res.status, res.body);
    const failure = detailFor(res.status, res.body);
    return push({
      id,
      status: refused ? 'pending' : 'failed',
      call: spec,
      ...(failure.code ? { code: failure.code } : {}),
      detail: failure.detail,
      console: `Authentication > Authentication Type: enable ${label} login${kind === 'hosted' ? ' with public signup off' : ''} — the API call was ${refused ? 'refused for this token' : `rejected (${failure.detail})`}.`,
    });
  };

  await enable('hosted', 'Hosted');
  await enable('embedded', 'Embedded');

  {
    const id: AuthOpId = 'cors-domain';
    const domain = slateDomain;
    // iFrame on at first create — the embedded sign-in frame cannot load
    // without it. An existing domain with iFrame off cannot be fixed by this
    // write: PUT /cors-domain is refused for the CLI token.
    const spec: RestCall | undefined = domain
      ? { method: 'POST', path: `${base}/cors-domain`, body: { domain, cors: true, iframe: true } }
      : undefined;
    if (done.has(id)) {
      push({ id, status: 'skipped', ...(spec ? { call: spec } : {}), detail: 'applied in an earlier run' });
    } else if (!domain) {
      push({
        id,
        status: 'pending',
        console: 'Authentication > Authorized Domains: add the Slate app host (CORS on, iFrame on — the embedded sign-in frame needs it). The Slate URL was not captured this run — pass --slate-domain <host> so deploy can POST /cors-domain.',
      });
    } else {
      // The domain list read is refused for the CLI token; a wider token makes a
      // re-run see the domain and its iFrame flag and skip the write entirely.
      const listRes = await call({ method: 'GET', path: `${base}/cors-domain` });
      const listed = 'transport' in listRes || listRes.status < 200 || listRes.status >= 300 ? undefined : corsDomains(listRes.body);
      const flag = 'transport' in listRes || listRes.status < 200 || listRes.status >= 300 ? undefined : corsDomainFlags(listRes.body)?.get(domain.toLowerCase());
      if (listed?.has(domain.toLowerCase())) {
        if (flag?.iframe === false) {
          push({
            id,
            status: 'pending',
            detail: `${domain} is authorised but iFrame is off — the embedded sign-in frame cannot load`,
            console: `Authentication > Whitelisting > Authorized Domains > ${domain} > Edit: turn iFrame on (the API cannot set it on an existing domain — PUT is refused for this token), then re-run deploy --confirm to re-check.`,
          });
        } else {
          push({
            id,
            status: 'verified',
            detail: `${domain} already authorised${flag?.iframe === true ? ' with iFrame on' : ''} (GET /cors-domain) — nothing re-posted`,
            ...(flag?.iframe === true
              ? {}
              : {
                  console: `Authentication > Whitelisting > Authorized Domains: confirm iFrame is on for ${domain} (Edit > iFrame on) — the list row did not report the flag.`,
                }),
          });
        }
      } else {
        const res = await call(spec as RestCall, {
          // Re-list the domains before re-posting: a create that landed despite
          // the failure answer is done; a listed-absent domain is re-sent; a
          // refused list can still re-send — a duplicate answers "already
          // exists", which alreadyDone counts as verified, never a second domain.
          reRead: async () => {
            const again = await call({ method: 'GET', path: `${base}/cors-domain` });
            if ('transport' in again) return undefined;
            if (again.status < 200 || again.status >= 300) return { resend: spec as RestCall };
            if (corsDomains(again.body)?.has(domain.toLowerCase())) return { applied: { data: { domain } } };
            return { resend: spec as RestCall };
          },
        });
        if ('transport' in res) {
          push({
            id,
            status: 'failed',
            detail: `transport error — ${res.transport}`,
            console: `Authentication > Authorized Domains: add ${domain} (CORS on, iFrame on) — the API call did not answer; re-run deploy --confirm to finish.`,
          });
        } else if (res.status >= 200 && res.status < 300) {
          push({ id, status: 'applied', call: spec, detail: `200 — domain ${domain} authorised (CORS on, iFrame on); confirm under Authorized Domains — the list read is refused` });
        } else if (alreadyDone(res.status, res.body)) {
          push({
            id,
            status: 'verified',
            call: spec,
            detail: `${domain} already authorised (HTTP ${res.status} says the domain exists)`,
            console: `Authentication > Whitelisting > Authorized Domains: confirm iFrame is on for ${domain} (Edit > iFrame on) — the flag is not readable with this token.`,
          });
        } else {
          const refused = scopeRefused(res.status, res.body);
          const failure = detailFor(res.status, res.body);
          push({
            id,
            status: refused ? 'pending' : 'failed',
            call: spec,
            ...(failure.code ? { code: failure.code } : {}),
            detail: failure.detail,
            console: `Authentication > Authorized Domains: add ${domain} (CORS on, iFrame on) — the API call was ${refused ? 'refused for this token' : `rejected (${failure.detail})`}.`,
          });
        }
      }
    }
  }

  // The documented Add User endpoint is POST /project-user. Public signup
  // (/project-user/signup) is intentionally not part of the normal path: it
  // requires a project-wide setting the first admin flow must not depend on.
  const addUserGuided = (reason: string): string =>
    `The API invite ${reason}; no invite was re-sent. Add the first admin in the console:\n${addUserValues(adminRole, slateDomain)}\nAfter the admin accepts the emailed invite and signs in once, re-run deploy --confirm to verify.`;

  {
    const id: AuthOpId = 'admin-signup';
    const admin = input.admin;
    const email = admin?.email.toLowerCase();
    const visible = email ? usersBefore?.find((user) => userEmail(user) === email) : undefined;
    const visibleId = visible ? userIdFromRecord(visible) : undefined;
    if (visibleId && !adminUserId) {
      adminUserId = visibleId;
      input.persistAdminUserId?.(visibleId);
    }

    const readAdmin = adminUserId ? await getUser(adminUserId) : undefined;
    const adminUser = readAdmin && 'user' in readAdmin ? readAdmin.user : undefined;
    const confirmed = adminUser ? userConfirmed(adminUser) : visible ? userConfirmed(visible) : undefined;

    if (!admin?.email && !adminUserId) {
      push({
        id,
        status: 'pending',
        console: `Pass --admin-email so deploy can send the first-admin invite through POST /project-user. The only human steps are accepting the emailed invite and signing in once.`,
      });
    } else if (adminUser && confirmed === true) {
      push({ id, status: 'verified', detail: `${adminLabel} is confirmed (GET /project-user/<id>)` });
    } else if (adminUser && confirmed === false) {
      push({
        id,
        status: 'pending',
        detail: `${adminLabel} is invited but unconfirmed (GET /project-user/<id>)`,
        console: 'Human next action: accept the emailed admin invite and sign in once, then re-run deploy --confirm. No invite was re-sent.',
      });
    } else if (readAdmin && 'missing' in readAdmin) {
      push({
        id,
        status: 'pending',
        detail: 'the recorded invite user id is missing from GET /project-user/<id>',
        console: 'The invite API returned a user id earlier, but that id no longer resolves. Do not send a second invite until the first admin confirms they have no emailed invite; then re-run deploy --confirm.',
      });
    } else if (done.has(id)) {
      push({
        id,
        status: adminUserId ? 'skipped' : 'pending',
        detail: adminUserId ? 'applied in an earlier run; confirmation is checked by verify-users' : 'the earlier invite was applied before a user id was persisted — no blind re-send',
        ...(adminUserId
          ? {}
          : {
              console: 'After the admin accepts the emailed invite and signs in once, GET /project-user will expose them; re-run deploy --confirm to verify. No invite was re-sent.',
            }),
      });
    } else if (!admin?.email) {
      push({ id, status: 'skipped', detail: 'no admin invite was requested' });
    } else if (!slateDomain) {
      push({
        id,
        status: 'pending',
        console: `Authentication > Users: the invite for ${adminLabel} needs redirect_url = the Slate app URL — pass --slate-domain <host> (or let the Slate deploy print the App Url first), then re-run to send it.`,
      });
    } else {
      const role = await adminRoleId();
      const spec: RestCall | undefined = role
        ? {
            method: 'POST',
            path: `${base}/project-user`,
            body: {
              platform_type: 'web',
              redirect_url: `https://${slateDomain}`,
              user_details: { email_id: admin.email, first_name: adminFirstName(admin.email, admin.name), last_name: '', role_id: role.roleId },
            },
          }
        : undefined;
      if (!role || !spec) {
        push({
          id,
          status: 'pending',
          detail: `${adminRole} role id was not exposed by GET /role or project-user role_details — no invite was sent`,
          console: `No invite was sent: GET /role is refused for this token and no project user carries the ${adminRole} role yet. On a fresh project this console Add User step is the path today — the console picks the role by name, so no role id is needed:\n${addUserValues(adminRole, slateDomain)}\nAfter the admin accepts the emailed invite and signs in once, re-run deploy --confirm to verify.`,
        });
      } else {
        const res = await call(spec, {
          // An invite that failed may still have mailed. Re-read the user list:
          // present → applied, absent → re-send, unreadable → never re-invite
          // blind (a second signup could mail twice).
          reRead: async () => {
            const again = await call({ method: 'GET', path: `${base}/project-user` });
            if ('transport' in again || again.status < 200 || again.status >= 300) return undefined;
            const found = (projectUsers(again.body) ?? []).find((row) => userEmail(row) === email);
            if (!found) return { resend: spec };
            const uid = found.user_id ?? found.userId;
            return { applied: { data: { user_id: typeof uid === 'string' || typeof uid === 'number' ? uid : undefined } } };
          },
        });
        if ('transport' in res) {
          push({
            id,
            status: 'failed',
            detail: `transport error — ${res.transport}`,
            console: addUserGuided('did not answer'),
          });
        } else if (res.status >= 200 && res.status < 300) {
          const uid = userIdFromInvite(res.body);
          if (uid) {
            adminUserId = uid;
            input.persistAdminUserId?.(uid);
          }
          push({ id, status: 'applied', call: spec, detail: `200 — invite sent to ${adminLabel} by POST /project-user (Web, Slate redirect_url); role id source: ${role.source}` });
        } else if (alreadyDone(res.status, res.body)) {
          // 409 DUPLICATE_VALUE: the address already holds an
          // invite. It is verified only when a read confirms it; GET
          // /project-user hides unconfirmed users, so a duplicate that was not
          // listed above is an invite waiting on its mail — pending, the same
          // status and wording as an unconfirmed invite.
          const uid = userIdFromInvite(res.body);
          if (uid) {
            adminUserId = uid;
            input.persistAdminUserId?.(uid);
          }
          const dupRead = uid ? await getUser(uid) : undefined;
          const dupConfirmed = dupRead && 'user' in dupRead ? userConfirmed(dupRead.user) : undefined;
          push(
            dupConfirmed === true
              ? { id, status: 'verified', call: spec, detail: `${adminLabel} already exists and is confirmed (GET /project-user/<id>) — nothing re-sent` }
              : {
                  id,
                  status: 'pending',
                  call: spec,
                  code: detailFor(res.status, res.body).code ?? 'DUPLICATE_VALUE',
                  detail: `HTTP ${res.status} — ${adminLabel} already exists or is already invited; nothing re-sent`,
                  console: `Authentication > Users: ${adminLabel} already exists or is already invited — accept the invite mail for this project, then sign in once at the app's /__catalyst/auth/login. Do not add the same address again in the console.`,
                },
          );
        } else {
          const refused = scopeRefused(res.status, res.body);
          const failure = detailFor(res.status, res.body);
          // 400 MISSING_PARAM on the invite is a named error, never a silent
          // console fallback: it means the first_name requirement fired (live
          // probe) — the detail names the field and the block is still printed.
          const missingParam =
            res.status === 400 && failure.code === 'MISSING_PARAM' && /first_name/i.test(typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? ''));
          push({
            id,
            status: refused ? 'pending' : 'failed',
            call: spec,
            ...(failure.code ? { code: failure.code } : {}),
            detail: missingParam ? `${failure.detail} — first_name is mandatory; pass --admin-name <name> (a name is derived from the email when the flag is omitted)` : failure.detail,
            console: addUserGuided(
              missingParam
                ? 'was rejected: HTTP 400 MISSING_PARAM — first_name is mandatory; the invite was not re-sent'
                : refused
                  ? 'was refused for this token'
                  : `was rejected (${failure.detail})`,
            ),
          });
        }
      }
    }
  }

  {
    const id: AuthOpId = 'verify-users';
    const spec: RestCall | undefined = adminUserId ? { method: 'GET', path: `${base}/project-user/${adminUserId}` } : { method: 'GET', path: `${base}/project-user` };
    const detail = adminUserId ? await getUser(adminUserId) : undefined;
    const email = input.admin?.email?.toLowerCase();
    if (detail && 'transport' in detail) {
      push({
        id,
        status: 'failed',
        call: spec,
        detail: `transport error — ${detail.transport}`,
        console: 'The invited admin could not be read back this run; re-run deploy --confirm to verify by API.',
      });
    } else if (detail && 'refused' in detail) {
      push({
        id,
        status: 'pending',
        call: spec,
        console: 'GET /project-user/<id> was refused for this token; after the admin accepts the invite and signs in once, re-run deploy --confirm to verify.',
      });
    } else if (detail && 'failure' in detail) {
      push({
        id,
        status: 'failed',
        call: spec,
        detail: detail.failure,
        console: 'The invited admin could not be read back this run; re-run deploy --confirm to verify by API.',
      });
    } else if (detail && 'missing' in detail) {
      push({
        id,
        status: 'pending',
        call: spec,
        detail: 'invited admin missing from GET /project-user/<id>',
        console: 'The recorded admin user id did not resolve. Do not send another invite until the admin confirms no emailed invite arrived; then re-run deploy --confirm.',
      });
    } else if (detail && 'user' in detail) {
      const confirmed = userConfirmed(detail.user);
      push(
        confirmed === true
          ? { id, status: 'verified', call: spec, detail: `${adminLabel} confirmed by GET /project-user/<id>` }
          : {
              id,
              status: 'pending',
              call: spec,
              detail: `${adminLabel} is unconfirmed in GET /project-user/<id>`,
              console: 'Human next action: accept the emailed invite and sign in once, then re-run deploy --confirm to verify. No invite was re-sent.',
            },
      );
    } else {
      const usersRes2 = await listUsers();
      if ('transport' in usersRes2) {
        push({
          id,
          status: 'failed',
          call: spec,
          detail: `transport error — ${usersRes2.transport}`,
          console: 'The app-user list could not be read back this run; re-run deploy --confirm to verify by API.',
        });
      } else if ('failure' in usersRes2) {
        push({ id, status: 'failed', call: spec, detail: usersRes2.failure, console: 'The app-user list could not be read back this run; re-run deploy --confirm to verify by API.' });
      } else if ('refused' in usersRes2) {
        push({ id, status: 'pending', call: spec, console: 'GET /project-user was refused for this token; re-run deploy --confirm after the admin accepts and signs in once.' });
      } else if (email) {
        const found = usersRes2.users.find((user) => userEmail(user) === email);
        const foundId = found ? userIdFromRecord(found) : undefined;
        if (foundId) {
          adminUserId = foundId;
          input.persistAdminUserId?.(foundId);
          const foundDetail = await getUser(foundId);
          if ('user' in foundDetail && userConfirmed(foundDetail.user) === true) {
            push({ id, status: 'verified', call: { method: 'GET', path: `${base}/project-user/${foundId}` }, detail: `${adminLabel} confirmed by GET /project-user/<id>` });
          } else if ('user' in foundDetail) {
            push({
              id,
              status: 'pending',
              call: { method: 'GET', path: `${base}/project-user/${foundId}` },
              detail: `${adminLabel} is unconfirmed in GET /project-user/<id>`,
              console: 'Human next action: accept the emailed invite and sign in once, then re-run deploy --confirm to verify. No invite was re-sent.',
            });
          } else {
            push({ id, status: 'verified', call: spec, detail: `${adminLabel} is listed by GET /project-user` });
          }
        } else if (found) {
          push({ id, status: 'verified', call: spec, detail: `${adminLabel} is listed by GET /project-user` });
        } else {
          push({
            id,
            status: 'pending',
            call: spec,
            detail: `${adminLabel} is not in the visible project-user list (unconfirmed users are hidden)`,
            console: 'Human next action: accept the emailed invite and sign in once, then re-run deploy --confirm. No invite was re-sent.',
          });
        }
      } else {
        push({ id, status: 'verified', call: spec, detail: `${usersRes2.users.length} project user${usersRes2.users.length === 1 ? '' : 's'}` });
      }
    }
  }

  return { results, done: [...done].sort(), consoleSteps, ...(adminUserId ? { adminUserId } : {}) };
}

export function formatAuthProvision(result: AuthProvisionResult): string {
  const label: Record<AuthOpStatus, string> = { applied: 'applied', verified: 'verified', skipped: 'skipped', pending: 'console', failed: 'FAILED' };
  const lines = ['auth provisioning:'];
  for (const op of result.results) {
    lines.push(`- ${op.id}: ${label[op.status]}${op.detail ? ` — ${op.detail}` : ''}`);
  }
  if (result.consoleSteps.length) {
    lines.push('auth console steps:');
    for (const step of result.consoleSteps) lines.push(`- ${step}`);
  }
  return `${lines.join('\n')}\n`;
}
