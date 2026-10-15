/**
 * The `c2c doctor` CLI half: D-A1..A4, D-C1..C5, D-D1..D3, D-E1..E4, D-F1..F6,
 * plus the D-B and D-V entries the recorded MCP evidence feeds. Every check
 * is read-only: no writes outside the workspace, no logins, no token reads,
 * no URL paths printed. A CLI read that meets 401 INVALID_TOKEN (the access
 * token lapsed as it ran) re-runs once when the CLI credential store holds a
 * newer token; the store is compared by a one-way tag and is never refreshed
 * (unless C2C_ALLOW_LOCAL_REFRESH=1). Each FAIL carries the exact fix the user runs.
 *
 * Deferred spec items (reported as NOTE/deferred in the doctor output):
 *   D-B6 drift   schema digests are recorded but there is no tested digest
 *                baseline to compare against yet
 *   D-F5 JOIN/SELECT  plan.json does not model JOINs or SELECT width; the
 *                documented SELECT cap (20) is not yet confirmed
 *   D-F6 rows    plan.json holds no planned row counts and the Dev row cap is
 *                [UNVERIFIED]
 */
import { constants, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseBytes, parseFile, type App } from '../../core/src/index.js';
import { nodeSatisfies, REACT_BUILD_NODE_RANGE } from '../../core/src/toolchain.js';
import { generateSchema, limitValue, type SchemaTable } from '../../schema/src/index.js';
import compat from '../data/compat.json' with { type: 'json' };
import { MCP_TOOLS_GUIDANCE, REQUIRED_MCP_TOOLS } from './required-tools.js';
import { dcOfCreatorHost, dcOfMcpHost, normalizeDc, type ResolvedScopeValues } from './scope.js';
import { missingRequiredTools, shortToolName, type McpEvidence } from './evidence.js';
import { verifyVendorDir, MANIFEST_NAME } from './vendor.js';
import { entryKind, isAbsentError, isSymlinkRefusedError } from '../../core/src/fs-kind.js';
import { readRegularFile, type FileRead } from './read-file.js';
import type { CheckResult, DoctorIo, SpawnResult } from './types.js';
import { invalidTokenOutput, readWithNewerToken } from '../../deploy/src/retry.js';
import { FIDELITY_JSON, LOADER_REPORT, hasReportJson } from '../../deploy/src/csv.js';
import { localRefreshAllowed } from '../../deploy/src/rest.js';
import { importingAgeMs, importingAgeState, isStuckImporting, stuckImportGuidedStep, STUCK_IMPORT_MAX_AGE_HOURS, unknownImportAgeGuidedStep, type ListedProject } from '../../deploy/src/stuck-import.js';
import { fallbackForTool } from '../../deploy/src/mcp-registry.js';
import { readDeployConfig } from '../../deploy/src/dc.js';
import { mailSenderTag, readMailSenderEvidence, type MailSenderEvidence } from '../../deploy/src/mail.js';
import { generate as generateDeluge } from '../../deluge/src/generate.js';

export interface DoctorContext {
  io: DoctorIo;
  /** Workspace (c2c-out lives here). */
  workspace: string;
  scope: ResolvedScopeValues;
  /** --app .ds path. */
  appPath?: string;
  /** --source-csv dir. */
  sourceCsv?: string;
  /** Only local checks (SessionStart hook): no account or network checks. */
  local: boolean;
  /** Evidence merged this run (observed MCP calls, or an user-supplied file). */
  evidence?: McpEvidence;
  /** Evidence origin matters: local transports are trusted only from the nonce-bound observed flow. */
  evidenceSource?: 'observed' | 'operator';
  /** The D-A3/D-B/D-V rows of the last recorded MCP observation for this scope, when no evidence is merged this run. */
  carried?: { checks: CheckResult[]; at: string };
  /** CLI login-store readers; injectable for tests. */
  cliDc?: () => string | undefined;
  cliOrg?: () => string | undefined;
  /** Node version under test; defaults to process.versions.node. */
  nodeVersion?: string;
}

const pass = (id: string, detail: string, extra: Partial<CheckResult> = {}): CheckResult => ({ id, status: 'pass', detail, fix: null, ...extra });
const warn = (id: string, detail: string, fix: string | null = null): CheckResult => ({ id, status: 'warn', detail, fix });
const fail = (id: string, detail: string, fix: string | null): CheckResult => ({ id, status: 'fail', detail, fix });
const skip = (id: string, detail: string): CheckResult => ({ id, status: 'skip', detail, fix: null });

/** The fix for a recorded evidence field that is present but not the shape a check can read. */
const RE_RECORD = 'run /c2c:doctor again so the evidence is collected fresh';

/** A recorded list field: the strings, 'malformed' when present but not a list of strings, undefined when absent. */
function recordedList(value: unknown): readonly string[] | 'malformed' | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : 'malformed';
}

async function runCmd(ctx: DoctorContext, command: string, args: string[]): Promise<SpawnResult> {
  try {
    const res = await ctx.io.spawn(command, args, { cwd: ctx.workspace, env: ctx.io.env });
    // A driver that resolves without a result (or without output fields) is a
    // failed command for every downstream parser, never a TypeError.
    return {
      code: res && typeof res.code === 'number' ? res.code : 1,
      stdout: res && typeof res.stdout === 'string' ? res.stdout : '',
      stderr: res && typeof res.stderr === 'string' ? res.stderr : '',
    };
  } catch (err) {
    return { code: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A read-only `catalyst` command. On 401 INVALID_TOKEN it re-runs once, and
 * only when the CLI credential store now holds a different token than before
 * the read (compared by tag, re-read without a refresh). With
 * C2C_ALLOW_LOCAL_REFRESH=1 the re-run follows one forced CLI refresh instead.
 */
async function runCliRead(ctx: DoctorContext, args: string[]): Promise<SpawnResult> {
  const { tokenTag, refreshToken } = ctx.io;
  const local = localRefreshAllowed(ctx.io.env) && !!refreshToken;
  const peek = async () => (tokenTag ? await tokenTag().catch(() => undefined) : undefined);
  let before: string | undefined;
  let attempts = 0;
  return readWithNewerToken({
    readOnly: local || !!tokenTag,
    attempt: async () => {
      if (!local && attempts++ === 0) before = await peek();
      return runCmd(ctx, 'catalyst', args);
    },
    expired: (res) => res.code !== 0 && invalidTokenOutput(`${res.stdout}\n${res.stderr}`),
    renew: async () => {
      if (local) {
        await refreshToken!(ctx.scope.org);
        return true;
      }
      const after = await peek();
      return after !== undefined && after !== before;
    },
    describe: `catalyst ${args.join(' ')}`,
    log: (line) => ctx.io.stderr(`${line}\n`),
  });
}

function homeDir(ctx: DoctorContext): string {
  return ctx.io.env.HOME || homedir();
}

// ---------- D-A1 / D-A4: official Catalyst skills on disk ----------

interface SkillHit {
  path: string;
  kind: 'skills-dir' | 'claude-skills' | 'plugin-cache' | 'marketplace' | 'codex';
  name?: string;
  version?: string;
}

function frontmatter(text: string): { name?: string; version?: string } {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  const body = end < 0 ? text.slice(3) : text.slice(3, end);
  let name: string | undefined;
  let version: string | undefined;
  let inMeta = false;
  for (const line of body.split('\n')) {
    const topName = /^name:\s*"?([^"\n]+?)"?\s*$/.exec(line);
    if (topName) name = topName[1].trim();
    if (/^metadata:\s*$/.test(line)) {
      inMeta = true;
      continue;
    }
    if (inMeta && /^\s+version:\s*"?([^"\n]+?)"?\s*$/.test(line)) {
      version = /^\s+version:\s*"?([^"\n]+?)"?\s*$/.exec(line)?.[1]?.trim();
    }
    if (/^\S/.test(line) && !/^metadata:/.test(line)) inMeta = false;
  }
  return { ...(name ? { name } : {}), ...(version ? { version } : {}) };
}

