/**
 * Argument handling for deploy, seed migrate, and smoke.
 * --confirm runs the guards before any spawn or fetch. A plan does not: it
 * prints the scope the user passed (or <org-id> and <project-id>) and the
 * checks --confirm will enforce. X_ZC_CREDENTIAL_PATH is never printed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { LockedExportError, parseFileWithSidecars, parseProject, widgetCommandStatus, type App } from '../../core/src/index.js';
import { seedCompositeMap } from '../../data/src/seed.js';
import { stratusRestSink } from '../../data/src/files.js';
import { emptyCheckpoint, type Checkpoint, type FetchLike, type MigrateResult } from '../../data/src/migrate.js';
import { emptyIntegrity, groupRefusals, integrityColumns, mandatoryMissingRefusals, type IntegrityReport } from '../../data/src/integrity.js';
import { applyConstraintDecisions, columnRenamesOf, generateSchema, type ConstraintDecision, type SchemaPlan } from '../../schema/src/generator.js';
import { FIDELITY_JSON, FIDELITY_MD, LOADER_REPORT, formatCsvPlan, hasReportJson, loaderColumns, migrateCsv, migrateLoaded, readSourceCsv, readSourceJson, type CsvLoad } from './csv.js';
import { readSourceBackup } from './backup.js';
import { ALLOWED_ENV, GuardError, assertProtectedName, assertProtectedProject, catalystProjectName, checkGuards, confirmGuardLines, planScopeLines, type GuardOk } from './guards.js';
import { parseJsonExact } from './json-exact.js';
import { applyAuthProvision, formatAuthProvision, slateUrlFrom } from './auth.js';
import { slateHost } from '../../auth/src/slate-host.js';
import { API_FUNCTION, FUNCTION_DIR, envVariables } from './function-dir.js';
import { buildDeploy, commandLine, deployFiles, migrateCatalystJson, writeDeployTree, type DeployCommand, type DeployFile, type DeployUi } from './plan.js';
import { asyncLaneBlocker } from './events.js';
import { humanChecklist } from './human-steps.js';
import { readConnectionSecretKeys } from './function-env.js';
import { CONSOLE_SERVICES, formatPostDeploySteps, postDeploySteps, servicesTouched, type ConsoleService, type PostDeployStep } from './post-deploy.js';
import { appTimeZone, generateUi, slateConfigSource } from '../../ui/src/generate.js';
import { emptyRegistry, type ProjectRegistry } from './registry.js';
import { catalystRestCall, listCatalystProjects, readCliAccessToken } from './rest.js';
import { importingAgeState, isStuckImporting, projectDataRecord, stuckImportGuidedStep, unknownImportAgeGuidedStep, type ListedProject } from './stuck-import.js';
import { spawnWithRetry, restWithRetry, type RetryOptions } from './retry.js';
import { readSlateAppUrl, slateConfigToml } from './slate.js';
import { applyEdits, editsPathFor, readEdits, withEdits } from './edit.js';
import { unsupportedSchemaOps } from './delta.js';
import { assertProjectDetails, assertReportedScope, catalystScopeArgs, scrubCatalystEnv } from './scope.js';
import { assertSeedReferences, assertSeedTables, foreignKeysForApp } from './remap.js';
import { formatMigratePlan, formatSkipped, migrateSeed, parseSeed, parseSeedBlocked, seedBucketName, seedFileColumns, seedStoreColumns, type SeedTable } from './seed.js';
import { ensureSeedBucket } from './stratus-bucket.js';
import { assertSmokeCookie, assertSmokeUrl, describeSmokeAuth, executeSmoke, formatSmokePlan, planSmoke, type SmokeAuth } from './smoke.js';
import { SMOKE_RESULT_MAX_AGE_MINUTES, verifySmokeResult } from './smoke-result.js';
import { formatCustomerSteps } from './customer-steps.js';
import { cdpBrowser, openOnOrigin, pageFetch, runBrowserSmoke, type BrowserSmokeResult, type SmokeBrowser } from './browser.js';
import { TablePlanError, applyTablePlan, formatMandatoryRelaxed, formatTableDiff, provisionedConstraints, type RestCall, type RestFn, type TableDiff } from './tables.js';
import { appShadowColumns, backfillShadows, formatBackfill } from './shadows.js';
import { checkGate, FIRST_USE_GATES, gateConsoleLine, requiredGates, type FirstUseGate } from './first-use.js';
import { DcNotConfiguredError, catalystBaseFor, dcEndpoints, deployMailRecipients, findDeployConfig, readCliActiveDc, readCliActiveOrg, readDeployConfig, resolveDeployDc, type DeployConfigFile } from './dc.js';
import { matchListedProject, missingProjectGuide, resolveOrgId, resolveProjectChoice } from './target.js';
import {
  formatInviteResult,
  inviteUsers,
  newUsersSalt,
  parseSocialList,
  readBackupUsers,
  readUsersState,
  userRefId,
  usersInvitesCsv,
  usersPlan,
  usersPlanJson,
  usersPlanMarkdown,
  writeUsersState,
  USERS_INVITES_CSV,
  USERS_PLAN_JSON,
  USERS_PLAN_MD,
  USERS_STATE_FILE,
  type InviteTarget,
} from './users.js';

/** Deploy report written into the deploy tree after a --confirm run. */
export const DEPLOY_REPORT = 'c2c-deploy-report.json';
export { FIDELITY_JSON, FIDELITY_MD, LOADER_REPORT, hasReportJson };

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The command was not re-run: a read-back already proved its effect. */
  skipped?: boolean;
}

export type SpawnFn = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<SpawnResult>;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  spawn: SpawnFn;
  fetch: FetchLike;
  /** Data Store admin REST. Tests inject this. Production uses the Catalyst CLI token. */
  rest?: RestFn;
  /** CLI bearer token. Tests inject this. Production reads it through the Catalyst CLI, not by opening the credential directory. */
  accessToken?: (env: NodeJS.ProcessEnv, org: string, projectId: string) => Promise<string>;
  /**
   * A newer access token for a read that met 401 INVALID_TOKEN, or undefined.
   * Defaults to re-reading the Catalyst CLI credential store without a refresh
   * (a forced CLI refresh only with C2C_ALLOW_LOCAL_REFRESH=1).
   */
  renewAccessToken?: (env: NodeJS.ProcessEnv, org: string) => Promise<string | undefined>;
  /** Waits between backfill pages and on a 429. Tests inject this. */
  sleep?: (ms: number) => Promise<void>;
  /** The Catalyst CLI login's active DC. Tests inject this. Production asks the CLI's own config store. */
  cliDc?: (env: NodeJS.ProcessEnv) => string | undefined;
  /** The Catalyst CLI login's active org id. Tests inject this. Production reads only `active_org`, never a token. */
  cliOrg?: (env: NodeJS.ProcessEnv) => string | undefined;
  /** Projects in the configured org. Tests inject this. Production lists them with one GET. */
  listProjects?: (org: string) => Promise<readonly ListedProject[]>;
  /** Reads stdin to the end (`smoke --result -`). Tests inject this. */
  stdin?: () => string;
}

export function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

/** The parsed export alone, without the edits log. */
export function loadSource(target: string): App {
  const st = statSync(target, { throwIfNoEntry: false });
  if (!st) throw new Error(`no such file or directory: ${target}`);
  return st.isDirectory() ? parseProject(target).ir : parseFileWithSidecars(target).ir;
}

/** The app model: the parsed export with its edits log (see edit.ts) replayed. */
export function loadApp(target: string): App {
  return withEdits(loadSource(target), target);
}

export function loadRegistry(path: string | undefined): ProjectRegistry {
  if (!path) return emptyRegistry();
  let parsed: unknown;
  try {
    parsed = parseJsonExact(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('the project registry (--projects) is not a project map');
  }
  return coerceRegistry(parsed);
}

interface GuardContext {
  registry: ProjectRegistry;
  registryPath?: string;
  configPath?: string;
  config?: DeployConfigFile;
  dcOrigin?: string;
  dcError?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripDc(registry: ProjectRegistry): ProjectRegistry {
  const { dc: _unused, ...rest } = registry;
  return rest;
}

/**
 * Registry, c2c-deploy.json, and the resolved DC. A missing or unknown DC is
 * reported by checkGuards. Org and project are resolved separately.
 */
function loadGuardContext(target: string, args: readonly string[], io: Io): GuardContext {
  if (args.includes('--dc') && flag(args, '--dc') === undefined) throw new GuardError('configuration', '--dc needs a value');
  if (args.includes('--config') && flag(args, '--config') === undefined) throw new GuardError('configuration', '--config needs a value');
  if (args.includes('--org') && flag(args, '--org') === undefined) throw new GuardError('configuration', '--org needs a value');
  if (args.includes('--project') && flag(args, '--project') === undefined) throw new GuardError('configuration', '--project needs a value');
  const registryPath = flag(args, '--projects');
  const registry = loadRegistry(registryPath);
  let configPath: string | undefined;
  let config: DeployConfigFile | undefined;
  try {
    configPath = findDeployConfig(target, flag(args, '--config'));
    config = configPath ? readDeployConfig(configPath) : undefined;
  } catch (error) {
    return { registry: stripDc(registry), registryPath, dcError: errorText(error) };
  }
  try {
    const resolved = resolveDeployDc({
      flag: flag(args, '--dc'),
      configPath,
      registryDc: registry.dc,
      registryPath,
      cliDc: () => (io.cliDc ?? readCliActiveDc)(io.env),
    });
    return { registry: { ...registry, dc: resolved.dc }, registryPath, configPath, config, dcOrigin: resolved.origin };
  } catch (error) {
    return { registry: stripDc(registry), registryPath, configPath, config, dcError: errorText(error) };
  }
}

/** Org, project and DC for one run. A project name is listed; a missing name is not created. */
export async function prepareGuard(target: string, args: readonly string[], appLink: string, io: Io, opts: { credentialOptional?: boolean } = {}): Promise<GuardOk> {
  const ctx = loadGuardContext(target, args, io);
  const orgFlag = flag(args, '--org');
  const registryOrg = ctx.registryPath && ctx.registry.org.trim() ? ctx.registry.org.trim() : undefined;
  const configOrg = ctx.config?.org;
  const cliOrg = !orgFlag?.trim() && !configOrg && !registryOrg ? (io.cliOrg ?? readCliActiveOrg)(io.env) : undefined;
  const org = resolveOrgId({
    flag: orgFlag,
    configOrg,
    configPath: ctx.configPath,
    registryOrg,
    registryPath: ctx.registryPath,
    cliOrg,
  });
  const choice = resolveProjectChoice({
    flag: flag(args, '--project'),
    configProject: ctx.config?.project,
    configPath: ctx.configPath,
    appLink,
    registry: ctx.registry,
    registryPath: ctx.registryPath,
  });
  if (choice.fromMap && registryOrg && registryOrg !== org.org) {
    throw new GuardError(
      'configuration',
      `project registry org is ${registryOrg} but the resolved org is ${org.org}; refusing a project id taken from that map`,
    );
  }
  // A denylist name is refused before the list, so a stale id cannot let the name through.
  assertProtectedName(ctx.registry, choice.raw);
  let projectId = choice.raw;
  let resolvedName: string | undefined;
  let nameLookup = false;
  if (!/^[0-9]+$/.test(projectId)) {
    const listed = io.listProjects ? await io.listProjects(org.org) : await listCatalystProjects(io.env, org.org);
    const found = matchListedProject(listed, projectId);
    if (found === 'ambiguous') {
      throw new GuardError('configuration', `project name "${projectId}" matches more than one project in org ${org.org}; pass --project <id>`);
    }
    if (!found) throw new GuardError('configuration', missingProjectGuide(projectId, org.org, org.origin));
    projectId = found.id;
    resolvedName = found.name;
    nameLookup = true;
  }
  return checkGuards({
    org: org.org,
    orgOrigin: org.origin,
    projectId,
    projectOrigin: choice.origin,
    resolvedName,
    ...(nameLookup ? { nameLookup: true } : {}),
    environment: flag(args, '--env'),
    appLink,
    credentialPath: credential(io.env),
    ...(opts.credentialOptional ? { credentialOptional: true } : {}),
    registry: ctx.registry,
    dcOrigin: ctx.dcOrigin,
    dcError: ctx.dcError,
  });
}

/**
 * Scope printed by a plan. --org and --project are copied as given. Anything
 * not passed is <org-id> or <project-id>. The data centre still comes from
 * --dc, c2c-deploy.json or the project registry (--projects) when one of those names it; the CLI
 * login is not read, and projects are not listed.
 */
export function planGuard(target: string, args: readonly string[], appLink: string): GuardOk {
  for (const name of ['--dc', '--config', '--org', '--project', '--projects']) {
    if (args.includes(name) && flag(args, name) === undefined) throw new GuardError('configuration', `${name} needs a value`);
  }
  const orgFlag = flag(args, '--org')?.trim();
  const projectFlag = flag(args, '--project')?.trim();
  const located = planDc(target, args);
  // Placeholders stand in for missing config, never for a project the registry
  // protects: a denylisted id or name is refused at plan time too.
  const registryPath = flag(args, '--projects');
  if (registryPath) {
    const registry = loadRegistry(registryPath);
    const configPath = findDeployConfig(target, flag(args, '--config'));
    let raw: string | undefined;
    try {
      raw = resolveProjectChoice({
        flag: projectFlag,
        configProject: configPath ? readDeployConfig(configPath).project : undefined,
        configPath,
        appLink,
        registry,
        registryPath,
      }).raw;
    } catch (error) {
      if (!(error instanceof GuardError)) throw error;
    }
    assertProtectedName(registry, raw);
    if (raw !== undefined && /^[0-9]+$/.test(raw)) assertProtectedProject(registry, { id: raw });
  }
  return {
    org: orgFlag || '<org-id>',
    ...(orgFlag ? { orgOrigin: '--org' } : {}),
    projectId: projectFlag || '<project-id>',
    ...(projectFlag ? { projectOrigin: '--project' } : {}),
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(appLink),
    dc: located?.dc ?? '<dc>',
    ...(located ? { dcOrigin: located.origin } : {}),
    registry: { org: '', env: ALLOWED_ENV, projects: {} },
  };
}

/** Local data centre for a plan. Never the CLI login, which reads the login store. */
function planDc(target: string, args: readonly string[]): { dc: string; origin: string } | undefined {
  const registryPath = flag(args, '--projects');
  const registryDc = registryPath ? loadRegistry(registryPath).dc : undefined;
  let configPath: string | undefined;
  try {
    configPath = findDeployConfig(target, flag(args, '--config'));
  } catch (error) {
    throw new GuardError('configuration', errorText(error));
  }
  try {
    const resolved = resolveDeployDc({
      flag: flag(args, '--dc'),
      configPath,
      registryDc,
      registryPath,
      cliDc: () => undefined,
    });
    return { dc: resolved.dc, origin: resolved.origin };
  } catch (error) {
    if (error instanceof DcNotConfiguredError) return undefined;
    throw new GuardError('configuration', errorText(error));
  }
}

function coerceRegistry(value: unknown): ProjectRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('the project registry (--projects) is not a project map');
  const record = value as Record<string, unknown>;
  const projects = idMap(record.projects, 'projects');
  if (!projects) throw new Error('the project registry (--projects) is not a project map');
  const org = decimalId(record.org, 'org');
  // dc is optional here: the DC can also come from --dc, c2c-deploy.json or the Catalyst CLI login.
  const dc = typeof record.dc === 'string' && record.dc.trim() ? record.dc : undefined;
  const env = typeof record.env === 'string' ? record.env : '';
  if (!env) throw new Error('the project registry (--projects) is not a project map');
  const neverTouch = record.never_touch === undefined ? undefined : idMap(record.never_touch, 'never_touch');
  const stuck = record.stuck_unusable === undefined ? undefined : idMap(record.stuck_unusable, 'stuck_unusable');
  if (record.never_touch !== undefined && !neverTouch) throw new Error('project registry never_touch is not a map');
  if (record.stuck_unusable !== undefined && !stuck) throw new Error('project registry stuck_unusable is not a map');
  return {
    org,
    ...(dc ? { dc } : {}),
    env,
    projects,
    ...(neverTouch ? { never_touch: neverTouch } : {}),
    ...(stuck ? { stuck_unusable: stuck } : {}),
    ...(record.aliases !== undefined ? { aliases: stringMap(record.aliases, 'aliases') } : {}),
  };
}

/** Ids stay decimal strings. A rounded number is refused, not coerced. */
function decimalId(value: unknown, label: string): string {
  if (typeof value === 'string') {
    const id = value.trim().split(/\s+/)[0] ?? '';
    if (!/^[0-9]+$/.test(id)) throw new Error(`project registry ${label} is not a decimal id`);
    return value.trim();
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error(`project registry ${label} is not a decimal id`);
}

function idMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`project registry ${label} is not a map`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = decimalId(item, `${label}.${key}`);
  return out;
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`project registry ${label} is not a map`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`project registry ${label}.${key} is not a string`);
    out[key] = item;
  }
  return out;
}

