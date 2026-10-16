/**
 * Security provisioning for a project that already exists.
 *
 * The greenfield IaC import carries these same declarations (Authentication
 * roles, Data Store tableScope/tablePermission rows and the function
 * SecurityRules item). This runner applies that subset on an existing project
 * — but c2c never calls MCP itself and the CLI token is refused on the
 * security routes (recorded: 401 OAUTH_SCOPE_MISMATCH / AUTHENTICATION_FAILURE).
 * So the run is two-pass:
 *
 *   1. The host agent calls the read tools (List_All_Roles, List_All_Tables,
 *      Get_Table_Permissions and Get_Table_Scopes per table,
 *      List_All_Functions) and saves each raw reply under
 *      provision/evidence/import-existing/. The run diffs that recorded
 *      evidence against provision/security.json. A grant broader than the plan
 *      is never kept silently: the run refuses and lists each extra grant with
 *      the exact --narrow-existing-security command (the Catalyst console path
 *      is a secondary note).
 *   2. Every change the evidence needs is printed for the host agent: one
 *      Update_Table_Permissions and one Update_Table_Scopes call per table,
 *      keyed by role NAME — App User and custom roles alike (live MCP probe on
 *      a scratch table: the update tools accept a custom role by name although
 *      their schema lists only the two system roles, an update merges per
 *      named role, and an empty array revokes) — plus Enable_Authentication
 *      for the plan's function. Creating a missing role (no MCP or CLI tool
 *      creates one) and other unauthenticated functions stay guided console
 *      steps. The run exits non-zero either way. After the host applies them
 *      and re-records the evidence, a second run re-reads it and verifies —
 *      the step closes only when the recorded reads show the plan.
 *
 * App Administrator is out of scope: full access by design. It is never
 * diffed, never refused and never written — a printed revoke or scope change
 * on it would lock the app's admins out.
 *
 * Nothing is ever reported as applied: a change stays pending until a re-run's
 * fresh evidence reads it back as the plan.
 */
export interface SecurityRoleSpec {
  role_name: string;
  description?: string;
  clone_role?: string;
}

export interface SecurityGrantSpec {
  table: string;
  role: string;
  permissions: string[];
  /** The row scope; only compared when `permissions` is non-empty (a role with no operation reads nothing, whatever its scope). */
  scope?: string;
}

export interface ImportExistingSecuritySpec {
  roles?: SecurityRoleSpec[];
  tablePermissions?: SecurityGrantSpec[];
  function?: string;
}

export interface ImportExistingSecurityOptions {
  /** --narrow-existing-security: plan removals of grants broader than the plan instead of refusing on them. */
  narrow?: boolean;
}

/**
 * The recorded MCP replies the run reads. `permissions`/`scopes` are keyed by
 * table NAME — a Get_Table_* reply carries role rows, never the table, so the
 * file name (permissions/<table_name>.json) is what binds it to its table. The
 * name, not the id, because the host saves the files before it knows ids by
 * heart and the plan names tables, never ids.
 */
export interface ImportExistingEvidence {
  roles?: unknown;
  tables?: unknown;
  functions?: unknown;
  permissions?: Record<string, unknown>;
  scopes?: Record<string, unknown>;
}

/** The project/org the printed MCP calls target. */
export interface ImportExistingTarget {
  projectId: string;
  org: string;
}

/** Message of a pending run: built only from evidence names/ids and the plan, so the caller prints it without the generic secret scrub. */
export class ImportExistingPendingError extends Error {}

interface NamedId {
  name: string;
  id: string;
}

/** Full access by design — never diffed, refused or written. */
const OUT_OF_SCOPE_ROLE = 'App Administrator';

/** Roles every Catalyst project carries; never created by a guided step. */
const BUILTIN_ROLES = new Set(['App Administrator', 'App User']);

/** Row-scope width: GLOBAL reads every row, ORG the org's, USER the caller's. */
const SCOPE_RANK: Record<string, number> = { USER: 0, ORG: 1, GLOBAL: 2 };