function isSafeSkillPath(filePath: string, rootDir: string, home: string): boolean {
  const absRoot = resolve(rootDir);
  const absFile = resolve(filePath);
  const absHome = resolve(home);
  const relToRoot = relative(absRoot, absFile);
  if (!relToRoot || relToRoot.startsWith('..') || isAbsolute(relToRoot)) return false;
  const anchor = absRoot === absHome || absRoot.startsWith(absHome + sep) ? absHome : absRoot;
  const relToAnchor = relative(anchor, absFile);
  if (!relToAnchor || relToAnchor.startsWith('..') || isAbsolute(relToAnchor)) return false;
  let cur = anchor;
  const parts = [anchor, ...relToAnchor.split(sep).map((part) => (cur = join(cur, part)))];
  for (const part of parts) {
    const lst = lstatSync(part, { throwIfNoEntry: false });
    if (!lst || lst.isSymbolicLink()) return false;
    if (part !== absHome && (lst.mode & 0o022) !== 0) return false;
  }
  const fileStat = lstatSync(absFile, { throwIfNoEntry: false });
  if (!fileStat?.isFile()) return false;
  let realRoot: string;
  let realAnchor: string;
  let realFile: string;
  try {
    realRoot = realpathSync(absRoot);
    realAnchor = realpathSync(anchor);
    realFile = realpathSync(absFile);
  } catch {
    return false;
  }
  return realFile.startsWith(realRoot + sep) && realFile.startsWith(realAnchor + sep);
}

function readSkill(path: string, kind: SkillHit['kind'], rootDir: string, home: string): SkillHit | undefined {
  if (!isSafeSkillPath(path, rootDir, home)) return undefined;
  // O_NOFOLLOW keeps the "not a symlink" check on the descriptor that is read.
  const read = readRegularFile(path, constants.O_NOFOLLOW);
  if (read.kind !== 'file') return undefined;
  const fm = frontmatter(read.bytes.toString('utf8'));
  return { path, kind, ...fm };
}

/**
 * The sorted names of the real subdirectories of `dir`, from one listing: each
 * entry is classified by its Dirent (entryKind), so a symlink, file, FIFO or
 * socket is skipped and never followed. An absent `dir` lists nothing; any
 * other listing error is thrown.
 */
function subdirs(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isAbsentError(err)) return [];
    throw err;
  }
  return entries
    .filter((entry) => entryKind(entry) === 'directory')
    .map((entry) => entry.name)
    .sort();
}

/** Search order from the doctor spec, D-A1 (plugin/references/doctor-spec.md). An unreadable directory is a finding, not a crash. */
function findCatalystSkill(ctx: DoctorContext): { hit: SkillHit | undefined; error?: string; searched: string[] } {
  const home = homeDir(ctx);
  const skillsDir = ctx.io.env.C2C_CATALYST_SKILLS_DIR;
  const searched: string[] = [];
  try {
    if (skillsDir) {
      const candidate = join(skillsDir, 'catalyst-by-zoho', 'SKILL.md');
      searched.push(candidate);
      const hit = readSkill(candidate, 'skills-dir', skillsDir, home);
      if (hit) return { hit, searched };
    } else {
      searched.push('$C2C_CATALYST_SKILLS_DIR (unset)');
    }
    const pluginsRoot = join(home, '.claude', 'plugins');
    const cacheRoot = join(pluginsRoot, 'cache');
    if (subdirs(pluginsRoot).includes('cache')) {
      for (const marketplace of subdirs(cacheRoot)) {
        if (!subdirs(join(cacheRoot, marketplace)).includes('catalyst-by-zoho')) continue;
        const pluginDir = join(cacheRoot, marketplace, 'catalyst-by-zoho');
        for (const version of subdirs(pluginDir)) {
          const candidate = join(pluginDir, version, 'skills', 'catalyst-by-zoho', 'SKILL.md');
          searched.push(candidate);
          const hit = readSkill(candidate, 'plugin-cache', cacheRoot, home);
          if (hit) return { hit, searched };
        }
      }
    } else {
      searched.push(join(cacheRoot, '*', 'catalyst-by-zoho', '*', 'skills', 'catalyst-by-zoho', 'SKILL.md'));
    }
    const marketRoot = join(home, '.claude', 'plugins', 'marketplaces');
    const marketPath = join(marketRoot, 'catalyst-by-zoho', 'skills', 'catalyst-by-zoho', 'SKILL.md');
    searched.push(marketPath);
    const market = readSkill(marketPath, 'marketplace', marketRoot, home);
    if (market) return { hit: market, searched };
    const claudeSkillsRoot = join(home, '.claude', 'skills');
    const claudeRouter = join(claudeSkillsRoot, 'catalyst-by-zoho', 'SKILL.md');
    searched.push(claudeRouter);
    const claudeDirect = readSkill(claudeRouter, 'claude-skills', claudeSkillsRoot, home);
    if (claudeDirect) return { hit: claudeDirect, searched };
    if (subdirs(join(home, '.claude')).includes('skills')) {
      for (const entry of subdirs(claudeSkillsRoot)) {
        if (!entry.startsWith('catalyst-') || entry === 'catalyst-by-zoho') continue;
        const candidate = join(claudeSkillsRoot, entry, 'skills', 'catalyst-by-zoho', 'SKILL.md');
        searched.push(candidate);
        const hit = readSkill(candidate, 'claude-skills', claudeSkillsRoot, home);
        if (hit) return { hit, searched };
      }
    }
    const codexHome = ctx.io.env.CODEX_HOME || join(home, '.codex');
    const codexSkillsRoot = join(codexHome, 'skills');
    const codexPath = join(codexSkillsRoot, 'catalyst-by-zoho', 'SKILL.md');
    searched.push(codexPath);
    return { hit: readSkill(codexPath, 'codex', codexSkillsRoot, home), searched };
  } catch (err) {
    return { hit: undefined, error: err instanceof Error ? err.message : String(err), searched };
  }
}

const D_A1_FIX =
  'the official Catalyst skills are not installed. Claude Code: /plugin marketplace add catalystbyzoho/claude-plugin then /plugin install catalyst-by-zoho@catalyst-by-zoho. Codex: copy the Catalyst agent skills into ~/.codex/skills/ (exact repo path [UNVERIFIED]). Cursor: clone the skills repo and set C2C_CATALYST_SKILLS_DIR=<path>/skills';

/** The skills the agent half must see in-session (D-A3, per plugin/references/doctor-spec.md). */
const REQUIRED_SKILLS = [
  'catalyst-by-zoho',
  'catalyst-zoho-mcp',
  'catalyst-basics',
  'catalyst-datastore',
  'catalyst-functions',
  'catalyst-slate',
  'catalyst-authentication',
  'catalyst-stratus',
];

/** Spec items this build reports but does not check yet (printed as deferred). */
export const DEFERRED_CHECKS: readonly { id: string; reason: string }[] = [
  { id: 'D-B6 drift', reason: 'schema digests are recorded but no tested baseline exists to compare them with yet' },
  { id: 'D-F5 JOIN/SELECT', reason: 'plan.json does not model JOINs or SELECT width; the documented SELECT cap (20) is not yet confirmed' },
  { id: 'D-F6 rows', reason: 'plan.json holds no planned row counts and the Dev row cap is not yet confirmed' },
];

function semverGte(a: string, b: string): boolean {
  const parts = (v: string) => v.split('.').map((x) => Number(x) || 0);
  const [a1, a2, a3] = parts(a);
  const [b1, b2, b3] = parts(b);
  return a1 !== b1 ? a1 > b1 : a2 !== b2 ? a2 > b2 : a3 >= b3;
}

function checkA(ctx: DoctorContext): CheckResult[] {
  const found = findCatalystSkill(ctx);
  const hit = found.hit;
  if (!hit) {
    const note = found.error ? `; the plugin skills directories could not be read (${found.error}); set C2C_CATALYST_SKILLS_DIR to the installed Catalyst skills directory` : '';
    const paths = found.searched.length > 0 ? ` (searched: ${found.searched.join('; ')})` : '';
    return [fail('D-A1', `the official Catalyst skills are not installed${note}${paths}`, D_A1_FIX)];
  }
  const out = [pass('D-A1', `catalyst skills found: ${hit.kind} v${hit.version ?? 'unknown'}`)];
  const floor = compat.catalystPlugin.min;
  if (hit.version && !semverGte(hit.version, floor)) {
    out.push(warn('D-A4', `catalyst-by-zoho ${hit.version} is older than ${floor}`, `/plugin update catalyst-by-zoho@<marketplace>`));
  }
  return out;
}

/**
 * D-A2: the plugin is enabled in the host, read via `claude plugin list --json`.
 * On hosts without the claude CLI (Cursor, a bare shell) this skips —
 * D-A1 already proved the files are on disk.
 */
