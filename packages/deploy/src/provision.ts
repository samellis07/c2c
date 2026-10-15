/**
 * `c2c provision` drives provision/plan.json to done.
 *
 * Layout under --out:
 *   provision/plan.json     steps {id, via: cli|mcp|console, tool|command, args, readBack:{via, tool|command, match}}
 *   provision/state.json    checkpoint; rewritten atomically after each change
 *   provision/results/      recorded read-back JSON per step
 *   provision/inputs.json   what the plan cannot know (slate domain, user emails, sender)
 *   provision/tables.json   the table-create diff spec for --run tables
 *   provision/crons.json    per-schedule cron specs for --run crons
 *
 * c2c never calls MCP. `via: mcp` steps are emitted verbatim (tool + JSON args)
 * for the host agent; the agent calls the tool, calls the read-back tool, and
 * records the result with --record. Console steps are the user's clicks. c2c
 * runs only `via: cli` steps (--run), through the customer's CLI token.
 *
 * Every step follows list → match → create-missing: when the recorded read-back
 * already matches, the step is `existing` and nothing is written. A step is
 * `done` only after its read-back matches following a write by this run.
 * Tokens never enter this file: CLI calls go through the injected io.rest (the
 * production io.rest wraps the Catalyst CLI's own authenticated client).
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slateHost } from '../../auth/src/slate-host.js';
import { assertLiveProject, flag, type Io } from './cli.js';
import { resolveProvisionScope, type ProvisionScope } from './provision-config.js';
import { CUSTOMER_STEPS } from './customer-steps.js';
import { parseJsonExact } from './json-exact.js';
import { AUTH_RE, catalystRestCall, EMAIL_RE, hasParamSecret, HEX_B64_TOKEN_RE, JWT_RE, listCatalystProjects, PARAM_SECRET_RE, readCliAccessToken, redactString, renewCliAccessToken, SAFE_CODE_KEY_RE, URL_RE, ZOHO_TOKEN_RE } from './rest.js';
export { redactString };
import { catalystBaseFor, dcEndpoints } from './dc.js';
import { catalystScopeArgs, scrubCatalystEnv } from './scope.js';
import { isExactGrantList, isPerRowGrantMatch, PLAN_CLI_PATH, PLAN_EMITTED_CLI_PATHS, PLAN_STEP_TOOL, PLAN_STEP_TOOLS, STEP_KINDS, sha256, type ProvisionStep, type StepEndpoint } from './offline-plan.js';
import { readConnectionSecretKeys, writeOrUpdateFunctionEnv } from './function-env.js';
import { connectionSecretItem } from './human-steps.js';
import { applyTablePlan, type RestCall, type RestFn, type RestResult, type TableCreateStep } from './tables.js';
import { restWithRetry, spawnWithRetry, type ReRead, type RestRetry, type RetryOptions } from './retry.js';
import { assertProtectedProject } from './guards.js';
import { checkGate, gateConsoleLine, gateForStep, type FirstUseGate, type GateCheck } from './first-use.js';
import { iacImportBundle, runProjectImport, ImportEndedError, StuckImportError, type ImportFetch } from './iac-import.js';

const USAGE =
  'usage: c2c provision --out <dir> [--status | --next | --confirm --run <id> | --record <id> [--result <file>] [--applied]]\n' +
  '                     [--dc <dc>] [--org <id>] [--project <id>] [--config <file>] [--domain <host>]\n' +
  '                     [--name <project-name>  (--run import only: the name the import creates)]\n';

/** A project name the import may create: lower-case letters, digits and dashes. */
const IMPORT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export interface ProvisionPlanFile {
  version: 1;
  app: string;
  dc?: string;
  steps: ProvisionStep[];
  connectionSecretKeys?: string[];
}

export type StepStatus = 'pending' | 'applied' | 'done' | 'existing';

export interface StepRecord {
  status: 'applied' | 'done' | 'existing';
  at: string;
  /** true when this run actually wrote (created/enabled/invited); false when the run found nothing missing. */
  applied: boolean;
  /** Recorded evidence, relative to --out. */
  result?: string;
  /** sha256 of the resolved read-back match at record time — a changed inputs.json revalidates the stored evidence against the moved match. */
  matchSha256?: string;
}

export interface ProvisionState {
  version: 1;
  app: string;
  planSha256: string;
  learned: {
    projectId?: string;
    /** The project name the import actually used ("<name>-2" on a clash). */
    importName?: string;
    /** Import attempts by name — a stuck import keeps its name blocked, so a retry never reuses it. */
    imports?: Record<string, { importId?: string; status: 'completed' | 'stuck' }>;
    byName: Record<string, string>;
  };
  steps: Record<string, StepRecord>;
}

interface ProvisionInputs {
  slateDomain?: string;
  senderEmail?: string;
  users?: { email_id: string; role?: string; role_id?: string; first_name?: string; last_name?: string }[];
  /** The project name the user chose for a manual import (fallback for <import-name>). */
  projectName?: string;
}

interface Ctx {
  out: string;
  plan: ProvisionPlanFile;
  state: ProvisionState;
  scope: ProvisionScope;
  inputs: ProvisionInputs;
  domainFlag?: string;
  /** --name: the project name `--run import` creates instead of the planned one. */
  importName?: string;
  io: Io;
  now: () => string;
  rest?: RestFn;
}

const STATE_PATH = ['provision', 'state.json'];
const RESULTS_DIR = ['provision', 'results'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// plan + state files

/** Generated side files pinned alongside plan.json: a change under a resumed state is refused like a plan change. inputs.json is deliberately not pinned — the customer fills it in after planning; its consumers revalidate instead. */
const PINNED_SIDE_FILES = ['tables.json', 'crons.json'] as const;

/** Tools whose read-back is a per-row grant list. Anything else on these tools is presence-only. */
const GRANT_TOOLS = new Set<string>([
  PLAN_STEP_TOOL.updateTablePermissions,
  PLAN_STEP_TOOL.getTablePermissions,
  PLAN_STEP_TOOL.updateTableScopes,
  PLAN_STEP_TOOL.getTableScopes,
]);
const PLAN_VIAS = new Set(['cli', 'mcp', 'console']);
const REPLAN = 're-run c2c plan into a fresh --out';

/** `undefined` when the field is absent, the canonical name when it is allowed, `null` otherwise. */
function canonicalTool(tool: unknown): string | undefined | null {
  if (tool === undefined) return undefined;
  if (typeof tool !== 'string') return null;
  const name = tool.normalize('NFKC').trim();
  return PLAN_STEP_TOOLS.includes(name) ? name : null;
}

function toolProblem(stepId: string, where: string, via: unknown, tool: unknown): string | undefined {
  if (typeof via !== 'string' || !PLAN_VIAS.has(via)) {
    return `provision/plan.json: step ${stepId} ${where}via ${JSON.stringify(via)} is not one c2c plan emits; ${REPLAN}`;
  }
  const name = canonicalTool(tool);
  if (name === null) {
    const shown = typeof tool === 'string' ? tool.normalize('NFKC').trim() : typeof tool;
    return `provision/plan.json: step ${stepId} ${where}tool ${JSON.stringify(shown)} is not one c2c plan emits; ${REPLAN}`;
  }
  if (via === 'mcp' && name === undefined) {
    return `provision/plan.json: step ${stepId} ${where}has no tool c2c plan emits; ${REPLAN}`;
  }
  return undefined;
}

/** A string c2c would send as a URL path. Only a plan template is accepted. */
function pathLike(text: string): boolean {
  return text.startsWith('/') || text.includes('://') || text.includes('%') || text.includes('..');
}

function foreignArgsError(stepId: string, value: unknown, where: string): string | undefined {
  const walk = (node: unknown, top: boolean): string | undefined => {
    if (typeof node === 'string') {
      if (pathLike(node) && !PLAN_EMITTED_CLI_PATHS.includes(node)) return 'a path is not one c2c plan builds';
      return undefined;
    }
    if (Array.isArray(node)) {
      if (node.some((item) => Array.isArray(item))) return 'nested lists are not an argument c2c plan emits';
      for (const item of node) {
        const err = walk(item, false);
        if (err) return err;
      }
      return undefined;
    }
    if (!isRecord(node)) return undefined;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'url') return 'url is not an argument c2c plan emits';
      if (key === 'argv' && !(top && Array.isArray(child) && child.length === 1 && child[0] === 'apig:enable')) {
        return 'argv is not an argument c2c plan emits';
      }
      const err = walk(child, false);
      if (err) return err;
    }
    return undefined;
  };
  const err = walk(value, true);
  return err ? `provision/plan.json: step ${stepId} ${where}: ${err}; ${REPLAN}` : undefined;
}

function sameKeys(args: Record<string, unknown>, keys: readonly string[]): boolean {
  const got = Object.keys(args).sort();
  const want = [...keys].sort();
  return got.length === want.length && got.every((key, index) => key === want[index]);
}

function isSignupBody(body: unknown): boolean {
  return isRecord(body) && Object.keys(body).length === 1 && body.public_signup === false;
}

/** The cors-domain body `c2c plan` writes. `domain` is the token filled from --domain or inputs; iframe stays on — the embedded sign-in frame needs it. */
function isCorsBody(body: unknown): boolean {
  return (
    isRecord(body) &&
    Object.keys(body).length === 3 &&
    body.domain === '<slate-app-url-host>' &&
    body.cors === true &&
    body.iframe === true
  );
}

const POST_BODY: Record<string, (body: unknown) => boolean> = {
  [PLAN_CLI_PATH.authHosted]: isSignupBody,
  [PLAN_CLI_PATH.authEmbedded]: isSignupBody,
  [PLAN_CLI_PATH.corsDomain]: isCorsBody,
};

function callShapeError(call: unknown, methods: readonly string[]): string | undefined {
  if (!isRecord(call)) return 'call must be an object';
  if (Object.keys(call).some((key) => key !== 'method' && key !== 'path' && key !== 'body')) return 'call has a field c2c plan does not emit';
  if (typeof call.method !== 'string' || !methods.includes(call.method)) return `call method must be ${methods.join(' or ')}`;
  if (typeof call.path !== 'string' || !PLAN_EMITTED_CLI_PATHS.includes(call.path)) return 'call path is not one c2c plan builds';
  if (call.method === 'GET') return 'body' in call ? 'a GET call has no body' : undefined;
  const check = POST_BODY[call.path];
  if (!check) return 'that path is not a POST c2c plan emits';
  if (!check(call.body)) return 'call body is not the body c2c plan emits';
  return undefined;
}

/** Cli args must be one of the shapes `c2c plan` writes. Any other field refuses. */
function cliArgsError(stepId: string, args: Record<string, unknown>, readBack: boolean): string | undefined {
  const where = readBack ? 'read-back ' : '';
  const fail = (detail: string) => `provision/plan.json: step ${stepId} ${where}arguments are not a shape c2c plan emits (${detail}); ${REPLAN}`;
  if (Object.keys(args).length === 0) return undefined;
  if (readBack) {
    if (!sameKeys(args, ['call'])) return fail('a read-back is a GET call');
    const detail = callShapeError(args.call, ['GET']);
    if (!detail) return undefined;
    if (detail.includes('method')) return `provision/plan.json: step ${stepId} read-back must be a GET of a path c2c plan builds; ${REPLAN}`;
    return fail(detail);
  }
  if (sameKeys(args, ['argv'])) {
    const argv = args.argv;
    if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== 'apig:enable') return fail('argv is not apig:enable');
    return undefined;
  }
  if (sameKeys(args, ['app', 'dir', 'environment', 'name']) || sameKeys(args, ['app', 'dir', 'environment', 'name', 'note'])) {
    if (stepId !== 'import') return fail('import arguments on a step that is not import');
    const fields = [args.app, args.dir, args.environment, args.name, args.note].filter((value) => value !== undefined);
    if (fields.some((value) => typeof value !== 'string')) return fail('import spec fields are strings');
    // The import packs exactly the tree c2c plan generated — nothing else.
    if (args.dir !== 'provision/iac') return fail('dir is provision/iac');
    return undefined;
  }
  if (sameKeys(args, ['plan', 'tables'])) {
    if (args.plan !== 'provision/tables.json' || !Array.isArray(args.tables) || args.tables.some((item) => typeof item !== 'string')) return fail('tables spec');
    return undefined;
  }
  if (sameKeys(args, ['plan', 'schedules', 'enabled'])) {
    if (args.plan !== 'provision/crons.json' || typeof args.schedules !== 'number' || typeof args.enabled !== 'boolean') return fail('crons spec');
    return undefined;
  }
  if (sameKeys(args, ['invites', 'spec'])) {
    if (typeof args.invites !== 'number' || typeof args.spec !== 'string') return fail('users spec');
    return undefined;
  }
  if (sameKeys(args, ['call'])) {
    const detail = callShapeError(args.call, ['GET', 'POST']);
    if (!detail) return undefined;
    if (isRecord(args.call) && args.call.method !== 'GET' && args.call.method !== 'POST') {
      return `provision/plan.json: step ${stepId} call method must be GET or POST; ${REPLAN}`;
    }
    return fail(detail);
  }
  return fail('unknown fields');
}

