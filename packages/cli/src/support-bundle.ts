/**
 * `c2c support-bundle --out <file> [--app <name>] [--stderr-file <file>]`
 *
 * Offline, read-only diagnostics bundle to attach when reporting a migration
 * or deploy error. Collects:
 *   1. `c2c doctor` JSON (`c2c-out/.c2c/doctor.json`) and its gate verdict /
 *      refusal message.
 *   2. The allow-listed deploy, plan, provision, verify, parity, fidelity,
 *      loader, smoke, and proof reports present under `c2c-out/<app>/`.
 *   3. CLI (`c2c`), plugin, and Node versions.
 *   4. The failing command's stderr (`--stderr-file <file>`, or
 *      `c2c-out/.c2c/last-stderr.log` when present).
 *   5. A manifest listing every item included in the bundle (also printed to
 *      stdout).
 *
 * Security model:
 *   - Redacts by allow-list (only named files and named schema fields are
 *     projected; unknown files such as `function-env.json`, `inputs.json`,
 *     `seed.json`, CSV/JSON row exports, and unknown JSON properties such as
 *     `rows`, `records`, `env`, `token`, `refresh_token`, `email` are dropped).
 *   - Every included string passes through `redactBundleText`, which scrubs
 *     any non-derivable values from local `function-env.json` /
 *     `~/.c2c/*function-env*.json` files and applies token, credential,
 *     OAuth/refresh token, env-assignment, URL, and email redaction.
 *   - Never makes a network or account call; the only filesystem write is
 *     `--out <file>`.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag, isDerivableEnvKey, redactString } from '../../deploy/src/index.js';
import {
  c2cVersion,
  doctorJsonPath,
  evaluateGate,
  gateRefusalMessage,
  workspaceDir,
  type GateScope,
  type GateStatus,
} from '../../doctor/src/index.js';

export const SUPPORT_BUNDLE_SCHEMA = 'c2c-support-bundle/1';

export const SUPPORT_BUNDLE_USAGE =
  'usage: c2c support-bundle --out <file> [--force] [--app <name>] [--stderr-file <file>]\n' +
  '       (offline, read-only: allow-listed diagnostics bundle; the only write is <file>.\n' +
  '        <file> must not exist unless --force is passed; its parent directory must\n' +
  '        already exist and must not be a symlink or contain a symlinked component)\n';

const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_STDERR_LINES = 500;

/** Common API/OAuth token shapes that may be shorter than 20 chars or lack digits. */
const EXTRA_TOKEN_RE =
  /\b(?:(?:sk|pk|rk)_(?:live|test|prod)_[A-Za-z0-9_-]{4,}|(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{6,}|xox[baprs]-[A-Za-z0-9-]{6,}|1000\.[0-9a-zA-Z._-]{6,}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?|[A-Za-z0-9_-]*(?:token|secret|passwd|password|apikey|api_key|oauth|refresh)[A-Za-z0-9_-]*_[A-Za-z0-9_-]{4,}|(?:token|secret|passwd|password|apikey|api_key|oauth|refresh)_[A-Za-z0-9_-]{4,})\b/gi;

/** Shell or dotenv style `KEY=VALUE` assignments in stderr or diagnostic text. */
const ENV_ASSIGN_RE =
  /((?:^|[\s;,(])(?:export\s+|set\s+)?)([A-Z][A-Z0-9_]{1,})(\s*=\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'<>)\]},;]+)/gm;

/** Flags whose following argv token in a command list must always be redacted. */
const SECRET_ARGV_FLAGS = new Set([
  '--auth-token',
  '--session-cookie',
  '--admin-email',
  '--mail-from',
  '--function-env',
  '--email',
  '--salt',
  '--login-user',
]);

const BENIGN_SECRET_LITERALS = new Set([
  'true',
  'false',
  'null',
  'none',
  'development',
  'production',
  'dry-run',
  'react',
  'vanilla',
  'pass',
  'warn',
  'fail',
  'skip',
]);

export interface SupportBundleIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
}

export interface SupportBundleDoctor {
  ok: boolean;
  status: GateStatus;
  refusal?: string;
  report?: Record<string, unknown>;
}

export interface SupportBundle {
  schema: typeof SUPPORT_BUNDLE_SCHEMA;
  manifest: string[];
  versions: {
    c2c: string;
    plugin: string;
    node: string;
  };
  doctor: SupportBundleDoctor;
  apps: Record<string, Record<string, unknown>>;
  stderr?: {
    lines: string[];
    truncated?: boolean;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeAppName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed !== '.' &&
    trimmed !== '..' &&
    !trimmed.startsWith('.') &&
    !trimmed.includes('/') &&
    !trimmed.includes('\\') &&
    !trimmed.includes('\0')
  );
}

/** Offline argument validation for `c2c support-bundle`. */
export function supportBundleArgsProblem(args: readonly string[]): string | undefined {
  const out = flag(args, '--out');
  if (!out) return 'c2c support-bundle: --out <file> is required';
  const app = flag(args, '--app');
  if (app !== undefined && !isSafeAppName(app)) {
    return 'c2c support-bundle: --app must be an application directory name under c2c-out';
  }
  const stderrFile = flag(args, '--stderr-file');
  if (stderrFile !== undefined && !stderrFile.trim()) {
    return 'c2c support-bundle: --stderr-file needs a file path';
  }
  return undefined;
}

function readPluginVersion(): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  for (const rel of ['plugin/.claude-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, rel), 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      /* fall through */
    }
  }
  return c2cVersion();
}

function safeRealpath(target: string): string | undefined {
  try {
    return realpathSync(target);
  } catch {
    return undefined;
  }
}

function isContainedRegularFile(filePath: string, rootReal: string, maxBytes = MAX_REPORT_BYTES): boolean {
  try {
    const st = lstatSync(filePath, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || !st.isFile() || st.size > maxBytes) return false;
    const real = safeRealpath(filePath);
    if (!real) return false;
    const rel = relative(rootReal, real);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false;
  }
}

function readContainedJson(filePath: string, rootReal: string): Record<string, unknown> | undefined {
  if (!isContainedRegularFile(filePath, rootReal, MAX_REPORT_BYTES)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function addSecretLiteral(set: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length < 4 || BENIGN_SECRET_LITERALS.has(trimmed.toLowerCase())) return;
  if (/^[0-9]+$/.test(trimmed)) return;
  set.add(trimmed);
}

function harvestEnvObjectSecrets(obj: Record<string, unknown>, out: Set<string>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (isDerivableEnvKey(key)) continue;
    if (typeof value === 'string') addSecretLiteral(out, value);
  }
}

function tryHarvestFunctionEnvFile(filePath: string, out: Set<string>): void {
  try {
    const fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_STDERR_BYTES) return;
      const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (!isRecord(parsed)) return;
      harvestEnvObjectSecrets(parsed, out);
      if ( isRecord(parsed.deployment) && isRecord(parsed.deployment.env_variables)) {
        harvestEnvObjectSecrets(parsed.deployment.env_variables, out);
      }
      if (typeof parsed.senderEmail === 'string') addSecretLiteral(out, parsed.senderEmail);
      if (Array.isArray(parsed.users)) {
        for (const user of parsed.users) {
          if (isRecord(user) && typeof user.email_id === 'string') addSecretLiteral(out, user.email_id);
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    /* ignore unreadable or absent env files */
  }
}

/**
 * Gather any secret values from local `function-env.json` or `~/.c2c/*.json`
 * files in memory so that if a failing command echoed an env value into stderr
 * or an error string, `redactBundleText` scrubs it before writing the bundle.
 * The env files themselves are never included in the bundle.
 */
function collectSecretLiterals(workspace: string, env: NodeJS.ProcessEnv): string[] {
  const found = new Set<string>();
  tryHarvestFunctionEnvFile(join(workspace, 'function-env.json'), found);
  const outDir = join(workspace, 'c2c-out');
  try {
    const st = lstatSync(outDir, { throwIfNoEntry: false });
    if (st && !st.isSymbolicLink() && st.isDirectory()) {
      tryHarvestFunctionEnvFile(join(outDir, 'function-env.json'), found);
      tryHarvestFunctionEnvFile(join(outDir, 'provision', 'inputs.json'), found);
      for (const entry of readdirSync(outDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const appDir = join(outDir, entry.name);
        tryHarvestFunctionEnvFile(join(appDir, 'function-env.json'), found);
        tryHarvestFunctionEnvFile(join(appDir, 'provision', 'inputs.json'), found);
        tryHarvestFunctionEnvFile(join(appDir, 'functions', 'c2c_api', 'catalyst-config.json'), found);
      }
    }
  } catch {
    /* ignore */
  }
  for (const [key, value] of Object.entries(env)) {
    if (isDerivableEnvKey(key)) continue;
    if (!/token|secret|password|passwd|api[-_]?key|credential|cookie|session|private|auth/i.test(key)) continue;
    addSecretLiteral(found, value);
  }
  const home = (typeof env.HOME === 'string' && env.HOME.trim()) || homedir();
  if (home) {
    const dotC2c = join(home, '.c2c');
    try {
      const st = lstatSync(dotC2c, { throwIfNoEntry: false });
      if (st && !st.isSymbolicLink() && st.isDirectory()) {
        for (const entry of readdirSync(dotC2c, { withFileTypes: true })) {
          if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json')) {
            tryHarvestFunctionEnvFile(join(dotC2c, entry.name), found);
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

/** Redact tokens, credentials, OAuth/refresh tokens, env values, URLs, and emails from a string. */
export function redactBundleText(value: string, secretLiterals: readonly string[] = []): string {
  let out = value;
  for (const literal of secretLiterals) {
    if (!literal) continue;
    if (out.includes(literal)) {
      out = out.split(literal).join('<redacted>');
    }
    for (const encoded of [Buffer.from(literal, 'utf8').toString('base64'), Buffer.from(literal, 'utf8').toString('base64url')]) {
      if (encoded !== literal && out.includes(encoded)) {
        out = out.split(encoded).join('<redacted>');
      }
    }
  }
  out = redactString(out);
  out = out.replace(EXTRA_TOKEN_RE, '<token>');
  out = out.replace(ENV_ASSIGN_RE, (_m, prefix: string, key: string, sep: string) => `${prefix}${key}${sep}<redacted>`);
  return out;
}

function cleanString(value: unknown, secrets: readonly string[]): string | undefined {
  return typeof value === 'string' ? redactBundleText(value, secrets) : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cleanBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function cleanStringArray(value: unknown, secrets: readonly string[]): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string').map((item) => redactBundleText(item, secrets));
}

function cleanEnvKeyArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(item));
}

function projectScope(raw: unknown, secrets: readonly string[]): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const key of ['dc', 'org', 'project', 'app'] as const) {
    const val = cleanString(raw[key], secrets);
    if (val !== undefined) out[key] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Allow-list projection for `c2c-out/.c2c/doctor.json`. */
function projectDoctorReport(raw: Record<string, unknown>, secrets: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const c2c = cleanString(raw.c2c, secrets);
  if (c2c !== undefined) out.c2c = c2c;
  const at = cleanString(raw.at, secrets);
  if (at !== undefined) out.at = at;
  const host = cleanString(raw.host, secrets);
  if (host !== undefined) out.host = host;
  const green = cleanBoolean(raw.green);
  if (green !== undefined) out.green = green;
  const scope = projectScope(raw.scope, secrets);
  if (scope) out.scope = scope;
  if (Array.isArray(raw.checks)) {
    // Only id, status, detail, and fix are allow-listed; `screen` (which can carry a masked login email) is dropped.
    out.checks = raw.checks.filter(isRecord).map((check) => {
      const item: Record<string, unknown> = {};
      const id = cleanString(check.id, secrets);
      if (id !== undefined) item.id = id;
      const status = cleanString(check.status, secrets);
      if (status !== undefined) item.status = status;
      const detail = cleanString(check.detail, secrets);
      if (detail !== undefined) item.detail = detail;
      const fix = cleanString(check.fix, secrets);
      if (fix !== undefined) item.fix = fix;
      return item;
    });
  }
  if (isRecord(raw.mcp)) {
    const mcp: Record<string, unknown> = {};
    for (const key of ['server', 'shape', 'host', 'transport', 'at', 'source'] as const) {
      const val = cleanString(raw.mcp[key], secrets);
      if (val !== undefined) mcp[key] = val;
    }
    const mcpScope = projectScope(raw.mcp.scope, secrets);
    if (mcpScope) mcp.scope = mcpScope;
    const tools = cleanStringArray(raw.mcp.tools, secrets);
    if (tools) mcp.tools = tools;
    if (isRecord(raw.mcp.binding)) {
      const binding: Record<string, unknown> = {};
      for (const key of ['kind', 'name', 'status', 'detail'] as const) {
        const val = cleanString(raw.mcp.binding[key], secrets);
        if (val !== undefined) binding[key] = val;
      }
      if (Object.keys(binding).length) mcp.binding = binding;
    }
    out.mcp = mcp;
  }
  if (isRecord(raw.mcpReused)) {
    const reused: Record<string, unknown> = {};
    const observedAt = cleanString(raw.mcpReused.observedAt, secrets);
    if (observedAt !== undefined) reused.observedAt = observedAt;
    const expires = cleanString(raw.mcpReused.expires, secrets);
    if (expires !== undefined) reused.expires = expires;
    if (Object.keys(reused).length) out.mcpReused = reused;
  }
  if (Array.isArray(raw.deferred)) {
    out.deferred = raw.deferred.filter(isRecord).map((entry) => {
      const item: Record<string, unknown> = {};
      const id = cleanString(entry.id, secrets);
      if (id !== undefined) item.id = id;
      const reason = cleanString(entry.reason, secrets);
      if (reason !== undefined) item.reason = reason;
      return item;
    });
  }
  return out;
}

function redactArgvList(argv: unknown, secrets: readonly string[]): string[] | undefined {
  if (!Array.isArray(argv)) return undefined;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = typeof argv[i] === 'string' ? (argv[i] as string) : String(argv[i] ?? '');
    if (SECRET_ARGV_FLAGS.has(token)) {
      out.push(token);
      if (i + 1 < argv.length) {
        out.push('<redacted>');
        i += 1;
      }
      continue;
    }
    out.push(redactBundleText(token, secrets));
  }
  return out;
}

function projectConstraints(raw: unknown, secrets: readonly string[]): Record<string, unknown>[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter(isRecord).map((entry) => {
    const item: Record<string, unknown> = {};
    for (const key of ['table', 'column', 'constraint', 'action', 'reason'] as const) {
      const val = cleanString(entry[key], secrets);
      if (val !== undefined) item[key] = val;
    }
    return item;
  });
}

/** Allow-list projection for `c2c-deploy-report.json`. */
function projectDeployReport(raw: Record<string, unknown>, secrets: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['project', 'projectId', 'environment', 'dc', 'ui', 'tableError'] as const) {
    const val = cleanString(raw[key], secrets);
    if (val !== undefined) out[key] = val;
  }
  if (raw.dcSource === null || typeof raw.dcSource === 'string') {
    out.dcSource = raw.dcSource === null ? null : redactBundleText(raw.dcSource, secrets);
  }
  const exitCode = cleanNumber(raw.exitCode);
  if (exitCode !== undefined) out.exitCode = exitCode;
  if (isRecord(raw.tableDiff)) {
    const diff: Record<string, unknown> = {};
    for (const key of ['createdTables', 'existingTables', 'shadowsOnExistingRows'] as const) {
      const list = cleanStringArray(raw.tableDiff[key], secrets);
      if (list) diff[key] = list;
    }
    for (const key of ['createdColumns', 'existingColumns'] as const) {
      const map = raw.tableDiff[key];
      if (isRecord(map)) {
        const cleanMap: Record<string, string[]> = {};
        for (const [table, cols] of Object.entries(map)) {
          const cleanCols = cleanStringArray(cols, secrets);
          if (cleanCols) cleanMap[redactBundleText(table, secrets)] = cleanCols;
        }
        diff[key] = cleanMap;
      }
    }
    out.tableDiff = diff;
  }
  const constraints = projectConstraints(raw.constraints, secrets);
  if (constraints) out.constraints = constraints;
  if (Array.isArray(raw.commands)) {
    out.commands = raw.commands
      .map((cmd) => redactArgvList(cmd, secrets))
      .filter((cmd): cmd is string[] => cmd !== undefined);
  }
  const skipped = cleanStringArray(raw.skipped, secrets);
  if (skipped) out.skipped = skipped;
  if (Array.isArray(raw.auth)) {
    out.auth = raw.auth.filter(isRecord).map((op) => {
      const item: Record<string, unknown> = {};
      for (const key of ['id', 'status', 'code', 'message'] as const) {
        const val = cleanString(op[key], secrets);
        if (val !== undefined) item[key] = val;
      }
      return item;
    });
  }
  if (Array.isArray(raw.postDeploySteps)) {
    out.postDeploySteps = raw.postDeploySteps.filter(isRecord).map((step) => {
      const item: Record<string, unknown> = {};
      for (const key of ['kind', 'projectId', 'text'] as const) {
        const val = cleanString(step[key], secrets);
        if (val !== undefined) item[key] = val;
      }
      const services = cleanStringArray(step.services, secrets);
      if (services) item.services = services;
      return item;
    });
  }
  const checklist = cleanStringArray(raw.humanChecklist, secrets);
  if (checklist) out.humanChecklist = checklist;
  if (isRecord(raw.slate)) {
    const notice = cleanString(raw.slate.notice, secrets);
    out.slate = notice !== undefined ? { notice } : {};
  }
  return out;
}

/** Allow-list projection for `plan.json`. */
function projectPlanReport(raw: Record<string, unknown>, secrets: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const version = cleanNumber(raw.version);
  if (version !== undefined) out.version = version;
  for (const key of ['command', 'c2c', 'app', 'dc', 'dcSource', 'doctor'] as const) {
    const val = cleanString(raw[key], secrets);
    if (val !== undefined) out[key] = val;
  }
  if (isRecord(raw.counts)) {
    const counts: Record<string, number> = {};
    for (const key of [
      'tables',
      'dataStoreTables',
      'columns',
      'nosqlTables',
      'functions',
      'schedules',
      'reports',
      'pages',
      'roles',
      'customApis',
    ] as const) {
      const num = cleanNumber(raw.counts[key]);
      if (num !== undefined) counts[key] = num;
    }
    out.counts = counts;
  }
  if (Array.isArray(raw.tables)) {
    out.tables = raw.tables.filter(isRecord).map((table) => {
      const item: Record<string, unknown> = {};
      for (const key of ['name', 'form', 'role', 'nosqlReason'] as const) {
        const val = cleanString(table[key], secrets);
        if (val !== undefined) item[key] = val;
      }
      const nosql = cleanBoolean(table.nosql);
      if (nosql !== undefined) item.nosql = nosql;
      for (const key of ['columns', 'uniqueVarchar', 'fks'] as const) {
        const num = cleanNumber(table[key]);
        if (num !== undefined) item[key] = num;
      }
      return item;
    });
  }
  if (Array.isArray(raw.fieldGaps)) {
    out.fieldGaps = raw.fieldGaps.filter(isRecord).map((gap) => {
      const item: Record<string, unknown> = {};
      for (const key of ['form', 'field', 'kind', 'status', 'reason'] as const) {
        const val = cleanString(gap[key], secrets);
        if (val !== undefined) item[key] = val;
      }
      return item;
    });
  }
  const constraints = projectConstraints(raw.constraints, secrets);
  if (constraints) out.constraints = constraints;
  if (Array.isArray(raw.budgets)) {
    out.budgets = raw.budgets.filter(isRecord).map((budget) => {
      const item: Record<string, unknown> = {};
      for (const key of ['id', 'table', 'status', 'detail', 'fix'] as const) {
        const val = cleanString(budget[key], secrets);
        if (val !== undefined) item[key] = val;
      }
      return item;
    });
  }
  const budgetsOk = cleanBoolean(raw.budgetsOk);
  if (budgetsOk !== undefined) out.budgetsOk = budgetsOk;
  if (Array.isArray(raw.probes)) {
    out.probes = raw.probes.filter(isRecord).map((probe) => {
      const item: Record<string, unknown> = {};
      for (const key of ['id', 'measures', 'reason'] as const) {
        const val = cleanString(probe[key], secrets);
        if (val !== undefined) item[key] = val;
      }
      const needed = cleanBoolean(probe.needed);
      if (needed !== undefined) item.needed = needed;
      return item;
    });
  }
  const secretKeys = cleanEnvKeyArray(raw.connectionSecretKeys);
  if (secretKeys) out.connectionSecretKeys = secretKeys;
  return out;
}

/** Allow-list projection for `provision/plan.json`. */
function projectProvisionPlan(raw: Record<string, unknown>, secrets: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const version = cleanNumber(raw.version);
  if (version !== undefined) out.version = version;
  for (const key of ['app', 'dc'] as const) {
    const val = cleanString(raw[key], secrets);
    if (val !== undefined) out[key] = val;
  }
  const secretKeys = cleanEnvKeyArray(raw.connectionSecretKeys);
  if (secretKeys) out.connectionSecretKeys = secretKeys;
  if (Array.isArray(raw.steps)) {
    out.steps = raw.steps.filter(isRecord).map((step) => {
      const item: Record<string, unknown> = {};
      for (const key of ['id', 'via', 'tool', 'command'] as const) {
        const val = cleanString(step[key], secrets);
        if (val !== undefined) item[key] = val;
      }
      if (isRecord(step.readBack)) {
        const rb: Record<string, unknown> = {};
        for (const key of ['via', 'tool', 'command'] as const) {
          const val = cleanString(step.readBack[key], secrets);
          if (val !== undefined) rb[key] = val;
        }
        if (Object.keys(rb).length) item.readBack = rb;
      }
      return item;
    });
  }
  return out;
}

/** Allow-list projection for `provision/state.json`. */
function projectProvisionState(raw: Record<string, unknown>, secrets: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const version = cleanNumber(raw.version);
  if (version !== undefined) out.version = version;
  for (const key of ['app', 'planSha256'] as const) {
    const val = cleanString(raw[key], secrets);
    if (val !== undefined) out[key] = val;
  }
  if (isRecord(raw.learned)) {
    const learned: Record<string, unknown> = {};
    for (const key of ['projectId', 'importName'] as const) {
      const val = cleanString(raw.learned[key], secrets);
      if (val !== undefined) learned[key] = val;
    }
    if (isRecord(raw.learned.imports)) {
      const imports: Record<string, Record<string, string>> = {};
      for (const [name, entry] of Object.entries(raw.learned.imports)) {
        if (!isRecord(entry)) continue;
        const rec: Record<string, string> = {};
        const importId = cleanString(entry.importId, secrets);
        if (importId !== undefined) rec.importId = importId;
        const status = cleanString(entry.status, secrets);
        if (status !== undefined) rec.status = status;
        imports[redactBundleText(name, secrets)] = rec;
      }
      learned.imports = imports;
    }
    if (isRecord(raw.learned.inProjectProbe)) {
      const probe: Record<string, string> = {};
      for (const key of ['name', 'projectId', 'at'] as const) {
        const val = cleanString(raw.learned.inProjectProbe[key], secrets);
        if (val !== undefined) probe[key] = val;
      }
      if (Object.keys(probe).length) learned.inProjectProbe = probe;
    }
    if (isRecord(raw.learned.byName)) {
      const byName: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.learned.byName)) {
        if (typeof v === 'string') byName[redactBundleText(k, secrets)] = redactBundleText(v, secrets);
      }
      learned.byName = byName;
    }
    out.learned = learned;
  }
  if (isRecord(raw.steps)) {
    const steps: Record<string, Record<string, unknown>> = {};
    for (const [stepId, rec] of Object.entries(raw.steps)) {
      if (!isRecord(rec)) continue;
      const item: Record<string, unknown> = {};
      for (const key of ['status', 'at', 'result', 'matchSha256'] as const) {
        const val = cleanString(rec[key], secrets);
        if (val !== undefined) item[key] = val;
      }
      const applied = cleanBoolean(rec.applied);
      if (applied !== undefined) item.applied = applied;
      steps[redactBundleText(stepId, secrets)] = item;
    }
    out.steps = steps;
  }
  return out;
}

/**
 * Allow-list projection for verify, parity, behavior, fidelity, and loader
 * reports (`verify/report.json`, `c2c-verify-report.json`, `c2c-parity.json`,
 * `c2c-behavior-report.json`, `c2c-fidelity.json`, `c2c-loader-report.json`).
 * Never includes cell values, row payloads, or behavior `expected`/`actual` values.
 */
function projectVerifyOrDataReport(raw: Record<string, unknown>, secrets: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['version', 'schema', 'kind', 'app', 'mode', 'status', 'error'] as const) {
    const val = cleanString(raw[key], secrets);
    if (val !== undefined) out[key] = val;
  }
  for (const key of ['ok', 'dryRun'] as const) {
    const val = cleanBoolean(raw[key]);
    if (val !== undefined) out[key] = val;
  }
  const reasons = cleanStringArray(raw.reasons, secrets);
  if (reasons) out.reasons = reasons;
  const eq = cleanNumber(raw.behaviorEquivalentApps);
  if (eq !== undefined) out.behaviorEquivalentApps = eq;
  if (isRecord(raw.summary)) {
    const summary: Record<string, number> = {};
    for (const key of ['cases', 'steps', 'findings'] as const) {
      const num = cleanNumber(raw.summary[key]);
      if (num !== undefined) summary[key] = num;
    }
    if (Object.keys(summary).length) out.summary = summary;
  }
  if (Array.isArray(raw.tables)) {
    out.tables = raw.tables.filter(isRecord).map((table) => {
      const item: Record<string, unknown> = {};
      for (const key of [
        'table',
        'sourceChecksum',
        'storedChecksum',
        'writtenChecksum',
        'sourceValueChecksum',
        'writtenValueChecksum',
        'error',
      ] as const) {
        const val = cleanString(table[key], secrets);
        if (val !== undefined) item[key] = val;
      }
      for (const key of ['sourceCount', 'storedCount', 'writtenCount', 'unattributed', 'batches'] as const) {
        const num = cleanNumber(table[key]);
        if (num !== undefined) item[key] = num;
      }
      for (const key of ['idsMatch', 'valuesMatch', 'mismatch'] as const) {
        const bool = cleanBoolean(table[key]);
        if (bool !== undefined) item[key] = bool;
      }
      for (const key of ['missingIds', 'extraIds', 'changedIds', 'differingIds', 'duplicateIds', 'reasons'] as const) {
        const arr = cleanStringArray(table[key], secrets);
        if (arr) item[key] = arr;
      }
      if (Array.isArray(table.refusals)) {
        item.refusals = table.refusals.filter(isRecord).map((ref) => {
          const r: Record<string, string> = {};
          for (const k of ['id', 'column', 'rule'] as const) {
            const v = cleanString(ref[k], secrets);
            if (v !== undefined) r[k] = v;
          }
          return r;
        });
      }
      return item;
    });
  }
  if (Array.isArray(raw.findings)) {
    // Only case, step, and pointer are allow-listed; expected/actual hold record values and are omitted.
    out.findings = raw.findings.filter(isRecord).map((finding) => {
      const item: Record<string, unknown> = {};
      const c = cleanString(finding.case, secrets);
      if (c !== undefined) item.case = c;
      const step = cleanNumber(finding.step);
      if (step !== undefined) item.step = step;
      const pointer = cleanString(finding.pointer, secrets);
      if (pointer !== undefined) item.pointer = pointer;
      return item;
    });
  }
  if (isRecord(raw.integrity)) {
    const integrity: Record<string, unknown> = {};
    const verified = cleanBoolean(raw.integrity.verified);
    if (verified !== undefined) integrity.verified = verified;
    const refusedCount = cleanNumber(raw.integrity.refusedCount);
    if (refusedCount !== undefined) integrity.refusedCount = refusedCount;
    if (isRecord(raw.integrity.refusedByRule)) {
      const byRule: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw.integrity.refusedByRule)) {
        const n = cleanNumber(v);
        if (n !== undefined) byRule[redactBundleText(k, secrets)] = n;
      }
      integrity.refusedByRule = byRule;
    }
    if (Object.keys(integrity).length) out.integrity = integrity;
  }
  if (Array.isArray(raw.skipped)) {
    out.skipped = raw.skipped.filter(isRecord).map((entry) => {
      const item: Record<string, string> = {};
      for (const key of ['form', 'table', 'reason'] as const) {
        const val = cleanString(entry[key], secrets);
        if (val !== undefined) item[key] = val;
      }
      return item;
    });
  }
  return out;
}