export function catalystSpawn(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function defaultIo(): Io {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(`${text.trimEnd()} [C2C-DEPLOY-001]\nSee plugin/references/error-index.md#c2c-deploy-001\n`),
    env: process.env,
    spawn: catalystSpawn,
    fetch: (url, init) => globalThis.fetch(url, init) as ReturnType<Io['fetch']>,
    // The org list (name/id/project_type/created_time only) — the held-name
    // check before an import POST and the name lookup both read it.
    listProjects: (org) => listCatalystProjects(process.env, org),
  };
}

/**
 * GET /baas/v1/project/<id> and refuse unless it is this org and project.
 * Every confirmed write calls this before the first row, table, function, cron, auth, or Slate call.
 */
export async function assertLiveProject(io: Io, org: string, projectId: string): Promise<RestFn> {
  const admin: RestFn = io.rest ?? ((call: RestCall) => catalystRestCall(io.env, org, projectId, call, { log: (line) => io.stderr(`${line}\n`) }));
  const details = await restWithRetry(admin, { method: 'GET', path: `/baas/v1/project/${projectId}` }, retryLog(io));
  if (details.result.status < 200 || details.result.status >= 300) {
    throw new Error('catalyst project details did not report the guarded org and project');
  }
  assertProjectDetails(details.result.body, org, projectId);
  assertNotImporting(details.result.body, projectId);
  return admin;
}

/**
 * An 'Importing' project takes no writes. One with known age past the bound
 * gets stuck guidance; unknown age gets neutral guidance. The delete is never retried.
 */
export function assertNotImporting(body: unknown, projectId: string): void {
  const data = projectDataRecord(body);
  const name = typeof data.project_name === 'string' ? data.project_name : undefined;
  const listed: ListedProject = {
    name: name ?? projectId,
    id: projectId,
    ...(typeof data.project_type === 'string' ? { projectType: data.project_type } : {}),
    ...(typeof data.created_time === 'string' ? { createdTime: data.created_time } : {}),
  };
  if (listed.projectType !== 'Importing') return;
  const ageState = importingAgeState(listed);
  if (isStuckImporting(listed)) throw new Error(stuckImportGuidedStep(listed));
  if (ageState === 'unknown') throw new Error(unknownImportAgeGuidedStep(listed));
  throw new Error(`project ${projectId} is still "Importing" — it cannot take writes until Catalyst finishes the import; re-run once the import completes`);
}

/** Retry scheduling for one run: printed lines, the injected clock when a test gives one. */
function retryLog(io: Io): RetryOptions {
  return { log: (line) => io.stdout(`${line}\n`), ...(io.sleep ? { sleep: io.sleep } : {}) };
}

export async function resolveScope(io: Io, org: string, projectId: string): Promise<{ org: string; projectId: string; token: string }> {
  const token = io.accessToken ? await io.accessToken(io.env, org, projectId) : await readCliAccessToken(io.env, org, projectId);
  if (!token) throw new Error('catalyst token was empty');
  return { org, projectId, token };
}

function credential(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.X_ZC_CREDENTIAL_PATH;
  return typeof value === 'string' ? value : undefined;
}

// CSI and OSC escape sequences, as a CLI prints them for colour and links.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** The exact message a fresh project answers `deploy slate` with until Slate is opened in the console once. */
const SLATE_SERVICE_CLOSED = /Please access the Slate service in your project's console before deploying via the CLI\./;

/**
 * Verify the console first-use gates a run needs before its first write: c2c
 * reads each gate's probe itself. An open answer continues; a closed or
 * unrecognised one prints the one-line checklist step and stops (false).
 */
async function verifyFirstUseGates(io: Io, rest: RestFn, guard: GuardOk, gates: readonly FirstUseGate[], rerun: string): Promise<boolean> {
  const where = { console: dcEndpoints(guard.dc).console, org: guard.org, project: guard.projectId };
  for (const gate of gates) {
    const check = await checkGate(rest, gate, guard.projectId, gateConsoleLine(gate, where));
    if (check.verdict === 'open') {
      io.stdout(`${check.message}\n`);
      continue;
    }
    io.stderr(`c2c: ${check.message}\n`);
    io.stderr(`c2c: nothing was written; after the console step ${rerun}\n`);
    return false;
  }
  return true;
}

function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('[credential]');
}

export function fail(io: Io, err: unknown): number {
  if (err instanceof GuardError) {
    io.stderr(`c2c: ${err.message}\n`);
    return 2;
  }
  // A locked Marketplace export is a usage-grade refusal, never a plan failure.
  if (err instanceof LockedExportError) {
    io.stderr(`c2c: ${err.message}\n`);
    return 2;
  }
  const message = err instanceof Error ? err.message : 'command failed';
  io.stderr(`c2c: ${message}\n`);
  return 1;
}

function targetOf(args: readonly string[]): { target?: string; rest: string[] } {
  if (!args.length || args[0].startsWith('--')) return { rest: [...args] };
  return { target: args[0], rest: args.slice(1) };
}

/** Resume state for one deploy dir. A step is skipped only when the bundle bytes are unchanged. */
export interface DeployState {
  version: 1;
  projectId: string;
  digest: string;
  done: string[];
  apiBase?: string;
  /** Slate app URL captured from slate:link/deploy output ("App Url:"), for the CORS authorised domain. */
  slateUrl?: string;
  /** Auth provisioning op ids applied or verified by an earlier run (resume skips them). */
  authDone?: string[];
  /** Catalyst user id returned by the first-admin invite; lets resume verify an unconfirmed user without resending. */
  authAdminUserId?: string;
  /** Console services earlier runs touched; they stay in the post-deploy steps until a run succeeds past them. */
  touched?: ConsoleService[];
  /** Delta sync checkpoint (c2c sync-delta). A deploy keeps it as it is. */
  delta?: unknown;
}

export const STATE_FILE = '.c2c-deploy-state.json';


/** sha256 over every written file except the runtime config the deploy itself rewrites. */
export function bundleDigest(files: readonly DeployFile[]): string {
  const hash = createHash('sha256');
  const sorted = [...files].filter((file) => file.path !== 'slate/c2c-config.js' && file.path !== 'web/public/c2c-config.js').sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.data);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readState(dir: string): DeployState | undefined {
  const path = join(dir, STATE_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as DeployState;
    return parsed && parsed.version === 1 && Array.isArray(parsed.done) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeState(dir: string, state: DeployState): void {
  const delta = state.delta ?? readStateDelta(join(dir, STATE_FILE));
  writeFileSync(join(dir, STATE_FILE), `${JSON.stringify(delta === undefined ? state : { ...state, delta }, null, 2)}\n`);
}

/** The delta checkpoint already in a state file, so a deploy never drops it. */
function readStateDelta(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { delta?: unknown }).delta;
  } catch {
    return undefined;
  }
}

/** sha256 over all source and configuration inputs to the React build in web/. */
export function webInputsDigest(webDir: string): string {
  const hash = createHash('sha256');
  const files: { path: string; data: Buffer }[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const full = join(dir, name);
      const st = statSync(full, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const rel = relative(webDir, full).split(sep).join('/');
        if (rel === 'public/c2c-config.js') continue;
        files.push({ path: rel, data: readFileSync(full) });
      }
    }
  };
  walk(webDir);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of files) {
    hash.update(f.path);
    hash.update('\0');
    hash.update(f.data);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function isWebDistCurrent(webDir: string): boolean {
  const dist = join(webDir, 'dist');
  if (!existsSync(join(dist, 'index.html'))) return false;
  const metaPath = join(dist, '.c2c-build.json');
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { inputDigest?: unknown };
      if (typeof meta.inputDigest === 'string') {
        return meta.inputDigest === webInputsDigest(webDir);
      }
    } catch {
      return false;
    }
  }
  return false;
}

export function recordWebDistBuild(webDir: string): void {
  const dist = join(webDir, 'dist');
  if (!existsSync(dist)) return;
  const inputDigest = webInputsDigest(webDir);
  writeFileSync(join(dist, '.c2c-build.json'), `${JSON.stringify({ inputDigest }, null, 2)}\n`);
}

/**
 * The first c2c-deploy-report.json found beside the target (the dir for a
 * project dir) or in the cwd. It is the binding `smoke --in-browser --url`
 * and `smoke --owner-session --url` are checked against; a report that
 * carries neither slate.appUrl nor functions.apiBase is a refusal — it
 * cannot silently unbind the check.
 */
function readDeployReport(target: string): { path: string; report: Record<string, unknown> } | undefined {
  const beside = statSync(target, { throwIfNoEntry: false })?.isDirectory() ? target : dirname(target);
  for (const dir of [beside, process.cwd()]) {
    const path = join(dir, DEPLOY_REPORT);
    if (!existsSync(path)) continue;
    let report: unknown;
    try {
      report = parseJsonExact(readFileSync(path, 'utf8'));
    } catch {
      throw new Error(`${path} is not valid JSON`);
    }
    return { path, report: report && typeof report === 'object' && !Array.isArray(report) ? (report as Record<string, unknown>) : {} };
  }
  return undefined;
}

/** slate.appUrl from a found deploy report — a URL, or undefined when the report does not carry one. */
function reportAppUrl(found: { path: string; report: Record<string, unknown> }): string | undefined {
  const slate = found.report.slate;
  const appUrl = slate && typeof slate === 'object' ? (slate as { appUrl?: unknown }).appUrl : undefined;
  if (appUrl === undefined || appUrl === null) return undefined;
  try {
    if (typeof appUrl !== 'string' || !appUrl.trim() || !/^https?:$/.test(new URL(appUrl.trim()).protocol)) throw new Error('not a URL');
  } catch {
    throw new Error(`${found.path} slate.appUrl is not a URL`);
  }
  return appUrl.trim();
}

/**
 * slate.appUrl and the project id a found deploy report binds to. A report
 * without slate.appUrl is a refusal, not an unbinding — it cannot bind --url
 * or a --result block.
 */
function deployReportBinding(target: string): { appUrl: string; projectId?: string } | undefined {
  const found = readDeployReport(target);
  if (!found) return undefined;
  const appUrl = reportAppUrl(found);
  if (appUrl === undefined) {
    throw new GuardError('smoke-auth', `${found.path} carries no slate.appUrl — a deploy report cannot bind --url`);
  }
  const projectId = found.report.projectId;
  return { appUrl, ...(typeof projectId === 'string' && /^[0-9]{1,24}$/.test(projectId) ? { projectId } : {}) };
}

/** The app URL the deploy itself reported. */
function deployReportAppUrl(target: string): string | undefined {
  return deployReportBinding(target)?.appUrl;
}

/**
 * The origin the deploy report binds a function --url to: functions.apiBase
 * when the deploy wrote one; a relative apiBase (or none) is served on the
 * app's own domain, so slate.appUrl is the origin then. A report carrying
 * neither cannot bind --url at all.
 */
function deployReportFunctionOrigin(target: string): { origin: string; label: string } | undefined {
  const found = readDeployReport(target);
  if (!found) return undefined;
  const functions = found.report.functions;
  const apiBase = functions && typeof functions === 'object' ? (functions as { apiBase?: unknown }).apiBase : undefined;
  if (typeof apiBase === 'string' && apiBase.trim() && !apiBase.trim().startsWith('/')) {
    try {
      const url = new URL(apiBase.trim());
      if (!/^https?:$/.test(url.protocol)) throw new Error('not a URL');
      return { origin: url.origin, label: 'functions.apiBase' };
    } catch {
      throw new Error(`${found.path} functions.apiBase is not a URL`);
    }
  }
  if (apiBase !== undefined && apiBase !== null && typeof apiBase !== 'string') throw new Error(`${found.path} functions.apiBase is not a URL`);
  const appUrl = reportAppUrl(found);
  if (appUrl) return { origin: new URL(appUrl).origin, label: 'slate.appUrl' };
  throw new GuardError('smoke-auth', `${found.path} carries no functions.apiBase or slate.appUrl — a deploy report cannot bind --url`);
}

/** The function URL the catalyst CLI prints after a functions deploy, as the client's API base. */
export function functionBaseFrom(output: string): string | undefined {
  const match = new RegExp(`https://[^\\s"'<>]+/server/${API_FUNCTION}(?=[/\\s"'<>]|$)`).exec(output);
  return match?.[0];
}

/**
 * --function-env: the c2c_api function's current console environment, which `catalyst deploy`
 * would otherwise replace with catalyst-config.json env_variables. A JSON object of strings,
 * kept outside the repo (values may be secrets; only key names are ever printed).
 * "new" states a first deploy with nothing to keep. A confirmed deploy needs one or the other.
 */
export function readFunctionEnv(value: string | undefined, confirm: boolean): Record<string, string> | undefined {
  if (value === undefined) {
    if (!confirm) return undefined;
    throw new Error(
      `--confirm needs --function-env <file> (the ${API_FUNCTION} console environment as a JSON object; catalyst deploy replaces it with catalyst-config.json env_variables) or --function-env new for a first deploy`,
    );
  }
  if (value === 'new') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(value, 'utf8'));
  } catch {
    throw new Error('--function-env must be a readable JSON file');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--function-env must hold a JSON object of name -> string');
  const env = parsed as Record<string, unknown>;
  for (const key of Object.keys(env)) {
    if (typeof env[key] !== 'string') throw new Error(`--function-env: ${key} must be a string`);
  }
  // Validates the names the same way the bundle does, before anything is written.
  envVariables('dry-run', env as Record<string, string>);
  return env as Record<string, string>;
}