const EVIDENCE_DIR = 'provision/evidence/import-existing';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rowsOf(body: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) if (isRecord(item)) out.push(item);
      return;
    }
    if (!isRecord(value)) return;
    for (const key of ['data', 'roles', 'tables', 'functions', 'items']) {
      const child = value[key];
      if (Array.isArray(child)) {
        walk(child);
        return;
      }
    }
    for (const child of Object.values(value)) if (isRecord(child)) walk(child);
  };
  walk(body);
  return out;
}

function decimal(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

/** Name/id rows of a List_All_* reply; a name listed twice is ambiguous evidence and refused. */
function namedRows(body: unknown, file: string, nameKeys: readonly string[], idKeys: readonly string[]): NamedId[] {
  const out: NamedId[] = [];
  for (const row of rowsOf(body)) {
    const name = nameKeys.map((key) => row[key]).find((value): value is string => typeof value === 'string' && value.length > 0);
    const id = idKeys.map((key) => decimal(row[key])).find((value): value is string => value !== undefined);
    if (!name || !id) continue;
    if (out.some((item) => item.name === name)) throw new Error(`evidence ${EVIDENCE_DIR}/${file} lists "${name}" twice — save the tool's raw reply once and re-run`);
    out.push({ name, id });
  }
  return out;
}

/**
 * Get_Table_Permissions rows -> role -> operation list. A missing or null
 * table_permissions reads as [] (no operation); anything that is not a list of
 * operation names, a row without a role name, a role listed twice, or a reply
 * with no role rows at all is malformed evidence and refused — never guessed.
 */
function permissionsByRole(body: unknown, file: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of roleRows(body, file)) {
    const role = row.role_name as string;
    const value = row.table_permissions;
    let ops: string[];
    if (value === undefined || value === null) ops = [];
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)) ops = [...new Set(value as string[])];
    else throw new Error(`evidence ${EVIDENCE_DIR}/${file}: role "${role}" table_permissions is not a list of operation names — save the tool's raw reply and re-run`);
    out.set(role, ops);
  }
  return out;
}

/** Get_Table_Scopes rows -> role -> scope (USER/ORG/GLOBAL); refused like permissionsByRole when malformed. */
function scopesByRole(body: unknown, file: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const row of roleRows(body, file)) {
    const role = row.role_name as string;
    const value = row.table_scope;
    if (value !== undefined && value !== null && !(typeof value === 'string' && value in SCOPE_RANK)) {
      throw new Error(`evidence ${EVIDENCE_DIR}/${file}: role "${role}" table_scope is not USER, ORG or GLOBAL — save the tool's raw reply and re-run`);
    }
    out.set(role, typeof value === 'string' ? value : undefined);
  }
  return out;
}

function roleRows(body: unknown, file: string): Record<string, unknown>[] {
  const rows = rowsOf(body);
  if (!rows.length) throw new Error(`evidence ${EVIDENCE_DIR}/${file} has no role rows — save the tool's raw reply and re-run`);
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.role_name !== 'string' || !row.role_name) throw new Error(`evidence ${EVIDENCE_DIR}/${file} has a row without a role_name — save the tool's raw reply and re-run`);
    if (seen.has(row.role_name)) throw new Error(`evidence ${EVIDENCE_DIR}/${file} lists role "${row.role_name}" twice — save the tool's raw reply once and re-run`);
    seen.add(row.role_name);
  }
  return rows;
}

/** Order-free set equality; [] and a missing grant are the same "no operation". */
function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((item) => expected.includes(item)) && expected.every((item) => actual.includes(item));
}

/** A grant the project holds that the plan does not ask for. */
interface BroaderGrant {
  item: string;
  step: string;
}

