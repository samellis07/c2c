/**
 * Hard guards for deploy, live seed migrate, and smoke.
 * A refusal happens before any network call. The credential directory is never read or printed.
 * The org and project are the ones the user configured. There is no bundled org.
 */
import { projectNameFor } from '../../schema/src/generator.js';
import type { ProjectRegistry } from './registry.js';
import { DC_HOW_TO_SET, KNOWN_DCS, parseDc } from './dc.js';

export const ALLOWED_ENV = 'Development';

export const ORG_HOW_TO_SET =
  'pass --org <id>, set "org" in c2c-deploy.json, set "org" in the project registry file (--projects), or log the Catalyst CLI in to that org';

export const PROJECT_HOW_TO_SET =
  'pass --project <id-or-name>, set "project" in c2c-deploy.json, or map the app in the project registry file (--projects)';

export type GuardCode =
  | 'deny-org'
  | 'org'
  | 'deny-project'
  | 'environment'
  | 'unknown-project'
  | 'name-mismatch'
  | 'configuration'
  | 'smoke-auth'
  | 'credential';

export class GuardError extends Error {
  readonly code: GuardCode;
  constructor(code: GuardCode, message: string) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
  }
}

export interface GuardInput {
  org: string;
  /** Where the org id came from (`--org`, a config path, the CLI login). */
  orgOrigin?: string;
  projectId: string;
  /** Where the project id or name came from. */
  projectOrigin?: string;
  /** Catalyst project name from a list, when the user gave a name rather than an id. */
  resolvedName?: string;
  /** Omitted means Development. Any other value is refused. */
  environment?: string;
  /** Creator application name. Matched to the c2c-<link> project key. */
  appLink: string;
  /** process.env.X_ZC_CREDENTIAL_PATH. Checked for presence only. */
  credentialPath: string | undefined;
  /** `smoke --in-browser` runs under the browser session: no Catalyst CLI credential is read. */
  credentialOptional?: boolean;
  registry?: ProjectRegistry;
  /** Where registry.dc came from (`--dc`, a c2c-deploy.json path, ...). Printed in plans and the deploy report. */
  dcOrigin?: string;
  /** Why the DC could not be resolved (unknown value, unreadable c2c-deploy.json, ...). */
  dcError?: string;
  /** A project name was resolved with one read-only GET /baas/v1/project. Printed in the plan. */
  nameLookup?: boolean;
}

export interface GuardOk {
  org: string;
  orgOrigin?: string;
  projectId: string;
  projectOrigin?: string;
  environment: typeof ALLOWED_ENV;
  projectName: string;
  /** Canonical DC key (us, eu, in, ...). Never defaulted. */
  dc: string;
  dcOrigin?: string;
  /** Set when resolving the project name performed one read-only GET /baas/v1/project. */
  nameLookup?: boolean;
  registry: ProjectRegistry;
}

/** `eu (from --dc)`: the DC a plan or report used and where it came from. */
export function dcLabel(guard: Pick<GuardOk, 'dc' | 'dcOrigin'>): string {
  return guard.dcOrigin ? `${guard.dc} (from ${guard.dcOrigin})` : guard.dc;
}

function fromOrigin(origin: string | undefined): string {
  return origin ? ` (from ${origin})` : '';
}

/** Plan lines that name the resolved org and project, and where each came from. */
export function planScopeLines(guard: {
  projectName: string;
  projectId: string;
  projectOrigin?: string;
  org: string;
  orgOrigin?: string;
  environment: string;
  dc: string;
  dcOrigin?: string;
  nameLookup?: boolean;
}): string[] {
  return [
    `project: ${guard.projectName} ${guard.projectId}${fromOrigin(guard.projectOrigin)}`,
    `project_id: ${guard.projectId}`,
    `org: ${guard.org}${fromOrigin(guard.orgOrigin)}`,
    `environment: ${guard.environment}`,
    `data_centre: ${dcLabel(guard)}`,
    ...(guard.nameLookup ? ['name lookup: one read-only GET /baas/v1/project'] : []),
  ];
}

/**
 * Checks a confirmed run enforces before it writes. A plan prints these and
 * does not apply them, so the review can happen before an org or a credential exists.
 */
export function confirmGuardLines(): string[] {
  return [
    'confirm enforces:',
    `- org is a decimal id; ${ORG_HOW_TO_SET}`,
    `- project is a decimal id or a project name; ${PROJECT_HOW_TO_SET}`,
    `- environment must be ${ALLOWED_ENV}`,
    '- the project is not on the denylist',
    '- the project is not stuck_unusable',
    '- the project id matches the app name',
    '- X_ZC_CREDENTIAL_PATH is set',
    `- data centre is configured; ${DC_HOW_TO_SET}`,
    '- a project name is resolved with one read-only GET /baas/v1/project',
  ];
}

/** Catalyst project key: schema sanitiser, then lower-case so it matches the project registry keys. */
export function catalystProjectName(link: string): string {
  return projectNameFor(link).toLowerCase();
}

