/**
 * The one place doctor and the gate resolve the target scope (DC, org, project).
 * Every caller goes through resolveScope(), so the precedence below lives in
 * one module.
 *
 * Precedence here: --dc/--org/--project flags → c2c-deploy.json
 * (`dc`|`zohoDc`, `org`, `apps.<link>.project` or `project`) → optional extra
 * candidates (e.g. a project registry file passed with --projects) → the Catalyst
 * CLI login's active_dc / active_org, read through the CLI's own config store — no token is read or
 * printed, only the two selector keys.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readRegularFile } from './read-file.js';
import { scrubCatalystEnv } from '../../deploy/src/scope.js';

export const DEPLOY_CONFIG = 'c2c-deploy.json';

/** Canonical DC keys (zcatalyst-cli DC_TYPE order). */
export const KNOWN_DCS = ['us', 'eu', 'in', 'au', 'ca', 'sa', 'jp', 'uae'] as const;
export type Dc = (typeof KNOWN_DCS)[number];

/** Spellings seen in c2c-deploy.json `zohoDc` and zcatalyst-cli `active_dc`. */
const DC_ALIASES: Readonly<Record<string, Dc>> = { com: 'us', 'com.au': 'au', ae: 'uae' };

/** zohomcp TLD → DC (D-B2/D-V1). `com` is US, `com.au` is AU, `ae` is UAE. */
export const TLD_TO_DC: Readonly<Record<string, Dc>> = {
  'com': 'us',
  'eu': 'eu',
  'in': 'in',
  'com.au': 'au',
  'ca': 'ca',
  'sa': 'sa',
  'jp': 'jp',
  'ae': 'uae',
};

export const DC_TO_TLD: Readonly<Record<Dc, string>> = {
  us: 'com',
  eu: 'eu',
  in: 'in',
  au: 'com.au',
  ca: 'ca',
  sa: 'sa',
  jp: 'jp',
  uae: 'ae',
};

/** Canonical DC key, or undefined for an unknown spelling. A missing value is undefined, never a throw. */
export function normalizeDc(value: string | undefined | null): Dc | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toLowerCase();
  if ((KNOWN_DCS as readonly string[]).includes(key)) return key as Dc;
  return DC_ALIASES[key];
}

/** The TLD a zohomcp host for this DC ends in (e.g. `in` → `in`, `au` → `com.au`). */
export function dcTld(value: string | undefined | null): string | undefined {
  const dc = normalizeDc(value);
  return dc ? DC_TO_TLD[dc] : undefined;
}

/** The DC a zohomcp host name belongs to, e.g. `catalystbyzoho.zohomcp.in` → `in`. */
export function dcOfMcpHost(host: string | undefined | null): Dc | undefined {
  if (typeof host !== 'string') return undefined;
  const match = /(^|\.)zohomcp\.([a-z.]+)$/i.exec(host.trim().toLowerCase());
  if (!match) return undefined;
  return TLD_TO_DC[match[2]];
}

/** `creator.zoho.<tld>` (or a bare DC key) → DC. */
export function dcOfCreatorHost(value: string | undefined | null): Dc | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toLowerCase();
  const direct = normalizeDc(key);
  if (direct) return direct;
  const match = /zoho(creator)?\.([a-z.]+)$/.exec(key.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  if (!match) return undefined;
  return TLD_TO_DC[match[2]];
}

export interface ScopeFlags {
  dc?: string;
  org?: string;
  project?: string;
  /** The UI the Slate app serves: --ui, else c2c-deploy.json `ui`, else react (vanilla is the fallback). */
  ui?: string;
  /** Creator app link name (also used to pick apps.<link>.project from config). */
  app?: string;
  /** Creator host or DC as stated by the user (`creator.zoho.<tld>` or a DC key). */
  creatorDc?: string;
  /** --config path. */
  config?: string;
}

export interface ScopeHooks {
  /** Last-resort readers of the Catalyst CLI's own store (active_dc / active_org only). */
  cliDc?: () => string | undefined;
  cliOrg?: () => string | undefined;
}

/** A last-resort reader that throws or answers non-string is an absent value, not a crash. */
function readHook(reader: (() => string | undefined) | undefined): string | undefined {
  try {
    return reader?.();
  } catch {
    return undefined;
  }
}

interface DeployConfig {
  dc?: string;
  org?: string;
  project?: string;
  env?: string;
  neverTouch: string[];
  creatorDc?: string;
  ui?: 'vanilla' | 'react';
}

/** A deploy config found by {@link findDeployConfig}: its path and the text of that one read. */
export interface FoundDeployConfig {
  path: string;
  text: string;
}

/**
 * Read `path` once as the deploy config: absent (ENOENT/ENOTDIR) is undefined,
 * a directory, FIFO or socket throws. No exists check runs before the read.
 */
function readConfigText(path: string): FoundDeployConfig | undefined {
  const read = readRegularFile(path);
  if (read.kind === 'missing') return undefined;
  if (read.kind === 'not-file') throw new Error(`${path} is not a file`);
  return { path, text: read.bytes.toString('utf8') };
}

