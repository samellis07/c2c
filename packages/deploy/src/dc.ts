/**
 * Which data centre a deploy, seed migrate, source-csv or smoke run uses.
 * Order: --dc, then c2c-deploy.json `dc` (or `zohoDc`), then the project registry (--projects) `dc`,
 * then the zcatalyst-cli login's `active_dc`. Nothing found is an error, never IN.
 * --catalyst-base still overrides the Catalyst API base once a DC is resolved.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDc, type DcCandidate, type ResolvedDc } from '../../core/src/dc.js';
import { parseJsonExact } from './json-exact.js';
import { resolveCatalyst } from './rest.js';
import { scrubCatalystEnv } from './scope.js';

export * from '../../core/src/dc.js';

/** Customer config file the deploy reads its DC from. Same file name as the runtime's functions/c2c-deploy.json. */
export const DEPLOY_CONFIG = 'c2c-deploy.json';

/** `--config <file>`, else c2c-deploy.json beside the export (the dir itself for a project dir), else in the cwd. */
export function findDeployConfig(target: string, explicit: string | undefined, cwd: string = process.cwd()): string | undefined {
  if (explicit !== undefined) {
    if (!existsSync(explicit)) throw new Error(`--config ${explicit} does not exist`);
    return explicit;
  }
  const st = statSync(target, { throwIfNoEntry: false });
  const beside = join(st?.isDirectory() ? target : dirname(target), DEPLOY_CONFIG);
  if (existsSync(beside)) return beside;
  const here = join(cwd, DEPLOY_CONFIG);
  return existsSync(here) ? here : undefined;
}

export interface DeployConfigFile {
  dc?: string;
  /** Decimal org id. */
  org?: string;
  /** Project id or project name. */
  project?: string;
  /** Test mail recipients for `--mail`. Omitted or empty means no test sends. */
  mail?: { testRecipients?: string[]; from?: string; verified?: boolean };
  /** Which UI the Slate app serves: react (default) or the vanilla tree as the fallback. */
  ui?: 'vanilla' | 'react';
}