/** When a grant tool carries `calls`, each body value is a grant-word list. */
function grantArgsOk(args: Record<string, unknown> | undefined): boolean {
  if (!args || args.calls === undefined) return true;
  if (!Array.isArray(args.calls)) return false;
  return args.calls.every((call) => {
    if (!isRecord(call)) return false;
    if (call.body === undefined) return true;
    if (!isRecord(call.body) || Object.keys(call.body).length === 0) return false;
    return Object.values(call.body).every(isExactGrantList);
  });
}

/**
 * A step is accepted only when its id matches one kind `c2c plan` emits, every
 * via/tool field equals that kind, and the match passes that kind's validator.
 * A non-grant kind rejects a match that contains a grant word.
 */
function stepKindError(step: ProvisionStep): string | undefined {
  const kind = STEP_KINDS.find((item) => item.pattern.test(step.id));
  if (!kind) return `provision/plan.json: step ${step.id} is not a step c2c plan emits; ${REPLAN}`;
  const write = canonicalTool(step.tool);
  const read = canonicalTool(step.readBack.tool);
  if (write === null || read === null) return undefined;
  if (step.via !== kind.via || step.readBack.via !== kind.readBack.via || write !== kind.tool || read !== kind.readBack.tool) {
    return `provision/plan.json: step ${step.id} is not the via/tool pair c2c plan emits for that step; ${REPLAN}`;
  }
  const grant = (!!kind.tool && GRANT_TOOLS.has(kind.tool)) || (!!kind.readBack.tool && GRANT_TOOLS.has(kind.readBack.tool));
  if (!kind.validateMatch(step.readBack.match) || (grant && (!grantArgsOk(step.args) || !grantArgsOk(step.readBack.args)))) {
    if (grant) {
      return `provision/plan.json: step ${step.id} carries a grant match that is not a per-row list of grant words — grant read-backs must key <id:Table> → {role: [exact set]}; ${REPLAN}`;
    }
    return `provision/plan.json: step ${step.id} read-back match is not the shape c2c plan emits for that step; ${REPLAN}`;
  }
  return undefined;
}

const CLI_TEMPLATES = new Set<string>(Object.values(PLAN_CLI_PATH));

/** The request path c2c sends: a known template with the project id filled in. */
function materialiseCliPath(template: string, projectId: string): string {
  if (!CLI_TEMPLATES.has(template)) throw new Error('call path is not one c2c plan builds');
  if (!/^[0-9]+$/.test(projectId)) throw new Error('refusing a path outside the project');
  return template.replaceAll('<project>', projectId);
}

const PLAN_FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Parse plan JSON and refuse `__proto__`, `constructor` and `prototype` keys anywhere in it. */
function parsePlanJson(raw: string): unknown {
  return JSON.parse(raw, (key, value) => {
    if (PLAN_FORBIDDEN_KEYS.has(key)) {
      throw new Error(`provision/plan.json: key ${JSON.stringify(key)} is not one c2c plan emits; ${REPLAN}`);
    }
    return value;
  });
}

function loadProvisionPlan(out: string): { plan: ProvisionPlanFile; sha: string } {
  const path = join(out, 'provision', 'plan.json');
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`no provision/plan.json under --out (run c2c plan --out ${out} first)`);
  }
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = parsePlanJson(raw);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('provision/plan.json:')) throw err;
    throw new Error('provision/plan.json is not valid JSON');
  }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.app !== 'string' || !Array.isArray(parsed.steps)) {
    throw new Error('provision/plan.json is not a version-1 provision plan');
  }
  for (const step of parsed.steps as ProvisionStep[]) {
    if (!isRecord(step) || typeof step.id !== 'string' || !isRecord(step.args) || !isRecord(step.readBack)) {
      throw new Error(`provision/plan.json: step ${isRecord(step) ? String(step.id) : '?'} is malformed`);
    }
    const toolErr =
      toolProblem(step.id, '', step.via, step.tool) ?? toolProblem(step.id, 'read-back ', step.readBack.via, step.readBack.tool);
    if (toolErr) throw new Error(toolErr);
    const argsErr =
      foreignArgsError(step.id, step.args, 'arguments') ??
      (step.readBack.args ? foreignArgsError(step.id, step.readBack.args, 'read-back arguments') : undefined);
    if (argsErr) throw new Error(argsErr);
    if (step.via === 'cli') {
      const cliErr = cliArgsError(step.id, step.args, false);
      if (cliErr) throw new Error(cliErr);
    }
    if (step.readBack.via === 'cli') {
      const cliErr = cliArgsError(step.id, step.readBack.args ?? {}, true);
      if (cliErr) throw new Error(cliErr);
    }
    const kindErr = stepKindError(step);
    if (kindErr) throw new Error(kindErr);
  }
  // The state pins plan.json plus every generated side file that exists right
  // now, in a fixed order. A missing file contributes nothing — if one appears
  // later the hash changes and the state is refused. inputs.json never feeds
  // this hash: it is customer input, revalidated per recorded step instead.
  let tree = raw;
  for (const name of PINNED_SIDE_FILES) {
    const side = join(out, 'provision', name);
    if (statSync(side, { throwIfNoEntry: false })?.isFile()) tree += `\n-- ${name}\n${readFileSync(side, 'utf8')}`;
  }
  // The import bundle is pinned too: a changed template or code zip under a
  // resumed state is refused like a plan change.
  const iacDir = join(out, 'provision', 'iac');
  if (statSync(iacDir, { throwIfNoEntry: false })?.isDirectory()) {
    const files: string[] = [];
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(iacDir, rel)).sort()) {
        const p = rel ? `${rel}/${entry}` : entry;
        // lstat: a linked directory is hashed as a file entry, so a symlink
        // points the pin (and the import) at a failing read, not a hidden tree.
        if (lstatSync(join(iacDir, p)).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk('');
    for (const file of files) tree += `\n-- iac/${file}\nsha256:${sha256(readFileSync(join(iacDir, file)))}`;
  }
  return { plan: parsed as unknown as ProvisionPlanFile, sha: sha256(tree) };
}

function readProvisionState(out: string): ProvisionState | undefined {
  const path = join(out, ...STATE_PATH);
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as ProvisionState;
  } catch {
    throw new Error('provision/state.json is corrupt — delete it (or restore a backup); a silent reset would lose every recorded read-back');
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.steps)) {
    throw new Error('provision/state.json is not a version-1 provision state — delete it (or restore a backup)');
  }
  return parsed as unknown as ProvisionState;
}

/** Atomic enough for a kill mid-write: tmp file in the same directory, then rename. */
function writeProvisionState(out: string, state: ProvisionState): void {
  const dir = join(out, 'provision');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.state.json.tmp.${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, join(dir, 'state.json'));
}

function readProvisionInputs(out: string): ProvisionInputs {
  const path = join(out, 'provision', 'inputs.json');
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('provision/inputs.json is not valid JSON');
  }
  if (!isRecord(parsed)) throw new Error('provision/inputs.json must be a JSON object');
  if (parsed.users !== undefined && !Array.isArray(parsed.users)) throw new Error('provision/inputs.json: users must be a list');
  if (parsed.projectName !== undefined && typeof parsed.projectName !== 'string') throw new Error('provision/inputs.json: projectName must be a string');
  // A 17-digit role id written as a JSON number was rounded by the parse
  // above; only a quoted decimal string reaches the invite body unchanged.
  for (const user of (parsed.users ?? []) as unknown[]) {
    if (isRecord(user) && user.role_id !== undefined && !(typeof user.role_id === 'string' && /^[0-9]+$/.test(user.role_id))) {
      throw new Error('provision/inputs.json: role_id must be a quoted decimal string, never a JSON number — a 17-digit number is rounded');
    }
  }
  // slateDomain lands verbatim in the cors-domain body and redirect_url —
  // the file is user input, so it answers to the same host rule as --domain.
  // The generated "" placeholder is still unfilled; anything else must parse.
  if (parsed.slateDomain !== undefined) {
    if (typeof parsed.slateDomain !== 'string' || (parsed.slateDomain.trim() && !slateHost(parsed.slateDomain))) {
      throw new Error('provision/inputs.json: slateDomain must be a Slate app host — a bare hostname or the https App Url slate:link prints');
    }
    parsed.slateDomain = parsed.slateDomain.trim() ? slateHost(parsed.slateDomain) : undefined;
  }
  return parsed as ProvisionInputs;
}

// ---------------------------------------------------------------------------
// evidence hygiene: a recorded read-back, state.json and anything printed must
// never carry an email, a URL, a token or a person field — the same rules as
// the doctor evidence validator, applied as redaction so the stored proof
// stays usable.

const SENSITIVE_VALUE_RE = new RegExp(`(?:${URL_RE.source}|${AUTH_RE.source}|${JWT_RE.source}|${EMAIL_RE.source}|${ZOHO_TOKEN_RE.source}|${PARAM_SECRET_RE.source}|${HEX_B64_TOKEN_RE.source})`, 'i');
/** A secret-named key — and everything nested under it — is never evidence. `code` matches inside _-compounds (auth_code, code_verifier) and camelCase (authCode) too. */
const SECRET_KEY_RE =
  /token|secret|passw|pw|authorization|api[-_]?key|private[-_]?key|access[-_]?key|signature|session|credential|cookie|bearer|jwt|otp|(?:^|[-_]|[a-z])code(?:$|[-_]|[A-Z])/i;

/**
 * Person data is never evidence: a read-back row can carry who created or
 * modified a resource, or describe a user of the project — none of that is
 * what the match needs. Attribution blocks go whole; the attributes of a
 * person (name parts, mail addresses, person ids, phones) go leaf by leaf.
 */
const PERSON_BLOCK_RE =
  /^(?:(?:created|modified|updated|deleted|added|invited|uploaded|owned|approved|rejected|assigned|registered|requested|authored|posted)_?by|owners?|creators?|authors?|assignees?|modifiers?|inviters?|user_?details|person_?details)$/i;
const PERSON_FIELD_RE =
  /^(?:first_?name|last_?name|middle_?name|full_?name|display_?name|given_?name|family_?name|nick_?name|user_?name|(?:e_?mail|email)(?:s|_?ids?|_?address)?|user_?ids?|zuid|person_?ids?|phones?|phone_?numbers?|mobiles?|mobile_?numbers?|telephones?|contact_?numbers?|fax)$/i;

/**
 * Deep copy with every person entry dropped at any depth. A record holding a
 * person attribute is itself about a person — a bare `name` leaf on such a row
 * is the person's name, not a resource name, so it goes too. `role_name`,
 * `project_name` and the like stay: they are what the match runs against.
 */
function stripPersonFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPersonFields);
  if (!isRecord(value)) return value;
  const personRow = Object.keys(value).some((key) => PERSON_FIELD_RE.test(key));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (PERSON_BLOCK_RE.test(key) || PERSON_FIELD_RE.test(key) || (personRow && /^name$/i.test(key))) continue;
    out[key] = stripPersonFields(child);
  }
  return out;
}

