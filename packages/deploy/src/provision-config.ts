/**
 * Customer scope for `c2c provision`. One isolated module owns where the
 * DC, org and project id come from: `--dc/--org/--project` flags win, then the
 * customer's `c2c-deploy.json` in the working directory (`--config <file>`
 * overrides the path), then state learned from earlier read-backs (the project
 * id recorded by the `project` step, and the project id, org and data centre
 * the `import` step ran under). No bundled registry, no default org.
 *
 *   {
 *     "dc": "us",                       // or "zohoDc"; no default
 *     "org": "10000000000",
 *     "env": "Development",             // anything else is refused
 *     "apps": { "<app-link>": { "project": "<project-id>" } },
 *     "never_touch": ["77563..."],      // or a map of name → id; listed projects are refused
 *     "stuck_unusable": { "<name>": "<project-id>" }   // refused like never_touch
 *   }
 *
 * The project may be legitimately absent: the first plan step creates it.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { flag } from './cli.js';
import { assertProtectedProject } from './guards.js';
import { DC_TABLE, type DcResolution } from './offline-plan.js';

export interface DeployConfig {
  dc?: string;
  org?: string;
  env?: string;
  apps: Record<string, { project?: string }>;
  neverTouch: string[];
  /** never_touch and stuck_unusable as name → id maps (a list entry keys by its id), for the protected-project rule shared with deploy. */
  protectedProjects: { never_touch: Record<string, string>; stuck_unusable: Record<string, string> };
}