function projectSmokeSlot(raw: Record<string, unknown>, secrets: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['version', 'status', 'session', 'blocker'] as const) {
    const val = cleanString(raw[key], secrets);
    if (val !== undefined) out[key] = val;
  }
  const ok = cleanBoolean(raw.ok);
  if (ok !== undefined) out.ok = ok;
  if (Array.isArray(raw.steps)) {
    out.steps = raw.steps.filter(isRecord).map((step) => {
      const item: Record<string, string> = {};
      const name = cleanString(step.name, secrets);
      if (name !== undefined) item.name = name;
      const status = cleanString(step.status, secrets);
      if (status !== undefined) item.status = status;
      return item;
    });
  }
  const lines = cleanStringArray(raw.lines, secrets);
  if (lines) out.lines = lines;
  return out;
}

/** Allow-list projection for `c2c-proof.json`. */
function projectProofReport(raw: Record<string, unknown>, secrets: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['schema', 'app', 'checksum', 'source', 'checkpointSince'] as const) {
    const val = cleanString(raw[key], secrets);
    if (val !== undefined) out[key] = val;
  }
  if (Array.isArray(raw.tables)) {
    out.tables = raw.tables.filter(isRecord).map((table) => {
      const item: Record<string, unknown> = {};
      for (const key of ['table', 'form', 'sourceChecksum', 'checkpointChecksum'] as const) {
        const val = cleanString(table[key], secrets);
        if (val !== undefined) item[key] = val;
      }
      for (const key of ['sourceRows', 'checkpointRows'] as const) {
        const num = cleanNumber(table[key]);
        if (num !== undefined) item[key] = num;
      }
      const match = cleanBoolean(table.match);
      if (match !== undefined) item.match = match;
      if (isRecord(table.delta)) {
        const delta: Record<string, unknown> = {};
        for (const k of ['new', 'changed', 'deleted'] as const) {
          const n = cleanNumber(table.delta[k]);
          if (n !== undefined) delta[k] = n;
        }
        const missing = cleanBoolean(table.delta.missing);
        if (missing !== undefined) delta.missing = missing;
        if (Object.keys(delta).length) item.delta = delta;
      }
      return item;
    });
  }
  if (isRecord(raw.smoke)) {
    out.smoke = projectSmokeSlot(raw.smoke, secrets);
  }
  if (isRecord(raw.readiness)) {
    const readiness: Record<string, unknown> = {};
    const automatic = cleanNumber(raw.readiness.automatic);
    if (automatic !== undefined) readiness.automatic = automatic;
    const band = cleanString(raw.readiness.band, secrets);
    if (band !== undefined) readiness.band = band;
    const manual = cleanStringArray(raw.readiness.manual, secrets);
    if (manual) readiness.manual = manual;
    if (Object.keys(readiness).length) out.readiness = readiness;
  }
  return out;
}