/** Deep copy with every email, URL and token-shaped string masked; secret-named keys hold only a marker; person entries are dropped. */
export function redactEvidence(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(stripPersonFields(value) as Record<string, unknown>)) {
      out[redactString(key)] = SECRET_KEY_RE.test(key) && !SAFE_CODE_KEY_RE.test(key) ? '<redacted>' : redactEvidence(child);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Project read-backs are reduced before they are matched, learned or stored:
// the answer lists every project in the org, and a hand-supplied --result can
// carry fields that hold another project's secrets. Only the target project entry survives —
// matched on the configured id or the name the plan asks for — with every
// secret-named field and every token-shaped value dropped at any depth.

/** Field names a project entry must never carry to disk: secrets, keys, client ids and auth blocks. */
const PROJECT_SECRET_FIELD_RE =
  /token|secret|passw|pw|authorization|key|client[-_]?id|signature|session|credential|cookie|bearer|jwt|otp|auth|(?:^|[-_]|[a-z])code(?:$|[-_]|[A-Z])/i;

/** A record holding an own id/name leaf is a project entry in the listing. */
function isProjectEntry(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.entries(value).some(([key, leaf]) => IDENTITY_FIELD_RE.test(key) && !isRecord(leaf) && !Array.isArray(leaf));
}

/**
 * The entry is the target when every known half of the target holds: when both
 * a configured id and a wanted name exist, both must match — a same-named
 * project under a different id is not the configured target.
 */
function projectEntryMatches(entry: Record<string, unknown>, target: { id?: string; name?: string }): boolean {
  const idHit =
    target.id !== undefined &&
    Object.entries(entry).some(([key, leaf]) => /^(?:[-\w]*_?id|zaid)$/i.test(key) && !isRecord(leaf) && !Array.isArray(leaf) && looseScalar(leaf, target.id));
  const nameHit =
    target.name !== undefined &&
    Object.entries(entry).some(([key, leaf]) => /^[-\w]*_?name$/i.test(key) && !isRecord(leaf) && !Array.isArray(leaf) && looseScalar(leaf, target.name));
  if (target.id !== undefined && target.name !== undefined) return idHit && nameHit;
  return idHit || nameHit;
}

/** Drop secret-named fields and token-shaped values at any depth of a kept entry. */
function scrubProjectEntry(value: unknown): unknown {
  if (typeof value === 'string') return SENSITIVE_VALUE_RE.test(value) || hasParamSecret(value) ? undefined : value;
  if (Array.isArray(value)) {
    return value.map(scrubProjectEntry).filter((item) => item !== undefined);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (PROJECT_SECRET_FIELD_RE.test(key) && !SAFE_CODE_KEY_RE.test(key)) continue;
      const scrubbed = scrubProjectEntry(child);
      if (scrubbed !== undefined) out[key] = scrubbed;
    }
    return out;
  }
  return value;
}

/**
 * Keep only the target project entry wherever a project list sits in the
 * read-back (a bare array, or under `projects`/`data`). Every entry is
 * scrubbed of secret fields; a list entry that is not the target is dropped
 * whole. No target match anywhere means an empty list, which fails the
 * read-back match and keeps the step open — nothing is stored. `matched`
 * counts the entries the target bound: more than one is ambiguous (a
 * same-named pair when no project id is configured) and the record must
 * refuse rather than learn whichever id came last.
 */
function reduceProjectReadBack(result: unknown, target: { id?: string; name?: string }): { reduced: unknown; matched: number } {
  let matched = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      if (node.some(isProjectEntry)) {
        return node
          .filter((item) => {
            const hit = isProjectEntry(item) && projectEntryMatches(item, target);
            if (hit) matched += 1;
            return hit;
          })
          .map(scrubProjectEntry);
      }
      return node.map(walk);
    }
    if (isRecord(node)) {
      if (isProjectEntry(node)) {
        const hit = projectEntryMatches(node, target);
        if (hit) matched += 1;
        return hit ? scrubProjectEntry(node) : {};
      }
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) out[key] = walk(child);
      return out;
    }
    return node;
  };
  return { reduced: walk(result), matched };
}

// ---------------------------------------------------------------------------
// read-back matching

function looseScalar(leaf: unknown, expected: unknown): boolean {
  if (leaf === expected) return true;
  if (typeof expected === 'string' || typeof expected === 'number' || typeof expected === 'boolean') {
    if (typeof leaf === 'string' || typeof leaf === 'number' || typeof leaf === 'boolean') return String(leaf) === String(expected);
  }
  return false;
}

/**
 * Inside a bound node, `item` must be the node's own value (scalar), an array
 * element, an object key (role names arrive as keys), or a leaf under an
 * identity field (a *_name / *_id / domain / email_address). A leaf under an
 * unrelated field — a description, a granted/denied wrapper — never counts.
 */
const IDENTITY_FIELD_RE = /^(?:[-\w]*_?(?:id|name)|domain|email(?:_address)?)$/i;
function boundHolds(node: unknown, item: unknown): boolean {
  if (Array.isArray(node)) return node.some((leaf) => boundHolds(leaf, item));
  if (isRecord(node)) {
    return Object.entries(node).some(([field, leaf]) => looseScalar(field, item) || (IDENTITY_FIELD_RE.test(field) && boundHolds(leaf, item)));
  }
  return looseScalar(node, item);
}

/**
 * Every value in `result` bound to `key` — the key is an object key at any
 * depth. A match entry `{ key: expected }` can only hold against one of these
 * nodes: a value under a different key never counts, and a missing key never
 * matches (a forged `{hosted_auth: false, public_signup: true}` cannot satisfy
 * `hosted_auth: true`, and App Administrator's grants never satisfy App User's).
 */
function boundValues(result: unknown, key: string): unknown[] {
  const found: unknown[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isRecord(value)) return;
    for (const [child, node] of Object.entries(value)) {
      if (child === key) found.push(node);
      walk(node);
    }
  };
  walk(result);
  return found;
}

/**
 * A row in `result` that `key` identifies: records carrying `key` as a leaf
 * value under an id/name field (the resolved `<id:Table>` match keys bind the
 * permission row whose table_id is that id). The leaf must be a direct field —
 * a container that merely wraps the row does not bind.
 */
const ROW_ID_KEYS = /^(?:[-\w]*_?id|[-\w]*_?name|domain)$/i;
function boundRows(result: unknown, key: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isRecord(value)) return;
    if (Object.entries(value).some(([field, leaf]) => ROW_ID_KEYS.test(field) && !isRecord(leaf) && !Array.isArray(leaf) && looseScalar(leaf, key))) {
      found.push(value);
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(result);
  return found;
}

/**
 * A row spec (`{ field: expected }`) against one located row: every spec entry
 * binds inside the row, and an expected list is the exact set — an extra grant
 * is a mismatch (Update_Table_Permissions replaces the set, so an over-grant
 * must stay open), and the diff names what to remove.
 */
function rowDiffs(row: unknown, spec: Record<string, unknown>): string[] {
  if (!isRecord(row)) return ['the bound value is not a row object'];
  const diffs: string[] = [];
  for (const [key, expected] of Object.entries(spec)) {
    const bound = boundValues(row, key);
    if (!bound.length) {
      diffs.push(`no "${key}" in the row`);
      continue;
    }
    const verdicts = bound.map((actual): string[] => {
      if (isRecord(expected)) {
        return isRecord(actual) ? rowDiffs(actual, expected) : [`"${key}" is not an object`];
      }
      if (Array.isArray(expected)) {
        if (isRecord(actual)) return [`"${key}": an object is not a permission list`];
        const list = Array.isArray(actual) ? actual : [actual];
        const absent = expected.filter((item) => !list.some((leaf) => boundHolds(leaf, item)));
        const extra = list.filter((leaf) => !expected.some((item) => boundHolds(leaf, item)));
        const parts = [
          ...absent.map((item) => `missing ${JSON.stringify(redactEvidence(item))}`),
          ...extra.map((leaf) => `extra ${JSON.stringify(redactEvidence(leaf))} — remove it`),
        ];
        return parts.length ? [`"${key}": ${parts.join(', ')}`] : [];
      }
      return looseScalar(actual, expected) ? [] : [`"${key}": got ${JSON.stringify(redactEvidence(actual))}, want ${JSON.stringify(redactEvidence(expected))}`];
    });
    if (!verdicts.some((verdict) => verdict.length === 0)) {
      diffs.push(...verdicts.sort((a, b) => a.length - b.length)[0]!);
    }
  }
  return diffs;
}

/**
 * Every match entry must hold. `{ key: expected }` means "the read-back binds
 * `key` to a node that contains `expected`" — a scalar as an exact leaf (loose
 * string/number, so 19-digit ids compare), an array as every element present,
 * an object as a contained subset. Multiple nodes may bind the same key
 * (e.g. a permission row per table); each expected item must appear under at
 * least one of them. Expected values are redacted in the failure report — the
 * resolved match can carry an email.
 *
 * A record-valued entry is a row spec instead: `key` identifies one row of the
 * read-back — a value stored under that key (a `{ "9000": {...} }` map) or a
 * record whose own id/name leaf equals it (a `[{table_id: "9000", ...}]` row)
 * — and the spec must match that row exactly. Permission/scopes matches are
 * emitted per (table, role) this way, so a grant on another table never counts
 * and an over-grant fails with the extra named.
 */
export function matchReadBack(result: unknown, match: Record<string, unknown>): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const [key, value] of Object.entries(match)) {
    if (isRecord(value)) {
      const candidates = [...boundValues(result, key), ...boundRows(result, key)];
      if (!candidates.length) {
        missing.push(`${key}: the read-back has no "${key}" key and no row carrying it`);
        continue;
      }
      const diffs = candidates.map((row) => rowDiffs(row, value)).sort((a, b) => a.length - b.length);
      if (diffs[0]!.length) missing.push(`${key}: ${diffs[0]!.join('; ')}`);
      continue;
    }
    const bound = boundValues(result, key);
    if (!bound.length) {
      missing.push(`${key}: the read-back has no "${key}" key`);
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!bound.some((node) => boundHolds(node, item))) {
        missing.push(`${key}: ${JSON.stringify(redactEvidence(item))} not found under "${key}" in the read-back`);
      }
    }
  }
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// grant read-backs: Get_Table_Permissions / Get_Table_Scopes answer ONE call
// with role rows — each row carries `role_name` and a grant field
// (`table_permissions` list or `table_scope` scalar), never the table id: the
// table is the call's own path_variables.id. A recorded file is therefore an
// array of per-call responses in args.calls order (or a single response for
// one call). The recording is normalised into { <call table id>: { <role>:
// <grant set> } } so the per-(table, role) row spec still binds each grant to
// the table and the role it belongs to — a grant on another table or another
// role can never count.

/** A grant list or a scalar grant word (the exact spellings the tools write). */
function isGrantValue(value: unknown): boolean {
  if (isExactGrantList(value)) return true;
  return typeof value === 'string' && isExactGrantList([value]);
}

/**
 * Every `role → grant set` a response carries. A role row is a record with a
 * `role_name` leaf; its grant field is table_permissions/table_scope — `prefer`
 * picks which when both sit on one row. Rows without role_name keep the
 * grant-field key itself as the role name (older recorded shapes keyed grants
 * by role). The first grant field wins per role.
 */
function roleGrantMap(node: unknown, prefer: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isRecord(value)) return;
    const role = typeof value.role_name === 'string' ? value.role_name : undefined;
    if (role) {
      if (out[role] === undefined) {
        const grant = [value[prefer], value.table_permissions, value.table_scope].find(isGrantValue) ?? Object.values(value).find(isGrantValue);
        if (isGrantValue(grant)) out[role] = grant;
      }
    } else {
      for (const [key, child] of Object.entries(value)) {
        if (isGrantValue(child) && out[key] === undefined) out[key] = child;
      }
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(node);
  return out;
}

/** The table id a grant row self-identifies with — `table_id`/`id` only; a role_id or user_id is not the table. */
function rowTableId(row: Record<string, unknown>): string | undefined {
  for (const key of ['table_id', 'id']) {
    const leaf = row[key];
    if ((typeof leaf === 'string' || typeof leaf === 'number') && !Array.isArray(leaf) && !isRecord(leaf)) return String(leaf);
  }
  return undefined;
}

/**
 * Normalise a recorded grant read-back into `{ <table id>: { role: grants } }`:
 * rows that carry their own table id bind themselves; an array of per-call
 * responses binds positionally to the resolved args.calls ids; a single-call
 * read-back binds whatever was recorded to that call's table. Returns
 * undefined when nothing can be bound — the raw result is then matched as-is.
 */
function normalizeGrantReadBack(result: unknown, callIds: string[], prefer: string): Record<string, unknown> | undefined {
  const elements = (Array.isArray(result) ? result : [result]).map(unwrapResult);
  const out: Record<string, unknown> = {};
  if (elements.every(isRecord)) {
    const keyed = elements.map((element) => rowTableId(element));
    if (keyed.some((id) => id !== undefined)) {
      for (let index = 0; index < elements.length; index++) {
        const id = keyed[index];
        if (id !== undefined && out[id] === undefined) out[id] = roleGrantMap(elements[index], prefer);
      }
      if (Object.keys(out).length) return out;
    }
  }
  if (callIds.length > 0 && callIds.length === elements.length) {
    for (let index = 0; index < callIds.length; index++) out[callIds[index]!] = roleGrantMap(elements[index], prefer);
  } else if (callIds.length === 1) {
    out[callIds[0]!] = roleGrantMap(result, prefer);
  }
  return Object.keys(out).length ? out : undefined;
}