async function checkA2(ctx: DoctorContext): Promise<CheckResult> {
  const res = await runCmd(ctx, 'claude', ['plugin', 'list', '--json']);
  if (res.code !== 0) return skip('D-A2', 'claude plugin list unavailable; plugin enablement not checked');
  let entries: Record<string, unknown>[];
  try {
    const parsed = JSON.parse(res.stdout) as unknown;
    const list: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? Array.isArray((parsed as Record<string, unknown>).plugins)
          ? ((parsed as Record<string, unknown>).plugins as unknown[])
          : Object.entries(parsed as Record<string, unknown>).map(([name, v]) => (v && typeof v === 'object' ? { name, ...(v as object) } : v))
        : [];
    entries = list.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object');
  } catch {
    return warn('D-A2', 'claude plugin list output was not JSON; enablement not checked');
  }
  const hits = entries.filter((e) => {
    const name = typeof e.name === 'string' ? e.name : typeof e.id === 'string' ? e.id : '';
    return name === 'catalyst-by-zoho' || name.startsWith('catalyst-by-zoho@');
  });
  if (hits.length === 0) return skip('D-A2', 'catalyst-by-zoho is not in claude plugin list');
  const enabled = hits.filter((e) => e.enabled === true);
  if (enabled.length === 0) {
    return fail('D-A2', 'catalyst-by-zoho is installed but disabled', '/plugin enable catalyst-by-zoho@<marketplace>, then restart the session');
  }
  const version = typeof enabled[0].version === 'string' ? ` ${enabled[0].version}` : '';
  if (hits.length > 1) {
    return warn('D-A2', `catalyst-by-zoho${version} enabled, but ${hits.length} copies are installed; disable one (/plugin disable catalyst-by-zoho@<marketplace>)`);
  }
  return pass('D-A2', `catalyst-by-zoho${version} enabled`);
}

/** D-A3: the skills the agent half recorded as visible this session. */
function checkA3(ctx: DoctorContext): CheckResult {
  const visible = recordedList(ctx.evidence?.catalyst_skills_visible);
  if (visible === 'malformed') return fail('D-A3', 'the recorded skills list is not a list of names; re-record the evidence', RE_RECORD);
  if (!visible) return skip('D-A3', 'skill visibility not recorded');
  const missing = REQUIRED_SKILLS.filter((name) => !visible.includes(name));
  if (missing.length) {
    return fail(
      'D-A3',
      `the Catalyst skills are installed but not loaded this session (${missing.join(', ')})`,
      'restart the host session; on Codex check ~/.codex/skills/<name>/SKILL.md exists',
    );
  }
  return pass('D-A3', `${REQUIRED_SKILLS.length}/${REQUIRED_SKILLS.length} Catalyst skills visible`);
}

// ---------- D-C*: the Catalyst CLI ----------

function checkC1C2(version: string | undefined, cliMissing: boolean): CheckResult[] {
  if (cliMissing || !version) {
    return [fail('D-C1', 'the Catalyst CLI is not installed', 'npm install -g zcatalyst-cli (with Node 20 or 22), then run catalyst --version')];
  }
  const out = [pass('D-C1', `zcatalyst-cli ${version}`)];
  const { min, tested } = compat.catalystCli;
  if (!semverGte(version, min)) {
    out.push(fail('D-C2', `zcatalyst-cli ${version} is below ${min}`, 'npm install -g zcatalyst-cli@latest'));
  } else if (!(tested as readonly string[]).includes(version)) {
    out.push(warn('D-C2', `zcatalyst-cli ${version} is above the tested versions (${tested.join(', ')})`));
  } else {
    out.push(pass('D-C2', `${version} (tested)`));
  }
  return out;
}

const LOGIN_FIX = (dc: string | undefined) => `catalyst login --dc ${dc ?? '<dc>'} (browser sign-in; c2c never does it)`;

/**
 * The CLI account as shown on screen: first letter and domain only
 * (`u***@example.com`). Doctor output gets pasted into chats, CI logs and
 * evidence, so the full address never prints.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return 'signed in';
  return `${email[0]}***${email.slice(at)}`;
}

function checkC3(stdout: string, stderr: string, code: number, dc: string | undefined): CheckResult {
  const who = /Logged as:\s*(\S+)/.exec(`${stdout}\n${stderr}`);
  if (code === 0 && who) {
    return { ...pass('D-C3', 'CLI signed in'), screen: `CLI signed in (${maskEmail(who[1]!)})` };
  }
  return fail('D-C3', 'the Catalyst CLI is not signed in', LOGIN_FIX(dc));
}

/** Decimal string the Catalyst CLI prints for a project id (lossy past MAX_SAFE_INTEGER). */
function cliRenderedId(id: string): string {
  if (!/^[0-9]+$/.test(id)) return id;
  const n = Number(id);
  return Number.isSafeInteger(n) ? id : String(n);
}

/** The leading id of an evidence list entry — `"<id>"` or `"<id> <name>"`; name and everything else is never compared. */
function entryId(item: string): string {
  return typeof item === 'string' ? item.trim().split(/\s+/)[0] ?? '' : '';
}