export interface ProvisionScope {
  /** undefined until a source provides it. */
  dc?: string;
  org?: string;
  projectId?: string;
  sources: { dc?: string; org?: string; projectId?: string };
  /** never_touch / stuck_unusable from c2c-deploy.json; absent means none. */
  protectedProjects?: DeployConfig['protectedProjects'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** `<cwd>/c2c-deploy.json` or `--config <file>`. Absent file → empty config; bad JSON → error. */
export function readDeployConfig(path: string): DeployConfig {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return { apps: {}, neverTouch: [], protectedProjects: { never_touch: {}, stuck_unusable: {} } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${path} must be a JSON object`);
  const config: DeployConfig = { apps: {}, neverTouch: [], protectedProjects: { never_touch: {}, stuck_unusable: {} } };
  if (typeof parsed.dc === 'string') config.dc = parsed.dc.trim().toLowerCase();
  else if (typeof parsed.zohoDc === 'string') config.dc = parsed.zohoDc.trim().toLowerCase();
  if (config.dc !== undefined && !(DC_TABLE as readonly string[]).includes(config.dc)) {
    throw new Error(`${path}: unknown data centre "${config.dc}" (want one of ${DC_TABLE.join(', ')})`);
  }
  if (parsed.org !== undefined) {
    const org = String(parsed.org).trim();
    if (!/^[0-9]{1,20}$/.test(org)) throw new Error(`${path}: org must be a decimal id`);
    config.org = org;
  }
  if (parsed.env !== undefined) {
    const env = String(parsed.env);
    if (env !== 'Development') throw new Error(`${path}: c2c only writes to Development projects ("env" is "${env}")`);
    config.env = env;
  }
  if (isRecord(parsed.apps)) {
    for (const [app, entry] of Object.entries(parsed.apps)) {
      if (!isRecord(entry)) throw new Error(`${path}: apps.${app} must be an object`);
      const project = entry.project;
      if (project !== undefined && !/^[0-9]+$/.test(String(project).trim())) {
        throw new Error(`${path}: apps.${app}.project must be a decimal id`);
      }
      config.apps[app] = project === undefined ? {} : { project: String(project).trim() };
    }
  }
  // never_touch and stuck_unusable share one rule, the one the protected-project
  // check applies: the entry's first token is the project id, anything after it
  // is a note. An entry with no decimal id is ambiguous — the config is refused
  // rather than silently protecting nothing.
  const protectedId = (value: unknown, label: string): string => {
    const text = String(value).trim();
    if (!/^[0-9]+$/.test(text.split(/\s+/)[0] ?? '')) throw new Error(`${path}: ${label} is not a decimal id`);
    return text;
  };
  const neverTouch = parsed.never_touch;
  if (Array.isArray(neverTouch)) {
    for (const [i, id] of neverTouch.entries()) {
      const text = protectedId(id, `never_touch[${i}]`);
      config.neverTouch.push(text);
      config.protectedProjects.never_touch[text] = text;
    }
  } else if (isRecord(neverTouch)) {
    for (const [name, id] of Object.entries(neverTouch)) {
      const text = protectedId(id, `never_touch.${name}`);
      config.neverTouch.push(text);
      config.protectedProjects.never_touch[name] = text;
    }
  } else if (neverTouch !== undefined) {
    throw new Error(`${path}: never_touch must be a list or a map of project ids`);
  }
  const stuck = parsed.stuck_unusable;
  if (Array.isArray(stuck)) {
    for (const [i, id] of stuck.entries()) {
      const text = protectedId(id, `stuck_unusable[${i}]`);
      config.protectedProjects.stuck_unusable[text] = text;
    }
  } else if (isRecord(stuck)) {
    for (const [name, id] of Object.entries(stuck)) config.protectedProjects.stuck_unusable[name] = protectedId(id, `stuck_unusable.${name}`);
  } else if (stuck !== undefined) {
    throw new Error(`${path}: stuck_unusable must be a list or a map of project ids`);
  }
  return config;
}

/**
 * Resolve dc/org/project for the plan's app. Flag > config > plan > learned.
 * `learnedProjectId` is the id the `project` step's read-back recorded;
 * `learnedOrg`/`learnedDc` are the org and data centre the `import` step ran
 * under, recorded in provision/state.json.
 */
export function resolveProvisionScope(opts: {
  args: readonly string[];
  cwd: string;
  app: string;
  planDc?: string;
  learnedProjectId?: unknown;
  learnedOrg?: unknown;
  learnedDc?: unknown;
}): ProvisionScope {
  const configPath = flag(opts.args, '--config') ?? join(opts.cwd, 'c2c-deploy.json');
  const config = readDeployConfig(configPath);
  const scope: ProvisionScope = { sources: {}, protectedProjects: config.protectedProjects };

  const dcFlag = flag(opts.args, '--dc');
  if (dcFlag !== undefined) {
    const dc = dcFlag.toLowerCase();
    if (!(DC_TABLE as readonly string[]).includes(dc)) {
      throw new Error(`unknown data centre "${dcFlag}" (want one of ${DC_TABLE.join(', ')})`);
    }
    scope.dc = dc;
    scope.sources.dc = '--dc';
  } else if (config.dc) {
    scope.dc = config.dc;
    scope.sources.dc = configPath;
  } else if (opts.planDc) {
    scope.dc = opts.planDc;
    scope.sources.dc = 'provision/plan.json';
  } else if (opts.learnedDc) {
    if (typeof opts.learnedDc !== 'string' || !(DC_TABLE as readonly string[]).includes(opts.learnedDc)) {
      throw new Error('the recorded data centre is not a known Catalyst DC');
    }
    scope.dc = opts.learnedDc;
    scope.sources.dc = 'provision/state.json (recorded import)';
  }
  if (scope.dc && opts.planDc && scope.dc !== opts.planDc) {
    throw new Error(`data centre mismatch: ${scope.sources.dc} says ${scope.dc}, the plan was made for ${opts.planDc}`);
  }

  const orgFlag = flag(opts.args, '--org');
  if (orgFlag !== undefined) {
    if (!/^[0-9]{1,20}$/.test(orgFlag)) throw new Error('--org must be a decimal id');
    scope.org = orgFlag;
    scope.sources.org = '--org';
  } else if (config.org) {
    scope.org = config.org;
    scope.sources.org = configPath;
  } else if (opts.learnedOrg != null) {
    if (typeof opts.learnedOrg !== 'string' || !/^[0-9]{1,20}$/.test(opts.learnedOrg)) {
      throw new Error('the recorded org is not a decimal id');
    }
    scope.org = opts.learnedOrg;
    scope.sources.org = 'provision/state.json (recorded import)';
  }

  const projectFlag = flag(opts.args, '--project');
  if (projectFlag !== undefined) {
    if (!/^[0-9]+$/.test(projectFlag)) throw new Error('--project must be a decimal id');
    scope.projectId = projectFlag;
    scope.sources.projectId = '--project';
  } else if (config.apps[opts.app]?.project) {
    scope.projectId = config.apps[opts.app]!.project;
    scope.sources.projectId = `${configPath} apps.${opts.app}.project`;
  } else if (opts.learnedProjectId != null && opts.learnedProjectId !== '') {
    if (typeof opts.learnedProjectId !== 'string' || !/^[0-9]+$/.test(opts.learnedProjectId)) {
      throw new Error('recorded project id is not a decimal id');
    }
    scope.projectId = opts.learnedProjectId;
    scope.sources.projectId = 'provision/state.json (recorded project read-back)';
  }
  if (scope.projectId) assertProtectedProject(config.protectedProjects, { id: scope.projectId });
  return scope;
}

export type { DcResolution };