/** The ids the plan asked the read-back tool about, resolved in call order. */
function grantCallIds(step: ProvisionStep, ctx: Ctx, missing: string[]): string[] {
  const calls = isRecord(step.readBack.args) && Array.isArray(step.readBack.args.calls) ? step.readBack.args.calls : [];
  const ids: string[] = [];
  for (const call of calls) {
    const raw = isRecord(call) && isRecord(call.path_variables) ? call.path_variables.id : undefined;
    if (typeof raw !== 'string') continue;
    const resolved = resolveTokens(raw, ctx, missing);
    if (typeof resolved === 'string' || typeof resolved === 'number') ids.push(String(resolved));
  }
  return ids;
}

/** The steps whose read-back is the org's project list. */
function isProjectStep(id: string): boolean {
  return id === 'project' || id === 'import';
}

/**
 * The project read-back, through the Catalyst CLI: one GET /baas/v1/project
 * (listCatalystProjects), reduced to `{ project_name, id }` rows. Never the
 * MCP project tools — they return jwtSecret/clientSecret into the transcript.
 */
async function cliProjectReadBack(ctx: Ctx, org: string): Promise<unknown> {
  const rows = ctx.io.listProjects
    ? await ctx.io.listProjects(org)
    : await listCatalystProjects(ctx.io.env, org, { log: (line) => ctx.io.stderr(`${line}\n`) });
  return { data: rows.map((row) => ({ project_name: row.name, id: row.id })) };
}

/** The grant field a read-back tool exposes, for the role-row pick. */
function grantFieldFor(tool: unknown): string {
  return canonicalTool(tool) === PLAN_STEP_TOOL.getTableScopes || canonicalTool(tool) === PLAN_STEP_TOOL.updateTableScopes ? 'table_scope' : 'table_permissions';
}

/**
 * Shape a recorded result before the matcher sees it, and decide what reaches
 * disk. `evidence` is what storeResult writes; `checked` is what the match
 * runs against. The project list reduces BOTH (nothing but the scrubbed
 * target entry may be learned, stored or matched); a grant read-back keeps the
 * raw rows as evidence and matches the normalised table-id map. `ambiguous`
 * marks a project list whose target bound more than one entry — the record
 * must refuse, never pick one id from a crowd.
 */
function prepareReadBack(ctx: Ctx, step: ProvisionStep, result: unknown, match: Record<string, unknown>, missing: string[]): { evidence: unknown; checked: unknown; ambiguous: boolean } {
  if (isProjectStep(step.id)) {
    // A project list carries every project in the org — and can carry another
    // project's secrets. Reduce to the target entry before it is matched,
    // learned or stored; nothing else in the answer may reach disk.
    const wanted = match.project_name ?? match.name ?? step.args.name;
    const { reduced, matched } = reduceProjectReadBack(result, {
      ...(ctx.scope.projectId !== undefined ? { id: ctx.scope.projectId } : {}),
      ...(typeof wanted === 'string' ? { name: wanted } : {}),
    });
    // Two surviving entries cannot both be the target — reduce to nothing so
    // neither is learned, stored or matched even if the caller ignores the flag.
    if (matched > 1) return { evidence: [], checked: [], ambiguous: true };
    return { evidence: reduced, checked: reduced, ambiguous: false };
  }
  if (canonicalTool(step.readBack.tool) === PLAN_STEP_TOOL.listSlateApps) {
    // The Slate read-back is proof the tool answered: only the envelope's own
    // top-level status counts — a `status` leaf nested inside a failure
    // envelope is not success.
    const checked = isRecord(result)
      ? Object.fromEntries(Object.entries(result).filter(([, leaf]) => !isRecord(leaf) && !Array.isArray(leaf)))
      : {};
    return { evidence: result, checked, ambiguous: false };
  }
  if (isPerRowGrantMatch(step.readBack.match)) {
    const normalized = normalizeGrantReadBack(result, grantCallIds(step, ctx, missing), grantFieldFor(step.readBack.tool));
    if (normalized) return { evidence: result, checked: normalized, ambiguous: false };
  }
  return { evidence: result, checked: result, ambiguous: false };
}

// ---------------------------------------------------------------------------
// placeholders resolved at run/record/next time: <project>, <org>, <console>,
// <slate-app-url-host>, <sender-email>, <user-emails>, <id:NAME>

const TOKEN = /^<([a-z-]+)(?::([^>]+))?>$/;
const TOKEN_ANYWHERE = /<([a-z-]+)(?::([^>]+))?>/g;

/**
 * Tokens whose resolved value is PII — resolved for internal matching and for
 * REST bodies, but printed back as the placeholder (the host reads the real
 * values from provision/inputs.json).
 */
const PRIVATE_TOKENS = new Set(['sender-email', 'user-emails']);

/** Your Slate host — --domain beats inputs.json slateDomain; both sides are validated before they reach here. */
const slateDomainFor = (ctx: Ctx): string | undefined => ctx.domainFlag ?? ctx.inputs.slateDomain;

function resolveToken(name: string, arg: string | undefined, ctx: Ctx, missing: string[], forPrint: boolean): unknown {
  const miss = (token: string): string => {
    missing.push(token);
    return token;
  };
  const printable = (token: string, value: unknown): unknown => (forPrint && PRIVATE_TOKENS.has(name) ? token : value);
  switch (name) {
    case 'project':
      return ctx.scope.projectId ?? miss('<project>');
    case 'import-name': {
      // The name the import run used, else the customer-named import, else the
      // plan's intended name (a user who imported by hand uses args.name).
      const wanted = ctx.state.learned.importName ?? ctx.inputs.projectName ?? importStepName(ctx);
      return wanted ?? miss('<import-name>');
    }
    case 'org': {
      if (!ctx.scope.org) return miss('<org>');
      const asNumber = Number(ctx.scope.org);
      return Number.isSafeInteger(asNumber) ? asNumber : ctx.scope.org;
    }
    case 'slate-app-url-host':
      return slateDomainFor(ctx) ?? miss('<slate-app-url-host>');
    case 'console':
      return ctx.scope.dc ? dcEndpoints(ctx.scope.dc).console : miss('<console>');

    case 'sender-email':
      return printable('<sender-email>', ctx.inputs.senderEmail || miss('<sender-email>'));
    case 'user-emails': {
      const emails = (ctx.inputs.users ?? []).map((user) => user.email_id).filter(Boolean);
      return printable('<user-emails>', emails.length ? emails : miss('<user-emails>'));
    }
    case 'id':
      return (arg && ownDecimalId(ctx.state.learned.byName, arg)) || miss(`<id:${arg}>`);
    default:
      return miss(`<${name}${arg ? `:${arg}` : ''}>`);
  }
}

/** The project name the import step plans to create. */
function importStepName(ctx: Ctx): string | undefined {
  const step = ctx.plan.steps.find((item) => item.id === 'import');
  const name = step?.args.name;
  return typeof name === 'string' && name ? name : undefined;
}


export function resolveTokens(value: unknown, ctx: Ctx, missing: string[], opts: { forPrint?: boolean } = {}): unknown {
  const forPrint = opts.forPrint === true;
  if (typeof value === 'string') {
    const token = TOKEN.exec(value);
    if (token) return resolveToken(token[1]!, token[2], ctx, missing, forPrint);
    // Tokens embedded in a longer string (paths, commands) substitute in place.
    if (TOKEN_ANYWHERE.test(value)) {
      TOKEN_ANYWHERE.lastIndex = 0;
      return value.replace(TOKEN_ANYWHERE, (raw, name: string, arg?: string) => {
        if (forPrint && PRIVATE_TOKENS.has(name)) return raw;
        const inner: string[] = [];
        const resolved = resolveToken(name, arg, ctx, inner, forPrint);
        // A miss is already recorded in `inner`; a non-scalar cannot embed.
        if (inner.length) return raw;
        if (resolved === undefined || typeof resolved === 'object') {
          missing.push(raw);
          return raw;
        }
        return String(resolved);
      });
    }
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const resolved = resolveTokens(item, ctx, missing, opts);
      // A placeholder that resolves to a list expands in place ("<user-emails>").
      if (Array.isArray(resolved) && typeof item === 'string' && TOKEN.test(item)) out.push(...resolved);
      else out.push(resolved);
    }
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      // A whole-token key ("<id:Table>") resolves too — grant row matches are
      // keyed by the learned table id.
      const token = TOKEN.exec(key);
      let outKey = key;
      if (token) {
        const resolved = resolveToken(token[1]!, token[2], ctx, missing, forPrint);
        if (typeof resolved === 'string' || typeof resolved === 'number') outKey = String(resolved);
        else missing.push(key);
      }
      out[outKey] = resolveTokens(child, ctx, missing, opts);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// learned ids: every recorded read-back feeds the name → id map

// `email_id` is deliberately absent: an email is an address, not a resource
// name, and it must never be learned into state.json. Any sensitive-looking
// name (an email, a URL, a token) is skipped for the same reason.
/** An own decimal id. A prototype lookup (`__proto__`, `constructor`) never counts. */
function ownDecimalId(map: object, key: string): string | undefined {
  if (!Object.hasOwn(map, key)) return undefined;
  const value = (map as Record<string, unknown>)[key];
  return typeof value === 'string' && /^[0-9]+$/.test(value) ? value : undefined;
}

/** Store a name → id pair as an own property, including names that are prototype keys. */
function rememberName(map: Record<string, string>, name: string, id: string): void {
  if (!/^[0-9]+$/.test(id)) return;
  Object.defineProperty(map, name, { value: id, enumerable: true, writable: true, configurable: true });
}

const NAME_KEYS = ['name', 'table_name', 'role_name', 'bucket_name', 'domain', 'project_name', 'cron_name', 'pool_name', 'job_pool_name'];
const ID_KEYS = ['id', 'table_id', 'role_id', 'project_id', 'bucket_id', 'jobpool_id', 'job_pool_id', 'cron_id', 'user_id', 'zaid'];

function learnIds(result: unknown, learned: ProvisionState['learned']): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isRecord(value)) return;
    let name: string | undefined;
    let id: string | undefined;
    for (const key of NAME_KEYS) {
      const raw = value[key];
      if (typeof raw === 'string' && raw.trim() && !SENSITIVE_VALUE_RE.test(raw) && !hasParamSecret(raw)) {
        name = raw;
        break;
      }
    }
    for (const key of ID_KEYS) {
      const raw = value[key];
      if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) {
        id = raw;
        break;
      }
      if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
        id = String(raw);
        break;
      }
    }
    if (name && id) rememberName(learned.byName, name, id);
    for (const child of Object.values(value)) walk(child);
  };
  walk(result);
}

// ---------------------------------------------------------------------------
// recorded result handling