function functionName(row: Record<string, unknown>): string | undefined {
  const name = row.name ?? row.api_name ?? row.function_name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/** The copy-pasteable fix every refusal line leads with. */
const NARROW_FIX = 'c2c provision --out <dir> --confirm --run import-existing --narrow-existing-security';

/** One MCP write the host agent must run (c2c never calls MCP). */
interface PendingCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * The connector envelope every MCP call needs: path_variables.projectId plus
 * the Catalyst-org/Environment headers — the same shape `c2c plan` writes onto
 * mcp steps.
 */
function callArgs(target: ImportExistingTarget, extra?: Record<string, unknown>): Record<string, unknown> {
  const org = /^[0-9]+$/.test(target.org) ? Number(target.org) : target.org;
  return { path_variables: { projectId: target.projectId }, headers: { 'Catalyst-org': org, Environment: 'Development' }, ...extra };
}

/**
 * Apply and verify the security subset on an existing project from recorded
 * MCP evidence. Returns { security: 'verified', … } only when the recorded
 * reads already show the plan — c2c writes nothing itself, so `applied` is
 * always 0 and a verified run closes the step as `existing`.
 *
 * Anything else throws: missing or malformed evidence (which file to save,
 * from which tool), grants broader than the plan without `opts.narrow`, or the
 * pending write list (an ImportExistingPendingError) — exact MCP calls keyed
 * by role name, guided console steps only for role creation and functions
 * other than the plan's.
 */
export function applyImportExistingSecurity(
  evidence: ImportExistingEvidence,
  spec: ImportExistingSecuritySpec,
  opts: ImportExistingSecurityOptions,
  target: ImportExistingTarget,
): Record<string, unknown> {
  const rolesSpec = (spec.roles ?? []).filter((role) => role.role_name !== OUT_OF_SCOPE_ROLE);
  const grants = (spec.tablePermissions ?? []).filter((grant) => grant.role !== OUT_OF_SCOPE_ROLE);
  const fn = spec.function ?? 'c2c_api';
  const plannedByTableRole = new Map<string, SecurityGrantSpec>();
  for (const grant of grants) {
    const key = `${grant.table}\u0000${grant.role}`;
    if (plannedByTableRole.has(key)) throw new Error(`provision/security.json grants role "${grant.role}" on table ${grant.table} twice — re-run c2c plan`);
    plannedByTableRole.set(key, grant);
  }

  // --- Evidence completeness: every read the diff needs, named by file ---
  const missingEvidence: string[] = [];
  if (evidence.roles === undefined) missingEvidence.push(`${EVIDENCE_DIR}/roles.json ← CatalystbyZoho_List_All_Roles`);
  if (evidence.tables === undefined) missingEvidence.push(`${EVIDENCE_DIR}/tables.json ← CatalystbyZoho_List_All_Tables`);
  if (evidence.functions === undefined) missingEvidence.push(`${EVIDENCE_DIR}/functions.json ← CatalystbyZoho_List_All_Functions`);
  if (missingEvidence.length) {
    throw new Error(
      `import-existing reads recorded MCP evidence — save each raw reply and re-run:\n  ${missingEvidence.join('\n  ')}\nargs for every call: ${JSON.stringify(callArgs(target))}`,
    );
  }
  const roles = namedRows(evidence.roles, 'roles.json', ['role_name', 'name'], ['role_id', 'id']);
  const tableRows = namedRows(evidence.tables, 'tables.json', ['table_name', 'name'], ['table_id', 'id']);
  const permissionsByTable = new Map<string, Map<string, string[]>>();
  const scopesByTable = new Map<string, Map<string, string | undefined>>();
  for (const table of tableRows) {
    const permission = evidence.permissions?.[table.name];
    if (permission === undefined) missingEvidence.push(`${EVIDENCE_DIR}/permissions/${table.name}.json ← CatalystbyZoho_Get_Table_Permissions {"path_variables":{"projectId":"${target.projectId}","id":"${table.id}"}}`);
    else permissionsByTable.set(table.id, permissionsByRole(permission, `permissions/${table.name}.json`));
    const scopes = evidence.scopes?.[table.name];
    if (scopes === undefined) missingEvidence.push(`${EVIDENCE_DIR}/scopes/${table.name}.json ← CatalystbyZoho_Get_Table_Scopes {"path_variables":{"projectId":"${target.projectId}","id":"${table.id}"}}`);
    else scopesByTable.set(table.id, scopesByRole(scopes, `scopes/${table.name}.json`));
  }
  if (missingEvidence.length) {
    throw new Error(
      `import-existing reads recorded MCP evidence — save each raw reply and re-run:\n  ${missingEvidence.join('\n  ')}\nargs for every call: ${JSON.stringify(callArgs(target))}`,
    );
  }
  const functionRows = rowsOf(evidence.functions);

  // A planned grant on a table the project does not have is a plan gap — fail
  // before printing a write plan, not after part of it already landed.
  const tableNames = new Set(tableRows.map((row) => row.name));
  for (const grant of grants) {
    if (tableNames.has(grant.table)) continue;
    throw new Error(`table ${grant.table} is not readable — run the tables step first`);
  }

  // --- Per table, per role: desired vs recorded. App Administrator is skipped
  // everywhere; a role the plan does not list desires [] (no operation). ---
  const existingRoles = new Set(roles.map((role) => role.name));
  const missingRoles = rolesSpec.filter((role) => !BUILTIN_ROLES.has(role.role_name) && !existingRoles.has(role.role_name));
  const missingRoleNames = new Set(missingRoles.map((role) => role.role_name));
  const broader: BroaderGrant[] = [];
  const permissionBodies = new Map<string, Record<string, string[]>>();
  const scopeBodies = new Map<string, Record<string, string>>();
  for (const table of tableRows) {
    const currentPermissions = permissionsByTable.get(table.id)!;
    const currentScopes = scopesByTable.get(table.id)!;
    const plannedRoles = grants.filter((grant) => grant.table === table.name).map((grant) => grant.role);
    const allRoles = [...new Set([...currentPermissions.keys(), ...currentScopes.keys(), ...plannedRoles])].filter((role) => role !== OUT_OF_SCOPE_ROLE).sort();
    for (const role of allRoles) {
      if (missingRoleNames.has(role)) continue; // created by the guided step first; the next run prints its grant calls
      const grant = plannedByTableRole.get(`${table.name}\u0000${role}`);
      const desiredOps = grant?.permissions ?? [];
      const actualOps = currentPermissions.get(role) ?? [];
      for (const op of actualOps.filter((item) => !desiredOps.includes(item))) {
        broader.push({
          item: `table "${table.name}": role "${role}" has ${op} outside the plan`,
          step: `Data Store → ${table.name} → Permissions → remove ${op} from the ${role} grant`,
        });
      }
      if (!sameSet(actualOps, desiredOps)) (permissionBodies.get(table.id) ?? permissionBodies.set(table.id, {}).get(table.id)!)[role] = desiredOps;
      // Scope only matters while the role holds an operation: it cannot be
      // cleared, and a role with no operation reads nothing at any scope.
      if (!desiredOps.length || grant?.scope === undefined) continue;
      const actualScope = currentScopes.get(role);
      if (actualScope === grant.scope) continue;
      // Wider than planned is only broader access while the role already holds an
      // operation; a role at [] reads nothing at any scope.
      if (actualOps.length && actualScope !== undefined && (SCOPE_RANK[actualScope] ?? Number.MAX_SAFE_INTEGER) > (SCOPE_RANK[grant.scope] ?? -1)) {
        broader.push({
          item: `table "${table.name}": role "${role}" holds scope ${actualScope} outside the plan (plan: ${grant.scope})`,
          step: `Data Store → ${table.name} → Permissions → set the ${role} row scope to ${grant.scope}`,
        });
      }
      (scopeBodies.get(table.id) ?? scopeBodies.set(table.id, {}).get(table.id)!)[role] = grant.scope;
    }
  }
  const extraFunctions = functionRows.filter((row) => functionName(row) !== fn && row.is_authenticated !== true);
  for (const row of extraFunctions) {
    const name = functionName(row)!;
    broader.push({
      item: `function "${name}" is reachable without authentication outside the plan`,
      step: `Functions → ${name} → require authentication, or delete the function`,
    });
  }
  if (broader.length && !opts.narrow) {
    throw new Error(
      `import-existing refuses: the project holds ${broader.length} grant(s) broader than provision/security.json and they were left in place:\n` +
        broader.map((grant, index) => `  ${index + 1}. ${grant.item} — fix: ${NARROW_FIX}; Catalyst console path: ${grant.step}`).join('\n'),
    );
  }

  // --- The pending change list ---
  const calls: PendingCall[] = [];
  const guided: string[] = [];

  // No MCP or CLI tool creates a role (List_All_Roles only reads; the REST
  // role route refuses this token) — a missing planned role is a guided step.
  for (const role of missingRoles) {
    guided.push(
      `role "${role.role_name}": create it in the Catalyst console → Authentication → User Management → Roles → Add Role (clone ${role.clone_role ?? 'App User'}); then re-record roles.json and the Get_Table_* replies — the next run prints its grant calls`,
    );
  }

  // One merge-update per table: only the roles named in the body change, and
  // an empty array revokes every operation of that role. The scope call comes
  // first, so a newly granted operation never lands on a wider row scope.
  for (const table of tableRows) {
    const scopes = scopeBodies.get(table.id);
    if (scopes) {
      calls.push({
        tool: 'CatalystbyZoho_Update_Table_Scopes',
        args: callArgs(target, { path_variables: { projectId: target.projectId, id: table.id }, body: scopes }),
      });
    }
    const permissions = permissionBodies.get(table.id);
    if (permissions) {
      calls.push({
        tool: 'CatalystbyZoho_Update_Table_Permissions',
        args: callArgs(target, { path_variables: { projectId: target.projectId, id: table.id }, body: permissions }),
      });
    }
  }

  // Function authentication: Enable_Authentication carries only a project id —
  // the plan's own function gets the MCP call; any other unauthenticated
  // function (only reachable under --narrow; otherwise already refused) is a
  // guided console step.
  const fnRow = functionRows.find((row) => functionName(row) === fn);
  if (!fnRow) throw new Error(`function ${fn} is not readable — deploy the function first`);
  if (fnRow.is_authenticated !== true) {
    calls.push({
      tool: 'CatalystbyZoho_Enable_Authentication',
      args: callArgs(target, { query_params: { auth_type: 'hosted' } }),
    });
  }
  if (opts.narrow) {
    for (const row of extraFunctions) {
      guided.push(`function "${functionName(row)!}" is reachable without authentication outside the plan — Catalyst console → Functions → ${functionName(row)} → require authentication, or delete the function`);
    }
  }

  if (calls.length || guided.length) {
    const lines: string[] = [];
    if (calls.length) {
      lines.push(
        `host agent — run each call, then re-record the evidence files under ${EVIDENCE_DIR}/ and re-run: c2c provision --out <dir> --confirm --run import-existing`,
        ...calls.map((call, index) => `  ${index + 1}. ${call.tool} ${JSON.stringify(call.args)}`),
      );
    }
    if (guided.length) {
      lines.push(`guided steps (no MCP tool exists — counted gaps until a re-run reads them back):`, ...guided.map((step, index) => `  ${index + 1}. ${step}`));
    }
    throw new ImportExistingPendingError(
      `import-existing is pending: the recorded evidence needs ${calls.length} MCP write(s) and ${guided.length} guided change(s) — c2c never calls MCP itself.\n${lines.join('\n')}`,
    );
  }

  return {
    security: 'verified',
    applied: 0,
    roles: rowsOf(evidence.roles),
    tables: tableRows,
    permissions: tableRows.map((table) => ({ table_id: table.id, ...Object.fromEntries(permissionsByTable.get(table.id)!) })),
    scopes: tableRows.map((table) => ({ table_id: table.id, ...Object.fromEntries([...scopesByTable.get(table.id)!].flatMap(([role, scope]) => (scope === undefined ? [] : [[role, [scope]]]))) })),
    functions: functionRows,
  };
}