interface ReportSpec {
  relPath: string;
  project: (raw: Record<string, unknown>, secrets: readonly string[]) => Record<string, unknown>;
}

/**
 * The allow-listed report files collected from each `c2c-out/<app>/` directory.
 * Any file not in this list (such as `function-env.json`, `provision/inputs.json`,
 * `seed.json`, CSV/JSON row dumps, or credential files) is ignored.
 */
const ALLOWED_APP_REPORTS: readonly ReportSpec[] = [
  { relPath: 'c2c-deploy-report.json', project: projectDeployReport },
  { relPath: 'plan.json', project: projectPlanReport },
  { relPath: 'provision/plan.json', project: projectProvisionPlan },
  { relPath: 'provision/state.json', project: projectProvisionState },
  { relPath: 'verify/report.json', project: projectVerifyOrDataReport },
  { relPath: 'c2c-verify-report.json', project: projectVerifyOrDataReport },
  { relPath: 'c2c-behavior-report.json', project: projectVerifyOrDataReport },
  { relPath: 'c2c-parity.json', project: projectVerifyOrDataReport },
  { relPath: 'c2c-fidelity.json', project: projectVerifyOrDataReport },
  { relPath: 'c2c-loader-report.json', project: projectVerifyOrDataReport },
  { relPath: 'c2c-proof.json', project: projectProofReport },
  { relPath: 'c2c-smoke-report.json', project: projectSmokeSlot },
  { relPath: 'smoke.json', project: projectSmokeSlot },
];