/** Unwrap an MCP-protocol envelope ({content:[{type:'text',text:'<json>'}]}) or a {result:…} wrapper. */
function unwrapResult(parsed: unknown): unknown {
  if (isRecord(parsed) && Array.isArray(parsed.content)) {
    const texts = parsed.content.filter((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string');
    if (texts.length) {
      const unwrapped = texts.map((item) => {
        const text = (item as { text: string }).text;
        try {
          return parseJsonExact(text);
        } catch {
          return text;
        }
      });
      return unwrapped.length === 1 ? unwrapped[0] : unwrapped;
    }
  }
  if (isRecord(parsed) && 'result' in parsed && parsed.result !== undefined) return parsed.result;
  return parsed;
}

function storeResult(out: string, id: string, result: unknown): string {
  const dir = join(out, ...RESULTS_DIR);
  mkdirSync(dir, { recursive: true });
  const rel = `provision/results/${id}.json`;
  writeFileSync(join(out, rel), `${JSON.stringify(redactEvidence(result), null, 2)}\n`);
  return rel;
}

function stepStatus(state: ProvisionState, id: string): StepStatus {
  return state.steps[id]?.status ?? 'pending';
}

function findStep(plan: ProvisionPlanFile, id: string): ProvisionStep | undefined {
  return plan.steps.find((step) => step.id === id);
}

function endpointRef(endpoint: StepEndpoint, id: string): string {
  return endpoint.tool ?? endpoint.command ?? id;
}

/** A cli read-back is one c2c makes itself: --record without a result file. */
function awaitingReadBack(step: ProvisionStep, id: string): string {
  return step.readBack.via === 'cli'
    ? `awaiting read-back: c2c reads it itself: c2c provision --record ${id}`
    : `awaiting read-back: call ${endpointRef(step.readBack, id)} and record it: c2c provision --record ${id} --result <file>`;
}

// ---------------------------------------------------------------------------
// cli step execution

function readJsonFile<T>(path: string, what: string): T {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`missing ${what} (${path}) — re-run c2c plan`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * A 4xx that only means the resource is already there is not a failure of
 * create-missing — and only the shapes the server is recorded to answer
 * count: a `DUPLICATE*` error_code, or a message saying the resource is
 * "already" something. "does not exist" is not "already exists", and an
 * error that merely mentions an existing configuration is a failure.
 */
function alreadyThere(result: { status: number; body: unknown }): boolean {
  if (result.status !== 400 && result.status !== 409) return false;
  const body = isRecord(result.body) ? result.body : {};
  const data = isRecord(body.data) ? body.data : {};
  const code = typeof data.error_code === 'string' ? data.error_code : typeof body.error_code === 'string' ? body.error_code : '';
  if (/^DUPLICATE(_VALUE|_ENTRY)?$/i.test(code)) return true;
  const message = typeof data.message === 'string' ? data.message : typeof body.message === 'string' ? body.message : '';
  return /already (enabled|exists|in use|added|present|registered|authorised|authorized)/i.test(message);
}

/**
 * The checks every provision call applies to a final answer: a refusal that
 * is not "already there" throws, and a sub-400 failure envelope is never a
 * success. The error is echoed to stderr: an error body can carry the
 * request's email/token/URL back, so it goes through the same redactor as
 * evidence.
 */
function checkRestResult(call: RestCall, result: RestResult): RestResult {
  if (result.status >= 400 && !alreadyThere(result)) {
    const detail = JSON.stringify(redactEvidence(result.body ?? {})).slice(0, 300);
    throw new Error(`${call.method} ${call.path} failed: ${result.status} ${detail}`);
  }
  // An already-there 4xx may wear the failure envelope: it is a claim the re-read confirms, not a failure.
  if (result.status >= 400 && alreadyThere(result)) return result;
  if (isRecord(result.body) && (result.body.status === 'failure' || result.body.status === 'error')) {
    const detail = JSON.stringify(redactEvidence(result.body)).slice(0, 300);
    throw new Error(`${call.method} ${call.path} reported failure: ${detail}`);
  }
  return result;
}

/** Backoff for the bounded transient 429/5xx retry every provision call gets. */
function provisionRetry(ctx: Ctx): RetryOptions {
  return { sleep: ctx.io.sleep, log: (line) => ctx.io.stdout(`c2c provision: ${line}\n`) };
}

/**
 * The REST channel underneath the checks: a 429/5xx answer is a result, not
 * a throw — the retry loop must see it to re-send. Only the sub-400 failure
 * envelope throws here, so a refused write never counts as landed.
 */
function restChannel(ctx: Ctx): RestFn {
  return async (call) => {
    const rest = ctx.rest;
    if (!rest) throw new Error('no REST channel (io.rest or the Catalyst CLI token path is required)');
    const result = await rest(call);
    if (result.status < 400 && isRecord(result.body) && (result.body.status === 'failure' || result.body.status === 'error')) {
      const detail = JSON.stringify(redactEvidence(result.body)).slice(0, 300);
      throw new Error(`${call.method} ${call.path} reported failure: ${detail}`);
    }
    return result;
  };
}

/**
 * One provision call with the bounded transient retry. A read retries as-is;
 * a write passes a reRead that decides the retry — it is never re-sent blind.
 * The recorded checks run on the final answer; a re-read `applied` skips them
 * because the write landed (the answer kept is the failure that prompted the
 * read).
 */
async function checkedRetry<T = never>(ctx: Ctx, call: RestCall, reRead?: (failure: RestResult, attempt: number) => Promise<ReRead<T>>): Promise<RestRetry<T>> {
  let writes = 0;
  const trackedRest: RestFn = async (attempt) => {
    if (attempt.method !== 'GET') writes++;
    return restChannel(ctx)(attempt);
  };
  let out = await restWithRetry(trackedRest, call, reRead ? { ...provisionRetry(ctx), reRead } : provisionRetry(ctx));
  if (out.applied === undefined && reRead && out.result.status >= 400 && alreadyThere(out.result) && isRecord(out.result.body) && (out.result.body.status === 'failure' || out.result.body.status === 'error')) {
    // A duplicate answer can still wear the failure envelope — the re-read
    // confirms the identity the same way the retry path does: landed is
    // applied, absent sends the write once, and an unreadable re-read proves
    // nothing, so the run aborts on the recorded duplicate claim.
    const seen = await reRead(out.result, 0);
    if (seen && 'applied' in seen) out = { result: out.result, applied: seen.applied };
    else if (seen && 'resend' in seen) out = { result: await restChannel(ctx)(seen.resend) };
    else if (seen && 'abort' in seen) {
      const detail = JSON.stringify(redactEvidence(out.result.body ?? {})).slice(0, 300);
      throw new Error(`${call.method} ${call.path}: the re-read refused the already-there answer: ${out.result.status} ${detail}`);
    } else {
      if (writes >= 2) {
        const detail = JSON.stringify(redactEvidence(out.result.body ?? {})).slice(0, 300);
        throw new Error(`${call.method} ${call.path}: duplicate answer remains unconfirmed after the two-write limit; the re-read still finds nothing: ${out.result.status} ${detail}`);
      }
      // The re-read read fine and the object is not there: the duplicate
      // claim was wrong, so the write goes out once — and only once. A resent
      // call answered already-there again is re-read a last time; a re-read
      // that still finds nothing (or cannot be read) fails closed — the step
      // stays open rather than close as existing without the object.
      // This is the one authorized resend. It shares the two-write limit
      // with the original bounded transient retry above.
      const resentResult = await trackedRest(call);
      out = { result: resentResult };
      if (
        resentResult.status >= 400 &&
        alreadyThere(resentResult) &&
        isRecord(resentResult.body) &&
        (resentResult.body.status === 'failure' || resentResult.body.status === 'error')
      ) {
        const again = await reRead(resentResult, 1);
        if (again && 'applied' in again) out = { result: resentResult, applied: again.applied };
        else {
          const detail = JSON.stringify(redactEvidence(resentResult.body ?? {})).slice(0, 300);
          throw new Error(
            `${call.method} ${call.path}: one resend after the duplicate answer did not land it — the re-read ${again && 'abort' in again ? 'is unreadable' : 'still finds nothing'}: ${resentResult.status} ${detail}`,
          );
        }
      }
    }
  }
  if (out.applied === undefined) checkRestResult(call, out.result);
  return out;
}

/**
 * The directory the import bundle packs — always `<out>/provision/iac`. The
 * plan pins args.dir to that path; resolve it through realpath so a linked
 * directory (the iac tree or an ancestor pointing outside --out) is refused
 * instead of uploaded.
 */
function resolveIacDir(out: string, arg: unknown): string {
  const expected = join(realpathSync(out), 'provision', 'iac');
  let resolved: string;
  try {
    resolved = realpathSync(join(out, typeof arg === 'string' ? arg : 'provision/iac'));
  } catch {
    throw new Error('provision/iac is missing — re-run c2c plan for a new project');
  }
  if (resolved !== expected) {
    throw new Error('the import bundle directory does not resolve to provision/iac under --out (a link points it elsewhere) — re-run c2c plan for a new project');
  }
  return resolved;
}

/**
 * The one-shot project create: pack provision/iac into the `code` part of a
 * multipart POST /baas/v1/project/import, confirm the deploy, poll the import
 * to Completed, and learn the project id it minted. A stuck import is
 * remembered by name and every recorded row is resolved before the retry's
 * first POST — a live, unreadable, or id-less row refuses the run rather
 * than orphaning the import it could not judge.
 */
async function runImportStep(ctx: Ctx, args: Record<string, unknown>): Promise<{ applied: boolean; result: unknown; proven: boolean }> {
  const name = ctx.importName ?? (typeof args.name === 'string' && args.name ? args.name : undefined);
  if (!name) throw new Error('step import has no project name — re-run c2c plan');
  if (!ctx.io.fetch || typeof ctx.io.fetch !== 'function') {
    throw new Error('the project import needs an HTTP channel (io.fetch) — the provision REST path is project-scoped; the import is org-scoped');
  }
  const bundle = iacImportBundle(resolveIacDir(ctx.out, args.dir));
  const token = ctx.io.accessToken ? await ctx.io.accessToken(ctx.io.env, ctx.scope.org!, '0') : await readCliAccessToken(ctx.io.env, ctx.scope.org!, '0');
  const stuck = Object.entries(ctx.state.learned.imports ?? {}).filter(([, row]) => row.status === 'stuck');
  // Names this invocation posted: only a verifiably-ended import frees them.
  const posted: string[] = [];
  // Names a listed project still holds as 'Importing': it cannot be deleted,
  // so the sequence takes the next documented suffix instead of colliding on
  // the 409. A list that cannot be read blocks nothing — a taken name still
  // answers 409 and moves to the next suffix.
  let heldNames: string[] = [];
  try {
    const listed = ctx.io.listProjects ? await ctx.io.listProjects(ctx.scope.org!) : [];
    heldNames = listed.filter((project) => project.projectType === 'Importing').map((project) => project.name);
  } catch {
    heldNames = [];
  }
  try {
    const result = await runProjectImport({
      baseUrl: catalystBaseFor(ctx.scope.dc!),
      org: ctx.scope.org!,
      token,
      // An injected first token has no CLI store behind it: renew only through an injected renewal.
      ...(ctx.io.renewAccessToken || !ctx.io.accessToken
        ? { renewToken: () => (ctx.io.renewAccessToken ?? renewCliAccessToken)(ctx.io.env, ctx.scope.org!) }
        : {}),
      name,
      takenNames: stuck.map(([blocked]) => blocked),
      heldNames,
      stuckIds: Object.fromEntries(stuck.flatMap(([blocked, row]) => (row.importId !== undefined ? [[blocked, row.importId]] : []))),
      // The import id is on disk before the deploy confirm, so an interrupted
      // run re-polls exactly the import it started and nothing else.
      onPosted: (postedName, importId) => {
        posted.push(postedName);
        (ctx.state.learned.imports ??= {})[postedName] = { status: 'stuck', importId };
        writeProvisionState(ctx.out, ctx.state);
      },
      bundle,
      fetch: ctx.io.fetch as ImportFetch,
      sleep: ctx.io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      onStatus: (line) => ctx.io.stdout(`${line}\n`),
    });
    // The protected-project rule shared with deploy, before anything is learned.
    try {
      assertProtectedProject(ctx.scope.protectedProjects ?? {}, { id: result.projectId, name: result.projectName });
    } catch (err) {
      throw new Error(`refusing to bind the imported project "${result.projectName}" (${result.projectId}): ${err instanceof Error ? err.message : String(err)}`);
    }
    // Stuck rows the import resolved as verifiably ended are dropped — their
    // names were free to re-post, so the record must not re-block a later run.
    for (const attempt of result.attempts) {
      if (attempt.outcome === 'ended' && ctx.state.learned.imports?.[attempt.name]?.status === 'stuck') delete ctx.state.learned.imports[attempt.name];
    }
    ctx.state.learned.importName = result.projectName;
    ctx.state.learned.projectId = result.projectId;
    rememberName(ctx.state.learned.byName, result.projectName, result.projectId);
    (ctx.state.learned.imports ??= {})[result.projectName] = { importId: result.importId, status: 'completed' };
    updateFunctionEnvFromCtx(ctx);
    return {
      applied: true,
      // The import is polled to Completed and the minted project id is
      // learned from the status read — the run's own output is the proof.
      proven: true,
      result: {
        project: { project_name: result.projectName, id: result.projectId },
        import: { id: result.importId, states: result.states },
        attempts: result.attempts,
      },
    };
  } catch (err) {
    if (err instanceof StuckImportError) {
      (ctx.state.learned.imports ??= {})[err.projectName] = { status: 'stuck', ...(err.importId ? { importId: err.importId } : {}) };
      writeProvisionState(ctx.out, ctx.state);
    } else if (err instanceof ImportEndedError) {
      // The import's own status read says it is over: its name is not held by
      // a running import, so the record goes and a retry may post it again.
      for (const name of posted) {
        if (ctx.state.learned.imports?.[name]?.status === 'stuck') delete ctx.state.learned.imports[name];
      }
      writeProvisionState(ctx.out, ctx.state);
    }
    // Every other failure leaves the import's outcome unknown: the row onPosted
    // wrote stays 'stuck', so the next run re-polls that import id before any
    // name is minted — a transient read error must never free it into an orphan.
    throw err;
  }
}

async function executeCliStep(ctx: Ctx, step: ProvisionStep, args: Record<string, unknown>): Promise<{ applied: boolean; result: unknown; proven: boolean }> {
  if (step.id === 'import') return runImportStep(ctx, args);
  const projectId = ctx.scope.projectId!;
  const channel = restChannel(ctx);
  const rest = <T,>(call: RestCall, reRead?: (failure: RestResult, attempt: number) => Promise<ReRead<T>>) => checkedRetry(ctx, call, reRead);

  if (step.id === 'tables') {
    const spec = typeof args.plan === 'string' ? args.plan : 'provision/tables.json';
    const steps = readJsonFile<TableCreateStep[]>(join(ctx.out, spec), 'table spec');
    if (!Array.isArray(steps) || steps.some((item) => !isRecord(item) || typeof item.table !== 'string' || !Array.isArray(item.columns))) {
      throw new Error(`${spec} is not a table spec (want a list of {table, columns: [...]} entries — re-run c2c plan)`);
    }
    const diff = await applyTablePlan(projectId, steps, channel, provisionRetry(ctx));
    return { applied: diff.createdTables.length + diff.createdColumns.length > 0, proven: true, result: diff };
  }

  if (step.id === 'app-users') {
    const users = ctx.inputs.users ?? [];
    if (!users.length) throw new Error('no users to invite — fill provision/inputs.json "users"');
    // Every invite carries redirect_url = the Slate app URL; without it the
    // mailed link lands on a page that does not exist.
    const domain = slateDomainFor(ctx);
    if (!domain) throw new Error('the invite needs redirect_url — set "slateDomain" in provision/inputs.json or pass --domain <slate-host>');
    // Catalyst Add User rejects a '+' in the email — refuse before any request.
    const plus = users.filter((user) => typeof user.email_id === 'string' && user.email_id.includes('+')).length;
    if (plus) {
      throw new Error(`provision/inputs.json: ${plus} user email(s) contain '+' — Catalyst Add User rejects it (Email Id cannot contain '+' character, INVALID_INPUT); use the plain address`);
    }
    const userPath = materialiseCliPath(PLAN_CLI_PATH.projectUser, projectId);
    const listed = (await rest({ method: 'GET', path: userPath })).result;
    const existing = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) for (const item of value) collect(item);
      else if (isRecord(value)) {
        if (typeof value.email_id === 'string') existing.add(value.email_id);
        for (const child of Object.values(value)) collect(child);
      }
    };
    collect(listed.body);
    const invited: unknown[] = [];
    for (const user of users) {
      if (!user.email_id) throw new Error('provision/inputs.json: every user needs email_id');
      if (existing.has(user.email_id)) continue;
      const roleId = user.role_id ?? (user.role ? ownDecimalId(ctx.state.learned.byName, user.role) : undefined);
      if (!roleId) {
        throw new Error(`role id for ${user.role ?? redactString(String(user.email_id))} is unknown — GET /role is refused for this token (401 OAUTH_SCOPE_MISMATCH); record the roles read-back first, or read role_id with the MCP CatalystbyZoho_List_All_Roles tool (a string — copy it as is) or the console and set it as a quoted string in provision/inputs.json`);
      }
      const body: Record<string, unknown> = {
        user_details: { email_id: user.email_id, role_id: roleId, ...(user.first_name ? { first_name: user.first_name } : {}), ...(user.last_name ? { last_name: user.last_name } : {}) },
        platform_type: 'web',
      };
      body.redirect_url = `https://${domain}`;
      // An invite POST is not idempotent: after a transient failure the user
      // list is re-read — the invite may have landed. It is never re-sent
      // while the re-read cannot prove it absent.
      const created = await rest<true>({ method: 'POST', path: userPath, body }, async () => {
        try {
          const again = await channel({ method: 'GET', path: userPath });
          if (again.status >= 400) return { abort: true as const };
          collect(again.body);
          return existing.has(user.email_id) ? { applied: true as const } : undefined;
        } catch {
          return { abort: true as const };
        }
      });
      if (created.applied !== undefined || !alreadyThere(created.result)) invited.push(created.result.body);
    }
    return { applied: invited.length > 0, proven: true, result: { invited: invited.length, existing: users.length - invited.length } };
  }

  if (step.id === 'crons') {
    const spec = typeof args.plan === 'string' ? args.plan : 'provision/crons.json';
    const crons = readJsonFile<{ name?: string; cron_name?: string; body?: Record<string, unknown>; unsupported?: string }[]>(join(ctx.out, spec), 'cron spec');
    const cronPath = materialiseCliPath(PLAN_CLI_PATH.cron, projectId);
    const listed = (await rest({ method: 'GET', path: cronPath })).result;
    const existing = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) for (const item of value) collect(item);
      else if (isRecord(value)) {
        if (typeof value.cron_name === 'string') existing.add(value.cron_name);
        for (const child of Object.values(value)) collect(child);
      }
    };
    collect(listed.body);
    const created: string[] = [];
    for (const cron of crons) {
      // One key everywhere: the listing's cron_name, the spec's cron_name (and
      // its body's), and the read-back match. `name` is display text only.
      const cronKey =
        (typeof cron.cron_name === 'string' && cron.cron_name) ||
        (typeof cron.body?.cron_name === 'string' && cron.body.cron_name) ||
        String(cron.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
      if (existing.has(cronKey)) continue;
      if (cron.unsupported || !cron.body) throw new Error(`cron ${cronKey}: ${cron.unsupported ?? 'no body in provision/crons.json'}`);
      const missing: string[] = [];
      const body = resolveTokens(cron.body, ctx, missing) as Record<string, unknown>;
      if (missing.length) throw new Error(`cron ${cronKey}: unresolved ${missing.join(', ')} (record the earlier steps first)`);
      // The cron POST is re-read before it is ever re-sent: the failed call
      // may have created the cron, and a duplicate must never be POSTed.
      const posted = await rest<true>({ method: 'POST', path: cronPath, body }, async () => {
        try {
          const again = await channel({ method: 'GET', path: cronPath });
          if (again.status >= 400) return { abort: true as const };
          collect(again.body);
          return existing.has(cronKey) ? { applied: true as const } : undefined;
        } catch {
          return { abort: true as const };
        }
      });
      if (posted.applied !== undefined || !alreadyThere(posted.result)) created.push(cronKey);
    }
    return { applied: created.length > 0, proven: true, result: { created, existing: [...existing] } };
  }

  // The path comes from the plan template, not from the resolved plan text.
  const rawCall = step.args.call;
  if (isRecord(rawCall) && typeof rawCall.path === 'string' && (rawCall.method === 'GET' || rawCall.method === 'POST')) {
    const path = materialiseCliPath(rawCall.path, projectId);
    const resolvedCall = isRecord(args.call) ? args.call : {};
    // A POST retried only because the first may not have landed: the call
    // bodies a plan emits are enable/create-missing writes, so a second send
    // either applies the missing write or answers already-there — never a
    // duplicate. The final answer is the step's evidence either way.
    const out = await rest({ method: rawCall.method, path, ...('body' in resolvedCall ? { body: resolvedCall.body } : {}) }, rawCall.method === 'POST' ? async () => ({ resend: { method: 'POST', path, ...('body' in resolvedCall ? { body: resolvedCall.body } : {}) } }) : undefined);
    // A POST answered under 400 (a failure envelope or a hard refusal already
    // threw) is the run's own evidence — the step may close on it. An
    // already-there 4xx or a GET answer only claims the state: the step
    // closes when that answer itself satisfies the read-back match, and
    // otherwise stays open for a recorded read-back.
    return {
      applied: rawCall.method !== 'GET' && !alreadyThere(out.result),
      proven: rawCall.method === 'POST' && out.result.status < 400,
      result: { status: out.result.status, body: out.result.body },
    };
  }

  if (Array.isArray(step.args.argv) && step.args.argv.length === 1 && step.args.argv[0] === 'apig:enable') {
    const childEnv = scrubCatalystEnv(ctx.io.env);
    const spawned = await spawnWithRetry(
      () => ctx.io.spawn('catalyst', [...catalystScopeArgs(ctx.scope.org!, projectId), 'apig:enable'], { cwd: ctx.out, env: childEnv }),
      'catalyst apig:enable',
      provisionRetry(ctx),
    );
    if (spawned.code !== 0) throw new Error(`catalyst apig:enable exited ${spawned.code}: ${redactString(`${spawned.stderr}${spawned.stdout}`).slice(0, 300)}`);
    return { applied: true, proven: true, result: { code: spawned.code, stdout: redactEvidence(spawned.stdout.slice(-2000)) } };
  }

  throw new Error(`step ${step.id}: no executable spec (want args.plan, args.call or apig:enable)`);
}