export function checkGuards(input: GuardInput): GuardOk {
  const registry = input.registry ?? { org: '', env: ALLOWED_ENV, projects: {} };
  const org = input.org.trim();
  const projectId = input.projectId.trim();
  const environment = (input.environment ?? ALLOWED_ENV).trim();
  const appLink = input.appLink.trim();

  if (!/^[0-9]+$/.test(org)) {
    throw new GuardError('configuration', `org is not configured; ${ORG_HOW_TO_SET}`);
  }
  if (!/^[0-9]+$/.test(projectId)) {
    throw new GuardError('configuration', `project is not configured; ${PROJECT_HOW_TO_SET}`);
  }
  if (environment !== ALLOWED_ENV || (registry.env && registry.env !== ALLOWED_ENV)) {
    throw new GuardError('environment', `environment must be ${ALLOWED_ENV}`);
  }
  // A denylist or stuck project is refused before any alias or projects lookup can name it.
  assertProtectedProject(registry, { id: projectId, name: input.resolvedName });
  // Project registry aliases map an app link (or its c2c- key) to the project key the console created.
  const aliases = registry.aliases ?? {};
  const derived = catalystProjectName(appLink);
  const alias = aliases[appLink] ?? aliases[derived];
  const expected = alias ? alias.trim().toLowerCase() : derived;
  const keys = Object.entries(registry.projects)
    .filter(([, id]) => id === projectId)
    .map(([key]) => key);
  let projectName: string;
  if (keys.length) {
    const matched = keys.find((key) => key.toLowerCase() === expected);
    if (!matched) {
      throw new GuardError('name-mismatch', `project id does not match app name ${expected}`);
    }
    projectName = matched;
  } else if (input.resolvedName?.trim()) {
    projectName = input.resolvedName.trim();
  } else {
    // The id is your choice and is not in the optional map.
    projectName = derived;
  }
  const credential = input.credentialPath;
  if (!input.credentialOptional && (credential === undefined || credential.trim() === '')) {
    throw new GuardError('credential', 'X_ZC_CREDENTIAL_PATH is unset');
  }
  if (input.dcError) throw new GuardError('configuration', input.dcError);
  if (!registry.dc || !registry.dc.trim()) {
    throw new GuardError('configuration', `data centre is not configured; ${DC_HOW_TO_SET}. Valid values: ${KNOWN_DCS.join(', ')}`);
  }
  let dc: string;
  try {
    dc = parseDc(registry.dc);
  } catch (error) {
    throw new GuardError('configuration', error instanceof Error ? error.message : 'invalid data centre');
  }
  return {
    org,
    ...(input.orgOrigin ? { orgOrigin: input.orgOrigin } : {}),
    projectId,
    ...(input.projectOrigin ? { projectOrigin: input.projectOrigin } : {}),
    environment: ALLOWED_ENV,
    projectName,
    dc,
    ...(input.dcOrigin ? { dcOrigin: input.dcOrigin } : {}),
    ...(input.nameLookup ? { nameLookup: true } : {}),
    registry,
  };
}

/**
 * Refuse a project id or name on never_touch or stuck_unusable — the id rules
 * and the name rule together, so a caller with a name-or-id record cannot
 * reach a protected project through either side.
 */
export function assertProtectedProject(registry: Pick<ProjectRegistry, 'never_touch' | 'stuck_unusable'>, project: { id?: string; name?: string }): void {
  const id = project.id?.trim();
  if (id) {
    if (neverTouchIds(registry).has(id)) {
      throw new GuardError('deny-project', `refusing project ${id} (denylist)`);
    }
    if (registryIds(registry.stuck_unusable).has(id)) {
      throw new GuardError('deny-project', `refusing project ${id} (stuck_unusable)`);
    }
  }
  // A denylist key is the project name. Refuse it even when the stored id is stale or absent from the match.
  assertProtectedName(registry, project.name);
}

/**
 * Refuse a never_touch or stuck_unusable entry matched by name, ignoring case.
 * A decimal id is not a name. The stored id is not required to match.
 */
export function assertProtectedName(registry: Pick<ProjectRegistry, 'never_touch' | 'stuck_unusable'>, name: string | undefined): void {
  if (!name) return;
  const key = name.trim().toLowerCase();
  if (!key || /^[0-9]+$/.test(key)) return;
  if (namedIn(registry.never_touch, key)) {
    throw new GuardError('deny-project', `refusing project ${name.trim()} (denylist)`);
  }
  if (namedIn(registry.stuck_unusable, key)) {
    throw new GuardError('deny-project', `refusing project ${name.trim()} (stuck_unusable)`);
  }
}

function namedIn(map: Record<string, string> | undefined, key: string): boolean {
  return Object.keys(map ?? {}).some((entry) => entry.trim().toLowerCase() === key);
}

function neverTouchIds(registry: Pick<ProjectRegistry, 'never_touch'>): Set<string> {
  return registryIds(registry.never_touch);
}

function registryIds(map: Record<string, string> | undefined): Set<string> {
  const ids = new Set<string>();
  for (const value of Object.values(map ?? {})) {
    const id = value.trim().split(/\s+/)[0];
    if (id) ids.add(id);
  }
  return ids;
}