/** `dc` / `zohoDc`, `org`, `project` and mail settings from a c2c-deploy.json. `dc` and `zohoDc` must agree. */
export function readDeployConfig(path: string): DeployConfigFile {
  let parsed: unknown;
  try {
    parsed = parseJsonExact(readFileSync(path, 'utf8'));
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
  const project = pick('project');
  const mail = readMailConfig(path, record.mail);
  const ui = pick('ui');
  if (ui !== undefined && ui !== 'vanilla' && ui !== 'react') throw new Error(`${path} "ui" must be "vanilla" or "react"`);
  return {
    ...(dc || zohoDc ? { dc: dc ?? zohoDc } : {}),
    ...(org ? { org } : {}),
    ...(project ? { project } : {}),
    ...(mail ? { mail } : {}),
    ...(ui ? { ui } : {}),
  };
}

/** Mail settings from a c2c-deploy.json. Recipients and sender addresses are validated; verification is an explicit boolean attestation. */
function readMailConfig(path: string, value: unknown): { testRecipients?: string[]; from?: string; verified?: boolean } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} "mail" is not an object`);
  }
  const record = value as Record<string, unknown>;
  const raw = record.testRecipients;
  const from = record.from;
  const verified = record.verified;
  if (from !== undefined && (typeof from !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from.trim()))) throw new Error(`${path} "mail.from" is not a mail address`);
  if (verified !== undefined && typeof verified !== 'boolean') throw new Error(`${path} "mail.verified" is not a boolean`);
  if (raw === undefined || raw === null) return { ...(typeof from === 'string' && from.trim() ? { from: from.trim() } : {}), ...(typeof verified === 'boolean' ? { verified } : {}) };
  if (!Array.isArray(raw)) throw new Error(`${path} "mail.testRecipients" is not an array`);
  const recipients = raw.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`${path} "mail.testRecipients" holds a non-string recipient`);
    const address = item.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      throw new Error(`${path} "mail.testRecipients" holds ${JSON.stringify(address)}, which is not a mail address`);
    }
    return address;
  });
  return { testRecipients: recipients, ...(typeof from === 'string' && from.trim() ? { from: from.trim() } : {}), ...(typeof verified === 'boolean' ? { verified } : {}) };
}

/** Test mail recipients from a c2c-deploy.json. Missing, unreadable or unset means nobody: no test sends. */
export function deployMailRecipients(configPath: string | undefined): readonly string[] {
  if (!configPath) return [];
  let config: DeployConfigFile;
  try {
    config = readDeployConfig(configPath);
  } catch {
    return [];
  }
  return config.mail?.testRecipients ?? [];
}

/** `dc` (or the runtime's `zohoDc`) from a c2c-deploy.json. Both set and different is refused. */
export function deployConfigDc(path: string): string | undefined {
  return readDeployConfig(path).dc;
}

const ACTIVE_DC_SCRIPT = `const path = require('path');
try {
  const store = require(path.join(process.env.C2C_CLI_LIB, 'util_modules', 'config-store.js')).default;
  const value = store.get('active_dc');
  if (typeof value === 'string') process.stdout.write(value);
} catch (err) {}
`;

/**
 * The DC the customer's Catalyst CLI is logged in to: only `active_dc` leaves the
 * CLI's own store reader; no token is read or printed. Undefined when the CLI is
 * missing or never chose a DC (the CLI's own fallback to US is not used).
 */
const ACTIVE_ORG_SCRIPT = `const path = require('path');
try {
  const store = require(path.join(process.env.C2C_CLI_LIB, 'util_modules', 'config-store.js')).default;
  const value = store.get('active_org');
  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) process.stdout.write(value.trim());
  else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) process.stdout.write(String(value));
} catch (err) {}
`;

/**
 * The org id in the Catalyst CLI config store, if the CLI stored one (`active_org`).
 * Only that id is written to stdout. The user profile and the credential are not read.
 * zcatalyst-cli 1.27.2 persists `active_dc` but not an org; an absent key is undefined.
 */
export function readCliActiveOrg(env: NodeJS.ProcessEnv): string | undefined {
  let lib: string;
  try {
    lib = resolveCatalyst(env).lib;
  } catch {
    return undefined;
  }
  const result = spawnSync(process.execPath, ['-e', ACTIVE_ORG_SCRIPT], {
    env: { ...scrubCatalystEnv(env), C2C_CLI_LIB: lib },
    encoding: 'utf8',
    timeout: 15_000,
  });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return /^[0-9]+$/.test(value) ? value : undefined;
}

export function readCliActiveDc(env: NodeJS.ProcessEnv): string | undefined {
  let lib: string;
  try {
    lib = resolveCatalyst(env).lib;
  } catch {
    return undefined;
  }
  const result = spawnSync(process.execPath, ['-e', ACTIVE_DC_SCRIPT], {
    env: { ...scrubCatalystEnv(env), C2C_CLI_LIB: lib },
    encoding: 'utf8',
    timeout: 15_000,
  });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return value || undefined;
}

export interface DeployDcInput {
  flag: string | undefined;
  configPath: string | undefined;
  registryDc: string | undefined;
  registryPath: string | undefined;
  /** Read lazily: only when nothing above names a DC. */
  cliDc: () => string | undefined;
}

export function resolveDeployDc(input: DeployDcInput): ResolvedDc {
  const configDc = input.configPath ? deployConfigDc(input.configPath) : undefined;
  const early: DcCandidate[] = [
    { source: 'flag', origin: '--dc', value: input.flag },
    { source: 'config', origin: input.configPath ?? DEPLOY_CONFIG, value: configDc },
    { source: 'registry', origin: input.registryPath ?? 'project registry', value: input.registryDc },
  ];
  if (early.some((item) => !!item.value?.trim())) return resolveDc(early);
  return resolveDc([{ source: 'catalyst-cli', origin: 'catalyst CLI login (active_dc)', value: input.cliDc() }]);
}
