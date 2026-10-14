/**
 * Pin every catalyst child to the guarded org and project.
 * zcatalyst-cli 1.27.2 reads --org and --project from the parent command
 * (lib/internal/command.js _prepare → parent.opts()). They must precede the
 * subcommand. Subcommand --help does not restate them; `catalyst --help` does.
 * Selector env vars are removed so they cannot override those flags.
 * X_ZC_CREDENTIAL_PATH is kept. The credential directory is not opened here.
 *
 * project:list does not print the org. lib/commands/project/list.js builds a
 * cli-table3 with only "Project Name" and "Project ID", and appends " (active)"
 * to the name when getProjectId() matches that row. The org is the Development
 * environment zgid (util_modules/project.js transformEnv maps env_zgid to id;
 * internal/api.js sends that id as CATALYST-ORG). GET /baas/v1/project/<id>
 * (endpoints/lib/project.js getProject) is what reports it.
 *
 * The printed Project ID is not the original digits once the id exceeds
 * Number.MAX_SAFE_INTEGER. zcatalyst-cli 1.27.2 lib/internal/api.js
 * _parseResponse does `body = JSON.parse(rawResponseData.toString())`.
 * getAllProjects returns res.body.data, and list.js then does:
 *   let displayId = project.id + '';
 *   if (activeProjectId === displayId) enhance = ' (active)';
 *   if (defaultProjectId === displayId) enhance += ' (base)';
 *   if (enhance !== '') { displayName = cyan(displayName + enhance); displayId = cyan(displayId + ''); }
 *   listTable.push([displayName, displayId]);
 * project.id is that parsed number, so the cell is the IEEE-754 rendering
 * (`10000000000315013` prints as `10000000000315012`, `10000000000013003` as
 * `10000000000013004`). command_needs/rc.js stores the same coercion
 * (`project.id + ''`), so the (active) mark compares two rounded strings.
 * A last-digit neighbor that rounds the same way is the same cell. The list
 * is only a sanity check against that rendering. The authoritative gate is
 * GET /baas/v1/project/<id> parsed from the raw body (integer literals kept
 * as strings): data.id and the Development env_zgid must equal the guarded
 * ids character for character. A wrong project or org still fails closed.
 */
import type { GuardOk } from './guards.js';

export function catalystScopeArgs(org: string, projectId: string): string[] {
  return ['--org', org, '--project', projectId];
}

export function scrubCatalystEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'X_ZC_CREDENTIAL_PATH') {
      next[key] = value;
      continue;
    }
    if (key.startsWith('CATALYST_') || key.startsWith('ZC_')) continue;
    next[key] = value;
  }
  return next;
}

const LIST_ERROR = 'catalyst project:list did not report the guarded org and project';
const DETAILS_ERROR = 'catalyst project details did not report the guarded org and project';

interface ProjectListRow {
  name: string;
  id: string;
  active: boolean;
}

/**
 * Decimal the CLI prints for this id. Safe integers stay themselves.
 * Anything past Number.MAX_SAFE_INTEGER is `String(Number(id))`, the same
 * value as `project.id + ''` after JSON.parse. Not an identity.
 */
export function cliRenderedProjectId(projectId: string): string {
  if (!/^[0-9]+$/.test(projectId)) return projectId;
  const asNumber = Number(projectId);
  if (!Number.isSafeInteger(asNumber)) return String(asNumber);
  return projectId;
}

/**
 * Sanity-check project:list. The Project ID cell must be the guarded id, or
 * (only when the CLI's rendering differs) that rendering — never a name like
 * widget-1001, and never some other row. One matching row. Another row marked
 * active still aborts. A lossy match is not proof: two different 17-digit ids
 * can print as the same cell, and the REST check refuses the wrong one.
 * The matching row must be active unless selectedProjectId is this id (the
 * --project flag). The table has no org column.
 */