// ---------------------------------------------------------------------------
// verbs

function statusOf(state: ProvisionState, step: ProvisionStep): StepStatus {
  return stepStatus(state, step.id);
}

function updateFunctionEnvFromCtx(ctx: Ctx): void {
  try {
    const domain = slateDomainFor(ctx);
    const appUrl = domain ? `https://${domain}` : undefined;
    const projectId = ctx.scope.projectId ?? ctx.state.learned.projectId;
    const secretKeys = ctx.plan.connectionSecretKeys;
    writeOrUpdateFunctionEnv(ctx.out, {
      dc: ctx.scope.dc ?? ctx.plan.dc,
      projectId,
      appUrl,
      learnedByName: ctx.state.learned.byName,
      ...(secretKeys?.length
        ? { connectionSecrets: secretKeys.map((k) => ({ connectionName: '', propertyKey: '', envKey: k })) }
        : {}),
    });
  } catch {
    // best-effort update
  }
}

/** What no step can do for you once every step is done. */
function humanChecklist(plan: ProvisionPlanFile, state?: ProvisionState, out?: string): string[] {
  // The mail-sender step is the customer's only when this app sends mail.
  const mail = plan.steps.some((step) => step.id === 'mail-sender');
  // A slate-enable step already done or existing proves Slate was started,
  // so a re-run drops that first step; the rest keep their numbering.
  const slateStarted = state
    ? plan.steps.some((step) => step.id === 'slate-enable' && ['done', 'existing'].includes(statusOf(state, step)))
    : false;
  const items = CUSTOMER_STEPS.filter(
    (step) => (mail || !step.startsWith('Verify mail sender:')) && (!slateStarted || !step.startsWith('Slate start:')),
  );
  const secretKeys = out ? readConnectionSecretKeys(out, plan.connectionSecretKeys) : (plan.connectionSecretKeys ?? []);
  if (secretKeys.length > 0) {
    items.push(connectionSecretItem(secretKeys));
  }
  return items;
}