function readWorkspaceDeployScope(workspace: string, rootReal: string): GateScope {
  const cfg = readContainedJson(join(workspace, 'c2c-deploy.json'), rootReal);
  if (!cfg) return {};
  const dc = typeof cfg.dc === 'string' && cfg.dc.trim() ? cfg.dc.trim() : typeof cfg.zohoDc === 'string' && cfg.zohoDc.trim() ? cfg.zohoDc.trim() : undefined;
  const org = typeof cfg.org === 'string' && cfg.org.trim() ? cfg.org.trim() : undefined;
  const project = typeof cfg.project === 'string' && cfg.project.trim() ? cfg.project.trim() : undefined;
  return {
    ...(dc ? { dc } : {}),
    ...(org ? { org } : {}),
    ...(project ? { project } : {}),
  };
}

function collectDoctorSection(
  workspace: string,
  rootReal: string,
  secrets: readonly string[],
  now?: Date,
): { doctor: SupportBundleDoctor; hasDoctorFile: boolean } {
  const docPath = doctorJsonPath(workspace);
  const rawDoc = readContainedJson(docPath, rootReal);
  const cfgScope = readWorkspaceDeployScope(workspace, rootReal);
  const docScope: GateScope = isRecord(rawDoc?.scope)
    ? {
        ...(typeof rawDoc.scope.dc === 'string' ? { dc: rawDoc.scope.dc } : {}),
        ...(typeof rawDoc.scope.org === 'string' ? { org: rawDoc.scope.org } : {}),
        ...(typeof rawDoc.scope.project === 'string' ? { project: rawDoc.scope.project } : {}),
      }
    : {};
  const scope: GateScope = {
    dc: cfgScope.dc ?? docScope.dc,
    org: cfgScope.org ?? docScope.org,
    project: cfgScope.project ?? docScope.project,
  };
  const hasFullScope = Boolean(scope.dc && scope.org && scope.project);
  const verdict = evaluateGate({
    workspace,
    scope,
    allowPartialScope: !hasFullScope,
    ...(now ? { now } : {}),
  });
  const refusal = verdict.ok ? undefined : redactBundleText(gateRefusalMessage(verdict, scope), secrets);
  const report = rawDoc ? projectDoctorReport(rawDoc, secrets) : undefined;
  return {
    hasDoctorFile: rawDoc !== undefined,
    doctor: {
      ok: verdict.ok,
      status: verdict.status,
      ...(refusal ? { refusal } : {}),
      ...(report ? { report } : {}),
    },
  };
}