/** `--config`, else c2c-deploy.json beside the export, else in the cwd. */
export function findDeployConfig(cwd: string, appPath: string | undefined, explicit: string | undefined): FoundDeployConfig | undefined {
  if (explicit !== undefined) {
    const found = readConfigText(explicit);
    if (!found) throw new Error(`--config ${explicit} does not exist`);
    return found;
  }
  if (appPath) {
    const st = statSync(appPath, { throwIfNoEntry: false });
    const beside = readConfigText(join(st?.isDirectory() ? appPath : dirname(appPath), DEPLOY_CONFIG));
    if (beside) return beside;
  }
  return readConfigText(join(cwd, DEPLOY_CONFIG));
}

function readDeployConfig({ path, text }: FoundDeployConfig): DeployConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  const record = parsed as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new Error(`${path} "${key}" is not a string`);
    return value.trim() || undefined;
  };
  const dc = pick('dc');
  const zohoDc = pick('zohoDc');
  if (dc && zohoDc && dc.toLowerCase() !== zohoDc.toLowerCase()) {
    throw new Error(`${path} sets "dc" ${dc} and "zohoDc" ${zohoDc}; they must agree`);
  }
  const org = pick('org');
  if (org !== undefined && !/^[0-9]+$/.test(org)) throw new Error(`${path} "org" is not a decimal id`);
  const env = pick('env');
  const neverTouch: string[] = [];
  const neverTouchRaw = record.never_touch;
  if (Array.isArray(neverTouchRaw)) {
    for (const item of neverTouchRaw) {
      if (typeof item !== 'string' || !/^[0-9]+$/.test(item.trim())) throw new Error(`${path} "never_touch" ids must be decimal strings`);
      neverTouch.push(item.trim());
    }
  } else if (neverTouchRaw && typeof neverTouchRaw === 'object') {
    for (const item of Object.values(neverTouchRaw as Record<string, unknown>)) {
      if (typeof item !== 'string' || !/^[0-9]+$/.test(item.trim().split(/\s+/)[0] ?? '')) {
        throw new Error(`${path} "never_touch" ids must be decimal strings`);
      }
      neverTouch.push((item as string).trim());
    }
  }
  const creatorDc = pick('creatorDc') ?? pick('creatorHost');
  const ui = pick('ui');
  if (ui !== undefined && ui !== 'vanilla' && ui !== 'react') throw new Error(`${path} "ui" must be "vanilla" or "react"`);
  return {
    ...(dc || zohoDc ? { dc: dc ?? zohoDc } : {}),
    ...(org ? { org } : {}),
    ...(env ? { env } : {}),
    neverTouch,
    ...(creatorDc ? { creatorDc } : {}),
    ...(ui ? { ui } : {}),
  };
}

/** `project` at top level or `apps.<link>.project` from c2c-deploy.json. */
function configProject(record: Record<string, unknown>, appLink: string | undefined, path: string): string | undefined {
  const top = record.project;
  if (top !== undefined && top !== null) {
    if (typeof top !== 'string' || !top.trim()) throw new Error(`${path} "project" is not a string`);
    return top.trim();
  }
  const apps = record.apps;
  if (appLink && apps && typeof apps === 'object' && !Array.isArray(apps)) {
    const entry = (apps as Record<string, unknown>)[appLink];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const project = (entry as Record<string, unknown>).project;
      if (project !== undefined && project !== null) {
        if (typeof project !== 'string' || !project.trim()) throw new Error(`${path} apps.${appLink}.project is not a string`);
        return project.trim();
      }
    }
  }
  return undefined;
}

export interface ResolvedScopeValues {
  dc?: string;
  dcSource?: string;
  org?: string;
  orgSource?: string;
  ui: 'vanilla' | 'react';
  uiSource?: string;
  project?: string;
  projectSource?: string;
  app?: string;
  env?: string;
  neverTouch: string[];
  creatorDc?: string;
  configPath?: string;
  /** The config `project` value can be a name; this is whatever was configured. */
}

/**
 * Resolve the run's scope. Flags win, then c2c-deploy.json, then `extra`
 * candidates (a project registry file, --projects), then the CLI login store. An unknown DC
 * spelling is an error, never silently IN. Nothing set leaves the field
 * undefined — the check that needs it reports the fix.
 */