function printStatus(ctx: Ctx): number {
  updateFunctionEnvFromCtx(ctx);
  const lines = [`provision ${ctx.plan.app}`, `scope: dc=${ctx.scope.dc ?? '?'} org=${ctx.scope.org ?? '?'} project=${ctx.scope.projectId ?? '(not created yet)'}`, ''];
  const steps = progressSteps(ctx);
  for (const step of steps) {
    const entry = ctx.state.steps[step.id];
    const detail = entry?.result ? ` (${entry.result})` : '';
    lines.push(`- ${step.id} [${step.via}] ${statusOf(ctx.state, step)}${detail}`);
  }
  const done = steps.filter((step) => ['done', 'existing'].includes(statusOf(ctx.state, step))).length;
  lines.push('', `done: ${done}/${steps.length}`);
  if (done === steps.length && steps.length > 0) {
    lines.push('', 'human checklist:');
    humanChecklist(ctx.plan, ctx.state, ctx.out).forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  ctx.io.stdout(`${lines.join('\n')}\n`);
  return 0;
}

/** An import creates the project, so a stale manual-project row is redundant. */
function progressSteps(ctx: Ctx): ProvisionStep[] {
  return ctx.plan.steps.some((step) => step.id === 'import')
    ? ctx.plan.steps.filter((step) => step.id !== 'project')
    : ctx.plan.steps;
}

function resolvedEndpoint(endpoint: StepEndpoint & { args?: Record<string, unknown> }, ctx: Ctx, missing: string[], opts: { forPrint?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { via: endpoint.via };
  if (endpoint.tool) out.tool = endpoint.tool;
  if (endpoint.command) out.command = endpoint.command;
  if (endpoint.args) out.args = resolveTokens(endpoint.args, ctx, missing, opts);
  return out;
}

async function emitNext(ctx: Ctx): Promise<number> {
  for (;;) {
    const steps = progressSteps(ctx);
    const step = steps.find((item) => !['done', 'existing'].includes(statusOf(ctx.state, item)));
    if (!step) {
      updateFunctionEnvFromCtx(ctx);
      ctx.io.stdout(`${JSON.stringify({ done: true, app: ctx.plan.app, steps: steps.length, checklist: humanChecklist(ctx.plan, ctx.state, ctx.out) }, null, 2)}\n`);
      return 0;
    }
    // A gate that already verifies open is never presented as console work:
    // Cloud Scale is normally open, so --next on a normal project probes past
    // it with no console line. verifyGateStep closes the step; the loop then
    // presents the following step. A closed or unrecognised answer stops here
    // at the guided step, as before.
    const gate = gateForStep(step.id);
    if (gate && (await verifyGateStep(ctx, step, gate)).verdict === 'open') continue;
    const missing: string[] = [];
    const print = { forPrint: true };
    const args = resolveTokens(step.args, ctx, missing, print) as Record<string, unknown>;
    const readBack = resolvedEndpoint(step.readBack, ctx, missing, print);
    if (step.readBack.match) readBack.match = resolveTokens(step.readBack.match, ctx, missing, print);
    // The guided ask is printed resolved — a console step names the customer's
    // own console URL, never a token. (An embedded miss — the "<table>" of a
    // console path, or a project id not recorded yet — stays literal and is
    // reported by the args/read-back resolution, not here.)
    const command = typeof step.command === 'string' ? (resolveTokens(step.command, ctx, missing, print) as string) : undefined;
    const status = statusOf(ctx.state, step);
    const instructions =
      status === 'applied'
        ? awaitingReadBack(step, step.id)
        : step.via === 'cli'
          ? `first read back (${endpointRef(step.readBack, step.id)}); if it already matches record it, else run: c2c provision --confirm --run ${step.id}`
          : step.via === 'mcp'
            ? `host agent: call the read-back first (${endpointRef(step.readBack, step.id)}). If it matches, record it. Otherwise call ${step.tool} with args (one call per args.calls entry when present), re-read, then c2c provision --record ${step.id} --result <file> --applied`
            : gateForStep(step.id)
              ? `user action in the Catalyst console: ${gateLine(ctx, gateForStep(step.id)!)}. When the user says it is done, run c2c provision --record ${step.id} — c2c reads GET ${gateForStep(step.id)!.probe} itself and closes the step only on an open answer.`
              : `user action in the Catalyst console: ${command}. Then read back (${endpointRef(step.readBack, step.id)}) and record the result.`;
    ctx.io.stdout(
      `${JSON.stringify({ done: false, step: { id: step.id, via: step.via, status, ...(step.tool ? { tool: step.tool } : {}), ...(command !== undefined ? { command } : {}), args, readBack }, ...(missing.length ? { unresolved: missing } : {}), instructions }, null, 2)}\n`,
    );
    return 0;
  }
}

/**
 * The machine-readable result of a finished import: one `c2c-field <key> <value>`
 * line each for the project id and the name it was created under (a taken
 * name is suffixed, so the name can differ from the one asked for).
 */
function printImportFields(ctx: Ctx): void {
  const id = ctx.state.learned.projectId;
  const name = ctx.state.learned.importName;
  if (id) ctx.io.stdout(`c2c-field project_id ${id}\n`);
  if (name) ctx.io.stdout(`c2c-field project_name ${name}\n`);
}

/** The gate's checklist line for this project (tokens stay literal when the scope does not know them yet). */
function gateLine(ctx: Ctx, gate: FirstUseGate): string {
  return gateConsoleLine(gate, {
    console: ctx.scope.dc ? dcEndpoints(ctx.scope.dc).console : '<console>',
    org: ctx.scope.org ?? '<org>',
    project: ctx.scope.projectId ?? '<project>',
  });
}

/**
 * Run a gate's probe and close the step on an open answer. The read is c2c's
 * own: a gate never closes on a result file someone else produced.
 */
async function verifyGateStep(ctx: Ctx, step: ProvisionStep, gate: FirstUseGate): Promise<GateCheck> {
  const rest = ctx.rest;
  const check = rest
    ? await checkGate(rest, gate, ctx.scope.projectId!, gateLine(ctx, gate))
    : { gate, verdict: 'unknown' as const, status: 0, message: `${gate.service} first-use gate could not be verified: no REST channel` };
  if (check.verdict === 'open') {
    const evidence = { gate: 'open', status: check.status };
    const rel = storeResult(ctx.out, step.id, evidence);
    const prior = ctx.state.steps[step.id];
    ctx.state.steps[step.id] = { status: prior?.applied ? 'done' : 'existing', at: ctx.now(), applied: prior?.applied === true, result: rel, matchSha256: sha256(JSON.stringify(step.readBack.match ?? {})) };
    writeProvisionState(ctx.out, ctx.state);
  }
  return check;
}

/**
 * Never proceed past an unverified gate: every gate step before `id` in plan
 * order that is still open is probed now. An open answer records it; a closed
 * or unrecognised answer stops the run with the checklist line.
 */
async function gatesBefore(ctx: Ctx, id: string): Promise<string | undefined> {
  for (const step of ctx.plan.steps) {
    if (step.id === id) return undefined;
    const gate = gateForStep(step.id);
    if (!gate || ['done', 'existing'].includes(stepStatus(ctx.state, step.id))) continue;
    const check = await verifyGateStep(ctx, step, gate);
    if (check.verdict !== 'open') return `step ${id} waits on ${step.id}: ${check.message}`;
    ctx.io.stdout(`${check.message}\n`);
  }
  return undefined;
}

async function runStep(ctx: Ctx, id: string, confirm: boolean): Promise<number> {
  const step = findStep(ctx.plan, id);
  if (!step) {
    ctx.io.stderr(`c2c provision: no step "${id}" in provision/plan.json\n`);
    return 2;
  }
  if (step.via !== 'cli') {
    ctx.io.stderr(`c2c provision: --run is for cli steps; ${id} is via ${step.via}${step.via === 'mcp' ? ' (the host agent calls it; c2c never calls MCP)' : ' (the user does it in the console)'}\n`);
    return 2;
  }
  if (!confirm) {
    ctx.io.stderr(`c2c provision: --run ${id} performs live REST calls; pass --confirm\n`);
    return 2;
  }
  const current = stepStatus(ctx.state, id);
  if (current === 'done' || current === 'existing') {
    ctx.io.stdout(`${JSON.stringify({ step: id, ran: false, status: current, note: 'already recorded; nothing to do' }, null, 2)}\n`);
    if (id === 'import') printImportFields(ctx);
    return 0;
  }
  if (id === 'import' && ctx.scope.projectId) {
    // The import POSTs a NEW project. With a configured (or learned) id the
    // plan is for an existing project — importing now would mint an orphan.
    ctx.io.stderr(
      `c2c provision: the import step creates a new project, but a project id is already configured (${ctx.scope.sources.projectId ?? 'scope'}) — re-run c2c plan without a configured project, into a fresh --out\n`,
    );
    return 2;
  }
  if (!ctx.scope.projectId && id !== 'import') {
    ctx.io.stderr(`c2c provision: no project id for ${ctx.plan.app} — record the project read-back, or set apps.${ctx.plan.app}.project in c2c-deploy.json, or pass --project\n`);
    return 2;
  }
  if (!ctx.scope.org) {
    ctx.io.stderr('c2c provision: no org — pass --org or set "org" in c2c-deploy.json\n');
    return 2;
  }
  if (!ctx.scope.dc) {
    ctx.io.stderr('c2c provision: no data centre — pass --dc, set "dc" in c2c-deploy.json, or re-run c2c plan with --dc (a live call must know which DC the CLI logged into)\n');
    return 2;
  }
  const missing: string[] = [];
  const args = resolveTokens(step.args, ctx, missing) as Record<string, unknown>;
  if (missing.length) {
    ctx.io.stderr(`c2c provision: step ${id} has unresolved inputs ${missing.join(', ')} — fill provision/inputs.json (or the step's spec file), or record the prerequisite steps first\n`);
    return 2;
  }
  try {
    // A confirmed run proves the project before the first table, user, auth,
    // or cron call. The import creates the project — there is nothing to prove.
    if (id !== 'import') await assertLiveProject(ctx.io, ctx.scope.org, ctx.scope.projectId!);
    if (id !== 'import') {
      const waiting = await gatesBefore(ctx, id);
      if (waiting) {
        ctx.io.stderr(`c2c provision: ${waiting}\n`);
        return 1;
      }
    }
    const outcome = await executeCliStep(ctx, step, args);
    // The run's own output is first-party evidence — ids it reports feed the
    // learned map before the read-back match resolves, so <id:Table> tokens
    // can bind what this run just listed. Person rows can't seed the map.
    learnIds(stripPersonFields(outcome.result), ctx.state.learned);
    updateFunctionEnvFromCtx(ctx);
    const rel = storeResult(ctx.out, `${id}.run`, outcome.result);
    // A rerun that finds everything present must not erase the earlier
    // "we wrote" flag.
    const applied = outcome.applied || ctx.state.steps[id]?.applied === true;
    const matchMissing: string[] = [];
    const match = resolveTokens(step.readBack.match ?? {}, ctx, matchMissing) as Record<string, unknown>;
    // When the run result itself proves the read-back match (the tables
    // listing carries table ids, an auth POST echoes its flag), that is
    // reported either way.
    const verified = matchMissing.length === 0 && matchReadBack(outcome.result, match).ok;
    // Pin the resolved match (or the unresolved-token sentinel revalidate
    // computes) so a moved inputs.json is what reopens the step — not the
    // absence of a read-back file.
    const matchSha256 = matchMissing.length ? `unresolved:${[...new Set(matchMissing)].join(',')}` : sha256(JSON.stringify(match));
    if (!outcome.proven && !verified) {
      // Not a successful run and not a verified claim: an already-there 4xx
      // or a read that does not satisfy the match only claims the state.
      // The step stays open for a recorded read-back — it never self-closes.
      ctx.state.steps[id] = { status: 'applied', at: ctx.now(), applied, result: rel, matchSha256 };
      writeProvisionState(ctx.out, ctx.state);
      ctx.io.stdout(
        `${JSON.stringify(
          {
            step: id,
            ran: true,
            applied,
            status: 'applied',
            verified,
            result: rel,
            next: awaitingReadBack(step, id),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    // A proven run closes the step: `done` when it wrote, `existing` when
    // everything was already there and the answer proves the read-back match.
    ctx.state.steps[id] = { status: applied ? 'done' : 'existing', at: ctx.now(), applied, result: rel, matchSha256 };
    writeProvisionState(ctx.out, ctx.state);
    const next = progressSteps(ctx).find((item) => !['done', 'existing'].includes(stepStatus(ctx.state, item.id)));
    ctx.io.stdout(
      `${JSON.stringify({ step: id, ran: true, applied, status: ctx.state.steps[id]!.status, verified, result: rel, next: next ? next.id : null }, null, 2)}\n`,
    );
    if (id === 'import') printImportFields(ctx);
    return 0;
  } catch (err) {
    ctx.io.stderr(`c2c provision: ${err instanceof Error ? redactString(err.message) : 'run failed'}\n`);
    return 1;
  }
}

async function recordStep(ctx: Ctx, id: string, resultPath: string | undefined, appliedFlag: boolean): Promise<number> {
  const step = findStep(ctx.plan, id);
  if (!step) {
    ctx.io.stderr(`c2c provision: no step "${id}" in provision/plan.json\n`);
    return 2;
  }
  const prior = ctx.state.steps[id];
  if (appliedFlag && !resultPath) {
    // The agent performed the write; the read-back is still owed.
    ctx.state.steps[id] = { status: 'applied', at: ctx.now(), applied: true, ...(prior?.result ? { result: prior.result } : {}) };
    writeProvisionState(ctx.out, ctx.state);
    ctx.io.stdout(`${JSON.stringify({ step: id, status: 'applied', next: `record the read-back: c2c provision --record ${id} --result <file>` }, null, 2)}\n`);
    return 0;
  }

  const gate = gateForStep(id);
  if (gate) {
    // A first-use gate is verified by c2c's own read, never by a result file.
    if (resultPath !== undefined || appliedFlag) {
      ctx.io.stderr(`c2c provision: ${id} is verified by c2c itself — run c2c provision --record ${id} with no --result or --applied once the console step is done\n`);
      return 2;
    }
    if (!ctx.scope.projectId || !ctx.scope.org) {
      ctx.io.stderr('c2c provision: the gate read-back needs a project id and org (config or flags)\n');
      return 2;
    }
    const check = await verifyGateStep(ctx, step, gate);
    if (check.verdict !== 'open') {
      ctx.io.stderr(`c2c provision: ${check.message} The step stays open.\n`);
      return 1;
    }
    const next = ctx.plan.steps.find((item) => !['done', 'existing'].includes(stepStatus(ctx.state, item.id)));
    ctx.io.stdout(`${JSON.stringify({ step: id, status: ctx.state.steps[id]!.status, verified: check.message, next: next ? next.id : null }, null, 2)}\n`);
    return 0;
  }

  let result: unknown;
  if (resultPath !== undefined) {
    let parsed: unknown;
    try {
      parsed = parseJsonExact(readFileSync(resultPath, 'utf8'));
    } catch {
      ctx.io.stderr(`c2c provision: --result ${resultPath} is not readable JSON\n`);
      return 2;
    }
    result = unwrapResult(parsed);
  } else if (step.readBack.via === 'cli' && isProjectStep(step.id) && step.readBack.args === undefined) {
    if (!ctx.scope.org) {
      ctx.io.stderr('c2c provision: the project read-back needs an org (config or --org)\n');
      return 2;
    }
    try {
      result = await cliProjectReadBack(ctx, ctx.scope.org);
    } catch (err) {
      ctx.io.stderr(`c2c provision: cli read-back for ${id} failed: ${redactString(err instanceof Error ? err.message : String(err))}\n`);
      return 1;
    }
  } else if (step.readBack.via === 'cli') {
    const call = isRecord(step.readBack.args) ? step.readBack.args.call : undefined;
    if (!isRecord(call) || typeof call.path !== 'string') {
      ctx.io.stderr(`c2c provision: step ${id} has no cli read-back call — pass --result <file>\n`);
      return 2;
    }
    if (call.method !== undefined && call.method !== 'GET') {
      ctx.io.stderr(`c2c provision: the cli read-back for ${id} must be a GET (a read-back never writes) — fix provision/plan.json\n`);
      return 2;
    }
    if (!ctx.scope.projectId || !ctx.scope.org) {
      ctx.io.stderr('c2c provision: the cli read-back needs a project id and org (config or flags)\n');
      return 2;
    }
    if (!ctx.scope.dc) {
      ctx.io.stderr('c2c provision: the cli read-back needs a data centre — pass --dc, set "dc" in c2c-deploy.json, or re-run c2c plan with --dc\n');
      return 2;
    }
    try {
      // Build the path from the template and the project id. The plan text is not the request path.
      const answer = await checkedRetry(ctx, { method: 'GET', path: materialiseCliPath(call.path, ctx.scope.projectId) });
      result = answer.result.body;
    } catch (err) {
      ctx.io.stderr(`c2c provision: cli read-back for ${id} failed: ${redactString(err instanceof Error ? err.message : String(err))}\n`);
      return 1;
    }
  } else {
    ctx.io.stderr(`c2c provision: --record ${id} needs --result <file> (the read-back is via ${step.readBack.via}; the host agent or the user produces it)\n`);
    return 2;
  }

  const missing: string[] = [];
  const match = resolveTokens(step.readBack.match ?? {}, ctx, missing) as Record<string, unknown>;
  const { evidence, checked, ambiguous } = prepareReadBack(ctx, step, result, match, missing);
  if (missing.length) {
    ctx.io.stderr(`c2c provision: read-back match for ${id} has unresolved inputs ${[...new Set(missing)].join(', ')} — fill provision/inputs.json or record the prerequisite steps first\n`);
    return 2;
  }
  if (ambiguous) {
    ctx.io.stderr(`c2c provision: read-back for ${id} matches more than one project entry — c2c will not pick an id from a same-named crowd; set apps.${ctx.plan.app}.project in c2c-deploy.json or pass --project\n`);
    return 1;
  }
  const check = matchReadBack(checked, match);
  if (!check.ok) {
    ctx.io.stderr(`c2c provision: read-back for ${id} does not match the plan — the step stays open:\n${check.missing.map((line) => `  - ${line}`).join('\n')}\n`);
    return 1;
  }
  learnIds(stripPersonFields(evidence), ctx.state.learned);
  updateFunctionEnvFromCtx(ctx);
  if ((step.id === 'project' || step.id === 'import') && typeof step.args.name === 'string') {
    // An import may have created a suffixed name — look the name the run used
    // (or the customer's manual name) up, not just args.name.
    const wanted = step.id === 'import' ? (ctx.state.learned.importName ?? ctx.inputs.projectName ?? step.args.name) : step.args.name;
    const projectId = ownDecimalId(ctx.state.learned.byName, wanted);
    // The scope check sees only configured ids; the recorded name can still be protected.
    try {
      assertProtectedProject(ctx.scope.protectedProjects ?? {}, { id: projectId, name: wanted });
    } catch (err) {
      ctx.io.stderr(`c2c provision: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    if (projectId) {
      ctx.state.learned.projectId = projectId;
      updateFunctionEnvFromCtx(ctx);
    }
  }
  const applied = appliedFlag || prior?.applied === true;
  const rel = storeResult(ctx.out, id, evidence);
  // Pin the resolved match, not inputs.json: when the customer edits inputs
  // later, only steps whose resolved match actually moved get re-proven.
  ctx.state.steps[id] = { status: applied ? 'done' : 'existing', at: ctx.now(), applied, result: rel, matchSha256: sha256(JSON.stringify(match)) };
  writeProvisionState(ctx.out, ctx.state);
  const next = ctx.plan.steps.find((item) => !['done', 'existing'].includes(stepStatus(ctx.state, item.id)));
  ctx.io.stdout(
    `${JSON.stringify({ step: id, status: ctx.state.steps[id]!.status, match: 'ok', result: rel, next: next ? next.id : null }, null, 2)}\n`,
  );
  return 0;
}

/**
 * inputs.json is customer input, not a pinned file: a record is proof of the
 * match as it resolved at record time. When the resolved match moves (filled
 * inputs, a changed users list, a relearned id), the stored read-back is
 * re-checked; when it no longer proves the match the step reopens. Steps whose
 * match is unchanged — including inputs they never consumed — stay closed.
 */
function revalidateRecorded(ctx: Ctx): string[] {
  const reopened: string[] = [];
  let dirty = false;
  for (const step of ctx.plan.steps) {
    const record = ctx.state.steps[step.id];
    if (!record || (record.status !== 'done' && record.status !== 'existing')) continue;
    const missing: string[] = [];
    const match = resolveTokens(step.readBack.match ?? {}, ctx, missing) as Record<string, unknown>;
    const sha = missing.length ? `unresolved:${[...new Set(missing)].join(',')}` : sha256(JSON.stringify(match));
    if (record.matchSha256 === sha) continue;
    if (!missing.length && record.result) {
      let stored: unknown;
      try {
        stored = parseJsonExact(readFileSync(join(ctx.out, record.result), 'utf8'));
      } catch {
        stored = undefined;
      }
      if (stored !== undefined) {
        const prepMissing: string[] = [];
        const prepared = prepareReadBack(ctx, step, stored, match, prepMissing);
        if (!prepMissing.length && !prepared.ambiguous && matchReadBack(prepared.checked, match).ok) {
          record.matchSha256 = sha;
          dirty = true;
          continue;
        }
      }
    }
    delete ctx.state.steps[step.id];
    reopened.push(step.id);
    dirty = true;
  }
  if (dirty) writeProvisionState(ctx.out, ctx.state);
  return reopened;
}

// ---------------------------------------------------------------------------

/**
 * The argument checks provision makes before it reads anything: the message
 * to refuse with (exit 2), or undefined when the arguments are well formed.
 */
export function provisionArgsProblem(args: readonly string[]): string | undefined {
  const out = flag(args, '--out');
  const runId = flag(args, '--run');
  const recordId = flag(args, '--record');
  const verbs = [runId !== undefined, recordId !== undefined, args.includes('--next'), args.includes('--status')].filter(Boolean).length;
  if (args.includes('--import')) {
    // There is one way to create a project: the planned one-shot import.
    return 'c2c provision: --import is not a provision mode — run c2c plan <app> --out <dir>, then c2c provision --out <dir> --run import --confirm [--name <project-name>]\n';
  }
  if (!out || verbs > 1) return USAGE;
  if (args.includes('--name')) {
    if (runId !== 'import') return 'c2c provision: --name only applies to --run import (the step that creates the project)\n';
    const importName = flag(args, '--name');
    if (importName === undefined || !IMPORT_NAME.test(importName)) {
      return 'c2c provision: --name needs a project name of lower-case letters, digits and dashes (at most 50)\n';
    }
  }
  return undefined;
}

export async function provisionCli(args: readonly string[], io: Io, opts: { now?: () => string } = {}): Promise<number> {
  const problem = provisionArgsProblem(args);
  if (problem) {
    io.stderr(problem);
    return 2;
  }
  const out = flag(args, '--out') as string;
  const runId = flag(args, '--run');
  const recordId = flag(args, '--record');
  const importName = flag(args, '--name');
  let plan: ProvisionPlanFile;
  let planSha: string;
  try {
    ({ plan, sha: planSha } = loadProvisionPlan(out));
  } catch (err) {
    io.stderr(`c2c provision: ${err instanceof Error ? err.message : 'no plan'}\n`);
    return 2;
  }
  let state: ProvisionState | undefined;
  try {
    state = readProvisionState(out);
  } catch (err) {
    io.stderr(`c2c provision: ${err instanceof Error ? err.message : 'state.json is unreadable'}\n`);
    return 1;
  }
  if (state && (state.planSha256 !== planSha || state.app !== plan.app)) {
    io.stderr('c2c provision: provision/plan.json or a pinned side file (tables.json, crons.json, iac/*) changed since provision/state.json was written — re-run c2c plan into a fresh --out or delete provision/state.json\n');
    return 1;
  }
  state ??= { version: 1, app: plan.app, planSha256: planSha, learned: { byName: {} }, steps: {} };
  let scope: ProvisionScope;
  let inputs: ProvisionInputs;
  try {
    scope = resolveProvisionScope({ args, cwd: process.cwd(), app: plan.app, ...(plan.dc ? { planDc: plan.dc } : {}), ...(state.learned.projectId ? { learnedProjectId: state.learned.projectId } : {}) });
    inputs = readProvisionInputs(out);
  } catch (err) {
    io.stderr(`c2c provision: ${err instanceof Error ? err.message : 'config failed'}\n`);
    return 2;
  }
  // --domain is validated at the door like inputs.json slateDomain: the value
  // lands verbatim in the cors-domain body and invite redirect_url.
  const domainFlag = flag(args, '--domain');
  const slateDomainFlag = domainFlag === undefined ? undefined : slateHost(domainFlag);
  if (domainFlag !== undefined && !slateDomainFlag) {
    io.stderr('c2c provision: --domain must be a Slate app host — a bare hostname or the https App Url slate:link prints\n');
    return 2;
  }
  const ctx: Ctx = {
    out,
    plan,
    state,
    scope,
    inputs,
    ...(slateDomainFlag !== undefined ? { domainFlag: slateDomainFlag } : {}),
    ...(importName !== undefined ? { importName } : {}),
    io,
    now: opts.now ?? (() => new Date().toISOString()),
    ...(scope.org && scope.projectId
      ? { rest: io.rest ?? ((call: RestCall) => catalystRestCall(io.env, scope.org!, scope.projectId!, call, { log: (line) => io.stderr(`${line}\n`) })) }
      : io.rest
        ? { rest: io.rest }
        : {}),
  };
  const reopened = revalidateRecorded(ctx);
  if (reopened.length) {
    io.stderr(`c2c provision: provision/inputs.json changed since ${reopened.join(', ')} was recorded — the stored read-back no longer proves the resolved match; the step(s) reopened, re-run/read-back and record again\n`);
  }
  if (runId !== undefined) return runStep(ctx, runId, args.includes('--confirm'));
  if (recordId !== undefined) return recordStep(ctx, recordId, flag(args, '--result'), args.includes('--applied'));
  if (args.includes('--next')) return emitNext(ctx);
  return printStatus(ctx);
}