export function assertReportedScope(output: string, projectId: string, selectedProjectId?: string): void {
  if (!/^[0-9]+$/.test(projectId)) throw new Error(LIST_ERROR);
  const rows = projectListRows(output);
  const rendered = cliRenderedProjectId(projectId);
  const sameCell = (id: string) => id === projectId || (rendered !== projectId && id === rendered);
  const match = rows.filter((row) => sameCell(row.id));
  if (match.length !== 1) throw new Error(LIST_ERROR);
  if (rows.some((row) => row.active && !sameCell(row.id))) throw new Error(LIST_ERROR);
  if (!match[0].active && selectedProjectId !== projectId) throw new Error(LIST_ERROR);
}

/** cli-table3 rows from project:list. Header cells name the columns. */
function projectListRows(output: string): ProjectListRow[] {
  const stripped = output.replace(/\u001b\[[0-9;]*m/g, '');
  let nameIndex = -1;
  let idIndex = -1;
  const rows: ProjectListRow[] = [];
  for (const line of stripped.split(/\r?\n/)) {
    if (!line.includes('│')) continue;
    if (/Command:/.test(line) || line.includes('--org') || line.includes('--project')) continue;
    const cells = tableCells(line);
    if (nameIndex < 0) {
      const nameAt = cells.indexOf('Project Name');
      const idAt = cells.indexOf('Project ID');
      if (nameAt >= 0 && idAt >= 0) {
        nameIndex = nameAt;
        idIndex = idAt;
      }
      continue;
    }
    const id = cells[idIndex] ?? '';
    const name = cells[nameIndex] ?? '';
    if (!/^[0-9]+$/.test(id)) continue;
    rows.push({ name, id, active: name.includes(' (active)') });
  }
  return rows;
}

function tableCells(line: string): string[] {
  const parts = line.split('│');
  if (parts.length && parts[0].trim() === '') parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
  return parts.map((cell) => cell.trim());
}

/**
 * Abort unless GET /baas/v1/project/<id> returned this project and the
 * Development env_zgid (CATALYST-ORG). Both ids are compared as exact digit
 * strings. A number past Number.MAX_SAFE_INTEGER is refused: its digits are
 * already gone. Exact fields only — not a text search.
 */
export function assertProjectDetails(body: unknown, org: string, projectId: string): void {
  if (!/^[0-9]+$/.test(org) || !/^[0-9]+$/.test(projectId)) throw new Error(DETAILS_ERROR);
  const data = projectData(body);
  const id = scalarId(data.id) ?? scalarId(data.project_id);
  if (id !== projectId) throw new Error(DETAILS_ERROR);
  if (reportedOrg(data) !== org) throw new Error(DETAILS_ERROR);
}

function projectData(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') throw new Error(DETAILS_ERROR);
  const record = body as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return record;
}

function scalarId(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
  // Safe integers only. A rounded double must not compare equal to a 17-digit id.
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function reportedOrg(data: Record<string, unknown>): string | undefined {
  if ('env_details' in data || 'environments' in data) {
    const dev = developmentEnv(data.env_details ?? data.environments);
    if (!dev) return undefined;
    return scalarId(dev.env_zgid) ?? scalarId(dev.id);
  }
  return scalarId(data.org_id) ?? scalarId(data.env_zgid);
}

function developmentEnv(value: unknown): Record<string, unknown> | undefined {
  const envs = environments(value);
  return envs.find((env) => env.env_name === 'Development');
}

function environments(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (!item || typeof item !== 'object') return { env_name: key };
      const env = item as Record<string, unknown>;
      return typeof env.env_name === 'string' ? env : { ...env, env_name: key };
    });
  }
  return [];
}

/** Shape RC.load binds: projects[] plus defaults.project / defaults.env. Top-level project_id/org_id are not read. */
export function catalystRc(guard: Pick<GuardOk, 'org' | 'projectId' | 'projectName'>): {
  projects: { idx: number; id: string; name: string; env: { idx: number; id: string; name: string; type: number }[] }[];
  defaults: { project: number; env: number };
  actives: { project: number; env: number };
} {
  return {
    projects: [
      {
        idx: 1,
        id: guard.projectId,
        name: guard.projectName,
        env: [{ idx: 1, id: guard.org, name: 'Development', type: 1 }],
      },
    ],
    defaults: { project: 1, env: 1 },
    actives: { project: 1, env: 1 },
  };
}
