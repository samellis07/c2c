/**
 * Which org and project a run writes to. First configured source wins.
 * A project name (not a decimal id) is resolved by listing the org; this
 * module only chooses the raw value. Nothing here creates a project.
 */
import { GuardError, ORG_HOW_TO_SET, PROJECT_HOW_TO_SET, catalystProjectName } from './guards.js';
import type { ProjectRegistry } from './registry.js';

export interface ResolvedOrg {
  org: string;
  origin: string;
}

export interface ProjectChoice {
  /** Decimal id, or a project name still to be listed. */
  raw: string;
  origin: string;
  /** True when raw was taken from the project registry map (--projects). */
  fromMap: boolean;
}

export function resolveOrgId(input: {
  flag?: string;
  configOrg?: string;
  configPath?: string;
  registryOrg?: string;
  registryPath?: string;
  cliOrg?: string;
}): ResolvedOrg {
  const candidates = [
    { origin: '--org', value: input.flag },
    { origin: input.configPath ?? 'c2c-deploy.json', value: input.configOrg },
    { origin: input.registryPath ?? 'project registry', value: input.registryOrg },
    { origin: 'catalyst CLI login (active_org)', value: input.cliOrg },
  ];
  for (const item of candidates) {
    if (item.value === undefined || item.value.trim() === '') continue;
    const id = item.value.trim();
    if (!/^[0-9]+$/.test(id)) {
      throw new GuardError('configuration', `org "${item.value}" from ${item.origin} is not a decimal id`);
    }
    return { org: id, origin: item.origin };
  }
  throw new GuardError('configuration', `org is not configured; ${ORG_HOW_TO_SET}`);
}

export function resolveProjectChoice(input: {
  flag?: string;
  configProject?: string;
  configPath?: string;
  appLink: string;
  registry: ProjectRegistry;
  registryPath?: string;
}): ProjectChoice {
  if (input.flag !== undefined && input.flag.trim() !== '') {
    return { raw: input.flag.trim(), origin: '--project', fromMap: false };
  }
  if (input.configProject !== undefined && input.configProject.trim() !== '') {
    return { raw: input.configProject.trim(), origin: input.configPath ?? 'c2c-deploy.json', fromMap: false };
  }
  const aliases = input.registry.aliases ?? {};
  const derived = catalystProjectName(input.appLink);
  const alias = aliases[input.appLink] ?? aliases[derived];
  const key = (alias ?? derived).trim().toLowerCase();
  const entry = Object.entries(input.registry.projects).find(([name]) => name.toLowerCase() === key);
  if (!entry) {
    throw new GuardError('configuration', `project is not configured; ${PROJECT_HOW_TO_SET}`);
  }
  const id = entry[1].trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9]+$/.test(id)) throw new GuardError('configuration', 'project registry project id is not a decimal id');
  return { raw: id, origin: input.registryPath ?? 'project registry', fromMap: true };
}

export function matchListedProject(
  projects: readonly { name: string; id: string }[],
  name: string,
): { name: string; id: string } | 'ambiguous' | undefined {
  const wanted = name.trim().toLowerCase();
  const hits = projects.filter((project) => project.name.trim().toLowerCase() === wanted && /^[0-9]+$/.test(project.id));
  if (hits.length > 1) return 'ambiguous';
  return hits[0];
}

/** Shown when a name is not in the org. Never a reason to create the project. */
export function missingProjectGuide(name: string, org: string, orgOrigin: string): string {
  return `project "${name}" was not found in org ${org} (from ${orgOrigin}). Guided step: create the project in the Catalyst console, then re-run with --project <id> or set "project" in c2c-deploy.json. c2c does not create projects.`;
}