export function resolveScope(input: {
  cwd: string;
  appPath?: string;
  flags: ScopeFlags;
  hooks?: ScopeHooks;
  /** Extra candidates after config, before the CLI store (e.g. the project registry dc/org). */
  extraDc?: { origin: string; value: string | undefined }[];
  extraOrg?: { origin: string; value: string | undefined }[];
  extraProject?: { origin: string; value: string | undefined }[];
}): ResolvedScopeValues {
  const found = findDeployConfig(input.cwd, input.appPath, input.flags.config);
  const config = found ? readDeployConfig(found) : undefined;
  const configPath = found?.path;
  let configProjectValue: string | undefined;
  if (found) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(found.text);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      configProjectValue = configProject(parsed as Record<string, unknown>, input.flags.app, found.path);
    }
  }

  const first = (items: ({ origin: string; value: string | undefined } | undefined)[]): { value: string; origin: string } | undefined => {
    for (const item of items) {
      if (!item || typeof item.value !== 'string' || item.value.trim() === '') continue;
      return { value: item.value.trim(), origin: item.origin };
    }
    return undefined;
  };

  const dcHit = first([
    { origin: '--dc', value: input.flags.dc },
    { origin: configPath ?? DEPLOY_CONFIG, value: config?.dc },
    ...(input.extraDc ?? []),
    { origin: 'catalyst CLI login (active_dc)', value: readHook(input.hooks?.cliDc) },
  ]);
  let dc: string | undefined;
  if (dcHit) {
    dc = normalizeDc(dcHit.value);
    if (!dc) throw new Error(`unknown data centre "${dcHit.value}" from ${dcHit.origin}; valid values: ${KNOWN_DCS.join(', ')}`);
  }

  const orgHit = first([
    { origin: '--org', value: input.flags.org },
    { origin: configPath ?? DEPLOY_CONFIG, value: config?.org },
    ...(input.extraOrg ?? []),
    { origin: 'catalyst CLI login (active_org)', value: readHook(input.hooks?.cliOrg) },
  ]);
  let org: string | undefined;
  if (orgHit) {
    const id = orgHit.value.trim().split(/\s+/)[0] ?? '';
    if (!/^[0-9]+$/.test(id)) throw new Error(`org "${orgHit.value}" from ${orgHit.origin} is not a decimal id`);
    org = id;
  }

  const projectHit = first([
    { origin: '--project', value: input.flags.project },
    { origin: configPath ?? DEPLOY_CONFIG, value: configProjectValue },
    ...(input.extraProject ?? []),
  ]);

  const creatorDc = input.flags.creatorDc ?? config?.creatorDc;
  const uiFlag = input.flags.ui?.trim();
  if (uiFlag !== undefined && uiFlag !== '' && uiFlag !== 'vanilla' && uiFlag !== 'react') {
    throw new Error('--ui must be vanilla or react');
  }
  const uiHit = first([
    { origin: '--ui', value: uiFlag },
    { origin: configPath ?? DEPLOY_CONFIG, value: config?.ui },
  ]);
  const ui = (uiHit?.value ?? 'react') as 'vanilla' | 'react';
  return {
    ...(dc ? { dc, dcSource: dcHit?.origin } : {}),
    ui,
    ...(uiHit ? { uiSource: uiHit.origin } : {}),
    ...(org ? { org, orgSource: orgHit?.origin } : {}),
    ...(projectHit ? { project: projectHit.value, projectSource: projectHit.origin } : {}),
    ...(input.flags.app ? { app: input.flags.app } : {}),
    ...(config?.env ? { env: config.env } : {}),
    neverTouch: config?.neverTouch ?? [],
    ...(creatorDc ? { creatorDc } : {}),
    ...(configPath ? { configPath } : {}),
  };
}

const ACTIVE_KEY_SCRIPT = `const path = require('path');
try {
  const store = require(path.join(process.env.C2C_CLI_LIB, 'util_modules', 'config-store.js')).default;
  const value = store.get(process.env.C2C_STORE_KEY);
  if (typeof value === 'string') process.stdout.write(value);
  else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) process.stdout.write(String(value));
} catch (err) {}
`;

/**
 * One selector key from the Catalyst CLI's own config store (`active_dc` or
 * `active_org`). Only that value leaves the child; no token is read or printed.
 * Undefined when the CLI is missing or never stored the key.
 */
function readCliStoreKey(env: NodeJS.ProcessEnv, key: 'active_dc' | 'active_org'): string | undefined {
  try {
    const which = spawnSync('/usr/bin/which', ['catalyst'], { env: scrubCatalystEnv(env), encoding: 'utf8', timeout: 5000 });
    const found = which.status === 0 ? (which.stdout ?? '').trim() : '';
    if (!found) return undefined;
    let dir = dirname(realpathSync(found));
    let lib: string | undefined;
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, 'internal'))) {
        lib = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!lib) return undefined;
    const result = spawnSync(process.execPath, ['-e', ACTIVE_KEY_SCRIPT], {
      env: { ...scrubCatalystEnv(env), C2C_CLI_LIB: lib, C2C_STORE_KEY: key },
      encoding: 'utf8',
      timeout: 15_000,
    });
    const value = result.status === 0 ? (result.stdout ?? '').trim() : '';
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Default last-resort hooks: the Catalyst CLI login's active_dc / active_org. */
export function cliStoreHooks(env: NodeJS.ProcessEnv): Required<ScopeHooks> {
  return {
    cliDc: () => readCliStoreKey(env, 'active_dc'),
    cliOrg: () => readCliStoreKey(env, 'active_org'),
  };
}