function escapeRegExpChar(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A planted secret literal echoed into stderr can be split across two lines by
 * the failing command's own wrapping. Redact occurrences that allow one line
 * break between any two characters before the per-line pass runs.
 */
function redactSplitLiterals(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const literal of secrets) {
    if (!literal || literal.length < 8 || out.includes(literal)) continue;
    const pattern = new RegExp([...literal].map(escapeRegExpChar).join('\\r?\\n?'), 'g');
    out = out.replace(pattern, '<redacted>');
  }
  return out;
}

function redactStderrTranscript(raw: string, secrets: readonly string[]): string[] {
  const sliced = raw.length > MAX_STDERR_BYTES ? raw.slice(0, MAX_STDERR_BYTES) : raw;
  const bounded = redactSplitLiterals(sliced, secrets);
  const lines = bounded.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(0, MAX_STDERR_LINES).map((line) => redactBundleText(line, secrets));
}

function collectAppReportsForDir(
  appDir: string,
  rootReal: string,
  secrets: readonly string[],
): Record<string, unknown> {
  const collected: Record<string, unknown> = {};
  for (const spec of ALLOWED_APP_REPORTS) {
    const full = join(appDir, spec.relPath);
    const raw = readContainedJson(full, rootReal);
    if (!raw) continue;
    collected[spec.relPath] = spec.project(raw, secrets);
  }
  return collected;
}