export async function deployCli(args: readonly string[], io: Io): Promise<number> {
  const { target, rest } = targetOf(args);
  if (!target) {
    io.stderr(
      'usage: c2c deploy <file|dir> [--project <id-or-name>] [--org <id>] [--env Development] [--out <dir>] [--ui vanilla|react] [--mail [--mail-from <address> --mail-sender-verified]] [--confirm] [--resume] [--api-base <url>] [--function-env <file>|new] [--slate-domain <host>] [--admin-email <mail> --admin-name <name> --admin-role <name> --admin-role-id <id>] [--async-on-success [--triggers-wired]] [--subset-shims] [--source-backup <zip|dir>|--source-csv <dir>|--source-json <dir>] [--projects <file>] [--dc <dc>] [--config <c2c-deploy.json>] [--edits <file>]\n' +
        '       c2c deploy <file|dir> --backfill-shadows [--confirm] [--catalyst-base <url>] [--projects <file>] [--dc <dc>] [--config <c2c-deploy.json>]\n' +
        '       --source-* measures the Creator data so is_mandatory/is_unique are provisioned only where the records allow it\n' +
        '       org: --org, else c2c-deploy.json, else the project registry (--projects), else the Catalyst CLI login (active_org)\n' +
        '       project: --project, else c2c-deploy.json, else the project registry map (--projects)\n',
    );
    return 2;
  }
  try {
    const source = loadSource(target);
    const log = readEdits(flag(rest, '--edits') ?? editsPathFor(target));
    const edited = applyEdits(source, log.edits);
    const app = edited.app;
    const appLink = app.name?.trim();
    if (!appLink) throw new GuardError('name-mismatch', 'application name is missing');
    // The table step creates missing tables and columns; it cannot rename,
    // alter, or drop. Refuse those edits before any guard, spawn, fetch, or
    // file write so the model and the store cannot drift apart.
    if (log.edits.length > 0) {
      const blocked = unsupportedSchemaOps(generateSchema(source), generateSchema(app), edited.renames);
      if (blocked.length > 0) {
        io.stderr(`c2c deploy: the edits log changes Data Store in a way the live deploy cannot apply; nothing was changed\n${blocked.map((b) => `- ${b}`).join('\n')}`);
        return 1;
      }
    }
    const confirm = rest.includes('--confirm');
    const guard = confirm ? await prepareGuard(target, rest, appLink, io) : planGuard(target, rest, appLink);
    for (const name of ['--source-backup', '--source-csv', '--source-json']) {
      if (rest.includes(name) && flag(rest, name) === undefined) throw new Error(`${name} needs a path`);
    }
    const srcBackup = flag(rest, '--source-backup');
    const srcCsv = flag(rest, '--source-csv');
    const srcJson = flag(rest, '--source-json');
    const named = [srcBackup, srcCsv, srcJson].filter((value) => value !== undefined).length;
    if (named > 1) throw new Error('pass at most one of --source-backup, --source-csv, or --source-json');
    if (rest.includes('--backfill-shadows')) {
      if (named) throw new Error('--backfill-shadows does not take a data source');
      return await backfillCli(app, guard, rest, confirm, io);
    }
    const allowEmpty = rest.includes('--allow-empty');
    const deploySource: CsvLoad | undefined =
      srcBackup !== undefined
        ? readSourceBackup(srcBackup, app, allowEmpty)
        : srcCsv !== undefined
          ? hasReportJson(srcCsv, app)
            ? readSourceJson(srcCsv, app, allowEmpty)
            : readSourceCsv(srcCsv, app, allowEmpty)
          : srcJson !== undefined
            ? readSourceJson(srcJson, app, allowEmpty)
            : undefined;
    const resume = rest.includes('--resume');
    let out = flag(rest, '--out');
    if (resume && (!confirm || !out)) throw new Error('--resume needs --confirm and the --out dir of the earlier run');
    // The state file is read whenever it exists — auth ops are idempotent on a
    // plain re-run too, not only under --resume.
    const previous = out ? readState(out) : undefined;
    if (previous && previous.projectId !== guard.projectId) throw new Error('--out holds a deploy for another project');
    const apiBaseFlag = flag(rest, '--api-base');
    if (apiBaseFlag !== undefined && !/^(https:\/\/[^\s]+|\/server\/[A-Za-z0-9_-]+)$/.test(apiBaseFlag)) {
      throw new Error('--api-base must be an https URL or /server/<function>');
    }
    const slateDomainFlag = flag(rest, '--slate-domain');
    if (slateDomainFlag !== undefined && !slateHost(slateDomainFlag)) throw new Error('--slate-domain must be a Slate app host — a bare hostname or the https App Url slate:link prints');
    const adminEmail = flag(rest, '--admin-email');
    if (adminEmail !== undefined && !/^\S+@\S+$/.test(adminEmail)) throw new Error('--admin-email is not an email');
    // The first admin's role is pinned: the invite always names App
    // Administrator (exact-name match on API data), so no flag can widen it.
    const adminRole = flag(rest, '--admin-role');
    if (adminRole !== undefined && adminRole !== 'App Administrator') {
      throw new Error('--admin-role is pinned: the first admin is always invited as App Administrator');
    }
    const adminRoleId = flag(rest, '--admin-role-id');
    if (adminRoleId !== undefined && !/^[0-9]+$/.test(adminRoleId)) throw new Error('--admin-role-id takes the decimal role id (digits only)');
    const admin =
      adminEmail === undefined
        ? undefined
        : {
            email: adminEmail,
            ...(flag(rest, '--admin-name') !== undefined ? { name: flag(rest, '--admin-name') as string } : {}),
            ...(adminRoleId !== undefined ? { roleId: adminRoleId } : {}),
          };
    let apiBase = apiBaseFlag ?? previous?.apiBase;
    const functionEnv = readFunctionEnv(flag(rest, '--function-env'), confirm);
    const slateDomain = slateHost(slateDomainFlag ?? previous?.slateUrl);
    // The UI the Slate app serves: --ui, else c2c-deploy.json `ui`, else react.
    // The flag wins so a scripted run can override a pinned config without editing it.
    // --ui vanilla keeps the previous target as the fallback.
    const uiFlag = flag(rest, '--ui');
    if (uiFlag !== undefined && uiFlag !== 'vanilla' && uiFlag !== 'react') throw new Error('--ui must be vanilla or react');
    const uiConfigPath = findDeployConfig(target, flag(rest, '--config'));
    const ui: DeployUi = uiFlag ?? (uiConfigPath ? readDeployConfig(uiConfigPath).ui : undefined) ?? 'react';
    const subsetShims = rest.includes('--subset-shims') || io.env.C2C_SUBSET_SHIMS === '1';
    const bundle = buildDeploy(app, guard, rest.includes('--mail'), confirm, apiBase, functionEnv, {
      from: flag(rest, '--mail-from'),
      verified: rest.includes('--mail-sender-verified'),
    }, {
      ...(slateDomain ? { slateDomain } : {}),
      ...(admin ? { admin } : {}),
    }, deployMailRecipients(findDeployConfig(target, flag(rest, '--config'))), deploySource?.sourceData, ui, rest.includes('--async-on-success'), subsetShims);
    const mailBlockers = bundle.mailFindings.filter((finding) => finding.severity === 'blocker');
    if (confirm && mailBlockers.length) {
      for (const finding of mailBlockers) io.stderr(`blocker ${finding.check}: ${finding.message}. ${finding.fix} ${finding.see}\n`);
      return 1;
    }
    // Deploy-time trigger gate: the record trigger is project configuration
    // the deploy does not create. The printed plan carries the warning; a
    // confirmed deploy refuses without the explicit opt-in.
    const triggerBlocker = asyncLaneBlocker(bundle.usesEvents, rest.includes('--triggers-wired'));
    if (triggerBlocker) {
      if (confirm) {
        io.stderr(`blocker event-async-triggers: ${triggerBlocker}\n`);
        return 1;
      }
      io.stderr(`warning event-async-triggers: ${triggerBlocker}\n`);
    }
    if (confirm && !out) out = mkdtempSync(join(tmpdir(), 'c2c-deploy-'));
    const digest = bundleDigest(bundle.files);
    // Command skipping is still a --resume feature; a plain --confirm re-runs
    // the deploy commands but still honours persisted auth ops and the Slate URL.
    const same = !!previous && previous.digest === digest;
    const resumeCommands = resume && same;
    let migratedSlate = false;
    if (out) {
      const keepCatalystJson = same && existsSync(join(out, 'catalyst.json'));
      let existingSlate: unknown;
      if (existsSync(join(out, 'catalyst.json'))) {
        try { existingSlate = JSON.parse(readFileSync(join(out, 'catalyst.json'), 'utf8')).slate; } catch { /* regenerate */ }
      }
      if (keepCatalystJson && migrateCatalystJson(out)) {
        migratedSlate = true;
        io.stdout('migrated catalyst.json: slate is now an array\n');
      }
      const files = bundle.files.map((file) => {
        if (file.path !== 'catalyst.json' || !Array.isArray(existingSlate)) return file;
        const parsed = JSON.parse(String(file.data)) as Record<string, unknown>;
        parsed.slate = existingSlate;
        return { ...file, data: `${JSON.stringify(parsed, null, 2)}\n` };
      });
      writeDeployTree(out, keepCatalystJson ? files.filter((file) => file.path !== 'catalyst.json') : files);
    }
    const secret = credential(io.env);
    io.stdout(redact(bundle.plan, secret));
    if (out) io.stdout(`out: ${out}\n`);
    if (!confirm) return widgetCommandStatus(app.widgets);
    if (previous && !same) io.stdout('resume: the generated bundle changed since the last run; every step runs again\n');
    // Auth ops and the Slate URL are independent of the bundle digest — a provisioned
    // auth op stays provisioned even when the bundle changed, so they carry on any resume.
    // Command skipping stays a --resume feature. An object-shaped slate means the
    // earlier slate:link died inside the CLI, so migration re-arms those two steps.
    const carried = resumeCommands && previous
      ? previous.done.filter((id) => !(migratedSlate && (id === 'slate-link' || id === 'slate')))
      : [];
    const state: DeployState = {
      version: 1,
      projectId: guard.projectId,
      digest,
      done: [...carried],
      ...(apiBase ? { apiBase } : {}),
      ...(previous?.authDone ? { authDone: [...previous.authDone] } : {}),
      ...(previous?.authAdminUserId ? { authAdminUserId: previous.authAdminUserId } : {}),
      ...(previous?.slateUrl ? { slateUrl: previous.slateUrl } : {}),
      ...(previous?.touched ? { touched: [...previous.touched] } : {}),
    };
    const cwd = out as string;
    writeState(cwd, state);
    const retry = retryLog(io);
    const childEnv = scrubCatalystEnv(io.env);
    const probe = await spawnWithRetry(
      () => io.spawn('catalyst', [...catalystScopeArgs(guard.org, guard.projectId), 'project:list'], { cwd, env: childEnv }),
      'catalyst project:list',
      retry,
    );
    if (probe.code !== 0) throw new Error('catalyst project:list did not report the guarded org and project');
    assertReportedScope(`${probe.stdout}\n${probe.stderr}`, guard.projectId, guard.projectId);
    const restFn = await assertLiveProject(io, guard.org, guard.projectId);
    const { planSignals } = await import('./offline-plan.js');
    const signals = planSignals(app);
    const gates = requiredGates({
      client: bundle.commands.some((command) => command.id === 'slate' && !state.done.includes(command.id)),
      files: signals.files.length > 0,
      pdf: signals.pdf,
    });
    if (!(await verifyFirstUseGates(io, restFn, guard, gates, `re-run this command with --resume --out ${cwd}`))) return 1;
    // When the CLI output has no "App Url:" the Slate API is the URL source:
    // the app list and its deployment report the served domain. The result is
    // persisted so a resumed run and the CORS step can use it.
    let slateListed = false;
    let slateSeen = false;
    let slateNotePrinted: string | undefined;
    const readBackSlate = async (): Promise<void> => {
      if (state.slateUrl) {
        slateListed = true;
        slateSeen = true;
        return;
      }
      try {
        const found = await readSlateAppUrl(restFn, guard.projectId, guard.projectName, retry);
        slateListed = found.listed;
        slateSeen = slateSeen || found.apps.length > 0;
        if (found.url) {
          state.slateUrl = found.url;
          writeState(cwd, state);
          io.stdout(`slate url (from the Slate API): ${found.url}\n`);
        } else if (found.note && found.note !== slateNotePrinted) {
          slateNotePrinted = found.note;
          io.stdout(`${found.note}\n`);
        }
      } catch {
        slateListed = false;
        /* a refused or failed read stays a console step */
      }
    };
    // The table plan is a diff against what exists, so a resumed run re-checks it and creates only what is missing.
    // A table failure still writes the report and the post-deploy steps for what was created.
    let diff: TableDiff;
    let tableError: string | undefined;
    try {
      diff = await applyTablePlan(guard.projectId, bundle.tableSteps, restFn, retry);
    } catch (err) {
      if (!(err instanceof TablePlanError)) throw err;
      diff = err.diff;
      tableError = redact(err.message, secret);
    }
    io.stdout(redact(formatTableDiff(diff), secret));
    const ran: DeployCommand[] = [];
    let slateUrl: string | undefined;
    let slateNotice: string | undefined;
    // Services an earlier run touched (a resume skips their commands) still need the console steps.
    const earlier = (previous?.touched ?? []).filter((service): service is ConsoleService => (CONSOLE_SERVICES as readonly string[]).includes(service));
    // The console configure steps must print even when a later command fails.
    // Auth provisioning runs on the failure path too: the ops are independent, and
    // a Slate deploy that exits non-zero can still have served the app.
    const finish = async (code: number): Promise<number> => {
      const done = bundle.commands.filter((command) => state.done.includes(command.id));
      const services = servicesTouched({ createdTables: diff.createdTables, createdColumns: diff.createdColumns, commands: done, extra: earlier, auth: true });
      // A completed Slate command proves the service was opened in the
      // console (a fresh project refuses the Slate deploy until it is), so
      // the end-of-run checklist drops the Slate start item.
      const slateStarted = done.some((command) => command.id === 'slate-link' || command.id === 'slate');
      // A run that captured no "App Url:" — including a resumed run that skipped
      // the slate commands — reads the URL from the Slate API before CORS needs it.
      if (!state.slateUrl && !slateHost(slateDomainFlag)) await readBackSlate();
      // An auth failure follows the normal failure path: the report is still
      // written and the run exits non-zero — it never escapes to fail().
      let auth: Awaited<ReturnType<typeof applyAuthProvision>>;
      let authThrew = false;
      try {
        auth = await applyAuthProvision(restFn, {
          projectId: guard.projectId,
          retry,
          ...(slateHost(slateDomainFlag ?? state.slateUrl) ? { slateDomain: slateHost(slateDomainFlag ?? state.slateUrl) } : {}),
          ...(admin ? { admin } : {}),
          done: state.authDone ?? [],
          ...(state.authAdminUserId ? { adminUserId: state.authAdminUserId } : {}),
          // Persist the invite user id immediately — a kill after POST /project-user must not cause a duplicate invite.
          persistAdminUserId: (userId) => {
            state.authAdminUserId = userId;
            writeState(cwd, state);
          },
          // Persist after every op — a kill mid-run resumes only the ops that never landed.
          persistDone: (ids) => {
            state.authDone = ids;
            writeState(cwd, state);
          },
        });
      } catch (err) {
        authThrew = true;
        const message = redact(err instanceof Error ? err.message : 'auth provisioning failed', secret);
        auth = {
          results: [],
          done: state.authDone ?? [],
          consoleSteps: [`Authentication provisioning stopped early: ${message} — completed ops were persisted; re-run deploy --confirm to finish.`],
        };
      }
      state.authDone = auth.done;
      if (auth.adminUserId) state.authAdminUserId = auth.adminUserId;
      const steps = postDeploySteps(guard.projectId, services, { resume: code !== 0, shadowsOnExistingRows: diff.shadowsOnExistingRows, org: guard.org });
      // Auth console steps sit before the trailing resume step — "then re-run" stays last.
      const authSteps: PostDeployStep[] = auth.consoleSteps.map((text) => ({ kind: 'configure', projectId: guard.projectId, services: ['Authentication'], text }));
      const resumeAt = steps.findIndex((step) => step.kind === 'resume');
      if (resumeAt >= 0) steps.splice(resumeAt, 0, ...authSteps);
      else steps.push(...authSteps);
      state.touched = services;
      writeState(cwd, state);
      const failedOps = auth.results.filter((op) => op.status === 'failed');
      if (failedOps.length && failedOps.length < auth.results.length) {
        io.stdout(`warning: ${failedOps.length} auth op${failedOps.length === 1 ? '' : 's'} failed — see the console steps and report\n`);
      }
      io.stdout(formatAuthProvision(auth));
      io.stdout(formatPostDeploySteps(steps, true));
      if (code === 0) {
        // The customer's steps in the shared wording. A deploy with no Slate
        // service, or one where a Slate command completed, is past step 1
        // (Slate start); the mail step carries its own condition, so it stays.
        const slate = services.includes('Web Client Hosting (Slate)');
        io.stdout(`human checklist:\n${formatCustomerSteps(!slate || slateStarted ? 1 : 0)}`);
      }
      // A successful run that only saw the URL on slate:link still reports it.
      // A failed slate build does not: that URL did not come from the build.
      if (code === 0 && !slateUrl && state.slateUrl) io.stdout(`slate url: ${state.slateUrl}\n`);
      // Op, status, code and message only — the request bodies hold the admin
      // email and role id, and those belong on the wire, never in a file.
      const report = {
        project: guard.projectName,
        projectId: guard.projectId,
        environment: guard.environment,
        dc: guard.dc,
        ui,
        dcSource: guard.dcOrigin ?? null,
        exitCode: code === 0 && (authThrew || (auth.results.length > 0 && auth.results.every((op) => op.status === 'failed'))) ? 1 : code,
        tableDiff: diff,
        ...(bundle.constraints?.length ? { constraints: bundle.constraints } : {}),
        ...(tableError ? { tableError } : {}),
        commands: ran.map((c) => c.argv),
        skipped: done.filter((command) => !ran.includes(command)).map((command) => command.id),
        auth: auth.results.map((op) => ({
          id: op.id,
          status: op.status,
          ...(op.code ? { code: op.code } : {}),
          ...(op.detail ? { message: op.detail } : {}),
        })),
        postDeploySteps: steps,
        humanChecklist: humanChecklist({
          slate: services.includes('Web Client Hosting (Slate)'),
          sendsMail: bundle.sendsMail,
          slateStarted,
          connectionSecretKeys: readConnectionSecretKeys(cwd),
        }),
        // appUrl prefers the deploy output's "App Url:"; the Slate API read-back is the fallback source.
        slate: { ...(slateUrl ?? state.slateUrl ? { appUrl: slateUrl ?? state.slateUrl } : {}), ...(slateNotice ? { notice: slateNotice } : {}) },
        // The function base the app calls (what `c2c smoke --owner-session --url` takes).
        ...(apiBase && /^https:\/\//.test(apiBase) ? { functions: { apiBase } } : {}),
      };
      writeFileSync(join(cwd, DEPLOY_REPORT), `${JSON.stringify(report, null, 2)}\n`);
      io.stdout(`report: ${join(cwd, DEPLOY_REPORT)}\n`);
      return report.exitCode;
    };
    if (tableError) {
      io.stderr(`c2c: ${tableError}\n`);
      return finish(1);
    }
    for (const command of bundle.commands) {
      if (state.done.includes(command.id)) {
        io.stdout(`skip ${command.id} (done in an earlier run)\n`);
        continue;
      }
      if (command.id === 'ui-build') {
        const webDir = join(cwd, 'web');
        if (isWebDistCurrent(webDir)) {
          io.stdout(`skip ${commandLine(command)} (web/dist matches the inputs)\n`);
          ran.push(command);
          state.done.push(command.id);
          writeState(cwd, state);
          continue;
        }
      }
      if (command.id === 'slate-link' || command.id === 'slate') {
        const config = slateConfigSource({ apiBase, auth: true, appTimeZone: appTimeZone(app), smokePlan: smokePlanOf(app, guard), smokeProject: guard.projectId });
        if (ui === 'react') {
          // The built tree is what the Slate steps link and deploy, so the
          // config must land in dist/ — written here, after `npm run build`,
          // because a clean Vite build empties dist/. slate-config.toml is
          // written for the same reason (a clean build would drop it).
          const dist = join(cwd, 'web', 'dist');
          if (!existsSync(join(dist, 'index.html'))) {
            io.stderr(`c2c: ${join('web', 'dist')} does not hold a built app — the web/ build step did not leave one\n`);
            return await finish(1);
          }
          writeFileSync(join(cwd, 'web', 'public', 'c2c-config.js'), config);
          writeFileSync(join(dist, 'c2c-config.js'), config);
          mkdirSync(join(dist, '.catalyst'), { recursive: true });
          writeFileSync(join(dist, '.catalyst', 'slate-config.toml'), slateConfigToml());
        } else {
          writeFileSync(join(cwd, 'slate', 'c2c-config.js'), config);
        }
        if (!apiBase) io.stdout(`warning: no API base; the Slate client calls /server/${API_FUNCTION} on its own domain. Pass --api-base <https://project-domain/server/${API_FUNCTION}>.\n`);
      }
      const program = command.command ?? 'catalyst';
      const spawnOnce = () => io.spawn(program, command.argv, { cwd: command.cwd ? join(cwd, command.cwd) : cwd, env: childEnv });
      // Catalyst commands re-run on a transient 429/5xx the output names — deploy
      // steps are re-entrant (redeploy overwrites, link re-links). npm is not a
      // Catalyst call and is left alone.
      const result =
        program === 'catalyst'
          ? await spawnWithRetry(spawnOnce, commandLine(command), {
              ...retry,
              beforeRetry: async (failure) => {
                if (command.id !== 'slate' && command.id !== 'slate-link') return;
                if (!state.slateUrl) await readBackSlate();
                if (command.id !== 'slate-link') return;
                // A link that failed may still have created the app; once the
                // Slate list names it, the step is done — never re-link into a
                // second same-name app.
                if (state.slateUrl || slateSeen) return { code: 0, stdout: '', stderr: '', skipped: true };
                // A list that could not be read proves nothing either way:
                // stop on the recorded failure rather than link blind.
                if (!slateListed) return failure;
              },
            })
          : await spawnOnce();
      io.stdout(result.skipped ? `skip ${commandLine(command)} (the Slate API already lists the app)\n` : `spawn ${commandLine(command)} exit ${result.code}\n`);
      const combined = stripAnsi(`${result.stdout}\n${result.stderr}`);
      // Any step's App Url can authorise the CORS domain, including slate:link.
      // It is not printed here: a slate:link URL must not look like the live app.
      const captured = slateUrlFrom(combined);
      if (captured && captured !== state.slateUrl) {
        state.slateUrl = captured;
        writeState(cwd, state);
      }
      // The CLI can finish slate:link and deploy slate without printing the URL.
      if (!state.slateUrl && (command.id === 'slate' || command.id === 'slate-link')) await readBackSlate();
      // Only the slate build's own output is the live app URL in the report.
      const built = command.id === 'slate' ? /App Url:\s*(https:\/\/[^\s"'<>]+)/i.exec(combined)?.[1] : undefined;
      if (built && !slateUrl) {
        slateUrl = built;
        io.stdout(`slate url: ${built}\n`);
      }
      if (result.code !== 0) {
        // A slate:link URL is not the live app. Drop it when the slate build
        // failed without printing its own App Url, so it cannot authorise CORS
        // or appear as if the app were served.
        if (command.id === 'slate' && !built && state.slateUrl) {
          delete state.slateUrl;
          writeState(cwd, state);
        }
        // Known CLI behaviour: the Slate build goes live (App Url
        // printed), then the CLI fails polling the app id with "404, No such
        // app with the given id exists". The app is served, so this is
        // recorded with an explanation, not as a plain failure.
        if (command.id === 'slate' && /No such app with the given id/i.test(combined) && built) {
          slateNotice = `Catalyst CLI reported "404, No such app with the given id exists" after a live Slate build (${slateUrl}). The app is served at that URL; verify it in the console before sharing it.`;
          io.stdout(`${slateNotice}\n`);
          ran.push(command);
          state.done.push(command.id);
          writeState(cwd, state);
          continue;
        }
        if (command.id === 'ui-build' || command.id === 'ui-deps') {
          const detail = redact(`${result.stdout}\n${result.stderr}`, secret).trim();
          const lines = detail ? detail.split(/\r?\n/).filter((l) => l.trim().length > 0) : [];
          const tail = lines.slice(-20);
          io.stderr(`c2c: build command failed: ${commandLine(command)}\n`);
          if (tail.length > 0) {
            io.stderr(`last ${tail.length} lines:\n${tail.join('\n')}\n`);
          }
          io.stderr(`next step: fix the build error in web/ and rerun deploy --confirm\n`);
          return await finish(result.code || 1);
        }
        const detail = redact(`${result.stderr}${result.stdout}`, secret).trim();
        if (detail) io.stderr(`${detail}\n`);
        // The recorded fresh-project refusal is an activation step, not a code
        // failure — name the console action and the provision step that tracks it.
        if (command.id === 'slate' && SLATE_SERVICE_CLOSED.test(combined)) {
          const slateConsole = `${dcEndpoints(guard.dc).console}/baas/${guard.org}/project/${guard.projectId}/Development#/slate`;
          io.stderr(`c2c: the Slate service was never opened on this project — Catalyst console → Slate → Start Exploring (${slateConsole}; provision step slate-enable), then re-run deploy\n`);
        }
        return await finish(result.code || 1);
      }
      if (command.id === 'functions' && !apiBaseFlag) {
        const found = functionBaseFrom(`${result.stdout}\n${result.stderr}`);
        if (found) {
          apiBase = found;
          state.apiBase = found;
          io.stdout(`api base: ${found}\n`);
        }
      }
      if (command.id === 'ui-build') {
        recordWebDistBuild(join(cwd, 'web'));
      }
      ran.push(command);
      state.done.push(command.id);
      writeState(cwd, state);
    }
    return await finish(0);
  } catch (err) {
    return fail(io, err);
  }
}

/**
 * Fill NULL `<Field>__n` shadows from the exact varchar, for rows written before the
 * shadow column existed. Plans unless --confirm. Exit 1 when a column stopped early.
 */
async function backfillCli(app: App, guard: GuardOk, args: readonly string[], confirm: boolean, io: Io): Promise<number> {
  const columns = appShadowColumns(app);
  if (!confirm) {
    const lines = [
      'c2c backfill-shadows plan v1',
      ...planScopeLines(guard),
      ...confirmGuardLines(),
      'confirm: no',
      '',
      'columns:',
      ...(columns.length ? columns.map((c) => `- ${c.table}.${c.shadow} from ${c.column} where ${c.shadow} IS NULL`) : ['- none']),
      '',
      'writes: no',
      '',
    ];
    io.stdout(`${lines.join('\n')}\n`);
    return 0;
  }
  await assertLiveProject(io, guard.org, guard.projectId);
  const scope = await resolveScope(io, guard.org, guard.projectId);
  const results = await backfillShadows({
    fetch: io.fetch,
    catalystBase: flag(args, '--catalyst-base') ?? catalystBaseFor(guard.dc),
    dc: guard.dc,
    scope,
    columns,
    ...(io.sleep ? { sleep: io.sleep } : {}),
  });
  for (const line of formatBackfill(results)) io.stdout(`${line}\n`);
  return results.some((r) => r.error) ? 1 : 0;
}

/**
 * Write-rule columns per table for a load, at store scope: `required` is the
 * provisioned is_mandatory, so a Creator-mandatory field the source disproved
 * (`appMandatory`) accepts the empty cells the store column was created for.
 * The caller passes the schema as provisioned — generated flags replayed with
 * the live-recorded decisions — never one re-measured on this load's rows.
 */
function columnsByTableOf(schema: SchemaPlan): Record<string, ReturnType<typeof integrityColumns>> {
  return Object.fromEntries(schema.tables.map((table) => [table.name, integrityColumns(table, undefined, 'store')]));
}

/** Store-unique column names per table from the same provisioned schema. */
function uniqueColumnsByTableOf(schema: SchemaPlan): Record<string, string[]> {
  return Object.fromEntries(schema.tables.map((table) => [table.name, table.columns.filter((column) => column.unique).map((column) => column.name)]));
}

/**
 * The schema as the live project was provisioned: generated flags replayed
 * with the decisions the store's own column metadata reports. A confirmed load
 * is checked against this, never against what the current source would
 * measure — a kept store constraint refuses before a token is minted.
 */
async function provisionedSchemaOf(rest: RestFn, projectId: string, app: App, opts: RetryOptions = {}): Promise<{ schema: SchemaPlan; decisions: ConstraintDecision[] }> {
  const generated = generateSchema(app);
  const decisions = await provisionedConstraints(rest, projectId, generated, opts);
  return { schema: applyConstraintDecisions(generated, decisions), decisions };
}

function writeLoaderReport(dir: string, integrity: IntegrityReport | undefined): void {
  const body = { kind: 'loader-integrity', integrity: integrity ?? emptyIntegrity() };
  writeFileSync(join(dir, LOADER_REPORT), `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * Deterministic fidelity body. Counts, checksums, and source ids only — a cell
 * value never appears. `valuesMatch` is false when the read-back proves a
 * difference, null when no read-back ran, and absent when the table has no
 * schema columns to canonicalize.
 */
export function fidelityBody(result: MigrateResult): Record<string, unknown> {
  return {
    kind: 'data-fidelity',
    ok: result.ok,
    dryRun: result.dryRun,
    ...(result.error ? { error: result.error } : {}),
    tables: result.tables.map((table) => ({
      table: table.table,
      sourceCount: table.sourceCount,
      writtenCount: table.writtenCount,
      sourceChecksum: table.sourceChecksum,
      writtenChecksum: table.writtenChecksum,
      idsMatch: table.sourceChecksum === table.writtenChecksum && table.sourceCount === table.writtenCount && !(table.missingIds?.length),
      ...(table.sourceValueChecksum !== undefined ? { sourceValueChecksum: table.sourceValueChecksum } : {}),
      ...(table.writtenValueChecksum !== undefined ? { writtenValueChecksum: table.writtenValueChecksum } : {}),
      ...(table.sourceValueChecksum !== undefined
        ? {
            valuesMatch:
              table.writtenValueChecksum === undefined
                ? null
                : table.writtenValueChecksum === table.sourceValueChecksum && !(table.differingIds?.length) && !(table.missingIds?.length),
          }
        : {}),
      missingIds: table.missingIds ?? [],
      ...(table.differingIds?.length ? { differingIds: table.differingIds } : {}),
      ...(table.duplicateIds?.length ? { duplicateIds: table.duplicateIds } : {}),
      ...(table.error ? { error: table.error } : {}),
      batches: table.batches,
    })),
    integrity: result.integrity ?? emptyIntegrity(),
  };
}

export function formatFidelityMd(result: MigrateResult): string {
  const body = fidelityBody(result) as { tables: Record<string, unknown>[] };
  const lines = ['# c2c data fidelity', '', `outcome: ${result.ok ? 'ok' : result.error ? `refused: ${result.error}` : 'mismatch'}`, `dry run: ${result.dryRun}`, ''];
  for (const table of body.tables) {
    lines.push(`## ${table.table}`);
    lines.push(`- rows: source ${table.sourceCount} written ${table.writtenCount}`);
    lines.push(`- id checksums: source ${table.sourceChecksum} written ${table.writtenChecksum} (${table.idsMatch ? 'match' : 'differ'})`);
    if (table.sourceValueChecksum !== undefined) {
      lines.push(
        table.writtenValueChecksum === undefined
          ? `- value checksum: source ${table.sourceValueChecksum} (not read back)`
          : `- value checksums: source ${table.sourceValueChecksum} written ${table.writtenValueChecksum} (${table.valuesMatch ? 'match' : 'differ'})`,
      );
    }
    const missing = table.missingIds as string[];
    if (missing.length) lines.push(`- missing source ids: ${missing.join(', ')}`);
    if (table.differingIds) lines.push(`- differing source ids: ${(table.differingIds as string[]).join(', ')}`);
    if (table.duplicateIds) lines.push(`- stored duplicate source ids: ${(table.duplicateIds as string[]).join(', ')}`);
    if (table.error) lines.push(`- error: ${table.error}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function writeFidelityReport(dir: string, result: MigrateResult): void {
  writeFileSync(join(dir, FIDELITY_JSON), `${JSON.stringify(fidelityBody(result), null, 2)}\n`);
  writeFileSync(join(dir, FIDELITY_MD), formatFidelityMd(result));
}

function logRefusals(io: Io, integrity: IntegrityReport | undefined): void {
  for (const group of integrity?.refusedByRule ?? []) {
    for (const row of group.rows) io.stderr(`c2c: ${row.table}.${row.column} ${row.sourceId} refused ${group.rule}\n`);
  }
}

/** Confirmed loads exit 0 only when the run succeeded and every stored row was schema-checked. */
export function confirmedLoadExit(ok: boolean, integrity: IntegrityReport | undefined): number {
  if (integrity?.verified === false) return 1;
  return ok ? 0 : 1;
}

/** Exit 2 before any token or fetch when a confirmed write cannot be checked. Undefined when every table has schema columns. */
function refuseMissingSchema(
  io: Io,
  tables: readonly { table: string }[],
  columnsByTable: Readonly<Record<string, readonly unknown[]>>,
): number | undefined {
  const missing = tables.filter((table) => !(columnsByTable[table.table]?.length)).map((table) => table.table);
  if (!missing.length) return undefined;
  const verb = missing.length === 1 ? 'has' : 'have';
  io.stderr(`c2c: ${missing.join(', ')} ${verb} no schema columns in the export\n`);
  return 2;
}

/** The seed load's argument rules: the refusal message, 'usage', or undefined when well formed. */
export function seedMigrateArgsProblem(args: readonly string[]): string | undefined {
  if (args.includes('--dry-run')) return 'c2c: seed migrate does not take --dry-run; omit --confirm to plan';
  // The app link defaults to the application name in --ds.
  if (!flag(args, '--seed') || !(flag(args, '--app') || flag(args, '--ds'))) return 'usage';
  return undefined;
}

export async function seedMigrateCli(args: readonly string[], io: Io): Promise<number> {
  const problem = seedMigrateArgsProblem(args);
  if (problem !== undefined && problem !== 'usage') {
    io.stderr(`${problem}\n`);
    return 2;
  }
  const seedPath = flag(args, '--seed');
  if (problem === 'usage' || !seedPath) {
    io.stderr(
      'usage: c2c migrate-data --seed <file> --ds <file|dir> [--app <link>] [--project <id-or-name>] [--org <id>] [--env Development] [--confirm] [--checkpoint <file>] [--catalyst-base <url>] [--projects <file>] [--dc <dc>] [--config <c2c-deploy.json>] [--login-user <email>]\n' +
        '       app: --app, else the application name in --ds\n' +
        '       org: --org, else c2c-deploy.json, else the project registry (--projects), else the Catalyst CLI login (active_org)\n' +
        '       project: --project, else c2c-deploy.json, else the project registry map (--projects)\n' +
        '       blocked tables in the seed file are named and keep the exit non-zero\n',
    );
    return 2;
  }
  try {
    // --ds loads the customer's own .ds so lookup cells remap from source ids to ROWIDs.
    const dsTarget = flag(args, '--ds');
    const seedApp = dsTarget ? loadApp(dsTarget) : undefined;
    const named = flag(args, '--app');
    const appLink = named ?? seedApp?.name?.trim();
    if (!appLink) throw new GuardError('name-mismatch', 'application name is missing');
    if (named && seedApp?.name && seedApp.name.trim() !== named) throw new GuardError('name-mismatch', 'application name does not match --app');
    const confirm = args.includes('--confirm');
    const guard = confirm ? await prepareGuard(seedPath, args, appLink, io) : planGuard(seedPath, args, appLink);
    const loginUser = flag(args, '--login-user');
    const seedText = readFileSync(seedPath, 'utf8');
    // Blocked-table records ride in the seed file; a table `c2c seed` refused
    // is named here, never silently absent.
    const blocked = parseSeedBlocked(seedText);
    let parsedSeed: SeedTable[];
    try {
      parsedSeed = parseSeed(seedText, loginUser ? { loginUser } : undefined);
    } catch (error) {
      // A seed whose only payload is c2c_blocked still names every blocked
      // table; it has no tables to parse.
      if (!(blocked.length && error instanceof Error && error.message === 'seed file has no tables')) throw error;
      parsedSeed = [];
    }
    // Reserved names move to their store columns. A name or address still stored
    // under the Creator field name is split into the part columns.
    const seedPlan = seedApp ? generateSchema(seedApp) : undefined;
    const tables = seedApp && seedPlan
      ? seedStoreColumns(parsedSeed, columnRenamesOf(seedPlan), seedCompositeMap(seedApp, seedPlan))
      : parsedSeed;
    const foreignKeys = seedApp ? foreignKeysForApp(seedApp) : undefined;
    const knownTables = seedPlan ? seedPlan.tables.map((table) => table.name) : undefined;
    const fileColumnsByTable = seedPlan ? seedFileColumns(seedPlan) : undefined;
    const seedBucket = fileColumnsByTable && Object.keys(fileColumnsByTable).length ? seedBucketName(appLink) : undefined;
    if (!confirm) {
      io.stdout(formatMigratePlan(tables, guard, [], blocked, seedBucket ? { bucket: seedBucket } : {}));
      return blocked.length ? 1 : 0;
    }
    for (const item of blocked) io.stdout(`blocked ${item.form}${item.field ? `/${item.field}` : ''}: ${item.reason}\n`);
    // Nothing left to load: every table in the file is blocked, so there is no write to confirm.
    if (!tables.length) return 1;
    const ds = flag(args, '--ds');
    if (!ds) {
      io.stderr('c2c: migrate-data --seed --confirm requires --ds <file|dir> so writes are checked against the table schema\n');
      return 2;
    }
    // A seed that names an unknown table or lookup is refused before the project check and before any write.
    if (knownTables) assertSeedTables(tables, knownTables);
    assertSeedReferences(tables, foreignKeys ?? []);
    const restFn = await assertLiveProject(io, guard.org, guard.projectId);
    // Seed files upload to Stratus: its first-use gate is verified first.
    const seedFiles = seedPlan ? Object.keys(seedFileColumns(seedPlan)).length > 0 : false;
    if (seedFiles && !(await verifyFirstUseGates(io, restFn, guard, [FIRST_USE_GATES.stratus], 're-run this command'))) return 1;
    const provisioned = await provisionedSchemaOf(restFn, guard.projectId, loadApp(ds), retryLog(io));
    const columnsByTable = columnsByTableOf(provisioned.schema);
    const missingSchema = refuseMissingSchema(io, tables, columnsByTable);
    if (missingSchema !== undefined) return missingSchema;
    // The file-column bucket is verified before the first row write: the
    // import creates it on a new project, and a project provisioned without
    // it gets one create attempt — never a bare 404 halfway through a load.
    if (seedBucket) {
      const ensured = await ensureSeedBucket(restFn, guard.projectId, seedBucket);
      if (ensured.outcome === 'console-step') {
        io.stderr(
          `c2c: the Stratus service was never opened on this project — Catalyst console → the project → Stratus → Start Exploring, then create bucket ${seedBucket} (provision step bucket), then re-run migrate-data\n`,
        );
        return 1;
      }
      if (ensured.outcome === 'failed') {
        io.stderr(
          `c2c: seed bucket ${seedBucket} is missing and could not be created (HTTP ${ensured.httpStatus}${ensured.detail ? ` — ${ensured.detail}` : ''}); create it with provision step bucket or Catalyst console → Stratus → Create Bucket, then re-run migrate-data\n`,
        );
        return 1;
      }
      if (ensured.outcome === 'created') io.stdout(`bucket: created ${seedBucket}\n`);
    }
    const checkpointPath = flag(args, '--checkpoint');
    let checkpoint = emptyCheckpoint();
    if (checkpointPath && statSync(checkpointPath, { throwIfNoEntry: false })?.isFile()) {
      const parsed = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint;
      if (parsed.version !== 1 || !parsed.tables) throw new Error('checkpoint is not version 1');
      checkpoint = parsed;
    }
    const scope = await resolveScope(io, guard.org, guard.projectId);
    const result = await migrateSeed({
      tables,
      ...(foreignKeys ? { foreignKeys } : {}),
      ...(knownTables ? { knownTables } : {}),
      uniqueColumnsByTable: uniqueColumnsByTableOf(provisioned.schema),
      dc: guard.dc,
      catalystBase: flag(args, '--catalyst-base') ?? catalystBaseFor(guard.dc),
      dryRun: false,
      fetch: io.fetch,
      checkpoint,
      saveCheckpoint: checkpointPath ? (next) => writeFileSync(checkpointPath, `${JSON.stringify(next)}\n`) : undefined,
      scope,
      columnsByTable,
      seedDir: dirname(seedPath),
      ...(fileColumnsByTable ? { fileColumnsByTable } : {}),
      sink: stratusRestSink({
        bucket: seedBucket ?? seedBucketName(appLink),
        dc: guard.dc,
        environment: guard.environment.toLowerCase() === 'production' ? 'production' : 'development',
        token: scope.token,
        fetch: async (url, init) => {
          const response = await io.fetch(url, {
            method: init?.method,
            headers: init?.headers,
            body: init?.body as unknown as string,
          });
          return { status: response.status, headers: response.headers, arrayBuffer: async () => new ArrayBuffer(0) };
        },
      }),
    });
    writeLoaderReport(dirname(seedPath), result.integrity);
    writeFidelityReport(dirname(seedPath), result);
    logRefusals(io, result.integrity);
    if (result.error) io.stderr(`c2c: ${result.error}\n`);
    for (const table of result.tables) {
      io.stdout(`${table.table}: source ${table.sourceCount} written ${table.writtenCount} mismatch ${table.mismatch}\n`);
      if (table.filledNulls) io.stdout(`${table.table}: filled ${table.filledNulls} null column value(s)\n`);
      if (table.correctedLookups) io.stdout(`${table.table}: corrected ${table.correctedLookups} lookup value(s)\n`);
      if (table.error) io.stderr(`c2c: ${table.table}: ${table.error}\n`);
      if (table.duplicateIds?.length) io.stderr(`c2c: ${table.table}: repeated source ids ${table.duplicateIds.slice(0, 10).join(', ')}\n`);
    }
    for (const line of formatSkipped([])) io.stdout(`${line}\n`);
    const complete = result.ok && result.tables.every((table) => table.sourceCount === table.writtenCount && !table.mismatch);
    const exit = confirmedLoadExit(complete, result.integrity);
    // The unblocked tables still load; a named-but-blocked table keeps the run non-zero.
    return blocked.length && exit === 0 ? 1 : exit;
  } catch (err) {
    return fail(io, err);
  }
}

/** The source-csv/json load's argument rules: the refusal message, 'usage', or undefined when well formed. */
export function sourceCsvArgsProblem(args: readonly string[]): string | undefined {
  const csvDir = flag(args, '--source-csv');
  const jsonDir = flag(args, '--source-json');
  if (args.includes('--seed') && (args.includes('--source-csv') || args.includes('--source-json'))) return 'c2c: pass either --seed or --source-csv, not both';
  if (csvDir && jsonDir) return 'c2c: pass either --source-csv or --source-json, not both';
  if (args.includes('--dry-run')) return 'c2c: source csv does not take --dry-run; omit --confirm to plan';
  if (!(jsonDir ?? csvDir) || !flag(args, '--ds')) return 'usage';
  return undefined;
}

export async function sourceCsvCli(args: readonly string[], io: Io): Promise<number> {
  const csvDir = flag(args, '--source-csv');
  const jsonDir = flag(args, '--source-json');
  const problem = sourceCsvArgsProblem(args);
  if (problem !== undefined && problem !== 'usage') {
    io.stderr(`${problem}\n`);
    return 2;
  }
  const dir = jsonDir ?? csvDir;
  const ds = flag(args, '--ds');
  if (problem === 'usage' || !dir || !ds) {
    io.stderr(
      'usage: c2c migrate-data --source-csv <dir> --ds <file|dir> [--project <id-or-name>] [--org <id>] [--app <link>] [--env Development] [--confirm] [--allow-empty] [--checkpoint <file>] [--catalyst-base <url>] [--projects <file>] [--dc <dc>] [--config <c2c-deploy.json>]\n' +
        '       c2c migrate-data --source-json <dir> --ds <file|dir> [--project <id-or-name>] [--org <id>] [--app <link>] [--env Development] [--confirm] [--allow-empty] [--checkpoint <file>] [--catalyst-base <url>] [--projects <file>] [--dc <dc>] [--config <c2c-deploy.json>]\n' +
        '       org: --org, else c2c-deploy.json, else the project registry (--projects), else the Catalyst CLI login (active_org)\n' +
        '       project: --project, else c2c-deploy.json, else the project registry map (--projects)\n' +
        '       The JSON export always carries record ids; a CSV carries them only when it includes the ID column, otherwise source ids are derived (the plan lists them under derived ids). A directory passed to --source-csv that contains a JSON report is read as JSON.\n',
    );
    return 2;
  }
  try {
    const app = loadApp(ds);
    const named = flag(args, '--app');
    const appLink = named ?? app.name?.trim();
    if (!appLink) throw new GuardError('name-mismatch', 'application name is missing');
    if (named && app.name?.trim() !== named) throw new GuardError('name-mismatch', 'application name does not match --app');
    const confirm = args.includes('--confirm');
    const guard = confirm ? await prepareGuard(ds, args, appLink, io) : planGuard(ds, args, appLink);
    const allowEmpty = args.includes('--allow-empty');
    const format = jsonDir || hasReportJson(dir, app) ? 'json' : 'csv';
    const loaded = format === 'json' ? readSourceJson(dir, app, allowEmpty) : readSourceCsv(dir, app, allowEmpty);
    if (!confirm) {
      io.stdout(formatCsvPlan(loaded, guard));
      // Plan reports the same refusal confirm would raise. Non-zero so a caller
      // can gate on it; nothing was written either way.
      if (loaded.missingMandatory.length) {
        io.stderr(`c2c: ${loaded.missingMandatory.length} mandatory value(s) missing; a confirmed run would refuse before any write\n`);
        return 1;
      }
      return 0;
    }
    const missingSchema = refuseMissingSchema(io, loaded.tables, columnsByTableOf(generateSchema(app)));
    if (missingSchema !== undefined) return missingSchema;
    // The provisioned column flags are the constraint truth: this export's own
    // measure cannot relax what the store enforces, and a column the store
    // demoted does not refuse a later load that leaves it empty.
    const restFn = await assertLiveProject(io, guard.org, guard.projectId);
    const provisioned = await provisionedSchemaOf(restFn, guard.projectId, app, retryLog(io));
    // Refuse before resolveScope: no token is minted and no row is written when
    // a store-mandatory column is absent from the export.
    const missing = mandatoryMissingRefusals(loaded.tables, loaderColumns(provisioned.schema, loaded.tables, loaded.foreignKeys));
    if (missing.length) {
      const integrity = { ...emptyIntegrity(), refusedByRule: groupRefusals(missing) };
      writeLoaderReport(dir, integrity);
      writeFidelityReport(dir, {
        ok: false,
        dryRun: false,
        tables: [],
        integrity,
        error: `refused ${missing.length} missing mandatory value(s) before any write`,
      });
      logRefusals(io, integrity);
      const names = [...new Set(missing.map((item) => `${item.table}.${item.column}`))].join(', ');
      io.stderr(
        `c2c: refused: ${missing.length} mandatory value(s) missing; nothing was written. ${names} is store-mandatory; fix the source or re-provision the column without the constraint\n`,
      );
      return 1;
    }
    const checkpointPath = flag(args, '--checkpoint');
    let checkpoint = emptyCheckpoint();
    if (checkpointPath && statSync(checkpointPath, { throwIfNoEntry: false })?.isFile()) {
      const parsed = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint;
      if (parsed.version !== 1 || !parsed.tables) throw new Error('checkpoint is not version 1');
      checkpoint = parsed;
    }
    const scope = await resolveScope(io, guard.org, guard.projectId);
    const result = await migrateCsv({
      app,
      dir,
      format,
      dc: guard.dc,
      catalystBase: flag(args, '--catalyst-base') ?? catalystBaseFor(guard.dc),
      fetch: io.fetch,
      checkpoint,
      saveCheckpoint: checkpointPath ? (next) => writeFileSync(checkpointPath, `${JSON.stringify(next)}\n`) : undefined,
      scope,
      allowEmpty,
      constraints: provisioned.decisions,
    });
    writeLoaderReport(dir, result.integrity);
    writeFidelityReport(dir, result);
    logRefusals(io, result.integrity);
    if (result.error) io.stderr(`c2c: ${result.error}\n`);
    for (const table of result.tables) {
      io.stdout(`${table.table}: source ${table.sourceCount} written ${table.writtenCount} mismatch ${table.mismatch}\n`);
      if (table.filledNulls) io.stdout(`${table.table}: filled ${table.filledNulls} null column value(s)\n`);
      if (table.correctedLookups) io.stdout(`${table.table}: corrected ${table.correctedLookups} lookup value(s)\n`);
      if (table.error) io.stderr(`c2c: ${table.table}: ${table.error}\n`);
      if (table.duplicateIds?.length) io.stderr(`c2c: ${table.table}: repeated source ids ${table.duplicateIds.slice(0, 10).join(', ')}\n`);
    }
    for (const count of result.counts) {
      io.stdout(`${count.form}: catalyst ${count.catalyst} expected ${count.expected} mismatch ${count.mismatch}\n`);
    }
    for (const line of formatSkipped(result.skipped)) io.stdout(`${line}\n`);
    for (const line of formatMandatoryRelaxed(result.relaxed)) io.stdout(`${line}\n`);
    if (result.fidelity.length) io.stdout('data fidelity:\n');
    for (const line of result.fidelity) io.stdout(`  - ${line}\n`);
    for (const line of result.warnings ?? []) io.stdout(`warning: ${line}\n`);
    return confirmedLoadExit(result.ok, result.integrity);
  } catch (err) {
    return fail(io, err);
  }
}

/** The app-user auth smoke sends on function calls: a Web SDK token or a session cookie, flag or env. Values are never printed. */
function smokeAuth(rest: readonly string[], env: NodeJS.ProcessEnv): { auth: SmokeAuth; label: string } {
  const tokenFlag = flag(rest, '--auth-token');
  const cookieFlag = flag(rest, '--session-cookie');
  const tokenEnv = typeof env.C2C_SMOKE_AUTH_TOKEN === 'string' && env.C2C_SMOKE_AUTH_TOKEN.trim() ? env.C2C_SMOKE_AUTH_TOKEN.trim() : undefined;
  const cookieEnv =
    typeof env.C2C_SMOKE_SESSION_COOKIE === 'string' && env.C2C_SMOKE_SESSION_COOKIE.trim() ? env.C2C_SMOKE_SESSION_COOKIE.trim() : undefined;
  if (cookieFlag) assertSmokeCookie(cookieFlag, '--session-cookie');
  if (cookieEnv) assertSmokeCookie(cookieEnv, 'C2C_SMOKE_SESSION_COOKIE');
  const auth: SmokeAuth = { ...(tokenFlag || tokenEnv ? { token: tokenFlag ?? tokenEnv } : {}) };
  if (cookieFlag || cookieEnv) auth.cookie = cookieFlag ?? cookieEnv;
  const label = describeSmokeAuth(auth, {
    ...(auth.token ? { token: tokenFlag ? '--auth-token' : 'C2C_SMOKE_AUTH_TOKEN' } : {}),
    ...(auth.cookie ? { cookie: cookieFlag ? '--session-cookie' : 'C2C_SMOKE_SESSION_COOKIE' } : {}),
  });
  return { auth, label };
}

/** The route table a deploy writes — regenerated so smoke calls only real routes with their real methods. */
function smokeRoutes(app: App, guard: ReturnType<typeof checkGuards>): { routes: Record<string, string>; schema: ReturnType<typeof deployFiles>['schema'] } {
  const { files, schema } = deployFiles(app, guard, false, { mode: 'dry-run' });
  const entry = files.find((file) => file.path === `${FUNCTION_DIR}/routes.json`);
  if (!entry || typeof entry.data !== 'string') throw new Error('the deploy bundle has no functions/c2c_api/routes.json');
  let routes: unknown;
  try {
    routes = JSON.parse(entry.data);
  } catch {
    throw new Error('functions/c2c_api/routes.json did not parse');
  }
  if (!routes || typeof routes !== 'object' || Array.isArray(routes)) throw new Error('functions/c2c_api/routes.json is not a route map');
  for (const [key, value] of Object.entries(routes)) {
    if (!/^[A-Z]+ \//.test(key) || typeof value !== 'string') throw new Error('functions/c2c_api/routes.json is not a route map');
  }
  return { routes: routes as Record<string, string>, schema };
}

/** The smoke plan for this source — what the deployed #/admin/smoke page embeds and runs. */
export function smokePlanOf(app: App, guard: ReturnType<typeof checkGuards>): ReturnType<typeof planSmoke> {
  const { routes, schema } = smokeRoutes(app, guard);
  return planSmoke(app, { routes, model: generateUi(app).model, schema });
}

/**
 * A Creator application backup — the "Schema + Data + Include Files" zip, or
 * the same layout already extracted to a directory. The plan lists every table
 * and lookup with counts taken from the backup; --confirm runs the same
 * guarded loader as the report-export paths.
 */
export async function sourceBackupCli(args: readonly string[], io: Io): Promise<number> {
  const source = flag(args, '--source-backup');
  for (const other of ['--seed', '--source-csv', '--source-json']) {
    if (args.includes(other)) {
      io.stderr(`c2c: pass either --source-backup or ${other}, not both\n`);
      return 2;
    }
  }
  if (args.includes('--dry-run')) {
    io.stderr('c2c: source backup does not take --dry-run; omit --confirm to plan\n');
    return 2;
  }
  const ds = flag(args, '--ds');
  if (!source || !ds) {
    io.stderr(
      'usage: c2c migrate-data --source-backup <zip|dir> --ds <file|dir> [--project <id-or-name>] [--org <id>] [--app <link>] [--env Development] [--confirm] [--allow-empty] [--checkpoint <file>] [--catalyst-base <url>] [--projects <file>] [--dc <dc>] [--config <c2c-deploy.json>]\n' +
        '       org: --org, else c2c-deploy.json, else the project registry (--projects), else the Catalyst CLI login (active_org)\n' +
        '       project: --project, else c2c-deploy.json, else the project registry map (--projects)\n' +
        '       the backup is the complete data source: every field, lookup record ids, and subform rows.\n',
    );
    return 2;
  }
  try {
    const app = loadApp(ds);
    const named = flag(args, '--app');
    const appLink = named ?? app.name?.trim();
    if (!appLink) throw new GuardError('name-mismatch', 'application name is missing');
    if (named && app.name?.trim() !== named) throw new GuardError('name-mismatch', 'application name does not match --app');
    const confirm = args.includes('--confirm');
    const guard = confirm ? await prepareGuard(ds, args, appLink, io) : planGuard(ds, args, appLink);
    const loaded = readSourceBackup(source, app, args.includes('--allow-empty'));
    if (!confirm) {
      io.stdout(formatCsvPlan(loaded, guard));
      // Plan reports the same refusal confirm would raise. Non-zero so a caller
      // can gate on it; nothing was written either way.
      if (loaded.missingMandatory.length) {
        io.stderr(`c2c: ${loaded.missingMandatory.length} mandatory value(s) missing; a confirmed run would refuse before any write\n`);
        return 1;
      }
      return 0;
    }
    const missingSchema = refuseMissingSchema(io, loaded.tables, columnsByTableOf(generateSchema(app)));
    if (missingSchema !== undefined) return missingSchema;
    // The provisioned column flags are the constraint truth: this backup's own
    // measure cannot relax what the store enforces, and a column the store
    // demoted does not refuse a later load that leaves it empty.
    const restFn = await assertLiveProject(io, guard.org, guard.projectId);
    const provisioned = await provisionedSchemaOf(restFn, guard.projectId, app, retryLog(io));
    // Refuse before resolveScope: no token is minted and no row is written when
    // a store-mandatory column has empty cells.
    const missing = mandatoryMissingRefusals(loaded.tables, loaderColumns(provisioned.schema, loaded.tables, loaded.foreignKeys));
    if (missing.length) {
      const integrity = { ...emptyIntegrity(), refusedByRule: groupRefusals(missing) };
      writeLoaderReport(statSync(source).isDirectory() ? source : dirname(source), integrity);
      writeFidelityReport(statSync(source).isDirectory() ? source : dirname(source), {
        ok: false,
        dryRun: false,
        tables: [],
        integrity,
        error: `refused ${missing.length} missing mandatory value(s) before any write`,
      });
      logRefusals(io, integrity);
      io.stderr(`c2c: refused: ${missing.length} mandatory value(s) missing; nothing was written\n`);
      return 1;
    }
    const checkpointPath = flag(args, '--checkpoint');
    let checkpoint = emptyCheckpoint();
    if (checkpointPath && statSync(checkpointPath, { throwIfNoEntry: false })?.isFile()) {
      const parsed = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint;
      if (parsed.version !== 1 || !parsed.tables) throw new Error('checkpoint is not version 1');
      checkpoint = parsed;
    }
    const scope = await resolveScope(io, guard.org, guard.projectId);
    const result = await migrateLoaded({
      app,
      loaded,
      dc: guard.dc,
      catalystBase: flag(args, '--catalyst-base') ?? catalystBaseFor(guard.dc),
      fetch: io.fetch,
      checkpoint,
      saveCheckpoint: checkpointPath ? (next) => writeFileSync(checkpointPath, `${JSON.stringify(next)}\n`) : undefined,
      scope,
      constraints: provisioned.decisions,
    });
    writeLoaderReport(statSync(source).isDirectory() ? source : dirname(source), result.integrity);
    logRefusals(io, result.integrity);
    for (const table of result.tables) {
      io.stdout(`${table.table}: source ${table.sourceCount} written ${table.writtenCount} mismatch ${table.mismatch}\n`);
      if (table.filledNulls) io.stdout(`${table.table}: filled ${table.filledNulls} null column value(s)\n`);
      if (table.correctedLookups) io.stdout(`${table.table}: corrected ${table.correctedLookups} lookup value(s)\n`);
      if (table.error) io.stderr(`c2c: ${table.table}: ${table.error}\n`);
      if (table.duplicateIds?.length) io.stderr(`c2c: ${table.table}: repeated source ids ${table.duplicateIds.slice(0, 10).join(', ')}\n`);
    }
    for (const count of result.counts) {
      io.stdout(`${count.form}: catalyst ${count.catalyst} expected ${count.expected} mismatch ${count.mismatch}\n`);
    }
    for (const line of formatSkipped(result.skipped)) io.stdout(`${line}\n`);
    for (const line of formatMandatoryRelaxed(result.relaxed)) io.stdout(`${line}\n`);
    if (result.fidelity.length) io.stdout('data fidelity:\n');
    for (const line of result.fidelity) io.stdout(`  - ${line}\n`);
    for (const line of result.warnings ?? []) io.stdout(`warning: ${line}\n`);
    return confirmedLoadExit(result.ok, result.integrity);
  } catch (err) {
    return fail(io, err);
  }
}

/** `c2c smoke` exit code when a person must act first (sign in); stdout carries the `c2c-blocker:` line. */
export const SMOKE_BLOCKED_EXIT = 4;

interface SmokeReport {
  version: 'c2c-smoke-report/1';
  ok: boolean;
  session: 'owner' | 'app-user' | 'credential';
  blocker?: string;
  lines: string[];
  result?: unknown;
}

/** --report <file>: the run's verdict and step lines. Holds no credential: none is ever read. */
function writeSmokeReport(path: string | undefined, report: SmokeReport): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * The smoke argument rules that need no file, network or session: the session
 * mode, --cdp's session, and the --url a confirmed run needs when it drives a
 * browser or calls the app with a credential flag (the guided default and
 * --result take the app URL from the deploy report).
 */
export function smokeArgsProblems(rest: readonly string[]): { session?: string; cdp?: string; url?: string } {
  const inBrowser = rest.includes('--in-browser');
  const ownerSession = rest.includes('--owner-session');
  const cdp = rest.includes('--cdp') || flag(rest, '--browser-cdp') !== undefined;
  const driven = cdp || (!inBrowser && !ownerSession && !!(flag(rest, '--auth-token') || flag(rest, '--session-cookie')));
  return {
    ...(inBrowser && ownerSession ? { session: '--in-browser and --owner-session are different sessions; pass one' } : {}),
    ...(cdp && !inBrowser && !ownerSession ? { cdp: '--cdp drives a local browser for --in-browser or --owner-session; pass one of them' } : {}),
    ...(rest.includes('--confirm') && !rest.includes('--result') && !rest.includes('--result-code') && driven && !flag(rest, '--url') ? { url: 'smoke --confirm requires --url' } : {}),
  };
}

/** --url (an app URL) must be on the deploy report's app origin when a report is beside the source. */
function assertReportOrigin(ds: string, appUrl: URL): void {
  const reported = deployReportAppUrl(ds);
  if (reported !== undefined && new URL(reported).origin !== appUrl.origin) {
    throw new GuardError('smoke-auth', `--url ${appUrl.origin} does not match the deploy report's app origin ${new URL(reported).origin}`);
  }
}

/**
 * The one step the user takes when nothing drives a browser for them: open the
 * deployed app's #/admin/smoke page in their own browser, signed in as the
 * owner, and paste the result code it shows into `--result-code` (or save the
 * c2c-smoke/1 block for `--result`). The URL is
 * the deploy report's slate.appUrl (else an app --url).
 */
function guidedStep(ds: string, rest: readonly string[], inBrowser: boolean): { text: string; page?: string } {
  const urlFlag = flag(rest, '--url');
  let appUrl: string | undefined;
  try {
    appUrl = deployReportAppUrl(ds);
  } catch {
    // A report that cannot bind an app URL (no slate.appUrl, not a URL, not
    // JSON) cannot name the page either — the step then says where the URL
    // comes from instead of refusing a hint that navigates nothing.
    appUrl = undefined;
  }
  if (appUrl === undefined && inBrowser && urlFlag) {
    const parsed = assertSmokeUrl(urlFlag);
    assertReportOrigin(ds, parsed);
    appUrl = parsed.toString();
  }
  let page: string | undefined;
  if (appUrl !== undefined) {
    const url = new URL(appUrl);
    url.hash = '';
    page = `${url.toString().replace(/\/+$/, '')}#/admin/smoke`;
  }
  const where = page ?? "your deployed app's URL followed by #/admin/smoke (the slate url `c2c deploy` printed; c2c-deploy-report.json keeps it as slate.appUrl)";
  const text =
    'smoke: one step for you — no browser automation, token or cookie is needed:\n' +
    `  open ${where} in your own browser, signed in to the app as the project owner; wait until the page says Done or Failed; ` +
    'press Copy beside the result code it shows and paste the code back here (your AI chat checks it with c2c smoke --result-code <code>); ' +
    `using the CLI yourself, save the c2c-smoke/1 block it shows as smoke-result.txt and run: c2c smoke ${ds} --result smoke-result.txt\n`;
  return { text, ...(page ? { page } : {}) };
}

function guidedSmoke(input: { io: Io; ds: string; rest: readonly string[]; inBrowser: boolean; reportPath: string | undefined }): number {
  const { io, ds, rest, inBrowser, reportPath } = input;
  const step = guidedStep(ds, rest, inBrowser);
  io.stdout(step.text);
  const blocker = `smoke-page${step.page ? ` ${step.page}` : ''}`;
  io.stdout(`c2c-blocker: ${blocker}\n`);
  writeSmokeReport(reportPath, { version: 'c2c-smoke-report/1', ok: false, session: 'app-user', blocker, lines: [step.text.trim()] });
  return SMOKE_BLOCKED_EXIT;
}

/** Largest pasted block --result / --result-code reads; the page's block is a few KiB. */
const MAX_RESULT_BYTES = 1024 * 1024;

/**
 * `c2c smoke --result <file|->`: verify the c2c-smoke/1 block the user copied
 * from the app's #/admin/smoke page and write the same report the browser
 * paths write. Bound to the deploy report's app origin and project (else
 * --url / --project). Reads no credential and makes no network call.
 */
function smokeResultCli(input: { io: Io; ds: string; app: App; appLink: string; rest: readonly string[]; reportPath: string | undefined }): number {
  const { io, ds, app, appLink, rest, reportPath } = input;
  const byCode = rest.includes('--result-code');
  if (byCode && rest.includes('--result')) {
    io.stderr('c2c: pass --result <file> or --result-code <code>, not both\n');
    return 2;
  }
  const valueOf = (name: string) => flag(rest, name) ?? (rest[rest.indexOf(name) + 1] === '-' ? '-' : undefined);
  const source = byCode ? valueOf('--result-code') : valueOf('--result');
  if (!source) {
    io.stderr(byCode ? "c2c: --result-code needs the code the app's #/admin/smoke page shows, or - to read it from stdin\n" : 'c2c: --result needs a file path, or - to read the block from stdin\n');
    return 2;
  }
  for (const other of ['--in-browser', '--owner-session', '--cdp', '--browser-cdp', '--auth-token', '--session-cookie']) {
    if (rest.includes(other)) throw new GuardError('smoke-auth', `--result checks the block the smoke page printed; ${other} is not used with it`);
  }
  const maxAgeFlag = flag(rest, '--max-age');
  if (rest.includes('--max-age') && !(maxAgeFlag && /^[1-9][0-9]{0,4}$/.test(maxAgeFlag))) throw new Error('--max-age needs a whole number of minutes');
  const maxAgeMinutes = maxAgeFlag ? Number(maxAgeFlag) : SMOKE_RESULT_MAX_AGE_MINUTES;
  const guard = planGuard(ds, rest, appLink);
  const binding = deployReportBinding(ds);
  const urlFlag = flag(rest, '--url');
  let origin: string;
  if (binding) {
    origin = new URL(binding.appUrl).origin;
    if (urlFlag !== undefined) assertReportOrigin(ds, assertSmokeUrl(urlFlag));
  } else if (urlFlag !== undefined) {
    origin = assertSmokeUrl(urlFlag).origin;
  } else {
    io.stderr(`c2c: --result needs the app it checks: no ${DEPLOY_REPORT} beside the source or in the current directory; pass --url <app-url> (the slate url c2c deploy printed)\n`);
    return 2;
  }
  const projectFlag = guard.projectOrigin === '--project' && /^[0-9]{1,24}$/.test(guard.projectId) ? guard.projectId : undefined;
  if (binding?.projectId && projectFlag && binding.projectId !== projectFlag) {
    throw new GuardError('name-mismatch', `--project ${projectFlag} does not match the deploy report's project ${binding.projectId}`);
  }
  const projectId = binding?.projectId ?? projectFlag;
  if (!projectId) {
    io.stderr(`c2c: --result needs the project it checks: ${binding ? `${DEPLOY_REPORT} names no project id` : `no ${DEPLOY_REPORT}`}; pass --project <project-id>\n`);
    return 2;
  }
  let text: string;
  if (byCode && source !== '-') {
    text = source;
  } else if (source === '-') {
    text = io.stdin ? io.stdin() : readFileSync(0, 'utf8');
  } else {
    if ((statSync(source, { throwIfNoEntry: false })?.size ?? 0) > MAX_RESULT_BYTES) throw new Error('--result file is larger than a c2c-smoke/1 block can be');
    text = readFileSync(source, 'utf8');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) throw new Error('--result input is larger than a c2c-smoke/1 block can be');
  const plan = smokePlanOf(app, guard);
  const check = verifySmokeResult(text, {
    origin,
    projectId,
    app: appLink,
    plan,
    submits: plan.filter((step) => step.kind === 'submit').length,
    now: Date.now(),
    maxAgeMinutes,
  });
  for (const line of check.lines) io.stdout(`${line}\n`);
  for (const reason of check.reasons) io.stderr(`c2c: refused: ${reason}\n`);
  if (check.ok) io.stdout(`result: verified — every step passed on ${origin} for project ${projectId}\n`);
  io.stdout(`state: ${check.ok ? 'passed' : 'failed'}\n`);
  writeSmokeReport(reportPath, {
    version: 'c2c-smoke-report/1',
    ok: check.ok,
    session: 'app-user',
    lines: [...check.lines, ...check.reasons.map((reason) => `refused: ${reason}`)],
    ...(check.block ? { result: check.block } : {}),
  });
  return check.ok ? 0 : 1;
}

export async function smokeCli(args: readonly string[], io: Io, opts?: { browser?: SmokeBrowser; sleep?: (ms: number) => Promise<void> }): Promise<number> {
  const { target, rest } = targetOf(args);
  const ds = target ?? flag(rest, '--ds');
  if (!ds) {
    io.stderr(
      'usage: c2c smoke <file|dir> [--project <id-or-name>] [--org <id>] [--url <app-url>] [--env Development] [--confirm] [--report <file>] [--catalyst-base <url>] [--projects <file>] [--dc <dc>] [--config <c2c-deploy.json>]\n' +
        '       c2c smoke <file|dir> --result <file|-> [--project <id>] [--url <app-url>] [--max-age <minutes>] [--report <file>]\n' +
        '       c2c smoke <file|dir> --result-code <code|-> [--project <id>] [--url <app-url>] [--max-age <minutes>] [--report <file>]\n' +
        '       org: --org, else c2c-deploy.json, else the project registry (--projects), else the Catalyst CLI login (active_org)\n' +
        '       project: --project, else c2c-deploy.json, else the project registry map (--projects)\n' +
        '       --confirm: prints one step — open <app url>#/admin/smoke in your own browser, signed in to the app once, and copy the result code it shows — and exits 4\n' +
        '       --result-code: verifies that code (this app origin and project, the plan, freshness, every step) and writes --report; never takes a token or cookie\n' +
        '       --result: the same check on the c2c-smoke/1 block the page shows, saved to a file (or - for stdin)\n',
    );
    return 2;
  }
  const reportPath = flag(rest, '--report');
  if (rest.includes('--report') && !reportPath) {
    io.stderr('c2c: --report needs a file path\n');
    return 2;
  }
  try {
    const app = loadApp(ds);
    const appLink = app.name?.trim();
    if (!appLink) throw new GuardError('name-mismatch', 'application name is missing');
    if (rest.includes('--result') || rest.includes('--result-code')) return smokeResultCli({ io, ds, app, appLink, rest, reportPath });
    const confirm = rest.includes('--confirm');
    const inBrowser = rest.includes('--in-browser');
    const ownerSession = rest.includes('--owner-session');
    const problems = smokeArgsProblems(rest);
    // Driving a local browser over the DevTools protocol is opt-in, never the default.
    const cdp = rest.includes('--cdp') || flag(rest, '--browser-cdp') !== undefined;
    if (problems.session) throw new GuardError('smoke-auth', problems.session);
    const credentialGiven = !!(flag(rest, '--auth-token') || flag(rest, '--session-cookie') || io.env.C2C_SMOKE_AUTH_TOKEN || io.env.C2C_SMOKE_SESSION_COOKIE);
    if ((inBrowser || ownerSession) && credentialGiven) {
      throw new GuardError('smoke-auth', `${inBrowser ? '--in-browser' : '--owner-session'} uses the signed-in browser session; --auth-token/--session-cookie are not accepted`);
    }
    if (problems.cdp) throw new GuardError('smoke-auth', problems.cdp);
    // The default: no browser automation and no app credential. The user runs
    // the app's own smoke page in their browser and hands back its result block.
    const guided = confirm && !cdp && (inBrowser || ownerSession || !credentialGiven);
    const guard = confirm ? await prepareGuard(ds, rest, appLink, io, { credentialOptional: inBrowser || guided }) : planGuard(ds, rest, appLink);
    if (guided) return guidedSmoke({ io, ds, rest, inBrowser, reportPath });
    const url = flag(rest, '--url');
    const { auth, label } = ownerSession ? { auth: {} as SmokeAuth, label: '' } : smokeAuth(rest, io.env);
    const authLabel = inBrowser ? 'in-browser (the signed-in app session)' : ownerSession ? "owner session (the project owner's browser session)" : label;
    const { routes, schema } = smokeRoutes(app, guard);
    const steps = planSmoke(app, { routes, model: generateUi(app).model, schema });
    io.stdout(formatSmokePlan(steps, guard, url, authLabel, confirm, inBrowser ? 'not required — the browser session is the credential' : undefined));
    if (!confirm) return 0;
    if (problems.url || !url) throw new Error(problems.url ?? 'smoke --confirm requires --url');
    if (inBrowser) {
      // The run happens inside the app under the browser's own sign-in — the
      // generated admin route enforces access, so no admin REST probe and no
      // credential scope are needed here.
      const appUrl = assertSmokeUrl(url);
      // --url names the app this deploy serves. A deploy report beside the
      // source is the binding; without one the project's own Slate app list is
      // read back (read-only calls only). A different origin — or an app URL
      // that cannot be proven at all — is refused before any navigation, so
      // the tab can never be pointed at another app.
      const reported = deployReportAppUrl(ds);
      if (reported !== undefined) {
        if (new URL(reported).origin !== appUrl.origin) {
          throw new GuardError('smoke-auth', `--url ${appUrl.origin} does not match the deploy report's app origin ${new URL(reported).origin}`);
        }
      } else {
        let bound: string | undefined;
        let why: string | undefined;
        try {
          const admin = await assertLiveProject(io, guard.org, guard.projectId);
          const read = await readSlateAppUrl(admin, guard.projectId, guard.projectName, retryLog(io));
          bound = read.url;
          why = read.note;
        } catch (err) {
          why = err instanceof Error ? err.message : 'the project could not be read';
        }
        if (!bound) {
          throw new GuardError(
            'smoke-auth',
            `--url ${appUrl.origin} cannot be bound to project ${guard.projectId}: no ${DEPLOY_REPORT} beside the source${why ? ` and the app's Slate URL could not be read (${why})` : ''} — run c2c deploy first so the report records the app URL`,
          );
        }
        if (new URL(bound).origin !== appUrl.origin) {
          throw new GuardError('smoke-auth', `--url ${appUrl.origin} does not match the project's Slate app origin ${new URL(bound).origin}`);
        }
      }
      const browser = opts?.browser ?? cdpBrowser(flag(rest, '--browser-cdp') ?? 'http://127.0.0.1:9222');
      let result: BrowserSmokeResult;
      try {
        result = await runBrowserSmoke({
          browser,
          appUrl: url,
          expect: { submits: steps.filter((step) => step.kind === 'submit').length },
          log: (line) => io.stderr(`${line}\n`),
        });
      } catch (err) {
        io.stderr(`c2c: could not reach the browser over CDP: ${err instanceof Error ? err.message : 'connection failed'}; check --browser-cdp <endpoint>\n`);
        io.stdout(guidedStep(ds, rest, inBrowser).text);
        return 1;
      }
      for (const line of result.lines) io.stdout(`${line}\n`);
      if (result.json !== undefined) io.stdout(`${JSON.stringify(result.json, null, 2)}\n`);
      io.stdout(`state: ${result.state}\n`);
      if (result.state === 'denied' || result.state === 'not-signed-in') {
        // Not signed in (or not an app administrator): a person's step, not a failure.
        const blocker = `not-signed-in ${url}`;
        io.stdout(`c2c-blocker: ${blocker}\n`);
        writeSmokeReport(reportPath, { version: 'c2c-smoke-report/1', ok: false, session: 'app-user', blocker, lines: result.lines });
        return SMOKE_BLOCKED_EXIT;
      }
      writeSmokeReport(reportPath, { version: 'c2c-smoke-report/1', ok: result.ok, session: 'app-user', lines: result.lines, ...(result.json === undefined ? {} : { result: result.json }) });
      return result.ok ? 0 : 1;
    }
    if (ownerSession) {
      // --url names the function this deploy serves — the deploy report beside
      // the source is the binding (functions.apiBase, else the served app
      // domain). Nothing is sent to a function the report does not name, and
      // the refusal runs before any request, even the project read.
      const base = assertSmokeUrl(url);
      const bound = deployReportFunctionOrigin(ds);
      if (!bound) {
        throw new GuardError('smoke-auth', `--owner-session --url ${base.origin} cannot be bound to project ${guard.projectId}: no ${DEPLOY_REPORT} beside the source — run c2c deploy first; its report records the function base`);
      }
      if (bound.origin !== base.origin) {
        throw new GuardError('smoke-auth', `--url ${base.origin} does not match the deploy report's ${bound.label} origin ${bound.origin}`);
      }
    }
    await assertLiveProject(io, guard.org, guard.projectId);
    if (ownerSession) {
      return await ownerSessionSmoke({ io, url, rest, guard, steps, reportPath, guided: () => guidedStep(ds, rest, inBrowser).text, ...(opts?.browser ? { browser: opts.browser } : {}), ...(opts?.sleep ? { sleep: opts.sleep } : {}) });
    }
    let scopePromise: Promise<{ org: string; projectId: string; token: string }> | undefined;
    const scope = () => (scopePromise ??= resolveScope(io, guard.org, guard.projectId));
    const result = await executeSmoke(steps, {
      fetch: io.fetch,
      base: url,
      auth,
      dc: guard.dc,
      catalystBase: flag(rest, '--catalyst-base') ?? catalystBaseFor(guard.dc),
      scope,
    });
    for (const line of result.lines) io.stdout(`${line}\n`);
    writeSmokeReport(reportPath, { version: 'c2c-smoke-report/1', ok: result.ok, session: 'credential', lines: result.lines });
    return result.ok ? 0 : 1;
  } catch (err) {
    return fail(io, err);
  }
}

/**
 * --owner-session: open a tab on the function URL in the local browser and
 * send every function call from inside that page, so the session the browser
 * already holds rides along. The CLI never reads, prints or stores it. Admin
 * read-backs keep using the CLI login, exactly as the credential smoke does.
 */
async function ownerSessionSmoke(input: {
  io: Io;
  url: string;
  rest: readonly string[];
  guard: GuardOk;
  steps: ReturnType<typeof planSmoke>;
  reportPath: string | undefined;
  guided: () => string;
  browser?: SmokeBrowser;
  sleep?: (ms: number) => Promise<void>;
}): Promise<number> {
  const { io, url, rest, guard, steps, reportPath } = input;
  const base = assertSmokeUrl(url);
  const fnBase = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
  const blocked = (lines: string[]): number => {
    const blocker = `not-signed-in ${fnBase}`;
    io.stdout(`c2c-blocker: ${blocker}\n`);
    writeSmokeReport(reportPath, { version: 'c2c-smoke-report/1', ok: false, session: 'owner', blocker, lines });
    return SMOKE_BLOCKED_EXIT;
  };
  const browser = input.browser ?? cdpBrowser(flag(rest, '--browser-cdp') ?? 'http://127.0.0.1:9222');
  let page: Awaited<ReturnType<typeof openOnOrigin>>;
  try {
    page = await openOnOrigin(browser, `${fnBase}/`, input.sleep ? { sleep: input.sleep } : {});
  } catch (err) {
    io.stderr(`c2c: could not reach the browser over CDP: ${err instanceof Error ? err.message : 'connection failed'}; check --browser-cdp <endpoint>\n`);
    io.stdout(input.guided());
    return 1;
  }
  if (!page) return blocked([`the browser tab did not stay on ${base.origin} (a sign-in redirect)`]);
  try {
    const inPage = pageFetch(page);
    const fetchVia: FetchLike = (target, init) => (new URL(target).origin === base.origin ? inPage(target, init) : io.fetch(target, init));
    let scopePromise: Promise<{ org: string; projectId: string; token: string }> | undefined;
    const scope = () => (scopePromise ??= resolveScope(io, guard.org, guard.projectId));
    const result = await executeSmoke(steps, {
      fetch: fetchVia,
      base: fnBase,
      auth: {},
      browserSession: true,
      dc: guard.dc,
      catalystBase: flag(rest, '--catalyst-base') ?? catalystBaseFor(guard.dc),
      scope,
    });
    for (const line of result.lines) io.stdout(`${line}\n`);
    if (result.notSignedIn) return blocked(result.lines);
    writeSmokeReport(reportPath, { version: 'c2c-smoke-report/1', ok: result.ok, session: 'owner', lines: result.lines });
    return result.ok ? 0 : 1;
  } finally {
    await page.close();
  }
}

/**
 * The Slate URL the deploy reported, for invite redirect_url — only when the
 * report names this project. A report for another project is refused outright:
 * its appUrl would mail invite links that land on the wrong app's Slate host.
 * Silent only when there is no report at all.
 */
function usersSlateUrl(target: string, projectId: string): string | undefined {
  const beside = statSync(target, { throwIfNoEntry: false })?.isDirectory() ? target : dirname(target);
  let foreign: string | undefined;
  for (const dir of [beside, process.cwd()]) {
    const path = join(dir, DEPLOY_REPORT);
    if (!existsSync(path)) continue;
    try {
      const report = parseJsonExact(readFileSync(path, 'utf8')) as { projectId?: unknown; slate?: { appUrl?: unknown } };
      if (report?.projectId !== projectId) {
        foreign = path;
        continue;
      }
      const appUrl = report.slate?.appUrl;
      if (typeof appUrl === 'string' && slateHost(appUrl)) return `https://${slateHost(appUrl)}`;
    } catch {
      // A report that does not parse is ignored here — a missing redirect is a pending step, not a plan failure.
    }
  }
  if (foreign) {
    throw new GuardError(
      'configuration',
      `the deploy report ${foreign} is for another project — its appUrl cannot supply redirect_url for ${projectId}; pass --slate-domain <host> instead`,
    );
  }
  return undefined;
}

function usersRoleIds(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of String(flag(args, '--role-ids') ?? '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const id = pair.slice(eq + 1).trim();
    if (!name) continue;
    if (!/^[0-9]+$/.test(id)) throw new Error(`--role-ids: ${name} needs a decimal role id`);
    out[name] = id;
  }
  return out;
}

/**
 * `c2c users` — the app users a Creator backup carries, mapped to Catalyst
 * roles and invited with redirect_url = the Slate app URL.
 *
 *   c2c users plan   --source-backup <zip|dir> --ds <file|dir> [--out <dir>] [--state <file>] [--salt <s>] [--social <a,b>] [--json]
 *   c2c users invite --source-backup <zip|dir> --ds <file|dir> --project <id> --org <org> [--slate-domain <host>] [--role-ids <n=id,...>] [--state <file>] [--salt <s>] --confirm
 *
 * The plan is the default and writes no identity: every file and line names a
 * user by usr_<hash>. invite sends POST /project-user per pending user and
 * records each landed invite in the state file so a re-run skips them.
 */
export async function usersCli(args: readonly string[], io: Io): Promise<number> {
  const [sub, ...rest] = args;
  const source = flag(rest, '--source-backup');
  const ds = flag(rest, '--ds');
  if ((sub !== 'plan' && sub !== 'invite') || !source || !ds) {
    io.stderr(
      'usage: c2c users plan --source-backup <zip|dir> --ds <file|dir> [--app <link>] [--out <dir>] [--state <file>] [--salt <s>] [--social <a,b>] [--json]\n' +
        '       c2c users invite --source-backup <zip|dir> --ds <file|dir> --project <id> --org <org> [--app <link>] [--slate-domain <host>] [--role-ids <name=id,...>] [--state <file>] [--salt <s>] --confirm [--projects <file>] [--dc <dc>] [--config <c2c-deploy.json>]\n' +
        '       identities are read from the backup at run time only; plans and reports name users by usr_<hash> id\n' +
        '       invite sends POST /project-user per pending user (the console Add User call) with redirect_url = the Slate app URL\n',
    );
    return 2;
  }
  if (rest.includes('--dry-run')) {
    io.stderr('c2c: users does not take --dry-run; plan is the default and invite needs --confirm\n');
    return 2;
  }
  try {
    const app = loadApp(ds);
    const named = flag(rest, '--app');
    const appLink = named ?? app.name?.trim();
    if (!appLink) throw new GuardError('name-mismatch', 'application name is missing');
    if (named && app.name?.trim() !== named) throw new GuardError('name-mismatch', 'application name does not match --app');
    const out = flag(rest, '--out');
    const statePath = flag(rest, '--state') ?? join(out ?? 'c2c-out', USERS_STATE_FILE);
    const state = readUsersState(statePath);
    // Salt custody: the value lives only in the state file. A stored salt is
    // reused verbatim; --salt/C2C_USERS_SALT overrides nothing once stored.
    // With no stored salt and none passed, a fresh random 256-bit salt is
    // minted — prior run ids then cannot match, so that is said on stderr.
    const explicitSalt = flag(rest, '--salt') ?? io.env.C2C_USERS_SALT;
    let salt: string;
    if (state?.salt) {
      if (explicitSalt && explicitSalt !== state.salt) {
        throw new GuardError('configuration', `${statePath} was written with a different salt — pass the same --salt or a fresh --state`);
      }
      salt = state.salt;
    } else if (explicitSalt) {
      salt = explicitSalt;
      if (state) {
        io.stderr(`c2c: ${statePath} has no salt — recording this run's salt; user ids from an earlier run will not match\n`);
      }
    } else {
      salt = newUsersSalt();
      io.stderr(
        state
          ? `c2c: ${statePath} has no salt — a fresh random salt was generated and stored; user ids from an earlier run will not match\n`
          : `c2c: no users state file yet — a fresh random salt was generated and stored in ${statePath}; user ids from an earlier run will not match\n`,
      );
    }
    const social = parseSocialList(flag(rest, '--social'));
    const backupUsers = readBackupUsers(source);
    const plan = usersPlan(app, backupUsers, { salt, invited: new Set((state?.invited ?? []).map((entry) => entry.id)), social });
    // Keep the salt (and any previously invited ids) in the state file so the
    // next run reuses them — nothing else may carry the salt.
    writeUsersState(statePath, { version: 1, project: state?.project ?? '', salt, invited: state?.invited ?? [] });

    if (sub === 'plan' || !rest.includes('--confirm')) {
      if (out) {
        mkdirSync(out, { recursive: true });
        for (const file of [
          { path: USERS_PLAN_JSON, data: usersPlanJson(plan) },
          { path: USERS_PLAN_MD, data: usersPlanMarkdown(plan) },
          { path: USERS_INVITES_CSV, data: usersInvitesCsv(plan) },
        ]) {
          const dest = join(out, file.path);
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, file.data);
        }
        io.stdout(`users plan written to ${out}/users (plan.json, plan.md, invites.csv)\n`);
      } else {
        io.stdout(rest.includes('--json') ? usersPlanJson(plan) : usersPlanMarkdown(plan));
      }
      if (sub === 'invite') io.stderr('c2c: invite is a dry print without --confirm; nothing was sent\n');
      return 0;
    }

    // invite --confirm: the live driver. Same guards as deploy; the driver is
    // io.rest in production and a fake in tests.
    const guard = await prepareGuard(ds, rest, appLink, io);
    if (state && state.project && state.project !== guard.projectId) {
      throw new GuardError('configuration', `${statePath} is a users state file for project ${state.project} — refusing to reuse it for ${guard.projectId}; pass a fresh --state`);
    }
    const slateFlag = flag(rest, '--slate-domain');
    if (slateFlag !== undefined && !slateHost(slateFlag)) throw new Error('--slate-domain must be a Slate app host — a bare hostname or the https App Url slate:link prints');
    const redirectUrl = slateFlag ? `https://${slateHost(slateFlag)}` : usersSlateUrl(ds, guard.projectId);
    const planned = new Map(plan.users.map((user) => [user.id, user.role]));
    const seen = new Set<string>();
    const targets: InviteTarget[] = backupUsers
      .map((user) => {
        const id = userRefId(user.identity.trim().toLowerCase(), salt);
        return { id, role: planned.get(id) ?? '', identity: user.identity, first: user.first, last: user.last };
      })
      .filter((target) => {
        // Users not in the plan (inactive, no identity) carry no role and are
        // never targets; a duplicate row in the backup dedupes to one target.
        if (!target.role || seen.has(target.id)) return false;
        seen.add(target.id);
        return true;
      });
    await assertLiveProject(io, guard.org, guard.projectId);
    await resolveScope(io, guard.org, guard.projectId);
    const restFn: RestFn = io.rest ?? ((call: RestCall) => catalystRestCall(io.env, guard.org, guard.projectId, call, { log: (line) => io.stderr(`${line}\n`) }));
    const result = await inviteUsers(restFn, {
      projectId: guard.projectId,
      targets,
      prior: state?.invited ?? [],
      roleIds: usersRoleIds(rest),
      ...(redirectUrl ? { redirectUrl } : {}),
      persist: (invited) => writeUsersState(statePath, { version: 1, project: guard.projectId, salt, invited }),
      retry: retryLog(io),
    });
    writeUsersState(statePath, { version: 1, project: guard.projectId, salt, invited: result.invited });
    io.stdout(formatInviteResult(result));
    return result.ok ? 0 : 1;
  } catch (err) {
    return fail(io, err);
  }
}