/** Project ids from a cli-table3 `project:list` table (Project ID column). Missing output is an empty list, not a throw. */
export function projectListIds(output: string | undefined | null): string[] {
  if (typeof output !== 'string') return [];
  const stripped = output.replace(/\[[0-9;]*m/g, '');
  let idIndex = -1;
  const ids: string[] = [];
  const cells = (line: string): string[] => {
    const parts = line.split('│');
    if (parts.length && parts[0].trim() === '') parts.shift();
    if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
    return parts.map((cell) => cell.trim());
  };
  for (const line of stripped.split(/\r?\n/)) {
    if (!line.includes('│')) continue;
    const row = cells(line);
    if (idIndex < 0) {
      const at = row.indexOf('Project ID');
      if (at >= 0) idIndex = at;
      continue;
    }
    const id = row[idIndex] ?? '';
    if (/^[0-9]+$/.test(id)) ids.push(id);
  }
  return ids;
}

const D_C4_FIX = (dc: string | undefined) =>
  `the CLI is on another DC or account: catalyst logout, then catalyst login --dc ${dc ?? '<dc>'} with the account that owns the org`;

function checkC5(ctx: DoctorContext): CheckResult {
  const { dc, dcSource } = ctx.scope;
  if (!dc) {
    return fail('D-C5', 'no data centre set', 'add "dc": "<us|eu|in|au|ca|sa|jp|uae>" to c2c-deploy.json or pass --dc');
  }
  const origin = dcSource === '--dc' ? '--dc' : dcSource?.includes('c2c-deploy.json') ? 'c2c-deploy.json' : (dcSource ?? 'unknown');
  return pass('D-C5', `DC ${dc} (from ${origin})`);
}

// ---------- D-D*: the Creator export and data source ----------

function checkD1(ctx: DoctorContext): { result: CheckResult; ir?: App } {
  const target = ctx.appPath;
  if (!target) return { result: skip('D-D1', 'no --app given; the Creator export was not checked') };
  const fix =
    'in Creator: app → Settings → Export (.ds); if the export is blank, run /c2c:analyze on any earlier export to find the broken component, fix it in Creator, export again';
  // One open classifies and reads the export; the parse uses those bytes.
  const read = readRegularFile(target);
  if (read.kind !== 'file' || read.bytes.length === 0 || read.bytes.every((b) => b <= 0x20)) {
    return { result: fail('D-D1', `${basename(target)} is empty or not a .ds export`, fix) };
  }
  const bytes = read.bytes;
  let ir: App;
  let errors: number;
  try {
    const file = parseBytes(target, bytes);
    ir = file.ir;
    errors = file.cst.errors.length;
  } catch (err) {
    return { result: fail('D-D1', `cannot parse ${basename(target)} (${err instanceof Error ? err.message : 'parse error'})`, fix) };
  }
  if (!ir.name || ir.dialect === 'snippet' || errors > 0) {
    return { result: fail('D-D1', `${basename(target)} is empty or not a .ds export`, fix) };
  }
  return { result: pass('D-D1', `export: ${basename(target)} ${Math.round(bytes.length / 1024)} KB, shape ${ir.shape}, parses`), ir };
}

/**
 * Sender state check. `mail.verified` in c2c-deploy.json is only the operator's
 * attestation — D-M1 reports `verified` solely from the live Catalyst
 * read-back a confirmed deploy persisted (c2c-out/.c2c/mail-sender.json,
 * sender tags only). An attestation without that record is reported as
 * attested, not verified. When the target project is known, a record observed
 * against another project (or naming none) is ignored.
 */
export function checkMailSender(app: App, workspace: string, projectId?: string): CheckResult[] {
  const sendsMail = generateDeluge(app).files.some((file) => file.source.includes('shim.mail.send('));
  if (!sendsMail) return [];
  const path = join(workspace, 'c2c-deploy.json');
  let sender: { from?: string; verified?: boolean } | undefined;
  try {
    sender = readDeployConfig(path).mail;
  } catch (err) {
    return [fail('D-M1', 'mail sender configuration could not be read', `fix ${path}: ${err instanceof Error ? err.message : 'invalid configuration'}`)];
  }
  if (!sender?.from) {
    return [fail('D-M1', 'the app sends mail and no Catalyst Mail sender is set', 'set mail.from in c2c-deploy.json, verify it in Catalyst Mail, then run c2c deploy app.ds --confirm --function-env function-env.json so the live read-back is recorded')];
  }
  let evidence: MailSenderEvidence | undefined = readMailSenderEvidence(workspace);
  if (evidence && projectId !== undefined && cliRenderedId(evidence.projectId ?? '') !== cliRenderedId(projectId)) evidence = undefined;
  const observed = evidence?.senders[mailSenderTag(sender.from)];
  if (observed?.toUpperCase() === 'VERIFIED') {
    return [
      {
        ...pass('D-M1', 'the app sends mail and its sender is verified by the live Catalyst read-back'),
        screen: `mail sender ${maskEmail(sender.from)} is verified (live read-back${evidence?.projectId ? ` for project ${evidence.projectId}` : ''} at ${evidence?.at})`,
      },
    ];
  }
  if (observed !== undefined) {
    return [
      {
        ...fail('D-M1', `the app sends mail and the live read-back lists its sender as ${observed}`, 'verify mail.from in Catalyst Mail (console → Mail → Email Configuration), then re-run c2c deploy app.ds --confirm --function-env function-env.json'),
        screen: `mail sender ${maskEmail(sender.from)} read back as ${observed}`,
      },
    ];
  }
  if (sender.verified === true) {
    return [
      {
        ...warn(
          'D-M1',
          'the app sends mail and its sender verification is attested in c2c-deploy.json but no live read-back confirmed it',
          'run c2c deploy app.ds --confirm --function-env function-env.json; it reads the sender state back from Catalyst and records it',
        ),
        screen: `mail sender ${maskEmail(sender.from)} is attested, not confirmed by a live read-back`,
      },
    ];
  }
  return [
    {
      ...fail('D-M1', 'the app sends mail and its sender is not marked verified', 'verify mail.from in Catalyst Mail, set mail.verified to true in c2c-deploy.json, then run c2c deploy app.ds --confirm --function-env function-env.json so the live read-back is recorded'),
      screen: `mail sender ${maskEmail(sender.from)} is not marked verified`,
    },
  ];
}

function checkD2(ctx: DoctorContext): CheckResult {
  const creator = ctx.scope.creatorDc ? dcOfCreatorHost(ctx.scope.creatorDc) : undefined;
  if (!creator || !ctx.scope.dc) return skip('D-D2', 'Creator host not stated; the Creator DC was not checked');
  if (creator === ctx.scope.dc) return pass('D-D2', `Creator DC ${creator}`);
  return warn('D-D2', `Creator is on ${creator}, Catalyst on ${ctx.scope.dc} (cross-DC moves data out of the region; confirm that is intended)`);
}

function planMigratesData(workspace: string, app: string | undefined): boolean {
  const planPath = join(workspace, 'c2c-out', app ?? '', 'provision', 'plan.json');
  try {
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Record<string, unknown>;
    if (plan.migrateData === true) return true;
    const data = plan.data;
    if (data === true) return true;
    if (data && typeof data === 'object' && !Array.isArray(data)) return true;
    const steps = plan.steps;
    if (Array.isArray(steps) && steps.some((step) => step && typeof step === 'object' && /migrate|data/i.test(JSON.stringify(step).slice(0, 500)))) return true;
  } catch {
    /* no plan yet */
  }
  return false;
}

function checkD3(ctx: DoctorContext): CheckResult {
  const dir = ctx.sourceCsv;
  if (!dir) {
    if (ctx.appPath && planMigratesData(ctx.workspace, ctx.scope.app)) {
      return fail(
        'D-D3',
        'no Creator data source',
        'export each report from Creator as JSON (preferred — it always carries record ids) or as CSV with the ID column, put them in exports/<app>-data/, and write counts.json with each report\u2019s record count; then pass --source-csv <dir>',
      );
    }
    return skip('D-D3', 'no data source given; the plan does not migrate data yet');
  }
  const fix =
    'export each report from Creator as JSON (preferred — it always carries record ids) or as CSV with the ID column, put them in exports/<app>-data/, and write counts.json with each report\u2019s record count';
  // The listing is the directory check: ENOENT/ENOTDIR (absent, a file, a FIFO) is "not a directory".
  let listing: string[];
  try {
    listing = readdirSync(dir);
  } catch (err) {
    if (isAbsentError(err)) {
      return fail('D-D3', `--source-csv ${dir} is not a directory`, fix);
    }
    throw err;
  }
  const names = listing.filter((name) => !name.startsWith('.'));
  const csvs = names.filter((name) => name.toLowerCase().endsWith('.csv'));
  // The loader reads a --source-csv dir holding JSON report exports as JSON
  // (hasReportJson, deploy/src/csv.ts); doctor accepts the same input. With no
  // parsed app the seed-manifest probe cannot run, so name 'seed.json' out too.
  let hasJson: boolean;
  if (ctx.appPath) {
    let app: App | undefined;
    try {
      app = parseFile(ctx.appPath).ir;
    } catch {
      /* D-D1 reports the parse failure */
    }
    hasJson = app !== undefined && hasReportJson(dir, app);
  } else {
    hasJson = names.some(
      (name) =>
        name.toLowerCase().endsWith('.json') &&
        name !== 'counts.json' &&
        name !== 'seed.json' &&
        name !== LOADER_REPORT &&
        name !== FIDELITY_JSON &&
        !name.endsWith('.edits.json'),
    );
  }
  if (!names.includes('counts.json')) return fail('D-D3', 'counts.json is missing', fix);
  try {
    const counts = JSON.parse(readFileSync(join(dir, 'counts.json'), 'utf8')) as unknown;
    const root = counts && typeof counts === 'object' && !Array.isArray(counts) ? (counts as Record<string, unknown>) : undefined;
    const map = root?.counts && typeof root.counts === 'object' && !Array.isArray(root.counts) ? (root.counts as Record<string, unknown>) : root;
    if (!map) throw new Error('bad');
    for (const [key, value] of Object.entries(map)) {
      if (key === 'version') continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error('bad');
    }
  } catch {
    return fail('D-D3', 'counts.json is not a JSON object of counts', fix);
  }
  if (!csvs.length && !hasJson) return fail('D-D3', 'no CSV or JSON exports found', fix);
  // The loader prefers JSON (it always carries record ids), so a dir holding
  // report JSON passes without probing CSV headers.
  if (hasJson) return pass('D-D3', `data: JSON report exports${csvs.length ? ` (+ ${csvs.length} CSVs the loader will skip)` : ''}, counts.json ok`);
  const withoutId = csvs.filter((name) => {
    const firstLine = readFileSync(join(dir, name), 'utf8').split('\n', 1)[0] ?? '';
    return !firstLine.split(',').some((cell) => cell.trim().replace(/^"|"$/g, '') === 'ID');
  });
  if (withoutId.length) {
    return warn(
      'D-D3',
      `${withoutId.join(', ')} has no record ID column; the loader derives source ids (lookups then match on display values, and editing a hashed column looks like delete+insert to delta sync) and reports them under 'derived ids' — prefer the JSON export, which always carries record ids`,
      'export each report from Creator with the ID column, or use the JSON report export, and re-run',
    );
  }
  return pass('D-D3', `data: ${csvs.length} CSVs, counts.json ok`);
}

// ---------- D-E*: Node and the plugin itself ----------

function checkE(ctx: DoctorContext): CheckResult[] {
  const out: CheckResult[] = [];
  const node = ctx.nodeVersion ?? process.versions.node;
  const { range, pinned } = compat.node;
  if (!nodeSatisfies(node, range)) {
    out.push(fail('D-E1', `Node ${node} is not supported; c2c needs Node ${range} (20 or 22)`, `install Node ${pinned} (nvm install ${pinned} && nvm use ${pinned})`));
  } else {
    out.push(pass('D-E1', `node v${node}${node === pinned ? ' (pinned)' : ''}`));
    if (node !== pinned) out.push(warn('D-E2', `Node ${node} is not the pinned ${pinned}; byte-identical manifests are only guaranteed on ${pinned}`));
  }
  const vendor = findVendorRoot();
  if (!vendor) {
    out.push(skip('D-E3', 'not running from a vendored plugin; nothing to verify'));
  } else {
    const verdict = verifyVendorDir(vendor.dir);
    if (verdict.ok) {
      out.push(pass('D-E3', `vendor ok (${vendor.name})`));
    } else if (verdict.error) {
      out.push(fail('D-E3', `the c2c plugin files are not intact (${verdict.error})`, 'reinstall the plugin (/plugin uninstall c2c, then install again)'));
    } else {
      const n = verdict.mismatched.length;
      out.push(fail('D-E3', `the c2c plugin files were modified (${n} file${n === 1 ? '' : 's'} differ)`, 'reinstall the plugin (/plugin uninstall c2c, then install again)'));
    }
  }
  const pluginRoot = vendor ? dirname(dirname(vendor.dir)) : undefined;
  const cwd = ctx.workspace;
  if (pluginRoot && (cwd === pluginRoot || cwd.startsWith(pluginRoot + sep))) {
    out.push(fail('D-E4', 'run c2c from your own workspace folder, not from the plugin folder', null));
  } else {
    try {
      const dir = join(cwd, 'c2c-out', '.c2c');
      mkdirSync(dir, { recursive: true });
      const probe = join(dir, `.write-probe-${process.pid}`);
      writeFileSync(probe, '');
      rmSync(probe);
      out.push(pass('D-E4', 'workspace ok'));
    } catch {
      out.push(fail('D-E4', `cannot write c2c-out/.c2c under ${cwd}; run c2c from a writable workspace`, null));
    }
  }
  return out;
}

/**
 * Whether `path` is present, by one read rather than an existsSync check: any
 * entry but an absent one (ENOENT/ENOTDIR) or a symlink loop counts, as with
 * existsSync. A regular file's text is kept.
 */
function presentEntry(path: string): { present: boolean; text?: string } {
  let read: FileRead;
  try {
    read = readRegularFile(path);
  } catch (err) {
    return { present: !isSymlinkRefusedError(err) };
  }
  if (read.kind === 'missing') return { present: false };
  return read.kind === 'file' ? { present: true, text: read.bytes.toString('utf8') } : { present: true };
}

/**
 * Walk up from this module for a vendor root (MANIFEST.sha256 + VERSION). The
 * name is read from that same VERSION read; an unreadable VERSION names 'c2c'.
 */
export function findVendorRoot(start = dirname(new URL(import.meta.url).pathname)): { dir: string; name: string } | undefined {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (presentEntry(join(dir, MANIFEST_NAME)).present) {
      const version = presentEntry(join(dir, 'VERSION'));
      if (version.present) return { dir, name: version.text === undefined ? 'c2c' : `c2c ${version.text.trim()}` };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// ---------- D-R*: the React build prerequisites ----------

/**
 * D-R1..D-R4: Node, npm, the npm registry and the npm cache on the machine
 * that builds the React app (`c2c deploy` runs `npm ci` and `npm run build`
 * in web/ unless `--ui vanilla` selects the fallback). They run whenever the
 * React target is selected (the default, `--ui react`, or c2c-deploy.json
 * `ui`); the vanilla target reports none of them. Probes run through
 * io.spawn so tests can stub them.
 */
async function checkReact(ctx: DoctorContext): Promise<CheckResult[]> {
  if (ctx.scope.ui !== 'react') return [];
  const out: CheckResult[] = [];
  const pinned = compat.reactBuild.pinned;
  const nodeFloor = REACT_BUILD_NODE_RANGE;
  const npmFloor = compat.reactBuild.npmMin;

  const nodeRes = await runCmd(ctx, 'node', ['--version']);
  const nodeVer = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(`${nodeRes.stdout}\n${nodeRes.stderr}`)?.[1];
  if (!nodeVer) {
    out.push(fail('D-R1', 'node is not installed or not on PATH', `install Node ${pinned} (nvm install ${pinned} && nvm use ${pinned}); the React deploy builds on this machine`));
  } else if (!nodeSatisfies(nodeVer, nodeFloor)) {
    out.push(fail('D-R1', `node ${nodeVer} cannot build the React app (the build needs Node ${nodeFloor})`, `install Node ${pinned} (nvm install ${pinned} && nvm use ${pinned})`));
  } else {
    out.push(pass('D-R1', `node v${nodeVer}`));
  }

  const npmRes = await runCmd(ctx, 'npm', ['--version']);
  const npmVer = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(`${npmRes.stdout}\n${npmRes.stderr}`)?.[1];
  const npmMajor = npmVer ? Number(npmVer.split('.')[0]) : NaN;
  let npmOk = false;
  if (!npmVer || !Number.isInteger(npmMajor)) {
    out.push(fail('D-R2', 'npm is not installed or not on PATH', `install Node ${pinned}; npm ships with it (the React deploy runs \`npm ci\` in web/)`));
  } else if (npmMajor < npmFloor) {
    out.push(
      fail(
        'D-R2',
        `npm ${npmVer} is too old (the React build needs npm ${npmFloor} or later)`,
        `install Node ${pinned} (npm ships with it), or run npm install -g npm@${npmFloor}`,
      ),
    );
  } else {
    npmOk = true;
    out.push(pass('D-R2', `npm ${npmVer}`));
  }
  if (!npmOk) {
    out.push(skip('D-R3', 'npm is not installed; the registry was not checked'));
    out.push(skip('D-R4', 'npm is not installed; the cache was not checked'));
    return out;
  }

  if (ctx.local) {
    out.push(skip('D-R3', 'not run (--local)'));
  } else {
    const ping = await runCmd(ctx, 'npm', ['ping', '--fetch-timeout', '10000']);
    if (ping.code === 0) {
      out.push(pass('D-R3', 'npm registry reachable'));
    } else {
      out.push(
        warn(
          'D-R3',
          'the npm registry is not reachable',
          'check the network connection or proxy, then run c2c doctor again; the React deploy runs `npm ci` in web/, which downloads from the registry',
        ),
      );
    }
  }

  const cacheRes = await runCmd(ctx, 'npm', ['config', 'get', 'cache']);
  const cacheDir = cacheRes.code === 0 ? (cacheRes.stdout.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '') : '';
  if (!cacheDir) {
    out.push(fail('D-R4', 'the npm cache location is unknown (`npm config get cache` printed nothing)', `repair the npm install (install Node ${pinned}; npm ships with it), then run c2c doctor again`));
    return out;
  }
  try {
    mkdirSync(cacheDir, { recursive: true });
    const probe = join(cacheDir, `.c2c-write-probe-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe);
    out.push(pass('D-R4', 'npm cache writable'));
  } catch {
    out.push(fail('D-R4', `the npm cache ${cacheDir} is not writable`, `make ${cacheDir} writable, or point npm at a writable cache (npm config set cache <dir>)`));
  }
  return out;
}

// ---------- D-F*: target org / project budget ----------

interface PlanInfo {
  tables: string[];
  users?: number;
}

/**
 * The MCP tools this app's plan needs, from `c2c plan` output: plan.json
 * `mcpTools.plan` and every MCP tool a provision step names. Undefined when
 * no plan has been written yet.
 */
function readPlanMcpTools(ctx: DoctorContext): string[] | undefined {
  const dir = join(ctx.workspace, 'c2c-out', ctx.scope.app ?? '');
  const names = new Set<string>();
  let found = false;
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []);
  try {
    const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as { mcpTools?: { plan?: unknown } };
    found = true;
    for (const name of strings(plan.mcpTools?.plan)) names.add(name);
  } catch {
    // no plan.json
  }
  try {
    const provision = JSON.parse(readFileSync(join(dir, 'provision', 'plan.json'), 'utf8')) as { steps?: unknown };
    found = true;
    for (const step of Array.isArray(provision.steps) ? provision.steps : []) {
      if (!step || typeof step !== 'object') continue;
      const { tool, via, readBack } = step as { tool?: unknown; via?: unknown; readBack?: { via?: unknown; tool?: unknown } };
      if (via === 'mcp' && typeof tool === 'string') names.add(tool);
      if (readBack && readBack.via === 'mcp' && typeof readBack.tool === 'string') names.add(readBack.tool);
    }
  } catch {
    // no provision/plan.json
  }
  return found ? [...names] : undefined;
}

function readPlanInfo(ctx: DoctorContext): PlanInfo | undefined {
  const app = ctx.scope.app;
  const path = join(ctx.workspace, 'c2c-out', app ?? '', 'provision', 'plan.json');
  try {
    const plan = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const tables: string[] = [];
    const rawTables = plan.tables;
    if (Array.isArray(rawTables)) {
      for (const item of rawTables) {
        if (typeof item === 'string') tables.push(item);
        else if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string') {
          tables.push((item as Record<string, unknown>).name as string);
        }
      }
    }
    const users = typeof plan.users === 'number' && Number.isInteger(plan.users) ? plan.users : typeof plan.plannedUsers === 'number' ? plan.plannedUsers : undefined;
    return { tables, ...(users !== undefined ? { users } : {}) };
  } catch {
    return undefined;
  }
}

function checkF(ctx: DoctorContext, ir: App | undefined, cliProjects: string[] | undefined, projectRows: readonly ListedProject[] | undefined): CheckResult[] {
  const out: CheckResult[] = [];
  const { project } = ctx.scope;
  // The CLI project list is the only project source: the MCP project tools
  // return project secrets into the transcript and are never called.
  const countList = cliProjects;
  const rendered = (id: string) => cliRenderedId(id);
  const listed = project && countList ? countList.some((id) => rendered(entryId(id)) === rendered(project)) : undefined;
  if (countList === undefined) {
    out.push(skip('D-F1', 'project count unknown (no CLI project list)'));
  } else {
    const n = countList.length;
    if (listed === true) out.push(pass('D-F1', `projects ${n}/50; target ${project} exists`));
    else if (n >= 50) {
      out.push(fail('D-F1', 'your account has 50/50 projects; c2c needs one project per app', 'delete an unused project in the console, ask Catalyst support to raise the limit, or choose an existing project for this app in c2c-deploy.json'));
    } else if (n >= 45) {
      out.push(warn('D-F1', `projects ${n}/50${project ? `; target ${project} not yet created` : ''}`));
    } else {
      out.push(pass('D-F1', `projects ${n}/50${project ? `; target ${project} not yet created` : ''}`));
    }
  }

  const envValue = ctx.scope.env;
  if (envValue && envValue !== 'Development') {
    out.push(fail('D-F2', 'c2c only writes to Development', 'set "env": "Development" in c2c-deploy.json; production goes through /c2c:verify cutover steps'));
  } else if (project && ctx.scope.neverTouch.includes(project)) {
    out.push(fail('D-F2', `project ${project} is in never_touch`, 'choose another project for this app in c2c-deploy.json'));
  } else {
    out.push(pass('D-F2', 'env Development'));
  }

  const plan = readPlanInfo(ctx);
  // The flat list names the target project's tables directly; a per-project
  // MCP listing is read at the target project only — another project's tables
  // are never this app's to compare.
  let tables = recordedList(ctx.evidence?.tables);
  if (tables === undefined && ctx.evidence?.projectTables) {
    tables = project ? ctx.evidence.projectTables[project] : undefined;
  }
  if (tables === 'malformed') {
    out.push(fail('D-F3', 'the recorded project table list is not a list of names; re-record the evidence', RE_RECORD));
  } else if (tables === undefined) {
    out.push(skip('D-F3', 'project table list not recorded'));
  } else if (tables.length === 0) {
    out.push(pass('D-F3', 'project empty (greenfield)'));
  } else if (!plan || plan.tables.length === 0) {
    out.push(warn('D-F3', `project has ${tables.length} tables; no provision/plan.json to compare them with`));
  } else {
    const allowed = new Set(plan.tables);
    const extra = tables.filter((name) => !allowed.has(name));
    if (extra.length === 0) {
      out.push(pass('D-F3', `update mode: ${tables.length} tables match the plan`));
    } else {
      out.push(
        fail(
          'D-F3',
          `project ${project ?? '?'} has ${extra.length} tables that are not part of this app (${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ', …' : ''})`,
          'use a new project for this app (one project per app); merging two apps into one project is refused',
        ),
      );
    }
  }

  const orgTables = ctx.evidence?.orgTableCount;
  if (orgTables === undefined) {
    out.push(skip('D-F4', 'org table count not recorded'));
  } else if (typeof orgTables !== 'number' || !Number.isInteger(orgTables) || orgTables < 0) {
    out.push(fail('D-F4', 'the recorded org table count is not a count; re-record the evidence', RE_RECORD));
  } else {
    const planned = plan?.tables.length ?? (ir ? generateSchema(ir).tables.length : 0);
    if (planned > 0) {
      out.push(
        warn(
          'D-F4',
          `org has ${orgTables} tables and the plan adds ${planned}; the org table-create limit is unpublished and can refuse at any count. On API_LIMIT_REACHED for table: stop creates, keep created tables, retry after 30/60/120 min; a project delete may not free capacity at once; use c2c status --table-budget <n> for a read-only estimate`,
        ),
      );
    } else {
      out.push(pass('D-F4', `tables ${orgTables} + ${planned} planned`));
    }
  }

  if (!ir) {
    out.push(skip('D-F5', 'no app; per-table budgets were not checked'));
  } else {
    out.push(f5TableBudgets(generateSchema(ir).tables));
  }

  const users = plan?.users;
  if (users === undefined) {
    out.push(skip('D-F6', 'planned user count unknown'));
  } else if (users > 25) {
    out.push(warn('D-F6', `${users} planned app users vs 25 Dev users (1000 observed; rehearse full volume outside Development)`));
  } else {
    out.push(pass('D-F6', `${users} planned app users`));
  }

  // D-F7: a target project still 'Importing' holds its name and cannot be
  // deleted — past the stuck bound the run stops on the one guided step.
  if (!project) {
    out.push(skip('D-F7', 'no target project'));
  } else if (projectRows === undefined) {
    out.push(skip('D-F7', 'the org project list could not be read with project_type'));
  } else {
    const row = projectRows.find((entry) => entry.id === project);
    if (!row) {
      out.push(skip('D-F7', 'the target project is not in the org list'));
    } else if (row.projectType === 'Importing') {
      const ageState = importingAgeState(row);
      if (ageState === 'stuck' && isStuckImporting(row)) {
        out.push(fail('D-F7', stuckImportGuidedStep(row), 'check the project in the Catalyst console; if it stays Importing, contact Catalyst support — a stuck import cannot be deleted and holds its name'));
      } else if (ageState === 'unknown') {
        out.push(warn('D-F7', unknownImportAgeGuidedStep(row)));
      } else {
        const age = importingAgeMs(row);
        const hours = age === undefined ? 'unknown age' : `${Math.max(0, Math.floor(age / 3600000))}h`;
        out.push(warn('D-F7', `project ${project} ("${row.name}") is still "Importing" (${hours}; stuck past ${STUCK_IMPORT_MAX_AGE_HOURS}h)`));
      }
    } else {
      out.push(pass('D-F7', 'the target project is not stuck importing'));
    }
  }
  return out;
}

/**
 * D-F5 per-table budgets. Same limits source as generation and `c2c plan`
 * (schema CATALYST_LIMITS): the raised cap fails, the stated default of
 * `datastore.columns_per_table_default` — documented [UNVERIFIED] in
 * plugin/references/facts/limits.md — warns, matching the plan's budget row.
 */
export function f5TableBudgets(tables: readonly SchemaTable[]): CheckResult {
  const maxColumns = limitValue('datastore.columns_per_table');
  const columnsDefault = limitValue('datastore.columns_per_table_default');
  const breaches: string[] = [];
  const overDefault: string[] = [];
  for (const table of tables) {
    if (table.columns.length > maxColumns) breaches.push(`table ${table.name} needs ${table.columns.length} columns (max ${maxColumns})`);
    else if (table.columns.length > columnsDefault)
      overDefault.push(`table ${table.name}: ${table.columns.length}/${maxColumns} columns (over the unverified default ${columnsDefault}; relies on the raised cap — confirm with P-COLS)`);
    const uniques = table.columns.filter((c) => c.unique && c.dataType === 'VarChar').map((c) => c.name);
    if (uniques.length > 2) breaches.push(`table ${table.name} needs ${uniques.length} unique varchar columns (${uniques.join(', ')}); Catalyst allows 2`);
    const fks = table.columns.filter((c) => c.relation).length;
    if (fks > 15) breaches.push(`table ${table.name} needs ${fks} foreign keys (max 15)`);
  }
  if (breaches.length) {
    return fail('D-F5', breaches.join('; '), 'split a table over the column cap into 1:1 side tables, choose which fields lose "No Duplicate" in Catalyst (c2c enforces them in the app layer), or let the splitter handle it; re-run /c2c:plan');
  }
  if (overDefault.length) return warn('D-F5', overDefault.join('; '));
  return pass('D-F5', 'budgets ok');
}

// ---------- D-B*/D-V*: merged MCP evidence ----------

function checkB(ctx: DoctorContext, evidence: McpEvidence, cliProjects: string[] | undefined): CheckResult[] {
  const out: CheckResult[] = [];
  const mcpFix = `disable the broken copy and add a correct entry, e.g. claude mcp add --transport http catalyst-by-zoho https://catalystbyzoho.zohomcp.<dc>/mcp/message; restart; complete the browser sign-in`;
  const hostOfUrl = typeof evidence.host_of_url === 'string' && evidence.host_of_url !== '' ? evidence.host_of_url : undefined;
  const localTransport = evidence.transport === 'stdio' || evidence.transport === 'local';
  // The submitted call results are caller-controlled; for a local transport
  // the only proof the connector is bound to this org/DC/project is the
  // doctor's own REST read-back of the nonce-named probe write.
  const bound = evidence.binding?.status === 'verified';
  const bindingFix = 'run c2c doctor --mcp-begin, make every call it names (the probe write first), then c2c doctor --mcp-observed -';
  if (localTransport && ctx.evidenceSource !== 'observed') {
    out.push(fail('D-B1', 'stdio/local MCP evidence must come from an observed live tool call; run c2c doctor --mcp-begin and --mcp-observed', 'run /c2c:doctor again and record the live MCP call with c2c doctor --mcp-begin'));
  } else if (localTransport && !bound) {
    out.push(fail('D-B1', `stdio/local MCP is not proved bound to this org/DC/project: ${evidence.binding?.detail ?? 'no server-side probe was read back'}`, bindingFix));
  } else if (localTransport) {
    out.push(pass('D-B1', `catalyst MCP: ${evidence.server ?? 'catalyst-by-zoho'} (${evidence.transport}) — bound by the probe write`));
  } else if (!hostOfUrl) {
    out.push(
      fail('D-B1', evidence.host_of_url === undefined ? 'no Catalyst MCP server was recorded' : 'the recorded MCP host is not a host name; re-record the evidence', mcpFix),
    );
  } else {
    out.push(pass('D-B1', `catalyst MCP: ${evidence.server ?? 'catalyst-by-zoho'} → ${hostOfUrl} (${evidence.transport ?? 'http'})`));
  }

  let mcpDc = dcOfMcpHost(hostOfUrl);
  let dcSource: 'MCP host' | 'project write probe' = 'MCP host';
  if (localTransport) {
    // A verified probe write places the nonce inside the very project the
    // CLI credential sees — that read-back is the org/DC proof. Caller-
    // submitted org hosts or the CLI's own selection never attest the
    // connector, so without the probe the DC stays unproven.
    if (bound) {
      mcpDc = normalizeDc(ctx.scope.dc);
      dcSource = 'project write probe';
    }
  }
  if (!mcpDc) {
    if (localTransport) {
      out.push(fail('D-B2', `cannot prove the Catalyst MCP data center for org ${ctx.scope.org ?? '?'}: the probe write was not read back in the selected project (${evidence.binding?.detail ?? 'no probe ran'})`, bindingFix));
    } else {
      out.push(hostOfUrl ? fail('D-B2', `cannot read a DC from MCP host ${hostOfUrl}`, mcpFix) : skip('D-B2', 'no MCP host recorded'));
    }
  } else if (!ctx.scope.dc) {
    out.push(warn('D-B2', `MCP DC = ${mcpDc}; the target DC is not set`));
  } else if (mcpDc !== ctx.scope.dc) {
    out.push(fail('D-B2', `the Catalyst MCP points at ${mcpDc} but your Catalyst account is in ${ctx.scope.dc}`, `change the URL to the ${ctx.scope.dc} endpoint and restart, or run the official /catalyst-by-zoho:switch-dc ${ctx.scope.dc.toUpperCase()}`));
  } else {
    out.push(pass('D-B2', `MCP DC = ${mcpDc} (proved by ${dcSource})`));
  }

  const toolList = recordedList(evidence.tools);
  if (toolList === 'malformed') {
    out.push(fail('D-B3', 'the recorded MCP tool list is not a list of names; re-record the evidence', RE_RECORD));
  } else {
    const tools = (toolList ?? []).map(shortToolName);
    const meta = tools.some((name) => name.startsWith('ZohoMCP_'));
    const direct = tools.some((name) => name !== 'authenticate' && name !== 'complete_authentication' && !name.startsWith('ZohoMCP_'));
    if (meta || direct) {
      out.push(pass('D-B3', `connected (${meta ? 'meta' : 'direct'})`));
    } else if (tools.length === 0) {
      out.push(fail('D-B3', 'the Catalyst MCP is configured but not connected/authorised', 'open /mcp (Claude Code) or run codex mcp login catalyst-by-zoho and finish the Zoho sign-in in the browser'));
    } else {
      out.push(fail('D-B3', 'the Catalyst MCP shows only sign-in tools; it is not authorised', 'open /mcp (Claude Code) or run codex mcp login catalyst-by-zoho and finish the Zoho sign-in in the browser'));
    }
  }

  if (evidence.shape === 'direct') {
    out.push(skip('D-B4', 'direct MCP shape; getFeatures does not apply'));
  } else if (Array.isArray(evidence.features) && evidence.features.length) {
    out.push(pass('D-B4', `features: ${evidence.features.length} groups`));
  } else {
    out.push(warn('D-B4', 'getFeatures was not recorded'));
  }

  const planTools = readPlanMcpTools(ctx);
  const missing = missingRequiredTools(
    toolList === 'malformed' || toolList === undefined ? { ...evidence, tools: [] } : { ...evidence, tools: [...toolList] },
    planTools ?? [],
  );
  if (missing.base.length || missing.plan.length) {
    const parts: string[] = [];
    if (missing.base.length) parts.push(`needed by doctor (${missing.base.length}): ${missing.base.join(', ')}`);
    if (missing.plan.length) {
      const planItems = missing.plan.map((name) => {
        const fallback = fallbackForTool(name);
        return fallback ? `${name} (fallback: ${fallback})` : name;
      });
      parts.push(`needed by this app's plan (${missing.plan.length}): ${planItems.join(', ')}`);
    }
    out.push(fail('D-B5', `the Catalyst MCP server is missing tools — ${parts.join('; ')}`, MCP_TOOLS_GUIDANCE));
  } else {
    const baseCount = REQUIRED_MCP_TOOLS.base.length;
    const planNote = planTools === undefined ? '; no plan yet (run c2c plan, then doctor again to check its tools)' : ', plan tools all present';
    out.push(pass('D-B5', `required tools: ${baseCount}/${baseCount} base${planNote}`));
  }

  const schemaCount = evidence.schemas && typeof evidence.schemas === 'object' && !Array.isArray(evidence.schemas) ? Object.keys(evidence.schemas).length : 0;
  out.push(schemaCount ? pass('D-B6', `schemas recorded (${schemaCount})`) : warn('D-B6', 'no tool schemas recorded; the skill re-reads each schema before calling'));

  const { org, project } = ctx.scope;
  const orgs = recordedList(evidence.orgs);
  if (!org) {
    out.push(skip('D-B7', 'org unknown; MCP org visibility was not checked'));
  } else if (orgs === 'malformed') {
    out.push(fail('D-B7', `the recorded org list is malformed; cannot prove the MCP sees org ${org}`, RE_RECORD));
  } else if (!orgs) {
    out.push(
      fail(
        'D-B7',
        `the evidence has no MCP org list; cannot prove the MCP sees org ${org}`,
        'run /c2c:doctor again: c2c doctor --mcp-begin, the agent calls CatalystbyZoho_List_All_Organizations, then pipes the result into c2c doctor --mcp-observed -',
      ),
    );
  } else if (!orgs.some((item) => entryId(item) === org)) {
    out.push(fail('D-B7', `the MCP account cannot see org ${org} (PERMISSION_NEEDED / not found)`, 'the MCP is signed in to another Zoho account or DC: sign out of the MCP and sign in with the account that owns the Catalyst org'));
  } else {
    // Project visibility comes from the CLI list (D-C4), never an MCP project tool.
    const projectNote = project && cliProjects ? (cliProjects.some((id) => cliRenderedId(id) === cliRenderedId(project)) ? `, project ${project} visible to the CLI` : ', project not yet created') : '';
    out.push(pass('D-B7', `MCP org ${org}${projectNote}`));
  }
  return out;
}

function checkV(ctx: DoctorContext, evidence: McpEvidence): CheckResult[] {
  const out: CheckResult[] = [];
  const hostOfUrl = typeof evidence.host_of_url === 'string' ? evidence.host_of_url : undefined;
  const mcpDc = dcOfMcpHost(hostOfUrl);
  // One read only: the store reader shells out, and a second read can come back
  // different or missing — that must be an unknown ('?'), never a crash.
  let cliValue: string | undefined;
  try {
    cliValue = ctx.cliDc?.();
  } catch {
    cliValue = undefined;
  }
  const cliDc = normalizeDc(cliValue);
  const parts: string[] = [];
  let mismatch = false;
  const seen = new Set<string>();
  for (const [label, dc] of [
    ['config', ctx.scope.dc],
    ['MCP', mcpDc],
    ['CLI', cliDc],
  ] as const) {
    parts.push(`${label} ${dc ?? '?'}`);
    if (dc) {
      if (seen.size && !seen.has(dc)) mismatch = true;
      seen.add(dc);
    }
  }
  if (mismatch) {
    out.push(fail('D-V1', `DC mismatch (${parts.join(', ')})`, 'fix whichever is wrong per D-B2/D-C4'));
  } else {
    out.push(pass('D-V1', `DC ${[...seen][0] ?? 'unknown'} consistent`));
  }

  const age = Date.now() - Date.parse(evidence.at ?? '');
  let workspaceReal = ctx.workspace;
  try {
    workspaceReal = realpathSync(ctx.workspace);
  } catch {
    /* workspace may not exist yet */
  }
  const wsMatch = !evidence.workspace || evidence.workspace === ctx.workspace || evidence.workspace === workspaceReal;
  if (!Number.isFinite(age) || age < 0 || age > 12 * 60 * 60 * 1000 || !wsMatch) {
    out.push(fail('D-V2', 'MCP evidence is stale/incomplete: too old, undated, or from another workspace; re-record', 'run /c2c:doctor again'));
  } else {
    out.push(pass('D-V2', 'MCP evidence is fresh'));
  }

  const servers = evidence.servers;
  const malformedServers =
    servers !== undefined &&
    (!Array.isArray(servers) || servers.some((s) => !s || typeof s !== 'object' || typeof s.name !== 'string' || typeof s.host !== 'string'));
  if (malformedServers) {
    out.push(fail('D-V3', 'the recorded MCP server list is malformed; re-record the evidence', RE_RECORD));
  } else if (servers !== undefined && servers.length > 1) {
    const names = servers.map((s) => `${s.name} on .${dcOfMcpHost(s.host) ?? '?'} (${s.host})`).join(', ');
    out.push(warn('D-V3', `two Catalyst MCP servers are connected (${names}); c2c uses ${evidence.server ?? servers[0].name}`));
  } else {
    out.push(pass('D-V3', 'one Catalyst MCP server'));
  }
  return out;
}

// ---------- orchestration ----------

export interface DoctorRun {
  checks: CheckResult[];
  scope: ResolvedScopeValues;
  ir?: App;
  green: boolean;
  /** Spec items reported but not checked yet; persisted into doctor.json.deferred. */
  deferred: { id: string; reason: string }[];
  /** exit 6 checks failed (Node / vendor integrity). */
  integrityFailed: boolean;
}

export async function runDoctorChecks(ctx: DoctorContext): Promise<DoctorRun> {
  const checks: CheckResult[] = [];
  const localSkip = (id: string) => skip(id, 'not run (--local)');

  checks.push(...checkA(ctx));
  checks.push(ctx.local ? localSkip('D-A2') : await checkA2(ctx));

  const versionRes = await runCmd(ctx, 'catalyst', ['--version']);
  const versionMatch = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(`${versionRes.stdout}\n${versionRes.stderr}`);
  checks.push(...checkC1C2(versionMatch?.[1], versionRes.code !== 0));

  const whoami = await runCliRead(ctx, ['whoami']);
  checks.push(checkC3(whoami.stdout, whoami.stderr, whoami.code, ctx.scope.dc));

  let cliProjects: string[] | undefined;
  if (ctx.local) {
    checks.push(localSkip('D-C4'));
  } else if (!ctx.scope.org) {
    checks.push(skip('D-C4', 'org unknown; the CLI project list was not compared'));
  } else {
    const list = await runCliRead(ctx, ['--org', ctx.scope.org, 'project:list']);
    if (list.code !== 0) {
      checks.push(fail('D-C4', `the CLI cannot see org ${ctx.scope.org}`, D_C4_FIX(ctx.scope.dc)));
    } else {
      // The project list comes from the Catalyst CLI only (Project Name and
      // Project ID cells — no secrets). The MCP project tools are never
      // called; the MCP's org identity is D-B7.
      cliProjects = projectListIds(`${list.stdout}\n${list.stderr}`);
      const note = ctx.scope.project && !cliProjects.some((id) => cliRenderedId(id) === cliRenderedId(ctx.scope.project!)) ? '; target project not yet created' : '';
      checks.push(pass('D-C4', `CLI sees org ${ctx.scope.org} (${cliProjects.length} projects${note})`));
    }
  }

  checks.push(checkC5(ctx));

  const d1 = checkD1(ctx);
  checks.push(d1.result);
  if (d1.ir) checks.push(...checkMailSender(d1.ir, ctx.workspace, ctx.scope.project));
  checks.push(ctx.local ? localSkip('D-D2') : checkD2(ctx));
  checks.push(ctx.local ? localSkip('D-D3') : checkD3(ctx));

  checks.push(...checkE(ctx));

  checks.push(...(await checkReact(ctx)));

  if (ctx.local) {
    for (const id of ['D-F1', 'D-F2', 'D-F3', 'D-F4', 'D-F5', 'D-F6', 'D-F7']) checks.push(localSkip(id));
  } else {
    // The org project rows carry project_type/created_time — the only signal
    // for a project stuck 'Importing' (D-F7). One read-only GET through
    // io.listProjects (production: the CLI token; tests inject it); an
    // unreadable answer degrades D-F7 to a skip, never a fail.
    let projectRows: readonly ListedProject[] | undefined;
    if (ctx.scope.org && ctx.scope.project && ctx.io.listProjects) {
      try {
        projectRows = await ctx.io.listProjects(ctx.scope.org);
      } catch {
        projectRows = undefined;
      }
    }
    checks.push(...checkF(ctx, d1.ir, cliProjects, projectRows));
  }

  if (ctx.evidence) {
    checks.push(checkA3(ctx));
    checks.push(...checkB(ctx, ctx.evidence, cliProjects));
    checks.push(...checkV(ctx, ctx.evidence));
  } else if (ctx.carried) {
    // The same rows the gate reads: a failed observation stays red until a new one is recorded.
    checks.push(...ctx.carried.checks);
  } else {
    checks.push(skip('D-A3', 'agent half not recorded yet'));
    checks.push(skip('D-B', 'agent half not recorded yet (run c2c doctor --mcp-begin; the agent makes the MCP calls it names and pipes the results into c2c doctor --mcp-observed -)'));
  }

  const green = checks.every((c) => c.status !== 'fail');
  const integrityFailed = checks.some((c) => c.status === 'fail' && (c.id === 'D-E1' || c.id === 'D-E3'));
  return {
    checks,
    scope: ctx.scope,
    ...(d1.ir ? { ir: d1.ir } : {}),
    green,
    deferred: DEFERRED_CHECKS.map((d) => ({ ...d })),
    integrityFailed,
  };
}