export function buildSupportBundle(opts: {
  workspace: string;
  app?: string;
  stderrText?: string;
  stderrTruncated?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): SupportBundle {
  const env = opts.env ?? process.env;
  const rootReal = safeRealpath(opts.workspace) ?? resolve(opts.workspace);
  const secrets = collectSecretLiterals(opts.workspace, env);
  const manifest: string[] = ['versions'];

  const { doctor, hasDoctorFile } = collectDoctorSection(opts.workspace, rootReal, secrets, opts.now);
  manifest.push(hasDoctorFile ? 'c2c-out/.c2c/doctor.json' : 'doctor');

  const apps: Record<string, Record<string, unknown>> = {};
  const outRoot = join(opts.workspace, 'c2c-out');
  const outSt = lstatSync(outRoot, { throwIfNoEntry: false });
  if (outSt && !outSt.isSymbolicLink() && outSt.isDirectory()) {
    const candidateNames: string[] = [];
    if (opts.app) {
      candidateNames.push(opts.app.trim());
    } else {
      for (const entry of readdirSync(outRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        candidateNames.push(entry.name);
      }
      candidateNames.sort();
    }
    for (const appName of candidateNames) {
      if (!isSafeAppName(appName)) continue;
      const appDir = join(outRoot, appName);
      const st = lstatSync(appDir, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
      const reports = collectAppReportsForDir(appDir, rootReal, secrets);
      const reportKeys = Object.keys(reports);
      if (!reportKeys.length) continue;
      const safeApp = redactBundleText(appName, secrets);
      apps[safeApp] = reports;
      for (const rel of reportKeys) {
        manifest.push(`c2c-out/${safeApp}/${rel}`);
      }
    }
    // Also support reports written directly into c2c-out/ when no app subdirectory matched.
    if (!opts.app && Object.keys(apps).length === 0) {
      const rootReports = collectAppReportsForDir(outRoot, rootReal, secrets);
      const reportKeys = Object.keys(rootReports);
      if (reportKeys.length) {
        apps['.'] = rootReports;
        for (const rel of reportKeys) {
          manifest.push(`c2c-out/${rel}`);
        }
      }
    }
  }

  let stderrSection: { lines: string[]; truncated?: boolean } | undefined;
  if (opts.stderrText !== undefined) {
    stderrSection = {
      lines: redactStderrTranscript(opts.stderrText, secrets),
      ...(opts.stderrTruncated ? { truncated: true } : {}),
    };
    manifest.push('stderr');
  } else {
    const fallbackLog = join(outRoot, '.c2c', 'last-stderr.log');
    if (isContainedRegularFile(fallbackLog, rootReal, MAX_STDERR_BYTES)) {
      const raw = readFileSync(fallbackLog, 'utf8');
      stderrSection = { lines: redactStderrTranscript(raw, secrets) };
      manifest.push('c2c-out/.c2c/last-stderr.log');
    }
  }

  return {
    schema: SUPPORT_BUNDLE_SCHEMA,
    manifest,
    versions: {
      c2c: c2cVersion(),
      plugin: readPluginVersion(),
      node: process.versions.node,
    },
    doctor,
    apps,
    ...(stderrSection ? { stderr: stderrSection } : {}),
  };
}

function defaultSupportBundleIo(): SupportBundleIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
  };
}

/**
 * Offline `--out` path checks: the parent directory must already exist (no
 * directory creation — the only write is `<file>` itself) and no component of
 * the resolved parent path may be a symlink. The realpath comparison allows
 * the macOS `/private` prefix alias so `/var`, `/tmp`, and `/etc` spellings do
 * not count as symlinked.
 */
function outputPathProblem(out: string): string | undefined {
  const outAbs = resolve(out);
  const parent = dirname(outAbs);
  const st = lstatSync(parent, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) {
    return `c2c support-bundle: refusing to write through symlinked directory: ${parent}`;
  }
  if (!st || !st.isDirectory()) {
    return `c2c support-bundle: --out parent directory does not exist: ${parent}`;
  }
  const real = safeRealpath(parent);
  if (!real) {
    return `c2c support-bundle: --out parent directory does not exist: ${parent}`;
  }
  if (real !== parent && real !== `/private${parent}`) {
    return `c2c support-bundle: refusing to write through symlinked directory: ${parent}`;
  }
  if (lstatSync(outAbs, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return `c2c support-bundle: refusing to write through symlink: ${out}`;
  }
  return undefined;
}

export function supportBundleCli(args: readonly string[], io: SupportBundleIo = defaultSupportBundleIo()): number {
  const problem = supportBundleArgsProblem(args);
  if (problem) {
    io.stderr(`${problem}\n`);
    return 2;
  }
  const out = flag(args, '--out') as string;
  const force = args.includes('--force');
  const app = flag(args, '--app');
  const stderrFile = flag(args, '--stderr-file');

  let stderrText: string | undefined;
  let stderrTruncated = false;
  if (stderrFile !== undefined) {
    let fd: number;
    try {
      fd = openSync(stderrFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      io.stderr(code === 'ENOENT'
        ? `c2c support-bundle: no such stderr file: ${stderrFile}\n`
        : `c2c support-bundle: --stderr-file must be a regular file: ${stderrFile}\n`);
      return 2;
    }
    try {
      if (!fstatSync(fd).isFile()) {
        io.stderr(`c2c support-bundle: --stderr-file must be a regular file: ${stderrFile}\n`);
        return 2;
      }
      // Read at most MAX_STDERR_BYTES + 1 bytes so an arbitrarily large stderr
      // file is never held in memory; the extra byte marks truncation.
      const buf = Buffer.alloc(MAX_STDERR_BYTES + 1);
      const bytesRead = readSync(fd, buf, 0, MAX_STDERR_BYTES + 1, 0);
      stderrTruncated = bytesRead > MAX_STDERR_BYTES;
      stderrText = buf.toString('utf8', 0, Math.min(bytesRead, MAX_STDERR_BYTES));
    } catch (err) {
      io.stderr(`c2c support-bundle: cannot read ${stderrFile}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    } finally {
      closeSync(fd);
    }
  }

  const env = io.env ?? process.env;
  const workspace = io.cwd ?? workspaceDir(env);
  try {
    const bundle = buildSupportBundle({
      workspace,
      ...(app !== undefined ? { app } : {}),
      ...(stderrText !== undefined ? { stderrText } : {}),
      ...(stderrTruncated ? { stderrTruncated } : {}),
      env,
      ...(io.now ? { now: io.now } : {}),
    });
    const outProblem = outputPathProblem(out);
    if (outProblem) {
      io.stderr(`${outProblem}\n`);
      return 2;
    }
    try {
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW |
        (force ? fsConstants.O_TRUNC : fsConstants.O_EXCL);
      const fd = openSync(out, flags);
      try {
        writeFileSync(fd, `${JSON.stringify(bundle, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') {
        io.stderr(`c2c support-bundle: refusing to write through symlink: ${out}\n`);
        return 2;
      }
      if (code === 'EEXIST') {
        io.stderr(`c2c support-bundle: refusing to overwrite existing file: ${out} (pass --force to overwrite)\n`);
        return 2;
      }
      throw err;
    }
    const lines = [`wrote ${out}`, 'manifest:', ...bundle.manifest.map((entry) => `- ${entry}`)];
    io.stdout(`${lines.join('\n')}\n`);
    return 0;
  } catch (err) {
    io.stderr(`c2c support-bundle: ${err instanceof Error ? err.message : 'failed to build support bundle'}\n`);
    return 1;
  }
}
